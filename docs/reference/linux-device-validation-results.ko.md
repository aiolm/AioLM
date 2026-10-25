# Linux 기기 검증 결과

2026-10-25 Linux 실행 기록이다. 전체 수락은 **진행 중**이다. 아래 판정은 해당 source와 실제 실행 범위에 한정하며, 과거 Windows 결과를 이번 Linux pass로 옮기지 않았다. 원본 명령·종료 코드·source/diff 해시·캡처와 실패 기록은 저장소의 커밋하지 않는 `tmp/linux-acceptance/`에 보관한다.

## Source와 환경

- 수신 commit은 `3e2c67d4d6dd2742ee8f9997797d31f244f234de`, 작업 branch는 `codex/linux-runtime-adapter-validation`이다. 기존 checkout·변경 이력·다른 worktree를 보존했다. 필수 조상을 확인했고, 검증 제품 `43b50686627df9631210419739544f3e5e317fc1` 이후 수신점까지는 문서 네 개만 달랐다. 수신 updater SHA-256은 `72cef2c6ee6ae39588dad6791665516c87858b05f1740d41d89c8bfb7b8e429a`다.
- 실제 환경은 Ubuntu 26.04.1 LTS x86_64/kernel 7.0.0-38-generic, EPYC 4585PX 16코어/32스레드, 약 60 GiB RAM, GNOME Wayland다. Radeon AI PRO R9700 두 GPU의 HSA/gfx1201·Vulkan 사용을 확인했다. WebKitGTK 2.52.6/GTK 3.24.52다. 이 결과는 더 오래된 glibc나 다른 배포판의 호환성 보장이 아니다.
- 승인된 native 개발 의존성과 Node 22.23.2/npm 12.0.2/Rust 1.98.0, 격리 CPython을 사용했다. Linux 의존성·바이너리를 새로 만들고 lockfile을 보존했다. 시스템 Python 3.14.4의 pip 부재 등 환경 실패는 별도 기록했다.
- 테스트 자식의 HOME/XDG/AIOLM 경로를 격리했다. 설치·업그레이드·제거는 공식 Ubuntu image 서명/SHA를 확인한 KVM VM과 합성 계정에서 실행했다. 실제 사용자 자료를 fixture로 복사하지 않았다. UTC 2026-10-25 07:47:30의 원래 878개 및 확장 1,560개 파일 해시 재검사에서 변경·누락·읽기 오류는 각각 0개였다. 모든 여정 종료 뒤 최종 검사도 수행한다.

GNOME Wayland 세션의 자식 X11 backend 창에서 직접 입력한 한글의 실제 native229·조합 입력·compositionend를 확인했다. 마지막 조합 종료 4ms 뒤 Enter가 keyCode13/isComposing=false로 전달되며 첫 Enter에 모델 경로를 불러오는 결함이 재현됐다. 설정 저장·모델 시작은 없었고, 정상 Discard/Close 후 원래 설정과 main IBus/접근성 상태는 그대로였다. 기존 Chat의 상태 기반 IME 보호를 공통 입력 로직으로 옮긴 수정 `69a463b`는 실제 순서를 재현한 RED4→관련195개 검사 통과, 전체 npm 110.100초/220개 파일·2,571개 검사, typecheck8.983초·lint5.083초로 확인했다. 고정13의 실제 직접 입력에서는 같은 조합 종료→4ms 뒤 비조합 Enter 순서가 관측됐고, 첫 Enter가 경로를 불러오지 않고 입력·기존 헤더를 보존했다. 설정·main 상태와 엔진 중지 상태도 같았다. 별도로 누를 다음 Enter의 정상 Load는 사용자 입력을 기다리고 있으며, 그 완료 전 전체 IME 판정을 pass로 바꾸지 않는다. 고정14의 프런트엔드 소스와 빌드 파일67개는13과 바이트가 같다. 이는14에서 새로 직접 입력한 결과를 뜻하지 않는다.

## 현재 production 고정점

열네 번째 기본 `npm run package:tauri`는148.416초에 exit0이었다. 제품 source는 `fc22b28d8b4847c7f9d74a83110cfae04492eb82`, 고정 시각은 UTC `2026-10-25T09:14:10.410294+00:00`다. 고정 당시 tracked/untracked 제품 변경은 없었다. 네 산출물과 해시·검사 기록을 독립 사본으로 보존했다. 519개 staging 파일의 UTF-8/UTF-16 개인 개발 경로·가짜 서버 검출은0개, 현재 SDK helper 세 파일의 전체 바이트 포함은 모든 GUI payload에서 확인했다.

| 산출물 | SHA-256 |
| --- | --- |
| `aiolm` | `d301d61d31d8c2a8bccc996f064e090cf369056d70272c552e7431c6b68a54a8` |
| `aiolm-cli` | `04cc42a0e26636d9d98488faf8ede051e7db4da2976f179dfcae52d815e3cbde` |
| `AioLM_0.3.1_amd64.deb` | `f00ede99eb70a32482766f6e6df033d3527fae6440844e640012fbe73aa1125c` |
| `AioLM_0.3.1_amd64.AppImage` | `fd7857254121e067a7f59a34c743c9d90a34b3394f04bf5f293726f512937073` |

고정14 DEB GUI는 `15200ce5da035945d0d1a884b621c9db159582be9f654b5fad3ad4edfd4442bf`, AppImage GUI는 `6d7b4ed462617ce57d3ca83c7198e540817cdd4eee8e393e33aaecadda80778f`, AppImage CLI는 `c798a3c79cca262474a106cb74d234607e996708cbfe6432561f64277c435b44`다. Bundle marker·strip/RPATH 처리를 구분한다. 새 native CLI smoke는0.265초에 통과했다. 고정14 이후 새 flag를 가진 개인 CPU 엔진을 새로 빌드하고, CLI A01–A09를 기본 thread와 명시3의 두 설정에서 각각3.739/3.875초에 통과했다. 실제 답변5/native42+2·내용 생성 뒤 취소·재시작·제거/재등록·정상 종료와 원래 자료4,032개 해시 보존을 확인했다. 두 설정은 같은32/temp0 조건이며 새 GUI 여정은 남아 있다. 앞선12 GUI나13 CLI 실행을14 실행으로 바꾸지 않는다.

