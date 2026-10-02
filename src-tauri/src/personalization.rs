//! Personal instructions and skills the chat can use.
//!
//! Two roots are read: AioLM's data folder (`AIOLM_HOME`, otherwise `.aiolm`)
//! and the shared `.agents` folder in the user's home folder. Each may hold an
//! `AGENTS.md` with standing instructions and a `skills` folder whose direct
//! subfolders each describe one skill in `SKILL.md`. Loading only reads: the
//! chat receives every instruction file and a catalog of skill names and
//! descriptions, and asks for a full `SKILL.md` by id when it needs one. No
//! skill script is ever run. Only an explicit save writes, and only the chosen
//! root's `AGENTS.md`.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const AGENTS_FILE: &str = "AGENTS.md";
const SKILLS_DIR: &str = "skills";
const SKILL_FILE: &str = "SKILL.md";
/// Upper bound for one `AGENTS.md` or `SKILL.md`. A larger file is reported
/// and left out instead of being cut short.
pub(crate) const MAX_FILE_BYTES: usize = 64 * 1024;
/// Skills offered to the chat after same-name skills are resolved.
pub(crate) const MAX_SKILLS: usize = 128;
/// Skill folders examined per root, so a huge folder cannot stall loading.
const MAX_SKILL_DIRECTORIES: usize = 2 * MAX_SKILLS;
/// Limits from the Agent Skills format for the catalog metadata.
const MAX_NAME_CHARS: usize = 64;
const MAX_DESCRIPTION_CHARS: usize = 1024;
/// Longest skill id the chat accepts, in UTF-16 code units.
const MAX_ID_UTF16: usize = 200;
const BOM: &[u8] = b"\xEF\xBB\xBF";
/// Saves from this process run one at a time, so two saves cannot both pass
/// the revision check before either writes.
static SAVE: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Source {
    Aiolm,
    Agents,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Aiolm => "aiolm",
            Source::Agents => "agents",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "aiolm" => Some(Source::Aiolm),
            "agents" => Some(Source::Agents),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct AgentInstructionsFile {
    pub source: Source,
    pub path: String,
    pub exists: bool,
    pub content: String,
    /// SHA-256 of the exact bytes on disk; `None` when the file is missing.
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ChatSkill {
    /// `<source>:<skill folder name>`, or `<source>:#<SHA-256 of the name>`
    /// for a folder name that is not a safe id. Given back to `read_skill`.
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: Source,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ChatPersonalization {
    pub instructions: Vec<AgentInstructionsFile>,
    pub skills: Vec<ChatSkill>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SkillContent {
    pub skill: ChatSkill,
    pub content: String,
}

/// Where each source lives, resolved when a command runs.
pub(crate) struct Roots {
    aiolm: Result<PathBuf, String>,
    agents: Result<PathBuf, String>,
}

impl Roots {
    pub(crate) fn current() -> Self {
        Self {
            aiolm: crate::home::resolve_aiolm_home(),
            agents: std::env::home_dir()
                .filter(|home| home.is_absolute())
                .map(|home| home.join(".agents"))
                .ok_or_else(|| {
                    "The home folder could not be determined, so ~/.agents was not read."
                        .to_string()
                }),
        }
    }

    fn get(&self, source: Source) -> Result<&Path, String> {
        let root = match source {
            Source::Aiolm => &self.aiolm,
            Source::Agents => &self.agents,
        };
        root.as_deref().map_err(Clone::clone)
    }
}

/// Everything the chat starts with. Missing roots and files are normal and
/// produce no warning; anything that exists but cannot be used is named in
/// `warnings` and left out.
pub(crate) fn load(roots: &Roots) -> ChatPersonalization {
    let mut warnings = Vec::new();
    let mut instructions = Vec::new();
    // Shared instructions first, then AioLM's own, so AioLM's can refine them.
    for source in [Source::Agents, Source::Aiolm] {
        match roots
            .get(source)
            .and_then(|root| read_instructions(root, source))
        {
            Ok(file) => instructions.push(file),
            Err(error) => warnings.push(error),
        }
    }
    let skills = catalog(roots, &mut warnings)
        .into_iter()
        .map(|entry| entry.skill)
        .collect();
    ChatPersonalization {
        instructions,
        skills,
        warnings,
    }
}

pub(crate) fn read_agents(roots: &Roots, source: Source) -> Result<AgentInstructionsFile, String> {
    read_instructions(roots.get(source)?, source)
}

/// Replaces the chosen root's `AGENTS.md` with `content`, but only while the
/// file still has `expected_revision` (`None`: it must still be missing), so
/// an edit made outside AioLM is never overwritten. A missing root and file
/// are created here and nowhere else. When `AGENTS.md` is a link, the file it
/// points to is replaced and the link is kept.
pub(crate) fn save_agents(
    roots: &Roots,
    source: Source,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<AgentInstructionsFile, String> {
    let root = roots.get(source)?;
    let path = root.join(AGENTS_FILE);
    let _guard = SAVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let target = write_target(&path)?;
    let current = match read_bounded(&target) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(file_error(&path, error)),
    };
    let current_revision = current.as_deref().map(revision);
    if current_revision.as_deref() != expected_revision {
        return Err(format!(
            "Save conflict: {} changed after it was opened. Your draft was not saved; reload the file before saving again.",
            path.display()
        ));
    }
    // A byte-order mark already on disk stays there; the editor never sees it.
    let mut bytes = Vec::with_capacity(BOM.len() + content.len());
    if current
        .as_deref()
        .is_some_and(|bytes| bytes.starts_with(BOM))
    {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(content.as_bytes());
    // The limit applies to what lands on disk, so the saved file can always
    // be read back.
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{} cannot be saved: it would be larger than {} KiB.",
            path.display(),
            MAX_FILE_BYTES / 1024
        ));
    }
    replace_file(&target, &bytes)
        .map_err(|error| format!("{} could not be saved: {error}", path.display()))?;
    Ok(AgentInstructionsFile {
        source,
        path: path.display().to_string(),
        exists: true,
        content: content.to_string(),
        revision: Some(revision(&bytes)),
    })
}

/// The full `SKILL.md` of a skill in the current catalog. Ids that are not in
/// the catalog, including any that try to name a path, are refused.
pub(crate) fn read_skill(roots: &Roots, id: &str) -> Result<SkillContent, String> {
    let unknown = || format!("The skill {id} is not available.");
    let (source, _) = id.split_once(':').ok_or_else(unknown)?;
    let source = Source::parse(source).ok_or_else(unknown)?;
    if !is_safe_id(id) {
        return Err(unknown());
    }
    let mut ignored = Vec::new();
    let folders = [Source::Agents, Source::Aiolm].map(|source| {
        roots
            .get(source)
            .map(|root| skill_folders(root, &mut ignored))
            .unwrap_or_default()
    });
    // With no more folders than offered skills the cap cannot leave this
    // skill out, so only the folders that decide its place are read.
    if folders.iter().map(Vec::len).sum::<usize>() <= MAX_SKILLS {
        let (skill, content) = listed_skill(source, id, &folders).ok_or_else(unknown)?;
        return Ok(SkillContent { skill, content });
    }
    let entry = catalog(roots, &mut ignored)
        .into_iter()
        .find(|entry| entry.skill.id == id)
        .ok_or_else(unknown)?;
    let content = read_skill_file(&entry.folder)?;
    Ok(SkillContent {
        skill: entry.skill,
        content,
    })
}

fn read_instructions(root: &Path, source: Source) -> Result<AgentInstructionsFile, String> {
    let path = root.join(AGENTS_FILE);
    let display = path.display().to_string();
    let bytes = match read_bounded(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(AgentInstructionsFile {
                source,
                path: display,
                exists: false,
                content: String::new(),
                revision: None,
            });
        }
        Err(error) => return Err(file_error(&path, error)),
    };
    Ok(AgentInstructionsFile {
        source,
        path: display,
        exists: true,
        content: decode(&path, &bytes)?,
        revision: Some(revision(&bytes)),
    })
}

/// The file a save replaces: `path` itself, or the file a link at `path`
/// points to. A link that cannot be followed to a file is an error rather
/// than something to replace with a plain file.
fn write_target(path: &Path) -> Result<PathBuf, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(path.to_path_buf()),
        Err(error) => return Err(file_error(path, error)),
    };
    if metadata.is_dir() {
        return Err(format!("{} is a folder, not a file.", path.display()));
    }
    if !metadata.file_type().is_symlink() {
        return Ok(path.to_path_buf());
    }
    let link_error = || {
        format!(
            "{} is a link whose target is not an existing file. AioLM will not replace the link; fix or remove it first.",
            path.display()
        )
    };
    let target = fs::canonicalize(path).map_err(|_| link_error())?;
    if !fs::metadata(&target).is_ok_and(|metadata| metadata.is_file()) {
        return Err(link_error());
    }
    Ok(target)
}

