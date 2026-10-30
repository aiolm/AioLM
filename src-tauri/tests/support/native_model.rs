//! Acquisition of immutable public model data for native acceptance tests.
//! Transport retries never relax the pinned size/hash or retry the inference.

use reqwest::Client;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static NEXT_PART: AtomicU64 = AtomicU64::new(0);

pub struct ModelSpec<'a> {
    pub url: &'a str,
    pub sha256: &'a str,
    pub bytes: u64,
}

#[derive(Clone, Copy)]
pub struct DownloadPolicy {
    pub max_attempts: usize,
    pub total_budget: Duration,
    pub idle_timeout: Duration,
    pub retry_delay: Duration,
}

impl Default for DownloadPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            total_budget: Duration::from_secs(600),
            idle_timeout: Duration::from_secs(45),
            retry_delay: Duration::from_secs(1),
        }
    }
}

#[derive(Debug)]
pub struct Acquisition {
    pub attempts: usize,
    pub cache_hit: bool,
}

struct Budget {
    started: Instant,
    limit: Duration,
}

impl Budget {
    fn remaining(&self) -> Result<Duration, String> {
        self.limit
            .checked_sub(self.started.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                format!(
                    "native model acquisition exceeded its {:?} total budget",
                    self.limit
                )
            })
    }

    fn operation_limit(&self, idle: Duration) -> Result<Duration, Failure> {
        Ok(self.remaining().map_err(Failure::Fatal)?.min(idle))
    }
}

enum Failure {
    Transient(String),
    Fatal(String),
}

fn io_error(operation: &str, error: std::io::Error) -> String {
    format!("native model {operation} failed: {:?}", error.kind())
}

/// A failed or cancelled request cannot leave a valid-looking model file.
/// Closing before cleanup also permits removing the partial on Windows.
struct Staging {
    path: PathBuf,
    file: Option<File>,
}

impl Staging {
    fn new(directory: &Path) -> Result<Self, String> {
        for _ in 0..32 {
            let path = directory.join(format!(
                ".aiolm-native-model-{}-{}.part",
                std::process::id(),
                NEXT_PART.fetch_add(1, Ordering::Relaxed)
            ));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error("create partial file", error)),
            }
        }
        Err("native model could not allocate an exclusive partial file".into())
    }

    fn restart(&mut self) -> Result<&mut File, Failure> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| Failure::Fatal("native model partial is closed".into()))?;
        file.set_len(0)
            .map_err(|e| Failure::Fatal(io_error("truncate partial file", e)))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|e| Failure::Fatal(io_error("rewind partial file", e)))?;
        Ok(file)
    }

    fn close_verified(&mut self) -> Result<(), String> {
        let mut file = self
            .file
            .take()
            .ok_or("native model partial is already closed")?;
        file.flush()
            .map_err(|e| io_error("flush verified partial", e))?;
        file.sync_all()
            .map_err(|e| io_error("sync verified partial", e))?;
        Ok(())
    }

    fn install(&mut self, destination: &Path) -> Result<(), String> {
        if self.file.is_some() {
            self.close_verified()?;
        }
        fs::rename(&self.path, destination).map_err(|e| io_error("install verified model", e))
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

fn verify_digest(spec: &ModelSpec<'_>, bytes: u64, hash: Sha256) -> Result<(), String> {
    if bytes != spec.bytes {
        return Err(format!(
            "native model pinned size mismatch: expected {}, received {bytes}",
            spec.bytes
        ));
    }
    let actual = format!("{:x}", hash.finalize());
    if actual != spec.sha256 {
        return Err(format!(
            "native model pinned SHA-256 mismatch: expected {}, received {actual}",
            spec.sha256
        ));
    }
    Ok(())
}

fn open_pinned_file(path: &Path, spec: &ModelSpec<'_>) -> Result<File, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| io_error("inspect cache entry", e))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("native model cache entry must be a regular file".into());
    }
    if metadata.len() != spec.bytes {
        return Err(format!(
            "native model cache pinned size mismatch: expected {}, found {}",
            spec.bytes,
            metadata.len()
        ));
    }
    let file = File::open(path).map_err(|e| io_error("open cache entry", e))?;
    if file
        .metadata()
        .map_err(|e| io_error("inspect opened cache entry", e))?
        .len()
        != spec.bytes
    {
        return Err("native model cache changed before it was opened".into());
    }
    Ok(file)
}

