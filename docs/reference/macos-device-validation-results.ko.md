# Mac 기기 검증 결과

[Mac 기기 작업 인계](macos-device-handoff.ko.md)의 M01–M12 후속 기록이다. **전체 기기 검증은 통과하지 않았다.** 공통 자동 검사, 세 엔진의 실제 추론·offline bundle 왕복, arm64 DMG 생성은 통과했다. 엔진 직접 연결의 `file://` 이미지 입력은 upstream 오류로 실패했고, 네이티브 조작과 별도 계정이 필요한 여정 및 일부 취소 단계는 남아 있다.

## 1. 소스·환경·증거의 범위

- 실행일: 2026-10-07. 기준 소스: `11996aa26b326164ef97f7ba005438f05c30891d`.
- 브랜치: `codex/macos-device-validation`. 최종 구현·패키지 소스: `f414544`. 수정 커밋은 아래 표에 기록한다. 원격 push는 수행하지 않았다.
- 실제 기기: macOS 26.6.2 / native arm64 / Apple M2 / 메모리 16 GB.
- 작업용 도구: Node 22.23.2, npm 12.0.2, Rust 1.98.0/rustfmt/clippy, CMake 4.4.4, CPython 3.12.15 arm64. 기존 ffmpeg 8.1.2를 사용했다.
- 도구·캐시·설정은 작업용 경로에 두었다. 기존 시스템 도구와 lockfile을 변경하지 않았다. 자동 검사·CLI·앱은 임시 HOME 및 legacy 경로를 격리했다. 새 OS 계정의 최초 실행을 대신한 검사는 아니다.
- 앱 검사는 `macos-ui-smoke` debug 빌드의 실제 Tauri WKWebView, 실제 IPC와 W3C WebDriver를 사용했다. 합성 IPC 화면 검사가 아니다. production DMG의 자연스러운 Finder 실행은 별도 `unrun`이다.
- raw 로그·모델·번들·캡처·검사 도구는 Git 제외 대상 `tmp/macos-acceptance/`에 보관했다. 자체 임시 홈 중 보존 대상으로 반환된 홈은 `retained-homes/`에 복사했다. 네이티브 검사 자체가 정리한 홈·모델은 재보관하지 않았다.
- 아래 근거 파일은 모두 이 작업 디렉터리 기준이다. `checks.jsonl`에 명령·종료 코드·소요 시간을 기록했고 원본 로그는 `logs/`에 보존했다. 이 문서에는 개인 경로·계정·기기 식별자·생성 런타임 ID·API 키를 포함하지 않는다.
- hosted runner 전용 스크립트의 실행 조건을 위조하지 않았다. 공개 benchmark 서비스 업로드는 수행하지 않았다.

## 2. 재현 결함과 수정

| 커밋 | 재현과 변경 | 수정 후 근거 |
| --- | --- | --- |
| `3523a87` | macOS 전용 버전 감지의 needless return과 프로필 fixture 초기화가 clippy 에 실패했다. snapshot 테스트의 symlink된 임시 조상 경로를 제품과 같은 canonical root로 맞췄다. 링크 보호는 유지한다. | 전체 Rust 검사·clippy 통과. 정상 하위 경로 허용과 symlink 거부를 함께 검사. |
| `6ef0b8f` | StrictMode effect 정리 후 Discover의 열린 상태가 남아 첫 검색이 pending으로 고정됐다. 정리 시 상태를 초기화했다. 최소 창에서는 고정 실행 영역 때문에 본문이 32 px로 줄었다. 작은 높이의 context 영역에 스크롤과 높이 제한을 적용했다. | StrictMode 재실행·오래된 응답 회귀 검사. 실제 WKWebView 검색→다운로드→실행 및 세 엔진×세 창 크기에서 본문 최소 122 px 확인. |
| `fbb557d` | acceptance harness 가 동기 CLI 재시작 중 오래된 pooled socket을 사용해 정상 서버에 ECONNRESET을 냈다. 검사 HTTP 요청은 매번 새 socket을 사용한다. 제품 서버 오류가 아니다. | 같은 포트 재시작/SSE/usage 회귀 검사, 합성 28개 검사, 실제 Metal 취소→재시작 통과. 오류 재시도로 숨기지 않는다. |
| `c2236d0` | mlx-vlm 0.7.6은 CLI 처리 전에 RuntimeConfig를 import 하여 `--max-kv-size`가 있어도 실제 `/v1/settings`의 값이 비었다. 검증한 KV 예산을 launch 환경에도 전달한다. | CLI/env/unset Rust 회귀 검사. 실제 MLX benchmark에서 KV 256·APC=false·reset 확인 후 64-token workload 완료. readiness를 제거하지 않았다. |
| `f414544` | 실제 mlx-lm의 선언된 root console script `mlx_lm`을 portable export 가 외부 파일로 거부했다. scripts 디렉터리의 선언된 console entry point 만 wheel에서 제외하고 설치 시 재생성한다. | 실제 파일이 있는 합성 metadata/wheel 검사. 임의 prefix·다른 디렉터리·absolute 경로는 계속 거부. 실제 Metal 174-wheel export/import/추론 통과. |

