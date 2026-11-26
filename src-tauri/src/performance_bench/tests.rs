use super::*;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener as AsyncListener,
};

/// The workload the desktop app sends: 128 tokens, one sample per point.
fn desktop_request() -> PerformanceBenchRequest {
    PerformanceBenchRequest {
        method: Default::default(),
        max_output_tokens: DESKTOP_OUTPUT_TOKENS,
        repetitions: 1,
        ..request()
    }
}

fn request() -> PerformanceBenchRequest {
    PerformanceBenchRequest {
        run_id: "serving-journal".into(),
        method: ServingMethod {
            id: "openai-chat-serving".into(),
            version: 5,
        },
        context_profile: "novel_ko".into(),
        prompt_bytes: vec![256],
        max_output_tokens: 128,
        concurrencies: vec![2],
        repetitions: 3,
        warmup: false,
        request_usage: false,
    }
}

#[tokio::test]
async fn command_rejects_operation_gate_and_invalid_request_with_source_kinds() {
    let state = crate::state::AppState::default();
    let progress: Progress = Arc::new(|_| {});
    let operation = state.operation.try_lock().unwrap();
    let busy = crate::commands::benchmark::run_performance_bench_with_progress(
        &state,
        AppConfig::default(),
        request(),
        progress.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        busy,
        AppError::busy("another server or benchmark operation is in progress")
    );
    drop(operation);
    let mut invalid = request();
    invalid.run_id.clear();
    let validation = crate::commands::benchmark::run_performance_bench_with_progress(
        &state,
        AppConfig::default(),
        invalid,
        progress,
    )
    .await
    .unwrap_err();
    assert_eq!(
        validation,
        AppError::validation("benchmark run_id must contain 1 to 128 bytes")
    );
}

#[test]
fn byte_inputs_are_exact_utf8_and_hash_the_final_user_content() {
    for profile in [
        "code_python",
        "code_mixed",
        "novel_ko",
        "novel_en",
        "novel_ja",
    ] {
        let mut request = request();
        request.context_profile = profile.into();
        request.prompt_bytes = (256..320).collect();
        request.concurrencies = vec![1];
        validate_request(&mut request).unwrap();
        let (workload, bases) = prepare_inputs(&request);
        let nonce = workload.prompt_nonce.as_ref().unwrap();
        for ((input, base), size) in workload.inputs.iter().zip(&bases).zip(256..320) {
            let text = corpus::cold_text(base, nonce, (input.bytes, 1, 1), 0);
            assert_eq!(text.len(), size);
            assert!(text[corpus::COLD_PREFIX_BYTES..]
                .starts_with("Continue the following text. Do not summarize or explain.\n\n"));
            assert_eq!(input.bytes as usize, size);
            assert_eq!(
                input.sha256,
                format!("{:x}", Sha256::digest(text.as_bytes()))
            );
        }
    }
    let mut request = request();
    request.warmup = false;
    validate_request(&mut request).unwrap();
    assert!(!request.warmup);
    request.prompt_bytes = vec![256, 256];
    assert!(validate_request(&mut request).is_err());
}

