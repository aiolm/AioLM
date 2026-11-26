//! One naming rule for every model label the app shows, advertises or records.
//!
//! A model's label drops the local directory, Windows verbatim prefixes, the
//! 40-hex snapshot revision directory and the split-file part suffix
//! (`-00001-of-00004` or `-0001-of-0004`), but keeps the `.gguf` or
//! `.safetensors` extension. Storage, loading, deletion and provenance keep the
//! original path; only presentation and advertised identifiers use these
//! helpers. The TypeScript twin lives in `src/shared/lib/displayPaths.ts`.
use std::path::Path;

/// A recognised split-file name. `width` is the digit count of the part number
/// so sibling parts are rebuilt with the width the repository actually used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShardParts<'a> {
    pub base: &'a str,
    pub index: usize,
    pub total: usize,
    pub width: usize,
    pub extension: Option<&'a str>,
}

impl ShardParts<'_> {
    /// The file name of one part of this split set.
    pub fn format_part(&self, part: usize) -> String {
        let width = self.width;
        let total = self.total;
        match self.extension {
            Some(ext) => format!("{}-{part:0width$}-of-{total:0width$}.{ext}", self.base),
            None => format!("{}-{part:0width$}-of-{total:0width$}", self.base),
        }
    }

    /// The name of the whole split model: the base without its part suffix.
    pub fn grouped_name(&self) -> String {
        match self.extension {
            Some(ext) => format!("{}.{ext}", self.base),
            None => self.base.to_owned(),
        }
    }
}

fn split_extension(value: &str) -> (&str, Option<&str>) {
    if let Some((stem, ext)) = value.rsplit_once('.') {
        if ext.eq_ignore_ascii_case("gguf") || ext.eq_ignore_ascii_case("safetensors") {
            return (stem, Some(ext));
        }
    }
    (value, None)
}

/// Recognise the split-file syntax without checking the part numbers' range.
/// Part and total must have the same zero-padded width of four or five digits,
/// so ordinary names such as `model-1-of-4` are never mistaken for shards.
pub fn parse_shard_raw(value: &str) -> Option<ShardParts<'_>> {
    let (stem, extension) = split_extension(value);
    let (prefix, total_text) = stem.rsplit_once("-of-")?;
    let (base, index_text) = prefix.rsplit_once('-')?;
    if base.is_empty()
        || base.ends_with(['/', '\\'])
        || index_text.len() != total_text.len()
        || !(4..=5).contains(&index_text.len())
        || !index_text
            .bytes()
            .chain(total_text.bytes())
            .all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some(ShardParts {
        base,
        index: index_text.parse().ok()?,
        total: total_text.parse().ok()?,
        width: index_text.len(),
        extension,
    })
}

fn in_range(parts: &ShardParts<'_>) -> bool {
    parts.total > 1 && parts.index > 0 && parts.index <= parts.total
}

/// A split-file name whose part number fits its total.
pub fn parse_shard(value: &str) -> Option<ShardParts<'_>> {
    parse_shard_raw(value).filter(in_range)
}

/// A split GGUF file name (`.gguf`, any case).
pub fn parse_gguf_shard(value: &str) -> Option<ShardParts<'_>> {
    parse_shard(value).filter(|parts| {
        parts
            .extension
            .is_some_and(|ext| ext.eq_ignore_ascii_case("gguf"))
    })
}

/// Split Safetensors syntax with its exact lowercase extension; callers decide
/// how to report an out-of-range part.
pub fn parse_safetensors_shard_raw(value: &str) -> Option<ShardParts<'_>> {
    if !value.ends_with(".safetensors") {
        return None;
    }
    parse_shard_raw(value)
}

/// A split Safetensors file name whose part number fits its total.
pub fn parse_safetensors_shard(value: &str) -> Option<ShardParts<'_>> {
    parse_safetensors_shard_raw(value).filter(in_range)
}

