//! Pre-load estimate of the RAM, VRAM and disk a launch configuration needs.
//!
//! Nothing is loaded and no runtime is started. Model files contribute their
//! size on disk and the bounded GGUF header facts from
//! [`gguf::read_model_facts`]; the configuration contributes the values
//! `server::build_args` would launch with. The public figures are one planning
//! allocation for VRAM, RAM offload and disk-backed offload. Working-buffer
//! bounds stay internal; their midpoint supplies the planning allowance.
//!
//! The model is placed the way llama.cpp's `llama_model::load_tensors`
//! (`src/llama-model.cpp`) places it:
//! - the input layer (`token_embd` and the other `LLM_TENSOR_LAYER_INPUT`
//!   tensors) stays on the CPU;
//! - `n_gpu_layers = N` offloads the output layer first and then the last
//!   `N - 1` repeating layers (`i_gpu_start = n_layer + 1 - N`, since
//!   llama.cpp #18148). Earlier runtimes offloaded the last `N` repeating
//!   layers and the output layer only once `N > n_layer`; the preview uses the
//!   current output-first convention, not an envelope over runtime versions;
//! - `--cpu-moe`, `--n-cpu-moe` and `--n-cpu-ffn` keep the matching expert or
//!   dense FFN tensors of offloaded layers on the CPU (`common/common.h`);
//! - a model without `output.weight` loads `token_embd` again for its output
//!   layer (`TENSOR_DUPLICATED`);
//! - LoRA tensors follow the tensor they adapt (`src/llama-adapter.cpp`).
//!
//! The KV cache follows `llama_kv_cache` (`src/llama-kv-cache.cpp`) for plain
//! attention models: every trunk layer holds K of `n_embd_head_k *
//! n_head_kv(il)` and V of `n_embd_head_v * n_head_kv(il)` elements per cell
//! (V uses the widest layer when flash attention is off, because V is then
//! stored transposed), at the configured cache types, on the device of its
//! layer unless KV offload is disabled. The context is the total for the
//! server, padded to 256 cells, and is split into per-sequence streams of
//! `pad256(n_ctx / n_seq)` cells unless the cache is unified
//! (`src/llama-context.cpp`); it is not multiplied by the slot count.
//! `--ctx-size 0` means the trained context, which current runtimes multiply
//! by the slot count while earlier ones do not (`common/fit.cpp`).
//!
//! Qwen3-Next, Qwen3.5 and Qwen4 hybrids cache only full-attention layers;
//! recurrent layers hold F32 convolution and delta-net state per sequence.
//! Qwen4 also holds an indexer key cache and optional PLE convolution state.
//! Other recurrent, sliding-window and MLA layouts remain unsupported.
//! Model files on disk are shown separately from SSD offload. Offload is the
//! model/cache working set left outside VRAM; fixed host process memory and
//! the runtime's always-host token embedding are excluded. Capacity overflow
//! describes required offload and does not silently change launch settings.

use crate::config::{AppConfig, SplitMode};
use crate::gguf::{self, ModelFacts, TensorBytes};
use crate::hardware::{self, GpuVendor};
use crate::tuning_defaults;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

const MIB: u64 = 1024 * 1024;

/// llama-server's own process: code, tokenizer tables, HTTP and slot state.
const RAM_BASE: ResourceRange = ResourceRange::new(160 * MIB, 640 * MIB);
/// Host memory a GPU runtime keeps for its driver and math libraries.
const GPU_HOST_RUNTIME: ResourceRange = ResourceRange::new(64 * MIB, 512 * MIB);
/// Device memory a GPU runtime reserves on each device before the first
/// buffer: context, library workspaces and memory pools.
const GPU_DEVICE_RUNTIME: ResourceRange = ResourceRange::new(128 * MIB, 640 * MIB);
/// Working memory a multimodal projector needs to encode media, beyond its
/// weights; it depends on image size limits the file does not state.
const PROJECTOR_COMPUTE: ResourceRange = ResourceRange::new(32 * MIB, 1024 * MIB);
/// llama.cpp's own batch sizes (`common/common.h`), used only to size the
/// compute heuristic when the runtime's defaults were not verified.
const UPSTREAM_BATCH: u64 = 2048;
const UPSTREAM_UBATCH: u64 = 512;
/// llama-server's automatic slot count (`tools/server/server.cpp`).
const AUTO_SLOTS: u64 = 4;
/// Vocabulary bounds for the logits buffer when no tensor states one.
const VOCAB_BOUNDS: (u64, u64) = (32_000, 262_144);
/// Bounds on configuration-supplied lists; the app never produces more.
const MAX_ADAPTERS: usize = 32;
const MAX_SERVER_ARGS: usize = 512;
const MAX_SHARDS: usize = 1_024;
const MAX_CACHED_FACTS: usize = 64;

mod capacity;

/// A lower and upper bound, in bytes.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResourceRange {
    pub min_bytes: u64,
    pub max_bytes: u64,
}

impl ResourceRange {
    const fn new(min_bytes: u64, max_bytes: u64) -> Self {
        Self {
            min_bytes,
            max_bytes,
        }
    }

    const fn exact(bytes: u64) -> Self {
        Self::new(bytes, bytes)
    }

    fn add(self, other: Self) -> Self {
        Self::new(
            self.min_bytes.saturating_add(other.min_bytes),
            self.max_bytes.saturating_add(other.max_bytes),
        )
    }

    fn planned(self) -> u64 {
        self.min_bytes
            .saturating_add(self.max_bytes.saturating_sub(self.min_bytes) / 2)
    }
}

/// Why an estimate is shaped the way it is. Serialized as the snake_case
/// codes the interface explains.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EstimateNote {
    /// Working buffers and runtime overhead are bounded, not measured.
    Approximate,
    /// A value that changes the estimate is left to the runtime.
    Automatic,
    /// A header lacks a value the estimate needs.
    MissingMetadata,
    /// The architecture keeps memory this estimate does not model.
    UnsupportedArchitecture,
    /// A configured file is not on disk.
    MissingFiles,
    /// A projector, adapter or draft model is included.
    Auxiliary,
    /// A selected GPU shares system memory, so VRAM overlaps RAM.
    SharedMemory,
    /// Advanced server arguments the estimate cannot account for.
    AdvancedOptions,
    CapacityUnknown,
    PlacementAdjustment,
    DiskOffload,
    /// Eligible PLE weights are explicitly read on demand from disk.
    LazyOffload,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ResourceEstimate {
    pub vram_bytes: Option<u64>,
    pub ram_offload_bytes: Option<u64>,
    pub ssd_offload_bytes: Option<u64>,
    pub required_vram_bytes: Option<u64>,
    pub host_memory_bytes: Option<u64>,
    pub vram_capacity_bytes: Option<u64>,
    pub ram_capacity_bytes: Option<u64>,
    pub disk_bytes: u64,
    pub disk_complete: bool,
    pub model_bytes: u64,
    pub auxiliary_bytes: u64,
    pub kv_bytes: Option<u64>,
    pub notes: Vec<EstimateNote>,
}

/// Internal working-buffer uncertainty for a single configured placement.
#[derive(Clone, Debug, PartialEq)]
struct MemoryEstimate {
    pub ram: Option<ResourceRange>,
    pub vram: Option<ResourceRange>,
    pub disk_bytes: u64,
    pub disk_complete: bool,
    pub model_bytes: u64,
    pub auxiliary_bytes: u64,
    pub kv_bytes: Option<u64>,
    pub ram_capacity_bytes: Option<u64>,
    pub notes: Vec<EstimateNote>,
    pub cpu_offload_bytes: Option<u64>,
    pub lazy_offload_bytes: u64,
}

/// Which devices the selected runtime can place weights on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Accelerator {
    /// A CPU-only runtime.
    Cpu,
    /// GPU devices the runtime will use.
    Gpu { devices: usize },
    /// No runtime is selected, or its devices were not found.
    Unknown { devices: usize },
}

/// Facts about the machine, gathered outside the estimate so that the
/// estimate itself stays a pure function of files and configuration.
#[derive(Clone, Debug)]
pub struct Environment {
    pub ram_capacity_bytes: Option<u64>,
    pub vram_capacity_bytes: Option<u64>,
    pub accelerator: Accelerator,
    /// A GPU the runtime would use is integrated and shares system memory.
    pub shared_memory: bool,
}

impl Environment {
    pub fn detect(cfg: &AppConfig, runtime_devices: &[String]) -> Self {
        let ram_capacity_bytes = crate::hardware_memory::system_memory_bytes();
        let profile = (cfg.active_backend != "cpu").then(hardware::detect);
        let mut env = Self::from_profile(cfg, ram_capacity_bytes, profile.as_ref());
        // A possible integrated adapter in the machine is not proof that the
        // selected runtime device shares RAM. Only resolved selection may use
        // RAM as GPU capacity.
        env.shared_memory = false;
        if let Some(capacity) = capacity::gpu_capacity(cfg, profile.as_ref(), runtime_devices) {
            env.vram_capacity_bytes = Some(capacity.dedicated_bytes);
            env.shared_memory = capacity.shared;
            env.accelerator = Accelerator::Gpu {
                devices: capacity.devices,
            };
        }
        env
    }

    fn from_profile(
        cfg: &AppConfig,
        ram_capacity_bytes: Option<u64>,
        profile: Option<&hardware::DeviceProfile>,
    ) -> Self {
        let device_count = |count: usize| {
            if cfg.gpu.split_mode == SplitMode::Single {
                1
            } else {
                count.max(1)
            }
        };
        let selected = device_count(cfg.gpu.gpu_ids.len());
        let vendor = match cfg.active_backend.trim().to_ascii_lowercase().as_str() {
            "cpu" => {
                return Self {
                    ram_capacity_bytes,
                    vram_capacity_bytes: Some(0),
                    accelerator: Accelerator::Cpu,
                    shared_memory: false,
                }
            }
            "cuda" => Some(GpuVendor::Nvidia),
            "rocm" => Some(GpuVendor::Amd),
            "sycl" | "openvino" => Some(GpuVendor::Intel),
            "vulkan" => None,
            _ => {
                return Self {
                    ram_capacity_bytes,
                    vram_capacity_bytes: None,
                    accelerator: Accelerator::Unknown { devices: selected },
                    shared_memory: false,
                }
            }
        };
        let eligible: Vec<_> = profile
            .into_iter()
            .flat_map(|profile| &profile.gpus)
            .filter(|gpu| gpu.vendor != GpuVendor::Unknown)
            .filter(|gpu| vendor.is_none_or(|vendor| gpu.vendor == vendor))
            .collect();
        // The settings editor stores identifiers from the runtime's device list,
        // which are not hardware PCI identifiers. No runtime needs to be spawned
        // again for each edit to honour that declared GPU selection.
        let scope = format!("runtime:{}:", cfg.active_backend);
        let runtime_selection = !cfg.gpu.gpu_ids.is_empty()
            && cfg
                .gpu
                .gpu_ids
                .iter()
                .all(|id| id.strip_prefix(&scope).is_some_and(|id| !id.is_empty()));
        if runtime_selection {
            return Self {
                ram_capacity_bytes,
                vram_capacity_bytes: None,
                accelerator: Accelerator::Gpu { devices: selected },
                shared_memory: eligible.is_empty() || eligible.iter().any(|gpu| gpu.integrated),
            };
        }
        let gpus: Vec<_> = eligible
            .into_iter()
            .filter(|gpu| cfg.gpu.gpu_ids.is_empty() || cfg.gpu.gpu_ids.contains(&gpu.stable_id))
            .collect();
        Self {
            ram_capacity_bytes,
            vram_capacity_bytes: None,
            accelerator: if gpus.is_empty() {
                Accelerator::Unknown { devices: selected }
            } else {
                Accelerator::Gpu {
                    devices: device_count(gpus.len()),
                }
            },
            shared_memory: gpus.iter().any(|gpu| gpu.integrated),
        }
    }
}

/// A KV cache element type llama-server accepts from this app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KvType {
    F32,
    F16,
    Bf16,
    Q8_0,
    Q5_0,
    Q5_1,
    Q4_0,
    Q4_1,
    Iq4Nl,
}

impl KvType {
    fn parse(value: &str) -> Option<Self> {
        Some(match value.trim() {
            "f32" => Self::F32,
            "f16" => Self::F16,
            "bf16" => Self::Bf16,
            "q8_0" => Self::Q8_0,
            "q5_0" => Self::Q5_0,
            "q5_1" => Self::Q5_1,
            "q4_0" => Self::Q4_0,
            "q4_1" => Self::Q4_1,
            "iq4_nl" => Self::Iq4Nl,
            _ => return None,
        })
    }

    /// Elements per block and bytes per block, from `type_traits` in
    /// `ggml/src/ggml.c` and the block layouts in `ggml/src/ggml-common.h`.
    fn block(self) -> (u64, u64) {
        match self {
            Self::F32 => (1, 4),
            Self::F16 | Self::Bf16 => (1, 2),
            Self::Q8_0 => (32, 34),
            Self::Q5_0 => (32, 22),
            Self::Q5_1 => (32, 24),
            Self::Q4_0 | Self::Iq4Nl => (32, 18),
            Self::Q4_1 => (32, 20),
        }
    }

    /// `ggml_row_size`.
    fn row_bytes(self, elements: u64) -> u64 {
        let (block, bytes) = self.block();
        elements.div_ceil(block).saturating_mul(bytes)
    }

    fn quantized(self) -> bool {
        self.block().0 > 1
    }
}

fn pad256(value: u64) -> u64 {
    value.div_ceil(256).saturating_mul(256)
}

/// Advanced server arguments, read the way llama.cpp's `common/arg.cpp`
/// reads them. Only arguments that move or add memory are interpreted.
#[derive(Debug)]
struct ServerArgs {
    cpu_moe: bool,
    n_cpu_ffn: u64,
    kv_offload: bool,
    kv_unified: Option<bool>,
    fit: bool,
    fit_ctx: Option<u64>,
    mmproj_offload: bool,
    op_offload: bool,
    lazy_mode: LazyMode,
    draft_type_k: Option<KvType>,
    draft_type_v: Option<KvType>,
    draft_cpu_moe: bool,
    draft_n_cpu_moe: u64,
    /// An argument moves or adds memory in a way the estimate cannot follow.
    unmodeled: bool,
    /// An argument this estimate does not recognise.
    unknown: bool,
}

