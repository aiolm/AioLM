//! Resolve tasks from the owned, ready runtime, including config-file overrides.
use super::{set_llama_mode, LlamaMode};
use crate::providers::{protocol::EngineInfo, ProviderId};
use serde_json::{json, Value};

const PROBE_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;

async fn response_json(mut response: reqwest::Response) -> Result<(u16, Value), String> {
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len().saturating_add(chunk.len()) > PROBE_RESPONSE_LIMIT {
            return Err("runtime task probe response exceeds 2 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body =
        serde_json::from_slice(&bytes).map_err(|_| "runtime task probe returned invalid JSON")?;
    Ok((status, body))
}

fn not_supported(status: u16, body: &Value) -> bool {
    status == 501
        && body.pointer("/error/type").and_then(Value::as_str) == Some("not_supported_error")
}

/// Called only after health, model identity and listener ownership pass. Help
/// describes argv syntax; it cannot tell us how a runtime-read config changes
/// the API. b11460/b11617 reject rerank/embedding tasks before computing when
/// they are disabled. Empty rerank documents are always rejected before work.
/// Unknown responses are a verification error, never certified capabilities.
pub async fn confirm_ready(
    mut info: EngineInfo,
    client: &reqwest::Client,
    url: &str,
    key: &str,
    deadline: std::time::Instant,
) -> Result<EngineInfo, String> {
    if info.provider != ProviderId::Llama {
        return Ok(info);
    }
    let request = |endpoint: &str| {
        let request = client
            .post(format!(
                "{}{endpoint}",
                url.trim_end_matches('/').trim_end_matches("/v1")
            ))
            .timeout(deadline.saturating_duration_since(std::time::Instant::now()));
        if key.is_empty() {
            request
        } else {
            request.bearer_auth(key)
        }
    };
    let (status, body) = response_json(
        request("/v1/rerank")
            .json(&json!({"query":"", "documents":[]}))
            .send()
            .await
            .map_err(|e| format!("could not verify runtime rerank mode: {e}"))?,
    )
    .await?;
    if !not_supported(status, &body) {
        if status == 400
            && body.pointer("/error/type").and_then(Value::as_str) == Some("invalid_request_error")
            && body.pointer("/error/message").and_then(Value::as_str)
                == Some("\"documents\" must be a non-empty string array")
        {
            return set_llama_mode(&mut info, LlamaMode::Rerank, "").map(|()| info);
        }
        return Err(format!("could not verify this runtime's rerank mode (HTTP {status}); no task was certified. Review its API/adapter before retrying"));
    }
    let (status, body) = response_json(
        request("/v1/embeddings")
            .json(&json!({"input":"a"}))
            .send()
            .await
            .map_err(|e| format!("could not verify runtime embedding mode: {e}"))?,
    )
    .await?;
    let mode = if not_supported(status, &body) {
        // Disabled embeddings do not prove logits exist (e.g. BERT loaded
        // without --embedding). Verify one native generation token. Embedding
        // and rerank contexts never reach this request.
        let (generation_status, generation) = response_json(
            request("/completion")
                .json(&json!({"prompt":"a", "n_predict":1, "temperature":0, "cache_prompt":false, "stream":false}))
                .send().await.map_err(|e| format!("could not verify runtime generation: {e}"))?,
        ).await?;
        if generation_status != 200
            || !generation.get("content").is_some_and(Value::is_string)
            || generation
                .get("tokens_evaluated")
                .and_then(Value::as_u64)
                .is_none_or(|n| n == 0)
        {
            return Err(format!("the ready runtime did not verify generation (HTTP {generation_status}); review its task mode and selected model before retrying"));
        }
        LlamaMode::Generate
    } else if status == 200
        && body
            .pointer("/data/0/embedding")
            .and_then(Value::as_array)
            .is_some_and(|vector| {
                !vector.is_empty()
                    && vector
                        .iter()
                        .all(|n| n.as_f64().is_some_and(f64::is_finite))
            })
    {
        LlamaMode::Embed
    } else {
        return Err(format!("could not verify usable OpenAI embeddings from this runtime (HTTP {status}); review its task mode and pooling settings before retrying"));
    };
    let model = info.upstream_model.clone();
    set_llama_mode(&mut info, mode, &model)?;
    Ok(info)
}
