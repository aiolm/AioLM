# llama-board 제품·구현 계획

이 문서는 llama-board의 현재 구조를 기준으로 사용자 요구사항, 안전성 정책, 출시 절차를 한 문서에서 추적하는 실행 계획이다. 제품은 Tauri v2 + React/TypeScript 기반의 로컬 우선 데스크톱 앱이며, llama-server·llama-bench와 관리 런타임을 GUI에서 직접 실행한다. 표준 OS 경로는 런타임 저장에 필요할 때만 사용하고, 모델·GPU·조직·사용자에 대한 임의의 기본값은 제품에 포함하지 않는다.

## 1. 제품 목표와 범위

llama-board는 다음 흐름을 하나의 안전한 작업 모델로 제공한다.

1. 사용자가 모델 디렉터리를 선택하고 primary GGUF를 고른다.
2. 필요하면 같은 세션에 멀티모달 projector(mmproj)와 speculative decoding용 draft bundle을 붙인다.
3. 호스트 GPU와 llama.cpp 런타임의 호환성을 확인하고, 사용자가 지정한 GPU 배치를 검증한다.
4. 터미널 창 없이 서버·벤치마크·런타임 설치·PR 빌드를 실행하고 진행률, 로그, 취소 결과를 GUI에 보여 준다.
5. 모델별 튜닝 프로필을 저장하고 재현 가능한 세션으로 다시 시작한다.

현재 코드에는 AppConfig(schema v9), 단일 서버의 상태/health 확인, %APPDATA%\\llama-board\\ 설정·런타임 저장, 런타임 preflight와 PR provenance, 실행 프로필(localStorage v2), 벤치마크 취소 PID 추적이 있다. 아래 계획은 이 기반을 깨지 않고 다중 세션·안전한 GPU 배치·부분 결과·중립 기본값을 완성하는 순서다. 정적 Claude 감사에서 확인된 회귀 위험은 각 단계의 acceptance gate와 명령으로 검증한다.

## 2. 도메인 계약

### 2.1 세션 모델: primary + optional mmproj + optional draft bundle

세션은 디스크에 저장되는 정의와 실행 중에만 존재하는 프로세스 상태를 분리한다.

| 구분 | 저장 정의 | 실행 상태 |
| --- | --- | --- |
| 식별 | id, 사용자 표시 name, enabled | lifecycle, PID, 시작 시각, 마지막 오류 |
| 모델 묶음 | primary_model(필수), mmproj(선택), draft(선택) | 실제 로드 모델, projector, draft 로드 여부 |
| draft bundle | draft GGUF와 spec_type, n-max/min, p-min/split, draft NGL/device 등 speculative 설정 | draft 초기화/실패 원인 |
| 실행 환경 | 런타임 backend/build, GpuPlacement, 포트 정책 | child handle, API key, stderr ring, active request 수 |
| 리소스 | 프로필 ID, 요청 timeout, idle unload 정책 | 모델·KV·projector·adapter 메모리 추정 |

primary가 없으면 세션을 시작할 수 없다. mmproj는 primary와 별개로 검색·선택하되 세션에 귀속하며, 이미지 요청 중 projector를 교체하지 않는다. draft bundle이 비어 있으면 speculative decoding을 끄고, draft 모델만 있거나 필수 speculative 값이 누락된 정의는 저장 전에 오류로 표시한다. 파일은 존재·일반 파일·허용 확장자를 시작 전에 다시 검증한다.

현재 AppConfig에 있는 sessions, SessionModels, GpuPlacement는 저장 계약의 출발점이다. 다음 구현에서는 UUID 기반 SessionManager를 추가하여 실제 프로세스 레지스트리를 세션 ID로 키운다. 기존 active_model·mmproj·active_backend·active_build 명령은 기본 세션을 가리키는 호환 facade로 남겨 구버전 UI와 CLI가 한 번에 깨지지 않게 한다.

### 2.2 안정적인 GPU 배정

device_profile은 GPU마다 vendor, 이름, VRAM, driver, integrated 여부와 hardware::GpuDevice::stable_id를 반환한다. 세션에 저장하는 것은 열거 순번이나 단순 PCI chipset 번호가 아니라 stable ID다.

