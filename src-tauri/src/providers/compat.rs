//! Whether a runtime can load a model artifact, and with which inputs.
//!
//! Compatibility comes from the artifact's own metadata compared against the
//! engine's model registry. A probed runtime's registry is authoritative for
//! that installed version; without a probe the pinned upstream lists in
//! `catalog_data` are used and the evidence says so. Missing files, partial
//! downloads, an absent installation or insufficient memory are readiness
//! problems and never turn an incompatible model into a compatible one or the
//! reverse.
use super::artifacts::{ArtifactFormat, ArtifactRole, Modalities, ModelArtifact};
use super::catalog_data as data;
use super::python_env::ProbeRecord;
use super::ProviderId;
use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompatStatus {
    /// The engine registry lists this model and its inputs are usable.
    Supported,
    /// Loadable with stated limitations.
    Partial,
    Unsupported,
    /// The artifact could not be identified well enough to decide.
    Unknown,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CompatReason {
    /// Stable code the UI localizes.
    pub code: &'static str,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ModelCompatibility {
    pub provider: ProviderId,
    pub status: CompatStatus,
    /// Verified generation, embedding, transcription and translation tasks.
    pub tasks: Vec<&'static str>,
    pub reasons: Vec<CompatReason>,
    /// Inputs usable through this provider: model support intersected with
    /// what the provider's server accepts.
    pub modalities: Modalities,
    pub limitations: Vec<String>,
    /// Problems that block a launch without affecting compatibility.
    pub readiness: Vec<String>,
    /// `runtime-probe`, `pinned-registry` or `artifact-format`.
    pub evidence: &'static str,
}

impl ModelCompatibility {
    pub fn loadable(&self) -> bool {
        matches!(self.status, CompatStatus::Supported | CompatStatus::Partial)
    }
}

/// Inputs each provider's OpenAI-compatible server accepts at all. A model
/// still has to support an input for it to be usable.
pub fn provider_input_support(provider: ProviderId) -> Modalities {
    match provider {
        // llama-server accepts image and audio parts through a projector; it
        // has no video input.
        ProviderId::Llama => Modalities {
            text: true,
            image: true,
            audio: true,
            video: false,
        },
        // vLLM: image_url, input_audio/audio_url and video_url parts.
        ProviderId::Vllm => Modalities {
            text: true,
            image: true,
            audio: true,
            video: true,
        },
        // mlx-vlm v0.7.6 `server/openai.py`: image_url/input_image,
        // input_audio and video/video_url/input_video parts.
        ProviderId::MlxVlm => Modalities {
            text: true,
            image: true,
            audio: true,
            video: true,
        },
    }
}

fn reason(code: &'static str, detail: impl Into<String>) -> CompatReason {
    CompatReason {
        code,
        detail: detail.into(),
    }
}

fn readiness(artifact: &ModelArtifact) -> Vec<String> {
    let mut problems = Vec::new();
    if artifact.incomplete {
        problems.push("the download did not complete".to_string());
    }
    for file in &artifact.missing {
        problems.push(format!("missing {file}"));
    }
    problems
}

fn contains(list: &[&str], value: &str) -> bool {
    list.contains(&value)
}

pub fn is_metal(probe: Option<&ProbeRecord>) -> bool {
    probe.is_some_and(|probe| probe.variant == "vllm-metal")
}

/// An explicit runtime wins. The unselected macOS catalog uses the pinned
/// Metal loader policy without treating an arbitrary CPU vLLM as Metal.
fn metal_selection(probe: Option<&ProbeRecord>) -> bool {
    is_metal(probe)
}

/// Quantization methods MLX cannot load from a Transformers checkpoint.
const MLX_UNLOADABLE_QUANTIZATION: &[&str] = &[
    "gptq",
    "awq",
    "bitsandbytes",
    "aqlm",
    "hqq",
    "eetq",
    "gguf",
    "exl2",
];
/// Methods mlx-vlm v0.7.6 converts at load time (`utils.py` compressed-tensors
/// and fp8 handling), which is slower and less widely tested than a native
/// MLX conversion.
const MLX_CONVERTED_QUANTIZATION: &[&str] = &["compressed-tensors", "fp8"];

pub fn assess(
    artifact: &ModelArtifact,
    provider: ProviderId,
    probe: Option<&ProbeRecord>,
) -> ModelCompatibility {
    assess_for_platform(artifact, provider, probe, std::env::consts::OS)
}

/// The unselected catalog uses the native platform's pinned loader policy.
/// Taking a platform value keeps that fallback testable without native hardware.
pub fn assess_for_platform(
    artifact: &ModelArtifact,
    provider: ProviderId,
    probe: Option<&ProbeRecord>,
    os: &str,
) -> ModelCompatibility {
    let fallback =
        (provider == ProviderId::Vllm && probe.is_none() && os == "macos").then(|| ProbeRecord {
            variant: "vllm-metal".into(),
            metal_gguf: true,
            ..Default::default()
        });
    assess_impl(artifact, provider, probe.or(fallback.as_ref()))
}

fn assess_impl(
    artifact: &ModelArtifact,
    provider: ProviderId,
    probe: Option<&ProbeRecord>,
) -> ModelCompatibility {
    let mut result = ModelCompatibility {
        provider,
        status: CompatStatus::Unknown,
        tasks: Vec::new(),
        reasons: Vec::new(),
        modalities: Modalities::default(),
        limitations: Vec::new(),
        readiness: readiness(artifact),
        evidence: "artifact-format",
    };
    let mut mlx_audio = true;
    match provider {
        ProviderId::Llama => assess_llama(artifact, &mut result),
        ProviderId::Vllm => assess_vllm(artifact, probe, &mut result),
        ProviderId::MlxVlm => {
            mlx_audio = assess_mlx(artifact, probe, &mut result)
                .is_some_and(|mapped| mlx_has_audio(&mapped, probe));
        }
    }
    if result.loadable() {
        result.modalities = artifact
            .modalities
            .intersect(provider_input_support(provider));
        if result.tasks.contains(&"transcription") && !result.tasks.contains(&"generate") {
            result.modalities = Modalities::default();
        }
        if provider == ProviderId::Vllm && metal_selection(probe) {
            let image = artifact.model_type.as_deref().is_some_and(|model_type| {
                listed(
                    probe
                        .filter(|p| p.metal_registry_scan >= 1)
                        .map(|p| &p.metal_multimodal_model_types),
                    data::VLLM_METAL_IMAGE_MODEL_TYPES,
                    model_type,
                )
            }) && artifact.quantization.as_deref() != Some("fp8")
                && result.tasks.contains(&"generate");
            result.modalities.image &= image;
            result.modalities.audio = false;
            result.modalities.video = false;
            // Speech-to-text sessions serve no chat inputs: transcription runs
            // through /v1/audio/* on a dedicated STT runner, never as chat
            // audio/video parts. Keep chat modalities empty so UI bindings
            // cannot offer audio/video chat on an STT session.
            if result.tasks.contains(&"transcription") || result.tasks.contains(&"translate") {
                result.modalities = Modalities::default();
            }
        }
        if result
            .reasons
            .iter()
            .any(|reason| reason.code == "text-only-registry")
        {
            result.modalities = Modalities::text_only();
        }
        if !mlx_audio && result.modalities.audio {
            result.modalities.audio = false;
            result.limitations.push(
                "this mlx-vlm model implementation has no audio encoder; audio input is unavailable".into(),
            );
        }
        let declared = artifact.modalities;
        for (name, model, usable) in [
            ("image", declared.image, result.modalities.image),
            (
                "audio",
                declared.audio && mlx_audio,
                result.modalities.audio,
            ),
            ("video", declared.video, result.modalities.video),
        ] {
            if model && !usable {
                result.limitations.push(format!(
                    "{} does not accept {name} input; the model's {name} support is unavailable here",
                    provider.server()
                ));
            }
        }
    }
    result
}

fn assess_llama(artifact: &ModelArtifact, result: &mut ModelCompatibility) {
    match (artifact.format, artifact.role) {
        (ArtifactFormat::Gguf, ArtifactRole::Projector) => {
            result.status = CompatStatus::Unsupported;
            result.reasons.push(reason(
                "projector-companion",
                "a multimodal projector is attached to a model, not loaded on its own",
            ));
        }
        (ArtifactFormat::Gguf, _) => {
            result.status = CompatStatus::Supported;
            result.tasks = vec!["generate", "embed"];
            result.evidence = "artifact-format";
            result
                .limitations
                .push("image and audio input require a matching multimodal projector".into());
        }
        (ArtifactFormat::Unknown, _) => {
            result.status = CompatStatus::Unknown;
            result.reasons.push(reason(
                "unidentified",
                "the model files could not be identified",
            ));
        }
        _ => {
            result.status = CompatStatus::Unsupported;
            result.reasons.push(reason(
                "llama-requires-gguf",
                "llama.cpp loads GGUF files; this artifact is a safetensors snapshot",
            ));
        }
    }
}

fn assess_vllm(
    artifact: &ModelArtifact,
    probe: Option<&ProbeRecord>,
    result: &mut ModelCompatibility,
) {
    if metal_selection(probe) {
        assess_metal(artifact, probe, result);
        return;
    }
    match artifact.format {
        ArtifactFormat::Gguf => {
            result.status = CompatStatus::Unsupported;
            result.reasons.push(reason(
                "vllm-gguf-plugin",
                "vLLM documents GGUF as experimental behind a separate plugin; AioLM does not offer GGUF on vLLM",
            ));
            return;
        }
        ArtifactFormat::Mlx => {
            result.status = CompatStatus::Unsupported;
            result.reasons.push(reason(
                "vllm-mlx-format",
                "MLX conversions are not loadable by vLLM",
            ));
            return;
        }
        ArtifactFormat::Unknown => {
            result.reasons.push(reason(
                "unidentified",
                "config.json does not name an architecture",
            ));
            return;
        }
        ArtifactFormat::HfSafetensors => {}
    }
    let probed = probe.filter(|probe| !probe.architectures.is_empty());
    result.evidence = if probed.is_some() {
        "runtime-probe"
    } else {
        "pinned-registry"
    };
    let registered = |architecture: &str| match probed {
        Some(probe) => probe
            .architectures
            .iter()
            .any(|known| known == architecture),
        None => {
            contains(data::VLLM_TEXT_GENERATION, architecture)
                || contains(data::VLLM_MULTIMODAL, architecture)
                || contains(data::VLLM_EMBEDDING, architecture)
                || contains(data::VLLM_TRANSFORMERS_BACKEND, architecture)
        }
    };
    let Some(architecture) = artifact.architectures.iter().find(|arch| registered(arch)) else {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason(
            "architecture-not-registered",
            format!(
                "vLLM {} does not register {}",
                probed
                    .map(|probe| probe.version.clone())
                    .unwrap_or_else(|| format!("{} (pinned list)", data::VLLM_SNAPSHOT_VERSION)),
                if artifact.architectures.is_empty() {
                    "an architecture for this model".to_string()
                } else {
                    artifact.architectures.join(", ")
                }
            ),
        ));
        return;
    };
    if architecture == "WhisperForConditionalGeneration"
        && probed.is_none_or(|probe| probe.transcription_scan == 0)
    {
        result.readiness.push("probe this vLLM runtime again to establish its installed speech task before loading Whisper".into());
        result.tasks = vec!["transcription", "translate"];
        result.status = CompatStatus::Partial;
        return;
    }
    let registered_task = |actual: Option<&Vec<String>>, pinned: &[&str]| {
        actual.filter(|known| !known.is_empty()).map_or_else(
            || contains(pinned, architecture),
            |known| known.contains(architecture),
        )
    };
    let embedding = registered_task(
        probed.map(|probe| &probe.embedding_architectures),
        data::VLLM_EMBEDDING,
    );
    let generation = registered_task(
        probed.map(|probe| &probe.generation_architectures),
        data::VLLM_TEXT_GENERATION,
    ) || registered_task(
        probed.map(|probe| &probe.multimodal_architectures),
        data::VLLM_MULTIMODAL,
    );
    let speech = probed.filter(|probe| probe.transcription_scan > 0);
    let transcription =
        speech.is_some_and(|probe| probe.transcription_architectures.contains(architecture));
    if architecture == "WhisperForConditionalGeneration" && !transcription {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason(
            "speech-not-registered",
            "this installed vLLM source does not establish Whisper transcription support",
        ));
        return;
    }
    let transcription_only = speech.is_some_and(|probe| {
        probe
            .transcription_only_architectures
            .contains(architecture)
    });
    if transcription {
        result.tasks.push("transcription");
        if speech.is_some_and(|probe| probe.translation_architectures.contains(architecture)) {
            result.tasks.push("translate");
        }
    }
    if artifact.role != ArtifactRole::Embedding && generation && !transcription_only {
        result.tasks.push("generate");
    }
    if embedding {
        result.tasks.push("embed");
    }
    if result.tasks.is_empty() {
        result
            .tasks
            .push(if artifact.role == ArtifactRole::Embedding {
                "embed"
            } else {
                "generate"
            });
    }
    result.status = CompatStatus::Supported;
    if !registered_task(
        probed.map(|probe| &probe.multimodal_architectures),
        data::VLLM_MULTIMODAL,
    ) && (artifact.modalities.image || artifact.modalities.audio || artifact.modalities.video)
    {
        result.status = CompatStatus::Partial;
        result.reasons.push(reason(
            "text-only-registry",
            "the registered implementation supports text inputs",
        ));
        result.limitations.push(format!(
            "{architecture} is registered for text generation only in vLLM {}",
            data::VLLM_SNAPSHOT_VERSION
        ));
    }
    if let Some(method) = &artifact.quantization {
        result.limitations.push(format!(
            "quantization '{method}' depends on the GPU and vLLM build; vLLM validates it at load"
        ));
    }
}

