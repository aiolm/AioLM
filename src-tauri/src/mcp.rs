// Local MCP stdio client with explicit per-call approval.
use crate::procutil::{OwnedTask, TransientChild};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::time::timeout;

const MCP_FILE: &str = "mcp-servers.json";
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RPC_LINE: usize = 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES: usize = 256 * 1024;
const MAX_APPROVAL_DESCRIPTION_BYTES: usize = 4096;
const PROTOCOL_VERSION: &str = "2024-11-05";
/// An unanswered approval must not hold its MCP server open indefinitely.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const TOOL_CALL_CANCELLED: &str = "MCP tool call cancelled";
const APPROVAL_TITLE: &str = "MCP tool approval required";

#[cfg(windows)]
mod native_approval;
static CONFIG_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Value,
}

fn default_enabled() -> bool {
    true
}

fn contains_forbidden_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character == '\0' || character == '\r' || character == '\n')
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn validate_server(server: &McpServer) -> Result<(), String> {
    if !valid_id(&server.id) {
        return Err("MCP server id must contain only letters, numbers, '-' or '_'.".into());
    }
    if server.name.trim().is_empty() || server.name.len() > 80 {
        return Err("MCP server name must be between 1 and 80 characters.".into());
    }
    if server.command.trim().is_empty()
        || server.command.len() > 512
        || contains_forbidden_control(&server.command)
        || server
            .command
            .chars()
            .any(|character| matches!(character, '&' | '|' | ';' | '<' | '>'))
    {
        return Err(
            "MCP command must be one executable path; shell operators are not allowed.".into(),
        );
    }
    if server.args.len() > 64
        || server
            .args
            .iter()
            .any(|argument| argument.len() > 4096 || contains_forbidden_control(argument))
    {
        return Err("MCP arguments must be at most 64 newline-free values.".into());
    }
    Ok(())
}

fn config_path() -> Result<PathBuf, String> {
    crate::home::resolve_aiolm_home().map(|home| home.join(MCP_FILE))
}

async fn load_servers() -> Result<Vec<McpServer>, String> {
    let path = config_path()?;
    if !tokio::fs::try_exists(&path)
        .await
        .map_err(|error| format!("cannot inspect MCP config: {error}"))?
    {
        return Ok(Vec::new());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("cannot read MCP config: {error}"))?;
    let servers: Vec<McpServer> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("cannot parse MCP config: {error}"))?;
    for server in &servers {
        validate_server(server)?;
    }
    Ok(servers)
}

async fn save_servers(servers: &[McpServer]) -> Result<(), String> {
    for server in servers {
        validate_server(server)?;
    }
    let path = config_path()?;
    let directory = path
        .parent()
        .ok_or_else(|| "MCP config has no parent directory".to_string())?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("cannot create MCP config directory: {error}"))?;
    let temp = directory.join(format!(".mcp-servers-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(servers)
        .map_err(|error| format!("cannot encode MCP config: {error}"))?;
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|error| format!("cannot stage MCP config: {error}"))?;
    if let Err(error) = activate_staged_file(&temp, &path).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(format!("cannot activate MCP config: {error}"));
    }
    Ok(())
}

/// Activate a staged config without relying on POSIX rename-overwrite semantics.
/// Windows' `MoveFileEx` equivalent is not exposed by Tokio's portable API and
/// `tokio::fs::rename` fails when the destination already exists. Moving the old
/// file to a sibling backup first keeps replacement recoverable if activation
/// fails, while retaining same-directory atomic renames for each step.
async fn activate_staged_file(temp: &PathBuf, path: &PathBuf) -> Result<(), std::io::Error> {
    let backup = path.with_extension(format!("json.backup-{}", uuid::Uuid::new_v4()));
    let had_existing = tokio::fs::try_exists(path).await?;
    if had_existing {
        tokio::fs::rename(path, &backup).await?;
    }
    match tokio::fs::rename(temp, path).await {
        Ok(()) => {
            if had_existing {
                let _ = tokio::fs::remove_file(&backup).await;
            }
            Ok(())
        }
        Err(error) => {
            if had_existing && tokio::fs::try_exists(&backup).await.unwrap_or(false) {
                let _ = tokio::fs::rename(&backup, path).await;
            }
            Err(error)
        }
    }
}

fn config_lock() -> &'static tokio::sync::Mutex<()> {
    CONFIG_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn append_bounded_line(target: &mut Vec<u8>, bytes: &[u8]) -> Result<(), String> {
    if target.len().saturating_add(bytes.len()) > MAX_RPC_LINE {
        return Err("MCP response exceeded the 1 MiB safety limit".to_string());
    }
    target.extend_from_slice(bytes);
    Ok(())
}

fn inherited_environment() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    // MCP servers are third-party executables. Do not hand them the complete
    // desktop process environment, which commonly contains API keys/tokens.
    const ALLOWED: &[&str] = &[
        "PATH",
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "CommonProgramW6432",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_ARCHITEW6432",
        "OS",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOME",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
    ];
    ALLOWED
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| ((*name).into(), value)))
        .collect()
}

