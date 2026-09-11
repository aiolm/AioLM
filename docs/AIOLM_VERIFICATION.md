# AioLM 0.1.6 verification

Verified locally on Windows x64, 2026-09-10. This records the implemented redesign and migration, the checks actually executed, and the remaining installation checks. It is not a claim that every hardware/backend combination has been tested.

## Implementation

- All 15 views share the AioLM shell, semantic light/dark tokens, bundled Pretendard Variable, common controls and responsive layouts. The 224 px sidebar becomes a keyboard-accessible dialog below 960 px.
- Chat is the entry view. Visited views retain drafts and selections. Sidebar, header and panel shortcuts share `ViewId` navigation and the task-leave guard.
- Package, binary, installer and storage names use AioLM/aiolm. The application identifier is `com.aiolm.desktop`; the version remains 0.1.6. Existing environment inputs, runtime manifests and project exports remain readable.
- Native data is staged and copied before WebView creation. Browser migration completes before application stores initialize. Original roots remain intact; existing AioLM data takes priority. See [migration behavior](MIGRATION.md).
- Functional verification also fixed a previous-answer deletion during a normal follow-up chat, the Windows IPC CSP hostname, and duplicate CLI entries in generated installers. Stored conversations remain visible after server shutdown without a first-message empty state above them. Tauri's documented Windows IPC origin is `http://ipc.localhost` ([official CSP documentation](https://v2.tauri.app/security/csp/)).

## Automated checks

| Check | Result |
| --- | --- |
| Frontend Vitest with coverage | 33 files, 176 tests passed |
| Coverage thresholds | Passed; statements 54.71%, lines 59.10% |
| Direct Node assertion scripts | All 24 scripts and the runner self-test passed |
| TypeScript | Application and scripts projects passed |
| ESLint | Passed |
| Rust tests, all targets | 242 passed: 233 library, 8 CLI, 1 fake-server integration; 5 environment-dependent tests ignored |
| Rust formatting and Clippy | `cargo fmt --check` and `cargo clippy --all-targets --all-features -- -D warnings` passed |
| Frontend production build | Passed |
| CLI and desktop release builds | Passed |
| NSIS and MSI bundles | Built locally; unsigned |

The test suite covers chat streaming, attachments, cancellation, multi-turn history, model selection, session behavior, runtime actions and bundle integrity, tuning/defaults, profiles, projects, API adapters, gateways, MCP, preferences and data deletion. This is deterministic regression coverage, not a live integration test of every external service. The existing jsdom canvas warning is limited to its missing canvas implementation; rendered accessibility checks use a real browser.

Commands used were the repository's TypeScript, ESLint, Vitest/coverage, direct-test and Cargo entry points. Vite/Vitest used `--configLoader native`. The available Node runtime was 24.19.0, whereas the repository pins Node 22.23.2/npm 12.0.2; package engine declarations were retained. Because npm was unavailable locally, equivalent Node entry points ran directly, and packaging skipped its duplicate npm prebuild after the frontend build had passed.

## Rendered UI

The flow under test was: open Chat, navigate to every view, operate settings/tuning/chat controls, and verify the resulting state.

Browser plugin not available: Playwright used installed Microsoft Edge against `http://localhost:1420`, with explicit Tauri IPC fixtures. Actual desktop checks used the packaged release binary and its WebView2 connection.

| Check | Evidence/result |
| --- | --- |
| Page identity, nonblank view, loading completion | Passed for every view |
| Error overlay, React error boundary, browser errors | No remaining errors in the final 120-view matrix |
| Responsive geometry | All 15 views in light/dark at 360×520, 768×800, 1280×800 and 1920×1080; no detected content extending past the viewport |
| Keyboard interactions | Drawer open/Escape/focus return; select keyboard navigation and popup bounds; settings search and switches passed |
| Preference interactions | Theme, density and reduced motion updated the rendered application |
| State retention | Chat draft survived Projects → Chat; tuning edits reached the configuration save command |
| Multilingual accessibility | English, Japanese and Chinese, all 15 views at 360×520 in dark mode: 45 axe WCAG 2 A/AA runs without violations; Korean covered by the 120-view matrix |

