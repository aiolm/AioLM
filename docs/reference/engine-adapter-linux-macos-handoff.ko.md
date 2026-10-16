# 엔진 중립 GUI 어댑터의 Linux·Mac 후속 인계

## 기준과 현재 경계

현재 Windows production17의 고정 source는 `1c95946186afccc3161b754ae952ee47e3a63649`이며 작업 브랜치는 `codex/windows-runtime-adapter-validation`이다. 필수 조상은 `df3264bad99deb0144b947f96300e8625f7a2da5`다. 이 문서는 **진행 중인 Windows 검증에서 준비한 후속 실행 지침**이며 Windows 종료 선언이나 Linux/Mac 실행 결과가 아니다. Windows 최종 수정·production GUI 수락·설치/OS 계정 검증이 남아 있으므로 실제 이관 시 [Windows 결과](windows-device-validation-results.ko.md)의 최종 source·종료 commit·잔여 판정을 다시 고정한다. 후보 source를 최종 종료 commit으로 바꾸어 부르지 않는다.

원격 push는 수행하지 않았다. 다음 기기는 사용자가 공유한 정확한 commit을 받은 뒤 시작한다. 이전 브랜치, 공개 0.3.1 binary, Windows `node_modules`·`dist`·실행 파일·Python 환경을 복사해 최신 소스 검증으로 계산하지 않는다. 기존 checkout·동명 작업 브랜치·모델·설정·기록은 보존한다.

```sh
git status --short
git rev-parse HEAD
git merge-base --is-ancestor df3264bad99deb0144b947f96300e8625f7a2da5 HEAD
git merge-base --is-ancestor 1c95946186afccc3161b754ae952ee47e3a63649 HEAD
```

시작 전 `AGENTS.md`, 존재하는 `tmp/AGENTS.local.md`, [Windows 인계의 L/M 정의](windows-device-handoff.ko.md), [공통 adapter 계약](runtime-adapter-handoff.ko.md), [외부 runtime 계약](pluggable-inference-runtimes.ko.md), [실제 엔진 수락](provider-native-acceptance.md)을 읽는다. 이 문서의 L01–L04/M01–M04는 Windows goal의 후속 단계다. 과거 [Linux 기기 인계](linux-device-handoff.ko.md)의 L01–L11 및 Mac의 옛 M01–M12 결과와 ID 범위를 합치지 않는다.

## 공통 실행 조건

- 실제 OS/architecture·CPU·RAM·장치/driver·WebKitGTK 또는 WKWebView·도구 버전과 source를 기록한다. `package.json`, `rust-toolchain.toml`, `src-tauri/Cargo.toml`의 요구에 맞춰 대상 OS에서 의존성과 binary를 새로 만든다. lockfile을 임의로 갱신하지 않는다.
- 실제 엔진·모델·projector·bridge·환경의 revision과 전체 hash를 고정한다. 새 홈 검사는 해당 OS의 이전 경로까지 격리하고, Keychain/Secret Service·실제 업그레이드/제거는 별도 OS 테스트 계정에서 수행한다. 앱 홈 변경만으로 OS 계정 검증을 대체하지 않는다.
- 고정 production 앱을 만든 **뒤** 새 합성 flag와 실제 개인 엔진 flag를 생성한다. 두 앱 binary와 고정 source에 없음을 확인하고, 실행 파일/entry point → 실제 help → 공통 GUI → 새 프로필 → fresh model probe/Ready → 실제 argv → 응답을 확인한다. 합성 echo는 실제 추론으로 계산하지 않는다.
- 설치 파일과 standalone 실행 파일의 전체 해시를 각각 남긴다. Windows17의 MSI/NSIS GUI는 Tauri CLI2.11.4가 bundle marker를 각각 MSI/NSS로 변경해 standalone과 정확히 3바이트 달랐다. 읽기 전용 추출·명시 marker의 전체 bytes 대조 근거는 Windows 결과에 있다. 다른 OS에서도 패키징 차이는 실제 의존성 소스와 파일 차이로 조사하고, 차이를 무시하거나 설치 실행을 생략한 채 설치 성공으로 판정하지 않는다.
- argv·환경·cwd·encoding·artifact 변경, help cache 무효화/diff, 미해석 arity·반복·positional, probe/탐색 경합·취소·실패 복구를 각각 검사한다. 이전 설정을 조용히 버리거나 도움말만으로 API 능력을 확정하지 않는다.
- 전송 조사에서는 원래 질문·첨부 bytes/순서·실제 request의 기본값 사용 여부를 기록한다. SSE DONE 후 reader 정리는 사용자 중지와 구분한다. system prompt·인증·원본 body는 필요한 메모리 범위에서만 다루고 익명화한 hash·숫자 지표를 남긴다. cache/RNG·HTTP 전체 wire가 같다고 추정하지 않는다.
- raw는 `tmp/linux-acceptance/` 또는 `tmp/macos-acceptance/`, 진행 기록은 그 안의 `progress.md`, 공개 결과는 OS별 reference 문서에 둔다. `pass/fail/unsupported/unrun/blocked`, 정확한 source/engine/model, 근거, 수정, 다음 실행과 차단 조건을 연결한다.

