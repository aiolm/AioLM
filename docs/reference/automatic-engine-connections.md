# External engine connections

AioLM can use an inference engine other than its built-in llama.cpp, vLLM and
MLX support, as long as that engine serves an OpenAI-compatible (`/v1`) API on
your computer. The engine's implementation language does not matter. Automatic
connection is the normal way to add one; advanced manual registration remains
available for engines that need an explicit launch description.

## Connect automatically

**Inference engines** opens an inventory of all engines. Opening `llama.cpp` or
another engine browses its runtimes without changing which engine your models
use. **All inference engines** returns to the inventory with its search and
expanded details kept.

1. Open **Inference engines → Add inference engine → Find automatically**.
2. Tell the discovered items apart by their source, entry-point path and listener
   address. Select one, choose **Check selected item**, then select a model.
   A sole running server is checked automatically. A sole item from an
   installation folder is only preselected, because checking it runs the
   program; choose **Check selected item** to check it. After a failed or
   cancelled check, **Check selected item** checks it again without repeating
   discovery; full discovery is still available, for example after the process
   has restarted. Selecting among several items does not run them. If nothing is
   found, choose the engine's installation folder, not an individual executable
   or JSON file.
   If the program serves models through a command (for example
   `engine serve text`), checking it also reads the help of the commands it
   documents, with `--help` only. When several commands can serve a model,
   **Launch command** lists them with the program's own descriptions; choose
   one and **Check selected command**. The chosen command is shown above the
   model selection.
3. Choose **Connect**. AioLM registers the engine only after the selected model
   answers a chat request and completes a streaming response. Your existing
   model settings and profiles do not change; choose the new engine and model in
   a settings profile to use them.

This flow needs no JSON files or probe programs.

Discovery and registration are locked while model sessions are running, starting
or stopping, or another runtime operation owns the resources. The Add flow names
the affected sessions and offers **Open Library** to stop or cancel them. A
separate runtime-operation notice explains locks not owned by a model session.

The progress indicator identifies the operation that failed: discovery,
inspection or connection verification. A failed rediscovery does not discard an
already inspected candidate and its model selection.

### Names, options and background loading

Automatic installations are identified by their documented launch command or
attached server address, rather than an internal connection ID or an unknown
binary version. Engine names resolve on app startup without first opening engine
management or settings. Split GGUF models have one display name without the shard
counter; the original first-shard path is still used to open the model.

For an AioLM-managed connection, model settings show options from the selected
engine command's own help. Existing connections discover this help when their
settings are first opened. The executable and connection files must still match
their recorded hashes; later changes do not silently replace reviewed help.
Simple option controls use responsive columns; JSON, token lists, local paths,
repeated and multi-value editors retain full width. Use these controls or
**Import command** for documented options. Command import, preview, order,
syntax and help tools are grouped under **Command and help tools**.
**Additional launch arguments** remains directly available below the controls
and accepts undocumented options as individual literal tokens, including paths with spaces. It does not evaluate
shell syntax. Duplicate flags, documented options and app-owned model,
address, port and authentication bindings are rejected there instead of being
emitted twice. Attached servers keep their launch settings outside AioLM.

**Save profile & start** saves the profile and target, then automatically closes
the model settings dialog before engine/model checks and loading finish.
The visible background launch task shows the model and current stage with
indeterminate progress, not a guessed percentage. Closing is not cancellation:
use **Cancel** to stop that launch. A later failure retains its details and
**Review saved model settings** reopens the saved configuration for correction.

Starting an unchanged, previously verified automatic model does not first load
and unload a throwaway verification process. Changed launch options are checked
in the actual serving process too: the proxy becomes ready only after that
process passes model identity, chat and streaming checks. An explicit model
compatibility probe remains a separate verification operation and may load the
model. Changed engine files or model files require fresh model evidence.


## What a connection checks

- Discovery looks at your own processes, their listening ports and limited
  installation metadata. It does not run every executable, import modules or read
  process environments. The process and listener are checked again before
  connecting, and cancelling a check does not skip it on a later retry.
- In an installation folder, files are recognized by their executable-format
  header, never by their names. Files whose header proves they cannot start as a
  program are not listed: Windows DLLs, shared libraries, object files, core
  dumps, Mach-O libraries, Java classes and GPU code objects. On Windows only PE
  programs can be started. Items are listed with proven console programs first,
  then other launchable images (for example GUI programs or a static PIE), then
  items that cannot be started as they are; within each group, files closer to
  the selected folder come first. Folder items are listed before running servers.
- A running server must answer an OpenAI `/v1` model-list request, and the
  selected model must pass a regular chat request and a complete streaming
  response. This establishes text chat and streaming only. It confirms that
  requests reach the selected model name; it is not proof of which weight files
  the server loaded, and it does not certify images, audio, tools or answer
  quality. Each sample allows up to 1024 completion tokens so a reasoning
  model can finish thinking before its visible answer; both samples together
  must finish within 180 seconds.
