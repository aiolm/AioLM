# 웹 접근성(a11y) 감사 — llama-board 전 페이지

- 감사일: 2026-09-07 (UTC)
- 범위: `src/App.tsx` 셸 + 전 패널(Chat, Models[library/lora], Discover, Runtimes, Benchmark, Projects, Tuning, Developer[api/gateways/diagnostics/mcp], Settings) + 공용 컴포넌트(TabNav, CustomSelect, Switch, ConfirmDialog, Tooltip, FeedbackBanner, EmptyState, StatusBadge)
- 방법: 정적 코드 감사(실행 기반 스크린리더 검증은 미수행). WCAG 2.2 AA 기준 매핑.
- 전제: Tauri 데스크톱 셸이지만 웹 콘텐츠로 취급하고 WCAG를 그대로 적용.

## 요약

전반 상태는 양호하다. 스킵 링크, roving-tabindex 탭 패턴, 네이티브 `<dialog>`, `role=log/alert/status/progressbar/table`의 올바른 사용, 키보드 내비게이션 모달리티(`is-keyboard-nav`), `prefers-reduced-motion`/`prefers-contrast` 대응, 설정 기반 모션 감소 등 기반이 잘 갖춰져 있다.

다만 아래 4건(Major)은 실제 사용자 차단 요소이므로 우선 수정 권장:

1. `ConfirmDialog` 닫힘 후 포커스 미복귀 (F-01)
2. Chat 스레드 사이드바 모바일 오버레이에 다이얼로그 시맨틱·Esc·포커스 관리 부재 (F-06)
3. Models 행 주 버튼의 `disabled` + `title` 의존 안내 — 키보드/SR에 사유 미전달 (F-08)
4. `CustomSelect`의 button+`role=combobox` 패턴 — SR 호환성 편차 위험 (F-03)

## 심각도 범례

- Critical: 특정 사용자군의 작업 완전 차단
- Major: 작업 가능하나 큰 장벽·정보 손실
- Minor: 개선 권장, 표준 준수 여유분

---

## 전역 셸·내비게이션

### 잘된 점

- `src/App.tsx:205` 스킵 링크(`#main-content`) 제공. `main#main-content`가 `tabIndex={-1}`이라 스킵 후 포커스 이동 가능.
- `src/components/TabNav.tsx:75-97` — WAI-ARIA 탭 패턴 준수: `role=tablist/tab`, `aria-selected`, `aria-controls`, roving tabindex, Arrow/Home/End, 자동 활성화. 3개 내비게이션 레벨이 동일 컴포넌트 사용.
- `src/main.tsx:10-20` 키보드 모달리티 구분, `index.html:15`·`App.tsx:127`의 `lang` 동기화.
- `src/styles/app-base.css:8-18`, `app-layout.css:6`, `index.css:183` — 모션 감소(설정 토글 + 미디어쿼리), `app-responsive.css:1-14` 고대비 대응.

### F-01 [Major] ConfirmDialog: 닫힘 후 포커스 미복귀 (WCAG 2.4.3)

- 위치: `src/components/ConfirmDialog.tsx:33-42`
- 현상: `open → showModal()` + 취소 버튼 초기 포커스는 있으나, `close()` 시 호출자(삭제 버튼 등)로 포커스 복귀 코드가 없음. Mcp의 수제 다이얼로그(`src/panels/Mcp.tsx:67-71, 138-139`)는 복귀 처리があるのに 공용 `ConfirmDialog`는 없음. Chat 스레드 삭제·Models 삭제·Settings 초기화·Projects 삭제 확인 후 키보드 포커스가 `body`로 떨어짐.
- 수정: invoker 캡처 후 복귀.
```tsx
const invokerRef = useRef<HTMLElement | null>(null);
useEffect(() => {
  const dialog = dialogRef.current;
  if (!dialog) return;
  if (open && !dialog.open) {
    invokerRef.current = document.activeElement as HTMLElement | null;
    dialog.showModal();
    window.requestAnimationFrame(() => cancelRef.current?.focus());
  } else if (!open && dialog.open) {
    dialog.close();
    window.requestAnimationFrame(() => invokerRef.current?.focus?.());
  }
}, [open]);
```