#[test]
fn cold_prompt_inputs_are_exact_unique_slot_prompts_with_first_point_descriptors() {
    let mut request = PerformanceBenchRequest {
        method: Default::default(),
        context_profile: "novel_ja".into(),
        prompt_bytes: vec![257, 4096],
        concurrencies: vec![4, 2],
        repetitions: 2,
        ..request()
    };
    validate_execution_request(&mut request).unwrap();
    let (workload, bases) = prepare_inputs(&request);
    let nonce = workload.prompt_nonce.clone().unwrap();
    assert_eq!(nonce.len(), 32);
    assert!(nonce
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_eq!(
        (workload.corpus_version, workload.cache_policy.as_str()),
        (2, "cold_prompt")
    );
    let mut seen = std::collections::HashSet::new();
    for (input, base) in workload.inputs.iter().zip(&bases) {
        for concurrency in [2, 4] {
            for repetition in [1, 2] {
                for slot in 0..concurrency {
                    let point = (input.bytes, concurrency, repetition);
                    let text = corpus::cold_text(base, &nonce, point, slot as usize);
                    assert_eq!(text.len(), input.bytes as usize);
                    let identity =
                        format!("{nonce}:{}:{concurrency}:{repetition}:{slot}", input.bytes);
                    let prefix = format!(
                        "{}{:x}\n",
                        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
                            .as_bytes()[slot as usize] as char,
                        Sha256::digest(identity.as_bytes())
                    );
                    assert!(text.starts_with(&prefix));
                    let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
                    if (concurrency, repetition, slot) == (2, 1, 0) {
                        assert_eq!(input.sha256, digest);
                    }
                    assert!(seen.insert(digest), "every dispatched prompt is distinct");
                }
            }
        }
    }
    let (again, _) = prepare_inputs(&request);
    assert_ne!(
        again.prompt_nonce.unwrap(),
        nonce,
        "each run gets a fresh nonce"
    );
}

#[test]
fn serving_accepts_only_the_current_method_and_caps_between_one_and_128_tokens() {
    assert_eq!(ServingMethod::default().version, 5);
    for target in [1, 128] {
        for request_usage in [false, true] {
            let mut valid = PerformanceBenchRequest {
                max_output_tokens: target,
                request_usage,
                ..request()
            };
            validate_execution_request(&mut valid).unwrap();
        }
    }
    for target in [0, 129] {
        let mut invalid = PerformanceBenchRequest {
            max_output_tokens: target,
            ..request()
        };
        assert!(validate_request(&mut invalid).is_err());
    }
    let mut unsupported = request();
    unsupported.method.version = 4;
    assert!(validate_request(&mut unsupported).is_err());
    let mut warmup = PerformanceBenchRequest {
        warmup: true,
        ..request()
    };
    assert!(validate_request(&mut warmup).is_err());
    validate_desktop_request(&mut PerformanceBenchRequest {
        request_usage: true,
        ..desktop_request()
    })
    .unwrap();
}

#[test]
fn desktop_runs_only_the_128_token_single_sample_workload_up_to_8_concurrent_requests() {
    validate_desktop_request(&mut PerformanceBenchRequest {
        concurrencies: vec![1, 2, 4, 8],
        ..desktop_request()
    })
    .unwrap();
    for invalid in [
        PerformanceBenchRequest {
            max_output_tokens: 64,
            ..desktop_request()
        },
        PerformanceBenchRequest {
            repetitions: 2,
            ..desktop_request()
        },
        PerformanceBenchRequest {
            concurrencies: vec![8, 16],
            ..desktop_request()
        },
    ] {
        let mut request = invalid;
        // Each stays a valid recorded workload under the shared contract.
        validate_execution_request(&mut request.clone()).unwrap();
        assert!(validate_desktop_request(&mut request).is_err());
    }
}

struct Reply {
    status: u16,
    data: String,
    delay: Duration,
    stall: bool,
}
impl Reply {
    /// A normal stream with optional engine-reported completion usage.
    fn streamed(count: usize, reported: Value) -> Self {
        let mut data = String::new();
        let mut left = count;
        while left > 0 {
            let piece = left.min(4096);
            data.push_str(&format!(
                "data: {}\n\n",
                json!({"choices":[{"delta":{"content":"x".repeat(piece)}}]})
            ));
            left -= piece;
        }
        data.push_str(&format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{},"finish_reason":"length"}]})
        ));
        if !reported.is_null() {
            data.push_str(&format!(
                "data: {}\n\n",
                json!({"choices":[],"usage":{"completion_tokens":reported}})
            ));
        }
        data.push_str("data: [DONE]\n\n");
        Self {
            status: 200,
            data,
            delay: Duration::ZERO,
            stall: false,
        }
    }

    fn done(usage: Value, reason: Option<&str>) -> Self {
        let content = json!({"choices":[{"delta":{"reasoning_content":"생각","content":"눈길"},"finish_reason":reason}]});
        let usage = if usage.is_null() {
            String::new()
        } else {
            format!("data: {}\n\n", json!({"choices":[],"usage":usage}))
        };
        Self {
            status: 200,
            data: format!("data: {content}\n\n{usage}data: [DONE]\n\n"),
            delay: Duration::ZERO,
            stall: false,
        }
    }

    fn rejected(status: u16) -> Self {
        Self {
            status,
            data: String::new(),
            delay: Duration::from_millis(150),
            stall: false,
        }
    }
}
struct HttpOwner {
    worker: tokio::task::JoinHandle<()>,
    receipts: Arc<Mutex<Vec<Value>>>,
    arrived: Arc<tokio::sync::Notify>,
}
impl Drop for HttpOwner {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

fn chat_engine() -> EngineInfo {
    let mut engine = EngineInfo::llama(
        "selected-model",
        crate::providers::artifacts::Modalities::text_only(),
    );
    engine.stream_usage_supported = Some(true);
    engine
}

async fn fixture(replies: Vec<Reply>) -> (reqwest::Client, reqwest::Request, HttpOwner) {
    fixture_for(replies, &request()).await
}

async fn fixture_for(
    replies: Vec<Reply>,
    bench: &PerformanceBenchRequest,
) -> (reqwest::Client, reqwest::Request, HttpOwner) {
    let listener = AsyncListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let captured = receipts.clone();
    let arrived = Arc::new(tokio::sync::Notify::new());
    let notice = arrived.clone();
    let worker = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        for reply in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let captured = captured.clone();
            let notice = notice.clone();
            handlers.spawn(async move {
                let mut bytes = Vec::new();
                let (end,length) = loop {
                    if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = std::str::from_utf8(&bytes[..index]).unwrap();
                        let length: usize = headers.lines().skip(1).filter_map(|line| line.split_once(':'))
                            .find(|(name,_)| name.eq_ignore_ascii_case("content-length")).unwrap().1.trim().parse().unwrap();
                        break (index+4,length);
                    }
                    let mut buffer = [0;4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0 && bytes.len() + count < 2 * 1024 * 1024);
                    bytes.extend_from_slice(&buffer[..count]);
                };
                while bytes.len() < end+length {
                    let mut buffer = [0;4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                }
                captured.lock().unwrap().push(json!({"line":std::str::from_utf8(&bytes[..end]).unwrap().lines().next(),
                    "body":serde_json::from_slice::<Value>(&bytes[end..end+length]).unwrap()}));
                tokio::time::sleep(reply.delay).await;
                socket.write_all(format!("HTTP/1.1 {} Fixture\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n", reply.status).as_bytes()).await.unwrap();
                let _ = socket.write_all(reply.data.as_bytes()).await;
                notice.notify_one();
                if reply.stall {
                    let mut byte = [0];
                    let _ = socket.read(&mut byte).await;
                }
            });
        }
        while let Some(joined) = handlers.join_next().await {
            joined.unwrap();
        }
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut engine = chat_engine();
    // Saved sampling defaults must not enter a common benchmark request.
    engine.request_fields.insert("top_k".into(), json!(7));
    let request = point_request(
        &client,
        &url,
        "synthetic-key",
        &engine,
        corpus::text("novel_ko", 256),
        bench,
    )
    .unwrap();
    (
        client,
        request,
        HttpOwner {
            worker,
            receipts,
            arrived,
        },
    )
}

fn result(request: &PerformanceBenchRequest) -> PerformanceBenchResult {
    let cfg = AppConfig::default();
    let (workload, _) = prepare_inputs(request);
    let model =
        serde_json::from_value(json!({"status":"unidentified","sha256":null,"size_bytes":null}))
            .unwrap();
    let profile = serde_json::from_value(json!({"schema_version":1,"os":"synthetic","arch":"synthetic",
        "cpu":{"name":"synthetic","logical_cores":1},"gpus":[],"detection":"synthetic","fingerprint":"synthetic"})).unwrap();
    let mut result = failed(request, &cfg, "pending".into());
    result.provenance = Some(crate::benchmark::provenance::capture_serving(
        &cfg,
        &profile,
        model,
        workload,
        None,
        "Synthetic model".into(),
    ));
    result.provenance.as_mut().unwrap().method.version = request.method.version;
    result
}

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[allow(clippy::type_complexity)]
fn journaled(
    request: &PerformanceBenchRequest,
) -> (
    Directory,
    PerformanceBenchResult,
    Arc<crate::benchmark::store::RunJournal>,
    Checkpoint,
    Arc<Mutex<Vec<PerformanceBenchRow>>>,
    Progress,
) {
    let root = std::env::temp_dir().join(format!("aiolm-serving-journal-{}", uuid::Uuid::new_v4()));
    let result = result(request);
    let journal = Arc::new(
        crate::benchmark::store::RunJournal::begin(
            &root,
            json!({
                "schemaVersion":3,"id":request.run_id,"createdAt":1,"model":"synthetic.model",
                "request":request,"result":result
            }),
        )
        .unwrap(),
    );
    let saved = journal.clone();
    let checkpoint: Checkpoint = Arc::new(move |result| saved.checkpoint(result));
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let progress: Progress = Arc::new(move |event| {
        if let Some(row) = event.row {
            captured.lock().unwrap().push(row);
        }
    });
    (
        Directory(root),
        result,
        journal,
        checkpoint,
        events,
        progress,
    )
}

fn buffered_workload(
    request: &PerformanceBenchRequest,
    buffered: &reqwest::Request,
    result: &PerformanceBenchResult,
    point: (u32, u32, u32),
) -> BufferedWorkload {
    let provenance = result.provenance.as_ref().unwrap();
    let nonce = provenance.workload.prompt_nonce.as_ref().unwrap();
    let base = corpus::text(
        &request.context_profile,
        point.0 as usize - corpus::COLD_PREFIX_BYTES,
    );
    let mut hashes = Vec::with_capacity(point.1 as usize);
    let slots = (0..point.1)
        .map(|slot| {
            let text = corpus::cold_text(&base, nonce, point, slot as usize);
            hashes.push(format!("{:x}", Sha256::digest(text.as_bytes())));
            let mut slot = buffered.try_clone().unwrap();
            let mut body: Value =
                serde_json::from_slice(slot.body().unwrap().as_bytes().unwrap()).unwrap();
            body["messages"][0]["content"] = json!(text);
            *slot.body_mut() = Some(serde_json::to_vec(&body).unwrap().into());
            slot
        })
        .collect();
    BufferedWorkload {
        request: request.clone(),
        slots,
        input_hashes: Some(hashes),
        usage_undecided: request.request_usage,
    }
}