/// Verify the bytes while copying, so a cache mutation between a separate hash
/// pass and copy cannot supply unverified data to the inference test.
fn verify_and_copy(
    source: &Path,
    destination: Option<&Path>,
    spec: &ModelSpec<'_>,
    budget: &Budget,
) -> Result<(), String> {
    budget.remaining()?;
    let mut source = open_pinned_file(source, spec)?;
    let mut staging = destination
        .map(|path| {
            Staging::new(
                path.parent()
                    .ok_or("native model destination has no parent")?,
            )
        })
        .transpose()?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        budget.remaining()?;
        let length = source
            .read(&mut buffer)
            .map_err(|e| io_error("read cache entry", e))?;
        if length == 0 {
            break;
        }
        bytes = bytes
            .checked_add(length as u64)
            .ok_or("native model cache byte count overflow")?;
        if bytes > spec.bytes {
            return Err("native model cache exceeded its pinned size".into());
        }
        hash.update(&buffer[..length]);
        if let Some(staging) = &mut staging {
            staging
                .file
                .as_mut()
                .ok_or("native model partial is closed")?
                .write_all(&buffer[..length])
                .map_err(|e| io_error("write copied model", e))?;
        }
    }
    verify_digest(spec, bytes, hash)?;
    budget.remaining()?;
    if let (Some(staging), Some(destination)) = (&mut staging, destination) {
        staging.install(destination)?;
        budget.remaining()?;
    }
    Ok(())
}

fn transport_failure(error: &reqwest::Error, received: u64) -> Failure {
    // Do not print the request/error URL: public model redirects can contain
    // temporary signed query parameters. Categories and byte counts suffice.
    let category = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection"
    } else if error.is_body() || error.is_decode() {
        "body stream"
    } else {
        "request"
    };
    let mut cause = std::error::Error::source(error);
    let mut io_kind = None;
    for _ in 0..8 {
        let Some(current) = cause else { break };
        if let Some(error) = current.downcast_ref::<std::io::Error>() {
            io_kind = Some(error.kind());
            break;
        }
        cause = current.source();
    }
    let detail = io_kind
        .map(|kind| format!(" (I/O {kind:?})"))
        .unwrap_or_default();
    let message = format!("native model {category} failure{detail} after {received} bytes");
    if error.is_timeout() || error.is_connect() || error.is_body() || error.is_decode() {
        Failure::Transient(message)
    } else {
        Failure::Fatal(message)
    }
}

async fn download_attempt(
    client: &Client,
    spec: &ModelSpec<'_>,
    file: &mut File,
    policy: DownloadPolicy,
    budget: &Budget,
) -> Result<(), Failure> {
    let mut response = tokio::time::timeout(
        budget.operation_limit(policy.idle_timeout)?,
        client.get(spec.url).send(),
    )
    .await
    .map_err(|_| Failure::Transient("native model response headers timed out".into()))?
    .map_err(|error| transport_failure(&error, 0))?;
    let status = response.status();
    if !status.is_success() {
        let message = format!("native model HTTP status {}", status.as_u16());
        return Err(
            if status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error() {
                Failure::Transient(message)
            } else {
                Failure::Fatal(message)
            },
        );
    }
    if let Some(length) = response.content_length() {
        if length != spec.bytes {
            return Err(Failure::Fatal(format!(
                "native model declared size mismatch: expected {}, declared {length}",
                spec.bytes
            )));
        }
    }
    let mut bytes = 0_u64;
    let mut hash = Sha256::new();
    loop {
        let chunk = tokio::time::timeout(
            budget.operation_limit(policy.idle_timeout)?,
            response.chunk(),
        )
        .await
        .map_err(|_| {
            Failure::Transient(format!(
                "native model body idle timeout after {bytes} bytes"
            ))
        })?
        .map_err(|error| transport_failure(&error, bytes))?;
        let Some(chunk) = chunk else { break };
        bytes = bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| Failure::Fatal("native model byte count overflow".into()))?;
        if bytes > spec.bytes {
            return Err(Failure::Fatal(
                "native model exceeded its pinned size".into(),
            ));
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .map_err(|e| Failure::Fatal(io_error("write downloaded model", e)))?;
    }
    verify_digest(spec, bytes, hash).map_err(Failure::Fatal)?;
    budget.remaining().map_err(Failure::Fatal)?;
    Ok(())
}