### F-02 [Minor] ConfirmDialog: busy 중 Esc 전면 차단 + 바쁜 상태 미고지 (WCAG 4.1.3)

- 위치: `src/components/ConfirmDialog.tsx:50-53, 77`
- 현상: `onCancel`에서 `event.preventDefault()`로 Esc를 항상 가로채고 busy가 아닐 때만 닫힘. busy 중에는 Esc·취소 모두 막히는데 진행 상태가 버튼 라벨 텍스트 교체(`Confirm → Removing…`, 영어 접두사 치환)에만 의존. 한국어 등 비영어 로케일에서는 `…`만 붙고 SR live 고지 없음.
- 수정: busy 중 `aria-busy="true"`를 dialog에 설정하고, 상태 텍스트를 `role="status"` 영역으로 분리. 라벨 치환 대신 `t()` 키 기반 진행 라벨 사용.

### F-03 [Major] CustomSelect: button+`role=combobox` 패턴의 SR 호환성 편차 (WCAG 4.1.2)

- 위치: `src/components/ThemeSwitcher.tsx:220-252, 254-305`
- 현상: 키보드 동작(열기/닫기, Arrow/Home/End, 타입어헤드, Esc/Tab)은 완비. 그러나 ARIA 1.2 combobox 패턴은 텍스트 입력 소유를 전제하므로, 버튼 트리거 + `aria-activedescendant` + body 포털 `listbox` 조합은 NVDA/JAWS/VoiceOver 조합에 따라 목록 읽기·선택 상태 전달이 들쭉날쭉할 수 있음. 숨겨진 네이티브 `<select>`(`204-219`)는 `aria-hidden="true" tabIndex={-1}`이라 AT 폴백이 되지 않음.
- 수정(택1):
  - (권장, 저비용) 현 구조 유지 + 실측 검증(NVDA+Chrome, VoiceOver+Safari에서 옵션 수·선택 상태·확장 상태 읽기 확인) 후 결과 기록.
  - (확실) 트리거를 `aria-haspopup="listbox" aria-expanded` 버튼 + `role="listbox"` 팝업(포털)으로 선언하고 `role=combobox` 제거 — "버튼 팝업" 패턴으로 정직하게 명명. `aria-activedescendant` 유지, 옵션 하이라이트를 `aria-selected`가 아닌 `data-active`로 분리(현재 `is-selected` 클래스가 선택/하이라이트를 합쳐 시각적으로 혼동 가능, `285`행).

### F-04 [Minor] CustomSelect 장식 chevron에 `aria-hidden` 누락

- 위치: `src/components/ThemeSwitcher.tsx:242-251`
- 수정: `<svg ... aria-hidden="true" focusable="false">` 추가.

---

## 공용 컴포넌트

### F-05 [Minor] Tooltip: `title` 중복 + 미번역 기본 라벨 (WCAG 4.1.2)

- 위치: `src/components/Tooltip.tsx:15, 21-29`
- 현상: (a) 기본 `label="Show help"` 하드코딩 — 한국어/일본어/중국어 UI에서 영어 잔류. (b) `title={description}` + `aria-describedby`로 동일 텍스트가 네이티브 툴팁과 SR 설명으로 이중 전달. (c) 팝오버가 `opacity:0` 상태로 접근성 트리에 상주(`app-components.css:371-399`) — `describedby` 특성상 허용 범위이나, 숨김 상태에서는 `visibility:hidden` 병행 권장.
- 수정: 기본 라벨을 i18n 키로 교체, `title` 속성 제거, 숨김 상태에 `visibility: hidden;` 추가(표시 상태 `visible`).

### Switch — 양호 (관찰 1건)

