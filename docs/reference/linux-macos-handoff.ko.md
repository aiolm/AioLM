# Linux·macOS 이식 및 검증 인계

최초 Windows 검증: 2026-10-03, Linux·원격 CI 후속 검증: 2026-10-03~04. 이 문서는 이식 구현의 검증 결과와
Linux·macOS에서 이어서 수행할 작업을 설명한다. 공통 개발 절차는
[Cross-platform validation](cross-platform-validation.md)을 참고한다.

## 현재 상태와 구현 범위

Windows에서 확인할 수 있는 이식 결함을 수정하고 자동 검증을 추가했다.
아래 Windows 결과는 Linux·macOS에서의 실행 성공을 의미하지 않는다. 대상 OS의
CI, 패키지 설치, 실제 모델·GUI 검증은 아래 완료 기준을 충족할 때까지 미완료다.
v0.2.1부터 Windows x64와 Linux x86_64(Ubuntu 24.04+) 설치 파일을 공개한다.
macOS와 Linux ARM64/DGX 검증은 별도로 남아 있다.

| 영역 | 구현 내용 | 대상 OS 검증 기준 |
| --- | --- | --- |
| 런타임 선택 | OS와 x64/ARM64 구분, Linux tar.gz/CPU/CUDA sidecar, macOS CPU·Metal 배포 이름 처리 | 실제 릴리스 다운로드·설치·probe |
| 압축·배포 | ZIP/tar.gz, 최상위 래퍼 폴더, 실행 권한 보존, 내부 SONAME 링크를 파일로 변환 | Linux .so / macOS .dylib 로딩과 ZIP 내보내기·가져오기 |
| 압축 안전성 | 경로 탈출·특수 파일·외부 링크·순환 링크·중복 파일 거부, 확장 크기/개수/메타데이터 한도, 취소 | 회귀 테스트를 Unix에서도 실행 |
| Metal | 백엔드 추천·UI·번역·MTL0/Metal0 선택·빌드 옵션 | Apple Silicon GPU 추론 |
| CPU | GPU가 함께 포함된 런타임도 CPU 선택 시 서버·perplexity의 GPU 오프로딩 차단; 저장 프로필 보존 | ARM64 CPU/Metal을 비교해 실제 실행 장치 확인 |
| GPU/CPU 정보 | Linux PCI 슬롯별 이름·드라이버 보완, macOS sysctl CPU/Apple GPU 이름 | 실제 장치·드라이버 정보와 대응 |
| 메모리 | Linux procfs RSS, macOS resident size, 공통 150ms 샘플링; Metal 통합 메모리를 별도 VRAM으로 중복 계산하지 않음 | 실제 모델 프로세스 RSS와 비교 |
| 프로세스 | Linux TCP inode 필드 인덱스 수정, macOS CLI 실행 파일·PID 식별 수정 | 시작·정지·재시작·비정상 종료 |
| MCP | Unix 초기화/호출 취소와 자식 프로세스 종료 회귀 테스트 | 실제 GTK/Cocoa 승인 창 취소 |
| 모델 식별 | POSIX 대소문자·역슬래시 구분, 기존 원본 모델 경로를 이용한 프로필 키 복구 | 대소문자가 다른 실제 모델·프로필·세션 |
| 패키징 | Windows NSIS/MSI, Linux DEB/AppImage, macOS APP/DMG 자동 선택; 테스트 서버 배포 제외 | 실제 설치·시작·제거 |
| 업데이트 | 설치된 DEB/APP의 소유권·위치·아키텍처 확인 후 해시 검증을 거쳐 시스템 설치 화면으로 전달 | 설치 화면에서 업데이트 완료·재실행 |
| CI | Linux와 macOS ARM64/Intel 각각 Clippy·Rust 테스트·바이너리 빌드·격리된 홈 CLI 검사 | 원격 작업 결과를 확인하고 실패 해결 |
| 패키지 CI | 수동 desktop-packages.yml, 네이티브 패키지·체크섬 아티팩트 | 아티팩트 설치 검증, 이후 정식 릴리스 연결 |

CPU 인자 정규화는 서버와 perplexity에 적용한다. 인자 문법이 다른 `llama-bench`나
도움말·버전·장치 조회에 서버 인자를 일괄 삽입하지 않는다.

업데이트는 DEB/DMG 파일을 열었다고 완료되는 것이 아니다. DEB는 데스크톱의 패키지
설치 화면에서 사용자가 마무리해야 하고, DMG는 **기존 앱이 있는 설치 폴더**의 앱을
교체해야 한다. AppImage와 개발/기타 수동 설치는 릴리스 페이지 안내를 사용한다.
v0.2.1 릴리스 워크플로는 Windows NSIS/MSI와 Linux DEB/AppImage를 함께 게시한다.
macOS 파일이 실제 릴리스에 게시되기 전에는 macOS 업데이트 설치 버튼을 사용할 수 없다.

## 최초 Windows 검증 (2026-10-03)

이 절의 테스트 수와 산출물 크기는 최초 검증 시점의 기록이다. 후속 CI와 실제 설치
결과는 아래 Linux 후속 검증 절에서 별도로 기록한다.

| 검증 | 결과 |
| --- | --- |
| TypeScript 전체 타입 검사, ESLint | 통과 |
| 계약 패키지·직접 실행 테스트·패키징 스크립트 테스트 | 통과 |
| Vitest 전체 | 144개 파일, 1,447개 테스트 통과 |
| Vitest 커버리지 | Statements 78.17%, branches 73.21%, lines 82.16% |
| Rust format, Clippy `-D warnings` | 통과 |
| Rust 전체 타깃·전체 기능 테스트 | 라이브러리 715 + CLI 10 + 가짜 서버 통합 1 = 726개 통과 |
| 프런트엔드 production, Windows GUI/CLI debug 빌드 | 통과 |
| 격리된 홈 CLI 초기화·설정 저장/재로딩·빈 런타임 목록·서버 중지 상태 | debug/release 모두 통과 |
| 실제 CPU·Vulkan 런타임 설치 | llama.cpp b11349 다운로드·SHA-256·압축 해제·preflight 통과 |
| 실제 다운로드 취소 | 통과; 공통 취소 테스트는 CPU 사용 |
| 업데이트 UI, 패키징 선택 | 각각 13개, 3개 테스트 통과 |
| CI YAML 문법·OS 행렬, 변경 파일 공백 검사 | 통과 |

