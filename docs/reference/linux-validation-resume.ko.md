# Linux 검증 재개 인계

2026-10-27 기준 검증 결과와 남은 작업을 정리한다. **Linux 전체 검증은 미완료**다. 제품 수정·자동 검사·실제 검증 결과를 보존하고 남은 범위를 이어서 수행한다. 이 문서는 기존 74개 계약을 대체하거나 목표를 줄이지 않는다.

## 저장소와 읽을 순서

- 원격: `https://github.com/aiolm/AioLM.git`
- 작업 브랜치: `codex/linux-runtime-adapter-validation`
- 고정19 엔진 여정 결과 문서 commit: `5c414854904e78fc7a7b69d06f20e554eff5ed48` (이 인계 문서 commit의 조상)
- 최신 데스크톱 제품 코드 commit: `43830d37dd839029192feb2e2c5a47061442947a`
- 원래 수신 commit: `3e2c67d4d6dd2742ee8f9997797d31f244f234de`
- 필수 원래 인계 조상: `df3264bad99deb0144b947f96300e8625f7a2da5`

먼저 현재 Git 상태/이력과 `AGENTS.md`, 존재한다면 `tmp/AGENTS.local.md`를 읽는다. 이어서 다음을 읽는다.

1. [Linux 실행 계약 전체](linux-device-handoff.ko.md)
2. [74개 판정과 실제 결과 전체](linux-device-validation-results.ko.md), 특히 고정22의 Linux 창 복원·다중 화면·새 실제 엔진 회귀와 F09 전처리 대조 절
3. [Windows/Mac 후속 인계](engine-adapter-linux-macos-handoff.ko.md)
4. `runtime-adapter-handoff.ko.md`, `pluggable-inference-runtimes.ko.md`, `inference-runtimes.md`, `provider-native-acceptance.md`, `cross-platform-validation.md`, `efficiency-review.ko.md`
5. `docs/guides/development.ko.md`, `docs/guides/install.ko.md`, `package.json`, `src-tauri/Cargo.toml`

가능하면 현재 같은 작업 디렉터리에서 이어서 진행한다. 다른 checkout에서는 fetch 후 해당 브랜치와 조상 관계를 확인하며 기존 변경/다른 worktree를 초기화하지 않는다.

## 확정된 현재 상태

전체74개는 **67 pass / 1 fail / 4 unrun / 1 unsupported / 1 blocked**다. 통과 항목도 각 source·입력·기기·조건의 근거 범위를 유지한다. 과거 Windows/Mac이나 다른 고정점의 결과를 현재 Linux 전체 실행으로 확대하지 않는다.

