# 엔진 중립 GUI 어댑터의 Linux·Mac 후속 인계

## 기준과 현재 경계

현재 Windows production19의 고정 제품 source는 `4a7fa53daf595c36b5b0e50d26f12d5e61afaaf2`이며 작업 브랜치는 `codex/windows-runtime-adapter-validation`이다. 필수 조상은 `df3264bad99deb0144b947f96300e8625f7a2da5`다. 이 문서는 **진행 중인 Windows 검증에서 준비한 후속 실행 지침**이며 Windows 종료 선언이나 Linux/Mac 실행 결과가 아니다. D81/D82 수정과 관련 production19 실제 GUI·원래 Strata·새 홈 bundle 수락은 완료했고 W02/W08 설치/OS 계정 검증 및 원래 W04/W05 content 실패가 남아 있으므로 실제 이관 시 [Windows 결과](windows-device-validation-results.ko.md)의 최종 source·종료 commit·잔여 판정을 다시 고정한다. 후보 source를 최종 종료 commit으로 바꾸어 부르지 않는다.

원격 push는 수행하지 않았다. 다음 기기는 사용자가 공유한 정확한 commit을 받은 뒤 시작한다. 이전 브랜치, 공개 0.3.1 binary, Windows `node_modules`·`dist`·실행 파일·Python 환경을 복사해 최신 소스 검증으로 계산하지 않는다. 기존 checkout·동명 작업 브랜치·모델·설정·기록은 보존한다.

```sh
git status --short
git rev-parse HEAD
git merge-base --is-ancestor df3264bad99deb0144b947f96300e8625f7a2da5 HEAD
git merge-base --is-ancestor 4a7fa53daf595c36b5b0e50d26f12d5e61afaaf2 HEAD
git merge-base --is-ancestor fdb48af66d66dff3f4b607c11ee28ba7c61830f0 HEAD
```

시작 전 `AGENTS.md`, 존재하는 `tmp/AGENTS.local.md`, [Windows 인계의 L/M 정의](windows-device-handoff.ko.md), [공통 adapter 계약](runtime-adapter-handoff.ko.md), [외부 runtime 계약](pluggable-inference-runtimes.ko.md), [실제 엔진 수락](provider-native-acceptance.md)을 읽는다. 이 문서의 L01–L04/M01–M04는 Windows goal의 후속 단계다. 과거 [Linux 기기 인계](linux-device-handoff.ko.md)의 L01–L11 및 Mac의 옛 M01–M12 결과와 ID 범위를 합치지 않는다.

## 공통 실행 조건

Windows D83 검사 commit은 `fdb48af66d66dff3f4b607c11ee28ba7c61830f0`이며 제품 binary 변경 없이 공통 CLI 수락 검사의 reasoning 취소와 독립 검사 실행을 수정했다. 후속 기기는 이 수정이 포함된 최신 검사 소스를 사용해 같은 원래 모델/질문/32·1024 한도를 유지하고, reasoning 또는 content 출력 후 실제 HTTP abort/서버 정상 상태와 엔진 내부 취소 ACK를 별도로 기록한다. A03의 답변 실패가 A04–A07을 가리지 않게 하되 실제 선행 조건이 실패한 항목은 이유 있는 unrun으로 남기고 전체 실패 exit를 보존한다. `npm run test:scripts`의 실제 연결 회귀와 [D83 결과](windows-device-validation-results.ko.md)를 함께 확인한다. Windows에서 남은 산술/미디어 fail을 새 검사 성공으로 지우지 않는다.

W02/W08은 이후 새 Windows VM을 준비했고, 명시적 재개에서 설치 전 체크포인트·고정11개 파일의 host-to-guest 복사·게스트 preflight까지 실제 성공했다. 최초 취소와 준비 코드의 잘못된 TPM 조회 실패 기록은 보존했다. 실제 설치/이전의 수락 판정은 아직 남아 있다. 원래0.2 공식 MSI와 고정19 MSI의 읽기 전용 대조에서 같은 UpgradeCode·서로 다른 ProductCode·`ALLUSERS=1`을 확인했다. Windows MSI의 컴퓨터 전체 설치는 새 사용자 계정만으로 격리하지 않고 별도 VM/기기에서 검증한다. 후속 OS도 실제 패키지 설치 범위와 기존 사용자 데이터/설치의 격리 범위를 확인한다. 원래 Windows 설치를 VM 준비나 정적 MSI 대조만으로 수락 완료 처리하지 않는다.

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

Windows 종료 commit은 여전히 미지정이다. 최신23의 준비된9개 VM 파일 전송 허용·관리자 인증 이후 실제 최신 설치본/공식0.2 MSI upgrade/remove를 이어간다. 원래 Strata32/미디어 fail은 유지하며, Linux/Mac 실제 기기 검증은 후속 범위다.

원래 Strata32 실패는 보존한3개 SSE의 현재 파서 오프라인 재생에서도 content0/reasoning113/usage32/length로 일치했다. 고정 엔진의 순수 함수 대조상 원래 요청은 thinking 기본값을 유지하며 양수 reasoning budget에 한정된 답변 예약 조건을 적용하지 않는다. 직접 HTTP 수락 검사와 앱 Chat 직렬화의 경계를 구분한다. 이 진단을 답변 성공이나 새 엔진 실행으로 계산하지 않는다. L02/M02의 같은 원래 요청·모델·제한과 raw reasoning/content/usage/finish reason을 각각 보존하고, 명시적으로 다른 설정을 조사한다면 별도 대조로 기록한다. reasoning만 나온 스트림을 최종 답변으로 바꾸거나 원래 실패를 지우지 않는다. 소스/요청 hash와 범위는 [Windows 결과의 Strata32 경계 확인](windows-device-validation-results.ko.md)에 연결한다.
