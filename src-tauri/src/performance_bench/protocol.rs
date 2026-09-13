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
        let stop = value.get("stop").and_then(Value::as_bool).unwrap_or(false);
        let has_output = value
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
        self.pending.extend_from_slice(bytes);
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "invalid UTF-8 in benchmark SSE")?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                self.event(now)?;
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
            }
        }
        Ok(())
    }

    fn finish(&mut self, now: Instant) -> Result<(), String> {
        self.push(b"\n\n", now)?;
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
}

pub(super) async fn measure(
    endpoint: Endpoint,
    tokens: Arc<Vec<u32>>,
    generation: u32,
    slot: u32,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
) -> Measurement {
    let Endpoint { client, base, key } = endpoint;
    let started = Instant::now();
    let mut stream = CompletionStream::default();
    let work = async {
        let response = client
            .post(format!("{base}/completion"))
            .bearer_auth(&key)
            .json(&completion_body(&tokens, generation, slot))
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
                Endpoint {
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
                Endpoint {
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
