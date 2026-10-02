//! Windows tool approval prompt owned by the call that asked for it.
//!
//! rfd runs its async message box on a detached thread with no way to close
//! it, so a stopped or expired call left the prompt and its thread open. This
//! prompt runs on a thread of its own, learns its dialog's HWND from a CBT hook
//! installed for that thread only, and answers No when its future is dropped or
//! the application shuts down. Other windows, including other dialogs of this
//! process, are never looked up or touched.
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetClassNameW, GetWindowThreadProcessId, MessageBoxW, PostMessageW,
    SetWindowsHookExW, UnhookWindowsHookEx, CBT_CREATEWNDW, HCBT_CREATEWND, IDNO, IDYES,
    MB_ICONINFORMATION, MB_YESNO, WH_CBT, WM_COMMAND, WS_CHILD,
};

#[derive(Default)]
struct DialogState {
    /// The prompt thread; only windows it created are ever answered.
    thread_id: u32,
    /// The prompt's own dialog while it exists (stored as an integer so the
    /// state can cross threads).
    hwnd: Option<isize>,
    dismissed: bool,
}

#[cfg(test)]
pub(super) struct Gate {
    pub reached: std::sync::mpsc::Sender<isize>,
    pub release: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct TestGates {
    /// Hold the prompt thread after its dismissal check, before the dialog exists.
    pub before_show: Option<Gate>,
    /// Hold the prompt thread when its dialog has been created but not shown.
    pub created: Option<Gate>,
}

struct Shared {
    state: Mutex<DialogState>,
    #[cfg(test)]
    gates: Mutex<TestGates>,
    /// No answers actually posted to the dialog, so tests can verify the
    /// withdrawal while the dialog is still held hidden at creation.
    #[cfg(test)]
    answered_no: std::sync::atomic::AtomicUsize,
}

impl Shared {
    fn state(&self) -> std::sync::MutexGuard<'_, DialogState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Answer No now, or as soon as the dialog exists. Both sides decide under
    /// the same lock, so a dismissal racing the dialog's creation is not lost.
    fn dismiss(&self) {
        let mut state = self.state();
        state.dismissed = true;
        if let Some(hwnd) = state.hwnd {
            self.answer_no(hwnd, state.thread_id);
        }
    }

    fn created(&self, hwnd: isize) {
        {
            let mut state = self.state();
            if state.hwnd.is_some() {
                return;
            }
            state.hwnd = Some(hwnd);
            if state.dismissed {
                self.answer_no(hwnd, state.thread_id);
            }
        }
        #[cfg(test)]
        self.wait_at(|gates| gates.created.take(), hwnd);
    }

    /// Post the No button to the prompt's dialog. A destroyed HWND can be
    /// reused, so the handle is only used while it belongs to the prompt thread.
    fn answer_no(&self, hwnd: isize, thread_id: u32) {
        let hwnd = hwnd as HWND;
        if unsafe { GetWindowThreadProcessId(hwnd, std::ptr::null_mut()) } == thread_id
            && unsafe { PostMessageW(hwnd, WM_COMMAND, IDNO as WPARAM, 0) } != 0
        {
            #[cfg(test)]
            self.answered_no
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        }
    }

