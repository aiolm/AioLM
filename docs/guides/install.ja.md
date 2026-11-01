# インストール

> **言語:** [English](install.md) | [한국어](install.ko.md) | [日本語](install.ja.md) | [中文](install.zh.md)

## ワンライナーインストール (Windows)

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

`cmd.exe`、Git Bash など PowerShell を起動できるすべてのシェルで同様です。

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

## オプション

```powershell
$env:AIOLM_INSTALLER = "msi"   # 既定: nsis
$env:AIOLM_RELEASE = "v0.1.5"  # 特定タグ
$env:AIOLM_DRY_RUN = "1"       # 検証のみ
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

ワンライナーは選択したリリースに含まれる `install.ps1` のコピーをダウンロードします。現在のソース: <https://github.com/aiolm/AioLM/blob/main/install.ps1>

## ダウンロード検証

リリースインストーラーは未署名です。同じリリースの `checksums.txt` と SHA-256 値を比較してください。チェックサムはファイルの破損や改変がないかを確認するだけで、公開者を保証するものではありません。

```powershell
$installer = Get-ChildItem -File "./AioLM_*_x64-setup.exe" | Select-Object -First 1
# MSI の場合は "./AioLM_*_x64_en-US.msi" を使用します。
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# 同じリリースの checksums.txt と比較
```

リリースページ: <https://github.com/aiolm/AioLM/releases/latest>

AioLM — All-In-One LMは旧アプリとは別にインストールされます。初回起動時に設定、管理ランタイム、CLIデータ、WebViewプロファイルを新しい `aiolm` / `com.aiolm.desktop` の場所へコピーします。元のデータは保持され、既存のAioLMデータが優先されます。移行前に旧アプリを終了してください。ロックや容量不足は解消後に再試行できます。[移行の詳細](../reference/migration.md)。

AioLMはデータを `%USERPROFILE%\.aiolm` に保存します。環境変数 `AIOLM_HOME` で別のフォルダーを指定することもできます。以前のAioLMのデータは起動時にこのフォルダーへ取り込まれ、管理ランタイムはコピーせずに移動されます。[データフォルダー](../reference/migration.md#data-folder)を参照してください。

## Linux

Ubuntu 24.04 以降、x86_64 が対象です。アプリメニューとアイコンの統合には DEB を推奨します。AppImage はポータブル形式です。ARM64 と NVIDIA DGX の環境はまだ確認されていません。

同じ[リリース](https://github.com/aiolm/AioLM/releases/latest)から DEB または AppImage と `checksums.txt` を取得してください。**v0.2.1 から Linux ファイルも配布します。** まだリリースされていない変更が必要な場合は[ソースからビルド](#ソースからビルド)してください。自分でビルドしたファイルは正式リリースではありません。

チェックサムファイルの該当項目と SHA-256 値を比較してください。インストールするバージョンの DEB だけを置いたフォルダーで実行します:

```bash
sha256sum ./AioLM_*_amd64.deb
sudo apt install ./AioLM_*_amd64.deb
```

インストール後、アプリメニューから AioLM を起動してください。DEB はランチャーとアイコンを登録します。`sudo apt remove aio-lm` で削除しても `~/.aiolm` または `AIOLM_HOME` のデータは残ります。

管理対象の Linux llama.cpp CPU ランタイムには GNU OpenMP（`libgomp.so.1`）が必要です。DEB は依存パッケージとして `libgomp1` をインストールします。

AppImage を常用するフォルダーに置き、チェックサムを確認してから実行権限を付けてください。管理対象 CPU ランタイム用に `libgomp1`、MCP ツールの承認ダイアログ用に `zenity`、Ubuntu 24.04 以降で FUSE 2 がない場合は `libfuse2t64` をインストールします。DEB は `zenity` も依存パッケージとしてインストールしますが、AppImage では別途インストールが必要です。承認ダイアログを表示できない場合、要求されたツールは実行されず呼び出しが失敗します:

```bash
sudo apt install libgomp1 libfuse2t64 zenity
chmod +x ./AioLM_*.AppImage
./AioLM_*.AppImage
```

AppImage の実行だけではアプリメニューに登録されません。同じリリースから `register-linux-desktop.py` を取得してください。自分でビルドした場合は同じソースの[ヘルパー](../../scripts/register-linux-desktop.py)を利用します。Python 3 が必要です。ヘルパーもリリースのチェックサムで検証してから登録します:

```bash
python3 register-linux-desktop.py --appimage ./AioLM_*.AppImage
```

アイコンとランチャーを XDG ユーザーデータフォルダーに登録します。AppImage 自体は移動しません。ファイルの場所を変更したら再登録してください。DEB に切り替える前に `python3 register-linux-desktop.py --remove` でローカル登録を削除してください。ヘルパーは自分が作成していないランチャー項目を置き換えたり削除したりしません。

DEB 更新は検証済みファイルをシステムのインストール画面で開き、ユーザーが完了します。AppImage はリリースページから更新し、新しいパスを登録してください。GPU アクセラレーションにはドライバーと互換性のある llama.cpp ランタイムが必要です。

AioLM はウィンドウまたはトレイメニューから通常どおり終了してください。通常の終了では AioLM が起動したモデルプロセスも停止しますが、強制終了や `kill -9` では停止しないため、その場合は残った `llama-server` プロセスを自分で終了してください。

## macOS

AioLM は Apple Silicon と Intel Mac の macOS Ventura 13.3 以降に対応します。Metal による GPU 高速化は Apple Silicon で利用でき、Intel Mac は CPU ランタイムを使用します。macOS パッケージは **v0.3.0** から含まれます。

### ターミナルからインストール

```bash
curl -fsSL https://github.com/aiolm/AioLM/releases/latest/download/install.sh | bash
```

スクリプトは Mac に合った DMG をダウンロードし、リリースの SHA-256 と照合してから（GitHub API の利用制限時はリリースのダウンロードリンクと `checksums.txt` を使用） `AioLM.app` を `/Applications`（書き込めない場合は `~/Applications`）にコピーします。実行前に AioLM を終了してください。`AIOLM_RELEASE=v0.3.0` でリリースを選び、`AIOLM_DRY_RUN=1` は検証のみ行い、`AIOLM_APPLICATIONS_DIR` でインストール先を変更できます。現在のソース: <https://github.com/aiolm/AioLM/blob/main/install.sh>

### DMG から手動でインストール

`AioLM_<バージョン>_aarch64.dmg`（Apple Silicon）または `AioLM_<バージョン>_x64.dmg`（Intel）をダウンロードし、`shasum -a 256` の値を同じリリースの `checksums.txt` と比較してから開き、AioLM を Applications にドラッグします。アプリはアドホック署名のみで公証されていないため、ブラウザーで取得したコピーは初回起動がブロックされます。一度開こうとした後、**システム設定 → プライバシーとセキュリティ → このまま開く**を選択してください。macOS 13・14 ではアプリを Control キーを押しながらクリックして**開く**を選ぶこともできます。インストールしたコピーごとに一度だけ必要です。

AioLM のデータは `~/.aiolm` に保存され、アプリを置き換えたり削除したりしても残ります。アプリが `/Applications` または `~/Applications` にある場合、設定の**ダウンロードしてインストール**が Mac に合った DMG を取得するので、新しいコピーでアプリを置き換えてください。未署名ビルドはコード識別子が変わるため、更新後にベンチマーク共有の認証情報など Keychain 項目へのアクセスを再度求められることがあります。アンインストールするには AioLM を終了して `AioLM.app` をゴミ箱に移動し、データも削除する場合は `~/.aiolm` を削除します。

Linux と同様に、通常の終了では AioLM のモデルプロセスも停止しますが、強制終了では停止しません。

## ソースからビルド

リリースファイルの代わりにインストーラーを自分で作成できます。自分でビルドしたインストーラーは正式リリースではなく、公証もされていません。

### 要件

- Windows 10/11 x64、Linux x86_64（Ubuntu 24.04 以降）または macOS 13.3 以降（Apple Silicon・Intel、Xcode コマンドラインツール）
- Node `22.23.2` と npm `12.0.2`（`.node-version`、`package.json#engines`）
- Rust `1.98.0`（`rust-toolchain.toml`。rustup が固定バージョンを自動的に使用します）
- OS ごとの [Tauri v2 の前提条件](https://v2.tauri.app/start/prerequisites/)

Debian/Ubuntu では、ネイティブビルドと AppImage ランタイムのビルドに必要なパッケージをインストールします。これらはビルド専用で、ビルドした AppImage を実行するには [Linux](#linux) に記載したパッケージも必要です:

```bash
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf desktop-file-utils bubblewrap git curl gnupg patch
```

Linux のパッケージングでは固定された AppImage ランタイムをソースからビルドするため、x86_64 ホスト、`/dev/fuse`、ネットワーク接続、そして非特権ユーザー名前空間を作成できる `bwrap` が必要です。Ubuntu 24.04 以降は AppArmor でこれを制限しているため、必要に応じて `bwrap` だけに適用される AppArmor プロファイルを許可してください。システム全体の保護は無効にしないでください。条件を満たしていない場合、パッケージングはビルド前に停止して対処方法を表示します。

### ビルド

```bash
git clone https://github.com/aiolm/AioLM.git aiolm
cd aiolm
npm ci
npm run package:tauri
```

インストーラーは `.codex-target/release/bundle/` 以下に作成されます（Windows は NSIS/MSI、Linux は DEB/AppImage、macOS は APP/DMG）。アプリと `aiolm-cli` が一緒に含まれます。`npm run package:tauri` はこのガイドで説明する統合パッケージングを行い、ビルドマシンのパスをバイナリから取り除きます。`tauri build` を直接実行せず、このコマンドを使ってください。

ベンチマーク共有サービスはビルド時の `AIOLM_BENCHMARK_API_URL` で変更できます。未設定または空の場合は公式 AioLM ウェブサイト `https://aiolm.vercel.app` に公開します。別のサービスはルートの HTTPS オリジンで指定し、`off`（大文字小文字を区別しません）を指定すると匿名公開を無効にしたビルドになります。その場合も共有サマリーとローカルの結果エクスポートは利用できます。

```powershell
$env:AIOLM_BENCHMARK_API_URL = "off"
npm run package:tauri
```