공개 API와 benchmark 계약을 변경하지 않았다. 기본 엔진 옵션·Windows/Linux 정책을 유지했으며 실패를 skip, 해시 무시, readiness 제거나 근거 없는 timeout 확대로 통과시키지 않았다.

## 3. M01–M12 판정

`pass`는 해당 항목의 실행 범위가 통과한 경우, `fail`은 실제 실패가 남은 경우다. `unsupported`는 구체적으로 확인한 미지원 하위 검사에 사용한다. 항목 내 필요한 여정이 미실행이면 `unrun`, 현재 도구로 조작할 수 없는 단계가 있으면 `blocked`다. 하위 성공을 항목 전체의 통과로 확대하지 않는다.

| ID | 상태 | 실행 근거 및 남은 작업 |
| --- | --- | --- |
| M01 | pass | 지정 도구와 native arm64 확인. TypeScript·lint·단위·frontend/CLI/native build, Rust 전체 타깃·feature, Python·native CLI·합성 harness 통과. Unix socket/process/symlink 검사를 실제 권한으로 실행. |
| M02 | pass | 고정 GGUF로 llama.cpp CPU→Metal lifecycle 및 CPU/Metal 소스 빌드 각각 통과. 설치 취소·staging 정리, probe·응답/usage·재시작·중지 확인. source-build 도중 CMake 취소는 M12의 미실행 단계다. |
| M03 | fail | 관리형 Metal 설치·ABI/import/MetalPlatform·실제 텍스트/이미지·STT·embedding·취소·재시작 통과. 별도 외부 환경 등록/삭제 시 모든 파일 보존. 직접 이미지 `file://` 요청은 upstream HTTP 500. |
| M04 | fail | 별도 MLX 설치·probe/processor·텍스트/이미지·취소·재시작 및 별도 외부 환경 보존 통과. 직접 이미지 `file://` 요청은 upstream HTTP 500. 다른 native 음성/영상 processor 여정은 unrun. |
| M05 | unrun | 실제 WKWebView 11개 메뉴×3 엔진, 공용 프로필 3개, 3 창 크기×3 엔진 확인. v12→v13 보존/backup은 자동 회귀 검사 통과. 실제 GUI 이전과 지원 옵션 전체 조합은 미실행. |
| M06 | unrun | 실제 검색→snapshot 다운로드 취소→재시도→설정→MLX 실행, 고정 GGUF 다운로드·해시 확인. 분할 GGUF/companion의 전체 UI 여정·삭제 보존 및 APFS 조건 전체는 미실행. |
| M07 | fail | 알려진 이미지 내용, Whisper 전사 내용, 실제 ffmpeg 프레임/미디어 resolve 확인. 직접 엔진 URI 500과 gateway의 안전한 400 거부를 분리했다. OS 첨부 선택→기록/재로드/재시도 전체 여정은 blocked/unrun. |
| M08 | blocked | gateway 인증·라우팅·멀티 세션·Responses continuation, 프로젝트, 실제 벡터 RAG 및 lexical fallback 통과. MCP schema·실제 승인창·취소/정리 확인. 네이티브 Yes/No·호출/후속 답변과 OS 문서 선택은 조작하지 못했다. |
| M09 | blocked | 세 엔진의 실제 tokenizer usage·cold-cache·KV·process-group RSS·이력·CSV/XLSX 내용 확인. MLX deep pass, Metal deep partial/unsupported, CPU native 비교 unsupported. OS RSS 대조·native Metal deep는 unrun, 네이티브 저장창은 blocked. |
| M10 | fail | 세 엔진 offline export/import 후 실제 추론 통과. hash/ABI/arch/OS 오류·pip 취소·기존 출력·별도 외부 환경 보호 확인. MLX 전체 harness 에는 직접 URI 500 이 남는다. native bundle 취소·활성 서버 거부의 실제 단계와 imported STT/embedding은 unrun. |
| M11 | blocked | arm64 DMG/GUI/CLI·버전·strict ad-hoc 서명·해시·개인 경로/fixture 제외·새 홈 CLI 기본값 확인. 실제 창 hide/두 번째 실행 restore/정상 종료 통과. IME·클립보드·picker·Dock/트레이 조작은 blocked. 별도 계정/Finder/Keychain/실제 업그레이드는 unrun. |
| M12 | unrun | 정상 앱 종료 시 두 모델·API·대기 승인창/stdio 포함 소유 프로세스 5→0, 포트 4개 닫힘. chat·pip·benchmark·deep·MCP 취소 정리 확인. ffmpeg/CMake 및 모든 교체·로딩·trial 단계 취소 행렬은 미실행. |

