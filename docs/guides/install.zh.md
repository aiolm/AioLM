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

## Linux / macOS (计划中)

Linux/macOS 的实际环境验证尚未完成。主机构建在 Linux 生成 DEB/AppImage，在 macOS 生成 APP/DMG。请参阅[验证步骤](../reference/cross-platform-validation.md)。除生成安装包外，还需验证 macOS 签名、公证和安装。DEB/DMG 更新会在系统安装界面打开已验证的文件，由用户完成安装。AppImage 和手动安装通过发布页面更新。