- gpu_ids는 llama.cpp --device 순서를 나타낸다.
- main_gpu는 gpu_ids 중 하나만 허용한다.
- split_mode는 none·layer·row, tensor_split은 같은 순서의 비율 배열이다.
- draft_gpu_id는 draft bundle을 별도 GPU에 둘 때만 사용한다.
- 저장된 stable ID를 현재 호스트의 backend 장치명(예: CUDA/Vulkan 표기)으로 바꾸는 것은 시작 직전에만 한다.
- 장치가 사라졌거나 backend가 지원하지 않으면 다른 GPU로 조용히 바꾸지 않는다. 시작을 보류하고 누락 ID와 대체 선택 UI를 보여 주며, 사용자가 “중립 기본 배치로 실행”을 명시한 경우에만 placement를 비운다.
- 모든 필드가 비어 있으면 --device, --main-gpu, --split-mode, --tensor-split, draft-device를 넣지 않아 llama.cpp 기본 동작을 보존한다.

하드웨어가 바뀐 뒤에도 같은 물리 장치를 가리키는지, 동일 칩셋 카드 두 장을 구분하는지, 0/1/2개 이상의 GPU와 integrated GPU 조합에서 argv가 안전한지를 단위 테스트와 실제 preflight로 확인한다.

### 2.3 세션 lifecycle 정책

상태는 stopped → starting → running → stopping → stopped와 failed·crashed 종단 상태를 명시한다. active_requests, idle 시간, PID, endpoint, bounded log tail을 상태 응답에 포함하고, 예상하지 못한 child 종료는 crashed로 분류한다.

기본 정책은 기존 단일 서버 사용자를 보존하기 위해 stop_existing_sessions_on_load = true다. 새 세션을 시작할 때 다른 실행 세션을 먼저 중지하고, 사용자가 이 값을 끄면 동시 실행을 허용하되 포트·GPU·메모리 충돌을 사전 검증한다. 앱은 자동으로 서버를 시작하지 않는다.

- 다른 모델/세션으로 전환하거나 server-side 튜닝을 적용할 때 active chat/request가 있으면 영향을 설명하는 인라인 확인을 먼저 받는다.
- stop은 새 요청을 막고 진행 중인 요청을 취소·대기한 뒤 제한 시간 안에 child와 descendant를 종료하고 reap한다.
- unload는 세션의 모델 리소스와 API key 파일을 정리하지만 저장된 세션 정의는 지우지 않는다.
- sleep_idle_seconds > 0이면 active request가 없고 idle 시간이 임계값을 넘은 세션만 자동 unload한다. -1은 자동 unload를 끈다.
- runtime 선택·삭제·import/export와 모델 파일 삭제는 실행 중인 세션과 충돌하므로 중지 후에만 허용한다.
- 창 닫기/RunEvent::Exit에서는 gateway, benchmark, runtime build/install, 모든 server child를 순서대로 취소·종료하고 로그 reader를 join한다. orphan 프로세스와 임시 API key/압축 파일을 남기지 않는다.

### 2.4 터미널 없는 작업, 취소, 부분 벤치마크

서버, bench, runtime probe/install/import/export, PR preflight/build, Hugging Face 다운로드는 공통 operation_id, phase, progress, started/finished/cancelled 상태를 사용한다. 동시에 하나만 실행해야 하는 작업은 backend guard와 UI disabled 상태로 중복 클릭을 막고, 앱 셸의 전역 작업 표시줄에서 어느 탭에서도 상태와 취소 버튼을 노출한다.

