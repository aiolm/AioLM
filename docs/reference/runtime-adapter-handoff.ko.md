# 외부 런타임 어댑터 v1 및 Windows·Linux 검증 인계

## 현재 상태와 검증 범위

공통 core 구현은 `9d0e9cbc4dc710a77573dc3b30713166f364a496`, SDK 보완은 `f1b94e40f98d2e4c4b31b5936a418981bfa5c69d`이며 Mac GUI 검증 중 수정한 프로필·취소 후 재시도까지의 기준은 `51afc569ceb7b0cf126c26664cf756889ae51c25`다. Mac 잔여 미디어 복구 도구와 검증된 local runtime 등록은 `64791d2`, 자동 시스템 안내 선택은 `158f966`이다. Gemma4 audio padding 호환 wheel은 `5ba74fe`, 대화별 첨부 순서와 parser 오류 안내는 `4a97627`이다. 작업 브랜치는 `codex/macos-device-validation`이다. 상세 실행 근거와 남은 항목은 [검증 결과 §98](macos-device-validation-results.ko.md#98-외부-런타임-인터페이스와-windowslinux-인계)와 [실제 Mac GUI §99](macos-device-validation-results.ko.md#99-외부-런타임의-실제-mac-gui와-기존-환경-복원)를 따른다.

추가 미디어 검증은 [Mac 결과 §101](macos-device-validation-results.ko.md#101-미디어-내용과-도구-후속-답변의-추가-원인-검증)과 [복구 절차](macos-validation-recovery.ko.md)를 따른다. 선택한 실제 MLX Python에서 `check_mlx_audio_history.py`와 `check_gemma4_audio_packing.py`를 실행한 뒤, 길이가 다른 두 녹음의 내용·첫 녹음 재사용·usage·취소/Retry·정상 재시작을 검사한다. 두 checker의 성공은 실제 모델 내용 성공을 뜻하지 않는다. MLX 미지원 기기에서는 stdlib 도구만 실행하고 실제 MLX 검사는 unsupported로 기록한다.

Windows/Linux 실제 앱에서 **첨부를 질문보다 먼저 전달**을 선택하고 새 입력/첨부 이력의 순서, Retry snapshot, 빈 대화 저장·재로드를 확인한다. 기존 대화는 text-first를 유지해야 한다. 영상 프레임·시각 설명과 전사문을 잘라내거나 원본 파일의 정체성을 바꾸면 실패다. runtime probe와 모델별 미디어/도구 지원을 우회하지 않는다. SmolVLM256M/Qwen3-VL2B의 오류를 500M/4B의 성공으로 대체하지 않는다. Gemma3n4bit/공개8bit의 전사 오류도 남았고 공식 원본 대조는 접근 제한으로 unrun이다. 해당 OS의 실제 검증·새 패키징·Strata 추론은 계속 unrun이다.

내장 llama.cpp·vLLM·MLX와 등록형 `custom.*` 엔진이 공통 `InferenceRuntimeAdapter`/`EngineCommand` 경계를 사용한다. 등록 UI는 런타임 화면의 **외부 엔진 등록**이다. 실행 중인 모델 세션을 먼저 언로드하고 JSON manifest를 선택해 **검사 후 등록**을 누른다. 등록된 엔진·런타임은 공용 실행 설정에서 선택하며 모델별 probe 후 실행한다.

Mac arm64에서는 네 번째 합성 엔진의 실제 소유 프로세스·readiness·HTTP/SSE 경로와 외부 CPU llama-server 빌드의 실제 Qwen2.5 응답·tokenizer usage·취소·재시작·종료·재등록을 검사했다. 실제 Windows·Linux 및 원본 Strata 추론은 **unrun**이다. 다른 OS의 결과를 Mac 결과로 대체하지 않는다. 기존 Mac M01–M12 판정은 이 문서로 전체 통과가 되지 않는다.

별도 빈 홈의 실제 WKWebView에서 manifest 파일 선택·등록, 처음 선택한 외부 엔진의 기본 프로필, 공용 프로필 저장과 실제 응답/usage, 부분 응답 취소·재시도, 360px 최소 창, 정상 Quit와 앱 재시작 후 설정/이력/등록 보존을 확인했다. 앱 gateway의 무인증·잘못된 키 401/정상 인증 200과 실제 모델 alias 라우팅도 확인했다. 처음 외부 엔진을 선택하면 설정 본문이 비던 문제는 `3c5b067`, 중지한 부분 응답의 재시도 버튼 누락은 `51afc56`에서 수정했다. Windows·Linux에서는 아래 W/L03–06을 실제 GUI로 다시 수행한다.

외부 어댑터 v1의 정확한 tokenizer/cold-cache 벤치마크, CPU reference 심층 검증, portable ABI export/import는 **unsupported**다. 관련 실행은 UI와 backend에서 거부하며 기존 이력·CSV/XLSX는 보존한다. Chat·MCP·미디어·embedding/transcription은 실제 모델별 probe가 해당 능력을 확인해야 사용한다. 단순 OpenAI 호환 서버라는 이유로 도구·멀티모달·지표를 지원으로 표시하지 않는다.

## 빌드와 공통 검사

대상 기기에서 저장소를 checkout하고 작업 브랜치를 만든다. 기존 사용자 홈·설정·외부 모델은 복사하거나 덮어쓰지 않는다. 기준 소스와 변경 커밋을 기록하고 lockfile을 유지한다. Node 22.23.2/npm 12.0.2, Rust 1.98.0 및 rustfmt/clippy, native CPython 3.12를 사용한다. GUI 빌드는 저장소의 [개발 환경](../guides/development.ko.md)과 [런타임 인계](provider-runtime-handoff.ko.md)의 해당 OS 준비 절차를 따른다. Windows에서는 MSVC/WebView2, Linux에서는 Tauri의 WebKitGTK·GTK·트레이 개발 의존성이 필요하다. 대상 OS의 현재 Tauri 요구사항을 확인하고 환경 문제를 제품 결함과 구분한다.

아래 명령은 PowerShell 및 Linux shell에서 각각 실행할 수 있다. 외부 엔진의 자체 빌드 의존성은 엔진의 고정 revision 문서를 별도로 따른다.

```text
node --version
npm --version
rustc --version
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features
cargo check --manifest-path src-tauri/Cargo.toml --all-targets --no-default-features
cargo test --manifest-path src-tauri/Cargo.toml --test runtime_adapters
python -B -m unittest discover -s scripts/runtime-adapters -p "test_*.py"
python -B -m unittest discover -s scripts/model-repair -p "test_*.py"
python -B -m unittest discover -s scripts/provider-compatibility -p "test_*.py"
python -B src-tauri/src/providers/vllm_probe_tests.py
npm run build:cli
```

`runtime_adapters`는 합성 fixture이며 실제 추론 성공으로 기록하지 않는다. 등록·취소·두 모델의 늦은 probe 경합·저장된 선택 보존·실제 child/port 종료를 검사한다. fixture는 기존 배포 명령의 `--no-default-features` 정책에 따라 배포에서 제외된다. CLI 기본 출력은 `.codex-target/release/aiolm-cli.exe`(Windows), `.codex-target/release/aiolm-cli`(Linux)다. `CARGO_TARGET_DIR`을 지정했다면 그 경로를 사용한다.

## Manifest 계약

JSON은 `schema_version: 1`, `adapter_version: 1`, `protocol: "openai-v1"`를 사용한다. 알 수 없는 schema·필드·binding을 거부한다. 최대 256 KiB다.

| 필드 | 의미 |
| --- | --- |
| `engine_id` | `custom.` 뒤 소문자 영문·숫자로 시작, 이후 영문·숫자·점·밑줄·하이픈. 전체 최대 64자. 내장 이름은 등록할 수 없다. |
| `runtime_id`, `display_name` | 해당 설치의 ID와 표시 이름. ID는 기존 runtime ID 규칙을 따른다. 같은 engine/runtime 등록을 덮어쓰지 않는다. |
| `platforms` | 실제 지원 `{os,arch}` 목록. OS는 `windows/linux/macos`, architecture는 `x86_64/aarch64`. 지원하지 않는 기기의 값을 위조하지 않는다. |
| `probe`, `launch` | 각각 절대 `program`, 문자열 `args` 배열, 선택적 `env`와 절대 `working_directory`. shell 문자열을 실행하지 않는다. |
| `model_formats` | `gguf/hf-safetensors/mlx/unknown` 선언. 선언만으로 모델 지원을 확정하지 않는다. |
| `models` | 선택적 `{path,name}` 명시적인 외부 모델 binding 목록. 새로운 형식·Strata deployment JSON은 `unknown`으로 등록하고 실제 probe로 검사한다. |
| `artifacts` | 선택적 adapter 스크립트·library·설정의 절대 경로. 등록 시 전체 SHA-256을 저장하고 변경을 거부한다. 종속 파일은 제공자가 빠짐없이 선언해야 한다. |
| `health_path`, `health_authenticated` | loopback 상태 endpoint와 인증 필요 여부. 소유 listener 및 `/v1/models`의 예상 alias도 함께 확인한다. |
| `options` | 옵션 `key`, `target: launch/request`, `kind`, 선택적 `flag/group/runtime_default`. launch 옵션은 flag와 probe의 `{options_json}` 전달이 필요하다. |

Bindings는 `{model}`, `{model_alias}`, `{host}`, `{port}`, `{api_key}`, `{ctx_size}`, `{parallel}`, `{options_json}`이다. probe와 launch는 선택 모델을 받아야 하며 launch는 앱이 지정한 port를 사용한다. `{api_key}`는 env에서만 허용한다. 빈 credential binding은 env에 넣지 않는다. 모델·port·host·인증 및 canonical messages/stream/tools를 사용자 옵션으로 덮어쓸 수 없다. argv의 한 원소는 한 인자로 전달되므로 경로 공백·한글을 shell quoting으로 다시 감싸지 않는다.

`kind`는 `integer/number/flag/toggle/choice/text/path/json`이다. 범위·choices·길이와 request/launch 적용 위치를 선언한다. 지원하지 않는 옵션을 조용히 버리지 않는다. 제공자가 선언한 request 옵션만 canonical 요청에 추가한다.

Probe는 30초 안에 stdout으로 **단일 JSON**을 출력한다. 진단은 stderr에 기록한다. 실제 version·accelerator·모델·task와 chat/tools 능력을 검사하며, 빈 모델은 설치 검사를 수행한다. 임의로 능력을 true로 채우지 않는다. 선택 모델이 미지원이면 `model_supported: false`를 반환한다. 예:

```json
{
  "schema_version": 1,
  "engine_id": "custom.example",
  "runtime_id": "build-1",
  "version": "verified-build-version",
  "accelerator": "cpu",
  "model": "",
  "model_supported": false,
  "served_model": "example-model",
  "capabilities": {
    "tasks": [],
    "modalities": {"text": false, "image": false, "audio": false, "video": false},
    "chat": false,
    "tools": false
  }
}
```

모델을 선택한 probe의 `model`은 전달받은 문자열과 같아야 한다. tasks는 `generate/embed/transcription/translate`이며 실제 구현과 맞아야 한다. `served_model`은 `/v1/models`와 실제 요청에서 사용하는 alias다. weights 경로와 다를 수 있다. Chat template가 없는 base 모델은 loadable과 별개로 chat을 거부한다.

CLI에는 `runtime register-manifest <json>`, `runtime select <engine> <runtime>`, `runtime probe <engine> <runtime>`, `runtime remove <engine> <runtime>`가 있다. 등록 제거는 외부 파일을 삭제하지 않는다. 해당 CLI도 새 임시 `AIOLM_HOME`에서 실행한다.

## 실제 외부 llama.cpp 빌드 검증

고정한 소스로 직접 빌드한 `llama-server`와 작은 공개 Instruct GGUF를 준비한다. 전체 model revision·SHA-256·출처·바이트 크기, 실행 파일 version/build·SHA-256을 기록한다. companion/split 모델은 필요한 모든 파일을 준비한다. SDK 예제는 실제 `--version/--help`와 GGUF metadata/chat template를 검사하는 CPU 기준 어댑터다. 실행 시 `LLAMA_API_KEY` 환경 binding을 사용하므로 선택한 빌드가 이를 제공해야 한다. CLI의 명시적 headless 모드는 기존 정책에 따라 인증을 비활성화하며 빈 env binding을 생략한다. 이미지·도구 지원을 선언하지 않는다.

Linux 예제(변수는 검증자가 실제 선택한 절대 경로다):

```bash
mkdir -p tmp/runtime-adapter-validation
python3 scripts/runtime-adapters/create_adapter.py create --kind llama.cpp \
  --engine-id custom.local-cpu --runtime-id build-1 \
  --server "$ADAPTER_SERVER" --model "$ADAPTER_MODEL" \
  --output "$PWD/tmp/runtime-adapter-validation/runtime.json"
npm run test:runtime-adapters -- --cli "$ADAPTER_CLI" \
  --manifest "$PWD/tmp/runtime-adapter-validation/runtime.json" \
  --model "$ADAPTER_MODEL" --provenance "$ADAPTER_PROVENANCE"
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force tmp/runtime-adapter-validation
python scripts/runtime-adapters/create_adapter.py create --kind llama.cpp `
  --engine-id custom.local-cpu --runtime-id build-1 `
  --server $AdapterServer --model $AdapterModel `
  --output "$PWD/tmp/runtime-adapter-validation/runtime.json"
npm run test:runtime-adapters -- --cli $AdapterCli `
  --manifest "$PWD/tmp/runtime-adapter-validation/runtime.json" `
  --model $AdapterModel --provenance $AdapterProvenance
```

`--output` manifest는 새 파일이어야 한다. 생성한 manifest를 읽고 실제 플랫폼·program·args·artifacts·모델을 확인한다. helper 또는 엔진을 변경했다면 이전 등록을 제거하고 다시 등록한다.

`provenance.json`은 아래 형태로 작업용 `tmp/`에 작성한다. placeholder를 그대로 사용하지 않는다. 모든 weights·tokenizer·processor·companion·deployment config의 전체 SHA-256을 직접 계산한다. harness는 **목록에 있는 파일**을 검사하며 누락된 의존성까지 발견하는 검사는 아니다.

```json
{
  "model_revision": "<실제 전체 40자리 revision>",
  "model_repository": "<공개 모델 출처>",
  "files": [{"path": "<실제 절대 파일 경로>", "sha256": "<64자리 SHA-256>"}]
}
```

harness는 새 작업용 홈에서 등록·선택·fresh probe·실제 `2+3` 응답과 authoritative usage·내용을 받은 뒤 취소·재시작·종료·제거 후 선택 유지/실행 거부·재등록을 검사한다. 마지막에는 소유 PID와 port 종료 및 provenance 파일 보존을 확인한다. 실패해도 원본 로그를 남긴다. `results.json`에는 실제 OS/arch, source commit·dirty 여부·tracked diff hash·CLI/manifest hash와 A01–A09 판정이 있다. 테스트는 설치/다운로드/공개 업로드를 하지 않는다. 다른 실제 엔진을 중지하고 이 검사만 실행한다. 메모리·성능 비교는 이 harness의 범위가 아니다.

## 원본 Strata 및 개인 엔진

대상은 [Niko1221/Strata](https://github.com/Niko1221/Strata)다. 원본 Strata는 Windows/Linux x86-64와 해당 GPU·메모리 요구사항을 만족한 기기에서 준비한다. Mac M2 결과를 지원 근거로 사용하지 않는다. 구체적인 build/download/라이선스는 고정 revision의 공식 문서를 따른다.

고정 source revision과 설치된 Python 환경, 엔진 binary·weights·tokenizer를 먼저 준비한다. SDK는 [serve/server.py](https://github.com/Niko1221/Strata/blob/main/serve/server.py)의 OpenAI 호환 server를 사용한다. AioLM 전용 deployment config를 작성해 엔진을 foreground로 실행한다. 독립 `lazy_load`, 저장 `api_key`, `mcp_servers`, `before_load`는 거부한다. lifecycle과 도구 승인은 AioLM이 담당한다. 기존 개인 config를 수정하지 않고 별도의 테스트 config를 선택한다.

```text
python scripts/runtime-adapters/create_adapter.py create --kind strata --engine-id custom.strata --runtime-id pinned-build --python <설치된Python절대경로> --root <Stratacheckout절대경로> --config <전용deploymentJSON절대경로> --revision <전체40자리sourcecommit> --output <새manifest절대경로>
```

`--model`과 라이브러리 binding은 이 Strata deployment JSON을 사용한다. weight 파일 자체와 같은 의미가 아니다. 같은 harness에 이 JSON과 모든 실제 weight/tokenizer 파일을 provenance로 전달한다. helper는 source HEAD, 실제 server 옵션·native version, deployment config의 실행 파일·tokenizer를 검사한다. 다른 native 실행 파일을 가리키는 deployment는 별도로 등록해야 한다. GPU 종류는 설정만으로 추정하지 않고 `unverified`로 두며 실제 장치/시작 로그를 대상 기기에서 확인한다. 실제 serving·GPU·모델 답변은 대상 기기에서 검증해야 하며 helper 생성 성공만으로 통과가 아니다. source 업데이트로 upstream API가 달라지면 고정 revision 근거와 최소 재현을 남기고 adapter를 수정한다.

개인 엔진은 같은 manifest/probe와 OpenAI v1 bridge를 구현하면 핵심 앱 재빌드 없이 등록할 수 있다. bridge는 stdout probe contract, health/model alias, SSE usage·tool IDs·오류·취소 의미를 유지해야 한다. 본 SDK를 임의 엔진의 능력 증명으로 재사용하지 않는다.

## 대상 OS 실제 GUI·기능 검사와 완료 조건

새 임시 홈을 사용하고 설정 백업과 native 창·트레이·파일 선택·클립보드·IME를 실제 OS에서 확인한다. GUI는 `npm run tauri dev` 또는 기존 `npm run package:tauri` 산출물을 사용한다. package 명령은 CLI 포함·fixture 제외 정책을 유지한다. runner 전용 조건을 위조하지 않는다.

| 항목 | 실제 검사와 근거 |
| --- | --- |
| W/L01 | 위 공통 검사와 합성 네 번째 엔진. 실행 명령·exit code·원본 로그, 실제 OS/arch/도구 버전. |
| W/L02 | manifest 파일 선택·등록·취소·중복/변경 hash/잘못된 OS 거부·제거. 소유 자원 정리와 외부 원본 보존. |
| W/L03 | 라이브러리 모델 binding·실행 설정의 네 번째 엔진·공용 프로필 저장/재로드·프로젝트 import·등록 제거 후 선택 보존. 내장 세 엔진 설정이 그대로 유지됨. |
| W/L04 | 대화의 자동 시스템 안내 on/off·정상 Quit 후 저장/재로드와 명시적 대화·프로필·개인화 지침 보존을 확인한다. 실제 loader 모델별 probe·응답/usage·스트림 취소/재시도/재시작·최소 창 크기·이력 재로드. 내용을 받은 뒤 중지한 부분 응답이 보존되고 Retry가 같은 사용자 메시지를 중복 없이 다시 보내며 이전 usage를 재사용하지 않는지 확인. 정상 Quit 후 소유 PID/port 종료와 재실행 후 등록/프로필/이력 보존도 확인. base 모델 chat 거부도 확인. |
| W/L05 | 지원 엔진의 MCP 승인/거부/실행 취소/후속 답변, tools 미지원 모델의 명시적 거부. 합성 도구만 사용. |
| W/L06 | 프로젝트/RAG·embedding runtime namespace·멀티 세션·앱 gateway 인증 실패/성공·모델 alias 라우팅·API listener와 모델 lifecycle 분리. |
| W/L07 | [Mac 복구 절차](macos-validation-recovery.ko.md)의 원본 보존·새 출력·해시 오류·취소를 해당 OS에서 검사한다. Mac 전용 vllm-metal wheel을 Windows/Linux 결과로 사용하지 않는다. 잘못된 media의 400과 active/in-flight 정리, 여러 user의 audio 배치도 검사한다. 실제 지원 모델의 이미지·STT·음성/영상 전처리, 합성 입력·내용 확인·보관/재로드/재시도/취소. 미지원 항목은 unsupported. |
| W/L08 | 내장 세 엔진의 기존 benchmark/deep/portable 회귀. 외부 v1의 미지원 사유, 이력·CSV/XLSX 보존. 공개 서비스 업로드하지 않음. |
| W/L09 | 실제 플랫폼 패키지의 GUI/CLI 포함·버전/서명/hash·fixture/개인 경로 제외, 실제 설치/제거/업그레이드·창/트레이/IME. 별도 계정이 필요한 항목은 unrun. |

원본 로그·모델·캡처는 `tmp/`에 두고 익명화한 결과 문서에는 source/수정 commit, engine/source/model revision, 실제 기기·환경, 항목별 `pass/fail/unsupported/unrun/blocked`, 근거와 남은 작업을 남긴다. 제품 결함은 최소 합성 재현과 회귀 검사로 수정하고 관련 실제 흐름을 다시 실행한다. readiness 제거·hash 무시·실패 skip·근거 없는 timeout 확대로 통과시키지 않는다. staged diff·개인정보·공백 오류 검토 후 필요한 작업만 커밋하며 원격 push는 하지 않는다.

Mac 후속 §100에서는 URI/decoder 오류와 audio history 배치를 별도 호환 환경으로 수정했지만 SmolVLM·Gemma3n·일부 Gemma4·Qwen3 도구 후속 답변의 내용 실패를 유지했다. 모델 변경으로 기존 고정 모델의 실패를 삭제하지 않는다. `158f966`의 source에 대한 실제 Windows/Linux 검증·Strata serving·새 플랫폼 패키지는 여전히 unrun이다.
