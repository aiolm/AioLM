# llama-server options

GPU layers use an explicit **app default of 99**, shared by the display, reset, new configuration, server launch and benchmark launch. Context size uses the existing **app default of 4096** for the display, reset, new configuration and server launch. Both values are labeled as app defaults; newer llama.cpp builds describe their own upstream GPU behavior as `auto` and context default as `0`. Other inherited settings continue to use the selected runtime's defaults. CPU thread/slot controls represent automatic counts as `0`; manually setting context size to `0` still uses the model's context.

Reset discards saved manual values and pending drafts. Reopening a dedicated control starts from the selected runtime's default (or its documented reference), including configs saved by older app versions. Resetting raw aliases also clears their dedicated-field mirrors. An editable catalog argument is initialized from its known scalar default.

Numeric draft GPU defaults remain numeric when stored in the string-valued draft control. Reasoning preservation follows each runtime's reported policy: `enabled` → `on`, `disabled` → `off`, or template-dependent → `auto`. Genuine automatic defaults include an explanation rather than an invented fixed number. Numeric display/reset agreement is checked for every dedicated numeric control and advanced sampler in `tuningResetValues.test.ts`.

Each setting displays its llama.cpp CLI signature (including aliases), the request JSON key where applicable, and the upstream default even while a custom value is being edited. Defaults from the selected executable's help take precedence. Model-dependent defaults and sentinel explanations are preserved; a missing default is explicitly marked as unspecified instead of substituting an old form value. Reference-only defaults are labeled and linked to their source. Request-only settings show their JSON key without inventing CLI flags. The catalog shows defaults even when an entry is collapsed.

The request-only defaults for `n_probs`, `min_keep`, `t_max_predict_ms` and `id_slot` are checked against the pinned upstream source linked in the UI. The prediction time limit's reference default is `-1`; both `-1` and `0` disable the limit. Deprecated memory switches show the default of `--load-mode` when the runtime delegates to it.

Tuning → **All server options** lists the selected executable's `--help` output. It supports flag aliases, positive/negative switches, values, repeated occurrences and arguments containing spaces. Search accepts names with spaces, underscores or hyphens (for example, `m map`). **Configured** filters explicit server arguments. Each option can be saved or reset independently. Changes take effect on the next server start; a running server uses **Apply & restart**.

Tuning → **Context & memory** also includes model loading and memory options: mmap, mlock, DirectIO, load-mode, lazy-mode, NUMA, cache RAM, KV/operation offload, repacking, automatic fitting and SWA, when reported by that runtime. Defaults are inherited by omitting an override; the reference catalog does not impose defaults from another version.

## Options removed or renamed upstream

Saved `server_args` survive a runtime upgrade, so an argument a newer build no longer accepts stops the server before it becomes ready, with `error: invalid argument: <flag>` as the first log line. Value editors offer the documented values for `--load-mode`, which the runtime help lists as prose rather than in its signature.

The raw argument editors take one option per line with its value after a space (`--load-mode none`). The runtime parser wants the flag and each value as separate process arguments and rejects `--flag=value`, so a line is split by the option's arity rather than by whitespace: everything after the flag is a single value unless the runtime's help says the option takes more, which keeps a path containing spaces intact. Only `--control-vector-layer-range START END` takes two. A value on a switch, or a missing value, is reported while editing instead of at launch.

The loading switches were folded into one `-lm, --load-mode MODE` option. They are still accepted, as deprecated aliases, in `b10840`; they are gone in `b11026`, where only the replacement is parsed.

| Removed switch | Replacement | Meaning |
| --- | --- | --- |
| `--mmap` | `--load-mode mmap` | memory-map the weights |
| `--no-mmap` | `--load-mode none` | read the weights instead of mapping them |
| `--mlock` | `--load-mode mlock` | keep the weights resident in RAM |
| `--mmap --mlock` | `--load-mode mmap+mlock` | both of the above |
| `-dio`, `--direct-io` | `--load-mode dio` | use DirectIO where supported |
| `-ndio`, `--no-direct-io` | `--load-mode auto` | the default: mmap unless a device cannot use it |
| `LLAMA_ARG_MMAP`, `LLAMA_ARG_MLOCK`, `LLAMA_ARG_DIO` | `LLAMA_ARG_LOAD_MODE` | environment form of the same setting |

Two more upstream changes keep the older spelling working, so saved arguments containing them do not need editing: `--webui`/`--no-webui` are aliases of `--ui`/`--no-ui`, and `-dt, --defrag-thold` is marked deprecated in both builds while remaining parsable.

Each runtime's own `--help` remains authoritative. To check one installed runtime for options it no longer accepts:

```powershell
& (Join-Path $env:APPDATA 'aiolm\runtimes\<build>-<backend>\llama-server.exe') --help |
  Select-String -Pattern 'DEPRECATED' -Context 0,2
```

The runtime help is authoritative, including options from custom PR builds. If the runtime cannot be queried, the app explicitly identifies the offline reference catalog as unverified. It includes all 255 option entries from the [upstream generated server help at fa6769818708afd9807b22183ccda112fd563427](https://github.com/ggml-org/llama.cpp/blob/fa6769818708afd9807b22183ccda112fd563427/tools/server/README.md), plus the older mmap, mlock and DirectIO switches. Current upstream uses `--load-mode`; older builds expose separate switches. Option availability depends on the executable and backend.

Dedicated model, adapter, GPU, context and reasoning controls remain the owners of their corresponding flags. The shared model settings dialog edits these values without saving until Apply. The server port is an application setting under Settings → Server and takes effect on the next launch. Local binding and ephemeral authentication are managed by the application. Commands that print information and exit (`--help`, `--version`, etc.) are not persistent startup settings.

Catalog changes use the existing config save queue and `server_args`, so existing configuration files, execution profiles and project snapshots retain them. An unsaved raw argument draft must be saved or reset before individual catalog entries can be changed. The raw server-argument and chat-JSON editors remain available under **Advanced / raw**.

Benchmarks use the selected model's server configuration to launch a dedicated `llama-server`. Workload controls temporarily override context size, concurrent slots, prompt-cache reuse, and the loopback port. Other compatible tuning and memory options remain server arguments. These temporary overrides do not change saved settings; see [Benchmarks](benchmarks.md) for the workflow and recorded configuration.

To refresh the checked-in reference catalog from an upstream commit or tag:

```powershell
node scripts/sync-server-options.mjs <commit-or-tag>
```

The generated file records the resolved commit and source URL. Review the diff when updating. The runtime reader continues to discover new options without requiring a catalog update.