## 4. 공통 자동 검사

| 명령 | 상태·최종 근거 |
| --- | --- |
| `npm run typecheck`, `npm run lint` | pass — `logs/final-typecheck.log`, `logs/final-lint.log`. |
| `npm run test:unit` | pass — `logs/final-unit.log`. 계약/direct/script 검사 포함. UI 160개 파일 / 1,550개 테스트; coverage statements 78.88%, branches 73.72%, functions 77.19%, lines 83.02%. |
| `npm run build`, `npm run build:cli` | pass — 공통 build 및 마지막 `logs/final-cli-portable.log`. 최종 packaging 명령에서도 production frontend·CLI를 다시 빌드. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | pass — `logs/final-rustfmt-kv.log`. 이후 Rust 변경 없음. |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | pass — `logs/final-clippy-portable.log`. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | pass — `logs/final-rust-with-portable.log`. lib 921 pass / 4 ignored, CLI 15 및 integration 검사. ignored 검사를 실행한 것으로 계산하지 않는다. |
| `cargo build --locked --manifest-path src-tauri/Cargo.toml --bins`, `npm run test:native-cli` | pass — native build 및 `logs/native-cli.log`. |
| `python3 -B -m unittest discover -s src-tauri/src/providers -p '*_tests.py'` | pass — 14개, `logs/final-python-all.log`. |
| `python3 -B -m unittest discover -s src-tauri/src/providers/tests -p 'test_*.py'` | pass — 3개, `logs/final-python-probe.log`. |
| `npm run test:provider-runtime` | pass — 28 개와 synthetic loopback self-test, `logs/provider-harness-socket.log`. 실모델 성공 근거는 아니다. |
| `npm run package:tauri` | pass — `logs/package-arm64.log`. chunk 크기 경고는 남아 있으나 build 실패는 아니다. |

sandbox에서 socket bind/프로세스 검사 권한이 거부된 Rust 실행은 환경 실패로 원본을 남겼다(`logs/final-rust-all.log`). 실제 권한으로 재실행한 전체 검사는 통과했다. 이후 portable 수정까지 포함한 최종 실행도 통과했다. lockfile은 변경하지 않았다.

## 5. 실제 엔진·모델

| 엔진 | 실제 설치·probe |
| --- | --- |
| llama.cpp | native lifecycle은 공식 b11459 CPU/Metal. 소스 빌드는 `f07be9f37e5dd3e8bec895f6ffd8d86fd1bbc370` CPU/Metal 각각. 이후 앱 설치 시 upstream latest 가 b11460으로 바뀌어 b11459 지정이 정책상 거부됐다. 앱·CPU bundle은 b11460, version 0.6.0 / commit `78651c410`으로 실행했다. |
| vllm-metal | CPython 3.12.15 arm64, vLLM distribution 0.30.0+cpu / imported 0.30.0, plugin 0.30.0, MLX 0.32.1, nanobind 2.10.2, mlx-vlm 0.6.17, mlx-lm `9e6acca691e64d6d8bb808c328fcdea459099cca`. MetalPlatform·shipped `_paged_ops`·GPU 사용 가능 및 STT loader scan 확인, probe errors 없음. |
| mlx-vlm | 별도 CPython 3.12.15 arm64 환경, mlx-vlm 0.7.6 / MLX 0.32.3. 실제 server flag·loader/processor를 probe 했으며 errors 없음. Metal 환경에 이 버전을 덮어 설치하지 않았다. |

