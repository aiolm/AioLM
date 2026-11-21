use std::{fs, io, path::Path};

pub(super) fn stage(destination: &Path) -> io::Result<()> {
    let fixture = Path::new(env!("CARGO_BIN_EXE_fake-llama-server"));
    fs::copy(fixture, destination)?;
    #[cfg(windows)]
    {
        // The GNU Windows fixture links the app's WebView loader dynamically.
        // A relocated process must find it beside its executable, not on PATH.
        let loader = fixture.with_file_name("WebView2Loader.dll");
        if loader.is_file() {
            fs::copy(loader, destination.with_file_name("WebView2Loader.dll"))?;
        }
    }
    Ok(())
}