- `src/components/Switch.tsx:15-29` + `Settings.tsx:15-22`의 `Row` 연계: `role=switch`, `aria-checked`, `aria-describedby/labelledby` 정상. `<label htmlFor>`가 `<button id>`를 참조 — button은 labelable 요소라 클릭 전달 동작. 포커스 링(`app-settings.css:193`) 존재.
- 관찰(Minor): Windows 고대비(Forced Colors) 모드에서 스위치 상태가 색상에만 의존할 가능 — `forced-color-adjust` 및 outline/border 폴백 확인 권장.

### FeedbackBanner / EmptyState / StatusBadge

- `FeedbackBanner.tsx:32` — tone별 `role=alert/status` + `aria-live` + `aria-atomic` 구분 적절. `App.tsx:261`의 `aria-live=polite` 래퍼와 이중 live 가능성 있으나 원자적 메시지로 실해 없음.
- `StatusBadge.tsx:8` — 상태가 텍스트 라벨로 전달(색상 단독 의존 아님). 양호.
- `EmptyState.tsx:17, 24` — 아이콘 `aria-hidden`, 제목 `h3`. 단독 사용 시 페이지 heading 순서(`h2`→`h3`)는 각 패널에서 대체로 유지됨(아래 패널별 항목 참조).

---

## Chat (Chat / Composer / MessageLog / ThreadSidebar / ConversationHeader)

### 잘된 점

- `ChatMessageLog.tsx:40-50` — `role="log" aria-live="off"` + `aria-label`로 스트리밍 폭주 방지. 단계 고지는 `ChatComposer.tsx:91`의 `role=status` 상태행이 담당 — 설계가 올바름.
- 작문창 `textarea`(`ChatComposer.tsx:83`) `aria-label`, 첨부 제거 버튼의 서술형 `aria-label`(`74, 80`), `pendingImages/Documents` 그룹 라벨(`74, 80`), 도구 승인 `role=alert`(`71`), 에러 `role=alert`(`ChatMessageLog.tsx:94`) 적절.
- 추론 `<details>`(`MessageBubble.tsx:50-53`) 네이티브 디스클로저 + summary 포커스 링. 이미지 `alt={image.name}`(`55`), 문서 칩 텍스트(`56`) 제공.

### F-06 [Major] 모바일 스레드 오버레이에 다이얼로그 시맨틱 부재 (WCAG 2.1.1, 2.4.3)

- 위치: `src/panels/ChatThreadSidebar.tsx:22-27`, 토글 `src/panels/ChatConversationHeader.tsx:21-29`
- 현상: 모바일(`sm:` 미만)에서 `absolute inset-y-0 z-20` 오버레이로 열리나 `<aside>` 그대로. Esc 닫기·배경 inert·열림 시 패널 포커스 이동·닫힘 시 토글 복귀 없음. `aria-expanded/controls`는 토글에 있으나 패널이 `dialog`가 아니라 SR이 모달로 인식 못 함.
- 수정: 모바일에서는 `role="dialog" aria-modal="true" aria-label` 부여 + Esc 닫기 + 열림 시 검색 입력 또는 패널로 포커스 + 닫힘 시 토글 버튼 복귀. 또는 Tailwind `sm:` 분기 대신 상시 `dialog` 패턴. 데스크탑 인라인 레이아웃(`sm:relative`)에는 적용 제외.

### F-07 [Major] 메시지별 복사 버튼: 터치 발견 불가 + 긴 대화 탭 스톱 폭증 (WCAG 2.1.1, 2.4.7)

- 위치: `src/panels/MessageBubble.tsx:60`
- 현상: `opacity-0 group-hover:opacity-100 focus:opacity-100` — 키보드 포커스 시는 보이나(양호), 터치(hover 없음) 사용자는 어시스턴트 메시지 복사 기능 발견 불가. 또한 메시지마다 탭 스톱이 1개씩 증가해 50개 대화 = 50+ 탭 스톱.
- 수정: `group-focus-within:opacity-100` 추가(자식 포커스 시 컨테이너 표시 유지) + 터치 지원을 위해 메시지당 상시 보이는 오버플로 메뉴(또는 길게 누르기 대체) 검토. 장기적으로 메시지 액션을 툴바 메뉴로 통합 권장.

