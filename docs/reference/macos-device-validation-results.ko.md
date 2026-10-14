# Mac 기기 검증 결과

[Mac 기기 작업 인계](macos-device-handoff.ko.md)의 M01–M12 후속 기록이다. **전체 기기 검증은 통과하지 않았다.** 공통 자동 검사, 세 엔진의 실제 추론·offline bundle 왕복, 실제 WKWebView 파일 선택·미디어·프로젝트·GUI 프로필 이전, arm64 DMG 생성과 재현 결함 수정은 완료했다. upstream 오류와 아래의 차단·미실행 범위는 남아 있다.

## 1. 소스·환경·근거

- 실행일: 2026-10-07–13 (Asia/Seoul). 기준 소스: `11996aa26b326164ef97f7ba005438f05c30891d`.
- 브랜치: `codex/macos-device-validation`. 초기 기기 검증·패키지 소스: `6261d0b`. 개발 앱 채팅 후속 수정: `2e63118`이며 11절에 별도로 기록한다. 추가 채팅·프로젝트·레이아웃 수정 `0424ab5`와 재검증은 12절, 해당 소스의 DMG는 13절에 기록한다. 삭제·실행 상태·좁은 창의 후속 수정 `533b450`과 재검증은 14절, 당시 잔여 범위는 15절, 해당 DMG는 16절에 기록한다. 접근성 의미 수정 `0709eda`와 재검증은 17절, 해당 DMG는 18절에 기록한다. 19절은 실제 창·PDF/폴더·clipboard·gateway·알림 검증과 알림 안내 수정 `5fd5e82`이며 해당 소스의 DMG는 20절에 기록한다. 21절은 실제 Gemma4 음성·취소·재시도·원래 실행 복원과 active-response 안내 수정 `b523f79`의 후속 기록이며 해당 소스의 DMG는 22절에 기록한다. 23절은 MCP 조회·승인 대기 정리와 기술 입력 치환 수정 `bbd2df6`을, 24절은 해당 소스의 DMG를 기록한다. 수정 커밋은 아래 표에 기록한다. 원격 push는 수행하지 않았다.
- 기기: macOS 26.6.2 / native arm64 / Apple M2 / 16 GB.
- 25·26절은 `c8fae57`에서 제품 코드 변경 없이 실제 창 숨김·설정 복원과 동일 MLX 공용 프로필의 두 모델·원래 vLLM 복원을 검증한 후속 기록이다. native debug 앱과 23절의 frontend 수정 소스를 사용했다.
- 27절은 `a35defd`에서 재현한 실제 두벌식 확정 Enter·미디어 첨부 그룹 결함과 수정 `47580b8`의 재검증이다. 28절은 해당 소스의 DMG를 기록한다.
- 29–30절은 `e594c57`의 Discover 배치와 실제 다크 화면, 31–32절은 `7afc07e`의 수동 MCP 진행·취소, 33–34절은 `25d71a5`의 MCP 검색 선택 소유권, 35–36절은 `91ffd3d`의 서버 정의 변경·승인 폐기와 각 소스의 DMG 후속 기록이다.
- 37절은 `7d71937`에서 제품 코드를 변경하지 않고 Gemma4 음성 내용 실패를 실제 앱과 직접 엔진 요청으로 구분한 후속 기록이다. 긴 응답의 종료 이유 표시 결함도 추가로 확인했다.
- 38절은 종료 이유 보존·출력 한도 안내 수정 `55606fd`와 실제 vLLM 부분 응답·재로드·다음 정상 응답·기존 실행 복원을, 39절은 해당 소스의 DMG를 기록한다.
- 40절은 런타임 옵션 확인 중 프로필·저장값 보호 수정 `a294062`와 요청 전용 프로필의 재시작 없는 왕복 검증이다. 41절은 해당 소스의 DMG를 기록한다.
- 42절은 외부 snapshot의 명시된 모델 카드 제목을 공통 표시 이름으로 사용하는 수정 `27bcca1`과 실제 MLX 실행·기록 재로드·vLLM 복원 검증이다. 43절은 해당 소스의 DMG를 기록한다.
- 44절은 최소 창에서 벤치마크 결과 열에 접근할 수 없던 공통 UI 수정 `142fac3`과 실제 키보드·버튼·창 복원 검증이다. 45절은 해당 소스의 DMG를 기록한다.
- 46절은 잠금 해제 후 네이티브 검증 재개, 이전 검증 서버 정리, 작업 알림이 본문 버튼을 가리는 결함 수정 `eb2d037`의 실제 재검증이다. 47절은 해당 소스의 DMG를 기록한다.
- 48절은 같은 제품 소스로 Chat 화면 전환·최소 창의 전역 MCP 승인 대기 취소와 알림 키보드 동작을 추가 검증한 기록이다.
- 49절은 재개 후 실제 최소 창에서 확인한 전체 모델 정보의 본문 가림과 수정 `6515cde`의 검증 기록이며 50절은 해당 소스의 DMG다.
- 51절은 같은 대화를 다시 선택하면 전송하지 않은 입력이 지워지던 결함 수정 `6398348`과 실제 입력·목록·화면 전환의 검증 기록이며 52절은 해당 소스의 DMG다.
- 53절은 macOS MCP 승인창의 실행 오류를 사용자 거부로 오인하던 수정 `80510a8`, 공용 프로필 검사 동기화 `c5a35fa`와 실제 앱 재시작·도구 조회의 기록이다. 54절은 해당 소스의 DMG다.
- 55절은 다른 엔진에 남은 llama.cpp backend 진단값과 최소 창의 로그 끝 가림 수정 `e70ec9e`를 실제 앱에서 검증한 기록이며 56절은 해당 소스의 DMG다.
- 57절은 실행 중인 기본·별도 모델 세션의 보호 조건을 런타임 관리 화면에 반영한 수정 `7ad2605`와 실제 잠금·해제·소유 프로세스 정리·복원 기록이며 58절은 해당 소스의 DMG다.
- 59절은 세션 명령 대기 중 런타임 관리 잠금과 준비·취소 상태 표시 수정 `930350e`의 실제 검증·보존 기록이다. 60절은 해당 소스의 DMG를 기록한다.
- 61절은 `930350e` production GUI의 격리 실행·실제 응답과 공통 채팅 안내 수정 `d614063`을 기록한다. 수정 후 native 화면과 기존 모델 재시작은 재잠금으로 blocked다. 62절은 새 수정 소스의 DMG를 기록한다.
- 63절은 잠금 해제 후 `d614063`의 실제 stopped/loading/Ready 안내·새 응답·정상 debug 종료, 해당 production GUI의 한국어 설정·실제 응답, 기본 대화 제목 수정 `e394447`과 재잠금 뒤 정리·복원을 기록한다. 61·62절의 과거 blocked/unrun을 당시 결과로 보존하며 새로운 근거와 구분한다.
- 64절은 `e394447`의 arm64 DMG·서명·해시·개인 경로/fixture 검사와 복원 환경 보존 기록이다. 새 제목 수정의 native 화면·해당 production GUI는 재잠금으로 blocked/unrun이다.
- 65절은 `6a374ce`의 stdout/stderr 진단 보존 수정·실제 합성 프로세스 회귀·공통 검사, 새 debug 앱과 원래 데이터 보존 기록이다. 66절은 해당 소스의 DMG다. 실제 엔진·진단 화면 재검증은 Mac 잠금으로 blocked다.
- 67절은 잠금 해제 뒤 `6a374ce` debug 앱의 실제 Qwen 시작·출처별 진단·한국어 제목·새 응답·이력 재로드·정상 종료와 개발 환경 복원을 기록한다. 65·66절의 당시 blocked/unrun을 보존하며 해당 production GUI를 검증한 것으로 대체하지 않는다.
- 68절은 `6a374ce` production GUI의 실제 초기 설정·Ready·응답, 설치 목록 조회 중 잘못된 미설치 안내 수정 `3564440`과 공통 검사·개발 환경 보존을 기록한다. 69절은 새 수정 소스의 DMG다. 수정 후 native 화면은 재잠금으로 blocked이며 이전 소스의 production 실행과 구분한다.
- 70절은 잠금 해제 뒤 설치 목록 수정의 실제 설정·응답·이력과 런타임 미선택 안내 수정 `9fcbbbb`, 공통 검사·MCP 승인 한계를 기록한다. 71절은 새 소스의 DMG이며 72절은 해당 production GUI의 실제 응답·재로드·정상 종료와 원래 개발 환경 복원이다. 68·69절의 당시 blocked/unrun은 보존한다.
- 73절은 한국어 지시 실패의 직접 엔진 재현이며 74절은 잠금 해제 후 실제 사람이 MCP OS Yes를 누른 뒤 도구 호출·결과·정리를 확인한 기록이다. No와 실제 호출 중 취소는 승인 대기 만료로 미검증이며 과거 blocked를 소급 변경하지 않는다.
- 75절은 실제 Qwen 도구 파서 프로필·모델의 요청·앱 Reject, 거부 뒤 잘못된 완료 안내 수정 `a4b7fe0`와 재검증을 기록한다. 76절은 해당 소스의 DMG다. 모델 후속 답변·원래 Default 프로필 복원은 재잠금으로 남아 있다.
- 77절은 실제 MCP 실행 대기의 첫 토큰 안내와 저장된 미완료 도구 요청의 완료 안내 수정 `a7ce853` 및 자동 검증을 기록한다. 78절은 해당 소스의 DMG다. 새 native 재검증은 Mac 잠금으로 blocked다.
- 79절은 잠금 해제 후 실제 MCP 실행 대기/미완료 이력 안내·Default 복원, 80절은 production GUI와 메모리 부족 안내 수정 `20f1ff4`의 자동/실기기 검증, 81절은 새 DMG와 해당 production GUI의 응답·이력·종료를 기록한다. 이전 차단/미실행은 당시 근거로 보존한다.
- 82절은 오류 배너 닫기 수정 `6e27196`의 자동/실기기 검증과 MCP 모델 후속 승인 한계를 기록한다. 83절은 해당 DMG이며 84절은 새 이미지의 실제 production 실패 안내·응답·작은 창·재로드·종료 검증이다.
- 87절은 엔진 미디어 거부 harness의 서버 오류 진단과 빈4xx 통과 판정 수정 `ff97a4c`·회귀/공통 검사·실제 엔진 오류 재확인을 기록한다. 앱/엔진 자체의 수정으로 확대하지 않는다.
- 88절은 실제 사람의 MCP OS No·승인 후 호출 중 취소·모델 후속 답변과 동일 고정 모델의 vLLM/MLX 도구 결과 내용 비교를 기록한다. 승인·전달·취소는 통과했으나 결과 내용은 실패했다. OS 알림 권한의 실제 확인·일시 변경·원상 복원도 구분한다.
- 89–90절은 실제 사람의 트레이 Show·Dock 클릭 복원·트레이 Quit과 배포 앱 입력 제한을, 91절은 이후 배포 앱의 실제 알림 제출·사람의 제목/본문 수신 확인·OS 설정 복원·정상 종료와 개발 앱 재실행을 기록한다. 이전 입력 제한의 원인은 확정하지 않았다.
- 92절은 실제 native clipboard data provider·읽기 실패·파일 promise의 Cmd+V 처리, Chat Copy·변경 감지·원본 복원과 최종 홈/실행 보존을 기록한다. 현재 기기의 데스크톱 하위 검증을 보완했으나 별도 환경 여정이 남아 M11은 unrun이며 전체 검증은 통과하지 않았다.
- 93–94절은 Retry 초안·Benchmark 모델명·Python bundle 취소/알림·긴 제목/최소 창 수정과 실제 재검증이다. 95절은 새로 재현한 MLX Benchmark processor 초기화 결함 수정 `9fde6da`와 동일 고정 Gemma4의 실제 완료를 기록한다. 96절은 로컬 CSV/XLSX 모델명 수정 `24a3dbd`·browser CSV 동작 보존·최종 공통 검사이며, 97절은 해당 소스의 최종 DMG·production GUI·설정 복구와 원래 모델/데이터 보존 결과다.
- 작업용 도구: Node 22.23.2, npm 12.0.2, Rust 1.98.0/rustfmt/clippy, CMake 4.4.4, CPython 3.12.15 arm64. 기존 ffmpeg 8.1.2를 사용했다.
- 도구·캐시·설정은 작업용 경로에 설치했다. 기존 시스템 설정과 lockfile을 보존했다. 자동 검사·CLI·앱의 HOME과 legacy 경로를 격리했다. 별도 OS 계정의 최초 실행을 대신한 검사는 아니다.
- 앱 검사는 `macos-ui-smoke` debug 빌드의 실제 Tauri WKWebView·IPC·W3C WebDriver 및 CUA 네이티브 조작이다. 61·63·68·72·80·81·84·97절에서는 각 검증 DMG와 바이트가 같은 production GUI도 개발 서버 없이 직접 실행했다. 자연스러운 Finder 설치 실행은 unrun이다.
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
| `533b450` | 대화 삭제 후 마운트된 Chat이 옛 내용을 복원하고 포트 저장 중 Stop이 뒤늦은 재시작에 덮였다. 삭제 barrier·turn 무효화·API action revision을 적용했다. 진단의 실행 runtime, 벤치 이력·Copy, snapshot 이름·재시도 안내, 좁은 창의 실행·취소 버튼과 엔진 입력 표시도 수정했다. | 합성 회귀·UI1688 tests, 실제 Metal 새 답변·재로드 PP/TG, 격리 WKWebView 삭제/Stop, 24개 설정 화면·진행 카드. 14절 참조. |
| `0709eda` | 실행 영역·provider 목록·진단 로그·llama.cpp export의 이름을 role 없는 요소에 지정하여 유효한 접근성 이름 의미가 없었다. 컨트롤 묶음에 group, 기존 포커스 가능한 진단에 비실시간 region을 지정했다. | 수정 전 실패·수정 후 회귀, UI1690 tests와 실제 WKWebView의 11메뉴·고급 export 재검사. 모델·설정 보존과 현재 light Chat의 gradient 대비를 한정해 확인했다. 17절 참조. |
| `5fd5e82` | native 알림 요청을 제출할 수 있는 상태를 Allowed로 표시해 macOS의 실제 승인을 확정한 것처럼 안내했다. Ready to send와 첫 알림의 OS 권한 안내, 전달 성공을 단정하지 않는 test 제출 문구로 바꿨다. | 수정 전 실패·수정 후 4 files/36 tests, 공통 UI1697 tests 및 실제 CUA의 Ready/제출 화면·모델/설정 보존. OS test 본문 수신은 여전히 blocked다. 19절 참조. |
| `b523f79` | 진행 중 응답 때문에 Unload가 거부될 때 모델 파일·경로를 확인하라고 잘못 안내했다. 실제 loading/replacing/unloading의 active-response 보호 오류를 먼저 구분하여 현재 응답을 끝내거나 중지한 뒤 재시도하도록 안내한다. | 수정 전 직접 회귀 실패·수정 후 통과, 기존6종 오류 안내 보존·공통 UI1697 tests·실제 MLX 생성 중 Unload 거부와 수정된 안내 확인. backend 보호·readiness·상태 처리 변경 없음. 21절 참조. |
| `bbd2df6` | 실제 WKWebView의 MCP 인자·JSON 입력에서 스마트 대시/따옴표가 ASCII 실행 인자와 JSON을 바꿨다. 명령·인자·JSON 세 기술 입력의 자동 교정을 끈다. | 수정 전 회귀3개 실패·수정 후 관련7개 통과, 같은 native 입력의 원문 보존·JSON 검토 카드 확인·공통 UI1700 tests. 사용자 문자의 정규화나 승인 정책·MCP API 변경 없음. 23절 참조. |
| `47580b8` | 실제 두벌식의 확정 Enter가 채팅까지 전송하고 영상 첨부 그룹이 이미지로 안내됐다. 조합·확정·Enter release 상태를 구분하고 그룹에 미디어 이름을 지정했다. | 실제 첫 Enter 입력 보존·다음 Enter 응답, 포인터 클릭 뒤 단일 Enter 응답, native MP4 선택·그룹명·제거·원래 설정 복원. 합성 IME17개·미디어16개와 공통 UI1733 tests 통과. 27절 참조. |
| `e594c57` | Discover desktop 검색 control과 라벨의 수직 위치가 어긋났다. toolbar 전용 배치를 정렬했다. | 실제 desktop·최소 창·다크 메뉴 배치/대비 표본과 공통 UI1733 tests. 29절 참조. |
| `7afc07e` | 수동 MCP 호출이 승인 대기에 들어가면 진행·취소 control이 사라졌다. 호출별 공용 작업·로컬 취소·결과 소유권을 유지한다. | 실제 로컬/공용 취소와 승인 process/소유 peer 정리, 합성8개 회귀·공통 UI1741 tests. 승인 이후 실제 실행은 blocked. 31절 참조. |
| `25d71a5` | 다른 서버 선택 후 이전 검색의 도구/오류가 새 서버에 표시됐다. 검색 세대로 늦은 응답을 폐기한다. | 실제 선택 전환·이전 성공/오류 폐기·현재 실패/재시도·16개 peer 정리, 합성7개 회귀·공통 UI1748 tests. 33절 참조. |
| `91ffd3d` | 실행 정의를 바꿔 저장한 뒤 이전 도구·검토·승인이 남았다. 정의 변경의 메타데이터/승인·호출 소유권과 저장 응답 선택을 보호한다. | 실제 변경 저장·재검색·같은 정의 재저장·비활성화·승인 대기 취소/소유 PID 정리, 합성13개 회귀·공통 UI1761 tests. 35절 참조. |
| `55606fd` | 토큰 한도로 잘린 응답을 완료로 표시하고 종료 이유를 기록에서 잃었다. 종료 이유를 보존하고 부분 응답 안내·완료 알림 억제·잘린 도구 요청의 승인 방지를 공통 Chat 계층에 적용한다. | 실제 vLLM length→재로드→다음 stop 응답, 합성6개 회귀·공통 UI1767 tests. 38절 참조. |
| `a294062` | 옵션 확인 대기를 잘못된 값·미저장 편집으로 취급하고 아직 조회하지 못한 옵션의 삭제를 제안했다. 확인 중 상태와 오류를 분리하고 schema 실패를 값 재검증으로 지우지 않는다. | 실제 native pending·잘못된 입력·복원, 합성6개 회귀·공통 UI1773 tests. 40절 참조. |
| `27bcca1` | 외부 snapshot의 응답·실행 모델명이 revision 해시로만 표시됐다. 로컬 카드의 명시된 제목을 제한적으로 읽고 공통 표시 계층에 적용한다. 모델 경로·provenance·호환성은 바꾸지 않는다. | 실제 MLX 실행·새 부분 응답·다른 엔진 실행 중 기존 기록 재로드, Rust 2개/UI 6개 회귀·공통 UI1779 tests. 42절 참조. |
| `142fac3` | 최소 WKWebView에서 PP·TG·메모리 열이 가려지고 포커스한 표의 방향키도 가로 위치를 이동하지 않았다. 공통 표의 열 이동 버튼·방향키·Home/End와 넘침 감지를 추가했다. | 실제 세 결과 표의 독립 이동·desktop 복원·28개 보존 조건, 합성9개 회귀·공통 UI1788 tests. 44절 참조. |
| `eb2d037` | 자동으로 펼쳐진 작업 알림이 MCP 검토 카드의 승인·취소 버튼을 덮어 끝까지 스크롤해도 접근할 수 없었다. 알림이 본문 공간을 확보하고 긴 내용만 별도로 스크롤하도록 수정했다. | 실제 desktop·최소 창의 버튼 접근·접기·긴 알림 스크롤, 17개 보존 조건·관련 UI35개·공통 UI1788 tests. 46절 참조. |
| `6515cde` | 최소 창에서 전체 모델 정보를 펼치면 헤더와 프로필 영역이 설정 본문을 잘린 부모 밖으로 밀어냈다. 짧은 창의 모델 정보 스크롤과 프로필 높이 제한으로 본문 공간을 확보한다. | 실제 최소·짧은 넓은 창·desktop, 입력 포커스·독립 스크롤·13개 geometry/10개 보존 조건·관련 UI96개·공통 UI1788 tests. 49절 참조. |
| `6398348` | 같은 대화를 다시 선택하는 것만으로 전송하지 않은 입력·첨부가 초기화됐다. 같은 대화는 목록만 닫고, 실제 전환에만 기존 composer 초기화를 적용한다. | 실제 desktop·최소 창의 입력 보존·다른 대화 초기화·화면 왕복, 수정 전 실패/후 통과 첨부 회귀·관련 UI42개·공통 UI1789 tests·16개 검증/보존 조건. 51절 참조. |
| `80510a8` | macOS 승인 scripting process의 모든 비정상 종료를 사용자 No로 보고했다. 성공 종료와 명시된 답변을 함께 확인하고, 실행 실패·잘못된 답변은 도구를 실행하지 않는 오류로 전달한다. | 수정 전 최소 회귀 실패/후 관련 7개 통과·기존 취소/timeout 정리·전체 Rust/clippy. 실제 앱 재빌드·정상 종료/재시작·Qwen 준비·MCP 조회는 통과했으나 실제 Yes/No는 blocked다. 53절 참조. |
| `e70ec9e` | vllm-metal 실행의 backend 진단에 저장된 llama.cpp CPU 선택이 들어갔다. 엔진 identity를 우선하고 다른 엔진에서는 해당 필드를 null로 반환한다. 최소 창의 진단 로그가 화면보다 높아 End로 이동한 마지막 줄이 가려지는 문제도 수정했다. | 수정 전 Rust 회귀 실패/후 관련17개·전체 Rust/clippy·공통 UI1789개 통과. 실제 새 native 실행의 null/저장값 보존과 최소·짧은 넓은 창·desktop의 로그 접근, geometry12개·재시작 보존16개 조건. 55절 참조. |
| `7ad2605` | 모델 실행 중에도 Python 환경 설치·등록·삭제·번들 전송 버튼이 활성화되어 backend 보호 오류를 뒤늦게 표시했다. 공통 세션 poller와 busy lifecycle을 사용해 기본·별도 세션의 잠금·안내를 반영한다. | 수정 전 회귀 실패/후 관련47개·공통 UI1794개 통과. 실제 기본 starting·별도 starting/running의 잠금, 전체 stopped의 해제, 별도 세션 소유 PID·포트 정리와23개 검증/보존 조건. 57절 참조. |
| `930350e` | 별도 세션 준비 명령이 진행돼도 아직 stopped인 poll 때문에 런타임 관리 버튼이 잠시 활성화되고 세션 행은 Stopped와 Cancel을 함께 표시했다. 공통 명령 activity로 잠금을 보완하고 준비·취소 상태를 유지한다. | 수정 전 두 회귀 실패/후 관련134개·직접 검사·공통 UI1801개 통과. 실제 native 별도 entry 생성 전 잠금, Starting/Cancelled/Stopped와 해제, 정상 load/stop·기본 실행 복원 및27개 검증/보존 조건. 59절 참조. |
| `d614063` | vLLM snapshot이 저장돼 있는데 공통 채팅이 GGUF 미선택으로 안내하고 실제 로딩 중에도 같은 안내를 표시. stopped 안내를 형식 중립적으로 수정하고 준비 상태의 제목·입력 placeholder를 우선 표시. 실패 진단·전송 readiness 유지. | 수정 전 최소 회귀 fail, 관련62개·공통 UI1807개/typecheck/lint/build pass. 63절에서 native stopped/loading/Ready·새 전송·정상 debug 종료와 해당 production GUI의 실제 Ready·산술 응답·지표를 확인했다. 한국어 응답 지시는 fail이며 production 재로드/정상 종료는 재잠금으로 blocked다. |
| `e394447` | 한국어 fresh UI의 기본 대화 제목이 영어로 표시됐다. 생성 제목·검색·삭제 안내를 현재 UI 언어로 표시하고 저장 제목·자동 이름 지정·사용자 제목을 보존한다. | 수정 전3개 회귀 fail, 관련58개·공통 UI1810개/typecheck/lint/build pass. 67절에서 한국어 생성 제목·검색·삭제 접근성 이름과 첫 전송의 자동 이름 지정을 native 앱에서 확인했다. 63·64절의 잠금 당시 기록은 보존한다. |
| `6a374ce` | 공통 spawn이 stdout을 버려 핵심 엔진 오류가 진단에서 사라졌다. 두 출력을 각각4KiB로 보존하고 종료 시 파이프에 남은 출력도 회수한다. | 수정 전 합성 실제 프로세스 회귀 fail/후 pass, 관련 Rust46개·전체 Rust/clippy·순차 공통 UI1810개 통과. 67절에서 실제 vLLM stdout/stderr 표시·로그 끝 접근·Ready·응답·정상 종료를 확인했다. 실제 실패/취소 시 진단은 이번 native 범위에서 실행하지 않았다. 65·66절 참조. |
| `3564440` | 설치 목록 조회 중 실제 설치된 런타임을 미설치로 표시했다. 대기·조회 실패·확인된 미설치를 구분하고 Start는 확인 전 차단한다. 새로고침 시 이전 readiness를 철회하고 저장값을 유지한다. | production native 재현·세 엔진의 수정 전 회귀3개 fail, 수정 후 관련85개·공통 UI1816개/typecheck/lint pass. 성공한 빈 목록은 미설치로 유지하며 조회 실패가 미설치나 영구 로딩으로 표시되지 않는 것을 검사했다. 68절 당시 native 재검증은 재잠금으로 blocked였고 70–72절에서 새 실제 재검증을 기록한다. |
| `9fcbbbb` | 런타임을 선택하지 않은 엔진에서도 선택된 런타임이 미설치됐다는 본문 경고가 나타났다. 미선택과 확인된 미설치를 구분한다. | 실제 debug 재현·vLLM/MLX 회귀2개 수정 전 fail/후 pass, 관련87개·공통 UI1818개/typecheck/lint 통과. 실제 debug와 새 production의 미선택 안내·Start 차단, 선택된 vLLM의 Ready·응답·재로드·정상 종료 확인. 70–72절 참조. |
| `a4b7fe0` | 실제 MCP 요청을 거부하거나 요청이 실패해도 하단이 응답 완료로 표시됐다. 승인 대기·실패·중단·완료와 assistant 없는 대화를 구분한다. | 수정 전3개 회귀 fail/후 pass·관련36개·공통 UI1818개/typecheck/lint 통과. 실제 거부 후 실패 안내·다음 모델 요청의 승인 대기 안내를 native 앱에서 확인했다. 75절 참조. |
| `a7ce853` | native MCP 실행/OS 승인 대기를 첫 토큰 대기로 표시하고 저장된 tool_calls 응답을 완료로 표시했다. 실행 대기·후속 모델 요청·재로드한 미완료 요청을 구분한다. | 수정 전 회귀4개 fail/후 pass·관련54개·공통 UI1822개/typecheck/lint 통과. 77절 당시 새 native 재검증은 blocked였고 79절에서 실제 실행 대기·정상 재실행 뒤 미완료 이력을 확인했다. |
| `20f1ff4` | vLLM의 실제 KV cache 용량 부족을 모델 경로/파일 무결성 문제로 안내했다. 구체적인 할당 실패를 wrapper·model/traceback 표현보다 먼저 분류한다. | 합성 회귀 수정 전 fail/후 pass·공통 UI1822개/typecheck/lint pass. 실제 KV cache 실패에서 메모리 안내·원인 로그·소유 프로세스 정리를 확인했다. 80절 참조. |
| `6e27196` | 오류 알림 Dismiss가 UI store의 runtime error를 지우고 다음 poll에서 같은 배너를 재표시했다. shell은 알림 확인 여부를 유지하고 store는 원인 진단을 보존한다. | 수정 전 두 회귀 fail/후43개 pass·공통 UI1824개/typecheck/lint/build pass. 실제 debug 및 해당 DMG production에서 배너 닫기·진단 보존·정상 설정 복원 확인. 82–84절 참조. |
| `297f5dc` | 이전 실패 메시지를 Retry하면 새 미전송 초안이 지워졌다. 재전송 대상과 현재 composer의 소유권을 분리해 새 텍스트·첨부·문서를 유지한다. | 수정 전 회귀/실제400에서 초안 소실, 수정 후 회귀55개·같은 native400에서 새 초안 보존. 93절 참조. |
| `aa7b140` | Benchmark 대상·이력·결과·삭제 안내가 외부 snapshot을 revision으로만 표시했다. 기존 제한된 metadata 표시 이름을 공유한다. | 회귀49개·실제 기존/신규 이력·결과·삭제 확인창의 모델명. record identity·provenance 보존. 93–95절 참조. |
| `7fc95e4` | bundle 전송이 다운로드 완료 알림을 보내고 local/global 취소의 실행 identity와 busy가 일치하지 않았다. 명시적 취소·진행·재시도 오류를 구분한다. | 회귀42개·실제 Save/Open Cancel·처리 중 Cancel과 출력/staging 정리. 환경 설치 알림 유지. 93–94절 참조. |
| `7dc1917` | 매우 긴 제목의 렌더링 폭이 커지고 최소 창의 설정 버튼이 제목 공간을 차지했다. 표시 preview를 grapheme 경계로 제한하고 좁은 창의 named icon을 적용한다. | 제목 회귀61개·설정 회귀56개·실제45,088-unit 제목과360×488 화면/포커스 복원. 저장·편집·검색의 전체 제목 보존. 93절 참조. |
| `9fde6da` | MLX Benchmark가 모델 loader의 processor 등록을 건너뛰어 설치된 Gemma4Processor를 해결하지 못했다. 가중치를 읽지 않는 일반 loader 초기화를 processor 앞에 적용한다. | Python contract5개·관련 Rust4개/전체 Rust·실제 서버와 token ID 일치·같은 Gemma4 Benchmark complete/PP1,024·TG16. 95절 참조. |
| `24a3dbd` | 로컬 CSV/XLSX의 Model과 제안 파일명이 화면과 달리 revision이었다. export의 표시 projection에 공통 이름을 적용하고 browser CSV의 동기 download 경로를 유지한다. | export 회귀18개·최종 UI1865개·실제 CSV/XLSX 이름/수치·저장 이력 원본 보존. 96–97절 참조. |

gateway 요청 형식·benchmark 계약·엔진/프로필 정책을 유지했다. 재현 결함 해결을 위해 프로젝트 네이티브 파일 IPC 두 개와 선택적 채팅 기능 정보를 추가했다. 채팅 기능 정보가 없는 기존 기록은 기존 동작을 유지한다. 플랫폼 공통 계약을 회귀 검사했으며, 이번에 Windows/Linux 실기기를 새로 검증한 것으로 해석하지 않는다. 해시 무시·readiness 제거·실패 skip·근거 없는 timeout 확대로 통과시키지 않았다.

## 3. M01–M12 판정

항목의 하위 성공을 전체 통과로 확대하지 않는다. `unsupported`는 실제 확인한 미지원 하위 검사, `unrun`은 필요한 여정의 미실행, `blocked`는 현재 계정/조작 수단의 차단이다. `fail`에는 미해결 실제 실패가 포함된다.

| ID | 상태 | 실행 근거와 남은 범위 |
| --- | --- | --- |
| M01 | pass | 지정 도구/native arm64, TypeScript·linter·단위·frontend/CLI/native build, Rust 전체 타깃/feature, Python·CLI·합성 harness. 실제 Unix socket/process/symlink/권한 검사. |
| M02 | pass | 고정 GGUF CPU→Metal probe·추론/usage·취소·재시작·중지, CPU/Metal source-build. 실제 CMake 자식 취소와 기존 설치/staging 보호. |
| M03 | fail | 별도 관리형 Metal 설치·ABI/MetalPlatform/native extension·텍스트/이미지/STT/embedding·취소·재시작·외부 환경 보호. 직접 file URI 이미지 요청은 upstream500. |
| M04 | fail | 별도 MLX probe·텍스트/이미지/native 영상·취소·재시작·외부 환경 보호. 21절의 Gemma4 native 음성 첫 내용 응답·usage·기록/재로드·실제 취소는 통과했지만 일부 긴/후속 질문은 음성 내용 응답에 실패했다. 직접 URI500와 Gemma3n 누락 shard index의 preflight 실패도 유지한다. |
| M05 | pass | 11 메뉴×3 엔진·공용 프로필·3 창 크기, GUI v12→v13/두 번째 이전/backup 불변. 설치된 flag별 호환 옵션 UI, 실제 OS LoRA 선택→draft-simple→공용 프로필 저장/시작→응답/usage, MLX embedding-only 및 잘못된 binding 거부 확인. 26절에서 서로 다른 Qwen3/Gemma4를 같은 MLX 공용 프로필로 순차 실행·실제 응답·이력 보존·원래 vLLM 복원도 확인했다. 임의의 모든 옵션 순열을 검증한 의미는 아님. |
| M06 | pass | 실제 snapshot 취소/재시도, 고정 GGUF, 공개 3-shard 전체 GUI 다운로드/해시/한 항목/CPU 추론, 두 GGUF와 공유 companion 다운로드/재사용·다른 primary 삭제 후 보존. 활성/선택 draft·LoRA·named split 보호, 외부 파일·case-sensitive APFS·한글/공백·권한·FAT 불완전 상태 확인. |
| M07 | fail | OS 이미지/WAV/MP4 선택·내용/usage·immutable 기록/재로드·실패 후 Retry·엔진 변경, 명시적 STT/frames·ffmpeg UI Stop, 비-WAV Whisper 전사/번역·ASR 전사. 21절의 Gemma4 실제 native 음성·취소와 잘못된 WAV의 동일 입력 Retry를 추가 확인했다. 긴/후속 음성 질문의 내용 실패·URI500·native SmolVLM 내용 오답·Gemma3n snapshot 실패 유지. ffmpeg 부재의 실제 앱 검사는 blocked. |
| M08 | fail | 실제 문서 선택·프로젝트 native 왕복·자동 문서 첨부·벡터/keyword/명시적 후보 선택·멀티 세션·gateway 인증/라우팅/Responses·개인화 요청 확인. 19절의 native PDF 내용 응답·재로드, gateway SSE 연결 종료·후속 응답과 Responses/Messages 미디어 거부도 통과. MCP 조회·승인 deadline·소유 프로세스 정리·기술 입력 치환 수정과 74절의 실제 OS Yes→수동 호출·결과는 통과했다. 88절의 실제 OS No→거부·tools/call0·정리와 승인 후 호출·모델 후속 요청도 통과했다. 후속 답변은 전달된 synthetic result 대신 입력 인자를 반복해 내용 검증에 실패했다. 동일 고정 모델의 직접 vLLM/MLX 비교에서도 재현됐으며 앱 전달 결함의 근거는 확인되지 않았다. |
| M09 | pass | 세 엔진 tokenizer usage·cold-cache/KV·RSS/OS 대조·이력/native CSV/XLSX 저장/viewer. MLX/native Metal deep pass. vllm partial/Unsupported와 CPU-only 비교 Unsupported를 full pass로 계산하지 않음. 공개 서비스 upload 제외. |
| M10 | pass | 세 엔진 새 홈 offline export/import/probe·실제 추론, imported STT/embedding. 해시/ABI/arch/OS 오류·pip/native 취소·활성 모델 거부·기존 출력·외부 환경 보호. 직접 URI의 전체 harness 실패는 M03/M04/M07에 별도 기록. |
| M11 | unrun | arm64 DMG/GUI/CLI·버전/strict ad-hoc/해시/개인 경로 제외/새 홈 CLI 기본값. 실제 hide·2차 실행 restore·정상 quit, 파일/문서/JSON/CSV/XLSX picker·취소·한글 paste 확인. 19절의 green-button 확대/복원, PDF/폴더 선택·취소·복원, 실제 Cmd+V/Chat Copy와 합성 다중 포맷·확인된 원본 clipboard snapshot 복원은 통과. 25절의 Close to tray·닫기 숨김·CUA 재활성화·설정 복원과89–90절의 실제 사람의 트레이 Show/Dock 클릭 복원·트레이 Quit도 통과했다. 27절의 현재 두벌식 native 조합·첫 Enter 확정·다음 Enter 응답·포인터 클릭 뒤 단일 Enter는 통과했으며 DOM composition 이벤트는 관찰되지 않았다. 91절의 custom-protocol 배포 앱에서 새 test notification 제출·사람의 정확한 제목/본문 수신 확인·원래 OS Allow off 복원·정상 종료와 개발 앱 재실행도 통과했다. 84절의 새6e27196 DMG production 응답·작은 창·재로드·normal Quit도 통과했다. 92절의 data provider 텍스트·읽기 실패·실제 파일 promise의 안전한 Cmd+V 처리와 원본 clipboard 복원도 통과했으며 파일 promise import는 unsupported다. 별도 계정/Finder·launchd 경로/Keychain/실제 upgrade·quarantine/Intel·구형 macOS의 필요한 여정은 unrun이다. 하위 데스크톱 성공을 전체 M11 pass로 확대하지 않는다. |
| M12 | pass | `6261d0b`에서 실제 모델3/API 실행 중 normal Quit→소유 자식·5포트 정리/파일 보존/launcher exit0. pip/CMake/ffmpeg·준비/실제 loading replacement·3 엔진×warmup/single/batch·native deep CPU/Metal 취소 통과. 별도 진단 환경에서 MLX CPU/GPU 평가 진입을 각각 관찰 후 취소·job 정리/cache 불변. 88절에서 실제 OS 승인 후 hold tools/call 시작→native Cancel→Cancelled·결과0·소유 부모/자식 종료·MCP 정의 원본 복원을 확인했다. 승인 대기 만료나 RPC timeout을 실제 호출 취소로 계산하지 않았다. |

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

다음은 초기 기기 검증 시점의 기록이다. 이후 실제 Copy·PDF/폴더 picker·macOS 확대 버튼의 한정된 통과와 현재 잔여 범위는 19절을 우선한다. 원래 차단 근거는 보존한다.

- **별도 OS 계정에서 unrun:** 최초 GUI 실행, Keychain 허용/거부/취소/갱신 재승인, 자연스러운 Finder 설치·첫 실행, 실제 과거 버전 upgrade/legacy 이전. 격리 HOME의 GUI v12 이전과 구분한다.
- **당시 조작 수단 blocked:** 별도 osascript MCP Yes/No→실제 tool/후속 답변·호출 중 취소, 한글 IME composition 중 Enter, clipboard Copy/모든 포맷 복원, Dock/트레이 Show/Quit. 기존 앱 파일 picker와 paste/normal Quit은 완료했다. OSAX 직접 조작 probe는 신뢰할 수 있는 실행 근거를 제공하지 않았고 CUA는 해당 별도 osascript 창을 선택하지 못했다. OS 접근성·자동화 권한은 변경하지 않았다. 이후 실제 Copy와 당시 원본 snapshot 복원은 19절에서 통과했으며 모든 포맷 복원으로 확대하지 않는다.
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

## 14. 삭제·실행 상태·작은 창 후속 검증

후속 소스는 `533b45000f6d479089d73db01d9da5246929c844`이다. 12절 이후 발견한 제품 결함을 수정하고 관련 합성 회귀 검사와 실제 개발 앱의 WKWebView를 재검증했다. 이 절은 M01·M05·M06·M08·M09·M12의 관련 하위 흐름에 대한 근거이며 **전체 M01–M12 통과를 뜻하지 않는다.** Python/Rust 런타임·공개 모델 revision·제품 기본값·lockfile은 이번 수정에서 변경하지 않았다. 실제 모델 호환성 화면은 5절의 Qwen3-VL revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`, Metal 0.30.0과 선택된 프로필 context4096에서 확인했다.

| 후속 항목 | 상태 | 수정과 실행 근거 |
| --- | --- | --- |
| 실제 새 채팅·PP/TG | pass | `goal-next-chat-proof.json`, `goal-next-chat-reload-proof.json`, `logs/goal-next-chat-final.log`. 현재 소스의 실제 WKWebView에서 새 한국어 입력 ORBIT-84를 보내 실제 Metal 답변 `2 + 3의 답은 5입니다.`와 새 이력을 확인했다. PP50 tokens, TG12 tokens / 469.474ms / 23.4305tok/s, cached0이 기록됐으며 실행 모델/PID를 유지했다. overlay·렌더 오류·body 가로 넘침·검사 fixture는 없었다. 앱 재로드 뒤에도 답변·모델 이름·PP/TG 기록이 유지됐다. PP 시간은 해당 runtime의 미제공 상태를 유지하며 TTFT를 PP 시간으로 사용하지 않았다. |
| 대화 전체 삭제와 늦은 작업 | pass | 이미 마운트된 Chat의 메모리가 삭제 후 대화를 다시 저장하던 결함을 수정했다. 삭제 시작 시 전송·승인·composer와 이전 turn을 무효화하고, 진행 중 저장·hydration을 정리한 뒤 새 workspace로 교체한다. 문서 index 삭제 완료까지 전송을 잠그며 삭제 실패 시 남은 대화를 복구한다. 준비·스트리밍·승인 대기·실제 도구 실행을 모사한 지연 결과, 삭제 뒤 새 turn 진행 중 이전 turn 완료, 늦은 첨부·embedding·save·hydration을 포함한 합성 회귀 11개가 통과했다. `logs/flow-settings-wipe-affected-final.log`의 관련 41 files/317 tests와 `logs/flow-settings-wipe-direct.log`가 근거다. 실제 엔진의 MCP 승인 성공을 뜻하지 않는다. |
| 삭제 화면의 격리 상태 흐름 | pass | `goal-native-settings-isolated-proof.json`, `logs/goal-next-settings-native-isolated-final.log`. 실제 WKWebView의 Settings→삭제 확인→Chat→New chat을 합성 IPC·별도 browser 저장소에서 조작했다. 합성 대화 삭제 호출1회와 과거 텍스트 소멸을 확인했다. 원래 대화 파일의 집계 해시·실제 모델/PID는 보존하고 fixture를 제거했다. 실제 사용자 대화의 native disk 삭제를 실행한 근거가 아니다. |
| API 저장보다 나중의 Stop 보존 | pass | 포트 저장이 늦게 끝난 뒤 앞선 실행 상태를 근거로 listener를 다시 시작하던 결함을 수정했다. 저장 전후 API action revision을 비교해 나중의 Stop을 보존한다. `logs/flow-api-port-intent-after.log`의 합성 회귀와 같은 WKWebView 격리 검사에서 Stop1회/Start0회·Start API 표시를 확인했다. 실제 listener의 포트 변경·중지를 이번 fixture로 검증한 것은 아니다. |
| 진단의 실제 실행 runtime | pass | 나중에 편집한 CPU/Metal·build 선택 대신 로드 시점 `status.execution`과 실제 engine metadata로 표시한다. metadata 유무 두 조건의 회귀 검사에서 편집 설정을 바꾸지 않고 실행 중 CPU/build를 정확히 표시했다. `logs/goal-benchmark-diagnostics-final-tests-fixed.log`. |
| 벤치 Copy의 늦은 결과 | pass | 복사 대기 중 다른 이력을 선택했을 때 이전 작업의 성공·오류가 새 이력에 나타나던 문제를 수정했다. 원래 record·locale·generation에 결과를 제한하고 복사 중 버튼을 잠근다. 지연 성공·지연 실패 회귀가 통과했다. 실제 macOS pasteboard 복사·전체 포맷 복원은 기존 blocked 판정을 유지한다. |
| browser 벤치 이력 보호 | pass | 새 결과 저장 시 읽을 수 없는 JSON이나 미래 schema·거부된 entry를 없애던 문제를 수정했다. 기존 entry를 보존하고 unreadable 저장소는 덮어쓰지 않으며 현재 결과의 export 가능성을 유지한다. invalid JSON·미래 형식·같은 ID의 valid entry만 갱신·추가 저장 회귀가 통과했다. 관련 벤치/진단 7 files/93 tests는 `logs/goal-benchmark-diagnostics-final-tests-fixed.log`에 기록했다. native CSV/XLSX 검사를 대체하지 않는다. |
| snapshot 모델 이름 | pass | 검증된 두 부분 repository가 있는 non-GGUF artifact는 revision SHA 대신 repository 모델 이름으로 목록에 표시한다. 원래 artifact/path/repository와 GGUF 파일 이름·외부 폴더·미검증 repository fallback은 보존한다. `logs/goal-discover-catalog-regression-after.log`의 관련 6 files/80 tests와 실제 설정 편집기의 읽을 수 있는 Qwen3-VL 이름을 확인했다. |
| snapshot 재시도 안내 | pass | 다음 다운로드 시작 시 이전 성공 안내와 Configure and run을 지워 실패·취소와 함께 남지 않도록 했다. 성공 뒤 재시도 pending→실패/취소 회귀가 통과했다. 같은 Discover/catalog 로그에 근거를 남겼다. 실제 network 다운로드 전체 반복은 이번 검사에 포함하지 않았다. |
| 작은 창의 실행 버튼 | pass | 390×600 창에서 Unload가 footer의 스크롤 아래로 가려졌다. 요약만 스크롤하고 실행 버튼은 footer에서 항상 보이도록 바꿨다. `goal-model-footer-before.json`의 버튼 하단606/viewport568이 수정 후 `goal-model-footer-after.json`에서551로 들어왔으며 본문 높이114는 유지했다. `goal-model-dialog-final-proof.json`, `logs/goal-next-model-dialog-final-fixed.log`의 8개 편집기 section×1280×800/960×640/390×600, 24개 실제 화면에서 버튼 표시·가로 넘침 없음·overlay/렌더 오류0·실제 모델 프로세스 보존을 확인했다. 모든 옵션의 실행 순열을 뜻하지 않는다. |
| 엔진별 Supported inputs | pass | artifact의 일반 video 표기가 Metal의 실제 미지원 video까지 노출하던 문제를 수정했다. 선택 provider의 supported/partial compatibility에 선언된 입력만 표시한다. Metal/MLX 두 합성 회귀와 실제 Metal의 text/image 표시를 확인했다. `goal-footer-modalities-before.json`, `logs/goal-next-modalities-repro.log`, `logs/goal-next-modalities-fixed.log`, 최종24화면 JSON이 근거다. |
| 다운로드 진행 카드 | pass | 390×600에서 bytes·속도·Cancel 영역이 카드 오른쪽을 넘는 결함을 수정했다. 실제 WKWebView에 합성 progress event를 전달해101/120GiB·1.76GiB/s·Cancel의 줄바꿈을 확인했다. `goal-discover-progress-before.json`의 cardOverflow=true가 `goal-discover-progress-after-rate.json`에서 false로 바뀌었으며 body 넘침·렌더 오류도 없었다. `logs/goal-discover-progress-regression.log`의 관련3 files/38 tests가 통과했다. 실제101GiB 다운로드 또는 취소 IPC 실행 근거가 아니다. |
| 실제 Settings 알림 제출 | pass | `goal-next-notification-proof.json`, `logs/goal-next-native-notification.log`. 당시 개발 앱의 Settings→Notifications에서 앱이 표시한 Allowed와 Send test notification을 확인하고 실제 버튼으로 제출했다. native IPC 성공 안내와 모델/PID 보존·렌더 오류0을 확인했다. 제품 기본 설정은 바꾸지 않았다. 성공은 OS 제출이며 배너 표시·알림 센터 수신을 확인한 결과가 아니다. 19절에서 macOS 권한 미결정 안내와 Allowed 표시의 혼동을 실제 확인했다. |
| 메뉴 접근성 자동 검사 | pass | 실제1280×800 WKWebView의 11메뉴 기본 화면에서 axe-core WCAG2A/AA·2.1AA·2.2AA 자동 확인 규칙의 violations가0이었다. `goal-native-accessibility-before.json`, `logs/goal-next-accessibility.log`. 설정 편집기·모든 메뉴의 전체 조작 여정·키보드/VoiceOver 검사로 확대하지 않는다. |
| 접근성 수동 판정 | unrun | 같은 JSON의 aria-prohibited-attr와 color-contrast는 incomplete가 남아 있다. 자동 위반0을 전체 접근성 통과로 해석하지 않으며 해당 노드의 수동 판정·실제 보조기기 검사는 남아 있다. |

공통 `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run build`는 모두 종료0이었다. 근거는 `logs/goal-next-{typecheck,lint,unit,build}-final.log`와 `checks.jsonl`이다. 계약/direct/script 검사를 포함해 UI171 files/1688 tests가 통과했으며 coverage statements80.27% / branches75.06% / functions78.61% / lines84.41%다. 이번 변경에는 Rust/Python 코드가 없으며 이전 전체 Rust 검사(lib937 pass/4 ignored·CLI15·integration)의 소스 범위는12절에 남겼다. 기존 frontend500kB chunk 경고는 유지된다.

회귀의 수정 전 실패와 수정 후 성공을 모두 보존했다. 임시 검사 도구의 Window.fetch 바인딩·동적 module/React root·초기 로딩·실제 버튼명/selector 가정 오류는 도구 실패로 구분했고 제품 성공 또는 실패에 더하지 않았다. 별도 소유 프로세스를 종료하거나 원래 사용자 자료를 삭제하지 않았다. 새 소스의 packaging 결과는 16절에 기록하며 13절의 DMG는 `0424ab5`에서 만들어진 산출물이다.

## 15. 원래 기기 검증의 잔여 범위

이 표는 `533b450` 검증 시점의 잔여 기록이다. 이후 실제 Copy·PDF/폴더 picker·macOS 확대 버튼의 한정된 통과와 알림 권한·수신 재관찰은 19절에 연결한다. 완료 근거가 있는 M01·M02·M05·M06·M09·M10은 유지하며, 후속 소스에서 관련 화면·저장·전송을 위 범위로 다시 검사했다. 다른 engine/modality·모든 여정·모든 OS의 전체 반복이 완료됐다는 근거는 없다.

| 관련 ID | 당시 상태 | 당시 잔여 범위와 후속 근거 |
| --- | --- | --- |
| M03·M04·M07 | fail | 직접 Metal/MLX file URI 이미지500, SmolVLM native projector의 알려진 이미지 내용 오답, 고정 Gemma3n native-audio snapshot의 누락 shard index는 미해결이다. upstream/model 수정 후 실제 내용·usage·기록/재로드/재시도 흐름을 다시 검사한다. |
| M07 | blocked | 정상 PATH 복구가 기존 ffmpeg를 찾으므로 실제 ffmpeg 부재의 앱 안내·준비 실패/취소를 검증할 별도 환경이 필요하다. 기존 설치를 숨기거나 PATH 정책을 끄지 않는다. |
| M08·M12 | blocked | 74절의 실제 사람의 OS Yes→수동 tools/call·결과·정리 pass 이후에도 실제 No·모델 후속 답변·승인 후 실제 호출 중 취소·자식/포트 정리는 남아 있다. 승인 대기 만료·취소와 합성 회귀를 실제 호출 취소 성공으로 확대하지 않는다. |
| M11 | blocked | 당시 한글 IME composition 중 Enter, 실제 Copy와 기존 pasteboard 전체 포맷 보존/복원, Dock/트레이 메뉴를 통한 Show/Quit·재열기가 남았다. 실제 paste·닫기/hide·두 번째 실행 restore·normal Quit·기존 OS 파일/저장 picker 성공과 구분한다. 실제 Copy와 확인된 원본 snapshot 복원은 이후 19절에서 통과했다. IME·Dock/트레이·임의 포맷은 남아 있다. |
| M11 | unrun | 별도 OS 계정의 최초 실행·Keychain 허용/거부/취소/수정/삭제·업데이트 재승인·실제 과거 버전 upgrade/legacy 이전, 자연스러운 Finder DMG 설치/첫 실행. Finder/launchd PATH의 MCP·CMake 탐색과 실제 다운로드 quarantine/첫 실행 경고·시스템 설정 열기 경로도 필요하다. |
| M11 | unrun | 당시 PDF/폴더 picker·OS 알림 배너 표시·macOS 창 확대 버튼 조작의 실제 근거가 없었다. 이미 검증한 이미지/음성/영상/Markdown/JSON/CSV/XLSX/LoRA picker와 취소, 세 창 크기·resize와 구분한 기록이다. PDF/폴더와 실제 확대 버튼은 이후 19절에서 통과했다. OS test 알림의 실제 수신·후속 OS 상태 확인은 19절에서도 blocked로 남는다. |
| M11·기기 범위 | unrun | Intel과 macOS13.3–15 실기기. bundle의 arm64·minimum OS13.3 선언이나 현재 macOS 성공으로 대신하지 않는다. |

Metal PP 시간 미제공, embedding/STT의 chat 미지원과 일부 deep comparison의 partial/unsupported는 기존 의미를 유지한다. 공개 benchmark 업로드는 사용자 범위에서 제외되며 로컬 계약 검사를 서비스 수락으로 간주하지 않는다. Developer ID/공증과 Force Quit/SIGKILL 복구·다른 사용자 single-instance 개선은 인계 문서의 별도 배포 결정/알려진 제한으로 남긴다.

## 16. 후속 소스 `533b450`의 arm64 DMG

기존 `npm run package:tauri`로 소스 `533b45000f6d479089d73db01d9da5246929c844`의 frontend·CLI·GUI·DMG를 다시 빌드했다. `logs/goal-next-package-533b450.log`, `logs/goal-next-package-inspect-533b450-python312.log`, `goal-next-package-533b450-results.json`이 근거다. 새 read-only/nobrowse mount에서 검사하고 detach했으며 이전 패키지·원본 로그를 보존했다.

- DMG `AioLM_0.3.1_aarch64.dmg`: 16769928 bytes, SHA256 `0757d7d6525478c963900a9e565ab84413991ce919325a438e0779c07749133c`.
- GUI `aiolm`: arm64, SHA256 `f1a27a8c18999b0c3f76e5883b59b19569bc9d019debd99a5278574d3a2b70c9`.
- CLI `aiolm-cli`: arm64, SHA256 `2b990f039433609178d103678f3ef8d808cca6e96af41ca461915ace4a4aafd5`.
- identifier `com.aiolm.desktop`, version0.3.1, minimum OS13.3 선언을 확인했다. 다른 OS의 실기기 성공으로 해석하지 않는다.
- `codesign --verify --deep --strict` pass. GUI·CLI는 ad-hoc/runtime이며 Developer ID 서명·공증은 수행하지 않았다.
- bundle 일반 파일 5개(Info.plist·CodeResources·GUI·CLI·icon.icns)를 확인했다. 모델·venv·smoke fixture·개인 설정이 포함되지 않았고 실제 home/repository 문자열의 UTF-8·UTF-16 스캔 일치0이었다.
- 기존 파일 없는 별도 새 홈의 packaged CLI에서 onboarding=false, 모델·runtime 미선택, 해당 홈의 모델 저장소 기본값을 확인했다. raw 복사본은 `goal-package-533b450/`에 보관했다.
- 최초 검사 호출의 시스템 Python은 `hashlib.file_digest`가 없어 mount 전에 종료했다. 준비된 CPython3.12로 같은 해시·서명·파일 보호 검사를 실행해 통과했으며 원래 실패 로그를 도구 오류로 보존했다. 검증 항목을 생략하지 않았다.

이 패키지 검사는 Finder 설치·최초 GUI 실행·quarantine·별도 계정 Keychain·실제 upgrade를 대체하지 않는다. 개발 앱과 선택된 Metal 모델은 실행 상태로 유지했고 마지막 실제 한국어 답변·PP/TG를 재로드하여 확인했다. 코드·문서만 커밋하며 raw 자료와 build output은 Git 제외 상태로 유지하고 원격 push는 수행하지 않았다.

## 17. 접근성 의미와 gradient 판정 후속 검증

후속 소스는 `0709eda82771043c83de5f3950fd5dc49c6dd2a9`이다. 14절의 `aria-prohibited-attr` incomplete를 실제 WKWebView의 개별 노드까지 조사해 제품의 ARIA 의미 결함을 수정했다. 화면 디자인·runtime 정책·사용자 설정을 바꾸지 않고 기존 이름이 전달될 수 있는 role을 부여했다. 이 기록은 관련 UI 하위 검사의 근거이며 전체 접근성 또는 M01–M12 통과를 뜻하지 않는다. 3·10·15절의 fail/blocked/unrun을 유지한다.

| 후속 항목 | 상태 | 수정과 실제 근거 |
| --- | --- | --- |
| 기본 실행 컨트롤의 이름 | pass | role 없는 `div`의 aria-label에 유효한 접근성 이름 의미가 없었다. 상단 실행 컨트롤에 `role=group`을 지정하고 실행 중 모델 선택·설정 버튼을 같은 그룹에서 찾도록 검사했다. `goal-a11y-incomplete-full.json`의 `.aiolm-runtime-context` incomplete1개가 `goal-a11y-chat-full-after.json`에서 사라졌다. `logs/goal-a11y-runtime-group-before.log`의 수정 전 회귀 실패와 `logs/goal-a11y-runtime-group-after.log`의 관련2 files/27 tests를 보존했다. |
| provider 설치 목록의 이름 | pass | 같은 문제가 있던 provider runtime 목록에 `role=group`을 지정했다. `goal-a11y-runtime-full-before.json`의 `.provider-runtime-list` incomplete1개가 `goal-a11y-runtime-full-after.json`에서 사라졌다. `logs/goal-a11y-provider-group-before.log`의 수정 전 실패와 `logs/goal-a11y-provider-group-after.log`의 관련4 files/41 tests에서 이름으로 목록을 찾고 기존 export IPC 대상도 유지했다. |
| native runtime export 컨트롤의 이름 | pass | 실제 llama.cpp→Advanced의 Export runtime 컨트롤에도 role 없는 이름 wrapper가 있었다. `role=group`을 지정했다. `goal-a11y-llama-full-before.json`의 해당 aria-prohibited-attr incomplete1개가 `goal-a11y-llama-full-after.json`에서 사라졌고 선택 WCAG 자동 검사에서24규칙 pass·violations0을 확인했다. gradient contrast incomplete24개는 유지했다. 실행 중 모델이 있으므로 CPU/Metal export 버튼은 모두 비활성 상태를 보존했으며, 원래 vLLM 화면·저장된 설정 바이트·실제 모델/PID/running 상태를 유지했다. `logs/goal-a11y-llama-export-before.log`의 수정 전2조건 실패와 `logs/goal-a11y-llama-export-after.log`의 관련3 files/37 tests가 근거다. 실제 bundle export/import·추론을 다시 실행한 검사는 아니다. |
| 진단 영역의 이름·포커스 | pass | 이름을 붙인 `pre`에 유효한 role이 없었다. `role=region`을 지정하고 기존 `tabIndex=0`을 유지했다. 로그를 live region으로 바꾸지 않았다. `goal-a11y-diagnostics-full-before.json`의 `pre` incomplete1개가 `goal-a11y-diagnostics-full-after.json`에서 사라졌다. `logs/goal-a11y-diagnostics-region-before.log`의 수정 전 실패와 `logs/goal-a11y-diagnostics-region-after.log`의 관련4 files/54 tests가 근거다. `goal-a11y-native-final-proof.json`, `logs/goal-a11y-native-final.log`에서 실제 region 이름·내용·포커스 수용·aria-live 부재를 확인했다. 프로그램으로 포커스를 준 결과이며 전체 Tab 순서나 VoiceOver 검사를 대신하지 않는다. |
| 11메뉴 자동 재검사 | pass | `goal-native-accessibility-after.json`, `logs/goal-a11y-native-menus-final.log`. 실제1280×800 WKWebView의11메뉴 기본 화면을 다시 검사했다. 모든 메뉴에서 violations0이며 aria-prohibited-attr incomplete는 없었다. color-contrast incomplete는 남겼다. Chat/Projects/Run a model/Discover/Loaded sessions/Manage runtimes/Benchmark/API server/MCP servers/Diagnostics/Settings의 해당 node 수는 각각26/29/45/20/25/27/42/23/30/21/24다. 숨긴 노드나 모든 상호작용의 전체 접근성 검사로 확대하지 않는다. |
| 실행 모델·화면 보존 | pass | 같은 최종 native proof에서 실제 Metal runtime을 보존했고 Chat 상단의 `Qwen3-VL-2B-Instruct-4bit`와 Default execution 그룹을 확인했다. Chat·Diagnostics 모두 overlay·렌더 오류0이었다. 실제 화면 캡처는 `goal-a11y-chat-final.png`, `goal-a11y-diagnostics-final.png`다. |
| 현재 light Chat의 gradient 대비 | pass | `goal-a11y-incomplete-full.json`의 대비 incomplete26개는 모두 gradient 배경을 자동 판정하지 못한 경우였다. `goal-a11y-styles-full.json`에서 현재 light Chat26개 노드의 실제 computed text/gradient 색과 조상 opacity1·filter 없음·normal blending을 확인했다. `goal-a11y-gradient-facts.json`에서 gradient stop 및 구간별1001개 sRGB 표본의 상대 휘도 대비를 계산했다. 표본상 최소5.389:1로26개 모두 일반 텍스트 기준4.5:1 이상이었다. 오른쪽 예약 padding의 SVG 편집 glyph는 텍스트 배경 계산에서 제외했다. 이는 현재 light Chat의 조사 노드만 확인한 결과다. |
| placeholder·다른 테마·보조기기 | unrun | WebKit의 `getComputedStyle(::placeholder)`는 일반 foreground를 반환하여 실제 placeholder pseudo-element 색을 직접 확인하지 못했다. 활성 light palette의 `--ui-faint`와 소스 규칙으로 계산한 두 placeholder stop 대비5.470:1 이상은 보조 근거로만 남긴다. 다른 테마·메뉴·상태의 gradient 대비, 전체 키보드/VoiceOver·OS 접근성 여정은 이 계산으로 통과 처리하지 않는다. axe의 contrast incomplete 원본도 그대로 유지한다. |

최종8개 파일을 포함한 `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run build`는 모두 종료0이었다. `logs/goal-a11y-combined-{typecheck,lint,unit,build}-final.log`, `checks.jsonl`이 근거다. 계약/direct/script 검사를 포함해 UI171 files/1690 tests가 통과했고 coverage statements80.27% / branches75.12% / functions78.63% / lines84.41%다. 네 번째 컨트롤 수정 전6개 파일의171 files/1689 tests 검사도 `logs/goal-a11y-unit-final.log`에 따로 보존했다. Rust/Python·lockfile 변경은 없으며 기존 frontend500kB chunk 경고는 유지된다. 실제 모델·대화 원본을 변경하거나 OS 권한을 조정하지 않았다. 소스 커밋 뒤 같은 native 검사를 `goal-a11y-native-0709eda-proof.json`, `logs/goal-a11y-native-0709eda.log`에 재기록했고 실행 상태·Chat 모델명·진단 포커스 수용·overlay/렌더 오류0을 다시 확인했다. 해당 캡처는 `goal-a11y-chat-0709eda.png`, `goal-a11y-diagnostics-0709eda.png`다. 새 패키지 검사는18절에 기록하며16절 DMG는 이전 소스 `533b450`의 산출물이다.

GGUF는 llama.cpp 전용으로 제한된 포맷이 아니다. 현재 검증한 [vllm-metal0.30.0 공식 GGUF 문서](https://github.com/vllm-project/vllm-metal/blob/v0.30.0/docs/gguf.md)도 MLX를 통한 dense GGUF와 별도 matching config/tokenizer 지원을 명시한다. 지원 모델·양자화·분할 여부에는 제한이 있다. 11절의 원본 근거를 다시 대조했으며 `user-400-before.json`의 실제 engine은 vllm-metal이었다. `ui-user-400-before.json`의 HTTP400은 채팅 템플릿 부재였고, `chat-template-base-proof.json`은 같은 Metal에서 completion200/8+16=24 tokens와 chat400/`chat_template_required`를 확인한다. 파일 형식의 로딩 실패와 채팅 템플릿 문제를 구분한다. 이는 기존 근거의 재대조이며 이번 접근성 수정에서 GGUF 추론을 새로 반복한 결과가 아니다.

## 18. 접근성 후속 소스 `0709eda`의 arm64 DMG

기존 `npm run package:tauri`로 소스 `0709eda82771043c83de5f3950fd5dc49c6dd2a9`의 CLI·frontend·GUI·DMG를 빌드했다. `logs/goal-a11y-package-final.log`, `logs/goal-a11y-package-inspect-final.log`, `goal-a11y-package-0709eda-results.json`이 근거이며 두 명령 모두 종료0이었다. 준비된 CPython3.12로 새 read-only/nobrowse mount에서 검사하고 detach했다.

- DMG `AioLM_0.3.1_aarch64.dmg`: 16769931 bytes, SHA256 `85aa20e45231bd54baca19e535876e51b47c3ce824b5e2a89caeca8efc58f1cd`.
- GUI `aiolm`: arm64, SHA256 `590d5f9d0a0b70c64f53d863021f04c0f8ce589f660400cc5b6a2c1ffc48e43b`.
- CLI `aiolm-cli`: arm64, SHA256 `1c1b742a8d20c7b9123f0e67ac0122a2c8c608a558f0ad92017d7a1177c07084`.
- identifier `com.aiolm.desktop`, version0.3.1, minimum OS13.3 선언을 확인했다. Intel·구형 OS 실기기 성공으로 해석하지 않는다.
- `codesign --verify --deep --strict` pass. GUI·CLI는 ad-hoc/runtime이며 Developer ID 서명·공증은 수행하지 않았다.
- bundle 일반 파일은 Info.plist·CodeResources·GUI·CLI·icon.icns 5개였다. 모델·venv·smoke fixture·개인 설정이 포함되지 않았으며 실제 home/repository 문자열의 UTF-8·UTF-16 스캔 일치0이었다.
- 기존 파일 없는 별도 새 홈의 packaged CLI에서 onboarding=false, 모델·runtime 미선택, 해당 홈의 모델 저장소 기본값을 확인했다.
- raw 복사본은 `goal-package-0709eda/`에 보관했다. 이전 소스의 raw DMG·로그·검사 자료를 보존했다.

이 검사는 Finder 설치·첫 GUI 실행·quarantine·별도 계정 Keychain·실제 upgrade를 대신하지 않는다. 15절의 잔여 범위와 17절의 수동 접근성 범위를 유지한다. 개발 앱과 선택된 Metal 모델은 실행 상태로 유지했다. 코드·검사·문서만 커밋하고 raw 자료와 build output은 Git 제외 상태로 두었으며 원격 push는 수행하지 않았다.

## 19. 실제 macOS 창·picker·Copy·gateway·알림 후속 검증

실제 Tauri WKWebView를 포함한 임시 debug 앱 bundle을 네이티브 CUA로 조작하고 원본 캡처·저장 파일·HTTP 응답을 읽어 확인했다. 창·picker·gateway의 검증 소스는 `0709eda82771043c83de5f3950fd5dc49c6dd2a9`이며, 알림 안내 수정과 이후 실제 화면·clipboard 검증의 소스는 `5fd5e826705dc76beda11674764f5ad586ea20dc`다. production DMG의 Finder 설치나 별도 계정의 최초 실행으로 확대하지 않는다.

| 실제 후속 항목 | 상태 | 확인한 범위와 원본 근거 |
| --- | --- | --- |
| 실행 모델·원본 대화 보존 | pass | `goal-native-continuation-restored-proof.json`, `goal-native-picker-validation-results.json`. 기존 native 대화22개 파일의 개별 SHA256과 재실행 직후 전체 digest가 같았고 이후 PDF 합성 대화 한 개만 추가됐다. 같은 vllm-metal·Qwen3-VL 모델의 running 상태와 HTTP readiness를 확인했다. 실제 Save profile & start로 공용 프로필 저장소·한 프로필·한 적용 binding의 revision만 증가했으므로 재실행 전 설정 전체가 동일하다고 주장하지 않는다. 프로필 내용·모델 선택·실행 값은 유지됐다. |
| macOS 창 확대·복원 | pass | 실제 macOS green-button 확대와 되돌리기 후 WKWebView viewport가1280×768→1920×928→1280×768로 복원됐다. `goal-native-window-before.json`, `goal-native-window-zoomed.json`, `goal-native-window-restored.json` 및 같은 이름의 PNG, picker 검증 JSON에서 같은 실행 모델·프로세스와 overlay/렌더 오류0을 확인했다. WebDriver resize나 fullscreen 검사가 아니다. |
| PDF OpenPanel 취소·선택·내용 응답 | pass | 실제 OpenPanel Cancel에서 첨부와 입력이 비어 있었고 다시 Go To/Open으로 합성 `synthetic-text-orbit-92.pdf`를 선택해 질문을 입력·전송했다. 응답에 ORBIT-92와 파란 원이 빨간 사각형 왼쪽이라는 내용이 들어갔다. PDF 이름·추출 텍스트·인용·모델·usage가 새 대화에 저장됐고 원본 PDF SHA256은 불변이었다. `goal-native-window-picker-cancel.json`, `goal-native-window-picker-loaded.json`, `goal-native-window-pdf-response.json`, picker 검증 JSON이 근거다. PDF의 텍스트 추출·문서 context 검증이며 그림을 모델이 시각적으로 읽었다는 근거는 아니다. |
| PDF 답변 재로드·usage | pass | `goal-native-window-pdf-reloaded.json`과 응답 캡처에서 같은 내용·인용·지표를 재확인했다. 실제 PP94 tokens·TG21 tokens, TG0.88 s·22.7 tok/s가 저장·표시됐다. runtime이 제공하지 않은 PP phase 시간·속도는 `—`로 표시했다. first-token 관측 시간을 PP phase로 계산하지 않았다. |
| 모델 폴더 Browse·취소·복원 | pass | 실제 Browse→Cancel에서 직전 설정이 같았다. 합성 빈 폴더를 Go To/Open으로 선택했을 때 모델 경로 키만 바뀌고 Models0/no models found가 표시됐으며 다시 원래 폴더를 선택한 뒤 Models7과 직전 설정이 복원됐다. `goal-native-window-folder-before.json`, `goal-native-window-folder-cancel.json`, `goal-native-window-folder-empty.json`, `goal-native-window-folder-restored.json` 및 picker 검증 JSON에서 실행 값·모델 프로세스 유지와 overlay/렌더 오류0을 확인했다. 이 설정 일치는 폴더 검사 직전 snapshot 기준이다. |
| Chat의 초기 Copy·원본 clipboard 복원 | pass | `goal-native-clipboard-chat-results.json`, picker 검증 JSON. 합성 답변의 실제 Copy 버튼을 클릭해 Copied 표시와 복사 텍스트 일치를 확인했다. 원래 clipboard 한 item/한 representation의 전체 snapshot을 복원·재확인했으며 원본 내용은 로그나 파일에 저장하지 않았다. fixture는 두 item/세 representation으로 준비했다. 이 단계는 Copy 근거이며 실제 Cmd+V와 다중 포맷 복원은 다음 후속 검사에서 확인했다. |
| 실제 Cmd+V·Copy·다중 포맷 복원 | pass | `goal-native-clipboard-multiformat-results.json`, `goal-native-clipboard-paste-ui.json`, `goal-native-clipboard-restored-ui.json`, `logs/goal-native-clipboard-paste-observe-final.log`, `logs/goal-native-clipboard-restored-observe-final.log`. 메모리 안의 중첩 snapshot으로 합성 두 item/세 type·95 bytes(plain text·HTML·custom binary)를 준비했다. 실제 Cmd+V의 입력 일치·미전송과 읽기 전용 snapshot 검사의 stable/matched/clipboard 쓰기 없음을 확인했다. 입력 삭제 뒤 실제 Copy의 Copied 표시와 예상27-byte 텍스트 일치를 확인하고 합성 item/type/data의 순서를 포함해 모두 복원한 뒤 원본 한 item/한 type도 복원·검증했다. 두 helper 종료0·finally 추가 clipboard 쓰기 없음·원본 clipboard 내용 출력/저장 없음이 확인됐다. snapshot 복원은 검사 helper의 보호 절차이며 앱 Copy가 이전 clipboard를 보존하는 제품 기능이라는 의미는 아니다. IME·promised/unreadable 또는 임의 모든 포맷은 unrun이다. |
| gateway SSE 연결 종료·후속 응답 | pass | `goal-native-gateway-continuation-results-2026-10-08T02-23-06-424Z.json`에서 실제 HTTP200/event-stream·첫 delta 후 client 연결을 종료하고 active requests0→1→0, 같은 모델의 후속 READY 응답 HTTP200과 usage14+2=16을 확인했다. 이 원본 통합 결과는 뒤의 임시 adapter 검사 오류 때문에 fail이며 stream 하위 결과는 pass다. 최신 `goal-native-gateway-continuation-results-2026-10-08T02-28-20-882Z.json`은 원본 SHA256과 동일 앱·모델을 확인하여 이 스트림 근거를 연결했다. 최신 단계에서 스트림을 다시 실행한 것으로 계산하지 않는다. |
| Responses/Messages 미디어 오류 형식 | pass | 위 최신 gateway JSON에서 Responses input_audio/input_video, Messages audio/video의 네 실제 요청이 HTTP400·JSON으로 거부됐다. Responses는 error.code=invalid_request와 error.type=invalid_request_error, Messages는 top-level type=error와 error.type=invalid_request_error를 확인했다. Messages에 없는 error.code를 요구한 이전 임시 검사 가정을 바로잡았고 원본 fail을 보존했다. 각 요청 후 active requests0, 검사 전후 설정 digest와 실행 모델이 같았다. 미지원 adapter 입력의 오류 계약 검사이며 native audio/video 추론 성공이 아니다. |
| 수정 전 OS test 알림 제출·권한 안내 | pass | `goal-native-notification-os-before.json`. 실제 Settings의 Send test notification을 눌러 native IPC 성공 안내를 확인했다. macOS는 Allow/Don’t Allow가 있는 권한 미결정 안내를 표시했고 Close만 눌러 창이 닫힌 것을 확인했다. 계정의 알림 권한을 결정하거나 시스템 설정을 바꾸지 않았다. 이때 앱의 Allowed 표시는 실제 macOS 승인을 확정하지 못해 혼동을 주는 제품 결함이었다. |
| 수정 후 실제 알림 안내·제출 | pass | `goal-native-notification-after-ready.json`, `goal-native-notification-after-submitted.json` 및 같은 이름의 PNG, `logs/goal-native-notification-after-ready.log`, `logs/goal-native-notification-after-submitted.log`. 실제 CUA로 Notifications의 Ready to send와 첫 알림의 OS 권한 안내를 확인하고 Send test notification을 눌러 submitted 성공 피드백을 확인했다. 카테고리 세 toggle off·직전 폴더 검사 기준 설정 일치·같은 모델·API off·overlay/렌더 오류0을 보존했다. 일반 알림의 기본값을 바꾸거나 OS 권한을 승인하지 않았다. |
| 실제 test 알림 수신 | blocked | 수정 전후 test 제목·본문 수신은 관찰되지 않았다. `goal-native-notification-center-after-observation.json`의 공식 NotificationCenter 재관찰 두 번도 timeoutReached로 끝났다. 이 검증에서 OS 권한을 결정하거나 시스템 설정을 바꾸지 않았으나 후속 OS 권한 상태를 확정하지 못했다. 수정 전 권한 미결정 안내의 근거는 보존하고 실제 배너/알림 센터 수신은 미확인으로 남긴다. Ready to send와 native 제출 성공, OS 권한 안내 표시를 test 본문 전달 성공으로 세지 않는다. |
| 후속 소스의 원래 Chat·저장 자료 보존 | pass | `goal-native-notification-final-proof.json`, `goal-native-notification-final-chat.png`, `logs/goal-native-notification-final-check.log`. 소스 `5fd5e82`에서 원래 ORBIT-84 대화와 답변·response model·PP/TG 표시·빈 입력을 확인했다. 원본22개 대화 파일의 모든 SHA256이 같고 총23개 중 추가분은 앞서 만든 합성 PDF 대화 한 개뿐이었다. 폴더 검사 직전 설정 일치·같은 실행 모델·running·API off/active requests0·overlay/렌더 오류0을 확인했다. package 빌드 후에도 실제 CUA로 같은 Chat을 다시 확인하고 `goal-native-notification-after-package-proof.json`, `goal-native-notification-after-package-chat.png`, `logs/goal-native-notification-after-package-check.log`에서 설정·실행·원본 해시·대화 수·빈 입력·오류 없음이 보존된 것을 재확인했다. |
| Gemma4 audio 준비 | pass | `goal-native-audio-gemma4/pinned-metadata.json`, `goal-native-audio-gemma4/processor-preflight.json`, `goal-native-audio-gemma4/snapshot-verification.json`. 공개 `mlx-community/gemma-4-E2B-it-4bit`의 전체 revision `238767527555cb75a05732a84dff5d6ba0dd6809`를 고정했다. 설치된 mlx-vlm0.7.6의 gemma4 loader·Gemma4Processor/Gemma4AudioFeatureExtractor와 합성 음성 preprocessing을 먼저 확인했다. 이 preflight는 sidecar9개를 검사하고 가중치를 다운로드하거나 모델을 생성하지 않았다. 이후 전체 snapshot10개 파일·3,583,088,661 bytes의 해시와 누락 shard 없음이 확인됐다. 기존 Gemma3n 자료는 변경하지 않았다. |
| Gemma4의 실제 native 음성 추론 | unrun | 이 준비 단계 당시 전체 snapshot 검증의 model_start는 unrun이었다. 실제 모델 시작·음성 내용·usage·기록/재로드·재시도·취소의 후속 결과는 21절에 기록한다. 기존 Gemma3n 누락 shard 실패나 M04/M07을 통과 처리하지 않는다. |

gateway 검사 후 API server는 네이티브 CUA의 Stop으로 off 상태에 복원했고 같은 모델의 실행을 유지했다. 별도 `goal-native-gateway-restored-proof.json`, `logs/goal-native-gateway-restored-final.log`의 종료0에서 API off·소유 gateway 포트 닫힘·active requests0·직전 설정 정확한 복원·모델 실행 보존·실제 stopped 화면을 확인했다. 이 단계는 앞선 gateway JSON의 스트림·adapter 근거에 포함된 것으로 계산하지 않는다. 초기 `logs/goal-native-gateway-restored.log`는 공통 검사 중 Vite reload로 Chat으로 이동해 stopped 문구를 찾지 못한 검사 순서 오류였고 API/설정/모델/포트 검사는 이미 통과했다. 원본 실패 로그를 보존하고 실제 API 화면에서 다시 확인했다.

알림 수정 전 `logs/goal-native-notification-copy-before.log`의 회귀 실패11개와 수정 후 `logs/goal-native-notification-copy-after.log`의 관련4 files/36 tests를 보존했다. 영어·한국어·일본어·중국어에서 제출 가능 상태와 OS 승인/전달의 차이, 카테고리 off 중 test 제출을 확인했다. 최종 `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run build`는 모두 종료0이었다. `logs/goal-native-notification-{typecheck,lint,unit,build}-final.log`가 근거이며 계약/direct/script 검사를 포함해 UI171 files/1697 tests·coverage statements80.27% / branches75.12% / functions78.63% / lines84.41%가 통과했다. 변경은 알림 관련 소스·검사5개 파일이며 Rust/Python·lockfile 변경은 없었다. 기존 frontend500kB chunk 경고는 남아 있다.

clipboard의 초기 `logs/goal-native-clipboard-paste-observe.log`는 존재하지 않는 `.chat-composer textarea`를 가정한 임시 관찰 도구 오류였다. 실제 native paste와 읽기 전용 전체 snapshot 비교는 통과한 상태였으며 최종 관찰은 실제 aria-label selector로 확인했다. 원본 오류 로그를 보존하고 제품 실패나 추가 성공으로 계산하지 않는다.

10·15절의 당시 clipboard Copy·PDF/폴더·green-button 미실행 기록은 위 한정된 실제 검증으로 이어진다. 합성 다중 포맷의 복원을 임의 clipboard 포맷 전체로 확대하지 않으며 IME와 다른 OS 여정은 남아 있다. 모든 raw JSON·PNG·합성 PDF·모델·원본 실패 자료는 `tmp/macos-acceptance/`에 보존하고 개인 경로·실행 식별자·포트·설정 값·clipboard 원문은 이 문서에 복사하지 않았다. 공개 업로드나 원격 push는 수행하지 않았다.

이 단계 이후의 범위는 MCP Yes/No→실제 tools/call→후속 답변 및 호출 중 취소·소유 자식 정리, 한글 IME composition 중 Enter, Dock/트레이 Show/Quit·재열기, 두 모델을 실제 전환하는 프로필 여정, Gemma4 native 음성 추론이었다. Gemma4와 원래 실행 복원의 실제 후속 결과 및 최신 잔여 범위는 21절에 기록한다. 알림은 이 검증에서 OS 권한을 결정하지 않았고 후속 OS 상태·실제 수신을 확인하지 못해 blocked다. 별도 계정의 최초 실행·Keychain·실제 upgrade·자연스러운 Finder 설치, Intel·구형 macOS는 unrun으로 유지한다. **전체 M01–M12 기기 검증은 통과하지 않았다.**

새 소스 `5fd5e82`의 기존 `npm run package:tauri` 빌드와 DMG 내용·서명·해시·개인정보 검사는 종료0으로 완료했으며 20절에 기록한다. 18절 DMG는 이전 `0709eda`의 산출물로 보존했다.

## 20. 알림 안내 후속 소스 `5fd5e82`의 arm64 DMG

기존 `npm run package:tauri`로 소스 `5fd5e826705dc76beda11674764f5ad586ea20dc`의 CLI·frontend·GUI·DMG를 빌드했다. `logs/goal-native-notification-package-5fd5e82.log`, `logs/goal-native-notification-package-inspect-5fd5e82.log`, `goal-native-notification-package-5fd5e82-results.json`이 근거다. 빌드236.63 s·검사4.122 s 모두 종료0이었고 검사 전후 소스 HEAD 일치와 새 read-only/nobrowse mount의 detach를 확인했다.

- DMG `AioLM_0.3.1_aarch64.dmg`: 16772410 bytes, SHA256 `4114b003f8f1d63dd3d3b6ae5fc88e0baa513dd095e34a4334178ecc84737642`.
- GUI `aiolm`: arm64, SHA256 `1da3b2ce4757387f64b12c0c40233320a8996ce6cb98056c5311e669df1516bc`.
- CLI `aiolm-cli`: arm64, SHA256 `2a21a9d6f7f3830ea1227052d0c6bf48a441c13bd4d846c44005b4671b048e23`.
- identifier `com.aiolm.desktop`, version0.3.1, minimum OS13.3 선언을 확인했다. Intel·구형 macOS 실기기 결과로 확대하지 않는다.
- `codesign --verify --deep --strict` pass. GUI·CLI는 ad-hoc/runtime이며 Developer ID 서명·공증은 수행하지 않았다.
- bundle 일반 파일은 Info.plist·CodeResources·GUI·CLI·icon.icns 5개였다. 모델·venv·smoke fixture·개인 설정이 없고 실제 home/repository·fixture 문자열의 UTF-8·UTF-16LE/BE 스캔 일치0이었다.
- 기존 파일 없는 별도 새 홈의 packaged CLI에서 onboarding=false·모델/runtime 미선택과 해당 홈의 모델 저장소 기본값을 확인했다. CLI 종료0이었다.
- raw 복사본은 `goal-package-5fd5e82/`에 보관했다. 이전 소스의 DMG·로그·원본 모델·대화를 보존했다.

빌드 뒤의 실제 개발 앱·원래 대화·실행 모델·설정 보존 재검증은 19절의 after-package 근거에 기록했다. 이는 production GUI의 Finder 설치·첫 실행·quarantine·별도 계정 Keychain·실제 upgrade나 OS test 알림 수신을 대신하지 않는다. 3절의 전체 판정과 19절의 잔여 범위를 유지하며 전체 기기 검증은 통과하지 않았다. raw/build output은 Git 제외 상태로 유지하고 원격 push는 수행하지 않았다.

## 21. 실제 Gemma4 음성 입력·취소·재시도와 실행 복원

19절의 고정 Gemma4 snapshot을 실제 WKWebView에서 시작했다. MLX runtime0.7.6은 이 앱 홈에 외부 등록된 환경이며, 별도 관리형 설치를 가리킨다. 등록 소유권을 managed로 바꾸지 않았다. 새 공용 프로필 `Native audio acceptance ORBIT-93`에 max_tokens128·max_kv_size4096·max_num_seqs1·enable_thinking=false·temperature0을 설정했다. 모델 revision은 `238767527555cb75a05732a84dff5d6ba0dd6809`이며 loader·processor·가중치·readiness 검사를 완화하지 않았다.

| 실제 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 원래 모델 종료→MLX 모델 시작 | pass | 실제 Unload 뒤 이전 소유 모델 프로세스와 포트가 닫혔고, 실제 Save profile & start로 Gemma4를 시작했다. `goal-native-audio-{draft,old-stopped,start-observation,ready}.json`, `goal-native-audio-old-runtime-cleanup.json`. authenticated health의 loaded_model·models 응답·소유 loopback listener를 독립 확인한 `goal-native-audio-running-content-audit-20261008T032315479Z.json`도 보존했다. |
| native WAV 입력·내용·usage | pass | 실제 New chat→Use native input only→OpenPanel의 합성 `speech.wav`→Send. STT 세션을 선택하지 않았다. 서버 로그는 audio1/images0을 확인하며, 답을 포함하지 않은 질문에 빨간 사각형이 왼쪽·파란 원이 오른쪽이라는 내용이 정확했다. `goal-native-audio-{attached,first-request}.json`과 PNG, 독립 content audit에서 원본과 저장 WAV의 98,524 bytes·SHA256 일치, 전사 전처리 없음, PP122/2.99 s/40.8 tok/s·TG18/0.53 s/34.2 tok/s를 확인했다. |
| 기록 재로드 | pass | 다른 대화를 실제 선택한 뒤 음성 대화로 돌아와 동일한 첨부·답변·모델·지표를 확인했다. `goal-native-audio-reloaded.json`/PNG. 이 모델은 catalog 밖의 local snapshot으로 선택했고 UI 이름은 revision fallback이다. 공개 repository 이름을 추측해 표시한 결과가 아니다. |
| 실제 음성 생성 Stop | pass | 새 WAV 대화에서 실제 Stop generation을 눌렀다. `goal-native-audio-cancelled.json`/PNG·독립 final audit에서 generation cancelled14 tokens·stream_closed_before_completion·in_flight0과 저장 assistant interrupted=true·부분 응답 보존을 확인했다. 최종 usage를 받지 못한 토큰/phase 시간은 `—`로 남겼다. 앞선 `cancel-pending` 요청은 29 tokens·finish_reason=stop의 자연 완료였으므로 취소 근거로 계산하지 않는다. |
| 진행 중 Unload 보호와 안내 | pass | 실제 생성 중 Unload는 active response 보호로 거부됐고 모델을 종료하지 않았다. 수정 전 `goal-native-audio-active-unload-guard.json`은 모델 파일·경로를 확인하라는 잘못된 안내를 보여준다. `b523f79` 적용 후 `goal-native-audio-active-unload-guard-after.json`/PNG에서 현재 응답을 끝내거나 중지한 뒤 재시도하는 안내와 실제 모델 running을 확인했다. 이 변경은 안내 분류만 수정하며 backend guard·readiness·상태 처리를 유지한다. |
| 잘못된 WAV의 동일 입력 Retry | pass | 별도로 만든 24-byte invalid WAV를 실제 OpenPanel로 선택했다. Send의 decode HTTP500 후 실제 Retry last message도 같은 오류로 종료됐다. `goal-native-audio-{invalid-first,invalid-retry}.json`/PNG와 final audit에서 user1/assistant0·동일 immutable audio ref/바이트/해시·빈 입력·진행 종료를 확인했다. Retry 저장으로 thread.json SHA는 바뀌었으므로 대화 파일 전체가 불변이라고 하지 않는다. 손상 입력의 오류/재시도 검사이며 정상 음성 복구 성공으로 계산하지 않는다. |
| 일부 긴/후속 음성 질문 | fail | audio1로 전달된 후속 질문 및 별도의 긴 질문에 모델이 음성을 다시 제공하라고 답했다. 단순 첫 질문 성공과 분리한다. `goal-native-audio-{cancel-pending,active-unload-guard}.json`과 로그가 근거다. 앱의 이전 음성 ref 전달 누락은 확인되지 않았으며 원인은 미확정이다. 모델·upstream 이력/processor 처리 후보를 제품 결함으로 단정하거나 template/cache/weights를 바꿔 통과시키지 않았다. |
| 직접 upstream 차분 재현 | pass | `goal-native-audio-direct-route-fixed.json`과 세 SSE 원본. 같은 음성 없이 질문했을 때 입력을 요구했고, 같은 WAV를 넣은 간단한 질문·전사는 각각 정확한 HTTP200 응답과 usage를 반환했다. native UI 검사를 대신한 근거가 아니다. 이전 `direct-first`의 세404는 이미 /v1이 있는 앱 URL에 /v1을 다시 붙인 임시 helper 오류였으며 원본을 보존했다. |
| 원래 실행·대화·설정 복원 | pass | MLX의 정상 Unload 뒤 소유 프로세스·포트 닫힘은 `goal-native-audio-mlx-runtime-cleanup.json`에서 확인했다. 실제 vLLM/Metal 선택·기존 Qwen3·4096 컨텍스트의 공용 Default를 저장/시작했다. `goal-native-audio-qwen-restored.json`과 `goal-native-audio-qwen-new-response.json`/PNG에서 원래 active 값·설정값 복원과 ORBIT-95의 실제 한국어 답변·PP53/TG12/0.42 s/26.1 tok/s를 확인했다. API off·active requests0·overlay/렌더 오류0을 유지했다. |

`goal-native-audio-final-readonly-audit-20261008T033444822699Z.json`의 독립 검사에서 검사 직전 23개 대화의 모든 SHA256은 보존됐다. 새 합성 대화4개 후 총27개였고, 복원된 Qwen3의 새 검증 답변을 추가한 뒤 총28개다. 후속 `goal-native-audio-qwen-restore-addendum-20261008T033840728837Z.json`도 새 답변·실제 usage·원본23개 보존·설정 복원·API off를 독립 확인했다. 기존 프로필16개는 완전히 같고 vLLM Default 한 개는 정상 저장에 따른 revision6→7만 달라졌으며 기존 binding 한 개의 profile_revision도 이에 맞게 증가했다. 기존 설정 내용·default/recent 식별자는 같다. 새 MLX 프로필과 binding은 검증 자료로 보존했다. library revision 보호를 우회하여 옛 파일을 직접 덮어쓰지 않았다. 복원 설정은 settings_profiles를 제외한 모든 값이 검사 직전과 같다.

invalid WAV의 decode 예외 때 upstream 로그의 in_flight가1→2로 남는 제약도 관찰됐다. 앱의 active_requests0과 별개이므로 모든 upstream counter가 정리됐다고 기록하지 않는다. 뒤의 정상 Unload로 해당 소유 프로세스와 포트를 종료한 근거는 따로 확인했다.

직접 회귀 `logs/goal-native-active-response-lifecycle-{before,after}-20261008.log`는 수정 전 종료1·수정 후 종료0이다. 실제 loading/replacing/unloading·named session의 Error/string 분류, 원문 보존과 기존6종 안내를 검사했다. 최종 `logs/goal-native-active-response-{typecheck,lint,unit,build}-final.log`는 모두 종료0: typecheck11.13 s·lint6.47 s·unit130.38 s·build13.86 s, UI171 files/1697 tests·coverage statements80.26% / branches75.11% / functions78.63% / lines84.41%. frontend500kB chunk 경고는 유지한다. 수정 소스·직접 검사는 두 파일이며 Rust/Python·lockfile 변경은 없다.

19절의 일부 준비/미실행 기록을 위 실행으로 이어갔지만 M04/M07의 내용 실패·URI500·Gemma3n 누락 shard는 해결되지 않았다. MCP native Yes/No→실제 tool/후속 답변·호출 중 취소, 한글 IME composition Enter, Dock/트레이 Show/Quit·재열기, 같은 엔진의 두 모델 간 공용 프로필 재사용, 추가 대비/VoiceOver·promised/unreadable clipboard는 남아 있다. 알림 실제 수신·ffmpeg 부재는 blocked, 별도 OS 계정의 최초 실행·Keychain·실제 upgrade·자연스러운 Finder 설치 및 Intel·구형 macOS는 unrun이다. **전체 M01–M12는 통과하지 않았다.**

런타임만 교체하면서 공통 기능을 유지하는 방향은 [교체 가능한 추론 런타임 설계](pluggable-inference-runtimes.ko.md)에 기록했다. `42620c9`의 설계 제안이며 개인 엔진의 manifest 등록·registry·adapter 구현 완료를 의미하지 않는다. 현재 세 provider ID·프로필 revision·benchmark schema1/2·portable ABI/해시 계약을 이번 안내 수정이나 음성 검증 때문에 바꾸지 않았다. raw 자료와 모델·프로필 snapshot은 `tmp/macos-acceptance/`에 보존했고 공개 업로드·원격 push는 수행하지 않았다.

## 22. 실행 보호 안내 수정 소스 `b523f79`의 arm64 DMG

기존 `npm run package:tauri`로 `b523f79625be5290c87e11ea48efc6455416b6e9`의 CLI·frontend·GUI·DMG를 빌드했다. `logs/goal-native-active-response-package-b523f79.log`, `logs/goal-native-active-response-inspect-package-b523f79.log`, `goal-native-active-response-package-b523f79-results.json`이 근거다. 빌드227.09 s·검사2.386 s 모두 종료0이었다. 검사 전후 HEAD 일치와 read-only/nobrowse mount의 detach를 확인했다.

- DMG `AioLM_0.3.1_aarch64.dmg`: 16772519 bytes, SHA256 `811e1a38514b61eb7e63dc36de447161ca87613cce1326a8c957bc6b4f73353f`.
- GUI `aiolm`: arm64, SHA256 `02aea0326993f5a29997dfb436475e7228638b78360c2e28a9165b3a738e27ea`.
- CLI `aiolm-cli`: arm64, SHA256 `e64f24ca44c8108a9612144fe7d09db33b63fef740946dd71b1d160a196fa98d`.
- GUI·CLI 해시는 빌드 앱의 바이너리와 일치했다. identifier `com.aiolm.desktop`·version0.3.1·minimum OS13.3 선언을 확인했다. Intel·구형 macOS 실기기 결과로 확대하지 않는다.
- `codesign --verify --deep --strict` pass. GUI·CLI는 ad-hoc/runtime이며 Developer ID 서명·공증은 수행하지 않았다.
- bundle의 일반 파일5개·symlink 없음, 실제 home/repository 및 음성·PDF·picker·smoke fixture 문자열의 UTF-8·UTF-16LE/BE 스캔 일치0을 확인했다. 개인 설정·모델·venv를 배포물에 넣지 않았다.
- 기존 파일 없는 별도 새 홈의 packaged CLI에서 onboarding=false·모델/runtime 미선택·격리된 모델 저장소 기본값과 종료0을 확인했다.
- 원본과 해시가 같은 raw DMG 복사본은 `goal-package-b523f79/`에 보존했다. 이전 패키지·로그·검증 모델·원본 대화는 유지했다.

빌드 후 실제 CUA로 원래 ORBIT-84 대화를 선택했다. `goal-native-audio-after-package-b523f79.json`/PNG와 `logs/goal-native-audio-after-package-b523f79.log`에서 같은 Qwen3/vllm-metal의 running·API off·active requests0·빈 입력·overlay/렌더 오류0, 원본23개 대화 SHA256 보존과 총28개를 재확인했다. 이 개발 앱 검사는 production GUI의 자연스러운 Finder 설치·최초 실행·quarantine·별도 계정 Keychain·실제 upgrade를 대신하지 않는다. 21절의 실패·잔여 범위를 유지하며 **전체 M01–M12 검증은 통과하지 않았다.** raw/build 산출물은 Git 제외 상태로 유지하고 원격 push는 수행하지 않았다.

## 23. 실제 MCP 조회·승인 대기 정리와 기술 입력 치환 수정

새 합성 서버 `Synthetic signalled tools ORBIT-96`를 실제 MCP 화면에서 등록했다. 기존 서버·원본 로그를 재사용하지 않았으며 별도의 fixture events와 lifetime 관측기를 사용했다. 합성 `synthetic_echo_orbit96`은 텍스트 receipt를 반환하고 `synthetic_hold_orbit96`은 호출 시작 신호 뒤 반환하지 않도록 준비했다. 준비와 실제 실행을 구분한다. 기존 Qwen3 모델·runtime 설정·승인 정책은 바꾸지 않았고 tool-enabled 프로필을 시작하지 않았다.

| 실제 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 새 서버 저장·도구 조회 | pass | 실제 Save server→Discover tools에서 두 도구의 이름·설명을 받았다. `goal-native-audio-mcp-orbit96-discovered.json`/PNG, `goal-native-mcp-orbit96-lifetime/fixture-events.jsonl`·`observer-events.jsonl`·`observer-state.json`. 조회 세션의 부모·자식 두 lifetime 연결이 모두 remoteEnded/closed=true·socketError=false로 종료됐다. 도구 호출 성공으로 세지 않는다. |
| 앱 검토→별도 native 승인 | blocked | 실제 JSON 입력→Review tool call→Approve and run once로 native 승인 대기에 들어갔다. `goal-native-audio-mcp-orbit96-review-no.json`/PNG와 `goal-native-mcp-orbit96-cua-owner-limit.json`. CUA의 실행 앱 목록에서 별도 승인 owner를 찾지 못했고 실제 실행 파일 target 선택도 Invalid app이었다. AioLM의 AX/캡처에는 해당 owner의 Yes/No 컨트롤이 포함되지 않았다. `review-no`는 거부를 준비한 입력의 이름이며 실제 No 클릭 근거가 아니다. 전체 데스크톱의 창 유무나 계정 승인 여부를 이 관찰로 확정하지 않는다. |
| 미응답 승인 deadline·소유 자식 정리 | pass | 기존120 s deadline 뒤 실제 MCP tool approval timed out 안내를 확인했다. `goal-native-audio-mcp-orbit96-timeout.json`/PNG. 해당 승인 대기 세션의 부모·자식 두 peer EOF와 해당 합성 서버의 소유 프로세스 부재, tools-call-start/result0은 `goal-native-mcp-orbit96-lifetime/after-calls-before-observer-stop.json` 및 events/state에서 확인했다. 이후 관측기만 SIGTERM으로 종료했고 `observer-stopped.json`에서 관측기·자체 listener 종료를 확인했다. 관측기의 종료 코드는 의도한 harness 정리이며 제품 실패가 아니다. 관측기 listener 종료를 앱의 도구 listener 종료로 바꾸어 기록하지 않는다. 실제 거부·승인·실행 중 Stop 근거도 아니다. |
| 수정 전 인자·JSON 입력 치환 | fail | 같은 CUA native setValue에서 `--events`·`--run`이 em dash로 바뀌었고 JSON의 닫는 ASCII 따옴표가 curly quote로 바뀌었다. 실제 Review는 JSON Parse error: Unterminated string으로 끝났다. `goal-native-audio-mcp-orbit96-{draft,json-before,json-error-before}.json`/PNG. 수정 전 소스는 `100ed8b`이며 붙여넣기로 정확한 argv를 입력한 도구 조회와 이 CUA native 입력 경로를 구분한다. |
| 수정 후 같은 native 입력·검토 | pass | `bbd2df6`에서 명령·인자·JSON에 spellCheck=false·autoCorrect=off·autoCapitalize=off를 설정했다. 동일 native 입력에서 ASCII 대시·따옴표가 보존되고 JSON 검토 카드가 올바른 값으로 표시됐다. 실제 Cancel로 검토만 닫았다. `goal-native-audio-mcp-orbit96-{json-after,verbatim-after}.json`/PNG와 `goal-native-mcp-orbit96-attributes-label-fixed.json`/로그에서 세 실제 WKWebView DOM 속성과 복원된 원문값을 확인했다. 합성 명령 경로 검사는 저장·실행하지 않았다. 문자열을 ASCII로 정규화하거나 사용자가 명시한 Unicode를 바꾸는 코드는 추가하지 않았다. |
| 원래 앱 상태·저장 자료 보존 | pass | 실제 원래 명령 복원→새 합성 서버 Disabled로 저장→원래 ORBIT-84 Chat으로 돌아왔다. `goal-native-audio-mcp-orbit96-{disabled,restored}.json`/PNG와 `goal-native-mcp-orbit96-servers-after.json`. main config의 전체 SHA256과 검사 전28개 대화의 모든 SHA256이 같고 원래23개도 보존됐다. 별도 MCP 서버 파일에는 새 disabled 등록이 추가됐으므로 이 파일까지 불변이라고 주장하지 않는다. 기존 합성 서버는 enabled로 유지됐다. 같은 Qwen3의 running·API off·active requests0·빈 입력·overlay/렌더 오류0을 확인했다. |

`logs/goal-native-mcp-literal-input-regression-before-20261008.log`는 기존1개 pass·새3개 fail/종료1, 수정 후 `logs/goal-native-mcp-literal-input-regression-after-20261008.log`는 관련2 files/7 tests·종료0이다. 최종 `logs/goal-native-mcp-literal-{typecheck,lint,unit,build}-final.log`는 모두 종료0: typecheck10.14 s·lint5.89 s·unit126.83 s·build12.01 s. 계약/direct/script 검사를 포함해 UI171 files/1700 tests·coverage statements80.27% / branches75.11% / functions78.68% / lines84.41%를 확인했다. 기존500kB chunk 경고는 유지한다. 소스·검사 두 파일만 바꾸었고 Rust/Python·lockfile·공개 API·승인 정책·argv 전달·경로 처리 코드는 유지했다.

첫 DOM 속성 관찰 helper는 label.textContent에 textarea의 내용까지 포함된다는 점을 놓쳐1개 필드만 찾고 실패했다. `logs/goal-native-mcp-orbit96-attributes-after.log`와 원본 helper를 보존했다. 별도의 label-fixed helper는 label의 첫 텍스트 노드를 사용하여 실제 세 필드를 읽기 전용으로 확인했고 종료0이었다. UI 입력·검토 전후 근거와 별개이며 DOM 이벤트나 값을 쓰지 않았다.

수정 방향은 공식 WebKit의 [spellcheck 비활성 처리](https://github.com/WebKit/WebKit/blob/459880fdd40351501295040dd219ef965256dea9/Source/WebCore/editing/Editor.cpp#L2993)와 [비-iOS Quote/Dash 처리](https://github.com/WebKit/WebKit/blob/459880fdd40351501295040dd219ef965256dea9/Source/WebCore/editing/Editor.cpp#L4246)에서도 확인했다. 이 upstream SHA가 설치된 OS의 WebKit 빌드와 같다는 의미는 아니다. 실제 효과는 위 현재 WKWebView의 같은 native 입력 전후 결과로 검증했다. [autocapitalize의 물리 키보드 제한](https://html.spec.whatwg.org/multipage/interaction.html#attr-autocapitalize)도 있으므로 이 속성 하나가 대시 치환을 막았다고 설명하지 않는다.

실제 Yes/No·tools/call·모델 후속 답변·도구 실행 중 Stop은 미검증으로 유지한다. 준비한 hold fixture의 선언을 실제 취소 성공으로 세지 않는다. 그 밖의 21절 미완료 범위와 M04/M07 내용 실패도 유지하며 **전체 M01–M12 검증은 통과하지 않았다.** 공개 업로드·원격 push는 수행하지 않았다.

## 24. MCP 기술 입력 수정 소스 `bbd2df6`의 arm64 DMG

기존 `npm run package:tauri`로 `bbd2df6fbb1b6cb7a992534a523e5b2f1d4203e5`의 CLI·frontend·GUI·DMG를 빌드했다. `logs/goal-native-mcp-literal-package-bbd2df6.log`, `logs/goal-native-mcp-literal-inspect-package-bbd2df6.log`, `goal-native-mcp-literal-package-bbd2df6-results.json`이 근거다. 빌드225.51 s·검사4.114 s 모두 종료0이었고 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- DMG `AioLM_0.3.1_aarch64.dmg`: 16772424 bytes, SHA256 `46da00fe45af1d351d67ad2d60147e5f2c286ce75fcff350ad830322ef9191d2`.
- GUI `aiolm`: arm64, SHA256 `b48f76e3648797ae8c57c90caf301a857552896033752af25c01277907b4aadd`.
- CLI `aiolm-cli`: arm64, SHA256 `70c9749e17b84361fbe58679d4c7d330338e770c022fd93da939a6a20b1ad112`.
- GUI·CLI 해시는 빌드 앱의 바이너리와 일치했다. identifier `com.aiolm.desktop`·version0.3.1·minimum OS13.3 선언을 확인했다. Intel·구형 macOS 실기기 결과로 확대하지 않는다.
- `codesign --verify --deep --strict` pass. GUI·CLI는 ad-hoc/runtime이며 Developer ID 서명·공증은 수행하지 않았다.
- bundle의 일반 파일5개·symlink 없음, 실제 home/repository·음성/PDF/picker/smoke/MCP fixture 문자열의 UTF-8·UTF-16LE/BE 스캔 일치0을 확인했다. 모델·venv·개인 설정·MCP 서버 등록 자료는 포함하지 않았다.
- 기존 파일 없는 별도 새 홈의 packaged CLI에서 onboarding=false·모델/runtime 미선택·격리된 모델 저장소 기본값과 종료0을 확인했다.
- 원본과 해시가 같은 raw DMG 복사본은 `goal-package-bbd2df6/`에 보존했다. 이전 소스별 DMG·로그·원본 모델·대화는 유지했다.

빌드 후 실제 CUA의 원래 Chat을 확인했다. `goal-native-audio-mcp-after-package-bbd2df6.json`/PNG와 `logs/goal-native-mcp-literal-after-package-bbd2df6.log`에서 같은 Qwen3/vllm-metal의 running·API off·active requests0·ORBIT-84·빈 입력·overlay/렌더 오류0과 원본23개 대화 SHA256 보존·총28개를 확인했다. `goal-native-mcp-literal-after-package-preservation-bbd2df6.json`에서 검사 직전28개 대화와 main config의 정확한 보존 및 별도 MCP 서버 파일의 disabled 캡처 일치도 대조했다. 이 개발 앱 검사를 production GUI의 자연스러운 Finder 설치·첫 실행·quarantine·별도 계정 Keychain·실제 upgrade로 확대하지 않는다. 21·23절의 실패·blocked·잔여 범위를 유지하며 **전체 M01–M12는 통과하지 않았다.** raw/build 산출물은 Git 제외 상태이며 원격 push는 수행하지 않았다.

## 25. 실제 Close to tray 설정·숨김·복원

`c8fae57`에서 23절의 수정된 frontend와 기존 native debug 앱을 사용했다. 제품 코드·의존성·기본값은 바꾸지 않았다. 실제 CUA Settings→Server에서 Close to system tray를 off→on으로 저장한 뒤 native 창 닫기 버튼을 눌렀다. UI 조작은 CUA로 수행했고, native window 조회·앱 상태·저장 파일은 읽기 전용으로 관찰했다.

| 실제 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 설정 저장·실제 창 숨김 | pass | `goal-native-tray-window-visible-before-order-fixed-20261008.json`은 baseline과 다른 설정이 close_to_tray 하나임을 확인한다. 실제 닫기 직후 `goal-native-tray-window-hidden-20261008.json`의 is_visible/is_focused=false, 같은 모델 프로세스 running·API off를 확인했다. |
| CUA 재활성화·원래 설정 복원 | pass | `goal-native-tray-window-{reactivated,restored}-20261008.json`에서 같은 앱의 visible/focused=true와 실제 UI off 복원을 확인했다. `goal-native-audio-tray-{baseline,final}-20261008.json`/PNG에서 config 의미·전체 SHA256, 검사 전28개 대화의 모든 SHA256, 실행 모델·프로세스·API off·active requests0이 보존됐다. |
| 트레이 Show/좌클릭/Quit·Dock 클릭 | blocked | SystemUIServer와 Dock의 CUA target 선택이 각각 -10005 timeoutReached로 끝났다. `goal-native-tray-cua-limits-20261008.json`은 해당 도구 응답과 미실행 조작을 기록한다. CUA의 앱 재활성화를 이 네 클릭의 통과로 계산하지 않는다. |

첫 `visible-before-20261008` 관찰 helper는 JSON 문자열의 객체 키 순서를 비교하여 gpu/settings_profiles도 변경으로 잘못 표시했다. 원본 로그·JSON을 보존했고, 객체 의미를 비교하는 별도 order-fixed 결과에서 close_to_tray만 다른 것을 확인했다. 제품 설정 변형이나 제품 수정으로 세지 않는다. CUA AX의 모든 tab 선택 표기도 실제 DOM의 aria-selected와 다르므로 그 표기만으로 앱의 탭 선택 결함을 단정하지 않았다.

## 26. 동일 MLX 공용 프로필의 두 모델·원래 실행 복원

같은 소스에서 기존 외부 MLX 0.7.6 등록을 사용했다. 등록의 소유권은 external이며 Python이 별도 관리형 환경의 실제 venv를 참조한다는 사실과 구분한다. Qwen3와 Gemma4의 loader/processor 모듈 및 실제 서로 다른 model_type를 먼저 확인했다. 새 모델을 다운로드하거나 기존 모델·외부 환경을 변경하지 않았다.

- 모델 A: `mlx-community/Qwen3-VL-2B-Instruct-4bit`, revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`.
- 모델 B: `mlx-community/gemma-4-E2B-it-4bit`, revision `238767527555cb75a05732a84dff5d6ba0dd6809`. 출처·파일 검증은 21절의 고정 자료를 사용했다.
- 실제 UI Save as new로 global 프로필 `Native shared models ORBIT-97`을 만들었다. 기존 음성 검증 프로필과 동일한 enable_thinking=false·max_kv_size4096·max_num_seqs1·max_tokens128·temperature0, 빈 system prompt를 사용했다. runtime/model/credential을 프로필 설정에 넣지 않았다.

| 실제 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 모델 A의 공용 프로필 실행·응답 | pass | 실제 MLX/runtime/프로필 선택→Save profile & start→새 Chat 질문에서 9+8=17의 한국어 응답을 받았다. `goal-native-audio-shared-qwen-mlx-{ready,response}-20261008.json`/PNG, PP53·TG11·PP0.14 s/367.1 tok/s·TG0.17 s/64.4 tok/s. 표시 모델명과 저장 execution이 선택한 Qwen3에 해당했다. |
| 모델 B에 같은 프로필 적용·응답 | pass | A의 실제 Unload 뒤 B 경로를 Load into editor했다. B의 기존 저장 프로필이 먼저 복원되는 것을 확인하고 ORBIT-97을 명시적으로 선택했다. Save profile & start→새 Chat에서 9+8=17의 한국어 응답을 받았다. `goal-native-audio-shared-gemma-{selected,ready,response}-20261008.json`/PNG, PP53·TG27·PP0.16 s/330.3 tok/s·TG0.57 s/47.7 tok/s. |
| 프로필·응답 이력 보존 | pass | `goal-native-shared-profile-independent-audit-20261008T042822640954Z.json`에서 같은 profile ID·global scope·설정·prompt를 확인했다. 정상 저장에 따라 A의 applied revision은2, B는3이며 둘의 설정 내용은 같다. A/B의 MLX 실행 단계에서 이전18개 프로필·기존28개 대화는 그대로였다. `goal-native-audio-shared-qwen-history-20261008.json`/PNG에서 B 실행 중 A의 저장 모델명·응답·PP/TG를 다시 열어 확인했다. |
| catalog 밖 snapshot의 친숙한 이름 자동 해석 | unsupported | B 경로는 UI와 저장 응답의 표시 이름이 revision 해시였다. 기존 displayPaths의 임의 snapshot fallback과 일치한다. config/processor/tokenizer JSON에는 repository 이름이 없고 README 제목을 표시 이름으로 읽는 기능은 구현하지 않았다. 경로의 상위 폴더명이나 base_model로 변환 모델명을 추정하거나 이 검증용 파일에 provenance를 덧붙이지 않았다. 추론·프로필 성공과 이 표시 한계를 구분한다. 당시 결과이며, 명시된 카드 제목의 제한적 표시 지원은 42절에서 후속 수정·검증했다. |
| 원래 vLLM 모델 복원·실제 응답 | pass | B의 실제 Unload 뒤 원래 Qwen3/vllm-metal 0.30/Default·4096 설정을 UI에서 선택·저장/시작했다. `goal-native-audio-shared-{restore-ready,restored-response,final}-20261008.json`/PNG에서 ORBIT-97C의 2+3=5 응답·PP54/TG12·TG0.76 s/14.5 tok/s와 원래 ORBIT-84 화면·빈 입력·API off·active requests0·렌더 오류/overlay0을 확인했다. PP 시간·rate는 미제공이므로 —를 유지했다. |

기존28개 대화는 보존하고 새 합성 A/B/복원 대화3개를 더해 총31개다. 새 공용 프로필·두 MLX binding은 검증 자료로 보존했다. 원래 vLLM 복원의 정상 저장으로 기존 Default 프로필과 해당 binding revision은7→8로 증가했고 설정 내용은 같다. settings_profiles 이외 config 값은 검사 직전과 동일하다. 정상 저장에 따른 프로필·binding revision 증가를 원본 파일 전체 불변으로 설명하지 않는다. 이 순차 실행 검사는 두 모델의 동시 실행이나 두 엔진의 모든 기능 동등성을 증명하지 않는다.

`goal-native-shared-profile-restoration-independent-audit-20261008T043432448217Z.json`은 최종 config와 실제 디스크 일치·기존17개 프로필의 정확한 보존·Default의 revision 이외 값 보존·기존28개와 새3개 응답의 SHA256을 독립 확인했다. 기록된 이전 모델 프로세스4개는 부재했고 이전 loopback 포트3개는 모두 ECONNREFUSED였다. 원래 vLLM의 새 프로세스는 존재하며 running·API off·active requests0을 유지했다. 새 A/B/C 응답의 파일은 각 응답 capture부터 최종 capture·현재 디스크까지 같았다.

25·26절은 21절 당시 남은 범위 중 창 숨김/설정 복원과 동일 엔진 두 모델의 공용 프로필 재사용을 보완한다. MCP native Yes/No→실제 호출/후속 응답/호출 중 Stop, 실제 한글 IME composition, 트레이 Show/Quit·Dock 클릭, 추가 대비/VoiceOver·promised/unreadable clipboard는 여전히 미검증이다. M04/M07의 실제 내용 실패·upstream 제약과 별도 계정/Finder/Keychain/upgrade·Intel/구형 macOS의 unrun도 유지한다. **전체 M01–M12는 통과하지 않았다.** 개인 엔진 manifest·registry·adapter는 별도 장기 설계이며 구현 완료로 계산하지 않았다. 제품 코드·Rust/Python·공개 API·lockfile 변경이 없어 기존 공통 검사를 반복 실행하지 않았다. 최신 제품 소스의 공통 검사와 패키지 근거는 23·24절에 유지한다. raw/build·모델·캡처는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 27. 실제 두벌식 확정 Enter와 미디어 첨부 그룹 수정

`a35defd`의 실제 WKWebView에서 재현한 두 결함을 `47580b8d54428bafee589ecccc96c233d37b88f1`에서 수정했다. 원래 Qwen3/vllm-metal 0.30 실행을 유지했으며 엔진·프로필·모델·승인 정책을 바꾸지 않았다. 읽기 전용 TIS 조회에서 검사 전후 모두 두벌식 한글 source/layout과 활성 ABC keyboard가 같았다. 입력 소스를 전환하거나 OS 설정을 수정하지 않았다.

| 실제 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 수정 전 확정 Enter의 조기 전송 | fail | 실제 CUA의 물리 키 g/k/s/r/m/f로 한글을 조합한 뒤 첫 Return이 즉시 사용자 메시지·응답을 시작했다. `goal-native-ime-orbit98-{composing,first-enter}-20261008.json`, `goal-native-audio-ime-orbit98-beforefix-response-20261008.json`/PNG. native input→keydown229 뒤 같은 값의 insertReplacementText 확정→Enter13/isComposing=false 순서여서 기존 keydown guard를 통과했다. 붙여넣기나 합성 DOM 이벤트로 재현하지 않았다. |
| 최종 소스의 확정·전송 구분 | pass | 같은 물리 키와 첫 Return 뒤 composer는 한글이고 generation=false·active requests0·기존 저장 대화 수/해시를 유지했다. 첫 Enter keyup도 관찰됐다. 두 번째 Return에서 새 사용자/assistant 각1개가 저장되고 실제 답변·usage를 받았다. `goal-native-ime-orbit98-{first-enter-final,second-enter-final,listener-final-stop}-20261008.json`, `goal-native-audio-ime-final-{first-enter,response}-20261008.json`/PNG. 중간 구현의 같은 통과 근거는 별도 afterfix 파일로 보존했다. |
| 포인터 클릭 뒤 일반 전송 | pass | 실제 좌표 클릭의 trusted pointerdown/mousedown 뒤 첫 Return으로 새 사용자/assistant 각1개와 응답을 받았다. `goal-native-ime-orbit98-{pointer-confirmed-native,pointer-first-enter,pointer-listener-stop}-20261008.json`, `goal-native-audio-ime-pointer-response-20261008.json`/PNG. 앞선 AX 입력란 선택만 한 pointer-confirmed 파일에는 포인터 이벤트가 없으므로 해당 조작을 통과 근거로 쓰지 않는다. |
| 수정 전 영상 그룹명 | fail | native Open 창에서 합성 shapes-video.mp4를 선택한 뒤 video preview가 Pending image attachments 그룹에 있었다. `goal-native-media-group-video-before-20261008.json`, `goal-native-audio-media-video-before-20261008.json`/PNG. |
| 수정 후 영상 그룹·제거 | pass | 같은 파일을 실제 Open 창에서 다시 선택하여 Pending media attachments 그룹과 video preview·제거 버튼을 확인했다. 실제 제거 뒤 pending 그룹이 사라지고 빈 입력의 Send가 비활성화됐다. `goal-native-media-group-video-after-20261008.json`, `goal-native-audio-media-video-after-20261008.json`/PNG. 명시적 영상 frame 옵션으로 첨부했고 이후 원래 false·접힌 패널로 복원했다. 이번 표기 검사는 영상 전처리·내용 추론 성공을 추가로 주장하지 않는다. |

관찰된 native 입력 이벤트는 trusted였지만 compositionstart/update/end는0이었다. 실제 두벌식 입력·치환·229/Enter 경계로 확인한 범위를 DOM composition 이벤트 발생으로 설명하지 않는다. 표준 composition 이벤트 순서·늦은 final input/end·held Enter 반복·229/isComposing·영어 Enter·Shift+Enter·Enter 전송 해제·마우스/blur/붙여넣기·빈 draft는 합성 회귀로 검사했다. 다른 OS·입력기 전체의 실제 동작으로 확대하지 않는다.

수정은 Composer의 상태 guard와 네 언어의 미디어 그룹명에 한정했다. 확정 전 Enter는 native 기본 확정을 허용하면서 전송만 막고, 확정된 Enter는 newline도 막는다. keyup 뒤 새 Enter는 정상 전달하며 이미 확정한 포인터/blur 등은 guard를 해제한다. 입력 문자열·공개 API·attachment 타입·엔진 ID·모델 호환성·Rust/Python·lockfile을 바꾸지 않았고 시간 휴리스틱을 추가하지 않았다. 미디어 회귀는 legacy image/audio/video/mixed의 그룹명과 별도 문서 그룹·원본 ref/dataUrl/path 제거 인자를 네 언어에서 확인한다.

수정 전 IME13개 중3개 실패·수정 후 순서 보강 전17개 중6개 실패 원본 로그를 보존했다. 최종 관련 IME4 files/27 tests와 미디어4 files/23 tests는 종료0이다. 근거는 `logs/goal-native-ime-regression-before-20261008.log`, `logs/goal-native-ime-ordering-regression-{before,after}-20261008.log`, `logs/goal-native-media-group-unit-{before,after}-20261008.log`다. 미디어 신규16개는 수정 전 모두 실패했다. `logs/goal-native-ime-media-final-{typecheck,lint,unit,build}-20261008.log`는 모두 종료0: 11.76 s·7.21 s·140.25 s·14.58 s. 계약/direct/script 검사와 UI173 files/1733 tests·coverage statements80.35% / branches75.21% / functions78.83% / lines84.46%를 확인했다. 기존500kB chunk 경고는 유지한다.

실제 검사 후 원래 ORBIT-84 화면·같은 실행 모델·API off·active requests0·빈 입력·렌더 오류/overlay0으로 돌아왔다. `goal-native-audio-ime-media-restored-final-20261008.json`/PNG와 읽기 전용 TIS 결과가 근거다. 검사 전31개 대화를 보존하고 조기 전송 재현·중간 수정·최종 수정·포인터 비교의 합성 대화4개를 더해 총35개를 유지했다. main config 전체 SHA256과 원래 입력 소스는 같다. passive 입력 관측기는 제거했다.

`goal-native-ime-media-independent-audit-20261008T050356764040Z.json`은 첫 Enter의 무저장·최종 native Enter down/up·trusted 포인터·각 새 user/assistant 한 쌍, 기존31개와 새4개 대화의 현재 디스크 SHA256, config·preferences·원래 Chat·입력 소스 복원을 독립 확인했다. 감사 대상5개 제품 파일은 수정 커밋과 같은 바이트였다.

추가 포인터 관찰의 첫 inline helper는 문자열 인용 오류로 JavaScript parse에서 실패했다. `logs/goal-native-ime-pointer-passive-extension-20261008.log`를 보존했고 별도 파일 helper의 `passive-extension-fixed` 로그에서 정상 부착·이후 detach를 확인했다. 제품 실패나 UI 입력 결과로 세지 않는다.

M11의 현재 두벌식 범위를 보완했지만 MCP native Yes/No→실제 호출/후속 응답/호출 중 Stop, 트레이 Show/Quit·Dock 클릭, 추가 대비/VoiceOver·promised/unreadable clipboard·알림 수신은 남아 있다. M04/M07 내용 실패·upstream 제약과 별도 계정/Finder/Keychain/upgrade·Intel/구형 macOS의 unrun도 유지하며 **전체 M01–M12는 통과하지 않았다.** 개인 엔진 registry·manifest·adapter는 장기 설계이며 구현 완료로 계산하지 않았다. raw·모델·캡처는 Git 제외 상태이고 공개 업로드·원격 push는 수행하지 않았다.

## 28. 두벌식·미디어 첨부 수정 소스 `47580b8`의 arm64 DMG

기존 `npm run package:tauri`로 `47580b8d54428bafee589ecccc96c233d37b88f1`의 CLI·frontend·GUI·DMG를 빌드했다. `logs/goal-native-ime-media-package-47580b8.log`, `logs/goal-native-ime-media-inspect-package-47580b8.log`, `goal-native-ime-media-package-47580b8-results.json`이 근거다. 빌드229.57 s·검사4.52 s 모두 종료0이었고 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- DMG `AioLM_0.3.1_aarch64.dmg`: 16773003 bytes, SHA256 `74782223e72dce420f8d7a8362a1a50a10affb6d47c512a0c12a9cf05d83ac02`.
- GUI `aiolm`: arm64, SHA256 `221d7aeae611e524ef369ba73876e04c505d36e67d66231a121117b8bcb07d28`.
- CLI `aiolm-cli`: arm64, SHA256 `1c1b742a8d20c7b9123f0e67ac0122a2c8c608a558f0ad92017d7a1177c07084`.
- GUI·CLI 해시는 빌드 앱과 일치했다. identifier `com.aiolm.desktop`·version0.3.1·minimum OS13.3 선언을 확인했다. Intel·구형 macOS 실제 검증으로 확대하지 않는다.
- `codesign --verify --deep --strict` pass. GUI·CLI는 ad-hoc/runtime이다. Developer ID 서명·공증은 수행하지 않았으며 자연스러운 Finder 설치·quarantine 동작은 unrun이다.
- bundle 일반 파일5개·symlink 없음. 실제 home/repository와 음성·PDF·picker·smoke·MCP·IME/media 관측 fixture 표식의 UTF-8·UTF-16LE/BE 일치0을 확인했다. 개인 설정·모델·venv·서버 등록 자료를 넣지 않았다.
- 기존 파일 없는 새 격리 홈의 packaged CLI에서 onboarding=false·모델/runtime 미선택·격리 모델 저장소 기본값과 종료0을 확인했다.
- 원본과 해시가 같은 raw DMG는 `goal-package-47580b8/`에 보존했다. 이전 패키지·로그·모델·대화는 유지했다.

빌드 후 실제 CUA로 원래 Chat 화면을 재확인했다. `goal-native-audio-ime-media-after-package-47580b8.json`/PNG와 `goal-native-ime-media-after-package-preservation-47580b8.json`에서 검사 직전35개 대화의 전체 SHA256·config 전체 SHA256/의미·localStorage·같은 실행 프로세스 보존을 대조했다. 원래 ORBIT-84·Qwen3/vllm-metal의 running·API off·active requests0·빈 입력·렌더 오류/overlay0을 유지했다. 개발 앱의 이 확인을 production GUI의 자연스러운 Finder 설치·최초 실행·별도 계정 Keychain·실제 upgrade 결과로 바꾸지 않는다. 27절의 잔여 범위와 **전체 M01–M12 미통과** 상태를 유지한다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 29. 다크 화면 대비 표본과 Discover 검색 컨트롤 정렬

`04e8442`에서 실제 Settings의 Theme를 Dark로 선택하고 CUA로 각 화면을 열었다. 원래 Qwen3/vllm-metal 0.30 실행·API off·active requests0을 유지했다. 모든 표본은 실제 Tauri WKWebView이며 외부 브라우저나 viewport emulation을 사용하지 않았다. 데스크톱 native 창은1280×800, web content는1280×768, DPR1이었다. 최소 크기는 실제 창 모서리 drag로360×520/web content360×488을 확인했다.

Discover에서 엔진 선택기의 라벨은 위에, 형식 라벨은 옆에 있고 나머지 컨트롤은 중앙 정렬돼 있었다. 수정 전 엔진·형식·검색·정렬의 web y는194·182·181.75·182.5였다. `e594c57ac6dbba8ec2e08dcdfbaa52dbcbe1d841`은 Discover에 한정하여 라벨을 위로 배치하고 동일한 control size·6px label gap·10px field gap·하단 정렬·줄바꿈을 적용한다. 네 컨트롤의 수정 후 하단은 모두227.5였으며 높이는33/33.5px이었다. 전역 EngineSelect, 엔진·형식 지원 목록, 검색/정렬 callback·submit·busy 의미와 공개 API는 바꾸지 않았다.

| 실제 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 수정 전 desktop toolbar 정렬 | fail | `goal-native-dark-discover-desktop-20261008.json`/PNG에서 라벨과 control y 불일치를 재현했다. |
| 수정 후 desktop toolbar | pass | `goal-native-dark-discover-toolbar-desktop-after-20261008.json`/PNG에서 네 컨트롤 하단 일치와 라벨 배치를 확인했다. 측정 시 HEAD는 수정 직전 커밋이며 해당 working source 두 파일의 SHA256을 독립 감사 파일에 남겼다. 이 바이트가 수정 커밋과 일치한다. |
| 최소 창 Discover | pass | `goal-native-dark-discover-toolbar-narrow-{top,menu}-20261008.json`/PNG. 실제 scroll로 검색 입력·정렬·Search models 버튼에 접근했고 정렬 메뉴의 네 항목·Escape 닫힘을 확인했다. document/body scrollWidth360으로 페이지 가로 넘침이 없었다. 새 검색·다운로드를 실행한 검사는 아니다. |
| 최소 창 Settings·Chat | pass | `goal-native-dark-{settings,chat}-narrow-20261008.json`/PNG. 실제 navigation 열기→Chat 이동, 현재 모델명·빈 composer·disabled Send·응답 영역 scroll을 확인했다. 짧은 Chat 창은 응답/지표 영역을 스크롤해야 하며 모든 값이 동시에 보이는 것으로 설명하지 않는다. 데스크톱 복원 후 실제 응답 모델명·PP50/TG12·TG0.47s/23.4tok/s를 재확인했다. PP 시간/rate는 미제공으로 —를 유지했다. |
| 설정·기록·실행 복원 | pass | `goal-native-dark-restored-final-20261008.json`/PNG와 `goal-native-discover-dark-layout-independent-audit-20261008.json`. System 테마·원래1280×800 창·ORBIT-84 Chat으로 UI 복원했다. config 전체 SHA256·35개 대화의 정확한 목록/전체 SHA256·localStorage 전체가 검사 전과 같고 같은 프로세스의 running·API off·idle·렌더 오류/overlay0을 확인했다. 독립 감사15개 조건은 모두 true다. |

대비 검사는 [WCAG 2.2 Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)의 일반 텍스트4.5:1/큰 텍스트3:1 기준을 사용했다. axe-core4.13.0의 color-contrast 결과와 실제 computed foreground/background·ancestor opacity/filter/blending을 별도로 기록했다. 숨김 `.sr-only`, 닫힌 details, 화면 밖/ancestor clipping 텍스트를 시각 표본에서 제외하고 disabled 텍스트는 inactive로 분리했다. 불투명 RGB linear gradient는 segment별101개 색 표본을 측정했으며 모든 기록 표본의 최저 비율은4.850676 이상이었다. 이 샘플링을 모든 gradient 지점이나 전체 접근성의 증명으로 사용하지 않는다.

| 실제 화면·raw phase | 기준 이상 시각 텍스트 표본 | inactive | axe 위반 / incomplete |
| --- | ---: | ---: | ---: |
| Chat `chat-desktop-refined-20261008` | 78 | 0 | 0 / 26 |
| Projects `projects-desktop-20261008` | 76 | 0 | 0 / 34 |
| Run a model `models-desktop-20261008` | 78 | 4 | 0 / 54 |
| Discover 수정 전 `discover-desktop-20261008` | 72 | 0 | 0 / 48 |
| Discover 수정 후 `discover-toolbar-desktop-after-20261008` | 74 | 0 | 미실행 |
| Manage runtimes `runtimes-desktop-20261008` | 56 | 1 | 0 / 28 |
| Loaded sessions `sessions-desktop-20261008` | 35 | 0 | 0 / 25 |
| Benchmark `benchmark-desktop-20261008` | 78 | 1 | 0 / 42 |
| API server `api-desktop-20261008` | 44 | 0 | 0 / 23 |
| MCP servers `mcp-desktop-20261008` | 48 | 0 | 0 / 31 |
| Diagnostics `diagnostics-desktop-20261008` | 34 | 0 | 0 / 21 |
| Settings Appearance `appearance-final-20261008` | 47 | 0 | 0 / 25 |
| 최소 Settings `settings-narrow-20261008` | 14 | 0 | 0 / 2 |
| 최소 Chat `chat-narrow-20261008` | 12 | 0 | 0 / 6 |

각 phase의 `goal-native-dark-*.json`/PNG, `goal-native-dark-contrast-*.json`, `goal-native-dark-measure-*.json`과 별도 runner 로그를 보존했다. Chat axe 결과는 visibility collector 보정 전 `chat-desktop-20261008`의 실제 audit다. 초기 수동 Chat118표본에는 숨김 텍스트가 포함돼 있어 최종78표본으로 대체했고 원본을 남겼다. initial Appearance의 null heading/sourceCommit도 원본 관측기의 한계이며 final capture에 보완했다. placeholder·pseudo content 전체, 모든 scroll 위치·popover·언어·상태·VoiceOver는 검증하지 않았다. **대비 표본은 pass지만 전체 대비/접근성 검증은 unrun 잔여 범위가 있고 axe incomplete를 pass로 바꾸지 않는다.**

관련 Discover/CustomSelect2 files/45 tests와 `logs/goal-discover-toolbar-{typecheck,lint,unit,build}-20261008.log` 모두 종료0이다. 공통 검사 시간은9.97s·7.33s·134.98s·15.50s, UI173 files/1733 tests, coverage80.35/75.21/78.83/84.46%였다. 기존 jsdom pseudo-element/canvas 진단과500kB chunk 경고는 유지한다. 순수 배치 변경은 기존 의미 회귀와 실제 rendered geometry로 확인했으며 CSS class/값만 복제하는 신규 테스트를 추가하지 않았다. Rust/Python·lockfile은 변경하지 않았다.

27절의 실제 실패·upstream 제한·blocked/unrun 항목과 **전체 M01–M12 미통과** 상태는 유지한다. 개인 엔진의 자유로운 교체는 [장기 설계](pluggable-inference-runtimes.ko.md)의 registry·versioned manifest/protocol adapter·model-resolved capability로 구현해야 하며 이번 배치 수정은 해당 기능의 구현이 아니다. raw·모델·캡처는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 30. Discover 수정 소스 `e594c57`의 arm64 DMG

기존 `npm run package:tauri`로 `e594c57ac6dbba8ec2e08dcdfbaa52dbcbe1d841`의 CLI·frontend·GUI·DMG를 빌드했다. `logs/goal-native-discover-package-e594c57.log`, `logs/goal-native-discover-inspect-package-e594c57.log`, `goal-native-discover-package-e594c57-results.json`이 근거다. 빌드229.95s·검사4.75s 모두 종료0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16772268 bytes, SHA256 `9d844186e078c8ff846e78f64407c9379dec383cf440c23473cb35ae161ceb44`.
- GUI `aiolm`: arm64, SHA256 `728c4cd6ab8d75521fc9510d0fbf25afd0452b77af21c31d71cd4585b4836235`.
- CLI `aiolm-cli`: arm64, SHA256 `794689cd0c1aa78e6b381cf6fb7e25635820b6063bef29e53b31629996020f2c`.
- GUI·CLI 해시와 빌드 앱 일치, 일반 파일5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE의 개인 home/repository 경로와 검증 fixture 표식 일치0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료0을 확인했다.
- 원본과 같은 해시의 DMG를 `goal-package-e594c57/`에 보존했다. 이전 패키지·로그·모델은 유지했다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·upgrade는 unrun이며 Intel/구형 macOS 실제 결과도 추정하지 않는다.

빌드 후 실제 CUA 화면과 `goal-native-dark-postpackage-e594c57.json`/PNG, `goal-native-discover-postpackage-preservation-e594c57.json`에서 원래 System 테마/Chat/창 크기·config 전체 SHA256·35개 대화의 전체 목록/해시·localStorage 전체·같은 모델 프로세스의 running/API off/idle·렌더 오류0을 재확인했다. `goal-native-discover-dark-layout-committed-source-20261008.json`은 실제 배치 관측 파일의 source SHA256과 수정 커밋 두 파일의 정확한 일치를 확인한다. 29절의 남은 범위와 **전체 M01–M12 미통과** 상태를 유지한다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 31. 수동 MCP 호출의 진행·취소·결과 소유권

수정 전 실제 WKWebView에서 `Approve and run once`를 누르면 검토 카드가 사라지고 대기 중 진행 표시·취소 버튼이 남지 않는 제품 결함을 재현했다. 합성 MCP 서버와 자식 프로세스는 Chat 이동 후에도 살아 있었고 기존 120초 네이티브 승인 제한 시간이 끝난 뒤 종료됐다. 앱은 탭 이동 때 패널을 숨겨 유지하므로 이 관측을 실제 component unmount나 성공한 취소로 기록하지 않는다. `goal-native-audio-mcp-orbit99-before-call-20261008.json`/PNG, `goal-native-mcp-orbit99-before-unmount-lifetime-20261008.json`, `goal-native-mcp-orbit99-before-deadline-cleanup-20261008.json`에 원본을 보존했다. 두 번째 대기 관측도 승인 제한 시간 종료로 끝났으며 취소 근거에서 제외한다.

수정은 기존 `mcp_cancel_tool_call`과 선택적 call ID 계약을 사용한다. 호출별 UUID와 공통 task를 등록하고 MCP 화면에는 진행·로컬 취소, 숨겨진 다른 화면에는 공용 취소를 제공한다. 서버 선택/새 draft/실제 unmount는 해당 호출을 취소하며 이전 결과가 새 선택에 표시되지 않게 한다. 취소 전송 실패는 원래 대기가 끝나지 않았다면 재시도할 수 있고, 취소한 호출은 session approval로 기억하지 않는다. 승인 정책·native timeout·도구 RPC 계약·엔진 API는 변경하지 않았다. 개인 엔진 교체 방향에 맞춰 이 동작은 엔진 ID 분기 없이 공통 작업 계층에 남는다.

| 실제 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 수정 전 취소·진행 UI | fail | 실제 승인 대기에서 control 부재와 소유 peer 생존을 재현했다. 기존 제한 시간의 정리를 취소 성공으로 바꾸지 않았다. |
| 다른 화면의 공용 취소 | pass | 실제 MCP 승인 대기→Chat 이동→공용 Cancel→Cancelled. `goal-native-audio-mcp-orbit99-global-pending-20261008.json`/PNG와 `goal-mcp-orbit99-global-{pending,cancelled}-lifetime-20261008.json`. 취소 전 소유 peer 2개와 승인 프로세스 1개, 취소 후 peer EOF/close·각 PID/승인 PID 부재를 확인했다. 호출 준비 시작 약 37초 이내 정리이며 120초 deadline 정리가 아니다. |
| 화면의 로컬 취소 | pass | 최종 위치의 진행 카드·Cancel이 실제 1280×800 화면 안에 표시됐다. `goal-native-audio-mcp-orbit99-local-visible-20261008.json`/PNG와 `goal-mcp-orbit99-local-visible{,-cancelled}-lifetime-20261008.json`. 실제 Cancel로 호출 준비 시작 약 30초 이내 소유 peer·승인 PID 부재와 Cancelled를 확인했다. 최초 위치의 footer 가림 관측도 남겼으며 최종 배치는 도구 목록 위에서 초점을 받는다. |
| 서버 변경·실제 unmount·늦은 결과·취소 실패 재시도 | pass | 합성 component 회귀 검사 범위다. actual unmount를 단순한 탭 이동과 구분한다. 네이티브 서버 변경 여정 전체를 실행한 결과는 아니다. |
| 승인 Yes/No 이후 실제 tools/call·모델 후속 응답 | blocked | 이 검사의 native approval owner를 CUA로 제어하지 못했다. fixture의 tools/call 시작/결과는 모두 0이다. 승인 대기 취소를 실제 tool 실행 중 취소·정상 결과·모델 후속 응답의 통과로 계산하지 않는다. |
| 사용자 데이터·환경 복원 | pass | `goal-mcp-orbit99-restoration-20261008.json`, `goal-mcp-orbit99-existing-servers-verified-20261008.json`, `goal-native-audio-mcp-orbit99-restored-20261008.json`/PNG. 이번 검사 전과 같은 config 전체 SHA256·35개 대화의 전체 목록/해시·localStorage·같은 running 모델 PID·API off·렌더 오류/overlay 0을 확인했다. 기존 두 서버 정의는 정확히 유지하고 추가한 합성 서버만 UI로 disabled 저장했다. |

Lifetime observer의 listener는 제품이 소유한 port가 아니라 검사 관측용이다. 전체 14개 peer connection의 remote-end/closed·socketError=false를 먼저 확인한 뒤 관측기만 SIGTERM으로 종료했다. observer runner의 종료 -15는 이 명시적 검사 정리이며, `goal-mcp-orbit99-observer-stopped-20261008.json`에서 listener·PID 부재를 별도로 확인했다. 관측기 종료를 제품 정리 근거로 사용하지 않았다.

`Mcp.calls.test.tsx`의 8개 회귀는 call ID/작업 소유권, 취소 결과 폐기, 숨겨진 패널의 공용 취소, 서버 선택, 실제 unmount, 전송 실패 재시도, 정상 결과와 취소한 session approval, 종료 후 늦은 취소 전송 실패를 검사한다. 마지막 경우는 최초 구현에서 종료된 task가 running으로 되살아나는 합성 실패를 재현해 settled guard로 수정했다. 관련 MCP/TaskStrip 4 files/29 tests는 종료 0이며 기존 경로·native payload 검사를 유지했다. 수정 전 최초 6개 회귀 실패 로그와 수정 후 로그, `goal-mcp-orbit99-late-cancel-response-before-20261008.log`의 1 fail/7 pass와 `goal-mcp-orbit99-late-response-related-final-20261008.log`를 모두 보존했다. 실제 승인 대기 취소 관측은 이 마지막 오류 응답 guard 추가 전이며, guard가 다루는 지연 실패 순서는 합성 검사 근거다. `TaskCancellation.test.tsx`라는 독립 파일은 존재하지 않아 command 인자 자체를 추가 검사 실행으로 계산하지 않는다.

수정 소스는 `7afc07e5893020baa808fa2032001d63a35edf4a`다. `goal-mcp-orbit99-source-delta-20261008.json`과 `goal-mcp-orbit99-committed-source-20261008.json`에서 실제 관측 당시 소스와 마지막 합성 guard 차이, 최종 5개 파일과 커밋 바이트의 정확한 일치를 확인했다. `logs/goal-mcp-orbit99-settled-{typecheck,lint,unit,build}-20261008.log` 모두 종료 0이며 각각 14.30s·8.66s·134.61s·17.75s다. 전체 UI 174 files/1741 tests, coverage 80.41/75.26/78.89/84.52%다. jsdom pseudo-element/canvas 진단과 500kB chunk 경고는 유지한다. Rust/Python·lockfile은 변경하지 않았다. 마지막 guard 후 실제 앱 상태도 `goal-native-audio-mcp-orbit99-settled-restored-20261008.json`/PNG에서 config·35개 대화·localStorage·같은 running 모델과 API off·오류/overlay 0 보존을 재확인했다. 패키지 검사 결과는 다음 절에 기록한다. 27–30절의 실제 실패·upstream 제한·blocked/unrun과 **전체 M01–M12 미통과**는 유지한다. 개인 엔진 자유 등록은 [장기 런타임 설계](pluggable-inference-runtimes.ko.md)의 미구현 목표이며 이번 MCP 수정으로 구현된 기능은 아니다. 공개 업로드·원격 push는 수행하지 않았다.

## 32. MCP 수정 소스 `7afc07e`의 arm64 DMG

기존 `npm run package:tauri`로 `7afc07e5893020baa808fa2032001d63a35edf4a`의 CLI·frontend·GUI·DMG를 빌드했다. `logs/goal-native-mcp-package-7afc07e.log`, `logs/goal-native-mcp-inspect-package-7afc07e.log`, `goal-native-mcp-package-7afc07e-results.json`이 근거다. 빌드 232.49s·검사 5.38s 모두 종료 0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16773114 bytes, SHA256 `1bdf5557dcf445a9dad462a194efb93c3067ae532cc80dd264442eb2fcdedc05`.
- GUI `aiolm`: arm64, SHA256 `d3e6a72c46de26388d315d86c8593e77751fc1b659a7348621b870a3de00b867`.
- CLI `aiolm-cli`: arm64, SHA256 `bbd5bca532e19f1073d21dd40efefd82e9ac1eff25bd47d77f61a6882145a310`.
- GUI·CLI 해시와 빌드 앱 일치, 일반 파일 5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE의 개인 home/repository 경로와 검증 fixture 표식 일치 0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료 0을 확인했다.
- 원본과 같은 해시의 DMG를 `goal-package-7afc07e/`에 보존했다. 기존 패키지·원본·모델·로그는 유지했다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade는 unrun이며 Intel/구형 macOS 실제 결과도 추정하지 않는다.

패키지 생성 후 실제 CUA 앱 상태와 `goal-native-audio-mcp-orbit99-postpackage-7afc07e.json`/PNG, `goal-mcp-orbit99-postpackage-preservation-7afc07e.json`에서 config 전체 SHA256·35개 대화의 전체 목록/해시·localStorage·같은 running 모델 PID·API off·렌더 오류/overlay 0 보존을 재확인했다. 31절의 네이티브 도구 승인 이후 blocked 범위와 기존 실제 실패·upstream 제한·unrun, **전체 M01–M12 미통과**를 유지한다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 33. MCP 도구 검색의 서버 선택·요청 소유권

`d76175b`에서 실제 WKWebView의 합성 A 서버 검색을 대기시킨 뒤 B 서버를 선택했다. A의 성공 응답을 반환하자 B의 이름·명령 아래에 A의 `synthetic_echo_orbit100`/`synthetic_hold_orbit100`과 Prepare call이 표시되는 제품 결함을 재현했다. B의 검색 버튼도 A 요청이 끝날 때까지 Discovering/disabled였다. 등록·검색·선택은 실제 CUA 입력으로 수행했고 합성 서버의 gate는 서버 응답 순서만 제어했다. 가짜 IPC·DOM 상태 변경이나 실제 도구 실행으로 재현하지 않았다.

수정 소스는 `25d71a59c322faf71c88f837c9525fb0e5907669`다. 서버 선택·새 draft·실제 unmount에서 검색 세대를 폐기하고 새 요청마다 세대를 발급한다. 현재 요청만 도구 목록·성공 안내·오류·로딩 상태를 변경한다. 선택을 바꾸면 이전 검색 로딩을 해제해 새 서버를 즉시 검색할 수 있다. backend 검색의 기존 응답/15초 RPC 제한 시간과 stdio process-group 정리는 유지했다. UI가 결과를 폐기하는 것을 네이티브 요청 취소로 설명하지 않는다. 기존 수동 호출·승인·취소, 엔진·공개 API·타입·기본값·Windows/Linux 계약·lockfile은 변경하지 않았다.

| 실제 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 수정 전 다른 서버 도구 표시 | fail | `goal-native-audio-mcp-discovery-orbit100-before-stale-20261008.json`/PNG에서 B 이름과 A의 도구 이름/Prepare call을 함께 확인했다. `goal-mcp-discovery-orbit100-before-release-20261008.json`은 서버를 바꾼 뒤에도 대기 중인 A의 소유 peer 2개를 기록한다. |
| 수정 후 선택 전환·늦은 성공 | pass | 실제 A Discovering→B 선택에서 B의 Discover tools가 즉시 enabled로 바뀌었다. 이후 A 성공 응답에도 B의 빈 도구 영역이 유지됐다. `goal-mcp-discovery-orbit100-after-switch-pending-20261008.json`, `goal-native-audio-mcp-discovery-orbit100-after-stale-success-20261008.json`/PNG. |
| 이전 서버의 늦은 오류 | pass | 실제 A 검색 대기→B 선택→합성 서버 오류 응답에서 B에 오류/도구/성공 안내가 생기지 않았다. `goal-mcp-discovery-orbit100-v2-error-pending-20261008.json`, `goal-native-audio-mcp-discovery-orbit100-after-stale-error-v2-20261008.json`/PNG와 응답 전 `tools-list-error` marker가 근거다. |
| 현재 서버 오류·정상 재시도 | pass | 현재 A 검색 실패의 MCP action failed를 확인한 뒤 실제 Discover tools 재시도에서 A의 도구 두 개와 완료 안내를 받았다. `goal-native-audio-mcp-discovery-orbit100-current-{error,retry}-v2-20261008.json`/PNG. selected A와 해당 도구의 실제 rendered 배치도 스크롤 후 확인했다. 도구 조회를 tools/call 성공으로 세지 않는다. |
| 새 draft·같은 서버 재선택·새 요청 중 이전 finally | pass | `Mcp.discovery.test.tsx`의 합성 회귀 범위다. 새 draft 뒤 늦은 성공/실패 폐기, 같은 ID 재선택 후 옛 요청 폐기, 새 서버 검색 중 옛 요청 종료가 새 로딩을 해제하지 않음을 검사했다. 이 세 경우의 전체 네이티브 여정을 실행한 결과는 아니다. |
| 소유 프로세스·외부 자원 | pass | `goal-mcp-discovery-orbit100-final-lifetime-source-20261008.json`에서 8개 검색 세션의 parent/descendant 총 16개 연결이 remote-end/close·socketError=false였고 모든 소유 PID 부재를 확인했다. 실제 tools-call-start/result는 0이다. 이 정리는 각 응답 후 기존 backend close_session의 결과이며 선택 시 취소가 아니다. observer listener는 검사 소유 port로 따로 종료했다. |
| 사용자 데이터·환경 복원 | pass | `goal-mcp-discovery-orbit100-restoration-20261008.json`, `goal-mcp-discovery-orbit100-inventory-audit-20261008.json`, `goal-native-audio-mcp-discovery-orbit100-restored-20261008.json`/PNG. baseline과 config 전체 SHA256·35개 대화의 전체 목록/해시·localStorage·같은 running 모델 PID·API off·렌더 오류/overlay 0이 같았다. 기존 세 서버 정의는 정확히 유지했고 새 합성 서버만 disabled로 UI 저장했다. |

첫 검증 fixture는 오류 marker를 stdout 응답 뒤에 써서, 앱이 응답을 받고 소유 프로세스를 정리할 때 marker가 기록되지 않을 수 있었다. 최초 observer 감사의 2개 오류 marker 수 검사가 실패한 것을 제품 실패나 pass로 바꾸지 않는다. `goal-mcp-discovery-orbit100-first-observer-audit-20261008.json`과 v1 fixture/첫 UI 오류·재시도 캡처를 보존했고, 오류 marker를 응답 전에 기록한 v2에서 늦은 오류·현재 오류·재시도를 다시 실행했다. 최종 side channel에는 성공 marker 4개·v2 오류 marker 2개, 전체 tools/list 8개가 있다. marker가 없던 v1 오류 두 개를 side channel에서 관측한 것으로 세지 않는다.

모든 제품 UI 동작은 CUA로 수행했다. Browser plugin이 제공되지 않아 실제 Tauri WKWebView와 읽기 전용 WebDriver 상태/캡처를 사용했다. `localhost:1420`, native 1280×800·web 1280×768에서 page identity·의미 있는 내용·Vite overlay 부재·수집된 render error 0·실제 interaction·PNG를 확인했다. 이번 수정은 배치 변경이 아니며 다른 viewport/모든 scroll·popover/언어/상태의 레이아웃 통과로 확대하지 않는다. 29절의 최소 창·다크 배치 근거와 한계를 유지한다.

수정 전 새 회귀 6 fail/1 pass, 수정 후 관련 5 files/36 tests 종료 0이다. `logs/goal-mcp-discovery-orbit100-{regression-before,related-after}-20261008.log`에 보존했다. 최종 `logs/goal-mcp-discovery-orbit100-{typecheck,lint,unit,build}-20261008.log`는 모두 종료 0이며 각각 14.49s·8.89s·134.98s·17.85s, 전체 UI 175 files/1748 tests·coverage 80.52/75.28/78.91/84.66%다. 기존 jsdom pseudo-element/canvas 진단과 500kB chunk 경고는 유지한다. `goal-mcp-discovery-orbit100-independent-source-ui-audit-20261008.json`은 실제 전후 상태와 관측 소스 두 파일/수정 커밋의 정확한 바이트 일치를 확인했다.

전체 peer 종료 후 살아 있는 observer process의 명령을 확인해 해당 관측기만 SIGTERM으로 종료했다. runner 종료 -15는 명시적인 검사 정리이며 `goal-mcp-discovery-orbit100-observer-stopped-20261008.json`에서 observer PID/listener 부재를 확인했다. 외부 파일·원래 서버·모델·대화는 삭제하지 않았다. 27–32절의 실제 실패·upstream 제한·blocked/unrun과 **전체 M01–M12 미통과**는 유지한다. 개인 엔진의 자유 등록은 미구현 장기 설계다. 공개 업로드·원격 push는 수행하지 않았다.

## 34. MCP 검색 수정 소스 `25d71a5`의 arm64 DMG

기존 `npm run package:tauri`로 `25d71a59c322faf71c88f837c9525fb0e5907669`의 CLI·frontend·GUI·DMG를 빌드했다. `logs/goal-native-mcp-discovery-package-25d71a5.log`, `logs/goal-native-mcp-discovery-inspect-package-25d71a5.log`, `goal-native-mcp-discovery-package-25d71a5-results.json`이 근거다. 빌드 225.65s·검사 4.35s 모두 종료 0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16773242 bytes, SHA256 `d9c06a53cc5fc4bb8910c6733e49e92ca6389c7dfc452d2defe7462779b530e2`.
- GUI `aiolm`: arm64, SHA256 `c718bb39d6733b138d497103561f5d9e23a75cea72d71e678e44274287fc0bc1`.
- CLI `aiolm-cli`: arm64, SHA256 `794689cd0c1aa78e6b381cf6fb7e25635820b6063bef29e53b31629996020f2c`.
- GUI·CLI 해시와 빌드 앱 일치, 일반 파일 5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE의 개인 home/repository 경로와 검증 fixture 표식 일치 0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료 0을 확인했다.
- 원본과 같은 해시의 DMG를 `goal-package-25d71a5/`에 보존했다. 기존 패키지·모델·로그는 유지했다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade는 unrun이며 Intel/구형 macOS 실제 결과도 추정하지 않는다.

패키지 생성 후 실제 CUA Chat 화면과 `goal-native-audio-mcp-discovery-orbit100-postpackage-25d71a5.json`/PNG, `goal-mcp-discovery-orbit100-postpackage-preservation-25d71a5.json`에서 config 전체 SHA256·35개 대화의 전체 목록/해시·localStorage·같은 running 모델 PID·API off·idle·빈 composer·렌더 오류/overlay 0 보존을 재확인했다. 33절의 검색 조회 통과를 도구 실행 통과로 확대하지 않는다. 기존 실제 실패·upstream 제한·blocked/unrun과 **전체 M01–M12 미통과**는 유지한다. 개인 엔진 manifest/adapter 등록은 장기 설계이며 아직 구현되지 않았다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 35. MCP 서버 정의 변경 후 메타데이터·승인·호출 소유권

`4d741e6`에서 실제 UI로 합성 서버의 alpha 정의를 등록·조회·검토한 뒤 실행 인수를 beta로 바꿔 저장했다. 저장된 command preview/인수는 beta였지만 Tools의 alpha 메타데이터·JSON editor·alpha 승인 검토 카드가 남는 제품 결함을 재현했다. `goal-native-audio-mcp-definition-orbit101-before-{stale,visible}-20261008.json`/PNG가 근거다. visible 캡처는 beta preview와 alpha 도구·승인 카드 상단을 함께 보여 주며 모든 승인 버튼이 한 viewport 안에 보였다는 의미는 아니다. 합성 fixture는 stdio 메타데이터만 제공하며 도구 실행이나 network listener를 만들지 않는다.

수정 소스는 `91ffd3d53f886476454b044fe13cde456b5b9119`다. 실행 파일·인수·enabled 상태를 바꾸는 저장 시작 시 이전 검색 세대·선택 세대·도구·검토·결과·해당 서버의 기억된 승인을 폐기하고 기존 호출의 취소를 요청한다. 저장이 실패해도 폐기한 메타데이터를 되살리지 않으며 실제로 저장된 정의를 다시 조회할 수 있다. 이름만 변경하거나 실행 정의가 같은 재저장은 현재 메타데이터·검토를 유지한다. 다른 서버의 승인 기억은 보존한다. 저장 중 중복 쓰기·검색·도구 준비/검토/승인을 막고, 늦은 저장 성공·실패가 새 선택이나 새 draft의 선택 ID·안내·오류를 덮지 않게 한다. 반환된 inventory는 반영하되 editor의 새 선택은 유지한다. 공통 엔진 분기·native 승인/취소 RPC·timeout·공개 API·타입·기본값·Rust/Python·lockfile은 변경하지 않았다.

| 검증 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 수정 전 저장 후 이전 메타데이터·검토 잔류 | fail | beta 정의 저장 후 alpha 도구와 승인 검토 카드가 남았다. 실제 CUA 등록·검색·검토·수정·저장으로 재현했으며 fake IPC/DOM 변경은 사용하지 않았다. |
| 수정 후 정의 변경·재조회 | pass | 실제 beta 조회·검토→alpha 인수 저장에서 Tools가 비고 검토/JSON editor가 사라졌다. 재조회는 alpha 메타데이터를 반환했다. `goal-native-audio-mcp-definition-orbit101-after-{before-save,clear}-20261008.json`/PNG와 fixture side channel이 근거다. |
| 정의가 같은 재저장·비활성화 | pass | 실제 alpha 메타데이터·검토를 가진 같은 정의의 재저장은 상태를 유지했다. enabled=false 저장은 메타데이터·검토를 폐기하고 Discover tools를 disabled로 만들었다. `goal-native-audio-mcp-definition-orbit101-{unchanged,disabled}-20261008.json`/PNG. 이름만 변경하는 경우는 합성 회귀 근거다. |
| 변경 저장으로 네이티브 승인 대기 취소 | pass | 실제 Approve and run once→네이티브 승인 대기에서 합성 MCP owner와 해당 승인 process 생존을 확인했다. beta 인수 저장 후 Cancelled·빈 Tools와 두 PID 부재를 확인했다. `goal-mcp-definition-orbit101-call-{pending,cancelled}-20261008.json`, `goal-native-audio-mcp-definition-orbit101-call-cancelled-20261008.json`/PNG. call metadata 응답 약 31.15초 후 부재이며 기존 120초 approval deadline 정리가 아니다. native Yes/No 응답이나 tools/call 실행 중 취소 결과는 아니다. |
| 저장 실패·늦은 응답·승인 기억·중복 저장 | pass | `Mcp.definition.test.tsx`의 합성 13개 회귀 범위다. 명령/인수/enabled 변경, name-only 보존, 실패 후 재검색, pending 검색 결과 폐기, 이전 승인/결과 폐기와 다른 서버 승인 보존, owned call 취소, 늦은 저장 성공/실패·새 draft 보존, 저장 중 준비/검색/승인·중복 쓰기 방지를 검사했다. 이 비동기 순서 전체를 실제 네이티브에서 실행한 것으로 세지 않는다. |
| 소유 자원·외부 데이터 | pass | `goal-mcp-definition-orbit101-source-ui-audit-20261008.json`은 fixture의 다섯 stdio session process PID 부재와 unexpected method 0을 확인한다. 네 번의 조회와 한 번의 호출 준비용 조회이며 실제 tools/call은 0이다. fixture는 자식·listener를 생성하지 않으므로 이 검사를 새로운 descendant/port 정리 검증으로 확대하지 않는다. |
| 기존 환경 복원 | pass | `goal-mcp-definition-orbit101-restoration-20261008.json`, `goal-native-audio-mcp-definition-orbit101-restored-20261008.json`/PNG. baseline과 config 전체 SHA256·35개 대화 목록/해시·localStorage·같은 running 모델 PID·API off·idle·빈 composer·render error/overlay 0이 같다. 기존 네 서버는 정확히 유지하고 이번 합성 서버만 disabled로 UI 저장했다. MCP 정의 파일 전체가 변경되지 않은 것으로 설명하지 않는다. |

Browser plugin이 제공되지 않아 실제 Tauri WKWebView `localhost:1420`과 CUA 입력·읽기 전용 WebDriver 상태/PNG를 사용했다. native 1280×800·web 1280×768에서 의미 있는 앱 내용·실제 interaction·수집된 render error/overlay 0을 확인했다. HMR 후 패널 상태가 초기화된 것을 수정 통과로 세지 않고, 저장된 beta 서버를 다시 선택·조회·검토한 뒤 변경 저장을 재실행했다. 이번 변경은 CSS 배치 수정이 아니며 다른 viewport·모든 scroll/popover·언어·VoiceOver의 통과로 확대하지 않는다. 최초 관측 감사 helper가 input의 aria-label을 가정해 실패한 것은 관측기 오류다. 실제 wrapped-label 입력은 그 속성이 없어 고유 합성 인수 값과 도구 설명·검토 카드의 존재를 읽는 감사로 보완했으며 제품 상태나 UI를 변경하지 않았다.

수정 전 최초 10개 회귀는 9 fail/1 pass, 수정 후 관련 MCP/TaskStrip 6 files/46 tests 종료 0이다. 후속 3개 회귀를 추가한 최종 전체 UI는 176 files/1761 tests·coverage 80.59/75.34/78.98/84.72%다. `logs/goal-mcp-definition-orbit101-{regression-before,related-after,typecheck,lint,unit,build}-20261008.log`에 보존했다. typecheck·lint·unit·build는 모두 종료 0이며 각각 15.15s·9.21s·136.97s·18.36s다. 기존 jsdom pseudo-element/canvas 진단과 500kB chunk 경고는 유지한다. `goal-mcp-definition-orbit101-committed-source-20261008.json`은 관측 소스 두 파일과 수정 커밋의 정확한 바이트 일치를 확인한다.

34절까지 남은 실제 실패·upstream 제한·blocked/unrun과 **전체 M01–M12 미통과**를 유지한다. 승인 대기 취소 통과를 native Yes/No→실제 도구 호출→모델 후속 응답의 통과로 바꾸지 않는다. 개인 엔진 registry·manifest·adapter는 미구현 장기 설계다. 공개 업로드·원격 push는 수행하지 않았다.

## 36. MCP 정의 변경 수정 소스 `91ffd3d`의 arm64 DMG

기존 `npm run package:tauri`로 `91ffd3d53f886476454b044fe13cde456b5b9119`의 CLI·frontend·GUI·DMG를 빌드했다. `logs/goal-native-mcp-definition-package-91ffd3d.log`, `logs/goal-native-mcp-definition-inspect-package-91ffd3d.log`, `goal-native-mcp-definition-package-91ffd3d-results.json`이 근거다. 빌드 230.16s·검사 3.28s 모두 종료 0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16774584 bytes, SHA256 `bfe15b4a02ffda541afffc812e35e9fe912b5d808c6b39035b98f5175a54dd9a`.
- GUI `aiolm`: arm64, SHA256 `9deaa38aaab0e7f32da06be058593c497d66901e9774668cdd03b00f651a7a3b`.
- CLI `aiolm-cli`: arm64, SHA256 `e64f24ca44c8108a9612144fe7d09db33b63fef740946dd71b1d160a196fa98d`.
- GUI·CLI 해시와 빌드 앱 일치, 일반 파일 5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE의 개인 home/repository 경로와 검증 fixture 표식 일치 0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료 0을 확인했다.
- 원본과 같은 해시의 DMG를 `goal-package-91ffd3d/`에 보존했다. 기존 패키지·모델·로그는 유지했다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade는 unrun이며 Intel/구형 macOS 실제 결과도 추정하지 않는다.

패키지 생성 후 실제 CUA Chat 화면과 `goal-native-audio-mcp-definition-orbit101-postpackage-91ffd3d.json`/PNG, `goal-mcp-definition-orbit101-postpackage-preservation-91ffd3d.json`에서 config 전체 SHA256·35개 대화의 목록/해시·localStorage·같은 running 모델 PID·API off·idle·빈 composer·render error/overlay 0과 복원된 MCP inventory 보존을 재확인했다. 이 화면의 모델명·TG와 PP 미제공 표시는 기존 응답의 재표시이며 이번에 새 추론을 실행한 결과가 아니다. 35절의 취소 통과를 승인 이후 도구 실행 통과로 확대하지 않는다. 기존 실제 실패·upstream 제한·blocked/unrun과 **전체 M01–M12 미통과**는 유지한다. 개인 엔진 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 37. Gemma4 음성 내용 실패의 system prompt 대조와 기존 실행 복원

`7d71937`의 native debug 앱에서 21절과 같은 MLX 0.7.6·Gemma4 revision `238767527555cb75a05732a84dff5d6ba0dd6809`·합성 WAV를 재검증했다. WAV는 98524 bytes, SHA256 `12835978d06f128b0e9086c5bd1c2d2eee5bce05dcb186b11c8d1fd26a37476c`다. 기존 음성 프로필의 temperature=0·max_tokens=128·max_kv_size=4096을 사용했으며 readiness·template·dependency·기본 system prompt를 변경하지 않았다. 원래 vLLM 모델을 UI에서 종료하고 소유 PID·포트 부재를 확인한 뒤 MLX를 실행했다.

| 검증 범위 | 상태 | 실제 근거와 한계 |
| --- | --- | --- |
| 새 대화의 첫 음성 질문·짧은 후속 전사 | pass | CUA New chat→실제 Open 창에서 speech.wav 첨부→내용 질문→새 첨부 없는 전사 질문. 왼쪽 빨간 사각형·오른쪽 파란 원을 정확히 응답했다. 첫 응답 PP 129 tok/0.56s/231.4 tok/s·TG 18 tok/0.40s/44.8 tok/s, 후속 PP 167 tok/0.30s/559.5 tok/s·TG 17 tok/0.40s/42.9 tok/s. 엔진 log에 각 요청 audio=1과 실제 phase 측정이 있다. `goal-native-audio-audio-followup-orbit102-{first,second}-20261008.json`/PNG. 모든 음성 질문의 내용 정확성을 뜻하지 않는다. |
| 긴 첫 음성 질문의 내용 | fail | 이전 실패와 같은 질문을 별도 새 대화에서 전송했다. 실제 audio=1·PP 135·TG 25·finish_reason=stop인데 음성을 제공해 달라는 답이 다시 나왔다. Projects→Chat 재로드 후 첨부·답·지표를 보존했다. `goal-native-audio-audio-followup-orbit102-{long-failure,reloaded}-20261008.json`/PNG. HTTP 성공과 내용 검증 실패를 구분한다. |
| 앱 밖 직접 요청의 대조 | pass | 같은 실행 process·모델·WAV·temperature·생성 예산에 대한 직접 upstream SSE 7건은 HTTP 200이다. system 메시지 없이 실행한 단일 긴 질문과 원래 두 turn 이력 재구성은 음성 내용을 해석했다. 앱과 같은 `You are a helpful assistant.` system 메시지를 추가한 두 요청은 이전의 음성 요구 응답을 정확히 재현했고 usage도 각각 135/25와 177/29로 일치했다. `goal-native-audio-followup-orbit102-direct[-system]-20261008.json`과 각 request JSON/SSE. 두 turn 요청은 기록으로 재구성한 replay이며 앱 wire를 캡처한 것으로 설명하지 않는다. |
| 내용 실패의 분류 | fail | 선택한 엔진·모델 조합의 system prompt 유무에 따른 내용 실패가 앱 밖에서도 재현된다. 앱의 첨부 누락으로 단정하지 않는다. 정확한 tokenizer·processor·model·cache 내부 원인은 미확정이다. 설치 코드가 역사적 audio를 모아 마지막 user 메시지에 배치하는 관찰만으로 이 실패의 원인이라고 확정하지 않는다. system prompt를 조용히 제거하거나 임의 template를 기본값으로 넣는 우회는 하지 않았다. |
| 긴 후속 응답의 종료 이유 안내 | fail | 당시 새 대화의 세 번째 요청은 음성 내용을 설명하다 128 tok·finish_reason=length로 끝났다. 앱은 부분 내용을 보존하지만 `Response complete`로 표시하고 메시지 이력에 length를 보존하지 않았다. `goal-native-audio-audio-followup-orbit102-third-20261008.json`/PNG와 소스 관찰 근거다. 앞의 음성 내용 실패와 별도의 제품 결함이며, 후속 수정·재검증은 38절에 기록한다. |
| MLX 종료·기존 vLLM 실행 복원 | pass | 실제 Unload 후 MLX 소유 PID·listener 부재, 같은 Qwen 모델 revision·외부 vllm-metal runtime·Global Default·context=4096을 UI로 다시 선택하고 readiness를 확인했다. 원래 대화·빈 composer·API off·idle·localStorage를 복원했다. 기존 35개 대화 파일은 정확한 해시를 유지하고 새 합성 대화 2개만 추가됐다. profile 내용은 보존했고 Save profile & start에 따른 두 profile revision·library revision·applied/provider_recent은 갱신됐다. config 전체 바이트 일치나 같은 모델 PID 보존으로 설명하지 않는다. |

`goal-native-audio-followup-orbit102-evidence-audit-20261008.json`은 원래 35개 파일의 해시, 두 새 대화의 immutable WAV 참조·실제 media bytes, 재로드된 실패 기록, 원래 model/runtime·non-profile config·localStorage·MCP 정의, profile 내용 보존과 예상 revision 변경, 수집 render error/overlay 0을 검사했다. 종료 근거는 `goal-native-audio-followup-orbit102-{old,mlx}-cleanup-20261008.json`, 최종 화면은 `goal-native-audio-audio-followup-orbit102-final-20261008.json`/PNG다. 최초 cleanup 관측기가 존재하지 않는 status.port를 읽어 실패한 것은 helper 오류이며 status.url에서 포트를 파싱한 실제 socket 검사로 바로잡았다. 파일 경로 입력의 자동화 문제는 실제 Open 선택·Attachment ready를 확인하고 진행했으며 제품 실패로 세지 않는다.

Browser plugin이 제공되지 않아 기존 frontend 검증 skill의 실제 Tauri WKWebView `localhost:1420`·CUA 조작·읽기 전용 WebDriver getter/PNG를 사용했다. native 1280×800·web 1280×768에서 앱 내용·실제 interaction·수집 render error/overlay 0을 확인했다. `logs/goal-native-audio-followup-orbit102-*-20261008.log`와 direct request/SSE 원본은 ignored tmp에 보존했다. 이번 변경은 검증 문서뿐이므로 35절의 전체 자동 검사·36절의 DMG를 새 검사·새 빌드로 재표기하지 않는다. M04/M07 내용 실패와 기존 blocked/unrun, 새 종료 이유 표시 결함, **전체 M01–M12 미통과**를 유지한다. 개인 엔진 등록은 미구현 장기 설계이며 공개 업로드·원격 push는 수행하지 않았다.

## 38. 공통 Chat 종료 이유 보존과 출력 한도 안내

수정 소스는 `55606fd9a98121752cfafc313a8fc3b3d3315997`다. 37절의 제품 결함을 공통 스트림 accumulator·대화 저장·화면 표시에서 수정했다. `finish_reason`의 비어 있지 않은 값을 보존하고 뒤따르는 null usage frame은 이전 종료 이유를 지우지 않는다. 다음 요청의 accumulator는 새로 초기화한다. 저장된 assistant 메시지의 선택적 `finishReason`을 browser/native 이력에서 유지하며 기존 기록과 잘못된 선택 필드 때문에 대화를 버리지 않는다. 이유는 요청 메시지로 다시 전송하지 않는다.

`length` 응답은 부분 내용·reasoning·usage·모델명을 유지하고 bubble과 composer에 출력 한도 안내를 표시한다. 정상 완료 알림을 제출하지 않으며, 잘린 tool 이름·인수가 유효한 부분 JSON이어도 실행 승인을 제시하지 않는다. transport 오류나 사용자 Stop으로 바꾸지 않고 자동 재시도·생성 예산 확대도 하지 않는다. 영어·한국어·일본어·중국어 문구를 추가했다. 새 엔진 이름 분기·설정 기본값·dependency·lockfile·native/Python 코드·공개 gateway/benchmark 계약 변경은 없다.

| 검증 범위 | 상태 | 실제 근거와 한계 |
| --- | --- | --- |
| 실제 출력 한도·부분 답변 | pass | 기존 native debug 앱의 실제 WKWebView·수정 frontend에서 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`·외부 vllm-metal 0.30.0/vLLM 0.30.0+cpu를 사용했다. UI Save as new로 별도 Global `Native output limit ORBIT-103`의 max_tokens=16을 적용했고 같은 소유 PID에서 추론했다. 첫 영어 장문 요청은 거절 문구·14 tok·stop으로 끝나 한도 검증 성공으로 세지 않았다. 같은 대화의 한국어 장문 요청은 실제 16 tok·length이며 부분 답변과 `Output token limit reached`를 표시했다. PP 42 tok·phase 시간/속도 미제공, TG 16 tok/0.47s/32.0 tok/s·cached 48 tok을 그대로 표시했다. `goal-native-audio-chat-limit-orbit103-native-length-20261008.json`/PNG와 새 대화 원본이 근거다. |
| 이력·재로드·다음 정상 응답 | pass | 실제 Projects→Chat remount 후 부분 내용·length·안내·usage가 남았다. 기존 Default 설정을 UI로 복원·재실행한 후 같은 대화의 짧은 질문은 `2 + 3은 5입니다.`·10 tok·stop이다. 최신 composer는 `Response complete · 6 messages`, 이전 bubble은 한도 안내를 유지했다. `goal-native-audio-chat-limit-orbit103-native-{reloaded,normal}-20261008.json`/PNG와 저장된 세 assistant의 stop/length/stop이 근거다. |
| 완료 알림·잘린 도구 요청 | pass | 합성 회귀에서 length의 알림 제출 0·pending approval 없음·activity 해제를 확인했다. 실제 OS 알림 수신이나 실제 MCP tool 호출의 통과를 뜻하지 않는다. 기존 blocked 범위를 유지한다. |
| 기존 실행·데이터 복원 | pass | 기존 Default 선택 뒤 UI Unload→Save profile & start로 원래 model/runtime·context=4096·request 옵션을 복원했다. 이전 소유 PID 부재와 listener 닫힘을 확인했다. 37개 원래 대화 파일의 목록/해시·non-profile config·localStorage·MCP 정의·기존 19개 profile 내용이 정확히 같다. 합성 대화 1개와 별도 한도 profile 1개를 보존했다. Default vLLM revision 9→10·library 48→52·applied/provider_recent은 저장/재실행으로 갱신됐다. 같은 최종 PID나 config 전체 바이트 일치로 설명하지 않는다. API off·idle·빈 composer·원래 대화·render error/overlay 0을 확인했다. `goal-chat-limit-orbit103-{old-cleanup,evidence-audit}-20261008.json`과 `goal-native-audio-chat-limit-orbit103-native-restored-20261008.json`/PNG. |

수정 전 새 회귀 6개는 모두 fail, 기존 25개는 pass였다. 수정 후 관련 6 files/38 tests·직접 이력 검사는 종료 0이다. 최종 typecheck·lint·unit·build는 모두 종료 0이며 10.48s·6.04s·151.46s·12.73s다. 최종 UI는 177 files/1767 tests, coverage 80.60/75.38/78.98/84.73%다. `logs/goal-chat-limit-orbit103-{regression-before,related-after,history-after,final-typecheck,final-lint,final-unit,final-build}-20261008.log`에 보존했다. 전체 unit 도중 마지막 소스 보완이 있어 최종 소스에 대해 한 차례 다시 실행했다. 기존 jsdom pseudo-element/canvas 진단과 500kB chunk 경고는 유지한다. native 코드는 변경하지 않았으므로 앞 절의 Rust/실제 엔진 전체 검사를 새 실행으로 재표기하지 않는다. 읽기 전용 감사의 79개 조건은 실제 저장 이유·부분 내용·다음 정상 답·복원·커밋된 12개 파일의 정확한 해시를 확인했다.

Browser plugin이 제공되지 않아 CUA 네이티브 조작과 읽기 전용 WebDriver getter/PNG를 사용했다. native 1280×800·web 1280×768에서 의미 있는 앱 내용과 실제 interaction을 확인했다. 초기 소스 변경 후 일시적인 빈 loading 화면을 관측했고 실제 Cmd+R 뒤 정상 화면·오류/overlay 0을 확보했다. 그 초기 화면을 통과로 계산하거나 bootstrap 원인을 수정했다고 주장하지 않는다. 다른 viewport·모든 언어/VoiceOver·production Finder 실행·모든 엔진의 새 실제 length 응답은 검증하지 않았다.

38절은 출력 한도 제품 결함의 수정 근거다. Gemma4 system prompt 조건의 음성 내용 실패와 기존 실제 실패·upstream 제한·blocked/unrun, **전체 M01–M12 미통과**를 유지한다. 개인 엔진 registry·manifest·adapter는 [장기 설계](pluggable-inference-runtimes.ko.md)이며 아직 구현되지 않았다. raw·합성 자료·빌드는 ignored tmp에 보존하고 공개 업로드·원격 push는 수행하지 않았다.

## 39. 출력 한도 수정 소스 `55606fd`의 arm64 DMG

기존 `npm run package:tauri`로 `55606fd9a98121752cfafc313a8fc3b3d3315997`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-native-chat-limit-package-55606fd.log`, `logs/goal-native-chat-limit-inspect-package-55606fd.log`, `goal-native-chat-limit-package-55606fd-results.json`이 근거다. 빌드 229.87s·검사 4.45s 모두 종료 0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16774717 bytes, SHA256 `a30432e9059fecb215f3fd935cd2485913214d5545a23b5f84d0f2751a7cf311`.
- GUI `aiolm`: arm64, SHA256 `893ad8a4cdb1fa756f0f5cc5c0103910dd6713f587d1fd431d6a1ce104b91721`.
- CLI `aiolm-cli`: arm64, SHA256 `e64f24ca44c8108a9612144fe7d09db33b63fef740946dd71b1d160a196fa98d`.
- GUI·CLI 해시와 빌드 앱 일치, 일반 파일 5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 home/repository 경로와 검증 fixture 표식 일치 0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료 0을 확인했다. 같은 해시의 DMG를 `goal-package-55606fd/`에 보존했다.

생성 후 실제 CUA Chat 화면과 `goal-native-audio-chat-limit-orbit103-postpackage-55606fd.json`/PNG, `goal-chat-limit-orbit103-postpackage-preservation-55606fd.json`의 9개 조건에서 복원 직후 config 전체 SHA256·38개 대화의 목록/해시·localStorage·같은 running 모델 PID·runtime/model·MCP 정의·API off·idle·빈 composer·render error/overlay 0을 재확인했다. 화면의 기존 응답과 지표는 재표시이며 패키지 생성 후 새 추론으로 설명하지 않는다. production 앱을 실행하지 않았으며 Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade는 unrun이다. Intel/구형 macOS 실제 결과도 추정하지 않는다. 38절의 수정과 패키지 통과를 **전체 M01–M12 통과**로 확대하지 않는다. 개인 엔진 등록은 미구현 장기 설계이며 공개 업로드·원격 push는 수행하지 않았다.

## 40. 런타임 옵션 확인 중 프로필·저장값 보호

수정 소스는 `a294062deebd63827ec59708b5af3c3ef41c2de3`다. 설정을 열었을 뿐인데 schema/값 확인 대기를 invalid로 처리해 `Editing`·`unsaved changes`·Revert를 표시하는 제품 결함을 수정했다. 아직 schema를 받지 못한 저장 옵션을 unsupported로 판단하고 `Clear value`를 제안하는 문제도 수정했다. 확인 중에는 저장·프로필 적용·시작을 막고 확인 상태를 표시하되 편집으로 취급하지 않는다. Close·실행 중 모델 Unload는 사용할 수 있다. 실제 잘못된 값과 성공적인 schema 조회에서 확인된 미지원 옵션은 계속 오류로 처리한다.

schema 조회 오류를 값 검증·import·preview 오류와 분리했다. 다른 값을 편집하여 값 검증에 성공해도 schema 조회 실패는 해제하지 않는다. schema를 다시 성공적으로 조회해야 적용할 수 있다. 공통 옵션 editor와 프로필 흐름을 수정했으며 새 engine 이름 분기·설정 기본값·native/Python 코드·dependency·lockfile·공개 API/benchmark 계약은 변경하지 않았다. 영어·한국어·일본어·중국어 확인 중 문구를 추가했다.

| 검증 범위 | 상태 | 실제 근거와 한계 |
| --- | --- | --- |
| 실제 확인 대기와 정상 설정 | pass | 최종 frontend의 native WKWebView를 CUA로 열고 읽기 전용 getter로 20초 관측했다. `goal-option-check-orbit104-native-frames-finalsource-20261008.json`/최종 PNG의 401 frames 중 실제 pending 3 frames가 있다. invalid/unsaved changes·render error/overlay는 0이다. pending에서 profile 선택·Save profile·Save as new는 disabled, Close는 enabled, unchecked Clear value는 없다. 검증 속도를 인위적으로 늦추거나 UI/IPC를 조작해 상태를 만들지 않았다. |
| 실제 잘못된 입력·취소 복원 | pass | CUA로 Generation의 max_tokens에 잘못된 문자열을 입력했을 때 field 오류·provider:max_tokens 안내·저장 차단이 남았다. 값을 지운 뒤 깨끗한 Default 상태로 돌아와 Close를 실행했다. `goal-native-audio-option-check-orbit104-native-invalid-20261008.json`/PNG와 최종 `goal-native-audio-option-check-orbit104-restored-finalsource-20261008.json`/PNG. 미저장 invalid draft는 config를 쓰지 않았다. 최종 schema 오류 분리 보완은 별도 합성 회귀로 검사했으며 실제 엔진의 schema 장애를 유발한 검증은 아니다. |
| 요청 전용 프로필의 즉시 적용·왕복 | pass | 같은 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`·외부 vllm-metal 0.30.0 실행에서 기존 max_tokens=16 프로필을 UI 선택하고 Default로 돌아왔다. engine request_fields가 max_tokens=16→빈 값으로 즉시 바뀌고 동일한 running PID를 유지했다. `goal-native-audio-profile-roundtrip-orbit104-{baseline,limited,restored}-20261008.json`/PNG. 38절의 Unload/Start는 당시 수행한 복원 절차이며 요청 옵션 변경 자체에 필요한 절차는 아니다. 이번에는 새 추론을 실행하지 않았다. |
| 기존 설정·데이터 보존 | pass | `goal-option-check-orbit104-evidence-audit-20261008.json`의 36개 조건은 기존 38개 대화의 전체 목록/해시와 20개 프로필 entry의 정확한 내용·revision 보존, 같은 PID·원래 engine/model·API off·idle·빈 composer·localStorage·MCP 정의를 확인한다. 프로필 왕복에 따라 library 52→54·applied/provider_recent이 갱신됐으며 한도 선택 중 provider_options에 max_tokens=16만 추가됐다. 원래 프로필 복원 이후 invalid 입력·최종 확인/Close 동안 config 전체 SHA256은 같다. 전체 왕복 동안 config가 불변이었다고 설명하지 않는다. |

수정 전 선택한 새 회귀 5개는 4 fail/1 pass였다. 후속 schema 오류 보존 회귀를 추가하여 총 6개를 검증했다. 최종 ProviderControls 검사 16 tests·전체 unit 177 files/1773 tests와 typecheck·lint·build는 모두 종료 0이다. 최종 소스 검사는 `logs/goal-option-check-orbit104-settled-{typecheck,lint,unit,build}-20261008.log`에 보존했으며 각각 10.20s·5.83s·130.46s·13.42s, coverage 80.63/75.51/79.01/84.75%다. 보완 전 전체 unit이 실행 중이었으므로 그 실행을 끝낸 뒤 확정 소스에 대해 다시 검사했다. 기존 jsdom pseudo-element/canvas 진단과 500kB chunk 경고는 유지한다. `goal-option-check-orbit104-committed-source-20261008.json`은 관측한 5개 소스 파일과 수정 커밋의 정확한 해시 일치를 확인한다.

최초 읽기 전용 감사가 한도 프로필 선택 중에도 non-profile config 전체 불변을 요구해 실패한 것은 감사 조건 오류다. 실제 의도한 max_tokens=16 변경만 허용하고, 복원 이후 전체 config 불변을 검사하는 v2 감사로 바로잡았다. 첫 실패 로그도 보존했다. Browser plugin이 없어 실제 Tauri WKWebView `localhost:1420`·CUA와 읽기 전용 WebDriver getter/PNG를 사용했다. native 1280×800·web 1280×768 범위이며 다른 viewport·모든 언어/VoiceOver·production Finder 실행을 새로 검증한 것은 아니다.

이 수정은 공통 기능을 유지하고 런타임만 교체하는 [장기 설계](pluggable-inference-runtimes.ko.md)에 맞춘 기존 옵션 검증 결함 수정이다. 개인 엔진 registry·versioned manifest·adapter 등록은 아직 구현되지 않았다. Gemma4 음성 내용 실패와 기존 upstream 오류·blocked/unrun, **전체 M01–M12 미통과**를 유지한다. raw·합성 자료·빌드는 ignored tmp에 보존했으며 공개 업로드·원격 push는 수행하지 않았다.

## 41. 런타임 옵션 보호 수정 소스 `a294062`의 arm64 DMG

기존 `npm run package:tauri`로 `a294062deebd63827ec59708b5af3c3ef41c2de3`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-native-option-check-package-a294062.log`, `logs/goal-native-option-check-inspect-package-a294062.log`, `goal-native-option-check-package-a294062-results.json`이 근거다. 빌드 230.86s·검사 3.78s 모두 종료 0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16775070 bytes, SHA256 `e30d2597419c1f734c63fc5e6de5db46b719c27dba0a6a73494a0d3d5f33cc2e`.
- GUI `aiolm`: arm64, SHA256 `76799d497d36e8049554582cca836e56eb4bd44985795fd5a82463a120eb81c0`.
- CLI `aiolm-cli`: arm64, SHA256 `70c9749e17b84361fbe58679d4c7d330338e770c022fd93da939a6a20b1ad112`.
- GUI·CLI 해시와 빌드 앱 일치, 일반 파일 5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 home/repository 경로와 검증 fixture 표식 일치 0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료 0을 확인했다. 같은 해시의 DMG를 `goal-package-a294062/`에 보존했다.

생성 후 실제 CUA Chat 화면과 `goal-native-audio-option-check-orbit104-postpackage-a294062.json`/PNG, `goal-option-check-orbit104-postpackage-preservation-a294062.json`의 8개 조건에서 복원 이후 config 전체 SHA256·38개 대화 목록/해시·localStorage·같은 running 모델 PID/engine/model·MCP 정의·API off·idle·빈 composer·render error/overlay 0을 재확인했다. 화면의 기존 답변·모델명·지표는 재표시이며 새 추론 결과로 설명하지 않는다. production GUI를 실행하지 않았으며 Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade는 unrun이다. Intel/구형 macOS 실제 결과도 추정하지 않는다. 40절의 수정·패키지 통과를 **전체 M01–M12 통과**로 확대하지 않는다. 개인 엔진 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 42. 외부 snapshot 모델명과 실행·기록 identity 보존

수정 소스는 `27bcca13b4df5a35e424b528983a73cad2306e08`다. catalog 밖의 `snapshots/<40hex>` 모델은 실행과 응답이 가능해도 이름을 revision으로만 표시했다. 실제 기존 Gemma 기록의 세 응답에서 재현했고, 같은 경로에 이미 있는 README의 첫 실제 H1 제목을 표시 이름으로 사용할 수 있게 수정했다. 이전 native backend와 수정 frontend로 캡처한 재현 근거는 `goal-native-audio-model-card-orbit105-history-oldbackend-20261008.json`/PNG다. 전체 frontend가 이전 소스였다는 의미는 아니다.

이름은 엔진 공통 artifact 검사와 `ModelName` 표시 계층에서 처리한다. 알려진 repository 이름과 사용자 폴더명은 유지하며 repository를 알 수 없는 40hex snapshot만 카드 읽기 대상이다. README는 일반 파일·UTF-8·64 KiB 이하이며 frontmatter와 fenced/indented code를 제외한 첫 H1이 단일 `namespace/model` 토큰이어야 한다. 일반 제목·HTML·경로 이동·추가 텍스트·지나치게 큰 카드·읽기 실패는 기존 표시로 돌아간다. YAML `base_model`이나 상위 폴더 이름으로 변환 모델명을 추정하지 않는다.

표시 이름을 모델 경로·저장 identity로 대체하지 않는다. repository/revision provenance·소유권·loader/task/modality·readiness는 이름으로 부여하지 않는다. 카드 없는 임의 snapshot 전체, icon/family 자동 해석, benchmark 이름 형식 변경까지 구현한 것은 아니다. 상단 실행 영역, 응답과 대화 설정, 모델 설정·실행 패널, 프로젝트·세션의 모델 표시, 진단에 공통 renderer를 연결했다. 동시 읽기는 합치되 결과 cache를 남기지 않고 이전 모델의 늦은 응답은 폐기한다. 새 dependency·lockfile·engine ID 분기·IPC 타입·공개 gateway/benchmark 계약 변경은 없다.

| 검증 범위 | 상태 | 실행 근거와 한계 |
| --- | --- | --- |
| 실제 카드·외부 소유권 | pass | `goal-model-card-orbit105-artifact-20261008.json`에서 이름 `gemma-4-e2b-it-4bit`와 카드 SHA256을 확인했다. ownership은 external, repository/revision 속성은 미제공 상태다. 21절의 고정 공개 모델 revision `238767527555cb75a05732a84dff5d6ba0dd6809`를 사용했으며 카드 이름을 다운로드 출처 증명으로 계산하지 않았다. |
| 미실행 모델의 기존 기록 표시 | pass | 수정 native debug 앱의 `goal-native-audio-model-card-orbit105-history-newbackend-20261008.json`/PNG에서 모델 stopped 상태에도 기존 세 응답 이름이 카드의 이름으로 표시됐다. 저장된 경로·내용·PP/TG는 그대로다. |
| 실제 MLX 실행·새 응답 표시 | pass | CUA로 새 합성 global 프로필을 만들고 외부 등록 MLX 0.7.6·Metal을 실제 실행했다. `goal-native-audio-model-card-orbit105-{loaded,response}-20261008.json`/PNG에서 loaded 상단 이름, 기록된 응답 이름·PP40/TG128·양수 phase 시간이 확인된다. readiness·loader·processor·설정 검사를 완화하지 않았다. |
| 새 응답의 완전한 종료·한 문장 지시 | fail | 2+3=5의 한국어 내용을 받았지만 부연하며 max_tokens=128에 도달했다. 기록의 finishReason=length와 부분 응답·출력 한도 안내를 보존했다. 완전한 답변 성공이나 한 문장 지시 준수로 세지 않고 생성 예산을 임의로 확대하지 않았다. 이번 표시 수정의 실패로 재분류하지 않는다. |
| 엔진 교체 후 기록 재로드 | pass | 원래 Qwen3-VL-2B-Instruct-4bit/vllm-metal 0.30.0 실행을 복원한 뒤 새 Gemma 기록과 기존 음성 기록을 실제로 다시 열었다. `goal-native-audio-model-card-orbit105-{different-live-model,history-qwen-running}-20261008.json`/PNG에서 상단 Qwen과 응답 Gemma의 identity가 구분된다. 기존 세 Gemma 응답은 현재 runtime 이름으로 바뀌지 않았다. |
| 데이터·선택 복원·cleanup | pass | `goal-model-card-orbit105-audit-final-20261008.json`의 35개 조건에서 기존 38개 대화 목록/해시, 원래 20개 profile 내용, non-profile config와 execution·localStorage·MCP 정의, 원래 ORBIT-84·running Qwen·API off·idle·빈 composer·render error/overlay 0을 확인했다. 새 합성 profile 1개·대화 1개만 더했다. 19개 기존 profile entry는 정확히 같고 Default vLLM revision만 정상 저장으로 10→11, library는 54→64다. applied snapshot도 정상 적용에 따라 갱신됐으므로 config 전체 불변으로 설명하지 않는다. 이전 Qwen과 MLX 각각의 소유 process group 구성원·listener 정리를 확인한 뒤 새 Qwen PID로 복원했다. |

최종 typecheck·lint·unit·build는 각각 11.45s·8.78s·133.81s·21.79s, 모두 종료 0이다. `logs/goal-model-card-orbit105-final-{typecheck,lint,unit,build}-20261008.log`가 근거이며 계약/direct/script와 UI178 files/1779 tests·coverage statements80.64 / branches75.52 / functions79.03 / lines84.75%를 확인했다. 관련 UI4 files/77 tests와 Rust artifact13 tests, Rust `--locked --all-targets --all-features`(lib939 pass/4 기존 ignored), clippy `-D warnings`, fmt check가 통과했다. Rust 전체 검사48.04s·clippy5.02s·fmt0.97s, debug 빌드17.47s다. 기존 live/CPU/Metal/source/download fixture의 ignored 상태를 새 실제 실행 통과로 계산하지 않았다. 기존 jsdom 진단·frontend chunk 경고는 유지한다.

수정 전 Rust 최소 재현은 기대한 선언 이름 대신 revision을 반환해 종료101이었다. 초기 typecheck의 미사용 import와 UI 동시 consumer fixture가 adjacent text로 합쳐지는 단일 assertion 실패를 바로잡고 최종 검사를 실행했다. 원본 `regression-before`, `typecheck`, `ui-related-after` 로그를 보존했다. 최초 감사33/35는 old cleanup의 portOpen=false를 잘못 pass 판정한 조건과 UI 프로필 선택 중 실제 모델별 cache 변경을 함께 드러냈다. 원래 Qwen MLX·Gemma 프로필 연결과 vLLM Default를 CUA로 되돌려 localStorage를 정확히 복원하고 cleanup 조건을 바로잡았다. 이 복원 동안 현재 Qwen PID는 같았다. 초기 감사 파일도 보존했다.

`goal-model-card-orbit105-native-source-20261008.json`과 `goal-model-card-orbit105-committed-source-20261008.json`에서 native build에 사용한 11개 소스와 커밋의 SHA256 일치를 확인했다. native 1280×800·WKWebView 1280×768에서 실제 상단·응답·설정 이름을 확인했으며 모든 연결 화면·다른 viewport·VoiceOver의 실제 검증으로 확대하지 않는다. 기존 모델 가중치를 재다운로드하거나 변경하지 않았고 카드 SHA256은 보존됐다.

이번 수정은 [교체 가능한 런타임 설계](pluggable-inference-runtimes.ko.md)의 공통 기능 경계를 유지하는 표시 결함 수정이다. 개인 엔진 registry·versioned manifest·out-of-process adapter와 앱 재빌드 없는 등록은 아직 구현되지 않았다. Gemma4 음성 내용 실패와 기존 upstream 오류·MCP 실제 승인 후 호출·트레이/Dock·OS 알림 수신의 blocked, 별도 계정/Finder/Keychain/upgrade·Intel/구형 macOS의 unrun을 유지한다. **전체 M01–M12는 통과하지 않았다.** raw·모델·캡처·합성 profile/대화와 빌드는 ignored tmp에 보존했으며 공개 업로드·원격 push는 수행하지 않았다.

## 43. 외부 snapshot 이름 수정 소스 `27bcca1`의 arm64 DMG

기존 `npm run package:tauri`로 `27bcca13b4df5a35e424b528983a73cad2306e08`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-model-card-orbit105-package-27bcca1-20261008.log`, `logs/goal-native-model-card-inspect-package-27bcca1-20261008.log`, `goal-native-model-card-package-27bcca1-results.json`이 근거다. 빌드230.31s·검사5.23s 모두 종료0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16775732 bytes, SHA256 `cd1698bc7b2a85166f63d148ea962fb437f03bf0b66b3b855dad263d7eb1d67e`.
- GUI `aiolm`: arm64, SHA256 `48ad86021cdcadbaa849ebb6b5996f6b8e487db3874f7e95a8ae6b2a97c990c0`.
- CLI `aiolm-cli`: arm64, SHA256 `f5d6e8c67f54257620c17e48254bdb89ccd271877bb5b1647ebe5fd32e5955b9`.
- GUI·CLI와 빌드 앱의 해시 일치, 일반 파일5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 home/repository 경로와 검증 fixture 표식 일치0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료0을 확인했다. 같은 해시의 DMG는 `goal-package-27bcca1/`에 보존했다.

생성 후 실제 CUA Chat 화면과 `goal-native-audio-model-card-orbit105-postpackage-27bcca1-20261008.json`/PNG, `goal-model-card-orbit105-postpackage-preservation-27bcca1-20261008.json`의 8개 조건에서 최종 복원 이후 config 전체 SHA256/값·39개 대화 목록/해시·localStorage·동일한 running Qwen PID/engine/model/execution·MCP 정의·API off·idle·빈 composer·render error/overlay0을 재확인했다. 기존 답변과 지표의 재표시이며 새 추론 결과는 아니다.

production GUI는 실행하지 않았고 Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade는 unrun이다. Intel/구형 macOS 결과도 추정하지 않는다. 42절의 수정·패키지 통과를 **전체 M01–M12 통과**로 확대하지 않는다. 개인 엔진 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 44. 좁은 창의 벤치마크 결과 열 접근과 공통 UI 수정

`5c528b2`의 실제 native debug 앱에서 기존 vllm-metal 0.30.0·Qwen2.5-0.5B-Instruct-4bit 벤치마크 이력을 열고 native 360×520 / WKWebView 360×488로 줄였다. 현재 실행 중인 Qwen3 모델과 이력의 Qwen2.5 모델은 구분했다. 단일 표는 326px 안에 955px, 동시 표는 1174px의 열을 담고 있었고 PP·TG·RAM이 오른쪽에 가려졌다. 표를 클릭해 포커스한 뒤 Right를 눌러도 scrollLeft=0이었다. 데이터 누락·계산 실패와 구분한 제품 UI 결함이다. 수정 전 캡처 `goal-native-audio-layout-orbit106-table-before-20261008.json`/PNG와 기대한 가로 이동이 0으로 실패한 `logs/goal-layout-orbit106-keyboard-regression-before-fixed-20261008.log`를 보존했다.

`142fac3`은 엔진과 무관한 `BenchmarkTableScroll`을 단일·동시·공개 미리보기 표에 적용한다. 실제 넘침이 있을 때만 이전/다음 열 버튼과 키보드 설명을 제공하며 끝에서 버튼을 비활성화한다. 해당 영역의 Left/Right·Home/End만 처리하고 셀 내부 control·modifier shortcut·세로 방향키는 보존한다. container/table ResizeObserver와 창 resize·내용 변경을 다시 측정하고 listener를 정리한다. 네 언어의 접근성 이름·설명을 제공한다. 결과 행·PP 추정 방법·TG·usage·공개 schema·이력·프로필·runtime lifecycle·request/IPC 계약은 바꾸지 않았다.

| 실행 범위 | 상태 | 근거와 결과 |
| --- | --- | --- |
| 단일 표의 키보드·버튼 | pass | CUA native click/Right로 0→244px, End로 629px, Home으로 0px를 확인했다. 다음 버튼 두 번은 488px, 끝은 629px, 이전 버튼은 384px로 돌아왔다. 마지막 메모리 238.5 MiB가 보이며 끝에서 다음 버튼이 비활성화된다. `goal-layout-orbit106-{arrow-right,end,home,next-buttons,previous-button}-20261008.json`과 대응 PNG가 근거다. |
| 동시 표의 독립 이동 | pass | 단일 표의 384px·미리보기의 0px를 유지하며 동시 표만 다음 버튼으로 244px, End로 848px까지 이동했다. 마지막 230.3 MiB와 비활성화된 다음 버튼을 확인했다. `goal-layout-orbit106-{batch-next,batch-end}-20261008.json`/PNG가 근거다. |
| 공개 미리보기 열 접근 | pass | CUA End로 595px, 이전 버튼으로 377px로 이동했다. 실제 화면에서 기존 PP 추정 1051.2/1430.0과 TG108.7/181.6·처리량98.9/163.1을 확인했다. `goal-layout-orbit106-{preview-end,preview-visible,preview-previous}-20261008.json`/PNG가 근거다. Publish는 누르지 않았으며 업로드하지 않았다. |
| 넓은 창·페이지 가로 넘침 | pass | native 1280×800 / WKWebView 1280×768로 CUA drag 복원했다. 단일 표 1006px와 미리보기 970px는 전부 맞아 이동 버튼이 사라지고, 1006px를 넘는 동시 표만 버튼을 유지했다. 최소 창의 document 폭은 360px, desktop은 1280px다. `goal-layout-orbit106-desktop-20261008.json`/PNG가 근거다. |
| 실행·설정·이력 보존 | pass | 기존 Chat ORBIT-84로 돌아왔다. `goal-layout-orbit106-preservation-audit-20261008.json`의 28개 조건에서 config 전체 hash/값·39개 대화 파일 목록/hash·21개 profile·localStorage·동일 running PID/engine/model/execution·API off·idle·빈 composer·render error/overlay0을 확인했다. 모든 관측의 세 표 결과 문자열도 같다. 새 추론·프로필·대화를 만들지 않았다. |

Frontend HMR가 연결된 기존 실제 Tauri WKWebView에서 검사했다. UI 조작은 CUA이고 WebDriver는 읽기 전용 DOM·상태·geometry·캡처 관측이다. Browser plugin은 없으며 일반 브라우저로 Tauri를 대체하지 않았다. 페이지 identity·유의미한 내용·overlay 없음·관측 error0·캡처·상호작용을 확인했지만 DevTools 전체 console이나 VoiceOver의 별도 검증으로 확대하지 않는다. `goal-layout-orbit106-committed-source-20261008.json`의 수정 7개 파일 hash는 커밋과 일치한다.

타입·lint·전체 unit·frontend build는 각각 12.34s·7.80s·129.65s·13.46s, 종료0이다. `logs/goal-layout-orbit106-{typecheck,lint,unit,build}-20261008.log`에 계약/direct/script·UI179 files/1788 tests·coverage statements80.67 / branches75.56 / functions79.08 / lines84.80%를 기록했다. 관련 4 files/54 tests와 추가된 9개 회귀가 통과했다. 최초 회귀의 중복 region selector와 수정 후 fixture에서 TTFT/TG 값이 같은 중복 text assertion을 좁혀 최종 검사했다. 실패 로그를 덮어쓰지 않았다. 보존 감사의 최초 helper는 첫 geometry 관측에 수집하지 않은 title을 읽다 중단했으며, 수집된 10개 page identity와 11개 geometry 관측을 구분해 최종 감사했다. jsdom의 기존 미구현 진단과 frontend chunk 경고는 유지한다. Rust/Python 제품 소스는 이번에 변경하지 않았다.

이 수정은 [교체 가능한 런타임 설계](pluggable-inference-runtimes.ko.md)의 공통 UI 경계를 따른다. 개인 엔진 registry·manifest·adapter 등록은 아직 구현되지 않았다. 원래 M03/M04/M07 실제 실패·upstream 오류, MCP 실제 승인 후 호출·트레이/Dock·OS 알림 수신의 blocked, 별도 계정·Finder·Keychain·upgrade·Intel/구형 macOS의 unrun은 유지한다. 전체 M01–M12가 통과한 것으로 표시하지 않는다. raw·캡처·관측 도구는 ignored tmp에 보존했고 원격 push는 수행하지 않았다.

## 45. 벤치마크 열 접근 수정 소스 `142fac3`의 arm64 DMG

기존 `npm run package:tauri`로 `142fac30e2d87d9d316c8641b1ae4baee28e02a1`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-layout-orbit106-package-142fac3-20261008.log`, `logs/goal-native-table-scroll-inspect-package-142fac3-20261008.log`, `goal-native-table-scroll-package-142fac3-results.json`이 근거다. 빌드220.11s·검사5.67s 모두 종료0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16776734 bytes, SHA256 `56c83ea82a3911aa5c711f0b88396b220cc7d76e2bc2cd379435ed1e56f8e52f`.
- GUI `aiolm`: arm64, SHA256 `6f0e084a090d80d46746f214545467f0c31f318d484606c16b5c4ef54f02d765`.
- CLI `aiolm-cli`: arm64, SHA256 `77bcee63a720b0d1e82d0a403ba7b0c0441685ce5650c6a623b5389e3a8a62b1`.
- GUI·CLI와 빌드 앱의 해시 일치, 일반 파일5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 home/repository 경로와 검증 fixture 표식 일치0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료0을 확인했다. 같은 해시의 DMG는 `goal-package-142fac3/`에 보존했다.

생성 후 `goal-native-audio-layout-orbit106-postpackage-142fac3-20261008.json`/PNG와 `goal-layout-orbit106-postpackage-preservation-142fac3-20261008.json`의 읽기 전용 앱 관측 8개 조건에서 최종 복원 이후 config 전체 SHA256/값·39개 대화 목록/hash·localStorage·동일 running Qwen PID/engine/model/execution·API off·idle·빈 composer·관측 render error/overlay0을 확인했다. 기존 응답·지표이며 새 추론은 아니다. **당시 패키징 이후의 마지막 CUA 네이티브 화면 재확인은 Mac 잠금으로 blocked**였다. CUA가 수동 잠금 해제를 요구했고 사용자에게 요청했다. 내부 getter·WKWebView 캡처를 네이티브 화면 재확인 성공으로 계산하지 않는다. 44절의 잠금 전 실제 CUA 검증과 46절의 잠금 해제 후 재개는 별도 근거다.

production GUI는 실행하지 않았고 Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade는 unrun이다. Intel/구형 macOS 결과도 추정하지 않는다. 이번 수정·패키지 통과를 전체 M01–M12 통과로 확대하지 않는다. 개인 엔진 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 46. 잠금 해제 후 작업 알림과 본문 버튼 접근 수정

2026-10-09 (Asia/Seoul)에 잠금 해제된 실제 native debug 앱에서 CUA 검증을 재개했다. 원래 ORBIT-84 Chat·실행 모델 이름·39개 대화와 기존 PP/TG 기록을 확인했다. `goal-native-audio-resume-orbit109-baseline-20261009.json`/PNG가 근거다. 45절의 당시 잠금 차단 기록을 소급하여 pass로 바꾸지 않으며 production DMG GUI 실행이나 새 추론 성공으로 설명하지 않는다.

이전 HTTP400 검증의 base GGUF 서버가 현재 앱 세션에 연결되지 않은 별도 process group·listener로 남아 있었다. 과거 실행 기록, 시작 시각·argv fingerprint·소유 자식 3개·group·listener를 다시 확인한 뒤 해당 group에만 SIGTERM을 보냈다. 3.59s 후 모두 부재·포트 닫힘이며 현재 실행은 유지됐다. `goal-resume-orbit109-old-runtime-cleanup-20261009.json`과 같은 이름의 로그가 근거다. 기존 조사 helper는 process 이름이 변경된 EngineCore를 누락하여 신호 전 조건 검사에서 중단했고, 완전한 inventory로 다시 확인했다. 개발 앱 교체의 잔여 프로세스인지 정상 종료 결함인지는 확정하지 않았다. 제품 수정이나 새 normal Quit 검증으로 계산하지 않는다.

실제 MCP 도구 검색이 성공하며 작업 알림이 자동으로 펼쳐졌을 때, 검토 카드의 승인·취소 버튼이 알림 뒤에 가려졌다. 페이지는 scrollTop=812, scrollHeight=1500, clientHeight=688로 이미 끝이었으며 승인 버튼 top=654.05px의 hit 대상은 알림이었다. `goal-native-mcp-orbit109-review-geometry-before-20261009.json`/PNG가 재현 근거다.

수정 `eb2d03770c860fe1c998187b6725d4098f2c9db7`은 공통 shell CSS만 변경한다. 펼친 activity가 정상 흐름에서 본문 공간을 확보하며 알림 내용은 최대 min(40vh, 320px)에서 별도로 스크롤한다. summary는 아래에 남고 닫히면 32px로 돌아간다. 알림 자동 펼침·native details 토글·작업 취소·승인 정책·엔진·요청·사용자 데이터 계약은 유지한다.

| 실행 범위 | 상태 | 근거와 결과 |
| --- | --- | --- |
| Desktop 승인·취소 버튼 접근 | pass | 실제 native 1280×800 / WKWebView 1280×768에서 page bottom과 activity top은 652px, 승인 버튼 top=571.05px이며 hit가 버튼이다. CUA 스크롤 후 두 버튼과 알림이 동시에 보인다. `goal-native-mcp-orbit109-review-geometry-after-20261009.json`/PNG. |
| 최소 창의 버튼·본문 | pass | 실제 CUA drag로 native 360×520 / WKWebView 360×488. 본문 높이 253px, 승인·취소 버튼 bottom=305.38px, activity top=354px이며 두 버튼 모두 hit=true. `goal-native-mcp-orbit109-review-minimum-20261009.json`/PNG. |
| 접기·긴 알림의 독립 스크롤 | pass | CUA로 접으면 activity 높이 32px이며 본문/알림 경계736px에서 두 버튼이 접근 가능하다. 최소 창의 긴 작업 결과와 저장 알림은 activity 195.19px·내용 client 161/scroll 232px로 제한된다. 내부를 CUA 스크롤하면 scrollTop=71px·닫기 hit=true이며 본문 scrollTop=0을 보존한다. `goal-native-mcp-orbit109-activity-{closed,bounded-before,bounded-after}-20261009.json`/PNG. |
| 실제 네이티브 승인 거부 결과 | blocked | UI에서 합성 echo 호출 검토 후 승인 대기를 시작했다. 별도 승인 owner 1개·도구 조회를 확인했고, 이후 UI는 `MCP tool call rejected by the user`·owner 부재·tools/call 0을 기록했다. 실제 No 버튼 조작은 자동 도구가 선택하지 못하는 범위이며 사용자 확인도 아직 없으므로 No 통과로 세지 않는다. `goal-native-mcp-orbit109-native-{pending,rejected}-20261009.json`. Yes 이후 실제 호출·모델 후속 응답·실제 호출 중 취소도 여전히 blocked다. |
| 설정·실행·자료 복원 | pass | CUA로 이번 합성 서버를 비활성화·저장하고 작업 알림을 닫은 뒤 원래 Chat과 1280×800 창으로 돌아왔다. 최종 감사 17/17에서 config hash/값·21개 profile 전체 library·39개 대화 목록/hash·localStorage·같은 running PID/engine/model·세션 실행값·API off·idle·빈 composer·error/overlay0·기존 MCP 5개 정의와 enable 상태가 같다. 새 정의 1개만 disabled로 보존하고 합성 root/child 4개가 부재·tools/call 0이다. `goal-resume-orbit109-preservation-v3-20261009.json` 및 `goal-native-audio-resume-orbit109-final-20261009.json`/PNG. 세션의 elapsed idle_seconds만 증가했다. |

검증 조작은 CUA이고 WebDriver는 읽기 전용 상태·DOM·geometry·캡처 관측이다. Browser plugin은 없으며 실제 Tauri를 일반 브라우저로 대체하지 않았다. 의미 있는 화면·페이지 identity·프레임워크 overlay 없음·관측 error 0·캡처·상호작용을 확인했지만 DevTools 전체 console·VoiceOver·Windows/Linux의 실제 화면 검증으로 확대하지 않는다. 감사 helper 초기 버전의 object identity 비교·잘못된 profile 필드/형식과 증가하는 idle_seconds 비교를 구조화된 값·settings_profiles.entries·실행값 검사로 바로잡았다. 초기 기록도 보존했다. 승인 관측의 초기 출력 helper는 event 대신 kind를 읽었으므로 실제 tools/call 0의 근거는 원본 event 배열과 최종 감사다.

`logs/goal-layout-orbit109-{typecheck,lint,unit,build}-20261009.log`에서 각각 10.03s·5.76s·131.40s·12.92s, 종료 0이다. 전체 unit은 계약/direct/script·UI 179 files/1788 tests, coverage80.68/75.57/79.08/84.80%이며 관련 3 files/35 tests도 통과했다. 기존 jsdom 진단·frontend chunk 경고는 남아 있다. CSS의 실제 geometry 회귀를 검사했으며 이를 그대로 옮긴 별도 jsdom layout 검사는 추가하지 않았다. Rust/Python 제품 소스·lockfile은 변경하지 않았다. 커밋 전 staged file/diff·개인정보·공백을 검토했고 `goal-layout-orbit109-committed-source-20261009.json`의 수정 파일 hash는 커밋과 같다.

이 수정은 엔진과 무관한 공통 UI 경계를 유지한다. [개인 엔진 설계](pluggable-inference-runtimes.ko.md)의 registry·manifest·adapter 등록은 여전히 미구현이다. M03/M04/M07 실제 내용 실패·upstream 제한, MCP Yes 이후 호출·트레이/Dock·OS 알림 수신 차단, 별도 계정·Finder·Keychain·upgrade·Intel/구형 macOS의 unrun을 유지하며 **전체 M01–M12는 통과하지 않았다.** raw·캡처·fixture·빌드는 ignored tmp에 보존했고 공개 업로드·원격 push는 수행하지 않았다.

## 47. 작업 알림 배치 수정 소스 `eb2d037`의 arm64 DMG

기존 `npm run package:tauri`로 `eb2d03770c860fe1c998187b6725d4098f2c9db7`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-layout-orbit109-package-eb2d037-20261009.log`, `logs/goal-native-activity-layout-inspect-package-eb2d037-20261009.log`, `goal-native-activity-layout-package-eb2d037-results.json`이 근거다. 빌드 235.04s·검사 4.92s 모두 종료 0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16776745 bytes, SHA256 `b21dc60c689a9600d922c95ce63f8170c00c82c04082227451111c4b0081efb7`.
- GUI `aiolm`: arm64, SHA256 `cd34581f51d75aabd2d97ee35729d63d366a4f3aeee68915e05ee0fa7c5e4aef`.
- CLI `aiolm-cli`: arm64, SHA256 `77bcee63a720b0d1e82d0a403ba7b0c0441685ce5650c6a623b5389e3a8a62b1`.
- GUI·CLI와 빌드 앱의 해시 일치, 일반 파일 5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 home/repository 경로와 검증 fixture 표식 일치 0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료 0을 확인했다. 같은 해시의 DMG는 `goal-package-eb2d037/`에 보존했다.

패키징 후 실제 CUA native Chat 화면을 다시 확인했다. `goal-native-audio-resume-orbit109-postpackage-eb2d037-20261009.json`/PNG와 `goal-layout-orbit109-postpackage-preservation-eb2d037-20261009.json`의 9개 조건에서 config 전체 hash/값·39개 대화 목록/hash·localStorage·동일 running Qwen PID/engine/model·세션 실행값·MCP 정의·API off·idle·빈 composer·관측 error/overlay0과 잠금 해제된 실제 화면을 확인했다. 기존 응답·PP/TG 재표시이며 새 추론 성공으로 설명하지 않는다.

production GUI는 실행하지 않았다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade와 Intel/구형 macOS는 unrun이다. 46절의 수정·패키지 통과를 **전체 M01–M12 통과**로 확대하지 않는다. 개인 엔진 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 48. Chat 최소 창의 전역 MCP 취소와 알림 키보드 동작

`fb90764`에서 제품 코드 변경 없이 `eb2d037`의 공통 activity 배치를 실제 native debug 앱에서 추가 검증했다. 새 dependency·lockfile·기본값·프로필·engine/API/benchmark 계약 변경은 없다. 47절의 패키지 제품 소스와 같다. 최신 네이티브 상태를 먼저 확보하지 않은 첫 CUA 호출은 중단됐다. 현재 상태를 얻고 계속했다.

합성 서버는 46절에서 보존한 disabled 정의를 UI로 선택·활성화·저장하여 사용했다. 조회 후 hold 도구의 합성 인자를 검토하고 앱의 승인 버튼으로 실제 시스템 승인 대기에 진입했다. `goal-native-mcp-orbit110-pending-before-navigation-20261009.json`에서 별도 승인 owner 1개와 실제 initialize/tools/list, tools/call 0을 확인했다. No/Yes를 조작하지 않았으며 이후 취소 결과를 실제 호출 중 취소로 계산하지 않는다.

| 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 화면 전환과 전역 취소 | pass | 시스템 승인 대기 중 CUA로 MCP→Chat 이동. 실제 desktop에서 전역 Cancel과 원래 ORBIT-84 내용·실행 모델·입력 영역이 보였다. 최소 native 360×520 / WKWebView 360×488에서도 전역 Cancel은 hit=true, top=390px/bottom=422px로 접근 가능했고 승인 owner도 여전히 1개였다. `goal-native-mcp-orbit110-chat-minimum-before-scroll-20261009.json`/PNG. |
| 최소 Chat 본문의 입력 접근 | pass | 본문 client 225/scroll 394px에서 CUA로 스크롤했다. scrollTop=169px에 도달하여 textarea·Attach file·Send message·전역 Cancel 모두 hit=true였다. 입력은 enabled이며 전송은 빈 composer에 따라 disabled인 정상 상태다. 새로운 입력 전송·추론 성공을 검증한 것은 아니다. `goal-native-mcp-orbit110-chat-minimum-after-scroll-20261009.json`/PNG. |
| 승인 대기 중 Chat 전역 취소·cleanup | pass | CUA로 Chat의 전역 Cancel을 클릭해 즉시 Cancelled 표시를 확인했다. 이후 승인 owner가 부재하고, 이번 조회와 호출 대기가 각각 만든 root/child의 소유 PID 총 4개가 모두 부재·tools/call 0이었다. MCP로 돌아오면 보존된 `Done / Cancelled` 알림이 표시됐다. `goal-native-mcp-orbit110-cancelled-20261009-v3.json`과 `goal-native-mcp-orbit110-cancelled-return-mcp-20261009.png`. |
| 알림의 실제 키보드·본문 공간 | pass | summary를 포커스하고 Space로 열었다. 본문 bottom과 activity top은 652px, focusedSummary=true/open=true였다. Escape로 접으면 높이 32px·경계 736px·focusedSummary=true/open=false였다. `goal-native-activity-orbit110-{space-open,escape-closed}-20261009.json`. |
| 원래 상태·데이터 복원 | pass | 합성 서버를 UI로 다시 disabled 저장·알림 닫기·원래 Chat/1280×800 창 복원 후 `goal-layout-orbit110-preservation-20261009.json`의 14개 조건이 모두 통과했다. config 전체 hash/값·21개 profile library·39개 대화 목록/hash·localStorage·같은 running PID/engine/model·세션 실행값·기존 6개 MCP 정의가 동일하며 API off·idle·빈 composer·error/overlay0·activity hidden이다. 세션의 idle_seconds 증가만 구분했다. `goal-native-audio-resume-orbit110-{baseline,final}-20261009.json`/PNG. |

취소 직후 실제 CUA 상태는 Cancelled였지만 읽기 전용 첫 후속 helper가 돌아올 때는 기존 6초 자동 정리 규칙에 따라 완료 작업 행이 사라졌다. 첫 두 helper의 cancelled=false를 제품 실패로 세지 않았다. 실제 CUA 취소 결과·반환된 MCP 취소 알림·프로세스 부재로 최종 근거를 보완했고 원본 helper 기록도 유지했다. 이 규칙·시간 제한을 변경하거나 실제 tools/call을 가짜로 생성하지 않았다.

조작은 CUA, WebDriver는 읽기 전용 상태·geometry·캡처 관측이다. 실제 화면의 내용·페이지 identity·프레임워크 overlay 없음·관측 error 0과 상호작용을 확인했으며 전체 DevTools console·VoiceOver 검증으로 확대하지 않는다. 제품 소스가 같아 공통 자동 검사나 패키징을 반복하지 않았다. 새로운 모델·대화·프로필·외부 환경을 만들거나 변경하지 않았다.

실제 네이티브 No/Yes 조작, Yes→tools/call→모델 후속 응답과 실제 호출 중 취소는 여전히 blocked다. 별도 승인 owner를 자동 UI 도구가 선택하지 못하며 46절의 No 사용자 확인도 아직 없다. 트레이/Dock·OS 알림 수신의 blocked와 별도 계정·Finder·Keychain·upgrade·Intel/구형 macOS의 unrun, 기존 모델 내용 실패·upstream 제한을 유지한다. **전체 목표·M01–M12 완료를 증명하지 않는다.** raw·캡처·fixture는 ignored tmp에 보존했고 원격 push는 수행하지 않았다.

## 49. 전체 모델 정보를 펼친 최소 창의 설정 본문 접근 수정

목표 재개 후 `ccd29e1`의 실제 native debug 앱에서 승인창과 무관한 모델 설정 흐름을 추가로 검사했다. 원래 Qwen3-VL 실행을 유지하며 CUA로 모델 설정을 열고 native 360×520 / WKWebView 360×488로 줄였다. 전체 모델 정보 9개를 펼치면 헤더 270px, 본문 부모 56px에 대해 프로필 context가 120px를 차지했다. 본문은 top=449/bottom=481px인데 부모 bottom=385px로 모두 잘린 영역 밖이었다. `goal-model-settings-orbit112-expanded-before-20261009.json`/PNG가 근거다. 모델 정보를 접어 우회하는 것을 성공으로 세지 않았다.

수정 `6515cde9372c514f18eeab07abfb653382943d68`은 공통 모델 설정 CSS만 변경한다. 높이 650px 이하에서 헤더의 정보 부분을 최대 25dvh로 제한해 전체 정보를 독립적으로 스크롤하고, Close 버튼은 정보 영역 밖에 유지한다. 이 경우 metadata 내부의 중복 스크롤을 제거한다. 프로필 context는 최대 min(120px, 40%)로 제한하고 기존 스크롤을 유지해 나머지 본문 공간을 확보한다. 큰 창의 기존 배치, engine·profile·option·readiness·실행 계약과 기본값은 변경하지 않는다.

| 실제 범위 | 상태 | 근거와 결과 |
| --- | --- | --- |
| 최소 창의 펼친 정보와 본문 | pass | 같은 입력·정보 펼침 상태에서 헤더 139px, 본문 112.20px/top=272.80/bottom=385px로 부모 안에 있다. CUA 본문 스크롤 후 `--limit-mm-per-prompt` textarea 전체 top=294.80/bottom=374.80px가 본문 안이며 hit=true, 실제 포커스도 textarea다. 값을 입력하거나 저장하지 않았다. `goal-model-settings-orbit112-{expanded-after,body-input-focused}-20261009.json`/PNG. |
| 전체 metadata·프로필·안내의 독립 접근 | pass | CUA로 헤더 정보 scrollTop=219에 도달해 마지막 video 항목까지 확인했다. 본문 scrollTop=488을 보존하고 Close/Unload hit=true다. context scrollTop=50에서 Save profile/Save as new hit=true, Save profile은 원래 실행 중 프로필 보호에 따라 disabled다. footer summary scrollTop=71에서 Supported inputs: text, image를 확인하고 Unload가 계속 보인다. 다른 영역의 스크롤 값은 보존했다. `goal-model-settings-orbit112-{metadata-bottom,profile-actions,footer-inputs}-20261009.json`/PNG. 이 footer 스크롤은 기존 동작의 검증이다. |
| 정보 접기와 첫 옵션 입력 | pass | 실제 보이는 summary를 클릭해 접고 본문 scrollTop=62에서 `--max-num-seqs` 전체 입력란과 고정 버튼에 접근했다. CUA 클릭의 포커스는 input, hit=true다. `goal-model-settings-orbit112-collapsed-input-focused-20261009.json`/PNG. 첫 숫자 AX summary 클릭은 접히지 않고 정보 영역을 이동시켰으며 현재 캡처 좌표 클릭으로 접었다. 최초 관측도 `collapse-attempt`로 보존했다. |
| 짧은 넓은 창·원래 desktop | pass | native 1280×520 / WKWebView 1280×488의 펼친 정보에서 본문 130.81px, 원래 native 1280×800 / WKWebView 1280×768에서 133px이다. 본문은 각각 부모 안에 있고 첫 옵션·Close·Unload hit=true다. `goal-model-settings-orbit112-{short-wide-expanded,desktop-expanded}-20261009.json`/PNG. 스크롤을 유지한 상태이며 모든 옵션이 한 번에 표시된다는 뜻은 아니다. |
| 원래 상태·자료 보존 | pass | CUA로 대화상자를 닫고 원래 Chat/1280×800 창을 확인했다. `goal-model-settings-orbit112-preservation-20261009.json`의 10개 조건에서 config 전체 hash/값·21개 profile library·39개 대화 목록/hash·localStorage·같은 running PID/engine/model·세션 실행값·API off·idle·빈 composer·관측 error/overlay0을 보존했다. elapsed idle_seconds 증가만 구분했다. `goal-native-audio-resume-orbit111-audit-20261009.json`과 `goal-native-audio-resume-orbit112-final-20261009.json`/PNG를 대조했다. 기존 응답·PP/TG 재표시이며 새 추론은 아니다. |

`goal-model-settings-orbit112-geometry-verification-20261009.json`의 13개 조건이 통과했다. 조작은 CUA이고 WebDriver는 읽기 전용 DOM·geometry·상태·캡처다. 입력 포커스 뒤 CUA AX가 추가 tab을 selected로 표시했지만 실제 DOM의 aria-selected는 Runtime & GPU 하나였으며 설정·탭 선택 변화로 해석하지 않았다. 실제 화면·페이지 identity·프레임워크 overlay 없음·관측 error 0을 확인했지만 DevTools 전체 console·VoiceOver·Windows/Linux의 실제 화면 검증으로 확대하지 않는다. 이번 실제 흐름은 현재 vLLM 모델이며 세 엔진을 다시 실행한 것으로 설명하지 않는다.

`logs/goal-model-settings-orbit112-{related,typecheck,lint,unit,build}-20261009.log`에서 각각 48.04s·12.40s·7.73s·130.58s·12.82s, 종료 0이다. 관련 UI는 3 files/96 tests, 전체 unit은 계약/direct/script·UI 179 files/1788 tests, coverage80.67/75.56/79.08/84.80%다. 기존 jsdom 진단·frontend chunk 경고는 남아 있다. CSS geometry는 실제 WKWebView에서 재현·검증했고 layout을 구현하지 않는 jsdom에 CSS를 그대로 옮긴 검사는 추가하지 않았다. Rust/Python 제품 소스·dependency·lockfile 변경은 없다. staged 파일·실제 diff·개인정보·공백을 검토했고 `goal-model-settings-orbit112-committed-source-20261009.json`의 파일 hash는 커밋과 같다.

추가 재현 결함을 수정한 근거이며 **전체 목표·M01–M12 완료를 증명하지 않는다.** MCP 실제 No/Yes 이후 호출·모델 후속 응답·호출 중 취소, 트레이/Dock·OS 알림 수신의 blocked와 별도 계정·Finder·Keychain·upgrade·Intel/구형 macOS의 unrun, 기존 모델 내용 실패·upstream 제한을 유지한다. 개인 엔진 registry·manifest·adapter는 [장기 설계](pluggable-inference-runtimes.ko.md)이며 아직 구현되지 않았다. raw·캡처·빌드는 ignored tmp에 보존했고 공개 업로드·원격 push는 수행하지 않았다.

## 50. 모델 정보·설정 본문 배치 수정 소스 `6515cde`의 arm64 DMG

기존 `npm run package:tauri`로 `6515cde9372c514f18eeab07abfb653382943d68`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-model-settings-orbit112-package-6515cde-20261009.log`, `logs/goal-native-model-settings-layout-inspect-package-6515cde-20261009.log`, `goal-native-model-settings-layout-package-6515cde-results.json`이 근거다. 빌드 229.41s·검사 4.35s 모두 종료 0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16776602 bytes, SHA256 `183d7566e534bff430d8ee8880732c08ada9b94036d3a6476d19fa04c58012a1`.
- GUI `aiolm`: arm64, SHA256 `960ae11273c6a43e6b32e07c220e93a9b01f598236a4d1348a23446b5310a2c1`.
- CLI `aiolm-cli`: arm64, SHA256 `584cf75be622be1d70f0176f7dca5778741c56526abd8994a8a31f73631d93c7`.
- GUI·CLI와 빌드 앱의 해시 일치, 일반 파일 5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 home/repository 경로와 검증 fixture 표식 일치 0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료 0을 확인했다. 같은 해시의 DMG는 `goal-package-6515cde/`에 보존했다.

패키징 후 실제 CUA native Chat 화면을 다시 확인했다. `goal-native-audio-resume-orbit112-postpackage-6515cde-20261009.json`/PNG와 `goal-model-settings-orbit112-postpackage-preservation-6515cde-20261009.json`의 10개 조건에서 config 전체 hash/값·21개 profile library·39개 대화 목록/hash·localStorage·동일 running PID/engine/model·세션 실행값·API off·idle·빈 composer·관측 error/overlay0을 보존했다. 기존 응답·PP/TG 재표시이며 새 추론 성공으로 설명하지 않는다.

production GUI는 실행하지 않았다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade와 Intel/구형 macOS는 unrun이다. 49절의 수정·패키지 통과를 **전체 M01–M12 통과**로 확대하지 않는다. 개인 엔진 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 51. 같은 대화 재선택의 미전송 입력·첨부 보존 수정

`82e0c94`의 실제 native debug 앱에서 현재 대화에 합성 미전송 입력을 넣고, 대화 검색으로 같은 대화를 찾은 뒤 현재 선택된 행을 다시 클릭했다. 대화·응답·모델·지표는 그대로인데 입력이 비고 Send가 disabled가 됐다. `goal-native-audio-orbit113-reselect-{before,after-beforefix}-20261009.json`/PNG가 근거다. 입력을 전송하거나 새 대화를 생성하지 않았다.

원인은 `selectThread`가 같은 activeThreadId에도 전환용 `onSwitchThread`를 호출하는 것이었다. 이 callback은 입력·첨부·선택한 skill·Chat 로컬 상태를 초기화한다. 수정 `63983487e4b62d72a6f2efac0b96e9dee990ed06`은 목록 닫기를 유지하고 같은 ID에는 전환 처리를 하지 않는다. 다른 ID 선택의 기존 buffer·진행 중 응답 소유권·composer 초기화, New chat·삭제·history hydration·엔진/프로필/API/benchmark 계약과 기본값은 변경하지 않는다.

| 실제 범위 | 상태 | 근거와 결과 |
| --- | --- | --- |
| Desktop 동일 대화 재선택 | pass | 같은 합성 입력과 현재 대화 행을 실제 CUA로 다시 선택해 입력 보존·Send enabled를 확인했다. `goal-native-audio-orbit113-reselect-afterfix-20261009.json`/PNG. 기존 응답·PP/TG이며 새 추론은 아니다. |
| 다른 기존 대화 선택 | pass | 검색 후 다른 기존 대화를 CUA로 선택하면 composer가 비고 해당 저장 응답·Gemma 모델 이름·PP/TG·출력 한도 안내가 표시된다. 고정 실행 영역은 실행 중 Qwen을 유지한다. `goal-native-audio-orbit113-different-thread-20261009.json`/PNG. 기존 부분 응답 재표시이며 새 모델 실행·전체 응답 성공으로 설명하지 않는다. |
| 최소 창 목록 닫힘·입력 보존 | pass | 원래 대화로 돌아와 같은 합성 입력을 넣고 native 360×520 / WKWebView 360×488에서 Conversations→현재 대화 선택을 실행했다. 목록은 실제로 닫히고 aria-expanded=false, 입력은 동일하며 Send enabled다. `goal-native-audio-orbit113-minimum-reselect-afterfix-20261009.json`/PNG와 `goal-chat-draft-orbit113-minimum-controls-20261009.json`. |
| 화면 왕복 | pass | 1280×800으로 복원 후 합성 입력을 둔 채 CUA로 Chat→Projects→Chat 왕복. 현재 대화·검색·입력이 유지됐다. project를 수정·저장·Apply하지 않았다. `goal-native-audio-orbit113-navigation-return-20261009.json`/PNG. 기존 화면 상태 보존 검증이며 이 왕복 동작을 새로 구현한 것은 아니다. |
| 원래 상태·자료 보존 | pass | CUA로 자신의 합성 입력과 검색만 비워 원래 Chat/1280×800으로 복원했다. `goal-chat-draft-orbit113-verification-preservation-20261009.json`의 16개 조건에서 위 재현/수정과 config 전체 hash/값·21개 profile library·39개 대화 목록/hash·localStorage·같은 running PID/engine/model·세션 실행값·API off·idle·빈 composer/검색·관측 error/overlay0을 확인했다. 세션 idle_seconds 증가만 구분했다. `goal-native-audio-resume-orbit113-{baseline,final}-20261009.json`/PNG를 대조했다. |

합성 ChatPanel 회귀는 서로 다른 저장 대화 2개와 문서를 사용해 미전송 입력·첨부 문서가 같은 대화 선택에서 보존되고, 다른 대화 선택에서는 기존대로 초기화되며 요청이 발생하지 않는 것을 검사한다. 수정 전 `logs/goal-chat-draft-orbit113-regression-before-20261009.log`는 기대 입력이 빈 값이어서 실패했고, 수정 후 관련 검사에서 통과했다. 최초 실행은 해당 새 검사만 선택한 run이며 나머지 32개를 실행한 것으로 계산하지 않는다. 실제 파일 선택·skill 선택·승인 이후 호출을 이번에 추가 검증한 것으로 확대하지 않는다.

`logs/goal-chat-draft-orbit113-{related,typecheck,lint,unit,build}-20261009.log`는 각각 7.88s·12.12s·7.54s·131.38s·12.28s, 종료 0이다. 관련 UI는 3 files/42 tests, 전체 unit은 계약/direct/script·UI 179 files/1789 tests, coverage80.68/75.56/79.08/84.80%다. 기존 jsdom 진단·frontend chunk 경고는 남아 있다. Rust/Python 제품 소스·dependency·lockfile·공개 타입 변경은 없다. staged 파일·실제 diff·개인정보·공백을 검토했고 `goal-chat-draft-orbit113-committed-source-20261009.json`의 두 파일 hash는 커밋과 같다.

UI 조작은 CUA이며 WebDriver는 읽기 전용 상태·DOM·캡처다. 실제 화면·페이지 identity·프레임워크 overlay 없음·관측 error 0을 확인했지만 전체 DevTools console·VoiceOver·Windows/Linux의 실제 화면 검증으로 확대하지 않는다. 이번 실제 흐름은 현재 vLLM 실행이며 MLX 기록 재표시를 MLX 재실행으로 계산하지 않는다. MCP 실제 No/Yes 이후 호출·모델 후속 응답·호출 중 취소와 트레이/Dock·OS 알림 수신의 blocked, 별도 계정·Finder·Keychain·upgrade·Intel/구형 macOS의 unrun, 기존 모델 내용 실패·upstream 제한을 유지한다. **전체 목표·M01–M12 완료는 증명하지 않는다.** 개인 엔진 registry·manifest·adapter는 미구현 장기 설계다. raw·합성 자료·빌드는 ignored tmp에 보존했고 공개 업로드·원격 push는 수행하지 않았다.

## 52. 미전송 채팅 보존 수정 소스 `6398348`의 arm64 DMG

기존 `npm run package:tauri`로 `63983487e4b62d72a6f2efac0b96e9dee990ed06`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-chat-draft-orbit113-package-6398348-20261009.log`, `logs/goal-native-chat-draft-inspect-package-6398348-20261009.log`, `goal-native-chat-draft-package-6398348-results.json`이 근거다. 빌드 229.77s·검사 6.07s 모두 종료 0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16777213 bytes, SHA256 `1bdb34e6396ef99d19b5bddaaafb34a8f38122073b3d6f17b85b323d99bbb959`.
- GUI `aiolm`: arm64, SHA256 `26f1ac8aaa24218e4546b9a7073338987ebbf4305a4394da28a3a7fb60cccc2a`.
- CLI `aiolm-cli`: arm64, SHA256 `584cf75be622be1d70f0176f7dca5778741c56526abd8994a8a31f73631d93c7`.
- GUI·CLI와 빌드 앱의 해시 일치, 일반 파일 5개·symlink 없음, identifier/version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 home/repository 경로와 검증 fixture 표식 일치 0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·종료 0을 확인했다. 같은 해시의 DMG는 `goal-package-6398348/`에 보존했다.

패키징 후 실제 CUA native Chat 화면을 다시 확인했다. `goal-native-audio-resume-orbit113-postpackage-6398348-20261009.json`/PNG와 `goal-chat-draft-orbit113-postpackage-preservation-6398348-20261009.json`의 11개 조건에서 config 전체 hash/값·21개 profile library·39개 대화 목록/hash·localStorage·동일 running PID/engine/model·세션 실행값·API off·idle·빈 composer/검색·관측 error/overlay0을 보존했다. 기존 응답·PP/TG 재표시이며 새 추론 성공으로 설명하지 않는다.

production GUI는 실행하지 않았다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade와 Intel/구형 macOS는 unrun이다. 51절의 수정·패키지 통과를 **전체 M01–M12 통과**로 확대하지 않는다. 개인 엔진 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.


## 53. macOS 승인 오류와 실제 사용자 거부의 구분

`625cb62`에서 macOS 승인 처리는 scripting process가 비정상 종료하면 원인과 관계없이 `Ok(false)`를 반환했고 공통 MCP 호출이 이를 사용자 거부로 표시했다. 실제 No 클릭 없이 종료 코드 1·5를 반환하는 최소 합성 회귀가 `Ok(false)` 때문에 실패했다. `logs/goal-mcp-approval-orbit114-regression-before-20261009.log`가 근거다. 46절의 실제 거부 표시가 이 오류에서 비롯됐다고 확정하지 않는다. 당시 No 조작·실행 오류의 원인은 여전히 미확인이다.

수정 `80510a86526779bcb72a892fd7badca39541c702`은 macOS 승인 응답만 변경한다. Cocoa No/Yes는 각각 명시된 `rejected`/`approved` 답변을 반환하며 성공 종료와 정확한 답변을 함께 확인한다. 비정상 종료·빈 값·추가 내용·예상 밖 응답·과도한 출력은 오류이며 도구를 실행하지 않는다. 응답을 32 bytes로 제한하고 큰 출력도 pipe가 찰 때까지 기다리지 않고 소유 프로세스를 정리한다. 기존 `Result<bool, String>` 계약·공통 승인 정책·120초 deadline·소유 process group·취소·Windows/Linux 처리를 보존한다. 오류를 숨기거나 임의 성공 응답을 승인으로 인정하지 않는다.

`logs/goal-mcp-approval-orbit114-related-final-20261009.log`는 7 passed/1 ignored다. 명시된 승인/거부, 실패와 잘못된 성공 응답, 큰 출력, 취소/deadline의 lifetime socket 종료, 도구 설명의 argv 보존을 검사했다. 실제 시스템 JavaScript의 문자열 직렬화도 UI를 열거나 조작하지 않고 확인했다. hosted-runner 전용 실제 Cocoa 취소 검사는 조건을 위조하지 않아 ignored이며 통과로 계산하지 않는다. 합성 답변은 실제 사람이 No/Yes를 클릭한 근거가 아니다.

| 실제 앱 범위 | 상태 | 근거와 한계 |
| --- | --- | --- |
| 정상 종료·새 native 빌드 | pass | CUA의 Quit AioLM으로 기존 앱과 Qwen 소유 process group의 4개 PID·engine/Vite/driver listener가 종료됐다. `goal-mcp-approval-orbit114-normal-quit-cleanup-20261009.json`. 새 debug 빌드·기존 격리 홈으로 다시 실행했다. ad-hoc bundle 서명으로 전체 binary hash는 달라지며 Mach-O compiled text hash 일치와 strict 서명을 별도로 확인했다. `goal-mcp-approval-orbit114-native-{source,codesign-source}-20261009.json`. |
| 저장된 모델 복원·MCP 조회 | pass | 실제 UI의 Save profile & start로 같은 vllm-metal/Qwen3-VL revision·context·실행 옵션을 복원해 model loaded를 확인했다. CUA로 기존 합성 서버를 선택·Discover tools를 실행해 metadata 완료, tools/list·소유 PID 종료·tools/call 0을 확인했다. `goal-native-audio-orbit114-{qwen-ready-check,mcp-discovery}-20261009.json`/PNG, `goal-mcp-approval-orbit114-discovery-cleanup-20261009.json`. 새 추론·승인 후 도구 실행의 성공으로 계산하지 않는다. |
| 원래 화면·내용 보존 | pass | 조회 알림을 닫고 원래 Chat/1280×800으로 복원했다. `goal-mcp-approval-orbit114-restored-preservation-20261009-v2.json`의 16개 조건은 39개 대화 목록/hash·localStorage·21개 profile 내용·application 내용·비-profile 설정·같은 engine/model/execution·API off·idle/빈 composer·관측 error/overlay0·기존 프로세스 정리를 확인한다. 앱 재시작으로 PID가 바뀌었으며 저장/시작의 기존 동작으로 Default vLLM profile revision 11→12, 해당 application revision, library revision64→66만 증가했다. config hash 불변이라고 주장하지 않는다. 첫 전체 동등성 검사의 실패 기록과 실제 revision delta도 보존했다. `goal-native-audio-resume-orbit114-{baseline,restored}-20261009.json`/PNG. |

공통 UI 첫 run은 프로필 저장 콜백 호출 직후 화면까지 갱신됐다고 가정하여 1개가 실패했다. `c5a35fa`는 실제 선택기 갱신을 기존 waitFor로 기다리는 검사 수정이며 제품 동작·기대값·시간 제한을 바꾸지 않는다. 해당 파일 63개가 통과했다. 다음 전체 run은 App navigation 1개와 Tuning options 2개가 실패했다. 그 두 파일은 같은 소스로 따로 실행하면 42개가 통과했고, 이후 별도 빌드·모델 startup을 겹치지 않은 원래 `npm run test:unit` 전체 run에서 179 files/1789 tests가 통과했다. 부하가 실패 원인이라고 확정하지 않으며 두 초기 실패 로그를 유지한다. `logs/goal-mcp-approval-orbit114-{unit,unit-final,profile-related,navigation-tuning-triage,unit-steady}-20261009.log`; 마지막 전체 run은 128.17s/exit0, coverage80.68/75.56/79.08/84.80%다. 기존 jsdom 진단·frontend chunk 경고는 유지한다.

`logs/goal-mcp-approval-orbit114-{typecheck,lint,build,fmt-check,clippy,rust-all,python-probe,python-portable,native-build}-20261009.log`는 각각 29.41s·11.49s·25.08s·0.75s·16.02s·53.92s·1.90s·0.12s·18.10s/exit0이다. Rust 전체 타깃·feature의 library943 passed/4 ignored와 CLI15·합성 integration 검사, Python14+3을 확인했다. 명시 실행을 요구하는 기존 live/hosted 검사는 이번에 재실행한 것으로 계산하지 않는다. dependency·lockfile·공개 타입 변경은 없으며 staged 파일·실제 diff·개인정보·공백을 검토했다. `goal-mcp-approval-orbit114-committed-source-20261009.json`의 승인 소스 hash는 실제 native 빌드와 같다.

실제 새 Cocoa No/Yes, Yes 이후 tools/call·모델 후속 응답·실제 호출 중 취소는 별도 창을 CUA가 선택하지 못해 여전히 blocked다. 이 한계를 성공으로 바꾸거나 승인 정책을 우회하지 않았다. 트레이/Dock·OS 알림의 blocked, 별도 계정/Finder/Keychain/upgrade·Intel/구형 macOS의 unrun과 기존 모델 내용 실패·upstream 제한을 유지한다. **전체 목표·M01–M12는 통과하지 않았다.** MCP 승인은 엔진과 무관한 host 기능이며 개인 엔진 registry·manifest·adapter는 [장기 설계](pluggable-inference-runtimes.ko.md)로 아직 미구현이다. raw·fixture·빌드는 ignored tmp에 보존했고 공개 업로드·원격 push는 수행하지 않았다.


## 54. 승인 오류 구분 수정 소스 `80510a8`의 arm64 DMG

기존 `npm run package:tauri`로 `80510a86526779bcb72a892fd7badca39541c702`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-mcp-approval-orbit114-package-80510a8-20261009.log`, `logs/goal-native-mcp-approval-inspect-package-80510a8-20261009.log`, `goal-native-mcp-approval-package-80510a8-results.json`이 근거다. 빌드227.87s·검사2.18s 모두 exit0이며 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16798967 bytes, SHA256 `e1c9b9b5847cf1ac68af1e3a30fd324d1cf4d74e2ea7020a36c03cc9943aefbc`.
- GUI `aiolm`: arm64, SHA256 `ed29d7f4eaaab63532c253570895e3c36c39145daae3ed0e5b9bd3d16a9a5b4f`.
- CLI `aiolm-cli`: arm64, SHA256 `cf4cb7820ccfc69dbe8cd7449e3e78330ee7e9d326c5c124c19fbfece5a33f43`.
- GUI·CLI와 빌드 앱의 해시 일치, 일반 파일5개·symlink 없음, version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 경로와 추가 ORBIT-109·110·112–114 검증 표식을 포함한 fixture 일치0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·exit0을 확인했다. 같은 DMG는 `goal-package-80510a8/`에 보존했다.

패키징 후 CUA로 실제 개발 앱의 원래 Chat·실행 중 Qwen을 다시 확인했다. `goal-native-audio-resume-orbit114-postpackage-80510a8-20261009.json`/PNG, `goal-mcp-approval-orbit114-postpackage-preservation-80510a8-20261009.json`의 11개 조건은 53절의 재시작/저장 뒤 복원 상태와 비교한 config 전체 hash/값·21개 profile library·39개 대화 목록/hash·localStorage·동일 running PID/engine/model·execution·세션 실행값·API off·idle/빈 composer·관측 error/overlay0의 보존이다. 이전 재시작 전 revision이나 PID가 불변이었다는 뜻이 아니다. 기존 응답·PP/TG 재표시이며 새 추론 성공으로 설명하지 않는다.

production GUI는 실행하지 않았다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade와 Intel/구형 macOS는 unrun이다. 53절의 blocked와 기존 실제 실패·upstream 제한을 유지하며 **전체 목표·M01–M12 통과를 뜻하지 않는다.** 개인 엔진 registry·manifest·adapter 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 55. 엔진별 backend 진단과 짧은 창의 로그 끝 접근 수정

`40a8197`의 실제 native debug 앱에서 vllm-metal/Qwen3-VL이 실행 중인데 `server_status.lifecycle.effective_backend`는 저장된 llama.cpp 선택인 `cpu`였다. 고정 실행 영역과 RuntimeSelectionLabel은 이미 Metal을 정확히 표시했으므로 화면 runtime label이 CPU였다고 해석하지 않는다. `goal-runtime-diagnostics-orbit115-backend-before-20261009.json`과 `goal-native-audio-resume-orbit115-baseline-20261009.json`이 근거다.

수정 `e70ec9eacf6e3d61d289091c830bfd07cac069c7`은 실제 engine identity를 먼저 확인하고 llama.cpp에서만 해당 backend 값을 제공한다. vLLM·MLX에서는 null이며 runtime identity는 기존 `engine` payload가 제공한다. `LifecycleDiagnostics` 타입에도 이미 가능한 null을 반영했다. 저장된 backend/build·실행 옵션·공용 프로필·기본값은 보존하며 임의로 Metal 문자열을 넣지 않는다. 합성 회귀는 vLLM/MLX의 저장 CPU, native CPU/Metal/빈 값과 실행 identity가 저장 provider보다 우선하는 전체 상태 응답 경로를 검사한다. 수정 전 검사는 cpu/null 불일치로 exit101, 수정 후 관련17개는 pass다. `logs/goal-runtime-diagnostics-orbit115-{regression-before,related}-20261009.log`가 근거이며 첫 run의 filtered 검사들을 실행한 것으로 세지 않는다.

실제 최소 창의 로그에서도 결함을 재현했다. native360×520 / WKWebView360×488에서 포커스한 로그에 End를 누르면 scrollTop1852+clientHeight400=scrollHeight2252로 끝에 도달하지만 영역 bottom709.375px가 viewport488px 밖이었다. 짧은 창의 Diagnostics에만 남은 본문 높이를 사용하는 flex 배치를 적용했다. 로그 내용·기존 스크롤·키보드 동작을 보존하며 API 예제나 큰 창의 스타일 범위를 넓히지 않는다.

| 실제 범위 | 상태 | 근거와 결과 |
| --- | --- | --- |
| 최소 창 Home/End | pass | 같은 전체 로그에서 높이145.625px/bottom455px, End scrollTop2106으로 마지막 `Application startup complete.`가 화면 안에 보인다. Home은 scrollTop0이며 포커스·hit=true, 모델/runtime/Unload도 접근 가능하다. 외부 본문 scrollHeight387=clientHeight387, 가로 넘침 없음. `goal-runtime-diagnostics-orbit115-{minimum-keyboard-log,minimum-keyboard-log-after,minimum-home}-20261009.json`과 `goal-native-audio-orbit115-diagnostics-keyboard-{before,after}-20261009.json`/PNG. |
| 짧은 넓은 창·desktop | pass | WK1280×488에서 로그217.625px/bottom455px와 End 끝 위치, WK1280×768에서 기존 높이400px/bottom637.375px를 확인했다. header control 접근·가로 넘침 없음. `goal-runtime-diagnostics-orbit115-{short-wide-end,desktop}-20261009.json`. `geometry-verification`의12개 조건이 통과했다. 실제 API stopped 화면도 CUA로 확인했으나 API 요청이나 모든 예제를 새로 검증한 것은 아니다. |
| 정상 종료·새 native 실행 | pass | CUA Cmd+Q 후 기존 앱/engine 소유4개 PID와 engine/Vite/driver 포트 종료, launcher exit0을 확인했다. 종료 뒤 AX 조회가 이전 bundle을 다시 열어 새 첫 launcher가 단일 인스턴스로 exit0했다. 이를 성공으로 세지 않고 다시 열린 앱을 정상 종료한 뒤 별도 retry 로그로 새 bundle을 실행했다. `goal-runtime-diagnostics-orbit115-{normal-quit-cleanup,launch-race}-20261009.json`과 `logs/goal-runtime-diagnostics-orbit115-{launch,retry-launch}-20261009.log`. 이전 dead driver 조회 실패도 남겼다. |
| 새 바이너리의 실제 진단 | pass | 동일 격리 홈에서 UI Save profile & start로 같은 Qwen revision/context/runtime를 복원했다. 실제 running 응답의 provider=vllm/variant=vllm-metal, effective_backend=null이며 저장 config와 execution의 backend=cpu는 보존된다. `goal-runtime-diagnostics-orbit115-backend-after-20261009.json`, `goal-native-audio-orbit115-qwen-ready-check-20261009.json`/PNG. 최소 창 End를 다시 실행해 bottom455px/마지막 줄을 확인했다. `goal-native-audio-orbit115-native-rebuilt-minimum-end-20261009.json`/PNG. 새 추론 성공으로 계산하지 않는다. |
| 원래 화면·내용 보존 | pass | Chat/1280×800으로 복원했다. 재시작 전 레이아웃 검사 동안 config 전체/hash·같은 PID와 대화/localStorage 등10개 보존 조건이 통과했다. 재시작 뒤16개 조건은39개 대화 목록/hash·21개 profile 내용·localStorage·비-profile 설정·같은 engine/model/execution·API off·idle/빈 composer·error/overlay0과 진단 수정을 확인한다. Save profile & start의 기존 동작으로 Default vLLM revision12→13, 해당 application revision 하나, library66→68만 증가하고 PID는 바뀌었다. `goal-runtime-diagnostics-orbit115-{before-restart-preservation,restored-preservation}-20261009.json`, `goal-native-audio-orbit115-{before-restart-restored,restored}-20261009.json`/PNG. config hash 불변이라고 주장하지 않는다. |

`logs/goal-runtime-diagnostics-orbit115-{frontend-related,typecheck,lint,unit,build,fmt-check,clippy,rust-all,python-probe,python-portable,native-build}-20261009.log`는 각각2.83s·10.04s·5.67s·129.63s·14.61s·0.76s·5.24s·43.53s·0.78s·0.14s·15.84s/exit0이다. 관련 UI3 files/26 tests, 공통 unit의 계약/direct/script와 UI179 files/1789 tests, coverage80.68/75.56/79.08/84.80%를 확인했다. Rust library946 passed/4 ignored와 CLI15·합성 integration, Python14+3도 통과했다. 명시 실행을 요구하는 기존 live/hosted 검사의 ignored를 pass로 계산하지 않는다. 기존 jsdom 진단과 frontend chunk 경고는 남겼다. CSS 배치는 실제 WKWebView에서 검증했으며 jsdom에 배치를 흉내 낸 검사는 추가하지 않았다.

`goal-runtime-diagnostics-orbit115-native-source-20261009.json`과 `committed-source`에서 native 빌드의 제품3파일 hash와 커밋 일치, ad-hoc 서명 전후 Mach-O compiled text hash 일치·strict 서명을 확인했다. 서명으로 전체 binary hash는 달라진다. staged 파일·실제 diff·개인정보·공백을 검토했고 dependency·lockfile 변경은 없다. UI 조작은 CUA이며 WebDriver는 읽기 전용 상태·geometry·캡처다. 이번 실제 엔진은 vLLM이며 MLX/llama.cpp를 다시 실행한 근거로 확대하지 않는다.

MCP 실제 No/Yes→호출·모델 후속 응답·호출 중 취소, 트레이/Dock·OS 알림의 blocked와 별도 계정/Finder/Keychain/upgrade·Intel/구형 macOS의 unrun, 기존 내용 실패/upstream 제한을 유지한다. **전체 목표·M01–M12는 통과하지 않았다.** 개인 엔진 registry·manifest·adapter는 미구현 [장기 설계](pluggable-inference-runtimes.ko.md)다. raw·캡처·빌드는 ignored tmp에 보존했으며 공개 업로드·원격 push는 수행하지 않았다.

## 56. 진단 metadata·로그 배치 수정 소스 `e70ec9e`의 arm64 DMG

기존 `npm run package:tauri`로 `e70ec9eacf6e3d61d289091c830bfd07cac069c7`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-runtime-diagnostics-orbit115-package-e70ec9e-20261009.log`, `logs/goal-native-runtime-diagnostics-inspect-package-e70ec9e-20261009.log`, `goal-native-runtime-diagnostics-package-e70ec9e-results.json`이 근거다. 빌드232.55s·검사5.00s/exit0, 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16799110 bytes, SHA256 `1236c025b5ed86da021fccf600204c0416f84ba960287e9cbf3912cd7b8890ae`.
- GUI `aiolm`: arm64, SHA256 `d6ddf948ceebc3eac8fd01c135a824534517970a68c0e218a02e19c730f49ec8`.
- CLI `aiolm-cli`: arm64, SHA256 `af6ff9df14a35834c9a232fab34f714d1e2bf6e18034f480e0e038c7394ce898`.
- GUI·CLI와 빌드 앱의 해시 일치, 일반 파일5개·symlink 없음, version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 경로와 ORBIT-115 등을 포함한 검증 fixture 표식 일치0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·exit0을 확인했다. 같은 DMG는 `goal-package-e70ec9e/`에 보존했다.

패키징 후 CUA로 실제 개발 앱의 Chat·Qwen model loaded를 다시 확인했다. `goal-native-audio-orbit115-postpackage-e70ec9e-20261009.json`/PNG와 `goal-runtime-diagnostics-orbit115-postpackage-preservation-e70ec9e-20261009.json`의11개 조건에서 재시작 뒤 복원 상태와 비교한 config 전체/hash·profile library·39개 대화 목록/hash·localStorage·동일 running PID/engine/model/execution·수정된 backend 진단·API off·idle/빈 composer·error/overlay0을 확인했다. 재시작 전 revision/PID의 불변이나 새 추론 성공을 의미하지 않는다.

production GUI는 실행하지 않았다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade와 Intel/구형 macOS는 unrun이다. 55절의 blocked와 기존 실제 실패/upstream 제한을 유지하며 **전체 목표·M01–M12 통과를 뜻하지 않는다.** 개인 엔진 registry·manifest·adapter 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 57. 모델 세션의 런타임 자원 잠금을 관리 화면에 반영

`a7be918`의 실제 개발 앱에서 Qwen/vllm-metal이 실행 중인데 환경 설치·삭제·Python bundle 전송 버튼이 활성화되어 있었다. CUA로 Export를 누르면 파일 선택 전에 backend의 `stop model sessions before exporting a runtime` 오류가 표시됐다. native 보호 조건은 이미 기본·별도 세션의 Starting/Ready/Stopping을 확인하며, 재현은 보호 실패나 외부 환경 삭제가 아니다. `goal-native-audio-orbit116-runtime-export-before-20261009.json`/PNG와 `runtime-minimum-before`가 근거다. 실제 설치·삭제 버튼으로 환경을 변경하지 않았다.

수정 `7ad2605563de61106e1360bafb985c595164cf89`은 기본 세션의 running뿐 아니라 starting/stopping과 별도 세션의 busy 상태를 기존 공통 session poller로 읽는다. 새 poll timer나 엔진 전용 분기를 추가하지 않고 boolean만 상태로 보관한다. Python 설치·등록·삭제·export/import를 잠그고 이유를 한국어·영어·일본어·중국어로 제공한다. 입력 경로 준비와 진행 중인 작업의 취소는 유지한다. 같은 관리 controller를 쓰는 native 작업과 deep 버튼도 공통 자원 상태를 받는다. backend의 최종 보호 조건·readiness·취소·기본값·공개 API와 dependency/lockfile은 변경하지 않았다.

실제 실행은 기존 vllm-metal0.30.0/vLLM0.30.0+cpu와 Qwen3-VL-2B-Instruct-4bit snapshot revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`, context4096을 사용했다. 새 모델 다운로드나 runtime 설치는 수행하지 않았다.

| 실제 범위 | 상태 | 근거와 결과 |
| --- | --- | --- |
| 기본 세션 실행 중 | pass | CUA로 관리 화면을 확인해 Python 작업5종이 비활성화되고 안내가 표시된다. 최소 창에서도 버튼·고정 실행 영역을 확인했다. `goal-native-audio-orbit116-runtime-minimum-locked-20261009.json`/PNG. |
| 기본 세션 중지 후 | pass | 실제 Stop session 뒤 전체 stopped에서 안내가 사라지고 설치·export·삭제·import/deep 버튼이 활성화된다. 빈 Python 입력의 Register는 기존 조건으로 비활성 상태다. `goal-native-audio-orbit116-runtime-all-stopped-unlocked-20261009.json`/PNG. |
| 별도 세션 시작·준비 완료 | pass | 격리 홈에 이번 검증용 세션 정의 하나를 만들고 같은 Qwen revision/runtime/options로 로드했다. 기본 모델은 stopped인 상태에서 별도 starting을 확인했고, session poll 후 작업5종과 deep 잠금을 확인했다. 준비 완료 row에는 Qwen 모델명·runtime·running·요청0이 표시된다. `goal-native-audio-orbit116-named-{starting,runtime-observed,runtime-locked,ready}-20261009.json`/PNG, `goal-runtime-lock-orbit116-named-desktop-locked-20261009.json`. |
| 창·버튼 동작 | pass | CUA disabled Export 클릭 후 새 파일 선택/실패 배너가 나타나지 않았다. native1280×800/WK1280×768와 native360×520/WK360×488에서 안내와 제목 간격12px, 가로 넘침 없음. 작은 창은 본문을 스크롤해 안내 전체와 제목을 확인했다. `goal-runtime-lock-orbit116-named-{desktop,minimum}-locked-20261009.json`, `goal-native-audio-orbit116-named-minimum-locked-20261009.json`/PNG. |
| 별도 세션 중지·정리·해제 | pass | 실제 Stop session 뒤 소유 process group의3개 PID와 해당 listener가 없어졌다. 전체 stopped의 관리 버튼 해제·빈 입력 Register 조건을 확인한 뒤, 이번에 만든 정의만 UI Remove로 정리했다. 외부 runtime/model은 보존했다. `goal-runtime-lock-orbit116-{named-cleanup,named-stopped-unlocked}-20261009.json`, `goal-native-audio-orbit116-named-stopped{-unlocked,}-20261009.json`/PNG. |
| 기본 실행·Chat 복원 | pass | 실제 Save profile & start로 기존 Qwen을 다시 로드했다. 기본 starting 상태의 관리 잠금도 별도 캡처했고, running 뒤1280×800 Chat으로 복원했다. `goal-runtime-lock-orbit116-default-starting-locked-20261009.json`, `goal-native-audio-orbit116-{default-starting-locked,restored}-20261009.json`/PNG. 새 추론을 전송한 검사는 아니다. |

UI는 공유 poll 결과를 반영하므로 실제 별도 세션 시작 직후 첫 관리 화면에는 이전 stopped snapshot의 활성 버튼이 잠시 보였다. 다음 poll의 starting snapshot에서 잠금이 표시됐다. 이 관측도 `named-runtime-observed`에 남겼으며 즉시/원자적 UI 잠금이라고 주장하지 않는다. 그 사이와 poll 실패·경쟁 상황의 최종 판정은 기존 backend가 계속 수행한다. 별도 엔진 로그의 AVFoundation 중복 class 경고도 숨기지 않았으며 이번 확인에서는 readiness가 성공했다.

`goal-runtime-lock-orbit116-verification-20261009.json`의16개 보존·7개 통합 조건은 모두 pass다.39개 대화 목록/hash,21개 profile 내용·다른 revision, localStorage, 비-profile 설정과 engine/model/execution을 보존하고 API off·idle/빈 composer·관측 error/overlay0을 확인했다. UI 저장·시작의 기존 동작으로 Default vLLM revision13→14, 해당 적용 revision 하나, library68→72가 바뀌었다. 이번 별도 세션 정의는 원래와 같이0개로 복원되지만 그 실행의 적용 snapshot 하나는 기존 저장 정책대로 남는다. 새 PID와 config hash 불변을 주장하지 않는다.

수정 전 최소 회귀는2.51s/exit1이며5개 filtered 검사를 실행한 것으로 세지 않는다. 구현 도중 첫 관련 run의5 failed/42 passed·5.60s/exit1도 보존했고 통과로 세지 않는다. 완성 후 관련4 files/47 tests는4.45s/exit0이다. `logs/goal-runtime-lock-orbit116-{regression-before,related,related-final}-20261009.log`가 근거다. 실제 안내 간격을 마무리한 최종 소스에서 typecheck10.92s·lint6.35s·공통 unit127.44s·frontend build13.43s/exit0을 확인했다. unit은 계약/direct/script와 UI179 files/1794 tests, coverage80.69/75.59/79.11/84.81%다. `logs/goal-runtime-lock-orbit116-{typecheck-final,lint-final,unit-final,build-final}-20261009.log`에 기존 jsdom 진단·chunk 경고도 남겼다. Rust/Python 소스 변경은 없으며55절의 해당 자동 검사를 새 실행으로 계산하지 않는다.

Browser plugin은 제공되지 않았다. 실제 Tauri UI 조작은 CUA, WebDriver는 읽기 전용 IPC·DOM geometry·캡처에 사용했다. 페이지 identity·의미 있는 화면·framework overlay 부재·이벤트로 관측한 error/rejection·실제 클릭/시작/중지·desktop/최소 창 캡처를 확인했으며 전체 DevTools console을 검증한 것으로 확대하지 않는다. React 검토에서는 공통 poller의 단일 요청·timer·listener 정리, 파생 boolean, 기존 취소와 접근성 안내·typed prop 보존을 확인했다. staged 파일·실제 diff·개인정보·공백 검토 후 제품6파일만 커밋했다.

이번 실제 runtime은 vLLM이다. MLX/llama.cpp 재실행이나 개인 엔진 등록의 검증을 뜻하지 않는다. MCP 실제 No/Yes→호출·모델 후속 응답·호출 중 취소, 트레이/Dock·OS 알림·실제 ffmpeg 부재의 blocked와 별도 계정/Finder/Keychain/upgrade·Intel/구형 macOS의 unrun, 기존 실제 실패/upstream 제한을 유지한다. **전체 목표·M01–M12는 통과하지 않았다.** 개인 엔진 registry·manifest·adapter는 미구현 [장기 설계](pluggable-inference-runtimes.ko.md)이며 공통 기능의 엔진 분리는 계속 목표다. raw·캡처·검증용 snapshot은 ignored tmp에 보관하며 공개 업로드·원격 push는 수행하지 않았다.

## 58. 공통 세션 잠금 수정 소스 `7ad2605`의 arm64 DMG

기존 `npm run package:tauri`로 `7ad2605563de61106e1360bafb985c595164cf89`의 CLI·frontend·GUI·DMG를 생성했다. `logs/goal-runtime-lock-orbit116-package-7ad2605-20261009.log`, `logs/goal-native-runtime-lock-inspect-package-7ad2605-20261009.log`, `goal-native-runtime-lock-package-7ad2605-results.json`이 근거다. 빌드228.80s·검사4.74s/exit0, 검사 전후 HEAD 일치와 read-only/nobrowse mount detach를 확인했다.

- `AioLM_0.3.1_aarch64.dmg`: 16798496 bytes, SHA256 `f7f9095ac92c3385e888ebb58a2f1c3d6ffb6c085ec03381a80ae7bed3cdb371`.
- GUI `aiolm`: arm64, SHA256 `585f1f085df04c7ad48a92d46d10eee0f5da17e0811cd3f844673ce2d881508b`.
- CLI `aiolm-cli`: arm64, SHA256 `fe0650d752d690d4338c63f63a0d701860f9ab2c84030d9fcba8768684e889d1`.
- 빌드 앱과 DMG의 GUI·CLI 해시 일치, 일반 파일5개·symlink 없음, version/minimum OS 선언·strict ad-hoc/runtime 서명 검사 pass. UTF-8·UTF-16LE/BE 개인 경로와 ORBIT-116 등을 포함한 fixture 표식 일치0, 새 격리 홈 packaged CLI의 onboarding=false·모델/runtime 미선택·격리 모델 경로·exit0을 확인했다. 같은 DMG를 `goal-package-7ad2605/`에 보존했다.

패키징 중 CUA로 관리 화면만 MLX와 llama.cpp로 전환했다. 실행 중인 Qwen/vllm-metal을 유지하며 MLX 작업5종과 native 설치·probe·삭제·PR·bundle 관련12개 control의 자원 잠금을 확인했다. native8개는 HTML disabled, 설치·삭제4개는 기존 aria-disabled와 보호 handler로 표현한다. 최초 읽기 전용 검사에서 HTML disabled만 요구하고 개수도11개로 잘못 가정하여 실패했다. `goal-runtime-lock-orbit116-native-controls-20261009.json`은 그 관측, `native-controls-final`은12개 모두의 disabled/aria-disabled 근거다. 이 검사 오류를 제품 결함이나 통과로 세지 않는다. 실제 설치·삭제를 요청하지 않았으며 MLX/llama.cpp 모델을 새로 실행한 검사가 아니다. `goal-native-audio-orbit116-{mlx,native}-inventory-locked-20261009.json`/PNG, `goal-runtime-lock-orbit116-mlx-inventory-locked-20261009.json`이 근거다.

vLLM 관리 선택과1280×800 Chat을 CUA로 복원했다. `goal-native-audio-orbit116-postpackage-7ad2605-20261009.json`/PNG에서 model loaded와39개 대화·기존 PP/TG 기록·빈 composer를 확인했다. 최초 엄격한 localStorage 전체 비교는 native 목록 자동 조회로 `aiolm.latest-runtimes.v2`가 갱신되어 실패했고 `goal-runtime-lock-orbit116-postpackage-preservation-7ad2605-20261009.json`에 남겼다. 이를 불변/pass로 바꾸지 않는다. 갱신은 기존 metal/cpu 키·errors를 유지하는 latest metadata/build `b11512`와 저장 시각이며 다른 localStorage는 보존됐다.

`goal-runtime-lock-orbit116-postpackage-verification-7ad2605-20261009.json`의14개 조건은 실제 cache 갱신을 분리하고 config 전체/hash·profile library·39개 대화 목록/hash·동일 running PID/engine/model/execution·별도 정의0·API off·idle/빈 composer·관측 error/overlay0·다른 localStorage와 두 관리 화면의 잠금을 확인한다.57절의 UI 저장 전 config hash·revision/PID가 불변이라는 의미는 아니다.

production GUI는 실행하지 않았다. Developer ID·공증·자연스러운 Finder 설치/실행·quarantine·별도 계정 Keychain·실제 upgrade와 Intel/구형 macOS는 unrun이다.57절의 blocked와 기존 실제 실패/upstream 제한을 유지하며 **전체 목표·M01–M12 통과를 뜻하지 않는다.** 개인 엔진 registry·manifest·adapter 등록은 미구현 장기 설계다. raw/build는 Git 제외 상태이며 공개 업로드·원격 push는 수행하지 않았다.

## 59. 세션 준비 명령 대기 중 보호와 상태 표시

후속 제품 소스는 `930350ec320d71eb159f2c24c495c9246494f0d3`이다. 기준은 `bf16825`이며 57절에 남긴 별도 세션 preflight 동안의 poll 지연을 실제 앱에서 검증했다. native debug 앱은 55절의 Rust 소스, frontend는 이번 소스를 HMR로 사용했다. Rust/Python·설치 엔진·모델·공개 IPC·기본값·lockfile은 변경하지 않았다. 임의 개인 엔진 registry·manifest·adapter 등록도 아직 구현하지 않았다.

### 재현과 수정 범위

기본 서버가 stopped이고 별도 세션을 시작한 직후, native 목록은 아직 기본 stopped 항목만 반환할 수 있다. 기존 UI는 그 목록만으로 런타임 관리 작업을 허용했다. 실제 첫 관리 화면의 여섯 작업은 이번 수정 후 이미 잠겼으며 별도 native entry/PID는 아직 목록에 없었다. 이는 명령 대기 activity의 근거이며 모델 readiness의 근거가 아니다.

공통 `session_start/stop/unload` facade의 대기 중 명령을 추적한다. 중지 요청이 먼저 끝나도 원래 시작 명령이 정리되지 않았으면 잠금을 유지하고, 성공·실패에 관계없이 명령 완료 시 해제·상태 갱신을 요청한다. 기존 공용 poller와 backend의 최종 자원 보호는 유지하며 추가 timer·엔진별 분기·가짜 Ready를 만들지 않는다. 다른 클라이언트에서 시작한 세션은 여전히 native 상태 조회에 의존한다. 모든 lifecycle hand-off의 시간 차이가 사라졌다고 단정하지 않는다.

실제 첫 세션 행에서는 준비 중 Stopped와 Cancel이 함께 표시됐다. 새 회귀 검사로 같은 stopped poll을 재현한 뒤 로컬 준비·취소가 진행되는 동안 Starting/Working을 유지하도록 수정했다. 실제 native running·failed·crashed 상태가 우선하며 모델이 준비됐다는 의미로 승격하지 않는다. 공통 task registry의 취소 여부만 구독하고 기존 취소·readiness·오류 계약을 유지한다.

전체 직접 검사에서 Node ESM이 새 모듈의 extension 없는 import를 해석하지 못했다. 명시한 `.ts` 경로와 의존성이 없는 `sessionEvents` 모듈로 정리했다. 기존 `sessionUtils` export와 이벤트 이름은 보존해 브라우저·native UI·Node 직접 검사 경로에서 같은 계약을 사용한다.

### 자동 검사

근거는 `logs/goal-session-transition-orbit117-*`와 `checks.jsonl`이다. 작업용 도구 버전은 1절과 같다.

| 검사 | 결과 |
| --- | --- |
| 잠금 수정 전 최소 회귀 | fail — 2.42초, 명령이 pending인데 설치 버튼 enabled. 이름 필터로 선택하지 않은35개는 실행하지 않은 상태다. |
| 상태 표시 수정 전 최소 회귀 | fail — 3.03초, Starting 대신 Stopped. 이름 필터로 선택하지 않은36개는 실행하지 않았다. |
| 관련6 files | pass — 별도 관련 실행4.86초/134개. 이후 이벤트 모듈 정리는 최종 공통 검사에 포함했다. 이전133개 실행과 Working badge/button을 구분하지 못한 임시 테스트 query 실패4.88초도 보존했다. 후자는 제품 동작 실패로 세지 않는다. |
| 최종 직접 검사 | pass — 7.66초. 초기 전체 검사17.59초의 import 실패를 수정하고 모든 직접 suite를 재실행했다. |
| 최종 typecheck / lint | pass — 12.06초 / 6.73초. |
| 최종 공통 `test:unit` | pass — 133.42초. contracts·provider 옵션·스크립트·직접 검사와 UI180 files/1801개 포함. coverage statements80.73%, branches75.62%, functions79.20%, lines84.83%. |
| 최종 build | pass — 18.08초. 기존 chunk 크기 경고는 남는다. |

`sessionTransitions.test.ts`는 세 facade의 인자·결과·대기 중 잠금, 겹친 시작/취소의 완료 순서, 동기 실패의 해제·native 상태 갱신 이벤트를 확인한다. Runtimes/Sessions 회귀는 native entry가 아직 없는 poll의 UI 보호와 준비/취소 상태를 검사한다. Rust/Python 제품 수정이 없어 해당 전체 suite를 이번 절에서 다시 실행했다고 표기하지 않는다.

### 실제 앱의 실행·취소·보존

실제 UI 조작은 CUA, 관찰은 WKWebView·읽기 전용 IPC/DOM·프로세스 조회다. 새 모델·환경 다운로드나 공개 서비스 업로드는 수행하지 않았다. vllm-metal0.30.0/vLLM0.30.0+cpu와 기존 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`, context4096을 사용했다.

- 기본 실행을 정상 중지하고 기존 소유 process group의 세 PID와 listener 종료를 확인했다. stopped 화면에서는 빈 Python 경로의 등록 버튼만 기존 조건대로 disabled였다.
- 이번 작업에서 만든 합성 별도 세션의 첫 시작은 native entry가 생기기 전 여섯 관리 작업이 disabled이고 안내/제목 간격12px·가로 넘침/관측 오류 없음이었다. 이후 실제 Ready/Running으로 전환됐다. 정상 중지 후 세 소유 PID와 listener 종료를 확인했다.
- 두 번째 시작은 수정된 Starting 표시 후 Running이 됐다. 취소를 누르기 전에 준비가 끝났으므로 이 실행을 취소 통과로 세지 않는다. 정상 중지 뒤 세 소유 PID 종료만 확인했다. 준비 상태의 URL을 따로 저장하지 않아 이 실행의 listener 재검사는 unrun이다.
- 세 번째 시작은 CUA의 Starting/Cancel 관찰 직후 Cancel을 눌렀다. Cancelled/Stopped, Tasks0, Load session 재활성화와 관리 작업 해제를 확인했다. native 목록의 기본·별도 항목 모두 stopped/PID없음이었다. preflight 임시 child 전체를 지속 추적한 근거는 아니며 실제 Working 상태가 길게 남는 장면은 합성 회귀와 구분한다.
- 합성 별도 정의만 UI에서 제거하고 기존 기본 Qwen 프로필을 저장/시작했다. 실제 기본 Running·로드 모델명과 채팅 화면을 복원했다. 최종 공통 이벤트 모듈에서도 기본 Running의 여섯 관리 작업 잠금·12px 간격·가로 넘침/관측 오류 없음이 유지됐다. 이번 절은 새 추론 요청의 내용/usage를 재검증한 근거가 아니다.

raw 근거는 `goal-native-audio-resume-orbit117-baseline-20261009.json/png`, `goal-native-audio-orbit117-*.json/png`, `goal-session-transition-orbit117-{named-first-management-locked,named-preparation-cancelled,cancellation-management-unlocked,final-default-management-locked}-20261009.json`, cleanup 기록이다. 보조 cleanup 도구의 잘못된 basename 입력 실패도 보존했으며 second named cleanup은 실제 수집한 PID와 listener 미검증을 분리해 기록했다.

`goal-session-transition-orbit117-preservation-20261009.json`의16개 조건과 `goal-session-transition-orbit117-integration-20261009.json`의11개 조건이 통과했다. 39개 대화 파일 목록/hash,21개 profile ID/값과 다른 profile revision, 다른 config 전체·localStorage·engine/model/execution, API off·idle/빈 composer를 보존했다. UI 저장/실행에 따라 기본 vLLM profile14→15, library72→78과 기본 applied revision이 갱신되고 이번 합성 named applied snapshot 한 개가 기존 보존 정책에 따라 추가됐다. 별도 정의는0이다. 시작 PID/config hash/revision까지 불변이라는 의미는 아니다.

M08/M12의 실제 MCP Yes/No 뒤 tool 실행·모델 후속 응답/실제 call 취소, M11의 트레이/Dock/OS 알림 수신은 blocked다. 별도 계정·Finder 설치 실행·Keychain·실제 upgrade·Intel/구형 macOS는 unrun이다. 실제 미디어 내용 실패/upstream 제한을 유지하며 전체 M01–M12 통과를 뜻하지 않는다.


## 60. 세션 명령 보호 수정 소스 `930350e`의 arm64 DMG

제품 소스 `930350ec320d71eb159f2c24c495c9246494f0d3`에서 기존 `npm run package:tauri`를 실행했다. 생성225.13초, 준비된 native arm64 CPython3.12의 검사3.39초 모두 exit0이다. 근거는 `logs/goal-session-transition-orbit117-package-930350e-20261009.log`, `logs/goal-session-transition-orbit117-inspection-930350e-20261009.log`, `goal-native-runtime-lock-package-930350e-results.json`이다. 검사 전·후 HEAD가 해당 제품 커밋이고 DMG 해시가 불변이었다.

| 산출물 | 보존 위치·검사 |
| --- | --- |
| DMG | `goal-package-930350e/AioLM_0.3.1_aarch64.dmg`, 16799470 bytes, SHA-256 `5527e5066bdc0588404d9e017f313a97009d3a1f60561886864363dd282705b4` |
| GUI | arm64, SHA-256 `c4d3edbd33e35b9789b9c48cf969580f722b278b7e1c1ea681672bc5ed24b1ce` |
| CLI | arm64, SHA-256 `af6ff9df14a35834c9a232fab34f714d1e2bf6e18034f480e0e038c7394ce898` |

DMG를 read-only/nobrowse로 연결해 버전0.3.1·bundle identity·최소 macOS13.3, 정확한 기존5개 파일·symlink 없음·두 실행 파일과 빌드 원본의 해시 일치를 검사했다. GUI/CLI·sealed app의 ad-hoc 서명과 deep/strict 검사를 통과했다. UTF-8/UTF-16 LE/BE의 현재 source/home 경로와 기존·이번 검증 fixture scan은 모두0이었다. 새 격리 홈의 패키지 CLI는 exit0이고 onboarding 미완료·active model/runtime 없음·격리 홈 안의 models directory를 확인했다. 생성 DMG를 raw 폴더에 해시 일치 복사하고 mount 해제를 확인했다. source/raw/build를 배포물에 넣지 않았다.

패키지 생성 전 CUA로 기본 Qwen·1280×800 Chat을 복원했다. 생성 후 실제 화면 재캡처는 Mac 잠금으로 blocked였고 사용자에게 수동 잠금 해제를 요청했다. `goal-native-session-transition-orbit117-postpackage-cua-lock.json`에 도구가 반환한 차단 근거를 보관했다. 잠금 해제나 실제 native 캡처 성공을 추정하지 않는다.

읽기 전용 WebDriver/IPC 관찰은 계속 가능했다. `goal-native-audio-orbit117-postpackage-930350e-20261009.json/png`와 `goal-session-transition-orbit117-postpackage-verification-930350e-20261009.json`의10개 조건은 패키지 직전 config 전체/hash·39개 대화 목록/hash·localStorage·동일 running PID/engine/model/execution·별도 정의0·API off·idle/빈 composer·관측 error/overlay0의 보존을 확인했다. 이 PNG는 잠금 해제된 native 화면 캡처를 대체하는 근거가 아니다.

production GUI는 실행하지 않았다. Developer ID·공증·자연스러운 Finder 설치 실행·quarantine·별도 계정 Keychain·실제 upgrade·Intel/구형 macOS는 unrun이다. 기존 미디어 실패와 MCP·트레이/Dock/OS 알림의 blocked를 유지하며 전체 목표나 M01–M12 통과를 뜻하지 않는다. 개인 엔진 registry·manifest·adapter 등록은 [미구현 장기 설계](pluggable-inference-runtimes.ko.md)로 남는다. 공개 업로드·원격 push는 수행하지 않았다.


## 61. Production GUI 실제 실행과 공통 채팅 안내 수정

제품 `930350e`의 검증된 DMG에서 GUI/CLI가 기존 해시와 일치하는 app을 작업용 디렉터리에 복사했다. 바이너리·Info.plist·서명을 수정하지 않았으며 개발 서버·embedded WebDriver 없이 직접 실행했다. 새 HOME·legacy·앱 설정 경로와 CoreFoundation home을 격리했다. `CFFIXED_USER_HOME` 사용은 [Apple CF 구현](https://github.com/apple-oss-distributions/CF/blob/main/CFPlatform.c)을 참고했으며 현재 기기의 실제 CoreFoundation home과 fixture 안에 생성된 WKWebView 파일로 확인했다. 같은 OS 계정이므로 Keychain·OS 서비스·별도 계정 최초 실행이나 Finder 설치 실행의 근거는 아니다.

새 패키지 CLI의 onboarding 미완료·모델/runtime 없음·fixture 안 models directory를 확인한 다음 기존 외부 Python 환경만 명시적으로 등록했다. vllm-metal0.30.0/vLLM0.30.0+cpu와 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`를 사용했다. 새 모델·환경 다운로드나 공개 업로드는 수행하지 않았다. 실제 CUA로 onboarding 3단계를 완료하고 모델 설정·프로필 저장/시작을 실행했다.

### 환경 실패와 실제 추론

첫 시작은 fixture가 지정한 긴 TMPDIR 때문에 ZeroMQ IPC 경로가 macOS의103자 한도를 초과해 실패했다. 실제 진단 화면의 마지막 오류를 캡처했다. 작업 전용 짧은 OS 임시 디렉터리로 재실행하고 UI에서 실제 vLLM `--max-model-len=4096`도 명시했다. 초기 CLI의 legacy `ctx_size=4096`만으로 provider context가 적용됐다고 보지 않는다. 재시도는 TMPDIR와 provider context 둘 다 달라졌으며 readiness·hash·시간 제한을 변경하지 않았다. 이 첫 실패는 검증 fixture의 환경 문제다.

재시도에서는 실제 native 화면의 model loaded·Qwen 표시 이름·vLLM 선택과 활성 composer를 확인했다. CUA로 합성 산술 요청을 보냈다. 응답 화면 재캡처 중 Mac이 다시 잠겨, 완료 내용은 fixture의 저장 대화와 런타임 로그로 확인했다.

| 검증 | 결과·근거 |
| --- | --- |
| 패키지 Ready·모델명·실제 전송 | pass — `goal-production-orbit120-ready.png/-ax.txt`, retry launch 및 실제 CUA 요청. |
| 내용·usage·종료 이유 저장 | pass(산술 내용 범위) — `3 + 4 = 7.`, finishReason stop, PP38/TG9토큰·cached0. TG0.3027초/26.43tok/s, TTFT5.206초·전체 요청5.523초 저장. PP 시간/속도는 누락 상태로 유지했다. 완료 화면의 실제 표시 확인은 blocked다. |
| 한국어 문장 지시 | fail — 응답이 한국어 문장이 아니었다. 직접 엔진 비교를 하지 않아 원인을 확정하지 않는다. 산술 성공을 언어 지시 준수로 세지 않는다. |
| 첫 실패 앱 정상 종료 | pass — 실제 Cmd+Q와 app exit0. 이미 실패한 엔진 전체 process group/port를 별도 연속 추적한 근거는 없다. |
| 재시도 앱 정상 GUI 종료·응답 재로드 | blocked / unrun — Mac 잠금 때문에 실행하지 못했다. |
| 재시도 fixture 강제 정리 | pass(강제 정리 범위) — 소유 app과 engine group만 SIGTERM. 기록한4개 PID·listener 종료, 외부 Python 환경 보존, 작업 전용 짧은 TMPDIR 제거 확인. app exit-15/launcher exit1이며 정상 종료 통과로 계산하지 않는다. |

raw는 `goal-production-orbit120-{prepared,fresh-defaults,registration,source-inventory,launch,retry-launch,retry-owned-running,integration,retry-forced-cleanup,response-cua-lock}.json`, welcome/appearance/stopped/진단/Ready native 캡처, fixture의 대화·설정과 `logs/goal-production-orbit120-*`다. 첫 prepare helper의 잘못된 inventory 접근 실패도 보존했다. 첫 정상 종료와 재시도 강제 종료를 섞지 않는다.

### 제품 결함 수정과 자동 검사

실제 stopped vLLM snapshot에 “No GGUF model is selected yet”가 표시됐다. 모델을 이미 지정한 상태와 모델 형식 양쪽을 잘못 설명했다. 모델 loading 상태에서도 같은 제목·안내와 offline placeholder가 남았다. `d6140630989a276e74e184af007467d30bcf660c`는 공통 stopped 안내를 모델 설정에서 로드하도록 바꾸고, native starting 또는 기존 로컬 준비 대기 중 로딩 안내·placeholder를 표시한다. 중복 Load를 제시하지 않으며 실패·crashed 진단이 우선한다. 엔진별 UI 분기·공개 API·설정 기본값을 추가하지 않고, 기존 전송 readiness·모델 identity·profile/benchmark 계약을 유지한다.

| 자동 검사 | 결과 |
| --- | --- |
| stopped 안내 수정 전 최소 회귀 | fail — 2.86초/세 엔진3개. 필터로 제외한32개는 실행하지 않았다. |
| loading 안내 수정 전 최소 회귀 | fail — 2.49초/2개. 제외한35개는 실행하지 않았다. |
| 최종 관련5 files | pass — 4.69초/62개. stopped3엔진·native starting/로컬 준비·failed/crashed 우선순위·composer/media/streaming 계약 포함. |
| typecheck / lint / build | pass — 9.78초 / 5.64초 / 15.54초. 기존 chunk 크기 경고 유지. |
| 공통 test:unit | pass — 123.53초. contracts·provider 옵션·scripts·직접 검사·UI180 files/1807개. coverage80.74/75.68/79.20/84.83%. |

중간 관련 실행4.41초는 존재하지 않는 두 경로가 포함돼 실제1 file/37개만 실행됐다. 이를3 files 통과로 세지 않고 정확한5개 경로로 다시 검사했다. Rust/Python 제품 변경은 없어 전체 해당 suite를 이번 절에서 다시 실행했다고 표기하지 않는다.

### 개발 앱 복원과 남은 범위

패키지 검사 전 기존 개발 앱을 실제 Cmd+Q로 종료하고 소유 엔진3개 PID·listener·Vite·WebDriver 정리를 확인했다. 패키지 fixture 정리 후 원래 격리 홈/설정으로 개발 서버와 debug app을 다시 실행했다. `goal-production-orbit120-restored-data-preservation.json`의7개 조건은 config 전체/hash·39개 대화 목록/hash·localStorage·별도 정의0·API off·stopped 상태를 확인했다. 모델은 아직 stopped이며 기본 Qwen을 다시 시작하는 native 동작은 blocked다.

Mac 잠금 중 읽기 전용 WKWebView는 document visibility hidden, initial surface data-ready false/inert였다. 빈 innerText로 수정 안내의 표시를 확인하려던 보조 assertion은 실패했다. 이는 수정 후 native 화면이나 startup 완료를 확인한 근거가 아니며, 관측 error 배열이 비었다고 전체 console 정상으로 표기하지 않는다. 새 수정의 native stopped/loading 화면과 Ready 이후 전송·정상 종료·재로드를 잠금 해제 후 확인해야 한다.

M08/M12의 실제 MCP 승인·거부 뒤 도구/모델 후속 응답·실제 call 취소, M11의 트레이/Dock/OS 알림 수신은 blocked를 유지한다. 별도 계정·Keychain·실제 upgrade·Finder 설치 실행·Intel/구형 macOS는 unrun이고 기존 실제 미디어 내용 실패/upstream 제한도 남는다. 개인 엔진 registry·manifest·adapter 등록은 [장기 설계](pluggable-inference-runtimes.ko.md)의 미구현 범위다. 전체 목표나 M01–M12를 통과로 표시하지 않는다. 원격 push는 수행하지 않았다.


## 62. 공통 채팅 안내 수정 소스 `d614063`의 arm64 DMG

제품 소스 `d6140630989a276e74e184af007467d30bcf660c`에서 기존 `npm run package:tauri`를 실행했다. 생성197.19초, 준비된 native arm64 CPython3.12 검사4.45초 모두 exit0이다. 근거는 `logs/goal-production-orbit120-package-d614063-20261009.log`, `logs/goal-production-orbit120-inspection-d614063-20261009.log`, `goal-native-runtime-lock-package-d614063-results.json`이다. 검사 전·후 HEAD와 이미지 hash가 불변이었다.

| 산출물 | 보존 위치·검사 |
| --- | --- |
| DMG | `goal-package-d614063/AioLM_0.3.1_aarch64.dmg`, 16799717 bytes, SHA-256 `cd16d58483b9f59e58829351be2957c30edaf8134bcc8775479ad0ab478dd86c` |
| GUI | arm64, SHA-256 `a262dabf7931b344b394f2df8ad3f31db200c3c1c68af9af681fe7bb200f1772` |
| CLI | arm64, SHA-256 `e762e4b60979b19d0c80b0b72a22c04ac7a97f27d06e1e92411699b54ed0c218` |

read-only/nobrowse mount에서 버전0.3.1·최소 macOS13.3·정확한 기존5개 파일·symlink 없음·GUI/CLI와 빌드 원본 hash 일치를 확인했다. 두 실행 파일과 sealed app의 ad-hoc 서명 및 deep/strict 검사가 통과했다. UTF-8/UTF-16 LE/BE의 현재 source/home 경로와 기존·이번 production 검증 fixture scan은 모두0이다. 새 격리 홈의 패키지 CLI는 onboarding 미완료·모델/runtime 없음·홈 안 models directory를 반환했다. 이미지의 해시 일치 복사와 mount 해제를 확인했다.

`goal-production-orbit120-postpackage-preservation.json`의7개 조건은 config/hash·39개 대화·localStorage 보존, 개발 앱·Vite·읽기 전용 driver 유지와 API off/model stopped를 확인했다. Vite는 실제 IPv6 loopback listener를 확인했으며 IPv4라고 가정한 초기 보조 probe 실패를 서버 장애로 세지 않는다. 이는 native UI 확인의 근거가 아니다.

새 패키지 GUI는 Mac 잠금 때문에 실행하지 않았다. 61절의 실제 production Ready·추론은 이전 `930350e`의 근거이며 새 수정의 native 화면 검증을 대신하지 않는다. 복원한 개발 앱도 아직 모델 stopped다. 새 소스의 실제 stopped/loading/Ready·전송·정상 종료·기록 재로드와 기본 Qwen 실행 복원은 잠금 해제 후 남은 작업이다.

Developer ID·공증·자연스러운 Finder 설치 실행·quarantine·별도 계정 Keychain·실제 upgrade·Intel/구형 macOS는 unrun이다. 미디어 내용 실패·MCP/트레이/Dock/OS 알림 blocked 및 개인 엔진 registry의 미구현 범위를 유지한다. 원격 push는 수행하지 않았다.


## 63. 실제 채팅 안내·production 응답과 기본 대화 제목 수정

2026-10-10 잠금 해제 상태에서 기존 debug 앱과 `d614063` frontend의 실제 CUA 검증을 재개했다. 시작 화면에 있던 과거 저장 응답을 새 실행의 응답으로 세지 않았다. 기존 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`, vllm-metal0.30.0/vLLM0.30.0+cpu와 외부 등록 환경을 사용했다. 새 다운로드·공개 업로드·원격 push는 수행하지 않았다.

### 기존 개발 앱의 실제 흐름

| 검증 | 결과·근거 |
| --- | --- |
| stopped·loading 공통 안내 | pass — 빈 새 대화에서 특정 파일 형식을 가정하지 않는 모델 설정 안내를 확인했다. 실제 Save profile and start 뒤 Chat의 Loading model·대기 안내, 비활성 모델 설정·composer·Send와 중복 Load 부재를 확인했다. `goal-native-orbit123-stopped`와 `-editor-starting` native PNG/AX, `goal-native-audio-orbit123-chat-loading-20261010.json`이 근거다. 파일명 editor-starting의 실제 캡처는 Chat loading 화면이다. |
| Ready·모델 identity·새 전송 | pass — 실제 Ready와 Qwen 표시 이름, 활성 composer에서 합성 요청을 전송했다. `goal-native-orbit123-ready`와 `-response` native 캡처, 저장 대화가 근거다. 실제 argv의 provider context는4096이었다. |
| 최소 창 접근 | pass(스크롤 접근 범위) — 실제360×520 창/WK360×488에서 응답·모델과 지표에 순서대로 접근했다. DOM width/clientWidth 모두360, log height76/scrollHeight377이다. 첫 지표 캡처의 PP 상단은 조금 잘려 있으며 모든 정보가 동시에 보인다고 계산하지 않는다. `goal-native-orbit123-minimum-{response,metrics}.png`, `-minimum-geometry.json` 보관.1280×800으로 복원했다. |
| 정상 debug 종료 | pass — 실제 Cmd+Q, launcher exit0. 기록한 app·엔진·tracker·EngineCore·Vite의5개 PID, 모델 listener·embedded driver·IPv6 Vite listener 정리를 확인했다. `goal-production-orbit123-debug-{owned-before-quit,normal-quit-cleanup}.json`이 근거다. |

첫 요청은 한국어 한 문장으로3+4를 설명하도록 했다. 응답 `3加上4等于7。`, finish stop, PP48/TG7/cache0, TTFT11188ms·전체11195ms·준비40ms, TG231.93ms/25.87tok/s를 저장했다. **산술은 pass, 한국어 지시는 fail**이다.

동일 모델 프로세스에 현재 프로필·저장된 일반 요청을 이용해 공통 `buildChatRequestBody`로 재구성한 직접 호출은 HTTP200/3888ms, `3과 4를 더하면 7입니다.`, PP48/TG12/cache32·finish stop이었다. native 요청 자체를 캡처한 것이 아니며 재구성한 비교임을 명시한다. 실제 두 번째 새 대화에 동일 입력을 보내자 `3에 4를 더하면 7이 답입니다.`, uncached PP16/cache32/전체 prompt48, TG14·finish stop이 표시됐다. prompt·sampling·출력 한도를 의도적으로 바꾸지 않았다. 첫 실패를 유지하며, 기본 sampling과 cache 상태가 다른 세 응답으로 원인을 단정하지 않는다. 모델 응답 언어를 강제하는 설정이나 우회 수정을 추가하지 않았다. 직접 request/SSE/result와 두 native 응답을 `goal-native-orbit123-direct-language-20261010-*`, `-thread.json`, `-repeated-response`에 보관했다.

### 소스 `d614063` production GUI

62절 DMG의 GUI/CLI를 byte-identical하게 작업용 app으로 복사하고 strict 서명을 확인했다. 별도 HOME·legacy·앱 경로·CoreFoundation home과 짧은 작업 전용 TMPDIR를 사용했다. 개발 서버·WebDriver·바이너리/Info.plist 수정 없이 직접 실행했다. 같은 OS 계정의 격리이며 자연스러운 Finder 설치 실행이나 별도 계정 최초 실행의 근거는 아니다. 새 CLI 기본값을 확인하고 기존 외부 환경·모델만 명시적으로 선택한 뒤 실제 onboarding에서 한국어를 선택했다.

첫 시작은 Ready 전에 실패했다. fixture 준비가 모델/runtime 선택으로 생성한 Recovered profile 뒤에 provider 옵션을 설정해서, 선택된 프로필에는 context 옵션이 비어 있었다. 실제 모델 설정의 provider context 필드도 runtime-default/빈 값이었다. 초기 CLI의 provider_options만으로 실제 launch context가4096이었다고 판단하지 않는다. 실제 UI에서4096을 입력하고 Save profile and start를 실행한 재시도는 Ready와 모델 표시·활성 composer에 도달했다. 실제 argv와 저장 옵션의4096을 확인했다. 이것은 fixture 준비 순서와 프로필 선택의 차이며, **첫 엔진 초기화 실패의 핵심 원인은 확인하지 못했다.** context 부족·OOM·upstream 결함으로 확정하지 않는다.

진단 끝에는 Engine core initialization failed와 “See root cause above”를 가리키는 API wrapper traceback만 남았다. 공통 spawn은 stdout을 버리고 stderr 마지막4KiB만 보존한다. stdout의 핵심 오류나 긴 stderr 앞부분을 잃을 수 있는 진단 개선 과제를 추가로 확인했으며 아직 수정하지 않았다. 중복 AVFoundation 클래스 경고도 원인으로 확정하지 않고 기존 외부 라이브러리를 변경하지 않았다. `goal-production-orbit123-loading-ko` 캡처는 이름과 달리 **실패 화면**이며 한국어 Loading 통과 근거로 쓰지 않는다. `-failure-log-end`가 실제 retained tail의 근거다.

| 검증 | 결과·근거 |
| --- | --- |
| 한국어 stopped 안내·실패 우선순위 | pass — 실제 onboarding 뒤 모델 형식을 가정하지 않는 안내, 실패 뒤 진단 우선 표시. `goal-production-orbit123-stopped-ko`와 `-loading-ko` native 캡처. |
| Ready·모델·실제 요청·응답 지표 | pass(산술 범위) — `-ready-ko`, `-response-ko.png/-ax.txt`, `-actual-threads.json`, `-integration.json`. 응답 `3加上4等于7。`, finish stop, PP48/TG7/cache0, TTFT8285ms/준비31ms/전체8300ms, TG206.55ms/29.05tok/s. PP 시간/속도 미측정은 —와 안내로 표시했다. |
| 한국어 응답 지시 | fail — production의 첫 응답도 중국어였다. 직접 비교의 성공을 production 응답 성공으로 대체하지 않는다. 원인은 미분류다. |
| 응답 재로드·정상 production GUI 종료 | blocked — 완료 응답은 실제 native 화면으로 확인했으나 이어진 관찰에서 Mac이 잠겼다. 잠금 해제를 요청한 뒤에도 조작할 수 없었다. `-response-cua-lock.json` 보관. |
| 소유 fixture 강제 정리 | pass(강제 정리 범위) — 기록한 engine/app group에만 SIGTERM, 전체 기록 PID·모델 포트 종료·소유 짧은 TMPDIR 제거·외부 Python 보존 확인. app exit-15/launcher exit1을 유지하며 정상 종료 pass로 세지 않는다. `-retry-owned-running`, `-retry-forced-cleanup`, `-retry-exit`과 run log가 근거다. |

준비·source inventory·registration·fresh defaults·실제 config/threads·native PNG/AX·실행 로그는 `goal-production-orbit123-*`에 보관했다. 강제 정리 helper의 초기 pair-list 접근 오류, 정상 종료를 요구해 실패한 production launcher도 보존했다. 검사 helper 실패를 제품 실패와 섞지 않는다.

### 공통 기본 제목 수정과 검사

한국어 fresh production UI에서 기본 제목·목록·삭제 접근성 이름이 `New conversation`으로 남는 제품 결함을 재현했다. 수정 `e3944470a4315c0a699ebf0e458ff76d4b5c2c3a`는 기존 생성 제목을 화면의 현재 언어로 표시하고 같은 표시 제목으로 검색할 수 있게 한다. 제목 입력에는 번역된 placeholder를 사용하며, 삭제 안내에도 같은 이름을 적용한다. 저장된 생성 제목·history schema·첫 메시지의 자동 이름 지정·빈 draft 재사용과 사용자 지정 제목은 보존한다. 엔진 분기·공개 IPC·프로필·benchmark 계약·제품 초기값을 변경하지 않았다.

| 자동 검사 | 결과 |
| --- | --- |
| 수정 전 최소 회귀 | fail —6.54초, 한국어·일본어·중국어3개 모두 생성 제목에서 실패. 필터 제외39개는 실행하지 않았다. |
| 최종 관련3 files | pass —4.81초/58개. 번역 제목·tooltip·검색·삭제 안내·취소·저장 제목 보존·사용자 제목으로 첫 전송, thread/hydration/history 검사 포함. 중간4.50초 실행은 존재하지 않는 fireEvent.cancel 사용 때문에3개 실패/55개 통과였고 검사 코드를 수정했다. |
| typecheck / lint / build | pass —9.58초 /5.56초 /10.91초. 기존 chunk 크기 경고 유지. |
| 공통 test:unit | pass —123.07초. contracts·provider 옵션·scripts·직접 검사·UI180 files/1810개. coverage80.78/75.72/79.34/84.89%. |

React 구성·hooks 의존성·접근성 이름과 데이터 보존을 검토했다. Rust/Python 제품 변경은 없으며 해당 전체 suite를 이 절에서 다시 실행했다고 표기하지 않는다. 새 제목 수정의 native 화면 재검증은 Mac 잠금으로 blocked다. 기존 `d614063` production의 실제 응답을 새 수정의 GUI 검증으로 대체하지 않는다.

### 개발 환경 복원과 남은 작업

강제 정리 뒤 원래 임시 홈으로 개발 서버와 기존 debug app을 복원했다. 읽기 전용 WebDriver/IPC의 `goal-production-orbit123-restored-data-preservation-final.json`은 production 직전 config 전체/hash·41개 대화 목록/hash·localStorage 보존, 별도 session 정의0·API off·model stopped의7개 조건을 확인했다. 첫 helper는 기본 session이 status 목록에 포함되는 것을 잘못 거부했으며 실패 파일을 보존하고 정의와 기본 status를 구분해 수정했다. 관측 errors/overlay0은 전체 console 검증을 뜻하지 않으며 잠금 상태의 WebDriver PNG는 native 화면 검증을 대신하지 않는다.

시작 시점과의 `goal-native-orbit123-original-data-audit.json`은 기존39개 대화와21개 프로필 identity·내용 보존을 확인했다. 실제 Save profile and start로 vLLM Default revision15→16과 적용 snapshot·library revision만 바뀌었고 합성 요청의 대화2개를 추가했다. 다른 config 값은 동일하다. 복원한 모델은 stopped이며 잠금 해제 뒤 기본 Qwen 재시작·새 제목 native 표시·production 재로드/정상 종료가 남아 있다.

미디어 내용 실패·URI upstream 제한·실제 ffmpeg 부재 검증, M08/M12의 MCP Yes/No 뒤 도구/모델 후속 응답과 호출 취소, M11의 트레이/Dock/실제 OS 알림 수신은 남아 있다. 별도 계정·Keychain·upgrade·Finder 설치 실행·Intel/구형 macOS는 unrun이다. stdout/stderr 핵심 오류 보존 개선과 응답 언어 실패 분류도 남긴다. 개인 엔진 registry·manifest·adapter 등록은 [장기 설계](pluggable-inference-runtimes.ko.md)의 **미구현** 범위다. 전체 목표나 M01–M12 통과를 표시하지 않는다.


## 64. 기본 대화 제목 수정 소스 `e394447`의 arm64 DMG

제품 소스 `e3944470a4315c0a699ebf0e458ff76d4b5c2c3a`에서 기존 `npm run package:tauri`를 실행했다. 생성197.10초, 준비된 native arm64 CPython3.12 검사4.67초 모두 exit0이다. `logs/goal-production-orbit123-title-package-20261010.log`, `logs/goal-production-orbit123-title-inspection-20261010.log`, `goal-native-runtime-lock-package-e394447-results.json`을 보관했다. 검사 전·후 HEAD와 이미지 hash는 불변이다.

| 산출물 | 보존 위치·검사 |
| --- | --- |
| DMG | `goal-package-e394447/AioLM_0.3.1_aarch64.dmg`,16799817 bytes, SHA-256 `28861364cccd0406f93856f72bfd15ea15444d9b733d20a4fba7df4e2a5826ad` |
| GUI | arm64, SHA-256 `8d6cbaeb48d339582f06d90192937733fda3021eb75c5fe9a1a0be33bef8b27f` |
| CLI | arm64, SHA-256 `e762e4b60979b19d0c80b0b72a22c04ac7a97f27d06e1e92411699b54ed0c218` |

read-only/nobrowse mount에서 버전0.3.1·최소 macOS13.3·기존5개 파일·symlink 없음, 두 실행 파일과 빌드 원본 hash 일치를 확인했다. GUI/CLI·sealed app의 ad-hoc 서명과 deep/strict 검사는 통과했다. source/home 경로의 UTF-8/UTF-16 LE/BE scan과 기존·이번 fixture scan은 모두0이었다. 새 격리 홈의 패키지 CLI는 exit0, onboarding 미완료·모델/runtime 없음·홈 안 models directory를 확인했다. 생성 DMG를 raw 폴더에 해시 일치 복사하고 mount 해제를 확인했다.

`goal-production-orbit123-postpackage-preservation.json`은 config/hash·41개 대화·localStorage 불변, 동일 복원 debug 앱·별도 정의0·API off/model stopped의7개 조건을 확인했다. 이는 읽기 전용 WebDriver/IPC 근거다. 개발 서버·embedded driver는 유지 중이며 실제 native 화면 확인과 Qwen 시작은 재잠금으로 blocked다.

패키지 검사 뒤 복원된 debug app을 CUA로 다시 선택했으나 Mac 잠금 차단이 반환됐다. `goal-native-orbit123-postpackage-cua-lock.json`에 해당 근거를 보관했으며 수정 후 제목 화면이나 모델 시작이 성공했다고 추정하지 않는다.

이 패키지 GUI는 실행하지 않았다. 63절의 실제 production Ready·응답은 이전 `d614063`의 결과이며 새 제목 수정의 실제 화면을 대신하지 않는다. 새 제목 native 검증·production 기록 재로드/정상 종료, 기존 미디어 내용 실패·MCP·트레이/Dock/OS 알림과 진단 개선·언어 실패 분류는 남아 있다. Developer ID·공증·Finder 설치 실행·quarantine·별도 계정 Keychain·upgrade·Intel/구형 macOS는 unrun이다. 개인 엔진 registry·manifest 등록도 미구현이며 전체 목표나 M01–M12를 통과로 표시하지 않는다. 원격 push는 수행하지 않았다.


## 65. 엔진 stdout 진단 보존과 개발 앱 갱신

63절에서 실제 엔진 초기화 실패의 진단에 wrapper만 남았고, 공통 spawn은 stdout을 버리는 것으로 확인했다. `6a374ce63a8d5f8fa078fe4defb5fc6b1b06c3bc`는 desktop·benchmark의 공통 실행에서 stdout/stderr를 모두 읽고 각4KiB의 독립 tail에 보관한다. 긴 stderr가 stdout의 핵심 오류를 밀어내지 않는다. stdout이 있으면 출처별 label을 사용하며 시간순 정렬을 의미하지 않는다. 기존 stderr-only 문자열은 그대로 유지한다. 두 출력 모두 기존 credential 비식별화·ANSI 제거를 거친다.

프로세스 소유자가 output reader 두 개도 소유하며, 종료 때 현재 파이프의 unread bytes를 조회해 그 snapshot만 회수한다. writer를 상속한 live 자식 때문에 EOF를 무한히 기다리거나 이후 출력을 계속 소비하지 않는다. Unix nonblocking/FIONREAD와 Windows PeekNamedPipe를 사용한다. readiness600초·해시 검사·엔진별 옵션·모델/profile/benchmark 계약·공개 IPC·기본값을 변경하지 않았다. 독립 headless CLI collector도 유지한다. 제한된 tail이므로 같은 stream의 앞부분은 계속 잘릴 수 있으며 전체 로그 영구 저장 기능을 구현한 것은 아니다. **이전에 버려진 실제 로그를 복구하거나 당시 Qwen 시작 실패의 원인을 확정하지 않는다.**

### 최소 재현과 공통 검사

기존 managed fake server의 성공적인 health/stream 흐름 뒤에 실패 흐름을 추가했다. 실제 프로세스가 stdout64KiB 뒤 핵심 오류·Unicode·합성 credential, stderr64KiB 뒤 API wrapper 오류를 쓰고 exit7한다. 동일 격리 runtime/홈에서 실행해 환경 override의 병렬 충돌을 피한다. readiness 실패에 두 오류가 모두 포함되는지, 출력 제한·비식별화·소유 child 회수·임시 credential 제거를 확인한다. 실모델 검증으로 계산하지 않는다.

| 명령·검증 | 결과·근거 |
| --- | --- |
| 수정 전 `--test smoke_fake` | fail —21.43초/exit101. readiness는 exit7을 보고했으나 핵심 stdout 오류가 없어 회귀 assertion에서 실패했다. `logs/goal-runtime-log-orbit124-before-20261010.log`. |
| 수정 후 동일 integration | pass —20.40초/1개. healthy health/SSE와 실패·정리 모두 실행. `logs/goal-runtime-log-orbit124-related-20261010.log`. |
| `--lib server::tests` | pass —20.93초/46개,906개 filtered. Unicode/chunk·redaction·긴 wrapper·clear/다음 실행, live writer 두 reader의 빠른 종료, 기존 readiness/상태/옵션 보호 포함. |
| Rust 전체 타깃·feature | pass —62.66초. lib948 pass/4 ignored, CLI15 pass, headless log·provider result contract·smoke_fake integration 통과. 실모델·실다운로드 등 gated ignored는 이번에 실행한 것으로 세지 않는다. |
| clippy 전체 타깃·feature / rustfmt check | pass —10.66초 /0.78초. 경고를 실패로 검사했다. |
| typecheck / lint | pass —8.99초 /5.04초. |
| 공통 `test:unit` 첫 실행 | fail —130.32초. contracts/direct/scripts 통과, UI179 files/1809개 pass, 기존 sampling raw override reset1개가5000ms timeout으로 실패했다. |
| 해당 UI file 재확인 | pass —2.86초/19개. source/test/timeout을 바꾸지 않았다. |
| 같은 공통 명령 순차 재실행 | pass —113.39초, UI180 files/1810개. coverage80.78/75.72/79.34/84.89%. 첫 실패를 보존하며 병렬 Rust 실행과의 경합이 원인이라고 확정하지 않는다. |

각 raw log는 `logs/goal-runtime-log-orbit124-{server-tests,rust-all,clippy,fmt-check,typecheck,lint,unit,ui-timeout-recheck,unit-sequential}-20261010.log`에 보관했다. 검사 skip·retry 설정·시간 제한 확대 없이 재확인했다. Python 제품 변경은 없다. 이번 Rust/macOS 검사를 Windows/Linux 실기기 검증으로 표시하지 않는다.

### 새 debug 앱과 데이터 보존

같은 source의 `cargo build --locked --manifest-path src-tauri/Cargo.toml --bin aiolm --all-features`는0.47초/exit0이었다. 기존 임시 debug bundle의 메타데이터/아이콘을 복사하고 새 executable을 넣어 ad-hoc으로 서명했다. 서명 전 빌드 원본과 복사본 hash 일치, 서명 후 hash와 deep/strict 검사를 기록했다. **서명이 바이너리를 변경하므로 서명된 app이 미서명 빌드와 byte-identical하다고 표시하지 않는다.** 작업용 debug bundle이며 배포물에 포함하지 않는다.

CUA는 기존 앱의 정상 종료 전에 다시 Mac 잠금 차단을 반환했다. 모델 stopped·API off·별도 정의0·생성 중 아님을 읽기 전용 관찰로 확인하고, 기록한 기존 fixture app group만 SIGTERM으로 종료했다. 기존 launcher가 Vite group을 회수했으며 app·driver·IPv4/IPv6 Vite listener 종료와 config/41개 대화 hash 보존을 확인했다. app exit-15/launcher exit1을 기록하고 정상 종료 pass로 세지 않는다. 원래 launcher 로그는 그대로 보존했다.

새 bundle로 개발 서버와 앱을 원래 임시 홈에서 실행했다. `goal-runtime-log-orbit124-restored-preservation.json`의8개 조건은 config 전체/hash·41개 대화 목록/hash·localStorage 불변, 별도 정의0·API off/model stopped, 서명된 executable의 hash 일치와 새 bundle에서 실제 실행 중인 프로세스를 확인한다. 관측 errors/overlay0은 전체 console 검증을 뜻하지 않는다. raw는 `goal-runtime-log-orbit124-debug-{prepared,owned-before-replacement,replacement-cleanup}.json`, `goal-native-audio-orbit124-{before-build,restored-6a374ce}-20261010.json/png`, 빌드·교체·복원 로그다.

새 앱을 CUA로 선택할 때도 Mac 잠금 차단이 반환됐다. `goal-runtime-log-orbit124-native-lock.json`에 보관했다. 모델은 stopped이고 실제 Qwen 재시작·새 title/진단 화면·실제 엔진 실패/취소 뒤 출력 회수는 blocked다. 이전 native 증거와 이번 실제 합성 프로세스 검사를 새 소스의 실모델/GUI 통과로 대체하지 않는다. 미디어 내용 실패·upstream URI 제한·MCP Yes/No와 실제 call 취소·트레이/Dock/OS 알림, 별도 계정/Keychain/upgrade/Finder·Intel/구형 macOS의 남은 상태를 유지한다. 응답 언어 실패는 미분류이며 개인 엔진 등록은 [설계](pluggable-inference-runtimes.ko.md)의 미구현 범위다. 전체 목표를 완료로 표시하지 않았다. 원격 push는 수행하지 않았다.


## 66. 진단 보존 소스 `6a374ce`의 arm64 DMG

기존 `npm run package:tauri`로 제품 source `6a374ce63a8d5f8fa078fe4defb5fc6b1b06c3bc`를 패키징했다. 생성197.54초, native arm64 CPython3.12 검사5.95초 모두 exit0이다. `logs/goal-runtime-log-orbit124-{package,inspection}-20261010.log`, `goal-native-runtime-lock-package-6a374ce-results.json`에 근거를 보관했다. 검사 전·후 HEAD와 DMG hash는 불변이다.

| 산출물 | 보존 위치·검사 |
| --- | --- |
| DMG | `goal-package-6a374ce/AioLM_0.3.1_aarch64.dmg`,16813297 bytes, SHA-256 `84a3b4c64bdfb7c8b2d2d9da1dbba793d46e6daa89a80d3bce1adf529df83a2a` |
| GUI | arm64, SHA-256 `7dbd4837bc05d4979bc7090433ba630adfa7b820d9d2d4e135f40a078c9d74f2` |
| CLI | arm64, SHA-256 `c42bf48d8c5b94df1fb63eee48f181d3e9bc98451490820463f478ef2b5e3843` |

read-only/nobrowse mount에서 버전0.3.1·최소 macOS13.3·정확한 기존5개 파일·symlink 없음·실행 파일과 빌드 원본 hash 일치를 확인했다. GUI/CLI·sealed app의 ad-hoc 서명/deep/strict 검사는 통과했다. source/home 경로·기존/이번 fixture·새 합성 실패 flag와 오류 문구의 UTF-8/UTF-16 LE/BE scan은 모두0이었다. 새 격리 홈의 패키지 CLI exit0·onboarding 미완료·모델/runtime 없음·홈 안 models directory, 이미지의 해시 일치 보존 복사와 mount 해제를 확인했다.

이 production GUI는 실행하지 않았다. Mac 잠금으로 새 debug native 진단과 실제 엔진 재검증도 blocked다. Developer ID·공증·자연스러운 Finder 설치 실행·quarantine·별도 계정 Keychain·upgrade·Intel/구형 macOS는 unrun이며 미디어/MCP/OS 통합의 잔여 상태를 유지한다. 전체 M01–M12 통과나 임의 개인 엔진 등록 완료를 뜻하지 않는다. 원격 push는 수행하지 않았다.


## 67. 잠금 해제 후 현재 debug 소스의 실제 응답·진단·종료

`612016d` checkout에서 제품 코드 변경 없이 `6a374ce63a8d5f8fa078fe4defb5fc6b1b06c3bc`의 서명된 debug bundle과 현재 frontend를 검증했다. 현재 실행 파일 hash가 65절의 서명 후 hash와 일치한다. CUA의 실제 AX·화면·입력으로 검증하고, 읽기 전용 WebDriver/IPC·파일 hash·OS 프로세스 근거를 함께 보관했다. 이 절의 PNG는 보조 WKWebView 캡처이며 native 조작 근거를 대신하지 않는다.

| 실제 여정 | 결과·근거 |
| --- | --- |
| 저장 프로필로 시작 | pass — vLLM Default의 저장된 `--max-model-len=4096`을 확인하고 Save profile & start. 값·기본값을 바꾸지 않았다. 실제 로딩 중 Chat 입력·첨부·전송 비활성화와 Loading model 안내, 이후 Ready·모델명·입력 활성화 확인. |
| 엔진·모델 | 별도 등록된 vllm-metal0.30.0/vLLM0.30.0+cpu, 기존 Qwen3-VL-2B-Instruct-4bit의 고정 revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`. 설치·다운로드·외부 환경 변경 없음. |
| 출처별 실제 진단 | pass — stdout의 EngineCore 초기화·Metal warmup·API readiness, stderr의 upstream 경고가 각각 label과 함께 표시됐다. 실제 native 스크롤로 로그 끝과 stderr에 접근했다. 각4KiB tail·동일 stream의 앞부분 잘림은 유지한다. upstream 중복 AVFoundation class 경고가 사라졌거나 이전 시작 실패 원인이 해결됐다고 주장하지 않는다. |
| 한국어 기본 제목 | pass — Settings에서 한국어로 전환한 새 빈 대화의 제목·목록·삭제 접근성 이름이 새 대화로 표시됐다. 같은 표시 제목으로 검색해 해당 빈 대화만 남는 것을 확인했다. 첫 요청 후 자동 이름 지정도 유지됐다. title 편집 placeholder·삭제 확인창은 이번 실제 여정에 포함하지 않았다. CUA typeText가 검색 원문을 넣지 못한 첫 시도는 paste로 재확인했으며 제품 입력 실패로 분류하지 않는다. |
| 실제 새 요청 | pass(이번 내용 범위) — 합성 질문 8+5에 한국어 한 문장 `8과 5를 더하면 13이 됩니다.`를 반환했다. 이전 63절의 중국어 첫 응답 실패를 성공으로 바꾸거나 그 원인을 확정하지 않는다. |
| 모델·PP·TG | pass — 고정 실행 영역과 응답의 Qwen 모델명, PP48 tokens/cache0, TG15 tokens/459.1557ms/30.4907tok/s. TTFT11505ms·준비27ms·요청11512ms. 런타임이 제공하지 않은 PP 시간·속도는 `—`와 이유로 표시되며 저장 데이터에도 해당 값이 없다. PP 시간을 TTFT로 대신하지 않았다. |
| 대화 재로드 | pass — 다른 대화→이번 대화 재선택, 앱 재실행 뒤 자동 복원에서 내용·모델명·PP/TG·cache·시간 유지. 모델 stopped에서도 저장된 응답 지표를 표시한다. |
| 정상 종료 | pass(기록한 실행 범위) — 실제 Cmd+Q 뒤 앱·vLLM 부모/core/자원 tracker의 기록4 PIDs와 모델·driver·IPv4/IPv6 Vite listener가 종료됐다. original launcher는 app exit0/전체 exit0. config/hash·42개 대화/hash 불변. `goal-native-orbit128-normal-quit-cleanup.json`과 원래 restore 로그가 근거다. |
| 최종 개발 환경 | pass — 원래 임시 홈의 동일 debug bundle/Vite 재실행, 저장 이력 복원·같은 기본 Qwen 재시작·Ready. 최종 API off·생성 중 아님·원래 English/밀도 유지. 준비 완료를 실제 native 화면과 IPC로 확인했다. |

raw는 `goal-native-audio-orbit128-{baseline,starting,loading,diagnostics,ready-diagnostics,localized-title,first-response,reloaded,before-quit,restored-repaired,final-ready}-20261010.json/png`와 대응 `logs/goal-native-orbit128-*-20261010.log`, `goal-native-orbit128-{owned-before-quit,normal-quit-cleanup,original-data-and-response-audit}.json`이다. 첫 starting 캡처는 profile 저장 대기 중 stopped였으며 실제 loading 캡처와 구분한다.

정상 종료 직후 CUA 관찰에서 별도의 같은-bundle 프로세스가 나타났다. 관찰에 의한 재실행은 시점으로부터의 추론이며 제품 crash로 분류하지 않는다. 최초 복원 launcher의 exit0은 기존 인스턴스 전달이므로 복원 성공으로 세지 않았다. 기록한 해당 debug process group만 SIGTERM으로 정리했으며 자식은 없었다. 이어진 복원 helper는 이미 이동된 stale session 파일을 다시 rename하다 실패했고, 그 뒤 관찰도 닫힌 driver에서 ECONNREFUSED로 실패했다. optional 파일의 존재를 확인하도록 helper를 수정한 뒤 새 로그·driver·실제 앱 PID·hash·native 화면으로 복원을 확인했다. 이 실패와 강제 정리도 원본 로그 및 `goal-native-orbit128-observer-relaunch-cleanup.json`에 남겼으며 기존 실행의 정상 종료 근거와 섞지 않는다.

최종 데이터 audit는 기존41개 대화/hash·21개 프로필 ID/내용·프로필 영역 밖 config 불변을 확인했다. 합성 대화1개를 추가했고 localStorage 변경은 그 대화의 active selection뿐이다. 두 번의 실제 Save profile & start로 vLLM Default revision16→18과 적용 snapshot/library revision만 바뀌었으며 설정 내용은 같았다. 초기 audit가 저장 모델 경로와 서버 alias를 직접 비교해 실패한 것은 helper의 잘못된 가정이었다. 저장 모델은 execution.active_model, 서버 alias는 engine.upstream_model과 각각 일치하는 것을 확인했다. URL의 `/v1` suffix를 정수 port로 읽던 초기 helper 오류도 URL parser로 수정하고 기록했다.

이번 제품 코드·추가 자동 검사·패키지 변경은 없다. 전체 자동 검사와 DMG는 65·66절의 동일 제품 소스 근거를 따른다. 이 production GUI 실행·실제 실패/취소 시 새 진단 수집, 미디어 내용 실패·URI upstream 제한·실제 ffmpeg 부재, MCP Yes/No 뒤 도구/모델 응답·호출 중 취소, 트레이/Dock/OS 알림 수신은 여전히 남아 있다. 별도 계정·Keychain·upgrade·자연스러운 Finder 설치 실행·Intel/구형 macOS는 unrun이다. 개인 엔진 registry/manifest 등록은 미구현이며 전체 목표나 M01–M12 완료를 표시하지 않는다. 원격 push는 수행하지 않았다.

## 68. 실제 production 응답과 설치 목록 조회 상태 수정

잠금 해제 상태에서 66절의 `6a374ce` DMG와 바이트가 같은 GUI/CLI를 별도 임시 홈에 복사해 실행했다. strict 서명·해시·CoreFoundation 홈 격리·fresh CLI의 미완료 onboarding/빈 모델·런타임·격리된 모델 기본 경로를 확인했다. 같은 OS 계정의 임시 홈이며 별도 계정 최초 실행·Keychain 검증으로 계산하지 않는다. 실제 화면 조작은 CUA로 수행했고 release 앱에는 개발 서버·WebDriver를 사용하지 않았다.

| 실제 여정 | 결과·근거 |
| --- | --- |
| 기존 개발 앱 정상 종료 | pass — 실제 Cmd+Q 뒤 기록한 앱·엔진의4 PIDs, 모델·driver·IPv4/IPv6 Vite listener 종료와 launcher exit0을 확인했다. 닫힌 앱을 다시 getApp/getAXState로 관찰하지 않고 inventory만 조회했다. 같은 debug bundle의 중복 실행 없음·config/hash·42개 대화/hash 불변. 이 근거를 production 정상 종료로 사용하지 않는다. |
| 격리 production 초기 설정 | pass — 한국어·시스템 테마·명시적인 모델 폴더로 onboarding 완료. 새 대화의 제목·목록·삭제 접근성 이름이 한국어로 표시됐다. 기존 설정을 factory default로 복사하지 않았다. |
| 기존 엔진 등록·실행 | pass — 현재 inventory의 사용 가능한4 runtime을 확인하고 기존 vllm-metal0.30.0/vLLM0.30.0+cpu 환경을 fixture 홈에 외부 등록했다. 모델은 기존 Qwen3-VL-2B-Instruct-4bit, revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`. 새 설치·다운로드 없음. GUI의 Recovered profile에서 실제 context 입력이 비어 있음을 확인하고 첫 Start 전에 `max_model_len=4096`을 명시적으로 입력·저장했다. fixture 준비의 평면 설정 값이 프로필 편집값에 이미 적용됐다고 가정하지 않는다. 실제 Loading→Ready와 모델명 확인. |
| 새 요청·내용 | 산술 pass / 한국어 지시 fail — 9+6을 한국어 한 문장으로 설명하라는 합성 요청에 `9加上6等于15。`, finish reason stop을 반환했다. 실제 native 화면과 저장 응답에서 확인했다. 원인을 확정하거나 강제 언어·seed·template 변경으로 통과시키지 않았다. |
| PP·TG | pass(제공된 지표 범위) — PP48 tokens/cache0, TG8 tokens/339.8409ms/20.5979tok/s, TTFT4960ms·준비26ms·요청4985ms. 런타임이 제공하지 않은 PP 시간·속도를 만들어 넣지 않았다. 모델명·응답·지표의 native 표시와 저장 값을 확인했다. |
| production 재로드·정상 종료 | blocked — 응답 뒤 native screenshot 관찰 시 Mac이 다시 잠겼다. 이번 production PNG는 수집하지 못했으며 이력 재로드·정상 GUI 종료도 실행하지 못했다. native AX 관찰과 저장 thread/config·프로세스 근거를 보관했다. |
| production 소유 자원 정리 | pass(강제 정리 범위) — 기록 PID·프로그램·process group·listener 소유권과 원래 데이터 hash를 확인한 뒤 해당 fixture의 엔진·앱 그룹만 SIGTERM.4 PIDs 종료·모델 listener 닫힘·원래 config와42개 대화/hash 불변·자체 short TMP 제거 확인. app exit−15/runner exit1은 강제 종료 결과이며 crash 또는 정상 종료 pass로 바꾸지 않는다. |

실제 Runtime 설정 화면에서 설치 목록을 읽는 중 미설치 경고가 먼저 나타났고, 설치된 Metal descriptor가 도착하면 사라지는 제품 결함을 재현했다. `3564440f1722b66f418c4da71e672b1938698456`은 공통 설정 editor에서 조회 대기·실패·확정 결과를 구분한다. 대기/실패는 선택이 없다는 근거가 아니며, 성공한 빈 목록은 실제 미설치로 안내한다. Start는 현재 선택을 확인할 때까지 차단하고 새로고침은 이전 readiness를 철회한다. private frontend callback의 nullable 상태만 추가했으며 IPC·공개 API·저장 schema·프로필·엔진 기능 계약을 바꾸지 않았다.

| 자동 검사 | 결과·시간 |
| --- | --- |
| 수정 전 세 엔진의 지연 inventory 회귀 | fail — llama.cpp/vLLM/MLX 모두 잘못된 미설치 안내,3개 실패·2.95s. 필터로 제외된 기존 검사63개는 실패 skip 처리나 통과 근거가 아니다. |
| 최종 관련 UI 검사 | pass — 2 files/85 tests·43.64s. 성공한 빈 Python inventory·refresh 대기·실패 시 readiness 철회·저장값 불변 포함. 총6개 회귀를 추가했다. |
| TypeScript / lint | pass — 9.50s / 5.57s. |
| 전체 `npm run test:unit` | pass — 114.59s. contracts·provider options·scripts·direct 검사와 UI180 files/1816 tests 통과. coverage statements80.8%/branches75.75%/functions79.37%/lines84.9%. |

추가 회귀의 최초 실행은84 pass/1 fail이었다. 제품이 반환한 `Error:` prefix까지 포함된 문자열에 테스트가 exact text를 요구한 문제였으며, 핵심 오류 문자열을 검사하도록 수정한 뒤 같은85개가 통과했다. 실패 로그도 보존한다. readiness 제거·해시 무시·timeout 확대·실패 skip은 하지 않았다. React 효과의 취소 guard·독립 조회의 병렬 실행·렌더 시 파생 상태·접근성 status/error를 검토했고 새 dependency는 없다. frontend만 변경했으므로 Rust/Python 전체 검사를 이번에 재실행한 것으로 표시하지 않는다. 동일 Rust 소스의 근거는65절, 새 전체 패키지 build는69절이다.

원래 임시 홈의 서명된 `6a374ce` debug core와 수정 frontend/Vite를 재실행했다. 최종 읽기 전용 관찰·audit에서도 config 전체/hash·42개 대화/hash·localStorage 불변, 추가 세션 정의 없음, API off·모델 stopped·생성 중 아님·UI 오류/overlay 없음을 확인했다. session_list에는 정상적인 stopped 기본 행이 있으므로 전체 목록이 비어야 한다고 요구한 초기 audit 가정을 고치고 config.sessions의 추가 정의 부재를 별도로 검사했다. 수정 후 native 화면과 Qwen 재시작은 CUA 재확인에서도 재잠금으로 blocked다. 이 개발 환경을 Ready로 표시하지 않는다.

raw는 `goal-production-orbit129-{source-inventory,prepared,debug-owned-before-quit,debug-normal-quit,retry-launch,native-response-and-lock,owned-before-forced-cleanup,forced-cleanup,retry-exit,short-temp-cleanup}.json`, `goal-native-audio-orbit129-{before-production,restored,final}-20261010.json/png`, `goal-runtime-inventory-orbit129-{restored,final}-preservation.json`과 대응 로그다. before-production/restored/final PNG는 보조 debug WKWebView 캡처이며 production native 캡처로 부르지 않는다. 검사 로그 prefix는 `logs/goal-runtime-inventory-orbit129-`이며 before·related·final-related·verified-related·typecheck·lint·unit·final-observe·final-audit 결과를 모두 남겼다.

미디어 내용 실패·upstream URI 제한·실제 ffmpeg 부재 검사, MCP Yes/No 뒤 실제 도구/모델 응답·호출 중 취소, 트레이/Dock/OS 알림 전달은 남아 있다. 별도 계정·Keychain·upgrade·자연스러운 Finder 설치 실행·Intel/구형 macOS는 unrun이다. 개인 엔진 registry/manifest 등록은 미구현이고 전체 M01–M12/목표 완료를 선언하지 않는다. 원격 push는 수행하지 않았다.

## 69. 설치 목록 상태 수정 소스의 arm64 DMG

제품 소스 `3564440f1722b66f418c4da71e672b1938698456`에서 기존 `npm run package:tauri`를 실행해 CLI·frontend·release GUI와 arm64 DMG를 생성했다. exit0·201.46s이며 chunk 크기 경고는 남아 있다. 공증 자격 증명이 없는 ad-hoc 패키지이므로 공증 완료로 표시하지 않는다.

| 산출물 | SHA-256 |
| --- | --- |
| `goal-package-3564440/AioLM_0.3.1_aarch64.dmg` — 16,813,203 bytes | `62815d7867511b72f1d29514bc018baabd2a3151f93709f64d72a44585489253` |
| GUI `aiolm` | `382909211c95e843b1f7242f33ba66178e39cc8878a18a73e011cd46d411fd93` |
| CLI `aiolm-cli` | `30e3119a878102c934aff49d431995dd95f88a7e973bd5dc3d1461671614aa46` |

`goal-native-runtime-lock-package-3564440-results.json`과 `logs/goal-runtime-inventory-orbit129-package{-inspect,}-20261010.log`가 근거다. native arm64 CPython3.12에서 read-only/nobrowse mount로 검사했고 exit0·7.35s였다. source HEAD 전후 일치·version0.3.1·최소 macOS13.3·GUI/CLI arm64·정확한5개 bundle 파일·strict deep ad-hoc 서명·build app과 이미지 내부 binary hash 일치가 pass다. UTF-8/UTF-16 두 byte order의 개인 홈/checkout 경로·기존 fixture·새 ORBIT-129 fixture 검사에서 일치0건이었다.

새 격리 홈에서 packaged CLI config get exit0, 미완료 onboarding·빈 모델/런타임·격리 홈 내부 모델 경로를 확인했다. 원본 이미지 hash 불변·보존 복사 hash 일치·mount 해제도 확인했다. 임시 설정·원본 모델·실행 로그·캡처는 배포 bundle에 들어 있지 않으며 Git 제외 대상 tmp에만 보관했다.

이 새 production GUI는 unrun이다. 68절의 실제 production 실행은 `6a374ce`의 근거이며 새 설치 목록 수정의 native 검증을 대신하지 않는다. Mac 잠금으로 수정 후 debug 화면·실제 Qwen 재시작도 blocked다. Developer ID·공증·자연스러운 Finder 설치 실행·quarantine·별도 계정/Keychain/upgrade·Intel/구형 macOS 및 미디어/MCP/OS 통합의 남은 판정을 유지한다. 임의 개인 엔진 등록이나 전체 M01–M12 완료를 선언하지 않으며 원격 push는 수행하지 않았다.

## 70. 설치 목록 수정의 실제 재검증과 미선택 런타임 안내

2026-10-11 Mac 잠금 해제 후 서명된 `6a374ce` debug core와 `3564440` frontend에서 실제 CUA 조작을 재개했다. 아래 결과는 새 근거이며 68·69절의 재잠금 당시 판정을 소급 변경하지 않는다.

| 실제 앱 검사 | 결과·근거 |
| --- | --- |
| 세 엔진의 설치된 runtime 선택 | pass — 외부 vllm-metal0.30.0·외부 mlx-vlm0.7.6·관리형 llama.cpp CPU b11460을 각각 설정 draft에서 선택했다. 확인된 선택에 잘못된 미설치 안내가 없고 저장 config·기존42개 대화/hash는 그대로다. llama.cpp로 전환할 때 호환되지 않는 snapshot 선택은 해제되며 모델 선택 안내가 나타났다. 이번에는 llama.cpp 추론을 실행하지 않았다. |
| vLLM 재시작·실제 응답·이력 | pass — 기존 Default 프로필의 context4096을 확인하고 저장/시작했다. loading 동안 composer가 비활성화되고 Ready 뒤 활성화된다. 고정 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`가 13+8 질문에 `13 + 8 = 21입니다.`로 답했고 finish reason은 stop이다. 기존 대화로 전환한 뒤 돌아와 응답·모델명·지표 보존을 확인했다. |
| 실제 응답 지표 | pass(제공된 측정 범위) — PP49 tokens/cache0, TG12 tokens/665.163ms/16.537tok/s, TTFT13126ms·준비38ms·요청13212ms. PP 시간/속도는 미제공으로 이유와 함께 `—`다. TTFT로 대체하지 않았다. |
| 실행 중 설정의 inventory 대기 | pass — 실제 `Checking runtime information.` 안내가 나타날 때 잘못된 미설치 경고가 없었다. 이미 실행 중인 모델의 Unload control을 유지하며 inventory 조회만으로 실행을 중단하지 않았다. |
| 미선택 runtime | fail→수정 후 pass — MLX draft에 runtime 선택이 없는데 본문은 선택된 runtime이 미설치됐다고 안내하고 footer는 미선택으로 안내했다. 설치된 runtime을 선택하면 본문 경고가 사라지는 최소 재현을 확인했다. 수정 후 미선택은 runtime 선택 안내·Start 비활성화로 일치한다. 저장하지 않은 draft를 폐기하고 원래 vLLM 실행을 유지했다. |

`9fcbbbb92ea24a794121f93a60d935e21e341b49`은 본문 미설치 경고에 실제 runtime 선택 조건을 추가했다. 성공한 빈 inventory에서 선택된 runtime의 미설치 판정, inventory 대기/실패 처리, readiness·Start 보호·저장값은 유지했다. private UI 조건과 회귀 검사·아키텍처 설명만 변경했으며 공개 API·schema·프로필·엔진 계약과 lockfile은 변경하지 않았다.

| 자동 검사 | 결과·시간 |
| --- | --- |
| 수정 전 vLLM/MLX 미선택 회귀 | fail — 2개 실패·2.85s. 필터로 제외된 기존68개는 실행한 것으로 계산하지 않는다. |
| 관련 Dialog/ProviderControls | pass — 2 files/87 tests·69.00s. 실제 미선택 안내·Start 차단·apply/profile commit 부재와 기존 선택된 미설치·지연 조회 검사를 함께 확인했다. |
| TypeScript / lint | pass — 30.22s / 23.34s. |
| 전체 `npm run test:unit` | pass — 147.05s. contracts·provider options·scripts·direct 검사와 UI180 files/1818 tests. coverage statements80.8%/branches75.76%/functions79.37%/lines84.9%. |

실제 debug 시작 과정에서 먼저 관측한 엔진 PID가 종료되고 이후 다른 PID가 Ready가 됐다. frontend HMR이 loading 중 있었지만 PID 교체 원인은 확인되지 않았다. agent는 추가 Start를 클릭하지 않았으며 이를 crash나 정상 warmup으로 단정하지 않는다. 최종 실제 응답·Ready와 이전 PID 부재를 기록했다. 72절의 새 production 실행에서는 별도로 관측한 단일 엔진 실행을 사용했다. frontend 변경이므로 전체 Rust/Python 검사를 이번에 반복 실행한 것으로 표시하지 않는다. 동일 Rust 소스 검사는65절, 새 전체 패키지 build는71절이다.

MCP에서는 기존 합성 stdio 서버의 조회→인자 검토→`Approve and run once`를 실제 UI에서 실행했다. 승인 대기의 Running/Cancel control과 소유 peer·승인 process를 확인했지만 CUA가 별도 `osascript` 앱을 선택하지 못해 `Invalid app: osascript`를 반환했다. 실제 OS Yes/No는 확인하지 못했다. 이후 agent 클릭 없이 Chat 화면으로 전환됐고 원인은 미확인이다. 소유 peer·승인 PID는 종료됐으며 새 fixture 이벤트는 initialize/list뿐이고 `tools/call`은 없다. 강제 signal이나 실제 Cancel 클릭 없이 종료된 이번 시도를 승인·도구 호출·호출 취소 pass로 계산하지 않는다. 해당 승인 process는 더 이상 대기 중이 아니다.

수정 후 원래42개 대화/hash를 보존하면서 합성 응답 대화1개를 추가했다. config의 프로필 영역 밖은 불변이고 vLLM Default의 기존 값은 revision18→19 외에 동일하다. API off·생성 중 아님·Qwen Ready·추가 세션 정의 없음·UI 오류/overlay 없음도 확인했다. 실제 Cmd+Q로 debug 앱과 엔진을 정상 종료하고 driver/Vite/모델 listener 닫힘·config/43개 대화 보존을 확인한 뒤 production 검증을 시작했다.

raw는 `goal-native-audio-orbit132-{baseline,vllm-settings,mlx-settings,llama-settings,before-start,starting,loading,current,load-result,response,live-settings,unselected-after,before-production}-20261011.json/png`, `goal-runtime-selection-orbit132-before-production-audit.json`, `goal-mcp-approval-orbit132-{before,pending,terminal}.json`, `goal-production-orbit132-debug-{owned-before-quit,normal-quit}.json`이다. native 조작/AX·화면 관찰은 대응 CUA tool 결과이며 JSON/PNG observer는 보조 debug WKWebView·IPC·파일 근거다. 수정 전 미선택 native AX는 tool 결과에 있고, runtime 선택 뒤 수집한 PNG를 수정 전 미선택 캡처로 부르지 않는다. 자동 검사 로그 prefix는 `logs/goal-runtime-selection-orbit132-`다.

미디어 내용 실패·URI upstream 오류·실제 ffmpeg 부재, MCP OS 승인 이후 실제 도구/후속 답변·호출 중 취소, 트레이/Dock/OS 알림 전달은 남아 있다. 이전 한국어 지시의 중국어 응답 실패도 원인 미분류로 유지한다. 이번 한국어 응답 성공만으로 모두 해결됐다고 판정하지 않는다.

## 71. 미선택 런타임 안내 수정 소스의 arm64 DMG

제품 소스 `9fcbbbb92ea24a794121f93a60d935e21e341b49`에서 기존 `npm run package:tauri`로 CLI·frontend·release GUI·arm64 DMG를 생성했다. exit0·229.27s이며 chunk 크기 경고는 유지한다.

| 산출물 | SHA-256 |
| --- | --- |
| `goal-package-9fcbbbb/AioLM_0.3.1_aarch64.dmg` — 16,813,256 bytes | `6792487ec4159e6ca833d9644d6d588625b726f0b0b7485f23e286d858e11841` |
| GUI `aiolm` | `a9320002cd96bb96ae9f028df5ee0273b52353696e34f1658336d7978689037b` |
| CLI `aiolm-cli` | `cbd7fa882d99f855d9b38b38d25123133e3c38d880fd941731e0afde8ee56dba` |

`goal-native-runtime-lock-package-9fcbbbb-results.json`과 `logs/goal-runtime-selection-orbit132-package{-inspect,}-20261011.log`가 근거다. read-only/nobrowse mount 검사 exit0·3.65s. source HEAD 전후 일치·version0.3.1/최소macOS13.3·정확한5개 bundle 파일·GUI/CLI arm64·strict deep ad-hoc 서명·build app과 이미지 내부 binary hash 일치가 pass다. UTF-8/UTF-16 양 byte order에서 개인 홈/checkout 경로·기존 fixture·ORBIT-132 fixture 일치0건을 확인했다.

새 격리 홈의 packaged CLI config get exit0, 미완료 onboarding·빈 모델/runtime·격리 홈 내부 모델 경로, 이미지 원본/보존 복사 hash 일치·mount 해제도 pass다. 임시 설정·모델·로그·검사 도구·캡처는 bundle에 없으며 Git 제외 tmp에 보관한다. Developer ID·공증·quarantine·자연스러운 Finder 설치 실행은 검증하지 않았다. 해당 production GUI의 실제 검증은 다음 절이며 69절의 이전 binary unrun과 구분한다.

## 72. 새 production GUI의 실제 응답·재로드·정상 종료

71절의 검증한 DMG에서 복사한 GUI/CLI hash를 재확인하고, 개발 서버와 WebDriver 없이 실제 production GUI를 별도 임시 HOME·CoreFoundation home·XDG·legacy 경로에서 실행했다. packaged CLI의 공장 초기값부터 확인한 뒤 기존 외부 vllm-metal0.30.0과 고정 Qwen snapshot을 명시적으로 등록/선택했다. 초기화 기본값에 기존 설정·모델 경로를 넣지 않았다. 같은 OS 계정의 격리 환경이며 별도 계정의 최초 실행·Keychain·실제 upgrade나 Finder 설치 실행을 대신하지 않는다.

| 실제 production 검사 | 결과·근거 |
| --- | --- |
| 미선택 runtime 안내 | pass — 실제 MLX draft에 선택이 없는 상태에서 미선택 안내·runtime 선택 control·Start 비활성화가 일치하고 잘못된 미설치 본문은 없다. 실제 native screenshot으로 배치와 footer 접근을 확인했다. 이 fixture에 MLX를 설치하거나 추론한 검사는 아니다. |
| 설치된 vLLM 선택·loading·Ready | pass — 실제 외부 runtime 선택에 잘못된 미설치 안내 없음. recovered 프로필의 context 입력이 비어 있어 첫 Start 전에 실제 UI에서4096을 명시했다. 기존 flat CLI 값이4096이라는 이유로 GUI 입력도4096이라고 간주하지 않았다. Save profile/start 후 실제 loading·composer 차단→Ready·활성화를 확인했다. 관측 엔진 root는 한 PID다. |
| 실제 응답·모델명·지표 | pass(해당 요청) — 14+6 질문에 `14에 6을 더하면 20이 됩니다.`로 답했고 stop 종료다. 모델 Qwen3-VL-2B-Instruct-4bit/revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`, PP53 tokens/cache0·TG16 tokens/645.899ms/23.223tok/s·TTFT8079ms·준비27ms·요청8134ms를 기록했다. PP 시간/속도는 미제공 이유와 `—`로 유지한다. |
| 대화 재로드·실제 배치 | pass — 새 대화로 전환한 뒤 원래 응답 대화로 돌아와 내용·모델명·지표 보존을 native AX와 screenshot에서 확인했다. header·대화 목록·응답 지표·composer의 실제 화면을 관찰했다. 전체 크기/테마/언어 조합의 배치 pass로 확대하지 않는다. |
| 정상 종료·소유 자원·데이터 | pass — 실제 Cmd+Q 후 앱 exit0/runner exit0·480.14s. 앱·엔진·tracker·core의 기록4 PIDs와 소유 listener 종료, 같은 production bundle의 중복 실행 없음, production config/대화 불변·원래 config hash/43개 대화 hash 불변, 자체 short TMP 제거를 확인했다. 종료 뒤 CUA inventory만 조회하고 닫힌 앱을 재선택해 재실행하지 않았다. |

raw는 `goal-production-orbit132-{fresh-defaults,source-inventory,registration,prepared,retry-launch,loading,response,reloaded,before-quit,normal-quit,retry-exit,short-temp-cleanup}.json`과 `logs/goal-production-orbit132-*-20261011.log`/`logs/goal-production-orbit132-retry-app.log`다. actual native AX·입력·screenshot은 CUA tool 결과에 보관했다. 별도 production PNG 파일을 수집한 것으로 표시하지 않으며 debug observer PNG와 구분한다. production observer는 읽기 전용 파일·소유 process·listener/hash 근거이고 실제 UX 판정은 native 관찰을 사용한다.

production 정상 종료 뒤 원래 임시 홈·legacy 경로의 debug 앱/Vite를 복원했다. 실제 native 화면에서43개 대화와 원래 ORBIT-132 응답·모델명·지표 재로드, Default 프로필의 context4096을 확인하고 기존 값으로 저장/시작했다. 실제 loading→model loaded·composer 활성화와 읽기 전용 server status의 running을 확인했다. 최종 config는 프로필 영역 밖에서 불변이고43개 대화/hash·localStorage 전체·프로필 ID 목록/선택 메타데이터를 보존했다. vLLM Default는 revision19→20 외에 동일하며 library revision86→88·적용 snapshot1개만 갱신됐다. API off·생성 중 아님·추가 세션 정의 없음·UI 오류/overlay 없음이다. 이 개발 앱과 Ready 모델을 유지했다. raw는 `goal-native-audio-orbit132-restored-{loading,ready}-20261011.json/png`, `goal-runtime-selection-orbit132-restored-preservation.json`과 `logs/goal-runtime-selection-orbit132-restore-debug-20261011.log`다.

별도 계정·Keychain·upgrade·자연스러운 Finder 설치 실행·Intel/구형 macOS는 unrun이며 미디어/MCP/OS 통합의 남은 실패·blocked를 유지한다. 개인 엔진 registry/manifest 등록은 [장기 설계](pluggable-inference-runtimes.ko.md)의 미구현 범위다. 공통 기능과 데이터 계약을 유지하는 어댑터 방향을 따르되 이번 안내 수정이나 production 응답을 해당 확장 기능 구현으로 계산하지 않는다. 전체 M01–M12/목표 완료를 선언하지 않으며 공개 업로드·원격 push는 수행하지 않았다.

## 73. 이전 한국어 지시 실패의 직접 엔진 재현

2026-10-11 `b2de520`에서 이전 턴의 수정·production 검증 완료를 확인하고 재개했다. 실제 CUA는 Mac 잠금을 반환해 새 창·트레이/Dock·MCP 승인 조작은 blocked다. 잠금 해제를 요청한 뒤 재확인에서도 동일한 차단이 있었다. 원래 debug 앱/Qwen 엔진은 현재 OS 프로세스와 읽기 전용 IPC에서 실행 중이며 상태 파일만으로 살아 있다고 추정하지 않았다.

68절 production의 저장된 합성 입력 `ORBIT-129 검증입니다. 9 + 6의 답을 한국어 한 문장으로 설명해 주세요.`와 provider 옵션을 읽어 공통 `buildChatRequestBody`로 직접 요청을 재구성했다. 현재 모델 경로·provider 옵션이 당시와 같은 것을 확인했다. 기본 system prompt와 고정 모델 revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`를 사용했으며 sampling·seed·언어·template override는 추가하지 않았다. 세 요청의 body는 동일하다. 이 비교는 현재 같은 엔진 PID에 대한 직접 HTTP 요청이며 당시 native wire 요청을 캡처한 검사는 아니다.

| 직접 호출 | 결과·근거 |
| --- | --- |
| 첫 요청 | HTTP200·20609ms·stop/[DONE], prompt48/completion8/cache0. 응답 `9加上6等于15。`로 산술은 맞지만 한국어 지시 fail이며68절 저장 응답과 같다. |
| 두 번째 | HTTP200·1962ms·stop/[DONE], prompt48/completion20/cache32. `9에 6을 더하면 15가 되어, 15입니다.`로 해당 요청의 한국어 지시 pass. |
| 세 번째 | HTTP200·970ms·stop/[DONE], prompt48/completion15/cache32. `9에 6을 더하면 15가 됩니다.`로 해당 요청의 한국어 지시 pass. |

첫 실패는 앱 화면을 거치지 않는 엔진 직접 호출에서도 재현됐다. 따라서 native UI가 없어도 이 결과가 발생한다는 근거를 확보했다. cache 상태와 sampling에 따른 출력 차이의 인과관계, tokenizer/모델/runtime 내부의 구체 원인은 아직 확인하지 못했다. 후속 성공을 첫 실패의 해결로 계산하거나 cache 결함으로 단정하지 않는다. 강제 한국어 system prompt·seed·template 또는 임의 출력 한도를 제품 기본값에 넣지 않았으며 제품 코드·공개 API·설정 변경은 없다.

전체 helper exit0·24.99s이며 원본 요청·각 SSE/응답·usage·종료 이유는 `goal-language-orbit133-direct-20261011-request.json`, `goal-language-orbit133-direct-20261011-{1,2,3}.sse/json`, `goal-language-orbit133-direct-20261011.json`과 `logs/goal-language-orbit133-direct-20261011.log`에 보관했다. config 전체/hash·43개 대화/hash·localStorage·동일 앱/엔진 PID 보존, running·API off·active requests0·생성 중 아님·UI 오류/overlay 없음의 읽기 전용 근거는 `goal-native-audio-orbit133-{current,final}-20261011.json/png`과 `goal-language-orbit133-preservation-20261011.json`이다. 잠금 상태의 보조 WKWebView PNG는 새 native 화면 통과 근거가 아니다.

이번에는 제품 수정이 없어 이전 자동 검사·패키지를 반복하지 않았다. 70–72절의 검사/새 DMG/실제 native 응답·정상 종료 근거는 그대로 유지한다. 미디어 내용 실패·URI upstream 오류·실제 ffmpeg 부재, 실제 MCP Yes/No 이후 도구/후속 답변·호출 중 취소, 트레이/Dock/OS 알림 전달과 별도 계정/Finder/Keychain/upgrade·Intel/구형 macOS의 남은 범위를 유지한다. 전체 목표·M01–M12 완료와 개인 엔진 등록 구현을 선언하지 않으며 원격 push는 수행하지 않았다.

## 74. 실제 MCP OS 승인 이후 수동 도구 호출·결과·정리

2026-10-11 `efa020d`에서 Mac 잠금 해제 후 원래 debug 앱의 실제 CUA 조작을 재개했다. 서명된 Rust core는 `6a374ce`, frontend는 `9fcbbbb`이며 제품 코드는 변경하지 않았다. 기존 합성 MCP 정의를 사용해 조회→인자 입력·검토→`Approve and run once`를 실행했다. 이 fixture는 합성 결과와 작업용 로그만 만들며 외부 파일·네트워크 작업은 수행하지 않는다. CUA는 별도 승인 앱 선택에 `Invalid app: osascript`를 반환했으므로 실제 OS 클릭은 사람이 수행했다.

| 실제 검사 | 판정·근거 |
| --- | --- |
| 사람의 OS Yes·수동 echo 호출 | pass — 사용자가 Yes 클릭을 회신한 뒤 native AX에서 `Tool synthetic_echo completed`와 결과 `synthetic result`를 확인했다. baseline 이후 discovery/실행 세션의 initialize/list와 `tools/call` 정확히1회를 기록했다. 실행 peer·승인 process와 앞선 discovery peer는 모두 종료됐다. 합성 승인이나 직접 IPC로 대체한 결과가 아니다. |
| 실제 No | blocked — 별도 합성 인자로 새 승인창을 열고 No 클릭을 요청했으나 회신·클릭 근거가 없었다. 기존120초 승인 deadline 뒤 native `MCP tool approval timed out`와 소유 peer·승인 process 종료를 확인했다. 새 이벤트에 tools/call은 없으며 이를 사용자 거부 pass로 계산하지 않는다. 이 승인창은 더 이상 대기 중이 아니다. |
| 승인 이후 실제 호출 중 취소 | unrun — 기존 hold 도구를 잠시 활성화하고 새 승인창을 열었다. 실제 tools/call 시작을 관찰하는 읽기 전용 watcher는130.16초 뒤 exit1로 종료됐고 실제 호출 시작 이벤트는 없었다. native 결과도 승인 시간 만료다. 기록한 서버 부모·자식은 종료됐으며 실제 호출 중 Cancel을 누른 검사로 계산하지 않는다. 별도 승인 요청도 만료돼 더 이상 대기 중이 아니다. |
| 정의·데이터·원래 화면 복원 | pass — hold 정의를 원래 Disabled로 돌려6개 정의/1개 enabled와 registry 의미·hash를 복원했다. 첫 AX switch 클릭은 값이 바뀌지 않아 성공으로 기록하지 않고 실제 화면의 switch 클릭·저장 후 off를 확인했다. 작업에서 생긴 만료 알림만 닫고 Chat으로 돌아왔다. config 전체/hash·43개 대화/hash·localStorage·동일 앱/Ready 엔진을 보존했고 API off·생성 중 아님·UI 오류/overlay 없음이다. 원래 ORBIT-132 응답·모델명·PP/TG를 native AX와 screenshot에서 재확인했다. |
| Dock·트레이 접근 | blocked — 실제 Dock/SystemUIServer 선택은 각각 약5초 뒤 `-10005 timeoutReached`로 실패했다. 트레이/Dock 동작이나 OS 알림 전달 pass로 계산하지 않는다. |

수동 echo 도구 결과를 확인한 범위다. 모델이 도구를 선택하고 결과를 사용해 후속 답변하는 흐름은 이번에 실행하지 않았다. 현재 엔진의 `tools_auto`/`tool_parser`도 false이며 이를 승인 성공만으로 지원된다고 간주하지 않는다. 실제 No·모델 후속 답변·실제 호출 중 취소가 남아 있어 M08·M12의 전체 판정은 blocked를 유지한다. 승인 deadline이나 RPC 제한을 늘리거나 승인 절차를 우회하지 않았다.

raw는 `goal-mcp-approval-orbit136-{before,pending,success,no-before,no-pending,no-terminal,preservation}.json`, `goal-mcp-call-cancel-orbit136-{before,terminal}.json`, `goal-mcp-call-cancel-orbit136-watch.py`와 대응 watcher 로그다. 실제 시작이 없으므로 호출 시작 record는 생성되지 않았다. echo fixture SHA-256은 `3d88b663794e2fdb35e9c2223da2e1e13b0f0f82c9d1f4fdf6a0376e8069646b`, hold fixture는 `93f330def71dccbdbb1048c8edbbb6c9ddd039d27e2f29ec3e64a4d37aa3026d`다. `goal-native-audio-orbit136-{baseline,mcp-pending,final}-20261011.json/png`와 `logs/goal-mcp-approval-orbit136-final-observe-20261011.log`는 보조 debug WKWebView·IPC·파일 근거이며 실제 native AX·입력·screenshot은 CUA tool 결과다.

제품 수정이 없어 자동 검사·패키지를 반복하지 않았다. 70–72절의 공통 검사·현재 DMG·production GUI 검증 근거를 유지한다. 미디어 내용·upstream URI·실제 ffmpeg 부재, 언어 지시 실패의 원인, OS 통합과 별도 계정/Keychain/upgrade/Finder·Intel/구형 macOS의 남은 판정도 유지한다. 임의 개인 엔진 registry/manifest 등록은 미구현이며 전체 M01–M12나 목표 완료를 선언하지 않는다. 공개 업로드·원격 push는 수행하지 않았다.

## 75. 실제 모델 도구 요청·앱 거부와 채팅 상태 안내 수정

2026-10-11 `1cb7554`에서 원래 debug 앱의 native CUA 검증을 이어갔다. 설치된 고정 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`의 chat template이 JSON `<tool_call>` 형식이고 설치된 vLLM0.30.0의 `hermes` 파서가 같은 형식을 처리하는 것을 로컬 소스에서 확인했다. 기존 Default를 수정하지 않고 실제 UI의 Save as new로 별도 합성 프로필을 만든 뒤 `--enable-auto-tool-choice`/`--tool-call-parser hermes`와 기존 context4096으로 정상 종료·재시작했다. Ready와 `tools_auto`/`tool_parser` true를 실제 앱과 IPC에서 확인했다. 제품 기본값이나 다른 모델의 파서를 변경하지 않았다.

| 실제 앱 검사 | 판정·근거 |
| --- | --- |
| 모델의 첫 도구 요청·인자 검토 | pass(해당 요청) — 새 합성 대화에서 기존 echo 도구1개를 조회·선택했다. 실제 Qwen이 요청한 이름·JSON 인자가 입력과 일치했고 앱 승인 control이 나타났다. native PP204/cache0, TG37/1.49s/24.1tok/s, TTFT6.52s·준비0.03s·요청7.35s다. PP 시간/속도는 미제공으로 유지한다. |
| 실제 앱 Reject | pass — CUA로 Reject를 눌러 `MCP tool call rejected by the user`와 입력·첨부·도구 선택 활성화를 확인했다. actual tools/call은 없고 active requests0이다. 별도 OS No 클릭을 검증한 결과로 대체하지 않는다. |
| 거부 뒤 하단 안내 | fail→수정 후 pass — 실제 오류가 표시되고 assistant 응답은 제거됐는데 footer는 `Response complete · 1 messages`였다. 수정 후 같은 native 화면에 `Request failed · 1 messages`가 나타났다. 다음 실제 모델 요청의 승인 대기에서도 완료 대신 `MCP approval required`를 확인했다. |
| 같은 대화의 다음 인자 지시 | fail(원인 미확인) — 다음 입력에서 ORBIT-137B 인자를 요청했지만 모델은 첫 ORBIT-137 인자를 다시 요청했다. 앱이 실제 요청 인자를 표시한 것을 기록했다. 두 합성 인자 모두 같은 안전한 echo 검증 범위이며 이를 원하는 인자 선택 pass로 계산하지 않는다. PP57/cache192, TG37/1.32s/27.2tok/s, TTFT5.89s·준비0.03s·요청6.63s다. cache와 실패의 인과관계를 단정하지 않는다. |
| 실제 OS 승인 이후 모델 후속 답변 | blocked — 앱 Approve once로 소유 peer·OS 승인 process를 만들고 사람의 Yes를 요청했으나 재잠금과 미회신으로 승인 deadline이 만료됐다. 읽기 전용 IPC에서 `MCP tool approval timed out`·수정된 실패 footer와 두 process 종료·tools/call 없음·생성 중 아님을 확인했다. 실제 도구 결과를 받은 후속 모델 답변은 unrun이다. 현재 대기 중인 승인창은 없다. |

재잠금 뒤 같은 Ready 엔진·도구 파서 프로필로 일반 채팅을 직접 HTTP 요청했다. tools를 넣지 않은 공통 request builder·기본 system prompt·현재 요청 설정을 사용했다. HTTP200·15280ms·stop/[DONE], prompt48/completion12/cache0과 `4에 5를 더하면 9입니다.`를 확인했다. helper exit0·15.55s이며 config hash와 같은 엔진을 보존했다. `goal-mcp-followup-orbit137-plain-20261011-request.json`, `goal-mcp-followup-orbit137-plain-20261011.json/.sse`와 대응 로그가 근거다. 이 결과는 일반 엔진 요청이며 native 앱 재검증이나 MCP 도구 결과 이후 답변을 대신하지 않는다.

`a4b7fe04a3d46aba8dd7ebb8a2df2cfc888ae181`은 공통 composer에 현재 오류와 저장된 마지막 assistant의 failed/interrupted/finish reason을 반영한다. MCP 승인 대기를 완료로 표현하지 않으며 assistant 응답이 없는 대화는 메시지 수만 표시한다. 정상 완료·출력 한도·생성 중 안내를 유지한다. private component 입력·관련 회귀·채팅 설명만 바꿨으며 API·저장 schema·기본값·엔진/프로필·lockfile 계약은 변경하지 않았다. React best-practices 검토에서는 단순 파생 상태를 render에서 계산하고 새 effect/state/memo나 의존성을 추가하지 않은 것을 확인했다.

| 자동 검사 | 결과·시간 |
| --- | --- |
| 수정 전 요청 실패·승인 대기 회귀 | fail — 2 files/3 failures·2.83s. 두 discovery 결과에서도 오류 후 footer가 완료로 표시되는 것을 재현했다. |
| 관련 채팅·MCP 취소/알림 검사 | pass — 7 files/36 tests·3.24s. |
| 마지막 상태 전환·관련 회귀 | pass — 3 files/7 tests·2.92s. 정상·한도·실패·중단·user-only·빈 대화 안내와 active generation 우선순위를 확인했다. |
| TypeScript / lint | pass — 9.94s / 5.87s. |
| 전체 `npm run test:unit` | pass — 125.33s. contracts/provider options/scripts/direct 검사와 UI180 files/1818 tests, coverage80.8%/75.78%/79.37%/84.9%. |

raw는 `goal-native-audio-orbit137-{baseline,start,ready,pending,rejected,repeat-pending,terminal,final}-20261011.json/png`, `goal-mcp-followup-orbit137-{call-before,rejection,native-pending,native-terminal,preservation,final-preservation}.json`이다. native 조작/AX/screenshot은 CUA tool 결과이고 observer PNG는 보조 debug WKWebView 근거다. 로그 prefix는 `logs/goal-chat-status-orbit137-`와 `logs/goal-mcp-followup-orbit137-`다. 74절의 echo fixture/hash를 그대로 사용했으며 새 실행 코드로 승인을 우회하지 않았다.

원래43개 대화/hash·기존 모든 프로필을 보존하고 합성 대화1개·검증 프로필1개만 추가했다. config에서 변경된 영역은 provider_options/settings_profiles다. 현재 같은 앱과 고정 Qwen이 검증 프로필로 Ready이며 API off·UI 오류/overlay 없음이다. 재잠금으로 native Default 선택·원래 실행 옵션 복원은 아직 못 했으며 전체 config/localStorage가 불변이라고 표시하지 않는다. 실제 OS No·도구 호출 중 취소·모델 후속 답변·트레이/Dock/OS 알림과 다른 미디어/계정/플랫폼 잔여 범위를 유지한다. 전체 목표·M01–M12 또는 개인 엔진 등록 구현 완료를 선언하지 않으며 원격 push는 수행하지 않았다.

## 76. 채팅 상태 안내 수정 소스의 arm64 DMG

제품 소스 `a4b7fe04a3d46aba8dd7ebb8a2df2cfc888ae181`에서 기존 `npm run package:tauri`로 CLI·frontend·release GUI·arm64 DMG를 생성했다. exit0·221.22s이며 chunk 크기 경고와 공증 자격 증명 부재에 따른 ad-hoc 서명은 유지한다.

| 산출물 | SHA-256 |
| --- | --- |
| `goal-package-a4b7fe0/AioLM_0.3.1_aarch64.dmg` — 16,812,674 bytes | `5be92c8cfa4f8cda6709ed364827381b675f73161875d8d81c5fe543555bf380` |
| GUI `aiolm` | `4bbd85f8172a4262593de440062c7e02e137baeabf9b431b25886b6202f3a3f5` |
| CLI `aiolm-cli` | `9c4d0386bbd05672d32b99a75bd27cd208b052fe1791feced46c2fbadd6fd63a` |

`goal-native-runtime-lock-package-a4b7fe0-results.json`과 `logs/goal-chat-status-orbit137-package{-inspect,}-20261011.log`가 근거다. native arm64 CPython3.12의 read-only/nobrowse mount 검사 exit0·5.65s. source HEAD 전후 일치·version0.3.1/최소macOS13.3·정확한5개 bundle 파일·GUI/CLI arm64·strict deep ad-hoc 서명·build app과 이미지 내부 binary hash 일치가 pass다. UTF-8/UTF-16 양 byte order에서 개인 홈/checkout 경로·기존 fixture·ORBIT-136/137 fixture 일치0건을 확인했다.

새 격리 홈의 packaged CLI config get exit0·미완료 onboarding·빈 모델/runtime·격리 홈 내부 모델 경로, 이미지 원본/보존 복사 hash 일치·mount 해제도 pass다. 검증 프로필·합성 대화·실행 환경과 모델·로그·캡처는 배포 bundle에 들어 있지 않으며 Git 제외 tmp에만 보관한다.

해당 production GUI의 실행은 unrun이고 새 native 이력 재로드·원래 Default 실행 복원은 Mac 잠금으로 blocked다. 75절의 debug 화면 통과나72절의 이전 production GUI 성공을 새 binary 실행으로 대체하지 않는다. Developer ID·공증·quarantine·자연스러운 Finder 설치 실행·별도 계정/Keychain/upgrade·Intel/구형 macOS와 미디어/MCP/OS 통합의 잔여 범위를 유지한다. package 이후 읽기 전용 검사에서 같은 Ready 엔진·44개 대화와 기존43개 hash·기존 프로필·config의 승인 만료 이후 불변·이전 엔진 group과 승인/도구 peer 종료·API off·active requests0·UI 오류 없음도 확인했다. 전체 목표 완료를 선언하지 않으며 원격 push는 수행하지 않았다.

## 77. MCP 실행 대기와 저장된 미완료 요청 안내

2026-10-11 `0081c09`에서 검증을 이어갔다. 75절의 실제 앱은 OS 승인창에서 기다리는 동안 footer에 `Waiting for the first token`을 표시했다. 승인 시간이 만료된 합성 대화의 저장 record에는 빈 assistant와 `finishReason: tool_calls` 및 모델·측정값이 남았고 실제 도구 결과·최종 답변은 없었다. 기존 composer는 오류·pending 상태가 없는 재로드에서 이를 응답 완료로 계산했다. 실제 실행 대기는 앞선 native 근거, 재로드 상태는 합성 저장 record를 사용한 회귀로 각각 재현했다. 이번 새 native 재로드를 통과했다고 기록하지 않는다.

제품 수정 `a7ce8534da0ff83834c381d7203391e02fd574c4`은 native 도구 호출의 실제 비동기 구간에만 실행 대기 상태를 유지한다. 결과·오류·취소 후 해제하며 후속 모델 요청에는 첫 토큰/생성 안내를 다시 사용한다. 대화 데이터 정리는 대기를 즉시 해제하고 이전 호출의 늦은 완료를 무시한다. Stop과 기존 입력 잠금·승인·취소 계약을 유지한다. 저장된 `tool_calls` 응답은 미완료로 안내하며 이력을 열어 도구를 자동 승인·실행하지 않는다. 공통 frontend와 한국어/영어/일본어/중국어 안내·회귀·채팅 설명만 변경했고 API·저장 schema·런타임·프로필·기본값·의존성·lockfile을 바꾸지 않았다.

| 자동 검사 | 판정·근거 |
| --- | --- |
| 수정 전 실행 대기·취소/후속 상태 회귀 | fail — 2 files/3 failures·1.94s. 기존 안내와 없는 실행 상태를 재현했다. |
| 수정 전 저장 이력 회귀 | fail — 1 failure/42 skipped·1.51s. 미완료 tool_calls를 완료로 계산했다. skipped 항목은 실행한 검사로 계산하지 않는다. |
| 최초 관련 검사 | pass — 6 files/72 tests·4.84s. |
| 승인 실패·데이터 정리 추가 후 관련 검사 | pass — 4 files/54 tests·7.62s. 실행 대기/Stop·취소·실패·unmount·정리·후속 모델 요청·저장 이력 무실행을 확인했다. |
| TypeScript / lint | pass — 11.58s / 7.53s. |
| 전체 `npm run test:unit` | pass — 119.41s. contracts/provider options/scripts/direct 검사와 UI180 files/1822 tests. coverage statements80.81%/branches75.79%/functions79.37%/lines84.91%. |
| 새 실제 앱 화면·도구 실행·재로드 | blocked — CUA는 Mac 잠금 및 자동 해제 실패를 반환했다. 보조 observer PNG나 합성 회귀를 native 통과로 대체하지 않는다. |

앞선 수동 synthetic_echo의 사람 Yes·실제 tools/call1회·결과·정리는 74절의 성공 근거를 유지한다. 늦게 받은 Yes 회신만으로 75절의 만료된 별도 요청·모델 후속 답변을 성공 처리하지 않는다. 현재 승인창/호출은 대기 중이 아니며 실제 OS No·호출 중 취소·모델 후속 답변은 여전히 남아 있다. 제한 시간을 늘리거나 승인을 우회하지 않았다.

raw는 `logs/goal-mcp-wait-orbit138-{before,history-before,related,final-related,typecheck,lint,unit}-20261011.log`, `goal-native-audio-orbit138-{baseline,final}-20261011.json/png`, `goal-mcp-wait-orbit138-preservation.json`이다. 같은 앱·Ready Qwen 엔진·config/hash·44개 대화/hash·localStorage가 이번 baseline과 일치하며 API off·생성 중 아님·UI 오류/overlay 없음이다. 기존 Default는 보존됐으나 실제 선택·원래 실행 옵션 복원은 잠금 해제 이후 남은 작업이다.

React best-practices 검토에서는 저장 이력 상태와 안내 문구를 render에서 계산하고 native 비동기 작업에 필요한 상태만 추가했다. 공개 API나 저장 데이터로 실행 대기를 확장하지 않았으며 실행 종료 전에 후속 모델 요청을 대기로 오인하지 않는 회귀를 확인했다. Rust/Python 소스를 바꾸지 않아 해당 전체 검사를 이번 수정 후 다시 실행했다고 주장하지 않는다. staged 파일·diff·개인 환경값·공백 오류를 검토하고 제품 변경만 커밋했다. 전체 목표·M01–M12 및 개인 엔진 registry 구현 완료를 선언하지 않으며 공개 업로드·원격 push는 수행하지 않았다.

## 78. MCP 실행 상태 수정 소스의 arm64 DMG

제품 소스 `a7ce8534da0ff83834c381d7203391e02fd574c4`에서 기존 `npm run package:tauri`로 CLI·frontend·release GUI·arm64 DMG를 생성했다. exit0·202.93s다. 기존 chunk 크기 경고와 공증 자격 증명 부재에 따른 ad-hoc 서명을 유지했다.

| 산출물 | SHA-256 |
| --- | --- |
| `goal-package-a7ce853/AioLM_0.3.1_aarch64.dmg` — 16,815,910 bytes | `47ec5f57f701fcdab4ed479504e7c355c5e6e9105c55be257913f51a973538ae` |
| GUI `aiolm` | `4ba3dfaf2d0c1bc065b1b850af9a5ed98fcfe4081a71d2ad05c975d6f552d432` |
| CLI `aiolm-cli` | `105228e15afd9326f985eaed6c9edb5636551744006cb18aedaaf712b6703a3e` |

검사 근거는 `goal-native-runtime-lock-package-a7ce853-results.json`과 `logs/goal-mcp-wait-orbit138-package{-inspect,}-20261011.log`다. native arm64 CPython3.12의 read-only/nobrowse mount 검사 exit0·4.62s이며 source HEAD 전후 일치·version0.3.1/최소macOS13.3·정확한5개 bundle 파일·GUI/CLI arm64·strict deep ad-hoc 서명·build app과 이미지 내부 binary hash 일치가 pass다. UTF-8/UTF-16 양 byte order에서 개인 홈/checkout 경로 및 기존/추가 fixture 일치0건이다.

새 임시 홈의 packaged CLI config get exit0·미완료 onboarding·빈 모델/runtime·격리 홈 내부 모델 경로, 원본/보존 이미지 hash 일치·mount 해제도 pass다. 실제 모델·검증 프로필·합성 대화·fixture·로그·캡처는 bundle에 포함하지 않고 Git 제외 tmp에 보관한다.

새 production GUI 실행·native 미완료 이력 재로드와 MCP 후속 답변/호출 중 취소·원래 Default 프로필 선택/실행 옵션 복원은 Mac 잠금으로 blocked 또는 unrun이다. 이전 debug/production GUI 성공과 이번 합성 회귀를 새 native 실행으로 대체하지 않는다. Developer ID·공증·quarantine·자연스러운 Finder 설치 실행·별도 계정/Keychain/upgrade·Intel/구형 macOS, 미디어 내용·URI upstream 오류·실제 ffmpeg 부재와 OS 통합의 남은 범위도 유지한다. 전체 목표·M01–M12 및 임의 개인 엔진 등록 구현 완료를 선언하지 않으며 원격 push는 수행하지 않았다.

패키지 이후 읽기 전용 근거는 `goal-native-audio-orbit138-package-20261011.json/png`, `goal-mcp-wait-orbit138-package-preservation.json`과 대응 observer 로그다. 이번 baseline 대비 같은 앱/엔진·config 전체/hash·44개 대화/hash·localStorage가 일치하며 API off·생성 중 아님·UI 오류/overlay 없음이다. 보조 WKWebView PNG를 새 native 화면 통과로 계산하지 않는다.

## 79. 실제 MCP 실행 대기·미완료 이력과 Default 복원

2026-10-11–12 잠금 해제 뒤 원래 debug 앱의 실제 CUA 검증을 재개했다. native core는 `6a374ce`, frontend는 처음 `a7ce853`이며 뒤의 정상 재실행에는 `20f1ff4`가 적용됐다. 앞선 미완료 이력의 모델명·PP/TG와 `MCP response incomplete` 안내를 실제 화면에서 확인한 뒤 새 합성 대화를 사용했다. 설치/모델 revision은 75절의 고정 Qwen과 vllm-metal 환경 그대로다.

| 실제 검사 | 판정·근거 |
| --- | --- |
| 새 모델 도구 요청 | pass(해당 요청) — synthetic_echo 이름과 ORBIT-141 JSON 인자가 새 입력과 일치했다. 실제 PP57/cache144, TG37/1.26s/28.6tok/s, TTFT27.66s·준비0.03s·요청28.30s. PP 시간/속도는 미제공이며 cache144를 cold-cache로 계산하지 않는다. |
| 앱 승인 뒤 native 대기 안내 | pass — 실제 Approve once 뒤 `Waiting for MCP tool`과 Stop 버튼을 확인했다. 별도 승인 process와 소유 MCP peer가 실제로 생성됐다. CUA inventory에는 별도 osascript 승인 surface가 없었다. |
| OS Yes 이후 모델 후속 답변 | blocked/unrun — 사람 Yes를 요청했으나 회신 없이 기존120초 제한으로 만료됐다. 실제 native 오류/실패 footer·입력 복구, tools/call 없음·두 소유 process 종료를 확인했다. 후속 답변 성공·사용자 No·실제 호출 중 취소로 대체하지 않는다. 현재 이 요청의 승인창은 없다. |
| 정상 앱 재실행 후 미완료 이력 | pass — production 검증 뒤 원래 홈의 debug 앱을 정상 재실행하고 해당 이력을 실제 선택했다. 모델·PP/TG·`MCP response incomplete · 2 messages`를 확인했다. 46개 대화/hash·config/hash가 그대로이며 도구를 자동 승인/실행하지 않았다. |
| 원래 Default 실행 복원 | pass — 실제 UI로 도구 파서 검증 프로필을 정상 중지하고 Default를 선택·저장/시작했다. 기존 max_model_len4096과 tools_auto/tool_parser false, Ready 및 `7과 6을 더하면 13이 됩니다.`를 확인했다. PP52/cache0, TG15/0.56s/25.2tok/s, TTFT6.54s·준비0.03s·요청6.86s. 기존 프로필 내용은 보존됐고 Default 저장 revision20→21만 변경됐다. 이전 엔진 group3개 process와 포트도 종료됐다. |

새 프로필은 작업용 합성 프로필이며 제품 기본값이나 원래 Default 설정을 바꾸지 않았다. 77–78절의 blocked/unrun은 당시 결과로 보존하며 위의 새 native 근거로 별도로 연결한다. 실제 No·모델 도구 결과 후속 답변·실제 호출 중 취소가 남아 M08/M12 전체 판정은 blocked다.

raw는 `goal-native-audio-orbit140-baseline-20261011.json/png`, `goal-native-audio-orbit141-{baseline,request,toolwait,terminal,defaultstart,defaultloading,defaultready,debugreloaded}-20261012.json/png`, `goal-mcp-followup-orbit141-{before,native-pending,terminal}.json`, `goal-default-restore-orbit141-{before,old-cleanup,results}.json`, `goal-native-orbit141-debug-reload-checks.json`이다. 실제 native 조작/AX/screenshot은 CUA tool 결과이며 tmp observer PNG는 보조 WKWebView 근거다. 기존44개 대화/hash를 보존하고 새 합성 대화2개만 추가했다. 앞선 수동 echo Yes의 성공은 74절에 유지하며 늦은 회신으로 만료된 다른 요청을 소급 성공 처리하지 않는다.

## 80. 실제 production GUI와 KV cache 오류 안내 수정

`a7ce853` DMG와 바이트가 같은 production GUI/CLI를 별도 작업용 홈·CoreFoundation/legacy 홈에서 준비했다. 새 홈 CLI 초기값·엄격한 서명·이미지/binary hash 확인 후 설치된 외부 환경을 다시 등록했다. 실제 GUI에서 한국어·테마·모델 폴더 초기 설정을 마쳤다. 별도 OS 계정이나 자연스러운 Finder 설치 실행을 대체한 검사는 아니다.

첫 launch는 다른 debug 인스턴스에 전달돼 exit0으로 즉시 끝났다. 이를 GUI 통과로 계산하지 않고 첫 로그/결과를 보존했다. 빈 debug 인스턴스를 실제 native Quit으로 종료하고 다른 AioLM GUI가 없는 것을 확인한 뒤 새 run record로 다시 실행했다. 종료된 App target을 다시 조회하면 검증 앱이 다시 열릴 수 있어 이후에는 OS process/launcher 종료로 확인하고 새로 띄운 PID가 살아 있을 때만 CUA를 바인딩했다. 해당 빈 화면에서 설정을 변경하거나 원래 파일을 삭제하지 않았다.

두 번째 실행의 모델 시작에서는 준비 단계의 CLI 옵션과 실제 저장 프로필의 값이 달랐다. 실제 native 진단의 vLLM은 model default max seq len262144에 KV cache28.0GiB가 필요하지만 available8.49GiB라며 실패했다. 저장 프로필의 provider_options가 비어 있는 것도 읽기 전용 파일 근거로 확인했다. 이 시작 실패는 검증 홈의 프로필 적용/용량 조건이며 제품이 모델을 정상 로드했다고 계산하지 않았다. 실제 UI의 `--max-model-len`에4096을 저장해 재시작한 뒤 Ready·`8과 9의 합은 17입니다.`·모델명·PP/TG·완료 안내를 확인했다. PP49/cache0, TG14/0.46s/28.5tok/s, TTFT4.67s·준비0.03s·요청5.07s다. 정상 Quit/relaunch에서 같은2개 메시지·모델·측정값·stop 이유/hash가 복원됐고 onboarding/자동 모델 실행은 반복되지 않았다. source `a7ce853`의 실제 GUI 성공이며 새 `20f1ff4`의 결과는 81절에 구분한다.

새 합성 메모리 검증 프로필의 첫 AX Save as new 클릭은 동작하지 않아 성공으로 계산하지 않고, 실제 포인터 클릭·이름 입력·저장을 확인했다.

같은 실패에서 `Check the model path and file integrity`를 안내한 것은 제품 결함이다. `20f1ff405ef4906c5eaedf7d7a1b7ea045475d84`는 out-of-memory 및 구체적인 KV/cache allocation 실패를 일반 model/file/traceback·timeout wrapper보다 먼저 분류한다. 원래 runtime detail은 보존하며 active-response guard·일반 timeout/port/executable/invalid-model 분류도 유지한다. memory라는 디렉터리 이름만 있는 invalid model 회귀를 포함했다. API·프로필·엔진·기본값·readiness·timeout·메모리 제한·lockfile은 변경하지 않았다.

| 검증 | 판정·근거 |
| --- | --- |
| 수정 전 합성 최소 회귀 | fail — 실제 로그 구조를 합성 경로/숫자로 구성한 direct 검사에서 model≠memory·0.40s. |
| 수정 후 lifecycle direct 검사 | pass — 4.16s. KV 용량·CUDA OOM/timeout wrapper·cache allocation 및 일반 invalid model 보존. |
| TypeScript / lint | pass — 12.36s / 7.65s. |
| 전체 `npm run test:unit` | pass — 129.84s. contracts/provider options/scripts/direct와 UI180 files/1822 tests. coverage80.8%/75.77%/79.37%/84.9%. |
| 실제 엔진의 수정된 오류 안내 | pass — 원래 Default를 보존한 새 합성 프로필에서 model default context의 KV 실패를 재현했다. native `There is not enough available memory or VRAM for this configuration`을 확인했고 원인 로그·failed 상태·46개 대화/hash·기존 모든 프로필·소유 server/core/group 종료를 보존/확인했다. 실패 전 bound port를 포착하지 못한 이 한 건을 포트 왕복 통과로 확대하지 않는다. |
| 재검증 후 정상 설정 복원 | pass — 실제 Default 선택·저장/시작으로 max_model_len4096, tools_auto/tool_parser false와 Ready를 확인했다. Default21→22는 저장 revision뿐이며 기존 내용과 다른 설정·46개 대화는 보존됐다. |

raw는 `goal-production-orbit141-{fresh-defaults,prepared,first-outcome,second-launch,second-exit,second-cleanup,reloaded,reload-checks,third-exit,third-cleanup}.json`, `goal-production-orbit141-{onboarding,loading,failed,completed,completed-checks}.json`과 대응 launcher/observer 로그다. 코드 검사 prefix는 `logs/goal-memory-hint-orbit141-{before,related,typecheck,lint,unit}-20261012.log`다. 새 실제 실패·복원은 `goal-native-audio-orbit141-{memoryloading,memorystarting,memoryfailed,memoryrestored}-20261012.json/png`, `goal-memory-hint-orbit141-{native-results,restored-checks}.json`에 보관했다. 시작 관찰 이름인 memorystarting에도 이미 terminal failed가 기록돼 있으며 live wait나 Ready 근거로 계산하지 않는다. Rust/Python 전체 검사를 이번 frontend 수정 후 다시 실행했다고 주장하지 않는다.

## 81. 메모리 안내 수정 소스의 DMG와 실제 production 응답·재로드

제품 소스 `20f1ff405ef4906c5eaedf7d7a1b7ea045475d84`에서 기존 `npm run package:tauri`로 arm64 GUI/CLI·DMG를 생성했다. exit0·222.06s이며 기존 chunk 크기 경고와 공증 자격 증명 부재에 따른 ad-hoc 서명을 유지했다.

| 산출물 | SHA-256 |
| --- | --- |
| `goal-package-20f1ff4/AioLM_0.3.1_aarch64.dmg` — 16,815,183 bytes | `9ea089497d44ed58b61bcd7268d923bd889cfc171541eea6d57ba327ef7cf480` |
| GUI `aiolm` | `aa32131761d49f7abbfe85b3cdfd82bdf83627189e043f1db6a25a2a7c06f2fd` |
| CLI `aiolm-cli` | `9c4d0386bbd05672d32b99a75bd27cd208b052fe1791feced46c2fbadd6fd63a` |

`goal-native-runtime-lock-package-20f1ff4-results.json`, `logs/goal-memory-hint-orbit141-package{-inspect,}-20261012.log`가 근거다. native arm64 CPython3.12의 read-only/nobrowse mount 검사 exit0·6.54s. source HEAD 전후 일치·version0.3.1/최소macOS13.3·정확한5개 bundle 파일·GUI/CLI arm64·strict deep ad-hoc 서명·build/이미지 binary hash 일치·UTF-8/UTF-16 양 byte order 개인 홈/checkout 경로와 기존/추가 fixture 일치0건·새 홈 CLI 초기값·이미지 보존/hash·mount 해제가 pass다.

검증 이미지를 다시 read-only로 열어 별도 app copy를 만들고 기존 작업용 production 홈의 명시적4096 프로필/합성 이력을 유지했다. 실제 CUA의 저장 프로필 시작→Ready→새 요청에서 `10과 11의 합은 21입니다.`와 모델명·PP/TG·완료 안내를 확인했다. PP106/cache0, TG16/0.55s/27.1tok/s, TTFT4.73s·준비0.02s·요청5.09s다. 원래 두 메시지를 바꾸지 않고 새 두 메시지만 추가했고 stop 이유와 측정값을 저장했다. 새 소스의 정상 Quit/relaunch에서 네 메시지 전체/hash·모델·측정값·완료 안내가 복원됐으며 모델 없이 composer가 비활성인 것도 확인했다. 이전 binary의 성공을 새 binary 검증으로 대체하지 않았다.

이 production 앱은 Vite 없이 격리 env의 binary로 직접 실행했다. native Quit과 launcher exit0, 소유 GUI/engine group·실제 포트·작업용 short temp 정리를 확인했으며 재로드 앱도 exit0·short-temp 정리·다른 AioLM GUI 없음 뒤 원래 debug 홈을 복원했다. 원래 config/hash와46개 대화/hash는 이 production 검사 동안 불변이고 기존 외부 환경·고정 모델 파일을 이동/삭제하지 않았다. 같은0.3.1의 작업용 binary 교체·기록 재로드이며 실제 과거 버전 업그레이드·별도 계정·자연스러운 Finder 설치 실행으로 계산하지 않는다.

raw는 `goal-production-source20f1ff4-orbit141-{prepared,launch,boot,completed,completed-checks,first-quit-checks,reload-launch,actualreload,reload-checks,reload-exit,final-cleanup-checks}.json`과 `logs/goal-production-source20f1ff4-orbit141-*.log`이다. 실제 native 화면/입력은 CUA tool 결과이고 observer는 파일·프로세스·이미지 해시 근거다. staging/개인 환경값/공백 검토 뒤 source/회귀만 `20f1ff4`로 커밋했다. 원격 push·공개 upload는 수행하지 않았다.

실제 MCP OS No·승인 이후 모델 도구 결과 후속 답변·실제 호출 중 Cancel, Dock/트레이/OS 알림·실제 ffmpeg 부재, URI upstream/미디어 내용 실패와 별도 계정/Keychain/upgrade/Finder·Intel/구형 macOS의 기존 남은 범위는 유지한다. 임의 개인 엔진 registry/manifest 등록도 미구현이며 전체 목표/M01–M12 완료를 선언하지 않는다.

최종적으로 원래 작업용 홈의 debug 앱을 다시 정상 실행하고 실제 Default 시작→Ready를 확인했다. Default22→23은 저장 metadata만 바뀌었고 모든 프로필 내용·다른 config 값·46개 대화/hash·한국어 저장 응답/모델/PP·TG를 보존했다. API off·active requests0·생성 중 아님·기록된 UI 오류/overlay 없음이며 현재 새 앱/엔진 PID가 실제로 살아 있다. `goal-native-audio-orbit141-{finalstarting,final}-20261012.json/png`, `goal-native-orbit141-final-preservation.json`, `logs/goal-runtime-selection-orbit141-final-restore-debug-20261012.log`가 근거다. finalstarting 관찰 때에도 이미 running이었으므로 이름만으로 대기 중이라고 판단하지 않는다. 원래 Default 선택/실행 옵션 복원은 더 이상 남은 작업이 아니며 실제 MCP OS 클릭·호출 중 취소 등 위의 잔여 범위는 유지한다.

## 82. 런타임 오류 배너 닫기 수정과 현재 MCP 승인 결과

`6e27196bf628b8973f6b9ea9dbe73df82c17c87e`는 실제 WKWebView에서 재현한 배너 닫기 결함을 수정했다. 메모리 용량 실패 후 Dismiss를 누르면 store에서 지운 error를 다음 native status poll이 다시 반환해 같은 배너가 반복됐다. 앱은 현재 오류의 알림 확인 여부를 보관하고, store는 backend 오류·로그를 유지한다. 달라진 오류·새 작업 실패·복구 후 재발은 다시 알리며 진단 화면의 failed 상태·원인 로그를 숨기지 않는다. 공개 타입·엔진·프로필·기본값·readiness·시간 제한은 바꾸지 않았다.

| 검증 | 판정·근거 |
| --- | --- |
| 수정 전 회귀 | fail — 합성 배너 재표시·authoritative error 삭제 두 검사가 실패, 5.96s. |
| 수정 후 관련 검사 | pass — 두 파일 43 tests, 6.09s. |
| TypeScript / lint / build | pass — 10.95s / 6.24s / 36.11s. 기존 bundle chunk 경고 유지. |
| 전체 `npm run test:unit` | pass — 157.79s. contracts·provider options·scripts·direct 및 UI180 files/1824 tests. coverage80.84%/75.78%/79.42%/84.91%. |
| 실제 오류 알림·진단 보존 | pass — 원래 Default를 보존하고 기존 합성 memory 프로필의 실제 KV 실패를 재현했다. 수정 전 native Dismiss 후 재등장, 수정 후 Dismiss·후속 poll·Diagnostics 이동에서도 배너 없음/같은 오류와 로그 보존. 기존46개 대화/hash와 실패 소유 server/core 프로세스 종료 확인. native core는 `6a374ce`, Vite frontend는 `6e27196`이다. |

원본은 `goal-dismiss-orbit142-before.json`, `goal-dismiss-orbit142-native-results.json`, `goal-native-audio-orbit142-{baseline,dismiss-before,dismiss-fixed}-20261013.json/png`와 `logs/goal-dismiss-orbit142-{before,related,typecheck,lint,unit,build,native-before,native-fixed}-20261013.log`다. 이번 frontend 수정에 Rust/Python 전체 검사를 새로 실행한 것으로 기록하지 않는다.

74절의 수동 echo는 사람의 OS Yes·실제 tools/call1회·결과·정리 pass를 유지한다. Yes 회신만으로 별도 모델 후속 요청의 성공을 소급 처리하지 않았다. 기존 합성 MCP 프로필을 실제 선택/시작하여 새 요청을 만들었다. 새 대화의 도구가 기본 off인 상태의 첫 응답에는 호출이 없었고, 앱의 Load MCP tools 후 정확한 새 인자의 tool request가 생성됐다. native Approve once→Waiting for MCP tool·Stop이 실제로 표시됐지만 CUA는 새 OS 창도 `Invalid app: osascript`로 선택할 수 없었다. 새 사람 클릭을 요청한 뒤 기존120초 한도에서 실제 approval timed out을 확인했다. peer/approval 프로세스 종료·입력 활성화·미완료4메시지 재선택 안내와 모델/측정값 보존은 pass다. 이번 요청의 tools/call은0건이며 OS No와 모델 도구 결과 후속 답변·실제 호출 중 Cancel은 blocked를 유지한다. 첫 응답을 실제 도구 결과나 모델 후속 처리 성공으로 계산하지 않는다.

원본은 `goal-native-audio-orbit142-{mcp-starting,mcp-wait,mcp-timeout,mcp-history}-20261013.json/png`, 대응 `logs/goal-dismiss-orbit142-*.log`와 `mcp-quit-events.jsonl`이다. mcp-starting 관찰은 backend failed에서 UI loading으로 전환하는 중의 순차 읽기이며 Ready 근거가 아니다. 도구 환경은 앞 절과 같은 고정 Qwen revision·vllm-metal0.30.0/vLLM0.30.0+cpu이고 외부 환경·모델 파일을 보존했다. OS 승인 우회나 시간 제한 확대는 하지 않았다.

## 83. 오류 배너 수정 소스의 arm64 패키지

제품 소스 `6e27196`의 기존 `npm run package:tauri`가 exit0·277.84s로 완료됐다. GUI/CLI·DMG와 version0.3.1/최소macOS13.3를 유지했고 기존 chunk 경고·ad-hoc 서명·공증 자격 증명 부재도 유지했다.

| 산출물 | SHA-256 |
| --- | --- |
| `goal-package-6e27196/AioLM_0.3.1_aarch64.dmg` — 16,815,924 bytes | `56bd050df02f8b55e4406522b89bc6e176d6fe2f127e5f6ed0edfc5f6802400b` |
| aiolm | `48cb971d1ded04e1d46d52bd6ab9f27dcf8bee01a723bcf3ce60c3c83e0328e8` |
| aiolm-cli | `9c4d0386bbd05672d32b99a75bd27cd208b052fe1791feced46c2fbadd6fd63a` |

read-only/nobrowse mount 검사 exit0·13.33s. native arm64 CPython3.12·source HEAD 전후 일치·정확한5개 bundle 파일·두 binary arm64·strict deep ad-hoc 서명·build/이미지 hash 일치·UTF-8/UTF-16 양 byte order 개인 홈/checkout 경로와 추가 fixture 일치0건·새 격리 홈 CLI 초기값·이미지 보존/hash·mount 해제가 pass다. raw는 `goal-native-runtime-lock-package-6e27196-results.json`, `logs/goal-dismiss-orbit142-package{-inspect,}-20261013.log`다. 이 절 당시 새 이미지의 실제 production GUI 실행은 unrun이었다. 84절에서 해당 이미지의 새 실제 실행을 검증했으며 이전20f1ff4 실행으로 대체하지 않았다. 배너 수정의 실제 기기 근거는82절 WKWebView다.

전체 M01–M12 통과나 임의 개인 엔진 등록 구현을 선언하지 않는다. 기존 upstream/미디어 내용 실패·OS No/모델 도구 후속 답변과 실제 호출 중 취소·Dock/트레이/알림·별도 계정/Keychain/실제 업그레이드/Finder·Intel/구형 macOS 잔여 범위는 유지한다. 원격 push와 공개 upload는 수행하지 않았다.

실제 native Default 복원 후 backend running과 같은 모델명·저장 응답/PP/TG·입력 활성화를 확인했다. max_model_len4096·tools_auto/tool_parser false·API off·active response 없음·composer 빈 값·UI 오류/overlay 없음이며 현재 앱/엔진 생존, 이전 MCP engine/peer/approval 종료가 pass다. Default23→24·기존 MCP2→3·memory2→3은 저장 revision만 바뀌었고 모든 프로필 내용·다른 config 값·기존46개 대화/hash를 보존했다. 새 합성 MCP 대화 한 파일만 추가되어47개다. `goal-native-audio-orbit142-restored-20261013.json/png`, `goal-dismiss-orbit142-final-preservation.json`이 근거다. 앞선 final 관찰은 backend starting이라 그 자체를 Ready로 계산하지 않는다. 원래 저장 응답/측정값을 재확인한 것이며 새 Default 추론 샘플로 계산하지 않는다.

## 84. 새 DMG의 실제 production 실패·응답·작은 창·재로드

2026-10-13 `abdab98` checkout에서83절의 검증 이미지(제품 소스 `6e27196`)를 read-only로 열어 별도 app copy를 만들었다. GUI/CLI hash·strict 서명이 이미지와 일치했고 기존 작업용 production 홈의 명시적4096 프로필·네 메시지를 유지했다. 원래 debug 앱을 native Quit→launcher exit0으로 종료하고 engine/driver/Vite 포트와 소유 프로세스 정리를 확인한 뒤, Vite 없이 격리된 binary를 실행했다. 실제 CUA 화면/입력과 파일·프로세스·해시 관찰을 근거로 삼았다.

| 실제 흐름 | 판정·근거 |
| --- | --- |
| 새 이미지 실행·기존 기록 | pass — native 한국어 앱과 기존 네 메시지/모델/측정값을 확인했다. 새 onboarding·모델 자동 시작은 없었다. |
| 메모리 실패·배너 닫기 | pass — 원래 프로필을 보존한 별도 합성 프로필에서 context override를 제거해 실제 KV capacity 실패를 재현했다. 올바른 메모리 안내→Dismiss 한 번→후속 poll에도 배너 없음·failed 진단/원인 로그 보존을 확인했다. 실패 후 소유 자식은 없고 GUI만 남았다. 이 실패의 bound port를 포착하지 못했으므로 실패 포트 왕복으로 확대하지 않는다. |
| 정상 설정·새 응답 | pass — 보존한4096 프로필 선택/시작→Ready. 새 합성 대화에서 `12에 13을 더하면 25입니다.`. PP54/cache0, TG15/0.49s/28.7tok/s, TTFT5.26s·준비0.02s·요청5.61s. 실제 모델명·완료 안내·stop·측정값을 저장했다. PP 단계 시간/속도 미제공은 dash와 설명으로 표시하고 추정값을 넣지 않았다. |
| 실제 작은 창 | pass — CUA native resize로약800×600·360×520의 작은 창을 확인했다. 메뉴·모델명·composer·첨부/완료/전송 영역의 겹침 없음을 확인했고 좁은 답변 영역의 native scroll로 PP/TG에 접근했다. 모델/측정값/설정을 유지하고1280×800으로 복원했다. 임의 모든 내용·크기의 배치 통과를 의미하지 않는다. |
| 정상 종료·재로드 | pass — native Quit→launcher exit0, 소유 GUI/engine group·실제 listener 포트·작업용 short temp 정리. 같은 검증 copy의 정상 재실행에서 새 두 메시지와 이전 네 메시지·모델/측정값/stop이 그대로 복원됐고 모델 없는 composer는 비활성이었다. 재로드 앱도 native Quit→exit0·short-temp 정리 확인. |
| 데이터·외부 환경 보호 | pass — 원래 개발 config/hash·47개 대화/hash는 production 검증 전체에서 불변. production 기존 대화 불변/새 합성 대화 한 파일 추가, 모든 기존 프로필 내용 보존/선택 프로필4→5는 revision만 변경. 합성 실패 프로필 하나 추가. 외부 환경·고정 공개 모델 파일은 이동/삭제하지 않았다. |

raw는 `goal-production-source6e27196-orbit143-{prepared,launch,boot,memory-start,memory-failed,restoring,answer,completed,native-results,reload-checks,quit-checks,exit,cleanup,final-cleanup}.json`, `goal-production-source6e27196-orbit143-reload-{launch,reloaded,exit,cleanup}.json`과 대응 `logs/goal-production-source6e27196-orbit143-*.log`다. 실제 native AX/screenshot·resize·scroll·입력은 CUA tool 결과이며 observer는 UI를 조작하지 않고 파일/소유 프로세스만 읽는다. answer 관찰 이름만으로 완료를 판단하지 않고 실제 완료 뒤 completed의 새 assistant·finishReason·metrics를 검사했다.

Dock와 SystemUIServer는 이번 새 시도에서도 각각 CUA `-10005 timeoutReached`로 접근하지 못했다. 실제 OS No·모델 도구 결과 후속 답변/호출 중 취소·알림·별도 계정/Keychain/실제 업그레이드/Finder 설치·Intel/구형 macOS·기존 upstream/미디어 내용 실패는 남아 있다. 같은0.3.1의 작업용 app copy를 직접 실행/재로드한 것이며 별도 계정·과거 버전 업그레이드·자연스러운 Finder 설치를 대신하지 않는다. 제품 소스는 변경하지 않았고 전체 M01–M12 통과를 선언하지 않는다.

개발 앱 복원 직후 첫 설정 열기에서는 loading 표시 뒤 모달이 닫히는 native 관찰이 있었으며 원인은 미분류다. 읽기 전용 보조 캡처에는 모달이 열린 시점도 있어 서로 다른 시점의 관찰을 같은 상태로 취급하지 않았다. 이후 native 좌표 클릭으로 연 설정은 유지되고 정상 프로필 시작이 진행됐다. `goal-native-audio-orbit143-restored-20261013.json/png`, `goal-debug-modal-orbit143-events.json`에 관찰을 보존했다. 뒤의 passive close 이벤트 한 건은 open=true로 복원된 모달의 기록이며 앞선 두 닫힘의 원인 증거로 확대하지 않는다. 새로운 제품 결함으로 분류/수정 완료했다고 주장하지 않는다.

최종 native 개발 앱의 Default 시작→모델 로드됨·backend running·입력 활성화를 확인했다. Default24→25는 저장 revision만 변경됐고 모든 기존 프로필 내용·다른 config 값·47개 대화/hash·저장 응답/모델/PP/TG를 보존했다. API off·생성 중 아님·composer 빈 값·UI 오류/overlay 없음과 현재 앱/엔진 생존을 확인했다. `goal-native-audio-orbit143-final-20261013.json/png`, `goal-runtime-selection-orbit143-final-preservation.json`, `logs/goal-runtime-selection-orbit143-final-restore-debug-20261013.log`가 근거다. final-starting은 실제 starting이므로 Ready 근거로 계산하지 않는다. 원래 실행 설정 복원은 완료했고 앞의 미분류 초기 설정창 관찰 및 외부/수동 검증 잔여 범위는 유지한다.

## 85. 초기 설정창 관찰의 수동 입력 재검증

`0543058` checkout/제품 frontend `6e27196`, native debug core `6a374ce`에서84절의 초기 설정창 닫힘 관찰을 다시 확인했다. 실행 중인 앱의 요소 기반 클릭·정상 Quit/relaunch 후 stopped 앱의 첫 요소 기반 클릭 모두 실제 설정창을 열어 유지했다. passive observer는 pointer/click·Escape/cancel·dialog 연결/open/close만 관찰했으며 controls를 조작하거나 cancel을 합성하지 않았다. 첫 열기의 close 이벤트 한 건 뒤에도 open=true였으므로 close 이벤트 자체를 사용자 닫힘이나 제품 실패로 계산하지 않는다. 실제 Escape→닫힘/cancel1회→재열기 유지도 확인했다. 설정을 저장하기 전 config 전체/hash와47개 대화/hash는 불변이었다. 진단용 listener와 MutationObserver는 제거했다.

현재 재검증은 pass다. 앞선 두 닫힘의 원인은 여전히 미분류이며 이번 통과를 과거 원인 규명·결함 수정 성공으로 바꾸지 않는다. 제품 코드·기본값·프로필 정책·시간 제한을 변경하지 않았고 이전 단위 검사를 이번 새 실행으로 주장하지 않는다. warm/open·cold/open·Escape/reopen을 이번 실제 범위로 한정한다.

raw는 `goal-modal-orbit144-{passive-installed,warm-first,warm-closed,before-quit,quit-checks,cold-installed,cold-first,cold-escape,cold-reopened,cold-removed,results}.json`, `goal-native-audio-orbit144-{baseline,before-restore,restoring}-20261013.json/png`, `logs/goal-modal-orbit144-*.log`다. 원래 앱 normal Quit/launcher exit0→소유 engine/driver/Vite listener 및 프로세스 정리 뒤 같은 격리 홈으로 정상 재실행했고 현재 PID가 살아 있음을 확인해 CUA를 연결했다. 관찰 시간 초과만으로 재실행하거나 종료된 앱을 CUA로 다시 열지 않았다.

Dock·SystemUIServer 프로세스가 실제로 실행 중임을 확인했지만 이번 두 CUA 접근도 각각 `-10005 timeoutReached`다.82–85절의 연속 후속 검증에서 같은 OS 조작 조건이 유지됐다. 현재 새 MCP 승인창은 없으며, 남은 실제 OS No·도구 결과 후속 모델 응답/실제 호출 중 취소에는 새 사람 클릭이 필요하다. OS 알림·별도 계정/Keychain/실제 upgrade/Finder·Intel/구형 macOS·기존 upstream/미디어 내용 실패의 남은 판정도 유지한다. 전체 M01–M12 완료를 선언하지 않는다.

별도 normal Quit/relaunch의 첫 설정 열기는 WebDriver session을 만들지 않은 상태에서 CUA만으로 확인했다. 실제 AX/screenshot의 설정창 유지와 session 파일 부재·config/hash·47개 대화/hash 불변이 pass다. 이후 WebDriver를 연결한 뒤에도 같은 열린 창이 유지됐으므로 이번에는 관찰기 연결에 의한 닫힘도 재현하지 못했다. `goal-modal-orbit144-native-{no-observer,first-preservation,after-wd-connect,results,before-quit,quit-checks}.json`, `logs/goal-modal-orbit144-native-only-launch-20261013.log`와 native CUA 결과가 근거다. 이 비교를 앞선 닫힘의 원인 규명으로 대체하지 않는다.

최종 native Default 모델 로드됨·backend running·입력 활성화·저장 모델명/PP/TG를 확인했다. 두 정상 재실행의 Default25→27은 저장 revision만 변경됐으며 기존 프로필 내용·다른 config 값·47개 대화/hash를 보존했다. API off·생성 중 아님·composer 빈 값·UI 오류/overlay 없음과 현재 앱/엔진 생존이 pass다. `goal-native-audio-orbit144-final-20261013.json/png`, `goal-modal-orbit144-final-preservation.json`이 근거다. 새 추론 샘플로 계산하지 않으며 restoring 관찰 두 건은 이름과 달리 당시 이미 running이었다.


## 86. 포괄 승인 이후 새 모델 MCP 요청의 실제 대기 결과

2026-10-13 `b500aed` checkout/제품 frontend `6e27196`·native core `6a374ce`에서 사람의 포괄 승인을 받은 뒤 새 호출을 실행했다. 기존 MCP 전용 프로필을 native UI로 선택/시작하고 새 합성 대화에 Load MCP tools를 적용했다. 고정 Qwen snapshot·런타임 버전은 앞선 검증과 같다. 모델이 정확한 `ORBIT-148 native tool followup` 인자의 synthetic_echo 요청을 만들었고 PP201/cache0·TG37/1.26s/28.6tok/s와 실제 모델명을 표시했다. native Approve once→Waiting for MCP tool·Stop→소유 peer/별도 Mac 승인 process를 확인했다.

Mac 승인창의 실제 Yes 클릭을 요청했으나 클릭 결과와 tools/call은 확인되지 않았다. 기존120초 deadline 뒤 native `MCP tool approval timed out`·Request failed·입력 복구, 두 소유 process 종료를 확인했다. 신규 fixture 이벤트8건은 discovery/initialize/list뿐이며 실제 tools/call은0건이다. 포괄 승인을 실제 OS 클릭이나 도구 결과 후속 답변의 성공으로 계산하지 않는다. 이 요청의 창은 만료됐으며 실제 No·모델 도구 결과 후속 답변·실제 호출 중 취소는 남아 있다. 승인을 우회하거나 제한을 늘리지 않았다.

원래47개 대화/hash는 이번 요청 전체에서 보존됐으며 새 합성 대화 한 파일만 추가됐다. raw는 `goal-native-audio-orbit148-{mcp-baseline,starting,ready-check,model-request,os-pending,timeout,restoring}-20261013.json/png`, `goal-mcp-orbit148-pending-evidence.json`과 대응 검사 로그다. 제품 코드 변경 없이 실제 결과만 기록했으며 기존 자동 검사·패키지 결과를 새 검사로 주장하지 않는다. 전체 M01–M12 완료를 선언하지 않는다.

최종 native Default→model loaded·backend running·입력 활성화를 확인했다. 모든 기존 프로필 내용과 다른 config 값·localStorage·47개 대화/hash를 보존했다. Default27→28·MCP 프로필3→4는 저장 revision만 변경됐다. API off·생성 중 아님·UI 오류/overlay 없음과 소유 peer/approval 정리가 pass다. `goal-native-audio-orbit148-final-20261013.json/png`, `goal-mcp-orbit148-final-preservation.json`이 근거다. 이전 저장 답변/측정값 표시를 새 추론으로 계산하지 않으며 원격 push는 수행하지 않았다.


## 87. 엔진 미디어 거부 검사의 진단·판정 보완

`a057b8c` checkout에서 실제 실패 기록과 harness를 대조해 두 결함을 재현하고 `ff97a4c`로 수정했다. 직접 엔진의 file URI500을 입력 허용으로 읽히는 “not refused”로 기록하고, 오류 설명이 없는 빈400을 actionable refusal pass로 기록했다. 실제 loopback 최소 재현은 각각 수정 전 실패했다. 서버5xx·입력200·설명 없는4xx를 구분하며 셋 모두 fail이다. 설명 있는 JSON4xx만 pass로 유지하고 HTTP status·실패 요약·cleanup을 보존한다. 새 회귀 세 개는 이 판정과 정리를 검사한다. 앱의 입력 프로토콜이나 엔진 자체를 수정한 결과로 확대하지 않는다.

현재 고정 Qwen의 실제 vllm-metal에 합성 비존재 file URI를 직접 전송해500을 다시 확인했다. 앱 입력 거부와 별개의 엔진 HTTP 검사이며 이전 upstream 실패를 해소했다고 기록하지 않는다. 첫 보조 요청은 이미/v1인 endpoint에/v1을 중복해 models404로 실패했고, 관찰기 URL 조합 수정 뒤 실제 media500을 확인했다. 이404를 제품 결함/통과 근거로 계산하지 않는다.

현재 native 화면에서 모델명과 저장 PP/TG·입력 활성화를 확인했고 direct error 뒤에도 backend running·active requests0이다.48개 대화/hash·config/hash·localStorage가 불변이고 API off·UI 오류/overlay 없음이다. 저장 지표 표시를 새 추론으로 계산하지 않는다. raw는 goal-harness-orbit149-engine-uri.json, goal-harness-orbit149-preservation.json, goal-native-audio-orbit149-{current,final}-20261013.json/png다.

M03/M04/M07의 실제 upstream/내용 실패와 M08/M11/M12의 OS 수동 조작·계정/환경 차단은 유지한다. 새 OS 승인창을 만들거나 deadline을 늘리지 않았다. 전체 M01–M12 완료·새 DMG 검증을 선언하지 않으며 원격 push/공개 upload를 하지 않았다.

검사는 pass다. `npm run test:provider-runtime`31개/16.88s·합성 self-test, 최종 typecheck9.95s·lint5.28s, 최종 `npm run test:unit`129.29s(계약/provider-options/scripts/direct 포함·UI180파일/1824개), build12.71s를 확인했다. coverage80.84/75.78/79.42/84.91%다. `logs/goal-harness-orbit149-{related-final,typecheck-final,lint-final,unit-final,build}-20261013.log`와 `checks.jsonl`이 근거다. 수정 전500 진단 회귀/빈400 판정 회귀의 exit1은 각각 `before`/`empty-before` 로그로 보존했다. chunk 크기 경고를 유지하며 Rust/Python/app 소스는 변경하지 않아 과거 검사를 새 실행으로 주장하지 않는다.

## 88. 실제 MCP 거부·호출 취소·후속 답변과 두 런타임 비교

2026-10-13 `94db689` checkout에서 제품 frontend `6e27196`·native core `6a374ce`의 실제 WKWebView와 별도 Mac 승인창을 검증했다. 기존 공개 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`, vllm-metal0.30.0/vLLM0.30.0+cpu와 mlx-vlm0.7.6을 사용했다. 모델·환경을 새로 설치하거나 승인 요구·기존 deadline을 변경하지 않았다.

| 실제 흐름 | 판정·근거 |
| --- | --- |
| 수동 Yes | pass — 첫 거부용 요청에는 사람이 실제 Yes를 눌렀다. tools/call1회·native synthetic result·소유 peer 정리를 확인했다. 요청 의도만으로 No 성공으로 기록하지 않았다. |
| 실제 OS No | pass — 새 ORBIT-151B 창에서 사람이 No를 눌렀다. native user rejection·도구 호출0·소유 peer/승인 process 종료를 확인했다. |
| 실제 호출 중 취소 | pass — 기존 hold 도구를 잠시 활성화하고 실제 OS Yes 뒤 tools-call-start를 관찰했다. native Cancel→Cancelled·결과0·소유 부모/자식 종료를 확인했다. Cancelled 캡처는 호출 시작 후14.824s로 기존15s RPC timeout 이전이다. MCP 정의를 정확한 원본 bytes/hash로 복원했다. 승인 대기 취소를 실제 RPC 취소로 대체하지 않았다. |
| 모델→도구→모델 후속 처리 | 실행 pass / 내용 fail — 첫 ORBIT-151 요청은120s 승인 만료·tools/call0·소유 process 정리로 끝났다. 새151C/151D 요청은 실제 사람의 Yes→tools/call1회→후속 모델 요청·stop 완료까지 도달했다. 그러나 두 답변은 static 반환값 synthetic result 대신 각 요청의 입력 text를 반복했다. |
| 실제 도구 결과 전달 관찰 | pass —151D의 passive fetch 관찰에서 system/user/assistant/tool 네 역할, 일치하는 tool_call_id/name과 실제 JSON 결과 `{"content":[{"text":"synthetic result","type":"text"}]}`를 확인했다. 요청·응답을 변경하지 않았다. invoke 관찰에는 기록0건이므로 native RPC 반환을 그 관찰기로 확인했다고 주장하지 않는다. 관찰 후 원래 fetch/invoke 함수와 global 제거를 확인했다. |
| 직접 vLLM 비교 | 내용 fail — 실제 캡처와 동일한 후속 body를 같은 엔진에 재전송해 HTTP200·stop·같은 입력 인자 답변을 확인했다. 별도 fresh cache_salt의 cache0, temperature0·원래 JSON 결과, temperature0·순수 text 결과 비교도 모두 같은 오답이다. 앱 이력·UI·MCP 도구를 재실행한 결과가 아니다. |
| 직접 MLX 비교 | 내용 fail — 실제 앱에서 기존 MLX 환경/프로필·같은 snapshot을 선택해 Ready/tools_auto/tool_parser를 확인했다. 캡처의 messages/tools/call ID/결과를 유지하고 model만 실제 local routing으로 바꾸며 temperature0/max_tokens128을 명시했다. HTTP200·stop·PP267/cache0·TG12에서 같은 입력 인자 답변이다. 정답을 넣지 않은 추가 user 지시로 최신 content[0].text를 읽도록 한 비교도 PP305/cache0·TG12·같은 오답이다. 새 native MLX 승인 여정의 성공으로 확대하지 않는다. |
| OS 알림 상태·복원 | 상태/제출 pass / 수신 blocked — System Settings의 AioLM Allow가 off임을 실제 확인했다. 일시 on→앱 test notification 제출→원래 off로 복원했고 다른 OS/app 알림 설정을 보존했다. NotificationCenter 접근은 두 번 timeoutReached로 실패해 실제 제목/본문 수신은 확인하지 못했다. System Settings도 정상 종료했다. |

151D의 실제 native 최종 지표는 PP75/cache192·TG12/0.36s/30.7tok/s·TTFT3.08s·요청3.35s·stop이다. 정상 완료/측정값은 내용 정답의 근거가 아니다. 올바른 결과 전달과 두 런타임의 직접 재현으로 앱 전달 결함의 근거는 확인되지 않았다. 모델/엔진의 내용 실패로 남기며 결과 필드 제거·역할 변경·cache 무효화를 제품 수정으로 적용하지 않았다.

raw는 `goal-mcp-orbit151-manual-results.json`, `goal-mcp-orbit151-{hold-started,cancel-results,followup-timeout-results,wire-observed,passive-removed,direct-followup,cold-original,cold-temperature-zero-envelope,cold-temperature-zero-text}.json`, `goal-mcp-orbit151-mlx-vlm-{controlled-envelope,explicit-reading}.json`, `goal-native-audio-orbit151-{manual-yes,native-no,actual-cancel,followup-answer,mlx-ready,final-ready}-20261013.json/png`와 대응 로그다. 기존 fixture와 실제 반환값을 바꾸지 않았고 OS 클릭은 사람이 수행했다. CUA가 선택하지 못한 osascript 창을 다른 자동화 기술로 조작하지 않았다.

M08은 미실행 차단에서 실제 내용 fail로, M12는 기록된 기기 범위 pass로 갱신했다. M03/M04/M07의 실제 upstream/미디어 내용 실패와 M11의 Dock/트레이·알림 수신·promised/unreadable clipboard는 남는다. 현재 앱은 시작 때 PATH를 복구해 실제 설치된 ffmpeg를 다시 찾으므로 작업용 PATH만으로 진짜 부재 환경을 만들 수 없다. 시스템 binary를 숨기거나 PATH 복구를 제거한 검사를 부재 통과로 계산하지 않는다. 별도 계정·Keychain·실제 upgrade·자연스러운 Finder 설치 실행·Intel/구형 macOS는 unrun이다. 개인 엔진 registry/manifest 등록은 [미구현 장기 설계](pluggable-inference-runtimes.ko.md)로 유지한다. 이번 제품 소스/자동 검사/DMG 변경은 없으며 전체 기기 검증 통과·원격 push·공개 upload를 선언하지 않는다.

최종 실제 vLLM Default→Ready·입력 활성화·원래 선택 대화/저장 모델명·PP/TG를 확인했다. 기존48개 대화/hash·프로필 내용·프로필 외 config·localStorage는 보존됐고 새 합성 대화 세 파일만 추가됐다. Default28→30·MCP4→6·MLX audio3→4는 저장 revision 변경이다. Qwen의 원래 MLX97 적용도 복원했고 이 복원 선택으로 MLX recent만93→97로 갱신됐으므로 config 전체 불변으로 주장하지 않는다. 선택 복원 중 저장 실행 설정은 일시 변경됐지만 현재 실행 중인 vLLM process는 유지했다. API off·active requests0·생성 중 아님·composer 빈 값·UI 오류/overlay 없음·이전 engine/hold 소유 group 종료를 확인했다. `goal-native-audio-orbit151-final-preserved-20261013.json/png`, `goal-mcp-orbit151-final-preserved-results.json`이 근거다. 앞의 final-preservation/final-all-preservation에는 복원 미완료와 비교 실패가 기록돼 있으며 최종 통과 근거로 대체하지 않는다. 저장 응답 표시를 새 Default 추론 샘플로 계산하지 않는다.

## 89. 실제 사람의 트레이 Show·Dock 클릭 복원

2026-10-13 `82cb57d` checkout/동일 제품 frontend `6e27196`·native core `6a374ce`에서 사람이 클릭 가능한 시점을 확인하고 검증했다. 실제 Settings→Server에서 작업용 홈의 Close to system tray를 off→on으로 저장했다. native 닫기 버튼 뒤 기존 driver의 읽기 전용 `is_visible`만 관찰했으며 숨겨진 앱을 CUA로 선택하거나 AX를 읽어 재활성화하지 않았다.

| 실제 흐름 | 판정·근거 |
| --- | --- |
| 트레이 Show | pass — 닫기 뒤 visibility false, 사람의 Show AioLM 클릭 회신과 이후 true를 확인했다. true를 관찰한 뒤에만 CUA 화면을 다시 읽었다. |
| Dock 클릭 | pass — 다시 native 닫기→visibility false 뒤 사람이 Dock 아이콘을 클릭했다. 클릭 회신·읽기 전용 true·실제 창 복원을 확인했다. 이미 열린 창에 focus만 준 결과가 아니다. |
| 실행·데이터 보존 | pass — 두 복원에서 같은 GUI/engine PID·running·51개 대화/hash를 유지했다. config는 close_to_tray 외 동일하다. driver/engine의 IPv4 listener와 Vite의 IPv6 listener를 확인했다. IPv4만 검사한 첫 Vite 연결 실패는 관찰 주소 오류이며 제품 실패로 계산하지 않는다. |
| 트레이 Quit | blocked — 실제 사람의 Quit AioLM 클릭을 요청했다. 첫180s 읽기 전용 관찰에서는 아직 GUI/engine·실제 포트가 살아 있어 종료를 확인하지 못했다. 이는 관찰기의 한도이며 앱/RPC timeout을 늘린 결과가 아니다. 같은 메뉴 클릭 결과를 기다리는 별도 관찰을 시작했다. |

raw는 `goal-window-orbit152-{prepared-listeners,hidden-processes,human-actions}.json`, `goal-window-orbit152-{tray-hidden,tray-show-watch,dock-hidden,dock-show-watch}.jsonl`, `goal-native-audio-orbit152-{baseline,prepared,tray-shown,dock-shown}-20261013.json/png`와 대응 로그다. Show와 Dock의 외부 복원은 사람의 실제 클릭 회신을 포함하며 CUA 재선택으로 대체하지 않았다. 기존 launcher process와 exec handle은 더 이상 존재하지 않으므로 향후 Quit에서 launcher exit0이나 Vite 자동 정리를 추정하지 않는다. 이전에 확인한 소유 Vite group만 별도로 정리할 준비를 했다.

이 절 시점에는 작업용 close_to_tray가 임시 on이며 Quit/동일 홈 재실행 후 원래 off 복원은 아직 남아 있다. 원래51개 대화와 별도 production 홈의 두 대화 파일/hash를 보관하고 같은 홈 재실행 helper를 준비했으나 실행하지 않았다. 알림 플러그인의 개발 모드는 Terminal identity, custom-protocol 배포 모드는 AioLM identity를 사용하므로88절의 개발 알림 제출을 배포용 AioLM 수신으로 확대하지 않는다. 기존 검증6e27196 production copy의 GUI/CLI hash·strict 서명을 다시 확인하고 별도 홈의 알림 검사를 준비했지만 아직 시작하지 않았다. OS Allow는 이전 off를 유지하고 새 알림을 제출하지 않았다. 제품 소스·자동 검사·DMG 변경 없이 확인한 결과만 기록하며 M11·전체 기기 검증은 여전히 통과하지 않았다.

## 90. 실제 트레이 Quit·설정 복원과 배포 앱 입력 확인

2026-10-13 `1927692` checkout에서89절의 실제 사람의 Quit AioLM 클릭 회신을 받고 GUI/engine 소유 process 종료·driver/engine 실제 포트 닫힘을 확인했다. 앞의 두180s 관찰에서는 종료를 확인하지 못했으며 그 기록을 보존한다. 이후 실제 클릭의 결과로 tray Quit을 pass로 갱신했다. 원래 launcher/exec handle이 없으므로 exit0을 추정하지 않는다. 외부 검증용 Vite group이 남았지만 이전 소유 PID/group·checkout cwd를 확인하고 별도 SIGTERM으로 정리했다. 이를 앱이 소유하지 않은 Vite의 자동 종료나 제품 Quit 실패로 계산하지 않는다.

검증된6e27196 production copy의 GUI/CLI hash·strict 서명을 확인한 뒤 Vite 없이 기존 별도 홈으로 실행했다. 실제 한국어 WKWebView의 기존 두 대화·모델명/PP·TG·모델 없음·비활성 composer를 확인했다. 새 모델/추론은 실행하지 않았다. CUA의 Settings 요소/좌표 클릭·Raise·Tab은 화면 전환을 만들지 않았고 연결 초기화 후에도 같았다. native 앱 메뉴의 열기/Cancel은 동작했지만 Escape는 메뉴를 닫지 못했다. bundle ID만으로 선택하면 여러 copy가 있어 ambiguous였으며 전체 경로로 선택한 GUI만 실제 실행 중임을 확인했다. 이 관찰을 앱 자체의 입력 결함이나 CUA 원인 확정으로 분류하지 않았다. 사람이 새 배포 앱을 활성화하고 직접 입력하는 확인을 요청했다.

OS의 AioLM Allow off를 확인하고 일시 on으로 변경했다가 알림 제출 전에 원래 off로 복원했다. 다른 알림 필드·공유 중 알림 설정·앱 완료 알림 category는 바꾸지 않았다. System Settings도 General로 돌아가 정상 종료했다. 아직 배포용 test notification 제출/수신은 확인하지 못했다. 개발 GUI가 종료된 동안 작업용 close_to_tray만 원래 false로 원상 복원했고 config 원본 bytes/hash·파일 mode가 정확히 일치한다. 이는 종료된 홈의 파일 복원이며 이번 native 설정 off 클릭 검사로 계산하지 않는다.

raw는 `goal-window-orbit152-{tray-quit-human-confirmed,owned-vite-cleanup,offline-config-restored}.json`, `goal-notification-production-orbit152-{copy-verified,before,launch,running-preservation,first-input-block}.json`과 대응 로그다. production 검사 중 debug config/51개 대화·production config/두 대화 파일의 exact hash를 확인했다. 기존 모델·외부 runtime·사용자 자료는 이동/삭제하지 않았다. 새 소스 수정·DMG 생성·전체 기기 검증 통과로 확대하지 않는다. 개발 앱의 실제 재실행/Ready 복원과 배포 앱의 실제 입력·알림 수신은 이 절 시점에 남아 있다.

새 입력 관찰과 관련된 기존 App navigation/App/Settings layout/preferences의 집중 검사는5 files/48 tests·exit0·6.43s로 통과했다. `logs/goal-navigation-settings-orbit152-focused-20261013.log`가 근거다. 같은 제품 소스의 React/jsdom 검사이며 현재 native 입력이나 OS 알림 수신을 통과했다고 해석하지 않는다. 새 회귀를 추가하거나 기존 전체 자동 검사를 이번 실행으로 주장하지 않았다.

## 91. 배포 앱 알림 수신·정상 종료와 개발 앱 복원

2026-10-13 `ce71695` checkout에서90절의 입력 검사를 이어갔다. 배포 앱은 검증된 `6e27196` 소스의 copy이며 복원한 개발 앱은 frontend `6e27196`·native core `6a374ce`다. 사람의 “설정 → 알림을 열었음” 회신 뒤 실제 실행 중인 배포 앱의 Settings→Notifications 선택 상태를 확인했다. 이후 “Dock 아이콘/한국어 창이 보이지 않음” 회신도 별도로 보존한다. 새 CUA의 General→Notifications 전환·focus가 실제 화면에 반영됐지만 앞선 입력 제한의 원인을 제품 결함이나 CUA 원인으로 확정하지 않았다. 이를 코드 수정 결과로 기록하지 않는다.

| 실제 흐름 | 판정·근거 |
| --- | --- |
| 배포 앱 알림 제출 | pass — 개발 서버가 없는 검증된6e27196 custom-protocol GUI에서 한국어 테스트 알림을 한 번 클릭했다. 실제 화면의 피드백은 시스템에 전송을 요청했다는 문구이며 전달 성공을 단정하지 않았다. 채팅·다운로드·벤치마크 완료 알림 category는 모두 off를 유지했다. |
| 새 알림 제목·본문 수신 | pass — 사람이 방금 보낸 새 항목의 제목 “AioLM 테스트 알림”과 본문 “AioLM에서 보낸 테스트 알림입니다.”를 둘 다 확인했다고 회신했다. 이는 사람의 실제 수신 관찰이며 자동 NotificationCenter 캡처 성공으로 확대하지 않는다. |
| OS 알림 설정 복원 | pass — 실제 System Settings의 AioLM Allow off→일시 on→test 제출 뒤 원래 off를 복원했다. 나머지 알림 필드·미리 보기·그룹·공유 중 알림 설정을 바꾸지 않았다. System Settings는 정상 종료했다. |
| 배포 앱 종료·홈 보존 | pass — 원래 Chat으로 돌아가 normal Quit, launcher exit0·GUI 종료·소유 짧은 임시 경로 제거를 확인했다. 배포 홈의 config/두 대화와 개발 홈의 config/51개 대화는 이 종료 시점에 exact bytes/hash를 보존했다. 원래 대화·외부 환경·모델을 이동/삭제하지 않았다. |
| 개발 앱 실제 복원 | pass — 같은 격리 홈으로 Vite/native debug 앱을 재실행하고 실제 Model settings의 원래 vLLM Default를 저장/시작했다. backend running·모델 로드됨·원래 선택 대화/모델명·입력 활성화를 확인했다. Server 화면의 Close to system tray는 off이며 읽기 전용 native tray 조회도 해당 tray 부재를 확인했다. 이는90절의 offline 파일 복원과 구분되는 실제 재실행 근거다. |

raw는 `goal-notification-production-orbit153-{fresh-receipt,restored-results}.json`, `goal-notification-production-orbit152-{exit,cleanup}.json`, `goal-tray-orbit153-readonly.json`, `goal-native-audio-orbit153-{debug-boot,debug-starting,restored-off}-20261013.json/png`와 대응 로그다. debug-starting이라는 파일 이름과 달리 해당 관찰의 실제 backend는 이미 running이었다. 표시된 PP52/cache0·TG15와 응답은 원래 저장 이력이며 새 추론 실행으로 계산하지 않는다. 원래 고정 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`와 vllm-metal 환경을 재사용했다.

88·90절의 당시 알림 수신 차단·입력 미확인은 보존하며 새 수신 근거로 연결한다. 이번에는 제품 소스·의존성·공통 자동 검사·DMG를 바꾸거나 재실행한 것으로 주장하지 않는다. promised/unreadable clipboard와 별도 계정의 최초 실행·Keychain·실제 upgrade·자연스러운 Finder 설치 실행은 아직 남아 있으며 M11/전체 기기 검증 통과를 선언하지 않는다. Intel·구형 macOS 결과도 추정하지 않았고 원격 push·공개 upload는 수행하지 않았다.

## 92. 실제 클립보드 예외 처리·원본 복원과 최종 보존

2026-10-13 `8a4bc2d` checkout/동일 frontend `6e27196`·native core `6a374ce`에서 작업용 SwiftPM/AppKit 검사 bundle을 만들고 네이티브 CUA로 조작했다. 원본 clipboard는 메모리에만 보관하며 promise·nil data·재구성 불가·변경된 changeCount에서 변경 전에 거부한다. 새 item으로 복원한 뒤 board type·item·representation type 순서와 bytes를 모두 비교한다. 검사 도구와 빌드 자료는 `tmp/`에만 두었고 AioLM Run 설정·제품 코드를 바꾸지 않았다.

첫 도구의 native 준비 시도는 성공한 snapshot 기록이나 clipboard 변경 없이 거부됐고 restore_required=false로 정상 종료했다. 이 시도의 상세 범주는 기록되지 않았다. 이후 별도 named pasteboard의 합성 데이터 시험에서 macOS의 호환용 문자열 alias 때문에 단순 board/item type 합집합 비교가 정상 텍스트도 거부함을 재현했다. 원래 형식 metadata와 합성 빈 bytes로만 별도 board를 재구성해 top-level type의 일치를 확인하도록 도구를 보완했다. 원본 bytes는 별도 pasteboard나 파일에 복사하지 않았다. 이 도구 보완을 제품 결함 수정이나 첫 시도의 확정 원인으로 확대하지 않는다.

| 실제 흐름 | 판정·근거 |
| --- | --- |
| data provider 텍스트 | pass — 실제 NSPasteboardItemDataProvider의 제공 callback1회·fulfilled=true와 실제 Cmd+V의 정확한 합성 입력을 확인했다. callback은 준비 시점에 이미 관찰됐으므로 붙여넣기 키가 늦은 callback을 발생시켰다고 주장하지 않는다. 입력을 전송하지 않고 삭제했다. |
| 읽기 실패 텍스트 | pass — 실제 callback이 data를 설정하지 않고 반환한 fulfilled=false를 확인했다. Cmd+V 뒤 입력은 빈 값·Send 비활성이고 새 메시지·생성·UI 오류가 없었다. 합성 DOM paste 이벤트로 대체하지 않았다. |
| 실제 파일 promise | 안전 처리 pass / import unsupported — NSFilePromiseProvider와 실제 delegate를 유지한 채 writeObjects 성공·native Cmd+V를 확인했다. 텍스트 composer에는 promise 수신/materialization 계약이 없으며 입력·첨부·전송·파일 쓰기 callback을 만들지 않았다. 파일 import 성공이나 promise payload 복원으로 계산하지 않는다. |
| Chat Copy·변경 감지 | pass — 실제 Copy→Copied 뒤 도구의 이전 snapshot 복원은 변경 감지로 clear/write 전에 거부됐다. 이어 실제 Cmd+V가 저장된 합성 답변을 정확히 붙여넣어 Copy 내용 보존을 확인했다. 첫 엄격한 adoption은 실패했으며 해당 clipboard representation 일치를 주장하지 않는다. |
| 알려진 텍스트 확인·원본 복원 | pass — 붙여넣은 텍스트를 수정하지 않고 실제 textarea의 select-all/Cmd+C로 복사했다. 도구의 정확한 한 item/한 UTF-8 representation 일치 뒤 원래 한 item/한 representation과 top-level type·순서·bytes의 stable match를 확인했다. 도구는 restore_required=false로 normal Quit·process 종료했다. 이는 검사 도구의 보호 절차이며 앱 Copy의 이전 clipboard 보존 기능이나 임의 모든 포맷 복원으로 확대하지 않는다. |

raw는 `goal-clipboard-orbit154-native-results.json`, `goal-clipboard-orbit154/events-orbit154-native{,2}.jsonl`, `goal-clipboard-orbit154/private-type-enumeration-diagnostic3.log`, `goal-native-audio-orbit154-{lazy-pasted,unreadable-pasted,promise-pasted,final}-20261013.json/png`와 대응 로그다. bundle 빌드·plist·strict ad-hoc 서명 확인은 `goal-clipboard-orbit154/build-orbit154-diagnostic2.log`와 native2 launch 로그에 기록했다. 원본 clipboard 내용·개인 경로를 문서나 배포 파일에 넣지 않았다. 소유 상태 확인은 OS changeCount를 사용하며 원자적 동시 쓰기 보장으로 주장하지 않는다.

최종 실제 개발 앱은 원래 vLLM Default/고정 Qwen snapshot의 running·모델 로드됨·원래 선택 대화/저장 모델명·PP/TG·입력 활성화 상태다. 51개 대화/hash·localStorage·프로필 내용과 프로필 외 config가 정확히 보존됐다. Default30→31·matching applied revision과 profile library141→143만 저장 revision 변경이므로 config 전체 bytes 불변으로 주장하지 않는다. 재실행한 runtime session의 PID·endpoint·credential·log/idle time도 이전 session과 같다고 주장하지 않는다. API off·active requests0·생성 중 아님·입력 빈 값·UI 오류/overlay 없음·Close to tray off이며 이전 GUI/engine·Vite group·production process는 종료됐다. 별도 production config/두 대화 hash도 그대로다. `goal-final-orbit154-preservation.json`·`goal-native-audio-orbit154-final-20261013.json/png`가 근거다. 이후 현재 GUI/engine 생존과 driver/engine/Vite listener도 `goal-final-orbit154-live-listeners.json`에서 다시 확인했다. Vite는 IPv6 listener이며 IPv4 부재를 실패로 계산하지 않는다. 저장 PP/TG는 새 추론 샘플이 아니다.

현재 M01–M12는7 pass /4 fail /1 unrun이다. M03/M04/M07의 실제 upstream URI500·미디어 내용/모델 snapshot 실패, M08의 실제 전달된 도구 결과 대신 입력 인자를 반복하는 내용 실패는 해결되지 않았다. 실제 ffmpeg 부재 환경도 현재 시스템 설치·PATH 복구 때문에 만들 수 없어 M07의 하위 blocked로 남긴다. M11의 현재 기기 데스크톱 하위 검사를 보완했지만 별도 계정 최초 실행·자연스러운 Finder 설치/launchd의 MCP·CMake 탐색·Keychain 허용/거부/취소/업데이트 재승인·실제 upgrade·다운로드 quarantine·Intel/구형 macOS는 unrun이다. 개인 엔진 registry/manifest는 [별도 미구현 설계](pluggable-inference-runtimes.ko.md)로 유지한다. 전체 기기 검증 통과·새 제품 회귀 수정·새 공통 자동 검사/DMG를 선언하지 않았고 공개 upload·원격 push는 수행하지 않았다.

## 93. 재시도 초안·모델명·런타임 취소·좁은 창의 후속 수정

2026-10-13 `d95721a` checkout에서 92절 이후 실제 WKWebView 검증을 재개했다. native debug core는 `6a374ce`, 이번 frontend 수정은 `297f5dc`(Retry), `aa7b140`(Benchmark 이름), `7fc95e4`(런타임 취소/알림), `7dc1917`(제목/최소 창)에 커밋했다. 기기·작업용 도구·격리 홈은 앞선 검증 조건을 유지했다. 새 실제 채팅에는 원래 vLLM Default와 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`, vllm-metal 0.30.0/vLLM 0.30.0+cpu를 사용했다.

제품 변경은 다음 네 작업 단위로 정리한다.

| 변경 | 재현된 문제와 수정된 동작 |
| --- | --- |
| 실패한 이전 요청 Retry 시 새 초안 보존 | 실제 HTTP400 요청의 Retry를 누르면 그 뒤 입력한 미전송 초안이 지워졌다. Retry는 원래 실패 메시지·첨부를 다시 전송하면서 현재 composer의 새 텍스트·첨부·문서를 유지한다. 새 메시지의 정상 Send와 도구 후속 요청의 기존 정리는 유지한다. |
| Benchmark snapshot 모델명 | 외부 `snapshots/<40자리 revision>` 모델은 대상·이력 선택·결과·삭제 안내에 revision만 표시될 수 있었다. 기존 모델 metadata 이름 확인을 이 화면들에도 공유하고 동시 읽기를 재사용한다. metadata 대기·실패 중에도 기존 이름 fallback으로 표시하며 실행·export·삭제의 모델 경로/record identity는 바꾸지 않는다. |
| Python 런타임 bundle 알림·취소 | export/import 완료가 Download complete로 분류되고, local Cancel은 cleanup 동안 반복 요청될 수 있었다. bundle 작업은 취소 가능한 로컬 작업으로 유지하며 다운로드 완료 알림을 보내지 않는다. 실제 환경 설치의 완료 알림은 유지한다. local/global Cancel은 같은 실행 identity를 사용해 Cancelling 동안 반복 요청을 막고 실제 작업 종료까지 busy를 유지한다. 취소 요청 IPC 오류는 현재 작업을 실패 완료로 바꾸지 않고 읽을 수 있는 detail/error와 재시도를 제공한다. 이전 실행의 늦은 오류·보관된 취소 callback은 다음 실행에 적용하지 않는다. 실제 backend/picker의 명시적 cancellation 문자열만 cancelled로 분류하며 cancellation을 언급하는 다른 실패는 오류로 남긴다. |
| 긴 채팅 제목·최소 창의 설정 제어 | 합성 45,088 UTF-16 code-unit 제목은 전체 문자열을 매번 heading/sidebar에 그려 shaping 폭이 약 267,000px/242,000px가 됐다. 표시 preview만 grapheme 경계에서 1,024 code units 이내+말줄임으로 제한하고 저장·편집·검색·tooltip/접근 가능한 전체 제목은 보존한다. Segmenter가 없는 구형 WebView는 기존 표시를 유지한다. workspace 폭399px 이하에서는 Conversation settings를 이름이 있는32×32 아이콘으로 표시해 제목 영역을 확보하며 기존 설정 editor·Escape focus 복원을 유지한다. |

이 네 frontend 수정은 공개 API·프로필/모델 identity·기본값·readiness·hash 검증·엔진 요청 의미·시간 제한·lockfile을 변경하지 않았다. 개인 엔진 registry/manifest 구현이나 기존 upstream/내용 실패를 이번 수정으로 해결했다고 주장하지 않는다.

| 수정 전/후 자동 검증 | 판정·근거 |
| --- | --- |
| Retry 최소 회귀 | 수정 전 fail — 1 file/2 failures·2 pass·0.90s. 성공/실패 Retry 모두 새 초안을 지웠다. 수정 후 pass — 관련6 files/55 tests·2.64s. |
| Benchmark snapshot 이름 | 수정 전 fail — 2 failures/10 pass·4.46s. 후속 범위 추가 중 mock에 `isNativeRuntimeAvailable`가 빠진1 failure/48 pass·4.44s도 원본 로그에 보존했다. 이는 검사 준비 오류이며 mock을 보완한 뒤 최종 관련3 files/49 tests·6.22s가 pass다. |
| Python 환경 작업 | 수정 전 fail — 확장 검사9 failures/6 pass·1.30s. local 수정 후 global callback 우회가 별도 통합 검사에서3 failures/15 pass·2.31s로 재현됐다. 같은 실행을 캡처한 callback을 적용한 뒤 관련4 files/42 tests·2.90s가 pass다. 실제 backend 작업 완료 전 busy·실패 진단·재시도와 늦은 이전 실행 오류 격리를 확인했다. |
| 긴 제목 preview | 수정 전 fail — 1 failure/43 skipped·1.29s. skipped 항목은 실행한 검사로 계산하지 않는다. 최종 관련3 files/61 tests·6.52s가 pass이며 full text 편집·tail 검색·reload·Unicode 경계/fallback을 확인했다. |
| 최소 창 설정 제어 | 수정 전 fail — 2 failures·0.93s. 수정 후 관련3 files/56 tests·4.53s가 pass이며 이름·기존 editor·Escape focus를 확인했다. |
| 최종 `npm run typecheck` / `npm run lint` | pass — 12.04s / 7.26s. |
| 최종 `npm run test:unit` | pass — 138.73s. contracts offline install/Node/browser import·schema/TypeScript, provider options, scripts, direct 검사 및 UI182 files/1857 tests. coverage statements80.97%/branches75.97%/functions79.61%/lines85.02%. jsdom의 pseudo-element/canvas 미구현 경고는 native 동작 통과 근거로 사용하지 않는다. |

집중 검사의 raw log는 `logs/goal-retry-draft-orbit155-{before-isolated,related-after}-20261013.log`, `logs/goal-benchmark-model-orbit155-{before,related,final}-20261013.log`, `logs/goal-provider-environment-orbit155-{before-expanded,global-before,global-after,global-lint}-20261013.log`, `logs/goal-chat-title-orbit155-{before,final}-20261013.log`, `logs/goal-chat-compact-orbit155-{before,after}-20261013.log`다. 공통 검사는 `logs/goal-orbit155-final-{typecheck,lint,unit}-20261013.log`와 `checks.jsonl`에 기록했다. 이 네 frontend 수정에서 Rust/Python 소스는 바꾸지 않았으며 해당 전체 검사를 이 표의 frontend 검사로 대체하지 않는다.

| 실제 WKWebView 검증 | 판정·근거 |
| --- | --- |
| Retry 수정 전 재현 | fail — 합성 긴 입력이 실제 vLLM context4096을 넘어 HTTP400/input_tokens4097로 거부됐다. 새 미전송 초안이 있는 상태에서 실제 Retry를 누르면 composer가 빈 값이 됐다. 이400은 의도한 과대 입력의 정확한 거부이며 정상 답변 기능 실패로 재분류하지 않는다. |
| Retry 수정 후 | pass — 같은 engine·동일 실제400을 유지한 채 새 초안이 문자 그대로 남았다. 새 user bubble을 추가하지 않았고 원래 실패·Retry 안내를 숨기지 않았다. 기존51개 대화/hash도 보존했다. 수정 전53자 초안과 수정 후45자 초안은 서로 다른 합성 입력이므로 두 문자열이 같다고 주장하지 않는다. |
| 긴 제목 표시·최소 창 | pass(현재 기기) — 원래45,088-unit 제목이 저장/tooltip/heading 접근 이름에 남고 표시 heading/sidebar는1,025-unit preview다. 실제360×488 viewport에서 제목 영역173.5px·settings32×32·Conversation settings 이름·label 숨김·Escape 종료 후 summary focus·composer 화면 내 배치를 확인했다. CSS/DOM 합성 회귀만으로 native 통과를 선언하지 않았다. |
| 새 정상 요청과 모델명·PP/TG | pass — 실제 새 입력 “ORBIT155. What is 6 plus 9? Answer with one number.”의 답변15·Response complete·두 메시지와 Qwen3-VL-2B-Instruct-4bit를 확인했다. PP38/cache0, TG3/0.08s/25.6tok/s, TTFT9.54s·준비0.02s·요청9.55s다. PP 시간/속도는 engine 미제공으로 `—`와 설명을 유지하며 추정하지 않았다. 저장된 이전 응답을 새 추론 샘플로 대체하지 않는다. |
| Benchmark 기존 이력 이름 | pass(기존 이력 화면 범위) — 실제 Result history 목록에 기존 Qwen2.5 Instruct 이름·상태가 표시되고 revision만으로 표시하지 않았다. 이 read-only 목록 근거를 새 Gemma Benchmark 실행 성공으로 확대하지 않는다. |

native raw는 `goal-retry-draft-orbit155-native-results.json`, `goal-native-audio-orbit155-{before-draft,before-lost,after-draft,after-kept,normal-response,title-after,title-minimum}-20261013.json/png`, `goal-chat-title-orbit155-{readonly,native-geometry}.json`, `goal-chat-compact-orbit155-geometry.json`, `goal-benchmark-orbit155-options-readonly.json`이다. 실제 입력/화면은 root의 CUA 조작·AX/screenshot이고 observer/geometry는 상태·파일·read-only WKWebView 보조 근거다. `before-ready`라는 파일 이름의 관찰은 실제 stopped였으므로 Ready 성공 근거로 사용하지 않는다.

## 94. 실제 Python bundle 취소와 frontend 수정 패키지

2026-10-13 같은 격리 홈의 실제 앱에서 default 모델을 Unload하고 named session/API가 동작하지 않는 상태로 MLX 환경을 검사했다. `mlx-vlm`0.7.6의 기존 외부 환경을 재사용했다. 소유 임시 출력만 선택하며 기존 bundle과 외부 환경을 삭제하지 않았다.

| 실제 흐름 | 판정·근거 |
| --- | --- |
| export 저장 picker Cancel | pass — 실제 macOS Save의 Cancel 후 TaskStrip은 `Cancelled · portable runtime export cancelled`, 작업 수0이다. 오류 배너·결과 파일 없이 export/import 제어가 다시 활성화됐다. |
| import picker Cancel | pass — 실제 macOS Open의 Cancel 후 `Cancelled · portable runtime import cancelled`, 작업 수0·오류 배너 없음·환경 Ready/제어 활성화를 확인했다. |
| export 처리 중 local Cancel | pass — 새 작업용 출력으로 Save, 실제 package 다운로드 progress와 작업 수1·환경 제어 잠금을 확인했다. native local Cancel 뒤 `Cancelled · portable runtime operation cancelled`, 작업 수0·오류 배너 없음·제어 활성화·환경 Ready다. 빠른 cleanup 때문에 중간 Cancelling 화면은 별도 native 캡처하지 못했으며 그 상태/반복 클릭 보호는 자동 회귀로만 확인했다. |
| 출력·staging·process 정리 | pass(관찰 범위) — 새 출력은 없고 OS 임시 경로의 `aiolm-portable-*` staging과 작업용 pip process가 남지 않았다. 작업 중 pip PID/group을 따로 포착하지 못했으므로 특정 PID의 종료로 확대하지 않는다. 전체 외부 환경의 before/after bytes를 비교한 근거로도 확대하지 않는다. |

raw는 `goal-native-audio-orbit155-{export-picker-cancel,import-picker-cancel,portable-working,portable-cancelled}-20261013.json/png`와 `goal-provider-orbit155-native-cancel-cleanup.json`이다. 성공한 portable 완료 알림의 무전송은42개 회귀 검사 범위이며 OS 배너 수신 검사를 다시 실행하지 않았다. 기존 실제 bundle 성공/보호 검사는 앞선 결과를 유지한다.

`7dc1917` 소스에서 `npm run build`14.31s·`npm run package:tauri`238.21s·새 arm64 DMG 검사6.56s가 모두 exit0다. DMG의 GUI/CLI가 모두 arm64·0.3.1이며 빌드 앱과 hash가 일치하고, 5개 파일·strict ad-hoc 서명·UTF-8/UTF-16 개인 경로/fixture 제외·새 임시 CLI 홈의 초기값·read-only image detach를 확인했다. ad-hoc 서명이며 notarization 자격 증명은 없어 공증을 수행하지 않았다. 로그는 `logs/goal-orbit155-{production-build,arm64-package}-20261013.log`, `logs/goal-orbit155-package-inspect-7dc1917-20261013.log`, manifest는 `goal-native-runtime-lock-package-orbit155-7dc1917-results.json`이다. 원본 image는 `goal-package-orbit155-7dc1917/`에 보존했다. 이 image는 아래에서 새로 발견한 native tokenizer 수정 전 소스이며 최종 수정 패키지로 대체하지 않는다.

실제 Gemma4 Benchmark는 `gemma-4-e2b-it-4bit` revision `238767527555cb75a05732a84dff5d6ba0dd6809`·mlx-vlm0.7.6, Code/Python·입력1,024·출력16·반복1·single 요청으로 실행했다. 대상·failed 결과·삭제 확인창에는 revision 대신 모델명이 표시됐고 삭제는 Cancel로 끝냈다. 그러나 prompt 준비 단계에서 `Gemma4Processor` import가 실패해 benchmark는 fail이다. 결과를 숨기거나 tokens 검사/readiness를 제거하지 않았다. 원본은 `goal-native-audio-orbit155-benchmark-{failed,delete-label}-20261013.json/png`다. 원인 조사와 수정 후 실제 재검증은 다음 절에 기록한다.

이후 실제 normal Quit으로 debug GUI·소유 launcher가 exit0으로 끝났고 이전 engine 및 Vite process가 종료됐다. `logs/goal-window-orbit155-native-launch-20261013.log`가 근거다. 첫 관찰에서 이전 turn의 소유 process가 모두 종료된 상태였고, stale CUA 앱 선택은 isolation/Vite 없는 별도 blank 실행을 만들었다. root가 생존 확인 전에 선택한 순서 오류를 인정하고 해당 실행만 정상 종료했다. 원인을 제품 render 결함으로 단정하거나 일반 홈의 파일을 삭제/덮어쓰지 않았다. 이후 새 detached 소유 launcher로 같은 임시 홈을 재실행해 이번 검증을 진행했다.

## 95. MLX Benchmark processor 초기화 결함 수정과 실제 완료

94절의 실제 Gemma4 실패는 Benchmark helper가 선택 모델의 loader 모듈을 등록하기 전에 processor를 읽은 제품 결함이었다. 설치된 mlx-vlm0.7.6의 Gemma4 모듈은 자신의 processor를 등록하며 실제 서버는 모델 loader를 먼저 호출한다. 앱 helper만 이 순서를 생략해 transformers의 다른 processor를 읽고 설치하지 않은 `torch` import로 실패했다. `9fde6da`는 설치된 loader의 `get_model_and_args(config, model_path)`로 모듈을 먼저 해결한 뒤 기존 processor를 읽는다. 이 초기화는 모델/가중치를 생성하거나 읽지 않는다. 별도 PyTorch 설치·모델별 강제 분기·request/template/special-token 규칙·실행 deadline·정확한 token 검사를 바꾸지 않았다. deep verification helper는 이미 loader의 `load()`를 사용해 같은 등록 누락이 확인되지 않았으며 수정하지 않았다.

새 회귀는 실제 embedded helper를 합성 loader/processor/tokenizer로 실행한다. 등록이 필요한 Gemma/다른 모델·trust 옵션·동일 Path·정확한 prompt 길이·stop token dedup·가중치 미로드·loader 오류 보존을 확인한다. 수정 전 exit1·수정 후 Python 기존14+contract5 tests가 exit0(0.41s/0.08s), 관련 Rust4 tests가 exit0(11.33s)다. `cargo test --locked --all-targets --all-features`38.26s·clippy 같은 범위 `-D warnings`4.91s·fmt1.61s·macos-ui-smoke debug build12.21s도 pass다. Rust library948 pass/기존4 ignored·CLI15 pass·headless1 pass/1 ignored·provider acceptance5 pass/1 ignored·fake smoke1 pass이며 실제 엔진/환경용 기존 ignored gate를 실행한 검사로 계산하지 않는다.

실제 설치 환경의 현재 helper와 실제 서버 전처리를 별도 offline process에서 비교했다. mlx-vlm0.7.6·mlx0.32.3·transformers5.19.0·tokenizers0.23.2, 설치된 MLX Gemma4Processor의 helper/서버 detokenizer 설정과 `_cpu_preprocess`에서 원래 production corpus8,349 bytes/2,476 tokens가 warm128·input1,024로 정확히 준비되고 각 token ID가 일치했다. 원래 corpus의 완성 SHA-256은 `37c6f418c17d16961e1a951936487ea34f071f144e55a7647de39ff153423a55`다. 최초 등록-only 조사에서 임의 `seed*32`를 사용한 exact1,024 실패와 후속 observer의 str/Path TypeError도 원본에 남겼다. 실제 corpus/서버 Path 계약으로 보완한 최종 observer는 exit0/7.93s이며 이 두 조사 오류를 제품 결함으로 확대하지 않았다.

| 수정 소스의 실제 WKWebView 흐름 | 판정·근거 |
| --- | --- |
| 같은 Gemma4 Benchmark | pass — `9fde6da`로 다시 빌드·서명한 debug core/같은 고정 모델과 외부 MLX 환경에서 동일 Code/Python·input1,024/output16·반복1·single/warmup 조건으로 실제 Run benchmark를 클릭했다. 새 결과 `complete`, row error 없음·engine usage PP1,024/cache0·TG16이다. 이전 failed 기록을 삭제/성공으로 바꾸지 않았다. |
| 실제 측정값 | pass — client TTFT802.138ms·TPOT27.008ms·전체1.207652s, PP 추정1,276.432tok/s·TG37.026tok/s·전체13.249tok/s다. sampled process RSS107.78MiB이며 GPU VRAM/전체 unified allocation이라고 주장하지 않는다. context1,280·parallel1·Metal/0.7.6이다. 작은 single 샘플의 성능을 다른 길이·동시 요청·기기의 성능으로 일반화하지 않는다. |
| 이력·모델명 | pass — 이전 실패 이력을 실제 재실행/reload 뒤 선택해 Result history·결과에 `gemma-4-e2b-it-4bit` 이름과 Failed가 유지됨을 확인했다. 새 완료의 대상/결과도 같은 이름이다. 기록의 원래 snapshot 경로·run identity·provenance를 유지한다. |
| CSV/XLSX 실제 저장 | 값/저장 pass — 실제 native Save로 두 새 작업용 파일을 저장하고 File saved 피드백을 확인했다. CSV638 bytes·XLSX7,373 bytes/Results sheet·ZIP 무결성과 input1,024/output16·측정값·Completed가 일치한다. 이 시점 export의 Model/제안 filename은 아직 revision fallback이며 human model label의 표시 일관성 개선은 다음 절에서 구분한다. |
| private runtime 종료 | pass(관찰 범위) — 성공/실패 실행의 실제 port 두 개가 닫혔고 완료 후 앱 child process가 남지 않았다. 이전 Qwen engine도 종료됐음을 확인했다. 짧은 benchmark engine PID/group은 별도 관찰하지 못했으므로 특정 PID lifetime 증거로 확대하지 않는다. |
| 원래 default 복원 | pass(중간 복원) — 실제 모델 editor에서 Qwen의 기존 MLX97 선택을 저장하고 원래 vLLM Default/외부 vllm-metal을 저장·시작했다. `running`·원래 고정 snapshot·같은 provider/runtime/options, API off·입력 빈 값·원래 선택 대화/저장 모델명/PP·TG가 돌아왔다. 저장 응답 표시를 새 추론으로 계산하지 않는다. |

native raw는 `goal-native-audio-orbit155-loader-{history-name,benchmark-started,benchmark-completed,default-restoring,default-starting,default-ready}-20261013.json/png`, `goal-mlx-benchmark-orbit155-native-{records,cleanup,export}.json`이다. default-restoring 관찰은 실제 stopped, default-starting은 starting, default-ready만 running이므로 각각의 실제 상태로 구분한다. 새 GUI/driver는 이전 실행과 다른 process이며 source-matched binary hash·strict debug 서명은 `goal-mlx-benchmark-orbit155-debug-prepared.json`에 보관했다. 이 fresh 앱의 Benchmark/복원 동안 passive error/unhandledrejection observer를 설치했고 errors0·overlay 없음이다. 앞선 observer 미설치 구간의 빈 errors 배열을 전체 console 검증으로 확대하지 않는다.

`9fde6da`의 표준 `npm run package:tauri`234.12s·패키지 검사8.28s가 exit0다. 새 GUI/CLI arm64·0.3.1·빌드와 hash 일치·strict ad-hoc·5개 파일·개인 경로/fixture 제외·새 CLI 초기값·read-only detach를 다시 확인했다. `goal-native-runtime-lock-package-orbit155-9fde6da-results.json`·`goal-package-orbit155-9fde6da/`와 대응 로그가 원본이다. 공증·자연스러운 Finder 설치/실행·별도 계정/Keychain·실제 upgrade 결과로 확대하지 않는다. export 표시 개선이 추가되면 그 이후 소스/검사/패키지를 별도로 기록한다.

## 96. CSV/XLSX 모델명 일관성과 최종 공통 검사

95절의 실제 export는 저장과 수치가 정상이었으나 Model 열과 제안 파일명에는 snapshot revision이 남았다. `24a3dbd`는 기존 metadata의 대상 제한·동시 조회 재사용·fallback을 공통 resolver로 추출하고 로컬 CSV/XLSX의 표시 projection에만 적용한다. 저장된 benchmark record·model path·provenance·공개 공유 요청은 원래 값을 유지하며 metadata 오류는 기존 fallback 이름으로 export할 수 있다. Markdown Copy의 계약도 유지한다.

| 수정 전/후 검증 | 판정·근거 |
| --- | --- |
| 모델명 export 회귀 | 수정 전 fail — 7 failures/10 pass·1.78s. 수정 후 관련6 files/81 tests·3.40s, 보완한 export18 tests·1.29s pass. native CSV/XLSX 이름·동시 조회·실패 fallback·원본 record 불변을 확인했다. |
| browser CSV timing | 최초 전체 검사 fail — 137.36s·기존2 failures/1863 pass. metadata를 기다리는 unconditional await가 browser의 CSV download 시작을 늦췄다. 기존 화면 검사를 완화하지 않고 native 여부를 한 번 확인해 browser CSV는 첫 await 전에 기존 download를 시작하게 수정했다. 강화한2개 anchor 회귀도 수정 전 fail/1.00s였으며 수정 후 관련7 files/109 tests·4.57s가 pass다. browser XLSX의 기존 비동기 workbook 생성은 유지한다. |
| 최종 `npm run typecheck` / `npm run lint` | pass — 11.74s / 6.59s. |
| 최종 `npm run test:unit` | pass — 135.18s. 기존 contracts/direct/scripts와 UI182 files/1865 tests, coverage statements80.98%/branches75.98%/functions79.62%/lines85.03%. 이전 실패 로그를 삭제하거나 skip으로 전환하지 않았다. |
| 실제 native CSV/XLSX | pass — 같은 고정 Gemma4 완료 이력을 선택해 macOS Save로 새 작업용 파일을 저장했다. 제안 filename과 Model은 `gemma-4-e2b-it-4bit`, CSV616 bytes/XLSX7,353 bytes이며 XLSX ZIP/Results sheet와 input1,024/output16을 확인했다. CSV 수치는 canonical 저장 row와 정확히 일치하고 기존 두 이력 record의 JSON은 변경되지 않았다. 최종 browser 경로 수정 후에도 실제 native XLSX의 이름을 다시 확인하고 Save를 Cancel해 오류 없이 끝냈다. |

이전 live 결과 export와 이후 이력 export를 raw 문자열로 비교한 첫 진단은 fail이다. Model 외에 Measured at가14:24:31→14:24:34, TG가37.026001642947364→37.02600164294736으로 달랐다. live 시작 시각과 canonical 이력 완료 시각·직렬화 마지막 자리의 차이를 별도 원본에 보존하고, 새 export는 실제 canonical 저장 row에 대해 정확히 비교했다. export 변경이 수치를 재계산하거나 원래 저장 이력을 수정한 근거로 해석하지 않는다.

회귀/공통 로그는 `logs/goal-benchmark-export-name-orbit155-{before,related-after,final-export-regression}-20261013.log`, `logs/goal-benchmark-export-browser-orbit155-{before,related-after}-20261013.log`, `logs/goal-benchmark-export-orbit155-{final-unit,final2-typecheck,final2-lint,final2-unit}-20261013.log`와 `checks.jsonl`이다. native raw는 `goal-benchmark-export-name-orbit155-{native-results,history-preserved,live-history-differences}.json`, `goal-native-audio-orbit155-export-final-cancel-20261013.json/png`, 새 `goal-orbit155-gemma-benchmark-named.csv/xlsx`다. Rust/Python은95절 이후 변경하지 않았으며 해당 전체 검사의 소스/결과는95절을 유지한다. 플랫폼 공통 browser 계약은 자동 검증했고 Windows/Linux 실기기를 새로 실행했다고 주장하지 않는다.

## 97. 최종 패키지·production 화면·설정 복구와 실행 보존

최종 제품 소스는 `24a3dbd68b098f9286de2757d1572aee677843c0`이다. 표준 `npm run package:tauri`214.23s·새 image 검사7.21s가 exit0다. GUI/CLI arm64·0.3.1·빌드와 같은 bytes·5개 파일·strict ad-hoc 서명, UTF-8/UTF-16 개인 경로/fixture 제외, 새 CLI 홈 초기값과 read-only image detach를 확인했다. 공증은 수행하지 않았다.

| 최종 패키지 | SHA-256·근거 |
| --- | --- |
| `AioLM_0.3.1_aarch64.dmg` | 16,815,894 bytes · `1ae37de45d407c4f460f2cd2f951a8b2840c9ed3adc32d1b1b7e9ce23b3de8e9` |
| GUI `aiolm` | `826d23bbb7da63cd87127286bbfe69a325485e1d9dc1218471aa74fc8b28661d` |
| CLI `aiolm-cli` | `6fba7114783f4464d12c051fc5d40792942afcdb7cff950831cd781a36ffb7ae` |

manifest는 `goal-native-runtime-lock-package-orbit155-24a3dbd-results.json`, 원본은 `goal-package-orbit155-24a3dbd/AioLM_0.3.1_aarch64.dmg`, 로그는 `logs/goal-benchmark-export-orbit155-{final-arm64-package,package-inspect-24a3dbd}-20261013.log`다. 94–95절의 중간 소스 image도 유지하며 최종 소스의 검사로 대체하지 않는다.

같은 bytes의 production 앱을 기존 격리 production 홈에서 Vite 없이 직접 실행했다. 준비2.97s·실행/정상 종료133.95s, exit0다. 실제 CUA에서 `tauri://localhost`의 한국어 Chat→Settings/General→Benchmark→원래 Chat을 클릭했다. 0.3.1/ko/comfortable, Qwen3-VL-2B-Instruct-4bit와 기존 runtime/profile 조건이 표시됐다. 모델 미실행의 비활성 composer와 저장 응답 PP54/TG15는 확인했으나 새 추론·Run benchmark·설정 변경·공개 업로드는 실행하지 않았다. normal Quit 뒤 기존 config와 두 대화 파일의 hash/bytes/mode가 정확히 유지되고 소유 짧은 임시 경로가 정리됐다. screenshot은 CUA tool trace에 있으며 로컬 파일로 저장한 캡처로 주장하지 않는다. `goal-production-source24a3dbd-orbit155-{home-before,prepared,launch,ui-observed,exit,cleanup}.json`과 대응 로그가 근거다.

최종 보존 비교에서 원래51개·현재53개 대화와 config의 나머지 영역은 보존됐지만, 모델이 비어 있는 MLX applied binding 한 값이 `Mac verification mlx-vlm`에서 검증용 `Native shared models ORBIT-97`로 바뀐 것을 발견했다. 이를 단순 revision 차이나 전체 설정 불변으로 처리하지 않았다. 실제 normal Quit 뒤 소유 GUI/launcher/engine/Vite 종료와 관련 port 폐쇄, 최종 snapshot의 config bytes·전체53개 파일 hash·active request0/API off를 확인한 상태에서 해당 JSON 값 하나만 원래 binding으로 offline 복구했다. 다른 binding·entry·revision·파일 mode·대화는 그대로 보존했다. 최초 살아 있는 process/오래된 snapshot guard 실패도 raw에 남겼으며 실제 UI 조작에 의한 복원으로 주장하지 않는다. 적용 결과는 `orbit155-preservation-draft-empty-mlx-restored-20261013.json`의 `applied=true`·`postApplyDataVerified=true`·unexpected0다.

복구한 같은 홈을 새 detached 개발 launcher로 실행했다. frontend는 `24a3dbd`, native core는 Rust 변경이 동일한 `9fde6da` build다. 실제 CUA에서 기존 Default/외부 vllm-metal0.30.0/vLLM0.30.0+cpu·context4096을 저장/시작하고, preparing→starting 후 `model loaded`와 backend `running`을 확인했다. 원래 고정 Qwen revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`이며 원래 선택 대화의 저장 모델명/PP·TG를 유지한다. API off·named active request0·composer 빈 값·생성 중 아님·overlay 없음이다. 최종 Ready 관찰 구간에서 명시적으로 등록한 passive error/unhandledrejection observer의 오류0을 확인하고 해당 listener를 제거했다. 이 구간 이전의 빈 errors fallback을 복원 명령 전체의 console 검증으로 확대하지 않는다. 설치/정리 원본은 `goal-native-audio-orbit155-finish-observer-{installed,cleanup}-20261013.json`이다. 저장 응답 표시를 새 추론으로 계산하지 않는다.

최종 read-only 보존 검사 `orbit155-preservation-draft-final-observed-20261013.json`은 전체 required pass/예상 밖 차이0이다. 원래51개 대화 hash와 현재53개 파일의 snapshot/disk hash, config의 profiles 외 영역·profile entry 순서/내용·provider recent/default·원래 default identity·applied binding keys/내용·빈 MLX binding·localStorage·선택 대화·UI preferences/theme, 별도 production config/두 대화의 hash를 확인했다. 이번 명시적 profile 저장/실행에 따른 library revision143→152, Default31→34·검증용 MLX 프로필 두 개의 revision4→5/3→4는 변경으로 기록한다. runtime process/session endpoint·log bytes의 동일성을 주장하지 않는다. 마지막 관찰 시 개발 GUI와 모델 process는 살아 있고 앱을 실행 상태로 남겼다. raw는 `goal-native-audio-orbit155-final-ready-observed-20261013.json/png`, `goal-window-orbit155-final-launch-owner.json`과 최종 보존 JSON이다. 이전 `final-ready`/`preservation-draft-final` 관찰도 원본으로 유지한다.

M01–M12 전체 판정은 **7 pass / 4 fail / 1 unrun**이다. M03/M04/M07의 실제 upstream URI500·미디어 내용/모델 snapshot 실패와 M08의 실제 도구 결과 대신 입력 인자를 반복하는 모델 내용 실패는 남아 있다. 현재 설치된 ffmpeg와 앱 PATH 복구 때문에 실제 부재 환경은 M07 하위 blocked다. M11의 별도 계정 최초 실행·Keychain·실제 upgrade·자연스러운 Finder 설치/launchd·다운로드 quarantine·Intel/구형 macOS는 unrun이며 현재 기기 결과로 추정하지 않는다. 이 관찰 당시 개인 엔진 registry/manifest는 미구현이었다. 후속 구현과 검증 상태는 아래 §98 및 [공통 런타임 문서](pluggable-inference-runtimes.ko.md)를 따른다. 이번 여섯 제품 수정·공통 검사·실제 재검증·최종 패키지를 완료했으며 전체 기기 검증 통과는 선언하지 않는다. 원격 push·공개 서비스 upload는 수행하지 않았다.


## 98. 외부 런타임 인터페이스와 Windows/Linux 인계

2026-10-13, 기준 소스 `54b605759786d4f39a1fbb3059a80698d88efbd1`에서 `9d0e9cbc4dc710a77573dc3b30713166f364a496`로 공통 런타임과 등록형 process adapter v1을 구현했다. SDK 후속 보완은 `b3da9bd`(GPU 미확인 값 보존), `f1b94e40f98d2e4c4b31b5936a418981bfa5c69d`(다른 native build를 가리키는 deployment 거부)다. 이전 Mac 후속 수정 `52f7a55`(세션 소유권/정리), `4444ce5`(API 상태), `6090558`(프로젝트 삭제 경합), `54b6057`(취소 판정)는 기준 소스에 포함돼 있다. 이 절의 새 어댑터 검증으로 이전 M01–M12의 **7 pass / 4 fail / 1 unrun**을 전체 통과로 변경하지 않는다.

`InferenceRuntimeAdapter`가 세 내장 엔진과 외부 `custom.*` 엔진의 실행 파일·구조화된 argv/env/cwd·EngineInfo를 제공하며 같은 소유 child/process group·Windows job·readiness·종료 경로로 연결한다. loopback OpenAI v1 서버 또는 별도 bridge를 manifest로 등록한다. 등록 UI/파일 선택·CLI 등록/선택/probe/제거, 명시적인 외부 모델 bindings, 공용 프로필·프로젝트·request 옵션 schema와 모델별 task/modality/tools 능력을 추가했다. 외부 제거는 등록 metadata만 제거하고 원본 환경·모델을 보존한다. 내장 세 엔진의 설치·benchmark·portable 계약은 유지한다.

설정 schema 13→14는 이전 bytes 백업을 보존한다. 이전 active provider/runtime·옵션·프로필 보존과 새 외부 프로필 기본값을 합성 임시 홈에서 검사했다. 미등록 `custom.*` 선택은 저장 데이터에 남으며 실행을 거부하고 llama.cpp로 대체하지 않는다. 외부 어댑터 v1의 정확한 tokenizer/cold-cache benchmark·CPU reference 심층 검증·portable ABI bundle은 **unsupported**이며 UI/backend에서 이유를 표시한다. 기존 이력·CSV/XLSX는 유지한다. opaque deployment binding 크기를 weights 크기로 표시하지 않는다.

검사 중 발견한 모델별 늦은 probe 경합, 새 등록 전 시작된 catalog 요청 재사용, 재등록 뒤 옛 instance 옵션 cache, cold editor에서 schema 부재 때문에 화면이 실패하는 문제를 수정했다. 모델/launch 옵션별 cache, 등록 후 새 inventory 요청, instance schema 무효화와 보수적인 reload 판정으로 회귀 검사했다. probe stdout의 JSON과 제한된 stderr 진단을 별도로 수집하며 취소·timeout 때 소유 프로세스를 정리한다. health endpoint 인증 여부도 manifest대로 적용한다. readiness·hash 검사 제거, 실패 skip, timeout 확대는 하지 않았다.

### 공통 자동 검사

원본은 `tmp/macos-acceptance/logs/pluggable-runtimes-*.log`와 `checks.jsonl`에 보존했다. 중간 타입 오류·구버전 schema backup 테스트 기대값·API mock 누락·clippy 오류와 수정 전 실패 로그도 남겼다. schema 13 이전 검사에 사용한 불일치 profile snapshot은 기존 복구 정책으로 별도 Recovered profile을 생성했다. 유효한 이전 profile application을 준비한 뒤 보존/정확한 backup 검사를 통과했으며 복구 정책을 우회하지 않았다.

| 검사 | 판정 | 근거 |
| --- | --- | --- |
| TypeScript·scripts 타입 | pass | `pluggable-runtimes-final-contract-types`, 9.36s. |
| lint | pass | `pluggable-runtimes-final-common-lint`, 7.05s. |
| 전체 공통 단위·coverage | pass | `pluggable-runtimes-final-common-suite`, 132.53s. frontend 183 files/1902 tests pass, contracts·script·direct 검사 포함. |
| Rust 전체 타깃·feature | pass | `pluggable-runtimes-final-common-native`, 46.95s. lib 953 pass/4 ignored, CLI·합성 실제 child/HTTP/SSE·기존 smoke 포함. 하드웨어 opt-in ignored 검사를 실제 수행한 것으로 계산하지 않음. |
| rustfmt·clippy | pass | `pluggable-runtimes-commit-fmt`, `pluggable-runtimes-final-source-clippy`, `-D warnings`. |
| 배포 feature 검사 | pass | `pluggable-runtimes-production-feature-check`, `--all-targets --no-default-features`, 28.32s. |
| Python SDK | pass | `pluggable-runtimes-strata-build-binding`, CPython 3.12, 합성 GGUF/template·truncation·Strata config 소유권/등록 build 보존 4 tests. 실제 Strata 추론을 수행한 테스트가 아님. |
| production frontend·CLI·debug native 빌드 | pass | `pluggable-runtimes-build-source-freeze`, `pluggable-runtimes-committed-cli`, `pluggable-runtimes-debug-source-final`. 이 빌드 성공을 패키지 설치/GUI 실제 조작으로 확대하지 않음. |

합성 네 번째 엔진은 실제 registry·모델 binding·readiness·SSE·usage fixture·스트림 종료·소유 PID/port 정리·중복/identity/hash 오류·probe 실패 진단·취소·제거 뒤 선택 보존·재등록과 다른 모델의 늦은 probe를 검사한다. 응답 `OK`와 fixture usage는 실제 모델 추론으로 계산하지 않는다. 외부 canonical request가 선언한 추가 필드와 model alias를 유지하고 미지원 tool/local path를 거부하는 native 검사도 포함했다.

### 실제 외부 CPU 빌드

기기는 macOS 26.6.2 / Apple M2 / 16GB다. 기존 검증의 외부 CPU llama-server build `b11460`, version `0.6.0-dev`, source `78651c410`을 등록했다. 작은 공개 `Qwen/Qwen2.5-0.5B-Instruct-GGUF`, revision `9217f5db79a29953eb74d5343926648285ec7e67`, `qwen2.5-0.5b-instruct-q4_k_m.gguf` 491400032 bytes, SHA-256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`를 재사용했다. 새 모델 다운로드·Strata 설치·공개 업로드는 하지 않았다.

`custom.native-reference/cpu-local`을 새 임시 CLI 홈에 등록해 실제 `2+3` 응답 `5`, authoritative prompt42/completion2/total44·cached0, 내용을 받은 뒤 스트림 취소와 서버 유지, 재시작, 종료, 제거 후 저장 선택 유지/실행 거부, 앱 재빌드 없는 재등록 후 실제 응답을 확인했다. A01–A09 **pass**이며 마지막에는 소유 PID와 port가 사라지고 명시된 전체 모델 SHA-256이 보존됨을 확인했다. 원본은 `runtime-interface-real/cli-sdk-final/`와 최종 커밋 소스 재실행 `runtime-interface-real/cli-committed/`이며 SDK 보완 뒤 `runtime-interface-real/cli-final-sdk-source/`와 `cli-final-sdk-binding/`에서 재실행했다. 최종 source는 SDK 보완 커밋까지 포함하며 raw의 source_dirty=true는 문서 작업 때문이다. 첫 시도의 AbortError 처리 실패는 harness 결함으로 수정했으며 `cli-run/` 실패 결과를 보존했다. 실제 SSE parser로 처리하고 최종 arithmetic 내용·usage를 검사하도록 보완했다.

SDK의 실제 upstream env 인증도 별도 소유 실행에서 검사했다. `/health` 무인증200, `/v1/models` 무인증401/정상 bearer200, 실제 chat `5`와 prompt42/completion2/total44, 소유 PID/port 종료를 확인했다. 원본은 `runtime-interface-real/auth-binding/`와 `pluggable-runtimes-actual-upstream-auth.log`다. 이 검사는 앱 gateway 인증/라우팅의 새 GUI 전체 검증을 대신하지 않는다.

원래 개발 앱의 vllm-metal 모델은 생성 요청 없이 Ready로 보존했다. 따라서 위 CPU 기능 검사를 단독 엔진 메모리·성능·cold-cache 측정 근거로 사용하지 않는다. read-only 관찰에서 원래 전체53개 대화 hash와 설정 bytes가 앞선 `orbit156-restored-ready` snapshot과 정확히 같고 schema13/library revision158, API off·생성 중 아님을 확인했다. `runtime-interface-preservation-v2.json`과 `goal-native-audio-runtime-interface-original-preserved.json/png`가 근거다. 더 오래된 revision152 snapshot과의 config 차이는 이전 승인된 작업의 변화이므로 이 작업의 설정 불변 근거로 사용하지 않았다.

### 남은 실제 기기 검사와 인계

| 항목 | 판정 | 이유 및 다음 작업 |
| --- | --- | --- |
| 새 native GUI의 등록→profile→모델 실행, 최소 창, 취소/재로드 | pass | 당시 잠금으로 blocked였으나 사용자 해제 확인 후 실제 조작·종료·재시작·원래 환경 복원을 수행했다. 후속 제품 수정과 실행 근거는 §99. |
| 외부 엔진의 앱 gateway 인증/라우팅 | pass | §99의 별도 홈에서 실제 UI로 시작/중지하고 무인증·잘못된 키 401, 정상 인증 200과 실제 `5`/usage를 확인. |
| 외부 엔진의 실제 MCP/RAG/미디어/멀티 세션 | unrun | 새 어댑터에 대한 해당 실제 내용·상호작용은 별도 기기 검사 필요. SDK CPU reference는 text/generate만 확인했으며 tools/image/audio/video는 unsupported. |
| 원본 Niko1221/Strata | unrun | 이 Mac M2/16GB는 원본 Windows/Linux x86-64 GPU·메모리 조건을 충족하지 않음. 고정 source revision·전용 deployment config와 설치된 Python/엔진을 받는 SDK 제공. 실제 source help/version과 serving은 대상 기기에서 확인해야 함. |
| Windows·Linux 실제 빌드·GUI·엔진·패키지 | unrun | 현재 기기에서 추정하지 않음. [OS 인계](runtime-adapter-handoff.ko.md)에 PowerShell/Linux 명령, 합성/실제 harness, source/model/hash provenance, W/L01–09 검사표 제공. |
| 외부 v1 benchmark/deep/portable | unsupported | 실제 tokenizer/cold-cache/reference/ABI 구현 없이 성공으로 표시하지 않음. 기존 내장 엔진 기능은 유지. |
| 새 소스의 Mac 배포 패키지·별도 계정·Intel/구형 macOS | unrun | 이 절에서 새 DMG/설치/upgrade를 수행하지 않음. 이전 §97 패키지는 그때의 소스 결과이며 새 source 패키지로 재사용하지 않음. |

[공통 런타임 문서](pluggable-inference-runtimes.ko.md)와 [Windows/Linux 인계](runtime-adapter-handoff.ko.md)에 v1 계약·SDK 사용법·제약·재검증 조건을 반영했다. 원본 로그·모델·manifest·환경별 경로·capture는 `tmp/`에 두고 커밋에는 코드·회귀 검사·익명화 문서만 포함한다. 원격 push는 수행하지 않았다.

## 99. 외부 런타임의 실제 Mac GUI와 기존 환경 복원

2026-10-13, 사용자 잠금 해제 확인 후 §98의 GUI blocked 항목을 재개했다. native core는 `1a74a7fcb5944092b464d931699e868d39ee180a`에서 빌드한 `macos-ui-smoke` debug이고 frontend는 같은 소스에서 아래 두 수정까지 적용한 `51afc569ceb7b0cf126c26664cf756889ae51c25`다. 실제 WKWebView 입력·파일 선택·창 조절·종료는 CUA로 수행했다. WebDriver는 읽기 전용 IPC/DOM/캡처와 수동 오류 관찰에 사용했으며 등록·설정 변경·실행을 대신 호출하지 않았다. 이 결과를 배포용 DMG 설치 성공으로 계산하지 않는다.

원래 앱은 정상 Quit로 종료하고 빈 작업용 홈에서 새 native bundle을 실행했다. 홈·legacy/WebKit 저장 경로를 격리했고 원래 설정/대화를 fixture로 복사하지 않았다. §98과 같은 공개 Qwen2.5 GGUF와 외부 CPU 빌드·고정 revision/hash를 재사용했다. 실제 native 파일 선택에서 manifest를 고르고 검사 후 등록했다. 최종 전체 모델 SHA-256 보존은 `adapter-ui-final-model-integrity.json`에서 확인했다. 새 모델 다운로드·공개 서비스 업로드·원격 push는 하지 않았다.

### 실제 조작 중 해결한 결함

- `3c5b067`: 처음 선택한 외부 엔진의 기본 프로필 객체가 반환된 공용 프로필 library에 없어서 설정 본문이 비었다. profile assignment 경로가 현재 provider의 기본 entry를 library에 포함하도록 수정했다. `adapter-ui-external-dialog-empty.json/png`에서 실제 실패를 관찰하고 `adapter-ui-profile-repro`에서 합성 최소 재현을 실패시켰다. 수정 뒤 프로필·모델 선택·생성 옵션이 표시됐으며 관련 4 files/169 tests와 실제 프로필 저장/실행을 통과했다. source library를 변경하지 않는 검사도 포함했다.
- `51afc56`: 중지한 부분 응답의 retry 정보를 유지하면서 버튼은 오류 banner 안에서만 표시했다. 마지막 응답이 interrupted이고 retry 정보가 있는 경우에도 기존 Retry 동작을 표시했다. `adapter-ui-retry-repro`의 실제 ChatPanel 경로 검사는 수정 전 실패했다. 수정 뒤 관련 2 files/15 tests와 실제 부분 응답 Retry가 통과했다. 같은 요청 history 재사용, 사용자 메시지 중복 방지, 부분 응답 교체, 완료 후 버튼 제거와 새 metrics를 검사했다. 재시작한 대화에 휘발성 retry 정보가 없는 경우 버튼을 임의로 제공하지 않는다.

### 실행 결과

| 항목 | 판정 | 실제 근거 |
| --- | --- | --- |
| 새 홈과 native manifest 등록 | pass | `adapter-ui-fresh.json/png`, `adapter-ui-registered.json/png`. 빈 홈에서 온보딩·native 파일 선택·검사 후 네 번째 엔진/version/CPU/external 표시. |
| 공용 프로필·모델·옵션·실행 | pass | `adapter-ui-fixed-dialog`, `model-selected`, `profile-saved`, `start` JSON/PNG. 외부 모델 binding 선택, `Adapter GUI validation` 공용 프로필과 request max_tokens32/temperature0 저장, 실제 Ready·chat/text 능력 확인. 세 내장 엔진 default entry 보존. |
| 실제 응답과 usage | pass | `adapter-ui-answer.json/png`. 합성 `2+3` 입력에 `5`, 실제 입력36/출력2 토큰 표시·저장. |
| 실제 스트림 취소 | pass | `adapter-ui-real-cancelled.json/png`. 긴 합성 이야기에서 내용 수신 후 Stop, 4382자 부분 응답의 interrupted=true·Ready 유지·active requests0. 종료 usage가 오지 않은 취소는 PP/TG를 미제공으로 남김. 앞선 숫자 목록은 자연 종료가 먼저 완료돼 `adapter-ui-cancelled`를 취소 통과 근거로 사용하지 않음. |
| 부분 응답 Retry | pass | `adapter-ui-retry-completed.json/png`. 실제 버튼으로 같은 요청을 재전송, 사용자/assistant 두 메시지 유지, 출력1024 토큰·length 종료와 새 metrics 기록. cached59 토큰과 신규 PP1 토큰을 구분해 표시. 내용의 품질이나 2000단어 달성을 모델 성공 기준으로 삼지 않음. |
| 최소 창의 실행 영역·설정 열기 | pass | `adapter-ui-minimum-window`, `minimum-settings`, `minimum-generation` JSON/PNG. 실제 모서리 drag로 외부 창360×520, client360×488·scrollWidth360. 고정 모델/설정/언로드 영역과 외부 프로필 표시, 생성 탭 선택 확인. max_tokens1024/temperature0은 접근성 tree로 확인했으며 이 캡처에서 접힌 아래 옵션의 실제 스크롤/수정 성공으로 확대하지 않음. |
| 최소 창의 아래 옵션 스크롤·직접 수정 | unrun | 일반 크기에서는 실제 입력/저장을 확인했지만 최소 창에서는 탭 선택과 설정 값 관찰까지 수행. 대상 OS의 W/L04에서 아래 옵션까지 실제 스크롤·입력 확인 필요. |
| 앱 gateway 인증·alias 라우팅 | pass | 실제 UI 시작/중지, `adapter-ui-gateway.json/png`, `adapter-ui-gateway-check.json`. `/v1/models` 무인증/잘못된 bearer401, 정상 bearer200. 목록의 alias로 실제 chat200/`5`와 prompt42/completion2/total44·cached5. API 중지 후 모델 Ready 유지. |
| 정상 Quit·재시작·재실행 | pass | `adapter-ui-exit/cleanup`, `first-quit-ownership`, `restart-reloaded/ready`, `restart-final-preservation` JSON/PNG. 설정 값 정확히 동일, 등록1개와 대화2개 파일 hash 보존, 저장 프로필로 다시 Ready. 두 번째 정상 Quit 후 해당 GUI/engine/Vite PID와 model/API/driver/Vite port 종료. 첫 종료의 Vite1420은 재시작 검증 때 이미 재사용 중이므로 첫 소유 PID 종료/cleanup과 두 번째 최종 port 종료를 구분함. Cmd+R 입력만으로 reload 성공을 주장하지 않고 실제 Quit/재실행으로 검사. |
| 외부 미지원 표시 | pass | 실제 CUA Benchmark에서 실행 disabled와 정확한 tokenizer/cold-cache 미지원 사유 표시. 등록 runtime inventory의 deep 미지원과 portable export 부재 확인. 해당 기능 자체는 §98대로 unsupported이며 새 benchmark/CSV/XLSX 결과를 만들지 않음. |
| 화면 오류 관찰 | pass | `adapter-ui-observer-remove.json`, `adapter-ui-restart-observer-restart-remove.json`의 errors/warnings/error events/unhandledrejection 각각0. 관찰 기간은 설치~제거에 한정하며 원래 앱 복원 기간까지 확대하지 않음. production build의 기존 500KiB chunk 경고는 남아 있으며 build 실패는 아님. |

이번 GUI 검증에서는 모델을 하나씩 실행했다. 재시도의 warm cache·실제 runtime PP/TG 표시를 cold-cache benchmark 또는 단독 성능 검증으로 확대하지 않는다. CPU reference의 도구·미디어 지원은 unsupported이며 외부 엔진의 실제 MCP/RAG/멀티 세션과 지원 미디어 검사는 여전히 unrun이다. 원본 Strata와 Windows/Linux 실제 실행도 unrun이다.

### 기존 작업 환경과 최종 검사

검증 앱을 정상 종료한 뒤 원래 bundle을 보존한 새 native 사본으로 같은 원래 작업용 홈을 복원했다. schema13→14 이전 backup bytes는 실행 전 설정과 정확히 같았다. 원래 vllm-metal0.30.0/vLLM0.30.0+cpu와 Qwen3-VL-2B-Instruct-4bit revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`를 CUA에서 같은 Default 프로필로 시작했다. 인증된 로컬 엔진에 합성 산술 요청을 별도로 보내 실제 `5`, prompt21/completion2/total23·cached0을 확인했다. 앱 대화에 새 메시지를 추가하지 않았다.

`adapter-ui-original-preservation.json`은 전체53개 대화 hash·localStorage·선택 모델/runtime·profile entry 순서/내용 보존, 정확한 schema13 backup, 예상 밖 설정 차이0을 확인한다. 명시적인 Save profile & start에 따른 library revision158→160와 vLLM Default/profile application revision35→36, config_version13→14는 실제 변화로 기록한다. 최종 `goal-native-audio-adapter-ui-original-final.json/png`에서 모델 Ready·active requests0·API off·생성 중 아님이다. 앱과 원래 모델을 실행 상태로 남겼다. 오래된 observer의 addedConversationFiles30은 과거23개 baseline과의 차이이며 이번 작업의 추가 대화 수가 아니다. 이번 실행 전53개 전부와 직접 비교해 모두 보존했다. 원래 앱의 빈 errors fallback을 오류 관찰 성공으로 계산하지 않는다.

| 최종 검사 | 판정 | 근거 |
| --- | --- | --- |
| 타입·lint | pass | `adapter-ui-final-typecheck`9.48s, `adapter-ui-final-lint`4.88s. |
| 전체 공통 검사 | pass | `adapter-ui-final-suite`130.11s, contracts/scripts/direct 포함, frontend183 files/1904 tests·line coverage85.17%. |
| production frontend 빌드 | pass | `adapter-ui-final-build`12.25s. |
| native/SDK | pass | native source·SDK 변경 없이 §98의 전체 타깃/feature·fmt/clippy·production feature·Python 검사를 유지. 새 native debug 빌드 `adapter-ui-unlocked-build`와 실제 외부 CPU 및 기존 vllm-metal 실행 확인. Rust 전체 검사를 이번 frontend 수정 후 다시 실행한 것으로 기록하지 않음. |

원본은 `tmp/macos-acceptance/adapter-ui-*`, `goal-native-audio-adapter-ui-*`, `logs/adapter-ui-*`, `checks.jsonl`에 남겼다. 로그·credential·개인 경로·capture는 커밋에 포함하지 않는다. 새 패키지 설치·별도 계정·Intel/구형 macOS는 unrun이다. M01–M12의 기존 전체 판정 **7 pass / 4 fail / 1 unrun**은 유지하며 전체 기기 검증 통과를 선언하지 않는다. Windows·Linux는 [어댑터 인계](runtime-adapter-handoff.ko.md)의 기준 소스와 W/L01–09로 작업을 이어간다.

## 100. 남은 4개 fail의 원인 수정과 실제 앱 재검증

2026-10-14(KST), 이어서 검증한 기준 소스는 `250b834`다. 복구 도구/호환 runtime/native probe 수정은 `64791d2d940fb5fc538257ceec9df888286832a4`, 대화의 자동 system 안내 선택은 `158f966ce6b6d47713f07c841428fdb73752be3f`다. 실제 native core는 기준 소스에 위 native 변경을 적용해 빌드한 `macos-ui-smoke` debug이며 frontend도 위 대화 변경을 반영했다. 자동 검사·실제 앱 조작은 커밋 전 같은 코드 내용으로 수행했다. 새 DMG 설치 결과로 확대하지 않는다.

기기는 macOS26.6.2 / Apple M2 /16GB다. Node22.23.2/npm12.0.2, Rust1.98.0, native arm64 CPython3.12.15를 작업용 경로에서 사용했다. 원래 앱을 정상 Quit한 뒤 새 홈·legacy/WebKit 경로를 격리한 실제 WKWebView에서 파일 선택·등록·프로필 저장·실행·입력·Stop/Retry·정상 Quit/재시작을 CUA로 조작했다. WebDriver는 읽기 전용 IPC/DOM/캡처와 요청을 변경하지 않는 수동 오류/전송 관찰에만 사용했다. 모델은 하나씩 실행했다. 원본 모델·환경·관리형 설치 기본 버전은 변경하지 않았다.

### 검증 환경과 고정 모델

| 엔진/모델 | 고정 정보 |
| --- | --- |
| vllm-metal | plugin0.30.0, core `0.30.0+cpu.aiolm.media1`. 별도 venv에서 원래 175개 의존성 버전을 유지하고 core만 별도 wheel로 교체. pinned MLX/MLX-LM/native paged ops·MetalPlatform 검사 유지. |
| mlx-vlm | 최종 `0.7.6+aiolm.media4`, 별도 venv에서 원래 57개 패키지의 provider 외 버전 유지. 실제 최종 native 등록/load·오류/음성 검사를 수행. 중간 media1/2/3 결과는 해당 버전 범위로 구분. |
| llama.cpp | 기존 공개 CPU build b11460, version0.6.0-dev(11460), source78651c410. 검증된 CPU ZIP을 실제 앱으로 import. 이번 SmolVLM 재검증은 CPU/ngl0이며 Metal 성공으로 계산하지 않음. |
| Qwen3-VL | `mlx-community/Qwen3-VL-2B-Instruct-4bit`, revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`, weight1782040921 bytes. |
| Gemma3n | `mlx-community/gemma-3n-E2B-it-4bit`, revision `66e7276cfc589073b4f92ebed58c05301f990222`, weight4462976625 bytes. 원본을 보존한 별도 derived snapshot. |
| Gemma4 | `mlx-community/gemma-4-E2B-it-4bit`, revision `238767527555cb75a05732a84dff5d6ba0dd6809`, weight3550670554 bytes. 원래 weights/processor/template를 유지. |
| SmolVLM | `ggml-org/SmolVLM-256M-Instruct-GGUF`, revision `b9e4379657e1450d04d02eec8e345667265b0a00`, Q8_0 weight175054528 bytes·f16 projector190031616 bytes. |

새 weights 다운로드는 하지 않았다. 공식 canonical template와 upstream 소스는 원인 비교용으로 별도 조회/보관했고 원래 snapshot에 적용하지 않았다. 합성 PNG는 왼쪽 빨간 세로 직사각형/오른쪽 파란 원이며 WAV는 “The red square is on the left. The blue circle is on the right.”다. 서로 다른 도형 내용을 섞어 정답을 판정하지 않는다. 원본 source/model/index/wheel과 원래 vLLM connector의 마지막 52개 파일 무결성 검사는 `residual100-final-preservation.json`에 보존했다.

vLLM 호환 wheel SHA-256은 `306bbf9faf6db3dcaa6161d13a1d795ca33dee39aaff62ef196d8a52439c12e1`, 최종 MLX wheel은 `03e7379294c9c7268cec27cc9df055f19019ce8cb550c0e77412cd89bd8f3e21`다. 입력 wheel의 hash·버전·알려진 source 문맥·RECORD·라이선스/native 속성을 확인하는 [복구 도구와 사용법](macos-validation-recovery.ko.md)을 추가했다. 별도 env 설치는 offline wheel cache를 사용했으며 dependency 검사도 통과했다.

### 해결한 재현 문제

| 문제 | 판정 | 원인·수정·실제 근거 |
| --- | --- | --- |
| M03 file URI가500 | pass | upstream connector가 allowlist 거부를 일반 RuntimeError/ValueError로 던졌다. 별도 core wheel에서 VLLMValidationError로 분류해400 반환. allowlist 유지. `residual100-r2-vllm-file-uri-authenticated.json`. 처음 harness의 인증 없는401은 실패 로그로 남겼으며 실제 오류 검증으로 계산하지 않음. |
| 검증된 local Metal core 등록 거부 | pass | 정확한 local version·입력 wheel provenance·설치 connector hash를 Python/Rust가 새 probe로 확인하게 수정. native CPython/macOS/MLX/MetalPlatform/native extension 조건과 imported version 검사 유지. 임의 suffix·다른 hash는 계속 거부. 실제 native 등록/Ready는 `residual100-r2-ui-vllm-ready`. |
| M04 MLX file URI500 | pass | 별도 wheel의 normalizer가 file media를400으로 명시적으로 거부. 최종 native Gemma4 엔진에서 `residual100-r3-mlx-media4-negative.json` 확인. 파일 접근 권한을 넓히지 않음. |
| M04 Gemma3n 누락 shard index | pass | 원본 인덱스는 존재하지 않는3 shards/1556 BF16 names를 가리켰으나 실제 파일은2302 quantized tensors였다. 전체 weight SHA-256·dtype/shape/byte 범위로 새 index를 파생 폴더에 생성. 원본 index/weights 보존. 최종 도구 산출물로 실제 native Ready·음성 추론 확인. 모델 내용의 정확성은 아래 fail로 별도 유지. |
| M07 오디오 이력 배치 | pass | 설치된 normalizer/template가 모든 audio marker를 마지막 user에 배치했다. 명시적 audio를 원래 user에 배치하고 marker 없는 side-channel 호환 fallback 유지. 실제 설치된 checker가 수정 전 `[0,0,2]`, 최종 수정 후 `[1,0,1]`. `residual100-mlx-media4-audio-ownership`. |
| M07 invalid WAV500·in-flight 누수 | pass | stream preflight decoder 오류가 시작한 metric을 정리하지 못했다. 별도 최종 wheel이 오류/취소를 한 번 기록·정리하고 알려진 audio format ValueError를400으로 반환. 실제 동일 bad bytes: media1은500/in-flight1, media4는400/in-flight0/failure+1. `residual100-mlx-preflight-before.json`, `residual100-r3-mlx-media4-negative.json`. protected-budget 초과는 request 시작 전400/metric delta0이었다. 별도 preflight overflow의 중복 기록 방지는 회귀 검사로 확인했으며 이 live path를 실행했다고 주장하지 않음. |
| M07 자동 system 안내 선택 부재 | pass | Gemma4 직접 추론도 긴 동일 질문에 generic system이 있으면 음성을 다시 요구했다. 대화별 opt-out을 추가하되 명시적 대화·프로필·개인화 지침과 기존 기본 동작 유지. 실제 짧은 전사와 첫 녹음을 사용하는 후속 전사가 둘 다 정확. `residual100-r3-ui-no-default-short-audio-history`. 정상 Quit/재실행 뒤 checkbox off·10개 대화/기록/metrics 보존은 `residual100-r4-ui-checkbox-off-reloaded`. |

Gemma3n weight SHA-256은 `8d5af4ae73617d12496301ebad11226f9056c4b0d51dbb9ef9409234fb87d6fa`다. 원본 index `3ed4d02b8c245c61ba2f542e48cc40ed98398f7098457d63d3d7d0fda8d09c0c`를 별도로 보관하고 derived index `e31d30fceae1bdf9da3bcd7fa72568b53fcb1306464d86a9ab012e26ad6f6946`를 생성했다. repaired snapshot을 원본 Hub/관리형 다운로드로 가장하지 않는다. 무결성·readiness 우회, 실패 skip·timeout 확대는 하지 않았다.

### 실제 내용·lifecycle 재검증과 남은 실패

| 흐름 | 판정 | 근거·남은 범위 |
| --- | --- | --- |
| vLLM 이미지 내용·usage | pass | 실제 PNG 첨부/응답에서 빨간 직사각형 왼쪽·파란 원 오른쪽, PP115/TG85/cache0. `residual100-r2-ui-vllm-image-result`. |
| 실제 취소·Retry·정상 종료/재시작 | pass | max256 두 번은 자연 종료가 먼저 완료돼 취소 성공으로 계산하지 않았다. 별도 프로필의 출력2048로 재시작해 내용 수신 후 Stop, 부분 응답/Retry·active requests0 확인. Retry는 실제 완료/length2048·새 metrics였으며 숫자1000개 내용 달성으로 계산하지 않음. `residual100-r2-ui-vllm-cancelled`, `vllm-retry-complete`. 정상 Quit 후 소유3 PID/port 종료, 같은 홈 재시작 후5개 대화 보존. SmolVLM 검증 종료 후에도 소유 PID/port 정리 통과. |
| Gemma4 긴 오디오 첫 답변 | pass | opt-out에서 동일 WAV의 정확한 단수 전사/도형 내용을 답함. PP123/TG256으로 output limit의 부분 응답. 전체 긴 설명 완료로 계산하지 않음. 원래 automatic system이 있는 최종 media4 답변은 계속 reattach를 요구해 fail. |
| Gemma4 긴 부분 답변 뒤 후속 전사 | fail | opt-out에서도 PP405/TG22로 다시 audio를 요구. 수동 wire 관찰에서 첫/후속 roles `[user]`/`[user,assistant,user]`, 동일 materialized WAV hash를 확인. 짧은 완결 답변 뒤의 후속 전사는 PP137/TG17로 정확했으나 긴 대화의 실패를 대체하지 않음. `residual100-no-default-wire-summary.json`, `residual100-r3-ui-passive-chat-remove.json`, `residual100-r3-ui-no-default-short-audio-history`. |
| Gemma3n 전사 내용 | fail | 구조 복구/Ready와 별개로 singular square를 plural squares로 답하는 내용 오류가 남음. 모델 값·processor를 추측 수정하지 않음. |
| SmolVLM 이미지 내용 | fail | 정확한 고정 Q8_0/f16 projector, CPU/ngl0/context4096/temperature0, automatic system off로 실제 PNG 재검증. “The circle is blue.”만 답해 rectangle/position을 누락. PP156/TG6/cache0. `residual100-r3-ui-smol-image-no-default`. 해당 모델의 기존 native 내용 실패를 그대로 유지. |
| Gemma4 실제 MCP 승인→도구→최종 답변 | pass | 별도 홈의 실제 fixture에서 입력 `RESIDUAL-100 input`과 다른 고정 반환 `synthetic result` 사용. 앱 Approve once→Mac Yes를 사용자가 클릭한 뒤 최종 답변도 `synthetic result`, PP167/TG3. `residual100-ui-gemma4-mcp-result`, `residual100-mcp-events.jsonl`. 이 호출은 MLX media1에서 수행했으며 최종 media4의 새 MCP 호출로 재표기하지 않음. |
| 고정 Qwen3 MCP 후속 내용 | fail | 원래 runtime/model로 복원한 뒤 같은 completed tool history를 인증된 직접 추론으로 재검증. JSON envelope와 순수 text 모두 HTTP200이지만 반환값 대신 입력 인자 반복. temperature0/tool_choice none이며 도구를 새로 실행한 검사가 아님. `residual100-original-direct.json`. 앱 결과 serialization을 근거 없이 변경하지 않음. |
| 실제 ffmpeg 부재 | blocked | 현재 시스템 설치/PATH 복구 조건은 기존 그대로. 시스템 executable을 숨기거나 제품 탐색을 제거하지 않음. |
| Windows/Linux·Strata·새 배포 패키지 | unrun | 해당 실제 기기/패키지 결과 없음. Mac 전용 wheel·다른 모델의 답변을 해당 OS/모델의 통과로 계산하지 않음. |

[Google 공식 Gemma4 prompt 형식](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4)은 system 역할을 지원한다. 공식 canonical template도 고정 source revision `3e22461f65e89153144f8adb70e3b8c2cc9845a7`에서 확인했다. 같은 rendered prompt/동일 실패를 재현했고 system 뒤 공백을 바꿔도 해결되지 않았다. `residual100-gemma4-direct-system-templates.json`, `residual100-gemma4-canonical-probe.json`. 따라서 template 결함이나 엔진 전체의 system 미지원으로 단정하지 않는다.

위 pass는 명시된 **별도 호환 환경/옵션/모델**의 하위 검사 결과다. 기존 stock environment의 URI500, 고정 모델의 내용 실패를 다른 환경/모델의 성공으로 삭제하지 않는다. M03/M04/M07/M08의 원인 조사·제품 수정·실제 앱 재검증을 수행했으나 **4개 모두 pass는 아니다**. 기존 기준의 M01–M12 전체 **7 pass /4 fail /1 unrun**과 역사적 실패를 유지하며 전체 기기 검증 통과를 선언하지 않는다. 원본 weights 업데이트 없이 모델 내용 오답을 제품 코드로 강제로 통과시키지 않는다.

### 최종 공통 검사·원래 환경 복원

| 검사 | 판정 | 근거 |
| --- | --- | --- |
| 전체 frontend·contracts/direct/scripts/coverage | pass | `residual100-final-js-suite`,175.41s. frontend183 files/1908 tests, line85.17%. 기존 jsdom canvas/pseudo-style 진단은 남아 있으나 실패0. |
| 타입·lint·production frontend | pass | `residual100-final-typecheck`26.37s, `residual100-final-lint`20.13s, `residual100-final-build`20.45s. 기존500KiB chunk 경고 유지. |
| Rust 전체 타깃/feature | pass | `residual100-native-all-targets`,45.72s. lib954 pass/4 ignored, 전체982 pass/13 ignored/0 fail. CLI/합성 child/HTTP/SSE 포함. 기존 명시적 live opt-in ignored를 실제 수행으로 계산하지 않음. |
| rustfmt·clippy | pass | `residual100-final-fmt`, `residual100-native-clippy`,5.50s, all-targets/all-features `-D warnings`. |
| Python 도구·native probe | pass | stdlib 복구5/호환5/probe6 tests. 최종 probe 재실행은 `residual100-final-probe-tests`. `residual100-final-reindex-preservation`, `residual100-final-python-tests`와 probe 로그. 원본·기존 출력·취소·발행 경합·라이선스 보존, overflow의 실패 기록 한 번, 변조 local runtime 거부 포함. |
| 현재 native core/CLI 빌드 | pass | `residual100-media-debug-build`13.94s, `residual100-final-cli-build`32.92s, CLI no-default-features. 둘 다 원래 bundle을 보존한 새 사본에 적용하고 strict ad-hoc signature 확인. |
| 현재 CLI 합성 smoke | pass | `residual100-final-cli-smoke`,2.04s. 새 임시 홈의 초기화·옵션·선택 rollback·진단·소유 snapshot 삭제를 확인. 실제 모델 추론 검사가 아님. |
| 실제 화면/오류 관찰 | pass | 최종 옵션의 실제 클릭/응답/정상 재시작, `residual100-r3-ui-observer-r3d-remove`와 `residual100-r4-ui-observer-r4-remove`의 errors/warnings/events0. 각각 설치~제거 기간에 한정. 원래 환경 observer의 빈 fallback을 이 성공 근거로 사용하지 않음. |
| 원래 환경 보존 | pass | `residual100-final-preservation.json`. 작업 전 전체53개 대화 hash·localStorage 정확히 동일, 원래 vllm-metal0.30.0/default Qwen3 model/runtime 선택·옵션 보존. 실제 Save & start에 따른 library revision160→162/Default36→37 외 예상 밖 설정 차이0. Ready/active requests0/API off, 직접 산술 응답 `5`. 기존 stock env를 호환 env로 자동 교체하지 않음. |

원래 앱·원래 모델은 실행 상태로 남겼다. `residual100-final-source-proof.json`은 최종 제품 source diff 없음과 검증 앱/복원 앱의 unsigned native 입력 일치를 확인한다. 마지막 native 캡처는 `goal-native-audio-residual100-original-final.json/png`다. 정상 종료한 검증 앱의 모델/포트와 staging은 정리했고 원본 모델/환경/번들/도구 로그는 보존했다. 개인 경로·credential·capture·원본 로그는 `tmp/macos-acceptance/`에 두고 커밋하지 않는다. [Windows/Linux 인계](runtime-adapter-handoff.ko.md)에 새 source·회귀 명령·옵션 저장/재로드·잘못된 media/오디오 이력 검사와 모델별 남은 실패를 반영했다. 별도 계정 최초 실행·Keychain·실제 upgrade·자연스러운 Finder 설치 실행·Intel/구형 macOS는 계속 unrun이며 공개 업로드·원격 push는 하지 않았다.

## 101. 미디어 내용과 도구 후속 답변의 추가 원인 검증

2026-10-14, 같은 macOS26.6.2/M2/16GB에서 §100의 `227e9ff`를 기준으로 조사했다. `5ba74fe`는 Gemma4 audio encoder padding을 제거하는 별도 호환 wheel/회귀 검사, `4a97627`은 대화별 첨부 순서 선택/저장과 parser 오류 안내 수정이다. native core는 §100의 `64791d2`와 동일하며 실제 WKWebView는 이번 frontend 소스를 사용했다. 관리형 upstream 기본 버전·원본 모델·기존 환경은 자동 교체하지 않았다. 실제 엔진은 하나씩 실행했고 독립 직접 검사 전 앱의 모델을 언로드했다. 공통 검사가 함께 실행된 구간의 수치를 성능 벤치마크로 보고하지 않는다.

### 고정 모델·별도 환경

설치된 loader/processor 지원을 먼저 확인하고 다운로드 전에 전체 revision을 고정했다. 아래 크기는 선택한 snapshot 파일 합계다. 각 LFS 전체 SHA-256·sidecar git blob 및 라이선스/저작권 파일은 raw provenance에 보관했다. 공개 모델 다운로드이며 계정 token·공개 업로드는 사용하지 않았다.

| 용도 | 출처·전체 revision | 크기(bytes) |
| --- | --- | ---: |
| 원래 Gemma4 | `mlx-community/gemma-4-E2B-it-4bit`, `238767527555cb75a05732a84dff5d6ba0dd6809` | 3,583,088,661 |
| 원래 Gemma3n | `mlx-community/gemma-3n-E2B-it-4bit`, `66e7276cfc589073b4f92ebed58c05301f990222` | 4,502,727,070 |
| SmolVLM 원본 대조 | `HuggingFaceTB/SmolVLM-256M-Instruct`, `7e3e67edbbed1bf9888184d9df282b700a323964` | 517,904,565 |
| Qwen3 원본 대조 | `Qwen/Qwen3-VL-2B-Instruct`, `89644892e4d85e24eaac8bacfd4f463576704203` | 4,266,648,961 |
| SmolVLM 대안 | `ggml-org/SmolVLM-500M-Instruct-GGUF`, `72e986006ef53e37cdd3f6d4241c90b0f01df376` | 636,277,783 |
| Gemma3n 정밀도 대조 | `mlx-community/gemma-3n-E2B-it-8bit`, `e391bc9e5397e6bd0d392ae6f1dfe69f4e694d61` | 6,734,451,320 |
| Qwen3 대안 | `mlx-community/Qwen3-VL-4B-Instruct-4bit`, `2fd8dacbdb8f1e54b8c005f081ec5bf79c56376b` | 3,109,732,071 |

원래 SmolVLM256M GGUF revision은 `b9e4379657e1450d04d02eec8e345667265b0a00`, Qwen3-VL2B4bit는 `9c4f5209e57b31f4b9dfba735de3fb983739c9cc`로 유지했다. `residual101-reference-model-provenance.json`, `residual101-alternative-provenance.json`, `residual101-staged-model-provenance.json`에 전체 파일 검증을 보존했다. Qwen4B snapshot도 실제 단일 weight와 다른 shard index를 제공해 기존 복구 도구로 **별도** 파생 폴더를 생성했다. 원본/파생 index SHA-256은 `58a7841d7bff2548dd91577d216274a83cf1b500bc6a534b809d6c1b1707cf2b`/`5b093d9ec44e62ecdf62142a1b56a4e5eec1811ae63cf1b01813d3d36c0d0496`, 동일 weight SHA-256은 `90eeb02604181dbcccd0a30a1f550a4a8928ca7dcbee4aee1449239306cfdfca`다. 이를 원본 Hub snapshot으로 가장하지 않았다.

MLX 최종 환경은 native arm64 CPython3.12.15/MLX0.32.3/transformers5.19.0과 `mlx-vlm0.7.6+aiolm.media5`다. 별도 venv의 정확한57개 dependency는 기존 환경과 같고 provider wheel만 변경했다. upstream 입력 SHA-256은 §100과 같은 `17fad1745e6c43dc0fd4d3b8593967b29928a1da5dbf6f781ca783922f68115d`, 새 wheel SHA-256은 `221300ed323af31530d80b44407c3cd81adcff12ed32ea12a930520e33f7bb71`다. offline dependency check와 실제 앱의 새 외부 Python 등록/probe/Ready를 확인했다. vLLM 대안 검사는 §100의 vllm-metal0.30.0/core `0.30.0+cpu.aiolm.media1` 별도 환경을 사용했다. CPU 이미지 검사는 llama.cpp b11460(`78651c410`), ngl0/context4096/temperature0과 정확한 해당 모델의 f16 projector다.

### 원인·수정·실제 앱 결과

| 검사 | 판정 | 실행 근거와 범위 |
| --- | --- | --- |
| Gemma4 긴 답변 뒤 첫 녹음 재사용 | pass | 같은 weights/이력을 no-thinking으로 직접 실행하면 녹음을 다시 요구했다. `enable_thinking=true`에서는 같은 이력이 정확했다. 별도 프로필의 출력1024/KV4096/temp0/seed0, automatic system off로 실제 앱의 긴 첫 답변·후속 전사가 정확하고 자연 종료했다. PP/TG는130/841,605/302. `residual101-gemma4-history.json`, `residual101-r1-ui-gemma4-thinking-long`, `gemma4-thinking-followup`. 모델별 옵션 결과이며 global default나 원래 실패를 변경하지 않음. |
| Gemma4 두 녹음 사이 padding 결함 | pass | 두 번째 합성 녹음이 더 길 때 encoder의 padding mask를 버려 첫 녹음의 padding이 새 녹음 token을 차지했다. 실제 encoder `[2,101,1536]` 중 유효77/101 frames, padding24를 제거해 `[178,1536]`과 audio tokens178을 맞췄다. 설치된 production embedding 메서드의 작은 합성 재현은 media4 exit1/media5 exit0. `residual101-padding-before/after`, `residual101-gemma4-packed-audio.json`. |
| 같은 두 녹음의 수정 전/후 실제 앱 | pass | 최초 red square/blue circle 녹음→그 녹음 후속 전사→green triangle/yellow circle의 새 녹음. media4는 새 녹음의 끝을 `yellow square`로 오답. media5는 `The green triangle is on the right. The yellow circle is on the left.`로 정확. 세 wire request body는 모두 완전히 동일하며 fetch observer는 원본 요청/응답을 변경하지 않았다. 최종 PP763/TG135,stop. `residual101-audio-wire-comparison.json`, `residual101-r1-ui-gemma4-media5-two-audios`. |
| SmolVLM500M 첨부 순서 복구 | pass | CLI의 image-first는 정확했으나 실제 앱 text-first는 `Red and blue are the same color.`로 오답. 같은 authenticated server/image/question/temp0에서 순서만 바꾼 직접 검사도 같은 차이를 보였다. 대화별 **첨부를 질문보다 먼저 전달**을 추가해 기존 text-first 기본을 유지. 실제 앱에서 red rectangle LEFT/blue circle RIGHT를 모두 정확히 답함. PP1/cache156은 앞선 직접 요청의 cache이며 cold-cache 성과가 아니다. `residual101-smol500-cli.json`, `residual101-smol500-order.json`, `residual101-r1-ui-smol500-ui-ordered`, `passive-chat-order-remove`. |
| 고정 SmolVLM256M 내용 | fail | 같은 PNG pixels/hash를 확인했다. native CLI의 jinja/built-in/default와 공식 원본 FP32 Torch CPU processor/image-first 및 text-first에서도 두 도형/좌우 내용을 정확히 답하지 못했다. 500M의 성공을256M 통과로 대체하지 않음. `residual101-smol-cli.json`, `residual101-hf-reference.json`. |
| Qwen3-VL4B 실제 MCP 후속 답변 | pass | 파생 index/동일 weight·별도 vLLM 프로필, auto tool choice true/parser **소문자 `hermes`**/output512/context4096/maxseq1/GPUmem0.45/temp0. 실제 앱 요청의 입력 `RESIDUAL-101 input`과 다른 반환 `synthetic result` 사용. 모델의 실제 structured call→앱 Approve once→사용자 Mac Yes→fixture 실행→최종 `synthetic result`. 최초 도구 요청PP192/TG37, 최종 후속PP79/TG4. `residual101-r1-ui-qwen-mcp-start`, `qwen-mcp-result`, `residual100-mcp-events.jsonl`. 실제 승인 대상 인자와 도구 실행 이벤트를 확인했으며 completed-history 직접 검사만으로 대신하지 않음. |
| 고정 Qwen3-VL2B MCP 내용 | fail | generic guidance/no tools/중립 도구 이름/temperature 변경 등7개 직접 조건에서 입력 인자를 반복했다. 실제 rendered prompt의 `<tool_response>` 안에는 반환값과 올바른 special IDs가 있었다. 공식 원본 bfloat16 Torch CPU의 canonical template/같은 completed history도 입력을 반복했다. 따라서 앱의 반환값 누락이나 Metal/4bit만의 문제로 수정하지 않음. 4B도 plain-text tool result 직접 조건은 실패했고 JSON envelope 조건만 정확했다. `residual101-qwen-matrix.json`, `residual101-qwen-actual-prompt.json`, `residual101-hf-reference.json`, `residual101-alternative-direct.json`. |
| Gemma3n 내용 | fail | strict loader/같은 WAV의 system 제거·짧은 질문·audio-first 조건과 공개8bit 정밀도 대조가 모두 `The red squares are on the left. The blue circle is on the right.`로 단수/복수 오답. 최종 media5의 실제 앱 원래4bit 모델도 PP209/TG17로 동일. 모델 답을 강제로 바꾸는 후처리나 정답 유도 지침을 추가하지 않음. `residual101-gemma3n-prompts.json`, `residual101-alternative-direct.json`, `residual101-r1-ui-gemma3n-ui-result`. |
| Gemma3n 공식 원본 대조 | unrun | 공식 원본 sidecar는401 접근 제한. 계정/license 조건을 우회하지 않았으며 full precision 원본으로 원인을 확정했다고 보고하지 않음. 공개8bit도 잘못된 index가 있었지만 strict 직접 loader는 실제 weight를 읽었다. 8bit의 실제 GUI 등록/전사는 수행하지 않았고 원래4bit GUI 결과와 구분함. |
| parser 오류의 포트 오안내 | pass | OS 텍스트 입력 과정에서 parser가 `Hermes`로 저장되어 실제 startup이 invalid parser로 실패했다. traceback의 `importing`/`reuse_port`와 `use`를 조합해 포트 충돌로 분류하던 제품 결함을 수정했다. 동일 잘못된 parser로 실제 앱 재검증 후 runtime diagnostics 안내, 정상 `hermes`로 검증 프로필 복구. `residual101-r1-ui-qwen-load-failed`, `parser-hint-fixed`. |

새 SmolVLM500M Q8 weight/projector SHA-256은 `9d4612de6a42214499e301494a3ecc2be0abdd9de44e663bda63f1152fad1bf4`/`4b2fca922e549e9b9608f4ba56f93565dd5220e935ba5570a2a864a0fcc988a6`다. 합성 PNG는 빨간 **직사각형**과 파란 원, WAV는 빨간 **정사각형**과 파란 원으로 서로 다른 입력이다. 새 WAV는 macOS 합성 음성의 green triangle/yellow circle 문장이며 original WAV는 보존했다. 모든 raw 파일·모델·개인 경로·캡처는 `tmp/macos-acceptance/`에 두었다.

### 재시작·공통 회귀와 원래 환경 보존

| 검사 | 판정 | 근거 |
| --- | --- | --- |
| 정상 Quit·같은 홈 재시작 | pass | 소유 Gemma4 PID/port 종료와 작업용 짧은 temp 정리. 전체16개 대화의 파일 hash가 동일하고 실제 UI의 automatic system off/media-before-text on 선택이 재로드됐다. Gemma4 프로필의 media5/reasoning true도 그대로. 재시작 뒤 두 녹음 이력에서 **첫** 녹음을 정확히 전사,PP815/TG184/stop. `residual101-restart-cleanup.json`, `residual101-restart-history.json`, `residual101-r2-ui-media-option-reloaded`, `gemma4-restarted-result`. |
| UI 회귀·기존 기능 | pass | 새 첨부 순서는 기존 기본/첨부 배열·frame labels·전사문·원본 identity를 유지한다. 회귀 검사에서 현재 입력과 이력, 실제 hook의 실패 snapshot Retry 동일성, 빈 대화 native 저장/새 load, checkbox 이름/설명을 확인. 관련4files/29tests, `residual101-media-order-tests-r2`. 최초 검사에서 존재하지 않는 retry helper를 호출한 test 오류는 고쳐 재실행했으며 raw red를 보존함. |
| 전체 JS·타입·lint·빌드 | pass | `residual101-final-common`145.67s, `final-typecheck`12.33s, `final-lint`6.96s, `final-build`14.64s. 기존 chunk/jsdom 진단은 보존하고 실패로 숨기지 않음. |
| Rust 전체·fmt/clippy·CLI | pass | `residual101-native-common`49.44s, all-targets/all-features. 기존 opt-in ignored를 실제 실행으로 계산하지 않음. fmt0.80s/clippy1.03s(`-D warnings`), `residual101-final-cli-smoke`0.57s. CLI smoke는 새 임시 홈의 합성 검사이며 모델 내용 검사가 아니다. |
| Python·설치 환경 | pass | compatibility6/repair5/native probe6, `residual101-python-final`, `final-repair-tests`, `final-probe-tests`. media5 offline package check/audio ownership/새 embedding checker 확인. 기존 source 문맥 변조와 all-padding을 거부하며 해시·readiness·context gate는 유지한다. |
| 최종 UI 오류 관찰 | pass | 재시작 후 대화/옵션 확인 기간의 console errors/warnings/events0. `residual101-r2-ui-observer-r2-remove`. 처음 긴 observer는 개발 빌드 이후 제거에 실패해 이 성공 근거로 사용하지 않음. |
| 원래 환경 복원·원본 보존 | pass | 원래53개 대화 hash와 모든 localStorage가 정확히 동일. 기존 vllm-metal0.30.0/Qwen3-VL2B runtime·model·프로필 옵션 유지. 정상 Save & start의 library162→164/Default37→38 외 설정 차이0. source model/wheel/connector52개 해시 검사 통과. Ready/active requests0/API off, 산술 직접 응답 `5`. `residual101-final-preservation.json`, `residual101-original-arithmetic.json`, `goal-native-audio-residual101-original-final.json/png`. |

실제 음성 후속 흐름·500M 이미지·4B MCP의 명시한 환경은 통과했지만 **원래256M/2B 모델의 내용 실패와 Gemma3n 오류는 남아 있다**. 기존 M01–M12 **7 pass/4 fail/1 unrun**과 역사적 기록을 유지하며 전체 기기 검증 통과로 표시하지 않는다. 이번 media5의 새 live 취소/Retry는 수행하지 않았고 §100의 media4/vLLM 실제 취소와 이번 합성 Retry 회귀를 구분한다. 별도 계정·Finder/Keychain/upgrade·Intel/구형 macOS·Windows/Linux·Strata·새 배포 패키지와 실제 ffmpeg 부재 조건은 기존 unrun/blocked를 유지한다. 원래 앱과 모델은 실행 상태로 남기고 검증 앱의 소유 프로세스/포트/temp는 정상 종료 후 정리했다. 원본·개인 데이터·raw를 커밋하거나 공개 업로드·원격 push하지 않았다. [복구 절차](macos-validation-recovery.ko.md)와 [Windows/Linux 인계](runtime-adapter-handoff.ko.md)에 새 검사·정확한 설정과 남은 작업을 반영했다.
