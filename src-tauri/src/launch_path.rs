//! The command search path of a desktop app opened from Finder or the Dock.
//!
//! LaunchServices starts such an app with launchd's minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`). Terminal shells add `/etc/paths` and
//! `/etc/paths.d` through `path_helper`, and Homebrew's shell setup adds its
//! Apple silicon prefix, so commands such as `npx` or `cmake` that work in
//! Terminal would not be found for MCP servers or source builds. Those standard
//! directories are appended after the inherited entries: an existing order is
//! never changed, and no shell startup file is read or executed.

#[cfg(target_os = "macos")]
const HOMEBREW_DIRECTORIES: &[&str] = &["/opt/homebrew/bin", "/opt/homebrew/sbin"];

/// Extend this process's PATH before any thread or child process exists.
#[cfg(target_os = "macos")]
pub(crate) fn extend_for_desktop_launch() {
    let mut directories = std::fs::read_to_string("/etc/paths")
        .map(|text| path_file_entries(&text))
        .unwrap_or_default();
    if let Ok(entries) = std::fs::read_dir("/etc/paths.d") {
        // path_helper reads these files in name order.
        let mut files: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
        files.sort();
        for file in files {
            if let Ok(text) = std::fs::read_to_string(file) {
                directories.extend(path_file_entries(&text));
            }
        }
    }
    directories.extend(
        HOMEBREW_DIRECTORIES
            .iter()
            .map(|directory| directory.to_string()),
    );
    directories.retain(|directory| std::path::Path::new(directory).is_dir());
    let current = std::env::var_os("PATH").unwrap_or_default();
    if let Some(path) = current
        .to_str()
        .and_then(|current| extended_path(current, &directories))
    {
        // Called first in `run`, while the process is still single-threaded.
        std::env::set_var("PATH", path);
    }
}

/// Absolute directories listed one per line, as `path_helper` reads them.
fn path_file_entries(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| line.starts_with('/'))
        .map(str::to_owned)
        .collect()
}

/// `current` followed by every addition it does not already contain, or `None`
/// when nothing is missing.
fn extended_path(current: &str, additions: &[String]) -> Option<String> {
    let mut entries: Vec<&str> = if current.is_empty() {
        Vec::new()
    } else {
        current.split(':').collect()
    };
    let original = entries.len();
    for directory in additions {
        if !entries.contains(&directory.as_str()) {
            entries.push(directory);
        }
    }
    (entries.len() > original).then(|| entries.join(":"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn launchd_path_gains_missing_standard_directories_in_order() {
        let additions = owned(&[
            "/usr/local/bin",
            "/usr/bin",
            "/opt/homebrew/bin",
            "/opt/homebrew/bin",
        ]);
        assert_eq!(
            extended_path("/usr/bin:/bin:/usr/sbin:/sbin", &additions).as_deref(),
            Some("/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin")
        );
    }

    #[test]
    fn a_terminal_path_keeps_its_own_order_and_is_left_alone_when_complete() {
        let additions = owned(&["/usr/local/bin", "/opt/homebrew/bin"]);
        assert_eq!(
            extended_path(
                "/opt/homebrew/bin:/Users/test/.local/bin:/usr/local/bin",
                &additions
            ),
            None
        );
        assert_eq!(
            extended_path("/Users/test/bin", &additions).as_deref(),
            Some("/Users/test/bin:/usr/local/bin:/opt/homebrew/bin")
        );
    }

    #[test]
    fn an_empty_path_becomes_the_standard_directories() {
        assert_eq!(
            extended_path("", &owned(&["/usr/bin", "/bin"])).as_deref(),
            Some("/usr/bin:/bin")
        );
    }

    #[test]
    fn path_files_list_absolute_directories_only() {
        assert_eq!(
            path_file_entries(
                "/usr/local/bin\n  /usr/bin \n\nrelative\n# note\r\n/Library/Apple/usr/bin\r\n"
            ),
            owned(&["/usr/local/bin", "/usr/bin", "/Library/Apple/usr/bin"])
        );
    }
}
