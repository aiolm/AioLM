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
CPU and Metal on both architectures. The job primes only the
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
Hosted Intel runners also expose an Apple Paravirtual Metal device. AioLM still
lets an Intel Mac choose a Metal PR build, although its catalog and
recommendations treat Intel Metal as unsupported. At `9a9f458`,
[run 37231505962](https://github.com/aiolm/AioLM/actions/runs/37231505962) again
passed both DMG jobs and the Apple Silicon CPU/Metal and Intel CPU source builds,
and all five [native CI jobs](https://github.com/aiolm/AioLM/actions/runs/37229307609)
passed. Its Intel Metal build compiled and passed the staged preflight, but every
later probe, then limited to 30 seconds, timed out during Metal initialization.
A diagnostic build measured cold initialization at 32-35 seconds for each new
executable path, with or without a precompiled Metal library, and 0.2 seconds
once cached. After the probe budget became 90 seconds,
[run 37271921406](https://github.com/aiolm/AioLM/actions/runs/37271921406) at
`96e0f63` passed all six jobs. The Intel Metal source build listed `MTL0` in
34 seconds, passed GPU verification, offloaded 25/25 layers at start and restart,
answered over SSE and released its port; the
[native CI](https://github.com/aiolm/AioLM/actions/runs/37271928250) also passed.

## Intel Mac Metal runtime

Upstream x64 releases disable Metal, so AioLM provides that runtime itself:

- Intel Macs detect their GPUs from `system_profiler SPDisplaysDataType -json`
  (vendor, model, dedicated or shared memory) and recommend Metal for a detected
  GPU. Native CI requires this on the hosted Intel runner.
- The [Metal runtime workflow](../../.github/workflows/macos-metal-runtime.yml)
  builds the newest (or a requested) `bNNNN` tag from the official repository
  with AioLM's source builder on an Intel runner. A source archive has no Git
  history, so the release number and commit are pinned in llama.cpp's build
  information, and the build is refused unless the server reports them. A second
  runner installs the exported bundle and runs GPU verification, start/restart
  SSE inference with layer offloading and stop.
- Dispatched from `main` with `publish=true`, it publishes
  `aiolm-bNNNN-metal-macos-x64.zip` as the prerelease
  `runtime-bNNNN-metal-macos-x64` after the `pr-runtime-publish` approval.
  Pull requests that change the workflow only build and verify.
- The app's Metal catalog on Intel Macs installs the newest such release through
  the verified bundle path: GitHub's SHA-256 digest, file manifest, backend and
  build, staged preflight and activation. Until a release is published, the row
  explains that none exists and a PR can still be built for Metal from source.

[Run 37279602840](https://github.com/aiolm/AioLM/actions/runs/37279602840) built
`b11406` (`8216c84`). The installed bundle reported build 11406, commit
`8216c8462`, listed `MTL0`, offloaded 25/25 layers at start and restart, answered
over SSE and released its port. Its [native CI](https://github.com/aiolm/AioLM/actions/runs/37279602834)
detected the hosted Intel GPU and recommended Metal. No runtime release has been
published yet; that requires this branch on `main` and the approval. Physical
AMD and Intel GPUs remain unverified.

## Distribution and remaining device checks

These candidates have no Developer ID signing or notarization. Hosted copying
and launching do not prove downloaded-app Gatekeeper acceptance. Formal macOS
publication remains separate from the Windows/Linux release workflow.

The repository needs a Developer ID Application certificate and its password,
the signing identity, and Apple notarization credentials before that workflow can
be connected. Follow [Tauri's signing setup](https://v2.tauri.app/distribute/sign/macos/)
and use repository secrets; never put a certificate, private key or account
identifier into source or a package. Once configured, verify the actual app/DMG:

```sh
codesign --verify --deep --strict --verbose=2 AioLM.app
codesign --display --verbose=4 AioLM.app
xcrun stapler validate AioLM.app
xcrun stapler validate AioLM.dmg
spctl --assess --type execute --verbose=4 AioLM.app
```

Unsigned candidates currently fail `codesign --verify --strict` with
"code has no resources but signature indicates they must be present": the
Apple Silicon executable carries only the linker's ad-hoc signature. LaunchServices
still opens them locally; Developer ID signing must produce a sealed bundle.

Verify a quarantined browser download on a separate clean Mac account as well.
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
