# Linux 기기 검증 결과

2026-10-25 Linux 실행 기록이다. 전체 수락은 **진행 중**이다. 아래 판정은 해당 source와 실제 실행 범위에 한정하며, 과거 Windows 결과를 이번 Linux pass로 옮기지 않았다. 원본 명령·종료 코드·source/diff 해시·캡처와 실패 기록은 저장소의 커밋하지 않는 `tmp/linux-acceptance/`에 보관한다.

## Source와 환경

- 수신 commit은 `3e2c67d4d6dd2742ee8f9997797d31f244f234de`, 작업 branch는 `codex/linux-runtime-adapter-validation`이다. 기존 checkout·변경 이력·다른 worktree를 보존했다. 필수 조상을 확인했고, 검증 제품 `43b50686627df9631210419739544f3e5e317fc1` 이후 수신점까지는 문서 네 개만 달랐다. 수신 updater SHA-256은 `72cef2c6ee6ae39588dad6791665516c87858b05f1740d41d89c8bfb7b8e429a`다.
- 실제 환경은 Ubuntu 26.04.1 LTS x86_64/kernel 7.0.0-38-generic, EPYC 4585PX 16코어/32스레드, 약 60 GiB RAM, GNOME Wayland다. Radeon AI PRO R9700 두 GPU의 HSA/gfx1201·Vulkan 사용을 확인했다. WebKitGTK 2.52.6/GTK 3.24.52다. 이 결과는 더 오래된 glibc나 다른 배포판의 호환성 보장이 아니다.
- 승인된 native 개발 의존성과 Node 22.23.2/npm 12.0.2/Rust 1.98.0, 격리 CPython을 사용했다. Linux 의존성·바이너리를 새로 만들고 lockfile을 보존했다. 시스템 Python 3.14.4의 pip 부재 등 환경 실패는 별도 기록했다.
- 테스트 자식의 HOME/XDG/AIOLM 경로를 격리했다. 설치·업그레이드·제거는 공식 Ubuntu image 서명/SHA를 확인한 KVM VM과 합성 계정에서 실행했다. 실제 사용자 자료를 fixture로 복사하지 않았다. UTC 2026-10-25 05:59:06의 원래 878개 및 확장 1,560개 파일 해시 재검사에서 변경·누락·읽기 오류는 각각 0개였다. 모든 여정 종료 뒤 최종 검사도 수행한다.

## 현재 production 고정점

열두 번째 기본 `npm run package:tauri`가 148.870초에 exit 0이었다. Source HEAD는 `cd4e5edd2dd30e763df0c47c1d32ae7dd35de6ce`, 고정 시각은 UTC `2026-10-25T05:35:56.601092+00:00`다. Tracked diff가 없는 상태에서 네 산출물을 독립 복사본으로 보존했다. 519개 staging 파일의 UTF-8/UTF-16 개인 개발 경로 및 가짜 서버 검출은 0개였고, 현재 SDK helper 세 파일 전체 바이트가 모든 GUI payload에 포함된다.

| 산출물 | SHA-256 |
| --- | --- |
| `aiolm` | `8c6af13511dffac0315eab9dc0f30b502b23a97c01f77ed4d861516769c1e21a` |
| `aiolm-cli` | `19da7b90f4f8ec8ae3aa7c1f969c5f97114c19da38d055e38efe8af8803dd7fc` |
| `AioLM_0.3.1_amd64.deb` | `bceee6bcf689c96ed6c0692109bac1843b1cef3aa7c43c0fe2d62057db9ecd89` |
| `AioLM_0.3.1_amd64.AppImage` | `abb05fc37bed70fcbe1d7d3aff3d122e82cd9cb69d396b688134b3ab135a9b46` |

DEB GUI는 `c245bb7084e52880825d80a296c91ee479dce3c15d62542a9adb2bb6ba1f1a5a`, AppImage GUI는 `5aca647073698bc5b90424001686709694663bd200492033577e1f424afd036f`, AppImage CLI는 `83a06d64410701592ca2f5e733e50fb3a509a478b6fc7223d430fb7ba9736078`이다. Bundle marker·strip/RPATH 처리가 있으므로 release 파일과 동일 바이트라고 가정하지 않는다. AppImage prefix는 검증한 pinned runtime `f59497a100d01453b3018e1d30a9ff4ee8c27b3b00c5d3ce56c1c17476445be3`이다.

