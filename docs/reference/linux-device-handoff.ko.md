# Linux 기기 작업 인계

작성 기준은 2026-10-07, AioLM 0.3.1, 다중 런타임 구현 커밋 `2c7d6d3`까지다. Linux에서 해야 할 일은 **현재 구현을 실제 GPU·데스크톱·설치 패키지에서 검증하고, 재현된 결함을 수정하는 것**이다. 과거 llama.cpp Linux 검증과 이번 vLLM 검증을 구분한다. 이번 변경의 Linux vLLM 실제 설치·추론은 아직 실행하지 않았다.

이 문서는 세션의 변경, `tmp`의 조사·수정 보고서·검증 로그, 현재 코드와 명령을 대조해 작성했다. 필요한 내용은 본문에 정리했으므로 Git으로 이 저장소만 받아도 작업할 수 있다. Mac 작업은 [Mac 기기 작업 인계](macos-device-handoff.ko.md)를 사용한다.

## 1. Git으로 작업 받기

공유할 소스 브랜치는 `docs/macos-supported`다. **원본 기기의 구현 및 이 문서 커밋을 먼저 원격에 올린 뒤** Linux에서 받는다. 원격의 이전 브랜치나 공개 v0.3.1 설치 파일만 받으면 이번 구현이 들어 있지 않을 수 있다.

원본 기기에서 검토한 커밋을 공유하는 명령은 `git push origin docs/macos-supported`다. 아래 명령은 받는 Linux 기기에서 실행한다.

새 checkout에서는 다음과 같이 시작한다. 기존 checkout이면 먼저 `git status --short`로 미커밋 작업을 확인하고 보존한다. 이미 같은 이름의 작업 브랜치가 있으면 새로 만들지 않고 해당 브랜치에서 이어간다.

```sh
git clone https://github.com/aiolm/AioLM.git
cd AioLM
git fetch origin
git switch -c verify/linux-runtimes --track origin/docs/macos-supported
git merge-base --is-ancestor 2c7d6d3 HEAD
git log -10 --oneline
git status --short
```

조상 확인 명령이 실패하면 원격에 구현 커밋이 올라왔는지 먼저 확인한다. `tmp`의 과거 패치·ZIP을 다시 적용하거나 Windows의 `node_modules`, `.codex-target`, `dist`, 사용자 설정·런타임 가상 환경을 복사하지 않는다. Linux에서 의존성과 바이너리를 새로 만든다. 작업 시작 때 실제 `git rev-parse HEAD` 값을 로컬 검증 기록에 남긴다.

## 2. 구현된 것과 검증되지 않은 것

| 작업 커밋 | 현재 구현 |
| --- | --- |
| `d298e8d` | 엔진별 벤치마크 계약 0.8.0, 의미 버전이 없을 때 `?(빌드번호)` 대신 알려진 빌드 표기 |
| `e43508e` | llama.cpp·vLLM·MLX provider, 설치·등록·probe·실행·API·미디어·정확성 검증의 공통 경로 |
| `323ceb5` | 모델 전체 목록과 엔진별 필터, 검색·스냅샷 다운로드, 분할 GGUF 한 항목 표시와 전체 조각 다운로드 |
| `e75ed4e` | 런타임별 설치 목록, 엔진 선택과 진단, 메뉴의 공통 표현 |
| `fd95beb` | 이미지·음성·영상, 명시적 전처리, 대화 기록, 임베딩 대상 선택 |
| `786f40f` | 엔진에 맞는 측정·기록·내보내기 |
| `ce8b2ac` | **엔진별로 분리된 공용 프로필만 사용**, 과거 모델별 프로필 이전, 작은 고정 실행 영역 |
| `7b226ac` | CLI의 엔진 설치·등록·선택·진단·번들·실행 |
| `2c7d6d3` | 실제 엔진 검증 harness와 플랫폼 인계 문서 |

