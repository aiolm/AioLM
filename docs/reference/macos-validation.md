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
  installed GUI launch, installed CLI smoke and settings retained after removal.
- Managed CPU runtime installation, a hash-pinned Qwen2.5-0.5B-Instruct Q4_K_M
  model, real streaming responses after the CLI exits, restart, continuing logs,
  stop and released ports. The package job selects the release CLI explicitly.
- Real Keychain create/read/update/delete, using a unique synthetic credential
  that the test removes.
- A real Cocoa MCP approval window: cancellation and deadline remove the window
  owned by that call. Tool descriptions are argv data, never executable script.

The [native CI](../../.github/workflows/ci.yml) additionally drives the real
WKWebView: clean onboarding, saved native settings, native frame, close-to-tray,
second-launch restore, normal close and preferences after relaunch. The optional
`macos-ui-smoke` Cargo feature registers WebDriver only on macOS with debug
assertions. Ordinary development and distribution builds do not enable it.
Synthetic screenshots are retained as test evidence, separate from packages.
Installer/UI scripts refuse to run outside disposable GitHub-hosted Macs.

macOS runtime probe commands have a 30-second budget; other platforms keep their
existing budget. Timeout diagnostics retain bounded initialization output.
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

Verify a quarantined browser download on a separate clean Mac account as well.
Remaining device acceptance includes the declared minimum OS, Finder/Dock
launch, menu interactions, native file selection/cancellation, clipboard and
Hangul IME, Keychain allow/deny/cancel, explicit MCP Yes/No, actual historical
upgrades and physical Apple Silicon Metal inference. Keep these
separate from the automated results.