    #[cfg(test)]
    fn wait_at(&self, gate: impl FnOnce(&mut TestGates) -> Option<Gate>, value: isize) {
        let gate = gate(&mut self.gates.lock().unwrap());
        if let Some(gate) = gate {
            let _ = gate.reached.send(value);
            let _ = gate
                .release
                .recv_timeout(std::time::Duration::from_secs(10));
        }
    }
}

thread_local! {
    static PROMPT: RefCell<Option<Arc<Shared>>> = const { RefCell::new(None) };
}

/// Dialog class name documented for dialog boxes, which MessageBoxW uses.
const DIALOG_CLASS: &str = "#32770";

fn is_dialog(hwnd: HWND) -> bool {
    let mut class = [0_u16; 16];
    let length = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    length > 0 && String::from_utf16_lossy(&class[..length as usize]) == DIALOG_CLASS
}

unsafe extern "system" fn creation_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HCBT_CREATEWND as i32 {
        let hwnd = wparam as HWND;
        let create = &*(lparam as *const CBT_CREATEWNDW);
        let top_level = (*create.lpcs).style as u32 & WS_CHILD == 0;
        if top_level && is_dialog(hwnd) {
            PROMPT.with(|prompt| {
                if let Some(shared) = prompt.borrow().as_ref() {
                    shared.created(hwnd as isize);
                }
            });
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16()
        .map(|unit| if unit == 0 { u16::from(b' ') } else { unit })
        .chain(std::iter::once(0))
        .collect()
}

fn show(shared: &Arc<Shared>, title: &[u16], text: &[u16]) -> Result<bool, String> {
    let thread_id = unsafe { GetCurrentThreadId() };
    {
        let mut state = shared.state();
        state.thread_id = thread_id;
        if state.dismissed {
            return Ok(false);
        }
    }
    #[cfg(test)]
    shared.wait_at(|gates| gates.before_show.take(), 0);
    let hook =
        unsafe { SetWindowsHookExW(WH_CBT, Some(creation_hook), std::ptr::null_mut(), thread_id) };
    if hook.is_null() {
        // Without the hook the prompt could not be withdrawn; refuse instead.
        return Err(format!(
            "cannot prepare the MCP approval prompt: {}",
            std::io::Error::last_os_error()
        ));
    }
    PROMPT.with(|prompt| *prompt.borrow_mut() = Some(shared.clone()));
    let answer = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONINFORMATION,
        )
    };
    PROMPT.with(|prompt| *prompt.borrow_mut() = None);
    unsafe { UnhookWindowsHookEx(hook) };
    let mut state = shared.state();
    state.hwnd = None;
    Ok(answer == IDYES && !state.dismissed)
}

/// Prompts that are still open, so shutdown can withdraw them synchronously.
fn open_prompts() -> &'static Mutex<HashMap<u64, Weak<Shared>>> {
    static OPEN: OnceLock<Mutex<HashMap<u64, Weak<Shared>>>> = OnceLock::new();
    OPEN.get_or_init(Default::default)
}

/// Answer No to every open prompt. Each one's call then sees a rejection, and
/// a cancelled call never sends `tools/call` either way.
pub(super) fn dismiss_all() {
    let prompts = open_prompts()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .values()
        .filter_map(Weak::upgrade)
        .collect::<Vec<_>>();
    for prompt in prompts {
        prompt.dismiss();
    }
}

pub(super) struct Prompt {
    key: u64,
    shared: Arc<Shared>,
    answer: Option<tokio::sync::oneshot::Receiver<Result<bool, String>>>,
    pub(super) thread: Option<std::thread::JoinHandle<()>>,
}

impl Prompt {
    pub(super) fn open(title: &str, text: &str) -> Result<Self, String> {
        Self::open_with(
            title,
            text,
            #[cfg(test)]
            TestGates::default(),
        )
    }

    pub(super) fn open_with(
        title: &str,
        text: &str,
        #[cfg(test)] gates: TestGates,
    ) -> Result<Self, String> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let shared = Arc::new(Shared {
            state: Mutex::new(DialogState::default()),
            #[cfg(test)]
            gates: Mutex::new(gates),
            #[cfg(test)]
            answered_no: Default::default(),
        });
        let key = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        open_prompts()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key, Arc::downgrade(&shared));
        let (sender, answer) = tokio::sync::oneshot::channel();
        let (title, text) = (wide(title), wide(text));
        let owner = shared.clone();
        let thread = std::thread::Builder::new()
            .name("mcp-approval".into())
            .spawn(move || {
                let _ = sender.send(show(&owner, &title, &text));
            });
        match thread {
            Ok(thread) => Ok(Self {
                key,
                shared,
                answer: Some(answer),
                thread: Some(thread),
            }),
            Err(error) => {
                open_prompts()
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&key);
                Err(format!("cannot open the MCP approval prompt: {error}"))
            }
        }
    }

    #[cfg(test)]
    pub(super) fn dismiss(&self) {
        self.shared.dismiss();
    }

    /// The user's answer. Dropping this future withdraws the prompt.
    pub(super) async fn answer(mut self) -> Result<bool, String> {
        match self.answer.take() {
            Some(answer) => answer
                .await
                .unwrap_or_else(|_| Err("the MCP approval prompt ended unexpectedly".into())),
            None => Ok(false),
        }
    }
}

