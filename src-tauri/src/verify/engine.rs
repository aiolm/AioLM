//! Deep accuracy verification for Python engines.
//!
//! The llama.cpp check scores the user's weights twice with `llama-perplexity`,
//! on the host and on the selected devices, and judges the median KL divergence.
//! Python engines ship no such tool, so the same comparison runs through each
//! engine's own package inside the selected runtime:
//!
//! - mlx-vlm: MLX arrays are not bound to a device, so one loaded model is
//!   evaluated on the Metal GPU and on the MLX CPU device over identical token
//!   IDs. The script returns the exact full-vocabulary KL divergence and both
//!   negative log-likelihoods for every scored position. This is a direct
//!   translation of the llama.cpp check and is judged by the same limits.
//! - vLLM: CUDA, ROCm, XPU and Metal runtimes return at
//!   most `max_logprobs` entries per position, never full logits. The device
//!   pass records vLLM's top-k prompt log-probabilities; a transformers float32
//!   CPU pass over the same token IDs is the reference. Splitting the vocabulary
//!   into the returned tokens and everything else gives a lower bound on the KL
//!   divergence (log-sum inequality), and the target token gives an exact
//!   perplexity ratio. A bound or ratio over its limit is definite evidence of a
//!   fault. Anything else says nothing about the full distribution, so it is
//!   reported as `unsupported` with partial coverage, never as a pass.
//!
//! Every verdict is keyed by the provider, runtime version and accelerator, the
//! model and adapter fingerprints, the saved engine options and the machine, so a
//! failure blocks only that exact combination and a corrected runtime, model or
//! setting is measured afresh.
use super::{
    decide, load_cache, record, refusal, store_deep, Record, Verdict, DEEP_CTX, DEEP_PASS_TIMEOUT,
    MAX_MEDIAN_KLD, MAX_PERPLEXITY_RATIO, PROBE_CHUNKS, PROBE_TEXT, SUITE_VERSION,
};
use crate::config::AppConfig;
use crate::providers::{
    artifacts::{self, ArtifactFormat, ModelArtifact},
    launch,
    python_env::{self, InstallationKind, PythonRuntimeManifest},
    ProviderId,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc};
use std::time::Duration;

pub(crate) const MLX_METHOD: &str = "mlx-host-device-kld";
pub(crate) const VLLM_METHOD: &str = "vllm-topk-partition-kld";

/// vLLM's default `max_logprobs`; raising it does not make the comparison exact.
const TOP_K: u32 = 20;
/// Bump when a script or comparison changes meaning.
const ENGINE_SUITE_VERSION: u32 = 2;
const OUTPUT_CAP: usize = 64 * 1024 * 1024;
const RESULT_MARKER: &str = "AIOLM_RESULT=";
const ERROR_MARKER: &str = "AIOLM_ERROR=";
/// Floor for the device mass outside the returned tokens. Rounding can push
/// `1 - sum` slightly below zero when the returned tokens hold nearly all of it.
const REST_FLOOR: f64 = 1e-12;
/// The float32 CPU reference must fit in memory beside the desktop.
const REFERENCE_MEMORY_FRACTION: f64 = 0.85;

/// Shared by every script: errors are reported on stdout because helper stderr
/// is discarded, and only marked lines are trusted.
const PRELUDE: &str = r#"
import json, math, sys
def emit(value):
    print('AIOLM_RESULT=' + json.dumps(value))
def fail(message):
    print('AIOLM_ERROR=' + json.dumps(str(message)[:2000]))
    sys.exit(3)
def finite(value):
    value = float(value)
    return value if math.isfinite(value) else None
