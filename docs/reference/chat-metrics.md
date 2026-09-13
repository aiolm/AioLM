# Chat response metrics

Each new assistant response shows two rows with token count, duration in seconds,
and throughput in tokens per second. Measurements update during streaming and
remain attached to the response in conversation history.

| Stage | Token count | Duration | Throughput |
| --- | --- | --- | --- |
| PP (prompt processing) | Server `timings.prompt_n`, excluding cached tokens | Server `timings.prompt_ms` | Server `timings.prompt_per_second` |
| TG (token generation) | Server `timings.predicted_n`, including reasoning tokens | Server `timings.predicted_ms` | Server `timings.predicted_per_second` |

When a server rate is missing, AioLM divides the corresponding stage's token count
by its duration. Usage fields can supply the TG count from `completion_tokens`,
or the PP count from `prompt_tokens` minus a known cached-token count. The cache
count comes from `timings.cache_n` or `usage.prompt_tokens_details.cached_tokens`.
Missing, invalid, or unobservable values display as `—`. Zero counts and durations
remain zero; a zero duration cannot supply a calculated rate. Counts are never
estimated from response text.

**More metrics** reveals these details:

- **Time to first token (TTFT):** time from starting the chat request to the first
  nonempty text, reasoning, or tool name/arguments received by the client.
- **Preparation time:** time spent preparing the send before starting the chat
  request, including server wake-up and document retrieval.
- **Request time:** elapsed client time from starting the chat request to its
  completion or interruption; it updates on streamed events while active.
- **Cached tokens:** the server-reported prompt tokens reused from cache.

PP/TG durations and rates use server phase measurements. Preparation and client
request timing do not enter those calculations.

Partial responses retain measurements on Stop or a connection failure. An empty
cancelled response is removed. Retrying starts fresh measurements. An MCP request
keeps its measurements while awaiting approval; its follow-up replaces them with
the final answer request's measurements, without adding tool execution or approval
wait time. The turn continues to use its original session and settings snapshot.

Chat requests default to `timings_per_token: true` and
`stream_options.include_usage: true`. Explicit `false` values in chat JSON are
honored. These defaults apply only to the request body and do not change saved
settings or unapplied drafts. Runtimes that omit statistics leave the affected
values unavailable. Older conversations without metrics continue to load, and
invalid stored metrics are discarded without discarding the conversation.
