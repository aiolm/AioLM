//! Native save of benchmark CSV text and XLSX bytes for the desktop app.
//!
//! The webview cannot reliably start a download for generated files, so the
//! frontend hands the CSV text or the finished XLSX workbook to the backend and
//! the user picks the destination in a native dialog. The frontend never
//! supplies a path, only a file name that pre-fills the dialog and can still be
//! changed there.
use std::path::{Path, PathBuf};

pub(crate) const DEFAULT_FILE_NAME: &str = "aiolm-benchmarks.csv";
pub(crate) const DEFAULT_XLSX_FILE_NAME: &str = "aiolm-benchmarks.xlsx";

/// Longest file name in UTF-8 bytes. 255 is the strictest common per-component
/// limit (ext4, APFS) and also bounds NTFS's 255 UTF-16 units.
const MAX_FILE_NAME_BYTES: usize = 255;

/// Characters Windows rejects in file names; `/` and `\` double as the path
/// separators that would turn a name into a path.
const WINDOWS_INVALID_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// A frontend-supplied name is only a suggestion for the dialog, so a missing
/// or unusable one falls back to `DEFAULT_FILE_NAME` instead of failing the
/// export.
pub(crate) fn suggested_file_name(requested: Option<&str>) -> &str {
    suggested(requested, "csv", DEFAULT_FILE_NAME)
}

/// Same policy as `suggested_file_name`, for the `.xlsx` workbook export.
pub(crate) fn suggested_xlsx_file_name(requested: Option<&str>) -> &str {
    suggested(requested, "xlsx", DEFAULT_XLSX_FILE_NAME)
}

fn suggested<'a>(requested: Option<&'a str>, extension: &str, default: &'static str) -> &'a str {
    requested
        .filter(|name| is_valid_file_name(name, extension))
        .unwrap_or(default)
}

/// A plain base name with the expected extension: no path, control or
/// Windows-invalid characters, and short enough for common filesystems.
/// Unicode model names stay valid.
fn is_valid_file_name(name: &str, expected_extension: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    name.len() <= MAX_FILE_NAME_BYTES
        && extension.eq_ignore_ascii_case(expected_extension)
        && !stem.trim().is_empty()
        && !name
            .chars()
            .any(|ch| ch.is_control() || WINDOWS_INVALID_CHARS.contains(&ch))
}

/// Prefix a byte order mark so spreadsheet apps recognize UTF-8 model names
/// when opening the CSV directly.
const UTF8_BOM: &str = "\u{feff}";

/// Ask `choose_path` where to save and write `contents` there. `Ok(false)`
/// means the user cancelled and nothing was written; `Ok(true)` is returned only
/// after the file has been fully replaced on disk.
pub(crate) fn save(
    contents: &str,
    choose_path: impl FnOnce() -> Option<PathBuf>,
) -> Result<bool, String> {
    save_bytes(&encode(contents), "CSV", choose_path)
}

/// Same contract as `save` for a finished XLSX workbook. The bytes are a ZIP
/// container, so they are written exactly as received: no BOM, no text
/// conversion.
pub(crate) fn save_xlsx(
    contents: &[u8],
    choose_path: impl FnOnce() -> Option<PathBuf>,
) -> Result<bool, String> {
    save_bytes(contents, "XLSX", choose_path)
}

fn save_bytes(
    bytes: &[u8],
    format: &str,
    choose_path: impl FnOnce() -> Option<PathBuf>,
) -> Result<bool, String> {
    let Some(path) = choose_path() else {
        return Ok(false);
    };
    write(&path, bytes, format)?;
    Ok(true)
}

