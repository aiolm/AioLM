//! HTTP and SSE measurement, independent of Tauri and the process launcher.
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub(super) async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub(super) async fn bounded_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("cannot read benchmark response: {error}"))?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("benchmark response exceeded its size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(format!(
            "benchmark HTTP {status}: {}",
            String::from_utf8_lossy(&bytes[..bytes.len().min(2048)])
        ));
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid benchmark JSON: {error}"))
}

pub(super) async fn tokenize(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    text: &str,
) -> Result<Vec<u32>, String> {
    let response = client
        .post(format!("{base}/tokenize"))
        .bearer_auth(key)
        .json(&json!({"content": text, "add_special": false, "parse_special": false}))
        .send()
        .await
        .map_err(|error| format!("tokenization failed: {error}"))?;
    let value = bounded_json(response).await?;
    value
        .get("tokens")
        .and_then(Value::as_array)
        .ok_or_else(|| "runtime did not return a tokenizer token array".to_string())?
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| "runtime returned an invalid token ID".to_string())
        })
        .collect()
}

#[derive(Clone, Debug, Default)]
pub(super) struct Measurement {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub cached_tokens: u32,
    pub first_token: Option<Instant>,
    pub last_token: Option<Instant>,
    pub started: Option<Instant>,
    pub error: Option<String>,
}

impl Measurement {
    pub fn ttft_ms(&self) -> Option<f64> {
        Some(
            self.first_token?
                .duration_since(self.started?)
                .as_secs_f64()
                * 1000.0,
        )
    }

    pub fn tpot_ms(&self) -> Option<f64> {
        (self.completion_tokens > 1)
            .then(|| {
                self.last_token?
                    .checked_duration_since(self.first_token?)
                    .filter(|elapsed| !elapsed.is_zero())
                    .map(|elapsed| {
                        elapsed.as_secs_f64() * 1000.0 / f64::from(self.completion_tokens - 1)
                    })
            })
            .flatten()
    }
}

#[derive(Default)]
struct CompletionStream {
    pending: Vec<u8>,
    newline_search: usize,
    data: Vec<String>,
    first_token: Option<Instant>,
    last_token: Option<Instant>,
    final_value: Option<Value>,
    total_bytes: usize,
}

impl CompletionStream {
    fn event(&mut self, now: Instant) -> Result<(), String> {
        if self.data.is_empty() {
            return Ok(());
        }
        let data = self.data.join("\n");
        self.data.clear();
        if data.trim() == "[DONE]" {
            return Ok(());
        }
        let value: Value = serde_json::from_str(&data)
            .map_err(|error| format!("invalid benchmark SSE data: {error}"))?;
        if let Some(error) = value.get("error") {
            return Err(format!("runtime completion error: {error}"));
        }
        let stop = value.get("stop").and_then(Value::as_bool).unwrap_or(false)
            || value.get("usage").is_some_and(|usage| {
                usage
                    .get("completion_tokens")
                    .and_then(Value::as_u64)
                    .is_some()
            });
        // vLLM `return_token_ids` chunks carry the step's token IDs even when a
        // partial UTF-8 sequence leaves their text empty.
        let has_output = value
            .pointer("/choices/0/token_ids")
            .and_then(Value::as_array)
            .is_some_and(|ids| !ids.is_empty())
            || value
                .pointer("/choices/0/text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
            || value
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
            || value
                .pointer("/choices/0/delta/reasoning")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
            || value
                .get("tokens")
                .and_then(Value::as_array)
                .is_some_and(|tokens| !tokens.is_empty())
            || value
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| !content.is_empty());
        // A final response can repeat the entire output. Its accounting must
        // not move the timestamp of the last observed output token.
        if has_output && (!stop || self.first_token.is_none()) {
            self.first_token.get_or_insert(now);
            self.last_token = Some(now);
        }
        if stop {
            self.final_value = Some(value);
        }
        Ok(())
    }

    fn push(&mut self, bytes: &[u8], now: Instant) -> Result<(), String> {
        self.total_bytes += bytes.len();
        if self.total_bytes > MAX_RESPONSE_BYTES {
            return Err("benchmark stream exceeded its size limit".into());
        }
        self.append_and_parse(bytes, now)
    }

