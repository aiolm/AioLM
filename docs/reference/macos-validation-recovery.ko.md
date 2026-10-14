# Mac 미디어 검증의 복구 도구와 옵션

이 문서는 [Mac 결과 §101](macos-device-validation-results.ko.md#101-미디어-내용과-도구-후속-답변의-추가-원인-검증)의 재현된 문제를 별도 환경에서 복구하는 절차다. 원본 모델·설치 환경은 변경하지 않는다. 관리형 설치의 기본 upstream 버전도 그대로 유지한다. 도구 실행 성공은 실제 모델 응답의 내용 검증을 대신하지 않는다.

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
| mlx-vlm `0.7.6` | `0.7.6+aiolm.media7` | 기존 media5의 URI·audio 이력·preflight·Gemma4 padding 수정에 Gemma3n media prefill의 텍스트 embedding 배율과 공유 KV 쿼리 위치 수정 추가. context overflow의 기존 기록/400 유지. |

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
"$NEW_PYTHON" scripts/provider-compatibility/check_gemma4_audio_packing.py
"$NEW_PYTHON" scripts/provider-compatibility/check_gemma3n_embeddings.py
```

첫 검사는 모델 추론 없이 설치된 normalizer/template의 audio marker가 `[1,0,1]`인지 확인한다. 두 번째는 작은 합성 encoder/embedding 값으로 **설치된 Gemma4의 실제 embedding 배치 메서드**를 호출한다. 녹음 사이 padding이 다음 녹음의 토큰을 대체하면 실패하며, 모델 weights·내용 추론이나 처리 속도 검사는 아니다. 앱의 런타임 관리에서 새 Python을 외부 환경으로 등록하고 **별도 프로필**로 선택한다. 올바른 인증으로 URI/invalid-WAV400, 정상 미디어 내용·usage·취소·Retry·재시작·종료를 실제 확인한다. 원본 환경/프로필을 자동 교체하지 않는다.

세 번째는 실제 Gemma3n 메서드를 작은 텐서로 호출해 텍스트 prefill 배율과 concrete/shared attention의 쿼리·키 위치를 비교한다. 단일 및 길이가 다른 두 입력의 batched cache에서 prefill/decode를 검사한다. 원본0.7.6은 배율 검사, 배율만 수정한 media6은 공유 위치 검사에서 실패했다. media7은 네 cache 조건을 통과했다. **같은 원래4bit 모델의 전사 단수·복수 오류는 실제 앱에서도 남았다.** checker 성공을 내용 성공으로 바꾸지 않는다.

## llama.cpp의 Idefics3 단일 이미지

`prepare_llama_source.py`는 Python3.12에서 명시한 원본 archive를 읽고 새 디렉터리에만 소스를 준비한다. 대상은 llama.cpp b11460의 전체 commit `78651c410dd8d97e3e22e533e0e7117889e3863a`다. [고정 소스 archive](https://codeload.github.com/ggml-org/llama.cpp/tar.gz/78651c410dd8d97e3e22e533e0e7117889e3863a)의 관찰한 SHA-256은 `3261e7f33becb7ada614605116f96222fc097f016b48cd627e01055f1535f981`이다. 이 값은 내려받은 바이트를 고정하는 감사 기록이며 별도의 vendor 서명 증명이 아니다.

Idefics3 공식 처리기는 한 장의 view에 row/column tile을 추가하지 않는다. 해당 native 경로는 같은 작은 이미지에 overview와 tile을 모두 넣었다. 준비 도구는 grid가1×1일 때 중복 tile과 tile 구분 개행을 제거한다. 다른 projector·여러 tile의 분기는 유지한다. archive와 수정할 두 소스의 해시·문맥을 검사하며 다른 revision·기존 출력 디렉터리를 거부한다. 원본 archive·weights·projector·LICENSE를 보존하고 수정 전후 해시를 `aiolm-source-compatibility.json`에 기록한다.

```sh
python3 -B scripts/provider-compatibility/prepare_llama_source.py \
  --archive "$TASK_LLAMA_ARCHIVE" --output-directory "$TASK_LLAMA_OUTPUT"
```

새 소스의 해당 OS CPU 빌드에는 `llama-server`, `llama-bench`, `llama-perplexity`, `llama-mtmd-cli`를 포함한다. `LLAMA_BUILD_NUMBER=11460`, `LLAMA_BUILD_COMMIT=78651c410-aiolm.single1`로 local 수정을 표시하고 공식 runtime을 덮어쓰지 않는다. 배포 가능한 번들을 만들 때 빌드 경로를 remap하고 OS에 맞는 상대 library search path를 설정한다. 필수 실행 파일·공유 라이브러리·LICENSE·audit와 실제 OS/architecture·전체 파일 해시를 기존 portable manifest 계약으로 묶어 앱의 **Import runtime ZIP**으로 검사한다. Mac 검증의 build ID는 `local_b11460_single1`, backend는 `cpu`다. Windows/Linux는 해당 OS에서 빌드와 실제 앱 검사를 다시 수행해야 한다.

같은 원래 SmolVLM256M Q8_0와 f16 projector는 이 CPU 빌드, 대화의 **첨부를 질문보다 먼저 전달**, 전용 프로필의 아래 일반 지침에서 원래 질문의 색상·도형·좌우와 후속 오른쪽 물체 설명을 정확히 답했다.

```text
List every visible object with its position, color, and geometric shape. Do not omit requested attributes.
```

이 지침에는 fixture의 색상·도형·정답을 넣지 않았다. 기존 Default나 다른 모델의 지침을 바꾸지 않는다. 지침이 없는 원래 질문에서는 요청 항목 누락이 남고, 해당 초기 부분 답변 뒤의 후속 설명도 오답이었다. 검증한 프로필/대화 조건의 성공을 모든 입력·모델의 정확성 보장으로 확장하지 않는다.

## MCP 관찰값의 모델 전달 형식

단일 MCP text block이고 다른 내용·metadata가 없는 결과는 모델의 tool 메시지에 `{"text":"실제 반환값"}`으로 전달한다. 명시한 `isError` boolean은 유지한다. 여러 block·이미지·structuredContent·annotations·알 수 없는 필드는 기존 JSON을 그대로 유지한다. native RPC 결과를 수정하지 않으며 승인·거부·취소·call ID와 기존 원본 크기 제한을 유지한다. 동일 Qwen3 2B 가중치의 직접 대조에서 중첩 envelope는 입력을 반복했지만 이 형식은 서로 다른 세 반환값을 정확히 읽었다. 실제 앱 승인→도구→후속 답변의 판정은 [결과 §102](macos-device-validation-results.ko.md#102-원래-모델을-유지한-잔여-오류-검증)를 따른다.

## 자동 시스템 안내 선택

대화 설정의 **지침이 비어 있으면 자동 시스템 안내 사용**은 기본적으로 켜져 있다. 끄면 대화·실행 프로필·개인화 지침이 모두 비었을 때만 자동 `You are a helpful assistant.` system message를 생략한다. 사용자가 쓴 지침은 유지한다. 선택은 대화와 함께 저장되며 기존 대화의 기본 동작은 유지한다.

같은 Gemma4 weights/processor의 직접 추론에서도 긴 오디오 질문은 이 자동 system message에 따라 실패했다. 공식 Google template는 system 역할을 지원하며 canonical template 교체로도 해결되지 않았다. 이를 engine 전체의 system 미지원으로 처리하거나 모든 사용자 지침을 삭제하지 않는다. §100에서는 옵션을 끈 짧은 전사/후속 전사만 정확했고 긴 부분 응답 뒤의 후속 전사는 실패했다. §101의 별도 Gemma4 프로필은 `enable_thinking=true`, `max_tokens=1024`, `max_kv_size=4096`, temperature/seed0을 사용했다. 같은 첫 녹음의 긴 답변과 후속 전사가 정확했고, media5에서 다른 길이의 새 녹음과 앱 재시작 후 첫 녹음 재전사도 정확했다. 해당 모델/환경/프로필의 결과이며 다른 모델의 기본 지침이나 출력 설정을 변경하는 근거가 아니다.

## 첨부와 질문의 순서

대화 설정의 **첨부를 질문보다 먼저 전달**은 기본적으로 꺼져 있다. 켜면 첨부 묶음을 질문 앞에 보내며 같은 대화의 이력에도 적용한다. 이미지·오디오·샘플 영상 프레임/시각 설명·전사문의 첨부 순서를 유지한다. 명시적 선택은 빈 대화에서도 저장하고 정상 재시작 후 복원한다. Retry는 실패한 요청의 기존 snapshot을 그대로 사용한다. 기존 대화·API/adapter canonical messages·다른 모델의 기본 순서는 바꾸지 않는다.

실제 b11460 CPU/SmolVLM500M의 같은 이미지와 질문은 text-first에서 오답, image-first에서 정확했다. 위 옵션으로 실제 앱의 이미지 내용/좌우 위치를 확인했다. 고정 SmolVLM256M은 native CLI와 공식 원본에서도 실패했으므로 500M 성공을 256M 통과로 계산하지 않는다.

Qwen3-VL4B는 전체 weight 해시가 동일한 파생 index와 vLLM의 `enable_auto_tool_choice=true`, `tool_call_parser=hermes`를 사용한 별도 프로필에서 실제 MCP 호출·Mac 승인·반환값 후속 답변을 통과했다. parser 이름은 대소문자를 구분한다. 기존 2B의 실패와 Gemma3n의 단수/복수 오류는 아직 남아 있다.

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
