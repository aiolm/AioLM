# AioLM

> **언어:** [English](../../README.md) | [한국어](overview.ko.md) | [日本語](overview.ja.md) | [中文](overview.zh.md)

[문서 목차](../README.md) — 설치, 사용 안내, 참고 문서, 보안·개인정보 정책을 모았습니다. 문서는 현재 소스를 기준으로 하므로 게시된 릴리스에는 최신 변경이 아직 포함되지 않았을 수 있습니다.

AioLM(All-in-One LM)은 추론 엔진이 아니라 모델·런타임·채팅·벤치마크를 관리하는 Windows/macOS/Linux용 데스크톱 GUI 어댑터입니다. llama.cpp, Linux 및 Apple Silicon macOS(vllm-metal)의 vLLM, Apple Silicon macOS의 MLX와 다른 연결된 OpenAI 호환 엔진을 사용할 수 있습니다. 호환성과 제한 사항은 [추론 런타임](../reference/inference-runtimes.md)을 참고하세요.

고정 출력 벤치마크(`openai-chat-serving@2`)는 출력 길이 제어와 스트리밍 출력 토큰 수 보고를 지원하는 엔진에서 실행합니다. 요청마다 선택한 N개 토큰이 보고되어야 성공이며, 조기 종료나 확인 불가는 실패로 처리합니다. 선택지는 1k·4k·8k·16k·32k·64k·128k·200k이며 1k=1,024입니다. 기본값은 입력 UTF-8 4096/16384 bytes, 출력 1k, 동시성 1/2/4, 반복 1회, 워밍업 켜짐입니다. 실행 프로필과 컨텍스트는 변경하지 않으므로 큰 출력은 모델과 각 병렬 슬롯에 충분한 컨텍스트가 필요합니다. 기존 `@1` 기록은 상한 방식 그대로 조회·내보내기·공유할 수 있습니다. [벤치마크 안내](../reference/benchmarks.md)를 참고하세요.

모델 로드와 API 서버 실행은 독립적입니다. 모델을 로드하면 앱 내부 채팅에서
사용할 수 있고, 외부 앱에서 연결하려면 사이드바의 **API 서버**에서 서버를
별도로 시작한 뒤 URL·키·모델 ID를 복사하고 OpenAI 또는 Anthropic 예제를
고릅니다. 모델을 교체하거나 메모리에서 해제해도 API 서버는 유지되며,
API 서버를 중지해도 로드된 모델과 내부 채팅은 유지됩니다.
[API 서버 사용 안내](local-api.md)를 참고하세요.

## 작업 공간

- **작업 공간:** 대화와 프로젝트.
- **모델 운영:** 라이브러리, 찾아보기, 추론 엔진 관리, 벤치마크.
- **연동:** API 서버와 MCP 서버.
- **앱:** 설정.

데스크톱 사이드바는 아이콘 rail로 접을 수 있고, 좁은 창에서는 탐색 drawer를 사용합니다. 화면·테마·밀도·글꼴을 바꿔도 열린 화면의 draft는 유지됩니다. 상단 바는 기본 실행 대상을, 대화 헤더의 항상 보이는 세션 선택은 그 대화에 답할 세션을 제어합니다. worker 선택으로 기본 실행 대상이 바뀌지는 않습니다. 검색용 임베딩과 오디오·비디오 전처리는 대화 설정 안에 있습니다.

모델 설정은 **런타임 선택 → 프로필 선택 → 옵션 조정** 순서입니다. 다운로드·미리보기는 실행이 아니며, 프로필 저장과 실행은 별도 행동입니다. 프로젝트도 저장과 저장된 설정 적용을 구분합니다. 테마와 글꼴은 **설정 → 화면**, 밀도는 **일반**에서 바꿉니다.

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

**찾아보기**(Hugging Face Discover)는 기본적으로 모든 형식의 저장소를 **인기 급상승순(Trending)**으로 보여 주며, 필요하면 GGUF·safetensors·MLX 필터로 좁힐 수 있습니다. 검색 결과에 보인다고 해서 다운로드나 실행을 지원한다는 뜻은 아닙니다. 앱은 GGUF와 완전한 safetensors/MLX 모델 묶음을 다운로드합니다. Safetensors 가중치를 파일별로 선택하면 해당 모델의 설정·토크나이저와 필요한 분할 조각을 함께 받고, 다른 모델·양자화 가중치는 제외합니다. 기존 전체 모델 다운로드도 유지됩니다. 다른 형식은 해당 형식을 지원하는 외부 엔진에서 사용할 수 있습니다. 찾아보기는 추론 엔진을 고르거나 우선하지 않습니다.

로드된 모델의 세션 작업, 로그, 실행 설정은 **라이브러리**에서 확인합니다. 별도의 진단·세션 페이지는 없습니다.

앱에서 다운로드한 모델은 **라이브러리**에서 업데이트를 확인하며, 변경 사항이 확인된 모델에만 **업데이트** 버튼이 표시됩니다. 변경되지 않은 파일은 재사용하고 변경·추가된 파일만 다운로드하므로 기존 모델 경로와 설정은 유지됩니다. 파일 단위 업데이트이므로 단일 GGUF 파일 자체가 변경되면 그 파일은 전체 다운로드가 필요합니다. 업데이트 전에 모든 모델 세션을 중지하세요.

모델 설정 창의 런타임 선택 또는 런타임·GPU 옵션에서 **추론 엔진 관리**를 누르면 선택한 엔진과 관계없이 **전체 추론 엔진 목록**이 열립니다. 관리 페이지에서 특정 엔진을 보고 있었더라도 전체 목록으로 이동합니다. **모델 설정으로 돌아가기**를 누르면 미저장 옵션과 선택한 엔진·런타임을 유지한 채 돌아옵니다. **추론 엔진**은 llama.cpp·vLLM·MLX 같은 엔진의 종류, **런타임**은 설치된 실행 환경을 뜻합니다.

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
