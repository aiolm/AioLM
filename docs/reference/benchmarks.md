# Benchmarks

AioLM is a GUI adapter, not an inference engine. The Benchmark screen runs the
same `openai-chat-serving@1` API workload on any connected engine that can serve
streaming text chat: llama.cpp, vLLM, MLX, registered processes and attached
services. Tokenizer, cache-reset and final usage APIs are not admission
requirements. Embedding-only, speech-only or models without a usable chat
adapter cannot serve this workload, regardless of engine name.

The common benchmark path does not remove a managed engine's normal OS and
hardware requirements; for example, locally managed MLX still requires Apple
Silicon macOS. An attached service follows its own host's requirements. See
[inference runtimes](inference-runtimes.md) for managed-engine platform support.

Results are client-observed and self-reported, not independently verified
hardware or engine rankings. Missing token, cache, identity and memory facts
remain unknown; they do not prevent a successful byte/time measurement.

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

Stop active model sessions. Open the benchmark's independent settings draft to
choose its model, runtime and launch profile. Cancel discards draft changes;
applying changes only this benchmark target, not normal chat defaults. Context,
parallel capacity, cache, GPU and thinking launch settings remain as configured.
Client request concurrency is distinct from server capacity. Common benchmark
request fields are read-only in the profile editor, while stale request
options can be explicitly cleared.

Choose exact input UTF-8 byte sizes, a maximum output-token request, request
concurrencies, repetitions, corpus, warmup and optional usage reporting. Defaults
are 4096/16384 input bytes, output cap 128, concurrencies 1/2/4, one repetition,
Python code, warmup on and usage reporting off. These are not input token
lengths. `max_tokens` is a request cap, not a guarantee that an engine generates
that many tokens. Early EOS is successful.

The original synthetic Python, mixed-code and Korean/English/Japanese prose
seeds repeat in numbered sections. Each input begins with
`Continue the following text. Do not summarize or explain.\n\n`, is truncated at
a UTF-8 boundary and padded by at most three ASCII spaces to the exact byte
size. Its final bytes and SHA-256 are frozen once per run. Tokenizers, templates,
filenames, conversations, RAG, MCP and instruction files do not enter the input.

Each point sends one user message through the selected adapter route to
`/v1/chat/completions`, with temperature 0, the output cap and streaming enabled.
Saved request defaults are not injected. Only the explicit usage checkbox adds
`stream_options.include_usage`; optional-field rejection is reported without an
engine-specific retry. Missing usage is a normal successful response. Warmup
runs the same point at the same concurrency once before timed repetitions.

Native readiness accepts a configured model alias only when that launch
advertises it, then routes through the verified advertised ID. A path-based
model name is not required for an aliased native server.

The cache policy is **as configured**, not cold cache. AioLM starts and owns only
its run's child/helper. For an attached service, cancelling closes AioLM's work
and owned helper, not the upstream process/container; shared caches are not
reset. Requests have a five-minute timeout and runs a thirty-minute timeout.

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

A zero-byte completed response has known zero output and unavailable first-output
latencies. A positive-duration zero-output row has a zero byte rate. Zero duration
or a non-finite derived rate remains unavailable. Usage can be complete, partial,
missing or invalid independently of successful byte/time measurement. Counters
are never inferred from chunks, bytes, request caps or earlier usage snapshots.

A JSON extension such as `"error": null` is not an engine error. Non-null error
objects and named SSE error events still fail the batch; successful completion
still requires `[DONE]`.

Repeated successful rows use the shared per-metric median, minimum, maximum and
sample count. Missing observations do not become zero or invalidate other known
samples. Failed batches add no partial or fabricated measurement row. Cancellation
discards the entire in-flight batch and retains previously completed rows.

## History and export

Runs are journaled in the data folder; completed batches survive interruption
and restart. Local schema2 records freeze method, configured workload and input
hashes, runtime identity, model evidence, AioLM-host hardware, compute ownership,
public typed settings and a private display label. Capture masks secrets before
typed parsing. Unannotated text/JSON, credentials, local paths and machine-local
option IDs are not automatically made public. Missing metadata does not gate a
run. Settings omitted for safety or bounds are reported as omissions.

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