마지막 IME 수정 뒤 전체 기본 npm110.100초, Vitest220개 파일/2,571개 검사와 contracts/scripts/direct/coverage, typecheck8.983초·lint5.083초가 통과했다. 그 뒤 프런트엔드 변경은 없었다. 마지막 불완전 스냅샷 탐색 수정 뒤 전체 기본 thread/all-target/all-feature Rust175.843초·Clippy5.625초·fmt0.820초·no-default/all-target4.357초가 통과했다. 고정14는 두 Rust 파일의 수정과 동일 프런트엔드를 새로 production 빌드했다. ignored 실제 엔진 검사는 자동 검사 수치에 합치지 않는다.

최신12 CLI의 실제 CPU `launch_resources` 정상/반복 종료·준비 중 소유 프로세스 중단 뒤 UUID 회수·실행 중/잠금/불일치/symlink canary 보존이 통과했다. 고정 뒤 새로 생성한 개인 CPU 엔진의 A01–A09 두 실행도 각각 3.700/3.858초에 통과했다. 최신 GUI에서는 고정 뒤 생성한 합성 `q3c88d9`의1,030개 help/1,012개 공통 입력·실제 값9·정확한 rich argv·가림·합성 echo·프로필 재열기를 확인했다. 실제 개인 `--ped7f245-threads`는 문서화한1–32 범위/오류 거부·저장3·실제 argv/native threads3·답변5/32+2·Stop/Retry·새 PID 재시작·정상 Quit/재열기3을 확인했다. 오래된 harness 설명 문자열은 raw에 보존하고 실제 post-freeze12 해시/시각/완료 단계로 명시 정정했다. 기본 AppImage12의 실제 FUSE/extract/NO_CLEANUP·두 번째 실행·GUI 답변5와 정상 소유 정리/데이터 보존은 통과했다.

## 발견한 제품 결함과 실제 재검증

| 문제와 원인 | 수정 및 검증 범위 |
| --- | --- |
| Unix symlink 정리와 interpreter-entry 검사 fixture가 플랫폼 계약과 맞지 않음 | `303dc65`: Unix unlink/Windows junction 경계를 보존하며 fixture만 수정했다. 전체 Linux 검사 통과. |
| Strata가 64개 artifact 한도를 넘고, SONAME 별칭의 동일 canonical 파일을 help identity가 중복으로 처리함 | artifact 256개/record 256 KiB 경계를 함께 유지하고 ELF loader의 전이 의존성을 선언 root 안에서 수집한다. 별칭 관계를 fingerprint에 포함하며 대상 교환을 거부한다. 실제 191개 artifact 등록/help/실행을 확인했다. `dlopen` 전용 자료 전체 검증으로 확대하지 않는다. |
| `KEY=VALUE`, wrapped prose, 선택지 뒤 설명을 각각 equals 문법/positional/거짓 arity로 잘못 읽음 | 공통 parser5–7 수정과 원문/합성 회귀를 추가했다. 고정10 실제 vLLM wrapped prose 탐색·수락·기존 값/실행 복구를 확인했다. `67d256e`의 선택지 뒤 설명은 Unknown으로 남기며 진짜 선택지 충돌은 보존한다. 실제 이전 parser5/6 cache의 최신 parser7 stale·시작 거부·원래 값/snapshot 보존·재탐색/재수락을 확인했다. 최신12 실제 같은 vLLM 도움말320/효과328에서 거짓 arity 충돌 해소·진짜 runner 충돌 보존과 기존32/temp0 프로필의 GPU 답변5/25+13·Stop/Retry·재시작·Quit/재열기를 통과했다. |
| Python help 인코딩과 실패 진단이 옵션 근거를 오염시키거나 원인을 잃음 | `befe3a4`/`d3fce2f`: help에만 UTF-8을 적용하고 실패/잘린/읽기 오류를 옵션으로 수락하지 않는다. 제한된 진단·exit/timeout을 보존하고, stderr의 cancelled 단어로 실제 실패를 취소 처리하지 않는다. 전체 검사와 고정11 실제 exit17/overflow/60.084초 timeout·quiet Cancel·같은 명령 재시도/자손 정리가 통과했다. 도움말/GUI source가12와 같음을 확인했다. |
| 깨끗한 VM의 CPU runtime에 `libgomp.so.1`이 없음 | `25fb4ce`: DEB 의존성과 네 언어 설치 안내를 보완했다. 동일 runtime 해시에서 해당 의존성 설치 후 실제 추론이 성공했다. |
| Strata의 HTTP(S) 전용 origin 정책이 실제 WebView `tauri://localhost`를 거부함 | `b3e1017`: 명시 deployment에 있는 이 origin만 SDK bridge로 연결한다. 원본 checkout·인증·host·readiness를 유지하며 실제 HIP GUI 추론/usage/취소를 확인했다. |
| 세션 포트 누락·GPU 목록 헤더 과계수·vault 원인 없는 일반 오류 | `e454065`/`b9668ae`/`e829df6`: 기존 URL helper·indexed 장치 중복 제거·동작별 typed 복구 안내를 적용했다. 실제 GUI의 두 GPU 표시, 잠금/인증 취소/사용 불가/잠금 해제 후 같은 키 backup을 확인했다. |
| Gateway의 Anthropic/Responses가 native 최종 usage를 요청하지 않음 | `cf99641`: native count를 보존하고 누락을 명시한다. 고정8 실제 동일 요청의 직접 native·OpenAI·Anthropic·Responses가 모두 32+2=34였다. 인증·alias·취소 lease 및 모델/API 독립 종료도 확인했다. |
| exec wrapper 뒤 CLI가 과거 interpreter image를 소유 identity로 저장함 | `220d1f9`: Ready 후 실제 소유 image를 확인·저장하고 확인 불가는 실패시킨다. 고정9/10/12의 실제 CPU 정상/반복 종료·중단 회수·canary 보존으로 재검증했다. |
| 짧은 정상 SSE가 고정 500ms 전에 끝나 harness 취소 검사가 실패함 | `e99e9fd`: 실제 content/reasoning 뒤 아직 열린 stream만 취소한다. Prompt·quality32/cancel64·deadline을 늘리지 않았다. 동일 실제 vLLM Node/Rust gate와 cleanup이 통과했다. |
| AppImage runtime이 정상 종료 뒤 추출 폴더를 남기고 인스턴스가 같은 경로를 공유함 | `8454091`: pinned type2 runtime의 nftw fd 한도64와 인스턴스별 mkdtemp를 적용했다. 기본 고정8 AppImage의 FUSE/extract/NO_CLEANUP·두 번째 실행·실제 답변·0700 폴더·소유 정리/canary 보존이 통과했다. 최신12 기본 산출물도 세 모드의 GUI 답변5·두 번째 인스턴스의 정확한 GUI/CPU PID/birth/URL 유지·0700 추출/정리·원래31개 파일/4개 저장값 보존을 통과했다. |
| 실제 옵션 오류와 discard 판단이 입력/선택 소유 경계를 제대로 나타내지 못함 | `4cc7de2`: input/combobox의 ARIA 오류 연결과 runtime 선택의 dirty 판단·Enter 처리를 보완했다. 전체 검사와 실제 GUI의 ARIA/키보드/값 보존을 확인했다. 실제 한글 입력에서 조합 종료 뒤 첫 Enter가 조기 Load를 실행하는 추가 결함을 재현했다. 69a463b의 자동 회귀와 실제 재검증 범위를 구분한다. Orca 낭독은 미실행이다. |
| 실제 OS 파일 드롭이 Chat 첨부로 연결되지 않고, 첫 수정도 Wry 창 이벤트를 놓침 | `7c1b8a5`/`347c7f7`: 실제 main-window drop만 제한된 일회 UUID 선택으로 기록하고 현재 보이는 composer에서 직렬 처리한다. 고정11의 raw event/커스텀 이벤트0 실패를 보존했다. 고정12 실제 8회 드롭의 Unicode PDF·순서/중복·4개 제한/다섯째 거부·text-only 이미지 거부·composer 밖/모달 무시와 native Cancel/Tab/Space 선택이 통과했다. 실제 Smol PNG/혼합 첨부도 Ready였다. Send 동작 없이 초안·31개 파일/4개 저장값 보존·모든 소유 프로세스/포트 정리를 확인했다. |
| 설정 파일 게시가 실패한 스냅샷이 오류·Retry 기록을 남기면서 모델 목록에서는 사라짐 | `fc22b28`: 명시 다운로드 manifest를 config 파일보다 먼저 검사 대상으로 인정한다. 실제659바이트 config의 hard-link 게시 실패에서 목록0개, 같은 실제 Retry 완료 후1개가 되는 경계를 확인했다. 파일 누락·Unknown·불완전·소유권 판단은 기존 검사기에 유지한다. 공개 catalogue 회귀의 RED→GREEN과 전체 Rust 검사는 통과했으며, 실제 실패 파일 사본을 사용한 고정14 GUI 재검증은 진행 중이다. |

