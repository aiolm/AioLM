# 엔진 중립 GUI 어댑터의 Linux·Mac 후속 인계

## 기준과 현재 경계

Windows GUI 어댑터 검증의 **종료 commit은 `53df1491cbb6dc790e9594221c3191a6c210937e`**다. production23의 고정 제품 source는 `908a2fb6bd5bdb4742eb4db6e8f6ac9e352956c1`이며 작업 브랜치는 `codex/windows-runtime-adapter-validation`이다. 필수 조상은 `df3264bad99deb0144b947f96300e8625f7a2da5`다. 종료 commit은 최종 수락 결과를 포함하며 이후 이 인계 문서의 hash 고정은 제품 변경이 아니다. 수신 기기는 종료 commit과 이 최종 인계 문서를 포함한 후속 문서 commit을 함께 받는다. [Windows 결과의 최종 수락](windows-device-validation-results.ko.md)에 따라 G01–G07은 pass, W01–W08은6개 pass/원래 W04·W05 내용2개 fail이다. 어댑터 범위에 필수 구현·실제 Windows 검증의 blocked/unrun은 남아 있지 않다. 두 품질 실패는 WIN-Q01/WIN-Q02로 보존하며 이 문서는 Linux/Mac 실제 실행 결과가 아니다.

아래 production19–23 및 D81–D87 절은 당시 checkpoint의 구현·검증·남은 작업을 보존한 기록이다. 그 절의 대기/미실행·종료 commit 미지정·goal 미완료 문구를 최신 상태로 해석하지 않는다. 최신23의 VM 전송 허용과 설치 인증은 이미 제공됐으며 반복 요청하지 않는다. 최종 상태는 위 종료 기준과 Windows 결과의 최종 수락 절을 따른다.

원격 push는 수행하지 않았다. 다음 기기는 사용자가 공유한 정확한 commit을 받은 뒤 시작한다. 이전 브랜치, 공개 0.3.1 binary, Windows `node_modules`·`dist`·실행 파일·Python 환경을 복사해 최신 소스 검증으로 계산하지 않는다. 기존 checkout·동명 작업 브랜치·모델·설정·기록은 보존한다.

```sh
git status --short
git rev-parse HEAD
git merge-base --is-ancestor df3264bad99deb0144b947f96300e8625f7a2da5 HEAD
git merge-base --is-ancestor 908a2fb6bd5bdb4742eb4db6e8f6ac9e352956c1 HEAD
git merge-base --is-ancestor fdb48af66d66dff3f4b607c11ee28ba7c61830f0 HEAD
git merge-base --is-ancestor 53df1491cbb6dc790e9594221c3191a6c210937e HEAD
```

시작 전 `AGENTS.md`, 존재하는 `tmp/AGENTS.local.md`, [Windows 인계의 L/M 정의](windows-device-handoff.ko.md), [공통 adapter 계약](runtime-adapter-handoff.ko.md), [외부 runtime 계약](pluggable-inference-runtimes.ko.md), [실제 엔진 수락](provider-native-acceptance.md)을 읽는다. 이 문서의 L01–L04/M01–M04는 Windows goal의 후속 단계다. 과거 [Linux 기기 인계](linux-device-handoff.ko.md)의 L01–L11 및 Mac의 옛 M01–M12 결과와 ID 범위를 합치지 않는다.

## 공통 실행 조건

### 2026-10-25 Linux 수정의 수신과 재검증

Linux 검증은 [Linux 기기 결과](linux-device-validation-results.ko.md)에 별도로 기록하며 아직 전체 완료가 아니다. 아래는 검토·커밋한 공통 변경의 재실행 연결이다. Windows production23과 과거 Mac 결과의 판정은 유지한다. Linux의 실제 성공도 그때 고정한 GUI·CLI·runtime·모델 해시의 범위이며 Windows/Mac pass가 아니다. 수신자는 이 표의 수정과 후속 결과 문서 commit을 함께 받고 정확한 HEAD·작업 트리·배포 파일 해시를 기록한다.

| 수정 commit | 새 동작과 Windows 재검증 | Mac 연결 |
| --- | --- | --- |
| `37c0343` | Linux 알림은 앱 소유 연결 하나/전체5초/동시 제출 거부/자동 재전송 없음으로 즉시 소실을 막는다. 새 `send_desktop_notification` IPC가 Windows에서는 같은 공식 plugin builder로 전달된다. W07/W08/G07: 권한·오류/재시도·카테고리·네 언어·실제 표시/정상 종료를 재검증한다. Linux 고정19의 발신자 유지·정상Close는 확인했으며 사람 배너 확인은 대기 중이다. | M01/M02/M04, MAC-R06/MAC-R11의 실제 plugin 표시·권한/오류·정상 종료. Linux 성공을 Mac pass로 옮기지 않는다. |
| `e454065` | 세션 summary URL에서 실제 port 표시. W03/W06: 모델·embedding·STT 세션 전환, 이름과 실제 URL/model/auth 보존. | M01/M02, R05/R06 |
| `cf99641` | Responses/Anthropic SSE가 native usage를 요청·보존하고 없는 count는 명시 오류로 끝낸다. W04/W06/W07, G04/G05: 세 protocol의 같은 요청, JSON/SSE, auth/alias, 취소 lease, 후속 응답과 API/모델 독립 종료. | M02, R05/R06 |
| `b9668ae` | 실패 probe 출력은 진단으로 남기고 장치/flag 근거로 쓰지 않는다. Indexed 장치 ID를 중복 없이 센다. W01/W04/W08: 성공·실패·복구와 실제 지원 GPU 장치 표시. | M01/M02, R12 |
| `befe3a4` | Python help의 bounded stdout/stderr·실패 원인·strict UTF-8. Help에만 `-X utf8`/`PYTHONIOENCODING=utf-8`; managed `-I`와 external 환경 구분 유지. W01/W03/W07: 실제 CPython pipe Unicode, 오류/잘림/취소·자손 정리. Windows native vLLM/MLX 지원을 추가하지 않는다. | M01/M02, R05/R07/R12 |
| `4cc7de2` | 런타임 선택만으로 false dirty/discard를 만들지 않고 실제 편집은 보호한다. Input/select 오류를 ARIA 상태·설명에 연결한다. W02/W03/W06/W08, G04–G07: 첫 저장/Enter, 진짜 미저장 편집, 포커스·작은 창·키보드·오류 해제. | M01/M02/M04, R06/R11 |
| `69a463b` | 조합 종료 뒤 Enter가 비조합/key13으로 전달돼도 경로 Load·프로필 생성/이름 변경을 실행하지 않도록 기존 Chat의 상태 기반 보호를 공통으로 사용한다. W02/W03/W04/W08, G04–G07: 직접 한글 조합 첫 Enter 보존→키 해제 뒤 다음 Enter 동작, dirty/discard·명시 버튼·붙여넣기/blur·Chat 전송 회귀. Linux 실제 실패와 자동 회귀 통과를 구분하며 새 production 직접 입력은 결과 문서의 현재 판정을 따른다. | M01/M02/M04, R06/R11의 실제 WKWebView IME·VoiceOver·포커스 |
| `b3e1017` | Help identity v5의 선언 alias→target, 같은 파일 한 번 해시, `KEY=VALUE` 해석·256 artifact/byte 상한. W02/W03/W07, G01–G05: retarget/stale/diff/보존, Unicode argv와 예산 거부. Strata ELF 검사는 Linux에서만 실행하며 원본 pin의 Mac 지원을 선언하지 않는다. | M01/M02, R13의 Mac 지원 개인 엔진 |
| `c00fd97` | Parser6은 깊은 옵션 설명의 Markdown·JSON/Enum·제목·flag/`--` 예시를 새 위치 인자로 읽지 않는다. W02/W03/W07, G01–G05: 실제 Python help·stdout/stderr·COLUMN0·위치 인자/alias/arity, 이전 수락의 stale·저장 값과 민감 값 가림 보존. | M01/M02, R05/R13의 실제 도움말 탐색·수락·실행 |
| `67d256e` | Parser7은 `{one,two} or a custom name`의 prose를 tuple/닫힌 선택지로 확정하지 않으며 전체 선택지의 공백 이름은 한 값으로 읽는다. W02/W03/W07, G01–G05: 별도/equals/optional·진짜 tuple·metadata 충돌, 이전 수락 stale·저장 값 보존과 실제 재탐색/실행. | M01/M02, R05/R13의 실제 엔진 도움말/옵션 |
| `d3fce2f` | 실패 help의 종료/시간초과/잘림/인코딩·stdout/stderr 발췌를 기존 오류 상세에 남기고 게시/수락은 거부한다. W02/W03/W07, G01–G05: 4KiB UTF-8 경계·실제 실패/재시도·진단에 cancelled 단어 포함·진짜 취소/늦은 결과·wizard 초안 보존. | M01/M02, R05/R11/R13의 실패 도움말 안내/복구 |
| `7c1b8a5`, `347c7f7` | 메인 창의 native WindowEvent에서 실제 OS 파일 drop만 짧게 유효한 UUID selection을 만들며 main webview에서 claim/read를 순서대로 처리한다. 취소/만료된 늦은 selection은 새 reader grant를 덮어쓰지 않는다. W04/W06/W08: OS drop·Unicode/여러 파일·개수/모델능력 거부·picker 대안·대화 전환/취소·숨김/overlay/DPI와 draft/이력 보존. | M02/M04, R06/R09/R11의 실제 Finder drop/VoiceOver·WKWebView·배율 |
| `220d1f9` | Ready 후 아직 소유한 실제 process image를 저장해 `exec` entry point도 안전하게 stop한다. W04/W07/W08: interpreter redirector·실제 image 조회 실패·잘못된 image의 종료 거부·정상 stop/restart/staging. | M01/M02/M04, 실제 macOS process-image 조회와 R07/R13 |
| `e99e9fd` | Provider 검사는 생성 content/reasoning 후 열린 stream을 취소한다. Role-only/empty/malformed/terminal은 거부하며 headers/body/recovery에 한 deadline을 쓴다. 최종 cleanup을 summary에 반영한다. W01/W04 및 D83: 실제 socket 종료·healthy follow-up, 원래 token/모델/입력과 실패 exit 보존. | M01/M02, R05/R13의 실제 엔진 |
| `e829df6` | Typed 잠금/키 없음과 백업 저장·복원·복사의 복구 안내를 구분하고 native 상세/비밀은 숨긴다. W06/W08: Credential Manager와 파일·clipboard·browser 오류, 취소·재시도, 4개 언어. | M02, R08/R11의 별도 계정 Keychain |
| `8454091`, `25fb4ce` | Linux AppImage pinned runtime의 인스턴스별 추출·정리와 prefix 검증, DEB `libgomp1`. 공통 패키지 script 검사 후 Windows GUI/CLI/NSIS/MSI를 새로 검증한다. 비 Linux provisioning은 그대로다. | M01/M04, R06/R08/R09의 새 APP/DMG. Linux bwrap/sysctl을 Mac에 적용하지 않는다. |

