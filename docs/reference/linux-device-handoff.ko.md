# Linux 기기 기능 검증·개선 인계

## 1. 이 문서의 위치와 상태

이 문서는 Linux에서 AioLM 전체 기능을 **처음부터 실제로 검증**하고, 기준선을 기록한 뒤 프로젝트 전체의 효율·UX·가독성·구조를 개선하기 위한 정식 인계다. Windows 작업은 updater 진행률 작업(R429→R433)과 해당 문서·커밋까지만 마치고 종료했으며, 이후의 기능 검증과 개선은 Linux에서 이어간다.

**현재 source의 Linux 기능은 아직 실행 검증되지 않았다.** 아래 행렬의 모든 행은 초기 상태 `unrun`이다. 문서·자동 검사·합성 fixture의 존재는 Linux 통과가 아니다.

근거를 네 종류로 구분한다. 서로 대체하지 않는다.

| 구분 | 의미 | 예 |
| --- | --- | --- |
| 과거 실제 Windows 근거 | 기록된 source·binary·기기 범위의 실제 실행 결과 | `53df149`의 GUI 어댑터 최종 수락, WIN-Q01/Q02 fail 잔여 |
| 현재 구현 | 검증 기준 commit의 코드·계약·자동 검사 | manifest v1, help→GUI schema, updater 진행률 coalescing |
| 계획된 확장 | 설계 문서에 있으나 구현 완료로 기록하지 않은 범위 | pluggable runtime 문서의 v1 밖 capability |
| 미실행 Linux | 현재 source로 Linux에서 실행한 근거가 없는 모든 항목 | 이 문서의 L01–L04 전체 |

Windows 근거의 범위:

- 원래 Windows GUI 어댑터 수락(종료 commit `53df1491cbb6dc790e9594221c3191a6c210937e`, 제품 source `908a2fb6bd5bdb4742eb4db6e8f6ac9e352956c1`)은 **기록된 과거 범위의 완료**다. 그 뒤의 production GUI를 새로 수락한 것이 아니다. G01–G07 pass, W01–W08 중 W04·W05의 원래 응답 내용은 WIN-Q01/WIN-Q02 fail로 남아 있다([Windows 결과](windows-device-validation-results.ko.md)).
- 이후 Windows 변경의 근거는 [효율 검토 기록](efficiency-review.ko.md)의 각 source·검사·제한을 따른다. 자동·합성 검사와 한정된 실제 Chrome/개발 앱 관찰을 전체 production GUI·실제 엔진·설치 수락으로 확대하지 않는다. 마지막 updater 수정은 새 production GUI·실제 다운로드·설치를 실행하지 않았다.
- Windows native unit 검사, `cfg(test)`로 Windows에서 실행한 Unix 경로 검사, parser 검사, 합성 GUI/IPC 검사는 Linux 통과가 아니다. 특히 `#[cfg(target_os = "linux")]` 코드(예: `src-tauri/src/app_update.rs`의 `linux_install`, `src-tauri/src/tray.rs`의 Linux tray, `src-tauri/src/mcp/linux_approval.rs`, Linux 전용 `gio`/`zbus-secret-service-keyring-store` 의존)는 Windows에서 컴파일조차 되지 않는다.

과거 Linux 기록([Linux·macOS 이식 인계](linux-macos-handoff.ko.md)의 2026-10-03~04 Ubuntu 26.04 실행, 이 문서 이전 판의 `2c7d6d3` 기준 계획)은 **당시 source의 역사적 근거**다. 현재 source의 pass로 옮기지 않는다. 이전 판 전문은 `git log -p -- docs/reference/linux-device-handoff.ko.md`로 확인한다. 이전 판 ID와 현재 항목의 연결은 §10, 이어받은 수정 위치는 §13에 있다.

## 2. 시작 전에 읽을 문서와 확인할 사실