- A server that was already running is attached through a local proxy owned by
  AioLM. Stopping the connection in AioLM stops the proxy and its requests and
  leaves the original server, and any container it runs in, alone.
- A stopped installation can be started by AioLM only when it has a discoverable
  entry point (or an explicitly declared interpreter) and documented, unambiguous
  arguments for the model, host and port, on the entry point itself or on one
  documented command at most three levels deep. A trial launch must confirm the
  model routing and that the listener belongs to the process AioLM started.
  The engine has up to 7 minutes to load the model and start serving. If it
  exits first, the error shows the end of the engine's own output.
- AioLM records checksums of the engine's executable, scripts and connection
  data. If those external files change, register the engine again. After an
  AioLM update, AioLM revalidates its own connection helper.

Engines that need their own protocol, credentials, ambiguous model IDs or
container creation are not connected automatically. A server already running in
a container can connect like any other local server. AioLM does not install
engines, supply engine-specific flags or manage containers.

Connecting an engine runs a program or sends requests to a local server, so
choose installations you trust.

## Advanced manual registration

**Add inference engine** also offers manual options: choose an executable or
entry point, import a connection settings file supplied with an engine adapter,
or check a complete runtime manifest. The same manifest can be registered from
the CLI:

```text
aiolm-cli runtime register-manifest <manifest.json>
aiolm-cli runtime select <custom.engine-id> <runtime-id>
aiolm-cli runtime probe <custom.engine-id> <runtime-id>
aiolm-cli runtime remove <custom.engine-id> <runtime-id>
```

Stop the headless server before registering. Registration runs the manifest's
probe; removing a registration deletes only AioLM's record, never the engine's
files or models.

In the desktop app, choosing a manifest with the native file picker grants its
canonical path for the current app session. A typed path, or another path
without that picker grant, requires native confirmation before registration;
the dialog shows the manifest path and the exact probe and launch programs and
arguments. CLI `runtime register-manifest` does not use this native approval
gate.

Importing an adapter setup recipe also uses the native file picker. The backend
retains the imported recipe and returns `{recipe, token}`; preparation requires
that session token together with the user's input values and owner identifier,
not a replacement recipe supplied by the page. Import the file again after
restarting the app.

### Runtime manifest

A manifest is a JSON file of at most 256 KiB. Unknown fields are rejected.

| Field | Meaning |
| --- | --- |
| `schema_version`, `adapter_version` | Both `1`. |
| `protocol` | `"openai-v1"`. |
| `engine_id` | `custom.` followed by a lowercase letter or digit, then letters, digits, `.`, `_` or `-`; at most 64 characters in total. Built-in engine names cannot be used. |
| `runtime_id`, `display_name` | The installation's ID and display name. An existing registration with the same engine and runtime ID is not overwritten. |
| `platforms` | The `{os, arch}` pairs the build actually runs on: `windows`, `linux` or `macos`, and `x86_64` or `aarch64`. |
| `probe`, `launch` | Each an absolute `program`, an `args` array and optional `env` and absolute `working_directory`. Arguments are passed as given; no shell is used, so do not add quoting. |
| `health_path`, `health_authenticated` | The loopback health endpoint and whether it needs the API key. |
| `model_formats` | Declared formats: `gguf`, `hf-safetensors`, `mlx` or `unknown`. A declaration does not establish that a model works. |
| `public_engine` | Optional public identity object with all six required nullable fields: `name`, `version`, `backend`, `build`, `variant`, `plugin_version`. Labels are at most 256 characters and cannot contain path separators, `:`, `@`, or ASCII control characters. Local IDs and display names are not public identity fallbacks. |
| `compute_ownership` | Optional `direct`, `descendant`, `attached`, or `unknown` declaration about compute, not permission to stop an upstream service. |
| `models` | Optional explicit `{path, name}` model entries to add to the library. AioLM does not scan folders for other files. |
| `artifacts` | Optional absolute paths of scripts, libraries and configuration the engine depends on, at most 256. Their SHA-256 is recorded at registration and checked before every use. |
| `options` | Optional settings shown in AioLM: `key`, `target` (`launch` or `request`), `kind` and optional `flag`, `group` and `runtime_default`. |
| `option_metadata` | Optional facts the engine's help text cannot show, such as which options are secret, their units, ranges and whether they need a restart. Options marked `sensitive` are hidden in previews, CLI output and benchmark records. |

`launch_bindings`, `bridge_command`, `launch_resources` and `command_layout` are
optional fields for wrappers and bridges; adapters that need them document them.

Launch arguments use these placeholders: `{model}`, `{model_alias}`, `{host}`,
`{port}`, `{api_key}`, `{ctx_size}`, `{parallel}` and `{options_json}`.
`{api_key}` is allowed only in `env`. The launch must use the port AioLM assigns.
Your settings cannot override the model, host, port or authentication.

