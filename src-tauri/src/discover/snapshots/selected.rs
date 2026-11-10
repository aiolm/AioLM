//! Resolve one Safetensors model without pulling alternative weight variants.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}
fn name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or_default()
}
fn joined(folder: &str, file: &str) -> String {
    if folder.is_empty() {
        file.into()
    } else {
        format!("{folder}/{file}")
    }
}

/// Standard split names select the entire group and always identify part one.
fn shards(path: &str) -> Result<Option<Vec<String>>, String> {
    let Some(stem) = path.strip_suffix(".safetensors") else {
        return Ok(None);
    };
    let Some((prefix, count)) = stem.rsplit_once("-of-") else {
        return Ok(None);
    };
    let Some((base, index)) = prefix.rsplit_once('-') else {
        return Ok(None);
    };
    if index.len() != 5
        || count.len() != 5
        || !index
            .bytes()
            .chain(count.bytes())
            .all(|byte| byte.is_ascii_digit())
    {
        return Ok(None);
    }
    let index: usize = index.parse().map_err(|_| "invalid selected weight shard")?;
    let count: usize = count.parse().map_err(|_| "invalid selected shard count")?;
    if index == 0 || index > count || count > MAX_TREE_ENTRIES {
        return Err("invalid selected shard count".into());
    }
    Ok(Some(
        (1..=count)
            .map(|part| format!("{base}-{part:05}-of-{count:05}.safetensors"))
            .collect(),
    ))
}

fn scope<'a>(entries: &'a [ApiTreeEntry], selected: &str) -> Result<&'a str, String> {
    let mut folder = parent(selected);
    loop {
        if let Some(config) = entries
            .iter()
            .find(|entry| entry.entry_type == "file" && entry.path == joined(folder, "config.json"))
        {
            return Ok(parent(&config.path));
        }
        if folder.is_empty() {
            return Err("selected weights have no model configuration".into());
        }
        folder = parent(folder);
    }
}

fn index_candidates<'a>(
    entries: &'a [ApiTreeEntry],
    selected: &str,
) -> Result<Vec<&'a ApiTreeEntry>, String> {
    safe_data_file(selected)?;
    if !selected.ends_with(".safetensors")
        || entries
            .iter()
            .filter(|entry| entry.entry_type == "file" && entry.path == selected)
            .count()
            != 1
    {
        return Err("selected Safetensors path is missing or ambiguous in the repository".into());
    }
    scope(entries, selected)?;
    let indices = entries
        .iter()
        .filter(|entry| {
            entry.entry_type == "file"
                && parent(&entry.path) == parent(selected)
                && entry.path.ends_with(".safetensors.index.json")
        })
        .collect::<Vec<_>>();
    if indices.len() > 64 {
        return Err("selected model has too many weight indices".into());
    }
    Ok(indices)
}

/// Loading metadata is fetched at the same immutable revision as the weights.
/// A malformed or oversized relevant index is never replaced by a whole model.
async fn read_indices(
    repo: &str,
    revision: &str,
    entries: &[ApiTreeEntry],
    selected: &str,
    cancel: &AtomicBool,
) -> Result<BTreeMap<String, serde_json::Value>, String> {
    let candidates = index_candidates(entries, selected)?;
    let mut total = 0u64;
    let mut indices = BTreeMap::new();
    for entry in candidates {
        safe_data_file(&entry.path)?;
        total = total
            .checked_add(entry.size)
            .ok_or("selected index size overflow")?;
        if total > MAX_SNAPSHOT_MANIFEST_BYTES {
            return Err("selected weight indices exceed metadata limit".into());
        }
        let response = tokio::select! {
            _ = wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
            response = client()?.get(download_url_at(repo, &entry.path, revision)).send() => response.map_err(|error| error.to_string())?
        };
        validate_response_url(&response)?;
        if !response.status().is_success() {
            return Err(format!(
                "weight index {}: HTTP {}",
                entry.path,
                response.status()
            ));
        }
        let bytes = tokio::select! {
            _ = wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
            bytes = bounded_response_bytes(response, entry.size as usize) => bytes?
        };
        if bytes.len() as u64 != entry.size {
            return Err("selected weight index is truncated".into());
        }
        if let Some(oid) = entry
            .lfs
            .as_ref()
            .and_then(|lfs| lfs.oid.as_deref())
            .or(entry.oid.as_deref())
        {
            let mut digest = FileDigest::new(oid, entry.size)?;
            digest.update(&bytes);
            if !digest.matches() {
                return Err("selected weight index checksum mismatch".into());
            }
        }
        let value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid selected weight index: {error}"))?;
        indices.insert(entry.path.clone(), value);
    }
    Ok(indices)
}

