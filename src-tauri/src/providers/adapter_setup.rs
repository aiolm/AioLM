//! Open adapter setup recipes produce the existing common entry-point draft.
//! No engine ID dispatch or serving capability inference belongs here.
use super::{
    registry::{EntrypointDraft, ProcessSpec},
    runtime_help::{self, Encoding, HelpCommand, HelpService},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    sync::{LazyLock, Mutex},
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

/// Display data is returned to the WebView; execution reads only the recipe
/// retained for the opaque, native-picker-issued token.
#[derive(Clone, Debug, Serialize)]
pub struct ImportedRecipe {
    pub recipe: Recipe,
    pub token: String,
}

#[derive(Default)]
struct RecipeStore(VecDeque<(String, Recipe)>);

impl RecipeStore {
    fn insert(&mut self, recipe: Recipe) -> ImportedRecipe {
        let token = uuid::Uuid::new_v4().to_string();
        if self.0.len() >= 64 {
            self.0.pop_front();
        }
        self.0.push_back((token.clone(), recipe.clone()));
        ImportedRecipe { recipe, token }
    }

    fn get(&self, token: &str) -> Result<Recipe, crate::error::AppError> {
        self.0
            .iter()
            .find(|(issued, _)| issued == token)
            .map(|(_, recipe)| recipe.clone())
            .ok_or_else(|| {
                crate::error::AppError::not_found(
                    "adapter setup token is unknown or expired; import the setup again",
                )
            })
    }
}

fn recipes() -> &'static Mutex<RecipeStore> {
    static RECIPES: LazyLock<Mutex<RecipeStore>> =
        LazyLock::new(|| Mutex::new(RecipeStore::default()));
    &RECIPES
}

/// Only the command's native picker calls this path.
pub(crate) fn import_selected(path: &Path) -> Result<ImportedRecipe, crate::error::AppError> {
    let recipe = import(path)?;
    Ok(recipes()
        .lock()
        .map_err(|_| crate::error::AppError::internal("adapter setup lock was poisoned"))?
        .insert(recipe))
}

pub(crate) fn imported_recipe(token: &str) -> Result<Recipe, crate::error::AppError> {
    recipes()
        .lock()
        .map_err(|_| crate::error::AppError::internal("adapter setup lock was poisoned"))?
        .get(token)
}

impl Recipe {
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        if self.version != 1
            || self.id.is_empty()
            || self.id.len() > 128
            || self.title.is_empty()
            || self.title.len() > 256
            || self.description.len() > 4096
            || self.fields.len() > 32
            || self.artifacts.len() > 64
            || serde_json::to_vec(self)
                .map_err(|e| crate::error::AppError::internal(e.to_string()))?
                .len()
                > LIMIT
        {
            return Err(crate::error::AppError::validation(
                "invalid adapter setup recipe version or size",
            ));
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
                return Err(crate::error::AppError::validation(
                    "invalid or duplicate adapter setup field",
                ));
            }
        }
        Ok(())
    }
}

