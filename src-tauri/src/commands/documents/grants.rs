//! Native-selected document paths and shared approval for restored bindings.
use crate::error::AppError;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};

const MAX_GRANTS: usize = 4096;
const MAX_GRANT_FILE_BYTES: usize = 16 * 1024 * 1024;
type Approval = tokio::sync::Mutex<Option<Result<(), AppError>>>;

struct PersistedGrants {
    path: PathBuf,
    entries: Option<VecDeque<PathBuf>>,
}

impl PersistedGrants {
    fn entries(&mut self) -> Result<&mut VecDeque<PathBuf>, AppError> {
        if self.entries.is_none() {
            let entries = match fs::File::open(&self.path) {
                Ok(file) => {
                    let mut bytes = Vec::new();
                    file.take(MAX_GRANT_FILE_BYTES as u64 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|error| AppError::io("cannot read document grants", &error))?;
                    if bytes.len() > MAX_GRANT_FILE_BYTES {
                        return Err(AppError::validation(
                            "document grants exceed the safety limit",
                        ));
                    }
                    let entries: VecDeque<PathBuf> =
                        serde_json::from_slice(&bytes).map_err(|error| {
                            AppError::validation(format!("cannot load document grants: {error}"))
                        })?;
                    if entries.len() > MAX_GRANTS || entries.iter().any(|path| !path.is_absolute())
                    {
                        return Err(AppError::validation("invalid persisted document grants"));
                    }
                    entries
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => VecDeque::new(),
                Err(error) => return Err(AppError::io("cannot open document grants", &error)),
            };
            self.entries = Some(entries);
        }
        Ok(self.entries.as_mut().expect("document grants loaded"))
    }
}

pub(super) struct DocumentGrants {
    persisted: Mutex<PersistedGrants>,
    approvals: Mutex<HashMap<PathBuf, Weak<Approval>>>,
}

impl DocumentGrants {
    fn new(path: PathBuf) -> Self {
        Self {
            persisted: Mutex::new(PersistedGrants {
                path,
                entries: None,
            }),
            approvals: Mutex::new(HashMap::new()),
        }
    }

    fn contains(&self, canonical: &Path) -> Result<bool, AppError> {
        let mut persisted = self
            .persisted
            .lock()
            .map_err(|_| "document grant state was poisoned".to_string())?;
        Ok(persisted.entries()?.iter().any(|path| path == canonical))
    }

    pub(super) fn grant(&self, canonical: &Path) -> Result<(), AppError> {
        let canonical = super::ensure_document_binding_path(canonical)?;
        let mut persisted = self
            .persisted
            .lock()
            .map_err(|_| "document grant state was poisoned".to_string())?;
        persisted.entries()?;
        let PersistedGrants { path, entries } = &mut *persisted;
        let entries = entries.as_mut().expect("document grants loaded");
        if entries.iter().any(|path| path == &canonical) {
            return Ok(());
        }
        let evicted = if entries.len() == MAX_GRANTS {
            entries.pop_front()
        } else {
            None
        };
        entries.push_back(canonical);
        let result = (|| {
            let bytes = serde_json::to_vec(&entries)
                .map_err(|error| format!("cannot serialize document grants: {error}"))?;
            if bytes.len() > MAX_GRANT_FILE_BYTES {
                return Err(AppError::validation(
                    "document grants exceed the safety limit",
                ));
            }
            crate::config::atomic_write(path, &bytes)
        })();
        if result.is_err() {
            entries.pop_back();
            if let Some(evicted) = evicted {
                entries.push_front(evicted);
            }
        }
        result
    }

    pub(super) async fn authorize<F, Fut>(
        &self,
        canonical: &Path,
        confirm: F,
    ) -> Result<(), AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<bool, String>>,
    {
        if self.contains(canonical)? {
            return Ok(());
        }
        let approval = {
            let mut approvals = self
                .approvals
                .lock()
                .map_err(|_| "document approval state was poisoned".to_string())?;
            approvals.retain(|_, approval| approval.strong_count() > 0);
            if let Some(approval) = approvals.get(canonical).and_then(Weak::upgrade) {
                approval
            } else {
                let approval = Arc::new(Approval::new(None));
                approvals.insert(canonical.to_path_buf(), Arc::downgrade(&approval));
                approval
            }
        };
        let mut result = approval.lock().await;
        if let Some(result) = result.as_ref() {
            return result.clone();
        }
        let outcome = async {
            // A picker or another completed approval may have granted it meanwhile.
            if self.contains(canonical)? {
                return Ok(());
            }
            if !confirm().await.map_err(AppError::unavailable)? {
                return Err(AppError::denied("project document access was not approved"));
            }
            self.grant(canonical)
        }
        .await;
        *result = Some(outcome.clone());
        outcome
    }
}

pub(super) fn document_grants() -> Result<&'static DocumentGrants, AppError> {
    static GRANTS: LazyLock<Result<DocumentGrants, AppError>> = LazyLock::new(|| {
        Ok(DocumentGrants::new(
            crate::home::resolve_aiolm_home()?.join("document-grants.json"),
        ))
    });
    GRANTS.as_ref().map_err(Clone::clone)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestHome(PathBuf);
    impl TestHome {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("aiolm-document-grants-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn document(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, b"synthetic document").unwrap();
            path.canonicalize().unwrap()
        }
    }
    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn native_grants_survive_restart_and_do_not_authorize_other_documents() {
        let home = TestHome::new();
        let selected = home.document("selected.txt");
        let other = home.document("other.txt");
        let file = home.0.join("document-grants.json");
        DocumentGrants::new(file.clone()).grant(&selected).unwrap();
        let restored = DocumentGrants::new(file);
        restored
            .authorize(&selected, || async {
                panic!("selected document must not prompt")
            })
            .await
            .unwrap();
        let denied = restored
            .authorize(&other, || async { Ok(false) })
            .await
            .unwrap_err();
        assert_eq!(denied.kind, crate::error::ErrorKind::Denied);
        assert_eq!(denied.message, "project document access was not approved");
        assert!(!restored.contains(&other).unwrap());
        let restarted = DocumentGrants::new(home.0.join("document-grants.json"));
        assert!(restarted.contains(&selected).unwrap());
        assert!(!restarted.contains(&other).unwrap());
    }

