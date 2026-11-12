# CLI

> **언어:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

`aiolm-cli`는 설치 파일에 보조 바이너리로 포함됩니다. Windows에서는 `aiolm.exe`와 같은 설치 디렉터리에서 `aiolm-cli.exe`를 찾을 수 있습니다. [소스에서 빌드](install.ko.md#소스에서-빌드)했다면 `.codex-target/release/`에도 있습니다. macOS에서는 `/Applications/AioLM.app/Contents/MacOS/aiolm-cli`(또는 `~/Applications` 아래)에 있습니다. 출력은 JSON이며 서버는 루프백 전용이고 인증 정보는 저장하지 않습니다.

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>  # 타입이 지정된 비밀이 아닌 값만 허용
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list   # `runtimes`도 별칭으로 사용 가능
./aiolm-cli.exe runtime discover [folder]
./aiolm-cli.exe runtime connect <candidate-id> <model-id> [folder] [--command <word>]...
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
- `config set`은 저장 전에 변경 후 설정 전체를 검증합니다. 두 배치 크기를 모두 명시했다면 `ubatch_size`는 `batch_size`를 넘을 수 없습니다. 둘 다 줄일 때는 `ubatch_size`부터 낮추세요.
- `config get`은 자격 증명처럼 보이는 값을 가립니다. `server_args`, `chat_options`, `lora_adapters`는 설정 시 JSON 값이 필요합니다.
- `models delete`는 `models_dir` 내부의 비활성 `.gguf`/`.mmproj` 파일과 앱 소유 모델 스냅샷을 삭제할 수 있습니다. 스냅샷 목록에 없는 사용자 파일을 보존하고 실행 중 모델과 보조 모델의 삭제를 차단합니다.

- `runtime device`는 로컬 GPU와 권장 백엔드를 검색하고, `runtime probe`는 llama-server의 버전/help/device 사전 점검을 실행하고 선택 도구인 llama-bench의 동작 여부를 함께 보고합니다. llama-bench가 없거나 실패해도 사전 점검은 실패하지 않습니다.
- `server start`는 설정된 모델을 사용하고 `127.0.0.1`에 바인딩하며 API-key 인증을 의도적으로 끕니다. 신뢰할 수 있는 컴퓨터에서만 사용하고 포트를 외부에 노출하거나 전달하지 마세요.
- 표준 출력은 JSON입니다. `server logs`는 최신 1 MiB에서 요청한 줄 수만 선택합니다. 매번 추가할 때 파일을 다시 쓰지 않도록, 로그 파일이 2 MiB를 넘으면 최신 1 MiB만 남깁니다.

[security.ko.md](../policies/security.ko.md)에서 인증 및 프로세스 경계를 확인하세요.

## 외부 엔진 연결

`runtime discover [folder]`는 현재 사용자의 로컬 모델 API를 찾고, 폴더를 지정하면 해당 설치 폴더의 진입점도 찾습니다. 후보 프로그램은 실행하지 않습니다. JSON 보고서에는 `candidates`(각 후보의 `id`, `display_name`, `source`, `entrypoint_kind`, `endpoints`, `state`), `warnings`, `truncated`가 포함됩니다.

`runtime connect <candidate-id> <model-id> [folder] [--command <word>]...`는 후보를 다시 검색하고 검사한 뒤, 선택한 모델의 채팅 및 스트리밍 응답을 검증하고 등록을 저장합니다. 검색 결과의 후보 ID를 사용하고, 폴더를 지정해 검색했다면 같은 폴더를 전달하세요. 폴더 설치의 모델 ID는 설정된 모델 카탈로그에 있는 로컬 모델 경로이며, 실행 중인 API에는 해당 서버가 제공하는 모델 ID를 사용합니다. 연결 과정에서 프로그램을 실행하거나 로컬 서버에 요청을 보낼 수 있으므로 신뢰하는 설치만 선택하세요. 연결 전에 헤드리스 서버를 중지하세요.

문서화된 서빙 명령을 선택하려면 단어마다 `--command`를 반복하세요. 예를 들어 `--command serve --command llm`을 사용합니다. 서빙 명령이 여러 개라면 오류에 선택지가 표시되므로, 그중 하나를 지정해 연결을 다시 실행하세요. 등록은 선택한 런타임이나 모델을 변경하지 않습니다.

고급 수동 등록에는 `runtime register-manifest <manifest.json>`을 사용합니다. 버전이 지정된 외부 프로세스 어댑터를 검사하고 등록하며, 엔진 파일은 외부에 그대로 둡니다. 등록 전에 헤드리스 서버를 중지하세요. 반환된 엔진·런타임 ID를 명시적으로 선택하고 `runtime probe`로 현재 활성 모델을 정확히 검사하세요.

```text
aiolm-cli runtime register-manifest <manifest.json>
aiolm-cli runtime select <custom.engine> <runtime-id>
aiolm-cli runtime probe <custom.engine> <runtime-id>
```

검증 세부 사항은 [외부 엔진 연결](../reference/automatic-engine-connections.md)을, 매니페스트 형식은 [고급 수동 등록](../reference/automatic-engine-connections.md#advanced-manual-registration)을 참고하세요.

## Python 엔진 런타임

`config set provider_options '<JSON>'`은 엔진별 옵션 맵 전체를 교체합니다. `config get`으로 기존 값을 읽어 다른 엔진의 항목을 보존한 뒤, `{"vllm":{"max_model_len":8192},"mlx-vlm":{"temperature":0.7}}` 같은 객체를 셸 인수 하나로 전달하세요. 잘못된 옵션이나 알 수 없는 옵션은 저장된 설정을 변경하지 않으며, `{}`는 전체 맵을 지웁니다. 모델과 설치된 런타임에 대한 검사는 실행 전에 진행됩니다.

선택된 런타임의 항목(빌드를 선택한 `llama.cpp`와 등록된 `custom.*` 엔진 포함)은 설정 창과 같은 옵션 스키마로 검사합니다. 기본 제공·manifest 옵션, 해당 런타임의 검토된 도움말 옵션, 그 도움말에 대해 사용자가 확인한 값 개수와 반복 여부, 그리고 명령줄 순서와 항목별 표기를 보존하는 `@option_order` 기록이 포함됩니다. 더 새로운 앱이 만든 기록이나 저장값과 맞지 않는 기록은 거부됩니다.

vLLM은 Linux 또는 vllm-metal을 통해 Apple Silicon macOS 15+에서, mlx-vlm은 Apple Silicon macOS에서 실행합니다. 지원되는 Mac에서 `runtime install vllm`은 vLLM/vllm-metal 0.30.0 휠과 네이티브 arm64 Python 3.12를 사용합니다. `runtime list`에는 네이티브 설치와 등록된 Python 설치가 포함됩니다. 고정 버전 엔진을 설치하거나 기존 인터프리터를 등록한 뒤, 반환된 런타임 ID를 선택하고 완전한 로컬 모델 스냅샷을 선택하세요. 외부 환경 제거는 인터프리터와 패키지를 보존하며, 관리형 설치 중 Ctrl-C는 설치를 취소하고 미완료 환경을 제거합니다.

일반 관리형 vLLM(Metal 제외)·mlx-vlm 패키지 설치는 의존성까지 바이너리 휠만 사용하며 소스 빌드로 대체하지 않습니다. 호환 휠이 없으면 안전상의 이유를 안내하고 설치를 중단합니다. 대신 외부 환경을 직접 준비하고 인터프리터를 등록할 수 있습니다. Mac의 vLLM 설치는 위에서 설명한 별도의 버전이 맞는 Metal 휠 설치 방식을 사용합니다.

```text
aiolm-cli runtime install <vllm|mlx-vlm> [python-executable]
aiolm-cli runtime register <vllm|mlx-vlm> <python-executable>
aiolm-cli runtime select <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime probe <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime remove <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime export <vllm|mlx-vlm> <runtime-id> <new-bundle.zip>
aiolm-cli runtime import <bundle.zip>
```

엔진별 모델 파일, 옵션과 프로필은 [추론 런타임](../reference/inference-runtimes.md)을 참고하세요.

내보내기는 설치된 엔진의 전체 의존성에 대해 정확한 버전의 휠을 다운로드하고 플랫폼·ABI·해시를 보존합니다. 가져오기는 해당 휠을 오프라인으로 새 환경에 설치하고 검사합니다. 호환되는 기본 Python 인터프리터가 이미 설치되어 있어야 합니다. 모델은 별도로 관리합니다. 내보내기·가져오기 전에 헤드리스 서버를 중지하세요. Ctrl-C는 미완료 작업을 정리하며, 내보내기는 기존 대상 파일을 보존합니다.
