# 개발

> **언어:** [English](development.md) | [한국어](development.ko.md) | [日本語](development.ja.md) | [中文](development.zh.md)

## 요구사항

- Windows 10/11 x64
- Node `22.23.2` / npm `12.0.2` (`.node-version`, `package.json#engines`)
- Rust `1.98.0` + `rustfmt`/`clippy` (`rust-toolchain.toml`)
- Tauri v2 사전 요구사항
- 스모크 테스트용 `llama-server.exe` 또는 관리형 런타임
- PR 빌드: 백엔드별 CMake + 툴체인/SDK (`cuda`→CUDA Toolkit, `vulkan`→Vulkan SDK, `rocm`→HIP SDK + `hipcc`)

툴체인을 올릴 때는 `.node-version`와 `package.json#engines`를 함께 수정하고, `rust-toolchain.toml`, `src-tauri/Cargo.toml#rust-version`, `.github/workflows/{ci,release}.yml`의 `toolchain:`도 함께 수정하세요.

## 클론 및 실행

```bash
git clone https://github.com/joowon-jang/AioLM.git aiolm
cd aiolm
npm install
npm run tauri -- dev
# 런타임: %APPDATA%/aiolm/runtimes/{build}-{backend}/
```

## 검증

폴더별 역할과 의존성 규칙은 [소스 구조 안내](../reference/architecture.md)를 참고하세요.
직접 실행하는 Node 테스트는 `tests/direct`에, 컴포넌트와 훅 테스트는 해당 소스 옆에 둡니다.

```bash
npm test              # 직접 스크립트 + Vitest 커버리지
npm run typecheck
npm run build
npm run lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml

# 단일 Vitest 파일
npm run test:ui -- <path>
```

### 실제 모델 smoke 테스트 (선택)

PowerShell:

```powershell
cd src-tauri
$env:AIOLM_SMOKE = "1"
$env:AIOLM_SMOKE_MODEL = "C:\path\to\model.gguf"
cargo test --test smoke -- --ignored --nocapture --test-threads=1
```

Bash / Git Bash:

```bash
cd src-tauri
AIOLM_SMOKE=1 AIOLM_SMOKE_MODEL='C:/path/to/model.gguf' cargo test --test smoke -- --ignored --nocapture --test-threads=1
```

`npm test`는 `test:run-direct-tests` + `test:direct` + `test:coverage`(`vitest run --coverage`)를 실행합니다.

## 패키징

```bash
npm run package:tauri
# -> .codex-target/release/bundle/nsis/ , .../msi/
```

설치 파일은 `aiolm-cli.exe`를 Tauri 보조 바이너리로 포함해 `aiolm.exe` 옆에 설치하므로
패키징 전에 `npm run build:cli`가 실행되어야 합니다. `npm run package:tauri`가 이를 함께 수행합니다.
CLI를 `bundle.resources`에도 등록하면 같은 파일이 두 번 설치되어 MSI 빌드가 WiX ICE30으로 실패합니다.

패키징은 `scripts/package-tauri.mjs`를 거치므로 cargo가 빌드 머신의 홈, Cargo,
rustup, 작업 폴더에 대한 rustc `--remap-path-prefix` 플래그와 함께 실행됩니다.
이 플래그가 없으면 rustc는 `aiolm.exe`와 `aiolm-cli.exe`의 모든 패닉 위치에
빌드한 사람의 절대 경로를 새겨 넣습니다. 플래그는 실행 시점에 해당 디렉터리에서
계산해 이미 설정된 `RUSTFLAGS` 뒤에 덧붙이므로 머신마다 다른 경로가 저장소에
남지 않습니다. Cargo의 `trim-paths` 프로필 옵션도 같은 일을 하지만 아직 나이틀리
전용이라 고정된 1.98.0 툴체인은 이를 거부합니다. `npx tauri build`를 직접
실행하면 경로 치환이 적용되지 않습니다.

같은 스크립트가 `lzma-sys` 같은 크레이트가 `cc`로 컴파일하는 C 소스에 `NDEBUG`를
정의합니다. `--remap-path-prefix`는 이 경로에 닿지 못하기 때문입니다. MSVC는
`assert()`를 `_wassert(..., __FILEW__, ...)`로 확장하므로, 그대로 두면 xz 소스가
빌드한 사람의 절대 경로를 와이드 문자열로 새겨 넣습니다. **따라서 패키징된 빌드는
포함된 C 라이브러리의 내부 assert가 제거된 상태로 동작합니다.** 이는 C 코드의 표준
릴리스 구성이며, 정의는 패키징 스크립트에서만 설정하므로 `cargo test`,
`cargo clippy`와 모든 개발 빌드는 assert를 그대로 유지합니다. 기존 `CFLAGS`와
`CXXFLAGS`는 `CFLAGS_x86_64-pc-windows-msvc` 같은 타깃별 변형을 포함해 교체하지
않고 뒤에 덧붙입니다.

`AIOLM_BENCHMARK_API_URL`은 네이티브 빌드 시점에 읽혀 패키지 앱의 벤치마크 공유
서비스를 결정합니다. 설정하지 않으면 익명 게시가 비활성화된 빌드가 만들어지고,
검토·내보내기·대기열은 그대로 동작합니다. 게시를 활성화하려면 루트 HTTPS 원본을
지정합니다.

```powershell
$env:AIOLM_BENCHMARK_API_URL = "https://benchmarks.example.com"
npm run package:tauri
```

Windows 릴리스 워크플로는 이 값을 `AIOLM_BENCHMARK_API_URL` 저장소 변수에서
가져옵니다. 릴리스 빌드가 사용할 수 없는 값이 설정되면 `cargo test`가 실패하므로,
게시가 조용히 비활성화된 설치 파일이 만들어지지 않습니다.
