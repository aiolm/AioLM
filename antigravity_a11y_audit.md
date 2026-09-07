# 웹 접근성(a11y) 정밀 감사 보고서 — Antigravity (Coordinator)

- 감사일: 2026-09-08
- 대상: `llama-board` 전 페이지 (`App.tsx`, `Chat`, `Models`, `Discover`, `Runtimes`, `Bench`, `Projects`, `Tuning`, `Developer`, `Mcp`, `Settings` 및 공용 컴포넌트)
- 기준: WAI-ARIA 1.2, WCAG 2.1 / 2.2 AA

---

## 1. 종합 평가 요약

llama-board는 전반적으로 스킵 링크, WAI-ARIA 탭 패턴(`TabNav`), 네이티브 `<dialog>`, `role="log" aria-live="off"`, 고대비/모션 감소 미디어쿼리 등 탄탄한 접근성 기본기를 갖추고 있습니다.
그러나 심층 정적 분석 결과, **컴포넌트 간 속성 불일치로 인한 설명 누락**, **반복 액션 버튼의 접근 가능한 이름(Accessible Name) 식별 불가**, **폼 컨트롤 라벨 누락**, **다이얼로그 포커스 관리 미흡** 등 실질적인 보조공학 사용자 경험을 해치는 결함들이 확인되었습니다.

---

## 2. 주요 발견 사항 (Critical & Major)

### AG-01 [Critical] CustomSelect prop 네이밍 불일치로 인한 Settings 설명 텍스트 전면 누락 (WCAG 4.1.2, 1.3.1)
- **위치**: `src/components/ThemeSwitcher.tsx:21-23, 46-47` & `src/panels/Settings.tsx:18-20`
- **현상**:
  - `Settings.tsx`의 `Row` 컴포넌트는 자식 컨트롤에 `"aria-describedby": descriptionId`, `"aria-labelledby": labelId` (kebab-case)를 `cloneElement`로 주입함.
  - 그러나 `CustomSelect`(`ThemeSwitcher.tsx`)는 `ariaDescribedBy`, `ariaLabelledBy` (camelCase) prop만 받도록 정의되어 있으며, `...rest` 전달이 없음.
  - 결과적으로 Settings의 언어, UI 밀도, 테마 등 모든 `CustomSelect`에 `aria-describedby`가 전혀 전달되지 않아 스크린리더에서 각 설정의 상세 설명(description)이 완전히 누락됨.
  - 또한 `RuntimePullRequestCard.tsx:40-57` 및 `Mcp.tsx:236`에서도 `CustomSelect`에 `aria-label`이나 `ariaLabelledBy`가 지정되지 않아 콤보박스의 접근 가능한 이름이 비어있거나 불완전함.
- **개선안**:
  `CustomSelectProps`에 `ariaDescribedBy?: string; "aria-describedby"?: string; ariaLabelledBy?: string; "aria-labelledby"?: string;`를 모두 지원하도록 유니온 처리하거나 `...rest`를 트리거 버튼에 전달하도록 수정.

### AG-02 [Major] 목록 내 반복 액션 버튼의 대상 식별자 누락 (WCAG 2.4.4, 2.4.6, 4.1.2)
- **위치**: 전 패널의 목록성 UI 다수
  1. `Models.tsx:401-403`: 모델 목록 각 행의 "경로 복사", "삭제", "시작"/"전환 및 재시작" 버튼이 단순 텍스트만 표시됨. 스크린리더 로터/요소 목록 탐색 시 "경로 복사, 버튼", "삭제, 버튼", "시작, 버튼"이 수십 개 중복 나열되어 어떤 모델에 대한 조작인지 알 수 없음. (행 주 선택 버튼 `386`행은 `aria-label={t("ui.selectModelNamed", { name: model.name })}`로 모범 적용되어 있으나 보조 액션 버튼들은 누락됨).
  2. `Discover.tsx:192`: 허깅페이스 파일 목록의 "다운로드" 버튼이 파일명 컨텍스트 없이 단순 "다운로드"로만 명명됨 (`aria-label={`${t("extra.download")}: ${displayFilePath}`}` 누락).
  3. `RuntimeBackendList.tsx:84-85`: 설치된 런타임 빌드 목록의 "활성화", "삭제" 버튼에 대상 백엔드/빌드 명칭이 누락됨.
  4. `RuntimeLoadingProfiles.tsx:45`: 프로필 목록의 "프로필 적용" 버튼에 프로필 명칭 누락.
  5. `Developer.tsx:125`: 엔드포인트 목록의 "cURL 복사" 버튼에 메서드 및 경로 컨텍스트 누락.
  6. `Mcp.tsx:238`: 도구 목록의 "호출 준비" 버튼에 도구명 컨텍스트 누락.
