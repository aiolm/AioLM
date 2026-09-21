//! What a measured model is, stated only from evidence.
//!
//! Two sources feed this, and each is named in the result. The GGUF header's
//! `general.*` block says how whoever packaged the file described it. A
//! download receipt says which Hugging Face repository this application
//! actually fetched the bytes from. Nothing else contributes: a file name is
//! never parsed for a publisher or a quantisation, and `general.quantized_by`
//! names whoever re-quantised the weights, which is not the same party as the
//! repository that published them.
//!
//! Everything here can end up in a shared record, so each value is held to a
//! shape that is safe to publish: short single-line labels, Hugging Face
//! `namespace/repo` ids rather than URLs, and repo-relative artifact paths
//! rather than anything from this machine.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Limits for anything that may be published.
const MAX_LABEL_CHARS: usize = 256;
const MAX_REPOSITORY_COMPONENT_CHARS: usize = 128;
const MAX_ARTIFACT_CHARS: usize = 512;
const MAX_BASE_MODELS: usize = 8;
const MAX_FILE_TYPE: u32 = 65_535;

/// Length in UTF-16 code units, matching how the public schema and the
/// JavaScript consumers measure `maxLength`. One emoji is two units here and
/// one `char` in Rust; the shorter budget wins so both sides agree.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Hugging Face routes these under its own namespaces, so a path beginning with
/// one of them does not name a model repository owned by that account.
const RESERVED_NAMESPACES: [&str; 8] = [
    "datasets",
    "spaces",
    "models",
    "api",
    "docs",
    "blog",
    "collections",
    "papers",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct BenchmarkModelMetadata {
    /// Always `GGUF`: metadata is only produced from a header this build read.
    pub format: String,
    pub name: Option<String>,
    pub architecture: Option<String>,
    pub size_label: Option<String>,
    /// The weight quantisation the file type names. This describes the stored
    /// weights only, not the KV cache and not the model's quality.
    pub quantization: Option<String>,
    /// `general.file_type` as stated, kept even when no label is known for it.
    pub file_type: Option<u32>,
    pub quantized_by: Option<String>,
    /// Hugging Face `namespace/repo`; the only thing a publisher is read from.
    pub repository: Option<String>,
    pub base_models: Vec<String>,
    /// Repo-relative artifact path, from a download receipt and nowhere else.
    pub artifact: Option<String>,
    pub source: String,
}

/// Header strings are written by whoever packaged the file. Keep only short
/// single-line labels that cannot be mistaken for a path, a repository id or an
/// address, so a label can never be read as provenance it has not earned.
fn label(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()
        && utf16_len(trimmed) <= MAX_LABEL_CHARS
        && !trimmed
            .chars()
            .any(|character| character.is_control() || "/\\:@".contains(character)))
    .then(|| trimmed.to_owned())
}

fn repository_component(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_REPOSITORY_COMPONENT_CHARS
        && value.starts_with(|first: char| first.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
        && !value.contains("..")
}

/// A Hugging Face repository id, or `None` when the text is not one.
fn repository_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let (namespace, repository) = trimmed.split_once('/')?;
    (repository_component(namespace)
        && repository_component(repository)
        && !RESERVED_NAMESPACES.contains(&namespace.to_ascii_lowercase().as_str()))
    .then(|| trimmed.to_owned())
}

/// The repository a `*.repo_url` points at, when it points at a public Hugging
/// Face model repository and nothing else. Only `namespace/repo` is kept: the
/// URL itself is never reported, and a link to a file, a revision, a dataset or
/// another host does not name a repository and is dropped entirely.
fn huggingface_repository(url: &str) -> Option<String> {
    let value = url.trim();
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .unwrap_or(value);
    let (host, path) = rest.split_once('/')?;
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if host != "huggingface.co" && host != "hf.co" {
        return None;
    }
    let path = path
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_matches('/');
    let mut parts = path.split('/');
    let namespace = parts.next()?;
    let repository = parts.next()?;
    // A longer path names something inside a repository, not the repository.
    if parts.next().is_some() {
        return None;
    }
    repository_id(&format!(
        "{namespace}/{}",
        repository.strip_suffix(".git").unwrap_or(repository)
    ))
}

