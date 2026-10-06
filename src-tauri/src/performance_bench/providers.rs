//! Provider protocols retain exact input/output accounting and client timing.
//!
//! vLLM 0.30.0 (Metal) and 0.31.0 accept token-ID prompts on `/v1/completions`, so each receives
//! the same corpus IDs llama-server does. mlx-vlm 0.7.6 serves only chat
//! requests; its prompts are text whose server-side encoding was constructed,
//! in the selected runtime, with the server's own template and tokenizer path
//! (`prompt_utils.apply_chat_template`, then the tokenizer with the server's
//! special-token rule) to land on the exact requested length. The engine's
//! reported `usage.prompt_tokens` is still checked against that length.
use crate::providers::{python_env, ProviderId};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

#[derive(Clone)]
pub(super) struct ProviderProtocol {
    pub provider: ProviderId,
    /// The `model` every request names: the served model, or the vLLM LoRA
    /// adapter the session routes requests to.
    pub model: String,
    /// The served base model, which `/v1/models` describes.
    pub served: String,
    pub runtime: python_env::PythonRuntimeManifest,
    pub prompts: BTreeMap<usize, String>,
    /// mlx-vlm stop tokens, suppressed so every request decodes to its limit.
    pub stop_tokens: Vec<u32>,
    pub trust_remote_code: bool,
    pub thinking_budget: Option<i64>,
}

const MLX_PROMPTS: &str = r#"
def main(job):
    from mlx_vlm.utils import load_config, load_processor, resolve_eos_token_ids
    from mlx_vlm.prompt_utils import apply_chat_template
    options = {'trust_remote_code': True} if job['trust_remote_code'] else {}
    config = load_config(job['model'], **options)
    processor = load_processor(job['model'], add_detokenizer=False, eos_token_ids=config.get('eos_token_id'), **options)
    tok = getattr(processor, 'tokenizer', processor)
    # mlx_vlm.server.generation._cpu_preprocess
    if config.get('model_type') in ('gemma3', 'gemma3n', 'gemma4', 'gemma4_unified'):
        special = getattr(processor, 'chat_template', None) is None
    else:
        special = True
    # A request that sets enable_thinking=false renders with reasoning=false too.
    template = {'enable_thinking': False, 'reasoning': False}
    if job.get('thinking_budget') is not None:
        template['thinking_budget'] = job['thinking_budget']
    def count(text):
        prompt = apply_chat_template(processor, config, [{'role': 'user', 'content': text}], num_images=0, num_audios=0, video=None, tools=None, **template)
        return len(tok(prompt, add_special_tokens=special)['input_ids'])
    ids = list(tok.encode(job['text'], add_special_tokens=False))
    if len(ids) < max(job['lengths']):
        # Too short; the caller retries with a longer corpus slice.
        emit({'tokens': ids, 'prompts': {}, 'stop_tokens': []})
        return
    prompts = {}
    for length in job['lengths']:
        take = max(1, min(len(ids), length - 32))
        seen, found = set(), None
        for _ in range(96):
            if take in seen:
                break
            seen.add(take)
            text = tok.decode(ids[:take], skip_special_tokens=False)
            delta = length - count(text)
            if delta == 0:
                found = text
                break
            take = max(1, min(len(ids), take + delta))
        if found is None:
            for take in range(max(1, take - 48), min(len(ids), take + 48) + 1):
                text = tok.decode(ids[:take], skip_special_tokens=False)
                if count(text) == length:
                    found = text
                    break
        if found is None:
            fail('cannot construct an exact %d-token chat prompt for this tokenizer and template' % length)
        prompts[str(length)] = found
    stops = resolve_eos_token_ids(config.get('eos_token_id'), tok)
    stops += [t for t in getattr(processor, 'additional_eos_token_ids', ()) if t not in stops]
    emit({'tokens': ids, 'prompts': prompts, 'stop_tokens': stops})
run(main)
"#;