- **개선안**:
  각 버튼에 대상 리소스 이름이 포함된 명시적 `aria-label` 부여.

### AG-03 [Major] ConfirmDialog 닫힘 시 트리거 요소로의 포커스 미복귀 (WCAG 2.4.3)
- **위치**: `src/components/ConfirmDialog.tsx:33-42`
- **현상**:
  - `open` 시 `dialog.showModal()`과 `cancelRef.current?.focus()`로 모달 진입은 정상 처리되나, 취소/확인으로 닫힐 때 원래 포커스를 갖고 있던 호출자(버튼 등)로 포커스를 복구하지 않음.
  - 포커스가 `document.body`로 유실되어 키보드/스크린리더 사용자가 페이지 처음부터 다시 탐색해야 함.
- **개선안**:
  다이얼로그가 열릴 때 `document.activeElement`를 `invokerRef`에 저장하고, 닫힐 때 `invokerRef.current?.focus()` 호출.

### AG-04 [Major] 모바일 Chat 스레드 사이드바의 모달 시맨틱 및 키보드 트랩/Esc 미지원 (WCAG 2.1.1, 2.4.3)
- **위치**: `src/panels/ChatThreadSidebar.tsx:21-27` & `ChatConversationHeader.tsx:21-29`
- **현상**:
  - 모바일 뷰(`sm:` 미만)에서 사이드바가 `absolute inset-y-0 left-0 z-20` 오버레이로 뜨지만 여전히 단순 `<aside>` 요소임.
  - `aria-modal="true"`, `role="dialog"` 시맨틱이 없고, Esc 키로 닫을 수 없으며, 닫기 버튼도 없고, 포커스가 배경으로 빠져나갈 수 있음.
- **개선안**:
  모바일 오버레이 상태일 때 `role="dialog" aria-modal="true"` 적용, Esc 키 이벤트 바인딩, 열림 시 포커스 이동 및 닫힘 시 토글 버튼으로 포커스 복귀.

---

## 3. 중간 및 경미 사항 (Moderate & Minor)

### AG-05 [Moderate] 폼 컨트롤 라벨 누락 (WCAG 4.1.2, 3.3.2)
- **위치**: `src/panels/RuntimeLoadingProfiles.tsx:29`
- **현상**:
  `<input value={profileName} placeholder={t("ui.profileNamePlaceholder")} className="app-input" />`
  플레이스홀더만 있고 `<label>`, `aria-label`, `aria-labelledby`가 전혀 없음. 플레이스홀더는 접근 가능한 이름(Accessible Name)으로 인정되지 않음.
- **개선안**:
  `aria-label={t("ui.profileNamePlaceholder")}` 추가 또는 시각적/숨김 `<label>` 연계.

### AG-06 [Moderate] MessageBubble의 복사 상태 변경 미고지 (WCAG 4.1.2)
- **위치**: `src/panels/MessageBubble.tsx:60`
- **현상**:
  어시스턴트 메시지 복사 버튼 클릭 시 시각적 텍스트는 `{copied ? text("copied") : text("copy")}`로 바뀌지만, `aria-label={text("copy")}`는 항상 고정되어 있음. 스크린리더 사용자는 복사가 성공했는지 피드백을 받지 못함.
- **개선안**:
  `aria-label={copied ? text("copied") : text("copy")}`로 동적 반영하고, 필요 시 `aria-live` 알림 제공.

### AG-07 [Minor] App.tsx 내 Tabpanel 중첩 구조 (WAI-ARIA Tabs 1.2)
- **위치**: `src/App.tsx:85, 284, 307`
- **현상**:
  최상위 탭 영역인 `<section id="panel-models" role="tabpanel">` 내부에 하위 서브메뉴인 `<PageShell>`이 다시 `<div role="tabpanel">`을 렌더링하여 `tabpanel` 내부에 또 다른 `tabpanel`이 중첩됨.
- **개선안**:
  최상위 컨테이너는 단순 컨테이너 섹션으로 두고, 실제 내용 영역만 `tabpanel` 역할을 맡기거나 구조적 계층 분리.