- Windows child는 CREATE_NO_WINDOW(또는 동등한 no-console 생성 플래그)를 사용하여 콘솔 창을 만들지 않는다. Unix child는 독립 process group으로 만들고 group 단위로 종료한다.
- stdout/stderr는 항상 drain하며, 로그는 bounded ring/tail로 제한하고 API key 같은 비밀은 redaction한다.
- 취소·timeout·앱 종료는 직접 child만이 아니라 descendant까지 종료하고, reader join/reap 후 staging, 다운로드 zip, API key 파일을 정리한다.
- runtime build/install은 취소 지점을 다운로드·압축 해제·preflight·configure·compile·commit마다 둔다. commit 전 취소는 destination을 노출하지 않으며, 실패/취소 뒤 재시도 가능한 상태를 남긴다.
- server 시작은 health가 실제 관리 child의 listener임을 확인해야 성공으로 바뀐다. 다른 프로세스가 점유한 포트의 200 응답은 성공으로 취급하지 않는다.
- benchmark runner는 stdout을 줄 단위로 파싱하여 benchmark-row 이벤트를 즉시 발행한다. 결과 계약은 status(completed/cancelled/failed), 이미 파싱된 rows, elapsed, stderr tail을 함께 반환한다. 취소해도 앞서 보인 행과 history snapshot은 보존하고, “취소됨”과 “실패”를 혼동하지 않는다.
- benchmark child PID는 취소 명령과 종료 hook에서 사용할 수 있어야 하며, pipe reader가 끝날 때까지 파일·상태를 정리한다. 새 실행은 이전 실행의 부분 결과를 덮어쓰지 않고 별도 기록을 남긴다.

## 3. 탭·상태·경고 모델

탭 전환은 작업 취소가 아니다. App shell의 전역 store가 server/session/task/benchmark 상태를 보유하고, 패널은 hidden/mounted 상태가 바뀌어도 operation_id로 다시 구독해 현재 진행률과 부분 결과를 복원한다.

- 마지막 top-level tab와 Models/Developer 하위 탭, 선택 세션, 선택 프로필은 버전이 있는 localStorage 상태로 저장한다.
- benchmark history와 취소된 실행의 부분 rows는 terminal event마다 snapshot하고 앱 재시작 뒤에도 읽을 수 있게 한다. 민감한 경로·token은 저장하지 않거나 표시 전에 normalize/redact한다.
- 탭을 옮길 때는 경고하지 않는다. 취소가 불가능한 외부 작업, 앱 종료, 모델/세션 전환, runtime 삭제·교체, 열린 chat을 끊는 restart처럼 실제 손실이 있는 동작에만 경고한다.
- 경고에는 작업 이름, 이미 완료된 부분, 취소/계속 선택지를 명시한다. 단순한 panel unmount 또는 lazy loading은 경고 사유가 아니다.
- backend가 다시 연결되면 진행 중 operation을 재조회하고, terminal 상태가 없을 때만 “상태 확인 필요”를 표시한다. 탭별 polling이 중복 요청을 만들지 않게 한다.

## 4. 중립 기본값과 보안 경계

첫 실행 기본값은 다음과 같이 모델·조직·장치에 중립적이어야 한다.

- models_dir = "", active_model = "", mmproj = "", draft model/device = "".
- active_backend = "", active_build = "", GpuPlacement의 모든 필드는 비어 있으며 host/runtime가 선택할 때까지 강제 GPU flag를 만들지 않는다.
- 튜닝 기본값은 llama.cpp의 안전한 공통값(ctx_size=4096, ngl=0, flash_attn=auto, threads=0, 샘플링 temperature=0.8, top_p=0.95, top_k=40)을 사용하고, 호스트 GPU에 맞춘 자동 추천은 정보로만 표시한다.
- 설정·managed runtime은 %APPDATA%\\llama-board\\ 아래에 저장한다. Windows runtime fallback에 필요한 %LOCALAPPDATA%와 Unix/macOS의 home/XDG 경로는 OS가 제공하는 위치로만 사용한다.
- 모델 디렉터리를 자동으로 특정 사용자·개발 도구의 경로로 채우지 않는다. 첫 Models 진입에서 폴더 선택을 유도하고, CLI에서는 models_dir를 명시하게 한다.
- Cargo authors, Tauri identifier, release/signing URL, 주석과 예제에는 개인 사용자명·조직명·개인 모델 경로를 넣지 않는다. 제품 identifier는 com.llamaboard.desktop, 공개 저장소/릴리스 참조는 https://github.com/llama-board/llama-board를 기준으로 한다.
- loopback endpoint, per-start API key, env allowlist, log redaction은 유지한다. 외부 endpoint나 사용자가 선택한 Hugging Face/PR source만 네트워크로 접근한다.