/// A directory component of an artifact path, mirroring the public schema:
/// ASCII, starts alphanumeric, then alphanumeric/dot/underscore/space/hyphen,
/// at most 128 code units.
fn artifact_directory(value: &str) -> bool {
    !value.is_empty()
        && utf16_len(value) <= MAX_REPOSITORY_COMPONENT_CHARS
        && value.starts_with(|first: char| first.is_ascii_alphanumeric())
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character == '.'
                || character == '_'
                || character == ' '
                || character == '-'
        })
}

/// A path inside a public repository, mirroring the public schema artifact
/// pattern: slash-separated safe components ending in a `.gguf` file whose
/// name starts alphanumeric. Anything that could be a path on this machine,
/// whether absolute, backslash separated or drive qualified, is refused, as
/// is traversal. A leading-dot filename is not a valid artifact name.
fn artifact_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || utf16_len(trimmed) > MAX_ARTIFACT_CHARS {
        return None;
    }
    if trimmed.starts_with('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.contains('@')
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return None;
    }
    let (directories, file) = parts.split_at(parts.len() - 1);
    if !directories
        .iter()
        .all(|directory| artifact_directory(directory))
    {
        return None;
    }
    let file = file[0];
    let (stem, extension) = file.rsplit_once('.')?;
    if !extension.eq_ignore_ascii_case("gguf") {
        return None;
    }
    if stem.is_empty()
        || !stem.starts_with(|first: char| first.is_ascii_alphanumeric())
        || !stem.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character == '.'
                || character == '_'
                || character == ' '
                || character == '-'
        })
    {
        return None;
    }
    Some(trimmed.to_owned())
}

impl BenchmarkModelMetadata {
    /// Whether every value is one this build would itself have produced. A
    /// record arriving from an older build, another machine or an edited file
    /// is held to the same shape as one collected here.
    pub(crate) fn is_valid(&self) -> bool {
        let is_label = |value: &Option<String>| {
            value
                .as_deref()
                .is_none_or(|value| label(value).as_deref() == Some(value))
        };
        let is_repository = |value: &str| repository_id(value).as_deref() == Some(value);
        self.format == "GGUF"
            && ["gguf", "huggingface", "gguf+huggingface"].contains(&self.source.as_str())
            && is_label(&self.name)
            && is_label(&self.architecture)
            && is_label(&self.size_label)
            && is_label(&self.quantization)
            && is_label(&self.quantized_by)
            && self.file_type.is_none_or(|value| value <= MAX_FILE_TYPE)
            && self.repository.as_deref().is_none_or(is_repository)
            && self.base_models.len() <= MAX_BASE_MODELS
            && self.base_models.iter().all(|value| is_repository(value))
            && self
                .artifact
                .as_deref()
                .is_none_or(|value| artifact_path(value).as_deref() == Some(value))
            // An artifact path is only ever known from a download receipt, which
            // also names the repository: it requires both a repository and a
            // Hugging Face source, mirroring the public schema.
            && (self.artifact.is_none()
                || (self.repository.is_some() && self.source.contains("huggingface")))
    }
}

