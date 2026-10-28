//! Open adapter setup recipes produce the existing common entry-point draft.
//! No engine ID dispatch or serving capability inference belongs here.
use super::{
    registry::{EntrypointDraft, ProcessSpec},
    runtime_help::{self, Encoding, HelpCommand, HelpService},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

const LIMIT: usize = 64 * 1024;

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
    let mut recipe: Recipe = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    recipe.validate()?;
    let root = path
        .canonicalize()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("adapter setup has no parent directory")?
        .to_path_buf();
    let mut resources = BTreeSet::new();
    let mut resolve_resource = |token: &str| -> Result<String, String> {
        let Some(relative) = token
            .strip_prefix("{resource:")
            .and_then(|s| s.strip_suffix('}'))
        else {
            return Ok(token.into());
        };
        let relative_path = Path::new(relative);
        if relative.is_empty()
            || relative.contains(['\\', '\0'])
            || relative.contains("{input:")
            || relative.contains("{resource:")
            || relative_path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(
                "adapter resources must be relative file paths inside the setup folder".into(),
            );
        }
        let resource = root.join(relative_path).canonicalize().map_err(|e| {
            format!("adapter resource is missing; keep the setup package together: {relative}: {e}")
        })?;
        if !resource.starts_with(&root) || !resource.is_file() {
            return Err("adapter resource must be a file inside the setup folder".into());
        }
        let resolved = resource.to_string_lossy().into_owned();
        resources.insert(resolved.clone());
        Ok(resolved)
    };
    recipe.prepare.program = resolve_resource(&recipe.prepare.program)?;
    recipe.prepare.args = recipe
        .prepare
        .args
        .iter()
        .map(|s| resolve_resource(s))
        .collect::<Result<_, _>>()?;
    recipe.prepare.working_directory = recipe
        .prepare
        .working_directory
        .as_ref()
        .map(|s| resolve_resource(s))
        .transpose()?;
    recipe.artifacts = recipe
        .artifacts
        .iter()
        .map(|s| resolve_resource(s))
        .collect::<Result<_, _>>()?;
    // Every referenced helper participates in the existing help identity check.
    let additional = resources
        .into_iter()
        .filter(|p| !recipe.artifacts.contains(p))
        .collect::<Vec<_>>();
    recipe.artifacts.extend(additional);
    recipe.validate()?;
    Ok(recipe)
}

fn resolve(token: &str, inputs: &BTreeMap<String, String>) -> Result<String, String> {
    if let Some(key) = token
        .strip_prefix("{input:")
        .and_then(|s| s.strip_suffix('}'))
    {
        return inputs
            .get(key)
            .cloned()
            .ok_or_else(|| format!("missing adapter input: {key}"));
    }
    if token.starts_with("{resource:") {
        return Err(
            "import the adapter setup JSON with its companion files before preparing it".into(),
        );
    }
    // Only the two v1 namespaces are template syntax; other braces are
    // literal data, including JSON argv and resolved package paths.
    if token.contains('\0') || token.contains("{input:") || token.contains("{resource:") {
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
    let resolve = |token: &str| resolve(token, &values);
    // Import adds package resources to the hash list. A user-selected input
    // may name the same file; keep one identical path after substitution. Preserve distinct symlink
    // aliases so HelpCommand can still detect retargeting.
    let artifacts = recipe
        .artifacts
        .iter()
        .map(|s| resolve(s).map(PathBuf::from))
        .collect::<Result<BTreeSet<_>, _>>()?
        .into_iter()
        .collect();
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
        artifacts,
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
