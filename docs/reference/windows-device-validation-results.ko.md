# Windows runtime adapter 검증 결과

## 실행 상태와 source

2026-10-15의 **진행 중인 실제 Windows 검증 기록**이다. W01–W08 전체 통과, G01–G07 구현 완료 또는 goal 완료를 뜻하지 않는다. 필수 실제 검사와 구조 구현이 남아 있으므로 종료 commit은 아직 지정하지 않는다. Linux/Mac 실제 실행은 이 Windows 작업의 후속 범위다.

- 시작 source: `df3264bad99deb0144b947f96300e8625f7a2da5`, `origin/codex/windows-runtime-adapter-handoff`의 필수 인계 commit 포함을 확인했다.
- 작업 branch: `codex/windows-runtime-adapter-validation`. 기존 변경과 사용자 설치·데이터를 보존했으며 원격 push는 수행하지 않았다.
- 현재 구현 checkpoint: `d025c94`. 공통 schema/help 기반 위에 명시적 entry point 등록·공통 GUI(`bd41dfa`, `becf8ee`), native 옵션·프로필·실제 argv 연결(`2f91aa7`), 저장한 옵션 순서/항목별 alias와 수락된 help에 연결된 arity/repeat 명시적 확인(`707331f`, `635fdc3`), CLI의 같은 effective schema 검증(`3966879`), 프로젝트의 linked profile provider/소유 설정 보존(`bbf4106`, `8801c27`)을 추가했다. 격리 검사에서 `npm run test:unit` 195 files/2,059 tests(coverage 포함), typecheck/lint, Rust library 1,071 tests와 integration suites, Clippy·no-default-features·fmt check가 pass다. Python helper 검사는 앞선 `becf8ee`에서 격리 CPython 3.12로 pass했다. 처음 PATH의 WindowsApps 별칭 실행 실패는 별도 환경 오류로 보존한다. 자동 검사는 실제 엔진·production GUI 수락의 대체 근거가 아니다.
- 검토 후 필수 구현·실제 검증이 계속된다. `c02bdc4`·`a0a6589`는 항목별 equals alias와 dash-leading 값, GUI/backend order record 거부 조건 차이를 재현 후 수정했다. Rust 1,073개와 관련 GUI 449개 검사·typecheck/lint/Clippy가 pass다. D15 최소 창 넘침은 `42008b4`·`700af30` 수정 후 source `79da287` production WebView2에서도 pass했다. 이후 실제 G 여정에서 D21 저장 차단을 재현해 `d025c94`로 수정했다. 전체 UI 195 files/2,064 tests·typecheck·변경 파일 lint는 pass이며 새 production 검증은 남아 있다.
- 실제 GUI 기준은 원래 `0cfbbb5` package6와 새 `becf8ee` package7을 각 항목에 구분해 기록한다. package7에서 D16·D17·D18 및 D19의 충돌/identity 범위를 실제 재검증했으며, 이후 source의 기능에 소급 적용하지 않는다. 나머지 실제 흐름과 최종 빌드 재검증은 진행 중이다. 별도 Python adapter helper는 `4d57c11`의 파일을 명시적으로 재등록한다.
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
| W07 | unrun | Unicode/공백 argv, runtime 설치/import 취소·의도적 import 실패/복구, 실제 CPU source build 취소·compiler 실패/재빌드의 staging/소유 process 정리, load/stream/benchmark 취소·의도적 benchmark 실패 후 같은 모델 복구·다른 세션 보호 pass 조건은 위 근거 참조. D16 동일 PR production 재빌드와 D15 최소 창 production 오류 화면은 수정 후 pass. 최종 source의 관련 반복은 남음 |
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

`1f31a0a`는 bridge의 파생 설정을 앱 소유 UUID 작업 디렉터리에 두고 GUI 중지·실패와 독립 CLI start/stop에서 정리한다. `c3e9edf`는 engine ID 분기 없이 가져오는 설정 파일→공통 입력 GUI→동일 entry point draft와, 제품에 포함하는 helper·Strata native-help/HTTP bridge를 추가했다. actual arbitrary producer subprocess·취소/재시도·helper 변조 거부, library 1,097 tests·기존 ignored 6개 및 관련 integration, UI 전체 2,095 tests와 이후 경계/이전 단계 보존 회귀·typecheck/lint/Clippy/fmt는 pass다. 실제 Chrome 360/640/1280의 새 화면·넘침·WCAG 검사는 합성 IPC로 한정한다. 같은 고정 Strata에 대한 새 helper 출력·bridge help·별도 모델 probe도 pass(raw `strata-adapter-acceptance/native-bridge-boundary4/result.json`)이며 원본 source/config/native hash를 보존했다. 최종 고정 production 앱의 실제 모델 로드·응답·공통 기능 성공으로 확대하지 않는다.

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
| U1–U3 | 미선택 외부 runtime의 raw ID 오류·오래된 inventory/probe 표시·사라진 Tuning 경로 안내 | 107 관련 검사/typecheck/lint pass; `c920bec`. package5 실제 Model & settings→Profiles 안내 pass, 선택/cache 경합 최종 GUI 검사는 남음 |

