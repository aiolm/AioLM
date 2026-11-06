use super::*;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener as AsyncListener,
};

fn request() -> PerformanceBenchRequest {
    PerformanceBenchRequest {
        run_id: "serving-journal".into(),
        method: Default::default(),
        context_profile: "novel_ko".into(),
        prompt_bytes: vec![256],
        max_output_tokens: 1024,
        concurrencies: vec![2],
        repetitions: 3,
        warmup: false,
        request_usage: true,
    }
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
        let (workload, texts) = prepare_inputs(&request);
        for ((input, text), size) in workload.inputs.iter().zip(&texts).zip(256..320) {
            assert_eq!(text.len(), size);
            assert!(
                text.starts_with("Continue the following text. Do not summarize or explain.\n\n")
            );
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
    assert!(serde_json::from_value::<PerformanceBenchRequest>(json!({
        "run_id":"legacy","prompt_lengths":[512],"generation_length":128,"batch_sizes":[],
        "repetitions":1,"context_profile":"novel_en","warmup":true
    }))
    .is_err());
    request.prompt_bytes = vec![256, 256];
    assert!(validate_request(&mut request).is_err());
}

#[test]
fn only_fixed_output_presets_execute_while_cap_requests_stay_readable() {
    for target in FIXED_OUTPUT_TOKENS {
        let mut fixed = PerformanceBenchRequest {
            max_output_tokens: target,
            ..request()
        };
        validate_execution_request(&mut fixed).unwrap();
    }
    assert_eq!(FIXED_OUTPUT_TOKENS.last(), Some(&MAX_SERVING_OUTPUT_TOKENS));
    for (target, usage) in [(1000, true), (204_801, true), (128, true), (1024, false)] {
        let mut invalid = PerformanceBenchRequest {
            max_output_tokens: target,
            request_usage: usage,
            ..request()
        };
        assert!(validate_request(&mut invalid).is_err(), "{target}/{usage}");
    }
    // Historical cap requests validate as history, but never run again.
    let mut cap = PerformanceBenchRequest {
        method: ServingMethod {
            id: "openai-chat-serving".into(),
            version: CAP_METHOD_VERSION,
        },
        max_output_tokens: 128,
        request_usage: false,
        ..request()
    };
    validate_request(&mut cap).unwrap();
    assert!(validate_execution_request(&mut cap).is_err());
    cap.max_output_tokens = 65_537;
    assert!(validate_request(&mut cap).is_err());
    let mut unknown = PerformanceBenchRequest {
        method: ServingMethod {
            id: "openai-chat-serving".into(),
            version: 3,
        },
        ..request()
    };
    assert!(validate_request(&mut unknown).is_err());
}

struct Reply {
    data: String,
    delay: Duration,
    stall: bool,
}
impl Reply {
    /// A forced stream: `count` one-byte output pieces, reported as `reported`
    /// completion tokens with only partial prompt/cache usage.
    fn forced(count: usize, reported: Value) -> Self {
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
            data: format!("data: {content}\n\n{usage}data: [DONE]\n\n"),
            delay: Duration::ZERO,
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

fn fixed_engine() -> EngineInfo {
    let mut engine = EngineInfo::llama(
        "selected-model",
        crate::providers::artifacts::Modalities::text_only(),
    );
    engine.fixed_output = Some(FixedOutputControl::IgnoreEos);
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
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                tokio::time::sleep(reply.delay).await;
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
    let mut engine = fixed_engine();
    // Saved sampling defaults must not enter a common benchmark request.
    engine.request_fields.insert("top_k".into(), json!(7));
    let request = point_request(
        &client,
        &url,
        "synthetic-key",
        &engine,
        corpus::text("novel_ko", 256),
        bench,
        FixedOutputControl::IgnoreEos,
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
        FixedOutputControl::IgnoreEos,
    ));
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
                "schemaVersion":2,"id":request.run_id,"createdAt":1,"model":"synthetic.model",
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

#[tokio::test]
async fn completed_forced_trials_checkpoint_but_eof_count_mismatch_and_cancel_discard_whole_batches(
) {
    let request = request();
    let (directory, mut result, journal, checkpoint, events, progress) = journaled(&request);
    let cancel = AtomicBool::new(false);
    let mut delayed = Reply::forced(1024, json!(1024));
    delayed.delay = Duration::from_millis(50);
    let (client, buffered, owner) = fixture(vec![delayed, Reply::forced(1024, json!(1024))]).await;
    trial(
        &request,
        &client,
        &buffered,
        (256, 2, 1),
        0,
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
    assert_eq!(row.content_bytes, 2048);
    assert_eq!(row.reported_completion_tokens, Some(2048));
    assert_eq!(
        row.reported_completion_tokens_by_request,
        Some(vec![1024, 1024])
    );
    assert_eq!(
        row.usage_status, "partial",
        "prompt/cache usage may stay unknown"
    );
    assert_eq!(row.finish_reasons, ["length", "length"]);
    assert!(row.validate_fixed_output(1024));
    assert!(row.e2e_ms >= 40.0, "batch E2E includes the last DONE");
    for receipt in owner.receipts.lock().unwrap().iter() {
        assert_eq!(receipt["line"], "POST /v1/chat/completions HTTP/1.1");
        let body = receipt["body"].as_object().unwrap();
        assert_eq!(body.len(), 7, "no saved defaults or vendor-only fields");
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["ignore_eos"], true);
        assert_eq!(body["stream_options"], json!({"include_usage":true}));
        assert!(body.get("top_k").is_none());
    }
    drop(owner);
    let kept = serde_json::to_value(&result.rows).unwrap();

    // Each failure belongs to one whole batch: no row, no checkpoint, no event.
    for (label, replies) in [
        (
            "unequal counts whose sum matches",
            vec![
                Reply::forced(1023, json!(1023)),
                Reply::forced(1025, json!(1025)),
            ],
        ),
        (
            "early EOS in one slot",
            vec![
                Reply::forced(1024, json!(1024)),
                Reply::forced(700, json!(700)),
            ],
        ),
        (
            "missing completion counter",
            vec![
                Reply::forced(1024, json!(1024)),
                Reply::forced(1024, Value::Null),
            ],
        ),
        (
            "invalid completion counter",
            vec![
                Reply::forced(1024, json!(1024)),
                Reply::forced(1024, json!(-1)),
            ],
        ),
        (
            "EOF before DONE",
            vec![
                Reply::forced(1024, json!(1024)),
                Reply {
                    data: "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".into(),
                    delay: Duration::ZERO,
                    stall: false,
                },
            ],
        ),
    ] {
        let (client, buffered, _owner) = fixture(replies).await;
        let failure = trial(
            &request,
            &client,
            &buffered,
            (256, 2, 2),
            0,
            ServingMemoryScope::Unavailable,
            &cancel,
            &mut result,
            Some(&checkpoint),
            &progress,
        )
        .await
        .unwrap_err();
        assert!(failure.contains("repetition 2"), "{label}: {failure}");
        assert_eq!(serde_json::to_value(&result.rows).unwrap(), kept, "{label}");
    }
    let (client, buffered, owner) = fixture(vec![
        Reply::forced(1024, json!(1024)),
        Reply {
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
    assert!(trial(
        &request,
        &client,
        &buffered,
        (256, 2, 3),
        0,
        ServingMemoryScope::Unavailable,
        &cancel,
        &mut result,
        Some(&checkpoint),
        &progress
    )
    .await
    .is_err());
    canceller.await.unwrap();
    assert_eq!(serde_json::to_value(&result.rows).unwrap(), kept);
    assert_eq!(events.lock().unwrap().len(), 1);
    result.status = "cancelled";
    journal.finish(&result).unwrap();
    drop(checkpoint);
    drop(journal);
    let page = crate::benchmark::store::list(&directory.0, 0, 10).unwrap();
    assert!(page.warnings.is_empty(), "{:?}", page.warnings);
    assert_eq!(page.records[0]["schemaVersion"], 2);
    assert_eq!(page.records[0]["request"]["method"]["version"], 2);
    assert_eq!(page.records[0]["result"]["rows"], kept);
    assert_eq!(
        page.records[0]["result"]["rows"][0]["reported_completion_tokens_by_request"],
        json!([1024, 1024])
    );
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
    assert_eq!(
        requests,
        [
            "ignore_eos",
            "max_tokens",
            "stream",
            "stream_options.include_usage",
            "temperature"
        ]
    );
}

#[tokio::test]
async fn largest_fixed_output_target_streams_and_counts_exactly_over_http() {
    let request = PerformanceBenchRequest {
        run_id: "largest-target".into(),
        max_output_tokens: 204_800,
        concurrencies: vec![1],
        ..request()
    };
    let (_directory, mut result, _journal, checkpoint, _events, progress) = journaled(&request);
    // The largest preset streams through the real HTTP/SSE path and counts
    // exactly; its scaled request budget stays bounded.
    let (client, buffered, owner) =
        fixture_for(vec![Reply::forced(204_800, json!(204_800))], &request).await;
    trial(
        &request,
        &client,
        &buffered,
        (256, 1, 1),
        0,
        ServingMemoryScope::Unavailable,
        &AtomicBool::new(false),
        &mut result,
        Some(&checkpoint),
        &progress,
    )
    .await
    .unwrap();
    let row = &result.rows[0];
    assert_eq!(row.content_bytes, 204_800);
    assert_eq!(
        row.reported_completion_tokens_by_request,
        Some(vec![204_800])
    );
    assert!(row.validate_fixed_output(204_800));
    {
        let receipts = owner.receipts.lock().unwrap();
        let body = &receipts[0]["body"];
        assert_eq!(body["max_tokens"], 204_800);
        assert_eq!(body["ignore_eos"], true);
    }
    drop(owner);

    // One token short of the largest target is early EOS, not a row.
    let (client, buffered, _owner) =
        fixture_for(vec![Reply::forced(204_799, json!(204_799))], &request).await;
    let error = trial(
        &request,
        &client,
        &buffered,
        (256, 1, 2),
        0,
        ServingMemoryScope::Unavailable,
        &AtomicBool::new(false),
        &mut result,
        Some(&checkpoint),
        &progress,
    )
    .await
    .unwrap_err();
    assert!(error.contains("204799 of 204800"), "{error}");
    assert_eq!(result.rows.len(), 1);
}

#[tokio::test]
async fn optional_usage_aggregates_only_known_safe_counters_without_losing_output() {
    let safe = json!({"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":3}});
    let max = json!({"prompt_tokens":9_007_199_254_740_991u64,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":0}});
    for (reports, status, prompt, completion, cached) in [
        (
            vec![safe.clone(), safe.clone()],
            "complete",
            Some(20),
            Some(4),
            Some(6),
        ),
        (vec![safe.clone(), Value::Null], "partial", None, None, None),
        (
            vec![
                json!({"prompt_tokens":10,"completion_tokens":1}),
                json!({"prompt_tokens":10,"completion_tokens":1}),
            ],
            "partial",
            Some(20),
            Some(2),
            None,
        ),
        (
            vec![safe.clone(), json!({"prompt_tokens":-1})],
            "invalid",
            None,
            None,
            None,
        ),
        (vec![max.clone(), max], "invalid", None, None, None),
        (vec![Value::Null, Value::Null], "missing", None, None, None),
    ] {
        let replies = reports
            .into_iter()
            .map(|usage| Reply::done(usage, Some("stop")))
            .collect();
        let (client, buffered, _owner) = fixture(replies).await;
        let (started, measurements) = batch(
            &client,
            &buffered,
            2,
            &AtomicBool::new(false),
            protocol::Budget::default(),
        )
        .await
        .unwrap();
        let row = aggregate(&request(), (256, 2, 1), started, &measurements, None);
        assert_eq!(row.usage_status, status);
        assert_eq!(
            (
                row.reported_prompt_tokens,
                row.reported_completion_tokens,
                row.reported_cached_tokens
            ),
            (prompt, completion, cached)
        );
        assert_eq!(row.output_bytes, 24);
        assert!(row.validate());
        // None of these early-EOS observations is fixed-output evidence.
        assert!(fixed_output_counts(1024, &measurements).is_err());
    }
}

#[tokio::test]
async fn fixed_output_needs_declared_control_and_usage_and_an_unchanged_force_field() {
    let mut engine = fixed_engine();
    assert_eq!(
        fixed_output_control(&engine),
        Ok(FixedOutputControl::IgnoreEos)
    );
    for usage in [None, Some(false)] {
        engine.stream_usage_supported = usage;
        assert!(fixed_output_control(&engine).is_err(), "{usage:?}");
    }
    engine.stream_usage_supported = Some(true);
    engine.fixed_output = None;
    assert!(fixed_output_control(&engine).is_err());

    // A control the adapter does not advertise is never sent as if it were.
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert!(point_request(
        &client,
        "http://127.0.0.1:9/v1",
        "synthetic-key",
        &fixed_engine(),
        corpus::text("novel_ko", 256),
        &request(),
        FixedOutputControl::MinTokens,
    )
    .is_err());
}

#[test]
fn aggregation_preserves_launch_slot_finish_order_and_nullable_channel_means() {
    let started = Instant::now();
    let measurement = |finished, reason: &str, content, content_latency| protocol::Measurement {
        content_bytes: content,
        reasoning_bytes: 6,
        first_output_ms: Some(50.0),
        first_content_ms: content_latency,
        first_reasoning_ms: Some(50.0),
        reported_prompt_tokens: None,
        reported_completion_tokens: None,
        reported_cached_tokens: None,
        usage_status: "missing".into(),
        finish_reason: reason.into(),
        finished: started + Duration::from_millis(finished),
    };
    let measurements = [
        measurement(200, "length", 6, Some(100.0)),
        measurement(100, "stop", 0, None),
    ];
    let row = aggregate(&request(), (256, 2, 1), started, &measurements, None);
    assert_eq!(row.finish_reasons, ["length", "stop"]);
    assert_eq!(row.e2e_ms, 200.0);
    assert_eq!(row.first_output_ms, Some(50.0));
    assert_eq!(row.first_reasoning_ms, Some(50.0));
    assert_eq!(row.first_content_ms, None);
    assert_eq!(row.output_bytes, 18);
}

#[test]
fn per_request_counts_are_checked_in_slot_order_before_any_aggregate() {
    let started = Instant::now();
    let counted = |count: Option<u64>| protocol::Measurement {
        content_bytes: 1,
        reasoning_bytes: 0,
        first_output_ms: Some(1.0),
        first_content_ms: Some(1.0),
        first_reasoning_ms: None,
        reported_prompt_tokens: None,
        reported_completion_tokens: count,
        reported_cached_tokens: None,
        usage_status: if count.is_some() {
            "partial"
        } else {
            "missing"
        }
        .into(),
        finish_reason: "length".into(),
        finished: started,
    };
    assert_eq!(
        fixed_output_counts(4096, &[counted(Some(4096)), counted(Some(4096))]),
        Ok(vec![4096, 4096])
    );
    for (slots, expected) in [
        (
            vec![counted(Some(4095)), counted(Some(4097))],
            "request 1 stopped after 4095",
        ),
        (
            vec![counted(Some(4096)), counted(Some(4097))],
            "request 2 reported 4097",
        ),
        (
            vec![counted(Some(4096)), counted(None)],
            "request 2 did not report",
        ),
    ] {
        let error = fixed_output_counts(4096, &slots).unwrap_err();
        assert!(error.contains(expected), "{error}");
    }
    // A row whose aggregate matches but whose evidence differs is not fixed output.
    let mut row = aggregate(
        &PerformanceBenchRequest {
            max_output_tokens: 4096,
            ..request()
        },
        (256, 2, 1),
        started,
        &[counted(Some(4095)), counted(Some(4097))],
        None,
    );
    assert_eq!(row.reported_completion_tokens, Some(8192));
    row.reported_completion_tokens_by_request = Some(vec![4095, 4097]);
    assert!(row.validate());
    assert!(!row.validate_fixed_output(4096));
}