impl ProviderProtocol {
    pub async fn tokenize(
        &mut self,
        client: &reqwest::Client,
        base: &str,
        key: &str,
        text: &str,
        lengths: Vec<u32>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Vec<u32>, String> {
        let value = if self.provider == ProviderId::Vllm {
            super::protocol::bounded_json(
                client
                    .post(format!("{base}/tokenize"))
                    .bearer_auth(key)
                    .json(&json!({"model":self.model,"prompt":text,"add_special_tokens":false}))
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?
        } else {
            let job = json!({"model": self.model, "trust_remote_code": self.trust_remote_code,
                "thinking_budget": self.thinking_budget, "text": text, "lengths": lengths});
            let value = crate::verify::engine::run_engine_script(&self.runtime, MLX_PROMPTS, job, Duration::from_secs(120), cancel)
                .await
                .map_err(|error| format!("the selected engine's tokenizer and chat template could not construct exact benchmark prompts: {error}"))?;
            self.prompts = serde_json::from_value(value["prompts"].clone())
                .map_err(|error| format!("invalid prepared prompt: {error}"))?;
            self.stop_tokens = serde_json::from_value(value["stop_tokens"].clone())
                .map_err(|error| format!("invalid stop tokens: {error}"))?;
            value
        };
        serde_json::from_value(value["tokens"].clone())
            .map_err(|error| format!("invalid token IDs: {error}"))
    }

    pub fn body(&self, tokens: &[u32], generation: u32) -> Result<(String, Value), String> {
        if self.provider == ProviderId::Vllm {
            // `return_token_ids` marks each decode step even when its text is an
            // incomplete UTF-8 sequence; log-probabilities would add work.
            Ok((
                "/v1/completions".into(),
                json!({"model":self.model,"prompt":tokens,"max_tokens":generation,
                "stream":true,"stream_options":{"include_usage":true},"temperature":0,"seed":42,"top_k":1,
                "ignore_eos":true,"skip_special_tokens":false,"return_token_ids":true}),
            ))
        } else {
            let prompt = self
                .prompts
                .get(&tokens.len())
                .ok_or("exact benchmark prompt was not prepared")?;
            // mlx-vlm has no ignore_eos. A large negative bias on the tokens it
            // stops on makes greedy decoding run to max_tokens instead.
            let bias: serde_json::Map<String, Value> = self
                .stop_tokens
                .iter()
                .map(|id| (id.to_string(), json!(-1.0e9)))
                .collect();
            let mut body = json!({"model":self.model,"messages":[{"role":"user","content":prompt}],
                "max_tokens":generation,"stream":true,"stream_options":{"include_usage":true},
                "temperature":0,"seed":42,"top_k":1,"top_p":1.0,"min_p":0.0,
                "enable_thinking":false,"reasoning":false,"logit_bias":bias});
            // Match every template argument used by the preparation helper.
            if let Some(budget) = self.thinking_budget {
                body["thinking_budget"] = json!(budget);
            }
            Ok(("/v1/chat/completions".into(), body))
        }
    }

    /// The per-sequence capacity the running engine reports, checked against
    /// what the workload needs: vLLM's `max_model_len`, or mlx-vlm's configured
    /// per-request KV cache allocation (`max_kv_size`), which bounds the cache
    /// rather than the model's positional context.
    pub async fn verify_settings(
        &self,
        client: &reqwest::Client,
        base: &str,
        key: &str,
        required: u32,
    ) -> Result<u32, String> {
        if self.provider == ProviderId::Vllm {
            let models = super::protocol::bounded_json(
                client
                    .get(format!("{base}/v1/models"))
                    .bearer_auth(key)
                    .send()
                    .await
                    .map_err(|error| format!("cannot verify benchmark server settings: {error}"))?,
            )
            .await?;
            vllm_context(&models, &self.served, required)
        } else {
            let settings = super::protocol::bounded_json(
                client
                    .get(format!("{base}/v1/settings"))
                    .bearer_auth(key)
                    .send()
                    .await
                    .map_err(|error| format!("cannot verify benchmark server settings: {error}"))?,
            )
            .await?;
            mlx_context(&settings, required)
        }
    }

    pub async fn reset_cache(
        &self,
        client: &reqwest::Client,
        base: &str,
        key: &str,
    ) -> Result<(), String> {
        if self.provider == ProviderId::MlxVlm {
            let response = client
                .post(format!("{base}/v1/cache/reset"))
                .bearer_auth(key)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            super::protocol::bounded_json(response).await?;
        }
        Ok(())
    }
}

fn checked_context(per_sequence: Option<u64>, required: u32, source: &str) -> Result<u32, String> {
    let per_sequence = per_sequence
        .ok_or_else(|| format!("runtime did not report its per-sequence context ({source})"))?;
    if per_sequence < u64::from(required) {
        return Err(format!("runtime context mismatch: need {required} tokens per sequence; {source} is {per_sequence}"));
    }
    u32::try_from(per_sequence).map_err(|_| "runtime reported an invalid context size".into())
}

/// vLLM 0.30.0/0.31.0 `/v1/models` carries each served model's `max_model_len`.
fn vllm_context(models: &Value, served: &str, required: u32) -> Result<u32, String> {
    let card = models
        .get("data")
        .and_then(Value::as_array)
        .and_then(|cards| {
            cards
                .iter()
                .find(|card| card.get("id").and_then(Value::as_str) == Some(served))
        });
    checked_context(
        card.and_then(|card| card.get("max_model_len"))
            .and_then(Value::as_u64),
        required,
        "max_model_len",
    )
}

/// mlx-vlm 0.7.6 `/v1/settings` reports the live runtime configuration. Its
/// `max_kv_size` is the KV cache each request is allocated (a rotating cache
/// would drop older tokens past it), not the model's positional context; the
/// benchmark records it as the per-sequence allocation. Prefix caching must be
/// off for a cold measurement.
fn mlx_context(settings: &Value, required: u32) -> Result<u32, String> {
    let current = settings
        .get("current")
        .ok_or("runtime did not report its settings")?;
    if current.get("apc_enabled").and_then(Value::as_bool) != Some(false) {
        return Err("prefix caching is enabled in the benchmark runtime; disable it for a cold-prompt measurement".into());
    }
    checked_context(
        current.get("max_kv_size").and_then(Value::as_u64),
        required,
        "max_kv_size",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protocol(provider: ProviderId) -> ProviderProtocol {
        ProviderProtocol {
            provider,
            model: "adapter".into(),
            served: "base".into(),
            runtime: python_env::PythonRuntimeManifest {
                format: 1,
                provider,
                id: "synthetic".into(),
                kind: python_env::InstallationKind::Managed,
                python: "python".into(),
                requested_version: None,
                probe: None,
            },
            prompts: BTreeMap::from([(3, "exact text".into())]),
            stop_tokens: vec![2, 106],
            trust_remote_code: false,
            thinking_budget: None,
        }
    }

    #[test]
    fn vllm_requests_name_the_routed_model_and_mark_steps_without_logprobs() {
        let (path, body) = protocol(ProviderId::Vllm).body(&[5, 6, 7], 64).unwrap();
        assert_eq!(path, "/v1/completions");
        assert_eq!(body["model"], "adapter");
        assert_eq!(body["prompt"], json!([5, 6, 7]));
        assert_eq!(body["ignore_eos"], true);
        assert_eq!(body["return_token_ids"], true);
        assert!(body.get("logprobs").is_none());
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn mlx_requests_use_the_prepared_prompt_and_suppress_every_stop_token() {
        let mut engine = protocol(ProviderId::MlxVlm);
        engine.thinking_budget = Some(32);
        let (path, body) = engine.body(&[5, 6, 7], 64).unwrap();
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(body["messages"][0]["content"], "exact text");
        assert_eq!(body["enable_thinking"], false);
        assert_eq!(body["reasoning"], false);
        assert_eq!(body["thinking_budget"], 32);
        assert_eq!(body["logit_bias"], json!({"2": -1.0e9, "106": -1.0e9}));
        assert!(
            engine.body(&[5, 6], 64).is_err(),
            "an unprepared length has no exact prompt"
        );
    }

    #[test]
    fn vllm_context_comes_from_the_served_model_card() {
        let models = json!({"data": [
            {"id": "adapter", "parent": "base", "max_model_len": 99999},
            {"id": "base", "max_model_len": 1280},
        ]});
        assert_eq!(vllm_context(&models, "base", 1200), Ok(1280));
        assert!(vllm_context(&models, "base", 2000)
            .unwrap_err()
            .contains("need 2000"));
        assert!(vllm_context(&json!({"data": [{"id": "base"}]}), "base", 1)
            .unwrap_err()
            .contains("did not report"));
        assert!(vllm_context(&models, "missing", 1).is_err());
    }

    #[test]
    fn mlx_context_requires_a_bounded_cold_cache() {
        let settings =
            |apc: Value, size: Value| json!({"current": {"apc_enabled": apc, "max_kv_size": size}});
        assert_eq!(
            mlx_context(&settings(json!(false), json!(1280)), 1200),
            Ok(1280)
        );
        assert!(mlx_context(&settings(json!(true), json!(1280)), 1200)
            .unwrap_err()
            .contains("prefix caching"));
        assert!(mlx_context(&settings(json!(false), Value::Null), 1200)
            .unwrap_err()
            .contains("did not report"));
        assert!(mlx_context(&settings(json!(false), json!(512)), 1200)
            .unwrap_err()
            .contains("need 1200"));
        assert!(mlx_context(&json!({}), 1).is_err());
    }
}
