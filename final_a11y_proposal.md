# 최종 접근성 수정 제안서 (final) — llama-board

- 작성일: 2026-09-08 (UTC)
- 원본: `antigravity_a11y_audit.md` (Coordinator 정밀 감사) + `opencode_a11y_audit.md` (Worker 감사)
- 방법: 두 보고서 전 항목을 코드(`src/`)에서 재검증한 뒤 통합. 검증 결과와 원본이 다를 경우 본서를 우선.
- 기준: WAI-ARIA 1.2, WCAG 2.2 AA.

## 1. 비교 결론 (3줄)

- 두 감사는 5개 항목에서 일치했고(대화상자 포커스 복귀, 모바일 스레드 패널, details Esc, slider 미번역, pre 스크롤), 모두 코드 검증으로 확정됐다.
- Antigravity 고유 5건 중 4건 확정 + 1건 부분 정정(아래 §4), OpenCode 고유 항목은 CustomSelect 패턴 위험·roving 함정·Tooltip 등 6건이 유효한 추가로 확정됐다.
- 합산 실행 항목은 P0 5건·P1 7건·P2 8건이며, P0는 Src 수정량 기준 총 100줄 미만으로 한 번에 처리 가능하다.

## 2. 공통 발견 (양 보고서 일치 → 확정)

| # | 항목 | 위치 | 심각도 | 상태 |
|---|---|---|---|---|
| C-1 | ConfirmDialog 닫힘 후 호출자로 포커스 미복귀 | `src/components/ConfirmDialog.tsx:33-42` | Major | 확정. Mcp 수제 다이얼로그(`Mcp.tsx:67-71`)는 복귀 구현済 — 공용 컴포넌트만 누락 |
| C-2 | 모바일 Chat 스레드 오버레이에 dialog 시맨틱·Esc·포커스 관리 부재 | `ChatThreadSidebar.tsx:22-27`, `ChatConversationHeader.tsx:21-29` | Major | 확정 |
| C-3 | 대화 설정 `<details>` 팝오버 Esc·외부닫기 없음 | `ChatConversationHeader.tsx:35-64` | Minor | 확정 |
| C-4 | TuningSliderField `aria-label` 영어 "slider" 하드코딩 | `TuningSliderField.tsx:107` | Minor | 확정 |
| C-5 | 장문 `<pre>` 스크롤 영역 키보드 도달 불가 | `Developer.tsx:150`, `Bench.tsx:223`, `Mcp.tsx:241` (+Bench 221, Tuning 이스케이프 출력) | Minor | 확정 |

## 3. Antigravity 고유 발견 — 검증 결과

| # | 항목 | 검증 결과 |
|---|---|---|
| AG-01 | Settings CustomSelect 설명 누락 (kebab vs camelCase) | **확정 (심각도만 Critical→Major로 조정, §4)**. `Settings.tsx:18-20`이 kebab-case를 주입하나 `CustomSelect`(`ThemeSwitcher.tsx:11-49`)는 camelCase만 받고 `...rest` 전달이 없어 4개 셀렉트(언어/밀도/테마/폴링)의 description이 전부 소실됨을 확인 |
| AG-02 | 목록 반복 버튼의 대상 식별자 누락 6곳 | **확정**. Models 401-403, Discover 192, RuntimeBackendList 84-85, RuntimeLoadingProfiles 45, Developer 125, Mcp 238 모두 `aria-label` 없이 텍스트만 있음을 확인 (단 RuntimeLoadingProfiles 삭제 버튼 42행은 `aria-label` 모범 — 수정 시 참조) |
| AG-05 | 프로필명 입력 라벨 완전 누락 | **확정**. `RuntimeLoadingProfiles.tsx:29` placeholderのみ |
| AG-06 | 복사 버튼 `copied` 상태 미고지 | **확정**. `MessageBubble.tsx:60` — F-07(가시성/탭스톱)과 동일 행의 다른 측면이므로 한 항목으로 통합 수정 |
| AG-08 | ♥ 기호 SR 발음 왜곡 | **확정**. `Discover.tsx:173` |
| AG-07 | tabpanel 중첩 | **확정 (Minor 유지)**. `App.tsx:85` PageShell tabpanel이 `panel-models`(276행) 등 상위 tabpanel 안에 중첩됨. 단 각 tablist가 독립 패널을 제어하는 구조라 실해는 낮음 — P2 |

