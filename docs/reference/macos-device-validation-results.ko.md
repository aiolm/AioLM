# Mac 기기 검증 결과

[Mac 기기 작업 인계](macos-device-handoff.ko.md)의 M01–M12 후속 기록이다. **전체 기기 검증은 통과하지 않았다.** 공통 자동 검사, 세 엔진의 실제 추론·offline bundle 왕복, 실제 WKWebView 파일 선택·미디어·프로젝트·GUI 프로필 이전, arm64 DMG 생성과 재현 결함 수정은 완료했다. upstream 오류와 아래의 차단·미실행 범위는 남아 있다.

## 1. 소스·환경·근거

- 실행일: 2026-10-07–08 (Asia/Seoul). 기준 소스: `11996aa26b326164ef97f7ba005438f05c30891d`.
- 브랜치: `codex/macos-device-validation`. 초기 기기 검증·패키지 소스: `6261d0b`. 개발 앱 채팅 후속 수정: `2e63118`이며 11절에 별도로 기록한다. 추가 채팅·프로젝트·레이아웃 수정 `0424ab5`와 재검증은 12절, 이를 포함한 최종 DMG는 13절에 기록한다. 수정 커밋은 아래 표에 기록한다. 원격 push는 수행하지 않았다.
- 기기: macOS 26.6.2 / native arm64 / Apple M2 / 16 GB.
- 작업용 도구: Node 22.23.2, npm 12.0.2, Rust 1.98.0/rustfmt/clippy, CMake 4.4.4, CPython 3.12.15 arm64. 기존 ffmpeg 8.1.2를 사용했다.
- 도구·캐시·설정은 작업용 경로에 설치했다. 기존 시스템 설정과 lockfile을 보존했다. 자동 검사·CLI·앱의 HOME과 legacy 경로를 격리했다. 별도 OS 계정의 최초 실행을 대신한 검사는 아니다.
- 앱 검사는 `macos-ui-smoke` debug 빌드의 실제 Tauri WKWebView·IPC·W3C WebDriver 및 CUA 네이티브 조작이다. production DMG의 자연스러운 Finder 설치 실행은 unrun이다.
- raw 로그·모델·번들·캡처·검사 도구는 Git 제외 대상 `tmp/macos-acceptance/`에 보관했다. 아래 근거 파일은 이 디렉터리 기준이며 `checks.jsonl`에 명령·종료 코드·소요 시간을 기록했다. 자체 검사에서 반환한 보존 홈은 `retained-homes/`에 복사했다.
- 이 문서와 패키지에는 개인 경로·계정/기기 식별자·생성 런타임 ID·API 키를 넣지 않았다. hosted runner 조건을 위조하지 않았고 공개 benchmark 서비스 업로드도 수행하지 않았다.

## 2. 재현 결함과 수정

| 커밋 | 재현과 변경 | 수정 후 근거 |
| --- | --- | --- |
| `3523a87` | macOS 버전 감지·프로필 fixture의 clippy 오류 수정. snapshot 테스트의 symlink된 임시 조상을 제품과 같은 canonical root로 맞춤. | 전체 Rust/clippy 통과. 하위 경로 허용과 symlink 거부 유지. |
| `6ef0b8f` | StrictMode 정리 후 Discover 첫 검색이 pending에 고정됨. effect 상태 초기화. 작은 창에서 고정 영역이 본문을 32 px로 축소하여 높이·스크롤 조정. | 회귀 검사 및 실제 검색→다운로드→실행. 3 엔진×3 창 크기에서 본문 최소 122 px. |
| `fbb557d` | acceptance harness가 CLI 재시작 중 pooled socket을 재사용해 정상 서버에 ECONNRESET을 냄. 요청마다 새 socket 사용. | 같은 포트 재시작/SSE/usage 검사와 실제 Metal 취소·재시작. 제품 서버 결함과 구분. |
| `c2236d0` | mlx-vlm 0.7.6이 CLI 처리 전에 RuntimeConfig를 import하여 실제 KV 예산이 비었음. 검증한 값을 launch 환경에도 전달. | CLI/env/unset 회귀 검사. 실제 settings/KV/APC/reset과 workload 완료. |
| `f414544` | 선언된 root console script `mlx_lm`을 portable export가 외부 파일로 거부. 선언된 entry point만 제외·설치 시 재생성. | 임의 prefix/다른 디렉터리/absolute 경로 거부 유지. 실제 174-wheel export/import/추론. |
| `c21fb34` | WKWebView의 프로젝트 JSON download 링크와 file input이 OS Save/Open 창을 열지 못함. native export/import IPC 추가, 4 MiB 제한·UTF-8/BOM/JSON 검사·atomic write·취소 처리. | UI 2개/Rust 3개 회귀 검사. 실제 OS Save/Open·취소와 프로젝트 왕복. browser fallback 유지. |
| `94d9d08` | export가 숫자 `max_tokens`를 자격 증명처럼 가려 import 후 실제 HTTP400 발생. 유한한 네 생성 예산 키만 보존. New chat 초기화가 공용 프로젝트 문서를 지우는 문제도 수정. | credential redaction 유지·direct 검사. 빈 draft 재사용/프롬프트/새 thread 회귀 검사. 실제 새 대화 자동 문서 첨부와 ORBIT-73 응답. |
| `d7290b0` | native deep 취소가 Unsupported로 저장되어 기존 pass를 덮어씀. cleanup 후 cancellation 확인, 취소 결과는 persist하지 않음. | 취소/실제 Unsupported 저장 회귀 검사. 실제 CPU·Metal 비교 자식 각각 취소, 이전 cache 바이트 불변. |
| `e05d642` | 동일 모델의 두 임베딩 후보 이름이 같아 명시적 대상을 구분할 수 없음. 표시 이름에 세션 ID 추가. | 같은 이름/모델의 두 후보 회귀 검사. 실제 WKWebView에서 지정한 세션의 URL·768차원 벡터 확인. |
| `6261d0b` | 실행 중 named session이 참조하는 split GGUF의 후속 shard를 삭제할 수 있었음. 저장된 primary/draft/projector와 실행 세션의 각 binding에 전체 shard 보호를 적용. 첫 조각 부재·symlink alias도 처리. | 저장 선택/실행 세션/alias 회귀 검사 3개. 실제 공개 3-shard 모델의 세 번째 조각 삭제 재현·복구 후, 수정된 앱에서 선택 보호 및 별도 세션 보호 거부·원본 해시 불변. |
| `2e63118` | vllm-metal에서 템플릿 없는 base GGUF가 로드되지만 채팅 HTTP400이 발생. completion과 chat 기능을 구분하는 선택적 `EngineInfo.chat_supported` 추가, composer 안내·입력 보존·전송 차단 및 gateway 오류 코드 제공. | 합성 회귀 검사 7개, 실제 GGUF completion200/chat 거부와 같은 Metal 런타임의 Instruct UI 답변·gateway200/usage. 11절 참조. |
| `0424ab5` | 최종 SSE 측정값과 실행 모델 이름이 누락되고 작은 창에서 답변·첨부가 가려짐. 채팅 지표·모델 식별·스크롤·picker 배치를 수정했다. 프로젝트 저장 실패·문서 읽기, 대화 hydration·첨부 순서, MCP 도구 선택·오류 보존도 수정했다. | 실제 Metal 새 한국어 답변·PP/TG, 33개 WKWebView 화면, 프로젝트 실패/재시도, Provider HMR, MCP 오류 보존과 관련 합성 회귀 검사. 12절 참조. |