Windows 최종 확인은 UI 160개 파일/1,549개 테스트, Rust 전체 타깃·feature 테스트, Python probe/portable 검사, 격리 CLI smoke와 harness 검사 통과다. 합성 IPC를 사용하는 Chrome 화면 검사에서는 3개 엔진의 18개 메뉴 시나리오, 고정영역 9개 화면 조건, 모델 선택 전후 공용 프로필 12개 조건을 확인했다. 이것은 Linux WebKitGTK·실제 GPU·실제 모델의 통과 근거가 아니다.

과거 Linux에서는 llama.cpp CPU/Vulkan/ROCm, X11/Wayland, GTK 파일 선택, 문서·비전·MCP·Secret Service·패키지 경로에 검증 기록이 있다. 자세한 근거는 [기존 Linux·macOS 이식 기록](linux-macos-handoff.ko.md)과 [플랫폼 검증](cross-platform-validation.md)에 있다. 같은 기기·같은 드라이버·이번 커밋의 성공으로 확대하지 않는다.

## 3. 환경 준비와 격리

저장소의 `AGENTS.md`를 따른다. Node/npm은 `package.json`, Rust는 `rust-toolchain.toml`의 버전을 사용한다. 현재 값은 Node 22.23.2, npm 12.0.2, Rust 1.98.0이다. lockfile을 임의로 갱신하지 않는다.

현재 패키지 기준은 Ubuntu 24.04 x86_64다. ARM64나 다른 배포판은 별도 결과로 기록한다. AMD ROCm·NVIDIA CUDA·Intel XPU도 각각 설치와 실제 장치를 확인한다. 기존 llama.cpp Vulkan/ROCm 성공은 vLLM GPU wheel의 지원 근거가 아니다.

Ubuntu의 개발 패키지 예시는 다음과 같다. 다른 배포판은 해당 패키지 이름과 [개발 안내](../guides/development.ko.md)를 사용한다.

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf pciutils zenity python3-venv
```

GPU의 OS·커널·드라이버·엔진 빌드 조합은 설치 시점의 공식 지원표와 맞춘다. NVIDIA는 `nvidia-smi`, AMD는 `rocminfo`, llama.cpp Vulkan은 `vulkaninfo --summary`로 실제 장치를 확인한다. 없는 도구를 통과로 처리하지 않고 필요한 검사의 준비 미완료로 기록한다. 개인 장치 일련번호·사용자 경로·전체 환경 출력은 소스에 넣지 않는다.

GUI의 최초 실행·이전·Keyring 검증은 **별도 테스트 OS 계정**에서 한다. `AIOLM_HOME` 하나만 변경해도 기존 데이터 이전 경로와 OS 자격 증명 저장소는 완전히 격리되지 않는다. CLI smoke와 provider harness는 자체 임시 홈과 이전 경로를 격리한다. 개인 데이터 삭제·실제 자격 증명 재사용을 테스트로 삼지 않는다.

## 4. 먼저 자동 검사

저장소 루트에서 실행한다. Cargo 출력은 `.codex-target`이며 `src-tauri/target`이나 `.build/cli`가 아니다.

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

`test:provider-runtime`은 가짜 CLI·loopback 엔진의 합성 검사다. 일반 Cargo 실행에서 ignored인 실제 모델·다운로드 검사는 이후 별도로 실행한다. CPU/GPU·pip 작업을 포함하는 큰 검증은 순서대로 진행한다. 시간 초과가 나면 부하·잔존 프로세스·원래 실패를 조사하고, 근거 없이 제한 시간만 늘리거나 결과를 skip으로 바꾸지 않는다.

## 5. 우선순위별 작업 목록

`P0`는 첫 실제 사용을 막는 핵심 검증·수정, `P1`은 전체 기능 및 설치 경로 검증이다. 각 행은 재현 결과, 수정 커밋, 검증 결과를 별도로 기록한다.

| ID | 우선순위 | 해야 할 작업과 완료 기준 |
| --- | --- | --- |
| L01 | P0 | Unix 전체 검사·빌드. 자식 프로세스, symlink, executable bit, UTF-8·대소문자 구분 테스트가 실제 실행돼야 한다. |
| L02 | P0 | llama.cpp CPU → 사용 가능한 GPU backend 각각 설치·probe·추론·중지·재시작. 기존 설정/비전/projector 경로가 유지돼야 한다. |
| L03 | P0 | vLLM 설치 또는 등록, 실제 accelerator와 버전·registry·CLI flag 확인, 텍스트 스트림·usage·취소·재시작·종료. |
| L04 | P0 | 모든 메뉴에서 엔진·설치·모델 표기와 전환. 공용 프로필·모델 호환성·지원 옵션·고정영역을 실제 WebKitGTK에서 확인. |
| L05 | P0 | Hub 검색→다운로드→설정→실행. 조각 묶음, 스냅샷, companion, 취소·재시도·불완전 상태·소유권 삭제 확인. |
| L06 | P0 | 모델이 선언한 이미지·음성·영상과 명시적 전처리. API/gateway·기록까지 실제 내용 확인, 미지원 입력은 설명 있는 거부. |
| L07 | P1 | 도구/MCP/개인화·스킬·RAG·멀티 세션·프로젝트. 실제 후속 응답과 인증·대상 분리 확인. |
| L08 | P1 | cold-cache 측정·usage·worker RSS·정확성 검증·이력·CSV/XLSX·공유 데이터. 부분 검증과 미지원 수치를 정확히 표시. |
| L09 | P1 | Python wheel 번들과 llama binary 번들. 별도 홈 가져오기 후 실제 추론, 오류·취소·외부 환경 보존. |
| L10 | P1 | X11/Wayland·트레이·IME·클립보드·포털·Secret Service·알림, DEB/AppImage 설치·업데이트·제거. |
| L11 | P0 | 로딩·생성·MCP 승인·pip·ffmpeg·벤치·검증 도중 취소/정상 종료. 소유 worker·포트·임시 파일 정리와 기존 실행 보존. |

### L02–L03: 엔진별 실제 실행

llama.cpp 런타임 설치 검사는 네트워크 다운로드를 수행한다. 가능한 backend만 선택해 별도로 실행한다.

```sh
AIOLM_RUNTIME_INSTALL=1 AIOLM_RUNTIME_BACKENDS=cpu \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test runtime_install \
  -- --ignored --nocapture --test-threads=1
