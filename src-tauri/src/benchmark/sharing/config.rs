//! Service origin resolution for anonymous benchmark publishing.
//!
//! Ordinary builds use AioLM's official sharing website. The optional
//! `AIOLM_BENCHMARK_API_URL` build variable overrides it; `off` explicitly
//! disables publishing. Resolution stays native, never from WebView input.
//! An invalid nonempty override fails closed instead of changing destinations. Only a
//! root service origin is accepted: any base path, query, fragment or
//! embedded credentials are rejected, matching the shared contracts origin
//! policy. HTTPS is required; plain HTTP is accepted only for loopback hosts
//! in debug builds (local synthetic servers used by tests), never in release
//! builds.

use reqwest::Url;

pub(crate) const MAX_URL_LEN: usize = 2048;
const DEFAULT_SERVICE_ORIGIN: &str = "https://aiolm.vercel.app";

/// Validate a candidate service base URL as a root origin. Returns the parsed
/// URL on success.
pub(crate) fn validate_base_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("benchmark service URL is empty".into());
    }
    if raw.len() > MAX_URL_LEN {
        return Err("benchmark service URL exceeds the size limit".into());
    }
    let url = Url::parse(raw).map_err(|_| "benchmark service URL is not absolute".to_string())?;
    validate_root_origin(&url)?;
    Ok(url)
}

fn validate_root_origin(url: &Url) -> Result<(), String> {
    if url.host_str().is_none_or(str::is_empty) {
        return Err("benchmark service URL has no host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("benchmark service URL must not embed credentials".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("benchmark service URL must not contain a query or fragment".into());
    }
    if url.path() != "/" {
        return Err("benchmark service URL must be a root origin without a base path".into());
    }
    if url.scheme() == "https" {
        return Ok(());
    }
    // Explicit debug loopback only: local synthetic HTTP servers for tests.
    #[cfg(debug_assertions)]
    if url.scheme() == "http" && is_loopback_host(url) {
        return Ok(());
    }
    Err("benchmark service URL requires HTTPS without embedded credentials".into())
}

fn is_loopback_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    )
}

/// Canonical `scheme://host[:port]` origin. The URL parser already lowercases
/// the host and strips scheme-default ports per WHATWG, agreeing with the
/// shared contracts origin normalization.
pub(crate) fn origin_of(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    }
}

/// Resolve the build override without consulting machine-specific settings.
/// Empty Actions variables behave like unset local build variables.
fn resolve_service_base_url(override_url: Option<&str>) -> Option<Url> {
    let raw = override_url
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if raw.is_some_and(|value| value.eq_ignore_ascii_case("off")) {
        return None;
    }
    validate_base_url(raw.unwrap_or(DEFAULT_SERVICE_ORIGIN)).ok()
}

/// Service base URL, or `None` when explicitly disabled or invalid.
/// Never throws: callers fail closed with a structured configuration error.
pub(crate) fn service_base_url() -> Option<Url> {
    resolve_service_base_url(option_env!("AIOLM_BENCHMARK_API_URL"))
}

/// Fixed allowed POST endpoint for new publications: `<origin>/v1/benchmark-runs`.
pub(crate) fn submit_endpoint(base: &Url) -> String {
    format!("{}/v1/benchmark-runs", origin_of(base))
}

/// The exact full destination bound into ownership metadata.
pub(crate) fn validate_destination(origin: &str, destination: &str) -> Result<(), String> {
    if destination.len() > MAX_URL_LEN {
        return Err("benchmark destination exceeds the size limit".into());
    }
    if *destination != submit_endpoint_for_origin(origin) {
        return Err("benchmark destination is not the service publication endpoint".into());
    }
    Ok(())
}

pub(crate) fn submit_endpoint_for_origin(origin: &str) -> String {
    format!("{origin}/v1/benchmark-runs")
}

/// Fixed allowed POST collection for upload sessions.
pub(crate) fn session_collection(base: &Url) -> String {
    format!("{}/v1/upload-sessions", origin_of(base))
}

/// Fixed allowed poll resource for one upload session. The id is restricted
/// to an opaque token alphabet so it cannot escape the fixed path.
pub(crate) fn session_resource(base: &Url, session_id: &str) -> Result<Url, String> {
    validate_session_id(session_id)?;
    Url::parse(&format!(
        "{}/v1/upload-sessions/{session_id}",
        origin_of(base)
    ))
    .map_err(|_| "benchmark session URL could not be built".into())
}

