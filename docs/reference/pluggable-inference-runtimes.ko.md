# 교체 가능한 추론 런타임

공통 런타임 인터페이스와 외부 프로세스 어댑터 v1을 구현했다. llama.cpp·vLLM·MLX의 기존 설치·실행·프로필 계약을 유지하며, `custom.*` 엔진은 사용자 선택 manifest로 앱 재빌드 없이 등록한다. 등록은 외부 실행 파일을 실제 실행하는 작업이다. 사용자가 검토한 자신의 빌드와 probe를 선택한다.

Rust의 `InferenceRuntimeAdapter`는 실행 파일, 구조화된 `EngineCommand`, 실행 종류와 `EngineInfo`를 제공한다. 내장 세 엔진과 외부 어댑터는 같은 프로세스 소유권·readiness·종료 경로를 사용한다. 외부 프로그램을 Python 환경으로 취급하지 않는다. 구현은 [adapter.rs](../../src-tauri/src/providers/adapter.rs), [registry.rs](../../src-tauri/src/providers/registry.rs), [등록 UI](../../src/features/runtimes/ExternalRuntimeRegistration.tsx)에 있다.

v1 외부 경계는 loopback OpenAI v1 HTTP다. 해당 API를 직접 제공하는 서버나 사용자 빌드 bridge를 등록한다. bridge는 고유 엔진의 요청·응답을 canonical HTTP/SSE로 변환한다. 등록된 부모 프로세스는 foreground로 남아야 하며, 독립 daemon이나 AioLM 밖에서 실행한 서버에 연결하는 모드는 제공하지 않는다. 기존 gateway 공개 API는 유지한다.

`custom.*` 선택과 옵션은 등록이 없어도 설정·프로필·프로젝트에 보존된다. 등록 누락·OS 불일치·probe 실패 때 실행을 거부하며 llama.cpp로 바꾸지 않는다. 설정 schema는 14다. schema 13 파일을 읽을 때 기존 내용을 `config.v13-before-v14.json`에 보관하고 이전 설정을 이전한다. 구버전 앱은 schema 14를 지원하지 않으므로 백업 복구는 앱을 종료한 상태에서 명시적으로 수행한다.

외부 v1은 모델별 probe가 확인한 task·입력·chat template·도구 능력과 실제 usage를 공통 Chat·프로젝트·세션·MCP·RAG·gateway에 전달한다. 외부 엔진의 정확한 tokenizer/cold-cache 벤치마크, CPU reference 심층 검증, ABI가 보장된 portable bundle은 **unsupported**다. 기존 내장 엔진 기능·측정·이력·CSV/XLSX는 유지한다. 등록된 opaque 모델 binding의 무게 파일 크기는 미확인으로 표시하며 deployment JSON 크기를 weights 크기로 사용하지 않는다.

등록과 실행마다 프로그램·선언한 adapter artifact SHA-256을 확인하고 선택 모델로 fresh probe를 실행한다. 변경한 실행 파일은 등록 제거 후 다시 등록해야 한다. 모델별 probe cache는 모델과 launch 옵션별로 분리한다. 모델 cache identity는 metadata와 제한된 header/config fingerprint이며 전체 weights의 무결성 검증을 대신하지 않는다. 다운로드·실제 기기 검증에서는 별도 전체 SHA-256과 revision을 사용한다.

등록 제거는 앱의 등록 metadata만 제거한다. 외부 실행 파일·모델·작업 디렉터리는 보존한다. 모델 bindings는 manifest의 명시적인 `models` 목록만 모델 라이브러리에 추가한다. 외부 디렉터리의 임의 JSON을 모델로 검색하지 않는다.

등록 형식, 실행 가능한 예제와 Windows·Linux 검증 절차는 [어댑터 인계](runtime-adapter-handoff.ko.md)를 따른다. 아래 계약 중 v1에 없는 확장 능력은 후속 구현 방향이며 현재 지원으로 표시하지 않는다.

## 공통 기능과 engine-native capability

지원 여부는 engine 이름만으로 결정하지 않는다. 설치 probe, 선택 모델·bindings, protocol 구현을 해석한 **model-resolved capability**가 task·modality·tools의 사용 가능 여부를 결정한다. 지원, 명시적 미지원, 아직 확인되지 않음과 readiness 문제를 구분하고 근거·이유를 표시한다. 미확인 값을 지원으로 승격하지 않는다.