pub(in crate::discover) async fn selected_snapshot_plan(
    repo: &str,
    revision: &str,
    entries: &[ApiTreeEntry],
    selected: &str,
    cancel: &AtomicBool,
) -> Result<(String, Vec<SnapshotFile>), String> {
    if cancel.load(Ordering::Acquire) {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    let indices = read_indices(repo, revision, entries, selected, cancel).await?;
    let (canonical, mut files) = plan(entries, selected, &indices)?;
    // Only filename normalization needs a remote namespace check. Existing
    // model-prefixed HF/MLX layouts keep their identity and are checked locally
    // before readiness is published.
    let mut native = false;
    let mut metadata_remaining = MAX_SNAPSHOT_MANIFEST_BYTES;
    for file in files.iter().filter(|file| {
        file.path.ends_with(".safetensors") && file.path != name(file.repository_path())
    }) {
        native |=
            native_weight_header(repo, revision, file, cancel, &mut metadata_remaining).await?;
    }
    if native {
        preserve_weight_names(&mut files)?;
    }
    if cancel.load(Ordering::Acquire) {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    Ok((canonical, files))
}

/// A server ignoring Range must be rejected before consuming its weight body.
/// Exact Content-Range binds both bounded reads to the immutable tree's size.
async fn range_response_bytes(
    response: reqwest::Response,
    start: u64,
    length: usize,
    size: u64,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::Acquire) {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    let end = start
        .checked_add(length as u64)
        .and_then(|end| end.checked_sub(1))
        .ok_or("invalid Safetensors header range")?;
    let expected = format!("bytes {start}-{end}/{size}");
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT
        || response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            != Some(expected.as_str())
    {
        return Err("selected Safetensors inspection requires an exact bounded byte range".into());
    }
    let bytes = tokio::select! {
        _ = wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
        bytes = bounded_response_bytes(response, length) => bytes?
    };
    if bytes.len() != length {
        return Err("selected Safetensors header range is truncated".into());
    }
    Ok(bytes)
}

async fn weight_range(
    repo: &str,
    revision: &str,
    file: &SnapshotFile,
    start: u64,
    length: usize,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::Acquire) {
        return Err(DOWNLOAD_CANCELLED.into());
    }
    let end = start
        .checked_add(length as u64)
        .and_then(|end| end.checked_sub(1))
        .ok_or("invalid Safetensors header range")?;
    let response = tokio::select! {
        _ = wait_cancelled(cancel) => return Err(DOWNLOAD_CANCELLED.into()),
        response = client()?.get(download_url_at(repo, file.repository_path(), revision))
            .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send() => response.map_err(|error| error.to_string())?
    };
    validate_response_url(&response)?;
    range_response_bytes(response, start, length, file.size, cancel).await
}

async fn native_weight_header(
    repo: &str,
    revision: &str,
    file: &SnapshotFile,
    cancel: &AtomicBool,
    metadata_remaining: &mut u64,
) -> Result<bool, String> {
    use crate::providers::artifacts::{inspect_safetensors_metadata, safetensors_header_length};
    *metadata_remaining = metadata_remaining
        .checked_sub(8)
        .ok_or("selected tensor headers exceed the metadata limit")?;
    let prefix = weight_range(repo, revision, file, 0, 8, cancel).await?;
    let length = safetensors_header_length(prefix.try_into().unwrap(), file.size)?;
    *metadata_remaining = metadata_remaining
        .checked_sub(length as u64)
        .ok_or("selected tensor headers exceed the metadata limit")?;
    let header = weight_range(repo, revision, file, 8, length, cancel).await?;
    inspect_safetensors_metadata(&header, file.size, None)
}

fn preserve_weight_names(files: &mut [SnapshotFile]) -> Result<(), String> {
    let mut names = BTreeSet::new();
    for file in files {
        if file.path.ends_with(".safetensors") {
            let remote = file.repository_path().to_owned();
            file.path = name(&remote).to_owned();
            file.remote_path = (file.path != remote).then_some(remote);
        }
        if !names.insert(file.path.to_ascii_lowercase()) {
            return Err("selected native snapshot has colliding file paths".into());
        }
    }
    Ok(())
}

fn plan(
    entries: &[ApiTreeEntry],
    selected: &str,
    indices: &BTreeMap<String, serde_json::Value>,
) -> Result<(String, Vec<SnapshotFile>), String> {
    index_candidates(entries, selected)?;
    let scope = scope(entries, selected)?;
    let folder = parent(selected);
    let mut tree_files = std::collections::HashMap::with_capacity(entries.len());
    for entry in entries.iter().filter(|entry| entry.entry_type == "file") {
        if tree_files.insert(entry.path.as_str(), entry).is_some() {
            return Err("repository tree has duplicate file paths".into());
        }
    }
    let standard = shards(selected)?;
    let is_split = standard.is_some();
    let required: BTreeSet<String> = standard.map_or_else(
        || [selected.to_owned()].into_iter().collect(),
        |parts| parts.into_iter().collect(),
    );
    let mut chosen_index = None;
    let required_names: std::collections::HashSet<&str> =
        required.iter().map(|path| name(path)).collect();
    let mut chosen_weights = None;
    for (path, value) in indices {
        let map = value
            .get("weight_map")
            .and_then(serde_json::Value::as_object)
            .ok_or("selected weight index has invalid weight_map")?;
        if map.is_empty() {
            return Err("selected weight index has empty weight_map".into());
        }
        // Establish membership using borrowed basenames before validating
        // dependencies. Another model's nested paths do not constrain this
        // selection, while every dependency of a relevant index stays strict.
        if !map
            .values()
            .filter_map(serde_json::Value::as_str)
            .any(|file| required_names.contains(file))
        {
            continue;
        }
        let mut indexed = BTreeSet::new();
        for value in map.values() {
            let file = value
                .as_str()
                .ok_or("selected weight index has non-string weight path")?;
            safe_data_file(file)?;
            if file.contains('/') || !file.ends_with(".safetensors") {
                return Err("selected weight index has unsupported weight path".into());
            }
            indexed.insert(joined(folder, file));
        }
        if chosen_index.is_some() {
            return Err("selected weights belong to multiple ambiguous indices".into());
        }
        if is_split && indexed != required {
            return Err("selected weight index disagrees with its split shard group".into());
        }
        chosen_weights = Some(indexed);
        chosen_index = Some(path.as_str());
    }
    drop(required_names);
    let required = chosen_weights.unwrap_or(required);
    let canonical = required
        .first()
        .ok_or("selected snapshot has no weight members")?
        .clone();
    // An indexed group must keep its exact shard names: rewriting upstream
    // weight_map values would manufacture a different model. MLX's standard
    // loader discovers model*.safetensors, so other indexed bindings are unsafe.
    if chosen_index.is_some() && required.iter().any(|path| !name(path).starts_with("model")) {
        return Err("indexed weights require standard model-prefixed shard filenames".into());
    }
    let mut files = Vec::new();
    let mut local_names = BTreeSet::new();
    let mut remote_names = BTreeSet::new();
    let mut add = |entry: &ApiTreeEntry, local: String| -> Result<(), String> {
        safe_data_file(&entry.path)?;
        safe_data_file(&local)?;
        if entry.size > MAX_MODEL_BYTES {
            return Err("snapshot file exceeds the model size limit".into());
        }
        if !local_names.insert(local.to_ascii_lowercase())
            || !remote_names.insert(entry.path.to_ascii_lowercase())
        {
            return Err("selected snapshot has colliding file paths".into());
        }
        files.push(SnapshotFile {
            remote_path: (local != entry.path).then(|| entry.path.clone()),
            path: local,
            size: entry.size,
            oid: entry
                .lfs
                .as_ref()
                .and_then(|value| value.oid.clone())
                .or_else(|| entry.oid.clone()),
        });
        Ok(())
    };
    for (part, path) in required.iter().enumerate() {
        let entry = tree_files
            .get(path.as_str())
            .copied()
            .ok_or_else(|| format!("selected snapshot is missing weight shard: {path}"))?;
        let local = if chosen_index.is_some() {
            name(path).into()
        } else if is_split {
            format!("model-{:05}-of-{:05}.safetensors", part + 1, required.len())
        } else {
            "model.safetensors".into()
        };
        add(entry, local)?;
    }
    if let Some(index) = chosen_index {
        let entry = tree_files
            .get(index)
            .copied()
            .ok_or("selected weight index is not in the repository")?;
        add(entry, "model.safetensors.index.json".into())?;
    }
    // Only immediate loading assets of this model's configuration scope are
    // shared. Another model folder or alternative weight index is not an asset.
    for entry in entries.iter().filter(|entry| {
        entry.entry_type == "file"
            && parent(&entry.path) == scope
            && accepted(&entry.path)
            && !entry.path.ends_with(".safetensors")
            && !entry.path.ends_with(".safetensors.index.json")
    }) {
        add(entry, name(&entry.path).into())?;
    }
    validate_loading_files(&files)?;
    Ok((canonical, files))
}

/// Persisted source bindings are bounded, unique and stay in the selected
/// model's scope. Whole snapshots retain their original identity-only mapping.
pub(super) fn validate_selection(manifest: &SnapshotManifest) -> Result<(), String> {
    let Some(selected) = manifest.selected_file.as_deref() else {
        if manifest.files.iter().any(|file| file.remote_path.is_some()) {
            return Err("whole snapshot has selected-file mappings".into());
        }
        return Ok(());
    };
    safe_data_file(selected)?;
    let standard = shards(selected)?;
    if !selected.ends_with(".safetensors")
        || standard.as_ref().is_some_and(|parts| parts[0] != selected)
    {
        return Err("snapshot selection is not a canonical weight entrypoint".into());
    }
    let config = manifest
        .files
        .iter()
        .find(|file| file.path == "config.json")
        .ok_or("selected snapshot has no configuration binding")?;
    let config_scope = parent(config.remote_path.as_deref().unwrap_or(&config.path));
    let folder = parent(selected);
    if !config_scope.is_empty()
        && folder != config_scope
        && !folder
            .strip_prefix(config_scope)
            .is_some_and(|rest| rest.starts_with('/'))
    {
        return Err("snapshot selection leaves its configuration scope".into());
    }
    let indexed = manifest
        .files
        .iter()
        .any(|file| file.path == "model.safetensors.index.json");
    let mut remote_names = BTreeSet::new();
    let mut found = false;
    for file in &manifest.files {
        let remote = file.remote_path.as_deref().unwrap_or(&file.path);
        safe_data_file(&file.path)?;
        safe_data_file(remote)?;
        if !remote_names.insert(remote.to_ascii_lowercase()) {
            return Err("snapshot has duplicate remote bindings".into());
        }
        found |= remote == selected;
        let valid = if remote.ends_with(".safetensors") {
            parent(remote) == folder
                && if indexed {
                    file.path == name(remote) && name(remote).starts_with("model")
                } else if let Some(parts) = &standard {
                    parts
                        .binary_search_by(|part| part.as_str().cmp(remote))
                        .is_ok_and(|part| {
                            file.path == name(remote)
                                || file.path
                                    == format!(
                                        "model-{:05}-of-{:05}.safetensors",
                                        part + 1,
                                        parts.len()
                                    )
                        })
                } else {
                    remote == selected
                        && (file.path == "model.safetensors" || file.path == name(remote))
                }
        } else if remote.ends_with(".safetensors.index.json") {
            indexed && parent(remote) == folder && file.path == "model.safetensors.index.json"
        } else {
            parent(remote) == config_scope && file.path == name(remote) && accepted(remote)
        };
        if !valid {
            return Err("snapshot has an invalid selected-model source binding".into());
        }
    }
    if !found {
        return Err("snapshot manifest is missing its selected weight entrypoint".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tree(paths: &[&str]) -> Vec<ApiTreeEntry> {
        paths
            .iter()
            .map(|path| {
                serde_json::from_value(serde_json::json!({"path":path,"size":2,"type":"file"}))
                    .unwrap()
            })
            .collect()
    }
    #[test]
    fn selected_alternative_installs_only_its_weights_and_loading_assets() {
        let entries = tree(&[
            "config.json",
            "tokenizer.json",
            "fp16.safetensors",
            "q4.safetensors",
            "other/config.json",
            "other/model.safetensors",
        ]);
        let (selected, files) = plan(&entries, "q4.safetensors", &BTreeMap::new()).unwrap();
        assert_eq!(selected, "q4.safetensors");
        assert_eq!(
            files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["model.safetensors", "config.json", "tokenizer.json"]
        );
        assert_eq!(files[0].remote_path.as_deref(), Some("q4.safetensors"));
    }
    #[test]
    fn unrelated_index_paths_do_not_block_an_independent_selected_model() {
        let entries = tree(&[
            "config.json",
            "tokenizer.json",
            "standalone.safetensors",
            "other.safetensors.index.json",
            "other/model.safetensors",
        ]);
        let mut indices = BTreeMap::from([(
            "other.safetensors.index.json".into(),
            serde_json::json!({"weight_map":{"other":"other/model.safetensors"}}),
        )]);
        let (selected, files) = plan(&entries, "standalone.safetensors", &indices).unwrap();
        assert_eq!(selected, "standalone.safetensors");
        assert_eq!(
            files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["model.safetensors", "config.json", "tokenizer.json"]
        );
        assert_eq!(
            files[0].remote_path.as_deref(),
            Some("standalone.safetensors")
        );
        indices.insert(
            "other.safetensors.index.json".into(),
            serde_json::json!({"weight_map":{
                "selected":"standalone.safetensors",
                "other":"other/model.safetensors"
            }}),
        );
        assert!(plan(&entries, "standalone.safetensors", &indices).is_err());
    }

    #[test]
    fn nested_split_selection_keeps_index_contents_and_exact_sources() {
        let entries = tree(&[
            "q4/config.json",
            "q4/tokenizer.json",
            "q4/model-00001-of-00002.safetensors",
            "q4/model-00002-of-00002.safetensors",
            "q4/model.safetensors.index.json",
            "fp16/model.safetensors",
        ]);
        let indices = [("q4/model.safetensors.index.json".into(), serde_json::json!({"weight_map":{"a":"model-00001-of-00002.safetensors","b":"model-00002-of-00002.safetensors"}}))].into_iter().collect();
        let (selected, files) =
            plan(&entries, "q4/model-00002-of-00002.safetensors", &indices).unwrap();
        assert_eq!(selected, "q4/model-00001-of-00002.safetensors");
        assert_eq!(files.len(), 5);
        assert!(files
            .iter()
            .all(|file| file.remote_path.as_deref().unwrap().starts_with("q4/")));
        assert_eq!(files[2].path, "model.safetensors.index.json");
    }
    #[test]
    fn unindexed_split_normalizes_loader_names_and_keeps_root_loading_scope() {
        let entries = tree(&[
            "config.json",
            "tokenizer.json",
            "q4/weights-00001-of-00002.safetensors",
            "q4/weights-00002-of-00002.safetensors",
            "fp16/model.safetensors",
        ]);
        let (selected, files) = plan(
            &entries,
            "q4/weights-00002-of-00002.safetensors",
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(selected, "q4/weights-00001-of-00002.safetensors");
        assert_eq!(files[0].path, "model-00001-of-00002.safetensors");
        assert_eq!(files[1].path, "model-00002-of-00002.safetensors");
        assert_eq!(
            files[0].remote_path.as_deref(),
            Some("q4/weights-00001-of-00002.safetensors")
        );
        assert_eq!(files.len(), 4);
    }
    #[test]
    fn indexed_selection_excludes_independent_indices_and_rejects_ambiguous_membership() {
        let entries = tree(&[
            "config.json",
            "tokenizer.json",
            "model-a.safetensors",
            "model-b.safetensors",
            "model-c.safetensors",
            "first.safetensors.index.json",
            "other.safetensors.index.json",
        ]);
        let mut indices: BTreeMap<String, serde_json::Value> = [
            ("first.safetensors.index.json".into(), serde_json::json!({"weight_map":{"a":"model-a.safetensors","b":"model-b.safetensors"}})),
            ("other.safetensors.index.json".into(), serde_json::json!({"weight_map":{"c":"model-c.safetensors"}})),
        ].into_iter().collect();
        let (selected, files) = plan(&entries, "model-b.safetensors", &indices).unwrap();
        assert_eq!(selected, "model-a.safetensors");
        assert_eq!(files.len(), 5);
        assert!(!files.iter().any(|file| file.path == "model-c.safetensors"));
        assert_eq!(
            files[2].remote_path.as_deref(),
            Some("first.safetensors.index.json")
        );
        let (alternate, alternate_files) = plan(&entries, "model-a.safetensors", &indices).unwrap();
        assert_eq!(alternate, selected);
        assert_eq!(alternate_files, files);
        indices.insert(
            "other.safetensors.index.json".into(),
            serde_json::json!({"weight_map":{"b":"model-b.safetensors","c":"model-c.safetensors"}}),
        );
        assert!(plan(&entries, "model-b.safetensors", &indices).is_err());
    }
    #[test]
    fn missing_shards_and_disagreeing_indices_do_not_select_another_variant() {
        let entries = tree(&[
            "config.json",
            "tokenizer.json",
            "model-00001-of-00002.safetensors",
            "alternative.safetensors",
            "model.safetensors.index.json",
        ]);
        assert!(plan(
            &entries,
            "model-00001-of-00002.safetensors",
            &BTreeMap::new()
        )
        .is_err());
        let indices = [("model.safetensors.index.json".into(), serde_json::json!({"weight_map":{"a":"model-00001-of-00002.safetensors","b":"alternative.safetensors"}}))].into_iter().collect();
        assert!(plan(&entries, "model-00001-of-00002.safetensors", &indices).is_err());
        assert!(plan(
            &tree(&["config.json", "model.safetensors"]),
            "model.safetensors",
            &BTreeMap::new()
        )
        .is_err());
    }

    fn weights() -> Vec<u8> {
        named_weights("weight")
    }

    fn named_weights(tensor: &str) -> Vec<u8> {
        let mut header = serde_json::to_vec(&serde_json::json!({
            (tensor): {"dtype":"F32", "shape":[1], "data_offsets":[0,4]}
        }))
        .unwrap();
        header.resize(header.len().div_ceil(8) * 8, b' ');
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        bytes.extend([0u8; 4]);
        bytes
    }

    async fn range_reply(headers: &str, body: &[u8]) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut reply = headers.as_bytes().to_vec();
        reply.extend_from_slice(body);
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let mut received = 0;
            while !request[..received]
                .windows(4)
                .any(|bytes| bytes == b"\r\n\r\n")
            {
                let count = socket.read(&mut request[received..]).await.unwrap();
                assert_ne!(
                    count, 0,
                    "HTTP request headers ended before their terminator"
                );
                received += count;
            }
            socket.write_all(&reply).await.unwrap();
        });
        reqwest::get(format!("http://{address}/weight"))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn header_inspection_requires_bounded_ranges_and_honors_cancellation() {
        let cancel = AtomicBool::new(false);
        let response = range_reply(
            "HTTP/1.1 200 OK\r\nContent-Length: 1000000000000\r\n\r\n",
            b"",
        )
        .await;
        assert!(range_response_bytes(response, 0, 8, 1000000000000, &cancel)
            .await
            .unwrap_err()
            .contains("byte range"));
        let response = range_reply("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-7/100\r\nContent-Length: 8\r\n\r\n", b"12345678").await;
        assert_eq!(
            range_response_bytes(response, 0, 8, 100, &cancel)
                .await
                .unwrap(),
            b"12345678"
        );
        let response = range_reply("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-7/101\r\nContent-Length: 8\r\n\r\n", b"12345678").await;
        assert!(range_response_bytes(response, 0, 8, 100, &cancel)
            .await
            .is_err());
        let response = range_reply("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-7/100\r\nContent-Length: 9\r\n\r\n", b"123456789").await;
        assert!(range_response_bytes(response, 0, 8, 100, &cancel)
            .await
            .is_err());
        let response = range_reply("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-7/100\r\nContent-Length: 8\r\n\r\n", b"12345678").await;
        cancel.store(true, Ordering::Release);
        assert_eq!(
            range_response_bytes(response, 0, 8, 100, &cancel)
                .await
                .unwrap_err(),
            DOWNLOAD_CANCELLED
        );
    }

    #[tokio::test]
    async fn native_selected_archive_keeps_source_identity_and_completes_without_hf_loadability() {
        use crate::providers::artifacts::{inspect_safetensors_metadata, ArtifactFormat};
        let root = std::env::temp_dir().join(format!("aiolm-native-selected-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let blobs = [
            ("config.json", br#"{"model_type":"mistral"}"#.to_vec()),
            ("tokenizer.json", b"{}".to_vec()),
            ("params.json", br#"{"dim":1,"n_layers":1}"#.to_vec()),
            (
                "variant/any-name.safetensors",
                named_weights("tok_embeddings.weight"),
            ),
            (
                "variant/hf-alternative.safetensors",
                named_weights("model.embed_tokens.weight"),
            ),
        ];
        let entries = blobs
            .iter()
            .map(|(path, bytes)| {
                serde_json::from_value(serde_json::json!({
                    "type":"file", "path":path, "size":bytes.len(),
                    "oid":format!("{:x}", Sha256::digest(bytes))
                }))
                .unwrap()
            })
            .collect::<Vec<_>>();
        let (selected, mut files) = plan(&entries, blobs[3].0, &BTreeMap::new()).unwrap();
        let bytes = &blobs[3].1;
        let length = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize;
        assert!(
            inspect_safetensors_metadata(&bytes[8..8 + length], bytes.len() as u64, None).unwrap()
        );
        preserve_weight_names(&mut files).unwrap();
        assert_eq!(files[0].path, "any-name.safetensors");
        assert_eq!(files[0].repository_path(), blobs[3].0);
        assert!(!files
            .iter()
            .any(|file| file.repository_path() == blobs[4].0));
        for file in &files {
            let bytes = &blobs
                .iter()
                .find(|(path, _)| *path == file.repository_path())
                .unwrap()
                .1;
            fs::write(root.join(&file.path), bytes).unwrap();
        }
        let mut manifest = SnapshotManifest {
            format: 2,
            repository: "owner/model".into(),
            revision: "a".repeat(40),
            selected_file: Some(selected),
            files,
            complete: false,
        };
        let artifact = download_snapshot_files(
            &root,
            &mut manifest,
            None,
            &AtomicBool::new(false),
            |_, _, _, _| {},
        )
        .await
        .unwrap();
        assert!(artifact.ready_files(), "{artifact:?}");
        assert!(manifest.complete);
        assert_eq!(artifact.format, ArtifactFormat::Unknown);
        assert_eq!(artifact.name, "model · variant/any-name.safetensors");
        assert_eq!(
            fs::read(root.join("any-name.safetensors")).unwrap(),
            blobs[3].1
        );
        assert_eq!(fs::read(root.join("params.json")).unwrap(), blobs[2].1);
        assert!(!root.join("model.safetensors").exists());
        assert!(!crate::providers::compat::assess(
            &artifact,
            crate::providers::ProviderId::MlxVlm,
            None
        )
        .loadable());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn hf_and_mlx_standalone_alternatives_share_config_without_becoming_native() {
        use crate::providers::artifacts::{inspect_safetensors_metadata, ArtifactFormat};
        for (config, tensor, expected) in [
            (
                br#"{"model_type":"mistral"}"#.as_slice(),
                "model.embed_tokens.weight",
                ArtifactFormat::HfSafetensors,
            ),
            (
                br#"{"model_type":"mistral","quantization":{"bits":4,"group_size":32}}"#.as_slice(),
                "model.layers.0.self_attn.q_proj.scales",
                ArtifactFormat::Mlx,
            ),
        ] {
            let root =
                std::env::temp_dir().join(format!("aiolm-hf-alternative-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let blobs = [
                ("config.json", config.to_vec()),
                ("tokenizer.json", b"{}".to_vec()),
                ("params.json", br#"{"dim":1}"#.to_vec()),
                ("consolidated.safetensors", named_weights(tensor)),
                (
                    "another-valid-alternative.safetensors",
                    named_weights(tensor),
                ),
            ];
            let entries = blobs
                .iter()
                .map(|(path, bytes)| {
                    serde_json::from_value(serde_json::json!({
                        "type":"file", "path":path, "size":bytes.len(),
                        "oid":format!("{:x}", Sha256::digest(bytes))
                    }))
                    .unwrap()
                })
                .collect::<Vec<_>>();
            let (selected, files) = plan(&entries, blobs[3].0, &BTreeMap::new()).unwrap();
            let bytes = &blobs[3].1;
            let length = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize;
            assert!(
                !inspect_safetensors_metadata(&bytes[8..8 + length], bytes.len() as u64, None)
                    .unwrap()
            );
            assert_eq!(files[0].path, "model.safetensors");
            assert_eq!(
                files
                    .iter()
                    .filter(|file| file.path.ends_with(".safetensors"))
                    .count(),
                1
            );
            for file in &files {
                let bytes = &blobs
                    .iter()
                    .find(|(path, _)| *path == file.repository_path())
                    .unwrap()
                    .1;
                fs::write(root.join(&file.path), bytes).unwrap();
            }
            let mut manifest = SnapshotManifest {
                format: 2,
                repository: "owner/model".into(),
                revision: "a".repeat(40),
                selected_file: Some(selected),
                files,
                complete: false,
            };
            let artifact = download_snapshot_files(
                &root,
                &mut manifest,
                None,
                &AtomicBool::new(false),
                |_, _, _, _| {},
            )
            .await
            .unwrap();
            assert!(artifact.ready_files(), "{artifact:?}");
            assert_eq!(artifact.format, expected);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn indexed_members_retry_an_older_selection_in_its_original_directory() {
        let root = std::env::temp_dir().join(format!("aiolm-indexed-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let blobs = [
            (
                "q4/config.json",
                br#"{"model_type":"llama","architectures":["LlamaForCausalLM"]}"#.to_vec(),
            ),
            ("q4/tokenizer.json", b"{}".to_vec()),
            ("q4/model-a.safetensors", named_weights("a")),
            ("q4/model-b.safetensors", named_weights("b")),
            (
                "q4/model.safetensors.index.json",
                br#"{"weight_map":{"a":"model-a.safetensors","b":"model-b.safetensors"}}"#.to_vec(),
            ),
        ];
        let entries = blobs
            .iter()
            .map(|(path, bytes)| {
                serde_json::from_value(
                    serde_json::json!({"type":"file", "path":path, "size":bytes.len(),
                "oid":format!("{:x}", Sha256::digest(bytes))}),
                )
                .unwrap()
            })
            .collect::<Vec<ApiTreeEntry>>();
        let indices = [(
            blobs[4].0.into(),
            serde_json::from_slice(&blobs[4].1).unwrap(),
        )]
        .into_iter()
        .collect();
        let revision = "a".repeat(40);
        // This is the namespace older versions created after clicking member b.
        let original =
            snapshot_directory(&root, "owner/model", &revision, Some(blobs[3].0)).unwrap();
        let (canonical, files) = plan(&entries, blobs[3].0, &indices).unwrap();
        assert_eq!(canonical, blobs[2].0);
        fs::create_dir_all(&original).unwrap();
        for file in &files {
            let bytes = &blobs
                .iter()
                .find(|(path, _)| *path == file.repository_path())
                .unwrap()
                .1;
            fs::write(original.join(&file.path), bytes).unwrap();
        }
        let mut manifest = SnapshotManifest {
            format: 2,
            repository: "owner/model".into(),
            revision: revision.clone(),
            selected_file: Some(blobs[3].0.into()),
            files,
            complete: false,
        };
        fs::write(
            original.join(SNAPSHOT_MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        for member in [blobs[2].0, blobs[3].0] {
            let (selected, files) = plan(&entries, member, &indices).unwrap();
            let directory =
                snapshot_directory(&root, "owner/model", &revision, Some(&selected)).unwrap();
            assert_eq!(directory, original);
            manifest.selected_file = Some(selected);
            manifest.files = files;
            manifest.complete = false;
            let installed = download_snapshot_files(
                &directory,
                &mut manifest,
                None,
                &AtomicBool::new(false),
                |_, _, _, _| {},
            )
            .await
            .unwrap();
            assert!(installed.ready_files(), "{installed:?}");
            assert_eq!(installed.path, original.to_string_lossy());
            assert_eq!(installed.selected_file.as_deref(), Some(blobs[2].0));
            assert_eq!(
                installed.selected_weight_files.as_ref().unwrap(),
                &[blobs[2].0, blobs[3].0]
            );
            assert_eq!(
                installed_snapshots(root.to_str().unwrap(), "owner/model")
                    .unwrap()
                    .len(),
                1
            );
        }
        assert_eq!(
            read_snapshot_manifest(&original.join(SNAPSHOT_MANIFEST))
                .unwrap()
                .unwrap()
                .selected_file
                .as_deref(),
            Some(blobs[2].0)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn selected_install_retry_cancellation_and_corruption_keep_scope_isolated() {
        let root = std::env::temp_dir().join(format!("aiolm-selected-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let blobs = [
            (
                "variants/q4/config.json",
                br#"{"model_type":"llama","architectures":["LlamaForCausalLM"]}"#.to_vec(),
            ),
            ("variants/q4/tokenizer.json", b"{}".to_vec()),
            ("variants/q4/weights.safetensors", weights()),
            ("variants/q4/alternative.safetensors", weights()),
        ];
        let entries: Vec<ApiTreeEntry> = blobs
            .iter()
            .map(|(path, bytes)| {
                serde_json::from_value(serde_json::json!({
                    "type":"file", "path":path, "size":bytes.len(),
                    "oid":format!("{:x}", Sha256::digest(bytes))
                }))
                .unwrap()
            })
            .collect();
        let revision = "a".repeat(40);
        let (selected, files) = plan(&entries, blobs[2].0, &BTreeMap::new()).unwrap();
        let directory =
            snapshot_directory(&root, "owner/model", &revision, Some(&selected)).unwrap();
        let whole = snapshot_directory(&root, "owner/model", &revision, None).unwrap();
        let other = snapshot_directory(&root, "owner/model", &revision, Some(blobs[3].0)).unwrap();
        assert_ne!(directory, whole);
        assert_ne!(directory, other);
        fs::create_dir_all(&directory).unwrap();
        for file in &files {
            let remote = file.remote_path.as_deref().unwrap_or(&file.path);
            let bytes = &blobs.iter().find(|(path, _)| *path == remote).unwrap().1;
            fs::write(directory.join(&file.path), bytes).unwrap();
        }
        let mut manifest = SnapshotManifest {
            format: 2,
            repository: "owner/model".into(),
            revision: revision.clone(),
            selected_file: Some(selected.clone()),
            files,
            complete: false,
        };
        let artifact = download_snapshot_files(
            &directory,
            &mut manifest,
            None,
            &AtomicBool::new(false),
            |_, _, _, _| {},
        )
        .await
        .unwrap();
        assert!(artifact.ready_files(), "{artifact:?}");
        assert_eq!(artifact.selected_file.as_deref(), Some(selected.as_str()));
        let installed = installed_snapshots(root.to_str().unwrap(), "owner/model").unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].selected_file, artifact.selected_file);
        assert_eq!(
            snapshot_directory(&root, "owner/model", &revision, Some(&selected)).unwrap(),
            directory
        );
        assert_eq!(
            snapshot_directory(&root, "owner/model", &revision, None).unwrap(),
            whole
        );

        manifest.complete = false;
        let before = fs::read(directory.join(SNAPSHOT_MANIFEST)).unwrap();
        let cancel = AtomicBool::new(false);
        let error =
            download_snapshot_files(&directory, &mut manifest, None, &cancel, |file, _, _, _| {
                if file == "model.safetensors" {
                    cancel.store(true, Ordering::Release);
                }
            })
            .await
            .unwrap_err();
        assert_eq!(error, DOWNLOAD_CANCELLED);
        assert_eq!(fs::read(directory.join(SNAPSHOT_MANIFEST)).unwrap(), before);
        assert!(
            installed_snapshots(root.to_str().unwrap(), "owner/model").unwrap()[0].ready_files()
        );

        let weight = directory.join("model.safetensors");
        let mut changed = fs::read(&weight).unwrap();
        *changed.last_mut().unwrap() = 1;
        fs::write(&weight, &changed).unwrap();
        let error = download_snapshot_files(
            &directory,
            &mut manifest,
            None,
            &AtomicBool::new(false),
            |_, _, _, _| {},
        )
        .await
        .unwrap_err();
        assert!(error.contains("failed verification"), "{error}");
        let installed = installed_snapshots(root.to_str().unwrap(), "owner/model").unwrap();
        assert!(!installed[0].ready_files());
        assert_eq!(
            installed[0].selected_file.as_deref(),
            Some(selected.as_str())
        );
        assert_eq!(fs::read(&weight).unwrap(), changed);
        assert!(!whole.join(SNAPSHOT_MANIFEST).exists());
        assert!(!other.join(SNAPSHOT_MANIFEST).exists());
        // In-place updates change the manifest revision, never the selected
        // directory identity; a later incomplete retry must retain that path.
        manifest.revision = "b".repeat(40);
        fs::write(
            directory.join(SNAPSHOT_MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert_eq!(
            snapshot_directory(&root, "owner/model", &manifest.revision, Some(&selected)).unwrap(),
            directory
        );
        fs::remove_dir_all(root).unwrap();
    }
}
