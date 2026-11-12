# CLI

> **语言:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

`aiolm-cli` 作为辅助二进制文件包含在安装程序中。Windows 上请在与 `aiolm.exe` 相同的安装目录中查找 `aiolm-cli.exe`；如果[从源码构建](install.zh.md#从源码构建)，`.codex-target/release/` 中也有一份。macOS 上位于 `/Applications/AioLM.app/Contents/MacOS/aiolm-cli`（或 `~/Applications` 下）。输出为 JSON，服务器仅使用 loopback，且不会持久化凭证。

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>  # 仅限类型明确的非秘密值
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list   # `runtimes` 也可作为别名
./aiolm-cli.exe runtime discover [folder]
./aiolm-cli.exe runtime connect <candidate-id> <model-id> [folder] [--command <word>]...
./aiolm-cli.exe runtime device
./aiolm-cli.exe runtime probe <backend> <build>
./aiolm-cli.exe runtime select <backend> <build>
./aiolm-cli.exe server start   # loopback；headless 模式不启用 API-key 认证
./aiolm-cli.exe server status
./aiolm-cli.exe server logs [lines]
./aiolm-cli.exe server stop
./aiolm-cli.exe server unload  # stop 的别名
./aiolm-cli.exe server restart
./aiolm-cli.exe doctor
```

## 首次启动

先在桌面应用中安装或导入运行时，再从 `runtime list` 中选择后端和构建并配置模型。`runtime select` 会一起验证并保存两个标识；无效选择不会更改原有设置。启动服务器需要选定的托管运行时。在 Linux/macOS 上使用不带 `.exe` 的 `./aiolm-cli`。

```powershell
./aiolm-cli.exe runtime list
./aiolm-cli.exe runtime select cpu <installed-build>
./aiolm-cli.exe config set models_dir "C:\Models"
./aiolm-cli.exe config set active_model "C:\Models\model.gguf"
./aiolm-cli.exe server start
```

- `config set` 会拒绝类似凭证的字段和未知字段。
- 每次 `config set` 都会在保存前验证修改后的配置。若显式设置了两个批次大小，`ubatch_size` 不得超过 `batch_size`；同时减小两者时，请先降低 `ubatch_size`。
- `config get` 会隐藏类似凭证的值；设置 `server_args`、`chat_options`、`lora_adapters` 时需要 JSON 值。
- `models delete` 可删除 `models_dir` 内未激活的 `.gguf`/`.mmproj` 文件和应用拥有的模型快照。它保留清单外的用户文件，并拒绝删除正在使用的模型及辅助模型。

- `runtime device` 会检测本地 GPU 和推荐后端；`runtime probe` 会运行 llama-server 的 version/help/device 预检，并报告可选工具 llama-bench 是否可用；缺少 llama-bench 或其运行失败不会导致预检失败。
- `server start` 使用已配置的模型并绑定到 `127.0.0.1`，且会有意禁用 API-key 认证。仅在可信计算机上使用，不要将端口暴露或转发到外部。
- 标准输出为 JSON。`server logs` 仅从最新的 1 MiB 中选取请求的行数。日志文件超过 2 MiB 时会压缩为最新的 1 MiB，以免每次追加都重写文件。

请参阅 [security.zh.md](../policies/security.zh.md) 了解认证和进程边界。

## 外部引擎连接

`runtime discover [folder]` 查找当前用户的本地模型 API；若提供文件夹，还会查找该安装文件夹内的入口点，但不会执行候选程序。JSON 报告包含 `candidates`（各候选项的 `id`、`display_name`、`source`、`entrypoint_kind`、`endpoints` 和 `state`）、`warnings` 和 `truncated`。

`runtime connect <candidate-id> <model-id> [folder] [--command <word>]...` 会重新发现并检查候选项，验证所选模型的聊天和流式响应，然后保存注册。使用发现结果中的候选 ID；若发现时指定了文件夹，请传入同一文件夹。对于文件夹内的安装，模型 ID 是已配置模型目录中本地模型的路径；对于运行中的 API，请使用该服务器提供的模型 ID。连接时可能运行程序或向本地服务器发送请求，因此请仅选择可信的安装。连接前请停止无界面服务器。

要选择文档中列出的服务命令，请为每个单词重复一次 `--command`，例如 `--command serve --command llm`。若发现多个服务命令，错误信息会列出选项；请指定其中一个并重新连接。注册不会更改当前选定的运行时或模型。

高级手动注册使用 `runtime register-manifest <manifest.json>`，它会探测并注册带版本的外部进程适配器，引擎文件仍保留在外部。注册前请停止无界面服务器。显式选择返回的引擎和运行时 ID，再使用 `runtime probe` 检查当前激活的具体模型：

```text
aiolm-cli runtime register-manifest <manifest.json>
aiolm-cli runtime select <custom.engine> <runtime-id>
aiolm-cli runtime probe <custom.engine> <runtime-id>
```

验证详情见[外部引擎连接](../reference/automatic-engine-connections.md)，清单格式见[高级手动注册](../reference/automatic-engine-connections.md#advanced-manual-registration)。

## Python 引擎运行时

`config set provider_options '<JSON>'` 会替换整个引擎选项映射。先用 `config get` 读取现有值并保留其他引擎的条目，再将 `{"vllm":{"max_model_len":8192},"mlx-vlm":{"temperature":0.7}}` 等对象作为一个 shell 参数传入。无效或未知选项不会更改已保存的配置；`{}` 会清空整个映射。模型和已安装运行时的检查在启动前执行。

所选运行时的条目（包括已选择构建的 `llama.cpp` 和已注册的 `custom.*` 引擎）会使用与设置窗口相同的选项模式进行检查：内置或 manifest 选项、该运行时已审阅帮助中的选项、用户针对该帮助确认的值数量与可否重复，以及保留命令行顺序和每项写法的 `@option_order` 记录。由更新版本应用生成的记录或与已保存值不一致的记录会被拒绝。

vLLM 在 Linux 或通过 vllm-metal 在 Apple Silicon macOS 15+ 上运行，mlx-vlm 在 Apple Silicon macOS 上运行。在支持的 Mac 上，`runtime install vllm` 使用匹配的 vLLM/vllm-metal 0.30.0 wheel 和原生 arm64 Python 3.12。`runtime list` 包含原生安装和已注册的 Python 安装。安装固定版本的引擎或注册现有解释器，然后选择返回的运行时 ID，再选择完整的本地模型快照。移除外部环境会保留解释器及其包；在托管安装期间按 Ctrl-C 会取消安装并删除未完成的环境。

标准托管 vLLM（非 Metal）和 mlx-vlm 包安装仅使用二进制 wheel，包括其依赖项，不会回退到源码构建。缺少兼容 wheel 时，安装会停止并说明安全原因。也可自行准备外部环境并注册其解释器。Mac 的 vLLM 安装使用上文所述的独立匹配版本 Metal wheel 方案。

```text
aiolm-cli runtime install <vllm|mlx-vlm> [python-executable]
aiolm-cli runtime register <vllm|mlx-vlm> <python-executable>
aiolm-cli runtime select <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime probe <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime remove <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime export <vllm|mlx-vlm> <runtime-id> <new-bundle.zip>
aiolm-cli runtime import <bundle.zip>
```

各引擎的模型文件、选项和配置方案见[推理运行时](../reference/inference-runtimes.md)。

导出会下载已安装引擎整个依赖闭包中精确版本的 wheel，并保留平台、ABI 和哈希。导入会将这些 wheel 离线安装到新环境并进行探测；必须已安装兼容的基础 Python 解释器。模型单独管理。导出或导入前请停止无界面服务器；Ctrl-C 会清理未完成的操作，导出会保留现有目标文件。
