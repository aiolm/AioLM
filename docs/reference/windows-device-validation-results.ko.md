# Windows runtime adapter 검증 결과

## 실행 상태와 source

2026-10-15의 **진행 중인 실제 Windows 검증 기록**이다. W01–W08 전체 통과, G01–G07 구현 완료 또는 goal 완료를 뜻하지 않는다. 필수 실제 검사와 구조 구현이 남아 있으므로 종료 commit은 아직 지정하지 않는다. Linux/Mac 실제 실행은 이 Windows 작업의 후속 범위다.

- 시작 source: `df3264bad99deb0144b947f96300e8625f7a2da5`, `origin/codex/windows-runtime-adapter-handoff`의 필수 인계 commit 포함을 확인했다.
- 작업 branch: `codex/windows-runtime-adapter-validation`. 기존 변경과 사용자 설치·데이터를 보존했으며 원격 push는 수행하지 않았다.
- 현재 수정 checkpoint: `4d57c112dd7918ed5c9d6dcf73426d05e92a0a56`.
- 최신 production GUI/CLI는 `eb3b2bf4055db76d5181cbd5b496a5b8f366d47b`에서 Windows native로 재빌드했다. 별도 Python adapter helper는 `4d57c11`의 파일을 명시적으로 재등록한다. 두 실행 source를 같은 것으로 표시하지 않는다.
- raw: 저장소의 `tmp/windows-acceptance/`. 지속적인 재개 기록은 그 아래 `progress.md`다. raw·모델·개인 경로·프로필·토큰·build 산출물은 Git에 포함하지 않는다.

결과는 `pass`, `fail`, `unsupported`, `unrun`, `blocked`로 구분한다. 표의 `unrun`은 해당 묶음의 필수 검사가 남았다는 뜻이며 그 안의 이미 실행한 결과는 별도로 남긴다. 실패를 미지원으로 바꾸거나 다른 모델의 성공으로 덮지 않는다.

| 실행 산출물 | SHA256 |
| --- | --- |
| production GUI | `f914174a03893c747d7a8e126bd556c92f6433f6d04093fae9992d48bb57c652` |
| production CLI | `c39e2cb1f245e596892fdc617e3fa7d5f666a824217a51ea4e3cc9900db5eebc` |
| NSIS | `6bece1039c28a0c5362fcb0aaf23197d4eefe0bb4c7c28a78f9d857bbd6e83c2` |
| MSI | `9df152b4eaf59bc7e1f29e3205717eb662aac2199830921de19fa84720052cd7` |
| adapter helper (`4d57c11`) | `30191bcc9f6d39795235466e39d8a81be1c431bfe667cef984a92f210aee1847` |

## 기기와 격리

| 항목 | 실제 기록 |
| --- | --- |
| OS | Windows 11 Pro 25H2, x64, build 10.0.26200.9550 |
| CPU / RAM | AMD EPYC 4585PX, 16 core / 32 thread; 67,782,369,280 bytes |
| GPU | AMD Radeon AI PRO R9700 두 장, 각각 32 GiB |
| driver | 32.0.31036.15, 2026-08-12 |
| Vulkan | API 1.4.349, driver 2.0.395 |
| 설치된 HIP SDK | 7.2.60201; 전역 SDK/driver 설정을 변경하지 않음 |
| WebView2 | 155.0.4283.45 |
| Node / npm | 22.23.2 / 12.0.2 |
| Rust | rustc/cargo 1.98.0, rustfmt/clippy |
| Python | native CPython 3.12.10 x64, 작업 전용 venv |
| Build tools | VS Build Tools 2022 17.14, MSVC 14.44.35207, Windows SDK 10.0.26100, CMake 3.31.6-msvc6, Ninja 1.12.1 |

GUI/CLI 검사는 `AIOLM_HOME`뿐 아니라 HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG/WebView2 profile도 임시 디렉터리로 분리한다. 최초 harness의 OS profile 격리 누락으로 실제 legacy 설정이 임시 홈에 복사된 실행은 무효화했다. 원본 데이터의 이동·수정은 없었으며 해당 임시 복사본만 정리하고 격리된 새 실행으로 다시 검사했다. 실제 최초 OS 실행·설치·업그레이드·제거·Credential Manager 검사는 기존 설치를 보호할 별도 테스트 OS 세션이 필요하다.

