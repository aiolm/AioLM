# Windows runtime adapter 검증 결과

## 실행 상태와 source

2026-10-15의 **진행 중인 실제 Windows 검증 기록**이다. W01–W08 전체 통과, G01–G07 구현 완료 또는 goal 완료를 뜻하지 않는다. 필수 실제 검사와 구조 구현이 남아 있으므로 종료 commit은 아직 지정하지 않는다. Linux/Mac 실제 실행은 이 Windows 작업의 후속 범위다.

- 시작 source: `df3264bad99deb0144b947f96300e8625f7a2da5`, `origin/codex/windows-runtime-adapter-handoff`의 필수 인계 commit 포함을 확인했다.
- 작업 branch: `codex/windows-runtime-adapter-validation`. 기존 변경과 사용자 설치·데이터를 보존했으며 원격 push는 수행하지 않았다.
- 현재 구현 checkpoint: `981821262fbcc35484145e7a65ab1ab011a6b270`. G01의 공통 옵션 스키마·검증·argv 기반과 21개 회귀 검사를 추가했다. 실제 GUI/프로필 연결과 G02–G07 구현은 진행 중이며 전체 완료가 아니다.
- 실제 GUI의 최근 검사는 `0cfbbb5`의 package6를 기준으로 한다. 이후 source의 기능에 소급 적용하지 않는다. 나머지 실제 흐름의 재검증은 진행 중이며 실행 전 항목을 pass로 계산하지 않는다. 별도 Python adapter helper는 `4d57c11`의 파일을 명시적으로 재등록한다.
- raw: 저장소의 `tmp/windows-acceptance/`. 지속적인 재개 기록은 그 아래 `progress.md`다. raw·모델·개인 경로·프로필·토큰·build 산출물은 Git에 포함하지 않는다.

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

후속 GUI 조작 중 다른 Windows 앱의 색상 선택기가 입력을 가로채는 상태를 확인했다. 해당 앱을 임의로 조작하지 않고 사용자에게 닫기를 요청했으며 독립 구현/파일 검증을 계속한다. 이 일시적 GUI 조건과 별도 설치 OS 세션 대기는 서로 다른 차단 항목이다.

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

## W01–W08 checkpoint

| ID | 상태 | 실행 근거와 다음 필수 작업 |
| --- | --- | --- |
| W01 | pass | 기준 공통 20개 명령과 native CLI smoke를 실행했다. D01/D02 수정 후 재검사 통과. 최신 전체 source의 최종 공통 검사는 모든 구현이 끝난 뒤 다시 필요하다. raw `w01/results.tsv` 및 개별 로그 |
| W02 | blocked | 격리 CLI 12개 검사와 실제 GUI onboarding/폴더 선택 pass. v13 backup/round trip·미등록 engine 보존·미래 schema 거부를 확인. 실제 OS 최초 실행·기존 설치 이전/자격 증명은 별도 OS 세션 대기 |
| W03 | unrun | CLI 26개 등록/변조/삭제/재등록, GUI 네 번째 엔진 등록·argv·변조 거부·느린 probe 취소 후 새 등록과 이전 child 정리 pass. 모델 선택 probe 경합·최종 G source 재검증 필요 |
| W04 | unrun | CPU/Vulkan·고정 Strata GUI의 실제 응답/usage·취소/Retry·재시작/Quit pass. 별도 고정 SDK 조합의 ROCm 실제 두 GPU gate/응답 pass, 기존 SDK 실패 보존. 개인 build 및 최종 source의 전체 GUI 흐름 재검증 필요 |
| W05 | unrun | MCP 승인/거부/호출 취소/입력과 다른 반환값 후속·rich/error/call ID pass. 이미지 복합 질문의 내용 누락 fail 유지, 도형 후속·설정/이미지/이력 재로드 pass. 실제 다른 지원 미디어와 새 Retry 복구 재검증 필요 |
| W06 | unrun | 실제 vector RAG·STT 전처리/답변/이력·멀티 세션·gateway 인증/라우팅 pass 조건은 위 checkpoint 참조. 최종 source task 거부·프로젝트 적용/내보내기·기존 CSV/XLSX 등 보존 재검증 필요 |
| W07 | unrun | Unicode/공백 argv, runtime 설치/import 취소·의도적 import 실패/복구의 staging 정리, load/stream/benchmark 취소와 정상 종료의 소유 job/port 정리·다른 세션 보호 pass. build 취소/실패·benchmark 실패와 최종 source 반복 필요 |
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