최신 고정22는 Linux에서 최소화된 기존 창이 두 번째 실행으로 복원되지 않는 실제 결함을 수정했다. 두 물리 출력 활성화·화면 이동·작은 창/최대화·DPR2·같은 창/포커스 복원과 원래 화면 설정 복구를 확인해 D04를pass로 갱신했다. 추출 AppImage AppRun의 실제 복원도 통과했다. 전체 자동 검사·새 패키지·고정 뒤 생성한 개인 CPU 엔진의 실제 GUI/CLI·정상 종료/재열기와 native6파일 보존은 [고정22의 정확한 범위](linux-device-validation-results.ko.md#고정22-linux-창-복원과-다중-화면)를 따른다. 원래 실패/부분 스크립트와 환경 오류를 최종 성공으로 덮어쓰지 않았다.

고정21은 깊은 JSON 붙여넣기로 앱 전체가 오류 화면으로 바뀌는 문제의 수정이다. 실제 고정20 실패와 두 제어형 폼의 예외를 재현했다. 숫자 검사 뒤 현재 엔진의 직렬화 가능 여부를 확인하고 사용할 수 없는 초안을 기존 입력 오류 경로에 남긴다. 전체 npm221파일/2597검사·최종 관련100검사/typecheck/lint·DEB/AppImage 빌드·고정 CLI smoke를 통과했다. 중간 테스트 타입 이름 수정 전후 생성 JS가 같은 근거도 보존했다. [고정21의 실제 결과와 배포 해시](linux-device-validation-results.ko.md#고정21-깊은-json-입력의-오류-화면-방지)를 먼저 읽는다. 실제 새 GUI의 같은100,001자 붙여넣기에서 화면·초안·native 설정 보존/Save 차단과 정상 JSON18 복구·저장·argv/합성 응답·정상 Close/별도 재열기를 확인했다. 고정 뒤 만든 새 개인 CPU 옵션의 실제 GUI 추론·내용 Stop/같은 PID Retry·새 PID 재시작/health·로드 상태 Close·별도 재열기의3/32/T0·이력/자동 시작 없음과 CLI A01–A09도 끝냈다. 알려진23개 생성 식별과7개 포트는 종료됐고 원본 receipt를 유지한893개 source blob이 제품 commit과 같다.

고정20의 JSON 숫자 손실·문자열 표시 수정도 원래 범위로 유지한다. 전체 npm(Vitest221파일/2595검사)·최종 typecheck/lint·DEB/AppImage 빌드·새 release CLI smoke와 실제 GUI 등록/help·JSON 거부/저장·정상 Close/별도 재열기·native 가져오기·실제 합성 argv/응답·정리를 확인했다. [고정20의 정확한 범위와 배포 해시](linux-device-validation-results.ko.md#고정20-json-옵션-숫자-경계와-타입-보존)를 따른다.

같은 고정20 뒤 만든 [새 개인 CPU 엔진의 실제 GUI·CLI](linux-device-validation-results.ko.md#고정20-새-개인-cpu-엔진의-실제-gui와-cli)도 추가 확인했다. 일반 등록/help261·새 옵션3 저장·실제 argv/health·답변5/usage33+2·내용 Stop/같은 PID Retry·새 PID 시작·로드 상태 정상 Close·별도 재열기의3/32/T0·네 메시지 이력/자동 시작 없음·최종 Close를 확인했다. 같은 CLI의 A01–A09도3.830초/exit0이다. GUI의32/T0와 기존 CLI harness의 산술32/취소1024·temperature 미지정은 구분한다. 최종12birth/네 포트 종료·전체 전용 설정 보존·제품/기존 개인 엔진 바이트 일치를 확인했고 모든 새 실행은 종료됐다. 이 범위로 고정19의 다른 backend·설치·IME·알림을 재실행했다고 하지 않는다.

기존 고정19의 전체 npm(220파일/2577검사)·typecheck·lint·Rust all-targets/all-features·Clippy·fmt·no-default check·production package·native CLI smoke 기록은 각 범위로 유지한다. Rust 코드는 이번에 바뀌지 않았고 Rust 전체 검사를 새로 실행했다고 표시하지 않는다. 고정19의 실제 엔진/IME/설치/알림 결과를 고정20에서 모두 다시 실행한 것으로 옮기지 않는다.

고정19 뒤 생성한 새 합성 엔진과 개인 CPU 옵션의 실제 CLI/GUI 등록·help·검증·프로필 저장·argv·Ready·산술/usage·내용 Stop·동일 PID/본문 Retry·새 PID 재시작을 확인했다. 로드된 정상 Quit→같은 프로필 별도 재열기/저장3·32/T0·자동 시작 없음→최종 정상 Close까지 끝냈다. 원본 검사기 exit1들과 도달 지점별 후속 실제 실행/파일 감사는 모두 보존하며 원본 전체 exit0으로 바꾸지 않는다.

새 엔진 여정 종료 뒤 UTC2026-10-26T00:06:25Z 검사에서 양성 식별9birth·네 포트 종료, 원래 driver의 빈 ready 상태, source34/DB·현재 native18파일·프로필/이력·네 UI 값 보존을 확인했다. 사용자878/1,560개 파일의 hash-only 대조는 변경·누락·오류0이었다. 기존 IBus/접근성/desktop 설정도 같았고 archive8/payload6/SDK3 바이트를 다시 확인했다. 새 접두사 부재 검사는 문서에 해당 이름을 공개하기 전에 끝냈다. 현재 문서에 이름이 있으므로 이 사전 공개 전용 검사를 그대로 재실행해서는 안 된다.

추가로 [고정19 실제 OS 알림 표시](linux-device-validation-results.ko.md#고정19-실제-os-알림-표시)에서 단일 Send의279개 양성 표시 표본과 제목·본문을 보았다는 사용자 확인, 정상 종료·자료 보존까지 확인해 D05를pass로 갱신했다. 최종 보존 근거는 `tmp/linux-acceptance/source19-manual-notification-final-guard/run/result.json`(SHA-256 `70a165eea787da34eb1d17350cc72ca1626d3982999ceadf8b3ba38e3decc6b1`)이며, 과거 ID45/48의 미표시 표본은 유지한다. 최신 원본 사용자 자료 guard는 이 추가 실행의 종료 뒤 결과를 우선한다.

추가로 [b11868 single-view 소스 준비 도구](linux-device-validation-results.ko.md#b11868-single-view-소스-준비-도구)는 감사한 전체 revision을 명시하는 `--revision`을 지원한다. 기본 b11460·해시/출력 경계·audit schema는 유지한다. Python17검사와 실제 원본 준비/CPU 빌드·같은 raw 요청의 응답/usage·정리를 확인했다. 이 개발 도구 후속은 데스크톱 고정22를 재빌드하거나 F09의 내용 실패를 통과로 바꾼 결과가 아니다. 원본은 `tmp/linux-acceptance/native-singleview-source23/`에 있다.

## 남은 항목과 다음 실행

| ID | 상태 | 정확한 남은 범위/재개 조건 |
| --- | --- | --- |
| L02-F09 | fail | 원래 모델/projector/PNG·raw 요청·32/T0를 유지한다. 독립 tokenizer의 전체49,280개 어휘/원래93개 ID가 같고, 원래 GGUF의 독립·native 디코더가 EOS까지 같은 오답이었다. 공식13보기/888토큰에서도 원래 GGUF·공개 텍스트 가중치·공개471개 전체 모델 모두 같은 `1`을 냈다. 공개 원본에서 선언된 dtype/고정 Q8 변환으로471개 tensor를 정확히 재구성했다. [수치·전처리·설정 대조 전체](linux-device-validation-results.ko.md#f09-독립-tokenizer텍스트-디코더픽셀-대조)를 읽고 완료한 제어를 반복하지 않는다. 이 입력 구성의 품질 잔여를 보존하며 실제 수정 근거를 확보하면 원래 기준을 재검증한다. |
| L03-D07 | unrun | EN/KO/JA/ZH updater 가능·불가의 실제 조건부 안내 조합. 기존 일반 알림 설정/종료/현재 버전 안내는 부분 근거다. |
| L03-U02 | unrun | 실제 DEB/AppImage 설치 가능 판별과 소유/arch 불일치 안내의 최종 UI. |
| L03-U03 | unrun | 실제 설치 가능/불가 classifier·진행·installer·release 이동. 기존 Check 오류/버튼 회복·동률 재열기는 부분 검증이다. |
| L03-U04 | blocked | 실제 더 새 공개 release로 통제된 계정/VM에서 업데이트. 공식 latest와 공개 release16개 목록을 함께 조회한 UTC2026-10-27T03:10:59Z에도 v0.3.1/실제 asset10개가 최신이었다. 동률에서는 설치 판별을 단락 평가해 실행하지 않으므로 U02/U03/D07의 나머지 조건도 열리지 않는다. 재개 시 공식 release를 다시 확인한다. 버전 조작이나 가짜 release로 대체하지 않는다. |
| L02-N09 | unrun/선택 | 원래 Windows 품질 입력/산출물이 없어 동등 대조 불가. 다른 Linux 입력으로 대신하지 않는다. |
| L02-N08 | unsupported | 관리형 MLX/vllm-metal의 macOS/Apple Silicon 계약에 따른 Linux 미지원. 실제 Linux 선택/관리 안내와 저장값 보존은 확인했다. 하드웨어가 없다는 이유의 임의 unsupported 판정이 아니다. |

먼저 위 계약과 원본 근거를 대조해 요건별 완료 감사를 끝내고, 실행 가능한 독립 항목부터 수행한다. 창/인스턴스 D04와 알림 D05는 완료됐으며 이전 ID45/48/50의 앱과 관찰기는 모두 종료됐다. 새 결함이나 변경 범위가 없다면 같은 표시 검사를 반복하지 않는다. 같은 실패 입력을 의미 없이 반복하거나 제품 결함 근거 없이 설정/모델/timeout을 바꾸지 않는다.

고정20 JSON 경계·저장/재열기·실제 합성 argv/응답 검사는 끝났고 전용 앱/엔진은 종료됐다. 단순 반복할 필요는 없다. 큰 정수 무손실 GUI/IPC 지원은 아직 구현하지 않았으며, JSON 수를 문자열로 바꿔 엔진 입력을 보정하지 않는다. 재열기의 help stale 관측은 [identity 기록 대조](linux-device-validation-results.ko.md#고정20-도움말-identity-기록-대조)에서 `XDG_RUNTIME_DIR`의 변화로 두 원본 fingerprint를 정확히 재현했다. 실제 자식 환경이 달라진 정상 무효화였으며 작업 폴더 자체는 같았다. 이 관측 때문에 같은 GUI 여정을 반복하거나 환경 비교를 완화할 필요는 없다.

## 같은 PC에만 남아 있는 원본 근거

`tmp/`와 빌드·모델·개인 사용자 자료는 Git에 올리지 않는다. 다음은 저장소 루트 기준 로컬 경로다.

- `tmp/linux-acceptance/linux-window-restore-source22/`: 창 복원 수정/전체 검사·독립 패키지·새 개인 엔진 실제 GUI/CLI와 종료/재열기. `source22-final-guard.json`(SHA-256 `ec6f5d4595225afced9819c52922bd9fc1da2f3232267ba46ca3968bfeacaa65`)의39핀과 `source22-commit-join.json`을 함께 읽는다. 실제 화면 before/after는 `two-display-preflight-v1/`, `two-display-source22/`, 추출 AppRun은 `appimage-window-source22/`이며 원래 화면은 복구됐고 모든 검증 앱은 종료됐다.
- `tmp/linux-acceptance/f09-vision-tensor-control-v1/`: 동일 projector198개 tensor·native 픽셀의 층별/최종 투영 대조, 기준 특징 대체의 동일 오답과 실제 prefill93개 ID 일치. `final-guard-v2.json`(SHA-256 `336c40c16e46fccccee2b0bcdf2c7597da06ed13d7b3c8bcc6689a1bacb7a2d0`)의50핀을 읽는다. 두 진단 서버와 기준 계산은 종료됐다. 첫 출력 buffer/float32 집계의 범위도 원본으로 구분한다.
- `tmp/linux-acceptance/f09-language-reference-v1/`: 독립 tokenizer/텍스트 수치·정상 RGB/Pillow 대조·세 설정 HTTP 대조·공식13보기 기준·공개471개 원본과 GGUF의 정확한 변환 재구성·텍스트 양자화 제어·공식 전체 multimodal 모델의 같은 오답. `final-guard.json`(SHA-256 `d5822d58b815c2c818a85551c28281956b31ea1967a0149d47a3451098b7ed33`)의173핀과 원본 실패를 함께 읽는다. 새 계산·서버는 모두 종료됐다. 가중치·원래 기준·품질 판정과 진단용 입력/구현의 범위를 구분하며 모델 자료를 Git/배포물에 포함하지 않는다.
- `tmp/linux-acceptance/residual-acceptance-audit-v1/`: 캐시 재사용을 요청하지 않은 최신 공식 release/전체 공개16개 목록·서버 Date와 source의 실제 updater 분기 조건 대조. 완료한 동률 확인이 설치 판별/진행/설치 여정을 대신하지 않는 근거다.
- `tmp/linux-acceptance/f09-singleview-control-v1/`: 원래 raw 요청/모델/한도를 유지한 native before/after와 longest-size 진단의5회 실제 추론·관측/정리, 합성 pixel-shuffle 대조. 내용 실패를 보존한다.
- `tmp/linux-acceptance/resume-20261027-review/`: 고정21의 실제/렌더된 입력 실패·최소 수정 검사·freeze·패키지/25개 내부 symlink 검사·합성/개인 GUI 네 실행·재열기·정리 근거. `baseline-causal-reproduction.json`, `source21-final-guard.json`(SHA-256 `17f7ac08cc1af3646ad9b9a08bd30bfb8751202661167104b329094d26f37baf`), `source21-commit-join.json`을 함께 읽는다. 원래 자동화 오류/exit1·타입 검사 오류와 보정 전 receipt도 그대로 있다. 새 개인 엔진 build/manifest/provenance는 `tmp/linux-acceptance/personal-engine-source21/`이다.
- `tmp/linux-acceptance/resume-20261026T151655Z/`: 고정20의 최초 실패/검사·freeze·패키지544파일 검사·actual GUI/가져오기/argv/응답·두 Close와 새 source 연결 근거. `root-validation-outcome.json`, `root-observation-corrections.json`, `commit-source-join.json`, `final-guard.json`을 함께 읽는다. 이후 `help-stale-audit-v1/root-causal-acceptance.json`이 원래 미확정 stale 원인의 대조 결과를 추가한다.
- `tmp/linux-acceptance/personal-engine-source20/`: 고정20 뒤 생성한 개인 CPU 옵션·독립 upstream checkout/패치·native build·manifest/provenance. 실제 GUI 두 실행과 CLI 결과는 위 재개 폴더의 `gui-personal20/`, `gui-personal20-reopen/`, `personal20-cli/`에 있으며 `personal20-final-guard.json`(SHA-256 `133eb099a65bcb798a4be22255995a89e5e14e5d15909bc3cf68feda2afcd614`)이 실제 파일/보존/정리 근거를 연결한다.
- `tmp/linux-acceptance/progress.md`: 누적 실행 기록. 마지막 checkpoint-v2는 종료 전 상태이므로 최신 기록/아래 final guard를 우선한다.
- `tmp/linux-acceptance/source19-fresh-engines-context/root-status-checkpoint-v3.json`: 최종 Close 기록. 이후 최종 guard와 문서 commit은 progress에 추가돼 있다.
- `tmp/linux-acceptance/source19-core-finalization/root-core-accepted.json`: 원본 실패를 보존한 실제 핵심 여정의 연결 근거와13개 raw pin.
- `tmp/linux-acceptance/source19-fresh-engines-lifecycle-v3/`: 실제 첫 Quit·별도 재열기·최종 Close의 root 실행/관측 기록.
- `tmp/linux-acceptance/source19-final-guard-preparation-v2/run/result.json`: 최종 실제 guard, SHA-256 `79c639199a5269bc490164213b6d339208064152cbd3746358b82ed505a89258`.
- `tmp/linux-acceptance/source19-final-guard-preparation-v2/run/frozen-and-absence.json`: 문서 공개 전 archive/payload/SDK·ASCII/UTF-16LE 접두사 검사.
- `tmp/linux-acceptance/freezes/source19-195005/`: production 고정 사본과 원래 receipt. receipt를 덮어쓰거나 과거 HEAD+diff를 새 commit으로 꾸미지 않는다.
- `tmp/linux-acceptance/source19-notification-continuous-preparation/`: 단일 Send/277표본·관찰기 종료와 geometry의 원본.
- `tmp/linux-acceptance/source19-clock-accessibility-route-audit/REPORT.md`: 시계 메뉴의 source 조사만 있다. 실제 유일한 Action 발견/활성화 근거는 없으므로 임의 메뉴/좌표/Action index를 가정하지 않는다.
- `tmp/linux-acceptance/source19-manual-notification-display/`: 새 알림 표시 검사의 앱 실행·엄격한 재확인·설정 준비·정상 Close 원본.
- `tmp/linux-acceptance/source19-manual-notification-observation/`: 단일 Send ID50·양성279/음성280표본·사용자 확인·D05 판정 원본. 관찰기는 종료됐다.
- `tmp/linux-acceptance/source19-manual-notification-final-guard/run/result.json`: 새 표시 검사 종료 뒤 원본 자료·현재 UI4/preferences·배포 파일 최종 보존 검사.
- `tmp/linux-acceptance/source19-resumed-completion-audit-v1/`: 최신 공식 release 조회·원래 미디어 바이트 감사·재개 시 요건별 완료 감사.
- `tmp/linux-acceptance/source19-media-contract-audit-v1/`: 원래 GGUF 헤더·고정 upstream/base source 대조와 전처리 가설. 실제 native 전처리/렌더링을 새로 실행한 근거가 아니다. 실제 VM 읽기 전용 조회·보존 검사는 `root-VM-readonly-outcome.json`(SHA-256 `a6e44e4129e2489643c2e187a14f6be48b564f4721ee3df47dc33adc87fb433e`)에 있다. 세 후속 저장 설정은 확인했으나 원래 F09의 전체 argv/렌더링/tensor 경로를 복구한 결과는 아니다.

새 PC/clone에는 이 원본과 모델/VM/산출물이 없을 수 있다. 원본이 없으면 부재를 명시하고 필요한 검증 환경과 합성 자료를 새로 준비한다. 공개 결과 문서만으로 기존 로컬 자원의 현재 생존·데이터 무변경을 주장하지 않는다. 원본 사용자 설정/대화/키를 fixture나 배포물로 복사하지 않는다.

## 개발·검증 원칙

- 검증→원인 조사→최소 수정→관련 자동 검사→실제 재검증을 이어간다. 성능·UI/UX·가독성·폴더 책임 검토도 범위에 포함한다. 변경 근거·사용자 영향·전후 결과를 연결한다.
- 실제 설치·이전·제거·자격 증명 검사는 격리 계정 또는 VM에서 수행한다. 원본 사용자 자료와 기존 시스템 설정을 보존한다.
- 프로세스와 포트 정리는 해당 테스트가 생성하고 소유권을 확인한 자원에 한정한다. PID 숫자의 재사용을 소유권으로 간주하지 않는다.
- Windows W/G·Mac M01–M04/MAC-R01–R13은 기존 인계의 정확한 재실행 범위를 유지한다. Linux 결과를 다른 OS pass로 옮기지 않는다. 실제 Mac 검증은 Linux 완료 조건이 아니다.
- 필수 항목에 fail/unrun/blocked가 남으면 Linux 검증 완료로 판정하지 않는다. 원본 실패·부분 성공·최종 판정과 각 실행의 source/조건을 구분해 기록한다.
- 필요한 코드·검사·문서만 커밋하며 `tmp/`·빌드·원본 자료는 제외한다. 기존 변경과 이력을 보존한다.