impl Default for ServerArgs {
    fn default() -> Self {
        Self {
            cpu_moe: false,
            n_cpu_ffn: 0,
            kv_offload: true,
            kv_unified: None,
            fit: true,
            fit_ctx: None,
            mmproj_offload: true,
            op_offload: true,
            lazy_mode: LazyMode::Auto,
            draft_type_k: None,
            draft_type_v: None,
            draft_cpu_moe: false,
            draft_n_cpu_moe: 0,
            unmodeled: false,
            unknown: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum LazyMode {
    Off,
    Auto,
    On,
}

impl LazyMode {
    // llama_model_loader::lazy_read::add: the decision is independent of
    // --load-mode. Only tensors marked TENSOR_READ_LAZY qualify; mmap alone
    // does not assign all model weights to disk.
    fn disk_bytes(self, tensors: &TensorBytes) -> u64 {
        let bytes = tensors.per_layer_token_embd;
        match self {
            Self::On => bytes,
            Self::Auto if bytes > 4 * 1024 * MIB => bytes,
            _ => 0,
        }
    }
}

/// Arguments that change nothing this estimate measures: sampling, chat
/// templates, networking, logging and threading. `--no-` spellings are matched
/// by their positive form; allocation-changing overrides are handled separately.
const NEUTRAL_ARGS: &[&str] = &[
    "-tb",
    "--threads-batch",
    "-C",
    "-Cr",
    "-Cb",
    "-Crb",
    "-n",
    "--predict",
    "--n-predict",
    "--swa-full",
    "-cms",
    "--checkpoint-min-step",
    "--context-shift",
    "--perf",
    "--show-timings",
    "-sp",
    "--special",
    "--warmup",
    "--spm-infill",
    "--samplers",
    "-s",
    "--seed",
    "--sampler-seq",
    "--sampling-seq",
    "--ignore-eos",
    "--temp",
    "--temperature",
    "--top-k",
    "--top-p",
    "--min-p",
    "--top-nsigma",
    "--top-n-sigma",
    "--typical",
    "--typical-p",
    "--repeat-last-n",
    "--repeat-penalty",
    "--presence-penalty",
    "--frequency-penalty",
    "--adaptive-target",
    "--adaptive-decay",
    "--dynatemp-range",
    "--dynatemp-exp",
    "-l",
    "--logit-bias",
    "--grammar",
    "--grammar-file",
    "-j",
    "--json-schema",
    "-jf",
    "--json-schema-file",
    "-bs",
    "--backend-sampling",
    "--attention",
    "-gan",
    "--grp-attn-n",
    "-gaw",
    "--grp-attn-w",
    "-dt",
    "--defrag-thold",
    "-cb",
    "--cont-batching",
    "-nocb",
    "--numa",
    "--check-tensors",
    "--lora-init-without-apply",
    "-a",
    "--alias",
    "--tags",
    "--reuse-port",
    "--path",
    "--api-prefix",
    "--tools",
    "--tools-runtime",
    "-ag",
    "--agent",
    "--ui",
    "--webui",
    "--threads-http",
    "--cache-prompt",
    "--cache-reuse",
    "--metrics",
    "--props",
    "--slots",
    "--slot-save-path",
    "--media-path",
    "--jinja",
    "--skip-chat-parsing",
    "--prefill-assistant",
    "-sps",
    "--slot-prompt-similarity",
    "--sse-ping-interval",
    "-v",
    "--verbose",
    "-lv",
    "--verbosity",
    "--offline",
    "-co",
    "--color",
    "-e",
    "--escape",
    "-fitt",
    "--fit-target",
    "-fitp",
    "--fit-print",
    "--models-dir",
    "--models-max",
    "--models-autoload",
    "-td",
    "-tbd",
    "-Cd",
    "-Crd",
    "-Cbd",
    "-Crbd",
    "--draft",
    "--draft-n",
    "--draft-max",
    "--draft-min",
    "--draft-n-min",
];

/// Prefixes of argument families that are all neutral in the same sense.
const NEUTRAL_PREFIXES: &[&str] = &[
    "--cpu-",
    "--prio",
    "--poll",
    "--dry-",
    "--xtc-",
    "--mirostat",
    "--rope-",
    "--yarn-",
    "--log-",
    "--cors-",
    "--ssl-",
    "--chat-template",
    "--ui-",
    "--webui-",
    "--mcp-",
    "--video-",
    "--spec-ngram-",
    "--spec-synth-",
    "--spec-draft-threads",
    "--spec-draft-cpu-",
    "--spec-draft-prio",
    "--spec-draft-poll",
    "--spec-draft-backend-sampling",
    "--spec-draft-n-max",
    "--spec-draft-n-min",
    "--spec-draft-p-",
    "--draft-p-",
];

/// Arguments that load other files or move memory in ways a header cannot
/// predict: tensor overrides, metadata overrides, remote devices, downloads
/// and presets that pick their own models, and pooled output modes.
const UNMODELED_ARGS: &[&str] = &[
    // These can retain additional host/device buffers or change resident weight
    // copies. A load estimate cannot silently ignore an explicit override.
    "--cache-ram",
    "-cram",
    "--cache-idle-slots",
    "--ctx-checkpoints",
    "-ctxcp",
    "--swa-checkpoints",
    "--load-mode",
    "-lm",
    "--lazy-mode",
    "-lzm",
    "--mmap",
    "--mlock",
    "--direct-io",
    "-dio",
    "--no-host",
    "--repack",
    "-nr",
    "--image-min-tokens",
    "--image-max-tokens",
    "--mtmd-batch-max-tokens",
    "-ot",
    "--override-tensor",
    "-otd",
    "--override-tensor-draft",
    "--spec-draft-override-tensor",
    "--override-kv",
    "-mu",
    "--model-url",
    "-hf",
    "-hfr",
    "--hf-repo",
    "-hff",
    "--hf-file",
    "--spec-draft-hf",
    "-hfd",
    "-hfrd",
    "--hf-repo-draft",
    "--rpc",
    "--kv-unified-per-slot",
    "--embedding",
    "--embeddings",
    "--rerank",
    "--reranking",
    "--pooling",
    "--mtp",
    "--dflash",
    "--eagle3",
    "--spec-default",
    "--models-preset",
];

fn is_neutral(name: &str) -> bool {
    let neutral = |name: &str| {
        NEUTRAL_ARGS.contains(&name)
            || NEUTRAL_PREFIXES
                .iter()
                .any(|prefix| name.starts_with(prefix))
    };
    neutral(name)
        || name
            .strip_prefix("--no-")
            .is_some_and(|rest| neutral(&format!("--{rest}")))
}

fn is_unmodeled(name: &str) -> bool {
    UNMODELED_ARGS.contains(&name)
        || name.strip_prefix("--no-").is_some_and(|rest| UNMODELED_ARGS.contains(&format!("--{rest}").as_str()))
        // Presets such as `--gpt-oss-20b-default` download and select a model.
        || (name.ends_with("-default") || name.ends_with("-spec"))
            && ["--fim-", "--gpt-oss-", "--vision-", "--embd-"]
                .iter()
                .any(|prefix| name.starts_with(prefix))
}

fn parse_server_args(raw: &[String]) -> ServerArgs {
    let mut args = ServerArgs::default();
    let raw = &raw[..raw.len().min(MAX_SERVER_ARGS)];
    let mut index = 0;
    while index < raw.len() {
        let token = raw[index].trim();
        index += 1;
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) => (name.trim(), Some(value.trim())),
            None => (token, None),
        };
        // `config::option_value`'s rule: a following token is a value unless
        // it looks like another option.
        let next = raw
            .get(index)
            .map(|value| value.trim())
            .filter(|value| !value.starts_with('-') || value.parse::<f64>().is_ok());
        let mut value = || match inline {
            Some(value) => Some(value),
            None => {
                let value = next;
                if value.is_some() {
                    index += 1;
                }
                value
            }
        };
        let count = |value: Option<&str>| value.and_then(|value| value.parse::<u64>().ok());
        match name {
            "-cmoe" | "--cpu-moe" => args.cpu_moe = true,
            "-ncffn" | "--n-cpu-ffn" => args.n_cpu_ffn = count(value()).unwrap_or(0),
            "-kvo" | "--kv-offload" => args.kv_offload = true,
            "-nkvo" | "--no-kv-offload" => args.kv_offload = false,
            "-kvu" | "--kv-unified" => args.kv_unified = Some(true),
            "-no-kvu" | "--no-kv-unified" => args.kv_unified = Some(false),
            "-fit" | "--fit" => args.fit = value() != Some("off"),
            "-fitc" | "--fit-ctx" => args.fit_ctx = count(value()),
            "--mmproj-offload" => args.mmproj_offload = true,
            "--no-mmproj-offload" => args.mmproj_offload = false,
            "-mmdev" | "--mmproj-device" => args.mmproj_offload = value() != Some("none"),
            "--op-offload" => args.op_offload = true,
            "--no-op-offload" => args.op_offload = false,
            "-lzm" | "--lazy-mode" => match value() {
                Some("off") => args.lazy_mode = LazyMode::Off,
                Some("auto") => args.lazy_mode = LazyMode::Auto,
                Some("on") => args.lazy_mode = LazyMode::On,
                _ => args.unmodeled = true,
            },
            // These modes keep the same weight placement. File-backed page
            // residency is deliberately not counted as a second RAM copy.
            "-lm" | "--load-mode" => {
                args.unmodeled |= !matches!(value(), Some("none" | "auto" | "mmap"));
            }
            "-ot" | "--override-tensor" => {
                // Input embeddings are already placed on the CPU. Restrict
                // recognition to these literal names; arbitrary regex/device
                // overrides still need an explanation instead of a false fit.
                args.unmodeled |= value().is_none_or(|overrides| {
                    overrides.split(',').any(|entry| {
                        !matches!(
                            entry.trim(),
                            "per_layer_token_embd=CPU"
                                | "per_layer_token_embd.weight=CPU"
                                | "token_embd=CPU"
                                | "token_embd.weight=CPU"
                        )
                    })
                });
            }
            "--spec-draft-type-k" | "-ctkd" | "--cache-type-k-draft" => {
                args.draft_type_k = value().and_then(KvType::parse)
            }
            "--spec-draft-type-v" | "-ctvd" | "--cache-type-v-draft" => {
                args.draft_type_v = value().and_then(KvType::parse)
            }
            "--spec-draft-cpu-moe" | "-cmoed" | "--cpu-moe-draft" => args.draft_cpu_moe = true,
            "--spec-draft-n-cpu-moe" | "--spec-draft-ncmoe" | "-ncmoed" | "--n-cpu-moe-draft" => {
                args.draft_n_cpu_moe = count(value()).unwrap_or(0)
            }
            _ if crate::config::APP_MANAGED_SERVER_ARGS.contains(&name) => {
                // `server::build_args` drops these in favour of the typed
                // settings, and so does this estimate.
                value();
            }
            _ => {
                if is_unmodeled(name) {
                    args.unmodeled = true;
                } else if !is_neutral(name) {
                    args.unknown = true;
                }
                value();
            }
        }
    }
    args
}

/// The settings `server::build_args` launches with, resolved the way it
/// resolves them.
struct Launch {
    ngl: u64,
    /// `0` asks for the model's trained context.
    ctx: u64,
    ubatch: u64,
    /// `None` when the runtime chooses (an unverified runtime default) or the
    /// value is not a cache type this estimate knows.
    type_k: Option<KvType>,
    type_v: Option<KvType>,
    /// `None` for `auto`.
    flash_attn: Option<bool>,
    n_cpu_moe: u64,
    /// `None` for the runtime's automatic slot count.
    parallel: Option<u64>,
    args: ServerArgs,
    /// A resource value is left to the runtime.
    automatic: bool,
}

fn launch_settings(cfg: &AppConfig) -> Launch {
    let inherited = |key: &str| tuning_defaults::inherited(cfg, key);
    let mut automatic = false;
    // `tuning_defaults::filter_args` launches the app's own defaults for these
    // two even when they are marked as runtime defaults.
    let ngl = if cfg.active_backend == "cpu" {
        0
    } else if inherited("ngl") {
        tuning_defaults::app_default_u32("ngl")
    } else {
        cfg.ngl
    };
    let ctx = if inherited("ctx_size") {
        tuning_defaults::app_default_u32("ctx_size")
    } else {
        cfg.ctx_size
    };
    let mut known = |key: &str, value: u64| {
        if inherited(key) {
            automatic = true;
            None
        } else {
            Some(value)
        }
    };
    let batch = known("batch_size", u64::from(cfg.batch_size)).unwrap_or(UPSTREAM_BATCH);
    let ubatch = known("ubatch_size", u64::from(cfg.ubatch_size)).unwrap_or(UPSTREAM_UBATCH);
    let mut cache_type = |key: &str, value: &str| {
        let parsed = (!inherited(key)).then(|| KvType::parse(value)).flatten();
        automatic |= parsed.is_none();
        parsed
    };
    let type_k = cache_type("cache_type_k", &cfg.cache_type_k);
    let type_v = cache_type("cache_type_v", &cfg.cache_type_v);
    let flash_attn = if inherited("flash_attn") {
        automatic = true;
        None
    } else {
        match cfg.flash_attn.as_str() {
            "on" => Some(true),
            "off" => Some(false),
            _ => None,
        }
    };
    // An inherited count omits the flag. Auto fitting may then move experts;
    // estimate() brackets both placements instead of assuming this placeholder.
    let n_cpu_moe = if inherited("n_cpu_moe") {
        0
    } else {
        u64::from(cfg.n_cpu_moe)
    };
    let parallel = (!inherited("parallel") && cfg.parallel > 0).then_some(u64::from(cfg.parallel));
    let args = if cfg.active_backend == "cpu" {
        let mut effective = cfg.server_args.clone();
        crate::inference_args::force_cpu(&mut effective);
        let mut parsed = parse_server_args(&effective);
        parsed.kv_offload = false;
        parsed.op_offload = false;
        parsed.mmproj_offload = false;
        parsed
    } else {
        parse_server_args(&cfg.server_args)
    };
    Launch {
        ngl: u64::from(ngl),
        ctx: u64::from(ctx),
        // llama.cpp never runs a physical batch larger than the logical one.
        ubatch: ubatch.clamp(1, batch.max(1)),
        type_k,
        type_v,
        flash_attn,
        n_cpu_moe,
        parallel,
        args,
        automatic,
    }
}

/// A model file and its shards, as found on disk.
struct FoundModel {
    facts: Arc<ModelFacts>,
    /// Tensor bytes over every shard; `None` when one of them is unreadable.
    tensors: Option<TensorBytes>,
}

enum Loaded {
    Ready(FoundModel),
    Missing,
    Unreadable,
}

/// Unique files counted once towards disk use.
#[derive(Default)]
struct Disk {
    seen: HashSet<PathBuf>,
    model: u64,
    auxiliary: u64,
    complete: bool,
}

impl Disk {
    /// Counts a file once and returns its canonical path, size and
    /// modification time, or `None` when it is not a readable file.
    fn count(
        &mut self,
        path: &Path,
        auxiliary: bool,
    ) -> Option<(PathBuf, u64, Option<SystemTime>)> {
        let found = std::fs::canonicalize(path).ok().and_then(|canonical| {
            let metadata = std::fs::metadata(&canonical).ok()?;
            metadata
                .is_file()
                .then(|| (canonical, metadata.len(), metadata.modified().ok()))
        });
        let Some((canonical, len, modified)) = found else {
            self.complete = false;
            return None;
        };
        if self.seen.insert(canonical.clone()) {
            let bucket = if auxiliary {
                &mut self.auxiliary
            } else {
                &mut self.model
            };
            *bucket = bucket.saturating_add(len);
        }
        Some((canonical, len, modified))
    }
}

/// Every file of a model: all shards when the name follows llama.cpp's
/// `-00001-of-00003.gguf` convention (`llama_split_path`), otherwise the file
/// itself. Headers live in the first shard.
fn model_files(path: &Path) -> Option<Vec<PathBuf>> {
    let name = path.file_name().and_then(|name| name.to_str());
    let Some((base, _, total)) = name.and_then(crate::models::shard_name) else {
        return Some(vec![path.to_path_buf()]);
    };
    if total > MAX_SHARDS {
        return None;
    }
    let parent = path.parent().unwrap_or(Path::new(""));
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("gguf");
    Some(
        (1..=total)
            .map(|index| parent.join(format!("{base}-{index:05}-of-{total:05}.{extension}")))
            .collect(),
    )
}

struct CachedFacts {
    len: u64,
    modified: Option<SystemTime>,
    facts: Result<Arc<ModelFacts>, String>,
}

/// Header facts by canonical path. An entry is reused only while the file
/// keeps its size and modification time, so a replaced model is read again.
static FACTS: LazyLock<Mutex<HashMap<PathBuf, CachedFacts>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cached_facts(
    canonical: &Path,
    len: u64,
    modified: Option<SystemTime>,
) -> Result<Arc<ModelFacts>, String> {
    if let Ok(cache) = FACTS.lock() {
        if let Some(entry) = cache.get(canonical) {
            if entry.len == len && entry.modified == modified {
                return entry.facts.clone();
            }
        }
    }
    let facts = gguf::read_model_facts(canonical).map(Arc::new);
    if let Ok(mut cache) = FACTS.lock() {
        if cache.len() >= MAX_CACHED_FACTS && !cache.contains_key(canonical) {
            cache.clear();
        }
        cache.insert(
            canonical.to_path_buf(),
            CachedFacts {
                len,
                modified,
                facts: facts.clone(),
            },
        );
    }
    facts
}

fn load_model(path: &str, disk: &mut Disk, auxiliary: bool) -> Loaded {
    let Some(files) = model_files(Path::new(path.trim())) else {
        disk.complete = false;
        return Loaded::Missing;
    };
    let shards = files.len() as u64;
    let mut first = None;
    let mut tensors = Some(TensorBytes::default());
    let mut missing = false;
    for file in files {
        let Some((canonical, len, modified)) = disk.count(&file, auxiliary) else {
            missing = true;
            continue;
        };
        match cached_facts(&canonical, len, modified) {
            Ok(facts) => {
                match (&mut tensors, &facts.tensors) {
                    (Some(total), Some(shard)) => total.absorb(shard),
                    _ => tensors = None,
                }
                first.get_or_insert(facts);
            }
            Err(_) => {
                tensors = None;
                first.get_or_insert_with(|| Arc::new(ModelFacts::default()));
            }
        }
    }
    // A header naming more parts than the file names reach cannot be loaded
    // either; llama.cpp finds the other parts by the same naming convention.
    if first
        .as_ref()
        .and_then(|facts| facts.split_count)
        .is_some_and(|count| count > 1 && count != shards)
    {
        disk.complete = false;
        missing = true;
    }
    match first {
        _ if missing => Loaded::Missing,
        Some(facts) if facts.architecture.is_some() => Loaded::Ready(FoundModel { facts, tensors }),
        _ => Loaded::Unreadable,
    }
}

/// `llm_arch_is_recurrent` and `llm_arch_is_hybrid` in `src/llama-arch.cpp`,
/// plus architectures with their own cache types (`llama_model::create_memory`
/// in `src/llama-model.cpp`), KV sharing between layers, encoder-decoder or
/// non-causal models, and the projector placeholder.
const UNSUPPORTED_ARCHITECTURES: &[&str] = &[
    "mamba",
    "mamba2",
    "rwkv6",
    "rwkv6qwen2",
    "rwkv7",
    "arwkv7",
    "jamba",
    "falcon-h1",
    "plamo2",
    "granitehybrid",
    "lfm2",
    "lfm2moe",
    "nemotron_h",
    "nemotron_h_moe",
    "kimi-linear",
    "bailingmoe3",
    "kimi-k3",
    "deepseek4",
    "minimax-01",
    "minimax-m3",
    "glm-dsa",
    "deepseek32",
    "hy_v4",
    "dots3note",
    "dflash",
    "gemma3n",
    "gemma4",
    "gemma4-assistant",
    "t5",
    "t5encoder",
    "bert",
    "jina-bert-v2",
    "jina-bert-v3",
    "nomic-bert",
    "nomic-bert-moe",
    "neo-bert",
    "eurobert",
    "wavtokenizer-dec",
    "modern-bert",
    "gemma-embedding",
    "dream",
    "llada",
    "llada-moe",
    "rnd1",
    "clip",
];

/// Dimensions used by attention caches and Qwen's gated delta-net state.
#[derive(Debug)]
struct Shape {
    /// `block_count`, including any next-token prediction layers.
    n_layer: usize,
    /// Layers that own a cache in the main context: the trunk, without the
    /// next-token prediction layers a separate context caches.
    kv_layers: usize,
    n_embd: u64,
    n_vocab: Option<u64>,
    n_head: u64,
    head_v: u64,
    /// `n_embd_k_gqa(il)` and `n_embd_v_gqa(il)`.
    k_dims: Vec<u64>,
    v_dims: Vec<u64>,
    /// F32 recurrent state bytes per sequence, indexed by layer; zero on
    /// full-attention layers. Includes optional Qwen4 PLE convolution history.
    recurrent_bytes: Vec<u64>,
    indexer_dim: u64,
    activation_width: u64,
    /// The widest per-token FFN activation, dense or routed.
    n_ff: u64,
    n_ctx_train: Option<u64>,
    tensors: TensorBytes,
}

fn shape(model: &FoundModel) -> Result<Shape, EstimateNote> {
    let facts = &model.facts;
    let architecture = facts.architecture.as_deref().unwrap_or_default();
    let qwen_hybrid = matches!(
        architecture,
        "qwen3next" | "qwen35" | "qwen35moe" | "qwen4exp"
    );
    if UNSUPPORTED_ARCHITECTURES.contains(&architecture)
        || ((facts.recurrent_state || facts.recurrent_layers.is_some()) && !qwen_hybrid)
        || facts.kv_lora_rank.is_some()
        || facts.sliding_window.is_some_and(|window| window > 0)
    {
        return Err(EstimateNote::UnsupportedArchitecture);
    }
    let n_layer = facts
        .block_count
        .and_then(|count| usize::try_from(count).ok())
        .filter(|count| (1..=gguf::MAX_MODEL_LAYERS).contains(count))
        .ok_or(EstimateNote::MissingMetadata)?;
    let n_embd = facts
        .embedding_length
        .filter(|value| *value > 0)
        .ok_or(EstimateNote::MissingMetadata)?;
    let nextn = facts.nextn_layers.unwrap_or(0);
    if nextn >= n_layer as u64 {
        return Err(EstimateNote::MissingMetadata);
    }
    let kv_layers = n_layer - nextn as usize;
    let (recurrent_bytes, indexer_dim, activation_width) =
        hybrid_dimensions(facts, n_layer, kv_layers, n_embd, qwen_hybrid)?;
    let heads = facts
        .head_count
        .as_ref()
        .ok_or(EstimateNote::MissingMetadata)?;
    let tensors = model.tensors.clone().ok_or(EstimateNote::MissingMetadata)?;
    // Header dimensions are untrusted sizes, not allocations to honour. Reject
    // incomplete layer arrays and implausible shapes instead of manufacturing
    // an MHA fallback or overflowing arithmetic later in the estimate.
    const MAX_DIM: u64 = 1 << 24;
    if n_embd > MAX_DIM
        || tensors.total() == 0
        || tensors.layers.len() != n_layer
        || tensors.layers.iter().any(|layer| layer.total() == 0)
        || (0..n_layer).any(|il| {
            heads
                .at(il)
                .is_none_or(|n| (n == 0 && recurrent_bytes[il] == 0) || n > MAX_DIM)
        })
        || facts.head_count_kv.as_ref().is_some_and(|kv| {
            (0..n_layer).any(|il| {
                kv.at(il)
                    .is_none_or(|n| (n == 0 && recurrent_bytes[il] == 0) || n > MAX_DIM)
            })
        })
        || tensors
            .vocab
            .or(facts.vocab_size)
            .is_some_and(|n| n == 0 || n > MAX_DIM)
    {
        return Err(EstimateNote::MissingMetadata);
    }
    // `llama_model::load_hparams`: head sizes default to n_embd / n_head().
    let default_head = heads
        .at(0)
        .filter(|heads| *heads > 0)
        .map(|heads| n_embd / heads);
    let head_k = facts
        .key_length
        .or(default_head)
        .ok_or(EstimateNote::MissingMetadata)?;
    let head_v = facts
        .value_length
        .or(default_head)
        .ok_or(EstimateNote::MissingMetadata)?;
    if head_k == 0 || head_v == 0 || head_k > MAX_DIM || head_v > MAX_DIM {
        return Err(EstimateNote::MissingMetadata);
    }
    let kv_heads = |il: usize| {
        facts
            .head_count_kv
            .as_ref()
            .and_then(|kv| kv.at(il))
            .or_else(|| heads.at(il))
            .unwrap_or(0)
    };
    let k_dims = (0..n_layer)
        .map(|il| head_k.saturating_mul(kv_heads(il)))
        .collect();
    let v_dims = (0..n_layer)
        .map(|il| head_v.saturating_mul(kv_heads(il)))
        .collect();
    let dense = facts.feed_forward_length.as_ref().map_or(0, |ff| ff.max());
    let routed = facts
        .expert_feed_forward_length
        .as_ref()
        .map_or(0, |ff| ff.max())
        .saturating_mul(
            facts
                .expert_used_count
                .as_ref()
                .map_or(0, |used| used.max()),
        )
        .saturating_add(facts.expert_shared_feed_forward_length.unwrap_or(0));
    let n_ff = match dense.max(routed) {
        0 => n_embd.saturating_mul(4),
        width => width,
    };
    Ok(Shape {
        n_layer,
        kv_layers,
        n_embd,
        n_vocab: tensors.vocab.or(facts.vocab_size),
        n_head: heads.max().max(1),
        head_v,
        k_dims,
        v_dims,
        recurrent_bytes,
        indexer_dim,
        activation_width,
        n_ff,
        n_ctx_train: facts.context_length.filter(|value| *value > 0),
        tensors,
    })
}

/// llama-hparams.cpp::n_embd_r/n_embd_s and llama-memory-recurrent.cpp
/// allocate F32 convolution and delta-net state per sequence. Qwen4 also
/// keeps a key-only indexer cache on each full-attention layer.
fn hybrid_dimensions(
    facts: &ModelFacts,
    n_layer: usize,
    trunk: usize,
    n_embd: u64,
    hybrid: bool,
) -> Result<(Vec<u64>, u64, u64), EstimateNote> {
    if !hybrid {
        return Ok((vec![0; n_layer], 0, n_embd));
    }
    let dim = |value: Option<u64>| {
        value
            .filter(|n| (1..=1 << 24).contains(n))
            .ok_or(EstimateNote::MissingMetadata)
    };
    let conv = dim(facts.ssm_conv_kernel)?;
    let inner = dim(facts.ssm_inner_size)?;
    let state = dim(facts.ssm_state_size)?;
    let groups = dim(facts.ssm_group_count)?;
    let interval = dim(Some(facts.full_attention_interval.unwrap_or(4)))?;
    let qwen4 = facts.architecture.as_deref() == Some("qwen4exp");
    let hc = if qwen4 {
        dim(facts.hyper_connections)?
    } else {
        1
    };
    let indexer = if qwen4 {
        dim(facts.indexer_key_length)?
    } else {
        0
    };
    let ple = if facts.ple_layers.is_empty() {
        0
    } else {
        dim(facts.ple_conv_kernel)?
            .saturating_sub(1)
            .saturating_mul(dim(facts.ple_ngram_size)?)
            .saturating_mul(hc)
            .saturating_mul(n_embd)
            .saturating_mul(4)
    };
    let base = conv
        .saturating_sub(1)
        .saturating_mul(inner.saturating_add(2u64.saturating_mul(groups).saturating_mul(state)))
        .saturating_add(state.saturating_mul(inner))
        .saturating_mul(4);
    let mut bytes = Vec::with_capacity(n_layer);
    for il in 0..n_layer {
        let recurrent = match &facts.recurrent_layers {
            Some(layers) => match layers.at(il) {
                Some(0) => false,
                Some(1) => true,
                _ => return Err(EstimateNote::MissingMetadata),
            },
            None => il < trunk && !(il as u64 + 1).is_multiple_of(interval),
        };
        let has_ple = facts.ple_layers.contains(&(il as u64));
        if has_ple && (!recurrent || il >= trunk) {
            return Err(EstimateNote::MissingMetadata);
        }
        bytes.push(if recurrent {
            base.saturating_add(if has_ple { ple } else { 0 })
        } else {
            0
        });
    }
    if facts.ple_layers.iter().any(|il| *il >= trunk as u64) {
        return Err(EstimateNote::MissingMetadata);
    }
    Ok((bytes, indexer, n_embd.saturating_mul(hc)))
}

/// How a runtime counts `n_gpu_layers`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Offload {
    /// The output layer first, then repeating layers (llama.cpp #18148).
    OutputFirst,
    /// Repeating layers first, the output layer once all of them are offloaded.
    #[cfg(test)]
    RepeatingFirst,
}

