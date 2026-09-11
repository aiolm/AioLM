fn main() {
    // Refresh embedded window/executable icons when artwork changes in dev builds.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