모델은 설치된 loader/processor를 먼저 확인하고 공개 Hub 전체 revision을 다운로드 전에 고정했다. 크기는 실제 선택하여 받은 파일 합계이며 repository의 모든 대체 포맷 합계가 아니다. HF cache `snapshots/<전체 SHA>` 또는 앱의 `.aiolm-snapshot.json`으로 provenance를 확인했다.

| 용도·공개 출처 | 전체 revision | 받은 bytes |
| --- | --- | ---: |
| native GGUF: `Qwen/Qwen2.5-0.5B-Instruct-GGUF` | `9217f5db79a29953eb74d5343926648285ec7e67` | 491400032 |
| Metal/MLX text: `mlx-community/Qwen2.5-0.5B-Instruct-4bit` | `a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3` | 289598797 |
| vision: `mlx-community/Qwen3-VL-2B-Instruct-4bit` | `9c4f5209e57b31f4b9dfba735de3fb983739c9cc` | 1798021605 |
| STT: `openai/whisper-tiny` | `169d4a4341b33bc18d8881c4b69c2e104e1cc0af` | 155434424 |
| embedding: `intfloat/multilingual-e5-base` | `d128750597153bb5987e10b1c3493a34e5a4502a` | 1134355035 |

GGUF 파일은 `qwen2.5-0.5b-instruct-q4_k_m.gguf`, SHA256은 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`다. 기존 native 검사와 같은 고정 파일을 사용했다.

| 실행 | 원본 근거·관찰 |
| --- | --- |
| native CPU/Metal/source | `logs/runtime-install-live.log`, `logs/native-cpu-live.log`, `logs/native-metal-live.log`, `logs/native-source-cpu.log`, `logs/native-source-metal.log`. Metal은 25/25 layers offload. 실제 응답/usage·재시작·중지, 설치 취소/staging 정리 확인. |
| Metal text | `metal-text-socket.json`. usage 60+108=168, 응답·mid-body cancel·restart·stop pass. 짧은 최초 응답이 cancel 전에 끝난 실패와 이전 socket harness 실패의 원본을 보존했다. 긴 생성으로 재검증했다. |
| MLX text/vision | `mlx-text-live.json`, `mlx-vision-live.json`. 응답/usage·cancel·restart·image endpoint 성공. 직접 `file://`는 500, 전체 harness는 fail. text checkpoint의 이미지 HTTP 200을 내용 이해의 근거로 삼지 않는다. |
| Metal vision | 최초에는 기본 max_model_len 262144의 KV 요구량 약 28 GiB 가 사용 가능 약 8.48 GiB를 넘어 실행 실패. `logs/metal-vision-server.log` 보존. 명시적 4096으로 `metal-vision-4096.json`의 추론/cancel/restart 성공, URI 는500. `metal-vision-content.json`에서 왼쪽 빨간 사각형·오른쪽 파란 원이라는 실제 내용을 확인했다. 기본값을 변경하지 않았다. |
| Metal STT | `metal-stt-live.json`, `ui-media-results.json`. 별도 STT 세션의 Whisper 가 알려진 합성 WAV를 정확히 전사했다. chat endpoint404는 unsupported이며 chat cancel은 미실행. |
| Metal embedding | `metal-embedding-live.json`, `ui-rag-results.json`. 768차원 유한값·restart/stop. chat404는 unsupported. |
| 외부 등록 보호 | `external-protection-vllm.json`, `external-protection-mlx-vlm.json`. 앱 관리 영역 밖에 별도 offline venv를 각각 만들고 실제 CLI register/probe/remove. 모든 일반 파일의 내용 해시가 등록 전후 일치. |