## Linux L01–L04

| ID | 실제 실행과 판정 근거 | 이어갈 조건 |
| --- | --- | --- |
| L01 | 같은 source의 공통 자동 검사·native GUI/CLI/package를 새로 빌드한다. 새 help flag의 schema/저장/실제 argv와 탐색·probe 경합을 검사한다. Unix cwd/locale, Unicode·공백·따옴표·역슬래시와 case-sensitive 경로를 Windows와 별도로 확인한다. | GTK/WebKitGTK와 프로젝트 의존성을 실제 배포판에 준비하고 실행 명령·exit·raw를 남긴다. 기존 Linux 결과를 최신 source의 성공으로 복사하지 않는다. |
| L02 | 고정 llama.cpp CPU/지원 GPU, native Linux vLLM, 지원 기기의 원래 Strata 및 실제 개인 엔진에서 help→GUI→프로필→fresh probe→Ready→추론/usage→중지/Retry→재시작/종료를 수행한다. MCP 실제 반환값 후속, 문서/RAG·embedding·STT 역할, 인증된 gateway 라우팅과 멀티 세션도 연결한다. | 실제 GPU/driver/ABI·모델 능력을 별도로 확인한다. Windows의 Strata 모델 shard revision `5348543e0147355ac9cbcb031184a3546350988e`와 엔진 `296b59d2f73c8f04a805df29c2fa97655adace78`를 재현하려면 Linux native 실행 파일·라이브러리를 새로 준비한다. Windows binary/venv는 사용하지 않는다. |
| L03 | 사용 가능한 실제 X11/Wayland desktop에서 IME·clipboard·portal/picker·tray 유/무·알림·Secret Service·패키지 설치/업데이트/제거를 검사한다. CSV/XLSX·공유 미리보기·이력 재로드와 새 홈 runtime bundle→Ready→실제 추론을 확인한다. | headless/합성/자식 PATH에서 도구를 뺀 성공은 전체 desktop·별도 계정·SDK 파일 부재 검증과 구분한다. 인증값·개인 기록·공유 게시를 임의 전송하지 않는다. |
| L04 | 먼저 이번 source의 fail을 재현·원인 조사·최소 수정·관련 검사·실제 GUI 재검증으로 처리한다. source와 OS별 결과·잔여 조건을 고정하고 Mac에 전달한다. | 공통 소스 수정은 아래 연결표에 따라 Windows 관련 W/G 재검증을 실행한다. Linux 완료 commit과 Windows 재검증 source가 다르면 그 차이를 명시한다. |

