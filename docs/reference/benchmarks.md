# Benchmarks

AioLM is a GUI adapter, not an inference engine. New measurements use
`openai-chat-serving@5`: the same Cold Prompt output-cap streaming chat workload
for built-in, manually registered and automatic engine connections. Streamed
usage support is optional. Text-chat, generate-task, chat-template and
input-modality requirements still apply.

The common benchmark path does not remove a managed engine's normal OS and
hardware requirements; for example, locally managed MLX still requires Apple
Silicon macOS. An attached service follows its own host's requirements. See
[inference runtimes](inference-runtimes.md) for managed-engine platform support.

Results remain client-observed and engine-reported, not independently verified
hardware or engine rankings. Early completion, zero-byte completed output and
missing or invalid usage reports are valid observations. Unreported token,
identity and memory facts remain unknown. A request cap does not prove engine
compliance, and reported completion counts are not inferred or clamped to it.

## Public benchmark explorer and profiles

**Browse public benchmarks** opens the localized AioLM website's explorer in a
separate, unprivileged window. It preserves search, comparisons and details
without embedding a privileged native bridge. External HTTPS links open in the
default browser. Closing the main application also closes its explorer.

**Create profile from run settings** is available for local and public runs.
Choose the destination engine/runtime, review the compatible launch settings
and omissions, then confirm. Cancel changes nothing. Matching uses target,
exact scope, public option name, type, unit and semantic role; similar-looking
context controls are not assumed interchangeable. Request entries explain the
measurement method and are not copied into profiles.

Imports do not choose models, files, GPU IDs or installations, restore private
connection IDs, append arbitrary source flags or fill missing values from the
current profile. Reimporting a source into the same destination preserves the
existing profile and user edits. A run with no restorable settings requires an
explicit default-profile confirmation. Public imports use the official website
without owner credentials or cookies.

## Workflow

On a wide workspace, the setup form sits beside the results; a narrow window
stacks setup above results. Trial count, progress, Run/Cancel and blocking
reasons stay above the setup so long runtime labels do not hide the primary
action. Profile, engine and runtime stay visible; **Key settings** and
**Hardware** expand to show launch values and host specifications. Input-size
and concurrency rows summarize their selected values and expand for editing.
The workload section shows the fixed output cap and Cold Prompt input-isolation policy.

The result toolbar keeps history selection and copy visible. **Export and
manage** expands inline for export format, selected/all-history export, profile
creation and deletion. Recorded model identity, status and measurement method
belong to the selected result, not the current setup draft. Result tables scroll
horizontally within their own keyboard-accessible area. Run configuration,
effective arguments and metric explanations start collapsed; public review and
owned-result management follow the result. Opening a review does not publish it.

Stop active model sessions. Open the benchmark's independent settings draft to
choose its model, runtime and launch profile. Cancel discards draft changes;
applying changes only this benchmark target, not normal chat defaults. Context,
parallel capacity, cache, GPU and thinking launch settings remain as configured.
Client request concurrency is distinct from server capacity. Common benchmark
request fields are read-only in the profile editor, while stale request
options can be explicitly cleared.

Run stays disabled while target support is being checked, is unknown or is
unsupported. The check uses existing target metadata rather than starting an
engine; **Configure benchmark target** opens the normal model/runtime workflow
when verification or a different runtime is needed. A supported reply for an
older target cannot enable the current one.

Accepting refreshed runtime options under **Key settings** repeats the support check for the selected target. The target, workload and saved settings remain unchanged; this never starts a benchmark automatically.

Choose exact input UTF-8 byte sizes, client concurrencies and corpus.
Input sizes and concurrencies are always-visible checkbox chips. Input choices
are 1K, 4K, 16K, 64K, 256K and 1M UTF-8 bytes (K=1024, M=1024K), and the
benchmark page labels input sizes in K/M; concurrency choices are 1, 2, 4 and 8. Defaults are
4K/16K input bytes, concurrencies
1/2/4 and Python code. No measured-workload warmup is sent. Optional streamed token usage is requested
when supported; valid unsolicited reports are preserved too.

