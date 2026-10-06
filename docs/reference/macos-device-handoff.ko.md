# Mac 기기 작업 인계

작성 기준은 2026-10-07, AioLM 0.3.1, 다중 런타임 구현 커밋 `2c7d6d3`까지다. Mac에서 할 일은 **현재 구현을 물리 기기의 llama.cpp·vllm-metal·MLX와 실제 데스크톱·설치 패키지에서 검증하고, 재현된 결함을 수정하는 것**이다. 이번 vllm-metal 및 mlx-vlm 설치·모델 추론은 아직 실제 Mac에서 실행하지 않았다.

이 문서는 세션의 변경, `tmp`의 조사·수정 보고서·검증 로그, 현재 코드를 대조해 작성했다. 필요한 내용을 본문에 정리했으므로 Git으로 저장소만 받아도 작업할 수 있다. Linux 작업은 [Linux 기기 작업 인계](linux-device-handoff.ko.md)를 사용한다.

## 1. Git으로 작업 받기

공유할 소스 브랜치는 `docs/macos-supported`다. **원본 기기의 구현 및 이 문서 커밋을 먼저 원격에 올린 뒤** Mac에서 받는다. 원격의 이전 브랜치나 공개 v0.3.1 패키지만으로 이번 변경을 검증하지 않는다.

원본 기기에서 검토한 커밋을 공유하는 명령은 `git push origin docs/macos-supported`다. 아래 명령은 받는 Mac 기기에서 실행한다.

새 checkout의 시작 명령은 다음과 같다. 기존 checkout이면 `git status --short`로 미커밋 작업을 먼저 확인·보존한다. 이미 같은 이름의 작업 브랜치가 있으면 새로 만들지 않고 이어간다.

```sh
git clone https://github.com/aiolm/AioLM.git
cd AioLM
git fetch origin
git switch -c verify/macos-runtimes --track origin/docs/macos-supported
git merge-base --is-ancestor 2c7d6d3 HEAD
git log -10 --oneline
git status --short
```

조상 확인이 실패하면 구현 커밋의 원격 공유부터 확인한다. 작업 시작 때 `git rev-parse HEAD`를 기록한다. `tmp`의 옛 patch·ZIP, Windows의 `node_modules`·`.codex-target`·`dist`, 다른 OS의 Python 환경을 복사하지 않는다. Mac에서 새로 빌드한다.

## 2. 현재 구현과 증거의 범위

| 작업 커밋 | 현재 구현 |
| --- | --- |
| `d298e8d` | 엔진별 벤치마크 계약 0.8.0, 알려진 빌드의 `?(빌드번호)` 표기 수정 |
| `e43508e` | llama.cpp·vLLM·MLX provider와 설치·등록·probe·실행·API·미디어·검증의 공통 경로 |
| `323ceb5` | 엔진 호환 모델 필터·검색·다운로드·소유권 삭제, 분할 GGUF 한 항목 및 전체 조각 다운로드 |
| `e75ed4e` | 런타임별 설치 관리, 엔진 선택과 진단, 전체 메뉴의 공통 표현 |
| `fd95beb` | 멀티모달·명시적 전처리·대화 기록·임베딩 대상 선택 |
| `786f40f` | 엔진별 성능 측정·기록·내보내기 |
| `ce8b2ac` | **엔진마다 분리된 공용 프로필만 사용**, 모델별 프로필 이전, 작은 고정 실행 영역 |
| `7b226ac` | CLI의 엔진 설치·등록·선택·번들·실행 |
| `2c7d6d3` | 실제 엔진 acceptance harness와 플랫폼 인계 |

최종 Windows 기록은 UI 160개 파일/1,549개 테스트, Rust 전체 타깃·feature, Python probe/portable, 격리 CLI·합성 harness 통과다. Chrome 합성 IPC 화면 검사에서 3개 엔진의 메뉴 18개, 고정영역 9개, 모델 선택 전후 공용 프로필 12개 조건을 확인했다. 이는 Mac WKWebView·실제 GPU·실제 모델의 통과 근거가 아니다.

기존 [macOS 검증 기록](macos-validation.md)에는 hosted macOS 15 ARM/Intel의 빌드·DMG·LaunchServices·표준 종료·설치 스크립트와 llama.cpp CPU/Metal source-build 결과가 있다. `tmp/macos-remaining-handoff.ko.md`에는 공개 설치 경로의 후속 기록도 있다. 이 과거 결과를 이번 9개 구현 커밋이나 물리 Apple Silicon의 vllm-metal·MLX 성공으로 확대하지 않는다. 최소 OS·실제 Finder/Dock·한글 입력·Keychain 수동 승인·실제 과거 버전 업그레이드는 아래에서 다시 확인한다.

## 3. 기기별 적용 범위와 환경 준비

| 기기/OS | 검증 대상 |
| --- | --- |
| Apple Silicon, macOS 15 이상 | llama.cpp CPU/Metal, vLLM의 vllm-metal 변형, 별도 mlx-vlm |
| Apple Silicon, macOS 13.3–14 | 앱 최소 OS·llama.cpp 및 설치 패키지. vllm-metal은 OS 조건 미충족으로 거부해야 함. MLX는 실제 패키지/OS 요구 조건을 따로 검사. |
| Intel Mac, macOS 13.3 이상 | llama.cpp CPU·앱·패키지. Intel Metal·vLLM·MLX를 지원으로 표시하지 않음. |