Visual review caught and corrected tooltip/select placement, narrow API-code overflow, small-window discovery list height, dark-button hover contrast and keyboard access to scrollable empty lists. A missing CPU field in the temporary runtime fixture was fixed, and the matrix was rerun with console and React-boundary checks enabled.

Screenshots, interaction scripts and JSON results are kept outside the repository in the local Codex visualization workspace, under `2026/09/09/01a08724-50cb-73c3-b183-79554961062e`. Key evidence files are `qa-results.json`, `interaction-results.json`, `migration-results.json`, and the `native-test` / `real-model-final-test` directories. The matrix uses representative fixtures and does not prove every combination of populated records, open menus or error states.

## Loading stability and complete text

The follow-up removes visual truncation throughout the application. Long labels, model names, paths, conversation titles and select options wrap or remain fully readable in keyboard-accessible scroll regions. Conversation titles retain the complete first message. Native selectors were replaced by the shared select, preserving keyboard operation, disabled options and form values. Loading/action labels also omit trailing ellipsis punctuation.

Bundled fonts load before the workspace is exposed. Initial native reads and IndexedDB conversation hydration settle before an inert, dimensioned surface becomes interactive. Dependent reads get two paint boundaries to commit their results. Initial content cannot expose a child button before the containing surface is ready. A new page does not wait for an older page's pending reads. Subsequent refreshes retain the mounted views and their drafts.

The execution header, activity area, notification slots, conversation heading, composer status/attachments/metrics and tuning footer retain their dimensions. Button states reserve the complete labels in advance. Background errors and tasks open from the activity area without pushing the main content. Model rescans keep existing records visible, including on failure, and report loading/errors in the reserved notification region.

Layout tests use production Vite assets at `http://127.0.0.1:1422` in Microsoft Edge. Tauri read fixtures return after 700–1,700 ms in different orders and include long Korean/Latin model names and paths. A `PerformanceObserver` records `layout-shift` entries, alongside header/main/control rectangles, overflow, browser errors and visible text truncation checks. Screen-reader-only and explicitly hidden elements are excluded from the visible-text audit. CLS excludes recent direct user input; explicit navigation, scrolling, typing and window resizing are not treated as background loading regressions.

The final result files are `stability-results.json` (initial loading and delayed errors), `stability-focused-results.json` (32 final loading/error rechecks after the read-isolation and rescan fixes), `status-stability-results.json` (server transitions), `flow-stability-results.json` (real HTTP streaming and benchmark completion fixtures), and `model-refresh-results.json` (rescan success/failure). These measurements cover the listed scenarios, not every possible user dataset or external service response.

| Stability check | Result |
| --- | --- |
| 15 views × 2 themes × 4 viewport sizes | 120 cases, CLS 0; no overflow or visible ellipsis |
| Delayed background error | 8 cases, CLS 0 |
| Server start/stop while viewing all 15 pages | 60 cases at 360/1280 px, CLS 0 |
| Streamed response/completion and long conversation title | 360/1280 px, CLS 0 |
| Benchmark completion | 360/1280 px, CLS 0 |
| Model rescan success/failure, retaining existing rows | 4 cases at 360/1280 px, CLS 0 |
| New shared-select behavior | Full labels, keyboard selection, disabled options, form serialization and profile/session application passed |
| Loading-read isolation | Unit regression verifies that a pending read in an older page does not block a new page |

## Scrollbar alignment and available-width layouts

The next follow-up reserves a stable gutter on every page scroll surface and on the tuning editor's matching navigation/footer surfaces. Short windows give the tuning editor one outer scroll surface, without reserving the gutter twice. Settings constrain their inner content rather than moving the scroll surface into a centered narrow column. Theme-independent geometry tokens also fix light mode overriding the small-window padding; tuning shares the same padding token in both density modes.

