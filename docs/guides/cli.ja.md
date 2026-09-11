# CLI

> **言語:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

開発中の `aiolm-cli.exe` は `.codex-target/release/aiolm-cli.exe` に生成されます。パッケージ版では Tauri リソースとして含まれるため、インストール後はアプリのリソースディレクトリにあります。出力は JSON、サーバーは loopback 専用で、認証情報は保存されません。

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list   # `runtimes` も別名として使用可能
./aiolm-cli.exe runtime device
./aiolm-cli.exe runtime probe <backend> <build>
./aiolm-cli.exe server start   # loopback、headless モードでは API-key 認証なし
./aiolm-cli.exe server status
./aiolm-cli.exe server logs [lines]
./aiolm-cli.exe server stop
./aiolm-cli.exe server unload  # stop の別名
./aiolm-cli.exe server restart
./aiolm-cli.exe doctor
```

## 初回起動

ヘッドレスサーバーを起動する前にモデルを設定してください。サーバー実行ファイルは、選択した管理ランタイムまたは `PATH` から解決されます。

```powershell
./aiolm-cli.exe config set models_dir "C:\Models"
./aiolm-cli.exe config set active_model "C:\Models\model.gguf"
./aiolm-cli.exe server start
```

- `config set` は認証情報に見えるフィールドと未知のフィールドを拒否します。
- `config get` は認証情報に見える値を伏せ字にします。`server_args`、`chat_options`、`lora_adapters` の設定値には JSON が必要です。
- `models delete` は `models_dir` 内の非アクティブな `.gguf`/`.mmproj` ファイルだけを削除できます。
- `runtime device` はローカル GPU と推奨バックエンドを検出し、`runtime probe` は version/help/device/bench の事前チェックを実行します。
- `server start` は設定済みモデルを使用し、`127.0.0.1` にバインドして API-key 認証を意図的に無効化します。信頼できる PC だけで使用し、ポートを外部公開・転送しないでください。
- 標準出力は JSON で、サーバーログのサイズには上限があります。

[security.ja.md](../policies/security.ja.md) で認証とプロセス境界を確認してください。
