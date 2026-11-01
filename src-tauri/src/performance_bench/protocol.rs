//! Client-observed OpenAI chat streaming measurements, independent of engine identity.
use crate::providers::sse::Framer;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[derive(Clone, Debug)]
pub(super) struct Measurement {
    pub content_bytes: u64,
    pub reasoning_bytes: u64,
    pub first_output_ms: Option<f64>,
    pub first_content_ms: Option<f64>,
    pub first_reasoning_ms: Option<f64>,
    pub reported_prompt_tokens: Option<u64>,
    pub reported_completion_tokens: Option<u64>,
    pub reported_cached_tokens: Option<u64>,
    pub usage_status: String,
    pub finish_reason: String,
    pub finished: Instant,
}

#[derive(Default)]
enum Usage {
    #[default]
    Missing,
    Invalid,
    Counters {
        prompt: Option<u64>,
        completion: Option<u64>,
        cached: Option<u64>,
    },
}

impl Usage {
    fn snapshot(value: &Value) -> Self {
        fn counter(value: Option<&Value>) -> Result<Option<u64>, ()> {
            value
                .map(|value| value.as_u64().filter(|n| *n <= MAX_SAFE_INTEGER).ok_or(()))
                .transpose()
        }
        let parse = || -> Result<Self, ()> {
            let object = value.as_object().ok_or(())?;
            let prompt = counter(object.get("prompt_tokens"))?;
            let completion = counter(object.get("completion_tokens"))?;
            let total = counter(object.get("total_tokens"))?;
            let cached = match object
                .get("prompt_tokens_details")
                .filter(|value| !value.is_null())
            {
                Some(details) => counter(details.as_object().ok_or(())?.get("cached_tokens"))?,
                None => None,
            };
            if cached
                .zip(prompt)
                .is_some_and(|(cached, prompt)| cached > prompt)
            {
                return Err(());
            }
            if let Some(total) = total {
                if prompt.is_some_and(|n| n > total) || completion.is_some_and(|n| n > total) {
                    return Err(());
                }
                if let (Some(prompt), Some(completion)) = (prompt, completion) {
                    if prompt.checked_add(completion) != Some(total) {
                        return Err(());
                    }
                }
            }
            Ok(Self::Counters {
                prompt,
                completion,
                cached,
            })
        };
        parse().unwrap_or(Self::Invalid)
    }

    fn fields(&self) -> (Option<u64>, Option<u64>, Option<u64>, &'static str) {
        match *self {
            Self::Missing => (None, None, None, "missing"),
            Self::Invalid => (None, None, None, "invalid"),
            Self::Counters {
                prompt,
                completion,
                cached,
            } => {
                let status = if prompt.is_some() && completion.is_some() && cached.is_some() {
                    "complete"
                } else if prompt.is_some() || completion.is_some() || cached.is_some() {
                    "partial"
                } else {
                    "missing"
                };
                (prompt, completion, cached, status)
            }
        }
    }
}

#[derive(Default)]
struct CompletionStream {
    framing: Framer,
    observed: Observed,
}

#[derive(Default)]
struct Observed {
    content_bytes: u64,
    reasoning_bytes: u64,
    first_content: Option<Instant>,
    first_reasoning: Option<Instant>,
    usage: Usage,
    finish_reason: Option<&'static str>,
    finished: Option<Instant>,
}

