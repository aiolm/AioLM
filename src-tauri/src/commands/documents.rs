//! Native document and image selection, extraction and bounded reads.
use super::files::open_verified_file;
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tauri::State;
use zip::ZipArchive;

const MAX_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EXTRACTED_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "json", "log", "xml", "html", "htm", "yaml", "yml", "toml",
    "ini", "py", "rs", "ts", "tsx", "js", "jsx", "css", "sql", "sh", "ps1", "docx", "pdf",
];

struct LimitedWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl LimitedWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(limit.min(64 * 1024)),
            limit,
            exceeded: false,
        }
    }
}

impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = self.limit.saturating_sub(self.bytes.len());
        if bytes.len() > remaining {
            self.bytes.extend_from_slice(&bytes[..remaining]);
            self.exceeded = true;
            return Err(io::Error::other(
                "extracted document text exceeds the safety limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[tauri::command]
pub(crate) fn pick_image(state: State<'_, AppState>) -> Option<String> {
    if let Ok(mut selected) = state.selected_image.lock() {
        *selected = None;
    }
    let path = rfd::FileDialog::new()
        .set_title("Choose an image for vision chat")
        .add_filter("Images", IMAGE_EXTENSIONS)
        .pick_file()?;
    let canonical = path.canonicalize().ok()?;
    image_mime_type(&canonical)?;
    let mut selected = state.selected_image.lock().ok()?;
    *selected = Some(canonical.clone());
    Some(canonical.to_string_lossy().into_owned())
}

fn document_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| DOCUMENT_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
}

fn grant_selected_attachment(state: &AppState, path: &Path) -> Result<String, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("cannot select attachment: {error}"))?;
    let selection = if image_mime_type(&canonical).is_some() {
        &state.selected_image
    } else if document_extension(&canonical) {
        &state.selected_document
    } else {
        return Err("unsupported attachment type; choose an image or document".into());
    };
    let mut selected = selection
        .lock()
        .map_err(|_| "attachment selection state was poisoned".to_string())?;
    *selected = Some(canonical.clone());
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn pick_attachment(state: State<'_, AppState>) -> Result<Option<String>, String> {
    *state
        .selected_image
        .lock()
        .map_err(|_| "image selection state was poisoned".to_string())? = None;
    *state
        .selected_document
        .lock()
        .map_err(|_| "document selection state was poisoned".to_string())? = None;
    let path = tokio::task::spawn_blocking(|| {
        let extensions: Vec<&str> = IMAGE_EXTENSIONS
            .iter()
            .chain(DOCUMENT_EXTENSIONS)
            .copied()
            .collect();
        rfd::FileDialog::new()
            .set_title("Choose an attachment for chat")
            .add_filter("Images and documents", &extensions)
            .add_filter("Images", IMAGE_EXTENSIONS)
            .add_filter("Documents", DOCUMENT_EXTENSIONS)
            .pick_file()
    })
    .await
    .map_err(|error| format!("attachment picker task failed: {error}"))?;
    path.map(|path| grant_selected_attachment(&state, &path))
        .transpose()
}

fn xml_text(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    let mut tag = String::new();
    for character in value.chars() {
        match character {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let lower = tag.to_ascii_lowercase();
                if lower.starts_with("/w:p") || lower.starts_with("w:br") {
                    output.push('\n');
                } else if lower.starts_with("w:tab") {
                    output.push('\t');
                }
            }
            _ if in_tag => tag.push(character),
            '&' => output.push('&'),
            _ => output.push(character),
        }
    }
    output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn extract_docx_text(bytes: &[u8]) -> Result<String, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("cannot read DOCX archive: {error}"))?;
    let document = archive
        .by_name("word/document.xml")
        .map_err(|error| format!("DOCX document.xml is missing: {error}"))?;
    if document.size() > MAX_DOCUMENT_BYTES {
        return Err("DOCX document.xml exceeds the 8 MiB safety limit".into());
    }
    let mut xml = String::new();
    document
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_string(&mut xml)
        .map_err(|error| format!("cannot read DOCX XML: {error}"))?;
    if xml.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("DOCX document.xml exceeds the 8 MiB safety limit".into());
    }
    Ok(xml_text(&xml))
}

fn extract_pdf_text(bytes: &[u8]) -> Result<String, String> {
    let mut document = pdf_extract::Document::load_mem(bytes)
        .map_err(|error| format!("cannot load PDF: {error}"))?;
    if document.is_encrypted() {
        document
            .decrypt("")
            .map_err(|error| format!("cannot decrypt PDF without a password: {error}"))?;
    }
    let mut writer = LimitedWriter::new(MAX_EXTRACTED_DOCUMENT_BYTES);
    let extraction = {
        let mut output = pdf_extract::PlainTextOutput::new(&mut writer as &mut dyn Write);
        pdf_extract::output_doc(&document, &mut output)
    };
    if writer.exceeded {
        return Err("extracted PDF text exceeds the 16 MiB safety limit".into());
    }
    extraction.map_err(|error| {
        format!("PDF text extraction failed; scanned/image-only PDFs need OCR: {error}")
    })?;
    Ok(String::from_utf8_lossy(&writer.bytes).into_owned())
}

