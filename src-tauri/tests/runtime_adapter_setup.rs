//! An arbitrary imported recipe uses the production process/draft boundary.
//! This fixture proves registration preparation and cancellation, not inference.
use aiolm_lib::providers::{
    adapter_setup::{self, Recipe},
    runtime_help::HelpService,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

struct Home {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("aiolm setup 눈길 {}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("AIOLM_HOME");
        // One test owns this integration binary's environment.
        std::env::set_var("AIOLM_HOME", &path);
        Self { path, previous }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("AIOLM_HOME", value),
            None => std::env::remove_var("AIOLM_HOME"),
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn imported_recipe_prepares_a_common_entry_and_cannot_publish_after_cancel() {
    let home = Home::new();
    let program = env!("CARGO_BIN_EXE_fake-llama-server");
    let draft_file = home.path.join("draft ; &.json");
    let source = json!({"engine_id":"custom.arbitrarysetup", "runtime_id":"r1", "display_name":"Arbitrary setup",
        "program":program,"prefix":["--adapter-engine"], "working_directory":home.path,"artifacts":[],"environment":{},
        "protocol":{"kind":"openai_http"}, "model":{"kind":"flag","flag":"--model"},"port":{"kind":"flag","flag":"--port"},
        "auth":{"kind":"none"},"probe":{"program":program,"args":["--adapter-probe","custom.arbitrarysetup","r1","{model}"],"env":{}},
        "health_path":"/health","model_formats":["unknown"]});
    fs::write(&draft_file, serde_json::to_vec(&source).unwrap()).unwrap();
    let recipe_file = home.path.join("recipe.json");
    let value = json!({"version":1,"id":"any.vendor.setup","title":"Arbitrary adapter","description":"Synthetic boundary",
        "fields":[{"key":"program","label":"Installed executable","kind":"file","required":true},
                  {"key":"draft","label":"Setup data","kind":"file","required":true}],
        "prepare":{"program":"{input:program}","args":["--adapter-setup-fixture","{resource:draft ; &.json}"],"env":{},"working_directory":home.path},
        "artifacts":["{input:draft}"]});
    fs::write(&recipe_file, serde_json::to_vec(&value).unwrap()).unwrap();
    let recipe = adapter_setup::import(&recipe_file).unwrap();
    let service = Arc::new(HelpService::default());
    assert!(adapter_setup::prepare(&service, "missing", &recipe, &BTreeMap::new()).is_err());
    let inputs = BTreeMap::from([
        ("program".into(), program.into()),
        ("draft".into(), draft_file.to_string_lossy().into_owned()),
    ]);
    let result = adapter_setup::prepare(&service, "first", &recipe, &inputs).unwrap();
    assert_eq!(result.engine_id.as_str(), "custom.arbitrarysetup");
    assert_eq!(result.program, program);
    assert_eq!(result.prefix, ["--adapter-engine"]);
    // Recipes never register or advertise Ready on their own.
    assert!(
        aiolm_lib::providers::registry::manifest(result.engine_id, &result.runtime_id).is_err()
    );
    let mut unknown = inputs.clone();
    unknown.insert("foreign".into(), "value".into());
    assert!(adapter_setup::prepare(&service, "foreign", &recipe, &unknown).is_err());
    let mut unsupported = value.clone();
    unsupported["version"] = json!(2);
    assert!(serde_json::from_value::<Recipe>(unsupported)
        .unwrap()
        .validate()
        .is_err());
    let mut partial = recipe.clone();
    partial.prepare.args[1] = "path/{input:draft}".into();
    assert!(
        adapter_setup::prepare(&service, "partial", &partial, &inputs)
            .unwrap_err()
            .contains("complete argv token")
    );
    assert!(adapter_setup::provided().unwrap().is_empty());

    let marker = home.path.join("started.txt");
    let mut slow = recipe.clone();
    slow.prepare.args.extend([
        "--adapter-setup-slow".into(),
        marker.to_string_lossy().into_owned(),
    ]);
    let worker_service = Arc::clone(&service);
    let worker_inputs = inputs.clone();
    let thread = std::thread::spawn(move || {
        adapter_setup::prepare(&worker_service, "slow", &slow, &worker_inputs)
    });
    let start = Instant::now();
    while !marker.is_file() && start.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(marker.is_file(), "the real fixture child did not start");
    assert!(service.cancel_owner("setup:slow").unwrap());
    assert!(thread
        .join()
        .unwrap()
        .unwrap_err()
        .contains("did not complete"));
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "cancellation must not wait for the child's 20 second delay"
    );
    // Failed preparation does not poison the next explicit retry.
    assert!(adapter_setup::prepare(&service, "slow", &recipe, &inputs).is_ok());
    assert!(
        !aiolm_lib::runtime::runtimes_root()
            .join("adapter-helpers")
            .exists(),
        "a third-party setup must not extract another engine's helpers"
    );
}

#[test]
fn every_vendor_imports_companion_resources_from_its_own_package() {
    let directory =
        std::env::temp_dir().join(format!("aiolm package 눈길 {}", uuid::Uuid::new_v4()));
    fs::create_dir_all(directory.join("helpers")).unwrap();
    let helper = directory.join("helpers/prepare ; &.py");
    fs::write(&helper, b"synthetic provider helper").unwrap();
    let path = directory.join("engine.setup.json");
    let source = json!({"version":1,"id":"any.vendor", "title":"Independent provider", "description":"",
        "fields":[{"key":"python","label":"Python executable","kind":"file","required":true}],
        "prepare":{"program":"{input:python}","args":["{resource:helpers/prepare ; &.py}"],"env":{}},
        "artifacts":["{resource:helpers/prepare ; &.py}"]});
    for id in ["new.vendor", "strata.example", "tensorfold.example"] {
        let mut value = source.clone();
        value["id"] = json!(id);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let imported = adapter_setup::import(&path).unwrap();
        let expected = helper
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(imported.prepare.args, [expected.clone()]);
        assert_eq!(imported.artifacts, [expected]);
        assert_eq!(imported.prepare.program, "{input:python}");
    }
    let mut automatic = source.clone();
    automatic["artifacts"] = json!([]);
    fs::write(&path, serde_json::to_vec(&automatic).unwrap()).unwrap();
    assert_eq!(adapter_setup::import(&path).unwrap().artifacts.len(), 1);
    let example = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../scripts/runtime-adapters/strata.setup.json");
    assert!(adapter_setup::import(&example).is_ok());
    for resource in [
        "../outside.py",
        "/outside.py",
        "C:\\outside.py",
        "helpers",
        "missing.py",
    ] {
        let mut value = source.clone();
        value["prepare"]["args"][0] = json!(format!("{{resource:{resource}}}"));
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            adapter_setup::import(&path).is_err(),
            "resource accepted: {resource}"
        );
    }
    #[cfg(unix)]
    {
        let outside = directory.with_extension("outside.py");
        fs::write(&outside, b"outside package").unwrap();
        let link = directory.join("linked.py");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let mut value = source.clone();
        value["prepare"]["args"][0] = json!("{resource:linked.py}");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(adapter_setup::import(&path).is_err());
        fs::remove_file(outside).unwrap();
    }
    fs::remove_dir_all(directory).unwrap();
}