/// Prefix exactly one BOM without touching any other byte, including CRLF
/// line breaks, so a caller that already added a BOM does not produce two.
fn encode(contents: &str) -> Vec<u8> {
    let body = contents.trim_start_matches(UTF8_BOM);
    let mut bytes = Vec::with_capacity(UTF8_BOM.len() + body.len());
    bytes.extend_from_slice(UTF8_BOM.as_bytes());
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

fn write(path: &Path, bytes: &[u8], format: &str) -> Result<(), String> {
    crate::config::atomic_write(path, bytes).map_err(|error| {
        format!(
            "The benchmark {format} could not be saved to {}: {error}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("aiolm-csv-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn saves_utf8_with_one_bom_and_keeps_crlf_bytes() {
        let root = root();
        let target = root.join(DEFAULT_FILE_NAME);
        let csv = "모델,tg_tps\r\n합성-모델,10.5\r\n";

        assert!(save(csv, || Some(target.clone())).unwrap());

        let mut expected = vec![0xEF, 0xBB, 0xBF];
        expected.extend_from_slice(csv.as_bytes());
        assert_eq!(fs::read(&target).unwrap(), expected);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn does_not_duplicate_a_bom_the_caller_already_added() {
        let root = root();
        let target = root.join(DEFAULT_FILE_NAME);

        assert!(save("\u{feff}\u{feff}a,b\r\n", || Some(target.clone())).unwrap());

        assert_eq!(fs::read(&target).unwrap(), b"\xEF\xBB\xBFa,b\r\n");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn replaces_an_existing_file_completely() {
        let root = root();
        let target = root.join(DEFAULT_FILE_NAME);
        fs::write(&target, "old content that is longer than the new content").unwrap();

        assert!(save("a\r\n", || Some(target.clone())).unwrap());

        assert_eq!(fs::read(&target).unwrap(), b"\xEF\xBB\xBFa\r\n");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn suggests_meaningful_names_and_keeps_unicode_model_names() {
        for name in [
            "aiolm-benchmark_합성-모델-Q4_K_M_2026-09-29_12-34-56.csv",
            "aiolm-benchmarks-all_2026-09-29_12-34-56.csv",
            "UPPER.CSV",
            ".hidden.csv",
        ] {
            assert_eq!(suggested_file_name(Some(name)), name);
        }
    }

    #[test]
    fn missing_file_name_falls_back_to_the_default() {
        assert_eq!(suggested_file_name(None), DEFAULT_FILE_NAME);
    }

    #[test]
    fn rejects_paths_and_names_that_are_not_csv() {
        for name in [
            "",
            ".csv",
            "  .csv",
            "report",
            "report.txt",
            "report.csv.exe",
            "report.csv ",
            "dir/report.csv",
            "dir\\report.csv",
            "../report.csv",
            "..\\report.csv",
            "C:\\report.csv",
            "/etc/report.csv",
        ] {
            assert_eq!(
                suggested_file_name(Some(name)),
                DEFAULT_FILE_NAME,
                "{name:?}"
            );
        }
    }

    #[test]
    fn rejects_control_and_windows_invalid_characters() {
        for ch in [
            '<', '>', ':', '"', '|', '?', '*', '\0', '\n', '\r', '\t', '\u{7f}', '\u{85}',
        ] {
            let name = format!("aiolm-{ch}model.csv");
            assert_eq!(
                suggested_file_name(Some(&name)),
                DEFAULT_FILE_NAME,
                "{name:?}"
            );
        }
    }

    #[test]
    fn limits_the_name_to_255_utf8_bytes() {
        let fits = format!("{}.csv", "a".repeat(255 - 4));
        let too_long = format!("{}.csv", "a".repeat(255 - 3));
        // Each Hangul syllable takes three bytes: 84 * 3 + ".csv" = 256.
        let multibyte = format!("{}.csv", "모".repeat(84));

        assert_eq!(suggested_file_name(Some(&fits)), fits);
        assert_eq!(suggested_file_name(Some(&too_long)), DEFAULT_FILE_NAME);
        assert_eq!(suggested_file_name(Some(&multibyte)), DEFAULT_FILE_NAME);
    }

    #[test]
    fn cancelled_dialog_reports_false_and_writes_nothing() {
        let root = root();

        assert!(!save("a,b\r\n", || None).unwrap());

        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn write_failure_is_reported_and_leaves_no_temporary_file() {
        let root = root();
        // A directory cannot be replaced by a file, on Windows and elsewhere.
        let target = root.join(DEFAULT_FILE_NAME);
        fs::create_dir(&target).unwrap();

        let error = save("a,b\r\n", || Some(target.clone())).unwrap_err();

        assert!(error.contains("could not be saved"), "{error}");
        assert!(error.contains(DEFAULT_FILE_NAME), "{error}");
        assert!(target.is_dir());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    /// A ZIP local file header, a NUL, a lone 0xFF and a UTF-8 BOM-like run in
    /// the middle: bytes a text-mode writer would corrupt or prefix.
    const XLSX_BYTES: &[u8] = b"PK\x03\x04\x14\0\0\0\x08\0\xEF\xBB\xBF\xFF\r\n\0\0PK\x05\x06";

    #[test]
    fn saves_xlsx_bytes_exactly_without_a_bom() {
        let root = root();
        let target = root.join(DEFAULT_XLSX_FILE_NAME);

        assert!(save_xlsx(XLSX_BYTES, || Some(target.clone())).unwrap());

        let saved = fs::read(&target).unwrap();
        assert_eq!(saved, XLSX_BYTES);
        assert!(saved.starts_with(b"PK\x03\x04"));
        assert!(saved.contains(&0));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn replaces_an_existing_xlsx_completely() {
        let root = root();
        let target = root.join(DEFAULT_XLSX_FILE_NAME);
        fs::write(&target, vec![7u8; 4096]).unwrap();

        assert!(save_xlsx(XLSX_BYTES, || Some(target.clone())).unwrap());

        assert_eq!(fs::read(&target).unwrap(), XLSX_BYTES);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cancelled_xlsx_dialog_reports_false_and_writes_nothing() {
        let root = root();

        assert!(!save_xlsx(XLSX_BYTES, || None).unwrap());

        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn xlsx_write_failure_is_reported_and_leaves_no_temporary_file() {
        let root = root();
        let target = root.join(DEFAULT_XLSX_FILE_NAME);
        fs::create_dir(&target).unwrap();

        let error = save_xlsx(XLSX_BYTES, || Some(target.clone())).unwrap_err();

        assert!(error.contains("XLSX could not be saved"), "{error}");
        assert!(error.contains(DEFAULT_XLSX_FILE_NAME), "{error}");
        assert!(target.is_dir());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn suggests_xlsx_names_and_keeps_unicode_model_names() {
        for name in [
            "aiolm-benchmark_합성-모델-Q4_K_M_2026-09-29_12-34-56.xlsx",
            "aiolm-benchmarks-all_2026-09-29_12-34-56.xlsx",
            "UPPER.XLSX",
            ".hidden.xlsx",
        ] {
            assert_eq!(suggested_xlsx_file_name(Some(name)), name);
        }
    }

    #[test]
    fn missing_xlsx_file_name_falls_back_to_the_default() {
        assert_eq!(suggested_xlsx_file_name(None), DEFAULT_XLSX_FILE_NAME);
    }

    #[test]
    fn xlsx_names_must_have_the_xlsx_extension_and_csv_names_the_csv_one() {
        for name in [
            "",
            ".xlsx",
            "  .xlsx",
            "report",
            "report.csv",
            "report.xls",
            "report.xlsm",
            "report.xlsx.exe",
            "report.xlsx ",
        ] {
            assert_eq!(
                suggested_xlsx_file_name(Some(name)),
                DEFAULT_XLSX_FILE_NAME,
                "{name:?}"
            );
        }
        assert_eq!(suggested_file_name(Some("report.xlsx")), DEFAULT_FILE_NAME);
    }

    #[test]
    fn xlsx_names_reject_paths_control_and_windows_invalid_characters() {
        for name in [
            "dir/report.xlsx",
            "dir\\report.xlsx",
            "../report.xlsx",
            "..\\report.xlsx",
            "C:\\report.xlsx",
            "/etc/report.xlsx",
        ] {
            assert_eq!(
                suggested_xlsx_file_name(Some(name)),
                DEFAULT_XLSX_FILE_NAME,
                "{name:?}"
            );
        }
        for ch in [
            '<', '>', ':', '"', '|', '?', '*', '\0', '\n', '\r', '\t', '\u{7f}', '\u{85}',
        ] {
            let name = format!("aiolm-{ch}model.xlsx");
            assert_eq!(
                suggested_xlsx_file_name(Some(&name)),
                DEFAULT_XLSX_FILE_NAME,
                "{name:?}"
            );
        }
    }

    #[test]
    fn limits_the_xlsx_name_to_255_utf8_bytes() {
        let fits = format!("{}.xlsx", "a".repeat(255 - 5));
        let too_long = format!("{}.xlsx", "a".repeat(255 - 4));
        // Each Hangul syllable takes three bytes: 83 * 3 + ".xlsx" = 254 fits,
        // 84 * 3 + ".xlsx" = 257 does not.
        let multibyte_fits = format!("{}.xlsx", "모".repeat(83));
        let multibyte_too_long = format!("{}.xlsx", "모".repeat(84));

        assert_eq!(suggested_xlsx_file_name(Some(&fits)), fits);
        assert_eq!(
            suggested_xlsx_file_name(Some(&multibyte_fits)),
            multibyte_fits
        );
        assert_eq!(
            suggested_xlsx_file_name(Some(&too_long)),
            DEFAULT_XLSX_FILE_NAME
        );
        assert_eq!(
            suggested_xlsx_file_name(Some(&multibyte_too_long)),
            DEFAULT_XLSX_FILE_NAME
        );
    }
}