- **모델 관리:** GGUF·safetensors 등 형식 registry와 adapter의 loader 검사를 분리한다. GGUF는 형식이며 특정 engine 선택과 동의어가 아니다. 같은 공통 기능·계약을 유지해도 동일한 weights 파일이 모든 엔진과 호환되는 것은 아니며 실제 형식·모델 지원은 loader capability로 확인한다. 개인 엔진의 새로운 형식도 registry/adapter를 통해 검사할 수 있어야 한다. app-owned 다운로드 manifest, 불완전 상태, 삭제 보호와 외부 파일 보존 계약을 유지한다.
- **Chat·gateway:** canonical 요청·결과는 message, reasoning, tool-call ID/arguments, 모델 alias, task, media, error, authoritative usage와 종료 이유를 보존한다. 내장 protocol 또는 별도 adapter가 엔진 요청·SSE를 변환한다. chunk 경계·UTF-8·취소·정상 종료·중간 오류의 의미를 유지하며 gateway의 기존 공개 wire API를 보존한다.
- **프로젝트·RAG·MCP:** 프로젝트·인용·문서 index·승인/거부/취소·재시도 기능은 공통 계층에 남긴다. 별도 task의 embedding runtime을 명시적으로 연결할 수 있어야 하며, 기존 keyword 검색 정책을 유지한다. 도구를 지원하지 않는 답변 모델에서는 이유를 알리고 tool 요청을 거부한다. tool 정의나 후속 응답을 조용히 제거하지 않는다.
- **미디어 전처리:** 문서 추출·로컬 영상 frame 추출·media 보관·취소는 host 서비스다. STT는 사용자가 연결한 별도 transcription runtime을 이용할 수 있다. 답변 runtime과 전처리 runtime을 구분하고, 저장된 transcript/frame·원본 참조를 재로드·재시도에서 재사용한다. 지원하지 않는 입력을 임의로 텍스트로 바꾸거나 엔진을 자동 교체하지 않는다.
- **프로필·세션:** 공통 선택·저장·revision·적용 snapshot·기록은 유지한다. engine별 옵션과 runtime/model binding을 구분하고, 다른 engine의 옵션을 새 engine으로 전달하지 않는다. 실행 중 세션 identity가 저장된 이전 선택보다 우선한다.

**모델 loadability와 chat-template 지원은 별도다.** GGUF나 다른 base 모델을 로드하고 text completion이 가능해도 chat template가 없으면 chat 요청은 사용할 수 없을 수 있다. 모델 파일의 template와 실제 loader가 선택한 tokenizer/processor의 template도 구분한다. 임의 template나 다른 모델을 기본 복구값으로 넣지 않으며, 확인된 limitation과 필요한 사용자 선택을 안내한다.

## 지표·벤치마크·검증·portable 계약

공통 화면·이력·CSV/XLSX는 유지한다. Adapter는 제공한 값, 명시적 미지원, 미제공/미확인을 구분하고 값의 방법·단위·범위를 전달한다. authoritative prompt/completion usage와 추정 token 수, engine phase 시간과 client 관측 시간, process-group RSS와 device/unified memory를 섞지 않는다. 미제공 값을 0이나 성공으로 채우지 않으며 TTFT를 PP phase 시간으로 대체하지 않는다.

| 기능 | adapter가 제공해야 하는 근거와 미지원 처리 |
| --- | --- |
| Serving benchmark | 격리된 같은 엔진·모델 실행, 정확한 tokenizer/요청 길이, 실제 context/concurrency 확인, 입증된 cold-cache 절차, authoritative usage, client timing과 소유 process RSS. 지원이 없으면 해당 측정의 이유를 표시하고 가짜 결과를 만들지 않는다. |
| Deep verification | 실제 장치와 reference의 비교 방법·coverage·fingerprint·결과를 제공한다. partial을 full pass로 바꾸지 않고 reference를 제공할 수 없으면 명시적으로 미지원/미확인으로 남긴다. 기존 실패·override는 정확히 같은 조합에만 적용한다. |
| Portable | 해당 runtime 종류의 재현 가능한 binary/dependency·hash·OS/architecture/ABI 계약과 새 환경 import/probe를 제공한다. 일반 개인 실행 파일을 Python wheel bundle로 간주하지 않는다. adapter가 이 기능을 제공하지 않으면 registration과 구분해 미지원으로 표시한다. |

일반적인 OpenAI chat 응답만 제공하는 개인 엔진은 Chat을 연결할 수 있어도 위 benchmark/deep/portable 능력을 자동으로 갖지 않는다. 공통 기능 코드와 데이터 형식은 유지하고 실행 가능한 부분과 불가능한 부분을 capability로 설명한다. 실제 검증 상태는 기존 `pass / fail / unsupported / unrun / blocked` 의미를 유지하며 실패를 skip으로 통과시키지 않는다.

## API·데이터 호환성

제안 구현은 frontend/native engine ID와 catalog·runtime/engine info를 확장하고, 새로운 manifest 등록·probe·adapter 계약을 추가해야 한다. 기존 Python 등록 IPC/CLI와 manifest는 계속 읽을 수 있게 유지한다. `is_python = non-llama` 같은 판정은 descriptor의 runtime 종류로 옮기며 공통 API가 개인 엔진을 내장 engine 이름으로 위장하지 않는다.

