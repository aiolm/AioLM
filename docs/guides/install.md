# Install

> **Language:** [English](install.md) | [한국어](install.ko.md) | [日本語](install.ja.md) | [中文](install.zh.md)

## One-line install (Windows)

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

Works from `cmd.exe`, Git Bash, or any shell that can start PowerShell:

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

## Options

```powershell
$env:AIOLM_INSTALLER = "msi"   # default: nsis
$env:AIOLM_RELEASE = "v0.1.5"  # specific tag
$env:AIOLM_DRY_RUN = "1"       # verify only, don't install
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

The one-line command downloads the `install.ps1` copy included in the selected release. Current source: <https://github.com/aiolm/AioLM/blob/main/install.ps1>

## Verify download

Release installers are unsigned. Compare the SHA-256 value with `checksums.txt` from the same release.

```powershell
$installer = Get-ChildItem -File "./AioLM_*_x64-setup.exe" | Select-Object -First 1
# For MSI, use "./AioLM_*_x64_en-US.msi" instead.
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# Compare with checksums.txt from the same release
```

Release page: <https://github.com/aiolm/AioLM/releases/latest>

AioLM — All-In-One LM installs separately from the previous application. On first launch it copies the previous configuration, managed runtimes, CLI storage and WebView profile into the new `aiolm` / `com.aiolm.desktop` locations. Original data stays intact; existing AioLM data takes priority. Close the previous app before migration and retry if a profile is locked or disk space is insufficient. See [migration details](../reference/migration.md).

AioLM keeps its data in `%USERPROFILE%\.aiolm`, or in the folder named by the `AIOLM_HOME` environment variable. Data from earlier AioLM releases is brought there at startup; managed runtimes are moved rather than copied. See [data folder](../reference/migration.md#data-folder).

## First-run setup

A fresh installation opens an English welcome screen before the workspace. Choose your language first, then preview a light, dark, or system theme and choose the folder for local models and new downloads. The default model folder is resolved for your user account at runtime. You can use an existing GGUF folder or download a model later.

Select **Start using AioLM** to save and open the workspace. Setup stays open if saving fails. Completed setup is retained across restarts and updates; existing configurations from earlier releases skip it. Language and theme remain editable in **Settings**, and the model folder in the model library.

## Update from the app

AioLM checks its public GitHub release metadata once each time the desktop app starts. A newer stable version appears in a dismissible notification; **View update** opens **Settings → General → Application updates**. You can also use **Check for updates** there at any time. A failed startup check does not interrupt normal use; settings shows the error and allows another check.

Choose **Download and install** and confirm to download the matching Windows x64 installer. AioLM verifies the SHA-256 digest published with that release, stops managed servers and tasks, opens the installer, and closes. Save active work first, follow the installer instructions, and reopen AioLM afterward. The download progress and verification status appear in settings. Installation is never started by the automatic check. If the download or verification fails, running sessions continue; if opening the installer fails after cleanup, the app stays open and servers can be started again.

The updater matches the running application's Windows uninstall registration to use the same NSIS or MSI installer type. The Linux/macOS implementation also recognizes a Debian package owned by `aio-lm`, or an app installed in `/Applications` or the user's `Applications` folder, and selects the matching DEB/DMG architecture when that asset is published. After verification it opens the system installation screen; complete installation there before reopening AioLM. For a DMG, replace the app in its existing installation folder. AppImage, development and other manual installations use **Open release page**. Update checks and downloads use the same public release source as `install.ps1`; no separate update server or signing secret is required. Checksum verification does not replace publisher code signing.

## Uninstall

Open **Settings → Apps → Installed apps → AioLM → Uninstall**, or use **Control Panel → Programs and Features**. Removing the application keeps your data unless you select **Delete the application data** in the NSIS uninstaller. That option removes the WebView profile and the data folder `%USERPROFILE%\.aiolm`, together with the `%APPDATA%\aiolm` and `%LOCALAPPDATA%\aiolm` folders earlier releases used, but keeps a `models` folder in them. It never removes a folder set with `AIOLM_HOME` or models stored elsewhere, and the MSI uninstaller removes no data; delete those folders separately if desired.

## Linux

Ubuntu 24.04 or newer, x86_64. DEB is recommended for desktop integration; AppImage is portable. ARM64 and NVIDIA DGX systems are not covered by this validation.

Download the DEB or AppImage and `checksums.txt` from the same [release](https://github.com/aiolm/AioLM/releases/latest). **Linux assets are included starting with v0.2.1.** For pre-release validation builds, sign in to GitHub, open a successful [Validate desktop packages](https://github.com/aiolm/AioLM/actions/workflows/desktop-packages.yml) run, and download `desktop-packages-ubuntu-24.04` from Artifacts. Artifacts expire; if unavailable, use the [source build instructions](development.md). Validation builds are not published releases.

Compare the SHA-256 value with the corresponding entry in the downloaded checksum file. In the directory containing only the DEB version you want:

```bash
sha256sum ./AioLM_*_amd64.deb
sudo apt install ./AioLM_*_amd64.deb
```

Launch AioLM from the application menu. The DEB installs the launcher and icon. Remove it with `sudo apt remove aio-lm`; data in `~/.aiolm` (or `AIOLM_HOME`) remains.

For AppImage, put the file in a permanent folder, verify its checksum, then make it executable. On Ubuntu 24.04+, install `libfuse2t64` if FUSE 2 is missing:

```bash
sudo apt install libfuse2t64
chmod +x ./AioLM_*.AppImage
./AioLM_*.AppImage
```

AppImage alone does not register a launcher. Download `register-linux-desktop.py` from the same release (for validation builds, use [the helper from the matching source revision](../../scripts/register-linux-desktop.py)); Python 3 is required. After verifying the helper against the release checksums, register the selected AppImage:

```bash
python3 register-linux-desktop.py --appimage ./AioLM_*.AppImage
```

This copies the icon and registers a launcher in your XDG user data directory; it does not move the AppImage. If you move or replace the file at a new path, run registration again. Before switching to DEB, remove this local registration with `python3 register-linux-desktop.py --remove`. A development checkout registers its icon automatically with `npm run tauri -- dev`; see [development](development.md).

DEB updates open the verified installer in the system package interface for you to finish. Update AppImage from the release page and register its new path. GPU drivers and a compatible llama.cpp runtime are required for GPU acceleration.

## macOS

AioLM supports macOS Ventura 13.3 or later on Apple silicon and Intel Macs. Metal GPU acceleration is available on Apple silicon; Intel Macs use the CPU runtime. macOS packages are published from the first release that includes them; v0.2.1 has none. Until then, validation DMGs are available as GitHub Actions artifacts; see [macOS validation](../reference/macos-validation.md).

### Install from the terminal

```bash
curl -fsSL https://github.com/aiolm/AioLM/releases/latest/download/install.sh | bash
```

The script downloads the DMG for your Mac, verifies its SHA-256 against the release, and copies `AioLM.app` into `/Applications`, or `~/Applications` when that folder is not writable. Quit AioLM first. `AIOLM_RELEASE=v0.3.0` selects a release, `AIOLM_DRY_RUN=1` stops after verification, and `AIOLM_APPLICATIONS_DIR` chooses another folder. Current source: <https://github.com/aiolm/AioLM/blob/main/install.sh>

### Install the DMG manually

Download `AioLM_<version>_aarch64.dmg` (Apple silicon) or `AioLM_<version>_x64.dmg` (Intel), compare `shasum -a 256` with `checksums.txt` from the same release, open it and drag AioLM to Applications. The app is ad-hoc signed but not notarized, so macOS blocks the first launch of a browser-downloaded copy: open it once, then choose **System Settings → Privacy & Security → Open Anyway**. On macOS 13 and 14 you can instead Control-click the app and choose **Open**. This is needed once per installed copy.

AioLM keeps its data in `~/.aiolm`; replacing or removing the app keeps it. When the app is installed in `/Applications` or `~/Applications`, **Download and install** in settings downloads the DMG for your Mac; replace the app with the new copy. Because unsigned builds change their code identity, macOS may ask again for access to Keychain items such as benchmark sharing credentials after an update. To uninstall, quit AioLM and move `AioLM.app` to the Trash; delete `~/.aiolm` to remove your data.