별도 45초 slow 도구 호출을 실제로 시작한 뒤 GUI Stop을 눌렀다. launcher와 interpreter 두 MCP 프로세스가 사라졌고 늦은 응답/모델 후속 요청이 없었으며 Strata의 세 소유 프로세스는 유지됐다. 취소 뒤 UI는 `MCP response incomplete` 상태였다. 이 상태에서 Retry가 보이지 않는 복구 문제의 D09 코드는 수정했으며 같은 tool-round의 production 실제 재검증이 남아 있다.

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
| D09 | 저장된 중단/빈 응답과 tool round에서 Retry 경로 유실 | 정확한 재시도 입력의 backward-compatible 저장·기존 부분 응답 보존, 관련 자동 검사 pass; `d98029b`, `e96c700`. package6 실제 부분/첫 토큰 전 중단의 저장·재시작·Retry pass. tool-round 취소/오류의 실제 복구는 unrun |
| D10 | MCP `isError:true`를 완료/성공으로 표시 | full 반환을 보존하고 failed 상태로 표시. 36 관련 검사와 package4 native 승인→실제 error 반환→Failed 표시 pass; `a17c758` |
| D11 | CPU에서 기존 GPU 배치를 해제할 조작 부재 | GPU 미감지 시 명시적 Clear GPU assignment 제공, 자동 초기화 없음. 93 관련 검사 및 실제 BGE CPU 시작/벡터 연결 pass; `c437380` |
| D12 | help/argv만으로 실제 실행 task를 확정하여 BGE chat 500 전달 | help arity 구분과 Ready 이후 실제 API task 확인. backend 전체 검사·실제 세 모드 CLI 및 package6 GUI gateway의 embedding/잘못된 chat task 거부 pass; `140fef0`, `876231f`, `8b4c5ea` |
| D13 | 프로젝트 기본값 재적용이 사용자의 대화 지침·도구 선택을 덮어씀 | binding/version별 기본값 적용과 저장 marker, 관련 384 tests 및 history round trip pass. 실제 지침·이미지 순서의 응답/재로드/재시작 보존 pass; `1f97170` |
| D14 | 호환성 reason 원시 키와 긴 오류 때문에 runtime 행 설명 붕괴 | 4개 언어 설명/미확인 사유 안내·유연한 열 배분/줄바꿈, 관련 52 tests/typecheck/lint/i18n pass. package6 실제 큰/좁은 창 표시 재검증 pass; `0cfbbb5` |
| U1–U3 | 미선택 외부 runtime의 raw ID 오류·오래된 inventory/probe 표시·사라진 Tuning 경로 안내 | 107 관련 검사/typecheck/lint pass; `c920bec`. package5 실제 Model & settings→Profiles 안내 pass, 선택/cache 경합 최종 GUI 검사는 남음 |

수정 코드와 자동 검사 성공만 있는 항목은 실제 production 재검증 전까지 해결 완료로 판정하지 않는다. 이번 G07에는 재시작한 중단 응답·MCP 취소 후 Retry, 선택/cache 경합, 작은 창·접근성·대량 옵션 관찰을 포함한다. 기존 일반 생성 Retry의 성공과 다른 복구 동선의 문제를 구분한다.

## G01–G07과 후속 인계

| ID | 상태 | 남은 실행 |
| --- | --- | --- |
| G01 | unrun | `9818212`의 versioned sourced schema·검증/argv 기반 21개 회귀 및 전체 clippy pass. descriptor·실제 GUI/profile 연결과 기존 계약 통합이 남음 |
| G02 | unrun | 실제 help 실행 수명·cache identity·diff·취소/경합 구현 및 검사 |
| G03 | unrun | deterministic help parser와 검증된 보강 metadata 구현 |
| G04 | unrun | 공통 renderer/validator/profile/argv serializer 통합 |
| G05 | unrun | executable/entry point→help→binding/protocol→Ready 여정 구현 |
| G06 | unrun | 열린 adapter 목록과 공통 제품 동선/기능 보존 |
| G07 | unrun | 재현된 UX 결함 수정·접근성/작은 창/대량 옵션·고정 binary의 미지 flag 실제 수락 |

기존 manifest v1 옵션 UI와 이번 최소 결함 수정을 G01–G07 전체 구현으로 계산하지 않는다. 설치 세션의 외부 차단과 독립적인 구현/검증은 계속 진행한다.

Windows의 필수 구현·검증·작업별 commit이 끝나면 실제 종료 commit과 Git 상태를 여기에 고정한다. 그 commit을 Linux `codex/linux-runtime-adapter-validation`에서 받아 [L01–L04](windows-device-handoff.ko.md#7-linux에서-이어서-검증)를 실행하고, 이후 Mac `codex/macos-runtime-adapter-revalidation`에서 [M01–M04](windows-device-handoff.ko.md#8-mac에서-최종-재검증)와 [잔여 R01–R13](macos-device-validation-remaining.ko.md)을 실행한다. 각 OS는 자체 binary/venv를 새로 만들고 W/G의 공통 schema·profile·argv·probe 경합 검사를 함께 수행한다. 후속 OS의 공통 수정은 영향을 받은 앞선 OS 검사를 재실행하는 조건으로 인계한다. 현재 checkpoint를 검증 완료한 Windows 종료 commit으로 사용하지 않는다.
