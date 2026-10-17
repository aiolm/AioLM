//! Keep the initial Windows window usable on a small display.

use tauri::{Runtime, WebviewWindow};

pub(crate) fn fit_initial_window<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => monitor,
        None => match window.primary_monitor()? {
            Some(monitor) => monitor,
            None => return Ok(()),
        },
    };
    let work_area = monitor.work_area();
    let size = window.outer_size()?;
    // The configured initial size can extend below the taskbar on a smaller
    // display. Let Windows account for its taskbar and invisible frame instead
    // of saving different defaults or guessing decoration/DPI offsets.
    if work_area.size.width > 0
        && work_area.size.height > 0
        && (size.width > work_area.size.width || size.height > work_area.size.height)
    {
        window.maximize()?;
    }
    Ok(())
}
