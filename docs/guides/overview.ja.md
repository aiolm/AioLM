# AioLM

> **言語:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[ドキュメント一覧](../README.md) — インストール、開発、コード構成、プロジェクトポリシー。

AioLM（All-in-One LM）— `llama.cpp` 用 Windows/Linux デスクトップランタイムマネージャー。`llama-server` を利用した Tauri v2 デスクトップ UI で、モデル、ランタイム、チャット、ベンチマークを管理します。

モデルのロードと API サーバーの起動は独立しています。モデルをロードすると
アプリ内チャットで利用でき、外部アプリから接続する場合はサイドバーの
**APIサーバー**でサーバーを起動し、URL・キー・モデル ID をコピーして
OpenAI または Anthropic の例を選びます。モデルを切り替えたりメモリから解放したりしても
API サーバーは維持され、API を停止してもモデルとアプリ内チャットは利用できます。
詳しくは [API サーバーガイド](local-api.md) を参照してください。

## 機能

- GGUF モデルの探索と安全な管理
- ランタイム管理（CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO）とポータブル ZIP 対応
- 番号/URL による PR ビルドと来歴レビュー
- ストリーミングチャット、ローカルスレッド、ドキュメントコンテキスト、埋め込み
- プロジェクト、Hugging Face Discover、API サーバー、MCP サーバー
- サーバー/サンプリングチューニング

調整画面の **すべての調整をリセット** でサーバー引数とチャット JSON を含む指定値を削除でき、各項目の **既定値に戻す** で個別に戻せます。推奨プリセットの固定値ではなく、選択した llama.cpp ランタイム・モデルの既定値を使います。**値を指定** で再入力でき、既定値の使用状態もプロファイルに保存されます。モデルファイル、アダプター、GPU 配置、ランタイム、保存済みプロファイルは維持されます。サーバー設定は再起動後に反映され、コンテキストとメモリ使用量が変わる場合があります。

## プラットフォーム対応

Windows x64 と Linux x86_64（Ubuntu 24.04 以降）のビルドを利用できます。Linux は DEB/AppImage、Windows は NSIS/MSI 形式です。**v0.2.1 から Linux パッケージも配布します。** [インストールガイド](install.ja.md#linux)を参照してください。macOS 13.3 以降向けの Apple Silicon（Metal）・Intel（CPU）DMG は、それを含む最初のリリースから配布し、アドホック署名のみで公証されていません。[macOS のインストール](install.ja.md#macos)を参照してください。Linux ARM64/NVIDIA DGX の検証は未完了です。[検証手順](../reference/cross-platform-validation.md)を参照してください。リリースファイルは未署名で SHA-256 チェックサムが付属します。

## ダウンロード

[Linux: DEB / AppImage](install.ja.md#linux)

Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

または [GitHub Releases](https://github.com/aiolm/AioLM/releases) から最新のインストーラーを取得してください。

高度なインストールオプション、検証、開発環境、CLI の使い方は [install.ja.md](install.ja.md)、[development.ja.md](development.ja.md)、[cli.ja.md](cli.ja.md) を参照してください。

既存データの移行と互換性は[移行ガイド](../reference/migration.md)を参照してください。

## セキュリティとプライバシー

[セキュリティポリシー](../policies/security.ja.md)と[プライバシーポリシー](../policies/privacy.md)を参照してください。

## ライセンス

MIT — [LICENSE](../../LICENSE) 参照。llama.cpp バイナリ — [NOTICE](../../NOTICE) 参照。
