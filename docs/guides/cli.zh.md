# CLI

> **语言:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

开发时，`aiolm-cli.exe` 会生成在 `.codex-target/release/aiolm-cli.exe`。打包版本会将它作为 Tauri 资源包含；安装后请在应用的资源目录中查找。输出为 JSON，服务器仅使用 loopback，且不会持久化凭证。

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list   # `runtimes` 也可作为别名
./aiolm-cli.exe runtime device
./aiolm-cli.exe runtime probe <backend> <build>
./aiolm-cli.exe server start   # loopback；headless 模式不启用 API-key 认证
./aiolm-cli.exe server status
./aiolm-cli.exe server logs [lines]
./aiolm-cli.exe server stop
./aiolm-cli.exe server unload  # stop 的别名
./aiolm-cli.exe server restart
./aiolm-cli.exe doctor
```

## 首次启动

启动无头服务器前，请先配置模型。服务器可执行文件会从选定的托管运行时或 `PATH` 中解析。

```powershell
./aiolm-cli.exe config set models_dir "C:\Models"
./aiolm-cli.exe config set active_model "C:\Models\model.gguf"
./aiolm-cli.exe server start
```

- `config set` 会拒绝类似凭证的字段和未知字段。
- `config get` 会隐藏类似凭证的值；设置 `server_args`、`chat_options`、`lora_adapters` 时需要 JSON 值。
- `models delete` 仅允许删除 `models_dir` 内未激活的 `.gguf`/`.mmproj` 文件。
- `runtime device` 会检测本地 GPU 和推荐后端；`runtime probe` 会运行 version/help/device/bench 预检。
- `server start` 使用已配置的模型并绑定到 `127.0.0.1`，且会有意禁用 API-key 认证。仅在可信计算机上使用，不要将端口暴露或转发到外部。
- 标准输出为 JSON，服务器日志大小有限制。

请参阅 [security.zh.md](../policies/security.zh.md) 了解认证和进程边界。
