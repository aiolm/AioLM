//! Structured native failures for anonymous benchmark publishing.
//!
//! Every sharing command rejects with a serialized object
//! `{code,message,status?,retry_after?,service_code?}` using only the codes
//! from the shared spec. Messages are bounded static product strings, never
//! raw server bodies or token dumps. Server handshake failures preserve the
//! HTTP status, the allowlisted server error code and Retry-After.

use serde::Serialize;

/// Codes from the shared spec; the frontend normalizes these first.
pub(crate) mod code {
    pub(crate) const CONFIGURATION_MISSING: &str = "configuration_missing";
    pub(crate) const VAULT_LOCKED: &str = "vault_locked";
    pub(crate) const OWNERSHIP_MISSING: &str = "ownership_missing";
    pub(crate) const VAULT_UNAVAILABLE: &str = "vault_unavailable";
    pub(crate) const VERIFICATION_REQUIRED: &str = "verification_required";
    pub(crate) const MEASUREMENT_ACTIVE: &str = "measurement_active";
    pub(crate) const CANCELLED: &str = "cancelled";
    pub(crate) const NETWORK_ERROR: &str = "network_error";
    pub(crate) const INVALID_RESPONSE: &str = "invalid_response";
    pub(crate) const BINDING_CONFLICT: &str = "binding_conflict";
}

/// Allowlisted service handshake codes permitted into WebView error
/// metadata. Arbitrary server strings may contain token material, so only
/// these exact values are preserved; everything else is dropped (never
/// truncated into an accepted code).
const KNOWN_SERVICE_CODES: [&str; 11] = [
    "verification_required",
    "ownership_missing",
    "submission_deleted",
    "rate_limited",
    "service_unavailable",
    "not_found",
    "invalid_request",
    "body_mismatch",
    "payload_too_large",
    "revision_conflict",
    "invalid_csrf",
];

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SharingError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) retry_after: Option<String>,
    /// Allowlisted server handshake code for diagnostics; unknown values are
    /// dropped so token material never enters WebView error metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) service_code: Option<String>,
}

impl SharingError {
    fn bare(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            status: None,
            retry_after: None,
            service_code: None,
        }
    }

    pub(crate) fn configuration_missing() -> Self {
        Self::bare(
            code::CONFIGURATION_MISSING,
            "Benchmark publishing is not configured.",
        )
    }

    pub(crate) fn vault_locked() -> Self {
        Self::bare(code::VAULT_LOCKED, "The system vault is locked.")
    }

    pub(crate) fn ownership_missing() -> Self {
        Self::bare(
            code::OWNERSHIP_MISSING,
            "No owner key is stored for this submission; import its recovery file to continue.",
        )
    }

    pub(crate) fn vault_unavailable_msg(message: &'static str) -> Self {
        Self::bare(code::VAULT_UNAVAILABLE, message)
    }

    pub(crate) fn vault_unavailable() -> Self {
        Self::vault_unavailable_msg("The system vault is unavailable.")
    }

    pub(crate) fn verification_required() -> Self {
        Self::bare(
            code::VERIFICATION_REQUIRED,
            "Browser verification is required.",
        )
    }

    pub(crate) fn measurement_active() -> Self {
        Self::bare(
            code::MEASUREMENT_ACTIVE,
            "Pause sharing while a measurement is active.",
        )
    }

    pub(crate) fn cancelled() -> Self {
        Self::bare(code::CANCELLED, "The sharing request was cancelled.")
    }

    pub(crate) fn network_error() -> Self {
        Self::bare(
            code::NETWORK_ERROR,
            "The sharing service could not be reached.",
        )
    }

    pub(crate) fn invalid_response() -> Self {
        Self::bare(
            code::INVALID_RESPONSE,
            "The sharing service returned an invalid response.",
        )
    }

    pub(crate) fn binding_conflict_msg(message: &'static str) -> Self {
        Self::bare(code::BINDING_CONFLICT, message)
    }

    pub(crate) fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub(crate) fn with_retry_after(mut self, retry_after: &str) -> Self {
        if !retry_after.is_empty() && retry_after.len() <= 128 {
            self.retry_after = Some(retry_after.into());
        }
        self
    }

    pub(crate) fn with_service_code(mut self, service_code: &str) -> Self {
        if KNOWN_SERVICE_CODES.contains(&service_code) {
            self.service_code = Some(service_code.into());
        }
        self
    }
}

impl std::fmt::Display for SharingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Map a typed vault failure to its structured code. Missing keys are an
/// ownership problem; locked stores stay retryable; everything else is an
/// environment failure. No variant carries secret material.
pub(crate) fn from_vault(error: &super::vault::VaultError) -> SharingError {
    match error {
        super::vault::VaultError::Locked(_) => SharingError::vault_locked(),
        super::vault::VaultError::Missing => SharingError::ownership_missing(),
        super::vault::VaultError::Invalid(_) | super::vault::VaultError::Platform(_) => {
            SharingError::vault_unavailable()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_serialize_to_the_agreed_shape() {
        let error = SharingError::verification_required()
            .with_status(401)
            .with_retry_after("7")
            .with_service_code("verification_required");
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "verification_required");
        assert_eq!(value["status"], 401);
        assert_eq!(value["retry_after"], "7");
        assert_eq!(value["service_code"], "verification_required");
        // Absent optionals are omitted, matching the TS validator.
        let bare = serde_json::to_value(SharingError::cancelled()).unwrap();
        assert!(bare.get("status").is_none());
        assert!(bare.get("retry_after").is_none());
        assert!(bare.get("service_code").is_none());
        // Arbitrary strings are dropped, never truncated into accepted codes.
        let dirty = SharingError::network_error().with_service_code("has spaces!");
        assert!(serde_json::to_value(&dirty)
            .unwrap()
            .get("service_code")
            .is_none());
    }

    #[test]
    fn service_code_accepts_only_exact_known_codes() {
        for known in KNOWN_SERVICE_CODES {
            let error = SharingError::network_error().with_service_code(known);
            assert_eq!(
                error.service_code.as_deref(),
                Some(known),
                "known code must be preserved: {known}"
            );
        }
    }

    #[test]
    fn service_code_rejects_unknown_and_token_material() {
        // Token-looking 43-character base64url strings must never enter
        // WebView error metadata.
        let token_like = "a".repeat(43);
        assert_eq!(token_like.len(), 43);
        for rejected in [
            token_like.as_str(),
            "some_arbitrary_server_code",
            "TOKEN123",
            "",
            "has spaces!",
            "verification_required ",
            " verification_required",
            "VERIFICATION_REQUIRED",
        ] {
            let error = SharingError::network_error().with_service_code(rejected);
            assert!(
                error.service_code.is_none(),
                "unknown value must be dropped: {rejected:?}"
            );
        }
    }

    #[test]
    fn service_code_rejects_overlong_and_prefixed_codes() {
        // Overlong input that merely starts with a known code is dropped,
        // never truncated into the accepted prefix.
        let overlong = format!("{}{}", "verification_required", "x".repeat(64));
        assert!(overlong.len() > 64);
        let error = SharingError::network_error().with_service_code(&overlong);
        assert!(error.service_code.is_none());
        // Valid-code prefixes with suffixes are distinct unknown values.
        for rejected in [
            "verification_required_extra",
            "verification_required-2",
            "rate_limited!",
            "not_found\n",
            "invalid_csrf ",
        ] {
            let error = SharingError::network_error().with_service_code(rejected);
            assert!(
                error.service_code.is_none(),
                "prefixed/suffixed code must be dropped: {rejected:?}"
            );
        }
    }
}