impl Drop for Prompt {
    fn drop(&mut self) {
        // Harmless once answered: the dialog handle is already cleared.
        self.shared.dismiss();
        // The No message ends the thread's modal loop. Close our thread
        // handle without blocking cancellation on the window message pump.
        self.thread.take();
        open_prompts()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.key);
    }
}

#[cfg(test)]
impl Prompt {
    /// Hand the prompt's thread and dialog to a test that holds the dialog
    /// hidden at creation (see [`tests::HeldDialog`]).
    pub(super) fn hold(
        &mut self,
        reached: std::sync::mpsc::Receiver<isize>,
        release: std::sync::mpsc::Sender<()>,
    ) -> tests::HeldDialog {
        tests::HeldDialog {
            shared: self.shared.clone(),
            thread: self.thread.take(),
            reached,
            release: Some(release),
            hwnd: None,
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, IsWindowVisible};

    const WAIT: Duration = Duration::from_secs(10);

    /// Prompt tests run one at a time: shutdown answers every open prompt.
    pub(in crate::mcp) async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
        static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        SERIAL.lock().await
    }

    pub(in crate::mcp) fn gate() -> (Gate, mpsc::Receiver<isize>, mpsc::Sender<()>) {
        let (reached, reached_rx) = mpsc::channel();
        let (release_tx, release) = mpsc::channel();
        (Gate { reached, release }, reached_rx, release_tx)
    }

    /// A prompt dialog held at creation, before its modal loop can show it.
    /// A test releases it only after a No has been posted, which the dialog
    /// handles before it would first be shown. If the test fails first, the
    /// drop answers No itself, so even a failing test never leaves a visible
    /// dialog behind.
    pub(in crate::mcp) struct HeldDialog {
        pub(super) shared: Arc<Shared>,
        pub(super) thread: Option<std::thread::JoinHandle<()>>,
        pub(super) reached: mpsc::Receiver<isize>,
        pub(super) release: Option<mpsc::Sender<()>>,
        pub(super) hwnd: Option<isize>,
    }

    impl HeldDialog {
        /// Wait for the dialog and check it is this prompt's own hidden window.
        pub(in crate::mcp) fn created(&mut self) -> isize {
            let hwnd = self
                .reached
                .recv_timeout(WAIT)
                .expect("dialog must be created");
            self.hwnd = Some(hwnd);
            let thread_id = self.shared.state().thread_id;
            unsafe {
                assert_ne!(IsWindow(hwnd as HWND), 0);
                assert_eq!(
                    GetWindowThreadProcessId(hwnd as HWND, std::ptr::null_mut()),
                    thread_id
                );
                assert_ne!(thread_id, GetCurrentThreadId());
                assert_eq!(IsWindowVisible(hwnd as HWND), 0, "fixture must stay hidden");
            }
            hwnd
        }

        pub(in crate::mcp) fn withdrawn(&self) -> bool {
            self.shared
                .answered_no
                .load(std::sync::atomic::Ordering::Acquire)
                > 0
        }

        /// Release a dialog whose withdrawal was already posted, then require
        /// that the dialog and its thread are gone.
        pub(in crate::mcp) fn release_withdrawn(mut self) {
            assert!(
                self.withdrawn(),
                "No must be posted while the dialog is hidden"
            );
            self.finish();
        }