```

GPU 검사는 `cpu`를 실제 지원하는 `cuda`, `rocm`, `vulkan` 등으로 바꾼다. 실제 GGUF를 앱에 설치한 뒤 [실모델 smoke 절차](cross-platform-validation.md#native-acceptance)를 따른다. CPU 선택 시 GPU 오프로딩이 꺼지고 GPU 선택 시 runtime이 열거한 실제 장치가 사용되는지 확인한다. source build에는 서버와 `llama-perplexity`, 공유 라이브러리 및 실행 권한이 함께 있어야 한다.

Linux 관리형 vLLM은 0.31.0이며 Python 허용 범위는 현재 코드에서 3.10–3.14다. Python 버전이 맞아도 wheel·PyTorch·드라이버의 GPU 조합이 맞아야 한다. 앱의 관리형 설치는 GPU별 source-build를 자동 해결하지 않는다. ROCm/XPU 또는 별도 빌드가 필요한 장비는 해당 GPU에 맞는 **격리된 기존 환경을 준비하고 등록**한다. CPU fallback을 GPU 성공으로 기록하지 않는다. Linux에서 MLX는 지원 대상이 아니며 선택 시 그 상태가 명확해야 한다.

테스트 계정에서 다음 CLI 흐름을 확인한다. Python은 실제 실행할 환경의 interpreter를 지정한다. register의 반환값 또는 `runtime list`에서 얻은 ID를 사용하며 생성 규칙을 추측하지 않는다.

```sh
AIOLM_CLI="$PWD/.codex-target/release/aiolm-cli"
AIOLM_TEST_PYTHON='/absolute/path/to/isolated-vllm/bin/python'
"$AIOLM_CLI" runtime register vllm "$AIOLM_TEST_PYTHON"
"$AIOLM_CLI" runtime list
# 아래 ID는 실제 반환값으로 교체한다.
"$AIOLM_CLI" runtime probe vllm '<returned-runtime-id>'
"$AIOLM_CLI" runtime select vllm '<returned-runtime-id>'
"$AIOLM_CLI" doctor
```

관리형 설치도 별도로 GUI 또는 `runtime install vllm <base-python>`로 확인한다. pip 자식 실행 중 취소, 실패 후 부분 환경 정리, manifest를 성공한 probe 뒤에만 공개하는지, 외부 등록 제거 시 interpreter·패키지를 보존하는지 확인한다. 테스트 환경 패키지/장치 노출을 바꾼 뒤 새 launch·doctor·심층 검증이 다시 probe하여 이전 준비 상태와 cache identity를 재사용하지 않아야 한다.

실제 harness는 이미 준비한 interpreter와 스냅샷만 받는다. 명령 앞의 변수 값은 기기에서 채우며 소스 기본값으로 저장하지 않는다.

```sh
mkdir -p tmp/linux-acceptance
AIOLM_TEST_MODEL='/absolute/path/to/snapshots/full-commit-sha'
AIOLM_TEST_REVISION='<actual-40-character-commit-sha>'
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python "$AIOLM_TEST_PYTHON" --model "$AIOLM_TEST_MODEL" \
  --revision "$AIOLM_TEST_REVISION" --cli "$AIOLM_CLI" --port 18080 \
  --out tmp/linux-acceptance/vllm-chat.json

