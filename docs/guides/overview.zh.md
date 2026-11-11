# AioLM

> **语言:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[文档目录](../README.md) — 安装、使用指南、参考文档以及安全与隐私政策。文档以当前源代码为准，已发布的版本可能尚未包含最新更改。

AioLM（All-in-One LM）不是推理引擎，而是用于管理模型、运行时、聊天和基准测试的 Windows/macOS/Linux 桌面 GUI 适配器。可使用 llama.cpp、Linux 或 Apple Silicon macOS（vllm-metal）上的 vLLM、Apple Silicon macOS 上的 MLX，以及其他已连接的 OpenAI 兼容引擎。兼容性和限制请参阅[推理运行时](../reference/inference-runtimes.md)。

固定输出基准测试（`openai-chat-serving@2`）需要引擎支持输出长度控制和流式输出令牌数报告。每个请求都必须报告所选的N个令牌才算成功；提前结束或无法验证时测量失败。选项为1k、4k、8k、16k、32k、64k、128k、200k，1k=1,024。默认值为输入UTF-8 4096/16384 bytes、输出1k、并发1/2/4、重复1次并启用预热。保留启动配置和上下文设置，因此较大输出需要模型及每个并行槽有足够的上下文。原有`@1`记录保留上限语义，仍可查看、导出和共享。请参阅[基准测试指南](../reference/benchmarks.md)。

模型加载与 API 服务器启动相互独立。加载模型后即可使用应用内聊天；若要让外部
应用连接，请在侧边栏的 **API 服务器** 中启动服务器，复制 URL、密钥和模型 ID，
并选择 OpenAI 或 Anthropic 示例。切换或卸载模型不会停止
API 服务器，停止 API 服务器也不会卸载模型或中断应用内聊天。
详情参见[API 服务器指南](local-api.md)。

## 工作空间

- **工作空间：** 聊天、项目。
- **模型管理：** 库、发现、推理引擎、基准测试。
- **集成：** API 服务器、MCP 服务器。
- **应用：** 设置。

桌面侧边栏可折叠为图标栏，窄窗口使用导航抽屉。切换页面、主题、密度或字体时，已打开页面的草稿会保留。顶部栏控制默认运行目标；聊天标题栏中始终可见的会话选择控制当前对话的应答会话。选择 worker 不会改变默认目标。检索嵌入以及音频、视频预处理位于对话设置中。

最大化窗口时，聊天正文、输入框和各工作空间会利用可用宽度。设置、API 页面和模型选项在空间充足时采用多列布局，每个选项的名称、说明和输入框保持在同一组内。模型设置窗口也会随当前窗口的宽高调整；窗口变窄时减少列数，较矮时可滚动内容并继续使用底部操作按钮。

模型设置按 **选择运行时 → 选择预设 → 调整选项** 的顺序进行。下载或预览不会启动模型，保存预设与运行是不同操作；项目也区分保存和应用已保存的设置。主题与字体位于 **设置 → 外观**，密度位于 **常规**。

## 功能

- Hugging Face 模型搜索（可选 GGUF、safetensors、MLX 格式筛选）与安全的模型管理
- 按引擎区分的设置配置、运行选项和多模态输入（推理引擎在模型设置中选择）
- 推理引擎管理（安装与管理 CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO 运行时）与便携式 ZIP 支持
- 通过编号/URL 进行 PR 构建与来源审核
- 流式聊天、本地线程、文档上下文与嵌入
- 用户 AGENTS.md 指令、本地技能和应用内个性化编辑器（[聊天个性化](../reference/personalization.md)）
- 项目、API 服务器、MCP 服务器
- 连接外部推理引擎（[自动引擎连接](../reference/automatic-engine-connections.md)）
- 服务器/采样调优
- 启动时的新版本通知，以及在设置中通过已验证的安装程序更新

**Discover**（Hugging Face 搜索）默认按 **Trending**（热门趋势）排序显示所有格式的仓库，也可以用 GGUF、safetensors、MLX 筛选器缩小范围。出现在搜索结果中并不代表支持下载或运行。应用下载 GGUF 和完整的 safetensors/MLX 模型包。选择权重文件时，会一并下载该模型的配置、分词器和所有必需分片，不包含其他模型或量化版本的权重；原有的完整模型下载也保留。其他格式可在支持该格式的外部引擎中使用。Discover 不会选择或偏向任何推理引擎。

下载时会显示速度和剩余时间，并可**暂停**。已接收的数据会保留，因此因暂停、失败或退出应用而中断的下载会留在 **Discover → 已暂停的下载** 中，点击**继续**即可从中断处接着下载。公开了摘要的文件即使是续传也会从头到尾校验。下载模型期间也可以安装推理引擎。关闭窗口默认会隐藏到系统托盘，并可在**设置 → 服务器**中设置登录时自动启动 AioLM。

已加载模型的会话操作、日志和运行设置都在 **库** 中查看，没有单独的诊断或会话页面。

在模型设置窗口的运行时选择或运行时与 GPU 选项中点击**管理推理引擎**，无论当前选择了哪个引擎，都会打开**全部推理引擎列表**。即使此前在管理页面查看特定引擎，也会返回全部列表。点击**返回模型设置**可保留未保存的选项以及所选引擎和运行时。**推理引擎**指 llama.cpp、vLLM、MLX 等引擎类型，**运行时**指已安装的运行环境。

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
