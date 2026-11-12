use super::*;

#[tokio::test]
async fn async_download_writer_writes_chunks_without_sync_file_calls() {
    let path = std::env::temp_dir().join(format!(
        "aiolm-runtime-download-{}-{}.part",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let mut file = tokio::fs::File::create(&path)
        .await
        .expect("create temp file");
    write_download_chunk(&mut file, b"runtime")
        .await
        .expect("write chunk");
    file.flush().await.expect("flush chunk");
    drop(file);
    assert_eq!(fs::read(&path).expect("read temp file"), b"runtime");
    let _ = fs::remove_file(path);
}

#[test]
fn release_asset_filename_must_be_a_safe_supported_archive_basename() {
    assert!(validate_asset_file_name("llama-b10603-bin-win-vulkan-x64.zip").is_ok());
    assert!(validate_asset_file_name("llama-b123-bin-ubuntu-rocm-10.0-x64.tar.gz").is_ok());
    let error = validate_asset_file_name("../runtime.zip").unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    assert!(validate_asset_file_name("runtime.tar.gz").is_ok());
    assert!(validate_asset_file_name("runtime.tar").is_err());
    assert!(validate_asset_file_name("runtime file.zip").is_err());
}

#[test]
fn runtime_download_inputs_keep_validation_errors() {
    for url in [
        "not a URL",
        "http://github.com/runtime.zip",
        "https://example.invalid/runtime.zip",
    ] {
        assert_eq!(
            validate_download_url(url).unwrap_err().kind,
            crate::error::ErrorKind::Validation
        );
    }
    assert_eq!(
        normalize_digest("not a digest").unwrap_err().kind,
        crate::error::ErrorKind::Validation
    );
}

#[tokio::test]
async fn cancelled_runtime_download_keeps_its_kind_without_contacting_the_network() {
    let path = test_directory("cancelled-download").join("runtime.zip");
    let error = download_to_file(
        &|_, _, _| {},
        "downloading",
        "https://github.com/runtime.zip",
        &path,
        &Arc::new(AtomicBool::new(true)),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, crate::error::ErrorKind::Cancelled);
    assert_eq!(error.message, "runtime install cancelled");
    assert!(!path.exists());
}