def chunked(tok, text, ctx, count):
    ids = list(tok.encode(text, add_special_tokens=False))
    chunks = [ids[i * ctx:(i + 1) * ctx] for i in range(min(count, len(ids) // ctx))]
    if not chunks:
        fail('the probe text has %d tokens for this tokenizer, fewer than one %d-token chunk' % (len(ids), ctx))
    bos = getattr(tok, 'bos_token_id', None)
    if bos is not None and list(tok.encode('a', add_special_tokens=True))[:1] == [bos]:
        chunks = [[bos] + chunk[1:] for chunk in chunks]
    return len(ids), chunks
def run(main):
    try:
        with open(sys.argv[1], encoding='utf-8') as file:
            main(json.load(file))
    except SystemExit:
        raise
    except BaseException as error:
        fail('%s: %s' % (type(error).__name__, error))
"#;

const MLX_SCRIPT: &str = r#"
def main(job):
    import mlx.core as mx
    from mlx_vlm.utils import load
    from mlx_vlm.models import cache as prompt_cache
    model, processor = load(job['model'], adapter_path=job.get('adapter'), trust_remote_code=job['trust_remote_code'])
    tok = getattr(processor, 'tokenizer', processor)
    tokens, chunks = chunked(tok, job['text'], job['ctx'], job['chunks'])
    def log_probs(chunk, device):
        mx.set_default_device(device)
        x = mx.array([chunk])
        embedded = model.get_input_embeddings(x, None, mask=None)
        extra = {k: v for k, v in embedded.to_dict().items() if k != 'inputs_embeds' and v is not None}
        cache = prompt_cache.make_prompt_cache(model.language_model, job.get('max_kv_size'))
        out = model.language_model(x, inputs_embeds=embedded.inputs_embeds, cache=cache, **extra)
        logits = (out.logits if hasattr(out, 'logits') else out)[0].astype(mx.float32)
        if logits.shape[0] != len(chunk):
            fail('the model returned logits for %d of %d positions' % (logits.shape[0], len(chunk)))
        result = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
        mx.eval(result)
        return result
    first = job['ctx'] // 2
    kld, host_nll, device_nll = [], [], []
    for chunk in chunks:
        host = log_probs(chunk, mx.cpu)
        device = log_probs(chunk, mx.gpu)
        mx.set_default_device(mx.cpu)
        host, device = host[first:-1], device[first:-1]
        targets = mx.array(chunk[first + 1:])[:, None]
        per = mx.sum(mx.exp(host) * (host - device), axis=-1)
        hn = -mx.take_along_axis(host, targets, axis=-1)[:, 0]
        dn = -mx.take_along_axis(device, targets, axis=-1)[:, 0]
        mx.eval(per, hn, dn)
        kld += [finite(v) for v in per.tolist()]
        host_nll += [finite(v) for v in hn.tolist()]
        device_nll += [finite(v) for v in dn.tolist()]
    emit({'tokens': tokens, 'chunks': len(chunks), 'kld': kld, 'host_nll': host_nll, 'device_nll': device_nll})
run(main)
"#;

const VLLM_DEVICE_SCRIPT: &str = r#"
def main(job):
    from vllm import LLM, SamplingParams, TokensPrompt
    if job.get('variant') == 'vllm-metal':
        from importlib.metadata import version
        from vllm.platforms import current_platform
        from vllm_metal.config import get_config
        import mlx.core as mx
        if version('vllm-metal') != job['plugin_version'] or version('vllm') != job['core_version']:
            fail('the installed vLLM core or Metal plugin changed since the runtime probe; probe it again')
        if not type(current_platform).__module__.startswith('vllm_metal.'):
            fail('the selected runtime did not activate the vllm-metal platform')
        if get_config().mlx_device != 'gpu' or not mx.metal.is_available():
            fail('the selected vllm-metal runtime has no active Metal GPU path')
    lora = job.get('lora')
    # One token beyond the scored chunk leaves room for the single generated
    # token the request must ask for; only prompt positions are scored.
    llm = LLM(model=job['model'], max_model_len=job['ctx'] + 1, max_logprobs=job['top_k'], enable_prefix_caching=False, enable_lora=bool(lora), **job['engine'])
    tokens, chunks = chunked(llm.get_tokenizer(), job['text'], job['ctx'], job['chunks'])
    request = None
    if lora:
        from vllm.lora.request import LoRARequest
        request = LoRARequest(lora['name'], 1, lora['path'])
    params = SamplingParams(max_tokens=1, temperature=0.0, prompt_logprobs=job['top_k'])
    outputs = llm.generate([TokensPrompt(prompt_token_ids=chunk) for chunk in chunks], params, lora_request=request, use_tqdm=False)
    first = job['ctx'] // 2
    positions = []
    for chunk, output in zip(chunks, outputs):
        entries = output.prompt_logprobs
        if entries is None or len(entries) != len(chunk):
            fail('vLLM returned prompt log-probabilities for %s of %d positions' % (None if entries is None else len(entries), len(chunk)))
        for t in range(first, len(chunk) - 1):
            entry = entries[t + 1]
            ids = sorted(int(k) for k in entry)
            positions.append({'target': chunk[t + 1], 'ids': ids, 'logprobs': [finite(entry[i].logprob) for i in ids]})
    emit({'tokens': tokens, 'chunks': chunks, 'positions': positions})
run(main)
"#;

const VLLM_REFERENCE_SCRIPT: &str = r#"
def main(job):
    import torch, transformers
    torch.set_grad_enabled(False)
    major = int(transformers.__version__.split('.')[0])
    kwargs = {'local_files_only': True, 'trust_remote_code': job['trust_remote_code'], 'low_cpu_mem_usage': True}
    kwargs['dtype' if major >= 5 else 'torch_dtype'] = torch.float32
    model, errors = None, []
    for name in ('AutoModelForCausalLM', 'AutoModelForImageTextToText'):
        factory = getattr(transformers, name, None)
        if factory is None:
            continue
        try:
            model = factory.from_pretrained(job['model'], **kwargs)
            break
        except (ValueError, KeyError) as error:
            errors.append('%s: %s' % (name, error))
    if model is None:
        fail('transformers cannot load this checkpoint as a text model for the CPU reference: ' + '; '.join(errors))
    if job.get('adapter'):
        try:
            from peft import PeftModel
        except ImportError:
            fail('the CPU reference needs the peft package in this runtime to apply the LoRA adapter')
        model = PeftModel.from_pretrained(model, job['adapter'])
    model = model.float().to('cpu').eval()
    first = job['ctx'] // 2
    positions, index = [], 0
    for chunk in job['chunks']:
        logits = model(input_ids=torch.tensor([chunk])).logits[0].float()
        if logits.shape[0] != len(chunk):
            fail('the reference returned logits for %d of %d positions' % (logits.shape[0], len(chunk)))
        rows = torch.log_softmax(logits, dim=-1)
        for t in range(first, len(chunk) - 1):
            ids = job['positions'][index]['ids']
            index += 1
            positions.append({'target': chunk[t + 1], 'ids': ids, 'logprobs': [finite(rows[t][i].item()) for i in ids]})
    emit({'positions': positions})
run(main)
"#;

#[derive(Debug, Deserialize)]
struct MlxOutput {
    chunks: usize,
    kld: Vec<Option<f64>>,
    host_nll: Vec<Option<f64>>,
    device_nll: Vec<Option<f64>>,
}

#[derive(Debug, Deserialize, Serialize)]
struct Position {
    target: u32,
    ids: Vec<u32>,
    logprobs: Vec<Option<f64>>,
}

#[derive(Debug, Deserialize, Serialize)]
struct DeviceOutput {
    chunks: Vec<Vec<u32>>,
    positions: Vec<Position>,
}

#[derive(Debug, Deserialize)]
struct ReferenceOutput {
    positions: Vec<Position>,
}

fn scored_per_chunk(ctx: usize) -> usize {
    ctx - ctx / 2 - 1
}

fn deep_ctx() -> usize {
    DEEP_CTX.parse().expect("deep context is a number")
}

fn deep_chunks() -> usize {
    PROBE_CHUNKS.parse().expect("probe chunk count is a number")
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    Some(if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    })
}

/// `PPL(device) / PPL(host)` over the same targets, the quantity
/// `llama-perplexity` prints as `Mean PPL(Q)/PPL(base)`.
fn perplexity_ratio(host_nll: &[f64], device_nll: &[f64]) -> Option<f64> {
    if host_nll.is_empty() || host_nll.len() != device_nll.len() {
        return None;
    }
    let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len() as f64;
    Some((mean(device_nll) - mean(host_nll)).exp()).filter(|value| value.is_finite())
}

/// KL(host || device) over the partition {each returned token} plus {the rest of
/// the vocabulary}. Coarsening a distribution never increases KL divergence, so
/// this is a lower bound on the full-vocabulary value.
fn partition_kld(host: &[f64], device: &[f64]) -> f64 {
    let (mut divergence, mut host_mass, mut device_mass) = (0.0, 0.0, 0.0);
    for (host, device) in host.iter().zip(device) {
        let probability = host.exp();
        divergence += probability * (host - device);
        host_mass += probability;
        device_mass += device.exp();
    }
    let host_rest = (1.0 - host_mass).max(0.0);
    let device_rest = (1.0 - device_mass).max(REST_FLOOR);
    if host_rest > 0.0 {
        divergence += host_rest * (host_rest.ln() - device_rest.ln());
    }
    divergence.max(0.0)
}

fn engine_record(
    method: &str,
    coverage: &str,
    verdict: Verdict,
    ratio: Option<f64>,
    detail: String,
) -> Record {
    let mut value = record(verdict, ratio, detail);
    value.method = Some(method.into());
    value.coverage = Some(coverage.into());
    value
}

fn mlx_verdict(output: &MlxOutput, ctx: usize) -> Record {
    let unsupported =
        |detail: String| engine_record(MLX_METHOD, "full", Verdict::Unsupported, None, detail);
    let expected = output.chunks * scored_per_chunk(ctx);
    if output.chunks == 0
        || [
            output.kld.len(),
            output.host_nll.len(),
            output.device_nll.len(),
        ]
        .iter()
        .any(|length| *length != expected)
    {
        return unsupported(format!(
            "the comparison returned an incomplete set of positions (expected {expected})."
        ));
    }
    let Some(host_nll) = output.host_nll.iter().copied().collect::<Option<Vec<_>>>() else {
        return unsupported(
            "the MLX CPU reference produced non-finite values, so it cannot be the reference."
                .into(),
        );
    };
    let (Some(kld), Some(device_nll)) = (
        output.kld.iter().copied().collect::<Option<Vec<_>>>(),
        output
            .device_nll
            .iter()
            .copied()
            .collect::<Option<Vec<_>>>(),
    ) else {
        return engine_record(
            MLX_METHOD,
            "full",
            Verdict::Fail,
            None,
            "the Metal pass produced non-finite log-probabilities where the MLX CPU reference did not.".into(),
        );
    };
    let (Some(median_kld), Some(ratio)) = (median(&kld), perplexity_ratio(&host_nll, &device_nll))
    else {
        return unsupported("the comparison produced no usable statistics.".into());
    };
    let mut value = engine_record(
        MLX_METHOD,
        "full",
        decide(median_kld, ratio, None),
        Some(ratio),
        format!(
            "Deep verification of these weights: median full-vocabulary KL divergence {median_kld:.6} against a limit of {MAX_MEDIAN_KLD}, Metal GPU against the MLX CPU device over {} identical positions.",
            kld.len()
        ),
    );
    value.median_kld = Some(median_kld);
    value
}

fn vllm_verdict(device: &DeviceOutput, reference: &ReferenceOutput) -> Record {
    let partial = |verdict, ratio, detail| {
        let mut value = engine_record(VLLM_METHOD, "partial", verdict, ratio, detail);
        value.top_k = Some(TOP_K);
        value
    };
    let aligned = !device.positions.is_empty()
        && device.positions.len() == reference.positions.len()
        && device
            .positions
            .iter()
            .zip(&reference.positions)
            .all(|(device, host)| {
                device.target == host.target
                    && device.ids == host.ids
                    && device.ids.len() == device.logprobs.len()
                    && host.ids.len() == host.logprobs.len()
                    && device.ids.contains(&device.target)
            });
    if !aligned {
        return partial(
            Verdict::Unsupported,
            None,
            "the reference pass did not score the same token positions as the vLLM pass.".into(),
        );
    }
    let (mut bounds, mut host_nll, mut device_nll) = (Vec::new(), Vec::new(), Vec::new());
    for (device, host) in device.positions.iter().zip(&reference.positions) {
        let Some(host_values) = host.logprobs.iter().copied().collect::<Option<Vec<_>>>() else {
            return partial(
                Verdict::Unsupported,
                None,
                "the transformers CPU reference produced non-finite values, so it cannot be the reference.".into(),
            );
        };
        let Some(device_values) = device.logprobs.iter().copied().collect::<Option<Vec<_>>>()
        else {
            return partial(
                Verdict::Fail,
                None,
                "vLLM produced non-finite prompt log-probabilities where the CPU reference did not.".into(),
            );
        };
        let target = device
            .ids
            .iter()
            .position(|id| *id == device.target)
            .expect("aligned target");
        bounds.push(partition_kld(&host_values, &device_values));
        host_nll.push(-host_values[target]);
        device_nll.push(-device_values[target]);
    }
    let (Some(bound), Some(ratio)) = (median(&bounds), perplexity_ratio(&host_nll, &device_nll))
    else {
        return partial(
            Verdict::Unsupported,
            None,
            "the comparison produced no usable statistics.".into(),
        );
    };
    let mut value = if decide(bound, ratio, None) == Verdict::Fail {
        partial(
            Verdict::Fail,
            Some(ratio),
            format!(
                "vLLM diverged from a transformers float32 CPU reference over {} identical positions: the median KL divergence is at least {bound:.6} (limit {MAX_MEDIAN_KLD}) and the exact perplexity ratio is {ratio:.3} (limit {MAX_PERPLEXITY_RATIO:.0}).",
                bounds.len()
            ),
        )
    } else {
        partial(
            Verdict::Unsupported,
            Some(ratio),
            format!(
                "No fault detected, but vLLM returns only the top {TOP_K} log-probabilities per position, so the full-distribution divergence is unknown. Over {} positions against a transformers float32 CPU reference: median KL lower bound {bound:.6} (limit {MAX_MEDIAN_KLD}), exact perplexity ratio {ratio:.3}.",
                bounds.len()
            ),
        )
    };
    value.median_kld_lower_bound = Some(bound);
    value
}

/// True when the runtime's own probe reports a device path to compare against
/// the host.
fn uses_device(provider: ProviderId, variant: &str, accelerator: &str) -> bool {
    match provider {
        ProviderId::Vllm if variant == "vllm-metal" => accelerator == "metal",
        ProviderId::Vllm => ["cuda", "rocm", "xpu"].contains(&accelerator),
        ProviderId::MlxVlm => accelerator == "metal",
        ProviderId::Llama => false,
    }
}

/// Bytes per parameter declared by `config.json`, defaulting to two because
/// every half-precision checkpoint needs twice its file size in float32.
fn declared_parameter_bytes(model: &Path) -> u64 {
    let dtype = std::fs::read(model.join("config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|config| {
            ["torch_dtype", "dtype"]
                .iter()
                .find_map(|key| config.get(*key).and_then(Value::as_str).map(str::to_owned))
        });
    if dtype.as_deref() == Some("float32") {
        4
    } else {
        2
    }
}

/// Free-form engine arguments change the computation in ways the comparison
/// cannot mirror, so a verdict would describe a different launch.
fn extra_arguments(options: &Map<String, Value>) -> Option<String> {
    options
        .get(crate::providers::options::EXTRA_ARGS_KEY)
        .and_then(Value::as_array)
        .is_some_and(|args| !args.is_empty())
        .then(|| "the saved settings pass extra engine arguments that this comparison cannot reproduce; remove them to verify the launch as configured.".into())
}

/// Why the MLX comparison would not describe the configured launch, if it would not.
fn mlx_prerequisite(options: &Map<String, Value>) -> Option<String> {
    if let Some(reason) = extra_arguments(options) {
        return Some(reason);
    }
    ["kv_bits", "kv_quant_scheme", "kv_group_size", "quantized_kv_start"]
        .iter()
        .any(|key| options.get(*key).is_some_and(|value| !value.is_null()))
        .then(|| "the saved mlx-vlm settings quantize the KV cache, and this comparison runs the unquantized cache path; clear the KV quantization settings to verify the launch.".into())
}

/// Why the vLLM comparison cannot produce a meaningful reference, if it cannot.
fn vllm_prerequisite(
    artifact: &ModelArtifact,
    options: &Map<String, Value>,
    parameter_bytes: u64,
    system_memory: Option<u64>,
) -> Option<String> {
    if let Some(reason) = extra_arguments(options) {
        return Some(reason);
    }
    if options.get("runner").and_then(Value::as_str) == Some("pooling") {
        return Some("a pooling session serves embeddings; deep verification scores next-token distributions of a generation session.".into());
    }
    if artifact.format != ArtifactFormat::HfSafetensors {
        return Some("the transformers CPU reference needs an unquantized Hugging Face safetensors snapshot; MLX conversions and GGUF weights cannot serve as this reference.".into());
    }
    if let Some(quantization) = &artifact.quantization {
        return Some(format!(
            "this checkpoint is quantized ({quantization}); the float32 CPU reference cannot execute it, and comparing against dequantized weights would measure quantization error instead of the device path."
        ));
    }
    if options
        .get("quantization")
        .is_some_and(|value| !value.is_null())
    {
        return Some("the saved vLLM settings quantize the weights at load time, which the float32 CPU reference cannot reproduce; clear the quantization setting to verify the device path.".into());
    }
    if options
        .get("kv_cache_dtype")
        .and_then(Value::as_str)
        .is_some_and(|value| value != "auto")
    {
        return Some("the saved vLLM settings quantize the KV cache, which the float32 CPU reference cannot reproduce; set the KV cache type to auto to verify the device path.".into());
    }
    if options
        .get("additional_config")
        .and_then(|value| value.get("turboquant"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Some("the saved Metal settings enable TurboQuant KV compression, which the float32 CPU reference cannot reproduce; disable TurboQuant to verify the device path.".into());
    }
    if options.get("hf_overrides").is_some_and(|value| {
        !value.is_null() && value.as_object().is_none_or(|map| !map.is_empty())
    }) {
        return Some("the saved vLLM settings override the model configuration, which this CPU reference cannot reproduce; clear hf_overrides to verify the launch.".into());
    }
    if options
        .get("hf_config_path")
        .is_some_and(|value| !value.is_null())
    {
        return Some("the saved vLLM settings select a separate Hugging Face configuration, which this CPU reference cannot reproduce; clear hf_config_path to verify the launch.".into());
    }
    let required = artifact.size_bytes.saturating_mul(4) / parameter_bytes.max(1);
    match system_memory {
        Some(total) if (required as f64) <= total as f64 * REFERENCE_MEMORY_FRACTION => None,
        Some(total) => Some(format!(
            "the float32 CPU reference needs about {:.1} GiB of RAM for these weights; this machine has {:.1} GiB.",
            required as f64 / 1024f64.powi(3),
            total as f64 / 1024f64.powi(3)
        )),
        None => Some("system memory could not be read, so the float32 CPU reference cannot be sized safely.".into()),
    }
}

/// Engine options the offline vLLM pass mirrors from the launch. Sampling,
/// serving, tool and speculative settings do not change prompt
/// log-probabilities; the target model scores the prompt either way.
fn vllm_engine_kwargs(options: &Map<String, Value>) -> Map<String, Value> {
    [
        "dtype",
        "tensor_parallel_size",
        "pipeline_parallel_size",
        "enforce_eager",
        "trust_remote_code",
        "gpu_memory_utilization",
        "cpu_offload_gb",
        "kv_cache_dtype",
        "max_lora_rank",
        "max_loras",
        "max_num_batched_tokens",
        "enable_chunked_prefill",
        "tokenizer",
        "tokenizer_mode",
        "load_format",
        "hf_config_path",
        "additional_config",
        "seed",
    ]
    .iter()
    .filter_map(|key| {
        options
            .get(*key)
            .map(|value| ((*key).to_owned(), value.clone()))
    })
    .collect()
}

fn fingerprint(path: &Path) -> String {
    if path.is_dir() {
        let revision = artifacts::inspect_snapshot(path).revision;
        artifacts::local_fingerprint(path, revision.as_deref())
    } else {
        let mut digest = Sha256::new();
        digest.update(path.as_os_str().as_encoded_bytes());
        if let Ok(stamp) = crate::benchmark::identity::stamp(path) {
            digest.update(serde_json::to_vec(&stamp).unwrap_or_default());
        }
        // File-based models load configuration/tokenizer companions. Include
        // their identities without scanning unrelated models in the parent.
        for name in [
            "config.json",
            "generation_config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "special_tokens_map.json",
            "added_tokens.json",
            "vocab.json",
            "merges.txt",
            "tokenizer.model",
            "processor_config.json",
            "preprocessor_config.json",
            "chat_template.jinja",
        ] {
            let companion = path.with_file_name(name);
            digest.update(name.as_bytes());
            if let Ok(stamp) = crate::benchmark::identity::stamp(&companion) {
                digest.update(serde_json::to_vec(&stamp).unwrap_or_default());
                // Companions are small; bounded content also catches same-size edits.
                use std::io::Read;
                if let Ok(file) = std::fs::File::open(&companion) {
                    let mut bytes = Vec::new();
                    if file.take(4 * 1024 * 1024).read_to_end(&mut bytes).is_ok() {
                        digest.update(bytes);
                    }
                }
            }
        }
        format!("{:x}", digest.finalize())
    }
}

/// The key a Python engine verdict is stored under. Every input that changes
/// the computation is included, so a verdict never covers another runtime
/// version, model state, adapter or setting.
pub(crate) fn engine_key(
    cfg: &AppConfig,
    runtime: &PythonRuntimeManifest,
    hardware_fingerprint: &str,
) -> String {
    let probe = runtime.probe.clone().unwrap_or_default();
    // These inherited GPU controls change the executed devices or kernels
    // without changing the hardware inventory. Store only their digest.
    let device_environment = device_environment_identity(python_env::engine_environment());
    let saved = launch::provider_options(cfg, runtime.provider);
    let adapters = launch::lora_adapters(&saved)
        .unwrap_or_default()
        .iter()
        .map(|adapter| format!("{}={}", adapter.name, fingerprint(Path::new(&adapter.path))))
        .collect::<Vec<_>>()
        .join(";");
    // Sorted explicitly: the key must not depend on map iteration order.
    let options: BTreeMap<String, Value> = saved.into_iter().collect();
    let companions = ["tokenizer", "hf_config_path"]
        .iter()
        .filter_map(|name| {
            options
                .get(*name)
                .and_then(Value::as_str)
                .map(|path| format!("{name}={}", fingerprint(Path::new(path))))
        })
        .collect::<Vec<_>>()
        .join(";");
    let model = cfg.active_model.trim();
    let mut hasher = Sha256::new();
    for part in [
        "engine-deep",
        &SUITE_VERSION.to_string(),
        &ENGINE_SUITE_VERSION.to_string(),
        runtime.provider.as_str(),
        &runtime.id,
        &runtime.python,
        &probe.version,
        &probe.imported_version,
        &probe.variant,
        &probe.metal_version,
        &probe.imported_metal_version,
        &probe.mlx_version,
        &serde_json::to_string(&probe.package_versions).unwrap_or_default(),
        &probe.python_version,
        &probe.python_arch,
        &probe.python_implementation,
        &probe.python_abi,
        &probe.accelerator,
        model,
        &fingerprint(Path::new(model)),
        &serde_json::to_string(&options).unwrap_or_default(),
        &adapters,
        &companions,
        &device_environment,
        hardware_fingerprint,
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    format!("{:x}", hasher.finalize())
}

fn device_environment_identity(
    environment: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> String {
    let controls: BTreeMap<String, String> = environment
        .into_iter()
        .filter_map(|(key, value)| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            [
                "CUDA_VISIBLE_DEVICES",
                "CUDA_DEVICE_ORDER",
                "CUDA_MODULE_LOADING",
                "HIP_VISIBLE_DEVICES",
                "ROCR_VISIBLE_DEVICES",
                "HSA_OVERRIDE_GFX_VERSION",
                "HSA_ENABLE_SDMA",
                "GPU_MAX_HW_QUEUES",
                "AMD_SERIALIZE_KERNEL",
                "HSA_XNACK",
                "ROCBLAS_TENSILE_LIBPATH",
                "HIPBLASLT_TENSILE_LIBPATH",
                "ROCM_KPACK_PATH",
                "ROCM_KPACK_PATH_PREFIX",
                "ONEAPI_DEVICE_SELECTOR",
                "SYCL_DEVICE_FILTER",
                "ZE_AFFINITY_MASK",
            ]
            .contains(&key.as_str())
            .then(|| (key, value.to_string_lossy().into_owned()))
        })
        .collect();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&controls).unwrap_or_default())
    )
}

/// The refusal for a Python launch whose exact combination has a stored deep
/// failure the user has not overridden.
pub(crate) fn launch_refusal(cfg: &AppConfig) -> Option<String> {
    let runtime = crate::providers::selected_python_runtime(cfg).ok()?;
    let key = engine_key(cfg, &runtime, &crate::hardware::detect().fingerprint);
    let cache = load_cache();
    if cache.overrides.iter().any(|item| item == &key) {
        return None;
    }
    cache
        .deep
        .get(&key)
        .filter(|record| record.verdict == Verdict::Fail)
        .map(|record| refusal(&key, record))
}

struct JobDirectory(PathBuf);

impl Drop for JobDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The value a marked script line reports, or the error it reported instead.
fn parse_script_output(stdout: &str) -> Result<Value, String> {
    for line in stdout.lines().rev() {
        if let Some(error) = line.trim().strip_prefix(ERROR_MARKER) {
            return Err(serde_json::from_str::<String>(error).unwrap_or_else(|_| error.to_owned()));
        }
        if let Some(result) = line.trim().strip_prefix(RESULT_MARKER) {
            return serde_json::from_str(result)
                .map_err(|error| format!("invalid script result: {error}"));
        }
    }
    Err("the engine script reported no result".into())
}

/// Run a script in the selected engine's interpreter with the engine's cleared
/// environment. The job travels in a private temporary file, which is also the
/// working directory, so an external interpreter cannot import a stray module
/// from wherever the app was started.
pub(crate) async fn run_engine_script(
    runtime: &PythonRuntimeManifest,
    script: &'static str,
    job: Value,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let python = runtime.python.clone();
    let managed = runtime.kind == InstallationKind::Managed;
    tokio::task::spawn_blocking(move || {
        let directory = std::env::temp_dir().join(format!("aiolm-engine-{}", uuid::Uuid::new_v4()));
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder
            .create(&directory)
            .map_err(|error| error.to_string())?;
        let _cleanup = JobDirectory(directory.clone());
        let input = directory.join("job.json");
        std::fs::write(
            &input,
            serde_json::to_vec(&job).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let mut command = crate::procutil::std_command(&python);
        command
            .env_clear()
            .envs(python_env::engine_environment())
            .current_dir(&directory);
        if managed {
            command.arg("-I");
        }
        command
            .arg("-c")
            .arg(format!("{PRELUDE}{script}"))
            .arg(&input);
        let output = crate::procutil::capture_stdout_cancellable(
            &mut command,
            timeout,
            OUTPUT_CAP,
            Some(&cancel),
        )
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::Interrupted => "cancelled".to_string(),
            std::io::ErrorKind::TimedOut => {
                format!("timed out after {} seconds", timeout.as_secs())
            }
            _ => error.to_string(),
        })?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        match parse_script_output(&stdout) {
            Ok(value) if output.status.success() => Ok(value),
            Ok(_) => Err(format!("the engine script exited with {}", output.status)),
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Score the selected Python engine's device path against a host reference
/// over the user's own weights, store the verdict and return it.
pub(crate) async fn run_deep(cfg: &AppConfig, cancel: Arc<AtomicBool>) -> Result<Record, String> {
    let runtime =
        crate::providers::refresh_selected_python_runtime(cfg, Some(cancel.clone())).await?;
    crate::providers::execution::validate(cfg)?;
    let provider = runtime.provider;
    let accelerator = runtime
        .probe
        .as_ref()
        .map(|probe| probe.accelerator.clone())
        .unwrap_or_default();
    let probe = runtime.probe.clone().unwrap_or_default();
    if !uses_device(provider, &probe.variant, &accelerator) {
        return Err(format!(
            "deep verification compares a device path against the host, but this {} runtime reports accelerator '{accelerator}', so there is nothing to compare",
            provider.server()
        ));
    }
    let model = cfg.active_model.trim();
    if model.is_empty() {
        return Err("select a model before running deep verification".into());
    }
    let options = launch::provider_options(cfg, provider);
    let adapters = launch::lora_adapters(&options)?;
    let trust_remote_code = options.get("trust_remote_code").and_then(Value::as_bool) == Some(true);
    let key = engine_key(cfg, &runtime, &crate::hardware::detect().fingerprint);
    if !crate::providers::execution::info(cfg)?
        .tasks
        .iter()
        .any(|task| task == "generate")
    {
        let outcome = engine_record(
            if provider == ProviderId::Vllm { VLLM_METHOD } else { MLX_METHOD },
            "none", Verdict::Unsupported, None,
            "deep verification compares next-token distributions of a generation model; transcription and embedding sessions need task-specific verification".into(),
        );
        store_deep(&key, outcome.clone());
        return Ok(outcome);
    }
    let (ctx, chunks) = (deep_ctx(), deep_chunks());
    let outcome = match provider {
        ProviderId::MlxVlm if mlx_prerequisite(&options).is_some() => Ok(engine_record(
            MLX_METHOD,
            "full",
            Verdict::Unsupported,
            None,
            mlx_prerequisite(&options).unwrap_or_default(),
        )),
        ProviderId::MlxVlm => {
            let job = json!({
                "model": model, "adapter": adapters.first().map(|adapter| adapter.path.clone()),
                "trust_remote_code": trust_remote_code, "text": PROBE_TEXT, "ctx": ctx, "chunks": chunks,
                // The server builds each request's cache with this bound.
                "max_kv_size": options.get("max_kv_size").and_then(Value::as_u64),
            });
            run_engine_script(&runtime, MLX_SCRIPT, job, DEEP_PASS_TIMEOUT, cancel.clone())
                .await
                .and_then(|value| {
                    serde_json::from_value::<MlxOutput>(value).map_err(|error| error.to_string())
                })
                .map(|output| mlx_verdict(&output, ctx))
                .map_err(|error| format!("the MLX comparison did not complete: {error}."))
        }
        ProviderId::Vllm => {
            let path = Path::new(model);
            let artifact = if path.is_dir() {
                artifacts::inspect_snapshot(path)
            } else {
                artifacts::inspect_gguf(
                    path,
                    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0),
                    &[],
                )
            };
            let selected = options
                .get(launch::REQUEST_LORA_KEY)
                .and_then(Value::as_str)
                .and_then(|name| adapters.iter().find(|adapter| adapter.name == name));
            match vllm_prerequisite(
                &artifact,
                &options,
                declared_parameter_bytes(Path::new(model)),
                crate::hardware_memory::system_memory_bytes(),
            ) {
                Some(reason) => Ok(engine_record(
                    VLLM_METHOD,
                    "partial",
                    Verdict::Unsupported,
                    None,
                    reason,
                )),
                None => {
                    let device_job = json!({
                        "variant": probe.variant, "plugin_version": probe.metal_version, "core_version": probe.version,
                        "model": model, "engine": vllm_engine_kwargs(&options), "top_k": TOP_K,
                        "lora": selected.map(|adapter| json!({"name": adapter.name, "path": adapter.path})),
                        "text": PROBE_TEXT, "ctx": ctx, "chunks": chunks,
                    });
                    match run_engine_script(
                        &runtime,
                        VLLM_DEVICE_SCRIPT,
                        device_job,
                        DEEP_PASS_TIMEOUT,
                        cancel.clone(),
                    )
                    .await
                    .and_then(|value| {
                        serde_json::from_value::<DeviceOutput>(value)
                            .map_err(|error| error.to_string())
                    }) {
                        Err(error) => {
                            Err(format!("the vLLM device pass did not complete: {error}."))
                        }
                        Ok(device) => {
                            let reference_job = json!({
                                "model": model, "adapter": selected.map(|adapter| adapter.path.clone()),
                                "trust_remote_code": trust_remote_code, "ctx": ctx,
                                "chunks": device.chunks, "positions": device.positions,
                            });
                            run_engine_script(
                                &runtime,
                                VLLM_REFERENCE_SCRIPT,
                                reference_job,
                                DEEP_PASS_TIMEOUT,
                                cancel.clone(),
                            )
                            .await
                            .and_then(|value| {
                                serde_json::from_value::<ReferenceOutput>(value)
                                    .map_err(|error| error.to_string())
                            })
                            .map(|reference| vllm_verdict(&device, &reference))
                            .map_err(|error| {
                                format!("the transformers CPU reference did not complete: {error}.")
                            })
                        }
                    }
                }
            }
        }
        ProviderId::Llama => {
            return Err("llama.cpp runtimes use llama-perplexity verification".into())
        }
    };
    if cancel.load(Ordering::Acquire) {
        return Err("deep verification cancelled".into());
    }
    let method = if provider == ProviderId::Vllm {
        VLLM_METHOD
    } else {
        MLX_METHOD
    };
    let coverage = if provider == ProviderId::Vllm {
        "partial"
    } else {
        "full"
    };
    let outcome = outcome.unwrap_or_else(|detail| {
        engine_record(method, coverage, Verdict::Unsupported, None, detail)
    });
    store_deep(&key, outcome.clone());
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position(target: u32, ids: &[u32], logprobs: &[f64]) -> Position {
        Position {
            target,
            ids: ids.to_vec(),
            logprobs: logprobs.iter().map(|value| Some(*value)).collect(),
        }
    }

    fn snapshot(
        format: ArtifactFormat,
        quantization: Option<&str>,
        size_bytes: u64,
    ) -> ModelArtifact {
        let mut artifact = artifacts::inspect_snapshot(Path::new("missing-synthetic-snapshot"));
        artifact.format = format;
        artifact.quantization = quantization.map(str::to_owned);
        artifact.size_bytes = size_bytes;
        artifact
    }

    #[test]
    fn identical_distributions_have_no_partition_divergence() {
        let logprobs = [0.5f64.ln(), 0.3f64.ln()];
        assert!(partition_kld(&logprobs, &logprobs).abs() < 1e-12);
    }

    #[test]
    fn the_partition_bound_never_exceeds_the_full_vocabulary_divergence() {
        let host = [0.5, 0.2, 0.2, 0.1f64];
        let device = [0.2, 0.5, 0.1, 0.2f64];
        let full: f64 = host
            .iter()
            .zip(&device)
            .map(|(p, q)| p * (p / q).ln())
            .sum();
        // Only the first two tokens are returned; the last two fold into "rest".
        let bound = partition_kld(
            &[host[0].ln(), host[1].ln()],
            &[device[0].ln(), device[1].ln()],
        );
        let expected =
            0.5 * (0.5f64 / 0.2).ln() + 0.2 * (0.2f64 / 0.5).ln() + 0.3 * (0.3f64 / 0.3).ln();
        assert!((bound - expected).abs() < 1e-12, "{bound} != {expected}");
        assert!(bound <= full + 1e-12);
        // A device that left no mass outside the returned tokens is floored, not infinite.
        let floored = partition_kld(&[0.5f64.ln()], &[0.0]);
        assert!(floored.is_finite() && floored > 0.0);
    }

    #[test]
    fn perplexity_ratio_and_median_follow_the_llama_definitions() {
        let host = [1.0, 2.0, 3.0];
        let device = [1.5, 2.5, 3.5];
        assert!((perplexity_ratio(&host, &device).unwrap() - 0.5f64.exp()).abs() < 1e-12);
        assert_eq!(perplexity_ratio(&host, &device[..2]), None);
        assert_eq!(median(&[3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), Some(2.5));
        assert_eq!(median(&[]), None);
        assert_eq!(median(&[1.0, f64::NAN]), None);
    }

    #[test]
    fn mlx_full_vocabulary_comparison_passes_or_fails_by_the_llama_limits() {
        let ctx = 8; // three scored positions per chunk
        let healthy = MlxOutput {
            chunks: 1,
            kld: vec![Some(0.001), Some(0.002), Some(0.003)],
            host_nll: vec![Some(2.0); 3],
            device_nll: vec![Some(2.01); 3],
        };
        let record = mlx_verdict(&healthy, ctx);
        assert_eq!(record.verdict, Verdict::Pass);
        assert_eq!(record.method.as_deref(), Some(MLX_METHOD));
        assert_eq!(record.coverage.as_deref(), Some("full"));
        assert_eq!(record.median_kld, Some(0.002));
        let corrupted = MlxOutput {
            kld: vec![Some(0.6); 3],
            ..healthy
        };
        assert_eq!(mlx_verdict(&corrupted, ctx).verdict, Verdict::Fail);
        let nan_device = MlxOutput {
            kld: vec![None; 3],
            ..corrupted
        };
        assert_eq!(mlx_verdict(&nan_device, ctx).verdict, Verdict::Fail);
        let broken_host = MlxOutput {
            host_nll: vec![None; 3],
            kld: vec![Some(0.0); 3],
            ..nan_device
        };
        assert_eq!(mlx_verdict(&broken_host, ctx).verdict, Verdict::Unsupported);
        let short = MlxOutput {
            chunks: 2,
            host_nll: vec![Some(1.0); 3],
            ..broken_host
        };
        assert_eq!(mlx_verdict(&short, ctx).verdict, Verdict::Unsupported);
    }

    #[test]
    fn vllm_partial_evidence_can_fail_but_never_passes() {
        let ids = [3, 7];
        let device = DeviceOutput {
            chunks: vec![vec![1, 7, 3]],
            positions: vec![position(3, &ids, &[0.6f64.ln(), 0.3f64.ln()])],
        };
        let agreeing = ReferenceOutput {
            positions: vec![position(3, &ids, &[0.6f64.ln(), 0.3f64.ln()])],
        };
        let record = vllm_verdict(&device, &agreeing);
        assert_eq!(record.verdict, Verdict::Unsupported);
        assert_eq!(record.coverage.as_deref(), Some("partial"));
        assert_eq!(record.top_k, Some(TOP_K));
        assert_eq!(record.median_kld, None);
        assert!(record.median_kld_lower_bound.unwrap() < 1e-12);
        assert!(record
            .detail
            .contains("full-distribution divergence is unknown"));

        let diverging = ReferenceOutput {
            positions: vec![position(3, &ids, &[0.01f64.ln(), 0.98f64.ln()])],
        };
        let record = vllm_verdict(&device, &diverging);
        assert_eq!(record.verdict, Verdict::Fail);
        assert!(record.median_kld_lower_bound.unwrap() > MAX_MEDIAN_KLD);
    }

    #[test]
    fn vllm_reference_must_score_the_same_tokens() {
        let device = DeviceOutput {
            chunks: vec![vec![1, 7, 3]],
            positions: vec![position(3, &[3, 7], &[-0.5, -1.2])],
        };
        for misaligned in [
            position(4, &[3, 7], &[-0.5, -1.2]),
            position(3, &[3, 8], &[-0.5, -1.2]),
            position(3, &[3, 7], &[-0.5]),
        ] {
            let record = vllm_verdict(
                &device,
                &ReferenceOutput {
                    positions: vec![misaligned],
                },
            );
            assert_eq!(record.verdict, Verdict::Unsupported);
            assert!(record.detail.contains("same token positions"));
        }
        let mut nan_device = DeviceOutput {
            chunks: vec![],
            positions: vec![position(3, &[3, 7], &[-0.5, -1.2])],
        };
        nan_device.positions[0].logprobs[1] = None;
        let record = vllm_verdict(
            &nan_device,
            &ReferenceOutput {
                positions: vec![position(3, &[3, 7], &[-0.5, -1.2])],
            },
        );
        assert_eq!(record.verdict, Verdict::Fail);
    }

    #[test]
    fn vllm_prerequisites_name_the_missing_reference_requirement() {
        let options = Map::new();
        let gib = 1024 * 1024 * 1024;
        let ready = snapshot(ArtifactFormat::HfSafetensors, None, gib);
        assert_eq!(vllm_prerequisite(&ready, &options, 2, Some(16 * gib)), None);
        assert!(vllm_prerequisite(
            &snapshot(ArtifactFormat::HfSafetensors, Some("awq"), gib),
            &options,
            2,
            Some(16 * gib)
        )
        .unwrap()
        .contains("quantized (awq)"));
        assert!(vllm_prerequisite(
            &snapshot(ArtifactFormat::Gguf, None, gib),
            &options,
            2,
            Some(16 * gib)
        )
        .unwrap()
        .contains("safetensors"));
        assert!(vllm_prerequisite(
            &snapshot(ArtifactFormat::Mlx, Some("mlx-4bit"), gib),
            &options,
            2,
            Some(16 * gib)
        )
        .unwrap()
        .contains("MLX conversions and GGUF"));
        let compressed = json!({"additional_config": {"turboquant": true}})
            .as_object()
            .unwrap()
            .clone();
        assert!(vllm_prerequisite(&ready, &compressed, 2, Some(16 * gib))
            .unwrap()
            .contains("TurboQuant"));
        let overrides = json!({"hf_overrides": {"rope_theta": 1000}})
            .as_object()
            .unwrap()
            .clone();
        assert!(vllm_prerequisite(&ready, &overrides, 2, Some(16 * gib))
            .unwrap()
            .contains("hf_overrides"));
        let fp8_cache = json!({"kv_cache_dtype": "fp8"})
            .as_object()
            .unwrap()
            .clone();
        assert!(vllm_prerequisite(&ready, &fp8_cache, 2, Some(16 * gib))
            .unwrap()
            .contains("KV cache"));
        let online = json!({"quantization": "fp8"}).as_object().unwrap().clone();
        assert!(vllm_prerequisite(&ready, &online, 2, Some(16 * gib))
            .unwrap()
            .contains("quantize the weights"));
        // 1 GiB of bf16 weights becomes 2 GiB in float32.
        assert!(vllm_prerequisite(&ready, &options, 2, Some(2 * gib))
            .unwrap()
            .contains("2.0 GiB"));
        assert!(vllm_prerequisite(&ready, &options, 2, None).is_some());
    }

    #[test]
    fn settings_the_comparison_cannot_reproduce_are_named_instead_of_verified() {
        let gib = 1024 * 1024 * 1024;
        let ready = snapshot(ArtifactFormat::HfSafetensors, None, gib);
        let extra = json!({"extra_args": ["--enforce-eager"]})
            .as_object()
            .unwrap()
            .clone();
        assert!(vllm_prerequisite(&ready, &extra, 2, Some(16 * gib))
            .unwrap()
            .contains("extra engine arguments"));
        assert!(mlx_prerequisite(&extra)
            .unwrap()
            .contains("extra engine arguments"));
        let pooling = json!({"runner": "pooling"}).as_object().unwrap().clone();
        assert!(vllm_prerequisite(&ready, &pooling, 2, Some(16 * gib))
            .unwrap()
            .contains("pooling"));
        let kv = json!({"kv_bits": 4}).as_object().unwrap().clone();
        assert!(mlx_prerequisite(&kv).unwrap().contains("KV cache"));
        let empty = json!({"extra_args": [], "max_kv_size": 4096})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(mlx_prerequisite(&empty), None);
    }

    #[test]
    fn only_a_probed_device_accelerator_has_anything_to_compare() {
        assert!(uses_device(ProviderId::Vllm, "", "cuda"));
        assert!(uses_device(ProviderId::Vllm, "standard", "rocm"));
        assert!(uses_device(ProviderId::Vllm, "standard", "xpu"));
        assert!(!uses_device(ProviderId::Vllm, "", "cpu"));
        assert!(uses_device(ProviderId::Vllm, "vllm-metal", "metal"));
        assert!(!uses_device(ProviderId::Vllm, "vllm-metal", "cpu"));
        assert!(!uses_device(ProviderId::Vllm, "", "metal"));
        assert!(!uses_device(ProviderId::Vllm, "vllm-metal", "cuda"));
        assert!(uses_device(ProviderId::MlxVlm, "", "metal"));
        assert!(!uses_device(ProviderId::MlxVlm, "", "Device(cpu, 0)"));
        assert!(!uses_device(ProviderId::Llama, "", "cuda"));
    }

    #[test]
    fn only_marked_lines_are_trusted_and_reported_errors_surface() {
        let noisy = "INFO loading\nAIOLM_RESULT={\"a\":1}\n";
        assert_eq!(parse_script_output(noisy).unwrap(), json!({"a": 1}));
        let failed = "warning\nAIOLM_ERROR=\"ImportError: No module named 'peft'\"\n";
        assert!(parse_script_output(failed).unwrap_err().contains("peft"));
        assert!(parse_script_output("plain text").is_err());
    }

    #[test]
    fn the_engine_key_changes_with_runtime_version_options_and_model() {
        let runtime = |version: &str| PythonRuntimeManifest {
            format: 1,
            provider: ProviderId::Vllm,
            id: "managed-synthetic".into(),
            kind: InstallationKind::Managed,
            python: "python".into(),
            requested_version: None,
            probe: Some(python_env::ProbeRecord {
                version: version.into(),
                accelerator: "cuda".into(),
                ..Default::default()
            }),
        };
        let cfg = AppConfig {
            active_provider: "vllm".into(),
            active_model: "synthetic-model-dir".into(),
            ..Default::default()
        };
        let base = engine_key(&cfg, &runtime("0.31.0"), "machine");
        assert_eq!(base, engine_key(&cfg, &runtime("0.31.0"), "machine"));
        assert_ne!(base, engine_key(&cfg, &runtime("0.31.1"), "machine"));
        let mut moved = runtime("0.31.0");
        moved.python = "other-synthetic-python".into();
        assert_ne!(base, engine_key(&cfg, &moved, "machine"));
        let mut dependency = runtime("0.31.0");
        dependency
            .probe
            .as_mut()
            .unwrap()
            .package_versions
            .insert("torch".into(), "synthetic-new-version".into());
        assert_ne!(base, engine_key(&cfg, &dependency, "machine"));
        let mut abi = runtime("0.31.0");
        abi.probe.as_mut().unwrap().python_abi = "synthetic-new-abi".into();
        assert_ne!(base, engine_key(&cfg, &abi, "machine"));
        let mut timestamp = runtime("0.31.0");
        timestamp.probe.as_mut().unwrap().probed_at = 999;
        assert_eq!(
            base,
            engine_key(&cfg, &timestamp, "machine"),
            "refreshing unchanged packages retains verdict identity"
        );
        assert_ne!(base, engine_key(&cfg, &runtime("0.31.0"), "other-machine"));
        let mut changed = cfg.clone();
        changed
            .provider_options
            .entry("vllm".into())
            .or_default()
            .insert("dtype".into(), json!("float16"));
        assert_ne!(base, engine_key(&changed, &runtime("0.31.0"), "machine"));
        let mut other_model = cfg.clone();
        other_model.active_model = "other-synthetic-model-dir".into();
        assert_ne!(
            base,
            engine_key(&other_model, &runtime("0.31.0"), "machine")
        );
        let mut metal = runtime("0.30.0");
        let probe = metal.probe.as_mut().unwrap();
        probe.accelerator = "metal".into();
        probe.variant = "vllm-metal".into();
        probe.metal_version = "0.30.0".into();
        let metal_key = engine_key(&cfg, &metal, "machine");
        metal.probe.as_mut().unwrap().metal_version = "0.30.1".into();
        assert_ne!(metal_key, engine_key(&cfg, &metal, "machine"));
        metal.probe.as_mut().unwrap().metal_version = "0.30.0".into();
        metal.probe.as_mut().unwrap().variant.clear();
        assert_ne!(metal_key, engine_key(&cfg, &metal, "machine"));
    }

    #[test]
    fn verification_identity_tracks_inherited_device_controls_without_order_or_home() {
        let identity = |items: &[(&str, &str)]| {
            device_environment_identity(
                items
                    .iter()
                    .map(|(key, value)| ((*key).into(), (*value).into())),
            )
        };
        let first = identity(&[("CUDA_VISIBLE_DEVICES", "0"), ("HSA_XNACK", "1")]);
        assert_eq!(
            first,
            identity(&[
                ("HSA_XNACK", "1"),
                ("CUDA_VISIBLE_DEVICES", "0"),
                ("HOME", "synthetic-home")
            ])
        );
        assert_ne!(
            first,
            identity(&[("CUDA_VISIBLE_DEVICES", "1"), ("HSA_XNACK", "1")])
        );
        assert_ne!(
            first,
            identity(&[("CUDA_VISIBLE_DEVICES", "0"), ("HSA_XNACK", "0")])
        );
    }

    #[test]
    fn file_model_verification_keys_change_with_weights_and_companions() {
        let root = std::env::temp_dir().join(format!("aiolm-metal-key-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let model = root.join("synthetic.gguf");
        std::fs::write(&model, b"synthetic weights").unwrap();
        std::fs::write(root.join("config.json"), br#"{"model_type":"llama"}"#).unwrap();
        let runtime = PythonRuntimeManifest {
            format: 1,
            provider: ProviderId::Vllm,
            id: "synthetic-metal".into(),
            kind: InstallationKind::Managed,
            python: "python".into(),
            requested_version: None,
            probe: Some(python_env::ProbeRecord {
                variant: "vllm-metal".into(),
                version: "0.30.0".into(),
                metal_version: "0.30.0".into(),
                accelerator: "metal".into(),
                ..Default::default()
            }),
        };
        let mut cfg = AppConfig {
            active_provider: "vllm".into(),
            active_model: model.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let initial = engine_key(&cfg, &runtime, "machine");
        std::fs::write(root.join("config.json"), br#"{"model_type":"qwen2"}"#).unwrap();
        let changed_config = engine_key(&cfg, &runtime, "machine");
        assert_ne!(
            initial, changed_config,
            "same-size companion edit must revoke the verdict"
        );
        std::fs::write(root.join("tokenizer.json"), b"{}").unwrap();
        let tokenizer_key = engine_key(&cfg, &runtime, "machine");
        assert_ne!(changed_config, tokenizer_key);
        std::fs::write(&model, b"replaced synthetic weights").unwrap();
        assert_ne!(tokenizer_key, engine_key(&cfg, &runtime, "machine"));
        let companion = root.join("external-tokenizer");
        std::fs::create_dir(&companion).unwrap();
        std::fs::write(companion.join("tokenizer.json"), b"{}").unwrap();
        cfg.provider_options
            .entry("vllm".into())
            .or_default()
            .insert("tokenizer".into(), json!(companion));
        let external = engine_key(&cfg, &runtime, "machine");
        std::fs::write(companion.join("tokenizer.json"), b"{\"added\":1}").unwrap();
        assert_ne!(external, engine_key(&cfg, &runtime, "machine"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_offline_pass_mirrors_only_computation_settings() {
        let options = json!({"dtype": "bfloat16", "tensor_parallel_size": 2, "temperature": 0.3,
            "speculative_config": {"method": "ngram"}, "lora_adapters": []});
        let kwargs = vllm_engine_kwargs(options.as_object().unwrap());
        assert_eq!(kwargs.len(), 2);
        assert_eq!(kwargs["tensor_parallel_size"], json!(2));
    }

    #[tokio::test]
    async fn a_cancelled_script_reports_cancellation_without_a_result() {
        let cancel = Arc::new(AtomicBool::new(true));
        let runtime = PythonRuntimeManifest {
            format: 1,
            provider: ProviderId::MlxVlm,
            id: "synthetic".into(),
            kind: InstallationKind::External,
            // Any long-running program stands in for an interpreter here; the
            // raised flag must stop it before it reports anything.
            python: if cfg!(windows) {
                "cmd".into()
            } else {
                "sh".into()
            },
            requested_version: None,
            probe: None,
        };
        let error = run_engine_script(&runtime, "", json!({}), Duration::from_secs(30), cancel)
            .await
            .unwrap_err();
        assert_eq!(error, "cancelled");
    }
}
