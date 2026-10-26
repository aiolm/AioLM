# Linux 검증 재개 인계

2026-10-26 사용자 요청으로 현재 세션의 검증을 마무리하고 다른 세션/AI로 인계한다. **Linux 전체 검증은 미완료**다. 제품 수정·자동 검사·실제 검증 결과를 보존하고 남은 범위를 이어서 수행한다. 이 문서는 기존 74개 계약을 대체하거나 목표를 줄이지 않는다.

## 저장소와 읽을 순서

- 원격: `https://github.com/aiolm/AioLM.git`
- 작업 브랜치: `codex/linux-runtime-adapter-validation`
- 최신 검증 결과 문서 commit: `5c414854904e78fc7a7b69d06f20e554eff5ed48` (이 인계 문서 commit의 조상)
- 최신 제품 코드 commit: `37c0343fe90b16588b2319f3ace96e6df274bf02`
- 원래 수신 commit: `3e2c67d4d6dd2742ee8f9997797d31f244f234de`
- 필수 원래 인계 조상: `df3264bad99deb0144b947f96300e8625f7a2da5`

먼저 현재 Git 상태/이력과 `AGENTS.md`, 존재한다면 `tmp/AGENTS.local.md`를 읽는다. 이어서 다음을 읽는다.

1. [Linux 실행 계약 전체](linux-device-handoff.ko.md)
2. [74개 판정과 실제 결과 전체](linux-device-validation-results.ko.md), 특히 마지막 고정19 절
3. [Windows/Mac 후속 인계](engine-adapter-linux-macos-handoff.ko.md)
4. `runtime-adapter-handoff.ko.md`, `pluggable-inference-runtimes.ko.md`, `inference-runtimes.md`, `provider-native-acceptance.md`, `cross-platform-validation.md`, `efficiency-review.ko.md`
5. `docs/guides/development.ko.md`, `docs/guides/install.ko.md`, `package.json`, `src-tauri/Cargo.toml`

가능하면 현재 같은 작업 디렉터리에서 이어서 진행한다. 다른 checkout에서는 fetch 후 해당 브랜치와 조상 관계를 확인하며 기존 변경/다른 worktree를 초기화하지 않는다. 이번 인계 push 허가는 현재 작업 브랜치 게시에 한정한다. 후속 원격 push는 사용자 지시를 따른다.

## 확정된 현재 상태

전체74개는 **65 pass / 1 fail / 6 unrun / 1 unsupported / 1 blocked**다. 통과 항목도 각 source·입력·기기·조건의 근거 범위를 유지한다. 과거 Windows/Mac이나 다른 고정점의 결과를 현재 Linux 전체 실행으로 확대하지 않는다.

고정19의 전체 npm(220파일/2577검사)·typecheck·lint·Rust all-targets/all-features·Clippy·fmt·no-default check·production package·native CLI smoke는 통과했다. 상세 명령/시각/검사 범위는 결과 문서에 있다. 이후 제품 바이트는 바뀌지 않았고 추가 변경은 검증 결과 문서다. 문서 변경 때문에 전체 빌드를 반복할 필요는 없지만 제품을 수정하면 해당 검사와 실제 production 여정을 다시 실행한다.

고정19 뒤 생성한 새 합성 엔진과 개인 CPU 옵션의 실제 CLI/GUI 등록·help·검증·프로필 저장·argv·Ready·산술/usage·내용 Stop·동일 PID/본문 Retry·새 PID 재시작을 확인했다. 로드된 정상 Quit→같은 프로필 별도 재열기/저장3·32/T0·자동 시작 없음→최종 정상 Close까지 끝냈다. 원본 검사기 exit1들과 도달 지점별 후속 실제 실행/파일 감사는 모두 보존하며 원본 전체 exit0으로 바꾸지 않는다.

최종 UTC2026-10-26T00:06:25Z 검사에서 양성 식별9birth·네 포트 종료, 원래 driver의 빈 ready 상태, source34/DB·현재 native18파일·프로필/이력·네 UI 값 보존을 확인했다. 사용자878/1,560개 파일의 hash-only 대조는 변경·누락·오류0이었다. 기존 IBus/접근성/desktop 설정도 같았고 archive8/payload6/SDK3 바이트를 다시 확인했다. 새 접두사 부재 검사는 문서에 해당 이름을 공개하기 전에 끝냈다. 현재 문서에 이름이 있으므로 이 사전 공개 전용 검사를 그대로 재실행해서는 안 된다.

## 남은 항목과 다음 실행