Every new run requests **at most 128 output tokens** and measures each
input/concurrency point once (`repetitions: 1`). Neither value is a setup control;
the setup shows the output cap as a read-only fact. The local
`max_output_tokens` field is the request limit, not an exact output target.
Model context is not enlarged
automatically: prompt plus output must fit the model's context allocation,
including each parallel slot's share.

The shared cap range is 1–128. Desktop runs require cap 128, one repetition
and concurrency at most 8. Public comparison uses the same single method and
exact `(input_bytes, concurrency, max_output_tokens)` operating point.

Corpus version 2 reuses the synthetic Python, mixed-code and Korean/English/
Japanese prose seeds with per-request input isolation. A fresh cryptographically
random UUIDv4 without hyphens is recorded as the run's 32-hex `prompt_nonce`.
Each prompt starts with `alphabet[slot] + SHA256(nonce:bytes:concurrency:repetition:slot) + "\n"`,
using decimal tuple numbers and the 64-character alphabet
`ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_` (zero-based slots).
This 66-byte ASCII prefix is followed by corpus1 text for the remaining bytes,
including its instruction and numbered sections, UTF-8 truncation and ASCII padding.
Distinct leading slot characters prevent identical-input batching; the run and
point digest prevents long measured-input prefixes from being reused across
points or runs. Total input bytes include the prefix.

`inputs[].sha256` identifies the actual first prompt for each size at the lowest
selected concurrency, repetition 1, slot 0. Every row records the actual
`input_sha256_by_request` in launch-slot order; no prompt hash can repeat across
the completed grid. The recorded nonce and corpus2 algorithm reproduce all
inputs. Tokenizers, templates, filenames, conversations, RAG, MCP and instruction
files do not enter the user input.

Each point sends five required top-level fields to `/v1/chat/completions`:
`model`, one user `messages` entry, `temperature: 0`, `max_tokens: 128` and
`stream: true`. Optional `stream_options: { "include_usage": true }` is negotiated
on the first actual measured batch.
There is no separate usage-check inference. A known false support declaration
omits the field from the start. If every request in that first batch is rejected
with HTTP 400/422, the batch may be resent once without the usage field, and all
subsequent requests omit it. Mixed accepted/rejected requests fail the batch;
accepted observations are never discarded and replayed as a fallback.
The submitted run request may ask for usage, but frozen provenance records the
effective `workload.request_usage` and matching request descriptors: true with the
exact usage descriptor, or false without it. No reports are fabricated when an
engine accepts the field but sends no counters.
The model is launched once per run with normal readiness verification. Readiness
may infer with unrelated inputs; it never receives the fresh measured prompts.
Loading and readiness are excluded from measurement timing. `warmup` must be
false; no measured prompt is sent before its measured batch. This is
Cold Prompt input isolation, not cold-start or cold-kernel measurement. Attached
and unknown external services remain supported without resetting their caches.
No `ignore_eos`, `min_tokens` or saved request defaults are injected. There are
no forced-generation controls, general per-point retries, engine-specific
calibration or cap fallbacks. Only the initial all-400/422 usage rejection permits
the resend described above.
HTTP errors outside the optional-field negotiation, SSE errors, malformed response
events, timeout and EOF before `[DONE]` fail the in-flight batch; earlier completed
rows remain available.

Native readiness accepts a configured model alias only when that launch
advertises it, then routes through the verified advertised ID. A path-based
model name is not required for an aliased native server.

The cache policy is **cold_prompt**, meaning the input-isolation procedure above,
not independent proof of an engine's internal cache state.
AioLM owns only its run's child/helper. For an attached service, cancelling closes
AioLM's work and owned helper, not the upstream process/container. Requests have
a five-minute timeout and an 8 MiB SSE budget; the entire run has a thirty-minute
timeout. The existing 64 KiB line/event
bounds remain unchanged. Cancellation remains available. Output is streamed,
not retained in memory.

