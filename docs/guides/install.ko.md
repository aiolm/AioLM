# 설치

> **언어:** [English](install.md) | [한국어](install.ko.md) | [日本語](install.ja.md) | [中文](install.zh.md)

## 원라이너 설치 (Windows)

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

## 다운로드 검증

릴리스 인스톨러는 미서명 상태로 배포됩니다. 같은 릴리스의 `checksums.txt`와 SHA-256 값을 비교하세요.

```powershell
$installer = Get-ChildItem -File "./AioLM_*_x64-setup.exe" | Select-Object -First 1
# MSI는 "./AioLM_*_x64_en-US.msi"를 사용하세요.
(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# 같은 릴리스의 checksums.txt와 비교
```

릴리스 페이지: <https://github.com/aiolm/AioLM/releases/latest>

AioLM — All-In-One LM은 이전 앱과 별도로 설치됩니다. 첫 실행에서 기존 설정·관리 런타임·CLI 저장소·WebView 프로필을 새 `aiolm` / `com.aiolm.desktop` 경로로 복사합니다. 원본을 유지하며, 이미 존재하는 AioLM 데이터를 우선합니다. 이전 앱을 종료한 뒤 실행하고, 잠금이나 공간 부족 오류가 발생하면 문제를 해결한 뒤 재시도하세요. [이전 방식과 호환성](../reference/migration.md)을 참고하세요.

AioLM은 데이터를 `%USERPROFILE%\.aiolm`에 보관하며, `AIOLM_HOME` 환경변수로 다른 폴더를 지정할 수 있습니다. 이전 AioLM 버전의 데이터는 시작할 때 이 폴더로 가져오고, 관리 런타임은 복사하지 않고 이동합니다. [데이터 폴더](../reference/migration.md#data-folder)를 참고하세요.

## 제거

**설정 → 앱 → 설치된 앱 → AioLM → 제거**를 선택하거나 **제어판 → 프로그램 및 기능**에서 제거하세요. NSIS 제거 프로그램에서 **Delete the application data**를 선택하지 않으면 데이터는 그대로 남습니다. 이 옵션은 WebView 프로필과 데이터 폴더 `%USERPROFILE%\.aiolm`, 그리고 이전 버전이 쓰던 `%APPDATA%\aiolm`과 `%LOCALAPPDATA%\aiolm` 폴더를 삭제하되, 그 안의 `models` 폴더는 남깁니다. `AIOLM_HOME`으로 지정한 폴더와 다른 위치의 모델은 삭제하지 않으며, MSI 제거 프로그램은 데이터를 삭제하지 않습니다. 필요하면 해당 폴더를 별도로 삭제하세요.

## Linux / macOS (예정)

Linux·macOS의 실제 환경 검증은 아직 진행 전입니다. 호스트 빌드는 Linux에서 DEB/AppImage, macOS에서 APP/DMG를 생성합니다. [플랫폼별 검증 절차](../reference/cross-platform-validation.md)를 참조하세요. 패키지 생성·체크섬 검증과 별도로 macOS 서명·공증 및 설치 검증이 필요합니다. DEB/DMG 업데이트는 검증된 파일을 시스템 설치 화면으로 전달하며, 사용자가 설치를 마무리합니다. AppImage·수동 설치는 릴리스 페이지에서 업데이트합니다.
