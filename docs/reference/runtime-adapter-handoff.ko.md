# 외부 런타임 어댑터 v1 및 Windows·Linux 검증 인계

## 현재 상태와 검증 범위

2026-10-14 이후 Windows → Linux → Mac에서 변경 검증을 우선하고 `--help` 기반 엔진 중립 GUI로 전환하는 실행 순서는 [Windows 검증과 구조 전환 계획](windows-device-handoff.ko.md)을 따른다. 아래 문서는 현재 구현된 manifest/probe 계약과 기존 실행 절차를 보존한다.

공통 core 구현은 `9d0e9cbc4dc710a77573dc3b30713166f364a496`, SDK 보완은 `f1b94e40f98d2e4c4b31b5936a418981bfa5c69d`이며 Mac GUI 검증 중 수정한 프로필·취소 후 재시도까지의 기준은 `51afc569ceb7b0cf126c26664cf756889ae51c25`다. Mac 잔여 미디어 복구 도구와 검증된 local runtime 등록은 `64791d2`, 자동 시스템 안내 선택은 `158f966`이다. Gemma4 audio padding 호환 wheel은 `5ba74fe`, 대화별 첨부 순서와 parser 오류 안내는 `4a97627`이다. 작업 브랜치는 `codex/macos-device-validation`이다. 상세 실행 근거와 남은 항목은 [검증 결과 §98](macos-device-validation-results.ko.md#98-외부-런타임-인터페이스와-windowslinux-인계)와 [실제 Mac GUI §99](macos-device-validation-results.ko.md#99-외부-런타임의-실제-mac-gui와-기존-환경-복원)를 따른다.

추가 미디어 검증은 [Mac 결과 §101](macos-device-validation-results.ko.md#101-미디어-내용과-도구-후속-답변의-추가-원인-검증)과 [복구 절차](macos-validation-recovery.ko.md)를 따른다. 선택한 실제 MLX Python에서 `check_mlx_audio_history.py`와 `check_gemma4_audio_packing.py`를 실행한 뒤, 길이가 다른 두 녹음의 내용·첫 녹음 재사용·usage·취소/Retry·정상 재시작을 검사한다. 두 checker의 성공은 실제 모델 내용 성공을 뜻하지 않는다. MLX 미지원 기기에서는 stdlib 도구만 실행하고 실제 MLX 검사는 unsupported로 기록한다.

[원래 모델 추가 검증 §102](macos-device-validation-results.ko.md#102-원래-모델을-유지한-잔여-오류-검증)의 수정은 MCP 관찰값 형식 `60626fb`, Idefics3 단일 이미지·Gemma3n 입력 계산 `d793781`이다. MCP는 단일 text block만 간결한 JSON으로 전달하며 rich/structured/error 결과·native 승인/취소·call ID/원본 제한을 유지한다. 같은 원래 Qwen3 2B4bit는 Mac 실제 앱의 structured call→앱 승인→Mac Yes→도구 실제 실행1회→입력과 다른 반환값 `synthetic result` 답변 및 정상 Quit/이력 재로드를 통과했다. Windows/Linux 실제 앱에서도 입력 인자와 다른 도구 반환값을 사용해 같은 소형 모델의 후속 답변을 확인한다. completed-history 직접 추론으로 실제 도구 호출을 대신하지 않는다. Mac 개발 화면의 재로드·승인창 timeout 시도는 실패 기록으로 보존하며 최종 검사는 production dist/Vite preview를 사용하는 실제 WKWebView였다.

Idefics3 source 준비 도구는 고정 archive/두 소스 해시를 확인하며 기존 출력·weights·projector·다른 모델·여러 tile의 분기를 바꾸지 않는다. Python3.12에서 새 소스를 준비하고 대상 OS CPU runtime을 별도 local build로 생성한다. 상세 pin/빌드·portable import 계약은 복구 절차를 따른다. Mac에서는 원래 SmolVLM256M Q8_0/f16 projector와 image-first/모든 요청 항목을 다루는 일반 지침의 조합이 원래 질문·후속·정상 재시작을 통과했다. 지침 없는 조건의 누락·후속 오답과 multi-view 대조 실패는 별도로 남는다. Windows/Linux는 같은 원래 모델·입력·지침으로 fresh probe/내용/usage/취소/Retry/재시작을 실제 확인하고 해당 OS 결과를 기록한다.

MLX media7에는 Gemma3n media prefill 배율과 single/batched shared query 위치 보정이 들어갔다. 지원 기기에서는 설치한 Python으로 `check_gemma3n_embeddings.py`도 실행한다. Mac 원래4bit 모델의 단수·복수 전사 오류는 이 수정 뒤에도 남았으므로 내용을 pass로 표시하지 않는다. MLX 미지원 OS의 해당 검사는 unsupported이며 이 문서로 지원을 선언하지 않는다. 이번 소스의 실제 Windows/Linux·Strata 추론·새 배포 패키지는 계속 unrun이다.

[후속 Gemma3n 검증 §103](macos-device-validation-results.ko.md#103-gemma3n-토큰-중복과-독립-디코더-대조)의 `754faf1`/media8은 tokenizer template를 processor에 전달하고 `**kwargs` dispatcher에도 caller의 `add_special_tokens` 정책을 전달한다. 기존 기본 runtime은 교체하지 않으며 새 환경에서 `check_mlx_chat_tokens.py`를 실행한다. Mac 실제 앱의 원래 입력은 BOS 한 번/PP208로 고쳐졌지만 전사는 여전히 fail이다. 같은4bit 파라미터의 실제 Transformers decoder/Torch head 생성도 오답이다. 공개 Unsloth 배포본에서 Google metadata와 전체 해시가 같은 원본 BF16 shard를 확보했고, 원본 전처리/공식 decoder의 float32 대조에서도 같은 전사 오답이 재현됐다. checker 성공이나 다른 모델의 답변으로 전사 정확도를 통과 처리하지 않는다. 대상 OS에서는 template 있음/없음·명시적 caller 정책·기존 미디어 이력과 실제 내용을 따로 검사한다.

[Gemma3n 정렬 검증 §104](macos-device-validation-results.ko.md#104-gemma3n의-오디오-임베딩-위치와-동일-모델-재검증)의 `4aeddcd`+`7ee402a`/media12은 명시적 `--gemma3n-audio-padding encoded-left`를 지원한다. 별도 프로필의 `extra_args`에 `["--gemma3n-audio-padding", "encoded-left"]`를 넣는다. waveform·mel·mask와 유효 벡터를 유지하고 padding 슬롯을 앞에 배치한다. 기본 `model`은 기존 처리다. 지원 환경에서 `check_gemma3n_audio_padding.py`와 원본 내용·다른 길이 음성·혼합 이력·30초 초과400/재시도·프로필 재로드를 검사한다. Mac의 원래 전사 오류는 이 정책으로 정확했으나 긴 결합 음성의 관사 오류는 별도 fail이다. MLX 미지원 OS는 unsupported로 기록하며 다른 엔진이나 Windows/Linux/Strata 성공으로 대체하지 않는다.

[긴 Gemma3n 음성 검증 §105](macos-device-validation-results.ko.md#105-gemma3n의-긴-결합-음성과-입력-디더-재검증)의 `db41797`/media13은 `encoded-left`와 함께 명시적 `--gemma3n-audio-dither`를 지원한다. 별도 프로필의 `extra_args`는 `["--gemma3n-audio-padding", "encoded-left", "--gemma3n-audio-dither"]`다. 녹음별 local RNG seed0/표준편차1e-4의 재현 가능한 입력 dither이며 기본은 꺼짐이다. 파일·샘플 수·mask·공유 processor·전역 RNG·30초 제한을 보존하고 처리 신호/mel만 달라진다. `check_gemma3n_audio_dither.py`와 실제 긴 음성·다른 길이의 이력·반복·재시작·초과400/재시도를 지원 OS에서 검사한다. Mac의 고정 결합 음성은 실제 앱에서 전체 전사가 정확했으나 새3개 음성 내용 오류와 원본 FP 참조 실패, 임의 dither seed의 실패는 남았다. 이 하위 성공을 일반 정확도나 Windows/Linux/Strata 통과로 대체하지 않는다.

Windows/Linux 실제 앱에서 **첨부를 질문보다 먼저 전달**을 선택하고 새 입력/첨부 이력의 순서, Retry snapshot, 빈 대화 저장·재로드를 확인한다. 기존 대화는 text-first를 유지해야 한다. 영상 프레임·시각 설명과 전사문을 잘라내거나 원본 파일의 정체성을 바꾸면 실패다. runtime probe와 모델별 미디어/도구 지원을 우회하지 않는다. SmolVLM256M/Qwen3-VL2B의 오류를 500M/4B의 성공으로 대체하지 않는다. §102의 Gemma3n4bit/공개8bit와 §103의 원본 대조는 전사 fail이었다. §104에서는 같은4bit와 원본 decoder의 명시적 임베딩 정렬로 원래 입력을 해결했고, §105의 별도 입력 dither 옵션에서는4bit의 고정 긴 결합 음성도 정확했다. 추가 내용 오류·원본 FP 참조 실패의 범위는 §105를 따른다. waveform padding_side 변경만으로 해결한 결과는 아니다. 해당 OS의 실제 검증·새 패키징·Strata 추론은 계속 unrun이다.

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
| `launch_bindings` | 선택적 entry point 선택 기록. `version: 1`, `launch.args` 앞부분 중 고정 entry point의 토큰 수 `prefix_len`과 순서 있는 `bindings: [{name,argument}]`. `name`은 `model/host/port/model_alias`, `argument`는 `{kind:"positional"}` 또는 `{kind:"flag",flag,equals?}`다. prefix 뒤에 binding을 펼친 결과가 `launch.args`와 정확히 일치해야 한다. 선택적 `options_separator: "--"`는 모든 앱 binding 뒤, 공통 GUI 옵션 앞에 명시적 wrapper 경계를 둔다. 이를 사용하는 wrapper가 두 영역을 따로 해석해야 한다. |
| `bridge_command` | 선택적 명시적 bridge 연결. `{version:1,environment_variable,argv:[engineProgram,...enginePrefix]}`. 엔진 프로그램은 절대 경로이며 `artifacts`에 포함되어야 한다. argv는 템플릿 확장 없이 JSON 문자열로 지정한 환경 변수에 넣어 help·probe·launch에 전달한다. 변수 이름은 고정 env/인증 env와 충돌할 수 없으며 앱 소유 변수는 사용할 수 없다. |
| `launch_resources` | 선택적 bridge 작업 디렉터리 요청. `{version:1,directory_env}`. AioLM이 launch마다 생성한 UUID 디렉터리의 절대 경로를 해당 환경 변수로 전달한다. 고정 env·bridge argv env·앱 소유 변수와 충돌하면 거부한다. bridge는 원본 배포 설정을 덮어쓰지 않고 여기에 파생 설정을 만든다. 일반 소유 프로세스의 종료·실패 시 정리하며, background CLI는 UUID와 PID를 상태에 보존하고 실제 중지 후 소유 표식을 확인해 정리한다. help·probe는 이 임시 디렉터리를 받지 않는다. |
| `model_formats` | `gguf/hf-safetensors/mlx/unknown` 선언. 선언만으로 모델 지원을 확정하지 않는다. |
| `models` | 선택적 `{path,name}` 명시적인 외부 모델 binding 목록. 새로운 형식·Strata deployment JSON은 `unknown`으로 등록하고 실제 probe로 검사한다. |
| `artifacts` | 선택적 adapter 스크립트·library·설정의 절대 경로. 등록 시 전체 SHA-256을 저장하고 변경을 거부한다. 종속 파일은 제공자가 빠짐없이 선언해야 한다. |
| `health_path`, `health_authenticated` | loopback 상태 endpoint와 인증 필요 여부. 소유 listener 및 `/v1/models`의 예상 alias도 함께 확인한다. |
| `options` | 옵션 `key`, `target: launch/request`, `kind`, 선택적 `flag/group/runtime_default`. launch 옵션은 flag와 probe의 `{options_json}` 전달이 필요하다. |
| `option_metadata` | 선택적 명시 옵션 정보. `{version:1, engine_id, adapter:{id,revision}, options:[{flag, kind?, arity?, repeatable?, choices?, range?, unit?, runtime_default?, restart_required?, sensitive?, local_path?, reserved?}], constraints:[{kind:"requires"/"excludes", when:{flag,equals?}, other:{flag,equals?}}]}`. `engine_id`는 manifest의 엔진과 같아야 하며 각 항목은 도움말에 나타나는 flag 표기 하나를 가리킨다. 최대 256개 항목·제약이다. |

Bindings는 `{model}`, `{model_alias}`, `{host}`, `{port}`, `{api_key}`, `{ctx_size}`, `{parallel}`, `{options_json}`이다. probe와 launch는 선택 모델을 받아야 하며 launch는 앱이 지정한 port를 사용한다. `{api_key}`는 env에서만 허용한다. 빈 credential binding은 env에 넣지 않는다. 모델·port·host·인증 및 canonical messages/stream/tools를 사용자 옵션으로 덮어쓸 수 없다. argv의 한 원소는 한 인자로 전달되므로 경로 공백·한글을 shell quoting으로 다시 감싸지 않는다.

실행 파일/entry point 등록 GUI는 선택한 prefix와 위치/flag 바인딩을 `launch_bindings`에 기록한다. 예를 들어 `prefix: ["--server"]`와 positional 모델은 `--server`를 모델 flag로 다시 추정하지 않는다. 선택 기록의 변경도 모델 probe identity를 바꾼다. metadata가 없는 기존 v1 manifest는 이전 해석과 직렬화를 유지하며 자동으로 새 필드를 채우지 않는다. 알 수 없는 metadata version, 중복 이름/flag, launch 템플릿과 다른 기록은 거부한다. 선택 기록은 help나 API 능력의 검증을 대신하지 않는다.

bridge 등록 GUI에서는 bridge가 엔진의 JSON argv를 읽는 환경 변수 이름을 사용자가 명시한다. bridge는 이 계약을 구현해야 하며, 앱이 임의의 wrapper에 엔진 인자를 자동 전달한다고 가정하지 않는다. 새 entry point draft의 `protocol: {kind:"bridge",program,prefix,engine_argv_env}`는 위 `bridge_command`로 저장된다. 기존 manifest의 생략된 필드는 유지한다. 기존 bridge draft에서 비어 있지 않은 엔진 prefix를 명시적 연결 없이 버리는 동작은 거부한다.

옵션 GUI와 모델·포트 바인딩은 실제 HTTP launch 명령인 bridge의 도움말에서 확인한다. 원래 엔진의 옵션을 사용하려면 bridge가 그 옵션을 문서화하고 전달해야 한다. 선언한 artifact의 도움말은 검사 목적으로 탐색할 수 있지만 bridge 실행 옵션의 근거로 수락할 수 없다. 같은 인터프리터를 쓰는 다른 스크립트도 등록한 launch prefix 검사를 우회하지 못한다. 엔진 argv 변경은 help와 모델 probe의 identity를 무효화한다. 이 연결이나 도움말 성공은 HTTP·모델·API 능력의 검증을 대신하지 않는다.

도움말 재탐색의 보존 값 경고는 현재 provider 설정을 기준으로 한다. 설치된 runtime의 catalog/manifest가 계속 설명하는 옵션과 전용 제어·순서 기록은 원시 도움말에 없다는 이유만으로 사라진 옵션으로 표시하지 않는다. 반면 새 entry point manifest에는 이전 수동 manifest의 옵션 정의가 없으므로 새 도움말에 없는 값은 검토 대상으로 남긴다. 재등록 화면도 추가·삭제·변경·보존 키를 표시하며, 수락된 도움말이 있다면 그 snapshot을 비교 기준으로 사용한다. 아직 수락하지 않은 탐색을 반복해도 비교 기준이 바뀌지 않는다. 이전 snapshot이 없어도 현재 도움말에 없는 저장 값은 표시한다. 경고·비교는 저장 값을 삭제하거나 재작성하지 않는다.

도움말은 구문만 보여 준다. 값이 비밀인지, 숫자의 단위, 재시작 필요 여부, 형식·범위·선택지·기본값과 옵션 사이의 의존/배타는 엔진이나 어댑터 제공자가 `option_metadata`로 명시한다. 등록 GUI는 같은 JSON을 선택 입력으로 받아 entry point와 함께 도움말 탐색·등록에 사용하며 엔진별 화면을 만들지 않는다. 알 수 없는 version·필드, 다른 엔진의 `engine_id`, 빈 `adapter.id/revision`, 형식과 맞지 않는 선택지·범위·기본값, 사실이 없는 항목은 등록 전에 거부한다. 정보는 수락한 도움말이나 manifest 옵션 중 같은 flag 표기를 가진 launch 옵션에서 아직 미확정인 사실만 `Documented`·`Adapter{id,revision}` 출처로 채운다. 새 옵션, request field, app-owned binding은 만들지 않는다. 도움말이 이미 보여 준 구문과 앱 binding이 항상 우선하며, 다른 선언·도움말에 없는 flag·binding 대상 항목·적용하지 못한 제약은 덮어쓰지 않고 차이로 표시한다. 결과는 설정 renderer·검증·저장 profile·실제 argv가 함께 쓰는 하나의 effective schema다. 비밀 값은 기본적으로 가린 입력, 순서 목록, 명령 미리보기에서 표시하지 않는다. 화면의 password 입력만으로는 다른 출력이 보호되지 않으므로, backend 명령 미리보기(`--flag=value` 포함), `aiolm-cli config` 출력(저장 profile 사본 포함)과 benchmark 기록도 선택한 runtime의 schema가 비밀로 표시한 저장 값을 이름과 관계없이 가린다. 수락한 도움말이 stale이거나 이전 parser가 쓴 snapshot이어도 그 snapshot으로 비밀 key를 계속 판정한다. 실제 실행 argv와 저장 값, 미리보기 응답 형식은 바꾸지 않으며 기존 이름 기반 가림도 유지한다. 선택하지 않은 엔진도 저장된 runtime별 manifest·수락 schema의 명시적인 민감 값 정보를 합쳐 CLI의 모든 profile 사본에서 가린다. 엔진이나 runtime 디렉터리 개수로 이 판정을 조용히 생략하지 않는다. 민감 옵션의 기본값·정보 차이·검증 오류도 가리며 원본 저장 값과 실제 argv는 유지한다. `option_metadata`가 있는 manifest만 그 digest가 도움말 identity와 launch fingerprint에 들어가므로, 정보를 바꿔 다시 등록하면 이전 도움말 수락과 모델 probe를 재사용하지 않고 저장 값을 유지한 채 다시 검토하게 한다. 필드가 없는 기존 manifest·draft·payload의 직렬화와 identity는 그대로다.

내장 llama.cpp는 고정 소스 `14310190` `common/arg.cpp`가 Hugging Face access token으로 정의한 `-hft, --hf-token`만 비밀 값으로 표시한다. 이름이나 설명 문구의 패턴으로 비밀·단위·제약을 추정하지 않는다.

catalog·manifest 옵션이 수락한 도움말의 같은 표기(다른 key의 alias 포함)나 같은 key를 가리키면 기존 key mapping과 직렬화를 유지하고 key·값 개수·형식·선택지·범위·기본값·반복·적용 위치 차이를 출처와 적용 쪽과 함께 표시한다. key·기본값·반복·출처 차이만으로는 유효한 실행을 막지 않는다. 선언대로 직렬화하면 도움말이 보여 준 값 개수를 벗어나거나, 저장 값이 도움말이 지원 사실로 보여 준 형식·선택지·범위 밖이면 저장·import·미리보기·실행 검증에서 해당 저장 값을 거부하고 값과 legacy key mapping은 보존하며, 도움말이 받는 값 선택, 저장 값 제거, 선언 수정 후 재등록(또는 도움말이 맞는 runtime 선택)을 안내한다. 도움말이 형식·범위를 보여 주지 않으면 추정하지 않는다.

`option_metadata`의 제약이 도움말에 없는 flag나 앱 binding을 가리켜 적용할 수 없으면, 그 제약이 다루는 옵션의 저장 값은 제약 없이 실행하지 않고 이유와 함께 거부·보존한다. 정보 전체를 유효한 schema로 결합할 수 없으면 어느 사실도 부분 적용하지 않되 `sensitive: true`는 유지하고, 정보가 설명하는 옵션의 저장 값은 수정 전까지 거부한다. 선언 값 하나(선택지·기본값·제약 operand)는 32 KiB, 정보 전체는 128 KiB, manifest와 해시·probe 결과를 포함한 전체 등록 기록은 기존 읽기 한도인 256 KiB로 제한한다. 한도를 넘으면 probe나 게시 전에 크기를 알리고 거부하며 기존 파일은 그대로 둔다.

도움말 parser는 짝이 되는 같은 이름의 값 옵션이 없을 때만 단독 `--no-foo`를 `foo`의 false 표기로 읽는다. `--host HOST`처럼 같은 이름의 값 옵션이 있으면 `--no-host`는 별도 switch(`no_host`, 표기하면 true)로 남아 두 옵션이 모두 보존된다. 이 해석 변경으로 parser version이 올라가 이전 parser의 snapshot·수락은 stale이 되고, 이전 key로 저장한 값은 의미를 옮기지 않고 검토 대상으로 남는다.

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

등록한 entry point의 고정 옵션(예: `--engine strata`, `--flag=value`)은 같은 옵션의 도움말 별칭을 포함해 일반 설정으로 덮어쓸 수 없다. 바꾸려면 다른 entry point를 명시적으로 등록한다. 어댑터는 `option_metadata.options`에 `reserved: "이유"`를 선언해 모델 수명·도구 서버 등 앱 소유 동작을 예약할 수 있다. 이유는 짧은 비어 있지 않은 문자열이며 새 옵션이나 request field를 만들지 않고 기존 옵션을 잠그기만 한다. GUI는 고정 entry point·예약 옵션·model/port binding을 구분해 안내하며, 기존 저장값은 삭제하지 않고 실행을 거부한다. 예를 들어 고정 revision의 Strata 어댑터는 `--lazy`·`--idle-unload`·`--before-load`·`--mcp-config`를 명시적으로 예약한다. 고정 `serve/server.py`는 deployment에 `tokenizer`가 없으면 `--tokenizer`를 사용하므로, helper가 검사한 tokenizer를 바꾸지 못하도록 `--tokenizer`도 예약한다. 다른 엔진의 같은 이름은 어댑터의 선언 없이 예약하지 않는다.

## 원본 Strata 및 개인 엔진

대상은 [Niko1221/Strata](https://github.com/Niko1221/Strata)다. 원본 Strata는 Windows/Linux x86-64와 해당 GPU·메모리 요구사항을 만족한 기기에서 준비한다. Mac M2 결과를 지원 근거로 사용하지 않는다. 구체적인 build/download/라이선스는 고정 revision의 공식 문서를 따른다.

고정 source revision과 설치된 Python 환경, 엔진 binary·weights·tokenizer를 먼저 준비한다. SDK는 [serve/server.py](https://github.com/Niko1221/Strata/blob/main/serve/server.py)의 OpenAI 호환 server를 사용한다. AioLM 전용 deployment config를 작성해 엔진을 foreground로 실행한다. 독립 `lazy_load`, 저장 `api_key`, `mcp_servers`, `before_load`는 거부한다. lifecycle과 도구 승인은 AioLM이 담당한다. 기존 개인 config를 수정하지 않고 별도의 테스트 config를 선택한다.

Strata의 browser CORS 설정도 명시한다. 고정 revision `296b59d2f73c8f04a805df29c2fa97655adace78`에서는 `cors_origins`의 기본값이 빈 목록이므로 native CLI와 health probe가 성공해도 GUI의 `/v1/*` 요청은 브라우저에서 거부된다. Windows production WebView의 origin이 `http://tauri.localhost`인 경우 전용 deployment JSON에 `"cors_origins": ["http://tauri.localhost"]`를 설정한다. 다른 OS나 개발 서버는 실제 origin을 확인하여 정확한 값만 추가하고, 모든 origin을 허용하는 `*`로 대체하지 않는다. loopback host와 AioLM이 전달하는 API key를 유지한다. helper의 native version probe는 같은 deployment의 `env`와 `lib_dirs`를 사용하며 전역 SDK 경로나 시스템 설정 변경을 요구하지 않는다.

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

[오디오 순서 재검증 §106](macos-device-validation-results.ko.md#106-gemma3n-원본-fp와-새-음성의-전사-대조)의 `f1049eb`/media14는 명시적 text/image/audio 순서 보존을 추가한다. 기존 media13의 선택 옵션·기본 정책을 유지한다. 지원 기기의 실제 런타임에서 확장된 `check_mlx_audio_history.py`를 실행하고 앱의 첨부 우선 선택·저장/재로드·서로 다른 음성의 이력을 검증한다. Mac 원본 FP 긴 관사와 새3개 전사는 여전히 fail이며 native float32 RoPE 버퍼를 유지하지 않은 BF16 실험의 성공도 채택하지 않았다. 이 결과를 다른 OS/런타임의 실제 성공으로 복사하지 않는다.

### 공통 GUI의 어댑터 설정 파일

실행 파일을 직접 선택하는 등록 여정에 더해, **어댑터로 간편 연결**에서 제공 설정을 보거나 외부 설정 파일을 가져올 수 있다. 엔진 목록은 닫힌 enum이 아니다. 어댑터 설정은 엔진별 화면 코드 대신 입력 항목과 producer 명령을 제공하고, 동일한 `EntrypointDraft`를 반환한다. 설정을 불러오는 것만으로 producer를 실행하거나 엔진을 등록하지 않는다. 사용자가 설치 정보를 입력하고 확인 명령을 실행한 뒤에도 도움말 탐색·binding 검토·등록·모델별 fresh probe가 필요하다.

설정 파일은 최대 64 KiB UTF-8 JSON(선택적 BOM)이며 다음 계약을 사용한다.

- `version: 1`, 자유로운 `id`, `title`, `description`.
- `fields: [{key,label,kind,required,default?}]`: `kind`는 `file/folder/text`, 최대 32개. 기본값은 어댑터가 선언한 값이며 현재 기기의 경로나 설정을 복사하지 않는다.
- `prepare: {program,args,env,working_directory?}`: 명시적으로 선택한 절대 실행 파일과 token 배열. 현재 v1의 `env`는 비어 있어야 한다. shell 문자열이나 비밀 입력은 사용하지 않는다.
- `artifacts`: producer의 스크립트·종속 파일을 선언한다. 실행 파일과 함께 명령 전후 해시를 검사한다.
- `{input:key}`와 `{resource:name}`는 **한 argv token 전체**를 대체한다. 공백·Unicode·빈 값·기호를 shell로 재해석하지 않는다. 부분 문자열 치환은 거부한다. `{resource:name}`는 제품에 포함된 helper 이름만 허용하며, 다른 어댑터는 선택한 외부 producer와 명시적 artifact를 쓸 수 있다.
- producer는 stdout에 단일 `EntrypointDraft` JSON, 진단은 stderr에 쓴다. 공통 소유 프로세스의 출력 한도·15초 기한·취소·경합 publication을 적용하고, 반환 draft를 검증한다. 실패·취소는 등록이나 Ready를 만들지 않으며 입력을 보존해 재시도할 수 있다.

제공 helper는 production 앱에 포함하며 표준 앱 runtime 경로의 내용 해시별 폴더에 배치한다. 개발 checkout의 절대 경로가 필요하지 않는다. 기존 helper가 달라졌으면 덮어쓰지 않고 오류를 반환한다. 설정 파일이나 helper 변경은 새 명령 identity와 명시적 재등록을 필요로 한다. 예전 draft에서 생략한 `models`, `launch_resources`, `options_separator`는 자동으로 채우지 않는다.

제공 Strata 설정은 검토한 source revision `296b59d2f73c8f04a805df29c2fa97655adace78`의 설치된 Python·SDK 폴더·전용 deployment JSON을 사용한다. 명시적 bridge가 선택한 **native 실행 파일의 실제 `--help`**와 자기 `--aiolm-model/host/port` binding을 보여 준다. 고정 native build는 도움말을 stderr에만 쓰고 AioLM은 비어 있지 않은 stdout만 해석하므로, bridge는 native stdout·stderr를 한 pipe로 받아 binding 행 뒤의 하나의 stdout 문서로 전달한다. 네이티브 옵션은 별도 `--` 경계 뒤에 전달되어 원본 deployment의 `args` 뒤에 정확한 token으로 붙는다. 고정 source의 scalar parser는 뒤의 값을 적용하며, 반복 옵션의 의미와 검증은 엔진에 남긴다. 도움말에서 확인하지 못한 타입·제약·API 능력을 확정하지 않는다.

bridge는 `launch_resources`의 앱 소유 폴더에만 파생 deployment와 로그를 만들고, 설치된 HTTP 서버에는 고정 `--engine strata`, 파생 config, 앱 host/port만 전달한다. 원본 deployment·weight·tokenizer를 바꾸지 않는다. 모델 소스·입력·resident protocol은 명시 metadata로 예약하며, 서버가 deployment의 `gpu`·`backend`로 설정한 표시 장치를 덮어쓰는 native `--gpu`도 예약한다. 장치를 바꾸려면 다른 전용 deployment를 선택한다. flag처럼 생긴 **값**을 별도 옵션으로 다시 해석하지 않는다. HTTP 서버와 native CLI의 인자를 섞지 않는다. 모델·tokenizer·source revision·build 검사는 별도 기존 probe가 담당한다. 도움말·producer 성공은 모델 로드나 추론 성공의 증거가 아니다. 다른 revision은 검토한 어댑터 설정/bridge가 필요하며, 다른 엔진의 설정 파일 추가는 앱의 공통 기능에 engine ID 분기를 요구하지 않는다.


## 검토한 실행 디렉터리

`HelpRequest.working_directory`는 선택적인 절대 경로이며, help를 수락하면 `AcceptedHelp.working_directory`에 실제 canonical 실행 디렉터리를 기록한다. 이후 같은 runtime의 help·launch와 명시적인 probe 디렉터리가 없는 probe는 이 문맥을 사용한다. GUI·CLI·shortcut의 시작 폴더가 다르다는 이유로 수락한 옵션이 stale이 되지 않는다. 기존 필드가 없는 request/accepted 레코드는 생략된 wire 표현과 이전 동작을 유지한다.

Manifest의 명시적 launch/probe 디렉터리는 우선한다. probe 디렉터리가 없으면 launch 디렉터리를 사용하며, 새 등록의 첫 probe는 제거된 같은 runtime ID의 이전 help 문맥을 가져오지 않는다. GUI의 실행 작업 디렉터리 선택은 adapter가 선언한 디렉터리를 덮어쓸 수 없다. Entry point 등록에서 help에 경로를 지정하려면 entry point 자체에도 그 경로를 명시해야 한다.

실제 디렉터리 변경은 help/probe identity를 변경하므로 다시 검토하고 model probe를 실행해야 한다. 기록된 폴더가 사라지면 저장된 옵션을 유지한 채 실행을 거부한다. 공통 도움말 화면에서 새 폴더를 선택하고 다시 탐색·수락해 복구한다. 폴더 선택의 늦은 응답은 이후의 사용자 입력이나 runtime 전환을 덮어쓰지 않는다. 이 계약은 실행 디렉터리에 한하며 subcommand·사용자 positional layout 및 encoding/locale의 후속 구현을 대신하지 않는다.


## 명시적 entry token 역할과 subcommand 배치

`command_layout`은 manifest·entry help·draft에 선택적으로 추가하는 버전 1 계약이다. `subcommands`는 실제 **serving entry prefix**의 0부터 시작하는 token 위치이며, `options`는 고정 옵션 위치와 뒤따르는 정확한 값 개수다. 예를 들어 prefix가 `["-I", "engine.py", "--label", "serve", "serve", "api"]`라면 다음 선언은 첫 `serve`를 `--label`의 값으로, 마지막 두 단어를 실제 중첩 subcommand로 구분한다.

```json
{
  "version": 1,
  "subcommands": [4, 5],
  "options": [{ "index": 0, "values": 0 }, { "index": 2, "values": 1 }]
}
```

진입 등록 GUI에서 **진입 인자 역할**을 켠 뒤 각 token을 리터럴·고정 옵션·서브커맨드로 명시한다. 고정 옵션에 소속된 값은 별도 subcommand로 선택할 수 없다. 선언은 어댑터/사용자 정보이며 도움말이나 API 능력을 새로 입증하지 않는다. Bridge를 사용하는 경우에는 실제 HTTP serving bridge의 prefix를 연결하며, 원래 native argv를 전달하는 기존 JSON 계약은 유지한다.

Help 요청의 scope는 이 선언이 증명하는 실제 prefix와 일치해야 한다. 값 위치·범위 밖 token·중복/역순 scope·겹치는 역할·미지원 버전은 거부한다. 고정 옵션처럼 생긴 **값**은 그 이름의 일반 옵션을 예약하지 않는다. Layout 변경은 help 및 model probe identity를 무효화한다. 이전에 선언 없이 임의의 nonempty scope를 저장했다면 값을 유지한 채 다시 검토하도록 거부하며, 실제 subcommand를 연결한 entry point를 재등록해야 한다. 기존 scope 없는 등록과 생략된 필드의 wire/hash는 유지한다.

Manifest 옵션은 선택적 `scope`로 위치를 명시할 수 있다. `[]`는 전역, `["serve"]`는 중간 scope다. 생략하면 기존처럼 수락한 help scope에 적용한다. 선언은 layout 안에 있어야 하며 명시적 scope 데이터 변경도 help/model probe identity를 무효화한다. 하나의 공통 resolver가 생성 과정에서 scope 경계를 기록하며, 실행 serializer는 그 경계로 전역 옵션을 첫 subcommand 앞에, 중간 옵션을 다음 subcommand 앞에, 최종 옵션을 기존 app binding 뒤에 배치한다. 같은 단어를 값과 subcommand로 썼다는 이유로 argv를 검색하거나 지우지 않는다. 내부 경계는 기존 `ResolvedOptions` wire에 추가하지 않는다.

공통 import의 occurrence/spelling 저장 형식도 manifest launch 옵션에 사용할 수 있다. 타입·arity·반복·순서·제약은 effective schema로 검사하며 기존 manifest text의 `max_len`도 각 occurrence에 적용한다. 기존 scalar 저장형과 request 옵션 계약은 보존한다. 이 구현 단위의 근거는 합성 실제 help·저장/재로드·subprocess parser 및 GUI 검사다. encoding/locale과 실제 production 엔진 여정은 후속 검증이 남아 있으며 이 절로 완료 판정하지 않는다.

### 위치 인자 배치와 전체 명령 import

도움말은 위치 인자의 이름과 순서만 보여 주며, 실행 템플릿이 그 자리를 이미 채우는지(모델 경로 binding, 고정 token)는 보여 주지 않는다. 그래서 도움말의 위치 인자는 역할을 지정하기 전까지 앱 소유(`discovery`)로 남고, 저장된 값은 삭제하지 않은 채 "자리가 지정되지 않음" 사유로 실행을 거부한다. 옵션 화면의 **위치 인자 배치**에서 각 자리를 `사용자 입력`, `앱 binding`(manifest `launch_bindings`의 positional binding), `entry token`(선언한 layout의 마지막 subcommand 뒤 리터럴)으로 한 번에 지정한다. 배치는 확인한 구문과 같은 파일에 수락한 도움말 fingerprint에 고정해 저장하며, 위치 역할이 있으면 version 2로 기록한다. 역할이 없는 파일은 version 1 그대로이고 version 1에 위치 역할이 있으면 거부한다. 배치는 launch identity에 포함된다.

배치는 하나의 layout으로 검사한다. 지정한 자리는 첫 자리부터 빈틈없이 이어져야 하고, 템플릿의 모든 positional binding과, 선언한 마지막 subcommand 뒤의 모든 리터럴이 각각 정확히 한 자리를 가져야 한다(그대로 두면 첫 자리를 차지하기 때문이다). subcommand를 선언하지 않은 layout에서는 prefix 리터럴(예: `python -I script.py`의 script 경로)이 그 명령의 위치 인자라는 근거가 없으므로, 지정하지 않으면 원래 자리에 그대로 두고 명시적으로 지정한 리터럴만 옮긴다. 사용자 자리는 템플릿 자리 앞·사이·뒤 어디에도 둘 수 있다. layout 없는 entry token, 다른 이름의 binding, 고정 옵션의 값, 중복, bridge의 `--` 경계를 넘는 binding/token, 선언 binding이 없는 예전 manifest, 미지원 entry version은 복구 안내와 함께 거부한다. 실행·미리보기·검증은 같은 resolver를 쓴다. 지정된 템플릿 token만 템플릿 위치에서 빼내 사용자 값과 함께 선언한 자리 순서로 최종 section에 배치하며, interpreter·script·지정하지 않은 리터럴·app flag와 `--` 경계는 그대로 둔다. 값이 아니라 템플릿의 placeholder와 index로 token을 찾는다. 사용자가 템플릿 자리에 값을 저장하면 앱 소유로 거부한다. 값 개수가 바뀌는 위치 인자는 마지막으로 공급한 위치 인자여야 한다.

등록된 엔진의 명령 import는 선택한 runtime의 entry(program, prefix, layout, 구분자, 적용 중인 위치 역할)를 함께 사용한다. 붙여 넣은 명령이 등록한 program(정확한 문자열 또는 같은 파일 이름, Windows는 대소문자·`.exe` 무시)으로 시작하면 바로 뒤에 entry head가 정확히 이어져야 하며, 다르면 차이 위치를 알려 주고 거부한다. head만으로 시작하면 head를 건너뛰고, 둘 다 아니면 옵션만 붙여 넣은 것으로 본다. 선언한 subcommand 뒤의 리터럴과 entry의 `--` 구분자는 그 자리에 정확히 있을 때만 건너뛴다. 맨 단어는 자리 역할을 따른다. entry token 자리는 그 token일 때만 소비하고, binding·미지정 자리는 앱 소유 검토로, 사용자 자리는 문서화된 값 개수만큼 계획에 넣는다. Built-in runtime의 기존 import 동작은 바뀌지 않는다.

도움말 parser version 3은 위치 인자 행의 설명을 값 이름으로 세지 않는다(첫 두 칸 이상의 공백에서 이름이 끝난다). 또한 위치 인자 section 안에서는 그 section의 첫 행과 같은 들여쓰기에 있는 소문자 이름 행(argparse 기본 출력)도 위치 인자로 읽는다. 더 깊이 들여쓴 행은 설명의 이어짐이나 subcommand 목록이며 위치 인자가 아니다. section 밖의 소문자 문장은 그대로 위치 인자가 되지 않는다. 이전 parser로 수락한 도움말은 stale로 표시되어 다시 탐색해야 하며 저장 값은 유지된다. 실제 Python interpreter와 argparse script를 쓰는 검사는 `AIOLM_TEST_PYTHON`을 지정하고 `cargo test --test runtime_interpreter_command_journey -- --ignored`로 실행한다. 이 검사는 argv와 parser 수락만 확인하며 추론이나 특정 엔진 지원을 입증하지 않는다.


## 명시적인 도움말 인코딩과 locale

엔진 추가의 도움말 단계와 등록된 runtime의 도움말 화면은 같은 텍스트 설정을 사용한다. Auto는 기존처럼 BOM 또는 UTF-8을 읽으며 시스템 code page를 추측하지 않는다. UTF-8, UTF-16 LE/BE, 한국어 Windows CP949, 일본어 Windows CP932, Windows 1252를 명시적으로 선택할 수 있다. locale은 엔진이 지원하는 값을 입력하며 비우면 기존 C를 사용한다. 설정은 해당 도움말 child의 디코딩과 LC_ALL에만 적용되며 추론 HTTP/SSE와 OS 설정을 변경하지 않는다.

선택은 선택적 HelpRequest.encoding·locale로 등록/수락 request에 저장된다. 생략된 기존 request의 wire 표현은 유지한다. 명시적 선택은 도움말 fingerprint에 포함되며, 다른 설정으로 탐색한 결과를 이전 fingerprint로 수락할 수 없다. 새로 수락하면 이전 model probe를 재사용하지 않고 새 probe를 요구한다. GUI에서 선택을 바꾸면 이전 탐색 결과는 수락/등록에 사용하지 않으며 저장된 프로필 값은 유지한다.

명시적 code page는 [encoding_rs 0.8.35의 BOM 탐색 없는 decoder](https://docs.rs/encoding_rs/0.8.35/encoding_rs/struct.Encoding.html#method.decode_without_bom_handling)를 사용한다. CP949는 [Encoding Standard의 EUC-KR decoder](https://encoding.spec.whatwg.org/#euc-kr-decoder), CP932는 Shift_JIS, Windows 1252는 해당 decoder에 연결한다. 잘못된 byte는 decoding_loss로 표시하고 schema 수락을 거부하며 다른 인코딩으로 재탐색하도록 안내한다. 명시적 선택 또는 손실이 있는 캡처의 제한된 원래 byte는 선택적 raw_bytes_base64로 보존한다. 이전 정상 Auto 출력에는 이 필드가 추가되지 않으며 이전 snapshot도 읽을 수 있다.

근거는 실제 합성 child의 CP949 stdout/stderr, Auto 손실과 명시적 선택의 복구, 손상 byte 거부, locale 전달, 등록/재탐색·수락·설정 저장/재로드·model probe·정확한 subprocess argv 및 두 GUI의 요청/저장 검사다. 합성 엔진/모델 검사이며 실제 엔진 추론 또는 최종 production native GUI 성공으로 계산하지 않는다. Linux/Mac에서는 사용 가능한 locale과 실제 설치 엔진의 인코딩을 해당 OS에서 다시 검증한다.