### AG-08 [Minor] 하트 기호(♥)의 스크린리더 발음 왜곡 (WCAG 1.1.1)
- **위치**: `src/panels/Discover.tsx:173`
- **현상**:
  `<span>♥ {formatCount(locale, model.likes)}</span>`: 문자 "♥"가 스크린리더에 따라 "검은 하트 수트" 등으로 직독되어 청각적 맥락을 해침.
- **개선안**:
  `<span aria-hidden="true">♥</span> <span className="sr-only">{t("panel.likes")}: </span>{formatCount(locale, model.likes)}` 형태로 분리.

### AG-09 [Minor] 대화 설정 Details 팝오버의 Esc / 포커스 관리 (WCAG 2.1.2)
- **위치**: `src/panels/ChatConversationHeader.tsx:35-60`
- **현상**:
  `<details>` 태그를 사용한 드롭다운 패널이 열렸을 때 Esc 키로 닫히지 않고 외부 클릭 닫기가 지원되지 않음.
- **개선안**:
  패널 내부 keydown 리스너로 Esc 시 `open = false` 설정 및 summary 포커스 복귀.

### AG-10 [Minor] 장문 스크롤 영역(`<pre>`)의 키보드 포커스 스크롤 지원 (WCAG 2.1.1)
- **위치**: `Developer.tsx:150`, `Bench.tsx:223`, `Mcp.tsx:241`
- **현상**:
  장문의 로그 및 코드 블록이 overflow-auto로 스크롤되지만 `tabIndex={0}`이 없어 키보드 전용 사용자가 내용을 스크롤할 수 없음.
- **개선안**:
  스크롤 가능한 `<pre>` 컨테이너에 `tabIndex={0}` 및 적절한 `aria-label` 부여.

### AG-11 [Minor] TuningSliderField 하드코딩 영어 "slider" 라벨 (WCAG 1.3.1)
- **위치**: `src/panels/TuningSliderField.tsx:107`
- **현상**:
  `aria-label={`${resolvedLabel} slider`}`로 영문 "slider"가 하드코딩되어 다국어 UI 환경에서 부자연스러움.
- **개선안**:
  `aria-label`을 다국어 번역 키를 사용하거나 number 인풋과 통일된 네이밍 체계 적용.

---

## 4. 결론 및 OpenCode 비교 포인트

1. **상호 일치하는 발견**:
   - `ConfirmDialog` 포커스 미복귀 (AG-03 / OpenCode F-01)
   - 모바일 스레드 사이드바 다이얼로그화 및 포커스/Esc 관리 (AG-04 / OpenCode F-06)
   - 대화 설정 `<details>` Esc 닫기 부재 (AG-09 / OpenCode F-09)
   - `TuningSliderField` 하드코딩 영어 "slider" (AG-11 / OpenCode F-21)
   - 스크롤 가능 `<pre>`의 키보드 접근성 (AG-10 / OpenCode F-23)

2. **Antigravity 고유 발견 (OpenCode 누락 사항)**:
   - **`CustomSelect` prop 네이밍 불일치(kebab vs camelCase)로 인한 Settings 설명 누락 (AG-01)**: 코드 베이스의 실제 prop 전달 체계를 추적하여 발견한 핵심 버그.
   - **전 패널 목록 내 반복 액션 버튼(복사, 삭제, 시작, 다운로드 등)의 Accessible Name 식별자 누락 (AG-02)**: 스크린리더 탐색 시 가장 혼란을 주는 UX 문제.
   - **`RuntimeLoadingProfiles.tsx`의 입력 필드 라벨 완전 누락 (AG-05)**.
   - **`MessageBubble.tsx` 복사 버튼의 `copied` 상태 `aria-label` 미반영 (AG-06)**.
   - **`Discover.tsx` 하트 기호(♥) 스크린리더 발음 왜곡 (AG-08)**.

3. **OpenCode 고유 발견 (추가 검토 필요 사항)**:
   - `CustomSelect` combobox vs listbox 팝업 패턴에 대한 스크린리더 호환성 분석 (OpenCode F-03).
   - `TuningNavigation` 카테고리 목록의 roving tabindex 함정 위험 (OpenCode F-18).
   - `TuningSamplerChain` 칩 컴포넌트의 중첩 인터랙티브 요소 (OpenCode F-20).
   - `Tooltip.tsx`의 미번역 기본 라벨 및 hidden 상태 visibility (OpenCode F-05).
   - Tailwind slate 하드코딩 색상과 토큰 대비 문제 (OpenCode C-01).
