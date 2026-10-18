# 외부 엔진 모델 선택 후속 검증

2026-10-19, Windows 개발 앱 대상. 이전 Windows goal의 고정 production23 결과를 변경하지 않는 후속 결함 수정이다. 구현 source는 `77bf166`이며 계약은 [외부 엔진 모델 후보와 호환성](runtime-adapter-handoff.ko.md#외부-엔진-모델-후보와-호환성의-구분)을 따른다.

## 결함과 변경

외부 엔진의 미확인 모델을 내장 엔진의 호환성 필터로 숨겼다. 반대로 등록 manifest의 파일 형식이 같으면 같은 엔진의 다른 런타임까지 포함해 `partial`로 표시했다. 모델 목록은 전체 라이브러리를 먼저 탐색하고 모델마다 런타임 바이너리 무결성 검사도 반복했다.

선택한 런타임의 모델 바인딩을 먼저 표시하고, 다른 로컬 후보는 명시적으로 탐색한다. 바인딩은 비배타적 목록이며 직접 파일·폴더·배포 설정 경로를 입력할 수 있다. 외부 엔진의 카탈로그 결과는 `unknown`으로 유지한다. 후보 선택과 검증된 실행 가능성을 분리하고 기존 실행 전 실제 모델 probe, readiness, 무결성 및 프로세스 소유권 검사를 유지한다. 공통 코드에 Strata ID·모델 이름 분기는 추가하지 않았다.

Strata의 검증 revision은 `296b59d2f73c8f04a805df29c2fa97655adace78`이다. 해당 [고정 README](https://github.com/Niko1221/Strata/blob/296b59d2f73c8f04a805df29c2fa97655adace78/README.md)는 Qwen3.8-Flash-Next 및 그 파생·양자화 모델을 대상으로 설명한다. 임의 GGUF 전체를 지원한다는 근거로 사용하지 않는다. 실제 설치된 Coder 모델 revision은 `5348543e0147355ac9cbcb031184a3546350988e`, native engine SHA-256은 `c4709f17ef974ffa34af4f0c357160a89249cabf6e9a698fbe6d0dc65a3243fa`이다.

## 자동 검사

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| 미확인 외부 모델 선택·실패 표시, 실행 전 probe 실패 시 저장/실행 방지, 기존 프로필·모델 설정 동작 | pass | 관련 UI 7개 파일 165개 검사 |
| 바인딩 기본 보기·명시적 라이브러리 탐색·런타임 변경·다른 런타임 응답 거부·기존 취소/늦은 응답 폐기 | pass | `useModelCatalog` 및 `modelScan` 검사 |
| 기존 IPC 생략 기본값·선택 메타데이터·내장 projector/embedding 필터·미확인과 unsupported 구분 | pass | API 및 모델 workspace 검사 |
| 런타임별 바인딩 격리·형식의 호환성 승격 금지·누락 경로 readiness | pass | Rust registry 10개 검사 |
| 실제 등록→미확인 카탈로그→모델 probe→소유 프로세스→HTTP 응답→변조 거부→제거/재등록 | pass | native 합성 엔진 integration 1개 검사. 실제 추론 엔진 성공과 구분 |
| 타입·lint·Rust 정적 검사 | pass | typecheck, 변경 TS/TSX ESLint, `cargo fmt --check`, `cargo clippy --locked --lib --tests -- -D warnings` |

회귀 검사는 수정 전 후보 버튼이 없어서 실패하는 것을 확인했다. 첫 수정 후에는 테스트가 dialog에서 직접 model probe를 호출한다고 잘못 가정해 실패했다. 실제 소유자인 launch provider의 preflight 검사를 별도로 검증하고 dialog의 전달·오류 유지 검사를 수정한 뒤 전체 관련 검사 165개가 통과했다. 실패 로그도 원본으로 보존한다.

## 실제 Windows 개발 GUI

구현 commit에서 새로 빌드한 Tauri 개발 GUI SHA-256은 `f9eba6ff6461833c58d418bf8099dfd9b3b203ad1dcbd6d18d8172cead7cc1d3`이다. 기존 개발 앱은 정상 언로드·종료한 뒤 같은 개발 터미널에서 한 번 재시작했다. 실제 UIA tree와 화면을 모두 확인했다.

| 항목 | 판정 | 실행 근거 |
| --- | --- | --- |
| 선택한 Strata 런타임의 기본 모델 보기 | pass | 등록된 Qwen Coder 배포 경로 1개와 실제 확인 필요 안내를 표시. 관련 없는 모델 목록은 먼저 탐색하지 않음 |
| 다른 로컬 후보 탐색 | pass | 명시적 버튼을 누른 뒤 기존 GGUF 모델들을 미확인 후보로 표시. 호환 지원을 주장하지 않음 |
| 바인딩 목록에 없는 경로와 실패 복구 | pass | 임시 합성 배포 JSON을 직접 입력·선택하고 실행 요청. 실제 adapter probe exit1로 거부, 편집기에서 오류 표시. 이 시점 기존 프로필 7개·대화 7개의 해시 보존. 변경을 버리고 재진입하자 원래 Strata 프로필·배포 경로와 바인딩 보기가 복원됨 |
| 같은 실제 Strata 엔진의 probe·로드·GUI 응답 | pass | 기존 Strata 개발용 프로필로 실행 전 확인을 통과하고 모델 로드됨. 새 대화에서 `2+3은 얼마야? 숫자만 답해.` → `5`. PP 1,861 / TG 44, TTFT 2.07초, 요청 2.57초 |
| 기존 데이터·엔진·배포 보존 | pass | 기존 대화 7개 전체 SHA-256 보존, 이번 검증 대화 1개만 추가. 프로필 6개 전체 해시 동일. 검증용 Strata 프로필은 저장 동작에 따른 revision만 1 증가했고, 그 필드만 되돌린 canonical hash가 사전 해시와 같아 모든 설정 보존을 확인. 기존 사용자 프로필 5개는 전체 해시 동일 |

원래 배포 JSON SHA-256 `39432ce15f33e303b446c236d6254e87c05eeee3c8bfb549e8ba8003a65df1b8`, 별도 개발 배포 JSON SHA-256 `bb4707ab7eb0af2a910576c1ef02c5ba98146eca450f77783adb02039fd3aed4`도 그대로다. 두 설정은 개발 origin의 CORS 허용 항목만 다르며 실제 모델·토크나이저·엔진 설정은 바꾸지 않았다. 기존 32토큰 요청의 내용 실패를 이 새 운영 검사로 대체하지 않는다. 개발 앱과 Strata는 사용자가 바로 사용할 수 있도록 실행 상태로 남겼다.

원본은 `tmp/strata-dev/model-selection-*`이며 개인 경로·설정·대화 내용·토큰은 커밋하지 않는다. 자동 검사는 합성 계약 증거, 위 GUI 응답은 고정 실제 엔진 증거로 구분한다.

## 후속 OS 및 배포

Linux/Mac에서는 이 수정 이후 source로 외부 런타임별 바인딩 보기, 미확인 후보 탐색·직접 경로, 런타임 전환·취소·오류 복구, 해당 기기의 실제 지원 모델 probe와 추론을 재검증한다. 다른 OS의 공통 수정은 Windows의 해당 회귀 검사와 실제 모델 선택 흐름으로 연결한다. 이번 후속 수정의 새 production 설치 패키지 및 Linux/Mac 실제 검증은 수행하지 않았다. 이전 goal의 고정 production 검증과 이번 개발 앱 검증을 합쳐 기록하지 않는다.
