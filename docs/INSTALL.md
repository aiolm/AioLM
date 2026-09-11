# Install

> **Language:** [English](INSTALL.md) | [한국어](INSTALL.ko.md) | [日本語](INSTALL.ja.md) | [中文](INSTALL.zh.md)

## One-line install (Windows)

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/llama-board/llama-board/releases/latest/download/install.ps1 | iex"
```

Works from `cmd.exe`, Git Bash, or any shell that can start PowerShell:

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/llama-board/llama-board/releases/latest/download/install.ps1 | iex"
```

## Options

```powershell
$env:AIOLM_INSTALLER = "msi"   # default: nsis
$env:AIOLM_RELEASE = "v0.1.5"  # specific tag
$env:AIOLM_DRY_RUN = "1"       # verify only, don't install
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/llama-board/llama-board/releases/latest/download/install.ps1 | iex"
```

The one-line command downloads the `install.ps1` copy included in the selected release. Current source: <https://github.com/llama-board/llama-board/blob/main/install.ps1>

## Verify download

```powershell
$installer = Get-ChildItem -File "./AioLM_*_x64-setup.exe" | Select-Object -First 1
# For MSI, use "./AioLM_*_x64_en-US.msi" instead.
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# Compare with checksums.txt from the same release
(Get-AuthenticodeSignature -LiteralPath $installer.FullName).Status
# Expect Valid for signed releases; NotSigned means the asset is unsigned.
```

Release page: <https://github.com/llama-board/llama-board/releases/latest>

AioLM — All-In-One LM installs separately from llama-board. On first launch it copies the previous configuration, managed runtimes, CLI storage and WebView profile into the new `aiolm` / `com.aiolm.desktop` locations. Original data stays intact; existing AioLM data takes priority. Close the previous app before migration and retry if a profile is locked or disk space is insufficient. See [migration details](MIGRATION.md).

## Code signing policy

See [CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md). After SignPath Foundation onboarding, release installers are submitted from GitHub-hosted CI and require manual approval before Authenticode signing. An explicitly marked bootstrap release may be unsigned before onboarding; verify `checksums.txt` and the Authenticode status before installing.

## Uninstall

Open **Settings → Apps → Installed apps → AioLM → Uninstall**, or use **Control Panel → Programs and Features**. Removing the application does not automatically delete user-managed model, runtime, project, or chat data; remove those folders separately if desired.

## Linux / macOS (planned)

`curl | tar` distribution is planned. No OS signing required for tar path. See [README.md](../README.md#platform-support).