gateway 요청 형식·benchmark 계약·엔진/프로필 정책을 유지했다. 재현 결함 해결을 위해 프로젝트 네이티브 파일 IPC 두 개와 선택적 채팅 기능 정보를 추가했다. 채팅 기능 정보가 없는 기존 기록은 기존 동작을 유지한다. 플랫폼 공통 계약을 회귀 검사했으며, 이번에 Windows/Linux 실기기를 새로 검증한 것으로 해석하지 않는다. 해시 무시·readiness 제거·실패 skip·근거 없는 timeout 확대로 통과시키지 않았다.

## 3. M01–M12 판정

항목의 하위 성공을 전체 통과로 확대하지 않는다. `unsupported`는 실제 확인한 미지원 하위 검사, `unrun`은 필요한 여정의 미실행, `blocked`는 현재 계정/조작 수단의 차단이다. `fail`에는 미해결 실제 실패가 포함된다.

| ID | 상태 | 실행 근거와 남은 범위 |
| --- | --- | --- |
| M01 | pass | 지정 도구/native arm64, TypeScript·linter·단위·frontend/CLI/native build, Rust 전체 타깃/feature, Python·CLI·합성 harness. 실제 Unix socket/process/symlink/권한 검사. |
| M02 | pass | 고정 GGUF CPU→Metal probe·추론/usage·취소·재시작·중지, CPU/Metal source-build. 실제 CMake 자식 취소와 기존 설치/staging 보호. |
| M03 | fail | 별도 관리형 Metal 설치·ABI/MetalPlatform/native extension·텍스트/이미지/STT/embedding·취소·재시작·외부 환경 보호. 직접 file URI 이미지 요청은 upstream500. |
| M04 | fail | 별도 MLX probe·텍스트/이미지/native 영상·취소·재시작·외부 환경 보호. 직접 URI500. Gemma3n 오디오는 고정 upstream snapshot의 누락 shard index 때문에 preflight 실패. |
| M05 | pass | 11 메뉴×3 엔진·공용 프로필·3 창 크기, GUI v12→v13/두 번째 이전/backup 불변. 설치된 flag별 호환 옵션 UI, 실제 OS LoRA 선택→draft-simple→공용 프로필 저장/시작→응답/usage, MLX embedding-only 및 잘못된 binding 거부 확인. 임의의 모든 옵션 순열을 검증한 의미는 아님. |
| M06 | pass | 실제 snapshot 취소/재시도, 고정 GGUF, 공개 3-shard 전체 GUI 다운로드/해시/한 항목/CPU 추론, 두 GGUF와 공유 companion 다운로드/재사용·다른 primary 삭제 후 보존. 활성/선택 draft·LoRA·named split 보호, 외부 파일·case-sensitive APFS·한글/공백·권한·FAT 불완전 상태 확인. |
| M07 | fail | OS 이미지/WAV/MP4 선택·내용/usage·immutable 기록/재로드·실패 후 Retry·엔진 변경, 명시적 STT/frames·ffmpeg UI Stop, 비-WAV Whisper 전사/번역·ASR 전사. URI500, native SmolVLM 내용 오답, Gemma3n upstream snapshot 실패 유지. ffmpeg 부재의 실제 앱 검사는 blocked. |
| M08 | blocked | 실제 문서 선택·프로젝트 native 왕복·자동 문서 첨부·벡터/keyword/명시적 후보 선택·멀티 세션·gateway 인증/라우팅/Responses·개인화 요청 확인. MCP 승인창·Cancel/quit 정리 통과. 별도 osascript Yes/No→실제 tool/후속 답변은 조작 차단. |
| M09 | pass | 세 엔진 tokenizer usage·cold-cache/KV·RSS/OS 대조·이력/native CSV/XLSX 저장/viewer. MLX/native Metal deep pass. vllm partial/Unsupported와 CPU-only 비교 Unsupported를 full pass로 계산하지 않음. 공개 서비스 upload 제외. |
| M10 | pass | 세 엔진 새 홈 offline export/import/probe·실제 추론, imported STT/embedding. 해시/ABI/arch/OS 오류·pip/native 취소·활성 모델 거부·기존 출력·외부 환경 보호. 직접 URI의 전체 harness 실패는 M03/M04/M07에 별도 기록. |
| M11 | blocked | 최종 arm64 DMG/GUI/CLI·버전/strict ad-hoc/해시/개인 경로 제외/새 홈 CLI 기본값. 실제 hide·2차 실행 restore·정상 quit, 파일/문서/JSON/CSV/XLSX picker·취소·한글 paste 확인. IME composition·clipboard Copy·Dock/트레이는 blocked/unrun. 별도 계정/Finder/Keychain/upgrade는 unrun. |
| M12 | blocked | `6261d0b`에서 실제 모델3/API 실행 중 normal Quit→소유 자식·5포트 정리/파일 보존/launcher exit0. pip/CMake/ffmpeg·준비/실제 loading replacement·3 엔진×warmup/single/batch·native deep CPU/Metal 취소 통과. 별도 진단 환경에서 MLX CPU/GPU 평가 진입을 각각 관찰 후 취소·job 정리/cache 불변. MCP 승인 후 실제 호출 중 취소는 승인창 조작 차단으로 미검증. |

## 4. 초기 기기 검증의 공통 자동 검사 (`6261d0b`)