## W01–W08 checkpoint

| ID | 상태 | 실행 근거와 다음 필수 작업 |
| --- | --- | --- |
| W01 | pass | 기준 공통 20개 명령과 native CLI smoke를 실행했다. D01/D02 수정 후 재검사 통과. 최신 전체 source의 최종 공통 검사는 모든 구현이 끝난 뒤 다시 필요하다. raw `w01/results.tsv` 및 개별 로그 |
| W02 | blocked | 격리 CLI 12개 검사와 실제 GUI onboarding/폴더 선택 pass. v13 backup/round trip·미등록 engine 보존·미래 schema 거부를 확인. 실제 OS 최초 실행·기존 설치 이전/자격 증명은 별도 OS 세션 대기 |
| W03 | unrun | CLI 26개 등록/변조/삭제/재등록 검사 pass, 최신 CLI/helper로 새 격리 홈에서 26개 재검사 pass(`w03/run5-package3`). 실제 GUI 합성 네 번째 엔진 등록·직접 argv·artifact 변경 거부 pass. D08의 Strata DLL 변조 전후 실제 CLI 검사 pass. GUI의 늦은 probe 경합·취소와 최종 G source 재검증 필요 |
| W04 | unrun | 개인 CPU llama.cpp CLI A01–A09, 내장 CPU/Vulkan GUI 응답·usage·취소/Retry·재시작/Quit pass. 고정 Strata native GUI 응답·취소/Retry·normal Quit pass. 개인 build의 최종 GUI 흐름과 새 production 재검증, ROCm numerical gate 및 실제 응답이 남음 |
| W05 | unrun | 실제 GUI/Strata와 synthetic stdio MCP에서 승인·거부·호출 중 취소·입력과 다른 반환값 후속 답변 pass. native GUI의 rich/error/call ID 보존 pass. 지원 모델의 실제 미디어 내용·첨부 순서·재로드와 취소 복구 수정이 남음 |
| W06 | unrun | 실제 프로젝트/RAG·STT 연결·멀티 세션·gateway 인증/라우팅 검사가 남음 |
| W07 | unrun | Unicode/공백 경로와 hostile 값의 단일 argv, runtime 설치 취소의 staging 정리, load/stream 취소 및 normal Quit의 소유 job/port 정리 pass. import/build/tool/benchmark 실패·취소, 다른 프로세스 보호의 남은 실제 흐름 필요 |
| W08 | blocked | 최신 native production GUI/CLI와 NSIS/MSI 빌드 pass. 패키지 설치→응답→재로드→업그레이드/제거는 별도 OS 세션 대기. IME 실제 composition·clipboard/tray/알림·지원 runtime 새 홈 portable 후 추론도 남음 |

Windows native의 MLX·표준 vLLM·Metal 실제 추론은 현재 local runtime 플랫폼 계약상 `unsupported`다. 값 보존·명시적인 거부는 별도의 Windows 공통 검사이며 Linux vLLM과 Mac MLX/Metal의 실제 추론 성공으로 기록하지 않는다. WSL 실행은 이번 Windows native 성공 근거가 아니다.

## 실제 엔진과 합성 결과

### llama.cpp

개인 CPU build는 source `14310190cd0a0c831fe949ac8cbedd8abdc90695` / b11617 / MSVC로 Windows에서 새로 빌드했다. `llama-server.exe` SHA256은 `465276c17a02a113b62c9c6be51660f44506b63a0de40e98ef09eb1957188e7b`다.