## Metrics

| Metric | Meaning |
| --- | --- |
| First observed output (TTFT, ms) | Mean request start to first nonempty content or reasoning byte; unavailable if any slot emits no output. |
| Prompt processing per request (Prefill, tok/s) | Mean of `1000 × reported prompt tokens / first-output ms`; each slot needs positive prompt usage and first-output time. |
| Generation speed per request (Decode, tok/s) | Mean of `1000 / slot TPOT`; needs at least two reported completion tokens and positive post-first-output duration in every slot. |
| Time per output token (TPOT, ms) | Mean of `(request E2E − first output) / (reported completion tokens − 1)`; request E2E ends at its `[DONE]`. |
| Total token throughput (tok/s) | Batch reported completion-token total divided by batch E2E in seconds. |
| Output throughput (B/s) | Batch decoded UTF-8 output bytes divided by batch E2E in seconds; includes content and reasoning, not tool arguments or framing. |
| End-to-end time (E2E, ms) | Batch start to the last request's `[DONE]`, not socket EOF. |
| Peak process RAM (bytes) | Sampled RSS of owned compute process-tree members; summed RSS may count shared pages more than once, and attached/unknown compute remains unavailable. |

The three per-request token metrics need engine-reported usage and stay
unavailable without it. A missing slot input or non-finite result makes that
metric unavailable for the row. Invalid usage clears all three derived metrics.
Raw output bytes and prompt/completion counts remain evidence, not display or
export metrics. Counters are never inferred from chunks, bytes, caps or earlier
usage snapshots. A completed zero-byte response has no first-output observation;
with a positive batch duration it has known zero byte throughput.

A JSON extension such as `"error": null` is not an engine error. Non-null error
objects and named SSE error events still fail the batch; successful completion
still requires `[DONE]`.

Repeated successful rows use the shared per-metric median, minimum, maximum and
sample count. Missing observations do not become zero or invalidate other known
samples. Failed batches add no partial or fabricated measurement row. Cancellation
discards the entire in-flight batch and retains previously completed rows.

## History and export

Runs are journaled after execution admission; completed batches survive interruption
and restart. Validation, unsupported-target rejection or cancellation before a
measurement starts does not create an empty failed result or invalidate existing
sharing permits. Genuine failures after measurement starts remain recordable.
Local schema3 records freeze method, configured workload and input
hashes, runtime identity, model evidence, AioLM-host hardware, compute ownership,
public typed settings and a private display label. Capture masks secrets before
typed parsing. Unannotated text/JSON, credentials, local paths and machine-local
option IDs are not automatically made public. Missing metadata does not gate a
run. Settings omitted for safety or bounds are reported as omissions.
Replay requires the nonce, unique request input hashes and first-point descriptor
consistency. Provenance uses schema3; public submissions use schema4.


CSV, Excel and Markdown use the same recorded identities and serving-point
statistics, including corpus, cache policy and prompt nonce for reproducibility.
The full native record and public JSON retain every actual request hash; aggregate
spreadsheet reports are not raw trial dumps. A recorded label is display-only, not a model identity; changing or
removing local files does not rewrite recorded canonical columns. Repository
revision is provenance, not a weight SHA or proof of unmodified weights.

Failed records without provenance can show their saved local model selection in
history and confirmation dialogs, but this UI label never fills canonical
export identity. If no configuration was recorded, profile import is disabled
with an associated localized explanation rather than opening a retry dialog.
Profile conversion retains safe settings and omission evidence.

Pre-cutover journals stay untouched on disk but are hidden from history and
excluded from pagination totals. Direct operations on them reject the
unsupported record. Browser history uses a new storage key and does not import
older browser records.

**Delete result** removes only the confirmed local run. Running, export and
publication operations disable deletion; failures remain retryable. Deletions
survive restart. Published runs
and owner keys remain in **Shared results**. See [history and sharing](benchmark-sharing.md)
for publication, recovery, ownership and retention policies.
