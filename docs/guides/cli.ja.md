# CLI

> **言語:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

`aiolm-cli` はインストーラーに補助バイナリとして含まれます。Windows では `aiolm.exe` と同じインストールディレクトリに `aiolm-cli.exe` があります。[ソースからビルド](install.ja.md#ソースからビルド)した場合は `.codex-target/release/` にもあります。macOS では `/Applications/AioLM.app/Contents/MacOS/aiolm-cli`（または `~/Applications` 配下）です。出力は JSON、サーバーは loopback 専用で、認証情報は保存されません。

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>  # 型付きの秘密情報でない値のみ
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list   # `runtimes` も別名として使用可能
./aiolm-cli.exe runtime discover [folder]
./aiolm-cli.exe runtime connect <candidate-id> <model-id> [folder] [--command <word>]...
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
- `config set` は保存前に変更後の設定全体を検証します。両方のバッチサイズが明示されている場合、`ubatch_size` は `batch_size` 以下でなければなりません。両方を減らすときは先に `ubatch_size` を下げてください。
- `config get` は認証情報に見える値を伏せ字にします。`server_args`、`chat_options`、`lora_adapters` の設定値には JSON が必要です。
- `models delete` は `models_dir` 内の非アクティブな `.gguf`/`.mmproj` とアプリ所有のモデルスナップショットを削除できます。マニフェスト外のファイルを保持し、実行中のモデルと補助モデルの削除を拒否します。

- `runtime device` はローカル GPU と推奨バックエンドを検出し、`runtime probe` は llama-server の version/help/device の事前チェックを実行し、任意ツール llama-bench が動作するかも報告します。llama-bench がない、または失敗しても事前チェックは失敗しません。
- `server start` は設定済みモデルを使用し、`127.0.0.1` にバインドして API-key 認証を意図的に無効化します。信頼できる PC だけで使用し、ポートを外部公開・転送しないでください。
- 標準出力は JSON です。`server logs` は最新の 1 MiB から指定された行数を選びます。追記のたびにファイルを書き直さないよう、ログファイルが 2 MiB を超えたときに最新の 1 MiB だけを残します。

[security.ja.md](../policies/security.ja.md) で認証とプロセス境界を確認してください。

## 外部エンジンの接続

`runtime discover [folder]` は現在のユーザーのローカルモデル API を探し、フォルダーを指定した場合はそのインストールフォルダー内のエントリーポイントも探します。候補プログラムは実行しません。JSON レポートには `candidates`（各候補の `id`、`display_name`、`source`、`entrypoint_kind`、`endpoints`、`state`）、`warnings`、`truncated` が含まれます。

`runtime connect <candidate-id> <model-id> [folder] [--command <word>]...` は候補を再検出して調べ、選択したモデルのチャットとストリーミング応答を検証して登録を保存します。検出結果の候補 ID を使い、フォルダーを指定して検出した場合は同じフォルダーを渡してください。フォルダー内のインストールでは、モデル ID は設定済みのモデルカタログにあるローカルモデルのパスです。実行中の API では、そのサーバーが提供するモデル ID を使います。接続時にプログラムを実行したりローカルサーバーにリクエストを送ったりするため、信頼できるインストールだけを選んでください。接続前にヘッドレスサーバーを停止してください。

文書化されたサービングコマンドを選ぶには、単語ごとに `--command` を繰り返します。例は `--command serve --command llm` です。複数のサービングコマンドが見つかった場合はエラーに選択肢が表示されるので、いずれかを指定して接続を再実行してください。登録しても選択中のランタイムやモデルは変わりません。

高度な手動登録には `runtime register-manifest <manifest.json>` を使います。バージョン付きの外部プロセスアダプターを検査・登録し、エンジンファイルは外部に保持します。登録前にヘッドレスサーバーを停止してください。返されたエンジンとランタイムの ID を明示的に選択し、`runtime probe` で現在のアクティブモデルを検査します。

```text
aiolm-cli runtime register-manifest <manifest.json>
aiolm-cli runtime select <custom.engine> <runtime-id>
aiolm-cli runtime probe <custom.engine> <runtime-id>
```

検証の詳細は[外部エンジンの接続](../reference/automatic-engine-connections.md)、マニフェスト形式は[高度な手動登録](../reference/automatic-engine-connections.md#advanced-manual-registration)を参照してください。

## Python エンジンのランタイム

`config set provider_options '<JSON>'` はエンジン別のオプションマップ全体を置き換えます。`config get` で既存値を読み、他のエンジンの項目を保持してから、`{"vllm":{"max_model_len":8192},"mlx-vlm":{"temperature":0.7}}` のようなオブジェクトをシェルの引数1つとして渡してください。不正または未知のオプションでは保存済み設定は変わらず、`{}` はマップ全体を消去します。モデルとインストール済みランタイムの検査は起動前に行われます。

選択中のランタイムの項目(ビルドを選択した `llama.cpp` と登録済みの `custom.*` エンジンを含む)は、設定画面と同じオプションスキーマで検査されます。組み込み・manifest のオプション、そのランタイムのレビュー済みヘルプのオプション、そのヘルプについてユーザーが確認した値の数と繰り返し可否、そしてコマンドラインの順序と項目ごとの表記を保持する `@option_order` 記録が対象です。より新しいアプリが作った記録や保存値と一致しない記録は拒否されます。

vLLM は Linux または vllm-metal 経由で Apple Silicon macOS 15+、mlx-vlm は Apple Silicon macOS で実行します。対応する Mac の `runtime install vllm` は vLLM/vllm-metal 0.30.0 の対応するホイールとネイティブ arm64 Python 3.12 を使用します。`runtime list` はネイティブのインストールと登録済み Python のインストールを表示します。固定バージョンのエンジンをインストールするか既存のインタープリターを登録し、返されたランタイム ID を選んでから、完全なローカルモデルスナップショットを選択してください。外部環境の削除ではインタープリターとパッケージを保持します。管理対象のインストール中に Ctrl-C を押すと、処理を取り消して未完了の環境を削除します。

通常の管理対象 vLLM（Metal を除く）・mlx-vlm パッケージのインストールは依存関係も含めてバイナリホイールのみを使用し、ソースビルドには切り替えません。互換ホイールがない場合は安全上の理由を説明してインストールを停止します。代わりに外部環境を自分で準備し、そのインタープリターを登録できます。Mac の vLLM インストールは、上記の対応するホイールを使用する別の Metal プランに従います。

```text
aiolm-cli runtime install <vllm|mlx-vlm> [python-executable]
aiolm-cli runtime register <vllm|mlx-vlm> <python-executable>
aiolm-cli runtime select <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime probe <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime remove <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime export <vllm|mlx-vlm> <runtime-id> <new-bundle.zip>
aiolm-cli runtime import <bundle.zip>
```

エンジン別のモデルファイル、オプションとプロファイルは[推論ランタイム](../reference/inference-runtimes.md)を参照してください。

エクスポートは、インストール済みエンジンの依存関係全体について正確なバージョンのホイールをダウンロードし、プラットフォーム・ABI・ハッシュを保持します。インポートはそれらのホイールを新しい環境にオフラインでインストールして検査します。互換性のある基本 Python インタープリターがすでに必要です。モデルは別途管理します。エクスポート・インポート前にヘッドレスサーバーを停止してください。Ctrl-C は未完了の処理を片付け、エクスポートは既存の出力先ファイルを保持します。
