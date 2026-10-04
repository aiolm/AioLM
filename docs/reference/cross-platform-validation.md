# Cross-platform validation

Starting with v0.2.1, releases include Windows x64 NSIS/MSI and Linux x86_64
(Ubuntu 24.04+) DEB/AppImage packages. See the
[Linux installation guide](../guides/install.md#linux). Additional validation
packages are available through the desktop-packages workflow. macOS and Linux
ARM64/DGX acceptance remain separate gates.
Linux and macOS have host packaging and native CI gates; source changes and a
passing Windows suite alone are not evidence of support on another OS.

The [Linux/macOS handoff (한국어)](linux-macos-handoff.ko.md) records the completed
Windows and local Linux verification and the remaining native checks.

On 2026-10-03–04, local Ubuntu 26.04 x64 verification passed the frontend suite
(1,450 tests), typecheck, lint, production build, Rust format and Clippy, 722 native
tests, debug desktop/CLI builds and the CLI smoke with an isolated home. Nine
live-environment tests and one internal subprocess fixture were excluded from the
default result. Build dependencies
were extracted into a temporary directory without a system install. This does not
establish the Ubuntu 24.04 package baseline or desktop acceptance.

Actual b11349 CPU, Vulkan0 and ROCm0 installs, streaming model chats, server cleanup
and benchmark cancellation preserving completed rows passed with a public
Qwen2.5-0.5B-Instruct Q4_K_M model. CPU runtime ZIP export/import and subsequent
inference also passed. The native Tauri/WebKitGTK GUI was exercised in isolated
X11/DBus sessions: onboarding, settings/project persistence, 11 navigation panels,
Unicode model paths, CPU loading, chat/cancellation/unload and authenticated
OpenAI/Anthropic loopback routes. Native GTK portal PDF grounded chat and DOCX
embedding retrieval passed, as did SmolVLM image attachment/sidecar inference,
actual clipboard copying, completed benchmark history and native CSV/XLSX export.
IBus Hangul composition passed with actual key events. A separate Weston Wayland
session passed clean onboarding, all navigation panels, CPU chat and unload
without JavaScript errors. Later native checks covered Weston clipboard paste,
Hangul input, window controls, Unicode PDF portal selection/cancellation, GNOME
AppIndicator hide/Show/second-launch recovery and actual KDE Plasma tray hide/Show/Quit.
A synthetic stdio MCP server passed discovery, call preparation,
native Yes/No and cancellation with dialog/process cleanup. Detailed results and
remaining gaps are in the Korean handoff. Linux Secret Service roundtrip/update/
delete and unavailable-store handling passed on a separate DBus and temporary
home. A pinned official PR CPU source build, build cancellation cleanup, and
inference using the source-built runtime also passed.
The no-tray Wayland close bug was fixed by checking for a registered desktop host.
Existing preferences remain saveable without that host. A Linux DBus runtime
feature conflict that panicked during notification submission was corrected;
actual dunst notification display and Secret Service/GTK portal regression checks
passed. Personalization editing and skill content in real model requests passed;
the small test model's instruction-following accuracy is not guaranteed.

The [portability commit's CI](https://github.com/aiolm/AioLM/actions/runs/37033112852)
stopped at Clippy on Linux and both macOS architectures; their tests and builds
were skipped. Platform-specific unused code and a missing Unix test fixture
directory have been corrected locally. CI now also installs the npm version
declared in `package.json`; `setup-node` alone used the bundled npm version.
The [final code CI](https://github.com/aiolm/AioLM/actions/runs/37192658718), at
implementation commit `a203ff6`, passed
frontend, Windows, Ubuntu and both macOS checks, builds and isolated CLI tests.
Windows also passed real CPU install/inference/restart/stop and Credential Manager
roundtrips. The CLI no longer leaves inherited output handles in detached children
or mixes taskkill messages into its JSON output.
The [final code package build](https://github.com/aiolm/AioLM/actions/runs/37192656705)
passed on all four runners, including Windows/Linux installed-package checks.
Actual Windows NSIS install/update/remove and MSI
install/repair/remove, including installed CLI smoke, passed in the
[installer check](https://github.com/aiolm/AioLM/actions/runs/37184668687).
That run also passed Ubuntu 24.04 DEB dependency installation, installed CLI,
same-version reinstall and removal. Genuine historical release upgrades remain
unverified; the synthetic-version fixture is described below.

The [final Linux packaged desktop run](https://github.com/aiolm/AioLM/actions/runs/37193916897)
explicitly selected package run `37192656705` and passed both desktop and KDE jobs.
The Ubuntu job of the [follow-up CI](https://github.com/aiolm/AioLM/actions/runs/37193477047)
also passed real Secret Service lock/native cancellation/recovery alongside the
ordinary tests, build and CLI smoke. Verification commit `8bb653f` retains the app
implementation from `a203ff6`. Desktop verification commit `b8e6d4b` supplies
CJK fonts on the minimal runner; final AppImage screenshots also showed Korean,
Japanese and Chinese labels correctly.

Additional Linux acceptance exercised GPU1 and two-device layer splitting with both
Vulkan and ROCm, CPU-reference perplexity comparison/cancellation, synthetic LoRA
loading and compatible draft-simple inference. It also covered long case-distinct
Unicode model paths with simultaneous sessions, actual Hub download cancellation/
retry/hash/reuse, read-only setting failures, idle unload, crash/restart recovery,
Responses API persistence/continuation and port conflicts. Closing the final app
with two models, the API and an MCP approval pending terminated the app, model/MCP
processes, native dialog and listeners.

Actual legacy-layout migration exposed lost Unix executable permissions. The copy
now preserves ordinary Unix mode bits, including private-file permissions, without
special privilege bits; Windows copying is unchanged. A regression test and actual
GUI migration within and across filesystems, migrated-runtime inference and restart
passed. Locked Secret Service
headless refusal, native read/write authentication cancellation and original-secret
recovery after daemon restart/unlock are now repeatable in Linux CI through
[`smoke-linux-vault.py`](../../scripts/smoke-linux-vault.py).

[`linux-desktop-acceptance.yml`](../../.github/workflows/linux-desktop-acceptance.yml)
reuses a successful same-repository package run, verifies checksums and performs
real DEB persistence, FUSE and KDE checks in disposable hosted runners. Supply its
`package_run_id` input to select the artifact source. The DEB predecessor is the
current binary with synthetic version `0.2.0~acceptance0`, not a historical release.
The public benchmark native window rendered successfully, but no public records
were available to import. Account-backed sharing, authenticated/paid external APIs,
other GPU/distribution combinations, model-specific decoding architectures and
long-duration soak tests still require their external conditions.

## Build and test gates

Use the pinned Node/npm and Rust versions in `package.json`, `.node-version` and
`rust-toolchain.toml`. Install the target OS's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
On Debian/Ubuntu the native build needs WebKitGTK 4.1, a C/C++ toolchain, OpenSSL,
libxdo, Ayatana AppIndicator and librsvg development packages. AppImage packaging
also needs `patchelf`. `pciutils` supplies optional GPU marketing names; its absence
does not prevent sysfs detection.

Linux MCP approval dialogs require `zenity`. DEB metadata declares that dependency;
AppImage hosts need it installed separately. A missing dialog executable fails the
tool call without running the requested tool.

```sh
npm install --global "$(node -p 'require("./package.json").packageManager')"
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

On Linux, the native vault acceptance additionally requires `gnome-keyring`,
`xvfb`, `xauth`, `dbus-x11`, `python3-gi`, `gir1.2-atspi-2.0` and `at-spi2-core`.
With the Rust toolchain and normal build dependencies available, run:

```sh
python3 scripts/smoke-linux-vault.py
```

It creates separate temporary homes and DBus sessions for headless and graphical
checks. Both actual read/write authentication prompts must be cancelled before
original-secret recovery can pass; an unavailable accessibility service is a test
setup failure, not a successful cancellation.

The CLI smoke uses a temporary directory, overrides both the current home and all
legacy migration roots in the child environment, and removes only its own files.
It verifies help, empty initial model/runtime selection, a saved setting roundtrip,
atomic runtime selection, invalid-selection rollback, diagnostics and stopped-server
state. It does not start a model or access credentials.
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

Local DEB/AppImage generation passed with GUI/CLI included and test fixtures/data
excluded. The AppImage also launched under `APPIMAGE_EXTRACT_AND_RUN=1` in an
isolated X11 session and completed a CPU chat and native MCP approval/call.
The package staging files were scanned for development home/workspace paths in
UTF-8/UTF-16 with no matches. Hosted Ubuntu DEB installation/reinstallation/removal
passed. A subsequent hosted check passed actual FUSE mount, mounted CLI and
AppImage GUI launch. DEB upgrade persistence passed using a synthetic predecessor
whose Version field differs; genuine historical release upgrades remain unverified.

| Host | Formats | Local output |
| --- | --- | --- |
| Windows | NSIS, MSI | `.codex-target/release/bundle/` |
| Linux | DEB, AppImage | `.codex-target/release/bundle/` |
| macOS | APP, DMG | `.codex-target/release/bundle/` |

The **Validate desktop packages** GitHub Actions workflow is manually
dispatched. It has read-only repository permissions, no signing credentials and no
release publication step. Artifacts are for acceptance testing. Run the normal CI
first, then install and launch the package on a clean target machine/session.
Package generation does not establish installation or update success.

The workflow also installs, reinstalls/repairs and removes Windows NSIS/MSI and
Ubuntu DEB packages on disposable hosted runners, checking the installed CLI.
To repeat installer checks without rebuilding, supply `package_run_id` from a
successful package workflow in this repository. It verifies artifact checksums
before installation. The installer script refuses personal/self-hosted machines.

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

CLI stop/restart now waits up to ten seconds for the managed server to exit after
the termination signal, retaining state on timeout. Headless logs now use an
independent collector that drains the server's pipes until EOF, keeps at most 1MiB
and redacts complete lines. Tests cover launcher exit, split secrets/UTF-8, EOF,
oversized lines and file-error recovery. Actual CPU requests after the starting
CLI exited and after restart produced new logs; stop reclaimed both processes.

MCP native tool schemas are normalized from `inputSchema` for UI/chat consumers.
Approval descriptions preserve UTF-8 boundaries. Linux approval processes are
owned by their call so cancellation and timeout also close the dialog.
The CLI command `runtime select <backend> <build>` validates and saves the pair
together, including first-run configuration. Invalid selections preserve saved
settings. Windows CI additionally runs the opt-in `native_cpu` live download and
CLI lifecycle test with a public hash-pinned 491 MB model, and an isolated synthetic
Credential Manager roundtrip. The CPU lifecycle test also passed locally on Linux.

| Area | Required observations |
| --- | --- |
| Install/launch | Clean install, CLI included, launch from desktop menu/Finder, second launch restores the existing window, uninstall leaves user data according to policy |
| UI | Navigation, resizing, native/custom title bar, Unicode input, IME, clipboard, drag/drop, dialogs, long paths and spaces |
| Tray | Show/Quit menu, close-to-tray on/off, no permanently hidden window when the desktop has no indicator support; Linux tray left-click events differ from Windows |
| Credentials | Save/load/delete with the real OS store; Linux Secret Service unlocked, locked and unavailable; macOS Keychain allow/deny/cancel |
| Model files | Download/cancel/resume, scans, case-distinct POSIX files, symlinks, missing mounts, import/export, deletion limited to synthetic fixtures |
| Runtime | Correct OS/arch asset, nested archives, shared libraries and executable permissions; install/import/export/uninstall; source builds and cancellation |
| Model lifecycle | CPU first, then each supported GPU backend; start, streaming completion, cancel loading/generation, stop, restart, app exit, no residual processes or sockets |
| MCP | stdio fixtures, approval accept/deny/cancel, interrupted startup/tool calls, process descendants and native approval dialog close; HTTP transport is not implemented |
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