fn extract_document_text(path: &Path, bytes: &[u8]) -> Result<String, String> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("docx") => extract_docx_text(bytes),
        Some("pdf") => extract_pdf_text(bytes),
        _ => {
            if bytes.contains(&0) {
                return Err(
                    "binary documents are not supported; choose a text, DOCX, or PDF document"
                        .into(),
                );
            }
            Ok(String::from_utf8_lossy(bytes).into_owned())
        }
    }
}

#[tauri::command]
pub(crate) fn pick_document(state: State<'_, AppState>) -> Option<String> {
    if let Ok(mut selected) = state.selected_document.lock() {
        *selected = None;
    }
    let path = rfd::FileDialog::new()
        .set_title("Choose a document for offline chat")
        .add_filter("Documents", DOCUMENT_EXTENSIONS)
        .pick_file()?;
    let canonical = path.canonicalize().ok()?;
    if !document_extension(&canonical) {
        return None;
    }
    let mut selected = state.selected_document.lock().ok()?;
    *selected = Some(canonical.clone());
    Some(canonical.to_string_lossy().into_owned())
}

fn ensure_selected_document_path(
    selected: Option<&Path>,
    requested: &Path,
) -> Result<PathBuf, String> {
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("cannot read document: {error}"))?;
    if selected != Some(canonical.as_path()) {
        return Err("document path was not selected by the native picker".into());
    }
    if !document_extension(&canonical) {
        return Err("unsupported document type; choose a text, DOCX, or PDF document".into());
    }
    Ok(canonical)
}

fn ensure_document_binding_path(requested: &Path) -> Result<PathBuf, String> {
    if !requested.is_absolute() {
        return Err("persisted document bindings must use an absolute path".into());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("cannot read document binding: {error}"))?;
    if !document_extension(&canonical) {
        return Err("unsupported document type; choose a text, DOCX, or PDF document".into());
    }
    let metadata = fs::symlink_metadata(&canonical)
        .map_err(|error| format!("cannot inspect document binding: {error}"))?;
    if !metadata.is_file() {
        return Err("document binding is not a regular file".into());
    }
    Ok(canonical)
}

async fn read_document_path(canonical: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let file = open_verified_file(&canonical, &canonical, "document")?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("cannot inspect document: {error}"))?;
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err("document exceeds the 8 MiB limit".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read document: {error}"))?;
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err("document exceeds the 8 MiB limit".into());
        }
        let text = extract_document_text(&canonical, &bytes)?;
        if text.trim().is_empty() {
            return Err(
                "document has no extractable text; scanned/image-only PDFs need OCR".into(),
            );
        }
        if text.len() > MAX_EXTRACTED_DOCUMENT_BYTES {
            return Err("extracted document text exceeds the 16 MiB safety limit".into());
        }
        Ok(text)
    })
    .await
    .map_err(|error| format!("document read task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn read_document_text(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let canonical = {
        let mut selected = state
            .selected_document
            .lock()
            .map_err(|_| "document selection state was poisoned".to_string())?;
        let canonical = ensure_selected_document_path(selected.as_deref(), Path::new(path.trim()))?;
        *selected = None;
        canonical
    };
    read_document_path(canonical).await
}

#[tauri::command]
pub(crate) async fn read_document_binding(path: String) -> Result<String, String> {
    let canonical = ensure_document_binding_path(Path::new(path.trim()))?;
    read_document_path(canonical).await
}

fn ensure_selected_image_path(
    selected: Option<&Path>,
    requested: &Path,
) -> Result<PathBuf, String> {
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("cannot read image: {error}"))?;
    if selected != Some(canonical.as_path()) {
        return Err("image path was not selected by the native picker".into());
    }
    Ok(canonical)
}

