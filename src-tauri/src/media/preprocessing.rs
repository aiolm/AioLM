//! Bounded video frame extraction from immutable app-owned references.
//!
//! Native vllm-metal v0.30.0 has no video chat (`docs/supported_models.md`:
//! image-only vision, no video). This preprocessing extracts at most four
//! sampled stills with a local `ffmpeg` binary so they can travel as ordinary
//! image parts to an image-capable answering model. The original video
//! reference stays in history and the selected answering runtime is never
//! switched. No model install, no download, no network access, no fallback:
//! a missing `ffmpeg` binary is an explicit error.
//!
//! The first decoded frame and subsequent frames at least five seconds apart
//! are selected. Timestamps come from ffmpeg's decoded presentation times,
//! relative to the first frame; they are never inferred from output filenames.

use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Highest sampled stills per video (matches the four-media-parts chat bound).
pub const MAX_VIDEO_FRAMES: usize = 4;
/// Minimum source seconds between selected frames.
pub const FRAME_INTERVAL_SECS: f64 = 5.0;
/// Longest `ffmpeg` frame extraction may run before it is killed.
pub const FFMPEG_TIMEOUT_SECS: u64 = 120;
/// Largest single extracted frame image (10 MiB keeps four frames well under
/// the 128 MiB decoded-media message bound even after base64 expansion).
pub const MAX_FRAME_BYTES: u64 = 10 * 1024 * 1024;

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrame {
    #[serde(rename = "ref")]
    pub reference: String,
    pub timestamp_seconds: f64,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrames {
    pub frames: Vec<VideoFrame>,
}

/// Bounded `ffmpeg` argv selecting the first frame and frames five seconds apart.
/// `-nostdin` prevents interactive prompts; no network input is accepted
/// because the input is an already-validated owned store path.
pub fn ffmpeg_frame_args(
    owned_input: &Path,
    output_pattern: &Path,
    max_frames: usize,
) -> Vec<OsString> {
    let frames = max_frames.clamp(1, MAX_VIDEO_FRAMES).to_string();
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("info"),
        OsString::from("-nostats"),
        OsString::from("-nostdin"),
        OsString::from("-protocol_whitelist"),
        OsString::from("file,pipe"),
        OsString::from("-i"),
        OsString::from(owned_input),
        OsString::from("-vf"),
        OsString::from(format!("setpts=PTS-STARTPTS,select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,{FRAME_INTERVAL_SECS}),scale=768:-1,showinfo")),
        OsString::from("-fps_mode"),
        OsString::from("vfr"),
        OsString::from("-frames:v"),
        OsString::from(frames),
        OsString::from("-q:v"),
        OsString::from("2"),
        OsString::from(output_pattern),
    ]
}

/// Resolve `reference` through the app-owned store check. Thin wrapper so
/// preprocessors share the exact ownership validation as chat attachments.
pub fn resolve_owned_video(reference: &str) -> Result<PathBuf, String> {
    super::owned_path(reference)
}

