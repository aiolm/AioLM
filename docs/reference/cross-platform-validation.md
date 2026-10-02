# Cross-platform validation

The published release remains Windows x64 until native acceptance is complete.
Linux and macOS have host packaging and native CI gates; source changes and a
passing Windows suite alone are not evidence of support on another OS.

The [Linux/macOS handoff (한국어)](linux-macos-handoff.ko.md) records the completed
Windows verification and the next native checks to run from a Linux workstation.

## Build and test gates

Use the pinned Node/npm and Rust versions in `package.json`, `.node-version` and
`rust-toolchain.toml`. Install the target OS's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
On Debian/Ubuntu the native build needs WebKitGTK 4.1, a C/C++ toolchain, OpenSSL,
libxdo, Ayatana AppIndicator and librsvg development packages. AppImage packaging
also needs `patchelf`. `pciutils` supplies optional GPU marketing names; its absence
does not prevent sysfs detection.

```sh
npm ci --ignore-scripts
npm rebuild esbuild
npm test
npm run typecheck
npm run lint
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features
cargo build --locked --manifest-path src-tauri/Cargo.toml --bins
npm run test:native-cli
```

The CLI smoke uses a temporary directory, overrides both the current home and all
legacy migration roots in the child environment, and removes only its own files.
It verifies help, empty initial model/runtime selection, a saved setting roundtrip,
diagnostics and stopped-server state. It does not start a model or access credentials.
Point it at a release binary with:

```sh
npm run test:native-cli -- .codex-target/release/aiolm-cli
```

Native CI runs on `ubuntu-24.04`, `macos-15` (ARM64) and `macos-15-intel` (x64).
The Unix suites include descendant process cleanup, interrupted MCP startup/tool
calls, TCP listener ownership, CLI process identity and process RSS sampling.
Tests of parsers, archive containment, OS/architecture asset selection and profile
identity also run on Windows with synthetic data.

## Packaging

`npm run package:tauri` builds the CLI, frontend and packages for the current host:

The `test-fixtures` default Cargo feature keeps the fake-server integration test
enabled in ordinary `cargo test`. Distribution scripts disable default features
so that helper is neither built nor bundled. Do not enable `test-fixtures` when
creating distribution packages.

| Host | Formats | Local output |
| --- | --- | --- |
| Windows | NSIS, MSI | `.codex-target/release/bundle/` |
| Linux | DEB, AppImage | `.codex-target/release/bundle/` |
| macOS | APP, DMG | `.codex-target/release/bundle/` |

The **Validate Linux and macOS packages** GitHub Actions workflow is manually
dispatched. It has read-only repository permissions, no signing credentials and no
release publication step. Artifacts are for acceptance testing. Run the normal CI
first, then install and launch the package on a clean target machine/session.
Package generation does not establish installation or update success.

Linux builds inherit the glibc baseline of their build host. The current package
workflow targets Ubuntu 24.04; do not promise older distribution support from those
artifacts. AppImage bundles are not a substitute for testing WebKitGTK and graphics
integration on each supported distribution. See [Tauri AppImage guidance](https://v2.tauri.app/distribute/appimage/).

Before a macOS public release, choose a minimum supported macOS version and verify
the resulting WebKit requirements. Tailwind v4 requires Safari 16.4-level WebKit;
the bundler's default deployment target alone is not a UI compatibility promise.
See [Tailwind browser requirements](https://tailwindcss.com/docs/compatibility).
Configure Developer ID signing and notarization
through CI secrets, then test the downloaded artifact under Gatekeeper. Unsigned CI
DMGs do not establish that experience. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).

## Native acceptance

Use a separate OS account for manual first-run and migration tests. Setting
`AIOLM_HOME` alone does not isolate legacy migration sources or OS credential stores.
Never reuse production settings, credentials or model deletion targets as fixtures.

| Area | Required observations |
| --- | --- |
| Install/launch | Clean install, CLI included, launch from desktop menu/Finder, second launch restores the existing window, uninstall leaves user data according to policy |
| UI | Navigation, resizing, native/custom title bar, Unicode input, IME, clipboard, drag/drop, dialogs, long paths and spaces |
| Tray | Show/Quit menu, close-to-tray on/off, no permanently hidden window when the desktop has no indicator support; Linux tray left-click events differ from Windows |
| Credentials | Save/load/delete with the real OS store; Linux Secret Service unlocked, locked and unavailable; macOS Keychain allow/deny/cancel |
| Model files | Download/cancel/resume, scans, case-distinct POSIX files, symlinks, missing mounts, import/export, deletion limited to synthetic fixtures |
| Runtime | Correct OS/arch asset, nested archives, shared libraries and executable permissions; install/import/export/uninstall; source builds and cancellation |
| Model lifecycle | CPU first, then each supported GPU backend; start, streaming completion, cancel loading/generation, stop, restart, app exit, no residual processes or sockets |
| MCP | stdio and HTTP fixtures, approval accept/deny/cancel, interrupted startup/tool calls, process descendants and native approval dialog close |
| API/documents | Loopback auth, OpenAI/Anthropic routes, image input and document embeddings where the model supports them |
| Benchmark | PP/TG, cancellation preserves rows, RSS values, resource estimate, history, CSV/XLSX export, consent-based sharing with a dedicated test account |
| Updates | Version/arch matching, hash failure, interrupted download, manual installer completion, relaunch and persistence; unsupported install formats use release-page fallback |

A small real GGUF is required for model tests. Choose a managed backend/build in
the isolated test account and run the existing opt-in suite:

```sh
export AIOLM_SMOKE=1
export AIOLM_SMOKE_MODEL='/absolute/path/to/test-model.gguf'
export AIOLM_SMOKE_BACKEND=cpu
export AIOLM_SMOKE_BUILD='<installed-build-id>'
cargo test --locked --manifest-path src-tauri/Cargo.toml --test smoke -- --ignored --nocapture --test-threads=1
```

Repeat with each actually available backend. `AIOLM_SMOKE_DEVICE` accepts runtime
device names reported by `--list-devices`. Do not assume GPU enumeration indices.
Record driver, runtime commit/build, model hash and result in local test notes;
do not copy personal settings or environment inventories into source or packages.

The live installer suite downloads into its own temporary data directory and
removes it afterward. It does not run legacy data migration. Test available
backends separately from model inference, for example on Linux:

```sh
AIOLM_RUNTIME_INSTALL=1 AIOLM_RUNTIME_BACKENDS=cpu,vulkan,rocm \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test runtime_install -- --ignored --nocapture --test-threads=1
```

On macOS, select `cpu,metal` on Apple Silicon, or `cpu` for the upstream Intel
archive. The cancellation case uses CPU so it can run on every desktop host.

## macOS work from Linux

Linux can drive the GitHub macOS jobs, inspect logs/artifacts, edit shared code and
review package metadata. The hosted runners execute actual macOS code, including
both architecture branches; Linux cross-compilation alone cannot establish that.
The test workflow does not currently automate the desktop WebView or native dialogs.
[WebdriverIO's Tauri embedded driver](https://v2.tauri.app/develop/tests/webdriver/)
can provide desktop E2E coverage on macOS as well as Linux and Windows.

Check Metal device availability before describing any hosted run as a Metal test.
If the hosted environment does not expose a usable GPU, use an Apple Silicon Mac
through a remote machine, a self-hosted runner or a tester for real-model Metal
acceptance. Intel macOS CPU support needs its own package/run; a successful ARM64
job is not evidence for Intel. Track native UI, signing, installation and GPU checks
as pending until their results are recorded.
