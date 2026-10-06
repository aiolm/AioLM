# CLI

> **언어:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

개발 중 `aiolm-cli.exe`는 `.codex-target/release/aiolm-cli.exe`에 생성됩니다. 패키지 빌드에서는 보조 바이너리로 포함되므로 설치 후 `aiolm.exe`와 같은 설치 디렉터리에서 찾을 수 있습니다. macOS에서는 `/Applications/AioLM.app/Contents/MacOS/aiolm-cli`(또는 `~/Applications` 아래)에 있습니다. 출력은 JSON이며 서버는 루프백 전용이고 인증 정보는 저장하지 않습니다.

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list   # `runtimes`도 별칭으로 사용 가능
./aiolm-cli.exe runtime device
./aiolm-cli.exe runtime probe <backend> <build>
./aiolm-cli.exe runtime select <backend> <build>
./aiolm-cli.exe server start   # 루프백, headless 모드에서는 API-key 인증을 사용하지 않음
./aiolm-cli.exe server status
./aiolm-cli.exe server logs [lines]
./aiolm-cli.exe server stop
./aiolm-cli.exe server unload  # stop의 별칭
./aiolm-cli.exe server restart
./aiolm-cli.exe doctor
```

## 처음 시작하기

데스크톱 앱에서 런타임을 설치하거나 가져온 다음, `runtime list`의 백엔드·빌드를 선택하고 모델을 설정하세요. `runtime select`는 두 식별자를 함께 검증·저장하며 잘못된 선택은 기존 설정을 바꾸지 않습니다. 서버 시작에는 선택한 관리형 런타임이 필요합니다. Linux/macOS에서는 `.exe` 없이 `./aiolm-cli`를 사용하세요.

```powershell
./aiolm-cli.exe runtime list
./aiolm-cli.exe runtime select cpu <installed-build>
./aiolm-cli.exe config set models_dir "C:\Models"
./aiolm-cli.exe config set active_model "C:\Models\model.gguf"
./aiolm-cli.exe server start
```

- `config set`은 자격 증명과 알 수 없는 필드를 거부합니다.
- `config set`은 현재 실행 설정을 씁니다. 앱에서 같은 엔진의 공용 프로필을 적용하면 해당 프로필의 실행 옵션을 사용하며, 선택한 모델과 런타임 설치는 유지됩니다. CLI만 사용하는 흐름에서는 설정한 값이 그대로 `server start`에 쓰입니다.
- `config get`은 자격 증명처럼 보이는 값을 가립니다. `server_args`, `chat_options`, `lora_adapters`는 설정 시 JSON 값이 필요합니다.
- `models delete`는 `models_dir` 내부의 비활성 `.gguf`/`.mmproj` 파일과 앱 소유 모델 스냅샷을 삭제할 수 있습니다. 스냅샷 목록에 없는 사용자 파일을 보존하고 실행 중 모델과 보조 모델의 삭제를 차단합니다.

- `runtime device`는 로컬 GPU와 권장 백엔드를 검색하고, `runtime probe`는 버전/help/device/bench 사전 점검을 실행합니다.
- `server start`는 설정된 모델을 사용하고 `127.0.0.1`에 바인딩하며 API-key 인증을 의도적으로 끕니다. 신뢰할 수 있는 컴퓨터에서만 사용하고 포트를 외부에 노출하거나 전달하지 마세요.
- 표준 출력은 JSON이며 서버 로그 크기는 제한됩니다.

[security.ko.md](../policies/security.ko.md)에서 인증 및 프로세스 경계를 확인하세요.

## Python 엔진 런타임

`runtime export <vllm|mlx-vlm> <런타임 ID> <새 번들.zip>`은 설치된 엔진에 필요한 정확한 버전의 휠과 플랫폼·ABI·해시를 내보냅니다. `runtime import <번들.zip>`은 로컬 휠만 사용해 새 격리 환경에 설치하고 검사합니다. 대상 기기에 호환되는 기본 Python이 필요하며, 모델은 별도로 관리합니다. 실행 중인 헤드리스 서버를 먼저 중지하세요. Ctrl-C는 미완료 작업을 정리하며, 내보내기는 기존 파일을 덮어쓰지 않습니다.

`config set provider_options '<JSON>'`은 엔진별 옵션 맵 전체를 교체합니다. `config get`으로 기존 값을 읽어 다른 엔진의 항목을 보존한 뒤, `{"vllm":{"max_model_len":8192},"mlx-vlm":{"temperature":0.7}}` 같은 객체를 셸 인수 하나로 전달하세요. 잘못된 옵션이나 알 수 없는 옵션은 저장된 설정을 변경하지 않으며, `{}`는 전체 맵을 지웁니다. 모델과 설치된 런타임에 대한 검사는 실행 전에 진행됩니다.

vLLM은 Linux 또는 vllm-metal을 통해 Apple Silicon macOS 15+에서, mlx-vlm은 Apple Silicon macOS에서 실행합니다. 지원되는 Mac에서 `runtime install vllm`은 vLLM/vllm-metal 0.30.0 휠과 네이티브 arm64 Python 3.12를 사용합니다. `runtime list`에 Python 런타임도 표시됩니다. `runtime install <vllm|mlx-vlm> [Python 실행 파일]`로 격리 설치하거나 `runtime register <vllm|mlx-vlm> <Python 실행 파일>`로 기존 환경을 등록한 뒤, `runtime select <vllm|mlx-vlm> <런타임 ID>`로 선택합니다. `runtime probe`와 `runtime remove`에도 같은 엔진명과 ID를 사용합니다. 기존 환경 제거는 Python과 패키지를 보존하며, 설치 중 Ctrl-C는 미완료 격리 환경을 정리합니다. 모델 형식과 옵션은 [추론 런타임](../reference/inference-runtimes.md)을 참고하세요.