    #[tokio::test]
    async fn concurrent_binding_requests_share_approval_and_persist_only_yes() {
        for approved in [true, false] {
            let home = TestHome::new();
            let document = home.document("restored.txt");
            let file = home.0.join("document-grants.json");
            let grants = DocumentGrants::new(file.clone());
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let confirm = || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok(approved)
            };
            let (first, second) = tokio::join!(
                grants.authorize(&document, confirm),
                grants.authorize(&document, confirm),
            );
            assert_eq!(first.is_ok(), approved);
            assert_eq!(second.is_ok(), approved);
            if !approved {
                assert_eq!(first.unwrap_err().kind, crate::error::ErrorKind::Denied);
                assert_eq!(second.unwrap_err().kind, crate::error::ErrorKind::Denied);
            }
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert_eq!(
                DocumentGrants::new(file).contains(&document).unwrap(),
                approved
            );
        }
    }

    #[test]
    fn grants_reject_relative_paths_and_store_only_canonical_files() {
        let home = TestHome::new();
        let document = home.document("selected.txt");
        let grants = DocumentGrants::new(home.0.join("document-grants.json"));
        assert!(grants.grant(Path::new("selected.txt")).is_err());
        assert!(super::super::ensure_document_binding_path(Path::new("selected.txt")).is_err());
        assert!(grants.grant(&home.0.join(".").join("selected.txt")).is_ok());
        assert!(grants.contains(&document).unwrap());
        let stored: Vec<PathBuf> =
            serde_json::from_slice(&fs::read(home.0.join("document-grants.json")).unwrap())
                .unwrap();
        assert_eq!(stored, vec![document]);
        assert!(grants.grant(&home.0).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_and_parent_symlinks_share_the_canonical_target_grant() {
        let home = TestHome::new();
        let document = home.document("selected.txt");
        let alias = home.0.join("alias.txt");
        std::os::unix::fs::symlink(&document, &alias).unwrap();
        let directory_alias = home.0.join("alias-directory");
        std::os::unix::fs::symlink(&home.0, &directory_alias).unwrap();
        let grants = DocumentGrants::new(home.0.join("document-grants.json"));
        grants.grant(&document).unwrap();
        for path in [alias, directory_alias.join("selected.txt")] {
            let canonical = super::super::ensure_document_binding_path(&path).unwrap();
            assert_eq!(canonical, document);
            grants
                .authorize(&canonical, || async {
                    panic!("an alias of a granted document must not prompt")
                })
                .await
                .unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_to_an_ungranted_document_require_approval_for_the_target() {
        let home = TestHome::new();
        let selected = home.document("selected.txt");
        let other = home.document("other.txt");
        let alias = home.0.join("alias.txt");
        std::os::unix::fs::symlink(&other, &alias).unwrap();
        let file = home.0.join("document-grants.json");
        let grants = DocumentGrants::new(file.clone());
        grants.grant(&selected).unwrap();
        let canonical = super::super::ensure_document_binding_path(&alias).unwrap();
        assert_eq!(canonical, other);
        assert!(!grants.contains(&canonical).unwrap());
        assert!(grants
            .authorize(&canonical, || async {
                assert_eq!(canonical, other);
                Ok(false)
            })
            .await
            .is_err());
        assert!(!grants.contains(&other).unwrap());
        grants
            .authorize(&canonical, || async {
                assert_eq!(canonical, other);
                Ok(true)
            })
            .await
            .unwrap();
        let restored = DocumentGrants::new(file);
        assert!(restored.contains(&other).unwrap());
        assert!(!restored.contains(&alias).unwrap());
    }

    #[test]
    fn persisted_grants_are_bounded_and_preserve_the_newest_selection() {
        let home = TestHome::new();
        let file = home.0.join("document-grants.json");
        let oldest = home.0.join("oldest.txt");
        let mut entries = VecDeque::from([oldest.clone()]);
        for index in 1..MAX_GRANTS {
            entries.push_back(home.0.join(format!("synthetic-{index}.txt")));
        }
        crate::config::atomic_write(&file, &serde_json::to_vec(&entries).unwrap()).unwrap();
        let latest = home.document("latest.txt");
        let grants = DocumentGrants::new(file.clone());
        grants.grant(&latest).unwrap();
        let restored = DocumentGrants::new(file);
        assert!(!restored.contains(&oldest).unwrap());
        assert!(restored.contains(&latest).unwrap());
        assert_eq!(
            restored.persisted.lock().unwrap().entries().unwrap().len(),
            MAX_GRANTS
        );
    }
}