## 4. OpenCode 고유 발견 — 검증 결과

| # | 항목 | 검증 결과 |
|---|---|---|
| F-03 | CustomSelect button+`role=combobox` SR 편차 위험 | **확정 (AG-01과 상호보완)**. AG-01이 "설명 전달 버그", F-03이 "역할 명명 리스크"로 같은 컴포넌트의 다른 결. 수정은 AG-01 rest 전달 + 버튼-팝업 명명 정정으로 일원화 |
| F-04 | chevron 장식 svg `aria-hidden` 누락 | **확정**. `ThemeSwitcher.tsx:242-251`. F-03 수정 시 동시 처리 |
| F-05 | Tooltip `title` 중복·미번역 라벨·숨김 visibility | **확정**. `Tooltip.tsx:15-29`. Tuning 패널 전역 영향이라 P1 |
| F-07 | 복사 버튼 터치 불가·탭스톱 폭증 | **확정**. AG-06과 통합 (아래 P-04) |
| F-08/F-12/F-13 | `disabled`+`title` 사유 미전달 3곳 | **확정**. Models 383-395, Discover 192, RuntimeBackendList 51/84-85. AG-02와 같은 버튼군이라 묶음 수정 |
| F-18/F-19 | Tuning 카테고리 roving 오용·`aria-current` | **확정**. `TuningNavigation.tsx:129-154`. P1 |
| F-20 | 샘플러 칩 중첩 인터랙티브 | **확정 (Minor)**. `TuningSamplerChain.tsx:111-141` |
| F-10/F-15/F-25/F-27 | 토스트 tone·숫자 범위·정책 고지·저장 표시 | **확정 (P2 일괄)** |
| C-01/C-02 | slate 하드코딩 대비·조건부 포커스 링 | **확정 (P2, 실측 과제)**. C-02는 현 패턴 정당하므로 코드 수정 없이 검증만 |

## 5. 정정 사항 (원본과 다른 판단, 근거 포함)

1. **AG-01 심각도 Critical→Major.** 이름(name)은 네이티브 `<label for>`→`<button id>` 연계로 전달되므로(버튼은 labelable 요소) 완전 차단이 아니라 설명(description) 손실이다. 단 Settings 4곳 전체에 걸친 체계적 손실이므로 P0로 유지.
2. **AG-01 두 번째 불릿 중 RuntimePullRequestCard 제외.** `RuntimePullRequestCard.tsx:38-58`의 CustomSelect는 실제 `<label>`로 감싸져 있어 접근 가능한 이름이 성립한다. 이름이 실제로 비어 있는 것은 Mcp 승인 정책 셀렉트(`Mcp.tsx:236` 전후, `<span>`+라벨 미연계)뿐이다. Mcp 쪽만 `ariaLabel` 추가로 수정.

## 6. 최종 수정 목록 (우선순위순)

### P0 — 다음 릴리스 전 (예상 총 100줄 미만)

- [ ] **P-01 `ConfirmDialog` 포커스 복귀** (C-1). `ConfirmDialog.tsx`에 invoker 캡처·복귀 추가 (OpenCode 보고서 F-01 스니펫 그대로 사용). 영향: Chat/Models/Settings/Projects 삭제·초기화 확인. 검증: 키보드로 삭제→취소 후 원래 버튼에 포커스. (WCAG 2.4.3)
- [ ] **P-02 Settings 설명 전달 복구** (AG-01). `CustomSelectProps`에 `"aria-describedby"`/`"aria-labelledby"`(kebab) 허용 + 트리거 버튼에 전달, 또는 `...rest` 패스스루. 동시에 Mcp 승인 정책 셀렉트에 `ariaLabel` 추가. 검증: NVDA에서 언어 설정 읽기 시 설명 낭독. (WCAG 4.1.2, 1.3.1)
- [ ] **P-03 목록 버튼 식별자 6곳** (AG-02). 형식: `aria-label={`${action}: ${name}`}`. 대상: Models 401-403(모델명) / Discover 192(파일명) / RuntimeBackendList 84-85(백엔드·빌드) / RuntimeLoadingProfiles 45(프로필명) / Developer 125(메서드+경로) / Mcp 238(도구명). (WCAG 2.4.4, 4.1.2)
- [ ] **P-04 복사 버튼 통합 수정** (AG-06+F-07). `MessageBubble.tsx:60`: `aria-label`을 copied 연동 + `group-focus-within:opacity-100` 추가. 터치 상시 메뉴는 별도 UX 티켓으로 분리. (WCAG 4.1.2, 2.1.1)
- [ ] **P-05 비활성 사유 `title`→programmatic 3곳** (F-08/F-12/F-13). `disabled`를 `aria-disabled`+클릭 가드(기존 notify 토스트 재사용)로 교체: Models 383-395 / Discover 192 / RuntimeBackendList 51·84-85. P-03과 같은 행이므로 동시 작업. (WCAG 4.1.3)

