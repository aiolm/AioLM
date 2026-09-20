# 开发

> **语言:** [English](development.md) | [한국어](development.ko.md) | [日本語](development.ja.md) | [中文](development.zh.md)

## 要求

- Windows 10/11 x64
- Node `22.23.2` / npm `12.0.2`（`.node-version`、`package.json#engines`）
- Rust `1.98.0` + `rustfmt`/`clippy` (`rust-toolchain.toml`)
- Tauri v2 前置条件
- 用于冒烟测试的 `llama-server.exe` 或托管运行时
- PR 构建：按后端需要的 CMake + 工具链/SDK（`cuda`→CUDA Toolkit，`vulkan`→Vulkan SDK，`rocm`→HIP SDK + `hipcc`）

升级工具链时，请同时更新 `.node-version` 与 `package.json#engines`，以及 `rust-toolchain.toml`、`src-tauri/Cargo.toml#rust-version` 和 `.github/workflows/{ci,release}.yml` 中的 `toolchain:`。

## 克隆与运行

```bash
git clone https://github.com/aiolm/AioLM.git aiolm
cd aiolm
npm install
npm run tauri -- dev
# 运行时：%APPDATA%/aiolm/runtimes/{build}-{backend}/
```

## 验证

```bash
npm test              # 直接脚本 + Vitest 覆盖率
npm run typecheck
npm run build
npm run lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml

# 单个 Vitest 文件
npm run test:ui -- <path>
```

### 真实模型 smoke 测试（可选）

PowerShell：

```powershell
cd src-tauri
$env:AIOLM_SMOKE = "1"
$env:AIOLM_SMOKE_MODEL = "C:\path\to\model.gguf"
cargo test --test smoke -- --ignored --nocapture --test-threads=1
```

Bash / Git Bash：

```bash
cd src-tauri
AIOLM_SMOKE=1 AIOLM_SMOKE_MODEL='C:/path/to/model.gguf' cargo test --test smoke -- --ignored --nocapture --test-threads=1
```

`npm test` 会运行 `test:run-direct-tests` + `test:direct` + `test:coverage`（`vitest run --coverage`）。

## 打包

```bash
npm run package:tauri
# -> .codex-target/release/bundle/nsis/ , .../msi/
```

安装包会将 `aiolm-cli.exe` 作为 Tauri 辅助二进制文件安装在 `aiolm.exe` 旁边，因此打包前必须先运行
`npm run build:cli`；`npm run package:tauri` 已包含这一步。
请勿再将该 CLI 列入 `bundle.resources`：同一文件会被安装两次，导致 MSI 构建因 WiX ICE30 失败。

打包通过 `scripts/package-tauri.mjs` 进行，因此 cargo 会带着针对构建机器的主目录、
Cargo、rustup 与工作区目录的 rustc `--remap-path-prefix` 参数运行。没有这些参数时，
rustc 会把构建者的绝对路径写入 `aiolm.exe` 和 `aiolm-cli.exe` 的每一处 panic 位置。
参数在运行时根据这些目录计算，并追加在已设置的 `RUSTFLAGS` 之后，因此仓库中不会保存
任何与机器相关的路径。Cargo 的 `trim-paths` 配置项可以表达同样的语义，但它仍是
nightly 专用，固定的 1.98.0 工具链会拒绝。直接运行 `npx tauri build` 则不会应用这些
替换。

同一脚本还会为 `lzma-sys` 等 crate 通过 `cc` 编译的 C 源码定义 `NDEBUG`，因为
`--remap-path-prefix` 无法触及这些路径：MSVC 会把 `assert()` 展开为
`_wassert(..., __FILEW__, ...)`，否则 xz 源码会以宽字符串形式嵌入构建者的绝对路径。
**因此打包构建在运行时不启用所含 C 库的内部断言**，这是 C 代码的标准发布配置；该定义
只由打包脚本设置，所以 `cargo test`、`cargo clippy` 与所有开发构建仍保留断言。已有的
`CFLAGS` 与 `CXXFLAGS`，包括 `CFLAGS_x86_64-pc-windows-msvc` 这类按目标区分的变体，
都是追加而非替换。

`AIOLM_BENCHMARK_API_URL` 在原生构建时读取，决定打包应用使用的基准共享服务。
不设置时构建出的版本会禁用匿名发布，而审阅、导出与队列仍照常工作。要启用发布，
请指定根 HTTPS 源：

```powershell
$env:AIOLM_BENCHMARK_API_URL = "https://benchmarks.example.com"
npm run package:tauri
```

Windows 发布工作流从仓库变量 `AIOLM_BENCHMARK_API_URL` 读取该值。若配置了发布
构建无法使用的值，`cargo test` 会失败，从而避免产出发布功能被静默禁用的安装包。
