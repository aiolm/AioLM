# Linux 기능 검증·개선 /goal 지시문

Linux 기기의 에이전트 세션에서 `/goal ` 뒤에 아래 상자 안의 본문 전체를 붙여 넣는다. 본문은 이 저장소와 함께 전달된 bundle·manifest만으로 실행할 수 있도록 작성했으며 Windows의 `tmp/` 자료를 필요로 하지 않는다. 상세 행렬·명령·판정 규칙은 [Linux 기기 기능 검증·개선 인계](linux-device-handoff.ko.md)에 있다.

```text
목표: 이 Linux 기기에서 AioLM 현재 source의 전체 기능을 실제로 검증하고, 그 기준선을 기록한 뒤 프로젝트 전체의 효율·UX·가독성·구조를 근거 기반으로 개선한다. 현재 source의 Linux 기능은 아직 한 번도 실행 검증되지 않았다. 따라서 모든 Linux 항목의 초기 상태는 unrun이며, 실행 근거 없이 다른 상태로 바꾸지 않는다. 이 목표는 계획 작성이나 테스트 실행만으로 끝나지 않는다. 실제 실행으로 결함을 찾고 고친 뒤 다시 실행해 확인한다. 엔진이나 모델이 완벽하게 동작한다고 약속하지 않으며, 실제 관찰만으로 판정한다. Mac 검증은 이 목표가 끝난 뒤의 별도 작업이고 Windows 추가 개선은 하지 않는다.

1. 시작 문서와 소스 확인
- 저장소의 AGENTS.md, 존재하면 tmp/AGENTS.local.md, docs/reference/linux-device-handoff.ko.md 전체를 먼저 읽는다. 필요할 때 그 문서가 가리키는 1차 문서(engine-adapter-linux-macos-handoff.ko.md, runtime-adapter-handoff.ko.md, pluggable-inference-runtimes.ko.md, inference-runtimes.md, provider-native-acceptance.md, cross-platform-validation.md, efficiency-review.ko.md의 "남은 검토", docs/guides/development.ko.md, docs/guides/install.ko.md)를 읽는다.
- 소스는 원격 push 없이 전달된 Git bundle로 받는다. origin(GitHub)에 Windows의 미공개 commit이 있다고 가정하지 않고 push·pull하지 않는다. bundle 옆의 checksum과 manifest로 확인한다: sha256sum -c aiolm-windows-validation.bundle.sha256, git bundle verify, 받은 ref(refs/heads/codex/windows-runtime-adapter-validation)가 manifest의 final_head와 같음, 검증된 코드 commit 43b50686627df9631210419739544f3e5e317fc1과 df3264bad99deb0144b947f96300e8625f7a2da5, 53df1491cbb6dc790e9594221c3191a6c210937e, 908a2fb6bd5bdb4742eb4db6e8f6ac9e352956c1, 4ad1f1fdadfcca736342a36fc4636f5613a2b866이 final_head의 조상임, 검증된 코드 commit 이후 바뀐 경로가 manifest 목록과 같고 문서뿐임. manifest 파일은 delivery-manifest.json다. 새 폴더 clone 또는 기존 저장소의 별도 ref·git worktree를 사용해 기존 checkout의 미커밋 변경과 branch를 보존한다. 작업 branch는 codex/linux-runtime-adapter-validation이며, 이미 있으면 초기화하지 않고 상태를 확인한다.
- package.json(engines, packageManager, scripts), .node-version, rust-toolchain.toml, src-tauri/Cargo.toml, src-tauri/tauri.conf.json, scripts/package-tauri.mjs, .github/workflows의 Linux job을 실행 전에 다시 읽는다. CLI flag·옵션·패키지 이름·backend 능력은 추측하지 않고 실제 --help, 스크립트 소스, lockfile, 배포판·세션 정보로 확인한다.
- "Orca"는 Linux에서 GNOME Orca 화면 낭독기를 뜻할 수 있다. Orca IDE 도구가 설치돼 있으면 해당 skill로 실제 실행 파일을 확인한다(ORCA_CLI_COMMAND 우선, Linux의 IDE 터미널 밖에서는 orca-ide 확인; bare orca 금지). 사용할 수 있는 도구·skill은 이 세션에서 실제로 확인한 뒤 사용한다.

2. 환경과 데이터 보존
- 배포판·커널·arch·CPU·RAM·가상화·GPU/driver/API·X11/Wayland·desktop·tray host·portal·IME·Secret Service·WebKitGTK와 Node/npm/Rust/Python 버전을 기록한다. Windows의 node_modules, dist, .codex-target, 실행 파일, venv, 설치 파일을 재사용하지 않고 Linux에서 새로 설치·빌드한다. lockfile을 바꾸지 않는다.
- native 의존성은 Tauri Linux 준비 문서와 저장소 CI의 Ubuntu 24.04 목록을 근거로 하며, 다른 배포판에는 그 배포판의 패키지 이름을 확인한다. 관리자 권한 설치·OS 설정 변경은 사용자 승인 뒤에만 한다. Secret Service가 없을 때 평문 저장으로 대체하지 않는다.
- 검사는 임시 HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, AIOLM_HOME으로 격리하고 자격 증명 없는 합성 fixture를 쓴다. 최초 실행·legacy 이전·Secret Service·패키지 설치/업그레이드/제거는 별도 테스트 OS 계정 또는 VM checkpoint에서 한다. 실제 사용자 설정·프로필·이력·자격 증명은 바꾸지 않고, 시작 전후 hash만 비교하며 내용을 기록하지 않는다.

3. 수락 기준(행렬 ID는 linux-device-handoff.ko.md를 따른다)
- L01: 소스 무결성(L01-S), 환경(L01-E), 저장소 자동 검사 전체를 Linux에서 새로 실행한 기준선(L01-T: typecheck, lint, test:unit, build, cargo fmt/clippy/test 전체 target·feature, no-default-features check, native CLI smoke, Python 검사, provider-runtime 합성 검사, release CLI, Secret Service vault 검사, 실제 Python argparse journey, updater 모듈 검사), 고정 production binary 뒤 만든 새 flag의 help→GUI→프로필→argv→probe→Ready→응답과 공통 옵션 형식·app-owned binding·버전 변경·변조·경합·취소·Linux 경로/locale 계약(L01-H).
- L02: 실제 엔진(llama.cpp CPU와 실제 있는 GPU backend, 외부 llama.cpp build 어댑터, native Linux vLLM 0.31.0, portable 왕복, 원본 Strata, Strata 외 실제 개인 엔진)과 공통 기능의 실제 production WebKitGTK GUI 여정(최초 실행·이전, 런타임→프로필→옵션, UX·접근성·IME·360×520·대량 옵션, Chat 취소/Retry/재시작/정상 종료·멀티 세션, 데이터 보존, 프로젝트/RAG/문서, STT·영상 전처리, MCP 승인/거부/취소와 다른 반환값의 후속 답변, 모델이 지원하는 미디어 내용과 첨부 순서·저장/재로드, gateway 인증·라우팅, 측정·이력·CSV/XLSX·공유 미리보기, 모델 탐색·관리, 개인화·스킬, 프로세스·포트·staging 정리).
- L03: X11/Wayland desktop 통합(파일 선택·clipboard·IME·tray 유/무·창·두 번째 실행·알림·Secret Service·4개 언어 안내), DEB·AppImage 생성과 설치·실행·재설치·업그레이드·제거·데이터 유지·desktop entry·아이콘, runtime bundle·내보내기, updater(설치 DEB 판별, 진행률 coalescing·기본 500 ms·대기 read liveness·GUI 백분율 경계·오류 우선순위·read/write 대기 중 취소 후 callback 없음의 Linux native 회귀, 설치 가능/불가 안내, 통제된 실제 업데이트는 일회용 VM 또는 테스트 계정에서만).
- L04: 기준선 고정 뒤 재현된 결함의 최소 수정과 회귀 검사·실제 재검사, 이어서 효율·UX·가독성·구조 개선 루프, 공통 수정의 Windows 재검증 항목 기록, Mac M01–M04·MAC-R01–R13 인계 고정.
- 완료 조건: 필수 L01–L03 항목 모두가 현재 Linux 실행 근거의 pass 또는 계약 근거의 unsupported이고, 이번 범위에서 재현한 제품 결함이 수정·재검증되어야 한다. 선택 대조와 조건부 환경의 미실행 조건은 별도로 기록한다. L04의 효율·UI/UX·가독성·폴더 책임 구조 검토 범위와 채택한 개선의 근거·수정·검사·실제 재검사를 연결하고, 최종 source의 관련 전체 자동 검사·production GUI 여정·작업별 commit·최종 Git 상태·Mac 인계까지 확인한다. 필수 항목에 fail/unrun/blocked나 필요한 구현이 남으면 complete로 바꾸지 않는다. 모든 독립 작업을 끝내도 외부 조건 때문에 필수 검증을 못 하면 goal 운영의 3회 blocked 규칙을 따른다. 자동 검사·합성 검사·문서 작성·일부 완료·컨텍스트/시간 한계는 전체 완료 근거가 아니다.

4. 판정 규칙
- 상태는 pass, fail, unsupported, unrun, blocked만 쓴다. unsupported는 현재 계약·플랫폼 문서나 소스 근거가 있을 때만 쓴다. 하드웨어·모델·인증·계정이 없으면 필요한 조건과 단계를 적어 blocked 또는 unrun으로 둔다.
- 모델 교체, token 한도 증가, hash 검사 생략, readiness 제거, 실패 skip, 근거 없는 timeout 확대로 pass를 만들지 않는다. 원래 요청·모델·한도를 바꾼 대조는 별도 행으로 기록한다.
- Windows native unit 검사, Windows에서 실행한 Unix cfg(test) 검사, parser 검사, 합성 GUI/IPC 검사, 합성 echo, 다른 OS의 결과는 Linux pass가 아니다. 원래 Windows GUI 어댑터 수락은 과거 범위의 완료이며, 이후 Windows 수정은 각 source의 자동·합성 검사와 한정된 실제 관찰 범위만 인정하며, 마지막 updater 수정은 새 production GUI·실제 다운로드·설치를 실행하지 않았다.
- MLX·vllm-metal은 계약상 Apple Silicon macOS 전용이므로 Linux에서는 미지원 안내와 값 보존만 검사하고 Linux native 지원으로 기록하지 않는다. WSL·container·VM 결과는 native Linux desktop/GPU 결과와 분리한다.
- Strata는 https://github.com/Niko1221/Strata의 전체 revision을 고정하고 그 revision의 문서로 지원 OS·GPU·RAM·모델/파일 형식을 확인한다. 검토된 어댑터 revision은 296b59d2f73c8f04a805df29c2fa97655adace78이며 다른 revision은 어댑터 재검토가 필요하다. 모델 이름을 추측하거나 지원되지 않는 GPU 경로를 강제하지 않는다. deployment JSON의 CORS origin은 Linux production WebView에서 실제로 관찰한 값만 넣는다.
- 이미 기록된 엔진 출력 정책·모델 품질 잔여(WIN-Q01, WIN-Q02)는 어댑터 전송 결함과 분리한다. 공통 기능 코드에 새 engine ID 분기, 닫힌 3엔진 가정, 모델 종류 추정 필터, 프로필의 미지원 공통 옵션 전달을 추가하지 않는다.

5. 개선 규칙
- Linux가 처음 검증되는 플랫폼이므로 기능 공백부터 채운다. 개선 후보는 실제 실행이나 코드 경로로 확인한 버그·성능·UX·가독성·구조 문제이며, 측정 또는 실패 재현 → 최소 수정 → 회귀 검사(red→green) → 전체 관련 검사 → 실제 재검사 순서로 처리한다.
- 공개 API, 저장 schema, 설정 형식, 독립적인 최신성·보안·무결성 검사를 보존한다. 책임·의존 근거 없이 폴더를 대규모로 옮기지 않는다. 합성 측정을 GUI 전체 지연이나 실제 엔진 속도로 표현하지 않는다.
- 공통 코드를 바꾸면 engine-adapter-linux-macos-handoff.ko.md의 재검증 연결표에 따라 관련 Windows 검사와 자동 회귀를 갱신한다. Windows 기기를 쓸 수 없으면 필요한 Windows 재실행 항목을 결과 문서에 남기고 Windows pass를 만들어 쓰지 않는다.

6. 기록과 커밋
- raw 로그·캡처·개인 경로는 tmp/linux-acceptance/에, 항목별 진행 상태·다음 작업·blocker는 tmp/linux-acceptance/progress.md에 둔다. 익명화한 결과는 실제 실행 뒤 docs/reference/linux-device-validation-results.ko.md에 항목 ID, 상태, source·runtime·model revision과 hash, 재현 절차, 원인, 수정 commit, 검사, 실제 재검사, 다음 작업·blocker로 기록한다. 개인 경로·계정·장치 식별자·IP/PID·자격 증명·원본 사용자 기록은 커밋하지 않는다.
- 작업 단위로 code/test/doc만 commit한다. git status --short로 확인해 필요한 경로만 stage하고 git diff --cached --name-only, git diff --cached, git diff --cached --check로 검토한다. tmp/, build 산출물, key, 사용자 데이터는 넣지 않는다. 기존 이력을 다시 쓰지 않고 push하지 않는다.

7. goal 운영
- goal 도구가 있으면 먼저 현재 goal을 조회한다(get_goal 등). 이 목표와 같은 goal이 있으면 그것을 이어서 사용하고, 없을 때만 token_budget 없이 새로 만든다. 다른 미완료 goal을 이 목표로 교체하거나 덮어쓰지 않는다.
- goal 도구가 없으면 실제 지원 여부와 활성화 방법을 확인해 알린다. 등록 없이 goal을 시작했다고 보고하지 않는다.
- 사용자가 요청하지 않으면 pause하지 않는다. 일부 완료·자동 검사 통과·컨텍스트나 시간 부족을 이유로 complete로 바꾸지 않는다. blocked는 실행 가능한 독립 작업을 모두 마친 뒤 같은 외부 조건 때문에 연속 3번의 goal turn에서 진전이 없을 때만 쓰고, 필요한 조건과 사용자가 할 일을 구체적으로 적는다. 관리자 권한·별도 계정·사람의 OS 조작이 필요한 단계는 구체적인 테스트 계정·checkpoint와 함께 요청하고, 기다리는 동안 독립 항목을 계속한다.
- 하위 에이전트를 쓸 수 있는 환경이면 작업마다 Claude → agy → OpenCode → 내장 에이전트 순으로 쓰되, 다음 경로로 넘어가는 것은 앞 경로가 실제로 실패했을 때뿐이다. 관찰 timeout이나 quota 경고만으로 실패로 간주하지 않는다. 끝났거나 취소된 이전 worker에 작업을 보내지 않는다.
```