직접 URI 500은 엔진 server 측 upstream 제한으로 분류했다. app gateway는 신뢰하지 않는 로컬 경로를 400 `untrusted_media_path`로 거부한다. 이 안전한 거부와 직접 엔진의 실패는 별도 결과다.

## 6. 실제 WKWebView·API·종료

| 근거 | 확인한 동작과 범위 |
| --- | --- |
| `ui-menu-results.json`, `ui-profile-results.json` | 11개 메뉴×3 엔진, 공용 프로필 3개, 실제 창 1280×800 / 800×600 / 360×520. 최소 viewport 360×488에서 수정 후 본문 122 px 이상. runtime/model 선택은 프로필 밖에 유지. |
| `ui-discover-results.json`, `logs/ui-discover-cold-fixed.log`, `logs/ui-gguf-download.log` | 첫 검색 고착 수정 후 vision snapshot cancel/retry·완료 manifest·Configure and run·실제 MLX 실행. GGUF 고정 크기/해시 일치. |
| `logs/ui-chat-flow-fixed.log` | 실제 composer 입력→응답/usage→대화 저장→reload 복원→긴 생성 Stop. 합성 한글 문자열 입력은 IME composition 검증이 아니다. |
| `ui-gateway-results.json` | 무인증 401, 인증 models/text200과 usage, 없는 alias404. 2 세션의 default/명시 alias200, 모호한 bare alias400. 이미지 내용 확인, URI400. 모든 모델 중지 후 API 유지/503, API stop. |
| `ui-media-results.json` | 내용이 알려진 합성 이미지·WAV/MP4를 immutable media store 에 배치하고 실제 resolve/무효 reference 거부·ffmpeg 프레임 시각·별도 Metal STT 확인. 전사문은 “The red square is on the left. The blue circle is on the right.”. OS attachment picker를 거치지 않은 processor/IPC 검사이며 첨부→이력→retry 전체 여정은 아니다. |
| `ui-rag-results.json` | 실제 e5 Metal 세션→app gateway→768차원 유한 벡터 3개. 실제 frontend retrieval 함수로 파란 원의 source/citation 선택, lexical fallback, 별도 namespace 확인. 문서 fixture를 투입했으며 OS 문서 picker/후보 선택 전체는 아니다. |
| project captures | 실제 Projects 화면에서 합성 프로젝트 생성·저장·적용, 공용 프로필과 active project 확인. native file binding/import/export는 미실행. |
| `ui-mcp-cancel-results.json` | 합성 stdio JSON-RPC의 실제 schema 열거, 제품 Cocoa 승인창의 가시 상태 확인. 실제 cancel로 창/stdio 자식 정리, tools/call 미전송. Yes/No→실제 호출/후속 답변은 미실행. |
| `ui-window-results.json` | close_to_tray=true에서 실제 close 가 창을 숨김. 같은 격리 설정의 두 번째 실행이 기존 창을 restore 하고 두 번째 프로세스 종료. false로 복원한 후 일반 close로 종료. tray/Dock의 Show/Quit 조작은 아니다. |
| `ui-cancel-checks.json` | 실제 benchmark/deep helper 시작 후 실제 cancel. 자식 종료, benchmark cancelled·중단 trial의 완료행 없음. 양쪽 backend/모든 trial 단계 행렬은 미실행. |
| `ui-final-quit-results.json`, `logs/ui-final-normal-quit.log` | 실제 모델 2개·API·MCP 승인 대기 중 정상 close. Responses continuation 이 이전 turn의 합성 코드 ORBIT을 기억하고 usage60+13=73 반환. 소유 root/자식 5→0, 모델 2/API/WebDriver 의 4 포트 닫힘, tools/call 없음. launcher/Vite 도 정상 종료. |

CUA app 연결이 `-10005`로 UI 상태를 가져오지 못해 네이티브 selector/IME/clipboard/MCP Yes/No/Dock/트레이 조작은 blocked다. OS 창 관찰은 대상 프로세스에 한정한 읽기 전용 CGWindow probe로 했다. 승인창의 존재 확인을 승인/거부 성공으로 표시하지 않는다.

## 7. benchmark·심층 검증·이력

