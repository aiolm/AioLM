# Windows runtime adapter 검증 결과

## 실행 상태와 source

2026-10-14–16의 **진행 중인 실제 Windows 검증 기록**이다. W01–W08 전체 통과, G01–G07 구현 완료 또는 goal 완료를 뜻하지 않는다. 필수 실제 검사와 구조 구현이 남아 있으므로 종료 commit은 아직 지정하지 않는다. Linux/Mac 실제 실행은 이 Windows 작업의 후속 범위다.

- 시작 source: `df3264bad99deb0144b947f96300e8625f7a2da5`, `origin/codex/windows-runtime-adapter-handoff`의 필수 인계 commit 포함을 확인했다.
- 작업 branch: `codex/windows-runtime-adapter-validation`. 기존 변경과 사용자 설치·데이터를 보존했으며 원격 push는 수행하지 않았다.
- 과거 구현 checkpoint: `d025c94`. 공통 schema/help 기반 위에 명시적 entry point 등록·공통 GUI(`bd41dfa`, `becf8ee`), native 옵션·프로필·실제 argv 연결(`2f91aa7`), 저장한 옵션 순서/항목별 alias와 수락된 help에 연결된 arity/repeat 명시적 확인(`707331f`, `635fdc3`), CLI의 같은 effective schema 검증(`3966879`), 프로젝트의 linked profile provider/소유 설정 보존(`bbf4106`, `8801c27`)을 추가했다. 격리 검사에서 `npm run test:unit` 195 files/2,059 tests(coverage 포함), typecheck/lint, Rust library 1,071 tests와 integration suites, Clippy·no-default-features·fmt check가 pass다. Python helper 검사는 앞선 `becf8ee`에서 격리 CPython 3.12로 pass했다. 처음 PATH의 WindowsApps 별칭 실행 실패는 별도 환경 오류로 보존한다. 자동 검사는 실제 엔진·production GUI 수락의 대체 근거가 아니다.
- 검토 후 필수 구현·실제 검증이 계속된다. `c02bdc4`·`a0a6589`는 항목별 equals alias와 dash-leading 값, GUI/backend order record 거부 조건 차이를 재현 후 수정했다. Rust 1,073개와 관련 GUI 449개 검사·typecheck/lint/Clippy가 pass다. D15 최소 창 넘침은 `42008b4`·`700af30` 수정 후 source `79da287` production WebView2에서도 pass했다. 이후 실제 G 여정에서 D21 저장 차단을 재현해 `d025c94`로 수정했다. 전체 UI 195 files/2,064 tests·typecheck·변경 파일 lint는 pass이며 새 production 검증은 남아 있다.
- 실제 GUI 기준은 원래 `0cfbbb5` package6와 새 `becf8ee` package7을 각 항목에 구분해 기록한다. package7에서 D16·D17·D18 및 D19의 충돌/identity 범위를 실제 재검증했으며, 이후 source의 기능에 소급 적용하지 않는다. 나머지 실제 흐름과 최종 빌드 재검증은 진행 중이다. 별도 Python adapter helper는 `4d57c11`의 파일을 명시적으로 재등록한다.
- 앞선 제품 checkpoint `55cd70b`는 실제 GUI에서 재현한 같은 버전 runtime 구별 문제를 수정했다. `2d7f97c`에서 어댑터 소유 help·catalog·metadata와 공통 preview·CLI 검증을 추가했다. 앞선 `a7581a2`은 `21931a4`의 긴 Windows 경로, `b47f920`의 stale 민감 값 보호, 명시적 도움말 인코딩·locale GUI를 포함한다. F8의 `ab1db3a`·`3e76298`·`01c77c2`와 민감한 위치 인수 표시 수정을 포함한다. 앞선 `3235e97`은 `f0c2966`의 Strata 도움말/예약 옵션과 import 검토 경고 상태 수정까지 포함한다. `c3e9edf`의 개방형 setup/Strata bridge, `0fbbff9`의 실행 디렉터리, `414c068`의 명시적 명령 scope, `f17ab6a`의 managed arity와 `9062ed7`의 import 경고 마스킹을 추가했다. 각 검사의 source와 범위는 아래 D36–D59 및 G 표에 구분한다. 후속 구현과 최종 production 검증이 진행 중이며 이 checkpoint를 Windows 종료 commit으로 사용하지 않는다.
- 앞선 positional 구현 커밋 `1de9dc8`은 실제 등록 metadata에서 관찰된 위치 인자에 명시 정보를 연결한다. `9909675`의 등록 반환 identity 안내와 `fc75f78`의 민감한 고정 인수 표시 보호를 포함한다. D66의 검사 전용 child-home 격리 보강은 `eaee5bf`로 커밋했다. 앞선 `c66d821`의 Windows headless 자식 listener 소유권, `5897a50`의 공통 옵션 메뉴 크기, `8f7ef9b`의 소유 근거를 보존하는 Windows staging 정리·중단 복구는 자동 검사를 통과했다. D62 최종 source의 전체 Rust 27개 아티팩트 1,157 pass/0 fail/16 ignored, 실제 venv opt-in·두 Clippy·fmt와 보호 장치별 대조 검사를 확인했다. 이 수정들을 포함한 production 재검증은 아직 `unrun`이다. package12 Strata의 staging 잔여 실패는 유지하며, 아래 이전 binary 결과를 최신 source의 완료 근거로 확대하지 않는다.
- raw: 저장소의 `tmp/windows-acceptance/`. 지속적인 재개 기록은 그 아래 `progress.md`다. raw·모델·개인 경로·프로필·토큰·build 산출물은 Git에 포함하지 않는다.
- 후속 UI checkpoint는 `3d1c2b8`·`bc5475b`다. 첫 화면을 특정 엔진 선택 대신 중립 목록과 실행 파일/entry point 추가로 변경했다. `3d1c2b8`에서 전체 자동 검사 195 files/2,072 UI tests·typecheck·lint가 pass이며 실제 production 목록/등록 화면/개인 엔진 help 탐색도 실행했다. 그 과정에서 발견한 D23을 `bc5475b`로 수정하고 관련 65 tests·typecheck·lint를 통과했다. D23의 수정 후 production 재검증과 나머지 G 구현은 남아 있다.
- 후속 공통 계약 수정은 `c3c6d09`(바인딩과 일반 옵션 충돌 방지), `324f220`(Windows/POSIX 가져오기), `38cc039`(정적 가져오기 응답 연결)다. `324f220`에서 전체 UI 2,076 tests·typecheck·lint, Rust library 1,078 tests·세 integration 여정·Clippy/fmt가 pass다. `38cc039`의 관련 44 tests·typecheck·lint도 pass다. 기존 opt-in/하위 프로세스 전용 ignore를 새로 추가하지 않았으며 해당 OS/실제 엔진 검증은 별도로 기록한다. 이 수정들의 최종 production GUI 수락은 남아 있다.

결과는 `pass`, `fail`, `unsupported`, `unrun`, `blocked`로 구분한다. 표의 `unrun`은 해당 묶음의 필수 검사가 남았다는 뜻이며 그 안의 이미 실행한 결과는 별도로 남긴다. 실패를 미지원으로 바꾸거나 다른 모델의 성공으로 덮지 않는다.

아래는 이전 package3의 산출물이며 이후 실행으로 소급 변경하지 않는다. package5와 새 패키지의 근거는 다음 절에서 구분한다.

| 이전 실행 산출물 | SHA256 |
| --- | --- |
| production GUI | `f914174a03893c747d7a8e126bd556c92f6433f6d04093fae9992d48bb57c652` |
| production CLI | `c39e2cb1f245e596892fdc617e3fa7d5f666a824217a51ea4e3cc9900db5eebc` |
| NSIS | `6bece1039c28a0c5362fcb0aaf23197d4eefe0bb4c7c28a78f9d857bbd6e83c2` |
| MSI | `9df152b4eaf59bc7e1f29e3205717eb662aac2199830921de19fa84720052cd7` |
| adapter helper (`4d57c11`) | `30191bcc9f6d39795235466e39d8a81be1c431bfe667cef984a92f210aee1847` |

### 후속 실제 실행 checkpoint

package5 source는 `8b4c5ea`이며 GUI SHA256 `ebabee8ab866b3f808e596c96e268cd37bde2f4d3d5eacf80da9860a6392f7de`, CLI `d3d32597e7dedca2d6a2fd245244f861bf2f49c6dd5c04947fb533cbc1af9d02`, NSIS `8324ec69e069bb3c7ac4946aae296aa05056d77759e26a5ed49b2da88ebe411f`, MSI `373dd30fd791df17fbaafb0668a118d12932abbe526b28b379f6fe3a72d786d1`이다. 패키지 생성 성공과 실제 설치 성공은 구분한다.

package6/source `0cfbbb5`의 네 target도 Windows native 빌드 exit0이다. 최종 GUI SHA256 `06965b1fc74508a51cb88312552782d19d93c3db8795bc5cd1e3a25d22d0ae8a`, CLI `56068220700624d98ae9c8772d95dbe6e4a3f6d20e459c03f3a685308f5224ef`, NSIS `94bd5a0d61e32d04aedd4000eef7df42475195d52f66789cd709db7e33646f99`, MSI `07932494084c9b64ef0136d6d142592acc5c4e2b77b7119e020d2776fde715c5`다. D14 실제 큰 창과 640×560 논리 크기 창에서 사유/긴 오류가 읽혔고, 좁은 탐색 메뉴 열기→Escape 닫기와 원래 창 크기 복구를 확인했다. 전체 접근성 검사 통과로 확대하지 않는다. raw `gui/60,68–72`.

package8/source `79da287922d05aaec0e473dfa24b2af0322de48a`도 네 target 빌드 exit0(300,502ms)이다. 고정 GUI SHA256 `1b4de07a8dd3c6dc4bc2a6b28905b41356bc26cee63c1bc6fa8a49b04f76db12`, CLI `7d948ad8533df81c5af160219191021ae4da1b9dff901db5ee7de8acccd9bded`, NSIS `0c33797950896f470c371b9706fbebca57a698fcd0c4eaa9ba7553f83bfb941c`, MSI `a631b8a0cd1a5fbe797ffe32aac1ab1ea921c68b5d823cb6fb317a4f2b438547`를 기록했다. CLI `--help` exit0이다. 설치 파일은 실행하지 않았고 원래 설치를 보존했다. D21 발견 이전의 고정 후보이며 이후 수정을 포함하지 않는다. raw `package8-candidate.json`, `claude-g-repair/runs/1792050619582-package8-candidate`.

package9/source `43500ed68fd74b55827b90cefefc321c9c447db9`는 D21 수정 후 네 target 빌드 exit0(294,464ms)이다. GUI SHA256 `28718b774ece4cf960c539c7e6906024cc9ce2b63c77e82c4d7159e17f56f1c2`, CLI `47e91c354951d7b93d4b29ba325cb448535f23be4dd0c4ace2471a343c35055c`, NSIS `6299cc6953a56167bdc4c1fad6b2fd76d3713737f70e3ad7d0096f79a8fea652`, MSI `308f6a8f188615ffd94d9ac24d89c6278fc0cd9719a979e29bb397c869404cb3`를 고정했다. 고정 후 생성한 미지 옵션으로 실제 합성 여정의 저장·시작·argv·응답을 확인했다. 아래 G 기록과 D21의 범위에 한정한다. raw `package9-candidate.json`, `g9-synthetic-first-response-verdict.json`.

package10/source `3d1c2b834cf3af15cd6c95b721d0d53303fe980b`는 중립 UI의 production 후보이며 네 target 빌드 exit0(281,786ms)이다. GUI SHA256 `07f51ffb9d67cf723cc13e08126c014d980418a567112dafd490d19d3ff78d10`, CLI `209c204d91be26ec45ccfcf5ad1f1587c7e8695cf0bacee1db8f1808bd74c8e3`, NSIS `3a7626651c4886a38040ad538e7db00a6ac4e801d74314d3110062613ec96ddf`, MSI `67333026dced419e95402b8735452cbe106fffce1f41684bb858c904cc88846c`다. 실제 WebView2에서 중립 목록→등록 엔진 검색/열기→목록 복귀→엔진 추가→개인 빌드의 help 253개 옵션·미확정 정보·원본 help→복귀 후 입력 보존을 확인했다. 360×520 논리 크기(DPI192)에서도 실제 화면을 관찰하고 원래 크기로 복구했다. 기존 프로필 4개·대화 파일·실행 선택은 그대로이며 정상 종료했다. 이 후보에서 D23을 재현했으므로 해당 결함의 pass 근거로 쓰지 않는다. raw `package10-candidate.json`, `package10-neutral-ui-verdict.json`, `gui/856–882`. 두 후보의 설치 파일은 실행하지 않았으며 이전 후보의 네 바이너리는 해시 확인 후 보존했다.

- **ROCm 실제 실행 pass 조건:** 기존 HIP7.2의 두 GPU numerical gate는 median KLD 1.341866으로 허용값 0.038160을 넘겨 **fail**이다. 별도의 공식 TheRock `10.2.0a20260923` SDK(archive SHA256 `01893448a7d5d5efe921afd15da800d44fb0a98076934a82fffe45c2932aa799`, rocm-systems `0816fc809a4ff1f21c330357368f977f4ffe67fd`)로 같은 b11617 source를 새로 빌드한 조합은 gate·export/import·재검사와 두 GPU의 실제 Qwen0.5B 응답/usage·stream 취소·재시작·정리를 통과했다. runtime ZIP SHA256 `82eb56534293410d08bcf14016af74ce08af61c63c11905cafcc691ce3247808`. 이 실행의 앱 source는 `140fef0`이며 최종 source의 GUI 재검증은 남아 있다. 전역 SDK·driver·기존 실패 기록을 바꾸지 않았다. raw `rocm-native/actual-acceptance/REPORT.md`.
- **W06 공통 연결 pass 조건:** package4/source `a17c758`에서 실제 BGE embedding 384차원과 Strata 답변을 분리해 vector RAG, 독립 세션 정지, gateway 누락/오류 key 401·모델 라우팅·미등록 모델 404를 확인했다. raw `strata-native/logs/34–35`. 이후 package6의 같은 실제 BGE 세션을 GUI에서 로드해 gateway embedding 200/384차원/usage8, chat의 앱 수준 400 `unsupported_task`, 누락/오류 key401을 확인했다. D12의 해당 결함은 실제 gateway에서 재검증 pass이며 `gui/67-d12-gateway-package6-result.json`이 근거다.
- **실제 STT 연결:** Whisper `0c7be696371069e0baa2515ed7aa08d5a5473aa6`의 Windows CPU CLI SHA256 `21bfbad3dd5749b6f82e82786c30f8714a82a754d424af46903d4370f738d984`와 명시적 임시 bridge를 사용했다. tiny.en revision `5359861c739e955e79d9a303bcbc70fb988958b1`, weight SHA256 `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f`. 공식 JFK WAV SHA256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`를 GUI에서 선택해 실제 전사→Qwen0.5B 답변→저장/재시작을 확인했다. 첫 답변의 녹음에 없는 추가 주장은 fail 기록으로 보존했고, 같은 이력의 정답을 포함하지 않은 정확한 문구 질문에는 실제 녹음의 문장을 반환했다. raw `whisper-native/38–41`; 최종 source 반복은 남아 있다.
- **실제 이미지와 portable:** 원래 SmolVLM256 Q8_0/f16 projector를 유지했다. model revision `b9e4379657e1450d04d02eec8e345667265b0a00`, model SHA256 `2a31195d3769c0b0fd0a4906201666108834848db768af11de1d2cef7cd35e65`, projector `0802360aca1748f112ea510b8ff277c65b1361c8ef30ed89b83c9c7a60d08e96`. 고정 b11460 source `78651c410dd8d97e3e22e533e0e7117889e3863a`에 기존 검증 도구의 single-view 호환 변경을 적용한 별도 native CPU build를 만들었다. server SHA256 `eed375732c4a6dc5d262c039f6f4a761a57ec2312c58826e4230c16ac60dd64d`, portable ZIP `25f51348d57a5eab0f9bfc8a43a564d947914804d3d9ff081542e4228eb1d722`. SDK 없는 PATH의 새 격리 홈 import 후 package5 CLI 실제 응답과 GUI import·명시적 profile 선택·Ready를 확인했다. 새 OS 설치 검증으로 확대하지 않는다.
- **이미지 내용의 한계와 보존:** 이미지 SHA256 `18f3d506bbcfb8d098782883c6553ec7f9a8c69643884e5d8c2d92a61fd15dc3`. 색과 도형을 함께 물은 질문에서 모양을 누락한 기존/호환 엔진의 답변은 **fail**로 남는다. 같은 이미지/모델/이력에서 정답을 포함하지 않고 도형을 다시 물었을 때 package5 실제 GUI는 `Circle.`과 usage를 반환했다. 일반적인 시각 묘사 지침과 image-first 설정은 응답·대화 전환·정상 Quit/재시작 뒤 유지됐고 이전 네 메시지가 그대로 보존됐다. raw `media-native/42–43,51–52`, `gui/54–56`. 이 조건부 성공을 원래 복합 질문의 통과로 바꾸지 않는다.
- **D12 실제 production CLI:** `0cfbbb5`의 package6 최종 CLI(위 SHA256)에서 실제 b11617 CPU/BGE를 새 홈 세 개로 검사했다. 명시적 `--embedding`과 격리된 `config.ini`의 `embedding=true` 모두 Ready 후 tasks `[embed]`·chat false·실제 384차원/usage를 확인했다. embedding 모드가 없는 BGE는 실제 generation 500을 확인해 Ready 전에 실패하고 소유 listener/state를 정리했다. headless CLI는 엔진에 직접 연결하므로 앱 gateway의 잘못된 task 거부와 별도로 판정한다. raw `d12-claude/effective-mode/production-1792017871815`. 패키징 전 CLI 해시로 실행한 같은 세 검사도 이전 기록으로 보존한다.

W03 실제 GUI의 느린 probe 취소→즉시 새 등록→이전 응답 대기 후 상태 보존·이전 child 정리도 pass다(`w03/gui-probe/44–46`). 일반 모델 선택 probe 경합, W07 나머지 실패/취소, W08 OS 통합과 별도 계정 설치, G 구현 및 최종 전체 재검증은 계속 남아 있다.

### package6 추가 실제 검사

- **D09 부분/빈 생성 복구 pass:** 같은 Qwen0.5B와 개인 b11617 CPU에서 생성 중 Stop으로 7,732자 부분 응답을 저장했다. 정상 Quit 후 재시작하여 저장된 Retry를 누르면 같은 입력으로 새 생성이 시작됐고 앞선 세 메시지와 재시도 입력이 그대로 보존됐다. 별도 3,232 prompt token 요청은 첫 토큰 전에 취소되어 빈 assistant 메시지와 Retry 입력을 저장했다. 재시작 후 Retry는 같은 두 메시지에서 674자/150 completion token의 실제 완료 응답을 반환했다. 취소 전에 끝난 첫 요청과 자동화 오류로 취소하지 못한 요청을 취소 성공으로 계산하지 않는다. raw `gui/82–99`; tool-round 취소/오류 복구는 아직 남아 있다.
- **실제 Korean IME composition pass:** 이미 설치된 한국어 입력 모드에서 물리 키 입력으로 `한글`을 조합했다. 첫 Return은 조합을 확정하고 전송하지 않았으며 두 번째 Return이 전송했다. 같은 문자열과 두 메시지의 저장/대화 재로드를 확인했다. 원래 Latin 입력 모드로 되돌린 뒤 실제 `g` 입력/삭제를 확인했고 OS 언어 설정은 바꾸지 않았다. 모델 답변의 한국어 의미 품질 검사가 아닌 입력 조합·전송 검사다. raw `gui/100–109`.
- **tray pass / 알림 표시 unrun:** 격리 설정에서 Close to tray를 켜고 창을 닫자 앱과 소유 엔진은 살아 있고 메인 창만 숨었다. 실제 Windows 숨겨진 아이콘 메뉴의 AioLM 아이콘으로 같은 창/엔진을 복원했다. 설정을 원래 false로 되돌리고 정상 Quit하여 앱·소유 엔진·port 정리를 확인했다. 알림 plugin의 제출 성공은 확인했으나 실제 OS toast를 관찰하지 못했으므로 알림 표시 통과로 기록하지 않는다. raw `gui/114–120`.
- **runtime import 취소/실패/복구 pass:** 원래 ROCm ZIP의 실제 GUI import 중 Cancel로 staging이 제거됐다. 기존 runtime의 manifest/server/주요 DLL 여섯 hash와 원본 ZIP은 그대로였다. manifest가 없는 작은 합성 ZIP은 구체적 오류로 거부하고 staging을 정리했다. 원래 올바른 ZIP으로 다시 import하여 복구했다. 별도 소유 세션의 실제 CPU 서버/health가 이 과정과 GUI 정상 Quit 뒤에도 유지돼 다른 프로세스 보호를 확인한 뒤 해당 세션도 정상 stop했다. raw `gui/128–143`, `w07/140–142,160`.
- **같은 ROCm의 최신 GUI 재검증 pass:** package6를 SDK 환경 변수가 없고 PATH에 Windows 디렉터리만 있는 격리 홈에서 실행했다. 위 TheRock bundle을 실제 GUI로 import하고 별도 profile에서 같은 Qwen0.5B, 두 GPU, `ngl=99`, layer split `1,1`을 명시했다. 새 startup canary gate median KLD 0.001908/한도 0.038160, overrides 없음이었다. 실제 응답 `51`/usage, 생성 중 취소·Retry의 새 토큰, 정상 종료의 소유 프로세스/port 정리와 재시작 후 profile/부분 이력 보존을 확인했다. 같은 profile의 새 실행은 `Tokyo`/usage를 반환했다. full-model deep gate나 이전 HIP7.2 실패의 통과를 뜻하지 않는다. raw `gui/148–166`.
- **실제 benchmark 취소/완료와 XLSX pass:** 같은 ROCm/Qwen0.5B로 단일 client의 1K prompt/1,024 output/10회 요청을 시작해 9개 완료 trial 뒤 GUI Cancel했다. 최종 상태는 cancelled/9개 보존이며 소유 benchmark child/port가 사라졌다. 별도 1K/128 output/1회는 completed였다. 실제 값은 prompt 1,024/completion 128/cache 0, client timing, TTFT 24.9765ms, TG 271.3751755tok/s, end-to-end 493.1392ms, process RAM 747,761,664 bytes다. PP 40,990.00468tok/s는 **estimated** 표기를 유지했다. GUI가 만든 XLSX(SHA256 `fe8e29c690539c2fb8e495baa2ba21afce774faf0baab22dcc601ac6f7797d59`)의 18열/한 trial을 실제 JSONL과 대조해 수치·단위·상태·빈 편차/속도비를 확인했다. native 파일 대화상자의 기본 목적지에 생성된 결과이며 자동화가 의도한 다른 경로 저장은 통과하지 않았다. CSV·의도적 benchmark 실패·build 취소/실패는 남아 있다. raw `gui/168–182`, `w07/verify-real-workbook.mjs`.

후속 GUI 조작 중 다른 Windows 앱의 색상 선택기가 입력을 가로채는 상태를 확인했다. 사용자가 닫았다고 알린 뒤 검증 창의 실제 포커스를 확인하고 아래 검사를 이어갔다. 이후 OS가 검증 창의 포커스 전환을 다시 거부해 사용자에게 해당 창을 전면으로 가져오도록 요청했다. 이 일시적 GUI 조건과 별도 설치 OS 세션 대기는 서로 다른 차단 항목이며 독립 구현/파일 검증은 계속한다.

- **실제 CSV pass:** 같은 completed trial을 GUI에서 CSV로 내보냈다. native 저장 대화상자의 기본 목적지에 생성된 648 bytes 파일의 SHA256은 `48b3ae74516e581be309758db02d80e0dcb0df8e6164d1e92bd639e7675c4dbf`다. UTF-8 BOM·18열/한 trial·위 XLSX와 같은 실측 값/단위·estimated PP·빈 편차/속도비·경로/비밀값 부재를 실제 JSONL과 대조했다. 다른 목적지 입력은 자동화의 포커스 검사에서 차단돼 통과로 계산하지 않았다. raw `gui/183–202`, `w07/verify-real-csv.mjs`.
- **의도적 benchmark 실패와 복구 pass:** 원래 14개 profile의 entry hash를 고정한 뒤 없는 template 파일을 가리키는 별도 profile을 GUI로 만들었다. 처음에는 기본 실행 설정만 바꿔 benchmark의 독립 target이 그대로였으므로 해당 completed 실행을 실패 검사로 계산하지 않았다. benchmark target을 명시적으로 바꾼 실제 실행은 같은 ROCm/Qwen0.5B에서 Ready 전 exit1, failed 상태와 원래 오류/argv를 저장했다. native 기록은 start/finish 두 event뿐이고 trial/usage가 없으며 key는 redacted다(SHA256 `a511145b57059805911dc64db3b324d166e2f7716681f36632f9c8b929b98866`). 소유 child/listener가 모두 정리됐다. Use default execution settings로 원래 profile에 복귀한 실행은 같은 모델/runtime에서 실제 1,024/128 token 한 trial을 완료했다(TTFT 23.9693ms, TG 270.1887939tok/s, 기록 SHA256 `bef5cfdaf70724ee9e4b12ed7f7d943a13d573858ba99e46517db1634362dfb1`). 기존 14개 profile은 모두 hash가 같고 실패 이력도 남았다. raw `gui/205–223`, `w07/verify-benchmark-failure.mjs`, `w07/verify-benchmark-recovery.mjs`.
- **D15 수정 후 production pass:** 원래 긴 오류 중복 노출을 `b682eca`의 요약·상세·복사·높이 제한으로 수정했다. source `becf8ee`의 지원 최소 창에서는 Tasks 가로 넘침이 남아 fail이었다(`gui/607–608`, `w07/618`). `42008b4`·`700af30`을 포함한 source `79da287` production에서 동일 PR/head·CPU와 process-local 강제 include로 실제 CMake/MSVC C1083 오류를 다시 발생시켰다. 최소 360×520 logical pixels(DPI192, 실제 720×1040)에서 native Tasks와 상세의 horizontal view가 모두 100%이고 가로 스크롤은 없다. 상세 폭은 530 physical pixels, 높이는 385이며 모든 동작이 패널 폭 안에 있고 세로 탐색으로 복사/닫기에 접근한다. 소유 포커스를 확인한 Windows Enter 펼침→Tab 상세 초점→PageDown 스크롤과 현재 실행의 원문 4,159자/51줄 복사도 pass다. 기존 PR runtime 전체·다른 ROCm 6개 파일 해시가 같고 compiler/staging은 0이며 원래 크기 복구·정상 종료를 확인했다. 원래 fail과 반영되지 않은 Orca 합성 Enter 입력은 보존하고 실제로 반영된 guarded Windows 입력을 근거로 사용했다. raw `gui/706–738`, `w07/739`. 이후 공통 수정의 최종 관련 재검증은 별도다.

### CPU 소스 빌드의 실제 취소·실패·복구

package6/source `0cfbbb5`의 GUI에서 upstream `ggml-org/llama.cpp` PR #30495, head `18dc7ef9d7424b387c672a7a94bc86ceab7fdede`, backend CPU를 명시적으로 확인했다. 다운로드→CMake 구성→실제 MSVC 빌드 단계에서 GUI Cancel build를 눌렀다. 관찰한 소유 CMake/MSBuild/cl 프로세스 12개가 모두 종료됐고 PR 다운로드 작업 공간·staging·설치 디렉터리는 남지 않았다. 기존 ROCm runtime 6개 파일의 해시가 유지됐다. **실제 source build 취소 pass**이며 엔진 빌드 완료나 추론 성공은 아니다. raw `gui/274–279`, `w07/279-cpu-source-build-cancel-verdict.json`.

별도 앱 자식 환경에만 존재하지 않는 헤더의 MSVC forced include를 지정해 같은 PR을 빌드했다. 실제 CMake compiler check가 MSVC C1083, exit1로 실패했고 GUI에 Failed가 표시됐다. 이후 소유 빌드 프로세스·PR staging·설치 디렉터리는 0, 기존 runtime 6개 파일과 원래 프로필 15개·기존 기록 파일 30개의 해시가 유지됐다. **의도한 실제 compiler 실패와 정리 pass**다. 시스템 SDK·컴파일러·환경 설정이나 upstream source를 바꾸지 않았다. raw `gui/281,286–295`, `w07/293-cpu-compiler-failure-verdict.json`.

오류 유발 환경변수 없이 정상 종료·재시작 후 같은 PR의 실제 재빌드·설치는 완료됐다. 소유 빌드 프로세스·다운로드 작업 공간은 0이고 원본 runtime·프로필·기록 해시도 유지됐다. 그러나 설치된 `llama-server --version`과 `aiolm-runtime.json`은 **AioLM의 build 396 / commit `ec0d5f6`을 잘못 보고**했다. source metadata에는 위 실제 PR head와 archive SHA256 `91e57b4c68a8743058e9543ad8cec135616777f411a33ea8e78e20910447d70c`가 기록돼 있다. 따라서 당시 빌드·설치 복구는 pass, **engine version provenance는 D16 fail**이다. archive 안에 `.git`이 없을 때 upstream CMake의 Git 조회가 둘러싼 앱 저장소로 올라가는 것이 원인이다. 엔진 launcher SHA256 `6f2206846375633e0457a0424e84fbdd09b9f450340f1b121d6645707a055923`, server implementation DLL `8da6c518fad07d1c8c36b14d6c2b349021b9bf543eeb5d60e3094f31efa2e417`. raw `gui/305–309`, `w07/310–311`과 실패한 빌드 전체를 보존했다.

`84ea139`·`d832fa0`은 Git ceiling과 검토한 engine head의 compile-time 전달·실제 생성 바이너리의 head 확인을 추가했다. source `becf8ee` production GUI에서 **같은 PR/head·같은 archive hash·CPU backend**를 다시 검토하고 실제 CMake/MSVC 빌드하여 D16 pass를 확인했다(`gui/575–580`, `w07/581–584`). 생성된 `llama-server --version`과 metadata는 모두 전체 head `18dc7ef9d7424b387c672a7a94bc86ceab7fdede`를 보고한다. archive로 증명할 수 없는 Git build count는 0이다. source metadata 바이트는 이전과 같으며, launcher SHA256은 `4f11575214d6fd71416fbd921cf6f30da7056cdf833ea18ecce25e3bfc1c997b`, implementation DLL은 `0d4799e9e5f90f15108ba59f303aba7c07143c507c76f84468e331abaef71545`다. 다른 ROCm runtime의 기존 6개 파일 해시는 같고 소유 compiler·staging은 0이다. post-build version 보정은 하지 않았으며 이 검사는 실제 모델 추론의 대체 근거가 아니다. 최종 공통 변경 후 관련 재검증은 남는다.

### package12 실제 Strata 기준 결과와 후속 수정

package12/source `357038e1a6c9dbe39836c5ed1dc2b2e3654cc803`(제품 `55cd70b`)는 Windows 네 target 빌드 exit0/257,209ms다. 고정 GUI SHA256 `d2c15b5f254c96847ad7a9413f02af2a8d3b2d158cabc7526bd49ba94fe107e4`, CLI `8679766934ecfd0afe6c2cc0081de6dc297e869a30bea516046eba242fec4bfb`, NSIS `c34fcfd535631c09b16f2f384e79a070cb36d71b4c53e26d0f8127cccf539653`, MSI `9f652281c67ea53c298b34e3cc76e8a6e59825da06b8e01d15d6cbf063e7c95c`다. 네 archive의 해시를 재확인했으며 설치 파일은 실행하지 않았다. raw `package12-candidate.json`.

OS 자동 재부팅으로 이전 Strata CLI 실행이 중단됐다. 그 실행은 결과 파일이 없고 세션/프로세스가 사라졌으므로 **통과로 판정하지 않는다**. 재부팅 후 실제 환경은 Windows 11 Pro 25H2 `26200.9711`이며 이전 `26200.9550`과 구분한다. GPU driver `32.0.31036.15`와 WebView2 `155.0.4283.45`를 확인했다. 기존 작업 홈의 설정과 이력을 복구해 이어갔으며 시스템 업데이트 설정은 변경하지 않았다. raw `postboot-os-revision-webview.json`, `postboot-gpu-driver.json`, `orca-after-os-restart-run-use.json`.

고정 후 별도로 만든 실제 개인 빌드(upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`, 진단 flag 하나 추가)의 native executable SHA256은 `096f1664f7ef71e5722cf3cc550bc4093ef586b9eeae9777fb1e77704b76dae4`다. 새 flag가 고정 앱/추적 소스에 없음을 확인한 뒤 production CLI에서 등록·모델 probe·실제 산술 응답 `5`·usage(입력42/출력2)·stream 취소·재시작·제거/재등록·외부 파일/모델 보존·소유 프로세스/포트 정리 A01–A09를 통과했다. 두 불완전한 초기 descriptor는 검증에서 거부된 그대로 보존했고, 실제 helper에 위임하는 명시적 options probe 계약을 완성한 뒤 실행했다. 이 문단은 **실제 개인 엔진 CLI/descriptor 성공**의 근거다. 같은 고정 앱의 후속 help→GUI/profile→실제 추론 성공은 아래 개인 엔진 GUI 기준 결과에 따로 기록한다. raw `package12-private-cli-actual-probe/results.json`, `package12-private-cli-actual-probe/diagnostic-engine-log.log`.

실제 Strata는 원본 revision `296b59d2f73c8f04a805df29c2fa97655adace78`, native `0.1.44.1`, executable SHA256 `c4709f17ef974ffa34af4f0c357160a89249cabf6e9a698fbe6d0dc65a3243fa`를 사용했다. 원본 배포 설정 SHA256 `39432ce15f33e303b446c236d6254e87c05eeee3c8bfb549e8ba8003a65df1b8`와 원래 Qwen3.8 Flash Next Coder IQ1_M revision `5348543e0147355ac9cbcb031184a3546350988e`를 보존했다. 두 모델 shard 전체 SHA256은 각각 `e11083ba855e7666b48ea3f2db6a9c3a20c18751a012cc24f948de91b7087fad`, `316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113`이며 별도 전체 재계산 기록이 있다. 다른 모델이나 기본 파라미터로 대체하지 않았다.

| 실제 package12 Strata 항목 | 판정 | 근거 |
| --- | --- | --- |
| 제공 setup→명시적 bridge→실제 help→등록 | pass | production에 포함된 helper로 설치 확인·help 135개 옵션·metadata 13개와 미확정 정보 표시를 확인. 수락 fingerprint `d3830c15b78f2346b45ef70dd3ea49dcac5d6f0770260d61ad0f244287e59c85` |
| 공통 옵션 GUI→프로필 저장/재로드→실제 argv | pass | `--spec 4`를 원래 설정과 같은 값으로 명시해 저장하고 창 재진입 후 확인. 정수형 profile 값과 bridge/native의 정확한 argv를 각각 확인. 원본 배포 설정은 변경하지 않음 |
| 원래 모델 fresh probe→Ready→실제 응답/usage | pass | model-supported/chat/tools/text 확인 후 AMD R9700 HIP 실제 로드. `2 + 3`에 저장된 답 `5`, PP74/1,335ms·TG39/348.2ms. 합성 응답이 아님 |
| 생성 취소·같은 요청 Retry | pass | 취소 시 부분 reasoning 8,443자와 정확한 retry snapshot 보존. Retry에서 다시 첫 토큰/부분 내용 4,610자 생성 후 취소. 두 저장 snapshot의 요청/도구 계약 일치 |
| MCP 거부 | pass | 실제 모델이 요청한 호출을 GUI에서 거부한 뒤 stdio `tools/call`이 0회임을 확인 |
| MCP 승인·입력과 다른 반환값 후속 | pass | GUI와 native 승인 창에서 명시적으로 승인. 입력 `blue-2046`에 대한 합성 MCP 도구 반환은 `amber-7319`, **실제 Strata 후속 답변**도 정확히 `amber-7319` |
| MCP 호출 중 취소 | pass | 45초 도구의 실제 RPC 시작 약1초 후 GUI 취소. 도구 프로세스 종료·취소된 tool round/원래 도구 Retry 저장·45초 경과 후 늦은 응답 없음. 도구 반환 성공으로 확대하지 않음 |
| 재시작·같은 모델 새 응답 | pass | 원래 모델/프로필과 `--spec 4`를 유지한 새 소유 프로세스/포트에서 다시 실제 답 `5`와 usage 확인 |
| 정상 Unload/Quit 프로세스·포트 정리 | pass | 강제 종료 없이 GUI/bridge/native가 모두 종료되고 두 포트가 닫힘. Quit 직후 잠시 남은 native는 후속 OS 조회에서 종료를 확인 |
| 정상 Unload/Quit staging 정리 | fail | 두 번 모두 marker와 배포 설정은 사라졌으나 `engine.log` 하나만 남음. D62 수정·production 재검증 필요 |
| 최종 수정 source의 전체 공통 기능/production | unrun | D60/D61/D62를 포함한 새 고정 binary에서 관련 반복과 나머지 W/G 필요 |

실제 GUI 추론·취소·MCP·재시작·Quit 뒤 두 원본 모델 shard의 전체 SHA256을 다시 계산해 동일함을 확인했다(exit0/77,174ms). raw `strata-adapter-acceptance/package12-post-gui-model-sha256.json`. 개인 빌드의 실제 GUI help 255개와 새 진단 flag·독립적인 `--host`/`--no-host` 표시, model/port/host 명시적 선택까지 확인했다. 중간에는 GUI 포커스 문제로 alias/probe/auth 및 등록·실행이 남았으며 해당 checkpoint 자체를 pass로 판정하지 않았다. 이후 실제 재개·완료 결과는 아래 개인 엔진 GUI 기준 절에 구분한다. raw `package12-private-gui-help-bindings-checkpoint.json`.

raw `strata-adapter-acceptance/package12-gui-baseline-verdict.json`은 위 근거를 실제 파일/argv/저장 데이터/hash로 대조하며 **전체 `fail`**이다. MCP 도구 자체는 합성이지만 모델의 호출 생성과 후속 답변은 원래 실제 Strata다. 한 초기 요청에서 사용자가 친 짧은 도구 이름을 모델이 그대로 호출해 허가된 namespaced 이름과 맞지 않았으며 앱이 거부했다. 이 실패를 보존한다. 별도 자연어 요청은 실제 제공된 이름으로 승인·호출·후속을 통과했으며 허가 검증이나 모델 답변을 보정하지 않았다. 기존 profile 5개와 대화 파일은 보존됐다.

D59의 production12 같은 버전 두 runtime 구별·실제 선택·저장 profile 복원은 pass다. 최소 360×520 논리 창에서는 메뉴가 좁은 trigger 폭에 묶여 긴 이름이 약13줄로 접히고 다음 항목이 가려지는 D61을 재현했다. 원래 창 크기로 정확히 복구했다. `5897a50`은 공통 메뉴가 viewport 범위에서 이름에 맞춰 늘어나도록 수정한다. 실제 component/full CSS의 headless Chrome 360/640/1280 검사에서 baseline40 fail→수정 후0 fail, unit3 fail→27 pass, 전체199 files/2,118 tests·typecheck·lint exit0이다. lint에는 의존성 없는 layout effect에 대한 경고1개가 있으며 렌더된 위치가 달라질 때만 state를 갱신한다. native WebView2 수정 후 검사는 아직 `unrun`이다.

`c66d821`의 D60은 headless CLI가 Job 없이 raw child를 넘겨 venv의 자식 listener를 거부하던 문제를 수정한다. 실제 합성 launcher와 opt-in venv RED/GREEN, 지속 프로세스 hand-over와 반례, 전체 Rust 27 artifacts/1,154 pass/0 fail/16 ignored, Clippy(전체/no-default)·fmt exit0이다. ignored는 pass에 포함하지 않는다. 실제 Strata CLI 재검증은 새 production에서 수행한다. D62의 중단 복구·정상 종료 잔여 수정은 `8f7ef9b`로 커밋했고 Windows 자동 검사를 통과했다. 수정 후 실제 Strata production 검증과 D64/D65를 포함한 최종 수락은 남아 있으므로 현재 source를 종료 commit으로 지정하지 않는다.

### package12 실제 개인 엔진 GUI 기준 결과

고정된 package12 production GUI에서 앱 고정 이후 빌드한 개인 엔진을 실행 파일·entry point 입력으로 등록했다. 실제 도움말 255개 옵션에 새 `--personal-diagnostic-642ee924a09048ac93868732fdbe9a51`가 나타났고, 모델/포트/호스트/제공 모델 이름 연결, 환경 변수 인증과 별도 실제 probe를 명시했다. probe 스크립트 두 개를 해시 대상으로 추가하면 기존 도움말을 무효화하며, 재탐색 후 등록했다. 새 프로필 저장→창 닫기/다시 열기의 값 보존, fresh model probe→실제 Ready→Windows 프로세스 argv의 한글·공백 단일 인수, 실제 답변 `5`와 PP 34/TG 2 토큰을 확인했다. 인증 없는 모델 API는 HTTP 401을 반환하고, 정상 Unload 후 소유 PID/포트는 사라졌다. 이전 Strata의 marker 없는 잔여 두 디렉터리는 보존됐다. 형식 미확인 옵션은 미확인 텍스트로 표시하며 임의로 타입을 확정하지 않았다.

raw `package12-private-gui-verdict.json`, 등록/help snapshot, `package12-private-gui-launch-processes.json`, 실제 저장 thread와 native 화면이 근거다. 개인 엔진 revision `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 추론 동작을 바꾸지 않는 진단 옵션을 추가한 바이너리 SHA-256 `096f1664f7ef71e5722cf3cc550bc4093ef586b9eeae9777fb1e77704b76dae4`, Qwen2.5 0.5B revision `9217f5db79a29953eb74d5343926648285ec7e67`, 모델 SHA-256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`를 고정했다. 이 범위는 실제 개인 엔진의 GUI 기준 `pass`이며 최종 수정 source의 production 수락은 여전히 `unrun`이다.

### package12 실제 합성 대량 옵션 GUI 기준 결과

같은 고정 package12 GUI에서 생성 시점을 pin 이후로 고정한 합성 엔진을 별도 런타임으로 등록하고 실제 도움말 1,014개 옵션(탐색 197ms)을 수락했다. 이전 런타임의 사라진 옵션과 저장 순서를 경고와 함께 보존했고, 새 편집 초안에서 명시적으로 제거한 뒤 새 프로필에 저장했다. 새 text flag와 마지막 bulk flag 검색·입력·검토 저장·창 닫기/재열기, Windows native argv의 한글·공백·메타문자·따옴표 의미 보존, 실제 argparse 해석과 echo 답변을 대조했다. 실제 전달하지 않은 count는 엔진의 기본값 17이며, SSE의 마지막 공백을 포함한 원문 응답을 그대로 비교했다. 기존 프로필 9개는 값과 revision 모두 보존됐다. 정상 Quit 후 GUI·venv launcher·실제 listener와 포트가 모두 사라졌으며, 앞서 실패한 Strata 잔여 디렉터리는 보존했다.

raw `package12-synthetic-gui-verdict.json`, registration/help snapshot·실제 argv/trace·원문 thread가 근거다. fixture SHA-256 `59019e0f894cf4ca3d4610d3083464b2f8dc2415c264c60d50d480820bc701ee`, spec SHA-256 `ac7c02d12ca71ebe22da1e3154a502f1f2ea16af8476e058a96006e79756d2d9`, 모형 파일 SHA-256 `8d0a5749b7319141d107980bfe59f5d0d4cca2425d13781dff77f1800c45a356`다. 이 범위는 합성 GUI/argv `pass`이며 실제 추론·표준 INP·최종 수정 source 수락을 뜻하지 않는다. 등록 완료 안내가 이전 build 이름을 표시한 D65 실패는 별도로 유지한다.

## 기기와 격리

| 항목 | 실제 기록 |
| --- | --- |
| OS | Windows 11 Pro 25H2, x64, build 10.0.26200.9550 |
| CPU / RAM | AMD EPYC 4585PX, 16 core / 32 thread; 67,782,369,280 bytes |
| GPU | AMD Radeon AI PRO R9700 두 장, 각각 32 GiB |
| driver | 32.0.31036.15, 2026-08-12 |
| Vulkan | API 1.4.349, driver 2.0.395 |
| 설치된 HIP SDK | 7.2.60201; 전역 SDK/driver 설정을 변경하지 않음 |
| WebView2 | 155.0.4283.45 |
| Node / npm | 22.23.2 / 12.0.2 |
| Rust | rustc/cargo 1.98.0, rustfmt/clippy |
| Python | native CPython 3.12.10 x64, 작업 전용 venv |
| Build tools | VS Build Tools 2022 17.14, MSVC 14.44.35207, Windows SDK 10.0.26100, CMake 3.31.6-msvc6, Ninja 1.12.1 |

GUI/CLI 검사는 `AIOLM_HOME`뿐 아니라 HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG/WebView2 profile도 임시 디렉터리로 분리한다. 최초 harness의 OS profile 격리 누락으로 실제 legacy 설정이 임시 홈에 복사된 실행은 무효화했다. 원본 데이터의 이동·수정은 없었으며 해당 임시 복사본만 정리하고 격리된 새 실행으로 다시 검사했다. 실제 최초 OS 실행·설치·업그레이드·제거·Credential Manager 검사는 기존 설치를 보호할 별도 테스트 OS 세션이 필요하다.

사용자는 현재 별도 Windows 테스트 계정/VM 세션을 제공할 수 없다고 확인했다. 해당 실제 설치/OS 자격 증명 검사는 `blocked`로 유지하고 기존 계정에 설치하거나 사용자 자격 증명을 변경하지 않는다. 독립적인 G 구현과 나머지 검증은 계속 진행한다.

## W01–W08 checkpoint

| ID | 상태 | 실행 근거와 다음 필수 작업 |
| --- | --- | --- |
| W01 | pass | 기준 공통 20개 명령과 native CLI smoke를 실행했다. D01/D02 수정 후 재검사 통과. 최신 전체 source의 최종 공통 검사는 모든 구현이 끝난 뒤 다시 필요하다. raw `w01/results.tsv` 및 개별 로그 |
| W02 | blocked | 격리 CLI 12개 검사와 실제 GUI onboarding/폴더 선택 pass. v13 backup/round trip·미등록 engine 보존·미래 schema 거부를 확인. 실제 OS 최초 실행·기존 설치 이전/자격 증명은 별도 OS 세션 대기 |
| W03 | unrun | CLI 26개 등록/변조/삭제/재등록, GUI 네 번째 엔진 등록·argv·변조 거부·느린 probe 취소 후 새 등록과 이전 child 정리 pass. 모델 선택 probe 경합·최종 G source 재검증 필요 |
| W04 | unrun | CPU/Vulkan·고정 Strata GUI의 실제 응답/usage·취소/Retry·재시작/Quit pass. 별도 고정 SDK 조합의 ROCm 실제 두 GPU gate/응답 pass, 기존 SDK 실패 보존. 개인 build 및 최종 source의 전체 GUI 흐름 재검증 필요 |
| W05 | unrun | MCP 승인/거부/호출 취소/입력과 다른 반환값 후속·rich/error/call ID pass. 이미지 복합 질문의 내용 누락 fail 유지, 도형 후속·설정/이미지/이력 재로드 pass. 실제 다른 지원 미디어와 새 Retry 복구 재검증 필요 |
| W06 | unrun | 실제 vector RAG·STT 전처리/답변/이력·멀티 세션·gateway 인증/라우팅 pass 조건은 위 checkpoint 참조. 최종 source task 거부·프로젝트 적용/내보내기·기존 CSV/XLSX 등 보존 재검증 필요 |
| W07 | fail | package12 실제 Strata 정상 Unload/Quit 두 번에서 marker 없는 engine.log staging 잔여 재현(D62 `8f7ef9b` 자동 수정 검사는 pass, 실제 수정 후 production은 unrun).  Unicode/공백 argv, runtime 설치/import 취소·의도적 import 실패/복구, 실제 CPU source build 취소·compiler 실패/재빌드의 staging/소유 process 정리, load/stream/benchmark 취소·의도적 benchmark 실패 후 같은 모델 복구·다른 세션 보호 pass 조건은 위 근거 참조. D16 동일 PR production 재빌드와 D15 최소 창 production 오류 화면은 수정 후 pass. 최종 source의 관련 반복은 남음 |
| W08 | blocked | production 네 target 빌드, CPU/ROCm portable의 실제 import/추론, Korean IME composition·tray 복원 pass 조건은 위 checkpoint 참조. 설치/업그레이드/제거는 별도 OS 세션 대기. 실제 알림 표시·전체 접근성·최종 재검증은 남음 |

Windows native의 MLX·표준 vLLM·Metal 실제 추론은 현재 local runtime 플랫폼 계약상 `unsupported`다. 값 보존·명시적인 거부는 별도의 Windows 공통 검사이며 Linux vLLM과 Mac MLX/Metal의 실제 추론 성공으로 기록하지 않는다. WSL 실행은 이번 Windows native 성공 근거가 아니다.

## 실제 엔진과 합성 결과

### llama.cpp

개인 CPU build는 source `14310190cd0a0c831fe949ac8cbedd8abdc90695` / b11617 / MSVC로 Windows에서 새로 빌드했다. `llama-server.exe` SHA256은 `465276c17a02a113b62c9c6be51660f44506b63a0de40e98ef09eb1957188e7b`다.

- Qwen/Qwen2.5-0.5B-Instruct-GGUF revision `9217f5db79a29953eb74d5343926648285ec7e67`, Q4_K_M SHA256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`: 개인 엔진의 격리 CLI A01–A09 pass.
- Qwen/Qwen3-1.7B-GGUF revision `90862c4b9d2787eaed51d12237eafdfe7c5f6077`, Q8_0 SHA256 `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a`: 내장 CPU GUI의 `2+3` 답변 `5`와 usage, 긴 생성 취소·Retry 및 정상 종료/재시작 pass. 명시적으로 고른 Vulkan GPU0에서 한국어 `7×6` 답변 `42` pass. Unicode 입력 주입을 실제 IME composition 검사로 확대하지 않는다.
- 공식 ROCm b11617 archive에는 필요한 hipblas DLL이 없고 설치된 HIP7.2와 다른 DLL byte identity를 가진다. SDK 혼합을 거부하고 staging을 정리한 동작은 pass이며 해당 archive의 실제 추론은 blocked다.
- 같은 llama.cpp source와 HIP7.2/gfx1201로 만든 개인 native ROCm bundle은 D05 수정 후 clean export/import/probe pass. ZIP SHA256 `9feb7404e89ff6b53aa281408032dde7e17e67be421055a198e76799d0cabf8a`, 588,299,928 bytes, payload 2,759 files. 이후 실제 두 GPU numerical gate는 fail이었다. 위 후속 checkpoint의 별도 SDK 조합 성공과 구분한다. 짧은 격리 홈으로 vendor MAX_PATH 조건을 만족해야 한다.

### Strata

추가 수락 범위는 Strata를 공통 GUI로 쉽게 등록하고 설정·저장·실제 실행·응답·취소·복구하는 여정이다. 최종 소스에서 이 여정은 아직 `unrun`이다. 고정 엔진의 서버 `--help`(stdout 6,235 bytes), native `--help`(stderr 21,785 bytes), native `--version`을 분리된 홈에서 다시 실행해 모두 exit 0을 확인했다. 동일 모델 설정의 실제 helper probe도 exit 0이며 원본 설정 해시를 보존했다. 이는 로드한 GPU와 실제 답변을 검증한 결과가 아니다. 서버 옵션과 native 자식의 설정/argv는 서로 다른 계약이므로, native 도움말을 서버 argv에 적용해 통과시키지 않는다. raw `strata-adapter-acceptance/help-baseline/result.json`, `strata-adapter-acceptance/probe-baseline/result.json`.

`1f31a0a`는 bridge의 파생 설정을 앱 소유 UUID 작업 디렉터리에 두고 GUI 중지·실패와 독립 CLI start/stop에서 정리한다. `c3e9edf`는 engine ID 분기 없이 가져오는 설정 파일→공통 입력 GUI→동일 entry point draft와, 제품에 포함하는 helper·Strata native-help/HTTP bridge를 추가했다. actual arbitrary producer subprocess·취소/재시도·helper 변조 거부, library 1,097 tests·기존 ignored 6개 및 관련 integration, UI 전체 2,095 tests와 이후 경계/이전 단계 보존 회귀·typecheck/lint/Clippy/fmt는 pass다. 실제 Chrome 360/640/1280의 새 화면·넘침·WCAG 검사는 합성 IPC로 한정한다. 같은 고정 Strata에 대한 새 helper 출력·bridge help·별도 모델 probe도 pass(raw `strata-adapter-acceptance/native-bridge-boundary4/result.json`)이며 원본 source/config/native hash를 보존했다. 최종 고정 production 앱의 실제 모델 로드·응답·공통 기능 성공으로 확대하지 않는다. 후속 `f0c2966`의 실제 pinned help 전달·별도 probe는 `strata-adapter-acceptance/native-bridge-boundary5/result.json`에, 원래 stream과 공통 parser 비교는 `claude-strata-common-adapter/report.md`에 연결한다. 이 source의 Rust library 1,102개(기존 ignored 6개)·CLI 15개(기존 ignored 1개) 및 integration, 관련 UI 500개·typecheck·lint·Clippy·fmt·Python 12개가 pass다. 최종 production 재검증은 계속 남는다.

고정 source `296b59d2f73c8f04a805df29c2fa97655adace78`, tag v0.1.44.1의 Windows x64 HIP release를 사용했다. archive SHA256 `e40bce7a2cfe47ea42d3f2af1e0adb92d14b8c02a29107c5a309b2cb518f5f52`, native `strata.exe` SHA256 `c4709f17ef974ffa34af4f0c357160a89249cabf6e9a698fbe6d0dc65a3243fa`다. bundle HIP는 10.2.0a20260930이며 host HIP7.2와 혼합하지 않았다. 고정 문서·자체 `--check`로 실제 R9700/63 GiB 조건을 확인했다.

모델은 ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF revision `5348543e0147355ac9cbcb031184a3546350988e`의 IQ1_M이다. 두 shard를 독립적으로 다시 hash하여 고정 LFS와 대조했다.

| 파일 | SHA256 | bytes |
| --- | --- | --- |
| IQ1_M shard 1 | `e11083ba855e7666b48ea3f2db6a9c3a20c18751a012cc24f948de91b7087fad` | 29,608,446,496 |
| IQ1_M shard 2 | `316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113` | 28,800,138,432 |

MTP source는 Qwen/Qwen3.8-Flash-Next revision `de4b8e4d43b917e7706784d8bb445c9af86a3540`이며 생성된 MTP·pack·tokenizer의 파일별 SHA256는 raw에 보존한다. upstream 원본 구성 대신 별도 deployment JSON을 사용하고 saved API key·lazy loading·독립 MCP·before-load 명령을 사용하지 않는다. Windows MAX_PATH 때문에 작업 범위에 한정된 임시 drive alias로 실행했으며 시스템 설정을 바꾸지 않았다.

actual production GUI → venv launcher → native interpreter → strata.exe에서 GPU0 R9700의 모델 준비와 새 응답을 확인했다. `17×3` 요청은 `51`, PP81/1,318.1ms/61.5tok/s, TG52/482.4ms/107.8tok/s, TTFT1,346.1ms, finish `stop` 및 2개 저장 메시지였다. 긴 생성의 취소는 추론 텍스트 6,204자를 보존했다. Retry는 같은 4개 메시지에서 새로 생성했고 별도 취소 후 새 TTFT/추론 내용을 저장했다. trailing engine usage가 없는 취소 응답에 측정값을 만들어 넣지 않았다. normal Quit 이후 앱·두 Python·엔진 및 소유 listener가 모두 사라졌다. raw `strata-native/logs/17–21` 및 engine 로그가 근거다.

처음 GUI 요청이 막힌 이유는 기본 `cors_origins`의 빈 목록이었다. 별도 구성에 실제 production origin `http://tauri.localhost` 하나를 지정한 뒤 같은 모델 Retry가 성공했다. unrelated origin에 CORS allow가 없고 잘못된 API key는 401이었다. 연결 계약은 [Strata 안내](runtime-adapter-handoff.ko.md#원본-strata-및-개인-엔진)에 반영했다. 새 production binary 재시작에서 선택한 model/runtime/profile과 대화 이력이 보존됐고 auto-start가 없었다. 바뀐 helper는 artifact 변경으로 거부됐으며 명시적인 제거·재등록 뒤에도 선택값을 유지했다. 같은 모델의 native 재시작과 reasoning 생성 중 `Generating` 표시, 취소/부분 저장을 재검증했다.

### 합성 fixture

`custom.synthetic-w`는 opaque 모델 파일과 고정 응답을 갖는 Python bridge다. 실제 native GUI 등록·hash 변조 거부·프로필 저장·직접 argv·readiness/HTTP/SSE·Retry·이력 보존의 근거이며 모델 추론 능력의 근거가 아니다. Unicode/공백 경로와 shell 문자가 든 값을 하나의 argv 요소로 전달했다. 재등록한 synthetic-1.1-cors의 응답은 `synthetic fixture answer`, 저장 메시지는 2개, TG4였으며 PP는 제공되지 않았다.

### MCP 실제 공통 흐름

고정 Strata 모델과 작업 전용 synthetic stdio MCP 서버를 실제 production GUI에서 연결했다. discovery 이후 자식 프로세스가 종료됐고, 승인 전과 거부 뒤에는 `tools/call`이 없었다. GUI 검토와 native 일회 승인 후 `indigo-912` 입력의 실제 반환값 `synthetic result: amber-7319`를 모델이 그대로 후속 답변으로 사용했다. 요청·반환의 JSON-RPC ID가 일치했고 결과/usage/2개 메시지를 저장했으며 stdio 프로세스가 정리됐다. 모델 추론은 실제 엔진이며 도구의 업무 데이터는 합성이다.

별도 45초 slow 도구 호출을 실제로 시작한 뒤 GUI Stop을 눌렀다. launcher와 interpreter 두 MCP 프로세스가 사라졌고 늦은 응답/모델 후속 요청이 없었으며 Strata의 세 소유 프로세스는 유지됐다. 취소 뒤 UI는 `MCP response incomplete` 상태였다. D09 수정 후 package6의 같은 실제 흐름에서 `Retry last message`가 표시됐고, 정상 종료·재시작 뒤에도 취소된 tool-round와 준비된 입력이 동일하게 복원됐다. 100초 뒤에도 취소된 도구의 늦은 반환은 없었다. raw `gui/339–365`, `w07/348–362`.

그러나 재시작 후 같은 엔진이 Ready가 된 뒤 저장된 Retry를 실행하자 도구가 재호출되지 않고 첨부 문서의 코드를 답했다. 저장한 Retry에는 도구 선택이 없고 재시작 시 현재 도구 목록은 비어 있어 원래 요청과 다른 tool context로 실행됐다. **당시 D17 fail**은 그대로 보존한다. 원래 취소 상태와 실패 응답은 raw에 각각 보존했다. source 조사와 격리 hook 재현에서 `tools: []` 요청을 확인했다. raw `gui/366–368`, `w07/351,362,368–369`.

`12a8086`을 포함한 source `becf8ee`의 production GUI에서 새 대화로 D17을 재검증했다. 원래 45초 지연 fixture는 취소·재시작·도구 복구·새 승인·실제 재호출까지 확인했지만, Retry는 변경하지 않은 MCP RPC 15초 제한으로 실패했다(`gui/512`, `w07/513`). 이를 응답 성공으로 계산하거나 제한을 늘리지 않았다. 별도 이름의 8초 합성 도구를 GUI에서 새로 등록하여 같은 고정 Strata/runtime/model로 호출 중 취소→정상 종료→같은 바이너리 재시작→원래 도구 하나 복구→새 native 승인→실제 반환/후속 답변까지 pass했다(`gui/516–556`, `w07/535–558`). 입력 `violet-928`과 다른 반환값 `synthetic result: amber-7319`를 실제 모델이 그대로 답했고 PP82/TG42, cached473을 기록했다. 재시작 전후 취소 이력은 같은 해시이며, 완료 후 원래 사용자 입력·첨부는 유지되고 성공한 답변의 임시 Retry 데이터는 기존 계약대로 제거된다. 도구 데이터는 합성이며 추론은 실제 엔진이다. 최종 공통 변경 후 관련 재검증은 남는다.

독립적인 같은 세션 오류 복구는 pass다. 실제 모델이 요청한 lookup을 native 승인 창에서 거부하자 도구 호출은 없고 `Request failed`·Retry가 표시됐다. 같은 입력 Retry는 다시 승인을 요구했으며, 새 일회 승인 후 실제 JSON-RPC 호출/반환 ID가 일치했다. 입력 `cobalt-782`와 다른 반환 `synthetic result: amber-7319`을 모델이 후속 답변에 사용했다. 기존 user 메시지·첨부가 동일하고 PP82/TG75/cached473, TTFT375.2ms였으며 도구 프로세스는 정리됐다. 합성 도구 데이터와 실제 고정 Strata 모델의 추론을 구분한다. 이는 재시작 복구의 성공 근거가 아니다. raw `gui/375–390`, `w07/383,389–390`.

명시적으로 raw 도구 이름을 지시한 첫 lookup 요청에서는 모델이 제공된 function ID 대신 `synthetic_lookup`를 반환했다. 앱은 unapproved tool로 거부했고 호출은 없었다. 이 모델 응답 실패를 삭제하지 않고 별도 자연어 요청의 승인/후속 성공과 구분한다. 검사 중 처음 자동 선택된 lookup을 해제한 선택 오류도 raw에 기록했으며 제품 ID 매핑 결함으로 계산하지 않았다. raw `strata-native/logs/24–27`, `w05-mcp-native.jsonl`이 근거다.

fixture 2-rich의 실제 native 관리 GUI에서 단일 text와 embedded resource의 `uri`·`mimeType`·resource text, `isError: false`를 보존했다. 별도 실행 오류는 정확한 error text와 `isError: true`로 보존됐고 각 요청/반환의 call ID가 일치했다. 응답 뒤 MCP child는 0이었다. 이는 [협상한 MCP 2024-11-05의 tool result/error 계약](https://modelcontextprotocol.io/specification/2024-11-05/server/tools)을 검사한 결과이며 rich resource를 모델이 실제 이미지·음성으로 이해했다는 뜻이 아니다. raw `strata-native/logs/28–29`와 stdio transcript가 근거다.

## 재현 결함과 수정

| ID | 제품/검사 문제와 수정 | 검증 및 commit |
| --- | --- | --- |
| D01 | Windows drive anchored 이름을 portable capture 경계 밖으로 허용하던 경로 검사 수정 | Python 회귀 pass, `50b87ec` |
| D02 | synthetic ZIP timestamp 때문에 checksum 검사가 변하는 fixture | 수정 전 3/30 fail, 수정 후 0/30; `2191a4f` |
| D03 | harness의 OS profile 격리 누락 | 오염 실행 무효화·원본 보존·격리 새 홈 재검사; `f4bbaca` |
| F1 | 개인 llama.cpp manifest가 native shared libraries를 hash하지 않음 | DLL 사본 변조 거부·기존 등록 검사 pass; `0c7ba10` |
| D04 | venv launcher의 자손 listener를 소유 job으로 인정하지 못해 readiness 정체 | exact Windows job membership 검사·다른 job 보호 회귀·실제 GUI fixture/Strata 준비 pass; `71a2e49` |
| D05 | CRT prefix 비교가 DebugCRT/CLR 파일까지 portable runtime에 포함 | 정확한 retail DLL 선택·기존 오염 runtime 거부·114 module tests/2 live ignored·clippy·clean export/import/probe pass; `a42ab63` |
| D06 | Strata native version probe에 deployment library paths 누락 | host env를 보존한 child env, 6 helper tests 및 동일 native probe pass; `21f56ae` |
| D07 | reasoning/tool 토큰을 생성 중에도 composer가 첫 토큰 대기로 표시 | 실제 GUI 재현, 수정 전 2 regression fail, 수정 후 관련 29 tests/typecheck/lint pass; `eb3b2bf`. 새 production의 같은 Strata reasoning stream에서 Generating·취소/저장 pass |
| D08 | Strata의 DLL/tokenizer 보호 누락과 upstream test 개수에 따른 artifact 한도 | 7 helper tests, 실제 native CLI engine 사본의 수정 전 변조 허용 fail→수정 후 probe/start 거부 pass, 원본 보존; `4d57c11` |
| D09 | 저장된 중단/빈 응답과 tool round에서 Retry 경로 유실 | 정확한 재시도 입력의 backward-compatible 저장·기존 부분 응답 보존, 관련 자동 검사 pass; `d98029b`, `e96c700`. package6 실제 부분/첫 토큰 전 중단의 저장·재시작·Retry와 같은 세션 MCP 거부 오류 후 새 승인/후속 답변 pass. 이후 발견한 D17도 별도 수정·실제 재검증을 아래에 기록 |
| D10 | MCP `isError:true`를 완료/성공으로 표시 | full 반환을 보존하고 failed 상태로 표시. 36 관련 검사와 package4 native 승인→실제 error 반환→Failed 표시 pass; `a17c758` |
| D11 | CPU에서 기존 GPU 배치를 해제할 조작 부재 | GPU 미감지 시 명시적 Clear GPU assignment 제공, 자동 초기화 없음. 93 관련 검사 및 실제 BGE CPU 시작/벡터 연결 pass; `c437380` |
| D12 | help/argv만으로 실제 실행 task를 확정하여 BGE chat 500 전달 | help arity 구분과 Ready 이후 실제 API task 확인. backend 전체 검사·실제 세 모드 CLI 및 package6 GUI gateway의 embedding/잘못된 chat task 거부 pass; `140fef0`, `876231f`, `8b4c5ea` |
| D13 | 프로젝트 기본값 재적용이 사용자의 대화 지침·도구 선택을 덮어씀 | binding/version별 기본값 적용과 저장 marker, 관련 384 tests 및 history round trip pass. 실제 지침·이미지 순서의 응답/재로드/재시작 보존 pass; `1f97170` |
| D14 | 호환성 reason 원시 키와 긴 오류 때문에 runtime 행 설명 붕괴 | 4개 언어 설명/미확인 사유 안내·유연한 열 배분/줄바꿈, 관련 52 tests/typecheck/lint/i18n pass. package6 실제 큰/좁은 창 표시 재검증 pass; `0cfbbb5` |
| D15 | 긴 실제 오류의 중복 노출과 최소 창 Tasks 가로 넘침 | 원래 source `becf8ee` 최소 창 fail 보존. `b682eca`·`42008b4`·`700af30` 수정 후 source `79da287` production WebView2에서 같은 PR/head/CPU의 실제 compiler 오류·최소 창 가로 범위/세로 접근·요약/상세·원문 복사·Enter/Tab/PageDown·기존 runtime 해시·정리/정상 종료 pass(`gui/706–738`, `w07/739`). 최종 source의 관련 반복은 별도 |
| D16 | PR source archive의 engine version에 둘러싼 AioLM Git commit/build count가 유입 | source `0cfbbb5` 실제 CPU build fail(`w07/310–311`) 보존. `84ea139`·`d832fa0`의 Git ceiling·검토한 head의 compile-time 전달·다른 commit의 활성화 거부, runtime 124개 검사/Clippy pass. source `becf8ee` production GUI의 같은 PR/head/archive/CPU 실제 재빌드에서 생성 바이너리가 전체 engine head를 보고하여 pass(`w07/584`). 원본 실패 빌드·다른 ROCm runtime 6개 해시 보존, compiler·staging 0. 모델 추론 및 최종 공통 변경 후 반복은 별도 |
| D17 | 재시작 후 저장된 MCP Retry가 원래 도구 없이 요청되어 다른 문서 답변으로 완료 | source `0cfbbb5` 실제 고정 Strata 모델 fail(`gui/366–368`, `w07/369`) 보존. `12a8086`은 원래 도구 정의/identity 저장·fresh discovery·정확한 선택·새 승인·늦은 복원 보호를 구현한다. 채팅 357개 검사 pass. source `becf8ee` production GUI에서 8초 합성 MCP 도구와 같은 실제 Strata 모델로 취소·저장·정상 재시작·원래 도구 복구·새 승인·다른 반환값의 정확한 후속 답변/usage pass(`w07/558`). 원래 45초 fixture의 15초 RPC timeout은 별도 실패/정리 근거로 보존. 최종 공통 변경 후 관련 재검증 남음 |
| D18 | 외부 엔진 프로젝트 적용 중 dormant llama.cpp backend 변경이 명시적 GPU 선택을 덮어씀 | source `0cfbbb5`에서 unloaded Strata 프로젝트 적용 후 GPU `[]`가 Vulkan 두 장으로 바뀌어 fail(`w07/401–403`). `8281018`은 이전/새 설정이 모두 llama.cpp인 경우에만 legacy GPU 재배치를 수행한다. 관련 Rust/Clippy pass. source `becf8ee` production GUI에서 같은 dormant ROCm→Vulkan 전환을 재검증하여 Strata/runtime/model과 GPU `[]` 보존 pass(`w07/451,458`, `gui/455–457`). 사전 조건은 GUI 정상 종료 후 공개 CLI로 backend 하나만 변경하고 전체 설정 diff로 확인했다. 최종 공통 변경 후 관련 재검증은 남음 |
| D19 | 같은 이름의 JSON import가 기존 프로젝트를 삭제하고 활성 project/history binding을 고아 상태로 남김 | source `0cfbbb5` native import fail(`gui/412–414`, `w07/415`). `67ef1bc`은 독립 UUID/복사 이름, rename 충돌 거부와 capacity 보호를 구현한다. 프로젝트 UI 49개/direct/lint pass. source `becf8ee` 실제 native export→같은 이름 import→복사 export에서 두 프로젝트·독립 ID·활성 원본 보존 pass(`gui/432–444`, `w07/449`). 이는 충돌/identity 범위의 판정이다. 별도 profile 문제는 D20으로 조사·수정했으며, 실제 복사 Apply는 Strata/runtime/model을 보존했다(`w07/445,448`). 전체 project/profile 왕복 계약이나 새 빈 대화의 영속 binding 성공으로 확대하지 않는다 |
| D20 | 프로젝트 read/save/import에서 linked profile의 engine이 누락되고 소유 설정이 전체 config로 확대 | source `becf8ee` 실제 export/import/export에서 provider 누락·설정 확대를 관찰(`w07/445`). 실제 Apply의 engine 유지와 구분했다. 격리 재현에서 custom/Python profile link가 기본 profile로 fallback하는 원인을 확인하고 `bbf4106`·`8801c27`로 provider/소유 설정을 보존했다. 관련 project test와 전체 2,059 UI/direct 검사 pass. 수정 후 production의 원래 왕복 재검증은 남음 |
| D21 | fresh model probe 전의 명령 미리보기 오류가 올바른 프로필의 저장·시작도 막음 | source `79da287`의 실제 새 합성 엔진에서 두 저장 동작이 비활성화됨(`gui/699–702`, `g8-d21-preview-gate-verdict.json` fail). `d025c94`는 previewError와 옵션 검증 오류를 분리하고 preview 성공도 실제 검증 오류를 해제하지 않게 했다. 실패를 먼저 재현한 두 회귀와 전체 UI 2,064 tests/typecheck/lint pass. package9에서 같은 fresh probe 미리보기 오류 중에도 Save/Save & start 활성→명시적 저장 검토→새 프로필 저장→모델별 probe→실제 argv와 합성 응답/이력까지 pass(`gui/839–854`, `g9-d21-saved-profile-verdict.json`, `g9-synthetic-first-response-verdict.json`). 기존 3개 프로필은 정확히 보존됐다. backend hash/readiness를 유지했으며 최종 source 관련 재검증은 계속 필요함 |
| D22 | 특정 내장 엔진 선택 중심의 첫 화면과 처리 중 페이지 복귀 시 이전 엔진 화면에 머무름 | `3d1c2b8`에서 모든 descriptor를 같은 중립 목록으로 열고 Add→실행 파일→help를 첫 동선으로 배치했다. busy 복귀를 잃는 회귀를 먼저 실패시킨 뒤 수정했다. 전체 UI 2,072 tests/typecheck/lint pass. 실제 Chrome 360/640/1280px의 목록·추가·help·키보드/포커스와 WCAG2A/AA/2.1AA 자동 검사 pass는 native IPC를 대체한 화면 검사로 한정한다. 별도로 package10 실제 WebView2의 중립 동선·개인 help·입력 보존·최소 창을 확인했다. 실제 OS 접근성 전체 통과로 확대하지 않음 |
| D23 | 사용자 등록 엔진 화면에 Python 번들 가져오기 동작 표시 | package10 실제 등록 엔진 화면에서 재현(`gui/864`). 호환되지 않는 번들 가져오기 경로로 사용자를 보낸다. 기존 조건이 Python 입력/설치/내보내기에만 적용되고 가져오기는 무조건 표시되는 것이 원인이다. `bc5475b`에서 같은 adapter 종류 조건을 적용했다. 회귀 실패 후 관련 65 tests/typecheck/lint pass. Python 어댑터의 가져오기는 유지하며 수정 후 production 검사는 unrun |
| D24 | 임의 이름의 모델/포트 템플릿 플래그를 일반 manifest 옵션으로 재사용 | `--weights {model}`·`--listen {port}`와 equals 형식이 일반 옵션으로 검증을 통과하는 회귀를 실제 실행해 재현했다. `c3c6d09`는 실제 템플릿 플래그를 거부하고 도움말 별칭의 소유권을 compat shadow 처리 전에 반영한다. 이전 잘못된 옵션 계약은 디스크에서 지우지 않고 복구 가능한 비활성 inventory 항목으로 표시하며 실제 probe/launch 읽기는 엄격하게 검증한다. 저장값을 유지하는 거부·복구 검사, provider 245 tests·세 integration 여정·Clippy/fmt pass. 최종 production 검사는 unrun |
| D25 | Windows 경로를 POSIX 문법으로 가져와 백슬래시 소실 | 실제 회귀에서 `C:\tpl\x.jinja`가 `C:tplx.jinja`로 바뀌었다. `324f220`은 GUI에 명시적 Windows/POSIX 선택을 추가하고 API의 생략된 syntax는 기존 POSIX 해석을 보존한다. 문법/런타임 변경 뒤 늦은 결과를 적용하지 않는다. [Microsoft C 인자 규칙](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments?view=msvc-170)을 따르는 8개 입력을 실제 MSVC `wmain`/CreateProcessW argv와 대조해 pass했고 같은 합성 corpus를 Rust 검사에 연결했다. corpus SHA256 `7c3c7f7ef43f77938d3304dbae8ddad90a6a5e170f01ec29dcd5668604fd4f94`, raw `windows-import-native/native-verdict.json`. 전체 자동 검사 pass와 AioLM production GUI 수락은 구분하며 후자는 unrun |
| D26 | 정적 옵션 가져오기의 네이티브 응답에 없는 `issues` 필드를 GUI에서 참조 | 기존 Rust 응답의 `managed`/`unrecognized`를 넣은 두 API 회귀가 실패했다. `38cc039`는 기존 wire 응답을 유지하면서 공개 클라이언트의 `issues` 계약으로 정리한다. 인식된 옵션 적용과 관리/미해석 인자 검토를 검사하고 관련 44 tests·typecheck·lint pass. 실제 production의 정적 가져오기 경로는 unrun |
| D27 | native 모델 출처/다운로드·preset 옵션이 선택 모델/앱 포트와 충돌 | 수락된 도움말의 `-hf`가 공통 resolver에서 argv로 생성되는 것을 재현했다. upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695` 소스에서 확인한 13개 주/초안 모델 출처 별칭과 11개 모델·포트 preset을 `bd5179b`의 native 어댑터 metadata에 추가했다. 공통 schema와 실제 native argv 경로에서 거부하며, 기존 설정을 읽을 때 인자를 조용히 제거하지 않도록 legacy migration 목록과 분리했다. v7/현재 schema의 인자·선택 모델 보존, 공통 help→schema→거부 및 raw argv 우회 거부 검사 pass. 전체 UI 2,079 tests, Rust library 1,080 tests·세 integration 여정·typecheck/lint/Clippy/fmt pass. 실제 모델 교체/다운로드는 실행하지 않았으며 최종 production 재검증은 unrun |
| D28 | 명시적으로 선택한 positional 모델 앞의 고정 boolean을 모델 flag로 재해석 | `prefix: ["--server"]`와 positional 모델에서 실제 `launch_prefix`가 빈 배열이 되는 회귀를 재현했다. `b102a98`은 새 등록에 선택적 `launch_bindings` version1을 저장한다. `prefix_len`과 순서 있는 바인딩을 실제 argv와 대조하고 재로드 시 선택을 유지한다. metadata 변경도 probe identity에 반영하며 없는 기존 v1 manifest는 이전 직렬화/해석을 보존한다. 템플릿 불일치·새 version·범위·중복 이름/flag 거부, Rust library 1,082 tests·네 integration 여정·관련 UI 174 tests·typecheck/lint/Clippy/fmt pass. 최종 production GUI 검사는 unrun |
| D29 | bridge 도움말에 원래 엔진의 prefix를 사용하고 엔진 인자를 전달하지 않음 | GUI 회귀 검사에서 `bridge.py --help` 대신 `--help`를 요청하는 실패를 재현했다. `8e943be`는 실제 bridge prefix를 사용하고 엔진 executable/prefix를 명시적 JSON argv 환경 계약으로 help·probe·launch에 전달한다. bridge가 이 계약과 옵션 전달을 구현해야 하며, 원래 엔진 artifact의 도움말은 검사 전용으로 유지하고 bridge 실행 schema의 근거로 수락하지 않는다. 실제 합성 bridge와 별도 자식 엔진 프로세스에서 Unicode·공백·빈 값·모델·미지 옵션 argv 전달을 확인했다. 합성 argv/protocol 검사이며 실제 추론 성공이 아니다. 전체 UI 2,080 tests, Rust library 1,083 tests·다섯 integration 여정·typecheck/lint/Clippy/fmt pass. 최종 production GUI·실제 엔진 bridge 재검증은 unrun |
| D30 | 정상 catalog/전용 설정의 잘못된 보존 경고와 재등록 diff 누락 | 정상 `temperature`·전용 설정·순서 기록까지 raw help와 비교하는 회귀, 이전 snapshot 없이 보존 값을 누락하는 회귀, 재등록 화면의 diff 미표시를 각각 실행 재현했다. `f8fe23f`는 설치된 runtime의 유효 catalog와 전용 키를 반영하고, 새 entry point에는 새 계약을 적용하며 현재 저장 값은 그대로 보존한다. 수락하지 않은 새 탐색을 반복해도 마지막 수락 snapshot과 비교한다. 현재 설정을 전달하는 IPC 인자는 선택적이며 이전 payload를 보존한다. 전체 UI 2,082 tests, Rust library 1,085 tests·관련 네 integration 여정·typecheck/lint/Clippy/fmt pass. 실제 Chrome 360/640/1280의 bridge·diff 상호작용/가로 넘침/WCAG 자동 검사는 pass지만 합성 IPC의 렌더링 검사다. 최종 production Windows GUI 재검증은 unrun |
| D31 | 독립적인 `--no-host` boolean과 `--host HOST` 값 옵션의 키 충돌 | 고정 package10/source `3d1c2b8` 이후 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 진단 flag 하나만 추가한 새 실제 개인 빌드에서 재현했다. 새 실행 파일 SHA-256은 `2e70eb1023e5f60f4483a42601fde088fa3671207083018319513f405e65c122`이며 새 flag가 고정 앱 binary/소스에 없고 원본 엔진·추론 파라미터가 보존됨을 확인했다. 실제 GUI 도움말은 253개 옵션을 읽었지만 `--no-host`의 키를 `host`로 만들며 뒤의 주소 옵션을 제거해 Host binding에서 `--host`를 고를 수 없었다. 원본 도움말·저장 schema·native 선택 상태의 **fail**을 보존한다. `3ba9a22`는 독립 switch를 `no_host`로 구분하고 실제 boolean 쌍·기존 단독 negative 의미를 보존한다. 동일 실제 help의 재파싱은 수정 전 fail→수정 후 두 옵션/255개 pass이며 parser version 2로 이전 cache를 무효화하고 기존 저장값은 이동·삭제하지 않는다. 관련 help 63 tests·기존 ignored 1개, 전체 Rust/Clippy/fmt pass. 최종 production GUI의 binding·등록→저장→argv→추론 재검증은 unrun |
| D32 | 대형 옵션 정보 또는 완성된 등록 레코드가 reader 한도를 넘어 재로드 불가 | 실제 등록 경로의 300 KiB default/choice/constraint와 입력 파일은 한도 안이지만 저장 레코드는 초과하는 합성 사례를 fail로 재현했다. `1f1ac4a`는 명시 정보/값 크기와 전체 저장 레코드를 제한하고 알려진 초과를 probe 전에, 최종 레코드도 publication 전에 거부한다. 기존 help 파일 보존·probe marker 없음·일반 등록/재로드 성공을 같은 integration에서 확인했다. 전체 Rust·관련 metadata 검사는 pass이며 최초 수정 중 실패도 raw에 보존했다. 실제 Windows GUI의 오류 안내·복구 재검증은 unrun |
| D33 | 관측된 선택지와 충돌하는 저장값·적용되지 않은 어댑터 제약을 허용 | 합성 등록 엔진의 선언 `fast/exact`와 실제 help `fast/safe`에서 `exact`의 실행 검증이 빠지는 것을 재현했다. `1c902c1`은 관측된 형식·선택지·범위에 어긋나는 저장값과 적용되지 않은 제약의 대상 값을 거부하고, 양쪽에서 유효한 `fast`의 실제 argv·기존 alias key·저장값을 보존한다. 결합할 수 없는 명시 정보의 민감 값 표시도 유지한다. 관련 integration·전체 Rust·UI 검사는 pass. 실제 production 변경 검토·복구는 unrun |
| D34 | 선택한 optional binding의 flag가 비어 있으면 조용히 생략 | Host를 도움말 옵션 방식으로 선택하고 flag를 고르지 않은 component 실행에서 manifest review가 진행되는 것을 재현했다. `13e63d6`은 선택을 완료하거나 `Not used`로 바꾸도록 안내하고 review/register를 막으며 입력을 보존한다. 명시적 미사용은 허용한다. 관련 UI·typecheck·lint 및 최종 전체 UI 2,087 tests pass. 실제 production 재검증은 unrun |
| D35 | 명시적으로 민감한 새 옵션 값이 backend preview·CLI 설정에 표시 | 이름에 비밀 의미가 없는 `--fresh-amber`와 합성 값으로 실제 CLI binary·preview 노출을 재현했다. `3f54306`은 선택한 엔진의 schema로 preview·CLI의 중첩 profile·측정 기록을 가리며 저장·실제 argv는 보존한다. `8428123`은 비활성 엔진·runtime·profile 및 기본값/차이/오류 표시도 처리하고, `77627cd`는 첫 128개 directory 뒤의 schema가 누락되는 회귀를 수정했다. 오래된 parser/수락 정보의 표시 전용 복구는 실행의 hash/readiness 검증을 우회하지 않는다. 관련 integration과 전체 검사는 pass이며 최종 production 재검증은 unrun |
| D36 | 새 Strata bridge가 성공 코드와 함께 native 도움말을 전달하지 못함 | 실제 고정 Windows native `--help`의 inherited stdout/stderr가 비어 있음을 재현했다. `c3e9edf`는 별도 pipe를 명시하고 두 stream을 제한 없는 중간 buffer 없이 상위 소유 캡처로 전달한다. 실제 subprocess regression은 수정 전 fail·수정 후 pass. 같은 원본 엔진으로 native stderr 21,785바이트와 bridge stdout 244바이트를 재확인했다. production GUI 재검증은 unrun |
| D37 | bridge 인자와 native 옵션 값의 명령 영역 구분 필요 | 합성 설치 server를 실제 실행해 `--`가 native config에 남는 실패와 flag처럼 생긴 값을 잘못 거부하는 동작을 재현했다. `c3e9edf`는 선택적인 `options_separator: "--"` 계약을 common draft/manifest/GUI에 보존하고 bridge에서 두 영역을 분리한다. native 값의 `--aiolm-port`는 HTTP port를 바꾸지 않으며 실제 bridge/child argv·독립 CLI start/stop·관련 Rust/UI 검사는 pass. 최종 실제 엔진 여정은 unrun |
| D38 | 어댑터 설정 후 이전 단계로 돌아가면 설치 입력이 사라짐 | 신규 component 여정에서 recipe·설치 폴더 입력의 유실을 재현했다. `c3e9edf`는 wizard 안에서 설정 상태를 유지하며 fresh help 검토를 별도로 요구한다. 실제 component regression의 수정 전 fail·수정 후 pass. 첫 검사에서 잘못 사용한 `Back` selector 실패는 제품 근거에서 제외했다. native production 왕복 검사는 unrun |
| D39 | GUI와 CLI의 시작 폴더가 다르면 수락한 옵션이 stale 처리됨 | 실제 독립 app/engine subprocess로 재현했다. `0fbbff9`는 수락한 canonical 실행 디렉터리를 저장해 help·launch·fallback probe에서 사용한다. 서로 다른 시작 폴더의 동일 identity/실제 argv/cwd, 변경 시 새 probe 요구, 폴더 삭제 후 명시적 복구, 기존 생략 wire·저장값 보존 검사 pass. 최종 production GUI/CLI 재검증은 unrun |
| D40 | 첫 등록 probe가 명시적 launch 디렉터리를 상속하지 않음 | 같은 runtime ID를 제거/재등록하는 실제 probe subprocess에서 declared cwd 불일치를 재현했다. `0fbbff9`는 probe 명시 경로 → launch 명시 경로 → 현재 등록의 검토된 경로 순서를 적용한다. 선언 변경의 help stale·재검토·새 probe·실제 cwd와 원래 옵션 보존 pass. 최종 실제 엔진 재검증은 unrun |
| D41 | 늦은 폴더 선택 결과가 이후 직접 입력한 실행 경로를 덮어씀 | component 검사에서 수정 전 fail을 확인했다. `0fbbff9`는 이후 수동 입력으로 이전 선택 응답을 무효화한다. 관련 29개 GUI 검사 pass. native production 재검증은 unrun |
| D42 | 작은 창 넘침 재현의 검사 설정 오류 정정 | 최초 Chrome fixture에 `styles/index.css`가 빠져 기본 box sizing·font가 적용되지 않았다. 해당 33px 넘침은 제품 결함 근거에서 제외한다. 실제 앱과 같은 index/app CSS 및 결과 파일의 HMR 재로드 방지를 적용한 수정 전·현재 레이아웃 비교는 모두 360/640/1280px 카드 경계·키보드·axe 검사 pass. 현재 360px screenshot을 확인했다. 이전 raw는 보존하며 native production 검증은 unrun |
| D43 | help 요청이 실제 entry에 없는 subcommand scope를 주장할 수 있음 | 실제 등록 경로에서 위조 scope 수락을 재현했다. `414c068`은 선택적 `command_layout`과 GUI의 명시 token 역할로 실제 prefix·옵션 값·중첩 subcommand를 구분한다. 불일치·겹침·미지원 버전 거부, flag처럼 생긴 값의 잘못된 예약 방지 및 기존 생략 계약의 관련 검사 pass. 최종 native production 검증은 unrun |
| D44 | 전역 옵션 뒤의 중첩 subcommand import·배치 실패 | `--root serve serve --worker api api`와 반복 tuple의 import 실패를 재현했다. `414c068`은 옵션이 소비한 값 밖의 scope 경계와 공통 resolver의 구조적 경계로 순서를 유지한다. 실제 합성 help→import→저장/재로드→모델별 probe→subprocess parser에서 전역·중간·최종 옵션과 tuple 순서 pass. 실제 Python 실행·전체 interpreter 명령 import·native 추론은 이 검사의 범위가 아님 |
| D45 | 공통 GUI/import 저장 형식의 manifest launch 옵션을 legacy scalar 검사가 거부 | 실제 저장 후 실행에서 global_name/worker_mode의 occurrence/spelling 객체 거부를 재현했다. `414c068`은 strict override를 공통 schema로 검사하고 기존 text max_len과 JSON 64KiB·scalar/request 계약을 보존한다. 실제 parser 여정·129바이트 길이 거부·기존 help/소유 인자 회귀 pass. 최종 production GUI 검증은 unrun |
| D46 | 명시적 옵션 scope 변경이 help cache를 무효화하지 않음 | 동일 entry/argv에서 scope만 바꾼 실제 identity 비교가 실패했다. `414c068`은 명시 scope 데이터의 digest를 help와 model probe identity에 포함하며 생략된 기존 데이터의 identity는 유지한다. 수정 전 fail·수정 후 실제 parser/기존 help/소유 인자 3개 여정 pass. production에서의 버전 변경·복구 전체 재검증은 unrun |
| D47 | 고정 boolean 옵션 뒤의 subcommand를 옵션 값으로 소비 | `--server serve api --local 7`의 import 실패를 재현했다. `f17ab6a`는 managed 옵션의 확인된 정확한 arity만큼만 소비하고, dash로 시작하는 실제 값도 그 경계로 구분한다. 개수가 미확정/선택적이거나 값이 누락된 명령은 값을 유지한 채 검토를 요구한다. import/순서 16개 검사와 실제 command/order/help 3개 여정·Clippy pass. 전체 interpreter prefix import와 최종 production 검증은 unrun |
| D48 | 붙여넣은 명령의 검토 경고에 민감 값 노출 | `9062ed7`은 확인된 schema의 민감 값만 두 import UI의 경고에서 가린다. 기존 값·새 plan·managed/미해석 토큰의 별칭·equals·tuple 값을 함께 처리하고, 값 개수가 미확정이면 남은 검토 텍스트를 보수적으로 가린다. 원문 입력·plan·실제 저장 값은 유지한다. 두 UI 노출 및 이전 값 누락을 수정 전 재현했고 관련 64개 검사·typecheck·lint pass. 실제 전체 CSS/Chrome의 360·640·1280 폭에서 두 UI의 마스킹·입력 보존·WCAG 검사 pass. 합성 IPC 기반 컴포넌트 검사이며 최종 native production 재검증은 unrun |
| D49 | 명령 가져오기 직후 설정 갱신으로 검토 경고 소실 | `3235e97`은 무시된 managed/미해석 옵션의 검토 상태를 일반 검증 오류와 분리한다. 수정 전 실제 ProviderOptions/full CSS/Chrome의 controlled cfg와 검증 완료 대기에서 경고 소실을 재현했다. 수정 후 동일 렌더 및 두 import UI×360·640·1280 폭의 마스킹·입력 보존·WCAG 검사 pass. controlled-state 회귀는 적용된 값·재검증·저장 가능 여부·runtime 전환 시 경고 제거까지 확인했다. 관련 UI 500개·typecheck·lint pass. 합성 IPC/컴포넌트 범위이며 최종 native production 검증은 unrun |
| D50 | Strata bridge 안내가 stderr의 native 옵션 도움말을 가림 | `f0c2966`은 native 두 stream을 binding 행 뒤 하나의 stdout 문서로 전달한다. 실제 고정 도움말을 공통 parser로 대조하면 분리 stream의 3개 옵션이 한 문서에서 135개로 증가한다. 실제 수정 helper도 stdout 22,029 bytes/stderr 0·별도 모델 probe exit0이며 원본 source/config/native hash를 보존했다. 합성 실제 subprocess의 discovery→effective schema→저장/거부→engine argv 여정 pass. 실제 모델 로드·최종 production GUI 수락은 unrun |
| D51 | native GPU 옵션이 등록된 deployment의 표시 장치 계약을 덮어씀 | 고정 generate.cpp는 `--gpu`로 HIP/CUDA_VISIBLE_DEVICES를 덮어쓴다. `f0c2966`은 해당 어댑터 metadata에서만 이를 예약하고 다른 deployment 선택으로 변경하도록 안내한다. 예약 누락 회귀 수정 후 Python 및 공통 실제 subprocess의 사유 표시·저장값 보존·실행 거부 검사 pass. 다른 엔진의 같은 이름을 전역 차단하지 않으며 최종 실제 Strata production 검증은 unrun |
| D52 | 직접 HTTP Strata 어댑터의 tokenizer fallback을 CLI로 교체 가능 | 고정 서버는 deployment에 tokenizer key가 없으면 `--tokenizer`를 사용한다. SDK가 해당 기본 tokenizer를 검증한 뒤 다른 CLI 경로가 이를 교체할 수 있어 `f0c2966`에서 명시적으로 예약했다. 해당 key가 있는 원래 검증 deployment의 실패로 확대하지 않는다. 예약 누락 회귀→Python 12개 pass, 기존 소유 인자·모델 probe 계약 유지. 최종 production 재검증은 unrun |
| D53 | Strata KV residency의 단위를 token으로 잘못 선언 | 고정 source의 generate.cpp·QSA 구현은 resident cells per QSA layer를 사용한다. `ab1db3a`에서 해당 metadata만 수정했으며 실제 값·범위·default·모델을 바꾸지 않았다. Python 수정 전 fail·수정 후 12개 pass. 원본 revision·native/config hash를 보존한 실제 helper help/probe도 pass이며 실제 모델 추론·최종 production은 unrun |
| D54 | positional 도움말의 설명을 값 개수로 읽고 argparse 소문자 항목을 누락 | 실제 Python argparse 여정에서 발견했다. `3e76298`은 열 간격에서 spec을 끝내고 positional section과 같은 들여쓰기의 행을 읽는다. parser version 3으로 기존 수락을 stale 처리하며 저장 값은 보존한다. 관련 RED→GREEN 및 실제 Python의 중첩·일반 script 도움말/argv/parser 여정 pass. argparse가 표시하지 않는 nargs는 확정하지 않으며 최종 GUI는 unrun |
| D55 | 새 도움말 수락 뒤 이전 미저장 positional 역할이 남음 | 실제 PositionalLayout/full CSS/Chrome의 controlled props에서 재현했다. `01c77c2`은 engine/runtime/accepted fingerprint/저장 역할로 draft를 구분한다. 회귀 RED→GREEN, 360·640·1280px의 역할 저장·긴 Unicode 경로·WCAG·새 help reset 렌더 pass. 실제 backend IPC·production GUI 전체 수락은 unrun |
| D56 | 민감한 고정 위치 인수가 역할 선택 목록에 표시 | 확인된 sensitive marker를 Static 역할로 지정하면 기본 선택과 다른 항목의 공통 목록에 값이 그대로 노출됐다. `de35776`은 현재 저장/미저장 역할의 해당 token을 가리며 원래 prefix·역할·저장 값은 유지한다. 관련 UI·typecheck·lint 및 실제 컴포넌트 기본 렌더 재검증 pass. `b47f920`은 새 help 수락 뒤 stale supplement의 알려진 값도 표시에서 보호하며 역할은 실행에 재적용하지 않는다. 후속 회귀 RED→GREEN, 관련 UI 493개·typecheck·lint와 실제 stale/current 렌더 및 3개 폭의 기존 역할 저장/WCAG 검사 pass. 최종 native production 재검증은 unrun |
| D57 | Windows의 긴 저장 경로에서 등록·도움말 영속 저장 실패 | 고정된 같은 실제 F8 integration exe와 Python으로 짧은 TEMP 대조군은 pass, 중간 길이에서는 discover_persist_describe가 os error 3, 긴 Unicode·공백 경로에서는 registry 등록이 같은 오류로 fail이다. 합성 엔진·모델을 사용한 실제 제품 경로의 실행이며 추론/GUI 검사는 아니다. 사용자 설정이나 OS long-path 정책을 변경하지 않았다. `21931a4`은 std::fs와 직접 MoveFileExW의 경로 표현 차이를 해결한다. 빌드 로그가 지정한 정확한 현재 검사 exe로 원래 짧은·중간·긴 조건을 다시 실행해 모두 pass다. guard 제거 대조군의 이전 exe를 고정했던 두 harness 실행은 현재 source 결과에서 제외하고 원본 raw로 보존한다. 최종 production GUI/CLI 긴 경로 재검증은 unrun |
| D58 | Windows code page 도움말을 선택할 수 없고 locale이 C로 고정 | `a7581a2`은 엔진 등록과 runtime 재탐색의 공통 인코딩·locale 선택, 생략 wire/default 보존, fingerprint·fresh model probe 연결을 구현한다. 실제 합성 child의 CP949 stdout/stderr, Auto 손실·손상 byte 거부/복구 안내, 실제 프로필 저장/재로드·소유 argv 검사 pass. CP949 확장 문자·CP932·Windows1252·원래 byte/BOM·기존 report 검사 pass. UI의 현재 선택 재로드/기본값 복귀/편집 후 재수락, 실제 360·640·1280px full CSS 렌더·WCAG·console/overflow 검사 pass. 최종 실제 엔진/production은 unrun |
| D59 | 같은 버전·accelerator의 다른 runtime이 선택 목록에서 같은 이름으로 표시 | package11 고정 production WebView2에서 별도 runtime 두 개의 표시가 같고 선택 뒤 프로필 ID만 달라지는 문제를 재현했다. `55cd70b`는 버전과 runtime ID가 다르면 ID를 공통 표시 이름에 포함한다. engine별 분기·저장 ID·실행 값은 바꾸지 않는다. 구별/실제 선택 두 회귀 RED→GREEN, 전체 199 files/2,115 tests·typecheck·lint pass. 기존 native/Metal plugin·project·session 표시 검사도 보존했다. 수정 후 production 및 작은 창 재검증은 unrun. raw `gui/1792093195560-package11-runtime-choices.json` 및 d59 실행 로그 |
| D60 | Windows headless CLI가 venv/bridge 자식 listener를 소유한 프로세스로 인정하지 않음 | 합성 launcher와 실제 opt-in venv에서 listener가 응답해도 start가 반환하지 않는 RED. `c66d821`에서 소유 Job으로 readiness와 지속 hand-over를 보존; 관련/전체 Rust 1,154 pass·16 ignored/Clippy/fmt pass. 실제 Strata production CLI 재검증은 unrun |
| D61 | 최소 창의 좁은 trigger 때문에 긴 runtime 옵션과 다음 항목이 가려짐 | package12 native 재현, `5897a50` 공통 메뉴 폭/위치 수정. 실제 component/full CSS headless 40 fail→0 fail, 360/640/1280·pointer/keyboard·axe/console·2,118 tests/type/lint exit0. 수정 후 native production은 unrun |
| D62 | 중단된 CLI 시작과 정상 Strata Unload/Quit 뒤 staging 잔여 | 실제 package12 정상 종료 두 번에서 marker가 사라지고 engine.log만 남음. `8f7ef9b`는 모든 Job 구성원의 종료를 제한된 시간 동안 확인하고 표식을 마지막에 지우며, 실패 시 소유 근거를 유지해 다음 launch 준비/반복 stop에서 복구한다. 소유 잠금·UUID·PID·junction/외부 데이터·동시 실행 보호의 RED/GREEN과 M1/M2/M3/M7 대조, 최종 Rust 1,157 pass/16 ignored·실제 venv·Clippy/fmt pass. 종료 drain 자체의 합성 RED는 재현하지 못했다(M6 pass). pre-D62의 확인 불가능한 잔여는 자동 삭제하지 않는다. 실제 수정 후 Strata production 재검증은 unrun이므로 이전 fail을 유지한다. Linux/Mac 분기의 compile/실행 근거는 아직 없다 |
| D63–D64 | 민감하다고 확인한 고정 진입 인수가 help 명령·전체 launch preview에서 노출 | `fc75f78`은 current/stale·미저장 역할의 display 마스킹과 늦은 preview/import 응답 보호를 구현했다. 실제 projection 대상의 RED→GREEN, 15개 schema·93개 관련 UI, 전체 UI 202 files/2,133 tests·type/lint/provider-options·fmt/Clippy, Rust 27개 아티팩트 1,161 pass/0 fail/16 ignored의 실제 exit를 확인했다. raw pasted 입력·저장값·실제 argv 및 stale 역할의 실행 거부는 보존한다. 다만 아래 D67에서 실제 등록으로 positional 민감도 fact를 공급할 경로가 없음을 확인했으므로, 이 unit/component 결과를 등록 엔진의 native 성공으로 확대하지 않는다. 최종 production은 unrun |
| U1–U3 | 미선택 외부 runtime의 raw ID 오류·오래된 inventory/probe 표시·사라진 Tuning 경로 안내 | 107 관련 검사/typecheck/lint pass; `c920bec`. package5 실제 Model & settings→Profiles 안내 pass, 선택/cache 경합 최종 GUI 검사는 남음 |

F8 checkpoint `01c77c2`의 최종 자동 검사는 Rust 1,147 pass/0 fail/16 ignored, 관련 UI 38 files/504 tests pass 및 Clippy·fmt·typecheck·변경 파일 lint·Python 12개 pass다. ignored 16개 중 15개는 기존 항목이고 1개는 외부 Python 실행 파일을 명시하는 새 opt-in interpreter 여정이다. 이 새 항목은 실제 Python을 지정하여 별도로 실행해 pass했으며 기본 실행에서 생략된 결과를 통과로 계산하지 않는다. worker 보고의 1,152는 하위 프로세스 검사 요약이 중복 포함된 수치였으며, Cargo artifact별 마지막 요약으로 원본 로그를 재집계해 1,147로 정정했다. 이는 argv/parser·저장 계약의 근거이며 실제 엔진 응답을 뜻하지 않는다. `a7581a2`의 encoding/locale과 `2d7f97c`의 adapter boundary 소스 구현을 마쳤으며 최종 native 검증은 진행 중이다. `a7581a2` 인코딩 단계의 전체 Rust는 같은 방식으로 1,150 pass/0 fail/16 ignored이고 관련 UI 508개·typecheck·lint·Clippy·fmt가 pass다. 마지막 실제 프로필/probe 보존 보강 뒤 해당 실제 subprocess 여정과 Clippy를 다시 통과했다. Python opt-in도 현재 소스로 별도 pass다.

재현 raw는 `positional-layout-render/render/results/roles-1792088353768/`(기존 역할 여정 pass), `sensitive-1792088326586/`(현재 역할 마스킹 pass), `sensitive-stale-1792088411164/`(stale 상태 fail), `long-home-product/run-1792088337198/`(짧은 대조군 pass·중간/긴 경로 fail)에 보존한다. 마지막 경로 검사는 F8에서 컴파일된 실행 파일을 별도로 복사·고정한 것으로 UI만 변경된 이후 worktree HEAD와 구분한다. source·binary·의존 파일 hash는 해당 raw와 보충 scope 기록에 남긴다.

어댑터 경계의 최종 source `2d7f97c`에서 Rust 1,152 pass/0 fail/16 ignored, 실제 Python opt-in, Clippy·fmt·no-default-features lib/bins 검사를 통과했다. native/Python의 help argv·scope·catalog·metadata·기존 공개 ID 동등성 두 검사와 기존 등록 엔진 subprocess 여정을 포함한다. 기본 제공 엔진별 명령·metadata 선택과 CLI 옵션 저장 정책은 어댑터 하위에 있으며 공통 GUI/schema·preview에서 새로운 엔진 ID 분기를 요구하지 않는다. 최종 공통 `npm run test:unit`은 199 files/2,113 tests(coverage 포함), typecheck·전체 lint pass다. raw `f9-root-completion-report.md`·`f9-source-evidence.json`과 해당 final-common/f9-boundary 실행 로그에 source·fixture·합성 model·실제 출력 hash를 보존한다. 이 소스 단계의 성공은 고정 production binary의 실제 엔진 성공과 구분한다.

추가 raw: D56 수정 후 `positional-layout-render/render/results/sensitive-stale-1792089107304/`·`sensitive-1792089109006/`·`roles-1792089110654/`; D57 정확한 빌드 receipt를 따른 `long-home-product/run-1792089275704/`; D58 `help-text-render/render/results/text-1792089858035/`와 `claude-g-repair/runs/`의 f9-text 검사들이다. 원래 실패와 비교 가능한 근거를 보존하며 합성 IPC·실제 합성 subprocess·실제 엔진 추론을 구분한다.

수정 코드와 자동 검사 성공만 있는 항목은 실제 production 재검증 전까지 해결 완료로 판정하지 않는다. 이번 G07에는 재시작한 중단 응답·MCP 취소 후 Retry, 선택/cache 경합, 작은 창·접근성·대량 옵션 관찰을 포함한다. 기존 일반 생성 Retry의 성공과 다른 복구 동선의 문제를 구분한다.

D65: 실제 package12에서 동일 engine ID에 새 runtime/build를 등록하면 원본 등록은 성공하지만 상단 완료 안내가 기존 build의 이름을 표시한다. 같은 화면 하단의 실제 반환값은 새 build를 표시해 서로 달랐다. 원인은 등록 callback이 engine ID만 전달하고 부모가 catalog의 첫 이름으로 성공 안내를 구성한 것이다. Claude의 여섯 frontend 파일 수정은 실제 반환된 display name과 runtime ID를 유지하고, 같은 엔진 두 build·목록 갱신 실패·두 등록 경로의 회귀 70개/type/lint를 통과했다. `9909675`로 여섯 파일을 커밋했으며 동일 frontend bytes의 전체 202 files/2,133 tests·typecheck·lint도 통과했다. production13의 advanced manifest 완료 안내는 실제 반환된 새 build 이름/ID로 통과했다. 기본 entry-point wizard 경로의 최종 native 재검증은 남아 있어 전체 항목을 닫지 않는다.

D66: D64의 새 Rust library 검사가 전역 `AIOLM_HOME`을 바꾸면 다른 병렬 검사의 홈 읽기에 영향을 줄 수 있어 `eaee5bf`에서 child process에만 격리 홈을 전달하도록 보강했다. 제품 마스킹/실행 코드와 frontend bytes는 동일 해시로 유지했다. 현재 수정 bytes에서 schema 16개, fmt·Clippy·no-default-features와 전체 Rust 27개 아티팩트 1,162 pass/0 fail/기존 조건부 16 ignored의 실제 exit 0을 확인했다. 한 파일 scoped 커밋과 검토를 마쳤으며 production 검증은 남는다. Cargo artifact별 마지막 요약으로 집계해 내부 child 결과를 중복 계산하지 않았다.

D67: source `9909675`의 실제 계약 조사에서 `option_metadata` v1은 flag spelling만 대상으로 허용하지만 help positional에는 spelling이 없음을 확인했다. supplement에도 민감도를 선언할 필드가 없어, 등록된 엔진이 위치 인자의 known-sensitive fact를 공급할 경로가 없다. D63–D64 검사는 명시 fact를 fixture snapshot에 넣은 범위의 보호 근거이며 등록 여정의 성공 근거가 아니다. 기존 debug CLI 사본도 positional 이름을 flag로 선언하면 exit 1로 거부했고, 새 `positional` 필드는 unknown field로 거부했다. 이 원래 계약 실패를 보존하며, 후속 `1de9dc8`의 D68에서 등록→실제 help→effective schema 연결을 수정했다. production13의 known-sensitive current·미저장 GUI 경로는 통과했지만 stale 경고의 D71 실패와 unknown 반례의 unrun이 남는다. 민감도를 이름으로 추정하거나 accepted help를 직접 조작해 통과시키지 않는다.

D68(`1de9dc8`): `option_metadata` version 1에 관찰된 launch 위치 인자의 effective key를 지정하는 `{"positional":"marker","sensitive":true}` 항목을 추가했다. flag/positional 중 정확히 하나를 검증하며, 같은 key의 flag·request·앱 binding·없는 자리를 가져오거나 새 자리를 만들지 않는다. 기존 provenance·미확정 fact 병합·관찰 구문 우선·차이 표시·digest/help/probe 무효화를 그대로 사용한다. 기존 flag 문서와 기본 제공 어댑터의 직렬화·digest 및 이전 차이 payload를 수정 전 기준값과 정확히 대조했다. 위치 인자의 알려진 민감값은 역할을 명시한 뒤에만 가리며 실제 argv·저장 원문은 보존한다. `runtime_schema.rs`의 변경은 차이 구조체 초기화 한 줄이고 기존 마스킹·실행 및 D66 검사 격리 코드는 유지했다.

실제 native CLI 등록·합성 엔진 help·역할 저장/재로드·실제 spawned argv·명령 preview·같은 runtime 재등록 후 stale 실행 거부/표시 보호를 통과했다. 별도 실제 Python argparse도 같은 등록/help/저장/argv 경로를 통과했다. 초기 integration RED는 양쪽 selector를 가진 잘못된 항목의 거부 문구 차이까지 진행한 결과이며, positive privacy launch의 RED로 확대하지 않는다. 정상 positional 선언을 이전 CLI가 unknown field로 거부한 실제 D69 근거와 새 unit의 거부를 원래 연결 부재의 근거로 구분한다. 이 범위는 실제 합성 subprocess/계약 성공이며 production GUI나 실제 추론 성공이 아니다.

최종 수정과 test-fixtures 전용 integration 등록 뒤 Rust 전체는 28개 Cargo 아티팩트의 마지막 요약만 집계해 **1,170 pass/0 fail/17 ignored**다. 기존 조건부 16개와 새 Python opt-in 1개를 default pass로 계산하지 않았다. 새 Python 검사는 실행 파일을 명시해 별도로 실행하여 **1 pass/0 fail**을 확인했다. 전체 Clippy(-D warnings)·fmt·no-default-features all-targets와 전체 typecheck·lint도 실제 exit 0이다. lockfile은 변경하지 않았다. raw `package13-d68-final-rust-artifact-counts.json`, `claude-g-repair/runs/`의 final-rust/final-python/final-nodefault/final-clippy/final-fmt가 근거다.

최종 frontend/script/contract 641개 파일(앞선 640개와 `tsconfig.node.json`)의 동일 bytes를 검사 전후 대조했다. `npm run test:unit`은 **202 files/2,134 UI tests** 및 contract/direct/script 검사를 통과했다. 첫 전체 실행에서는 변경하지 않은 benchmark 복원 검사 하나가 기존 5초 제한에 걸렸다. 이 실패는 보존했으며, source·제한·skip 변경 없이 해당 파일 9개와 Rust 검사 종료 뒤 같은 전체 명령을 다시 실행해 통과했다. 자원 경합 가능성을 단독 원인으로 확정하지 않는다. lint에는 기존 공통 메뉴 경고 1개가 있고 오류는 없다. raw `package13-d68-final-ui-after.json`에 최초 실패·집중 검사·최종 전체 검사·type/lint·source 비교를 연결했다. 이 자동 결과는 최종 production GUI/CLI·실제 엔진 검증을 대체하지 않는다.

## production13 고정 바이너리 검증과 추가 수정

production13은 source `c2dbc5ba271181ed8130b92f5e6c5d0466c63e22`에서 네 target을 새로 빌드하고 보존했다. GUI SHA-256은 `5a41565dc3767f26debb03b456e218b15fade0d80d16b6668689ee1e020b33aa`, CLI는 `ed43b1065fa21b0a4ae6caee78fcfb9a2a1caa6e2f211a3a54b9594ffe20c8af`다. 설치 패키지는 실행하지 않았다. 아래 성공은 이 고정 바이너리의 범위이며, 이후 D70/D71 수정의 production 성공으로 확대하지 않는다.

- 합성 엔진: pin 뒤 생성한 새 옵션이 고정 앱/source에 없음을 확인했다. 실제 help 1,014개 → 공통 GUI → 새 프로필 저장·닫기·재열기 → fresh probe/Ready → 실제 argv → SSE parser echo를 통과했다. Unicode·공백·따옴표 문자열, negative flag, 명시적 `0`·`false`·마지막 대량 옵션을 확인했다. 기존 프로필 10개는 익명 내용 해시가 모두 유지됐다. 합성 echo와 가짜 usage 4 tokens이며 실제 추론이 아니다.
- 같은 runtime의 v2: 이전 help 무효화·stale 실행 거부·선언한 cwd 불일치 거부, 추가/삭제/arity 변경 diff와 저장값 보존을 확인했다. GUI에서 문맥과 값 개수를 명시적으로 복구하고 튜플·반복·복수 값·값 없는 optional·choice를 새 프로필로 저장/재열기한 뒤 정확한 argv/echo를 확인했다. 반복 여부는 실제 help의 `(repeatable)` 설명을 사용자가 GUI에서 확인한 fact로 기록했다. 정상 Unload 뒤 소유 Python 두 PID와 포트가 사라졌고 이전 두 markerless staging은 보존됐다.
- 실제 개인 빌드: 동일 원본 llama.cpp revision `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 추론 동작을 바꾸지 않는 새 diagnostic flag만 추가해 native CPU로 빌드했다. 엔진 SHA-256 `fe1bd3ab8d94d80e354d047ffd01acd3cfa98feb0258cf60efa2e3aa9e8953ef`, 동일 Qwen 모델로 CLI A01–A09를 모두 통과했다(답변 `5`, PP42/TG2, stream 취소·재시작·등록 제거/재등록·소유 프로세스/포트 정리·외부 파일 해시). production13 개인 엔진 GUI 여정은 아직 unrun이다. 초기 잘못된 descriptor 거부는 보존하며 제품 실패로 바꾸지 않았다.
- D65의 advanced manifest 경로는 실제 반환된 새 이름과 runtime ID가 상·하단에 일치했다. 기본 entry-point wizard 경로의 최종 native 검사는 남는다.
- D68의 known-sensitive positional metadata는 실제 GUI 등록/help에서 적용됐다. 명시 역할의 저장 전 도움말, 저장/재열기 뒤 current 도움말·preview·미해석 import 검토에서는 marker를 가리고 plain/program/script를 표시했다. 붙여넣기 원문과 실제 argv는 유지됐으며 Ready/echo는 marker 해시만 반환했다. 이 범위는 `pass`지만 stale 경고의 D71 실패와 unknown 반례의 unrun을 포함한 전체 privacy 수락은 아직 닫지 않는다. raw textarea까지 포함한 화면 전체의 비밀 문자열 부재를 성공 조건으로 사용하지 않는다.

근거는 raw `package13-candidate.json`, `package13-synthetic-gui-verdict.json`, `package13-v2-gui-verdict.json`, `package13-private-cli-actual-probe-reviewed/results.json`, `package13-d65-advanced-registration-verdict.json`, `package13-privacy-r1-current-verdict.json`이다. 합성 fixture 파일·spec·model과 실제 개인 build/model revision·hash를 각 결과에 연결했다. 전체 개인 설정 복사 대신 익명 프로필 해시만 저장했다. 첫 해시 비교의 identifier 직렬화 오류도 보존하고 JSON identifier/정렬 compact Unicode 형식으로 기존 10개 모두 일치함을 재확인했다.

D70: 원래 Strata revision/config/model의 production13 CLI에서 probe와 native 시작은 성공했지만 산술 답변 검사는 `fail`이었다. 기존 요청의 `max_tokens:32`를 유지했으며 엔진 로그에는 32 tokens/`length`가 기록됐다. 구 harness가 실패 전 SSE 원문을 저장하지 않아 출력 한도를 유일한 원인으로 확정하지 않는다. 모델·질문·정답·한도를 바꿔 통과시키지 않았고 추가 응답 조사가 필요하다. 최초 CLI 시도에서 GGUF를 deployment JSON 자리에 전달한 호출 오류는 별도 실패로 보존했다. 수정 호출은 원래 JSON이 지정하는 동일 모델을 사용한다.

같은 Strata 실행의 정상 `server stop`은 프로세스와 포트를 종료했지만 `engine.log`와 ownership marker를 남기고 Windows 오류 267을 반환했다. 이후 같은 소유 상태의 stop 재시도는 즉시 정리됐다. 잠긴 실제 Windows 파일로 회귀 검사를 실행해 원래 공유 위반 32가 정규 파일에 대한 디렉터리 삭제 fallback 때문에 267로 가려짐을 재현했다. `164d4eb`는 원래 파일 오류를 보존하고, CLI가 기존 종료 10초 예산 안에서 32/33만 재시도하며 매번 UUID/PID/marker 소유권을 재검증하게 한다. 오류 무시·일반 실패 skip·추가 timeout은 없다. 관련 4개와 전체 Rust **28 artifacts/1,172 pass/0 fail/17 ignored**, Clippy(-D warnings)·fmt·no-default all-targets가 통과했다. 이전 최종 검사에 사용한 frontend/script/contracts 641개 bytes도 동일하다. 이 수정의 실제 production 종료 검사는 아직 unrun이다.

D71: 같은 privacy runtime을 r2로 재등록한 stale 화면에서는 명령과 역할이 marker를 가렸지만, 경고문은 backend의 prefix mismatch 오류에 포함된 literal entry 인자를 그대로 표시했다. 실제 화면과 접근성 트리로 노출을 확인했다. raw `package13-privacy-stale-verdict.json`의 `fail`을 유지한다. `afe1e83`에서 mismatch 오류의 literal prefix를 제거했다. 원래 노출의 RED와 관련 schema 17개 GREEN, 최종 Rust **28 artifacts/1,173 pass/0 fail/17 ignored**, Clippy(-D warnings)·fmt·no-default all-targets의 실제 exit 0을 확인했다. 같은 stale 저장 상태를 새 production에서 재검증할 때까지 r2 help를 수락하지 않는다. 런타임/원문 argv와 엄격한 prefix 검증은 유지하며 실제 수정 후 GUI 결과는 아직 unrun이다.

Linux/Mac 후속 담당자는 L02/M01에서 D70의 정상 종료·소유권 오류/기한 보존과 D71의 stale help/preview/launch 오류에 literal 인자가 나오지 않는지를 함께 확인한다. 현재 두 OS의 실제 실행·컴파일은 unrun이며 Windows 결과를 이식해 pass로 기록하지 않는다. W08 별도 OS 테스트 세션은 여전히 제공 불가이고, 독립적으로 실행할 Windows 검증과 수정이 남아 있어 goal은 active다.

## production14 실제 여정과 D72/D73 후속 수정

production14는 source `c112b7d68f3253e510ee70a3f6ebb7046aa0461f`에서 GUI·CLI·NSIS·MSI를 새로 빌드하고 고정했다. GUI SHA-256은 `ed9ce5c73fd157eaaef676ae2888024804f5e02bb23ec2d0c98432c658f20655`, CLI는 `eb35548182e77b0f92d18bbdda282733e13dea16e45df585801042cf93f3b1ba`다. 설치 파일은 실행하지 않았다. 아래 실제 결과와 이후 `645e530`·`bc4e53d`의 소스/자동 검사 결과를 구분한다.

| 범위 | production14 실제 판정과 근거 |
| --- | --- |
| D71 동일 stale 상태 | **pass**. 기존 r1 accepted help·역할·프로필과 r2 등록을 그대로 불러와, 경고의 literal 인자가 사라지고 구조화한 명령의 마스킹과 plain 인자 표시는 유지됨을 화면으로 확인했다. Start는 엄격히 거부하고 저장값을 유지했다. cwd를 명시적으로 비운 뒤 r2의 새 옵션/diff를 검토·수락하고 역할을 다시 연결해, 새 프로필·Ready·원래 positional argv·해시만 담은 합성 응답·정상 Unload까지 복구했다. unknown-sensitive 반례는 아직 unrun이며 합성 응답은 추론이 아니다 |
| 실제 개인 엔진 | **pass, 이 바이너리의 여정 범위**. 고정 후 생성한 새 diagnostic flag가 앱/source에 없음을 확인했다. upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 추론을 바꾸지 않는 flag만 추가한 native CPU build SHA-256 `6d91bc0b962fab7af15566788c3cb724d4bef533d50c47c7564c54230fde880b`를 사용했다. 실제 wizard 실행 파일→help 255개(미확정 189개)→명시적 binding/protocol/probe→등록→공통 옵션→새 프로필 저장/닫기/재열기→fresh probe/Ready→실제 argv→답변 `5`/PP34·TG2를 확인했다. manifest의 `options`에 새 flag를 미리 선언하지 않았다. 한글·공백·따옴표·세미콜론·ampersand 값이 한 token으로 전달되고 무인증 접근은 401이었다. 생성 중 취소·원래 질문 snapshot·Retry 완료·정상 Unload도 확인했다. Retry의 숫자 나열 답변 품질은 별도로 남기며 그 내용을 정답으로 보정하지 않았다. CLI A01–A09도 모두 pass다 |
| 원래 Strata GUI | **공통 추론/도구 여정 pass, 정상 정리는 fail**. 기존 revision `296b59d2f73c8f04a805df29c2fa97655adace78`, native 0.1.44.1, deployment/model/spec4를 유지했다. 새 복사 프로필에서 Ready·실제 답변 `5`/PP74·TG45, 생성 취소·원래 snapshot Retry의 1–1000 응답과 usage, 재시작 뒤 새 답변을 확인했다. MCP 거부는 RPC 0건, 앱과 Windows의 일회 승인 뒤 `blue-2046` 입력→`amber-7319` 반환→실제 모델의 `amber-7319` 후속 답변을 확인했다. 느린 호출 중 취소 후 소유 MCP 두 PID가 사라졌고 89초 뒤에도 늦은 반환/이력 반영이 없었다. MCP 정의는 원래 바이트로 복원하고 이전 로그 해시도 보존했다 |
| 원래 Strata CLI | **D70 정리 pass, 원래 산술 요청 fail 유지**. 취소·정상 stop·제거/미등록 실행 거부·재등록, 소유 PID 12개·포트·빈 staging을 확인했다. 원래 `max_tokens:32` 산술 요청 세 번의 raw SSE는 reasoning만 출력하고 final content 없이 `finish_reason:length`, 실제 completion 32 tokens로 끝났다. 요청·모델·한도·정답 검사를 바꾸지 않았으며 GUI의 다른 기존 요청 성공으로 이 실패를 대체하지 않는다 |
| 저장 자료·외부 파일 | 기존 프로필 10개와 이전 이력 파일 10개가 모두 동일 해시였다. 새 검증 프로필만 추가했으며 전체 설정/이력 복사본을 만들지 않았다. GUI 종료 뒤 원래 Strata weight 두 파일·deployment·실행 파일·bridge·probe helper의 **전체 파일 SHA-256 6개가 모두 동일**했다 |

개인 엔진 모델은 원래 Qwen revision `9217f5db79a29953eb74d5343926648285ec7e67`, GGUF SHA-256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`다. Strata 모델 revision `5348543e0147355ac9cbcb031184a3546350988e`과 두 weight 해시는 앞선 고정 기록과 동일하다. raw `package14-candidate.json`, `package14-d71-stale-native-verdict.json`, `package14-privacy-r2-recovery-verdict.json`, `package14-private-gui-verdict.json`, `package14-private-cli-observed/results.json`, `package14-mcp-approved-rpc-verdict.json`, `package14-mcp-inflight-cancel-verdict.json`, `package14-mcp-definition-restoration-verdict.json`, `strata-adapter-acceptance/package14-cli-observed/results.json`·`package14-post-gui-provenance/results.json`이 각 실행의 source/runtime/model/hash와 범위를 담는다.

D72: 긴 manifest 검토 끝에서 Register를 누르면 새 엔진의 올바른 완료 안내/다음 동작은 위에 생기지만 화면은 JSON 안에 남고, 사라진 Register 버튼의 포커스가 body로 이동했다. 실제 Windows 화면으로 재현했고 `645e530`에서 현재 등록 성공의 안내 그룹에 포커스를 옮겨 브라우저가 다음 동작을 보여 주도록 수정했다. 실패·무관한 refresh·숨긴 페이지에 늦게 도착한 성공은 포커스를 가져가지 않는다. 실제 component/app CSS의 별도 합성 렌더는 수정 전 화면 밖/Tab→Previous, 수정 후 안내와 Open 동작이 보임/Tab→반환된 엔진 Open을 확인했다. 초기 잘못된 CSS harness의 원본은 worker가 삭제해 전사본만 남아 있고, 올바른 CSS의 before/after raw와 원래 native 실패는 보존했다. 관련 54개·typecheck·lint와 전체 `npm run test:unit`(UI 202 files/2,137 tests 및 contract/direct/script 포함)이 exit 0이다. 공통 frontend/script/test/package 619개 파일은 해당 전체 검사 전후 동일 bytes였다. 이 수정의 native production pointer/keyboard 재검증은 **unrun**이다.

D73: production14의 정상 GUI Unload와 모델을 올린 채 앱 Quit에서 각각 소유 프로세스는 종료됐지만 새 staging의 **유효한 owner record·lock·engine.log**가 남았다. 두 예전 markerless 잔여와 구분하고 실패 원본 파일을 보존했다. 다음 Start가 유효한 소유 잔여만 자동 회수하는 것은 pass지만 정상 정리 실패를 pass로 바꾸지 않는다. 실제 원인은 desktop teardown이 tree 종료 확인 뒤 파일 정리를 한 번만 시도하던 경로다. 원래 실패 순간의 구체적인 파일 핸들 보유자는 입증하지 못했다. `bc4e53d`는 소유권을 매번 다시 확인하는 Windows 공유 오류 32/33의 재시도 단계를 CLI와 공유하고, GUI tree 대기와 정리를 **기존 하나의 10초 종료 예산 안에서** 수행한다. UUID/PID/reparse·소유 표식 마지막 삭제·실패 시 다음 시작 복구 계약을 유지한다. 기존 GUI bridge journey에서 실제 삭제를 막는 Windows 파일 핸들로 RED(exit101)→GREEN(exit0)을 확인했다. 전체 Rust는 Cargo 아티팩트 28개별 마지막 요약으로 **1,173 pass/0 fail/17 ignored**이며, worker 합계 1,178의 중복 child 요약 5개를 제외했다. fmt·Clippy(-D warnings)·no-default도 exit 0이다. raw `package14-strata-gui-first-unload-verdict.json`, `package14-strata-gui-normal-quit-verdict.json`, 두 `package14-failed-gui-*` 보존 폴더, `claude-d73/report.md`, `d73-final-rust-artifact-counts.json`에 연결한다. 수정 후 실제 Strata GUI Unload/Quit·CLI 회귀는 **unrun**이다.

다음 production은 D72/D73를 포함한 source를 새로 빌드·고정한 뒤 다시 생성한 미지 flag로 검증한다. production14용 새 대량 옵션 fixture는 준비됐지만, 이 후속 수정의 최종 미지 옵션 성공으로 계산하지 않는다. W05 원래 복합 미디어 질문 실패와 필수 공통 기능/접근성/경합 검사, W08 별도 Windows 설치 세션의 차단은 남아 있으며 goal은 active다.

## production15 고정과 독립 CLI 재검증

D72/D73를 포함하는 source `3b3a121425a983112f90c7fd63cd5e6d497ba5d2`에서 Windows production 빌드가 exit 0(301,875ms)으로 끝났다. 입력 lockfile·도구 설정 해시와 clean Git/인계 커밋을 확인한 뒤 네 산출물을 보존했다. GUI SHA-256은 `52cf95af66c332c1472e961d9f7d70243c28e81372a98c4fae59973c370750cd`, CLI는 `4281322006f54c0eca64cec80546a36e07a4e016c61f9581de761ed1c730ca39`, NSIS는 `d9143daa3e8fb6b2897f461e7be659bba506026b64434938f48780a63f93a5c6`, MSI는 `c9a343e00a25b904fb7c23c3dca03cdd5af23997cce06f7d2dbe82dd478e2723`다. 설치 파일은 실행하지 않았다.

| 항목 | 실행 근거와 판정 |
| --- | --- |
| 고정 후 미지 옵션 | **합성 GUI 수락 pass, 개인 엔진 GUI unrun**. 고정 뒤 새 합성 v1/v2의 1,000개 옵션과 실제 개인 엔진 diagnostic flag를 생성하고, GUI/CLI의 UTF-8·UTF-16 bytes와 고정 source에 해당 flag가 없음을 확인했다. 이전 후보의 새 flag를 재사용하지 않았다. 합성 실제 GUI의 저장·argv·응답과 버전 변경 복구는 아래 추가 근거에 연결한다 |
| 실제 개인 엔진 CLI | **A01–A09 pass**. 같은 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`의 diagnostic 전용 새 native build SHA-256 `d5fec992606e63fab0da5d7660f9ec2ee70bfb63952f454de0f579f9ce624705`와 원래 Qwen 모델을 사용했다. 실제 새 옵션 소비·답변 `5`/PP42·TG2·생성 취소·재시작·제거/미등록 거부·재등록·소유 PID 3개 종료·포트 종료·빈 staging·외부 파일 전체 해시 보존을 확인했다. 별도 새 홈의 production CLI 설정/이전/API 계약 smoke도 exit 0이다. GUI 여정 성공을 뜻하지 않는다 |
| 원래 Strata CLI 회귀 | **정리 pass, 산술 세 요청 fail 유지**. 원래 runtime/model/deployment/descriptor를 유지한 517,902ms 실행에서 A01/A02/A04/A06/A08/A09가 pass다. 소유 PID 12개 종료·포트 종료·빈 staging·외부 파일 6개 전체 해시 보존을 확인했다. A03/A05/A07은 같은 32-token 요청에서 raw SSE가 reasoning만 출력하고 final content 없이 length로 끝났다. 질문·모델·한도·정답을 바꾸지 않았다 |
| CPU portable | **가져오기/실행/정리 pass, 복합 미디어 내용 fail**. 현재 source로 빌드한 별도 debug `runtime-bundle` 도구로 기존 고정 CPU ZIP을 SDK 경로 없는 새 격리 홈에 가져오고 native 파일 13개 해시를 확인했다. 이어 production15 CLI에서 원래 SmolVLM256 Q8_0/f16 projector로 Ready·실제 HTTP/SSE 응답·usage·소유 PID/포트/state/staging 정리를 확인했다. 원래 복합 질문과 이미지, text-first·기록한 기본 system/sampling 제어 요청은 ` AiOLM 42.`/PP118·TG9로 답해 색상·도형 검사는 fail다. 이는 b11460 호환 runtime의 별도 CLI 제어이며 원래 b11617 GUI 요청과의 동등성이나 최종 GUI 수락을 뜻하지 않는다 |
| 배포 파일 정적 확인 | **제한된 범위 pass**. 네 고정 파일에서 동적으로 구한 빌드 홈/작업 경로의 UTF-8·UTF-16 원시 패턴이 없었다. MSI는 Windows Installer DB를 읽기 전용 mode 0으로 열어 version 0.3.1·GUI/CLI 파일 두 개·shortcut 3개·registry 4개를 확인했다. 압축 내부의 모든 문자열 부재, 설치·업그레이드·제거·OS 통합 성공으로 확대하지 않는다 |
| 최종 실제 GUI | **일부 pass, 필수 잔여 unrun**. 최초 Windows 작업 보기/키보드 포커스 차단과 `window_not_focused`를 보존했다. 이후 실제 foreground HWND/PID와 가려지지 않은 화면을 확인하고 이어갔다. 합성 v1/v2 여정과 D73의 원래 Strata GUI Unload/Quit는 pass다. D72의 advanced 등록 완료 안내/Tab·Enter는 pass이며, 개인 엔진의 긴 wizard와 남은 공통 기능은 아직 unrun이다 |

raw는 `package15-candidate.json`, `package15-unknown-engine-preparation/result.json`, `package15-private-cli-observed/results.json`, `strata-adapter-acceptance/package15-cli-observed/results.json`, `package15-strata-original-request-analysis.json`, `package15-cpu-portable-observed2/results.json`, `package15-msi-read-only-database.json`, `package15-distribution-path-byte-audit.json`에 있다. CPU portable 첫 시도는 SDK 없는 PATH에서 관측용 PowerShell을 찾지 못해 추론 전에 중단됐다. 원본을 보존하고 관측 도구만 OS 절대 경로로 수정했으며, 첫 시도의 비어 있는 descendant 목록은 소유 프로세스 검증 성공으로 채택하지 않는다.

W05 원본 argv와 이력을 다시 대조하면 최초 실패 runtime은 b11617 CPU/revision `14310190c`이고 b11460 호환 runtime은 이후 도형 후속 검증이다. 두 실행을 혼동한 작업 메모는 정정했다. 원본 argv가 가리키는 현재 보존 실행 파일의 SHA-256은 `715f0ea98819f03fc596e9d352e989fc0ae093056282e0d73b2d657e7afa7d02`다. 도움말/소스 기반 요청 비교 도구는 합성 stub에서만 검사했으며 아직 실제 GUI HTTP body를 포착하지 않았다. `/slots`의 detokenized prompt와 노출 params 일치는 해당 관측 필드의 일치만 뜻한다. 이미지 embedding이나 전체 HTTP bytes의 동등성 또는 배타적 원인 증명이 아니다. 원래 미디어 fail·필수 GUI/공통 기능 unrun·W08 별도 설치 세션 blocked를 유지하고 goal은 active다.

추가로 **원래 b11617 CPU runtime**의 파일 52개를 새 격리 CLI 홈에만 복사·전체 해시 대조하고, 같은 production15 CLI와 원래 SmolVLM256 Q8_0/f16 projector·이미지·복합 질문으로 실제 제어 실행했다. 명시한 caller system/sampling/text-first 설정에서 HTTP200·PP185/TG7·stop은 확인했지만 답변은 ` A1) A12`로 색상/도형 검사는 **fail**다(exit1/6,587ms). 미리 관측한 소유 PID 종료·포트 종료·state/staging 정리와 원래 runtime 52개·모델·projector·이미지 해시 보존은 pass다. 호환 runtime으로 바꾸지 않고도 별도 API 요청에서 내용 실패가 발생했음을 좁혀 기록한다. 실제 GUI wire를 포착한 것은 아니며 전체 요청 동등성이나 배타적인 앱 밖 원인으로 단정하지 않는다. raw `package15-original-w05-control/results.json`과 해당 `request.json`·`response-sse.txt`, 실행 `1792133600410-package15-original-w05-control`에 연결한다.

## production15 실제 GUI의 미지 옵션·버전 변경·Strata 종료 재검증

같은 고정 GUI와 검증 홈에서 새 합성 엔진의 실제 help 1,014개(형식 미확인 1,008개)를 탐색·검토했다. 전용 화면이나 미리 선언한 옵션 없이 공통 GUI에서 Unicode·공백·따옴표·`;`·`&`를 포함한 텍스트, negative flag, 정수 0, 마지막 1,000번째 옵션을 설정했다. 새 프로필 저장→닫기/재열기→새 probe/Ready→실제 Windows 소유 프로세스 argv→HTTP/SSE의 파서 echo→저장 이력을 대조해 pass다. TG4와 답변은 합성 fixture이며 실제 추론 성공으로 계산하지 않는다. 등록 후 새 엔진의 올바른 이름과 다음 동작이 화면에 나타나고 Tab→Enter로 해당 엔진을 연 D72 검사는 advanced 등록 범위의 pass다.

같은 engine/runtime ID의 v2로 교체했을 때 예전 help/설정은 남고 stale 경고와 실행 거부가 발생했다. 새 help의 추가·삭제·arity 변경 diff를 검토하고 예전 값을 새 작업 초안에서 복구했다. 별도의 새 프로필에 두 값 `[0,7]`, 사용자가 문법을 확인한 반복 tuple `[[1,2],[3,4]]`, 공백/한글 복수 값, 값 없는 optional, choice와 negative flag를 저장·재열었다. 새 Ready 후 OS `CommandLineToArgvW` 결과와 엔진이 받은 argv, 실제 화면/이력의 echo가 일치했다. v1/v2 정상 언로드에서 미리 관측한 소유 Python 프로세스 각 2개와 포트가 종료됐다. 기존 프로필 10개와 이력 파일 10개의 해시는 모두 같고 새 프로필만 두 개 추가됐다. raw `package15-synthetic-gui-verdict.json`, `package15-synthetic-gui-argv-verdict.json`, `package15-synthetic-v2-argv-echo-verdict.json`, `package15-synthetic-v2-normal-unload.json`, `package15-after-synthetic-profile-history-preservation.json`에 연결한다. 이 결과를 미실행 경합·민감 정보 negative case까지 확대하지 않는다.

D73는 원래 Strata revision `296b59d2f73c8f04a805df29c2fa97655adace78`, 모델 revision `5348543e0147355ac9cbcb031184a3546350988e`, 원래 deployment와 `--spec 4`로 재검증했다. 실제 GUI에서 새 probe/Ready와 답변 `5`/PP74·TG39를 확인한 뒤 정상 Unload했다. 미리 관측한 소유 PID 4개·포트·유효한 owner/lock/log가 있던 새 staging이 모두 정리됐다. 재시작 후에도 답변 `5`/PP74·TG45를 확인하고 모델이 로드된 상태에서 앱 창을 정상 종료했다. GUI와 소유 PID 4개·구체적인 포트·새 staging이 모두 정리됐다. 두 예전 markerless 잔여 폴더의 파일 해시는 그대로이며 수동 삭제하지 않았다. 원래 engine·deployment·두 weight shard·공통 helper 2개, 총 6개 파일의 전체 해시도 모두 보존됐다. raw `package15-strata-native-gui-lifecycle-aggregate.json`, `package15-strata-gui-normal-unload-verdict.json`, `package15-strata-gui-normal-quit-verdict.json`, `strata-adapter-acceptance/package15-post-gui-provenance/results.json`이다.

따라서 D73의 실제 Windows GUI 정상 종료/CLI 정리 회귀는 pass다. 이전 production14의 staging 실패 원본과 production15 CLI의 원래 32-token 산술 실패는 유지한다. 이번 GUI 질문을 CLI 실패의 대체 성공으로 사용하지 않으며 MCP·생성 취소/Retry의 production14 근거와 이번 production15 종료 검사를 구분한다. 개인 엔진의 간편 등록 wizard, 남은 공통 기능·미디어 원인 조사·경합 검사와 별도 Windows 설치 세션은 남아 있다. goal은 active다.

## production15 개인 엔진·프로젝트·CPU 번들과 D78

고정한 같은 GUI에 개인 native 엔진을 간편 등록하는 전체 wizard를 실제 Windows에서 실행했다. setup을 가져온 뒤 기본값이 비어 있는 필수 실행 파일을 직접 선택하고, 실제 help 255개(형식 미확인 189개)를 확인했다. manifest의 `options`는 빈 배열이며 앱 고정 후 만든 진단 flag를 미리 선언하지 않았다. 명시한 binding/protocol/probe를 검토·등록하고 공통 옵션 GUI에서 한글·따옴표·공백·세미콜론·ampersand 값을 입력했다. 새 프로필 저장→닫기/재열기→새 모델 probe/Ready→실제 Windows 소유 프로세스 argv→답변 `5`/PP34·TG2를 대조해 **이 바이너리의 여정 범위 pass**다. 값은 정확히 한 인자였고 무인증 요청은 401로 거부됐다. 생성 중 취소의 부분 응답 보존 안내, 같은 질문으로 Retry 완료, 정상 Unload의 소유 PID·포트 종료도 확인했다. 취소 직후 이력 JSON의 별도 snapshot은 포착하지 않았으므로 Retry 전후 snapshot 동일성까지 주장하지 않는다.

개인 엔진은 upstream revision `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 추론을 바꾸지 않는 diagnostic flag만 추가한 build이며 SHA-256 `d5fec992606e63fab0da5d7660f9ec2ee70bfb63952f454de0f579f9ce624705`다. Qwen 모델 revision `9217f5db79a29953eb74d5343926648285ec7e67`과 SHA-256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`는 기존 검증과 같다. 실제 등록 완료의 올바른 안내·포커스·Tab→Open→Enter 동작으로 D72의 긴 wizard도 pass다. 기존 프로필 10개·이력 10개와 예전 staging 파일 해시는 모두 보존됐다. raw `package15-private-gui-verdict.json`, `package15-private-gui-argv-verdict.json`, `package15-private-d72-tab-focus.json`에 연결한다.

비기본 엔진에 연결한 프로젝트의 실제 native 내보내기→동명 독립 복사본 가져오기→재내보내기에서 schema·config·profileApplication이 동일했다. 복사본의 설명 수정이 원본에 영향을 주지 않았고 Apply도 engine/runtime/model 연결을 유지했다. 이는 프로젝트 왕복·적용 범위 pass이며 RAG 성공을 포함하지 않는다. 원래 b11617 CPU runtime의 실제 GUI ZIP 가져오기·내보내기도 manifest 파일 63개 해시 대조를 통과했다. 원래 native 파일 52개는 동일하고 추가 11개는 기존 exporter 계약의 VC 재배포 DLL이다. 두 ZIP 자체의 해시는 다르므로 byte-identical ZIP이라고 기록하지 않는다. 새 설정 홈·SDK 없는 실제 GUI 추론은 별도 unrun이다. raw `package15-project-native/verdict.json`, `package15-original-bundle-preparation/gui-import-export-verdict.json`이다.

D78은 개인 엔진의 긴 manifest 검토에서 Register가 높이 4,285px의 파란 열로 늘어나 label이 화면 밖에 놓인 실제 제품 결함이다. 검토용 PRE와 버튼이 공통 grid의 같은 행을 차지한 것이 원인이었다. 검토 화면만 세로 흐름과 별도 action 행으로 바꾸고 전체 JSON을 줄바꿈해 표시했다. 실제 컴포넌트·전체 앱 CSS·같은 합성 manifest를 사용하는 headless 검사에서 원래 파일을 그대로 공급한 RED는 버튼 1,926px/label 화면 밖을 재현했다. GREEN은 1,100×760·360×520에서 버튼 33.5px, 전체 manifest, 가로 넘침 없음, 실제 pointer/Tab·Enter 등록 1회, 현재 완료 안내/Open 포커스, 등록 실패 후 재검토를 6개 시나리오 모두 통과했다. 이 렌더링은 **합성 IPC**이며 수정 후 production Windows GUI 수락을 대신하지 않는다. 관련 UI 64개·전체 `test:unit`(UI 202파일/2,137개)·typecheck·lint는 exit 0이다. lint의 기존 CustomSelect hook 경고 1개는 남고 오류는 0개다.

raw는 `package15-private-review-layout-defect.json`, `root-d78/1792139343716-red-raw-cdp/results.json`, `root-d78/1792139511402-green-raw-cdp/results.json`과 각 PNG, `claude-g-repair/runs/1792139369348-d78-final-full-npm-unit/result.json`이다. 브라우저 시작·연결·개발 서버의 실패 실행과 잘못된 자동화 Enter 입력도 보존했으며 성공 근거에서 제외했다. D78 수정 후에는 새 production을 고정하고 그 뒤 새 미지 flag를 만들어 실제 GUI를 다시 검증해야 한다. 공통 기능·경합·원래 미디어 실패 조사와 별도 Windows 설치 세션도 남아 goal은 active다.

## production16 고정과 독립 검증·실제 GUI 재검증

D78 수정 후 source `45cb369e15ef4be16151941107aed841c2007d59`(제품 수정 `882d8be`)에서 production 네 target을 새로 빌드했다(exit0/304,433ms). lockfile·도구 설정 입력 해시와 clean Git/필수 인계 커밋을 확인하고 산출물을 별도 고정했다. GUI SHA-256 `b15c65b7e3e76e3a222922d7ea8fc6c61c9dbbcf09826948ecc5619a6afaa1f0`, CLI `160e2a17d1c5158405367ebc18e60aa7ee12db24950f36d1cc3e17d799a28940`, NSIS `2f8ab92ef3bf200100d4c9f9045699eb3ed80df33dcf46e9e9378e6ec372ede5`, MSI `fcf7fa4f0e7cb2ed0741653dc77a514be78ef9e2c141fcebe56e13e230241b4c`다. 설치 파일은 실행하지 않았다. 고정 뒤 생성한 합성 엔진 v1/v2·실제 개인 엔진의 새 flag가 이 GUI/CLI와 고정 source에 없음을 확인했다.

| 범위 | 실제 판정과 근거 |
| --- | --- |
| 개인 native 엔진 CLI | **pass, A01–A09**. 같은 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`의 새 진단 flag build SHA-256 `87dae167a3b96f8c92339526fcf422e3195e2de15741da1587c552229f4da0d4`를 Windows에서 새로 빌드했다. 기존 Qwen revision/모델 해시를 유지하고 등록·probe·실제 flag 소비·추론/usage·취소·재시작·제거/거부·재등록·소유 PID/포트/staging 정리를 11,101ms/exit0으로 확인했다. GUI 도움말·새 프로필 성공의 대체 근거로 사용하지 않는다 |
| 변조 거부/복구 CLI | **pass**. 새 격리 홈에서 개인 엔진의 보조 파일을 새 작업 복사본으로 등록했다. 복사본만 변조한 뒤 probe와 Start가 해시 변경을 엄격히 거부하고 포트가 닫히며 실행 state·잔여 staging이 없음을 확인했다. 변조 상태에서 제거하고 미등록 선택을 거부한 뒤, 복사본을 원래 바이트로 복원·재등록해 probe를 통과했다(1,803ms/exit0). 원래 실행 파일·모델·helper는 바꾸지 않았다 |
| CLI 저장/API 계약 | **pass, 3,444ms/exit0**. 고정 production16 CLI를 명시해 새 홈 초기화·설정 왕복·provider 옵션 검증·선택 원자성/실패 보존을 검사했다. 앞선 환경 변수 지정 오류로 기본 debug CLI를 실행한 별도 성공 로그는 production 근거에서 제외했다 |
| 원래 CPU 번들 | **pass, 이 CLI 범위**. production15 GUI에서 내보낸 원래 b11617 CPU ZIP을 SDK 경로를 제외한 환경의 새 격리 홈에 가져와 payload 63개 해시를 확인했다. 가져오기는 기존 debug `runtime-bundle` 예제 도구(변하지 않은 import 코드, 해시 `e6ebd938…`)를 사용했고 이후 실행은 고정 production16 CLI다. 같은 Qwen 모델로 fresh probe/Ready·답변 `5`/PP34·TG2·정상 stop 뒤 소유 PID/포트/state/staging 정리를 확인했다(6,053ms/exit0). 원래 SmolVLM 미디어 실패를 이 다른 텍스트 검사로 대체하지 않는다. 새 홈의 production GUI 가져오기/실행은 여전히 unrun이다 |
| MSI/산출물 정적 검사 | **pass, 제한된 범위**. Windows Installer database를 읽기 전용 mode0으로 열어 제품/버전·GUI/CLI 두 파일·shortcut 3개·registry 항목 4개를 확인했다. 네 고정 산출물의 UTF-8/UTF-16LE에서 동적으로 구한 builder home/tool-cache/repository 경로 패턴은 발견되지 않았다. 압축 payload 전체의 개인정보 부재·설치/업그레이드/제거·Credential Manager의 성공을 뜻하지 않는다 |
| 실제 GUI16 | **pass, 아래 한정된 여정**. 작업 보기 장애를 해소한 뒤 같은 검증 홈에서 합성 v1·실제 개인 엔진의 새 옵션 등록/도움말/공통 GUI/새 프로필/재열기/실제 argv/응답과 정상 언로드, D78/D72의 긴 검토·작은 창·완료 포커스를 확인했다. 기존 프로필과 시작 전 이력은 해시로 보존을 확인했다. runtime v2·남은 경합/복구·공통 기능·원래 미디어의 최종 native 실행은 별도 unrun이다 |

raw `package16-candidate.json`, `package16-unknown-engine-preparation/result.json`, `package16-private-cli-observed/results.json`, `package16-private-integrity-cli/results.json`, `package16-original-cpu-portable-text/results.json`, `package16-msi-read-only-database.json`, `package16-distribution-path-byte-audit.json`, `package16-current-status.json`에 source/runtime/model revision과 해시·실행 결과·정확한 재개 지점을 남겼다. BGE·Whisper·원래 RAG 문서 등 8개 입력 파일의 전체 해시도 확인했지만 그 준비를 실제 GUI 공통 기능 성공으로 계산하지 않는다.

합성 v1은 앱 고정 뒤 만든 namespace `f34875b685e7`의 옵션을 실제 도움말에서 수락했다. 이전 runtime의 값 7개와 저장 순서는 경고와 함께 보존돼 실행을 차단했으며, 검증용 미저장 초안에서만 명시적으로 정리했다. 새 문자열·negative flag의 `false`·`0`·1,000개 중 마지막 검색 옵션을 공통 GUI로 입력해 **새 G16 프로필**로 저장/재열기했다. 실제 소유 자식 두 개의 Windows argv와 합성 엔진의 파싱 결과·HTTP/SSE 응답·저장 이력이 일치했다. 정상 언로드 후 두 PID와 포트가 사라졌고 예전 두 markerless staging의 로그 해시는 같았다. 합성 TG4는 실제 추론 성공이 아니다. raw `package16-synthetic-v1-argv-echo-verdict.json`, `package16-synthetic-v1-normal-unload.json`이다.

실제 개인 빌드는 위 `87dae167…` 서버와 원래 Qwen0.5B 모델을 유지했다. 별도 setup을 가져와 비어 있는 필수 실행 파일을 native picker로 지정하고, 실제 도움말 255개 옵션/형식·값 개수 미확정 189개를 검토했다(raw schema의 kind 미확정 수는 별도 193개). 등록 manifest의 `options`는 비어 있으며 새 flag를 미리 선언하지 않았다. 모델/포트/호스트/별칭·환경 변수 인증과 별도 probe를 확인해 등록한 뒤 공통 GUI의 새 옵션을 **새 G16 개인 프로필**로 저장/재열기했다. fresh model probe/Ready, 실제 argv의 단일 Unicode·공백·따옴표 인자, 원래 산술 답변 `5`/PP34·TG2, 누락 인증 401을 확인했다. 기존 프로필 10개와 시작 전 비설정 파일 29개의 해시가 유지됐다. raw `package16-private-gui-argv-response-verdict.json`이다.

취소 검사의 첫 실행은 136.8ms 만에 자연 종료해 중지 버튼을 관찰하지 못했으므로 취소 pass에서 제외했다. 같은 질문·모델·제한을 유지한 native UIA 전송/중지 검사에서는 68ms에 실제 중지 버튼을 관찰하고 한 번 실행했다. 부분 응답 16자의 보존과 Retry 전 이력 해시를 기록했으며, 같은 질문으로 Retry가 정상 stop/TG3914로 끝났다. 이 긴 답변의 내용 품질은 판정하지 않았다. 이후 정상 언로드로 소유 PID/포트가 정리됐고 원래 staging 로그는 보존됐다. raw `package16-private-cancel-before-retry.json`, `package16-private-cancel-retry-verdict.json`, `package16-private-gui-normal-unload.json`이다. 프로필 저장의 일부 자동화 클릭은 효과를 확인하지 못한 기록을 보존했고, 표준 키보드 동작 후 실제 이름 입력 화면과 저장 결과를 확인했다. 자동화 반환만으로 성공을 계산하지 않았다.

D78/D72는 **수정 후 실제 Windows GUI의 이 범위 pass**다. 같은 긴 개인 manifest의 Register가 192dpi에서 높이 68px(34 CSS px)로 표시됐으며 일반 창과 실제 client 360×520에서 문구가 보였다. 작은 창의 등록 후 완료 영역에 포커스가 이동하고 Tab으로 정확한 새 엔진 Open에 이동한 뒤 Enter로 해당 상세 화면을 열었다. 원래 창의 위치·outer/client 크기도 정확히 복원했다. 실제 등록은 accessibility primaryAction 경로이므로 이를 물리 마우스 입력 성공으로 확대하지 않는다. headless 실제 pointer/keyboard·실패 복구 6개 검사는 앞선 범위로 유지한다. raw `package16-d78-d72-native-verdict.json`이다.

원래 고정 Strata의 production16 CLI는 309,940ms/exit1로 완료됐다. A01/A02/A04/A06/A08/A09는 pass이며 소유 PID 12개·포트·staging 정리와 원래 입력 6개 해시를 확인했다. **A03/A05/A07의 원래 32-token 산술 답변은 fail**로 유지한다. 모델·질문·제한을 바꾸지 않았으며 같은 엔진의 GUI 성공으로 이 CLI 실패를 지우지 않는다. 실행 시 checkout `01227ae`와 binary source `45cb369`의 차이는 결과 문서뿐임을 별도 pairing 근거로 확인했다. raw `strata-adapter-acceptance/package16-cli-observed/results.json`, `package16-cli-binary-source-pairing.json`이다. 필수 Strata GUI 공통 흐름과 다른 잔여 항목은 계속 실행한다.

이어진 production16 공통 세션 기준 검사에서 **D79**를 재현했다. 새 세션을 저장/로드한 뒤 편집하지 않아도 다음 세션을 만들 때 미저장 변경 경고가 나타났다. 프로필 준비가 실행 설정을 저장한 뒤 화면의 편집본을 갱신하지 않아, 이전 편집본과 정규화된 저장본이 다르게 비교됐다. `ce9cab1`은 처음부터 편집하지 않았고 대기 중에도 같은 선택/내용을 유지한 편집본만 저장 결과와 맞춘다. 로드 전/도중의 실제 이름 편집과 이후 다른 세션 선택은 보존한다. 저장 데이터·API·probe·엔진 제한은 바꾸지 않았다. RED에서 성공/실패 후 잘못된 경고 2개를 재현하고 관련 65개 검사를 통과했으며, 이후 선택 경합 회귀를 포함한 전체 UI 202파일/2,142개·typecheck·lint가 exit0이다(기존 CustomSelect 경고 1개/오류 0개). raw `root-d79/checkpoint.json`과 `claude-g-repair/runs/1792146208171-d79-session-preparation-red`, `1792146275623-d79-session-preparation-green`, `1792146325432-d79-final-full-npm-unit`이다. **D79 수정 후 production GUI는 unrun**이며 위 production16의 한정된 성공을 수정된 binary의 성공으로 소급하지 않는다. 현재는 고정16에서 공통 기능의 기준 검증을 계속하고 추가 결함을 정리한 뒤 최종 production을 다시 검증한다.

W05의 추가 원인 조사에서는 원래 b11617/SmolVLM256 Q8_0/f16·이미지·질문·기록한 caller JSON 제어를 유지한 native 실행이 HTTP200/PP185·TG8/stop·답변 ` Aiolm 42`로 끝나 복합 내용 실패를 다시 관찰했다. 상세 로그 level5에서도 HTTP body 포착은 실패했다. 같은 revision의 `server-http.cpp:181`에서 요청 로거 등록이 주석 처리돼 있으며 로그 자체도 실제 level5를 확인한다. 함수 정의가 존재한다는 사실을 활성 로그 기능으로 추정하지 않는다. 소유 진단 PID/포트와 모든 원래 입력 해시는 정리·보존했으며 이 진단 프로세스의 강제 종료를 앱의 정상 Quit 검증으로 계산하지 않는다.

실제 GUI body 관찰을 위해 [WebView2의 프로세스 환경 변수 방식](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code#using-an-environment-variable)을 사용하는 별도 launcher와 읽기 전용 Network 관찰 도구를 tmp에 준비했다. 실행 시 소유 loopback listener·프로세스 생성 시각·원래 엔진/모델 해시를 먼저 검증하고, 본문/인증 값은 메모리에만 유지해 같은 엔진으로 원문 body를 재전송하도록 했다. 시스템 prompt·인증 값은 결과에 남기지 않는다. 합성 privacy/filter/parser 검사만 통과했으며 **실제 WebView2 연결·GUI body 포착·재전송은 unrun**이다. 전체 HTTP header/framing·GUI wire 동일성이나 배타적인 앱 밖 원인을 주장하지 않는다. raw `w05-network-observation.md`, `w05-network-observer-synthetic-selftest-after-response-privacy-fix.json`, `w05-network-response-privacy-green.json`이다. 필수 GUI 및 설치 세션이 남아 goal은 active다.

## G01–G07과 후속 인계

| ID | 상태 | 남은 실행 |
| --- | --- | --- |
| G01 | unrun | `9818212`의 versioned sourced schema·검증/argv 기반 21개 회귀 및 전체 clippy pass. 이후 descriptor·공통 GUI/profile/실행 연결을 구현했으며 기존 계약의 최종 실제 통합 수락이 남음 |
| G02 | unrun | `fd579ca`의 shell 없는 소유 help 실행·fingerprint/cache·부분 출력·취소 기반 16개 검사와 기존 process 10개/clippy pass. 취소 descendant 검사는 정확한 handle의 OS 종료를 확인해 10/10 반복 pass. `a53f82c`의 영속 snapshot publication/help 전용 취소와 runtime별 accepted help 연결을 추가했으며 실제 GUI의 전체 identity·취소·경합 검증은 남음 |
| G03 | unrun | parser/store·stdout/stderr 근거·column-0 alias·UTF-8·publication 경합 기반 추가. `011b083`은 version/engine/provenance를 검증하는 명시적 `option_metadata`, 같은 effective schema의 단위·민감 값·재시작·제약 적용과 관측/선언 차이 표시를 연결했다. 기존 payload의 필드 생략을 보존하며 metadata digest 변경은 help/probe를 무효화한다. 이후 D31–D35의 parser·한도·충돌·민감 값 수정과 관련 자동 검사를 통과했다. 실제 Chrome의 마스킹·접근성·넘침 검사는 합성 IPC이며 native 성공이 아니다. `a7581a2`의 명시적 encoding/locale과 실제 합성 child·공통 GUI 연결은 pass다. 최종 실제 엔진/native production 여정은 남음 |
| G04 | unrun | 공통 renderer/native/custom profile/launch와 preview 마스킹 위에 `707331f`·`635fdc3`의 versioned 저장 순서/항목별 alias 및 help fingerprint에 연결된 명시적 arity/repeat 보완을 추가. 합성 실제 spawned argv·CLI 저장/거부 integration과 GUI 검사 pass. 거부 조건/equals alias는 `c02bdc4`·`a0a6589`에서 수정/회귀 pass. 최종 고정 GUI의 재로드/실제 엔진 argv 검증은 남음 |
| G05 | unrun | `bd41dfa`·`becf8ee`의 명시적 entry point→help→binding/protocol/probe→등록 단계에 `c3e9edf`의 개방형 adapter setup import·공통 입력 GUI·제품 포함 Strata native-help bridge를 연결했다. 모델 positional binding과 bridge의 명시 argv·옵션 경계는 실제 합성 subprocess에서 pass. package9의 합성 Ready/응답은 이전 범위로 유지한다. `0fbbff9`의 실행 디렉터리와 `414c068`의 명시적 prefix/scope·중첩 옵션 순서의 자동/렌더 검사는 pass다. `01c77c2`에서 전체 interpreter 명령 import와 User/Binding/Static 역할을 slot 순서로 연결했다. 실제 Python argparse의 사용자→model→고정 token→사용자 배치, 반복 tuple·중첩 scope·저장/재로드·정확한 argv 및 layout 유무의 일반 script 여정은 pass다. 개인 엔진·Strata의 최종 production 전체 여정은 남음 |
| G06 | unrun | `3d1c2b8`의 중립 목록·임의 엔진 선택/검색·Add 중심 동선을 package10 WebView2에서 확인했다. 기존 공통 화면·공개 계약의 최종 source 실제 보존 검사와 D23 수정 후 production 검사가 남음 |
| G07 | unrun | 취소·런타임 전환/늦은 import 결과 보호, 1,000옵션의 초기 64개 표시/검색 회귀 추가. 실제 작은 창·접근성·성능 관찰, D15–D19 production 재검증과 최종 고정 binary의 미지 flag 수락 남음. 현재 제품에서 사용하는 ProviderOptions·compact form을 개발 Chrome/full CSS·합성 IPC·controlled cfg로 측정하면 1,000·3,400개 옵션의 import 전후 입력은 약 31ms였다. 독립 noncompact 모드의 57–66ms 관찰은 현재 제품 입력 결함의 근거로 계산하지 않는다. 표준 INP/native WebView2·최종 production 성능 판정은 남는다. raw `option-performance-render/render/results/shipping-typing-1792085452843/result.json`. |

기존 manifest v1 옵션 UI와 이번 최소 결함 수정을 G01–G07 전체 구현으로 계산하지 않는다. 설치 세션의 외부 차단과 독립적인 구현/검증은 계속 진행한다.

package8을 고정한 **후에** 새 합성 옵션 7개와 개인 엔진 진단 flag를 생성해, 고정 앱 바이트와 tracked source에 없고 앱 해시가 그대로임을 확인했다(`g8-unknown-provenance-verdict.json` pass). 합성 script SHA256은 `59019e0f894cf4ca3d4610d3083464b2f8dc2415c264c60d50d480820bc701ee`, 명시적 spec artifact는 `e246d21341d4b10c6126e0166d28e889c01c3e095feb69ba8a617880134eb652`다. 실제 GUI executable→help 14개 옵션→명시적 binding/protocol/probe→등록→원래 opaque 모델 선택→공통 옵션에서 반복 문법 확인→교차 순서/음수 flag/0/복수/선택 값을 입력했다(`gui/621–698`). 여기서 D21을 발견했으므로 **저장→실제 argv→응답은 unrun**이다. 합성 HTTP echo를 실제 추론으로 계산하지 않는다. 별도 개인 llama.cpp는 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 진단 flag 하나만 추가해 Windows CPU 빌드/실제 version exit0, executable SHA256 `8b392a00a7d6a5176f2fb757386c0a1db57129519ee71630b96ab034c09dcce4`를 기록했으며 이 후보의 실제 GUI 여정은 unrun이다. D21 수정의 새 production 후보는 다시 고정한 후 새 미지 flag로 검사한다. 기존 실패·준비 결과는 보존한다.

package9도 바이너리를 고정한 **후에** 새로운 합성 옵션 7개와 별도의 개인 진단 flag를 만들고 앱 바이트/해당 tracked source에 없음을 확인했다(`g9-unknown-provenance-verdict.json`). 합성 script SHA256은 `59019e0f894cf4ca3d4610d3083464b2f8dc2415c264c60d50d480820bc701ee`, spec artifact는 `50a5c6a97d652e605fcdbf7f151b57ae43345159724a5107ca9d235b3065a923`, opaque 모델은 `8d0a5749b7319141d107980bfe59f5d0d4cca2425d13781dff77f1800c45a356`다. 실제 GUI help 14개 옵션→binding/probe 등록→공통 옵션→저장→모델별 probe→소유 프로세스의 실제 argv→Chat HTTP 요청/파서 echo→저장 이력→정상 종료·소유 포트/프로세스 정리를 확인했다(`gui/750–855`). 반복 pair 사이의 text 순서, Unicode·공백·따옴표, negative flag, 0, 복수 값과 값 없는 optional을 실제 파서 결과로 대조했다. 사용량 TG4는 합성 고정값이며 실제 엔진 추론으로 계산하지 않는다. 개인 빌드는 같은 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 새 진단 flag 하나만 추가했고 executable SHA256 `97bd39a2119a1a061f2a05b97116701624e28cde5ea3721fc64c49ba963e154f`다. native version과 package10의 실제 help 253개 탐색은 pass지만 해당 빌드의 GUI 등록→프로필→argv→실제 추론은 unrun이다. 최종 수정 바이너리의 새 미지 flag 수락·버전 변경·경합/취소·실패 복구는 계속 필요하다.

소스 감사에서 모델/포트 바인딩과 일반 옵션의 충돌, Windows 명령 import 문법, bridge help/argv 책임, 명시적 positional binding·사용자 positional/scope, retained diff, metadata/충돌 표시 등의 미검증 경로를 찾았다. 이는 실행 재현 전의 가설·구현 공백을 포함하며 pass나 unsupported로 판정하지 않는다. 각각 재현→수정→관련 검사→production 재검증을 이어간다.

package11은 source `db54f87`(제품 `2d7f97c`)에서 270,016ms/exit0으로 네 production target을 빌드한 뒤 별도 보존했다. GUI SHA256 `ae807b318790d67b867a71a6a412f6adfa34452bc5521bb57e7cbda2f42578c3`, CLI `5b6625476eedb7f0ed954809c3c0dd6b5c8e2fd503cf70dd5a7cdcc08eb5282a`다. 고정 후 새 합성 flag 7개와 개인 진단 flag를 생성해 GUI/CLI 바이트와 tracked source에 없음을 확인했다. 실제 Windows WebView2에서 entry point → help 14개 → 명시적 binding/protocol/probe → 공통 GUI의 Windows 전체 interpreter 명령 import → 반복 구문 직접 확인 → 새 프로필 저장/재열기 → 모델별 probe/Ready → 실제 소유 argv/cwd/auth → Chat echo/저장 이력 → 정상 Quit과 소유 PID·포트 정리를 통과했다. pair 사이 text 순서, Unicode·공백·따옴표, negative flag, 0, 복수 값과 값 없는 optional의 실제 파서 결과를 대조했다. 기존 프로필 4개와 이전 대화 파일 hash가 보존됐다. 답변과 TG4는 합성이며 실제 추론이 아니다. raw `package11-candidate.json`·`package11-unknown-provenance.json`·`package11-synthetic-acceptance.json`·`verify-package11.py`·`package11-normal-quit-cleanup.json`. 실제 개인 엔진은 같은 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 새 진단 flag만 추가해 native 빌드/version을 통과했고 exe SHA256은 `dba138f319bb7c47a1357d3970393b2dfecf31424ae37787af8e12931fbece71`이다. 이 개인 빌드의 등록/argv/추론과 최종 Strata 및 D59 수정 후 production 수락은 unrun이며 package11의 성공을 이후 source에 소급하지 않는다. 설치 파일은 실행하지 않았다.

Windows의 필수 구현·검증·작업별 commit이 끝나면 실제 종료 commit과 Git 상태를 여기에 고정한다. 그 commit을 Linux `codex/linux-runtime-adapter-validation`에서 받아 [L01–L04](windows-device-handoff.ko.md#7-linux에서-이어서-검증)를 실행하고, 이후 Mac `codex/macos-runtime-adapter-revalidation`에서 [M01–M04](windows-device-handoff.ko.md#8-mac에서-최종-재검증)와 [잔여 R01–R13](macos-device-validation-remaining.ko.md)을 실행한다. 각 OS는 자체 binary/venv를 새로 만들고 W/G의 공통 schema·profile·argv·probe 경합 검사를 함께 수행한다. 후속 OS의 공통 수정은 영향을 받은 앞선 OS 검사를 재실행하는 조건으로 인계한다. 현재 checkpoint를 검증 완료한 Windows 종료 commit으로 사용하지 않는다.

후속 기기에서 시작할 구체적인 순서는 다음과 같다. 이 목록은 인계 준비이며 Linux/Mac 실행 결과가 아니다.

D62의 Linux/Mac 분기는 이 Windows 기록으로 컴파일 성공을 추정하지 않는다. L01과 M01에서는 전체 native 빌드 뒤 `providers::launch_resources::tests::recovery_reclaims_only_staging_whose_owner_and_process_are_gone`를 직접 실행하고, OS 잠금·실행 중/재사용 PID·링크·확인할 수 없는 예전 디렉터리 보존을 확인한다. `headless_descendant_listener`와 잠긴 파일 삭제 거부 검사는 Windows 전용이므로 다른 OS에서 테스트 0개로 끝난 결과를 그 계약의 통과로 계산하지 않는다. 해당 OS의 실제 bridge/CLI에서 시작 중단→다음 launch의 소유 staging 복구, 정상 unload/restart/quit의 child·port 정리, 다른 세션/프로세스 보호를 실행한다. 공통 정리 코드를 고치면 Windows의 실제 Strata Unload/Quit 및 headless 지속 실행/중단 복구를 다시 검사한다.

D68의 새 positional metadata 등록·관측 help·명시 역할·원문 argv와 current/stale 표시 보호도 L02/M01에서 해당 OS의 실제 interpreter로 실행한다. 같은 key의 flag/request/app binding 보호, 예전 flag 문서의 digest 보존, 조건부 Python 검사의 실제 실행을 구분한다. `runtime_positional_metadata_journey`는 test-fixtures가 활성화된 검사 대상이며 실제 엔진 추론을 뜻하지 않는다.

D70/D73의 공통 정리 단계는 L01/M01에서 해당 OS의 native 빌드·실제 bridge stop/restart/quit으로 다시 검사한다. Windows 공유 오류 검사의 통과나 다른 OS의 조건부 검사 0개를 Linux/Mac 실행 근거로 사용하지 않는다. D72도 긴 검토 뒤 실제 pointer/keyboard 등록 완료 안내·다음 동작과 숨긴 페이지의 늦은 결과 포커스를 해당 GUI에서 확인한다. 공통 종료/포커스 코드를 수정하면 Windows의 원래 Strata GUI Unload/Quit·CLI 소유 수명주기와 긴 wizard 등록을 관련 재검증으로 연결한다.

D78도 L02/M01의 실제 GUI에서 긴 manifest 전체가 한 열로 읽히고 Register label이 정상 크기 버튼 안에 보이는지 확인한다. 최소 창·OS 글자 크기에서 pointer·Tab/Enter 등록, 실패 후 검토, D72의 완료 안내/Open 포커스를 함께 검사한다. Windows의 headless 합성 IPC 결과를 다른 OS의 native 성공으로 복사하지 않는다. 이 공통 review/scroll 동작을 바꾸면 Windows의 같은 긴 wizard·작은 창·포커스 검사를 다시 실행한다. 실제 GUI 요청 관찰 도구는 기기별로 새로 검증하고 credential·system prompt 원문을 인계하지 않는다. 현재 Windows 종료 commit은 아직 확정하지 않았다.

D63–D65의 공통 UI 수정도 해당 OS에서 current/stale/미저장 역할의 민감값 표시, 늦은 preview/import 응답, 원문·실제 argv 보존과 동일 engine의 새 build 등록 완료 이름/ID를 실제 GUI로 확인해야 한다. 새 flag와 대량 옵션은 그 OS의 고정 앱 이후에 다시 생성한다. 후속 결과에 실제 실행 source와 binary hash를 연결하며 Windows의 이전 바이너리 성공을 복사하지 않는다. 현재 이 항목들은 Linux/Mac `unrun` 인계다.

| ID | 시작 조건과 실행 | 남길 근거/앞선 OS 재검증 |
| --- | --- | --- |
| L01 | 실제 Windows 종료 commit 포함 여부·기존 Git 변경을 확인하고 Linux 도구/desktop 의존성부터 기록한다. lockfile 유지, native rebuild, 공통 자동 검사와 예전 profile/history/import 호환을 실행한다. Windows binary·venv·개인 홈은 복사하지 않는다 | Linux source/toolchain/build hashes와 실제 desktop 종류. 설정/저장 수정은 Windows profile·D18/D19/D20 왕복을 다시 검사 |
| L02 | Linux 앱 binary hash를 먼저 고정한 뒤 앱에 없던 새 flag의 합성 엔진과 실제 개인 엔진을 별도로 만든다. help→명시적 문법 확인→공통 GUI→저장/재로드→실제 argv→응답/usage를 실행한다. native llama.cpp·vLLM·지원 Strata는 각각 고정 revision/model로 검사한다 | 합성/실제 판정 분리, help/build fingerprint·argv·RPC/SSE·소유 process/port. 버전/arity 변경·별칭·반복 tuple·미해석 옵션·탐색 경합/취소도 실행. 공통 schema/launch 수정은 Windows G 수락을 반복 |
| L03 | X11/Wayland의 실제 지원 세션에서 최소 창·키보드·IME·MCP 승인/거부/호출 취소/저장 Retry·media 순서·project/RAG·STT·gateway 인증/alias·CSV/XLSX·portal/clipboard/tray/알림·Secret Service·설치/업그레이드를 검사한다 | desktop/권한 조건과 raw native 동작. 45초 도구는 기존 RPC deadline의 실패/정리 검사이며 반환 성공의 대체가 아니다. 준비된 bounded 도구에서도 새 승인/실제 반환을 따로 확인. 공통 UI/MCP 수정은 Windows D15/D17 반복 |
| L04 | 재현 fail을 먼저 수정하고 Linux production package/CLI/GUI를 수정 후 재검증한다. Windows 관련 W/G 결과가 연결된 Linux 종료 commit과 남은 차단을 Mac에 전달한다 | source/패키지 hash·작업별 commit·clean/dirty Git 상태. 외부 자원 부재를 unsupported로 치환하지 않음 |
| M01 | Linux 종료 commit을 받고 Mac에서 새 native binary/venv를 만든다. 공통 schema/order/확인 metadata·migration·프로필·등록/변조 거부·help cache/diff·탐색 취소를 검사한다 | Mac 기기/OS/architecture·source·binary/runtime/model hash. Mac 성공을 Windows/Linux 결과로 복사하지 않음 |
| M02 | 원래 모델·호환 환경을 보존하고 실제 WKWebView에서 llama.cpp CPU/Metal·vllm-metal·MLX 및 지원 개인 엔진의 공통 여정을 실행한다. 앱 hash 고정 후 새 flag를 만드는 순서와 실제 media/MCP/usage/취소·Retry·종료 계약을 유지한다 | 엔진별 실제 결과와 준비된 probe/capability. 공통 변경은 Windows/Linux의 G·chat·gateway 관련 검사를 다시 실행 |
| M03 | MAC-R01–R13을 각각 독립 판정한다. 원본 FP와 새 음성 3개, 원래 SmolVLM 질문, 개발 reload, 최신 DMG/호환 bundle, 별도 계정/Keychain/Finder, ffmpeg 부재, VoiceOver, Intel/구형 OS, 실제 개인 엔진 조건을 확보한다 | 원래 fail/blocked/unrun 보존. 다른 모델/기기의 성공으로 대체하지 않으며 필요한 자원과 다음 실행을 명시 |
| M04 | 마지막 수정 후 production package/실제 GUI/CLI·기존 데이터 보존·정상 종료/복원을 확인하고 Mac 종료 source와 앞선 OS 관련 재검증을 고정한다 | OS별 최종 commit/hash·미해결 항목. 모든 OS 실행은 해당 기기에서 수행 |


## production16 공통 연결과 세션 이름 수정

이 절의 실제 GUI는 source `45cb369`와 위에 고정한 production16이다. 이후 D79·D80 소스 수정의 native 성공으로 소급하지 않는다.

| 범위 | 판정과 실행 근거 |
| --- | --- |
| 별도 검색 엔진 + Strata 답변 | **pass, 현재 여정**. 원래 b11617 CPU/BGE revision `d32f8c040ea3b516330eeb75b72bcc2d3a780ab7`, 모델 SHA-256 `ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514`를 명시적 embedding 모드의 새 세션/프로필로 저장했다. 실제 Chat에서 이 검색 대상을 선택하고 원래 Unicode·공백 경로 문서 두 개/순서/질문을 유지했다. 원래 고정 Strata가 Pim/teal heron을 답했고 vector score .6176/.4054·인용·PP229/TG165·저장 이력을 확인했다. reload는 별도 unrun |
| 독립 세션·gateway | **pass, 현재 여정**. main Strata와 두 named 세션을 함께 실행했다. 실제 GUI가 시작한 gateway에서 누락/잘못된 key401, 실제 BGE embedding200/384차원/usage8, embedding 대상 chat400 `unsupported_task`, 미등록 모델404, 다른 실제 텍스트 세션의 답변5를 확인했다. BGE만 정상 중지한 뒤 같은 key로 모델 목록에서 제거/embedding404·다른 세션의 답변5/PP44·TG2를 확인했다. key는 메모리에서만 사용했고 파일에 저장하지 않았다. 원래 clipboard DataObject 복원 호출은 확인했으나 모든 형식의 바이트 일치를 주장하지 않는다 |
| 별도 음성 엔진 + Strata 답변 | **pass, 현재 여정**. 원래 explicit Whisper bridge·revision `0c7be696371069e0baa2515ed7aa08d5a5473aa6`, CLI SHA-256 `21bfbad3dd5749b6f82e82786c30f8714a82a754d424af46903d4370f738d984`, tiny.en revision `5359861c739e955e79d9a303bcbc70fb988958b1`, 모델 SHA-256 `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f`를 유지했다. 실제 GUI 등록→새 named STT/프로필→원래 manifest의 정확한 모델 경로→fresh probe의 transcription task→명시적 음성 대상 선택→원래 JFK WAV/질문으로 실행했다. 실제 Whisper 전사와 별도 Strata 답변, PP124/TG160·stop·저장된 audio/transcription/응답 역할을 확인했다. reload·정상 Quit은 별도 unrun |
| 경로/등록 제한 | **pass, 거부 계약**. 모델 실행 중 등록이 잠기는 기존 안내를 확인하고 해당 검증 모델을 정상 중지한 뒤 등록했다. 원래 bridge가 모델 경로 문자열을 엄격히 비교해 같은 파일의 별칭 경로를 거부한 결과를 보존했다. samefile/전체 해시로 동일 파일임을 확인하고 manifest에 선언된 원래 경로를 선택했으며 bridge·모델·해시 검사를 바꾸지 않았다 |
| 원래 실패 보존 | **fail 유지**. 앞선 Qwen 첫 음성 답변의 추가 주장, Strata CLI의 원래 32-token 산술 실패, 원래 SmolVLM 이미지 내용 실패를 위 성공으로 지우지 않는다. Windows 실제 설치/업그레이드/제거/Credential Manager는 별도 로그인 계정/VM 부재로 blocked다 |

raw는 `package16-strata-bge-rag-native-verdict.json`, `package16-gateway-native/phase1.json`, `phase2.json`, `package16-bge-independent-normal-stop.json`, `package16-whisper-strata-stt-native-verdict.json`, `package16-stt-original-model-path-identity.json`이다. 원래 Strata revision/model/deployment·두 spec4 인자는 그대로다. 원래 프로필 10개와 production16 시작 전 비설정 파일 29개의 해시 보존, 이후 프로필 전체의 익명 해시 기준을 기록했다. 설정/이력 원문을 복제하거나 커밋하지 않았다. 첫 Strata 정상 언로드의 자식/소유 staging 정리는 확인했지만 해당 시작의 listener를 미리 기록하지 않아 그 포트 정리는 unrun이다. 다음 Strata/Whisper 실행은 실제 소유 PID·listener·staging을 미리 관측했으며 종료 검증은 계속 필요하다.

이 과정에서 **D80**을 재현했다. Sessions에서 저장한 이름이 Chat의 실행 중 답변·검색·음성 대상 메뉴에서 모델 파일명/생성된 이름으로 바뀌어, 여러 엔진의 역할을 찾기 어려웠다. `ce386ab`은 같은 세션 ID의 비어 있지 않은 저장 이름을 표시하고 실제 runtime의 URL·인증·모델·task·상태·ID는 보존한다. 이름이 없거나 공백이면 원래 runtime 이름을 사용한다. 새 engine ID 분기·저장/API 변경은 없다. RED에서 이름 누락 3개와 기존 fallback 통과 2개를 확인했고, 수정 후 관련 4파일/70개와 전체 UI 202파일/2,147개·typecheck·lint가 exit0이다(기존 CustomSelect 경고 1개/오류 0개). embedding 검사 최초 실패는 로드된 답변 fixture 누락으로 첨부가 비활성화된 검사 준비 오류이며, 실제 준비 fixture만 수정한 전후 로그를 보존했다. readiness를 제거하지 않았다. raw `root-d80/checkpoint.json`과 `claude-g-repair/runs/1792149678516-d80-running-session-names-red`, `1792149798741-d80-running-session-names-green-loaded-answer-fixture`, `1792149821774-d80-final-full-npm-unit`이다. **D79/D80 수정 후 production native는 unrun**이다.

L02/M01에서는 해당 OS의 실제 GUI에서 새 named 답변·embedding·transcription 세션을 저장/로드하고, 편집하지 않은 세션의 이동과 실제 편집/선택 경합 보존(D79), 저장 이름의 세 메뉴 표시 및 실제 endpoint/model/auth 보존(D80)을 함께 확인한다. 공통 세션/Chat 코드를 바꾸면 Windows의 같은 새 세션·RAG·STT·gateway 경로를 재검증한다. 최종 Windows 종료 commit은 아직 확정하지 않았으며 goal은 active다.


## production16 MCP·측정·내보내기 기준 검증

source `45cb369`의 같은 고정16 GUI/원래 Strata·모델로 MCP를 검사했다. 거부 후 실제 tool RPC가 없었고, 앱 승인과 Windows 확인창 승인 뒤 `blue-2046` 입력과 다른 도구 반환값 `amber-7319`가 실제 후속 답변/PP82·TG70·stop·저장 이력에 반영됐다. 원래 45초 도구에서는 실제 RPC 전송과 무응답 상태를 확인한 뒤 native Stop을 눌렀다. 소유 MCP 자식 두 개가 종료됐고 호출 후 68초 이상 지나도 응답·늦은 저장 결과가 없었다. 다른 Strata/Whisper 세션과 gateway는 유지됐다. **이 범위 pass**이며 도구 자체는 합성 fixture, 답변은 실제 Strata다. 새 대화에서 도구 선택이 0개로 초기화된 것을 놓친 첫 자동화 요청은 승인 성공에서 제외하고 보존했다. 같은 질문을 명시적 1개 선택 확인 후 실행했으며 모델·답변을 보정하지 않았다. 원래 서버 정의·fixture·trace 기존 바이트 해시는 보존했다. raw `package16-mcp-denied-without-rpc.json`, `package16-mcp-approved-rpc-verdict.json`, `package16-mcp-inflight-cancel-verdict.json`이다.

이후 실제 GUI의 모델 언로드/세션 중지로 Strata·Whisper 소유 PID 5개와 미리 관측한 두 포트, 소유 staging을 정리했다. 예전 markerless 디렉터리 두 개의 로그 해시는 같고 gateway는 유지됐다. **정상 언로드 pass**이며 GUI Quit의 대체 근거로 계산하지 않는다. raw `package16-strata-whisper-normal-unload-verdict.json`이다.

외부 어댑터 v1의 정확한 tokenizer·cold-cache 측정 미지원 계약을 유지하고, 기존 내장 측정 보존은 원래 b11617 CPU/`14310190c`와 원래 Qwen0.5B revision `9217f5db79a29953eb74d5343926648285ec7e67`로 별도 실행했다. 새 측정 프로필과 실제 1K/128/반복1/동시1 선택, 측정 완료 PP1,024·TG128·캐시0·TG116.9032tok/s·TTFT691.8419ms, 실제 argv의 CPU 배치와 완료 후 소유 PID/포트 정리를 확인했다. runtime payload 63개와 원래 모델의 전체 해시를 다시 확인했다. 실제 Windows 저장창으로 새 CSV/XLSX를 생성해 18열·헤더·모델명·숫자·상태를 저장된 trial과 대조했다. **이 측정·내보내기 범위 pass**다. 원래 profile 10개와 시작 전 비설정 파일 29개는 엄격히 같은 해시다. 추가 기준 프로필 중 검증용 Strata 프로필만 앞선 명시적 “프로필 저장 후 실행”으로 revision6→7이 됐으며, revision 한 필드만 메모리에서 이전 값으로 대조하면 전체 기준 해시가 정확히 일치한다. 설정 내용 변경이나 hash 무시로 통과시키지 않았다.

공유는 실제 화면의 모델·장치·측정 조건/결과 미리보기만 검토했고 경로·credential이 없음을 확인했다. **공개 게시·전송 wire는 unrun**이며 공유 버튼은 누르지 않았다. 내보내기에도 경로/credential이 없고 로컬 실행 argv의 인증 파일 인자는 `[redacted]`다. raw `package16-benchmark-export-native-verdict.json`, `package16-benchmark-owned-start-observed.json`, `package16-benchmark-owned-after-completion.json`과 native 저장창 readback이다. 원시 측정/CSV/XLSX/사용자 홈은 커밋하지 않는다. D79/D80 수정 production·이력 reload·tray·원래 이미지 실패의 실제 body 조사·최종 검증은 계속 unrun이며, 이 기록을 최종 Windows 종료 판정으로 사용하지 않는다.


## production16 창 숨김·복원과 알림 요청

같은 고정16(source `45cb369`)의 실제 설정 화면에서 검증 홈의 원래 false인 트레이 설정을 표준 native 접근성 Toggle로 켜고 저장을 확인했다. 창 제어의 정상 Close를 Invoke하자 창은 숨겨지고 같은 GUI 소유 gateway의 loopback listener/인증 없는 요청401은 유지됐다. **같은 binary와 같은 격리 홈을 정상 재실행**하자 두 번째 프로세스가 exit0으로 종료하고 기존 창이 복원됐다. 이후 트레이 설정을 원래 false로 되돌려 저장을 확인했다. **이 창 숨김·single-instance 복원 범위 pass**이며 tray 아이콘의 pointer/context menu 검사는 별도 unrun이다. 포커스가 유지되지 않는 pointer 경로를 억지로 진행하지 않고, 소유 GUI와 실제 자식 WebView2 PID를 검증한 표준 접근성 동작/상태 readback을 사용했다. 첫 작업용 helper의 WebView 자식 PID 비교 오류와 입력 전 거부 로그도 보존했다. 제품 소스 변경이나 물리적 클릭 성공을 주장하지 않는다.

실제 알림 탭의 “테스트 알림 보내기”를 실행해 시스템에 알림 전송을 요청했다는 앱 안내를 확인했다. **native 전송 요청 pass / 실제 OS 표시 unrun**이다. 화면도 Windows의 설치된 앱 identity가 필요함을 안내하며, 별도 W08 계정/VM 부재는 그대로다. OS 알림 설정·권한이나 원래 설치를 바꾸지 않았다. raw `package16-tray-notification-native-verdict.json`, `package16-tray-single-instance-restore.json`, `package16-tray-hidden-owned-gateway.json`, `package16-tray-restored-owned-gateway.json`, `gui/1792152648238-package16-native-notification-submit-readback.json`이다. 수정 후 최종 production, 정상 Quit/이력 reload·원래 미디어 body 조사와 다른 필수 잔여 작업은 계속 필요하다.

## production16 원래 이미지 요청 관찰·동일 본문 재전송과 이력 보존

같은 고정16(source `45cb369`, GUI SHA256 `b15c65b7e3e76e3a222922d7ea8fc6c61c9dbbcf09826948ecc5619a6afaa1f0`)의 일반 실행을 먼저 정상 종료했다. 언로드된 상태의 GUI·WebView 생성 식별자 7개와 gateway 포트가 사라졌고 검증 홈 파일 44개·프로필 전체 항목 29개 해시가 그대로였다. **이 종료는 언로드 상태의 정상 Quit pass**이며 모델 로드 상태의 종료로 확대하지 않는다. raw `package16-stock-normal-quit-verdict.json`이다.

그 뒤 같은 binary·격리 홈을 자식 프로세스 전용 WebView2 진단 환경으로 실행하고, debug listener의 loopback 주소와 소유 WebView 자식을 확인한 뒤 Network 도메인만 연결했다. 원래 b11617 CPU/runtime revision `14310190cd0a0c831fe949ac8cbedd8abdc90695`의 payload 63개, native executable `715f0ea98819f03fc596e9d352e989fc0ae093056282e0d73b2d657e7afa7d02`, 원래 SmolVLM Q8_0·f16 projector 해시를 확인했다. 새 검증 프로필과 실제 GUI로 모델·projector를 선택하고 fresh probe/Ready를 확인했다. 실제 OS argv는 context4096·threads4·GPU layers0·device none이었다. 기존 프로필을 덮어쓰지 않았다.

원래 모델 revision은 `b9e4379657e1450d04d02eec8e345667265b0a00`, 모델 SHA256은 `2a31195d3769c0b0fd0a4906201666108834848db768af11de1d2cef7cd35e65`, projector는 `0802360aca1748f112ea510b8ff277c65b1361c8ef30ed89b83c9c7a60d08e96`다. 원래 질문과 PNG(`18f3d506bbcfb8d098782883c6553ec7f9a8c69643884e5d8c2d92a61fd15dc3`)를 빈 새 대화에서 실제 native picker·Chat 입력으로 보냈다. Network에서 확인한 본문은 11,629바이트/SHA256 `cdec23afa6d0bd1b7070f1580aeace6d71347bfa41fbf1f2a92c51d8460dea60`, system/user 두 메시지, 정확한 질문·이미지 해시와 **text → image** 순서였다. 도구·이전 대화 문서가 추가되지 않았다. 실제 본문은 `runtime_defaults`에 따라 temperature/top_p/top_k를 생략했다. 이전 별도 caller 제어 요청과 역사적 GUI 본문의 동일성을 주장하지 않는다.

첫 관찰기는 GUI가 정상 완료했는데도 Network의 `loadingFailed`만 보고 중단했다. 제품의 SSE 소비 코드는 DONE 뒤 `reader.cancel()`로 reader를 정리한다. [Network 공식 protocol의 응답 스트리밍](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-streamResourceContent)을 사용하는 작업용 관찰기를 추가해 buffered bytes·후속 data events·DONE·final finish를 확인하도록 했다. DONE 없는 취소/잘림·비정상 HTTP·UTF-8 분할·2MiB 한도·민감 값 제외 등의 관련 15개 검사를 통과했다. 첫 실패와 원래 관찰기 파일을 보존했고 제품·엔진 소스나 종료 계약은 바꾸지 않았다.

같은 조건의 두 번째 GUI 요청 본문도 위 SHA256과 정확히 일치했다. 실제 응답의 DONE·HTTP200·stop을 관찰한 뒤, 인증과 본문을 메모리에만 유지해 **동일 본문 바이트를 생성 식별자를 재확인한 같은 native 엔진으로 재전송**했다. GUI와 직접 재전송의 답변은 공백을 포함한 ` AIOLM 42`로 같고 content SHA256은 `16317352b3987fa06036a4fc0e524b908f0a37eb9fcc2f6b124783870e2fa66d`다. GUI usage는 prompt185/completion7/cached184, 직접 재전송은 prompt185/completion8/cached184이며 둘 다 stop이다. GUI의 캐시 제외 PP1·TG7·cached184와 저장된 답변·첨부 해시도 일치했다. **본문·이미지 순서 관찰 및 동일 본문 재전송 pass / 원래 색·도형 질문의 내용 fail**이다. 앞선 첫 GUI 답변 `Aiolm 42`도 보존한다. 대소문자·token 수 차이를 정답 보정하지 않는다. 전체 HTTP framing/header, cache/RNG 상태의 동일성 또는 배타적인 앱/엔진 원인까지 증명한 것은 아니다. raw `package16-w05-network-native-verdict.json`, `package16-w05-network-observed/results.json`, `package16-w05-network-stream-observed/results.json`이다. 앞선 준비 단계의 실제 body 조사 unrun은 이 범위의 실행 결과로 갱신한다.

재시작한 실제 GUI에서 원래 Strata+BGE RAG와 Whisper→Strata STT 대화의 답변·첨부·역할·usage를 다시 열어 확인했고 저장 thread 해시는 원래와 같았다. RAG 숫자 vector score는 최초 Chat과 재로드 화면 모두 표시하지 않았으므로 표시 회귀를 만들거나 숫자 score UI 재로드 성공을 주장하지 않는다. 저장 측정 이력도 실제 메뉴에서 키보드로 선택해 1,024/128 토큰·TTFT691.8ms·TG116.9 tok/s 완료 표를 확인했고 원래 측정 파일의 전체 해시가 같았다. 앞선 native SelectionItem 예외는 보존하며 이력 소실로 판정하지 않는다. raw `package16-history-native-reload-verdict.json`이다.

이후 원래 SmolVLM 모델을 로드한 채 표준 native 창 Close로 정상 종료했다. **사전 관찰한 GUI·WebView·native 엔진 생성 식별자 9개와 debug/엔진 포트 두 개가 사라졌으며, 직전 전체 파일 47개·프로필 30개와 원래 두 markerless staging 로그 해시가 그대로였다.** 강제 kill이나 원래 자료 삭제는 하지 않았다. raw `package16-network-loaded-normal-quit-verdict.json`이다. 이 결과는 원래 CPU 모델의 로드 상태 종료 범위이며 Strata 또는 D79/D80 수정 후 최종 production의 종료 성공으로 확대하지 않는다. 진단 환경이 없는 일반 GUI 재실행과 이미지 이력 재로드는 다음 검사다.

Linux L01–L04와 Mac M01–M04/R01–R13 인계에서는 동일 모델·질문·첨부 순서와 실제 request/default 사용 여부를 함께 기록하고, SSE DONE 뒤 reader 정리를 사용자 취소와 구분해 관찰한다. 후속 OS에서 공통 전송/미디어 소스를 수정하면 이 Windows 원본 이미지 해시·본문·usage·저장/재로드·취소 흐름을 다시 검사한다. 이번에 제품 전송 결함이 입증됐다고 추정하거나 다른 모델로 바꿔 원래 fail을 지우지 않는다. 새 홈 production GUI bundle, 버전 변경·경합·복구·최종 수정 production 및 W08의 필수 미실행 항목이 남아 전체 goal은 active다.

## 새 앱 홈의 production16 이동식 CPU runtime 검증

진단 옵션 없이 같은16을 정상 재실행해 원래 이미지·답변·usage 이력이 표시되고 기존 파일 47개가 그대로임을 확인했다. 다시 정상 종료한 뒤, **설정·대화·runtime을 복사하지 않은 별도 앱·WebView 홈**에서 같은 고정16을 실행했다. 초기 설정의 언어만 명시적으로 선택하고 테마·새 홈 안의 기본 모델 폴더를 유지했다. 자식 PATH는 Windows/System32만 사용했고 `cl.exe`, `cmake.exe`, `hipcc.exe`, `nvcc.exe` 검색은 모두 exit1이었다. 가속기 SDK 환경 변수도 자식에서 제외했다. 호스트의 SDK 파일을 제거한 검사가 아니며 별도 OS 계정의 설치·최초 실행 검증으로 확대하지 않는다.

실제 GUI의 기본 CPU 어댑터 상세 → 고급 → 이동식 runtime ZIP 가져오기 → native picker로 원래 GUI export ZIP(`4cb6f6bd4602facbc1ac9818aeef378e666c63fe69756e7f24f9837f0c9d428f`)을 선택했다. 가져오기 완료 표시와 새 홈의 **원래 payload 63개 전체 해시**를 확인했다. 명시적으로 원래 Qwen0.5B Q4_K_M(revision `9217f5db79a29953eb74d5343926648285ec7e67`, SHA256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`)를 선택하고 CPU runtime·ngl0·threads4·context4096을 GUI에서 저장/실행했다. fresh Ready와 실제 Windows argv·소유 loopback listener를 관찰했다. 원래 단일 숫자 산술 질문의 실제 답변 `5`·PP34/TG2·stop과 저장 이력을 확인했다.

정상 언로드로 사전 관찰 native PID와 포트가 정리됐고, 이어 정상 창 종료 후 GUI·WebView를 포함한 생성 식별자 9개가 사라졌다. staging은 비었고 payload 63개·새 홈 설정/대화 파일 2개·기존 검증 홈 파일 47개 해시가 보존됐다. **이 새 앱 홈의 GUI import → Ready → 실제 추론/usage → 저장 → 정상 언로드/종료 범위 pass**다. 원래 SmolVLM 이미지 질문의 fail은 별도로 유지한다. 화면 밖 버튼·지원되지 않는 접근성 Select의 작업용 거부 기록은 보존했고, 표준 ScrollItem과 키보드 선택 뒤 실제 상태로 판정했다. raw `package16-stock-restored-image-history-verdict.json`, `package16-restored-stock-normal-quit-verdict.json`, `package16-sdkfree-gui-native-verdict.json`이다. 후속 Linux/Mac에서도 원본 bundle 해시·자식 도구 환경·실제 모델 실행을 구분해 재현한다.

## production17 고정과 새 개인 엔진 CLI의 실제 검증

D79/D80을 포함한 깨끗한 source `1c95946186afccc3161b754ae952ee47e3a63649`에서 production17을 한 번 빌드했다. 333,948ms/exit0 후 GUI `9078c9b45967701de9518b996068df9fdd4d29c98a4fac0ee42e6d0b8eacb338`, CLI `612e44ac64899b19b9986ac601dbc9703fa00346f9983b107af2117f40bd981e`, NSIS `cedb64d1481d124b7e67f31a51707c5ee343db6cf002fa0f710af74288b6a0a3`, MSI `957f279f8126bb4501e3ac86d755a52106a260beb5f75e9b479520a1bbf86a59`를 별도 보존했다. 설치 패키지는 생성·고정만 했으며 실행하지 않았다. 기존 lockfile·도구 설정을 바꾸지 않았다. 앞서 마지막 제품 수정에서 통과한 전체 UI 202파일/2,147개·typecheck·lint 근거는 유지하며, 이후 제품 소스 변경은 없다.

**고정한 뒤** 새로운 합성 v1/v2 namespace `14b491937117`의 옵션·1,000개 목록과 실제 개인 엔진의 새 진단 flag를 만들었다. 새 flag들은 고정 GUI·CLI 바이트와 해당 source commit에 없고 앱 해시가 그대로임을 확인했다. 원래 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 추론을 바꾸지 않는 진단 flag만 추가한 Windows CPU 빌드가 exit0이며 executable SHA256은 `9ee4de40ecd8f10f5fc6f27084e1f758d5418de64ef39c8e28e5fcce6bb4f909`다. 실제 version/help exit0와 새 flag 표시를 확인했다. 이 준비를 최종 GUI 수락 성공으로 계산하지 않는다.

첫 CLI 시도는 작업용 manifest를 이전 검사에서 옮길 때 launch/probe 두 경로에 이전 개인 엔진이 남아 새 flag를 소비하지 못하고 시작에 실패했다. provenance에 기록한 엔진과 실행 선언이 달랐으므로 이 결과로 제품17 결함을 주장하지 않는다. 원래 manifest·실패 결과를 보존하고 **두 실행 경로만** 실제17 엔진으로 바꾼 별도 manifest를 만들었다. 설정·옵션·모델·질문·기한·제한은 그대로이며 모든 provenance 파일의 해시를 다시 확인했다. 수정한 작업용 입력으로 고정17 CLI의 A01–A09가 모두 pass다. 실제 `5`/usage·새 flag의 실제 소비, 스트림 중단 후 서버 유지, 재시작·정상 중지·제거/재등록과 소유 PID 3개·포트·staging 정리, 외부 입력 파일 4개 해시 보존을 확인했다. 별도 공통 CLI smoke도 1,194ms/exit0이다. raw `package17-private-cli-observed/results.json`, `package17-private-cli-engine-reference-correction.json`, `package17-private-cli-corrected-observed/results.json`, `claude-g-repair/runs/1792157398935-package17-pinned-native-cli-smoke/result.json`이다.

현재 같은17 GUI의 기존 검증 홈 재실행을 관찰했다. **새 합성/실제 개인 엔진의 최종 GUI help→옵션→프로필→argv→응답, v2 변경·경합·privacy/recovery, D79/D80과 원래 Strata 공통 기능의 수정 후 실제 GUI 재검증은 계속 필요하다.** GUI용 개인 setup은 필수 server 경로의 기본값과 옵션 사전 선언이 없는 별도 recipe이며, CLI용 선언 manifest를 GUI의 미지 옵션 발견 근거로 사용하지 않는다. W08 차단·원래 Strata CLI 및 이미지 내용 실패도 유지한다. 이 후보 고정과 한정된 CLI pass는 전체 Windows 종료 판정이 아니다.

후속 OS의 구체적인 L01–L04/M01–M04·MAC-R01–R13 실행과 공통 수정의 Windows 재검증 연결은 [엔진 어댑터 Linux·Mac 후속 인계](engine-adapter-linux-macos-handoff.ko.md)에 기록했다. Windows 최종 종료 commit은 필수 검증 후 별도로 고정하며, 이 진행 중인 후보의 인계를 완료 선언으로 사용하지 않는다.

## production17 Strata CLI·변조 거부·설치 파일 내부 검사

이 절도 고정 production17/source `1c95946186afccc3161b754ae952ee47e3a63649`의 실제 실행이다. 원래 Strata revision `296b59d2f73c8f04a805df29c2fa97655adace78`, 실행 파일 `c4709f17ef974ffa34af4f0c357160a89249cabf6e9a698fbe6d0dc65a3243fa`, 모델 revision `5348543e0147355ac9cbcb031184a3546350988e`와 기존 deployment·두 shard·bridge 해시를 유지했다. 원래 CLI 수락의 A01/A02/A06/A08/A09는 pass, **A03/A04/A05/A07은 fail**이다. 세 산술 요청은 이전16과 본문 바이트가 같고 32-token 제한에서 HTTP200·DONE·length·PP65/TG32, reasoning113자와 빈 content를 반환했다. 실행·응답 전송을 산술 정답 성공으로 계산하지 않는다. 정상 중지 후 사전 관찰한 소유 PID 11개·포트·새 staging이 정리됐고 외부 파일 6개 해시가 그대로였다. raw `strata-adapter-acceptance/package17-cli-observed/results.json`과 `package17-cli-request-response-assessment.json`이다.

원래 A04의 1,024-token 요청도 본문 바이트가 이전16과 같았다. 실제로 reasoning2,456자·빈 content·PP75/TG1024·DONE에 도달했으며, 기존 작업용 관찰기는 **content가 온 뒤에만** 중단하므로 취소를 실행하지 않았다. 이 A04 fail을 유지하고 GUI 취소 또는 엔진 측 취소 결함의 증거로 확대하지 않는다. 별도 검사는 **같은 원래 A04 요청·모델·1,024-token 제한**에서 실제 reasoning3자가 생성되고 DONE이 오기 전에 HTTP 요청을 중단했다. 요청 SHA256은 `a2747afe99acf5e25f6f042cd51e006568c5f39a07af8f8cdb4e2eb84db96f2f`다. 서버 유지와 이후 정상 stop, 사전 관찰 PID 4개·포트·staging 정리, 원래 해시 6개 보존은 **pass, 클라이언트 중단 범위**다. 엔진 내부의 취소 수신 확인은 증명하지 않았으며 원래 A04·답변 품질·실제 GUI 중지/Retry의 pass로 대체하지 않는다. raw `strata-adapter-acceptance/package17-reasoning-cancel-observed/results.json`이다. 실행 중 checkout에 문서 변경과 작업용 bytecode가 있어 원래 raw의 `source_dirty`는 유지한다. 고정 binary/source 연결은 별도 receipt로 확인했고 bytecode는 실행 종료 후 작업 raw 안에 보존했다.

별도 빈 CLI 홈에서 개인17 엔진의 **작업용 probe 복사본에만 주석을 추가**했다. probe와 start 모두 `adapter artifact changed; register the updated build explicitly`로 거부됐다. 변조 상태의 제거·등록 누락 선택 거부·복원한 복사본의 재등록과 fresh probe는 pass이며, 원래 엔진·모델·helper·고정 CLI는 바꾸지 않았다. 이 결과는 GUI probe 경합의 대체 근거가 아니다. raw `package17-private-integrity-cli/results.json`이다.

MSI 데이터베이스를 읽기 전용 mode0으로 열어 버전0.3.1·실행 파일 2개·shortcut 3개·registry 항목 4개를 확인했다. 이어 [Windows Installer의 embedded cabinet 계약](https://learn.microsoft.com/en-us/windows/win32/msi/media-table)과 [읽기 API](https://learn.microsoft.com/en-us/windows/win32/api/msiquery/nf-msiquery-msirecordreadstream)로 내부 CAB를 작업 디렉터리에 추출하고 Windows `expand.exe`로 풀었다. **설치 작업과 추출한 실행 파일은 실행하지 않았다.** CLI의 전체 SHA256은 고정 CLI와 같았다. MSI 안의 GUI SHA256은 `72942202725f9c53fdf2d7c62234b345e0da63d6f42fce825060925502de16d7`로 standalone GUI와 달랐다. 처음의 전체 동일성 검사는 fail로 보존했다. 실제 차이는 offset28,283,218의 3바이트 `UNK`→`MSI` 하나였으며 [사용 중인 Tauri CLI2.11.4의 포장 소스](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs)와 실제 빌드 로그의 bundle-type patch/restore 동작에 일치했다. 메모리에서 그 명시적 marker만 적용한 예상 전체 bytes와 추출 파일을 완전히 대조했다. 바이너리·MSI 파일은 수정하지 않았고 각 전체 해시를 별도로 유지했다. **제한된 내부 payload provenance pass**이며 설치 GUI·업그레이드/제거·Credential Manager의 pass가 아니다. raw `package17-msi-read-only-database.json`, `package17-msi-gui-difference.json`, `package17-msi-payload-readonly/results-assessment.json`이다.

고정 GUI/CLI/NSIS/MSI와 압축을 푼 MSI 실행 파일에서 실행 환경으로부터 구한 builder home/cache/repository 경로 패턴 4개의 UTF-8/UTF-16LE 일치는 없었다. 개인 경로 원문은 결과에 쓰지 않았다. 이 한정 검사를 모든 종류의 개인정보 부재나 NSIS 압축 내부 검사로 확대하지 않는다. raw `package17-distribution-path-byte-audit.json`과 위 payload assessment다.

이후 NSIS도 설치 실행 없이 내부 application payload 두 개만 추출했다. 도구는 [공식 7-Zip26.04 release](https://github.com/ip7z/7zip/releases/tag/26.04)의 MSI를 공개 asset digest `0b01334a418654293513449f61d6bfc99e5196ca371e3c3dc961eda57cd535c6`로 검증하고 읽기 전용 CAB 추출로 작업 디렉터리에 준비했다. 도구 MSI를 설치하거나 PATH/registry를 바꾸지 않았다. NSIS 목록의 안전한 경로를 확인한 후 `aiolm.exe`와 `aiolm-cli.exe`만 풀었으며, installer·plugin·uninstaller와 추출 GUI/CLI는 실행하지 않았다. NSIS GUI 전체 SHA256은 `75186f89770d03bf932614b7a7cb1d83c5e2231445a19e6c840d6e7101203cca`이고, 위와 같은 bundle marker의 `UNK`→`NSS` 3바이트만 standalone과 달랐다. 명시 marker를 적용한 메모리의 예상 전체 bytes와 정확히 일치했고 CLI는 고정 CLI의 전체 해시와 같았다. 원래 installer·standalone 파일의 전체 해시도 유지했다. 추출한 두 파일의 같은 개인 경로 패턴 검사에 일치는 없었다. **NSIS 내부 application payload provenance의 제한된 pass**이며 실제 설치/업데이트 성공은 여전히 미실행이다. raw `package17-readonly-archive-tool/provenance.json`, `package17-nsis-payload-readonly/results.json`이다.

### 현재 후보의 W/G 잔여 판정

다음은 앞선 source별 실행 결과를 유지하면서 **최종 수정 production17의 남은 필수 흐름**을 구분하는 표다. 초기 전면 전환 차단 중 독립 CLI·내부 패키지 검사를 진행했고, 이후 실제 GUI에서 새 합성/개인 엔진과 원래 Strata의 아래 흐름을 검증했다. 전체 goal은 active다.

| ID | 현재 판정 | 고정한 근거와 다음 실행 |
| --- | --- | --- |
| W01 | pass | 마지막 제품 수정의 전체 UI 202파일/2,147개·typecheck·lint 및 고정17 native CLI smoke pass. 이후 문서만 변경했다. 제품을 다시 수정하면 영향 검사와 수정 후 production을 다시 실행한다. |
| W02 | blocked | 기존 합성 migration·프로필/이력 보존과 새 앱 홈 onboarding은 각각 기록한 source에서 pass. 기존 설치의 실제 OS 계정 이전·자격 증명 검사는 별도 세션 부재로 blocked다. |
| W03 | fail | 고정17 CLI 변조 거부·제거/복원/재등록, 합성17 v1/v2 GUI/help/diff/프로필/argv·응답은 한정 pass. 추가 실제 지연 probe에서 D81 preflight 취소/진행 표시 누락을 재현했다. 수정과 새 production 실제 재검증이 필요하다. |
| W04 | fail | 원래 Strata17 CLI의 빈 최종 content와 기존 원본 실패 유지. 개인17 CLI/실제 GUI의 새 옵션·추론/usage·생성 취소·Retry·정상 언로드, Strata17 GUI의 실제 스트리밍 취소·같은 질문 Retry/usage는 한정 pass. 최종 재시작/로드 상태 종료는 남았다. |
| W05 | fail | 원래 SmolVLM 질문의 내용 fail 유지. production16 실제 본문/순서·동일 bytes 재전송·저장/재로드 근거 보존. 최종17 실제 Strata MCP의 거부/call0·승인/입력과 다른 도구 반환값 후속·호출 중 취소/늦은 결과 보호는 한정 pass. 최종17 미디어 관련 재검증이 남았다. |
| W06 | unrun | 고정17 D79/D80·RAG/STT·gateway·BGE만 중지와 아래 실제 이력 재로드/CSV/XLSX·공유 미리보기/로드 상태 종료는 한정 pass. D81 수정 후 영향 범위의 최종 production 재검증은 남았다. 이전16 성공은 해당 source 범위로 유지한다. |
| W07 | unrun | 원래12 staging 실패는 유지하고 이후 수정된 CLI17 정상 소유 정리와16 GUI의 언로드/로드 중 정상 Quit 성공을 분리한다. 최종17 실제 GUI의 원래 Strata·실패 복구/경합/다른 세션 보호가 남았다. |
| W08 | blocked | 고정17 네 target 생성·MSI/NSIS 읽기 전용 내부 application payload, 새 홈16 CPU bundle 실제 추론은 한정 pass. 별도 OS 계정의 실제 설치/업그레이드/제거·Credential Manager는 blocked이며, 최종 실제 GUI/OS 표시 검사는 남았다. |
| G01 | unrun | 공통 schema/descriptor의 구현·자동 검사와 이전 고정 GUI의 실제 argv 근거 보존. 새 고정17 합성 미지 옵션과 실제 개인 엔진의 GUI/저장/실제 argv·응답은 아래 범위 pass. 전체 계약/기존 기능 보존의 잔여 확인은 남았다. |
| G02 | unrun | help 수명/해시·cache/diff의 source별 근거 보존. 고정17 v2 stale/start 거부·실제 새/삭제/변경 diff·명시 복구는 아래 범위 pass. 탐색 취소·경합의 실제 GUI 확인은 남았다. |
| G03 | unrun | parser/명시 metadata·미확정 정보 보호의 구현/관련 검사 보존. 실제17 합성/개인 엔진 미지 flag 발견·미확정 표시·유지되는 미해석 값의 명시 복구는 아래 범위 pass. 관련 취소/경합은 남았다. |
| G04 | unrun | 공통 renderer/validator/serializer·기존 순서/alias 보존 근거 유지. 새17 합성 v1/v2 프로필 재로드·negative/zero/arity2/repeat tuple/multiple/optional과 실제 개인 flag의 OS argv 대조는 아래 범위 pass. 전체 공통 기능 보존의 잔여 확인은 남았다. |
| G05 | unrun | 빈 options/필수 server 기본값 없는 개인17 setup의 실제 파일 선택→help→명시 binding/probe→등록→새 옵션 GUI/프로필→실제 응답과 Strata/BGE/Whisper의 명시 protocol/bridge 공통 기능은 한정 pass. 최종 종료/실패 복구 등은 남았다. |
| G06 | unrun | 실제17 중립 runtime 목록·미지 엔진 등록과 최종17 D79 성공/편집 보호, D80 세 역할의 이름/연결은 아래 범위 pass. 나머지 공통 기능 보존과 실제 경합 경로 확인은 남았다. |
| G07 | fail | 이전16 긴 wizard·접근성·작은 창과 고정17 대량/미지 옵션 흐름의 근거 보존. 실제17 지연 preflight에서 D81을 재현했다. 취소/진행 표시 수정 후 관련 자동 검사와 새 production 실제 복구 확인이 필요하다. |

별도 OS 세션을 현재 제공할 수 없다는 답변은 보존한다. 기존 설치와 사용자 데이터를 바꾸어 이 차단을 우회하지 않는다. 남은 독립 실행을 계속하며 필수 blocked/unrun과 원래 fail이 있으므로 Windows 종료 commit과 goal complete는 지정하지 않는다.

### Strata 연결 중단 로그 조사와 새 엔진 사전 실행

별도 reasoning 중단 검사에서 이미 보존한 실제 서버 로그를 조사했다. 해당 단일 요청은 `[strata] done: 3 tokens in 2 s (61.8 tok/s) (disconnect, cancel=True)`로 기록됐다. 로그 SHA256은 `3157ff779a17331d4b531f149ba117a9938df57b99c6a63db6df3b4cf12db438`다. 서버 `serve/server.py`의 SHA256 `6c45c639e28a873b854606719d9ce2bb2e0df666f105164e78e2735878b9aa8f`는 이 실제 검사의 등록 기록에 포함된 artifact 해시와 같고, 현재 고정 Strata revision의 해당 파일에 변경이 없다. **서버가 연결 중단을 인지하고 cancellation을 설정한 범위 pass**다. 소스에는 HTTP 연결 감시→취소 설정→generator close, 지원을 알린 native 엔진의 STOP 전송/종료 응답 drain 경로가 있다. 이 소스 경로와 로그를 실제 native STOP/DONE 원문 교환이나 엔진별 finish telemetry를 직접 포착한 증거로 확대하지 않는다. 원래 A04 fail·최종17 GUI 중지/Retry의 unrun과 기존 raw 결과는 그대로 유지했다. 모델·질문을 다시 실행하거나 제한을 바꾸지 않고 기존 근거를 조사했다.

고정17 이후 만든 합성 v1/v2도 Windows의 명시된 Python entry point에서 실제 `--help`와 같은 opaque 모델의 `--probe`를 실행했다. 두 모델 probe는 선언한 engine/runtime/version·모델 지원을 반환했고 tools는 false였다. 도움말은 각각 203,104/203,146바이트이며 SHA256은 `eca99e97843b40841b087ff88a4752108e0b5379b4f0df29c727c642255d9bda` / `d6745e37e74758d8f50eff2fd36fbae8361abf231205b6e884816afb9cd1869e`다. 실제 v2 출력의 기존 text flag 제거/새 flag 추가, count의 단일 값→두 값과 기본값17→[23,24], negative spelling·1,000개 목록의 마지막 flag를 확인했다. fixture·모델·고정 GUI 해시는 보존됐다. 이는 **새 엔진의 entry point/help/probe 실행 전제 검사 pass**이며 AioLM의 parser·cache/diff·공통 GUI·프로필·실제 argv/응답 성공이 아니다. 추론 서버나 GUI 등록은 실행하지 않았다. 두 조사 결과는 `package17-independent-engine-preflight/results.json`과 해당 stdout/stderr에 있으며 완료한 이 사전 검사를 GUI 재개 시 반복하지 않는다.

### 2026-10-16의 외부 차단 판정과 당시 재개 지점

2026-10-16의 독립 CLI·설치 파일 내부·새 엔진 사전 실행·Strata 취소 로그 조사와 관련 기록을 마친 뒤, **연속 세 goal 턴에서 같은 GUI 접근 차단**을 확인했다. 고정17 GUI의 생성 식별자·전체 해시는 그대로이며 창은 응답/표시 중이고 최소화되지 않았다. 다른 앱이 전면에 있고 native 접근성의 내부 항목 수는 0이었다. 표준 전면 전환 거부 뒤 사용자에게 요청한 전면 유지 응답은 아직 없으며, 관련 없는 앱에 입력을 보내거나 검증 창을 강제 재시작하지 않았다. 현재 남은 필수 GUI 실행은 이 외부 상태가 바뀌어야 진행할 수 있다. 별도 Windows 설치 테스트 세션을 제공할 수 없다는 W08 차단도 유지한다. `gui/package17-post-independent-blocker-2.json`, `gui/package17-post-independent-blocker-3.json` 및 `progress.md`에 각 확인과 근거를 남겼다. 이 상태는 **goal blocked 판정의 근거**이며 W/G 완료 또는 Windows 종료 commit을 뜻하지 않는다.

재개 조건은 현재 production17 AioLM 검증 창을 전면에 유지하는 것이다. 새 접근성 상태를 확인한 뒤 **추론 엔진 추가 → 준비된 새 합성17 v1의 실제 help 검토/수락 → 공통 옵션 → 새 프로필 저장/재로드 → fresh probe/Ready → 실제 OS argv/echo/이력 → 정상 언로드**부터 이어간다. 이후 같은 ID의 v2 변경/cache diff·미해석 값 복구, 별도 개인17 setup의 명시적 실행 파일 선택/실제 help/등록/추론, D79/D80과 원래 Strata의 공통 기능을 검증한다. 이미 끝낸 CLI·패키지 내부·help/probe 사전 검사는 반복하지 않는다. 기존 바이너리와 고정 이후 만든 flag·모델·프로필·원래 실패를 보존한다. W08의 설치/업그레이드/제거·Credential Manager는 별도 로그인된 테스트 계정/VM이 필요한 독립 잔여 항목이며 기존 설치·사용자 데이터로 대체하지 않는다.


### 재개 후 production17의 미지 합성 엔진 v1/v2 실제 GUI 검증

사용자의 명시적 재개 뒤 goal이 active임을 확인했다. 당시 GUI 프로세스가 실제로 없다는 native 관찰과 Orca 앱 목록을 확인한 후, **같은 고정17 binary와 기존 검증 홈**을 일반 실행했다. 시간 경과만으로 실행 중인 창을 재시작하지 않았다. 새 창의 소유 WebView2와 생성 시각·binary 전체 해시를 검증해 native 접근성/표준 키보드로 조작했다. 이전 외부 전면 차단 판정은 당시 기록이며 현재 진행을 막지 않는다. 설치용 별도 OS 세션의 W08 차단은 유지한다.

고정 이후 만든 합성17 v1의 **빈 `options` manifest**를 실제 GUI에서 등록했다. 같은 engine family의 예전 표시 이름과 이번 runtime ID를 구분해 이번 빌드를 명시적으로 선택했다. 실제 `--help`의 1,014개 옵션·형식/arity 미확정 1,008개를 검토/수락하고 공통 GUI에서 새 Unicode·공백·따옴표 값, negative false, count0, 1,000개 목록의 마지막 옵션을 설정했다. 기존 설정의 다른 namespace 값과 순서는 명시적으로 보존/경고됐으며, 이번 새 draft에서만 지워 복구했다. **새 프로필 저장→닫기/재열기→현재 help 확인→fresh probe/Ready→소유 Windows 프로세스 두 개의 실제 argv→HTTP/SSE parser echo→stop/TG4와 두 메시지 이력**까지 한정 pass다. fixture에 cache split이 없어 PP는 빈 값이며 실제 추론 성공으로 기록하지 않는다. 원래 프로필 30개 전체 항목 해시와 config 외 원래 파일 46개는 같았다. 원본 전체 47개 파일/30개 프로필은 새 프로필을 만들기 전에도 모두 일치했다.

같은 runtime ID에 v2를 덮어쓰려는 등록은 거부됐다. 이번 검증용 v1 등록만 명시적으로 제거한 뒤 준비된 v2를 등록했다. v1 저장 프로필을 열자 runtime/help 변경과 값 유지가 표시됐으며, 이전 entry point의 help로 실행하려던 요청은 실제로 거부되고 프로필 해시는 그대로였다. 실행 디렉터리를 비워 어댑터 문맥으로 다시 탐색하자 **새 replacement text·삭제된 text·단일 값에서 두 값으로 바뀐 count**가 diff에 표시됐다. 삭제된 옵션 값은 자동 삭제되지 않았다. v2 help를 수락한 뒤 이번 draft의 유지 값만 명시적으로 지우고 count를 두 값으로 복구했다. 반복 tuple은 사용자가 확인한 구문으로 현재 help에 연결해 저장했다. 앞선 native Invoke helper의 거부는 offscreen/disabled를 구분하지 않는 조건이므로 별도 disabled-state 입증으로 계산하지 않는다.

별도의 **새 v2 프로필**에 count `[0,7]`, 반복 pair `[[1,2],[3,4]]`, 공백/Unicode 복수 값, 값 없이 존재하는 optional flag, choice와 negative false를 저장했다. 실제 재열기·current help·fresh probe/Ready 뒤 두 소유 프로세스의 Windows 명령줄을 `CommandLineToArgvW`로 해석해 fixture trace와 전부 대조했다. shell 보간 없이 값이 유지되고 두 pair flag·negative spelling·optional 존재와 인접 option 경계가 일치했다. 실제 Chat parser echo와 저장 이력도 같은 값/stop/TG4였다. **v1 프로필을 포함한 기존 31개 프로필·원래 46개 파일과 새 v1 이력 전체 해시가 그대로**이며 새 프로필은 총32개다.

v1/v2 각각 정상 GUI 언로드 뒤 사전 관찰 소유 프로세스 두 개가 없어지고 포트가 닫혔으며 새 staging은 남지 않았다. 원래 marker 없는 두 staging 디렉터리와 로그 전체 해시는 보존했다. 강제 종료나 이전 자료 삭제를 하지 않았다. 이는 **합성 v1/v2의 GUI·버전 교체·명시 복구·argv·응답·언로드 범위 pass**이고 실제 개인 엔진/Strata 추론·GUI 정상 Quit·probe 경합·전체 W/G 완료는 아니다. 제품 소스·고정 binary·fixture/모델을 바꾸거나 성공에 맞춰 다시 생성하지 않았다.

source는 계속 `1c95946186afccc3161b754ae952ee47e3a63649`, GUI/CLI 전체 해시는 앞선 고정17과 같다. v1/v2 script SHA256은 `59019e0f894cf4ca3d4610d3083464b2f8dc2415c264c60d50d480820bc701ee`, spec SHA256은 각각 `032163f8b64c53fdc359b3b20e67fa5a75999bcbcab017cd17caea917722767d` / `90d6074801687195f341325b59b3f6ded70ce7b83b5b452fa002e92106ee217b`, opaque model SHA256은 `8d0a5749b7319141d107980bfe59f5d0d4cca2425d13781dff77f1800c45a356`다. raw는 `package17r1-synthetic-v1-argv-echo-verdict.json`, `package17r1-synthetic-v2-argv-echo-verdict.json`, 각 `normal-unload.json`과 내부 native evidence 목록이다.

다음 필수 실행은 빈 options/필수 server 기본값 없는 개인17 setup의 실제 실행 파일 선택→help→binding/probe→등록→실제 모델 응답/취소/Retry, 이후 D79/D80와 원래 Strata의 공통 GUI다. 기존 Strata/SmolVLM 내용 fail·W08 blocked는 유지하며 전체 goal은 active다. Linux/Mac 실제 검증은 별도 기기 인계로 유지한다.

### production17의 실제 개인 엔진 GUI와 생성 중 취소·Retry

같은 고정17에, **앱을 고정한 뒤 새 flag를 추가해 빌드한 개인 native 엔진**을 실제 GUI로 연결했다. 원래 upstream revision `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 추론을 바꾸지 않는 진단 옵션만 추가했으며 executable SHA256은 `9ee4de40ecd8f10f5fc6f27084e1f758d5418de64ef39c8e28e5fcce6bb4f909`다. 빈 `options`와 필수 server 기본값이 없는 setup을 native picker로 가져오고 실행 파일을 직접 선택했다. 실제 설치 정보 확인→실제 help의 새 flag 원문→모델/포트/호스트/모델 이름·환경 인증·probe 연결→manifest 검토→등록을 수행했다. 모델 Ready는 등록 후 별도 fresh probe로 확인했다.

실제 help의 255개 옵션과 형식/arity 미확정 189개를 GUI에서 구분했다. 새 진단 옵션의 타입은 미확정이며, 앱이 도움말에 없는 타입이나 모델 능력을 확정한 것으로 기록하지 않는다. 공통 GUI에서 Unicode·따옴표·공백·shell 특수문자가 포함된 새 값을 입력하고 **새 프로필 저장→닫기/재열기→현재 help·정확한 값 확인→fresh Ready**를 거쳤다. 실제 소유 Windows 명령줄을 `CommandLineToArgvW`로 해석해 새 flag가 한 번, 값이 하나의 argv로 전달됨을 확인했다. 인증 값은 argv에 없고 인증 없는 모델 목록 요청은401이었다.

원래 Qwen2.5 0.5B Q4_K_M(revision `9217f5db79a29953eb74d5343926648285ec7e67`, SHA256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`)의 원래 단일 숫자 산술 질문은 실제 답변 `5`·PP34/TG2·cached0·stop과 두 메시지 이력으로 완료됐다. 이 결과는 **실제 엔진 추론 pass**이며 합성 parser echo와 구분한다. 기존 32개 프로필 전체 항목과 중복 경로를 정규화한 기존 config 외 파일 48개 해시가 모두 같았다. 새 엔진의 Default와 새 검증 프로필이 추가돼 총34개 프로필이다. 기존 항목을 덮어쓰지 않았다.

같은 원래 숫자 나열 질문으로 실제 스트리밍 본문 23자를 관찰하고 enabled Stop을 한 번 실행했다. 653ms 시점의 실제 생성 관찰 뒤 취소됐으며, 부분164자·interrupted와 GUI의 부분 응답 보존 안내가 저장됐다. 별도 검증 기록을 보존한 뒤 **같은 user 메시지의 Retry**를 실행해 자연 완료 stop/TG3948·cached41·캐시 제외 PP1과 두 메시지 이력을 확인했다. 출력 길이나 내용의 정답 품질까지 주장하지 않는다. 모델·질문·제한·제품 timeout을 바꾸지 않았다. 정상 GUI 언로드 후 사전 관찰 native 프로세스와 포트가 없어졌으며 새 staging은 없고 원래 두 markerless 로그 해시는 같았다. GUI 정상 Quit 또는 Strata 취소 성공으로 확대하지 않는다.

작업용 첫 native picker 경로의 `/` 구분자는 Windows가 거부했다. 두 오류 창을 정확한 소유권/오류 본문으로 확인해 정상 닫고, `\` 구분자 경로의 readback 뒤 가져오기를 완료했다. SaveAs의 접근성 Invoke 예외와 pointer 무효 동작도 보존했으며, 표준 SetFocus의 실제 지연 readback 후 Return으로 폼이 열렸다. 이 자동화 문제를 제품 결함으로 계산하지 않았다. raw는 `package17r1-private-gui-argv-response-verdict.json`, `package17r1-private-cancel-retry-verdict.json`, `package17r1-private-normal-unload.json` 및 각각의 native 근거다. 제품 소스·고정 binary와 원래 데이터/실패를 보존했다.

### production17 D79 세션 편집과 D80 답변 대상의 실제 재검증

새 검증 세션을 저장하고 실제로 로드했다. 로드 준비 과정이 null이던 실행 설정을 저장한 것을 확인한 뒤, 편집하지 않은 상태에서 **새 세션**을 선택하자 미저장 경고 없이 빈 편집기가 열렸다. 이어 실제 이름을 편집하고 새 세션을 누르자 미저장 경고가 나타났으며, 취소 후 정확한 편집값이 유지됐다. 검증용 미저장 이름만 원래 빈 값으로 되돌렸다. **D79의 성공 경로/실제 편집 보호 범위 pass**다. 실패/준비 중 경합의 자동 근거는 유지하며 이 단일 GUI 경로로 해당 실제 경합까지 입증했다고 확대하지 않는다.

Chat 대화 설정에서 실행 중 세션이 저장한 **G17 private answer** 이름으로 표시됐고, 실제 선택 readback 뒤 같은 산술 질문의 답변 `5`·PP34/TG2·stop을 확인했다. 기본 서버는 중지된 채 별도 세션의 새 소유 native 프로세스가 응답했다. 기존 세션 정의 3개와 직전 프로필 34개 전체 항목 해시가 같고, 이번 세션의 해결된 실행 설정만 추가됐다. **D80의 답변 대상 이름/연결 범위 pass**이며 임베딩·STT 이름/라우팅은 최종17에서 아직 unrun이다. 세션 엔진은 다음 공통 검사에 사용하기 위해 실행 중이다. raw `package17r1-d79-d80-answer-native-verdict.json`이며 정상 종료 근거를 이 항목에 포함하지 않는다.

고정 binary의 합성 엔진과 실제 개인 엔진에서 모두 help→공통 GUI→새 프로필→실제 argv→응답을 확인했다. 이 범위의 완료 근거를 전체 W/G 완료로 확대하지 않는다. 다음은 원래 Strata의 공통 GUI와 임베딩/STT 이름·라우팅, probe/help 경합·실패 복구·최종 정상 종료다. W08의 별도 OS 세션 차단과 원래 Strata/SmolVLM 내용 fail을 유지하고 goal은 active다.

### production17의 Strata·BGE·Whisper 실제 공통 기능과 D80 역할 검증

실제 개인 엔진 답변 세션을 유지한 채 원래 b11617 CPU runtime·BGE Q8_0 모델로 새 임베딩 프로필과 세션을 구성했다. 기존 `--embedding` 설정과 context512를 확인했다. **기존 세션을 중지하지 않는 원래 false 설정**을 로드 직전에 확인했고 답변 세션의 생성 식별자·포트가 그대로 유지됐다. 준비 중 작업용 토글을 잘못 한 번 바꾼 것은 새 엔진 로드 전에 원래 false로 복구하고 readback/기존 프로세스 보존을 확인했다. 제품이나 기본 정책의 변경으로 계산하지 않는다. 실행 중 임베딩 세션을 새 이름으로 저장한 뒤 Chat에 **G17 BGE embedding**이 반영되고 정확히 선택됐다.

원래 Whisper native bridge와 tiny.en 모델도 새 프로필·세션으로 연결했다. 첫 별칭 경로는 bridge의 **선언한 모델 경로 문자열만 허용하는 계약**에 따라 probe가 false를 반환했다. 이전16의 같은 계약/거부 기록과 소스를 확인하고, `samefile`·원래 모델/bridge 해시로 동일 파일임을 검증한 뒤 기존에 선언한 경로를 GUI에서 선택했다. bridge·모델·해시를 바꾸지 않았다. 실제 fresh probe는 transcription만 허용하고 chat은 false이며, 새 세션 로드가 성공했다. 첫 거부와 새 프로필도 보존했다. Windows 기능 미지원 판정이 아니다. 실행 후 저장한 **G17 Whisper STT**가 음성 전사 선택기에 반영되고 정확히 선택됐다. 기존 프로필34개 전체 해시를 유지하면서 이번 BGE·STT·Strata 검증 프로필 등을 추가해 총38개다.

같은 고정17에서 원래 Strata의 실제 help를 다시 탐색/수락하고 공통 GUI의 **spec4·tokens 단위·재시작 메타데이터와 출처**를 확인했다. 기존 값을 복제한 새 검증 프로필을 저장/재열기한 뒤 원래 배포 모델로 fresh probe/Ready를 거쳤다. 원래 revision `296b59d2f73c8f04a805df29c2fa97655adace78`, 모델 revision `5348543e0147355ac9cbcb031184a3546350988e`, native executable SHA256 `c4709f17ef974ffa34af4f0c357160a89249cabf6e9a698fbe6d0dc65a3243fa`를 유지했다. 실제 Windows argv의 spec4 두 곳·context131072·KV int8·resident32768이 기존 설정과 같다. 실제 probe의 accelerator 값은 `unverified`였으며 이를 임의로 GPU 검증값으로 고치지 않았다. 모델 지원과 chat/tools capability, 실제 모델 실행은 별도 근거로 기록했다. BGE·Whisper·개인 답변 세션도 함께 유지됐다.

Chat에서 답변을 기본 Strata로, 임베딩을 위의 새 BGE 이름으로 명시적으로 선택했다. 원래 Unicode/공백 경로의 **lumen-notes.md→unrelated.md** 두 문서와 질문의 전체 해시·순서를 유지한 실제 요청은 `Pim, a teal heron.`·PP229/TG231·stop과 저장 이력으로 완료됐다. 실제 인용 순위는 Lumen0.6168/다른 문서0.4061이다. 이전16의0.6176/0.4054로 보정하지 않았다. BGE revision `d32f8c040ea3b516330eeb75b72bcc2d3a780ab7`, 모델 SHA256 `ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514`와 원래 CPU executable 해시를 대조했다. **이 실제 RAG/역할 연결 범위 pass**다.

이어 새 대화에서 원래 JFK WAV(`59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`,352,078바이트)와 같은 질문을 전송했다. 원래 native Whisper CLI가 전사한 실제 새 기록은 한 개이며 exit0·전사106자다. 저장 오디오의 preparation은 새 STT 세션·모델·그 실제 전사와 일치했다. Strata는 나라가 자신을 위해 무엇을 할지 묻기보다 자신이 나라를 위해 무엇을 할지 물으라는 내용의 한 문장 답변을 PP124/TG160·stop으로 완료했다. 원래 Whisper revision `0c7be696371069e0baa2515ed7aa08d5a5473aa6`, CLI·모델·bridge 해시는 앞선 근거와 같다. 기존 bridge 로그 prefix 전체 해시도 보존됐다. **실제 STT→Strata 답변/usage·저장 역할과 D80 임베딩/STT 이름 반영 범위 pass**다. 가짜 전사나 합성 추론으로 대체하지 않았다.

raw `package17r1-strata-rag-stt-native-verdict.json`, `package17r1-stt-original-path-identity.json`, `package17r1-four-engines-load-observed.json`과 각각의 native 근거에 입력/출력·revision·해시·역할이 있다. 프로세스 소유권은 부모 PID만 보지 않고 **실제 부모 이후에 생성된 자식**으로 검증해 이전 PID 재사용의 외부 프로세스를 제외했다. 원래 Strata CLI 산술 질문의 빈 content fail·SmolVLM 내용 fail은 유지한다. 이후의 MCP·gateway·취소/Retry 결과는 다음 항목으로 분리한다. probe/help 경합·실패 복구·실제 이력 재로드·로드 상태 정상 Quit와 W08의 별도 OS 세션 차단이 남아 goal은 active다.

### production17 Strata의 MCP 승인·거부·호출 중 취소

같은 고정 GUI와 원래 Strata/model revision에서 원래 MCP 질문과 로컬 합성 도구를 사용했다. 도구 서버 정의 SHA256 `76c2900092ca8269ca4c86840ac653fbbb21eb38a0b5de163e1dd784b342cf70`과 fixture `671a31a297476a9a0bd2d9e7f6cb01f99720857f3f0c39f05d4be6dae5ead333`를 유지했다. 합성 도구의 응답과 실제 Strata의 후속 추론을 구분한다.

거부 경로는 실제 승인 대화에서 거부 후 사용자 거부 오류를 표시했고 `tools/call`은 0개였다. 승인 경로는 앱의 일회 승인과 소유 Windows 확인 창을 거쳐 `blue-2046` 입력의 실제 RPC 한 번이 실행됐다. 도구는 입력과 다른 `amber-7319`를 반환했고, Strata의 최종 답변도 `amber-7319`·PP82/TG70·cached354·stop이었다. 원래 서버/fixture와 기존 trace prefix 해시가 같았다. 각각 **한정 pass**이며 raw `package17r1-mcp-denied-native-verdict.json`, `package17r1-mcp-approved-native-verdict.json`이다.

지연 도구는 원래 `violet-6247` 입력·45초 지연을 유지했다. 실제 RPC가 도구에 도달하고 아직 결과가 없는 것을 확인한 뒤 GUI Stop을 실행했다. 취소 안내·저장 이력을 확인했으며 새로 생성된 MCP 소유 프로세스 3개가 없어지고 기존 엔진/GUI 소유 식별자 18개와 포트 4개는 그대로였다. 실제 호출 후106초에 응답이나 늦은 이력 변경이 없었다. 검사 도구의 강제 종료 없이 **호출 중 취소/늦은 결과 보호 범위 pass**다. raw `package17r1-mcp-inflight-cancel-native-verdict.json`이며 엔진의 native STOP/DONE wire 확인으로 확대하지 않는다.

### production17 gateway와 한 세션만 정상 중지

실제 GUI에서 loopback gateway를 시작했다. API 키는 실제 복사 동작으로 프로세스 메모리에서만 사용하고 원래 clipboard DataObject 복원을 호출했으며 키·인증 header를 저장하지 않았다. 모든 clipboard 형식의 바이트 동일성을 검증했다는 뜻은 아니다. 인증 누락/오류401, 모델 별칭 4개, BGE 실제 임베딩384차원·usage8, 잘못된 task400/`unsupported_task`, 없는 모델404를 확인했다. 개인 엔진 별칭의 원래 산술 요청은 `5`·PP44/TG2였고, 원래 JFK의 실제 multipart STT는106자·기존 전사 SHA256 `dfe1af694958a82c9d89d31bf0378075a10d40f715e670b6e5169042c8680cec`와 같았다. 이는 앞선 GUI STT 뒤 별도로 실행된 두 번째 실제 전사다.

같은 키를 메모리에서 유지한 채 실제 GUI에서 BGE 세션만 정상 중지했다. BGE와 소유 conhost가 없어지고 해당 포트가 닫혔다. 나머지 소유 식별자16개·Strata/Whisper/개인 엔진/gateway 포트는 유지됐다. 같은 키의 모델 목록 요청은200이며 BGE 별칭은 사라져404, 다른 개인 엔진 요청은 계속 `5`였다. helper 정상 종료 후 메모리 키를 비웠다. 원래 두 markerless 로그 해시는 같고 BGE 정의·프로필도 유지됐다. **인증/공통 역할 라우팅·독립 정상 중지 범위 pass**이며 전체 GUI 종료 성공은 별도다. raw `package17r1-gateway-native/phase1.json`, `phase2.json`, `package17r1-bge-gateway-independent-stop-verdict.json`이다.

### production17 Strata의 실제 생성 취소와 같은 질문 Retry

원래 숫자 나열 질문 SHA256 `584b6df00db96e08c9e8a1f6e512bb6fbca9bbf1ed7576090a0c2bfdc955b288`으로 실제 추론 텍스트가 스트리밍되는 것을 GUI에서 확인했다. 정상 Stop 후 content0·reasoning1,751자의 중단된 부분과 interrupted 상태가 저장됐다. 이때의 별도 원본을 보존하고 같은 user 메시지의 Retry를 한 번 실행했다. 기존 GUI 제한·모델·질문·timeout을 바꾸지 않았다.

Retry는 약33.29초 뒤 stop·PP5/TG4074·cached77로 정상 완료됐다. 실제 content3,892자는 1부터1000까지 한 줄씩인 원래 요구와 정확히 일치했고 reasoning674자·두 메시지 이력이 남았다. **실제 GUI 스트리밍 취소·부분 보존·Retry/usage 범위 pass**다. raw `package17r1-strata-cancel-retry-native-verdict.json`과 해당 native 근거다. GUI의 기존 출력 제한과 앞선 CLI의 max1024는 다른 검사 조건이므로 원래 CLI A04와 산술32의 content fail을 바꾸지 않는다. native STOP/DONE wire acknowledgement도 이 결과로 확정하지 않는다.

### production17 정상 재시작·이력 재로드·로드 상태 종료

실제 GUI에서 Strata만 정상 언로드했다. 사전 관찰한 소유 프로세스4개가 종료되고 포트가 닫혔으며, 나머지 소유 식별자12개·개인 엔진/Whisper/gateway 포트는 그대로였다. 새 Strata staging도 없어지고 원래 두 markerless 로그 해시는 같았다. 같은 프로필로 다시 실행해 새 소유 식별자와 Ready를 확인했다. 재시작 전후 native Windows argv가 전체적으로 같았으며 원래 두 spec4·모델·context·KV 조건도 유지됐다. 같은 GUI 산술 질문은 `5`·PP74/TG45·stop이었다. 짧은 CLI 제한의 기존 실패를 변경한 결과는 아니다.

실제 대화 목록에서 이번17의 RAG·STT·승인 MCP 대화를 각각 다시 열었다. 답변·PP/TG가 각각229/231,124/160,82/70으로 복원됐고 세 저장 thread의 전체 해시가 기존 실행 기록과 같았다. 기존34개 프로필 전체 항목 해시를 유지하면서 총38개, 세션 정의6개를 보존했다. raw `package17r1-strata-only-normal-unload-verdict.json`, `package17r1-strata-restart-history-native-verdict.json`이다.

Strata·개인 엔진·Whisper와 gateway가 로드된 상태에서 원래 close-to-tray=false 설정의 정상 Close를 실행했다. 사전 관찰한16개 소유 프로세스의 종료, 포트4개 닫힘, 새 staging0개, 원래 두 markerless 로그 전체 해시를 확인했다. GUI/WebView의 일부 종료 객체에 열린 handle이 남아 있었으므로 단순 OpenProcess 성공을 생존으로 판정한 첫 검사는 보존했다. 실제 프로세스 종료 신호와 exit0 또는 error87로 구분했으며 검사 도구의 강제 종료는 없었다. **로드 상태 정상 Quit의 소유권/정리 범위 pass**다. raw `package17r1-loaded-normal-quit-owned-verdict.json`이다.

별도 종료 전 전체 파일 snapshot은 기존 help 경로2개가 홈 범위 밖으로 resolve되는 경계 검사에서 중단됐다. 다음 shell 명령의 정상 Close가 실행돼 그 snapshot을 종료 전후 전체 bytes 보존 근거로 사용하지 않았다. 범위 밖 원본은 읽거나 삭제하지 않았다. 기존 불투명 baseline의 config 외41개 파일·프로필34개를 다시 대조했고, 정상 종료 뒤 새로 고정한 범위 내113개 파일·프로필38개를 같은17 재실행 전후 대조해 변경0개였다. 범위 밖 두 항목은 제외 이유와 함께 보존했다. raw `package17r2-before-launch-data.json`과 재실행/native readback이다. 없는 종료 전 근거를 소급 생성하지 않는다.

### production17 기존 측정 이력·CSV/XLSX·공유 미리보기

같은17에서 원래16의 CPU/Qwen 완료 이력을 실제 선택했다. 원본 record SHA256 `c54af124d830965fb21eff1777c1c668035335210b4b6558827526c1225b545e`가 같았고, 실제 Windows 저장 창으로 새 CSV644바이트와 XLSX7,483바이트를 생성했다. CSV/XLSX의 열·값이 저장한 trial의 PP1024/TG128·지표와 정확히 일치했다. 공유 미리보기에서 모델/장치/조건/측정값 표시와 개인 경로·인증 정보 패턴 부재를 확인했다. 공개 게시·전송은 실행하지 않았다. **기존 측정의 재로드/내보내기·공유 미리보기 보존 범위 pass**이며 새17 benchmark 실행의 대체 근거가 아니다. raw `package17r1-benchmark-reload-export-native-verdict.json`이다.

현재 Strata 외부 process v1에는 정확한 tokenizer·cold-cache benchmark 절차가 없다는 실제 GUI 안내/비활성 실행과 `providers/adapter.rs`의 `RuntimeFeature::ExactBenchmark`, `performance_bench.rs`의 같은 계약을 확인했다. **이 정확 측정 절차만 unsupported**다. Strata의 일반 추론·usage·저장 이력/내보내기 지원을 부정하거나 원래 실패를 바꾼 판정이 아니다.

### D81: 모델 실행 전 preflight의 취소/진행 표시 누락

고정17에 별도 합성 엔진 `custom.synthetic-g17-races`/`race-44ef58ce13fd`를 등록했다. 빈 options manifest SHA256 `7a9ce04ca56c3d5c4263bde0d39b17556840df11a9ef095efb8876b87be76f2f`, fixture executable script `6caf2658f2ca080693ec999dd541ada9ef8fbc555607924bf5cc137d58692522`, spec `da25fb082142f619f9ce23a731610917da9b07897c5fcc6cdedcc17e19c02939`를 고정했다. help/probe 지연15초는 이 fixture의 동작이며 제품 timeout이나 원래 엔진을 바꾸지 않았다. 실제 pending help의 정상 Cancel은 새 소유 프로세스3개 종료·기존7개 보존·원래 지연 뒤 늦은 반환0개·미수락 상태로 한정 pass다. 첫 자연 완료 이후 도착한 취소 검사는 입력 전에 거부됐고 성공으로 계산하지 않았다. raw `package17r2-help-cancel-native-verdict.json`이다.

같은 실제 GUI에서 새 프로필로 모델A를 저장한 뒤 실행했다. 실제 preflight subprocess가 15초 대기하는 동안 설정 modal은 모델명·중지 상태·실행 footer만 표시했다. **취소 버튼과 진행 설명이 없어 사용자가 이 단계를 중단할 수 없었다.** native 검사는 취소 버튼0개를 확인해 입력하지 않았고, 검사 후 자연 완료한 preflight와 두 번째 시작 probe가 모델을 Ready로 만들었다. 이후 정상 언로드했다. 이것은 probe 취소 성공이나 플랫폼 unsupported가 아니라 **D81 제품 결함 fail**이다. raw `D81-preflight-cancel-red-native.json`, 해당 pending subprocess/GUI 근거를 보존한다.

원인은 `ModelSettingsProvider.persist`가 `preflightLaunch`를 먼저 기다리고 그 뒤에만 launching/cancel을 노출하는 순서와, backend `preflight_launch`가 취소 owner 없이 validation을 실행하는 계약이었다. 새 회귀 검사는 기존45개 pass/새1개 fail로 같은 누락을 재현했다. 요청별 취소·진행 표시·늦은 성공의 저장/실행 차단을 `cad44fd28819ad54f49ff9735cd0de8ca15f4006`에서 수정했다. 아래 production18의 실제 취소/복구 검증으로 연결한다. 고정17의 앞선 한정 pass를 새 수정 완료나 전체 goal 완료로 확대하지 않는다.


### D81 수정과 production18의 실제 취소·복구 검증

실행 전 검사 시작 전에 요청별 owner와 진행 상태를 노출하고 정상 취소 명령을 연결했다. backend는 같은 owner의 검사만 취소하며 기존 validation·readiness·해시 검증을 유지한다. 취소한 요청이 뒤늦게 성공해도 설정 저장이나 엔진 실행으로 이어지지 않는다. 기존 cfg-only IPC 호출은 호환된다. 엔진별 분기·모델·기본값·lockfile·timeout은 바꾸지 않았다.

자동 검사는 frontend202개 파일/2,150개 테스트·typecheck·lint, 전체 Rust 검사와 Clippy all-targets/경고 오류 처리·no-default-features·fmt를 통과했다. Rust library는1,137개 pass/기존 opt-in6개 ignored이며 bin/integration 검사도 통과했다. 별도 실제 Python entry point·positional/secret 여정2개도 pass다. 전체 frontend 검사 뒤 진행 문구만 기존 footer summary로 옮겼고 해당 Dialog72개와 ESLint를 다시 통과했다. ignored 검사를 모두 실행했다고 주장하지 않는다.

이 source에서 GUI·CLI·NSIS·MSI를 새로 빌드하고 원래17 복사본과 분리해 고정했다. source는 `cad44fd28819ad54f49ff9735cd0de8ca15f4006`, SHA256은 다음과 같다.

| 산출물 | production18 SHA256 |
| --- | --- |
| GUI | `a7095810b4c4a4fcb3883402582e220ffd8e5da0c5bda3201411fcb0dd0ad1b8` |
| CLI | `c54ba49f8427252060a84db3b17af72ec2f5280c7dc0ee581d6bf99ca26fe830` |
| NSIS | `6559650452b9b7684132529cdd961d5d4e6c9b401e24d047fc77ab46e40f464f` |
| MSI | `dadff4760716fe82f3a8d8fdbaca8cb56e7b1fd327339913a9680a86a8031ecf` |

최종 Tauri 빌드가 만든 동일 output directory의 GUI/CLI와 설치 패키지를 짝지었다. 이전 output directory의 오래된 GUI나 먼저 만들어진 별도 CLI를 새 최종 바이너리로 계산하지 않았다. 설치 패키지는 실행하지 않았다.

- **D81 원래 재현 경로 pass:**17에서 실패했던 같은15초 합성 preflight·모델A·argv 해시를 유지했다. 실제 검사 중 진행 문구와 취소가 나타났고, 정상 취소 후 새 소유 프로세스3개만 종료됐다. 기본 GUI7개·설정 전체 바이트·프로필40개·세션 정의6개가 같고 포트/Ready/늦은 반환이 없었다. 편집기와 재시도 경로가 유지됐다. raw `D81-production18-cancel-native-verdict.json`이다.
- **다른 모델로 복구 pass:** GUI에서 모델B를 선택하고 새 검증 프로필을 저장했다. 새로운 preflight와 시작 probe를 각각 실제 수행해 Ready가 됐고 Windows argv 두 곳이 정확히 B를 가리켰다. 실제 합성 SSE 응답은 저장한 옵션을 echo하고 TG4·stop·이력으로 완료됐다. cache breakdown이 없는 fixture의 PP는 unknown으로 유지했다. 정상 언로드 후 포트가 닫히고 기본7개/기존 staging 로그가 유지됐다. 기존 프로필40개 전체 항목을 보존하고 새 항목을 추가해41개다. 첫 검사 도구의 잘못된 PP 필수값 가정 실패도 보존했으며 실제 응답이나 저장 지표를 수정하지 않았다. raw `D81-production18-model-b-recovery-native-verdict.json`이다.
- **최소 창과 다른 실제 실행 대상 보존 pass:** 실제 client360×520 논리 픽셀/DPI192에서 진행 설명과 활성 취소 버튼이 화면 안에 보였다. 다른 실제 개인 엔진 세션을 실행한 채 같은 모델B 검사를 취소했다. 새 검사 프로세스3개만 종료되고 기존9개 생성 식별자·개인 엔진 포트/health가 유지됐다. 원래15초보다 긴343초 뒤에도 취소한 probe 반환이 없었다. 창 크기를 정상 복원한 뒤 Chat에서 이름으로 해당 개인 세션을 선택해 원래 산술 질문에 실제 `5`·PP34/TG2·stop을 받았다. 기본 서버는 중지됐고 다른 엔진의 PID/생성 시각/포트가 바뀌지 않았다. 취소 직후와 실제 답변 후 모두 설정 전체 바이트·프로필41개·세션 정의6개가 같다. raw `D81-production18-minimum-other-target-native-verdict.json`이다.

위 합성 probe/응답 성공과 개인 Qwen의 실제 추론 성공을 구분한다. 개인 executable/model은 앞선17의 같은 SHA256 `9ee4de40ecd8f10f5fc6f27084e1f758d5418de64ef39c8e28e5fcce6bb4f909`/`74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`이며 교체하지 않았다. D81 수정 범위는 pass지만 최종18의 나머지 Strata·공통 GUI/CLI·설치 패키지 검증은 아직 unrun이다. 원래 Strata/SmolVLM fail과 native STOP/DONE 확인 공백, W08 별도 OS 세션 차단을 유지한다. 전체 goal은 active다.


### production18의 실제 CLI·패키지·Strata 후속 검증

고정18 CLI의 격리 smoke를 통과했다. 같은 실제 개인 엔진과 원래 모델로 등록/probe·응답과 usage·실제 생성 취소·재시작·제거 후 시작 거부·재등록·정리·원본 파일 보존의 A01–A09를 모두 통과했다. 새 소유 probe 복사본만 변조한 별도 검사는 probe와 시작의 해시 불일치 거부·포트/staging 부재·제거·원본 복원/재등록·fresh probe까지 pass다. 원본 엔진·모델·helper를 변조하지 않았다. raw `package18-private-cli-observed/results.json`, `package18-private-integrity-cli/results.json`이다. CLI receipt의 checkout `b87e445`는 문서 추가 commit이고 실행 바이너리 source는 위의 `cad44fd`로 구분한다.

MSI는 read-only database/CAB 추출, NSIS는 앞서 digest 검증한 같은 작업용 7-Zip의 list/extract만 수행했다. 내부 CLI가 고정 CLI와 같고, GUI 전체 바이트는 Tauri2.11.4의 기존 `UNK→MSI`/`UNK→NSS` 표시3바이트를 반영한 예상값과 일치했다. 내부 GUI SHA256은 MSI `fce80231aabd62068cd9117a3a7b492061b9243a1078ba3e0472662177f6b68e`, NSIS `53f69a37bb44cff37385400de15dd741dd2007cd7619eb76dc486211fa098d48`다. 개인 절대 경로 패턴은0개고 원래 고정 파일은 유지됐다. **패키지 payload 출처/보존 범위 pass**이며 installer·추출된 executable·plugin·제거 동작을 실행하지 않았다. raw `package18-msi-payload-readonly/results-assessment.json`, `package18-nsis-payload-readonly/results.json`이다. W08 실제 설치/업그레이드/제거/OS 저장소 검사의 대체 근거가 아니다.

원래 Strata revision/model/deployment를 새 GUI에서 선택해 **G18 Strata original native validation**이라는 새 검증 프로필을 저장했다. 기존41개 전체 프로필 항목과 세션 정의6개가 같고 새 프로필의 settings/system prompt는 원래17과 정확히 같다. 실제 fresh probe→Ready→Windows native argv의 spec4·context131072·KV int8·resident32768→산술 질문의 실제 `5`·PP74/TG45·stop을 확인했다. probe accelerator의 `unverified`를 GPU 검증값으로 바꾸지 않았다. 다른 개인 세션의 프로세스 생성 식별자와 포트를 유지했다.

같은 Strata의 실제 생성 중 정상 Stop은 reasoning820자/content819자의 interrupted 부분 이력을 보존했다. 같은 원래 질문의 Retry는 추가 재시도 없이67.593초 뒤 자연 stop·PP5/TG8156·cache77로 완료됐고 저장 content3892자가1–1000의 원래 수열과 일치했다. 한 read-only 검사가25초 시점에 아직 실행 중인 요청을 완료로 가정해 실패한 raw도 보존했다. 실제 자연 종료를 관찰해 판정했으며 모델·답변·제한·timeout을 바꾸지 않았다. raw `package18-strata-cancel-retry-native-verdict.json`이다. 원래 CLI의 max1024 요청 실패와 native STOP/DONE wire 확인 공백은 유지한다.

Strata만 정상 언로드하자 소유 프로세스4개 종료·포트 닫힘·기존9개/개인 세션/원래 staging 로그 보존이 확인됐다. 같은 저장 프로필로 재시작한 새 native의 실제 Windows argv는 이전 native와 정확히 같았다. 다시 실제 `5`·PP74/TG45·stop이 완료됐다. 원래 모델 두 shard를 포함한6개 파일의 전체 해시도 다시 일치했다. raw `package18-strata-only-normal-unload-native-verdict.json`, `package18-strata-normal-restart-native-verdict.json`, `package18-strata-full-original-provenance.json`이다. 최종 loaded Quit와18의 새 등록/나머지 공통 GUI 검증은 별도다.

원래 production15 GUI가 내보낸 CPU bundle은 별도 SDK-free 새 홈에서63개 payload 해시를 확인하고 고정18 CLI로 실제 `5`/usage·정상 종료·포트/staging 정리까지 pass다. 처음 이전 debug import helper 해시를 그대로 적용한 검사는 실행 전에 정확히 거부됐다. 기존 실패를 보존하고 현재 source의 helper를 명시적으로 새 빌드/고정한 별도 실행을 사용했다. 이는 **현재 source debug helper의 import와 production18 CLI 실행 범위**이며 production18 GUI import 성공으로 계산하지 않는다. 원래 ZIP/모델/runtime은 바꾸지 않았고 W05 원래 미디어 실패도 유지한다. raw `package18-runtime-bundle-helper-pin.json`, `package18-original-cpu-portable-text-current-helper/results.json`이다.

Linux/Mac의 실제 preflight 취소·다른 대상 보존·늦은 반환·다른 모델 복구·최소 창/접근성·앱 종료 검사와 이후 공통 변경의 Windows 재검증은 [공통 후속 인계](engine-adapter-linux-macos-handoff.ko.md)의 D81 절로 연결한다. Windows 종료 commit과 전체 goal 완료는 아직 선언하지 않는다.


### production18의 실제 Strata solo STOP/DONE 확인

원래1024-token 요청의 실제 생성 중 취소에서 native 응답을 별도로 관찰했다. 첫 시도는 upstream의 `STRATA_BATCH_TRACE`를 켰으나 원래 batch0의 solo 경로가 그 로그를 사용하지 않아 실패했다. 그 뒤 관찰 도구의 물리 경로/별칭 경로 비교가 실제 callback을 놓친 실패도 보존했다. 두 시도 모두 정상 소유 프로세스·포트·staging 정리와 원래6개 파일의 해시를 확인했으며 제품 취소 실패나 unsupported로 바꾸지 않았다.

새 별도 진단은 실제로 등록/해시 검증한 관찰용 Python wrapper에서 원래 server source의 성공한 stdin flush 반환과 `_parse_done` 반환을 수동으로 조작하지 않고 기록했다. 앱·원래 bridge·server·native·모델 파일은 수정하지 않았다. 같은 소유 native PID에서 STOP 쓰기/flush가 반환한 뒤2.9998ms 후 `DONE 5 75 1094.1 51.2 cancel …`이 파싱됐다. 원래 solo·can_stop=true·max_new1024를 유지했고5토큰에서 끝나 generation 한도에 도달한 자연 종료와 구분된다. 실제 native argv는 원래 배포 설정과 정확히 같았다. 원래6개 파일 해시·정상4개 소유 종료·포트/staging 정리까지5개 항목이 pass다.

**이 별도 관찰 조건의 native STOP/DONE 확인 범위 pass**다. 이전 일반 GUI/CLI 실행을 소급해 wire 관찰 성공으로 바꾸지 않는다. 원래 A04/최종 content 실패와 요청 제한은 유지하며 성능 비교를 주장하지 않는다. raw `package18-strata-solo-native-stop-done-verdict.json`, `strata-adapter-acceptance/package18-solo-native-ack-path-observed/results.json`이다.

### production18 새 개인 엔진의 수동 등록·공통 GUI·실제 argv·응답

고정18이 모르는 같은 개인17 엔진의 옵션을 새 namespace `custom.personal-g18`/`private-g18`로 등록했다. 새18 엔진을 별도로 빌드했다고 주장하지 않는다. 고정18 GUI/CLI와 해당 binary source에 옵션이 없음을 확인한 뒤 실행 파일·표시 이름·ID를 직접 입력하고 실제 help255개를 읽었다. 모델/호스트/포트/제공 이름 binding·환경 변수 인증·probe18개 argv·hash 대상 helper·GGUF·원래 CPU0 prefix/cwd를 명시했다. prefix/파일을 추가하자 help를 새로 탐색했고, 검토한 manifest의 `options`는 비어 있었다. 실제 등록 후 해당 런타임의 모델별 fresh probe가 Ready를 결정했다.

고급 탭의 공통 옵션에서 새 값을 입력해 새 **G18 personal help options** 프로필로 저장하고 닫기/재열기에서 정확한 값을 확인했다. 처음 런타임·GPU 탭의 검색으로 옵션을 찾지 못한 것은 기존 탭 분류 때문이며, 실제 수락된 schema와 고급 탭에서 옵션·형식 미확정·help 근거를 확인했다. SaveAs의 일부 자동화 입력은 폼 효과가 확인되지 않아 성공으로 계산하지 않았다. 실제 native focus readback 후 정상 Return으로 폼을 열어 저장했다. 당시 자동화 한계로 분류했으나, 이후 합성 엔진에서 같은 현상을 조사해 아래 D82의 중복 blur commit 결함을 확인했다. 원래 저장/재열기/argv/응답 근거는 유지하되 첫 클릭 성공 근거로 계산하지 않는다.

실제 Windows argv에서 Unicode·따옴표·공백·세미콜론·ampersand가 있는 저장값은 정확히 하나의 인자로 전달됐다. 키가 argv에 없고 무인증 요청은401이었다. 원래 모델의 실제 산술 답변 `5`·PP34/TG2·stop을 확인했다. 이전42개 전체 프로필·세션 정의6개·production18 시작 전 이력/프로젝트/측정/MCP 파일53개의 전체 해시가 같다. 엔진별 Default와 새 검증 프로필을 추가해 총44개다. 원래 engine/model SHA256과 revision은 앞선 개인17 검증 그대로다.

정상 언로드 후 새 소유 프로세스2개 종료·포트 닫힘·기존 GUI7개·원래 staging 로그를 확인했다. **새 고정18의 수동 등록→실제 help→공통 GUI→새 프로필/재열기→실제 argv→실제 응답/인증→정상 언로드 범위 pass**다. raw `package18-personal-manual-gui-argv-response-native-verdict.json`, `package18-personal-normal-unload-native-verdict.json`이다. 새 post-pin 합성 엔진/버전 변경과 최종 종료 등 나머지 검사는 계속하며 전체 goal 완료를 뜻하지 않는다.


### D82: 옵션 편집 뒤 첫 프로필 저장 클릭이 유실되는 결함

고정 production18에서 공통 옵션을 편집하고 검증 완료 후 새 프로필 저장을 눌러도 폼이 열리지 않았다. 같은 설정을 유지한 채 프로필 탭으로 이동해 입력 포커스를 먼저 해제한 후에는 정상 native Invoke 한 번으로 폼이 열렸다. 이 우회는 입력값을 수정하거나 검증을 생략하지 않았다. 새 합성 프로필을 보존한 뒤 이전44개 전체 프로필과 저장 세션6개가 같은지도 확인했다.

원인은 공통 옵션 입력의 `onChange`와 `onBlur`가 같은 값을 각각 commit하는 것이다. blur가 새 cfg 객체를 만들며 이미 완료한 비동기 검증을 재시작하고, pointer down과 click 사이에 저장 버튼을 disabled로 바꾼다. 실제 설정 대화상자의 회귀 검사에서 입력→검증 완료→mouse down→blur→click 순서로 새 프로필 폼이 열리지 않는 red를 재현했다. 입력 변경에서 이미 수행한 파싱·commit을 blur에서 반복하지 않도록 input/textarea 두 경로만 수정했다. 검증·오류·Ready 조건을 제거하지 않았다.

같은 회귀 검사는 첫 클릭으로 폼 열기와 정확한 옵션을 가진 프로필 저장까지 통과했다. 관련 UI132개, 전체 UI202파일/2151개, typecheck, lint가 통과했다. lint는 기존 `CustomSelect`의 변경하지 않은 의존성 경고1개가 있고 오류는 없다. raw `d82-saveas-regression-red.log`, `d82-related-ui-green.log`, `d82-full-ui.log`, `d82-typecheck.log`, `d82-lint.log`와 native `gui/1792184785732-d82-after-safe-blur-saveas.json`, `d82-before-native-red-preserved-data.json`을 보존한다. **이 자동 검사 단계에서는 수정 후 production Windows 실제 클릭 재검증이 unrun이었다. 이후 production19 결과를 아래에 별도로 기록한다.** 기존18 결과를 수정 후 성공으로 소급하지 않고 전체 goal은 active다.


### production18 새 합성 엔진과 로드 상태 정상 종료

앱 고정 뒤 만든 별도 namespace의 합성 엔진을 실제 GUI로 등록했다. manifest 옵션은 비어 있고 실제 help에서1014개 옵션을 수락했다. 공통 GUI에서 새로운 문자열·명시적 false·0·999번 옵션을 입력해 새 프로필로 보존하고 재열기→fresh model probe→Ready→Windows argv→parser echo를 확인했다. 문자열/false/0/마지막 값이 정확히 전달됐고 TG4, PP 미확정, 무인증401을 확인했다. 실제 LLM 추론이 아닌 합성 parser 검증 pass다. 첫 SaveAs는 D82의 안전한 탭 blur 우회를 사용했으므로 첫 클릭 성공으로 계산하지 않는다. 이전44개 전체 프로필·저장 세션6개·기존 이력/프로젝트/측정/MCP 파일53개는 같다. raw `package18-synthetic-v1-gui-argv-echo-verdict.json`이다.

합성 엔진을 로드한 상태에서 정상 창 닫기로 전체10개 소유 프로세스 종료·포트49338 닫힘·새 staging 없음·기존2개 markerless 로그 보존을 확인했다. 실제 종료 직전의 유효한200개 persistent 파일 전체 해시·46개 전체 프로필·세션6개는 종료 뒤에도 같다. 기존 홈 밖으로 연결된 help 파일2개는 타깃을 읽지 않고 제외 사유를 유지했다. 첫 사전 검사는 명시적 SaveRun으로 자체 프로필 revision이1→2가 된 것을 전체 동일 조건으로 잘못 요구해 종료 전에 거부됐다. 변경 identity를 자체 프로필 하나로 확인하고 이전44개의 전체 해시는 엄격히 보존한 뒤 새 유효 기준을 기록하고 정상 종료했다. raw `package18-valid-before-loaded-final-normal-quit-data.json`, `package18-loaded-final-normal-quit-native-verdict.json`이다.

### production19 D82 실제 첫 클릭·개인 엔진·패키지 재검증

수정 source는 `4a7fa53daf595c36b5b0e50d26f12d5e61afaaf2`다. 원래 lockfile/도구/설정 입력7개와 검토한 code/test/doc3개 해시를 보존한 clean source에서 새 GUI/CLI/NSIS/MSI를332842ms에 빌드하고 별도로 고정했다. 이전17·18 pin은 바꾸지 않았다.

| production19 산출물 | SHA256 |
| --- | --- |
| GUI | `983a6f4f0175e90369d562ff9cfcfceedba0069c0be90d56d28e6221ea98b860` |
| CLI | `22be42ed12addb927d7ecffc603beb0b9a726e153f7198b32432c79a78fd1b3d` |
| NSIS | `330bf964e1b562777c258451b7073b72beec36bc20ec1fe22bad5c247264c441` |
| MSI | `9854b42cd121c12102dfa9c06d2064a95148b46df4318fed057ab055f028665d` |

새 stock Windows GUI를 같은 격리 홈에서 시작해 이전200개 파일 전체 해시·46개 전체 프로필·세션6개를 그대로 확인했다. 합성 flag와 개인 flag가 고정19 GUI/CLI/source에 없음을 검사했다. 실제 fresh help를 다시 탐색·수락하고 합성999번 옵션을 편집한 뒤 입력란의 실제 native 포커스와 검증 완료 상태에서 SaveAs를 **한 번만 pointer click**했다. 탭 blur 우회나 재클릭 없이 프로필 이름 폼이 열렸다. 새 **G19 synthetic first-click options** 저장·닫기/재열기·fresh model probe/Ready·실제 Windows argv·parser echo까지 같은 새 값을 확인했다. 이전46개 전체 프로필·세션6개·기존 persistent53개는 같았다. 합성 범위 pass이며 raw `D82-production19-synthetic-first-click-argv-echo-verdict.json`이다.

같은 실제 개인17 엔진/원래 Qwen 모델을 새19 개인 빌드라고 바꾸어 부르지 않고 검사했다. 빈 manifest 옵션과 fresh help255개를 사용하는 공통 입력에서 새 Unicode·따옴표·공백·메타문자 값을 편집한 후 **첫 pointer SaveAs**로 바로 폼을 열었다. 새 **G19 personal first-click options** 저장·재열기·fresh probe/Ready·정확한 단일 Windows 인자·실제 답변 `5`·PP34/TG2·stop·무인증401을 확인했다. 원래 engine/model/probe/helper4개 전체 해시와 이전46개 프로필·세션6개·기존53개 파일을 보존했다. 실제 추론 범위 pass이며 raw `D82-production19-personal-first-click-argv-response-verdict.json`이다. 프로필은 자체 신규2개가 추가돼48개다. 두 엔진을 각각 정상 언로드해 GUI 기본7개/엔진 listener 없음까지 관찰했다.

고정19 CLI smoke와 같은 실제 개인 엔진의 A01–A09는 모두 pass다. 관찰용 local harness의 자식 창만 숨겼고 질문·모델·응답·제한·timeout은 바꾸지 않았다. raw `package19-private-cli-observed/results.json`이다. NSIS/MSI는 설치나 추출 exe 실행 없이 payload를 읽었다. 전체 예상 GUI bytes와 정확한3-byte 패키지 표식 차이, CLI 고정 bytes 일치·개인 절대 경로 검색0개를 확인했다. 패키지 GUI의 전체 SHA256은 MSI `90b568b64a6090abe72695ba8a9cc1821f7bbb1a71ce43afbc3c0e66db1b913e`, NSIS `77dcf1f64b0cf843dc27b1c991674d77e4009c207f3c9c8a07d5282718d037b1`이다. raw `package19-msi-payload-readonly/results-assessment.json`, `package19-nsis-payload-readonly/results.json`이다. 이는 W08 실제 설치/업그레이드/제거/Vault의 대체가 아니다.

**D82는 자동 회귀와 수정 후 production19의 합성·실제 개인 엔진 첫 클릭/저장/재열기/argv/응답 범위 pass다.** 런타임 v2 변경·잔여 관련 흐름·최종 종료/인계 검사는 계속한다. 원래 Strata CLI/미디어 content 실패와 별도 OS 계정이 없는 W08 blocked/unrun을 보존하며 전체 goal이나 Windows 종료 commit을 아직 complete로 선언하지 않는다.


### production19 같은 runtime의 v2 변경·미해석 값·명시 복구

같은 `custom.synthetic-g18`의 같은 runtime ID를 v2로 명시적으로 재등록했다. 원래 v1 엔진/fixture 파일과 수락된 help cache는 보존했다. 같은 고정19 GUI에서 오래된 help 경고가 나타났고 정상 실행 시도는 backend의 entry point 불일치 검사에서 거부됐다. 당시 버튼은 enabled였으므로 UI disabled로 거부했다고 기록하지 않는다. 실제 거부 화면은 저장값을 유지했다고 알렸으며 새 엔진 프로세스/포트는 없었다.

원래 help 작업 디렉터리의 자체 override를 비워 새 등록의 실행 문맥으로 다시 탐색했다. 새 옵션·사라진 옵션·count arity 변경 diff를 검토/수락하자 사라진 text 값과 불충분한 count가 경고와 함께 남았다. 자체 새 draft에서만 제거/복구했고 기존 프로필을 고치거나 버리지 않았다. count 두 값 `[0,7]`, 새 문자열, 명시적 false, 반복 tuple `[[1,2],[3,4]]`, 복수 문자열, 값 없는 optional, choice를 공통 GUI로 설정했다. repeat 정보는 help가 확정한 것으로 꾸미지 않고 명시적 사용자 확인으로 기록했다. 새 **G19 synthetic v2 recovery** 저장·재열기→fresh model probe/Ready→두 Python 프로세스의 실제 Windows argv→parser echo가 일치했다. 원래 v1 모델 경로/bytes·8개 fixture 전체 해시·이전48개 전체 프로필·세션6개를 보존했다. 새 프로필까지49개다. 새 help fingerprint는 `2d8307a281a4f21dbb9178e1ab68c4f9bafe7aaa337ca85001234bc36e9abcce`이며 원래 v1 cache도 전체 bytes가 같다.

앱 재빌드 없이 수행한 **합성 parser 범위 pass**다. 실제 LLM 추론으로 계산하지 않는다. 첫 전송 계획은 runtime 화면에서 새 채팅 버튼을 찾지 못해 전송 전에 거부됐고, 정상 채팅 이동 뒤 한 번만 요청했다. 무인증401·정상 언로드 후 기본7개/포트 없음도 확인했다. raw `package19-before-runtime-v2-data.json`, `package19-synthetic-v2-argv-echo-verdict.json`, `package19-v2-after-normal-unload-owned.json`이다.

### production19 원래 Strata와 로드 상태 종료

원래 Strata revision `296b59d2f73c8f04a805df29c2fa97655adace78`/0.1.44.1과 원래 두 모델 shard revision `5348543e0147355ac9cbcb031184a3546350988e`를 유지했다. 모델59GB를 포함한 원래6개 파일의 전체 해시를 다시 확인했다. 새로운 **G19 Strata original native validation**의 설정/prompt는 기존18 프로필과 정확히 같고 실제 Windows native argv도 이전18과 정확히 같다. 원래 GPU0/HIP·spec4 두 회·minp0.5·context/KV·모델·제한을 바꾸지 않았다. probe의 accelerator 표시는 계속 unverified이며 Ready나 실제 응답을 근거로 그 표시를 임의 확정하지 않는다.

fresh probe/Ready 이후 원래 질문의 실제 최종 답변 `5`·PP74/TG45·stop·무인증401을 확인했다. 이전49개 전체 프로필·세션6개·기존 이력/프로젝트/측정/MCP53개 파일은 같다. 새 프로필까지50개다. 이 범위는 **최종 관련19의 실제 Strata 설정/실행/응답 보존 pass**이며 원래 제한32/1024의 CLI content 실패를 덮지 않는다. 이전18 생성 취소/같은 질문 Retry와 별도 native STOP/DONE 진단은 해당 source/조건으로 유지한다. raw `package19-strata-full-original-provenance.json`, `package19-strata-original-profile-argv-response-verdict.json`이다.

Strata를 로드한 채 정상 창 닫기로 전체11개 소유 프로세스 종료·bridge55471 닫힘·새 staging 제거를 확인했다. 실제 종료 직전206개 persistent 파일 전체 해시·50개 전체 프로필·세션6개는 같다. 현재 소유 staging4개 파일은 ephemeral로 구분했고 기존 marker 없는2개 로그와 홈 밖 help2개 타깃 보호는 유지했다. 강제 kill은 없었다. raw `package19-valid-before-loaded-normal-quit-data.json`, `package19-loaded-normal-quit-native-verdict.json`이다.

### production19 새 홈의 실제 GUI CPU bundle 가져오기

이전19 창을 정상 종료한 뒤 별도 새 앱/WebView 홈에서 같은 고정19 GUI를 시작했다. 기존 설정·runtime·사용자 이력을 복사하지 않았다. 언어/테마/모델 폴더의 최초 설정을 GUI에서 완료했다. 자식 PATH는 Windows/System32만 사용하고 SDK 환경 변수를 제외했다. `cl`, `cmake`, `hipcc`, `nvcc`를 자식 환경에서 찾을 수 없음을 확인했다. **호스트의 SDK 파일을 제거했다거나 별도 OS 계정이라고 주장하지 않는다.**

production15 GUI가 내보낸 원래 CPU ZIP `4cb6f6bd4602facbc1ac9818aeef378e666c63fe69756e7f24f9837f0c9d428f`를 새19의 실제 ZIP 가져오기 버튼/소유 파일 선택기로 가져왔다. debug helper나 CLI import로 GUI 동작을 대신하지 않았다. CPU b11617/원래 revision `14310190cd0a0c831fe949ac8cbedd8abdc90695`의63개 payload 전체 해시가 일치했다. engine SHA256은 `715f0ea98819f03fc596e9d352e989fc0ae093056282e0d73b2d657e7afa7d02`다.

원래 Qwen0.5B 모델 revision `9217f5db79a29953eb74d5343926648285ec7e67`/SHA256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`를 그대로 선택했다. 앞선 CPU text 대조와 같은 ngl0/threads4를 GUI로 지정했다. 편집된 numeric Spinner에 실제 포커스를 둔 뒤 첫 pointer SaveAs로 새 **G19 SDK-free original CPU**를 저장하고 재열기·저장값·실제 argv를 확인했다. fresh probe/Ready→실제 답변 `5`·PP34/TG2·stop·무인증401을 확인했다. 별도 CPU text 검증이며 W05 원래 media 실패를 다른 모델로 바꾼 성공이 아니다.

CPU를 로드한 상태에서 정상 창 닫기로 소유9개 종료·51940 닫힘·staging 없음·새 홈66개 파일 전체 해시/프로필4개/저장 세션0개 보존을 확인했다. 기존 주 검증 홈의206개 파일·프로필50개·세션6개도 그대로다. raw `package19-sdkfree-fresh-gui-launch.json`, `package19-sdkfree-gui-import-profile-inference-verdict.json`, `package19-sdkfree-loaded-normal-quit-native-verdict.json`이다. **최신 production GUI의 새 홈 bundle 가져오기/실제 추론/정상 종료 범위 pass**이며 설치/업그레이드/제거·Vault 검사는 대체하지 않는다.

### production19 기준 W/G 판정과 남은 완료 조건

아래 표가 앞선17의 잔여 표를 갱신한다. 제품 source는 `4a7fa53daf595c36b5b0e50d26f12d5e61afaaf2`이며 이후 제품 Rust/GUI는 바뀌지 않았다. 뒤의 D83은 CLI 수락 검사·회귀 검사·문서 변경이다. `package19-preservation-source-boundary-audit.json`에17 이후 D81/D82 변경 파일과18 이후 Rust tree 동일 근거를 고정했다. 변경되지 않은 MCP/RAG/STT/gateway/media/측정·공유·이력/CSV/XLSX/저장 schema의 실제16/17 결과를19에서 전부 반복했다고 바꾸지 않는다. D81은18의 pending 취소/모델 복구/최소 창/다른 실제 엔진 보존, D82는19의 합성·실제 개인·수치 입력 첫 저장과 관련 실행·데이터 보존으로 재검증했다. pass는 해당 Windows 경계의 판정이며 전체 goal/모든 OS 완료가 아니다.

| ID | 판정 | 실행 근거와 남는 범위 |
| --- | --- | --- |
| W01 | pass | 원래 환경/공통20명령 기준,18 Rust 전체/opt-in/Clippy·no-default·fmt와2150 UI, D82 관련132/전체202파일2151 UI·typecheck·lint,19 production 네 target/CLI smoke·실제 CLI9항목. D83 검사 수정의 스크립트43개·관련 lint/typecheck도 pass다. 제품 Rust/GUI tree는 동일하다. 기존 전체 lint 경고1개와 opt-in ignore의 실제 범위를 유지한다. |
| W02 | blocked | 합성 migration/backup/미등록 engine 값/미래 schema 거부와 실제18→19 전체200파일 보존, 새19 GUI onboarding은 pass. 이후 별도 VM의 Windows 바탕화면 진입을 확인했으나 관리자 권한 준비 요청이 취소되어, 설치 전 체크포인트·파일 전달·실제0.2 이전/자격 증명 검사는 아직 blocked/unrun이다. 아래 VM 재개 기록을 따른다. |
| W03 | pass | 원래 CLI 등록/변조/제거/재등록,18 D81 실제 취소·늦은 반환/다른 모델 복구·다른 엔진 보존,19 미지 개인 엔진과 합성 v1/v2의 fresh help/probe·diff·미해석 값 복구·실제 argv 근거. 합성 echo와 실제 추론은 분리했다. |
| W04 | fail | 원래 Strata CLI A03/A05/A07의 제한32 최종 content 실패는 유지한다. A04의 원래1024 요청에서 취소 trigger에 도달하지 못한 기록은 보존하며, D83에서 원인을 검사 코드의 content 전용 trigger로 재현·수정하고 같은 요청의 실제 reasoning 출력 후 abort/서버 정상 상태를 pass로 추가했다. 실제 CPU/Vulkan/지원 ROCm·개인 엔진·Strata의 source별 추론/usage·생성 취소/Retry/restart와19 실제 개인/원래 Strata/CPU bundle 응답·로드 상태 정상 종료는 한정 pass다. 모델/제한/정답을 바꾸어 원래 답변 실패를 닫지 않는다. |
| W05 | fail | 원래 SmolVLM 내용 실패/같은 body 대조 실패는 유지한다. actual source별 첨부 순서·전달/저장/재로드,17 실제 MCP 거부/승인/입력과 다른 반환값 후속/호출 취소는 한정 pass다. 이후 해당 feature/프로토콜 코드는 바뀌지 않았다. |
| W06 | pass |17 실제 프로젝트/RAG·BGE·Whisper STT·역할별 멀티 세션·gateway401/라우팅/task 거부·이력/CSV/XLSX/공유 미리보기 근거 유지. 관련18 owner 취소/다른 엔진 보존,19 기존53개 feature 데이터와50개 전체 프로필/세션6개 및 실제19 실행/종료 보존으로 변경 경계를 확인했다. 모든 기능을19에서 다시 실행한 의미는 아니다. |
| W07 | pass | 원래12 markerless staging 실패는 보존하며 수정된 source의 새 소유 staging 정리와 구분한다. source별 install/build/help/probe/load/stream/tool/benchmark/import 실패·취소·Unicode/공백/긴 경로·shell 없는 argv,18 다른 엔진 보존과19 두 홈의 실제 loaded Quit/소유20개 종료/포트/staging/기존 로그·데이터 보존 pass다. |
| W08 | blocked |19 네 target·MSI/NSIS 읽기 전용 전체 payload/개인 경로 검사·실제 GUI 새 홈 CPU ZIP import/실제 추론/종료는 pass. source별 IME/clipboard/picker/tray 근거는 보존한다. 이후 새 VM의 바탕화면과 원래0.2 공식 설치 파일/업그레이드 식별자를 확인했다. VM 관리자 준비는 권한 요청 취소로 미실행이며 실제 upgrade/remove/최초 OS 계정 실행·Credential Manager·설치 identity의 OS 통합/알림도 아직 blocked/unrun이다. |
| G01 | pass | versioned sourced schema/descriptor와 실제19의 앱이 모르는 빈-options 엔진이 공통 표시·검증·새 프로필·실제 argv·응답으로 연결된다. 기존 내장/외부 데이터 계약과 미확정 사실의 구분을 보존했다. |
| G02 | pass | 소유 help/probe의 제한·취소·cache/identity/늦은 반환 자동 검사,17 실제 help Cancel/탭 context 종료,18 pending preflight 취소/다른 모델 복구,19 같은 ID v2 stale/정상 실행 거부/fresh 탐색/diff 근거. |
| G03 | pass | parser·명시 metadata/encoding/locale·민감 값·예약 옵션/arity/alias/scope의 source별 자동/실제 근거,19 알려지지 않은 타입 표시·삭제값 보존·명시적 반복 확인·변경 arity 복구. help에서 API 능력을 추정하지 않았다. |
| G04 | pass | 같은 renderer/검증/serializer의19 first SaveAs·재열기·false/0/quoted Unicode/arity2/반복 tuple/복수 값/optional·기존 순서/alias 근거. D82 실제 red→수정→2151 자동/두 미지 엔진·numeric 실제 재검증을 연결했다. |
| G05 | pass |18 실제 수동 entry point/help/명시 binding/protocol/probe 등록과19 같은 개인 엔진의 fresh help/Ready/실제 응답,19 같은 ID v2 명시 재등록/복구,원래 native Strata bridge/실제 응답/정상 종료. 공통 기능에 새 engine ID 분기는 추가하지 않았다. |
| G06 | pass | 중립 목록/검색/Add 동선과 내장 adapter 표시, 실제 사용자 등록·모델/프로필 여정,17 D79/D80 세 역할 이름/연결/미저장 보호·공통 기능,19 기존 전체 데이터 보존과 실제 새 홈 onboarding/bundle 여정을 확인했다. |
| G07 | pass | source별 재현 결함/수정/재검증과16 긴 wizard·접근성 tree/키보드·작은 창,18 최소 창 pending 취소/타 엔진 보존,19 1000개 옵션 검색/999번 편집·미지 개인 엔진·D82 첫 클릭·v2 실패 복구를 실제 관찰했다. 계측 native INP나 전체 OS 접근성 인증을 주장하지 않는다. Linux/Mac 실제 검사는 후속 범위다. |

Windows native 미지원인 MLX/표준 vLLM/Metal, 외부 v1의 정확 tokenizer/cold-cache benchmark·CPU reference deep·ABI portable은 실제 플랫폼/계약 근거 범위에서만 unsupported를 유지한다. 원래 지원 내용의 실패를 unsupported로 바꾸지 않는다. W04/W05 원본 실패와 W02/W08 필수 OS 검사가 남아 있으므로 **goal complete와 Windows 종료 commit을 지정하지 않는다.** 제품 결함 D81/D82의 수정 및 현재 실행 가능한 관련 검증을 마쳤다는 것과 전체 완료는 구분한다.

W02/W08은 원래 PC의0.2 설치/사용자 Vault를 보존한 별도 Windows 테스트 환경과 합성 이전 데이터를 사용한다. 이전의 환경 제공 불가 상태는 아래 새 VM 재개 기록으로 갱신한다. 원래0.2와 고정19 installer의 버전/전체 해시를 확인하고, 새 설치와0.2→19 업그레이드를 각각 깨끗한 OS 스냅샷에서 실행한다. 새 설치→같은 원래 모델 응답/저장/재로드→정상 종료와, 원래0.2 설치/합성 이전 데이터 생성→고정19 실제 업그레이드→같은 모델 응답/데이터·자격 증명 보존을 구분한다. 설치 identity의 OS 통합/알림과 제거/잔여 데이터 정책을 NSIS/MSI별로 기록한다. MSI는 컴퓨터 전체 설치이므로 기존 PC에 계정만 추가해 실제 업그레이드/제거를 수행하지 않는다. 최신 source가 달라지면 영향받는 W/G를 재검증한다. Linux L01–L04 및 Mac M01–M04/R01–R13은 별도 인계의 구체 작업으로 남기며 Windows goal의 실제 기기 완료 조건으로 추가하지 않는다.

### D83 — reasoning 생성 취소와 독립적인 CLI 검사 계속 실행

검사 구현과 회귀/계약 문서는 `fdb48af66d66dff3f4b607c11ee28ba7c61830f0`에 고정했다. 제품 source4a와 고정19 네 binary hash는 그대로다. 아래 최초 D83 실행은5e79643 위의 검사 WIP에서 수행했으며 각 raw의 dirty 상태와 파일 hash를 보존했다.

마지막에는 같은 원래 Strata를 **커밋된 검사 코드 그대로** 다시 실행했다(`d83-strata-committed-native/`). reasoning2문자/content0에서 취소·서버 running/health true, A01/A02/A04/A06/A08/A09 pass, A03/A05/A07의 원래 답변 fail/전체 exit1이 재현됐다. 실제 검사 파일 hash는 main `8cf61aa5087a84ab0600d67abb50f0e29d54f399922f92e49c35a1c6979c7746`, reader `c7ccfb8c0b70e7829b8caf88ba249e2cdc53795a6883e7cd73d28b867a6b8013`, 공통 parser `196aa9dda7da64e127f6b8134912ecaa929a1b7808a3b7144a76721b8eff9f3f`다. source dirty는 당시 결과/인계 문서와 새로 생성된 bytecode이며 검사/제품 소스는 커밋과 같았다. 소유 port의 bridge와 자손을 생성 식별자로 관찰해6개가 정상 정리된 것도 별도 확인했다(`d83-committed-native-descendants.json`). 처음부터 모든 세대의 모든 subprocess를 관찰했다고 확대하지 않는다. 원래6개 파일 전체 hash도 다시 전후 대조했다.

재개 후 원래 CLI 실패와 검사 코드를 다시 대조해 수락 검사 결함을 발견했다. reader는 content만 출력으로 취급해 reasoning 중 취소하지 못했고, 취소하지 않은 채 EOF에 도달하면 숫자 나열 요청에도 산술 정답 검사를 적용했다. 또한 A03 답변 실패가 독립적인 A04–A07 실행까지 중단했다. 앱/엔진 결함과 구분한 **검사 코드 결함**이다.

공통 SSE parser의 reasoning/content를 구분해 실제 생성 출력 후 abort하도록 수정했다. reasoning은 문자 수만 기록하며 최종 답변에 합치지 않는다. 출력 없는 종료·이미 받은 finish reason/DONE·잘못된 SSE를 취소 성공으로 만들지 않는다. 선행 provenance/등록/Ready/정상 제거 조건을 보존하면서 독립 검사를 계속하고, 원래 실패와 전체 nonzero exit를 유지한다. 결과에 검사 스크립트·reader·parser의 파일 hash도 추가했다. 질문·model·stream/usage 설정·32/1024 토큰 한도·산술/authoritative usage 검사는 변경하지 않았다.

- 자동 회귀: 수정 전 9개 중7 fail/2 pass, 수정 후9 pass. reasoning 두 표현·content·미출력 종료·finish reason/DONE·잘못된 SSE·분할 Unicode/EOF·실제 loopback HTTP 연결 조기 종료/서버 재사용을 검사했다. 전체 `test:scripts`43 pass, 관련 lint/typecheck pass다.
- 별도 합성 오답 fixture: 수정 전 A03에서 중단, 수정 후9항목 모두 기록했다. A03/A05/A07 오답은 fail, A04/A06/A08/A09는 pass이며 전체 exit1이다. 이는 추론 성공이 아니다. 시작에 실패한 기존 인증 필수 fixture는 A04/A05를 이유 있는 unrun으로 기록했고, 의도적으로 틀린 provenance는 등록/실행을 거부했다. 기존 fixture나 원본 실패를 고쳐 성공시키지 않았다.
- 실제 Strata: 고정19 CLI SHA-256 `22be42ed12addb927d7ecffc603beb0b9a726e153f7198b32432c79a78fd1b3d`, 원래 manifest SHA-256 `9dd5ba78428cdf9eb2af8f15d10fcf586b16332e279978bb150b388f6036a0b4`, 엔진 revision `296b59d2f73c8f04a805df29c2fa97655adace78`, 모델 revision `5348543e0147355ac9cbcb031184a3546350988e`를 그대로 사용했다. A04는 reasoning2문자/content0에서 HTTP abort, 뒤의 status `running`/health true로 pass다. A01/A02/A06/A08/A09도 pass, 원래32토큰 산술 A03/A05/A07은 fail로 남아 전체 exit1이다. 외부6개 파일 전체 hash를 전후 대조했다. 이 실행의 HTTP abort와 기존18의 별도 native STOP→DONE ACK 근거를 합쳐 같은 실행의 wire ACK라고 부르지 않는다.
- 실제 개인 엔진: 원래 엔진 SHA-256 `9ee4de40ecd8f10f5fc6f27084e1f758d5418de64ef39c8e28e5fcce6bb4f909`, 모델 revision `9217f5db79a29953eb74d5343926648285ec7e67`, 수정 전부터 사용한 올바른 probe manifest를 사용해9항목 pass/exit0이다. 산술 응답 `5`/usage와 content 생성 중 취소, 정상 재시작·제거/재등록·정리를 실제 확인했다.
- 격리 홈에서만 실행했으며 주 검증 홈206개와 별도 SDK 검사 홈66개 기존 파일 hash를 다시 확인했다. Python isolated 실행이 새로 만든 helper bytecode는 원본 hash/생성 시각과 함께 tmp에 보관하고 소스 트리의 해당 생성물만 정리했다. 기존 로그·fixture·설정·이력·모델·고정19 binary는 보존했다.

raw는 `d83-adapter-cancellation-{red,green}.log`, `d83-test-scripts.log`, `d83-eslint-green.log`, `d83-typecheck.log`, `d83-negative-failfast-red/`, `d83-negative-final-source/`, `d83-start-failure-prerequisites/`, `d83-provenance-refusal/`, `d83-strata-original-native/`, `d83-private-original-native/`, `d83-prior-gui-data-preservation.json`이다. 검사 변경은 생산 GUI/CLI 제품 source4a나19 binary를 바꾸지 않으며 새 GUI 실행 결과로 계산하지 않는다. W04/W05의 남은 답변/미디어 fail과 W02/W08의 실제 OS 계정 blocked 판정은 유지한다. 독립적인 D83 작업을 수행했으므로 이전 blocked 연속 횟수를 이어 붙이거나 goal을 완료로 바꾸지 않는다.

### W02/W08 재개 준비 — 새 VM 바탕화면 확인, 관리 권한 준비 미실행

사용자가 Hyper-V VM을 만든 뒤 goal을 active로 재개했다. 실제 VM 연결 창과 Hyper-V 관리자에서2세대를 확인했고, 설치 화면을 지나 게스트의 Windows 바탕화면/설정 화면에 진입한 것을 관찰했다. 호스트 foreground 프로세스가 VM 연결이며 호스트 설정 앱은 실행 중이 아님을 확인해 게스트 화면과 구분했다. 이 관찰은 VM의 OS build·CPU/RAM·WebView2·TPM 조회나 설치 수락 결과를 대신하지 않는다. 원래 PC의0.2.0 설치도 읽기 전용으로 확인했으며 해당 앱이나 설치 프로그램·Vault를 실행하지 않았다.

공식 [v0.2.0 release](https://github.com/aiolm/AioLM/releases/tag/v0.2.0)에서 NSIS/MSI와 checksum을 내려받아 GitHub 배포 metadata의 byte 수/SHA-256와 대조했다. NSIS는 `f680d9b59793db0d3983b1f5df01088b222d25dfc3b1d1fb00395bf1f76e9b21`, MSI는 `cd1f9cf999f2626719d423d2a62e62ea7ec4b430039511dc05926ac952a2d40d`다. 원래0.2 MSI와 고정19 MSI를 Windows Installer `OpenDatabase` mode0으로 읽어 각각0.2.0/0.3.1, 같은 UpgradeCode·서로 다른 ProductCode·양쪽 `ALLUSERS=1`을 확인했다. 실제 설치/업그레이드 성공이 아닌 정적 선행 근거다. MSI의 컴퓨터 전체 범위 때문에 새 사용자 계정만으로 호스트의 기존 설치를 격리할 수 없으며, 실제 수락은 별도 VM/기기에서 진행한다.

고정19 GUI/CLI/NSIS/MSI, 원래 CPU bundle과 같은 원래 Qwen 모델의 전체 hash를 다시 확인하고, 원래0.2 설치 파일 및 읽기 전용 게스트 preflight를 합쳐11개 전달 파일을 준비했다. 준비 스크립트의 범위는 정확한 테스트 VM 확인→새 설치 전 체크포인트 생성→새 전용 폴더로 파일 복사다. 복사에 필요한 해당 VM의 guest file-copy 통합 서비스만 임시 사용하고 원래 상태로 되돌리며, 설치 프로그램/게스트 명령은 실행하지 않는다. 게스트 preflight는 전달 파일 hash·OS/CPU/RAM/graphics/WebView2·기존 AioLM 설치 여부를 실제 VM에서 확인하도록 준비돼 있다. 실행하지 않은 항목은 pass로 계산하지 않는다.

첫 직접 `Get-VM` 조회는 Hyper-V 관리 권한 부족으로 거부됐고 최초 RunAs는 취소로 종료했다. 이후 명시적 재개에서 관리자 준비가 실제 실행됐다. 준비 코드의 존재하지 않는 `Get-VMTPM` 호출로 첫 실행이 중단됐으며, 그때 체크포인트·복사는 시작되지 않았음을 결과로 확인했다. 실패 기록을 보존하고 설치된 공식 `Get-VMSecurity`의 `TpmEnabled` 조회로 수정한 별도 실행은 성공했다. 이는 준비 검사 코드 수정이며 제품 수정이 아니다.

실제 VM은 실행 중인 generation2·16 vCPU·할당 RAM16GiB였으며 가상 TPM은 활성 상태였다. 현재 `Standard` 정책을 바꾸지 않고 새 설치 전 체크포인트를 생성했다. 고정 전체 hash를 확인한11개 파일을 새로운 전용 게스트 폴더로 복사했고, 해당 VM의 file-copy 통합 서비스를 원래 비활성 상태로 복원했다. 이 host-to-guest 복사 성공은 게스트 hash 확인 또는 설치 성공을 뜻하지 않는다. 실제 근거는 raw `vm-acceptance/<run-id>/admin-preparation-{result,attempt2-result}.json`과 attempt2 이벤트 기록이다.

게스트 preflight는 이후 실제 실행해 **pass**를 확인했다. 원래 실행 정책의 파일 실행 거부를 먼저 관측하고, 검토한 로컬 파일에 대해 새 PowerShell 프로세스의 `RemoteSigned`만 적용했다. 사용자/시스템 정책은 바꾸지 않았다. Hyper-V 가상 키보드 API로 명령을 전달했으며 화면의 실제 출력과 별도 요약을 대조했다. payload10개의 전체 SHA-256 대조가 통과했고 기존 AioLM 설치0개·프로세스0개·기본 데이터 폴더 없음이었다.

| 게스트 환경 | 실제 관측값 |
| --- | --- |
| OS | Microsoft Windows11 Home, `10.0.26300`, build26300, x64 |
| CPU | AMD EPYC4585PX16-Core Processor, 게스트8 cores/16 logical processors |
| RAM | OS가 보고한 `16776084`KiB; Hyper-V 할당16GiB |
| Graphics/driver | Microsoft Hyper-V 비디오, `10.0.26100.1150` |
| PowerShell/WebView2 | `5.1.26100.9711` / `155.0.4283.62` |

raw `vm-guest-preflight-attempt2-readback.json`, `vm-preflight-verified-summary.json` 및 게스트 전용 폴더의 `guest-preflight.json`이다. 이후 원본 JSON을 Hyper-V 내부 네트워크의 한정된 임시 receipt 수신기로 회수해 전달 목록의10개 hash와 다시 대조했다. 방화벽·네트워크 정책은 변경하지 않았다. `vm-acceptance/<run-id>/guest-receipts/001-preflight.json`이 원본이며 별도 transport receipt에 수신 bytes/hash를 남겼다.

고정19 NSIS의 실제 새 설치 완료→설치 마법사의 Run AioLM→최초 onboarding→한국어·시스템 테마→원래 Qwen이 있는 검증 폴더를 실제 picker로 선택→채팅 화면 진입까지 **한정 pass**다. 설치된 GUI 전체 SHA-256은 `77dcf1f64b0cf843dc27b1c991674d77e4009c207f3c9c8a07d5282718d037b1`, CLI는 `22be42ed12addb927d7ecffc603beb0b9a726e153f7198b32432c79a78fd1b3d`로 앞서 읽기 전용 추출한 고정19 NSIS payload와 일치한다. 두 파일의 실제 version은0.3.1이고 설치된 CLI의 `--help`는 exit0/JSON 반환이다. 원래 홈이 없던 게스트에서 기본 `.aiolm` 생성과 설치 경로의 실제 GUI 프로세스를 확인했다. raw `002-fresh-nsis-installed.json`, `vm-fresh-nsis-install-result-ui.json`, `vm-fresh-main-after-onboarding.json`이다.

**이 설치본의 실제 추론/저장·재로드/정상 종료·업그레이드/제거/자격 증명/설치 OS 통합의 수락 판정은 아직 남아 있다**. 이후 NSIS/MSI 업그레이드를 별도 시나리오로 수행한다. 호스트의 원래0.2 설치·설정·Credential Manager는 변경하지 않았다. 키 입력 도구의 호출 성공만으로 명령 실행을 판정하지 않는다.

raw는 `vm-resume-*.json`, `vm-official-releases.json`, `vm-active-preparation.json`, `vm-acceptance/<run-id>/payload.json`, `original-msi-upgrade-identity.json`, `vm-prepare-admin-canceled.json`, `vm-original-host-install-before.json`, `vm-original-host-protected-hashes-corrected.json`이다. 원래 호스트 설치 경로의 인용부호 처리에 실패한 최초 부분 baseline도 보존하고, 수정된 읽기 전용 검사에서 원래 GUI와 기존 설정2개 전체 hash를 기록했다. 제한된 baseline이며 전체 개인 기록을 복제·검사했다고 주장하지 않는다. 준비 파일/스크립트·계정/기기 정보·화면·host 경로는 tmp에만 보존하고 커밋하지 않는다. 제품 source4a/고정19 binary와 D83 검사는 바뀌지 않았고 기존 W04/W05 내용 실패도 유지한다. 새로운 재개 실행이므로 이전 blocked 연속 횟수를 재사용하지 않는다.


## D84 작은 Windows 화면의 최초 창 배치 수정과 production20

최신 제품 source는 `bf48ba4366e1dd4f64a7ed23191190d1d0e55ca9`다. 앞의 production19 표는 이전 제품 source의 기준 결과이며, 이번 변경과 아래 현재 잔여 판정으로 갱신한다. Windows 시작 코드와 창 배치 모듈 두 파일만 변경했다. 추론 adapter/schema/protocol·Ready·설정/이력/API 계약은 변경하지 않았다. Windows 전체 종료 commit이나 goal complete를 지정하지 않는다.

별도 VM의 실제 작업 영역은1024×720인데 기존 설치19의 일반 창은1044×788로 하단을 넘었다. 최초 실행과 정상 종료 후 재시작에서 하단 첨부/전송/앱 정보가 잘렸고, 수동 최대화로 표시됐다. native UI Automation/Screen 근거 `003/004/008-window-bounds.json`으로 재현했다. 기본1280×800 창에서 장식을 제거한 뒤 작업 영역을 확인하지 않고 표시하던 시작 경계가 원인이다.

표시 전에 현재 monitor(없으면 primary)의 실제 work area와 outer size를 비교해, 유효한 작업 영역보다 큰 Windows 창만 OS 최대화한다. 저장 기본값·사용자 설정·화면 해상도를 변경하거나 DPI/장식 보정값을 하드코딩하지 않았다. monitor가 없으면 기존 표시를 계속한다. Rust lib1137 pass/0 fail/기존 opt-in6 ignored, Clippy all-targets `-D warnings`, locked no-default check, fmt가 pass다. lib 검사는 직접 Cargo 실행이었고 Clippy/no-default는 별도 임시 OS/app 홈 runner에서 수행했다.

최초20 빌드는 GUI/CLI 컴파일 후 Tauri NSIS 생성의 unwrap panic으로 실패했다. 진단 bundle 실행도 같은 실패를 보존했다. 문서화된 `bundle.useLocalToolsDir=true`를 임시 packaging config로 선택하고 출력 target 경로를 실행별로 고정한 재실행은 GUI/CLI/NSIS/MSI 모두 exit0이었다. lockfile·제품 기본 config·toolchain은 유지했다. 실패를 skip/pass로 바꾸거나 패키징 도구/버전을 교체하지 않았다. raw `package20-build-context.json`, 첫 실행/진단/attempt2의 `result.json`, `package20-candidate.json`에 각 조건과 실제 출력을 구분한다.

| 고정20 산출물 | 전체 SHA-256 |
| --- | --- |
| gui | `d7d74933cb776228576b686f7eb0aa28f59ca2e2c9f11f17ffa12a9579aee6c1` |
| cli | `9a99a8f9b85cf4550a794cbb7f6685a3c52125ebe31a6bbe09f783683d0f5eca` |
| nsis | `4b521c2dcf2cf9e93f72e6261eff83a8077b6e1f54eda68c4ba8043f3f309557` |
| msi | `48cb5b6ad6cd098f68c6c727eaac8921f42b5f83f7e3622bb867e9c23e22ec6c` |
| NSIS 내부 GUI | `364564c01b9d010c415bb726d8dc63602d7cd71602b42d7e6cf8de2f548430da` |
| MSI 내부 GUI | `db65c1b7e91381c038066f308d50654ca69711d879a893889eaa495ba8ea600e` |

NSIS/MSI를 실행하지 않는 별도 payload 검사도 pass다. 각각 전체 GUI bytes가 고정 standalone의 Tauri bundle marker3bytes만 치환한 값과 일치하고, CLI는 고정 파일 전체와 동일했다. UTF-8/UTF-16 개인 절대 경로 검색0건이며 원래19 고정 파일도 보존됐다. `package20-{nsis,msi}-payload-readonly/`에 별도 근거를 둔다. 이 정적 검사를 실제 설치 성공으로 세지 않는다.

### VM의 실제 CPU 기준과 수정 후 검증

기존19 NSIS 새 설치본에서 원래 CPU bundle을 GUI로 가져오고 같은 Qwen0.5B 모델·명시 runtime binding·새 프로필 `VM CPU acceptance`를 만들었다. import 후 runtime 폴더64개 파일의 전체 hash가 기존 기준과 같았다. runtime revision `14310190cd0a0c831fe949ac8cbedd8abdc90695`, 실행 파일 SHA256 `715f0ea98819f03fc596e9d352e989fc0ae093056282e0d73b2d657e7afa7d02`, 모델 revision `9217f5db79a29953eb74d5343926648285ec7e67`/SHA256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`다. 원래 질문의 실제 응답5·PP34/TG2·저장 이력과 정상 종료 후 재열기를 확인했다. GUI/엔진 종료·포트 닫힘·임시 인증 파일 제거·설정/대화 hash 보존은 `005–009` guest receipt 및 별도 baseline/quit assessment에 있다.

새20 파일은 기존19 설치·데이터의 체크포인트를 만든 뒤 별도 폴더로 전달했고, 게스트에서 production 네 파일과 관찰 스크립트 한 개, 총5개 전체 hash를 확인했다. 최초20 실행에서 **수동 최대화 없이 Maximized**로 열렸다. work area1024×720, native outer1040×736/(−8,−8)은 정상 최대화 시 관측한 DWM 바깥 테두리와 같고, 실제 첨부/전송/앱 정보가 모두 보였다. 재시작 당시 설정·원래 대화·runtime66개 파일 전체 hash, 프로필/이력 객체가19와 동일했다. raw `011-fresh-nsis-data.json`, `package20-initial-window-preservation-verdict.json`이다.

같은 프로필을 실제 GUI에서 다시 열어 원래 runtime/model binding을 확인하고 SaveRun→Loaded→새 대화→동일 질문의 실제 응답5·PP34/TG2를 확인했다. 원래 대화는 그대로 남았다. 명시적 저장으로 해당 프로필 revision2→3이 됐고, 네 프로필의 settings/coverage는 모두 같았다. 실제 CPU argv·소유 엔진/listener와 정상 창 Close 후 GUI/엔진/포트/인증 파일/staging 정리, 종료 전후67개 파일·두 대화·프로필의 보존을 확인했다. `012–014` guest receipt와 `package20-cpu-close-and-workarea-verdict.json`, `package20-profile-settings-preservation-verdict.json`에 연결한다. 종료 관찰 JSON의 첫 회수는 임시 수신기 만료로 실패했으며 원본 파일을 보존해 새 수신기로 회수했다. 제품 Quit을 다시 수행하거나 실패를 숨기지 않았다.

큰 화면 분기도 같은20 파일을 별도 새 app/OS 홈에서 실제 실행했다. work area3840×2064에서 일반 창2586×1671/(49,49)로 열려 최대화되지 않았고 onboarding이 작업 영역 안에 표시됐다. 실제 Close 후 소유7개 프로세스가 모두 종료됐다. 호스트의 원래0.2 GUI와 두 기존 config의 제한된 전체 hash3개도 그대로였으며 원래 설치/Vault는 조작하지 않았다. `package20-larger-workarea/`와 `package20-host-original-protected-hashes-unchanged.json`이다. 전체 개인 기록을 검사했다는 의미는 아니다.

| 이번 변경/잔여 ID | 현재 판정 | 범위 |
| --- | --- | --- |
| W01 | pass | D84 관련 Rust gates와20 production 네 target, 전체 payload/경로 검사. 변경되지 않은 frontend 전체 검사를 새로 반복했다고 주장하지 않는다. |
| W02 | unrun | 별도 VM 새 설치·데이터/프로필/이력 보존은 한정 pass. 원래0.2 실제 이전·자격 증명 보존은 아직 필수 미실행이다. 이전의 VM 관리자 준비 blocked는 실제 해소됐다. |
| W04/W05 | fail | 원래 Strata32와 SmolVLM 내용 실패를 유지한다. 별도 CPU 응답으로 대체하지 않는다. |
| W07/G07의 D84 경계 | pass | 실제 작은 화면 red→최소 수정→같은 production의 작은/큰 work area·실제 추론·보존·정상 종료 재검증. 다른 기준 경계의 실행 근거는 앞의 source별 기록을 유지한다. |
| W08 | unrun | 고정20 설치 패키지 생성/정적 검사와 standalone production GUI는 한정 pass. 현재 VM NSIS 재설치부터 계속하며 실제0.2 NSIS/MSI upgrade·MSI 새 설치·remove·Credential Manager·설치 identity의 OS 통합/알림 등 필수 수락은 남아 있다. |

Windows goal은 active다. 이미 완료한 범위를 반복하지 않고 고정20 실제 설치본에서 관련 GUI/CLI·OS 통합을 이어간다. Linux/Mac 실제 검사는 이번 Windows 완료 조건에 추가하지 않으며, [Linux/Mac 인계](engine-adapter-linux-macos-handoff.ko.md)의 L01–L04/M01–M04/R01–R13을 같은 source 경계로 이어간다.

### 고정20 NSIS 실제 재설치와 설치본 보존 검사

같은 제품 source `bf48ba4366e1dd4f64a7ed23191190d1d0e55ca9`의 고정20 NSIS를 VM에서 실행했다. 기존0.3.1을 발견한 유지 관리 화면에서 Add/Reinstall을 선택하고 실제 설치 완료→Run AioLM→설치된 GUI 실행을 관찰했다. 이는 **같은 버전 재설치**이며 원래0.2.0에서의 업그레이드 결과가 아니다. 완료 화면의 바탕 화면 바로가기 생성은 선택 해제했고 기존 바로가기는 보존했다.

설치된 GUI SHA-256 `364564c01b9d010c415bb726d8dc63602d7cd71602b42d7e6cf8de2f548430da`, CLI SHA-256 `9a99a8f9b85cf4550a794cbb7f6685a3c52125ebe31a6bbe09f783683d0f5eca`와 버전0.3.1이 앞의 NSIS 전체 payload 검사와 일치했다. 실제 CLI help exit0, 설치본 최초 Maximized와 작업 영역1024×720, 엔진 미실행 상태를 확인했다. 재설치 직전 정상 종료 snapshot과 비교해 설정·두 대화·runtime의 **67개 파일 전체 hash**, 프로필 및 이력 객체가 모두 같았다. 사용자 Start 메뉴/바탕 화면의 AioLM 바로가기는 설치된 GUI를 가리키고, 실제 `Get-StartApps`의 AppID는 `com.aiolm.desktop`이었다. 이 등록 결과만으로 알림 표시나 모든 OS 통합을 통과했다고 판단하지 않는다.

raw는 `015-fresh-nsis-data.json`, `016-fresh-nsis-installed.json`, `package20-installed-maintenance-verdict.json`과 검증 스크립트 `verify-package20-installed-maintenance.mjs`다. 관찰 명령 마지막 조각의 Hyper-V `TypeText`가32773으로 거부된 실패를 보존했다. 실제 화면에서 실행 전 입력 중단 지점을 확인하고 누락 조각만 다시 전달한 뒤 전체 명령을 한 번 실행해 두 영수증을 회수했다. 가상 키보드 API의 접수 자체를 제품 실행 성공으로 사용하지 않았다.

VM의 현재 바탕 화면이 실제 OneDrive 동기화 경로이고 OneDrive 프로세스도 실행 중이었다. 바로가기 제거가 다른 기기로 전파될 가능성을 격리하기 위해, 기존 계정/동기화 설정은 보존하고 **이 VM의 OneDrive 미연결 로컬 테스트 계정**을 준비하도록 요청했다. 사용자가 생성 방법을 요청해 Microsoft의 계정 추가/유형 변경 절차를 안내했다. 새 계정의 실제 로그인·바탕 화면 경로·OneDrive 상태는 아직 확인하지 않았다. 계정 준비 중에는 VM 키 입력을 멈추고 수집된 영수증의 읽기 전용 비교를 수행했다.

W02/W08 전체는 계속 unrun이다. 위 재설치·보존·설치 identity 등록만 한정 pass이며, 설치20 실제 추론/정상 종료, 원래0.2 NSIS/MSI 업그레이드, MSI 새 설치/제거, Credential Manager 및 OS 알림 실제 표시는 남아 있다. 원래 Strata32/미디어 fail도 유지하며 goal을 complete로 바꾸지 않는다.

### VM 로컬 계정 격리와 공식0.2 업그레이드 전 기준

사용자가 새 VM 로컬 테스트 계정에 로그인한 뒤 실제 게스트에서 로컬 계정, OneDrive 밖의 바탕 화면, 현재 세션 OneDrive0개, 기존 사용자별/컴퓨터 전체 AioLM 설치0개·기본 데이터 폴더 없음·현재 세션 앱 없음과 전달한 관찰 도구 두 파일의 전체 hash를 확인했다. 이 계정은 실제 관리자 그룹 조회에서도 표준 사용자였다. 새 체크포인트를 만든 뒤 검증 도구 세 파일만 전달했으며 guest file-copy 통합 서비스는 원래 disabled로 복구했다. 호스트나 VM 기존 계정의 설치/Vault/OneDrive 설정은 변경하지 않았다. raw는 `017-preflight.json`, `local-account20-transfer-result.json`이다.

공식0.2.0 NSIS SHA-256 `f680d9b59793db0d3983b1f5df01088b222d25dfc3b1d1fb00395bf1f76e9b21`를 게스트에서 다시 확인하고 실제 사용자별 기본 경로에 설치했다. 관리자 권한 요청 없이 설치 완료→Run AioLM→실제 최초 onboarding→원래 모델 전달 폴더 선택→Chat 진입을 확인했다. 이전 버전의 작은 창은 수동 최대화했으며, 수정20의 자동 최대화와 구분한다. 설치 GUI SHA-256 `21bae2a546b10bf47679a0a02e1e4200408fdee153407ddac8725cf6f45b3564`, CLI SHA-256 `744ff8e86ac63174ccf97263922b892fc45fac900f2c7db4ebbae56e06623282`와 버전0.2.0이 공식 NSIS의 읽기 전용 추출 파일 전체 hash/byte 수와 일치했다. 호스트에서는 이 설치 프로그램이나 추출된 실행 파일을 실행하지 않았다.

**이전0.2 CPU bundle import는 fail**이다. 실제 GUI에서 Advanced→Portable runtime bundles→원래 CPU ZIP을 선택했으나 `llama-server --list-devices`의 가속기 없음 오류로 staged preflight가 실패했다. 같은 원래 bundle은 앞의 고정19/20에서 import와 실제 CPU 추론을 통과했다. 원래0.2 binary·bundle·readiness 조건을 바꾸지 않고 이전 실패를 보존한다. 이전 버전에서 실제 추론을 성공했다고 주장하거나 이 실패를 unsupported로 바꾸지 않는다. 원래0.2 runtime 화면의 긴 오류 문구가 좁은 열로 표시된 현상도 관찰했고, 기존 키보드 탐색으로 Advanced를 열어 실제 import picker에 도달했다. 이는 최신20에서 같은 결함을 재현했다는 의미가 아니다.

**공식0.2의 실제 Windows Vault 기준은 한정 pass**다. 게스트의 로컬 테스트 계정에서 새 UUID와 임의32-byte 합성 키로 제품 계약에 맞는 백업 파일을 생성했다. 원래0.2 GUI의 Restore from backup file→소유 항목 표시→Save backup file→별도 새 파일 저장을 실제 수행했다. 로컬 비교에서 UUID·origin·비밀 값이 같았고 원본/앱 내보내기 전체 파일 hash도 일치했다. 복원·목록·내보내기 경로는 로컬 registry/OS Vault를 사용하며 공유 제출이나 외부 소유권 관리는 실행하지 않았다. 비밀 내용은 출력·호스트 회수·커밋하지 않았다. raw는 `018-fresh-nsis-installed.json`, `vm-original02-installed-vault-verdict.json`과 해당 실제 GUI capture 기록에 연결한다. 합성 파일 생성이나 비교 helper만으로 Vault 성공을 판정한 것이 아니다.

원래0.2→고정20 실제 업그레이드와 그 전후 프로필/이력·자격 증명 보존은 아직 unrun이다. 별도 MSI 새 설치/업그레이드/제거, 최종 설치본 실제 추론·정상 종료·알림도 남아 있다. 표준 사용자의 MSI 권한 처리는 실제 설치 시점에 확인한다. 이번 격리·이전 설치·Vault 기준으로 W02/W08 전체나 goal을 완료 처리하지 않는다.

### 공식0.2에서 고정20으로 실제 NSIS 업그레이드와 보존 확인

앞 절의 업그레이드 미실행 상태를 다음 실제 결과로 갱신한다. 공식0.2.0 tag의 source는 `5231e8fb826ab65d59ded739e198981a60d31c1f`, 고정20 제품 source는 계속 `bf48ba4366e1dd4f64a7ed23191190d1d0e55ca9`다. 별도 VM 로컬 테스트 계정에서 이전 GUI로 모델 프로필 `LEGACY02`를 생성하고 GPU layers0/context4096을 저장했다. 정상 종료 후 실제 schema12 파일과 두 프로필을 확인했고, 재시작 GUI에서 같은 모델의 프로필을 다시 열었다.

이전0.2 CPU ZIP import fail은 유지한다. 같은 원래 CPU bundle64개 파일의 전체 hash를 확인해 별도 작업 폴더에 풀고 이전 앱을 실행할 때 그 프로세스의 PATH에만 전달했으나, 실제 GUI picker는 system runtime을 제공하지 않았다. 이전 source의 `ModelSettingsDialog.test.tsx`도 managed runtime만 허용하도록 명시한다. 도움말 문구만으로 지원을 단정했던 가설은 이 소스와 실제 화면으로 기각했다. 원래 binary·등록·Ready 조건을 우회하지 않았으며, Windows나 고정20의 미지원 판정으로 바꾸지 않는다.

이력 이전은 **명시적인 합성 데이터**로 검증했다. 이전 source의 conversation format1에 맞는 새 대화에 `[SYNTHETIC]` 제목, 실제 엔진 응답이 아니라는 본문, 한글을 포함한 두 메시지만 넣었다. 기존 파일을 덮어쓰지 않았다. 공식0.2 GUI가 이 대화를 읽고 실제 표시한 뒤 정상 종료했고, 설정·이력·소유권 등록 등 파일5개 전체 hash가 실행 전후 같았다. 실제 이전 GUI의 프로필 저장과 합성 이력의 출처를 구분하며, 이전 엔진 추론을 성공했다고 주장하지 않는다. `019–022-fresh-nsis-data.json`, `vm-original02-migration-baseline-verdict.json`에 연결한다.

고정20 NSIS 전체 hash를 게스트에서 확인한 뒤 실행했다. 설치 프로그램이 **older version**을 감지했고, 기본 Uninstall before installing 절차에서 **Delete the application data를 선택하지 않았다**. 이전 제거 완료→같은 사용자별 설치 경로→설치 완료→Run AioLM을 실제 수행했다. 새 GUI는 수동 최대화 없이 열렸고 onboarding을 반복하지 않았으며 기존 합성 대화의 한글·두 메시지·합성 표시가 그대로 보였다. 설치 GUI/CLI 전체 hash는 위 고정20 NSIS payload와 일치했다. 같은0.3.1 재설치 결과와 구분되는 실제0.2→0.3.1 업그레이드다.

실제 schema12→14 이전 후 원본 설정 백업은 이전 config 전체 hash와 같았고, 나머지 네 파일도 그대로였다. 원래 두 프로필의 ID·이름·revision·각 설정 값과 원래 모델 적용 기록이 보존됐다. 이전 Model profile이 같은 엔진에서 공유하는 Global scope로 바뀐 것은 `config/profiles.rs::share_profiles`의 이전 규칙이며, 원래 모델 적용 key/프로필 ID/값은 유지됐다. 이전의 빈 runtime backend/build는 `legacy_runtime`에 보존되고 임의 runtime으로 재연결되지 않았다. 기본 제공 엔진의 기본 프로필 두 개가 추가돼 총4개다. `023-fresh-nsis-data.json`, `vm-original02-upgraded20-data-verdict.json`의 실제 객체/파일 비교가 pass다.

**업그레이드 전후 Windows Vault 보존도 한정 pass**다. 고정20에서 원래 등록 시각의 합성 소유 항목을 찾고, 재등록 없이 Save backup file→별도 새 파일 저장을 수행했다. 게스트 비교에서 원래0.2 내보내기와 UUID·origin·비밀 값 및 전체 파일 hash가 같았다. GUI의 실제 OS Vault 접근과 로컬 파일 비교를 각각 관찰했으며, comparator가 Vault를 대신 읽은 것이 아니다. 비밀 내용은 VM 밖으로 전송하거나 출력하지 않았다. `024-fresh-nsis-data.json`, `vm-original02-upgraded20-vault-verdict.json`과 실제 picker/저장/비교 capture가 근거다. 테스트 계정의 파일 메타데이터·프로필 설정을 호스트 임시 근거 폴더로 보내는 범위는 사용자에게 명시적으로 허용받았다.

위 결과는 실제 NSIS 업그레이드와 초기 설정/합성 이력/Vault 보존의 범위만 pass다. 이 로컬 계정의 설치20 실제 추론/usage·재시작·정상 종료/소유 리소스 정리·OS 통합과 알림, MSI 새 설치/실제 업그레이드/제거는 이어서 수행한다. W02/W08 전체와 goal은 완료 처리하지 않는다. 원래 Strata32/미디어 fail, 이전0.2 CPU import fail도 유지한다.

### 업그레이드 설치본의 실제 CPU 추론·알림·정상 종료

같은 고정20 NSIS 설치본에서 실제 CLI `--help`가 exit0으로 JSON 도움말을 반환했고 GUI/CLI 전체 hash와 PE 버전0.3.1이 기존 패키지와 일치했다. 관찰 스크립트가 추가로 요구했던 `--version`은 현재 CLI parser와 도움말에 정의되지 않아 unknown command/exit1이었다. 수집기 전체의 fail 원본을 보존하고, 실제 지원되는 help 및 설치 파일 identity만 한정 pass로 판정했다. `025-fresh-nsis-data.json`, `vm-upgraded20-installed-cli-verdict.json`과 `aiolm-cli.rs::parse_command`를 대조했다. 이 관찰 가정 때문에 제품 명령을 새로 추가하거나 실패를 숨기지 않았다.

엔진 중립 목록에서 기본 제공 llama.cpp 관리 화면을 열고 Advanced→Portable runtime bundles로 **원래 b11617 CPU ZIP**을 가져왔다. Windows 파일 선택기에 `/` 경로를 입력한 첫 시도는 파일 이름 오류로 거부돼 가져오기가 시작되지 않았고, 대화상자를 취소한 뒤 같은 파일의 Windows 경로로 재시도했다. 실제 가져오기 완료와 b11617 managed runtime 표시를 확인했다. 원래 Qwen 모델의 이전 프로필 `LEGACY02`를 열어 이 runtime을 명시적으로 선택하고 Save profile & start→model loaded를 수행했다. 새 대화에서 원래 질문의 실제 응답 **5와 PP34/TG2**가 표시됐고, 이전의 명시적 합성 대화는 별도로 남았다.

실제 엔진 argv는 원래 모델·CPU device none·GPU layers0·context4096·loopback bind를 유지했다. CPU 원본64개 파일 전체 hash/byte 수가 ZIP manifest와 일치했다. 정상 창 Close 전후 설정·프로필·원래 합성 이력·새 실제 대화·runtime 등 **71개 파일 전체 hash가 같았다**. `LEGACY02`의 모든 설정 값은 이전 직후와 같고, 명시적 저장에 따른 revision2→3 및 runtime binding을 확인했다. GUI·엔진·WebView·콘솔 자식 등9개를 PID와 생성 시각으로 추적했으며 정상 Close 후 모두 종료되고 엔진 listener와 launch staging도 없었다. `026–028-fresh-nsis-data.json`, `vm-upgraded20-cpu-close-verdict.json`이 근거다.

수집 실패 두 건도 구분해 보존했다. 첫 관찰 JSON은68,315바이트여서 기존64KiB 수신 한도를 넘었다. 게스트 원본과 hash를 보존하고 같은 JSON 객체를17,429바이트로 공백 압축해 회수했으며 제한·timeout이나 제품 실행을 바꾸지 않았다. 다음 수집기는 Ready 중에도 임시 인증 파일이 존재해야 한다고 잘못 가정해 fail을 기록했다. 실제 제품은 `commands/server.rs`에서 readiness 성공 직후 그 파일을 삭제하며, 실제 관찰에서도 파일이 없었다. 이 fail과9개 프로세스 기준은 그대로 보존했고, 별도 정상 종료 관찰 및 종료 후 해당 경로의 부재를 확인했다. 종료 후 원래 모델 전체 SHA-256도 기존 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`와 같았다. 후속 관찰 화면은 `vm-upgraded20-model-auth-result.json`이다.

설치본 Settings→Notifications→Send test notification에서 요청 접수 안내와 **실제 Windows의 AioLM 테스트 toast 표시**를 각각 확인했다. `vm-upgraded20-test-notification-result.json`이며, 단순 API 접수 성공을 표시 성공으로 간주한 것이 아니다. 다른 앱이나 계정의 알림 설정은 바꾸지 않았다.

이번 실제 추론·usage·알림·정상 종료/보존만 한정 pass다. 같은 설치본의 재시작 후 새 대화/프로필·Vault 재확인, MSI 새 설치/실제 업그레이드/제거와 잔여 OS 통합 검사는 남아 있으므로 W02/W08 전체 및 goal은 완료 처리하지 않는다. 원래 Strata32/미디어 및 이전0.2 CPU import fail도 유지한다.

### 업그레이드 설치본 재시작과 NSIS 데이터 보존 제거

같은 고정20 설치본을 정상 종료 후 다시 실행했다. 원래 실제 질문·응답5·PP34/TG2가 저장된 대화와 이전 합성 대화가 각각 표시됐고, `LEGACY02`의 원래 모델·명시적 managed CPU runtime binding도 재로드됐다. 설정을 다시 저장하거나 profile revision을 늘리지 않았다. Benchmark에서 기존 소유 항목의 백업을 새로운 로컬 작업 파일로 내보냈으며, 원래0.2·업그레이드 직후·재시작 후의 UUID·origin·비밀 값과 전체 파일 hash가 같았다. 비밀은 출력하거나 VM 밖으로 보내지 않았다. 두 번째 정상 Close 후71개 파일의 전체 hash와 설정/프로필 객체가 직전 기준과 같았고 현재 세션 앱·엔진·listener·staging도 없었다. `029–030-fresh-nsis-data.json`, `vm-upgraded20-restart-verdict.json`과 실제 재시작/프로필/Vault/종료 화면이 근거다.

이어서 실제 설치 폴더의 NSIS 제거 프로그램을 실행했다. 테스트 계정의 사용자별 설치 경로와 **Delete the application data 미선택**을 확인하고 제거 완료 화면까지 진행했다. 제거 후 GUI·CLI·제거 실행 파일과 테스트 계정의 바탕 화면/시작 메뉴 AioLM 바로가기가 없었고, 현재 사용자 uninstall 등록의 정확한 DisplayName AioLM 항목 수도0이었다. 같은 계정의 데이터71개 파일 이름·크기·전체 SHA-256 및 프로필/설정은 제거 직전과 일치했다. `031-fresh-nsis-data.json`, `vm-upgraded20-nsis-remove-verdict.json`과 실제 제거·경로·등록 정보 화면을 연결한다. 파일 보존만으로 제거 후 OS Vault 재접근까지 통과했다고 주장하지 않는다.

이 범위의 재시작·보존·NSIS 실제 제거만 한정 pass다. MSI 실제 새 설치/이전 버전 업그레이드/제거와 후속 설치본의 Vault 접근 등은 계속 검증한다. W02/W08 전체 및 goal은 완료 처리하지 않으며 원래 Strata32/미디어와 이전0.2 CPU import fail을 유지한다.

### MSI 인증 이후 중단과 portable의 제거 후 검증

고정20 MSI SHA-256 `48cb5b6ad6cd098f68c6c727eaac8921f42b5f83f7e3622bb867e9c23e22ec6c`를 게스트에서 확인하고 실제 Welcome→Destination→Install까지 진행했다. MSI는 per-machine 권한을 요구했고 VM의 표준 사용자에게 관리자 인증 화면이 표시됐다. 이후 실제 화면은 Setup Wizard was interrupted였다. 정확한 취소/시간 초과 원인은 확정하지 않는다. Finish로 닫은 뒤 실행 파일3개, 원래0.2/고정20의 MSI ProductCode 등록 경로6개와 AioLM 바로가기 경로12개가 없었고 사용자/시스템 PATH에도 해당 설치 경로가 없었다. 데이터71개 파일 전체 hash와 설정/프로필은 시도 전과 같았다. `032–033-fresh-nsis-data.json`, `vm-msi20-installer-outcome.json`, `vm-msi20-interrupted-verdict.json`이 근거다. 수집기의 removed 모드는 부재 관찰용이며 실제 MSI 제거 성공을 뜻하지 않는다. 실제 MSI 새 설치·업그레이드·제거는 관리자 인증 후 다시 수행해야 한다.

독립적으로 같은 로컬 계정에서 고정20 standalone GUI/CLI를 실행했다. GUI 전체 hash는 위 `d7d74933cb776228576b686f7eb0aa28f59ca2e2c9f11f17ffa12a9579aee6c1`, CLI는 `9a99a8f9b85cf4550a794cbb7f6685a3c52125ebe31a6bbe09f783683d0f5eca`, PE 버전은 둘 다0.3.1이었다. 실제 CLI `--help`는 exit0이었다. 저장된 CLI 관찰 자료의 최초 POST는 이미 종료된 수신기에 대해 timeout이 났다. VM 원본을 보존하고 새 수신기로 같은 파일을 회수했으며 CLI를 재실행하거나 timeout을 늘리지 않았다.

**NSIS 제거 후 실제 OS Vault 접근도 한정 pass**다. portable GUI가 이전 등록 시각의 소유 항목을 읽었고, 재등록 없이 새 비공개 작업 파일로 백업을 내보냈다. 원래0.2 내보내기와 UUID·origin·비밀 값·전체 파일 hash가 같았다. 기존 실제 대화/usage와 합성 이력도 별도로 재로드됐다. 이 결과를 MSI 설치본의 Vault 접근 성공으로 대체하지 않는다.

portable GUI에서 같은 `LEGACY02`·원래 b11617 CPU runtime·원래 Qwen 모델을 Save profile & start로 실행했다. 새로운 대화의 같은 질문에서 실제 **5와 PP34/TG2**를 확인했다. 원래64개 runtime 파일 전체 hash/크기가 manifest와 같았고 엔진 argv의 모델·loopback·context4096·CPU device none·GPU layers0도 보존됐다. 정상 창 Close 전후72개 파일 전체 hash와 설정/프로필이 같았다. 실행 전71개 중 명시적 프로필 저장으로 바뀐 config 이외70개는 그대로이며 새 실제 대화 파일1개가 추가됐다. `LEGACY02` revision3→4 외 설정 값은 전부 같았다. GUI·엔진·WebView·콘솔 등9개를 PID/생성 시각으로 추적했고 종료 후 모두 사라졌으며 엔진 포트·임시 인증 파일·launch staging도 없었다. 종료 후 원래 모델 전체 hash도 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`와 같았다.

첫 비교 스크립트는 프로필 라이브러리 revision이 한 번 증가한다고 가정해 실패했다. `profileEditor.ts::mergeProfileEditor`의 명시적 저장과 `useExecutionStore.ts::start`의 실행용 application 확정은 별도 저장이며, 관찰된 library5→7과 profile3→4를 구분했다. 최초 실패/스크립트를 보존하고 source 계약 및 나머지 프로필·적용 객체의 모든 값까지 비교한 후 한정 pass로 판정했다. `034–037-fresh-nsis-data.json`, `vm-portable20-verdict.json`, `vm-portable20-first-verifier-failure.json`과 실제 GUI·종료·모델 hash 화면을 연결한다. MSI 필수 실제 수락·잔여 OS 통합과 원래 Strata32/미디어 실패가 남아 W02/W08 전체 및 goal은 완료 처리하지 않는다.

### portable의 OS 클립보드·한글 IME·트레이

같은 고정20 portable을 재시작해 새 실제 대화의5·PP34/TG2와 기존 실제/합성 대화3개를 확인했다. 실제 응답의 Copy→설정 검색에 Windows Ctrl+V로5가 들어갔고 지웠다. 기존 한글 IME에서 `rkskek`가 `가나다`로 조합되고 Tab 후 조합이 확정되는 것을 관찰했다. 검색어를 지우고 입력 모드를 원래 A로 복원했다. `vm-portable20-clipboard-result.json`, `vm-portable20-ime-composition.json`, `vm-portable20-ime-committed.json`이 근거다. 편집 가능한 설정 검색에서 검사한 범위이며, 모델을 로드하지 않아 비활성화된 채팅 입력의 IME 검사로 주장하지 않는다.

트레이 기능은 `src-tauri/src/tray.rs`의 실제 계약을 확인했다. 원래 꺼져 있던 Close to system tray를 켜고 같은 CPU/model/profile로 로드한 뒤 창 Close→숨김→실제 트레이 아이콘 클릭→로드 상태 복원→트레이 메뉴 Quit AioLM을 수행했다. 숨긴 동안 GUI/엔진 PID가 남았고, 복원 전후에는 PID와 생성 시각·전체 실행 파일 hash·listener가 같았다. 숨김 수집기는 생성 시각을 수집하지 않았으므로 그 구간의 PID만으로 별도 identity 보장을 주장하지 않는다. 숨김·복원·Quit 전후72개 파일 전체 hash와 프로필/설정 요약이 같았다. Quit 후 GUI/엔진·launch staging이 없었고 알려진 엔진 포트의 별도 실제 OS 조회도 listener0이었다.

이후 재시작→설정에서 트레이 옵션을 원래 꺼짐으로 저장→일반 Close로 종료했다. 실제 저장 화면과 config의 `close_to_tray=False`를 확인했고 config 이외71개 파일은 변경되지 않았다. 모델 로드를 위한 명시적 Save profile & start에 따른 프로필 revision4→5와 library7→9 외 프로필 값·적용 객체는 같았다. `038–042-fresh-nsis-data.json`, `vm-portable20-tray-verdict.json`, `vm-portable20-tray-reset-final-result.json`이 근거다. 이전036/037의9개 자식 프로세스 기준은 재사용하지 않았으며 이번 트레이 관찰을 전체 자식 tree 검사로 확대하지 않는다.

OS 통합의 위 범위만 한정 pass다. 실제 화면에서 exit 안내의 “Closing the desktop app”가 트레이 숨김과 혼동될 수 있어 D85로 기록하고 수정본의 production 화면 재검증을 이어간다. MSI 관리자 인증은 아직 제공되지 않았고 실제 MSI 설치·업그레이드·제거는 unrun이다. W02/W08 전체 및 goal을 완료 처리하지 않는다.

### D85 — 실제 종료와 트레이 숨김 안내 구분

실제 고정20 설정 화면의 종료 설명은 “Closing the desktop app always stops”라고 안내했지만, 바로 아래 트레이 옵션은 창을 닫아도 서버가 실행된다고 설명했다. 실제 트레이 숨김에서 엔진이 유지되는 것을 관찰했으므로 사용자가 창 닫기를 작업 종료로 오해할 수 있었다. source `2738587bce3ca3b1aa8cc4cdfed00e6c1dd168ac`에서 영어·한국어·일본어·중국어 종료 설명만 앱 종료와 트레이 숨김/탭 이동을 명확히 구분하도록 수정했다. runtime·protocol·설정 저장·프로세스 계약은 바꾸지 않았다. 기존 설정 검사5개, i18n의4개 언어/713개 UI key, typecheck와 변경 파일 ESLint가 pass다.

첫 CLI 사전 빌드는 compiler DLL의 LNK1104로 실패했다. 원본 로그를 보존했고 남은 빌드 프로세스·출력 폴더 쓰기·여유 공간·해당 파일의 보안 탐지를 조사했으나 정확한 원인은 확정하지 않았다. ACL·보안 설정·lockfile을 변경하지 않았다. 다음 실행은 기존에 성공한 Tauri의 전체 enabled binary/NSIS/MSI 빌드 경로에 `--locked --no-default-features`를 적용했고 exit0이었다. 네 target 모두 이번 빌드 시각 이후 생성된 것을 확인했다. `package21-build-result.json`, `package21-build-attempt2-result.json`, `package21-build-context.json`에 실패와 성공을 각각 남겼으며 고정20은 그대로 보존했다.

| 고정21 target | 전체 SHA-256 |
| --- | --- |
| standalone GUI | `34ef6b47bfb5bf2a5b1140c9cdd112dd8bae1e0772471a3b4dfaa13b414b9a5e` |
| CLI | `7f251f40fc83a707b632e2f7677f74bd2a0eb22570d29f3194f193ee1a8040b4` |
| NSIS | `690138cbf76e90b6349265753b99e81770325ee6843c12cfe626ffbab56242d3` |
| MSI | `6281e7a58a64ec88e481fd111673c95b4d8b522d1050e70e0e1d3c48dfe6fcf4` |
| NSIS 내부 GUI | `1561e5f0889bc1b4e52853d9410e4436a167083065f3666789cfeebb65fc2da4` |
| MSI 내부 GUI | `39255ab6ce8fdb728e7da369aa4f8b80d4eac00d594c53fd5d60bc8f163a088e` |

고정21의 두 installer를 실행하지 않고 payload만 읽기 전용으로 추출했다. GUI는 기존 Tauri 계약의 정확한3바이트 bundle marker 외 모든 byte가 standalone과 같았고 CLI는 전체 hash가 같았다. standalone과 추출 payload의 개인 빌드 경로 검사도 pass다. `package21-candidate.json`, `package21-{nsis,msi}-payload-readonly/`가 근거이며 실제 설치/업그레이드/제거 성공을 뜻하지 않는다.

**수정 문구의 실제 production GUI는 한정 pass**다. 호스트의 새 격리 앱/OS/WebView 프로필에서 고정21 최초3단계 onboarding을 완료했다. 설정→서버의 영어 문구와 실제 한국어 전환 후 새 문구를 접근성 tree와 화면에서 확인했다. 물리1304×1104 창에서도 한국어 설명이 겹치지 않고 줄바꿈됐으며 스크롤 후 트레이 설정에 접근할 수 있었다. 모델을 로드하지 않은 이 검사에서 추론 성공을 주장하지 않는다. 같은21 CLI의 별도 격리 `--help`는 exit0이었다. 정상 Close 전에 GUI/WebView 자식7개를 PID/생성 시각으로 기록했고 이후 모두 종료됐으며 config 전체 hash가 같았다. Close 직후 화면 조회의 FromHandle 오류는 보존하고 별도 프로세스 identity 검사로 종료를 확인했다. `host-package21-{server-copy,ko-server-copy,ko-small,ko-small-scrolled}.json`, `host-package21-copy-verdict.json`이 근거다.

현재 W02는 고정20의 실제0.2 NSIS 이전/프로필·이력·Vault 보존까지 한정 pass이며, W08도20의 NSIS 설치/재설치/제거·실제 추론/usage/종료·알림/클립보드/IME/트레이 범위는 한정 pass다. 두 항목의 전체 판정은 계속 **unrun**이다. 고정21의 VM 바이너리/검증 스크립트 전송은 자동 승인 검토가 기존 메타데이터 전송 동의와 범위가 다르다며 거절해 명시적 허용을 요청했다. 새 파일 서버는 시작되지 않았고 우회 전송하지 않았다. 고정21 VM 실제 추론/보존/종료·설치본 수락과 실제 MSI 새 설치/0.2 업그레이드/제거는 각각 파일 전송 허용과 VM 관리자 인증 후 이어간다. 원래 Strata32/미디어 content fail을 유지하며 goal은 active이고 Windows 종료 commit은 아직 지정하지 않는다.

### 고정21 이후 만든 미지 엔진의 실제 Windows GUI 기준 검증

제품 source와 GUI/CLI는 위 고정21 그대로다. 고정 후 새 namespace의 합성 v1/v2와 새 진단 flag를 가진 개인 native 빌드를 만들고, flag가 고정 GUI/CLI의 UTF-8·UTF-16 및 해당 source에 없음을 확인했다. 합성 engine script SHA256은 `59019e0f894cf4ca3d4610d3083464b2f8dc2415c264c60d50d480820bc701ee`, v1 spec은 `b345b4e21f3e32539cfba67707427d2cb896a59f83663be4b0457c6a1741f1e0`, opaque 모델은 `8d0a5749b7319141d107980bfe59f5d0d4cca2425d13781dff77f1800c45a356`다. 사용자 데이터 없는 별도 검증 홈을 사용했다.

합성 v1은 **실제 수동 wizard**에서 interpreter·Unicode/공백 script entry point·hash 대상 파일·직접 HTTP protocol·model/host/port/alias binding·환경 변수 인증·모델별 probe를 입력했다. manifest의 options/models는 비어 있었다. 실제 help의1,014개 옵션과 형식/arity 미확정1,008개를 구분하고, 공통 GUI에서 새 text flag와1,000개 목록의999번 옵션에 한글·따옴표·공백 값을 입력했다. 새 global 프로필→명시적 변경 확인→저장→fresh probe/Ready→실제 argv→합성 Chat echo/TG4까지 한정 pass다. 기존 기본 프로필4개는 유지됐다. PP 미확정인 합성 HTTP 응답이며 LLM 추론으로 계산하지 않는다. `package21-synthetic-v1-verdict.json`이 근거다.

같은 runtime ID로 v2를 덮어쓰는 등록은 거부됐다. 검증용 등록만 제거하고 준비된 v2 manifest를 실제 GUI로 등록했다. 이전 help의 실행은 entry point 불일치로 거부됐고 기존 값은 유지됐다. fresh help는 새 replacement text·삭제된 text·count의 단일→두 값 변경을 diff로 표시했다. 삭제된 값은 자동 삭제하지 않고 사용자가 이번 draft에서 명시적으로 지웠다. 별도 새 프로필로 복구해 실제 재실행→Windows의 두 Python 프로세스 명령줄을 `CommandLineToArgvW`로 해석→fixture trace/합성 echo와 값 전체 일치를 확인했다. 기존5개 프로필·v1 이력·원래 help cache는 그대로였다. 정상 언로드 뒤 소유 엔진/콘솔3개와 listener가 없어지고 파일9개 전체 hash가 같았다. `package21-synthetic-v2-verdict.json`의 한정 pass다. 첫 검증 스크립트의 `Added options` 예상은 실제 `New options`와 달라 실패했으며, 원본을 남기고 실제 문구에 맞춰 대조했다.

실제 개인 빌드는 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`를 보존한 채 추론에 영향을 주지 않는 새 진단 옵션만 추가했다. configure/build exit0이며 executable SHA256은 `0bd0765b5115f53d026144bfc7573b3ecdbbb5fb41622c2c7dee5bdd66db3355`다. 빈 options의 명시적 manifest를 실제 GUI로 등록하고 실제 help255개에서 미지 flag를 탐색했다. 공통 GUI의 새 Unicode/따옴표/공백/메타문자 값을 새 프로필로 저장→창 닫기/재열기→같은 값→fresh 모델 probe/Ready→단일 Windows argv를 확인했다. 같은 원래 Qwen revision `9217f5db79a29953eb74d5343926648285ec7e67`, 모델 SHA256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`와 같은 산술 질문에서 실제 **5/stop/PP34/TG2**, 무인증401을 확인했다. 합성 성공과 구분되는 실제 추론 한정 pass이며 `package21-personal-verdict.json`이 근거다.

개인 엔진이 로드된 상태에서 정상 창 Close 후 GUI/엔진/WebView/콘솔9개를 PID/생성 시각으로 추적해 전부 종료, 엔진 listener·staging 없음, 설정·프로필·이력·모델·등록·help13개 파일 전체 hash 보존을 확인했다. `package21-normal-close-verdict.json`이다. 이21 검증은 호스트의 격리 홈에서 수행했으며 VM 설치/이전 수락을 대체하지 않는다. W02/W08의 필수 잔여와 원래 Strata/미디어 fail을 유지한다.

이 과정에서 등록 제거 직후 남은 외부 엔진 상세 화면이 **Built-in adapter**라고 잘못 표시되는 결함을 재현했다(`gui21/synth-v1-remove.json`). catalog descriptor가 없을 때도 기본 제공 문구로 fallback하는 것이 원인이다. 제거 후 복구 동선에서 외부 엔진이 내장형으로 바뀐 것처럼 보이는 표시 결함이며 수정과 새 production 재검증 전에는 해결됐다고 판정하지 않는다.

### D86 제거된 외부 엔진 분류 수정과 production22 재검증

source `4d67994e19f5b2e3a6cdcdeabef4ce9827e365fe`에서 catalog descriptor가 있을 때만 해당 어댑터 분류를 표시하도록 최소 수정했다. descriptor가 없는 제거 직후 화면은 기존 누락 안내와 목록으로 돌아가는 동선을 유지한다. runtime/protocol/probe/옵션/저장·Rust 코드는 변경하지 않았다. 기존 중립 inventory 검사에 catalog에서 외부 엔진이 사라지는 상태 전이를 연결해54개 UI 검사, typecheck, 관련 ESLint가 pass다. 첫 검사 정규식이 상단 소개의 복수형 `Built-in adapters`까지 잡은 실패 로그를 남기고 분류 문구 전체와 일치하도록 고쳤다.

`--locked --no-default-features`로 실제 GUI·CLI·NSIS·MSI를 새로 빌드해 exit0/117,691ms와 입력/lockfile hash 보존을 확인했다. 이전20/21 고정 파일도 보존했다. 고정22의 전체 SHA256은 다음과 같다.

| 대상 | SHA256 |
| --- | --- |
| GUI | `b5dff7241b73f72df3e47fd5e276f4196f31a3135f83c384285f5ef45958e2b5` |
| CLI | `111f3cb4bd1a624c45b07e39e1aa84c7a668c4e8714aa06d46fb1e8b7b197a56` |
| NSIS | `6a2ab7d09bf50a5f6a6e144174a7933ae01b6efa194bd18bcf24c4ab67826fc4` |
| MSI | `799f9ec43dd391eee7c5a80a2b071458e80aafcdaf789f56f94ad4cf2b0a5828` |
| NSIS 내부 GUI | `0ea5f63a1d309c138c73b0c926cb5cb9ea73745702ce4f349991a4e2522ac8a9` |
| MSI 내부 GUI | `9a3437fb63930ed897b5878feccb6be449a316ba85d9f8b28d77422f6fa2907d` |

standalone과 읽기 전용 추출 payload는 개인 빌드 경로 검사 pass이며, installer GUI는 기존의 정확한3바이트 bundle marker 외 전체 byte가 standalone과 같고 CLI는 전체 hash가 같았다. 설치 파일은 실행하지 않았다. 고정22 MSI ProductCode는 `{84DD554F-DC6E-4A65-9F9F-8672582872EE}`이며 공식0.2와 UpgradeCode가 같다. 첫 관찰 스크립트는 이전21 hash guard를 남겨 실행 전에 거부됐고, 원본을 보존한 뒤 정확한22 hash로 읽기 전용 조사했다. 실제 upgrade 성공 근거는 아니다.

기존21 검증 홈의13개 파일을 보존한 채 고정22를 실행했다. 실제 GUI에서 같은 합성 외부 등록 제거→누락 안내/잘못된 분류 없음→목록→같은 manifest 재등록→정상 **Registered engine** 표시를 확인했다. 이 동선에서 예상된 등록 파일 외12개 파일 전체 hash가 그대로였고 실행 선택도 바꾸지 않았다. 이어 같은 개인21 엔진·같은 Qwen·기존 프로필의 새 진단 값과 current help를 재열기에서 확인하고 fresh probe/Ready→실제 Windows argv→새 Chat의 **5/stop/PP34/TG2/무인증401**을 확인했다. 기존8개 프로필은 명시적 시작의 선택 프로필 revision 증가 외 전부 같고 기존 이력3개도 그대로였다. 새22 CLI의 별도 격리 `--help`도 exit0이다.

개인 엔진이 로드된 채 정상 창 Close 후 소유9개 PID/생성 시각 전부 종료·listener/staging 없음·파일14개 전체 hash 보존을 확인했다. `package22-d86-personal-verdict.json`, `package22-normal-close-verdict.json`, `package22-cli-help-verdict.json`과 `gui22/`가 실제 근거다. **D86은 수정 후 관련 자동 검사와 production Windows 실제 제거/재등록·추론/종료 범위 pass**다. 합성 v1/v2의 전체 parser 검증은 앞선21 source의 근거와 구분한다.

W03/G01–G07의 기존 한정 pass 근거에 위 재검증을 연결하지만 전체 goal은 완료되지 않았다. 최신22 GUI/CLI·NSIS/MSI·읽기 전용 관찰 PS5개는 해시·내용·구문 검토 후 VM의 새 package22 경로에 전달할 준비만 했다. 내부 호스트를 통한 실행 파일/스크립트 내용 전송의 명시적 허용을 요청했으며 서버 시작·전송·게스트 실행은 아직 하지 않았다. 실제 MSI 설치/공식0.2 upgrade/제거와 최신 설치본 수락, 원래 Strata32/미디어 내용 fail은 그대로 남아 있다. W02/W08은 전체 unrun, Windows 종료 commit은 미지정이다.

같은 고정22에서 합성 v2의 전체 실행 연결도 추가로 확인했다. 정상 종료 뒤14개 파일을 보존해 재시작했고, 엔진 선택만으로는 모델이 없고 이전 v1 프로필의 삭제된 값이 유지돼 실행이 차단됐다. 기존 검사가 명시한 invalid draft 보호로 프로필 선택도 차단돼 있었다. 실제 모델 선택에서 미저장 초안만 명시적으로 버리자 그 모델의 **저장된 v2 프로필/새 replacement text/999번 값/current help**가 복원됐다. 값을 지우거나 프로필을 덮어써 복구한 것이 아니다. fresh probe/Ready→두 Python 프로세스의 Windows argv/trace 전체 일치→새 합성 echo/stop/TG4를 확인했다. PP는 미확정이며 실제 추론으로 계산하지 않는다. 기존8개 프로필은 선택 프로필의 명시적 시작 revision 증가 외 같고, 기존 이력4개와 나머지 파일12개가 보존됐다.

첫 수집 비교는 등록 파일도 변경되지 않는다고 잘못 예상해 실패했다. 실제 `registry.rs::refresh`는 모델별 probe 결과와 fingerprint를 저장한다. 등록 파일은 직전21의 같은 모델 Ready 등록 파일 전체 hash `215fb8dceac58750c4f55b8e3a7bd4067bb716c7078ec439f209a6871b9623d1`와 정확히 같으며 manifest 전체/model_supported/모델·engine·runtime identity도 확인했다. 원래 실패와 스크립트를 보존하고 이 계약을 대조해 `package22-synthetic-reload-verdict.json`을 한정 pass로 기록했다. 무인증401 검사는 첫 실패의 앞 단계에서 완료됐으며 정상 종료 후 새 HTTP 검사를 했다고 주장하지 않는다. 정상 창 Close 뒤 소유10개 PID/생성 시각·listener/staging 정리, 파일15개 전체 hash 일치도 `package22s-normal-close-verdict.json`으로 pass다.

### D87 opaque 모델의 미확정 크기 표시

위 실제22 모델 선택 목록에서 opaque binding의 가중치 크기가 **0 B**로 표시되는 결함을 재현했다(`gui22s/model-tab.json`). 합성 binding 파일 자체는70바이트지만 실제 가중치가 아니며, 등록된 opaque binding은 엔진 설정/모델 alias일 수도 있다. 백엔드는 명시적으로 weight size unknown이라는 notes와 format unknown/size0을 반환하므로 작은 binding 파일을 stat해 가중치 크기로 사용하면 안 된다. 메인 모델 목록은 이미 같은 unknown format을 `—`로 표시한다. 모델 설정의 선택 목록에도 그 규칙을 적용하는 최소 표시 수정이다. 저장/API/probe/readiness·모델/추론은 변경하지 않는다. 수정 후 production 실제 검증은 별도 새 binary에서 이어가며 이 문서만으로 D87 해결이나 goal 완료를 판정하지 않는다.

### D87 수정 후 production23 실제 재검증

source `908a2fb6bd5bdb4742eb4db6e8f6ac9e352956c1`의 변경은 위 표시 조건 한 곳이며, 기존 모델 설정/런타임 UI127개·typecheck·관련 ESLint가 pass다. 새 `--locked --no-default-features` production GUI/CLI/NSIS/MSI 빌드 exit0/132,830ms, 입력/lockfile·이전 고정20–22 보존과 개인 빌드 경로 검사도 pass다. 전체 SHA256은 다음과 같다.

| 대상 | SHA256 |
| --- | --- |
| GUI | `518b8298aeb987c80841bccfc845d63429cd8bd814b93b505ae16d639dcbbc97` |
| CLI | `54d1c8e61d4041cf2e74dd450f97119551cde40b3ab6acffed6e1efd1ecc08cf` |
| NSIS | `33385d1cd4bffe98087bdf21d83bf749385ad53a23f2577cdbc1994a6d215e4d` |
| MSI | `aa3c79b6e31240f3a777eae0e2c0c612a5b3cfb95dc1b3758b594728307e3400` |
| NSIS 내부 GUI | `a045451f638605946cb6c1736800cd7f80bbb6ff0c873b68b2d31808d2a2375f` |
| MSI 내부 GUI | `be5d58a27469e5b8c4b335a322df4516e418854dcaf00cd081c3259019c7906c` |

읽기 전용 payload 검사에서 GUI의 정확한3바이트 bundle marker 외 전체 byte 일치·CLI 전체 hash 일치·개인 경로 없음이 pass다. MSI ProductCode `{D6E9B690-D7B4-4A21-B78D-D8977EF1B802}`와 공식0.2의 동일 UpgradeCode/ALLUSERS1도 읽기 전용으로 확인했다. installer는 실행하지 않았으며 실제 upgrade 성공이 아니다.

고정23은 같은 검증 홈의15개 파일을 보존해 시작했다. 실제 모델 설정 목록에서 opaque binding은 **unknown · · —**로 표시되고 이전22의 **0 B**가 사라졌다. 실제 Qwen은 기존 **468.6 MiB**로 표시돼 알려진 크기를 숨기지 않았다. 합성 v2 프로필의 Unicode/따옴표/공백 replacement text·999번 값/current help→fresh probe/Ready→두 Python Windows argv와 trace 전체 일치→새 합성 echo/stop/TG4를 확인했다. PP는 미확정이며 실제 추론이 아니다. 정상 GUI 언로드 후 엔진/콘솔3개와 listener가 없어지고 파일16개 hash가 같았다.

이어 모델 선택에서 현재 초안만 명시적으로 버리고 같은 Qwen/개인21 엔진의 저장 프로필·새 진단 flag 값을 복원했다. current help→fresh 모델 probe/Ready→실제 Windows argv→원래 질문의 새 **5/stop/PP34/TG2/무인증401**이 pass다. 기존8개 프로필은 두 명시적 시작의 해당 revision 증가 외 같고 기존 이력5개·기타14개 파일 hash도 보존됐다. 두 엔진의 flag는 고정23 GUI/CLI에도 없었다. `package23-d87-both-engines-verdict.json`, `gui23/model-tab.json`, `gui23/personal-model-list.json`이 근거다.

개인 엔진이 로드된 상태의 정상 창 Close 후 소유9개 PID/생성 시각 전부 종료·listener/staging 없음·파일17개 전체 hash 일치와 새 격리 CLI help exit0도 pass다(`package23-normal-close-verdict.json`, `package23-cli-help-verdict.json`). **D87은 관련 자동 검사와 수정 후 production Windows 실제 표시/두 엔진/정리 범위 pass**다. 전체 goal이나 설치 수락은 아니다.

최신23 GUI/CLI·NSIS/MSI·읽기 전용 검증 PS5개를 해시/구문/실제 변경 내용까지 검토해 새 VM 폴더용으로 준비했다. 기존 메타데이터 동의와 다른 실행 파일/스크립트 내용 전송의 허용을 요청했으며 파일 서버 시작·전송·게스트 실행은 아직 하지 않았다. 앞선21/22도 전송하지 않았다. W02/W08의 최신 설치본 수락·실제 MSI 새 설치/공식0.2 upgrade/제거와 원래 Strata32/미디어 fail을 유지하고 Windows 종료 commit은 미지정이다.