Forms now choose columns from their available width. Named container queries govern list/detail layouts, the chat conversation list and nested tuning controls. This removes viewport breakpoints that squeezed a detail pane or stacked controls even when they fit. Model-directory actions stay grouped, session fields span the actual grid, and cards in scrolling flex pages retain their content height. Full text, disabled states, drafts and action handlers remain intact.

Browser plugin not available: Playwright used Microsoft Edge at `http://127.0.0.1:1424` with the existing explicit IPC fixtures. The target flow was page navigation → resize around breakpoints → add/remove vertical overflow → open disclosures and operate the chat list. Classic 16 px scrollbar styling was forced for gutter tests, including on hosts that normally use overlays.

| Follow-up check | Result |
| --- | --- |
| 15 views × 2 themes × 11 sizes | 330 cases passed: scrollbar appearance did not change content width; no page overflow, boundary or browser errors |
| Final theme/density cascade | 240 cases: all 15 views × 2 themes × 2 densities at 360×520, 600×800, 960×800 and 1280×800; common padding and stable content width passed |
| Complete control labels and disclosures | 200 cases across Korean/English/Japanese/Chinese and 5 widths; the detected narrow English/Japanese tuning labels were fixed and 8 targeted final rechecks passed |
| Chat list interaction | Responsive open/close and focus return passed in all four languages |
| Delayed initial reads and background error regression | 32 cases across all views at 360/1280 px; CLS 0 |
| Automated checks | 176 unit tests, all 24 direct scripts, both TypeScript configurations and ESLint passed |
| Production artifacts | Frontend, desktop, CLI, NSIS and MSI rebuilt |
| Latest native launch | Windows application control policy blocked the rebuilt executable; the latest native recheck could not run |

Evidence in the same external visualization workspace: `spacing-results.json`, `spacing-final-results.json`, `spacing-interactions.json`, `spacing-wrap-final.json`, `spacing-stability.json`, `spacing-tests.log`, and `spacing-after-*.png`. These are fixture-based browser measurements; the native launch limitation above is separate from their passing results. The Windows policy was not changed or bypassed.

The screenshot-specific clarification identified two remaining fixed track ratios: model/runtime context used 2:1 columns, and the chat path/status used 1:1 columns. Both now size from their text rather than a percentage. The short chat status retains its natural width, with state labels reserving only the space needed during an active conversation so completion does not move the path. The supplied Qwen3.8 path and `rocm · local_b10840_nop2p` both changed from two lines to one at 1280 px. Five viewport widths (360, 600, 900, 1280, 1920) passed the DOM assertion that text stays on one line whenever its combined intrinsic width fits; insufficient widths still wrap without truncation. Chat's 7 regression tests passed, and streaming/completion at 360/1280 px retained CLS 0. Evidence: `intrinsic-after.json`, `intrinsic-flow-results.json`, and `intrinsic-after-1280-{runtime,path}.png`. This final focused check used the same Edge/IPC fixture environment and does not replace the native launch limitation above.

## Migration checks

Native tests exercised first install without default writes, old-only data, existing destination priority, repeat launch, abandoned staging, invalid JSON/copy failure, simultaneous migration lock ownership and a locked Windows profile followed by retry. They assert original preservation, managed-path rewriting, external-path preservation and omission of live process state.

Ten browser unit cases cover prefix/path conversion, existing-data priority, malformed structured data, binary value preservation, quota failure and retry. Five real IndexedDB scenarios independently cover old-only data, coexistence, interrupted copy, quota failure and a fresh install. Blob and typed-array attachments were compared after copying.

An isolated actual Tauri first launch copied a closed legacy WebView profile and configuration. Korean conversation text, a document attachment, the dark preference and the external model path survived. A second launch retained the completed journal without repeating the import. Host application data was not used as a writable fixture. Disk-full behavior was injected as a quota failure; the host disk was not filled.

## Native and installer checks

