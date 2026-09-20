//! Pre-launch numerical correctness gate.
//!
//! An installed runtime is a third-party binary running on hardware this
//! project has never seen. It can compute wrong results while reporting
//! success, and a user cannot tell the difference from the answer text: in the
//! case that motivated this module, three consecutive upstream Windows ROCm
//! builds produced fluent but wrong output when a model was split across two
//! GPUs, while the same builds were correct on one GPU and on the host.
//!
//! Naming the affected builds does not generalise — the next broken build is
//! not on any list — so the gate measures instead. Every runtime ships
//! `llama-perplexity`, which can write a full logits baseline
//! (`--save-all-logits`) and score a later pass against it
//! (`--kl-divergence --kl-divergence-base`). Running the same binary over the
//! same weights and the same text twice, changing only which devices execute
//! the kernels, isolates device-path divergence with no sampling involved.
//!
//! The verdict is the median KL divergence, not the perplexity ratio. On the
//! large model the ratio was dramatic — 1.60 healthy on one ROCm device, 2.06
//! healthy across two Vulkan devices, 230,173,867 corrupted — but on the tiny
//! canary this gate actually runs, the same corrupted placement only moved it
//! to 2.49 against 1.00 healthy. A ratio limit wide enough to tolerate honest
//! precision drift would have let that through. Median divergence separates the
//! same runs by two and a half orders (0.0019 healthy, 0.67 corrupted), so that
//! is what decides, with the ratio kept only as a secondary blow-up trip.
//!
//! Exact agreement is never required anywhere: a healthy GPU pass matched the
//! host's top token only 71-74% of the time, because host and device accumulate
//! in different precisions. And because a runtime may quietly ignore a device
//! it was offered — leaving the cross-device path untested while the numbers
//! look perfect — the gate also reads back which devices actually received
//! weights, and reports `Unsupported` rather than `Pass` when the placement it
//! was asked to verify did not happen.

use crate::config::AppConfig;
use crate::gpu::ResolvedGpu;
use crate::runtime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

/// Bump when the probe text, canary weights, or comparison change meaning, so
/// stored verdicts are never reinterpreted under a different procedure.
pub const SUITE_VERSION: u32 = 1;

/// Median KL divergence above this fails, and it is the primary verdict.
///
/// The perplexity ratio alone is not usable here. It separates the big models
/// by eight orders of magnitude, but on the deliberately tiny canary the same
/// corrupted placement only moved it from 1.000 to 2.493 — a ratio limit loose
/// enough for legitimate drift would have passed a placement already proven to
/// produce wrong text. Median KLD separates the canary cleanly instead:
/// 0.001908 on one ROCm device, 0.001867 across two Vulkan devices, against
/// 0.666306 on the corrupted two-device ROCm placement, a factor of about 350.
/// This limit sits ~52x above the worst healthy observation and ~6.7x below the
/// measured fault.
const MAX_MEDIAN_KLD: f64 = 0.1;

/// Floor and multiplier for the self-calibrated limit used when a placement
/// spans devices.
///
/// A single fixed constant has to be right on hardware nobody here has seen: too
/// tight and an honest machine is blocked, too loose and a fault slips past. So
/// a multi-device placement is judged against the same machine's own
/// single-device drift instead — its honest host-to-device difference, measured
/// moments earlier with the same weights and text. Measured here, calibration
/// was 0.001908 and the corrupted two-device placement 0.666306, a factor of
/// about 350, while a healthy two-device placement stayed at 0.001867. The floor
/// keeps a suspiciously perfect calibration from producing a limit of zero.
const CALIBRATION_FACTOR: f64 = 20.0;
const CALIBRATION_FLOOR: f64 = 0.02;

/// Kept as a secondary trip for gross divergence that reports an unusable
/// median: the corrupted large-model placement scored 230,173,867 here while
/// every healthy placement measured between 0.99 and 2.06.
const MAX_PERPLEXITY_RATIO: f64 = 10.0;

/// What the canary scores on a working host path, and how far from it a runtime
/// may land before its own host pass is disqualified as the oracle.
///
/// The host path is near enough to deterministic across builds: b11026 (ROCm)
/// and b10840 (Vulkan) scored 1617.7714 and 1617.7713 over this text. A build
/// whose host path is broken lands orders of magnitude away, so a factor-of-two
/// band catches that while leaving ample room for a different CPU's arithmetic
/// and for the last digit of the text's own encoding.
const REFERENCE_PPL_EXPECTED: f64 = 1617.7714;
const REFERENCE_PPL_TOLERANCE: f64 = 2.0;

/// Each pass loads tens of megabytes and scores a few hundred tokens; the
/// measured canary reference pass took 0.6s and a device pass 3.1s. The limit
/// only has to stop a hung child from blocking a launch.
const PASS_TIMEOUT: Duration = Duration::from_secs(180);

