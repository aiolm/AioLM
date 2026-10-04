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

リリースインストーラーは未署名です。同じリリースの `checksums.txt` と SHA-256 値を比較してください。

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

Ubuntu 24.04 以降、x86_64 が対象です。アプリメニューとアイコンの統合には DEB を推奨します。AppImage はポータブル形式です。ARM64 と NVIDIA DGX は今回の検証対象外です。

同じ[リリース](https://github.com/aiolm/AioLM/releases/latest)から DEB または AppImage と `checksums.txt` を取得してください。**v0.2.1 から Linux ファイルも配布します。** リリース前の検証ビルドが必要な場合は、GitHub にログインし、成功した [Validate desktop packages](https://github.com/aiolm/AioLM/actions/workflows/desktop-packages.yml) 実行の Artifacts から `desktop-packages-ubuntu-24.04` を取得できます。保存期限が切れている場合は[ソースビルド](development.md)を利用してください。検証ビルドは正式リリースとは異なります。

チェックサムファイルの該当項目と SHA-256 値を比較してください。インストールするバージョンの DEB だけを置いたフォルダーで実行します:

```bash
sha256sum ./AioLM_*_amd64.deb
sudo apt install ./AioLM_*_amd64.deb
```

インストール後、アプリメニューから AioLM を起動してください。DEB はランチャーとアイコンを登録します。`sudo apt remove aio-lm` で削除しても `~/.aiolm` または `AIOLM_HOME` のデータは残ります。

AppImage を常用するフォルダーに置き、チェックサムを確認してから実行権限を付けてください。Ubuntu 24.04 以降で FUSE 2 がない場合は `libfuse2t64` をインストールします:

```bash
sudo apt install libfuse2t64
chmod +x ./AioLM_*.AppImage
./AioLM_*.AppImage
```

AppImage の実行だけではアプリメニューに登録されません。同じリリースから `register-linux-desktop.py` を取得してください。検証ビルドでは[同じソースリビジョンのヘルパー](../../scripts/register-linux-desktop.py)を利用します。Python 3 が必要です。ヘルパーもリリースのチェックサムで検証してから登録します:

```bash
python3 register-linux-desktop.py --appimage ./AioLM_*.AppImage
```

アイコンとランチャーを XDG ユーザーデータフォルダーに登録します。AppImage 自体は移動しません。ファイルの場所を変更したら再登録してください。DEB に切り替える前に `python3 register-linux-desktop.py --remove` でローカル登録を削除してください。開発実行では `npm run tauri -- dev` がアイコンを自動登録します。[開発ガイド](development.md)を参照してください。

DEB 更新は検証済みファイルをシステムのインストール画面で開き、ユーザーが完了します。AppImage はリリースページから更新し、新しいパスを登録してください。GPU アクセラレーションにはドライバーと互換性のある llama.cpp ランタイムが必要です。

## macOS 検証ビルド

Apple Silicon・Intel 別の DMG は macOS Ventura 13.3 以降を対象とします。GitHub Actions の一時的な検証アーティファクトで提供し、v0.2.1 の公開リリースに macOS インストーラーは含まれません。アーキテクチャと SHA-256 を確認し、`AioLM.app` を Applications にコピーしてください。正式配布には Developer ID 署名、公証、残りの実機検証が必要です。取得方法と自動検証の範囲・制限は [macOS 検証](../reference/macos-validation.md)を参照してください。