#[tokio::test]
async fn first_actual_batch_negotiates_usage_without_discarding_accepted_measurements() {
    for (reports, status, completion) in [
        (
            vec![
                json!({"completion_tokens":2}),
                json!({"completion_tokens":3}),
            ],
            "partial",
            Some(5),
        ),
        (vec![Value::Null, Value::Null], "missing", None),
        (
            vec![json!({"completion_tokens":-1}), Value::Null],
            "invalid",
            None,
        ),
    ] {
        let request = PerformanceBenchRequest {
            request_usage: true,
            repetitions: 1,
            ..request()
        };
        let (directory, mut result, journal, checkpoint, events, progress) = journaled(&request);
        let (client, buffered, owner) = fixture_for(
            reports
                .into_iter()
                .map(|usage| Reply::done(usage, Some("stop")))
                .collect(),
            &request,
        )
        .await;
        let mut workload = buffered_workload(&request, &buffered, &result, (256, 2, 1));
        trial(
            &mut workload,
            &client,
            (256, 2, 1),
            0,
            None,
            ServingMemoryScope::Unavailable,
            &AtomicBool::new(false),
            &mut result,
            Some(&checkpoint),
            &progress,
        )
        .await
        .unwrap();
        assert_eq!(
            owner.receipts.lock().unwrap().len(),
            2,
            "no preflight inference with warmup off"
        );
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].output_bytes, 24);
        assert_eq!(result.rows[0].usage_status, status);
        assert_eq!(result.rows[0].reported_completion_tokens, completion);
        assert!(result.provenance.as_ref().unwrap().workload.request_usage);
        assert!(!workload.usage_undecided);
        assert_eq!(events.lock().unwrap().len(), 1);
        result.status = "complete";
        journal.finish(&result).unwrap();
        drop(checkpoint);
        drop(journal);
        let page = crate::benchmark::store::list(&directory.0, 0, 10).unwrap();
        assert!(page.warnings.is_empty(), "{:?}", page.warnings);
        assert_eq!(
            page.records[0]["result"]["rows"].as_array().unwrap().len(),
            1
        );
    }
}

#[tokio::test]
async fn entirely_rejected_first_batch_checkpoints_usage_off_before_resend() {
    for status in [400, 422] {
        let request = PerformanceBenchRequest {
            request_usage: true,
            repetitions: 1,
            ..request()
        };
        let (directory, mut result, journal, saved, events, progress) = journaled(&request);
        let (client, buffered, owner) = fixture_for(
            vec![
                Reply::rejected(status),
                Reply::rejected(status),
                Reply::done(Value::Null, Some("stop")),
                Reply::done(Value::Null, Some("stop")),
            ],
            &request,
        )
        .await;
        let receipts = owner.receipts.clone();
        let downgraded_at = Arc::new(Mutex::new(None));
        let observed_downgrade = downgraded_at.clone();
        let checkpoint: Checkpoint = Arc::new(move |result| {
            if result.rows.is_empty() {
                assert_eq!(
                    receipts.lock().unwrap().len(),
                    2,
                    "checkpoint precedes resend"
                );
                let provenance = result.provenance.as_ref().unwrap();
                assert!(!provenance.workload.request_usage);
                assert!(provenance
                    .execution
                    .settings
                    .iter()
                    .all(|setting| setting.name != "stream_options.include_usage"));
                *observed_downgrade.lock().unwrap() = Some(Instant::now());
            }
            saved(result)
        });
        let mut workload = buffered_workload(&request, &buffered, &result, (256, 2, 1));
        trial(
            &mut workload,
            &client,
            (256, 2, 1),
            0,
            None,
            ServingMemoryScope::Unavailable,
            &AtomicBool::new(false),
            &mut result,
            Some(&checkpoint),
            &progress,
        )
        .await
        .unwrap();
        let receipts = owner.receipts.lock().unwrap();
        assert_eq!(receipts.len(), 4);
        assert!(receipts[..2]
            .iter()
            .all(|receipt| receipt["body"]["stream_options"]["include_usage"] == true));
        assert!(receipts[2..]
            .iter()
            .all(|receipt| receipt["body"].get("stream_options").is_none()));
        let mut first: Vec<_> = receipts[..2]
            .iter()
            .map(|receipt| receipt["body"]["messages"][0]["content"].as_str().unwrap())
            .collect();
        let mut retried: Vec<_> = receipts[2..]
            .iter()
            .map(|receipt| receipt["body"]["messages"][0]["content"].as_str().unwrap())
            .collect();
        first.sort_unstable();
        retried.sort_unstable();
        assert_eq!(first, retried, "negotiation resends the same slot prompts");
        assert_ne!(first[0], first[1]);
        assert!(first.iter().all(|text| text.len() == 256));
        let since_downgrade = downgraded_at
            .lock()
            .unwrap()
            .unwrap()
            .elapsed()
            .as_secs_f64()
            * 1000.0;
        assert!(
            result.rows[0].e2e_ms <= since_downgrade,
            "rejected latency is not measured"
        );
        assert_eq!(result.rows[0].usage_status, "missing");
        assert_eq!(events.lock().unwrap().len(), 1);
        result.status = "complete";
        journal.finish(&result).unwrap();
        drop(checkpoint);
        drop(journal);
        let page = crate::benchmark::store::list(&directory.0, 0, 10).unwrap();
        assert!(page.warnings.is_empty(), "{:?}", page.warnings);
        assert_eq!(page.records[0]["request"]["request_usage"], true);
        assert_eq!(
            page.records[0]["result"]["provenance"]["workload"]["request_usage"],
            false
        );
    }
}

