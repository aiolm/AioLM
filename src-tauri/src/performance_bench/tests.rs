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
        max_output_tokens: 128,
        concurrencies: vec![2],
        repetitions: 3,
        warmup: false,
        request_usage: false,
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

struct Reply {
    data: String,
    delay: Duration,
    stall: bool,
}
impl Reply {
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

async fn fixture(replies: Vec<Reply>) -> (reqwest::Client, reqwest::Request, HttpOwner) {
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
    let mut engine = EngineInfo::llama(
        "selected-model",
        crate::providers::artifacts::Modalities::text_only(),
    );
    // Saved sampling defaults must not enter a common benchmark request.
    engine.request_fields.insert("top_k".into(), json!(7));
    let request = point_request(
        &client,
        &url,
        "synthetic-key",
        &engine,
        corpus::text("novel_ko", 256),
        &request(),
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
        profile,
        model,
        workload,
        None,
        "Synthetic model".into(),
    ));
    result
}

#[tokio::test]
async fn completed_http_trials_checkpoint_but_eof_and_cancel_discard_whole_batches() {
    let request = request();
    let root = std::env::temp_dir().join(format!("aiolm-serving-journal-{}", uuid::Uuid::new_v4()));
    struct Directory(PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _directory = Directory(root.clone());
    let mut result = result(&request);
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
    let cancel = AtomicBool::new(false);
    let mut delayed = Reply::done(Value::Null, Some("stop"));
    delayed.delay = Duration::from_millis(50);
    let (client, buffered, owner) =
        fixture(vec![delayed, Reply::done(Value::Null, Some("length"))]).await;
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
    assert_eq!(result.rows[0].output_bytes, 24);
    assert_eq!(result.rows[0].content_bytes, 12);
    assert_eq!(result.rows[0].reasoning_bytes, 12);
    assert_eq!(result.rows[0].usage_status, "missing");
    assert_eq!(result.rows[0].reported_completion_tokens, None);
    assert_eq!(result.rows[0].finish_reasons.len(), 2);
    assert!(
        result.rows[0].e2e_ms >= 40.0,
        "batch E2E includes the last DONE"
    );
    assert!(owner
        .receipts
        .lock()
        .unwrap()
        .iter()
        .all(|r| r["line"] == "POST /v1/chat/completions HTTP/1.1"
            && r["body"].as_object().unwrap().len() == 5));
    drop(owner);
    let kept = serde_json::to_value(&result.rows).unwrap();
    let (client, buffered, _owner) = fixture(vec![
        Reply::done(Value::Null, None),
        Reply {
            data: "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".into(),
            delay: Duration::ZERO,
            stall: false,
        },
    ])
    .await;
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
    assert!(failure.contains("repetition 2"));
    assert_eq!(serde_json::to_value(&result.rows).unwrap(), kept);
    let (client, buffered, owner) = fixture(vec![
        Reply::done(Value::Null, None),
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
    let page = crate::benchmark::store::list(&root, 0, 10).unwrap();
    assert!(page.warnings.is_empty(), "{:?}", page.warnings);
    assert_eq!(page.records[0]["schemaVersion"], 2);
    assert_eq!(page.records[0]["result"]["rows"], kept);
    assert_eq!(
        page.records[0]["result"]["provenance"]["workload"]["inputs"][0]["bytes"],
        256
    );
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
        let (started, measurements) = batch(&client, &buffered, 2, &AtomicBool::new(false))
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
    }
}

#[tokio::test]
async fn explicit_usage_request_is_uniform_even_when_support_is_unknown_and_usage_is_missing() {
    for supported in [None, Some(false), Some(true)] {
        let (client, buffered, owner) = fixture(vec![Reply::done(Value::Null, None)]).await;
        let base = buffered
            .url()
            .as_str()
            .trim_end_matches("/chat/completions");
        let mut engine = EngineInfo::llama(
            "selected-model",
            crate::providers::artifacts::Modalities::text_only(),
        );
        engine.stream_usage_supported = supported;
        let request = PerformanceBenchRequest {
            request_usage: true,
            concurrencies: vec![1],
            ..request()
        };
        let buffered = point_request(
            &client,
            base,
            "synthetic-key",
            &engine,
            corpus::text("novel_ko", 256),
            &request,
        )
        .unwrap();
        let (started, measurements) = batch(&client, &buffered, 1, &AtomicBool::new(false))
            .await
            .unwrap();
        let row = aggregate(&request, (256, 1, 1), started, &measurements, None);
        assert_eq!(row.usage_status, "missing");
        assert_eq!(row.output_bytes, 12);
        assert_eq!(
            owner.receipts.lock().unwrap()[0]["body"]["stream_options"],
            json!({"include_usage":true})
        );
    }
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