The redesign baseline release passed server start, streamed response, abort, reload persistence and server stop against both the deterministic test server and the real local Qwen3.8-27B-Q4_K_M GGUF on CPU, using the existing `local_b10840_nop2p` runtime through PATH, a 2,048-token context and a separate port/data root. It returned `Hello!`; the previous response and subsequent cancelled prompt survived reload, without browser/CSP errors. After the loading/text follow-up, the rebuilt desktop application reopened this isolated profile and displayed its saved real-model conversation offline without browser errors. New streaming/layout checks used the HTTP fixture described above. The original model file and application settings were unchanged.

The earlier MSI administrative image was extracted successfully (exit 0) without registering a product installation on the host. Generated NSIS/MSI metadata uses AioLM and includes `aiolm.exe` and `aiolm-cli.exe` once each. The rebuilt local artifacts are:

- `.codex-target/release/bundle/nsis/AioLM_0.1.6_x64-setup.exe`
- `.codex-target/release/bundle/msi/AioLM_0.1.6_x64_en-US.msi`
- `.codex-target/release/aiolm-cli.exe`

Final SHA-256 checksums:

```text
7b5ff129287bc148066c641477f6c8279009da7e70f624eea7af8ddf36844d12  AioLM_0.1.6_x64-setup.exe
d2f04c76da97f36d02017c6b10024a0eb2cf70d880fedb0b2460e977f88778c8  AioLM_0.1.6_x64_en-US.msi
15fcb6f3fd73eef62dd8345613dd4a4eb2a85e0606387a7b4233c6fcb16a8d9f  aiolm-cli.exe
```

## Remaining acceptance checks

- Full NSIS/MSI installation, coexistence, uninstall and first-run migration in a clean Windows VM were not executed. Administrative extraction and running the release executable are narrower checks.
- Native file-picker interaction was not verified: Windows Computer Use application access approval timed out. File-selection handlers, attachment processing and storage have deterministic coverage, but this does not verify the OS dialog.
- Live runtime downloads/builds, GPU inference, DFlash, vision inference and every external MCP/gateway provider were not exercised. Environment-dependent Rust installation/model tests remain marked ignored rather than reported as passed.
- Very large real user WebView profiles and physical disk-full conditions were not tested end to end.
- SignPath service/repository renaming, signing and public release were outside this implementation. These local installers report `NotSigned`.

## Density and flexible layout follow-up (2026-09-10)

Read-only window inspection identified the running AioLM client as 2560×1600 physical pixels at 192 DPI, equivalent to a 1280×800 CSS viewport. Its process, window and user data were left running unchanged. This viewport was the primary comparison target.

Shared page padding is now 16 px (12 px in compact mode), and form/card gaps and row spacing are reduced. Intrinsic header columns, form columns with a 12 rem minimum and a bounded list column allow the detail editor to use available width. Text still wraps without ellipsis. The 224 px desktop navigation and stable scrollbar gutters remain.

Empty panel notice reservations are replaced by the existing bottom activity drawer. Only active-page notices enter the drawer; retry/dismiss actions and original handlers are preserved. The summary announces that attention is needed. Chat attachments appear in an anchored tray only while present or being read, and MCP tools and response metrics use disclosures. The tools disclosure includes a close button, and Escape closes an active disclosure and returns focus to its summary. API connection diagnostics and live model memory/slot values are also available in disclosures, so background changes do not move the page. Loaded API models fill their card's available space and scroll when needed.

The automatic conversation title is committed with the send action, before asynchronous preparation starts. This keeps the complete title without resizing the header when generation finishes. User-authored titles are preserved.

Measured with the same Korean IPC fixture at 1280×800:

| Region | Before | After |
| --- | ---: | ---: |
| App header height | 104 px | 72 px |
| One-line model/runtime box | 64 px | 36 px |
| Chat message area | 192 px | about 420 px |
| Conversation title button | 64 px | 28 px minimum, grows with text |
| Empty attachment reservation | 64 px | 0 px |
| Empty metrics reservation | 36 px | 0 px |
| Tuning footer | 96 px | 53 px |
| Projects outer scroll distance | 347 px | 135 px |
| Sessions outer scroll distance | 166 px | 50 px |
| Runtime outer scroll distance | 494 px | 270 px |
| Tuning content scroll distance | 577 px | 221 px |

The empty chat, MCP and gateway fixtures no longer need page scrolling. Longer forms and actual lists still scroll to expose their complete contents.

Validation for this follow-up:

- 34 test files / 179 unit tests passed, including active-page notice routing, retry/dismiss, and title assignment before delayed request preparation. The final shell/chat/notice recheck passed all 19 relevant tests.
- Both TypeScript configurations, ESLint, all 24 direct test scripts, the direct-runner self-test, and the frontend production build passed.
- The immutable production build passed 240 screen cases: 15 views × 2 themes × 2 densities × 4 sizes (360×520, 600×800, 960×800, 1280×800). No page overflow, missing panel, browser error, inconsistent padding or scrollbar-induced width change was detected.
- Slow initial reads and late errors passed 32 cases across all views at 360/1280 px, with CLS 0 and no ellipsis.
- Delayed attachment reading and MCP discovery passed 24 cases across all four languages at 360, 768 and 1280 px. Asynchronous completion preserved the message/input anchors and CLS 0. Attachment removal and MCP close/focus return were exercised.
- The affected sessions, benchmark and API server-state transitions passed the final 12 focused cases with CLS 0.
- The final production HTTP streaming/benchmark fixture passed all 4 completion cases at 360/1280 px with CLS 0.
- Desktop, CLI and both NSIS/MSI bundles were built at version 0.1.6. SHA-256 values above refer to these final artifacts.

Evidence in the external visualization workspace includes `density-before.json`, `density-after.json`, `density-after-*.png`, `density-chat-final.png`, `density-interactions.json`, `density-production-layout.json`, `density-production-flow.json`, `density-status-focused.json` and `spacing-stability.json`. The final 240-case run used the immutable build on port 1425, avoiding development hot-reload interference.

These are browser fixture checks. No new native installation or real-model execution was performed for the density changes; the earlier application-control and clean-VM acceptance limitations still apply. Backend and migration behavior were unchanged by this follow-up.
## Split GGUF recognition follow-up (2026-09-10)

The configured directory contains 45 GGUF files, including 33 shards of one Qwen3.8-Flash-Next model. The scanner previously exposed every shard as a separate model. Standard five-digit shard suffixes are now grouped by directory, base name and total; each group uses its first available file as its path, sums sizes, and reports missing parts. Complete groups launch via part 00001. Incomplete groups stay visible but cannot be selected or launched. Quantizations, separate directories and vision sidecars remain distinct. This yields 13 entries including four vision sidecars (nine in the default list).

Grouped deletion explicitly identifies the number of files. The existing IPC command accepts an optional file selection and validates every path, configured model and running session before deleting any member. Errors trigger a rescan. No actual user model files were modified or deleted during verification.

Validation: five model-panel tests, TypeScript, ESLint, Rust compilation, Clippy and frontend/NSIS/MSI builds passed. Four browser cases (light/dark at 360 and 1280 pixels) used the actual filesystem inventory as a fixture and verified grouping, filtering, first-part selection, deletion cancellation and no page overflow/errors. This fixture is not a native scanner execution. Added Rust grouping tests compiled, but Windows application control blocked execution of both the test binary (error 4551) and the rebuilt CLI. Native scanner execution and real-model loading therefore remain unverified for this follow-up.

The grouping convention and first-shard loading agree with the [llama.cpp model loader](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-model-loader.cpp). Evidence is in `model-files-original.json`, `model-shards-results.json` and `model-shards-*.png` in the external visualization workspace.

## A/I/O branding follow-up (2026-09-10)

