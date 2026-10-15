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
    if let Some(index) = arguments.iter().position(|arg| arg == "--adapter-probe") {
        let engine = arguments.get(index + 1).expect("adapter engine ID");
        let runtime = arguments.get(index + 2).expect("adapter runtime ID");
        let model = arguments.get(index + 3).expect("adapter model binding");
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
        let extra = if mode == "v2" {
            "  --fresh-extra VALUE   synthetic option added by build two\n"
        } else {
            ""
        };
        println!(
            "usage: fake-engine [options] [TARGET]\n\npositional arguments:\n  TARGET                entry to serve\n\noptions:\n  -h, --help            show this help message and exit\n  --model MODEL         model path\n  --host HOST           bind address\n  -p, --port PORT       bind port\n  --fresh-count N       synthetic count, zero is meaningful\n  --fresh-label TEXT    synthetic label, empty is meaningful\n  --fresh-pair A B      synthetic fixed pair\n  --fresh-switch        synthetic switch\n{extra}"
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
    let port = port_arg();
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind fake llama-server port");
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => handle(stream),
            Err(_) => continue,
        }
    }
}