/// Fixed scoring text: eight unrelated paragraphs, no repetition anywhere.
///
/// The text has to be genuinely hard to predict, and an earlier version was
/// not. It repeated one paragraph to reach the required length, which let a
/// competent model copy what it had already seen: the 88 GiB model scored it at
/// perplexity 1.016, and against that nearly one-hot reference a placement
/// already proven to emit garbage diverged by only 0.0023 — the gate passed it.
/// With this text the same model scores 5.92 and the same placement diverges
/// visibly. A probe the model finds easy measures nothing.
///
/// Length matters too: the deep pass needs 1024 tokens for two 512-token
/// chunks, and this is about 1150 for the tokenizers measured.
const PROBE_TEXT: &str = concat!(
    "The harbour master kept two ledgers, one for the tides and one for the debts, and he was careful never to confuse them. In winter the fishing boats came back light and the second ledger grew faster than the first. He had inherited the habit from his father, who believed that a number written down was a promise and a number remembered was only a wish. Gulls quarrelled on the slate roof above his office while he ruled the margins with a steel edge.\n",
    "Sedimentary rock preserves the order of its own deposition, which is why a cliff face can be read from the bottom upward like a column of text. Interruptions in that order are themselves informative: an unconformity marks time that was removed rather than time that never passed. Field geologists learn to distrust a surface that looks too clean, because erosion rarely leaves a tidy edge.\n",
    "A compiler that optimises aggressively must still preserve the observable behaviour of the program it was given, and the definition of observable is where most of the difficulty lives. Reordering two independent loads is harmless until another thread is watching. The memory model is the contract that decides which reorderings are lies.\n",
    "Bread dough is a suspension held together by gluten that forms only when flour is hydrated and worked. Too little water and the network never develops; too much and it tears under its own weight. Bakers speak of hydration as a percentage of flour mass, which lets the same recipe scale from a single loaf to a bakery shift without recalculating from scratch.\n",
    "The court reporter transcribed the testimony without inflection, so the transcript flattened a shouted accusation into the same typeface as a murmured correction. Appellate judges reading it months later would reconstruct the tone from context, or fail to. This is one reason why findings of fact are left to the trial court, which heard the voices.\n",
    "Migrating birds navigate by a combination of cues that no single experiment has fully separated: the sun's azimuth, polarised light at dusk, the geomagnetic field, and remembered landmarks. Displacement studies move a bird hundreds of kilometres and watch where it goes. Juveniles often fly the original heading and end up where no member of their species winters.\n",
    "Insurance prices uncertainty rather than risk, and the distinction matters when the underlying distribution is unknown. A flood model calibrated on fifty years of records says little about a catchment whose upstream forest was cleared last decade. Underwriters call this parameter risk and charge for it separately.\n",
    "Glassblowers work within a narrow thermal window where the material flows but does not run. The piece is turned constantly, because gravity is patient and will pull an unattended wall thin on one side. Annealing afterwards is slower than the shaping and matters more: cool it too fast and stress locked into the glass will crack it days later on a shelf.\n",
    "Restoring a pipe organ means deciding whose instrument you are restoring, because three centuries of builders may have left their opinions inside the case. A voicer who widens a flue to brighten a rank is not repairing damage; he is arguing with a predecessor. Conservation practice now favours reversible work and written justification for every departure from what was found.\n",
    "The submarine cable repair ship carries more spare fibre than it expects to use and a grapnel heavy enough to drag a seabed it cannot see. Locating a fault begins with an optical measurement taken from shore, accurate to within a kilometre over thousands. The crew then hooks the cable, cuts it deliberately, and brings one end aboard before the other.\n",
    "Vaccine trials are usually powered on the assumption that infection is a rare event, which makes the required sample size sensitive to an incidence rate nobody controls. If the epidemic recedes during enrolment the trial may finish with too few cases to distinguish anything. Adaptive designs address this by letting the stopping rule depend on accumulating counts rather than a fixed calendar.\n",
    "A chess endgame tablebase contains the exact value of every reachable position with a small number of pieces, computed backwards from checkmate. It has no notion of plan or threat. Grandmasters studying tablebase lines sometimes find wins that take a hundred moves and follow no principle any human would articulate.\n",
    "Wool takes dye unevenly when the fibre has been damaged by heat, which is why a dyer tests a skein from each fleece before committing a batch. The variation is invisible dry and obvious wet. Commercial mills blend across many animals precisely to average this out, at the cost of the character a single flock would give.\n",
    "Air traffic controllers work in a language deliberately stripped of ambiguity, where numbers are spoken digit by digit and a handful of words are reserved for meanings they never carry elsewhere. Readback exists so that a misheard instruction fails loudly at once rather than quietly later. The phraseology is revised after accidents, and every revision is an epitaph.\n",
    "Peat bogs accumulate about a millimetre a year and preserve pollen, insects, and occasionally people. The chemistry that tans skin also dissolves bone, so a bog body may have a face and no skeleton. Radiocarbon dates from such finds cluster in ways archaeologists still argue about.\n",
    "The rule against perpetuities defeated generations of law students because it asks about possibilities rather than probabilities, and possibility includes the fertile octogenarian. Several jurisdictions replaced it with a flat period of years. Others abolished it and now host trusts intended to run for centuries.",
);

/// Deep verification scores the user's own weights, so it must not inherit the
/// canary's budget: the reference pass streams a model that may be larger than
/// system memory off disk. It is never on the launch path, so the only job of
/// this limit is to stop a hung child from waiting forever.
const DEEP_PASS_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// The user's model has a real context; 512 tokens over two chunks is enough to
/// separate a working placement from a broken one, and keeps the pass bounded.
const DEEP_CTX: &str = "512";

const PROBE_CTX: &str = "256";
const PROBE_CHUNKS: &str = "2";

/// The canary is a small ordinary dense model, not the user's. Measurement
/// settled that this fault class corrupts a plain dense model under the same
/// placement, so a tiny one trips the same wire; using it keeps the check to
/// seconds and never loads the user's weights a second time.
pub struct Canary {
    pub id: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

pub const CANARY: Canary = Canary {
    id: "stories15M-q4_0",
    url: "https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories15M-q4_0.gguf",
    sha256: "66967fbece6dbe97886593fdbb73589584927e29119ec31f08090732d1861739",
    bytes: 19_077_344,
};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// The device placement agreed with the host within the measured band.
    Pass,
    /// The device placement disagreed: this runtime computes wrong results here.
    Fail,
    /// The check could not be completed, so correctness is unknown.
    Unsupported,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Record {
    pub verdict: Verdict,
    /// `Mean PPL(Q)/PPL(base)`; absent when the comparison never produced one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ratio: Option<f64>,
    pub detail: String,
    pub suite_version: u32,
    pub recorded_at: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    #[serde(default)]
    entries: BTreeMap<String, Record>,
    /// Verdicts from deep verification, which scores the user's own weights
    /// instead of the canary. Kept apart because they are keyed by model too
    /// and are far more expensive to produce.
    #[serde(default)]
    deep: BTreeMap<String, Record>,
    /// Keys the user chose to run anyway after seeing the evidence.
    #[serde(default)]
    overrides: Vec<String>,
}

fn cache_path() -> PathBuf {
    runtime::runtimes_root()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(runtime::runtimes_root)
        .join("verification.json")
}

fn load_cache() -> Cache {
    fs::read_to_string(cache_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_cache(cache: &Cache) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(cache) {
        let _ = fs::write(path, text);
    }
}

fn store(key: &str, record: Record) {
    let mut cache = load_cache();
    cache.entries.insert(key.to_string(), record);
    write_cache(&cache);
}

fn store_deep(key: &str, record: Record) {
    let mut cache = load_cache();
    cache.deep.insert(key.to_string(), record);
    write_cache(&cache);
}

/// The stored deep verdict for a combination, if one was ever produced.
pub fn deep_record(key: &str) -> Option<Record> {
    load_cache().deep.get(key).cloned()
}

/// Record that the user accepted the risk for exactly this combination.
///
/// It holds until something relevant changes, because every input that could
/// change the result is in the key: a different runtime build, GPU selection,
/// split, or machine produces a different key and is blocked again. An override
/// therefore cannot silently widen to cover a setup nobody agreed to.
pub fn allow_override(key: &str) -> Result<(), String> {
    if key.len() != 64 || !key.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err("that is not a verification override key".into());
    }
    let mut cache = load_cache();
    if !cache.overrides.iter().any(|item| item == key) {
        cache.overrides.push(key.to_string());
    }
    let path = cache_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(&cache).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| error.to_string())
}

