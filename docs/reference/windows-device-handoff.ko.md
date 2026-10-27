# Windows 검증과 엔진 중립 GUI 어댑터 전환 계획

## 1. 목표와 작업 순서

2026-10-14 기준 소스 `e021be8` / 브랜치 `codex/macos-device-validation`을 Windows에서 이어받는다. 이 문서는 **실행할 계획**이며 Windows·Linux의 새로운 실제 검증 결과나 아래 구조 개선의 구현 완료를 뜻하지 않는다.

AioLM의 주된 제품 개념을 **사용자가 선택한 추론엔진을 GUI로 등록·설정·실행하고 공통 기능으로 이용하는 어댑터**로 전환한다. llama.cpp·MLX·vLLM은 기본 제공 어댑터이며 엔진 목록을 닫힌 세 종류로 가정하지 않는다. 설치된 엔진의 `--help`를 읽어 실행 설정을 즉시 GUI로 제공하는 것을 핵심 여정으로 삼는다. 기존 Chat·모델 관리·프로필·프로젝트·RAG·MCP·gateway·세션·측정·이력·CSV/XLSX와 실측 데이터 공유 계약은 유지한다. 측정·공유는 공통 기능 중 하나로 배치한다.

순서는 다음과 같다.

1. **Windows에서 현재 변경을 먼저 검증한다(W01–W08).** 기존 동작의 기준과 실제 결함을 기록하고 재현되는 제품 결함부터 수정한다.
2. **Windows에서 공통 옵션 탐색·GUI·어댑터 경계를 개선한다(G01–G07).** 검증 중 발견한 개선점은 기록하되 큰 구조 변경은 첫 기준 검증 뒤에 시작한다.
3. **Linux에서 같은 변경을 검증하고 지원 엔진의 실제 추론을 확인한다(L01–L04).** Linux에서 수정하면 영향을 받은 Windows 흐름도 다시 검사한다.
4. **Mac에서 그 소스를 다시 검증한다(M01–M04).** Apple Silicon 엔진과 [Mac 추가 검증 목록](macos-device-validation-remaining.ko.md)을 이어간다. Mac 수정이 공통 코드를 바꾸면 Windows·Linux의 관련 검사를 다시 수행한다.

각 단계의 시작/종료 source commit을 고정한다. 공통 기능에 관련된 재현 결함을 해결하고 검사한 뒤 다음 구현 단위로 진행한다. 특정 기기·모델·권한이 없어 blocked인 항목은 이유와 다음 조건을 남기고 독립 작업은 계속한다. 실패를 skip하거나 다른 모델의 성공으로 대체하지 않는다.

## 2. 현재 구현과 구조 변경이 필요한 지점

| 현재 근거 | 이미 구현한 것 | 이번 계획의 변화 |
| --- | --- | --- |
| [공통 런타임 계약](pluggable-inference-runtimes.ko.md), [adapter.rs](../../src-tauri/src/providers/adapter.rs) | `InferenceRuntimeAdapter`, 공통 `EngineCommand`·프로세스 소유권·readiness·종료 | 등록된 descriptor/capability가 공통 기능의 실행 판단을 제공하도록 확대하고 engine ID 분기를 어댑터 내부로 정리 |
| [registry.rs](../../src-tauri/src/providers/registry.rs), [외부 등록 UI](../../src/features/runtimes/ExternalRuntimeRegistration.tsx) | manifest v1·`custom.*`·loopback OpenAI v1 bridge·등록/제거·모델별 fresh probe | manifest 작성에만 의존하지 않는 executable/도움말 탐색 여정; 실행 바인딩·protocol은 명시적으로 연결 |
| [옵션 스키마](../../src-tauri/src/providers/options.rs), [Python help probe](../../src-tauri/src/providers/python_env.rs) | vLLM/MLX의 정적 타입 스키마와 설치된 help의 flag 필터 | 설치별 help에서 실제 옵션을 발견하는 공통 스키마, 정적 정보는 검증된 보강 정보로 사용 |
| [llama.cpp 옵션 탐색](../../src/features/tuning/useServerOptions.ts), [공통 옵션 UI](../../src/features/model-settings/ProviderControls.tsx) | llama.cpp help parsing/기존 catalog fallback, provider option GUI | 하나의 runtime-scoped 옵션 renderer·검증·argv serializer를 기본 경로로 사용 |
| [옵션 projection 생성](../../scripts/sync-provider-launch-options.mjs) | Rust의 내장 vLLM/MLX 스키마를 browser JSON으로 동기화 | live IPC의 설치별 스키마와 portable schema snapshot 사용; 기존 browser/benchmark import 호환 유지 |

