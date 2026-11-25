//! Joining `/`-separated relative paths onto platform paths.
//!
//! Relative locations that AioLM writes as text (SDK layouts such as
//! `lib/x64`, snapshot manifest entries, Hugging Face repository files) always
//! use `/`. Passing such a string to `Path::join` keeps the `/` on Windows and
//! yields `C:\sdk\lib/x64`, which is shown to people in errors and the UI and
//! does not compare equal to the same path read back from the file system.
//! Joining one segment at a time gives every platform its own separator.
//! `scripts/path-separators.test.mjs` rejects new `/` literals in `join` calls.

use std::path::{Path, PathBuf};

/// Append each `/`-separated segment of `relative` to `base`. Empty segments
/// are skipped, so `""` returns `base` and `"a//b/"` equals `"a/b"`.
pub(crate) fn join_relative(base: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .fold(base.to_path_buf(), |path, segment| path.join(segment))
}

#[cfg(test)]
mod tests {
    use super::join_relative;
    use std::path::Path;

    #[test]
    fn joins_each_segment_with_the_platform_separator() {
        let base = Path::new("sdk");
        assert_eq!(join_relative(base, "lib/x64"), base.join("lib").join("x64"));
        assert_eq!(join_relative(base, "a//b/"), base.join("a").join("b"));
        assert_eq!(join_relative(base, ""), base);
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_contain_no_forward_slash() {
        let joined = join_relative(Path::new(r"C:\sdk"), "lib/rocm_sysdeps/lib");
        assert_eq!(joined.to_str(), Some(r"C:\sdk\lib\rocm_sysdeps\lib"));
    }
}