| ID | 상태 | 정확한 남은 범위/재개 조건 |
| --- | --- | --- |
| L02-F09 | fail | 원래 Smol 이미지/영상 질문의 내용 정확도가 native 직접 대조에서도 실패했다. 원래 입력·모델/projector revision·한도를 유지해 원인을 조사한다. 전송/파서 결함과 모델 출력 품질을 구분하고 모델 교체·정답 보정·token 증가로 통과시키지 않는다. |
| L03-D04 | unrun | 실제 다중 활성 화면 간 이동 검증. 마지막 조회는 물리2개/활성 logical·output1개/scale2였다. 기존 최소화·두 번째 실행·작은 창·DPR2 근거는 유지한다. 실제 두 출력 활성화와 관련 사용자 조작을 확인해야 하며 설정 변경 권한을 추정하지 않는다. |
| L03-D05 | unrun | 실제 OS 배너 또는 알림센터 표시를 확인해야 한다. 연결 즉시 소실 결함은 수정됐고 실제 ServiceUnknown 뒤 앱 복구도 검증했다. 정확한 Shell 객체의277표본/27.632초는 모두 SHOWING=false/유효하지 않은 좌표여서 표시 pass가 아니다. 수락/객체 생성과 표시를 구분한다. |
| L03-D07 | unrun | EN/KO/JA/ZH updater 가능·불가의 실제 조건부 안내 조합. 기존 일반 알림 설정/종료/현재 버전 안내는 부분 근거다. |
| L03-U02 | unrun | 실제 DEB/AppImage 설치 가능 판별과 소유/arch 불일치 안내의 최종 UI. |
| L03-U03 | unrun | 실제 설치 가능/불가 classifier·진행·installer·release 이동. 기존 Check 오류/버튼 회복·동률 재열기는 부분 검증이다. |
| L03-U04 | blocked | 실제 더 새 공개 release로 통제된 계정/VM에서 업데이트. 마지막 공식 latest 조회(UTC2026-10-25T21:51:29Z)는 v0.3.1로 현재와 같았다. 재개 시 공식 release를 다시 확인한다. 버전 조작이나 가짜 release로 대체하지 않는다. |
| L02-N09 | unrun/선택 | 원래 Windows 품질 입력/산출물이 없어 동등 대조 불가. 다른 Linux 입력으로 대신하지 않는다. |
| L02-N08 | unsupported | 관리형 MLX/vllm-metal의 macOS/Apple Silicon 계약에 따른 Linux 미지원. 실제 Linux 선택/관리 안내와 저장값 보존은 확인했다. 하드웨어가 없다는 이유의 임의 unsupported 판정이 아니다. |

먼저 위 계약과 원본 근거를 대조해 요건별 완료 감사를 끝내고, 실행 가능한 독립 항목부터 수행한다. 실제 표시가 필요하면 새로 통제한 테스트를 준비해 사용자에게 구체적인 조작을 안내한다. 이전 알림 ID45/48의 앱은 이미 종료됐으므로 오래된 질문에 대한 답이나 알림을 현재 live 검사로 사용하지 않는다. 같은 실패 입력을 의미 없이 반복하거나 제품 결함 근거 없이 설정/모델/timeout을 바꾸지 않는다.

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

새 PC/clone에는 이 원본과 모델/VM/산출물이 없을 수 있다. 원본이 없으면 부재를 명시하고 필요한 검증 환경과 합성 자료를 새로 준비한다. 공개 결과 문서만으로 기존 로컬 자원의 현재 생존·데이터 무변경을 주장하지 않는다. 원본 사용자 설정/대화/키를 fixture나 배포물로 복사하지 않는다.

## 운영과 보존

- Claude는 사용하지 않는다. 위임이 필요하면 Orca Orchestration skill을 따르고 agy→opencode→둘 다 실제 실패 시 내장 subagent 순서를 따른다. 이 세션에서는 agy quota/opencode usage의 실제 실패 뒤 fallback을 사용했다. 관찰 timeout만으로 실패를 단정하거나 새 세션의 외부 상태를 추정하지 않는다.
- Linux의 bare `orca`는 GNOME 화면 낭독기일 수 있다. 세션에 맞는 CLI/스킬을 확인하고 사용한다. 기존 IDE CLI는 `orca-ide`였고 Run은 `run_0d76ee4f77df`였다. 최종 inbox0/reclaimable0이며 사용자 보존 worker28개/released2개였다. 보존된 worker/다른 앱/기존 driver를 임의로 종료하지 않는다.
- 원래 외부 관리자 프로세스 PID10576은 이 검증의 관찰/채택/종료 대상이 아니다. 전역 프로세스나 다른 앱/알림 내용을 수집하지 말고 현재 양성 식별한 소유 자원만 다룬다. PID 숫자 재사용을 소유권으로 간주하지 않는다.
- 기존 native 개발 패키지 설치와 테스트 OS 계정/이 PC의 검증용 AioLM 설치·제거는 사용자 승인을 받았다. 기존 승인 범위를 보존하고 다른 시스템·파괴적 정리 권한으로 확대하지 않는다. 실제 설치/이전/제거/자격 증명은 격리 계정 또는 VM에서 검사한다.
- 검증→원인 조사→최소 수정→관련 자동 검사→실제 재검증을 이어간다. 성능·UI/UX·가독성·폴더 책임 검토도 원래 목표에 포함된다. 변경 근거·사용자 영향·전후 결과를 연결한다.
- Windows W/G·Mac M01–M04/MAC-R01–R13은 기존 인계의 정확한 재실행 범위를 유지한다. Linux 결과를 다른 OS pass로 옮기지 않는다. 실제 Mac 검증은 Linux 완료 조건이 아니다.
- 목표 도구가 있으면 먼저 실제 goal을 조회한다. 같은 미완료 목표를 재사용하고 다른 목표를 임의 교체하지 않는다. 새 스레드에 목표가 없다면 원래 전체 범위로 생성하되 token budget을 임의 설정하지 않는다. 필수 fail/unrun/blocked가 남으면 complete로 표시하지 않는다.
- 작업별 필요한 경로만 stage하고 cached 실제 diff·파일 목록·개인정보·공백을 확인한 뒤 커밋한다. `tmp/`·빌드·원본 자료는 제외한다. 기존 이력은 다시 쓰지 않는다. 인계 이후 작업의 push는 별도 지시를 따른다.