첨부 취소/만료와 canonicalization 완료의 경합은 실제 barrier로 RED 두 개→GREEN 두 개를 확인했고, invalid/replay/wrong-window token은 이전 읽기 권한을 취소하지 않는다. 전체 Rust 및 frontend 검사에 포함했다. 실제 드롭 검사를 합성 DOM DataTransfer·임의 경로 grant로 대체하지 않았다. Busy/reset/unmount/expiry·DPR 경계는 명시된 자동 검사 범위이며 실제 IME/이미지 정답 검사로 세지 않는다.

## 실제 엔진과 기능의 범위

- CPU는 Qwen2.5-0.5B-Instruct GGUF revision `9217f5db79a29953eb74d5343926648285ec7e67`, SHA `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`를 사용했다. Managed CPU와 실제 개인 build의 새 flag·argv·native thread·답변5/usage·Stop/Retry·재시작·Quit/이력을 확인했다. 합성 echo는 실제 추론과 별도다.
- 실제 Vulkan 두 GPU와 managed ROCm b11869의 native/GUI 추론·선택 장치·VRAM·취소/Retry·재시작·정상 종료를 확인했다. 다운로드/preflight를 추론 성공으로 쓰지 않았다. 마지막 관련 GPU 회귀는 남는다.
- 외부 vLLM 0.31.0+rocm723은 private ROCm 7.2.3/MPI4 환경이다. 고정8 Node248.998초/Rust241.650초의 native37+3, 고정8/10 및 최신12 GUI의 동일 산술32/temp0 정답5/native25+13·내용 Stop/Retry·재시작·정상 종료를 확인했다. 최신12는 원래6개 이력/258개 이전 receipt를 보존해9개 이력이 됐고, 재실행의 현재parser7/같은 fingerprint·프로필 값도 확인했다. 관리형 PyPI CUDA 설치의 AMD 실패와 구분한다.
- N05의 첫 local-archive 출처 export 거부를 보존했다. 이후 진짜 index 출처 219개 원래 wheel 해시로 만든 bundle `dd7eb6ada83407ed6246b1339c7865ab1cfb77febfadcd4503d267e70f0221ed`(3,340,062,021바이트)를 offline 새 홈에 import했다. 모든 wheel SHA·probe·실제37+3/취소·복구·재시작·종료와 별도 원래 산술32/temp0 정답5/native35+23이 통과했다. Wheel SHA/OS/ABI 손상 거부·실행 중 import 거부·실제 SIGINT 정리/같은 ZIP 재시도·기존 파일 보존도 확인했다. 첫 실패는 깊은 TMPDIR의 Unix ZMQ 경로 한도였고, 짧은 테스트 TMPDIR만 바꾼 동일 harness 반복을 별도 보존했다. 최신12 CLI에서도 같은 import 대상의 probe411개 flag·Ready35.979초·원래32/temp0 산술 정답5/35+23·정상 종료0.465초와220개 METADATA/config 보존을 확인했다. 전체 portable suite 재실행이나 SDK 없는 환경·다른 ROCm/OS·GUI import 전체 성공을 뜻하지 않는다.
- Strata는 revision `296b59d2f73c8f04a805df29c2fa97655adace78`, native SHA `fcd7121f4c52e972d69cf1d023f227e7618fdc9929f08f5fa9d9e4439df3a26e`다. 고정 모델 revision `5348543e0147355ac9cbcb031184a3546350988e`의 두 shard SHA는 `e11083ba855e7666b48ea3f2db6a9c3a20c18751a012cc24f948de91b7087fad`/`316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113`다. 약58.4GB 전체 hash와 pack/MTP 검증을 유지했다. 191개 artifact의 SDK·help·명시 bridge·HIP Ready·usage·취소/Retry·재시작·종료·MCP 반환47 후속 답변을 실제 확인했다. Ctest 103 pass/5 skip/4 fail과 원래 32-token reasoning-only 품질 실패를 보존했다. 최신12의 원래 manifest와 현재 SDK/실제 GUI12 preview manifest를 사용한 stock CLI 실행은206.588/201.988초에 각각 exit1이었다. A03/A05/A07의 원래32-token 산술 실패와 별도로 나머지6개 provenance/lifecycle 항목은 통과했다. 별도 같은32/temperature 생략 SSE는 content 없음·reasoning113자·native65+32·finish length/DONE였고 quality exit1을 보존했다. 현재 SDK options[]에 없는 요청 옵션의 GUI 전달 성공을 주장하지 않는다.
- 실제 MCP의 Yes/No·승인 대기/호출 Stop, PDF/DOCX·Nomic768/프로젝트·keyword fallback, 원본 WAV→47/STT 준비 Stop/Retry 실행 횟수1→2→2, 영상 네 part/다섯째 거부, benchmark 완료2/취소1·실제 CSV/XLSX 세 행/미리보기·개인화/지침/skill symlink 정책을 확인했다. 각 행의 남은 조합은 아래 표에 남긴다. 외부 게시나 임의 skill 실행은 하지 않았다.

