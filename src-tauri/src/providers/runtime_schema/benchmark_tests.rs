use super::*;
use serde_json::json;

#[test]
fn benchmark_projection_locks_private_bindings_and_excludes_all_name_collisions() {
    let source = adapter_source("synthetic.adapter", "r1");
    let mut options = Vec::new();
    for (key, flag) in [
        ("alpha", "--alpha"),
        ("beta", "--beta"),
        ("safe", "--safe"),
        ("secret", "--secret"),
        ("path", "--path"),
        ("model", "--model"),
        ("host", "--host"),
        ("port", "--port"),
        ("auth", "--auth"),
        ("entry", "--entry"),
    ] {
        let mut option = blank(key, "test", Target::Launch);
        option.spellings.push(Spelling {
            flag: flag.into(),
            style: ValueStyle::Separate,
            polarity: None,
        });
        option.kind = documented(ValueKind::Integer, &source);
        option.arity = documented(
            Arity {
                min: 1,
                max: Some(1),
            },
            &source,
        );
        option.repeatable = documented(false, &source);
        option.benchmark_public = documented(true, &source);
        if ["alpha", "beta"].contains(&key) {
            option.benchmark_name = documented("collision".into(), &source);
        }
        match key {
            "secret" => option.sensitive = documented(true, &source),
            "path" => option.local_path = documented(true, &source),
            "model" => option.managed = Some(ManagedBinding::Model),
            "host" => option.managed = Some(ManagedBinding::Host),
            "port" => option.managed = Some(ManagedBinding::Port),
            "auth" => option.managed = Some(ManagedBinding::Authentication),
            "entry" => option.managed = Some(ManagedBinding::EntryPoint),
            _ => {}
        }
        options.push(option);
    }
    let mut schema = OptionSchema {
        schema_version: SCHEMA_VERSION,
        binding: crate::providers::runtime_options::SchemaBinding {
            engine: "custom.example".into(),
            runtime: "build-1".into(),
            fingerprint: "a".repeat(64),
        },
        options,
        constraints: vec![],
        raw_help: vec![],
        end_of_options: Fact::default(),
    };
    lock_private_benchmark_options(&mut schema);
    assert_eq!(
        benchmark_names(&schema),
        BTreeMap::from([("safe".into(), "safe".into())])
    );
    for option in &schema.options[3..] {
        assert_eq!(
            option.benchmark_public.supported(),
            Some(&false),
            "{}",
            option.key
        );
    }
    // Neither a scoped twin nor a distinct target is a collision.
    schema.options[1].scope = vec!["serve".into()];
    assert!(benchmark_names(&schema).contains_key("alpha"));
    assert!(benchmark_names(&schema).contains_key("beta"));
}

#[test]
fn benchmark_capture_reserves_request_slots_and_never_invents_omitted_defaults() {
    let root =
        std::env::temp_dir().join(format!("aiolm-benchmark-capture-{}", uuid::Uuid::new_v4()));
    let cfg = AppConfig {
        active_backend: "cpu".into(),
        active_build: "synthetic".into(),
        ..Default::default()
    };
    let effective = effective(&root, &cfg, false).unwrap();
    let empty = capture_benchmark_settings(&effective, &[], &[], 3).unwrap();
    assert!(empty.settings.is_empty());
    let raw = [
        "server",
        "--threads",
        "4",
        "--ctx-size",
        "8192",
        "--parallel",
        "2",
    ]
    .map(str::to_owned);
    let captured = capture_benchmark_settings(&effective, &raw, &raw, 127).unwrap();
    assert!(captured.omitted);
    assert_eq!(captured.settings.len(), 1);
    assert_eq!(captured.settings[0].name, "ctx-size");
    let mut sanitized = raw.clone();
    sanitized[1] = "[REDACTED]".into();
    let captured = capture_benchmark_settings(&effective, &raw, &sanitized, 3).unwrap();
    assert_eq!(
        captured
            .settings
            .iter()
            .find(|s| s.name == "threads")
            .unwrap()
            .value,
        Value::Null
    );
    let mut collision = effective.clone();
    let source = adapter_source("synthetic.adapter", "r1");
    for option in &mut collision.schema.options {
        if ["threads", "parallel"].contains(&option.key.as_str()) {
            option.benchmark_name = documented("shared".into(), &source);
        }
    }
    collision.benchmark_names = benchmark_names(&collision.schema);
    let captured = capture_benchmark_settings(&collision, &raw, &raw, 3).unwrap();
    assert!(captured.omitted);
    assert_eq!(captured.settings.len(), 1);
    assert_eq!(captured.settings[0].name, "ctx-size");
}

#[test]
fn benchmark_values_only_publish_typed_safe_scalars_and_numeric_json_arrays() {
    let source = adapter_source("synthetic.adapter", "r1");
    let mut option = blank("private-key", "test", Target::Launch);
    option.kind = documented(ValueKind::Text, &source);
    for text in [
        "--injected",
        "/local/path",
        "host:1234",
        "name@example",
        "a\\b",
    ] {
        assert_eq!(public_capture_value(&option, &[json!(text)]), None);
    }
    assert_eq!(
        public_capture_value(&option, &[json!("fp8")]),
        Some(json!("fp8"))
    );
    option.kind = documented(ValueKind::Integer, &source);
    assert_eq!(public_capture_value(&option, &[json!(-1)]), Some(json!(-1)));
    option.kind = documented(ValueKind::Json, &source);
    assert_eq!(
        public_capture_value(&option, &[json!([0.6, 0.4])]),
        Some(json!([0.6, 0.4]))
    );
    for value in [json!({"private":"value"}), json!(["text"]), json!(4)] {
        assert_eq!(public_capture_value(&option, &[value]), None);
    }
}
