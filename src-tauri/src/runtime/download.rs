use super::*;

fn download_error(error: &reqwest::Error, message: String) -> AppError {
    if error.is_timeout() {
        AppError::timeout(message)
    } else {
        AppError::unavailable(message)
    }
}

pub(super) fn emit(
    app: &AppHandle,
    backend: &str,
    build: &str,
    phase: &str,
    received: f64,
    total: f64,
) {
    let _ = app.emit(
        "runtime-download-progress",
        serde_json::json!({
            "backend": backend,
            "build": build,
            "phase": phase,
            "received": received,
            "total": total
        }),
    );
}

pub(super) fn validate_download_url(url: &str) -> Result<(), AppError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| AppError::validation(format!("invalid download URL: {error}")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::validation("runtime download URL must use HTTPS"));
    }
    let host = parsed.host_str().unwrap_or_default();
    if !trusted_runtime_host(host) {
        return Err(AppError::validation(format!(
            "runtime download host is not trusted: {host}"
        )));
    }
    Ok(())
}

/// Hosts allowed to serve the correctness gate's verification model. Kept
/// separate from the runtime download allow-list: these are model weights from
/// the model hub, not release binaries from the source forge.
fn validate_model_download_url(url: &str) -> Result<(), AppError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| AppError::validation(format!("invalid download URL: {error}")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::validation(
            "verification model URL must use HTTPS",
        ));
    }
    let host = parsed.host_str().unwrap_or_default();
    if !trusted_model_host(host) {
        return Err(AppError::validation(format!(
            "verification model host is not trusted: {host}"
        )));
    }
    Ok(())
}

pub fn file_sha256(path: &Path) -> Result<String, AppError> {
    sha256_file(path)
}

/// Fetch a small pinned file and accept it only when it matches the expected
/// size and digest exactly. A verification model that arrived corrupted would
/// make the gate report a fault that is not in the runtime, so a mismatch is
/// discarded rather than used.
pub async fn download_verified(
    url: &str,
    path: &Path,
    sha256: &str,
    expected_bytes: u64,
) -> Result<(), AppError> {
    validate_model_download_url(url)?;
    let response = download_http().get(url).send().await.map_err(|error| {
        download_error(
            &error,
            format!("verification model download failed: {error}"),
        )
    })?;
    validate_model_download_url(response.url().as_str())?;
    if !response.status().is_success() {
        return Err(AppError::new(
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                crate::error::ErrorKind::NotFound
            } else {
                crate::error::ErrorKind::Unavailable
            },
            format!(
                "verification model download returned HTTP {}",
                response.status()
            ),
        ));
    }
    let mut stream = response.bytes_stream();
    let partial = path.with_extension("part");
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|error| AppError::from_io(&error))?;
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            download_error(
                &error,
                format!("verification model download failed: {error}"),
            )
        })?;
        written += chunk.len() as u64;
        if written > expected_bytes {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(AppError::validation(
                "verification model is larger than its pinned size",
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| AppError::from_io(&error))?;
    }
    file.flush()
        .await
        .map_err(|error| AppError::from_io(&error))?;
    drop(file);
    if written != expected_bytes {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(AppError::validation(format!(
            "verification model is {written} bytes, expected {expected_bytes}"
        )));
    }
    let path = path.to_path_buf();
    let sha256 = sha256.to_owned();
    tokio::task::spawn_blocking(move || {
        if sha256_file(&partial)? != sha256 {
            let _ = fs::remove_file(&partial);
            return Err(AppError::validation(
                "verification model digest does not match its pinned value",
            ));
        }
        fs::rename(&partial, path).map_err(|error| AppError::from_io(&error))
    })
    .await
    .map_err(|error| {
        AppError::new(
            if error.is_cancelled() {
                crate::error::ErrorKind::Cancelled
            } else {
                crate::error::ErrorKind::Internal
            },
            format!("verification model hash task failed: {error}"),
        )
    })?
}

pub(super) fn normalize_digest(value: &str) -> Result<String, AppError> {
    let hex = value.strip_prefix("sha256:").unwrap_or(value).trim();
    if hex.len() != 64 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(AppError::validation(
            "release asset digest is not a SHA-256 value",
        ));
    }
    Ok(hex.to_ascii_lowercase())
}

pub(super) fn validate_asset_file_name(name: &str) -> Result<(), AppError> {
    let path = Path::new(name);
    if name.is_empty()
        || name.len() > 255
        || path.file_name().and_then(|value| value.to_str()) != Some(name)
        || !(name.ends_with(".zip") || name.ends_with(".tar.gz"))
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err(AppError::validation(
            "release asset filename is not a safe ZIP or tar.gz basename",
        ));
    }
    Ok(())
}

pub(super) fn sha256_file(path: &Path) -> Result<String, AppError> {
    let file = fs::File::open(path).map_err(|error| AppError::from_io(&error))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    std::io::copy(&mut reader, &mut hasher).map_err(|error| AppError::from_io(&error))?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub(super) async fn download_to_file(
    progress: ProgressSink<'_>,
    phase: &str,
    url: &str,
    path: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("runtime install cancelled"));
    }
    validate_download_url(url)?;
    download_request_to_file(
        progress,
        phase,
        download_http().get(url),
        path,
        cancel,
        validate_download_url,
    )
    .await
}

pub(super) async fn download_request_to_file(
    progress: ProgressSink<'_>,
    phase: &str,
    request: reqwest::RequestBuilder,
    path: &Path,
    cancel: &Arc<AtomicBool>,
    validate_response_url: impl FnOnce(&str) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let response = tokio::select! {
        biased;
        _ = crate::cancellation::wait_cancelled(cancel) => {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        response = request.send() => response
            .map_err(|error| download_error(&error, format!("runtime download failed: {error}")))?,
    };
    validate_response_url(response.url().as_str())?;
    if !response.status().is_success() {
        return Err(AppError::new(
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                crate::error::ErrorKind::NotFound
            } else {
                crate::error::ErrorKind::Unavailable
            },
            format!("runtime download returned HTTP {}", response.status()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_ARCHIVE_BYTES)
    {
        return Err(AppError::validation(
            "runtime archive exceeds the configured size limit",
        ));
    }
    let total = response.content_length().unwrap_or(0);
    let mut output = tokio::fs::File::create(path)
        .await
        .map_err(|error| AppError::from_io(&error))?;
    let mut received = 0_u64;
    let mut stream = response;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = crate::cancellation::wait_cancelled(cancel) => {
                return Err(AppError::cancelled("runtime install cancelled"));
            }
            chunk = stream.chunk() => chunk.map_err(|error| {
                download_error(&error, format!("runtime download stream failed: {error}"))
            })?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::cancelled("runtime install cancelled"));
        }
        received = received.saturating_add(chunk.len() as u64);
        if received > MAX_ARCHIVE_BYTES {
            return Err(AppError::validation(
                "runtime archive exceeds the configured size limit",
            ));
        }
        write_download_chunk(&mut output, &chunk).await?;
        progress(phase, received as f64, total as f64);
    }
    if cancel.load(Ordering::Acquire) {
        return Err(AppError::cancelled("runtime install cancelled"));
    }
    output
        .flush()
        .await
        .map_err(|error| AppError::from_io(&error))?;
    Ok(())
}

pub(super) async fn write_download_chunk(
    output: &mut tokio::fs::File,
    chunk: &[u8],
) -> Result<(), AppError> {
    output
        .write_all(chunk)
        .await
        .map_err(|error| AppError::from_io(&error))
}
