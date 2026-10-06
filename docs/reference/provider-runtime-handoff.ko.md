# Linux·Mac 추론 런타임 검증 인계

이번 변경은 llama.cpp, Linux vLLM, Apple Silicon의 vllm-metal 및 mlx-vlm을 같은 앱에서 선택하는 구현입니다. 런타임별 프로필·옵션·모델 호환성, 검색·다운로드·실행, 세션·프로젝트·대화 기록, 도구·문서 검색·벤치마크·검증 경로를 포함합니다. 현재 장비는 Windows이며 Linux와 Mac은 연결되어 있지 않습니다. 해당 추론 엔진의 실제 설치·모델 추론은 **미실행**입니다.

Git으로 기기에서 이어갈 때는 [Linux 작업 문서](linux-device-handoff.ko.md) 또는 [Mac 작업 문서](macos-device-handoff.ko.md)를 사용합니다. 세션의 구현 커밋과 `tmp`의 유효한 조사·검증 내용을 반영한 우선순위, 실제 실행 명령, 결과 제출 기준이 들어 있습니다. 이 문서는 공통 흐름의 요약입니다.

## 기기에서 시작하기

화면 검증에서는 다음도 확인합니다. 모델 설정에서 추론 엔진·런타임·프로필 선택 영역은 고정되고 본문만 스크롤되어야 합니다. 엔진을 바꾼 뒤 각 설정 탭에는 해당 항목의 지원 옵션만 보여야 하며, 프로필 미리보기에 다른 엔진의 GPU·캐시 설정이 섞이지 않아야 합니다. 모델을 고르기 전에도 고정 영역에서 공통 프로필을 선택할 수 있습니다.

런타임 메뉴에서 llama.cpp·vLLM·MLX를 각각 선택해 설치 목록과 운영체제 지원 여부를 확인합니다. 모델 설정에서 런타임 관리로 이동하면 편집 중인 엔진의 목록이 열려야 합니다. 찾아보기의 엔진 선택은 실행 설정을 변경하지 않아야 하며, 다른 엔진으로 찾은 모델을 실행 설정으로 가져올 때 기존 엔진의 런타임 ID가 재사용되지 않아야 합니다. 앱 상단·세션·프로젝트·채팅·벤치마크·진단은 실제 선택되거나 실행 중인 엔진을 표시해야 합니다. API·MCP·앱 설정은 엔진 공통 기능입니다.

구현과 문서 커밋이 공유된 Git 브랜치를 기기에서 받습니다. 사용자 설정과 Windows의 `.codex-target`, `node_modules`, `dist`는 옮기지 않습니다. 저장소 설치 안내에 따라 의존성을 준비하고 `package.json`의 Node/npm 버전과 `rust-toolchain.toml`의 Rust 버전을 사용합니다.

```sh
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features
npm run build:cli
python3 -B -m unittest discover -s src-tauri/src/providers -p '*_tests.py'
```

실제 추론은 [기기 검증 안내](provider-native-acceptance.md)를 따라 Linux vLLM, Mac vllm-metal, Mac mlx-vlm 각각 실행합니다. 모델은 미리 다운로드하고 스냅샷의 정확한 커밋을 지정합니다. 자동 검증은 모델이나 엔진을 임의로 다운로드하지 않습니다. CLI harness는 자체 임시 홈과 이전 경로를 격리합니다. GUI의 최초 실행·이전·자격 증명 검증은 별도 테스트 OS 계정에서 합니다. `AIOLM_HOME` 변경만으로 기존 이전 경로와 OS 자격 증명 저장소까지 격리되지는 않습니다.

vllm-metal은 macOS 15 이상, Apple Silicon, 네이티브 arm64 CPython 3.12 및 맞는 0.30.0 코어·플러그인 휠이 필요합니다. 관리형 Linux vLLM은 0.31.0, mlx-vlm은 0.7.6입니다. 실제 플랫폼·버전·MLX·소스 리비전은 앱의 런타임 검사로 확인합니다. 등록 환경의 패키지를 변경했다면 다시 검사하세요.

## 전체 사용 흐름

