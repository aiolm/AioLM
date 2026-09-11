# AioLM

> **言語:** [English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md)

`llama.cpp` 用 Windows デスクトップランタイムマネージャー。`llama-server` / `llama-bench` を Tauri v2 デスクトップ UI でラップし、モデル、ランタイム、チャット、ベンチマークを管理します。

## 機能

- GGUF モデルの探索と安全な管理
- ランタイム管理（CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO）とポータブル ZIP 対応
- 番号/URL による PR ビルドと来歴レビュー
- ストリーミングチャット、ローカルスレッド、ドキュメントコンテキスト、埋め込み
- プロジェクト、Hugging Face Discover、開発者/MCP ゲートウェイ
- サーバー/サンプリングチューニング

調整画面の **すべての調整をリセット** でサーバー引数とチャット JSON を含む指定値を削除でき、各項目の **既定値に戻す** で個別に戻せます。推奨プリセットの固定値ではなく、選択した llama.cpp ランタイム・モデルの既定値を使います。**値を指定** で再入力でき、既定値の使用状態もプロファイルに保存されます。モデルファイル、アダプター、GPU 配置、ランタイム、保存済みプロファイルは維持されます。サーバー設定は再起動後に反映され、コンテキストとメモリ使用量が変わる場合があります。

## プラットフォーム対応

現在は Windows x64 をサポートしています。**Linux（NVIDIA DGX を含む）および macOS 対応を予定**しています。Linux/macOS は `curl | tar`、Windows は `NSIS`/`MSI` を使用します。Windows リリースインストーラーは SignPath Foundation のオンボーディングと手動承認後、GitHub ホスト型 CI から Authenticode で署名されます。公開された署名と SHA-256 チェックサムを確認してください。

## ダウンロード

最新リリースは [GitHub Releases](https://github.com/llama-board/llama-board/releases) から取得してください。

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/llama-board/llama-board/releases/latest/download/install.ps1 | iex"
```

高度なインストールオプション、検証、開発環境、CLI の使い方は [docs/INSTALL.ja.md](docs/INSTALL.ja.md)、[docs/DEVELOPMENT.ja.md](docs/DEVELOPMENT.ja.md)、[docs/CLI.ja.md](docs/CLI.ja.md) を参照してください。

AioLM — All-In-One LMはllama-boardとは別にインストールされます。初回起動時に設定、管理ランタイム、CLIデータ、WebViewプロファイルを新しい `aiolm` / `com.aiolm.desktop` の場所へコピーします。元のデータは保持され、既存のAioLMデータが優先されます。移行前に旧アプリを終了してください。ロックや容量不足は解消後に再試行できます。[移行の詳細](docs/MIGRATION.md)。

## コード署名ポリシー (Code signing policy)

[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) と [PRIVACY.md](PRIVACY.md) で、署名範囲、役割、リリース承認、プライバシー、アンインストール方針を確認できます。

## セキュリティ

[SECURITY.ja.md](SECURITY.ja.md) を参照してください。

## ライセンス

MIT — [LICENSE](LICENSE) 参照。llama.cpp バイナリ — [NOTICE](NOTICE) 参照。

