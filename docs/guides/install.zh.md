# 安装

> **语言:** [English](install.md) | [한국어](install.ko.md) | [日本語](install.ja.md) | [中文](install.zh.md)

## 一行安装 (Windows)

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

## 验证下载

发布的安装程序未签名。请将 SHA-256 值与同一版本的 `checksums.txt` 进行比较。

```powershell
$installer = Get-ChildItem -File "./AioLM_*_x64-setup.exe" | Select-Object -First 1
# 对 MSI 使用 "./AioLM_*_x64_en-US.msi"。
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# 与同一版本的 checksums.txt 对比
```

发布页面: <https://github.com/aiolm/AioLM/releases/latest>

AioLM — All-In-One LM与旧应用独立安装。首次启动会将原有设置、托管运行时、CLI数据和WebView配置复制到新的 `aiolm` / `com.aiolm.desktop` 目录。原始数据保留，已有AioLM数据优先。迁移前请关闭旧应用；解除锁定或释放磁盘空间后可重试。[迁移详情](../reference/migration.md)。

AioLM将数据保存在 `%USERPROFILE%\.aiolm`，也可以通过环境变量 `AIOLM_HOME` 指定其他文件夹。早期AioLM版本的数据会在启动时导入该文件夹，托管运行时会被移动而非复制。参见[数据文件夹](../reference/migration.md#data-folder)。

## Linux

适用于 Ubuntu 24.04 或更新版本、x86_64。推荐使用 DEB 集成应用菜单和图标；AppImage 为便携格式。本次验证不涵盖 ARM64 和 NVIDIA DGX。

从同一个[发布版本](https://github.com/aiolm/AioLM/releases/latest)下载 DEB 或 AppImage 及 `checksums.txt`。**从 v0.2.1 开始也提供 Linux 文件。** 如需发布前的验证构建，可登录 GitHub，在成功的 [Validate desktop packages](https://github.com/aiolm/AioLM/actions/workflows/desktop-packages.yml) 运行的 Artifacts 中下载 `desktop-packages-ubuntu-24.04`。文件过期后请使用[源码构建](development.md)。验证构建并非正式发布版本。

将 SHA-256 值与校验和文件中的对应项进行比较。在仅包含所需版本 DEB 的文件夹内执行:

```bash
sha256sum ./AioLM_*_amd64.deb
sudo apt install ./AioLM_*_amd64.deb
```

安装后从应用菜单启动 AioLM。DEB 会注册启动项和图标。使用 `sudo apt remove aio-lm` 卸载后，`~/.aiolm` 或 `AIOLM_HOME` 中的数据会保留。

将 AppImage 放在长期保留的文件夹，验证校验和后赋予执行权限。Ubuntu 24.04 或更新版本若缺少 FUSE 2，请安装 `libfuse2t64`:

```bash
sudo apt install libfuse2t64
chmod +x ./AioLM_*.AppImage
./AioLM_*.AppImage
```

仅运行 AppImage 不会注册应用菜单。请下载同一发布中的 `register-linux-desktop.py`；验证构建使用[对应源码版本的辅助脚本](../../scripts/register-linux-desktop.py)，需要 Python 3。使用发布校验和验证辅助脚本后注册所选 AppImage:

```bash
python3 register-linux-desktop.py --appimage ./AioLM_*.AppImage
```

该操作将图标和启动项注册到 XDG 用户数据目录，不会移动 AppImage。更改文件路径后请重新注册。切换到 DEB 前，使用 `python3 register-linux-desktop.py --remove` 删除本地注册。开发运行 `npm run tauri -- dev` 会自动注册图标，参见[开发指南](development.md)。

DEB 更新会在系统安装界面打开已验证文件，由用户完成安装。AppImage 通过发布页面更新并重新注册新路径。GPU 加速需要相应驱动和兼容的 llama.cpp 运行时。

## macOS

AioLM 支持 Apple Silicon 和 Intel Mac 上的 macOS Ventura 13.3 及以上版本。Apple Silicon 可使用 Metal GPU 加速，Intel Mac 使用 CPU 运行时。macOS 安装包从 **v0.3.0** 开始提供。托管验证及其余实机检查参见 [macOS 验证](../reference/macos-validation.md)。

### 通过终端安装

```bash
curl -fsSL https://github.com/aiolm/AioLM/releases/latest/download/install.sh | bash
```

脚本会下载适合当前 Mac 的 DMG，与发布中的 SHA-256 核对后，将 `AioLM.app` 复制到 `/Applications`（不可写时为 `~/Applications`）。运行前请先退出 AioLM。`AIOLM_RELEASE=v0.3.0` 可选择版本，`AIOLM_DRY_RUN=1` 仅执行校验，`AIOLM_APPLICATIONS_DIR` 可指定安装目录。当前源码：<https://github.com/aiolm/AioLM/blob/main/install.sh>

### 手动安装 DMG

下载 `AioLM_<版本>_aarch64.dmg`（Apple Silicon）或 `AioLM_<版本>_x64.dmg`（Intel），将 `shasum -a 256` 的结果与同一版本的 `checksums.txt` 比较，然后打开并将 AioLM 拖到“应用程序”。应用仅有临时（ad-hoc）签名且未经公证，因此通过浏览器下载的副本首次启动会被阻止：先尝试打开一次，然后选择**系统设置 → 隐私与安全性 → 仍要打开**。在 macOS 13 和 14 上也可以按住 Control 点按应用并选择**打开**。每个安装的副本只需操作一次。

AioLM 的数据保存在 `~/.aiolm`，替换或删除应用都会保留。应用安装在 `/Applications` 或 `~/Applications` 时，设置中的**下载并安装**会获取适合当前 Mac 的 DMG，请用新副本替换应用。由于未签名构建的代码标识会变化，更新后 macOS 可能会再次询问是否允许访问钥匙串项目（例如基准测试共享凭据）。卸载时请退出 AioLM 并将 `AioLM.app` 移到废纸篓；如需删除数据，请删除 `~/.aiolm`。
