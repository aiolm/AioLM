# AioLM

> **语言:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[文档目录](../README.md) — 安装、开发、代码结构及项目政策。

AioLM（All-in-One LM）— `llama.cpp` 的 Windows/macOS/Linux 桌面运行时管理器。通过基于 `llama-server` 的 Tauri v2 桌面 UI，管理模型、运行时、聊天和基准测试。

模型加载与 API 服务器启动相互独立。加载模型后即可使用应用内聊天；若要让外部
应用连接，请在侧边栏的 **API 服务器** 中启动服务器，复制 URL、密钥和模型 ID，
并选择 OpenAI 或 Anthropic 示例。切换或卸载模型不会停止
API 服务器，停止 API 服务器也不会卸载模型或中断应用内聊天。
详情参见[API 服务器指南](local-api.md)。

## 功能

- GGUF 模型发现与安全管理
- 运行时管理（CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO）与便携式 ZIP 支持
- 通过编号/URL 进行 PR 构建与来源审核
- 流式聊天、本地线程、文档上下文与嵌入
- 项目、Hugging Face Discover、API 服务器、MCP 服务器
- 服务器/采样调优

在调优页面使用 **重置全部调优** 删除所有覆盖值（包括服务器参数与聊天 JSON），也可通过每个参数的 **恢复默认值** 单独重置。使用的是所选 llama.cpp 运行时与模型的默认值，而非固定推荐预设。通过 **自定义值** 可重新输入，配置也会保存默认值使用状态。模型文件、适配器、GPU 分配、运行时及已保存配置保持不变。服务器设置重启后生效，默认上下文大小与显存用量可能因运行时和模型而异。

## 平台支持

可使用 Windows x64、macOS 13.3 或更新版本（Apple Silicon 和 Intel）以及 Linux x86_64（Ubuntu 24.04 或更新版本）构建。Windows 使用 NSIS/MSI，macOS 使用 DMG，Linux 使用 DEB/AppImage。**从 v0.2.1 开始也提供 Linux 安装包。** 请参阅[安装指南](install.zh.md#linux)。面向 macOS 13.3 及以上版本的 Apple Silicon（Metal）和 Intel（CPU）DMG 从 **v0.3.0** 开始提供，仅有临时（ad-hoc）签名且未经公证，参见 [macOS 安装](install.zh.md#macos)。Linux ARM64/NVIDIA DGX 验证尚未完成。参见[跨平台验证](../reference/cross-platform-validation.md)。发布文件未签名，并附有 SHA-256 校验和。

## 下载

[Linux: DEB / AppImage](install.zh.md#linux)

Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

或从 [GitHub Releases](https://github.com/aiolm/AioLM/releases) 直接获取最新安装程序。

高级安装选项、验证、开发环境和 CLI 用法请参见 [install.zh.md](install.zh.md)、[development.zh.md](development.zh.md) 和 [cli.zh.md](cli.zh.md)。

现有数据迁移与兼容性请参阅[迁移指南](../reference/migration.md)。

## 安全与隐私

请参阅[安全政策](../policies/security.zh.md)和[隐私政策](../policies/privacy.md)。

## 许可证

MIT — 见 [LICENSE](../../LICENSE)。llama.cpp 二进制文件 — 见 [NOTICE](../../NOTICE)。