실제 모델로 warmup=true, code_python, 1 반복, concurrency1/2를 실행했다. 짧은 검증 workload이며 서로 다른 prompt 길이의 결과로 엔진 간 성능 순위를 판단하지 않는다.

| 근거 | 실측과 판정 |
| --- | --- |
| `ui-bench-llama.cpp.json` | b11460 CPU. prompt16/generation8, completion8/16, cached tokens0. peak process-group RSS736067584 / 736182272 bytes. pass. |
| `ui-bench-vllm.json` | Metal. prompt16/generation8, completion8/16, cache0. max context256·prefix caching 비활성 확인. RSS1419444224 / 1407025152 bytes. pass. |
| `ui-bench-mlx-vlm-kv-fixed.json`, `ui-bench-mlx-vlm-kv64.json` | 수정 후 KV256/APC=false/reset 확인. prompt16은 chat template 보다 짧아 exact prompt 구성에서 fail, 원본 보존. 별도 prompt64/generation8은 completion8/16·cache0·유한 timing, RSS575127552 / 575242240 bytes로 complete. |
| `ui-deep-mlx-vlm.json` | 동일 4bit weights의 MLX CPU/Metal full-vocabulary 비교 510 positions. median KL0.00010713571828091517, ratio0.9999340004355735, pass. |
| `ui-deep-vllm.json` | coverage partial, verdict unsupported. MLX 변환 weights는 비양자화 HF CPU reference 에 대응하지 않는다. full pass 가 아니다. |
| `ui-deep-llama.cpp.json` | CPU-only 에는 비교 backend 가 없어 unsupported. native Metal 심층 비교는 unrun. |
| `ui-native-history.json`, `actual-benchmark-content.csv`, `actual-benchmark-content.xlsx` | 실제 native journal 저장. 실제 WKWebView에서 제품 CSV/XLSX 생성 함수로 export 내용 생성, 실패행을 포함한 이력·header/9rows·ZIP CRC 확인. native 저장 picker/별도 Excel viewer는 미검증. |

RSS는 제품의 `pti_resident_size` process-group 측정이다. 독립적인 OS/Activity Monitor 대조는 unrun이며 모든 unified-memory GPU buffer를 포함한다고 해석하지 않는다. 공개 서비스 contract0.8.0/schema v2는 로컬 자동계약 검사만 수행했으며 공개 upload/수락은 미실행.

## 8. offline bundle·오류·보호

| archive | 실제 내용·SHA256 | 새로운 격리 홈에서의 결과 |
| --- | --- | --- |
| `llama-cpu-portable.zip` | b11460, dylib 포함 61 files, 24279253 bytes. `79a3c8b19dc1a2f23490d992ef7842b4c49eced048c331b3a974deb97ebcd2f9` | export/import/probe·고정 GGUF 응답/usage·stop pass. `logs/native-bundle-live.log`. |
| `vllm-portable.zip` | 174 wheels, 498797516 bytes. `7459d98c13d4aead780d2e97c7daedecc7ef0c004d3e3ac775e1fa59f5653e23` | offline import/healthy probe·고정 mlx-lm provenance·실제 text/cancel/restart/stop pass. `vllm-portable-live.json`, `logs/python-bundle-metal-fixed.log`. |
| `mlx-vlm-portable.zip` | 56 wheels, 190507043 bytes. `0e544ce217a914ae204e453081968bdd6e0c8f9a2857d9f7fe937b16ff74f919` | offline import/probe·실제 text/cancel/restart/stop pass. 전체 harness는 직접 file URI500으로 fail. `mlx-vlm-portable-live.json`, `logs/python-bundle-mlx.log`. |

`bundle-negative-results.json`은 실제 archive 복사본에서 wheel SHA256·x86_64 arch·cp311/cp312 ABI·Linux OS 불일치 거부를 확인했다. 실제 pip 자식 실행 중 SIGINT로 비성공 종료·자식/staging 정리·완료 설치 비공개를 확인했다. 기존 archive로 export 거부와 원본 archive의 내용 해시 불변도 확인했다.