async fn spawn_session(server: &McpServer) -> Result<McpSession, String> {
    if !server.enabled {
        return Err("MCP server is disabled".into());
    }
    let mut command = crate::procutil::tokio_command(&server.command);
    crate::procutil::configure_process_group(&mut command);
    command
        .args(&server.args)
        .env_clear()
        .envs(inherited_environment())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = TransientChild::spawn(&mut command)
        .map_err(|error| format!("cannot start MCP server '{}': {error}", server.name))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "MCP server stdin was not captured".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP server stdout was not captured".to_string())?;
    // Drained but discarded: an MCP server's stderr is diagnostic chatter,
    // not protocol traffic. The handle is still retained and joined in
    // `close_session` so the reader task cannot outlive the session it
    // belongs to.
    let stderr_drain = child.stderr.take().map(|mut stderr| {
        OwnedTask::from(tokio::spawn(async move {
            let mut buffer = [0_u8; 4096];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        }))
    });
    let mut session = McpSession {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        stderr_drain,
    };
    let initialized = async {
        send_message(
            &mut session.stdin,
            1,
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "aiolm", "version": env!("CARGO_PKG_VERSION")}
            }),
        )
        .await?;
        let _ = read_response(&mut session.stdout, 1).await?;
        send_notification(&mut session.stdin, "notifications/initialized", json!({})).await
    }
    .await;
    if let Err(error) = initialized {
        close_session(session).await;
        return Err(error);
    }
    Ok(session)
}

struct McpSession {
    child: TransientChild,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_drain: Option<OwnedTask<()>>,
}

async fn send_message(
    stdin: &mut ChildStdin,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    write_line(stdin, message).await
}

async fn send_notification(
    stdin: &mut ChildStdin,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let message = json!({"jsonrpc": "2.0", "method": method, "params": params});
    write_line(stdin, message).await
}

async fn write_line(stdin: &mut ChildStdin, message: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&message)
        .map_err(|error| format!("cannot encode MCP request: {error}"))?;
    bytes.push(b'\n');
    timeout(RPC_TIMEOUT, async {
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| format!("cannot write MCP request: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("cannot flush MCP request: {error}"))
    })
    .await
    .map_err(|_| "MCP request write timed out after 15 seconds".to_string())?
}

async fn read_bounded_line(reader: &mut BufReader<ChildStdout>) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|error| format!("cannot read MCP response: {error}"))?;
        if buffer.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|error| format!("MCP response was not UTF-8: {error}"));
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        append_bounded_line(&mut bytes, &buffer[..take])?;
        reader.consume(take);
        if newline.is_some() {
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|error| format!("MCP response was not UTF-8: {error}"));
        }
    }
}

async fn read_response(reader: &mut BufReader<ChildStdout>, id: u64) -> Result<Value, String> {
    let read = timeout(RPC_TIMEOUT, async {
        loop {
            let Some(line) = read_bounded_line(reader).await? else {
                return Err("MCP server closed stdout before responding".to_string());
            };
            let message: Value = serde_json::from_str(&line)
                .map_err(|error| format!("MCP returned invalid JSON: {error}"))?;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!("MCP request failed: {error}"));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    })
    .await
    .map_err(|_| "MCP request timed out after 15 seconds".to_string())?;
    read
}

async fn close_session(mut session: McpSession) {
    // The Job object (Windows) or process group (Unix) owns the whole tree, so
    // one terminate reaches every descendant before the root is reaped.
    session.child.terminate();
    let _ = session.child.wait().await;
    // The child's stdio pipes close on exit, which lets this reader task
    // finish on its own; joining it here guarantees the task is gone before
    // the session is considered closed instead of leaking it indefinitely.
    if let Some(mut drain) = session.stderr_drain.take() {
        // A server may have passed stderr to a detached descendant. Do not let
        // that inherited pipe keep the caller waiting forever after shutdown.
        if timeout(Duration::from_secs(2), &mut drain).await.is_err() {
            drain.abort();
            let _ = drain.await;
        }
    }
}

pub async fn list() -> Result<Vec<McpServer>, String> {
    load_servers().await
}

pub async fn save(server: McpServer) -> Result<Vec<McpServer>, String> {
    let _config_guard = config_lock().lock().await;
    let mut servers = load_servers().await?;
    validate_server(&server)?;
    if let Some(existing) = servers
        .iter_mut()
        .find(|candidate| candidate.id == server.id)
    {
        *existing = server;
    } else {
        servers.push(server);
    }
    save_servers(&servers).await?;
    Ok(servers)
}

pub async fn remove(id: &str) -> Result<Vec<McpServer>, String> {
    if !valid_id(id) {
        return Err("invalid MCP server id".into());
    }
    let _config_guard = config_lock().lock().await;
    let mut servers = load_servers().await?;
    servers.retain(|server| server.id != id);
    save_servers(&servers).await?;
    Ok(servers)
}

pub async fn tools(id: &str) -> Result<Vec<McpTool>, String> {
    let server = load_servers()
        .await?
        .into_iter()
        .find(|server| server.id == id)
        .ok_or_else(|| "MCP server was not found".to_string())?;
    let mut session = spawn_session(&server).await?;
    let result = send_tools_request(&mut session).await;
    close_session(session).await;
    let result = result?;
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "MCP tools/list returned no tools array".to_string())?;
    tools
        .iter()
        .cloned()
        .map(|tool| {
            serde_json::from_value(tool)
                .map_err(|error| format!("invalid MCP tool metadata: {error}"))
        })
        .collect()
}

async fn send_tools_request(session: &mut McpSession) -> Result<Value, String> {
    send_message(&mut session.stdin, 2, "tools/list", json!({})).await?;
    read_response(&mut session.stdout, 2).await
}