| 명령 | 근거·상태 |
| --- | --- |
| `npm run typecheck`, `npm run lint` | pass — `logs/final-target-typecheck.log`, `logs/final-target-lint.log`. |
| `npm run test:unit` | pass — `logs/final-shard-unit.log`. 계약/direct/script 포함, UI 160 files / 1555 tests. coverage statements79.06% / branches73.84% / functions77.43% / lines83.2%. |
| `npm run build`, `npm run build:cli` | pass — 최종 packaging에서 production frontend/CLI 재빌드. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | pass — `logs/final-shard-fmt-check.log`. |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | pass — `logs/final-shard-clippy.log`. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | pass — `logs/final-shard-rust-all.log`. lib928 pass/4 ignored, CLI15 및 integration. ignored는 실행된 것으로 계산하지 않음. |
| native build, `npm run test:native-cli` | pass — native 빌드, `logs/final-shard-native-cli.log`. |
| Python provider unittest discovery | pass — 14개 `logs/final-python-all.log`, 3개 `logs/final-python-probe.log`. |
| `npm run test:provider-runtime` | pass — 28개와 synthetic loopback self-test, `logs/final-provider-harness.log`. 실모델 근거와 구분. |
| `npm run package:tauri` | pass — `logs/final-shard-package.log`. chunk 크기 경고는 남음. |

초기 sandbox의 socket bind/프로세스 권한 오류와 임시 검사 도구의 reload race·selector/동적 port/별칭·응답 완료 시점 오류도 원본 로그에 보존했다. 같은 검사를 실제 권한과 올바른 실제 상태로 재검증했다. 이를 제품 결함이나 성공으로 세지 않는다. staged diff·개인정보·공백을 확인하고 build/raw/tmp는 커밋하지 않았다.

## 5. 엔진과 고정 모델

| 엔진 | 실제 설치·probe |
| --- | --- |
| llama.cpp | native lifecycle 공식 b11459 CPU/Metal; source CPU/Metal `f07be9f37e5dd3e8bec895f6ffd8d86fd1bbc370`. 앱 CPU/bundle b11460 0.6.0/commit `78651c410`. 후속 공식 Metal b11461 0.6.0-dev/commit `4d756bc72`. 지정 옛 latest 설치가 정책상 거부된 원본도 보존. |
| vllm-metal | CPython3.12.15 arm64, distribution0.30.0+cpu/import0.30.0, plugin0.30.0, MLX0.32.1, nanobind2.10.2, mlx-vlm0.6.17, mlx-lm `9e6acca691e64d6d8bb808c328fcdea459099cca`. MetalPlatform·shipped `_paged_ops`·GPU·STT registry 확인, probe errors 없음. |
| mlx-vlm | 별도 CPython3.12.15 arm64, mlx-vlm0.7.6/MLX0.32.3. 실제 flag/loader/processor probe errors 없음. Metal 환경에 0.7.6을 덮어 설치하지 않음. |

설치된 loader/processor를 먼저 확인한 뒤 공개 repository 전체 revision을 다운로드 전에 고정했다. bytes는 실제 선택하여 받은 파일 합계다. provenance는 고정 Hub snapshot 경로 또는 `.aiolm-snapshot.json`으로 확인했다.

| 공개 출처·용도 | 전체 revision | 받은 bytes |
| --- | --- | ---: |
| `Qwen/Qwen2.5-0.5B-Instruct-GGUF` native | `9217f5db79a29953eb74d5343926648285ec7e67` | 491400032 |
| `mlx-community/Qwen2.5-0.5B-Instruct-4bit` text | `a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3` | 289598797 |
| `mlx-community/Qwen3-VL-2B-Instruct-4bit` vision/video | `9c4f5209e57b31f4b9dfba735de3fb983739c9cc` | 1798021605 |
| `openai/whisper-tiny` STT | `169d4a4341b33bc18d8881c4b69c2e104e1cc0af` | 155434424 |
| `intfloat/multilingual-e5-base` embedding | `d128750597153bb5987e10b1c3493a34e5a4502a` | 1134355035 |
| `Qwen/Qwen3-ASR-0.6B` STT | `5eb144179a02acc5e5ba31e748d22b0cf3e303b0` | 1880560703 |
| `ggml-org/SmolVLM-256M-Instruct-GGUF` model/projector | `b9e4379657e1450d04d02eec8e345667265b0a00` | 365086144 |
| `mlx-community/gemma-3n-E2B-it-4bit` native audio | `66e7276cfc589073b4f92ebed58c05301f990222` | 4502727070 |
| `Prasad12344321/Qwen2.5-0.5B-bnb-4bit-python` Q8_0/Q4_K_M·동일 repo companion | `eae6acf655ad41fb0583133783328ad7c9c339ca` | 944748678 |
| `ggml-org/models-moved` TinyStories15M Q8_0 공개 3-shard | `499bc8821c6b12b4e53c5bffcb21ec206f212d81` | 26671680 |
| `Prasad12344321/Qwen2.5-0.5B-bnb-4bit-python` PEFT LoRA·config·base config | `eae6acf655ad41fb0583133783328ad7c9c339ca` | 35238652 |

고정 Q4_K_M GGUF SHA256은 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`이며 기존 native 검사와 같다. SmolVLM Q8_0 model/projector SHA256은 각각 `2a31195d3769c0b0fd0a4906201666108834848db768af11de1d2cef7cd35e65`, `0802360aca1748f112ea510b8ff277c65b1361c8ef30ed89b83c9c7a60d08e96`다.

| 실제 실행 | 근거와 해석 |
| --- | --- |
| CPU/Metal/source lifecycle | `logs/native-cpu-live.log`, `logs/native-metal-live.log`, `logs/native-source-cpu.log`, `logs/native-source-metal.log`. Metal 25/25 layers offload, 실제 응답/usage·재시작/중지. |
| Metal/MLX text/vision | `metal-text-socket.json`, `mlx-text-live.json`, `mlx-vision-live.json`, `metal-vision-4096.json`, `metal-vision-content.json`. 알려진 이미지의 색/형태/순서 확인. HTTP200만으로 이해 성공을 판정하지 않음. |
| Metal 메모리 한계 | 기본 max_model_len262144의 KV 약28 GiB가 사용 가능 약8.48 GiB를 넘어 실패. 명시적4096에서 성공. 기본값을 기기 설정으로 바꾸지 않음. |
| STT/embedding | `metal-stt-live.json`, `qwen-asr-live.json`, `ui-stt-final-results.json`, `metal-embedding-live.json`. AIFF Whisper 전사/영어 번역200, ASR 정확한 전사200/번역 unsupported400. 768차원 유한 벡터·restart/stop. STT/embedding chat404는 unsupported. |
| 외부 등록 보호 | `external-protection-vllm.json`, `external-protection-mlx-vlm.json`. 별도 offline venv register/probe/remove 전후 모든 일반 파일 해시 일치. |
| native projector 내용 | `ui-native-projector-results.json`: 실제200/usage153+7=160. “rectangle and blue sphere”로 빨강/좌우/원 검증 실패. 작은 모델 정확성 실패로 기록, loader 성공과 구분. |
| Gemma3n upstream | `native-audio-pinned-metadata.json`, `gemma-alternative-preflight.json`, `ui-native-gemma-start-results.json`. 공식 index는 없는3개 shard를 가리키고 실제 repo에는 단일 가중치만 존재. 20개 대체 audio-capable E2B4bit 변형도 같은 문제. index를 삭제하거나 readiness를 우회하지 않음. |

직접 `file://` 이미지500은 upstream server 제한이다. gateway의400 `untrusted_media_path` 거부와 구분한다. Metal native 음성/영상 채팅은 해당 고정 plugin에서 unsupported이며 STT/명시적 preprocessing으로 처리한다.