기본 Rust 실행에서 실제 모델·다운로드 등 7개 테스트는 명시적 opt-in으로 제외된다.
첫 병렬 실행에서 일부 UI·프로세스 타이밍 테스트가 시간 초과했다. 동시 컴파일 부하를
제거하고 Vitest 작업자 4개, Rust 테스트 스레드 4개로 재실행해 통과했다.
테스트 시간 제한은 변경하지 않았다.

Windows 패키지도 생성하고 파일 목록을 검사했다:

| 산출물 | 크기 | 확인 범위 |
| --- | ---: | --- |
| AioLM_0.2.0_x64-setup.exe | 10,771,221 bytes | 생성 및 NSIS 파일 목록 |
| AioLM_0.2.0_x64_en-US.msi | 14,086,144 bytes | 생성 및 MSI DB 읽기 전용 파일 목록 |

두 패키지 모두 제품 GUI와 CLI를 포함하고 `fake-llama-server`는 제외됐다.
릴리스 실행 파일에 개발 PC의 홈/워크스페이스 경로가 UTF-8·UTF-16으로 포함되지
않았음을 검사했다. 설치 파일을 실제 설치하거나 기존 사용자 앱을 교체하지는 않았다.
실제 모델을 로딩한 Windows GPU 추론과 ROCm 실기 검증도 이 결과에 포함하지 않는다.

Windows 검증 당시에는 대형 프런트엔드 청크 안내와 release의 미사용 debug 전용 함수
(`is_loopback_host`) 경고가 있었다. 후자의 컴파일 조건은 Linux 후속 작업에서 수정했다.
원본 검증 로그와 로컬 장비 메모는 Git에
포함하지 않으며, 다음 작업자는 아래 명령으로 자신의 환경에서 결과를 재검증한다.

## Linux에서 이어서 확인한 결과

Ubuntu 26.04 x64에서 Node 22.23.2, npm 12.0.2, Rust 1.98.0으로 검증했다.
관리자 설치 없이 임시 폴더에 도구와 Ubuntu 개발 패키지를 준비해 사용했다.
이 환경의 결과는 Ubuntu 24.04 CI나 다른 배포판의 설치 검증을 대신하지 않는다.
기존 사용자 설정·런타임을 테스트 자료로 사용하지 않았다.