- 기존 `llama.cpp`, `vllm`, `mlx-vlm` ID와 해당 options, runtime 선택, 프로필·적용 revision, system prompt, 대화·프로젝트·세션·벤치마크 원문 의미를 보존한다. 과거 provider 누락 값이 llama.cpp라는 이전 규칙도 유지한다.
- nonempty 미등록 ID를 llama.cpp로 fallback하지 않는다. adapter가 제거되었거나 offline이어도 해당 설정·옵션·프로필·기록을 보존하고 unavailable로 표시한다. adapter 재등록 후 저장된 선택을 복구할 수 있어야 한다.
- 이전은 versioned·원자적으로 수행하고 원본 backup을 보존한다. 미래 schema/adapter 버전은 무손실 보존·명시적 거부 규칙을 가지며, 오래된 앱이 새 데이터를 다시 써서 잃지 않도록 검증한다.
- 공개 benchmark schema 1/2와 기존 의미는 바꾸지 않는다. 개인 엔진의 공개 projection이 필요하면 별도 versioned 계약과 수신 서비스 지원을 먼저 추가한다. 그 전에는 로컬 기록을 보존하며 기존 이름으로 위장하거나 공개 upload를 활성화하지 않는다.

## 구현 전환 순서와 수락 기준

1. 기존 세 엔진·설정 이전·공개 schema 1/2의 계약을 고정하고 registry/descriptor와 version 협상 경계를 추가한다. 내장 ID의 저장·wire 표현은 유지한다.
2. 내장 엔진의 probe·모델/옵션 검사·launch·protocol·benchmark 등 분기를 adapter로 옮긴다. 기존 기능 controller와 데이터 계약의 변화를 최소화하고 Windows/Linux 공통 검사를 통과시킨다.
3. 합성 네 번째 엔진을 manifest로 등록한다. 내장 protocol과 out-of-process 변환 경로를 확인하며, 공통 feature/lifecycle 코드에 새 engine-specific branch를 추가하지 않고 전체 여정을 검사한다.
4. 실제 사용자 빌드 엔진을 별도 테스트 환경에서 등록·probe·실제 추론한다. 정확한 source/build identity와 모델 revision을 고정하고 선언한 capability를 실제 입력·응답으로 검증한다.

| 수락 항목 | 필요한 확인 |
| --- | --- |
| 앱 재빌드 없는 교체 | 고정된 AioLM binary에 합성 네 번째 엔진과 실제 개인 build를 등록·선택·재시작·제거/재등록한다. 앱 핵심 코드 수정 없이 catalog·옵션·모델 호환성·live identity가 반영된다. |
| 공통 기능·데이터 | Chat stream·reasoning·취소·retry·기록 재로드, 프로젝트·RAG의 명시적 embedding 연결, STT 전처리 연결, MCP 승인/거부/취소/후속 응답, 프로필·multi-session·gateway routing을 지원 범위대로 실행한다. 미지원 입력/기능은 명확히 거부하며 원본 데이터·다른 엔진 선택을 보존한다. |
| 기능 코드 경계 | 새 엔진 ID 비교·전용 옵션/모듈/endpoint 가정이 공통 앱 기능과 lifecycle에 추가되지 않는다. 이런 처리는 adapter·descriptor·내장 등록부에만 존재하며 정적 검토/검사로 확인한다. |
| 계약·측정 | arbitrary SSE chunk·중간 오류·template 없음·미지원 media/tools·누락 usage/PP·잘못된 context/cache 응답을 합성 검사한다. 실제 benchmark는 정확한 usage와 cold-cache 근거를 요구하고 unsupported/partial을 전체 pass로 계산하지 않는다. |
| Round trip·복원 | 기존 세 엔진 설정/프로필/세션/이력과 schema 1/2의 read/save/export/import 의미를 유지한다. 개인 등록·설정의 round trip, adapter 부재/offline·미래 버전·충돌 시 값 보존, 지원하는 portable의 새 환경 import 후 실제 추론을 확인한다. |
| Cleanup·플랫폼 | 등록/준비/실제 loading/stream/benchmark/import의 실패·취소·재시작·종료 때 소유 process/port/staging 정리와 외부 환경·기존 출력 보존을 확인한다. Windows/Linux 계약·프로세스 소유권·경로/argv 검사와 해당 엔진이 선언한 플랫폼의 실제 실행을 구분한다. |

구현 완료는 이 문서나 합성 엔진 한 개의 성공으로 선언하지 않는다. 기존 세 엔진의 영향받은 실제 여정과 개인 엔진의 선언된 기능을 검증하고, 실행하지 못한 범위·실제 실패·upstream 제한을 근거와 함께 남긴다.