struct CatalogEntry {
    skill: ChatSkill,
    folder: PathBuf,
}

/// The skills offered to the chat, sorted by name. A skill in AioLM's root
/// replaces a shared skill of the same name.
fn catalog(roots: &Roots, warnings: &mut Vec<String>) -> Vec<CatalogEntry> {
    let mut by_name = BTreeMap::new();
    for source in [Source::Agents, Source::Aiolm] {
        let Ok(root) = roots.get(source) else {
            // `load` has already reported the missing root.
            continue;
        };
        let mut seen = BTreeMap::new();
        for (folder_name, folder) in skill_folders(root, warnings) {
            let skill = match read_entry(source, &folder_name, &folder) {
                Ok((skill, _)) => skill,
                Err(error) => {
                    warnings.push(format!("Skill skipped: {error}"));
                    continue;
                }
            };
            let name = skill.name.clone();
            if let Some(first) = seen.get(&name) {
                warnings.push(format!(
                    "Skill skipped: {} uses the name \"{name}\" already used by the {first} folder.",
                    skill.path
                ));
                continue;
            }
            seen.insert(name.clone(), folder_name.clone());
            by_name.insert(name, CatalogEntry { skill, folder });
        }
    }
    let mut entries = by_name.into_values().collect::<Vec<_>>();
    if entries.len() > MAX_SKILLS {
        let left_out = entries
            .split_off(MAX_SKILLS)
            .into_iter()
            .map(|entry| entry.skill.name)
            .collect::<Vec<_>>();
        warnings.push(format!(
            "Only the first {MAX_SKILLS} skills by name are offered; {} more were left out: {}.",
            left_out.len(),
            left_out.join(", ")
        ));
    }
    entries
}

/// The catalog entry for one skill folder and the `SKILL.md` text it was
/// read from.
fn read_entry(
    source: Source,
    folder_name: &str,
    folder: &Path,
) -> Result<(ChatSkill, String), String> {
    let display = folder.join(SKILL_FILE);
    let text = read_skill_file(folder)?;
    let (name, description) =
        metadata(&text).map_err(|error| format!("{}: {error}", display.display()))?;
    let skill = ChatSkill {
        id: skill_id(source, folder_name),
        name,
        description,
        source,
        path: display.display().to_string(),
    };
    Ok((skill, text))
}

/// The catalog skill `id` and its `SKILL.md` text, from the skill folders of
/// both roots (`[agents, aiolm]`) when they number no more than
/// `MAX_SKILLS`. Besides the skill's own folder, only the folders that could
/// take its name are read: earlier folders of its root, which keep a name
/// they share with it, and, for a shared skill, AioLM's folders, which
/// replace it by name.
fn listed_skill(
    source: Source,
    id: &str,
    [agents, aiolm]: &[Vec<(String, PathBuf)>; 2],
) -> Option<(ChatSkill, String)> {
    let own = match source {
        Source::Agents => agents,
        Source::Aiolm => aiolm,
    };
    let position = own
        .iter()
        .position(|(folder_name, _)| skill_id(source, folder_name) == id)?;
    let (folder_name, folder) = &own[position];
    let (skill, text) = read_entry(source, folder_name, folder).ok()?;
    let replacing: &[(String, PathBuf)] = match source {
        Source::Agents => aiolm,
        Source::Aiolm => &[],
    };
    let takes_name = |(_, folder): &(String, PathBuf)| {
        read_skill_file(folder)
            .is_ok_and(|text| metadata(&text).is_ok_and(|(name, _)| name == skill.name))
    };
    let taken = own[..position].iter().chain(replacing).any(takes_name);
    (!taken).then_some((skill, text))
}