        /// Release the dialog and wait until it and its thread are gone.
        pub(in crate::mcp) fn finish(&mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
            if let Some(thread) = self.thread.take() {
                let deadline = std::time::Instant::now() + WAIT;
                while !thread.is_finished() {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "prompt thread must end"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                thread.join().unwrap();
            }
            if let Some(hwnd) = self.hwnd {
                assert_eq!(
                    unsafe { IsWindow(hwnd as HWND) },
                    0,
                    "dialog must be destroyed"
                );
            }
        }
    }

    impl Drop for HeldDialog {
        fn drop(&mut self) {
            if let (Some(release), Some(hwnd)) = (self.release.take(), self.hwnd) {
                unsafe { PostMessageW(hwnd as HWND, WM_COMMAND, IDNO as WPARAM, 0) };
                let _ = release.send(());
            }
        }
    }

    pub(in crate::mcp) fn created_gates() -> (TestGates, mpsc::Receiver<isize>, mpsc::Sender<()>) {
        let (created, reached, release) = gate();
        (
            TestGates {
                created: Some(created),
                ..TestGates::default()
            },
            reached,
            release,
        )
    }

    fn open_held() -> (Prompt, HeldDialog) {
        let (gates, reached, release) = created_gates();
        let mut prompt = Prompt::open_with("AioLM test prompt", "synthetic", gates).unwrap();
        let mut held = prompt.hold(reached, release);
        held.created();
        (prompt, held)
    }

    #[tokio::test]
    async fn dropping_an_open_prompt_closes_its_own_dialog_and_ends_its_thread() {
        let _serial = serial().await;
        let (prompt, held) = open_held();
        let key = prompt.key;
        drop(prompt);
        held.release_withdrawn();
        assert!(!open_prompts().lock().unwrap().contains_key(&key));
    }

    #[tokio::test]
    async fn an_expired_prompt_closes_its_dialog_and_ends_its_thread() {
        let _serial = serial().await;
        let (prompt, held) = open_held();
        let expired = tokio::time::timeout(Duration::from_millis(20), prompt.answer()).await;
        assert!(expired.is_err());
        tokio::task::spawn_blocking(move || held.release_withdrawn())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_dismissal_that_races_dialog_creation_is_applied_by_the_hook() {
        let _serial = serial().await;
        let (before_show, before_reached, before_release) = gate();
        let (mut gates, reached, release) = created_gates();
        gates.before_show = Some(before_show);
        let mut prompt = Prompt::open_with("AioLM test prompt", "synthetic", gates).unwrap();
        let mut held = prompt.hold(reached, release);
        before_reached.recv_timeout(WAIT).unwrap();
        // The thread has passed its own dismissal check and the dialog does
        // not exist yet, so only the creation hook can withdraw it.
        prompt.dismiss();
        assert!(!held.withdrawn());
        before_release.send(()).unwrap();
        held.created();
        assert!(held.withdrawn(), "the hook must answer No on creation");
        let held = tokio::task::spawn_blocking(move || held.release_withdrawn());
        assert_eq!(
            tokio::time::timeout(WAIT, prompt.answer()).await.unwrap(),
            Ok(false)
        );
        held.await.unwrap();
    }

    #[tokio::test]
    async fn the_yes_button_is_reported_as_approval() {
        let _serial = serial().await;
        let (prompt, mut held) = open_held();
        let hwnd = held.hwnd.unwrap();
        unsafe { PostMessageW(hwnd as HWND, WM_COMMAND, IDYES as WPARAM, 0) };
        let held = tokio::task::spawn_blocking(move || held.finish());
        assert_eq!(
            tokio::time::timeout(WAIT, prompt.answer()).await.unwrap(),
            Ok(true)
        );
        held.await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_withdraws_every_open_prompt() {
        let _serial = serial().await;
        let (prompt, held) = open_held();
        dismiss_all();
        assert!(held.withdrawn());
        let held = tokio::task::spawn_blocking(move || held.release_withdrawn());
        assert_eq!(
            tokio::time::timeout(WAIT, prompt.answer()).await.unwrap(),
            Ok(false)
        );
        held.await.unwrap();
    }
}
