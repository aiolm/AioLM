# AioLM

> **言語:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[ドキュメント一覧](../README.md) — インストール、使い方、リファレンス、セキュリティとプライバシーのポリシー。ドキュメントは現在のソースに基づくため、公開済みリリースには最新の変更がまだ含まれていない場合があります。

AioLM（All-in-One LM）— Tauri v2 UI でモデル、ランタイム、チャット、ベンチマークを管理する Windows/macOS/Linux デスクトップアプリです。llama.cpp、Linux および Apple Silicon macOS（vllm-metal）の vLLM、Apple Silicon macOS の MLX を選択できます。互換性と制限事項は [推論ランタイム](../reference/inference-runtimes.md) を参照してください。

モデルのロードと API サーバーの起動は独立しています。モデルをロードすると
アプリ内チャットで利用でき、外部アプリから接続する場合はサイドバーの
**APIサーバー**でサーバーを起動し、URL・キー・モデル ID をコピーして
OpenAI または Anthropic の例を選びます。モデルを切り替えたりメモリから解放したりしても
API サーバーは維持され、API を停止してもモデルとアプリ内チャットは利用できます。
詳しくは [API サーバーガイド](local-api.md) を参照してください。

## 機能

- Hugging Face モデル検索（GGUF・safetensors・MLX の形式フィルターを任意で使用）と安全なモデル管理
- エンジン別の設定プロファイル、実行オプション、マルチモーダル入力（推論エンジンはモデル設定で選択）
- ランタイム管理（CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO）とポータブル ZIP 対応
- 番号/URL による PR ビルドと来歴レビュー
- ストリーミングチャット、ローカルスレッド、ドキュメントコンテキスト、埋め込み
- ユーザーの AGENTS.md 指示、ローカルスキル、アプリ内のパーソナライズ編集（[チャットのパーソナライズ](../reference/personalization.md)）
- プロジェクト、API サーバー、MCP サーバー
- 外部推論エンジンとの接続（[エンジンの自動接続](../reference/automatic-engine-connections.md)）
- サーバー/サンプリングチューニング
- 起動時の新バージョン通知と、設定からの検証済みインストーラーによる更新

**Discover**（Hugging Face 検索）は既定であらゆる形式のリポジトリを **Trending**（人気急上昇）順に表示し、必要に応じて GGUF・safetensors・MLX フィルターで絞り込めます。検索結果に表示されても、ダウンロードや実行に対応しているとは限りません。アプリ内ダウンロードが扱うのは GGUF ファイルと完全な safetensors スナップショットだけで、その他の形式はその形式に対応する外部エンジンで利用できます。Discover が推論エンジンを選んだり優先したりすることはありません。

ロード中のモデルのセッション操作、ログ、実行設定は **モデル管理** で確認できます。独立した診断ページやセッションページはありません。

設定プロファイルと実行オプションについては [モデルの選択と設定](../reference/model-settings.md) と [サーバーオプション](../reference/server-options.md)（英語）を参照してください。

## プラットフォーム対応

Windows x64、macOS 13.3 以降（Apple Silicon・Intel）、Linux x86_64（Ubuntu 24.04 以降）のビルドを利用できます。Windows は NSIS/MSI、macOS は DMG、Linux は DEB/AppImage 形式です。**v0.2.1 から Linux パッケージも配布します。** [インストールガイド](install.ja.md#linux)を参照してください。macOS 13.3 以降向けの Apple Silicon（Metal）・Intel（CPU）DMG は **v0.3.0** から配布し、アドホック署名のみで公証されていません。[macOS のインストール](install.ja.md#macos)を参照してください。Linux ARM64 と NVIDIA DGX の環境はまだ確認されていません。リリースファイルは未署名で SHA-256 チェックサムが付属します。チェックサムはダウンロードしたファイルがリリースの一覧と一致するかを確認するだけで、公開者を保証するものではありません。

## ダウンロード

[Linux: DEB / AppImage](install.ja.md#linux)

Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

または [GitHub Releases](https://github.com/aiolm/AioLM/releases) から最新のインストーラーを取得してください。

高度なインストールオプションとダウンロード検証は[インストールガイド](install.ja.md)、自分でビルドする方法は[ソースからビルド](install.ja.md#ソースからビルド)、CLI の使い方は [cli.ja.md](cli.ja.md) を参照してください。

既存データの移行と互換性は[移行ガイド](../reference/migration.md)を参照してください。

## セキュリティとプライバシー

[セキュリティポリシー](../policies/security.ja.md)と[プライバシーポリシー](../policies/privacy.md)を参照してください。

## ライセンス

MIT — [LICENSE](../../LICENSE) 参照。llama.cpp ランタイムと Linux AppImage ランタイムを含むサードパーティーの告知 — [NOTICE](../../NOTICE) 参照。
