use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::SystemTime;
use tokio::io::AsyncReadExt;

const REPOSITORY: &str = "owner/model";
const CONFIG: &[u8] = br#"{"model_type":"llama","architectures":["LlamaForCausalLM"],"v":1}"#;
const NEW_CONFIG: &[u8] = br#"{"model_type":"llama","architectures":["LlamaForCausalLM"],"v":2}"#;

#[derive(Clone)]
struct Blob {
    path: String,
    bytes: Vec<u8>,
}

impl Blob {
    fn new(path: &str, bytes: &[u8]) -> Self {
        Self {
            path: path.into(),
            bytes: bytes.to_vec(),
        }
    }

    fn oid(&self) -> String {
        if self.path.ends_with(".json") {
            let mut digest = sha1::Sha1::new();
            digest.update(format!("blob {}\0", self.bytes.len()).as_bytes());
            digest.update(&self.bytes);
            format!("{:x}", digest.finalize())
        } else {
            format!("{:x}", Sha256::digest(&self.bytes))
        }
    }

    fn tracked(&self, local: &str) -> TrackedFile {
        TrackedFile {
            remote: self.path.clone(),
            local: local.into(),
            size: self.bytes.len() as u64,
            oid: Some(self.oid()),
        }
    }
}

fn snapshot_blobs() -> Vec<Blob> {
    vec![
        Blob::new("config.json", CONFIG),
        Blob::new("tokenizer.json", b"{}"),
        // The artifact inspector checks weight presence, not tensor decoding.
        Blob::new("model.safetensors", b"synthetic weights"),
    ]
}

fn remote(blobs: &[Blob], revision: char) -> Remote {
    Remote {
        revision: revision.to_string().repeat(40),
        entries: blobs
            .iter()
            .map(|blob| {
                serde_json::from_value(serde_json::json!({
                    "type": "file",
                    "path": blob.path,
                    "size": blob.bytes.len(),
                    "oid": blob.oid(),
                }))
                .unwrap()
            })
            .collect(),
    }
}

struct Fixture {
    directory: PathBuf,
    library: PathBuf,
    receipts: PathBuf,
    model: PathBuf,
    metadata: PathBuf,
}

impl Fixture {
    fn directory() -> (PathBuf, PathBuf, PathBuf) {
        let directory = std::env::temp_dir().join(format!("aiolm-update-{}", Uuid::new_v4()));
        let library = directory.join("models");
        let receipts = directory.join("receipts");
        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&receipts).unwrap();
        let directory = directory.canonicalize().unwrap();
        (
            directory,
            library.canonicalize().unwrap(),
            receipts.canonicalize().unwrap(),
        )
    }

    fn snapshot(blobs: &[Blob]) -> Self {
        let (directory, library, receipts) = Self::directory();
        let revision = "a".repeat(40);
        let model = library
            .join("hf")
            .join(repo_directory(REPOSITORY))
            .join("snapshots")
            .join(&revision);
        fs::create_dir_all(&model).unwrap();
        for blob in blobs {
            let target = model.join(&blob.path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, &blob.bytes).unwrap();
        }
        let metadata = model.join(SNAPSHOT_MANIFEST);
        let manifest = SnapshotManifest {
            format: 1,
            repository: REPOSITORY.into(),
            revision,
            selected_file: None,
            complete: true,
            files: blobs
                .iter()
                .map(|blob| blob.tracked(&blob.path).snapshot_file())
                .collect(),
        };
        // Deliberately not the planner's pretty encoding: a no-op must not
        // silently rewrite an otherwise valid ownership manifest.
        fs::write(&metadata, serde_json::to_vec(&manifest).unwrap()).unwrap();
        Self {
            directory,
            library,
            receipts,
            model,
            metadata,
        }
    }

    fn selected_snapshot(blobs: &[Blob], selected: &str) -> Self {
        let (directory, library, receipts) = Self::directory();
        let model = library
            .join("hf")
            .join(repo_directory(REPOSITORY))
            .join("snapshots")
            .join("c".repeat(40));
        fs::create_dir_all(&model).unwrap();
        let files = blobs
            .iter()
            .map(|blob| {
                let local = blob.path.rsplit('/').next().unwrap();
                fs::write(model.join(local), &blob.bytes).unwrap();
                blob.tracked(local).snapshot_file()
            })
            .collect();
        let metadata = model.join(SNAPSHOT_MANIFEST);
        let manifest = SnapshotManifest {
            format: 2,
            repository: REPOSITORY.into(),
            revision: "a".repeat(40),
            selected_file: Some(selected.into()),
            complete: true,
            files,
        };
        fs::write(&metadata, serde_json::to_vec(&manifest).unwrap()).unwrap();
        Self {
            directory,
            library,
            receipts,
            model,
            metadata,
        }
    }

    fn gguf(blobs: &[Blob], entrypoint: &str, companions: bool, legacy: bool) -> Self {
        let (directory, library, receipts) = Self::directory();
        let repository = library.join("hf").join(repo_directory(REPOSITORY));
        let model = repository.join(relative_path(entrypoint));
        let root = model.parent().unwrap();
        fs::create_dir_all(root).unwrap();
        let files: Vec<_> = blobs
            .iter()
            .map(|blob| {
                let local = blob.path.rsplit('/').next().unwrap();
                let target = root.join(local);
                fs::write(&target, &blob.bytes).unwrap();
                if blob.path.ends_with(".gguf") {
                    crate::benchmark::download_receipt::record(
                        &receipts, &target, REPOSITORY, &blob.path,
                    )
                    .unwrap();
                }
                blob.tracked(local)
            })
            .collect();
        let metadata = gguf_metadata(&model).unwrap();
        if !legacy {
            let manifest = GgufManifest {
                format: 1,
                repository: REPOSITORY.into(),
                revision: "a".repeat(40),
                entrypoint: entrypoint.into(),
                companions,
                files,
            };
            fs::write(&metadata, serde_json::to_vec(&manifest).unwrap()).unwrap();
        }
        Self {
            directory,
            library,
            receipts,
            model,
            metadata,
        }
    }

    fn installed(&self) -> Installed {
        load_installed(
            self.model.to_str().unwrap(),
            self.library.to_str().unwrap(),
            Some(&self.receipts),
        )
        .unwrap()
    }

    fn root(&self) -> &Path {
        if self.model.is_dir() {
            &self.model
        } else {
            self.model.parent().unwrap()
        }
    }

    fn state(&self, blobs: &[Blob]) -> BTreeMap<PathBuf, FileState> {
        let mut files: Vec<_> = blobs
            .iter()
            .map(|blob| {
                self.root().join(if self.model.is_dir() {
                    blob.path.as_str()
                } else {
                    blob.path.rsplit('/').next().unwrap()
                })
            })
            .collect();
        if self.metadata.exists() {
            files.push(self.metadata.clone());
        }
        files
            .into_iter()
            .map(|path| {
                let state = FileState::read(&path);
                (path, state)
            })
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[derive(Debug, PartialEq, Eq)]
struct FileState {
    bytes: Vec<u8>,
    modified: SystemTime,
    #[cfg(unix)]
    inode: u64,
}

impl FileState {
    fn read(path: &Path) -> Self {
        let metadata = fs::metadata(path).unwrap();
        Self {
            bytes: fs::read(path).unwrap(),
            modified: metadata.modified().unwrap(),
            #[cfg(unix)]
            inode: {
                use std::os::unix::fs::MetadataExt;
                metadata.ino()
            },
        }
    }
}

fn assert_unchanged(state: &BTreeMap<PathBuf, FileState>) {
    for (path, before) in state {
        assert_eq!(&FileState::read(path), before, "rewrote {}", path.display());
    }
}

#[derive(Clone)]
struct Reply {
    bytes: Vec<u8>,
    declared: usize,
    status: u16,
}

impl Reply {
    fn ok(bytes: &[u8]) -> Self {
        Self {
            bytes: bytes.to_vec(),
            declared: bytes.len(),
            status: 200,
        }
    }
}

struct Loopback {
    source: TransferSource,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Loopback {
    async fn start(blobs: &[Blob]) -> Self {
        Self::replies(
            blobs
                .iter()
                .map(|blob| (format!("/{}", blob.path), Reply::ok(&blob.bytes)))
                .collect(),
        )
        .await
    }

    async fn replies(replies: HashMap<String, Reply>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                    assert!(request.len() < 16 * 1024, "oversized fixture request");
                }
                let text = String::from_utf8(request).unwrap();
                let path = text
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .to_string();
                recorded.lock().unwrap().push(path.clone());
                let missing = Reply {
                    bytes: Vec::new(),
                    declared: 0,
                    status: 404,
                };
                let reply = replies.get(&path).unwrap_or(&missing);
                let headers = format!(
                    "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.status, reply.declared
                );
                if socket.write_all(headers.as_bytes()).await.is_ok() {
                    let _ = socket.write_all(&reply.bytes).await;
                }
                let _ = socket.shutdown().await;
            }
        });
        Self {
            source: TransferSource::Loopback(format!("http://{address}")),
            requests,
            task,
        }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn changed_names(plan: &Plan) -> Vec<&str> {
    let mut names: Vec<_> = plan
        .changed
        .iter()
        .map(|index| plan.files[*index].local.as_str())
        .collect();
    names.sort_unstable();
    names
}

