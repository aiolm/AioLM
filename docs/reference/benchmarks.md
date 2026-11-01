# Benchmarks

The Benchmark screen measures local serving requests with a separate instance of
the selected inference engine: llama.cpp, vLLM or MLX. Registered external
engines cannot be benchmarked because they provide no exact tokenizer or
cold-cache procedure. Engine-specific limits are listed in
[Benchmarks and verification](inference-runtimes.md#benchmarks-and-verification).

## Public benchmark explorer and profiles

The Benchmark screen links to the localized [AioLM website](https://aiolm.vercel.app)
in the default browser. **Browse public benchmarks** opens that site's existing
explorer in a separate AioLM window, preserving its search, filters, comparisons
and detail pages without copying the website UI. The site disallows iframe
embedding, so this window loads it directly. It has no native IPC capabilities
and uses a private browsing session; external HTTPS links open in the default
browser. Closing the explorer leaves the main app running, while closing the
main app also exits its explorer.

On a result detail page, **Create profile from run settings** creates a reusable
profile from the public record's context allocation, concurrency, runtime,
recorded execution settings and supported portable launch options. The same
action is available beside a local history result. Creating a profile preserves
the current model, running sessions, profile assignments and existing profiles.
Repeated imports of the same result keep the previously created profile,
including any user edits. Import notifications remain visible in the app's
activity drawer when the Benchmark screen is hidden.

Check the local model files, GPU devices and installed runtime before applying an imported profile;
public records omit file paths, device identifiers, credentials and other private
launch options. Settings absent from older records inherit runtime defaults
rather than the viewer's current settings. The import reports unsupported options
instead of silently claiming an exact reproduction. It does not download models,
install a recorded runtime or copy benchmark workload parameters into server
settings. Measurements and benchmark conditions remain available on the detail
page.

The app only accepts import requests for public results on the official
website. Reading a public result sends no owner credentials or cookies, and the
record is checked before a profile is created from it.

## Workflow

Open the shared settings dialog from Benchmark to choose a model, runtime, GPU placement, and execution options. Applying these settings changes only the benchmark target. The default execution model and saved chat settings remain available for their own sessions. Stop running model sessions before starting a measurement; the page lists sessions that must be stopped. Select one or more prompt lengths, the output length, concurrent request counts, repetitions, and an input profile. Every input length gets a single-request baseline and each selected concurrent workload. Trials run in ascending concurrency order, and each level covers every selected input length before the next level starts: with 4,096 and 16,384 input tokens at 1x and 2x, the order is 4,096/1x, 16,384/1x, 4,096/2x, 16,384/2x. Leaving the screen does not cancel the run. Cancel stops the benchmark's engine instance and preserves trials already returned.

The settings dialog edits a draft. Cancel discards unapplied edits. Context allocation, concurrency, and sampling used by the measurement are controlled by the benchmark workload; their controls explain this constraint. The target starts from the default execution settings on first use and then remains independent. Use the explicit default-settings action to replace it with the current default execution settings.

Defaults are 4,096 and 16,384 input tokens, 128 output tokens, 2 and 4 concurrent requests, one repetition, and Python code. Every new run automatically prepares the model and warms every configured request slot before measuring; this is not a user-selectable option. Preparation is excluded from measurements, and failure or cancellation during preparation prevents measurement from starting. Concurrent request counts are separate from the runtime's token batch and microbatch settings. A workload without additional concurrent request counts runs only its single-request baseline. Results saved by older versions keep the warmup setting recorded at the time; reading, exporting or sharing an old result never changes its recorded conditions.

Each run starts its own authenticated engine instance on the local loopback interface, using a copy of the model's configuration. It sizes the context for the largest input plus output and the maximum selected concurrency; with llama.cpp, the runtime's reported slot and context settings are checked before measuring. Temporary context, concurrency, cache, and port overrides do not replace saved settings or the main server. The effective arguments and context allocation are recorded with the result.

The input profiles are original synthetic Python, mixed-language code, and Korean, English, or Japanese prose. Numbered sections repeat to produce longer inputs. They provide reproducible workloads for measuring inference performance. The engine's own tokenizer produces token IDs, which are truncated to the exact requested input length and sent without a chat template. Warmup exercises every configured slot before measurement.

Requests disable prompt-cache reuse, fix sampling, and ignore EOS to measure the requested output length. Actual input/output counts and cache accounting come from the engine's final response, never from counting streamed chunks. A shortened, truncated, cache-contaminated, or incompletely accounted response is marked as a failed trial. Every engine must provide exact tokenization, sufficient final token accounting and a cold-cache procedure; with llama.cpp these come from its `/tokenize`, `/props` and streaming `/completion` endpoints.

## Metrics

The benchmark reports timings observed by the local client, including local scheduling and transport overhead.

| Metric | Definition |
| --- | --- |
| TTFT | Time from each request's start to its first observed output token; averaged across concurrent requests. |
| TPOT | Each request's observed first-to-last output interval divided by its output count minus one; averaged across requests. |
| Input processing (Prefill / PP) · estimated, tok/s | Total input tokens divided by the interval from trial start until every request emits its first token. This is a prefill estimate based on TTFT, including queueing and transport. |
| Output generation (Decode / TG), tok/s | Total output tokens excluding each request's first token, divided by the interval from the earliest first output to the latest last output. |
| Total time, s | Wall time from trial start until all requests finish (E2E). |
| Total throughput, tok/s | Total output tokens divided by total time, including input processing (Prefill / PP). |
| Peak process RAM | Largest sampled resident memory of the benchmark's engine instance during the trial. Sampling occurs at the boundaries and approximately every 150 ms on Windows, Linux and macOS. Linux uses the lightweight procfs RSS counter, which can lag actual residency; macOS uses resident size rather than Activity Monitor's memory footprint. This is RAM, not VRAM, and brief peaks can be missed. |
| Speedup | TG rate divided by the single-request baseline with exactly the same input length, output length, and timing method. |

Unobservable metrics remain unavailable instead of becoming zero. In particular, a single output token or output delivered in one burst cannot establish a decode rate. Missing OS memory counters produce an unavailable RAM result. Failed trials do not contribute to speed averages or speedup.

Cancelling discards the in-flight trial before it is saved or emitted as a result. A concurrent trial is discarded as a whole if any request is interrupted; earlier completed trials remain available. Cancelled runs show only completed measurements in history and Excel/CSV/Markdown exports, and a cancellation with no completed measurements leaves no result entry. This also filters interrupted error rows saved by older versions when displaying or exporting them, without rewriting the original journal or a frozen publication. Legitimately unavailable metrics on a completed measurement remain unavailable.

The result table averages repeated successful trials for the same workload, shows sample standard deviation when at least two TG samples exist, and takes the maximum RAM observation. Unknown metrics remain unknown if any contributing trial lacks that measurement. Raw trials remain in saved results; exports contain the summary table. A cache-contaminated result is not a valid speedup baseline. UI, sharing summaries and exports use the same metric names as [chat response metrics](chat-metrics.md).

## History and export

History is saved in the data folder and loads in pages; see [Local history](benchmark-sharing.md#local-history). Each run includes the request, raw trial measurements, the engine and the version it reports (see [What a shared result contains](benchmark-sharing.md#what-a-shared-result-contains)), actual context and concurrency, effective arguments without credentials, available device information including the processor's thread count and, where the operating system reports it, its physical core count, and complete/partial/cancelled/failed status. Select a saved run to inspect it, export one or all runs as Excel/CSV, or copy a result as a Markdown table. Exports omit local paths and raw launch arguments. Failed runs with no measurements retain a status row in Excel/CSV. Nothing is uploaded automatically.

Use **Delete result** for the selected run. The confirmation identifies the model and measurement time; deletion removes that local result and selects a remaining run, or clears the result view when none remain. Measurement, export and publication operations disable deletion. A failed delete keeps the confirmation available for retry, while a failure to refresh after successful deletion does not restore the removed result.

A deleted result stays deleted after a restart; results imported from earlier versions do not bring it back. Deleting a local result never deletes a published result: published results and their owner keys remain available in **Shared results** (see [Managing shared results](benchmark-sharing.md#managing-shared-results)).

Results from the earlier engine benchmark are kept unchanged but are not shown as serving benchmark results.

The benchmark's engine instance is stopped on completion, cancellation, timeout, and failure. Requests have a five-minute timeout; the overall run has a thirty-minute timeout. If a trial times out, completed results are retained. Model loading and tokenization can take time before the first result appears.
