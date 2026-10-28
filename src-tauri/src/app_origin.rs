//! Exact web origins shared by the application's loopback HTTP listeners.
//! An allowed browser origin never replaces endpoint authentication.
pub(crate) fn is_allowed(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:1420"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_packaged_and_configured_development_origins_are_allowed() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:1420",
        ] {
            assert!(is_allowed(origin));
        }
        for origin in [
            "null",
            "http://tauri.localhost.evil.invalid",
            "https://evil.invalid",
            "http://localhost:1421",
            "http://localhost:1420/",
            "http://localhost:1420\r\nInjected: value",
        ] {
            assert!(!is_allowed(origin));
        }
    }
}
