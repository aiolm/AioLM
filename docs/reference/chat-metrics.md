# Chat response metrics

Each new assistant response shows two rows with token count, duration in seconds,
and rate in tokens per second. Measurements update during streaming and
remain attached to the response in conversation history.

| Stage | Token count | Duration | Rate |
| --- | --- | --- | --- |
| Input processing (Prefill / PP) | Server `timings.prompt_n`, excluding cached tokens | Server `timings.prompt_ms` | Server `timings.prompt_per_second` |
| Output generation (Decode / TG) | Server `timings.predicted_n`, including reasoning tokens | Server `timings.predicted_ms` | Server `timings.predicted_per_second` |

Compact rows display PP/TG. Their accessible names and tooltips use the same
localized phase names as benchmark tables, sharing and exports. Benchmark PP is
explicitly an estimate; chat PP uses runtime phase timings.

When a server rate is missing, AioLM divides the corresponding stage's token count
by its duration. Usage fields can supply the TG count from `completion_tokens`,
or the PP count from `prompt_tokens` minus a known cached-token count. The cache
count comes from `timings.cache_n` or `usage.prompt_tokens_details.cached_tokens`.
Missing, invalid, or unobservable values display as `—`. Zero counts and durations
remain zero; a zero duration cannot supply a calculated rate. Counts are never
estimated from response text.

The response also shows these details:

- **Time to first token (TTFT):** time from starting the chat request to the first
  nonempty text, reasoning, or tool name/arguments received by the client.
- **Preparation time:** time spent preparing the send before starting the chat
  request, including server wake-up and document retrieval.
- **Request time:** elapsed client time from starting the chat request to its
  completion or interruption; it updates on streamed events while active.
- **Cached tokens:** the server-reported prompt tokens reused from cache.

PP/TG durations and rates use server phase measurements. Preparation and client
request timing do not enter those calculations.

Live generation status is separate from the measured PP/TG rows:

- **Preparing request** covers local send preparation, including server wake-up,
  media preparation, personalization and document retrieval.
- **Input processing (Prefill / PP) · waiting for the first token** begins when
  the chat request starts. It includes transport and server queue time: the chat
  API does not provide a separate event proving when server-side prefill starts.
- **Output generation (Decode / TG)** begins on the first nonempty answer,
  reasoning, or tool name/arguments. Empty role frames and statistics alone do
  not establish generated output. Disabling streamed text buffers the answer,
  not the generation status; Decode remains visible while output is buffered.

The composer and active empty assistant bubble use the same phase labels.
Preparation appears only in the composer, not on the previous reply. Historical,
completed and interrupted replies never acquire the current request's progress.
The expandable thinking-process section contains actual reasoning output; it
does not indicate that input processing is still running.

Partial responses retain measurements on Stop or a connection failure. A reply
stopped before any output remains marked interrupted with its retry context.
Retrying starts fresh measurements. An MCP request
keeps its measurements while awaiting approval; its follow-up replaces them with
the final answer request's measurements, without adding tool execution or approval
wait time. The turn continues to use its original session and settings snapshot.

The composer status distinguishes an MCP approval request, native tool execution
(including its OS approval wait), a failed request, an interrupted response, and
a completed response. Once a tool returns, the follow-up model request starts a
new Prefill/first-token wait before Decode. Stop remains available during tool
execution and each in-flight model phase.
A saved assistant request with `finish_reason: tool_calls` is incomplete after
reload; opening its history does not approve or execute the tool. A saved user
message without an assistant response shows only the message count. A token-limited response
keeps its limit notice; message count alone does not establish completion.

Chat requests default to `timings_per_token: true` and
`stream_options.include_usage: true`. Explicit `false` values in chat JSON are
honored. These defaults apply only to the request body and do not change saved
settings or unapplied drafts. Runtimes that omit statistics leave the affected
values unavailable. Older conversations without metrics continue to load, and
invalid stored metrics are discarded without discarding the conversation.