- Qwen/Qwen2.5-0.5B-Instruct-GGUF revision `9217f5db79a29953eb74d5343926648285ec7e67`, Q4_K_M SHA256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`: 개인 엔진의 격리 CLI A01–A09 pass.
- Qwen/Qwen3-1.7B-GGUF revision `90862c4b9d2787eaed51d12237eafdfe7c5f6077`, Q8_0 SHA256 `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a`: 내장 CPU GUI의 `2+3` 답변 `5`와 usage, 긴 생성 취소·Retry 및 정상 종료/재시작 pass. 명시적으로 고른 Vulkan GPU0에서 한국어 `7×6` 답변 `42` pass. Unicode 입력 주입을 실제 IME composition 검사로 확대하지 않는다.
- 공식 ROCm b11617 archive에는 필요한 hipblas DLL이 없고 설치된 HIP7.2와 다른 DLL byte identity를 가진다. SDK 혼합을 거부하고 staging을 정리한 동작은 pass이며 해당 archive의 실제 추론은 blocked다.
- 같은 llama.cpp source와 HIP7.2/gfx1201로 만든 개인 native ROCm bundle은 D05 수정 후 clean export/import/probe pass. ZIP SHA256 `9feb7404e89ff6b53aa281408032dde7e17e67be421055a198e76799d0cabf8a`, 588,299,928 bytes, payload 2,759 files. 실제 numerical gate/추론은 unrun이며 두 GPU gate 실패를 다른 배치의 성공으로 대체하지 않는다. 짧은 격리 홈으로 vendor MAX_PATH 조건을 만족해야 한다.

### Strata

고정 source `296b59d2f73c8f04a805df29c2fa97655adace78`, tag v0.1.44.1의 Windows x64 HIP release를 사용했다. archive SHA256 `e40bce7a2cfe47ea42d3f2af1e0adb92d14b8c02a29107c5a309b2cb518f5f52`, native `strata.exe` SHA256 `c4709f17ef974ffa34af4f0c357160a89249cabf6e9a698fbe6d0dc65a3243fa`다. bundle HIP는 10.2.0a20260930이며 host HIP7.2와 혼합하지 않았다. 고정 문서·자체 `--check`로 실제 R9700/63 GiB 조건을 확인했다.

모델은 ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF revision `5348543e0147355ac9cbcb031184a3546350988e`의 IQ1_M이다. 두 shard를 독립적으로 다시 hash하여 고정 LFS와 대조했다.

| 파일 | SHA256 | bytes |
| --- | --- | --- |
| IQ1_M shard 1 | `e11083ba855e7666b48ea3f2db6a9c3a20c18751a012cc24f948de91b7087fad` | 29,608,446,496 |
| IQ1_M shard 2 | `316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113` | 28,800,138,432 |

MTP source는 Qwen/Qwen3.8-Flash-Next revision `de4b8e4d43b917e7706784d8bb445c9af86a3540`이며 생성된 MTP·pack·tokenizer의 파일별 SHA256는 raw에 보존한다. upstream 원본 구성 대신 별도 deployment JSON을 사용하고 saved API key·lazy loading·독립 MCP·before-load 명령을 사용하지 않는다. Windows MAX_PATH 때문에 작업 범위에 한정된 임시 drive alias로 실행했으며 시스템 설정을 바꾸지 않았다.

actual production GUI → venv launcher → native interpreter → strata.exe에서 GPU0 R9700의 모델 준비와 새 응답을 확인했다. `17×3` 요청은 `51`, PP81/1,318.1ms/61.5tok/s, TG52/482.4ms/107.8tok/s, TTFT1,346.1ms, finish `stop` 및 2개 저장 메시지였다. 긴 생성의 취소는 추론 텍스트 6,204자를 보존했다. Retry는 같은 4개 메시지에서 새로 생성했고 별도 취소 후 새 TTFT/추론 내용을 저장했다. trailing engine usage가 없는 취소 응답에 측정값을 만들어 넣지 않았다. normal Quit 이후 앱·두 Python·엔진 및 소유 listener가 모두 사라졌다. raw `strata-native/logs/17–21` 및 engine 로그가 근거다.

처음 GUI 요청이 막힌 이유는 기본 `cors_origins`의 빈 목록이었다. 별도 구성에 실제 production origin `http://tauri.localhost` 하나를 지정한 뒤 같은 모델 Retry가 성공했다. unrelated origin에 CORS allow가 없고 잘못된 API key는 401이었다. 연결 계약은 [Strata 안내](runtime-adapter-handoff.ko.md#원본-strata-및-개인-엔진)에 반영했다. 새 production binary 재시작에서 선택한 model/runtime/profile과 대화 이력이 보존됐고 auto-start가 없었다. 바뀐 helper는 artifact 변경으로 거부됐으며 명시적인 제거·재등록 뒤에도 선택값을 유지했다. 같은 모델의 native 재시작과 reasoning 생성 중 `Generating` 표시, 취소/부분 저장을 재검증했다.