/// CPU overrides for offloaded layers.
#[derive(Clone, Copy, Default)]
struct Overrides {
    cpu_moe: bool,
    n_cpu_moe: u64,
    n_cpu_ffn: u64,
}

#[derive(Debug, Default)]
struct Placement {
    cpu: u64,
    gpu: u64,
    layer_gpu: Vec<bool>,
    output_gpu: bool,
    /// Weight bytes of the heaviest layer left on the CPU; with op offload a
    /// GPU may copy it in to process a large batch.
    largest_cpu_layer: u64,
}

fn place(
    tensors: &TensorBytes,
    n_layer: usize,
    gpu: bool,
    ngl: u64,
    offload: Offload,
    overrides: Overrides,
    duplicate_tied_output: bool,
) -> Placement {
    let layers = n_layer as u64;
    let (first_gpu_layer, output_gpu) = match (gpu, offload) {
        (false, _) => (layers, false),
        (true, Offload::OutputFirst) => {
            let offloaded = ngl.min(layers + 1);
            (layers + 1 - offloaded, offloaded > 0)
        }
        #[cfg(test)]
        (true, Offload::RepeatingFirst) => (layers.saturating_sub(ngl), ngl > layers),
    };
    let mut placement = Placement {
        cpu: tensors.input.saturating_add(tensors.token_embd),
        output_gpu,
        layer_gpu: (0..layers).map(|il| il >= first_gpu_layer).collect(),
        ..Placement::default()
    };
    let mut output = tensors.output;
    if duplicate_tied_output && !tensors.has_output_weight && output_gpu {
        output = output.saturating_add(tensors.token_embd);
    }
    if output_gpu {
        placement.gpu = output;
    } else {
        placement.cpu = placement.cpu.saturating_add(output);
    }
    for (il, bytes) in tensors.layers.iter().enumerate() {
        let on_gpu = placement.layer_gpu.get(il).copied().unwrap_or(false);
        let (gpu_bytes, cpu_bytes) =
            if on_gpu {
                let il = il as u64;
                let experts_cpu = overrides.cpu_moe || il < overrides.n_cpu_moe;
                let dense_cpu = il < overrides.n_cpu_ffn;
                let cpu = if experts_cpu { bytes.experts } else { 0 }
                    .saturating_add(if dense_cpu { bytes.dense_ffn } else { 0 });
                (bytes.total().saturating_sub(cpu), cpu)
            } else {
                (0, bytes.total())
            };
        placement.gpu = placement.gpu.saturating_add(gpu_bytes);
        placement.cpu = placement.cpu.saturating_add(cpu_bytes);
        placement.largest_cpu_layer = placement.largest_cpu_layer.max(cpu_bytes);
    }
    placement
}