The probe must print a single JSON object to standard output within 30 seconds
and write diagnostics to standard error. Without a model it checks the
installation; with a model it reports whether that model is supported:

```json
{
  "schema_version": 1,
  "engine_id": "custom.example",
  "runtime_id": "build-1",
  "version": "reported-build-version",
  "accelerator": "cpu",
  "model": "",
  "model_supported": false,
  "served_model": "example-model",
  "capabilities": {
    "tasks": [],
    "modalities": {"text": false, "image": false, "audio": false, "video": false},
    "chat": false,
    "tools": false
  }
}
```

When a model is given, `model` must repeat it exactly. `tasks` lists
`generate`, `embed`, `transcription` or `translate`, and `served_model` is the
name the server uses in `/v1/models` and requests. Report only capabilities the
engine actually has. A base model without a chat template can load and still
be unable to chat.

The probe can also supply `public_engine`, `compute_ownership`, and the selected
model's `model_format` (`gguf`, `hf-safetensors`, `mlx`, or `unknown`). A probe's
identity object is authoritative as a whole, including null fields; an explicit
`unknown` ownership overrides the manifest. Missing identity or ownership falls
back to the manifest, then to all-null identity or unknown ownership. A missing
selected-model format stays unknown; the manifest's supported-format inventory
is never used as selected-model evidence. Optional metadata is omitted from
stored legacy manifests and probes when absent.

`capabilities.stream_usage_supported` is an optional boolean declaration of
support for `stream_options.include_usage`; false and missing are distinct.
Automatic core API verification leaves it unknown. Metadata declarations do not
replace streaming or selected-model checks.
Normal chat requests add `stream_options.include_usage` automatically only when
this declaration is true. Unknown or false support leaves that optional field
out, while an explicit user-supplied `stream_options` value takes precedence.
Fixed-output benchmarks always request usage and require it to be reported.

`capabilities.fixed_output` is an optional, explicit opt-in naming the request
field the engine honors to generate exactly `max_tokens` tokens:
`"ignore_eos"` (sent as `true`) or `"min_tokens"` (sent as the same target as
`max_tokens`). The probe is rejected unless `stream_usage_supported` is `true`
and the manifest declares a `request` option with that key: a `flag` or
`toggle` for `ignore_eos`, or an `integer` without `choices` whose ordinary range
accepts every value from 1 through 204800 for `min_tokens`. Out-of-range
`sentinel_values` cannot fill gaps in that interval. A model without the
`generate` task does not offer it. Missing means unsupported: AioLM never infers this control from an
engine name, its help output or automatic API verification, and automatic
connections leave it absent. The declaration only lets the benchmark send the
field; every request must still report exactly the requested completion-token
count, and an early stop, overrun or missing count fails the run. Built-in
llama.cpp sessions use `ignore_eos`, built-in vLLM 0.4.0 or later uses
`min_tokens`, and vllm-metal and mlx-vlm have no fixed-output control.


Streaming verification and benchmarks require a blank-line-terminated
`data: [DONE]` SSE event. EOF or an unterminated sentinel is not completion.
LF, CRLF and CR line endings are accepted; a completed event does not require
the server to close its socket.

Direct and descendant compute are owned topology. On Unix their memory scope
is the owned process tree; on Windows only a known direct compute root can
report root-process memory. Descendant/helper compute on Windows, attached
services, and unknown compute have unavailable memory attribution. An automatic
attached proxy reports attached topology and unknown model format; its own
memory is not inference-engine memory. Owned automatic launch helpers report
descendant compute, not their proxy root.

### Creating a manifest for your own llama.cpp build

For a `llama-server` you built yourself, the repository's helper inspects the
build and writes a manifest:

```bash
python3 scripts/runtime-adapters/create_adapter.py create --kind llama.cpp \
  --engine-id custom.local-cpu --runtime-id build-1 \
  --server /absolute/path/to/llama-server \
  --model /absolute/path/to/model.gguf \
  --output /absolute/path/to/new-manifest.json
aiolm-cli runtime register-manifest /absolute/path/to/new-manifest.json
```

The output file must not exist yet. Read the generated manifest and confirm its
platform, program, arguments, artifacts and model before registering. The
helper runs no downloads, installations or inference. After changing the build
or the helper, remove the registration and register again.

### Limits

A registered engine is used for chat, projects, document search, MCP tools and
the API server to the extent its probe reports. Fixed-output benchmark admission
requires a declared output control and streamed completion-token reporting.
The catalog advertises `openai-chat-serving@2` only when declared; generated
automatic connections without that declaration remain unsupported for benchmarking.
Numerical verification against a CPU reference and portable runtime archives
remain unavailable for external engines. Unknown public identity, model format,
or compute attribution is not replaced with a built-in engine identity.

If a registration is removed or does not match the computer, AioLM keeps the
engine's saved settings and profiles but refuses to launch it; it never falls
back to llama.cpp. Register the engine again to use those settings.
