//! Personal instructions and skills for the chat.
use crate::personalization::{
    self, AgentInstructionsFile, ChatPersonalization, Roots, SkillContent, Source,
};

/// Runs file work off the async runtime with the roots resolved now, so a
/// changed `AIOLM_HOME` or home folder is picked up by the next call.
async fn with_roots<T: Send + 'static>(
    task: impl FnOnce(&Roots) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || task(&Roots::current()))
        .await
        .map_err(|error| format!("personalization task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn chat_personalization() -> Result<ChatPersonalization, String> {
    with_roots(|roots| Ok(personalization::load(roots))).await
}

#[tauri::command]
pub(crate) async fn personalization_read_skill(id: String) -> Result<SkillContent, String> {
    with_roots(move |roots| personalization::read_skill(roots, &id)).await
}

#[tauri::command]
pub(crate) async fn personalization_read_agents(
    source: Source,
) -> Result<AgentInstructionsFile, String> {
    with_roots(move |roots| personalization::read_agents(roots, source)).await
}

#[tauri::command]
pub(crate) async fn personalization_save_agents(
    source: Source,
    content: String,
    expected_revision: Option<String>,
) -> Result<AgentInstructionsFile, String> {
    with_roots(move |roots| {
        personalization::save_agents(roots, source, &content, expected_revision.as_deref())
    })
    .await
}
