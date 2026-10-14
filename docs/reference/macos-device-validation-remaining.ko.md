# Mac 추가 검증 목록

## 기준과 사용 범위

2026-10-14까지의 [Mac 검증 결과](macos-device-validation-results.ko.md)를 기준으로, Mac에서 더 확인해야 하는 항목을 모았다. 기록 기준 소스는 `52e489f`, 최신 오디오 순서 수정은 `f1049eb`이다. 관찰 기기는 **macOS 26.6.2 / Apple M2 / 16GB**, 앱은 AioLM 0.3.1이다. 이 문서 작성 중에는 앱·엔진을 다시 실행하거나 새로운 검증 결과를 만들지 않았다.

결과 문서 §3의 M01–M12 집계는 당시 판정이다. 이후 해결된 하위 흐름과 현재 남은 조건을 아래에서 구분하며, 전체 Mac 검증을 pass로 선언하지 않는다. 과거의 실패·차단 기록을 삭제하거나 최신 소스의 성공으로 소급 변경하지 않는다.

상태는 `pass`(명시한 조건에서 성공), `fail`(실행 후 기준 미충족), `unsupported`(현재 계약·플랫폼의 미지원), `unrun`(실행 근거 없음), `blocked`(실행 조건을 확보하지 못함)를 사용한다. 우선순위 P1은 내용 실패·최신 배포 검증, P2는 환경이 필요한 OS·기기·추가 회귀 검사다. 우선순위가 낮아도 완료로 취급하지 않는다.

Linux·Windows의 실행 계획과 결과는 별도로 작성한다. 그 작업의 입력 문서는 [공통 런타임 인계](runtime-adapter-handoff.ko.md)이며 Mac의 성공을 다른 OS의 성공으로 복사하지 않는다.

## 남은 항목 요약

| ID | 우선순위 | 관련 범위 | 현재 상태 | 추가 검증 대상 |
| --- | --- | --- | --- | --- |
| MAC-R01 | P1 | M04·M07 | fail | Gemma3n 원본 FP 참조의 긴 문장 관사 |
| MAC-R02 | P1 | M04·M07 | fail | 동일 4bit 모델의 새 음성 3개 전체 전사 |
| MAC-R03 | P1 | M02·M07 | fail | SmolVLM 256M의 지침 없는 원래 질문 및 여러 view 대조 |
| MAC-R04 | P1 | M08 | fail | MCP 승인 대기 중 개발 frontend 재로드 시도; 원인 미확정 |
| MAC-R05 | P1 | M03–M09·M12 | unrun | 최종 호환 runtime에서 아직 반복하지 않은 실제 모델 흐름 |
| MAC-R06 | P1 | M11 | unrun | 최신 소스의 arm64 DMG와 production GUI |
| MAC-R07 | P1 | M10·M12 | unrun | 최종 호환 runtime의 새 홈 export/import·실제 추론 |
| MAC-R08 | P2 | M05·M11 | unrun | 별도 OS 계정 최초 실행·Keychain·실제 과거 버전 업그레이드 |
| MAC-R09 | P2 | M02·M08·M11 | unrun | 자연스러운 Finder 설치·실행·launchd PATH·quarantine |
| MAC-R10 | P2 | M07 | blocked | ffmpeg가 실제로 없는 환경의 앱 동작 |
| MAC-R11 | P2 | M11 | unrun | 전체 VoiceOver·키보드 여정과 미확인 테마·상태의 대비 |
| MAC-R12 | P2 | M01–M12의 지원 범위 | unrun | Intel 및 최소 macOS 13.3·구형 macOS 물리 기기 |
| MAC-R13 | P2 | 외부 런타임 | unrun | Mac을 지원하는 실제 개인 엔진의 adapter 등록·추론 |

R01의 참조 실패와 R02의 실제 앱 실패 3개가 최근 요청에서 남은 **네 가지 내용 실패**다. R03–R04는 이전 검증에서 별도로 남긴 조건·원인 조사이며, R05 이후는 최신 소스 또는 다른 환경의 검증 공백이다.

## R01–R02: Gemma3n 내용 실패