/// Metal's native load path is MLX-LM/MLX-VLM, not the GPU ModelRegistry.
fn assess_metal(
    artifact: &ModelArtifact,
    probe: Option<&ProbeRecord>,
    result: &mut ModelCompatibility,
) {
    let scanned = probe.filter(|probe| probe.metal_registry_scan >= 1);
    result.evidence = if scanned.is_some() {
        "runtime-probe"
    } else {
        "pinned-registry"
    };
    if artifact.role == ArtifactRole::Projector {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason(
            "projector-companion",
            "vllm-metal does not load a standalone multimodal projector",
        ));
        return;
    }
    if artifact.format == ArtifactFormat::Gguf {
        match super::artifacts::metal_gguf_problem(artifact) {
            Some(problem) => {
                result.status = CompatStatus::Unsupported;
                result.reasons.push(reason("metal-gguf-scope", problem));
            }
            None => {
                result.status = CompatStatus::Supported;
                result.tasks = vec!["generate"];
                if probe.is_some_and(|probe| !probe.metal_gguf) {
                    result.readiness.push("the selected Metal runtime lacks gguf>=0.17.0; use AioLM's managed Metal installation or add that dependency to your own compatible external environment".into());
                }
            }
        }
        return;
    }
    if artifact.format == ArtifactFormat::Unknown {
        result.reasons.push(reason(
            "unidentified",
            "config.json does not identify a Metal-loadable model",
        ));
        return;
    }
    let Some(model_type) = artifact.model_type.as_deref() else {
        result.reasons.push(reason(
            "unidentified",
            "vllm-metal's MLX loader requires model_type in config.json",
        ));
        return;
    };
    // Native speech-to-text is a separate task/session, never audio chat.
    // Pinned v0.30.0 evidence: `vllm_metal/stt/detection.py`
    // `_STT_MODEL_TYPES` is `{"whisper", "qwen3_asr"}` with matching
    // constructors in `vllm_metal/stt/registry.py`; `docs/stt.md` serves
    // Whisper through `/v1/audio/transcriptions` and
    // `/v1/audio/translations`, Qwen3-ASR through transcriptions only.
    // Installed-source speech lists establish readiness for executable sessions.
    if data::VLLM_METAL_TRANSCRIPTION_MODEL_TYPES.contains(&model_type) {
        let speech = probe.filter(|probe| probe.metal_transcription_scan > 0);
        if speech.is_some() {
            result.evidence = "runtime-probe";
        }
        if speech.is_some_and(|probe| {
            !probe
                .metal_transcription_model_types
                .iter()
                .any(|kind| kind == model_type)
        }) {
            result.status = CompatStatus::Unsupported;
            result.reasons.push(reason(
                "speech-not-registered",
                "this installed Metal speech registry has no loader for this model",
            ));
            return;
        }
        if speech.is_none() {
            result.readiness.push("probe this Metal runtime again to establish its installed speech registry and dependencies".into());
        } else if speech.is_some_and(|probe| !probe.metal_stt_extras) {
            result.readiness.push("this Metal environment needs the stt extra (librosa and numba) before speech inference".into());
        }
        let supported_architectures = data::VLLM_METAL_TRANSCRIPTION_ARCHITECTURES
            .iter()
            .find(|(kind, _)| *kind == model_type)
            .map(|(_, architectures)| *architectures)
            .unwrap_or(&[]);
        if !artifact.architectures.is_empty()
            && !artifact
                .architectures
                .iter()
                .any(|arch| supported_architectures.contains(&arch.as_str()))
        {
            result.status = CompatStatus::Unsupported;
            result.reasons.push(reason(
                "architecture-not-registered",
                format!(
                    "vllm-metal has no verified speech-to-text load path for model type '{model_type}' with this checkpoint architecture"
                ),
            ));
            return;
        }
        if artifact.role == ArtifactRole::Embedding {
            result.status = CompatStatus::Unsupported;
            result.reasons.push(reason(
                "model-type-not-embedding",
                format!("vllm-metal serves '{model_type}' through speech-to-text, not embeddings"),
            ));
            return;
        }
        result.status = CompatStatus::Supported;
        result.tasks = if listed(
            speech.map(|probe| &probe.metal_translation_model_types),
            data::VLLM_METAL_TRANSLATION_MODEL_TYPES,
            model_type,
        ) {
            vec!["transcription", "translate"]
        } else {
            vec!["transcription"]
        };
        result.limitations.push(
            "speech-to-text needs the local vllm-metal[stt] extra (librosa/numba); non-WAV audio needs a local ffmpeg binary".into(),
        );
        return;
    }
    let generation = listed(
        scanned.map(|p| &p.metal_model_types),
        data::VLLM_METAL_TEXT_MODEL_TYPES,
        model_type,
    );
    let images = listed(
        scanned.map(|p| &p.metal_multimodal_model_types),
        data::VLLM_METAL_IMAGE_MODEL_TYPES,
        model_type,
    );
    let embedding = listed(
        scanned.map(|p| &p.metal_embedding_model_types),
        data::VLLM_METAL_EMBEDDING_MODEL_TYPES,
        model_type,
    );
    if !generation && !images && !embedding {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason(
            "model-type-not-registered",
            format!(
                "vllm-metal {} has no verified MLX load path for model type '{model_type}'",
                probe
                    .map(|p| p.metal_version.as_str())
                    .filter(|v| !v.is_empty())
                    .unwrap_or(data::VLLM_METAL_SNAPSHOT_VERSION)
            ),
        ));
        return;
    }
    let architecture_known = |arch: &str| {
        data::VLLM_METAL_ARCHITECTURES
            .iter()
            .any(|(kind, arches)| *kind == model_type && arches.contains(&arch))
            && probe
                .filter(|p| !p.architectures.is_empty())
                .is_none_or(|p| p.architectures.iter().any(|known| known == arch))
    };
    if !artifact.architectures.is_empty()
        && !artifact
            .architectures
            .iter()
            .any(|arch| architecture_known(arch))
    {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason("architecture-not-registered", "the core vLLM registry cannot resolve this checkpoint architecture, even though its model_type has a Metal loader"));
        return;
    }
    if artifact
        .architectures
        .iter()
        .any(|arch| arch.contains("SequenceClassification") || arch.contains("TokenClassification"))
    {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason("metal-task-unavailable", "this checkpoint requires classify/token_classify pooling; the app serves generate and embed tasks"));
        return;
    }
    if artifact.role == ArtifactRole::Embedding && !embedding {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason(
            "model-type-not-embedding",
            format!("vllm-metal has no app-supported embedding path for '{model_type}'"),
        ));
        return;
    }
    if matches!(model_type, "xlm-roberta" | "roberta") && artifact.format == ArtifactFormat::Mlx {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason(
            "metal-quantization",
            "Metal encoder pooling requires an unquantized HF checkpoint",
        ));
        return;
    }
    if let Some(method) = artifact
        .quantization
        .as_deref()
        .filter(|_| artifact.format == ArtifactFormat::HfSafetensors)
    {
        if !["awq", "fp8", "mxfp4", "compressed-tensors"].contains(&method)
            || (method == "fp8" && !["qwen3_5", "qwen3_5_moe"].contains(&model_type))
        {
            result.status = CompatStatus::Unsupported;
            result.reasons.push(reason("metal-quantization", format!("'{method}' checkpoint quantization is not supported by this Metal MLX load path")));
            return;
        }
        if method == "awq" {
            if let Some(problem) =
                super::artifacts::metal_awq_problem(std::path::Path::new(&artifact.path))
            {
                result.status = CompatStatus::Unsupported;
                result.reasons.push(reason("metal-quantization", problem));
                return;
            }
        }
        if method == "compressed-tensors" {
            if let Some(problem) = super::artifacts::metal_compressed_tensors_problem(
                std::path::Path::new(&artifact.path),
            ) {
                result.status = CompatStatus::Unsupported;
                result.reasons.push(reason("metal-quantization", problem));
                return;
            }
        }
    }
    result.status = CompatStatus::Supported;
    result.tasks = if artifact.role == ArtifactRole::Embedding || (!generation && !images) {
        vec!["embed"]
    } else if embedding
        && !artifact.modalities.image
        && !artifact.modalities.audio
        && !artifact.modalities.video
    {
        vec!["generate", "embed"]
    } else {
        vec!["generate"]
    };
    if artifact.modalities.image && (!images || artifact.quantization.as_deref() == Some("fp8")) {
        result.status = CompatStatus::Partial;
        result.reasons.push(reason("text-only-registry", "the pinned Metal plugin serves this checkpoint through its text backbone; image input is unavailable"));
    }
    if artifact.modalities.audio || artifact.modalities.video {
        result.status = CompatStatus::Partial;
    }
}