#[tokio::test]
async fn unchanged_revision_never_requests_or_rewrites_model_files_or_manifest() {
    let blobs = snapshot_blobs();
    let fixture = Fixture::snapshot(&blobs);
    let before = fixture.state(&blobs);
    let cancel = AtomicBool::new(false);
    let plan = plan_update(
        fixture.installed(),
        &remote(&blobs, 'a'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    assert!(plan.changed.is_empty());
    assert!(plan.removed.is_empty());
    assert_eq!(plan.download_bytes, 0);
    assert_eq!(
        plan.reused_bytes,
        blobs
            .iter()
            .map(|blob| blob.bytes.len() as u64)
            .sum::<u64>()
    );
    let server = Loopback::start(&[]).await;
    let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    assert_eq!(result.updated_files, 0);
    assert_eq!(result.removed_files, 0);
    assert_eq!(result.downloaded_bytes, 0);
    assert!(server.requests().is_empty());
    assert_unchanged(&before);
    let manifest = read_snapshot_manifest(&fixture.metadata).unwrap().unwrap();
    assert_eq!(manifest.format, 1);
    assert!(manifest.selected_file.is_none());
}

#[tokio::test]
async fn config_only_update_requests_only_config_and_preserves_weight_inode_and_mtime() {
    let old = snapshot_blobs();
    let fixture = Fixture::snapshot(&old);
    let weight = fixture.root().join("model.safetensors");
    let weight_before = FileState::read(&weight);
    let tokenizer_before = FileState::read(&fixture.root().join("tokenizer.json"));
    let mut next = old.clone();
    next[0] = Blob::new("config.json", NEW_CONFIG);
    let cancel = AtomicBool::new(false);
    let plan = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Check,
    )
    .await
    .unwrap();
    assert_eq!(changed_names(&plan), ["config.json"]);
    assert_eq!(plan.download_bytes, NEW_CONFIG.len() as u64);
    let server = Loopback::start(&next).await;
    let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    assert_eq!(server.requests(), ["/config.json"]);
    assert_eq!(result.updated_files, 1);
    assert_eq!(result.downloaded_bytes, NEW_CONFIG.len() as u64);
    assert_eq!(result.path, fixture.model.to_str().unwrap());
    assert_eq!(FileState::read(&weight), weight_before);
    assert_eq!(
        FileState::read(&fixture.root().join("tokenizer.json")),
        tokenizer_before
    );
    assert_eq!(
        fs::read(fixture.root().join("config.json")).unwrap(),
        NEW_CONFIG
    );
    let manifest = read_snapshot_manifest(&fixture.metadata).unwrap().unwrap();
    assert_eq!(manifest.format, 1);
    assert!(manifest.selected_file.is_none());
    assert_eq!(manifest.revision, "b".repeat(40));
    assert!(manifest.complete);
    assert_eq!(
        manifest
            .files
            .iter()
            .find(|file| file.path == "config.json")
            .unwrap()
            .oid,
        next[0].tracked("config.json").oid
    );
}

fn selected_weights(value: f32) -> Vec<u8> {
    let mut header = br#"{"weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}"#.to_vec();
    header.resize(header.len().div_ceil(8) * 8, b' ');
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&value.to_le_bytes());
    bytes
}

fn nested_selected_blobs() -> Vec<Blob> {
    vec![
        Blob::new("variants/q4/config.json", CONFIG),
        Blob::new("variants/q4/tokenizer.json", b"{}"),
        Blob::new("variants/q4/model.safetensors", &selected_weights(1.0)),
    ]
}

fn normalized_blobs(blobs: &[Blob]) -> Vec<Blob> {
    blobs
        .iter()
        .map(|blob| Blob::new(blob.path.rsplit('/').next().unwrap(), &blob.bytes))
        .collect()
}

