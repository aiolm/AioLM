# Release verification and build performance

The desktop release builds Windows x64, Linux x86_64, macOS Apple Silicon and
macOS Intel in parallel. Publication still requires the existing
`release-publish` environment approval. Do not create the tag or a draft release
before the builds: an existing release intentionally prevents duplicate builds.

## One production compilation

`npm run package:tauri` prepares the pinned AppImage runtime on Linux, runs the
Tauri frontend hook once, and compiles both `aiolm` and `aiolm-cli` with the same
production context, features and path-remapping environment. Tauri builds all
enabled binaries; the default test fixture is disabled. A separate bundle command
then creates installers without another Cargo compilation. The script checks
both executable outputs and retains the embedded AppImage runtime checks.

`npm run build:cli` remains available for standalone development. It is not a
prerequisite for packaging. Do not add the CLI to `bundle.resources`: Tauri
includes it as an auxiliary binary, and duplicate MSI entries fail WiX ICE30.

Cargo dependency caches explicitly use the repository's `.codex-target` directory.
They are separated by OS, architecture, verification/package purpose, pinned
toolchain and build inputs. Only trusted main jobs save shared caches; PR jobs
can restore compatible main caches. Cargo still rebuilds changed source and
configuration. Cached AppImage runtimes must match the current source-input cache
key and the pinned binary hash; finished images are checked again.

## Tests run once per configuration

CI runs contracts, tooling, direct tests, lint, type checks and frontend builds
on Linux and Windows. The complete Vitest suite is split into two disjoint
shards per OS. Verified pure helpers use Node; UI and browser-dependent tests
keep jsdom. The model settings suite is split by behavior with the same test
cases and assertions. A fixture moved out of test files is explicitly excluded
from production coverage; existing coverage sources and thresholds are retained.

Each OS first collects a complete test plan tied to its checkout SHA and source
and configuration hashes. Shards must match that plan. OS-local merge jobs
independently collect the test inventory, reject missing/duplicate/failed reports,
verify the actual blob contents, and enforce the original whole-suite coverage
thresholds. Partial shards defer those thresholds; they never ignore test
failures. The stable `Frontend tests and build` check requires every OS, shard
and merge to succeed. Successful main runs retain measured file durations for
future balanced plans. Missing history changes scheduling only, never coverage.

Native CI retains clippy, all-feature and default-feature tests, real CLI/runtime
checks, OS credential checks and macOS window/lifecycle checks. Windows process
fixtures prepare repeated initial settings through the same validated config
save path, then read them back through the real CLI. Representative and long
command-line cases still exercise individual public config commands. All process
ownership, cancellation, resource cleanup and preservation assertions remain.

## Publication gates

Native CI and release packages run in parallel for the same main SHA. A release
waits for that existing CI run; it does not dispatch a duplicate run. The ready
job compares each platform's actual build-input fingerprint with its CI record,
including the benchmark API setting without logging its value. A repository
variable changed between jobs therefore cannot silently bypass verification.

Only after CI and all native installer checks pass does the ready job validate
the nine payload names, generate LF `checksums.txt`, and show the exact SHA,
checks and hashes in its approval summary. The publication job downloads those
ten staged files, rechecks CI after approval, and verifies the staged hashes.
It has publication permission but does not check out or execute repository
source. The protected environment's rules are unchanged.

After publication, a separate read-only job downloads the actual public assets
and performs [public release verification](release-verification.md). This
checks stable/latest metadata, exact tag SHA, ten assets, nine manifest hashes,
DEB metadata, pinned AppImage runtime and isolated CLI behavior. It does not
certify complete Linux acceptance, original v0.3.1-to-v0.3.2 update/UI behavior,
SmolVLM F09, or dedicated external-engine/device inference.

## Measuring and investigating failures

Changes to packaging tools and configuration automatically run the existing
four-platform desktop package validation on PRs, before a main release. Manual
package validation and rechecking retained installers remain available.

Cargo HTML timing reports and Windows process evidence are retained as workflow
artifacts. Process summaries separate setup, behavior and cleanup time. Executable
evidence retains byte counts and SHA-256 without allocating discarded Base64;
other raw-file preservation evidence remains unchanged.

Compare cold and warm cache runs, the slowest platform, and approval waiting
separately. File-duration history is optional and cannot authorize skipping a
test. Retry failed jobs after diagnosing their logs; successful platform outputs
do not need to be rebuilt when retrying one failed platform. Existing published
releases, tags and pinned validation materials are not replaced by these changes.