#[tauri::command]
pub(crate) async fn read_image_data(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let canonical = {
        let mut selected = state
            .selected_image
            .lock()
            .map_err(|_| "image selection state was poisoned".to_string())?;
        let canonical = ensure_selected_image_path(selected.as_deref(), Path::new(path.trim()))?;
        *selected = None;
        canonical
    };
    tokio::task::spawn_blocking(move || {
        let mime = image_mime_type(&canonical)
            .ok_or_else(|| "unsupported image type; use PNG, JPEG, or WebP".to_string())?;
        let file = open_verified_file(&canonical, &canonical, "image")?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("cannot inspect image: {error}"))?;
        const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
        if metadata.len() > MAX_IMAGE_BYTES {
            return Err("image exceeds the 20 MiB limit".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read image: {error}"))?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err("image exceeds the 20 MiB limit".into());
        }
        Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
    })
    .await
    .map_err(|error| format!("image read task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_mime_type_accepts_supported_formats_only() {
        assert_eq!(image_mime_type(Path::new("photo.PNG")), Some("image/png"));
        assert_eq!(image_mime_type(Path::new("photo.jpeg")), Some("image/jpeg"));
        assert_eq!(image_mime_type(Path::new("photo.webp")), Some("image/webp"));
        assert_eq!(image_mime_type(Path::new("photo.svg")), None);
    }

    #[test]
    fn unified_attachment_selection_grants_only_the_matching_reader() {
        let root =
            std::env::temp_dir().join(format!("aiolm-attachment-path-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create attachment test directory");
        for (name, is_image) in [("photo.PNG", true), ("manual.PDF", false)] {
            let state = AppState::default();
            let path = root.join(name);
            fs::write(&path, b"selected").expect("write attachment");
            let canonical = path.canonicalize().expect("canonicalize attachment");

            assert_eq!(
                grant_selected_attachment(&state, &path).expect("grant selected attachment"),
                canonical.to_string_lossy()
            );
            let image = state.selected_image.lock().expect("image selection state");
            let document = state
                .selected_document
                .lock()
                .expect("document selection state");
            assert_eq!(
                ensure_selected_image_path(image.as_deref(), &path).is_ok(),
                is_image
            );
            assert_eq!(
                ensure_selected_document_path(document.as_deref(), &path).is_ok(),
                !is_image
            );
        }

        let state = AppState::default();
        let unsupported = root.join("program.exe");
        fs::write(&unsupported, b"unsupported").expect("write unsupported attachment");
        assert!(grant_selected_attachment(&state, &unsupported).is_err());
        assert!(state
            .selected_image
            .lock()
            .expect("image selection state")
            .is_none());
        assert!(state
            .selected_document
            .lock()
            .expect("document selection state")
            .is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn image_read_requires_the_path_returned_by_the_native_picker() {
        let root = std::env::temp_dir().join(format!("aiolm-image-path-{}", std::process::id()));
        fs::create_dir_all(&root).expect("create image test directory");
        let selected = root.join("selected.png");
        let other = root.join("other.png");
        fs::write(&selected, b"selected").expect("write selected image");
        fs::write(&other, b"other").expect("write other image");
        let canonical = selected
            .canonicalize()
            .expect("canonicalize selected image");

        assert!(ensure_selected_image_path(Some(&canonical), &selected).is_ok());
        assert!(ensure_selected_image_path(Some(&canonical), &other).is_err());
        assert!(ensure_selected_image_path(None, &selected).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn document_read_requires_native_selection_and_text_extension() {
        let root =
            std::env::temp_dir().join(format!("aiolm-document-path-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create document test directory");
        let selected = root.join("selected.md");
        let other = root.join("other.md");
        let binary = root.join("binary.exe");
        fs::write(&selected, b"selected").expect("write selected document");
        fs::write(&other, b"other").expect("write other document");
        fs::write(&binary, b"binary").expect("write binary document");
        let canonical = selected
            .canonicalize()
            .expect("canonicalize selected document");

        assert!(document_extension(&selected));
        assert!(document_extension(Path::new("manual.docx")));
        assert!(document_extension(Path::new("manual.PDF")));
        assert!(!document_extension(&binary));
        assert!(ensure_selected_document_path(Some(&canonical), &selected).is_ok());
        assert!(ensure_selected_document_path(Some(&canonical), &other).is_err());
        assert!(ensure_selected_document_path(None, &selected).is_err());
        assert!(ensure_selected_document_path(Some(&canonical), &binary).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn docx_xml_text_preserves_paragraphs_tabs_and_entities() {
        let xml = r#"<w:document><w:p><w:r><w:t>A &amp; B</w:t><w:tab/><w:t>C</w:t></w:r></w:p><w:p><w:t>Next</w:t></w:p></w:document>"#;
        assert_eq!(xml_text(xml), "A & B\tC\nNext\n");
    }

    #[test]
    fn limited_document_writer_stops_before_unbounded_growth() {
        let mut writer = LimitedWriter::new(4);
        assert!(writer.write_all(b"12345").is_err());
        assert_eq!(writer.bytes, b"1234");
        assert!(writer.exceeded);
    }

    #[test]
    fn docx_declared_uncompressed_xml_size_is_bounded() {
        let path =
            std::env::temp_dir().join(format!("aiolm-docx-bomb-{}.docx", uuid::Uuid::new_v4()));
        let file = fs::File::create(&path).expect("create DOCX fixture");
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        archive
            .start_file("word/document.xml", options)
            .expect("start document.xml");
        archive
            .write_all(&vec![b'x'; MAX_DOCUMENT_BYTES as usize + 1])
            .expect("write oversized XML");
        archive.finish().expect("finish DOCX fixture");
        let bytes = fs::read(&path).expect("read DOCX fixture");
        let error = super::extract_docx_text(&bytes).expect_err("oversized XML must be rejected");
        assert!(error.contains("8 MiB"));
        let _ = fs::remove_file(path);
    }
}