The user-provided monogram was edited with the built-in image generation tool. Prompt direction: place the central I behind the A/O ring so both rounded ends are occluded; preserve the silhouette and cyan/blue/violet gradients. A second edit removed the backdrop and inner negative spaces to transparent alpha. Assets are `public/brand/aio-monogram.png` and `aio-monogram-preview.png`. The app mark, favicon and Tauri installation icons use this artwork.

Shared light/dark colors, primary buttons and selected navigation now match the monogram. Existing layout dimensions, text wrapping and scrollbar rules remain. The preloaded app image has explicit 36-by-36 dimensions to reserve its space before decoding.

Validation: 18 focused unit tests, TypeScript, targeted ESLint, frontend production build and NSIS/MSI builds passed. Browser fixtures passed 120 cases: 15 screens × two themes × four viewport sizes (360×520, 768×800, 1280×800, 1920×1080), checking navigation, content, page overflow, browser errors and desktop logo dimensions/loading. Light/dark screenshots were also inspected. These checks do not constitute a new asynchronous CLS measurement. Evidence is `aio-brand-results.json` and `aio-brand-*.png` in the external visualization workspace.

The SHA-256 values above refer to the rebuilt branding artifacts. At build completion, native execution had not been rechecked after the earlier Windows application-control block. The subsequent native run below supersedes that execution limitation. No certificate or signing was applied; the installers remain unsigned.

## Native release verification (2026-09-10, 21:15–21:28 KST)

The current `.codex-target/release/aiolm.exe` launched successfully twice, without changes to signing or Windows security policy. Its SHA-256 is `735f618922106cabc1b177d87f6a20f60f6d9d4251782b62e502b826d62b6771`. Verification used the actual Tauri window and Rust backend with the existing user profile, rather than a browser IPC fixture.

- The new icon and light/dark themes rendered in the native window. All 15 screens were opened and their initialized contents inspected. The theme was restored to its original System setting.
- The native scanner displayed nine models by default and grouped the 33-file Qwen3.8-Flash-Next model into one entry. No model files were changed.
- The selected `Qwen3.8-27B-Q4_K_M.gguf` loaded using the installed `local_b10840_nop2p-rocm` runtime. The server reached Ready and `/health` returned `{"status":"ok"}`.
- A new local verification conversation received `AIO_NATIVE_OK` from the real model. A second, longer response was stopped through the Generate Stop button; partial output and the cancellation notice were preserved.
- The Windows file picker selected a synthetic `aiolm-native-attachment.txt` document. Attachment reading completed, and the real model returned the document's token `AIO_FILE_OK`.
- The app's Stop button terminated the server process and removed the listener on port 8080. After normal app exit and relaunch, all six verification messages, the partial response and the document attachment were restored. The original conversation remained present.

The app remains open with the server stopped. One clearly named verification conversation was retained as evidence. The external visualization workspace contains `aio-native-verification.json`, `aio-native-relaunch.png` and the synthetic attachment.

This native smoke test does not cover clean-VM NSIS/MSI installation or migration, runtime installation/cancellation, every external provider, all model types, or measured native CLS across every viewport. Rust test binaries and the CLI were not rerun during this check. Those separate acceptance items remain subject to their earlier stated limits.

## Development icon refresh (2026-09-10, 23:35 KST)

The user's development session still ran `.codex-target/debug/aiolm.exe` from 16:31, before the icon assets changed at 21:05. Its sidebar displayed the updated Vite-served image, while the native title bar retained the earlier square A icon. The release executable had been rebuilt separately, so verifying it did not cover the development executable.

`src-tauri/build.rs` now declares `cargo:rerun-if-changed=icons`, ensuring Cargo rebuilds the embedded Windows resources when icon files change. The running Tauri development watcher rebuilt and restarted the debug executable at 23:35:12. Its actual native title-bar icon and sidebar logo both displayed the new A/I/O monogram. The build output confirms the new icon dependency; `cargo fmt --check` passed. The development session remains open with the server stopped.