#[test]
fn older_indexed_update_ownership_normalizes_identity_without_relocating_user_paths() {
    let blobs = vec![
        Blob::new("q4/config.json", CONFIG),
        Blob::new("q4/tokenizer.json", b"{}"),
        Blob::new("q4/model-a.safetensors", &selected_weights(1.0)),
        Blob::new("q4/model-b.safetensors", &selected_weights(2.0)),
        Blob::new(
            "q4/model.safetensors.index.json",
            br#"{"weight_map":{"a":"model-a.safetensors","b":"model-b.safetensors"}}"#,
        ),
    ];
    let fixture = Fixture::selected_snapshot(&blobs, "q4/model-b.safetensors");
    let before = fixture.state(&normalized_blobs(&blobs));
    let installed = fixture.installed();
    assert_eq!(installed.path, fixture.model.to_str().unwrap());
    assert_eq!(installed.root, fixture.model);
    assert_eq!(
        installed.selected_file.as_deref(),
        Some("q4/model-a.safetensors")
    );
    assert_eq!(installed.files.len(), 5);
    assert!(installed
        .files
        .iter()
        .all(|file| file.remote == format!("q4/{}", file.local)));
    assert_eq!(
        installed.revision.as_deref(),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_unchanged(&before);
    // User config/session references remain valid: preparing update ownership
    // neither moves the old member-b directory nor creates the canonical one.
    assert_eq!(
        fs::read_dir(fixture.model.parent().unwrap())
            .unwrap()
            .count(),
        1
    );
    let persisted = read_snapshot_manifest(&fixture.metadata).unwrap().unwrap();
    assert_eq!(
        persisted.selected_file.as_deref(),
        Some("q4/model-b.safetensors")
    );
}

#[tokio::test]
async fn selected_nested_update_preserves_source_paths_and_excludes_other_models() {
    let old = nested_selected_blobs();
    let selected = "variants/q4/model.safetensors";
    let fixture = Fixture::selected_snapshot(&old, selected);
    let original_path = fixture.model.clone();
    let tokenizer_before = FileState::read(&fixture.root().join("tokenizer.json"));
    let installed = fixture.installed();
    assert_eq!(installed.selected_file.as_deref(), Some(selected));
    assert!(installed
        .files
        .iter()
        .all(|file| { file.remote == format!("variants/q4/{}", file.local) }));
    let mut next = old.clone();
    next[0] = Blob::new("variants/q4/config.json", NEW_CONFIG);
    next[2] = Blob::new(selected, &selected_weights(2.0));
    // Valid independent choices must not become part of this model update.
    next.extend([
        Blob::new("variants/q4/alternative.safetensors", b"alternative"),
        Blob::new("variants/q8/config.json", CONFIG),
        Blob::new("variants/q8/tokenizer.json", b"{}"),
        Blob::new("variants/q8/model.safetensors", b"other variant"),
    ]);
    next.extend(snapshot_blobs());
    let cancel = AtomicBool::new(false);
    let plan = plan_update(installed, &remote(&next, 'b'), &cancel, PlanMode::Apply)
        .await
        .unwrap();
    assert_eq!(changed_names(&plan), ["config.json", "model.safetensors"]);
    assert!(plan.removed.is_empty());
    assert_eq!(plan.files.len(), 3);
    let server = Loopback::start(&next).await;
    let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    let mut requests = server.requests();
    requests.sort_unstable();
    assert_eq!(
        requests,
        ["/variants/q4/config.json", "/variants/q4/model.safetensors"]
    );
    assert_eq!(result.path, original_path.to_str().unwrap());
    assert_eq!(result.updated_files, 2);
    assert_eq!(
        FileState::read(&fixture.root().join("tokenizer.json")),
        tokenizer_before
    );
    assert_eq!(
        fs::read(fixture.root().join("model.safetensors")).unwrap(),
        selected_weights(2.0)
    );
    assert!(!fixture.root().join("alternative.safetensors").exists());
    assert!(!fixture.root().join("variants").exists());
    let manifest = read_snapshot_manifest(&fixture.metadata).unwrap().unwrap();
    assert_eq!(manifest.format, 2);
    assert_eq!(manifest.selected_file.as_deref(), Some(selected));
    assert_eq!(manifest.revision, "b".repeat(40));
    assert_eq!(manifest.files.len(), 3);
    assert!(manifest.files.iter().all(|file| {
        file.remote_path.as_deref() == Some(format!("variants/q4/{}", file.path).as_str())
    }));
    // Reopen persisted metadata: the next update must retain this same scope.
    let reopened = fixture.installed();
    assert_eq!(reopened.selected_file.as_deref(), Some(selected));
    let unchanged = plan_update(reopened, &remote(&next, 'b'), &cancel, PlanMode::Apply)
        .await
        .unwrap();
    assert!(unchanged.changed.is_empty());
    assert!(unchanged.removed.is_empty());
}

#[tokio::test]
async fn removed_selected_entrypoint_never_falls_back_to_a_whole_snapshot() {
    let old = nested_selected_blobs();
    let fixture = Fixture::selected_snapshot(&old, "variants/q4/model.safetensors");
    let before = fixture.state(&normalized_blobs(&old));
    let mut next = old[..2].to_vec();
    next.push(Blob::new(
        "variants/q4/alternative.safetensors",
        b"alternative",
    ));
    next.extend(snapshot_blobs());
    assert!(plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &AtomicBool::new(false),
        PlanMode::Apply,
    )
    .await
    .is_err());
    assert_unchanged(&before);
}