## 5. 튜닝 모드와 프로필

Tuning은 사용자가 원하는 안전성과 제어 범위를 분리한다.

1. **간편 모드**: 검증된 field/select/slider만 노출한다. server-side(ngl, context/batch/cache, threads, flash attention, MoE, GPU placement, draft)와 request-side sampling(temperature, top_p, top_k, reasoning/chat 옵션)을 그룹으로 나눈다.
2. **고급 모드**: raw server_args와 JSON chat_options를 편집할 수 있지만, app-managed 옵션(모델, API key, mmproj, GPU, draft 등)은 중복 지정할 수 없고 schema/크기/민감값 검증을 통과해야 저장한다.

server-side 변경은 dirty로 표시하고 Apply & Restart 시에만 실행 중 서버에 반영한다. sampling/chat 변경은 debounce 저장 후 다음 요청에 적용하며 restart를 요구하지 않는다. profile 적용 시 어떤 값이 restart 필요인지와 열린 chat이 끊기는지를 먼저 보여 준다.

프로필 저장소는 기존 localStorage model profile 구조를 버전업 가능하게 유지한다.

- 여러 server profile과 모델별 여러 model profile을 저장·복제·삭제한다.
- 모델 경로별 default profile을 하나 지정하며, 모델을 바꾸면 그 모델의 default를 우선 선택한다.
- server profile에는 runtime, server-side, mmproj/draft/GPU 정책을, model profile에는 sampling, reasoning, stop strings, chat options을 담는다.
- profile 적용은 config 파일의 단일 source of truth와 충돌하지 않게 patch를 만들고, 비밀/credential-like raw arg는 저장하지 않는다.
- 구버전 profile은 필드 기본값으로 읽고 한 번만 새 schema로 다시 쓴다. 유효하지 않은 값은 중립 기본값으로 되돌리고 사용자에게 알린다.

## 6. 설정·identifier 마이그레이션과 rollout

### 6.1 설정 마이그레이션

현재 config schema v9 및 기존 단일 설정을 다음 규칙으로 한 번만 마이그레이션한다. 새 세션 런타임 필드가 추가되면 다음 schema 번호를 올리고, 미래 버전은 읽기/덮어쓰기를 거부한다.

1. v0~v8의 typed 값과 legacy server_args를 먼저 복원한다. 명시된 JSON field가 raw arg보다 우선하고 app-managed duplicate는 제거/거부한다.
2. 기존 active_model을 primary로, 기존 mmproj를 optional projector로, spec_draft_model과 speculative fields를 draft bundle로 옮긴 default 세션 하나를 만든다.
3. 기존 gpu를 default 세션의 placement로 옮긴다. GPU 정보가 없으면 빈 placement를 보존한다. stable ID를 만들 수 없는 옛 숫자 index는 자동 remap하지 않고 확인 필요 상태로 표시한다.
4. active_backend/active_build는 default 세션 runtime으로 연결하고, 한 쌍만 존재하거나 managed binary가 없으면 빈 선택으로 만들되 원본 config를 백업한다.
5. stop_existing_sessions_on_load는 누락 시 true로 두어 단일 서버 동작을 보존한다. 명시된 false는 존중한다.
6. models_dir가 특정 개인 경로였던 기존 사용자의 값은 사용자가 직접 지정한 설정으로 보존할 수 있지만, 새 설치 기본값은 빈 문자열이다. 마이그레이션이 임의 경로를 새로 만들거나 개인 경로를 문서/소스에 복사하지 않는다.
7. 저장 전 atomic write와 .bak 복구를 사용하고, migration 완료 후 config_version과 migration marker를 기록한다. 실패하면 원본을 보존하고 읽기 전용 오류를 보여 준다.

### 6.2 배포 단계