## 6. 실제 WKWebView·파일·미디어·프로젝트

| 원본 근거 | 확인한 여정 |
| --- | --- |
| `ui-menu-results.json`, `ui-profile-results.json` | 11 메뉴×3 엔진, 모델 없이 공용 프로필 생성·런타임/모델 선택과 분리, 1280×800/800×600/360×520 실제 창. 최소 본문122 px 이상. |
| `ui-gui-migration-results.json`, `ui-gui-migration-profiles-results.json`, `ui-gui-migration-second-results.json` | CLI 선행 없는 GUI v12→v13. 세 ID/이름/revision/coverage/prompt/옵션/default/recent/적용 snapshot 보존. native 화면에서 세 엔진의 이전 프로필 표시·복사본 삭제 후 원본 전체 entry 동일. 두 번째8192값 이전에도 최초 backup 바이트 불변. 별도 계정 upgrade의 대체 검사는 아님. |
| Discover/GGUF/split | `ui-discover-results.json`, `logs/ui-discover-cold-fixed.log`, `logs/ui-gguf-download.log`, `ui-split-actual-results.json`. public snapshot 취소/재시도/실행, 고정 GGUF. 공식 split 도구로 같은 고정 모델을2조각으로 생성하여 한 항목 scan/첫 shard CPU 실제추론·Metal preflight 거부/기존 서버·활성/외부 파일 보호. 생성 split의 검사와 별개로, `public-split-pinned-metadata.json`, `ui-public-split-download-results.json`에서 공식 공개 TinyStories15M의 3조각 전체 network 다운로드→LFS 해시→단일 목록→CPU completion200/usage도 확인. |
| 실제 파일시스템 | `filesystem-device-results.json`. read-write case-sensitive APFS 이미지에서 다른 case 파일·한글/공백 GGUF 추론·symlink·외부 mount·permission-denied 확인. FAT32 hard-link 오류45와 complete=false manifest. 오류를 완료로 표시하지 않음. 임시 mount는 detach하고 이미지는 보존. 최대 파일명 길이 전체 검사는 아님. |
| 실제 companion/보호 | `ui-companion-download-results.json`, `ui-metal-companion-completion-results.json`, `ui-auxiliary-protection-results.json`. WKWebView 검색 엔진 변경은 답변 엔진을 유지하며 두 GGUF와 동일 repo config/tokenizer를 다운로드. LFS 해시 일치·완료 파일 재사용. Metal completion200/usage. 다른 primary 삭제 후 나머지 primary/공유 companion 모든 해시 보존. base tokenizer의 chat template 부재로 chat400인 원본도 별도 유지. |
| 실제 draft/LoRA/MLX embedding | `ui-real-draft-results.json`, `public-lora-input.json`, `ui-auxiliary-protection-results.json`, `ui-mlx-embedding-options-results.json`. 같은 고정 GGUF 복사본 draft 실제 추론/usage·활성/선택 삭제 거부. 공개 PEFT LoRA를 고정 공식 llama.cpp source 변환기로17,619,680-byte GGUF 변환·native 로드/응답9+15=24usage, 활성/선택 adapter 보존. MLX 실제 --embedding-model/--model 없음·768 유한 vectors, 중복 embedding/draft binding 거부 후 기존 PID 유지. |
| 실제 GUI 복합 옵션 | `ui-actual-native-combination-results.json`, `ui-final-supported-options-results.json`, `ui-real-option-schemas.json`. native OS LoRA picker와 draft 선택→draft-simple→새 공용 프로필→UI Save/start→실제 응답/usage36+20=56. primary model/runtime은 프로필 밖이며 draft/LoRA 보조 binding은 기존 정책상 프로필에 포함 가능. 설치된 Metal의 tensor/pipeline parallel·CPU offload 미노출, MLX embedding-only 및 auxiliary/advanced UI 확인. |
| 공개 split 삭제 결함 | `ui-named-split-protection-results-before-shard-fix.json`, `ui-named-split-recovery.json`, `ui-named-split-protection-results.json`. 실제 named session의 후속 shard 삭제가 허용된 결함을 재현. 작업용 백업에서 복구·중지 후 수정 빌드에서 선택된 전체 shard 보호와 별도 실행 세션 보호를 각각 검증. 세 번째 shard SHA256 불변. |
| native image/audio/video | `ui-image-history-record.json`, `ui-audio-history-audio.json`, `ui-video-history-video.json`, `ui-media-native-reloaded.json`. 실제 OS 선택→immutable store→이미지 내용/선택 Whisper 전사/frames 시각→실제 답변→기록/reload. 원본 reference·준비된 전사/프레임·선택 답변 모델 보존. 원본 파일 경로를 image/audio/video history에 저장하지 않음. |
| 독립 native video | `ui-native-video-clean-history.json`, `ui-native-video-clean.png`. 문서·이전 메시지 없는 Qwen3-VL 새 대화에서 video kind로 native 전달하고 빨간 사각형 왼쪽/파란 원 오른쪽 확인. 초기 문서가 정답을 포함한 결과는 내용 이해 근거에서 제외. 음성 track 이해로 확대하지 않음. |
| Retry/engine 변경 | `ui-media-engine-change-results.json`, `ui-media-retry-phase-results.json`. MLX→Metal 변경 후 원본/프레임 reference 그대로 실제 내용 확인. 준비된 HTTP 요청 직전 자체 fixture가 앱 소유 model group만 종료: 실제 연결 실패/Retry last message→실제 restart→동일 messages 재전송·내용 성공. 엔진 응답을 합성하지 않음. 역사에 저장된 prepared frames 재사용 범위다. |
| ffmpeg/미지원 입력 | `ui-ffmpeg-cancel-results.json`, `ui-ffmpeg-stop-real-results.json`. 실제 ffmpeg와 staging 관찰→IPC cancel 및 OS 첨부 long video의 UI Stop→자식 종료/원본 불변/부분 대화 없음. Metal에서 전처리 opt-in 전 영상은 설명 있는 거부, 동의 후 프레임 경로 허용. |
| 문서/project native | `ui-native-document-history.json`, `ui-project-native-roundtrip-results.json`, `ui-project-autoload-history.json`. OS Markdown 선택→ORBIT-73·source→reload. 프로젝트 생성/문서 binding/Save/Open/각Cancel·JSON 왕복, 숫자 budget 보존, 새 대화 자동 문서 첨부·실제 CPU 응답. |
| RAG/개인화 | `ui-rag-results.json`, `ui-embedding-target-label-results.json`, `ui-personalization-actual.json`, `ui-personalization-outgoing.json`. 실제768차원 vectors/namespace/keyword와 두 후보의 이름·명시적 URL 선택/답변 모델 보존. 합성 AGENTS2개·내부 symlink skill 내용이 실제 system request에 포함. 폴더 밖 symlink는 거부. 작은 모델이 첫 비유도 응답에서 instruction code를 모두 따르지 않은 결과는 보존. 요청 포함 성공과 모델 순응 정확성을 구분. |
| gateway/MCP/창 | `ui-gateway-results.json`, `ui-mcp-cancel-results.json`, `ui-window-results.json`, `ui-final-quit-results.json`. 401/인증200/없는alias404/모호alias400·멀티 세션·503/API독립수명·Responses continuation, 실제 MCP schema/승인창/Cancel·tool 미전송, hide/2차실행 restore/normal close. Yes/No·Dock/트레이 조작 성공을 뜻하지 않음. |