### F-08은 Models 섹션으로 이동 (아래)

### F-09 [Minor] 대화 설정 `<details>` 팝오버: Esc·외부 클릭 닫기 없음 (WCAG 2.1.2)

- 위치: `src/panels/ChatConversationHeader.tsx:35-64`
- 현상: 네이티브 `<details>`라 `summary` 토글·암시적 `aria-expanded`는 동작하나, Esc 닫기·외부 클릭 닫기·열림 시 첫 필드 포커스 이동 없음. 키보드 함정은 아니나(포커스가 summary에 남음) SR 사용자는 열린 패널을 탭으로 순회해야 함.
- 수정: Esc 핸들러로 `open=false` + 닫힘 시 `summary` 복귀. ( Bragg: `<details>`에 직접 Esc 바인딩.)

---

## Models (library / lora)

### 잘된 점

- 목록 `role=list/listitem`(`358, 379`), 스캔 중 `aria-busy`(`358`), 로딩/에러 `role=status/alert`(`359-361`), 검색 입력 라벨(`345`), vision 체크박스 네이티브 라벨(`346`), 선택 행 `aria-current` + 명시 `aria-label`(`385-386`), 상태 태그 텍스트 병기(`398-399`) — 색상 단독 의존 아님.

### F-08 [Major] 서버 실행 중 행 주 버튼 `disabled` + `title` 의존 안내 (WCAG 4.1.3, 3.3.1)

- 위치: `src/panels/Models.tsx:383-395`
- 현상: `disabled={serverRunning}` + `title={t("ui.useRowAction")}`. 비활성 버튼은 탭 순서에서 제외되어 키보드 사용자는 "왜 선택 불가인지"를 만날 수 없고, `title`은 키보드/SR에 신뢰 전달 안 됨.
- 수정: `disabled` 대신 `aria-disabled="true"` + 포커스 유지 + 클릭 가드에서 이유를 `role=status`/`notify`로 고지(기존 `notify` 인프라 재사용). 또는 행에 `aria-describedby`로 "(서버 정지 후 선택 가능)" 상시 병기.

### F-10 [Minor] LoRA 스케일 입력 라벨 연계는 양호하나 숫자 검증 고지 확인 필요

- 위치: `src/panels/Models.tsx:335-336, 341`
- 현상: `label htmlFor="lora-scale"` 연계 정상. 범위 오류(`0–4`)는 `notify` 토스트(`127`)로 고지 — `app-panel-feedback-layer[aria-live=polite]`(`268`) 내부라 전달됨. 단 토스트가 `tone=info` 단일이라 에러/정보 구분이 SR에 안 남.
- 수정: 검증 실패 토스트를 `tone="error"`로(또는 `role=alert` 영역) — Runtimes/Discover/Bench의 에러 배너와 일관.

---

## Discover

- 잘된 점: 검색 `<form>` + `sr-only` 라벨(`143-145`), 결과/파일 `<section aria-label>`(`165, 180`), 다운로드 `role=progressbar` + valuemin/max/now(`158`), 진행 `role=status`(`153`), 피드백 live 레이어(`149`).
- F-11 [Minor]: 로딩/빈 상태 텍스트(`167-168, 184-185`)가 live 영역 밖에 있어 SR에 자동 고지 안 됨. `aria-busy`는 form에만(`143`). 수정: 결과 섹션에 `aria-busy={searching}` / `aria-live="polite"` 부여 또는 상태 텍스트를 `role=status`로.
- F-12 [Minor]: 파일행 다운로드 버튼의 비활성 사유(`title={stopBeforeDownload}`, `192`)가 F-08과 동일 문제(경미 — 상단에 동일 문구의 에러가 `search()`/`download()`에서 텍스트로 고지되므로 정보 자체는 도달 가능). `aria-disabled` 패턴 또는 `aria-describedby` 권장.