| 단계 | 산출물 | 종료 조건 |
| --- | --- | --- |
| A. 중립화 | Cargo/Tauri/release/signing/docs와 예제에서 개인 식별자·모델 경로 제거 | JSON/TOML/XML parse 및 scoped grep 통과 |
| B. 계약 고정 | session bundle, stable GPU, lifecycle/task/bench result schema | Rust/TS contract tests와 v0~v9 migration tests 통과 |
| C. 프로세스 안전성 | no-console, process group/tree kill, reader join, temp cleanup | cancellation/timeout/exit leak tests 통과 |
| D. UI rollout | Models/Runtime/Tuning 전역 작업 표시줄, 탭 persistence, selective warnings | tab switch 중 작업 지속·경고 matrix 통과 |
| E. 다중 세션 | default facade를 유지하며 session list/start/stop/unload와 conflict 확인 추가 | primary/mmproj/draft + 0/1/2 GPU acceptance 통과 |
| F. release | identifier 변경과 shared %APPDATA% 보존, SignPath artifact 경로/URL 검증 | unsigned bootstrap 또는 SignPath signed installer smoke 통과 |

identifier 변경은 앱 번들 식별자만 바꾸며 사용자 설정과 runtime을 삭제하는 migration이 아니다. 설치/업데이트 전후에 %APPDATA%\\llama-board\\config.json과 runtimes\\가 유지되는지 확인하고, 이전 uninstall entry를 함부로 지우지 않는다. release note와 설치 문서에는 “공유 설정 디렉터리를 삭제하지 말 것”과 schema backup/복구 절차를 명시한다.

## 7. 수용 기준

### 기능·안전성

- primary만, primary+mmproj, primary+draft bundle, 세 요소 모두의 세션을 저장·로드·시작·중지·unload할 수 있다. 잘못된 companion, 없는 파일, 충돌 포트는 시작 전에 설명 가능한 오류가 된다.
- stable GPU ID가 재시작·동일 칩셋 다중 카드에서도 같은 물리 장치를 가리킨다. 0/1/2개 이상 GPU, integrated GPU, 누락 GPU에서 자동 오배정이 없다.
- 기본 stop-existing 정책과 명시적 다중 세션 정책이 지켜지고, active request/chat을 끊는 동작은 확인 후 실행된다. crash/timeout/exit 뒤 server·gateway·bench·runtime build descendant가 남지 않는다.
- server/bench/install/probe/build/download에 콘솔 창이 생기지 않고, 취소 후 reader·child·staging·zip·API key가 정리된다.
- benchmark가 실행 중 parsed row를 보이고, 취소 시 cancelled + partial rows와 history가 보존되며, 실패/취소/완료를 구분한다.
- 탭 이동은 진행 작업을 중단하지 않으며 마지막 탭·하위 탭·세션·profile과 부분 history를 복원한다. 실제 손실 가능성이 있는 동작만 경고한다.
- 간편/고급 튜닝 모드, restart 적용과 next-request 적용의 차이, server/model default profile이 모두 표시되고 저장된다.
- 새 설치 모델 디렉터리와 GPU/runtime 선택이 비어 있고 개인 사용자명·조직명·개인 경로가 release metadata, docs, smoke instructions에 없다.

### 회귀·출시

- 기존 config의 값과 single-server facade가 보존되고, migration은 한 번만 수행되며 invalid/future schema는 원본을 잃지 않는다.
- managed runtime의 preflight/provenance/digest/SignPath artifact 검사가 그대로 통과한다. release는 product name/version/file names를 일치시키고, 서명되지 않은 경우에도 명시적으로 표시한다.
- 아래 정적·동적 검증 명령이 모두 통과하고, 실제 모델 smoke는 명시적으로 opt-in한 환경에서만 실행한다.

## 8. 검증 명령

저위험 정적 검증:

```powershell
# Tauri JSON
Get-Content -Raw src-tauri/tauri.conf.json | ConvertFrom-Json | Out-Null
Get-Content -Raw src-tauri/tauri-cli-build.conf.json | ConvertFrom-Json | Out-Null

# Cargo TOML/lock metadata
cargo metadata --locked --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 | ConvertFrom-Json | Out-Null

# SignPath XML
[xml](Get-Content -Raw .signpath/artifact-configurations/windows-release.xml) | Out-Null

# In-scope neutralization: this must print no matches.
git grep -n -I -E '<personal-user>|<personal-organization>|C:\\Users\\<personal-user>' -- IDEA.md 'README*.md' 'docs/**' src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/tauri-cli-build.conf.json src-tauri/tests/smoke.rs '.github/workflows/release.yml' '.signpath/**'
```