CUA의 실제 `.app` 연결을 복구하여 파일/문서/저장창·취소·정상 Quit·한글 paste는 검증했다. 별도 osascript 승인창, TextInputMenuAgent 및 Dock 접근은 CUA 오류/시간 초과로 남았다. IME 전환 시도에는 실제 composition이 발생하지 않았으며 붙여넣기로 대신 통과시키지 않았다. Copy는 기존 pasteboard의 모든 포맷을 보존·복원할 조작 수단을 확보하지 못해 미검증이다. ffmpeg 부재도 최소 PATH로 실행했지만 정상 PATH 복구가 설치된 Homebrew ffmpeg를 찾아 실제 부재 상태를 만들지 못했다. 기존 설치/PATH 복구 정책을 제거하지 않았다.

## 7. benchmark·심층 검증·취소·내보내기

실제 tokenizer와 작은 code_python workload, warmup/concurrency1/2를 사용했다. 서로 다른 prompt 길이로 엔진 성능 순위를 비교하지 않는다.

| 근거 | 관찰 |
| --- | --- |
| `ui-bench-llama.cpp.json`, `ui-bench-vllm.json`, `ui-bench-mlx-vlm-kv64.json` | 실제 completion count/cached tokens0·KV/APC=false/reset·유한 timing·history. MLX prompt16은 chat template보다 짧아 exact prompt 구성 실패,64-token workload에서 완료. 실패 원본 유지. |
| OS RSS 대조 | `ui-native-metal-rss-results.json`: 649789440/649920512 bytes 제품/ps 동일. `ui-mlx-vlm-os-rss-results.json`: 578125824/578748416 동일. `ui-vllm-os-rss-results.json`: 제품250052608/241483776, OS247889920/241893376, 차이0.865%/0.170%. vLLM 부모/자식 group 포함. |
| deep verdict | `ui-deep-mlx-vlm.json`:510 positions full-vocabulary medianKL0.00010713571828091517/ratio0.9999340004355735 pass. `ui-native-metal-deep-results.json`: KL0.001846/ratio1.001106 pass. vllm quantized CPU reference는 partial/unsupported, CPU-only native는 비교 backend 없어 unsupported. |
| native CSV/XLSX | `ui-native-save-active-results.json`, `device-native.csv`, `device-native.xlsx`. 실제 OS Save/Cancel, CSVUTF-8 BOM·XLSX 내용 bytes/ZIP CRC·9rows·실패행 보존. Finder Quick Look에서 실제 workbook rows 확인. 독립 Excel 앱 검사는 아님. |
| 9 benchmark cancel | `ui-benchmark-cancel-matrix-results.json`: 3엔진×warmup/single/batch 실제 stage event 이후 cancel. 전부cancelled/소유 자식 종료/중단 trial 완료행 없음. batch 전에 완료된 single행은 보존. |
| 준비/로딩/deep | `ui-cmake-cancel-results.json`, `ui-replacement-cancel-results.json`, `ui-native-deep-cancel-results.json`. 실제 CMake child/staging 정리. replacement 준비 취소는 기존 서버 보호, 실제 --port loading 취소는 old/new 자식·포트 정리. native host/device deep 각 취소·cache 불변. MLX 초기 child cancel도 별도 확인. |
| MLX 단계별 취소 | `ui-mlx-traced-phase-results.json`, `mlx-deep-observer-cleanup.json`: CPU/GPU 각각 실제 비교 작업의 log-prob evaluation 진입을 관찰 후 취소. 소유 child/job 디렉터리 제거·기존 cache 바이트 불변. 관리형 환경은 보존하고 별도 같은 기기 복사본을 외부 등록하여 Python entry trace만 추가한 진단 검사다. 대기 삽입/결과 대체 없음. 진단 후 trace·등록 제거. mid-kernel 중단·성능 측정·portable 복사 성공으로 해석하지 않음. |
| 최종 종료 | `logs/ui-final-all-fixes-normal-quit.log`, `ui-final-quit-results.json`: 모델2/API/MCP 승인 대기 중 소유5→0·4포트 닫힘·tools/call 미전송. 최신 `6261d0b`는 `ui-shard-final-quit-results.json`, `logs/ui-shard-fixed-live.log`, `logs/ui-shard-final-quit-verify.log`: native draft/LoRA·공개 split·MLX embedding 세 실제 세션과 인증 API 응답 후 정상 Quit. 소유 자식 전부 종료·5포트 닫힘·모델/보조/shard 해시 불변·launcher/Vite exit0. |

