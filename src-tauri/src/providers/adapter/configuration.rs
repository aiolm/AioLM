//! Validation policy for provider-keyed option maps. Installed selections
//! use the effective schema; dormant Python catalogs and registered values
//! retain their established offline editing and launch-validation behavior.
use serde_json::Value;

pub fn parse_option_maps(
    cfg: &crate::config::AppConfig,
    value: &str,
) -> Result<std::collections::BTreeMap<String, serde_json::Map<String, Value>>, String> {
    use crate::providers::{self, runtime_ordered, ProviderId};
    let options: std::collections::BTreeMap<String, serde_json::Map<String, Value>> =
        serde_json::from_str(value).map_err(|error| {
            format!("provider_options must be a JSON object of provider option objects: {error}")
        })?;
    for (key, values) in &options {
        let provider = ProviderId::parse(key)
            .filter(|provider| provider.as_str() == key)
            .ok_or_else(|| format!("provider options cannot be saved for '{key}'"))?;
        let mut selected = cfg.clone();
        selected.active_provider = key.clone();
        selected
            .provider_options
            .insert(key.clone(), values.clone());
        let issues = if provider == ProviderId::Llama {
            // Native generic options exist only as the installed build's
            // reviewed help describes them.
            if cfg.active_backend.is_empty() || cfg.active_build.is_empty() {
                return Err(format!("provider options cannot be saved for '{key}' until a llama.cpp runtime is selected; typed llama.cpp settings use their own config fields"));
            }
            providers::runtime_schema::saved_issues(
                &providers::registry::root(),
                &selected,
                values,
                &Default::default(),
            )
        } else if provider.is_custom() {
            // External schemas depend on the selected registered instance;
            // other instances keep their typed JSON for launch to validate.
            let manifest = (cfg.active_provider == *key && !cfg.active_runtime.is_empty())
                .then(|| providers::registry::manifest(provider, &cfg.active_runtime).ok())
                .flatten();
            match manifest {
                Some(manifest) => {
                    providers::registry::saved_option_issues(&selected, &manifest, values)
                }
                None => order_issues(values),
            }
        } else {
            let runtime = (cfg.active_provider == *key && !cfg.active_runtime.is_empty())
                .then(|| providers::selected_python_runtime(&selected).ok())
                .flatten();
            match runtime {
                Some(runtime) => {
                    providers::launch::saved_option_issues(&selected, &runtime, values)
                }
                None => {
                    let mut catalog = values.clone();
                    catalog.remove(runtime_ordered::ORDER_KEY);
                    let mut issues = providers::launch::option_issues(provider, &catalog);
                    issues.extend(order_issues(values));
                    issues
                }
            }
        };
        if !issues.is_empty() {
            let messages = issues
                .iter()
                .map(|issue| issue.message.as_str())
                .collect::<Vec<_>>();
            return Err(format!("invalid {key} options: {}", messages.join("; ")));
        }
    }
    Ok(options)
}

/// A saved order record must agree with the values it orders.
fn order_issues(
    values: &serde_json::Map<String, Value>,
) -> Vec<crate::providers::options::OptionIssue> {
    use crate::providers::runtime_ordered;
    match runtime_ordered::saved_order(values) {
        Err(message) => vec![crate::providers::options::OptionIssue {
            key: runtime_ordered::ORDER_KEY.into(),
            code: "order",
            message,
        }],
        Ok(_) => Vec::new(),
    }
}