현재 코드에는 내장 엔진별 ID·설치 방식·옵션 가정이 남아 있다. 모든 분기를 일괄 삭제하지 않고, 사용자 데이터·실행 계약을 고정한 뒤 각각의 책임을 어댑터·설치 서비스·공통 기능으로 옮긴다. 엔진 중립 UI는 모든 엔진이 같은 모델 형식·task·미디어·측정 능력을 갖는다는 뜻이 아니다.

변경 검증의 우선 대상을 아래처럼 연결한다. commit은 변경 식별용이며 실행 기준은 전체 인계 HEAD다.

| 변경 묶음 | 식별 근거 | 먼저 확인할 위치 |
| --- | --- | --- |
| 공통 adapter·SDK·실제 custom profile/취소 후 Retry | `9d0e9cb`, `f1b94e4`, `51afc56` / Mac 결과 §98–99 | W02–W04·W07 |
| index 파생 복구·호환 runtime 등록·자동 system 선택 | `64791d2`, `158f966` / §100 | W03/W05의 공통 계약, 실제 MLX/vllm-metal은 M02–M03 |
| MCP 단일 text 반환값 전달 | `60626fb` / §102 | W05 실제 도구 후속, L02–L03·M02 |
| 첨부 순서·미디어 계산/이력·encoded padding·명시적 dither | `4a97627`, `d793781`, `4aeddcd`, `db41797`, `f1049eb` / §101–106 | W05 저장/전달·helper, 지원 모델 실제 내용은 각 지원 OS |
| 재시도 초안·설치 취소·좁은 창·MLX benchmark processor·CSV/XLSX 모델명 | §93–97, 당시 패키지 source `24a3dbd` | W06–W08·지원 Linux/Mac 측정·최신 package |

## 3. Windows로 소스와 증거 받기

원격 push는 이 문서 작성 범위에 포함하지 않는다. 전달할 문서 커밋까지 포함한 HEAD를 송신/수신 기록에 남긴다. 공유된 Git ref 또는 Git bundle로 **커밋 이력**을 전달하고, 받는 기기에서 `e021be8`이 조상인지 확인한다. 오래된 인계의 `docs/macos-supported`/`2c7d6d3`만으로 최신 구현을 받았다고 판단하지 않는다.

원격 공유 없이 전달할 경우 송신 기기에서 사용할 명령 예시는 다음과 같다. 같은 이름의 기존 bundle이 있으면 새 파일명을 사용한다.

```sh
git status --short
git rev-parse HEAD
git bundle create tmp/aiolm-windows-handoff.bundle codex/macos-device-validation
git bundle verify tmp/aiolm-windows-handoff.bundle
```

받는 Windows 기기에서 새 checkout을 만드는 PowerShell 예시다. 기존 checkout의 미커밋 파일은 보존하며, 같은 작업 브랜치가 있으면 새로 만들지 않고 상태와 source를 확인한다.

```powershell
git clone -b codex/macos-device-validation .\aiolm-windows-handoff.bundle AioLM
Set-Location AioLM
git switch -c codex/windows-runtime-adapter-validation
git merge-base --is-ancestor e021be8 HEAD
if ($LASTEXITCODE -ne 0) { throw 'Required source commit is missing' }
git rev-parse HEAD
git status --short
```

