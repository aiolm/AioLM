# 설치

> **언어:** [English](install.md) | [한국어](install.ko.md) | [日本語](install.ja.md) | [中文](install.zh.md)

## Windows: 다운로드, 검증 후 설치

같은 [릴리스](https://github.com/aiolm/AioLM/releases/latest)에서 x64 설치 EXE(또는 MSI)와 `checksums.txt`를 받으세요. 릴리스 설치 파일은 서명되지 않았습니다. 설치 파일의 SHA-256을 계산합니다.

```powershell
$installer = Get-ChildItem -File "./AioLM_*_x64-setup.exe" | Select-Object -First 1
# MSI는 "./AioLM_*_x64_en-US.msi"를 사용하세요.
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
```

결과를 `checksums.txt`의 해당 항목과 비교하세요. 일치한 뒤에만 설치 파일을 열고 안내에 따라 설치합니다. 체크섬 일치는 파일 무결성을 확인할 뿐 게시자의 신원을 보증하지 않습니다.

### 편의용 원라이너 설치

이 대안은 내려받은 스크립트 자체를 먼저 검증하지 않고 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

`cmd.exe`, Git Bash 등 PowerShell을 실행할 수 있는 모든 셸에서 동일합니다.

```bash
powershell.exe -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

## 옵션

```powershell
$env:AIOLM_INSTALLER = "msi"   # 기본: nsis
$env:AIOLM_RELEASE = "v0.1.5"  # 특정 태그
$env:AIOLM_DRY_RUN = "1"       # 검증만, 설치 안 함
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

원라이너는 선택한 릴리스에 포함된 `install.ps1` 사본을 다운로드합니다. 현재 원본: <https://github.com/aiolm/AioLM/blob/main/install.ps1>

AioLM — All-In-One LM은 이전 앱과 별도로 설치됩니다. 첫 실행에서 기존 설정·관리 런타임·CLI 저장소·WebView 프로필을 새 `aiolm` / `com.aiolm.desktop` 경로로 복사합니다. 원본을 유지하며, 이미 존재하는 AioLM 데이터를 우선합니다. 이전 앱을 종료한 뒤 실행하고, 잠금이나 공간 부족 오류가 발생하면 문제를 해결한 뒤 재시도하세요. [이전 방식과 호환성](../reference/migration.md)을 참고하세요.

AioLM은 데이터를 `%USERPROFILE%\.aiolm`에 보관하며, `AIOLM_HOME` 환경변수로 다른 폴더를 지정할 수 있습니다. 이전 AioLM 버전의 데이터는 시작할 때 이 폴더로 가져오고, 관리 런타임은 복사하지 않고 이동합니다. [데이터 폴더](../reference/migration.md#data-folder)를 참고하세요.

## 제거

**설정 → 앱 → 설치된 앱 → AioLM → 제거**를 선택하거나 **제어판 → 프로그램 및 기능**에서 제거하세요. NSIS 제거 프로그램에서 **Delete the application data**를 선택하지 않으면 데이터는 그대로 남습니다. 이 옵션은 WebView 프로필과 데이터 폴더 `%USERPROFILE%\.aiolm`, 그리고 이전 버전이 쓰던 `%APPDATA%\aiolm`과 `%LOCALAPPDATA%\aiolm` 폴더를 삭제하되, 그 안의 `models` 폴더는 남깁니다. `AIOLM_HOME`으로 지정한 폴더와 다른 위치의 모델은 삭제하지 않으며, MSI 제거 프로그램은 데이터를 삭제하지 않습니다. 필요하면 해당 폴더를 별도로 삭제하세요.

## Linux

Ubuntu 24.04 이상, x86_64 기준입니다. 앱 메뉴·아이콘 통합에는 DEB를 권장하며, AppImage는 이동식 실행 파일입니다. ARM64와 NVIDIA DGX 환경은 아직 확인되지 않았습니다.

같은 [릴리스](https://github.com/aiolm/AioLM/releases/latest)에서 DEB 또는 AppImage와 `checksums.txt`를 받으세요. **v0.2.1부터 Linux 파일도 제공합니다.** 아직 릴리스되지 않은 변경이 필요하면 [소스에서 빌드](#소스에서-빌드)하세요. 직접 빌드한 파일은 정식 릴리스가 아닙니다.

다운로드한 체크섬 파일의 해당 항목과 SHA-256 값을 비교하세요. 설치할 버전의 DEB만 있는 폴더에서 실행합니다:

```bash
sha256sum ./AioLM_*_amd64.deb
sudo apt install ./AioLM_*_amd64.deb
```

설치 후 앱 메뉴에서 AioLM을 실행하세요. DEB가 실행 항목과 아이콘을 등록합니다. `sudo apt remove aio-lm`으로 제거해도 `~/.aiolm` 또는 `AIOLM_HOME`의 데이터는 남습니다.

관리형 Linux llama.cpp CPU 런타임에는 GNU OpenMP(`libgomp.so.1`)가 필요합니다. DEB는 `libgomp1`을 의존성으로 설치합니다.

AppImage는 계속 보관할 폴더에 두고 체크섬을 확인한 뒤 실행 권한을 부여하세요. 관리형 CPU 런타임용 `libgomp1`, MCP 도구 승인 창용 `zenity`, 그리고 Ubuntu 24.04 이상에서 FUSE 2가 없다면 `libfuse2t64`를 설치합니다. DEB는 `zenity`도 의존성으로 설치하지만 AppImage는 직접 설치해야 하며, 승인 창을 띄울 수 없으면 요청한 도구를 실행하지 않고 호출이 실패합니다:

```bash
sudo apt install libgomp1 libfuse2t64 zenity
chmod +x ./AioLM_*.AppImage
./AioLM_*.AppImage
```

AppImage 실행만으로는 앱 메뉴에 등록되지 않습니다. 같은 릴리스의 `register-linux-desktop.py`를 받으세요. 직접 빌드했다면 같은 소스의 [도우미](../../scripts/register-linux-desktop.py)를 사용합니다. Python 3가 필요합니다. 릴리스 체크섬으로 도우미도 검증한 뒤 선택한 AppImage를 등록합니다:

```bash
python3 register-linux-desktop.py --appimage ./AioLM_*.AppImage
```

아이콘을 복사하고 XDG 사용자 데이터 폴더에 실행 항목을 등록하며 AppImage 자체는 이동하지 않습니다. 파일 경로가 바뀌면 다시 등록하세요. DEB로 전환하기 전에는 `python3 register-linux-desktop.py --remove`로 로컬 등록을 제거하세요. 도우미는 자신이 만들지 않은 실행 항목을 바꾸거나 지우지 않습니다.

DEB 업데이트는 검증한 설치 파일을 시스템 설치 화면으로 열며 사용자가 설치를 마무리합니다. AppImage는 릴리스 페이지에서 업데이트하고 새 경로를 등록하세요. GPU 가속에는 GPU 드라이버와 호환되는 llama.cpp 런타임이 필요합니다.

AioLM은 창이나 트레이 메뉴에서 정상적으로 종료하세요. 정상 종료하면 AioLM이 시작한 모델 프로세스도 멈추지만, 강제 종료나 `kill -9`로 끝내면 멈추지 않으므로 남은 `llama-server` 프로세스를 직접 종료해야 합니다.

## macOS

AioLM은 Apple Silicon과 Intel Mac의 macOS Ventura 13.3 이상을 지원합니다. Metal GPU 가속은 Apple Silicon에서 사용하며 Intel Mac은 CPU 런타임을 사용합니다. macOS 패키지는 **v0.3.0**부터 포함됩니다.

### DMG로 직접 설치

같은 [릴리스](https://github.com/aiolm/AioLM/releases/latest)에서 `AioLM_<버전>_aarch64.dmg`(Apple Silicon) 또는 `AioLM_<버전>_x64.dmg`(Intel)와 `checksums.txt`를 받으세요. SHA-256을 계산합니다.

```bash
shasum -a 256 ./AioLM_*.dmg
```

결과를 `checksums.txt`의 해당 항목과 비교하세요. 일치한 뒤에만 DMG를 열고 AioLM을 Applications로 끌어 놓으세요. 체크섬은 무결성만 확인하며 게시자의 신원을 보증하지 않습니다.

앱은 ad-hoc 서명만 있고 공증되지 않았으므로 브라우저로 받은 사본은 첫 실행이 차단됩니다. 한 번 실행을 시도한 뒤 **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 선택하세요. macOS 13·14에서는 앱을 Control-클릭하고 **열기**를 선택해도 됩니다. 설치한 사본마다 한 번만 필요합니다.

### 편의용 터미널 설치

이 대안은 내려받은 스크립트 자체를 먼저 검증하지 않고 실행합니다.

```bash
curl -fsSL https://github.com/aiolm/AioLM/releases/latest/download/install.sh | bash
```

스크립트는 Mac에 맞는 DMG를 받아 릴리스의 SHA-256과 비교한 뒤(GitHub API 사용 한도에 걸리면 릴리스 다운로드 링크와 `checksums.txt`를 사용) `AioLM.app`을 `/Applications`에, 쓸 수 없으면 `~/Applications`에 복사합니다. 실행 전에 AioLM을 종료하세요. `AIOLM_RELEASE=v0.3.0`으로 릴리스를 고르고, `AIOLM_DRY_RUN=1`은 검증까지만 하며, `AIOLM_APPLICATIONS_DIR`로 설치 폴더를 바꿀 수 있습니다. 현재 소스: <https://github.com/aiolm/AioLM/blob/main/install.sh>

AioLM 데이터는 `~/.aiolm`에 있으며 앱을 교체하거나 제거해도 유지됩니다. 앱이 `/Applications` 또는 `~/Applications`에 있으면 설정의 **다운로드 및 설치**가 Mac에 맞는 DMG를 받으므로 새 사본으로 앱을 교체하세요. 서명되지 않은 빌드는 코드 식별값이 바뀌므로, 업데이트 후 벤치마크 공유 자격 증명 같은 Keychain 항목 접근을 다시 물을 수 있습니다. 제거하려면 AioLM을 종료하고 `AioLM.app`을 휴지통으로 옮기세요. 데이터까지 지우려면 `~/.aiolm`을 삭제합니다.

Linux와 마찬가지로 정상 종료하면 AioLM의 모델 프로세스도 멈추지만, 강제 종료하면 멈추지 않습니다.

## 소스에서 빌드

릴리스 파일 대신 직접 설치 파일을 만들 수 있습니다. 직접 빌드한 설치 파일은 정식 릴리스가 아니며 공증되지 않습니다.

### 요구사항

- Windows 10/11 x64, Linux x86_64(Ubuntu 24.04 이상) 또는 macOS 13.3 이상(Apple Silicon·Intel, Xcode 명령줄 도구)
- Node `22.23.2`와 npm `12.0.2`(`.node-version`, `package.json#engines`)
- Rust `1.98.0`(`rust-toolchain.toml`. rustup이 고정 버전을 자동으로 사용합니다)
- 운영체제별 [Tauri v2 사전 요구사항](https://v2.tauri.app/start/prerequisites/)

Debian/Ubuntu에서는 네이티브 빌드와 AppImage 런타임 빌드에 필요한 패키지를 설치합니다. 이 패키지는 빌드에만 필요하며, 빌드한 AppImage를 실행하려면 [Linux](#linux)에 적힌 패키지도 필요합니다:

```bash
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf desktop-file-utils bubblewrap git curl gnupg patch
```

Linux 패키징은 고정된 AppImage 런타임을 소스에서 빌드하므로 x86_64 호스트, `/dev/fuse`, 네트워크 접근, 그리고 권한 없는 사용자 네임스페이스를 만들 수 있는 `bwrap`이 필요합니다. Ubuntu 24.04 이상은 AppArmor로 이를 제한하므로, 필요하면 `bwrap`에만 적용되는 AppArmor 프로필을 허용하세요. 시스템 전체 보호를 끄지 마세요. 조건이 맞지 않으면 패키징이 빌드 전에 멈추고 해결 방법을 표시합니다.

### 빌드

```bash
git clone https://github.com/aiolm/AioLM.git aiolm
cd aiolm
npm ci
npm run package:tauri
```

설치 파일은 `.codex-target/release/bundle/` 아래에 만들어집니다(Windows는 NSIS/MSI, Linux는 DEB/AppImage, macOS는 APP/DMG). 앱과 `aiolm-cli`가 함께 포함됩니다. `npm run package:tauri`는 이 문서의 통합 패키징과 함께 빌드 머신의 경로를 바이너리에서 제거하므로, `tauri build`를 직접 실행하지 말고 이 명령을 사용하세요.

벤치마크 공유 서비스는 빌드 시점의 `AIOLM_BENCHMARK_API_URL`로 바꿀 수 있습니다. 설정하지 않거나 비워 두면 공식 AioLM 웹사이트 `https://aiolm.vercel.app`에 게시합니다. 다른 서비스는 루트 HTTPS 원본으로 지정하고, `off`(대소문자 무관)로 지정하면 익명 게시를 끈 빌드가 만들어집니다. 이때도 공유 요약과 로컬 결과 내보내기는 사용할 수 있습니다.

```powershell
$env:AIOLM_BENCHMARK_API_URL = "off"
npm run package:tauri
```
