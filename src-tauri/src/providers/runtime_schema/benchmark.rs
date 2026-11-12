use super::*;

/// Privacy is a final merge invariant, not a user-overridable annotation.
pub(super) fn lock_private_benchmark_options(schema: &mut OptionSchema) {
    let source = adapter_source("aiolm", "benchmark-privacy-v1");
    for option in &mut schema.options {
        if private_benchmark_option(option) {
            option.benchmark_public = documented(false, &source);
        }
    }
}

fn private_benchmark_option(option: &OptionDefinition) -> bool {
    option.sensitive.value == Some(true)
        || option.local_path.value == Some(true)
        || matches!(
            option.managed,
            Some(
                ManagedBinding::Model
                    | ManagedBinding::Host
                    | ManagedBinding::Port
                    | ManagedBinding::Authentication
                    | ManagedBinding::EntryPoint
                    | ManagedBinding::Reserved
            )
        )
}

/// Exclude all keys in a collision rather than choosing a local-key winner.
pub fn benchmark_names(schema: &OptionSchema) -> BTreeMap<String, String> {
    use crate::providers::runtime_options::{benchmark_identifier, public_setting_name};
    let mut identities: BTreeMap<(&str, &[String], &str), Vec<&str>> = BTreeMap::new();
    for option in &schema.options {
        if private_benchmark_option(option)
            || option.benchmark_public.supported() != Some(&true)
            || option.scope.len() > 8
            || !option.scope.iter().all(|s| benchmark_identifier(s))
        {
            continue;
        }
        if let Some(name) = public_setting_name(option) {
            identities
                .entry((
                    if option.target == Target::Launch {
                        "launch"
                    } else {
                        "request"
                    },
                    &option.scope,
                    name,
                ))
                .or_default()
                .push(&option.key);
        }
    }
    identities
        .into_iter()
        .filter(|(_, keys)| keys.len() == 1)
        .map(|((_, _, name), keys)| (keys[0].to_owned(), name.to_owned()))
        .collect()
}

#[derive(Debug)]
pub(crate) struct CapturedBenchmarkSettings {
    pub settings: Vec<crate::benchmark::provenance::RecordedSetting>,
    pub omitted: bool,
}

fn public_capture_value(option: &OptionDefinition, values: &[Value]) -> Option<Value> {
    let safe_scalar = |value: &Value| match (option.kind.supported(), value) {
        (Some(ValueKind::Boolean), Value::Bool(_)) => true,
        (Some(ValueKind::Integer | ValueKind::Number), Value::Number(n)) => {
            n.as_f64().is_some_and(f64::is_finite)
        }
        (Some(ValueKind::Text), Value::String(text)) => {
            !text.is_empty()
                && text.chars().count() <= 128
                && !text.starts_with('-')
                && !text.chars().any(|c| c.is_control() || "\\/:@".contains(c))
        }
        _ => false,
    };
    if values.len() == 1 {
        let value = &values[0];
        if safe_scalar(value) {
            return Some(value.clone());
        }
        if matches!(option.kind.supported(), Some(ValueKind::Json))
            && value.as_array().is_some_and(|items| {
                items.len() <= 64 && items.iter().all(|v| v.as_f64().is_some_and(f64::is_finite))
            })
        {
            return Some(value.clone());
        }
    }
    if values.len() > 1
        && values.len() <= 64
        && matches!(
            option.kind.supported(),
            Some(ValueKind::Integer | ValueKind::Number)
        )
        && values
            .iter()
            .all(|value| value.as_f64().is_some_and(f64::is_finite))
    {
        return Some(Value::Array(values.to_vec()));
    }
    None
}

/// Recognize raw identities only; conversion consumes the already masked copy.
/// `request_slots` reserves the authoritative common request entries first.
pub(crate) fn capture_benchmark_settings(
    effective: &EffectiveSchema,
    raw: &[String],
    sanitized: &[String],
    request_slots: usize,
) -> Result<CapturedBenchmarkSettings, String> {
    use crate::providers::runtime_ordered::{capture_plan_for_entry, CapturedValue};
    let occurrences = capture_plan_for_entry(
        &effective.schema,
        &effective.scope,
        effective.entry.as_ref(),
        raw,
        sanitized,
    )?;
    let mut grouped: BTreeMap<&str, Vec<&crate::providers::runtime_ordered::CapturedOccurrence>> =
        BTreeMap::new();
    let mut omitted = false;
    for occurrence in &occurrences {
        if effective.benchmark_names.contains_key(&occurrence.key) {
            grouped.entry(&occurrence.key).or_default().push(occurrence);
        } else {
            omitted = true;
        }
    }
    let mut settings = Vec::with_capacity(grouped.len().min(128));
    for (key, occurrences) in grouped {
        let Some(option) = effective
            .schema
            .options
            .iter()
            .find(|option| option.key == key)
        else {
            continue;
        };
        if private_benchmark_option(option)
            || option.benchmark_public.supported() != Some(&true)
            || option.target != Target::Launch
        {
            omitted = true;
            continue;
        }
        let last = occurrences.last().expect("group has an occurrence");
        let value = if occurrences.len() > 1 && option.repeatable.supported() == Some(&true) {
            let mut numbers = Vec::new();
            let mut known = true;
            for occurrence in &occurrences {
                match &occurrence.state {
                    CapturedValue::Known(values)
                        if values
                            .iter()
                            .all(|v| v.as_f64().is_some_and(f64::is_finite)) =>
                    {
                        numbers.extend(values.iter().cloned())
                    }
                    _ => {
                        known = false;
                        break;
                    }
                }
            }
            if known && !numbers.is_empty() && numbers.len() <= 64 {
                Value::Array(numbers)
            } else {
                Value::Null
            }
        } else if occurrences.len() > 1 && option.repeatable.supported().is_none() {
            Value::Null
        } else {
            match &last.state {
                CapturedValue::Known(values) => {
                    public_capture_value(option, values).unwrap_or(Value::Null)
                }
                CapturedValue::Redacted | CapturedValue::Invalid => Value::Null,
            }
        };
        let unit = option
            .unit
            .supported()
            .filter(|unit| {
                [
                    "tokens", "bytes", "MiB", "GiB", "threads", "layers", "count", "ratio", "bits",
                    "percent",
                ]
                .contains(&unit.as_str())
            })
            .cloned();
        settings.push(crate::benchmark::provenance::RecordedSetting {
            target: "launch".into(),
            scope: option.scope.clone(),
            name: effective.benchmark_names[key].clone(),
            value,
            unit,
            role: option
                .benchmark_role
                .supported()
                .map(|role| role.as_str().to_owned()),
        });
    }
    settings.sort_by(|a, b| (&a.target, &a.scope, &a.name).cmp(&(&b.target, &b.scope, &b.name)));
    let available = 128usize.saturating_sub(request_slots);
    omitted |= settings.len() > available;
    settings.truncate(available);
    Ok(CapturedBenchmarkSettings { settings, omitted })
}

#[cfg(test)]
#[path = "benchmark_tests.rs"]
mod tests;