마지막 frontend 수정 뒤 전체 기본 npm 109.286초, Vitest 220개 파일/2,567개 검사와 contracts/scripts/direct/coverage가 통과했다. Typecheck 8.781초·lint 4.784초도 통과했다. 이후 바뀐 두 native 파일은 전체 기본 thread/all-target/all-feature Rust 195.406초·Clippy 5.455초·fmt 0.819초·no-default/all-target check 4.242초로 검증했다. 기본 package12의 frontend/CLI build와 실제 격리 native CLI smoke 0.169초도 통과했다. 무시된 opt-in 실제 엔진 검사는 이 자동 검사 수치에 합치지 않는다.

최신12 CLI의 실제 CPU `launch_resources` 정상/반복 종료·준비 중 소유 프로세스 중단 뒤 UUID 회수·실행 중/잠금/불일치/symlink canary 보존이 통과했다. 고정 뒤 새로 생성한 개인 CPU 엔진의 A01–A09 두 실행도 각각 3.700/3.858초에 통과했다. 최신 GUI의 새 합성/개인 엔진 여정과 최종 AppImage 수명 검사는 진행 중이다.

## 발견한 제품 결함과 실제 재검증

| 문제와 원인 | 수정 및 검증 범위 |
| --- | --- |
| Unix symlink 정리와 interpreter-entry 검사 fixture가 플랫폼 계약과 맞지 않음 | `303dc65`: Unix unlink/Windows junction 경계를 보존하며 fixture만 수정했다. 전체 Linux 검사 통과. |
| Strata가 64개 artifact 한도를 넘고, SONAME 별칭의 동일 canonical 파일을 help identity가 중복으로 처리함 | artifact 256개/record 256 KiB 경계를 함께 유지하고 ELF loader의 전이 의존성을 선언 root 안에서 수집한다. 별칭 관계를 fingerprint에 포함하며 대상 교환을 거부한다. 실제 191개 artifact 등록/help/실행을 확인했다. `dlopen` 전용 자료 전체 검증으로 확대하지 않는다. |
| `KEY=VALUE`, wrapped prose, 선택지 뒤 설명을 각각 equals 문법/positional/거짓 arity로 잘못 읽음 | 공통 parser5–7 수정과 원문/합성 회귀를 추가했다. 고정10 실제 vLLM wrapped prose 탐색·수락·기존 값/실행 복구를 확인했다. `67d256e`의 선택지 뒤 설명은 Unknown으로 남기며 진짜 선택지 충돌은 보존한다. 마지막 vLLM GUI parser7 확인은 남는다. |
| Python help 인코딩과 실패 진단이 옵션 근거를 오염시키거나 원인을 잃음 | `befe3a4`/`d3fce2f`: help에만 UTF-8을 적용하고 실패/잘린/읽기 오류를 옵션으로 수락하지 않는다. 제한된 진단·exit/timeout을 보존하고, stderr의 cancelled 단어로 실제 실패를 취소 처리하지 않는다. 전체 검사와 고정11 실제 exit17/overflow/60.084초 timeout·quiet Cancel·같은 명령 재시도/자손 정리가 통과했다. 도움말/GUI source가12와 같음을 확인했다. |
| 깨끗한 VM의 CPU runtime에 `libgomp.so.1`이 없음 | `25fb4ce`: DEB 의존성과 네 언어 설치 안내를 보완했다. 동일 runtime 해시에서 해당 의존성 설치 후 실제 추론이 성공했다. |
| Strata의 HTTP(S) 전용 origin 정책이 실제 WebView `tauri://localhost`를 거부함 | `b3e1017`: 명시 deployment에 있는 이 origin만 SDK bridge로 연결한다. 원본 checkout·인증·host·readiness를 유지하며 실제 HIP GUI 추론/usage/취소를 확인했다. |
| 세션 포트 누락·GPU 목록 헤더 과계수·vault 원인 없는 일반 오류 | `e454065`/`b9668ae`/`e829df6`: 기존 URL helper·indexed 장치 중복 제거·동작별 typed 복구 안내를 적용했다. 실제 GUI의 두 GPU 표시, 잠금/인증 취소/사용 불가/잠금 해제 후 같은 키 backup을 확인했다. |
| Gateway의 Anthropic/Responses가 native 최종 usage를 요청하지 않음 | `cf99641`: native count를 보존하고 누락을 명시한다. 고정8 실제 동일 요청의 직접 native·OpenAI·Anthropic·Responses가 모두 32+2=34였다. 인증·alias·취소 lease 및 모델/API 독립 종료도 확인했다. |
| exec wrapper 뒤 CLI가 과거 interpreter image를 소유 identity로 저장함 | `220d1f9`: Ready 후 실제 소유 image를 확인·저장하고 확인 불가는 실패시킨다. 고정9/10/12의 실제 CPU 정상/반복 종료·중단 회수·canary 보존으로 재검증했다. |
| 짧은 정상 SSE가 고정 500ms 전에 끝나 harness 취소 검사가 실패함 | `e99e9fd`: 실제 content/reasoning 뒤 아직 열린 stream만 취소한다. Prompt·quality32/cancel64·deadline을 늘리지 않았다. 동일 실제 vLLM Node/Rust gate와 cleanup이 통과했다. |
| AppImage runtime이 정상 종료 뒤 추출 폴더를 남기고 인스턴스가 같은 경로를 공유함 | `8454091`: pinned type2 runtime의 nftw fd 한도64와 인스턴스별 mkdtemp를 적용했다. 기본 고정8 AppImage의 FUSE/extract/NO_CLEANUP·두 번째 실행·실제 답변·0700 폴더·소유 정리/canary 보존이 통과했다. 최신12 actual 반복은 진행 중이다. |
| 실제 옵션 오류와 discard 판단이 입력/선택 소유 경계를 제대로 나타내지 못함 | `4cc7de2`: input/combobox의 ARIA 오류 연결과 runtime 선택의 dirty 판단·Enter 처리를 보완했다. 전체 검사와 실제 GUI의 ARIA/키보드/값 보존을 확인했다. 실제 IME composition·Orca 낭독은 별도 미실행이다. |
| 실제 OS 파일 드롭이 Chat 첨부로 연결되지 않고, 첫 수정도 Wry 창 이벤트를 놓침 | `7c1b8a5`/`347c7f7`: 실제 main-window drop만 제한된 일회 UUID 선택으로 기록하고 현재 보이는 composer에서 직렬 처리한다. 고정11의 raw event/커스텀 이벤트0 실패를 보존했다. 고정12 실제 8회 드롭의 Unicode PDF·순서/중복·4개 제한/다섯째 거부·text-only 이미지 거부·composer 밖/모달 무시와 native Cancel/Tab/Space 선택이 통과했다. 실제 Smol PNG/혼합 첨부도 Ready였다. 0개 전송·31개 파일/4개 저장값 보존·모든 소유 프로세스/포트 정리를 확인했다. |