#[tokio::test]
async fn selected_nested_cancellation_and_digest_failure_do_not_publish_or_change_scope() {
    for cancellation in [true, false] {
        let old = nested_selected_blobs();
        let selected = "variants/q4/model.safetensors";
        let fixture = Fixture::selected_snapshot(&old, selected);
        let before = fixture.state(&normalized_blobs(&old));
        let mut next = old.clone();
        next[2] = Blob::new(selected, &selected_weights(2.0));
        next.push(Blob::new(
            "variants/q4/alternative.safetensors",
            b"alternative",
        ));
        next.extend(snapshot_blobs());
        let cancel = AtomicBool::new(false);
        let plan = plan_update(
            fixture.installed(),
            &remote(&next, 'b'),
            &cancel,
            PlanMode::Apply,
        )
        .await
        .unwrap();
        let mut replies = HashMap::new();
        replies.insert(
            format!("/{selected}"),
            if cancellation {
                Reply::ok(&next[2].bytes)
            } else {
                Reply::ok(&vec![b'x'; next[2].bytes.len()])
            },
        );
        let server = Loopback::replies(replies).await;
        let error = apply_plan(
            plan,
            &cancel,
            |_, received, _| {
                if cancellation && received > 0 {
                    cancel.store(true, Ordering::Release);
                }
            },
            &server.source,
        )
        .await
        .unwrap_err();
        if cancellation {
            assert_eq!(error, DOWNLOAD_CANCELLED);
        } else {
            assert!(
                error.contains("digest") || error.contains("checksum"),
                "{error}"
            );
        }
        assert_eq!(server.requests(), [format!("/{selected}")]);
        assert_unchanged(&before);
        let manifest = read_snapshot_manifest(&fixture.metadata).unwrap().unwrap();
        assert_eq!(manifest.format, 2);
        assert_eq!(fixture.installed().selected_file.as_deref(), Some(selected));
        assert!(!fixture.root().join("alternative.safetensors").exists());
        assert!(!fixture.root().join("variants").exists());
    }
}

#[tokio::test]
async fn added_removed_and_same_size_changed_files_follow_content_identity() {
    let mut old = snapshot_blobs();
    old.push(Blob::new("generation_config.json", b"{\"old\":true}"));
    old.push(Blob::new("tokenizer_config.json", b"{\"v\":1}"));
    let fixture = Fixture::snapshot(&old);
    fs::write(fixture.root().join("notes.txt"), b"user notes").unwrap();
    let weight_before = FileState::read(&fixture.root().join("model.safetensors"));
    let mut next = snapshot_blobs();
    next.push(Blob::new("tokenizer_config.json", b"{\"v\":2}"));
    next.push(Blob::new("special_tokens_map.json", b"{}"));
    let cancel = AtomicBool::new(false);
    let plan = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    assert_eq!(
        changed_names(&plan),
        ["special_tokens_map.json", "tokenizer_config.json"]
    );
    assert_eq!(plan.removed.len(), 1);
    assert_eq!(
        plan.installed.files[plan.removed[0]].local,
        "generation_config.json"
    );
    let server = Loopback::start(&next).await;
    let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    let mut requests = server.requests();
    requests.sort_unstable();
    assert_eq!(
        requests,
        ["/special_tokens_map.json", "/tokenizer_config.json"]
    );
    assert_eq!(result.updated_files, 2);
    assert_eq!(result.removed_files, 1);
    assert!(!fixture.root().join("generation_config.json").exists());
    assert_eq!(
        fs::read(fixture.root().join("tokenizer_config.json")).unwrap(),
        b"{\"v\":2}"
    );
    assert_eq!(
        fs::read(fixture.root().join("special_tokens_map.json")).unwrap(),
        b"{}"
    );
    assert_eq!(
        fs::read(fixture.root().join("notes.txt")).unwrap(),
        b"user notes"
    );
    assert_eq!(
        FileState::read(&fixture.root().join("model.safetensors")),
        weight_before
    );
    let manifest = read_snapshot_manifest(&fixture.metadata).unwrap().unwrap();
    assert!(!manifest
        .files
        .iter()
        .any(|file| file.path == "generation_config.json"));
    assert!(manifest
        .files
        .iter()
        .any(|file| file.path == "special_tokens_map.json"));
}

#[tokio::test]
async fn cancellation_after_transfer_preserves_all_installed_bytes_and_manifest() {
    let old = snapshot_blobs();
    let fixture = Fixture::snapshot(&old);
    let before = fixture.state(&old);
    let mut next = old.clone();
    next[0] = Blob::new("config.json", NEW_CONFIG);
    next[1] = Blob::new("tokenizer.json", b"{\"updated\":true}");
    let cancel = AtomicBool::new(false);
    let plan = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    let server = Loopback::start(&next).await;
    let error = apply_plan(
        plan,
        &cancel,
        |_, received, _| {
            if received > 0 {
                cancel.store(true, Ordering::Release);
            }
        },
        &server.source,
    )
    .await
    .unwrap_err();
    assert_eq!(error, DOWNLOAD_CANCELLED);
    assert!(
        !server.requests().is_empty(),
        "cancellation must exercise a real transfer"
    );
    assert_unchanged(&before);
}

#[tokio::test]
async fn pre_cancelled_apply_makes_no_requests_and_preserves_installed_files() {
    let old = snapshot_blobs();
    let fixture = Fixture::snapshot(&old);
    let before = fixture.state(&old);
    let mut next = old.clone();
    next[0] = Blob::new("config.json", NEW_CONFIG);
    let cancel = AtomicBool::new(false);
    let plan = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    cancel.store(true, Ordering::Release);
    let server = Loopback::start(&next).await;
    assert_eq!(
        apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
            .await
            .unwrap_err(),
        DOWNLOAD_CANCELLED
    );
    assert!(server.requests().is_empty());
    assert_unchanged(&before);
}

#[tokio::test]
async fn interrupted_and_checksum_invalid_downloads_never_publish_staged_files() {
    for checksum_failure in [false, true] {
        let mut old = snapshot_blobs();
        old.push(Blob::new(
            "generation_config.json",
            b"{\"keep_until_commit\":true}",
        ));
        let fixture = Fixture::snapshot(&old);
        let before = fixture.state(&old);
        let mut next = snapshot_blobs();
        next[0] = Blob::new("config.json", NEW_CONFIG);
        next[1] = Blob::new("tokenizer.json", b"{\"updated\":true}");
        let cancel = AtomicBool::new(false);
        let plan = plan_update(
            fixture.installed(),
            &remote(&next, 'b'),
            &cancel,
            PlanMode::Apply,
        )
        .await
        .unwrap();
        let mut replies: HashMap<_, _> = next
            .iter()
            .map(|blob| (format!("/{}", blob.path), Reply::ok(&blob.bytes)))
            .collect();
        replies.insert(
            "/tokenizer.json".into(),
            if checksum_failure {
                Reply::ok(&vec![b'x'; next[1].bytes.len()])
            } else {
                Reply {
                    bytes: b"partial".to_vec(),
                    declared: next[1].bytes.len(),
                    status: 200,
                }
            },
        );
        let server = Loopback::replies(replies).await;
        assert!(apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
            .await
            .is_err());
        assert_eq!(server.requests(), ["/config.json", "/tokenizer.json"]);
        assert_unchanged(&before);
    }
}

