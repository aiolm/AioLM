//! Deterministic stand-in for `llama-server`, used only by
//! `tests/smoke_fake.rs` so the process-spawn / `/health` polling / SSE
//! streaming path in `server.rs` gets real, always-on integration coverage
//! without needing a multi-GB model or `AIOLM_SMOKE=1`.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

fn port_arg() -> u16 {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|arg| arg == "--port")
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn handle(mut stream: TcpStream) {
    let mut reader = match stream.try_clone() {
        Ok(clone) => BufReader::new(clone),
        Err(_) => return,
    };
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut authorization = false;
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            authorization |= name.eq_ignore_ascii_case("authorization");
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut slow = false;
    if content_length > 0 {
        let mut body = vec![0_u8; content_length];
        let _ = reader.read_exact(&mut body);
        slow = String::from_utf8_lossy(&body).contains("slow");
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    if path == "/health"
        && authorization
        && std::env::args().any(|arg| arg == "--adapter-no-health-auth")
    {
        respond(
            &mut stream,
            "400 Bad Request",
            "text/plain",
            "Health endpoint must not receive credentials",
        );
        return;
    }
    match (method, path) {
        ("POST", "/completion") => {
            if std::env::args().any(|arg| arg == "--fake-no-generation") {
                respond(
                    &mut stream,
                    "500 Internal Server Error",
                    "application/json",
                    r#"{"error":{"type":"server_error","message":"context has no logits"}}"#,
                );
            } else {
                respond(
                    &mut stream,
                    "200 OK",
                    "application/json",
                    r#"{"content":"a","tokens_evaluated":1,"tokens_predicted":1}"#,
                );
            }
        }
        ("OPTIONS", _) => respond(&mut stream, "200 OK", "text/plain", ""),
        ("GET", "/health") => respond(
            &mut stream,
            "200 OK",
            "application/json",
            r#"{"status":"ok"}"#,
        ),
        ("GET", "/v1/models") => respond(
            &mut stream,
            "200 OK",
            "application/json",
            r#"{"data":[{"id":"fake-model","object":"model"}]}"#,
        ),
        ("POST", "/v1/rerank") => {
            if std::env::args().any(|arg| arg == "--fake-unverified-task-api") {
                respond(
                    &mut stream,
                    "404 Not Found",
                    "application/json",
                    r#"{"error":{"type":"unknown_endpoint"}}"#,
                );
            } else if std::env::args().any(|arg| arg == "--fake-rerank-mode") {
                respond(
                    &mut stream,
                    "400 Bad Request",
                    "application/json",
                    r#"{"error":{"type":"invalid_request_error","message":"\"documents\" must be a non-empty string array"}}"#,
                );
            } else {
                respond(
                    &mut stream,
                    "501 Not Implemented",
                    "application/json",
                    r#"{"error":{"type":"not_supported_error"}}"#,
                );
            }
        }
        ("POST", "/v1/embeddings") => {
            if !authorization {
                respond(
                    &mut stream,
                    "401 Unauthorized",
                    "application/json",
                    r#"{"error":{"type":"unauthorized"}}"#,
                );
            } else if std::env::args().any(|arg| arg == "--fake-embedding-mode") {
                respond(
                    &mut stream,
                    "200 OK",
                    "application/json",
                    r#"{"data":[{"embedding":[0.1,0.2]}]}"#,
                );
            } else if std::env::args().any(|arg| arg == "--fake-invalid-pooling") {
                respond(
                    &mut stream,
                    "400 Bad Request",
                    "application/json",
                    r#"{"error":{"type":"invalid_request_error","message":"pooling required"}}"#,
                );
            } else {
                respond(
                    &mut stream,
                    "501 Not Implemented",
                    "application/json",
                    r#"{"error":{"type":"not_supported_error"}}"#,
                );
            }
        }
        ("POST", "/v1/chat/completions") => {
            if slow {
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                for _ in 0..20 {
                    if stream
                        .write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"OK \"}}]}\n\n")
                        .is_err()
                    {
                        return;
                    }
                    let _ = stream.flush();
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                let _ = stream.write_all(b"data: [DONE]\n\n");
                return;
            }
            if std::env::args().any(|arg| arg == "--adapter-engine") {
                respond(&mut stream, "200 OK", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\ndata: [DONE]\n\n");
                return;
            }
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n";
            respond(&mut stream, "200 OK", "text/event-stream", body);
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", "not found"),
    }
}

fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments
        .iter()
        .any(|arg| arg == "--adapter-launcher-fixture")
    {
        // Like a venv `python.exe` redirector: run the real server as a child
        // with the remaining argv, wait for it and exit with its status, so
        // the HTTP listener is a descendant rather than the launched process.
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(
            arguments[1..]
                .iter()
                .filter(|arg| *arg != "--adapter-launcher-fixture"),
        );
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().expect("spawn synthetic launcher child");
        if let Ok(path) = std::env::var("FAKE_LAUNCHER_RECORD") {
            std::fs::write(
                path,
                serde_json::json!({"launcher": std::process::id(), "server": child.id()})
                    .to_string(),
            )
            .expect("record synthetic launcher identities");
        }
        let status = child.wait().expect("wait for synthetic launcher child");
        std::process::exit(status.code().unwrap_or(1));
    }
    if arguments
        .iter()
        .any(|arg| arg == "--adapter-context-contract-fixture")
    {
        let result = (|| -> Result<serde_json::Value, String> {
            use aiolm_lib::providers::{adapter, registry, runtime_schema};
            let cfg = aiolm_lib::config::load_result()?;
            let target = runtime_schema::help_target(&registry::root(), &cfg)?;
            let command = runtime_schema::help_command(&cfg, &target.request)?;
            let identity = command.identity(&std::sync::atomic::AtomicBool::new(false))?;
            let plan = adapter::resolve(&cfg).launch(&cfg, cfg.port, "", &Default::default())?;
            let mut process = std::process::Command::new(&plan.program);
            process.args(&plan.args).env_clear().envs(plan.env);
            if let Some(cwd) = &plan.working_directory {
                process.current_dir(cwd);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                process.creation_flags(0x08000000);
            }
            let output = process.output().map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned());
            }
            let actual: serde_json::Value =
                serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
            Ok(
                serde_json::json!({"help": identity.fingerprint, "help_cwd": command.working_directory,
                "launch_cwd": plan.working_directory, "actual": actual}),
            )
        })();
        println!(
            "{}",
            result.unwrap_or_else(|error| serde_json::json!({"error":error}))
        );
        return;
    }
    if let Some(index) = arguments
        .iter()
        .position(|arg| arg == "--adapter-setup-fixture")
    {
        let draft = arguments.get(index + 1).expect("synthetic draft file");
        if let Some(index) = arguments
            .iter()
            .position(|arg| arg == "--adapter-setup-slow")
        {
            let marker = arguments.get(index + 1).expect("synthetic marker path");
            std::fs::write(marker, std::process::id().to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(20));
        }
        print!("{}", std::fs::read_to_string(draft).unwrap());
        return;
    }
    if arguments
        .iter()
        .any(|arg| arg == "--adapter-resource-fixture")
        && !arguments
            .iter()
            .any(|arg| matches!(arg.as_str(), "--help" | "--adapter-probe"))
    {
        let directory = std::env::var_os("SYNTHETIC_LAUNCH_DIRECTORY").expect("owned directory");
        let directory = std::path::PathBuf::from(directory);
        std::fs::write(
            directory.join("effective-config.json"),
            b"synthetic configuration",
        )
        .unwrap();
        std::fs::write(
            std::env::var_os("FAKE_RESOURCE_RECORD").expect("resource evidence"),
            directory.to_string_lossy().as_bytes(),
        )
        .unwrap();
    }
    if arguments
        .iter()
        .any(|arg| arg == "--adapter-staging-log-fixture")
    {
        // Like a native engine under a bridge: a separate descendant without
        // the server's output pipes holds its log in the launch directory,
        // refusing deletion.
        let directory = std::env::var_os("SYNTHETIC_LAUNCH_DIRECTORY").expect("owned directory");
        let log = std::path::Path::new(&directory).join("engine.log");
        let holder = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--adapter-log-holder")
            .arg(&log)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn synthetic log holder");
        // It lives as long as this server; the owner's teardown ends both.
        std::mem::forget(holder);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !log.is_file() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    if let Some(index) = arguments
        .iter()
        .position(|arg| arg == "--adapter-log-holder")
    {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0x1); // FILE_SHARE_READ only
        }
        let mut log = options
            .open(arguments.get(index + 1).expect("log path"))
            .expect("open synthetic engine log");
        writeln!(log, "synthetic engine ready").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(120));
        return;
    }
    if arguments
        .iter()
        .any(|arg| arg == "--native-stderr-help-fixture")
    {
        // A native build that, like the pinned Strata engine, documents its
        // options on stderr only and exits 0.
        eprint!("native-engine generate [options]\n\n  --fresh-native N      synthetic native setting\n  --fresh-device LIST   synthetic device selection a deployment owns\n");
        return;
    }
    if arguments
        .iter()
        .any(|arg| arg == "--bridge-engine-argv-fixture")
    {
        // A separate, short-lived synthetic engine receives exact tokens
        // from the bridge. This is argv evidence, not inference evidence.
        std::fs::write(
            std::env::var("FAKE_BRIDGE_CHILD_ARGV_FILE").expect("bridge child argv path"),
            serde_json::to_vec(&arguments[1..]).unwrap(),
        )
        .unwrap();
        return;
    }
    if arguments
        .iter()
        .any(|arg| arg == "--adapter-bridge-fixture")
    {
        let engine: Vec<String> = serde_json::from_str(
            &std::env::var("SYNTHETIC_ENGINE_ARGV").expect("explicit bridge engine argv"),
        )
        .expect("bridge engine JSON argv");
        let phase = if arguments.iter().any(|arg| arg == "--help") {
            "help"
        } else if arguments.iter().any(|arg| arg == "--adapter-probe") {
            "probe"
        } else {
            "launch"
        };
        let path = std::env::var("FAKE_BRIDGE_LINK_FILE").expect("bridge evidence path");
        let mut evidence: serde_json::Value = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        evidence[phase] = serde_json::json!(engine);
        std::fs::write(path, serde_json::to_vec(&evidence).unwrap()).unwrap();
        if let Ok(streams) = std::env::var("FAKE_BRIDGE_NATIVE_HELP") {
            if phase == "help" {
                // The bridge documents its own bindings on stdout, then the
                // native help: "merged" gives the native child the same
                // stdout pipe for both streams, "separate" leaves its stderr.
                use std::io::Write;
                print!("bridge bindings:\n  --model MODEL   selected model\n  --port PORT     owned bind port\n\nnative engine options:\n");
                std::io::stdout().flush().unwrap();
                let mut native = std::process::Command::new(&engine[0]);
                native.arg("--native-stderr-help-fixture");
                if streams == "merged" {
                    native.stderr(std::io::stdout());
                }
                assert!(native.status().expect("native help").success());
                return;
            }
        }
        if phase == "launch" {
            let forwarded = arguments[1..].iter().filter(|arg| {
                !matches!(
                    arg.as_str(),
                    "--adapter-bridge-fixture" | "--adapter-engine" | "--adapter-no-health-auth"
                )
            });
            let status = std::process::Command::new(&engine[0])
                .args(&engine[1..])
                .args(forwarded)
                .status()
                .expect("spawn synthetic bridge engine");
            assert!(status.success(), "synthetic bridge engine failed");
        }
    }
    if let Some(index) = arguments.iter().position(|arg| arg == "--adapter-probe") {
        let engine = arguments.get(index + 1).expect("adapter engine ID");
        let runtime = arguments.get(index + 2).expect("adapter runtime ID");
        let model = arguments.get(index + 3).expect("adapter model binding");
        // Lets a test prove whether registration reached the probe at all.
        if let Ok(path) = std::env::var("FAKE_PROBE_MARKER") {
            std::fs::write(path, b"probed").expect("record probe marker");
        }
        if let Ok(path) = std::env::var("FAKE_PROBE_CWD_RECORD") {
            std::fs::write(
                path,
                serde_json::to_vec(&std::env::current_dir().unwrap()).unwrap(),
            )
            .unwrap();
        }
        if arguments.iter().any(|arg| arg == "--adapter-probe-jitter")
            && model.contains("slow-model")
        {
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        if arguments.iter().any(|arg| arg == "--adapter-probe-slow") {
            std::thread::sleep(std::time::Duration::from_secs(20));
        }
        if arguments.iter().any(|arg| arg == "--adapter-probe-fail") {
            eprintln!("synthetic probe: selected loader dependency is missing");
            std::process::exit(7);
        }
        println!(
            "{}",
            serde_json::json!({"schema_version":1,"engine_id":engine,"runtime_id":runtime,"version":"synthetic-adapter-1","accelerator":"cpu","model":model,"served_model":"fake-model","model_supported":model.is_empty() || std::path::Path::new(model).is_file(),"capabilities":{"tasks":["generate"],"modalities":{"text":true,"image":false,"audio":false,"video":false},"chat":true,"tools":false}})
        );
        return;
    }
    if arguments.iter().any(|arg| arg == "--adapter-help-fixture") {
        // Synthetic help for the help-to-launch journey. Option names are
        // fresh so no catalog or app code can know them in advance.
        let mode = std::env::var("FAKE_ENGINE_HELP").unwrap_or_default();
        if mode == "cp949" || mode == "cp949-broken" {
            // A localized Windows build writing help in code page 949
            // ("모델 이름 표시"), and the locale this child actually received.
            use std::io::Write;
            let mut out = std::io::stdout();
            out.write_all(b"usage: fake-engine [options]\n\noptions:\n  --model MODEL         model path\n  -p, --port PORT       bind port\n  --fresh-label TEXT    ").unwrap();
            out.write_all(&[
                0xb8, 0xf0, 0xb5, 0xa8, 0x20, 0xc0, 0xcc, 0xb8, 0xa7, 0x20, 0xc7, 0xa5, 0xbd, 0xc3,
            ])
            .unwrap();
            let locale = std::env::var("LC_ALL").unwrap_or_default();
            out.write_all(
                format!("\n  --fresh-locale VALUE  received LC_ALL={locale}\n").as_bytes(),
            )
            .unwrap();
            if mode == "cp949-broken" {
                out.write_all(&[0x81]).unwrap(); // unfinished CP949 lead byte
            }
            std::io::stderr()
                .write_all(&[
                    0xb8, 0xf0, 0xb5, 0xa8, 0x20, 0xc0, 0xcc, 0xb8, 0xa7, 0x20, 0xc7, 0xa5, 0xbd,
                    0xc3, b'\n',
                ])
                .unwrap();
            return;
        }
        let extra = match mode.as_str() {
            "v2" => "  --fresh-extra VALUE   synthetic option added by build two\n",
            // An alias for per-occurrence spelling, and aliases that disagree
            // on the value count so help leaves that count unknown.
            "order" => "  -t TAG, --fresh-tag TAG   synthetic tag with an alias\n  -i X, --fresh-items X Y   synthetic items whose aliases disagree\n",
            // A rebuilt engine that now documents the item count.
            "order2" => "  -t TAG, --fresh-tag TAG   synthetic tag with an alias\n  --fresh-items X Y   synthetic items, two per occurrence\n",
            // Options whose type, unit, secrecy and choices only explicit
            // adapter metadata can describe; help shows syntax alone.
            // The shapes a two-layer serving entry point documents (engine
            // selector, config file, lifecycle and tool switches).
            "server" => "  --engine {mock,strata}\n  --config CONFIG       engine config file\n  --api-key API_KEY     require this key\n  --mcp-config MCP_CONFIG  tool servers file\n  --lazy                start unloaded\n  --idle-unload SECONDS  unload when idle\n  --before-load BEFORE_LOAD  run before loading\n  --fit-max-tokens      clamp max tokens\n",
            "metadata" => "  --fresh-secret TOKEN  synthetic credential-like value\n  --fresh-cache N       synthetic cache size\n  --fresh-mode {fast,safe}  synthetic mode with documented choices\n  --fresh-amber VALUE   synthetic value only explicit metadata calls secret\n",
            _ => "",
        };
        println!(
            "usage: fake-engine [options] [TARGET]\n\npositional arguments:\n  TARGET                entry to serve\n\noptions:\n  -h, --help            show this help message and exit\n  --model MODEL         model path\n  --host HOST           bind address\n  -p, --port PORT       bind port\n  --fresh-count N       synthetic count, zero is meaningful\n  --fresh-label TEXT    synthetic label, empty is meaningful\n  --fresh-pair A B      synthetic fixed pair\n  --fresh-switch        synthetic switch\n{extra}"
        );
        return;
    }
    if arguments
        .get(1)
        .is_some_and(|arg| arg == "--adapter-command-contract-fixture")
    {
        let result = (|| -> Result<serde_json::Value, String> {
            let mut parsed = serde_json::json!({"pairs":[]});
            let mut stage = 0;
            let mut index = 3; // fixture mode and one fixed script token
            while index < arguments.len() {
                let token = &arguments[index];
                index += 1;
                if (stage == 0 && token == "serve") || (stage == 1 && token == "api") {
                    stage += 1;
                    continue;
                }
                // The leaf scope's documented TARGET positional, once.
                if stage == 2 && !token.starts_with('-') && parsed.get("target").is_none() {
                    parsed["target"] = token.clone().into();
                    continue;
                }
                let key = match (stage, token.as_str()) {
                    (0, "--label") => "label",
                    (0, "--global-name") => "global",
                    (1, "--worker-mode") => "worker",
                    (2, "--model") => "model",
                    (2, "--port") => "port",
                    (2, "--fresh-count") => "count",
                    (2, "--fresh-pair") => "pairs",
                    _ => return Err(format!("unexpected {token} in scope {stage}")),
                };
                let value = arguments.get(index).ok_or("missing option value")?.clone();
                index += 1;
                if key == "pairs" {
                    let second = arguments.get(index).ok_or("missing tuple member")?.clone();
                    index += 1;
                    parsed[key]
                        .as_array_mut()
                        .unwrap()
                        .push(serde_json::json!([value, second]));
                } else if key == "count" {
                    parsed[key] = value.parse::<u64>().map_err(|e| e.to_string())?.into();
                } else {
                    parsed[key] = value.into();
                }
            }
            if stage != 2
                || parsed["model"]
                    .as_str()
                    .is_none_or(|model| !std::path::Path::new(model).is_file())
                || parsed["port"]
                    .as_str()
                    .is_none_or(|port| port.parse::<u16>().is_err())
            {
                return Err("incomplete command contract".into());
            }
            Ok(serde_json::json!({"argv":&arguments[1..],"parsed":parsed}))
        })();
        match result {
            Ok(value) => println!("{value}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        return;
    }
    if arguments
        .iter()
        .any(|arg| arg == "--adapter-observe-context-fixture")
    {
        println!(
            "{}",
            serde_json::json!({"argv": &arguments[1..], "cwd": std::env::current_dir().unwrap()})
        );
        return;
    }
    if arguments.iter().any(|arg| arg == "--adapter-engine") {
        if let Ok(path) = std::env::var("FAKE_ENGINE_ARGV_FILE") {
            std::fs::write(path, serde_json::to_vec(&arguments[1..]).unwrap())
                .expect("record fixture argv");
        }
    }
    if std::env::args().any(|arg| arg == "--version" || arg == "--help") {
        println!("llama-server test fixture b1\n--model MODEL   model path\n--port PORT   server port\n--api-key KEY   credential\n--api-key-file FILE   credential file\n--ctx-size N   context size\n--threads N   worker count\n--temp N   sampling temperature\n--top-p N   sampling probability\n--top-k N   sampling count\n--fixture-native-value TEXT   synthetic native option");
        return;
    }
    if std::env::args().any(|arg| arg == "--fake-startup-failure") {
        let args = std::env::args().collect::<Vec<_>>();
        let key = args
            .iter()
            .position(|arg| arg == "--api-key-file")
            .and_then(|index| args.get(index + 1))
            .map(|path| std::fs::read_to_string(path).expect("read fixture credential"))
            .unwrap_or_default();
        let mut output = std::io::stdout().lock();
        output.write_all(&vec![b'x'; 65536]).unwrap();
        writeln!(
            output,
            "\nengine core: synthetic allocation failed 🙂; credential={}",
            key.trim()
        )
        .unwrap();
        output.flush().unwrap();
        drop(output);
        let mut errors = std::io::stderr().lock();
        errors.write_all(&vec![b'y'; 65536]).unwrap();
        writeln!(
            errors,
            "\nAPI wrapper: engine initialization failed; see engine core output above."
        )
        .unwrap();
        errors.flush().unwrap();
        std::process::exit(7);
    }
    if arguments.iter().any(|arg| arg == "--adapter-hold-fixture") {
        // A live managed tree that never listens, so only an unrelated
        // process can answer on the configured port. Bounded if leaked.
        std::thread::sleep(std::time::Duration::from_secs(120));
        return;
    }
    let port = port_arg();
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind fake llama-server port");
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => handle(stream),
            Err(_) => continue,
        }
    }
}
