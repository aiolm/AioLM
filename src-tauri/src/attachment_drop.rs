//! Short-lived native drop selections. Frontend events never supply file paths.
use crate::state::AppState;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{DragDropEvent, Emitter, EventTarget, Manager, Webview, Window, WindowEvent};
use uuid::Uuid;

const EVENT: &str = "aiolm://attachments-dropped";
// Selection metadata only: at most eight batches of 64 paths, valid for two
// minutes. Byte bounds also cap unusual OS path allocations; no file is read.
const MAX_PENDING_BATCHES: usize = 8;
const MAX_PATHS_PER_BATCH: usize = 64;
const MAX_PATH_BYTES: usize = 64 * 1024;
const MAX_BATCH_PATH_BYTES: usize = 256 * 1024;
const BATCH_LIFETIME: Duration = Duration::from_secs(120);

struct PendingDrop {
    window: String,
    created: Instant,
    paths: VecDeque<PathBuf>,
    in_flight: Option<Uuid>,
}

#[derive(Debug)]
pub(crate) struct AttachmentDropClaim {
    batch: Uuid,
    ticket: Uuid,
    path: PathBuf,
}

impl AttachmentDropClaim {
    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[derive(Default)]
pub(crate) struct AttachmentDrops {
    batches: HashMap<Uuid, PendingDrop>,
}

impl AttachmentDrops {
    /// Only the native window callback inserts selections. Keep this bounded
    /// and free of filesystem work: readers validate paths after a claim.
    pub(crate) fn capture(
        &mut self,
        window: &str,
        paths: &[PathBuf],
        now: Instant,
    ) -> Result<String, String> {
        ensure_main_window(window)?;
        if paths.is_empty() || paths.len() > MAX_PATHS_PER_BATCH {
            return Err("drop between 1 and 64 attachments at a time".into());
        }
        let mut bytes = 0usize;
        for path in paths {
            let length = path.as_os_str().len();
            bytes = bytes.saturating_add(length);
            if !path.is_absolute() || length > MAX_PATH_BYTES || bytes > MAX_BATCH_PATH_BYTES {
                return Err("dropped attachment paths exceed the selection safety limit".into());
            }
        }
        self.expire(now);
        if self.batches.len() >= MAX_PENDING_BATCHES {
            return Err("too many pending attachment drops; finish or retry the drop".into());
        }
        let id = Uuid::new_v4();
        self.batches.insert(
            id,
            PendingDrop {
                window: window.into(),
                created: now,
                paths: paths.iter().cloned().collect(),
                in_flight: None,
            },
        );
        Ok(id.to_string())
    }

    pub(crate) fn claim(
        &mut self,
        window: &str,
        id: &str,
        now: Instant,
    ) -> Result<AttachmentDropClaim, String> {
        ensure_main_window(window)?;
        let id =
            Uuid::parse_str(id).map_err(|_| "invalid attachment drop selection".to_string())?;
        self.expire(now);
        let batch = self
            .batches
            .get_mut(&id)
            .filter(|batch| batch.window == window)
            .ok_or("attachment drop expired or unavailable; drop the files again")?;
        if batch.in_flight.is_some() {
            return Err("an attachment from this drop is still being selected".into());
        }
        let path = batch
            .paths
            .pop_front()
            .ok_or("attachment drop has already been claimed")?;
        let ticket = Uuid::new_v4();
        batch.in_flight = Some(ticket);
        Ok(AttachmentDropClaim {
            batch: id,
            ticket,
            path,
        })
    }

    /// The caller retains the store lock through reader-grant publication.
    /// Discard/expiry can invalidate a claim while its path resolves, including
    /// the last path: the batch stays live until this exact ticket completes.
    pub(crate) fn complete(
        &mut self,
        window: &str,
        claim: &AttachmentDropClaim,
        now: Instant,
    ) -> Result<(), String> {
        ensure_main_window(window)?;
        self.expire(now);
        let batch = self
            .batches
            .get_mut(&claim.batch)
            .filter(|batch| batch.window == window && batch.in_flight == Some(claim.ticket))
            .ok_or("attachment drop cancelled or expired before selection completed")?;
        batch.in_flight = None;
        if batch.paths.is_empty() {
            self.batches.remove(&claim.batch);
        }
        Ok(())
    }

    pub(crate) fn discard(&mut self, window: &str, id: &str, now: Instant) -> Result<(), String> {
        ensure_main_window(window)?;
        let id =
            Uuid::parse_str(id).map_err(|_| "invalid attachment drop selection".to_string())?;
        if self
            .batches
            .get(&id)
            .is_some_and(|batch| batch.window != window)
        {
            return Err("attachment drop belongs to another window".into());
        }
        self.expire(now);
        // Idempotent after the last claim, including frontend finally cleanup.
        self.batches.remove(&id);
        Ok(())
    }