첨부 취소/만료와 canonicalization 완료의 경합은 실제 barrier로 RED 두 개→GREEN 두 개를 확인했고, invalid/replay/wrong-window token은 이전 읽기 권한을 취소하지 않는다. 전체 Rust 및 frontend 검사에 포함했다. 실제 드롭 검사를 합성 DOM DataTransfer·임의 경로 grant로 대체하지 않았다. Busy/reset/unmount/expiry·DPR 경계는 명시된 자동 검사 범위이며 실제 IME/이미지 정답 검사로 세지 않는다.

## 실제 엔진과 기능의 범위

- CPU는 Qwen2.5-0.5B-Instruct GGUF revision `9217f5db79a29953eb74d5343926648285ec7e67`, SHA `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`를 사용했다. Managed CPU와 실제 개인 build의 새 flag·argv·native thread·답변5/usage·Stop/Retry·재시작·Quit/이력을 확인했다. 합성 echo는 실제 추론과 별도다.
- 실제 Vulkan 두 GPU와 managed ROCm b11869의 native/GUI 추론·선택 장치·VRAM·취소/Retry·재시작·정상 종료를 확인했다. 다운로드/preflight를 추론 성공으로 쓰지 않았다. 마지막 관련 GPU 회귀는 남는다.
- 외부 vLLM 0.31.0+rocm723은 private ROCm 7.2.3/MPI4 환경이다. 고정8 Node248.998초/Rust241.650초의 native37+3, 고정8/10 GUI의 동일 산술32/temp0 정답5/native25+13 및 취소·재시작·6개 이력 보존을 확인했다. 관리형 PyPI CUDA 설치의 AMD 실패와 구분한다.
- N05의 첫 local-archive 출처 export 거부를 보존했다. 이후 진짜 index 출처 219개 원래 wheel 해시로 만든 bundle `dd7eb6ada83407ed6246b1339c7865ab1cfb77febfadcd4503d267e70f0221ed`(3,340,062,021바이트)를 offline 새 홈에 import했다. 모든 wheel SHA·probe·실제37+3/취소·복구·재시작·종료와 별도 원래 산술32/temp0 정답5/native35+23이 통과했다. Wheel SHA/OS/ABI 손상 거부·실행 중 import 거부·실제 SIGINT 정리/같은 ZIP 재시도·기존 파일 보존도 확인했다. 첫 실패는 깊은 TMPDIR의 Unix ZMQ 경로 한도였고, 짧은 테스트 TMPDIR만 바꾼 동일 harness 반복을 별도 보존했다. 이 결과는 SDK 없는 환경·다른 ROCm/OS·GUI import 전체를 보장하지 않는다.
- Strata는 revision `296b59d2f73c8f04a805df29c2fa97655adace78`, native SHA `fcd7121f4c52e972d69cf1d023f227e7618fdc9929f08f5fa9d9e4439df3a26e`다. 고정 모델 revision `5348543e0147355ac9cbcb031184a3546350988e`의 두 shard SHA는 `e11083ba855e7666b48ea3f2db6a9c3a20c18751a012cc24f948de91b7087fad`/`316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113`다. 약58.4GB 전체 hash와 pack/MTP 검증을 유지했다. 191개 artifact의 SDK·help·명시 bridge·HIP Ready·usage·취소/Retry·재시작·종료·MCP 반환47 후속 답변을 실제 확인했다. Ctest 103 pass/5 skip/4 fail과 원래 32-token reasoning-only 품질 실패를 보존했다. 최신12의 원래 manifest/current SDK 대조는 진행 중이다.
- 실제 MCP의 Yes/No·승인 대기/호출 Stop, PDF/DOCX·Nomic768/프로젝트·keyword fallback, 원본 WAV→47/STT 준비 Stop/Retry 실행 횟수1→2→2, 영상 네 part/다섯째 거부, benchmark 완료2/취소1·실제 CSV/XLSX 세 행/미리보기·개인화/지침/skill symlink 정책을 확인했다. 각 행의 남은 조합은 아래 표에 남긴다. 외부 게시나 임의 skill 실행은 하지 않았다.

