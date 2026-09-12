# AioLM

> **언어:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[문서 목차](../README.md) — 설치·개발 가이드, 코드 구조, 프로젝트 정책을 모았습니다.

`llama.cpp`용 Windows 데스크톱 런타임 매니저. `llama-server` 기반의 Tauri v2 데스크톱 UI에서 모델, 런타임, 채팅, 벤치마크를 관리합니다.

## 기능

- GGUF 모델 탐색 및 안전한 관리
- 런타임 관리(CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO)와 휴대용 ZIP 지원
- 번호/URL로 PR 빌드 및 출처 리뷰
- 스트리밍 채팅, 로컬 스레드, 문서 컨텍스트, 임베딩
- 프로젝트, Hugging Face Discover, 개발자/MCP 게이트웨이
- 서버/샘플링 튜닝

튜닝 화면의 **튜닝 전체 초기화**로 모든 지정값(서버 인자·채팅 JSON 포함)을 제거하거나, 각 항목의 **기본값으로 초기화**로 하나씩 되돌릴 수 있습니다. 고정된 추천 숫자를 넣는 대신 선택한 llama.cpp 런타임·모델의 기본값을 사용합니다. **직접 설정**으로 다시 값을 입력할 수 있으며, 이 기본값 사용 상태도 프로필에 저장됩니다. 모델 파일·어댑터·GPU 배치·런타임·저장된 프로필은 초기화하지 않습니다. 서버 설정은 **적용 및 재시작** 후 반영되며 기본 컨텍스트 크기와 메모리 사용량은 런타임·모델에 따라 달라질 수 있습니다.

## 플랫폼 지원

현재 Windows x64를 지원합니다. **Linux(NVIDIA DGX 포함) 및 macOS 지원을 계획 중**입니다. Linux/macOS는 `curl | tar`, Windows는 `NSIS`/`MSI`를 사용합니다. Windows 인스톨러는 GitHub 호스팅 CI에서 빌드하며, 미서명 파일과 SHA-256 체크섬을 함께 배포합니다.

## 다운로드

최신 릴리스는 [GitHub Releases](https://github.com/joowon-jang/AioLM/releases)에서 받으세요.

고급 설치 옵션, 검증, 개발 환경, CLI 사용법은 [install.ko.md](install.ko.md), [development.ko.md](development.ko.md), [cli.ko.md](cli.ko.md)를 참조하세요.

기존 데이터 이전과 호환성은 [마이그레이션 가이드](../reference/migration.md)를 참고하세요.

## 보안 및 개인정보

[보안 정책](../policies/security.ko.md)과 [개인정보 정책](../policies/privacy.md)을 참고하세요.

## 라이선스

MIT — [LICENSE](../../LICENSE) 참조. llama.cpp 바이너리 — [NOTICE](../../NOTICE) 참조.