/// One combination of the choices a launch leaves open.
#[derive(Clone, Copy, Debug)]
struct Scenario {
    gpu: bool,
    offload: Offload,
    flash_attn: bool,
    n_seq: u64,
    unified: bool,
    n_ctx: u64,
}

/// Cells per stream and number of streams (`llama_context` and
/// `llama_kv_cache` constructors).
fn kv_cells(n_ctx: u64, n_seq: u64, unified: bool) -> (u64, u64) {
    let n_ctx = pad256(n_ctx);
    if unified || n_seq <= 1 {
        (n_ctx, 1)
    } else {
        (pad256(n_ctx / n_seq).max(256), n_seq)
    }
}

/// KV bytes of layers `from..to` as (CPU, GPU).
#[allow(clippy::too_many_arguments)]
fn kv_bytes(
    shape: &Shape,
    layers: std::ops::Range<usize>,
    cells: u64,
    type_k: KvType,
    type_v: KvType,
    flash_attn: bool,
    placement: &Placement,
    offload: bool,
) -> (u64, u64) {
    let widest_v = shape.v_dims.iter().copied().max().unwrap_or(0);
    let (mut cpu, mut gpu) = (0u64, 0u64);
    for il in layers {
        if shape.recurrent_bytes[il] > 0 {
            continue;
        }
        let v_dim = if flash_attn {
            shape.v_dims[il]
        } else {
            widest_v
        };
        let bytes = type_k
            .row_bytes(shape.k_dims[il])
            .saturating_add(type_v.row_bytes(v_dim))
            .saturating_add(type_k.row_bytes(shape.indexer_dim))
            .saturating_mul(cells);
        if offload && placement.layer_gpu.get(il).copied().unwrap_or(false) {
            gpu = gpu.saturating_add(bytes);
        } else {
            cpu = cpu.saturating_add(bytes);
        }
    }
    (cpu, gpu)
}

/// Heuristic peak of one device's compute buffer for a physical batch:
/// residual activations, the widest of the FFN and attention intermediates,
/// and the logits when the device holds the output layer. Attention without
/// flash attention materialises the `n_kv x n_ubatch x n_head` score matrix
/// once or, around the softmax, twice; flash attention only needs quantized
/// caches converted to f16 on some backends.
#[allow(clippy::too_many_arguments)]
fn compute_buffer(
    shape: &Shape,
    ubatch: u64,
    n_seq: u64,
    kv_per_stream: u64,
    flash_attn: bool,
    quantized: bool,
    layers: bool,
    output: bool,
) -> ResourceRange {
    let f32s = |count: u64| count.saturating_mul(4);
    let act = f32s(
        ubatch
            .saturating_mul(shape.activation_width)
            .saturating_mul(4),
    );
    let ffn = f32s(ubatch.saturating_mul(shape.n_ff).saturating_mul(3));
    let attention = if flash_attn {
        let min = f32s(
            ubatch
                .saturating_mul(shape.n_head)
                .saturating_mul(shape.head_v)
                .saturating_mul(2),
        );
        let conversion = if quantized {
            let widest = |dims: &[u64]| dims.iter().copied().max().unwrap_or(0);
            kv_per_stream
                .saturating_mul(widest(&shape.k_dims).saturating_add(widest(&shape.v_dims)))
                .saturating_mul(2)
        } else {
            0
        };
        ResourceRange::new(min, min.saturating_add(conversion))
    } else {
        let scores = f32s(
            kv_per_stream
                .saturating_mul(ubatch)
                .saturating_mul(shape.n_head),
        );
        ResourceRange::new(scores, scores.saturating_mul(2))
    };
    // Chunked delta-net prefill retains intermediate recurrent states in
    // addition to its persistent state. Bound backend/chunking differences.
    let recurrent = shape
        .recurrent_bytes
        .iter()
        .copied()
        .max()
        .unwrap_or(0)
        .saturating_mul(ubatch.div_ceil(64).saturating_add(n_seq))
        .saturating_mul(2);
    let layer = ResourceRange::new(
        act.saturating_add(ffn.max(attention.min_bytes)),
        act.saturating_add(ffn.max(attention.max_bytes).max(recurrent)),
    );
    // Current servers reserve logits for one output per slot, earlier ones
    // for every token of the physical batch.
    let logits = ResourceRange::new(
        f32s(
            shape
                .n_vocab
                .unwrap_or(VOCAB_BOUNDS.0)
                .saturating_mul(n_seq.min(ubatch)),
        ),
        f32s(
            shape
                .n_vocab
                .unwrap_or(VOCAB_BOUNDS.1)
                .saturating_mul(ubatch),
        ),
    );
    let out = ResourceRange::exact(act).add(logits);
    let mut peak = ResourceRange::default();
    if layers {
        peak = layer;
    }
    if output {
        peak = ResourceRange::new(
            peak.min_bytes.max(out.min_bytes),
            peak.max_bytes.max(out.max_bytes),
        );
    }
    peak
}

/// One model with its context: the main model or a draft model.
struct ContextPlan<'a> {
    shape: &'a Shape,
    ngl: u64,
    on_gpu: bool,
    overrides: Overrides,
    type_k: Option<KvType>,
    type_v: Option<KvType>,
    /// Extra rollback rows reserved by speculative decoding.
    recurrent_copies: Option<u64>,
}

/// Memory of one model and its context in one scenario, as (RAM, VRAM, KV).
fn context_memory(
    plan: &ContextPlan,
    scenario: &Scenario,
    launch: &Launch,
    gpu_devices: u64,
) -> (ResourceRange, ResourceRange, u64, Placement, u64) {
    let gpu = scenario.gpu && plan.on_gpu;
    let placement = place(
        &plan.shape.tensors,
        plan.shape.n_layer,
        gpu,
        plan.ngl,
        scenario.offload,
        plan.overrides,
        true,
    );
    // A verified runtime default arrives resolved from the editor. Otherwise
    // use llama.cpp's f16 baseline and identify the assumption in the notes.
    let pick = |known: Option<KvType>| known.unwrap_or(KvType::F16);
    let (type_k, type_v) = (pick(plan.type_k), pick(plan.type_v));
    let (per_stream, streams) = kv_cells(scenario.n_ctx, scenario.n_seq, scenario.unified);
    let (kv_cpu, kv_gpu) = kv_bytes(
        plan.shape,
        0..plan.shape.kv_layers,
        per_stream.saturating_mul(streams),
        type_k,
        type_v,
        scenario.flash_attn,
        &placement,
        launch.args.kv_offload,
    );
    let (mut state_cpu, mut state_gpu) = (0u64, 0u64);
    for (il, bytes) in plan
        .shape
        .recurrent_bytes
        .iter()
        .take(plan.shape.kv_layers)
        .enumerate()
    {
        let copies = plan.recurrent_copies.unwrap_or(4);
        let bytes = bytes.saturating_mul(scenario.n_seq).saturating_mul(copies);
        if launch.args.kv_offload && placement.layer_gpu[il] {
            state_gpu = state_gpu.saturating_add(bytes);
        } else {
            state_cpu = state_cpu.saturating_add(bytes);
        }
    }
    let quantized = type_k.quantized() || type_v.quantized();
    let any_gpu_layer = placement.layer_gpu.iter().any(|on| *on);
    let any_cpu_layer =
        placement.layer_gpu.iter().any(|on| !*on) || placement.largest_cpu_layer > 0;
    let buffer = |layers, output| {
        compute_buffer(
            plan.shape,
            launch.ubatch,
            scenario.n_seq,
            per_stream,
            scenario.flash_attn,
            quantized,
            layers,
            output,
        )
    };
    // The CPU always embeds the batch and stages its outputs.
    let staging = launch
        .ubatch
        .saturating_mul(plan.shape.n_embd)
        .saturating_mul(4);
    let cpu_compute =
        buffer(any_cpu_layer, !placement.output_gpu).add(ResourceRange::exact(staging));
    let mut ram = ResourceRange::exact(
        placement
            .cpu
            .saturating_add(kv_cpu)
            .saturating_add(state_cpu),
    )
    .add(cpu_compute);
    let mut vram = ResourceRange::default();
    if gpu {
        let device = buffer(any_gpu_layer, placement.output_gpu);
        // Every device holding layers has its own buffer.
        let mut gpu_compute = ResourceRange::new(
            device.min_bytes,
            device.max_bytes.saturating_mul(gpu_devices),
        );
        if launch.args.op_offload && placement.largest_cpu_layer > 0 {
            gpu_compute.max_bytes = gpu_compute
                .max_bytes
                .saturating_add(placement.largest_cpu_layer);
        }
        vram = ResourceRange::exact(
            placement
                .gpu
                .saturating_add(kv_gpu)
                .saturating_add(state_gpu),
        )
        .add(gpu_compute);
    }
    // Host copy of the outputs (`llama_context::output_reserve`).
    let host_outputs = ResourceRange::new(
        plan.shape
            .n_vocab
            .unwrap_or(VOCAB_BOUNDS.0)
            .saturating_mul(scenario.n_seq)
            .saturating_mul(4),
        plan.shape
            .n_vocab
            .unwrap_or(VOCAB_BOUNDS.1)
            .saturating_mul(launch.ubatch)
            .saturating_mul(4),
    );
    ram = ram.add(host_outputs);
    (
        ram,
        vram,
        kv_cpu.saturating_add(kv_gpu),
        placement,
        kv_cpu.saturating_add(state_cpu),
    )
}

/// One current-runtime placement. Unknown defaults use documented baselines,
/// never a fictional CPU-only branch or all-experts-on-CPU lower bound.
fn scenario(launch: &Launch, main: &Shape, accelerator: Accelerator) -> Option<Scenario> {
    let n_seq = launch.parallel.unwrap_or(AUTO_SLOTS);
    Some(Scenario {
        gpu: !matches!(accelerator, Accelerator::Cpu),
        offload: Offload::OutputFirst,
        flash_attn: launch.flash_attn.unwrap_or(true),
        n_seq,
        unified: launch.args.kv_unified.unwrap_or(launch.parallel.is_none()),
        n_ctx: if launch.ctx > 0 {
            launch.ctx
        } else {
            main.n_ctx_train?.saturating_mul(n_seq)
        },
    })
}

/// Parses `--spec-draft-ngl`: `auto` and `all` offload every layer
/// (`llama_model::n_gpu_layers` treats a negative count as all of them).
fn draft_layers(cfg: &AppConfig) -> u64 {
    if cfg.active_backend == "cpu" {
        return 0;
    }
    if tuning_defaults::inherited(cfg, "spec_draft_ngl") {
        return u64::MAX;
    }
    cfg.spec_draft_ngl.trim().parse::<u64>().unwrap_or(u64::MAX)
}

