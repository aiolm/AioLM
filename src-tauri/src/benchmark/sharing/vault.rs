//! OS vault access for publication owner secrets.
//!
//! Secrets live in the platform credential store through `keyring-core` 1.x:
//! Windows Credential Manager, macOS Keychain (`keychain` feature) or the
//! Linux Secret Service (`crypto-rust`, no OpenSSL dependency). There is no
//! plaintext fallback: a locked or missing vault blocks publishing with a
//! typed, recoverable error. The `Vault` trait lets tests inject an
//! in-memory mock; production commands always use [`OsVault`].

use super::recovery::OWNER_SECRET_LEN;
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
use std::sync::Mutex;
use std::sync::{Arc, OnceLock};

/// Non-secret service name under which owner secrets are stored.
pub(crate) const VAULT_SERVICE: &str = "aiolm-benchmark-owner";

/// Typed vault failures. Every variant is recoverable by user action
/// (unlock, retry, import a recovery file); none carries secret material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum VaultError {
    /// The secure store exists but cannot be accessed right now (locked,
    /// denied, headless without an unlocked login collection).
    Locked(String),
    /// No credential is stored for this publication.
    Missing,
    /// The stored entry cannot be used (wrong length, ambiguous, invalid
    /// name). Never auto-replaced: the user must resolve it explicitly.
    Invalid(String),
    /// The platform store itself failed.
    Platform(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Locked(detail) => write!(f, "owner vault is locked or unavailable: {detail}"),
            Self::Missing => write!(f, "owner key is not in the vault"),
            Self::Invalid(detail) => write!(f, "owner vault entry is invalid: {detail}"),
            Self::Platform(detail) => write!(f, "secure storage failed: {detail}"),
        }
    }
}

/// Actionable user-facing message for a vault failure. Never includes secrets.
#[cfg(test)]
pub(crate) fn describe(error: &VaultError) -> String {
    match error {
        VaultError::Missing => "the owner key for this publication is missing from the system vault; import its recovery file to continue".into(),
        VaultError::Locked(_) | VaultError::Platform(_) | VaultError::Invalid(_) => error.to_string(),
    }
}

pub(crate) trait Vault: Send + Sync {
    fn get_secret(&self, user: &str) -> Result<[u8; OWNER_SECRET_LEN], VaultError>;
    fn set_secret(&self, user: &str, secret: &[u8; OWNER_SECRET_LEN]) -> Result<(), VaultError>;
}

/// Production vault backed by the platform credential store.
pub(crate) struct OsVault;

/// Successful store handles only. Transient open failures are never cached:
/// every call retries initialization until a store is installed.
static DEFAULT_STORE: OnceLock<Arc<keyring_core::CredentialStore>> = OnceLock::new();

#[cfg(test)]
type StoreOpener = fn() -> Result<Arc<keyring_core::CredentialStore>, String>;

#[cfg(test)]
static TEST_OPENER: Mutex<Option<StoreOpener>> = Mutex::new(None);

/// Injectable opener seam for tests: failure-then-success sequences prove
/// initialization retries without an app restart.
#[cfg(test)]
pub(crate) fn set_test_opener(opener: Option<StoreOpener>) {
    *TEST_OPENER.lock().expect("vault test opener lock") = opener;
}

fn open_platform_store() -> Result<Arc<keyring_core::CredentialStore>, String> {
    #[cfg(test)]
    if let Some(opener) = TEST_OPENER.lock().expect("vault test opener lock").as_ref() {
        return opener();
    }
    #[cfg(windows)]
    {
        let store = windows_native_keyring_store::Store::new()
            .map_err(|error| format!("cannot open Windows Credential Manager: {error}"))?;
        Ok(store)
    }
    #[cfg(target_os = "macos")]
    {
        let store = apple_native_keyring_store::keychain::Store::new()
            .map_err(|error| format!("cannot open macOS Keychain: {error}"))?;
        Ok(store)
    }
    #[cfg(target_os = "linux")]
    {
        let store = zbus_secret_service_keyring_store::Store::new()
            .map_err(|error| format!("cannot open Linux Secret Service: {error}"))?;
        Ok(store)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        return Err("secure storage is not supported on this platform".into());
    }
}

fn ensure_default_store() -> Result<(), String> {
    if DEFAULT_STORE.get().is_some() {
        return Ok(());
    }
    let store = open_platform_store()?;
    keyring_core::set_default_store(store.clone());
    // A racing initializer may win first; either store is equivalent.
    let _ = DEFAULT_STORE.set(store);
    Ok(())
}

fn map_error(error: keyring_core::Error) -> VaultError {
    match error {
        keyring_core::Error::NoEntry => VaultError::Missing,
        keyring_core::Error::NoStorageAccess(detail) => VaultError::Locked(detail.to_string()),
        keyring_core::Error::PlatformFailure(detail) => VaultError::Platform(detail.to_string()),
        keyring_core::Error::Invalid(_, detail) => VaultError::Invalid(detail.to_string()),
        keyring_core::Error::TooLong(name, limit) => {
            VaultError::Invalid(format!("vault entry {name} exceeds length {limit}"))
        }
        keyring_core::Error::Ambiguous(_) => {
            VaultError::Invalid("multiple vault entries match this publication".into())
        }
        keyring_core::Error::NoDefaultStore => {
            VaultError::Platform("secure storage is not supported on this platform".into())
        }
        _ => VaultError::Platform("secure storage returned an unknown error".into()),
    }
}

