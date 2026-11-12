# Install

> **Language:** [English](install.md) | [한국어](install.ko.md) | [日本語](install.ja.md) | [中文](install.zh.md)

## Windows: download, verify, then install

Download the x64 setup EXE (or MSI) and `checksums.txt` from the same [release](https://github.com/aiolm/AioLM/releases/latest). Release installers are unsigned. Calculate the installer's SHA-256:

```powershell
$installer = Get-ChildItem -File "./AioLM_*_x64-setup.exe" | Select-Object -First 1
# For MSI, use "./AioLM_*_x64_en-US.msi" instead.
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
```

Compare the result with the matching entry in `checksums.txt`. Only after it matches, open the installer and follow its instructions. A matching checksum confirms file integrity, not the publisher's identity.

### Convenience one-line install

This alternative runs the downloaded script without first verifying the script itself:

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

AioLM — All-In-One LM installs separately from the previous application. On first launch it copies the previous configuration, managed runtimes, CLI storage and WebView profile into the new `aiolm` / `com.aiolm.desktop` locations. Original data stays intact; existing AioLM data takes priority. Close the previous app before migration and retry if a profile is locked or disk space is insufficient. See [migration details](../reference/migration.md).

AioLM keeps its data in `%USERPROFILE%\.aiolm`, or in the folder named by the `AIOLM_HOME` environment variable. Data from earlier AioLM releases is brought there at startup; managed runtimes are moved rather than copied. See [data folder](../reference/migration.md#data-folder).

## First-run setup

A fresh installation opens an English welcome screen before the workspace. Choose your language first, then preview a light, dark, or system theme and choose the folder for local models and new downloads. The default model folder is resolved for your user account at runtime. You can use an existing GGUF folder or download a model later.

Select **Start using AioLM** to save and open the workspace. Setup stays open if saving fails. Completed setup is retained across restarts and updates; existing configurations from earlier releases skip it. Language and theme remain editable in **Settings**, and the model folder in the model library.

## Update from the app

AioLM checks its public GitHub release metadata once each time the desktop app starts. A newer stable version appears in a dismissible notification; **View update** opens **Settings → General → Application updates**. You can also use **Check for updates** there at any time. A failed startup check does not interrupt normal use; settings shows the error and allows another check.

Choose **Download and install** and confirm to download the matching Windows x64 installer. AioLM verifies the SHA-256 digest published with that release, stops managed servers and tasks, opens the installer, and closes. Save active work first, follow the installer instructions, and reopen AioLM afterward. The download progress and verification status appear in settings. Installation is never started by the automatic check. If the download or verification fails, running sessions continue; if opening the installer fails after cleanup, the app stays open and servers can be started again.

The updater matches the running application's Windows uninstall registration to use the same NSIS or MSI installer type. The Linux/macOS implementation also recognizes a Debian package owned by `aio-lm`, or an app installed in `/Applications` or the user's `Applications` folder, and selects the matching DEB/DMG architecture when that asset is published. After verification it opens the system installation screen; complete installation there before reopening AioLM. For a DMG, replace the app in its existing installation folder. AppImage, source-built and other manual installations use **Open release page**. Update checks and downloads use the same public release source as `install.ps1`; no separate update server or signing secret is required. Checksum verification does not replace publisher code signing.

## Uninstall

Open **Settings → Apps → Installed apps → AioLM → Uninstall**, or use **Control Panel → Programs and Features**. Removing the application keeps your data unless you select **Delete the application data** in the NSIS uninstaller. That option removes the WebView profile and the data folder `%USERPROFILE%\.aiolm`, together with the `%APPDATA%\aiolm` and `%LOCALAPPDATA%\aiolm` folders earlier releases used, but keeps a `models` folder in them. It never removes a folder set with `AIOLM_HOME` or models stored elsewhere, and the MSI uninstaller removes no data; delete those folders separately if desired.

## Linux

Ubuntu 24.04 or newer, x86_64. DEB is recommended for desktop integration; AppImage is portable. Release packages are built for x86_64 only; ARM64 systems, including NVIDIA DGX, have no published package and have not been tested.

Download the DEB or AppImage and `checksums.txt` from the same [release](https://github.com/aiolm/AioLM/releases/latest). **Linux assets are included starting with v0.2.1.** To use a revision that is not in a release yet, [build from source](#build-from-source).

Compare the SHA-256 value with the corresponding entry in the downloaded checksum file. In the directory containing only the DEB version you want:

```bash
sha256sum ./AioLM_*_amd64.deb
sudo apt install ./AioLM_*_amd64.deb
```

Launch AioLM from the application menu. The DEB installs the launcher and icon. Remove it with `sudo apt remove aio-lm`; data in `~/.aiolm` (or `AIOLM_HOME`) remains.

The managed Linux llama.cpp CPU runtime requires GNU OpenMP (`libgomp.so.1`). The DEB installs `libgomp1` as a dependency.

For AppImage, put the file in a permanent folder, verify its checksum, then make it executable. Install `libgomp1` for the managed CPU runtime, `zenity` for MCP tool approval dialogs and, on Ubuntu 24.04+, `libfuse2t64` if FUSE 2 is missing. The DEB installs `zenity` as a dependency, but AppImage does not; if the approval dialog cannot open, the requested tool is not run and the call fails:

```bash
sudo apt install libgomp1 libfuse2t64 zenity
chmod +x ./AioLM_*.AppImage
./AioLM_*.AppImage
```

AppImage alone does not register a launcher. Download `register-linux-desktop.py` from the same release (for a source build, use [the helper from the same checkout](../../scripts/register-linux-desktop.py)); Python 3 is required. After verifying the helper against the release checksums, register the selected AppImage:

```bash
python3 register-linux-desktop.py --appimage ./AioLM_*.AppImage
```

This copies the icon and registers a launcher in your XDG user data directory; it does not move the AppImage. If you move or replace the file at a new path, run registration again. Before switching to DEB, remove this local registration with `python3 register-linux-desktop.py --remove`. The helper refuses to replace or remove desktop entries it does not own.

DEB updates open the verified installer in the system package interface for you to finish. Update AppImage from the release page and register its new path. GPU drivers and a compatible llama.cpp runtime are required for GPU acceleration.

Quit AioLM normally from its window or tray menu. A normal quit stops the model processes it started; a Force Quit or `kill -9` of AioLM does not, so stop any remaining `llama-server` processes yourself in that case.

## macOS

AioLM supports macOS Ventura 13.3 or later on Apple silicon and Intel Macs. Metal GPU acceleration is available on Apple silicon; Intel Macs use the CPU runtime, and Metal runtimes and Metal PR builds are not offered there. macOS packages are included starting with **v0.3.0**.

### Install the DMG manually

Download `AioLM_<version>_aarch64.dmg` (Apple silicon) or `AioLM_<version>_x64.dmg` (Intel), together with `checksums.txt` from the same [release](https://github.com/aiolm/AioLM/releases/latest). Calculate its SHA-256:

```bash
shasum -a 256 ./AioLM_*.dmg
```

Compare the result with the matching entry in `checksums.txt`. Only after it matches, open the DMG and drag AioLM to Applications. A checksum confirms integrity, not the publisher's identity.

The app is ad-hoc signed but not notarized, so macOS blocks the first launch of a browser-downloaded copy: open it once, then choose **System Settings → Privacy & Security → Open Anyway**. On macOS 13 and 14 you can instead Control-click the app and choose **Open**. This is needed once per installed copy.

### Convenience terminal install

This alternative runs the downloaded script without first verifying the script itself:

```bash
curl -fsSL https://github.com/aiolm/AioLM/releases/latest/download/install.sh | bash
```

The script downloads the DMG for your Mac, verifies its SHA-256 against the release (falling back to the release download links and `checksums.txt` when the GitHub API is rate limited), and copies `AioLM.app` into `/Applications`, or `~/Applications` when that folder is not writable. Quit AioLM first. `AIOLM_RELEASE=v0.3.0` selects a release, `AIOLM_DRY_RUN=1` stops after verification, and `AIOLM_APPLICATIONS_DIR` chooses another folder. Current source: <https://github.com/aiolm/AioLM/blob/main/install.sh>

AioLM keeps its data in `~/.aiolm`; replacing or removing the app keeps it. When the app is installed in `/Applications` or `~/Applications`, **Download and install** in settings downloads the DMG for your Mac; replace the app with the new copy. Because unsigned builds change their code identity, macOS may ask again for access to Keychain items such as benchmark sharing credentials after an update. To uninstall, quit AioLM and move `AioLM.app` to the Trash; delete `~/.aiolm` to remove your data.

### Commands started from Finder or the Dock

An app opened from Finder or the Dock does not read your shell startup files. AioLM adds the directories listed in `/etc/paths` and `/etc/paths.d` and Homebrew's `/opt/homebrew/bin` and `/opt/homebrew/sbin`, so MCP commands such as `npx` and build tools from the official installers or Homebrew are found. Commands that only your shell profile adds, for example through nvm, Volta, asdf or `~/.local/bin`, need an absolute path in AioLM; a script that starts with `#!/usr/bin/env node` also needs `node` in one of those directories. CMake for PR builds is found on that path or as `CMake.app` in `/Applications` or `~/Applications`.

As on Linux, a normal quit stops AioLM's model processes, but a Force Quit does not.

## Build from source

Building from source is optional. Use it for a revision that has no release yet, or to produce installers for your own machine. The resulting installers are unsigned, like release installers.

### Requirements

- Windows 10/11 x64, Linux x86_64 (Ubuntu 24.04 or newer) or macOS 13.3 or later (Apple silicon or Intel, with the Xcode command line tools)
- Node `22.23.2` and npm `12.0.2` (pinned in `.node-version` and `package.json`)
- Rust `1.98.0` (pinned in `rust-toolchain.toml`; `rustup` installs it automatically)
- The [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system
- Git

On Ubuntu, the Tauri prerequisites and the DEB/AppImage tools are below. They are needed only for building; running a built AppImage still needs the packages listed under [Linux](#linux).

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential pkg-config libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf desktop-file-utils
```

### Build installers

```bash
git clone https://github.com/aiolm/AioLM.git
cd AioLM
npm ci
npm run package:tauri
```

`npm run package:tauri` builds the interface, the desktop app and `aiolm-cli` together and creates the installers for the current operating system under `.codex-target/release/bundle/`: NSIS and MSI on Windows, DEB and AppImage on Linux, APP and DMG on macOS. The CLI is installed beside the app. Use this command rather than running `tauri build` directly: it also removes the build machine's directory paths from the compiled binaries.

Install the result as described for your platform above. A source build uses the same data folder as a release installation, `~/.aiolm` or `AIOLM_HOME`.

Builds publish shared benchmark results to the official AioLM website, `https://aiolm.vercel.app`. To build with publishing disabled, set `AIOLM_BENCHMARK_API_URL=off` before packaging; a root HTTPS origin selects another service, and an invalid value disables publishing. Local benchmark history and exports work either way. See [benchmark sharing](../reference/benchmark-sharing.md#publishing-service).

### Linux AppImage runtime

Linux packaging builds the AppImage runtime from pinned sources on first use and caches it under `.codex-target/appimage-runtime/`. This step needs an x86_64 host, network access, `/dev/fuse` and these tools:

```bash
sudo apt install bubblewrap git curl gnupg patch
```

The build runs inside an unprivileged bubblewrap namespace and uses no root access. Ubuntu 24.04 and newer restrict unprivileged user namespaces through AppArmor; packaging checks this first and stops with an explanation if `bwrap` is blocked. Allow `bwrap` with a scoped AppArmor profile instead of turning the restriction off for the whole system. If you already have a runtime binary that matches the pinned hash in `scripts/appimage-runtime/pins.conf`, set `LDAI_RUNTIME_FILE` to its path to use it instead of building one; any other file stops packaging.

To prepare the runtime before packaging, run `node scripts/package-tauri.mjs --prepare-runtime`; packaging verifies the cached copy again. Component sources and licenses are listed in [NOTICE](../../NOTICE).
