# インストール

> **言語:** [English](install.md) | [한국어](install.ko.md) | [日本語](install.ja.md) | [中文](install.zh.md)

## ワンライナーインストール (Windows)

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/AioLM/releases/latest/download/install.ps1 | iex"
```

`cmd.exe`、Git Bash など PowerShell を起動できるすべてのシェルで同様です。

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/AioLM/releases/latest/download/install.ps1 | iex"
```

## オプション

```powershell
$env:AIOLM_INSTALLER = "msi"   # 既定: nsis
$env:AIOLM_RELEASE = "v0.1.5"  # 特定タグ
$env:AIOLM_DRY_RUN = "1"       # 検証のみ
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/joowon-jang/AioLM/releases/latest/download/install.ps1 | iex"
```

ワンライナーは選択したリリースに含まれる `install.ps1` のコピーをダウンロードします。現在のソース: <https://github.com/joowon-jang/AioLM/blob/main/install.ps1>

## ダウンロード検証

リリースインストーラーは未署名です。同じリリースの `checksums.txt` と SHA-256 値を比較してください。

```powershell
$installer = Get-ChildItem -File "./AioLM_*_x64-setup.exe" | Select-Object -First 1
# MSI の場合は "./AioLM_*_x64_en-US.msi" を使用します。
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# 同じリリースの checksums.txt と比較
```

リリースページ: <https://github.com/joowon-jang/AioLM/releases/latest>

AioLM — All-In-One LMは旧アプリとは別にインストールされます。初回起動時に設定、管理ランタイム、CLIデータ、WebViewプロファイルを新しい `aiolm` / `com.aiolm.desktop` の場所へコピーします。元のデータは保持され、既存のAioLMデータが優先されます。移行前に旧アプリを終了してください。ロックや容量不足は解消後に再試行できます。[移行の詳細](../reference/migration.md)。

## Linux / macOS (予定)

`curl | tar` 配布を予定しています。tar パスは OS 署名不要です。詳しくは [overview.ja.md](overview.ja.md#プラットフォーム対応) を参照してください。
