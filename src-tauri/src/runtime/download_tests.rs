use super::*;

#[tokio::test]
async fn async_download_writer_writes_chunks_without_sync_file_calls() {
    let path = std::env::temp_dir().join(format!(
        "aiolm-runtime-download-{}-{}.part",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let mut file = tokio::fs::File::create(&path)
        .await
        .expect("create temp file");
    write_download_chunk(&mut file, b"runtime")
        .await
        .expect("write chunk");
    file.flush().await.expect("flush chunk");
    drop(file);
    assert_eq!(fs::read(&path).expect("read temp file"), b"runtime");
    let _ = fs::remove_file(path);
}

#[test]
fn release_asset_filename_must_be_a_safe_supported_archive_basename() {
    assert!(validate_asset_file_name("llama-b10603-bin-win-vulkan-x64.zip").is_ok());
    assert!(validate_asset_file_name("llama-b123-bin-ubuntu-rocm-10.0-x64.tar.gz").is_ok());
    let error = validate_asset_file_name("../runtime.zip").unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(validate_asset_file_name("runtime.tar.gz").is_ok());
    assert!(validate_asset_file_name("runtime.tar").is_err());
    assert!(validate_asset_file_name("runtime file.zip").is_err());
}

#[test]
fn runtime_download_inputs_keep_validation_errors() {
    for url in [
        "not a URL",
        "http://github.com/runtime.zip",
        "https://example.invalid/runtime.zip",
    ] {
        assert_eq!(
            validate_download_url(url).unwrap_err().kind,
            crate::error::ErrorKind::Validation
        );
    }
    assert_eq!(
        normalize_digest("not a digest").unwrap_err().kind,
        crate::error::ErrorKind::Validation
    );
}

#[tokio::test]
async fn cancelled_runtime_download_keeps_its_kind_without_contacting_the_network() {
    let path = test_directory("cancelled-download").join("runtime.zip");
    let error = download_to_file(
        &|_, _, _| {},
        "downloading",
        "https://github.com/runtime.zip",
        &path,
        &Arc::new(AtomicBool::new(true)),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
    assert_eq!(error.message, "runtime install cancelled");
    assert!(!path.exists());
}

#[tokio::test]
async fn stalled_runtime_download_cancels_during_headers_and_body_reads() {
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    for send_chunk in [false, true] {
        let root = test_directory("stalled-download");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("runtime.zip");
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}/runtime.zip", listener.local_addr().unwrap());
        let (request_seen, request_received) = tokio::sync::oneshot::channel();
        let (stop_server, server_stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0_u8; 1];
                socket.read_exact(&mut byte).await.unwrap();
                request.extend_from_slice(&byte);
            }
            if send_chunk {
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\nruntime\r\n",
                    )
                    .await
                    .unwrap();
                socket.flush().await.unwrap();
            }
            request_seen.send(()).unwrap();
            let _ = server_stopped.await;
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let (chunk_written, chunk_received) = tokio::sync::watch::channel(false);
        let updates = Mutex::new(Vec::new());
        let progress = |phase: &str, received, total| {
            updates
                .lock()
                .unwrap()
                .push((phase.to_owned(), received, total));
            chunk_written.send_replace(true);
        };
        let download = download_request_to_file(
            &progress,
            "downloading",
            download_http().get(&url),
            &path,
            &cancel,
            |url| {
                assert_eq!(
                    reqwest::Url::parse(url).unwrap().host_str(),
                    Some("127.0.0.1")
                );
                Ok(())
            },
        );
        let stop = async {
            request_received.await.unwrap();
            if send_chunk {
                let mut chunk_received = chunk_received;
                timeout(
                    Duration::from_secs(5),
                    chunk_received.wait_for(|written| *written),
                )
                .await
                .expect("first chunk must reach the progress callback")
                .unwrap();
            }
            let started = Instant::now();
            cancel.store(true, Ordering::Release);
            started
        };
        let (result, cancelled_at) = timeout(Duration::from_secs(10), async {
            tokio::join!(download, stop)
        })
        .await
        .expect("cancellation must not wait for the 60 second read timeout");
        assert!(cancelled_at.elapsed() < Duration::from_secs(2));
        assert_eq!(
            result.unwrap_err(),
            AppError::cancelled("runtime install cancelled")
        );
        if send_chunk {
            assert_eq!(
                *updates.lock().unwrap(),
                [("downloading".to_owned(), 7.0, 0.0)]
            );
        } else {
            assert!(!path.exists());
            assert!(updates.lock().unwrap().is_empty());
        }
        stop_server.send(()).unwrap();
        server.await.unwrap();
        let _ = fs::remove_dir_all(root);
    }
}