기본 도구 버전을 확인하고 `npm ci --ignore-scripts`, `npm rebuild esbuild`, typecheck·lint·전체 `npm run test:unit`·production package, Rust fmt·전체 all-target/all-feature clippy/test·no-default-feature check, runtime adapter Python 검사를 대상 OS에서 실행한다. Default suite의 ignored 항목을 실제 실행으로 세지 않는다. 실제 CPython help 대조는 native interpreter를 `AIOLM_TEST_PYTHON`으로 지정해 아래 명령을 별도 실행한다.

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib providers::python_env::tests::real_python_server_help_uses_utf8_and_preserves_interpreter_isolation -- --ignored --exact --nocapture
npm run test:provider-runtime
```

실제 vllm-metal/MLX는 [native 수락 절차](provider-native-acceptance.md)와 explicit Rust live gate를 별도로 실행한다. CLI harness는 앱 gateway·history·WKWebView를 우회하므로 이를 GUI 성공으로 쓰지 않는다. 새 홈은 [수동 격리 명령](provider-native-acceptance.md#isolated-manual-commands)을 따르고, Mac GUI·Keychain·설치/업그레이드는 별도 OS 계정에서 수행한다. 새 source의 VoiceOver/IME와 실제 창 조작은 component ARIA 검사로 대체하지 않는다.

아래 M01–M04와 MAC-R01–R13은 계속 Mac 작업이다. R01–R04의 과거 fail, R10의 blocked와 나머지 unrun을 Linux 실행으로 닫지 않는다. 원래 Windows WIN-Q01/WIN-Q02와 Linux의 별도 품질 실패도 입력·모델·token 한도를 유지해 구분한다.

Windows D83 검사 commit은 `fdb48af66d66dff3f4b607c11ee28ba7c61830f0`이며 제품 binary 변경 없이 공통 CLI 수락 검사의 reasoning 취소와 독립 검사 실행을 수정했다. 후속 기기는 이 수정이 포함된 최신 검사 소스를 사용해 같은 원래 모델/질문/32·1024 한도를 유지하고, reasoning 또는 content 출력 후 실제 HTTP abort/서버 정상 상태와 엔진 내부 취소 ACK를 별도로 기록한다. A03의 답변 실패가 A04–A07을 가리지 않게 하되 실제 선행 조건이 실패한 항목은 이유 있는 unrun으로 남기고 전체 실패 exit를 보존한다. `npm run test:scripts`의 실제 연결 회귀와 [D83 결과](windows-device-validation-results.ko.md)를 함께 확인한다. Windows에서 남은 산술/미디어 fail을 새 검사 성공으로 지우지 않는다.

W02/W08은 별도 Windows VM과 OneDrive에 연결하지 않은 로컬 테스트 계정에서 실제 검증했다. 최신23의 허용된9개 파일은 게스트 전체 hash·크기가 고정본과 일치했다. portable의 원래 CPU/Qwen 추론·Vault 동일 여부, NSIS·MSI 새 설치/설치본 추론/정상 종료/데이터 보존 제거와 MSI 재시작·공식0.2 MSI→최신23 패키지 업그레이드/구버전 등록 제거/실제 추론/정상 종료/76개 파일 보존 제거는 명시 범위에서 pass다. 원래0.2→고정20 NSIS의 schema12→14/프로필/이력/Vault 이전은 별도 근거이며, MSI 업그레이드에서 같은 schema 이전을 다시 실행했다고 주장하지 않는다. 최초 취소·TPM 조회 오류·MSI 경로 오류와 인증 취소/1602 기록도 보존했다. MSI는 같은 UpgradeCode·서로 다른 ProductCode·`ALLUSERS=1`이며 컴퓨터 전체 설치를 새 사용자 계정만으로 격리하지 않는다. 후속 OS도 실제 패키지 범위와 기존 데이터/설치의 격리 범위를 확인하고, 정적 패키지 대조를 실제 설치 성공으로 계산하지 않는다.

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

Strata의 원래 32-token 산술 요청과 SmolVLM의 원래 색·도형 질문은 Windows에 내용 fail이 남아 있다. Linux에서 모델·질문·제한을 바꾼 성공으로 이전 fail을 지우지 않는다. 실제 조건의 차이와 각 결과를 병기하고, 실행/전송 계약의 결함과 모델 내용 실패의 원인을 증명 없이 합치지 않는다. Linux에서 관리형 mlx-vlm·vllm-metal 어댑터의 지원을 선언하거나 Windows의 WSL 결과를 native OS 성공으로 옮기지 않는다.

Strata17 원래 A04의 1,024-token 요청은 reasoning만 생성한 뒤 DONE에 도달해 기존 content 기반 관찰기의 취소 조건에 도달하지 않았다. 이 원본 실패는 보존한다. D83은 그 검사 결함을 수정한 커밋의 같은 원래 요청으로 A04 HTTP abort·서버 유지·정상 stop/소유 정리를 pass로 추가했다. 해당 실행 자체의 엔진 내부 취소 ACK를 증명한 것은 아니며, 별도18 native STOP→DONE ACK 근거와도 실행을 구분한다. 후속 OS는 요청 body·실제 중단 trigger·DONE/finish·서버 상태를 함께 기록하고, 이 한정 성공을 이전 실행이나 정답 품질의 pass로 바꾸지 않는다.

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
| CLI 수락 검사·취소 reader | W01/W04: D83 reasoning/content 취소·종료 후 취소 거부·실제 HTTP 연결 종료·서버 보존, 원래 답변 실패/전체 exit 보존, 실패한 선행 조건의 unrun과 hash 거부 | Linux L01/L02, Mac M01/M02; 합성 오답 대조와 실제 엔진을 구분하고 제품 binary/검사 source·파일 hash를 각각 기록 |
| 프로세스·port·staging·복구 | W04/W07/W08: 사전 관찰 소유 생성 식별자/포트, 정상 Unload/Quit, 중단 후 복구, 확인 불가 기존 staging 보존 | Linux L01–L03, Mac M01/M02/M04의 native 수명주기 |
| bundle·패키지·OS 저장소/통합 | W08: 새 홈 bundle 실제 추론과 별도 Windows 계정의 설치/업그레이드/제거·Credential Manager. 정적 MSI 검사와 실제 설치를 구분 | Linux L03/L04, Mac M03/M04 및 R06–R12 |

각 수정은 code/test/doc을 필요한 경로만 검토·커밋하고, 이전 OS 재검증의 source·관련 검사·실제 GUI 근거를 그 수정 commit에 연결한다. 필수 실제 검사가 남아 있으면 인계 문서나 자동 검사 성공만으로 전체 완료를 선언하지 않는다.


## D81 실행 전 검사 취소의 공통 후속 검증

Windows 수정 source `cad44fd28819ad54f49ff9735cd0de8ca15f4006`은 요청별 preflight owner·정상 취소·앱 종료 정리와 진행 표시, 취소 이후 늦은 성공의 저장/실행 차단을 추가한다. cfg-only 기존 IPC도 보존한다. Windows production18의 원래 합성15초 probe 취소/다른 모델 복구, 최소360×520 논리 픽셀 창, 동시에 실행 중인 실제 개인 엔진 보존/답변 근거는 Windows 결과 문서의 D81에 연결돼 있다. 이 commit은 Windows 전체 완료 commit이 아니다.

Linux L01/L02와 Mac M01/M02는 각 OS에서 새로 빌드한 production으로 다음을 확인한다. 실제 pending 검사에 진행 설명과 취소가 나타나고, 취소하면 해당 subprocess/자손만 정상 종료돼야 한다. 설정·프로필·기존 세션과 다른 실행 엔진의 생성 식별자/포트/응답을 보존한다. 원래 지연 이후 늦은 결과가 저장·실행·다른 모델 capability를 오염시키지 않는지 확인한다. 다른 모델로 새 owner를 만들어 재검사→Ready→실제 argv→응답→정상 언로드를 수행한다. 최소 창과 키보드/스크린리더의 진행 상태·취소/Retry도 직접 확인한다. 앱 정상 종료 중의 pending 검사 정리를 포함한다. 합성 취소와 실제 엔진 추론은 각각 별도 판정한다.

후속 OS에서 이 공통 경계를 수정하면 Windows W03/W04/W07 및 G04–G07의 같은 취소·복구·다른 대상 보존을 새 source로 다시 검사한다. `launch_jobs` owner/queued cancellation, `preflight_launch` 기존 호출 호환/종료 시 거부, ModelSettingsProvider의 늦은 성공 무효화와 Dialog 진행/취소 관련 자동 검사를 함께 연결한다. 단순 timeout 확대나 validation/readiness 제거로 통과시키지 않는다.


## D82 옵션 편집 후 첫 저장 클릭의 공통 후속 검증

공통 GUI 수정 source `4a7fa53daf595c36b5b0e50d26f12d5e61afaaf2`는 이미 입력 변경에서 파싱/commit한 값을 blur에서 다시 commit하지 않도록 한다. 중복 cfg 변경이 pointer down과 click 사이에 비동기 검증을 재시작해 SaveAs를 disabled로 만들던 결함이다. 검증·오류·Ready 조건은 보존한다. 실제 설정 대화상자의 red→green 회귀와 전체 UI2151개, production19의 합성·실제 개인 엔진에서 focused input→첫 pointer SaveAs→새 프로필/재열기→실제 argv/응답 근거는 Windows 결과 문서 D82에 연결한다. 이 source는 Windows 전체 종료 commit이 아니다.

Linux L01/L02와 Mac M01/M02에서 일반 text·수치·JSON textarea·반복/복수 값의 편집 후 검증 완료→첫 pointer 저장과 키보드 이동/저장을 확인한다. 유효하지 않은 중간 입력은 저장을 계속 막아야 하고, 실제 변경은 새 검증을 수행해야 한다. 다른 탭 이동·미저장 보호·저장/재열기·기존 프로필/이력·런타임/모델 binding도 보존한다. 이 경계의 공통 코드를 후속 OS에서 수정하면 Windows W03/G03–G06의 같은 첫 클릭/보존/argv 흐름과 관련 자동 회귀를 새 source로 다시 실행한다. 저장 차단 제거나 검증 무시로 통과시키지 않는다.


## production19 인계 checkpoint와 Windows 재개 지점

현재 고정 제품 source는 `4a7fa53daf595c36b5b0e50d26f12d5e61afaaf2`다. 이후 익명 결과/인계 문서 commit을 포함한 정확한 수신 HEAD도 기록한다. 이 source는 Windows 전체 종료 commit이 아니다. 같은19 binary에서 합성/실제 개인 엔진의 첫 저장·재열기·실제 argv/응답, 같은 runtime의 v2 stale/diff/미해석 값 복구, 원래 Strata의 동일 설정/prompt/Windows argv·실제 응답, 두 홈의 loaded normal Quit/데이터 보존, SDK가 자식 PATH에 없는 별도 새 홈에서의 실제 GUI CPU bundle import/추론까지 확인했다. 합성 parser와 실제 LLM을 구분한 원본 receipt/해시는 Windows 결과 문서의 production19 절에 있다.

W02/W08의 별도 VM은 설치 전 체크포인트·파일 복사 후 게스트 preflight까지 pass다. 실제 Windows11 Home build26300에서 payload10개의 전체 hash 일치, 기존 AioLM 설치/프로세스/기본 데이터 폴더 없음을 확인했다. 고정19 NSIS 새 설치 완료·실제 최초 onboarding/폴더 picker/채팅 진입·설치된 GUI/CLI의 전체 payload hash 일치와 CLI help exit0까지 한정 pass다. 실제 응답/저장·재로드/정상 종료·기존 설치 upgrade/remove·Credential Manager·설치 identity의 OS 통합/알림의 수락 판정은 여전히 남아 있다. Windows의 원래 Strata32/1024 content 실패와 SmolVLM 내용 실패도 유지한다. 원래 모델/질문/제한을 바꾸거나 실패를 unsupported로 바꾸지 않는다. Linux/Mac 기기에서 실행했다고 Windows 설치 성공으로 계산하지 않는다.

Linux L01–L04와 이후 Mac M01–M04/R01–R13은 위 source 및 문서 checkpoint를 받은 뒤 각 OS에서 새로 빌드해 실행할 수 있도록 준비한다. 실제 이관/종료 commit은 필수 Windows 잔여의 상태를 확인해 다시 고정한다. D81/D82 또는 schema/help/protocol/저장·프로세스/패키지 경계에 후속 OS의 공통 수정이 생기면 위 재검증 표의 Windows W/G를 연결한다. Windows의 전부를 반복한 것으로 추정하지 않고 변경 파일·해당 기존 근거·새 source의 관련 실제 검증을 함께 남긴다.


## D84 Windows 창 배치 수정과 production20 후속 인계

현재 제품 source는 `bf48ba4366e1dd4f64a7ed23191190d1d0e55ca9`다. Windows 전용 startup에서 작업 영역보다 큰 최초 창만 표시 전 최대화하며, 기존 크기가 들어가는 큰 화면에서는 일반 창을 유지한다. Linux/Mac 시작 동작을 변경한 공통 화면 정책이 아니다. 실제 Windows VM1024×720 작업 영역의 red→수정20 자동 최대화/하단 버튼 표시, 호스트3840×2064의 일반 창/새 홈 onboarding, 같은 원래 CPU/runtime/model·프로필/이력·추론/usage·정상 종료/소유 자원 정리 근거가 Windows 결과 D84 절에 있다. 고정20 GUI/CLI/NSIS/MSI 전체 hash와 NSIS/MSI 내부 GUI 전체 hash도 그 절을 따른다.

Windows 종료 commit은 아직 지정하지 않는다. 별도 VM의19 실제 NSIS 새 설치·원래 CPU import/응답·저장·재열기·정상 종료와20 standalone의 양쪽 화면/같은 프로필/실제 응답은 한정 pass다. 고정20의 실제 설치본 수락, 원래0.2 NSIS/MSI upgrade·MSI 새 설치·remove·Credential Manager·설치 identity OS 통합/알림 및 원래 Strata32/media 내용 실패는 남아 있다. Linux/Mac에서 대신 실행해 Windows pass로 바꾸지 않는다.

Linux L01/L02와 Mac M01/M02에서 해당 OS의 최초 표시·작은/큰 화면·taskbar/dock/work area·배율/다중 monitor·기존 설정/프로필/이력 보존을 별도 기기에서 확인한다. Windows 전용 구현을 추정 이식하지 않고 실제 OS 결과에 따라 판단한다. 후속 OS의 공통 window/startup 변경이 필요하면 Windows W02/W07/W08/G07의20 작은/큰 화면·기존 데이터·실제 엔진 시작/정상 종료를 새 source로 재검증한다. L03/L04·M03/M04·R01–R13의 나머지 구체 작업과 이전 source의 재검증 연결은 기존 인계를 유지한다.

고정20의 VM NSIS 같은 버전 유지 관리 재설치도 실제 완료했다. 설치된 GUI/CLI의 전체 hash가 앞의 고정20 NSIS payload와 일치하고, 재설치 전후67개 설정/대화/runtime 파일·프로필·두 이력 객체가 동일했다. 설치본 startup Maximized, CLI help exit0, Start 메뉴의 `com.aiolm.desktop` 등록은 한정 pass다. 원래0.2 업그레이드나 OS 알림 표시를 확인한 것은 아니다. 실제 바탕 화면의 OneDrive 동기화를 확인해 제거/업그레이드용 VM 로컬 계정 준비를 요청했고 아직 새 로그인 검증 전이다. Windows 잔여와 기존 fail은 유지하며 종료 commit은 지정하지 않는다. 후속 OS도 동기화된 사용자 폴더가 있는 경우 설치/제거의 영향을 격리하고, 해당 OS의 실제 패키지 identity/알림/자격 증명 검사를 별도로 수행한다.

이후 VM의 새 로컬 표준 사용자 계정에서 OneDrive 격리·기존 설치/데이터 없음과 새 체크포인트를 실제 확인했다. 공식0.2 NSIS 설치/최초 실행과 설치 GUI·CLI 전체 payload 대조, 이전0.2 GUI의 합성 소유권 백업 복원→OS Vault 읽기/내보내기→원본과 동일함까지 한정 pass다. 원래0.2의 같은 CPU ZIP import는 가속기 없음 오류로 fail이며, 고정19/20의 같은 bundle 성공과 구분한다. 원래0.2→고정20 실제 업그레이드·프로필/이력/자격 증명 이전은 아직 미실행이다. 후속 OS는 Windows Credential Manager의 내부 파일을 복사하지 않고 각 OS의 실제 저장소를 별도로 검증하며, 명시적 합성 복구 파일의 제품 계약과 upgrade 전후 보존을 확인한다. 비밀 백업 파일은 인계 문서/배포물에 포함하지 않는다.

## D85 안내 수정과 현재 Windows 검증 경계

최신 제품 source는 `2738587bce3ca3b1aa8cc4cdfed00e6c1dd168ac`이다. 실제 Windows 트레이 숨김에서 엔진이 유지되는 것과 설정의 “Closing the desktop app always stops” 설명 사이의 혼동을 줄이기 위해4개 언어의 설명만 수정했다. 앱 종료는 작업을 중지하고, 트레이 숨김/탭 이동은 작업을 유지한다고 구분한다. D84 이후 runtime/protocol/저장/프로세스 코드는 바뀌지 않았다. 관련 자동 검사, 고정21 전체 GUI/CLI/NSIS/MSI 빌드·읽기 전용 payload/개인 경로 검사와 호스트 새 격리 프로필의 실제 영어/한국어 GUI·작은 창 줄바꿈·CLI help·정상 Close가 한정 pass다. 정확한 전체 hash와 source별 근거는 [Windows 결과의 D85](windows-device-validation-results.ko.md)를 따른다.

앞 절의 미실행 상태 중 고정20의 **실제0.2 NSIS 업그레이드·schema12→14/프로필/합성 이력 이전·Vault 보존·동일 원래 CPU/model 실제 추론/usage·재시작·정상 종료·데이터 보존 제거**는 이후 한정 pass로 갱신됐다. 제거 후 portable에서도 원래 소유 항목의 실제 Vault 내보내기 보존과 새 실제 추론/정상 종료를 확인했다. OS 테스트 알림·설정 검색에서의 native 클립보드/한글 IME·실제 트레이 숨김/복원/Quit/꺼짐 복원도20에서 한정 pass다. 이를21 설치본의 성공으로 대체하지 않는다. 고정21 VM 전송 허용과 MSI 관리자 인증은 대기 중이며 실제 MSI 새 설치/0.2 업그레이드/제거와21의 관련 최종 수락은 남아 있다. 원래 Strata32/미디어 fail은 유지하고 Windows 종료 commit은 지정하지 않는다.

Linux L01/L02 및 Mac M01/M02에서는 해당 OS에서 새로 빌드한 production으로 종료/숨김 설명의4개 언어, 실제 tray/menu 또는 dock 동작, 작은 창/배율에서 설명과 설정의 접근성을 확인한다. tray를 제공하지 않는 Linux 세션에서는 기존 host 감지와 정상 종료 fallback을 실제로 검사한다. 이후 실제 엔진을 로드해 숨김 중 생성 identity/포트/응답 유지→복원→명시적 Quit의 정리와 데이터 보존을 구분한다. 공통 안내·설정·tray/lifecycle 코드를 수정하면 Windows W04/W07/W08/G07의 같은 흐름을 새 source로 재검증한다. L03/L04·Mac M03/M04 및 R01–R13의 기존 구체 작업은 유지하며 Linux/Mac 실제 기기 검증은 이번 Windows goal의 완료 조건으로 추가하지 않는다.

## D86 외부 엔진 제거 후 분류와 production22 인계 checkpoint

최신 제품 source는 `4d67994e19f5b2e3a6cdcdeabef4ce9827e365fe`다. 외부 등록을 제거해 catalog descriptor가 없어진 상세 화면에서 기본 제공 어댑터라고 표시하던 결함을 고쳤다. 실제 descriptor가 있을 때만 분류를 표시하며, 누락 안내·목록 복귀·다시 등록하는 동선을 유지한다. protocol/옵션/저장/Rust 경계는 바뀌지 않았다. 관련 UI54개/typecheck/ESLint, 고정22 GUI/CLI/NSIS/MSI 빌드·전체 payload/개인 경로 검사, 실제 Windows GUI의 제거→누락 안내→재등록→정상 분류와 같은 개인 엔진/Qwen/미지 옵션의 재열기·Ready·실제 argv·5/usage/401·정상 종료가 한정 pass다. 기존8개 프로필·3개 이력 보존 및 종료 전후14개 파일 전체 hash 일치는 [Windows 결과의 D86](windows-device-validation-results.ko.md)에 연결한다.

앞선 고정21은 고정 후 만든 합성 엔진의 완전 수동 executable/entry point/help/binding/protocol/probe wizard→1,014개 공통 옵션/999번 검색→새 프로필/실제 argv/합성 echo, 같은 ID v2의 거부/stale/diff/미해석 값 유지/명시 복구, 새로 빌드한 실제 개인 native 엔진의 앱이 모르는 옵션→실제 응답/usage를 검증했다. 합성 응답과 실제 추론을 구분하며 고정22에서 같은 엔진을 새22 빌드라고 부르지 않는다. 새 flag는 고정22 GUI/CLI에도 없음을 검사했다.

Linux L01/L02와 Mac M01/M02에서 해당 OS의 실제 임의 엔진을 등록하고, 실제 옵션이 있는 상태의 help/cache/profile/argv/response 외에 등록 제거 직후 상세 화면·목록의 검색 유지·등록 복구와 기본 제공/외부 분류를 확인한다. catalog 조회 실패나 갱신 중인 상태를 내장형이라는 사실로 확정하지 않는다. 이 공통 경계를 후속 OS에서 수정하면 Windows W03/G01/G05/G07의 같은 제거·재등록·보존·실제 실행 동선과 자동 검사를 새 source로 연결한다. L03/L04·M03/M04 및 R01–R13의 기존 작업을 유지한다.

이 source는 Windows 전체 종료 commit이 아니다. 최신22 VM 파일 전송 동의와 실제 MSI 관리자 인증을 기다리며 최신 설치본 수락·실제 MSI 새 설치/공식0.2 upgrade/remove가 남아 있다. 원래 Strata32/미디어 fail도 유지한다. 후속 OS 실제 검증은 각 기기에서 새로 빌드해 수행할 작업이며 Windows pass를 대신하지 않는다.

## D87 미확정 가중치 크기와 production23 checkpoint

최신 제품 source는 `908a2fb6bd5bdb4742eb4db6e8f6ac9e352956c1`이다. opaque adapter 모델 binding은 가중치 파일 대신 설정 파일이나 alias일 수 있다. 백엔드의 format unknown/size0/unknown weight size를0바이트의 가중치로 표시하지 않도록 모델 설정의 선택 목록도 메인 모델 목록과 같은 `—` 규칙을 적용했다. 작은 binding 파일의 실제 바이트 수로 가중치 크기를 대신 계산하지 않는다. 표시 한 곳만 변경했으며 저장/API/probe/readiness/Rust/추론 계약은 유지한다.

기존 UI127개/typecheck/ESLint, 새 고정23 GUI/CLI/NSIS/MSI 빌드·payload·개인 경로 검사가 pass다. 실제 Windows에서 opaque 크기 `—`와 같은 Qwen의468.6 MiB, 같은 합성/실제 개인 엔진의 저장 옵션 재로드/current help/Ready/실제 argv/응답, 합성 언로드와 실제 엔진이 로드된 정상 Quit를 확인했다. 기존8개 프로필·5개 이력, 정상 Quit 전후17개 파일 전체 hash 보존의 범위와 정확한 source/binary/engine/model hash는 [Windows 결과의 D87](windows-device-validation-results.ko.md)에 있다. 합성 echo와 실제5/PP34/TG2를 구분한다.

Linux L01/L02와 Mac M01/M02에서 opaque 설정/alias binding의 미확정 가중치 크기와 실제로 검사된 GGUF/snapshot 크기를 구분해 표시하는지 확인한다. 크기나 미디어/API 능력을 help·작은 설정 파일·엔진 이름만으로 추정하지 않는다. 해당 공통 model picker/catalog/metadata 경계를 수정하면 Windows W03/W05/G03/G06/G07의 같은 unknown/known 모델 표시·binding·저장 옵션·실제 argv/응답을 새 source로 재검증한다. 나머지 L03/L04·M03/M04·R01–R13은 기존 인계를 유지한다.

Windows 종료 commit은 여전히 미지정이다. 최신23의9개 VM 파일 전송·전체 hash 대조와 portable의 실제 추론/Vault/73개 파일 정상 종료 보존, NSIS의 새 설치/설치 CLI/바로가기 GUI/같은 실제 추론/정상 종료/74개 파일을 보존한 제거를 확인했다. MSI도 사용자 인증 후 실제 설치 로그의 인증 성공·종료0, 정확한 payload/등록/공용 바로가기·설치 CLI help0, 설치 전후74개 전체 파일 보존·실제 CPU/Qwen 추론/usage·로드된 정상 Close/소유9개 종료/포트·staging 정리·바로가기 재시작/75개 파일 보존 및 실제 제거를 확인했다. 공식0.2 MSI의 실제 설치/0.2 등록→최신23 업그레이드/구버전 등록 제거·같은 실제 추론/정상 종료/76개 파일을 보존한 제거도 pass다. 설치된 MSI의 Vault 등록 상태·기존 등록 시각은 복원됐지만 새로운 MSI 백업의 비밀 동일 여부 검증으로 확대하지 않는다. 원래 Strata32/미디어 fail과 goal 미완료는 유지하며, Linux/Mac 실제 기기 검증은 후속 범위다. 정확한 source·hash·receipt059–075 및 `vm-msi23-fresh-verdict.json`·`vm-msi23-upgrade-remove-verdict.json`의 범위는 Windows 결과에 연결한다.

원래 Strata32 실패는 보존한3개 SSE의 현재 파서 오프라인 재생에서도 content0/reasoning113/usage32/length로 일치했다. 고정 엔진의 순수 함수 대조상 원래 요청은 thinking 기본값을 유지하며 양수 reasoning budget에 한정된 답변 예약 조건을 적용하지 않는다. 직접 HTTP 수락 검사와 앱 Chat 직렬화의 경계를 구분한다. 이 진단을 답변 성공이나 새 엔진 실행으로 계산하지 않는다. L02/M02의 같은 원래 요청·모델·제한과 raw reasoning/content/usage/finish reason을 각각 보존하고, 명시적으로 다른 설정을 조사한다면 별도 대조로 기록한다. reasoning만 나온 스트림을 최종 답변으로 바꾸거나 원래 실패를 지우지 않는다. 소스/요청 hash와 범위는 [Windows 결과의 Strata32 경계 확인](windows-device-validation-results.ko.md)에 연결한다.

그 뒤 최신23 CLI로 같은 원래 요청 bytes·모델·최대32개를 실제 대조 전후 실행한 결과도 content0/reasoning109/usage32/length였다. 별도 명시적 `reasoning_effort=none`과 `reasoning_budget_tokens=8` 대조는 같은 최대32개에서 각각 생성2개·28개로 `5`/stop을 반환했다. 원래6개 입력의 실행 전후 전체 hash가 같았다. 추가 제어가 있는 요청은 원래 수락 실패를 대체하지 않으며 후속 OS에서도 구분한다. 정상 stop 직후 최초 관찰기의 native child 잔여/exit1과 후속 소유4개·포트/staging 없음의 범위도 함께 보존한다. raw `strata23-reasoning-control/diagnosis-verdict.json`과 Windows 결과의 최신23 thinking 대조 절을 따른다.

최신23의 원래 SmolVLM Q8_0/f16 미디어 GUI도 실제 재검증했다. 이번 호스트 OS는26H2 `26300.9711`, 실제 WebView2는 `.62`이며 이전25H2/`.45` 및 VM 환경과 구분한다. 원래 질문·이미지·system·text-first 순서의 실제 GUI body가16의 원본과 같은11,629바이트/전체 hash였고 동일 bytes를 같은 엔진에 재전송해도 `Aiolm 42`/PP185/TG7/stop으로 색·도형 **fail**을 유지했다. 새 프로필만 추가하고 기존50개 프로필·207개 비설정 파일을 보존했다. 로드된 실제 Close의9개·일반 production 재시작 후 Close의7개 kernel identity 종료와209개 파일 전체 hash 보존·이미지/답변/usage 재로드는 별도 pass다. 전면 차단/미디어 GUI 미실행은 해소됐고 검증 앱·엔진·포트는 종료됐다. `package23-w05-native-verdict.json`과 Windows 결과의 최신 미디어 절이 근거다.

L02/M02의 원래 미디어 대조에서도 모델/질문/이미지/order/system을 그대로 두고 실제 요청 내용·엔진 직접 응답·저장/재로드와 품질 판정을 분리한다. 명시적으로 다른 옵션을 조사하면 별도 대조로 기록한다. Linux/Mac에서는 해당 OS의 native 엔진을 새로 빌드하며 Windows binary나 Windows kernel-handle 결과를 해당 OS의 수락으로 계산하지 않는다. 기존 L01–L04/M01–M04/R01–R13과 공통 수정 후 앞선 OS 재검증 연결은 유지한다.

## 종료 기준에서 다음 기기로 재개

1. 종료 commit `53df1491cbb6dc790e9594221c3191a6c210937e`와 이 문서를 포함한 후속 문서 commit을 확보하고 위 조상 검사를 실행한다. Windows 제품 source908a2fb와 그 이후 문서만 변경된 범위를 확인한다. 기존 변경이 있으면 보존하고 동명 작업 브랜치를 초기화하지 않는다.
2. Linux 기기에서 L01부터 시작한다. 실제 환경/도구를 기록하고 lockfile을 유지해 의존성·GUI/CLI/package·native 엔진을 새로 빌드한다. 이어 L02의 새 flag 전체 여정/Strata·공통 역할, L03의 desktop/패키지/OS 통합, L04의 재현 결함 수정·Windows 관련 재검증·Linux 종료 commit을 순서대로 수행한다.
3. 그 Linux 종료 commit을 포함해 Mac M01–M04와 R01–R13을 실제 지원 기기에서 수행한다. OS별 원래/호환 모델·runtime 환경과 실행 근거를 구분한다. 앞선 OS 공통 경계를 수정하면 위 재검증 연결표의 실제 흐름을 다시 실행한다.

WIN-Q01/WIN-Q02는 각각 원래 Strata32 최종 답변과 SmolVLM 색·도형의 **fail/P2 후속 품질 잔여**다. 엔진 내부/요청 정책 또는 모델 품질의 별도 작업이며 GUI 어댑터 수락을 막는 미실행 항목으로 바꾸지 않는다. 원래 요청·모델·제한·실제 직접 응답과 source/hash를 유지하고, 명시적인 변경 대조가 필요하면 원래 실패와 분리한다. 후속 검증에서 어댑터 전달·파서·수명주기의 새 결함이 재현되면 해당 구현과 앞선 OS 관련 검증을 다시 연다. Windows의 두 fail을 다른 모델/요청 성공이나 unsupported로 덮지 않는다.

Windows production23의 GUI/CLI·설치 파일 hash는 결과 문서에 고정돼 있다. 실제 마지막 감사에서 입력12개·배포4개가 그대로였으며, 마지막 미디어 흐름의 기존50개 프로필·207개 비설정 파일 및 정상 종료/일반 재시작 전후209개 파일 전체 hash가 보존됐다. 검증 앱·소유 엔진·관찰기·임시 전송기는 종료됐고 사용자 조작 대기는 없다. raw와 개인정보는 이 로컬 작업 홈에만 남기며 후속 OS에는 필요한 익명화 결과와 검토한 source/계약만 전달한다. 원격 push는 별도 요청 전에는 수행하지 않는다.

## Linux 불완전 스냅샷 탐색 수정의 공통 재검증

제품 수정 `fc22b28d8b4847c7f9d74a83110cfae04492eb82`는 다운로드 기록이 있는 스냅샷을 `config.json` 도착 전에도 모델 목록의 검사 대상으로 포함한다. Linux 실제 다운로드의 설정 파일 게시 실패에서 오류·Retry·불완전 manifest는 남았지만 모델 목록이 비던 결함을 재현했다. 목록에 포함한 뒤 형식·모달리티·파일 완결성·소유권은 기존 검사기가 판단하며, 파일 누락을 Ready로 바꾸거나 엔진별 형식을 추정하지 않는다. 불완전 기록과 잘못된 JSON 기록, 기록 없는 가중치의 제외, 정상 파일 도착 이후의 완결성 전환을 공개 catalogue 경로의 회귀 검사로 확인했다.

Windows W03/W05/G03/G06/G07과 Mac M01/M02에서는 해당 OS의 새 production에서 실제 중단·실패한 다운로드를 목록에서 다시 찾을 수 있는지 확인한다. 설정 파일이 없으면 Unknown/누락/불완전 상태를 표시하고 실행 선택을 차단해야 한다. 같은 revision의 실제 Retry가 완료된 뒤에만 정상 파일 상태로 전환되는지, 기존 binding·프로필·외부 파일·삭제 보호가 보존되는지 확인한다. Linux의 실제 파일시스템 실패와 자동 검사 결과를 Windows/Mac 실행 결과로 계산하지 않는다. 정확한 Linux source·고정 binary·실제 재검증 범위는 [Linux 결과](linux-device-validation-results.ko.md)에 연결한다.

근거 마감은 UTC2026-10-25T18:46:35.549445Z/KST2026-10-26T03:46:35.549445+09:00다. 고정18의 새 옵션 GUI/저장·실제 native 동작·두 정상 Close/재열기·키보드·네 언어/native DPR2·빠른 검색과 private 인프라 정리까지 실제 범위를 확인했다. Core 원래 exit1/scoped 등록 감사와 각 harness/Reader 실패는 보존하며 최종18 managed ROCm CLI의 실제 offload/원래 요청 추론·내용 취소/같은 PID HTTP 재요청·재시작·정상 정리와 최종 사용자 자료 guard를 추가 확인했다.

## Linux 파일 누락 안내와 미확정 GGUF 기능의 공통 재검증

제품 수정 `9a6d64dde49f956b736d615de4f181ec150067fe`는 불완전 HF 스냅샷을 분할 모델의 조각 누락으로 설명하던 네 언어 안내를 필수 파일 누락/다운로드 불완전으로 바꾼다. 상태 로직·저장 schema·readiness는 바꾸지 않는다. Linux 고정15의 같은 실제 실패 파일 사본에서 네 언어360×520 안내·구체적인 설정 누락 원인·비활성 Start·기존 binding 보존과 native 키보드 스크롤의 마지막 줄 접근을 확인했다. 좁은 footer에서 안내 전체가 동시에 표시됐다는 결과는 아니다. 정상 언어/크기 복구·같은 profile의 정상 Quit/재열기와 기존 프로필·이력·runtime 보존도 확인했다.

제품 수정 `faa7d613b3036e91e1f392e772a9d416f7e248ef`는 일반 GGUF metadata를 읽지 못한 파일의 Text/tokenizer/chat-template 기능을 추정하지 않으며, projector 전용 판독도 일반 판독 성공 이후에만 수행한다. 잘못된 magic과 세 번째 key가 잘린95바이트 mmproj 회귀의 RED→GREEN 및 최종 전체 Rust 검사를 통과했다. 기존 파일명 역할 힌트와 정상 GGUF의 기능 판단 정책, 저장·호환성·readiness·소유권은 유지한다. 정상 파일의 기존 tokenizer/template 정책을 모든 GGUF의 실제 데이터 존재 증명으로 확대하지 않는다. 정확한 고정16 payload·실제 GUI 재검증 상태는 [Linux 결과](linux-device-validation-results.ko.md)에 연결한다.

Windows W03/W05/G03/G06/G07과 Mac M01/M02에서는 해당 OS의 새 production으로 같은 불완전 snapshot·분할 GGUF의 일반 안내/구체적 누락 이유·disabled Start를 확인한다. 보통/mmproj의 읽기 실패는 Unknown/원인·미확정 기능으로 남기고 정상 GGUF/projector를 별도 대조한다. 실제 Linux12/14/15/16의 F12 요청 최소범위 pass에는 같은-origin companion 전체바이트와 nondefault CPU 세션의 독립 사본 삭제/다운로드 보호까지 포함한다. 모든 optional later-shard/projector/draft/LoRA live-role 조합·새 large-shard 전송·품질·17 VM 실행을 뜻하지 않는다. 후속 OS의 실제 바이트·binding/프로필/argv·Stop/Unload와 소유권 보호를 별도로 기록한다.

## Linux 수치 범위 안내의 표시와 접근성 재검증

제품 수정 `f1959c2201663c49bab854961bc022596317302a`는 알려진 유한 수치 범위만 기존 네 언어로 입력 위/ARIA 설명에 연결하고0/한쪽 경계를 보존한다. 미확정 범위는 추정하지 않으며 알려진 민감 옵션의 범위 리터럴/설명 ID는 생략한다. 실제16의0·33·abc 거부/linked error/Save 차단은 정상이나 문서화1–32 안내가 없었던 관측을 보존한다. 의미 있는5개 회귀와 동료 검토의 민감한 같은 양끝값 노출 회귀는 각각 수정 전 RED를 확인했고, 최종84개/전체frontend 검사는 통과했다.17은 공통 옵션 표시/검사 두 파일뿐이며 native/IPC/validation/IME 소스는16과 같다. 실제 고정17 private X11의 새 합성 q270e5c는 help1030/common1012·값9/정확한 argv·마스킹·명시SYNTHETIC echo/저장9 재열기를 확인했다. 실제 개인 ped1c544는0·33·abc 거부/모든Save 차단→미저장3의 linked1–32/native description 뒤, Reader 정리/원래 helper 복원 후 값을 다시 쓰지 않은 한 번pointer의 첫Save/저장3 재열기까지 확인했다. max32/T0·provider/runtime를 보존했다. 이후 실제17 native GUI core는 새flag3/실제 argv와n_threads3·첫/새PID재시작 답변5·native/GUI/저장32+2·내용Stop/같은PID Retry·정상Unload/재시작을 통과했다. 긴 숫자Retry의 원래32 한도 도달은 lifecycle 경계이며 품질pass로 쓰지 않는다. 직접raw control3의21packet/130656B는 Reader를 대신하지 않고 원래 control/Reader1–5 실패·한계를 보존한다.

Private Reader6은 정상 Tab→같은 entry의 ordinary pointer return 뒤 실제 필드명/role·값3/help·범위1–32와 invalid33/valid3, 상세 WhereAmI와 Tab/현재위치 발화를 확인했다. 전체 validation 오류 문장·사람 청취/이해도는 입증하지 않았다.39완료/7취소와705 packet 8,217,702B/실제 ALSA·RAW 8,142,586B의 취소차이를 보존하고, watchdog36회 뒤 정상stop구간 Processdefunct 실패도 전체pass로 바꾸지 않는다. 정상stop/fullcleanup·실제자식회수/keeper무신호정상종료·소유speech폴더제거·main/config/private접근성/원래focus/common/fresh19 복원과 deadtyped42/binding0을 확인했다. 이 Reader 정리 당시 private bus/driver/mount teardown은 별도였으며 이후18의 실제 최종 정상 정리는 아래에 구분한다.

Source17 small-window 최초 actual은 UTC2026-10-25T14:56:15.221344에 locale/resize 전 General selector 가시/noninert match와 finally복구가 실패했다. 실패 순간 geometry가 없으므로 inert 원인으로 단정하지 않으며, 나중read-only en1280×800/Generalvisible/noModal은 원래 실패를 닫지 않는다. 원래PREP_ONLY 호출은 검사가 아니다. 복구helper의 두 가정 실패를 남기고 정상 두Continue UI로 baseline을 복구했다. R2의3ms geometry assertion 뒤 R3는 최소250ms/같은3frame 안정화에서도 입력 아래9px가 가려졌고, 독립 native XTest Tab에서도 같은9px가 재현됐다. 각 정상복구는 저장3 editor/search·locale/넓은창·native21파일/UI6키·중지상태를 보존했다. 첫Save 완료는 UTC2026-10-25T14:55:03.600739이며 KST26일로 실행일을 바꾸지 않는다. 이 당시 네언어/전체F03 판정은 남았으며 후속18 대표 요구사항의 pass 판정은 아래와 구분한다.

실제17은 모델 실행 중 정상Quit→동일profile의 새GUI 재열기3/자동시작없음→최종정상Close를 완료했고 소유GUI/WebKit/model birth·포트가 사라졌다. 마지막 원래 보존assertion은 top-level provider_options의 특정dict가 현재실행map에서 없어져 exit1/동일성false였고 그대로 보존했다. 별도 source/닫힌파일 감사와 독립재계산에서 기존저장5프로필·과거applied snapshot·그dict의21값이 전부 정확히 남았음을 확인했다. 이는 저장라이브러리와 현재실행map을 구분하는 해당사례의 판정이며 임의미저장값의 무손실 주장이 아니다. 수정하지 않은 strict lifecycle importer의 실제2Close/24pins와current-gone 검사는 pass지만 원래rawfalse를 pass로 바꾸지 않는다.18 baseline은 닫힌17의 현재9프로필/3applied와별도기존5프로필/21값으로 잡았으며 GUI/설정변경 없이 기록했다. 이후 실제18 DPR2/private 정리 뒤와 최종 GPU 뒤878/1560 guard는 각각 변경·누락·오류0개였다.

## Linux 작은 창 포커스 가림의 source18 수정과 실제 제한된 재검증

제품 `9f9dbac921ca5837aa5e9594658362d872a79d5f`는 공통 모델설정 scroll영역의 주석과 `scroll-padding-block: 1em`만 바꾼다.17의 실제안정화/nativeTab9px가림을 보존하며 JS/validation/Save/schema/API/IME/native엔진은 바꾸지 않는다. 같은최종CSS diff에서 type8.609초·lint4.783초·전체220파일/2577검사110.497초, commit뒤기본package139.034초·nativeCLI smoke0.260초가 통과했다. UTC15:36:16.107862 고정18은519 staging privacy/fake0·현재SDK3의전체바이트·여섯payload와독립archive8개로 검사했다. nlink1은독립archive8사본의범위이며 원래Cargo releaseGUI/CLI의nlink2와구분한다.18 Rust재실행은 없으며 동일native소스의16 최종결과를 구분해 유지한다.

고정뒤새 qb420d5/pefcaecb와CPU native를 만들었고 원래upstream/pin/license/모델/32T0를 유지했다.18 archivedCLI의A01–A09 기본/명시3은3.712/3.882초·실제5/native42+2·내용취소/재시작/재등록/정상종료를 통과했다.6PID/두포트종료·4033원래입력/4009새artifact와고정payload/8archive 해시를 확인했다. 18 첫준비R1은기존5서비스기록의미기록exeSHA를요구해GUI시작전KeyError로중단했고24native파일/빈driver/기존birth·원래실패를보존했다. 별도R2는원래positive5생성/기록4argv·과거exe/부모graph와독립systempackageprogram/privatebus/단계별env를연결했다. 가짜과거SHA/AT-SPI전체argv·소유밖manager채택은없다. 실제prepare/attach가통과했고복사DBfamily20,480B/WALSHM유무와native24개를보존했다. 실제UI4키는2부재/2UTF16LE후보와정확히일치했다.

보존된17저장3/32T0의 실제18 영어 nativeTab 뒤 네언어47.396초/UTC16:09:06 replay가 통과했다. 각360×520/DPR1의 linked 안내/입력 전체, 영어H87의4px 여유와 JA H75.594 포함, own native editable id/현지화1–32, 각16forwardTab의 header SUMMARY/Close·footer두버튼 가시 순환 및 native24/UI6/critical4·영어wideChat/noModal/quiet 복구를 확인했다. 이는 그 visibility replay의 범위다. 이후 별도18 keyboard-only 진입·wrap·이탈/같은 opener focus, fresh 등록/Save/native 동작·두Close·DPR2/빠른 검색 및 원래 F03 root판정은 다음 절에 기록한다.

별도 고정13 직접한글에서는 조합종료4ms 뒤 첫 Enter가 기존 헤더/입력을 보존하고, 사용자의 별도 물리 End→Enter가 같은 정확한 한글 경로를 정상 Load했다. 원래27개 event prefix/현재36개 기록·139자 필드·config/main 상태/allStopped/noSave를 보존해 Linux D02의 해당 경계는 pass다. defaultPreventedAfter의 측정 시점은 확인되지 않아 근거로 쓰지 않으며 이후 정상 Discard/Close·main/manual13 소유 자원 정리·config/main 보존도 완료했다. 별도private17 전체 종료로 확대하지 않는다. 이 물리 입력만으로 일반 Orca·다른 OS의 pass로 확대하지 않으며, 후속 Linux F03 대표 범위의 근거로 source를 구분한다.

Windows W03/G03은 명시한 범위·0/한쪽 경계·미확정 사실/민감 값, G06은 같은 값/프로필/dirty·binding 보존, G07은 실제 keyboard/접근성 description·오류 해제/작은 창을 재검증한다. W07/G07의 실패·취소·포커스 복구와 기존69a463b IME 인계를 함께 유지해 실제 조합 첫 Enter 보존→키 해제 뒤 다음 Enter를 각각 확인한다. W05의 원래 내용 품질 실패를 모델 관리나 UI 범위 안내로 닫지 않는다. Mac은 기존 M01/M02의 실제 새 flag·옵션/프로필/실행, M04/MAC-R06의 새 APP/DMG, MAC-R11의 WKWebView/VoiceOver·키보드/IME·작은 창, MAC-R13의 지원 개인 엔진에 연결한다. M03/M04와 나머지 MAC-R01–R13의 원래 입력·판정·재개점을 유지한다. Linux 자동/GUI 결과를 Windows/Mac pass로 옮기지 않는다.


## Linux 최종18의 실제 대표 UX 판정과 후속 OS 경계

새18 합성 GUI의39.008초 여정은 help1030/pre-import plain1012·fresh9·masked rich argv·명시SYNTHETIC echo/저장9를 확인했다. 실제 개인 CPU17.318초는 help263·0/33/abc 오류/linked1–32/모든Save 차단→첫 한 번pointerSave/저장3 재열기를 확인했다. 이후 실제 native argv3/n_threads3·첫/새PID재시작5와 native/GUI/저장32+2, 내용Stop/부분응답·같은PIDRetry·정상Unload/재시작을 원래32/T0/입력/모델로 기록했다. 원래 core 전체exit1은 선택등록의 정상 모델별probe/fingerprint 여섯경로 갱신 때문이며 source/정확한 beforeSHA 재구성의 scoped 감사만 수락했다. Rawbefore 사본이나 원래wholecorePASS로 바꾸지 않았다. 나머지29nonconfig/기존9저장·3applied·별도기존5/21값은 보존됐고 새선택revision1→3은 명시두Save&start에 대응한다.

실행중 정상Quit 검사1.127초 뒤 동일고정18/profile의 새GUI에서 저장3/같은binding·32T0/noautostart를 확인하고 최종정상Close했다. 재열기·확인·최종Close 전체검사는8.068초였으며, 소유9birth/다섯포트Gone·native34/DBfamily/UI4exact를 확인했다. currentgone0.269초/strict파생import0.465초는 닫힌역사만 추가하며 원래exit1·과거topmapfalse를 유지했다. 키보드-only13.416초는16nativeX11Tab/KPEnter와1ordinaryWDShiftTab으로 entry/wrap/Close/같은논리opener focus를 실제 확인했다. 포인터/DOMfocus·scroll로 대체하지 않았다.

별도 main X11/XWayland actualDPR2는6.293초에360×520logical/720×1040physical과 전체1–32hint/focused3·4px여유/nooverflow 및 실제wide복구를 확인했다. RAPIDv1의 잘못된 rich-profile 선행가정과 v2의 pre-import1012 rawcount 가정/모든실패를 보존했다. v2 ordinary model Load 자체는 실제 empty-pathDefault→정확한모델/rich9를 확인했다. v3는 schema/manifest/저장occurrence/renderer로 정확한 plain1012+14expanded=1026 전체이름을 도출해 unknown/missing/duplicate를 숨기지 않고17.686초에 A100/B1saved9/missing0/reset을 통과했다.37trustedinput/300rAF한도에서 실제 A100→완성B입력직후옛A100→최종B1의 deferred전이를 기록했다. 원래2초상한·입력 그대로이며 모든interleaving 보장이 아니다.

Root는 UTC18:15:14에 원래 대표 조항을 감사해 Linux F03을pass로 판정했고 전체집계는65pass/1fail/6unrun/1unsupported/1blocked다. 실제13물리IME와17stockOrca는 그대로source를 밝힌 carried근거다. named invalid33+사용가능1–32+Entryvalid3는 원래 오류안내로 충분하다고 판단했으나, 전체오류문장 미발화/청취미검사/Reader36검사뒤 종료probe실패/취소PCM차이는 남는다. 다른OS·모든GNOME·IME·경합조합의 포괄 인증으로 옮기지 않는다.

Main18정상Close0.901초 뒤 소유GUI/WebKit·포트·session과 copied7/source34/DB/UI·원래main상태를 확인했다. Private인프라의 두 소유FUSE는 정상unmount했지만 원래cleanup은 portal exe 판독FileNotFound/exit1이었다. 원래실패·grant/raw를 남기고 prepare/unmount 재실행 없이 원래positive12개만의 continuation0.556초·별도tail0.077초로 전부Gone/포트·X11socket·lock/자기인증파일제거·maincontrols/mount동일성을 확인했다. 밖manager읽기·신규채택·그룹/강제신호 없이 원래main driver/sharedstate는 보존됐다. 실제DPR2뒤와UTC18:39:49 private정리뒤878/1560guard도각각0변경/누락/오류다. 첫GPU시도5.669초/exit1의serverStart전supported목록harnessTypeError와 두번째긴SSE수집상한실패는 보존하며, 이후 별도v3 실제범위는 다음과 같다.

최종18 archived CLI/같은managedROCm b11869/Qwen의 실제v3는 UTC18:45:23 시작/17.594초exit0이었다. 첫/새PID재시작 모두 원래32/T0 산술5/native42+2/DONE와 요청전 실제offloaded25/25를 확인했다. 원래별도1024/T0의 실제내용1/2/3 뒤 terminal전 clientsocketclose→같은nativePID·동일body의새HTTP요청200/usage34+708/DONE(436132B)를 기록했다. Native취소ACK·GUIRetrybutton·1–200전체품질·새18Vulkan pass는 주장하지 않는다. 진단verbosity4는성능비교가아니다. 두번째13.996초실패의256KiB 긴timings수집상한만 고정1024/실제frame근거의유한2MiB로 구분했고 quality256KiB/32T0·모델/입력/token/timeouts는바꾸지않았다. 두원래harness실패/정리도남겼다. 정상Stop/all4native·collectorBirth/IPv4+6포트Gone·683원본/독립사본/모델/CLI/보호자료exact를확인했다. Private정리와GPU뒤 UTC18:46:35 최종878/1560hash-onlyguard도0변경/누락/오류이며 사용자자료복사는없다.

Windows/Mac은 앞선 W/G·M/MAC-R 대응을 그대로 적용한다. 해당OS 실제 production의 새flag/프로필·Start/Stop/Retry·읽기실패/호환성·keyboard/IME·native접근성/작은창을 자기OS에서 다시 확인한다. Linux F03pass를 Windows/Mac의 pass로 옮기지 않으며 원래 Windows 내용품질 실패와 나머지 외부엔진의 실제 source/요청/품질 한계는 유지한다.

## Linux 알림 문구와 updater 오류/회복의 제한된 실제 범위

설치16 VM의 ordinary Notifications는 r1 EN/KO와 r3 JA/ZH의360×520 설명/category·키보드 접근을 확인했으나 EN 상태의 별도 가시 PNG는 없다. r3의 wide 실제 Check2회 오류/재활성 Retry→정상Quit/같은profile 원래환경 재열기의0.3.1 동률회복·데이터/자원 보존은 실제 하위 경계만의 pass다. U02/U03 전체 classifier·설치/진행/installer·조건부 D07을 닫지 않는다. main13 own ID35의 native 수락/closure와 달리 사용자는 배너/알림센터를 확인하지 못했다고 명시했으므로 D05의 사람 확인은 unrun이며 추가Send/OS설정 변경은 없었다. UTC17:18:40의 기존 공식 latest API 재확인도 공개v0.3.1과source0.3.1 동률이므로 실제새버전업데이트는blocked다. 기존 Windows W07/W08/G07과 Mac M01/M02/M04와 MAC-R06/MAC-R11의 native 실패복구·작은창/접근성·알림/패키지 검사를 각 OS에서 실행한다. Linux의 proxy 자식만의 환경/키보드 경로나 직접 PCM control을 다른 OS의 알림·VoiceOver/Reader·업데이트 설치 pass로 옮기지 않는다.

### 2026-10-25 고정19 알림 연결 후속

Linux `37c0343fe90b16588b2319f3ace96e6df274bf02`의 동일 바이트 고정19는 ordinary Send의 발신 연결을 약130.558초 유지하고 정상Close 때 해제했다. 고정18의 수락 뒤 약1.47ms 닫힘과 구분하며, 실제 배너/알림센터 사람 확인은 대기 중이라 D05는unrun이다. 전체 자동 검사와 package/CLI·실제 알림 전후·정상 종료·사용자 자료 보존 및 정확한 배포 해시는 [고정19 결과](linux-device-validation-results.ko.md#고정19-알림-연결-수정과-실제-재검증)를 따른다. 기존 엔진·UX·설치/IME/Reader 근거의 source 범위를 유지한다. Windows/Mac은 새 제출 IPC의 공식 plugin 경로를 실제로 재검증해야 하며 Linux 전체 목표도 아직 진행 중이다. 원격 push는 하지 않았다.