/// Direct subfolders of `<root>/skills`, sorted by name. Linked folders are
/// included; hidden folders and plain files are not skills.
fn skill_folders(root: &Path, warnings: &mut Vec<String>) -> Vec<(String, PathBuf)> {
    let dir = root.join(SKILLS_DIR);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            warnings.push(format!("Skills skipped: {}", file_error(&dir, error)));
            return Vec::new();
        }
    };
    let mut folders = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!("Skills skipped: {}", file_error(&dir, error)));
                continue;
            }
        };
        let is_folder = entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() || kind.is_symlink());
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            if is_folder {
                warnings.push(format!(
                    "Skill skipped: {} has a name that is not valid Unicode.",
                    entry.path().display()
                ));
            }
            continue;
        };
        if is_folder && !name.starts_with('.') {
            folders.push((name, entry.path()));
        }
    }
    folders.sort();
    if folders.len() > MAX_SKILL_DIRECTORIES {
        let left_out = folders.split_off(MAX_SKILL_DIRECTORIES);
        warnings.push(format!(
            "Only the first {MAX_SKILL_DIRECTORIES} skill folders in {} were read; {} more were left out: {}.",
            dir.display(),
            left_out.len(),
            left_out
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    folders
}

/// Reads `SKILL.md` of one skill folder. The folder may be a link; the file
/// must resolve inside the folder it belongs to, so a linked `SKILL.md`
/// cannot pull in a file from elsewhere.
fn read_skill_file(folder: &Path) -> Result<String, String> {
    let display = folder.join(SKILL_FILE);
    let resolved_folder = fs::canonicalize(folder).map_err(|error| file_error(folder, error))?;
    if !resolved_folder.is_dir() {
        return Err(format!("{} is not a folder.", folder.display()));
    }
    let file = fs::canonicalize(resolved_folder.join(SKILL_FILE))
        .map_err(|error| file_error(&display, error))?;
    if !file.starts_with(&resolved_folder) {
        return Err(format!(
            "{} points outside its skill folder.",
            display.display()
        ));
    }
    let bytes = read_bounded(&file).map_err(|error| file_error(&display, error))?;
    decode(&display, &bytes)
}

/// `<source>:<folder>` when that is a safe id, otherwise `<source>:#` and the
/// SHA-256 of the folder name. Folder names starting with `#` are always
/// hashed, so a folder cannot take the id of another folder's hash.
fn skill_id(source: Source, folder: &str) -> String {
    let plain = format!("{}:{folder}", source.as_str());
    if !folder.starts_with('#') && is_safe_id(&plain) {
        plain
    } else {
        format!(
            "{}:#{:x}",
            source.as_str(),
            Sha256::digest(folder.as_bytes())
        )
    }
}

/// The chat's own check on ids (`isSafeSkillId`): at most 200 UTF-16 units,
/// no path separators, control characters, or `..`.
fn is_safe_id(id: &str) -> bool {
    let length = id.encode_utf16().count();
    (1..=MAX_ID_UTF16).contains(&length)
        && !id.contains(['/', '\\'])
        && !id.contains(char::is_control)
        && !id.contains("..")
}

/// Reads at most one byte past the limit, so an oversized file is detected
/// without reading all of it. Only regular files are read: the path is
/// checked before opening, so a FIFO or device is never opened and cannot
/// block, and the opened handle is checked again in case the path changed.
fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
    let not_a_file = || std::io::Error::new(ErrorKind::InvalidInput, "it is not a regular file");
    if !fs::metadata(path)?.is_file() {
        return Err(not_a_file());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Should the path become a FIFO after the check, opening it still
        // returns at once instead of waiting for a writer.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(not_a_file());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(std::io::Error::new(
            ErrorKind::FileTooLarge,
            format!("it is larger than {} KiB", MAX_FILE_BYTES / 1024),
        ));
    }
    Ok(bytes)
}

/// Writes `bytes` to a new file beside `target` and renames it over `target`,
/// so readers see the old or the new file and never a partial one. On Unix
/// the new file is created with the permissions of the file it replaces, so
/// a private (0600) `AGENTS.md` is never readable by others, not even while
/// it is being written.
fn replace_file(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "it has no parent folder"))?;
    fs::create_dir_all(parent)?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(AGENTS_FILE);
    let temp = parent.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mode = fs::metadata(target)
            .ok()
            .map(|metadata| metadata.permissions().mode() & 0o777);
        if let Some(mode) = mode {
            options.mode(mode);
        }
        mode
    };
    let result = (|| {
        let mut file = options.open(&temp)?;
        // `mode` above is narrowed by the umask; set it exactly.
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(mode))?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn file_error(path: &Path, error: std::io::Error) -> String {
    format!("{} could not be read: {error}.", path.display())
}

/// UTF-8 text, with a leading byte-order mark removed.
fn decode(path: &Path, bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.strip_prefix(BOM).unwrap_or(bytes).to_vec())
        .map_err(|_| format!("{} is not UTF-8 text.", path.display()))
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// `name` and `description` from the YAML frontmatter that opens a
/// `SKILL.md`. Only these two keys are read; plain, quoted, and block (`|`,
/// `>`) values are understood, including values continued on indented lines.
fn metadata(text: &str) -> Result<(String, String), String> {
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Err("it does not start with a --- frontmatter block.".to_string());
    }
    let mut block = Vec::new();
    let mut closed = false;
    for line in lines {
        if line.trim_end() == "---" {
            closed = true;
            break;
        }
        block.push(line);
    }
    if !closed {
        return Err("its frontmatter block is not closed with ---.".to_string());
    }

    let mut name = None;
    let mut description = None;
    let mut index = 0;
    while index < block.len() {
        let line = block[index];
        index += 1;
        if line.is_empty() || line.starts_with([' ', '\t', '#']) {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let start = index;
        while index < block.len()
            && (block[index].trim().is_empty() || block[index].starts_with([' ', '\t']))
        {
            index += 1;
        }
        let slot = match key.trim() {
            "name" => &mut name,
            "description" => &mut description,
            _ => continue,
        };
        if slot.is_some() {
            return Err(format!("its frontmatter repeats `{}`.", key.trim()));
        }
        *slot = Some(scalar(rest.trim(), &block[start..index])?);
    }

    let name = name
        .filter(|value: &String| !value.is_empty())
        .ok_or("its frontmatter has no `name`.")?;
    let description = description
        .filter(|value: &String| !value.is_empty())
        .ok_or("its frontmatter has no `description`.")?;
    if name.chars().count() > MAX_NAME_CHARS || name.contains(char::is_control) {
        return Err(format!(
            "its name must be one line of at most {MAX_NAME_CHARS} characters."
        ));
    }
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(format!(
            "its description is longer than {MAX_DESCRIPTION_CHARS} characters."
        ));
    }
    Ok((name, description))
}

