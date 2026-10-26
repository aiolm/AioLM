# Linux 검증 재개 인계

2026-10-26 기준 검증 결과와 남은 작업을 정리한다. **Linux 전체 검증은 미완료**다. 제품 수정·자동 검사·실제 검증 결과를 보존하고 남은 범위를 이어서 수행한다. 이 문서는 기존 74개 계약을 대체하거나 목표를 줄이지 않는다.

## 저장소와 읽을 순서

- 원격: `https://github.com/aiolm/AioLM.git`
- 작업 브랜치: `codex/linux-runtime-adapter-validation`
- 고정19 엔진 여정 결과 문서 commit: `5c414854904e78fc7a7b69d06f20e554eff5ed48` (이 인계 문서 commit의 조상)
- 최신 제품 코드 commit: `37c0343fe90b16588b2319f3ace96e6df274bf02`
- 원래 수신 commit: `3e2c67d4d6dd2742ee8f9997797d31f244f234de`
- 필수 원래 인계 조상: `df3264bad99deb0144b947f96300e8625f7a2da5`

먼저 현재 Git 상태/이력과 `AGENTS.md`, 존재한다면 `tmp/AGENTS.local.md`를 읽는다. 이어서 다음을 읽는다.

1. [Linux 실행 계약 전체](linux-device-handoff.ko.md)
2. [74개 판정과 실제 결과 전체](linux-device-validation-results.ko.md), 특히 마지막 고정19 절
3. [Windows/Mac 후속 인계](engine-adapter-linux-macos-handoff.ko.md)
4. `runtime-adapter-handoff.ko.md`, `pluggable-inference-runtimes.ko.md`, `inference-runtimes.md`, `provider-native-acceptance.md`, `cross-platform-validation.md`, `efficiency-review.ko.md`
5. `docs/guides/development.ko.md`, `docs/guides/install.ko.md`, `package.json`, `src-tauri/Cargo.toml`

가능하면 현재 같은 작업 디렉터리에서 이어서 진행한다. 다른 checkout에서는 fetch 후 해당 브랜치와 조상 관계를 확인하며 기존 변경/다른 worktree를 초기화하지 않는다.

## 확정된 현재 상태

전체74개는 **66 pass / 1 fail / 5 unrun / 1 unsupported / 1 blocked**다. 통과 항목도 각 source·입력·기기·조건의 근거 범위를 유지한다. 과거 Windows/Mac이나 다른 고정점의 결과를 현재 Linux 전체 실행으로 확대하지 않는다.

고정19의 전체 npm(220파일/2577검사)·typecheck·lint·Rust all-targets/all-features·Clippy·fmt·no-default check·production package·native CLI smoke는 통과했다. 상세 명령/시각/검사 범위는 결과 문서에 있다. 이후 제품 바이트는 바뀌지 않았고 추가 변경은 검증 결과 문서다. 문서 변경 때문에 전체 빌드를 반복할 필요는 없지만 제품을 수정하면 해당 검사와 실제 production 여정을 다시 실행한다.

고정19 뒤 생성한 새 합성 엔진과 개인 CPU 옵션의 실제 CLI/GUI 등록·help·검증·프로필 저장·argv·Ready·산술/usage·내용 Stop·동일 PID/본문 Retry·새 PID 재시작을 확인했다. 로드된 정상 Quit→같은 프로필 별도 재열기/저장3·32/T0·자동 시작 없음→최종 정상 Close까지 끝냈다. 원본 검사기 exit1들과 도달 지점별 후속 실제 실행/파일 감사는 모두 보존하며 원본 전체 exit0으로 바꾸지 않는다.

새 엔진 여정 종료 뒤 UTC2026-10-26T00:06:25Z 검사에서 양성 식별9birth·네 포트 종료, 원래 driver의 빈 ready 상태, source34/DB·현재 native18파일·프로필/이력·네 UI 값 보존을 확인했다. 사용자878/1,560개 파일의 hash-only 대조는 변경·누락·오류0이었다. 기존 IBus/접근성/desktop 설정도 같았고 archive8/payload6/SDK3 바이트를 다시 확인했다. 새 접두사 부재 검사는 문서에 해당 이름을 공개하기 전에 끝냈다. 현재 문서에 이름이 있으므로 이 사전 공개 전용 검사를 그대로 재실행해서는 안 된다.