이미지/영상의 색·도형 응답은 같은 원본/model/processor의 직접 native 대조에서도 틀렸다. 정확한 전송 bytes·순서·재로드 및 최신12 첨부 수락과 **F09 내용 품질 실패**를 구분한다. RAG의 ORBIT-47→47 답변 실패도 context 전송과 구분해 보존했다. 원래 Windows 품질 입력/산출물이 없으므로 동등 대조는 미실행이다. 모델 교체·정답 보정·token 증가로 통과시키지 않았다.

## 패키지·환경 원인·성능 검토

- 실제 공개0.3.0→로컬0.3.1 DEB 업그레이드 두 사례에서 schema12→14/원본 backup·Unicode profile/model/runtime/이력/usage 및 실제 앱 OS vault 키와 동일0600 backup을 보존했다. 설치·GIO cold/second launch·재설치·제거 뒤66개 데이터/모델 보존도 확인했다. 최신12 같은 버전 교체는 별도이며31개 파일/4개 저장값을 보존했다.
- 실제 CPU runtime ZIP `ab193fb817a363dad964575fd15cf17d27805a5d56a975d9c7da16b724741de7`의 GUI export→compiler/CMake/ROCm SDK 없는 VM 새 AppImage 홈 import→Ready/답변5를 확인했다. 64개 entry·실행 권한·라이브러리/hash/ldd를 확인했다. Python N05는 별도다.
- VM에서 같은 GUI와 새 빈 profile도 WebKit→ATK 등록 중 SIGSEGV했다. 원래 core와 실제 OS 라이브러리로 조사해 cached AT-SPI 주소의 오래된 GUID를 확인했다. 실제 socket AUTH EXTERNAL과 classic libdbus의 old/current GUID 대조 뒤 **자식 주소만** 올바르게 전달하자 같은 binary의 onboarding/Close가 성공했다. 서비스 재시작·bridge/sandbox/접근성 비활성화·제품 수정으로 우회하지 않았다. 원래 private driver/bus와 사용자 파일을 보존했다.
- 같은 Node·실제 약104MB 입력·warm-cache 조건의 새 process 각5회에서 AppImage 검증을 전체 파일 대신944,632바이트 prefix로 제한한 결과 median21.418→0.336ms/peakRSS151,880→50,468KiB였다. 앱 시작·WebView 렌더·엔진 추론·전체 빌드 속도 개선으로 확대하지 않는다.
- 책임/의존 방향은 adapter 계약·registry/launch·공통 기능을 나누어 검토했다. 새 native drop 저장소·feature hook과 공통 진단 helper는 해당 책임에 두었다. 마지막 변경의 정적 감사에서 새 고정3엔진 분기/모델 형식 추정 필터가 추가되지 않았으며, 실제 새 flag 여정까지 확인한 뒤 최종 H07을 판정한다. 근거 없는 폴더 이동은 하지 않았다.
- 현재 공개 최신 v0.3.1과 source v0.3.1이 같아 실제 새 버전 updater 설치는 blocked다. 동률 확인은 설치 판별 분기를 실행하지 않는다. 가짜 상위 버전·신뢰하지 않는 release·거부된 browser origin 우회로 대체하지 않는다. Updater native 진행률 검사는 첫/최종 바이트·기본500ms pending read·부분 쓰기·오류/취소 순서를 확인하며 write/flush 대기 상한이나 실제 다운로드 가속을 뜻하지 않는다.