fn validate_tool_arguments(schema: &Value, arguments: &Value) -> Result<(), String> {
    let Some(schema) = schema.as_object() else {
        return Ok(());
    };
    let Some(arguments) = arguments.as_object() else {
        return Err("MCP tool arguments must be a JSON object".into());
    };
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for field in required.iter().filter_map(Value::as_str) {
            if !arguments.contains_key(field) {
                return Err(format!("MCP tool argument '{field}' is required"));
            }
        }
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (field, value) in arguments {
            let Some(expected) = properties
                .get(field)
                .and_then(Value::as_object)
                .and_then(|property| property.get("type"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let valid = match expected {
                "string" => value.is_string(),
                "number" => value.is_number(),
                "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
                "boolean" => value.is_boolean(),
                "object" => value.is_object(),
                "array" => value.is_array(),
                "null" => value.is_null(),
                _ => true,
            };
            if !valid {
                return Err(format!("MCP tool argument '{field}' must be {expected}"));
            }
        }
    }
    Ok(())
}

fn tool_approval_description(server: &McpServer, name: &str, arguments: &Value) -> String {
    let serialized = serde_json::to_string(arguments).unwrap_or_else(|_| "<unserializable>".into());
    let description = format!(
        "Server: {} ({})\nTool: {}\nArguments: {}\n\nAllow this one-time MCP tool call?",
        server.name, server.id, name, serialized
    );
    if description.len() <= MAX_APPROVAL_DESCRIPTION_BYTES {
        return description;
    }
    let mut bounded = description;
    bounded.truncate(MAX_APPROVAL_DESCRIPTION_BYTES.saturating_sub("\n…".len()));
    bounded.push_str("\n…");
    bounded
}

async fn confirm_tool_call(
    server: &McpServer,
    name: &str,
    arguments: &Value,
) -> Result<(), String> {
    let description = tool_approval_description(server, name, arguments);
    // Windows: the prompt belongs to this future, so a Stop, the approval
    // timeout or shutdown closes the dialog and ends its thread.
    #[cfg(windows)]
    let approved = native_approval::Prompt::open(APPROVAL_TITLE, &description)?
        .answer()
        .await?;
    #[cfg(not(windows))]
    let approved = rfd::AsyncMessageDialog::new()
        .set_title(APPROVAL_TITLE)
        .set_description(description)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await
        == rfd::MessageDialogResult::Yes;
    if approved {
        Ok(())
    } else {
        Err("MCP tool call rejected by the user".into())
    }
}

/// Run one approved tool call. With a caller-chosen `call_id` it can be
/// stopped through [`cancel_tool_call`]; the id is registered before any other
/// work, so a Stop can never fall between registration and the first await.
pub async fn call_tool_with_id(
    id: &str,
    name: &str,
    arguments: Value,
    call_id: Option<&str>,
) -> Result<Value, String> {
    // A call without a caller id still registers under a private one, so
    // shutdown can cancel it like any other.
    let call_id = call_id
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (_registration, mut cancel) = register_tool_call(&call_id)?;
    if name.is_empty() || name.len() > 256 || contains_forbidden_control(name) {
        return Err("invalid MCP tool name".into());
    }
    if !arguments.is_object() {
        return Err("MCP tool arguments must be a JSON object".into());
    }
    let argument_bytes = serde_json::to_vec(&arguments)
        .map_err(|error| format!("cannot encode MCP tool arguments: {error}"))?;
    if argument_bytes.len() > MAX_TOOL_ARGUMENT_BYTES {
        return Err("MCP tool arguments exceed the 256 KiB safety limit".into());
    }
    let server = cancel
        .guard(load_servers())
        .await??
        .into_iter()
        .find(|server| server.id == id)
        .ok_or_else(|| "MCP server was not found".to_string())?;
    run_tool_call(
        &server,
        name,
        &arguments,
        cancel,
        || confirm_tool_call(&server, name, &arguments),
        APPROVAL_TIMEOUT,
    )
    .await
}

/// Run one approved tool call on its own session. Cancellation drops the
/// pending step (spawn, RPC or the approval wait) and always reclaims the
/// session; a call cancelled before approval never sends `tools/call`.
async fn run_tool_call<F, Fut>(
    server: &McpServer,
    name: &str,
    arguments: &Value,
    mut cancel: CallCancel,
    approve: F,
    approval_timeout: Duration,
) -> Result<Value, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    // A dropped spawn future still owns its TransientChild, which terminates
    // the process tree, so an early cancel needs no separate cleanup.
    let mut session = cancel.guard(spawn_session(server)).await??;
    let approval_cancel = cancel.clone();
    let work = async {
        let tool_list = send_tools_request(&mut session).await?;
        let tool = tool_list
            .get("tools")
            .and_then(Value::as_array)
            .and_then(|tools| {
                tools
                    .iter()
                    .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
            })
            .ok_or_else(|| format!("MCP tool '{name}' is not declared by the server"))?;
        if let Some(schema) = tool.get("inputSchema") {
            validate_tool_arguments(schema, arguments)?;
        }
        timeout(approval_timeout, approve())
            .await
            .map_err(|_| "MCP tool approval timed out".to_string())??;
        // The approval may have resolved in the same instant as a Stop; the
        // tool must not run once the caller has cancelled.
        if approval_cancel.is_cancelled() {
            return Err(TOOL_CALL_CANCELLED.to_string());
        }
        send_message(
            &mut session.stdin,
            2,
            "tools/call",
            json!({"name": name, "arguments": arguments}),
        )
        .await?;
        read_response(&mut session.stdout, 2).await
    };
    let result = cancel.guard(work).await.and_then(|result| result);
    close_session(session).await;
    result
}

/// Cancellation state of one caller-identified tool call. A cancel that
/// arrives before its call registers leaves a short-lived tombstone, so the
/// two IPC requests may reach the backend in either order.
enum CallSlot {
    Active(tokio::sync::watch::Sender<bool>),
    Cancelled(std::time::Instant),
}

const CANCELLED_CALL_RETENTION: Duration = Duration::from_secs(60);
const MAX_CANCELLED_CALLS: usize = 256;
const MAX_ACTIVE_CALLS: usize = 32;

fn tool_calls() -> &'static std::sync::Mutex<HashMap<String, CallSlot>> {
    static CALLS: OnceLock<std::sync::Mutex<HashMap<String, CallSlot>>> = OnceLock::new();
    CALLS.get_or_init(Default::default)
}