fn has_url_scheme(value: &str) -> bool {
    let mut chars = value.chars();
    if !chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
    {
        return false;
    }
    for ch in chars {
        if ch == ':' {
            return true;
        }
        if !(ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// Explicit path syntax only. Bare relative strings and namespaced model IDs
/// stay intact, and a file extension does not make a string a local path.
pub fn is_explicit_path(value: &str) -> bool {
    let path = crate::verbatim_path::strip_windows_verbatim_prefix_str(value.trim());
    if path.is_empty() {
        return false;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        return true;
    }
    if path.starts_with(['/', '\\'])
        || ["~/", "~\\", "./", ".\\", "../", "..\\"]
            .iter()
            .any(|prefix| path.starts_with(prefix))
    {
        return true;
    }
    if path
        .get(..7)
        .is_some_and(|head| head.eq_ignore_ascii_case("file://"))
    {
        return true;
    }
    !has_url_scheme(&path) && path.contains('\\')
}

/// Drop a valid part suffix, keeping the folder prefix and the extension.
pub fn strip_shard_suffix(value: &str) -> String {
    parse_shard(value).map_or_else(|| value.to_owned(), |parts| parts.grouped_name())
}

/// The model part of an `owner/model` repository id.
pub fn repository_display_name(repository: &str) -> Option<String> {
    let component = |part: &str| {
        !part.is_empty()
            && part.len() <= 128
            && part.starts_with(|first: char| first.is_ascii_alphanumeric())
            && !part.contains("..")
            && part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch))
    };
    let (owner, model) = repository.split_once('/')?;
    (component(owner) && component(model)).then(|| model.to_owned())
}

/// The repository name of an immutable snapshot path: HF cache
/// (`models--owner--name/snapshots/<revision>`) or the app library
/// (`hf/owner/name/snapshots/<revision>`).
pub fn snapshot_name_from_path(value: &str) -> Option<String> {
    let path = crate::verbatim_path::strip_windows_verbatim_prefix_str(value.trim());
    let parts: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect();
    let len = parts.len();
    if len < 3 || parts[len - 2] != "snapshots" {
        return None;
    }
    let revision = parts[len - 1];
    if revision.len() != 40 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let repository = parts[len - 3];
    if let Some(encoded) = repository.strip_prefix("models--") {
        let owner_end = encoded.find("--")?;
        return (owner_end > 0 && owner_end + 2 < encoded.len())
            .then(|| encoded[owner_end + 2..].to_owned());
    }
    (len >= 5 && parts[len - 5] == "hf" && !parts[len - 4].is_empty() && !repository.is_empty())
        .then(|| repository.to_owned())
}

/// Label for a stored model path or ID without touching the filesystem.
pub fn display_name(value: &str) -> String {
    let cleaned = crate::verbatim_path::strip_windows_verbatim_prefix_str(value.trim());
    if cleaned.is_empty() {
        return String::new();
    }
    if let Some(snapshot) = snapshot_name_from_path(&cleaned) {
        return strip_shard_suffix(&snapshot);
    }
    // A selected snapshot label (`repo · variant/model.safetensors`) is already
    // a label; its `/` belongs to the variant, not to a directory.
    if !is_explicit_path(&cleaned) && cleaned.contains(" · ") && !cleaned.contains('\\') {
        return strip_shard_suffix(&cleaned);
    }
    let segment = cleaned
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("");
    strip_shard_suffix(segment)
}

/// `display_name`, plus the declared or selected title of a snapshot directory
/// that only exists on disk. Reads small metadata files, never weights.
pub fn resolve_display_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path = Path::new(trimmed);
    if path.is_dir() {
        if let Some(label) = crate::providers::artifacts::snapshot_display_name(path) {
            if label.selected || crate::providers::artifacts::has_opaque_snapshot_name(path) {
                let candidate = strip_shard_suffix(label.name.trim());
                if !candidate.is_empty() {
                    return candidate;
                }
            }
        }
    }
    display_name(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aiolm-names-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn four_and_five_digit_parts_are_grouped_with_their_extension() {
        for (name, expected) in [
            ("model-00001-of-00004.gguf", "model.gguf"),
            ("model-0001-of-0004.gguf", "model.gguf"),
            ("model-0004-of-0004.GGUF", "model.GGUF"),
            ("model-0002-of-0004.safetensors", "model.safetensors"),
            ("Qwen3.8-Flash-0001-of-0004", "Qwen3.8-Flash"),
            ("Q4/model-00001-of-00002.gguf", "Q4/model.gguf"),
            (
                "variants · 4bit/model-0001-of-0004.safetensors",
                "variants · 4bit/model.safetensors",
            ),
        ] {
            assert_eq!(strip_shard_suffix(name), expected, "{name}");
        }
        let parts = parse_gguf_shard("a-0001-of-0003.gguf").unwrap();
        assert_eq!(parts.format_part(2), "a-0002-of-0003.gguf");
        let parts = parse_gguf_shard("a-00001-of-00003.gguf").unwrap();
        assert_eq!(parts.format_part(3), "a-00003-of-00003.gguf");
    }

    #[test]
    fn ordinary_names_and_invalid_parts_are_left_alone() {
        for name in [
            "a-1-of-2.gguf",
            "a-1-of-4.gguf",
            "a-1-of-33.gguf",
            "a-00001-of-00001.gguf",
            "a-0001-of-0001.gguf",
            "a-00000-of-00004.gguf",
            "a-00005-of-00004.gguf",
            "a-00001-of-0004.gguf",
            "a-00001-OF-00002.gguf",
            "a-00001-of-00004.bin",
            "a-00001-of-00004.txt",
            "a-00001-of-00004.gguf-extra",
            "a-00001-of-00004.gguf.part",
            "a-00001-of-0000x.gguf",
            "Q4/-00001-of-00004.gguf",
            "-00001-of-00004.gguf",
            "",
        ] {
            assert_eq!(strip_shard_suffix(name), name, "{name}");
        }
        assert!(parse_gguf_shard("a-00001-of-00004.safetensors").is_none());
        assert!(parse_safetensors_shard("a-00001-of-00004.GGUF").is_none());
        assert!(parse_safetensors_shard("a-00001-of-00004.SAFETENSORS").is_none());
        assert!(parse_safetensors_shard_raw("a-00000-of-00004.safetensors").is_some());
        assert!(parse_safetensors_shard("a-00000-of-00004.safetensors").is_none());
    }

    #[test]
    fn path_syntax_is_explicit_only() {
        for path in [
            r"C:\models\a.gguf",
            "C:/models/a.gguf",
            "/models/a.gguf",
            "./a.gguf",
            "~/a.gguf",
            r"\\server\share\a.gguf",
            r"\\?\C:\models\a.gguf",
            "file:///models/a.gguf",
            r"models\a.gguf",
        ] {
            assert!(is_explicit_path(path), "{path}");
        }
        for value in [
            "",
            "owner/model",
            "models/a.gguf",
            "acme/voice.bin",
            "https://example.invalid/models/voice.bin",
            "native-speech-model",
        ] {
            assert!(!is_explicit_path(value), "{value}");
        }
    }

    #[test]
    fn display_names_drop_directories_revisions_and_parts() {
        let revision = "a".repeat(40);
        for (value, expected) in [
            (r"C:\models\qwen-00001-of-00004.gguf", "qwen.gguf"),
            ("/models/qwen-0001-of-0004.gguf", "qwen.gguf"),
            (
                r"\\?\UNC\server\models\qwen-00001-of-00002.GGUF",
                "qwen.GGUF",
            ),
            ("qwen.gguf", "qwen.gguf"),
            ("/models/plain-model/", "plain-model"),
            ("/", ""),
            ("", ""),
            (
                "variants · 4bit/model-0001-of-0004.safetensors",
                "variants · 4bit/model.safetensors",
            ),
            (
                &format!("/lib/models--org--Qwen-model/snapshots/{revision}"),
                "Qwen-model",
            ),
            (
                &format!(r"C:\cache\models--org--model--variant\snapshots\{revision}\"),
                "model--variant",
            ),
            (&format!("/lib/hf/org/gemma/snapshots/{revision}"), "gemma"),
            (&format!("/lib/other/snapshots/{revision}"), &revision),
            (
                &format!("/lib/hf/org/gemma/snapshots/{revision}/x.gguf"),
                "x.gguf",
            ),
        ] {
            assert_eq!(display_name(value), expected, "{value}");
        }
    }

    #[test]
    fn repository_names_follow_hub_syntax() {
        assert_eq!(
            repository_display_name("org/model-4bit").as_deref(),
            Some("model-4bit")
        );
        for bad in [
            "model",
            "a/b/c",
            "/model",
            "org/",
            "org/-m",
            "org/m o",
            "org/model..v2",
        ] {
            assert_eq!(repository_display_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn resolved_names_read_snapshot_metadata_only_for_opaque_snapshots() {
        let revision = "b".repeat(40);
        let root = temp("resolve");
        let cache = root
            .join("models--org--cache-model")
            .join("snapshots")
            .join(&revision);
        std::fs::create_dir_all(&cache).unwrap();
        assert_eq!(resolve_display_name(cache.to_str().unwrap()), "cache-model");

        let app = root.join("hf/org/app-model/snapshots").join(&revision);
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(
            app.join(crate::providers::artifacts::SNAPSHOT_MANIFEST),
            serde_json::to_vec(&serde_json::json!({
                "format": 1, "repository": "org/app-model", "revision": revision,
                "complete": false, "files": [{"path": "model.safetensors", "size": 8}]
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(resolve_display_name(app.to_str().unwrap()), "app-model");

        let external = root.join("external/snapshots").join(&revision);
        std::fs::create_dir_all(&external).unwrap();
        assert_eq!(resolve_display_name(external.to_str().unwrap()), revision);
        std::fs::write(
            external.join("README.md"),
            b"# example/converted-model-4bit\n",
        )
        .unwrap();
        assert_eq!(
            resolve_display_name(external.to_str().unwrap()),
            "converted-model-4bit"
        );

        let named = root.join("my-own-folder");
        std::fs::create_dir_all(&named).unwrap();
        std::fs::write(
            named.join(crate::providers::artifacts::SNAPSHOT_MANIFEST),
            serde_json::to_vec(&serde_json::json!({
                "format": 1, "repository": "org/app-model", "revision": revision,
                "complete": false, "files": [{"path": "model.safetensors", "size": 8}]
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            resolve_display_name(named.to_str().unwrap()),
            "my-own-folder"
        );
        assert_eq!(resolve_display_name("  "), "");
        std::fs::remove_dir_all(root).unwrap();
    }
}