### 합성 fixture

`custom.synthetic-w`는 opaque 모델 파일과 고정 응답을 갖는 Python bridge다. 실제 native GUI 등록·hash 변조 거부·프로필 저장·직접 argv·readiness/HTTP/SSE·Retry·이력 보존의 근거이며 모델 추론 능력의 근거가 아니다. Unicode/공백 경로와 shell 문자가 든 값을 하나의 argv 요소로 전달했다. 재등록한 synthetic-1.1-cors의 응답은 `synthetic fixture answer`, 저장 메시지는 2개, TG4였으며 PP는 제공되지 않았다.

### MCP 실제 공통 흐름

고정 Strata 모델과 작업 전용 synthetic stdio MCP 서버를 실제 production GUI에서 연결했다. discovery 이후 자식 프로세스가 종료됐고, 승인 전과 거부 뒤에는 `tools/call`이 없었다. GUI 검토와 native 일회 승인 후 `indigo-912` 입력의 실제 반환값 `synthetic result: amber-7319`를 모델이 그대로 후속 답변으로 사용했다. 요청·반환의 JSON-RPC ID가 일치했고 결과/usage/2개 메시지를 저장했으며 stdio 프로세스가 정리됐다. 모델 추론은 실제 엔진이며 도구의 업무 데이터는 합성이다.

별도 45초 slow 도구 호출을 실제로 시작한 뒤 GUI Stop을 눌렀다. launcher와 interpreter 두 MCP 프로세스가 사라졌고 늦은 응답/모델 후속 요청이 없었으며 Strata의 세 소유 프로세스는 유지됐다. 취소 뒤 UI는 `MCP response incomplete` 상태였다. 이 상태에서 Retry가 보이지 않는 복구 문제는 수정 대상으로 남아 있다.

명시적으로 raw 도구 이름을 지시한 첫 lookup 요청에서는 모델이 제공된 function ID 대신 `synthetic_lookup`를 반환했다. 앱은 unapproved tool로 거부했고 호출은 없었다. 이 모델 응답 실패를 삭제하지 않고 별도 자연어 요청의 승인/후속 성공과 구분한다. 검사 중 처음 자동 선택된 lookup을 해제한 선택 오류도 raw에 기록했으며 제품 ID 매핑 결함으로 계산하지 않았다. raw `strata-native/logs/24–27`, `w05-mcp-native.jsonl`이 근거다.