/// One YAML scalar: `first` follows the colon, `more` are the indented lines
/// under it. The result is trimmed.
fn scalar(first: &str, more: &[&str]) -> Result<String, String> {
    if let Some(header) = first.strip_prefix(['|', '>']) {
        if !header
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            .chars()
            .all(|c| matches!(c, '+' | '-' | '1'..='9'))
        {
            return Err("its frontmatter has an unsupported block value.".to_string());
        }
        let indent = more
            .iter()
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.len() - line.trim_start().len())
            .min()
            .unwrap_or(0);
        let lines = more
            .iter()
            .map(|line| line.get(indent..).unwrap_or("").trim_end())
            .collect::<Vec<_>>();
        let value = if first.starts_with('|') {
            lines.join("\n")
        } else {
            fold(&lines)
        };
        return Ok(value.trim().to_string());
    }
    let mut lines = vec![first];
    lines.extend(more.iter().map(|line| line.trim()));
    let joined = fold(&lines);
    let value = if let Some(body) = joined.strip_prefix('"') {
        double_quoted(body)?
    } else if let Some(body) = joined.strip_prefix('\'') {
        single_quoted(body)?
    } else {
        match joined.find(" #") {
            Some(comment) => joined[..comment].to_string(),
            None => joined,
        }
    };
    Ok(value.trim().to_string())
}

/// Joins lines with spaces; an empty line becomes a line break.
fn fold(lines: &[&str]) -> String {
    let mut value = String::new();
    let mut pending_space = false;
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            value.push('\n');
            pending_space = false;
        } else {
            if pending_space {
                value.push(' ');
            }
            value.push_str(line);
            pending_space = true;
        }
    }
    value
}

fn after_quote(rest: &str) -> Result<(), String> {
    let rest = rest.trim();
    if rest.is_empty() || rest.starts_with('#') {
        Ok(())
    } else {
        Err("its frontmatter has text after a quoted value.".to_string())
    }
}

fn single_quoted(body: &str) -> Result<String, String> {
    let mut value = String::new();
    let mut chars = body.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if c != '\'' {
            value.push(c);
        } else if chars.peek().is_some_and(|(_, next)| *next == '\'') {
            chars.next();
            value.push('\'');
        } else {
            after_quote(&body[at + 1..])?;
            return Ok(value);
        }
    }
    Err("its frontmatter has an unclosed quoted value.".to_string())
}