`node_modules`, `dist`, `.codex-target`, Mac 실행 파일·venv·개인 홈·자격 증명은 복사하지 않는다. Windows에서 다시 설치/빌드한다. 원본 로그·모델·wheel·캡처는 Git에 없으므로 필요한 **합성 입력만** 별도로 전달하거나 재생성하고 해시를 확인한다. 공개 모델은 full revision·파일 SHA-256·크기·loader 지원을 확인한 뒤 준비한다. 동일 음성 대조를 재생성된 다른 WAV로 대체하지 않는다. Mac 호환 wheel을 Windows/Linux용 wheel로 취급하지 않는다.

Windows raw는 `tmp/windows-acceptance/`, 익명화한 결과는 새 `docs/reference/windows-device-validation-results.ko.md`에 기록한다. 결과 문서는 실제 실행 후 생성한다. 기존 사용자 홈과 분리한 임시 `AIOLM_HOME`을 사용하되 최초 실행·legacy 이전·OS 자격 증명 검사는 별도 테스트 OS 계정에서 수행한다.

## 4. Windows 검증을 먼저 수행

### W01 — 환경과 공통 자동 검사

OS/build·CPU/arch·RAM·GPU/driver·WebView2·도구 버전을 먼저 기록한다. 기준은 `package.json`의 Node 22.23.2/npm 12.0.2와 Rust 1.98.0·rustfmt/clippy, native CPython 3.12, 필요한 CMake다. Windows GUI 빌드에는 Microsoft C++ Build Tools의 C++ desktop 도구와 WebView2가 필요하다([Tauri 공식 준비 안내](https://v2.tauri.app/start/prerequisites/#windows)). 작업용 도구 경로를 사용하고 기존 시스템 설정·사용자 Python을 덮어쓰지 않는다.

아래 명령을 하나씩 실행하고 exit code·로그를 기록한다. PowerShell은 native 명령 실패 후에도 다음 명령을 실행할 수 있으므로 실패를 확인하고 분류한 뒤 진행한다. lockfile은 유지한다.

```powershell
node --version
npm --version
rustc --version
python --version
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features
cargo check --manifest-path src-tauri/Cargo.toml --all-targets --no-default-features
cargo test --manifest-path src-tauri/Cargo.toml --test runtime_adapters
python -B -m unittest discover -s scripts/runtime-adapters -p 'test_*.py'
python -B -m unittest discover -s scripts/model-repair -p 'test_*.py'
python -B -m unittest discover -s scripts/provider-compatibility -p 'test_*.py'
python -B -m unittest discover -s src-tauri/src/providers -p '*_tests.py'
npm run test:provider-runtime
npm run build:cli
```

CLI smoke와 실제 엔진 harness는 [공통 어댑터 검사](runtime-adapter-handoff.ko.md#빌드와-공통-검사)와 [native acceptance](provider-native-acceptance.md)의 현재 인자를 확인해 실행한다. 합성 fixture 성공과 실제 추론 성공을 구분한다.

### W02–W08 — 실제 실행 대상

| ID | 우선 검증할 변경·흐름 | 완료 기준 |
| --- | --- | --- |
| W02 | schema 13→14·기존 llama.cpp 설정·profile/runtime binding·등록 누락/삭제/재등록·최초 custom profile | 합성 구버전 데이터 backup·round trip, 미등록 engine 값 보존, 무단 fallback 없음. 빈 홈과 기존 합성 홈을 따로 검사 |
| W03 | 외부 manifest/probe·program/artifact hash·OS 판정·options·model alias·늦은 probe 경합 | 같은 Windows binary에 합성 네 번째 엔진 등록. 취소/경합/변조 거부/외부 파일 보존. fixture 답변은 실제 추론으로 계산하지 않음 |
| W04 | 실제 llama.cpp CPU→지원 GPU backend·외부 개인 빌드·조건을 만족하는 Strata | 고정 source/model로 help/probe→Ready→새 응답/usage→생성 중 취소→Retry→재시작→normal Quit. 실제 엔진과 adapter/bridge의 버전·해시를 별도 기록 |
| W05 | MCP 간결 text envelope, 첨부 순서·자동 system 선택·이력·parser 오류 안내 | 실제 GUI에서 입력 인자와 다른 도구 반환값의 후속 답변, 승인/거부/호출 중 취소, rich/error/call ID 보존. 지원 모델의 이미지·음성·영상은 실제 내용으로 판정 |
| W06 | 공통 기능의 엔진 전환, 프로젝트/RAG/STT·멀티 세션·gateway | 프로필/이력을 보존하고 세션에 정확히 라우팅. 답변 엔진과 embedding/STT 엔진의 역할 분리. 미지원 task 명시 거부와 key/외부 데이터 보호 |
| W07 | Windows argv/한글/공백·긴 경로·환경·process ownership·실패/취소 | shell 재해석 없음. install/build/load/stream/tool/benchmark/import 실패·취소 뒤 소유 child/job·port·staging 정리와 다른 프로세스 보호 |
| W08 | 최신 production GUI/CLI·NSIS/MSI·Credential Manager·IME/clipboard/picker/tray/알림·portable | 사용하는 package target의 설치→실제 응답→저장/재로드→정상 종료·update/remove. 실제 과거 release 업그레이드와 합성 version 검사 구분. 지원 내장 runtime의 새 홈 export/import 후 추론 |

Windows의 표준 vLLM·MLX와 WSL/remote 실행은 현재 [local runtime 계약](inference-runtimes.md)의 대상이 아니다. Windows에서는 미지원 표시·값 보존·합성 protocol을 검증하고, Linux vLLM과 Mac MLX/vllm-metal 실제 추론은 후속 단계에 남긴다. WSL 성공을 Windows native 지원으로 기록하지 않는다. Strata의 대상 OS와 요구 자원은 [공식 repository](https://github.com/Niko1221/Strata)와 고정 revision의 조건으로 확인한다. GPU/RAM/weights 조건을 확보하지 못하면 blocked/unrun이다. 개인 엔진의 일반 등록 흐름은 다른 작은 실제 엔진으로도 검증할 수 있지만 Strata 실행 성공을 대신하지 않는다.

Mac의 index 복구·MLX media14·vLLM local core는 OS/loader별 변경이다. Windows에서 공통 helper·입력 저장·GUI 계약을 검사한 것과 해당 runtime의 실제 모델을 실행한 것을 구분한다. 현재 외부 v1의 정확한 tokenizer/cold-cache benchmark·CPU reference deep·ABI portable은 unsupported이며 기존 지원 내장 엔진의 기능은 유지한다.

W01–W08의 결과를 먼저 고정한 뒤 구조 개선을 시작한다. 진행을 막는 제품 결함은 최소 수정·관련 회귀를 먼저 수행한다. 실행 자원 대기 항목에는 다음 OS/기기와 필요한 조건을 명시하고 미실행을 pass로 바꾸지 않는다.

## 5. 공통 구조의 도착점

아래는 새로 구현할 설계이며 현재 manifest v1의 기존 필드로 취급하지 않는다.

```text
GUI: runtime 등록 → help 탐색 → 공통 옵션 편집 → model/probe → 실행/공통 기능
                            ↓
Runtime descriptor + Option schema + Model-resolved capabilities
                            ↓
Adapter: discovery / validation / command / protocol / optional measurements
                            ↓
Host services: owned process / readiness / media / tools / sessions / storage
                            ↓
선택한 실제 엔진 또는 foreground protocol bridge
```

UI와 Chat/RAG/MCP/gateway는 새 engine ID 분기를 추가하지 않고 descriptor와 model-resolved capability를 참조한다. 설치/update/source-build는 설치 서비스, argv/protocol/model loader 차이는 adapter에 둔다. engine·adapter·설치된 runtime·model binding·실행 session을 별도 identity로 유지한다. 필요한 능력이 없으면 이유를 표시하고 다른 엔진으로 자동 변경하지 않는다.

기존 engine ID, 설정 schema 14, profile revision, 적용 snapshot, session/이력, 공개 gateway wire, benchmark schema 1/2를 보존한다. 새 schema가 필요한 작업 단위에서만 version을 추가하고 원자적 migration·원본 backup·unknown/미등록 값 보존·구버전 앱의 명시적 거부를 마련한다. 등록이 사라진 엔진을 llama.cpp로 되돌리지 않는다. 같은 이름의 flag라도 다른 runtime에서 의미가 달라지면 binding/schema fingerprint로 구분한다.

## 6. G01–G07: `--help`를 GUI로 전환하는 구현 계획

### G01 — 공통 옵션 스키마

runtime descriptor와 versioned option schema의 타입을 정의한다. 최소 필드는 key·alias/flag·subcommand scope·positional 순서·값 타입·arity·repeat/optional value·enum/범위/단위·default 출처·group/help·launch/request target·재시작 필요 여부·배타/의존 관계·민감 값/로컬 경로·app-managed binding·정보 출처/확실성·raw help 범위다.

타입/범위/default가 help에 없으면 미확정으로 보존하고 설명에 나온 숫자로 상한이나 초기값을 만들지 않는다. runtime default는 보여 주되 저장된 override로 임의 전송하지 않는다. 미설정/명시적 false/0/빈 문자열을 구분한다. 모르는 타입은 text/token-list 등 보수적인 GUI로 제공하고 arity가 불명확하면 지정 방법 확인 또는 추가 metadata가 필요함을 표시한다. request API 필드는 help만 보고 추정하지 않는다.

### G02 — help 탐색과 실행 수명

사용자가 선택한 실행 파일/인터프리터·인자·working directory에서 adapter가 지정한 help command를 shell 없는 argv로 실행한다. 일반 `--help`와 명시한 subcommand·`--help=all`을 지원한다. vLLM serve·MLX server 등 기존 probe를 이 경로로 옮긴다. config 파일로만 설정하는 엔진은 같은 GUI schema에 명시적 metadata를 제공한다. help가 없다는 이유만으로 엔진 등록을 모두 막지 않고 탐색 지원과 추론 능력을 구분한다.

stdout/stderr·exit code·encoding·locale·ANSI·출력 제한·잘림 여부·취소·timeout을 수집한다. help 실패 후 정적 catalog를 검증된 옵션으로 표시하지 않는다. 최초 탐색은 비동기로 완료 즉시 GUI에 반영하고 동일 fingerprint의 다음 사용은 cache에서 표시한다. 실제 측정 전에 근거 없는 고정 응답 시간 목표를 정하지 않는다. 실행 파일/선언 artifact hash·runtime version·help argv·환경/locale·parser version을 cache identity에 포함한다. 변경 시 재탐색하고 이전 설정과의 diff를 보여 준다. timeout/과다 출력/자식 잔존/늦은 탐색 두 개의 경합을 실제 프로세스로 검사한다.

### G03 — parser와 보강 정보

일반적인 help의 usage·option block·alias·metavar·choices·여러 줄 설명·제목을 deterministic parser로 공통 schema에 변환한다. bool/negative flag, `--key=value`, short option, optional value, 여러 값, repeat, positional, global/subcommand scope를 다룬다. [argparse 공식 명세](https://docs.python.org/3/library/argparse.html#nargs)에도 가변 arity와 값을 소비하지 않는 action이 있으므로 모든 설정을 flag/value 한 쌍으로 가정하지 않는다.

엔진/adapter가 구조화된 schema를 제공하면 version/provenance를 확인해 사용하고 help와 충돌하는 항목을 표시한다. 검증된 내장 adapter metadata는 단위·제약·GUI 용어·app binding을 보완한다. 새 flag가 앱 release를 기다려야 하는 고정 allowlist로 만들지 않는다. 해석되지 않은 block도 raw help에서 확인할 수 있게 하고 unsupported/unknown을 조용히 삭제하지 않는다. AI의 의미 추정을 필수 경로로 두지 않으며 불확실한 추정을 검증된 제약으로 사용하지 않는다.

### G04 — 하나의 renderer·validator·serializer

모든 엔진에서 같은 option schema로 GUI 표시·profile 저장·import·검증·argv 생성을 수행한다. 타입에 따라 숫자/choice/toggle/path/JSON/list/text를 표시하고 검색·group·상세 help·runtime default와 override·재시작 여부·미확정 값을 보여 준다. 기존 llama.cpp 타입 설정과 vLLM/MLX option key는 호환 mapping으로 유지한다. browser의 이력/benchmark import는 저장된 schema snapshot과 기존 projection을 호환 읽기한다.

argv preview는 요소별로 확인할 수 있으며 API key 등은 마스킹한다. CLI 문자열 편집은 OS/syntax를 명시한 import로 취급하고 shell로 실행하지 않는다. alias/순서/중복/negative flag/여러 값/빈 문자열/하이픈으로 시작하는 값을 의미 손실 없이 serialize한다. model·host/port·auth·daemon/lifecycle은 app-owned binding으로 관리하고 raw args·약어·alias·보강 metadata로 덮어쓰지 못하게 backend에서도 검사한다. reserved field 외의 안전한 새 옵션은 보수적 editor로 제공하며 정적 metadata에 없다는 이유만으로 배제하지 않는다.

### G05 — 등록부터 새 엔진 실행까지

실행 파일/entry point 선택→help 탐색→실행 설정 GUI→model/port/auth binding 확인→protocol/health/model probe→등록→Ready→공통 Chat을 한 여정으로 만든다. 일반 CLI 엔진이 HTTP 서버를 제공하지 않으면 명시한 bridge를 사용한다. `--help` 성공은 OpenAI API·chat template·tools·media·tokenizer/cold-cache/portable 지원의 증거가 아니다. 선택 모델의 fresh probe와 실제 추론으로 확인한다.

새 엔진을 추가할 때 공통 기능의 engine ID 분기나 전용 GUI를 작성하지 않는다. 수동 manifest는 고급 경로로 유지한다. manifest v1 호환을 보존하고 help command/schema reference 등의 추가에 새 version이 필요하면 협상·기존 manifest 읽기·unknown version 거부를 먼저 구현한다. 개인 엔진을 다시 빌드해 hash가 바뀌면 실행 전에 감지하고 명시적 재등록/검토한 업데이트로 새 help diff·사라진 옵션·능력을 보여 준다. 저장값은 지우지 않고 실행 가능 여부를 재판정한다.

### G06 — 제품 탐색과 공통 기능 정리

초기 안내·주요 동선·문서를 “runtime 등록/설치→설정→model 선택→실행”으로 맞춘다. 세 개의 고정 engine tab 중심에서 설치/등록할 수 있는 adapter 목록·검색으로 전환하고 llama.cpp/MLX/vLLM은 기본 제공 adapter로 표시한다. live session identity·engine/runtime/version/model·준비 상태·취소/진단 동선을 공통화한다.

Chat·프로젝트/RAG·MCP·API·benchmark/공유는 같은 runtime/session을 사용하는 공통 화면으로 유지한다. benchmark 동선 정리를 이유로 기능·기존 이력을 삭제하지 않는다. GGUF 전용으로 보이는 문구는 artifact/loader 지원에 맞추고 모델 형식과 엔진을 구분한다. 미지원 기능은 capability 이유와 필요한 연결을 안내한다. 개발 내부 구조를 제품 사용자 화면에 나열하지 않는다.

### G07 — 검증 중 개선점 탐색과 수락 기준

Windows 기준 검증과 새 등록의 실제 사용을 관찰해 설정 발견성·용어/오류 설명·선택 저장·불완전 runtime/model 복구·취소/Retry·접근성·탐색 대기/경합·대량 옵션의 검색/render 성능을 살핀다. 문제별 재현 입력·사용자 영향·원인/미확정·최소 수정·관련 회귀·재검증 결과를 남긴다. 큰 화면 변경과 backend 계약 변경은 별도 commit으로 검토 가능하게 만든다.

| 수락 항목 | 필요한 증거 |
| --- | --- |
| 새 엔진의 즉시 GUI 전환 | 고정 AioLM binary에 미등록 합성 엔진과 실제 개인 엔진을 추가. 새 flag를 전용 코드 없이 표시·저장·실제 argv 반영 |
| 버전 변경 | 같은 엔진의 두 build에서 flag/default/arity 변경 감지. 이전 profile 값 보존과 사라진 옵션 표시. 오래된 help cache 재사용 없음 |
| 의미 보존 | Windows/Linux의 같은 합성 CLI에서 GUI 설정→argv→실제 parser 수락→저장/재로드 비교. Mac에서도 같은 계약 실행 |
| parser 적용 범위 | help/protocol 계약을 만족하는 llama.cpp·지원 OS의 vLLM/MLX·다른 CLI 형식의 개인 엔진. 미해석 항목의 보수적 편집/metadata 보완 확인 |
| 프로세스·입력 보호 | help 취소·출력 초과·실패·probe 경합, model/port/auth 덮어쓰기 거부, 외부 파일·다른 프로세스 보호 |
| 공통 기능·호환 | W02/W05/W06 재검증, 내장 측정/portable 의미 보존, 외부 미지원 표시, 기존 profile/이력/API/공유 schema 보존 |
| 제품 동선 | 검증자가 등록→help 설정→실행→진단/취소를 실제 수행. keyboard·focus·IME·작은 창의 주요 조작을 실제 WebView에서 확인 |

## 7. Linux에서 이어서 검증

Windows에서 확인한 종료 commit을 받아 `codex/linux-runtime-adapter-validation`에서 시작한다. [최신 Linux 인계](linux-device-handoff.ko.md)의 Git 수신 절차로 원격 Windows 작업 브랜치와 검증 기준 commit을 확인한다. 현재 source의 Linux 기능은 아직 미실행이며 과거 Linux 결과를 현재 pass로 옮기지 않는다. raw는 `tmp/linux-acceptance/`, 새 익명화 결과는 `docs/reference/linux-device-validation-results.ko.md`에 남긴다.

| ID | 순서와 완료 조건 |
| --- | --- |
| L01 | Windows 변경을 먼저 검토하고 같은 공통 자동 검사·schema/GUI/argv/probe 경합을 native Linux에서 실행. Tauri/GTK/WebKitGTK 등은 [공식 의존성](https://v2.tauri.app/start/prerequisites/#linux)과 저장소 guide로 준비. Windows 경로/venv/binary를 복사하지 않음 |
| L02 | 고정 llama.cpp CPU/지원 GPU·native Linux vLLM·지원 Strata/실제 개인 엔진에서 help→GUI→실제 응답/usage→취소/Retry→restart/정리. 실제 GPU/driver/ABI·모델 능력은 probe와 요청으로 확인. MLX/Metal은 지원 OS에 남김 |
| L03 | 이용 가능한 실제 X11/Wayland desktop에서 공통 기능·IME·clipboard·portal/picker·tray 유/무·알림·Secret Service·package/CLI·새 홈 portable 검증. headless/합성 성공을 전체 desktop 성공으로 확대하지 않음 |
| L04 | 변경 부분의 fail부터 최소 수정하고 이후 Linux의 조작/복구/성능 개선을 G07 형식으로 구현. 공통 변경은 Windows에 돌려 관련 W/G 검사를 재실행하고 Mac에 전달할 종료 commit·남은 항목 고정 |

Linux 표준 vLLM은 현재 관리 대상 버전/accelerator 계약으로 실행한다. Mac local core wheel을 이식했다고 가정하지 않는다. 새 엔진의 help/protocol 차이를 발견하면 일반 parser 문제와 adapter 고유 metadata/bridge 문제를 분리해 수정한다.

## 8. Mac에서 최종 재검증

Linux 이후의 같은 source를 Mac에서 받아 `codex/macos-runtime-adapter-revalidation`에서 계속한다. raw는 기존 `tmp/macos-acceptance/`의 새 실행 directory에 보관하고 결과는 기존 Mac 결과 문서에 새 절로 추가한다.

| ID | 순서와 완료 조건 |
| --- | --- |
| M01 | Windows/Linux 공통 변경부터 공통 자동 검사·기존 profile/migration·help schema/argv·등록/제거/재등록·탐색 취소를 Mac에서 확인 |
| M02 | 원래 모델과 검증된 native 환경을 보존하며 llama.cpp CPU/Metal·vllm-metal·MLX의 help GUI·새 추론·미디어 순서/이력·MCP 후속·gateway·usage·취소/Retry·정상 종료를 실제 WKWebView에서 확인 |
| M03 | [Mac 추가 검증 R01–R13](macos-device-validation-remaining.ko.md)을 독립 판정. Gemma3n 원본 FP/새 음성 3개·SmolVLM 조건·개발 reload·최신 DMG/호환 bundle·별도 계정/Keychain/Finder·ffmpeg 부재·VoiceOver·Intel/구형 OS를 확보한 조건에서 실행 |
| M04 | 최종 source의 production package·실제 GUI·기존 사용자 데이터/환경 보존·원래 실행 복원. Mac 공통 수정은 Windows/Linux에 돌려 관련 검사 완료와 OS별 남은 항목 확정 |

Mac의 남은 내용 fail을 모델 교체·정답 보정으로 닫지 않는다. 올바른 원본 참조와 같은 입력의 대조를 계속하며 미해결은 fail로 보존한다. Intel·구형 OS·별도 계정을 M2 한 기기의 성공으로 추정하지 않는다.

## 9. 구현 단위와 인계 완료 기준

commit은 원칙적으로 Windows 기존 결함→descriptor/schema→help runner/parser→renderer/serializer→등록 통합→내장 adapter 이전→동선/개선→Linux 수정→Mac 수정 단위로 나눈다. 독립 개선은 작게 다루고 실패 원본·수정 전후·관련 검사를 연결한다. 한 번의 대규모 재작성과 불필요한 공개 API/저장 schema 변경을 피한다.

각 OS 종료 시 source/수정 commit·실제 기기/OS/GPU·runtime/model revision/hash·항목 ID·기대/실제 관찰·상태·재현 절차·raw 위치·다음 OS 조건을 기록한다. `pass / fail / unsupported / unrun / blocked`를 구분하고 새 binary 실행을 이전 binary 결과로 대체하지 않는다.

작업 종료 기준은 변경 부분의 지원 OS별 검증, 실제 엔진의 공통 GUI adapter 여정, help의 새 옵션 반영, 기존 계약/데이터 보존, OS별 잔여 항목의 구체적 인계다. 물리 기기 미실행·unsupported·미해결 내용 fail이 있으면 전체 통과를 선언하지 않는다. 원본 로그/개인 데이터/build는 tmp에 보관하고 필요한 code/test/doc만 staged diff·개인정보·공백을 검토해 commit한다. 원격 push·공개 데이터 upload는 별도의 명시된 작업으로 취급한다.