## Runtimes

- 잘된 점: 백엔드 카드 `section[aria-labelledby]` +見出し(`RuntimeBackendList.tsx:38, 42`), 행 `aria-busy`, 설치 진행률 `role=progressbar` + 값(`62`), 설치 빌드 목록 `role=list/listitem` + 활성 빌드 텍스트 배지(`73-87`), 실패 `role=alert`(`Runtimes.tsx:40`).
- F-13 [Minor]: 설치/활성화/삭제 버튼군의 비활성 사유가 전부 `title`(`RuntimeBackendList.tsx:51, 84-85`). F-08/F-12와 동일 — `aria-disabled` + 클릭 시 이유 고지로 통일 권장.
- F-14 [Minor]: 상태·적합도 뱃지(`43-44`)가 클래스 기반 색상 + 텍스트 라벨 병행 — 텍스트가 있어 1.4.1은 만족. 단 `text-slate-500`/`text-red-400` 등 하드코딩 회색/적색의 명도대비가 테마 변수와 어긋날 가능 — 다크/라이트 양 테마에서 대비 실측(4.5:1) 권장.

## Benchmark (Bench)

- 잘된 점: 결과 `<table>`에 `<caption class=sr-only>` + `scope=col`(`193-201`), 실행 상태 `role=status`(`171`), 취소/에러 `role=status/alert`(`180, 185`), 기록 섹션 `aria-labelledby`(`225`).
- F-15 [Minor]: 반복 횟수 입력이 `type=text inputMode=numeric`(`124-142`) — SR이 "텍스트"로 읽음. `inputmode` + blur 정규화는 되어 있으나, `type=number` 또는 `role=spinbutton` + `aria-valuemin/max`가 더 정확. 단 스텝 UI 부작용을 피한 의도적 선택으로 보이므로, 최소 `aria-describedby`로 "1–100" 범위 고지 권장.
- 관찰: `phase==="canceling"` 버튼 `disabled` + 라벨 변경(`146-152`) — 진행 고지는 `role=status` 슬롯(`169-176`)에 있어 양호.

## Projects

- 잘된 점: 피드백 live 레이어 + `role=alert` 에러(`252-255`), 통계 그룹 `role=group aria-label`(`256`), 활성 프로젝트 텍스트 배지(`274`), 저장 버튼의 `title`による 사유(`302`).
- F-16 [Minor]: 프로젝트 목록이 `<aside>` 내 div 나열(`270-276`)로 `role=list/listitem` 없음(Discover/Models와 불일치). 선택 버튼에 `aria-current` 없음 — 현재 선택이 시각(`is-selected`)으로만 표현. 수정: 컨테이너 `role=listbox` 또는 `list` + 옵션 `aria-selected/aria-current` 부여. (단순 목록+단일 선택이므로 `list` + `aria-current="true"`가 최소 변경.)
- F-17 [Minor]: 파일 임포트 `<label>` 내 숨김 `<input type=file class=sr-only>`(`249`) — 키보드 도달·동작은 가능하나, SR이 "Import JSON, 파일 선택"으로 읽는지(라벨 연계는 DOM 포함 관계로 성립) 실측 권장. Settings의 동일 패턴(`Settings.tsx:135-136`)도 동일.

## Tuning (서버/샘플링/추론/이스케이프 + 내비게이션)