추가로 [고정19 실제 OS 알림 표시](linux-device-validation-results.ko.md#고정19-실제-os-알림-표시)에서 단일 Send의279개 양성 표시 표본과 제목·본문을 보았다는 사용자 확인, 정상 종료·자료 보존까지 확인해 D05를pass로 갱신했다. 최종 보존 근거는 `tmp/linux-acceptance/source19-manual-notification-final-guard/run/result.json`(SHA-256 `70a165eea787da34eb1d17350cc72ca1626d3982999ceadf8b3ba38e3decc6b1`)이며, 과거 ID45/48의 미표시 표본은 유지한다. 최신 원본 사용자 자료 guard는 이 추가 실행의 종료 뒤 결과를 우선한다.

## 남은 항목과 다음 실행

| ID | 상태 | 정확한 남은 범위/재개 조건 |
| --- | --- | --- |
| L02-F09 | fail | 원래 Smol 내용 정확도가 native 직접 대조에서도 실패했다. 원래 입력·모델/projector·32/T0를 유지한다. 템플릿은 고정 HF base와 같고 런타임도 SmolVLM으로 구분한다. 오래된 projector의 전처리 크기 항목 누락은 native 호환 경로 가설이며 실제 원래 branch/렌더링 관측이 필요하다. 모델·입력·한도 변경이나 앱 전용 분기로 통과시키지 않는다. |
| L03-D04 | unrun | 실제 다중 활성 화면 간 이동 검증. 최신 UTC2026-10-26T09:36 조회도 물리2개/활성 logical·output1개/scale2였고 사용자가 두 번째 출력 활성화 불가를 확인했다. 기존 최소화·두 번째 실행·작은 창·DPR2 근거는 유지한다. 실제 두 출력 활성화와 관련 사용자 조작을 확인해야 하며 설정 변경 권한을 추정하지 않는다. |
| L03-D07 | unrun | EN/KO/JA/ZH updater 가능·불가의 실제 조건부 안내 조합. 기존 일반 알림 설정/종료/현재 버전 안내는 부분 근거다. |
| L03-U02 | unrun | 실제 DEB/AppImage 설치 가능 판별과 소유/arch 불일치 안내의 최종 UI. |
| L03-U03 | unrun | 실제 설치 가능/불가 classifier·진행·installer·release 이동. 기존 Check 오류/버튼 회복·동률 재열기는 부분 검증이다. |
| L03-U04 | blocked | 실제 더 새 공개 release로 통제된 계정/VM에서 업데이트. 최신 공식 latest 조회(UTC2026-10-26T09:34:52Z)는 v0.3.1로 현재와 같았다. 재개 시 공식 release를 다시 확인한다. 버전 조작이나 가짜 release로 대체하지 않는다. |
| L02-N09 | unrun/선택 | 원래 Windows 품질 입력/산출물이 없어 동등 대조 불가. 다른 Linux 입력으로 대신하지 않는다. |
| L02-N08 | unsupported | 관리형 MLX/vllm-metal의 macOS/Apple Silicon 계약에 따른 Linux 미지원. 실제 Linux 선택/관리 안내와 저장값 보존은 확인했다. 하드웨어가 없다는 이유의 임의 unsupported 판정이 아니다. |

먼저 위 계약과 원본 근거를 대조해 요건별 완료 감사를 끝내고, 실행 가능한 독립 항목부터 수행한다. 알림 D05는 완료됐으며 이전 ID45/48/50의 앱과 관찰기는 모두 종료됐다. 새 결함이나 변경 범위가 없다면 같은 표시 검사를 반복하지 않는다. 같은 실패 입력을 의미 없이 반복하거나 제품 결함 근거 없이 설정/모델/timeout을 바꾸지 않는다.

## 같은 PC에만 남아 있는 원본 근거

`tmp/`와 빌드·모델·개인 사용자 자료는 Git에 올리지 않는다. 다음은 저장소 루트 기준 로컬 경로다.

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
- `tmp/linux-acceptance/source19-media-contract-audit-v1/`: 원래 GGUF 헤더·고정 upstream/base source 대조와 전처리 가설. 실제 native 전처리/렌더링을 새로 실행한 근거가 아니다.

새 PC/clone에는 이 원본과 모델/VM/산출물이 없을 수 있다. 원본이 없으면 부재를 명시하고 필요한 검증 환경과 합성 자료를 새로 준비한다. 공개 결과 문서만으로 기존 로컬 자원의 현재 생존·데이터 무변경을 주장하지 않는다. 원본 사용자 설정/대화/키를 fixture나 배포물로 복사하지 않는다.

## 개발·검증 원칙

- 검증→원인 조사→최소 수정→관련 자동 검사→실제 재검증을 이어간다. 성능·UI/UX·가독성·폴더 책임 검토도 범위에 포함한다. 변경 근거·사용자 영향·전후 결과를 연결한다.
- 실제 설치·이전·제거·자격 증명 검사는 격리 계정 또는 VM에서 수행한다. 원본 사용자 자료와 기존 시스템 설정을 보존한다.
- 프로세스와 포트 정리는 해당 테스트가 생성하고 소유권을 확인한 자원에 한정한다. PID 숫자의 재사용을 소유권으로 간주하지 않는다.
- Windows W/G·Mac M01–M04/MAC-R01–R13은 기존 인계의 정확한 재실행 범위를 유지한다. Linux 결과를 다른 OS pass로 옮기지 않는다. 실제 Mac 검증은 Linux 완료 조건이 아니다.
- 필수 항목에 fail/unrun/blocked가 남으면 Linux 검증 완료로 판정하지 않는다. 원본 실패·부분 성공·최종 판정과 각 실행의 source/조건을 구분해 기록한다.
- 필요한 코드·검사·문서만 커밋하며 `tmp/`·빌드·원본 자료는 제외한다. 기존 변경과 이력을 보존한다.
