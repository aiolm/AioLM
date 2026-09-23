//! Conversations as files people can read, in the data folder.
//!
//! Each conversation is a folder under `conversations` holding `thread.json`.
//! Its images are written next to it in `attachments`, named by content hash,
//! instead of as base64 inside the JSON. The frontend owns the conversation
//! format and its limits; this store moves images in and out of files, keeps
//! every write atomic, and never deletes a file it cannot read.
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const FORMAT_VERSION: u64 = 1;
const THREAD_FILE: &str = "thread.json";
const ATTACHMENTS: &str = "attachments";
/// Far above what the chat keeps; a larger file was not written by AioLM.
const MAX_THREAD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
static STORE: Mutex<()> = Mutex::new(());

pub(crate) fn root() -> Result<PathBuf, String> {
    crate::home::resolve_aiolm_home().map(|home| home.join("conversations"))
}

#[derive(Serialize)]
pub(crate) struct Loaded {
    pub threads: Vec<Value>,
    /// Folders that were skipped and left untouched, with the reason.
    pub warnings: Vec<String>,
}

/// The file format. Fields are written in reading order; fields a later
/// frontend adds are kept as they are.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredThread {
    #[serde(default)]
    version: u64,
    id: String,
    #[serde(default)]
    title: Value,
    #[serde(default)]
    system_prompt: Value,
    #[serde(default)]
    created_at: Value,
    #[serde(default)]
    updated_at: Value,
    #[serde(default)]
    messages: Vec<Value>,
    #[serde(flatten)]
    rest: Map<String, Value>,
}

fn lock() -> MutexGuard<'static, ()> {
    STORE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Every conversation folder that can be read. A folder that cannot be read is
/// reported and left as it is, so a damaged or newer file is never replaced.
pub(crate) fn load(root: &Path) -> Result<Loaded, String> {
    let _guard = lock();
    let mut loaded = Loaded {
        threads: Vec::new(),
        warnings: Vec::new(),
    };
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(loaded),
        Err(error) => return Err(format!("cannot read {}: {error}", root.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("cannot read {}: {error}", root.display()))?;
        // `file_type` does not follow links, so a linked folder is skipped.
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        match read_thread(&entry.path()) {
            Ok(Some(thread)) if folder_name(&thread.id) == name => {
                loaded
                    .threads
                    .push(serde_json::to_value(thread).map_err(|error| error.to_string())?);
            }
            Ok(Some(_)) => loaded.warnings.push(format!(
                "{name}: the folder name does not match the conversation id"
            )),
            // A folder whose first write never finished holds no conversation.
            Ok(None) => {}
            Err(error) => loaded.warnings.push(format!("{name}: {error}")),
        }
    }
    Ok(loaded)
}

