# 開発

> **言語:** [English](development.md) | [한국어](development.ko.md) | [日本語](development.ja.md) | [中文](development.zh.md)

## 要件

- Windows 10/11 x64、Linux x86_64（Ubuntu 24.04 以降）または macOS 13.3 以降（Apple Silicon・Intel、Xcode コマンドラインツール）
- Node `22.23.2` / npm `12.0.2`（`.node-version`, `package.json#engines`）
- Rust `1.98.0` + `rustfmt`/`clippy` (`rust-toolchain.toml`)
- Tauri v2 前提
- スモークテスト用 `llama-server.exe` または管理ランタイム
- PR ビルド: バックエンドごとの CMake + ツールチェーン/SDK（`cuda`→CUDA Toolkit、`vulkan`→Vulkan SDK、`rocm`→HIP SDK + `hipcc`）

ツールチェーンを更新するときは、`.node-version` と `package.json#engines`、`rust-toolchain.toml`、`src-tauri/Cargo.toml#rust-version`、`.github/workflows/{ci,release}.yml` の `toolchain:` を一緒に更新してください。

## クローンと実行

```bash
git clone https://github.com/aiolm/AioLM.git aiolm
cd aiolm
npm install
npm run tauri -- dev
# ランタイム: ~/.aiolm/runtimes/{build}-{backend}/
```

## 検証

```bash
npm test              # 直接スクリプト + Vitest カバレッジ
npm run typecheck
npm run build
npm run lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml

# 単一の Vitest ファイル
npm run test:ui -- <path>
```

### 実モデル smoke テスト（任意）

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

`npm test` は `test:run-direct-tests` + `test:direct` + `test:coverage`（`vitest run --coverage`）を実行します。

## パッケージング

```bash
npm run package:tauri
# -> .codex-target/release/bundle/nsis/ , .../msi/
```

インストーラーは `aiolm-cli.exe` を Tauri の補助バイナリとして `aiolm.exe` の隣に配置するため、
パッケージング前に `npm run build:cli` が実行されている必要があります。`npm run package:tauri` はこれを含みます。
CLI を `bundle.resources` にも登録すると同じファイルが二重に配置され、MSI ビルドが WiX ICE30 で失敗します。

パッケージングは `scripts/package-tauri.mjs` を経由するため、cargo はビルドマシンの
ホーム、Cargo、rustup、ワークスペースの各ディレクトリに対する rustc
`--remap-path-prefix` フラグ付きで実行されます。これがないと rustc は `aiolm.exe` と
`aiolm-cli.exe` のすべてのパニック位置にビルドした人の絶対パスを埋め込みます。
フラグは実行時にそれらのディレクトリから計算し、すでに設定されている `RUSTFLAGS` の
後ろに追加するため、マシン固有のパスはリポジトリに残りません。Cargo の `trim-paths`
プロファイルオプションでも同じことを表現できますが、まだナイトリー専用で、固定した
1.98.0 ツールチェーンは受け付けません。`npx tauri build` を直接実行するとこの置換は
行われません。

同じスクリプトは、`lzma-sys` のようなクレートが `cc` でコンパイルする C ソースに
`NDEBUG` を定義します。`--remap-path-prefix` はそこに届かないためです。MSVC は
`assert()` を `_wassert(..., __FILEW__, ...)` に展開するので、そのままでは xz の
ソースがビルドした人の絶対パスをワイド文字列として埋め込みます。**したがって
パッケージ版のビルドは、同梱した C ライブラリの内部アサーションを無効にした状態で
動作します。** これは C コードの標準的なリリース構成であり、この定義はパッケージング
スクリプトだけが設定するため、`cargo test`、`cargo clippy` と開発ビルドはアサーション
を保持します。既存の `CFLAGS` と `CXXFLAGS` は、`CFLAGS_x86_64-pc-windows-msvc` の
ようなターゲット別の変種も含めて、置き換えずに追記します。

`AIOLM_BENCHMARK_API_URL` はネイティブビルド時に読み取られ、ビルドしたアプリの
ベンチマーク共有サービスを上書きします。未設定または空なら公式 AioLM ウェブサイト
`https://aiolm.vercel.app` に公開します。別のサービスを使うにはルートの HTTPS
オリジンを指定し、匿名公開を無効にしたビルドを作るには `off`（大文字小文字は
区別しません）を指定します。その場合も共有サマリーとローカルの結果エクスポートは
そのまま使えます。

```powershell
$env:AIOLM_BENCHMARK_API_URL = "https://benchmarks.example.com"
npm run package:tauri
```

Windows リリースワークフローはこの値をリポジトリ変数 `AIOLM_BENCHMARK_API_URL`
から取得し、変数が空なら公式ウェブサイトを使うインストーラーを作ります。パス付きの
URL やプレーン HTTP など、リリースビルドで使えないそれ以外の値は `cargo test` が
拒否するため、入力ミスは公開が無効のまま気付かれないインストーラーではなく検証の
失敗として現れます。不正な値が公式ウェブサイトに置き換えられることはありません。
