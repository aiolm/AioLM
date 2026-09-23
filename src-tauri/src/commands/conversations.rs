//! Conversation files in the data folder.
use crate::conversations;
use serde_json::Value;
use std::path::Path;

async fn in_store<T: Send + 'static>(
    task: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let root = conversations::root()?;
    tokio::task::spawn_blocking(move || task(&root))
        .await
        .map_err(|error| format!("conversation task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn conversations_load() -> Result<conversations::Loaded, String> {
    in_store(conversations::load).await
}

#[tauri::command]
pub(crate) async fn conversation_save(thread: Value) -> Result<(), String> {
    in_store(move |root| conversations::save(root, thread)).await
}

#[tauri::command]
pub(crate) async fn conversation_delete(id: String) -> Result<(), String> {
    in_store(move |root| conversations::delete(root, &id)).await
}

#[tauri::command]
pub(crate) async fn conversations_import(threads: Vec<Value>) -> Result<usize, String> {
    in_store(move |root| conversations::import(root, threads)).await
}

#[tauri::command]
pub(crate) async fn conversations_clear() -> Result<(), String> {
    in_store(conversations::clear).await
}
