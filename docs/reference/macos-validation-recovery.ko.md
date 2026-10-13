# Mac 미디어 검증의 복구 도구와 옵션

이 문서는 [Mac 결과 §100](macos-device-validation-results.ko.md#100-남은-4개-fail의-원인-수정과-실제-앱-재검증)의 재현된 문제를 별도 환경에서 복구하는 절차다. 원본 모델·설치 환경은 변경하지 않는다. 관리형 설치의 기본 upstream 버전도 그대로 유지한다. 도구 실행 성공은 실제 모델 응답의 내용 검증을 대신하지 않는다.

## safetensors 인덱스의 파생 snapshot

공개 Gemma3n snapshot은 실제 단일 quantized weight의 tensor 이름과 다른 shard 인덱스를 제공했다. `reindex_snapshot.py`는 각 weight 전체 SHA-256과 dtype·shape·byte 범위·중복 tensor를 검사하고 **새 디렉터리**에 실제 파일에 맞는 인덱스를 만든다. 누락된 weight를 생성하거나 tensor 값을 수정하지 않는다.

CPython 3.12 이상에서, 모든 실제 weight 파일의 신뢰할 수 있는 전체 해시를 지정한다. 아래 값은 사용자가 확인한 경로·해시로 바꾼다.

```sh
python3 scripts/model-repair/reindex_snapshot.py \
  --source "$SOURCE_SNAPSHOT" --output "$NEW_DERIVED_SNAPSHOT" \
  --weight-sha256 "model.safetensors=$EXPECTED_WEIGHT_SHA256"
```

분할 weight는 `--weight-sha256`을 파일마다 반복한다. 기존 출력은 교체하지 않는다. 취소·오류 때 이번 staging만 정리한다. 원본 인덱스는 `source-index.json`, 인덱스/weight 해시와 작업 정보는 `aiolm-index-repair.json`에 보관한다. weights와 tokenizer/processor/template 및 라이선스·저작권 공지를 복사한다. `.aiolm-snapshot.json`은 복사하지 않으며 파생 폴더를 원본 Hub revision이나 관리형 다운로드로 가장하지 않는다.

새 폴더를 앱에서 선택해 artifact 검사·runtime probe·실제 load·내용/usage·취소/재시작을 확인한다. ABI·processor·모델 품질 실패는 여전히 실패다. 이번 Gemma3n은 load에 성공했으나 전사에서 단수/복수 오류가 남았다.

## 별도 호환 wheel

`build_wheel.py`는 선택한 upstream wheel의 전체 SHA-256과 알려진 소스 문맥을 확인한다. 새 local version/dist-info/RECORD와 `aiolm_compatibility.json`을 생성하며 원본 wheel·라이선스·native 파일 속성을 보존한다. 서명된 wheel은 거부한다. 기존 출력도 교체하지 않는다.

| 기반 버전 | 새 버전 | 수정 내용 |
| --- | --- | --- |
| vLLM `0.30.0+cpu` | `0.30.0+cpu.aiolm.media1` | local media allowlist 거부를 validation 오류로 분류해 HTTP400 반환. allowlist 유지. |
| mlx-vlm `0.7.6` | `0.7.6+aiolm.media4` | `file:` media400, user별 audio marker 배치, stream preflight 오류/취소의 in-flight 정리, 오디오 decoder의 알려진 invalid-format 오류400. context overflow의 기존 기록/400 유지. |

```sh
python3 scripts/provider-compatibility/build_wheel.py \
  --provider vllm --wheel "$UPSTREAM_WHEEL" \
  --source-sha256 "$EXPECTED_WHEEL_SHA256" --output-directory "$NEW_WHEEL_DIRECTORY"
```

MLX에는 `--provider mlx-vlm`을 사용한다. 입력/출력 디렉터리는 실제 별도 경로로 선택한다. 검증한 Mac arm64 입력 SHA-256은 vLLM `fd9adfd566a8afa4ecbdf36b04bab10ebf43cd9ca18eca4b0a0bf2013b8de135`, MLX `17fad1745e6c43dc0fd4d3b8593967b29928a1da5dbf6f781ca783922f68115d`다. 이는 다른 플랫폼 wheel을 허용하는 값이 아니다.

새 native arm64 CPython3.12 venv에 기존 검증 환경의 정확한 dependency freeze를 설치한 뒤, 새 wheel만 `--no-deps`로 설치한다. 검증에서는 로컬 wheel cache로 offline 재구성했다. 예:

```sh
uv pip freeze --python "$SOURCE_PYTHON" > "$DEPENDENCY_FREEZE"
uv venv --python "$NATIVE_PYTHON_312" "$NEW_VENV"
uv pip install --python "$NEW_PYTHON" --no-index \
  --find-links "$VERIFIED_WHEEL_CACHE" --requirement "$DEPENDENCY_FREEZE"
uv pip install --python "$NEW_PYTHON" --no-deps "$COMPATIBILITY_WHEEL"
uv pip check --python "$NEW_PYTHON"
```

vllm-metal0.30.0은 기존 pinned MLX/MLX-LM/native paged ops와 MetalPlatform 요구사항을 모두 유지한다. 앱은 위 **특정** local core의 provenance와 설치된 connector SHA-256을 새 probe로 검사한 뒤 등록한다. 다른 local suffix나 변조 파일은 거부한다. 임의 엔진은 [공통 manifest/adapter](pluggable-inference-runtimes.ko.md)로 등록한다. MLX의 설치된 오디오 이력 검사:

```sh
"$NEW_PYTHON" scripts/provider-compatibility/check_mlx_audio_history.py
```

이 검사는 모델 추론 없이 실제 설치된 normalizer/template의 audio marker가 `[1,0,1]`인지 확인한다. 앱의 런타임 관리에서 새 Python을 외부 환경으로 등록하고 **별도 프로필**로 선택한다. 올바른 인증으로 URI/invalid-WAV400, 정상 미디어 내용·usage·취소·Retry·재시작·종료를 실제 확인한다. 원본 환경/프로필을 자동 교체하지 않는다.

## 자동 시스템 안내 선택

대화 설정의 **지침이 비어 있으면 자동 시스템 안내 사용**은 기본적으로 켜져 있다. 끄면 대화·실행 프로필·개인화 지침이 모두 비었을 때만 자동 `You are a helpful assistant.` system message를 생략한다. 사용자가 쓴 지침은 유지한다. 선택은 대화와 함께 저장되며 기존 대화의 기본 동작은 유지한다.

같은 Gemma4 weights/processor의 직접 추론에서도 긴 오디오 질문은 이 자동 system message에 따라 실패했다. 공식 Google template는 system 역할을 지원하며 canonical template 교체로도 해결되지 않았다. 이를 engine 전체의 system 미지원으로 처리하거나 모든 사용자 지침을 삭제하지 않는다. 옵션을 끈 실제 앱에서 짧은 전사와 후속 전사는 정확했으나 긴 부분 응답 이후의 후속 전사는 여전히 실패했다. 모델별 검증이 필요하다.

## 회귀 검사와 대상 OS 인계

```sh
python3 -B -m unittest discover -s scripts/model-repair -p 'test_*.py'
python3 -B -m unittest discover -s scripts/provider-compatibility -p 'test_*.py'
python3 -B src-tauri/src/providers/vllm_probe_tests.py
npm run typecheck
npm run lint
npm test
npm run build
```

Rust 전체 타깃/feature·fmt/clippy 명령은 [OS 인계](runtime-adapter-handoff.ko.md)를 따른다. Windows/Linux는 실제 기기에서 새 옵션 저장/재로드·명시적 지침 보존·지원 미디어/도구 내용을 재검증한다. Mac 전용 wheel이나 이 Mac의 답변을 Windows/Linux 성공 근거로 사용하지 않는다. 공개 업로드·원격 push 없이 원본 실패 로그를 보존한다.