| 기능 | 확인할 동작 |
| --- | --- |
| 런타임 | 설치·취소·정리, 기존 Python 등록·검사·삭제, 외부 환경 보존 |
| 검색·다운로드 | 엔진별 형식, 고정 리비전, 취소·재시도, 완전·불완전 상태, tokenizer/processor 동반 파일 |
| 모델 관리 | 전체 표시·런타임 필터, 호환성과 준비 상태 구분, 실행 중 모델·보조 모델 삭제 차단 |
| 실행 | 런타임 먼저 선택, 해당 프로필·모델·옵션 표시, 설치 변경 후 호환성 검사, 실패 시 기존 실행 보존 |
| 프로필·세션 | 엔진별 기본·최근 프로필, 저장·재시작, 여러 세션의 식별, 과거 llama.cpp 설정 이전 |
| 대화 | 스트리밍·reasoning·취소·재시도, 엔진·모델 유지, 기록 저장·재로드 |
| 멀티모달 | 선언한 네이티브 이미지·음성·영상 각각 실제 내용 검증, 지원하지 않는 입력 거부 |
| 전처리 | 선택한 음성 세션의 전사문, 영상 프레임·실제 시각·음성 미포함 표시, 원본 보존, 총 4개 미디어 제한 |
| 도구 | MCP 승인·거부·취소 및 후속 응답, 지원하는 parser/template |
| 문서·RAG | 임베딩 세션·동반 모델, 명시적 대상, 엔진·모델별 캐시, 어휘 검색 대체 경로 |
| API | 인증·공개 별칭, 채팅·임베딩·음성의 정확한 세션 라우팅, 작업 거부·취소 시 해제 |
| 측정 | 실제 토큰 사용량, 캐시를 비운 벤치마크, 취소 시 완료 결과 보존, 검증·메모리 범위 표시 |
| 보조 모델 | 지원하는 LoRA·draft·pooling 바인딩, 잘못된 조합 사전 거부 |
| 복구·종료 | unload·restart·idle unload·앱 종료 시 소유 프로세스 정리, 충돌·포트 오류 |
| 번들 | 새 홈에 오프라인 가져오기·실제 추론, 해시 변조·ABI 불일치·취소·기존 파일 보존 |

## Metal 멀티모달

고정한 vllm-metal 버전은 이미지 채팅과 별도 음성 인식 작업을 제공합니다. 음성·영상의 **네이티브 채팅**은 지원하지 않습니다. Whisper는 전사·번역, Qwen3-ASR은 전사를 제공합니다. 음성 인식 세션은 채팅이나 생성 벤치마크 대상이 아닙니다.

음성 전처리를 선택하면 사용자가 고른 실행 중 음성 세션의 전사문을 보내며, 답변하는 모델은 유지됩니다. 영상 추출을 선택하면 이미지 입력을 지원하는 답변 모델에 샘플 프레임을 보냅니다. 로컬 `ffmpeg`가 필요하며 음성 트랙은 포함되지 않습니다. 실패·취소 때 부분 결과를 기록하지 않는지, 저장된 결과를 재시도·재로드에서 재사용하는지도 확인하세요.

## 번들과 결과

Python 번들은 가상 환경을 복사하지 않고 정확한 의존성 휠·해시·플랫폼·ABI를 보관합니다. 대상에는 호환되는 기본 Python이 필요하며 모델은 별도로 관리합니다. 내보내기는 휠을 다운로드할 수 있지만 가져오기는 로컬 휠만 사용합니다. Metal의 고정 mlx-lm 소스는 설치된 파일 해시로 확인합니다. 헤드리스 서버를 먼저 중지하고 새 파일로 내보내세요.

```sh
.codex-target/release/aiolm-cli runtime export vllm <runtime-id> <new-bundle.zip>
.codex-target/release/aiolm-cli runtime import <bundle.zip>
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --runtime-bundle <bundle.zip> --model <snapshot-directory> \
  --revision <full-40-character-commit> --cli .codex-target/release/aiolm-cli \
  --out tmp/provider-acceptance-portable.json
```

스크립트는 자체 임시 홈에 번들을 가져옵니다. 다른 홈의 런타임 ID는 그곳에서 찾을 수 없습니다. 생성·임베딩·음성은 각각 `--task chat`, `--task embedding`, `--task transcription`으로 검사합니다. 실제 음성 의미 검증에는 `--audio-file`로 알려진 발화를 지정하세요. 합성 무음 파일은 인식 정확도를 증명하지 않습니다.

공유 JSON은 경로·프로세스 식별자·URL을 제외하지만 콘솔과 보관한 테스트 홈에는 로컬 경로가 있을 수 있습니다. 결과는 `tmp/`에 두고 개인 설정·경로·자격 증명을 커밋하지 마세요. `pass`, `fail`, `unsupported`, `unrun`, `blocked`를 구분하며, 부분 수치 비교나 프로세스 RSS를 전체 검증·GPU 메모리 검증으로 보고하지 않습니다.