    fn append_and_parse(&mut self, bytes: &[u8], now: Instant) -> Result<(), String> {
        self.pending.extend_from_slice(bytes);
        let mut consumed = 0;
        let outcome = (|| -> Result<(), String> {
            while let Some(offset) = self.pending[self.newline_search..]
                .iter()
                .position(|byte| *byte == b'\n')
            {
                let start = consumed;
                let end = self.newline_search + offset + 1;
                consumed = end;
                self.newline_search = end;
                let line = std::str::from_utf8(&self.pending[start..end])
                    .map_err(|_| "invalid UTF-8 in benchmark SSE")?
                    .trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    self.event(now)?;
                } else if let Some(data) = line.strip_prefix("data:") {
                    self.data
                        .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
                }
            }
            self.newline_search = self.pending.len();
            Ok(())
        })();
        // An error consumes its line and leaves the remaining suffix for a later push.
        self.newline_search = if outcome.is_ok() {
            self.newline_search - consumed
        } else {
            0
        };
        if consumed > 0 {
            drop(self.pending.drain(..consumed));
        }
        outcome
    }

    fn finish(&mut self, now: Instant) -> Result<(), String> {
        if self.total_bytes > MAX_RESPONSE_BYTES {
            return Err("benchmark stream exceeded its size limit".into());
        }
        // Local delimiters flush the event without consuming received-byte budget.
        self.append_and_parse(b"\n\n", now)?;
        self.event(now)
    }

    fn measurement(
        &self,
        started: Instant,
        expected_prompt: u32,
        expected_generation: u32,
    ) -> Measurement {
        let mut result = Measurement {
            started: Some(started),
            first_token: self.first_token,
            last_token: self.last_token,
            ..Default::default()
        };
        let Some(value) = &self.final_value else {
            result.error = Some("stream ended without final token accounting".into());
            return result;
        };
        let count = |path: &str| {
            value
                .pointer(path)
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
        };
        let cache = count("/timings/cache_n")
            .or_else(|| count("/usage/prompt_tokens_details/cached_tokens"));
        let evaluated = count("/timings/prompt_n");
        let prompt = count("/usage/prompt_tokens")
            .or_else(|| count("/tokens_evaluated"))
            .or_else(|| evaluated.and_then(|n| n.checked_add(cache.unwrap_or(0))));
        let completion = count("/timings/predicted_n")
            .or_else(|| count("/usage/completion_tokens"))
            .or_else(|| count("/tokens_predicted"));
        result.prompt_tokens = prompt.unwrap_or(0);
        result.completion_tokens = completion.unwrap_or(0);
        // prompt_n is the number actually evaluated; with cache_prompt=false
        // it must cover the whole tokenized input. This also verifies older
        // runtimes that omit the newer explicit cache_n field.
        let cached = cache.or_else(|| {
            prompt
                .zip(evaluated)
                .map(|(total, processed)| total.saturating_sub(processed))
        });
        result.cached_tokens = cached.unwrap_or(0);
        result.error = if prompt != Some(expected_prompt) {
            Some(format!("prompt token count mismatch: requested {expected_prompt}, runtime reported {prompt:?}"))
        } else if completion != Some(expected_generation) {
            Some(format!("output token count mismatch: requested {expected_generation}, runtime reported {completion:?}"))
        } else if cached.is_none() {
            Some("runtime did not report enough token timings to verify a cold prompt".into())
        } else if result.cached_tokens > 0 {
            Some(format!(
                "cold benchmark unexpectedly reused {} prompt tokens",
                result.cached_tokens
            ))
        } else if value.get("truncated").and_then(Value::as_bool) == Some(true) {
            Some("runtime truncated the benchmark context".into())
        } else if result.first_token.is_none() {
            Some("runtime returned no streamed output token timestamps".into())
        } else {
            None
        };
        result
    }
}

pub(super) fn completion_body(tokens: &[u32], generation: u32, slot: u32) -> Value {
    json!({"prompt": tokens, "n_predict": generation, "stream": true,
        "cache_prompt": false, "ignore_eos": true, "return_tokens": true,
        "temperature": 0, "seed": 42, "top_k": 1, "top_p": 1.0, "min_p": 0.0,
        "repeat_penalty": 1.0, "presence_penalty": 0.0, "frequency_penalty": 0.0,
        "stop": [], "id_slot": slot})
}

#[derive(Clone)]
pub(super) struct Endpoint {
    pub client: reqwest::Client,
    pub base: String,
    pub key: String,
    pub engine: Option<Arc<super::providers::ProviderProtocol>>,
}

pub(super) async fn measure(
    endpoint: &Endpoint,
    tokens: Arc<Vec<u32>>,
    generation: u32,
    slot: u32,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
) -> Measurement {
    let Endpoint {
        client,
        base,
        key,
        engine,
    } = endpoint;
    let started = Instant::now();
    let mut stream = CompletionStream::default();
    let work = async {
        let (path, body) = match engine {
            Some(engine) => engine.body(&tokens, generation)?,
            None => (
                "/completion".into(),
                completion_body(&tokens, generation, slot),
            ),
        };
        let response = client
            .post(format!("{base}{path}"))
            .bearer_auth(key)
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("completion request failed: {error}"))?;
        if !response.status().is_success() {
            bounded_json(response).await?;
            return Err("runtime rejected benchmark completion".to_string());
        }
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            stream.push(
                &chunk.map_err(|error| format!("completion stream failed: {error}"))?,
                Instant::now(),
            )?;
            if stream.final_value.is_some() {
                break;
            }
        }
        // A missing cached-token count is never read as zero: vLLM 0.31 reports
        // it, including 0, whenever --enable-prompt-tokens-details is active,
        // so its absence means the cold prompt is unproven.
        stream.finish(Instant::now())
    };
    let outcome = tokio::select! {
        biased;
        _ = cancelled(&cancel) => Err("benchmark cancelled".to_string()),
        result = tokio::time::timeout(timeout, work) => result.unwrap_or_else(|_| Err("benchmark request timed out".into())),
    };
    let mut measured = stream.measurement(started, tokens.len() as u32, generation);
    if let Err(error) = outcome {
        measured.error = Some(error);
    }
    measured
}

