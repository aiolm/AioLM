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

pub(crate) async fn confirm(title: &str, description: &str) -> Result<bool, String> {
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