/// Identify the weights without hashing them: a multi-gigabyte model cannot be
/// digested on every launch, but its path, size and modification time together
/// change whenever the file does.
fn model_identity(path: &str) -> String {
    let meta = fs::metadata(path).ok();
    let size = meta.as_ref().map(|value| value.len()).unwrap_or_default();
    let modified = meta
        .as_ref()
        .and_then(|value| value.modified().ok())
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or_default();
    format!("{path}|{size}|{modified}")
}

/// The key for a deep verdict. Same placement inputs as the canary key, plus
/// the weights themselves and the offload depth, because deep verification's
/// whole point is that those are what it exercised.
pub fn deep_key(
    cfg: &AppConfig,
    resolved: &ResolvedGpu,
    hardware_fingerprint: &str,
    runtime_devices: &[String],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"deep\0");
    hasher.update(cache_key(cfg, resolved, hardware_fingerprint, runtime_devices).as_bytes());
    hasher.update([0u8]);
    hasher.update(model_identity(&cfg.active_model).as_bytes());
    hasher.update([0u8]);
    hasher.update(cfg.ngl.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Everything that can change the numerical result. A value not represented
/// here would let a stale verdict cover a combination it never measured.
pub fn cache_key(
    cfg: &AppConfig,
    resolved: &ResolvedGpu,
    hardware_fingerprint: &str,
    runtime_devices: &[String],
) -> String {
    let mut hasher = Sha256::new();
    for part in [
        SUITE_VERSION.to_string().as_str(),
        CANARY.id,
        CANARY.sha256,
        cfg.active_backend.as_str(),
        cfg.active_build.as_str(),
        resolved.device_flag.as_deref().unwrap_or(""),
        resolved.split_mode.unwrap_or(""),
        &resolved
            .main_gpu_index
            .map(|index| index.to_string())
            .unwrap_or_default(),
        &resolved
            .tensor_split
            .iter()
            .map(f32::to_string)
            .collect::<Vec<_>>()
            .join(","),
        // Offload on or off changes which kernels run; the exact layer count
        // does not, and bucketing keeps a slider from invalidating the cache.
        if cfg.ngl > 0 { "offload" } else { "host" },
        hardware_fingerprint,
        // Driver or device-order changes show up in the runtime's own listing.
        &runtime_devices.join(";"),
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    format!("{:x}", hasher.finalize())
}

/// `Mean PPL(Q)/PPL(base)  :   1.604024 ±   0.213186`
fn parse_ratio(text: &str) -> Option<f64> {
    text.lines()
        .find(|line| line.trim_start().starts_with("Mean PPL(Q)/PPL(base)"))
        .and_then(|line| line.split(':').nth(1))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<f64>().ok())
}

/// `Median  KLD:   0.029481`
fn parse_median_kld(text: &str) -> Option<f64> {
    text.lines()
        .find(|line| line.trim_start().starts_with("Median") && line.contains("KLD:"))
        .and_then(|line| line.split(':').nth(1))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<f64>().ok())
}

/// `load_tensors:        ROCm1 model buffer size =    10.41 MiB`
///
/// A runtime is free to ignore a device it was offered. When it does, the
/// canary never crosses a device boundary and a pass would say nothing about
/// the path the user is about to run on, so the gate counts the devices that
/// actually received weights instead of trusting the request.
fn devices_holding_weights(text: &str) -> Vec<String> {
    let mut devices = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.split_once("load_tensors:") else {
            continue;
        };
        let mut tokens = rest.1.split_whitespace();
        let Some(device) = tokens.next() else {
            continue;
        };
        if !rest.1.contains("model buffer size") || device.starts_with("CPU") {
            continue;
        }
        let holds_bytes = line
            .split('=')
            .nth(1)
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<f64>().ok())
            .is_some_and(|size| size > 0.0);
        if holds_bytes && !devices.iter().any(|seen| seen == device) {
            devices.push(device.to_string());
        }
    }
    devices
}

/// `Final estimate: PPL = 35.2426 +/- 8.96873`
fn parse_final_ppl(text: &str) -> Option<f64> {
    text.lines()
        .find(|line| line.contains("Final estimate: PPL ="))
        .and_then(|line| line.split('=').nth(1))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<f64>().ok())
}

/// The divergence a placement must stay under. With no calibration pass this is
/// the fixed limit; with one it is the stricter of that limit and a multiple of
/// this machine's own measured single-device drift.
fn limit_for(calibration: Option<f64>) -> f64 {
    match calibration.filter(|value| value.is_finite() && *value >= 0.0) {
        Some(drift) => MAX_MEDIAN_KLD.min((drift * CALIBRATION_FACTOR).max(CALIBRATION_FLOOR)),
        None => MAX_MEDIAN_KLD,
    }
}