Strata의 원래 32-token 산술 요청과 SmolVLM의 원래 색·도형 질문은 Windows에 내용 fail이 남아 있다. Linux에서 모델·질문·제한을 바꾼 성공으로 이전 fail을 지우지 않는다. 실제 조건의 차이와 각 결과를 병기하고, 실행/전송 계약의 결함과 모델 내용 실패의 원인을 증명 없이 합치지 않는다. Linux에서 MLX/Metal을 지원으로 선언하거나 Windows의 WSL 결과를 native OS 성공으로 옮기지 않는다.

Strata17 원래 A04의 1,024-token 요청은 reasoning만 생성한 뒤 DONE에 도달해 기존 content 기반 관찰기의 취소 조건에 도달하지 않았다. 별도 동일 요청에서 실제 reasoning 생성 중 HTTP 요청 중단·서버 유지·정상 stop/소유 정리를 확인했지만 엔진 내부 취소 수신 확인은 증명하지 않았다. 후속 OS는 요청 body·실제 중단 trigger·DONE/finish·서버 상태를 함께 기록하고, 이 한정 성공을 GUI 중지/Retry·원래 A04·정답 품질의 pass로 바꾸지 않는다.

## Mac M01–M04

| ID | 실제 실행과 판정 근거 | 이어갈 조건 |
| --- | --- | --- |
| M01 | 받은 Windows/Linux 변경의 자동 검사·migration·기존 프로필/설정·entry point/help/schema/argv·등록/제거/재등록·탐색 취소를 native Mac에서 확인한다. | 정확한 수신 commit과 실제 shell/Python architecture를 기록한다. 새 flag는 Mac production 고정 뒤 만든다. |
| M02 | 지원 기기의 llama.cpp CPU/Metal·vllm-metal·별도 MLX 환경에서 실제 WKWebView의 새 추론·usage·미디어 순서/저장/재로드·MCP·gateway·RAG/STT 대상 분리·취소/Retry·정상 종료를 확인한다. | 원래 모델·환경과 호환 환경을 별도 등록/프로필로 보존한다. 관리형 기본 upstream이나 서로 다른 venv를 덮어쓰지 않는다. |
| M03 | 아래 MAC-R01–R13을 각자 판정하고 최신 production/계정/물리 장치 조건을 확보해 실행한다. | 과거 pass는 당시 source/모델 범위로 유지한다. 필요한 장비가 없으면 정확한 조건과 미실행을 남긴다. |
| M04 | 최종 source의 production APP/DMG·실제 GUI·사용자 데이터·원래 환경/실행 복원을 확인하고 종료 commit과 OS별 잔여를 고정한다. | 공통 변경은 Windows와 Linux 관련 항목을 다시 검사한다. Mac 성공을 다른 OS의 성공으로 복사하지 않는다. |

## MAC-R01–R13의 구체적 재개

원래 입력·상태·복구 절차의 기준은 [Mac 추가 검증 목록](macos-device-validation-remaining.ko.md)과 [Mac 검증 복구](macos-validation-recovery.ko.md)다. 아래는 다음 실행을 연결하며 새 Mac 결과를 선언하지 않는다.

