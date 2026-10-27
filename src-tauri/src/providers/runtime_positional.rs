//! The registered entry a command line starts with, and where help's
//! positional slots go in it. Help shows positional names and order, never
//! whether the launch template already fills a slot (a model path, a fixed
//! token) or the user may. A slot is user-settable only after an explicit
//! role is confirmed for it. Confirmed roles describe the whole positional
//! layout: the template tokens they name are lifted out of the template and
//! emitted with the user's values in declared slot order, so user slots may
//! precede, separate or follow template-filled ones.
use super::{
    registry::{self, ArgBinding, RuntimeManifest},
    runtime_command::CommandLayout,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Who fills one help positional slot.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "role", rename_all = "snake_case", deny_unknown_fields)]
pub enum PositionalRole {
    /// The user supplies its values.
    User,
    /// The launch template's positional binding with this name fills it.
    Binding { name: String },
    /// The entry prefix's literal token at this index fills it.
    Static { index: usize },
}

/// The selected runtime's registered command head, from adapter/entry data:
/// what a pasted full command starts with and which template tokens can
/// occupy positional slots. Never derived from text search or engine IDs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CommandEntry {
    pub version: u32,
    pub program: String,
    pub prefix: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<CommandLayout>,
    /// Explicit boundary after the app-owned bindings (a bridge's `--`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub separator: Option<String>,
    /// Positional bindings the template places after the prefix, in order.
    /// `None` when the manifest does not declare its bindings explicitly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub positional_bindings: Option<Vec<String>>,
    /// The positional roles in effect for the selected runtime's reviewed
    /// help (confirmed, current and valid as a layout); empty otherwise.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub positional_roles: BTreeMap<String, PositionalRole>,
}

pub const ENTRY_VERSION: u32 = 1;

