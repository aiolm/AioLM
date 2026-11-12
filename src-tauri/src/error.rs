//! Typed command errors shared by the Tauri IPC boundary.
//!
//! Commands return `Result<T, AppError>`. The WebView receives
//! `{ "kind": "<kind>", "message": "<text>" }`, so callers branch on `kind`
//! instead of matching English text, while `message` stays the readable,
//! already-sanitized description shown to users.

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The user or a superseding operation stopped the work.
    Cancelled,
    /// A referenced file, session, model, runtime or record does not exist.
    NotFound,
    /// Another operation holds the resource; retrying later can succeed.
    Busy,
    /// The request or saved configuration is invalid.
    Validation,
    /// A deadline elapsed before the work finished.
    Timeout,
    /// The user declined a native confirmation or picker grant.
    Denied,
    /// The platform, network or a dependency is not available right now.
    Unavailable,
    /// Anything not classified above.
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Cancelled, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }

    pub fn busy(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Busy, message)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Validation, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Timeout, message)
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Denied, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unavailable, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }

    /// Classify an I/O failure by its kind; `context` prefixes the message.
    pub fn io(context: &str, error: &std::io::Error) -> Self {
        Self::new(Self::io_kind(error), format!("{context}: {error}"))
    }

    /// Classify an I/O failure while keeping exactly `error.to_string()`.
    pub fn from_io(error: &std::io::Error) -> Self {
        Self::new(Self::io_kind(error), error.to_string())
    }

    /// The kind an I/O failure maps to, for callers composing their own text.
    /// OS permission failures stay `Internal`: `Denied` is reserved for a user
    /// declining a native confirmation or picker grant.
    pub fn io_kind(error: &std::io::Error) -> ErrorKind {
        match error.kind() {
            std::io::ErrorKind::NotFound => ErrorKind::NotFound,
            std::io::ErrorKind::TimedOut => ErrorKind::Timeout,
            std::io::ErrorKind::ResourceBusy => ErrorKind::Busy,
            _ => ErrorKind::Internal,
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

/// Unclassified string errors from lower layers stay readable as `internal`.
impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::internal(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::internal(message)
    }
}

/// A panicked or cancelled blocking task.
impl From<tokio::task::JoinError> for AppError {
    fn from(error: tokio::task::JoinError) -> Self {
        if error.is_cancelled() {
            Self::cancelled(error.to_string())
        } else {
            Self::internal(error.to_string())
        }
    }
}

/// Callers that still return `String` (CLI, internal helpers) keep the text.
impl From<AppError> for String {
    fn from(error: AppError) -> Self {
        error.message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_ipc_shape() {
        let value = serde_json::to_value(AppError::not_found("model file is missing")).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "kind": "not_found", "message": "model file is missing" })
        );
    }

    #[test]
    fn io_errors_keep_their_kind_and_context() {
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        let error = AppError::io("cannot read config", &missing);
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(error.message.starts_with("cannot read config: "));
        let other = std::io::Error::other("disk failure");
        assert_eq!(AppError::io("write", &other).kind, ErrorKind::Internal);
        let permission = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            AppError::from_io(&permission).kind,
            ErrorKind::Internal,
            "Denied means a declined confirmation"
        );
        assert_eq!(AppError::from_io(&other).message, other.to_string());
    }

    #[test]
    fn unclassified_strings_become_internal_without_losing_text() {
        let error: AppError = String::from("probe failed").into();
        assert_eq!(error.kind, ErrorKind::Internal);
        assert_eq!(String::from(error), "probe failed");
    }
}
