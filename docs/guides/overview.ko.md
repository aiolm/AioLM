# AioLM

> **언어:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[문서 목차](../README.md) — 설치, 사용 안내, 참고 문서, 보안·개인정보 정책을 모았습니다. 문서는 현재 소스를 기준으로 하므로 게시된 릴리스에는 최신 변경이 아직 포함되지 않았을 수 있습니다.

AioLM(All-in-One LM)은 추론 엔진이 아니라 모델·런타임·채팅·벤치마크를 관리하는 Windows/macOS/Linux용 데스크톱 GUI 어댑터입니다. llama.cpp, Linux 및 Apple Silicon macOS(vllm-metal)의 vLLM, Apple Silicon macOS의 MLX와 다른 연결된 OpenAI 호환 엔진을 사용할 수 있습니다. 호환성과 제한 사항은 [추론 런타임](../reference/inference-runtimes.md)을 참고하세요.

연결된 모든 텍스트 스트리밍 엔진은 같은 API 벤치마크(`openai-chat-serving@1`)와 이력·내보내기·공유·관리를 사용합니다. 시간과 출력 bytes는 클라이언트 관측값이며 토큰·캐시 카운터는 엔진 자체 보고값으로, 없으면 미확인입니다. 입력 UTF-8 bytes는 토큰 수가 아니며 최대 출력 token 요청은 강제 생성 길이가 아닙니다. 실행 프로필은 보존하고 캐시는 설정된 상태로 측정하므로 cold-cache를 보장하지 않습니다. 기본값은 입력 4096/16384 bytes, 출력 상한 128 tokens, 동시성 1/2/4, 반복 1회, 워밍업 켜짐, 선택적 usage 요청 꺼짐입니다. [벤치마크 안내](../reference/benchmarks.md)를 참고하세요.

모델 로드와 API 서버 실행은 독립적입니다. 모델을 로드하면 앱 내부 채팅에서
사용할 수 있고, 외부 앱에서 연결하려면 사이드바의 **API 서버**에서 서버를
별도로 시작한 뒤 URL·키·모델 ID를 복사하고 OpenAI 또는 Anthropic 예제를
고릅니다. 모델을 교체하거나 메모리에서 해제해도 API 서버는 유지되며,
API 서버를 중지해도 로드된 모델과 내부 채팅은 유지됩니다.
[API 서버 사용 안내](local-api.md)를 참고하세요.

## 기능

- Hugging Face 모델 검색(GGUF·safetensors·MLX 형식 필터 선택 가능)과 안전한 모델 관리
- 엔진별 설정 프로필, 실행 옵션, 멀티모달 입력(추론 엔진은 모델 설정에서 선택)
- 추론 엔진 관리(CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO 런타임 설치·관리)와 휴대용 ZIP 지원
- 번호/URL로 PR 빌드 및 출처 리뷰
- 스트리밍 채팅, 로컬 스레드, 문서 컨텍스트, 임베딩
- 사용자 AGENTS.md 지침, 로컬 스킬, 앱 내 개인화 편집기([채팅 개인화](../reference/personalization.md))
- 프로젝트, API 서버, MCP 서버
- 외부 추론 엔진 연결([자동 엔진 연결](../reference/automatic-engine-connections.md))
- 서버/샘플링 튜닝
- 시작 시 새 버전 알림과 설정에서 검증된 설치 파일로 업데이트

**찾아보기**(Hugging Face Discover)는 기본적으로 모든 형식의 저장소를 **인기 급상승순(Trending)**으로 보여 주며, 필요하면 GGUF·safetensors·MLX 필터로 좁힐 수 있습니다. 검색 결과에 보인다고 해서 다운로드나 실행을 지원한다는 뜻은 아닙니다. 앱 내 다운로드는 GGUF 파일과 완전한 safetensors 스냅샷만 처리하며, 다른 형식은 해당 형식을 지원하는 외부 엔진에서 사용할 수 있습니다. 찾아보기는 추론 엔진을 고르거나 우선하지 않습니다.

로드된 모델의 세션 작업, 로그, 실행 설정은 **모델 관리**에서 확인합니다. 별도의 진단·세션 페이지는 없습니다.

모델 실행 모달의 런타임 선택 또는 런타임·GPU 옵션에서 기존 **추론 엔진 관리**를 누르면 선택한 엔진과 관계없이 **전체 추론 엔진 목록**이 열립니다. 관리 페이지에서 특정 엔진을 보고 있었더라도 전체 목록으로 이동합니다. **모델 설정으로 돌아가기**를 누르면 미저장 옵션과 선택한 엔진·런타임을 유지한 채 돌아옵니다. **추론 엔진**은 llama.cpp·vLLM·MLX 같은 엔진의 종류, **런타임**은 설치된 실행 환경을 뜻합니다.

설정 프로필과 실행 옵션은 [모델 선택과 설정](../reference/model-settings.md)과 [서버 옵션](../reference/server-options.md)(영문)을 참고하세요.

## 플랫폼 지원

Windows x64, macOS 13.3 이상(Apple Silicon·Intel), Linux x86_64(Ubuntu 24.04 이상) 빌드를 사용할 수 있습니다. Windows는 NSIS/MSI, macOS는 DMG, Linux는 DEB/AppImage 형식입니다. **v0.2.1부터 Linux 패키지도 배포합니다.** [Linux 설치 가이드](install.ko.md#linux)에서 설치 방법을 확인하세요. macOS 13.3 이상용 Apple Silicon(Metal)·Intel(CPU) DMG는 **v0.3.0**부터 배포하며, ad-hoc 서명만 있고 공증되지 않았습니다. [macOS 설치](install.ko.md#macos)를 참고하세요. Linux ARM64와 NVIDIA DGX 환경은 아직 확인되지 않았습니다. 릴리스 파일은 미서명이며 SHA-256 체크섬을 제공합니다. 체크섬은 다운로드한 파일이 릴리스 목록과 같은지 확인할 뿐 게시자를 보증하지는 않습니다.

## 다운로드

[Linux: DEB / AppImage](install.ko.md#linux)

Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

또는 [GitHub Releases](https://github.com/aiolm/AioLM/releases)에서 최신 인스톨러를 직접 받을 수 있습니다.

고급 설치 옵션과 다운로드 검증은 [설치 가이드](install.ko.md), 직접 빌드하는 방법은 [소스에서 빌드](install.ko.md#소스에서-빌드), CLI 사용법은 [cli.ko.md](cli.ko.md)를 참고하세요.

기존 데이터 이전과 호환성은 [마이그레이션 가이드](../reference/migration.md)를 참고하세요.

## 보안 및 개인정보

[보안 정책](../policies/security.ko.md)과 [개인정보 정책](../policies/privacy.md)을 참고하세요.

## 라이선스

MIT — [LICENSE](../../LICENSE) 참조. llama.cpp 런타임과 Linux AppImage 런타임을 포함한 제3자 고지 — [NOTICE](../../NOTICE) 참조.
