# CLI

> **言語:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

開発中の `aiolm-cli.exe` は `.codex-target/release/aiolm-cli.exe` に生成されます。パッケージ版では補助バイナリとして含まれるため、インストール後は `aiolm.exe` と同じインストールディレクトリにあります。macOS では `/Applications/AioLM.app/Contents/MacOS/aiolm-cli`（または `~/Applications` 配下）です。出力は JSON、サーバーは loopback 専用で、認証情報は保存されません。

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list   # `runtimes` も別名として使用可能
./aiolm-cli.exe runtime device
./aiolm-cli.exe runtime probe <backend> <build>
./aiolm-cli.exe runtime select <backend> <build>
./aiolm-cli.exe server start   # loopback、headless モードでは API-key 認証なし
./aiolm-cli.exe server status
./aiolm-cli.exe server logs [lines]
./aiolm-cli.exe server stop
./aiolm-cli.exe server unload  # stop の別名
./aiolm-cli.exe server restart
./aiolm-cli.exe doctor
```

## 初回起動

デスクトップアプリでランタイムをインストールまたはインポートし、`runtime list` のバックエンドとビルドを選んでモデルを設定してください。`runtime select` は両方の識別子をまとめて検証・保存し、無効な選択では既存設定を変更しません。サーバー起動には選択した管理ランタイムが必要です。Linux/macOS では `.exe` を付けずに `./aiolm-cli` を使用します。

```powershell
./aiolm-cli.exe runtime list
./aiolm-cli.exe runtime select cpu <installed-build>
./aiolm-cli.exe config set models_dir "C:\Models"
./aiolm-cli.exe config set active_model "C:\Models\model.gguf"
./aiolm-cli.exe server start
```

- `config set` は認証情報に見えるフィールドと未知のフィールドを拒否します。
- `config get` は認証情報に見える値を伏せ字にします。`server_args`、`chat_options`、`lora_adapters` の設定値には JSON が必要です。
- `models delete` は `models_dir` 内の非アクティブな `.gguf`/`.mmproj` とアプリ所有のモデルスナップショットを削除できます。マニフェスト外のファイルを保持し、実行中のモデルと補助モデルの削除を拒否します。

- `runtime device` はローカル GPU と推奨バックエンドを検出し、`runtime probe` は version/help/device/bench の事前チェックを実行します。
- `server start` は設定済みモデルを使用し、`127.0.0.1` にバインドして API-key 認証を意図的に無効化します。信頼できる PC だけで使用し、ポートを外部公開・転送しないでください。
- 標準出力は JSON で、サーバーログのサイズには上限があります。

[security.ja.md](../policies/security.ja.md) で認証とプロセス境界を確認してください。

## Python エンジンのランタイム

`runtime export <vllm|mlx-vlm> <ランタイムID> <新規バンドル.zip>` はエンジン依存関係の正確なバージョンのホイールとプラットフォーム・ABI・ハッシュを保存します。`runtime import <バンドル.zip>` はローカルホイールのみで新しい分離環境にインストールして検査します。対象端末には互換性のあるPythonが必要です。モデルは別途管理します。先にヘッドレスサーバーを停止してください。Ctrl-Cで未完了処理を片付け、エクスポートは既存ファイルを上書きしません。

`config set provider_options '<JSON>'` はエンジン別のオプションマップ全体を置き換えます。`config get` で既存値を読み、他のエンジンの項目を保持してから、`{"vllm":{"max_model_len":8192},"mlx-vlm":{"temperature":0.7}}` のようなオブジェクトをシェルの引数1つとして渡してください。不正または未知のオプションでは保存済み設定は変わらず、`{}` はマップ全体を消去します。モデルとインストール済みランタイムの検査は起動前に行われます。

vLLM は Linux または vllm-metal 経由で Apple Silicon macOS 15+、mlx-vlm は Apple Silicon macOS で実行します。対応する Mac の `runtime install vllm` は vLLM/vllm-metal 0.30.0 の対応するホイールとネイティブ arm64 Python 3.12 を使用します。`runtime list` は Python ランタイムも表示します。`runtime install <vllm|mlx-vlm> [Python実行ファイル]` で分離環境にインストールするか、`runtime register <vllm|mlx-vlm> <Python実行ファイル>` で既存環境を登録し、`runtime select <vllm|mlx-vlm> <ランタイムID>` で選択します。`runtime probe` と `runtime remove` も同じエンジン名とIDを使います。既存環境の削除ではPythonとパッケージを保持し、インストール中のCtrl-Cは未完了の分離環境を片付けます。[推論ランタイム](../reference/inference-runtimes.md)も参照してください。