#[tokio::test]
async fn local_same_length_edits_are_not_treated_as_upstream_changes() {
    let old = snapshot_blobs();
    let fixture = Fixture::snapshot(&old);
    fs::write(fixture.root().join("config.json"), NEW_CONFIG).unwrap();
    let before = fixture.state(&old);
    let cancel = AtomicBool::new(false);
    let result = plan_update(
        fixture.installed(),
        &remote(&old, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await;
    assert!(result.is_err());
    assert_unchanged(&before);
}

#[tokio::test]
async fn untracked_files_cannot_be_claimed_or_overwritten_by_an_update() {
    let old = snapshot_blobs();
    let fixture = Fixture::snapshot(&old);
    let collision = fixture.root().join("generation_config.json");
    fs::write(&collision, b"user owned configuration").unwrap();
    let collision_before = FileState::read(&collision);
    let before = fixture.state(&old);
    let mut next = old.clone();
    next.push(Blob::new("generation_config.json", b"{}"));
    assert!(plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &AtomicBool::new(false),
        PlanMode::Apply
    )
    .await
    .is_err());
    assert_eq!(FileState::read(&collision), collision_before);
    assert_unchanged(&before);
}

#[tokio::test]
async fn unsafe_remote_paths_cannot_escape_the_owned_snapshot() {
    let old = snapshot_blobs();
    let fixture = Fixture::snapshot(&old);
    let before = fixture.state(&old);
    let mut next = old.clone();
    next.push(Blob::new("../outside.json", b"{}"));
    assert!(plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &AtomicBool::new(false),
        PlanMode::Apply
    )
    .await
    .is_err());
    assert!(!fixture
        .model
        .parent()
        .unwrap()
        .join("outside.json")
        .exists());
    assert_unchanged(&before);
}

#[cfg(unix)]
#[tokio::test]
async fn tracked_symlinks_and_new_paths_through_symlink_directories_are_refused() {
    use std::os::unix::fs::symlink;
    for tracked in [false, true] {
        let old = snapshot_blobs();
        let fixture = Fixture::snapshot(&old);
        let outside = fixture.directory.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let external = outside.join("config.json");
        fs::write(&external, CONFIG).unwrap();
        let external_before = FileState::read(&external);
        let metadata_before = FileState::read(&fixture.metadata);
        let mut next = old.clone();
        if tracked {
            fs::remove_file(fixture.root().join("config.json")).unwrap();
            symlink(&external, fixture.root().join("config.json")).unwrap();
        } else {
            symlink(&outside, fixture.root().join("assets")).unwrap();
            next.push(Blob::new("assets/config.json", NEW_CONFIG));
        }
        assert!(plan_update(
            fixture.installed(),
            &remote(&next, 'b'),
            &AtomicBool::new(false),
            PlanMode::Apply
        )
        .await
        .is_err());
        assert_eq!(FileState::read(&external), external_before);
        assert_eq!(FileState::read(&fixture.metadata), metadata_before);
    }
}

#[tokio::test]
async fn changes_after_planning_are_preserved_instead_of_overwritten_at_commit() {
    for change in ["tracked", "manifest", "collision"] {
        let old = snapshot_blobs();
        let fixture = Fixture::snapshot(&old);
        let mut next = old.clone();
        next[0] = Blob::new("config.json", NEW_CONFIG);
        next.push(Blob::new("generation_config.json", b"{}"));
        let cancel = AtomicBool::new(false);
        let plan = plan_update(
            fixture.installed(),
            &remote(&next, 'b'),
            &cancel,
            PlanMode::Apply,
        )
        .await
        .unwrap();
        let collision = fixture.root().join("generation_config.json");
        match change {
            "tracked" => fs::write(
                fixture.root().join("config.json"),
                b"user edit after planning",
            )
            .unwrap(),
            "manifest" => {
                let mut bytes = fs::read(&fixture.metadata).unwrap();
                bytes.push(b'\n');
                fs::write(&fixture.metadata, bytes).unwrap();
            }
            "collision" => fs::write(&collision, b"user file after planning").unwrap(),
            _ => unreachable!(),
        }
        let before = fixture.state(&old);
        let collision_before = collision.exists().then(|| FileState::read(&collision));
        let server = Loopback::start(&next).await;
        assert!(
            apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
                .await
                .is_err(),
            "accepted {change} race"
        );
        assert_unchanged(&before);
        match collision_before {
            Some(before) => assert_eq!(FileState::read(&collision), before),
            None => assert!(!collision.exists()),
        }
    }
}

fn gguf_bytes(name: &str) -> Vec<u8> {
    use crate::gguf::fixture::{file, Value};
    file(
        &[
            ("general.architecture".into(), Value::Str("llama")),
            ("general.name".into(), Value::String(name.into())),
        ],
        &[("token_embd.weight".into(), vec![8], 32)],
    )
}