fn decide(median_kld: f64, ratio: f64, calibration: Option<f64>) -> Verdict {
    let diverged = !median_kld.is_finite() || median_kld > limit_for(calibration);
    let blown_up = !ratio.is_finite() || ratio > MAX_PERPLEXITY_RATIO;
    if diverged || blown_up {
        Verdict::Fail
    } else {
        Verdict::Pass
    }
}

fn reference_is_usable(ppl: f64) -> bool {
    ppl.is_finite()
        && ppl > 0.0
        && (REFERENCE_PPL_EXPECTED / REFERENCE_PPL_TOLERANCE
            ..=REFERENCE_PPL_EXPECTED * REFERENCE_PPL_TOLERANCE)
            .contains(&ppl)
}

/// True when the pending launch puts any work on an accelerator. A host-only
/// launch has nothing to compare: it *is* the reference path.
pub fn uses_accelerator(cfg: &AppConfig, resolved: &ResolvedGpu) -> bool {
    if cfg.ngl == 0 && !crate::tuning_defaults::inherited(cfg, "ngl") {
        return false;
    }
    if resolved.device_flag.as_deref() == Some("none") {
        return false;
    }
    !cfg.active_backend.is_empty() && cfg.active_backend != "cpu"
}

fn canary_dir() -> PathBuf {
    cache_path()
        .parent()
        .map(|parent| parent.join("verification"))
        .unwrap_or_else(|| PathBuf::from("verification"))
}

async fn ensure_canary() -> Result<PathBuf, String> {
    let path = canary_dir().join(format!("{}.gguf", CANARY.id));
    if path.is_file() && runtime::file_sha256(&path)? == CANARY.sha256 {
        return Ok(path);
    }
    fs::create_dir_all(canary_dir()).map_err(|error| error.to_string())?;
    runtime::download_verified(CANARY.url, &path, CANARY.sha256, CANARY.bytes).await?;
    Ok(path)
}

fn write_probe_text() -> Result<PathBuf, String> {
    let path = canary_dir().join("probe.txt");
    fs::create_dir_all(canary_dir()).map_err(|error| error.to_string())?;
    fs::write(&path, PROBE_TEXT).map_err(|error| error.to_string())?;
    Ok(path)
}

/// Both passes share every argument except device placement. `--fit off` is
/// required: with fitting enabled the tool aborts with `common_fit_params:
/// ... failed to fit params` before it ever scores anything.
fn common_args<'a>(model: &'a str, text: &'a str) -> Vec<&'a str> {
    vec![
        "--model",
        model,
        "--file",
        text,
        "--fit",
        "off",
        "-c",
        PROBE_CTX,
        "--chunks",
        PROBE_CHUNKS,
        "--seed",
        "1",
    ]
}

/// Verify that this runtime computes correct results with this exact device
/// placement on this machine, or explain why the launch is refused.
///
/// A cached pass costs a hash and a file read. A miss costs two short passes
/// over the canary — measured at 0.6s and 3.1s — and is paid once per
/// combination.
pub async fn ensure_verified(
    cfg: &AppConfig,
    resolved: &ResolvedGpu,
    hardware_fingerprint: &str,
    runtime_devices: &[String],
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    if !uses_accelerator(cfg, resolved) {
        return Ok(());
    }
    let key = cache_key(cfg, resolved, hardware_fingerprint, runtime_devices);
    let cache = load_cache();
    if cache.overrides.iter().any(|item| item == &key) {
        return Ok(());
    }
    // Deep verification, when it has been run, measured these exact weights on
    // this exact placement. It outranks the canary in both directions: its
    // failure is specific evidence the canary cannot produce, and it is the only
    // thing that can have covered an architecture the canary does not reach.
    let deep = deep_key(cfg, resolved, hardware_fingerprint, runtime_devices);
    if let Some(record) = cache.deep.get(&deep) {
        if record.verdict == Verdict::Fail {
            return Err(refusal(&deep, record));
        }
    }
    if let Some(record) = cache.entries.get(&key) {
        return match record.verdict {
            Verdict::Pass => Ok(()),
            _ => Err(refusal(&key, record)),
        };
    }
    let record = measure(cfg, resolved, cancel).await;
    store(&key, record.clone());
    match record.verdict {
        Verdict::Pass => Ok(()),
        _ => Err(refusal(&key, &record)),
    }
}

fn refusal(key: &str, record: &Record) -> String {
    let measured = record
        .ratio
        .map(|ratio| format!(" Measured perplexity ratio {ratio:.3} against a limit of {MAX_PERPLEXITY_RATIO:.0}; 1.0 means the device agrees with the host."))
        .unwrap_or_default();
    match record.verdict {
        Verdict::Fail => format!(
            "this runtime computed wrong results with the selected GPUs on this machine, so the server was not started.{measured} {} Select a different runtime build or GPU selection, or start it anyway with verification override key {key}.",
            record.detail
        ),
        _ => format!(
            "the selected GPUs could not be verified on this machine, so correctness is unknown and the server was not started. {} Retry, select a different runtime build or GPU selection, or start it anyway with verification override key {key}.",
            record.detail
        ),
    }
}

fn record(verdict: Verdict, ratio: Option<f64>, detail: impl Into<String>) -> Record {
    Record {
        verdict,
        ratio,
        detail: detail.into(),
        suite_version: SUITE_VERSION,
        recorded_at: chrono_now(),
    }
}

fn chrono_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_default()
}