fn prune_cancelled_calls(calls: &mut HashMap<String, CallSlot>, keep: usize) {
    let now = std::time::Instant::now();
    calls.retain(|_, slot| match slot {
        CallSlot::Active(_) => true,
        CallSlot::Cancelled(at) => now.duration_since(*at) < CANCELLED_CALL_RETENTION,
    });
    let mut tombstones = calls
        .iter()
        .filter_map(|(id, slot)| match slot {
            CallSlot::Cancelled(at) => Some((*at, id.clone())),
            CallSlot::Active(_) => None,
        })
        .collect::<Vec<_>>();
    if tombstones.len() > keep {
        tombstones.sort();
        for (_, id) in &tombstones[..tombstones.len() - keep] {
            calls.remove(id);
        }
    }
}

fn lock_tool_calls() -> std::sync::MutexGuard<'static, HashMap<String, CallSlot>> {
    tool_calls()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// Cancel the tool call registered under `call_id`, or the one that is about
/// to register under it.
pub fn cancel_tool_call(call_id: &str) -> Result<(), String> {
    if !valid_id(call_id) {
        return Err("invalid MCP tool call id".into());
    }
    record_cancel(&mut lock_tool_calls(), call_id);
    Ok(())
}

fn record_cancel(calls: &mut HashMap<String, CallSlot>, call_id: &str) {
    match calls.get(call_id) {
        Some(CallSlot::Active(sender)) => {
            sender.send_replace(true);
        }
        Some(CallSlot::Cancelled(_)) => {}
        None => {
            // Make room first, so the bound holds and this record is kept.
            prune_cancelled_calls(calls, MAX_CANCELLED_CALLS - 1);
            calls.insert(
                call_id.to_string(),
                CallSlot::Cancelled(std::time::Instant::now()),
            );
        }
    }
}

fn cancel_active_calls(calls: &HashMap<String, CallSlot>) {
    for slot in calls.values() {
        if let CallSlot::Active(sender) = slot {
            sender.send_replace(true);
        }
    }
}

/// Application shutdown: cancel every running tool call and withdraw any
/// approval prompt at once, without waiting for their tasks to be polled.
pub fn cancel_all_tool_calls() {
    cancel_active_calls(&lock_tool_calls());
    #[cfg(windows)]
    native_approval::dismiss_all();
}

/// Keeps a call id registered for exactly as long as its call runs.
struct CallRegistration(String);

impl Drop for CallRegistration {
    fn drop(&mut self) {
        let mut calls = lock_tool_calls();
        if matches!(calls.get(&self.0), Some(CallSlot::Active(_))) {
            calls.remove(&self.0);
        }
    }
}

fn register_tool_call(call_id: &str) -> Result<(CallRegistration, CallCancel), String> {
    if !valid_id(call_id) {
        return Err("invalid MCP tool call id".into());
    }
    let receiver = admit_call(&mut lock_tool_calls(), call_id)?;
    Ok((
        CallRegistration(call_id.to_string()),
        CallCancel(Some(receiver)),
    ))
}

fn admit_call(
    calls: &mut HashMap<String, CallSlot>,
    call_id: &str,
) -> Result<tokio::sync::watch::Receiver<bool>, String> {
    prune_cancelled_calls(calls, MAX_CANCELLED_CALLS);
    match calls.get(call_id) {
        Some(CallSlot::Active(_)) => Err("MCP tool call id is already in use".into()),
        Some(CallSlot::Cancelled(_)) => {
            calls.remove(call_id);
            Err(TOOL_CALL_CANCELLED.into())
        }
        None => {
            let active = calls
                .values()
                .filter(|slot| matches!(slot, CallSlot::Active(_)))
                .count();
            // Each running call owns an MCP server process.
            if active >= MAX_ACTIVE_CALLS {
                return Err("too many MCP tool calls are already running".into());
            }
            let (sender, receiver) = tokio::sync::watch::channel(false);
            calls.insert(call_id.to_string(), CallSlot::Active(sender));
            Ok(receiver)
        }
    }
}

/// The cancellation signal a tool call observes; `None` never fires.
#[derive(Clone)]
struct CallCancel(Option<tokio::sync::watch::Receiver<bool>>);

impl CallCancel {
    fn is_cancelled(&self) -> bool {
        self.0.as_ref().is_some_and(|receiver| *receiver.borrow())
    }

