# Benchmarks

The Benchmark screen measures local serving requests with a dedicated `llama-server`.

## Workflow

Choose a model directly in Benchmark and open Model settings to select its runtime, GPU placement, and execution options. Applying these settings changes only the benchmark target. The default execution model and saved chat settings remain available for their own sessions. Stop running model sessions before starting a measurement; the page lists sessions that must be stopped. Select one or more prompt lengths, the output length, concurrent request counts, repetitions, and an input profile. Every input length gets a single-request baseline and each selected concurrent workload. Leaving the screen does not cancel the run. Cancel stops the dedicated server and preserves trials already returned.

The settings dialog edits a draft. Cancel discards unapplied edits. Context allocation, concurrency, and sampling used by the measurement are controlled by the benchmark workload; their controls explain this constraint. The target starts from the default execution settings on first use and then remains independent. Use the explicit default-settings action to replace it with the current default execution settings.

Defaults are 4,096 and 16,384 input tokens, 128 output tokens, 2 and 4 concurrent requests, one repetition, Python code, and warmup enabled. Concurrent request counts are separate from the runtime's token batch and microbatch settings. A workload without additional concurrent request counts runs only its single-request baseline.

The runner clones the model's configuration and starts an authenticated server on an OS-assigned loopback port. It explicitly sizes the context for the largest input plus output and the maximum selected concurrency. It checks the runtime's reported slot and context settings before measuring. Temporary context, concurrency, cache, and port overrides do not replace saved tuning or the main server. The effective arguments and context allocation are recorded with the result.

The input profiles are original synthetic Python, mixed-language code, and Korean, English, or Japanese prose. Numbered sections repeat to produce longer inputs. They provide reproducible workloads for measuring inference performance. The runtime's tokenizer produces token IDs, which are truncated to the exact requested input length and sent to `/completion` without a chat template. Warmup exercises every configured slot before measurement.

Requests disable prompt-cache reuse, fix sampling, and ignore EOS to measure the requested output length. Actual input/output counts and cache accounting come from the runtime's final response, never from counting streamed chunks. A shortened, truncated, cache-contaminated, or incompletely accounted response is marked as a failed trial. Runtimes must provide `/tokenize`, `/props`, streaming `/completion`, and sufficient final token accounting.

## Metrics

The benchmark reports timings observed by the local client, including local scheduling and transport overhead.

| Metric | Definition |
| --- | --- |
| TTFT | Time from each request's start to its first observed output token; averaged across concurrent requests. |
| TPOT | Each request's observed first-to-last output interval divided by its output count minus one; averaged across requests. |
| PP tok/s | Total input tokens divided by the interval from trial start until every request emits its first token. This is a prefill estimate based on TTFT, including queueing and transport. |
| TG tok/s | Total output tokens excluding each request's first token, divided by the interval from the earliest first output to the latest last output. |
| E2E | Wall time from trial start until all requests finish. |
| Total tok/s | Total output tokens divided by E2E, including input processing. |
| Peak process RAM | Largest sampled resident working set of the dedicated server during the trial. Sampling occurs at the boundaries and approximately every 150 ms on Windows. This is RAM, not VRAM, and brief peaks can be missed. |
| Speedup | TG rate divided by the single-request baseline with exactly the same input length, output length, and timing method. |

Unobservable metrics remain unavailable instead of becoming zero. In particular, a single output token or output delivered in one burst cannot establish a decode rate. Missing OS memory counters produce an unavailable RAM result. Failed trials do not contribute to speed averages or speedup.

The result table averages repeated successful trials for the same workload, shows sample standard deviation when at least two TG samples exist, and takes the maximum RAM observation. Unknown metrics remain unknown if any contributing trial lacks that measurement. Raw trials remain in saved results and CSV. A cache-contaminated result is not a valid speedup baseline.

## History and export

History stores the newest 20 runs in local browser storage. Each run includes the request, raw trial measurements, runtime version, actual context and concurrency, effective arguments without credentials, available device information, and complete/partial/cancelled/failed status. Select a saved run to inspect it or export the history to CSV. Failed runs with no measurements also have a CSV row. Nothing is uploaded automatically.

Legacy engine history remains in local storage; it is not deleted, converted, or displayed as serving benchmark results.

The dedicated server is cleaned up on completion, cancellation, timeout, and failure. Requests have a five-minute timeout; the overall run has a thirty-minute timeout. If a trial times out, completed results are retained. Model loading and tokenization can take time before the first result appears.