#[tokio::test]
async fn mixed_first_batch_and_later_usage_rejections_never_replay_or_record_failed_rows() {
    for accepted_first in [false, true] {
        let request = PerformanceBenchRequest {
            request_usage: true,
            ..request()
        };
        let (directory, mut result, journal, checkpoint, events, progress) = journaled(&request);
        let mut replies = Vec::new();
        if accepted_first {
            replies.extend([
                Reply::done(Value::Null, Some("stop")),
                Reply::done(Value::Null, Some("stop")),
            ]);
        }
        if accepted_first {
            replies.extend([Reply::rejected(400), Reply::rejected(422)]);
        } else {
            replies.extend([Reply::done(Value::Null, Some("stop")), Reply::rejected(400)]);
        }
        let (client, buffered, owner) = fixture_for(replies, &request).await;
        let mut workload = buffered_workload(&request, &buffered, &result, (256, 2, 1));
        if accepted_first {
            trial(
                &mut workload,
                &client,
                (256, 2, 1),
                0,
                None,
                ServingMemoryScope::Unavailable,
                &AtomicBool::new(false),
                &mut result,
                Some(&checkpoint),
                &progress,
            )
            .await
            .unwrap();
        }
        let next = buffered_workload(&request, &buffered, &result, (256, 2, 2));
        workload.slots = next.slots;
        workload.input_hashes = next.input_hashes;
        let error = trial(
            &mut workload,
            &client,
            (256, 2, 2),
            0,
            None,
            ServingMemoryScope::Unavailable,
            &AtomicBool::new(false),
            &mut result,
            Some(&checkpoint),
            &progress,
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Unavailable);
        assert_eq!(result.rows.len(), usize::from(accepted_first));
        assert_eq!(events.lock().unwrap().len(), usize::from(accepted_first));
        assert!(result.provenance.as_ref().unwrap().workload.request_usage);
        assert_eq!(
            owner.receipts.lock().unwrap().len(),
            if accepted_first { 4 } else { 2 }
        );
        result.status = if accepted_first { "partial" } else { "failed" };
        result.message = Some(error.message);
        journal.finish(&result).unwrap();
        drop(checkpoint);
        drop(journal);
        let page = crate::benchmark::store::list(&directory.0, 0, 10).unwrap();
        assert!(page.warnings.is_empty(), "{:?}", page.warnings);
        assert_eq!(
            page.records[0]["result"]["rows"].as_array().unwrap().len(),
            usize::from(accepted_first)
        );
    }
}