/// Collects what can be said about the model at `path` without reading a tensor,
/// hashing the file or asking the network. Returns `None` when the file is not
/// a GGUF header this build can read, or when neither source said anything.
pub(crate) fn collect(root: &Path, path: &Path) -> Option<BenchmarkModelMetadata> {
    let descriptor = crate::gguf::read_descriptor(path).ok()?;
    let receipt = super::download_receipt::read(root, path);
    if descriptor.is_empty() && receipt.is_none() {
        return None;
    }
    let file_type = descriptor
        .file_type
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value <= MAX_FILE_TYPE);
    let declared_repository = descriptor
        .repo_url
        .as_deref()
        .and_then(huggingface_repository);
    let mut base_models: Vec<String> = Vec::new();
    for candidate in descriptor
        .base_model_repo_urls
        .iter()
        .filter_map(|url| huggingface_repository(url))
    {
        if base_models.len() == MAX_BASE_MODELS {
            break;
        }
        if !base_models.contains(&candidate) {
            base_models.push(candidate);
        }
    }
    // A receipt is evidence of where the bytes came from; the header's own
    // URL is only a claim, so the receipt wins when both are present.
    let receipt_repository: Option<String> = receipt
        .as_ref()
        .and_then(|receipt| repository_id(&receipt.repository));
    let repository: Option<String> = receipt_repository
        .clone()
        .or_else(|| declared_repository.clone());
    // An artifact without its own repository cannot be published (and would
    // fail validation), so a receipt whose repository is unusable contributes
    // no artifact even when the header claims one.
    let artifact: Option<String> = receipt_repository.as_ref().and(
        receipt
            .as_ref()
            .and_then(|receipt| artifact_path(&receipt.artifact)),
    );
    let metadata = BenchmarkModelMetadata {
        format: "GGUF".into(),
        name: descriptor.name.as_deref().and_then(label),
        architecture: descriptor.architecture.as_deref().and_then(label),
        size_label: descriptor.size_label.as_deref().and_then(label),
        quantization: file_type
            .and_then(crate::gguf::file_type_label)
            .map(str::to_owned),
        file_type,
        quantized_by: descriptor.quantized_by.as_deref().and_then(label),
        repository,
        base_models,
        artifact,
        source: String::new(),
    };
    let from_header = metadata.name.is_some()
        || metadata.architecture.is_some()
        || metadata.size_label.is_some()
        || metadata.quantized_by.is_some()
        || metadata.file_type.is_some()
        || declared_repository.is_some()
        || !metadata.base_models.is_empty();
    let from_receipt = metadata.artifact.is_some()
        || receipt
            .as_ref()
            .is_some_and(|receipt| repository_id(&receipt.repository).is_some());
    let source = match (from_header, from_receipt) {
        (true, true) => "gguf+huggingface",
        (true, false) => "gguf",
        (false, true) => "huggingface",
        (false, false) => return None,
    };
    Some(BenchmarkModelMetadata {
        source: source.into(),
        ..metadata
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A GGUF header carrying only string and uint32 entries, which is all the
    /// `general.*` block this module reads is made of.
    fn header(entries: &[(&str, Option<&str>, Option<u32>)]) -> Vec<u8> {
        let string = |value: &str| {
            let mut out = (value.len() as u64).to_le_bytes().to_vec();
            out.extend_from_slice(value.as_bytes());
            out
        };
        let mut out = b"GGUF".to_vec();
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u64).to_le_bytes());
        for (key, text, number) in entries {
            out.extend_from_slice(&string(key));
            match (text, number) {
                (Some(text), _) => {
                    out.extend_from_slice(&8u32.to_le_bytes());
                    out.extend_from_slice(&string(text));
                }
                (_, Some(number)) => {
                    out.extend_from_slice(&4u32.to_le_bytes());
                    out.extend_from_slice(&number.to_le_bytes());
                }
                _ => unreachable!("a header entry carries a value"),
            }
        }
        out
    }

    struct Fixture {
        root: PathBuf,
        model: PathBuf,
    }

    impl Fixture {
        fn new(entries: &[(&str, Option<&str>, Option<u32>)]) -> Self {
            let root = std::env::temp_dir().join(format!("aiolm-facts-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let model = root.join("synthetic.gguf");
            fs::write(&model, header(entries)).unwrap();
            Self { root, model }
        }

        fn collect(&self) -> Option<BenchmarkModelMetadata> {
            super::collect(&self.root, &self.model)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn metadata() -> BenchmarkModelMetadata {
        BenchmarkModelMetadata {
            format: "GGUF".into(),
            name: Some("Synthetic 7B".into()),
            architecture: Some("llama".into()),
            size_label: Some("7B".into()),
            quantization: Some("Q4_K_M".into()),
            file_type: Some(15),
            quantized_by: Some("synthetic-quantizer".into()),
            repository: Some("synthetic-org/synthetic-model".into()),
            base_models: vec!["synthetic-base/synthetic-weights".into()],
            artifact: Some("quantized/synthetic.gguf".into()),
            source: "gguf+huggingface".into(),
        }
    }

    #[test]
    fn only_a_public_huggingface_model_repository_becomes_a_repository_id() {
        assert_eq!(
            huggingface_repository("https://huggingface.co/synthetic-org/synthetic-model"),
            Some("synthetic-org/synthetic-model".into())
        );
        assert_eq!(
            huggingface_repository("https://HF.co/synthetic-org/synthetic-model.git/"),
            Some("synthetic-org/synthetic-model".into())
        );
        // A file, a revision, another kind of repository, another host and a
        // bare name are each either not a repository or not a public one.
        for rejected in [
            "https://huggingface.co/synthetic-org/synthetic-model/blob/main/model.gguf",
            "https://huggingface.co/datasets/synthetic-org/synthetic-set",
            "https://example.invalid/synthetic-org/synthetic-model",
            "https://huggingface.co/synthetic-org",
            "file:///home/someone/models/synthetic.gguf",
            "synthetic-org/synthetic-model",
        ] {
            assert_eq!(huggingface_repository(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn labels_stay_short_single_line_and_unlike_a_path_or_an_address() {
        assert_eq!(label("  Synthetic 7B  ").as_deref(), Some("Synthetic 7B"));
        for rejected in [
            "",
            "   ",
            "synthetic/model",
            "C:\\models\\synthetic.gguf",
            "someone@example.invalid",
            "line\nbreak",
        ] {
            assert_eq!(label(rejected), None, "{rejected:?}");
        }
        assert!(label(&"x".repeat(MAX_LABEL_CHARS)).is_some());
        assert_eq!(label(&"x".repeat(MAX_LABEL_CHARS + 1)), None);
        // Length is UTF-16 code units, as the public schema measures it: 128
        // emoji are 256 units (accepted) while 129 are 258 (refused), even
        // though both are far fewer Rust `char`s.
        assert!(label(&"😀".repeat(128)).is_some());
        assert_eq!(label(&"😀".repeat(129)), None);
    }

    #[test]
    fn an_artifact_is_a_repository_path_and_never_one_from_this_machine() {
        assert_eq!(
            artifact_path("quantized/synthetic.GGUF").as_deref(),
            Some("quantized/synthetic.GGUF")
        );
        assert_eq!(
            artifact_path("my dir/synthetic model.Q4_K_M.gguf").as_deref(),
            Some("my dir/synthetic model.Q4_K_M.gguf")
        );
        for rejected in [
            "/models/synthetic.gguf",
            "C:/models/synthetic.gguf",
            "models\\synthetic.gguf",
            "../synthetic.gguf",
            "quantized//synthetic.gguf",
            "synthetic.bin",
            // The public schema requires the filename to start alphanumeric.
            ".gguf",
            "quantized/.gguf",
            "quantized/synthetic.gguf/",
            "quantized/synthetic.GGUF.bak",
        ] {
            assert_eq!(artifact_path(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn validation_refuses_what_this_build_would_not_have_produced() {
        assert!(metadata().is_valid());
        let cases: Vec<(&str, BenchmarkModelMetadata)> = vec![
            (
                "an artifact without a download to justify it",
                BenchmarkModelMetadata {
                    source: "gguf".into(),
                    ..metadata()
                },
            ),
            (
                "an artifact without its repository alongside it",
                BenchmarkModelMetadata {
                    repository: None,
                    source: "huggingface".into(),
                    ..metadata()
                },
            ),
            (
                "a repository that is a URL rather than an id",
                BenchmarkModelMetadata {
                    repository: Some("https://huggingface.co/a/b".into()),
                    ..metadata()
                },
            ),
            (
                "a label carrying a local path",
                BenchmarkModelMetadata {
                    name: Some("C:\\models\\synthetic.gguf".into()),
                    ..metadata()
                },
            ),
            (
                "more base models than may be reported",
                BenchmarkModelMetadata {
                    base_models: (0..MAX_BASE_MODELS + 1)
                        .map(|index| format!("synthetic-base/model{index}"))
                        .collect(),
                    ..metadata()
                },
            ),
            (
                "a file type outside the recorded range",
                BenchmarkModelMetadata {
                    file_type: Some(MAX_FILE_TYPE + 1),
                    ..metadata()
                },
            ),
            (
                "a source this build does not write",
                BenchmarkModelMetadata {
                    source: "filename".into(),
                    ..metadata()
                },
            ),
        ];
        for (reason, value) in cases {
            assert!(!value.is_valid(), "{reason}");
        }
    }

    #[test]
    fn a_header_on_its_own_describes_packaging_but_claims_no_artifact() {
        let fixture = Fixture::new(&[
            ("general.architecture", Some("llama"), None),
            ("general.name", Some("Synthetic 7B"), None),
            ("general.size_label", Some("7B"), None),
            ("general.file_type", None, Some(15)),
            ("general.quantized_by", Some("synthetic-quantizer"), None),
            (
                "general.repo_url",
                Some("https://huggingface.co/claimed-org/claimed-model"),
                None,
            ),
            ("general.base_model.count", None, Some(1)),
            (
                "general.base_model.0.repo_url",
                Some("https://huggingface.co/synthetic-base/weights"),
                None,
            ),
        ]);
        let collected = fixture.collect().expect("a described header");
        assert_eq!(collected.source, "gguf");
        assert_eq!(collected.format, "GGUF");
        assert_eq!(collected.name.as_deref(), Some("Synthetic 7B"));
        assert_eq!(collected.quantization.as_deref(), Some("Q4_K_M"));
        assert_eq!(collected.file_type, Some(15));
        assert_eq!(
            collected.quantized_by.as_deref(),
            Some("synthetic-quantizer")
        );
        assert_eq!(
            collected.repository.as_deref(),
            Some("claimed-org/claimed-model")
        );
        assert_eq!(
            collected.base_models,
            vec!["synthetic-base/weights".to_string()]
        );
        // Only a download shows which artifact of a repository this file is.
        assert_eq!(collected.artifact, None);
        assert!(collected.is_valid());
    }

    #[test]
    fn a_download_receipt_outranks_the_repository_the_header_claims() {
        let fixture = Fixture::new(&[
            ("general.architecture", Some("llama"), None),
            (
                "general.repo_url",
                Some("https://huggingface.co/claimed-org/claimed-model"),
                None,
            ),
        ]);
        super::super::download_receipt::record(
            &fixture.root,
            &fixture.model,
            "serving-org/serving-model",
            "quantized/synthetic.gguf",
        )
        .unwrap();
        let collected = fixture.collect().expect("a described header");
        assert_eq!(collected.source, "gguf+huggingface");
        assert_eq!(
            collected.repository.as_deref(),
            Some("serving-org/serving-model")
        );
        assert_eq!(
            collected.artifact.as_deref(),
            Some("quantized/synthetic.gguf")
        );
        assert!(collected.is_valid());

        // Replacing the file revokes the receipt, leaving only the claim the
        // header itself makes and no artifact at all.
        let replaced = header(&[(
            "general.repo_url",
            Some("https://huggingface.co/claimed-org/claimed-model"),
            None,
        )]);
        fs::write(&fixture.model, replaced).unwrap();
        let collected = fixture.collect().expect("a described header");
        assert_eq!(collected.source, "gguf");
        assert_eq!(
            collected.repository.as_deref(),
            Some("claimed-org/claimed-model")
        );
        assert_eq!(collected.artifact, None);
    }

    #[test]
    fn a_receipt_without_a_usable_repository_contributes_no_artifact() {
        // A reserved namespace names a Hugging Face route, not a model
        // repository owned by that account. Its artifact must not be paired
        // with the unrelated repository the header claims.
        let fixture = Fixture::new(&[
            ("general.architecture", Some("llama"), None),
            (
                "general.repo_url",
                Some("https://huggingface.co/claimed-org/claimed-model"),
                None,
            ),
        ]);
        super::super::download_receipt::record(
            &fixture.root,
            &fixture.model,
            "datasets/synthetic-set",
            "quantized/synthetic.gguf",
        )
        .unwrap();
        let collected = fixture.collect().expect("a described header");
        assert_eq!(collected.source, "gguf");
        assert_eq!(
            collected.repository.as_deref(),
            Some("claimed-org/claimed-model")
        );
        assert_eq!(collected.artifact, None);
        assert!(collected.is_valid());
    }

    #[test]
    fn nothing_is_claimed_for_a_header_that_describes_nothing() {
        // A quantisation this build has no name for keeps its number, and an
        // architecture alone is still worth reporting.
        let described = Fixture::new(&[("general.file_type", None, Some(1024))])
            .collect()
            .expect("a stated file type");
        assert_eq!(described.file_type, Some(1024));
        assert_eq!(described.quantization, None);
        assert_eq!(described.source, "gguf");

        assert!(Fixture::new(&[("llama.block_count", None, Some(32))])
            .collect()
            .is_none());
        let empty = std::env::temp_dir().join(format!("aiolm-facts-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&empty).unwrap();
        let text = empty.join("notes.txt");
        fs::write(&text, b"not a model").unwrap();
        assert!(super::collect(&empty, &text).is_none());
        let _ = fs::remove_dir_all(&empty);
    }
}