impl Observed {
    fn event(
        &mut self,
        data: &str,
        event_type: Option<&str>,
        now: Instant,
    ) -> Result<bool, String> {
        if event_type == Some("error") {
            return Err("runtime returned an SSE error event".into());
        }
        if data == "[DONE]" {
            self.finished = Some(now);
            return Ok(true);
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("invalid benchmark SSE JSON: {error}"))?;
        let object = value
            .as_object()
            .ok_or("benchmark SSE data is not an object")?;
        if object.contains_key("error") {
            return Err("runtime returned a completion error".into());
        }
        if let Some(usage) = object.get("usage").filter(|value| !value.is_null()) {
            // A snapshot replaces the entire preceding one; missing fields are
            // never backfilled, and a malformed snapshot cannot revive it.
            self.usage = Usage::snapshot(usage);
        }
        let Some(choices) = object.get("choices") else {
            return Ok(false);
        };
        let choices = choices
            .as_array()
            .ok_or("benchmark SSE data has invalid completion choices")?;
        if choices.len() > 1 {
            return Err("benchmark stream returned multiple completion choices".into());
        }
        let Some(choice) = choices.first() else {
            return Ok(false);
        };
        let choice = choice
            .as_object()
            .ok_or("benchmark stream returned an invalid choice")?;
        if choice
            .get("index")
            .is_some_and(|index| index.as_u64() != Some(0))
        {
            return Err("benchmark stream returned an unexpected choice index".into());
        }
        if let Some(reason) = choice.get("finish_reason").filter(|value| !value.is_null()) {
            self.finish_reason = Some(match reason.as_str() {
                Some("stop") => "stop",
                Some("length") => "length",
                Some("content_filter") => "content_filter",
                Some("tool_calls") => "tool_calls",
                _ => "other",
            });
        }
        if let Some(delta) = choice.get("delta").filter(|value| !value.is_null()) {
            let delta = delta
                .as_object()
                .ok_or("benchmark stream returned an invalid delta")?;
            let content = delta.get("content");
            let reasoning = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"));
            for (value, bytes, first) in [
                (content, &mut self.content_bytes, &mut self.first_content),
                (
                    reasoning,
                    &mut self.reasoning_bytes,
                    &mut self.first_reasoning,
                ),
            ] {
                if let Some(value) = value.filter(|value| !value.is_null()) {
                    let text = value
                        .as_str()
                        .ok_or("benchmark stream returned non-text output")?;
                    *bytes += text.len() as u64;
                    if !text.is_empty() {
                        first.get_or_insert(now);
                    }
                }
            }
        }
        Ok(false)
    }

    fn measurement(&self, started: Instant) -> Result<Measurement, String> {
        let finished = self
            .finished
            .ok_or("benchmark stream ended before [DONE]")?;
        let latency =
            |at: Option<Instant>| at.map(|at| at.duration_since(started).as_secs_f64() * 1000.0);
        let first_output = match (self.first_content, self.first_reasoning) {
            (Some(content), Some(reasoning)) => Some(content.min(reasoning)),
            (content, reasoning) => content.or(reasoning),
        };
        let (prompt, completion, cached, status) = self.usage.fields();
        Ok(Measurement {
            content_bytes: self.content_bytes,
            reasoning_bytes: self.reasoning_bytes,
            first_output_ms: latency(first_output),
            first_content_ms: latency(self.first_content),
            first_reasoning_ms: latency(self.first_reasoning),
            reported_prompt_tokens: prompt,
            reported_completion_tokens: completion,
            reported_cached_tokens: cached,
            usage_status: status.into(),
            finish_reason: self.finish_reason.unwrap_or("not_reported").into(),
            finished,
        })
    }
}

impl CompletionStream {
    fn push(&mut self, bytes: &[u8], now: Instant) -> Result<bool, String> {
        let observed = &mut self.observed;
        self.framing.push(bytes, MAX_RESPONSE_BYTES, |data, kind| {
            observed.event(data, kind, now)
        })
    }

    fn complete(&self, started: Instant) -> Result<Measurement, String> {
        // EOF cannot dispatch an event: only a blank-line-terminated DONE
        // observed by push makes a request complete.
        self.observed.measurement(started)
    }
}

/// Execute a buffered request cloned without reserializing its input. Only a
/// fully DONE-terminated request yields an observation; failures have no row.
pub(super) async fn request(
    client: &reqwest::Client,
    request: &reqwest::Request,
    cancel: &AtomicBool,
) -> Result<Measurement, String> {
    request_with_timeout(client, request, cancel, REQUEST_TIMEOUT).await
}