RSS는 `pti_resident_size` process-group resident memory다. 모든 unified-memory GPU allocation이나 physical footprint를 포함한다고 해석하지 않는다. 공개 contract0.8.0/schema v2는 로컬 자동 계약 검사만 했으며 서비스 업로드/수락은 제외다.

## 8. offline bundle·오류·보호

| archive | 실제 내용·SHA256 | 새로운 격리 홈에서의 결과 |
| --- | --- | --- |
| `llama-cpu-portable.zip` | b11460, dylib 포함 61 files, 24279253 bytes. `79a3c8b19dc1a2f23490d992ef7842b4c49eced048c331b3a974deb97ebcd2f9` | export/import/probe·고정 GGUF 응답/usage·stop pass. `logs/native-bundle-live.log`. |
| `vllm-portable.zip` | 174 wheels, 498797516 bytes. `7459d98c13d4aead780d2e97c7daedecc7ef0c004d3e3ac775e1fa59f5653e23` | offline import/healthy probe·고정 mlx-lm provenance·실제 text/cancel/restart/stop pass. `vllm-portable-live.json`, `logs/python-bundle-metal-fixed.log`. |
| `mlx-vlm-portable.zip` | 56 wheels, 190507043 bytes. `0e544ce217a914ae204e453081968bdd6e0c8f9a2857d9f7fe937b16ff74f919` | offline import/probe·실제 text/cancel/restart/stop pass. 전체 harness는 직접 file URI500으로 fail. `mlx-vlm-portable-live.json`, `logs/python-bundle-mlx.log`. |

`bundle-negative-results.json`은 실제 archive 복사본에서 wheel SHA256·x86_64 arch·cp311/cp312 ABI·Linux OS 불일치 거부를 확인했다. 실제 pip 자식 실행 중 SIGINT로 비성공 종료·자식/staging 정리·완료 설치 비공개를 확인했다. 기존 archive로 export 거부와 원본 archive의 내용 해시 불변도 확인했다.

`native-bundle-negative-results.json`은 실제 native archive의 LICENSE SHA256·arch·OS 불일치를 publish 전에 거부하고 원본을 보존했다. 외부 환경은 앞서 설명한 별도 venv에서 전체 파일 보호를 확인했다. `native-bundle-cancel-results.json`에서 실제 압축·추출 중 SIGINT, 자식/staging 정리, 원본 archive/runtime 해시 불변을 확인했다. `ui-native-save-active-results.json`에서 native/Python export/import 네 명령이 활성 모델 중에는 picker 전에 거부됐다. `imported-stt.json`, `imported-embedding.json`은 새 offline 환경의 실제 STT/768차원 embedding·재시작·중지 통과다. chat404는 해당 task에서 unsupported이며 chat cancel은 실행한 것으로 계산하지 않는다.

## 9. 최종 arm64 DMG

기존 `npm run package:tauri`로 `6261d0b`의 production frontend/CLI/app/DMG를 생성했다. `package-results.json`, `logs/final-shard-package.log`, `logs/final-shard-package-inspect.log` 근거다. 작업용 mountpoint에 read-only/nobrowse mount·검사·detach했다.

- `AioLM_0.3.1_aarch64.dmg`: 16759441 bytes, SHA256 `9c8e69ea87c6afbbdecffdcc7c580748328fba5b22221c1010cdde623dba7851`.
- GUI `aiolm`: arm64, SHA256 `8f5555a2ff5dda2197be79c46f1e06f58d0982bb8d6facd276dd4cc2d1a67d24`.
- CLI `aiolm-cli`: arm64, SHA256 `1983d84e9418b1b1d8d102e03ac8e49ed532c7e17a9b7117f36231eaf008b193`.
- identifier `com.aiolm.desktop`, version0.3.1, minimum OS13.3은 선언값이며13.3 실기기 통과가 아니다.
- `codesign --verify --deep --strict` pass. GUI/CLI ad-hoc/runtime, Developer ID/공증 없음.
- 포함 파일은 Info.plist/CodeResources/GUI/CLI/icon.icns. fixture/model/venv/개인 설정 제외. 실제 home/repository 문자열 UTF-8/UTF-16 스캔 일치 없음.
- 기존 설정 없는 새 홈에서 packaged CLI: onboarding=false, 모델/runtime 미선택, 해당 홈 모델 저장소 기본값.
- raw 복사본은 `tmp/macos-acceptance/package/`, build output은 Git 제외 `.codex-target/release/bundle/`. Finder 설치·quarantine 해제는 수행하지 않음.

## 10. 남은 검사와 다음 작업

- **별도 OS 계정에서 unrun:** 최초 GUI 실행, Keychain 허용/거부/취소/갱신 재승인, 자연스러운 Finder 설치·첫 실행, 실제 과거 버전 upgrade/legacy 이전. 격리 HOME의 GUI v12 이전과 구분한다.
- **현재 조작 수단 blocked:** 별도 osascript MCP Yes/No→실제 tool/후속 답변·호출 중 취소, 한글 IME composition 중 Enter, clipboard Copy/모든 포맷 복원, Dock/트레이 Show/Quit. 기존 앱 파일 picker와 paste/normal Quit은 완료했다. OSAX 직접 조작 probe는 신뢰할 수 있는 실행 근거를 제공하지 않았고 CUA는 해당 별도 osascript 창을 선택하지 못했다. OS 접근성·자동화 권한은 변경하지 않았다.
- **실제 ffmpeg 부재 blocked:** 정상 PATH 복구가 기존 설치를 찾음. 설치를 숨기거나 제품 PATH 복구를 끄지 않고 부재 상태를 검증할 별도 환경 필요.
- **실제 fail 유지:** 직접 Metal/MLX URI 이미지500, SmolVLM native projector의 알려진 시각 내용 오답, 고정 Gemma3n native-audio snapshot의 누락 shard index. upstream/model 수정 후 해당 흐름을 다시 실행해야 한다.
- **실기기 없이 unrun:** Intel 및 macOS13.3–15. 이 결과로 다른 architecture/minimum OS 성공을 추정하지 않는다.
- 전체 앱 Force Quit/SIGKILL 복구·다른 사용자 single-instance 개선·Developer ID/공증·공개 benchmark 업로드는 이번에 구현하지 않았다. 미디어 retry의 자체 model-child fault와 전체 앱 강제 종료를 구분한다.

## 11. 개발 앱 실행 후 모델 오류 후속 검증