### P1 — 다음 스프린트

- [ ] **P-06 모바일 스레드 패널 dialog화** (C-2). `role=dialog aria-modal` + Esc + 포커스 왕복. (WCAG 2.1.1, 2.4.3)
- [ ] **P-07 CustomSelect 명명 정정** (F-03/F-04). `role=combobox` 제거→`aria-haspopup=listbox` 버튼-팝업으로 정정, chevron `aria-hidden`, 하이라이트/선택 클래스 분리. P-02와 같은 파일이라 함께 처리 권장. (WCAG 4.1.2)
- [ ] **P-08 Tuning 카테고리 roving 해제** (F-18/F-19). 전 버튼 `tabIndex={0}`, `aria-current="page"`→삭제(콘텐츠見出し가 설명 담당). (WCAG 2.1.1)
- [ ] **P-09 Tooltip 정리** (F-05). `title` 제거·라벨 i18n·숨김 `visibility:hidden`. (WCAG 4.1.2)
- [ ] **P-10 프로필명 입력 라벨** (AG-05). `aria-label` 1줄. (WCAG 3.3.2)
- [ ] **P-11 details Esc** (C-3) + MCP 승인 섹션 포커스 이동(F-26 묶음). (WCAG 2.1.2)
- [ ] **P-12 장문 `<pre>` 스크롤** (C-5). `tabIndex={0}`+`aria-label` 4곳. (WCAG 2.1.1)

### P2 — 백로그 (묶음 처리)

- [ ] **P-13** ♥ 분리(AG-08) + "slider" i18n(C-4) + 샘플러 칩 group 명명(F-20) — 자잘한 마크업 3건 일괄.
- [ ] **P-14** 토스트 tone 구분(F-10)·Bench 범위 고지(F-15)·MCP 정책 변경 고지(F-25)·저장 표시 연장(F-27)·파일 입력 실측(F-17/F-28).
- [ ] **P-15** Discover 로딩 live(F-11)·Developer 요약 live(F-22)·Projects/MCP 목록 선택 상태(F-16/F-24)·tabpanel 중첩 해소(AG-07).
- [ ] **P-16 (실측, 코드 수정 없음)** 대비 실측 axe+수동(C-01, 本文 4.5:1/UI 3:1, 라이트·다크·`prefers-contrast`) + 조건부 포커스 링 입력방식별 확인(C-02) + CustomSelect SR 실측 기록(F-03 잔여).

## 7. 검증 절차 (수정 후, 두 보고서 합의)

1. 키보드 전수 (Tab 역행 포함): P-01·P-05·P-06·P-11·P-12.
2. 스크린리더 (NVDA+Chrome, VoiceOver): P-02·P-03·P-04·P-07·AG-08.
3. axe + 대비 실측: P-16.
4. 모션·줌·360px: 기존 양호 판정 유지 확인.

## 8. 출처 대조표

- 확정-공통: C-1…C-5 (§2).
- Antigravity 확정: AG-01(조정)·AG-02·AG-05·AG-06·AG-08·AG-07 (§3).
- OpenCode 확정: F-03·F-04·F-05·F-07·F-08·F-12·F-13·F-18·F-19·F-20·F-10·F-15·F-25·F-27·C-01·C-02 (§4).
- 부분 정정 2건은 §5 참조. 양 보고서 모두 SR 실측·대비 수치 실측은 미수행으로 동일 한계를 공유하며, 이는 P-16으로 이관.