impl Vault for OsVault {
    fn get_secret(&self, user: &str) -> Result<[u8; OWNER_SECRET_LEN], VaultError> {
        if let Err(detail) = ensure_default_store() {
            return Err(VaultError::Platform(detail));
        }
        let entry = keyring_core::Entry::new(VAULT_SERVICE, user).map_err(map_error)?;
        let secret = entry.get_secret().map_err(map_error)?;
        if secret.len() != OWNER_SECRET_LEN {
            return Err(VaultError::Invalid(
                "stored owner key has an unexpected length".into(),
            ));
        }
        let mut bytes = [0u8; OWNER_SECRET_LEN];
        bytes.copy_from_slice(&secret);
        Ok(bytes)
    }

    fn set_secret(&self, user: &str, secret: &[u8; OWNER_SECRET_LEN]) -> Result<(), VaultError> {
        if let Err(detail) = ensure_default_store() {
            return Err(VaultError::Platform(detail));
        }
        let entry = keyring_core::Entry::new(VAULT_SERVICE, user).map_err(map_error)?;
        entry.set_secret(secret).map_err(map_error)
    }
}

/// Generate a fresh 32-byte owner secret from the OS random source.
pub(crate) fn random_owner_secret() -> Result<[u8; OWNER_SECRET_LEN], String> {
    let mut secret = [0u8; OWNER_SECRET_LEN];
    getrandom::fill(&mut secret)
        .map_err(|error| format!("cannot generate an owner key: {error}"))?;
    Ok(secret)
}

/// In-memory vault for unit tests. `locked` simulates an OS-locked store;
/// dropping the registry handle while keeping the vault simulates a restart.
#[cfg(test)]
pub(crate) struct MockVault {
    state: Mutex<MockState>,
}

#[cfg(test)]
struct MockState {
    secrets: HashMap<String, [u8; OWNER_SECRET_LEN]>,
    locked: bool,
    fail_next_set: bool,
    successful_sets: u64,
}

#[cfg(test)]
impl MockVault {
    pub(crate) fn open() -> Self {
        Self {
            state: Mutex::new(MockState {
                secrets: HashMap::new(),
                locked: false,
                fail_next_set: false,
                successful_sets: 0,
            }),
        }
    }

    pub(crate) fn set_locked(&self, locked: bool) {
        self.state.lock().expect("mock vault lock").locked = locked;
    }

    /// Fail the next `set_secret` with a transient error, keeping any
    /// existing key untouched. Models a crash-prone vault write.
    pub(crate) fn inject_set_failure(&self) {
        self.state.lock().expect("mock vault lock").fail_next_set = true;
    }

    pub(crate) fn successful_sets(&self) -> u64 {
        self.state.lock().expect("mock vault lock").successful_sets
    }
}

#[cfg(test)]
impl Vault for MockVault {
    fn get_secret(&self, user: &str) -> Result<[u8; OWNER_SECRET_LEN], VaultError> {
        let state = self.state.lock().expect("mock vault lock");
        if state.locked {
            return Err(VaultError::Locked("mock vault is locked".into()));
        }
        state.secrets.get(user).copied().ok_or(VaultError::Missing)
    }

    fn set_secret(&self, user: &str, secret: &[u8; OWNER_SECRET_LEN]) -> Result<(), VaultError> {
        let mut state = self.state.lock().expect("mock vault lock");
        if state.locked {
            return Err(VaultError::Locked("mock vault is locked".into()));
        }
        if state.fail_next_set {
            state.fail_next_set = false;
            return Err(VaultError::Locked("synthetic vault write outage".into()));
        }
        state.secrets.insert(user.into(), *secret);
        state.successful_sets += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_vault_round_trip_lock_and_restart() {
        let vault = MockVault::open();
        let secret = [7u8; OWNER_SECRET_LEN];
        assert_eq!(vault.get_secret("user"), Err(VaultError::Missing));
        vault.set_secret("user", &secret).unwrap();
        assert_eq!(vault.get_secret("user").unwrap(), secret);
        // A locked vault blocks access without leaking or clearing material.
        vault.set_locked(true);
        assert!(matches!(
            vault.get_secret("user"),
            Err(VaultError::Locked(_))
        ));
        assert!(matches!(
            vault.set_secret("user", &secret),
            Err(VaultError::Locked(_))
        ));
        vault.set_locked(false);
        assert_eq!(vault.get_secret("user").unwrap(), secret);
    }

    #[test]
    fn error_messages_carry_no_secret_material() {
        let message = describe(&VaultError::Missing);
        assert!(message.contains("recovery file"));
        assert!(!message.contains("secret"));
    }

    static OPENER_CALLS: AtomicU64 = AtomicU64::new(0);

    fn fail_once_opener() -> Result<Arc<keyring_core::CredentialStore>, String> {
        if OPENER_CALLS.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err("synthetic credential service outage".into());
        }
        let store = keyring_core::mock::Store::new()
            .map_err(|error| format!("cannot open mock credential store: {error}"))?;
        Ok(store)
    }

    #[test]
    fn store_init_retries_after_transient_failure() {
        OPENER_CALLS.store(0, Ordering::SeqCst);
        set_test_opener(Some(fail_once_opener));
        // A transient outage surfaces but is never cached ...
        assert!(ensure_default_store().is_err());
        // ... so recovery needs no app restart, and success sticks.
        assert!(ensure_default_store().is_ok());
        assert!(ensure_default_store().is_ok());
        set_test_opener(None);
        assert_eq!(OPENER_CALLS.load(Ordering::SeqCst), 2);
    }
}
