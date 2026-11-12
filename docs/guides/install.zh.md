# 安装

> **语言:** [English](install.md) | [한국어](install.ko.md) | [日本語](install.ja.md) | [中文](install.zh.md)

## Windows：先下载并验证，再安装

从同一个[发布版本](https://github.com/aiolm/AioLM/releases/latest)下载 x64 安装 EXE（或 MSI）及 `checksums.txt`。发布的安装程序未签名。计算安装程序的 SHA-256：

```powershell
$installer = Get-ChildItem -File "./AioLM_*_x64-setup.exe" | Select-Object -First 1
# 对 MSI 使用 "./AioLM_*_x64_en-US.msi"。
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
```

将结果与 `checksums.txt` 中的对应条目比较。只有匹配后，才打开安装程序并按提示安装。校验和匹配只能确认文件完整性，不能证明发布者身份。

### 便捷的单行安装

此替代方式会直接执行下载的脚本，不会先验证脚本本身：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

在 `cmd.exe`、Git Bash 或任何可启动 PowerShell 的终端中均可使用。

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

## 选项

```powershell
$env:AIOLM_INSTALLER = "msi"   # 默认: nsis
$env:AIOLM_RELEASE = "v0.1.5"  # 指定标签
$env:AIOLM_DRY_RUN = "1"       # 仅验证
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

单行命令会下载所选发布版本中包含的 `install.ps1` 副本。当前源码: <https://github.com/aiolm/AioLM/blob/main/install.ps1>

AioLM — All-In-One LM与旧应用独立安装。首次启动会将原有设置、托管运行时、CLI数据和WebView配置复制到新的 `aiolm` / `com.aiolm.desktop` 目录。原始数据保留，已有AioLM数据优先。迁移前请关闭旧应用；解除锁定或释放磁盘空间后可重试。[迁移详情](../reference/migration.md)。

AioLM将数据保存在 `%USERPROFILE%\.aiolm`，也可以通过环境变量 `AIOLM_HOME` 指定其他文件夹。早期AioLM版本的数据会在启动时导入该文件夹，托管运行时会被移动而非复制。参见[数据文件夹](../reference/migration.md#data-folder)。

## Linux

适用于 Ubuntu 24.04 或更新版本、x86_64。推荐使用 DEB 集成应用菜单和图标；AppImage 为便携格式。ARM64 和 NVIDIA DGX 环境尚未经过确认。

从同一个[发布版本](https://github.com/aiolm/AioLM/releases/latest)下载 DEB 或 AppImage 及 `checksums.txt`。**从 v0.2.1 开始也提供 Linux 文件。** 如需尚未发布的更改，请[从源码构建](#从源码构建)。自行构建的文件不是正式发布版本。

将 SHA-256 值与校验和文件中的对应项进行比较。在仅包含所需版本 DEB 的文件夹内执行:

```bash
sha256sum ./AioLM_*_amd64.deb
sudo apt install ./AioLM_*_amd64.deb
```

安装后从应用菜单启动 AioLM。DEB 会注册启动项和图标。使用 `sudo apt remove aio-lm` 卸载后，`~/.aiolm` 或 `AIOLM_HOME` 中的数据会保留。

托管的 Linux llama.cpp CPU 运行时需要 GNU OpenMP（`libgomp.so.1`）。DEB 会将 `libgomp1` 作为依赖项安装。

将 AppImage 放在长期保留的文件夹，验证校验和后赋予执行权限。请为托管 CPU 运行时安装 `libgomp1`，为 MCP 工具审批对话框安装 `zenity`；Ubuntu 24.04 或更新版本若缺少 FUSE 2，还需安装 `libfuse2t64`。DEB 会将 `zenity` 作为依赖项安装，AppImage 则需要单独安装；无法显示审批对话框时，所请求的工具不会运行，调用会失败:

```bash
sudo apt install libgomp1 libfuse2t64 zenity
chmod +x ./AioLM_*.AppImage
./AioLM_*.AppImage
```

仅运行 AppImage 不会注册应用菜单。请下载同一发布中的 `register-linux-desktop.py`；自行构建时使用同一源码中的[辅助脚本](../../scripts/register-linux-desktop.py)，需要 Python 3。使用发布校验和验证辅助脚本后注册所选 AppImage:

```bash
python3 register-linux-desktop.py --appimage ./AioLM_*.AppImage
```

该操作将图标和启动项注册到 XDG 用户数据目录，不会移动 AppImage。更改文件路径后请重新注册。切换到 DEB 前，使用 `python3 register-linux-desktop.py --remove` 删除本地注册。辅助脚本不会替换或删除并非由它创建的启动项。

DEB 更新会在系统安装界面打开已验证文件，由用户完成安装。AppImage 通过发布页面更新并重新注册新路径。GPU 加速需要相应驱动和兼容的 llama.cpp 运行时。

请从窗口或托盘菜单正常退出 AioLM。正常退出会停止 AioLM 启动的模型进程；强制退出或 `kill -9` 则不会，此时请自行结束残留的 `llama-server` 进程。

## macOS

AioLM 支持 Apple Silicon 和 Intel Mac 上的 macOS Ventura 13.3 及以上版本。Apple Silicon 可使用 Metal GPU 加速，Intel Mac 使用 CPU 运行时。macOS 安装包从 **v0.3.0** 开始提供。

### 手动安装 DMG

从同一个[发布版本](https://github.com/aiolm/AioLM/releases/latest)下载 `AioLM_<版本>_aarch64.dmg`（Apple Silicon）或 `AioLM_<版本>_x64.dmg`（Intel），以及 `checksums.txt`。计算 SHA-256：

```bash
shasum -a 256 ./AioLM_*.dmg
```

将结果与 `checksums.txt` 中的对应条目比较。只有匹配后，才打开 DMG 并将 AioLM 拖到“应用程序”。校验和只确认完整性，不能证明发布者身份。

应用仅有临时（ad-hoc）签名且未经公证，因此通过浏览器下载的副本首次启动会被阻止：先尝试打开一次，然后选择**系统设置 → 隐私与安全性 → 仍要打开**。在 macOS 13 和 14 上也可以按住 Control 点按应用并选择**打开**。每个安装的副本只需操作一次。

### 便捷的终端安装

此替代方式会直接执行下载的脚本，不会先验证脚本本身：

```bash
curl -fsSL https://github.com/aiolm/AioLM/releases/latest/download/install.sh | bash
```

脚本会下载适合当前 Mac 的 DMG，与发布中的 SHA-256 核对后（GitHub API 受限时改用发布下载链接和 `checksums.txt`），将 `AioLM.app` 复制到 `/Applications`（不可写时为 `~/Applications`）。运行前请先退出 AioLM。`AIOLM_RELEASE=v0.3.0` 可选择版本，`AIOLM_DRY_RUN=1` 仅执行校验，`AIOLM_APPLICATIONS_DIR` 可指定安装目录。当前源码：<https://github.com/aiolm/AioLM/blob/main/install.sh>

AioLM 的数据保存在 `~/.aiolm`，替换或删除应用都会保留。应用安装在 `/Applications` 或 `~/Applications` 时，设置中的**下载并安装**会获取适合当前 Mac 的 DMG，请用新副本替换应用。由于未签名构建的代码标识会变化，更新后 macOS 可能会再次询问是否允许访问钥匙串项目（例如基准测试共享凭据）。卸载时请退出 AioLM 并将 `AioLM.app` 移到废纸篓；如需删除数据，请删除 `~/.aiolm`。

与 Linux 相同，正常退出会停止 AioLM 的模型进程，强制退出则不会。

## 从源码构建

可以自行构建安装程序来代替发布文件。自行构建的安装程序不是正式发布版本，也未经公证。

### 要求

- Windows 10/11 x64、Linux x86_64（Ubuntu 24.04 或更新版本）或 macOS 13.3 或更新版本（Apple Silicon 或 Intel，需 Xcode 命令行工具）
- Node `22.23.2` 和 npm `12.0.2`（`.node-version`、`package.json#engines`）
- Rust `1.98.0`（`rust-toolchain.toml`；rustup 会自动使用固定版本）
- 对应操作系统的 [Tauri v2 前置条件](https://v2.tauri.app/start/prerequisites/)

在 Debian/Ubuntu 上安装原生构建和 AppImage 运行时构建所需的软件包。这些软件包仅用于构建；运行构建出的 AppImage 还需要 [Linux](#linux) 一节列出的软件包:

```bash
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf desktop-file-utils bubblewrap git curl gnupg patch
```

Linux 打包会从源码构建固定版本的 AppImage 运行时，因此需要 x86_64 主机、`/dev/fuse`、网络访问，以及能够创建非特权用户命名空间的 `bwrap`。Ubuntu 24.04 或更新版本通过 AppArmor 限制该功能；如有需要，请为 `bwrap` 单独允许一个 AppArmor 配置文件，不要关闭系统范围的保护。条件不满足时，打包会在构建前停止并显示解决方法。

### 构建

```bash
git clone https://github.com/aiolm/AioLM.git aiolm
cd aiolm
npm ci
npm run package:tauri
```

安装程序生成在 `.codex-target/release/bundle/` 下（Windows 为 NSIS/MSI，Linux 为 DEB/AppImage，macOS 为 APP/DMG），其中同时包含应用和 `aiolm-cli`。`npm run package:tauri` 会执行本文所述的集成打包，并从二进制文件中移除构建机器的路径；请使用此命令，不要直接运行 `tauri build`。

基准共享服务可在构建时通过 `AIOLM_BENCHMARK_API_URL` 更改。不设置或留空时发布到官方 AioLM 网站 `https://aiolm.vercel.app`。使用其他服务时请指定根 HTTPS 源；设为 `off`（不区分大小写）会构建禁用匿名发布的版本，此时共享摘要与本地结果导出仍可使用。

```powershell
$env:AIOLM_BENCHMARK_API_URL = "off"
npm run package:tauri
```
