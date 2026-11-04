# llama-server options

GPU layers use an explicit **app default of 99**, shared by the display, reset, new configuration, server launch and benchmark launch. Context size uses the existing **app default of 4096** for the display, reset, new configuration and server launch. Both values are labeled as app defaults; newer llama.cpp builds describe their own upstream GPU behavior as `auto` and context default as `0`. Other inherited settings continue to use the selected runtime's defaults. CPU thread/slot controls represent automatic counts as `0`; manually setting context size to `0` still uses the model's context.

**Reset to default** restores an option's default in the working draft; saving the profile makes the change permanent, and discarding the draft keeps the saved value. A reset option shows the selected runtime's default (or its documented reference), including in configurations saved by older app versions. Resetting raw aliases also clears their dedicated-field mirrors. An editable catalog argument is initialized from its known scalar default.

Numeric draft GPU defaults remain numeric when stored in the string-valued draft control. Reasoning preservation follows each runtime's reported policy: `enabled` → `on`, `disabled` → `off`, or template-dependent → `auto`. Genuine automatic defaults include an explanation rather than an invented fixed number.

Each setting displays its llama.cpp CLI signature (including aliases), the request JSON key where applicable, and the upstream default even while a custom value is being edited. Defaults from the selected executable's help take precedence. Model-dependent defaults and sentinel explanations are preserved; a missing default is explicitly marked as unspecified instead of substituting an old form value. Reference-only defaults are labeled and linked to their source. Request-only settings show their JSON key without inventing CLI flags. The catalog shows defaults even when an entry is collapsed.

The request-only defaults for `n_probs`, `min_keep`, `t_max_predict_ms` and `id_slot` are checked against the pinned upstream source linked in the UI. The prediction time limit's reference default is `-1`; both `-1` and `0` disable the limit. Deprecated memory switches show the default of `--load-mode` when the runtime delegates to it.

Open **Model settings**, choose the runtime, select a profile, then adjust its options in the same dialog. Runtime options come from the selected executable's `--help`. The option controls and **Direct input** are two views of the same draft. Direct input preserves argument order, repeated options and values containing spaces. Changes are saved through the profile controls rather than through a second per-option save flow.

Model loading and memory options such as mmap, mlock, DirectIO, load-mode, lazy-mode, NUMA, cache RAM, KV/operation offload, repacking, automatic fitting and SWA appear when reported by that runtime. Defaults are inherited by omitting an override; the reference catalog does not impose defaults from another version. Other engines use their own discovered schema instead of the llama.cpp field catalog.

## Numeric limits and special values

Temperature controls sampling randomness, not a probability. Values above `1` are valid; the app retains its `0–2` slider policy rather than incorrectly limiting it to `1`. The selected runtime's contract still takes precedence over the offline reference.

| Control | Guided input and meaning |
| --- | --- |
| Top-k | `0` disables filtering; positive values limit the candidate pool. |
| Keep tokens | `-1` retains the entire initial prompt; `0` remains the app's default. |
| Repetition penalty | Strictly positive; `1` is neutral. Positive values smaller than the slider step remain valid typed input. |
| Repeat and DRY windows | Nonnegative in the pinned request schema; `0` disables the corresponding window. `-1` is not advertised as a context-sized repeat window. |
| Idle sleep | `-1` disables sleep; positive seconds enable it. `0` is rejected by the supported launch parser. |
| Context size | `0` uses the model context; explicit positive sizes start at `512` under the existing app policy. This minimum is not an upstream llama.cpp limit. |
| Batch and microbatch | An explicit microbatch cannot exceed an explicit batch. Inherited settings retain their runtime-default markers instead of being clamped against stale raw placeholders. |

Guided edits and command imports reject values that would otherwise be silently changed on save, including fractional integer settings. Projects preserve context `0` and Keep `-1`. Benchmark imports validate the final batch pair, using a known destination runtime default when only microbatch is imported; an unknown default is reported as an omission rather than guessed.

Existing advanced numeric overrides are displayed as stored and are not rewritten by opening or blurring the editor. Editing a request option also clears competing aliases, so a hidden canonical Mirostat or completion-token key cannot override the visible edit. Slider increments do not impose a rounding requirement on typed values.

These rules were checked against the pinned [request schema](https://github.com/ggml-org/llama.cpp/blob/fa6769818708afd9807b22183ccda112fd563427/tools/server/server-schema.cpp), [sampler validation](https://github.com/ggml-org/llama.cpp/blob/fa6769818708afd9807b22183ccda112fd563427/common/sampling.cpp), and [launch argument parser](https://github.com/ggml-org/llama.cpp/blob/fa6769818708afd9807b22183ccda112fd563427/common/arg.cpp).


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
& (Join-Path $HOME '.aiolm\runtimes\<build>-<backend>\llama-server.exe') --help |
  Select-String -Pattern 'DEPRECATED' -Context 0,2
```

The runtime help is authoritative, including options from custom PR builds. If the runtime cannot be queried, the app explicitly identifies the offline reference catalog as unverified. It includes all 255 option entries from the [upstream generated server help at fa6769818708afd9807b22183ccda112fd563427](https://github.com/ggml-org/llama.cpp/blob/fa6769818708afd9807b22183ccda112fd563427/tools/server/README.md), plus the older mmap, mlock and DirectIO switches. Current upstream uses `--load-mode`; older builds expose separate switches. Option availability depends on the executable and backend.

Dedicated model, adapter, GPU, context and reasoning controls remain the owners of their corresponding flags. The shared model settings dialog edits these values as a draft until the user saves the profile or saves and starts it. Local binding and ephemeral authentication are managed by the application. Commands that print information and exit (`--help`, `--version`, etc.) are not persistent startup settings.

Options are saved as server arguments with the profile, so existing configuration files, execution profiles and project snapshots keep them. Correct invalid input before switching between guided controls and **Direct input**. Direct input provides the server-argument and chat-JSON editors without a second editable copy on screen.

Benchmark capture metadata does not make additional flags app-managed.
Ordinary runtime tunings such as `--top-k` retain their saved overrides and
argument order.

Benchmarks launch the selected engine through the common adapter path using its configured launch profile. Workload controls do not override context size, parallel capacity, cache, GPU or thinking settings. AioLM still manages the run's local server binding and authentication; see [Benchmarks](benchmarks.md) for the workflow and recorded configuration.
