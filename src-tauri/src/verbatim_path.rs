//! Strip Windows extended-length verbatim path prefixes (`\\?\`, `\\?\UNC\`).
//!
//! `std::fs::canonicalize()` on Windows returns `\\?\C:\...` or
//! `\\?\UNC\server\share\...`. Many inference engines, child shells (`cmd.exe`)
//! and path parsers reject `?` or mis-handle the verbatim prefix when passed
//! in previewed or launched CLI arguments. Stripping only recognized drive and
//! UNC verbatim prefixes restores standard paths (`C:\...`, `\\server\share\...`)
//! without disturbing device/volume namespaces (`\\?\Volume{...}\...`), POSIX
//! paths, or UTF-8 characters and spaces.

use std::borrow::Cow;
use std::path::PathBuf;

/// Returns `true` when `value` begins with a Windows drive designator such as
/// `C:\` or `C:/`.
fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// Remove a Windows verbatim prefix (`\\?\X:\...` -> `X:\...`,
/// `\\?\UNC\server\share` -> `\\server\share`) while leaving ordinary paths,
/// POSIX paths, URLs, and Windows device/volume namespaces untouched.
pub(crate) fn strip_windows_verbatim_prefix_str(value: &str) -> Cow<'_, str> {
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        if let Some(unc) = rest
            .get(..4)
            .filter(|prefix| prefix.eq_ignore_ascii_case(r"UNC\"))
        {
            let suffix = &rest[unc.len()..];
            if !suffix.is_empty() {
                return Cow::Owned(format!(r"\\{suffix}"));
            }
        }
        if has_windows_drive_prefix(rest) {
            return Cow::Borrowed(rest);
        }
    }
    Cow::Borrowed(value)
}

/// Strip a recognized Windows verbatim prefix from a `PathBuf` if UTF-8
/// convertible and prefixed; non-prefixed or non-UTF-8 paths are returned
/// unchanged.
pub(crate) fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let Some(value) = path.to_str() else {
        return path;
    };
    let stripped = strip_windows_verbatim_prefix_str(value);
    if stripped.len() != value.len() {
        PathBuf::from(stripped.as_ref())
    } else {
        path
    }
}

/// Strip a recognized Windows verbatim prefix from an argv token, including
/// `--flag=\\?\...` or `-m=\\?\...` forms.
pub(crate) fn strip_windows_verbatim_prefix_arg(arg: &str) -> Cow<'_, str> {
    let direct = strip_windows_verbatim_prefix_str(arg);
    if direct.len() != arg.len() {
        return direct;
    }
    if let Some((flag, value)) = arg.split_once('=') {
        if flag.starts_with('-') {
            let stripped = strip_windows_verbatim_prefix_str(value);
            if stripped.len() != value.len() {
                return Cow::Owned(format!("{flag}={stripped}"));
            }
        }
    }
    Cow::Borrowed(arg)
}

/// Compare two path strings ignoring a leading Windows verbatim prefix (`\\?\`,
/// `\\?\UNC\`).
pub(crate) fn same_verbatim_stripped_path(left: &str, right: &str) -> bool {
    strip_windows_verbatim_prefix_str(left) == strip_windows_verbatim_prefix_str(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_drive_and_unc_verbatim_prefixes_while_preserving_unicode_and_spaces() {
        assert_eq!(
            strip_windows_verbatim_prefix_str(r"\\?\C:\한글 모델\sub dir\weights.gguf"),
            r"C:\한글 모델\sub dir\weights.gguf"
        );
        assert_eq!(
            strip_windows_verbatim_prefix_str(r"\\?\D:/models/draft model.gguf"),
            r"D:/models/draft model.gguf"
        );
        assert_eq!(
            strip_windows_verbatim_prefix_str(r"\\?\UNC\server\share\한글 폴더\mmproj.gguf"),
            r"\\server\share\한글 폴더\mmproj.gguf"
        );
        assert_eq!(
            strip_windows_verbatim_prefix_str(r"\\?\unc\fileserver\models\mtp-draft.gguf"),
            r"\\fileserver\models\mtp-draft.gguf"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(PathBuf::from(r"\\?\C:\models\a.gguf")),
            PathBuf::from(r"C:\models\a.gguf")
        );
    }

    #[test]
    fn strips_verbatim_prefixes_inside_equals_option_tokens() {
        assert_eq!(
            strip_windows_verbatim_prefix_arg(r"--model=\\?\C:\한글 모델\model.gguf"),
            r"--model=C:\한글 모델\model.gguf"
        );
        assert_eq!(
            strip_windows_verbatim_prefix_arg(r"--mmproj=\\?\UNC\server\share\mmproj.gguf"),
            r"--mmproj=\\server\share\mmproj.gguf"
        );
        assert_eq!(
            strip_windows_verbatim_prefix_arg(r"-md=\\?\unc\nas\models\draft.gguf"),
            r"-md=\\nas\models\draft.gguf"
        );
        assert_eq!(
            strip_windows_verbatim_prefix_arg(r"\\?\C:\engines\serve.exe"),
            r"C:\engines\serve.exe"
        );
    }

    #[test]
    fn leaves_ordinary_posix_urls_and_device_namespaces_untouched() {
        for unchanged in [
            r"C:\models\ordinary.gguf",
            r"\\server\share\ordinary.gguf",
            "/synthetic/models/model.gguf",
            "https://example.invalid/models?v=1",
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\models\a.gguf",
            r"\\?\Global\PIPE\synthetic",
            r"\\?\한글",
            "--literal=http://example.invalid?x=1",
        ] {
            assert_eq!(strip_windows_verbatim_prefix_str(unchanged), unchanged);
            assert_eq!(strip_windows_verbatim_prefix_arg(unchanged), unchanged);
        }
    }

    #[test]
    fn compares_verbatim_and_plain_paths_as_equal() {
        assert!(same_verbatim_stripped_path(
            r"\\?\C:\한글 모델\model.gguf",
            r"C:\한글 모델\model.gguf"
        ));
        assert!(same_verbatim_stripped_path(
            r"\\?\UNC\server\share\model.gguf",
            r"\\server\share\model.gguf"
        ));
        assert!(!same_verbatim_stripped_path(
            r"\\?\C:\models\a.gguf",
            r"C:\models\b.gguf"
        ));
    }
}