`native-bundle-negative-results.json`은 실제 native archive의 LICENSE SHA256·arch·OS 불일치를 publish 전에 거부하고 원본을 보존했다. 외부 환경은 앞서 설명한 별도 venv에서 전체 파일 보호를 확인했다. native bundle 취소/active-server export/import 거부는 실제 실행하지 않았으며 자동회귀 검사의 성공을 실기기 성공으로 대신하지 않는다. import 후 STT/embedding은 미실행.

## 9. arm64 DMG

기존 `npm run package:tauri`로 source `f414544`에서 production frontend/CLI/app/DMG를 빌드했다. 근거는 `package-results.json`, `logs/package-inspect-native.log`다. DMG를 작업용 mountpoint 에 read-only/nobrowse로 mount 해 확인하고 detach 했다. Finder 설치나 quarantine 해제는 수행하지 않았다.

- `AioLM_0.3.1_aarch64.dmg`: 16747127 bytes, SHA256 `2eefbc835f70da6892b2e3549046f5c6048c1ebe6a9da12805faf4798133fb52`.
- GUI `aiolm`: arm64, SHA256 `e575f529c10c569ab08da3d319c61c5936dfbc00100bc203481f93a4cd04c79d`.
- CLI `aiolm-cli`: arm64, SHA256 `c60a5b13d4fde15c85dd9735a824fa0947d6a621c02b7d8c4bd6f47f9c838215`.
- identifier `com.aiolm.desktop`, version0.3.1. minimum OS13.3은 선언값이며 이 기기에서13.3을 검증한 결과가 아니다.
- `codesign --verify --deep --strict` 통과. GUI/CLI는 ad-hoc/runtime이며 Developer ID 와공증은 없다.
- 포함된 일반 파일은 Info.plist, CodeResources, GUI, CLI, icon.icns. fixture·관리형 환경·개인 설정은 없다. 실제 home/repository 문자열의 UTF-8/UTF-16 스캔에 일치 없음.
- 기존 설정이 없는 새 격리 홈에서 packaged CLI를 실행하여 onboarding=false, model/runtime 미선택, 모델 저장소가 해당 홈 안에 있음을 확인했다.
- 원본 복사본은 `tmp/macos-acceptance/package/`, build output은 Git 제외 대상 `.codex-target/release/bundle/`. production GUI의 자연스러운 Finder 실행은 unrun.

## 10. 남은 검사

- **별도 OS 계정에서 unrun:** 최초 GUI 실행, Keychain 승인/거부/갱신 재승인, 자연스러운 Finder 설치 실행, 실제 과거 버전 upgrade/legacy 이전. 현재의 격리 HOME 검사는 대체 근거가 아니다.
- **네이티브 조작 blocked:** MCP Yes/No→실제 tool→답변, IME composition, clipboard, 파일/문서/저장 picker, Dock/트레이 Show/Quit. 실제 WKWebView 문자입력·창 조작과 구분한다.
- **M05–M08의 unrun:** GUI v12→v13 이전값/backup 전체 확인, 모든 호환 option, 분할 GGUF/companion/외부 삭제/전체 APFS 조건, llama projector vision, MLX 모델별 native audio/video, Whisper 번역/Qwen3-ASR, ffmpeg 부재, 첨부 history/reload/retry/engine 변경, 개인화/skill, 문서 후보 선택·project file binding 전체.
- **M09–M10의 unrun:** 독립 OS RSS 대조, native Metal 심층 비교, helper 양쪽 backend 전체 단계, native 저장 후 viewer, imported STT/embedding, native bundle 실제 cancel/active-server 거부.
- **M12의 unrun:** ffmpeg/CMake, install/prepare/warmup/trial/replacement 모든 단계에서 소유 프로세스·port·staging 취소 행렬. 정상 quit 성공만으로 모든 취소 단계를 통과 처리하지 않는다.
- **실기기 없이 unrun:** Intel과 macOS13.3–15. 현재 결과로 다른 architecture/minimum OS 성공을 추정하지 않는다.
- **실제 fail 유지:** Metal/MLX 직접 URI 이미지 입력 500. upstream 동작, gateway 거부, 실제 이미지 내용 성공을 구분한다.
- Force Quit/SIGKILL 복구, 다른 사용자 single-instance 개선, Developer ID/공증, 공개 benchmark upload는 이번에 구현·검증하지 않았다.