1. 저장소 `AGENTS.md`, 존재하면 `tmp/AGENTS.local.md`.
2. 이 문서 전체와 [Linux /goal 지시문](linux-device-validation-goal-prompt.ko.md).
3. 필요할 때 다음 1차 문서: [엔진 중립 GUI 어댑터의 Linux·Mac 후속 인계](engine-adapter-linux-macos-handoff.ko.md)(L01–L04 정의·공통 수정 재검증 연결), [Windows 검증과 구조 전환 계획](windows-device-handoff.ko.md)(L/M 순서), [외부 런타임 어댑터 계약](runtime-adapter-handoff.ko.md), [교체 가능한 추론 런타임](pluggable-inference-runtimes.ko.md), [Inference runtimes](inference-runtimes.md), [Provider native acceptance](provider-native-acceptance.md), [Cross-platform validation](cross-platform-validation.md), [개발](../guides/development.ko.md)·[설치](../guides/install.ko.md) 안내, [효율 검토의 남은 검토](efficiency-review.ko.md#남은-검토).
4. 실행 전에 다시 읽을 실제 파일: `package.json`(`engines`, `packageManager`, scripts), `.node-version`, `rust-toolchain.toml`, `src-tauri/Cargo.toml`(features·target 의존성), `src-tauri/tauri.conf.json`, `scripts/package-tauri.mjs`, `.github/workflows/{ci,desktop-packages,linux-desktop-acceptance,release}.yml`, 각 smoke 스크립트 머리말.

검증 기준 commit 시점의 manifest 값(실행 전 다시 확인): Node `22.23.2`, npm `12.0.2`, Rust `1.98.0`+rustfmt/clippy, 앱 `0.3.1`, Linux package `deb,appimage`(`scripts/package-tauri.mjs`), DEB 의존 `zenity`, Linux vLLM `0.31.0`, MLX·vllm-metal은 Apple Silicon macOS 전용([Inference runtimes](inference-runtimes.md)). CLI flag·옵션은 문서에서 추측하지 말고 실제 `--help`와 스크립트 소스를 읽는다.

**“Orca” 이름 구분:** Linux 접근성 검사의 화면 낭독기는 GNOME **Orca**(AT-SPI)다. Orca IDE가 설치된 경우 해당 세션의 skill로 실행 파일을 확인한다. `ORCA_CLI_COMMAND`가 있으면 그 값을 우선하며, Linux의 Orca IDE 터미널 밖에서는 `orca-ide`를 확인하고 bare `orca`를 실행하지 않는다. GNOME 화면 낭독기와 IDE 명령을 혼동하지 않는다.

## 3. 소스 전달과 무결성 확인 (L01-S)

원격 push는 승인되지 않았다. `origin`(GitHub)에 Windows의 미공개 commit이 있다고 가정하지 않고, 자동으로 push·pull하지 않는다. 전달 파일은 최종 문서 commit을 포함한 자체 포함 Git bundle, 별도 manifest, SHA-256 checksum이다. bundle에는 Git 객체만 들어가며 `tmp/`·사용자 데이터·`node_modules`·build 산출물·Git 설정은 들어가지 않는다.

순환 hash를 피하는 규칙:

- 이 문서와 /goal 지시문에는 **검증된 코드 commit** `43b50686627df9631210419739544f3e5e317fc1`(40자리)만 고정한다. 이 commit은 최종 HEAD의 조상이다.
- bundle 파일의 SHA-256과 **최종 HEAD**(이 문서를 포함한 commit)는 bundle 옆의 별도 manifest `delivery-manifest.json`와 checksum 파일 `aiolm-windows-validation.bundle.sha256`에만 기록한다. manifest 자신의 hash는 manifest 안에 넣지 않는다.

동봉 manifest의 필수 항목: bundle 파일명·SHA-256·포함 ref(`refs/heads/codex/windows-runtime-adapter-validation`)·`final_head`·`validated_code_commit`·필수 조상 목록·`validated_code_commit..final_head`에서 바뀐 경로 목록(문서만이어야 함)·생성에 쓴 Git 버전.

| ID | 확인 | 통과 조건 | 증거 | 상태 |
| --- | --- | --- | --- | --- |
| L01-S01 | bundle checksum과 Git 검사 | `sha256sum -c`가 OK, `git bundle verify` 성공, `git bundle list-heads`에 manifest의 ref가 있음 | 명령·exit·출력 | unrun |
| L01-S02 | 최종 HEAD와 조상 | 받은 ref == manifest `final_head`. `validated_code_commit`, `df3264bad99deb0144b947f96300e8625f7a2da5`, `53df1491cbb6dc790e9594221c3191a6c210937e`, `908a2fb6bd5bdb4742eb4db6e8f6ac9e352956c1`, `4ad1f1fdadfcca736342a36fc4636f5613a2b866`가 조상. `git diff --name-only <validated>..<final_head>`가 manifest 목록과 같고 문서 경로만 포함 | 명령·exit·목록 | unrun |
| L01-S03 | 기존 checkout 보존 | 기존 저장소의 `git status --short`·branch를 먼저 기록하고 바꾸지 않음. 같은 이름 작업 branch가 있으면 초기화하지 않고 상태를 확인 | 전후 status | unrun |

새 폴더로 받기(bundle·manifest·checksum을 둔 폴더에서 변수만 실제 값으로 바꾼다):

```sh
set -eu
BUNDLE='aiolm-windows-validation.bundle'
sha256sum -c "$BUNDLE.sha256"
cat 'delivery-manifest.json'          # final_head·validated_code_commit 확인
FINAL_HEAD='<manifest의 final_head>'
VALIDATED='43b50686627df9631210419739544f3e5e317fc1'
git clone --no-checkout "$BUNDLE" AioLM-linux
cd AioLM-linux
git bundle verify "../$BUNDLE"
git remote rename origin windows-bundle      # bundle 경로 remote를 GitHub origin과 구분
test "$(git rev-parse windows-bundle/codex/windows-runtime-adapter-validation)" = "$FINAL_HEAD"
for c in "$VALIDATED" df3264bad99deb0144b947f96300e8625f7a2da5 \
  53df1491cbb6dc790e9594221c3191a6c210937e \
  908a2fb6bd5bdb4742eb4db6e8f6ac9e352956c1 4ad1f1fdadfcca736342a36fc4636f5613a2b866; do
  git merge-base --is-ancestor "$c" "$FINAL_HEAD" || { echo "MISSING $c"; exit 1; }
done
git diff --name-only "$VALIDATED" "$FINAL_HEAD"   # manifest 목록과 비교
git switch -c 'codex/linux-runtime-adapter-validation' "$FINAL_HEAD"
git status --short
```

이미 있는 저장소에 받기(사용자 변경 보존, 작업 트리를 건드리지 않는 별도 ref와 worktree 사용):

```sh
set -eu
git status --short                           # 결과 기록, 아무것도 지우지 않음
BUNDLE_PATH='<checksum을 확인한 bundle의 절대 경로>'
FINAL_HEAD='<manifest의 final_head>'
git bundle verify "$BUNDLE_PATH"
git fetch "$BUNDLE_PATH" \
  'refs/heads/codex/windows-runtime-adapter-validation:refs/aiolm-handoff/windows-final'
test "$(git rev-parse refs/aiolm-handoff/windows-final)" = "$FINAL_HEAD"
VALIDATED='43b50686627df9631210419739544f3e5e317fc1'
# 위와 같은 조상·경로 검사 후, 같은 이름 branch/worktree가 없을 때만 생성한다.
# 이미 있으면 git branch --list / git worktree list로 확인하고 기존 상태에서 이어간다.
git worktree add ../AioLM-linux-validation -b 'codex/linux-runtime-adapter-validation' "$FINAL_HEAD"
```

`refs/aiolm-handoff/windows-final`이 이미 있으면 다른 새 이름을 쓴다. Windows의 `node_modules`·`dist`·`.codex-target`·실행 파일·venv·설치 파일·`tmp/` 자료를 복사하지 않는다. Git에 없는 Windows raw 증거는 이 인계의 전제가 아니다.

## 4. 판정 규칙

상태는 `pass`(명시한 조건에서 실제 성공), `fail`(실행 후 기준 미충족), `unsupported`(현재 계약·플랫폼의 명시적 미지원, **문서·소스 근거 필수**), `unrun`(실행 근거 없음), `blocked`(필요한 기기·모델·권한·계정을 확보하지 못함, 조건과 다음 절차 필수)만 쓴다.

- 하드웨어·모델·인증·계정이 없으면 계약 근거 없이 `unsupported`로 쓰지 않는다. 필요한 조건을 적어 `blocked` 또는 `unrun`으로 둔다.
- 모델 교체, token 한도 증가, hash 검사 생략, readiness 제거, 실패 skip, 근거 없는 timeout 확대로 pass를 만들지 않는다. 원래 요청·모델·한도는 바꾸지 않고, 다른 조건의 대조는 별도 행으로 기록한다.
- 합성 echo·loopback fake·`--self-test`·`synthetic:true`는 실제 추론이 아니다.
- WSL·container·VM 안의 결과는 각각 그 환경으로 기록하고 native Linux desktop/GPU 결과와 합치지 않는다.
- headless·Xvfb·자식 PATH 조작 성공은 실제 desktop 세션·별도 계정·실제 파일 부재 검사를 대신하지 않는다.
- 이미 기록된 엔진 출력 정책·모델 품질 잔여(WIN-Q01 reasoning만 생성된 Strata 32-token 요청, WIN-Q02 SmolVLM 색·도형)는 어댑터 전송 결함과 분리한다. 전송·파서·수명주기 결함이 새로 재현되면 그것만 제품 결함으로 연다.

모든 행의 공통 증거 필드: 날짜, source commit과 dirty 여부·tracked diff hash, OS/kernel/arch·세션 종류, GUI/CLI binary SHA-256, 엔진 source revision·binary hash, 모델 repository·전체 revision·파일 SHA-256, 실행 명령(개인 경로 익명화)·exit code, raw 위치(`tmp/linux-acceptance/…`), 기대와 실제 관찰, 상태, 원인(확정/미확정), 수정 commit, 회귀 검사, 실제 재검사 결과, 다음 작업·blocker.

## 5. 실행 순서

1. L01-S → L01-E: 소스·환경·격리를 확정한다.
2. L01-T: 저장소 자동 검사 전체를 Linux에서 새로 실행해 **기준선**을 기록한다. 실패는 먼저 환경 문제와 제품 결함을 구분한다.
3. L01-H: 고정 production binary에서 합성 CLI·help·argv·경로 계약을 확인한다.
4. L02-N → L02-F: 실제 엔진(CPU부터) → 공통 기능의 실제 GUI 여정.
5. L03-D → L03-P → L03-U: desktop OS 통합 → package/bundle/export → updater.
6. L04: 기준선이 고정된 뒤에만 결함 수정·개선 루프를 시작한다. 기능 검증 공백을 먼저 채운다.

GPU·특정 모델·별도 계정·관리자 권한이 필요한 항목이 막혀도 그 조건을 기록하고 독립 항목을 계속한다.

## 6. L01 — 소스·자동 검사·빌드·help·경로

### L01-E 환경과 격리

| ID | 확인 | 통과 조건·주의 | 상태 |
| --- | --- | --- | --- |
| L01-E01 | 배포판·커널·arch·CPU·RAM·가상화 | `/etc/os-release`, `uname -srm`, `lscpu`, `free -h`, `systemd-detect-virt`(있으면). 현재 package·설치 안내 기준은 Ubuntu 24.04+ x86_64이며 다른 배포판·ARM64는 별도 결과 | unrun |
| L01-E02 | GPU·driver·API | 있는 도구만: `lspci -nnk`, `nvidia-smi`, `rocminfo`, `vulkaninfo --summary`. 소프트웨어 렌더러와 실제 GPU 구분. 도구·장치가 없으면 GPU 행을 그 조건으로 `blocked` | unrun |
| L01-E03 | desktop 세션 | `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, `WAYLAND_DISPLAY`/`DISPLAY`, tray host(StatusNotifier/AppIndicator) 유무, xdg-desktop-portal, IME(IBus/Fcitx), Secret Service 제공자와 잠금 상태, GNOME Orca·AT-SPI 사용 가능 여부 | unrun |
| L01-E04 | 도구 버전 | `node --version`, `npm --version`, `rustc --version`, `cargo --version`, `python3 --version`, `pkg-config --modversion webkit2gtk-4.1`. manifest 값과 다르면 작업용 설치로 맞추고 시스템·사용자 도구를 덮어쓰지 않음 | unrun |
| L01-E05 | native 의존성 | [Tauri Linux 준비](https://v2.tauri.app/start/prerequisites/#linux)와 CI의 Ubuntu 24.04 목록을 근거로 한다(아래). 다른 배포판에 apt 명령을 그대로 쓰지 않고 같은 라이브러리를 배포판 패키지 이름으로 찾는다. 관리자 설치는 사용자 승인 뒤에만 | unrun |
| L01-E06 | 새 의존성·binary | CI와 같은 `npm ci --ignore-scripts` 후 `npm rebuild esbuild`. lockfile 무변경(`git diff --exit-code package-lock.json src-tauri/Cargo.lock`). Cargo 출력은 `.codex-target` | unrun |
| L01-E07 | 사용자 데이터 격리 | 앱 데이터는 `AIOLM_HOME` 또는 `~/.aiolm`, 이전 경로는 `$XDG_CONFIG_HOME/aiolm`·`$XDG_DATA_HOME/aiolm`(기본 `~/.config`·`~/.local/share`)이다(`src-tauri/src/home.rs`). 검사는 테스트 자식 프로세스에만 임시 `HOME`·`XDG_CONFIG_HOME`·`XDG_DATA_HOME`·`AIOLM_HOME`을 함께 적용한다. 실제 계정의 환경·도구 설정을 덮어쓰지 않는다. 최초 실행·legacy 이전·Secret Service는 별도 테스트 OS 계정. 실제 사용자 설정·이력·자격 증명은 시작 전후 hash만 비교하고 내용을 기록하지 않음 | unrun |

CI가 Ubuntu 24.04에서 쓰는 패키지(근거: `.github/workflows/ci.yml`, `desktop-packages.yml`): `libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`, vault 검사용 `gnome-keyring xvfb xauth dbus-x11 python3-gi gir1.2-atspi-2.0 at-spi2-core`, AppImage용 `patchelf`, package metadata용 `desktop-file-utils`. MCP 승인창에는 `zenity`가 필요하다. `pciutils`는 GPU 이름 표시용 선택 항목이다. Secret Service가 없을 때 평문 vault로 대체하는 경로를 만들지 않는다.

### L01-T 자동 검사 기준선

명령은 실행 직전에 `package.json`·workflow와 다시 대조한다. 각 명령을 하나씩 실행하고 exit·전체 로그를 `tmp/linux-acceptance/`에 남긴다. timeout·worker·skip·threshold를 바꾸지 않는다.

| ID | 명령(검증 기준 commit의 manifest 기준) | 비고 | 상태 |
| --- | --- | --- | --- |
| L01-T01 | `npm run typecheck` | contracts build 포함 | unrun |
| L01-T02 | `npm run lint` | | unrun |
| L01-T03 | `npm run test:unit` | contracts·provider-options·scripts·direct·Vitest coverage | unrun |
| L01-T04 | `npm run build` | production frontend | unrun |
| L01-T05 | `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | | unrun |
| L01-T06 | `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | Linux 전용 cfg 코드의 첫 native 컴파일 검사 | unrun |
| L01-T07 | `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | Unix 자손 프로세스 정리·symlink·실행 권한·대소문자 구분 경로·listener 소유 검사 포함. ignored 수는 pass에 넣지 않음 | unrun |
| L01-T08 | `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets --no-default-features` | 배포 feature 정책 | unrun |
| L01-T09 | `cargo build --locked --manifest-path src-tauri/Cargo.toml --bins` 후 `npm run test:native-cli` | 격리 CLI smoke | unrun |
| L01-T10 | Python: `python3 -B -m unittest discover -s scripts/runtime-adapters -p 'test_*.py'`, `-s scripts/model-repair`, `-s scripts/provider-compatibility`, `-s src-tauri/src/providers -p '*_tests.py'`, `-s src-tauri/src/providers/tests -p 'test_*.py'`, `-s scripts -p 'test_linux_desktop.py'` | 실제 Python 버전 기록 | unrun |
| L01-T11 | `npm run test:provider-runtime` | 합성 harness. 실제 엔진 근거 아님 | unrun |
| L01-T12 | `npm run build:cli` 후 `npm run test:native-cli -- .codex-target/release/aiolm-cli` | release CLI | unrun |
| L01-T13 | `python3 scripts/smoke-linux-vault.py` | 독립 DBus 세션의 실제 Secret Service 잠금·취소·복구. 필요한 도구가 없으면 setup 실패로 기록 | unrun |
| L01-T14 | `AIOLM_TEST_PYTHON=<실제 Python> cargo test --locked --manifest-path src-tauri/Cargo.toml --test runtime_interpreter_command_journey -- --ignored` 및 같은 방식의 `runtime_positional_metadata_journey` | 실제 argparse 수락만 확인, 추론 아님 | unrun |
| L01-T15 | updater 모듈: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib app_update` | R433 회귀 포함(§8 L03-U01). Windows 기록 `Windows의 최종 app_update 모듈 34개 통과. 추가한 6개 회귀는 a_download_reports_its_first_bytes_and_each_whole_percent_through_the_last_byte, a_download_reports_the_writes_that_change_the_percentage_the_settings_panel_shows, a_download_of_unknown_size_is_reported_by_time_rather_than_by_every_chunk, bytes_written_before_a_stalled_read_are_reported_once_while_it_waits_or_when_it_ends, a_failed_download_last_reports_only_bytes_that_were_written, a_dropped_download_releases_its_body_and_file_and_reports_nothing_more다. GUI 29% 경계의 실제 RED(33 pass/1 fail) 뒤 수정했고, 실제 기본 500 ms의 별도 전후 스트림 11쌍(완료 9·취소 2)으로 알림 수·확정 쓰기 바이트·SHA·drop 뒤 무알림을 비교했다. 별도 probe는 임시 측정이며 Linux가 새로 실행할 retained module 검사와 구분한다. 500 ms는 다음 read 대기의 미보고 바이트에만 적용하며 write/flush stall의 상한은 아니다`와 Linux 결과를 따로 기록 | unrun |

검증 기준 commit의 Windows 최종 자동 검사 수치는 `Windows Rust library 1,294 pass·기존 ignored 6, cargo fmt --all -- --check 및 Clippy --all-targets --all-features -- -D warnings exit 0, 관련 UI 2개 파일·13 pass. 최종 변경은 native 파일 하나다. 바뀌지 않은 프런트엔드의 이전 전체 검사(typecheck·lint·production build·기본 npm test exit 0, 219개 파일·2,523 pass)는 source 동일성에 한해서 재사용했고 이번 전체 재실행으로 세지 않는다. 실제 production GUI·릴리스 다운로드·설치는 이번 수정에서 unrun`다. Linux 결과와 비교할 때 OS별 cfg 테스트 수 차이를 실패로 단정하지 않고 실제 목록 차이로 설명한다.

### L01-H 고정 binary의 help·argv·경로 계약

먼저 production binary(`npm run package:tauri` 산출물 또는 release build)를 만들고 GUI/CLI SHA-256을 기록한다. 그 **뒤에** 합성 CLI 엔진의 새 flag와 실제 개인 엔진의 새 flag를 준비하고, 고정 binary와 source에 그 문자열이 없음을 확인한다.

| ID | 대상 | 통과 조건 | 상태 |
| --- | --- | --- | --- |
| L01-H01 | 엔진 중립 등록 여정 | 실행 파일/entry point 선택 → 실제 `--help` → 모든 편집 가능 옵션이 GUI에 처음부터 표시·검색 → 새 프로필 저장/재열기 → 실제 argv(합성 parser가 받은 값 대조) → protocol/health/model probe → Ready → 응답(합성은 synthetic으로 표시) | unrun |
| L01-H02 | 공통 옵션 표현 | bool·단독 `--no-x`와 같은 이름 값 옵션 공존, `--key=value`, short, optional value, 고정·가변 arity, repeat, 여러 값, positional 배치, subcommand scope, runtime default 출처, launch/request target, sensitive 마스킹(미리보기·CLI config·benchmark), reserved, `-`로 시작하는 값, 빈 문자열, Unicode·공백 argv가 shell 재해석 없이 보존 | unrun |
| L01-H03 | app-owned binding | model/host/port/auth·`--` 경계를 raw args·alias·metadata로 덮어쓰기 거부(backend 검사 포함). 비HTTP CLI는 명시 bridge(`bridge_command`, `launch_resources`)로만 연결 | unrun |
| L01-H04 | 버전·변조 | 같은 엔진의 두 build(hash 변경)에서 flag/default/arity 변화 감지, help cache 무효화·diff·사라진 옵션 표시·저장 값 보존. artifact 변조·잘못된 OS 거부. parser version 변경 시 stale | unrun |
| L01-H05 | 경합·취소·실패 | help timeout·출력 초과·자식 잔존, 두 모델의 늦은 probe 경합, 실행 전 검사 취소(D81), 옵션 편집 후 첫 저장 클릭(D82), 제거→누락 안내→재등록(D86), 실패 후 재시도 | unrun |
| L01-H06 | Linux 경로·locale | 대소문자만 다른 POSIX 경로, 한글·공백·따옴표·역슬래시, symlink·외부 mount·읽기 전용 폴더, cwd 기록, `locale -a`로 확인한 실제 locale·인코딩 선택 | unrun |
| L01-H07 | 엔진 분기 금지 | 공통 기능에 새 engine ID 비교·고정 3엔진 가정·모델 형식 추정 필터·프로필의 미지원 공통 옵션 전달이 없는지 정적 검토(`rg`)와 위 여정으로 확인. 정적 검토는 실행 pass가 아님 | unrun |
| L01-H08 | 외부 v1 미지원 경계 | 외부 엔진의 정확한 tokenizer/cold-cache benchmark·CPU reference deep·ABI portable 거부와 이력·CSV/XLSX 보존. opaque binding 크기 `—` 표시(D87)·외부 후보 호환성 unknown | unrun |
| L01-H09 | `launch_resources` Linux 정리 | UUID 폴더·소유 잠금 파일, 비정상 종료 후 다음 실행의 회수 조건(링크 거부, 실행 중 보존), CLI `server stop` 재실행 정리 | unrun |

## 7. L02 — 실제 엔진과 공통 기능 GUI

### L02-N 실제 엔진

| ID | 대상 | 실행·통과 조건 | 상태 |
| --- | --- | --- | --- |
| L02-N01 | llama.cpp CPU | GUI 관리형 설치 또는 `AIOLM_RUNTIME_INSTALL=1 AIOLM_RUNTIME_BACKENDS=cpu cargo test --locked --manifest-path src-tauri/Cargo.toml --test runtime_install -- --ignored --nocapture --test-threads=1`. 작은 GGUF로 `AIOLM_SMOKE`/`--test smoke`(파일 머리말과 [Cross-platform validation](cross-platform-validation.md#native-acceptance) 확인). `native_cpu`의 `real_cpu_cli_lifecycle`은 `AIOLM_NATIVE_CPU=1`과 공개 모델 다운로드를 요구하므로 네트워크 허용을 확인한 뒤 단독 실행 | unrun |
| L02-N02 | llama.cpp GPU backend | 실제 장치가 있는 backend(cuda/vulkan/rocm)만 각각. 장치 열거 이름 사용, CPU fallback을 GPU 성공으로 기록하지 않음. 없으면 그 backend `blocked` | unrun |
| L02-N03 | 외부 llama.cpp build 어댑터 | `scripts/runtime-adapters/create_adapter.py create --kind llama.cpp …` → `npm run test:runtime-adapters -- --cli … --manifest … --model … --provenance …`([절차](runtime-adapter-handoff.ko.md#실제-외부-llamacpp-빌드-검증)). A01–A09, 소유 PID/port 종료, provenance 보존 | unrun |
| L02-N04 | native Linux vLLM 0.31.0 | 계약상 GPU와 맞는 wheel·PyTorch·driver 조합이 필요하다. 관리형 설치 또는 격리된 기존 환경 등록 후 `node scripts/smoke-provider-runtime.mjs --engine vllm …`과 Rust live gate(`AIOLM_PROVIDER_ACCEPTANCE=1 … --test provider_runtime_acceptance -- --ignored --nocapture --test-threads=1`). embedding·transcription·media·tools는 모델이 선언한 경우에만 `--task`/`--expect-*` | unrun |
| L02-N05 | vLLM portable 왕복 | export → 새 홈 import → probe → 실제 추론. 해시 손상·OS/ABI 불일치·Ctrl-C·실행 중 import 거부·기존 파일 보존([Portable round-trip](provider-native-acceptance.md#portable-round-trip)) | unrun |
| L02-N06 | 원본 Strata | 대상 [Niko1221/Strata](https://github.com/Niko1221/Strata)(`https://github.com/niko1221/strata`와 같은 저장소). 실행할 **전체 revision을 고정**하고 그 revision의 문서에서 지원 OS·GPU·RAM·모델/파일 형식을 직접 확인한다. 검토된 어댑터 revision은 `296b59d2f73c8f04a805df29c2fa97655adace78`이며 다른 revision은 어댑터·bridge 재검토가 필요하다. Windows 모델 shard revision `5348543e0147355ac9cbcb031184a3546350988e`을 재현하려면 Linux native 실행 파일·라이브러리를 새로 빌드한다. 모델 이름을 추측하거나 지원되지 않는 GPU 경로를 강제하지 않는다. 전용 deployment JSON의 `cors_origins`는 Linux production WebView의 **실제 origin을 관찰해** 정확한 값만 넣는다(Windows의 `http://tauri.localhost`를 가정하지 않음, `*` 금지). 조건 미충족은 구체적 조건과 함께 `blocked` | unrun |
| L02-N07 | 실제 개인 엔진(Strata 외) | 고정 binary 뒤 만든 새 flag로 help→GUI→프로필→argv→probe→Ready→응답/usage→취소/Retry→재시작/종료. Strata 실행 성공을 대신하지 않음 | unrun |
| L02-N08 | MLX·vllm-metal | 계약상 Apple Silicon macOS 전용이다. Linux에서는 선택 시 미지원 안내와 저장 값 보존을 검사한다(엔진 자체는 계약 근거의 `unsupported`). Linux native 지원으로 기록하지 않음 | unrun |
| L02-N09 | 원래 품질 잔여 대조(선택) | WIN-Q01: 원래 요청 SHA-256 `02ad3c50bedefc28a1d2728530e4289ee61e31795dec3920b0b87c9b7b7c4c88`, 32 token. WIN-Q02: GUI body SHA-256 `cdec23afa6d0bd1b7070f1580aeace6d71347bfa41fbf1f2a92c51d8460dea60`. 원래 입력을 Linux에서 재현할 수 있을 때만 raw reasoning/content/usage/finish를 보존해 비교. 전송 결함과 모델·엔진 정책을 분리 | unrun |

harness의 `outcome=pass`는 전체 기능 통과가 아니다. harness는 엔진에 직접 연결하므로 앱 gateway·인증·이력은 아래 GUI 행에서 따로 확인한다.

### L02-F 공통 기능의 실제 production GUI 여정

실제 WebKitGTK의 production binary(개발 서버가 아닌 package 또는 release build), 별도 테스트 홈/계정, 가능한 실제 엔진으로 실행한다. X11과 Wayland가 모두 있으면 둘 다 기록한다. 화면 위치는 실행 직전에 실제 앱과 source로 다시 확인한다.

| ID | 기능(대표 source) | 확인할 실제 관찰 | 상태 |
| --- | --- | --- | --- |
| L02-F01 | 최초 실행·설정 이전(`src/features/onboarding`, `src-tauri/src/home.rs`, `src-tauri/src/config`) | 빈 홈 onboarding, 합성 구버전 설정의 schema 14 이전과 원본 backup, 미등록 engine 값 보존·llama.cpp fallback 없음, 앱 데이터 쓰기 실패 후 복구 | unrun |
| L02-F02 | 런타임→프로필→옵션(`src/features/model-settings`, `src/features/runtimes`, `src/features/tuning`) | 엔진·런타임 카드 선택, 모달 안 런타임 관리 후 복귀와 초안 보존, 프로필 목록 미리보기/적용/이름 변경/기본/삭제 확인, 옵션 전체 표시·검색, 런타임 옵션 기본값 복원과 프로필 전체 초기화 구분, 대화 지침 유지, 요약·저장 확인의 민감 값 마스킹 | unrun |
| L02-F03 | UX 품질 | 발견성·쉬운 용어·중복 동작 없음·오류 설명과 복구, 취소/Retry, 키보드만으로 진입·이탈·포커스 복원, GNOME Orca의 이름·상태·오류 안내, IME 한글 조합, 360×520 최소 창과 배율, 1,000개 이상 옵션의 검색·렌더, 빠른 연속 조작의 경합 | unrun |
| L02-F04 | Chat(`src/features/chat`) | 실제 추론 stream·reasoning·usage, 내용 수신 후 중지한 부분 응답 보존, Retry가 같은 메시지를 중복 없이 보내고 이전 usage를 재사용하지 않음, 모델 재시작·정상 Quit 후 이력 재로드, 자동 시스템 안내 on/off, 첨부 우선 순서 저장/재로드, 멀티 세션 | unrun |
| L02-F05 | 데이터 보존 | 프로필·runtime/model binding·이력·API 설정·benchmark 이력의 저장→종료→재실행 보존, 작업 전후 hash 비교 | unrun |
| L02-F06 | 프로젝트·RAG·문서(`src/features/projects`, `src-tauri/src/commands/documents.rs`) | 답변 세션과 embedding 세션의 명시 연결, 여러 후보의 임의 선택 방지, keyword fallback, PDF/DOCX 추출, namespace·벡터 저장 유지 | unrun |
| L02-F07 | STT·영상 전처리(`src-tauri/src/media`) | 명시적으로 고른 STT 세션의 전사 전달, 실제 `ffmpeg` 영상 프레임(음성 미포함 표시), 실패·취소 시 부분 기록 없음, Retry의 전처리 재사용, 4개 미디어 한도 | unrun |
| L02-F08 | MCP(`src/features/mcp`, `src-tauri/src/mcp/linux_approval.rs`) | stdio 도구 schema→zenity 승인 Yes/No→실제 호출→입력과 다른 반환값의 후속 답변, 승인 대기·실행 중 Stop의 도구·승인창 정리, tools 미지원 모델의 명시 거부 | unrun |
| L02-F09 | 미디어 내용 | 모델·processor·설치 조합이 선언한 이미지·음성·영상만 실제 내용으로 판정. 미지원 입력의 설명 있는 거부, 64 MiB 파일 한도, 첨부 순서·저장/재로드·Retry | unrun |
| L02-F10 | gateway(`src/features/developer`, `src-tauri/src/gateway`) | 무인증·잘못된 키 401·정상 200, 모델 alias·여러 세션 라우팅, OpenAI/Anthropic/Responses 경로, 미지원 task 거부, 취소 후 lease 반환, API listener와 모델 수명 분리 | unrun |
| L02-F11 | 측정·공유(`src/features/bench`, `src-tauri/src/benchmark`) | PP/TG, 중간 취소 시 완료 행 보존, worker RSS(VRAM 총량으로 표시하지 않음), cold-cache 근거, 이력·CSV/XLSX 내보내기, 공유 미리보기·동의. 공개 upload는 별도 명시 승인 없이는 하지 않음 | unrun |
| L02-F12 | 모델 탐색·관리(`src/features/discover`, `src/features/models`) | Hub 검색→immutable revision 다운로드→설정→실행, GGUF 조각·snapshot·companion, 취소·재시도·불완전 표시, 외부 파일·활성 binding 삭제 보호, hard-link 없는 파일시스템의 실패 표시 | unrun |
| L02-F13 | 개인화·스킬(`src/features/settings/PersonalizationSettings.tsx`, `src-tauri/src/personalization.rs`) | 개인화/AGENTS/skill 내용의 실제 요청 반영, skill symlink 정책 | unrun |
| L02-F14 | 프로세스·포트 소유 | 모델 두 개·API listener·MCP 승인이 동시에 있을 때 정상 Quit 후 소유 worker·ffmpeg·pip/CMake 자식·승인창·포트·임시 key 파일 정리(`ss -ltnp`, `ps`). 다른 사용자 프로세스 보존. SIGKILL 잔존은 알려진 제한으로 따로 기록 | unrun |

## 8. L03 — desktop OS·package·bundle·export·updater

### L03-D desktop 통합

| ID | 대상 | 통과 조건 | 상태 |
| --- | --- | --- | --- |
| L03-D01 | 파일·폴더 선택 | GTK/portal 선택·취소, 한글·공백 경로, PDF·이미지 첨부, drag/drop | unrun |
| L03-D02 | clipboard·IME | 복사/붙여넣기, IBus/Fcitx 한글 조합, IME 조합 중 Enter 처리 | unrun |
| L03-D03 | tray | tray host가 있을 때 Show/Quit·close-to-tray on/off, host가 없을 때 창이 영구히 숨지 않는 fallback(`src-tauri/src/tray.rs`), 숨김 중 엔진 identity/포트/응답 유지→복원→명시 Quit 정리 | unrun |
| L03-D04 | 창·인스턴스 | 최초 표시·작은/큰 화면·배율·다중 monitor, 두 번째 실행의 기존 창 복원. Windows 전용 창 배치(D84)를 추정 이식하지 않음 | unrun |
| L03-D05 | 알림 | 실제 desktop 알림 수신, 실패 시 앱 동작 유지 | unrun |
| L03-D06 | Secret Service | 합성 자격 증명으로 읽기·쓰기·수정·삭제, unlocked·locked·unavailable, 승인 취소, 잠금 해제 후 원래 값 복구. 평문 대체 없음. 실제 사용자 비밀을 쓰지 않음 | unrun |
| L03-D07 | 4개 언어 안내 | 종료/숨김 설명, updater 설치 가능·불가 안내, 작은 창 줄바꿈 | unrun |

### L03-P package·bundle·export

| ID | 대상 | 통과 조건 | 상태 |
| --- | --- | --- | --- |
| L03-P01 | package 생성 | `npm run package:tauri`의 DEB·AppImage(`.codex-target/release/bundle`), GUI·CLI 포함, `test-fixtures`·가짜 서버·개인 경로(UTF-8/UTF-16) 제외, 각 파일 SHA-256, 빌드 호스트 glibc 기준 기록(더 오래된 배포판 지원을 약속하지 않음) | unrun |
| L03-P02 | DEB 설치 수명 | 테스트 계정·VM checkpoint에서 설치(`zenity` 의존)·메뉴 실행·재설치·제거. 제거 뒤 `~/.aiolm`/`AIOLM_HOME` 데이터 유지 정책 확인. 설치된 GUI/CLI hash 대조 | unrun |
| L03-P03 | AppImage | 실제 FUSE mount와 `APPIMAGE_EXTRACT_AND_RUN` 구분, `scripts/register-linux-desktop.py --appimage …`/`--remove`의 실행 항목·아이콘 | unrun |
| L03-P04 | 실제 업그레이드 | 실제 과거 공개 release DEB → 새 package의 설정·프로필·이력·자격 증명 보존. 합성 version 교체와 구분 | unrun |
| L03-P05 | runtime bundle | llama.cpp ZIP/tar의 실행 권한·`.so`/SONAME·`ldd`/RPATH와 새 홈 import→Ready→실제 추론, Python wheel bundle은 L02-N05 | unrun |
| L03-P06 | 내보내기 산출물 | CSV/XLSX·공유 미리보기 파일·이력 재로드가 실제 파일로 열림 | unrun |

`scripts/smoke-linux-packaged-desktop.py`와 `scripts/smoke-linux-kde.py`는 일회용 GitHub hosted runner 전용이다(`GITHUB_ACTIONS`·`RUNNER_ENVIRONMENT`를 검사). 개인 기기에서 환경 변수를 위조해 실행하지 않는다. 관리자 권한이나 사람의 OS 조작이 필요한 단계는 구체적인 테스트 계정·checkpoint와 함께 요청하고, 기다리는 동안 독립 항목을 계속한다.

### L03-U updater (Windows 마지막 작업의 Linux 회귀)

Linux in-app 업데이트는 dpkg가 실행 파일을 소유한 설치 DEB만 대상이다. 설치 파일은 검증 후 `/usr/bin/xdg-open`으로 시스템 설치 화면에 열고 사용자가 설치를 마친다. AppImage·개발 build는 릴리스 페이지 안내 대상이다(`src-tauri/src/app_update.rs`, [설치 안내](../guides/install.ko.md)). Windows의 현재 코드·binary 결과는 Linux 근거가 아니다.

| ID | 대상 | 통과 조건 | 상태 |
| --- | --- | --- | --- |
| L03-U01 | R433 진행률 핵심 로직 회귀(L01-T15) | Linux native에서 다음을 포함한 module 검사 전체: 알려진/알 수 없는 총량의 진행률 coalescing, 기본 간격 500 ms 경로, 대기 중 read의 liveness, GUI 백분율 계산(`Math.min(100, Math.floor(downloaded / total * 100))`)과 같은 표시 전환 경계, 부분 쓰기 뒤 마지막 성공 `write_all` 기준 보고와 오류 우선순위, read·write 대기 중 future drop 후 추가 callback 없음, 첫 0·최종·EOF 보고. 검사 이름과 Windows 수치는 `Windows의 최종 app_update 모듈 34개 통과. 추가한 6개 회귀는 a_download_reports_its_first_bytes_and_each_whole_percent_through_the_last_byte, a_download_reports_the_writes_that_change_the_percentage_the_settings_panel_shows, a_download_of_unknown_size_is_reported_by_time_rather_than_by_every_chunk, bytes_written_before_a_stalled_read_are_reported_once_while_it_waits_or_when_it_ends, a_failed_download_last_reports_only_bytes_that_were_written, a_dropped_download_releases_its_body_and_file_and_reports_nothing_more다. GUI 29% 경계의 실제 RED(33 pass/1 fail) 뒤 수정했고, 실제 기본 500 ms의 별도 전후 스트림 11쌍(완료 9·취소 2)으로 알림 수·확정 쓰기 바이트·SHA·drop 뒤 무알림을 비교했다. 별도 probe는 임시 측정이며 Linux가 새로 실행할 retained module 검사와 구분한다. 500 ms는 다음 read 대기의 미보고 바이트에만 적용하며 write/flush stall의 상한은 아니다` | unrun |
| L03-U02 | Linux 설치 판별 | 설치 DEB의 dpkg 소유·아키텍처 일치에서만 설치 가능, AppImage·개발 build·소유 불일치는 설치 불가 안내와 릴리스 페이지 | unrun |
| L03-U03 | GUI 안내 | 실제 WebKitGTK에서 확인·설치 가능/불가 안내·다시 확인·릴리스 페이지 이동, 진행 중 백분율 표시와 오류 | unrun |
| L03-U04 | 통제된 실제 업데이트 | 일회용 VM 또는 테스트 계정에서만, digest 또는 신뢰 checksums가 있는 실제 공개 release 사이에서 다운로드→해시 검증→xdg-open 설치 화면→사용자 완료→재실행·데이터 보존. 개인 주 계정·보호되지 않은 데이터에 설치하지 않음. 현재 source보다 새 공개 release가 없으면 그 조건으로 `blocked` | unrun |

## 9. L04 — 결함 수정·개선 루프·재검증·Mac 인계

### L04-R 결함 수정

기준선(L01–L03의 첫 실행 결과)을 `progress.md`와 결과 문서에 고정한 뒤 시작한다. 각 결함은 재현 입력·사용자 영향·원인(미확정이면 그대로)·최소 수정·회귀 검사(red→green)·실제 재검사를 남긴다. Linux가 처음 검증되는 플랫폼이므로 **기능 공백을 먼저 채우고**, 그다음 성능·UX를 다룬다.

### L04-I 개선 루프

| 단계 | 규칙 |
| --- | --- |
| 후보 | 실제 실행·코드 경로로 확인한 버그·성능·UX·가독성·구조 문제. [효율 검토의 남은 검토](efficiency-review.ko.md#남은-검토) 목록도 후보로 쓰되 정적 추정을 결함으로 확정하지 않음 |
| 측정·반증 | 같은 입력·revision의 전후 측정 또는 실패 재현. 합성 측정을 GUI 전체 지연·실제 엔진 속도로 표현하지 않음 |
| 수정 | 최소 변경. 공개 API·저장 schema·설정 형식·독립 최신성 검사·보안 검사를 보존. 책임·의존 근거 없는 대규모 폴더 이동 금지 |
| 검증 | 관련 회귀 검사, 전체 자동 검사, 영향받은 실제 GUI/엔진 재검사 |
| 기록 | 작업 단위 commit과 결과 문서의 항목 ID 연결 |

### L04-W 공통 수정의 Windows 재검증 연결

공통 코드를 바꾸면 [재검증 연결표](engine-adapter-linux-macos-handoff.ko.md#공통-수정의-이전-os-재검증-연결)에 따라 관련 Windows W/G 검사와 자동 회귀를 갱신한다. Windows 기기를 쓸 수 없으면 바뀐 경계·commit·필요한 Windows 재실행 항목을 결과 문서에 남기고, Windows pass를 만들어 쓰지 않는다.

### L04-M Mac 인계

Linux 종료 commit과 남은 항목을 고정해 Mac M01–M04와 MAC-R01–R13(§10)에 넘긴다. Mac 실제 검증은 Linux 완료 조건이 아니다.

## 10. 기존 ID 연결

| 기존 ID(문서) | 이번 Linux 항목 |
| --- | --- |
| L01(공통 인계): 같은 source의 자동 검사·GUI/CLI/package 빌드·새 help flag·Unix 경로 | L01-S·E·T·H, L03-P01 |
| L02(공통 인계): 실제 엔진·공통 기능 GUI | L02-N·F |
| L03(공통 인계): X11/Wayland desktop·Secret Service·package·bundle·export | L03-D·P·U |
| L04(공통 인계): 결함 수정·Windows 재검증·Mac 전달 | L04-R·I·W·M |
| 이전 판 L01–L11(`2c7d6d3` 기준) | L01→L01-T, L02→L02-N01·N02, L03→L02-N04, L04→L02-F02, L05→L02-F12, L06→L02-F09·F07, L07→L02-F06·F08·F10·F13, L08→L02-F11, L09→L02-N05·L03-P05, L10→L03-D·P, L11→L02-F14. 과거 ID 범위와 현재 ID를 합치지 않음 |
| 어댑터 인계 W/L01–W/L09 | L01-T·H(L01–L02), L02-F02·F05(L03), L02-F04(L04), L02-F08(L05), L02-F06·F10(L06), L02-F07·F09(L07), L01-H08·L02-F11(L08), L03-P(L09) |
| Provider native acceptance의 Linux GPU 행 | L02-N04(text/stream/usage/cancel/restart/stop, media/tools/embeddings), L02-N05(portable), L02-F07(STT), L02-F11(benchmark·deep) |
| WIN-Q01/WIN-Q02 | L02-N09(선택 대조), 원래 Windows fail 유지 |
| M01–M04, MAC-R01–R13 | L04-M 이후 Mac 작업. [Mac 추가 검증 목록](macos-device-validation-remaining.ko.md)·[복구 절차](macos-validation-recovery.ko.md). Linux 결과로 대체하지 않으며 Linux 완료 조건이 아님 |

## 11. 기록·커밋

- raw 로그·캡처·모델 정보·개인 경로: `tmp/linux-acceptance/`(커밋하지 않음).
- 진행 기록: `tmp/linux-acceptance/progress.md`(항목 ID별 현재 상태·다음 작업·blocker).
- 익명화 결과: `docs/reference/linux-device-validation-results.ko.md`(실제 실행 뒤 생성). 행마다 항목 ID, `pass/fail/unsupported/unrun/blocked`, source·runtime·model revision과 hash, 재현 절차, 원인, 수정 commit, 검사, 실제 재검사, 다음 작업·blocker를 남긴다. 개인 경로·계정·장치 일련번호·IP/PID·자격 증명·원본 사용자 기록은 넣지 않는다.
- commit은 작업 단위로 code/test/doc만 포함한다. `git status --short`로 경로를 확인하고 필요한 경로만 stage한 뒤 `git diff --cached --name-only`, `git diff --cached`, `git diff --cached --check`로 검토한다. `tmp/`·build·key·사용자 데이터는 넣지 않는다. 기존 이력을 다시 쓰지 않고 push하지 않는다.

## 12. 완료 기준

Linux 기능 검증 완료는 필수 L01–L03 항목 모두에 현재 Linux 실행의 `pass` 또는 계약 근거가 있는 `unsupported` 판정이 있고, 이번 범위의 재현 가능한 제품 결함을 수정·재검증한 때만 인정한다. 선택 대조(L02-N09)와 조건부 환경(X11/Wayland·GPU backend 등)은 실제 제공된 조건·미실행 조건을 별도로 기록한다. 필수 항목이 `fail`·`unrun`·`blocked`이면 goal을 complete로 바꾸지 않는다. 외부 조건 때문에 진행할 수 없어도 실행 가능한 독립 작업은 끝내고, 같은 차단이 연속 3개 goal turn에서 반복될 때만 blocked로 기록한다.

L04의 효율·UI/UX·가독성·구조 검토 범위와 우선순위를 기록하고, 채택한 문제의 원인·수정·회귀 검사·실제 재검사 및 작업별 commit을 연결한다. 최종 source의 관련 전체 자동 검사와 production GUI 여정을 다시 실행하고 Linux 종료 commit·Git 상태·Mac 인계를 고정해야 한다. 자동 검사 성공·합성 검사·문서 작성·일부 개선·컨텍스트/시간 한계는 전체 완료 근거가 아니다. 실행 가능한 재현 결함이나 필요한 구현이 남으면 계속한다.

## 13. 이전 판에서 이어받은 수정 위치

| 문제 | 주요 구현 위치 |
| --- | --- |
| 설치/probe/ABI/환경 | `src-tauri/src/providers/`(`python_env.rs`, `vllm_probe.py`, `portable*.py`), `src-tauri/src/runtime_archive.rs`, `src-tauri/src/runtime_elf.rs` |
| 외부 어댑터·help·schema | `src-tauri/src/providers/`(`adapter.rs`, `registry.rs`, `options.rs`), `src-tauri/src/commands/runtime_help_cmd.rs`, `src/features/runtimes/` |
| 모델/옵션/preflight | `src-tauri/src/providers/`, `src-tauri/src/commands/launch.rs`, `src-tauri/src/launch_jobs.rs`, `src/features/model-settings/`, `src/features/tuning/` |
| Hub/조각/삭제 | `src-tauri/src/discover.rs`, `src-tauri/src/discover/`, `src-tauri/src/commands/models.rs`, `src/features/discover/`, `src/features/models/` |
| 미디어/task/API | `src-tauri/src/media/`, `src-tauri/src/gateway/`, `src/features/chat/`, `src/shared/api/` |
| 측정/검증 | `src-tauri/src/performance_bench/`, `src-tauri/src/performance_memory.rs`, `src-tauri/src/verify/`, `src-tauri/src/benchmark/`, `src/features/bench/` |
| Unix/데스크톱 | `src-tauri/src/procutil.rs`, `src-tauri/src/server.rs`, `src-tauri/src/home.rs`, `src-tauri/src/tray.rs`, `src-tauri/src/mcp/`, `src-tauri/src/app_update.rs`, `scripts/` |
