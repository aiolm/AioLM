# AioLM

> **语言:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[文档目录](../README.md) — 安装、开发、代码结构及项目政策。

`llama.cpp` 的 Windows 桌面运行时管理器。通过 Tauri v2 桌面 UI 封装 `llama-server` / `llama-bench`，管理模型、运行时、聊天和基准测试。

## 功能

- GGUF 模型发现与安全管理
- 运行时管理（CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO）与便携式 ZIP 支持
- 通过编号/URL 进行 PR 构建与来源审核
- 流式聊天、本地线程、文档上下文与嵌入
- 项目、Hugging Face Discover、开发者/MCP 网关
- 服务器/采样调优

在调优页面使用 **重置全部调优** 删除所有覆盖值（包括服务器参数与聊天 JSON），也可通过每个参数的 **恢复默认值** 单独重置。使用的是所选 llama.cpp 运行时与模型的默认值，而非固定推荐预设。通过 **自定义值** 可重新输入，配置也会保存默认值使用状态。模型文件、适配器、GPU 分配、运行时及已保存配置保持不变。服务器设置重启后生效，默认上下文大小与显存用量可能因运行时和模型而异。

## 平台支持

目前支持 Windows x64。**计划支持 Linux（包括 NVIDIA DGX）和 macOS**。Linux/macOS 将使用 `curl | tar`，Windows 使用 `NSIS`/`MSI`。完成 SignPath Foundation 接入并获得手动批准后，Windows 发布安装程序会由 GitHub 托管的 CI 使用 Authenticode 签名；请验证发布的签名和 SHA-256 校验和。

## 下载

从 [GitHub Releases](https://github.com/llama-board/llama-board/releases) 获取最新版本。

高级安装选项、验证、开发环境和 CLI 用法请参见 [install.zh.md](install.zh.md)、[development.zh.md](development.zh.md) 和 [cli.zh.md](cli.zh.md)。

现有数据迁移与兼容性请参阅[迁移指南](../reference/migration.md)。

## 代码签名政策 (Code signing policy)

请参阅 [code-signing.md](../policies/code-signing.md) 和 [privacy.md](../policies/privacy.md)，了解签名范围、角色、发布审批、隐私和卸载政策。

## 安全

请参见 [security.zh.md](../policies/security.zh.md)。

## 许可证

MIT — 见 [LICENSE](../../LICENSE)。llama.cpp 二进制文件 — 见 [NOTICE](../../NOTICE)。