- 잘된 점: 모드 탭 `tablist/tab/aria-selected/aria-controls` + roving(`TuningNavigation.tsx:77-102`), 검색 입력 라벨(`105-115`), 슬라이더+숫자 쌍의 라벨/`aria-describedby` 연계(`TuningSliderField.tsx:86-129`), 샘플러 체인의 키보드 이동 버튼(`TuningSamplerChain.tsx:136-138`) + 드래그 대체 수단, `CustomSelect`가 아닌 네이티브 `<select>`를 쓴 샘플러 추가(`149-156`) — AT 친화적.
- F-18 [Major→Minor 경계, Minor 판정] 카테고리 목록이 탭 패턴이 아닌데 roving tabindex 사용 (WCAG 2.1.1 함정 위험)
  - 위치: `TuningNavigation.tsx:129-154`
  - 현상: 카테고리 버튼이 `tabIndex={isActive ? 0 : -1}` + ArrowUp/Down 이동. 탭이 아닌 목록에서 roving을 쓰면, 비활성 카테고리는 Tab으로 도달 불가 — 화살표 키惯習을 모르는 사용자는 카테고리 1개만 보이고 끝난 것으로 오인 가능. 현재 버튼에 `role`이 없어 SR은 "버튼"으로만 읽고 화살표 조작법을 알 수 없음.
  - 수정(택1): (a) 전 버튼 `tabIndex={0}` 제거(roving 해제) — 가장 단순. (b) `role=listbox/option + aria-selected` 또는 `role=tab` 부여 후 컨테이너 설명에 조작법 병기. 권장 (a).
- F-19 [Minor] 카테고리 버튼 `title` 설명 + `aria-current="page"` (`141-142`)
  - `title`은 터치·키보드에 미전달. 카테고리 설명은 콘텐츠 영역見出し(`Tuning.tsx:233-236` `h3+p`)에 중복 표시되므로 실해는 경미. `aria-current="page"`는 내비게이션 링크용 — 버튼에는 `aria-pressed` 또는 `aria-selected`가 의미상 정확. 탭 패턴으로 정리 시 함께 해소.
- F-20 [Minor] 샘플러 칩 `div[tabIndex=0]` + 내부 버튼 3개 중첩 (WCAG 4.1.2)
  - 위치: `TuningSamplerChain.tsx:111-141`
  - 현상: 칩 자체가 포커스 가능 + 화살표 재정렬, 내부에 이동/삭제 버튼. 중첩 인터랙티브는 SR에 "그룹" 없이 평탄하게 읽혀 혼란 가능. `role=list/listitem`은 있으나 칩에 이름·역할이 없음.
  - 수정: 칩에 `role="group" aria-label={sampler}` 또는 `aria-roledescription` 부여. 장기적으로 드래그 핸들을 별도 포커스 요소로 분리.
- F-21 [Minor] 슬라이더/숫자 이중 컨트롤의 이름 중복
  - 위치: `TuningSliderField.tsx:95-126`
  - 현상: range(`aria-label="{label} slider"`, 영어 "slider" 접미 하드코딩)와 number(`aria-labelledby` 동일 라벨)가 같은 이름 공간 공유 — SR이 "Temperature slider, 슬라이더" / "Temperature, 스핀버튼"으로 읽어 구분은 되나 "slider" 문자열 미번역. 수정: `aria-label`을 i18n 키(`{label} + sliderLabel`)로.

## Developer (API / Gateways / Diagnostics)

- 잘된 점: 섹션見出し가 사이드바 선택을 추종(`Developer.tsx:90-94`, `h2` 갱신) — SPA에서見出し 방치 흔한 실수 회피. 코드 블록이 `<pre>/<code>` 실제 텍스트(복사 가능), 복사 버튼 상태가 라벨 변경(`copied`)으로 전달.
- F-22 [Minor]: 상태 요약 3종(`110-114`)이 `role=group` + `div` 나열 — 값 변경(설치 모델 수, 게이트웨이 상태)이 live로 고지 안 됨. 폴링/전환 시 SR 사용자는 재탐색 필요. 수정: 값 노드에 `aria-live="polite"` 또는 변경 시 `role=status` 토스트(既存 `error` 레이어 재사용).
- F-23 [Minor]: 진단 로그 `<pre>`(`150`)가 장문 스크롤 영역 — 키보드 스크롤은 포커스 가능 요소여야 하는데 `<pre>`에 `tabIndex=0` 없음. 수정: `tabIndex={0}` + `aria-label` 부여(키보드 전용 사용자 스크롤 보장). 동일 패턴: Bench effectiveArgs(`221-224`), Mcp 결과 `pre`(`241`), Tuning 이스케이프 출력(해당 시).