#[tokio::test]
async fn single_gguf_updates_only_the_proven_artifact_not_other_quantizations() {
    let old = vec![Blob::new("Q4/model.gguf", &gguf_bytes("old model"))];
    let fixture = Fixture::gguf(&old, "Q4/model.gguf", false, false);
    let neighbor = fixture.root().join("other.gguf");
    fs::write(&neighbor, b"untracked neighboring quantization").unwrap();
    let neighbor_before = FileState::read(&neighbor);
    let next = vec![
        Blob::new("Q4/model.gguf", &gguf_bytes("new model")),
        Blob::new("Q8/model.gguf", &gguf_bytes("other quantization")),
    ];
    let cancel = AtomicBool::new(false);
    let plan = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    assert_eq!(changed_names(&plan), ["model.gguf"]);
    let server = Loopback::start(&next).await;
    let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    assert_eq!(server.requests(), ["/Q4/model.gguf"]);
    assert_eq!(result.updated_files, 1);
    assert_eq!(fs::read(&fixture.model).unwrap(), next[0].bytes);
    assert_eq!(FileState::read(&neighbor), neighbor_before);
    let manifest: GgufManifest =
        serde_json::from_slice(&fs::read(&fixture.metadata).unwrap()).unwrap();
    assert_eq!(manifest.revision, "b".repeat(40));
    assert_eq!(manifest.files.len(), 1);
    assert_eq!(manifest.files[0].remote, "Q4/model.gguf");
    let before_repeat = fixture.state(&next[..1]);
    let installed = fixture.installed();
    assert_eq!(
        installed.revision.as_deref(),
        Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
    let repeat = plan_update(installed, &remote(&next, 'b'), &cancel, PlanMode::Apply)
        .await
        .unwrap();
    assert!(repeat.changed.is_empty());
    assert!(repeat.removed.is_empty());
    assert_eq!(repeat.download_bytes, 0);
    let result = apply_plan(repeat, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    assert_eq!(result.downloaded_bytes, 0);
    assert_eq!(server.requests(), ["/Q4/model.gguf"]);
    assert_unchanged(&before_repeat);
}

#[tokio::test]
async fn sharded_gguf_reuses_unchanged_shards_and_requests_only_the_changed_shard() {
    let old = vec![
        Blob::new("Q4/model-00001-of-00002.gguf", &gguf_bytes("first old")),
        Blob::new("Q4/model-00002-of-00002.gguf", &gguf_bytes("second old")),
    ];
    let fixture = Fixture::gguf(&old, &old[0].path, false, false);
    let first_before = FileState::read(&fixture.model);
    let mut next = old.clone();
    next[1] = Blob::new(&old[1].path, &gguf_bytes("second new"));
    let cancel = AtomicBool::new(false);
    let plan = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    assert_eq!(changed_names(&plan), ["model-00002-of-00002.gguf"]);
    let server = Loopback::start(&next).await;
    let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    assert_eq!(server.requests(), ["/Q4/model-00002-of-00002.gguf"]);
    assert_eq!(result.updated_files, 1);
    assert_eq!(FileState::read(&fixture.model), first_before);
    assert_eq!(
        fs::read(fixture.root().join("model-00002-of-00002.gguf")).unwrap(),
        next[1].bytes
    );
}

#[tokio::test]
async fn gguf_companion_updates_preserve_weights_and_keep_remote_to_local_mapping() {
    let old = vec![
        Blob::new("Q4/model.gguf", &gguf_bytes("stable model")),
        Blob::new("config.json", CONFIG),
        Blob::new("tokenizer.json", b"{}"),
        Blob::new("generation_config.json", b"{}"),
    ];
    let fixture = Fixture::gguf(&old, "Q4/model.gguf", true, false);
    let weight_before = FileState::read(&fixture.model);
    let next = vec![
        old[0].clone(),
        Blob::new("config.json", NEW_CONFIG),
        old[2].clone(),
        Blob::new("tokenizer_config.json", b"{}"),
        Blob::new("unrelated/config.json", b"{}"),
    ];
    let cancel = AtomicBool::new(false);
    let plan = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    assert_eq!(
        changed_names(&plan),
        ["config.json", "tokenizer_config.json"]
    );
    assert_eq!(plan.removed.len(), 1);
    let server = Loopback::start(&next).await;
    let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    let mut requests = server.requests();
    requests.sort_unstable();
    assert_eq!(requests, ["/config.json", "/tokenizer_config.json"]);
    assert_eq!(result.removed_files, 1);
    assert_eq!(FileState::read(&fixture.model), weight_before);
    assert_eq!(
        fs::read(fixture.root().join("config.json")).unwrap(),
        NEW_CONFIG
    );
    assert!(!fixture.root().join("generation_config.json").exists());
    let manifest: GgufManifest =
        serde_json::from_slice(&fs::read(&fixture.metadata).unwrap()).unwrap();
    assert!(manifest.companions);
    assert!(manifest
        .files
        .iter()
        .any(|file| file.remote == "config.json" && file.local == "config.json"));
    assert!(!manifest
        .files
        .iter()
        .any(|file| file.remote.starts_with("unrelated/")));
}

#[tokio::test]
async fn legacy_stamped_receipts_reuse_matching_bytes_without_claiming_neighbors() {
    for sharded in [false, true] {
        let paths: &[&str] = if sharded {
            &[
                "Q4/model-00001-of-00002.gguf",
                "Q4/model-00002-of-00002.gguf",
            ]
        } else {
            &["Q4/model.gguf"]
        };
        let old: Vec<_> = paths
            .iter()
            .map(|path| Blob::new(path, &gguf_bytes(path)))
            .collect();
        let fixture = Fixture::gguf(&old, paths[0], false, true);
        fs::write(
            fixture.root().join("config.json"),
            b"untracked legacy companion",
        )
        .unwrap();
        let before = fixture.state(&old);
        let installed = fixture.installed();
        assert!(installed.revision.is_none());
        assert_eq!(installed.files.len(), old.len());
        assert!(installed.files.iter().all(|file| file.oid.is_none()));
        let cancel = AtomicBool::new(false);
        let plan = plan_update(installed, &remote(&old, 'b'), &cancel, PlanMode::Apply)
            .await
            .unwrap();
        assert!(plan.changed.is_empty());
        assert!(plan.removed.is_empty());
        assert_eq!(plan.download_bytes, 0);
        assert_eq!(plan.files.len(), old.len());
        let server = Loopback::start(&[]).await;
        let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
            .await
            .unwrap();
        assert_eq!(result.downloaded_bytes, 0);
        assert!(server.requests().is_empty());
        assert_unchanged(&before);
        assert_eq!(
            fs::read(fixture.root().join("config.json")).unwrap(),
            b"untracked legacy companion"
        );
    }
}

#[test]
fn legacy_shards_require_a_still_valid_receipt_for_every_member() {
    let old = vec![
        Blob::new("Q4/model-00001-of-00002.gguf", &gguf_bytes("first")),
        Blob::new("Q4/model-00002-of-00002.gguf", &gguf_bytes("second")),
    ];
    let fixture = Fixture::gguf(&old, &old[0].path, false, true);
    fs::write(
        fixture.root().join("model-00002-of-00002.gguf"),
        b"locally replaced shard",
    )
    .unwrap();
    assert!(load_installed(
        fixture.model.to_str().unwrap(),
        fixture.library.to_str().unwrap(),
        Some(&fixture.receipts)
    )
    .is_err());
    assert!(!fixture.metadata.exists());
}

#[tokio::test]
async fn missing_gguf_entrypoints_and_incomplete_shard_sets_never_select_a_replacement() {
    for sharded in [false, true] {
        let old = if sharded {
            vec![
                Blob::new("Q4/model-00001-of-00002.gguf", &gguf_bytes("first")),
                Blob::new("Q4/model-00002-of-00002.gguf", &gguf_bytes("second")),
            ]
        } else {
            vec![Blob::new("Q4/model.gguf", &gguf_bytes("original"))]
        };
        let fixture = Fixture::gguf(&old, &old[0].path, false, false);
        let before = fixture.state(&old);
        let next = if sharded {
            vec![old[0].clone()]
        } else {
            vec![Blob::new("Q8/replacement.gguf", &gguf_bytes("replacement"))]
        };
        assert!(plan_update(
            fixture.installed(),
            &remote(&next, 'b'),
            &AtomicBool::new(false),
            PlanMode::Apply
        )
        .await
        .is_err());
        assert_unchanged(&before);
    }
}

#[tokio::test]
async fn legacy_update_checksum_failure_preserves_proven_bytes_and_absent_manifest() {
    let old = vec![Blob::new("Q4/model.gguf", &gguf_bytes("legacy old"))];
    let fixture = Fixture::gguf(&old, &old[0].path, false, true);
    let before = fixture.state(&old);
    let next = vec![Blob::new("Q4/model.gguf", &gguf_bytes("legacy new"))];
    let cancel = AtomicBool::new(false);
    let plan = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    assert_eq!(changed_names(&plan), ["model.gguf"]);
    let replies = HashMap::from([(
        "/Q4/model.gguf".into(),
        Reply::ok(&vec![b'x'; next[0].bytes.len()]),
    )]);
    let server = Loopback::replies(replies).await;
    assert!(apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .is_err());
    assert_eq!(server.requests(), ["/Q4/model.gguf"]);
    assert_unchanged(&before);
    assert!(!fixture.metadata.exists());
    assert!(crate::benchmark::download_receipt::read(&fixture.receipts, &fixture.model).is_some());
}

#[test]
fn activation_failure_after_backup_rolls_back_replacements_and_removals() {
    let mut old = snapshot_blobs();
    old.push(Blob::new("generation_config.json", b"{\"old\":true}"));
    let fixture = Fixture::snapshot(&old);
    let before = fixture.state(&old);
    let transaction = fixture.directory.join("commit");
    let backups = transaction.join("backup");
    fs::create_dir_all(&backups).unwrap();
    let replacement = transaction.join("new-config");
    fs::write(&replacement, NEW_CONFIG).unwrap();
    let missing_source = transaction.join("missing-tokenizer");
    let mut journal = Vec::new();

    commit_file(
        fixture.root().join("generation_config.json"),
        None,
        true,
        &backups,
        &mut journal,
    )
    .unwrap();
    commit_file(
        fixture.root().join("config.json"),
        Some(&replacement),
        true,
        &backups,
        &mut journal,
    )
    .unwrap();
    let error = commit_file(
        fixture.root().join("tokenizer.json"),
        Some(&missing_source),
        true,
        &backups,
        &mut journal,
    )
    .unwrap_err();
    assert!(error.contains("cannot activate"));
    assert_eq!(journal.len(), 3);
    assert!(!fixture.root().join("generation_config.json").exists());
    assert_eq!(
        fs::read(fixture.root().join("config.json")).unwrap(),
        NEW_CONFIG
    );
    assert!(!fixture.root().join("tokenizer.json").exists());
    let tokenizer_backup = journal[2].backup.as_ref().unwrap();
    assert_eq!(fs::read(tokenizer_backup).unwrap(), b"{}");

    rollback(&mut journal).unwrap();
    assert_unchanged(&before);
}

#[test]
fn failed_rollback_keeps_original_backup_and_never_overwrites_an_unexpected_file() {
    let old = snapshot_blobs();
    let fixture = Fixture::snapshot(&old);
    let metadata_before = FileState::read(&fixture.metadata);
    let target = fixture.root().join("config.json");
    let original = FileState::read(&target);
    let transaction = fixture.directory.join("commit");
    let backups = transaction.join("backup");
    fs::create_dir_all(&backups).unwrap();
    let missing_source = transaction.join("missing-config");
    let mut journal = Vec::new();

    assert!(commit_file(
        target.clone(),
        Some(&missing_source),
        true,
        &backups,
        &mut journal,
    )
    .is_err());
    assert!(
        !target.exists(),
        "activation must fail after backing up the old file"
    );
    let backup = journal[0].backup.clone().unwrap();
    assert_eq!(FileState::read(&backup), original);
    fs::write(&target, b"unexpected external file").unwrap();
    let unexpected = FileState::read(&target);

    let error = rollback(&mut journal).unwrap_err();
    assert!(error.contains("restore destination exists"));
    assert_eq!(FileState::read(&target), unexpected);
    assert_eq!(
        FileState::read(&backup),
        original,
        "the recoverable original must remain on disk"
    );
    assert_eq!(FileState::read(&fixture.metadata), metadata_before);
}

#[tokio::test]
async fn revision_or_readme_only_changes_never_download_or_rewrite_a_ready_snapshot() {
    for changed_readme in [false, true] {
        let old = snapshot_blobs();
        let fixture = Fixture::snapshot(&old);
        let readme = fixture.root().join("README.md");
        fs::write(&readme, b"local model card").unwrap();
        let readme_before = FileState::read(&readme);
        let before = fixture.state(&old);
        let mut next = old.clone();
        if changed_readme {
            next.push(Blob::new(
                "README.md",
                b"upstream changed only the model card",
            ));
        }
        let cancel = AtomicBool::new(false);
        let plan = plan_update(
            fixture.installed(),
            &remote(&next, 'b'),
            &cancel,
            PlanMode::Apply,
        )
        .await
        .unwrap();
        assert!(plan.changed.is_empty());
        assert!(plan.removed.is_empty());
        assert_eq!(plan.download_bytes, 0);
        assert_eq!(
            plan.reused_bytes,
            old.iter().map(|blob| blob.bytes.len() as u64).sum::<u64>()
        );
        let server = Loopback::start(&[]).await;
        let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
            .await
            .unwrap();
        assert_eq!(result.downloaded_bytes, 0);
        assert_eq!(result.updated_files, 0);
        assert_eq!(result.removed_files, 0);
        assert!(server.requests().is_empty());
        assert_unchanged(&before);
        assert_eq!(FileState::read(&readme), readme_before);
    }
}

#[test]
fn an_arbitrary_same_name_gguf_without_a_sidecar_or_stamped_receipt_is_not_owned() {
    let (directory, library, receipts) = Fixture::directory();
    let model = library
        .join("hf")
        .join(repo_directory(REPOSITORY))
        .join("Q4/model.gguf");
    fs::create_dir_all(model.parent().unwrap()).unwrap();
    fs::write(&model, gguf_bytes("unproven local model")).unwrap();
    let metadata = gguf_metadata(&model).unwrap();
    let fixture = Fixture {
        directory,
        library,
        receipts,
        model,
        metadata,
    };
    let before = FileState::read(&fixture.model);
    assert!(!fixture.metadata.exists());
    assert!(crate::benchmark::download_receipt::read(&fixture.receipts, &fixture.model).is_none());
    assert!(load_installed(
        fixture.model.to_str().unwrap(),
        fixture.library.to_str().unwrap(),
        Some(&fixture.receipts),
    )
    .is_err());
    assert_eq!(FileState::read(&fixture.model), before);
    assert!(!fixture.metadata.exists());
}

#[tokio::test]
async fn unchanged_json_moving_from_git_blob_to_sha256_identity_is_reused_without_download() {
    let old = snapshot_blobs();
    let fixture = Fixture::snapshot(&old);
    let before = fixture.state(&old);
    let mut latest = remote(&old, 'b');
    for (entry, blob) in latest.entries.iter_mut().zip(&old) {
        if blob.path.ends_with(".json") {
            assert_eq!(entry.oid.as_ref().unwrap().len(), 40);
            entry.oid = Some(format!("{:x}", Sha256::digest(&blob.bytes)));
        }
    }
    let cancel = AtomicBool::new(false);
    let plan = plan_update(fixture.installed(), &latest, &cancel, PlanMode::Apply)
        .await
        .unwrap();
    assert!(plan.changed.is_empty());
    assert!(plan.removed.is_empty());
    assert_eq!(plan.download_bytes, 0);
    assert_eq!(
        plan.reused_bytes,
        old.iter().map(|blob| blob.bytes.len() as u64).sum::<u64>()
    );
    let server = Loopback::start(&[]).await;
    let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    assert_eq!(result.downloaded_bytes, 0);
    assert!(server.requests().is_empty());
    assert_unchanged(&before);
}

#[test]
fn rollback_preserves_user_edits_or_replacements_of_an_activated_file_and_keeps_original_backup() {
    for replaced in [false, true] {
        let old = snapshot_blobs();
        let fixture = Fixture::snapshot(&old);
        let target = fixture.root().join("config.json");
        let original = FileState::read(&target);
        let metadata_before = FileState::read(&fixture.metadata);
        let transaction = fixture.directory.join("commit");
        let backups = transaction.join("backup");
        fs::create_dir_all(&backups).unwrap();
        let replacement = transaction.join("new-config");
        fs::write(&replacement, NEW_CONFIG).unwrap();
        let mut journal = Vec::new();
        commit_file(
            target.clone(),
            Some(&replacement),
            true,
            &backups,
            &mut journal,
        )
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), NEW_CONFIG);
        let backup = journal[0].backup.clone().unwrap();
        assert_eq!(FileState::read(&backup), original);

        if replaced {
            fs::remove_file(&target).unwrap();
        }
        fs::write(&target, b"user edits after activation must survive").unwrap();
        let user_file = FileState::read(&target);
        assert!(
            rollback(&mut journal).is_err(),
            "accepted user mutation after activation"
        );
        assert_eq!(FileState::read(&target), user_file);
        assert_eq!(FileState::read(&backup), original);
        assert_eq!(FileState::read(&fixture.metadata), metadata_before);
    }
}