fixture 2-rich의 실제 native 관리 GUI에서 단일 text와 embedded resource의 `uri`·`mimeType`·resource text, `isError: false`를 보존했다. 별도 실행 오류는 정확한 error text와 `isError: true`로 보존됐고 각 요청/반환의 call ID가 일치했다. 응답 뒤 MCP child는 0이었다. 이는 [협상한 MCP 2024-11-05의 tool result/error 계약](https://modelcontextprotocol.io/specification/2024-11-05/server/tools)을 검사한 결과이며 rich resource를 모델이 실제 이미지·음성으로 이해했다는 뜻이 아니다. raw `strata-native/logs/28–29`와 stdio transcript가 근거다.

## 재현 결함과 수정

| ID | 제품/검사 문제와 수정 | 검증 및 commit |
| --- | --- | --- |
| D01 | Windows drive anchored 이름을 portable capture 경계 밖으로 허용하던 경로 검사 수정 | Python 회귀 pass, `50b87ec` |
| D02 | synthetic ZIP timestamp 때문에 checksum 검사가 변하는 fixture | 수정 전 3/30 fail, 수정 후 0/30; `2191a4f` |
| D03 | harness의 OS profile 격리 누락 | 오염 실행 무효화·원본 보존·격리 새 홈 재검사; `f4bbaca` |
| F1 | 개인 llama.cpp manifest가 native shared libraries를 hash하지 않음 | DLL 사본 변조 거부·기존 등록 검사 pass; `0c7ba10` |
| D04 | venv launcher의 자손 listener를 소유 job으로 인정하지 못해 readiness 정체 | exact Windows job membership 검사·다른 job 보호 회귀·실제 GUI fixture/Strata 준비 pass; `71a2e49` |
| D05 | CRT prefix 비교가 DebugCRT/CLR 파일까지 portable runtime에 포함 | 정확한 retail DLL 선택·기존 오염 runtime 거부·114 module tests/2 live ignored·clippy·clean export/import/probe pass; `a42ab63` |
| D06 | Strata native version probe에 deployment library paths 누락 | host env를 보존한 child env, 6 helper tests 및 동일 native probe pass; `21f56ae` |
| D07 | reasoning/tool 토큰을 생성 중에도 composer가 첫 토큰 대기로 표시 | 실제 GUI 재현, 수정 전 2 regression fail, 수정 후 관련 29 tests/typecheck/lint pass; `eb3b2bf`. 새 production의 같은 Strata reasoning stream에서 Generating·취소/저장 pass |
| D08 | Strata의 DLL/tokenizer 보호 누락과 upstream test 개수에 따른 artifact 한도 | 7 helper tests, 실제 native CLI engine 사본의 수정 전 변조 허용 fail→수정 후 probe/start 거부 pass, 원본 보존; `4d57c11` |

재현된 runtime 선택 오류의 raw 문구, 삭제/재등록 후 Deep verification의 오래된 metadata, 사라진 Tuning 동선 안내, 앱 재시작 후 저장된 중단 응답에서 Retry가 사라지는 복구 동선, MCP 호출 취소 뒤 Retry 부재는 현재 unresolved다. 이번 G07 구현/재검증에 포함하며 단순 제안으로 완료 처리하지 않는다. 재시작 전 일반 생성 Retry의 성공과 다른 복구 동선의 문제를 구분한다.

## G01–G07과 후속 인계

| ID | 상태 | 남은 실행 |
| --- | --- | --- |
| G01 | unrun | versioned 공통 option schema와 호환 계약 구현 |
| G02 | unrun | 실제 help 실행 수명·cache identity·diff·취소/경합 구현 및 검사 |
| G03 | unrun | deterministic help parser와 검증된 보강 metadata 구현 |
| G04 | unrun | 공통 renderer/validator/profile/argv serializer 통합 |
| G05 | unrun | executable/entry point→help→binding/protocol→Ready 여정 구현 |
| G06 | unrun | 열린 adapter 목록과 공통 제품 동선/기능 보존 |
| G07 | unrun | 재현된 UX 결함 수정·접근성/작은 창/대량 옵션·고정 binary의 미지 flag 실제 수락 |

기존 manifest v1 옵션 UI와 이번 최소 결함 수정을 G01–G07 전체 구현으로 계산하지 않는다. 설치 세션의 외부 차단과 독립적인 구현/검증은 계속 진행한다.

Windows의 필수 구현·검증·작업별 commit이 끝나면 실제 종료 commit과 Git 상태를 여기에 고정한다. 그 commit을 Linux `codex/linux-runtime-adapter-validation`에서 받아 [L01–L04](windows-device-handoff.ko.md#7-linux에서-이어서-검증)를 실행하고, 이후 Mac `codex/macos-runtime-adapter-revalidation`에서 [M01–M04](windows-device-handoff.ko.md#8-mac에서-최종-재검증)와 [잔여 R01–R13](macos-device-validation-remaining.ko.md)을 실행한다. 각 OS는 자체 binary/venv를 새로 만들고 W/G의 공통 schema·profile·argv·probe 경합 검사를 함께 수행한다. 후속 OS의 공통 수정은 영향을 받은 앞선 OS 검사를 재실행하는 조건으로 인계한다. 현재 checkpoint를 검증 완료한 Windows 종료 commit으로 사용하지 않는다.
