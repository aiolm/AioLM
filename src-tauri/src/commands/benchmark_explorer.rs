//! Reuse the public website in an unprivileged app window. Import navigations
//! carry only a public record id; the local frontend fetches and validates it.

use futures_util::StreamExt;
use reqwest::Url;
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const WEBSITE: &str = "https://aiolm.vercel.app";
const WINDOW: &str = "benchmark-explorer";
const IMPORT_PATH: &str = "/__aiolm_profile_import/";
const MAX_DETAIL_BYTES: usize = 256 * 1024;

fn language(locale: &str) -> &str {
    match locale {
        "ko" | "ja" | "zh" => locale,
        _ => "en",
    }
}

fn public_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 110
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn website_url(url: &Url) -> bool {
    url.origin().ascii_serialization() == WEBSITE
        && url.username().is_empty()
        && url.password().is_none()
}

fn import_id(url: &Url) -> Option<&str> {
    if !website_url(url) || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    url.path()
        .strip_prefix(IMPORT_PATH)
        .filter(|id| public_id(id))
}

#[tauri::command]
pub(crate) async fn open_aiolm_website(locale: String) -> Result<(), String> {
    let url = format!("{WEBSITE}/{}", language(&locale));
    tauri::async_runtime::spawn_blocking(move || open::that(url))
        .await
        .map_err(|_| "Could not open the website.".to_string())?
        .map_err(|_| "Could not open the website.".to_string())
}

#[tauri::command]
pub(crate) async fn open_benchmark_explorer(
    app: tauri::AppHandle,
    locale: String,
    import_label: String,
    import_hint: String,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    if import_label.len() > 256 || import_hint.len() > 2048 {
        return Err("Invalid explorer labels.".into());
    }
    let script = format!(
        "window.__AIOLM_EXPLORER_COPY__ = {};\n{}",
        serde_json::json!({ "label": import_label, "hint": import_hint }),
        include_str!("benchmark_explorer_toolbar.js")
    );
    let handle = app.clone();
    let url = Url::parse(&format!("{WEBSITE}/{}/benchmarks", language(&locale)))
        .map_err(|_| "Invalid website URL.".to_string())?;
    WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::External(url))
        .title("AioLM — Benchmarks")
        .inner_size(1200.0, 820.0)
        .min_inner_size(400.0, 520.0)
        // No capabilities match this window; public pages have no native IPC.
        .incognito(true)
        .initialization_script(&script)
        .on_navigation(move |url| {
            if let Some(id) = import_id(url) {
                if let Some(main) = handle.get_webview_window("main") {
                    let _ = main.emit("benchmark-profile-import", id);
                    let _ = main.show();
                    let _ = main.set_focus();
                }
                return false;
            }
            if url.path().starts_with(IMPORT_PATH) {
                return false;
            }
            if website_url(url) {
                return true;
            }
            if url.scheme() == "https" && url.username().is_empty() && url.password().is_none() {
                let external = url.to_string();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = open::that(external);
                });
            }
            false
        })
        .on_new_window(|url, _| {
            if url.scheme() == "https" && url.username().is_empty() && url.password().is_none() {
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = open::that(url.as_str());
                });
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn read_public_benchmark(id: String) -> Result<serde_json::Value, String> {
    if !public_id(&id) {
        return Err("Invalid public benchmark id.".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Could not read the public benchmark.".to_string())?;
    let response = client
        .get(format!("{WEBSITE}/v1/benchmark-runs/{id}"))
        .send()
        .await
        .map_err(|_| "Could not read the public benchmark.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Public benchmark request failed ({}).",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_DETAIL_BYTES as u64)
    {
        return Err("Public benchmark exceeds the size limit.".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Could not read the public benchmark.".to_string())?;
        if bytes.len() + chunk.len() > MAX_DETAIL_BYTES {
            return Err("Public benchmark exceeds the size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid public benchmark response.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_navigations_cannot_escape_the_public_website() {
        for raw in [
            "https://aiolm.vercel.app/__aiolm_profile_import/public-1",
            "https://aiolm.vercel.app:443/__aiolm_profile_import/public-1",
        ] {
            assert_eq!(import_id(&Url::parse(raw).unwrap()), Some("public-1"));
        }
        for raw in [
            "https://example.test/__aiolm_profile_import/public-1",
            "https://user@aiolm.vercel.app/__aiolm_profile_import/public-1",
            "http://aiolm.vercel.app/__aiolm_profile_import/public-1",
            "https://aiolm.vercel.app/__aiolm_profile_import/../manage",
            "https://aiolm.vercel.app/__aiolm_profile_import/a/b",
            "https://aiolm.vercel.app/__aiolm_profile_import/a?secret=1",
            "https://aiolm.vercel.app/__aiolm_profile_import/a#fragment",
        ] {
            assert_eq!(import_id(&Url::parse(raw).unwrap()), None, "{raw}");
        }
        assert!(public_id(&"x".repeat(110)));
        assert!(!public_id(&"x".repeat(111)));
        assert_eq!(language("invalid"), "en");
    }
}