pub(crate) fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("benchmark session id is invalid".into());
    }
    Ok(())
}

/// Validate a server-returned browser URL: it must equal the configured
/// `<origin>/verify/<session_id>` exactly, with no query, fragment,
/// credentials or alternate path. Used before opening the verification URL.
pub(crate) fn validate_verification_url(
    origin: &str,
    session_id: &str,
    value: &str,
) -> Result<String, String> {
    if value.len() > MAX_URL_LEN {
        return Err("benchmark service URL exceeds the size limit".into());
    }
    validate_session_id(session_id)?;
    let expected = format!("{origin}/verify/{session_id}");
    if value != expected {
        return Err("benchmark service returned an unexpected verification URL".into());
    }
    Ok(expected)
}

/// Fixed allowed POST collection for one-time management tickets.
pub(crate) fn management_handoff_endpoint(base: &Url) -> String {
    format!("{}/v1/management-handoffs", origin_of(base))
}

/// Server-issued ticket id: a lowercase canonical hyphenated UUID v4.
pub(crate) fn validate_handoff_id(value: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::try_parse(value).map_err(|_| "handoff id is invalid".to_string())?;
    if parsed.get_version_num() != 4
        || parsed.get_variant() != uuid::Variant::RFC4122
        || parsed.hyphenated().to_string() != value
    {
        return Err("handoff id is invalid".into());
    }
    Ok(())
}

/// Server-issued ticket token: canonical unpadded base64url of exactly 32
/// bytes (43 characters that re-encode identically).
pub(crate) fn validate_handoff_token(value: &str) -> Result<(), String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let bytes = if value.len() == 43 {
        URL_SAFE_NO_PAD.decode(value).ok()
    } else {
        None
    };
    match bytes {
        Some(bytes) if bytes.len() == 32 && URL_SAFE_NO_PAD.encode(&bytes) == value => Ok(()),
        _ => Err("handoff token is invalid".into()),
    }
}