pub async fn acquire_model(
    client: &Client,
    spec: &ModelSpec<'_>,
    destination: &Path,
    cache: Option<&Path>,
    policy: DownloadPolicy,
) -> Result<Acquisition, String> {
    let budget = Budget {
        started: Instant::now(),
        limit: policy.total_budget,
    };
    if policy.max_attempts == 0
        || policy.max_attempts > 3
        || policy.idle_timeout.is_zero()
        || spec.bytes == 0
        || spec.sha256.len() != 64
        || !spec
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("native model specification or retry policy is invalid".into());
    }
    budget.remaining()?;
    match fs::symlink_metadata(destination) {
        Ok(_) => return Err("native model destination already exists".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("inspect disposable destination", error)),
    }
    let parent = destination
        .parent()
        .ok_or("native model destination has no parent")?;
    fs::create_dir_all(parent).map_err(|e| io_error("create disposable model directory", e))?;
    let cache_path = if let Some(directory) = cache {
        if !directory.is_absolute() {
            return Err("AIOLM_NATIVE_MODEL_CACHE must be an absolute owned directory".into());
        }
        fs::create_dir_all(directory).map_err(|e| io_error("create model cache directory", e))?;
        Some(directory.join(format!("{}.gguf", spec.sha256)))
    } else {
        None
    };
    if let Some(path) = &cache_path {
        match fs::symlink_metadata(path) {
            Ok(_) => {
                verify_and_copy(path, Some(destination), spec, &budget)?;
                println!("Native model cache hit: pinned size and SHA-256 verified");
                return Ok(Acquisition {
                    attempts: 0,
                    cache_hit: true,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error("inspect model cache", error)),
        }
    }
    let staging_directory = cache_path
        .as_ref()
        .and_then(|path| path.parent())
        .unwrap_or(parent);
    let mut staging = Staging::new(staging_directory)?;
    for attempt in 1..=policy.max_attempts {
        budget.remaining()?;
        let file = staging.restart().map_err(|error| match error {
            Failure::Transient(message) | Failure::Fatal(message) => message,
        })?;
        match download_attempt(client, spec, file, policy, &budget).await {
            Ok(()) => {
                staging.close_verified()?;
                budget.remaining()?;
                if let Some(path) = &cache_path {
                    // Atomic no-clobber publication: both paths are within the
                    // same owned cache directory. An existing concurrent entry
                    // must verify; it is never replaced by a partial or by us.
                    match fs::hard_link(&staging.path, path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            verify_and_copy(path, None, spec, &budget)?;
                        }
                        Err(error) => return Err(io_error("publish verified cache entry", error)),
                    }
                    verify_and_copy(path, Some(destination), spec, &budget)?;
                } else {
                    staging.install(destination)?;
                    budget.remaining()?;
                }
                return Ok(Acquisition {
                    attempts: attempt,
                    cache_hit: false,
                });
            }
            Err(Failure::Fatal(message)) => return Err(message),
            Err(Failure::Transient(message)) => {
                let remaining = budget.remaining()?;
                if attempt == policy.max_attempts {
                    return Err(format!("{message}; exhausted {attempt} transport attempts"));
                }
                let delay = policy.retry_delay.saturating_mul(attempt as u32);
                if delay >= remaining {
                    return Err(format!(
                        "{message}; insufficient total download budget for retry"
                    ));
                }
                eprintln!(
                    "{message}; retrying native model from byte zero ({attempt}/{})",
                    policy.max_attempts
                );
                tokio::time::sleep(delay).await;
            }
        }
    }
    unreachable!("nonzero bounded attempts return above")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize},
        Arc, Mutex,
    };
    use std::thread::JoinHandle;

    const DATA: &[u8] = b"hash-pinned synthetic model";

    struct Area(PathBuf);
    impl Area {
        fn new() -> Self {
            loop {
                let path = std::env::temp_dir().join(format!(
                    "aiolm-model-download-test-{}-{}",
                    std::process::id(),
                    NEXT_PART.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("temporary model test directory: {error}"),
                }
            }
        }
        fn destination(&self) -> PathBuf {
            self.0.join("model with spaces.gguf")
        }
        fn cache(&self) -> PathBuf {
            self.0.join("cache")
        }
    }
    impl Drop for Area {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Clone)]
    enum Reply {
        Body {
            status: u16,
            declared: Option<usize>,
            bytes: Vec<u8>,
        },
        StalledBody,
    }

    struct Server {
        url: String,
        requests: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
        diagnostics: Arc<Mutex<Vec<String>>>,
    }
    impl Server {
        fn new(replies: Vec<Reply>) -> Self {
            Self::with_inherited_nonblocking(replies, false)
        }
        fn with_inherited_nonblocking(replies: Vec<Reply>, force_nonblocking: bool) -> Self {
            assert!(!replies.is_empty());
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}/model.gguf", listener.local_addr().unwrap());
            let requests = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let counted = requests.clone();
            let stopped = stop.clone();
            let diagnostics = Arc::new(Mutex::new(Vec::new()));
            let recorded = diagnostics.clone();
            let worker = std::thread::spawn(move || {
                while !stopped.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            if force_nonblocking {
                                stream.set_nonblocking(true).unwrap();
                            }
                            match Self::read_request(&mut stream) {
                                Ok(true) => {
                                    let index = counted.fetch_add(1, Ordering::AcqRel);
                                    let reply = &replies[index.min(replies.len() - 1)];
                                    if let Err(error) = Self::respond(&mut stream, reply, &stopped)
                                    {
                                        recorded
                                            .lock()
                                            .unwrap()
                                            .push(format!("response {index}: {:?}", error.kind()));
                                    }
                                }
                                Ok(false) => recorded
                                    .lock()
                                    .unwrap()
                                    .push("incomplete request headers".into()),
                                Err(error) => recorded
                                    .lock()
                                    .unwrap()
                                    .push(format!("request headers: {:?}", error.kind())),
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(2))
                        }
                        Err(error) => panic!("local model fixture accept: {error}"),
                    }
                }
            });
            Self {
                url,
                requests,
                stop,
                worker: Some(worker),
                diagnostics,
            }
        }
        fn read_request(stream: &mut TcpStream) -> std::io::Result<bool> {
            // Accepted sockets may inherit the listener's nonblocking flag on
            // Darwin. WouldBlock is not the end of an HTTP request.
            stream.set_nonblocking(false)?;
            let deadline = Instant::now() + Duration::from_secs(1);
            let mut request = vec![];
            let mut byte = [0_u8; 1];
            while request.len() < 8192 && !request.ends_with(b"\r\n\r\n") {
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .filter(|remaining| !remaining.is_zero())
                    .ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "fixture header budget elapsed",
                        )
                    })?;
                stream.set_read_timeout(Some(remaining))?;
                match stream.read(&mut byte)? {
                    0 => return Ok(false),
                    _ => request.push(byte[0]),
                }
            }
            Ok(request.ends_with(b"\r\n\r\n"))
        }
        fn respond(
            stream: &mut TcpStream,
            reply: &Reply,
            stop: &AtomicBool,
        ) -> std::io::Result<()> {
            let (status, declared, bytes) = match reply {
                Reply::Body {
                    status,
                    declared,
                    bytes,
                } => (*status, *declared, bytes.as_slice()),
                Reply::StalledBody => (200, Some(DATA.len()), &DATA[..1]),
            };
            let mut headers = format!("HTTP/1.1 {status} Fixture\r\nConnection: close\r\n");
            if let Some(length) = declared {
                headers.push_str(&format!("Content-Length: {length}\r\n"));
            }
            headers.push_str("\r\n");
            let mut response = headers.into_bytes();
            response.extend_from_slice(bytes);
            stream.write_all(&response)?;
            stream.flush()?;
            if matches!(reply, Reply::StalledBody) {
                let deadline = Instant::now() + Duration::from_secs(1);
                while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(2));
                }
                return Ok(());
            }
            // Deliver a finite HTTP response with an orderly FIN, including
            // intentional Content-Length truncation. Bound peer draining so
            // dropping the socket never turns unread input into a TCP reset.
            stream.shutdown(Shutdown::Write)?;
            let deadline = Instant::now() + Duration::from_millis(200);
            let mut discard = [0_u8; 1024];
            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                if remaining.is_zero() {
                    break;
                }
                stream.set_read_timeout(Some(remaining))?;
                match stream.read(&mut discard) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::TimedOut
                                | std::io::ErrorKind::WouldBlock
                                | std::io::ErrorKind::ConnectionReset
                        ) =>
                    {
                        break
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok(())
        }
        fn count(&self) -> usize {
            self.requests.load(Ordering::Acquire)
        }
        fn diagnostics(&self) -> Vec<String> {
            self.diagnostics.lock().unwrap().clone()
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.worker.take().unwrap().join().unwrap();
        }
    }

    fn good() -> Reply {
        Reply::Body {
            status: 200,
            declared: Some(DATA.len()),
            bytes: DATA.to_vec(),
        }
    }
    fn hash(data: &[u8]) -> String {
        format!("{:x}", Sha256::digest(data))
    }
    fn policy() -> DownloadPolicy {
        DownloadPolicy {
            max_attempts: 3,
            total_budget: Duration::from_secs(2),
            idle_timeout: Duration::from_millis(200),
            retry_delay: Duration::from_millis(2),
        }
    }
    fn client() -> Client {
        Client::builder().no_proxy().build().unwrap()
    }
    fn spec<'a>(url: &'a str, sha: &'a str) -> ModelSpec<'a> {
        ModelSpec {
            url,
            sha256: sha,
            bytes: DATA.len() as u64,
        }
    }
    fn no_partials(area: &Area) {
        for directory in [&area.0, &area.cache()] {
            if directory.is_dir() {
                assert!(fs::read_dir(directory).unwrap().all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".part")));
            }
        }
    }

    #[test]
    fn inherited_nonblocking_socket_waits_for_complete_fragmented_headers() {
        let server = Server::with_inherited_nonblocking(vec![good()], true);
        let mut stream = TcpStream::connect(
            server
                .url
                .trim_start_matches("http://")
                .trim_end_matches("/model.gguf"),
        )
        .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        stream
            .write_all(b"GET /model.gguf HTTP/1.1\r\nHost: local-fixture")
            .unwrap();
        let mut byte = [0_u8; 1];
        let error = stream
            .read(&mut byte)
            .expect_err("partial headers must not receive a response");
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
        ));
        assert_eq!(server.count(), 0, "no response before header terminator");
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        stream.write_all(b"\r\n\r\n").unwrap();
        let mut response = vec![];
        stream.read_to_end(&mut response).unwrap();
        assert!(response.starts_with(b"HTTP/1.1 200"));
        assert!(response.ends_with(DATA));
        assert_eq!(server.count(), 1);
        assert!(
            server.diagnostics().is_empty(),
            "{:?}",
            server.diagnostics()
        );
    }

    #[tokio::test]
    async fn truncated_body_restarts_from_zero_and_publishes_only_a_verified_cache() {
        let area = Area::new();
        let server = Server::new(vec![
            Reply::Body {
                status: 200,
                declared: Some(DATA.len()),
                bytes: DATA[..3].to_vec(),
            },
            good(),
        ]);
        let sha = hash(DATA);
        let outcome = acquire_model(
            &client(),
            &spec(&server.url, &sha),
            &area.destination(),
            Some(&area.cache()),
            policy(),
        )
        .await
        .unwrap();
        assert_eq!(outcome.attempts, 2);
        assert!(!outcome.cache_hit);
        assert_eq!(server.count(), 2);
        assert_eq!(fs::read(area.destination()).unwrap(), DATA);
        assert_eq!(
            fs::read(area.cache().join(format!("{sha}.gguf"))).unwrap(),
            DATA
        );
        no_partials(&area);
    }

    #[tokio::test]
    async fn transient_http_retries_but_not_found_does_not() {
        for (status, expected_requests) in [(408, 2), (429, 2), (503, 2), (404, 1)] {
            let area = Area::new();
            let server = Server::new(vec![
                Reply::Body {
                    status,
                    declared: Some(0),
                    bytes: vec![],
                },
                good(),
            ]);
            let sha = hash(DATA);
            let result = acquire_model(
                &client(),
                &spec(&server.url, &sha),
                &area.destination(),
                None,
                policy(),
            )
            .await;
            assert_eq!(server.count(), expected_requests, "HTTP {status}");
            assert_eq!(result.is_ok(), status != 404);
            if status == 404 {
                assert!(!area.destination().exists());
            }
            no_partials(&area);
        }
    }

    #[tokio::test]
    async fn integrity_and_oversized_responses_fail_without_retry_or_cache_publication() {
        for (case, reply) in [
            (
                "same-size hash mismatch",
                Reply::Body {
                    status: 200,
                    declared: Some(DATA.len()),
                    bytes: vec![b'x'; DATA.len()],
                },
            ),
            (
                "unframed body oversized",
                Reply::Body {
                    status: 200,
                    declared: None,
                    bytes: vec![b'x'; DATA.len() + 1],
                },
            ),
            (
                "declared size oversized",
                Reply::Body {
                    status: 200,
                    declared: Some(DATA.len() + 1),
                    bytes: vec![b'x'; DATA.len() + 1],
                },
            ),
            (
                "declared size short",
                Reply::Body {
                    status: 200,
                    declared: Some(1),
                    bytes: vec![b'x'],
                },
            ),
        ] {
            let area = Area::new();
            let server = Server::new(vec![reply, good()]);
            let sha = hash(DATA);
            let error = acquire_model(
                &client(),
                &spec(&server.url, &sha),
                &area.destination(),
                Some(&area.cache()),
                policy(),
            )
            .await
            .unwrap_err();
            assert!(
                error.contains("size") || error.contains("SHA-256"),
                "{case}: {error}; fixture: {:?}",
                server.diagnostics()
            );
            assert_eq!(server.count(), 1, "{case}");
            assert!(!area.destination().exists());
            assert!(!area.cache().join(format!("{sha}.gguf")).exists());
            no_partials(&area);
        }
    }

    #[tokio::test]
    async fn repeated_truncation_stops_after_three_attempts_and_removes_the_partial() {
        let area = Area::new();
        let server = Server::new(vec![Reply::Body {
            status: 200,
            declared: Some(DATA.len()),
            bytes: DATA[..3].to_vec(),
        }]);
        let sha = hash(DATA);
        let error = acquire_model(
            &client(),
            &spec(&server.url, &sha),
            &area.destination(),
            Some(&area.cache()),
            policy(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("exhausted 3"), "{error}");
        assert_eq!(server.count(), 3);
        assert!(!area.destination().exists());
        assert!(!area.cache().join(format!("{sha}.gguf")).exists());
        no_partials(&area);
    }

    #[tokio::test]
    async fn one_total_budget_bounds_a_stalled_body_and_all_retries() {
        let area = Area::new();
        let server = Server::new(vec![Reply::StalledBody]);
        let sha = hash(DATA);
        let policy = DownloadPolicy {
            total_budget: Duration::from_millis(80),
            idle_timeout: Duration::from_secs(1),
            ..policy()
        };
        // The acquisition budget starts after its caller has prepared the client.
        let client_started = Instant::now();
        let client = client();
        let client_setup = client_started.elapsed();
        let spec = spec(&server.url, &sha);
        let destination = area.destination();
        let started = Instant::now();
        let error = acquire_model(&client, &spec, &destination, None, policy)
            .await
            .unwrap_err();
        assert!(error.contains("budget"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "client setup: {client_setup:?}; acquisition elapsed: {:?}; total budget: {:?}; idle timeout: {:?}",
            started.elapsed(),
            policy.total_budget,
            policy.idle_timeout
        );
        assert_eq!(server.count(), 1);
        assert!(!area.destination().exists());
        no_partials(&area);
    }

    #[tokio::test]
    async fn cache_hits_verify_all_bytes_and_copy_into_the_disposable_home() {
        let area = Area::new();
        fs::create_dir(area.cache()).unwrap();
        let sha = hash(DATA);
        let cached = area.cache().join(format!("{sha}.gguf"));
        fs::write(&cached, DATA).unwrap();
        let server = Server::new(vec![good()]);
        let outcome = acquire_model(
            &client(),
            &spec(&server.url, &sha),
            &area.destination(),
            Some(&area.cache()),
            policy(),
        )
        .await
        .unwrap();
        assert!(outcome.cache_hit);
        assert_eq!(outcome.attempts, 0);
        assert_eq!(server.count(), 0);
        assert_eq!(fs::read(area.destination()).unwrap(), DATA);
        fs::write(area.destination(), b"disposable mutation").unwrap();
        assert_eq!(
            fs::read(cached).unwrap(),
            DATA,
            "case model must not share a writable inode with cache"
        );
        no_partials(&area);
    }

    #[tokio::test]
    async fn invalid_cache_entries_are_rejected_without_network_or_final_model() {
        for invalid in [vec![b'x'; DATA.len()], vec![b'x'; DATA.len() + 1]] {
            let area = Area::new();
            fs::create_dir(area.cache()).unwrap();
            let sha = hash(DATA);
            fs::write(area.cache().join(format!("{sha}.gguf")), invalid).unwrap();
            let server = Server::new(vec![good()]);
            let error = acquire_model(
                &client(),
                &spec(&server.url, &sha),
                &area.destination(),
                Some(&area.cache()),
                policy(),
            )
            .await
            .unwrap_err();
            assert!(
                error.contains("SHA-256") || error.contains("size"),
                "{error}"
            );
            assert_eq!(server.count(), 0);
            assert!(!area.destination().exists());
            no_partials(&area);
        }
    }

    #[tokio::test]
    async fn destination_io_failure_is_permanent_and_does_not_start_a_request() {
        let area = Area::new();
        let parent = area.0.join("not-a-directory");
        fs::write(&parent, b"owned fixture").unwrap();
        let server = Server::new(vec![good()]);
        let sha = hash(DATA);
        let error = acquire_model(
            &client(),
            &spec(&server.url, &sha),
            &parent.join("model.gguf"),
            None,
            policy(),
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("destination") || error.contains("directory"),
            "{error}"
        );
        assert_eq!(server.count(), 0);
        assert_eq!(fs::read(parent).unwrap(), b"owned fixture");
    }
}
