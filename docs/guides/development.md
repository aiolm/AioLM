# Development

> **Language:** [English](development.md) | [한국어](development.ko.md) | [日本語](development.ja.md) | [中文](development.zh.md)

## Requirements

- Windows 10/11 x64
- Node `22.23.2` / npm `12.0.2` (`.node-version`, `package.json#engines`)
- Rust `1.98.0` + `rustfmt`/`clippy` (`rust-toolchain.toml`)
- Tauri v2 prerequisites
- `llama-server.exe` or managed runtime for smoke tests
- For PR builds: CMake + toolchain/SDK per backend (`cuda`→CUDA Toolkit, `vulkan`→Vulkan SDK, `rocm`→HIP SDK + `hipcc`)

Bump toolchain: `.node-version` + `package.json#engines` together; `rust-toolchain.toml` + `src-tauri/Cargo.toml#rust-version` + `.github/workflows/{ci,release}.yml` `toolchain:` together.

## Clone and run

```bash
git clone https://github.com/aiolm/AioLM.git aiolm
cd aiolm
npm install
npm run tauri -- dev
# Runtimes: %APPDATA%/aiolm/runtimes/{build}-{backend}/
```

## Validation

See [Source architecture](../reference/architecture.md) for folder ownership, dependency rules,
and test placement. Direct Node tests live in `tests/direct`; component and hook
tests live beside their source files.

```bash
npm test              # standalone contracts package + direct scripts + vitest coverage
npm run test:contracts # packed package in an isolated consumer
npm run typecheck
npm run build
npm run lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml

# Single Vitest file
npm run test:ui -- <path>

```

CI runs the full native checks on Windows and also runs `cargo check --locked
--manifest-path src-tauri/Cargo.toml --all-targets --all-features` on Ubuntu and
macOS. The additional jobs check compilation while support for those platforms
is developed; they do not validate native runtime installation or packaging.
For local compile checks on those hosts, install the corresponding
[Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) first.

Benchmark history, public contract and sharing-client development are described
in [Benchmark sharing](../reference/benchmark-sharing.md). Their normal tests use
synthetic temporary files and a loopback HTTP server; no website account or real
model is required. Keep browser persistence checks in a separate test database.
The workspace package builds automatically before development, type checking,
application builds and the main test command. After editing its source during a
running development session, run `npm run build:contracts` to update its exports.
See [Project boundaries](../reference/project-boundaries.md) for sharing the package
with a separate website repository in the planned GitHub organization.

### Real-model smoke (opt-in)

PowerShell:

```powershell
cd src-tauri
$env:AIOLM_SMOKE = "1"
$env:AIOLM_SMOKE_MODEL = "C:\path\to\model.gguf"
cargo test --test smoke -- --ignored --nocapture --test-threads=1
```

Bash / Git Bash:

```bash
cd src-tauri
AIOLM_SMOKE=1 AIOLM_SMOKE_MODEL='C:/path/to/model.gguf' cargo test --test smoke -- --ignored --nocapture --test-threads=1
```

`npm test` builds and tests the contracts package, then runs `test:run-direct-tests`,
`test:direct` and `test:coverage` (`vitest run --coverage`).

## Packaging

```bash
npm run package:tauri  # builds CLI first
# -> .codex-target/release/bundle/nsis/ , .../msi/
```

The installers ship `aiolm-cli.exe` as Tauri's auxiliary binary, installed next to
`aiolm.exe`, so `npm run build:cli` must run before packaging; `npm run package:tauri`
does that for you. Do not also list the CLI under `bundle.resources`: the same file
would be installed twice and the MSI build fails with WiX ICE30.

Packaging goes through `scripts/package-tauri.mjs` so that cargo runs with rustc
`--remap-path-prefix` flags for the build machine's home, Cargo, rustup and
workspace directories. Without them rustc bakes the builder's absolute paths into
every panic location in `aiolm.exe` and `aiolm-cli.exe`. The flags are computed at
run time from those directories and appended to any `RUSTFLAGS` already set, so no
machine-specific path is stored in the repository. Cargo's `trim-paths` profile
option would express the same thing, but it is still nightly-only and the pinned
1.98.0 toolchain rejects it. Running `npx tauri build` by hand skips the remapping.

The same script defines `NDEBUG` for the C sources that crates such as `lzma-sys`
compile through `cc`, because `--remap-path-prefix` cannot reach them: MSVC expands
`assert()` to `_wassert(..., __FILEW__, ...)`, so the xz sources otherwise embed the
builder's absolute path as a wide string. **Packaged builds therefore run the bundled
C libraries with their internal assertions compiled out**, which is the standard
release configuration for C code; `cargo test`, `cargo clippy` and every development
build keep theirs, because only the packaging scripts set the define. Existing
`CFLAGS` and `CXXFLAGS`, including target-specific variants such as
`CFLAGS_x86_64-pc-windows-msvc`, are appended to rather than replaced.

`AIOLM_BENCHMARK_API_URL` is read at native build time and selects the benchmark
sharing service for the packaged app. Leave it unset to package a build with
anonymous publishing disabled while review, export and queueing keep working.
Set it to a root HTTPS origin to enable publishing:

```powershell
$env:AIOLM_BENCHMARK_API_URL = "https://benchmarks.example.com"
npm run package:tauri
```

The Windows release workflow supplies it from the `AIOLM_BENCHMARK_API_URL`
repository variable. `cargo test` rejects a configured value that a release
build cannot use, so a typo fails verification instead of producing installers
with publishing silently disabled.