코드·계약 검증:

```powershell
npm run typecheck
npm run lint
npm run test:ui
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

패키징과 선택적 실모델 smoke:

```powershell
npm run package:tauri
cd src-tauri
$env:LLAMA_BOARD_SMOKE = "1"
$env:LLAMA_BOARD_SMOKE_MODEL = "C:\\path\\to\\model.gguf"
cargo test --test smoke -- --ignored --nocapture
```

수용 테스트에는 fake server/benchmark child로 no-console·descendant kill·reader join·partial rows·재시작 후 persistence를 재현하는 deterministic fixture를 우선 사용한다. 실제 GPU/대용량 모델 검증은 위 smoke처럼 opt-in으로 분리하여 일반 CI가 개인 장치나 모델 경로에 의존하지 않게 한다.

## 9. 구현 반영 및 검증 (2026-09-09)

### 런타임과 GPU 배치

- managed runtime에서는 OS GPU 목록을 런타임 장치 목록으로 대신 사용하지 않는다. 프로브 진행/실패 중에는 GPU 입력을 비활성화하고 오류와 재시도 버튼을 표시한다.
- 동일 GPU 두 장을 OS 이름만으로 추측하지 않는다. 사용자는 `runtime:rocm:ROCm0`처럼 현재 런타임이 보고한 장치를 선택한다. 이는 영구적인 PCI 슬롯 식별자가 아니므로 런타임/하드웨어 변경 후에는 재선택이 필요하다. 주 GPU 인덱스는 선택한 장치 순서 기준으로 변환한다.
- Windows의 공식 ROCm b10840/b10872와 R9700 두 장을 분할 사용하는 조합에서 출력 손상이 재현됐다. 해당 조합은 실행 전에 차단하며 호환 빌드, Vulkan 또는 GPU별 독립 세션을 안내한다. CPU로 조용히 전환하지 않는다.
- 호환 런타임 `local_b10840_nop2p`는 upstream b10840의 commit `73ab7599b553c03f6f5d2db24a18ad76f2eb36a3`를 변경 없이 ROCm 7.2 clang 21로 빌드한다. `GGML_CUDA_NO_PEER_COPY=ON`으로 장치 간 복사 경로만 바꾸며 모델 계산은 GPU에서 실행한다. 이 산출물의 GPU target은 `gfx1201`이며 모든 AMD GPU를 위한 범용 빌드가 아니다.
- local build ID는 `local_` 접두사와 최대 48자의 영숫자/밑줄 suffix로 제한한다. 기존 공식 런타임을 덮어쓰지 않고 독립적으로 import/export하며 manifest SHA-256 검증과 깨끗한 환경의 preflight를 거친다.
- DFlash2는 특정 PR 번호에 고정하지 않고 런타임 help의 정확한 `draft-dflash` 지원 여부로 검증한다. 모델 파일/드래프트 종류 검사는 별도로 유지한다.

### UI와 종료 정책

- 실행 프로필의 상세 편집기를 기본 접힘으로 바꿔 실제 튜닝 입력이 첫 화면 아래로 밀리지 않게 했다. 폼/직접 입력 선택, 모델별 기본 프로필과 dirty 입력 보존을 유지한다.
- 중지 상태의 메모리 표시는 마지막 실행 모델이 아니라 현재 선택된 모델 기준이다. 실행 중에는 실제 로드된 모델 기준으로 표시한다.
- 프로젝트 목록/편집기 grid는 작은 창에서 내용 높이를 유지하며 페이지가 스크롤을 담당한다. 모델/세션/프로젝트/설정 화면은 480px 폭에서도 확인한다.
- 데스크톱 종료 시 서버·추가 세션·빌드·벤치마크·gateway를 항상 정리한다. 이를 끌 수 있는 것처럼 보이던 설정을 실제 정책 안내로 교체했다. 탭 전환은 작업을 중지하지 않는다.
- 배포용 CSP는 `127.0.0.1`과 `localhost`의 사용자 지정 포트를 허용한다. 외부 임의 origin은 열지 않아 다중 세션의 로컬 채팅 포트와 보안 경계를 함께 유지한다.
- 설정 백업/가져오기/부분 초기화의 한국어·일본어·중국어 라벨을 보완했다.

### 검증 결과와 범위

| 검증 | 결과 |
| --- | --- |
| TypeScript 타입 검사, ESLint, 직접 실행 테스트 | 통과 |
| Vitest + coverage | 27개 파일, 123개 테스트 통과; line coverage 51.56% |
| Rust clippy all-targets/all-features (`-D warnings`) | 통과 |
| Rust 기본 테스트 | library 220, CLI 8, fake-server 통합 1 통과; opt-in 테스트는 별도 실행 |
| ROCm 호환 빌드, R9700 두 장, 27B Q4_K_M 텍스트 | 66/66 레이어 GPU offload, 양쪽 GPU buffer, 정확한 OK 응답 |
| 같은 빌드의 이미지 + DFlash2 + 두 GPU, 앱 launch validation 포함 | 주 모델 66/66 및 draft 6/6 GPU offload, SSE 응답 완료, 종료 후 포트 해제 |
| Vulkan 텍스트/이미지/DFlash 및 ROCm GPU별 단독/독립 세션 | 실제 모델 검증 통과 |
| 실제 모델 로드 취소, 벤치마크 첫 행 후 취소, 런타임 다운로드 취소 | 프로세스/포트 또는 staging 정리; benchmark 부분 행 보존 |
| Claude 독립 검토 | 검토 완료; 알려진 ROCm dual-GPU 조합 차단 요구 반영 |

실모델 결과는 위 모델·GPU·런타임 조합의 검증이며 모든 하드웨어/모델의 호환성을 보증하지 않는다. UI는 Windows Tauri/WebView2에서 스크린샷과 접근성 트리, 탭/접힘/프로브 조작을 확인했다. 모든 동적 데이터 상태 및 다른 OS의 시각 검증까지 끝났다는 의미는 아니다. 로컬 호환 런타임과 로컬 설치 파일은 서명되지 않았으며 배포 서명을 대체하지 않는다.

호환 런타임 산출물은 `.codex-target/deliverables/llama-board-rocm-b10840-nop2p-gfx1201.zip`이고 SHA-256은 `8918ebb77d3ae25751c92fef8f2567434944278c40a3e8f7e0ce116e9c9e4985`다. Windows 설치 파일은 `.codex-target/release/bundle/nsis/`와 `msi/`에 생성한다. 사용자 설정/모델/기존 런타임은 삭제하지 않는다.

최종 NSIS/MSI 생성 후 기존 사용자 설치 경로에 NSIS `/UPDATE` 설치를 실행해 exit code 0을 확인했다. 기존 실행 파일/제거 프로그램/설정은 `.codex-target/pre-update-20260909/`에 백업했다. 설정의 변경 항목은 `active_build=local_b10840_nop2p`와 기존 DFlash2 파일에 맞춘 `spec_type=draft-dflash`뿐이며, 이전 공식 ROCm/Vulkan 런타임은 보존했다. 설치된 앱에서 모델 로드 후 채팅 입력/전송/SSE 완료를 직접 실행했고 실제 `OK` 응답을 확인했다.

설치본에서 모델을 실행한 채 설정/프로젝트 탭으로 이동해 서버 유지와 480px 프로젝트 목록/편집기 여백을 확인했다. 이어 앱을 종료했을 때 앱 소유 서버 및 테스트 프로세스 잔류 수가 0이고 1420/8080/18081~18083 포트가 모두 해제된 것을 확인했다. Vite는 `.codex-target`와 `coverage`를 감시에서 제외하여 개발 중 보고서/런타임 빌드 생성으로 활성 화면이 새로고침되지 않도록 했다.