async fn measure(
    cfg: &AppConfig,
    resolved: &ResolvedGpu,
    cancel: Option<&Arc<AtomicBool>>,
) -> Record {
    let binary = match runtime::perplexity_bin_for(&cfg.active_backend, &cfg.active_build) {
        Ok(path) if path.is_file() => path,
        Ok(path) => {
            return record(
                Verdict::Unsupported,
                None,
                format!("this runtime does not ship {}.", path.display()),
            )
        }
        Err(error) => return record(Verdict::Unsupported, None, error),
    };
    let model = match ensure_canary().await {
        Ok(path) => path,
        Err(error) => {
            return record(
                Verdict::Unsupported,
                None,
                format!("the verification model could not be prepared: {error}."),
            )
        }
    };
    let text = match write_probe_text() {
        Ok(path) => path,
        Err(error) => {
            return record(
                Verdict::Unsupported,
                None,
                format!("the verification text could not be written: {error}."),
            )
        }
    };
    let baseline = canary_dir().join("baseline.logits");
    let model_arg = model.to_string_lossy().into_owned();
    let text_arg = text.to_string_lossy().into_owned();
    let baseline_arg = baseline.to_string_lossy().into_owned();

    let mut reference = common_args(&model_arg, &text_arg);
    reference.extend_from_slice(&[
        "--device",
        "none",
        "-ngl",
        "0",
        "--save-all-logits",
        &baseline_arg,
    ]);
    let reference_output = runtime::run_runtime_tool(
        &binary,
        &cfg.active_backend,
        &cfg.active_build,
        &reference,
        PASS_TIMEOUT,
        cancel,
    )
    .await;
    let outcome = match reference_output {
        Err(error) => record(
            Verdict::Unsupported,
            None,
            format!("the host reference pass did not complete: {error}."),
        ),
        Ok(text) => match parse_final_ppl(&text) {
            Some(ppl) if reference_is_usable(ppl) => {
                candidate(&binary, cfg, resolved, &model_arg, &text_arg, &baseline_arg, cancel).await
            }
            Some(ppl) => record(
                Verdict::Unsupported,
                None,
                format!("this runtime's own host pass scored {ppl:.1} on weights that score {REFERENCE_PPL_EXPECTED:.1} on a working host path, so its host results cannot be trusted as the reference."),
            ),
            None => record(
                Verdict::Unsupported,
                None,
                "the host reference pass printed no perplexity.".to_string(),
            ),
        },
    };
    let _ = fs::remove_file(&baseline);
    outcome
}