사용자가 보고한 두 실패를 실제 개발 앱의 동일 격리 홈에서 확인했다. 첫 실패는 Qwen3-VL의 모델 기본 context262144가 요구하는 KV28GiB와 가용7.9GiB의 불일치였다. 현재 선택된 Metal 프로필에만 `max_model_len=4096`을 저장하고 같은 모델·런타임으로 math 응답4/HTTP200/usage23을 확인했다. 제품 기본값 변경이나 timeout 증가는 하지 않았다. `metal-user-default-context-results.json`, `logs/metal-user-default-context-full.log`, `metal-user-profile-retry-results.json`이 근거다.

두 번째 실패의 `unsloth.Q8_0.gguf`는 5절의 고정 Python repository에서 받은 531065184-byte base 모델이다. 실제 GGUF metadata와 인접 tokenizer 모두 채팅 템플릿이 없었고 Transformers의 기본 템플릿 제거 오류로 chat400이 발생했다. GGUF 포맷 자체의 로딩 실패와 구분한다. `user-400-before.json`, `ui-user-400-before.json`, `logs/user-400-gguf-metadata.log`에 원본을 보존했다. [vllm-metal 공식 GGUF 설명](https://docs.vllm.ai/projects/vllm-metal/en/latest/gguf/)도 별도 config/tokenizer와 제한된 모델·양자화 지원을 명시한다.

`2e63118`은 실제 vLLM snapshot 또는 Metal GGUF의 인접 tokenizer를 검사한다. 명시적 프로필 템플릿과 Harmony는 허용하며, 알 수 없는 renderer와 기존 기능 기록은 기존 동작을 유지한다. chat 불가를 모델 로드/readiness 실패로 바꾸지 않고 text completion을 보존한다. 한국어·영어·일본어·중국어 composer 안내와 `chat_template_required` gateway 오류를 추가했다.

| 후속 항목 | 상태 | 실제 근거 |
| --- | --- | --- |
| base GGUF completion/chat 구분 | pass | `chat-template-base-proof.json`, `ui-chat-template-base-guard.json/png`, `logs/chat-template-base-proof-fixed.log`. 실제 Metal 준비 완료·`chat_supported=false`·안내/Send 비활성. 인증 chat400/명확한 오류 코드, completion200/8+16=24 tokenizer tokens. |
| 설치된 Instruct 전환·동일 입력 | pass | 5절의 `mlx-community/Qwen2.5-0.5B-Instruct-4bit` revision을 재사용했다. 실제 Model path→설정 복원→base Unload→프로필 저장/시작. 같은 Metal 런타임·context4096·`chat_supported=true`. 기존 `안녕` 대화의 실패 입력을 재사용해 실제 한국어 assistant 답변과 2개 메시지 기록을 확인했다. `instruct-chat-proof.json`, `ui-instruct-chat-success.json/png`, `logs/instruct-chat-proof-fixed.log`. 인증 chat200/31+12=43 tokenizer tokens. 개발 앱과 모델을 실행 상태로 유지했다. |
| 후속 자동 검사 | pass | `logs/typecheck.log`, `logs/chat-template-final-lint.log`, `logs/chat-template-unit.log`, `logs/chat-template-build.log`, `logs/chat-template-rust.log`, `logs/chat-template-clippy.log`, `logs/chat-template-fmt-check.log`. UI161 files/1558 tests, coverage79.07/73.92/77.43/83.2%. Rust lib932 pass/4 ignored, CLI15 및 integration. 기존 ignored는 실행 성공으로 계산하지 않는다. |
| 후속 수정의 DMG | pass | 이 채팅 후속 수정을 포함한 `0424ab5`의 DMG 생성·검사는 13절에 기록한다. |
| Finder/전체 M01–M12 반복 | unrun | 개발 앱의 관련 실제 흐름과 자동 검사, 패키지 검사를 전체 기기 검증으로 확대하지 않는다. 기존 fail/blocked/unrun 판정을 전체 pass로 바꾸지 않는다. |

검사 도구의 selector 따옴표·버튼명/공백·재시도 메시지 수 가정 오류는 실패 로그와 수정 후 검사를 함께 보존했다. 실제 앱은 기존 실패 입력을 재사용해 2개 메시지로 응답했으며, 도구가 기대한 3개 메시지와의 차이는 제품 실패가 아니다. raw 설정·키·개인 경로는 커밋하지 않았다.

## 12. 채팅 지표·프로젝트·레이아웃 후속 검증

후속 소스는 `0424ab5`이다. 이번 결과는 개발 앱에서 M01·M05·M08·M09의 관련 하위 흐름을 재검증한 기록이며, 전체 M01–M12 통과를 뜻하지 않는다. 5절의 Qwen3-VL revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`, 외부 등록 Metal 0.30.0, 현재 프로필의 context4096을 그대로 사용했다.

| 후속 항목 | 상태 | 수정과 실행 근거 |
| --- | --- | --- |
| 실제 채팅 PP/TG 표시 | pass | `goal-chat-metrics-proof.json`, `goal-final-chat-proof.json`. 본문 완료 뒤 도착하는 최종 SSE usage·metrics를 기록과 화면에 반영했다. 기존 답변은 PP39 tokens, TG46 tokens / 1.50s / 30.0tok/s였다. 최종 빌드에서 새 한국어 입력·실제 답변·기록과 PP48 tokens, TG74 tokens / 3.84s / 19.0tok/s도 확인했다. TG 속도는 실제 첫 출력부터 마지막 출력까지의 시간과 토큰 간격 수로 계산한다. 선택된 runtime probe가 지원하는 telemetry flag만 자동 적용하며, 명시적 `false`·raw negative flag·통계 비활성화 제약을 보존한다. |
| Metal PP 시간 | unsupported | 같은 근거에서 해당 runtime은 PP 처리 시간을 제공하지 않는다. PP 토큰 수와 별도로 시간·속도를 `—`와 현지화한 설명으로 표시한다. TTFT를 PP 시간으로 추정하지 않았다. |
| 모델 이름·이력·개발 중 상태 | pass | `goal-chat-metrics-proof.json`, `goal-context-hmr-proof.json`. 폭0이던 실행 모델 이름이 읽을 수 있게 표시됐다. alias와 실제 로드 artifact를 구분하고 새 이력에는 확보한 실제 모델 정보를 남긴다. 과거 기록의 누락 정보는 추정하지 않는다. 실제 Provider HMR 후 WebView 재로드 없이 같은 모델·PID·화면 상태를 유지했고 렌더 오류가 없었다. |
| 프로젝트 저장 실패·이탈 | pass | `goal-project-persistence-proof.json`. quota 오류에서 성공 안내가 나오지 않고 저장 목록·활성 포인터·편집 입력을 보존했다. Keep editing은 draft를 유지하며 Discard는 명시적 선택 후에만 버린다. 공간 회복 뒤 Retry save도 성공했다. |
| 프로젝트 문서 읽기·재시도 | pass | `goal-project-document-proof.json`. 실제 누락 파일 이름과 재시도 안내, 입력 보존, Send 차단을 확인했다. 파일 복구 후 native 재읽기와 실제 Metal 답변 `ORBIT-76`을 확인했다. 기존 첫4개 자동 첨부 정책과 수동 첨부를 보존하며 이전 프로젝트·대화·pending turn의 늦은 읽기가 현재 composer를 덮어쓰지 않도록 했다. |
| 메뉴·작은 창 | pass | `goal-layout-survey-verified.json`. 11메뉴×1280×800/960×640/390×600의 33개 실제 WKWebView 화면에서 body 가로 넘침·overlay·ErrorBoundary·렌더 오류가 모두0이었다. Scan 완료 대기를 포함하되 각 화면의 첫 viewport 검사이며 모든 버튼·여정을 실행한 검사는 아니다. |
| 창 크기 변경·답변 위치 | pass | `goal-chat-resize-proof.json`. 최신 답변을 보고 있을 때 창을 줄이면 끝을 따라가며, 과거 내용을 읽고 있을 때는 위치를 보존했다. 실제 390×600 창의 scrollTop253·본문168·scrollHeight421을 확인했다. |
| MCP 갱신·요청 오류 | pass | `goal-mcp-error-proof.json`. 자동 도구 호출이 꺼진 실제 모델에서 요청 전 거부 안내가 늦은 도구 목록 갱신 후 사라지던 문제를 수정했다. 합성 MCP catalog의 native 응답을 지연한 WKWebView 검사에서 안내가 유지되고 지원하지 않는 HTTP 요청이 전송되지 않았으며 모델 PID·기능·선택을 보존했다. 합성 스트림만으로 실제 엔진의 도구 지원을 통과 처리하지 않았다. |
| MCP native 취소·정리 | pass | `ui-mcp-cancel-results.json`. 실제 Cocoa 승인창의 Cancel에서 tool 호출을 보내지 않고 소유 프로세스를 회수했다. 별도 osascript Yes/No와 승인 후 실제 호출 중 취소는 10절의 조작 제약 때문에 blocked를 유지한다. |
| 후속 수정 패키징 | pass | `0424ab5`의 새 arm64 DMG·CLI·bundle 검사 결과는 13절에 기록한다. |
| Finder·별도 계정·전체 반복 | unrun | 새 패키지 검사와 개발 앱의 관련 하위 흐름을 전체 M01–M12 반복이나 다른 계정·OS 검증으로 확대하지 않는다. |

최종 공통 UI 검사는 170 files/1663 tests가 통과했고 coverage statements79.88% / branches74.83% / functions78.17% / lines84.01%다. 근거는 `logs/goal-final-{unit,lint,typecheck,build}-verified.log`다. 전체 타깃·feature Rust 검사 `logs/goal-final-rust-verified.log`에서 lib937 pass/4 ignored, CLI15 및 integration이 통과했다. 최종 clippy·rustfmt는 `logs/goal-telemetry-raw-override-clippy.log`, `logs/goal-telemetry-raw-override-fmt-final.log`이며 ignored를 실행 성공으로 계산하지 않는다. 기존 frontend chunk 크기 경고는 남아 있다.

지연된 대화 hydration과 첨부 한도·실패 복구의 추가 회귀6개도 통과했다(`logs/flow-thread-hydration-after.log`, `logs/flow-attachment-capacity-after.log`, `logs/flow-attachment-capacity-recovery.log`). RAG embedding 취소·실패 Retry 상태·프로젝트 읽기 순서, 승인 대기 중 대화 소유, MCP 갱신 오류 분리도 합성 회귀 검사로 확인했다. 첨부 파일 이름만 기다리던 기존 검사 helper는 실제 Attachment ready까지 기다리도록 수정했으며 timeout 증가·실패 skip은 하지 않았다. 선택 모델의 자동 도구 호출이 꺼져 차단된 스트림 시도는 승인 흐름 성공으로 계산하지 않았다. 검사는 임시 저장소와 합성 문서로 수행했고 사용자 자료를 삭제하거나 개발 기기의 경로·설정을 제품 기본값으로 넣지 않았다. 원본 로그·캡처·설정은 Git 제외 `tmp/macos-acceptance/`에 보존한다.

## 13. 후속 수정을 포함한 arm64 DMG

`0424ab5e8e7e572326949fa1240a1d31ad16d72a`에서 기존 `npm run package:tauri`로 frontend·CLI·GUI·DMG를 재빌드했다. `logs/goal-final-package.log`, `logs/goal-final-package-inspect.log`, `goal-package-results.json`이 근거다. read-only/nobrowse mount에서 검사한 뒤 detach했으며 이전 raw 패키지와 별도 보관했다.

- `AioLM_0.3.1_aarch64.dmg`: 16768896 bytes, SHA256 `921785ba2146aa07d93e04493860173ed477498a0e5562e9f2c24ede94e39a71`.
- GUI `aiolm`: arm64, SHA256 `1bd3d567e8bb383123ca79a2829d6fbb533f60430415f11382c9d806e7fc5f4c`.
- CLI `aiolm-cli`: arm64, SHA256 `794689cd0c1aa78e6b381cf6fb7e25635820b6063bef29e53b31629996020f2c`.
- identifier `com.aiolm.desktop`, version0.3.1, minimum OS13.3은 선언값이다. 구형 OS 실기기 통과로 계산하지 않는다.
- `codesign --verify --deep --strict` pass. GUI·CLI는 ad-hoc/runtime이며 Developer ID 서명·공증은 수행하지 않았다.
- app 내부의 일반 파일은 Info.plist·CodeResources·GUI·CLI·icon.icns 5개다. 모델·venv·smoke fixture·개인 설정 제외, 실제 home/repository 문자열의 UTF-8·UTF-16 스캔 일치0을 확인했다.
- 기존 파일 없는 별도 새 홈의 packaged CLI에서 onboarding=false, 모델·runtime 미선택, 해당 홈의 모델 저장소 기본값을 확인했다.
- raw 복사본은 `goal-package-0424ab5/`에 보관했다. production GUI의 자연스러운 Finder 설치·첫 실행, 별도 계정 Keychain·실제 upgrade는 여전히 unrun이다. 개발 앱은 현재 선택된 Metal 모델과 마지막 실제 한국어 답변을 유지한 상태로 두었다.
