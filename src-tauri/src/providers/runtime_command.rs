//! Explicit roles in a fixed entry prefix. A word equal to a subcommand may
//! instead be an option value; only the reviewed layout establishes its role.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandLayout {
    pub version: u32,
    #[serde(default)]
    pub subcommands: Vec<usize>,
    #[serde(default)]
    pub options: Vec<PrefixOption>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrefixOption {
    pub index: usize,
    /// Number of following literal argv tokens owned by this fixed option.
    pub values: usize,
}

impl CommandLayout {
    pub fn validate(&self, prefix: &[String]) -> Result<(), String> {
        if self.version != 1
            || prefix.len() > 128
            || self.options.len() > 128
            || self.subcommands.len() > 8
        {
            return Err("unsupported command layout version or bounds".into());
        }
        let mut occupied = BTreeSet::new();
        for option in &self.options {
            let Some(flag) = prefix.get(option.index) else {
                return Err("a fixed option index is outside the entry prefix".into());
            };
            if !flag.starts_with('-')
                || flag.trim_start_matches('-').is_empty()
                || option.values > 128
                || option.index.saturating_add(option.values) >= prefix.len()
                || (flag.contains('=') && option.values != 0)
            {
                return Err("declare a fixed option and its exact following value count".into());
            }
            for index in option.index..=option.index + option.values {
                if !occupied.insert(index) {
                    return Err("fixed option roles overlap in the command layout".into());
                }
            }
        }
        let mut previous = None;
        for index in &self.subcommands {
            let Some(word) = prefix.get(*index) else {
                return Err("a subcommand index is outside the entry prefix".into());
            };
            if occupied.contains(index)
                || previous.is_some_and(|old| old >= *index)
                || word.is_empty()
                || word.len() > 128
                || word.starts_with('-')
                || word.contains(['\0', '/', '\\'])
                || word.chars().any(char::is_whitespace)
            {
                return Err("choose ordered subcommand tokens, not option names or values".into());
            }
            previous = Some(*index);
        }
        for (index, token) in prefix.iter().enumerate() {
            if token.starts_with('-') && !occupied.contains(&index) {
                return Err(format!(
                    "declare the fixed option at argument {} and its value count",
                    index + 1
                ));
            }
        }
        Ok(())
    }

    pub fn scope(&self, prefix: &[String]) -> Result<Vec<String>, String> {
        self.validate(prefix)?;
        Ok(self
            .subcommands
            .iter()
            .map(|index| prefix[*index].clone())
            .collect())
    }

    /// Insert each resolved scope section before its next declared subcommand.
    /// The final section follows the app-owned bindings. Prefix bytes and
    /// equal-looking option values are never searched or reconstructed.
    pub fn assemble(
        &self,
        prefix: &[String],
        template: &[String],
        sections: &[Vec<String>],
    ) -> Result<Vec<String>, String> {
        self.validate(prefix)?;
        if !template.starts_with(prefix) || sections.len() != self.subcommands.len() + 1 {
            return Err("the resolved options do not match the declared command layout".into());
        }
        let mut argv = Vec::new();
        let mut start = 0;
        for (depth, index) in self.subcommands.iter().copied().enumerate() {
            argv.extend_from_slice(&template[start..index]);
            argv.extend_from_slice(&sections[depth]);
            argv.push(template[index].clone());
            start = index + 1;
        }
        argv.extend_from_slice(&template[start..]);
        argv.extend_from_slice(sections.last().expect("one section per scope"));
        if argv.len() > 4096 || argv.iter().map(String::len).sum::<usize>() > 512 * 1024 {
            return Err("assembled command exceeds its argument limit".into());
        }
        Ok(argv)
    }

    pub fn fixed_flags(&self, prefix: &[String]) -> Result<Vec<String>, String> {
        self.validate(prefix)?;
        Ok(self
            .options
            .iter()
            .map(|option| {
                prefix[option.index]
                    .split_once('=')
                    .map_or(prefix[option.index].as_str(), |(flag, _)| flag)
                    .to_owned()
            })
            .collect())
    }
}

pub fn scope(layout: Option<&CommandLayout>, prefix: &[String]) -> Result<Vec<String>, String> {
    layout.map_or_else(|| Ok(Vec::new()), |layout| layout.scope(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry() -> (Vec<String>, CommandLayout) {
        let prefix = ["-I", "engine.py", "--label", "serve", "serve", "api"]
            .map(String::from)
            .to_vec();
        let layout = CommandLayout {
            version: 1,
            subcommands: vec![4, 5],
            options: vec![
                PrefixOption {
                    index: 0,
                    values: 0,
                },
                PrefixOption {
                    index: 2,
                    values: 1,
                },
            ],
        };
        (prefix, layout)
    }
    #[test]
    fn equal_option_values_and_interpreter_tokens_are_not_subcommands() {
        let (mut prefix, layout) = entry();
        assert_eq!(layout.scope(&prefix).unwrap(), vec!["serve", "api"]);
        prefix[3] = "--engine".into();
        assert_eq!(layout.fixed_flags(&prefix).unwrap(), vec!["-I", "--label"]);
        let mut forged = layout.clone();
        forged.subcommands = vec![3, 5];
        assert!(forged.scope(&prefix).is_err());
        assert!(scope(None, &prefix).unwrap().is_empty());
    }
    #[test]
    fn unknown_versions_overlapping_roles_and_unmapped_flags_are_refused() {
        let (prefix, layout) = entry();
        let mut future = layout.clone();
        future.version = 2;
        assert!(future.validate(&prefix).is_err());
        let mut overlap = layout.clone();
        overlap.options.push(PrefixOption {
            index: 3,
            values: 0,
        });
        assert!(overlap.validate(&prefix).is_err());
        let mut missing = layout.clone();
        missing.options.remove(0);
        assert!(missing.validate(&prefix).is_err());
        let mut order = layout.clone();
        order.subcommands.reverse();
        assert!(order.validate(&prefix).is_err());
    }
}