수정 코드와 자동 검사 성공만 있는 항목은 실제 production 재검증 전까지 해결 완료로 판정하지 않는다. 이번 G07에는 재시작한 중단 응답·MCP 취소 후 Retry, 선택/cache 경합, 작은 창·접근성·대량 옵션 관찰을 포함한다. 기존 일반 생성 Retry의 성공과 다른 복구 동선의 문제를 구분한다.

## G01–G07과 후속 인계

| ID | 상태 | 남은 실행 |
| --- | --- | --- |
| G01 | unrun | `9818212`의 versioned sourced schema·검증/argv 기반 21개 회귀 및 전체 clippy pass. 이후 descriptor·공통 GUI/profile/실행 연결을 구현했으며 기존 계약의 최종 실제 통합 수락이 남음 |
| G02 | unrun | `fd579ca`의 shell 없는 소유 help 실행·fingerprint/cache·부분 출력·취소 기반 16개 검사와 기존 process 10개/clippy pass. 취소 descendant 검사는 정확한 handle의 OS 종료를 확인해 10/10 반복 pass. `a53f82c`의 영속 snapshot publication/help 전용 취소와 runtime별 accepted help 연결을 추가했으며 실제 GUI의 전체 identity·취소·경합 검증은 남음 |
| G03 | unrun | parser/store·stdout/stderr 근거·column-0 alias·UTF-8·publication 경합 기반 추가. `011b083`은 version/engine/provenance를 검증하는 명시적 `option_metadata`, 같은 effective schema의 단위·민감 값·재시작·제약 적용과 관측/선언 차이 표시를 연결했다. 기존 payload의 필드 생략을 보존하며 metadata digest 변경은 help/probe를 무효화한다. 이후 D31–D35의 parser·한도·충돌·민감 값 수정과 관련 자동 검사를 통과했다. 실제 Chrome의 마스킹·접근성·넘침 검사는 합성 IPC이며 native 성공이 아니다. 최종 실제 여정과 명시적 encoding/locale 연결은 남음 |
| G04 | unrun | 공통 renderer/native/custom profile/launch와 preview 마스킹 위에 `707331f`·`635fdc3`의 versioned 저장 순서/항목별 alias 및 help fingerprint에 연결된 명시적 arity/repeat 보완을 추가. 합성 실제 spawned argv·CLI 저장/거부 integration과 GUI 검사 pass. 거부 조건/equals alias는 `c02bdc4`·`a0a6589`에서 수정/회귀 pass. 최종 고정 GUI의 재로드/실제 엔진 argv 검증은 남음 |
| G05 | unrun | `bd41dfa`·`becf8ee`의 명시적 entry point→help→binding/protocol/probe→등록 단계에 `c3e9edf`의 개방형 adapter setup import·공통 입력 GUI·제품 포함 Strata native-help bridge를 연결했다. 모델 positional binding과 bridge의 명시 argv·옵션 경계는 실제 합성 subprocess에서 pass. package9의 합성 Ready/응답은 이전 범위로 유지한다. `0fbbff9`의 실행 디렉터리와 `414c068`의 명시적 prefix/scope·중첩 옵션 순서의 자동/렌더 검사는 pass다. 전체 interpreter 명령 import·사용자 positional layout과 개인 엔진·Strata의 최종 production 전체 여정은 남음 |
| G06 | unrun | `3d1c2b8`의 중립 목록·임의 엔진 선택/검색·Add 중심 동선을 package10 WebView2에서 확인했다. 기존 공통 화면·공개 계약의 최종 source 실제 보존 검사와 D23 수정 후 production 검사가 남음 |
| G07 | unrun | 취소·런타임 전환/늦은 import 결과 보호, 1,000옵션의 초기 64개 표시/검색 회귀 추가. 실제 작은 창·접근성·성능 관찰, D15–D19 production 재검증과 최종 고정 binary의 미지 flag 수락 남음 |

기존 manifest v1 옵션 UI와 이번 최소 결함 수정을 G01–G07 전체 구현으로 계산하지 않는다. 설치 세션의 외부 차단과 독립적인 구현/검증은 계속 진행한다.