#[cfg(test)]
mod tests {
    use super::*;

    const FINAL_ACCOUNTING_EVENT: &[u8] = b"data: {\"tokens\":[8,9],\"stop\":true,\"timings\":{\"prompt_n\":3,\"cache_n\":0,\"predicted_n\":2}}\n\n";

    fn received_boundary_body(bytes: usize, terminated: bool) -> Vec<u8> {
        let event = if terminated {
            FINAL_ACCOUNTING_EVENT
        } else {
            &FINAL_ACCOUNTING_EVENT[..FINAL_ACCOUNTING_EVENT.len() - 2]
        };
        assert!(bytes > event.len() + 2, "fixture body has room for padding");
        let mut body = Vec::with_capacity(bytes);
        let mut padding = bytes - event.len();
        // Complete bounded comment lines keep byte-limit checks independent of long-line
        // buffer rescan cost. They carry no output tokens or accounting.
        while padding > 0 {
            let line = padding.min(4096);
            if line == 1 {
                body.push(b'\n');
            } else {
                body.push(b':');
                body.resize(body.len() + line - 2, b' ');
                body.push(b'\n');
            }
            padding -= line;
        }
        body.extend_from_slice(event);
        assert_eq!(body.len(), bytes, "fixture exact received byte length");
        body
    }

    fn measurement_facts(measured: &Measurement) -> Value {
        json!({
            "prompt_tokens": measured.prompt_tokens,
            "completion_tokens": measured.completion_tokens,
            "cached_tokens": measured.cached_tokens,
            "started": measured.started.is_some(),
            "first_token": measured.first_token.is_some(),
            "last_token": measured.last_token.is_some(),
            "first_equals_last": measured.first_token == measured.last_token,
            "ttft_ms": measured.ttft_ms(),
            "tpot_ms": measured.tpot_ms(),
            "error": measured.error,
        })
    }

