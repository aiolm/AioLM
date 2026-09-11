//! Developer packaging utility. Uses the same verified, cancellable bundle
//! path as the UI. For staging exports, set APPDATA/XDG_DATA_HOME to an isolated
//! directory; never overwrite an installed official build with a local one.
use aiolm_lib::runtime;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let cancel = Arc::new(AtomicBool::new(false));
    let interrupt = cancel.clone();
    let signal = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            interrupt.store(true, Ordering::Release);
        }
    });
    let result = match args.as_slice() {
        [action, backend, build, output] if action == "export" => {
            let (backend, build, output) = (backend.clone(), build.clone(), output.clone());
            tokio::task::spawn_blocking(move || {
                runtime::export_bundle(
                    Path::new(&output),
                    &backend,
                    &build,
                    &|phase, _, _| eprintln!("{phase}"),
                    &cancel,
                )
            })
            .await
            .map_err(|error| error.to_string())?
            .map(|info| format!("{} sha256={}", info.path, info.archive_sha256))
        }
        [action, archive] if action == "import" => runtime::import_bundle(
            Path::new(archive),
            &|phase, _, _| eprintln!("{phase}"),
            cancel,
        )
        .await
        .map(|installed| installed.dir),
        _ => Err(
            "usage: runtime-bundle export <backend> <build> <output.zip> | import <bundle.zip>"
                .into(),
        ),
    };
    signal.abort();
    println!("{}", result?);
    Ok(())
}
