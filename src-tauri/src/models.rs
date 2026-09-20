// src-tauri/src/models.rs
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

mod scan_jobs;
pub use scan_jobs::ScanRegistry;

const MAX_DEPTH: u32 = 8;
const MAX_MODELS: usize = 10_000;
const MAX_ENTRIES: usize = 100_000;

#[derive(Serialize, Clone, Debug)]
pub struct GgufModel {
    pub name: String,
    pub path: String,
    pub size_mb: f64,
    pub is_vision: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shards: Option<ModelShards>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ModelShards {
    pub files: Vec<String>,
    pub total: usize,
    pub missing: Vec<usize>,
}

// GGUF's standard suffix is -00001-of-00033.gguf. Include the directory,
// quantization/base name and total in the key; similarly named models elsewhere
// and different quantizations must remain independent entries.
fn shard_name(name: &str) -> Option<(&str, usize, usize)> {
    let (stem, extension) = name.rsplit_once('.')?;
    if !extension.eq_ignore_ascii_case("gguf") {
        return None;
    }
    let (prefix, total) = stem.rsplit_once("-of-")?;
    let (base, index) = prefix.rsplit_once('-')?;
    if base.is_empty()
        || index.len() != 5
        || total.len() != 5
        || !index.bytes().all(|byte| byte.is_ascii_digit())
        || !total.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let index: usize = index.parse().ok()?;
    let total: usize = total.parse().ok()?;
    (total > 1 && index > 0 && index <= total).then_some((base, index, total))
}

pub(crate) fn validate_model_shards(path: &Path) -> Result<(), String> {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    let Some((base, index, total)) = shard_name(name) else {
        return Ok(());
    };
    if index != 1 {
        return Err("select the first GGUF shard before starting the model".into());
    }
    let parent = path.parent().unwrap_or(Path::new(""));
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("gguf");
    for index in 1..=total {
        let shard = parent.join(format!("{base}-{index:05}-of-{total:05}.{extension}"));
        if !shard.is_file() {
            return Err(format!("model shard is missing: {}", shard.display()));
        }
    }
    Ok(())
}

fn group_shards(files: Vec<GgufModel>) -> Vec<GgufModel> {
    let mut models = Vec::new();
    let mut groups = BTreeMap::<(PathBuf, String, usize), Vec<(usize, GgufModel)>>::new();
    for file in files {
        if let Some((base, index, total)) = shard_name(&file.name) {
            let parent = Path::new(&file.path)
                .parent()
                .unwrap_or(Path::new(""))
                .to_path_buf();
            groups
                .entry((parent, base.to_owned(), total))
                .or_default()
                .push((index, file));
        } else {
            models.push(file);
        }
    }
    for ((_, base, total), mut parts) in groups {
        parts.sort_by_key(|(index, _)| *index);
        let present: HashSet<usize> = parts.iter().map(|(index, _)| *index).collect();
        let missing = (1..=total)
            .filter(|index| !present.contains(index))
            .collect();
        let mut model = parts[0].1.clone();
        model.name = format!("{base}.gguf");
        model.size_mb = parts.iter().map(|(_, part)| part.size_mb).sum();
        model.shards = Some(ModelShards {
            files: parts.into_iter().map(|(_, part)| part.path).collect(),
            total,
            missing,
        });
        models.push(model);
    }
    models
}

#[derive(Serialize, Clone, Debug)]
pub struct ModelScan {
    pub models: Vec<GgufModel>,
    pub truncated: bool,
}

pub fn scan(models_dir: &str) -> Result<ModelScan, String> {
    scan_cancellable(models_dir, &AtomicBool::new(false))
}

pub fn scan_cancellable(models_dir: &str, cancel: &AtomicBool) -> Result<ModelScan, String> {
    scan_with_limits(models_dir, cancel, MAX_ENTRIES)
}

struct ScanProgress<'a> {
    cancel: &'a AtomicBool,
    entries: usize,
    max_entries: usize,
    visited: HashSet<PathBuf>,
    truncated: bool,
}