pub fn estimate(cfg: &AppConfig, env: &Environment) -> ResourceEstimate {
    let memory = estimate_memory(cfg, env);
    let mut notes: BTreeSet<_> = memory.notes.iter().copied().collect();
    let required_vram_bytes = memory.vram.map(ResourceRange::planned);
    let host_memory_bytes = memory
        .ram
        .zip(memory.cpu_offload_bytes)
        .map(|(ram, offload)| ram.planned().saturating_sub(offload));
    let mut vram_bytes = required_vram_bytes;
    let mut ram_offload_bytes = memory.cpu_offload_bytes;
    let mut ssd_offload_bytes = None;
    if let (Some(required), Some(cpu), Some(host)) = (
        required_vram_bytes,
        memory.cpu_offload_bytes,
        host_memory_bytes,
    ) {
        let gpu_budget = if matches!(env.accelerator, Accelerator::Cpu) {
            Some(0)
        } else if env.shared_memory {
            // Unified memory has one physical pool. Reserve fixed host memory
            // before putting the remaining working set on that shared device.
            env.ram_capacity_bytes.map(|ram| {
                ram.saturating_sub(host)
                    .saturating_add(env.vram_capacity_bytes.unwrap_or(0))
            })
        } else {
            env.vram_capacity_bytes
        };
        let on_gpu = gpu_budget.map_or(required, |budget| required.min(budget));
        let overflow = required.saturating_sub(on_gpu);
        let offload = cpu.saturating_add(overflow);
        vram_bytes = Some(on_gpu);
        if overflow > 0 {
            notes.insert(EstimateNote::PlacementAdjustment);
        }
        if gpu_budget.is_none() && required > 0 {
            notes.insert(EstimateNote::CapacityUnknown);
        }
        let shared_gpu = if env.shared_memory {
            on_gpu.saturating_sub(env.vram_capacity_bytes.unwrap_or(0))
        } else {
            0
        };
        let ram_budget = env
            .ram_capacity_bytes
            .map(|ram| ram.saturating_sub(host).saturating_sub(shared_gpu));
        if offload == 0 {
            ram_offload_bytes = Some(0);
            ssd_offload_bytes = Some(memory.lazy_offload_bytes);
        } else if let Some(budget) = ram_budget {
            let in_ram = offload.min(budget);
            let on_disk = offload.saturating_sub(in_ram);
            ram_offload_bytes = Some(in_ram);
            ssd_offload_bytes = Some(on_disk.saturating_add(memory.lazy_offload_bytes));
            if on_disk > 0 {
                notes.insert(EstimateNote::DiskOffload);
            }
        } else {
            // A RAM/SSD split cannot be inferred without a RAM budget.
            ram_offload_bytes = None;
            notes.insert(EstimateNote::CapacityUnknown);
        }
    }
    ResourceEstimate {
        vram_bytes,
        ram_offload_bytes,
        ssd_offload_bytes,
        required_vram_bytes,
        host_memory_bytes,
        vram_capacity_bytes: if env.shared_memory {
            env.ram_capacity_bytes
                .map(|ram| ram.saturating_add(env.vram_capacity_bytes.unwrap_or(0)))
        } else {
            env.vram_capacity_bytes
        },
        ram_capacity_bytes: env.ram_capacity_bytes,
        disk_bytes: memory.disk_bytes,
        disk_complete: memory.disk_complete,
        model_bytes: memory.model_bytes,
        auxiliary_bytes: memory.auxiliary_bytes,
        kv_bytes: memory.kv_bytes,
        notes: notes.into_iter().collect(),
    }
}