/// A probe whose source scan filled the mlx-vlm package lists. Records from
/// before the scan carry empty lists that say nothing, so they fall back to
/// the pinned v0.7.6 lists.
fn package_scan(probe: Option<&ProbeRecord>) -> Option<&ProbeRecord> {
    probe.filter(|probe| probe.package_scan >= 1)
}

fn listed(scanned: Option<&Vec<String>>, pinned: &[&str], value: &str) -> bool {
    match scanned {
        Some(list) => list.iter().any(|known| known == value),
        None => contains(pinned, value),
    }
}

fn pair_lookup(pairs: &[(&str, &str)], key: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(alias, _)| *alias == key)
        .map(|(_, target)| (*target).to_owned())
}

/// Whether the mlx-vlm package implementing `mapped` encodes audio.
fn mlx_has_audio(mapped: &str, probe: Option<&ProbeRecord>) -> bool {
    listed(
        package_scan(probe).map(|probe| &probe.audio_model_types),
        data::MLX_VLM_AUDIO_MODEL_TYPES,
        mapped,
    )
}

/// Decide mlx-vlm compatibility. Returns the package that would load the
/// model when it is loadable, so callers can ask what that package supports.
fn assess_mlx(
    artifact: &ModelArtifact,
    probe: Option<&ProbeRecord>,
    result: &mut ModelCompatibility,
) -> Option<String> {
    match artifact.format {
        ArtifactFormat::Gguf => {
            result.status = CompatStatus::Unsupported;
            result
                .reasons
                .push(reason("mlx-gguf", "mlx-vlm does not load GGUF files"));
            return None;
        }
        ArtifactFormat::Unknown => {
            result.reasons.push(reason(
                "unidentified",
                "config.json does not name a model type",
            ));
            return None;
        }
        ArtifactFormat::Mlx | ArtifactFormat::HfSafetensors => {}
    }
    if let Some(method) = artifact
        .quantization
        .as_deref()
        .filter(|_| artifact.format == ArtifactFormat::HfSafetensors)
    {
        if contains(MLX_UNLOADABLE_QUANTIZATION, method) {
            result.status = CompatStatus::Unsupported;
            result.reasons.push(reason(
                "mlx-quantization",
                format!(
                    "'{method}' quantized weights cannot be loaded by MLX; use an MLX conversion"
                ),
            ));
            return None;
        }
    }
    let probed = probe.filter(|probe| !probe.model_types.is_empty());
    result.evidence = if probed.is_some() {
        "runtime-probe"
    } else {
        "pinned-registry"
    };
    let Some(model_type) = artifact.model_type.as_deref() else {
        result.reasons.push(reason(
            "unidentified",
            "config.json does not name a model type",
        ));
        return None;
    };
    let version = || {
        probed
            .map(|probe| probe.version.clone())
            .unwrap_or_else(|| format!("{} (pinned list)", data::MLX_VLM_SNAPSHOT_VERSION))
    };
    // mlx-vlm lowercases `model_type` before remapping (`utils.get_model_and_args`).
    let lowered = model_type.to_ascii_lowercase();
    let embedding_role = artifact.role == ArtifactRole::Embedding;
    let embedding_alias = embedding_role
        .then(|| {
            probed
                .and_then(|probe| probe.embedding_model_type_aliases.get(&lowered).cloned())
                .or_else(|| pair_lookup(data::MLX_VLM_EMBEDDING_MODEL_TYPE_ALIASES, &lowered))
        })
        .flatten();
    let mapped = embedding_alias
        .or_else(|| {
            probed
                .and_then(|probe| probe.model_type_aliases.get(&lowered).cloned())
                .or_else(|| pair_lookup(data::MLX_VLM_MODEL_TYPE_ALIASES, &lowered))
        })
        .unwrap_or_else(|| lowered.replace('-', "_"));
    let known = match probed {
        Some(probe) => probe.model_types.contains(&mapped),
        None => contains(data::MLX_VLM_MODEL_TYPES, &mapped),
    };
    if !known {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason(
            "model-type-not-registered",
            format!(
                "mlx-vlm {} has no implementation for model type '{model_type}'",
                version()
            ),
        ));
        return None;
    }
    let scan = package_scan(probed);
    let embeds = listed(
        scan.map(|probe| &probe.embedding_model_types),
        data::MLX_VLM_EMBEDDING_MODEL_TYPES,
        &mapped,
    );
    let image_generation =
        scan.is_some_and(|probe| probe.image_generation_model_types.contains(&mapped));
    // Only the v0.7.6 packages were read and classified. A package a newer
    // runtime adds may be a detector, encoder or pipeline as easily as a chat
    // model, and nothing short of loading it tells which, so it stays Unknown.
    let verified = contains(data::MLX_VLM_MODEL_TYPES, &mapped);
    let unverified = |result: &mut ModelCompatibility| {
        result.status = CompatStatus::Unknown;
        result.reasons.push(reason(
            "model-type-unverified",
            format!(
                "mlx-vlm {} provides '{model_type}', which AioLM has not verified as a chat or embedding model",
                version()
            ),
        ));
    };
    result.tasks = if embeds {
        vec!["embed"]
    } else if embedding_role {
        if !verified && scan.is_none() {
            unverified(result);
            return None;
        }
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason(
            "model-type-not-embedding",
            format!(
                "mlx-vlm {} has no embedding implementation for model type '{model_type}'",
                version()
            ),
        ));
        return None;
    } else if image_generation || contains(data::MLX_VLM_NON_GENERATIVE_MODEL_TYPES, &mapped) {
        result.status = CompatStatus::Unsupported;
        result.reasons.push(reason(
            "model-type-not-generative",
            format!(
                "mlx-vlm {} implements '{model_type}' as a non-chat model (image generation, segmentation, detection or classification); it cannot serve chat",
                version()
            ),
        ));
        return None;
    } else if !verified {
        unverified(result);
        return None;
    } else {
        vec!["generate"]
    };
    result.status = CompatStatus::Supported;
    if let Some(method) = artifact
        .quantization
        .as_deref()
        .filter(|_| artifact.format == ArtifactFormat::HfSafetensors)
    {
        if contains(MLX_CONVERTED_QUANTIZATION, method) {
            result.status = CompatStatus::Partial;
            result.limitations.push(format!(
                "'{method}' weights are converted by mlx-vlm while loading; an MLX conversion loads faster"
            ));
        }
    }
    if artifact.modalities.video && result.tasks == ["generate"] {
        result.limitations.push(
            "mlx-vlm samples video into frames for models whose processor has no native video input".into(),
        );
    }
    Some(mapped)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generic provider tests select a standard runtime explicitly so their
    // expectations stay independent of the unselected macOS catalog policy.
    fn assess(
        artifact: &ModelArtifact,
        provider: ProviderId,
        probe: Option<&ProbeRecord>,
    ) -> ModelCompatibility {
        let standard = ProbeRecord::default();
        super::assess(
            artifact,
            provider,
            probe.or((provider == ProviderId::Vllm).then_some(&standard)),
        )
    }

    #[test]
    fn unselected_macos_catalog_uses_metal_while_explicit_standard_runtime_wins() {
        let model = artifact(ArtifactFormat::Mlx, &["LlamaForCausalLM"], Some("llama"));
        let fallback = assess_for_platform(&model, ProviderId::Vllm, None, "macos");
        assert!(fallback.loadable());
        assert_eq!(fallback.evidence, "pinned-registry");
        assert!(!assess_for_platform(&model, ProviderId::Vllm, None, "linux").loadable());
        assert!(!assess_for_platform(
            &model,
            ProviderId::Vllm,
            Some(&ProbeRecord::default()),
            "macos"
        )
        .loadable());
    }

    fn metal_probe() -> ProbeRecord {
        ProbeRecord {
            variant: "vllm-metal".into(),
            version: "0.30.0+cpu".into(),
            metal_version: "0.30.0".into(),
            metal_gguf: true,
            metal_transcription_scan: 1,
            metal_transcription_model_types: vec!["whisper".into(), "qwen3_asr".into()],
            metal_translation_model_types: vec!["whisper".into()],
            metal_stt_extras: true,
            ..Default::default()
        }
    }

    #[test]
    fn metal_uses_mlx_loader_evidence_instead_of_the_gpu_registry_superset() {
        let mut probe = metal_probe();
        probe.architectures = vec![
            "BertModel".into(),
            "LlamaForCausalLM".into(),
            "MadeUpForCausalLM".into(),
        ];
        let bert = artifact(ArtifactFormat::HfSafetensors, &["BertModel"], Some("bert"));
        assert!(!assess(&bert, ProviderId::Vllm, Some(&probe)).loadable());
        for format in [ArtifactFormat::HfSafetensors, ArtifactFormat::Mlx] {
            let llama = artifact(format, &["LlamaForCausalLM"], Some("llama"));
            assert_eq!(
                assess(&llama, ProviderId::Vllm, Some(&probe)).tasks,
                vec!["generate"]
            );
            probe.metal_registry_scan = 1;
            probe.metal_model_types = vec!["qwen3".into()];
            let result = assess(&llama, ProviderId::Vllm, Some(&probe));
            assert!(!result.loadable());
            assert_eq!(result.evidence, "runtime-probe");
            probe.metal_model_types.push("llama".into());
            assert!(assess(&llama, ProviderId::Vllm, Some(&probe)).loadable());
        }
        let unknown = artifact(ArtifactFormat::Mlx, &["MadeUpForCausalLM"], Some("made_up"));
        assert!(!assess(&unknown, ProviderId::Vllm, Some(&probe)).loadable());
        probe.architectures.clear();
        let inconsistent = artifact(ArtifactFormat::Mlx, &["MadeUpForCausalLM"], Some("llama"));
        assert!(!assess(&inconsistent, ProviderId::Vllm, Some(&probe)).loadable());
    }

    #[test]
    fn metal_image_chat_is_native_adapter_scoped_and_never_audio_or_video() {
        let probe = metal_probe();
        for (model_type, architecture, image) in [
            ("qwen3_vl", "Qwen3VLForConditionalGeneration", true),
            ("paddleocr_vl", "PaddleOCRVLForConditionalGeneration", true),
            ("qwen3_5", "Qwen3_5ForConditionalGeneration", true),
            ("gemma4", "Gemma4ForConditionalGeneration", false),
        ] {
            let mut model = artifact(ArtifactFormat::Mlx, &[architecture], Some(model_type));
            model.modalities = Modalities {
                text: true,
                image: true,
                audio: true,
                video: true,
            };
            let result = assess(&model, ProviderId::Vllm, Some(&probe));
            assert!(result.loadable(), "{model_type}: {:?}", result.reasons);
            assert_eq!(result.modalities.image, image, "{model_type}");
            assert!(!result.modalities.audio && !result.modalities.video);
            assert_eq!(result.tasks, vec!["generate"]);
        }
        let asr = artifact(
            ArtifactFormat::HfSafetensors,
            &["WhisperForConditionalGeneration"],
            Some("whisper"),
        );
        // Speech-to-text is a separate task/session, never audio chat:
        // loadable for transcription/translation, with no chat modalities.
        let stt = assess(&asr, ProviderId::Vllm, Some(&probe));
        assert!(stt.loadable());
        assert_eq!(stt.tasks, vec!["transcription", "translate"]);
        assert_eq!(stt.modalities, Modalities::default());
        assert!(!stt.modalities.audio && !stt.modalities.video && !stt.modalities.image);
        let mut fp8 = artifact(
            ArtifactFormat::HfSafetensors,
            &["Qwen3_5ForConditionalGeneration"],
            Some("qwen3_5"),
        );
        fp8.quantization = Some("fp8".into());
        fp8.modalities = Modalities {
            text: true,
            image: true,
            audio: false,
            video: true,
        };
        let text_backbone = assess(&fp8, ProviderId::Vllm, Some(&probe));
        assert!(text_backbone.loadable());
        assert_eq!(text_backbone.modalities, Modalities::text_only());
        let mut embedding = artifact(ArtifactFormat::Mlx, &["Qwen3ForCausalLM"], Some("qwen3"));
        embedding.role = ArtifactRole::Embedding;
        assert_eq!(
            assess(&embedding, ProviderId::Vllm, Some(&probe)).tasks,
            vec!["embed"]
        );
        let mut projector = artifact(ArtifactFormat::Gguf, &["clip"], None);
        projector.role = ArtifactRole::Projector;
        assert_eq!(
            assess(&projector, ProviderId::Vllm, Some(&probe)).reasons[0].code,
            "projector-companion"
        );
    }

    #[test]
    fn metal_transcription_is_task_scoped_and_qwen3_asr_cannot_translate() {
        let probe = metal_probe();
        // Qwen3-ASR serves transcriptions only (docs/stt.md); translation
        // needs Whisper. Neither enables audio/video chat.
        let asr = artifact(
            ArtifactFormat::HfSafetensors,
            &["Qwen3ASRForConditionalGeneration"],
            Some("qwen3_asr"),
        );
        let result = assess(&asr, ProviderId::Vllm, Some(&probe));
        assert!(result.loadable());
        assert_eq!(result.tasks, vec!["transcription"]);
        assert_eq!(result.modalities, Modalities::default());
        assert_eq!(result.evidence, "runtime-probe");
        assert!(result
            .limitations
            .iter()
            .any(|note| note.contains("vllm-metal[stt]")));
        // A mismatched architecture is not advertised as STT.
        let mismatched = artifact(
            ArtifactFormat::HfSafetensors,
            &["LlamaForCausalLM"],
            Some("qwen3_asr"),
        );
        let verdict = assess(&mismatched, ProviderId::Vllm, Some(&probe));
        assert!(!verdict.loadable());
        assert_eq!(verdict.reasons[0].code, "architecture-not-registered");
        // Realtime-only generation has no file-transcription binding here.
        let realtime = artifact(
            ArtifactFormat::HfSafetensors,
            &["Qwen3ASRRealtimeGeneration"],
            Some("qwen3_asr"),
        );
        assert!(!assess(&realtime, ProviderId::Vllm, Some(&probe)).loadable());
        // STT checkpoints are not embedding models.
        let mut embedding = artifact(
            ArtifactFormat::HfSafetensors,
            &["WhisperForConditionalGeneration"],
            Some("whisper"),
        );
        embedding.role = ArtifactRole::Embedding;
        assert_eq!(
            assess(&embedding, ProviderId::Vllm, Some(&probe)).reasons[0].code,
            "model-type-not-embedding"
        );
    }

    #[test]
    fn speech_execution_requires_installed_task_and_dependencies() {
        let whisper = artifact(
            ArtifactFormat::HfSafetensors,
            &["WhisperForConditionalGeneration"],
            Some("whisper"),
        );
        let mut metal = metal_probe();
        let ready = |probe: &ProbeRecord| {
            let result = assess(&whisper, ProviderId::Vllm, Some(probe));
            result.loadable() && result.readiness.is_empty()
        };
        assert!(ready(&metal));
        metal.metal_stt_extras = false;
        assert!(!ready(&metal));
        metal.metal_transcription_model_types.clear();
        assert!(!assess(&whisper, ProviderId::Vllm, Some(&metal)).loadable());
        metal.metal_transcription_scan = 0;
        assert!(!ready(&metal));
        let mut standard = ProbeRecord {
            architectures: vec!["WhisperForConditionalGeneration".into()],
            multimodal_architectures: vec!["WhisperForConditionalGeneration".into()],
            transcription_scan: 1,
            transcription_architectures: vec!["WhisperForConditionalGeneration".into()],
            transcription_only_architectures: vec!["WhisperForConditionalGeneration".into()],
            translation_architectures: vec!["WhisperForConditionalGeneration".into()],
            ..Default::default()
        };
        let result = assess(&whisper, ProviderId::Vllm, Some(&standard));
        assert_eq!(result.tasks, vec!["transcription", "translate"]);
        assert_eq!(result.modalities, Modalities::default());
        standard.transcription_architectures.clear();
        assert!(!assess(&whisper, ProviderId::Vllm, Some(&standard)).loadable());
    }

    fn artifact(
        format: ArtifactFormat,
        architectures: &[&str],
        model_type: Option<&str>,
    ) -> ModelArtifact {
        ModelArtifact {
            path: "/models/x".into(),
            name: "x".into(),
            format,
            role: ArtifactRole::Model,
            size_bytes: 1,
            file_count: 1,
            architectures: architectures
                .iter()
                .map(|value| value.to_string())
                .collect(),
            model_type: model_type.map(str::to_owned),
            quantization: None,
            has_tokenizer: true,
            has_processor: false,
            has_chat_template: true,
            modalities: Modalities::text_only(),
            missing: Vec::new(),
            incomplete: false,
            revision: None,
            repository: None,
            ownership: "external",
            notes: Vec::new(),
        }
    }

    #[test]
    fn each_provider_accepts_only_its_own_formats() {
        let gguf = artifact(ArtifactFormat::Gguf, &["llama"], None);
        assert!(assess(&gguf, ProviderId::Llama, None).loadable());
        let vllm = assess(&gguf, ProviderId::Vllm, None);
        assert_eq!(vllm.status, CompatStatus::Unsupported);
        assert_eq!(vllm.reasons[0].code, "vllm-gguf-plugin");
        assert!(!assess(&gguf, ProviderId::MlxVlm, None).loadable());

        let hf = artifact(
            ArtifactFormat::HfSafetensors,
            &["LlamaForCausalLM"],
            Some("llama"),
        );
        assert_eq!(
            assess(&hf, ProviderId::Llama, None).reasons[0].code,
            "llama-requires-gguf"
        );
        let on_vllm = assess(&hf, ProviderId::Vllm, None);
        assert_eq!(on_vllm.status, CompatStatus::Supported);
        assert_eq!(on_vllm.evidence, "pinned-registry");
        assert!(assess(&hf, ProviderId::MlxVlm, None).loadable());

        let mlx = artifact(ArtifactFormat::Mlx, &["LlamaForCausalLM"], Some("llama"));
        assert_eq!(
            assess(&mlx, ProviderId::Vllm, None).reasons[0].code,
            "vllm-mlx-format"
        );
        assert!(assess(&mlx, ProviderId::MlxVlm, None).loadable());
    }

    #[test]
    fn unregistered_architectures_are_not_advertised() {
        let unknown = artifact(
            ArtifactFormat::HfSafetensors,
            &["MadeUpForCausalLM"],
            Some("made_up"),
        );
        let vllm = assess(&unknown, ProviderId::Vllm, None);
        assert_eq!(vllm.status, CompatStatus::Unsupported);
        assert_eq!(vllm.reasons[0].code, "architecture-not-registered");
        let mlx = assess(&unknown, ProviderId::MlxVlm, None);
        assert_eq!(mlx.reasons[0].code, "model-type-not-registered");
        assert_eq!(mlx.modalities, Modalities::default());
    }

    #[test]
    fn a_probed_registry_overrides_the_pinned_list() {
        let model = artifact(
            ArtifactFormat::HfSafetensors,
            &["LlamaForCausalLM"],
            Some("llama"),
        );
        let probe = ProbeRecord {
            version: "0.30.0".into(),
            architectures: vec!["Qwen2ForCausalLM".into()],
            ..Default::default()
        };
        let result = assess(&model, ProviderId::Vllm, Some(&probe));
        assert_eq!(result.status, CompatStatus::Unsupported);
        assert_eq!(result.evidence, "runtime-probe");
        assert!(result.reasons[0].detail.contains("0.30.0"));
        let mlx_probe = ProbeRecord {
            version: "0.7.6".into(),
            model_types: vec!["llama".into()],
            model_type_aliases: [("mistral".to_string(), "llama".to_string())].into(),
            ..Default::default()
        };
        let mistral = artifact(ArtifactFormat::Mlx, &[], Some("mistral"));
        assert!(assess(&mistral, ProviderId::MlxVlm, Some(&mlx_probe)).loadable());
    }

    #[test]
    fn effective_modalities_are_the_intersection_with_explicit_limitations() {
        let mut vlm = artifact(
            ArtifactFormat::HfSafetensors,
            &["Qwen2_5_VLForConditionalGeneration"],
            Some("qwen2_5_vl"),
        );
        vlm.modalities = Modalities {
            text: true,
            image: true,
            audio: false,
            video: true,
        };
        let vllm = assess(&vlm, ProviderId::Vllm, None);
        assert_eq!(vllm.status, CompatStatus::Supported);
        assert!(vllm.modalities.image && vllm.modalities.video);
        let mlx = assess(&vlm, ProviderId::MlxVlm, None);
        assert!(mlx
            .limitations
            .iter()
            .any(|note| note.contains("samples video")));
        let mut gguf = artifact(ArtifactFormat::Gguf, &["qwen2vl"], None);
        gguf.modalities = Modalities {
            text: true,
            image: false,
            audio: false,
            video: true,
        };
        let llama = assess(&gguf, ProviderId::Llama, None);
        assert!(!llama.modalities.video);
        assert!(llama.limitations.iter().any(|note| note.contains("video")));
    }

    #[test]
    fn readiness_problems_do_not_change_compatibility() {
        let mut model = artifact(
            ArtifactFormat::HfSafetensors,
            &["LlamaForCausalLM"],
            Some("llama"),
        );
        model.missing = vec!["model-00002-of-00002.safetensors".into()];
        model.incomplete = true;
        let result = assess(&model, ProviderId::Vllm, None);
        assert_eq!(result.status, CompatStatus::Supported);
        assert_eq!(result.readiness.len(), 2);
    }

    #[test]
    fn mlx_rejects_torch_only_quantization_and_flags_converted_weights() {
        let mut gptq = artifact(
            ArtifactFormat::HfSafetensors,
            &["LlamaForCausalLM"],
            Some("llama"),
        );
        gptq.quantization = Some("gptq".into());
        assert_eq!(
            assess(&gptq, ProviderId::MlxVlm, None).reasons[0].code,
            "mlx-quantization"
        );
        gptq.quantization = Some("fp8".into());
        assert_eq!(
            assess(&gptq, ProviderId::MlxVlm, None).status,
            CompatStatus::Partial
        );
    }

    #[test]
    fn vllm_pure_embedding_architectures_serve_embeddings_whatever_the_role() {
        let bert = artifact(ArtifactFormat::HfSafetensors, &["BertModel"], Some("bert"));
        let verdict = assess(&bert, ProviderId::Vllm, None);
        assert_eq!(verdict.tasks, vec!["embed"]);
        let qwen = artifact(
            ArtifactFormat::HfSafetensors,
            &["Qwen2ForCausalLM"],
            Some("qwen2"),
        );
        assert_eq!(
            assess(&qwen, ProviderId::Vllm, None).tasks,
            vec!["generate", "embed"]
        );
        let mut sentence = qwen.clone();
        sentence.role = ArtifactRole::Embedding;
        assert_eq!(
            assess(&sentence, ProviderId::Vllm, None).tasks,
            vec!["embed"]
        );
        // A probe's own task lists decide for the installed version.
        let probe = ProbeRecord {
            version: "0.32.0".into(),
            architectures: vec!["BertModel".into()],
            generation_architectures: vec!["BertModel".into()],
            embedding_architectures: vec!["XLMRobertaModel".into()],
            ..Default::default()
        };
        assert_eq!(
            assess(&bert, ProviderId::Vllm, Some(&probe)).tasks,
            vec!["generate"]
        );
    }

    #[test]
    fn mlx_non_generative_packages_never_serve_chat() {
        for (model_type, architecture) in [
            ("sam3", "Sam3Model"),
            ("sam3.1_video", "Sam3VideoModel"),
            ("qwen_image", "QwenImagePipeline"),
            ("rf-detr", "RFDetr"),
            ("dinov2_with_registers", "Dinov2WithRegistersModel"),
            (
                "openai_privacy_filter",
                "OpenAIPrivacyFilterForTokenClassification",
            ),
        ] {
            let model = artifact(
                ArtifactFormat::HfSafetensors,
                &[architecture],
                Some(model_type),
            );
            let verdict = assess(&model, ProviderId::MlxVlm, None);
            assert_eq!(verdict.status, CompatStatus::Unsupported, "{model_type}");
            assert_eq!(
                verdict.reasons[0].code, "model-type-not-generative",
                "{model_type}"
            );
            assert!(verdict.tasks.is_empty());
            assert_eq!(verdict.modalities, Modalities::default());
        }
        // Encoders with an embedding head serve embeddings instead.
        let bert = artifact(ArtifactFormat::HfSafetensors, &["BertModel"], Some("bert"));
        assert_eq!(assess(&bert, ProviderId::MlxVlm, None).tasks, vec!["embed"]);
    }

    #[test]
    fn mlx_embedding_role_uses_the_embedding_remapping() {
        let mut qwen3 = artifact(ArtifactFormat::Mlx, &["Qwen3ForCausalLM"], Some("qwen3"));
        assert_eq!(
            assess(&qwen3, ProviderId::MlxVlm, None).tasks,
            vec!["generate"]
        );
        qwen3.role = ArtifactRole::Embedding;
        let verdict = assess(&qwen3, ProviderId::MlxVlm, None);
        assert_eq!(
            (verdict.status, verdict.tasks),
            (CompatStatus::Supported, vec!["embed"])
        );
        let mut llama = artifact(ArtifactFormat::Mlx, &["LlamaForCausalLM"], Some("llama"));
        llama.role = ArtifactRole::Embedding;
        assert_eq!(
            assess(&llama, ProviderId::MlxVlm, None).reasons[0].code,
            "model-type-not-embedding"
        );
        let probe = ProbeRecord {
            version: "0.7.7".into(),
            model_types: vec!["llama".into(), "llama_embedding".into()],
            embedding_model_type_aliases: [("llama".to_string(), "llama_embedding".to_string())]
                .into(),
            embedding_model_types: vec!["llama_embedding".into()],
            package_scan: 1,
            ..Default::default()
        };
        assert_eq!(
            assess(&llama, ProviderId::MlxVlm, Some(&probe)).tasks,
            vec!["embed"]
        );
    }

    #[test]
    fn mlx_reports_audio_only_for_packages_with_an_audio_encoder() {
        let declared = Modalities {
            text: true,
            image: true,
            audio: true,
            video: false,
        };
        let mut vl = artifact(
            ArtifactFormat::Mlx,
            &["Qwen2_5_VLForConditionalGeneration"],
            Some("qwen2_5_vl"),
        );
        vl.modalities = declared;
        let verdict = assess(&vl, ProviderId::MlxVlm, None);
        assert!(verdict.modalities.image && !verdict.modalities.audio);
        assert!(verdict
            .limitations
            .iter()
            .any(|note| note.contains("no audio encoder")));
        let mut omni = artifact(
            ArtifactFormat::Mlx,
            &["Gemma3nForConditionalGeneration"],
            Some("gemma3n"),
        );
        omni.modalities = declared;
        assert!(assess(&omni, ProviderId::MlxVlm, None).modalities.audio);
        // An installed version that adds audio to a package is believed.
        let probe = ProbeRecord {
            version: "0.7.7".into(),
            model_types: vec!["qwen2_5_vl".into()],
            audio_model_types: vec!["qwen2_5_vl".into()],
            package_scan: 1,
            ..Default::default()
        };
        assert!(
            assess(&vl, ProviderId::MlxVlm, Some(&probe))
                .modalities
                .audio
        );
        // vLLM keeps the model's declared audio support.
        let mut vllm = artifact(
            ArtifactFormat::HfSafetensors,
            &["Qwen2_5OmniThinkerForConditionalGeneration"],
            Some("qwen2_5_omni"),
        );
        vllm.modalities = declared;
        let probe = ProbeRecord {
            version: "0.31.0".into(),
            architectures: vec!["Qwen2_5OmniThinkerForConditionalGeneration".into()],
            multimodal_architectures: vec!["Qwen2_5OmniThinkerForConditionalGeneration".into()],
            ..Default::default()
        };
        assert!(
            assess(&vllm, ProviderId::Vllm, Some(&probe))
                .modalities
                .audio
        );
    }

    /// What `python_env`'s mlx-vlm probe prints for a runtime newer than the
    /// pinned list: the v0.7.6 packages plus three it added.
    fn newer_mlx_probe() -> ProbeRecord {
        let mut model_types: Vec<String> = data::MLX_VLM_MODEL_TYPES
            .iter()
            .map(|name| name.to_string())
            .collect();
        model_types.extend(["acme_detector", "acme_embedder", "acme_painter"].map(String::from));
        let line = serde_json::json!({
            "version": "0.8.0",
            "python_version": "3.12.4",
            "accelerator": "metal",
            "model_types": model_types,
            "model_type_aliases": {"mistral": "llama"},
            "embedding_model_type_aliases": {"qwen3": "qwen3_embedding"},
            "audio_model_types": ["gemma3n"],
            "embedding_model_types": ["bert", "qwen3_embedding", "acme_embedder"],
            "image_generation_model_types": ["qwen_image", "acme_painter"],
            "package_scan": 1,
            "errors": []
        });
        crate::providers::python_env::parse_probe_output(&format!("INFO\nAIOLM_PROBE={line}\n"))
            .unwrap()
    }

    #[test]
    fn packages_added_after_the_pinned_release_are_unknown_unless_the_scan_proves_a_task() {
        let probe = newer_mlx_probe();
        let model = |model_type: &str| artifact(ArtifactFormat::Mlx, &["X"], Some(model_type));
        // A new detector is neither advertised for chat nor called unsupported.
        let detector = assess(&model("acme_detector"), ProviderId::MlxVlm, Some(&probe));
        assert_eq!(detector.status, CompatStatus::Unknown);
        assert_eq!(detector.reasons[0].code, "model-type-unverified");
        assert!(detector.tasks.is_empty() && !detector.loadable());
        assert_eq!(detector.modalities, Modalities::default());
        assert_eq!(detector.evidence, "runtime-probe");
        let mut embedding = model("acme_detector");
        embedding.role = ArtifactRole::Embedding;
        assert_eq!(
            assess(&embedding, ProviderId::MlxVlm, Some(&probe)).reasons[0].code,
            "model-type-not-embedding"
        );
        // Source evidence decides the packages it can decide.
        assert_eq!(
            assess(&model("acme_embedder"), ProviderId::MlxVlm, Some(&probe)).tasks,
            vec!["embed"]
        );
        let painter = assess(&model("acme_painter"), ProviderId::MlxVlm, Some(&probe));
        assert_eq!(painter.reasons[0].code, "model-type-not-generative");
        // Pinned packages keep working with the newer runtime.
        let mut vl = model("qwen2_5_vl");
        vl.modalities = Modalities {
            text: true,
            image: true,
            audio: true,
            video: false,
        };
        let verdict = assess(&vl, ProviderId::MlxVlm, Some(&probe));
        assert_eq!(verdict.tasks, vec!["generate"]);
        assert!(verdict.modalities.image && !verdict.modalities.audio);
        assert_eq!(
            assess(&model("mistral"), ProviderId::MlxVlm, Some(&probe)).tasks,
            vec!["generate"]
        );
        assert_eq!(
            assess(&model("sam3"), ProviderId::MlxVlm, Some(&probe)).reasons[0].code,
            "model-type-not-generative"
        );
        assert_eq!(
            assess(&model("bert"), ProviderId::MlxVlm, Some(&probe)).tasks,
            vec!["embed"]
        );
        let mut qwen3 = model("qwen3");
        qwen3.role = ArtifactRole::Embedding;
        assert_eq!(
            assess(&qwen3, ProviderId::MlxVlm, Some(&probe)).tasks,
            vec!["embed"]
        );
    }

    #[test]
    fn scan_provenance_survives_a_manifest_reload_and_older_records_stay_conservative() {
        let probe = newer_mlx_probe();
        let manifest = crate::providers::python_env::PythonRuntimeManifest {
            format: 1,
            provider: ProviderId::MlxVlm,
            id: "managed-0-8-0".into(),
            kind: crate::providers::python_env::InstallationKind::Managed,
            python: "python".into(),
            requested_version: None,
            probe: Some(probe.clone()),
        };
        let saved = serde_json::to_string_pretty(&manifest).unwrap();
        let reloaded: crate::providers::python_env::PythonRuntimeManifest =
            serde_json::from_str(&saved).unwrap();
        let reloaded = reloaded.probe.unwrap();
        assert_eq!(reloaded, probe);
        let embedder = artifact(ArtifactFormat::Mlx, &["X"], Some("acme_embedder"));
        assert_eq!(
            assess(&embedder, ProviderId::MlxVlm, Some(&reloaded)).tasks,
            vec!["embed"]
        );
        // A record written before the scan existed has no package lists; its
        // empty lists must not be read as "no audio, no embeddings".
        let mut older = serde_json::to_value(&probe).unwrap();
        for key in [
            "audio_model_types",
            "embedding_model_types",
            "image_generation_model_types",
            "package_scan",
        ] {
            older.as_object_mut().unwrap().remove(key);
        }
        let older: ProbeRecord = serde_json::from_value(older).unwrap();
        assert_eq!(older.package_scan, 0);
        let unknown = assess(&embedder, ProviderId::MlxVlm, Some(&older));
        assert_eq!(
            (unknown.status, unknown.reasons[0].code),
            (CompatStatus::Unknown, "model-type-unverified")
        );
        let mut omni = artifact(ArtifactFormat::Mlx, &["X"], Some("gemma3n"));
        omni.modalities = Modalities {
            text: true,
            image: true,
            audio: true,
            video: false,
        };
        assert!(
            assess(&omni, ProviderId::MlxVlm, Some(&older))
                .modalities
                .audio,
            "pinned audio list applies"
        );
        assert_eq!(
            assess(
                &artifact(ArtifactFormat::Mlx, &["X"], Some("bert")),
                ProviderId::MlxVlm,
                Some(&older)
            )
            .tasks,
            vec!["embed"]
        );
    }
}
