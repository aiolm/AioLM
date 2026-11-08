# Benchmarks

AioLM is a GUI adapter, not an inference engine. New measurements use
`openai-chat-serving@2`: a fixed-output workload with a declared engine control
and an exact engine-reported completion-token count for every request.
Managed llama.cpp uses `ignore_eos`; supported non-Metal vLLM uses `min_tokens`.
Registered engines must explicitly declare a matching request option and
streamed usage support. MLX, vllm-metal and undeclared/automatic connections
are refused rather than silently falling back to an output cap.

The common benchmark path does not remove a managed engine's normal OS and
hardware requirements; for example, locally managed MLX still requires Apple
Silicon macOS. An attached service follows its own host's requirements. See
[inference runtimes](inference-runtimes.md) for managed-engine platform support.

Results remain client-observed and engine-reported, not independently verified
hardware or engine rankings. Output-token equality is checked against each
request's reported completion count, not a client-side tokenizer. Missing
prompt/cache, identity and memory facts remain unknown; a missing or invalid
completion count cannot produce a successful fixed-output row.

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
**Advanced request options** contains warmup and the fixed-output requirements.

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

Choose exact input UTF-8 byte sizes, fixed output tokens, client concurrencies,
repetitions, corpus and warmup. Defaults are 4096/16384 input bytes, 1k output
tokens, concurrencies 1/2/4, one repetition, Python code and warmup enabled.
Usage reporting is required and is no longer an optional setup checkbox.

Output choices are **1k, 4k, 8k, 16k, 32k, 64k, 128k and 200k**, where k=1024
(200k=204800). Repetitions are 1, 3, 5 or 10. Both use non-editable dropdowns,
locked while measuring. The wire field `max_output_tokens` remains the request
limit and fixed target; method `@2` additionally controls termination and verifies
the result. Model context is not enlarged automatically: prompt plus output
must fit the model's context allocation, including each parallel slot's share.

Historical `openai-chat-serving@1` results remain cap-based, with their original
values through 65536 and optional usage. They are never relabelled as fixed.
The website defaults to `@2`, keeps `@1` and legacy token methods in explicit
separate scopes, and matches the exact method and
`(input_bytes, concurrency, max_output_tokens)` point. Fixed-output speed uses
reported tok/s; existing byte observations remain available.

The original synthetic Python, mixed-code and Korean/English/Japanese prose
seeds repeat in numbered sections. Each input begins with
`Continue the following text. Do not summarize or explain.\n\n`, is truncated at
a UTF-8 boundary and padded by at most three ASCII spaces to the exact byte
size. Its final bytes and SHA-256 are frozen once per run. Tokenizers, templates,
filenames, conversations, RAG, MCP and instruction files do not enter the input.

Each point sends one user message to `/v1/chat/completions`, with temperature 0,
`max_tokens=N`, streaming, `stream_options.include_usage=true` and the declared
`ignore_eos=true` or `min_tokens=N` control. Saved request defaults are not
injected. There is no engine-specific fallback or retry to a cap workload.
Before aggregation, every request must have a valid completion count equal to N.
An aggregate of N times concurrency is not sufficient. Short, excessive,
missing or invalid counts fail the whole in-flight batch; earlier completed
rows remain available. Warmup uses the same control and count check.

Native readiness accepts a configured model alias only when that launch
advertises it, then routes through the verified advertised ID. A path-based
model name is not required for an aliased native server.

The cache policy is **as configured**, not cold cache. AioLM starts and owns only
its run's child/helper. For an attached service, cancelling closes AioLM's work
and owned helper, not the upstream process/container; shared caches are not
reset. Time budgets scale with `ceil(output_tokens/1024)`: five minutes per
request and thirty minutes per run at 1k, up to 1000 minutes per request and
100 hours per run at 200k. Cancellation remains available. Each request's SSE
budget is 8 MiB plus 1024 bytes per output token (208 MiB at 200k); the 64 KiB
line/event bounds remain unchanged. Output is streamed, not retained in memory.

## Metrics

| Metric | Meaning |
| --- | --- |
| First observed output | Request start to the first nonempty content or reasoning chunk. Concurrent rows average request latencies only when every request emitted that channel. |
| First content / reasoning | The corresponding channel's first observed chunk, or unavailable when any request emitted none. |
| End-to-end time | Batch start to the last request's `[DONE]`, not socket EOF. |
| Content / reasoning / output bytes | Decoded UTF-8 bytes; output is the sum of the two channels. Tool arguments, roles and SSE framing are excluded. Content such as `<think>` is not rewritten. |
| Observed output B/s | Output bytes divided by batch end-to-end time. It is not a token/decode rate. |
| Reported tokens / tok/s | Engine-reported counters, and completion-token sum divided by end-to-end time only when every request supplied that counter. |
| Peak process RAM | Sampled RSS of explicitly owned compute. Unix process-tree RSS can count shared pages per process; Windows root RSS is used only for a known compute root. Proxy RSS is never upstream engine RAM or VRAM. |

A zero-byte completed response has known zero observed bytes and unavailable
first-output latencies. A positive-duration zero-output row has a zero byte
rate. Zero duration or a non-finite derived rate remains unavailable. Fixed
output requires its completion counter, but missing prompt/cache counters may
leave usage partial. Historical `@1` can retain missing or invalid usage with
successful byte/time observations. Counters are never inferred from chunks,
bytes, requested targets or earlier usage snapshots.

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
Local schema2 records freeze method, configured workload and input
hashes, runtime identity, model evidence, AioLM-host hardware, compute ownership,
public typed settings and a private display label. Capture masks secrets before
typed parsing. Unannotated text/JSON, credentials, local paths and machine-local
option IDs are not automatically made public. Missing metadata does not gate a
run. Settings omitted for safety or bounds are reported as omissions.
Fixed-output rows also retain `reported_completion_tokens_by_request` in
launch-slot order. Replay and publication validate every entry against the
frozen target, including partial/cancelled runs' completed rows. Old `@1`
records keep their original bound and carry no fixed-output evidence.


CSV, Excel and Markdown use the same recorded identities and serving-point
statistics. A recorded label is display-only, not a model identity; changing or
removing local files does not rewrite recorded canonical columns. Repository
revision is provenance, not a weight SHA or proof of unmodified weights.

Failed records without provenance can show their saved local model selection in
history and confirmation dialogs, but this UI label never fills canonical
export identity. If no configuration was recorded, profile import is disabled
with an associated localized explanation rather than opening a retry dialog.
Profile conversion omits out-of-bounds legacy settings independently, retaining
other safe settings, omission evidence and frozen input metadata.

Legacy local schema1 and public schema1/2 remain readable, exportable and
manageable with their original token/PP/TG/TTFT/TPOT units. Mixed exports keep
those metrics in separate Legacy columns; old snapshots, hashes and receipts
are never rewritten into byte measurements.

**Delete result** removes only the confirmed local run. Running, export and
publication operations disable deletion; failures remain retryable. Deletions
survive restart and legacy imports do not resurrect removed runs. Published runs
and owner keys remain in **Shared results**. See [history and sharing](benchmark-sharing.md)
for publication, recovery, ownership and retention policies.