fn estimate_memory(cfg: &AppConfig, env: &Environment) -> MemoryEstimate {
    let mut notes = BTreeSet::new();
    let mut disk = Disk {
        complete: true,
        ..Disk::default()
    };
    let launch = launch_settings(cfg);
    let mut blocked = false;

    let main = if cfg.active_model.trim().is_empty() {
        disk.complete = false;
        None
    } else {
        match load_model(&cfg.active_model, &mut disk, false) {
            Loaded::Ready(model) => Some(model),
            Loaded::Missing => None,
            Loaded::Unreadable => {
                notes.insert(EstimateNote::MissingMetadata);
                None
            }
        }
    };

    // Projector: its weights go where `--mmproj-offload` sends them.
    let mut projector = None;
    if !cfg.mmproj.trim().is_empty() {
        notes.insert(EstimateNote::Auxiliary);
        if let Some(files) = model_files(Path::new(cfg.mmproj.trim())) {
            let shards = files.len() as u64;
            let mut bytes = 0u64;
            for path in files {
                if let Some((canonical, len, modified)) = disk.count(&path, true) {
                    bytes = bytes.saturating_add(len);
                    if let Ok(facts) = cached_facts(&canonical, len, modified) {
                        if facts.split_count.is_some_and(|count| count != shards) {
                            disk.complete = false;
                        }
                    }
                }
            }
            projector = Some(bytes);
        } else {
            disk.complete = false;
        }
    }

    // Enabled adapters follow the layers they adapt.
    let mut adapters = Vec::new();
    if cfg
        .lora_adapters
        .iter()
        .filter(|adapter| adapter.enabled)
        .count()
        > MAX_ADAPTERS
    {
        disk.complete = false;
    }
    for adapter in cfg
        .lora_adapters
        .iter()
        .filter(|adapter| adapter.enabled)
        .take(MAX_ADAPTERS)
    {
        notes.insert(EstimateNote::Auxiliary);
        match load_model(&adapter.path, &mut disk, true) {
            Loaded::Ready(FoundModel {
                tensors: Some(tensors),
                ..
            }) => adapters.push(tensors),
            Loaded::Missing => {}
            _ => {
                notes.insert(EstimateNote::MissingMetadata);
                blocked = true;
            }
        }
    }

    // A draft model gets its own context of the same size.
    let speculative = tuning_defaults::speculative_enabled(cfg);
    let mut draft = None;
    if speculative && !cfg.spec_draft_model.trim().is_empty() {
        notes.insert(EstimateNote::Auxiliary);
        match load_model(&cfg.spec_draft_model, &mut disk, true) {
            Loaded::Ready(model) => match shape(&model) {
                Ok(shape) => draft = Some(shape),
                Err(note) => {
                    notes.insert(note);
                    blocked = true;
                }
            },
            Loaded::Missing => {}
            Loaded::Unreadable => {
                notes.insert(EstimateNote::MissingMetadata);
                blocked = true;
            }
        }
    }
    // Multi-token prediction drafts from the model's own next-token layers.
    let mtp =
        speculative && cfg.spec_type.contains("mtp") && cfg.spec_draft_model.trim().is_empty();

    if !disk.complete {
        notes.insert(EstimateNote::MissingFiles);
        blocked = true;
    }
    if launch.args.unmodeled
        || launch.args.unknown
        || (!tuning_defaults::inherited(cfg, "cache_type_k") && launch.type_k.is_none())
        || (!tuning_defaults::inherited(cfg, "cache_type_v") && launch.type_v.is_none())
        || matches!(cfg.gpu.split_mode, SplitMode::Row | SplitMode::Tensor)
    {
        notes.insert(EstimateNote::AdvancedOptions);
        blocked = true;
    }
    // build_args always supplies n_gpu_layers (including the app default).
    // Upstream fit.cpp does not redistribute experts once it is explicit.

    let main_shape = main.as_ref().map(shape);
    if let Some(Err(note)) = &main_shape {
        notes.insert(*note);
    }
    let draft_types = (launch.args.draft_type_k, launch.args.draft_type_v);
    let draft_open =
        (draft.is_some() || mtp) && (draft_types.0.is_none() || draft_types.1.is_none());
    let rollback = speculative
        && ["mtp", "eagle", "dflash", "dspark"]
            .iter()
            .any(|kind| cfg.spec_type.contains(kind));
    let recurrent_copies = if !rollback {
        Some(1)
    } else if tuning_defaults::inherited(cfg, "spec_draft_n_max") {
        None
    } else {
        Some(1 + u64::from(cfg.spec_draft_n_max))
    };
    let mut ram: Option<ResourceRange> = None;
    let mut vram: Option<ResourceRange> = None;
    let mut cpu_offload_bytes = None;
    let mut lazy_offload_bytes = 0u64;
    let mut kv_total = None;
    let open = match &main_shape {
        Some(Ok(shape)) => {
            scenario(&launch, shape, env.accelerator).map(|scenario| (shape, scenario))
        }
        _ => None,
    };
    if matches!(main_shape, Some(Ok(_))) && open.is_none() {
        notes.insert(EstimateNote::MissingMetadata);
    }
    if let Some((shape, scenario)) = open {
        let gpu_devices = match env.accelerator {
            Accelerator::Gpu { devices } | Accelerator::Unknown { devices } => {
                devices.max(1) as u64
            }
            Accelerator::Cpu => 1,
        };
        let main_plan = ContextPlan {
            shape,
            ngl: launch.ngl,
            on_gpu: true,
            overrides: Overrides {
                cpu_moe: launch.args.cpu_moe,
                n_cpu_moe: launch.n_cpu_moe,
                n_cpu_ffn: launch.args.n_cpu_ffn,
            },
            type_k: launch.type_k,
            type_v: launch.type_v,
            recurrent_copies,
        };
        let draft_plan = draft.as_ref().map(|draft| ContextPlan {
            shape: draft,
            ngl: draft_layers(cfg),
            on_gpu: cfg.active_backend != "cpu" && cfg.spec_draft_device.trim() != "none",
            overrides: Overrides {
                cpu_moe: launch.args.draft_cpu_moe,
                n_cpu_moe: launch.args.draft_n_cpu_moe,
                n_cpu_ffn: 0,
            },
            type_k: draft_types.0,
            type_v: draft_types.1,
            recurrent_copies: Some(1),
        });
        {
            let scenario = &scenario;
            let (mut ram_here, mut vram_here, mut kv, placement, cpu_cache) =
                context_memory(&main_plan, scenario, &launch, gpu_devices);
            let host_embedding = if scenario.gpu {
                shape.tensors.token_embd
            } else {
                0
            };
            let mut offload_here = placement
                .cpu
                .saturating_sub(host_embedding)
                .saturating_add(cpu_cache);
            let lazy = launch.args.lazy_mode.disk_bytes(&shape.tensors);
            lazy_offload_bytes = lazy_offload_bytes.saturating_add(lazy);
            offload_here = offload_here.saturating_sub(lazy);
            ram_here = ResourceRange::new(
                ram_here.min_bytes.saturating_sub(lazy),
                ram_here.max_bytes.saturating_sub(lazy),
            );
            ram_here = ram_here.add(RAM_BASE);
            if scenario.gpu {
                ram_here = ram_here.add(GPU_HOST_RUNTIME);
                vram_here = vram_here.add(ResourceRange::new(
                    GPU_DEVICE_RUNTIME.min_bytes,
                    GPU_DEVICE_RUNTIME.max_bytes.saturating_mul(gpu_devices),
                ));
            }
            if let Some(bytes) = projector {
                let projector = ResourceRange::exact(bytes).add(PROJECTOR_COMPUTE);
                if scenario.gpu && launch.args.mmproj_offload {
                    vram_here = vram_here.add(projector);
                } else {
                    ram_here = ram_here.add(projector);
                    offload_here = offload_here.saturating_add(bytes);
                }
            }
            for adapter in &adapters {
                let adapted = place(
                    adapter,
                    shape.n_layer,
                    scenario.gpu,
                    launch.ngl,
                    scenario.offload,
                    main_plan.overrides,
                    false,
                );
                ram_here = ram_here.add(ResourceRange::exact(adapted.cpu));
                vram_here = vram_here.add(ResourceRange::exact(adapted.gpu));
                offload_here = offload_here.saturating_add(adapted.cpu);
            }
            if let Some(plan) = &draft_plan {
                let (draft_ram, draft_vram, draft_kv, placement, cpu_cache) =
                    context_memory(plan, scenario, &launch, gpu_devices);
                ram_here = ram_here.add(draft_ram);
                vram_here = vram_here.add(draft_vram);
                kv = kv.saturating_add(draft_kv);
                let host_embedding = if scenario.gpu && plan.on_gpu {
                    plan.shape.tensors.token_embd
                } else {
                    0
                };
                offload_here = offload_here
                    .saturating_add(placement.cpu.saturating_sub(host_embedding))
                    .saturating_add(cpu_cache);
                let lazy = launch.args.lazy_mode.disk_bytes(&plan.shape.tensors);
                lazy_offload_bytes = lazy_offload_bytes.saturating_add(lazy);
                offload_here = offload_here.saturating_sub(lazy);
                ram_here = ResourceRange::new(
                    ram_here.min_bytes.saturating_sub(lazy),
                    ram_here.max_bytes.saturating_sub(lazy),
                );
            }
            if mtp && shape.kv_layers < shape.n_layer {
                notes.insert(EstimateNote::Auxiliary);
                let pick = |known: Option<KvType>| known.unwrap_or(KvType::F16);
                let (per_stream, streams) =
                    kv_cells(scenario.n_ctx, scenario.n_seq, scenario.unified);
                let (cpu, gpu) = kv_bytes(
                    shape,
                    shape.kv_layers..shape.n_layer,
                    per_stream.saturating_mul(streams),
                    pick(draft_types.0),
                    pick(draft_types.1),
                    scenario.flash_attn,
                    &placement,
                    launch.args.kv_offload,
                );
                ram_here = ram_here.add(ResourceRange::exact(cpu));
                vram_here = vram_here.add(ResourceRange::exact(gpu));
                kv = kv.saturating_add(cpu).saturating_add(gpu);
                offload_here = offload_here.saturating_add(cpu);
            }
            kv_total = Some(kv);
            ram = Some(ram_here);
            vram = Some(vram_here);
            cpu_offload_bytes = Some(offload_here);
        }
        if !blocked {
            notes.insert(EstimateNote::Approximate);
            if lazy_offload_bytes > 0 {
                notes.insert(EstimateNote::LazyOffload);
            }
            if env.shared_memory && scenario.gpu {
                notes.insert(EstimateNote::SharedMemory);
            }
        }
        if launch.automatic
            || draft_open
            || recurrent_copies.is_none()
            || launch.flash_attn.is_none()
            || launch.parallel.is_none()
            || launch.ctx == 0
            || matches!(env.accelerator, Accelerator::Unknown { .. })
            || (draft_plan.is_some() && draft_layers(cfg) == u64::MAX)
        {
            notes.insert(EstimateNote::Automatic);
        }
    }
    if blocked || main_shape.as_ref().is_none_or(|shape| shape.is_err()) {
        ram = None;
        vram = None;
        cpu_offload_bytes = None;
    }
    if blocked {
        kv_total = None;
    }
    MemoryEstimate {
        ram,
        vram,
        disk_bytes: disk.model.saturating_add(disk.auxiliary),
        disk_complete: disk.complete,
        model_bytes: disk.model,
        auxiliary_bytes: disk.auxiliary,
        kv_bytes: kv_total,
        ram_capacity_bytes: env.ram_capacity_bytes,
        notes: notes.into_iter().collect(),
        cpu_offload_bytes,
        lazy_offload_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // These tests exercise GGUF/cache accounting independently of capacity
    // planning; placement tests below call super::estimate for the public view.
    use super::estimate_memory as estimate;
    use crate::config::LoraAdapterConfig;
    use crate::gguf::fixture::{self, Value};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("aiolm-estimate-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    type Values = Vec<(String, Value)>;
    type Tensors = Vec<(String, Vec<u64>, u64)>;

    const EMBEDDING: u64 = 65_536;
    const OUTPUT: u64 = 32_768 + 1_024;
    /// `attn_q` plus a dense `ffn_up`.
    const LAYER: u64 = 16_384 + 32_768;
    /// f16 K and V of two 64-wide KV heads, in four layers.
    const KV_PER_CELL: u64 = 4 * (128 * 2 + 128 * 2);
    const GPU: Accelerator = Accelerator::Gpu { devices: 1 };

    /// Four plain attention layers with 8 query heads and 2 KV heads of 64
    /// dimensions, trained for 8192 tokens.
    fn plain(architecture: &'static str) -> (Values, Tensors) {
        let key = |suffix: &str| format!("{architecture}.{suffix}");
        let values = vec![
            ("general.architecture".into(), Value::Str(architecture)),
            (key("block_count"), Value::U32(4)),
            (key("context_length"), Value::U32(8_192)),
            (key("embedding_length"), Value::U32(256)),
            (key("feed_forward_length"), Value::U32(1_024)),
            (key("attention.head_count"), Value::U32(8)),
            (key("attention.head_count_kv"), Value::U32(2)),
            (key("attention.key_length"), Value::U32(64)),
            (key("attention.value_length"), Value::U32(64)),
        ];
        let mut tensors = vec![
            ("token_embd.weight".into(), vec![256, 1_000], EMBEDDING),
            ("output_norm.weight".into(), vec![256], 1_024),
            ("output.weight".into(), vec![256, 1_000], 32_768),
        ];
        for il in 0..4 {
            tensors.push((format!("blk.{il}.attn_q.weight"), vec![256, 256], 16_384));
            tensors.push((format!("blk.{il}.ffn_up.weight"), vec![256, 1_024], 32_768));
        }
        (values, tensors)
    }

    fn replace(values: &mut Values, key: &str, value: Value) {
        values.retain(|(existing, _)| existing != key);
        values.push((key.into(), value));
    }

    fn config(model: &Path) -> AppConfig {
        AppConfig {
            active_model: model.to_string_lossy().into_owned(),
            active_backend: "cuda".into(),
            active_build: "b1".into(),
            ngl: 99,
            ctx_size: 4_096,
            cache_type_k: "f16".into(),
            cache_type_v: "f16".into(),
            flash_attn: "on".into(),
            parallel: 1,
            ..AppConfig::default()
        }
    }

    fn environment(accelerator: Accelerator) -> Environment {
        Environment {
            ram_capacity_bytes: Some(64 << 30),
            vram_capacity_bytes: Some(if accelerator == Accelerator::Cpu {
                0
            } else {
                24 << 30
            }),
            accelerator,
            shared_memory: false,
        }
    }

    fn adapter(path: &Path) -> LoraAdapterConfig {
        LoraAdapterConfig {
            path: path.to_string_lossy().into_owned(),
            scale: 1.0,
            enabled: true,
        }
    }

    fn size(path: &Path) -> u64 {
        std::fs::metadata(path).unwrap().len()
    }

    #[test]
    fn offloaded_layers_and_the_output_layer_move_from_ram_to_vram() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("model.gguf", &fixture::file(&values, &tensors));
        let bytes = gguf::read_model_facts(&path).unwrap().tensors.unwrap();
        let at = |ngl, offload| place(&bytes, 4, true, ngl, offload, Overrides::default(), true);
        let full = at(99, Offload::OutputFirst);
        assert_eq!((full.cpu, full.gpu), (EMBEDDING, 4 * LAYER + OUTPUT));
        assert_eq!(at(0, Offload::OutputFirst).gpu, 0);
        // Current runtimes offload the output layer first; earlier ones
        // started with the last repeating layer.
        assert_eq!(at(1, Offload::OutputFirst).gpu, OUTPUT);
        assert_eq!(at(1, Offload::RepeatingFirst).gpu, LAYER);
        assert_eq!(
            at(2, Offload::OutputFirst).layer_gpu,
            [false, false, false, true]
        );
        assert_eq!(at(4, Offload::RepeatingFirst).gpu, 4 * LAYER);
        // A tied output layer loads the embedding a second time on the GPU.
        let mut tied = bytes.clone();
        tied.has_output_weight = false;
        let tied = place(
            &tied,
            4,
            true,
            99,
            Offload::OutputFirst,
            Overrides::default(),
            true,
        );
        assert_eq!(tied.gpu, 4 * LAYER + OUTPUT + EMBEDDING);

        let gpu = environment(GPU);
        let offloaded = estimate(&config(&path), &gpu);
        let on_cpu = estimate(
            &AppConfig {
                ngl: 0,
                ..config(&path)
            },
            &gpu,
        );
        let kv = 4_096 * KV_PER_CELL;
        assert_eq!(offloaded.kv_bytes, Some(kv));
        let moved = 4 * LAYER + OUTPUT + kv;
        let (vram, cpu_vram) = (offloaded.vram.unwrap(), on_cpu.vram.unwrap());
        let (ram, cpu_ram) = (offloaded.ram.unwrap(), on_cpu.ram.unwrap());
        assert!(vram.min_bytes >= cpu_vram.min_bytes + moved);
        assert!(cpu_ram.min_bytes >= ram.min_bytes + moved);
        assert!(vram.min_bytes <= vram.max_bytes && ram.min_bytes <= ram.max_bytes);
        assert_eq!(offloaded.ram_capacity_bytes, Some(64 << 30));
        assert!(offloaded.notes.contains(&EstimateNote::Approximate));

        // A CPU runtime never reports VRAM, whatever the layer count says.
        let cpu_runtime = estimate(&config(&path), &environment(Accelerator::Cpu));
        assert_eq!(cpu_runtime.vram, Some(ResourceRange::exact(0)));
        assert!(cpu_runtime.ram.unwrap().min_bytes >= EMBEDDING + 4 * LAYER + OUTPUT + kv);

        // Partial offload also covers runtimes that offload a repeating layer,
        // with its cache, where current ones offload only the output layer.
        let partial = estimate(
            &AppConfig {
                ngl: 1,
                ..config(&path)
            },
            &gpu,
        )
        .vram
        .unwrap();
        assert!(partial.max_bytes >= cpu_vram.min_bytes + LAYER + kv / 4);

        // Without a selected runtime either placement is possible.
        let unknown = estimate(
            &config(&path),
            &Environment {
                shared_memory: true,
                ..environment(Accelerator::Unknown { devices: 1 })
            },
        );
        assert_eq!(unknown.vram, offloaded.vram);
        assert!(unknown.notes.contains(&EstimateNote::Automatic));
        assert!(unknown.notes.contains(&EstimateNote::SharedMemory));
    }

    #[test]
    fn kv_cache_follows_context_cache_types_and_real_head_dimensions() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("model.gguf", &fixture::file(&values, &tensors));
        let env = environment(GPU);
        let kv = |cfg: &AppConfig| estimate(cfg, &env).kv_bytes;
        let base = config(&path);
        assert_eq!(kv(&base), Some(4_096 * KV_PER_CELL));
        let doubled = AppConfig {
            ctx_size: 8_192,
            ..base.clone()
        };
        assert_eq!(kv(&doubled), Some(8_192 * KV_PER_CELL));
        assert!(
            estimate(&doubled, &env).vram.unwrap().min_bytes
                >= estimate(&base, &env).vram.unwrap().min_bytes + 4_096 * KV_PER_CELL
        );
        // q8_0 stores 32 elements in 34 bytes.
        let quantized = AppConfig {
            cache_type_k: "q8_0".into(),
            cache_type_v: "q8_0".into(),
            ..base.clone()
        };
        assert_eq!(kv(&quantized), Some(4_096 * 4 * 2 * (128 / 32 * 34)));
        // The context is the server's total. Three separate slots split it
        // into padded streams instead of tripling it.
        let slots = AppConfig {
            parallel: 3,
            ..base.clone()
        };
        assert_eq!(kv(&slots), Some(3 * 1_536 * KV_PER_CELL));

        let (mut values, tensors) = plain("llama");
        replace(
            &mut values,
            "llama.attention.head_count_kv",
            Value::U32s(vec![2, 2, 4, 4]),
        );
        let varied = config(&scratch.write("varied.gguf", &fixture::file(&values, &tensors)));
        // Flash attention stores every layer at its own width...
        assert_eq!(kv(&varied), Some(4_096 * (2 * 512 + 2 * 1_024)));
        // ...without it V is transposed at the widest layer's width.
        let off = AppConfig {
            flash_attn: "off".into(),
            ..varied.clone()
        };
        assert_eq!(
            kv(&off),
            Some(4_096 * ((128 + 128 + 256 + 256) * 2 + 4 * 256 * 2))
        );
        // Automatic flash attention uses the enabled planning baseline.
        let auto = estimate(
            &AppConfig {
                flash_attn: "auto".into(),
                ..varied
            },
            &env,
        );
        assert_eq!(auto.kv_bytes, Some(4_096 * (2 * 512 + 2 * 1_024)));
        assert!(auto.ram.is_some() && auto.vram.is_some());
    }

    #[test]
    fn unresolved_runtime_defaults_use_a_disclosed_baseline_not_all_placements() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("model.gguf", &fixture::file(&values, &tensors));
        let env = environment(GPU);
        let base = config(&path);
        let known = estimate(&base, &env);
        let inherited = estimate(
            &AppConfig {
                runtime_defaults: vec!["cache_type_k".into(), "cache_type_v".into()],
                ..base.clone()
            },
            &env,
        );
        assert_eq!(inherited.kv_bytes, known.kv_bytes);
        assert!(inherited.notes.contains(&EstimateNote::Automatic));
        let (known_vram, open_vram) = (known.vram.unwrap(), inherited.vram.unwrap());
        assert_eq!(open_vram, known_vram);
        // A type the runtime would reject is not read as f16 either.
        let unrecognised = AppConfig {
            cache_type_k: "q3_k".into(),
            ..base.clone()
        };
        assert_eq!(estimate(&unrecognised, &env).kv_bytes, None);

        // App-owned defaults launch 99 layers and 4096 cells whatever the
        // placeholders hold, exactly as `server::build_args` does.
        let app_owned = estimate(
            &AppConfig {
                runtime_defaults: vec!["ngl".into(), "ctx_size".into()],
                ngl: 0,
                ctx_size: 1_000_000,
                ..base.clone()
            },
            &env,
        );
        assert_eq!(
            (app_owned.kv_bytes, app_owned.vram),
            (known.kv_bytes, known.vram)
        );

        // Context 0 uses the trained context for each current-server slot.
        let trained = AppConfig {
            ctx_size: 0,
            ..base.clone()
        };
        assert_eq!(estimate(&trained, &env).kv_bytes, Some(8_192 * KV_PER_CELL));
        let automatic = estimate(
            &AppConfig {
                parallel: 0,
                ..trained.clone()
            },
            &env,
        );
        assert_eq!(automatic.kv_bytes, Some(4 * 8_192 * KV_PER_CELL));
        assert!(automatic.notes.contains(&EstimateNote::Automatic));
        assert!(automatic.vram.unwrap().max_bytes >= 4 * 8_192 * KV_PER_CELL);

        let (mut values, tensors) = plain("llama");
        values.retain(|(key, _)| key != "llama.context_length");
        let untrained = scratch.write("untrained.gguf", &fixture::file(&values, &tensors));
        let missing = estimate(
            &AppConfig {
                ctx_size: 0,
                ..config(&untrained)
            },
            &env,
        );
        assert_eq!(
            (missing.ram, missing.vram, missing.kv_bytes),
            (None, None, None)
        );
        assert!(missing.notes.contains(&EstimateNote::MissingMetadata));
    }

    #[test]
    fn split_models_are_counted_once_and_missing_parts_block_memory_figures() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let single = scratch.write("single.gguf", &fixture::file(&values, &tensors));
        let mut first_values = values;
        first_values.push(("split.count".into(), Value::U32(3)));
        let parts = [&tensors[..3], &tensors[3..7], &tensors[7..]];
        let mut paths = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            let bytes = if index == 0 {
                fixture::file(&first_values, part)
            } else {
                fixture::file(&[("split.count".into(), Value::U32(3))], part)
            };
            paths.push(scratch.write(&format!("split-{:05}-of-00003.gguf", index + 1), &bytes));
        }
        let env = environment(GPU);
        let whole = estimate(&config(&single), &env);
        let split = estimate(&config(&paths[0]), &env);
        // The parts add up to the placement of the same model in one file.
        assert_eq!(
            (split.ram, split.vram, split.kv_bytes),
            (whole.ram, whole.vram, whole.kv_bytes)
        );
        let total: u64 = paths.iter().map(|path| size(path)).sum();
        assert_eq!(
            (split.model_bytes, split.disk_bytes, split.disk_complete),
            (total, total, true)
        );
        // Naming a later part still finds the whole model.
        assert_eq!(estimate(&config(&paths[1]), &env).vram, split.vram);

        // A file named twice is stored once.
        let adapter_path = scratch.write(
            "adapter.gguf",
            &fixture::file(
                &[("general.architecture".into(), Value::Str("llama"))],
                &[("blk.0.attn_q.weight.lora_a".into(), vec![256, 8], 8_192)],
            ),
        );
        let twice = estimate(
            &AppConfig {
                lora_adapters: vec![adapter(&adapter_path), adapter(&adapter_path)],
                ..config(&paths[0])
            },
            &env,
        );
        assert_eq!(twice.auxiliary_bytes, size(&adapter_path));
        assert_eq!(twice.disk_bytes, total + size(&adapter_path));

        // A missing part leaves a partial size and no memory figures.
        std::fs::remove_file(&paths[1]).unwrap();
        let incomplete = estimate(&config(&paths[0]), &env);
        assert!(!incomplete.disk_complete);
        assert!(incomplete.notes.contains(&EstimateNote::MissingFiles));
        assert_eq!((incomplete.ram, incomplete.vram), (None, None));
        assert_eq!(incomplete.disk_bytes, size(&paths[0]) + size(&paths[2]));

        let nothing = estimate(&AppConfig::default(), &env);
        assert!(!nothing.disk_complete);
        assert_eq!(
            (nothing.ram, nothing.vram, nothing.disk_bytes),
            (None, None, 0)
        );
    }

    #[test]
    fn auxiliary_models_add_memory_and_unsupported_architectures_get_no_figure() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("model.gguf", &fixture::file(&values, &tensors));
        let projector = scratch.write("mmproj.gguf", &vec![0u8; 3 << 20]);
        let adapter_path = scratch.write(
            "adapter.gguf",
            &fixture::file(
                &[("general.architecture".into(), Value::Str("llama"))],
                &[
                    ("blk.3.attn_q.weight.lora_a".into(), vec![256, 8], 8_192),
                    ("blk.0.attn_q.weight.lora_b".into(), vec![8, 256], 8_192),
                ],
            ),
        );
        let (draft_values, draft_tensors) = plain("qwen2");
        let draft = scratch.write("draft.gguf", &fixture::file(&draft_values, &draft_tensors));
        let env = environment(GPU);
        let base = estimate(&config(&path), &env);
        assert!(!base.notes.contains(&EstimateNote::Auxiliary));
        let with_auxiliary = estimate(
            &AppConfig {
                mmproj: projector.to_string_lossy().into_owned(),
                lora_adapters: vec![adapter(&adapter_path)],
                spec_type: "draft-simple".into(),
                spec_draft_model: draft.to_string_lossy().into_owned(),
                server_args: ["-ctkd", "f16", "-ctvd", "f16"].map(String::from).to_vec(),
                ..config(&path)
            },
            &env,
        );
        assert!(with_auxiliary.notes.contains(&EstimateNote::Auxiliary));
        assert!(!with_auxiliary
            .notes
            .contains(&EstimateNote::AdvancedOptions));
        assert_eq!(
            with_auxiliary.auxiliary_bytes,
            size(&projector) + size(&adapter_path) + size(&draft)
        );
        assert_eq!(with_auxiliary.model_bytes, base.model_bytes);
        // The total includes the independent draft cache as well.
        assert_eq!(
            with_auxiliary.kv_bytes,
            base.kv_bytes.map(|bytes| bytes * 2)
        );
        // The projector, both adapter tensors and the fully offloaded draft
        // with its own cache all land in VRAM.
        let added = size(&projector) + 16_384 + 4 * LAYER + OUTPUT + 4_096 * KV_PER_CELL;
        assert!(with_auxiliary.vram.unwrap().min_bytes >= base.vram.unwrap().min_bytes + added);

        let cases: [(&'static str, Option<(&str, u32)>); 4] = [
            ("mamba", None),
            ("newhybrid", Some(("newhybrid.ssm.state_size", 16))),
            ("deepseek2", Some(("deepseek2.attention.kv_lora_rank", 512))),
            ("gemma3", Some(("gemma3.attention.sliding_window", 1_024))),
        ];
        for (index, (architecture, extra)) in cases.into_iter().enumerate() {
            let (mut values, tensors) = plain(architecture);
            if let Some((key, value)) = extra {
                values.push((key.into(), Value::U32(value)));
            }
            let path = scratch.write(
                &format!("unsupported-{index}.gguf"),
                &fixture::file(&values, &tensors),
            );
            let result = estimate(&config(&path), &env);
            assert_eq!(
                (result.ram, result.vram, result.kv_bytes),
                (None, None, None),
                "{architecture}"
            );
            assert!(result
                .notes
                .contains(&EstimateNote::UnsupportedArchitecture));
            assert!(result.disk_complete && result.disk_bytes == size(&path));
        }
    }

    #[test]
    fn expert_weights_stay_in_ram_when_moe_layers_are_kept_on_the_cpu() {
        let scratch = Scratch::new();
        let (values, mut tensors) = plain("qwen3moe");
        for il in 0..4 {
            tensors.push((
                format!("blk.{il}.ffn_up_exps.weight"),
                vec![256, 64, 8],
                65_536,
            ));
        }
        let path = scratch.write("moe.gguf", &fixture::file(&values, &tensors));
        let bytes = gguf::read_model_facts(&path).unwrap().tensors.unwrap();
        let moe = |overrides| place(&bytes, 4, true, 99, Offload::OutputFirst, overrides, true);
        let offloaded = moe(Overrides::default());
        let first_two = moe(Overrides {
            n_cpu_moe: 2,
            ..Overrides::default()
        });
        assert_eq!(first_two.gpu, offloaded.gpu - 2 * 65_536);
        assert_eq!(first_two.cpu, offloaded.cpu + 2 * 65_536);
        assert_eq!(first_two.largest_cpu_layer, 65_536);
        let all = moe(Overrides {
            cpu_moe: true,
            ..Overrides::default()
        });
        assert_eq!(all.gpu, offloaded.gpu - 4 * 65_536);

        let env = environment(GPU);
        let base = estimate(&config(&path), &env).vram.unwrap();
        let typed = estimate(
            &AppConfig {
                n_cpu_moe: 2,
                ..config(&path)
            },
            &env,
        );
        assert_eq!(base.min_bytes - typed.vram.unwrap().min_bytes, 2 * 65_536);
        let flag = estimate(
            &AppConfig {
                server_args: vec!["--cpu-moe".into()],
                ..config(&path)
            },
            &env,
        );
        assert_eq!(base.min_bytes - flag.vram.unwrap().min_bytes, 4 * 65_536);
        assert!(!flag.notes.contains(&EstimateNote::AdvancedOptions));
    }

    #[test]
    fn only_advanced_arguments_that_move_memory_blank_the_estimate() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("model.gguf", &fixture::file(&values, &tensors));
        let env = environment(GPU);
        let base = config(&path);
        let with_args = |args: &[&str]| {
            estimate(
                &AppConfig {
                    server_args: args.iter().map(|arg| arg.to_string()).collect(),
                    ..base.clone()
                },
                &env,
            )
        };
        let reference = estimate(&base, &env);
        let harmless = with_args(&[
            "--min-p",
            "0.05",
            "--jinja",
            "--no-warmup",
            "--dry-multiplier",
            "0.8",
            "--threads-http",
            "4",
        ]);
        assert!(!harmless.notes.contains(&EstimateNote::AdvancedOptions));
        assert_eq!(
            (harmless.ram, harmless.vram),
            (reference.ram, reference.vram)
        );

        let overridden = with_args(&["-ot", "blk\\.[0-3]\\.=CPU"]);
        assert!(overridden.notes.contains(&EstimateNote::AdvancedOptions));
        assert_eq!(
            (overridden.ram, overridden.vram, overridden.kv_bytes),
            (None, None, None)
        );

        let unknown = with_args(&["--future-option", "3"]);
        assert!(unknown.notes.contains(&EstimateNote::AdvancedOptions));
        assert_eq!(
            (unknown.ram, unknown.vram, unknown.kv_bytes),
            (None, None, None)
        );
        for args in [
            ["--cache-ram", "8192"],
            ["--load-mode", "mlock"],
            ["--image-max-tokens", "65536"],
        ] {
            let estimate = with_args(&args);
            assert!(estimate.notes.contains(&EstimateNote::AdvancedOptions));
            assert!(estimate.ram.is_none() && estimate.vram.is_none());
        }

        // Keeping the cache on the host moves exactly the cache.
        let host_cache = with_args(&["-nkvo"]);
        let kv = reference.kv_bytes.unwrap();
        assert_eq!(
            reference.vram.unwrap().min_bytes - host_cache.vram.unwrap().min_bytes,
            kv
        );
        assert_eq!(
            host_cache.ram.unwrap().min_bytes - reference.ram.unwrap().min_bytes,
            kv
        );
    }

    #[test]
    fn server_arguments_are_classified_with_their_values() {
        let parse = |args: &[&str]| {
            parse_server_args(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>())
        };
        // A flag's value is never mistaken for the next flag.
        let neutral = parse(&["--no-warmup", "--repeat-last-n", "-1"]);
        assert!(!neutral.unknown && !neutral.unmodeled);
        assert!(parse(&["--no-mmap", "--mlock"]).unmodeled);
        // App-managed spellings are dropped with their value, as the launch does.
        let managed = parse(&["-t", "8", "--n-cpu-ffn", "2"]);
        assert_eq!(managed.n_cpu_ffn, 2);
        assert!(!managed.unknown);
        let draft = parse(&["-ctkd=q8_0", "--fit", "off", "-fitc", "2048", "-cmoed"]);
        assert_eq!(draft.draft_type_k, Some(KvType::Q8_0));
        assert!(!draft.fit && draft.draft_cpu_moe);
        assert_eq!(draft.fit_ctx, Some(2_048));
        assert!(parse(&["--gpt-oss-20b-default"]).unmodeled);
        assert!(parse(&["--override-kv", "llama.context_length=int:4096"]).unmodeled);
    }

    #[test]
    fn header_facts_are_read_again_when_the_file_changes() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("model.gguf", &fixture::file(&values, &tensors));
        let env = environment(GPU);
        assert_eq!(
            estimate(&config(&path), &env).kv_bytes,
            Some(4_096 * KV_PER_CELL)
        );
        let (mut values, mut tensors) = plain("llama");
        replace(&mut values, "llama.block_count", Value::U32(2));
        tensors.retain(|(name, _, _)| !name.starts_with("blk.2.") && !name.starts_with("blk.3."));
        values.push(("general.name".into(), Value::Str("replacement")));
        std::fs::write(&path, fixture::file(&values, &tensors)).unwrap();
        assert_eq!(
            estimate(&config(&path), &env).kv_bytes,
            Some(4_096 * KV_PER_CELL / 2)
        );
    }

    #[test]
    fn runtime_gpu_selection_and_single_mode_preserve_declared_placement() {
        let mut cfg = config(Path::new("synthetic.gguf"));
        cfg.gpu.gpu_ids = vec!["runtime:cuda:CUDA0".into(), "runtime:cuda:CUDA1".into()];
        let env = Environment::from_profile(&cfg, Some(32 << 30), None);
        assert_eq!(env.accelerator, Accelerator::Gpu { devices: 2 });
        assert!(env.shared_memory); // Physical mapping is unknown, so do not claim separate pools.
        cfg.gpu.split_mode = SplitMode::Single;
        assert_eq!(Environment::from_profile(&cfg, None, None).accelerator, GPU);
        cfg.active_backend = "cpu".into();
        assert_eq!(
            Environment::from_profile(&cfg, None, None).accelerator,
            Accelerator::Cpu
        );
    }

    #[test]
    fn cpu_estimate_uses_effective_host_placement_instead_of_saved_gpu_tuning() {
        let cfg = AppConfig {
            active_backend: "cpu".into(),
            ngl: 99,
            spec_draft_ngl: "all".into(),
            runtime_defaults: vec!["ngl".into(), "spec_draft_ngl".into()],
            server_args: [
                "--override-tensor=blk.*=MTL0",
                "--mmproj-device=MTL0",
                "--kv-offload",
                "--op-offload",
            ]
            .map(str::to_string)
            .to_vec(),
            ..Default::default()
        };
        let launch = launch_settings(&cfg);
        assert_eq!(launch.ngl, 0);
        assert_eq!(draft_layers(&cfg), 0);
        assert!(!launch.args.kv_offload);
        assert!(!launch.args.op_offload);
        assert!(!launch.args.mmproj_offload);
        assert!(!launch.args.unmodeled);
        assert!(!launch.args.unknown);
        assert_eq!(cfg.ngl, 99);
        assert_eq!(cfg.spec_draft_ngl, "all");
    }

    #[test]
    fn malformed_dimensions_and_short_layer_arrays_have_no_memory_figure() {
        let scratch = Scratch::new();
        for (index, (key, value)) in [
            ("llama.attention.head_count_kv", Value::U32s(vec![2])),
            ("llama.attention.key_length", Value::U32(0)),
            ("llama.attention.head_count", Value::U32(u32::MAX)),
            ("llama.embedding_length", Value::U32(u32::MAX)),
        ]
        .into_iter()
        .enumerate()
        {
            let (mut values, tensors) = plain("llama");
            replace(&mut values, key, value);
            let path = scratch.write(
                &format!("invalid-{index}.gguf"),
                &fixture::file(&values, &tensors),
            );
            let result = estimate(&config(&path), &environment(GPU));
            assert!(result.ram.is_none() && result.vram.is_none());
            assert!(result.notes.contains(&EstimateNote::MissingMetadata));
        }
        let (values, _) = plain("llama");
        let empty = scratch.write("empty.gguf", &fixture::file(&values, &[]));
        assert!(estimate(&config(&empty), &environment(GPU)).ram.is_none());
    }

    #[test]
    fn projector_shards_count_once_and_missing_shards_invalidate_the_total() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("model.gguf", &fixture::file(&values, &tensors));
        let first = scratch.write("projector-00001-of-00002.gguf", &[0; 64]);
        let second = scratch.write("projector-00002-of-00002.gguf", &[0; 96]);
        let cfg = AppConfig {
            mmproj: first.to_string_lossy().into_owned(),
            ..config(&path)
        };
        let result = estimate(&cfg, &environment(GPU));
        assert!(result.disk_complete);
        assert_eq!(result.auxiliary_bytes, 160);
        std::fs::remove_file(second).unwrap();
        let result = estimate(&cfg, &environment(GPU));
        assert!(!result.disk_complete);
        assert_eq!(result.auxiliary_bytes, 64);
        assert!(result.ram.is_none());
    }

    #[test]
    fn forced_cpu_draft_adds_host_memory_and_cache_without_device_buffers() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("model.gguf", &fixture::file(&values, &tensors));
        let draft = scratch.write("draft.gguf", &fixture::file(&values, &tensors));
        let base = estimate(&config(&path), &environment(GPU));
        let result = estimate(
            &AppConfig {
                spec_type: "draft-simple".into(),
                spec_draft_model: draft.to_string_lossy().into_owned(),
                spec_draft_device: "none".into(),
                server_args: ["-ctkd", "f16", "-ctvd", "f16"].map(String::from).to_vec(),
                ..config(&path)
            },
            &environment(GPU),
        );
        assert_eq!(result.vram, base.vram);
        assert!(result.ram.unwrap().min_bytes > base.ram.unwrap().min_bytes);
        assert_eq!(result.kv_bytes, base.kv_bytes.map(|bytes| bytes * 2));
    }

    #[test]
    fn qwen_hybrids_separate_attention_cache_from_recurrent_state() {
        let scratch = Scratch::new();
        for architecture in ["qwen3next", "qwen35", "qwen35moe", "qwen4exp"] {
            let (values, tensors) = hybrid(architecture);
            let path = scratch.write(
                &format!("{architecture}.gguf"),
                &fixture::file(&values, &tensors),
            );
            let mut cfg = config(&path);
            let env = environment(GPU);
            let base = estimate(&cfg, &env);
            // One full-attention layer, with a key-only indexer on Qwen4.
            let per_cell = 512 + if architecture == "qwen4exp" { 128 } else { 0 };
            assert_eq!(base.kv_bytes, Some(4096 * per_cell), "{architecture}");
            assert!(base.ram.is_some() && base.vram.is_some(), "{architecture}");
            cfg.ctx_size *= 2;
            let longer = estimate(&cfg, &env);
            assert_eq!(longer.kv_bytes, Some(8192 * per_cell));
            assert_eq!(
                longer.vram.unwrap().min_bytes - base.vram.unwrap().min_bytes,
                4096 * per_cell
            );
            assert_eq!(longer.disk_bytes, base.disk_bytes);
            cfg.ctx_size /= 2;
            cfg.parallel = 2;
            let parallel = estimate(&cfg, &env);
            // More sequences duplicate recurrent state, not the total KV capacity.
            assert_eq!(parallel.kv_bytes, base.kv_bytes);
            assert_eq!(
                parallel.vram.unwrap().min_bytes - base.vram.unwrap().min_bytes,
                3 * 71_680
            );
            cfg.parallel = 1;
            cfg.server_args = vec!["--no-kv-offload".into()];
            let cpu_cache = estimate(&cfg, &env);
            let caches = 3 * 71_680 + 4096 * per_cell;
            assert_eq!(
                cpu_cache.ram.unwrap().min_bytes - base.ram.unwrap().min_bytes,
                caches
            );
            assert_eq!(
                base.vram.unwrap().min_bytes - cpu_cache.vram.unwrap().min_bytes,
                caches
            );
            cfg.server_args.clear();
            cfg.cache_type_k = "q8_0".into();
            cfg.cache_type_v = "q8_0".into();
            let quantized = estimate(&cfg, &env);
            assert!(quantized.vram.unwrap().min_bytes < base.vram.unwrap().min_bytes);
            cfg.ngl = 0;
            let cpu = estimate(&cfg, &environment(Accelerator::Cpu));
            assert_eq!(cpu.vram, Some(ResourceRange::default()));
            assert!(
                cpu.ram.unwrap().min_bytes
                    >= RAM_BASE.min_bytes
                        + cpu.kv_bytes.unwrap()
                        + 3 * 71_680
                        + EMBEDDING
                        + 4 * LAYER
                        + OUTPUT
            );
        }
    }

    fn hybrid(architecture: &'static str) -> (Values, Tensors) {
        let (mut values, tensors) = plain(architecture);
        for (key, value) in [
            ("ssm.conv_kernel", 4),
            ("ssm.inner_size", 256),
            ("ssm.state_size", 64),
            ("ssm.group_count", 2),
            ("full_attention_interval", 4),
        ] {
            values.push((format!("{architecture}.{key}"), Value::U32(value)));
        }
        if architecture == "qwen4exp" {
            values.push((
                format!("{architecture}.attention.indexer.key_length"),
                Value::U32(64),
            ));
            values.push((
                format!("{architecture}.hyper_connection.count"),
                Value::U32(4),
            ));
        }
        (values, tensors)
    }

    #[test]
    fn qwen_layer_masks_ple_and_cpu_embeddings_are_included() {
        let scratch = Scratch::new();
        let (mut values, mut tensors) = hybrid("qwen4exp");
        replace(
            &mut values,
            "qwen4exp.attention.recurrent_layers",
            Value::U32s(vec![1, 0, 1, 0]),
        );
        replace(
            &mut values,
            "qwen4exp.attention.head_count_kv",
            Value::U32s(vec![0, 2, 0, 2]),
        );
        values.extend([
            ("qwen4exp.ple.layers".into(), Value::U32s(vec![0])),
            ("qwen4exp.ple.conv_kernel".into(), Value::U32(3)),
            ("qwen4exp.ple.ngram_size".into(), Value::U32(3)),
        ]);
        tensors.push(("per_layer_token_embd.weight".into(), vec![64, 100], 32_768));
        let path = scratch.write("hybrid.gguf", &fixture::file(&values, &tensors));
        let mut cfg = config(&path);
        cfg.server_args = [
            "--load-mode",
            "none",
            "--override-tensor",
            "per_layer_token_embd=CPU",
        ]
        .map(String::from)
        .to_vec();
        let base = estimate(&cfg, &environment(GPU));
        assert!(base.ram.is_some());
        assert!(!base.notes.contains(&EstimateNote::AdvancedOptions));
        assert_eq!(base.kv_bytes, Some(2 * 640 * 4096));
        let found = match load_model(&cfg.active_model, &mut Disk::default(), false) {
            Loaded::Ready(found) => found,
            _ => panic!("synthetic model unreadable"),
        };
        let dimensions = shape(&found).unwrap();
        assert_eq!(
            dimensions.recurrent_bytes,
            vec![71_680 + 24_576, 0, 71_680, 0]
        );
        assert_eq!(dimensions.tensors.input, 32_768);
        cfg.server_args = ["--override-tensor", "blk.*=CPU"]
            .map(String::from)
            .to_vec();
        assert!(estimate(&cfg, &environment(GPU)).ram.is_none());
        // A partial layer mask or missing state dimension must not silently
        // drop state memory or turn the model back into plain attention.
        replace(
            &mut values,
            "qwen4exp.attention.recurrent_layers",
            Value::U32s(vec![1]),
        );
        let bad = scratch.write("short-mask.gguf", &fixture::file(&values, &tensors));
        assert!(estimate(&config(&bad), &environment(GPU)).ram.is_none());
        values.retain(|(key, _)| key != "qwen4exp.ssm.state_size");
        let bad = scratch.write("missing-state.gguf", &fixture::file(&values, &tensors));
        assert!(estimate(&config(&bad), &environment(GPU))
            .notes
            .contains(&EstimateNote::MissingMetadata));
    }

    #[test]
    fn fully_gpu_resident_models_have_zero_ram_and_ssd_offload() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("full-gpu.gguf", &fixture::file(&values, &tensors));
        let cfg = config(&path);
        let result = super::estimate(&cfg, &environment(GPU));
        assert_eq!(result.ram_offload_bytes, Some(0));
        assert_eq!(result.ssd_offload_bytes, Some(0));
        assert!(result.host_memory_bytes.unwrap() > 0);
        assert!(result.disk_bytes > 0);
        assert_eq!(result.vram_bytes, result.required_vram_bytes);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("min_bytes"));

        let partial = super::estimate(
            &AppConfig {
                ngl: 2,
                ..cfg.clone()
            },
            &environment(GPU),
        );
        assert!(partial.ram_offload_bytes.unwrap() > 0);
        assert_eq!(partial.ssd_offload_bytes, Some(0));
        assert!(partial.vram_bytes < result.vram_bytes);
        assert_eq!(partial.disk_bytes, result.disk_bytes);

        let cpu = super::estimate(&cfg, &environment(Accelerator::Cpu));
        assert_eq!(cpu.vram_bytes, Some(0));
        assert!(cpu.ram_offload_bytes.unwrap() >= EMBEDDING + 4 * LAYER + OUTPUT);
        assert_eq!(cpu.ssd_offload_bytes, Some(0));
    }

    #[test]
    fn lazy_ple_reads_count_as_ssd_offload_even_with_plenty_of_ram() {
        let scratch = Scratch::new();
        let (values, mut tensors) = hybrid("qwen4exp");
        const PLE: u64 = 32_768;
        tensors.push(("per_layer_token_embd.weight".into(), vec![64, 100], PLE));
        let path = scratch.write("lazy-ple.gguf", &fixture::file(&values, &tensors));
        let mut cfg = config(&path);
        let env = environment(GPU);
        let resident = super::estimate(&cfg, &env);
        assert_eq!(resident.ram_offload_bytes, Some(PLE));
        assert_eq!(resident.ssd_offload_bytes, Some(0));
        cfg.server_args = vec!["--lazy-mode=on".into()];
        let lazy = super::estimate(&cfg, &env);
        assert_eq!(lazy.vram_bytes, resident.vram_bytes);
        assert_eq!(lazy.host_memory_bytes, resident.host_memory_bytes);
        assert_eq!(lazy.ram_offload_bytes, Some(0));
        assert_eq!(lazy.ssd_offload_bytes, Some(PLE));
        assert!(lazy.notes.contains(&EstimateNote::LazyOffload));
        assert!(!lazy.notes.contains(&EstimateNote::DiskOffload));
        assert_eq!(lazy.disk_bytes, resident.disk_bytes);
        let mut small = env.clone();
        small.vram_capacity_bytes = lazy.vram_bytes.map(|bytes| bytes - 4096);
        small.ram_capacity_bytes = lazy.host_memory_bytes.map(|bytes| bytes + 1024);
        let overflow = super::estimate(&cfg, &small);
        assert_eq!(overflow.ram_offload_bytes, Some(1024));
        assert_eq!(overflow.ssd_offload_bytes, Some(PLE + 3072));
        assert!(overflow.notes.contains(&EstimateNote::DiskOffload));
        cfg.server_args = vec!["-lzm".into(), "off".into()];
        assert_eq!(super::estimate(&cfg, &env), resident);
        cfg.server_args = vec!["--load-mode=mmap".into()];
        assert_eq!(super::estimate(&cfg, &env), resident);
    }

    #[test]
    fn automatic_lazy_reads_apply_only_to_large_eligible_tensors() {
        let mut tensors = TensorBytes {
            per_layer_token_embd: 4 * 1024 * MIB,
            ..TensorBytes::default()
        };
        assert_eq!(LazyMode::Auto.disk_bytes(&tensors), 0);
        tensors.per_layer_token_embd += 32;
        assert_eq!(
            LazyMode::Auto.disk_bytes(&tensors),
            tensors.per_layer_token_embd
        );
        assert_eq!(LazyMode::Off.disk_bytes(&tensors), 0);
        tensors.per_layer_token_embd = 0;
        tensors.input = 8 * 1024 * MIB;
        assert_eq!(LazyMode::On.disk_bytes(&tensors), 0);
    }

    #[test]
    fn capacity_planning_fills_vram_then_ram_and_only_spills_the_remainder_to_disk() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("capacity.gguf", &fixture::file(&values, &tensors));
        let cfg = config(&path);
        let full = super::estimate(&cfg, &environment(GPU));
        let required = full.required_vram_bytes.unwrap();
        let host = full.host_memory_bytes.unwrap();
        let env = Environment {
            vram_capacity_bytes: Some(required - 128 * 1024),
            ..environment(GPU)
        };
        let in_ram = super::estimate(&cfg, &env);
        assert_eq!(in_ram.vram_bytes, env.vram_capacity_bytes);
        assert_eq!(in_ram.ram_offload_bytes, Some(128 * 1024));
        assert_eq!(in_ram.ssd_offload_bytes, Some(0));
        assert!(in_ram.notes.contains(&EstimateNote::PlacementAdjustment));
        let limited = Environment {
            ram_capacity_bytes: Some(host + 32 * 1024),
            ..env.clone()
        };
        let on_disk = super::estimate(&cfg, &limited);
        assert_eq!(on_disk.ram_offload_bytes, Some(32 * 1024));
        assert_eq!(on_disk.ssd_offload_bytes, Some(96 * 1024));
        assert_eq!(
            on_disk.vram_bytes.unwrap()
                + on_disk.ram_offload_bytes.unwrap()
                + on_disk.ssd_offload_bytes.unwrap(),
            required
        );
        assert_eq!(on_disk.disk_bytes, full.disk_bytes);
        assert!(on_disk.notes.contains(&EstimateNote::DiskOffload));
        let longer = super::estimate(
            &AppConfig {
                ctx_size: 8192,
                ..cfg
            },
            &limited,
        );
        assert_eq!(longer.vram_bytes, on_disk.vram_bytes);
        assert!(longer.ssd_offload_bytes > on_disk.ssd_offload_bytes);
        assert_eq!(longer.disk_bytes, on_disk.disk_bytes);
    }

    #[test]
    fn explicit_cpu_experts_remain_offloaded_even_when_the_gpu_has_space() {
        let scratch = Scratch::new();
        let (values, mut tensors) = hybrid("qwen4exp");
        tensors.push(("blk.3.ffn_up_exps.weight".into(), vec![256, 64, 8], 65_536));
        let path = scratch.write("experts.gguf", &fixture::file(&values, &tensors));
        let mut cfg = config(&path);
        cfg.runtime_defaults.push("n_cpu_moe".into());
        let gpu = super::estimate(&cfg, &environment(GPU));
        assert_eq!(gpu.ram_offload_bytes, Some(0));
        cfg.runtime_defaults.clear();
        cfg.n_cpu_moe = 4;
        let cpu = super::estimate(&cfg, &environment(GPU));
        assert_eq!(cpu.ram_offload_bytes, Some(65_536));
        assert_eq!(cpu.ssd_offload_bytes, Some(0));
        assert!(cpu.vram_bytes < gpu.vram_bytes);
    }

    #[test]
    fn missing_capacity_is_not_reported_as_zero_and_shared_memory_is_not_counted_twice() {
        let scratch = Scratch::new();
        let (values, tensors) = plain("llama");
        let path = scratch.write("shared.gguf", &fixture::file(&values, &tensors));
        let cfg = AppConfig {
            ngl: 2,
            ..config(&path)
        };
        let unknown = super::estimate(
            &cfg,
            &Environment {
                vram_capacity_bytes: None,
                ram_capacity_bytes: None,
                ..environment(GPU)
            },
        );
        assert!(unknown.vram_bytes.is_some());
        assert_eq!(unknown.ram_offload_bytes, None);
        assert_eq!(unknown.ssd_offload_bytes, None);
        assert!(unknown.notes.contains(&EstimateNote::CapacityUnknown));
        let known = super::estimate(&cfg, &environment(GPU));
        let shared = super::estimate(
            &cfg,
            &Environment {
                vram_capacity_bytes: None,
                ram_capacity_bytes: Some(
                    known.host_memory_bytes.unwrap() + known.vram_bytes.unwrap() + 1024,
                ),
                shared_memory: true,
                ..environment(GPU)
            },
        );
        assert_eq!(shared.ram_offload_bytes, Some(1024));
        assert!(shared.ssd_offload_bytes.unwrap() > 0);
    }

    #[test]
    fn inherited_moe_count_does_not_invent_cpu_experts_when_gpu_layers_are_explicit() {
        let scratch = Scratch::new();
        let (values, mut tensors) = plain("qwen3moe");
        tensors.push(("blk.3.ffn_up_exps.weight".into(), vec![256, 64, 8], 65_536));
        let path = scratch.write("model.gguf", &fixture::file(&values, &tensors));
        let mut cfg = config(&path);
        cfg.runtime_defaults.push("n_cpu_moe".into());
        let result = estimate(&cfg, &environment(GPU));
        let fixed_gpu = estimate(&config(&path), &environment(GPU));
        assert_eq!(result.ram, fixed_gpu.ram);
        assert_eq!(result.vram, fixed_gpu.vram);
        cfg.server_args = vec!["--fit".into(), "off".into()];
        assert!(estimate(&cfg, &environment(GPU)).ram.is_some());
        cfg.gpu.split_mode = SplitMode::Tensor;
        let result = estimate(&cfg, &environment(GPU));
        assert!(result.ram.is_none());
        assert!(result.notes.contains(&EstimateNote::AdvancedOptions));
    }
}