    async fn cancelled(&mut self) {
        match self.0.as_mut() {
            // The sender lives as long as the registration, which outlives
            // every wait; a closed channel is never a cancel.
            Some(receiver) => {
                if receiver.wait_for(|cancelled| *cancelled).await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
            None => std::future::pending().await,
        }
    }

    /// Run `work` unless the call is cancelled first. A cancel that is
    /// already pending wins over work that is ready in the same poll.
    async fn guard<T>(&mut self, work: impl std::future::Future<Output = T>) -> Result<T, String> {
        tokio::select! {
            biased;
            _ = self.cancelled() => Err(TOOL_CALL_CANCELLED.to_string()),
            value = work => Ok(value),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(windows, unix))]
    fn node_fixture(root: &std::path::Path, script: &str) -> McpServer {
        // Use the project's Node runtime to keep fixture startup independent
        // of PowerShell host initialization and command-input handling.
        let path = root.join("server.mjs");
        let prelude = r#"import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
const record = (name, value) => writeFileSync(join(root, name), String(value));
"#;
        std::fs::write(&path, format!("{prelude}{script}")).unwrap();
        McpServer {
            args: vec![
                path.to_string_lossy().into_owned(),
                root.to_string_lossy().into_owned(),
            ],
            ..server("node")
        }
    }

    #[cfg(windows)]
    fn lifecycle_fixture(root: &std::path::Path, response: &str) -> McpServer {
        let script = format!(
            r#"import {{ spawn }} from 'node:child_process';
record('parent.pid', process.pid);
const child = spawn('ping.exe', ['-n', '60', '127.0.0.1'], {{ windowsHide: true, stdio: 'ignore' }});
child.on('error', error => {{ throw error; }});
child.on('spawn', () => {{
    record('descendant.pid', child.pid);
    {response};
    setTimeout(() => {{}}, 60000);
}});
"#
        );
        node_fixture(root, &script)
    }

    #[cfg(any(windows, unix))]
    struct LifecycleFixture(std::path::PathBuf);

    #[cfg(any(windows, unix))]
    impl LifecycleFixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("aiolm-mcp-lifecycle-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }

    #[cfg(any(windows, unix))]
    impl Drop for LifecycleFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn unix_monitored_fixture(root: &std::path::Path, port: u16, mode: &str) -> McpServer {
        // Separate lifetime sockets make cleanup observable without PID reuse
        // races or platform-specific zombie/reaping assumptions. Both the MCP
        // process and its background child retain one socket until they exit.
        let descendant = format!(
            "const socket = require('node:net').createConnection({{ host: '127.0.0.1', port: {port} }}, () => process.send('ready')); setTimeout(() => {{}}, 60000);"
        );
        let script = format!(
            r#"import {{ createConnection }} from 'node:net';
import {{ spawn }} from 'node:child_process';
import {{ createInterface }} from 'node:readline';
let connected = 0;
const ready = () => {{
    if (++connected === 2 && {mode} === 'invalid') process.stdout.write('invalid-json\n');
}};
const lifetime = createConnection({{ host: '127.0.0.1', port: {port} }}, ready);
lifetime.on('error', error => {{ throw error; }});
const child = spawn(process.execPath, ['-e', {descendant}], {{ stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }});
child.on('error', error => {{ throw error; }});
child.on('message', ready);
if ({mode} === 'tool') {{
    const input = createInterface({{ input: process.stdin, crlfDelay: Infinity }});
    input.on('line', line => {{
        const message = JSON.parse(line);
        let result;
        if (message.method === 'initialize') result = {{}};
        else if (message.method === 'tools/list') result = {{ tools: [{{ name: 'probe', inputSchema: {{ type: 'object' }} }}] }};
        else if (message.method === 'tools/call') record('tools-call.txt', 'called');
        if (result !== undefined) process.stdout.write(JSON.stringify({{ jsonrpc: '2.0', id: message.id, result }}) + '\n');
    }});
}}
setTimeout(() => {{}}, 60000);
"#,
            mode = serde_json::to_string(mode).unwrap(),
            descendant = serde_json::to_string(&descendant).unwrap(),
        );
        node_fixture(root, &script)
    }

    #[cfg(unix)]
    async fn accept_lifetimes(listener: &tokio::net::TcpListener) -> Vec<tokio::net::TcpStream> {
        timeout(Duration::from_secs(20), async {
            let mut sockets = Vec::new();
            for _ in 0..2 {
                sockets.push(listener.accept().await.unwrap().0);
            }
            sockets
        })
        .await
        .expect("the MCP server and its descendant must start")
    }

    #[cfg(unix)]
    async fn assert_lifetimes_closed(sockets: Vec<tokio::net::TcpStream>) {
        timeout(Duration::from_secs(5), async {
            for mut socket in sockets {
                let mut bytes = Vec::new();
                socket.read_to_end(&mut bytes).await.unwrap();
            }
        })
        .await
        .expect("the MCP server and its descendant must both exit");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_failed_and_interrupted_initialization_reclaim_the_process_tree() {
        for mode in ["invalid", "pending"] {
            let fixture = LifecycleFixture::new();
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let candidate =
                unix_monitored_fixture(&fixture.0, listener.local_addr().unwrap().port(), mode);
            let task =
                OwnedTask::from(tokio::spawn(async move { spawn_session(&candidate).await }));
            let sockets = accept_lifetimes(&listener).await;
            if mode == "pending" {
                task.abort();
                assert!(matches!(task.await, Err(error) if error.is_cancelled()));
            } else {
                let result = timeout(Duration::from_secs(10), task)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(matches!(result, Err(ref error) if error.contains("invalid JSON")));
            }
            assert_lifetimes_closed(sockets).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_stop_during_approval_or_tool_rpc_closes_the_process_tree() {
        for waiting_for_approval in [true, false] {
            let fixture = LifecycleFixture::new();
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let candidate =
                unix_monitored_fixture(&fixture.0, listener.local_addr().unwrap().port(), "tool");
            let call_id = uuid::Uuid::new_v4().to_string();
            let (registration, cancel) = register_tool_call(&call_id).unwrap();
            let (shown, approval_shown) = tokio::sync::oneshot::channel();
            let call = OwnedTask::from(tokio::spawn(async move {
                let _registration = registration;
                run_tool_call(
                    &candidate,
                    "probe",
                    &json!({}),
                    cancel,
                    move || async move {
                        let _ = shown.send(());
                        if waiting_for_approval {
                            std::future::pending::<Result<(), String>>().await
                        } else {
                            Ok(())
                        }
                    },
                    Duration::from_secs(60),
                )
                .await
            }));
            let sockets = accept_lifetimes(&listener).await;
            timeout(Duration::from_secs(20), approval_shown)
                .await
                .unwrap()
                .unwrap();
            if !waiting_for_approval {
                timeout(Duration::from_secs(10), async {
                    while !fixture.0.join("tools-call.txt").exists() {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("the server must receive tools/call");
            }
            cancel_tool_call(&call_id).unwrap();
            let result = timeout(Duration::from_secs(10), call)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result, Err(TOOL_CALL_CANCELLED.to_string()));
            assert_eq!(
                fixture.0.join("tools-call.txt").exists(),
                !waiting_for_approval
            );
            assert!(!call_registered(&call_id));
            assert_lifetimes_closed(sockets).await;
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn invalid_initialization_terminates_the_server_and_its_descendant() {
        let fixture = LifecycleFixture::new();
        let candidate = lifecycle_fixture(&fixture.0, "process.stdout.write('invalid-json\\n')");
        let result = spawn_session(&candidate).await;
        assert!(
            matches!(result, Err(ref error) if error.contains("invalid JSON")),
            "initialization returned {:?}",
            result.err()
        );
        for name in ["parent.pid", "descendant.pid"] {
            let pid = std::fs::read_to_string(fixture.0.join(name))
                .unwrap()
                .parse()
                .unwrap();
            if let Some(exit) = crate::procutil::ProcessExitProbe::open(pid) {
                assert!(exit.exited(), "MCP initialization left {name} running");
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn interrupting_initialization_terminates_the_server_and_its_descendant() {
        let fixture = LifecycleFixture::new();
        let candidate = lifecycle_fixture(&fixture.0, "process.stderr.write('fixture-ready\\n')");
        let task = OwnedTask::from(tokio::spawn(async move { spawn_session(&candidate).await }));
        let mut exits = Vec::new();
        timeout(Duration::from_secs(10), async {
            for name in ["parent.pid", "descendant.pid"] {
                let pid = loop {
                    if let Ok(text) = tokio::fs::read_to_string(fixture.0.join(name)).await {
                        if let Ok(pid) = text.parse::<u32>() {
                            break pid;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                };
                exits.push(crate::procutil::ProcessExitProbe::open(pid).unwrap());
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        timeout(Duration::from_secs(5), async {
            while exits.iter().any(|exit| !exit.exited()) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled MCP initialization must release the process tree");
    }

    /// A synthetic MCP server that declares one tool and records, but never
    /// answers, a `tools/call`, so a test can hold the RPC in flight.
    #[cfg(windows)]
    fn tool_call_fixture(root: &std::path::Path) -> McpServer {
        let script = r#"import { createInterface } from 'node:readline';
record('server.pid', process.pid);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
    const message = JSON.parse(line);
    let result;
    if (message.method === 'initialize') result = {};
    else if (message.method === 'tools/list') result = { tools: [{ name: 'probe', inputSchema: { type: 'object' } }] };
    else if (message.method === 'tools/call') record('tools-call.txt', 'called');
    if (result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
"#;
        node_fixture(root, script)
    }

    #[cfg(windows)]
    async fn server_exit_probe(root: &std::path::Path) -> crate::procutil::ProcessExitProbe {
        timeout(Duration::from_secs(20), async {
            loop {
                if let Ok(text) = tokio::fs::read_to_string(root.join("server.pid")).await {
                    if let Ok(pid) = text.parse::<u32>() {
                        if let Some(probe) = crate::procutil::ProcessExitProbe::open(pid) {
                            return probe;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture server must start")
    }

    /// The fixture writes its PID before answering `initialize`, so the file
    /// exists, and the server is alive, once a call has reached approval.
    #[cfg(windows)]
    fn open_server_probe(root: &std::path::Path) -> crate::procutil::ProcessExitProbe {
        let pid = std::fs::read_to_string(root.join("server.pid"))
            .unwrap()
            .parse()
            .unwrap();
        crate::procutil::ProcessExitProbe::open(pid).expect("fixture server must be running")
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn stop_closes_the_native_approval_dialog_and_never_sends_tools_call() {
        let _serial = native_approval::tests::serial().await;
        let fixture = LifecycleFixture::new();
        let candidate = tool_call_fixture(&fixture.0);
        let call_id = uuid::Uuid::new_v4().to_string();
        let (registration, cancel) = register_tool_call(&call_id).unwrap();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let call = OwnedTask::from(tokio::spawn(async move {
            let _registration = registration;
            run_tool_call(
                &candidate,
                "probe",
                &json!({}),
                cancel,
                move || async move {
                    // The real prompt, held hidden at creation by the test gate.
                    let (gates, reached, release) = native_approval::tests::created_gates();
                    let mut prompt =
                        native_approval::Prompt::open_with(APPROVAL_TITLE, "synthetic", gates)?;
                    held_tx.send(prompt.hold(reached, release)).unwrap();
                    if prompt.answer().await? {
                        Ok(())
                    } else {
                        Err("MCP tool call rejected by the user".into())
                    }
                },
                Duration::from_secs(60),
            )
            .await
        }));
        let held = tokio::task::spawn_blocking(move || {
            let mut held = held_rx
                .recv_timeout(Duration::from_secs(20))
                .expect("the call must reach approval");
            held.created();
            held
        })
        .await
        .unwrap();
        let server = open_server_probe(&fixture.0);
        cancel_tool_call(&call_id).unwrap();
        let result = timeout(Duration::from_secs(10), call)
            .await
            .expect("Stop must end the approval wait")
            .unwrap();
        assert_eq!(result, Err(TOOL_CALL_CANCELLED.to_string()));
        assert!(held.withdrawn(), "Stop must answer the dialog No");
        tokio::task::spawn_blocking(move || held.release_withdrawn())
            .await
            .unwrap();
        assert!(!fixture.0.join("tools-call.txt").exists());
        assert!(server.exited());
        assert!(!call_registered(&call_id));
    }

    #[test]
    fn running_calls_and_cancel_records_stay_bounded() {
        let mut calls = HashMap::new();
        for index in 0..MAX_CANCELLED_CALLS + 5 {
            record_cancel(&mut calls, &format!("stopped-{index}"));
            assert!(calls.len() <= MAX_CANCELLED_CALLS);
        }
        assert!(calls.contains_key(&format!("stopped-{}", MAX_CANCELLED_CALLS + 4)));
        let mut receivers = Vec::new();
        for index in 0..MAX_ACTIVE_CALLS {
            receivers.push(admit_call(&mut calls, &format!("running-{index}")).unwrap());
        }
        assert_eq!(
            admit_call(&mut calls, "one-too-many").err(),
            Some("too many MCP tool calls are already running".to_string())
        );
        // A cancel recorded for a waiting call is still honoured at the limit.
        assert_eq!(
            admit_call(&mut calls, &format!("stopped-{}", MAX_CANCELLED_CALLS + 4)).err(),
            Some(TOOL_CALL_CANCELLED.to_string())
        );
        drop(receivers);
    }

    #[test]
    fn shutdown_cancels_every_running_call() {
        let (first, first_cancel) = tokio::sync::watch::channel(false);
        let (second, second_cancel) = tokio::sync::watch::channel(false);
        let mut calls = HashMap::new();
        calls.insert("first".to_string(), CallSlot::Active(first));
        calls.insert("second".to_string(), CallSlot::Active(second));
        calls.insert(
            "stopped".to_string(),
            CallSlot::Cancelled(std::time::Instant::now()),
        );
        cancel_active_calls(&calls);
        assert!(*first_cancel.borrow());
        assert!(*second_cancel.borrow());
    }

    fn call_registered(call_id: &str) -> bool {
        lock_tool_calls().contains_key(call_id)
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stop_while_awaiting_approval_never_sends_tools_call_and_reclaims_the_server() {
        let fixture = LifecycleFixture::new();
        let candidate = tool_call_fixture(&fixture.0);
        let call_id = uuid::Uuid::new_v4().to_string();
        let (registration, cancel) = register_tool_call(&call_id).unwrap();
        let (shown, approval_shown) = tokio::sync::oneshot::channel();
        let call = OwnedTask::from(tokio::spawn(async move {
            let _registration = registration;
            run_tool_call(
                &candidate,
                "probe",
                &json!({}),
                cancel,
                move || async move {
                    let _ = shown.send(());
                    std::future::pending::<Result<(), String>>().await
                },
                Duration::from_secs(60),
            )
            .await
        }));
        timeout(Duration::from_secs(20), approval_shown)
            .await
            .expect("the call must reach approval")
            .unwrap();
        let exit = server_exit_probe(&fixture.0).await;
        cancel_tool_call(&call_id).unwrap();
        let result = timeout(Duration::from_secs(10), call)
            .await
            .expect("Stop must end the approval wait")
            .unwrap();
        assert_eq!(result, Err(TOOL_CALL_CANCELLED.to_string()));
        assert!(!fixture.0.join("tools-call.txt").exists());
        assert!(exit.exited(), "a cancelled call must close its MCP server");
        assert!(!call_registered(&call_id));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stop_that_races_an_approval_still_forbids_tools_call() {
        let fixture = LifecycleFixture::new();
        let candidate = tool_call_fixture(&fixture.0);
        let call_id = uuid::Uuid::new_v4().to_string();
        let (registration, cancel) = register_tool_call(&call_id).unwrap();
        let exit = std::cell::RefCell::new(None);
        let result = run_tool_call(
            &candidate,
            "probe",
            &json!({}),
            cancel,
            || {
                *exit.borrow_mut() = Some(open_server_probe(&fixture.0));
                // The user answers Yes in the same instant the chat is stopped.
                cancel_tool_call(&call_id).unwrap();
                async { Ok(()) }
            },
            Duration::from_secs(60),
        )
        .await;
        let exit = exit
            .into_inner()
            .unwrap_or_else(|| panic!("the call must reach approval: {result:?}"));
        drop(registration);
        assert_eq!(result, Err(TOOL_CALL_CANCELLED.to_string()));
        assert!(!fixture.0.join("tools-call.txt").exists());
        assert!(exit.exited());
        assert!(!call_registered(&call_id));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cancelling_during_the_tool_rpc_closes_the_session_and_clears_the_call() {
        let fixture = LifecycleFixture::new();
        let candidate = tool_call_fixture(&fixture.0);
        let call_id = uuid::Uuid::new_v4().to_string();
        let (registration, cancel) = register_tool_call(&call_id).unwrap();
        let call = OwnedTask::from(tokio::spawn(async move {
            let _registration = registration;
            run_tool_call(
                &candidate,
                "probe",
                &json!({}),
                cancel,
                || async { Ok(()) },
                Duration::from_secs(60),
            )
            .await
        }));
        let exit = server_exit_probe(&fixture.0).await;
        timeout(Duration::from_secs(20), async {
            while !fixture.0.join("tools-call.txt").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the server must receive tools/call");
        let stopped = std::time::Instant::now();
        cancel_tool_call(&call_id).unwrap();
        let result = timeout(Duration::from_secs(10), call)
            .await
            .expect("Stop must end the in-flight RPC")
            .unwrap();
        assert_eq!(result, Err(TOOL_CALL_CANCELLED.to_string()));
        assert!(stopped.elapsed() < RPC_TIMEOUT);
        assert!(exit.exited(), "a cancelled RPC must close its MCP server");
        assert!(!call_registered(&call_id));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn an_unanswered_approval_times_out_and_closes_the_server() {
        let fixture = LifecycleFixture::new();
        let candidate = tool_call_fixture(&fixture.0);
        let exit = std::cell::RefCell::new(None);
        let result = run_tool_call(
            &candidate,
            "probe",
            &json!({}),
            CallCancel(None),
            || {
                *exit.borrow_mut() = Some(open_server_probe(&fixture.0));
                std::future::pending::<Result<(), String>>()
            },
            Duration::from_millis(200),
        )
        .await;
        let exit = exit
            .into_inner()
            .unwrap_or_else(|| panic!("the call must reach approval: {result:?}"));
        assert_eq!(result, Err("MCP tool approval timed out".to_string()));
        assert!(!fixture.0.join("tools-call.txt").exists());
        assert!(exit.exited());
    }

    #[tokio::test]
    async fn a_cancel_that_arrives_before_its_call_still_applies_once() {
        let call_id = uuid::Uuid::new_v4().to_string();
        cancel_tool_call(&call_id).unwrap();
        // The call is refused before it reads any configuration or starts a server.
        assert_eq!(
            call_tool_with_id("not-configured", "probe", json!({}), Some(&call_id)).await,
            Err(TOOL_CALL_CANCELLED.to_string())
        );
        assert!(!call_registered(&call_id));
        // The tombstone is consumed, so a later call may reuse the id.
        let (registration, cancel) = register_tool_call(&call_id).unwrap();
        assert!(!cancel.is_cancelled());
        assert!(
            register_tool_call(&call_id).is_err(),
            "an id runs one call at a time"
        );
        cancel_tool_call(&call_id).unwrap();
        assert!(cancel.is_cancelled());
        drop(registration);
        assert!(!call_registered(&call_id));
    }

    #[test]
    fn cancelled_call_tombstones_stay_bounded_and_ids_are_validated() {
        assert!(cancel_tool_call("bad id\n").is_err());
        assert!(register_tool_call("").is_err());
        // Pruning is checked on a private map so concurrent tests keep their
        // own tombstones in the shared registry.
        let now = std::time::Instant::now();
        let mut calls = HashMap::new();
        let (sender, _receiver) = tokio::sync::watch::channel(false);
        calls.insert("running".to_string(), CallSlot::Active(sender));
        calls.insert(
            "expired".to_string(),
            CallSlot::Cancelled(now - CANCELLED_CALL_RETENTION - Duration::from_secs(1)),
        );
        for index in 0..MAX_CANCELLED_CALLS + 8 {
            calls.insert(
                format!("stopped-{index}"),
                CallSlot::Cancelled(now - Duration::from_millis(index as u64)),
            );
        }
        prune_cancelled_calls(&mut calls, MAX_CANCELLED_CALLS);
        assert_eq!(calls.len(), MAX_CANCELLED_CALLS + 1);
        assert!(matches!(calls.get("running"), Some(CallSlot::Active(_))));
        assert!(!calls.contains_key("expired"));
        // The newest tombstones survive; the oldest give way.
        assert!(calls.contains_key("stopped-0"));
        assert!(!calls.contains_key(&format!("stopped-{}", MAX_CANCELLED_CALLS + 7)));
    }

    fn server(command: &str) -> McpServer {
        McpServer {
            id: "test-server".into(),
            name: "Test server".into(),
            command: command.into(),
            args: Vec::new(),
            enabled: true,
        }
    }

    #[test]
    fn rejects_shell_operators_and_control_characters() {
        assert!(validate_server(&server("npx")).is_ok());
        assert!(validate_server(&server("npx && whoami")).is_err());
        assert!(validate_server(&server("npx\nwhoami")).is_err());
    }

    #[test]
    fn rejects_invalid_ids_and_oversized_arguments() {
        let mut candidate = server("npx");
        candidate.id = "../server".into();
        assert!(validate_server(&candidate).is_err());
        candidate.id = "test-server".into();
        candidate.args = vec!["x".repeat(4097)];
        assert!(validate_server(&candidate).is_err());
    }

    #[tokio::test]
    async fn staged_config_replaces_existing_file_and_preserves_new_content() {
        let root = std::env::temp_dir().join(format!("aiolm-mcp-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root)
            .await
            .expect("temp directory");
        let path = root.join("mcp-servers.json");
        let temp = root.join(".mcp-servers.tmp");
        tokio::fs::write(&path, b"old").await.expect("old config");
        tokio::fs::write(&temp, b"new")
            .await
            .expect("staged config");

        activate_staged_file(&temp, &path)
            .await
            .expect("replacement should succeed");
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "new");
        assert!(!tokio::fs::try_exists(&temp).await.unwrap());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn inherited_environment_excludes_common_secret_names() {
        let names: Vec<String> = inherited_environment()
            .into_iter()
            .map(|(name, _)| name.to_string_lossy().to_ascii_uppercase())
            .collect();
        assert!(!names.iter().any(|name| name.contains("TOKEN")));
        assert!(!names.iter().any(|name| name.contains("API_KEY")));
        assert!(!names.iter().any(|name| name.contains("PASSWORD")));
    }

    #[test]
    fn bounded_line_accumulator_rejects_over_limit_payloads() {
        let mut line = vec![b'x'; MAX_RPC_LINE - 1];
        assert!(append_bounded_line(&mut line, b"\n").is_ok());
        assert!(append_bounded_line(&mut line, b"x").is_err());
    }

    #[test]
    fn tool_schema_validation_rejects_missing_and_wrong_types() {
        let schema = json!({
            "type": "object",
            "required": ["query"],
            "properties": {"query": {"type": "string"}}
        });
        assert!(validate_tool_arguments(&schema, &json!({})).is_err());
        assert!(validate_tool_arguments(&schema, &json!({"query": 4})).is_err());
        assert!(validate_tool_arguments(&schema, &json!({"query": "llama"})).is_ok());
    }

    #[test]
    fn approval_description_is_bounded_and_binds_server_and_tool_identity() {
        let description =
            tool_approval_description(&server("npx"), "search", &json!({"query": "llama"}));
        assert!(description.contains("Test server"));
        assert!(description.contains("search"));
        assert!(description.contains("llama"));
        assert!(description.len() <= MAX_APPROVAL_DESCRIPTION_BYTES);
    }
}
