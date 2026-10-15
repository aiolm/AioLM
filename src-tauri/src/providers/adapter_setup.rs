//! Open adapter setup recipes produce the existing common entry-point draft.
//! No engine ID dispatch or serving capability inference belongs here.
use super::{
    registry::{EntrypointDraft, ProcessSpec},
    runtime_help::{self, Encoding, HelpCommand, HelpService},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const LIMIT: usize = 64 * 1024;
const RESOURCES: &[(&str, &str)] = &[
    (
        "create_adapter.py",
        include_str!("../../../scripts/runtime-adapters/create_adapter.py"),
    ),
    (
        "strata_bridge.py",
        include_str!("../../../scripts/runtime-adapters/strata_bridge.py"),
    ),
    (
        "strata_setup.py",
        include_str!("../../../scripts/runtime-adapters/strata_setup.py"),
    ),
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub kind: FieldKind,
    pub required: bool,
    #[serde(default)]
    pub default: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    File,
    Folder,
    Text,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Recipe {
    pub version: u32,
    pub id: String,
    pub title: String,
    pub description: String,
    pub fields: Vec<Field>,
    pub prepare: ProcessSpec,
    #[serde(default)]
    pub artifacts: Vec<String>,
}

impl Recipe {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.id.is_empty()
            || self.id.len() > 128
            || self.title.is_empty()
            || self.title.len() > 256
            || self.description.len() > 4096
            || self.fields.len() > 32
            || self.artifacts.len() > 64
            || serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > LIMIT
        {
            return Err("invalid adapter setup recipe version or size".into());
        }
        let mut keys = BTreeSet::new();
        for field in &self.fields {
            if field.key.is_empty()
                || field.key.len() > 64
                || !field
                    .key
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_')
                || field.label.is_empty()
                || field.label.len() > 256
                || field.default.len() > 32768
                || !keys.insert(&field.key)
            {
                return Err("invalid or duplicate adapter setup field".into());
            }
        }
        Ok(())
    }
}

pub fn provided() -> Result<Vec<Recipe>, String> {
    let recipe: Recipe = serde_json::from_str(include_str!(
        "../../../scripts/runtime-adapters/strata.setup.json"
    ))
    .map_err(|e| e.to_string())?;
    recipe.validate()?;
    Ok(vec![recipe])
}

pub fn import(path: &Path) -> Result<Recipe, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    use std::io::Read;
    (&mut file)
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT {
        return Err("adapter setup recipe exceeds 64 KiB".into());
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let recipe: Recipe = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    recipe.validate()?;
    Ok(recipe)
}

fn materialize() -> Result<BTreeMap<String, String>, String> {
    let mut digest = Sha256::new();
    for (name, source) in RESOURCES {
        digest.update(name.as_bytes());
        digest.update(source.as_bytes());
    }
    let parent = crate::runtime::runtimes_root().join("adapter-helpers");
    if fs::symlink_metadata(&parent).is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir()) {
        return Err("bundled adapter helper root is not an owned directory".into());
    }
    let directory = parent.join(format!("{:x}", digest.finalize()));
    if fs::symlink_metadata(&directory).is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir()) {
        return Err("bundled adapter helper directory is not an owned directory".into());
    }
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut paths = BTreeMap::new();
    for (name, source) in RESOURCES {
        let path = directory.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => file
                .write_all(source.as_bytes())
                .map_err(|e| e.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.to_string()),
        }
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file())
            || fs::read(&path).map_err(|e| e.to_string())? != source.as_bytes()
        {
            return Err(
                "bundled adapter helper changed; restore the helper before retrying setup".into(),
            );
        }
        paths.insert((*name).into(), path.to_string_lossy().into_owned());
    }
    Ok(paths)
}

fn resolve(
    token: &str,
    inputs: &BTreeMap<String, String>,
    resources: &BTreeMap<String, String>,
) -> Result<String, String> {
    if let Some(key) = token
        .strip_prefix("{input:")
        .and_then(|s| s.strip_suffix('}'))
    {
        return inputs
            .get(key)
            .cloned()
            .ok_or_else(|| format!("missing adapter input: {key}"));
    }
    if let Some(key) = token
        .strip_prefix("{resource:")
        .and_then(|s| s.strip_suffix('}'))
    {
        return resources
            .get(key)
            .cloned()
            .ok_or_else(|| format!("unknown bundled adapter resource: {key}"));
    }
    if token.contains(['{', '}', '\0']) {
        return Err("setup placeholders must occupy one complete argv token".into());
    }
    Ok(token.into())
}

pub fn prepare(
    service: &HelpService,
    owner: &str,
    recipe: &Recipe,
    inputs: &BTreeMap<String, String>,
) -> Result<EntrypointDraft, String> {
    recipe.validate()?;
    if inputs.len() > recipe.fields.len()
        || inputs
            .keys()
            .any(|key| !recipe.fields.iter().any(|f| f.key == *key))
    {
        return Err("unknown adapter setup input".into());
    }
    let mut values = BTreeMap::new();
    for field in &recipe.fields {
        let value = inputs.get(&field.key).unwrap_or(&field.default);
        if (field.required && value.trim().is_empty())
            || value.len() > 32768
            || value.contains('\0')
        {
            return Err(format!("invalid adapter setup input: {}", field.label));
        }
        values.insert(field.key.clone(), value.clone());
    }
    let resources = materialize()?;
    let resolve = |token: &str| resolve(token, &values, &resources);
    let command = HelpCommand {
        program: PathBuf::from(resolve(&recipe.prepare.program)?),
        args: recipe
            .prepare
            .args
            .iter()
            .map(|s| resolve(s))
            .collect::<Result<_, _>>()?,
        environment: super::python_env::engine_environment()
            .into_iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect(),
        working_directory: recipe
            .prepare
            .working_directory
            .as_ref()
            .map(|s| resolve(s).map(PathBuf::from))
            .transpose()?,
        artifacts: recipe
            .artifacts
            .iter()
            .map(|s| resolve(s).map(PathBuf::from))
            .collect::<Result<_, _>>()?,
        runtime_version: format!("adapter-setup-v1:{}", recipe.id),
        scope: vec![],
        encoding: Encoding::Utf8,
        timeout_ms: 15000,
        output_limit: 256 * 1024,
    };
    // Credentials or arbitrary inherited variables are never setup inputs.
    if !recipe.prepare.env.is_empty() {
        return Err("adapter setup environment must be empty".into());
    }
    let ticket = service.begin(&format!("setup:{owner}"))?;
    let result = (|| {
        let report = runtime_help::discover(&command, &ticket.cancel)?;
        if !report.complete() {
            return Err(format!(
                "adapter setup did not complete: {} {}",
                report
                    .error
                    .as_deref()
                    .unwrap_or("process failed or output is incomplete"),
                report.stderr.clean_text
            ));
        }
        let draft: EntrypointDraft = serde_json::from_str(&report.stdout.text)
            .map_err(|e| format!("adapter setup returned an invalid entry point: {e}"))?;
        super::registry::manifest_from_draft(&draft)?;
        service.publish(&ticket, &report, || Ok(()))?;
        Ok(draft)
    })();
    if result.is_err() {
        service.failed(&ticket);
    }
    result
}