Intel의 GPU 감지와 Metal 추론 지원은 다르다. Intel Metal은 현재 카탈로그와 PR source-build 모두 미지원이다. hosted Apple Paravirtual GPU의 과거 시험 결과도 물리 Intel GPU 지원 근거가 아니다. Rosetta의 x86_64 Python으로 Apple Silicon Metal을 통과시키지 않는다.

저장소 `AGENTS.md`와 [개발 안내](../guides/development.ko.md)를 따른다. 현재 도구는 `package.json`의 Node 22.23.2/npm 12.0.2, `rust-toolchain.toml`의 Rust 1.98.0이다. Xcode Command Line Tools와 소스 빌드용 CMake를 준비하고 lockfile을 임의 갱신하지 않는다.

```sh
xcode-select --install
xcode-select -p
sw_vers -productVersion
uname -m
node --version
npm --version
rustc --version
cmake --version
```

Command Line Tools가 이미 있으면 설치 명령은 생략한다. shell과 Python의 아키텍처를 함께 확인한다. 환경/장치의 전체 출력·일련번호·개인 경로는 Git에 넣지 않는다. 최초 실행·이전·Keychain은 **별도 테스트 OS 계정**에서 한다. `AIOLM_HOME` 변경만으로 legacy 이전 경로나 OS 자격 증명 저장소까지 격리되지 않는다. CLI smoke/harness는 자체 임시 홈과 이전 경로를 격리한다.

### 서로 합치면 안 되는 Python 환경

| 엔진 | 현재 관리형 정책과 실제 검사 |
| --- | --- |
| vllm-metal | macOS 15+, native arm64 CPython 3.12/cp312. plugin 0.30.0 + vLLM 0.30.0+cpu의 해시 고정 release wheel. `mlx==0.32.1`, `nanobind==2.10.2`, `mlx-vlm>=0.6.8,<0.7.0`, `llguidance>=1.7.0,<1.8.0`, 고정 mlx-lm 소스. |
| MLX | 별도 환경에 `mlx-vlm==0.7.6`. interpreter·패키지·장치·설치된 server flag·모델 processor를 별도 probe. 코드의 Python 허용 범위는 3.10 이상이지만 실제 wheel/OS 호환은 기기에서 확인. |

vllm-metal의 mlx-lm 리비전은 `9e6acca691e64d6d8bb808c328fcdea459099cca`다. 앱은 설치 provenance와 파일을 확인한다. 두 엔진의 mlx-vlm 요구 버전이 다르므로 **같은 venv에 MLX 0.7.6을 추가 설치하지 않는다**. 관리형 Metal 설치는 `gguf,stt` extras도 포함한다. 등록한 외부 환경은 필요한 extras를 갖추었는지 검사한다.

Metal probe에는 실제 `vllm_metal.platform.MetalPlatform`, Metal 장치 사용 가능, shipped `_paged_ops` import, 일치하는 imported/distribution core·plugin 버전, loader/STT registry 근거가 필요하다. CPU core의 `+cpu` suffix는 배포 메타데이터이며 그 이름만으로 CPU 추론이라고 단정하지 않는다. 반대로 MLX 패키지가 옆에 있다는 이유만으로 Metal 준비 완료로 간주하지 않는다. 실패를 JIT fallback·readiness 검사 제거·알 수 없는 remote code 허용으로 우회하지 않는다.

## 4. 먼저 자동 검사

저장소 루트에서 실행한다. 실제 CLI 경로는 `.codex-target/release/aiolm-cli`다.

```sh
npm ci --ignore-scripts
npm rebuild esbuild
npm run typecheck
npm run lint
npm run test:unit
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features
cargo build --locked --manifest-path src-tauri/Cargo.toml --bins
npm run test:native-cli
python3 -B -m unittest discover -s src-tauri/src/providers -p '*_tests.py'
python3 -B -m unittest discover -s src-tauri/src/providers/tests -p 'test_*.py'
npm run test:provider-runtime
npm run build:cli
test -x .codex-target/release/aiolm-cli
```

일반 Cargo에서 ignored인 실모델·네트워크 검사는 아직 실행된 것이 아니다. `test:provider-runtime`은 합성 loopback 검사다. GPU/pip/CPU reference/패키지 검사는 부하와 프로세스 잔존을 구분할 수 있게 순서대로 실행한다. 시간 초과를 근거 없이 늘리거나 실패를 skip으로 바꾸지 않는다.

## 5. 우선순위별 작업

`P0`는 첫 실제 사용을 막는 핵심 검증·수정, `P1`은 전체 기능 및 배포 검증이다. Intel 또는 OS 조건 미충족 항목은 구체적 사유와 함께 unsupported로 기록한다.