pub fn import(path: &Path) -> Result<Recipe, crate::error::AppError> {
    let mut file = fs::File::open(path).map_err(|e| crate::error::AppError::from_io(&e))?;
    let mut bytes = Vec::new();
    use std::io::Read;
    (&mut file)
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| crate::error::AppError::from_io(&e))?;
    if bytes.len() > LIMIT {
        return Err(crate::error::AppError::validation(
            "adapter setup recipe exceeds 64 KiB",
        ));
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let mut recipe: Recipe = serde_json::from_slice(bytes)
        .map_err(|e| crate::error::AppError::validation(e.to_string()))?;
    recipe.validate()?;
    let root = path
        .canonicalize()
        .map_err(|e| crate::error::AppError::from_io(&e))?
        .parent()
        .ok_or_else(|| crate::error::AppError::validation("adapter setup has no parent directory"))?
        .to_path_buf();
    let mut resources = BTreeSet::new();
    let mut resolve_resource = |token: &str| -> Result<String, crate::error::AppError> {
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
            return Err(crate::error::AppError::validation(
                "adapter resources must be relative file paths inside the setup folder",
            ));
        }
        let resource = root.join(relative_path).canonicalize().map_err(|e| {
            crate::error::AppError::new(
                crate::error::AppError::io_kind(&e),
                format!(
                    "adapter resource is missing; keep the setup package together: {relative}: {e}"
                ),
            )
        })?;
        if !resource.starts_with(&root) || !resource.is_file() {
            return Err(crate::error::AppError::validation(
                "adapter resource must be a file inside the setup folder",
            ));
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

fn resolve(
    token: &str,
    inputs: &BTreeMap<String, String>,
) -> Result<String, crate::error::AppError> {
    if let Some(key) = token
        .strip_prefix("{input:")
        .and_then(|s| s.strip_suffix('}'))
    {
        return inputs.get(key).cloned().ok_or_else(|| {
            crate::error::AppError::validation(format!("missing adapter input: {key}"))
        });
    }
    if token.starts_with("{resource:") {
        return Err(crate::error::AppError::validation(
            "import the adapter setup JSON with its companion files before preparing it",
        ));
    }
    // Only the two v1 namespaces are template syntax; other braces are
    // literal data, including JSON argv and resolved package paths.
    if token.contains('\0') || token.contains("{input:") || token.contains("{resource:") {
        return Err(crate::error::AppError::validation(
            "setup placeholders must occupy one complete argv token",
        ));
    }
    Ok(token.into())
}

pub fn prepare(
    service: &HelpService,
    owner: &str,
    recipe: &Recipe,
    inputs: &BTreeMap<String, String>,
) -> Result<EntrypointDraft, crate::error::AppError> {
    recipe.validate()?;
    if inputs.len() > recipe.fields.len()
        || inputs
            .keys()
            .any(|key| !recipe.fields.iter().any(|f| f.key == *key))
    {
        return Err(crate::error::AppError::validation(
            "unknown adapter setup input",
        ));
    }
    let mut values = BTreeMap::new();
    for field in &recipe.fields {
        let value = inputs.get(&field.key).unwrap_or(&field.default);
        if (field.required && value.trim().is_empty())
            || value.len() > 32768
            || value.contains('\0')
        {
            return Err(crate::error::AppError::validation(format!(
                "invalid adapter setup input: {}",
                field.label
            )));
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
        return Err(crate::error::AppError::validation(
            "adapter setup environment must be empty",
        ));
    }
    let ticket = service.begin(&format!("setup:{owner}"))?;
    let result = (|| {
        let report = runtime_help::discover(&command, &ticket.cancel)?;
        if !report.complete() {
            return Err(report.incomplete_error(format!(
                "adapter setup did not complete: {} {}",
                report
                    .error
                    .as_deref()
                    .unwrap_or("process failed or output is incomplete"),
                report.stderr.clean_text
            )));
        }
        let draft: EntrypointDraft = serde_json::from_str(&report.stdout.text).map_err(|e| {
            crate::error::AppError::validation(format!(
                "adapter setup returned an invalid entry point: {e}"
            ))
        })?;
        super::registry::manifest_from_draft(&draft).map_err(crate::error::AppError::validation)?;
        service.publish(&ticket, &report, || Ok(()))?;
        Ok(draft)
    })();
    if result.is_err() {
        service.failed(&ticket);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_import_tokens_ignore_changes_to_displayed_recipe_and_source_file() {
        let root = std::env::temp_dir().join(format!("aiolm-setup-token-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("synthetic.setup.json");
        fs::write(
            &path,
            br#"{
            "version":1,"id":"synthetic.adapter","title":"Synthetic adapter","description":"",
            "fields":[],"prepare":{"program":"/synthetic/original","args":[],"env":{}}
        }"#,
        )
        .unwrap();
        let mut imported = import_selected(&path).unwrap();
        imported.recipe.prepare.program = "/synthetic/webview-replacement".into();
        fs::write(&path, b"changed after native import").unwrap();
        let retained = imported_recipe(&imported.token).unwrap();
        assert_eq!(retained.prepare.program, "/synthetic/original");
        assert_eq!(
            imported_recipe("unissued-token").unwrap_err().kind,
            crate::error::ErrorKind::NotFound
        );
        fs::remove_dir_all(root).unwrap();
    }
}