async fn candidate(
    binary: &Path,
    cfg: &AppConfig,
    resolved: &ResolvedGpu,
    model: &str,
    text: &str,
    baseline: &str,
    cancel: Option<&Arc<AtomicBool>>,
) -> Record {
    let mut args = common_args(model, text);
    args.extend_from_slice(&["--kl-divergence", "--kl-divergence-base", baseline]);
    // Mirror the pending launch's placement exactly: the point is to exercise
    // the device path the user is about to run on, not a convenient one.
    let index;
    let split;
    if let Some(devices) = &resolved.device_flag {
        args.extend_from_slice(&["--device", devices]);
    }
    if let Some(mode) = resolved.split_mode {
        args.extend_from_slice(&["--split-mode", mode]);
    }
    if let Some(main) = resolved.main_gpu_index {
        index = main.to_string();
        args.extend_from_slice(&["--main-gpu", &index]);
    }
    if !resolved.tensor_split.is_empty() {
        split = resolved
            .tensor_split
            .iter()
            .map(f32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        args.extend_from_slice(&["--tensor-split", &split]);
    }
    // Raise verbosity so the load prints its per-device buffer sizes; without
    // them the pass cannot show that the canary reached the devices at all.
    args.extend_from_slice(&["-ngl", "99", "-lv", "5"]);
    let output = match runtime::run_runtime_tool(
        binary,
        &cfg.active_backend,
        &cfg.active_build,
        &args,
        PASS_TIMEOUT,
        cancel,
    )
    .await
    {
        Ok(output) => output,
        Err(error) => {
            return record(
                Verdict::Unsupported,
                None,
                format!("the device pass did not complete: {error}."),
            )
        }
    };
    let requested = resolved
        .device_flag
        .as_deref()
        .map(|devices| devices.split(',').filter(|name| !name.is_empty()).count())
        .unwrap_or(0);
    let reached = devices_holding_weights(&output);
    // For a placement that spans devices, measure what this machine's honest
    // host-to-device difference looks like on one device first, and judge the
    // spread against that rather than against a constant chosen elsewhere.
    let calibration = match resolved.device_flag.as_deref() {
        Some(devices) if requested > 1 => {
            calibrate(binary, cfg, model, text, baseline, devices, cancel).await
        }
        _ => None,
    };
    if requested > 1 && reached.len() < 2 {
        return record(
            Verdict::Unsupported,
            None,
            format!(
                "the runtime placed the verification model on {} instead of spreading it over the {requested} selected devices, so the cross-device path was never exercised.",
                if reached.is_empty() { "no device".to_string() } else { reached.join(", ") }
            ),
        );
    }
    let (Some(ratio), Some(median_kld)) = (parse_ratio(&output), parse_median_kld(&output)) else {
        return record(
            Verdict::Unsupported,
            None,
            "the device pass printed no divergence statistics.".to_string(),
        );
    };
    let limit = limit_for(calibration);
    record(
        decide(median_kld, ratio, calibration),
        Some(ratio),
        format!(
            "Median KL divergence {median_kld:.6} against a limit of {limit:.6}{}, measured against this runtime's own host pass over identical text on {}.",
            calibration
                .map(|drift| format!(" calibrated from this machine's single-device drift of {drift:.6}"))
                .unwrap_or_default(),
            if reached.is_empty() {
                "the selected devices".to_string()
            } else {
                reached.join(", ")
            }
        ),
    )
}

/// Score the user's own weights on their own placement, host against device.
///
/// This is the coverage the canary cannot give: the real architecture, the real
/// quantization, the real expert and attention kernels, at the real offload
/// depth. It is also far too slow for the launch path — the host reference
/// streams the whole model, which may be larger than system memory — so it is
/// never run automatically. A stored failure does block later launches of the
/// same combination, because by then the evidence is specific and definite.
///
/// Its sensitivity depends on how much of the model is actually on the device.
/// Measured against the 88 GiB model whose two-device placement is known to emit
/// garbage: at the configured full offload the device pass returned `nan`, which
/// fails outright, but at 20 of 48 layers it diverged only 0.0836 against a
/// healthy single-device 0.0204 — a factor of four, under the limit, a miss.
/// Most of that run was host arithmetic shared by both passes, which dilutes the
/// fault. Deep verification is therefore trustworthy for the placement it was
/// asked about and weak evidence about shallower ones.
pub async fn run_deep(
    cfg: &AppConfig,
    resolved: &ResolvedGpu,
    hardware_fingerprint: &str,
    runtime_devices: &[String],
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<Record, String> {
    if !uses_accelerator(cfg, resolved) {
        return Err("deep verification compares a device placement against the host, so there is nothing to compare for a host-only configuration".into());
    }
    if cfg.active_model.trim().is_empty() {
        return Err("select a model before running deep verification".into());
    }
    let binary = runtime::perplexity_bin_for(&cfg.active_backend, &cfg.active_build)?;
    if !binary.is_file() {
        return Err(format!("this runtime does not ship {}", binary.display()));
    }
    let text = write_probe_text()?;
    let baseline = canary_dir().join("deep-baseline.logits");
    let text_arg = text.to_string_lossy().into_owned();
    let baseline_arg = baseline.to_string_lossy().into_owned();
    let ngl = cfg.ngl.to_string();

    // Shared by both passes. The loader is left at its default so a model
    // larger than system memory can still stream for the host reference;
    // forcing it to read everything in would make the reference impossible on
    // exactly the machines that need this check most.
    let shared = |extra: &[&str]| -> Vec<String> {
        let mut args = vec![
            "--model".to_string(),
            cfg.active_model.clone(),
            "--file".to_string(),
            text_arg.clone(),
            "--fit".to_string(),
            "off".to_string(),
            "-c".to_string(),
            DEEP_CTX.to_string(),
            "--chunks".to_string(),
            PROBE_CHUNKS.to_string(),
            "--seed".to_string(),
            "1".to_string(),
        ];
        args.extend(extra.iter().map(|value| (*value).to_string()));
        args
    };

    let reference = shared(&[
        "--device",
        "none",
        "-ngl",
        "0",
        "--save-all-logits",
        &baseline_arg,
    ]);
    let reference_args = reference.iter().map(String::as_str).collect::<Vec<_>>();
    let reference_output = runtime::run_runtime_tool(
        &binary,
        &cfg.active_backend,
        &cfg.active_build,
        &reference_args,
        DEEP_PASS_TIMEOUT,
        cancel,
    )
    .await;
    let outcome = match reference_output {
        Err(error) => record(
            Verdict::Unsupported,
            None,
            format!("the host reference pass over this model did not complete: {error}."),
        ),
        Ok(output) => match parse_final_ppl(&output) {
            // The user's own weights have no pinned expected score, so only an
            // impossible one disqualifies the reference.
            Some(ppl) if ppl.is_finite() && ppl > 0.0 => {
                let mut device =
                    shared(&["--kl-divergence", "--kl-divergence-base", &baseline_arg]);
                device.extend(placement_args(resolved));
                device.extend([
                    "-ngl".to_string(),
                    ngl.clone(),
                    "-lv".to_string(),
                    "5".to_string(),
                ]);
                let device_args = device.iter().map(String::as_str).collect::<Vec<_>>();
                match runtime::run_runtime_tool(
                    &binary,
                    &cfg.active_backend,
                    &cfg.active_build,
                    &device_args,
                    DEEP_PASS_TIMEOUT,
                    cancel,
                )
                .await
                {
                    Err(error) => record(
                        Verdict::Unsupported,
                        None,
                        format!("the device pass over this model did not complete: {error}."),
                    ),
                    Ok(output) => deep_verdict(&output, resolved),
                }
            }
            Some(ppl) => record(
                Verdict::Unsupported,
                None,
                format!(
                    "the host reference pass scored {ppl}, which cannot be used as a reference."
                ),
            ),
            None => record(
                Verdict::Unsupported,
                None,
                "the host reference pass printed no perplexity.".to_string(),
            ),
        },
    };
    let _ = fs::remove_file(&baseline);
    let key = deep_key(cfg, resolved, hardware_fingerprint, runtime_devices);
    store_deep(&key, outcome.clone());
    Ok(outcome)
}

fn deep_verdict(output: &str, resolved: &ResolvedGpu) -> Record {
    let reached = devices_holding_weights(output);
    let requested = resolved
        .device_flag
        .as_deref()
        .map(|devices| devices.split(',').filter(|name| !name.is_empty()).count())
        .unwrap_or(0);
    if requested > 1 && reached.len() < 2 {
        return record(
            Verdict::Unsupported,
            None,
            format!(
                "the runtime placed this model on {} instead of spreading it over the {requested} selected devices, so the cross-device path was never exercised.",
                if reached.is_empty() { "no device".to_string() } else { reached.join(", ") }
            ),
        );
    }
    let (Some(ratio), Some(median_kld)) = (parse_ratio(output), parse_median_kld(output)) else {
        return record(
            Verdict::Unsupported,
            None,
            "the device pass printed no divergence statistics.".to_string(),
        );
    };
    // No calibration pass here: a second full pass over the real weights would
    // double an already long job, and the fixed ceiling is what the canary's
    // own uncalibrated limit uses.
    record(
        decide(median_kld, ratio, None),
        Some(ratio),
        format!(
            "Deep verification of these weights: median KL divergence {median_kld:.6} against a limit of {MAX_MEDIAN_KLD}, measured against the host over identical text on {}.",
            if reached.is_empty() { "the selected devices".to_string() } else { reached.join(", ") }
        ),
    )
}

/// The placement flags both gates mirror from the pending launch.
fn placement_args(resolved: &ResolvedGpu) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(devices) = &resolved.device_flag {
        args.extend(["--device".to_string(), devices.clone()]);
    }
    if let Some(mode) = resolved.split_mode {
        args.extend(["--split-mode".to_string(), mode.to_string()]);
    }
    if let Some(main) = resolved.main_gpu_index {
        args.extend(["--main-gpu".to_string(), main.to_string()]);
    }
    if !resolved.tensor_split.is_empty() {
        args.extend([
            "--tensor-split".to_string(),
            resolved
                .tensor_split
                .iter()
                .map(f32::to_string)
                .collect::<Vec<_>>()
                .join(","),
        ]);
    }
    args
}

/// Measure this machine's honest host-to-device difference on the first
/// selected device. A failure here is not a verdict: it only means the spread
/// has to be judged against the fixed limit instead.
async fn calibrate(
    binary: &Path,
    cfg: &AppConfig,
    model: &str,
    text: &str,
    baseline: &str,
    devices: &str,
    cancel: Option<&Arc<AtomicBool>>,
) -> Option<f64> {
    let single = devices.split(',').find(|name| !name.is_empty())?;
    let mut args = common_args(model, text);
    args.extend_from_slice(&[
        "--kl-divergence",
        "--kl-divergence-base",
        baseline,
        "--device",
        single,
        "-ngl",
        "99",
    ]);
    let output = runtime::run_runtime_tool(
        binary,
        &cfg.active_backend,
        &cfg.active_build,
        &args,
        PASS_TIMEOUT,
        cancel,
    )
    .await
    .ok()?;
    parse_median_kld(&output).filter(|value| value.is_finite() && *value >= 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SplitMode;

    fn placement(devices: &str) -> ResolvedGpu {
        ResolvedGpu {
            device_flag: Some(devices.into()),
            ..ResolvedGpu::default()
        }
    }

    #[test]
    fn reads_the_statistics_and_reference_score_from_real_tool_output() {
        // Verbatim from llama-perplexity b11026.
        let output = "====== Perplexity statistics ======\nMean PPL(Q)                   :  45.910556 ±  11.862727\nMean PPL(base)                :  28.622108 ±   6.505030\nMean PPL(Q)/PPL(base)         :   1.604024 ±   0.213186\n\n====== KL divergence statistics ======\nMean    KLD:   1.083187 ±   0.125368\nMedian  KLD:   0.029481\n";
        assert_eq!(parse_ratio(output), Some(1.604024));
        assert_eq!(parse_median_kld(output), Some(0.029481));
        assert_eq!(parse_ratio("nothing to see"), None);
        assert_eq!(parse_median_kld("nothing to see"), None);
        assert_eq!(
            parse_final_ppl("Final estimate: PPL = 35.2426 +/- 8.96873"),
            Some(35.2426)
        );
        assert_eq!(parse_final_ppl("no estimate here"), None);
    }

    #[test]
    fn the_canary_verdict_follows_divergence_not_the_perplexity_ratio() {
        // Measured on the canary: one ROCm device, then two Vulkan devices.
        for healthy in [0.001908, 0.001867] {
            assert_eq!(decide(healthy, 0.99, None), Verdict::Pass, "{healthy}");
        }
        // The two-device ROCm placement already proven to produce wrong text.
        // Its perplexity ratio alone is only 2.687, which the ratio limit of 10
        // would wave through, so the median divergence has to be what decides.
        assert_eq!(decide(0.666306, 2.493472, None), Verdict::Fail);
        assert_eq!(decide(0.001908, 2.493472, None), Verdict::Pass);
        // The large-model blow-up trips either criterion on its own.
        assert_eq!(decide(21.082850, 230_173_867.0, None), Verdict::Fail);
        assert_eq!(decide(0.001, 230_173_867.0, None), Verdict::Fail);
        for broken in [f64::NAN, f64::INFINITY] {
            assert_eq!(decide(broken, 0.99, None), Verdict::Fail);
            assert_eq!(decide(0.001, broken, None), Verdict::Fail);
        }
    }

    #[test]
    fn calibration_tightens_the_limit_without_ever_loosening_it() {
        // This machine's measured single-device drift.
        let drift = Some(0.001908);
        // 20x of it is well under the fixed limit, so calibration tightens.
        assert!(limit_for(drift) < MAX_MEDIAN_KLD);
        // The healthy two-device placement still passes the tighter limit,
        // and the corrupted one fails it by a wide margin.
        assert_eq!(decide(0.001867, 0.99, drift), Verdict::Pass);
        assert_eq!(decide(0.666306, 2.493472, drift), Verdict::Fail);
        // A machine that drifts more is judged more leniently, but never past
        // the fixed ceiling, and a degenerate calibration cannot disable it.
        assert!(limit_for(Some(1.0)) <= MAX_MEDIAN_KLD);
        assert_eq!(limit_for(Some(0.0)), CALIBRATION_FLOOR);
        assert_eq!(limit_for(Some(f64::NAN)), MAX_MEDIAN_KLD);
        assert_eq!(limit_for(None), MAX_MEDIAN_KLD);
    }

    #[test]
    fn a_deep_verdict_is_tied_to_the_weights_it_actually_measured() {
        let cfg = AppConfig {
            active_backend: "rocm".into(),
            active_build: "b11026".into(),
            active_model: "models/a.gguf".into(),
            ngl: 99,
            ..Default::default()
        };
        let devices = vec!["ROCm0: AMD Radeon AI PRO R9700 (32624 MiB)".to_string()];
        let placement = placement("ROCm0,ROCm1");
        let base = deep_key(&cfg, &placement, "fingerprint", &devices);

        // A deep verdict must never be confused with the canary verdict.
        assert_ne!(base, cache_key(&cfg, &placement, "fingerprint", &devices));
        // Different weights are a different measurement...
        let mut other_model = cfg.clone();
        other_model.active_model = "models/b.gguf".into();
        assert_ne!(
            base,
            deep_key(&other_model, &placement, "fingerprint", &devices)
        );
        // ...and so is a different offload depth, which the canary key buckets.
        let mut shallower = cfg.clone();
        shallower.ngl = 20;
        assert_ne!(
            base,
            deep_key(&shallower, &placement, "fingerprint", &devices)
        );
        assert_eq!(
            cache_key(&cfg, &placement, "fingerprint", &devices),
            cache_key(&shallower, &placement, "fingerprint", &devices)
        );
        assert_eq!(base, deep_key(&cfg, &placement, "fingerprint", &devices));
    }

    #[test]
    fn the_deep_pass_mirrors_the_placement_it_is_asked_to_verify() {
        let mut placement = placement("ROCm0,ROCm1");
        placement.split_mode = SplitMode::Row.as_flag_value();
        placement.main_gpu_index = Some(1);
        placement.tensor_split = vec![3.0, 1.0];
        let args = placement_args(&placement);
        for expected in [
            ["--device", "ROCm0,ROCm1"],
            ["--split-mode", "row"],
            ["--main-gpu", "1"],
            ["--tensor-split", "3,1"],
        ] {
            let at = args
                .iter()
                .position(|arg| arg == expected[0])
                .unwrap_or_else(|| panic!("{} missing", expected[0]));
            assert_eq!(args[at + 1], expected[1]);
        }
        assert!(placement_args(&ResolvedGpu::default()).is_empty());
    }

    #[test]
    fn an_override_only_accepts_a_key_this_gate_could_have_printed() {
        // The refusal prints a 64-character hex key. Anything else is a typo or
        // a guess, and silently storing it would leave the user believing they
        // had unblocked a launch that is still going to be refused.
        let key = cache_key(
            &AppConfig {
                active_backend: "rocm".into(),
                active_build: "b11026".into(),
                ngl: 99,
                ..Default::default()
            },
            &placement("ROCm0,ROCm1"),
            "fingerprint",
            &[],
        );
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|value| value.is_ascii_hexdigit()));
        for rejected in ["", "yes", &key[..63], &format!("{key}0"), &"z".repeat(64)] {
            assert!(
                allow_override(rejected).is_err(),
                "{rejected} is not a key this gate prints"
            );
        }
    }

    #[test]
    fn a_runtime_whose_own_host_pass_is_wrong_cannot_be_the_oracle() {
        // Both builds measured scored exactly this on the pinned canary.
        assert!(reference_is_usable(REFERENCE_PPL_EXPECTED));
        // Ample room for another CPU's arithmetic.
        assert!(reference_is_usable(REFERENCE_PPL_EXPECTED * 1.5));
        assert!(reference_is_usable(REFERENCE_PPL_EXPECTED / 1.5));
        // A host path that is actually broken lands nowhere near it.
        assert!(!reference_is_usable(153_092.3));
        assert!(!reference_is_usable(3661.8301));
        assert!(!reference_is_usable(12.0));
        assert!(!reference_is_usable(f64::NAN));
        assert!(!reference_is_usable(0.0));
    }

    #[test]
    fn counts_only_the_devices_that_actually_received_weights() {
        // Verbatim from a two-device load at -lv 5.
        let output = "0.00.669 I load_tensors:   CPU_Mapped model buffer size =     4.94 MiB\n0.00.669 I load_tensors:      Vulkan0 model buffer size =     2.14 MiB\n0.00.669 I load_tensors:      Vulkan1 model buffer size =    10.41 MiB\n";
        assert_eq!(devices_holding_weights(output), vec!["Vulkan0", "Vulkan1"]);
        // A runtime that ignored the second device must not look verified.
        let single = "0.00.669 I load_tensors:      ROCm0 model buffer size =    12.55 MiB\n";
        assert_eq!(devices_holding_weights(single), vec!["ROCm0"]);
        assert!(devices_holding_weights("no load lines here").is_empty());
    }

    #[test]
    fn the_key_separates_every_value_that_changes_the_computation() {
        let cfg = AppConfig {
            active_backend: "rocm".into(),
            active_build: "b11026".into(),
            ngl: 99,
            ..Default::default()
        };
        let devices = vec!["ROCm0: AMD Radeon AI PRO R9700 (32624 MiB)".to_string()];
        let base = cache_key(&cfg, &placement("ROCm0,ROCm1"), "fingerprint", &devices);

        // A different GPU selection is a different measurement.
        assert_ne!(
            base,
            cache_key(&cfg, &placement("ROCm0"), "fingerprint", &devices)
        );
        // So is a different machine, runtime build, or device listing.
        assert_ne!(
            base,
            cache_key(&cfg, &placement("ROCm0,ROCm1"), "other", &devices)
        );
        let mut newer = cfg.clone();
        newer.active_build = "b11028".into();
        assert_ne!(
            base,
            cache_key(&newer, &placement("ROCm0,ROCm1"), "fingerprint", &devices)
        );
        assert_ne!(
            base,
            cache_key(&cfg, &placement("ROCm0,ROCm1"), "fingerprint", &[])
        );
        // And so is a split that moves tensors differently.
        let mut split = placement("ROCm0,ROCm1");
        split.split_mode = SplitMode::Row.as_flag_value();
        assert_ne!(base, cache_key(&cfg, &split, "fingerprint", &devices));
        let mut ratios = placement("ROCm0,ROCm1");
        ratios.tensor_split = vec![3.0, 1.0];
        assert_ne!(base, cache_key(&cfg, &ratios, "fingerprint", &devices));
        // Repeating the same inputs must reuse the same verdict.
        assert_eq!(
            base,
            cache_key(&cfg, &placement("ROCm0,ROCm1"), "fingerprint", &devices)
        );
    }

    #[test]
    fn host_only_launches_have_nothing_to_compare() {
        let mut cfg = AppConfig {
            active_backend: "rocm".into(),
            active_build: "b11026".into(),
            ngl: 99,
            ..Default::default()
        };
        assert!(uses_accelerator(&cfg, &placement("ROCm0")));
        assert!(!uses_accelerator(&cfg, &placement("none")));
        cfg.ngl = 0;
        assert!(!uses_accelerator(&cfg, &placement("ROCm0")));
        cfg.ngl = 99;
        cfg.active_backend = "cpu".into();
        assert!(!uses_accelerator(&cfg, &ResolvedGpu::default()));
    }

    #[test]
    fn both_passes_disable_fitting_because_the_tool_aborts_otherwise() {
        let args = common_args("model.gguf", "probe.txt");
        let fit = args
            .iter()
            .position(|arg| *arg == "--fit")
            .expect("fit flag");
        assert_eq!(args.get(fit + 1), Some(&"off"));
    }
}