| ID | 우선순위 | 해야 할 작업과 완료 기준 |
| --- | --- | --- |
| M01 | P0 | 자동 검사·native build와 아키텍처 확인. Unix process/symlink/권한 검사가 실제 실행됨. |
| M02 | P0 | llama.cpp CPU, Apple Silicon이면 Metal 설치·probe·실모델 추론·중지·재시작·source-build. |
| M03 | P0 | vllm-metal 관리형 설치/외부 등록·ABI·native import·실제 MetalPlatform·텍스트/이미지·취소·재시작. |
| M04 | P0 | 별도 MLX 설치/등록·모델/processor·텍스트·선언한 이미지/음성/영상·취소·재시작. |
| M05 | P0 | 모든 메뉴의 엔진 표현, 작은 고정영역·엔진별 공용 프로필·이전·호환 모델·지원 옵션을 WKWebView에서 확인. |
| M06 | P0 | 검색→다운로드→설정→실행, 조각 묶음·스냅샷/companion·중단/재시도·외부 파일 보존. |
| M07 | P0 | Metal STT, 명시적 음성/영상 전처리, API·대화 기록·재시도. 실제 내용 및 미지원 입력 거부 확인. |
| M08 | P1 | MCP 네이티브 Yes/No·개인화/skill·문서/RAG·프로젝트·멀티 세션·API 인증/라우팅. |
| M09 | P1 | 실제 usage·cold-cache·KV·process-group RSS·심층 검증·이력/CSV/XLSX·공유 계약. |
| M10 | P1 | 엔진별 offline bundle 왕복과 실제 추론, 해시/ABI 오류·취소·기존 파일·외부 환경 보호. |
| M11 | P1 | Finder/Dock/트레이·PATH·한글 IME·클립보드·파일/Keychain, DMG 설치/최초 실행/업데이트/최소 OS. |
| M12 | P0 | 정상 종료·Stop·취소·재시작에서 소유 서버/도구/ffmpeg/pip/CMake/collector·포트·임시 파일 정리. |

### M02: llama.cpp를 먼저 확인

설치 검사는 네트워크 다운로드를 한다. Apple Silicon이면 다음을 실행하고 Intel이면 backend를 `cpu`로 제한한다.

```sh
AIOLM_RUNTIME_INSTALL=1 AIOLM_RUNTIME_BACKENDS=cpu,metal \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test runtime_install \
  -- --ignored --nocapture --test-threads=1

AIOLM_NATIVE_CPU=1 \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test native_cpu \
  real_cpu_cli_lifecycle -- --ignored --nocapture --test-threads=1

# Apple Silicon의 실제 Metal 장치에서만 실행한다.
AIOLM_NATIVE_METAL=1 \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test native_cpu \
  real_metal_cli_lifecycle -- --ignored --nocapture --test-threads=1
```

native lifecycle은 해시 고정 약 491 MB 모델과 런타임을 다운로드한다. 임의 개인 모델로 대체해 결과를 같다고 적지 않는다. 설치 후 첫 Metal probe는 실행 파일 경로별 cold initialization 때문에 느릴 수 있으며 현재 제한은 90초다. 실제 장치의 실패 이유를 확인한다.