impl ScanProgress<'_> {
    fn check_cancelled(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) {
            Err("model scan cancelled".into())
        } else {
            Ok(())
        }
    }
}

fn scan_with_limits(
    models_dir: &str,
    cancel: &AtomicBool,
    max_entries: usize,
) -> Result<ModelScan, String> {
    let mut progress = ScanProgress {
        cancel,
        entries: 0,
        max_entries,
        visited: HashSet::new(),
        truncated: false,
    };
    progress.check_cancelled()?;
    let root = Path::new(models_dir.trim());
    if models_dir.trim().is_empty() {
        return Err("models directory is empty".into());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot open models directory {}: {error}", root.display()))?;
    if !root.is_dir() {
        return Err(format!(
            "models path is not a directory: {}",
            root.display()
        ));
    }

    let mut models = Vec::new();
    walk(&root, &mut models, 0, &mut progress)?;
    progress.check_cancelled()?;
    let mut models = group_shards(models);
    models.sort_by(|left, right| {
        right
            .size_mb
            .partial_cmp(&left.size_mb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.name.cmp(&right.name))
    });
    progress.check_cancelled()?;
    Ok(ModelScan {
        models,
        truncated: progress.truncated,
    })
}

fn walk(
    dir: &Path,
    models: &mut Vec<GgufModel>,
    depth: u32,
    progress: &mut ScanProgress<'_>,
) -> Result<(), String> {
    progress.check_cancelled()?;
    if depth > MAX_DEPTH {
        progress.truncated = true;
        return Ok(());
    }
    if models.len() >= MAX_MODELS || progress.entries >= progress.max_entries {
        progress.truncated = true;
        return Ok(());
    }
    let canonical = dir
        .canonicalize()
        .map_err(|error| format!("cannot read models directory {}: {error}", dir.display()))?;
    if !progress.visited.insert(canonical.clone()) {
        return Ok(());
    }

    let entries = fs::read_dir(&canonical).map_err(|error| {
        format!(
            "cannot enumerate models directory {}: {error}",
            canonical.display()
        )
    })?;
    for entry in entries {
        progress.check_cancelled()?;
        if models.len() >= MAX_MODELS || progress.entries >= progress.max_entries {
            progress.truncated = true;
            break;
        }
        progress.entries += 1;
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            walk(&path, models, depth + 1, progress)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let is_gguf = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"));
        if !is_gguf {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        models.push(GgufModel {
            name: name.clone(),
            path: path.to_string_lossy().into_owned(),
            size_mb: metadata.len() as f64 / 1_048_576.0,
            is_vision: name.to_ascii_lowercase().contains("mmproj"),
            shards: None,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(name: &str, dir: &str, size_mb: f64) -> GgufModel {
        GgufModel {
            name: name.into(),
            path: Path::new(dir).join(name).to_string_lossy().into_owned(),
            size_mb,
            is_vision: name.contains("mmproj"),
            shards: None,
        }
    }

    #[test]
    fn thirty_three_shards_are_one_model_with_first_path_and_total_size() {
        let files = (1..=33)
            .rev()
            .map(|index| {
                fixture(
                    &format!("Qwen-Q4-{:05}-of-00033.gguf", index),
                    "models",
                    index as f64,
                )
            })
            .collect();
        let result = group_shards(files);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Qwen-Q4.gguf");
        assert!(result[0].path.ends_with("Qwen-Q4-00001-of-00033.gguf"));
        assert_eq!(result[0].size_mb, 561.0);
        let shards = result[0].shards.as_ref().unwrap();
        assert_eq!(shards.files.len(), 33);
        assert_eq!(shards.total, 33);
        assert!(shards.missing.is_empty());
    }

    #[test]
    fn missing_shards_stay_one_visible_incomplete_model() {
        let result = group_shards(vec![
            fixture("a-00004-of-00004.gguf", "models", 4.0),
            fixture("a-00002-of-00004.gguf", "models", 2.0),
        ]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].shards.as_ref().unwrap().missing, vec![1, 3]);
        assert_eq!(result[0].size_mb, 6.0);
    }

    #[test]
    fn grouping_keeps_folders_quantizations_totals_and_sidecars_separate() {
        let mut files = Vec::new();
        for (dir, base, total) in [
            ("a", "model-Q4", 2),
            ("b", "model-Q4", 2),
            ("a", "model-Q8", 2),
            ("a", "model-Q4", 3),
        ] {
            for index in 1..=total {
                files.push(fixture(
                    &format!("{base}-{index:05}-of-{total:05}.gguf"),
                    dir,
                    1.0,
                ));
            }
        }
        files.push(fixture("mmproj.gguf", "a", 1.0));
        files.push(fixture("single.gguf", "a", 1.0));
        let result = group_shards(files);
        assert_eq!(result.len(), 6);
        assert!(result
            .iter()
            .any(|model| model.is_vision && model.shards.is_none()));
        assert!(result
            .iter()
            .any(|model| model.name == "single.gguf" && model.shards.is_none()));
    }

    #[test]
    fn only_standard_valid_shard_suffixes_are_grouped() {
        for name in [
            "a-1-of-2.gguf",
            "a-00000-of-00002.gguf",
            "a-00003-of-00002.gguf",
            "a-00001-of-00001.gguf",
            "a-00001-of-00002.gguf.part",
            "a-00001-of-0000x.gguf",
        ] {
            assert!(shard_name(name).is_none(), "{name}");
        }
        assert_eq!(shard_name("a-00001-of-00002.GGUF"), Some(("a", 1, 2)));
    }

    #[test]
    fn scan_reports_missing_directory_instead_of_empty_success() {
        let missing = std::env::temp_dir().join(format!("aiolm-missing-{}", std::process::id()));
        let result = scan(&missing.to_string_lossy());
        assert!(result.is_err());
    }

    #[test]
    fn cancelled_scan_stops_before_reading_the_directory() {
        let result = scan_cancellable("", &AtomicBool::new(true));
        assert_eq!(result.unwrap_err(), "model scan cancelled");
    }

    #[test]
    fn scan_bounds_non_model_entries_across_nested_directories() {
        let root = std::env::temp_dir().join(format!("aiolm-scan-limit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        for index in 0..8 {
            fs::write(
                root.join("nested").join(format!("unrelated-{index}.txt")),
                b"fixture",
            )
            .unwrap();
        }
        let result = scan_with_limits(&root.to_string_lossy(), &AtomicBool::new(false), 4).unwrap();
        assert!(result.models.is_empty());
        assert!(result.truncated);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_finds_nested_gguf_and_marks_mmproj() {
        let root = std::env::temp_dir().join(format!("aiolm-models-{}", std::process::id()));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create model directory");
        let mut model = fs::File::create(nested.join("model.GGUF")).expect("create model");
        model.write_all(b"fixture").expect("write model");
        let mut sidecar = fs::File::create(root.join("mmproj-test.gguf")).expect("create sidecar");
        sidecar.write_all(b"fixture").expect("write sidecar");

        let models = scan(&root.to_string_lossy()).expect("scan should succeed");
        assert_eq!(models.models.len(), 2);
        assert!(!models.truncated);
        assert!(models.models.iter().any(|model| model.is_vision));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scan_marks_depth_limited_results_as_truncated() {
        let root = std::env::temp_dir().join(format!("aiolm-depth-{}", std::process::id()));
        let mut deep = root.clone();
        for index in 0..=MAX_DEPTH {
            deep = deep.join(format!("level-{index}"));
        }
        fs::create_dir_all(&deep).expect("create deep model directory");
        fs::write(deep.join("too-deep.gguf"), b"fixture").expect("write deep model");

        let result = scan(&root.to_string_lossy()).expect("scan should succeed");
        assert!(result.models.is_empty());
        assert!(result.truncated);
        let _ = fs::remove_dir_all(root);
    }
}