/// Management page on the bound origin carrying a one-time ticket in the
/// fragment, `<origin>/manage#handoff=<id>.<token>`. Fragments are never
/// sent to servers or in `Referer`; the page redeems and strips it. Built
/// only from validated parts, never from a server-returned URL.
pub(crate) fn management_handoff_url(
    origin: &str,
    handoff_id: &str,
    handoff_token: &str,
) -> Result<String, String> {
    validate_handoff_id(handoff_id)?;
    validate_handoff_token(handoff_token)?;
    Ok(format!(
        "{origin}/manage#handoff={handoff_id}.{handoff_token}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_builds_publish_to_the_official_website() {
        for value in [None, Some(""), Some("  \t\n")] {
            let base = resolve_service_base_url(value).unwrap();
            assert_eq!(origin_of(&base), DEFAULT_SERVICE_ORIGIN);
            assert_eq!(
                submit_endpoint(&base),
                "https://aiolm.vercel.app/v1/benchmark-runs"
            );
        }
    }

    #[test]
    fn custom_builds_keep_their_origin_and_can_disable_publishing() {
        let base =
            resolve_service_base_url(Some(" https://benchmarks.example.test:8443/ ")).unwrap();
        assert_eq!(origin_of(&base), "https://benchmarks.example.test:8443");
        for value in ["off", "OFF", " off "] {
            assert!(resolve_service_base_url(Some(value)).is_none());
        }
    }

    #[test]
    fn invalid_overrides_never_fall_back_to_the_official_website() {
        for value in [
            "not a url",
            "http://example.test",
            "https://user:pass@example.test",
            "https://example.test/api",
            "https://example.test?key=value",
            "https://example.test/#fragment",
        ] {
            assert!(resolve_service_base_url(Some(value)).is_none(), "{value}");
        }
    }

    #[test]
    fn base_url_accepts_only_root_origins() {
        assert!(validate_base_url("https://benchmarks.example.test").is_ok());
        assert!(validate_base_url("https://benchmarks.example.test/").is_ok());
        assert!(validate_base_url("https://benchmarks.example.test:8443").is_ok());
        assert!(validate_base_url("").is_err());
        assert!(validate_base_url("not a url").is_err());
        assert!(validate_base_url("https://user@example.test").is_err());
        assert!(validate_base_url("https://user:pass@example.test/").is_err());
        // Non-root paths, queries and fragments are rejected, not stripped.
        assert!(validate_base_url("https://benchmarks.example.test/api/").is_err());
        assert!(validate_base_url("https://benchmarks.example.test/api").is_err());
        assert!(validate_base_url("https://example.test?x=1").is_err());
        assert!(validate_base_url("https://example.test#frag").is_err());
        assert!(validate_base_url("https://example.test/#frag").is_err());
        assert!(validate_base_url("http://192.0.2.1").is_err());
        assert!(validate_base_url("http://example.test").is_err());
        // Debug builds allow explicit loopback HTTP for local synthetic servers.
        assert!(validate_base_url("http://127.0.0.1:4317").is_ok());
        assert!(validate_base_url("http://localhost:4317").is_ok());
        assert!(validate_base_url("http://127.0.0.1:4317/api").is_err());
        assert!(validate_base_url(&format!("https://example.test/{}", "x".repeat(3000))).is_err());
    }

    /// Release configuration guard. `service_base_url` fails closed, so a
    /// misconfigured build environment would otherwise produce installers that
    /// look normal but have publishing silently disabled. An absent or blank
    /// variable uses the official website; `off` is an explicit disabled build.
    /// Any custom URL must be
    /// an origin a release build can actually use, which excludes the loopback
    /// HTTP exception that only debug builds accept.
    #[test]
    fn configured_build_environment_url_is_usable_in_a_release_build() {
        let raw = option_env!("AIOLM_BENCHMARK_API_URL").unwrap_or("").trim();
        if raw.eq_ignore_ascii_case("off") {
            assert!(service_base_url().is_none());
        } else {
            let candidate = if raw.is_empty() {
                DEFAULT_SERVICE_ORIGIN
            } else {
                raw
            };
            let url = validate_base_url(candidate).unwrap_or_else(|error| {
                panic!("AIOLM_BENCHMARK_API_URL is not a usable service origin: {error}")
            });
            assert_eq!(
                    url.scheme(),
                    "https",
                    "AIOLM_BENCHMARK_API_URL must be an HTTPS origin: release builds reject the loopback HTTP exception",
                );
            // The packaged app reports publishing as available through
            // exactly this accessor, so assert the configured build
            // actually enables it rather than only that the value parses.
            assert_eq!(
                service_base_url().map(|configured| origin_of(&configured)),
                Some(origin_of(&url)),
                "a configured build must expose the service origin to the app",
            );
        }
    }

    #[test]
    fn origins_canonicalize_like_the_shared_contracts() {
        let base = validate_base_url("https://benchmarks.example.test/").unwrap();
        assert_eq!(origin_of(&base), "https://benchmarks.example.test");
        let ported = validate_base_url("https://benchmarks.example.test:8443/").unwrap();
        assert_eq!(origin_of(&ported), "https://benchmarks.example.test:8443");
        // Scheme-default ports normalize away, as with WHATWG URL parsers.
        let defaulted = validate_base_url("https://benchmarks.example.test:443/").unwrap();
        assert_eq!(origin_of(&defaulted), "https://benchmarks.example.test");
        assert_eq!(
            submit_endpoint(&base),
            "https://benchmarks.example.test/v1/benchmark-runs"
        );
        assert!(validate_destination(
            "https://benchmarks.example.test",
            "https://benchmarks.example.test/v1/benchmark-runs"
        )
        .is_ok());
        assert!(validate_destination(
            "https://benchmarks.example.test",
            "https://benchmarks.example.test/v1/other"
        )
        .is_err());
        assert!(validate_destination(
            "https://benchmarks.example.test",
            "https://other.example.test/v1/benchmark-runs"
        )
        .is_err());
    }

    #[test]
    fn endpoints_stay_under_the_configured_origin() {
        let base = validate_base_url("https://benchmarks.example.test/").unwrap();
        assert_eq!(
            session_collection(&base),
            "https://benchmarks.example.test/v1/upload-sessions"
        );
        assert_eq!(
            session_resource(&base, "sess_1").unwrap().as_str(),
            "https://benchmarks.example.test/v1/upload-sessions/sess_1"
        );
        assert!(session_resource(&base, "../escape").is_err());
        assert!(session_resource(&base, "").is_err());
    }

    #[test]
    fn verification_url_must_match_exactly() {
        let origin = "https://benchmarks.example.test";
        assert_eq!(
            validate_verification_url(
                origin,
                "sess-1",
                "https://benchmarks.example.test/verify/sess-1"
            )
            .unwrap(),
            "https://benchmarks.example.test/verify/sess-1"
        );
        // Same-origin but wrong shape is rejected.
        assert!(validate_verification_url(
            origin,
            "sess-1",
            "https://benchmarks.example.test/verify/other"
        )
        .is_err());
        assert!(validate_verification_url(
            origin,
            "sess-1",
            "https://benchmarks.example.test/verify/sess-1?x=1"
        )
        .is_err());
        assert!(validate_verification_url(
            origin,
            "sess-1",
            "https://benchmarks.example.test/verify/sess-1#frag"
        )
        .is_err());
        assert!(validate_verification_url(
            origin,
            "sess-1",
            "https://other.example.test/verify/sess-1"
        )
        .is_err());
        assert!(validate_verification_url(
            origin,
            "sess-1",
            "https://user@benchmarks.example.test/verify/sess-1"
        )
        .is_err());
        assert!(validate_verification_url(
            origin,
            "sess-1",
            "http://benchmarks.example.test/verify/sess-1"
        )
        .is_err());
    }

    const HANDOFF_ID: &str = "0b7c5f0e-3d1a-4c2b-9e8f-1a2b3c4d5e6f";
    const HANDOFF_TOKEN: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    #[test]
    fn management_handoff_stays_on_the_bound_origin_fragment() {
        let base = validate_base_url("https://benchmarks.example.test:8443").unwrap();
        assert_eq!(
            management_handoff_endpoint(&base),
            "https://benchmarks.example.test:8443/v1/management-handoffs"
        );
        let url = management_handoff_url(&origin_of(&base), HANDOFF_ID, HANDOFF_TOKEN).unwrap();
        assert_eq!(
            url,
            format!(
                "https://benchmarks.example.test:8443/manage#handoff={HANDOFF_ID}.{HANDOFF_TOKEN}"
            )
        );
        // The ticket rides only in the fragment, never a query string.
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.path(), "/manage");
        assert!(parsed.query().is_none());
        assert_eq!(
            parsed.fragment(),
            Some(format!("handoff={HANDOFF_ID}.{HANDOFF_TOKEN}").as_str())
        );
    }

    #[test]
    fn handoff_parts_must_be_canonical() {
        assert!(validate_handoff_id(HANDOFF_ID).is_ok());
        for rejected in [
            HANDOFF_ID.to_uppercase(),
            // Version 1 and non-RFC variant UUIDs.
            "0b7c5f0e-3d1a-1c2b-9e8f-1a2b3c4d5e6f".to_string(),
            "0b7c5f0e-3d1a-4c2b-1e8f-1a2b3c4d5e6f".to_string(),
            HANDOFF_ID.replace('-', ""),
            format!("{{{HANDOFF_ID}}}"),
            format!("urn:uuid:{HANDOFF_ID}"),
            format!("{HANDOFF_ID}#x"),
            String::new(),
        ] {
            assert!(validate_handoff_id(&rejected).is_err(), "{rejected}");
        }
        assert!(validate_handoff_token(HANDOFF_TOKEN).is_ok());
        for rejected in [
            format!("{HANDOFF_TOKEN}="),
            HANDOFF_TOKEN[..42].to_string(),
            format!("{HANDOFF_TOKEN}A"),
            // Standard-alphabet characters and URL metacharacters.
            format!("{}+", &HANDOFF_TOKEN[..42]),
            format!("{}/", &HANDOFF_TOKEN[..42]),
            format!("{}#", &HANDOFF_TOKEN[..42]),
            format!("{}&", &HANDOFF_TOKEN[..42]),
            // Nonzero trailing bits decode but are not canonical.
            format!("{}9", &HANDOFF_TOKEN[..42]),
            String::new(),
        ] {
            assert!(validate_handoff_token(&rejected).is_err(), "{rejected}");
        }
        assert!(management_handoff_url(
            "https://benchmarks.example.test",
            HANDOFF_ID,
            &format!("{}+", &HANDOFF_TOKEN[..42])
        )
        .is_err());
    }
}
