# macOS validation builds

macOS candidates target **Ventura 13.3 or later**, with separate Apple Silicon
(`aarch64`) and Intel (`x64`) DMGs. The minimum is a packaging policy chosen for
Tailwind v4's [Safari 16.4 baseline](https://tailwindcss.com/docs/compatibility).
Hosted tests run macOS 15; they do not establish execution on macOS 13.3.
The published v0.2.1 release still contains Windows and Linux packages only.

## Hosted acceptance

The [package workflow](../../.github/workflows/desktop-packages.yml) builds both
architectures and retains DMGs with SHA-256 checksums for 14 days. It publishes no
release. Run it on the source revision you want to validate:

```sh
gh workflow run desktop-packages.yml --ref '<source-branch>' -f platforms=macos
gh run list --workflow desktop-packages.yml
gh run view '<run-id>' --log-failed
gh run download '<run-id>' --dir tmp/macos-packages
```

`package_run_id` can instead select a successful package workflow run for installer
rechecks. Its checksums and app version/minimum OS must match the selected source.
Use the architecture-specific DMG and compare its SHA-256 with `checksums.txt`.

The automated checks cover:

- DMG mount, bundle identifier/version/minimum OS and GUI/CLI architecture;
  exclusion of the fake test server.
- System and synthetic user Applications installation, replacement and removal;
  installed CLI smoke and settings retained after removal. The installed bundle
  is opened through LaunchServices with launchd's environment, as Finder does,
  and leaves through the standard quit request that the Dock sends.
- Managed CPU runtime installation, a hash-pinned Qwen2.5-0.5B-Instruct Q4_K_M
  model, real streaming responses after the CLI exits, restart, continuing logs,
  stop and released ports. The package job selects the release CLI explicitly.
- Real Keychain create/read/update/delete, using a unique synthetic credential
  that the test removes.
- A real Cocoa MCP approval window: cancellation and deadline remove the window
  owned by that call. Tool descriptions are argv data, never executable script.

The [native CI](../../.github/workflows/ci.yml) additionally drives the real
WKWebView: clean onboarding, saved native settings, native frame, close-to-tray,
second-launch restore, normal close and preferences after relaunch. A second
check wraps the same binary in a disposable bundle and opens it through
LaunchServices with launchd's PATH: tray close, LaunchServices reopen of the
running copy without a second instance, an MCP command found only in
`/usr/local/bin`, the standard quit request and no remaining MCP process. The optional
`macos-ui-smoke` Cargo feature registers WebDriver only on macOS with debug
assertions. Ordinary development and distribution builds do not enable it.
Synthetic screenshots are retained as test evidence, separate from packages.
Installer/UI scripts refuse to run outside disposable GitHub-hosted Macs.

macOS runtime probe commands have a 90-second budget; other platforms keep their
existing budget. Metal caches its initialization per executable path, so the first
probe after a runtime is activated starts cold: about 20 seconds on hosted Apple
Silicon and 32-35 seconds on hosted Intel, then about 0.2 seconds. Timeout diagnostics retain bounded initialization output.
For hosted CPU/Metal acceptance, the job fetches public release metadata using
its scoped GitHub token. The test fixture primes the ordinary catalog cache,
then downloads and verifies the actual runtime through the normal installer.
The token is never passed to AioLM or llama.cpp and the fixture is excluded from
distribution builds.

The Metal probe records whether the hosted runner exposes an actual device. On
Apple Silicon, a detected device enables a separate live Metal lifecycle test;
the test requires runtime enumeration, a streaming model answer and nonzero GPU
layer offloading. No exposed device means **unverified Metal inference**, even
when CPU and ARM64 builds pass. The upstream Intel archive is validated for CPU.
Hosted Macs can expose an Apple Paravirtual Metal device. Results from that
device establish execution in the virtual runner; they do not establish physical
Apple Silicon performance, memory limits or driver behavior.

With `source_build=true`, the package workflow also builds merged llama.cpp
PR #29903 at its merged head commit with the runner's Xcode/CMake toolchain:
CPU on both architectures and Metal on Apple Silicon. The job primes only the
PR lookup with its scoped token; the source archive, its commit check, CMake
build, staged preflight, GPU verification and CLI lifecycle use the normal path.

## Commands from Finder and the Dock