fn read_thread(folder: &Path) -> Result<Option<StoredThread>, String> {
    let bytes = match read_bounded(&folder.join(THREAD_FILE), MAX_THREAD_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut thread: StoredThread = serde_json::from_slice(&bytes)
        .map_err(|error| format!("not a conversation file: {error}"))?;
    if thread.version > FORMAT_VERSION {
        return Err(format!(
            "written by a newer AioLM (format {})",
            thread.version
        ));
    }
    restore_images(&mut thread.messages, folder);
    Ok(Some(thread))
}

pub(crate) fn save(root: &Path, thread: Value) -> Result<(), String> {
    let _guard = lock();
    save_unlocked(root, thread)
}

fn save_unlocked(root: &Path, thread: Value) -> Result<(), String> {
    let mut thread: StoredThread =
        serde_json::from_value(thread).map_err(|error| format!("invalid conversation: {error}"))?;
    if thread.id.is_empty() {
        return Err("a conversation needs an id".into());
    }
    thread.version = FORMAT_VERSION;
    let folder = root.join(folder_name(&thread.id));
    let attachments = folder.join(ATTACHMENTS);
    let mut kept = HashSet::new();
    store_images(&mut thread.messages, &attachments, &mut kept)?;
    let bytes = serde_json::to_vec_pretty(&thread).map_err(|error| error.to_string())?;
    // Images are in place before the file that refers to them.
    crate::config::atomic_write(&folder.join(THREAD_FILE), &bytes)?;
    remove_unreferenced(&attachments, &kept);
    Ok(())
}

/// Writes conversations that are not stored yet and leaves every stored one
/// alone, so bringing over an earlier copy never overwrites newer data.
pub(crate) fn import(root: &Path, threads: Vec<Value>) -> Result<usize, String> {
    let _guard = lock();
    let mut imported = 0;
    for thread in threads {
        let id = thread
            .get("id")
            .and_then(Value::as_str)
            .ok_or("a conversation needs an id")?
            .to_owned();
        if root.join(folder_name(&id)).join(THREAD_FILE).exists() {
            continue;
        }
        save_unlocked(root, thread)?;
        imported += 1;
    }
    Ok(imported)
}

pub(crate) fn delete(root: &Path, id: &str) -> Result<(), String> {
    let _guard = lock();
    remove_folder(&root.join(folder_name(id)))
}

/// Removes every conversation, including folders that could not be read.
pub(crate) fn clear(root: &Path) -> Result<(), String> {
    let _guard = lock();
    remove_folder(root)
}

fn remove_folder(folder: &Path) -> Result<(), String> {
    // `remove_dir_all` removes a link itself, never what it points to.
    match fs::remove_dir_all(folder) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot delete {}: {error}", folder.display())),
    }
}

/// A conversation's folder: its id when that is a plain lowercase name, and
/// otherwise a hash of it, so no id can reach outside `conversations`, name a
/// Windows device, or differ from another id only by case.
fn folder_name(id: &str) -> String {
    let plain = !id.is_empty()
        && id.len() <= 128
        && !id.starts_with("h-")
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
        && !is_device_name(id);
    if plain {
        id.to_owned()
    } else {
        format!("h-{}", &hex(&Sha256::digest(id.as_bytes()))[..32])
    }
}

fn is_device_name(name: &str) -> bool {
    matches!(name, "con" | "prn" | "aux" | "nul")
        || (name.len() == 4
            && (name.starts_with("com") || name.starts_with("lpt"))
            && name.as_bytes()[3].is_ascii_digit())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn store_images(
    messages: &mut [Value],
    attachments: &Path,
    kept: &mut HashSet<String>,
) -> Result<(), String> {
    for image in messages.iter_mut().flat_map(images_mut) {
        let Some(object) = image.as_object_mut() else {
            continue;
        };
        let Some((media_type, bytes)) = object
            .get("dataUrl")
            .and_then(Value::as_str)
            .and_then(decode_data_url)
        else {
            // An image that was too large to keep has an empty data URL.
            continue;
        };
        let name = format!(
            "{}.{}",
            hex(&Sha256::digest(&bytes)),
            extension(&media_type)
        );
        let path = attachments.join(&name);
        if !path.is_file() {
            crate::config::atomic_write(&path, &bytes)?;
        }
        object.remove("dataUrl");
        object.insert(
            "file".into(),
            Value::String(format!("{ATTACHMENTS}/{name}")),
        );
        object.insert("mediaType".into(), Value::String(media_type));
        kept.insert(name);
    }
    Ok(())
}

fn restore_images(messages: &mut [Value], folder: &Path) {
    for image in messages.iter_mut().flat_map(images_mut) {
        let Some(object) = image.as_object_mut() else {
            continue;
        };
        let Some(file) = object.remove("file") else {
            continue;
        };
        let media_type = object.remove("mediaType");
        let data_url = match (
            file.as_str().and_then(attachment_name),
            media_type
                .as_ref()
                .and_then(Value::as_str)
                .filter(|value| valid_media_type(value)),
        ) {
            (Some(name), Some(media_type)) => {
                read_bounded(&folder.join(ATTACHMENTS).join(name), MAX_IMAGE_BYTES)
                    .map(|bytes| format!("data:{media_type};base64,{}", STANDARD.encode(bytes)))
                    .unwrap_or_default()
            }
            // A missing or unusable image shows as one that was not kept.
            _ => String::new(),
        };
        object.insert("dataUrl".into(), Value::String(data_url));
    }
}

fn images_mut(message: &mut Value) -> impl Iterator<Item = &mut Value> {
    message
        .get_mut("images")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
}

fn decode_data_url(value: &str) -> Option<(String, Vec<u8>)> {
    let (media_type, payload) = value.strip_prefix("data:")?.split_once(";base64,")?;
    let media_type = media_type.to_ascii_lowercase();
    if !valid_media_type(&media_type) {
        return None;
    }
    let bytes = STANDARD.decode(payload).ok()?;
    (!bytes.is_empty()).then_some((media_type, bytes))
}

fn valid_media_type(value: &str) -> bool {
    value.strip_prefix("image/").is_some_and(|subtype| {
        !subtype.is_empty()
            && subtype.len() <= 64
            && subtype
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
    })
}

fn extension(media_type: &str) -> &'static str {
    match media_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

/// `attachments/<sha256>.<extension>` only, so a stored name never leads
/// outside its conversation folder.
fn attachment_name(file: &str) -> Option<&str> {
    let name = file.strip_prefix("attachments/")?;
    let (hash, extension) = name.split_once('.')?;
    let lower_hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    (hash.len() == 64
        && hash.bytes().all(lower_hex)
        && (1..=8).contains(&extension.len())
        && extension
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()))
    .then_some(name)
}

