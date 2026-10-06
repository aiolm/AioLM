# CLI

> **语言:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

开发时，`aiolm-cli.exe` 会生成在 `.codex-target/release/aiolm-cli.exe`。打包版本会将它作为辅助二进制文件包含；安装后请在与 `aiolm.exe` 相同的安装目录中查找。macOS 上位于 `/Applications/AioLM.app/Contents/MacOS/aiolm-cli`（或 `~/Applications` 下）。输出为 JSON，服务器仅使用 loopback，且不会持久化凭证。

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list   # `runtimes` 也可作为别名
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
- `config get` 会隐藏类似凭证的值；设置 `server_args`、`chat_options`、`lora_adapters` 时需要 JSON 值。
- `models delete` 可删除 `models_dir` 内未激活的 `.gguf`/`.mmproj` 文件和应用拥有的模型快照。它保留清单外的用户文件，并拒绝删除正在使用的模型及辅助模型。

- `runtime device` 会检测本地 GPU 和推荐后端；`runtime probe` 会运行 version/help/device/bench 预检。
- `server start` 使用已配置的模型并绑定到 `127.0.0.1`，且会有意禁用 API-key 认证。仅在可信计算机上使用，不要将端口暴露或转发到外部。
- 标准输出为 JSON，服务器日志大小有限制。

请参阅 [security.zh.md](../policies/security.zh.md) 了解认证和进程边界。

## Python 引擎运行时

`runtime export <vllm|mlx-vlm> <运行时ID> <新包.zip>` 保存引擎依赖项的精确 wheel 版本、平台、ABI 和哈希。`runtime import <包.zip>` 仅使用本地 wheel 安装到新的隔离环境并检查。目标设备需要兼容的基础 Python，模型单独管理。先停止无界面服务器；Ctrl-C 会清理未完成的操作，导出不会覆盖已有文件。

`config set provider_options '<JSON>'` 会替换整个引擎选项映射。先用 `config get` 读取现有值并保留其他引擎的条目，再将 `{"vllm":{"max_model_len":8192},"mlx-vlm":{"temperature":0.7}}` 等对象作为一个 shell 参数传入。无效或未知选项不会更改已保存的配置；`{}` 会清空整个映射。模型和已安装运行时的检查在启动前执行。

vLLM 在 Linux 或通过 vllm-metal 在 Apple Silicon macOS 15+ 上运行，mlx-vlm 在 Apple Silicon macOS 上运行。在支持的 Mac 上，`runtime install vllm` 使用匹配的 vLLM/vllm-metal 0.30.0 wheel 和原生 arm64 Python 3.12。`runtime list` 也显示 Python 运行时。使用 `runtime install <vllm|mlx-vlm> [Python可执行文件]` 安装隔离环境，或使用 `runtime register <vllm|mlx-vlm> <Python可执行文件>` 注册现有环境，然后通过 `runtime select <vllm|mlx-vlm> <运行时ID>` 选择。`runtime probe` 和 `runtime remove` 使用相同的引擎名称和ID。删除注册不会删除原有Python及其包，安装过程中Ctrl-C会清理未完成的隔离环境。详情见[推理运行时](../reference/inference-runtimes.md)。
