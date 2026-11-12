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

#[test]
fn python_provider_disk_accounting_accepts_gguf_without_inventing_memory() {
    let scratch = Scratch::new();
    let (values, tensors) = plain("llama");
    let path = scratch.write("metal-model.gguf", &fixture::file(&values, &tensors));
    let mut cfg = config(&path);
    cfg.active_provider = "vllm".into();
    let result = super::estimate(&cfg, &environment(GPU));
    let size = std::fs::metadata(&path).unwrap().len();
    assert_eq!(result.model_bytes, size);
    assert_eq!(result.disk_bytes, size);
    assert!(result.disk_complete);
    assert_eq!(result.required_vram_bytes, None);
    assert_eq!(result.host_memory_bytes, None);
    assert_eq!(result.kv_bytes, None);
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
fn facts_cache_keeps_recent_models_when_capacity_is_exceeded() {
    let cache = Mutex::new(FactsCache::default());

    let scratch = Scratch::new();
    let (values, tensors) = plain("llama");
    let bytes = fixture::file(&values, &tensors);
    let hot = scratch.write("hot.gguf", &bytes);
    let cold: Vec<_> = (0..64)
        .map(|index| scratch.write(&format!("cold-{index}.gguf"), &bytes))
        .collect();

    let read = |path: &Path| {
        let mut disk = Disk::default();
        let (canonical, len, modified) = disk.count(path, false).unwrap();
        assert!(cached_facts_in(&cache, &canonical, len, modified).is_ok());
    };
    read(&hot);
    for path in &cold {
        read(path);
        read(&hot);
    }

    let canonical = std::fs::canonicalize(hot).unwrap();
    let cache = cache.lock().unwrap();
    assert_eq!(cache.entries.len(), MAX_CACHED_FACTS);
    assert!(cache.entries.contains_key(&canonical));
    assert_eq!(cache.order.back(), Some(&canonical));
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
fn long_flash_contexts_reserve_host_and_device_attention_masks() {
    let scratch = Scratch::new();
    let (values, tensors) = plain("llama");
    let path = scratch.write("long-context.gguf", &fixture::file(&values, &tensors));
    let mut cfg = config(&path);
    cfg.ctx_size = 262_144;
    cfg.ubatch_size = 512;
    let env = environment(GPU);
    let base = estimate(&cfg, &env);
    cfg.ctx_size *= 2;
    let longer = estimate(&cfg, &env);
    // F16 mask is 256 MiB per 256K context at 512 tokens, even with FA.
    let mask = 256 * MIB;
    assert_eq!(attention_mask_bytes(262_144, 512, true), mask);
    assert_eq!(attention_mask_bytes(262_144, 512, false), mask * 2);
    assert_eq!(
        longer.ram.unwrap().min_bytes - base.ram.unwrap().min_bytes,
        mask
    );
    assert_eq!(
        longer.vram.unwrap().min_bytes - base.vram.unwrap().min_bytes,
        longer.kv_bytes.unwrap() - base.kv_bytes.unwrap() + mask
    );
}

#[test]
fn layer_pipelines_keep_four_mask_copies_on_host_and_each_gpu() {
    let scratch = Scratch::new();
    let (values, tensors) = plain("llama");
    let path = scratch.write("pipeline.gguf", &fixture::file(&values, &tensors));
    let env = environment(Accelerator::Gpu { devices: 2 });
    for backend in ["cuda", "rocm"] {
        let mut cfg = config(&path);
        cfg.active_backend = backend.into();
        cfg.ctx_size = 262_144;
        cfg.ubatch_size = 512;
        let full = estimate(&cfg, &env);
        cfg.gpu.split_mode = SplitMode::Layer;
        assert_eq!(estimate(&cfg, &env), full);
        cfg.server_args = vec!["--no-kv-offload".into()];
        let host = estimate(&cfg, &env);
        let mask = 256 * MIB;
        let kv = full.kv_bytes.unwrap();
        assert_eq!(
            full.vram.unwrap().min_bytes - host.vram.unwrap().min_bytes,
            kv + 4 * mask * 2,
            "{backend}"
        );
        assert_eq!(
            host.ram.unwrap().min_bytes + 3 * mask,
            full.ram.unwrap().min_bytes + kv,
            "{backend}"
        );
    }
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

    // Host attention also removes the GPU's input-mask copy. The host
    // already holds the mask in either case.
    let host_cache = with_args(&["-nkvo"]);
    let kv = reference.kv_bytes.unwrap();
    assert_eq!(
        reference.vram.unwrap().min_bytes - host_cache.vram.unwrap().min_bytes,
        kv + 4096 * 512 * 2
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
    let env = Environment::from_gpus(&cfg, Some(32 << 30), &[]);
    assert_eq!(env.accelerator, Accelerator::Gpu { devices: 2 });
    assert!(env.shared_memory); // Physical mapping is unknown, so do not claim separate pools.
    cfg.gpu.split_mode = SplitMode::Single;
    assert_eq!(Environment::from_gpus(&cfg, None, &[]).accelerator, GPU);
    cfg.active_backend = "cpu".into();
    assert_eq!(
        Environment::from_gpus(&cfg, None, &[]).accelerator,
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

    // Non-layer weights cannot make an incomplete repeating layer valid.
    let (values, mut tensors) = plain("llama");
    tensors.retain(|(name, _, _)| !name.starts_with("blk.1."));
    let gap = scratch.write("missing-layer.gguf", &fixture::file(&values, &tensors));
    let bytes = size(&gap);
    let env = environment(GPU);
    assert_eq!(
        super::estimate(&config(&gap), &env),
        ResourceEstimate {
            vram_bytes: None,
            ram_offload_bytes: None,
            ssd_offload_bytes: None,
            required_vram_bytes: None,
            host_memory_bytes: None,
            vram_capacity_bytes: env.vram_capacity_bytes,
            ram_capacity_bytes: env.ram_capacity_bytes,
            disk_bytes: bytes,
            disk_complete: true,
            model_bytes: bytes,
            auxiliary_bytes: 0,
            kv_bytes: None,
            notes: vec![EstimateNote::MissingMetadata],
        }
    );
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
            4096 * per_cell + 4096 * 512 * 2
        );
        assert_eq!(longer.disk_bytes, base.disk_bytes);
        cfg.ctx_size /= 2;
        cfg.parallel = 2;
        let parallel = estimate(&cfg, &env);
        // More streams duplicate recurrent state but halve the per-stream
        // attention mask. Total KV capacity stays the same.
        assert_eq!(parallel.kv_bytes, base.kv_bytes);
        assert_eq!(
            parallel.vram.unwrap().min_bytes + 4096 * 512 * 2,
            base.vram.unwrap().min_bytes + 3 * 71_680 + 2048 * 512 * 2
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
            caches + 4096 * 512 * 2
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
    let dimensions = shape(found).unwrap();
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