[이식 커밋 `687434a`의 CI](https://github.com/aiolm/AioLM/actions/runs/37033112852)를
확인한 결과, Windows Rust와 프런트엔드는 성공했으나 Linux와 macOS ARM64/Intel은
Clippy에서 중단됐다. 세 작업 모두 후속 네이티브 테스트·빌드·CLI 검사가 실행되지
않았다. 패키지 워크플로의 기존 실행 이력도 없었다.

이번에 수정한 항목:

- Windows 전용 import·함수와 Linux/macOS에서 쓰이지 않는 함수의 컴파일 조건을
  실제 사용 플랫폼에 맞췄다. Windows에서만 필요했던 가변 바인딩도 제거했다.
- Unix CPU preflight 테스트가 실행 파일을 쓰기 전에 임시 디렉터리를 만들도록 수정했다.
- CLI 정지·재시작은 종료 신호 후 최대 10초 동안 이전 서버의 종료를 기다린다.
  시간 초과 시 상태와 오류를 보존하고 재시작을 진행하지 않는다. SIGTERM 후 정리를
  지연하는 자식 프로세스로 회귀 검증했다.
- Headless 서버의 로그 수집을 시작 CLI의 수명과 분리했다. 로그는 1MiB로 제한하고
  파이프 청크에 걸친 비밀 값과 한글을 줄 단위로 처리한다. 서버 파이프 EOF에서
  수집기를 종료하며, 정지·재시작은 수집기 종료도 기다린다.
- CI와 패키지·릴리스 작업에서 `package.json`에 고정된 npm을 설치한다.
  기존 실행은 Node에 포함된 npm 10.9.8을 사용해 버전 요구 경고를 냈다.
- Linux ROCm 10의 추가 공유 라이브러리와 SDK 내부 디렉터리 구조를 처리한다.
  실제 ELF 종속성을 읽어 완성 여부를 확인하고, 누락된 공급자 라이브러리만 기존
  SDK 일치 검사와 함께 보완한다. 호스트 드라이버는 복사하지 않는다.
- GPU 런타임의 preflight는 실제 백엔드 장치 이름을 확인한다. 빈 장치 목록에
  진단 메시지가 함께 출력돼도 가속기가 있는 것으로 판정하지 않는다.
- MCP의 native `inputSchema` 응답을 화면의 내부 형식으로 변환한다. 실제 도구 조회
  응답으로 호출 준비 화면과 채팅 도구 스키마를 검사하는 회귀 테스트를 추가했다.
- 긴 한글·다중 바이트 MCP 인자를 승인 설명에서 줄일 때 UTF-8 경계를 보존한다.
- Linux MCP 승인 창의 프로세스를 호출이 소유하도록 바꿔 취소·시간 초과 때 함께
  종료한다. DEB의 의존성에 `zenity`를 추가했다. AppImage 사용 환경에도 `zenity`가
  필요하다.
- 벤치마크 저장소 잠금을 소유자가 끝날 때 명시적으로 해제한다. Unix에서 동시에
  생성한 자식이 파일 디스크립터를 잠깐 상속해도 완료한 실행의 잠금이 남지 않는다.
  복제한 파일 핸들을 유지한 상태의 재획득과 기존 프로세스 간 배타성 검사를 통과했다.
- 최초 CLI 런타임 선택은 `runtime select <backend> <build>`로 한 쌍을 검증·저장한다.
  잘못된 선택이 기존 설정을 바꾸지 않는지 빈 임시 홈에서 확인했다.
- Windows의 분리된 서버가 시작 CLI의 출력 파이프를 추가로 상속하지 않도록
  표준 스트림의 상속 플래그를 제거했다. 모델이 로드돼도 호출자가 명령 종료를
  기다리던 문제를 실제 CPU 검사로 재현했고, 분리된 자식의 출력 EOF 회귀 검사를
  추가했다. 정지·재시작의 `taskkill` 메시지도 JSON 출력에 섞이지 않게 했다.
- Linux 트레이는 실제 StatusNotifier 호스트가 있어야 새로 활성화한다. 호스트가
  없는 환경에서도 이전 설정을 가진 홈의 다른 설정을 저장할 수 있고, 창 닫기는
  정상 종료한다. 호스트 없는 Wayland에서 창만 숨던 문제를 재현·수정했다.
- Linux Secret Service의 DBus 런타임을 데스크톱 플러그인과 같은 async-io로 맞췄다.
  알림 전송에서 중첩 Tokio 런타임 panic이 발생하던 문제를 수정하고 실제 알림 표시,
  Secret Service 저장·읽기·수정·삭제, 트레이 호스트 및 GTK 파일 포털을 재검증했다.

| 검증 | Linux 결과 |
| --- | --- |
| TypeScript 전체 타입 검사, ESLint, 프런트엔드 production 빌드 | 통과 |
| 계약 패키지·직접 실행·패키징 스크립트 테스트 | 통과 |
| Vitest 전체 | 145개 파일, 1,450개 테스트 통과 |
| Vitest 커버리지 | Statements 78.18%, branches 73.23%, lines 82.17% |
| Rust format, Clippy `-D warnings` | 통과 |
| Rust 전체 타깃·전체 기능 테스트 | 라이브러리 709 + CLI 11 + 가짜 서버 통합 1 + 로그 통합 1 = 722개 통과 |
| Linux GUI/CLI debug 빌드 | 통과; 실제 GUI 결과는 아래 별도 기록 |
| 격리된 홈 CLI 초기화·설정 저장/재로딩·빈 런타임 목록·서버 중지 상태 | debug/release 통과 |

Linux 기본 실행에서 실제 환경 opt-in 9개와 로그 통합 검사의 자식 프로세스 fixture 1개는
제외된다. 실제 모델·설치 결과는 아래 별도 기록하며 기본 테스트 수에 중복 합산하지 않는다.

[최종 코드 CI](https://github.com/aiolm/AioLM/actions/runs/37192658718)에서 프런트엔드,
Windows, Ubuntu 24.04, macOS ARM64와 Intel의 검사·GUI/CLI 빌드·빈 홈 CLI 검사가
모두 통과했다. Windows는 일반 Rust 730개 검사와 실제 CPU 시작·SSE 채팅·로그 갱신·
재시작·정지·포트 해제, 실제 Credential Manager 저장·읽기·수정·삭제도 통과했다.
성공한 Mac 빌드는 Metal 추론이나 Cocoa GUI의 실사용 완료를 뜻하지 않는다.
검증한 구현 커밋은 `a203ff6`이며 이후 문서 변경과 구분한다.

[최종 코드 패키지 CI](https://github.com/aiolm/AioLM/actions/runs/37192656705)는 Windows
NSIS/MSI, Ubuntu DEB/AppImage, macOS ARM64/Intel APP/DMG 생성과 각 release CLI
검사를 모두 통과했다. Windows NSIS/MSI와 Linux DEB의 실제 설치·동일 버전
재설치/복구·설치된 CLI·제거 검사도 같은 실행에서 통과했다. 패키지를 릴리스로
게시하거나 기존 사용자 앱을 교체하지 않았다.

Headless CLI는 시작 → 시작 명령 종료 후 실제 채팅 → 로그 증가 → 재시작 → 다시
채팅·로그 증가 → 정지 → 중지 상태를 확인했다. 서버와 로그 수집기가 모두 종료됐다.
수정 전에는 시작 명령 종료 후 로그가 고정됐지만, 수정 후 각 채팅에서 새 prompt
evaluation 로그가 추가됐다. 장기간 연속 운용의 결과로 확대 해석하지 않는다.

원본 로그·도구·재현물은 저장소 루트 `tmp/`에만 두며 커밋하지 않는다.

### 실제 모델과 GUI 확인 범위

공개 Qwen2.5-0.5B-Instruct Q4_K_M GGUF와 llama.cpp b11349를 사용했다. 모델의
SHA-256은 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`다.
모델·런타임·설정·벤치마크 결과는 격리된 임시 홈에만 저장했다.

| 실제 실행 | CPU | Vulkan0 | ROCm0 |
| --- | --- | --- | --- |
| 다운로드·SHA 검증·설치·probe | 통과 | 통과 | 통과 |
| 채팅 응답·SSE 완료·서버 정지·포트 해제 | 통과 | 통과 | 통과 |
| 벤치마크 중간 취소·완료 행 보존·프로세스 정리 | 통과 | 통과 | 통과 |
| 확인한 GPU 오프로딩 | 0/25 layers | 25/25 layers | 25/25 layers |

CPU 런타임의 ZIP 내보내기 → 새 임시 홈으로 가져오기 → probe → 실제 채팅도
통과했다. 후속 GPU1·두 GPU 분할 결과는 아래에 따로 기록하며 CUDA·Metal의 결과를 대신하지 않는다.

가상 X11 화면과 별도 DBus·격리된 HOME/XDG 경로에서 실제 Tauri/WebKitGTK 앱을
WebDriver로 조작했다. 초기 설정의 한국어·어두운 테마 선택, 합성 프로젝트 저장 후
재시작 복원, 주요 메뉴 11개 이동, 한글·공백 파일명의 모델 프로필 저장·CPU 실행,
채팅·생성 취소·부분 응답 보존·언로드를 확인했다. 1280×800과 760×720 창의 채팅
화면에서 루트 가로 넘침은 없었다. 찾아보기는 실제 공개 Hub 목록을 표시했다.

GUI에서 시작한 로컬 API 서버는 인증 없는 모델 목록 요청에 401을 반환했고, 인증된
모델 목록·OpenAI chat completions·Anthropic messages 요청은 200과 실제 모델
응답을 반환했다. API 중지 후에도 모델은 유지되며, 이후 GUI에서 언로드했다.

합성 로컬 MCP stdio 서버를 GUI에 등록해 도구 조회 → 스키마 표시 → 인자 입력 →
호출 검토 → 실제 네이티브 Yes 승인 → 결과 표시를 확인했다. No 거부와 승인 대기
중 IPC 취소에서는 `tools/call`이 전송되지 않았고 서버 프로세스가 종료됐다.
취소 후 승인 창도 닫혔다. 테스트용 서버는 외부 네트워크나 사용자 파일에 접근하지 않는다.

추가로 확인한 실제 GUI 흐름:

| 기능 | 검증 결과 |
| --- | --- |
| PDF 문서 | GTK 포털 파일 선택 → 텍스트 추출 → 실제 채팅에서 합성 검증 코드 응답과 lexical 출처 표시 |
| DOCX·임베딩 검색 | 한글 포함 합성 DOCX 선택 → Qwen embeddings → 실제 채팅에서 검증 코드·문서 chunk·유사도 표시 |
| 이미지·비전 사이드카 | 공개 SmolVLM-256M Q8_0와 mmproj를 로드해 PNG 선택 후 실제 사각형 인식 응답 |
| 클립보드 | 응답 복사 버튼 → 격리된 X11 클립보드의 실제 텍스트 일치 |
| 벤치마크·내보내기 | 실제 CPU 벤치마크 완료·기록 저장 → GTK 저장 창에서 CSV/XLSX 생성 → 파일 내용 검사 |
| 한글 IME | 실제 IBus Hangul 엔진·한영 전환·XTest 키 입력으로 `한글` 조합 확인 |
| Wayland | 별도 Weston headless compositor·DBus·빈 홈에서 온보딩, 11개 화면 전환, CPU 모델 채팅 `OK`, 언로드; JS 오류 없음 |
| 트레이 없는 데스크톱 | 활성화 거부·기존 값 유지·오류 표시, 기존 트레이 설정이 있어도 일반 설정 저장, 실제 닫기 버튼으로 앱 종료 |
| 시스템 알림 | 수정된 앱에서 실제 dunst 알림 표시·한글 본문·알림 기록 확인; 별도 X11/DBus 사용 |
| 개인화·스킬 | UI 지침 저장·다시 읽기, 합성 로컬 스킬 조회·선택·`$skill-name` 호출, 실제 모델 요청의 system 메시지에 지침·스킬 본문 포함 |

비전 모델과 사이드카는 공식 저장소의 고정 revision
`b9e4379657e1450d04d02eec8e345667265b0a00`의 파일을 SHA-256 검증해 사용했다.
이 검사는 이미지 전달·사이드카 실행·응답 흐름의 확인이며 모델의 인식 정확도 평가는 아니다.
스킬 본문이 전달돼도 작은 검증 모델이 지정 응답을 따르지 않는 경우가 있었으므로,
스킬 검증은 파일·UI·요청 전달의 성공으로 기록하고 모델의 지시 준수 보장으로 확대하지 않는다.
Wayland 결과는 Weston에서의 실행이며 GNOME/KDE 트레이·포털 호환성 전체를 대신하지 않는다.

### Linux 패키지 확인 범위

Linux 실사용 검증에 사용한 로컬 패키지는 다음과 같다. 아래 크기는 해당 생성 시점의
기록이며 후속 CI 산출물의 크기와 구분한다:

| 산출물 | 크기 | 확인 범위 |
| --- | ---: | --- |
| AioLM_0.2.0_amd64.deb | 17,970,984 bytes | 생성, 파일 목록, GUI/CLI 실행 권한, GTK/WebKit/AppIndicator·zenity 의존성 |
| AioLM_0.2.0_amd64.AppImage | 101,796,344 bytes | 생성, 파일 목록, 격리된 X11 실행, CPU 채팅, MCP 네이티브 승인·결과 |

AppImage는 `APPIMAGE_EXTRACT_AND_RUN=1`로 설치 없이 실행했다. 실행 중인 GUI가
실제 AppImage에서 추출된 실행 파일인지 확인했고, 저장된 한글 모델 프로필로 실행해
채팅 응답과 MCP 도구 실행 결과를 받았다. 후속 GitHub Ubuntu runner에서는 실제
FUSE 마운트와 마운트된 CLI·AppImage GUI 실행도 통과했다.

두 패키지는 GUI와 CLI를 포함하며 가짜 서버·테스트 모델·설정 파일을 포함하지 않는다.
DEB staging의 11개, AppDir의 442개 일반 파일을 검사해 개발 PC 홈·워크스페이스
경로가 UTF-8·UTF-16으로 포함되지 않았음을 확인했다.

[Ubuntu 24.04 설치 CI](https://github.com/aiolm/AioLM/actions/runs/37184668687)에서
성공한 빌드의 체크섬을 다시 검증한 DEB를 실제 설치하고, 설치된 CLI의 빈 홈 검사를
실행한 뒤 동일 버전 재설치·CLI 재검사·제거·실행 파일 제거 확인까지 통과했다.
서로 다른 버전 간 업데이트나 사용자 데스크톱의 설치 화면 조작을 대신하지 않는다.

### 추가 실사용 검증과 남은 범위

자동 테스트가 통과해도 모든 사용자 기능의 실기 검증이 완료된 것은 아니다.

- 빈 설정의 CLI 런타임 선택은 `runtime select <backend> <build>`로 두 값을 함께
  검증·저장하도록 수정했다. 격리된 홈의 최초 선택과 잘못된 식별자 입력 후 기존
  설정 보존 검사가 통과했다. Windows CI에도 같은 검사를 추가했다.
- 공개 해시 고정 모델을 내려받는 `native_cpu` opt-in 검사를 추가했다. Linux에서
  b11382 CPU 설치·preflight와 CLI 시작 명령 종료 후 SSE 채팅·로그 갱신, 재시작,
  정지·포트 해제를 통과했다. Windows CI에서도 같은 검사와 실제 Credential Manager
  저장·읽기·수정·삭제가 통과했다.
- 별도 DBus와 임시 홈의 실제 Linux Secret Service에서
  저장·읽기·수정·삭제와 저장소 부재 오류 처리도 통과했다.
- 공식 llama.cpp PR 29903의 고정 커밋으로 CPU CMake 빌드·preflight·실제 추론을
  통과했다. 빌드 중 취소가 다운로드·staging 디렉터리를 정리하는 것도 확인했다.
- 외부 유료 API·인증 계정과 벤치마크 공개 공유·복구는 전용 계정·서비스를 통한
  실사용 검증이 남아 있다.
- Windows NSIS 설치·동일 버전 업데이트·삭제와 MSI 설치·복구·삭제 및 각 설치된
  CLI 검사가 [원격 runner](https://github.com/aiolm/AioLM/actions/runs/37184668687)에서
  통과했다. NSIS 제거 후 보존한 설치 경로를 MSI가 재사용하는 동작도 확인했다.
- GNOME/KDE 트레이와 FUSE AppImage는 아래 후속 검사에서 통과했다. 실제 과거
  배포 바이너리에서의 업데이트, Windows GPU 추론·GUI 전체 조작은 남아 있다.
- MCP는 현재 stdio만 구현됐다. HTTP 전송을 검사 완료나 지원 기능으로 표시하지 않는다.
- macOS ARM64/Intel의 CPU/Metal 추론·Cocoa/Keychain·서명·공증은 실제 Mac
  또는 대상 runner에서 확인해야 한다.

### Linux 추가 검증 완료 기록 (2026-10-04)

위 초기 검증의 공백을 실제 네이티브 실행으로 추가 확인했다. 개인 계정·설정과
분리된 HOME/XDG/DBus 및 합성 자료를 사용했다. 다음 표는 해당 환경에서의 성공을
뜻하며 모든 배포판·GPU·모델 조합의 보증이 아니다.

| 영역 | 추가로 확인한 실제 동작 |
| --- | --- |
| Wayland 입력·창 | Weston에서 클립보드 복사/붙여넣기, IBus 한글 조합, 최대화·복원·크기 변경, 한글·공백 PDF의 GTK 포털 선택/추출·취소 |
| GNOME 트레이 | GNOME Shell/Mutter와 AppIndicator 확장의 실제 등록, 창 닫기→숨김, native Show→표시, 숨긴 뒤 두 번째 실행→기존 창 표시 |
| KDE 트레이 | Ubuntu 24.04의 실제 Plasma/KWin·kded StatusNotifier 호스트에서 등록, 숨김, native Show, Quit 후 프로세스 종료 |
| 잠긴 비밀 저장소 | 실제 Secret Service 잠금 후 headless 실패, 읽기/쓰기 인증 창의 실제 Cancel, daemon 재시작·잠금 해제 후 기존 비밀 값 보존·삭제 |
| GPU 선택 | Vulkan·ROCm 각각 GPU1 단독과 GPU0+GPU1 layer split의 실제 추론; 선택한 각 장치의 모델 버퍼와 25/25 layer offload 로그 확인 |
| 심층 모델 검증 | Vulkan·ROCm을 CPU 기준 perplexity와 비교해 통과; 실제 기준 계산 중 취소와 임시 logits 제거 |
| LoRA·draft | 합성 zero-weight rank-1 LoRA 로드 후 추론, 호환 Qwen 모델의 draft-simple 추론과 실제 draft 토큰 채택 확인 |
| 모델·경로·세션 | 한글·공백을 포함한 448-byte 경로, 대소문자만 다른 두 GGUF 탐색·동시 세션 추론·언로드 |
| Hub 다운로드 | 공개 SmolVLM 파일의 실제 다운로드 중 취소·staging 제거, 재시도·SHA-256 일치, 기존 검증 파일 재사용 |
| 실패·복구 | 읽기 전용 설정 저장 실패 후 원본 보존, 실제 idle unload, 서버 강제 종료 감지·재시작·추론 |
| API | 포트 충돌 거부, Responses 생성·조회·previous_response_id 후속 대화, 스트림 연결 종료, API 정지 후 모델 유지 |
| 데이터 이행 | config_version 1의 합성 구버전 폴더 → 새 홈, 설정·원본 보존, 같은/다른 파일시스템의 이행한 런타임 실제 추론과 앱 재시작 |
| 앱 종료 | 기본/추가 모델 세션·API·MCP 승인 대기 중 창 닫기 → 앱·모델·MCP·승인 창 종료 및 리스닝 포트 닫힘 |
| 공개 벤치마크 창 | 실제 별도 native WebView에서 공개 한국어 사이트·필터·빈 결과 렌더링 확인; 공개 레코드가 없어 가져오기는 미실행 |
| DEB 업그레이드 | 합성 이전 버전 패키지 설치 → GUI/설정 저장 → 새 버전 설치 → 설정·WebView 저장값 유지 → 제거 후 데이터 보존 |
| AppImage | 실제 FUSE mount 확인, 추출 실행 fallback 없이 마운트된 CLI와 AppImage GUI 실행 |

데이터 이행 검사에서 **실행 파일의 Unix 권한이 사라져 Permission denied가 발생하는
결함**을 찾았다. `copy_tree`가 일반 Unix 권한 비트를 보존하도록 수정했고, 실행 권한과
private 파일 권한 회귀 테스트 및 실제 이행·추론·재시작을 통과했다. 최종 CI DEB에서
추출한 앱에서도 같은 이행·추론·재시작을 확인했다. 특별 권한 비트는
복사하지 않으며 Windows 파일 복사 동작은 변경하지 않았다.

DEB의 이전 버전은 최종 패키지의 Version 필드만 `0.2.0~acceptance0`으로 바꾼
**합성 fixture**다. 패키지 관리자 업그레이드와 사용자 데이터 보존의 증거이며,
실제 과거 Linux 릴리스 바이너리·모든 과거 스키마 업그레이드의 증거는 아니다.
GNOME 검사는 트레이/재실행 범위이며 전체 GNOME 입력·포털 검증으로 확대하지 않는다.
LoRA 검사는 연결·로드·추론 경로를 확인하며 학습 품질이나 모든 draft 아키텍처를
검증하지 않는다. 다중 GPU 결과도 현재 장치의 layer split 범위다.

[최종 Linux 패키지 실기 CI](https://github.com/aiolm/AioLM/actions/runs/37193916897)는
패키지 run `37192656705`를 명시적으로 지정해 DEB 데이터 보존·FUSE·KDE 검사를 모두
통과했다. [후속 Linux CI](https://github.com/aiolm/AioLM/actions/runs/37193477047)의
Ubuntu 작업도 일반 테스트·실제 Secret Service 인증 취소·빌드·CLI 검사를 통과했다.
Secret Service 검사 커밋은 `8bb653f`, CJK 글꼴을 갖춘 패키지 검사 커밋은
`b8e6d4b`이며 패키지의 앱 구현은 `a203ff6`과 같다. 최종 AppImage 스크린샷에서
한국어·일본어·중국어 표시도 확인했다.

반복 가능한 네이티브 검사는 다음에 추가했다:

- [Linux 데스크톱 패키지 CI](../../.github/workflows/linux-desktop-acceptance.yml):
  성공한 패키지 run의 체크섬을 확인하고 DEB 데이터 보존·FUSE·KDE 트레이를 검사한다.
  설치 스크립트는 GitHub hosted runner에서만 동작한다.
- [실제 Secret Service 검사](../../scripts/smoke-linux-vault.py): 임시 홈과 별도 DBus에서
  잠금·인증 취소·복구를 검사하며 Linux native CI에서도 실행한다.

남은 실기 범위는 외부 유료/인증 API, 계정 기반 공개 공유·복구 및 공개 레코드 가져오기,
실제 과거 배포 바이너리 업그레이드, 다른 GPU 계열·드라이버·배포판, 모델별 전용
speculative decoding 구성, 장기간 연속 운용이다. 이런 외부 조건을 확보하지 않은
검사를 완료로 표시하지 않는다. 현재 제공된 Linux 환경에서 수행한 검사는 위에
기록했으며 Windows와 macOS의 남은 실기 범위는 별개다.

## Linux에서 소스 받기

새 작업 폴더에서는:

```sh
git clone https://github.com/aiolm/AioLM.git
cd AioLM
git switch main
```

이미 저장소가 있다면 먼저 `git status --short`로 미커밋 작업을 확인한다. 작업 트리가
깨끗하고 main에서 이어서 작업할 경우:

```sh
git switch main
git pull --ff-only origin main
git log -1 --oneline
```

로컬 수정이 있으면 먼저 별도 커밋/브랜치에 보존한다. 강제 초기화나 패치 재적용은
필요하지 않다. 이 문서와 이식 코드는 같은 커밋에 들어 있다.

## Linux 검증 순서

1. 저장소의 AGENTS.md, 이 문서와 [공통 검증 문서](cross-platform-validation.md)를 읽는다.
2. 저장소에 고정된 Node/npm·Rust 버전을 사용한다. 작성 시점에는 Node 22.23.2,
   npm 12.0.2, Rust 1.98.0이다. lockfile을 일괄 갱신하지 않는다.
3. Tauri 시스템 개발 패키지를 설치하고 아래 자동 검사를 순서대로 실행한다.

Ubuntu 24.04의 예:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf pciutils zenity
npm install --global "$(node -p 'require("./package.json").packageManager')"
npm ci --ignore-scripts
npm rebuild esbuild
npm test
npm run typecheck
npm run lint
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- --test-threads=4
cargo build --locked --manifest-path src-tauri/Cargo.toml --bins
npm run test:native-cli
```

4. 사용할 CPU/GPU 백엔드를 확인한다. AMD 환경에서도 CPU, Vulkan, ROCm을 별도
   결과로 취급한다. Vulkan 성공만으로 ROCm 성공을 판정하지 않는다.
5. 실제 런타임 설치 테스트를 실행한다. 이 테스트는 자체 임시 폴더를 만들고 정리하므로
   설치된 사용자 런타임을 덮어쓰지 않는다. 사용할 백엔드만 선택한다.

```sh
AIOLM_RUNTIME_INSTALL=1 AIOLM_RUNTIME_BACKENDS=cpu,vulkan,rocm \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test runtime_install \
  -- --ignored --nocapture --test-threads=1
```

6. 별도 테스트 OS 계정에서 앱을 시작하고 작은 실제 GGUF를 설치한다. CPU부터
   채팅·생성 취소·정지·재시작을 확인한다.
7. 같은 모델로 Vulkan과 ROCm을 각각 확인한다. 런타임 장치 목록에 나온 이름을
   사용하며 GPU 순번이나 실제 GPU 개수를 추정하지 않는다.
8. 작은 반복 벤치마크, 중간 취소, 결과 보존, RAM 측정, CSV/XLSX 내보내기를 확인한다.
9. ZIP 내보내기 → 별도 테스트 폴더에 가져오기 → probe → 추론을 실행해 실행 권한과
   라이브러리가 보존되는지 확인한다.
10. CMake 소스 빌드와 취소를 확인한다. SONAME 링크·RPATH를 `ldd`/`readelf`로 점검한다.
11. `npm run package:tauri`로 DEB/AppImage를 만들고 새로운 테스트 계정/VM에서
    설치·업데이트·제거한다. 설치한 CLI도 검사한다.

실제 모델 opt-in 테스트 예시(별도 테스트 계정에서 경로·빌드 값을 교체):

```sh
AIOLM_SMOKE=1 AIOLM_SMOKE_MODEL='/absolute/path/to/test-model.gguf' \
AIOLM_SMOKE_BACKEND=cpu AIOLM_SMOKE_BUILD='<installed-build-id>' \
cargo test --locked --manifest-path src-tauri/Cargo.toml --test smoke \
  -- --ignored --nocapture --test-threads=1
```

각 GPU 백엔드로 반복한다. `AIOLM_SMOKE_DEVICE`에는 `--list-devices`가 보고한
런타임 장치 이름을 사용한다.

### AMD GPU와 Linux 배포판

현재 네이티브 패키지 CI 기준은 Ubuntu 24.04 x64이다. 더 오래된 배포판 지원은
glibc 기준을 별도로 낮춰 빌드하고 검증해야 한다. ROCm은 실제 GPU의 아키텍처가
지원되는 **OS 세부 버전 + 커널 + 드라이버 + ROCm** 조합을 고른다.
[공식 ROCm 호환 표](https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html)를
설치 직전에 확인하고 서로 다른 릴리스의 표를 섞지 않는다.

도구가 설치된 검증 환경에서 다음 결과를 로컬 기록으로 남긴다:

```sh
uname -r
lscpu
lspci -nnk
rocminfo
vulkaninfo --summary
```

`rocminfo`에서 실제 GPU 아키텍처와 접근 가능 여부를 확인하고, `vulkaninfo`에서는
소프트웨어 렌더러가 아닌 실제 GPU가 선택 가능한지 확인한다. 오류가 있으면 앱 수정
전에 드라이버/장치 접근 권한 문제인지 분리한다. 임의의 gfx override를 정상 지원의
증거로 사용하지 않는다. 장비 목록이나 개인 경로를 테스트 fixture·앱 기본값에 넣지 않는다.

### 데이터 격리

`AIOLM_HOME`만 임시 폴더로 바꾸고 GUI/CLI의 첫 실행을 하면 **기존 경로를
마이그레이션**할 수 있다. 구버전 런타임은 복사가 아니라 이동될 수도 있다.
기존 사용자 데이터를 실험 대상으로 삼지 않는다. 제공된 `npm run test:native-cli`는
HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG 경로를 모두 **자식 프로세스에서만**
격리한다. 수동 GUI·Keyring 검증에는 별도 OS 계정을 사용한다.

### Linux GUI 확인 항목

- X11과 Wayland 각각의 창 이동·크기 조절·제목 표시줄·파일 대화상자·클립보드.
- 한글 IME 조합, 경로/파일명에 공백·한글, 긴 경로.
- GNOME/KDE에서 트레이 메뉴 Show/Quit와 두 번째 실행의 기존 창 복귀.
- AppIndicator가 없는 환경에서 close-to-tray로 앱이 복구 불가능하게 숨지 않는지.
- Secret Service 정상 저장/조회/삭제, 잠긴 저장소, 서비스 없음, 인증 취소.
- MCP stdio, 초기화 실패, 도구 승인/거부/취소, 네이티브 승인 창 닫힘. HTTP 전송은 현재 미구현.
- 앱 종료·런타임 빌드 취소 후 llama-server/MCP/CMake의 자식과 소켓이 남지 않는지.
- 이미지/문서/임베딩/외부 API/프로필·프로젝트/벤치마크 공유는 각 기능에 필요한 전용 테스트 자료·계정으로 확인.
- DEB 설치·업데이트·제거와 AppImage 최초 실행·수동 교체. 파일 열기 성공과 설치 완료를 구분.

## Mac 기기 없이 Linux에서 macOS 작업 병행

Linux에서 코드를 수정하고 GitHub의 macOS 작업을 실행해 실제 macOS 빌드·테스트
결과를 받을 수 있다. [CI](../../.github/workflows/ci.yml)는 main 푸시와 PR에서
`macos-15` ARM64, `macos-15-intel` x64 및 Linux를 검증한다.
먼저 해당 커밋의 CI 결과를 확인하고 Unix 네이티브 테스트, Metal 선택, dylib 경로,
CLI 프로세스 식별, RAM 샘플링 등의 실패를 해결한다.

[패키지 검증 워크플로](../../.github/workflows/desktop-packages.yml)는 수동 실행하며
DEB/AppImage와 두 Mac 아키텍처의 DMG·체크섬을 아티팩트로 보관한다.
읽기 전용 저장소 권한으로 동작하고 릴리스를 게시하지 않는다.

```sh
gh run list --workflow ci.yml --branch main
gh workflow run desktop-packages.yml --ref '<source-branch>' -f platforms=macos
gh run list --workflow desktop-packages.yml
gh run view '<run-id>' --log-failed
gh run download '<run-id>' --dir tmp/native-packages
```

실제 Mac 런타임 설치 테스트는 위 Linux 명령의 백엔드를 Apple Silicon에서는
`cpu,metal`, upstream Intel 아카이브에서는 `cpu`로 바꾼다. ARM64에서 CPU와
Metal이 같은 배포 아카이브를 사용해도 실제 실행 장치가 달라지는지 확인한다.

macOS CI에는 opt-in 디버그 WebDriver로 실제 WKWebView 초기 설정·설정 저장·트레이
닫기·재실행 복구를 조작하는 검증이 추가됐다. 패키지 작업은 시스템/사용자 Applications
설치·교체·제거와 설치된 GUI/CLI, CPU 모델 추론, Keychain 저장·수정·삭제 및 Cocoa
승인 창 취소·시간 초과를 검사한다. `platforms=macos`로 두 Mac 작업만 실행할 수 있다.
Ventura 13.3은 패키지 최소 버전 정책이며 호스팅 검증 OS는 macOS 15다.
[macOS 검증 안내](macos-validation.md)에 범위와 배포 전제 조건을 정리했다.
아래 항목의 추가 실기 증거는 여전히 필요하다:

- Cocoa 파일 선택/취소, 승인 Yes/No, 한글 IME, 클립보드, Keychain 허용/거부/취소.
- Finder/Dock 실행·재실행·트레이/메뉴·닫기 동작.
- 실제 과거 릴리스에서의 업데이트 완료와 사용자 데이터 보존.
- Developer ID 서명·공증·다운로드 격리 속성/Gatekeeper. 미서명 CI DMG는 공개 배포 검증을 대신하지 않는다.
- 선언한 최소 macOS 13.3에서의 실행 및 WebKit 호환성 확인.
- Apple Silicon의 실제 Metal GPU 추론. 호스팅 CI가 GPU를 제공하는지는 `llama-server --list-devices`로 먼저 확인.
- Intel Metal은 실제 장치·소스 빌드가 지원하는 범위를 별도로 확인. Intel x64 CPU 추론은 호스팅 검증에 포함됐다.

호스팅 Mac에서 Metal 장치를 사용할 수 없으면 원격 Apple Silicon 장비,
자체 runner 또는 Mac 사용자 테스터가 필요하다. ARM64 성공 결과로 Intel 검증을
대체하지 않는다.

## 정식 지원 완료 기준

- [x] Linux native CI, macOS ARM64/Intel native CI 모두 성공.
- [x] Linux DEB 생성·설치·제거·합성 버전 업그레이드 데이터 보존 및 FUSE AppImage 실행.
- [ ] 실제 과거 릴리스 업그레이드와 macOS 설치·제거·업데이트 완료 확인.
- [x] Linux CPU/Vulkan/ROCm 실제 모델 테스트와 결과 기록(Ubuntu 26.04 x64, b11349).
- [ ] macOS CPU/Metal 실제 모델 테스트와 결과 기록.
- [x] 위 Linux 환경의 GUI·Secret Service·MCP 승인·프로세스 정리·파일 처리 검사.
- [ ] 계정 기반 Linux 실기 흐름과 macOS GUI·Keychain·MCP·파일 처리 검사.
- [ ] macOS 최소 버전, Linux 배포판/glibc·그래픽 환경 지원 범위 확정.
- [ ] macOS 서명/공증 계정·CI secrets 구성 및 Gatekeeper 검증.
- [x] release.yml에 Linux DEB/AppImage 빌드·설치 검사와 Windows/Linux 통합 체크섬 게시 경로 구현. v0.2.1 공개 파일 다운로드와 체크섬 검증 완료.
- [ ] macOS 검증·서명 완료 후 release.yml에 macOS 게시 경로 추가.
- [x] README·4개 언어 설치/개요·AioLM-Web에 Linux x86_64 설치 안내 반영. v0.2.0에는 Windows 파일만 있으므로 Linux 검증 아티팩트 경로와 제한을 명시.
- [x] Linux v0.2.1 공개 릴리스 파일 게시와 AioLM-Web 운영 배포 후 실제 다운로드 경로 확인.

실기 확인 없이 체크박스를 완료로 바꾸지 않는다. 실패는 재현 명령, 기대/실제 결과,
OS/커널·GPU 드라이버·런타임 빌드·모델 해시로 기록하되 개인 경로·토큰·사용자 데이터는
제외한다. 지원 상태가 바뀌면 이 인계 문서와 공통 검증 문서를 함께 갱신한다.

## 공식 참고 자료

- [llama.cpp 배포 형식](https://github.com/ggml-org/llama.cpp/blob/master/.github/workflows/release.yml)
- [Tauri WebView 버전](https://v2.tauri.app/reference/webview-versions/)
- [Tauri AppImage와 glibc](https://v2.tauri.app/distribute/appimage/)
- [Tauri macOS 서명](https://v2.tauri.app/distribute/sign/macos/)
- [GitHub 호스팅 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Tailwind 브라우저 요구사항](https://tailwindcss.com/docs/compatibility)


## Linux 데스크톱 아이콘 등록

개발 바이너리는 시스템 설치 항목이 없어 GNOME에서 기본 톱니바퀴로 보일 수 있다.
`npm run tauri -- dev`가 Linux에서만 사용자 XDG 경로에 숨겨진 개발용 항목과
아이콘을 등록한다. Wayland의 `aiolm` app_id와 `aiolm.desktop`,
`StartupWMClass=aiolm`을 연결한다. 별도 임시 홈의 GNOME Wayland 세션에서
실제 창이 해당 desktop 항목과 PNG 아이콘으로 연결되는 것을 확인했다.
등록 전에 열렸던 창은 GNOME이 기존 연결을 캐시하므로, 현재 모델 작업을 마친 뒤
앱을 다시 열어야 새 아이콘이 적용될 수 있다. 등록 자체는 모델을 중단하지 않는다.

DEB에는 실행 항목과 아이콘이 이미 포함되어 있으며 설치 smoke에서 둘의 존재와
식별자, desktop 문법을 검사한다. AppImage는 릴리스에 포함할
`register-linux-desktop.py --appimage <파일>`로 명시적으로 등록한다.
기존 AppImage 실행 항목은 개발 실행으로 덮어쓰지 않고, 도우미가 소유하지 않는
항목도 보존한다. 실제 AppImage 추출·등록·제거 및 임시 경로 단위 검사를 통과했다.
Windows/macOS 실행에는 Linux 등록을 적용하지 않는다.


## v0.2.1 공개 릴리스 및 웹 운영 배포 (2026-10-04)

[릴리스 작업](https://github.com/aiolm/AioLM/actions/runs/37201880791)은
커밋 `6ba8506`의 Windows NSIS/MSI 및 Ubuntu 24.04 DEB/AppImage 생성과
릴리스 전 검사를 통과했다. [공통 CI](https://github.com/aiolm/AioLM/actions/runs/37201880783)도
Windows, Ubuntu, macOS ARM64/Intel과 프런트엔드 검사를 모두 통과했다.

[공개 v0.2.1](https://github.com/aiolm/AioLM/releases/tag/v0.2.1)에서
설치 파일 4개, Windows 설치 스크립트, Linux 아이콘 등록 도우미와 체크섬 파일을
직접 다운로드했다. 6개 배포 파일의 SHA-256이 공개 체크섬과 모두 일치했다.
공개 DEB를 임시 디렉터리에 추출해 desktop 문법과 창 식별자를 확인하고,
격리된 홈의 설치 CLI 초기화·설정 저장·런타임 선택·오류 시 설정 보존 검사를 통과했다.
공개 AppImage와 도우미로 임시 XDG 경로에 아이콘을 등록·검증·제거했으며,
추출된 아이콘이 DEB의 아이콘과 같은 것도 확인했다.

웹 변경은 [PR #3](https://github.com/aiolm/AioLm-Web/pull/3)의
병합 커밋 `bb9c21e`로 운영 배포했다. 웹 버전은 기존 `1.2.0`을 유지하며
이번 작업으로 웹 릴리스나 태그를 생성하지 않았다.
[운영 사이트](https://aiolm.vercel.app/ko)의 한국어·영어·일본어·중국어에서
Linux 설치 탭, 다운로드/문서 링크, Linux/Windows 명령 복사와 키보드 탭 전환을
실제 Chrome으로 확인했다. 1440×1000 및 390×844 화면에서 가로 넘침이 없었고
페이지·콘솔 오류가 없었다. readiness API도 `ready`를 반환했다.

이 결과는 Windows 실기 GPU/GUI 전체 검증이나 남아 있는 macOS 검증을 대체하지 않는다.