    async fn read_fixture_request(socket: &mut tokio::net::TcpStream) -> Result<Value, String> {
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        let header_end = loop {
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                if end + 4 > 64 * 1024 {
                    return Err("fixture request header exceeded its setup bound".into());
                }
                break end + 4;
            }
            if bytes.len() > 64 * 1024 {
                return Err("fixture request header exceeded its setup bound".into());
            }
            let mut chunk = [0u8; 4096];
            let read = socket
                .read(&mut chunk)
                .await
                .map_err(|error| error.to_string())?;
            if read == 0 {
                return Err("fixture request closed before complete headers".into());
            }
            bytes.extend_from_slice(&chunk[..read]);
        };
        let header = std::str::from_utf8(&bytes[..header_end])
            .map_err(|error| format!("fixture request header is not UTF-8: {error}"))?;
        let request_line = header.lines().next().unwrap_or_default().to_owned();
        let content_length = header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .ok_or_else(|| "fixture request lacks its expected Content-Length".to_string())?;
        let authenticated = header
            .lines()
            .any(|line| line.eq_ignore_ascii_case("authorization: Bearer synthetic-benchmark-key"));
        if content_length > 4096 {
            return Err("fixture request JSON exceeded its setup bound".into());
        }
        while bytes.len() < header_end + content_length {
            let mut chunk = [0u8; 4096];
            let read = socket
                .read(&mut chunk)
                .await
                .map_err(|error| error.to_string())?;
            if read == 0 {
                return Err("fixture request closed before complete JSON".into());
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        let body: Value = serde_json::from_slice(&bytes[header_end..header_end + content_length])
            .map_err(|error| format!("fixture request JSON is invalid: {error}"))?;
        Ok(json!({"request_line": request_line, "authenticated": authenticated, "body": body}))
    }

    #[derive(Debug)]
    struct ReceivedBoundaryObservation {
        configured_received_bytes: usize,
        measured: Measurement,
        request: Value,
        body_write_error: Option<String>,
        returned_before_release: bool,
    }

    async fn measure_received_boundary(
        bytes: usize,
    ) -> Result<ReceivedBoundaryObservation, String> {
        use tokio::io::AsyncWriteExt;
        let body = received_boundary_body(bytes, true);
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| format!("fixture client setup: {error}"))?;
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| format!("fixture listener setup: {error}"))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let mut server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.map_err(|error| error.to_string())?;
            let request = read_fixture_request(&mut socket).await?;
            // Deliberately no Content-Length and no EOF until the caller releases
            // this server. Complete final accounting must end measurement itself.
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
                .await.map_err(|error| format!("fixture response header write: {error}"))?;
            let body_write_error = socket
                .write_all(&body)
                .await
                .err()
                .map(|error| error.to_string());
            let _ = release_rx.await;
            let _ = socket.shutdown().await;
            Ok::<_, String>((request, body_write_error))
        });
        // All Result/assert handling follows controller release and server join.
        // These deadlines diagnose liveness/setup; they are not speed assertions.
        let measured = tokio::time::timeout(
            Duration::from_secs(25),
            measure(
                &Endpoint {
                    client,
                    base: format!("http://{address}"),
                    key: "synthetic-benchmark-key".into(),
                    engine: None,
                },
                Arc::new(vec![11, 12, 13]),
                2,
                0,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(20),
            ),
        )
        .await;
        let returned_before_release = measured.is_ok();
        let _ = release_tx.send(());
        let served = match tokio::time::timeout(Duration::from_secs(5), &mut server).await {
            Ok(result) => result.map_err(|error| format!("fixture server join: {error}"))?,
            Err(_) => {
                server.abort();
                let _ = server.await;
                return Err("fixture server did not retire after explicit release".into());
            }
        }?;
        let measured = measured
            .map_err(|_| "measure exceeded the outer fixture liveness deadline".to_string())?;
        Ok(ReceivedBoundaryObservation {
            configured_received_bytes: bytes,
            measured,
            request: served.0,
            body_write_error: served.1,
            returned_before_release,
        })
    }

    #[tokio::test]
    async fn received_response_byte_limit_excludes_local_eof_flush() {
        assert_eq!(
            MAX_RESPONSE_BYTES,
            8 * 1024 * 1024,
            "preserve the existing exact 8-MiB policy"
        );
        let mut observations = Vec::new();
        for bytes in [
            MAX_RESPONSE_BYTES - 2,
            MAX_RESPONSE_BYTES - 1,
            MAX_RESPONSE_BYTES,
            MAX_RESPONSE_BYTES + 1,
        ] {
            observations.push(measure_received_boundary(bytes).await);
        }
        // Every owned server is released/joined before any product assertion.
        for observation in &observations {
            println!("RECEIVED_RESPONSE_BOUNDARY {observation:?}");
        }
        let expected_request = json!({"prompt":[11,12,13],"n_predict":2,"stream":true,
            "cache_prompt":false,"ignore_eos":true,"return_tokens":true,"temperature":0,
            "seed":42,"top_k":1,"top_p":1.0,"min_p":0.0,"repeat_penalty":1.0,
            "presence_penalty":0.0,"frequency_penalty":0.0,"stop":[],"id_slot":0});
        let mut accepted_size_errors = Vec::new();
        for observation in observations {
            let observation = observation.unwrap_or_else(|error| {
                panic!("SETUP/UNEXPECTED TRANSPORT, not a received-byte-limit assertion: {error}")
            });
            assert_eq!(
                observation.request["request_line"], "POST /completion HTTP/1.1",
                "SETUP request route"
            );
            assert_eq!(
                observation.request["authenticated"], true,
                "SETUP request authentication"
            );
            assert_eq!(
                observation.request["body"], expected_request,
                "SETUP exact production request"
            );
            assert!(
                observation.returned_before_release,
                "SETUP/liveness: EOF was not released to complete measurement"
            );
            let measured = observation.measured;
            println!(
                "RECEIVED_RESPONSE_FIELDS bytes={} fields={}",
                observation.configured_received_bytes,
                measurement_facts(&measured)
            );
            assert!(measured.error.as_deref().is_none_or(|error| error == "benchmark stream exceeded its size limit"),
                    "UNEXPECTED non-boundary transport/parser/liveness outcome needs separate classification: {:?}", measured.error);
            if observation.configured_received_bytes <= MAX_RESPONSE_BYTES {
                assert!(
                    observation.body_write_error.is_none(),
                    "SETUP accepted-size body was not fully sent: {:?}",
                    observation.body_write_error
                );
                assert_eq!(
                    (
                        measured.prompt_tokens,
                        measured.completion_tokens,
                        measured.cached_tokens
                    ),
                    (3, 2, 0)
                );
                assert!(measured.started.is_some() && measured.first_token.is_some());
                assert_eq!(measured.first_token, measured.last_token);
                assert!(measured
                    .ttft_ms()
                    .is_some_and(|value| value.is_finite() && value >= 0.0));
                assert!(
                    measured.tpot_ms().is_none(),
                    "final-only output cannot invent a decode interval"
                );
                if let Some(error) = measured.error {
                    accepted_size_errors.push((observation.configured_received_bytes, error));
                }
            } else {
                assert_eq!(
                    measured.error.as_deref(),
                    Some("benchmark stream exceeded its size limit"),
                    "one-byte-over-limit control must retain the exact existing cap rejection"
                );
            }
        }
        assert!(accepted_size_errors.is_empty(), "local EOF flush rejected accepted received sizes after all controls: {accepted_size_errors:?}");
    }

    #[test]
    fn eof_flush_preserves_boundary_event_accounting() {
        assert_eq!(
            MAX_RESPONSE_BYTES,
            8 * 1024 * 1024,
            "preserve the existing exact 8-MiB policy"
        );
        let mut observations = Vec::new();
        for terminated in [true, false] {
            for bytes in [
                MAX_RESPONSE_BYTES - 2,
                MAX_RESPONSE_BYTES - 1,
                MAX_RESPONSE_BYTES,
                MAX_RESPONSE_BYTES + 1,
            ] {
                let started = Instant::now();
                let mut stream = CompletionStream::default();
                let body = received_boundary_body(bytes, terminated);
                let push_error = body.chunks(4096).find_map(|chunk| {
                    stream
                        .push(chunk, started + Duration::from_millis(100))
                        .err()
                });
                let finish_error = if push_error.is_none() {
                    stream.finish(started + Duration::from_millis(200)).err()
                } else {
                    None
                };
                let measured = stream.measurement(started, 3, 2);
                observations.push((
                    bytes,
                    terminated,
                    push_error,
                    finish_error,
                    measured,
                    started,
                ));
            }
        }
        for (bytes, terminated, push_error, finish_error, measured, _) in &observations {
            println!("EOF_FLUSH_BOUNDARY bytes={bytes} terminated={terminated} push={push_error:?} finish={finish_error:?} fields={}", measurement_facts(measured));
        }
        let mut accepted_flush_errors = Vec::new();
        for (bytes, terminated, push_error, finish_error, measured, started) in observations {
            if bytes <= MAX_RESPONSE_BYTES {
                assert!(
                    push_error.is_none(),
                    "valid received size failed before EOF flush: {push_error:?}"
                );
                if let Some(error) = finish_error {
                    assert_eq!(
                        error, "benchmark stream exceeded its size limit",
                        "UNEXPECTED non-boundary EOF error"
                    );
                    accepted_flush_errors.push((bytes, terminated, error));
                    continue;
                }
                assert!(measured.error.is_none(), "{:?}", measured.error);
                assert_eq!(
                    (
                        measured.prompt_tokens,
                        measured.completion_tokens,
                        measured.cached_tokens
                    ),
                    (3, 2, 0)
                );
                let expected = started + Duration::from_millis(if terminated { 100 } else { 200 });
                assert_eq!(measured.first_token, Some(expected));
                assert_eq!(measured.last_token, Some(expected));
                assert!(measured.tpot_ms().is_none());
            } else {
                assert_eq!(
                    push_error.as_deref(),
                    Some("benchmark stream exceeded its size limit")
                );
            }
        }
        assert!(accepted_flush_errors.is_empty(), "EOF flush charged accepted received sizes after all controls: {accepted_flush_errors:?}");
    }

    #[test]
    fn fragmented_multiline_events_preserve_timing_and_cold_counts() {
        let started = Instant::now();
        let first = "data: {\"tokens\":[101],\"content\":\"눈\",\"stop\":false}\r\n\r\n";
        let split = first
            .as_bytes()
            .windows("눈".len())
            .position(|part| part == "눈".as_bytes())
            .unwrap()
            + 1;
        let mut stream = CompletionStream::default();
        stream
            .push(
                &first.as_bytes()[..split],
                started + Duration::from_millis(90),
            )
            .unwrap();
        stream
            .push(
                &first.as_bytes()[split..],
                started + Duration::from_millis(100),
            )
            .unwrap();
        stream
            .push(
                "data: {\"tokens\":[102],\ndata: \"content\":\"길\",\"stop\":false}\n\n".as_bytes(),
                started + Duration::from_millis(150),
            )
            .unwrap();
        stream.push(b"data: {\"tokens\":[101,102],\"stop\":true,\"timings\":{\"prompt_n\":3,\"cache_n\":0,\"predicted_n\":2}}", started + Duration::from_millis(250)).unwrap();
        stream.finish(started + Duration::from_millis(300)).unwrap();
        let measured = stream.measurement(started, 3, 2);
        assert!(measured.error.is_none(), "{:?}", measured.error);
        assert_eq!(
            (
                measured.prompt_tokens,
                measured.completion_tokens,
                measured.cached_tokens
            ),
            (3, 2, 0)
        );
        assert_eq!(
            measured.first_token,
            Some(started + Duration::from_millis(100))
        );
        assert_eq!(
            measured.last_token,
            Some(started + Duration::from_millis(150))
        );
        assert_eq!(measured.ttft_ms(), Some(100.0));
        assert_eq!(measured.tpot_ms(), Some(50.0));

        let mut invalid = CompletionStream::default();
        assert_eq!(
            invalid.push(b"data: \xff\n\n", started).unwrap_err(),
            "invalid UTF-8 in benchmark SSE"
        );
        let mut malformed = CompletionStream::default();
        assert!(malformed
            .push(b"data: {not-json}\n\n", started)
            .unwrap_err()
            .starts_with("invalid benchmark SSE data:"));
        let mut refused = CompletionStream::default();
        assert!(refused
            .push(b"data: {\"error\":\"synthetic refusal\"}\n\n", started)
            .unwrap_err()
            .contains("runtime completion error"));
        let mut missing = CompletionStream::default();
        missing
            .push(b"data: {\"tokens\":[101],\"stop\":false}\n\n", started)
            .unwrap();
        missing.finish(started).unwrap();
        assert_eq!(
            missing.measurement(started, 3, 2).error.as_deref(),
            Some("stream ended without final token accounting")
        );
        let mut cached = CompletionStream::default();
        cached.push(b"data: {\"tokens\":[101,102],\"stop\":true,\"timings\":{\"prompt_n\":2,\"cache_n\":1,\"predicted_n\":2}}\n\n", started).unwrap();
        assert!(cached
            .measurement(started, 3, 2)
            .error
            .unwrap()
            .contains("reused 1"));
    }

    #[test]
    fn byte_partitions_preserve_events_fields_and_pending_suffix() {
        let started = Instant::now();
        let first = ": ignored comment\r\n\r\ndata: {\"tokens\":[8],\"content\":\"눈\",\"stop\":false}\r\n\r\n";
        let second = "event: ignored\r\ndata: {\"tokens\":[9],\r\ndata: \"content\":\"길\",\"stop\":false}\r\n\r\n";
        let final_piece = format!(
            "{}:unfinished comment",
            std::str::from_utf8(FINAL_ACCOUNTING_EVENT).unwrap()
        );
        let phases = [
            (first.as_bytes(), 100),
            (second.as_bytes(), 150),
            (final_piece.as_bytes(), 250),
        ];
        let received_bytes = phases.iter().map(|(bytes, _)| bytes.len()).sum::<usize>();
        let expected_final = json!({"tokens":[8,9],"stop":true,
            "timings":{"prompt_n":3,"cache_n":0,"predicted_n":2}});
        let expected_facts = json!({"prompt_tokens":3,"completion_tokens":2,"cached_tokens":0,
            "started":true,"first_token":true,"last_token":true,"first_equals_last":false,
            "ttft_ms":100.0,"tpot_ms":50.0,"error":null});
        let mut snapshots = Vec::new();
        for partition in [1, 2, 3, 7, usize::MAX] {
            let mut stream = CompletionStream::default();
            for (bytes, millis) in &phases {
                for chunk in bytes.chunks(partition) {
                    stream
                        .push(chunk, started + Duration::from_millis(*millis))
                        .unwrap();
                }
            }
            let measured = stream.measurement(started, 3, 2);
            assert_eq!(measurement_facts(&measured), expected_facts);
            assert_eq!(measured.started, Some(started));
            assert_eq!(
                measured.first_token,
                Some(started + Duration::from_millis(100))
            );
            assert_eq!(
                measured.last_token,
                Some(started + Duration::from_millis(150))
            );
            assert_eq!(stream.final_value.as_ref(), Some(&expected_final));
            assert_eq!(stream.pending, b":unfinished comment");
            assert!(stream.data.is_empty());
            assert_eq!(stream.total_bytes, received_bytes);
            let before_finish = json!({"measurement":measurement_facts(&measured),
                "final_value":stream.final_value.clone(),"pending":stream.pending.clone(),
                "data":stream.data.clone(),"received_bytes":stream.total_bytes});
            stream.finish(started + Duration::from_millis(300)).unwrap();
            let finished = stream.measurement(started, 3, 2);
            assert_eq!(measurement_facts(&finished), expected_facts);
            assert_eq!(finished.started, measured.started);
            assert_eq!(finished.first_token, measured.first_token);
            assert_eq!(finished.last_token, measured.last_token);
            assert_eq!(stream.final_value.as_ref(), Some(&expected_final));
            assert!(stream.pending.is_empty() && stream.data.is_empty());
            assert_eq!(stream.total_bytes, received_bytes);
            let after_finish = json!({"measurement":measurement_facts(&finished),
                "final_value":stream.final_value.clone(),"pending":stream.pending.clone(),
                "data":stream.data.clone(),"received_bytes":stream.total_bytes});
            snapshots.push((before_finish, after_finish));
        }
        for pair in snapshots.windows(2) {
            assert_eq!(pair[0], pair[1], "partitioning changed parser results");
        }
    }

    #[test]
    fn failed_stream_lines_preserve_remainder_for_continuation() {
        let started = Instant::now();
        let first = b"data: {\"tokens\":[8],\"stop\":false}\n\n";
        let expected_final = json!({"tokens":[8,9],"stop":true,
            "timings":{"prompt_n":3,"cache_n":0,"predicted_n":2}});
        let mut recovered = Vec::new();
        for (case, bad_lines, retained_data, remaining_event, error_prefix) in [
            (
                "UTF-8",
                b"data: {\"tokens\":[9],\r\ndata: \xff\n".as_slice(),
                vec!["{\"tokens\":[9],".to_owned()],
                "data: \"content\":\"길\",\"stop\":false}\r\n\r\n",
                "invalid UTF-8 in benchmark SSE",
            ),
            (
                "JSON",
                b"data: {not-json}\r\n\r\n".as_slice(),
                Vec::new(),
                "data: {\"tokens\":[9],\r\ndata: \"content\":\"길\",\"stop\":false}\r\n\r\n",
                "invalid benchmark SSE data:",
            ),
        ] {
            let remainder = format!(
                "{remaining_event}{}:unfinished comment",
                std::str::from_utf8(FINAL_ACCOUNTING_EVENT).unwrap()
            );
            let mut failed_chunk = bad_lines.to_vec();
            failed_chunk.extend_from_slice(remainder.as_bytes());
            let mut stream = CompletionStream::default();
            stream
                .push(first, started + Duration::from_millis(100))
                .unwrap();
            let error = stream
                .push(&failed_chunk, started + Duration::from_millis(150))
                .unwrap_err();
            assert!(error.starts_with(error_prefix), "{case}: {error}");
            assert_eq!(
                stream.pending,
                remainder.as_bytes(),
                "{case}: bad line/event must be consumed"
            );
            assert_eq!(
                stream.data, retained_data,
                "{case}: preserve the pending event state"
            );
            assert!(stream.final_value.is_none());
            assert_eq!(
                stream.first_token,
                Some(started + Duration::from_millis(100))
            );
            assert_eq!(stream.last_token, stream.first_token);
            assert_eq!(stream.total_bytes, first.len() + failed_chunk.len());
            let continuation = b" resumed\n";
            stream
                .push(continuation, started + Duration::from_millis(200))
                .unwrap();
            stream.finish(started + Duration::from_millis(250)).unwrap();
            let measured = stream.measurement(started, 3, 2);
            let facts = measurement_facts(&measured);
            assert_eq!(
                facts,
                json!({"prompt_tokens":3,"completion_tokens":2,"cached_tokens":0,
                "started":true,"first_token":true,"last_token":true,"first_equals_last":false,
                "ttft_ms":100.0,"tpot_ms":100.0,"error":null})
            );
            assert_eq!(measured.started, Some(started));
            assert_eq!(
                measured.first_token,
                Some(started + Duration::from_millis(100))
            );
            assert_eq!(
                measured.last_token,
                Some(started + Duration::from_millis(200))
            );
            assert_eq!(stream.final_value.as_ref(), Some(&expected_final));
            assert!(stream.pending.is_empty() && stream.data.is_empty());
            assert_eq!(
                stream.total_bytes,
                first.len() + failed_chunk.len() + continuation.len()
            );
            recovered.push(facts);
        }
        assert_eq!(recovered[0], recovered[1]);

        let mut oversized = CompletionStream::default();
        let error = oversized
            .push(&vec![b'x'; MAX_RESPONSE_BYTES + 1], started)
            .unwrap_err();
        assert_eq!(error, "benchmark stream exceeded its size limit");
        assert_eq!(oversized.finish(started), Err(error.clone()));
        assert_eq!(oversized.push(b"", started), Err(error));
        assert_eq!(oversized.total_bytes, MAX_RESPONSE_BYTES + 1);
        assert!(oversized.pending.is_empty() && oversized.data.is_empty());
        assert!(oversized.final_value.is_none());
    }

    #[test]
    fn fragmented_sse_uses_final_tokens_not_chunk_count() {
        let start = Instant::now();
        let mut stream = CompletionStream::default();
        stream
            .push(
                b"data: {\"content\":\"he",
                start + Duration::from_millis(100),
            )
            .unwrap();
        stream
            .push(
                b"llo\",\"tokens\":[2,3],\"stop\":false}\r\n\r\n",
                start + Duration::from_millis(150),
            )
            .unwrap();
        stream
            .push(
                b"data: {\"tokens\":[4],\"stop\":false}\n\n",
                start + Duration::from_millis(200),
            )
            .unwrap();
        stream.push(b"data: {\"stop\":true,\"timings\":{\"prompt_n\":10,\"cache_n\":0,\"predicted_n\":3}}\n\n", start + Duration::from_millis(250)).unwrap();
        let measured = stream.measurement(start, 10, 3);
        assert!(measured.error.is_none(), "{:?}", measured.error);
        assert_eq!(measured.completion_tokens, 3);
        assert!((measured.ttft_ms().unwrap() - 150.0).abs() < 0.01);
        assert!((measured.tpot_ms().unwrap() - 25.0).abs() < 0.01);
    }

    #[test]
    fn a_short_or_cached_completion_cannot_be_a_successful_measurement() {
        let now = Instant::now();
        let mut stream = CompletionStream::default();
        stream.push(b"data: {\"tokens\":[1],\"stop\":false}\n\ndata: {\"stop\":true,\"timings\":{\"prompt_n\":8,\"cache_n\":2,\"predicted_n\":1}}\n\n", now).unwrap();
        assert!(stream
            .measurement(now, 10, 2)
            .error
            .unwrap()
            .contains("output token count"));
        assert!(stream
            .measurement(now, 10, 1)
            .error
            .unwrap()
            .contains("reused"));
    }

    #[test]
    fn request_uses_exact_ids_and_disables_cache_and_early_eos() {
        let body = completion_body(&[12, 34, 56], 64, 2);
        assert_eq!(body["prompt"], json!([12, 34, 56]));
        assert_eq!(body["cache_prompt"], false);
        assert_eq!(body["ignore_eos"], true);
        assert_eq!(body["id_slot"], 2);
    }

    #[test]
    fn final_only_output_has_no_observed_decode_interval_and_missing_counts_fail() {
        let now = Instant::now();
        let mut stream = CompletionStream::default();
        stream.push(b"data: {\"tokens\":[1,2,3],\"stop\":true,\"timings\":{\"prompt_n\":10,\"cache_n\":0,\"predicted_n\":3}}\n\n", now).unwrap();
        let measured = stream.measurement(now, 10, 3);
        assert!(measured.error.is_none());
        assert!(measured.tpot_ms().is_none());
        let mut missing = CompletionStream::default();
        missing
            .push(
                b"data: {\"content\":\"one chunk is not one token\",\"stop\":true}\n\n",
                now,
            )
            .unwrap();
        assert!(missing.measurement(now, 10, 3).error.is_some());
    }

    #[test]
    fn engine_usage_proves_a_cold_prompt_only_when_cached_tokens_are_reported() {
        let now = Instant::now();
        // The first step decodes to an incomplete UTF-8 sequence: no text, one token ID.
        let steps = b"data: {\"choices\":[{\"index\":0,\"text\":\"\",\"token_ids\":[17]}]}\n\ndata: {\"choices\":[{\"index\":0,\"text\":\"ab\",\"token_ids\":[18]}]}\n\n";
        let mut reported = CompletionStream::default();
        reported.push(steps, now).unwrap();
        reported.push(b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":0}}}\n\ndata: [DONE]\n\n", now + Duration::from_millis(50)).unwrap();
        let measured = reported.measurement(now, 10, 2);
        assert!(measured.error.is_none(), "{:?}", measured.error);
        assert_eq!(measured.first_token, Some(now));
        assert_eq!(measured.cached_tokens, 0);

        let mut unreported = CompletionStream::default();
        unreported.push(steps, now).unwrap();
        unreported.push(b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n", now).unwrap();
        let measured = unreported.measurement(now, 10, 2);
        assert!(measured.error.unwrap().contains("cold prompt"));

        let mut reused = CompletionStream::default();
        reused.push(steps, now).unwrap();
        reused.push(b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":8}}}\n\n", now).unwrap();
        assert!(reused
            .measurement(now, 10, 2)
            .error
            .unwrap()
            .contains("reused 8"));
    }

    #[tokio::test]
    async fn a_stalled_stream_is_cancellable_and_does_not_invent_token_counts() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (connected_tx, connected_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let _ = socket.read(&mut bytes).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"tokens\":[42],\"stop\":false}\n\n").await.unwrap();
            connected_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_trigger = cancel.clone();
        let trigger = tokio::spawn(async move {
            connected_rx.await.unwrap();
            cancel_trigger.store(true, Ordering::Release);
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let measured = tokio::time::timeout(
            Duration::from_secs(2),
            measure(
                &Endpoint {
                    engine: None,
                    client,
                    base: format!("http://{address}"),
                    key: "test".into(),
                },
                Arc::new(vec![1, 2]),
                10,
                0,
                cancel,
                Duration::from_secs(60),
            ),
        )
        .await
        .unwrap();
        assert!(measured.error.unwrap().contains("cancelled"));
        assert_eq!(measured.completion_tokens, 0);
        trigger.await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn final_accounting_completes_without_waiting_for_connection_eof() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"tokens\":[8,9],\"stop\":true,\"timings\":{\"prompt_n\":3,\"cache_n\":0,\"predicted_n\":2}}\n\n").await.unwrap();
            std::future::pending::<()>().await;
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let measured = tokio::time::timeout(
            Duration::from_secs(2),
            measure(
                &Endpoint {
                    engine: None,
                    client,
                    base: format!("http://{address}"),
                    key: "test".into(),
                },
                Arc::new(vec![1, 2, 3]),
                2,
                0,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(60),
            ),
        )
        .await
        .unwrap();
        assert!(measured.error.is_none(), "{:?}", measured.error);
        assert_eq!(measured.completion_tokens, 2);
        assert!(measured.tpot_ms().is_none());
        server.abort();
    }
}
