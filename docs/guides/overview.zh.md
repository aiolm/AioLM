# AioLM

> **语言:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[文档目录](../README.md) — 安装、使用指南、参考文档以及安全与隐私政策。文档以当前源代码为准，已发布的版本可能尚未包含最新更改。

AioLM（All-in-One LM）不是推理引擎，而是用于管理模型、运行时、聊天和基准测试的 Windows/macOS/Linux 桌面 GUI 适配器。可使用 llama.cpp、Linux 或 Apple Silicon macOS（vllm-metal）上的 vLLM、Apple Silicon macOS 上的 MLX，以及其他已连接的 OpenAI 兼容引擎。兼容性和限制请参阅[推理运行时](../reference/inference-runtimes.md)。

所有已连接且支持文本流式输出的引擎使用相同的 API 基准测试（`openai-chat-serving@1`）、历史记录、导出及共享管理。时间和输出 bytes 为客户端观测值；词元和缓存计数由引擎自行报告，未报告时保持未知。输入 UTF-8 bytes 不是词元数，最大输出 token 请求是上限而非强制生成长度。启动配置保持不变，缓存按当前配置测量，不保证冷缓存。默认值为输入 4096/16384 bytes、输出上限 128 tokens、并发 1/2/4、重复 1 次、启用预热、关闭可选 usage 请求。请参阅[基准测试指南](../reference/benchmarks.md)。

模型加载与 API 服务器启动相互独立。加载模型后即可使用应用内聊天；若要让外部
应用连接，请在侧边栏的 **API 服务器** 中启动服务器，复制 URL、密钥和模型 ID，
并选择 OpenAI 或 Anthropic 示例。切换或卸载模型不会停止
API 服务器，停止 API 服务器也不会卸载模型或中断应用内聊天。
详情参见[API 服务器指南](local-api.md)。

## 功能

- Hugging Face 模型搜索（可选 GGUF、safetensors、MLX 格式筛选）与安全的模型管理
- 按引擎区分的设置配置、运行选项和多模态输入（推理引擎在模型设置中选择）
- 运行时管理（CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO）与便携式 ZIP 支持
- 通过编号/URL 进行 PR 构建与来源审核
- 流式聊天、本地线程、文档上下文与嵌入
- 用户 AGENTS.md 指令、本地技能和应用内个性化编辑器（[聊天个性化](../reference/personalization.md)）
- 项目、API 服务器、MCP 服务器
- 连接外部推理引擎（[自动引擎连接](../reference/automatic-engine-connections.md)）
- 服务器/采样调优
- 启动时的新版本通知，以及在设置中通过已验证的安装程序更新

**Discover**（Hugging Face 搜索）默认按 **Trending**（热门趋势）排序显示所有格式的仓库，也可以用 GGUF、safetensors、MLX 筛选器缩小范围。出现在搜索结果中并不代表支持下载或运行。应用内下载只处理 GGUF 文件和完整的 safetensors 快照；其他格式可在支持该格式的外部引擎中使用。Discover 不会选择或偏向任何推理引擎。

已加载模型的会话操作、日志和运行设置都在 **模型管理** 中查看，没有单独的诊断或会话页面。

设置配置与运行选项请参阅 [模型选择与设置](../reference/model-settings.md) 和 [服务器选项](../reference/server-options.md)（英文）。

## 平台支持

可使用 Windows x64、macOS 13.3 或更新版本（Apple Silicon 和 Intel）以及 Linux x86_64（Ubuntu 24.04 或更新版本）构建。Windows 使用 NSIS/MSI，macOS 使用 DMG，Linux 使用 DEB/AppImage。**从 v0.2.1 开始也提供 Linux 安装包。** 请参阅[安装指南](install.zh.md#linux)。面向 macOS 13.3 及以上版本的 Apple Silicon（Metal）和 Intel（CPU）DMG 从 **v0.3.0** 开始提供，仅有临时（ad-hoc）签名且未经公证，参见 [macOS 安装](install.zh.md#macos)。Linux ARM64 和 NVIDIA DGX 环境尚未经过确认。发布文件未签名，并附有 SHA-256 校验和。校验和只能确认下载的文件与发布清单一致，不能证明发布者身份。

## 下载

[Linux: DEB / AppImage](install.zh.md#linux)

Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

或从 [GitHub Releases](https://github.com/aiolm/AioLM/releases) 直接获取最新安装程序。

高级安装选项和下载验证请参见[安装指南](install.zh.md)，自行构建请参见[从源码构建](install.zh.md#从源码构建)，CLI 用法请参见 [cli.zh.md](cli.zh.md)。

现有数据迁移与兼容性请参阅[迁移指南](../reference/migration.md)。

## 安全与隐私

请参阅[安全政策](../policies/security.zh.md)和[隐私政策](../policies/privacy.md)。

## 许可证

MIT — 见 [LICENSE](../../LICENSE)。第三方声明（包括 llama.cpp 运行时和 Linux AppImage 运行时）— 见 [NOTICE](../../NOTICE)。
