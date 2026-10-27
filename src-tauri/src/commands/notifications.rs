//! Submit generic desktop alerts without claiming that the OS displayed them.

#[derive(serde::Deserialize)]
pub(crate) struct NotificationOptions {
    title: String,
    body: String,
}

#[tauri::command]
pub(crate) async fn send_desktop_notification(
    app: tauri::AppHandle,
    options: NotificationOptions,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        app.state::<crate::desktop_notifications::NotificationService>()
            .submit(&options.title, &options.body)
            .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(options.title)
            .body(options.body)
            .show()
            .map_err(|error| error.to_string())
    }
}
