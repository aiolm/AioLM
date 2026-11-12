//! Native approval dialogs owned by the requesting future.

#[cfg(target_os = "linux")]
#[path = "mcp/linux_approval.rs"]
mod linux_approval;
#[cfg(target_os = "macos")]
#[path = "mcp/macos_approval.rs"]
mod macos_approval;
#[cfg(windows)]
#[path = "mcp/native_approval.rs"]
pub(crate) mod native_approval;

// A task-scoped dialog boundary keeps IPC regression tests headless without
// changing process-global behavior or adding an approval bypass to app builds.
#[cfg(test)]
tokio::task_local! {
    pub(crate) static TEST_ANSWERS: std::cell::RefCell<std::collections::VecDeque<TestAnswer>>;
}

#[cfg(test)]
pub(crate) enum TestAnswer {
    Immediate(bool),
    Delayed {
        opened: tokio::sync::oneshot::Sender<()>,
        answer: tokio::sync::oneshot::Receiver<bool>,
    },
}

pub(crate) async fn confirm(title: &str, description: &str) -> Result<bool, String> {
    #[cfg(test)]
    if let Ok(answer) = TEST_ANSWERS.try_with(|answers| {
        answers
            .borrow_mut()
            .pop_front()
            .expect("unexpected native confirmation in the scoped IPC test")
    }) {
        return match answer {
            TestAnswer::Immediate(answer) => Ok(answer),
            TestAnswer::Delayed { opened, answer } => {
                let _ = opened.send(());
                Ok(answer.await.unwrap_or(false))
            }
        };
    }
    // Dropping the future withdraws its dialog rather than leaving a detached
    // prompt open after cancellation or a caller's approval timeout.
    #[cfg(windows)]
    return native_approval::Prompt::open(title, description)?
        .answer()
        .await;
    #[cfg(target_os = "linux")]
    return linux_approval::confirm(title, description).await;
    #[cfg(target_os = "macos")]
    return macos_approval::confirm(title, description).await;
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    Ok(rfd::AsyncMessageDialog::new()
        .set_title(title)
        .set_description(description)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await
        == rfd::MessageDialogResult::Yes)
}

pub(crate) fn dismiss_all() {
    #[cfg(windows)]
    native_approval::dismiss_all();
}
