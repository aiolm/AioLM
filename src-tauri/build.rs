fn main() {
    // Refresh embedded window/executable icons when artwork changes in dev builds.
    println!("cargo:rerun-if-changed=icons");
    // Materialize generated context inputs before any consuming Rust unit.
    let attributes = tauri_build::Attributes::new().codegen(tauri_build::CodegenContext::new());
    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