#[tokio::test]
async fn serving_trials_checkpoint_but_eof_errors_and_cancel_discard_whole_batches() {
    let request = request();
    let (directory, mut result, journal, checkpoint, events, progress) = journaled(&request);
    let cancel = AtomicBool::new(false);
    let mut delayed = Reply::streamed(128, json!(128));
    delayed.delay = Duration::from_millis(50);
    let (client, buffered, owner) = fixture(vec![delayed, Reply::streamed(128, json!(128))]).await;
    trial(
        &mut buffered_workload(&request, &buffered, &result, (256, 2, 1)),
        &client,
        (256, 2, 1),
        0,
        None,
        ServingMemoryScope::Unavailable,
        &cancel,
        &mut result,
        Some(&checkpoint),
        &progress,
    )
    .await
    .unwrap();
    assert_eq!(result.rows.len(), 1);
    let row = &result.rows[0];
    assert_eq!(row.output_bytes, 256);
    assert_eq!(row.reported_completion_tokens, Some(256));
    assert_eq!(row.usage_status, "partial", "prompt usage may stay unknown");
    assert_eq!(row.finish_reasons, ["length", "length"]);
    assert!(row.validate());
    assert!(row.e2e_ms >= 40.0, "batch E2E includes the last DONE");
    for receipt in owner.receipts.lock().unwrap().iter() {
        assert_eq!(receipt["line"], "POST /v1/chat/completions HTTP/1.1");
        let body = receipt["body"].as_object().unwrap();
        assert_eq!(body.len(), 5, "no saved defaults or vendor-only fields");
        assert_eq!(body["max_tokens"], 128);
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["stream"], true);
        assert_eq!(body["model"], "selected-model");
        let text = body["messages"][0]["content"].as_str().unwrap();
        assert_eq!(text.len(), 256);
        assert!(row
            .input_sha256_by_request
            .contains(&format!("{:x}", Sha256::digest(text.as_bytes()))));
        for forbidden in ["top_k", "ignore_eos", "min_tokens", "stream_options"] {
            assert!(body.get(forbidden).is_none(), "{forbidden}");
        }
    }
    drop(owner);
    let kept = serde_json::to_value(&result.rows).unwrap();

    // Each failure belongs to one whole batch: no row, no checkpoint, no event.
    for (label, replies) in [
        (
            "SSE error",
            vec![
                Reply::streamed(3, Value::Null),
                Reply {
                    status: 200,
                    data: "data: {\"error\":{\"message\":\"synthetic error\"}}\n\n".into(),
                    delay: Duration::ZERO,
                    stall: false,
                },
            ],
        ),
        (
            "EOF before DONE",
            vec![
                Reply::streamed(128, json!(128)),
                Reply {
                    status: 200,
                    data: "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".into(),
                    delay: Duration::ZERO,
                    stall: false,
                },
            ],
        ),
    ] {
        let (client, buffered, _owner) = fixture(replies).await;
        let failure = trial(
            &mut buffered_workload(&request, &buffered, &result, (256, 2, 2)),
            &client,
            (256, 2, 2),
            0,
            None,
            ServingMemoryScope::Unavailable,
            &cancel,
            &mut result,
            Some(&checkpoint),
            &progress,
        )
        .await
        .unwrap_err();
        assert_eq!(
            failure.kind,
            crate::error::ErrorKind::Unavailable,
            "{label}"
        );
        assert!(
            failure.message.contains("repetition 2"),
            "{label}: {failure}"
        );
        assert_eq!(serde_json::to_value(&result.rows).unwrap(), kept, "{label}");
    }
    let (client, buffered, owner) = fixture(vec![
        Reply::streamed(128, json!(128)),
        Reply {
            status: 200,
            data: "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".into(),
            delay: Duration::ZERO,
            stall: true,
        },
    ])
    .await;
    let cancel = Arc::new(AtomicBool::new(false));
    let trigger = cancel.clone();
    let notice = owner.arrived.clone();
    let receipts = owner.receipts.clone();
    let canceller = tokio::spawn(async move {
        loop {
            if receipts.lock().unwrap().len() == 2 {
                break;
            }
            notice.notified().await;
        }
        trigger.store(true, Ordering::Release);
    });
    let cancelled = trial(
        &mut buffered_workload(&request, &buffered, &result, (256, 2, 3)),
        &client,
        (256, 2, 3),
        0,
        None,
        ServingMemoryScope::Unavailable,
        &cancel,
        &mut result,
        Some(&checkpoint),
        &progress,
    )
    .await
    .unwrap_err();
    assert_eq!(cancelled.kind, crate::error::ErrorKind::Cancelled);
    assert_eq!(
        cancelled.message,
        "point b256/c2/o128, repetition 3: benchmark cancelled"
    );
    canceller.await.unwrap();
    assert_eq!(serde_json::to_value(&result.rows).unwrap(), kept);
    assert_eq!(events.lock().unwrap().len(), 1);
    result.status = "cancelled";
    journal.finish(&result).unwrap();
    drop(checkpoint);
    drop(journal);
    let page = crate::benchmark::store::list(&directory.0, 0, 10).unwrap();
    assert!(page.warnings.is_empty(), "{:?}", page.warnings);
    assert_eq!(page.records[0]["schemaVersion"], 3);
    assert_eq!(page.records[0]["request"]["method"]["version"], 5);
    assert_eq!(page.records[0]["result"]["rows"], kept);
    assert_eq!(
        page.records[0]["result"]["provenance"]["workload"]["inputs"][0]["bytes"],
        256
    );
    let requests: Vec<_> = page.records[0]["result"]["provenance"]["execution"]["settings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|setting| setting["target"] == "request")
        .map(|setting| setting["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(requests, ["max_tokens", "stream", "temperature"]);
}

#[tokio::test]
async fn done_only_completion_is_a_zero_byte_checkpoint_with_unknown_token_counts() {
    let request = PerformanceBenchRequest {
        run_id: "empty-output".into(),
        max_output_tokens: 128,
        concurrencies: vec![1],
        ..request()
    };
    let (directory, mut result, journal, checkpoint, events, progress) = journaled(&request);
    let (client, buffered, _owner) = fixture_for(
        vec![Reply {
            status: 200,
            data: "data: [DONE]\n\n".into(),
            delay: Duration::ZERO,
            stall: false,
        }],
        &request,
    )
    .await;
    trial(
        &mut buffered_workload(&request, &buffered, &result, (256, 1, 1)),
        &client,
        (256, 1, 1),
        0,
        None,
        ServingMemoryScope::Unavailable,
        &AtomicBool::new(false),
        &mut result,
        Some(&checkpoint),
        &progress,
    )
    .await
    .unwrap();
    let row = &result.rows[0];
    assert_eq!(row.output_bytes, 0);
    assert_eq!(row.first_output_ms, None);
    assert_eq!(row.reported_completion_tokens, None);
    assert_eq!(row.usage_status, "missing");
    assert_eq!(row.prefill_tokens_per_second, None);
    assert_eq!(row.decode_tokens_per_second, None);
    assert_eq!(row.tpot_ms, None);
    assert_eq!(row.peak_memory_bytes, None);
    assert_eq!(row.finish_reasons, ["not_reported"]);
    assert!(row.validate());
    assert_eq!(events.lock().unwrap().len(), 1);
    result.status = "partial";
    journal.finish(&result).unwrap();
    drop(checkpoint);
    drop(journal);
    let page = crate::benchmark::store::list(&directory.0, 0, 10).unwrap();
    assert!(page.warnings.is_empty(), "{:?}", page.warnings);
    assert_eq!(page.records[0]["result"]["rows"][0]["output_bytes"], 0);
    assert_eq!(
        page.records[0]["result"]["rows"][0]["reported_completion_tokens"],
        Value::Null
    );
}

#[tokio::test]
async fn optional_usage_aggregates_only_known_safe_counters_without_losing_output() {
    let safe = json!({"prompt_tokens":10,"completion_tokens":2,"total_tokens":12});
    let max = json!({"prompt_tokens":9_007_199_254_740_991u64,"completion_tokens":0});
    for (reports, status, prompt, completion) in [
        (
            vec![safe.clone(), safe.clone()],
            "complete",
            Some(20),
            Some(4),
        ),
        (vec![safe.clone(), Value::Null], "partial", None, None),
        (
            vec![
                json!({"prompt_tokens":10,"completion_tokens":1}),
                json!({"prompt_tokens":10,"completion_tokens":1}),
            ],
            "complete",
            Some(20),
            Some(2),
        ),
        (
            vec![
                json!({"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":-1}}),
                safe.clone(),
            ],
            "complete",
            Some(20),
            Some(4),
        ),
        (
            vec![safe.clone(), json!({"prompt_tokens":-1})],
            "invalid",
            None,
            None,
        ),
        (vec![max.clone(), max], "invalid", None, None),
        (vec![Value::Null, Value::Null], "missing", None, None),
        (
            vec![
                json!({"completion_tokens":1}),
                json!({"completion_tokens":3}),
            ],
            "partial",
            None,
            Some(4),
        ),
    ] {
        let replies = reports
            .into_iter()
            .map(|usage| Reply::done(usage, Some("stop")))
            .collect();
        let (client, buffered, _owner) = fixture(replies).await;
        let request = request();
        let (_directory, mut result, _journal, checkpoint, _events, progress) = journaled(&request);
        trial(
            &mut buffered_workload(&request, &buffered, &result, (256, 2, 1)),
            &client,
            (256, 2, 1),
            0,
            None,
            ServingMemoryScope::Unavailable,
            &AtomicBool::new(false),
            &mut result,
            Some(&checkpoint),
            &progress,
        )
        .await
        .unwrap();
        let row = &result.rows[0];
        assert_eq!(row.usage_status, status);
        assert_eq!(
            (row.reported_prompt_tokens, row.reported_completion_tokens),
            (prompt, completion)
        );
        assert_eq!(row.output_bytes, 24);
        if status == "invalid" {
            assert_eq!(row.prefill_tokens_per_second, None);
            assert_eq!(row.decode_tokens_per_second, None);
            assert_eq!(row.tpot_ms, None);
        }
        assert!(row.validate());
    }
}

#[tokio::test]
async fn serving_requests_omit_saved_defaults_and_negotiate_usage_declarations() {
    for usage in [None, Some(false), Some(true)] {
        let mut engine = chat_engine();
        engine.provider = crate::providers::ProviderId::parse("custom.benchmark-test").unwrap();
        engine.tasks = vec!["generate".into()];
        engine.chat_supported = Some(true);
        engine.stream_usage_supported = usage;
        engine
            .request_fields
            .insert("temperature".into(), json!(0.9));
        engine
            .request_fields
            .insert("ignore_eos".into(), json!(true));
        engine
            .request_fields
            .insert("min_tokens".into(), json!(128));
        engine
            .request_fields
            .insert("stream_options".into(), json!({"include_usage":true}));
        engine.request_lora = Some("selected-lora".into());
        let body = point_body(&engine, "synthetic input".into(), &request()).unwrap();
        assert_eq!(
            body,
            json!({
                "model":"selected-lora", "messages":[{"role":"user","content":"synthetic input"}],
                "temperature":0, "max_tokens":128, "stream":true
            })
        );
        let admission = engine_admission(&engine, &request());
        assert_eq!(admission.status, "supported", "{usage:?}");
        assert_eq!(admission.reason, "ready");
        assert!(admission.detail.is_none());
        let requested = PerformanceBenchRequest {
            request_usage: true,
            ..request()
        };
        let effective = effective_request(&engine, &requested);
        assert_eq!(effective.request_usage, usage != Some(false));
        let body = point_body(&engine, "synthetic input".into(), &effective).unwrap();
        assert_eq!(
            body.get("stream_options"),
            (usage != Some(false))
                .then(|| json!({"include_usage": true}))
                .as_ref()
        );
    }
}

#[tokio::test]
async fn benchmark_admission_rejects_known_non_chat_targets() {
    let mut no_chat_template = chat_engine();
    no_chat_template.chat_supported = Some(false);
    let mut embeddings_only = chat_engine();
    embeddings_only.tasks = vec!["embed".into()];
    embeddings_only.chat_supported = Some(true);

    for engine in [no_chat_template, embeddings_only] {
        let admission = engine_admission(&engine, &request());

        assert_eq!(admission.status, "unsupported", "{engine:?}");
        assert_eq!(admission.reason, "request", "{engine:?}");
        assert!(admission.detail.is_some(), "{engine:?}");
    }
}

#[tokio::test]
async fn benchmark_admission_supports_chat_requests_for_builtin_and_custom_engines() {
    for provider in [
        chat_engine().provider,
        crate::providers::ProviderId::parse("custom.benchmark-test").unwrap(),
    ] {
        let mut engine = chat_engine();
        engine.provider = provider;
        engine.tasks = vec!["generate".into()];
        engine.chat_supported = Some(true);
        let admission = engine_admission(&engine, &request());
        assert_eq!(admission.status, "supported", "{provider:?}");
        assert_eq!(admission.reason, "ready", "{provider:?}");
        assert!(admission.detail.is_none(), "{provider:?}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn native_benchmark_rejection_preserves_history_and_measurement_permits_on_retries() {
    use crate::benchmark::{sharing::permits, store};
    use crate::providers::registry;
    use std::fs;
    use std::path::Path;

    const CHILD: &str = "AIOLM_BENCHMARK_ADMISSION_FIXTURE";
    const FILTER: &str = "performance_bench::tests::native_benchmark_rejection_preserves_history_and_measurement_permits_on_retries";
    const OWNER: &str = ".admission-fixture-owner";
    if std::env::var_os(CHILD).is_none() {
        let original_home = std::env::var_os("AIOLM_HOME");
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let directory = Directory(base.join(format!(
            "aiolm-benchmark-admission-{}",
            uuid::Uuid::new_v4()
        )));
        fs::create_dir(&directory.0).unwrap();
        fs::write(
            directory.0.join(OWNER),
            b"synthetic benchmark admission fixture",
        )
        .unwrap();
        let mut command = crate::procutil::std_command(std::env::current_exe().unwrap());
        command
            .args(["--exact", FILTER, "--nocapture", "--test-threads=1"])
            .env(CHILD, &directory.0)
            .env("AIOLM_HOME", &directory.0);
        let output = crate::procutil::capture_output_cancellable(
            &mut command,
            Duration::from_secs(60),
            256 * 1024,
            None,
        )
        .unwrap();
        assert_eq!(std::env::var_os("AIOLM_HOME"), original_home);
        assert!(
            output.status.success(),
            "isolated admission fixture failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.starts_with("test result: ok. 1 passed; 0 failed;")));
        return;
    }

    let area = PathBuf::from(std::env::var_os(CHILD).unwrap());
    assert_eq!(PathBuf::from(std::env::var_os("AIOLM_HOME").unwrap()), area);
    assert!(area.is_absolute());
    assert_eq!(
        fs::read(area.join(OWNER)).unwrap(),
        b"synthetic benchmark admission fixture"
    );
    let model = area.join("deployment.json");
    fs::write(&model, b"{}").unwrap();
    let probe_script = area.join("probe.sh");
    let launch_script = area.join("launch.sh");
    let launched = area.join("unexpected-launch");
    fs::write(
        &probe_script,
        b"if [ -z \"$1\" ]; then cat \"$2\"; else cat \"$3\"; fi\n",
    )
    .unwrap();
    fs::write(&launch_script, b"printf launched > \"$1\"\nexit 1\n").unwrap();
    let independent_probe = area.join("independent-probe.json");
    let selected_probe = area.join("selected-probe.json");
    let mut probe = json!({
        "schema_version":1, "engine_id":"custom.benchmark-admission", "runtime_id":"build-1",
        "version":"synthetic", "accelerator":"synthetic", "model":"",
        "model_supported":true, "served_model":"selected-model",
        "capabilities":{
            "tasks":["generate"],
            "modalities":{"text":true,"image":false,"audio":false,"video":false},
            "chat":false
        }
    });
    fs::write(&independent_probe, serde_json::to_vec(&probe).unwrap()).unwrap();
    probe["model"] = json!(model);
    fs::write(&selected_probe, serde_json::to_vec(&probe).unwrap()).unwrap();
    let manifest = serde_json::from_value(json!({
        "schema_version":1, "adapter_version":1,
        "engine_id":"custom.benchmark-admission", "runtime_id":"build-1",
        "display_name":"Synthetic admission engine", "protocol":"openai-v1",
        "platforms":[{"os":std::env::consts::OS,"arch":std::env::consts::ARCH}],
        "probe":{
            "program":"/bin/sh",
            "args":[probe_script,"{model}",independent_probe,selected_probe]
        },
        "launch":{
            "program":"/bin/sh",
            "args":[launch_script,launched,"{model}","{port}","{model_alias}"],
            "env":{"ENGINE_KEY":"{api_key}"}
        },
        "artifacts":[probe_script,launch_script,independent_probe,selected_probe],
        "model_formats":["unknown"], "health_path":"/health", "options":[]
    }))
    .unwrap();
    registry::register_manifest(manifest, None).await.unwrap();
    let cfg = AppConfig {
        active_provider: "custom.benchmark-admission".into(),
        active_runtime: "build-1".into(),
        active_model: model.to_string_lossy().into_owned(),
        ..AppConfig::default()
    };
    registry::refresh(&cfg, None).await.unwrap();
    let verdict = admission(cfg.clone(), desktop_request()).await;
    assert_eq!(verdict.status, "unsupported");
    assert_eq!(verdict.reason, "request");
    let expected_error = verdict.detail.unwrap();

    let root = crate::benchmark::data_root().unwrap();
    let existing_request = PerformanceBenchRequest {
        run_id: "existing-history".into(),
        ..request()
    };
    let existing_result = result(&existing_request);
    let journal = store::RunJournal::begin(
        &root,
        json!({
            "schemaVersion":3, "id":existing_request.run_id, "createdAt":1,
            "model":"synthetic.model", "request":existing_request, "result":existing_result
        }),
    )
    .unwrap();
    journal.finish(&existing_result).unwrap();
    drop(journal);
    fn journal_bytes(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut journals = fs::read_dir(root.join("runs"))
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                let bytes = fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect::<Vec<_>>();
        journals.sort_by(|left, right| left.0.cmp(&right.0));
        journals
    }
    let history_before = serde_json::to_value(store::list(&root, 0, 20).unwrap()).unwrap();
    assert_eq!(history_before["total"], 1);
    let journals_before = journal_bytes(&root);
    let epoch = permits::epoch();
    permits::store_permit("existing-submission", "existing-session", "existing-permit");
    let permit = permits::live_permit("existing-submission");
    assert!(permit.is_some());
    let state = crate::state::AppState::default();
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let progress: Progress = Arc::new(move |event| captured.lock().unwrap().push(event));
    for run_id in [
        "unsupported-attempt",
        "unsupported-attempt",
        "unsupported-retry",
    ] {
        let error = crate::commands::benchmark::run_performance_bench_with_progress(
            &state,
            cfg.clone(),
            PerformanceBenchRequest {
                run_id: run_id.into(),
                ..desktop_request()
            },
            progress.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Unavailable);
        assert_eq!(error.message, expected_error);
        assert_eq!(permits::epoch(), epoch);
        assert_eq!(permits::live_permit("existing-submission"), permit);
        assert_eq!(journal_bytes(&root), journals_before);
        assert_eq!(
            serde_json::to_value(store::list(&root, 0, 20).unwrap()).unwrap(),
            history_before
        );
        assert!(!launched.exists());
        assert!(state.bench_process.lock().unwrap().is_none());
        assert!(!state.bench_cancel.load(Ordering::Acquire));
    }
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 3);
    assert!(events
        .iter()
        .all(|event| event.phase == "loading" && event.row.is_none()));
    permits::clear_permit("existing-submission");
}

#[test]
fn aggregation_preserves_launch_slot_order_nullable_first_output_and_sampled_memory() {
    let started = Instant::now();
    let measurement = |finished, reason: &str, output, latency| protocol::Measurement {
        output_bytes: output,
        first_output_ms: latency,
        e2e_ms: finished as f64,
        reported_prompt_tokens: None,
        reported_completion_tokens: None,
        usage_status: "missing".into(),
        finish_reason: reason.into(),
        finished: started + Duration::from_millis(finished),
    };
    let mut measurements = [
        measurement(200, "length", 12, Some(50.0)),
        measurement(100, "stop", 6, Some(50.0)),
    ];
    let row = aggregate(&request(), (256, 2, 1), started, &measurements, Some(4096));
    assert_eq!(row.finish_reasons, ["length", "stop"]);
    assert_eq!(row.e2e_ms, 200.0);
    assert_eq!(row.first_output_ms, Some(50.0));
    assert_eq!(row.output_bytes, 18);
    assert_eq!(row.peak_memory_bytes, Some(4096));
    measurements[1].first_output_ms = None;
    let row = aggregate(&request(), (256, 2, 1), started, &measurements, None);
    assert_eq!(row.first_output_ms, None);
    assert_eq!(row.prefill_tokens_per_second, None);
    assert_eq!(row.decode_tokens_per_second, None);
    assert_eq!(row.tpot_ms, None);
    assert_eq!(row.peak_memory_bytes, None);
}

#[test]
fn aggregation_averages_per_request_rates_and_requires_two_output_tokens_for_decode() {
    let started = Instant::now();
    let measurement = |first, elapsed, prompt, completion| protocol::Measurement {
        output_bytes: 12,
        first_output_ms: Some(first),
        e2e_ms: elapsed,
        reported_prompt_tokens: Some(prompt),
        reported_completion_tokens: Some(completion),
        usage_status: "complete".into(),
        finish_reason: "stop".into(),
        finished: started + Duration::from_secs_f64(elapsed / 1000.0),
    };
    let mut measurements = [
        measurement(100.0, 1100.0, 50, 11),
        measurement(300.0, 2300.0, 150, 21),
    ];
    let row = aggregate(&request(), (256, 2, 1), started, &measurements, None);
    assert_eq!(row.prefill_tokens_per_second, Some(500.0));
    assert_eq!(row.tpot_ms, Some(100.0));
    assert_eq!(row.decode_tokens_per_second, Some(10.0));
    assert_eq!(row.first_output_ms, Some(200.0));
    assert_eq!(row.e2e_ms, 2300.0);

    measurements[0].reported_completion_tokens = Some(1);
    let row = aggregate(&request(), (256, 2, 1), started, &measurements, None);
    assert_eq!(row.prefill_tokens_per_second, Some(500.0));
    assert_eq!(row.tpot_ms, None);
    assert_eq!(row.decode_tokens_per_second, None);
}

#[test]
fn sanitize_captured_argv_strips_windows_verbatim_prefixes_and_redacts_secrets() {
    let cfg = AppConfig::default();
    let root = crate::providers::registry::root();
    let program = std::path::Path::new(r"\\?\C:\한글 엔진 dir\synthetic-engine.exe");
    let raw_args = vec![
        "--model".to_owned(),
        r"\\?\C:\한글 모델\sub dir\weights.gguf".to_owned(),
        r"--mmproj=\\?\UNC\fileserver\share\mmproj.gguf".to_owned(),
        "--api-key".to_owned(),
        "synthetic-secret-token".to_owned(),
        r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\keep.bin".to_owned(),
    ];

    let (argv, masked) = sanitize_captured_argv(&root, &cfg, program, &raw_args);
    assert_eq!(
        argv,
        [
            r"C:\한글 엔진 dir\synthetic-engine.exe",
            "--model",
            r"C:\한글 모델\sub dir\weights.gguf",
            r"--mmproj=\\fileserver\share\mmproj.gguf",
            "--api-key",
            "synthetic-secret-token",
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\keep.bin",
        ]
    );
    assert_eq!(
        masked,
        [
            r"C:\한글 엔진 dir\synthetic-engine.exe",
            "--model",
            r"C:\한글 모델\sub dir\weights.gguf",
            r"--mmproj=\\fileserver\share\mmproj.gguf",
            "--api-key",
            "[redacted]",
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\keep.bin",
        ]
    );
    assert_eq!(argv.len(), masked.len());
}

#[test]
fn capture_engine_args_returns_direct_engine_command_without_verbatim_prefix() {
    use std::fs;
    const CHILD: &str = "AIOLM_BENCHMARK_ENGINE_ARGS_FIXTURE";
    const FILTER: &str =
        "performance_bench::tests::capture_engine_args_returns_direct_engine_command_without_verbatim_prefix";
    if std::env::var_os(CHILD).is_none() {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let directory =
            Directory(base.join(format!("aiolm-bench-engine-args-{}", uuid::Uuid::new_v4())));
        fs::create_dir(&directory.0).unwrap();
        let mut command = crate::procutil::std_command(std::env::current_exe().unwrap());
        command
            .args(["--exact", FILTER, "--nocapture", "--test-threads=1"])
            .env(CHILD, &directory.0)
            .env("AIOLM_HOME", directory.0.join("aiolm home"));
        let output = crate::procutil::capture_output_cancellable(
            &mut command,
            Duration::from_secs(45),
            256 * 1024,
            None,
        )
        .unwrap();
        assert!(
            output.status.success(),
            "isolated engine_args fixture failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.starts_with("test result: ok. 1 passed; 0 failed;")));
        return;
    }

    let area = PathBuf::from(std::env::var_os(CHILD).unwrap());
    let engine_dir = area.join("한글 엔진 dir");
    fs::create_dir_all(&engine_dir).unwrap();
    let engine = engine_dir.join("synthetic-engine.exe");
    let model = engine_dir.join("한글 model.gguf");
    let helper = std::env::current_exe().unwrap();
    fs::write(&engine, b"synthetic engine").unwrap();
    fs::write(&model, b"synthetic model").unwrap();

    let root = crate::providers::registry::root();
    let engine_id = crate::providers::ProviderId::parse("custom.auto-0123456789abcdef").unwrap();
    let runtime_id = "connection-0123456789abcdef".to_string();
    let conn_dir = root.join(engine_id.as_str()).join(&runtime_id);
    fs::create_dir_all(&conn_dir).unwrap();
    let conn_path = conn_dir.join("connection.json");
    let verbatim_engine = format!(
        r"\\?\{}",
        engine.to_string_lossy().trim_start_matches(r"\\?\")
    );
    let verbatim_model = format!(
        r"\\?\{}",
        model.to_string_lossy().trim_start_matches(r"\\?\")
    );
    let spec_json = json!({
        "version": 1,
        "engine_id": engine_id.as_str(),
        "runtime_id": runtime_id,
        "target": {
            "kind": "managed",
            "launch": {
                "program": verbatim_engine,
                "args": ["serve", "--model", "{model}", "--port={port}", "--host={host}"],
                "env": {},
                "working_directory": null
            },
            "artifacts": []
        },
        "model_path": verbatim_model,
        "served_alias": "synthetic-bench-model"
    });
    fs::write(&conn_path, serde_json::to_vec(&spec_json).unwrap()).unwrap();

    let encoded_addr = base64::engine::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        conn_path.to_string_lossy().as_bytes(),
    );
    let manifest: crate::providers::registry::RuntimeManifest = serde_json::from_value(json!({
        "schema_version": 1,
        "adapter_version": 1,
        "engine_id": engine_id.as_str(),
        "runtime_id": runtime_id,
        "display_name": "Synthetic auto bench",
        "platforms": [{"os": std::env::consts::OS, "arch": std::env::consts::ARCH}],
        "protocol": "openai-v1",
        "probe": {
            "program": helper.to_string_lossy(),
            "args": [
                crate::providers::runtime_auto::INTERNAL,
                "probe",
                encoded_addr,
                "{model}"
            ],
            "env": {},
            "working_directory": null
        },
        "launch": {
            "program": helper.to_string_lossy(),
            "args": [
                crate::providers::runtime_auto::INTERNAL,
                "serve",
                encoded_addr,
                "{model}",
                "{port}"
            ],
            "env": {"AIO_CONNECT_KEY": "{api_key}"},
            "working_directory": null
        },
        "options": [],
        "model_formats": ["unknown"],
        "models": [{"path": verbatim_model, "name": "Synthetic model"}],
        "artifacts": [conn_path.to_string_lossy(), verbatim_engine],
        "health_path": "/health",
        "health_authenticated": false
    }))
    .unwrap();
    let hash_file = |path: &str| format!("{:x}", Sha256::digest(fs::read(path).unwrap()));
    let mut artifacts_sha256 = serde_json::Map::new();
    for artifact in &manifest.artifacts {
        artifacts_sha256.insert(artifact.clone(), json!(hash_file(artifact)));
    }
    fs::write(
        conn_dir.join("registration.json"),
        serde_json::to_vec(&json!({
            "manifest": manifest,
            "executable_sha256": hash_file(&manifest.launch.program),
            "probe_sha256": hash_file(&manifest.probe.program),
            "artifacts_sha256": artifacts_sha256,
            "probe": null,
            "model_fingerprint": "",
            "launch_fingerprint": "",
            "error": null,
        }))
        .unwrap(),
    )
    .unwrap();

    let clean_model = crate::verbatim_path::strip_windows_verbatim_prefix(model)
        .to_string_lossy()
        .into_owned();
    let cfg = AppConfig {
        active_provider: engine_id.as_str().into(),
        active_runtime: runtime_id.clone(),
        active_model: clean_model.clone(),
        port: 43210,
        ..AppConfig::default()
    };
    let captured = capture_engine_args(&root, &cfg)
        .unwrap()
        .expect("automatic managed manifest produces engine_args");
    assert!(
        captured
            .iter()
            .all(|arg| !arg.contains(r"\\?\") && !arg.contains('?')),
        "{captured:?}"
    );
    assert!(
        captured
            .windows(2)
            .any(|w| w == ["--model", clean_model.as_str()]),
        "{captured:?}"
    );
    // The helper gives the engine its own internal port, so the benchmark's
    // front port must not be recorded as the engine's port.
    assert!(
        captured.contains(&"--port={port}".to_owned()),
        "{captured:?}"
    );
    assert!(
        captured.iter().all(|arg| !arg.contains("43210")),
        "{captured:?}"
    );
    assert!(
        captured.contains(&"--host=127.0.0.1".to_owned()),
        "{captured:?}"
    );

    let non_auto: crate::providers::registry::RuntimeManifest = serde_json::from_value(json!({
        "schema_version": 1,
        "adapter_version": 1,
        "engine_id": "custom.manual-bench",
        "runtime_id": "build-1",
        "display_name": "Synthetic manual bench",
        "platforms": [{"os": std::env::consts::OS, "arch": std::env::consts::ARCH}],
        "protocol": "openai-v1",
        "probe": {"program": "/bin/sh", "args": [], "env": {}},
        "launch": {"program": "/bin/sh", "args": ["{model}", "{port}"], "env": {}},
        "options": [],
        "model_formats": ["unknown"],
        "models": [],
        "artifacts": [],
        "health_path": "/health",
        "health_authenticated": false
    }))
    .unwrap();
    assert!(capture_engine_args_for_manifest(&root, &cfg, &non_auto)
        .unwrap()
        .is_none());
}

#[test]
fn engine_capture_failure_is_recorded_and_warned_without_failing_the_run() {
    let request = PerformanceBenchRequest {
        run_id: "capture-failure".into(),
        method: ServingMethod {
            id: "openai-chat-serving".into(),
            version: METHOD_VERSION,
        },
        context_profile: "novel_en".into(),
        prompt_bytes: vec![256],
        max_output_tokens: 128,
        concurrencies: vec![1],
        repetitions: 1,
        warmup: false,
        request_usage: true,
    };
    let mut result = failed(&request, &AppConfig::default(), String::new());
    result.engine_args = Some(vec!["/synthetic/stale".into()]);
    let warning = record_engine_args(
        &mut result,
        Err(AppError::validation("synthetic capture failure")),
    )
    .expect("a capture failure is reported");
    assert!(warning.contains("synthetic capture failure"), "{warning}");
    assert!(warning.contains("measurement continues"), "{warning}");
    assert_eq!(result.engine_args, None);
    assert_eq!(
        result.engine_args_error.as_deref(),
        Some("synthetic capture failure")
    );
    let serialized = serde_json::to_value(&result).unwrap();
    assert_eq!(serialized["engine_args_error"], "synthetic capture failure");
    assert!(serialized.get("engine_args").is_none());

    assert!(record_engine_args(&mut result, Ok(Some(vec!["/synthetic/engine".into()]))).is_none());
    assert_eq!(result.engine_args, Some(vec!["/synthetic/engine".into()]));
    assert_eq!(result.engine_args_error, None);
    assert!(serde_json::to_value(&result)
        .unwrap()
        .get("engine_args_error")
        .is_none());

    assert!(record_engine_args(&mut result, Ok(None)).is_none());
    assert_eq!(result.engine_args, None);
    assert_eq!(result.engine_args_error, None);

    // Built-in engines run their own command; there is nothing to capture.
    let root = std::env::temp_dir().join(format!("aiolm-bench-builtin-{}", uuid::Uuid::new_v4()));
    assert!(capture_engine_args(&root, &AppConfig::default())
        .unwrap()
        .is_none());
}
