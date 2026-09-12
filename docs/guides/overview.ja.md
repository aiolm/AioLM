# AioLM

> **言語:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[ドキュメント一覧](../README.md) — インストール、開発、コード構成、プロジェクトポリシー。

`llama.cpp` 用 Windows デスクトップランタイムマネージャー。`llama-server` を利用した Tauri v2 デスクトップ UI で、モデル、ランタイム、チャット、ベンチマークを管理します。

## 機能

- GGUF モデルの探索と安全な管理
- ランタイム管理（CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO）とポータブル ZIP 対応
- 番号/URL による PR ビルドと来歴レビュー
- ストリーミングチャット、ローカルスレッド、ドキュメントコンテキスト、埋め込み
- プロジェクト、Hugging Face Discover、開発者/MCP ゲートウェイ
- サーバー/サンプリングチューニング

調整画面の **すべての調整をリセット** でサーバー引数とチャット JSON を含む指定値を削除でき、各項目の **既定値に戻す** で個別に戻せます。推奨プリセットの固定値ではなく、選択した llama.cpp ランタイム・モデルの既定値を使います。**値を指定** で再入力でき、既定値の使用状態もプロファイルに保存されます。モデルファイル、アダプター、GPU 配置、ランタイム、保存済みプロファイルは維持されます。サーバー設定は再起動後に反映され、コンテキストとメモリ使用量が変わる場合があります。

## プラットフォーム対応

現在は Windows x64 をサポートしています。**Linux（NVIDIA DGX を含む）および macOS 対応を予定**しています。Linux/macOS は `curl | tar`、Windows は `NSIS`/`MSI` を使用します。Windows インストーラーは GitHub ホスト型 CI でビルドし、未署名のファイルと SHA-256 チェックサムを配布します。

## ダウンロード

最新リリースは [GitHub Releases](https://github.com/joowon-jang/AioLM/releases) から取得してください。

高度なインストールオプション、検証、開発環境、CLI の使い方は [install.ja.md](install.ja.md)、[development.ja.md](development.ja.md)、[cli.ja.md](cli.ja.md) を参照してください。

既存データの移行と互換性は[移行ガイド](../reference/migration.md)を参照してください。

## セキュリティとプライバシー

[セキュリティポリシー](../policies/security.ja.md)と[プライバシーポリシー](../policies/privacy.md)を参照してください。

## ライセンス

MIT — [LICENSE](../../LICENSE) 参照。llama.cpp バイナリ — [NOTICE](../../NOTICE) 参照。