## MCP

- 잘된 점: 삭제 다이얼로그가 네이티브 `<dialog>` + 포커스 복귀(`52-71`) — F-01의 모범 사례. 이 파일을 공용 다이얼로그 수정 시 참조.
- F-24 [Minor]: 서버 목록이 `div` 나열 + 선택 버튼에 선택 상태 미표시(`234`) — `is-selected` 시각のみ. `aria-current="true"` 또는 `aria-pressed` 추가 권장(Projects F-16과 동일 계열).
- F-25 [Minor]: `CustomSelect` 승인 정책 변경이 `onChange` 즉시 저장(`236` 전후) — SR 고지 없음. `notice` 배너(`230`)는 도구 탐색 시에만 설정. 수정: 정책 변경 시 `notice` 또는 `role=status` 한 줄 고지.
- F-26 [Minor]: 승인(`240`, `role=alert`)·결과(`241`) 섹션이 조건부 마운트 — 포커스 이동 없음. `role=alert`가 SR에 읽히므로 차단도는 낮으나, 키보드 사용자는 승인 버튼까지 탭 순회가 필요. 수정: 승인 섹션 마운트 시見出し(`h3`)에 `tabIndex=-1` + 포커스 이동 검토.

## Settings

- 잘된 점: `Row`(`15-22`)의 `label/for + description` 연계 + 컨트롤에 `aria-describedby/labelledby` 주입 — 폼 라벨링 모범. 섹션 `tabpanel` + `aria-labelledby`(`97`), 저장 표시 `role=status`(`84`), 위험/백업 영역見出し 구조.
- F-27 [Minor]: 저장됨 배지가 1.8초 후 사라지는 일시 콘텐츠(`54-57, 84`) — `role=status`라 SR에는 고지되나 저시력·인지 유저가 읽기 전 소멸 가능. 수정: 표시 유지 시간을 4초 이상으로 연장하거나 상시 "마지막 저장 HH:MM" 텍스트 병기.
- F-28 [Minor]: 파일 임포트 패턴 F-17과 동일(`135-136`).

---

## 색상·대비·모션·반응형 (교차 절단)

- C-01 [Minor] 하드코딩 회색 텍스트(`text-slate-500/600`, `text-slate-400` 등 — Developer/Mcp/Runtimes 다수)의 라이트/다크 테마 대비 미검증. 테마 토큰(`--board-faint/muted`)이 아닌 Tailwind slate 직접 지정이 혼재. 수정: 토큰으로 통일 후 양 테마에서本文 4.5:1·UI 3:1 실측.
- C-02 [Minor] 포커스 링이 `body.is-keyboard-nav` 조건부(`app-base.css:15-18`) — 마우스+키보드 병행(예: 마우스 클릭 후 Tab) 시 첫 Tab부터 링이 나타나므로( keydown 리스너가 Tab을 포착, `main.tsx:11-15`) 실사용 문제 적음. 단 터치 탐색기·음성 제어 등 `:focus-visible` 휴리스틱이 빗나가는 입력 방식에서 링 소실 가능 — 고위험은 아니나 기록.
- C-03 [양호] `prefers-reduced-motion: reduce` 폴백(`index.css:183`) + 사용자 토글(`app-reduce-motion`) 이중화. 스트리밍 자동 스크롤(`Chat.tsx:107-111`)은 `phase idle`에서만 smooth — 모션 민감 사용자 배려됨.

## 키보드 맵 (실측 전제 정리)