소스 빌드는 아래 명령으로 확인하고 Apple Silicon Metal은 `cpu`를 `metal`로 바꿔 별도로 실행한다. CMake 탐색, 서버·`llama-perplexity`·동적 라이브러리·실행 권한, 설치 취소를 확인한다. CPU/GPU 선택과 projector 비전·기존 GGUF 경로도 유지돼야 한다. 별도 로컬 GGUF smoke는 [플랫폼 검증](cross-platform-validation.md#native-acceptance)에 있다.

```sh
AIOLM_NATIVE_SOURCE=cpu \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test native_cpu \
  real_source_build_cli_lifecycle -- --ignored --nocapture --test-threads=1
```

### M03–M04: 두 Python 엔진의 설치·실제 추론

테스트 계정에서 아래 interpreter를 기기의 native arm64 Python으로 채운다. 관리형 설치가 만든 환경과 별도 등록 환경을 혼동하지 않는다. 설치·등록·probe·삭제는 각 엔진에서 확인하며 생성 ID는 실제 반환값을 사용한다.

```sh
AIOLM_CLI="$PWD/.codex-target/release/aiolm-cli"
AIOLM_BASE_PYTHON='/absolute/path/to/native-arm64-python3.12'
"$AIOLM_CLI" runtime install vllm "$AIOLM_BASE_PYTHON"
"$AIOLM_CLI" runtime install mlx-vlm "$AIOLM_BASE_PYTHON"
"$AIOLM_CLI" runtime list
"$AIOLM_CLI" runtime probe vllm '<returned-metal-runtime-id>'
"$AIOLM_CLI" runtime select vllm '<returned-metal-runtime-id>'
"$AIOLM_CLI" runtime probe mlx-vlm '<returned-mlx-runtime-id>'
"$AIOLM_CLI" doctor
```

외부 환경은 `runtime register <vllm|mlx-vlm> <환경의-python>`으로 등록한다. pip 실행 중 취소 후 staging 정리, 실패 환경을 설치 완료로 노출하지 않는지, 외부 등록 삭제 시 패키지/환경 보존을 확인한다. 패키지·아키텍처·장치 노출이 바뀌면 다시 probe하고 launch·doctor·cache가 이전 준비 상태를 재사용하지 않아야 한다.

준비된 두 환경의 interpreter와 **실제 immutable revision의 로컬 모델**을 지정한다. 아래 값은 예시 자리이며 개발 기기의 설정을 기본값으로 저장하지 않는다.

```sh
mkdir -p tmp/macos-acceptance
AIOLM_METAL_PYTHON='/absolute/path/to/vllm-metal-env/bin/python'
AIOLM_MLX_PYTHON='/absolute/path/to/mlx-vlm-env/bin/python'
AIOLM_METAL_MODEL='/absolute/path/to/metal-snapshots/full-commit-sha'
AIOLM_METAL_REVISION='<actual-metal-model-40-character-commit-sha>'
AIOLM_MLX_MODEL='/absolute/path/to/mlx-snapshots/full-commit-sha'
AIOLM_MLX_REVISION='<actual-mlx-model-40-character-commit-sha>'

node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python "$AIOLM_METAL_PYTHON" --model "$AIOLM_METAL_MODEL" \
  --revision "$AIOLM_METAL_REVISION" --cli "$AIOLM_CLI" --port 18080 \
  --out tmp/macos-acceptance/vllm-metal-chat.json

node scripts/smoke-provider-runtime.mjs --engine mlx-vlm \
  --python "$AIOLM_MLX_PYTHON" --model "$AIOLM_MLX_MODEL" \
  --revision "$AIOLM_MLX_REVISION" --cli "$AIOLM_CLI" --port 18081 \
  --out tmp/macos-acceptance/mlx-vlm-chat.json
```

revision은 `.aiolm-snapshot.json` 또는 Hub cache의 `snapshots/<전체 SHA>`로 증명한다. 임의 폴더 이름에 SHA 일부를 붙이는 것은 근거가 아니다. harness는 엔진/모델을 자동 다운로드하지 않고 매번 새 홈을 만든다. 다른 홈에서 등록한 `--runtime-id` 대신 `--python`이나 `--runtime-bundle`을 사용한다. Rust wrapper도 필요하면 다음처럼 별도로 실행한다.

```sh
AIOLM_PROVIDER_ACCEPTANCE=1 AIOLM_PROVIDER_ENGINE=vllm \
AIOLM_PROVIDER_TASK=chat AIOLM_PROVIDER_PYTHON="$AIOLM_METAL_PYTHON" \
AIOLM_PROVIDER_MODEL="$AIOLM_METAL_MODEL" AIOLM_PROVIDER_REVISION="$AIOLM_METAL_REVISION" \
AIOLM_PROVIDER_CLI="$AIOLM_CLI" AIOLM_PROVIDER_PORT=18080 \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test provider_runtime_acceptance \
  -- --ignored --nocapture --test-threads=1
```

MLX는 ENGINE/PYTHON/MODEL/REVISION을 대응하는 값으로 바꾼다. 실제 CLI server flag·loader·processor·task를 확인하고 지원이 증명된 기능에만 `--expect-media`, `--expect-tools`, `--expect-embeddings`, `--expect-transcription`을 선언한다. 이미지에는 `--media-file`로 내용이 알려진 합성 이미지를 사용한다. embedding-only는 `--task embedding`, 음성 인식은 `--task transcription`으로 분리한다. 자세한 입력/결과 규칙은 [native acceptance](provider-native-acceptance.md)에 있다.

### M05–M06: 전체 메뉴·프로필·다운로드

테스트 계정에서 `npm run tauri -- dev`와 실제 설치 앱 양쪽을 확인한다. 모든 메뉴를 엔진별로 순회한다.

| 흐름 | 완료 기준 |
| --- | --- |
| 실행 편집기 | 엔진/설치/프로필 고정영역이 본문을 덮지 않고 작은 창·확대·긴 이름에서도 본문이 충분히 남음. 엔진 먼저 선택 후 호환 모델/옵션만 표시. |
| 공용 프로필 | 모델 없이 생성·저장·선택, 같은 엔진의 다른 모델에서 사용, 엔진별 기본/최근 선택 분리. runtime instance·primary model은 프로필 밖의 선택으로 유지. |
| 프로필 이전 | 합성 v12→v13. 원본 바이트 backup과 ID·이름·값·prompt·revision·coverage·적용 snapshot 보존. backup 덮어쓰기 없음. 이전 복사본 삭제가 다른 프로필을 제거하지 않음. |
| 전체 메뉴 | 채팅·프로젝트·실행 세션·런타임·벤치·진단·상단의 실제 엔진/버전. API/MCP/앱 설정은 공통 기능으로 표현. |
| 모델 검색 | 포맷/엔진 전환 후 이전 결과 무효화. 검색 엔진 변경이 실행 엔진을 바꾸지 않음. 다운로드 시작의 엔진/설치를 실행 설정에 보존. |
| 다운로드 | GGUF `00001-of-00033`는 한 항목/전체 크기/조각 세트로 표시. 파일은 분리 보관하고 loader에 첫 조각을 전달. 작은 합성 조각으로 UI를 먼저 검사. |
| 스냅샷/companion | immutable config·tokenizer·processor·가중치/조각과 완료/불완전 상태. 검증된 완료 파일 재사용, 중단 파일 재다운로드. 같은 repo companion만 사용하며 다른 base repo를 자동 다운로드하지 않음. |
| 관리/삭제 | 전체 목록 및 엔진 필터. 외부 모델·사용자 추가 파일·공유 companion과 활성 primary/draft/embedding/LoRA 보존. |
| 실패한 실행 변경 | 호환성 preflight 실패 시 기존 서버 유지. 설치가 바뀌면 모델/옵션을 재검사하고 다른 엔진 ID를 재사용하지 않음. |

Installed는 전송 완료이며 추론 지원 인증이 아니다. Metal GGUF는 dense `qwen2/qwen3/llama`, 한 개의 비분할 파일, 인접 config/tokenizer와 **모든 tensor가 F32/F16/BF16/Q4_0/Q4_1/Q8_0**인 제한을 확인한다. K-quants·MoE·SSM·vision·fused QKV는 거부한다. Q4_K 계열이나 분할 GGUF를 llama.cpp처럼 Metal에서 실행 가능하다고 표시하지 않는다. MLX/HF도 실제 설치 loader와 tensor/processor가 맞아야 한다.

Metal 앱 경로는 단일 로컬 장치다. CPU offload·tensor/pipeline parallel·미지원 min_tokens/logit_bias 등이 일반 vLLM 옵션이라는 이유로 나타나지 않아야 한다. LoRA/draft/embedding도 실제 설치 flag와 task가 선언한 범위만 허용한다. MLX embedding-only binding의 `--embedding-model`과 잘못된 base-model/adapter 조합을 확인한다. 알 수 없는 설치 버전의 미디어 능력을 자동 추정하지 않는다.

APFS의 한글/공백/긴 이름, case-sensitive volume, symlink·외부 mount·권한 거부를 합성 fixture로 검사한다. hard-link를 지원하지 않는 대상에서는 활성화 실패를 정상 완료로 표시하지 않는다. 자동 네트워크 재시도·부분 파일 byte-range resume·CLI snapshot 다운로드는 현재 구현 범위가 아니다. 별도 개선이면 공용 다운로드 API·progress callback·소유권까지 설계한다.

### M07–M08: 멀티모달·STT·도구·문서·API

| 경로 | 실제 확인할 내용 |
| --- | --- |
| llama.cpp | 지원 비전 GGUF + 맞는 projector. 선택한 모델의 native modality만 허용. |
| vllm-metal 이미지 채팅 | 고정 설치의 Qwen3-VL/Qwen3.5/PaddleOCR-VL adapter 경로와 실제 이미지 내용. Gemma4 및 Qwen3.5 FP8 conditional wrapper의 text backbone을 비전 지원으로 간주하지 않음. |
| vllm-metal 음성/영상 채팅 | 고정 버전의 네이티브 채팅은 미지원. 설명 있는 거부와 명시적 전처리를 각각 검증. |
| Metal STT | Whisper 전사/번역, Qwen3-ASR 전사. 별도 음성 세션·STT registry/extras·알려진 발화로 정확성·task 라우팅 확인. |
| MLX | 실제 지원 processor마다 텍스트·이미지·음성·영상 내용 확인. Gemma3n 오디오와 Qwen 비전 등 모델별 차이를 지킴. 영상은 app-owned 로컬 파일 경로로 전달. |
| 음성 전처리 | 명시적으로 고른 실행 중 STT 세션의 전사문을 답변 세션에 전달. 답변 모델/엔진은 유지. |
| 영상 전처리 | image-capable 답변 모델에 실제 시각이 붙은 프레임 전달. ffmpeg 필요·음성 미포함 안내·총 미디어 4개 제한. |

STT는 별도 로컬 모델을 준비하고 `--task transcription --audio-file <알려진-발화.wav>`로 검사한다. 기본 0.1초 무음 fixture는 endpoint 연결만 증명한다. 음성 인식 세션을 채팅·생성 벤치 대상으로 넣지 않는다. 비-WAV 입력과 영상 전처리의 `ffmpeg` 존재/부재를 모두 확인한다.

실제 내용이 답변에 반영되는지 확인하고 HTTP 200만으로 통과하지 않는다. app-owned 미디어 reference를 저장·재로드·재시도·엔진 변경에 걸쳐 보존한다. 전처리 재사용, 실패/취소 시 부분 대화 없음, 원본 유지, 영상 프레임의 실제 시각을 확인한다. OpenAI/Anthropic/Responses가 표현하지 못하는 미디어는 조용히 버리지 않아야 한다. harness는 엔진 직접 연결이므로 GUI history/gateway/인증/프로토콜 변환은 따로 검사한다.

MCP stdio의 schema→선택→네이티브 Yes/No→호출→후속 답변을 확인한다. 준비/승인/호출 중 Stop으로 승인창과 도구 자식이 정리돼야 한다. HTTP MCP transport는 현재 미구현이다. 개인화/AGENTS/skill과 symlink SKILL.md가 요청에 정확히 반영되고 준비 취소가 다음 turn을 오염시키지 않는지 검사한다.

RAG는 답변 모델 임베딩·별도 임베딩 세션·여러 후보의 명시적 선택·keyword fallback을 각각 검증한다. 실제 벡터의 수·차원·유한값과 모델/namespace 분리를 확인한다. 프로젝트·재시도·tool follow-up에서 turn 시작의 엔진/모델/인증을 유지한다. API는 공개 별칭·인증·여러 세션의 chat/embedding/audio·Responses continuation·미지원 task 거부·취소 lease 반환을 검사한다. CLI의 직접 loopback과 API-key 비활성화는 앱 gateway 인증 검증을 대신하지 않는다.

### M09: 성능·메모리·심층 검증

작은 지원 모델부터 실제 tokenizer usage와 길이/early EOS를 확인한다. cold-cache 근거 없이 PP/TG를 확정하지 않는다. 동시 요청·warmup·취소 후 완료 행·history/CSV/XLSX·엔진 core/plugin 버전 표기를 확인한다. 모델/설치/패키지 변경 시 오래된 측정/검증 cache identity를 재사용하지 않아야 한다.

vllm-metal은 일반 vLLM worker 경로를 실제 Metal에서 검사한다. `max_model_len`, 실제 prompt/completion token count, EngineCore/worker process group과 RSS를 대조한다. MLX는 `max_kv_size`가 회전 가능한 요청별 KV 할당이며 positional context limit과 다름을 지킨다. APC=false와 설치 서버가 제공하는 cache/reset·인증을 실제로 확인한다.

macOS `peak_memory_bytes`는 `pti_resident_size` 기반 process-group RSS다. Activity Monitor/OS 측정과 대조하되 모든 unified-memory GPU buffer를 포함한다고 주장하지 않는다. physical footprint로 바꾸려면 측정 의미·호환성·별도 근거가 필요하다. 메모리 한계 검사는 작은 모델부터 진행하고 다른 작업의 부하를 구분한다.

MLX 심층 검증은 CPU와 Metal의 full-vocabulary logits 비교지만 실제 CPU kernel이 지원돼야 한다. vLLM/Metal은 top-k KL 하한·target-token perplexity 비교여서 정상 범위도 **partial**이다. full pass로 표시하지 않는다. 양자화·CPU kernel 부재·reference 메모리 부족·재현 불가 옵션은 unavailable/unsupported로 기록한다. matching 실패만 launch를 막고 override는 같은 engine/runtime/model/adapter/options 범위에만 적용돼야 한다. Python에 llama.cpp tiny canary를 강제로 적용하지 않는다. helper 로딩·warmup·trial·deep 양쪽 backend의 취소/정리도 검사한다.

공개 벤치마크 서비스가 contract 0.8.0/schema v2와 Metal core/plugin 식별을 받는지는 별도 외부 검증이다. 로컬 export 성공을 서비스 배포·업로드 성공으로 간주하지 않는다.

### M10: 번들 왕복

Python 번들은 venv 복사가 아니라 정확한 wheel closure·해시·OS/arch/ABI다. 호환 기본 Python과 모델은 대상에 별도로 있어야 한다. 테스트 서버를 중지하고 기존 파일이 없는 새 경로로 내보낸다.

```sh
"$AIOLM_CLI" runtime export vllm '<returned-metal-runtime-id>' tmp/macos-acceptance/vllm-metal-portable.zip
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --runtime-bundle tmp/macos-acceptance/vllm-metal-portable.zip \
  --model "$AIOLM_METAL_MODEL" --revision "$AIOLM_METAL_REVISION" \
  --cli "$AIOLM_CLI" --port 18082 --out tmp/macos-acceptance/vllm-metal-portable.json

"$AIOLM_CLI" runtime export mlx-vlm '<returned-mlx-runtime-id>' tmp/macos-acceptance/mlx-vlm-portable.zip
node scripts/smoke-provider-runtime.mjs --engine mlx-vlm \
  --runtime-bundle tmp/macos-acceptance/mlx-vlm-portable.zip \
  --model "$AIOLM_MLX_MODEL" --revision "$AIOLM_MLX_REVISION" \
  --cli "$AIOLM_CLI" --port 18083 --out tmp/macos-acceptance/mlx-vlm-portable.json
```

새 홈의 오프라인 설치→probe→실제 추론을 모두 확인한다. Metal의 고정 mlx-lm 소스·shipped native extension·wheel hash를 보존해야 한다. archive 사본의 해시 변조, x86_64/arm64·Python ABI·OS 불일치, Ctrl-C, 실행 중 거부, 기존 출력 파일 보호, 외부 등록 환경 보존을 검사한다. llama.cpp 번들은 dylib·install name/RPATH·실행 권한과 가져온 뒤 추론을 별도로 검사한다.

### M11–M12: 실제 Mac 데스크톱·패키지·정상 종료

Finder 더블클릭, Dock 아이콘/메뉴, 트레이 Show/Quit, 닫기→트레이→재열기, 두 번째 실행의 기존 창 복원을 사람이 직접 확인한다. shell의 `open`은 호출 환경을 넘길 수 있으므로 그대로 Finder 실행의 통과 근거로 적지 않는다.

Finder/launchd PATH 복구는 표준 경로·`/etc/paths`·`/etc/paths.d`·Homebrew 경로를 추가하며 shell startup 파일을 실행하지 않는다. nvm/Volta/asdf/사용자 로컬 경로에만 있는 MCP는 절대 executable 경로를 지정한다. `#!/usr/bin/env node`도 node를 찾을 수 있어야 한다. Finder에서 MCP 실행과 CMake 탐색을 다시 검사한다.

한글 IME 조합 중 Enter, 복사/붙여넣기, 이미지/파일/PDF/폴더 선택·취소, 알림과 창 크기/확대의 실제 WKWebView를 확인한다. Keychain은 합성 자격 증명의 읽기/쓰기/수정/삭제, 허용/거부/취소와 업데이트 후 재승인을 검사한다. 권한 거부를 빈 값으로 덮어쓰거나 실제 사용자 비밀을 로그에 기록하면 안 된다.

```sh
npm run package:tauri
```

`.codex-target/release/bundle`의 해당 아키텍처 DMG를 테스트 계정에서 설치한다. GUI/CLI·architecture·version·bundle identity·해시와 strict ad-hoc 서명, 테스트 fixture/개인 경로 제외를 확인한다. 설치된 실제 경로에서 서명 검사는 다음처럼 실행한다.

```sh
codesign --verify --deep --strict --verbose=2 '/absolute/path/to/AioLM.app'
codesign --display --verbose=4 '/absolute/path/to/AioLM.app'
```

현재는 Developer ID/공증 없이 ad-hoc 서명이다. 실제 브라우저 다운로드의 quarantine과 첫 실행 경고→시스템 설정의 **그래도 열기**를 확인한다. Gatekeeper를 끄거나 quarantine 제거를 정상 사용자 절차로 삼지 않는다. 빌드마다 코드 identity가 바뀌므로 업데이트 후 Keychain이 다시 물을 수 있다. Developer ID·공증은 별도 배포 결정이며 인증서를 소스에 넣거나 본 작업의 필수 미구현 기능으로 간주하지 않는다.

재설치·해시 불일치 거부·다운로드 중단·업데이트 안내·재실행을 검사한다. 실제 과거 버전의 합성 사용자 데이터→이번 빌드 업그레이드에서 프로필/세션/대화/모델/자격 증명 정책을 확인하고 합성 버전 교체 검사와 구분한다. 앱 최소 OS 13.3의 WebKit을 확인할 기기가 없으면 unrun이다. macOS 15의 성공이나 vllm-metal의 OS 조건으로 앱 최소 OS 검사를 대신하지 않는다.

`smoke-macos-package.mjs`, `smoke-macos-ui.mjs`, `smoke-macos-launch.mjs`는 일회용 GitHub hosted runner 전용이며 개인 Mac에서 환경 변수를 위조해 실행하지 않는다. [기존 패키지/CI 안내](cross-platform-validation.md)에 따라 hosted 검사를 별도로 수행할 수 있지만 물리 기기 결과와 구분한다. 문서 커밋의 CI 성공도 실제 모델 성공을 의미하지 않는다.

모델 두 개·API listener·MCP 승인 대기 상태에서 정상 Quit을 수행하고 소유 worker·ffmpeg·pip/CMake 자식·collector·승인창·포트·임시 API-key 파일의 정리를 확인한다. 로딩/생성/도구/전처리/bench/deep 도중 Stop, Start/Stop/unload 반복, 실패한 replacement preflight도 검사한다. 다른 사용자 프로세스는 영향을 받지 않아야 한다.

알려진 제한은 별도 기록한다. Force Quit/SIGKILL에서는 정상 cleanup이 실행되지 않아 자식이 남을 수 있고, 단일 인스턴스 플러그인은 `/tmp` 소켓을 공유하여 두 번째 사용자 계정에서 보호가 달라진다. 이를 정상 종료 잔존 결함과 구분한다. 개선한다면 별도 감독/복구 또는 사용자별 인스턴스 설계와 회귀 검사가 필요하다.

## 6. 수정할 위치와 결과 제출

| 문제 | 주요 구현 위치 |
| --- | --- |
| Metal ABI/설치/probe | `src-tauri/src/providers/metal_env.rs`, `metal_constraints.txt`, `python_env.rs`, `vllm_probe.py` |
| 모델/loader/task/옵션 | `src-tauri/src/providers/artifacts.rs`, `compat.rs`, `options.rs`, `launch.rs` |
| 검색/다운로드/삭제 | `src-tauri/src/discover.rs`, `discover/snapshots.rs`, `commands/models.rs`, `src/features/discover/` |
| 공용 프로필/화면 | `src-tauri/src/config/profiles.rs`, `src/shared/config/settingsProfiles.ts`, `profileAssignments.ts`, `src/features/model-settings/` |
| 미디어/API/문서 | `src-tauri/src/media/`, `providers/protocol.rs`, `gateway/`, `src/features/chat/`, `src/shared/api/` |
| 측정/검증 | `src-tauri/src/performance_bench/providers.rs`, `performance_memory.rs`, `verify/engine.rs`, `src/features/bench/` |
| Mac/Unix/배포 | `src-tauri/src/procutil.rs`, `server.rs`, `home.rs`, `mcp/`, `tauri.conf.json`, `scripts/`, `install.sh` |

합성/익명화한 최소 재현으로 기기 환경·upstream 제한·제품 결함을 구분하고 관련 수정/검사를 수행한다. Linux/Windows 경로도 보존한다. 원본 로그·모델·번들·개인 경로·캡처는 `tmp/macos-acceptance/`에 둔다. Git에는 필요한 코드/검사와 익명화한 결과 문서만 올린다. `tmp`는 강제 stage하지 않는다.

결과는 필요하면 `docs/reference/macos-device-validation-results.ko.md`로 별도 작성한다.

```markdown
## 실행 기록
- 소스 커밋 / 수정 커밋:
- macOS/arch, engine core/plugin/MLX 버전 (장치 고유 식별자 제외):
- 모델 repository / immutable revision / GGUF digest, task/modality:
- ID: M01 ... M12
- 상태: pass / fail / unsupported / unrun / blocked
- 실제 실행 방법, 핵심 관찰, 수정 이유, 재검증:
- 미검증 기기/OS/모델/기능과 다음 작업:
```

`outcome=pass`인 harness에도 `unsupported`·`unrun`이 있을 수 있고 benchmark/deep은 별도 데스크톱 후속 검사다. native inference, 모델별 modality, 앱 전체 여정, 번들/패키지의 적용 항목을 실제로 마쳐야 기기 검증이 완료된다. 없는 Intel/구형 OS 기기의 결과를 추정해 성공으로 적지 않는다.

Linux와 독립 작업 브랜치에서 작업별 커밋을 남긴다. 제출 전 `git status --short`, 정확한 staged 파일과 diff, `git diff --cached --check`를 확인한다. 최신 공유 기반으로 병합하거나 필요한 수정만 가져와 상대 기기의 작업을 보존한다. 이력을 강제로 다시 쓰지 않는다.

## 7. tmp 자료를 반영한 기준

원본 자료를 대상 Mac에 복사할 필요는 없다. 다음 유효한 결론을 위 절차에 반영했으며 중간 보고서의 TODO를 현재 미구현으로 옮기지 않았다.

| 읽은 자료 | 반영한 결론/시점 구분 |
| --- | --- |
| `multi-engine-feasibility.ko.md`, `multi-runtime-baseline-audit.md`, `multi-runtime-implementation-plan.md`, `multi-runtime-handoff-status.md` | 초기 결합 구조/설계와 사용량 제한 중단 기록. 구현 완료 후 옛 patch/미커밋/모델별 프로필 TODO는 대체됨. |
| `multi-runtime-implementation-report.md`, `vllm-metal-implementation-report.md` | provider와 Metal 구현 범위. 계약 0.7.0·이전 테스트 수는 최종 커밋의 근거로 사용하지 않음. |
| `claude-metal-environment-report.md`, `claude-metal-model-report.md`, `claude-metal-benchmark-report.md` | exact wheel/ABI/native provenance, 제한된 loader·task·이미지, 메모리·부분 검증의 실제 Mac 후속 검사. |
| `claude-provider-runtime-report.md`, `claude-provider-followup-report.md`, `claude-cli-options-report.md`, `claude-model-cli-report.md` | 실제 MLX flag/processor·LoRA/draft/pooling과 filesystem/pip 작업. 미지원 기능과 데이터 소유권 경계. |
| `claude-benchmark-runtime-report.md`, `runtime-audit-benchmark-report.md` | cold-cache·usage·KV·RSS·CPU reference kernel·취소. RSS와 physical footprint 구분. |
| `runtime-audit-discovery-report.md`, `runtime-audit-execution-report.md`, `runtime-feature-audit-report.md` | 전체 메뉴와 모델 여정. 중간 단계의 Python 번들 미구현 설명은 후속 구현으로 대체됨. |
| `runtime-completion-final-report.md`, `runtime-completion-native-report.md`, `runtime-completion-metal-report.md` | 번들·STT·전처리·harness 최종 연결 완료. 초기 미연결 제안은 완료 상태로 대체했고 실제 Mac 추론은 여전히 미실행. |
| `macos-claude-handoff.md`, `macos-remaining-handoff.ko.md`, `linux-macos-handoff.ko.md` | Finder/PATH·Keychain·최소 OS·물리 기기·업그레이드·강제 종료 제한. Intel Metal 시험 정책·서명/체크섬/API 실패의 옛 상태는 현재 코드와 기존 검증 문서로 대조. |
| `claude-resource-leak-audit.md`, `resource-leak-recheck.md`, `claude-mcp-cancellation-fix.md`, `claude-mcp-native-approval-fix.md`, `cleanup-rust-report.md` | 자식/승인창/collector·준비 취소·Unix symlink 검증. 옛 비Windows dialog 미수정 주장은 현재 구현으로 대체됨. |
| `commit-unit-tests.log`, `commit-native-tests.log`, `commit-python-tests.log`, `commit-cli-smoke.log`, `commit-provider-validation.log` | 최종 Windows 합성 근거. 다른 버전의 commit-lint/typecheck 로그를 이번 결과로 사용하지 않음. |
| `engine-parity-qa/results.json`, `compact-settings-qa/after.json`, `shared-profiles-qa/results.json`, `shared-profiles-config-rust.log` | 18/9/12개 Chrome 합성 조건과 profile migration. 실제 WKWebView와 native font/IME는 본 기기에서 재검증. |