| ID | 다음 실제 검사 |
| --- | --- |
| R01 | 유효한 원본 FP 계산 조건에서 Gemma3n 긴 문장 전체·관사를 대조한다. 원본/파생 snapshot과 processor·weight hash를 구분한다. |
| R02 | 같은 원래 4bit 모델의 새 음성 세 개를 실제 앱에서 전부 전사하고 전체 문장을 대조한다. 기존 세 실패를 단어 일부 성공으로 바꾸지 않는다. |
| R03 | 원래 SmolVLM256 질문을 추가 지침 없이 실행하고 여러 view·첨부 순서·실제 request 조건을 대조한다. Windows b11617 결과와 Mac의 별도 호환 b11460 결과를 합치지 않는다. |
| R04 | 실제 MCP 승인 대기 중 개발 frontend 재로드를 시도해 승인·RPC·소유 자식·이력 상태를 확인한다. 재로드 시도 실패와 원인 미확정 기록을 유지한다. |
| R05 | 최종 호환 runtime에 아직 실행하지 않은 실제 모델·공통 기능을 순서대로 연결하고 각 원본/호환 환경의 hash와 옵션을 기록한다. |
| R06 | 수신한 최종 source로 arm64 APP/DMG를 새로 만들고 실제 production GUI를 확인한다. Windows installer는 Mac 근거가 아니다. |
| R07 | 최종 Mac runtime을 export하고 새 홈에서 import→probe→Ready→실제 추론/usage→정상 종료한다. dylib/상대 로딩과 payload hash를 확인한다. |
| R08 | 별도 Mac 테스트 계정에서 최초 실행·Keychain·실제 과거 release 업그레이드를 수행한다. 기존 사용자 계정의 자료를 교체하지 않는다. |
| R09 | Finder의 자연스러운 설치/실행과 launchd PATH·quarantine 조건에서 확인한다. 격리 shell 실행이나 보안 설정 해제로 대체하지 않는다. |
| R10 | ffmpeg가 실제로 없는 확보된 환경에서 안내·명시적 전처리 거부/복구를 검사한다. 자식 PATH 변경만으로 파일 부재를 주장하지 않는다. |
| R11 | 실제 VoiceOver·키보드 전체 여정, 작은 창, 미확인 테마·오류/로딩/취소 상태 대비를 확인한다. DOM 단위 검사와 구분한다. |
| R12 | 실제 Intel 및 최소/구형 지원 macOS 기기에서 해당 지원 범위를 검사한다. Rosetta/hosted GPU의 결과를 물리 장치 지원으로 확대하지 않는다. |
| R13 | Mac을 실제 지원하는 개인 엔진을 앱 고정 뒤 새 flag로 준비해 help→GUI→프로필→argv→응답/usage와 수명주기를 확인한다. 현재 Windows/Linux 대상 원본 Strata를 Mac 필수 지원으로 바꾸지 않는다. |

## 공통 수정의 이전 OS 재검증 연결

| 바뀐 경계 | Windows에서 다시 확인할 흐름 | 후속 OS 기록 |
| --- | --- | --- |
| schema/parser/help cache·entry point·binding | W02/W03/W07 및 G01–G05: 새 flag, alias/arity/negative/repeat/subcommand/positional, cwd/encoding, identity 변경/diff와 hash 거부 | Linux L01/L02, Mac M01/M02의 새 source·실제 argv와 보존 결과 |
| 프로필·세션 편집/이름·프로젝트 binding | W03/W06: D79의 저장/로드 후 편집하지 않은 세션 이동과 실제 미저장 편집 보호; D80의 답변/embedding/STT 이름과 실제 URL/model/auth 보존 | Linux L02/L03, Mac M01/M02의 역할·이력·gateway 라우팅 |
| HTTP/SSE·media·MCP·RAG/STT | W04–W06: 원래 질문/첨부 해시·순서, usage, 내용, 승인/거부/호출 중 취소·실제 반환값 후속, Retry와 재로드 | Linux L02, Mac M02 및 영향받는 R01–R05 |
| 프로세스·port·staging·복구 | W04/W07/W08: 사전 관찰 소유 생성 식별자/포트, 정상 Unload/Quit, 중단 후 복구, 확인 불가 기존 staging 보존 | Linux L01–L03, Mac M01/M02/M04의 native 수명주기 |
| bundle·패키지·OS 저장소/통합 | W08: 새 홈 bundle 실제 추론과 별도 Windows 계정의 설치/업그레이드/제거·Credential Manager. 정적 MSI 검사와 실제 설치를 구분 | Linux L03/L04, Mac M03/M04 및 R06–R12 |

각 수정은 code/test/doc을 필요한 경로만 검토·커밋하고, 이전 OS 재검증의 source·관련 검사·실제 GUI 근거를 그 수정 commit에 연결한다. 필수 실제 검사가 남아 있으면 인계 문서나 자동 검사 성공만으로 전체 완료를 선언하지 않는다.