fn remove_unreferenced(attachments: &Path, kept: &HashSet<String>) {
    let Ok(entries) = fs::read_dir(attachments) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !kept.contains(&name) && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
    if kept.is_empty() {
        let _ = fs::remove_dir(attachments);
    }
}

fn read_bounded(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::other(format!(
            "{} is larger than {limit} bytes",
            path.display()
        )));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("aiolm-conversations-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn png(bytes: &[u8]) -> String {
        format!("data:image/png;base64,{}", STANDARD.encode(bytes))
    }

    fn thread(id: &str, messages: Value) -> Value {
        json!({
            "id": id,
            "title": "Trip",
            "systemPrompt": "",
            "createdAt": 1,
            "updatedAt": 2,
            "messages": messages,
        })
    }

    fn stored(root: &Path, id: &str) -> Value {
        serde_json::from_slice(&fs::read(root.join(folder_name(id)).join(THREAD_FILE)).unwrap())
            .unwrap()
    }

    #[test]
    fn a_conversation_is_readable_json_with_images_as_files() {
        let root = fixture();
        let messages = json!([
            {"role": "user", "content": "Where?", "images": [{"name": "map.png", "dataUrl": png(b"map")}]},
            {"role": "assistant", "content": "Here.", "model": "m.gguf"}
        ]);
        save(&root, thread("thread-1", messages.clone())).unwrap();

        let file = stored(&root, "thread-1");
        assert_eq!(file["version"], 1);
        assert_eq!(file["messages"][1]["content"], "Here.");
        let image = &file["messages"][0]["images"][0];
        assert!(image.get("dataUrl").is_none());
        assert_eq!(image["mediaType"], "image/png");
        let path = root.join("thread-1").join(image["file"].as_str().unwrap());
        assert_eq!(fs::read(path).unwrap(), b"map");

        let loaded = load(&root).unwrap();
        assert!(loaded.warnings.is_empty());
        assert_eq!(loaded.threads.len(), 1);
        assert_eq!(loaded.threads[0]["messages"], messages);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn images_no_longer_referenced_are_removed_and_dropped_images_stay_empty() {
        let root = fixture();
        let first = json!([{"role": "user", "content": "a", "images": [{"name": "a.png", "dataUrl": png(b"a")}]}]);
        save(&root, thread("thread-1", first)).unwrap();
        let second = json!([{"role": "user", "content": "a", "images": [{"name": "b.png", "dataUrl": png(b"b")}, {"name": "big.png", "dataUrl": ""}]}]);
        save(&root, thread("thread-1", second.clone())).unwrap();

        let attachments = root.join("thread-1").join(ATTACHMENTS);
        assert_eq!(fs::read_dir(&attachments).unwrap().count(), 1);
        assert_eq!(load(&root).unwrap().threads[0]["messages"], second);

        save(&root, thread("thread-1", json!([]))).unwrap();
        assert!(!attachments.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ids_that_are_not_plain_names_are_hashed_into_the_folder() {
        for id in [
            "../escape",
            "C:\\temp",
            "Thread-A",
            "con",
            "com1",
            "h-abc",
            "",
        ] {
            let name = folder_name(id);
            assert!(name.starts_with("h-") && name.len() == 34, "{id} -> {name}");
        }
        assert_eq!(folder_name("thread-1727081234567"), "thread-1727081234567");
        assert_eq!(folder_name("thread-1-2"), "thread-1-2");
        assert_ne!(folder_name("Thread-A"), folder_name("thread-a"));
    }

    #[test]
    fn unreadable_newer_and_misplaced_files_are_reported_and_kept() {
        let root = fixture();
        save(&root, thread("thread-1", json!([]))).unwrap();
        fs::create_dir_all(root.join("thread-2")).unwrap();
        fs::write(root.join("thread-2").join(THREAD_FILE), "{not json").unwrap();
        fs::create_dir_all(root.join("thread-3")).unwrap();
        fs::write(
            root.join("thread-3").join(THREAD_FILE),
            json!({"version": 2, "id": "thread-3"}).to_string(),
        )
        .unwrap();
        fs::create_dir_all(root.join("copy")).unwrap();
        fs::copy(
            root.join("thread-1").join(THREAD_FILE),
            root.join("copy").join(THREAD_FILE),
        )
        .unwrap();
        fs::create_dir_all(root.join("interrupted")).unwrap();

        let loaded = load(&root).unwrap();
        assert_eq!(loaded.threads.len(), 1);
        assert_eq!(loaded.warnings.len(), 3, "{:?}", loaded.warnings);
        assert!(root.join("thread-2").join(THREAD_FILE).exists());
        assert!(root.join("thread-3").join(THREAD_FILE).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_stored_file_name_cannot_lead_outside_its_folder() {
        assert!(attachment_name(&format!("attachments/{}.png", "a".repeat(64))).is_some());
        for file in [
            "../thread.json".to_string(),
            format!("attachments/../{}.png", "a".repeat(64)),
            format!("attachments/{}.png", "A".repeat(64)),
            format!("attachments/{}/x.png", "a".repeat(64)),
            "attachments/short.png".to_string(),
        ] {
            assert!(attachment_name(&file).is_none(), "{file}");
        }
    }

    #[test]
    fn import_keeps_stored_conversations_and_delete_and_clear_remove_folders() {
        let root = fixture();
        save(
            &root,
            thread("thread-1", json!([{"role": "user", "content": "new"}])),
        )
        .unwrap();
        let imported = import(
            &root,
            vec![
                thread("thread-1", json!([{"role": "user", "content": "old"}])),
                thread(
                    "thread-2",
                    json!([{"role": "user", "content": "only here"}]),
                ),
            ],
        )
        .unwrap();
        assert_eq!(imported, 1);
        assert_eq!(stored(&root, "thread-1")["messages"][0]["content"], "new");
        assert_eq!(
            stored(&root, "thread-2")["messages"][0]["content"],
            "only here"
        );

        delete(&root, "thread-1").unwrap();
        assert!(!root.join("thread-1").exists());
        delete(&root, "thread-1").unwrap();
        clear(&root).unwrap();
        assert!(!root.exists());
        assert!(load(&root).unwrap().threads.is_empty());
    }

    #[test]
    fn fields_a_later_frontend_adds_are_kept() {
        let root = fixture();
        let mut value = thread("thread-1", json!([]));
        value["pinned"] = json!(true);
        save(&root, value).unwrap();
        assert_eq!(load(&root).unwrap().threads[0]["pinned"], true);
        fs::remove_dir_all(root).unwrap();
    }
}
