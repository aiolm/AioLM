use super::*;

pub(crate) struct Fixture {
    pub root: PathBuf,
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
}

fn check_ancestors(path: &Path) {
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).unwrap();
        assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(metadata.file_attributes() & 0x400, 0, "reparse ancestor");
        }
    }
}

impl Fixture {
    pub(crate) fn new() -> Self {
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        check_ancestors(&parent);
        let root = parent.join(format!("rp-{}", Uuid::new_v4().simple()));
        fs::create_dir(&root).unwrap();
        check_ancestors(&root);
        Self {
            directories: vec![root.clone()],
            root,
            files: vec![],
        }
    }

    pub(crate) fn directory(&mut self, relative: &str) -> PathBuf {
        let mut directory = self.root.clone();
        for component in Path::new(relative).components() {
            assert!(matches!(component, Component::Normal(_)));
            directory.push(component);
            if !self.directories.contains(&directory) {
                check_ancestors(directory.parent().unwrap());
                fs::create_dir(&directory).unwrap();
                self.directories.push(directory.clone());
            }
            check_ancestors(&directory);
        }
        directory
    }

    pub(crate) fn write(&mut self, relative: &str, bytes: &[u8]) {
        let relative_path = Path::new(relative);
        assert!(relative_path
            .components()
            .all(|part| matches!(part, Component::Normal(_))));
        if let Some(parent) = relative_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            self.directory(parent.to_str().unwrap());
        }
        let file = self.root.join(relative_path);
        if !self.files.contains(&file) {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&file)
                .unwrap();
            self.files.push(file.clone());
        }
        let metadata = fs::symlink_metadata(&file).unwrap();
        assert!(metadata.is_file() && !metadata.file_type().is_symlink());
        fs::write(file, bytes).unwrap();
    }

    pub(crate) fn remove_file(&mut self, relative: &str) {
        let file = self.root.join(relative);
        assert!(self.files.contains(&file));
        fs::remove_file(&file).unwrap();
        self.files.retain(|entry| entry != &file);
    }

    pub(crate) fn finish(self) {
        for file in self.files {
            check_ancestors(file.parent().unwrap());
            let metadata = fs::symlink_metadata(&file).unwrap();
            assert!(metadata.is_file() && !metadata.file_type().is_symlink());
            fs::remove_file(file).unwrap();
        }
        for directory in self.directories.into_iter().rev() {
            check_ancestors(&directory);
            fs::remove_dir(directory).unwrap();
        }
    }
}

pub(crate) fn assert_json(label: &str, actual: serde_json::Value, expected: serde_json::Value) {
    println!(
        "RUNTIME_LISTING_JSON {}",
        serde_json::json!({"case":label,"actual":actual,"expected":expected})
    );
    assert_eq!(actual, expected, "{label}");
}