AIOLM_PROVIDER_ACCEPTANCE=1 AIOLM_PROVIDER_ENGINE=vllm \
AIOLM_PROVIDER_TASK=chat AIOLM_PROVIDER_PYTHON="$AIOLM_TEST_PYTHON" \
AIOLM_PROVIDER_MODEL="$AIOLM_TEST_MODEL" AIOLM_PROVIDER_REVISION="$AIOLM_TEST_REVISION" \
AIOLM_PROVIDER_CLI="$AIOLM_CLI" AIOLM_PROVIDER_PORT=18080 \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test provider_runtime_acceptance \
  -- --ignored --nocapture --test-threads=1
```

revision은 실제 `.aiolm-snapshot.json` 또는 Hub cache의 `snapshots/<전체 SHA>`로 증명되어야 한다. 이름에 SHA 일부를 넣은 임의 디렉터리는 근거가 아니다. harness는 매번 새 홈을 만들므로 다른 홈에 등록한 `--runtime-id`를 찾을 수 없다. `--python` 또는 `--runtime-bundle`을 쓴다. 모델과 엔진을 자동 다운로드하지 않는다.

텍스트가 성공하면 embedding-only 모델은 `--task embedding`, STT 모델은 `--task transcription --audio-file <known-speech.wav>`로 각각 검사한다. 지원을 확인한 기능은 `--expect-media`, `--expect-tools`, `--expect-embeddings`, `--expect-transcription`으로 기대값을 명시한다. 모든 모델에 기능을 강제로 기대하지 않는다. harness는 엔진에 직접 연결하므로 앱의 gateway·인증·히스토리 검증은 아래 GUI 흐름으로 따로 해야 한다. 상세 옵션은 [native acceptance](provider-native-acceptance.md)에 있다.

### L04–L05: 전체 메뉴·프로필·모델 여정

별도 테스트 계정에서 `npm run tauri -- dev`로 GUI를 실행하고, 설치 패키지에서도 같은 여정을 반복한다.

| 화면/상태 | 확인할 결과 |
| --- | --- |
| 실행 편집기 | 엔진→설치→공용 프로필→호환 모델 선택. 고정영역은 본문과 겹치지 않고 좁은 창·큰 글꼴에서도 본문이 충분히 남음. |
| 프로필 | 모델 없이 생성·선택·저장 가능. 모든 모델에서 같은 엔진의 프로필 사용 가능. 엔진별 기본·최근 선택이 분리됨. 이름이 같은 다른 엔진 프로필을 잘못 적용하지 않음. |
| 이전 | 합성 v12 설정이 v13으로 바뀌고 원본 바이트 backup 보존. 모델별 프로필의 ID·이름·값·prompt·revision·coverage·적용 snapshot 보존. 이전 복사본 삭제가 다른 프로필을 삭제하지 않음. |
| 실행 옵션 | 선택한 엔진의 지원 옵션만 표시. 지원하지 않는 기존 값은 확인·삭제 가능. vLLM 옵션을 llama 값으로 clamp하거나 명령에 섞지 않음. |
| 찾아보기 | 형식 변경 시 오래된 검색 결과 폐기. 검색의 엔진은 실행 중 엔진을 바꾸지 않음. 포맷 일치는 추론 지원과 구분. |
| GGUF 조각 | `00001-of-00033` 같은 모델을 한 다운로드 항목으로 표시하고 총 크기·전체 조각·첫 entrypoint 처리. 누락 조각이면 실행 차단. 거대 모델 전체 다운로드 없이 작은 합성 조각 fixture로 UI/상태부터 확인. |
| 스냅샷 | 실제 immutable revision의 config·tokenizer·processor·가중치·인덱스/조각. 중단 파일은 다시 받고 검증된 완료 파일은 재사용. Installed는 완료 상태이며 추론 호환 인증이 아님. |
| 다운로드 후 실행 | 다운로드 시작의 엔진/설치 선택을 지키고 호환성 검사. 실패한 교체 preflight가 기존 서버를 먼저 종료하지 않음. |
| 모델 관리 | 전체 모델과 엔진 필터, projector/embedding 역할 구분. 외부 파일·사용자 추가 파일·활성 primary/draft/embedding/LoRA binding 삭제 보호. 공유 companion 자동 삭제 없음. |
| 나머지 메뉴 | 채팅·프로젝트·세션·벤치마크·진단·상단이 실제 선택/실행 엔진과 버전을 표시. API/MCP/앱 설정은 공통 기능. |

대소문자가 다른 POSIX 경로, 한글·공백·긴 이름, symlink·외부 mount·읽기 전용 폴더도 합성 fixture로 확인한다. hard-link가 없는 파일시스템에서 다운로드 활성화 실패를 확인하고 정상 지원으로 표시하지 않는다. 현재 정책은 파일 단위 재시도이며 자동 네트워크 재시도·부분 파일 byte-range resume·CLI snapshot 다운로드는 구현하지 않았다. 파일시스템 대체 경로나 CLI 다운로드를 추가한다면 별도 작업으로 progress callback·공용 API·소유권 검증까지 구현한다.

### L06–L07: 멀티모달·API·도구·문서

이미지·음성·영상은 지원하는 **모델/processor/설치 조합**마다 실제 내용이 답변에 반영되는지 검사한다. 단순 HTTP 200이나 파일 첨부 성공만으로 통과하지 않는다. app-owned reference로 저장 후 재로드·재시도·엔진 전환을 확인하고 미지원 입력이 조용히 사라지지 않아야 한다. OpenAI/Anthropic/Responses 변환이 표현할 수 없는 입력은 설명 있는 거부를 해야 한다.

음성 전처리는 명시적으로 고른 실행 중 STT 세션의 전사문을 답변 세션으로 보내고, 영상 전처리는 image-capable 모델에 실제 시각이 붙은 프레임을 보낸다. 답변 엔진은 바뀌지 않는다. `ffmpeg`가 없을 때 안내, 실패·취소 때 부분 기록 없음, 재시도 때 기존 전처리 재사용, 여러 첨부 합계 4개 미디어 제한, 영상 음성 미포함 표시를 확인한다. 0.3초/12.1초 합성 영상으로 디코더를 확인했던 Windows 기록은 Linux ffmpeg나 실제 모델 검증을 대신하지 않는다.

MCP에서는 schema 탐색→도구 선택→네이티브 Yes/No→실제 호출→후속 답변을 확인한다. 도구 준비·승인 대기·실행 중 Stop을 누르면 도구와 승인창이 모두 닫혀야 한다. Linux에는 `zenity`가 필요하다. 개인화/AGENTS/skill 내용이 실제 요청에 전달되는지도 확인한다.

RAG는 답변 세션 임베딩, 다른 임베딩 세션 명시 선택, 여러 후보일 때 자동 임의 선택 방지, keyword fallback을 각각 검사한다. 임베딩 벡터가 비어 있거나 비수치인 경우 실패여야 한다. turn 시작의 model·namespace·auth가 tool follow-up/재시도에도 유지되는지 확인한다. 지원하는 LoRA/draft/embedding binding의 실제 tensor·base-model 대응을 확인하고, vLLM의 PEFT `.bin` 등 정책상 거부되는 조합은 허용하지 않는다.

API 서버는 인증·공개 별칭·여러 세션의 채팅/임베딩/음성 라우팅, 미지원 task 거부, 취소 후 lease 반환, Responses continuation까지 확인한다. CLI headless의 API-key 비활성화 경로는 데스크톱 인증 gateway와 다르다. loopback 테스트를 외부 공개 서버 검증으로 간주하지 않는다.

### L08–L09: 측정·정확성·번들

벤치마크는 작은 비양자화 지원 모델부터 시작한다. 사용량·tokenization·warmup 후 cold-cache 근거·실제 context allocation을 확인하고 병렬 요청, LoRA 대상, 중간 취소의 완료 행 보존, history·CSV/XLSX를 검사한다. vLLM의 `cached_tokens: 0`, prompt/completion count, token-ID 스트림과 TTFT/TPOT를 실제 엔진 출력과 대조한다. `peak_memory_bytes`에 EngineCore/worker가 포함되는지 OS RSS와 비교한다. 여러 GPU가 있으면 tensor parallel worker의 process group과 종료도 별도 확인한다. RSS를 VRAM 총량으로 표시하지 않는다.

심층 검증은 작은 CPU reference 가능한 모델에서 먼저 수행한다. vLLM은 top-k KL 하한과 target-token perplexity 비교이므로 정상 범위도 **partial**이며 full pass가 아니다. 양자화·지원하지 않는 CPU kernel·reference 메모리 부족·재현 불가 옵션은 unavailable/unsupported여야 한다. 검증 실패/cache/override가 정확히 같은 엔진·설치·패키지·모델·adapter·옵션에만 적용되는지 검사한다. Python에는 llama.cpp tiny canary를 강제로 적용하지 않는다.

Python 번들은 가상 환경 복사가 아니라 exact wheel closure·플랫폼·ABI·해시다. 테스트 계정에서 headless 서버를 중지한 뒤 새 파일로 내보낸다.

```sh
"$AIOLM_CLI" runtime export vllm '<returned-runtime-id>' tmp/linux-acceptance/vllm-portable.zip
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --runtime-bundle tmp/linux-acceptance/vllm-portable.zip \
  --model "$AIOLM_TEST_MODEL" --revision "$AIOLM_TEST_REVISION" \
  --cli "$AIOLM_CLI" --port 18081 --out tmp/linux-acceptance/vllm-portable.json