근거는 [결과 §106](macos-device-validation-results.ko.md#106-gemma3n-원본-fp와-새-음성의-전사-대조)이다. 실제 앱의 4bit 모델은 `mlx-community/gemma-3n-E2B-it-4bit@66e7276cfc589073b4f92ebed58c05301f990222`, 동일 reindexed snapshot의 weight SHA-256은 `8d5af4ae73617d12496301ebad11226f9056c4b0d51dbb9ef9409234fb87d6fa`다.

최종 환경은 mlx-vlm `0.7.6+aiolm.media14` / MLX 0.32.3 / transformers 5.19.0 / native CPython 3.12.15다. 검증 wheel SHA-256은 `ba9e56cdbd8c848f08f5efbd20f0380f23e73853b1988fb417d52b3ee330d95b`다. 별도 프로필의 `extra_args=["--gemma3n-audio-padding","encoded-left","--gemma3n-audio-dither"]`, temperature 0·seed 0·output 256, 빈 시스템 지침·자동 시스템 안내 off·text-first를 유지한다. 질문은 모두 `Transcribe the full sentence exactly.`다. 출력 비교는 대소문자·구두점만 정규화하고 단어·관사·수를 보정하지 않는다.

| 입력과 SHA-256 | 기대하는 전체 문장 | 최신 실패·대조 |
| --- | --- | --- |
| `residual104-heldout-audio/long.wav` · `58c896d6dda795f2a63a80b64982a8a2ecbef4f779c0a45fa4d1b541a1e987a3` | A small orange diamond is above a purple rectangle. There are three cups on the table and one spoon beside the plate. | 원본 float32·native buffer를 유지한 BF16 참조 모두 마지막 **the plate → a plate**. 같은 4bit/명시적 신호 옵션의 실제 앱은 전체 pass이며 이 성공으로 FP 실패를 대체하지 않는다. |
| `residual105-audio/indefinite.wav` · `e57d5a28a402eb9a3d661711b67411630c78b6a0f2ec5f9d36210b9f705e45e6` | A quiet bird is sitting above a wooden shelf. There are two books on the desk and a pencil beside a lamp. | 실제 4bit 앱 **quiet → gray**. 원본 BF16은 quiet를 읽지만 **a wooden → the wooden**으로 전체 fail. |
| `residual105-audio/mixed.wav` · `e1f714e2c6bfcdcef30267b993054ae978cf38c75e6b7d1a53bab3803425a950` | The tall white tower stands near the river. A small green boat is beside the bridge. | 실제 4bit 앱 **tower stands → towers stand**. 원본 BF16 전체 pass는 동일 4bit 앱의 해결 근거가 아니다. |
| `residual105-audio/definite.wav` · `8db9fca8c592f1cf77b735969e79b60bb89c74460b1e10ac7d8bb644bfa3a0a0` | There are four apples in a basket. The yellow cup is on the shelf and the spoon is beside the bowl. | 실제 4bit 앱 **cup → cap**. 원본 BF16은 cup을 읽지만 마지막 bowl 전에 EOS로 전체 fail. |

원본 참조는 Google `gemma-3n-E2B-it@5e092ebca197cdcd8d8b195040accf22693501bc`의 공개 LFS metadata와 세 shard 전체 해시·크기가 일치하는 공개 Unsloth revision `c4291af6285b4f90d88bdf6f9a634a8d2f262cc8`을 이미 확보했다. 다운로드 크기는 10,879,085,840 bytes다. 현재 실패를 단순히 원본 가중치 접근 불가로 분류하지 않는다. Google gated 자산에 대한 정식 접근이 없다는 사실은 별개로 유지한다.

현재 참조는 실제 Transformers `Gemma3nModel.forward`에 원본 파라미터를 strict 연결하고 CPU에서 층·embedding·head를 나눠 계산한 것이다. stock 전체 모델의 GPU 실행은 unrun이다. 최초 `.to(bfloat16)` 실험은 고정 RoPE 버퍼까지 낮춰 긴 문장을 맞혔지만 native float32 버퍼를 유지한 참조에서는 다시 실패했다. 이 부분 성공을 공식 계산의 해결책으로 채택하지 않는다.

다음 작업은 원래 입력·질문·가중치를 유지한 채, 가능한 메모리·지원 runtime에서 stock 전체 원본 실행과 현재 참조의 processor·padding·attention mask·토큰 배치·중간 계산·첫 분기 logit을 대조하는 것이다. 정당한 자산 접근과 실행 자원이 없으면 해당 대조를 blocked/unrun으로 기록한다. 정밀도 차이·quantization·음향적 모호성·모델 학습의 기여를 아직 하나로 확정하지 않았으므로 새 실험은 구분할 가설과 대조 조건을 먼저 기록한다.

§106의 정밀도/packing 70회, AltUp 40회, 속도 변환, 무음 분할, width 4 후보 탐색은 네 조건을 함께 해결하지 못했다. §105의 임의 dither seed도 긴 음성을 9/16만 맞혔다. 새 근거 없이 이를 반복하거나 기본 정책으로 넣지 않는다. 정답 prefix·문자 치환·성공할 때까지 재시도·모델 교체로 pass 처리하지 않는다.

완료 기준은 R01의 올바른 원본 계산 조건에서 전체 문장 일치, R02의 같은 4bit 실제 앱에서 새 3개 전체 문장 일치다. 수정이 있다면 기존 짧은 음성·긴 음성·연속 음성·서로 다른 음성 이력, 첨부 순서 저장/재로드, 길이 초과 400 이후 복구, 취소·재시작·정상 종료도 재검증한다. 각 조건을 독립 판정하고 전체 내용 실패를 부분 단어 성공으로 통과시키지 않는다.

원본 근거는 `tmp/macos-acceptance/`의 `residual106-ui-proof.json`, `residual106-ui-{indefinite,mixed,definite,long-preserved}.json/png`, `residual106-source-native-buffers-bfloat16-official-left-0.json`과 대응 helper·로그다. 소스 자료를 받는 다른 기기에서는 이 tmp 파일들이 Git에 포함되지 않음을 고려해 합성 입력의 별도 전달·해시 확인이 필요하다.

## R03–R05: 조건부 실패와 최신 runtime 회귀

**R03 — SmolVLM 256M.** [결과 §102](macos-device-validation-results.ko.md#102-원래-모델을-유지한-잔여-오류-검증)의 동일 Q8_0/f16 projector·원래 PNG·원래 질문·지침 없음/text-first 조건은 좌우를 누락했고 후속 답변도 sphere로 틀렸다. image-first와 모든 요청 항목을 다루라는 일반 지침의 검증 프로필에서는 실제 앱·후속·재시작 pass다. 이 조건부 성공을 지침 없는 조건으로 확대하지 않는다. 같은 모델로 입력 배치·processor·실제 토큰을 대조하고, 원래 질문의 모든 내용과 후속 답변을 확인한다. 여러 view 대조는 layout 로그가 없어 harness가 실패했고 두 binary의 답변도 동일하지 않았다. 관찰 수단을 보완한 뒤 실제 view/chunk·marker·usage·내용을 비교하며, 로그 수집 실패와 제품 내용 실패를 별도 판정한다.

**R04 — 개발 frontend 재로드.** 같은 §102에서 MCP 승인 대기 중 재로드가 발생했고 원인을 확정하지 않았다. production dist/Vite preview를 제공한 실제 WKWebView에서는 Qwen3 2B의 승인→도구 실행→입력과 다른 반환값 답변·이력 재로드가 pass다. 개발 서버의 HMR·파일 변경·오류·navigation 시점과 native 요청 상태를 함께 수집해 재현한다. 재현 원인이 확인된 경우에만 수정하며, 개발 화면과 production bundle 양쪽에서 대기 유지·취소·미완료 이력·후속 답변을 확인한다. Mac 별도 승인창의 실제 클릭이 필요하면 사람이 조작하고 timeout을 늘려 성공으로 만들지 않는다.

**R05 — 최종 runtime 회귀.** media14의 실제 Gemma3n 첨부 순서·이력과 설치된 Gemma3n/Gemma4 순서 checker는 pass다. 그러나 Gemma4의 실제 음성 후속 답변·혼합 미디어와 모든 지원 모델 흐름을 최종 wheel에서 다시 실행한 근거는 없다. [복구 절차](macos-validation-recovery.ko.md)의 최종 wheel·옵션·hash를 고정하고 이전 성공의 같은 모델·입력·프로필을 재사용한다. 이미지/음성/영상·STT·오디오 이력, 실제 생성 중 취소→Retry, 앱 gateway stream/일반 오류 복구, 지원하는 tokenizer usage·cold-cache·RSS·deep·CSV/XLSX를 영향을 받은 범위에서 확인한다. vLLM local core의 검증된 400 처리와 Qwen3 MCP 후속 흐름도 최신 production 앱에서 확인한다. 합성 checker나 API 성공으로 실제 GUI 내용을 대신하지 않는다. 기존 pass는 보존하고 새 소스의 반복 실행을 별도 기록한다.

## R06–R07: 최신 배포와 runtime 번들

**R06 — arm64 DMG.** 마지막 실제 패키지 근거는 [결과 §97](macos-device-validation-results.ko.md#97-최종-패키지production-화면설정-복구와-실행-보존)의 소스 `24a3dbd68b098f9286de2757d1572aee677843c0`이다. 이후 공통 adapter·MCP 전달·호환 runtime 수정은 그 DMG에 포함되지 않는다. 해당 production 관찰도 저장된 응답·화면·정상 종료 검사이며 새 추론·benchmark는 실행하지 않았다.

검증할 source commit을 고정해 기존 `npm run package:tauri`로 새 DMG를 만든다. GUI/CLI arm64·version·bundle identity·strict 서명·전체 해시·fixture/개인 경로 제외와 새 임시 홈 CLI 기본값을 확인한다. 내장 frontend의 실제 production GUI에서 등록/프로필 저장→Ready→새 추론/usage→취소/재시도→이력 재로드→정상 Quit·소유 프로세스/포트 정리를 확인한다. 외부 adapter는 실제 모델을 사용하는 검증된 llama.cpp 빌드로 재검증한다. 개발 서버·이전 binary·저장된 응답이 새 패키지의 실행 근거가 되지 않도록 binary 해시를 기록한다. Finder 설치는 R09에서 별도로 판정한다.

**R07 — 호환 runtime 번들.** M10의 기존 세 엔진 stock export/import pass와 [결과 §94](macos-device-validation-results.ko.md#94-실제-python-bundle-취소와-frontend-수정-패키지)의 취소 근거는 유지한다. 최종 media14·검증된 vLLM local core가 포함된 번들의 새 홈 왕복은 unrun이다. 원래 환경을 보존하고 별도 테스트 환경에서 export→빈 홈 import→hash/ABI/probe→실제 추론을 수행한다. 호환 wheel의 출처·상위 wheel·변경 소스·dependency 버전이 보존되는지 확인한다. 해시/ABI/arch/OS 오류, export/import 취소와 재시도, 기존 출력·외부 환경 보호를 검사한다. 거부 또는 실패 후 staging·소유 자식·포트가 남지 않아야 한다. 불일치를 무시하거나 stock wheel로 치환해 통과시키지 않는다.

## R08–R12: Mac 계정·설치·접근성·기기

**R08 — 별도 OS 계정.** `AIOLM_HOME`만 바꾼 검사는 OS Keychain·legacy 경로까지 격리한 최초 실행이 아니다. 별도 테스트 계정과 합성 데이터로 초기 설정·기본값·legacy 이전, 합성 Keychain 항목 읽기/쓰기/수정/삭제와 허용/거부/취소·업데이트 후 재승인을 확인한다. 실제 과거 배포 버전으로 데이터를 만든 뒤 새 버전으로 업그레이드해 프로필·세션·대화·모델 경로·자격 증명 정책과 backup/두 번째 이전을 확인한다. 합성 버전 번호 교체와 실제 업그레이드를 구분한다. 권한 거부를 빈 값 저장으로 덮어쓰지 않으며 실제 사용자 비밀을 기록하지 않는다.

**R09 — Finder·PATH·quarantine.** 별도 계정에서 DMG를 Finder로 열어 자연스럽게 설치하고 앱을 더블클릭한다. shell의 `open`이 넘긴 환경을 Finder/launchd 검증으로 계산하지 않는다. 해당 경로로 MCP executable·`env node`와 CMake 탐색, 정상 종료·재실행을 확인한다. 사용자 로컬 경로의 executable은 명시적 선택/절대 경로 정책을 따른다. 실제 브라우저 다운로드로 부여된 quarantine과 첫 실행 경고·시스템 설정의 정상 열기 절차를 관찰한다. Gatekeeper 해제·quarantine 제거·shell startup 실행을 정상 설치 절차로 사용하지 않는다. hosted runner 전용 smoke script의 실행 조건도 위조하지 않는다.

**R10 — 실제 ffmpeg 부재.** 현재 Mac은 설치된 ffmpeg를 앱 PATH 복구가 찾아 부재 검사를 만들지 못했다. 실제로 설치되지 않은 격리 환경에서 전처리 요청 시 안내·설치/선택 흐름·취소·Retry·기존 첨부/이력 보존과 worker 정리를 확인한다. 현재 설치를 숨기거나 PATH 복구를 제거해 부재로 위장하지 않는다. 영상/비-WAV 지원 모델의 정상 변환 성공과 부재 조건의 안전한 실패를 별도 판정한다.

**R11 — 접근성.** [결과 §17](macos-device-validation-results.ko.md#17-접근성-의미와-gradient-판정-후속-검증)의 ARIA 수정·11메뉴 자동 검사와 특정 light Chat gradient 대비는 pass다. 일부 실제 키보드 조작 성공은 전체 VoiceOver·Tab 순서 검사를 대신하지 않는다. 실제 WKWebView의 메뉴→실행→채팅/첨부→승인/취소→진단/설정에서 키보드만으로 접근·이탈·포커스 복원을 확인하고 VoiceOver의 이름·상태·오류·대기 안내를 확인한다. placeholder와 다른 테마·메뉴·disabled/error/focus 상태의 미확인 대비를 실제 렌더 기준으로 판정한다. 자동 contrast incomplete를 제거하거나 특정 화면의 색 계산으로 전체를 pass 처리하지 않는다.

**R12 — 다른 Mac 기기/OS.** Intel 및 앱 최소 macOS 13.3·구형 macOS의 물리 기기 실행은 unrun이다. 기기별 실제 CPU·OS·메모리와 지원 runtime을 먼저 기록하고 빌드/패키지→설치/최초 실행→지원 엔진 추론→WKWebView 입력/파일/Keychain→정상 종료를 확인한다. M2/26.6.2 또는 hosted macOS 결과를 대신 쓰지 않는다. 현재 catalog의 Intel Metal과 지원 조건을 만족하지 않는 vLLM/MLX는 unsupported로 구분하고 강제 실행으로 통과시키지 않는다.

## R13과 현재 계약의 경계

Mac의 외부 adapter는 합성 네 번째 엔진과 실제 외부 llama.cpp CPU 빌드의 등록·추론·usage·취소·재시작·삭제/외부 파일 보호를 검증했다([결과 §98–99](macos-device-validation-results.ko.md#98-외부-런타임-인터페이스와-windowslinux-인계)). 실제 개인 개발 엔진 전반의 성공 근거는 아니다. Mac을 지원하는 실제 엔진이 준비되면 source revision·binary/weights/tokenizer 해시·probe capability를 고정하고 같은 lifecycle·HTTP/SSE·usage·오류·도구/미디어의 지원 범위를 검증한다. 지원을 확인하지 않은 기능은 성공으로 표시하지 않는다.

[Strata 인계](runtime-adapter-handoff.ko.md#원본-strata-및-개인-엔진)의 대상은 Windows/Linux x86-64다. 원본 Strata 실제 실행은 그 지원 기기에서 검증할 일이며 Mac M2의 필수 미완료 검사로 추가하지 않는다. 향후 Mac 지원 빌드가 확인된 경우 R13의 별도 대상으로 기록한다.

현재 외부 adapter v1의 정확한 tokenizer/cold-cache benchmark·CPU reference deep·ABI portable bundle은 **unsupported**다([공통 런타임 계약](pluggable-inference-runtimes.ko.md)). 이들을 R05/R07에서 지원되는 내장 엔진과 섞지 않는다. 실제 file promise의 안전한 붙여넣기 처리는 관찰했지만 file promise import 역시 unsupported다.

Developer ID/공증은 별도 배포 결정이고, 공개 benchmark upload는 이번 검증에서 제외했다. Force Quit/SIGKILL 복구·계정 간 single-instance 보호는 알려진 별도 설계 범위다. 추가 범위가 정해지기 전에는 필수 미구현 기능으로 취급하지 않으며 정상 Quit의 pass를 강제 종료의 pass로 확대하지 않는다.

## 완료 근거를 유지할 항목

- Qwen3 2B 실제 MCP 승인→도구 실행→입력과 다른 반환값 후속 답변·저장/재로드는 §102에서 pass다. 실제 OS No·도구 호출 중 취소는 §88에 별도 pass 근거가 있다.
- Gemma4 음성 후속 답변은 §101의 선택 프로필에서 pass다. 최신 wheel 반복은 R05이며 과거 내용 실패를 같은 조건의 현재 실패로 재기록하지 않는다.
- Gemma3n 기존 짧은 전사·긴 4bit 전사·연속 음성은 §104–106의 명시적 옵션에서 pass다. audio 순서·저장/재로드·서로 다른 음성 이력·오류 후 복구는 §106에서 pass다.
- 실제 한글 IME는 §27, 트레이 Show·Dock 복원·트레이 Quit은 §89–90, 사람의 알림 제목/본문 수신은 §91, clipboard/picker의 기록된 범위는 §19·92에서 pass다. CUA의 과거 접근 제한을 현재 미실행으로 반복하지 않는다.
- M01·M02·M05·M06·M09·M10·M12의 기존 pass는 기록된 source/환경/입력 범위에 한정한다. 최신 수정의 영향이 있는 부분만 새 판정으로 덧붙인다.

## 후속 실행 기록과 종료 조건

후속 검증은 이 목록의 ID별로 [결과 문서](macos-device-validation-results.ko.md)에 새 절을 추가하고 다음 값을 남긴다.

| 기록 | 필요한 내용 |
| --- | --- |
| 실행 기준 | 날짜, source/수정 commit, 실제 기기/OS/arch, GUI/CLI binary 해시 |
| runtime·입력 | 엔진/호환 wheel/의존성 버전·해시, 모델 full revision·weight hash, 합성 파일 hash, 질문·프로필·미디어 순서·cache 조건 |
| 기대와 관찰 | 실제 전체 응답·usage, 오류 코드·승인/취소 시점, pass/fail/unsupported/unrun/blocked와 이유 |
| 소유권·보존 | 요청/queue 상태, 소유 process group·port·staging 정리, 기존 홈·환경·외부 파일·이력 비교 |
| 남은 조건 | 환경/upstream/제품/검사 도구 문제의 구분, 미확정 원인, 다음 대조와 필요한 기기/계정 |

원본 로그·모델·번들·캡처·실험 helper는 `tmp/macos-acceptance/`에 보관한다. 커밋 문서에는 익명화된 조건과 결과만 남기며 개인 경로·계정 식별자·자격 증명·원본 사용자 기록을 넣지 않는다. 검증용 홈뿐 아니라 실제 사용자 앱의 설정·대화·프로필·모델을 보존하고, 작업 종료 시 검증 앱과 소유 프로세스를 정리한 뒤 원래 실행 상태를 확인한다.

재현된 제품 결함은 필요한 최소 수정과 회귀 검사로 해결하고 관련 실제 앱 흐름을 재검증한다. readiness 제거·hash 무시·실패 skip·근거 없는 timeout 확대는 해결 근거가 아니다. 환경이 필요한 항목은 남은 상태를 명시한다. 위 목록을 완료해도 실행하지 않은 OS·모델·계정·기능까지 전체 통과로 확대하지 않는다.