    fn expire(&mut self, now: Instant) {
        self.batches
            .retain(|_, batch| now.saturating_duration_since(batch.created) < BATCH_LIFETIME);
    }
}

fn ensure_main_window(window: &str) -> Result<(), String> {
    if window != "main" {
        return Err("attachments can only be selected in the main window".into());
    }
    Ok(())
}

pub(crate) fn ensure_main_webview(webview: &str, window: &str) -> Result<(), String> {
    ensure_main_window(window)?;
    ensure_main_window(webview)
}

#[derive(Clone, serde::Serialize)]
struct DropPosition {
    x: f64,
    y: f64,
}

#[derive(Clone, serde::Serialize)]
struct DroppedAttachments {
    id: Option<String>,
    count: usize,
    /// Physical webview coordinates, matching Tauri's native Drop event.
    position: DropPosition,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    // Tauri routes a window-content webview's native drop through WindowEvent;
    // child-webview events are separate and must not capture a second batch.
    let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event else {
        return;
    };
    let Some(main) = window.get_webview_window("main") else {
        return;
    };
    let webview: &Webview = main.as_ref();
    if ensure_main_webview(webview.label(), webview.window().label()).is_err() {
        return;
    }
    let state = webview.state::<AppState>();
    // Never wait for a command or touch the filesystem on the GUI thread.
    let result = match state.attachment_drops.try_lock() {
        Ok(mut drops) => drops.capture(webview.window().label(), paths, Instant::now()),
        Err(_) => Err("attachment drop selection is busy; drop the files again".into()),
    };
    let (id, error) = match result {
        Ok(id) => (Some(id), None),
        Err(error) => (None, Some(error)),
    };
    let _ = webview.emit_to(
        EventTarget::webview(webview.label()),
        EVENT,
        DroppedAttachments {
            id,
            count: paths.len(),
            position: DropPosition {
                x: position.x,
                y: position.y,
            },
            error,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|name| std::env::temp_dir().join(name))
            .collect()
    }

    #[test]
    fn native_batches_keep_unicode_order_and_independent_discard() {
        let mut drops = AttachmentDrops::default();
        let now = Instant::now();
        let selected = paths(&["합성 문서.pdf", "画像.png"]);
        let first = drops.capture("main", &selected, now).unwrap();
        let second = drops.capture("main", &paths(&["other.txt"]), now).unwrap();
        let claim = drops.claim("main", &first, now).unwrap();
        assert_eq!(claim.path(), selected[0]);
        assert!(
            drops.claim("main", &first, now).is_err(),
            "one in-flight claim per batch"
        );
        drops.complete("main", &claim, now).unwrap();
        assert!(
            drops.complete("main", &claim, now).is_err(),
            "ticket cannot be replayed"
        );
        drops.discard("main", &second, now).unwrap();
        let claim = drops.claim("main", &first, now).unwrap();
        assert_eq!(claim.path(), selected[1]);
        drops.complete("main", &claim, now).unwrap();
        assert!(
            drops.claim("main", &first, now).is_err(),
            "no replay after exhaustion"
        );
        assert!(drops.claim("main", &second, now).is_err());
        drops.discard("main", &first, now).unwrap();
    }

    #[test]
    fn forged_expired_and_wrong_window_tokens_cannot_consume_a_selection() {
        let mut drops = AttachmentDrops::default();
        let now = Instant::now();
        let selected = paths(&["retained.txt"]);
        let id = drops.capture("main", &selected, now).unwrap();
        assert!(drops
            .claim("main", &Uuid::new_v4().to_string(), now)
            .is_err());
        assert!(drops
            .claim("main", "forged path is not a token", now)
            .is_err());
        assert!(drops.claim("other", &id, now).is_err());
        assert!(drops.discard("other", &id, now).is_err());
        assert!(ensure_main_webview("other", "main").is_err());
        assert!(ensure_main_webview("main", "other").is_err());
        let claim = drops.claim("main", &id, now).unwrap();
        assert_eq!(claim.path(), selected[0]);
        assert!(drops.complete("other", &claim, now).is_err());
        drops.complete("main", &claim, now).unwrap();
        let expired = drops.capture("main", &selected, now).unwrap();
        assert!(drops.claim("main", &expired, now + BATCH_LIFETIME).is_err());
    }

    #[test]
    fn pending_and_path_limits_reject_overflow_without_evicting_active_batches() {
        let mut drops = AttachmentDrops::default();
        let now = Instant::now();
        let selected = paths(&["retained.txt"]);
        assert!(drops.capture("main", &[], now).is_err());
        assert!(drops
            .capture(
                "main",
                &vec![selected[0].clone(); MAX_PATHS_PER_BATCH + 1],
                now
            )
            .is_err());
        assert!(drops
            .capture("main", &[PathBuf::from("relative.txt")], now)
            .is_err());
        let long = std::env::temp_dir().join("x".repeat(MAX_PATH_BYTES + 1));
        assert!(drops.capture("main", &[long], now).is_err());
        let aggregate = vec![std::env::temp_dir().join("x".repeat(60 * 1024)); 5];
        assert!(drops.capture("main", &aggregate, now).is_err());
        let maximum = vec![selected[0].clone(); MAX_PATHS_PER_BATCH];
        let maximum_id = drops.capture("main", &maximum, now).unwrap();
        drops.discard("main", &maximum_id, now).unwrap();
        let ids: Vec<_> = (0..MAX_PENDING_BATCHES)
            .map(|_| drops.capture("main", &selected, now).unwrap())
            .collect();
        assert!(drops
            .capture("main", &selected, now)
            .unwrap_err()
            .contains("too many pending"));
        for id in ids {
            let claim = drops.claim("main", &id, now).unwrap();
            assert_eq!(claim.path(), selected[0]);
            drops.complete("main", &claim, now).unwrap();
        }
        for _ in 0..MAX_PENDING_BATCHES {
            drops.capture("main", &selected, now).unwrap();
        }
        assert!(drops
            .capture("main", &selected, now + BATCH_LIFETIME)
            .is_ok());
    }
}