impl CommandEntry {
    pub fn from_manifest(manifest: &RuntimeManifest) -> Self {
        let bindings = manifest.launch_bindings.as_ref();
        Self {
            version: ENTRY_VERSION,
            program: manifest.launch.program.clone(),
            prefix: registry::launch_prefix(manifest),
            layout: manifest.command_layout.clone(),
            separator: bindings.and_then(|b| b.options_separator.clone()),
            positional_bindings: bindings.map(|b| {
                b.bindings
                    .iter()
                    .filter(|bound| matches!(bound.argument, ArgBinding::Positional))
                    .map(|bound| bound.name.clone())
                    .collect()
            }),
            positional_roles: BTreeMap::new(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version != ENTRY_VERSION {
            return Err("unsupported command entry version; update the app".into());
        }
        if self.prefix.len() > 128 || self.program.is_empty() {
            return Err("invalid command entry".into());
        }
        if let Some(layout) = &self.layout {
            layout.validate(&self.prefix)?;
        }
        if self.separator.as_deref().is_some_and(|s| s != "--") {
            return Err("command entry separator must be --".into());
        }
        Ok(())
    }

    /// Literal prefix tokens that may fill the help scope's positional slots:
    /// with a declared layout, every token after the last declared subcommand
    /// (or, with none, in the prefix) that is not a fixed option or its value.
    /// After a subcommand they are proven arguments of that command; without
    /// one they may be interpreter tokens and move only if mapped. Without a
    /// layout no prefix token's role is known, so none can be relocated.
    pub fn static_candidates(&self) -> Vec<usize> {
        let Some(layout) = &self.layout else {
            return Vec::new();
        };
        let owned: BTreeSet<usize> = layout
            .options
            .iter()
            .flat_map(|o| o.index..=o.index + o.values)
            .collect();
        let start = layout.subcommands.last().map_or(0, |last| last + 1);
        (start..self.prefix.len())
            .filter(|index| !owned.contains(index))
            .collect()
    }
}

/// Check confirmed roles for the help scope's positional slots as one
/// layout. `slots` are (key, help position). Every template token that is
/// positional to the help scope must be given a slot, since a token left in
/// place would take the first slot; mapped slots must be a leading run so no
/// unmapped slot shifts a later value. User slots may sit anywhere in it.
pub fn validate_roles(
    entry: Option<&CommandEntry>,
    slots: &[(String, u16)],
    roles: &BTreeMap<String, PositionalRole>,
) -> Result<(), String> {
    if roles.is_empty() {
        return Ok(());
    }
    let entry = entry.ok_or(
        "this runtime's launch command does not declare where positional arguments go; positional roles cannot be confirmed for it",
    )?;
    entry.validate()?;
    let bindings = entry.positional_bindings.as_ref().ok_or(
        "this runtime's manifest does not declare its launch bindings; register its entry point again before mapping positionals",
    )?;
    for key in roles.keys() {
        if !slots.iter().any(|(slot, _)| slot == key) {
            return Err(format!(
                "{key} is not a positional of this runtime's reviewed help"
            ));
        }
    }
    let candidates = entry.static_candidates();
    let mut ordered: Vec<&(String, u16)> = slots.iter().collect();
    ordered.sort_by_key(|(_, position)| *position);
    let mut unmapped_before = None;
    let mut used_bindings = BTreeSet::new();
    let mut used_statics = BTreeSet::new();
    for (key, _) in ordered {
        let Some(role) = roles.get(key) else {
            unmapped_before.get_or_insert(key);
            continue;
        };
        if let Some(earlier) = unmapped_before {
            return Err(format!(
                "{key}: map the earlier positional {earlier} first; an unmapped earlier slot would shift this value"
            ));
        }
        match role {
            PositionalRole::User => {}
            _ if entry.separator.is_some() => {
                return Err(format!(
                    "{key}: tokens before the entry's -- boundary cannot fill positionals after it"
                ))
            }
            PositionalRole::Binding { name } => {
                if !bindings.contains(name) {
                    return Err(format!(
                        "{key}: {name} is not a positional binding of this entry point"
                    ));
                }
                if !used_bindings.insert(name.clone()) {
                    return Err(format!("{key}: {name} already fills another slot"));
                }
            }
            PositionalRole::Static { index } => {
                if entry.layout.is_none() {
                    return Err(format!(
                        "{key}: declare the entry's argument roles before mapping an entry token to a positional"
                    ));
                }
                if !candidates.contains(index) {
                    return Err(format!(
                        "{key}: entry token {} is not a positional argument of this command",
                        index + 1
                    ));
                }
                if !used_statics.insert(*index) {
                    return Err(format!(
                        "{key}: entry token {} already fills another slot",
                        index + 1
                    ));
                }
            }
        }
    }
    if let Some(name) = bindings.iter().find(|name| !used_bindings.contains(*name)) {
        return Err(format!(
            "map the launch template's positional binding {name} to its slot; left in place it would take the first slot"
        ));
    }
    // Only a declared subcommand proves the literals after it are arguments
    // of the help's command. Without one, prefix literals (an interpreter's
    // script path, say) stay entry tokens in place unless mapped explicitly.
    let proven_leaf = entry
        .layout
        .as_ref()
        .is_some_and(|layout| !layout.subcommands.is_empty());
    if let Some(index) = candidates
        .iter()
        .find(|index| proven_leaf && !used_statics.contains(index))
    {
        return Err(format!(
            "map entry token {} ({}) to its slot; left in place it would take the first slot",
            index + 1,
            entry.prefix[*index]
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::runtime_command::PrefixOption;

    fn entry(bindings: &[&str]) -> CommandEntry {
        CommandEntry {
            version: 1,
            program: "engine".into(),
            prefix: ["--label", "x", "serve", "marker"]
                .map(String::from)
                .to_vec(),
            layout: Some(CommandLayout {
                version: 1,
                subcommands: vec![2],
                options: vec![PrefixOption {
                    index: 0,
                    values: 1,
                }],
            }),
            separator: None,
            positional_bindings: Some(bindings.iter().map(|s| (*s).to_owned()).collect()),
            positional_roles: BTreeMap::new(),
        }
    }
    fn slots() -> Vec<(String, u16)> {
        ["input", "middle", "output", "extra"]
            .iter()
            .enumerate()
            .map(|(i, key)| ((*key).to_owned(), i as u16))
            .collect()
    }
    fn roles(entries: &[(&str, PositionalRole)]) -> BTreeMap<String, PositionalRole> {
        entries
            .iter()
            .map(|(key, role)| ((*key).to_owned(), role.clone()))
            .collect()
    }
    fn model() -> PositionalRole {
        PositionalRole::Binding {
            name: "model".into(),
        }
    }

    #[test]
    fn user_slots_may_precede_and_follow_template_slots() {
        let entry = entry(&["model"]);
        assert_eq!(entry.static_candidates(), vec![3]);
        // [user input, fixed marker, app model, user output]
        let interleaved = roles(&[
            ("input", PositionalRole::User),
            ("middle", PositionalRole::Static { index: 3 }),
            ("output", model()),
            ("extra", PositionalRole::User),
        ]);
        validate_roles(Some(&entry), &slots(), &interleaved).unwrap();
        // A later slot may stay unmapped (and unset).
        let mut shorter = interleaved.clone();
        shorter.remove("extra");
        validate_roles(Some(&entry), &slots(), &shorter).unwrap();
        let mut gap = interleaved.clone();
        gap.remove("input");
        assert!(validate_roles(Some(&entry), &slots(), &gap)
            .unwrap_err()
            .contains("earlier positional input"));
    }

    #[test]
    fn a_plain_interpreter_and_script_entry_keeps_its_tokens_in_place() {
        // `python -I engine.py INPUT`: no declared subcommand proves that the
        // script path is the engine's argument, so it is never required (or
        // assumed) to fill a slot; it may still be mapped explicitly.
        let mut entry = entry(&[]);
        entry.prefix = ["-I", "engine.py"].map(String::from).to_vec();
        entry.layout = Some(CommandLayout {
            version: 1,
            subcommands: vec![],
            options: vec![PrefixOption {
                index: 0,
                values: 0,
            }],
        });
        let user = roles(&[("input", PositionalRole::User)]);
        validate_roles(Some(&entry), &slots(), &user).unwrap();
        let explicit = roles(&[
            ("input", PositionalRole::Static { index: 1 }),
            ("middle", PositionalRole::User),
        ]);
        validate_roles(Some(&entry), &slots(), &explicit).unwrap();
        // The same prefix without a declared layout: user slots only.
        entry.layout = None;
        validate_roles(Some(&entry), &slots(), &user).unwrap();
    }

    #[test]
    fn unplaced_duplicate_unknown_and_boundary_crossing_roles_are_refused() {
        let entry = entry(&["model"]);
        let no_model = roles(&[
            ("input", PositionalRole::User),
            ("middle", PositionalRole::Static { index: 3 }),
        ]);
        assert!(validate_roles(Some(&entry), &slots(), &no_model)
            .unwrap_err()
            .contains("binding model"));
        let no_marker = roles(&[("input", PositionalRole::User), ("middle", model())]);
        assert!(validate_roles(Some(&entry), &slots(), &no_marker)
            .unwrap_err()
            .contains("marker"));
        let twice = roles(&[
            ("input", model()),
            ("middle", model()),
            ("output", PositionalRole::Static { index: 3 }),
        ]);
        assert!(validate_roles(Some(&entry), &slots(), &twice).is_err());
        let port = roles(&[(
            "input",
            PositionalRole::Binding {
                name: "port".into(),
            },
        )]);
        assert!(validate_roles(Some(&entry), &slots(), &port).is_err());
        // A value of a fixed option is never a positional token.
        let value = roles(&[("input", PositionalRole::Static { index: 1 })]);
        assert!(validate_roles(Some(&entry), &slots(), &value).is_err());
        let forged = roles(&[("missing", PositionalRole::User)]);
        assert!(validate_roles(Some(&entry), &slots(), &forged).is_err());
        let mut bridged = entry.clone();
        bridged.separator = Some("--".into());
        let crossing = roles(&[("input", PositionalRole::User), ("middle", model())]);
        assert!(validate_roles(Some(&bridged), &slots(), &crossing)
            .unwrap_err()
            .contains("boundary"));
        let mut unlaid = entry.clone();
        unlaid.layout = None;
        let token = roles(&[("input", PositionalRole::Static { index: 3 })]);
        assert!(validate_roles(Some(&unlaid), &slots(), &token)
            .unwrap_err()
            .contains("argument roles"));
        let mut legacy = entry.clone();
        legacy.positional_bindings = None;
        assert!(validate_roles(Some(&legacy), &slots(), &no_model)
            .unwrap_err()
            .contains("register"));
        assert!(validate_roles(None, &slots(), &no_model).is_err());
        let mut future = entry.clone();
        future.version = 2;
        assert!(validate_roles(Some(&future), &slots(), &no_model)
            .unwrap_err()
            .contains("version"));
        assert!(validate_roles(None, &slots(), &BTreeMap::new()).is_ok());
    }
}