```

대상 기기에는 호환되는 기본 Python이 필요하다. 해시 확인·오프라인 설치·probe·실제 추론을 모두 마쳐야 번들 왕복 검증이 완료된다. 테스트 사본으로 해시 손상, OS/ABI 불일치, Ctrl-C, 기존 내보내기 파일 보호, 실행 중 가져오기 거부, 외부 환경 보존을 확인한다. llama.cpp ZIP/tar는 실행 권한, `.so`/SONAME, `ldd`/RPATH와 가져온 뒤 추론도 별도로 확인한다.

### L10–L11: Linux 데스크톱·설치·자원 정리

X11과 Wayland에서 파일/PDF/이미지/폴더 선택·취소, 클립보드, 한글 IME, 알림, 트레이 Show/Quit, AppIndicator가 없을 때 닫은 창의 복원, 두 번째 실행의 기존 창 복원을 각각 확인한다. 앱 데이터 쓰기 실패 후 복구도 검사한다. Secret Service는 합성 자격 증명으로 읽기·쓰기·수정·삭제, locked/unavailable, 네이티브 승인 취소, 잠금 해제 후 원래 값 복구를 검사한다. [vault 스크립트](../../scripts/smoke-linux-vault.py)는 독립 세션을 만들며 파일 앞의 설명에 따라 실행한다. GNOME Keyring·DBus·Xvfb·AT-SPI 환경이 필요하다.

```sh
npm run package:tauri
```

`.codex-target/release/bundle`의 DEB/AppImage에 GUI·CLI가 포함되고 가짜 서버·개인 경로·테스트 데이터가 제외됐는지 검사한다. 테스트 계정 또는 VM에서 설치·메뉴 실행·재설치·업데이트·제거와 데이터 보존 정책을 확인한다. AppImage의 실제 FUSE mount와 extract-and-run을 구분하고 패키지 빌드 기기의 glibc 기준을 기록한다. 이것으로 더 오래된 배포판 지원을 보장하지 않는다. 실제 과거 버전 업그레이드는 합성 버전 fixture와 구분한다. `smoke-linux-packaged-desktop.py`와 `smoke-linux-kde.py`는 일회용 GitHub hosted runner 전용이며 개인 기기에서 환경 변수를 위조해 실행하지 않는다.

모델 두 개·API listener·MCP 승인이 동시에 있을 때 앱을 정상 종료하고 소유 worker·ffmpeg·pip/CMake 자식·collector·승인창·포트·임시 API-key 파일이 정리되는지 확인한다. 다른 사용자 프로세스는 영향을 받지 않아야 한다. Start/Stop/unload 반복과 실패한 교체 preflight의 경쟁 상태도 검사한다. Linux의 SIGKILL/강제 종료는 정상 cleanup을 실행하지 않는 알려진 제한이다. 정상 종료의 잔존 문제와 별도로 기록한다. 강제 종료 잔존까지 해결하려면 별도 감독·복구 설계가 필요하다.

## 6. 실패했을 때 수정할 위치

| 문제 | 주요 구현 위치 |
| --- | --- |
| 설치/probe/ABI/환경 | `src-tauri/src/providers/python_env.rs`, `vllm_probe.py`, `mod.rs`, `portable.rs` |
| 모델/옵션/preflight | `providers/artifacts.rs`, `compat.rs`, `options.rs`, `launch.rs`, `commands/launch.rs` |
| Hub/조각/삭제 | `src-tauri/src/discover.rs`, `discover/snapshots.rs`, `commands/models.rs`, `src/features/discover/` |
| 프로필/실행 UI | `src/shared/config/settingsProfiles.ts`, `profileAssignments.ts`, `src-tauri/src/config/profiles.rs`, `src/features/model-settings/` |
| 미디어/task/API | `src-tauri/src/media/`, `providers/protocol.rs`, `gateway/`, `src/features/chat/`, `src/shared/api/` |
| 측정/검증 | `src-tauri/src/performance_bench/providers.rs`, `performance_memory.rs`, `verify/engine.rs`, `src/features/bench/` |
| Unix/데스크톱 | `src-tauri/src/procutil.rs`, `server.rs`, `home.rs`, `mcp/`, `src/app/`, `scripts/` |

합성 또는 익명화한 최소 재현부터 저장하고 기기 환경·upstream 제한·제품 결함을 구분한 뒤 수정과 관련 검사를 수행한다. readiness 검사 제거, 실패를 skip으로 바꾸기, 알 수 없는 remote code 실행, 조용한 런타임 변경을 통과 방법으로 사용하지 않는다. 다른 OS 경로를 보존하고 작업별 수정 커밋과 검증을 남긴다.

## 7. 결과·Git·완료 조건

원본 로그·모델·번들·개인 경로·화면 캡처는 기기의 `tmp/linux-acceptance/`에 두고 `tmp`를 강제 stage하지 않는다. `docs/reference/linux-device-validation-results.ko.md`를 별도로 만들어 익명화한 결론·커밋·검사 방법·결과·구체적 결함만 제출할 수 있다. 실제 사용자 설정·IP/PID·자격 증명·장치 고유 식별자는 Git에 넣지 않는다.

```markdown
## 실행 기록
- 소스 커밋 / 수정 커밋:
- OS/arch, driver/engine 버전, GPU backend (고유 식별자 제외):
- 모델 repository / immutable revision / GGUF digest, task/modality:
- ID: L01 ... L11
- 상태: pass / fail / unsupported / unrun / blocked
- 실행 방법, 핵심 관찰, 수정 이유, 재검증 결과:
- 미검증 모델/기기/기능과 다음 작업:
```

harness의 `outcome=pass`는 전체 기능 통과가 아니다. `unrun`과 미선언 기능의 `unsupported`를 허용하며 benchmark/deep은 별도 데스크톱 검증이 필요하다. 해당하는 항목을 실제 실행하고 구체적 근거와 실패 수정 후 재검증을 남겨야 기기 행렬이 완료된다. 다른 GPU/OS의 성공을 추정해 적지 않는다. 공개 벤치마크 수신 서비스의 contract 0.8.0/schema v2 호환은 별도 외부 작업이며 배포·검사하지 않았다면 공유 전 과정을 통과로 표시하지 않는다.

제출 전 정확한 파일 목록·staged diff·`git diff --cached --check`를 확인한다. Linux/Mac은 독립 작업 브랜치를 사용하고 최신 공유 기반에 병합하거나 필요한 수정만 가져와 상대 기기의 작업을 보존한다. 기존 이력은 다시 쓰지 않는다. 검증 문서 커밋으로 실행된 CI 성공을 GPU 성공으로 적지 않는다.

## 8. tmp 자료를 반영한 기준

다음 원본 파일은 Git으로 공유하지 않으며 유효한 결론을 위 절차에 반영했다.

| 읽은 자료 | 반영한 결론/시점 구분 |
| --- | --- |
| `multi-engine-feasibility.ko.md`, `multi-runtime-baseline-audit.md`, `multi-runtime-implementation-plan.md` | llama 결합 지점과 provider 분리 설계. 초기 TODO를 현재 미구현 기능으로 간주하지 않음. |
| `multi-runtime-handoff-status.md`, `multi-runtime-implementation-report.md` | 초기 사용량 제한 중단과 중간 구현 기록. 미커밋 상태·계약 0.7.0·옛 프로필 범위는 후속 커밋으로 대체됨. |
| `claude-provider-runtime-report.md`, `claude-provider-followup-report.md`, `claude-model-cli-report.md`, `claude-cli-options-report.md` | 실제 flag·pooling·LoRA·미디어·소유권과 pip/Unix 후속 검사. CLI snapshot 다운로드·hard-link 제한 등은 계속 기록. |
| `claude-benchmark-runtime-report.md`, `runtime-audit-benchmark-report.md` | cold-cache·usage·worker RSS·부분 정확성 비교·취소의 실제 GPU 검사. |
| `runtime-audit-discovery-report.md`, `runtime-audit-execution-report.md`, `runtime-feature-audit-report.md` | 검색부터 실행까지의 수정과 파일 단위 재시도. 당시 Python 번들이 없다는 설명은 후속 구현으로 대체됨. |
| `runtime-completion-final-report.md`, `runtime-completion-native-report.md` | portable·STT·전처리·harness 연결 완료. 실제 Linux/Mac 엔진은 미실행. |
| `linux-macos-handoff.ko.md`, `resource-leak-recheck.md`, `cleanup-rust-report.md` | 과거 Unix·권한·수명 관리·skill symlink 항목을 현재 코드 및 플랫폼 문서와 대조. 옛 패치를 다시 적용하지 않음. |
| `commit-unit-tests.log`, `commit-native-tests.log`, `commit-python-tests.log`, `commit-cli-smoke.log`, `commit-provider-validation.log` | 이번 구현의 최종 Windows 합성 근거. 옛 commit-lint/typecheck 로그는 다른 버전이므로 현재 근거로 쓰지 않음. |
| `engine-parity-qa/results.json`, `compact-settings-qa/after.json`, `shared-profiles-qa/results.json`, `shared-profiles-config-rust.log` | 18/9/12개 Chrome 합성 조건과 프로필 이전 검사. 본 기기의 WebKitGTK 재검증 필요. |
