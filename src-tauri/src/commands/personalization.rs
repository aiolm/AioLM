//! Personal instructions and skills for the chat. Validation, missing skills,
//! unavailable roots and save conflicts retain typed errors for the editor.
use crate::error::{AppError, ErrorKind};
use crate::personalization::{
    self, AgentInstructionsFile, ChatPersonalization, Roots, SkillContent, Source,
};

/// Runs file work off the async runtime with the roots resolved now, so a
/// changed `AIOLM_HOME` or home folder is picked up by the next call.
async fn with_roots<T: Send + 'static>(
    task: impl FnOnce(&Roots) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(move || task(&Roots::current()))
        .await
        .map_err(|error| {
            AppError::new(
                if error.is_cancelled() {
                    ErrorKind::Cancelled
                } else {
                    ErrorKind::Internal
                },
                format!("personalization task failed: {error}"),
            )
        })?
}

#[tauri::command]
pub(crate) async fn chat_personalization(
    instruction_sources: Vec<Source>,
) -> Result<ChatPersonalization, AppError> {
    with_roots(move |roots| Ok(personalization::load(roots, &instruction_sources))).await
}

#[tauri::command]
pub(crate) async fn personalization_read_skill(id: String) -> Result<SkillContent, AppError> {
    with_roots(move |roots| personalization::read_skill(roots, &id)).await
}

#[tauri::command]
pub(crate) async fn personalization_read_agents(
    source: Source,
) -> Result<AgentInstructionsFile, AppError> {
    with_roots(move |roots| personalization::read_agents(roots, source)).await
}

#[tauri::command]
pub(crate) async fn personalization_save_agents(
    source: Source,
    content: String,
    expected_revision: Option<String>,
) -> Result<AgentInstructionsFile, AppError> {
    with_roots(move |roots| {
        personalization::save_agents(roots, source, &content, expected_revision.as_deref())
    })
    .await
}
