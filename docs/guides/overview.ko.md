# AioLM

> **언어:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[문서 목차](../README.md) — 설치·개발 가이드, 코드 구조, 프로젝트 정책을 모았습니다.

AioLM(All-in-One LM) — `llama.cpp`용 Windows/macOS/Linux 데스크톱 런타임 매니저. `llama-server` 기반의 Tauri v2 데스크톱 UI에서 모델, 런타임, 채팅, 벤치마크를 관리합니다.

모델 로드와 API 서버 실행은 독립적입니다. 모델을 로드하면 앱 내부 채팅에서
사용할 수 있고, 외부 앱에서 연결하려면 사이드바의 **API 서버**에서 서버를
별도로 시작한 뒤 URL·키·모델 ID를 복사하고 OpenAI 또는 Anthropic 예제를
고릅니다. 모델을 교체하거나 메모리에서 해제해도 API 서버는 유지되며,
API 서버를 중지해도 로드된 모델과 내부 채팅은 유지됩니다.
[API 서버 사용 안내](local-api.md)를 참고하세요.

## 기능

- GGUF 모델 탐색 및 안전한 관리
- 런타임 관리(CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO)와 휴대용 ZIP 지원
- 번호/URL로 PR 빌드 및 출처 리뷰
- 스트리밍 채팅, 로컬 스레드, 문서 컨텍스트, 임베딩
- 프로젝트, Hugging Face Discover, API 서버, MCP 서버
- 서버/샘플링 튜닝

튜닝 화면의 **튜닝 전체 초기화**로 모든 지정값(서버 인자·채팅 JSON 포함)을 제거하거나, 각 항목의 **기본값으로 초기화**로 하나씩 되돌릴 수 있습니다. 고정된 추천 숫자를 넣는 대신 선택한 llama.cpp 런타임·모델의 기본값을 사용합니다. 입력란은 기본값 상태에서도 바로 수정할 수 있으며, 값을 바꾸면 해당 항목만 사용자 설정으로 전환됩니다. 기본값 사용 상태도 프로필에 저장됩니다. 모델 파일·어댑터·GPU 배치·런타임·저장된 프로필은 초기화하지 않습니다. 서버 설정은 **적용 및 재시작** 후 반영되며 기본 컨텍스트 크기와 메모리 사용량은 런타임·모델에 따라 달라질 수 있습니다.

## 플랫폼 지원

Windows x64, macOS 13.3 이상(Apple Silicon·Intel), Linux x86_64(Ubuntu 24.04 이상) 빌드를 사용할 수 있습니다. Windows는 NSIS/MSI, macOS는 DMG, Linux는 DEB/AppImage 형식입니다. **v0.2.1부터 Linux 패키지도 배포합니다.** [Linux 설치 가이드](install.ko.md#linux)에서 설치 방법을 확인하세요. macOS 13.3 이상용 Apple Silicon(Metal)·Intel(CPU) DMG는 **v0.3.0**부터 배포하며, ad-hoc 서명만 있고 공증되지 않았습니다. [macOS 설치](install.ko.md#macos)를 참고하세요. Linux ARM64/NVIDIA DGX 검증은 남아 있습니다. [플랫폼별 검증 절차](../reference/cross-platform-validation.md)를 참고하세요. 릴리스 파일은 미서명이며 SHA-256 체크섬을 제공합니다.

## 다운로드

[Linux: DEB / AppImage](install.ko.md#linux)

Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

또는 [GitHub Releases](https://github.com/aiolm/AioLM/releases)에서 최신 인스톨러를 직접 받을 수 있습니다.

고급 설치 옵션, 검증, 개발 환경, CLI 사용법은 [install.ko.md](install.ko.md), [development.ko.md](development.ko.md), [cli.ko.md](cli.ko.md)를 참조하세요.

기존 데이터 이전과 호환성은 [마이그레이션 가이드](../reference/migration.md)를 참고하세요.

## 보안 및 개인정보

[보안 정책](../policies/security.ko.md)과 [개인정보 정책](../policies/privacy.md)을 참고하세요.

## 라이선스

MIT — [LICENSE](../../LICENSE) 참조. llama.cpp 바이너리 — [NOTICE](../../NOTICE) 참조.