fn double_quoted(body: &str) -> Result<String, String> {
    let invalid = || "its frontmatter has an invalid escape in a quoted value.".to_string();
    let mut value = String::new();
    let mut chars = body.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '"' => {
                after_quote(&body[at + 1..])?;
                return Ok(value);
            }
            '\\' => {
                let (_, escaped) = chars.next().ok_or_else(invalid)?;
                value.push(match escaped {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    '0' => '\0',
                    '"' | '\\' | '/' | ' ' => escaped,
                    'u' => {
                        let hex = (0..4)
                            .map(|_| chars.next().map(|(_, c)| c))
                            .collect::<Option<String>>()
                            .ok_or_else(invalid)?;
                        u32::from_str_radix(&hex, 16)
                            .ok()
                            .and_then(char::from_u32)
                            .ok_or_else(invalid)?
                    }
                    _ => return Err(invalid()),
                });
            }
            _ => value.push(c),
        }
    }
    Err("its frontmatter has an unclosed quoted value.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        base: PathBuf,
        roots: Roots,
    }

    impl Fixture {
        /// Two roots that do not exist yet, inside a fresh temporary folder.
        fn new() -> Self {
            let base = std::env::temp_dir()
                .join(format!("aiolm-personalization-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&base).unwrap();
            let roots = Roots {
                aiolm: Ok(base.join("aiolm")),
                agents: Ok(base.join("agents")),
            };
            Self { base, roots }
        }

        fn root(&self, source: Source) -> PathBuf {
            self.roots.get(source).unwrap().to_path_buf()
        }

        fn write(&self, source: Source, relative: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
            let path = self.root(source).join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        }

        fn skill(&self, source: Source, folder: &str, name: &str, description: &str) {
            self.write(
                source,
                &format!("skills/{folder}/SKILL.md"),
                format!("---\nname: {name}\ndescription: {description}\n---\n# {name}\nBody.\n"),
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn names(personalization: &ChatPersonalization) -> Vec<(&str, Source)> {
        personalization
            .skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.source))
            .collect()
    }

    #[test]
    fn missing_roots_load_as_empty_without_warnings_or_side_effects() {
        let fixture = Fixture::new();
        let loaded = load(&fixture.roots);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        assert!(loaded.skills.is_empty());
        let sources = loaded
            .instructions
            .iter()
            .map(|file| {
                (
                    file.source,
                    file.exists,
                    file.content.as_str(),
                    file.revision.clone(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            sources,
            vec![
                (Source::Agents, false, "", None),
                (Source::Aiolm, false, "", None)
            ]
        );
        // Loading never creates a root.
        assert!(!fixture.root(Source::Aiolm).exists());
        assert!(!fixture.root(Source::Agents).exists());
    }

    #[test]
    fn an_unresolvable_root_is_a_warning_and_the_other_root_still_loads() {
        let mut fixture = Fixture::new();
        fixture.write(Source::Aiolm, "AGENTS.md", "Use metric units.");
        fixture.roots.agents = Err("no home folder".to_string());
        let loaded = load(&fixture.roots);
        assert_eq!(loaded.warnings, vec!["no home folder".to_string()]);
        assert_eq!(loaded.instructions.len(), 1);
        assert_eq!(loaded.instructions[0].content, "Use metric units.");
    }

    #[test]
    fn both_instruction_files_load_shared_first_with_bom_removed_and_exact_revisions() {
        let fixture = Fixture::new();
        let shared = b"\xEF\xBB\xBFShared rules.\r\n";
        fixture.write(Source::Agents, "AGENTS.md", shared);
        fixture.write(Source::Aiolm, "AGENTS.md", "AioLM rules.");
        let loaded = load(&fixture.roots);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        let agents = &loaded.instructions[0];
        assert_eq!(agents.source, Source::Agents);
        assert!(agents.exists);
        assert_eq!(agents.content, "Shared rules.\r\n");
        // The revision covers the bytes on disk, mark included.
        assert_eq!(agents.revision.as_deref(), Some(revision(shared).as_str()));
        assert_eq!(loaded.instructions[1].source, Source::Aiolm);
        assert_eq!(loaded.instructions[1].content, "AioLM rules.");
    }

    #[test]
    fn oversized_or_non_utf8_instructions_are_reported_not_truncated() {
        let fixture = Fixture::new();
        fixture.write(Source::Agents, "AGENTS.md", vec![b'a'; MAX_FILE_BYTES + 1]);
        fixture.write(Source::Aiolm, "AGENTS.md", [0xff, 0xfe, 0x00]);
        let loaded = load(&fixture.roots);
        assert!(loaded.instructions.is_empty());
        assert_eq!(loaded.warnings.len(), 2, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("larger than 64 KiB"));
        assert!(loaded.warnings[1].contains("not UTF-8"));
        // Exactly at the limit is still accepted.
        fixture.write(Source::Agents, "AGENTS.md", vec![b'a'; MAX_FILE_BYTES]);
        assert_eq!(
            read_agents(&fixture.roots, Source::Agents)
                .unwrap()
                .content
                .len(),
            MAX_FILE_BYTES
        );
    }

    #[test]
    fn skills_are_a_sorted_metadata_catalog_and_aiolm_wins_a_shared_name() {
        let fixture = Fixture::new();
        fixture.skill(Source::Agents, "review", "review", "Shared review.");
        fixture.skill(Source::Agents, "plan", "plan", "Shared planning.");
        fixture.skill(Source::Aiolm, "my-review", "review", "AioLM review.");
        let loaded = load(&fixture.roots);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        assert_eq!(
            names(&loaded),
            vec![("plan", Source::Agents), ("review", Source::Aiolm)]
        );
        let review = &loaded.skills[1];
        assert_eq!(review.id, "aiolm:my-review");
        assert_eq!(review.description, "AioLM review.");
        // The catalog holds metadata only; the body comes from read_skill.
        let read = read_skill(&fixture.roots, &review.id).unwrap();
        assert!(read.content.contains("# review\nBody."));
        assert_eq!(read.skill.description, "AioLM review.");
        // The shadowed shared skill is not offered.
        assert!(read_skill(&fixture.roots, "agents:review").is_err());
    }

    #[test]
    fn a_repeated_name_within_one_root_keeps_the_first_folder_and_warns() {
        let fixture = Fixture::new();
        fixture.skill(Source::Aiolm, "a", "dup", "First.");
        fixture.skill(Source::Aiolm, "b", "dup", "Second.");
        let loaded = load(&fixture.roots);
        assert_eq!(loaded.skills.len(), 1);
        assert_eq!(loaded.skills[0].id, "aiolm:a");
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].contains("already used by the a folder"));
    }

    /// Every skill folder of both roots reads through `read_skill` exactly
    /// when the full catalog offers it, with the same metadata and the file's
    /// text.
    fn assert_read_skill_matches_catalog(fixture: &Fixture) {
        let loaded = load(&fixture.roots);
        let mut checked = 0;
        for source in [Source::Agents, Source::Aiolm] {
            let Ok(entries) = fs::read_dir(fixture.root(source).join(SKILLS_DIR)) else {
                continue;
            };
            for entry in entries {
                let folder = entry.unwrap().file_name().into_string().unwrap();
                let id = skill_id(source, &folder);
                let offered = loaded.skills.iter().find(|skill| skill.id == id);
                match (offered, read_skill(&fixture.roots, &id)) {
                    (Some(offered), Ok(read)) => {
                        assert_eq!(read.skill.name, offered.name, "{id}");
                        assert_eq!(read.skill.description, offered.description, "{id}");
                        assert_eq!(read.skill.source, offered.source, "{id}");
                        assert_eq!(read.skill.path, offered.path, "{id}");
                        assert_eq!(read.content, fs::read_to_string(&offered.path).unwrap());
                    }
                    (None, Err(error)) => assert!(error.contains("is not available"), "{error}"),
                    (offered, read) => panic!("{id}: catalog {offered:?}, read_skill {read:?}"),
                }
                checked += 1;
            }
        }
        assert!(checked > 0);
    }

    #[test]
    fn read_skill_offers_exactly_the_catalog_with_its_name_priority_and_validation() {
        let fixture = Fixture::new();
        // Within one root the first folder keeps a shared name.
        fixture.skill(Source::Agents, "a-first", "alpha", "First alpha.");
        fixture.skill(Source::Agents, "b-second", "alpha", "Second alpha.");
        // AioLM replaces a shared skill by name, from any of its folders.
        fixture.skill(Source::Agents, "c-shared", "shared", "Shared.");
        fixture.skill(Source::Aiolm, "z-late", "shared", "AioLM shared.");
        fixture.skill(Source::Agents, "d-beta", "beta", "Shared beta.");
        fixture.skill(Source::Aiolm, "a-beta", "beta", "AioLM beta.");
        fixture.skill(Source::Aiolm, "b-beta", "beta", "Later AioLM beta.");
        // An unusable AioLM folder replaces nothing, and is not offered.
        fixture.skill(Source::Agents, "e-gamma", "gamma", "Shared gamma.");
        fixture.write(
            Source::Aiolm,
            "skills/c-broken/SKILL.md",
            "---\nname: gamma\n---\n",
        );
        fixture.skill(Source::Agents, "g-delta", "delta", "Shared delta.");
        let mut huge = b"---\nname: delta\ndescription: d\n---\n".to_vec();
        huge.resize(MAX_FILE_BYTES + 1, b'x');
        fixture.write(Source::Aiolm, "skills/d-huge/SKILL.md", huge);
        fixture.write(Source::Agents, "skills/f-empty/README.md", "No skill here.");
        fixture.skill(Source::Agents, "#hashed", "hashed", "Hashed id.");
        assert_read_skill_matches_catalog(&fixture);
        let loaded = load(&fixture.roots);
        let offered = loaded
            .skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.description.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            offered,
            vec![
                ("alpha", "First alpha."),
                ("beta", "AioLM beta."),
                ("delta", "Shared delta."),
                ("gamma", "Shared gamma."),
                ("hashed", "Hashed id."),
                ("shared", "AioLM shared."),
            ]
        );
        // Each read sees the files as they are now: a later edit that takes a
        // name moves the skill without any reload.
        fixture.skill(Source::Aiolm, "c-broken", "gamma", "Fixed AioLM gamma.");
        assert!(read_skill(&fixture.roots, "agents:e-gamma").is_err());
        assert_eq!(
            read_skill(&fixture.roots, "aiolm:c-broken")
                .unwrap()
                .skill
                .description,
            "Fixed AioLM gamma."
        );
        assert_read_skill_matches_catalog(&fixture);
        // A folder renamed after loading is read under its new id only, and
        // a rename can hand the first-folder name to another folder.
        let skills = fixture.root(Source::Agents).join(SKILLS_DIR);
        fs::rename(skills.join("a-first"), skills.join("h-first")).unwrap();
        assert!(read_skill(&fixture.roots, "agents:a-first").is_err());
        assert!(read_skill(&fixture.roots, "agents:h-first").is_err());
        assert_eq!(
            read_skill(&fixture.roots, "agents:b-second")
                .unwrap()
                .skill
                .description,
            "Second alpha."
        );
        assert_read_skill_matches_catalog(&fixture);
    }

    #[test]
    fn read_skill_refuses_a_folder_past_the_per_root_folder_limit() {
        let fixture = Fixture::new();
        for index in 0..=MAX_SKILL_DIRECTORIES {
            let folder = format!("skill-{index:03}");
            fixture.skill(Source::Agents, &folder, &folder, "d");
        }
        let last = format!("agents:skill-{MAX_SKILL_DIRECTORIES:03}");
        assert!(load(&fixture.roots).warnings[0].contains("skill folders"));
        assert!(read_skill(&fixture.roots, &last).is_err());
        // Folders read but beyond the skill cap are refused as well.
        assert!(read_skill(&fixture.roots, "agents:skill-128").is_err());
        assert!(read_skill(&fixture.roots, "agents:skill-000").is_ok());
    }

    #[test]
    fn frontmatter_accepts_quoted_and_multiline_values() {
        let text = "\u{feff}---\r\nname: \"quoted \\\"name\\\"\"\r\nlicense: MIT\r\nmetadata:\r\n  description: nested is ignored\r\ndescription: >-\r\n  Folded line one\r\n  and two.\r\n\r\n  New paragraph.\r\n---\r\nBody\r\n";
        let text = text.strip_prefix('\u{feff}').unwrap();
        assert_eq!(
            metadata(text).unwrap(),
            (
                "quoted \"name\"".to_string(),
                "Folded line one and two.\nNew paragraph.".to_string()
            )
        );
        let literal = "---\nname: 'it''s'\ndescription: |\n  Line one\n  Line two\n---\n";
        assert_eq!(
            metadata(literal).unwrap(),
            ("it's".to_string(), "Line one\nLine two".to_string())
        );
        let plain = "---\nname: plain # comment\ndescription: Starts here\n  and continues.\n---\n";
        assert_eq!(
            metadata(plain).unwrap(),
            (
                "plain".to_string(),
                "Starts here and continues.".to_string()
            )
        );
    }

    #[test]
    fn malformed_and_oversized_skills_are_reported_and_left_out() {
        let fixture = Fixture::new();
        fixture.write(Source::Aiolm, "skills/no-front/SKILL.md", "# Just text\n");
        fixture.write(Source::Aiolm, "skills/unclosed/SKILL.md", "---\nname: x\n");
        fixture.write(
            Source::Aiolm,
            "skills/no-description/SKILL.md",
            "---\nname: x\n---\n",
        );
        fixture.write(
            Source::Aiolm,
            "skills/bad-quote/SKILL.md",
            "---\nname: \"open\ndescription: d\n---\n",
        );
        let mut huge = b"---\nname: huge\ndescription: d\n---\n".to_vec();
        huge.resize(MAX_FILE_BYTES + 1, b'x');
        fixture.write(Source::Aiolm, "skills/huge/SKILL.md", huge);
        fs::create_dir_all(fixture.root(Source::Aiolm).join("skills/empty")).unwrap();
        fixture.write(Source::Aiolm, "skills/README.md", "not a skill folder");
        fs::create_dir_all(fixture.root(Source::Aiolm).join("skills/.system")).unwrap();
        fixture.skill(Source::Aiolm, "good", "good", "Works.");
        let loaded = load(&fixture.roots);
        assert_eq!(names(&loaded), vec![("good", Source::Aiolm)]);
        // One warning per unusable folder; the plain file and hidden folder
        // are not skills at all.
        assert_eq!(loaded.warnings.len(), 6, "{:#?}", loaded.warnings);
        assert!(loaded
            .warnings
            .iter()
            .any(|w| w.contains("larger than 64 KiB")));
    }

    #[test]
    fn only_direct_skill_folders_are_discovered_and_ids_cannot_name_paths() {
        let fixture = Fixture::new();
        fixture.write(
            Source::Aiolm,
            "skills/group/nested/SKILL.md",
            "---\nname: nested\ndescription: d\n---\n",
        );
        fixture.write(
            Source::Aiolm,
            "secret/SKILL.md",
            "---\nname: s\ndescription: d\n---\n",
        );
        fixture.skill(Source::Aiolm, "real", "real", "Real.");
        let loaded = load(&fixture.roots);
        assert_eq!(names(&loaded), vec![("real", Source::Aiolm)]);
        for id in [
            "aiolm:group/nested",
            "aiolm:group\\nested",
            "aiolm:../secret",
            "aiolm:..",
            "aiolm:",
            "elsewhere:real",
            "real",
            "AIOLM:real",
        ] {
            assert!(read_skill(&fixture.roots, id).is_err(), "{id}");
        }
        assert!(read_skill(&fixture.roots, "aiolm:real").is_ok());
    }

    /// The chat's `isSafeSkillId`, restated so the ids are checked against it.
    fn chat_accepts(id: &str) -> bool {
        let length = id.encode_utf16().count();
        length > 0
            && length <= 200
            && !id
                .chars()
                .any(|c| matches!(c, '/' | '\\' | '\u{0}'..='\u{1f}' | '\u{7f}'))
            && !id.contains("..")
    }

    #[test]
    fn unusual_folder_names_get_stable_opaque_ids_that_resolve_only_through_the_catalog() {
        let fixture = Fixture::new();
        let long = "l".repeat(MAX_ID_UTF16);
        let dotted = "foo..bar";
        let hashed_dotted = skill_id(Source::Aiolm, dotted);
        // A folder named like another folder's hashed id is hashed itself.
        let impostor = hashed_dotted.trim_start_matches("aiolm:").to_string();
        let folders = [
            "pdf".to_string(),
            "한글-스킬".to_string(),
            dotted.to_string(),
            long.clone(),
            impostor,
        ]
        .into_iter()
        // Windows does not allow control characters in file names.
        .chain(cfg!(unix).then(|| "tab\there".to_string()))
        .collect::<Vec<_>>();
        for (index, folder) in folders.iter().enumerate() {
            fixture.skill(Source::Aiolm, folder, &format!("skill-{index}"), "d");
        }

        let loaded = load(&fixture.roots);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        assert_eq!(loaded.skills.len(), folders.len());
        let id_of = |name: &str| {
            loaded
                .skills
                .iter()
                .find(|skill| skill.name == name)
                .unwrap()
                .id
                .clone()
        };
        assert_eq!(id_of("skill-0"), "aiolm:pdf");
        assert_eq!(id_of("skill-1"), "aiolm:한글-스킬");
        assert_eq!(id_of("skill-2"), hashed_dotted);
        assert!(id_of("skill-3").starts_with("aiolm:#"));
        assert_ne!(id_of("skill-4"), hashed_dotted);
        assert!(id_of("skill-4").starts_with("aiolm:#"));
        let mut ids = loaded
            .skills
            .iter()
            .map(|skill| skill.id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), folders.len());
        // Ids are the same on every load, and each reads its own skill.
        let again = load(&fixture.roots);
        for skill in &loaded.skills {
            assert!(chat_accepts(&skill.id), "{}", skill.id);
            assert!(again.skills.iter().any(|other| other.id == skill.id));
            let read = read_skill(&fixture.roots, &skill.id).unwrap();
            assert_eq!(read.skill.name, skill.name);
            assert!(read.content.contains(&format!("name: {}", skill.name)));
        }
        // Raw folder names and hashes outside the catalog are refused.
        for id in [
            "aiolm:foo..bar".to_string(),
            format!("aiolm:{long}"),
            format!("aiolm:#{}", "0".repeat(64)),
            format!("agents:{}", hashed_dotted.trim_start_matches("aiolm:")),
        ] {
            assert!(read_skill(&fixture.roots, &id).is_err(), "{id}");
        }
    }

    #[test]
    fn the_catalog_is_capped_with_a_warning_naming_what_was_left_out() {
        let fixture = Fixture::new();
        for index in 0..=MAX_SKILLS {
            let name = format!("skill-{index:03}");
            fixture.skill(Source::Aiolm, &name, &name, "d");
        }
        let loaded = load(&fixture.roots);
        assert_eq!(loaded.skills.len(), MAX_SKILLS);
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].contains("1 more were left out: skill-128."));
        // A skill the cap left out cannot be read either.
        assert!(read_skill(&fixture.roots, "aiolm:skill-128").is_err());
        assert_eq!(
            read_skill(&fixture.roots, "aiolm:skill-127")
                .unwrap()
                .skill
                .name,
            "skill-127"
        );
        assert_read_skill_matches_catalog(&fixture);
    }

    #[test]
    fn save_creates_a_missing_file_and_then_requires_its_current_revision() {
        let fixture = Fixture::new();
        let saved = save_agents(&fixture.roots, Source::Aiolm, "First.", None).unwrap();
        let path = fixture.root(Source::Aiolm).join("AGENTS.md");
        assert_eq!(fs::read(&path).unwrap(), b"First.");
        assert_eq!(
            saved.revision.as_deref(),
            Some(revision(b"First.").as_str())
        );
        assert_eq!(
            read_agents(&fixture.roots, Source::Aiolm).unwrap().revision,
            saved.revision
        );
        // Saving as if the file were still missing is a conflict.
        let error = save_agents(&fixture.roots, Source::Aiolm, "Other.", None).unwrap_err();
        assert!(error.starts_with("Save conflict:"), "{error}");
        let next = save_agents(
            &fixture.roots,
            Source::Aiolm,
            "Second.",
            saved.revision.as_deref(),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"Second.");
        assert_ne!(next.revision, saved.revision);
        // The other root was not touched.
        assert!(!fixture.root(Source::Agents).exists());
        // No temporary file is left next to the saved one.
        assert_eq!(
            fs::read_dir(fixture.root(Source::Aiolm)).unwrap().count(),
            1
        );
    }

    #[test]
    fn an_edit_made_elsewhere_is_never_overwritten() {
        let fixture = Fixture::new();
        let path = fixture.write(Source::Agents, "AGENTS.md", "Opened.");
        let opened = read_agents(&fixture.roots, Source::Agents).unwrap();
        fs::write(&path, "Edited elsewhere.").unwrap();
        let error = save_agents(
            &fixture.roots,
            Source::Agents,
            "Draft.",
            opened.revision.as_deref(),
        )
        .unwrap_err();
        assert!(error.starts_with("Save conflict:"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), b"Edited elsewhere.");
        // A file deleted elsewhere is a conflict too, and is not recreated.
        fs::remove_file(&path).unwrap();
        assert!(save_agents(
            &fixture.roots,
            Source::Agents,
            "Draft.",
            opened.revision.as_deref()
        )
        .unwrap_err()
        .starts_with("Save conflict:"));
        assert!(!path.exists());
    }

    #[test]
    fn save_keeps_a_byte_order_mark_and_refuses_oversized_content() {
        let fixture = Fixture::new();
        let path = fixture.write(Source::Aiolm, "AGENTS.md", b"\xEF\xBB\xBFOld.");
        let opened = read_agents(&fixture.roots, Source::Aiolm).unwrap();
        assert_eq!(opened.content, "Old.");
        save_agents(
            &fixture.roots,
            Source::Aiolm,
            "New.",
            opened.revision.as_deref(),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFNew.");
    }

    #[test]
    fn the_size_limit_applies_to_the_bytes_written_including_a_kept_bom() {
        let fixture = Fixture::new();
        // Without a mark, exactly the limit is saved and reads back.
        let exact = "a".repeat(MAX_FILE_BYTES);
        let saved = save_agents(&fixture.roots, Source::Agents, &exact, None).unwrap();
        assert_eq!(
            read_agents(&fixture.roots, Source::Agents)
                .unwrap()
                .revision,
            saved.revision
        );
        let error = save_agents(
            &fixture.roots,
            Source::Agents,
            &format!("{exact}a"),
            saved.revision.as_deref(),
        )
        .unwrap_err();
        assert!(error.contains("larger than 64 KiB"), "{error}");

        // With a kept mark, the mark counts: the limit minus three bytes fits.
        let path = fixture.write(Source::Aiolm, "AGENTS.md", b"\xEF\xBB\xBFOld.");
        let opened = read_agents(&fixture.roots, Source::Aiolm).unwrap();
        let error = save_agents(
            &fixture.roots,
            Source::Aiolm,
            &"b".repeat(MAX_FILE_BYTES - BOM.len() + 1),
            opened.revision.as_deref(),
        )
        .unwrap_err();
        assert!(error.contains("larger than 64 KiB"), "{error}");
        // A refused save leaves the file as it was and nothing beside it.
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFOld.");
        assert_eq!(
            fs::read_dir(fixture.root(Source::Aiolm)).unwrap().count(),
            1
        );

        let fits = "b".repeat(MAX_FILE_BYTES - BOM.len());
        save_agents(
            &fixture.roots,
            Source::Aiolm,
            &fits,
            opened.revision.as_deref(),
        )
        .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), MAX_FILE_BYTES as u64);
        assert_eq!(
            read_agents(&fixture.roots, Source::Aiolm).unwrap().content,
            fits
        );
    }

    #[cfg(unix)]
    #[test]
    fn saving_keeps_the_permissions_of_the_replaced_file() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let path = fixture.write(Source::Aiolm, "AGENTS.md", "Private.");
        for mode in [0o600, 0o640] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            let opened = read_agents(&fixture.roots, Source::Aiolm).unwrap();
            save_agents(
                &fixture.roots,
                Source::Aiolm,
                "Still private.",
                opened.revision.as_deref(),
            )
            .unwrap();
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_without_waiting_for_a_writer() {
        let fixture = Fixture::new();
        let path = fixture.root(Source::Aiolm).join("AGENTS.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let c_path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        // Opening a FIFO for reading would block here without the check.
        let error = read_agents(&fixture.roots, Source::Aiolm).unwrap_err();
        assert!(error.contains("not a regular file"), "{error}");
        let loaded = load(&fixture.roots);
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
    }

    #[test]
    fn a_directory_is_not_read_as_a_file() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root(Source::Agents).join("AGENTS.md")).unwrap();
        let error = read_agents(&fixture.roots, Source::Agents).unwrap_err();
        assert!(error.contains("not a regular file"), "{error}");
    }

    #[test]
    fn a_folder_named_agents_md_is_not_replaced() {
        let fixture = Fixture::new();
        let path = fixture.root(Source::Aiolm).join("AGENTS.md");
        fs::create_dir_all(&path).unwrap();
        assert!(save_agents(&fixture.roots, Source::Aiolm, "x", None).is_err());
        assert!(path.is_dir());
    }

    #[cfg(unix)]
    fn link_file(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    fn link_file(target: &Path, link: &Path) -> bool {
        // Needs Developer Mode or elevation; tests that need it skip otherwise.
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }

    #[cfg(unix)]
    fn link_folder(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    fn link_folder(target: &Path, link: &Path) -> bool {
        // A junction needs no extra rights, so folder links are covered even
        // where symbolic links are not allowed.
        std::os::windows::fs::symlink_dir(target, link).is_ok()
            || std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output()
                .is_ok_and(|output| output.status.success())
    }

    #[test]
    fn saving_through_a_linked_agents_md_replaces_its_target_and_keeps_the_link() {
        let fixture = Fixture::new();
        let target = fixture.base.join("dotfiles").join("agents.md");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "Linked.").unwrap();
        let link = fixture.root(Source::Agents).join("AGENTS.md");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        if !link_file(&target, &link) {
            eprintln!("skipped: symbolic links are not available here");
            return;
        }
        let opened = read_agents(&fixture.roots, Source::Agents).unwrap();
        assert_eq!(opened.content, "Linked.");
        save_agents(
            &fixture.roots,
            Source::Agents,
            "Updated.",
            opened.revision.as_deref(),
        )
        .unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"Updated.");

        // A link whose target is gone reads as missing but is never replaced.
        fs::remove_file(&target).unwrap();
        assert!(!read_agents(&fixture.roots, Source::Agents).unwrap().exists);
        let error = save_agents(&fixture.roots, Source::Agents, "New.", None).unwrap_err();
        assert!(error.contains("will not replace the link"), "{error}");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!target.exists());
    }

    #[test]
    fn a_linked_skill_folder_loads_but_its_skill_md_cannot_point_outside_it() {
        let fixture = Fixture::new();
        let installed = fixture.base.join("installed").join("deploy");
        fs::create_dir_all(&installed).unwrap();
        fs::write(
            installed.join("SKILL.md"),
            "---\nname: deploy\ndescription: Linked install.\n---\nSteps.\n",
        )
        .unwrap();
        let skills = fixture.root(Source::Agents).join("skills");
        fs::create_dir_all(&skills).unwrap();
        if !link_folder(&installed, &skills.join("deploy")) {
            eprintln!("skipped: symbolic links are not available here");
            return;
        }
        let loaded = load(&fixture.roots);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        assert_eq!(names(&loaded), vec![("deploy", Source::Agents)]);
        assert_eq!(loaded.skills[0].id, "agents:deploy");
        let read = read_skill(&fixture.roots, "agents:deploy").unwrap();
        assert!(read.content.ends_with("Steps.\n"));

        let outside = fixture.base.join("outside.md");
        fs::write(&outside, "---\nname: escape\ndescription: d\n---\n").unwrap();
        fs::create_dir_all(skills.join("escape")).unwrap();
        if !link_file(&outside, &skills.join("escape").join("SKILL.md")) {
            eprintln!("skipped: symbolic file links are not available here");
            return;
        }
        let loaded = load(&fixture.roots);
        assert_eq!(names(&loaded), vec![("deploy", Source::Agents)]);
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("outside its skill folder"));
        assert!(read_skill(&fixture.roots, "agents:escape").is_err());
    }
}
