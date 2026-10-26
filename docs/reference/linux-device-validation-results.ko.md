# Linux 기기 검증 결과

최신 추가 검증은 아래 [고정19 새 엔진 전체 여정과 최종 보존 검사](#고정19-새-엔진-전체-여정과-최종-보존-검사), [고정19 알림 연결 수정](#고정19-알림-연결-수정과-실제-재검증), [최소화 상태의 실제 채팅 완료](#고정19-최소화-상태의-실제-채팅-완료), [OS 접근성 표시 관찰](#고정19-os-접근성-표시-관찰), [실제 알림 서비스 부재와 앱 회복](#고정19-실제-알림-서비스-부재와-앱-회복)에 기록했다. 제품 `37c0343`의 동일 바이트 빌드에서 연결 수명 결함 해소·백그라운드 제출·실제 전송 실패 뒤 앱 동작 유지를 확인했다. 정확한 테스트 문구의 Shell 객체 생성도 확인했으나 실제 표시는 입증하지 못했다. 전체 집계는65 pass/1 fail/6 unrun/1 unsupported/1 blocked로 유지한다.

고정18 결과의 근거 마감은 UTC2026-10-25T18:46:35.549445Z/KST2026-10-26T03:46:35.549445+09:00다. **고정18의 새 옵션 GUI 등록·저장/실제 CPU 동작, 두 정상 Close·재열기, 네 언어 최소 창·native DPR2·빠른 검색을 확인했고 원래 대표 UX 범위 F03은 root 판정으로 pass다. Core의 원래 exit1·등록 metadata 감사와 RAPID 실패는 그대로 보존한다. 최종18 ROCm CLI의 실제 offload/추론·내용 취소/같은 PID HTTP 재요청·재시작/정상 종료와 최종 사용자 자료 guard도 완료했다. 다른 backend/GUI로 확대하지 않는다.** 실제 실행 시각은 2026-10-25 UTC 기준으로 기록한다. 후속 문서 정리 시각은 KST 2026-10-26이지만 실행 날짜를 옮기지 않는다. 전체 수락은 **진행 중**이다. 아래 판정은 해당 source와 실제 실행 범위에 한정하며, 과거 Windows 결과를 이번 Linux pass로 옮기지 않았다. 원본 명령·종료 코드·source/diff 해시·캡처와 실패 기록은 저장소의 커밋하지 않는 `tmp/linux-acceptance/`에 보관한다.

## Source와 환경

- 수신 commit은 `3e2c67d4d6dd2742ee8f9997797d31f244f234de`, 작업 branch는 `codex/linux-runtime-adapter-validation`이다. 기존 checkout·변경 이력·다른 worktree를 보존했다. 필수 조상을 확인했고, 검증 제품 `43b50686627df9631210419739544f3e5e317fc1` 이후 수신점까지는 문서 네 개만 달랐다. 수신 updater SHA-256은 `72cef2c6ee6ae39588dad6791665516c87858b05f1740d41d89c8bfb7b8e429a`다.
- 실제 환경은 Ubuntu 26.04.1 LTS x86_64/kernel 7.0.0-38-generic, EPYC 4585PX 16코어/32스레드, 약 60 GiB RAM, GNOME Wayland다. Radeon AI PRO R9700 두 GPU의 HSA/gfx1201·Vulkan 사용을 확인했다. WebKitGTK 2.52.6/GTK 3.24.52다. 이 결과는 더 오래된 glibc나 다른 배포판의 호환성 보장이 아니다.
- 승인된 native 개발 의존성과 Node 22.23.2/npm 12.0.2/Rust 1.98.0, 격리 CPython을 사용했다. Linux 의존성·바이너리를 새로 만들고 lockfile을 보존했다. 시스템 Python 3.14.4의 pip 부재 등 환경 실패는 별도 기록했다.
- 테스트 자식의 HOME/XDG/AIOLM 경로를 격리했다. 설치·업그레이드·제거는 공식 Ubuntu image 서명/SHA를 확인한 KVM VM과 합성 계정에서 실행했다. 실제 사용자 자료를 fixture로 복사하지 않았다. UTC 2026-10-25 07:47:30의 원래 878개 및 확장 1,560개 파일 해시 재검사에서 변경·누락·읽기 오류는 각각 0개였다. 이후 UTC18:05:13의 실제 DPR2 종료 뒤와18:39:49의 private 정리 뒤878/1,560개 재검사도 각각 변경·누락·오류0개였다. 최종 GPU와 private 정리 뒤 UTC18:46:35의 마지막878/1,560개 hash-only 검사도 변경·누락·오류0개였으며 실사용 자료를 복사하지 않았다.

GNOME Wayland 세션의 자식 X11 backend 창에서 직접 입력한 한글의 실제 native229·조합 입력·compositionend를 확인했다. 마지막 조합 종료4ms 뒤 Enter가 keyCode13/isComposing=false로 전달되며 첫 Enter에 모델 경로를 불러오는 결함이 고정12에서 재현됐다. 설정 저장·모델 시작은 없었고, 정상 Discard/Close 후 원래 설정과 main IBus/접근성 상태는 그대로였다. 기존 Chat의 상태 기반 IME 보호를 공통 입력 로직으로 옮긴 `69a463b`는 실제 순서를 재현한 RED4→관련195개·전체 npm110.100초/220파일·2,571개·typecheck8.983초·lint5.083초를 통과했다. 고정13의 같은 실제 조합 종료→4ms 뒤 첫 비조합 Enter는 경로를 Load하지 않고 기존 헤더/입력을 보존했다. 이후 사용자가 별도로 누른 실제 End→Enter에서도 trusted/key13/isComposing=false/nonrepeat와 정확한 한글 경로의 정상 Load·입력139자 유지가 확인됐다. 원래27개 event prefix와 현재36개 기록을 그대로 보존했고 설정/main 상태·allStopped/noSave는 같았다. 캡처 뒤 defaultPreventedAfter의 측정 시점은 확인되지 않아 동작 보호의 근거로 쓰지 않는다. **D02의 실제 clipboard·해당 IME 경계는 pass**이며 이후 정상 Discard/Close·소유 GUI/WebKit/포트 정리·기존 main driver 유지와 config/main 상태 보존도 완료했다. 이는 main/manual13만의 정리이며 별도 private17 전체 종료를 뜻하지 않는다. 이 직접 입력 단독 결과를 일반 접근성 인증이나17 GUI 성공으로 확대하지 않으며, 후속 실제 Reader/최종18 대표 UX 판정은 아래와 구분한다. 고정14의 frontend67파일이13과 같았던 사실도 새 직접 입력 pass를 뜻하지 않는다.

## 고정18 production 기준선

열여덟 번째 기본 `npm run package:tauri`는139.034초에 exit0이었다. 제품 source는 `9f9dbac921ca5837aa5e9594658362d872a79d5f`, 고정 시각은 UTC `2026-10-25T15:36:16.107862+00:00`다. 고정 당시 tracked/untracked 제품 변경은 없었다. 네 산출물과 네 검사/해시 기록을 독립 archive 사본8개로 보존하고, 그8개 사본의 SHA·크기·nlink1을 별도로 확인했다. 원래 Cargo release GUI/CLI의 알려진 nlink2와 archive 사본의 링크 수를 구분한다. Release/DEB/AppImage의 GUI·CLI 여섯 payload를 검사했고, 519개 staging 파일의 UTF-8/UTF-16 개인 개발 경로·가짜 서버 검출은0개였다. 현재 SDK helper 세 파일의 전체 바이트 포함도 모든 GUI payload에서 확인했다.

| 산출물 | SHA-256 |
| --- | --- |
| `aiolm` | `736eabccc8acbfa488a01734b49898bae6327395bf03bdc7f6da4fdff3ecbe0f` |
| `aiolm-cli` | `46fd206dc92eb8babfe65ac4f70538767bdaa9101f9a6a60ea54aada126bd7d9` |
| `AioLM_0.3.1_amd64.deb` | `f70b53b3fa0da3116d8b72b7d70bb06d131155dd19be113fe2c1263300ca02b4` |
| `AioLM_0.3.1_amd64.AppImage` | `c63e001e60276c8b0e19aeedc509ef770e68f5cb7ba936c0e47fc6b3852ec80b` |

고정18 release GUI는 `736eabccc8acbfa488a01734b49898bae6327395bf03bdc7f6da4fdff3ecbe0f`, release/DEB CLI는 `46fd206dc92eb8babfe65ac4f70538767bdaa9101f9a6a60ea54aada126bd7d9`다. DEB GUI는 `2214b89582aeb20dbcd15a53478cbc0f0efea4dc22d932e46bdc0b04e1372f44`, AppImage GUI는 `c975f340b232724f5016986098ea62c1510f84a3c7850feaf1298f0d45a2a012`, AppImage CLI는 `555e94d992bf7a84672b8014b9dc7a5d02314f81feade8f078e8594aead1512c`다. DEB/AppImage 파일은 각각 `f70b53b3fa0da3116d8b72b7d70bb06d131155dd19be113fe2c1263300ca02b4`/`c63e001e60276c8b0e19aeedc509ef770e68f5cb7ba936c0e47fc6b3852ec80b`이며 bundle marker·strip/RPATH 처리에 따른 payload 차이를 구분한다. 새 native CLI smoke는0.260초에 통과했다.

고정18의 실제 GUI를 열기 전에 UTC15:45:01/03에 새 합성 `qb420d5`와 개인 `--pefcaecb-threads`를 생성했다. 원래 upstream/pin·12줄 alias 패치·license·같은 Qwen 모델을 유지한 CPU 전용 build는32.381초였고, native SHA는 `d34faa943eb3f7ee72144f90deec3ebefc5cbc11984a389426ba2802b3b9eec1`다. 새 이름은 고정 여섯 payload와 tracked source에서 검출되지 않았다. 고정한18 CLI의 A01–A09는 기본 thread/명시3에서 각각3.712/3.882초에 통과했다. 실제 답변5/native42+2=44·내용 생성 뒤 취소·같은 서버 유지·재시작·제거/재등록·정상 종료를 확인했고 소유6개 PID/두 포트는 모두 닫혔다. 원래17 입력4,033개·독립 archive8개·고정 여섯 payload 해시는 같았으며 새 산출물4,009개를 별도 색인했다. 이 CLI 검사의 원래 조건은 산술 max_tokens32·별도 취소 max_tokens1024이며 HTTP 본문에 temperature를 지정하지 않았다. 이전의 CLI temp0 설명을 원본 요청에 맞게 정정하며, 아래 GUI의32/T0 조건과 구분한다. 이 생성·CLI 검사 자체를 GUI 성공으로 바꾸지 않으며, 이후 실제18 GUI의 별도 근거는 아래에 기록한다.

고정18 CSS와 같은 최종 diff에서 전체 기본 npm110.497초, Vitest220개 파일/2,577개 검사와 contracts/scripts/direct/coverage, typecheck8.609초·lint4.783초가 통과했다. 검사 때17 source 위의 CSS diff `e0f7f0c057628123a4fca949eb2c5d2bd5e211a6afaf18c8d73f32e89c611b86`를 사용했고, 이를9f9dbac으로 commit한 뒤 기본 package/CLI smoke를 실행했다. 17의 알려진 수치 범위/민감 값 보호는 별도 의미 있는 RED5개와 민감 값 RED 뒤 관련84개·전체 frontend 통과 기록을 그대로 유지한다.

17→18 제품 변경은 공통 모델 설정 scroll 영역의 주석과 `scroll-padding-block: 1em`뿐이다. 키보드로 이동한 입력을 scrollport 가장자리에서 띄우기 위한 CSS이며 JS 상태·schema·API·검증·Save·IME·engine 동작을 바꾸지 않았다. 16→17 범위 표시 수정과 이후18에서도 native/src-tauri·scripts·lockfile 바이트는 같다. 마지막16 GGUF 수정 뒤 전체 기본 thread/all-target/all-feature Rust170.747초·Clippy4.657초·fmt0.795초·no-default/all-target3.132초와 관련 artifact16개4.795초 결과를 동일 native 소스의 근거로 유지한다. 이를17/18에서 다시 실행한 Rust나 VM 결과라고 하지 않는다. ignored 실제 엔진 검사도 자동 검사 수치에 합치지 않는다.

고정12 CLI의 실제 CPU `launch_resources` 정상/반복 종료·준비 중 소유 프로세스 중단 뒤 UUID 회수·실행 중/잠금/불일치/symlink canary 보존이 통과했다. 고정 뒤 새로 생성한 개인 CPU 엔진의 A01–A09 두 실행도 각각 3.700/3.858초에 통과했다. 고정12 GUI에서는 고정 뒤 생성한 합성 `q3c88d9`의1,030개 help/1,012개 공통 입력·실제 값9·정확한 rich argv·가림·합성 echo·프로필 재열기를 확인했다. 실제 개인 `--ped7f245-threads`는 문서화한1–32 범위/오류 거부·저장3·실제 argv/native threads3·답변5/32+2·Stop/Retry·새 PID 재시작·정상 Quit/재열기3을 확인했다. 오래된 harness 설명 문자열은 raw에 보존하고 실제 post-freeze12 해시/시각/완료 단계로 명시 정정했다. 기본 AppImage12의 실제 FUSE/extract/NO_CLEANUP·두 번째 실행·GUI 답변5와 정상 소유 정리/데이터 보존은 통과했다.

고정16 private X11 GUI의 새 합성 flat은 help1,030/common1,012·새 값9·정확한 rich argv·마스킹·명시 SYNTHETIC echo·저장9 재열기까지 실제 통과했다. 실제 개인 엔진은 현재 help263/문서화1–32,0·33·abc 거부와 linked error/모든 Save 차단→유효한 **미저장3**·32/temp0·고유 native SHOWING/FOCUSED/EDITABLE leaf까지만 확인했다. 개인 Save/native argv/답변·Reader는 실행하지 않았다. 정상 controller cleanup→Discard→Close로 F08의 기존6개 nonconfig 파일·기존 provider 옵션/프로필·소유 자원과 main 상태를 보존했다. Close 직전 네 UI localStorage 키의 별도 snapshot은 없었으므로 초기16 snapshot을 post-flat 현재 baseline으로 바꾸지 않는다. New chat의 의도한 active-conversation 변경도 보존한다. 17의 별도 실제 실행은 다음 범위까지만 진행됐다.

고정17 private X11 GUI에서 고정 후 만든 새 합성 `q270e5c`는 실제 help1,030/common1,012·입력9·정확한 rich argv·민감 값 가림·명시 SYNTHETIC echo와 저장9 재열기까지 통과했다. DOM input을 쓴 경로/검색과 실제 WebDriver 키 입력을 쓴 옵션을 raw에 구분하며 물리 IME나 추론으로 세지 않는다. 새 실제 개인 `--ped1c544-threads`는 help261/효과263·문서화1–32,0·33·abc 거부·linked error/모든 Save 차단 뒤 **미저장3**·32/temp0에서 입력 위의 linked1–32 안내와 실제 고유 native SHOWING/FOCUSED/EDITABLE leaf의 같은 description을 확인했다. Reader 자원 정리와 원래 helper 복원 뒤 UTC2026-10-25T14:55:03.600739의 실제 첫 Save는 값을 다시 쓰지 않은 한 번의 pointer click으로 프로필 이름 입력을 열었고, 저장한3/같은 provider·runtime·max32/temp0를 다시 열어 확인했다. 이후 같은 고정17의 실제 native GUI Start/core를 실행했다. 새 flag 값3이 실제 argv에 남았고 native 로그의 `n_threads = 3`을 확인했다. 첫 실행과 새 PID 재시작의 실제 답변은 각각5였으며 native·GUI·저장 usage가 모두32+2로 일치했다. 내용 생성 뒤 Stop→같은 PID의 Retry와 정상 Unload 뒤 새 PID 재시작도 확인했다. Retry의 긴 숫자 요청이 원래32 한도에 도달한 결과는 lifecycle 범위로 남기고 정답 품질 성공으로 세지 않았다. 모델·prompt·token/temperature를 바꿔 통과시키지 않았다.

고정17은 실행 중 모델을 둔 첫 정상 Quit→같은 profile의 실제 새 GUI 재열기에서 저장3/같은 binding·max32/temp0·자동시작 없음→중지 상태의 최종 정상 Close를 완료했다. 두 Close의 실제 GUI/WebKit/model birth와 모델/inspector 포트가 사라졌고 driver는 빈 상태로 유지됐다. 첫 모델의 Unload 뒤 PID 부재는 고정 helper의 성공한 검사로 확인했으며 당시 birth가 없다는 한계를 기록했다. 그러나 마지막 보존 assertion은 exit1이었다. 과거 top-level `provider_options`의 특정 dict가 현재 실행 map에서 없어져 **원래 map 동일성은 false**이며 이 raw를 바꾸지 않았다. 별도 source/닫힌 파일 감사와 독립 재계산에서 기존 저장 프로필5개·과거 적용 snapshot은 정확히 같고 해당21개 값은 같은 저장 프로필과 적용 snapshot에 전부 남아 있음을 확인했다. 현재 실행 옵션 map과 저장 프로필 라이브러리를 구분하는 이 사례의 결과이며 임의 미저장 값의 무손실 보장은 아니다. 후속 파생 감사의 current-gone 검사와 **수정하지 않은 strict lifecycle importer**가 실제 두 Close를 수입했고, 원래/파생24개 pin과 소유 birth/포트 정리를 확인했다. raw exit1/false는 그대로다.18 baseline은 실제 닫힌17 설정의9개 프로필/3개 적용 snapshot과 별도의 기존5개/21값 보존을 기준으로 잡았다. 이 감사·수입에는 새 GUI/설정 변경이 없었다.

별도 TTS control1의 client 검증 실패와 control2의 엄격한 WAV header 실패를 보존했다. raw control3은 실제 BEGIN/END·21 packet·130,656바이트의 동일 server FD/ALSA Sent/PCM 일치로 직접 합성 경계를 통과했다. PCM SHA `f5757118ccf56251b80616bdecd673225eea34736ceff16e6cd99f2b5574c870`는 control2의 원래 payload와 같지만 이전 실패를 pass로 바꾸거나 Reader 결과로 대체하지 않는다. Reader1–4의 실행수명/회수·identity 사전검사/시작 전 실패와 Reader5의 cached-frame 낭독 한계를 그대로 보존했다. 이후 Reader6에서는 정상 Tab→같은 필드의 ordinary pointer return 뒤 실제 Orca locus가 entry로 바뀌었고, 이름·role·값3·help/수치1–32와33의 invalid entry·복구3의 Entry valid, 상세 WhereAmI handler 및 실제 Tab/현재 위치 안내를 확인했다. 정확한 전체 오류 문장은 발화되지 않았으며, 사람의 청취·이해도는 검사하지 않았다. 이 제한은 원래 F03에 없는 청취/전체 GNOME 동작 요건을 새로 추가하지 않으며, 실제 이름·상태·오류 안내는 최종 원래 요구사항 감사에서 판정했고, 아래 F03 pass에도 전체 오류 문장·청취 미입증은 그대로다.

Reader6의 실제46개 SSIP 요청은 native39개 완료/7개 취소였다. 1,394개705 packet의8,217,702바이트와 실제 ALSA/보존 RAW8,142,586바이트의75,116 차이는 취소한 두 message에 그대로 남기며 전체 발화 재생으로 쓰지 않는다. Watchdog는36회 검사 뒤 마지막 정상 Reader-stop 구간의 native traversal에서 Process is defunct를 기록했다. 마지막 단계 완료→Orca 정상 shutdown→실패 파일/정상 회수의 시각은 종료 경합과 부합하지만, 실패한 accessible PID가 없어 확정 인과나 watchdog 전체 pass로 쓰지 않는다. 원래 진단을 보존했고 정상 reader-stop/full cleanup·실제 자식 회수/keeper 무신호 정상 종료·main/config/private 접근성 복구를 확인했다. 의도 유지했던 자기 speech 폴더도 나중에 정상 제거했고, 원래 focus/common helper와 fresh19 해시는 그대로 복원·확인했으며 typed42개의 생존 Reader binding은0이었다. 이는 소유 Reader 자원의 정리다. 이 Reader 정리 당시 private bus/driver/mount teardown은 별도였으며, 이후 실제18의 최종 정상 정리는 아래와 구분한다.

작은 창17 최초 실제 실행은 UTC2026-10-25T14:56:15.221344에 locale/resize 전에 `#settings-tab-general`의 가시·noninert match를 찾지 못해 중단됐고 finally 복구도 같은 selector에서 실패했다. 실패 순간의 geometry는 없어 inert가 원인이라고 확정하지 않는다. 나중 read-only General visible/en/1280×800/no modal 관측은 그 실패를 pass로 바꾸지 않는다. 앞선 PREP_ONLY 호출도 실제 검사로 세지 않았다. 복구 helper의 manifest-key shadowing·wizard 단계 가정 실패를 보존한 뒤, 정상 UI의 두 Continue 경로로 원래 baseline 복구를 확인했다.

후속 actual R2는360×520/DPR1에서 실제 Tab 뒤3ms의 geometry assertion에 실패했으므로 당시 관측만으로 settling 이후 동작을 단정하지 않았다. R3는 최소250ms와 같은3개 frame의 안정화 뒤에도 입력 아래9px가 scroll body에 가려지는 실제 제품 UX 결함을 확인했다. 별도 native XTest Tab control에서도 같은 rect/9px가 재현됐다. 각 실행의 정상 복구에서 원래 저장3 editor/search·locale/넓은 크기·설정/프로필/이력·native 파일21개/UI 키6개와 중지 상태가 보존됐다. 네 언어 작은 창 전체 pass는 아니다. 이 관측에 대한18의 `scroll-padding-block: 1em` 수정은 아래 실제 같은 프로필/네 언어 재검증까지 진행됐다. 이 당시 fail과 raw는 보존했으며, 후속 최종18의 원래 대표 요구사항 감사/판정은 아래에 별도로 기록한다.

고정18의 첫 control 준비 R1은 실제 GUI 시작 전 기존 서비스 기록에 없던 `exe_sha256`을 요구해 KeyError로 중단됐다. run/context/session/GUI 생성이 없었고 원래 native 파일24개·빈 driver/같은 birth가 보존됐으며 raw 실패와 독립 사본은 그대로다. 별도 R2는 처음의5개 positive 생성 PID/birth/역할·기록된 네 argv와 과거 실제 exe/부모 graph를 연결하고, 현재 system program을 독립 package manifest와 대조했다. 과거에 없던 exe SHA/AT-SPI bus argv를 만들어 넣거나 소유 밖 user manager를 읽고 채택하지 않았다. 원래 private bus owner·단계별 환경을 재검증한 뒤 실제 prepare/attach가 exit0이었다. 닫힌17의 WebKit storage DB20,480바이트와 WAL/SHM 유무를 독립 사본으로 보존했고 SQLite는 분석 사본만 열었다. 실제18의 알려진 네 UI 키는 두 키의 부재와 두 키의 UTF-16LE 후보를 정확히 대조했으며 원본 DB family와 native24개는 그대로였다. 이전 초기16 네 키를 현재 값으로 대신하지 않았다.

같은 frozen18의 보존된17 저장3/같은 binding·32/temp0에서 먼저 영어 한 번의 native Tab 검사가 통과했다. 뒤이어 UTC2026-10-25T16:09:06.415192의47.396초 네 언어 실제 replay도 exit0이었다. 영어/한국어/일본어/중국어 각각 실제360×520/DPR1에서 native Tab으로 Group→같은 입력에 도달했고, linked 범위 안내·입력 전체가 scroll body 안에 있었다. 영어 body는17과 같은 y363.984–450.984/H87이지만 입력은 y413.484–446.984로 아래4px 여유가 생겼고 안내는 y395.484–413.484였다. 일본어의 더 좁은 H75.594 body에서도 전체가 들어왔다. 실제 own native SHOWING/FOCUSED/EDITABLE leaf의 id가 DOM 입력과 같고 localized description의1–32도 일치했다. 각 언어의16회 forward Tab 순환은 header의 SUMMARY/Close 두 focus와 footer의 두 button을 지나 원래 입력으로 돌아왔고, 기록한 해당 네 focus의 rect/hit는 모두 가시였다. 실제 Shift+Tab·Reader 발화나 키보드만의 최초 진입/최종 이탈·트리거 focus 복원까지 검사한 것은 아니다.

두 visibility 검사는 일반 UI 복구 뒤 native24개·알려진 UI6개/critical4개와 원래 저장3/32/temp0·영어1280×800·Chat/no modal·모든 native/API 중지 상태가 정확히 같았다. 세 helper pin도 같았고 root가 네 언어 PNG를 확인했다. 이 결과는 보존된17 프로필의 범위이며 새18 flag 여정·키보드 최초 진입/최종 이탈·DPR2·빠른 검색은 이후 별도 실제 실행으로 구분한다.


## 최종18의 새 옵션·실제 동작·대표 UX와 정상 정리

고정 뒤 만든 새 합성 엔진의 실제18 GUI 여정은39.008초에 등록/help1,030·pre-import 공통 입력1,012·새 값9·정확한 rich argv·가림·명시 SYNTHETIC echo·저장9 재열기를 확인했다. 합성 echo는 추론이 아니다. 실제 개인 CPU 엔진은17.318초에 help263·문서화1–32의0/33/abc 거부·linked error와 모든 Save 차단 뒤 유효3을 확인했다. 값을 다시 쓰지 않은 첫 한 번의 pointer Save가 이름 입력을 열었고 저장3을 재열었다. 새 flag3/실제 argv와 native `n_threads = 3`, 첫 실행·새 PID 재시작의 답변5 및 native/GUI/저장 usage32+2 일치, 내용 수신 뒤 Stop/부분 응답 보존·같은 PID Retry·정상 Unload/재시작을 실제 기록했다. 원래32/T0·입력·모델은 바꾸지 않았다. 긴 숫자 Retry가32 한도에 도달한 결과는 lifecycle 범위이며 전체 숫자 품질 pass가 아니다.

원래 core 명령의 전체 판정은 **exit1**이며 완료 flag도 만들지 않았다. 선택한 개인 등록 기록이 모델 독립 probe에서 모델별 probe/fingerprint로 정상 갱신되어 파일 동일성 한 항목이 false였다. 별도 source/닫힌 파일 감사는 실제4718바이트 after에서 정확한 원래4429바이트/SHA를 재구성했고, 여섯 JSON 경로의 정당한 갱신과 manifest/program/probe/artifact 정체성 보존을 확인했다. 재구성을 raw before 사본이라고 하지 않는다. 나머지29개 nonconfig 파일·기존9개 저장 프로필/3개 적용 snapshot·기존5개/21값은 그대로였고 선택한 새18 revision1→3은 두 번의 명시 Save&start에 대응한다. 실제 native 동작과 이 scoped 감사만을 수락했으며 원래 전체 core exit1을 pass로 바꾸지 않았다.

실행 중 모델을 둔 첫 정상 Quit 검사(1.127초) 뒤 같은 고정18/profile을 다시 열어 저장3/같은 binding·32/T0·자동 시작 없음을 확인하고 중지 상태에서 최종 정상 Close했다. 재열기부터 확인·최종 Close까지의 전체 검사는8.068초였다. 실제 소유9개 GUI/WebKit/native birth와 다섯 포트가 사라졌고 닫힌 native34파일·DB family/네 UI 값은 정확히 같았다. current-gone0.269초와 strict 원래17 guard를 유지한 파생 import0.465초는 두 실제18 Close를 닫힌 역사로 추가했다. shared state에서는18 epoch/관측 포트만 의도대로 늘었고 과거 원본/65개 source pin·이전 기록은 그대로다. 과거146d baseline을 현재4f02로 꾸미거나 이전 상태로 되돌리지 않았다.

실제18 keyboard-only route13.416초는 native X11 Tab/KP_Enter16회와 ordinary WebDriver Shift+Tab 한 번으로 고유 runtime opener→dialog heading→first/last wrap→keyboard Close→같은 논리 opener focus 복원을 확인했다. 성공 경로에는 pointer/DOM focus·scroll 변경이 없었고 native24/UI4/UI6/quiet·영어/크기/Chat을 보존했다. 내부 비동기 항목의 focusable count9→14는 raw에 남기며 DOM 객체 동일성이나 모든 경합을 입증했다고 하지 않는다.

별도 새 합성 테스트 profile의 실제 main X11/XWayland 창에서 native scale/DPR2·물리720×1040/논리360×520을6.293초에 확인했다.16개 frame/250ms 이상 안정화 뒤 전체 linked1–32 안내와 실제 focused3 입력은 같은 H87 body 안에4px 여유로 들어왔고 body 가로 넘침이 없었다. 원래1280×800/물리2560×1600·DPR2·영어/no modal·copied7/native/UI4/quiet를 실제 재측정해 복구했다. 시스템 배율·출력·IME·모델/값을 바꾸지 않았다.

빠른 검색의 원래 RAPIDv1은 모델별 rich profile을 명시 모델 선택 전에 기대해 Default에서 timeout/exit1이었고, finally의 Discard 대기는 한 번의 정상 own Discard로 복구했다. 당시 hidden model 값은 없어졌다고 단정하지 않는다. 별도 v2는 실제 empty model path/Default→정확한 등록 모델의 ordinary Enter/Load→rich profile/저장9를 확인했지만 raw count1012 가정 때문에 observer 전에 exit1이었다. 원래1012는 Import 전 측정이었고 rich 저장값의 pair2/rgb3/tags3/header2/route4가14개 자식 입력을 더했다. 각 raw 실패와 정상 복구는 그대로다.

별도 v3는 accepted schema/manifest·저장 occurrence·renderer에서 **정확한 canonical1012+expanded14=raw1026 이름 전체**를 도출했고, unknown/missing/duplicate를 제외하거나 합쳐 숨기지 않았다. 원래2초 상한/입력 그대로17.686초 실제 A100→B1(완전히 보이는 저장9)·missing0·양쪽 count의 전체 reset을 확인했다.37개 trusted input/300 rAF 한도에서 실제 A100 render와 완성된 B 입력 직후 아직 A100인 DOM→최종 B1의 deferred 전이가 관측됐다. 강제 지연·주입 응답·모든 interleaving 보장은 아니다. 원래 native/UI4/quiet는 정상 own Discard 뒤 같았다.

원래 F03 대표 조항을 닫힌70개 근거 pin과 실제 화면으로 감사한 뒤 root는 UTC18:15:14에 **F03 pass**로 판정했다. 실제18 fresh/keyboard/네 언어 DPR1/native DPR2/1,000개 이상 렌더·빠른 최종 검색·오류 복구와, 같은 로직의 실제13 물리 IME·17 stock Orca 결과를 source별로 구분했다. 이름 있는 invalid33+쓸 수 있는1–32 범위 안내+복구3의 Entry valid는 원래 오류 안내에 충분하다고 판단했지만, 전체 오류 문장 미발화·사람 청취/이해도 미검사·Reader watchdog 종료 경합 실패는 그대로다. 보편적인 접근성 인증이나 모든 GNOME/IME/경합 조합의 pass는 아니다.

Main18은0.901초의 정상 Close로 실제 소유 GUI/WebKit 세 birth·listener의IPv4/IPv6·자기 session을 정리했고 원래 main driver와 controls는 유지됐다. 이후 private 인프라의 두 소유 FUSE mount는 정상 unmount했으나 원래 cleanup은 이미 종료 중인 portal exe 판독에서 FileNotFound/exit1을 기록했다. 이 실패·원래 grant/raw를 보존하고 prepare/unmount를 반복하지 않았다. 별도 기존 positive12개만의 continuation0.556초는 다섯 정상 SIGTERM과 자연 종료한 자식의 무신호 처리를 구분해 모두 gone을 확인했다. 별도 tail0.077초는 private 포트/X11 socket·lock 종료, 자기 인증 파일의 내용 열람 없는 제거, main controls/mount 동일성을 확인했다. 새 소유 채택·밖 manager 읽기·그룹/강제 신호나 원래 shared state 변경은 없었다. **Private 인프라 최종 정리는 이 실제 continuation/tail 범위로 완료했으며 원래 cleanup exit1은 그대로다.**

**최종18 관련 GPU 재검증 완료 — managed ROCm CLI 범위.** UTC18:45:23.130848에 시작한 실제 v3는17.594초/exit0이었다. 같은 고정18 CLI·기존 b11869/Qwen·원래32/T0 산술 요청에서 첫 실행과 새 PID 재시작 모두 답변5/native42+2=44/DONE였고, 각각 요청 전에 실제 `offloaded25/25`를 확인했다. HIP/자기 vendor library·DRM VRAM·요청 전후의 실제 소유 listener도 기록했다. 별도 원래1024/T0 요청의 내용1/2/3 뒤 terminal 전 실제 client socket을 닫았고 native 취소 ACK는 주장하지 않는다. 같은 native PID에 바이트가 같은 새 HTTP 요청은200/비어 있지 않은 응답·native34+708=742(입력 cached33)/DONE로 끝났으며 wire436,132바이트를 보존했다. 이는 GUI Retry button이나1–200 전체 순서의 품질 pass가 아니다.

진단 verbosity4는 offload 사실을 수집하기 위한 것이며 성능 비교가 아니다. 원래 quality256KiB/32T0와 긴 요청1024T0·입력·모델·모든 inference/대기 상한은 그대로였다. 첫 시도5.669초/exit1은 supported 목록을 dict로 읽어 server Start 전에 중단된 harness TypeError였다. 두 번째13.996초/exit1은 실제 offload/산술/내용취소 뒤 긴 timings SSE의256KiB 수집 상한을 terminal 전에 초과한 harness 실패였다. 두 raw 실패와 정상 정리/보존을 유지했다. 별도 v3는 실제 frame 크기와 고정1024 telemetry에 근거한 유한2MiB **긴 stream 수집 상한만** 사용했으며 정답을 위해 token/deadline을 늘리지 않았다. 정상 Stop 뒤 첫/재시작의 native·collector 네 birth와 소유 포트IPv4/IPv6가 사라졌고, 전체683개 원본/독립 사본·모델·고정 CLI·보호 helper는 같았다. 기존 Vulkan/ROCm GUI·vLLM/Strata의 source/요청/품질 경계는 유지하며 **새18 Vulkan이나 GPU GUI 재검증으로 세지 않는다.**

최종 GPU와 private 인프라 정리 뒤 UTC18:46:35.549445의 원래878/확장1,560개 hash-only guard는 각각 변경·누락·오류0개였다. 원래 사용자 자료의 복사·삭제·복원은 없었으며, 이 완료 범위를 남은 조건부 UX/updater나 미디어 품질 pass로 옮기지 않는다.

## 발견한 제품 결함과 실제 재검증

| 문제와 원인 | 수정 및 검증 범위 |
| --- | --- |
| Unix symlink 정리와 interpreter-entry 검사 fixture가 플랫폼 계약과 맞지 않음 | `303dc65`: Unix unlink/Windows junction 경계를 보존하며 fixture만 수정했다. 전체 Linux 검사 통과. |
| Strata가 64개 artifact 한도를 넘고, SONAME 별칭의 동일 canonical 파일을 help identity가 중복으로 처리함 | artifact 256개/record 256 KiB 경계를 함께 유지하고 ELF loader의 전이 의존성을 선언 root 안에서 수집한다. 별칭 관계를 fingerprint에 포함하며 대상 교환을 거부한다. 실제 191개 artifact 등록/help/실행을 확인했다. `dlopen` 전용 자료 전체 검증으로 확대하지 않는다. |
| `KEY=VALUE`, wrapped prose, 선택지 뒤 설명을 각각 equals 문법/positional/거짓 arity로 잘못 읽음 | 공통 parser5–7 수정과 원문/합성 회귀를 추가했다. 고정10 실제 vLLM wrapped prose 탐색·수락·기존 값/실행 복구를 확인했다. `67d256e`의 선택지 뒤 설명은 Unknown으로 남기며 진짜 선택지 충돌은 보존한다. 실제 이전 parser5/6 cache의 최신 parser7 stale·시작 거부·원래 값/snapshot 보존·재탐색/재수락을 확인했다. 고정12 실제 같은 vLLM 도움말320/효과328에서 거짓 arity 충돌 해소·진짜 runner 충돌 보존과 기존32/temp0 프로필의 GPU 답변5/25+13·Stop/Retry·재시작·Quit/재열기를 통과했다. |
| Python help 인코딩과 실패 진단이 옵션 근거를 오염시키거나 원인을 잃음 | `befe3a4`/`d3fce2f`: help에만 UTF-8을 적용하고 실패/잘린/읽기 오류를 옵션으로 수락하지 않는다. 제한된 진단·exit/timeout을 보존하고, stderr의 cancelled 단어로 실제 실패를 취소 처리하지 않는다. 전체 검사와 고정11 실제 exit17/overflow/60.084초 timeout·quiet Cancel·같은 명령 재시도/자손 정리가 통과했다. 도움말/GUI source가12와 같음을 확인했다. |
| 깨끗한 VM의 CPU runtime에 `libgomp.so.1`이 없음 | `25fb4ce`: DEB 의존성과 네 언어 설치 안내를 보완했다. 동일 runtime 해시에서 해당 의존성 설치 후 실제 추론이 성공했다. |
| Strata의 HTTP(S) 전용 origin 정책이 실제 WebView `tauri://localhost`를 거부함 | `b3e1017`: 명시 deployment에 있는 이 origin만 SDK bridge로 연결한다. 원본 checkout·인증·host·readiness를 유지하며 실제 HIP GUI 추론/usage/취소를 확인했다. |
| 세션 포트 누락·GPU 목록 헤더 과계수·vault 원인 없는 일반 오류 | `e454065`/`b9668ae`/`e829df6`: 기존 URL helper·indexed 장치 중복 제거·동작별 typed 복구 안내를 적용했다. 실제 GUI의 두 GPU 표시, 잠금/인증 취소/사용 불가/잠금 해제 후 같은 키 backup을 확인했다. |
| Gateway의 Anthropic/Responses가 native 최종 usage를 요청하지 않음 | `cf99641`: native count를 보존하고 누락을 명시한다. 고정8 실제 동일 요청의 직접 native·OpenAI·Anthropic·Responses가 모두 32+2=34였다. 인증·alias·취소 lease 및 모델/API 독립 종료도 확인했다. |
| exec wrapper 뒤 CLI가 과거 interpreter image를 소유 identity로 저장함 | `220d1f9`: Ready 후 실제 소유 image를 확인·저장하고 확인 불가는 실패시킨다. 고정9/10/12의 실제 CPU 정상/반복 종료·중단 회수·canary 보존으로 재검증했다. |
| 짧은 정상 SSE가 고정 500ms 전에 끝나 harness 취소 검사가 실패함 | `e99e9fd`: 실제 content/reasoning 뒤 아직 열린 stream만 취소한다. Prompt·quality32/cancel64·deadline을 늘리지 않았다. 동일 실제 vLLM Node/Rust gate와 cleanup이 통과했다. |
| AppImage runtime이 정상 종료 뒤 추출 폴더를 남기고 인스턴스가 같은 경로를 공유함 | `8454091`: pinned type2 runtime의 nftw fd 한도64와 인스턴스별 mkdtemp를 적용했다. 기본 고정8 AppImage의 FUSE/extract/NO_CLEANUP·두 번째 실행·실제 답변·0700 폴더·소유 정리/canary 보존이 통과했다. 고정12 기본 산출물도 세 모드의 GUI 답변5·두 번째 인스턴스의 정확한 GUI/CPU PID/birth/URL 유지·0700 추출/정리·원래31개 파일/4개 저장값 보존을 통과했다. |
| 실제 옵션 오류와 discard 판단이 입력/선택 소유 경계를 제대로 나타내지 못함 | `4cc7de2`: input/combobox의 ARIA 오류 연결과 runtime 선택의 dirty 판단·Enter 처리를 보완했다. 전체 검사와 실제 GUI의 ARIA/키보드/값 보존을 확인했다. 실제 한글 입력에서 조합 종료 뒤 첫 Enter가 조기 Load를 실행하는 추가 결함을 재현했다. 69a463b의 자동 회귀 뒤 고정13 실제 첫 Enter 보존과 별도 다음 Enter의 정상 Load를 확인했다. main/manual13의 정상 cleanup·config/main 보존은 완료했으며 당시 일반 Orca 판정은 남았으며, 후속 실제17 Reader/최종18 F03 대표 범위 판정과 구분한다. |
| 문서화한 수치 범위가 실제 입력과 접근성 설명에 없고, 첫 후보는 민감한 범위값을 노출함 | `f1959c2`: 알려진 유한 범위만 기존 네 언어 안내로 입력 위와 ARIA 설명에 연결하며0/한쪽 경계를 보존한다. 미확정 범위는 추정하지 않고 알려진 민감 옵션의 범위 리터럴과 설명 ID를 생략한다. 실제16의0 거부/linked error/저장 금지는 정상이나1–32 안내는 없었던 관측을 보존한다. 의미 있는5개 RED와 동료 검토의 민감 값 RED 뒤 최종84개·전체 frontend 검사를 통과했다. 실제17 개인 GUI의 위쪽 linked1–32/native description과 첫 Save/저장3 재열기를 확인했다. 제한된 private Reader6은 실제 필드·범위/invalid·valid 발화까지 확인했으나 전체 오류 문장·청취·watchdog 종료 경합과 일반 접근성 한계를 남긴다. 첫 selector/복구 실패는 보존했다. 실제17 첫 Save/저장3 재열기·native GUI core/정상 두 Close는 별도 확인했고, R2/R3/native Tab에서 남은9px 가림은 아래18 수정의 실제 재검증 대상으로 남긴다.16 결과를 새 안내 성공으로 바꾸지 않는다. |
| 작은 창의 정상 Tab 이동 뒤 입력 아래9px가 scroll body에 가려짐 | `9f9dbac`: 공통 scroll 영역에 `scroll-padding-block: 1em`과 의도 주석만 추가했다. 실제17의 안정화 R3와 독립 native Tab RED/정상 baseline 복구를 보존했다. 같은 최종 CSS diff의 typecheck8.609초·lint4.783초·전체2,577개110.497초 및 기본 package139.034초/CLI smoke0.260초는 통과했다. 실제18 보존된17 프로필에서 narrow EN과 네 언어360×520/DPR1·native entry/range·forward Tab 가시 순환/정상 복구는 통과했다. 후속 별도18 fresh/core 동작·keyboard 진입/이탈·focus 복원·native DPR2/빠른 검색까지 원래 대표 요구사항을 감사해 F03 pass로 판정했다. 원래 실패·Reader 한계와 각 source의 범위는 보존한다. |
| 실제 OS 파일 드롭이 Chat 첨부로 연결되지 않고, 첫 수정도 Wry 창 이벤트를 놓침 | `7c1b8a5`/`347c7f7`: 실제 main-window drop만 제한된 일회 UUID 선택으로 기록하고 현재 보이는 composer에서 직렬 처리한다. 고정11의 raw event/커스텀 이벤트0 실패를 보존했다. 고정12 실제 8회 드롭의 Unicode PDF·순서/중복·4개 제한/다섯째 거부·text-only 이미지 거부·composer 밖/모달 무시와 native Cancel/Tab/Space 선택이 통과했다. 실제 Smol PNG/혼합 첨부도 Ready였다. Send 동작 없이 초안·31개 파일/4개 저장값 보존·모든 소유 프로세스/포트 정리를 확인했다. |
| 설정 파일 게시가 실패한 스냅샷이 오류·Retry 기록을 남기면서 모델 목록에서는 사라짐 | `fc22b28`: 명시 다운로드 manifest를 config 파일보다 먼저 검사 대상으로 인정한다. 실제659바이트 config의 hard-link 게시 실패에서 목록0개, 같은 실제 Retry 완료 후1개가 되는 경계를 확인했다. 파일 누락·Unknown·불완전·소유권 판단은 기존 검사기에 유지한다. 공개 catalogue 회귀의 RED→GREEN과 전체 Rust 검사 뒤 실제 실패 파일 사본으로 고정14 GUI를 재검증했다. 목록에 한 행이 남고 Unknown/설정 누락/불완전 이유와 비활성 Start를 표시했으며 기존 binding·프로필·중지 상태를 보존했다. |
| 불완전 HF 스냅샷에도 분할 모델의 조각 누락이라고 안내함 | `9a6d64d`: 네 언어를 필수 모델 파일 누락/다운로드 불완전 안내로 바꾸고 공통 상태의 주석을 정정했다. 로직·schema·IME·Rust 변경은 없다. 고정15 실제 영어/한국어/일본어/중국어360×520 GUI의 안내·설정 누락 원인·비활성 Start·기존 binding을 확인했다. 좁은 footer에서는 안내 전체가 한 화면에 보이지 않으며, 실제 Home/ArrowDown/PageDown으로 마지막 줄까지 접근했다. 정상 언어/크기 복구와 원래 프로필·이력·runtime·정상 재실행 보존을 확인했다. |
| 읽을 수 없는 GGUF에도 Text/tokenizer/chat-template 기능을 확정하고, 일찍 끝난 projector reader는 Image까지 추정함 | `faa7d61`: 일반 GGUF metadata 판독 성공 전에는 이 기능들을 Unknown/false로 남기고 projector 전용 판독도 같은 성공 조건에 둔다. 보통·mmproj 이름의 잘못된 magic과 세 번째 key가 잘린95바이트 GGUF 회귀에서 각각 실제 RED→GREEN을 확인했다. 파일명 역할 힌트·기존 정상 GGUF 정책·readiness/소유권은 유지한다. 정상 파일의 기존 tokenizer/template 정책을 모든 파일에 그 데이터가 존재한다는 독립 증명으로 확대하지 않는다. 고정16 설치 GUI의 보통·부분 shard·잘린 mmproj 세 파일에서 실제 Unknown/원인·모든 기능 false와 잘못된 모달리티 badge 부재를 확인했다. 지원 파일 표시를 켜서 실제 mmproj 행도 확인한 뒤 되돌렸으며, 원래 정상 Qwen의 GGUF/qwen2/Text 기능은 유지됐다. |

첨부 취소/만료와 canonicalization 완료의 경합은 실제 barrier로 RED 두 개→GREEN 두 개를 확인했고, invalid/replay/wrong-window token은 이전 읽기 권한을 취소하지 않는다. 전체 Rust 및 frontend 검사에 포함했다. 실제 드롭 검사를 합성 DOM DataTransfer·임의 경로 grant로 대체하지 않았다. Busy/reset/unmount/expiry·DPR 경계는 명시된 자동 검사 범위이며 실제 IME/이미지 정답 검사로 세지 않는다.

## 실제 엔진과 기능의 범위

- CPU는 Qwen2.5-0.5B-Instruct GGUF revision `9217f5db79a29953eb74d5343926648285ec7e67`, SHA `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`를 사용했다. Managed CPU와 실제 개인 build의 새 flag·argv·native thread·답변5/usage·Stop/Retry·재시작·Quit/이력을 확인했다. 합성 echo는 실제 추론과 별도다.
- 실제 Vulkan 두 GPU와 managed ROCm b11869의 native/GUI 추론·선택 장치·VRAM·취소/Retry·재시작·정상 종료를 확인했다. 다운로드/preflight를 추론 성공으로 쓰지 않았다. 최종18의 별도 managed ROCm CLI는 실제25/25 offload·원래32/T0 답변5/42+2·내용 취소/같은 PID HTTP 재요청·새 PID 재시작·정상 Stop을 확인했다. 기존 Vulkan의 실제 GUI scope와 새18 ROCm CLI scope를 구분한다.
- 외부 vLLM 0.31.0+rocm723은 private ROCm 7.2.3/MPI4 환경이다. 고정8 Node248.998초/Rust241.650초의 native37+3, 고정8/10 및 고정12 GUI의 동일 산술32/temp0 정답5/native25+13·내용 Stop/Retry·재시작·정상 종료를 확인했다. 고정12는 원래6개 이력/258개 이전 receipt를 보존해9개 이력이 됐고, 재실행의 현재parser7/같은 fingerprint·프로필 값도 확인했다. 관리형 PyPI CUDA 설치의 AMD 실패와 구분한다.
- N05의 첫 local-archive 출처 export 거부를 보존했다. 이후 진짜 index 출처 219개 원래 wheel 해시로 만든 bundle `dd7eb6ada83407ed6246b1339c7865ab1cfb77febfadcd4503d267e70f0221ed`(3,340,062,021바이트)를 offline 새 홈에 import했다. 모든 wheel SHA·probe·실제37+3/취소·복구·재시작·종료와 별도 원래 산술32/temp0 정답5/native35+23이 통과했다. Wheel SHA/OS/ABI 손상 거부·실행 중 import 거부·실제 SIGINT 정리/같은 ZIP 재시도·기존 파일 보존도 확인했다. 첫 실패는 깊은 TMPDIR의 Unix ZMQ 경로 한도였고, 짧은 테스트 TMPDIR만 바꾼 동일 harness 반복을 별도 보존했다. 고정12 CLI에서도 같은 import 대상의 probe411개 flag·Ready35.979초·원래32/temp0 산술 정답5/35+23·정상 종료0.465초와220개 METADATA/config 보존을 확인했다. 전체 portable suite 재실행이나 SDK 없는 환경·다른 ROCm/OS·GUI import 전체 성공을 뜻하지 않는다.
- Strata는 revision `296b59d2f73c8f04a805df29c2fa97655adace78`, native SHA `fcd7121f4c52e972d69cf1d023f227e7618fdc9929f08f5fa9d9e4439df3a26e`다. 고정 모델 revision `5348543e0147355ac9cbcb031184a3546350988e`의 두 shard SHA는 `e11083ba855e7666b48ea3f2db6a9c3a20c18751a012cc24f948de91b7087fad`/`316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113`다. 약58.4GB 전체 hash와 pack/MTP 검증을 유지했다. 191개 artifact의 SDK·help·명시 bridge·HIP Ready·usage·취소/Retry·재시작·종료·MCP 반환47 후속 답변을 실제 확인했다. Ctest 103 pass/5 skip/4 fail과 원래 32-token reasoning-only 품질 실패를 보존했다. 고정12의 원래 manifest와 현재 SDK/실제 GUI12 preview manifest를 사용한 stock CLI 실행은206.588/201.988초에 각각 exit1이었다. A03/A05/A07의 원래32-token 산술 실패와 별도로 나머지6개 provenance/lifecycle 항목은 통과했다. 별도 같은32/temperature 생략 SSE는 content 없음·reasoning113자·native65+32·finish length/DONE였고 quality exit1을 보존했다. 현재 SDK options[]에 없는 요청 옵션의 GUI 전달 성공을 주장하지 않는다.
- 실제 MCP의 Yes/No·승인 대기/호출 Stop, PDF/DOCX·Nomic768/프로젝트·keyword fallback, 원본 WAV→47/STT 준비 Stop/Retry 실행 횟수1→2→2, 영상 네 part/다섯째 거부, benchmark 완료2/취소1·실제 CSV/XLSX 세 행/미리보기·개인화/지침/skill symlink 정책을 확인했다. 각 행의 남은 조합은 아래 표에 남긴다. 외부 게시나 임의 skill 실행은 하지 않았다.

이미지/영상의 색·도형 응답은 같은 원본/model/processor의 직접 native 대조에서도 틀렸다. 정확한 전송 bytes·순서·재로드 및 고정12 첨부 수락과 **F09 내용 품질 실패**를 구분한다. RAG의 ORBIT-47→47 답변 실패도 context 전송과 구분해 보존했다. 원래 Windows 품질 입력/산출물이 없으므로 동등 대조는 미실행이다. 모델 교체·정답 보정·token 증가로 통과시키지 않았다.

고정12의 별도 합성 profile에서 실제 Qwen+Smol CPU Ready·인증 API·미승인 native MCP 창을 동시에 유지한 뒤, pre-stop 없는 정상 Quit로 소유7개 PID·API/모델/inspector 포트·승인창이 정리됐다. 도구 호출은0개였다. 같은 profile 재실행은 API stopped/keynull·임시 session ID 없음이었고 config·기존31개 파일/4개 저장값·원래 runner를 보존했다. 이 사례에 활성 ffmpeg/pip/CMake 작업은 없었으므로 그 취소까지 성공했다고 하지 않는다.

실제 Qwen 요청 성공 뒤에도 native CPU 로그의 POST 줄 수는0이었다. 따라서 앞선 드롭/F14 raw의 POST0은 누적 HTTP 요청 수 근거로 쓰지 않는다. no-Send·초안/이력 보존·실제 MCP tools/call0·종료 증거는 유지하며 원본 raw는 수정하지 않았다. 별도 고정12 Chat 4회는 원래 fetch의 실제 URL/body/SSE를 관측했다. 첫 회는 method 필드가 없어 POST는 소스 계약 근거이고, 나머지3회는 POST를 직접 기록했다. 두 CPU 모델의 안내 on/off에서 system+user/user-only·대상·usage·정상 Quit/재열기4개 송신 이력이 일치했다. Qwen은5 두 번, Smol은 ` 5.`와 ` 2 + 3 = 5`로 숫자만 출력 형식은 실패했다. 같은64MiB+1 파일의 native 거부 재검사는 설치된 관측기4행→4행·초안/미디어 저장소 보존을 확인했다. 빈 미송신 대화가 비활성화되면 정리되는 기존 저장 계약은 송신 이력 손실과 구분했다.

별도 고정12 UI에서 새 프로필 두 개의 Rename/stable ID·기본 선택 중 dirty 값 보존·기본 삭제 금지·다른 프로필 Delete 취소/확인/fallback·정상 재실행을 확인했다. 한 필드 기본값/저장값 Revert/전체 옵션 초기화를 구분했고, 지침·모델·runtime·timeout 보존과 runtime 관리 복귀/Keep editing/Discard를 실제 확인했다. 엔진을 시작하지 않았고 초기화 뒤32/temp0 등 CPU 제한을 명시 복구했다. 이 CPU/default 대상의 빈 optional binding을 모든 비어 있지 않은 binding 검증으로 확대하지 않는다.

고정14 실제 Chat의 나머지 MCP 거부 두 경로도 확인했다. 원래 Strata1024 요청에서 앱 내 Reject와 Approve once 뒤 실제 native No를 각각 실행했다. 실제 POST 두 개의 응답은 tool_calls/DONE·native402+94였고, tool 실행·후속 POST는0개였다. 두 번째 GUI의 PP5는 native cached397을 제외한 계산 토큰으로 원래 usage402와 구분했다. 정상 Unload로 엔진·MCP·승인창·포트가 종료됐으며 원래 가중치/runtime/191개 artifact 해시는 같았다. 고정16 같은 private X11 profile 재실행에서도 두 거부 이력·네 Chat 저장값·native config/MCP가 같았고 실제 native SHOWING 문서를 확인했다. 새18 Reader/일반 GNOME·Wayland 낭독 pass로 확대하지 않는다. 이후 private 서비스 정리는 위의 별도 정상 continuation/tail과 원래 실패로 구분한다.

모델 관리 F12의 요청 최소 범위는 실제12/14/15/16의 합집합으로 pass다. 실제12의 검색·491MB 취소/Retry·실행 중 삭제/다운로드 거부와659바이트 config의 진짜 EOPNOTSUPP 게시 실패/같은 Retry,14의 그대로 보존한 실패 snapshot 행·Unknown/누락/disabled Start·묶음 Delete Cancel/Confirm·첫 제거 전3종 native batch 거부,15의 네 언어 안내/정상 재열기를 함께 유지한다.

고정16 설치 GUI에서는 세 미확정 파일의 기능false/badge와 원래 정상 Qwen을 실제 대조했다. 별도 관리용 TinyReader의 같은 origin/fullpin GGUF40,986,912바이트와 companion5개552,991바이트는 실제 한 번의 Download46event 뒤 LFS-SHA/Gitblob/전체SHA·qwen3 header/config·no auto_map/no parts를 검사했다. 품질 대체나 추론은 없었다. 원래 Qwen의 독립491MB 사본/nlink1로 nondefault CPU 세션을 한 번 시작해 defaultStopped·별도 binding·health200·native 삭제 거부·UI Delete 비활성·다운로드1ms busy 거부/46→46event/빈 목적지를 확인하고 정상 Stop/Unload로 소유PID/포트를 정리했다. 기대 오류 dictionary를 WebDriver 오류로 읽은 첫 harness 비정상 종료는 보존했고, root가 승인한 같은 결과의 배열 조회/해시·정리 post-audit만 추가했으며 시작/다운로드를 재발행하지 않았다.

고정16 같은 profile의 정상 Quit→재열기→최종 Close 후 config는 검사 전과 같은 SHA56861…이고 기존4프로필/5이력/runtime63·normal31파일/4저장값/전체DB·원본 source340/assets4/공유 helper·진짜 source/실패/성공 사본 해시는 같았다. private benchmark 경로0→1은 실제 companion 다운로드 출처 receipt 하나이며 기존 benchmark 실행 결과를 바꾸지 않았다. VM 소유 app/driver/forward/포트를 정리해11:12:28.439517Z lease를 반환했다. 이것은 모든 later-shard/projector/draft/LoRA **live-role 조합**, 새 large-shard 전송, vLLM GGUF Ready/품질 또는17 VM 실행의 pass가 아니다.

## 패키지·환경 원인·성능 검토

- 실제 공개0.3.0→로컬0.3.1 DEB 업그레이드 두 사례에서 schema12→14/원본 backup·Unicode profile/model/runtime/이력/usage 및 실제 앱 OS vault 키와 동일0600 backup을 보존했다. 설치·GIO cold/second launch·재설치·제거 뒤66개 데이터/모델 보존도 확인했다. 고정12 같은 버전 교체는 별도이며31개 파일/4개 저장값을 보존했다.
- 실제 CPU runtime ZIP `ab193fb817a363dad964575fd15cf17d27805a5d56a975d9c7da16b724741de7`의 GUI export→compiler/CMake/ROCm SDK 없는 VM 새 AppImage 홈 import→Ready/답변5를 확인했다. 64개 entry·실행 권한·라이브러리/hash/ldd를 확인했다. Python N05는 별도다.
- VM에서 같은 GUI와 새 빈 profile도 WebKit→ATK 등록 중 SIGSEGV했다. 원래 core와 실제 OS 라이브러리로 조사해 cached AT-SPI 주소의 오래된 GUID를 확인했다. 실제 socket AUTH EXTERNAL과 classic libdbus의 old/current GUID 대조 뒤 **자식 주소만** 올바르게 전달하자 같은 binary의 onboarding/Close가 성공했다. 서비스 재시작·bridge/sandbox/접근성 비활성화·제품 수정으로 우회하지 않았다. 원래 private driver/bus와 사용자 파일을 보존했다.
- 같은 Node·실제 약104MB 입력·warm-cache 조건의 새 process 각5회에서 AppImage 검증을 전체 파일 대신944,632바이트 prefix로 제한한 결과 median21.418→0.336ms/peakRSS151,880→50,468KiB였다. 앱 시작·WebView 렌더·엔진 추론·전체 빌드 속도 개선으로 확대하지 않는다.
- 책임/의존 방향은 adapter 계약·registry/launch·공통 기능을 나누어 검토했다. 새 native drop 저장소·feature hook과 공통 진단 helper는 해당 책임에 두었다. 마지막 변경의 정적 감사에서 새 고정3엔진 분기/모델 형식 추정 필터가 추가되지 않았으며, 고정12의 실제 새 합성/개인 flag 여정과 결합해 H07을 판정했다. 근거 없는 폴더 이동은 하지 않았다.
- 설치된16의 ordinary Notifications 설명·상태·category 문구는 r1 EN/KO와 r3 JA/ZH에서 각각360×520으로 확인했다. EN 상태는 이전 DOM 확인만 있고 별도 가시 PNG가 없어 네 언어 모든 상태의 화면 증명으로 확대하지 않는다. r3의 JA/ZH는 처음부터 키보드 탭 경로를 쓰고 마지막 benchmark의 실제 focus/가시 rect를 확인했으며 r1의 진단 부족 pointer 실패를 해소한 것으로 쓰지 않는다. 별도 app 자식의 닫힌 loopback proxy에서 wide 창의 실제 Check 두 번은 Checking/disabled→native 오류/reenabled Retry로 돌아왔다. 정상 Quit 후 같은 payload/profile을 원래 환경으로 다시 열자0.3.1 동률 startup check가 성공했고 config/프로필·normal31/4저장값/DB 및 소유 자원을 보존해 VM lease를 반환했다. r1/r2의 실패 raw는 그대로이며 이 결과는 U03의 오류/재시도 하위 경계만 닫고 설치 판별/가능·불가/진행·release 이동이나 D07 전체 조건부 문구를 닫지 않는다.
- main/manual13에서 실제 Send 한 번의 desktop 수락/own ID35와 정상 closure를 확인했으나 사용자는 배너/알림센터에서 확인하지 못했다고 명시했다. D05의 사람 확인은 unrun으로 유지하며 추가 Send·권한/OS 알림 설정 변경은 없었다.
- 2026-10-25 UTC17:18:40의 [공식 latest API](https://api.github.com/repos/aiolm/AioLM/releases/latest) 재확인에서도 공개 최신 v0.3.1(공개2026-10-06)과 source v0.3.1이 같아 실제 새 버전 updater 설치는 blocked다. 동률 확인은 설치 판별 분기를 실행하지 않는다. 가짜 상위 버전·신뢰하지 않는 release·거부된 browser origin 우회로 대체하지 않는다. Updater native 진행률 검사는 첫/최종 바이트·기본500ms pending read·부분 쓰기·오류/취소 순서를 확인하며 write/flush 대기 상한이나 실제 다운로드 가속을 뜻하지 않는다.

## 앞선 고정점의 보존

고정8의 GUI/CLI/package 및 자동 검사·STT/gateway/AppImage 결과는 별도 raw 사본에 보존했다. 고정9는 `220d1f9` CLI 수정 뒤 GUI payload가8과 동일 바이트임을 확인했다. 고정10은 parser6 수정 뒤 GUI가 바뀌어 실제 vLLM/새 개인 엔진을 다시 검증했다. 고정11은 parser7·진단·첫 drop 구현을 포함하며 실제 drop 실패를 삭제하지 않았다. 고정12는 그 실제 실패의 WindowEvent 수정 뒤 고정했다. 고정13은 직접 한글 첫 Enter 결함의 공통 입력 수정 뒤 고정했고, 고정14는 실제 불완전 스냅샷 누락의 탐색 수정,15는 네 언어의 일반 파일 누락 안내,16은 읽지 못한 GGUF 기능의 미확정 처리,17은 문서화한 수치 범위의 표시/접근성 설명과 민감 범위 보호,18은 실제 작은 창 Tab 가림을 위한 공통 CSS 여백 수정 뒤 각각 고정했다. 서로 다른 고정점의 hash나 실행을 현재 전체 기능 성공으로 합치지 않는다.

## 74개 세부 항목

현재 65 pass / 1 fail / 1 unsupported / 6 unrun / 1 blocked다. 부분 실행은 전체 행의 pass로 확대하지 않는다.

| ID | 항목 | 판정 | 실행 근거 또는 남은 범위 |
| --- | --- | --- | --- |
| L01-S01 | 원격 저장소와 수신 ref | pass | 지정 원격 ref를 fetch했고 수신 commit과 FETCH_HEAD가 일치했다. |
| L01-S02 | 기준점·코드 보존 | pass | 필수 조상과 updater 해시가 일치했고, 검증 제품 이후 수신점까지 문서 네 개만 달랐다. |
| L01-S03 | 기존 checkout 보존 | pass | 기존 checkout·branch·다른 worktree와 변경 이력을 보존했다. |
| L01-E01 | 배포판·커널·arch·CPU·RAM·가상화 | pass | Native Ubuntu26.04.1/x86_64·kernel7·16코어/32스레드·약60GiB를 실제 확인했다. |
| L01-E02 | GPU·driver·API | pass | 실제 R9700 두 GPU의 HSA/Vulkan 열거 및 native 사용을 확인했다. 소프트웨어 렌더러와 구분했다. |
| L01-E03 | desktop 세션 | pass | GNOME Wayland/main X11·privateX11 경계를 구분하고 실제clipboard/물리IME13·stockOrca17 이름/invalid범위/valid 안내·최종18 대표UX F03 pass를 기록했다. 전체오류문장/청취/모든GNOME 인증은 아니다. |
| L01-E04 | 도구 버전 | pass | 고정 Node22.23.2/npm12.0.2/Rust1.98.0·작업용 CPython과 실제 시스템/WebKit 버전을 기록했다. |
| L01-E05 | native 의존성 | pass | 승인된 native 개발 패키지 설치와 pkg-config 해석을 확인했다. |
| L01-E06 | 새 의존성·binary | pass | Linux에서 npm 의존성/esbuild와 Cargo 산출물을 새로 만들었고 두 lockfile은 유지했다. |
| L01-E07 | 사용자 데이터 격리 | pass | 자식 HOME/XDG/AIOLM 격리·VM 합성 계정. DPR2/private정리뒤와최종GPU뒤UTC18:46:35 원래878/1560개hashguard 변경·누락·오류0; 실사용파일복사없음. |
| L01-T01 | `npm run typecheck` | pass | 18 CSS 최종 diff의 typecheck8.609초 통과. 보존된17프로필의18 실제 네언어 최소창/native범위 가림수정 replay도 별도 통과. |
| L01-T02 | `npm run lint` | pass | 18 CSS 최종 diff의 전체 lint4.783초 통과. |
| L01-T03 | `npm run test:unit` | pass | 18 CSS 최종 diff의 전체 npm110.497초, Vitest220파일/2577검사와 contracts/scripts/direct/coverage 통과. |
| L01-T04 | `npm run build` | pass | 기본package18 139.034초/actual18fresh·keyboard/4localeDPR1/nativeDPR2/빠른검색과rootF03대표범위pass. Coreexit1/scoped등록·RAPIDv1/v2·Reader종료probe실패 유지. 최종18ROCmCLI17.594초/정상정리·최종자료guard도확인; 다른GPU/GUI확대아님. |
| L01-T05 | `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | pass | 16 최종 GGUF 수정 뒤 fmt0.795초 통과.17/18 src-tauri 바이트 동일 근거이며 재실행 주장이 아니다. |
| L01-T06 | `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | pass | 16 최종 GGUF 수정 뒤 Clippy4.657초 통과.17/18 native 소스 동일, 새 실행으로 세지 않는다. |
| L01-T07 | `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | pass | 16 기본 thread/all-target/all-feature Rust170.747초 통과.17/18 src-tauri/scripts/lockfile 동일 근거를 유지하며18 Rust 재실행은 주장하지 않는다. 실제 opt-in 엔진은 별도다. |
| L01-T08 | `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets --no-default-features` | pass | 16 no-default/all-target check3.132초 통과.17/18 native 소스 동일, 새 실행 주장은 아니다. |
| L01-T09 | `cargo build --locked --manifest-path src-tauri/Cargo.toml --bins` 후 `npm run test:native-cli` | pass | Linux debug CLI build/격리 smoke 통과. Release 결과는 T12와 구분한다. |
| L01-T10 | Python: `python3 -B -m unittest discover -s scripts/runtime-adapters -p 'test_*.py'`, `-s scripts/model-repair`, `-s scripts/provider-compatibility`, `-s src-tauri/src/providers -p '*_tests.py'`, `-s src-tauri/src/providers/tests -p 'test_*.py'`, `-s scripts -p 'test_linux_desktop.py'` | pass | 어댑터·모델복구·provider·Linux desktop Python 검사 통과. 실제 엔진 결과와 합산하지 않는다. |
| L01-T11 | `npm run test:provider-runtime` | pass | provider harness 단위/self-test 및 실제 native gate를 각각 기록했다. |
| L01-T12 | `npm run build:cli` 후 `npm run test:native-cli -- .codex-target/release/aiolm-cli` | pass | 기본 package18 CLI build와 실제 격리 native CLI smoke0.260초 통과. |
| L01-T13 | `python3 scripts/smoke-linux-vault.py` | pass | 격리 합성 Secret Service의 실제 vault CRUD smoke 통과. 앱 복구 여정은 D06이다. |
| L01-T14 | `AIOLM_TEST_PYTHON=<실제 Python> cargo test --locked --manifest-path src-tauri/Cargo.toml --test runtime_interpreter_command_journey -- --ignored` 및 같은 방식의 `runtime_positional_metadata_journey` | pass | 실제 CPython interpreter/positional metadata의 opt-in argv 검사를 실행했다. |
| L01-T15 | updater 모듈: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib app_update` | pass | Linux native updater 모듈 전체 회귀를 실행했다. 실제 업데이트와 별도다. |
| L01-H01 | 엔진 중립 등록 여정 | pass | 고정18후 새flat/개인CPU의 actualGUI등록/help1030/263·plain1012+rich14·새9/3·가림/정확argv·합성echo와실제native5/32+2를구분. 두Close/재열기·6payload이름부재와원래CLI A/B근거 유지. |
| L01-H02 | 공통 옵션 표현 | pass | 고정12 실제 같은 vLLM 도움말320/효과328에서 parser7의 거짓 arity 충돌 해소·진짜 runner 선택지 충돌 보존,32/0 실제 답변5·중지/Retry·재시작·Quit/재열기까지 통과. 알 수 없는 사실은 추정하지 않았다. |
| L01-H03 | app-owned binding | pass | CLI/GUI app-owned binding·alias/raw/metadata 거부와 명시 bridge를 확인했고, 고정12 새 엔진의 GUI→프로필→argv/native 여정으로 보존을 확인했다. |
| L01-H04 | 버전·변조 | pass | 두 build diff/값 보존·변조/OS/alias 거부와 실제 자연 상태 cache5→고정12 parser7,6→7의 stale/시작 거부/재수락·값/원래snapshot 보존 확인. 위치 인자 역할은 명시 재지정이 필요하다. |
| L01-H05 | 경합·취소·실패 | pass | 고정11 실제 exit17/overflow/60.084초 timeout의 제한된 원인 안내·거부/무변경/자손 정리/재시도와 조용한 실제 Cancel을 확인했다. 해당 source/GUI는12와 동일하며 기존 preflight/owner 경계를 보존했다. |
| L01-H06 | Linux 경로·locale | pass | CLI의 POSIX/case/Unicode/symlink/cwd/두 locale와 GUI 경로를 확인했다. 고정12는 별도 실제 tmpfs의 엔진·SDK·읽기전용 모델 경로에서 전체 A01–A09/답변5/보존·정리를 통과했다. USB 분리 검사는 아니다. |
| L01-H07 | 엔진 분기 금지 | pass | 기존중립성/정적책임감사 유지.18은공통CSS여백/comment만변경했고실제freshGUI/native동작·원래대표F03범위를확인했다. 모델별/engine특례·JS/schema/API분기추가는없다. |
| L01-H08 | 외부 v1 미지원 경계 | pass | 고정9 external v1의 benchmark/deep/portable 거부·opaque 크기/compatibility 안내·CSV 이력 보존을 확인했다. |
| L01-H09 | `launch_resources` Linux 정리 | pass | production12의 실제 CPU exec 종료·반복 종료·중단 UUID 회수·canary/소유 자원 정리까지 재검증했다. |
| L02-N01 | llama.cpp CPU | pass | 고정 native CPU의 CLI/GUI 실제 답변·stream/usage·중지/Retry·재시작·Quit/이력 보존을 확인했다. |
| L02-N02 | llama.cpp GPU backend | pass | 기존실제Vulkan/ROCmGUI범위유지. 최종18managedROCmCLI v3실제첫 실행과 새 PID 재시작의 각 산술 요청 전25/25 offload·원래32T0각5/native42+2/DONE. 별도1024T0내용1/2/3clientsocket취소/같은PID동일bodyHTTP200Retry34+708/DONE436132B; GUIbutton/전체1..200품질/18Vulkan아님. 진단4·유한long2MiB/quality256KiB구분·모든inference/timeouts그대로. 네native/collectorbirth·포트Gone/683원본독립사본·모델CLI보호자료exact, 두harness실패보존. |
| L02-N03 | 외부 llama.cpp build 어댑터 | pass | 18원래CPU CLI A/B A01–A09 3.712/3.882초·5/native42+2·6PID두포트Gone 보존. Actual18GUI fresh3/nativethreads3·첫/재시작5/nativeUI저장32+2·contentStop/samePIDRetry·정상두Close 확인. 원래coreexit1은선택등록정상refresh의scopedaudit와구분. |
| L02-N04 | native Linux vLLM 0.31.0 | pass | 외부 vLLM 실제 Node/Rust gate와 고정12 GUI parser7/기존COMMON32·0/답변5·native25+13/Stop·Retry/재시작/Quit·원래6개 이력 보존(전체9개)을 확인했다. 관리형 CUDA 실패와 별도다. |
| L02-N05 | vLLM portable 왕복 | pass | 진짜 index 출처219개 원래 wheel 해시의 export→새 홈 offline import→실제37+3/취소·재시작 통과. SHA/OS/ABI 손상·실행 중 거부·SIGINT 정리/같은ZIP 재시도·기존 파일 보존도 통과. 고정12 CLI도 같은 import 대상의 probe·원래32/0 산술35+23·종료/metadata 보존을 재검증했다. |
| L02-N06 | 원본 Strata | pass | 고정12 원래 manifest/current SDK 두 native stock 실행의6개 lifecycle/provenance 항목 통과, 산술32의 A03/A05/A07 실패는 보존했다. 별도 같은32 SSE는 reasoning-only/65+32/length였다. 앞선 실제 GUI/MCP 결과와 구분한다. |
| L02-N07 | 실제 개인 엔진(Strata 외) | pass | Actual18개인help263/문서화1–32·0/33/abc거부/첫단일Save3재열기·argv3/n_threads3·native5와UI저장32+2·StopRetry/재시작·정상Quit재열기3/최종Close. 원래32T0조건과CLI A/B·coreexit1/등록audit한계 보존. |
| L02-N08 | MLX·vllm-metal | unsupported | 관리형 mlx-vlm·vllm-metal 어댑터의 macOS/Apple Silicon 계약을 따른다. 고정19의 실제 Linux MLX 선택/관리 화면에서 미지원 안내·진행/설치/등록 차단과 저장값 보존도 확인했다. MLX 라이브러리 전체의 Linux 지원과 구분한다. |
| L02-N09 | 원래 품질 잔여 대조(선택) | unrun | 원래 Windows 품질 입력/산출물이 없어 동등 대조는 미실행이다. 별도 Linux 입력 결과로 대체하지 않는다. |
| L02-F01 | 최초 실행·설정 이전(`src/features/onboarding`, `src-tauri/src/home.rs`, `src-tauri/src/config`) | pass | 빈 홈/구버전 이전·원본backup·미등록 session 보존·EACCES 복구 통과. 후속 VM ATK crash는 stale AT-SPI GUID를 인과 대조했고 child 주소만 복구해 같은 앱 onboarding/정상 종료를 확인했다. |
| L02-F02 | 런타임→프로필→옵션(`src/features/model-settings`, `src/features/runtimes`, `src/features/tuning`) | pass | 고정12 실제UI profile CRUD/default/dirty/DeleteCancelConfirm/fallback·fieldReset/Revert/allReset/지침timeout·runtime관리복귀/KeepDiscard 유지.17 실제 첫Save는 값재입력 없는 한 번pointer/저장3 재열기와 후속core뒤 재열기3까지 확인. 저장라이브러리와 active실행map 보존은 F05의 분리판정이다. |
| L02-F03 | UX 품질 | pass | PASS(root원래대표조항판정): actual18fresh/오류복구·keyboard-onlyentry/wrap/exit/logicalfocusreturn·4localeDPR1+nativeDPR2·정확plain1012+rich14/빠른A100→B1saved9/missing0/reset. CarriedIME13/Orca17 namedinvalid33+usable1–32/Entryvalid3; 전체오류문장·청취·watchdogPASS아님. 모든raw실패 유지. |
| L02-F04 | Chat(`src/features/chat`) | pass | 실제 두 CPU 모델×안내 on/off 4회에서 정확한 대상·system 메시지 유무·SSE/usage와 저장 이력 재열기를 확인했다. Qwen은5, Smol의 숫자만 출력 형식 실패는 보존했다. 활성 빈 초안만 저장하는 기존 계약과 구분했다. |
| L02-F05 | 데이터 보존 | pass | 17rawactive-mapfalse/21saved감사 유지.18coreexit1등록refreshscopedaudit·기존9/3/F08값·actual두Close/native34DBUI4exact. MainDPR2copied7·private12continuation/tail완료와원래cleanupexit1보존. 최종GPU뒤18:46:35 878/1560변경·누락·오류0/hash-only. |
| L02-F06 | 프로젝트·RAG·문서(`src/features/projects`, `src-tauri/src/commands/documents.rs`) | pass | 실제 PDF/DOCX·Nomic768·프로젝트/namespace·명시 embedding·keyword fallback을 확인했다. 모델의 ORBIT47 내용 오류는 별도로 보존했다. |
| L02-F07 | STT·영상 전처리(`src-tauri/src/media`) | pass | 고정8 원본 WAV→47·전사 준비 Stop·실행 횟수1/2/2 재사용·네 MP4의 네 part/다섯째 거부·Quit/reopen 통과. |
| L02-F08 | MCP(`src/features/mcp`, `src-tauri/src/mcp/linux_approval.rs`) | pass | Actual14두거부/POST2/tool0/후속0·Unload와Orca17/deadtyped42근거 유지.18교체/두Close와mainDPR2/private인프라정리로기존MCP/이력/저장값 보호. 원래cleanupexit1/정상continuation-tail분리; 새MCP/Reader반복성공을발명하지않음. |
| L02-F09 | 미디어 내용 | fail | 원본 Linux Smol 이미지/영상 질문의 내용 정확도가 native 직접 대조에서도 실패했다. 입력·모델·한도를 바꾸지 않았고 첨부 전송/순서는 별도로 확인했다. |
| L02-F10 | gateway(`src/features/developer`, `src-tauri/src/gateway`) | pass | 고정8 native 같은 요청32+2와 OpenAI/Anthropic/Responses 최종 usage 일치·인증/alias·lease 반환·API/모델 독립 종료 통과. |
| L02-F11 | 측정·공유(`src/features/bench`, `src-tauri/src/benchmark`) | pass | 실제 완료2/취소1의 native 측정·이력·CSV/XLSX·공유 미리보기를 확인했다. 업로드하지 않았다. |
| L02-F12 | 모델 탐색·관리(`src/features/discover`, `src/features/models`) | pass | 요청 최소범위 PASS: 실제12 검색/취소/Retry/실행보호·659B hard-link실패/같은Retry,14 실패snapshot/disabledStart·묶음Cancel/Confirm·3종원자거부,15 네언어,16 Unknown3/정상Qwen·진짜same-origin GGUF+5companion 전체hash·namedCPU 사본의 삭제/UI/busy다운로드/정상정리. 첫harness 오류/같은결과post-audit 보존·재발행없음. 모든optional live-role/large-shard전송/품질/17VM pass는 아니다. |
| L02-F13 | 개인화·스킬(`src/features/settings/PersonalizationSettings.tsx`, `src-tauri/src/personalization.rs`) | pass | 개인화·AGENTS revision/초안 보존·실제 요청 반영·연결 skill/symlink 정책을 확인했다. 임의 skill 실행은 하지 않았다. |
| L02-F14 | 프로세스·포트 소유 | pass | 고정12 실제 Qwen+Smol Ready/API401·200/MCP native 승인 대기를 동시 유지한 뒤 정상 Quit로 모든 소유 PID·포트·승인창 정리, 재실행의 API key없음/임시ID없음을 확인했다. 활성 ffmpeg/pip/CMake 취소 검사는 이 사례에 포함하지 않았다. |
| L03-D01 | 파일·폴더 선택 | pass | 고정12 실제 OS 드롭8회: Unicode PDF·순서/중복·4개 제한·지원 거부·composer 밖/모달 무시와 native picker Cancel/Tab/Space 통과. Smol 실제 이미지/혼합 첨부 수락, Send 없이 초안·31파일/4저장값 보존·소유 정리 확인. 품질은 F09와 별도다. |
| L03-D02 | clipboard·IME | pass | PASS: 실제clipboard·13물리한글첫Enter보존/별도EndEnterLoad·원래eventprefix/config/main/정상정리 유지. 같은IMEguard를18에서도carried근거로구분하며새18물리IME재실행이나다른OSpass는아님. |
| L03-D03 | tray | pass | 고정12 실제 host에서 Close→숨김 중 같은 CPU/포트/답변5 유지→own Show→own Quit/정리·설정false 복원 통과. host 없는 VM fallback도 별도 확인했다. Off의 Passive 등록과 활성 아이콘을 구분했다. |
| L03-D04 | 창·인스턴스 | unrun | 기존설치8의 최소화/두번째실행·360×520와HOST18 nativeDPR2, 별도19의 최소화/복원은 각 범위의 실제 근거다. 최신 읽기 전용23:22 조회는 물리2/활성logical·output1/scale2이며 식별자 미보존·OS변경 없음. 다중 활성 화면 이동 검사는 남는다. |
| L03-D05 | 알림 | unrun | 수정37c0343/고정19에서 연결 수명 결함 해소·백그라운드 제출과 실제 ServiceUnknown 뒤 오류 안내/버튼 재활성화/화면 이동·상태 보존을 확인했다. Shell 객체의 초기5표본과 별도 연속277표본(검출 후27.632초)은 SHOWING=false/유효하지 않은 좌표였다. 실제 OS 표시 확인은 남는다. |
| L03-D06 | Secret Service | pass | native CRUD와 실제 앱 잠금·인증 취소·사용 불가·잠금 해제/동일 키 backup 복구 확인. 평문 대체 없음. |
| L03-D07 | 4개 언어 안내 | unrun | 기존 네언어 종료/숨김·현재버전 안내 유지. 설치16 ordinary Notifications는 r1 ENKO/r3 JAZH 설명/category·좁은창키보드, ENstatus는 DOM한계 명시. updater 가능/불가의 실제조건부 조합은 여전히 남는다. |
| L03-P01 | package 생성 | pass | 기본package18 139.034초/519privacyfake0/SDK3·6payload·독립archive8SHA고정. nlink1은archive8만/원래CargoGUI·CLI nlink2구분. Actual18fresh/F03/native동작/두Close·DPR2/빠른검색/인프라정리+최종ROCmCLI·userdatazero근거연결; 다른backend/GUI패키지실행확대아님. |
| L03-P02 | DEB 설치 수명 | pass | 별도 VM의 DEB 설치·메뉴·재설치/제거·공개 버전 업그레이드 보존과 고정12 동일버전 교체의31파일/4저장값 보존 확인. |
| L03-P03 | AppImage | pass | 기본 AppImage12의 실제 FUSE/extract/NO_CLEANUP·각GUI답변5·두 번째 인스턴스·정확한 PID/birth 유지·0700 추출/정리·canary/31파일/4저장값 보존까지 통과했다. |
| L03-P04 | 실제 업그레이드 | pass | 실제 공개0.3.0→새0.3.1 DEB의 설정/schema14·프로필/이력·앱 소유 OS vault 키와 backup 보존을 확인했다. |
| L03-P05 | runtime bundle | pass | 실제 CPU ZIP export→SDK 없는 VM 새 홈 import→Ready/추론과 실행권한/.so를 확인했다. Python은 N05에서 별도다. |
| L03-P06 | 내보내기 산출물 | pass | 실제 CSV/XLSX 세 행과 공유 미리보기·이력 재로드를 확인했다. 외부 runtime 선택 때도 기존 결과를 보존했다. |
| L03-U01 | R433 진행률 핵심 로직 회귀(L01-T15) | pass | Linux native 진행률 전체 모듈 통과. 500ms는 pending read의 미보고 확정 쓰기 간격이며 write/flush 상한이나 실제 속도 개선이 아니다. |
| L03-U02 | Linux 설치 판별 | unrun | 실제 DEB/AppImage 설치 가능 판별과 소유/arch 불일치 안내의 최종 UI 검사가 남는다. |
| L03-U03 | GUI 안내 | unrun | 설치16 실제 wide Check2회의 Checking/disabled→native오류/reenabledRetry와 정상Quit/같은profile 원래환경재열기0.3.1 동률startup회복·보존/정리 PASS. 실제 설치가능/불가 classifier·진행/installer·release 이동은 남아 전체행 판정 유지. |
| L03-U04 | 통제된 실제 업데이트 | blocked | 공개 최신 버전이 현재0.3.1과 같아 실제 새 release update가 차단됐다. 버전을 조작하거나 확인되지 않은 브라우저 이동으로 대체하지 않는다. |

## 남은 검증과 OS 인계

현재65 pass/1 fail/6 unrun/1 unsupported/1 blocked다. F03은 원래 대표 UX 조항의 actual18/동일 로직의 IME13·Orca17 범위로 root가 pass 판정했다. 실제18 새 옵션/저장3·native 동작·두 Close/재열기·DPR2/빠른 검색·소유 private 인프라 정리는 위 범위로 완료했다. Core 원래 exit1/선택 등록의 scoped 감사, 과거 active-map false/저장21값 감사, RAPIDv1/v2·Reader watchdog 실패는 별개로 보존한다. F09 미디어 내용 품질 실패와 선택 원래 품질 대조·창/인스턴스·사람 알림·조건부 네 언어/updater 설치 판별/안내, 실제 새 버전 차단은 남는다. 읽기 전용 현재 화면 조회는 물리2개/활성1개·scale2만 확인했고 설정을 바꾸지 않았으므로 실제 다중 활성 화면 검사는 unrun이다. 최종18 ROCm CLI 재검증·정상 인프라 정리와 그 뒤878/1,560개 사용자 자료 최종 guard는 위 범위로 완료했다. 이는 남은 조건부 행의 pass를 뜻하지 않는다. 필수 fail/unrun/blocked가 남으므로 전체 목표를 complete로 표시하지 않는다.

제품·검사·계약 변경은 작업별 commit으로 고정했다. 상세 Windows W/G 및 Mac M01–M04/MAC-R01–R13 대응은 [후속 인계](engine-adapter-linux-macos-handoff.ko.md#2026-10-25-linux-수정의-수신과-재검증)를 따른다. Windows/Mac 실제 실행은 이번 Linux 결과로 pass 처리하지 않는다. Mac 실제 실행은 Linux goal의 완료 조건이 아니다. 엔진·대표 UX의 고정점18과 추가 알림 수정 고정점19를 구분해 결과와 OS 인계 문서를 갱신했다. 원격 push는 하지 않았다.

## 고정19 알림 연결 수정과 실제 재검증

UTC2026-10-25T19:53:59.154607Z까지의 추가 근거다. 고정18의 ordinary Settings Send 한 번에서 OS 수락 뒤139,831ns에 앱의 발신 연결이 소실되고, 수락 뒤1,467,434ns에 같은 알림의 Shell Closed(reason2)가 관찰됐다. 명시적인 CloseNotification 호출은 없었다. 기존 plugin2.4.0이 반환 핸들을 버리고 notify-rust4.18.1의 새 zbus 연결도 해제하는 경로와, 설치 GNOME50.1이 앱으로 해석한 발신자의 소실 때 알림 source를 파괴하는 경로를 확인했다. 타임스탬프는 관찰기 수신 시각이며 Shell 내부 app association을 직접 계측한 결과는 아니다. 최초 attach의 자식 식별 실패와 관찰기의 잘못된 JS selector 실패는 원본으로 보존했고, 같은 세션의 엄격한 재확인과 별도 selector 수정 뒤 실제 Send는 한 번만 수행했다.

제품 `37c0343fe90b16588b2319f3ace96e6df274bf02`는 Linux 알림 연결 하나를 앱 수명 동안 소유한다. 동시 제출은 큐에 쌓지 않고 거부하며 연결 획득·송신·응답의 전체 대기 한도는5초다. 시간 초과나 오류의 원격 수락 여부가 불확실하므로 자동 재전송하지 않고, 정상 연결은 유지한다. 닫힌 연결은 다음 명시적 제출에서만 교체한다. lockfile에 고정된 zbus5.19.0에 직접 의존할 뿐 crate/version과 async-io 실행 방식은 유지한다. 권한 호출과 Windows/Mac의 실제 전송은 공식 plugin을 사용한다. 네 언어의 일반 문구·카테고리 선택·브라우저 미지원·완료 작업의 오류 격리는 그대로다.

검사는 전체 npm117.932초/220파일·2577개, type9.133초, lint5.305초, Rust all-targets/all-features175.225초, Clippy14.517초, fmt0.816초, `cargo check --no-default-features`20.012초, 기본 package193.946초, native CLI smoke0.258초를 통과했다. Rust에는 실제 격리 D-Bus에서 요청 종료 뒤 소유 유지/소유자 종료 때 해제, 닫힌 연결의 다음 요청 복구, 인증에 응답하지 않는 실제 Unix peer의 시간 한도, 일반 테스트 endpoint의 늦은 응답·중복 전송 없음·정상 연결 보존, 올바른 응답 타입/ID의5개 회귀가 포함된다. 첫 컴파일 실패와 테스트 endpoint의 Tokio timer 컨텍스트 실패를 보존하고 해당 테스트만 고친 뒤 전체 Rust를 다시 통과했다. 이 일반 endpoint는 OS 알림 daemon을 대체하지 않는다.

고정19는 위 commit과 동일한9개 제품·검사 파일 바이트로 빌드했으며, 원래 build receipt의 HEAD+diff·당시 새 파일 해시와 commit의 바이트 대응을 보존했다. UTC19:50:04.163953Z 고정의 배포 SHA-256은 다음과 같다.

| 파일 | SHA-256 |
| --- | --- |
| release GUI | `7568031880e19f047bd8137ce34e1af4c6cfb489ee8117e6799c2ed74e54bcc3` |
| CLI | `16c218c91fab515076ec401522989d9a6561fe6984addc0dfbcbb22214d7d786` |
| DEB | `986cd56508a5235ea9c70fc8e64d558b46edeea6e6ff019776228dc5a38f6f84` |
| AppImage | `a47a06e87a03198ea764eeebe361253865b010bbeb8d0714e19eacd96344dbda` |

519개 staging 파일의 개발 경로/가짜 fixture 검사, 여섯 payload, 세 SDK helper의 현재 전체 바이트 포함과 독립 archive8사본을 확인했다. GUI는 고정한 release 사본으로 실행했다. 실제 같은 데스크톱의 ordinary Settings Send 한 번에서 새 요청·수락 ID·relay의 원래 발신자/PID를 연결했고,28.224초 뒤에도 live bus PID 조회가 같은 앱을 가리켰다.30.401초 관찰 checkpoint에 즉시 소실/닫힘이 없었으며, 약130.558초 뒤 정상Close 때 발신자 소실과 같은 ID의 Closed2를 관찰했다. 관찰기133.517초와 별도 normalClose1.366초가 모두 exit0이고, 소유 GUI/WebKit3birth·관찰한 포트의 IPv4/IPv6가 종료됐다. 기존 driver는 빈 ready 상태로 남겼다. Source34/DB family·복사한 합성7파일·데스크톱 설정과 원래878/확장1560개 사용자 파일의 hash-only 검사는 변경·누락·오류0이었다.

즉시 연결 종료 결함은 이 전후 결과로 해소됐지만 실제 배너/알림센터의 사람 확인은 대기 중이므로 D05는unrun이다. 원래18 RED와 중간fail 판정은 그대로 보존한다. 엔진·대표 UX·설치 VM·직접 IME·Reader의 근거는 각 절의18/16/13/17 범위로 유지하며 이 알림 재검증을 해당 전체 여정의19 재실행으로 계산하지 않는다. Windows W07/W08/G07과 Mac M01/M02/M04·MAC-R06/MAC-R11에서 새 제출 IPC·권한/오류·네 언어·실제 표시·정상 종료를 다시 확인한다. 전체 Linux 목표는 진행 중이며 원격 push는 하지 않았다.

## 고정19 최소화 상태의 실제 채팅 완료

UTC2026-10-25T20:54:07.500770Z까지의 별도 실제 실행이다. 같은 고정19 release GUI와 원래 개인 CPU 엔진·모델을 새 임시 사용자 환경에서 사용했다. 첫 Start는 환경이 달라진 help fingerprint 때문에 native 실행 전에 정상 거부됐다. 전체261개 옵션/제약/help 본문은 같았고 차이는 임시 HOME/XDG 환경에 대응했다. 정상 Discover help→검토→Use these options로 새 fingerprint를 수락한 뒤 기존 옵션3/max32/temperature0을 유지해 Ready를 확인했다. 캐시를 직접 고치거나 최신성 검사를 생략하지 않았다. 잘못된 대기 버튼명과 최초 자식 식별 실패도 원본으로 남겼다.

일반 Chat에 `Compute 2 + 3. Reply with the number only.`를 입력하고 Send 한 번 직후 표준 창 최소화를 요청했다. 실제 HTTP200/SSE는 자연 종료 `5`, native usage32+2=34, finish reason `stop`, DONE 한 번이었다. 앱의 완료 경로에서 일반 알림 제목/본문과 양성 식별한 발신 PID·relay·수락 ID44를 연결했다. Settings 테스트나 직접 알림 주입이 아니다. 최초 관찰기 모듈명 충돌은 Send 전에 발생했고, 별도 수정본에서 실제 Chat 요청은 한 번만 보냈다.

원본 관찰기의 `background_proven:false`는 그대로 보존했다. 이 판정은 최소화 조건에 X11 map_state0/1까지 요구했으나, [EWMH의 HIDDEN](https://specifications.freedesktop.org/wm/1.5/ar01s05.html)과 [X11의 viewable 정의](https://xorg.freedesktop.org/releases/current/doc/xproto/x11protocol.html#glossary:Viewable)는 compositor에서 숨김과 X 서버의 매핑을 구분한다. 별도 원본 감사와 root 재계산에서 Notify 직전4.104ms/직후12.726ms의 표본이 모두 WM_STATE Iconic·HIDDEN·비활성이었고, 복원 전까지 약150.290초의18개 일치 표본과 DOM hidden/blur를 확인했다. 모순 표본이나 기록된 Map/Reparent/Circulate/Destroy 이벤트는 없었다. 따라서 실제 최소화·백그라운드 상태의 완료 알림 제출 근거로 수락하되 정확한 서버 전환 시각이나 화면 픽셀 관찰로 확대하지 않는다. 원본 실패 값을 고치거나 요청을 반복하지 않았다.

일반 설정 화면에서 채팅 알림 선택을 원래 raw 값으로 정확히 복원했고, 모델은 정상 Unload0.356초, 앱은 정상 Close1.363초에 종료했다. 모델·GUI/WebKit의 소유 프로세스와 관찰한 포트는 종료됐고 기존 driver는 빈 ready 상태로 유지했다. 임시 프로필에는 정상 help/등록 fingerprint 갱신·선택 프로필 revision과 이번 합성 대화 한 건만 반영됐으며 나머지 값은 같았다. 원본 Source34/DB family·데스크톱 설정과878/1,560개 사용자 파일의 hash-only 최종 검사는 변경·누락·오류0이었다. 모델 Unload 뒤에도 알림 연결은 앱이 소유했고 앱 Quit 뒤 해제됐다.

배너/알림센터의 실제 표시는 아직 확인되지 않아 D05는unrun이며 전체 집계도 그대로다. 이 실행은 해당 개인 CPU 엔진의 실제 채팅·백그라운드 알림 경로만 추가하며 다른 엔진/GPU·설치본 전체의 고정19 재실행을 뜻하지 않는다. 같은 시점의 읽기 전용 화면 조회도 물리2개 중 활성1개/scale2였으므로 다중 활성 화면 검사는 남는다. 제품 코드는 바꾸지 않았으며 앞 절의 전체 자동 검사·배포 해시를 유지한다.

## 고정19 OS 접근성 표시 관찰

UTC2026-10-25T21:32:49.246566Z까지의 별도 실제 실행이다. 원래 D05의 실제 desktop 알림 수신은 사람/픽셀 관찰만을 요구하지 않으므로, 기존 Shell의 인증된 AT-SPI 연결에서 OS가 제공하는 표시 상태를 관찰했다. 서비스나 접근성 설정을 켜지 않았고 IsEnabled/ScreenReaderEnabled=false를 그대로 유지했다. 같은 고정19 release GUI의 새 격리 환경에서 일반 Settings Send 한 번을 실행해, 양성 식별한 앱 발신자·relay·수락 ID45와 정확한 일반 테스트 제목/본문을 연결했다.

30.235초의 native 관찰기는64개 Shell 이벤트 중 정확한 테스트 문구를 가진 NOTIFICATION 역할 객체 한 개를 기록했다. 초기5개 표본은 알림 컨테이너·제목·본문 모두 VISIBLE=true지만 SHOWING=false였고 SCREEN 좌표/크기는 INT_MIN으로 유효하지 않았다. 따라서 객체 생성은 확인했으나 실제 표시 pass는 성립하지 않는다. 이5표본을30초 전체의 연속 표시 상태로 확대하지 않는다. 이번 접근성 관찰은 D-Bus 알림 ID를 직접 포함하지 않으므로 연결 근거도 고유 문구·시각·발신 PID의 상관관계로 한정한다. 알려진 해당 객체/상위 경로에는 제어 관계나 Action이 없었으며 임의의 Shell 조작이나 추가 Send는 하지 않았다. 다른 앱·알림 내용은 기록하지 않았다.

native 관찰기와 별도300.648초 발신 관찰기는 모두 exit0으로 종료했고 자체 구독·연결을 해제했다. 그 전의 전송 없는 관찰기 준비/동기화 실패와 시작 시 자식 식별 실패, 실행 전 준비본 변경의 별도 소유권 재검토 기록은 원본으로 보존했다. 앱은1.357초에 정상 Close됐고 소유 GUI/WebKit 세 프로세스·관찰한 포트의 IPv4/IPv6·해당 세션이 종료됐다. 기존 driver는 빈 ready 상태로 남겼으며 원본 Source34/DB family·복사한 합성7파일·데스크톱 설정과878/1,560개 사용자 파일의 hash-only 검사에서 변경·누락·오류0을 확인했다. 실제 OS 표시와 새 Linux 전송 경로의 별도 실패/앱 동작 유지 검증은 남아 있어 D05와 전체 집계는 그대로다. 제품 코드와 배포 바이트는 변경하지 않았다.

## 고정19 실제 알림 서비스 부재와 앱 회복

UTC2026-10-25T21:48:40.580945Z까지의 별도 실제 검증이다. 같은 고정19 release GUI를 새 임시 HOME/XDG와 합성7파일로 실행하고, 이 자식 앱의 세션 연결만 실제 격리 dbus-daemon으로 지정했다. 기존 데스크톱 broker·AT-SPI 연결·설정은 유지했다. 격리 broker는 알림 소유자와 서비스 활성화 디렉터리가 없으며, 활성화 목록의 내장 D-Bus 이름 하나가 실제 소유 broker PID를 가리키는지 확인했다. 첫 사전검사의 잘못된 빈 목록 가정은 GUI/Send 전에 실패했고 정상 종료/실제 wait0과 원본 기록을 보존했다. 내장 이름을 포함하는 실제 규약을 확인한 새 격리 환경에서 다음 여정을 실행했다.

일반 Settings Send 한 번에 앱의 발신 PID/birth·요청 serial과 실제 core의 `org.freedesktop.DBus.Error.ServiceUnknown` 응답을 연결했다. GUI의 정확한 실패 문구, Send 버튼 재활성화와 General→Notifications 복귀를 확인했다. 관찰한2.014초 동안 Notify는 한 번이고 수락 응답이나 자동 재전송은 없었다. 전체 Send/회복 관찰기6.494초는 exit0이며 native7파일·채팅 저장값4개·preferences·모델/API 정지 상태·원본 source가 실행 전/후/최종 표본에서 같았다. 오류 화면의 실제 앱 캡처도 확인했다. 이 결과는 해당 Linux 서비스 부재 경로의 하위 pass이며 모든 오류·권한·OS의 보편적 성공이나 무제한 시간의 재전송 부재를 뜻하지 않는다.

정상 Close 검사1.438초 뒤 소유 GUI/WebKit 세 프로세스·관찰한 포트의 IPv4/IPv6·해당 세션이 종료됐다. 격리 broker는 처음 생성한 Popen 소유자가 정상 종료 요청과 실제 wait0을 확인했고 소켓·임시 runtime·소유자도 정리됐다. 최종 root 검사에서 원본 Source34/DB family·복사한 합성7파일·데스크톱 설정과878/1,560개 사용자 파일의 hash-only 변경·누락·오류는0이었다. 기존 driver는 빈 ready 상태로 유지했다. 앞 절에 남겨 둔 새 Linux 전송 경로의 실패/앱 동작 유지 하위 검증은 이 범위에서 완료했으며, 실제 OS 표시가 남아 D05는unrun이다. 제품 코드·배포 해시·앞선 전체 자동 검사 범위는 그대로이고 원격 push는 하지 않았다.

이후 읽기 전용 재확인에서도 UTC21:51:29의 공식 latest API는 HTTP200/v0.3.1로 현재 소스0.3.1과 같았고, [공식 최신 페이지](https://github.com/aiolm/AioLM/releases/latest)도 같은 태그로 연결됐다. 실제 새 버전 업데이트의 차단 조건은 유지한다. UTC21:52:01의 화면 조회는 물리2개 중 활성logical/output1개·scale2였으며 다중 활성 화면 이동 검증도 남는다. 모니터 식별자는 저장하지 않았고 OS 설정은 변경하지 않았다.

## 고정19 Linux MLX 미지원 안내와 저장값 보존

UTC2026-10-25T22:35:28.758040Z, 같은 고정19 release GUI의 격리된 사용자 환경에서 실제 모델/API가 모두 정지한 상태로 일반 모델설정의 MLX 선택과 Manage runtimes를 방문했다. Apple Silicon macOS 전용 안내, 비활성 runtime fieldset과 Continue to profile을 확인했다. 이 단계에는 Start 버튼이 없으므로 이를 표시된 Start 버튼의 비활성화로 표현하지 않는다. 관리 화면에서는 동일한 미지원 안내와 비활성 Install isolated environment/Register existing Python environment를 실제 캡처로 확인했고 두 동작을 실행하지 않았다.

일반 Back→원래 엔진 선택→Close 뒤 native11파일·전체 설정·저장 프로필/적용 설정·runtime/model 선택·채팅 저장값4개·preferences가 실행 전/후/최종 표본에서 정확히 같았다. 관찰기8.521초는 exit0이다. 실제 MLX 기준선은 빈 Default 프로필 한 개, 적용 설정 없음, 옵션 bank 키 없음이었으며 임의의 비어 있지 않은 MLX 값을 심어 보존했다고 주장하지 않는다. 이 하위 검증은 N08의 Linux 미지원 처리 근거를 보강하며 관리형 MLX 실행 판정은 unsupported로 유지한다. 이 시점에 앱은 정지 상태로 계속 열려 있어 전체 종료 검증이나 다른 엔진 여정의 완료를 뜻하지 않는다. 제품 코드·고정 배포 해시·전체65/1/6/1/1 집계는 바꾸지 않았다.

## 고정19 OS 알림 객체의 연속 표시 관찰

UTC2026-10-25T23:22:03.431489Z에 완료했다. 앞선 ID45의5표본은 실제로0.451430779초만 덮었고 이후 같은 경로를 다시 측정하지 않았다. 이를30초 동안 계속 표시되지 않았다는 근거로 쓰지 않는다. 새 관찰기는 원래의30초 관찰 틀을 유지하면서 정확한 일반 테스트 제목/본문이 일치하는 Shell 알림 객체를 목표100ms 간격으로 계속 측정했다. 기존 Shell/Registry·접근성 설정을 사용했고 OS 정책을 바꾸거나 별도 서비스를 켜지 않았다.

같은 고정19 GUI와 로드된 개인 CPU 엔진을 유지한 채 일반 Settings Send를 한 번 실행했다. 실제 앱 PID/발신 연결·relay·수락 ID48을 확인했으며 자동 재전송·연결 상실·CloseNotification은 관찰되지 않았다. 정확한 객체 하나에서277표본을 얻었고 실제 표본 구간은27.631969189초, 첫 표본은 Send 요청 기록 뒤212.064ms였다. 모든 표본에서 정확한 문구를 다시 확인했지만 SHOWING=false와 유효하지 않은 SCREEN 좌표였으며 양성 표시 표본이나 질의 불가 표본은 없었다. 관찰기의 실제 armed 구간30.008초와 객체 검출 뒤 표본 구간을 구분한다. AT-SPI가 FDO ID를 제공한 것은 아니므로 두 근거는 문구/시간으로 연결하며 ID 동일성을 만들어 쓰지 않는다.

native 관찰기와 전송 관찰기는 모두 exit0으로 끝났고 자체 구독·연결·resolver를 정리했다. 전후 접근성 flags와 화면 geometry는 같았고, 식별자 없는 조회는 활성1개/1920×1080 logical·3840×2160 mode·scale2였다. 좌표 단위를 임의로 변환하거나 알림 역할만으로 배너/센터를 구분하지 않았다. native16파일·전체 설정·채팅4값/preferences·같은 엔진 PID/로드 상태·원본 Source34/DB가 유지됐고 일반 Chat 복귀 뒤에도 보존을 재확인했다. 이 관찰 시점에는 앱/엔진을 유지했으며 최종 Quit은 아래 후속 개인 엔진 여정에서 완료했다. 이 결과도 실제 OS 표시 성공을 입증하지 못하므로 D05와65/1/6/1/1 집계는 그대로다. 제품 코드·배포 해시는 변경하지 않았다.

## 고정19 새 엔진 전체 여정과 최종 보존 검사

고정19 production GUI/CLI를 먼저 고정한 뒤 UTC2026-10-25T22:08–22:09에 새 합성 엔진 `q776eb1`과 실제 개인 CPU 엔진의 새 옵션 `--pe374044-threads`를 생성했다. 원래 llama.cpp revision과 모델 바이트를 유지하고 엔진 쪽 옵션 alias만 추가했다. 앱 제품 코드는 `37c0343` 그대로이며 전용 GUI나 engine ID 분기는 추가하지 않았다. 생성 전과 최종 문서 공개 전 모두 여섯 배포 payload·HEAD·무시되지 않는 작업 파일에서 새 두 접두사의 ASCII/UTF-16LE 부재를 확인했다. 문서에 이름을 기록한 뒤의 문서 문자열을 고정 전 제품 지식으로 계산하지 않는다.

실제 CLI는 조정 가능한 manifest와 고정값3 대조 manifest에서 각각3.684초/3.843초에 A01–A09를 통과했다. 산술 답5·native42+2 usage와 별도 내용 생성 후 취소·정상 정리를 확인했다. 이 CLI 요청의 temperature는 생략됐고 산술 한도32/별도 취소 한도1024였다. 아래 GUI의32/temperature0 조건이나 GUI Retry를 이 CLI 결과로 대신하지 않는다.

실제 합성 엔진 GUI에서는 help1030개/공통 옵션1012개, 복합 옵션을 포함한1026개 표시, 새 옵션의 일반 입력9·저장·재열기, 민감 값 마스킹, Unicode/공백/인증과 정확한 argv·Ready·합성 응답·Unload를 확인했다. 첫 실행은 최종 보존 검사에서 허용한 probe 변경을6개로 좁게 센 탓에 exit1이었다. 원본을 유지한 파일 감사에서 실제8개 변경이 현재 source의 probe 갱신과 일치하고 나머지 등록·프로필·적용 설정은 보존됨을 확인했다. 저장값은 미해석 타입의 문자열 `"9"`였고 Markdown 이스케이프 한 쌍의 저장/표시 차이도 원문 전체 대조로 확인했다. 이를 원래 실행기 전체 exit0이나 숫자 타입 저장으로 바꾸지 않는다.

개인 엔진 GUI의 실제 help 탐색261개와 metadata가 더해진 수락 schema263개를 구분한다. 범위1–32 설명,0/33/abc의 오류와 Save 차단, 유효값3·max32·temperature0의 최초 Save as/재열기를 확인했다. 실제 argv의 새 옵션3과 native `n_threads=3`, 소유 프로세스·포트·Ready를 확인한 뒤 첫 추론과 재시작 뒤 추론 모두 답5·native/SSE/GUI/저장 이력의32+2=34가 일치했다. 내용 생성 후 trusted Stop, 같은 PID/동일 HTTP 본문의 일반 Retry, 정상 Unload 뒤 새 PID 재시작을 실제 수행했다. 빠른 취소 실행기의 내용 관측→Stop54.645ms는 자동화 경로의 측정이며 엔진 성능 개선 수치가 아니다. Retry usage34+32=66은 해당 재요청의 실제 결과이고 긴 답변 전체 품질 성공을 뜻하지 않는다.

초기 설정 파일의 직렬화/LF 비교 오류, 이미 자연 종료된 빠른 생성의 Stop 거부, 두 번째 Starting 응답에 선택적 PID가 없는 경우의 실행기 오류, 재시작 산술 뒤 누락된 감사 입력으로 발생한 원래 exit1을 모두 보존했다. 각 도달 지점의 원본·별도 실제 후속 동작·파일 전용 감사를 연결해 위 핵심 여정을 수락했다. 이전30초 Ready 관찰 자체가 성공했다고 주장하지 않으며, 후속 산술 전에는 실제 Running/health200을 다시 확인했다. Native 자식의 정리된 실행 환경은 GUI desktop 환경과 다르게 구성하는 제품 계약과 전체 해시를 대조했다. 검사기 오류를 제품 결함으로 세거나 소유권·readiness·해시 검사를 없애지 않았다.

로드된 상태의 정상 Quit3.278초 뒤 같은 프로필을 별도 새 프로세스로 열어 저장3/32/T0·runtime/model binding·대화 이력과 자동 시작 없음을 확인했다. 재열기 검사는11.128초, 이후 별도 최종 정상 Close는 UTC2026-10-26T00:01:22Z에3.046초/exit0이었다. 최종 root 검사도 UTC00:06:25Z에 exit0이었다. 이번 두 GUI epoch·두 native 엔진·관찰기의 양성 식별9개 프로세스 birth와 관찰한 네 포트의 IPv4/IPv6가 모두 종료됐고 원래 driver는 빈 ready 상태로 유지됐다. 저장 후 native18파일·17개 프로필 항목/7개 적용 항목과 대화 이력, 닫힌 DB의 네 UI 값, 원래 source34파일/DB family를 보존했다. 선택한 새 등록의 두 Start revision 증가 등 의도한 변화는 앞선 source 감사와 연결했다.

원본878개와 확장1,560개 사용자 파일의 최종 hash-only 대조에서 변경·누락·오류는0이었다. 기존 IBus/접근성/desktop 설정도 같았다. 독립 archive8개와 여섯 payload의 전체 SHA/크기, 세 SDK helper의 현재 전체 바이트 포함을 다시 확인했다. 기존519개 staging 파일의 개인정보/가짜 파일 검사 결과는 산출물 바이트 일치를 근거로 유지하며 새519파일 스캔으로 세지 않는다. 이 최종 근거의 SHA-256은 `79c639199a5269bc490164213b6d339208064152cbd3746358b82ed505a89258`이다. 고정19의 다른 backend·실제 설치/업그레이드·물리 IME 전체 재실행을 뜻하지 않으며 기존 source별 근거를 유지한다. 미디어 품질 실패·실제 OS 알림 표시·다중 활성 화면·조건부 업데이트 등은 남아 있고 전체 집계65 pass/1 fail/6 unrun/1 unsupported/1 blocked와 목표 진행 중 상태는 그대로다. 원격 push는 하지 않았다.


## 다른 세션으로 재개

2026-10-26 사용자 요청으로 현재 작업 브랜치를 원격 게시하고 나머지 검증을 다른 세션/AI에 인계한다. 위 각 실행 당시의 “push하지 않았다”는 기록은 해당 시점의 사실이다. [최신 재개 인계](linux-validation-resume.ko.md)에 정확한 남은 항목·로컬 전용 근거·다음 실행 조건을 정리했다. 전체65 pass/1 fail/6 unrun/1 unsupported/1 blocked이며 검증 전체 완료를 선언하지 않는다.