| 위치 | Tab | Arrow/Home/End | Enter/Space | Esc | 비고 |
|---|---|---|---|---|---|
| 최상위 रेल TabNav | roving 1스톱 | ○ | ○ | – | 자동 활성화 |
| 설정 섹션 TabNav | roving 1스톱 | ○ | ○ | – | 동 |
| Tuning 모드 탭 | roving 1스톱 | ←/→のみ | ○ | – | ↑/↓ 미지원(2개라 실해↓) |
| Tuning 카테고리 | **F-18: 활성만 Tab** | ↑/↓ | ○ | – | 수정 필요 |
| CustomSelect | 트리거 1스톱 | ○(열림 시) | ○ | ○닫기 | F-03 참조 |
| ConfirmDialog | 트랩 | – | ○ | ○(busy 제외) | F-01/F-02 |
| 샘플러 칩 | 칩+내부3버튼 | ←→↑↓ 이동 | ○ | – | F-20 |
| Chat 스레드 오버레이(모바일) | 배경까지 이동 | – | ○ | **×** | F-06 |
| 대화 설정 details | summary 1스톱 | – | ○ | **×** | F-09 |

---

## 수정 우선순위 체크리스트

- [ ] P0 F-01: `ConfirmDialog` 포커스 복귀 (스니펫 上)
- [ ] P0 F-06: 모바일 스레드 패널 dialog화 + Esc + 포커스往復
- [ ] P0 F-08: Models 행 `disabled→aria-disabled` + 이유 고지 (Runtimes F-13, Discover F-12 동일 패턴 일괄)
- [ ] P0 F-03: CustomSelect 패턴 결정(검증 기록 or 버튼-팝업으로 명명 정정) + F-04 chevron `aria-hidden`
- [ ] P1 F-07: 복사 버튼 `focus-within` 표시 + 터치 대안
- [ ] P1 F-18/F-19: 카테고리 roving 해제 + `aria-current` 정리
- [ ] P1 F-20/F-21: 샘플러 칩 group 명명 + "slider" i18n
- [ ] P1 F-05: Tooltip `title` 제거·라벨 i18n·숨김 `visibility`
- [ ] P1 F-02: busy `aria-busy` + 진행 라벨 i18n
- [ ] P2 F-09/F-26: details/승인 섹션 Esc·포커스 이동
- [ ] P2 F-11/F-22: 로딩·요약 값 live 고지
- [ ] P2 F-15/F-23: 숫자 범위·장문 `<pre>` 키보드 스크롤(`tabIndex=0`)
- [ ] P2 F-16/F-24: Projects/MCP 목록 선택 상태 노출
- [ ] P2 F-10/F-25/F-27/F-28: 토스트 tone 구분·정책 변경 고지·저장 표시 연장·파일 입력 실측
- [ ] P2 C-01: slate 하드코딩→토큰 + 대비 실측(라이트/다크, 4.5:1/3:1)

## 검증 절차 (수정 후)

1. 키보드 전수: Tab 역행 포함 전 패널 순회, 포커스 가시성·함정·복귀 확인 (F-01, F-06, F-09).
2. 스크린리더: NVDA+Chrome(Windows), VoiceOver+Safari(iOS 대응분) — CustomSelect 옵션 읽기(F-03), combobox 명명, live 고지 중복 여부.
3. 대비: axe DevTools + 수동 스포이드 —本文 4.5:1, UI/포커스 3:1, 라이트/다크/`prefers-contrast: more`.
4. 모션: OS 모션 감소 ON + 앱 내 토글 — 스피너·펄스·스트리밍 스크롤.
5. 줌 200%·모바일 360px: 오버레이·팝오버 클리핑, `title` 의존 정보의 가시 대안.

## 제외·한계

- SR 실측 미수행 — F-03 등급은 패턴 위험 기반이며 실측 후 하향 가능.
- 대비 수치 실측 미수행 — 토큰 값(`--board-focus` 등) 대비 계산은 axe 실측으로 대체 필요.
- Runtimes 서브카드 내부 로직·i18n 누락 키의 SR 영향은 범위 외(텍스트 폴백 동작).