## 앞선 고정점의 보존

고정8의 GUI/CLI/package 및 자동 검사·STT/gateway/AppImage 결과는 별도 raw 사본에 보존했다. 고정9는 `220d1f9` CLI 수정 뒤 GUI payload가8과 동일 바이트임을 확인했다. 고정10은 parser6 수정 뒤 GUI가 바뀌어 실제 vLLM/새 개인 엔진을 다시 검증했다. 고정11은 parser7·진단·첫 drop 구현을 포함하며 실제 drop 실패를 삭제하지 않았다. 고정12는 그 실제 실패의 WindowEvent 수정 뒤 고정했다. 서로 다른 고정점의 hash나 실행을 현재 전체 기능 성공으로 합치지 않는다.

## 74개 세부 항목

현재 52 pass / 2 fail / 1 unsupported / 18 unrun / 1 blocked다. 부분 실행은 전체 행의 pass로 확대하지 않는다.

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
| L01-T01 | `npm run typecheck` | pass | 최종 도움말/wizard 수정 후 typecheck8.781초 통과. |
| L01-T02 | `npm run lint` | pass | 최종 도움말/wizard 수정 후 전체 lint4.784초 통과. |
| L01-T03 | `npm run test:unit` | pass | 최종 전체 npm109.286초, Vitest220파일/2567검사와 contracts/scripts/direct/coverage 통과. |
| L01-T04 | `npm run build` | pass | 최종 main WindowEvent 수정 후 기본 package12의 production frontend build 통과. |
| L01-T05 | `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | pass | 최종 main WindowEvent 수정 후 fmt0.819초 통과. |
| L01-T06 | `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | pass | 최종 main WindowEvent 수정 후 전체 Clippy5.455초 통과. |
| L01-T07 | `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | pass | 최종 main WindowEvent 수정 전체 Rust195.406초 통과. 첨부 취소 ticket/도움말 진단의 전체 검사도 별도 보존했다. |
| L01-T08 | `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets --no-default-features` | pass | 최종 main WindowEvent 수정 후 no-default/all-target check4.242초 통과. |
| L01-T09 | `cargo build --locked --manifest-path src-tauri/Cargo.toml --bins` 후 `npm run test:native-cli` | pass | Linux debug CLI build/격리 smoke 통과. Release 결과는 T12와 구분한다. |
| L01-T10 | Python: `python3 -B -m unittest discover -s scripts/runtime-adapters -p 'test_*.py'`, `-s scripts/model-repair`, `-s scripts/provider-compatibility`, `-s src-tauri/src/providers -p '*_tests.py'`, `-s src-tauri/src/providers/tests -p 'test_*.py'`, `-s scripts -p 'test_linux_desktop.py'` | pass | 어댑터·모델복구·provider·Linux desktop Python 검사 통과. 실제 엔진 결과와 합산하지 않는다. |
| L01-T11 | `npm run test:provider-runtime` | pass | provider harness 단위/self-test 및 실제 native gate를 각각 기록했다. |
| L01-T12 | `npm run build:cli` 후 `npm run test:native-cli -- .codex-target/release/aiolm-cli` | pass | 기본 package12 CLI build와 실제 격리 native CLI smoke0.169초 통과. |
| L01-T13 | `python3 scripts/smoke-linux-vault.py` | pass | 격리 합성 Secret Service의 실제 vault CRUD smoke 통과. 앱 복구 여정은 D06이다. |
| L01-T14 | `AIOLM_TEST_PYTHON=<실제 Python> cargo test --locked --manifest-path src-tauri/Cargo.toml --test runtime_interpreter_command_journey -- --ignored` 및 같은 방식의 `runtime_positional_metadata_journey` | pass | 실제 CPython interpreter/positional metadata의 opt-in argv 검사를 실행했다. |
| L01-T15 | updater 모듈: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib app_update` | pass | Linux native updater 모듈 전체 회귀를 실행했다. 실제 업데이트와 별도다. |
| L01-H01 | 엔진 중립 등록 여정 | pass | 고정8/10/11 뒤 새 합성 flag의 실제 GUI 등록/help·1030옵션·rich argv·프로필·명시된 합성 echo를 확인했다. 최신12 실제 여정의 최종 보고를 검토 중이다. |
| L01-H02 | 공통 옵션 표현 | fail | 실제 vLLM의 두 parser 결함 중 wrapped prose는 고정10 GUI로 해결했다. 선택지 뒤 prose의 거짓 arity는67d256e/parser7로 수정·전체 Rust 통과; 다음 production 실제 재검사가 남는다. |
| L01-H03 | app-owned binding | unrun | CLI binding/raw/alias/metadata/명시 bridge와 실제 GUI app-owned 거부·저장값 보존 보고를 검토했다. 마지막 production 영향 재검증은 남는다. |
| L01-H04 | 버전·변조 | unrun | 두 build의 GUI diff·값 보존/복구·CLI 변조/OS/alias 거부와 실제 nested 합성 profile의6→7 stale/재수락을 확인했다. 원래5 cache의 실제 재검사 위치를 찾고 있다. |
| L01-H05 | 경합·취소·실패 | pass | 고정11 실제 exit17/overflow/60.084초 timeout의 제한된 원인 안내·거부/무변경/자손 정리/재시도와 조용한 실제 Cancel을 확인했다. 해당 source/GUI는12와 동일하며 기존 preflight/owner 경계를 보존했다. |
| L01-H06 | Linux 경로·locale | pass | CLI의 POSIX/case/Unicode/symlink/cwd/두 locale와 GUI 경로를 확인했다. 최신12는 별도 실제 tmpfs의 엔진·SDK·읽기전용 모델 경로에서 전체 A01–A09/답변5/보존·정리를 통과했다. USB 분리 검사는 아니다. |
| L01-H07 | 엔진 분기 금지 | unrun | 최종 source 정적 감사에서 새 engine 분기/고정3엔진·모델 형식 추정 추가가 없었다. 최신12 새 엔진 실제 여정의 보고와 함께 최종 판정한다. |
| L01-H08 | 외부 v1 미지원 경계 | pass | 고정9 external v1의 benchmark/deep/portable 거부·opaque 크기/compatibility 안내·CSV 이력 보존을 확인했다. |
| L01-H09 | `launch_resources` Linux 정리 | pass | production12의 실제 CPU exec 종료·반복 종료·중단 UUID 회수·canary/소유 자원 정리까지 재검증했다. |
| L02-N01 | llama.cpp CPU | pass | 고정 native CPU의 CLI/GUI 실제 답변·stream/usage·중지/Retry·재시작·Quit/이력 보존을 확인했다. |
| L02-N02 | llama.cpp GPU backend | pass | 실제 Vulkan 두 GPU와 별도 managed ROCm의 CLI/GUI 추론·취소/Retry·재시작·정상 종료를 확인했다. 최종 관련 회귀는 남는다. |
| L02-N03 | 외부 llama.cpp build 어댑터 | pass | 고정12 뒤 새 개인 CPU flag 생성·빌드와 최신 CLI A01–A09 두 실행이 통과했다. 실제 최신 GUI 여정은 진행 중이다. |
| L02-N04 | native Linux vLLM 0.31.0 | pass | 외부 vLLM0.31.0+rocm723의 실제 Node/Rust gate와 고정8/10 GUI 품질25+13·Stop/Retry·재시작·6개 이력 보존 통과. 관리형 CUDA 실패는 별도다. |
| L02-N05 | vLLM portable 왕복 | pass | 진짜 index 출처219개 원래 wheel 해시의 export→새 홈 offline import→실제37+3/취소·재시작 통과. SHA/OS/ABI 손상·실행 중 거부·SIGINT 정리/같은ZIP 재시도·기존 파일 보존도 통과. |
| L02-N06 | 원본 Strata | pass | 고정 revision Strata의 실제 HIP 추론·usage·MCP 반환47·취소/Retry·재시작/정상 종료 확인. 원래32-token reasoning 품질 실패는 보존했다. |
| L02-N07 | 실제 개인 엔진(Strata 외) | pass | 앱 고정 뒤 만든 실제 개인 CPU 엔진의 새 flag·도움말·argv·native 동작을 확인했다. 합성 응답과 구분했다. |
| L02-N08 | MLX·vllm-metal | unsupported | MLX/Metal의 실제 플랫폼 계약은 macOS/Apple Silicon이다. Linux 미지원 근거를 기록했다. |
| L02-N09 | 원래 품질 잔여 대조(선택) | unrun | 원래 Windows 품질 입력/산출물이 없어 동등 대조는 미실행이다. 별도 Linux 입력 결과로 대체하지 않는다. |
| L02-F01 | 최초 실행·설정 이전(`src/features/onboarding`, `src-tauri/src/home.rs`, `src-tauri/src/config`) | pass | 빈 홈/구버전 이전·원본backup·미등록 session 보존·EACCES 복구 통과. 후속 VM ATK crash는 stale AT-SPI GUID를 인과 대조했고 child 주소만 복구해 같은 앱 onboarding/정상 종료를 확인했다. |
| L02-F02 | 런타임→프로필→옵션(`src/features/model-settings`, `src/features/runtimes`, `src/features/tuning`) | unrun | 런타임·프로필·옵션의 실제 여러 여정과 재실행 보존을 확인했다. 이름/기본/삭제·전체 초기화 등 남은 세부 동작을 최종 대조한다. |
| L02-F03 | UX 품질 | unrun | ARIA 오류·키보드/포커스·1000개 이상 옵션·360×520/DPR1·2를 실제 확인했다. 실제 Orca 낭독과 한글 IME는 남는다. |
| L02-F04 | Chat(`src/features/chat`) | unrun | 실제 CPU/GPU/vLLM/개인 엔진 stream·usage·부분 Stop/Retry·재시작·Quit/이력과 미디어 순서를 확인했다. 자동 안내 on/off·멀티 세션의 최종 조합은 남는다. |
| L02-F05 | 데이터 보존 | unrun | 각 여정의 profile/runtime/model·대화·benchmark·네 workspace 저장값을 실제 재실행/해시로 확인했다. 마지막 통합 및 원본 사용자 자료 검사를 남긴다. |
| L02-F06 | 프로젝트·RAG·문서(`src/features/projects`, `src-tauri/src/commands/documents.rs`) | pass | 실제 PDF/DOCX·Nomic768·프로젝트/namespace·명시 embedding·keyword fallback을 확인했다. 모델의 ORBIT47 내용 오류는 별도로 보존했다. |
| L02-F07 | STT·영상 전처리(`src-tauri/src/media`) | pass | 고정8 원본 WAV→47·전사 준비 Stop·실행 횟수1/2/2 재사용·네 MP4의 네 part/다섯째 거부·Quit/reopen 통과. |
| L02-F08 | MCP(`src/features/mcp`, `src-tauri/src/mcp/linux_approval.rs`) | unrun | 실제 Strata 도구 반환47·native Yes/No·대기/호출 Stop과 개인 엔진 tools=false 거부 확인. 최종 Chat 거부와 통합 소유 정리를 남긴다. |
| L02-F09 | 미디어 내용 | fail | 원본 Linux Smol 이미지/영상 질문의 내용 정확도가 native 직접 대조에서도 실패했다. 입력·모델·한도를 바꾸지 않았고 첨부 전송/순서는 별도로 확인했다. |
| L02-F10 | gateway(`src/features/developer`, `src-tauri/src/gateway`) | pass | 고정8 native 같은 요청32+2와 OpenAI/Anthropic/Responses 최종 usage 일치·인증/alias·lease 반환·API/모델 독립 종료 통과. |
| L02-F11 | 측정·공유(`src/features/bench`, `src-tauri/src/benchmark`) | pass | 실제 완료2/취소1의 native 측정·이력·CSV/XLSX·공유 미리보기를 확인했다. 업로드하지 않았다. |
| L02-F12 | 모델 탐색·관리(`src/features/discover`, `src/features/models`) | unrun | 실제 Hub immutable GGUF 검색/다운로드·26% 취소/재시도·Ready·활성 삭제 보호 확인. shards/snapshot/companion·불완전/hard-link 실패·외부 삭제 보호가 남는다. |
| L02-F13 | 개인화·스킬(`src/features/settings/PersonalizationSettings.tsx`, `src-tauri/src/personalization.rs`) | pass | 개인화·AGENTS revision/초안 보존·실제 요청 반영·연결 skill/symlink 정책을 확인했다. 임의 skill 실행은 하지 않았다. |
| L02-F14 | 프로세스·포트 소유 | unrun | 여러 실제 엔진/API/전처리의 개별 정상 종료와 소유 port/PID 정리 확인. 두 모델+API+MCP 승인 동시 Quit 조합은 남는다. |
| L03-D01 | 파일·폴더 선택 | pass | 최신12 실제 OS 드롭8회: Unicode PDF·순서/중복·4개 제한·지원 거부·composer 밖/모달 무시와 native picker Cancel/Tab/Space 통과. Smol 실제 이미지/혼합 첨부 수락,0POST·31파일/4저장값 보존·소유 정리 확인. 품질은 F09와 별도다. |
| L03-D02 | clipboard·IME | unrun | 실제 Copy→OS clipboard 및 OS clipboard→Ctrl+V 입력 통과. 실제 한글 조합/조합 중 Enter는 미실행이다. |
| L03-D03 | tray | unrun | tray host 없는 VM의 숨김 방지/안내·저장true fallback 종료 확인. host 있는 desktop의 실제 숨김/추론 유지/Show/Quit가 남는다. |
| L03-D04 | 창·인스턴스 | unrun | 실제 최초 표시·360×520/DPR1·2·minimize 뒤 두 번째 실행 복원 확인. 다중 monitor 조건의 검사는 남는다. |
| L03-D05 | 알림 | unrun | notifications host 없는 VM의 제출/실패 뒤 앱 유지 확인. 실제 desktop 수신은 미실행이다. |
| L03-D06 | Secret Service | pass | native CRUD와 실제 앱 잠금·인증 취소·사용 불가·잠금 해제/동일 키 backup 복구 확인. 평문 대체 없음. |
| L03-D07 | 4개 언어 안내 | unrun | 네 언어의 종료/숨김·현재 버전 안내와 작은 창 줄바꿈 확인. updater 설치 가능/불가 설명의 실제 조합이 남는다. |
| L03-P01 | package 생성 | pass | 기본 package12 148.870초/519 staging 개인정보·fake0/SDK3 전체 바이트·6payload 해시 고정. |
| L03-P02 | DEB 설치 수명 | pass | 별도 VM의 DEB 설치·메뉴·재설치/제거·공개 버전 업그레이드 보존과 최신12 동일버전 교체의31파일/4저장값 보존 확인. |
| L03-P03 | AppImage | pass | 기본 AppImage8의 실제 FUSE/extract/NO_CLEANUP·두 번째 인스턴스·실제 답변5·소유 정리와 desktop 등록/제거 확인. |
| L03-P04 | 실제 업그레이드 | pass | 실제 공개0.3.0→새0.3.1 DEB의 설정/schema14·프로필/이력·앱 소유 OS vault 키와 backup 보존을 확인했다. |
| L03-P05 | runtime bundle | pass | 실제 CPU ZIP export→SDK 없는 VM 새 홈 import→Ready/추론과 실행권한/.so를 확인했다. Python은 N05에서 별도다. |
| L03-P06 | 내보내기 산출물 | pass | 실제 CSV/XLSX 세 행과 공유 미리보기·이력 재로드를 확인했다. 외부 runtime 선택 때도 기존 결과를 보존했다. |
| L03-U01 | R433 진행률 핵심 로직 회귀(L01-T15) | pass | Linux native 진행률 전체 모듈 통과. 500ms는 pending read의 미보고 확정 쓰기 간격이며 write/flush 상한이나 실제 속도 개선이 아니다. |
| L03-U02 | Linux 설치 판별 | unrun | 실제 DEB/AppImage 설치 가능 판별과 소유/arch 불일치 안내의 최종 UI 검사가 남는다. |
| L03-U03 | GUI 안내 | unrun | 현재0.3.1 재확인 안내는 실제 통과했다. 설치 가능/불가·오류/진행 및 release 이동은 미실행이다. |
| L03-U04 | 통제된 실제 업데이트 | blocked | 공개 최신 버전이 현재0.3.1과 같아 실제 새 release update가 차단됐다. 버전을 조작하거나 확인되지 않은 브라우저 이동으로 대체하지 않는다. |

## 남은 검증과 OS 인계

최신 GUI의 새 엔진/최종 parser7, 접근성·한글 IME, 모델 관리 일부, tray/실제 알림·창 조건, 두 모델/API/MCP의 동시 종료 조합과 최종 데이터 보존을 이어간다. 실제 조건이 없는 updater 분기는 차단 원인과 재개점을 기록한다. 필수 fail/unrun/blocked가 남아 있으므로 goal을 complete로 표시하지 않는다.

제품·검사·계약 변경은 작업별 commit으로 고정했다. 상세 Windows W/G 및 Mac M01–M04/MAC-R01–R13 대응은 [후속 인계](engine-adapter-linux-macos-handoff.ko.md#2026-10-25-linux-수정의-수신과-재검증)를 따른다. Windows/Mac 실제 실행은 이번 Linux 결과로 pass 처리하지 않는다. Mac 실제 실행은 Linux goal의 완료 조건이 아니다. 최종 결과 문서 commit과 source 고정은 남아 있고 원격 push는 하지 않았다.