#[tokio::test]
async fn adding_companions_to_downloaded_gguf_keeps_weights_and_ownership_on_plain_retry() {
    let old = vec![Blob::new("Q4/model.gguf", &gguf_bytes("stable model"))];
    let fixture = Fixture::gguf(&old, &old[0].path, false, false);
    let weights_before = FileState::read(&fixture.model);
    let mut complete = old.clone();
    complete.push(Blob::new("config.json", CONFIG));
    complete.push(Blob::new("tokenizer.json", b"{}"));
    for blob in &complete[1..] {
        fs::write(fixture.root().join(&blob.path), &blob.bytes).unwrap();
    }
    let source = remote(&complete, 'a');
    let files = listed_gguf_files(REPOSITORY, &source.revision, &source.entries).unwrap();
    let companions = snapshots::gguf_companion_plan(&source.entries, &old[0].path).unwrap();
    let cancel = AtomicBool::new(false);
    record_gguf_manifest(
        &fixture.model,
        REPOSITORY,
        &source.revision,
        &files,
        Some(&companions),
        &cancel,
    )
    .await
    .unwrap();
    let ownership = fs::read(&fixture.metadata).unwrap();
    record_gguf_manifest(
        &fixture.model,
        REPOSITORY,
        &"b".repeat(40),
        &files,
        None,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(fs::read(&fixture.metadata).unwrap(), ownership);
    assert_eq!(FileState::read(&fixture.model), weights_before);
    complete[1] = Blob::new("config.json", NEW_CONFIG);
    let update = plan_update(
        fixture.installed(),
        &remote(&complete, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    assert_eq!(changed_names(&update), ["config.json"]);
}

#[tokio::test]
async fn gguf_companions_already_updated_by_another_model_are_adopted_without_transfer() {
    let old = vec![
        Blob::new("Q4/model.gguf", &gguf_bytes("stable model")),
        Blob::new("config.json", CONFIG),
        Blob::new("tokenizer.json", b"{}"),
    ];
    let fixture = Fixture::gguf(&old, &old[0].path, true, false);
    // Other quantizations in this folder share these verified loading assets.
    let published_config =
        br#"{"model_type":"llama","architectures":["LlamaForCausalLM"],"v":2000}"#;
    fs::write(fixture.root().join("config.json"), published_config).unwrap();
    let before = fixture.state(&old);
    let mut next = old.clone();
    next[1] = Blob::new("config.json", published_config);
    let cancel = AtomicBool::new(false);
    let check = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Check,
    )
    .await
    .unwrap();
    assert_eq!(changed_names(&check), ["config.json"]);
    let plan = plan_update(
        fixture.installed(),
        &remote(&next, 'b'),
        &cancel,
        PlanMode::Apply,
    )
    .await
    .unwrap();
    let server = Loopback::start(&next).await;
    let result = apply_plan(plan, &cancel, |_, _, _| {}, &server.source)
        .await
        .unwrap();
    assert_eq!(result.downloaded_bytes, 0);
    assert!(server.requests.lock().unwrap().is_empty());
    for (path, state) in &before {
        if path != &fixture.metadata {
            assert_eq!(&FileState::read(path), state);
        }
    }
    let installed = fixture.installed();
    assert_eq!(
        installed.revision.as_deref(),
        Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
    let repeat = plan_update(installed, &remote(&next, 'b'), &cancel, PlanMode::Check)
        .await
        .unwrap();
    assert!(repeat.changed.is_empty());
    assert!(repeat.removed.is_empty());
}