/// Validate one extracted frame before it is imported as an image part:
/// it must be a nonempty regular file inside `temp_dir` with an image
/// extension and within `MAX_FRAME_BYTES`.
pub fn validate_frame_output(path: &Path, temp_dir: &Path) -> Result<u64, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("sampled frame is missing: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("sampled frame was replaced by a link".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("sampled frame is missing: {error}"))?;
    let directory = temp_dir
        .canonicalize()
        .map_err(|error| format!("frame directory is unavailable: {error}"))?;
    if canonical.parent() != Some(directory.as_path()) {
        return Err("sampled frame escaped its temporary directory".into());
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
        return Err("sampled frame must be a png/jpg/webp image".into());
    }
    let metadata = std::fs::symlink_metadata(&canonical)
        .map_err(|error| format!("sampled frame is missing: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("sampled frame was replaced by a link".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_FRAME_BYTES {
        return Err("sampled frame must be nonempty and at most 10 MiB".into());
    }
    if metadata.len() > super::MAX_MEDIA_BYTES {
        return Err("sampled frame exceeds the media store limit".into());
    }
    Ok(metadata.len())
}

/// Temporary extraction directory that is removed on every exit path,
/// including cancellation, timeout and import failure. The guard owns the
/// directory for the whole extraction; dropping it cleans up.
struct TempFrames {
    path: PathBuf,
}

impl TempFrames {
    fn create(parent: &Path) -> Result<Self, String> {
        let path = parent.join(format!("aiolm-frames-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("frame directory is unavailable: {error}"))?;
        Ok(Self { path })
    }
}

impl Drop for TempFrames {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A spawned `ffmpeg` child. The trait keeps the wait/kill lifecycle in the
/// shared orchestration below while tests script realistic stub children
/// without a native binary or engine.
trait FrameChild {
    fn frame_timestamps(&self) -> Result<Vec<f64>, String>;
    /// `Ok(None)` while running, `Ok(Some(code))` when exited.
    fn try_wait(&mut self) -> Result<Option<i32>, String>;
    /// Stop a cancelled or timed-out extraction.
    fn kill(&mut self) -> Result<(), String>;
    /// Reap the child after `kill` (stdio is null, so there are no pipes to
    /// drain; waiting reaps the zombie).
    fn wait(&mut self) -> Result<i32, String>;
}

struct SystemChild(std::process::Child, PathBuf);

impl Drop for SystemChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn parse_frame_timestamps(log: &str) -> Result<Vec<f64>, String> {
    let mut times = Vec::new();
    for line in log
        .lines()
        .filter(|line| line.contains("showinfo") && line.contains("pts_time:"))
    {
        let value = line
            .split_once("pts_time:")
            .unwrap()
            .1
            .split_whitespace()
            .next()
            .unwrap_or("");
        let time: f64 = value
            .parse()
            .map_err(|_| "invalid sampled frame timestamp")?;
        if !time.is_finite() || time < 0.0 || times.last().is_some_and(|previous| time <= *previous)
        {
            return Err("invalid sampled frame timestamp order".into());
        }
        times.push(time);
        if times.len() == MAX_VIDEO_FRAMES {
            break;
        }
    }
    Ok(times)
}

impl FrameChild for SystemChild {
    fn frame_timestamps(&self) -> Result<Vec<f64>, String> {
        let file = std::fs::File::open(&self.1).map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > 64 * 1024 {
            return Err("frame extraction diagnostics exceeded the size limit".into());
        }
        parse_frame_timestamps(&String::from_utf8_lossy(&bytes))
    }
    fn try_wait(&mut self) -> Result<Option<i32>, String> {
        self.0
            .try_wait()
            .map_err(|error| format!("frame extraction failed: {error}"))
            .map(|status| status.map(|status| status.code().unwrap_or(-1)))
    }

    fn kill(&mut self) -> Result<(), String> {
        self.0
            .kill()
            .map_err(|error| format!("frame extraction failed: {error}"))
    }

    fn wait(&mut self) -> Result<i32, String> {
        self.0
            .wait()
            .map_err(|error| format!("frame extraction failed: {error}"))
            .map(|status| status.code().unwrap_or(-1))
    }
}

/// Spawns the bounded `ffmpeg` argv for one extraction. Scripted by stubs in
/// tests; the production implementation launches the local binary.
fn spawn_system_ffmpeg(
    input: &Path,
    output_pattern: &Path,
    max_frames: usize,
) -> Result<Box<dyn FrameChild>, String> {
    let args = ffmpeg_frame_args(input, output_pattern, max_frames);
    let log = output_pattern
        .parent()
        .ok_or("missing frame directory")?
        .join("frame-times.log");
    let diagnostics = std::fs::File::create(&log).map_err(|error| error.to_string())?;
    let child = crate::procutil::std_command("ffmpeg")
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(diagnostics)
        .spawn()
        .map_err(|error| format!("video frame sampling needs a local ffmpeg binary ({error})"))?;
    Ok(Box::new(SystemChild(child, log)))
}

/// Import one validated frame file into immutable owned image storage.
/// Returns only the new image reference; the temporary path and any data
/// URL are never persisted.
fn import_frame_to_store(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    super::import_selected(path, file).map(|attachment| attachment.reference)
}

/// Shared extraction orchestration. All filesystem/process collaborators are
/// injected so tests exercise the real lifecycle (validation, timeout and
/// cancellation kills with reap, temp cleanup, source integrity, bounded
/// import) against scripted stubs without touching the real media store.
type FrameSpawner<'a> = dyn Fn(&Path, &Path, usize) -> Result<Box<dyn FrameChild>, String> + 'a;

#[allow(clippy::too_many_arguments)]
fn extract_inner(
    reference: &str,
    cancel: &AtomicBool,
    resolve: &dyn Fn(&str) -> Result<PathBuf, String>,
    spawn: &FrameSpawner<'_>,
    import_frame: &dyn Fn(&Path) -> Result<String, String>,
    timeout: Duration,
    temp_parent: &Path,
    max_frames: usize,
) -> Result<VideoFrames, String> {
    if cancel.load(Ordering::Acquire) {
        return Err("video frame extraction cancelled".into());
    }
    // Only owned immutable video references are accepted. `resolve` enforces
    // the `<64-hex>.<ext>` store shape, so URLs, absolute paths and
    // traversal strings never reach the process spawn.
    let source = resolve(reference)?;
    // Best-effort revalidation just before use: the store file must still be
    // a regular unlinked file and still decode as video.
    let metadata = std::fs::symlink_metadata(&source)
        .map_err(|error| format!("attachment is missing: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("owned media was replaced by a link".into());
    }
    if super::mime(&source).map(|(kind, _)| kind) != Some("video") {
        return Err("select a video attachment for frame sampling".into());
    }
    // `owned_path` verifies the path, not the bytes: hash the source content
    // here so a swapped file cannot ride on a valid reference.
    let expected = reference
        .split_once('.')
        .map(|(hash, _)| hash)
        .unwrap_or_default();
    let temp = TempFrames::create(temp_parent)?;
    let snapshot = temp.path.join(format!(
        "source.{}",
        source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("mp4")
    ));
    let mut snapshot_file = std::fs::File::create(&snapshot).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut file = std::fs::File::open(&source).map_err(|error| error.to_string())?;
    let mut bounded = (&mut file).take(super::MAX_MEDIA_BYTES + 1);
    let mut checked: u64 = 0;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("video frame extraction cancelled".into());
        }
        let read = bounded
            .read(&mut chunk)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        checked += read as u64;
        snapshot_file
            .write_all(&chunk[..read])
            .map_err(|error| error.to_string())?;
        hasher.update(&chunk[..read]);
    }
    if checked == 0 || checked > super::MAX_MEDIA_BYTES {
        return Err("stored media must be nonempty and at most 64 MiB".into());
    }
    if format!("{:x}", hasher.finalize()) != expected.to_ascii_lowercase() {
        return Err("stored video no longer matches its immutable reference".into());
    }
    if cancel.load(Ordering::Acquire) {
        return Err("video frame extraction cancelled".into());
    }
    drop(snapshot_file);
    let pattern = temp.path.join("frame-%02d.jpg");
    let mut child = spawn(&snapshot, &pattern, max_frames)?;
    let started = Instant::now();
    let code = loop {
        if cancel.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("video frame extraction cancelled".into());
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("video frame extraction timed out".into());
        }
        match child.try_wait() {
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(Some(code)) => break code,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    if code != 0 {
        let _ = child.wait();
        return Err(format!("video frame sampling failed (ffmpeg exit {code})"));
    }
    if cancel.load(Ordering::Acquire) {
        return Err("video frame extraction cancelled".into());
    }
    // Collect this extraction's outputs only, in sorted output order, capped
    // at the bound even if the binary emitted more.
    let mut produced: Vec<PathBuf> = std::fs::read_dir(&temp.path)
        .map_err(|error| format!("frame directory is unavailable: {error}"))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("frame-"))
        })
        .collect();
    produced.sort();
    if produced.is_empty() {
        return Err("video frame sampling produced no frames".into());
    }
    produced.truncate(max_frames.clamp(1, MAX_VIDEO_FRAMES));
    let timestamps = child.frame_timestamps()?;
    if timestamps.len() < produced.len() {
        return Err("frame sampling did not report presentation timestamps".into());
    }
    let mut frames = Vec::with_capacity(produced.len());
    for (index, path) in produced.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            return Err("video frame extraction cancelled".into());
        }
        validate_frame_output(path, &temp.path)?;
        let imported = import_frame(path)?;
        frames.push(VideoFrame {
            reference: imported,
            timestamp_seconds: timestamps[index],
        });
    }
    // `temp` drops here on success and on every error return above.
    Ok(VideoFrames { frames })
}