async fn request_with_timeout(
    client: &reqwest::Client,
    request: &reqwest::Request,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Measurement, String> {
    let started = Instant::now();
    let work = async {
        let request = request
            .try_clone()
            .ok_or("benchmark request body is not buffered")?;
        let mut response = client
            .execute(request)
            .await
            .map_err(|error| format!("benchmark request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("benchmark HTTP {}", response.status()));
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("text/event-stream"))
            })
        {
            return Err("benchmark response is not an event stream".into());
        }
        let mut stream = CompletionStream::default();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("benchmark stream failed: {error}"))?
        {
            if stream.push(&chunk, Instant::now())? {
                break;
            }
        }
        stream.complete(started)
    };
    tokio::select! {
        biased;
        _ = cancelled(cancel) => Err("benchmark cancelled".into()),
        result = tokio::time::timeout(timeout, work) => result.unwrap_or_else(|_| Err("benchmark request timed out".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn event(value: Value) -> String {
        format!("data: {value}\n\n")
    }

    fn measured(data: &[u8]) -> Result<Measurement, String> {
        let now = Instant::now();
        let mut stream = CompletionStream::default();
        stream.push(data, now)?;
        stream.complete(now)
    }

    fn with_usage(usage: Value) -> Measurement {
        measured(
            format!(
                "{}data: [DONE]\n\n",
                event(json!({"choices":[],"usage":usage}))
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn two_channels_measure_observed_utf8_bytes_and_first_chunk_times() {
        let started = Instant::now();
        let mut stream = CompletionStream::default();
        stream
            .push(
                event(json!({"choices":[{"delta":{"reasoning_content":"생각"}}]})).as_bytes(),
                started + Duration::from_millis(50),
            )
            .unwrap();
        stream
            .push(
                event(json!({"choices":[{"delta":{"content":"눈길"}}]})).as_bytes(),
                started + Duration::from_millis(100),
            )
            .unwrap();
        assert!(stream
            .push(b"data: [DONE]\n\n", started + Duration::from_millis(200))
            .unwrap());
        let row = stream.complete(started).unwrap();
        assert_eq!((row.content_bytes, row.reasoning_bytes), (6, 6));
        assert_eq!(row.first_output_ms, Some(50.0));
        assert_eq!(row.first_content_ms, Some(100.0));
        assert_eq!(row.first_reasoning_ms, Some(50.0));
        assert_eq!(
            row.finished.duration_since(started),
            Duration::from_millis(200)
        );
        assert_eq!((row.content_bytes + row.reasoning_bytes) as f64 / 0.2, 60.0);
        assert_eq!(row.usage_status, "missing");
        assert_eq!(
            (
                row.reported_prompt_tokens,
                row.reported_completion_tokens,
                row.reported_cached_tokens
            ),
            (None, None, None)
        );
        assert_eq!(row.finish_reason, "not_reported");
    }

    #[test]
    fn byte_splits_bom_multiline_and_every_sse_line_ending_preserve_output() {
        for ending in ["\n", "\r\n", "\r"] {
            let wire = "\u{feff}: heartbeat\nid: ignored\nevent: message\ndata: {\ndata: \"choices\":[{\"delta\":{\"content\":\"눈길\",\"reasoning\":\"생각\"}}]\ndata: }\n\ndata: [DONE]\n\n".replace('\n', ending);
            let now = Instant::now();
            for split in 0..=wire.len() {
                let mut stream = CompletionStream::default();
                stream.push(&wire.as_bytes()[..split], now).unwrap();
                stream.push(&wire.as_bytes()[split..], now).unwrap();
                let row = stream.complete(now).unwrap();
                assert_eq!((row.content_bytes, row.reasoning_bytes), (6, 6));
            }
            let mut stream = CompletionStream::default();
            for byte in wire.bytes() {
                stream.push(&[byte], now).unwrap();
            }
            assert_eq!(stream.complete(now).unwrap().content_bytes, 6);
        }
    }

    #[test]
    fn done_alone_is_known_empty_output_without_model_reason_or_usage() {
        let row = measured(b"data: [DONE]\n\n").unwrap();
        assert_eq!((row.content_bytes, row.reasoning_bytes), (0, 0));
        assert_eq!(
            (
                row.first_output_ms,
                row.first_content_ms,
                row.first_reasoning_ms
            ),
            (None, None, None)
        );
        assert_eq!(row.finish_reason, "not_reported");
        assert_eq!(row.usage_status, "missing");
    }

    #[test]
    fn reasoning_only_and_literal_think_are_output_but_role_tools_and_usage_are_not() {
        let row = measured(
            format!(
                "{}data: [DONE]\n\n",
                event(json!({"choices":[{"delta":{
            "role":"assistant","reasoning_content":"생각","reasoning":"ignored",
            "tool_calls":[{"function":{"arguments":"not output"}}]
        }}],"usage":{"completion_tokens":2}}))
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!((row.content_bytes, row.reasoning_bytes), (0, 6));
        assert!(row.first_output_ms.is_some());
        assert!(row.first_content_ms.is_none());
        let row = measured(
            format!(
                "{}data: [DONE]\n\n",
                event(json!({"choices":[{"delta":{"content":"<think>x</think>"}}]}))
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(row.content_bytes, 16);
    }

    #[test]
    fn last_nonnull_finish_reason_survives_usage_and_is_not_a_terminator() {
        let now = Instant::now();
        let mut stream = CompletionStream::default();
        for reason in [json!("stop"), json!("length"), Value::Null] {
            assert!(!stream
                .push(
                    event(json!({"choices":[{"delta":{},"finish_reason":reason}]})).as_bytes(),
                    now
                )
                .unwrap());
        }
        assert!(!stream.push(event(json!({"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":5}})).as_bytes(), now).unwrap());
        assert!(
            stream.complete(now).is_err(),
            "usage/finish cannot replace DONE"
        );
        stream.push(b"data: [DONE]\n\n", now).unwrap();
        let row = stream.complete(now).unwrap();
        assert_eq!(row.finish_reason, "length");
        assert_eq!(row.usage_status, "complete");
        assert_eq!(
            (
                row.reported_prompt_tokens,
                row.reported_completion_tokens,
                row.reported_cached_tokens
            ),
            (Some(4), Some(1), Some(0))
        );
        for (reason, expected) in [
            (json!("content_filter"), "content_filter"),
            (json!("tool_calls"), "tool_calls"),
            (json!("vendor_reason"), "other"),
            (json!(false), "other"),
            (json!(""), "other"),
        ] {
            let row = measured(
                format!(
                    "{}data: [DONE]\n\n",
                    event(json!({"choices":[{"finish_reason":reason}]}))
                )
                .as_bytes(),
            )
            .unwrap();
            assert_eq!(row.finish_reason, expected);
        }
    }

    #[test]
    fn usage_snapshots_replace_without_backfill_and_null_is_ignored() {
        let full = json!({"prompt_tokens":4,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1}});
        for (last, status, counters) in [
            (Value::Null, "complete", (Some(4), Some(2), Some(1))),
            (
                json!({"completion_tokens":1}),
                "partial",
                (None, Some(1), None),
            ),
            (json!({}), "missing", (None, None, None)),
            (json!(false), "invalid", (None, None, None)),
        ] {
            let data = format!(
                "{}{}data: [DONE]\n\n",
                event(json!({"choices":[],"usage":full})),
                event(json!({"choices":[],"usage":last}))
            );
            let row = measured(data.as_bytes()).unwrap();
            assert_eq!(row.usage_status, status);
            assert_eq!(
                (
                    row.reported_prompt_tokens,
                    row.reported_completion_tokens,
                    row.reported_cached_tokens
                ),
                counters
            );
        }
        let data = format!(
            "{}{}{}data: [DONE]\n\n",
            event(json!({"usage":false})),
            event(
                json!({"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":0}}})
            ),
            event(json!({"usage":null}))
        );
        let row = measured(data.as_bytes()).unwrap();
        assert_eq!(row.usage_status, "complete");
        assert_eq!(
            (
                row.reported_prompt_tokens,
                row.reported_completion_tokens,
                row.reported_cached_tokens
            ),
            (Some(7), Some(3), Some(0))
        );
    }

    #[test]
    fn usage_requires_safe_counters_consistent_totals_and_bounded_cache() {
        for usage in [
            json!([]),
            json!("invalid"),
            json!({"prompt_tokens":-1}),
            json!({"completion_tokens":1.5}),
            json!({"prompt_tokens":null}),
            json!({"completion_tokens":9_007_199_254_740_992_u64}),
            json!({"prompt_tokens":1,"prompt_tokens_details":{"cached_tokens":2}}),
            json!({"prompt_tokens":1,"completion_tokens":2,"total_tokens":4}),
            json!({"prompt_tokens":2,"total_tokens":1}),
            json!({"completion_tokens":2,"total_tokens":1}),
            json!({"prompt_tokens":MAX_SAFE_INTEGER,"completion_tokens":1,"total_tokens":MAX_SAFE_INTEGER}),
            json!({"prompt_tokens":u64::MAX,"completion_tokens":1,"total_tokens":0}),
            json!({"prompt_tokens_details":{"cached_tokens":"0"}}),
        ] {
            let row = with_usage(usage);
            assert_eq!(row.usage_status, "invalid");
            assert_eq!(
                (
                    row.reported_prompt_tokens,
                    row.reported_completion_tokens,
                    row.reported_cached_tokens
                ),
                (None, None, None)
            );
        }
        let row = with_usage(
            json!({"prompt_tokens":MAX_SAFE_INTEGER,"completion_tokens":0,"total_tokens":MAX_SAFE_INTEGER,"prompt_tokens_details":{"cached_tokens":0}}),
        );
        assert_eq!(row.reported_prompt_tokens, Some(MAX_SAFE_INTEGER));
        assert_eq!(row.usage_status, "complete");
        let row = with_usage(json!({"completion_tokens":0}));
        assert_eq!(row.reported_completion_tokens, Some(0));
        assert_eq!(row.reported_cached_tokens, None);
        assert_eq!(row.usage_status, "partial");
    }

    #[test]
    fn invalid_framing_json_choices_or_missing_done_never_yield_observations() {
        for wire in [
            b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n".as_slice(),
            b"data: {\"choices\":[],\"usage\":{\"completion_tokens\":1}}\n\n",
            b"data: [DONE]",
            b"data: [DONE]\n",
            b"data: [DONE]\r",
            b"data: [DONE]\r\n",
            b"data: nope\n\ndata: [DONE]\n\n",
            b"data: []\n\ndata: [DONE]\n\n",
            b"data: {\"error\":\"unavailable\"}\n\ndata: [DONE]\n\n",
            b"event: error\ndata: {}\n\ndata: [DONE]\n\n",
            b"event: error\n\ndata: [DONE]\n\n",
            b"data: {\"choices\":[{},{}]}\n\ndata: [DONE]\n\n",
            b"data: {\"choices\":[{\"index\":1}]}\n\ndata: [DONE]\n\n",
            b"data: {\"choices\":[{\"index\":null}]}\n\ndata: [DONE]\n\n",
            b"data: {\"choices\":[{\"delta\":{\"content\":3}}]}\n\ndata: [DONE]\n\n",
            b"data: {\"choices\":[{\"delta\":{\"reasoning\":false}}]}\n\ndata: [DONE]\n\n",
            b": invalid UTF8 \xff\n\ndata: [DONE]\n\n",
            b"data: \xff",
        ] {
            assert!(measured(wire).is_err(), "accepted {wire:?}");
        }
    }

    #[test]
    fn stream_line_and_multiline_event_limits_apply_without_eof() {
        use crate::providers::sse::EVENT_LIMIT;
        let now = Instant::now();
        let mut stream = CompletionStream::default();
        assert!(stream.push(&vec![b'x'; EVENT_LIMIT + 1], now).is_err());
        let mut stream = CompletionStream::default();
        let wire = format!(
            "data: {}\ndata: {}\n",
            " ".repeat(EVENT_LIMIT / 2),
            " ".repeat(EVENT_LIMIT / 2)
        );
        assert!(
            stream.push(wire.as_bytes(), now).is_err(),
            "multiline separators count against event limit"
        );
        let mut stream = CompletionStream::default();
        let comment = format!(":{}\n", " ".repeat(EVENT_LIMIT - 1));
        stream.push(comment.as_bytes(), now).unwrap();
        stream.push(b"data: [DONE]\n\n", now).unwrap();
        assert_eq!(stream.complete(now).unwrap().content_bytes, 0);
        let mut stream = CompletionStream::default();
        let comment = format!(":{}\n", " ".repeat(4094));
        for _ in 0..MAX_RESPONSE_BYTES / comment.len() {
            stream.push(comment.as_bytes(), now).unwrap();
        }
        assert!(stream.push(b"x", now).is_err());
    }

    async fn fixture_request(socket: &mut tokio::net::TcpStream) {
        let mut request = Vec::new();
        loop {
            let mut buffer = [0; 4096];
            let n = socket.read(&mut buffer).await.unwrap();
            assert_ne!(n, 0);
            request.extend_from_slice(&buffer[..n]);
            if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..end]).unwrap();
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    return;
                }
            }
            assert!(request.len() < 65536);
        }
    }

    async fn http_fixture(
        status: u16,
        body: Vec<u8>,
        hold_open: bool,
    ) -> (
        reqwest::Client,
        reqwest::Request,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let url = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            fixture_request(&mut socket).await;
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            socket
                .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                .await
                .unwrap();
            socket.write_all(&body).await.unwrap();
            socket.write_all(b"\r\n").await.unwrap();
            if hold_open {
                std::future::pending::<()>().await;
            } else {
                socket.write_all(b"0\r\n\r\n").await.unwrap();
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let request = client.post(url).json(&json!({"model":"fixture","messages":[{"role":"user","content":"input"}],"temperature":0,"max_tokens":128,"stream":true})).build().unwrap();
        (client, request, task)
    }

    #[tokio::test]
    async fn http_done_reads_late_usage_but_never_waits_for_open_socket_or_parses_trailing_data() {
        let mut wire = format!(
            "{}{}{}data: [DONE]\n\n",
            event(json!({"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]})),
            event(json!({"usage":{"prompt_tokens":4,"completion_tokens":1}})),
            event(json!({"choices":[],"usage":null}))
        )
        .into_bytes();
        wire.push(0xff);
        let (client, prepared, fixture) = http_fixture(200, wire, true).await;
        let row = tokio::time::timeout(
            Duration::from_secs(1),
            request(&client, &prepared, &AtomicBool::new(false)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            row.content_bytes, 1,
            "early EOS below the request cap succeeds"
        );
        assert_eq!(row.finish_reason, "stop");
        assert_eq!(row.reported_prompt_tokens, Some(4));
        assert_eq!(row.reported_completion_tokens, Some(1));
        assert_eq!(row.reported_cached_tokens, None);
        fixture.abort();
    }

    #[tokio::test]
    async fn http_eof_error_status_and_malformed_payload_fail_without_measurement() {
        for (status, body) in [
            (
                200,
                b"data: {\"choices\":[],\"usage\":{\"completion_tokens\":1}}\n\n".to_vec(),
            ),
            (200, b"data: \xff\n\ndata: [DONE]\n\n".to_vec()),
            (200, b"data: invalid\n\ndata: [DONE]\n\n".to_vec()),
            (200, b"event: error\ndata: unavailable\n\n".to_vec()),
            (401, b"data: [DONE]\n\n".to_vec()),
        ] {
            let (client, prepared, fixture) = http_fixture(status, body, false).await;
            assert!(request(&client, &prepared, &AtomicBool::new(false))
                .await
                .is_err());
            fixture.await.unwrap();
        }
    }

    #[tokio::test]
    async fn request_deadline_and_cancellation_discard_unfinished_output() {
        let partial = event(json!({"choices":[{"delta":{"content":"partial"}}]})).into_bytes();
        let (client, prepared, fixture) = http_fixture(200, partial.clone(), true).await;
        assert!(request_with_timeout(
            &client,
            &prepared,
            &AtomicBool::new(false),
            Duration::from_millis(100)
        )
        .await
        .unwrap_err()
        .contains("timed out"));
        fixture.abort();
        let (client, prepared, fixture) = http_fixture(200, partial, true).await;
        let cancel = AtomicBool::new(false);
        let operation = request(&client, &prepared, &cancel);
        let stop = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.store(true, Ordering::Release);
        };
        let (result, ()) = tokio::join!(operation, stop);
        assert!(result.unwrap_err().contains("cancelled"));
        fixture.abort();
    }
}