이미지/영상의 색·도형 응답은 같은 원본/model/processor의 직접 native 대조에서도 틀렸다. 정확한 전송 bytes·순서·재로드 및 최신12 첨부 수락과 **F09 내용 품질 실패**를 구분한다. RAG의 ORBIT-47→47 답변 실패도 context 전송과 구분해 보존했다. 원래 Windows 품질 입력/산출물이 없으므로 동등 대조는 미실행이다. 모델 교체·정답 보정·token 증가로 통과시키지 않았다.

최신12의 별도 합성 profile에서 실제 Qwen+Smol CPU Ready·인증 API·미승인 native MCP 창을 동시에 유지한 뒤, pre-stop 없는 정상 Quit로 소유7개 PID·API/모델/inspector 포트·승인창이 정리됐다. 도구 호출은0개였다. 같은 profile 재실행은 API stopped/keynull·임시 session ID 없음이었고 config·기존31개 파일/4개 저장값·원래 runner를 보존했다. 이 사례에 활성 ffmpeg/pip/CMake 작업은 없었으므로 그 취소까지 성공했다고 하지 않는다.

실제 Qwen 요청 성공 뒤에도 native CPU 로그의 POST 줄 수는0이었다. 따라서 앞선 드롭/F14 raw의 POST0은 누적 HTTP 요청 수 근거로 쓰지 않는다. no-Send·초안/이력 보존·실제 MCP tools/call0·종료 증거는 유지하며 원본 raw는 수정하지 않았다. 별도 최신12 Chat 4회는 원래 fetch의 실제 URL/body/SSE를 관측했다. 첫 회는 method 필드가 없어 POST는 소스 계약 근거이고, 나머지3회는 POST를 직접 기록했다. 두 CPU 모델의 안내 on/off에서 system+user/user-only·대상·usage·정상 Quit/재열기4개 송신 이력이 일치했다. Qwen은5 두 번, Smol은 ` 5.`와 ` 2 + 3 = 5`로 숫자만 출력 형식은 실패했다. 같은64MiB+1 파일의 native 거부 재검사는 설치된 관측기4행→4행·초안/미디어 저장소 보존을 확인했다. 빈 미송신 대화가 비활성화되면 정리되는 기존 저장 계약은 송신 이력 손실과 구분했다.

별도 최신12 UI에서 새 프로필 두 개의 Rename/stable ID·기본 선택 중 dirty 값 보존·기본 삭제 금지·다른 프로필 Delete 취소/확인/fallback·정상 재실행을 확인했다. 한 필드 기본값/저장값 Revert/전체 옵션 초기화를 구분했고, 지침·모델·runtime·timeout 보존과 runtime 관리 복귀/Keep editing/Discard를 실제 확인했다. 엔진을 시작하지 않았고 초기화 뒤32/temp0 등 CPU 제한을 명시 복구했다. 이 CPU/default 대상의 빈 optional binding을 모든 비어 있지 않은 binding 검증으로 확대하지 않는다.

## 패키지·환경 원인·성능 검토