package8을 고정한 **후에** 새 합성 옵션 7개와 개인 엔진 진단 flag를 생성해, 고정 앱 바이트와 tracked source에 없고 앱 해시가 그대로임을 확인했다(`g8-unknown-provenance-verdict.json` pass). 합성 script SHA256은 `59019e0f894cf4ca3d4610d3083464b2f8dc2415c264c60d50d480820bc701ee`, 명시적 spec artifact는 `e246d21341d4b10c6126e0166d28e889c01c3e095feb69ba8a617880134eb652`다. 실제 GUI executable→help 14개 옵션→명시적 binding/protocol/probe→등록→원래 opaque 모델 선택→공통 옵션에서 반복 문법 확인→교차 순서/음수 flag/0/복수/선택 값을 입력했다(`gui/621–698`). 여기서 D21을 발견했으므로 **저장→실제 argv→응답은 unrun**이다. 합성 HTTP echo를 실제 추론으로 계산하지 않는다. 별도 개인 llama.cpp는 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 진단 flag 하나만 추가해 Windows CPU 빌드/실제 version exit0, executable SHA256 `8b392a00a7d6a5176f2fb757386c0a1db57129519ee71630b96ab034c09dcce4`를 기록했으며 이 후보의 실제 GUI 여정은 unrun이다. D21 수정의 새 production 후보는 다시 고정한 후 새 미지 flag로 검사한다. 기존 실패·준비 결과는 보존한다.

package9도 바이너리를 고정한 **후에** 새로운 합성 옵션 7개와 별도의 개인 진단 flag를 만들고 앱 바이트/해당 tracked source에 없음을 확인했다(`g9-unknown-provenance-verdict.json`). 합성 script SHA256은 `59019e0f894cf4ca3d4610d3083464b2f8dc2415c264c60d50d480820bc701ee`, spec artifact는 `50a5c6a97d652e605fcdbf7f151b57ae43345159724a5107ca9d235b3065a923`, opaque 모델은 `8d0a5749b7319141d107980bfe59f5d0d4cca2425d13781dff77f1800c45a356`다. 실제 GUI help 14개 옵션→binding/probe 등록→공통 옵션→저장→모델별 probe→소유 프로세스의 실제 argv→Chat HTTP 요청/파서 echo→저장 이력→정상 종료·소유 포트/프로세스 정리를 확인했다(`gui/750–855`). 반복 pair 사이의 text 순서, Unicode·공백·따옴표, negative flag, 0, 복수 값과 값 없는 optional을 실제 파서 결과로 대조했다. 사용량 TG4는 합성 고정값이며 실제 엔진 추론으로 계산하지 않는다. 개인 빌드는 같은 upstream `14310190cd0a0c831fe949ac8cbedd8abdc90695`에 새 진단 flag 하나만 추가했고 executable SHA256 `97bd39a2119a1a061f2a05b97116701624e28cde5ea3721fc64c49ba963e154f`다. native version과 package10의 실제 help 253개 탐색은 pass지만 해당 빌드의 GUI 등록→프로필→argv→실제 추론은 unrun이다. 최종 수정 바이너리의 새 미지 flag 수락·버전 변경·경합/취소·실패 복구는 계속 필요하다.

소스 감사에서 모델/포트 바인딩과 일반 옵션의 충돌, Windows 명령 import 문법, bridge help/argv 책임, 명시적 positional binding·사용자 positional/scope, retained diff, metadata/충돌 표시 등의 미검증 경로를 찾았다. 이는 실행 재현 전의 가설·구현 공백을 포함하며 pass나 unsupported로 판정하지 않는다. 각각 재현→수정→관련 검사→production 재검증을 이어간다.

Windows의 필수 구현·검증·작업별 commit이 끝나면 실제 종료 commit과 Git 상태를 여기에 고정한다. 그 commit을 Linux `codex/linux-runtime-adapter-validation`에서 받아 [L01–L04](windows-device-handoff.ko.md#7-linux에서-이어서-검증)를 실행하고, 이후 Mac `codex/macos-runtime-adapter-revalidation`에서 [M01–M04](windows-device-handoff.ko.md#8-mac에서-최종-재검증)와 [잔여 R01–R13](macos-device-validation-remaining.ko.md)을 실행한다. 각 OS는 자체 binary/venv를 새로 만들고 W/G의 공통 schema·profile·argv·probe 경합 검사를 함께 수행한다. 후속 OS의 공통 수정은 영향을 받은 앞선 OS 검사를 재실행하는 조건으로 인계한다. 현재 checkpoint를 검증 완료한 Windows 종료 commit으로 사용하지 않는다.

후속 기기에서 시작할 구체적인 순서는 다음과 같다. 이 목록은 인계 준비이며 Linux/Mac 실행 결과가 아니다.

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