/// Sample at most four stills from an owned immutable video reference.
///
/// See the module docs for the lifecycle: bounded local `ffmpeg`, 120s
/// timeout, kill plus reap on cancel/timeout/failure, RAII temp cleanup on
/// all exits, source SHA256 verification, and import of valid frames to
/// immutable owned image refs. Never downloads, installs or falls back.
pub async fn extract_video_frames(
    reference: &str,
    max_frames: usize,
    cancel: Arc<AtomicBool>,
) -> Result<VideoFrames, String> {
    if !(1..=MAX_VIDEO_FRAMES).contains(&max_frames) {
        return Err("request between one and four video frames".into());
    }
    let reference = reference.to_owned();
    tokio::task::spawn_blocking(move || {
        extract_inner(
            &reference,
            &cancel,
            &resolve_owned_video,
            &spawn_system_ffmpeg,
            &import_frame_to_store,
            Duration::from_secs(FFMPEG_TIMEOUT_SECS),
            &std::env::temp_dir(),
            max_frames,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Scripted stub child: exits with `exit_code` after `polls_before_exit`
    /// `try_wait` polls, or never exits when `exit_code` is `None`.
    struct StubChild {
        polls_before_exit: usize,
        exit_code: Option<i32>,
        polls: usize,
        killed_child: bool,
        waited: bool,
    }

    impl StubChild {
        fn exiting(polls_before_exit: usize, exit_code: i32) -> Self {
            Self {
                polls_before_exit,
                exit_code: Some(exit_code),
                polls: 0,
                killed_child: false,
                waited: false,
            }
        }

        fn hanging() -> Self {
            Self {
                polls_before_exit: usize::MAX,
                exit_code: None,
                polls: 0,
                killed_child: false,
                waited: false,
            }
        }
    }

    impl FrameChild for StubChild {
        fn frame_timestamps(&self) -> Result<Vec<f64>, String> {
            Ok(vec![
                0.0,
                FRAME_INTERVAL_SECS,
                2.0 * FRAME_INTERVAL_SECS,
                3.0 * FRAME_INTERVAL_SECS,
            ])
        }
        fn try_wait(&mut self) -> Result<Option<i32>, String> {
            self.polls += 1;
            if self.killed_child {
                // A killed stub reaps immediately.
                return Ok(Some(-9));
            }
            match self.exit_code {
                Some(code) if self.polls > self.polls_before_exit => Ok(Some(code)),
                _ => Ok(None),
            }
        }

        fn kill(&mut self) -> Result<(), String> {
            self.killed_child = true;
            Ok(())
        }

        fn wait(&mut self) -> Result<i32, String> {
            self.waited = true;
            Ok(if self.killed_child {
                -9
            } else {
                self.exit_code.unwrap_or(0)
            })
        }
    }

    struct StubSpawn {
        child: Mutex<Option<StubChild>>,
        spawned: Mutex<usize>,
        /// Frame payloads the stub writes into the output directory.
        outputs: Vec<Vec<u8>>,
        on_spawn: Option<Box<dyn Fn() + Send + Sync>>,
    }

    impl StubSpawn {
        fn succeeding(outputs: Vec<Vec<u8>>) -> Self {
            Self {
                child: Mutex::new(Some(StubChild::exiting(2, 0))),
                spawned: Mutex::new(0),
                outputs,
                on_spawn: None,
            }
        }
    }

    /// Test scaffolding: a fake owned store under a temp root. `resolve`
    /// mirrors the production shape check (`<64-hex>.<ext>` inside the fake
    /// root); content hashing and MIME checks run in the shared `extract_inner`.
    struct FakeStore {
        root: PathBuf,
    }

    impl FakeStore {
        fn create() -> Self {
            let root =
                std::env::temp_dir().join(format!("aiolm-fakestore-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn add(&self, bytes: &[u8], extension: &str) -> String {
            let reference = format!("{:x}.{extension}", Sha256::digest(bytes));
            std::fs::write(self.root.join(&reference), bytes).unwrap();
            reference
        }

        fn resolve(&self) -> impl Fn(&str) -> Result<PathBuf, String> + '_ {
            |reference: &str| {
                let Some((hash, extension)) = reference.split_once('.') else {
                    return Err("invalid media reference".into());
                };
                if hash.len() != 64
                    || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || !["mp4", "webm", "mp3", "wav", "png", "jpg"].contains(&extension)
                {
                    return Err("invalid media reference".into());
                }
                let path = self.root.join(reference);
                let metadata = std::fs::symlink_metadata(&path)
                    .map_err(|_| "attachment is missing".to_string())?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("owned media was replaced by a link".into());
                }
                Ok(path)
            }
        }

        /// Stub importer: validates the frame file, then mints an immutable
        /// `<content-sha>.jpg` reference without touching any real store.
        fn import(&self) -> impl Fn(&Path) -> Result<String, String> + '_ {
            |path: &Path| {
                let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
                if bytes.is_empty() || bytes.len() as u64 > MAX_FRAME_BYTES {
                    return Err("sampled frame must be nonempty and at most 10 MiB".into());
                }
                Ok(format!("{:x}.jpg", Sha256::digest(&bytes)))
            }
        }
    }

    impl Drop for FakeStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn run_with(
        store: &FakeStore,
        stub: &StubSpawn,
        reference: &str,
        cancel: &AtomicBool,
        timeout: Duration,
        temp_parent: &Path,
    ) -> Result<VideoFrames, String> {
        extract_inner(
            reference,
            cancel,
            &store.resolve(),
            &|_input, pattern, _max| {
                *stub.spawned.lock().unwrap() += 1;
                // The stub honors the caller's output pattern directory and
                // writes its scripted frame payloads there.
                let directory = pattern.parent().ok_or("frame pattern has no directory")?;
                for (index, payload) in stub.outputs.iter().enumerate() {
                    std::fs::write(
                        directory.join(format!("frame-{:02}.jpg", index + 1)),
                        payload,
                    )
                    .map_err(|error| error.to_string())?;
                }
                if let Some(hook) = &stub.on_spawn {
                    hook();
                }
                let child = stub
                    .child
                    .lock()
                    .unwrap()
                    .take()
                    .ok_or("stub child consumed")?;
                Ok(Box::new(child) as Box<dyn FrameChild>)
            },
            &store.import(),
            timeout,
            temp_parent,
            MAX_VIDEO_FRAMES,
        )
    }

    fn temp_parent() -> PathBuf {
        let parent = std::env::temp_dir().join(format!("aiolm-frametest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        parent
    }

    #[test]
    fn successful_extraction_imports_bounded_frames_with_honest_timestamps() {
        let store = FakeStore::create();
        let parent = temp_parent();
        let video = store.add(b"fake-video-bytes", "mp4");
        let stub = StubSpawn::succeeding(vec![
            b"frame-one".to_vec(),
            b"frame-two".to_vec(),
            b"frame-three".to_vec(),
        ]);
        let cancel = AtomicBool::new(false);
        let result = run_with(
            &store,
            &stub,
            &video,
            &cancel,
            Duration::from_secs(30),
            &parent,
        )
        .unwrap();
        assert_eq!(result.frames.len(), 3);
        assert_eq!(
            result
                .frames
                .iter()
                .map(|frame| frame.timestamp_seconds)
                .collect::<Vec<_>>(),
            vec![0.0, FRAME_INTERVAL_SECS, 2.0 * FRAME_INTERVAL_SECS]
        );
        for frame in &result.frames {
            assert!(frame.reference.ends_with(".jpg"));
            assert_eq!(frame.reference.len(), 68);
        }
        // Temp extraction directories are removed; only the test parent remains.
        let leftovers: Vec<_> = std::fs::read_dir(&parent).unwrap().collect();
        assert!(leftovers.is_empty());
        assert_eq!(*stub.spawned.lock().unwrap(), 1);
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn short_videos_still_yield_a_nonempty_frame() {
        let store = FakeStore::create();
        let parent = temp_parent();
        let video = store.add(b"tiny", "webm");
        let stub = StubSpawn::succeeding(vec![b"only".to_vec()]);
        let result = run_with(
            &store,
            &stub,
            &video,
            &AtomicBool::new(false),
            Duration::from_secs(30),
            &parent,
        )
        .unwrap();
        assert_eq!(result.frames.len(), 1);
        assert_eq!(result.frames[0].timestamp_seconds, 0.0);
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn failing_ffmpeg_reports_and_cleans_up_without_imports() {
        struct Failing;
        let store = FakeStore::create();
        let parent = temp_parent();
        let video = store.add(b"fake-video-bytes", "mp4");
        let imports = Mutex::new(0usize);
        let error = extract_inner(
            &video,
            &AtomicBool::new(false),
            &store.resolve(),
            &|_input, _pattern, _max| Ok(Box::new(StubChild::exiting(0, 1)) as Box<dyn FrameChild>),
            &|_path| {
                *imports.lock().unwrap() += 1;
                Ok("never.jpg".to_string())
            },
            Duration::from_secs(30),
            &parent,
            MAX_VIDEO_FRAMES,
        )
        .unwrap_err();
        assert!(error.contains("ffmpeg exit 1"), "{error}");
        assert_eq!(*imports.lock().unwrap(), 0);
        assert!(std::fs::read_dir(&parent).unwrap().next().is_none());
        std::fs::remove_dir_all(&parent).unwrap();
        let _ = Failing;
    }

    #[test]
    fn timeout_kills_reaps_and_cleans_up() {
        let store = FakeStore::create();
        let parent = temp_parent();
        let video = store.add(b"fake-video-bytes", "mp4");
        let stub = StubSpawn {
            child: Mutex::new(Some(StubChild::hanging())),
            spawned: Mutex::new(0),
            outputs: Vec::new(),
            on_spawn: None,
        };
        let error = run_with(
            &store,
            &stub,
            &video,
            &AtomicBool::new(false),
            Duration::from_millis(80),
            &parent,
        )
        .unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        assert!(std::fs::read_dir(&parent).unwrap().next().is_none());
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn missing_binary_is_an_explicit_error_without_fallback() {
        let store = FakeStore::create();
        let parent = temp_parent();
        let video = store.add(b"fake-video-bytes", "mp4");
        let error = extract_inner(
            &video,
            &AtomicBool::new(false),
            &store.resolve(),
            &|_input, _pattern, _max| {
                Err("video frame sampling needs a local ffmpeg binary (not found)".into())
            },
            &store.import(),
            Duration::from_secs(30),
            &parent,
            MAX_VIDEO_FRAMES,
        )
        .unwrap_err();
        assert!(error.contains("ffmpeg"), "{error}");
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn pre_cancelled_work_never_spawns() {
        let store = FakeStore::create();
        let parent = temp_parent();
        let video = store.add(b"fake-video-bytes", "mp4");
        let stub = StubSpawn::succeeding(vec![b"frame".to_vec()]);
        let cancel = AtomicBool::new(true);
        let error = run_with(
            &store,
            &stub,
            &video,
            &cancel,
            Duration::from_secs(30),
            &parent,
        )
        .unwrap_err();
        assert!(error.contains("cancelled"), "{error}");
        assert_eq!(*stub.spawned.lock().unwrap(), 0);
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn mid_run_cancel_kills_and_returns_no_partial_state() {
        let store = FakeStore::create();
        let parent = temp_parent();
        let video = store.add(b"fake-video-bytes", "mp4");
        let stub = StubSpawn {
            child: Mutex::new(Some(StubChild::hanging())),
            spawned: Mutex::new(0),
            outputs: vec![b"frame".to_vec()],
            on_spawn: None,
        };
        let cancel = AtomicBool::new(false);
        let error = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(50));
                cancel.store(true, Ordering::Release);
            });
            run_with(
                &store,
                &stub,
                &video,
                &cancel,
                Duration::from_secs(30),
                &parent,
            )
            .unwrap_err()
        });
        assert!(error.contains("cancelled"), "{error}");
        assert!(std::fs::read_dir(&parent).unwrap().next().is_none());
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn swapped_source_bytes_fail_integrity_and_never_spawn() {
        let store = FakeStore::create();
        let parent = temp_parent();
        let reference = store.add(b"original-bytes", "mp4");
        // Swap the bytes behind a valid reference.
        std::fs::write(store.root.join(&reference), b"swapped-bytes").unwrap();
        let stub = StubSpawn::succeeding(vec![b"frame".to_vec()]);
        let error = run_with(
            &store,
            &stub,
            &reference,
            &AtomicBool::new(false),
            Duration::from_secs(30),
            &parent,
        )
        .unwrap_err();
        assert!(error.contains("immutable reference"), "{error}");
        assert_eq!(*stub.spawned.lock().unwrap(), 0);
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn non_video_refs_and_unknown_refs_are_refused_before_spawn() {
        let store = FakeStore::create();
        let parent = temp_parent();
        let audio = store.add(b"audio-bytes", "mp3");
        let stub = StubSpawn::succeeding(vec![b"frame".to_vec()]);
        let error = run_with(
            &store,
            &stub,
            &audio,
            &AtomicBool::new(false),
            Duration::from_secs(30),
            &parent,
        )
        .unwrap_err();
        assert!(error.contains("video"), "{error}");
        let error = run_with(
            &store,
            &stub,
            "not-a-reference",
            &AtomicBool::new(false),
            Duration::from_secs(30),
            &parent,
        )
        .unwrap_err();
        assert!(error.contains("invalid media reference"), "{error}");
        assert_eq!(*stub.spawned.lock().unwrap(), 0);
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn import_failure_cleans_up_the_temp_directory() {
        let store = FakeStore::create();
        let parent = temp_parent();
        let video = store.add(b"fake-video-bytes", "mp4");
        let stub = StubSpawn::succeeding(vec![b"one".to_vec(), b"two".to_vec()]);
        let calls = Mutex::new(0usize);
        let error = extract_inner(
            &video,
            &AtomicBool::new(false),
            &store.resolve(),
            &|_input, pattern, _max| {
                let directory = pattern.parent().ok_or("frame pattern has no directory")?;
                for (index, payload) in [b"one".as_slice(), b"two".as_slice()].iter().enumerate() {
                    std::fs::write(
                        directory.join(format!("frame-{:02}.jpg", index + 1)),
                        payload,
                    )
                    .map_err(|error| error.to_string())?;
                }
                Ok(Box::new(StubChild::exiting(0, 0)) as Box<dyn FrameChild>)
            },
            &|_path| {
                let mut calls = calls.lock().unwrap();
                *calls += 1;
                if *calls > 1 {
                    return Err("store unavailable".into());
                }
                Ok("first.jpg".to_string())
            },
            Duration::from_secs(30),
            &parent,
            MAX_VIDEO_FRAMES,
        )
        .unwrap_err();
        assert!(error.contains("store unavailable"), "{error}");
        assert!(std::fs::read_dir(&parent).unwrap().next().is_none());
        std::fs::remove_dir_all(&parent).unwrap();
        let _ = stub;
    }

    #[test]
    fn frame_args_are_bounded_offline_and_capped() {
        let args = ffmpeg_frame_args(
            Path::new("/store/ab.mp4"),
            Path::new("/tmp/frame-%02d.jpg"),
            99,
        );
        let joined = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined.contains("-nostdin"));
        assert!(joined.contains("-frames:v"));
        assert!(joined.contains(" 4"));
        assert!(!joined.contains("http"));
        assert!(joined.contains("-protocol_whitelist file,pipe"));
        assert!(joined.contains("showinfo"));
        assert!(!joined.contains("fps=1/5"));
        assert_eq!(
            ffmpeg_frame_args(Path::new("/s/a.mp4"), Path::new("/t/%02d.jpg"), 0)
                .iter()
                .find(|arg| *arg == "1")
                .cloned(),
            Some(OsString::from("1")),
            "zero requests still yield at least one frame slot"
        );
        // max_frames=2 yields exactly 2.
        let two = ffmpeg_frame_args(Path::new("/s/a.mp4"), Path::new("/t/%02d.jpg"), 2);
        assert!(two.iter().any(|arg| *arg == "2"));
    }

    #[test]
    fn decoded_presentation_times_are_preserved_instead_of_invented() {
        let times = parse_frame_timestamps("[Parsed_showinfo] n: 0 pts: 0 pts_time:0\n[Parsed_showinfo] n: 1 pts: 303 pts_time:5.05\n").unwrap();
        assert_eq!(times, vec![0.0, 5.05]);
        assert!(parse_frame_timestamps("[showinfo] pts_time:NaN").is_err());
        assert!(parse_frame_timestamps("[showinfo] pts_time:2\n[showinfo] pts_time:1").is_err());
    }

    #[test]
    fn frame_outputs_must_stay_inside_their_temporary_directory() {
        let root = std::env::temp_dir().join(format!("aiolm-frames-{}", uuid::Uuid::new_v4()));
        let elsewhere = std::env::temp_dir().join(format!("aiolm-else-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let good = root.join("frame-01.jpg");
        std::fs::write(&good, b"fake-jpg").unwrap();
        assert_eq!(validate_frame_output(&good, &root).unwrap(), 8);
        let outside = elsewhere.join("frame-01.jpg");
        std::fs::write(&outside, b"fake-jpg").unwrap();
        assert!(validate_frame_output(&outside, &root).is_err());
        let wrong_ext = root.join("frame-01.mp4");
        std::fs::write(&wrong_ext, b"fake").unwrap();
        assert!(validate_frame_output(&wrong_ext, &root).is_err());
        let empty = root.join("empty.jpg");
        std::fs::write(&empty, b"").unwrap();
        assert!(validate_frame_output(&empty, &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(elsewhere).unwrap();
    }
}