- 실제 공개0.3.0→로컬0.3.1 DEB 업그레이드 두 사례에서 schema12→14/원본 backup·Unicode profile/model/runtime/이력/usage 및 실제 앱 OS vault 키와 동일0600 backup을 보존했다. 설치·GIO cold/second launch·재설치·제거 뒤66개 데이터/모델 보존도 확인했다. 최신12 같은 버전 교체는 별도이며31개 파일/4개 저장값을 보존했다.
- 실제 CPU runtime ZIP `ab193fb817a363dad964575fd15cf17d27805a5d56a975d9c7da16b724741de7`의 GUI export→compiler/CMake/ROCm SDK 없는 VM 새 AppImage 홈 import→Ready/답변5를 확인했다. 64개 entry·실행 권한·라이브러리/hash/ldd를 확인했다. Python N05는 별도다.
- VM에서 같은 GUI와 새 빈 profile도 WebKit→ATK 등록 중 SIGSEGV했다. 원래 core와 실제 OS 라이브러리로 조사해 cached AT-SPI 주소의 오래된 GUID를 확인했다. 실제 socket AUTH EXTERNAL과 classic libdbus의 old/current GUID 대조 뒤 **자식 주소만** 올바르게 전달하자 같은 binary의 onboarding/Close가 성공했다. 서비스 재시작·bridge/sandbox/접근성 비활성화·제품 수정으로 우회하지 않았다. 원래 private driver/bus와 사용자 파일을 보존했다.
- 같은 Node·실제 약104MB 입력·warm-cache 조건의 새 process 각5회에서 AppImage 검증을 전체 파일 대신944,632바이트 prefix로 제한한 결과 median21.418→0.336ms/peakRSS151,880→50,468KiB였다. 앱 시작·WebView 렌더·엔진 추론·전체 빌드 속도 개선으로 확대하지 않는다.
- 책임/의존 방향은 adapter 계약·registry/launch·공통 기능을 나누어 검토했다. 새 native drop 저장소·feature hook과 공통 진단 helper는 해당 책임에 두었다. 마지막 변경의 정적 감사에서 새 고정3엔진 분기/모델 형식 추정 필터가 추가되지 않았으며, 최신12의 실제 새 합성/개인 flag 여정과 결합해 H07을 판정했다. 근거 없는 폴더 이동은 하지 않았다.
- 2026-10-25 UTC09:18의 [공식 latest API](https://api.github.com/repos/aiolm/AioLM/releases/latest) 재확인에서도 공개 최신 v0.3.1(공개2026-10-06)과 source v0.3.1이 같아 실제 새 버전 updater 설치는 blocked다. 동률 확인은 설치 판별 분기를 실행하지 않는다. 가짜 상위 버전·신뢰하지 않는 release·거부된 browser origin 우회로 대체하지 않는다. Updater native 진행률 검사는 첫/최종 바이트·기본500ms pending read·부분 쓰기·오류/취소 순서를 확인하며 write/flush 대기 상한이나 실제 다운로드 가속을 뜻하지 않는다.

## 앞선 고정점의 보존

고정8의 GUI/CLI/package 및 자동 검사·STT/gateway/AppImage 결과는 별도 raw 사본에 보존했다. 고정9는 `220d1f9` CLI 수정 뒤 GUI payload가8과 동일 바이트임을 확인했다. 고정10은 parser6 수정 뒤 GUI가 바뀌어 실제 vLLM/새 개인 엔진을 다시 검증했다. 고정11은 parser7·진단·첫 drop 구현을 포함하며 실제 drop 실패를 삭제하지 않았다. 고정12는 그 실제 실패의 WindowEvent 수정 뒤 고정했다. 고정13은 직접 한글 첫 Enter 결함의 공통 입력 수정 뒤 고정했고, 고정14는 실제 불완전 스냅샷 누락의 탐색 수정 뒤 고정했다. 서로 다른 고정점의 hash나 실행을 현재 전체 기능 성공으로 합치지 않는다.

## 74개 세부 항목

현재 60 pass / 4 fail / 1 unsupported / 8 unrun / 1 blocked다. 부분 실행은 전체 행의 pass로 확대하지 않는다.

| ID | 항목 | 판정 | 실행 근거 또는 남은 범위 |
| --- | --- | --- | --- |
| L01-S01 | 원격 저장소와 수신 ref | pass | 지정 원격 ref를 fetch했고 수신 commit과 FETCH_HEAD가 일치했다. |
| L01-S02 | 기준점·코드 보존 | pass | 필수 조상과 updater 해시가 일치했고, 검증 제품 이후 수신점까지 문서 네 개만 달랐다. |
| L01-S03 | 기존 checkout 보존 | pass | 기존 checkout·branch·다른 worktree와 변경 이력을 보존했다. |
| L01-E01 | 배포판·커널·arch·CPU·RAM·가상화 | pass | Native Ubuntu26.04.1/x86_64·kernel7·16코어/32스레드·약60GiB를 실제 확인했다. |
| L01-E02 | GPU·driver·API | pass | 실제 R9700 두 GPU의 HSA/Vulkan 열거 및 native 사용을 확인했다. 소프트웨어 렌더러와 구분했다. |
| L01-E03 | desktop 세션 | pass | GNOME Wayland·portal·tray/Secret Service·AT-SPI·Orca/IBus 설치 상태를 확인했다. 실제 낭독/IME 여정은 D02/F03에 남는다. |
| L01-E04 | 도구 버전 | pass | 고정 Node22.23.2/npm12.0.2/Rust1.98.0·작업용 CPython과 실제 시스템/WebKit 버전을 기록했다. |
| L01-E05 | native 의존성 | pass | 승인된 native 개발 패키지 설치와 pkg-config 해석을 확인했다. |
| L01-E06 | 새 의존성·binary | pass | Linux에서 npm 의존성/esbuild와 Cargo 산출물을 새로 만들었고 두 lockfile은 유지했다. |
| L01-E07 | 사용자 데이터 격리 | pass | 자식 HOME/XDG/AIOLM 격리와 VM 합성 계정 사용. 기존878/1560개 사용자 파일 중간 재검사 변경0개; 최종 재검사는 남는다. |
| L01-T01 | `npm run typecheck` | pass | 마지막 IME 프런트엔드 수정 뒤 typecheck8.983초 통과. 이후 프런트엔드 소스는 같다. |
| L01-T02 | `npm run lint` | pass | 마지막 IME 프런트엔드 수정 뒤 전체 lint5.083초 통과. 이후 프런트엔드 소스는 같다. |
| L01-T03 | `npm run test:unit` | pass | 마지막 IME 프런트엔드 수정 뒤 전체 npm110.100초, Vitest220파일/2571검사와 contracts/scripts/direct/coverage 통과. |
| L01-T04 | `npm run build` | pass | 불완전 스냅샷 탐색 수정 뒤 기본 package14의 production frontend build 통과. 빌드 파일67개는13과 같은 바이트다. |
| L01-T05 | `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | pass | 마지막 스냅샷 탐색 수정 뒤 fmt0.820초 통과. |
| L01-T06 | `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | pass | 마지막 스냅샷 탐색 수정 뒤 전체 Clippy5.625초 통과. |
| L01-T07 | `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | pass | 마지막 스냅샷 탐색 수정 뒤 전체 기본 thread/all-target/all-feature Rust175.843초 통과. 기존 실제 엔진 opt-in 범위는 별도다. |
| L01-T08 | `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets --no-default-features` | pass | 마지막 스냅샷 탐색 수정 뒤 no-default/all-target check4.357초 통과. |
| L01-T09 | `cargo build --locked --manifest-path src-tauri/Cargo.toml --bins` 후 `npm run test:native-cli` | pass | Linux debug CLI build/격리 smoke 통과. Release 결과는 T12와 구분한다. |
| L01-T10 | Python: `python3 -B -m unittest discover -s scripts/runtime-adapters -p 'test_*.py'`, `-s scripts/model-repair`, `-s scripts/provider-compatibility`, `-s src-tauri/src/providers -p '*_tests.py'`, `-s src-tauri/src/providers/tests -p 'test_*.py'`, `-s scripts -p 'test_linux_desktop.py'` | pass | 어댑터·모델복구·provider·Linux desktop Python 검사 통과. 실제 엔진 결과와 합산하지 않는다. |
| L01-T11 | `npm run test:provider-runtime` | pass | provider harness 단위/self-test 및 실제 native gate를 각각 기록했다. |
| L01-T12 | `npm run build:cli` 후 `npm run test:native-cli -- .codex-target/release/aiolm-cli` | pass | 기본 package14 CLI build와 실제 격리 native CLI smoke0.265초 통과. |
| L01-T13 | `python3 scripts/smoke-linux-vault.py` | pass | 격리 합성 Secret Service의 실제 vault CRUD smoke 통과. 앱 복구 여정은 D06이다. |
| L01-T14 | `AIOLM_TEST_PYTHON=<실제 Python> cargo test --locked --manifest-path src-tauri/Cargo.toml --test runtime_interpreter_command_journey -- --ignored` 및 같은 방식의 `runtime_positional_metadata_journey` | pass | 실제 CPython interpreter/positional metadata의 opt-in argv 검사를 실행했다. |
| L01-T15 | updater 모듈: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib app_update` | pass | Linux native updater 모듈 전체 회귀를 실행했다. 실제 업데이트와 별도다. |
| L01-H01 | 엔진 중립 등록 여정 | pass | 고정12 뒤 새 q3c88d9의 실제 wizard1030/common1012·물리 입력9·프로필·정확한 rich argv·마스킹·합성 echo·재열기9까지 확인했다. 실제 LLM과 구분한다. |
| L01-H02 | 공통 옵션 표현 | pass | 고정12 실제 같은 vLLM 도움말320/효과328에서 parser7의 거짓 arity 충돌 해소·진짜 runner 선택지 충돌 보존,32/0 실제 답변5·중지/Retry·재시작·Quit/재열기까지 통과. 알 수 없는 사실은 추정하지 않았다. |
| L01-H03 | app-owned binding | pass | CLI/GUI app-owned binding·alias/raw/metadata 거부와 명시 bridge를 확인했고, 최신12 새 엔진의 GUI→프로필→argv/native 여정으로 보존을 확인했다. |
| L01-H04 | 버전·변조 | pass | 두 build diff/값 보존·변조/OS/alias 거부와 실제 자연 상태 cache5→최신12 parser7,6→7의 stale/시작 거부/재수락·값/원래snapshot 보존 확인. 위치 인자 역할은 명시 재지정이 필요하다. |
| L01-H05 | 경합·취소·실패 | pass | 고정11 실제 exit17/overflow/60.084초 timeout의 제한된 원인 안내·거부/무변경/자손 정리/재시도와 조용한 실제 Cancel을 확인했다. 해당 source/GUI는12와 동일하며 기존 preflight/owner 경계를 보존했다. |
| L01-H06 | Linux 경로·locale | pass | CLI의 POSIX/case/Unicode/symlink/cwd/두 locale와 GUI 경로를 확인했다. 최신12는 별도 실제 tmpfs의 엔진·SDK·읽기전용 모델 경로에서 전체 A01–A09/답변5/보존·정리를 통과했다. USB 분리 검사는 아니다. |
| L01-H07 | 엔진 분기 금지 | pass | 최종 source 정적 분기/책임 감사와 고정 뒤 새 합성·실제 개인 엔진의 GUI/프로필/argv/native 여정을 함께 통과했다. |
| L01-H08 | 외부 v1 미지원 경계 | pass | 고정9 external v1의 benchmark/deep/portable 거부·opaque 크기/compatibility 안내·CSV 이력 보존을 확인했다. |
| L01-H09 | `launch_resources` Linux 정리 | pass | production12의 실제 CPU exec 종료·반복 종료·중단 UUID 회수·canary/소유 자원 정리까지 재검증했다. |
| L02-N01 | llama.cpp CPU | pass | 고정 native CPU의 CLI/GUI 실제 답변·stream/usage·중지/Retry·재시작·Quit/이력 보존을 확인했다. |
| L02-N02 | llama.cpp GPU backend | pass | 실제 Vulkan 두 GPU와 별도 managed ROCm의 CLI/GUI 추론·취소/Retry·재시작·정상 종료를 확인했다. 최종 관련 회귀는 남는다. |
| L02-N03 | 외부 llama.cpp build 어댑터 | pass | 고정12 뒤 --ped7f245-threads 생성·실제 CPU build와 CLI A01–A09 두 실행, GUI 값3/native threads3/답변5/중지·Retry·재시작·정상 Quit/재열기3 통과. |
| L02-N04 | native Linux vLLM 0.31.0 | pass | 외부 vLLM 실제 Node/Rust gate와 최신12 GUI parser7/기존COMMON32·0/답변5·native25+13/Stop·Retry/재시작/Quit·원래6개 이력 보존(전체9개)을 확인했다. 관리형 CUDA 실패와 별도다. |
| L02-N05 | vLLM portable 왕복 | pass | 진짜 index 출처219개 원래 wheel 해시의 export→새 홈 offline import→실제37+3/취소·재시작 통과. SHA/OS/ABI 손상·실행 중 거부·SIGINT 정리/같은ZIP 재시도·기존 파일 보존도 통과. 최신12 CLI도 같은 import 대상의 probe·원래32/0 산술35+23·종료/metadata 보존을 재검증했다. |
| L02-N06 | 원본 Strata | pass | 고정12 원래 manifest/current SDK 두 native stock 실행의6개 lifecycle/provenance 항목 통과, 산술32의 A03/A05/A07 실패는 보존했다. 별도 같은32 SSE는 reasoning-only/65+32/length였다. 앞선 실제 GUI/MCP 결과와 구분한다. |
| L02-N07 | 실제 개인 엔진(Strata 외) | pass | 최신12 고정 뒤 새 개인 엔진 flag의 실제 help/타입·범위·저장·argv·native 동작/추론을 확인했다. 합성 echo와 분리했다. |
| L02-N08 | MLX·vllm-metal | unsupported | MLX/Metal의 실제 플랫폼 계약은 macOS/Apple Silicon이다. Linux 미지원 근거를 기록했다. |
| L02-N09 | 원래 품질 잔여 대조(선택) | unrun | 원래 Windows 품질 입력/산출물이 없어 동등 대조는 미실행이다. 별도 Linux 입력 결과로 대체하지 않는다. |
| L02-F01 | 최초 실행·설정 이전(`src/features/onboarding`, `src-tauri/src/home.rs`, `src-tauri/src/config`) | pass | 빈 홈/구버전 이전·원본backup·미등록 session 보존·EACCES 복구 통과. 후속 VM ATK crash는 stale AT-SPI GUID를 인과 대조했고 child 주소만 복구해 같은 앱 onboarding/정상 종료를 확인했다. |
| L02-F02 | 런타임→프로필→옵션(`src/features/model-settings`, `src/features/runtimes`, `src/features/tuning`) | pass | 최신12 실제 UI의 profile 이름/ID·기본/dirty보호·Delete Cancel/Confirm/fallback·재실행, field reset/Revert/전체옵션 reset/지침·timeout 보존·runtime 관리 복귀/Keep/Discard 통과. CPU/default 대상이며 optional binding은 빈 값이었다. |
| L02-F03 | UX 품질 | fail | ARIA·작은 창·대량 옵션·키보드 결과는 유지한다. 실제 한글 첫 Enter의 조기 Load를69a463b로 수정했고 고정13 같은 native 순서에서 첫 Enter 보존을 확인했다. 별도 다음 Enter·GNOME Orca 낭독은 남아 fail 유지. |
| L02-F04 | Chat(`src/features/chat`) | pass | 실제 두 CPU 모델×안내 on/off 4회에서 정확한 대상·system 메시지 유무·SSE/usage와 저장 이력 재열기를 확인했다. Qwen은5, Smol의 숫자만 출력 형식 실패는 보존했다. 활성 빈 초안만 저장하는 기존 계약과 구분했다. |
| L02-F05 | 데이터 보존 | unrun | 각 여정의 profile/runtime/model·대화·benchmark·네 workspace 저장값을 실제 재실행/해시로 확인했다. 마지막 통합 및 원본 사용자 자료 검사를 남긴다. |
| L02-F06 | 프로젝트·RAG·문서(`src/features/projects`, `src-tauri/src/commands/documents.rs`) | pass | 실제 PDF/DOCX·Nomic768·프로젝트/namespace·명시 embedding·keyword fallback을 확인했다. 모델의 ORBIT47 내용 오류는 별도로 보존했다. |
| L02-F07 | STT·영상 전처리(`src-tauri/src/media`) | pass | 고정8 원본 WAV→47·전사 준비 Stop·실행 횟수1/2/2 재사용·네 MP4의 네 part/다섯째 거부·Quit/reopen 통과. |
| L02-F08 | MCP(`src/features/mcp`, `src-tauri/src/mcp/linux_approval.rs`) | unrun | 실제 Strata 도구 반환47·native Yes/No·대기/호출 Stop과 개인 엔진 tools=false 거부 확인. 최종 Chat 거부와 통합 소유 정리를 남긴다. |
| L02-F09 | 미디어 내용 | fail | 원본 Linux Smol 이미지/영상 질문의 내용 정확도가 native 직접 대조에서도 실패했다. 입력·모델·한도를 바꾸지 않았고 첨부 전송/순서는 별도로 확인했다. |
| L02-F10 | gateway(`src/features/developer`, `src-tauri/src/gateway`) | pass | 고정8 native 같은 요청32+2와 OpenAI/Anthropic/Responses 최종 usage 일치·인증/alias·lease 반환·API/모델 독립 종료 통과. |
| L02-F11 | 측정·공유(`src/features/bench`, `src-tauri/src/benchmark`) | pass | 실제 완료2/취소1의 native 측정·이력·CSV/XLSX·공유 미리보기를 확인했다. 업로드하지 않았다. |
| L02-F12 | 모델 탐색·관리(`src/features/discover`, `src/features/models`) | fail | 실제 GGUF 취소/재시도·삭제 보호와 CLI16개 catalogue/삭제 거부를 확인했다. config 게시 실패의 목록 누락을fc22b28로 수정했고14 GUI 재검증 중이다. GUI 묶음 삭제·같은 저장소 GGUF companion 다운로드는 별도 잔여다. |
| L02-F13 | 개인화·스킬(`src/features/settings/PersonalizationSettings.tsx`, `src-tauri/src/personalization.rs`) | pass | 개인화·AGENTS revision/초안 보존·실제 요청 반영·연결 skill/symlink 정책을 확인했다. 임의 skill 실행은 하지 않았다. |
| L02-F14 | 프로세스·포트 소유 | pass | 최신12 실제 Qwen+Smol Ready/API401·200/MCP native 승인 대기를 동시 유지한 뒤 정상 Quit로 모든 소유 PID·포트·승인창 정리, 재실행의 API key없음/임시ID없음을 확인했다. 활성 ffmpeg/pip/CMake 취소 검사는 이 사례에 포함하지 않았다. |
| L03-D01 | 파일·폴더 선택 | pass | 최신12 실제 OS 드롭8회: Unicode PDF·순서/중복·4개 제한·지원 거부·composer 밖/모달 무시와 native picker Cancel/Tab/Space 통과. Smol 실제 이미지/혼합 첨부 수락, Send 없이 초안·31파일/4저장값 보존·소유 정리 확인. 품질은 F09와 별도다. |
| L03-D02 | clipboard·IME | fail | 실제 clipboard 왕복·직접 한글 입력을 확인했다.13에서 실제 조합 종료4ms 뒤 첫 Enter가 조기 Load 없이 입력을 보존했다. 별도 다음 Enter의 정상 동작 확인 전 fail을 유지한다. |
| L03-D03 | tray | pass | 최신12 실제 host에서 Close→숨김 중 같은 CPU/포트/답변5 유지→own Show→own Quit/정리·설정false 복원 통과. host 없는 VM fallback도 별도 확인했다. Off의 Passive 등록과 활성 아이콘을 구분했다. |
| L03-D04 | 창·인스턴스 | unrun | 최초 표시·360×520/DPR1·2·두 번째 실행 복원 확인. 실제 물리화면2개 중 활성출력은1개여서 다중 활성화면 이동은 미실행이며 전역 설정을 바꾸지 않았다. |
| L03-D05 | 알림 | unrun | 최신12 실제 desktop 수신자와 own 알림ID31/정상 closure를 확인했다. 실제 banner 렌더링/사람의 수신 확인은 남는다. |
| L03-D06 | Secret Service | pass | native CRUD와 실제 앱 잠금·인증 취소·사용 불가·잠금 해제/동일 키 backup 복구 확인. 평문 대체 없음. |
| L03-D07 | 4개 언어 안내 | unrun | 네 언어의 종료/숨김·현재 버전 안내와 작은 창 줄바꿈 확인. updater 설치 가능/불가 설명의 실제 조합이 남는다. |
| L03-P01 | package 생성 | pass | 기본 package14 148.416초/519 staging 개인 경로·fake0/SDK3 전체 바이트·6개 payload 해시를 고정했다. 실제 GUI 검사는 생성과 구분한다. |
| L03-P02 | DEB 설치 수명 | pass | 별도 VM의 DEB 설치·메뉴·재설치/제거·공개 버전 업그레이드 보존과 최신12 동일버전 교체의31파일/4저장값 보존 확인. |
| L03-P03 | AppImage | pass | 기본 AppImage12의 실제 FUSE/extract/NO_CLEANUP·각GUI답변5·두 번째 인스턴스·정확한 PID/birth 유지·0700 추출/정리·canary/31파일/4저장값 보존까지 통과했다. |
| L03-P04 | 실제 업그레이드 | pass | 실제 공개0.3.0→새0.3.1 DEB의 설정/schema14·프로필/이력·앱 소유 OS vault 키와 backup 보존을 확인했다. |
| L03-P05 | runtime bundle | pass | 실제 CPU ZIP export→SDK 없는 VM 새 홈 import→Ready/추론과 실행권한/.so를 확인했다. Python은 N05에서 별도다. |
| L03-P06 | 내보내기 산출물 | pass | 실제 CSV/XLSX 세 행과 공유 미리보기·이력 재로드를 확인했다. 외부 runtime 선택 때도 기존 결과를 보존했다. |
| L03-U01 | R433 진행률 핵심 로직 회귀(L01-T15) | pass | Linux native 진행률 전체 모듈 통과. 500ms는 pending read의 미보고 확정 쓰기 간격이며 write/flush 상한이나 실제 속도 개선이 아니다. |
| L03-U02 | Linux 설치 판별 | unrun | 실제 DEB/AppImage 설치 가능 판별과 소유/arch 불일치 안내의 최종 UI 검사가 남는다. |
| L03-U03 | GUI 안내 | unrun | 현재0.3.1 재확인 안내는 실제 통과했다. 설치 가능/불가·오류/진행 및 release 이동은 미실행이다. |
| L03-U04 | 통제된 실제 업데이트 | blocked | 공개 최신 버전이 현재0.3.1과 같아 실제 새 release update가 차단됐다. 버전을 조작하거나 확인되지 않은 브라우저 이동으로 대체하지 않는다. |

## 남은 검증과 OS 인계

접근성·한글 IME, 모델 관리 일부, tray/실제 알림·창 조건, 최종 기능 조합과 데이터 보존을 이어간다. 실제 조건이 없는 updater 분기는 차단 원인과 재개점을 기록한다. 필수 fail/unrun/blocked가 남아 있으므로 goal을 complete로 표시하지 않는다.

제품·검사·계약 변경은 작업별 commit으로 고정했다. 상세 Windows W/G 및 Mac M01–M04/MAC-R01–R13 대응은 [후속 인계](engine-adapter-linux-macos-handoff.ko.md#2026-10-25-linux-수정의-수신과-재검증)를 따른다. Windows/Mac 실제 실행은 이번 Linux 결과로 pass 처리하지 않는다. Mac 실제 실행은 Linux goal의 완료 조건이 아니다. 최종 결과 문서 commit과 source 고정은 남아 있고 원격 push는 하지 않았다.