LaunchServices starts apps with launchd's PATH, `/usr/bin:/bin:/usr/sbin:/sbin`.
`open` from Terminal instead passes the shell's environment, so it is not a
substitute for testing that path. AioLM appends the directories that
`path_helper` reads from `/etc/paths` and `/etc/paths.d`, plus Homebrew's
`/opt/homebrew/bin` and `/opt/homebrew/sbin`, without changing existing order or
running shell startup files. MCP commands such as `npx` and source-build tools
from the official installers or Homebrew are therefore found after a Finder or
Dock launch. Commands that only shell startup files add, for example from nvm,
Volta, asdf or `~/.local/bin`, need an absolute path; a script that starts with
`#!/usr/bin/env node` also needs `node` in one of those directories. CMake is
found on that PATH or as `CMake.app` in `/Applications` or `~/Applications`.

## Recorded acceptance

On 2026-10-04 UTC, all five jobs in the
[native acceptance run](https://github.com/aiolm/AioLM/actions/runs/37220213887)
passed at revision `d5bca39`, including real CPU inference and WKWebView lifecycle
on both macOS 15 architectures, plus Windows/Linux regression checks.
The [DMG acceptance run](https://github.com/aiolm/AioLM/actions/runs/37218783406)
passed both architectures at revision `877acb3`: installed GUI/CLI, settings
persistence, release CLI CPU inference, Keychain and Cocoa cancellation/deadline
checks. The intervening changes affect CI/tests only; distribution code is the
same. Each DMG has a downloadable SHA-256 checksum in its artifact.

Apple Silicon Metal used llama.cpp `b11393` and the
hash-pinned model above on an Apple Paravirtual device. Both start and restart
reported `offloaded 25/25 layers to GPU`, produced real SSE responses after the
launcher exited, and retained logs; stop released the server port. This is
virtual-runner evidence, separate from physical Mac acceptance.

### Finder launch and source build audit (2026-10-04/05 UTC)

The LaunchServices check reproduced a Finder/Dock defect in
[run 37223412302](https://github.com/aiolm/AioLM/actions/runs/37223412302): with
launchd's PATH, an MCP command in `/usr/local/bin` failed with
`No such file or directory`. After the PATH fix, both Macs in
[run 37225429914](https://github.com/aiolm/AioLM/actions/runs/37225429914) passed
the LaunchServices launch, tray close, reopen without a second instance, MCP
lookup and standard quit. The app then started with
`/usr/bin:/bin:/usr/sbin:/sbin` followed by `/usr/local/bin`, the `/etc/paths.d`
entries and, on Apple Silicon, `/opt/homebrew/bin`.

The first hosted Metal source build exposed a second defect: PR runtimes lacked
`llama-perplexity`, so GPU verification refused to start any GPU source build.
With that tool built, [run 37228362827](https://github.com/aiolm/AioLM/actions/runs/37228362827)
at `d25192b` passed both DMG jobs and every source build: PR #29903 at
`f07be9f` built for CPU on both architectures and for Metal on Apple Silicon
(CMake 4.4.2, Apple clang 17), listed `MTL0`, passed GPU verification, reported
`offloaded 25/25 layers to GPU` at start and restart, answered over SSE and released
its port on stop. Apple Silicon builds took about 25-30 minutes and Intel about 16.
Installed DMG apps in system and user Applications were opened through
LaunchServices and quit through the standard request on both architectures.
Hosted Intel runners also expose an Apple Paravirtual Metal device. At `9a9f458`,
[run 37231505962](https://github.com/aiolm/AioLM/actions/runs/37231505962) again
passed both DMG jobs and the Apple Silicon CPU/Metal and Intel CPU source builds,
and all five [native CI jobs](https://github.com/aiolm/AioLM/actions/runs/37229307609)
passed.

A diagnostic build measured cold Metal initialization at 32-35 seconds on that
Intel device for each new executable path, with or without a precompiled Metal
library, and 0.2 seconds once cached; hosted Apple Silicon took about 20 seconds.
Because activation renames the staged runtime, the first probe after an install
is always cold, so macOS probes now allow 90 seconds.

## Intel Mac Metal is not supported

Upstream's x64 macOS release disables Metal, and AioLM cannot verify accuracy,
speed or memory on physical AMD or Intel Mac GPUs. Intel Macs therefore use the
CPU runtime:

- Intel Macs detect their GPUs from `system_profiler SPDisplaysDataType -json`
  (vendor, model, dedicated or shared memory) for the device profile, but Metal
  is never recommended there, including for a virtual Apple GPU. Native CI
  requires Metal to be recommended on Apple Silicon and unsupported on Intel.
- The catalog offers no Metal runtime for Intel Macs, and Metal PR source builds
  are refused before any source is downloaded.

During this audit an Intel Metal PR build did run on the hosted paravirtual GPU
([run 37271921406](https://github.com/aiolm/AioLM/actions/runs/37271921406)), and an
AioLM-built release bundle and publishing workflow were prototyped and then
removed unpublished. That virtual-device result is not evidence for physical
Intel Mac GPUs.

## Distribution and remaining device checks

macOS is distributed without Apple credentials:

- The bundle is ad-hoc signed (`signingIdentity: "-"`). The package check requires
  `codesign --verify --deep --strict` to pass and an ad-hoc, sealed signature on
  the app and both executables. This is not a Developer ID: Gatekeeper blocks the
  first launch of a browser-downloaded copy until the user chooses **Open Anyway**
  (see the [installation guide](../guides/install.md#macos)). Each build has a new
  code identity, so Keychain may ask for access again after an update.
- [`install.sh`](../../install.sh) resolves the release, verifies the DMG's SHA-256
  from GitHub's digest or `checksums.txt`, checks the bundle identity, version and
  signature, and installs into `/Applications` or `~/Applications`. The package
  check installs and replaces the built DMG through it and requires a checksum
  mismatch to install nothing.
- The [release workflow](../../.github/workflows/release.yml) builds, checks and
  publishes both DMGs and `install.sh` with the Windows/Linux assets when `main`
  carries a new version. No macOS release has been published yet.

[Run 37298629080](https://github.com/aiolm/AioLM/actions/runs/37298629080) at `e5fa2df`
passed both architectures: Tauri signed `aiolm-cli`, `aiolm` and the bundle with
identity `-`; the strict, sealed ad-hoc signature, LaunchServices launch and quit,
replacement and settings retention passed, and `install.sh` rejected a mismatched
checksum, then installed and replaced the app with settings kept.

A [Gatekeeper comparison](https://github.com/aiolm/AioLM/actions/runs/37315465231)
gave copies of the DMGs from before and after ad-hoc signing Safari's quarantine
attribute, installed them as a user would and opened them on hosted macOS 15:

- Apple Silicon before ad-hoc signing: "AioLM is damaged and can't be opened. You
  should move it to the Trash." `codesign`, `spctl` and `syspolicy_check` reported
  the incomplete signature. Intel builds had no signature at all and did not show it.
- After ad-hoc signing, both architectures: "AioLM Not Opened. Apple could not
  verify…" with **Done**, the unnotarized-app prompt that **Open Anyway** in System
  Settings resolves. `codesign --verify --deep --strict` passes; `syspolicy_check`
  reports only the missing notarization ticket and an internal XProtect check.

Clicking **Open Anyway**, macOS 13/14 Control-click **Open**, and a real browser
download on a physical Mac were not exercised.

Developer ID signing and notarization would remove the Gatekeeper step and keep
Keychain access stable across updates. They need a Developer ID Application
certificate and its password, the signing identity, and Apple notarization
credentials. Follow [Tauri's signing setup](https://v2.tauri.app/distribute/sign/macos/)
and use repository secrets; never put a certificate, private key or account
identifier into source or a package. Once configured, verify the actual app/DMG:

```sh
codesign --verify --deep --strict --verbose=2 AioLM.app
codesign --display --verbose=4 AioLM.app
xcrun stapler validate AioLM.app
xcrun stapler validate AioLM.dmg
spctl --assess --type execute --verbose=4 AioLM.app
```

Before ad-hoc signing, candidates failed `codesign --verify --strict` with
"code has no resources but signature indicates they must be present", because the
Apple Silicon executable carried only the linker's signature.

Remaining device acceptance includes the declared minimum OS, actual Finder
double-click and Dock icon/menu clicks, tray menu clicks, native file
selection/cancellation, clipboard and Hangul IME, Keychain allow/deny/cancel,
explicit MCP Yes/No, actual historical upgrades and physical Apple Silicon Metal
inference. Keep these separate from the automated results.

Known platform limits from code review, not device tests: the single-instance
plugin uses one socket in `/tmp`, so a second macOS user account starts its own
copy without that plugin's protection; LaunchServices still reuses a copy within
one account. As on Linux, nothing stops managed `llama-server` processes after
Force Quit or SIGKILL of AioLM. The standard quit request runs the normal cleanup.
