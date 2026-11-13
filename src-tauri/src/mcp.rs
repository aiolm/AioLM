// Local MCP stdio client with explicit per-call approval.
use crate::error::{AppError, ErrorKind};
use crate::procutil::{OwnedTask, TransientChild};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::time::timeout;

const MCP_FILE: &str = "mcp-servers.json";
const LAUNCH_APPROVAL_FILE: &str = "mcp-launch-approvals.json";
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RPC_LINE: usize = 1024 * 1024;
// Pagination shares the per-response byte budget rather than multiplying it.
const MAX_TOOL_LIST_BYTES: usize = MAX_RPC_LINE;
const MAX_TOOL_LIST_PAGES: usize = 64;
const MAX_LISTED_TOOLS: usize = 4096;
const MAX_TOOL_ARGUMENT_BYTES: usize = 256 * 1024;
const MAX_APPROVAL_DESCRIPTION_BYTES: usize = 4096;
const APPROVAL_TRUNCATION_SUFFIX: &str = "\n…";
const PROTOCOL_VERSION: &str = "2024-11-05";
/// An unanswered approval must not hold its MCP server open indefinitely.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const TOOL_CALL_CANCELLED: &str = "MCP tool call cancelled";
const APPROVAL_TITLE: &str = "MCP tool approval required";

static LAUNCH_APPROVAL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CONFIG_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static MCP_FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static LAUNCH_APPROVAL_FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

fn validate_server(server: &McpServer) -> Result<(), AppError> {
    if !valid_id(&server.id) {
        return Err(AppError::validation(
            "MCP server id must contain only letters, numbers, '-' or '_'.",
        ));
    }
    if server.name.trim().is_empty() || server.name.len() > 80 {
        return Err(AppError::validation(
            "MCP server name must be between 1 and 80 characters.",
        ));
    }
    if server.command.trim().is_empty()
        || server.command.len() > 512
        || contains_forbidden_control(&server.command)
        || server
            .command
            .chars()
            .any(|character| matches!(character, '&' | '|' | ';' | '<' | '>'))
    {
        return Err(AppError::validation(
            "MCP command must be one executable path; shell operators are not allowed.",
        ));
    }
    if server.args.len() > 64
        || server
            .args
            .iter()
            .any(|argument| argument.len() > 4096 || contains_forbidden_control(argument))
    {
        return Err(AppError::validation(
            "MCP arguments must be at most 64 newline-free values.",
        ));
    }
    Ok(())
}

fn config_path() -> Result<PathBuf, AppError> {
    crate::home::resolve_aiolm_home()
        .map(|home| home.join(MCP_FILE))
        .map_err(AppError::validation)
}

async fn load_servers() -> Result<Vec<McpServer>, AppError> {
    let path = config_path()?;
    tokio::task::spawn_blocking(move || load_servers_from_path(&path))
        .await
        .map_err(|error| {
            AppError::new(
                if error.is_cancelled() {
                    ErrorKind::Cancelled
                } else {
                    ErrorKind::Internal
                },
                format!("MCP config load task failed: {error}"),
            )
        })?
}

fn load_servers_from_path(path: &Path) -> Result<Vec<McpServer>, AppError> {
    let _guard = MCP_FILE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Older saves briefly moved the live document aside. Recover the
            // most recent backup without discarding that recovery point.
            let Some(parent) = path.parent().filter(|parent| parent.is_dir()) else {
                return Ok(Vec::new());
            };
            let prefix = format!(
                "{}.backup-",
                path.file_name().unwrap_or_default().to_string_lossy()
            );
            let mut backups = std::fs::read_dir(parent)
                .map_err(|error| AppError::io("cannot inspect MCP backups", &error))?
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.file_name().to_string_lossy().starts_with(&prefix)
                        && entry.file_type().is_ok_and(|kind| kind.is_file())
                })
                .collect::<Vec<_>>();
            backups.sort_by_key(|entry| {
                entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
            });
            let Some(backup) = backups.pop() else {
                return Ok(Vec::new());
            };
            let bytes = std::fs::read(backup.path())
                .map_err(|error| AppError::io("cannot read MCP backup", &error))?;
            let servers = decode_servers(&bytes)?;
            crate::config::atomic_write(path, &bytes).map_err(|mut error| {
                error.message = format!("cannot recover MCP config: {error}");
                error
            })?;
            return Ok(servers);
        }
        Err(error) => return Err(AppError::io("cannot read MCP config", &error)),
    };
    decode_servers(&bytes)
}

fn decode_servers(bytes: &[u8]) -> Result<Vec<McpServer>, AppError> {
    let servers: Vec<McpServer> = serde_json::from_slice(bytes)
        .map_err(|error| AppError::validation(format!("cannot parse MCP config: {error}")))?;
    for server in &servers {
        validate_server(server)?;
    }
    Ok(servers)
}

async fn save_servers(servers: &[McpServer]) -> Result<(), AppError> {
    save_servers_to_path(servers, config_path()?).await
}

async fn save_servers_to_path(servers: &[McpServer], path: PathBuf) -> Result<(), AppError> {
    for server in servers {
        validate_server(server)?;
    }
    let bytes = serde_json::to_vec_pretty(servers)
        .map_err(|error| AppError::internal(format!("cannot encode MCP config: {error}")))?;
    tokio::task::spawn_blocking(move || {
        let _guard = MCP_FILE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        crate::config::atomic_write(&path, &bytes).map_err(|mut error| {
            error.message = format!("cannot save MCP config: {error}");
            error
        })
    })
    .await
    .map_err(|error| {
        AppError::new(
            if error.is_cancelled() {
                ErrorKind::Cancelled
            } else {
                ErrorKind::Internal
            },
            format!("MCP config save task failed: {error}"),
        )
    })?
}

fn config_lock() -> &'static tokio::sync::Mutex<()> {
    CONFIG_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn append_bounded_line(target: &mut Vec<u8>, bytes: &[u8]) -> Result<(), AppError> {
    if target.len().saturating_add(bytes.len()) > MAX_RPC_LINE {
        return Err(AppError::validation(
            "MCP response exceeded the 1 MiB safety limit",
        ));
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

struct LaunchContext {
    environment: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    cwd: PathBuf,
}

impl LaunchContext {
    fn capture() -> Result<Self, AppError> {
        Ok(Self {
            environment: inherited_environment(),
            cwd: std::env::current_dir()
                .map_err(|error| AppError::io("cannot resolve MCP working directory", &error))?,
        })
    }

    fn fingerprint(&self, server: &McpServer) -> String {
        let mut hash = Sha256::new();
        fn field(hash: &mut Sha256, value: &[u8]) {
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value);
        }
        field(&mut hash, b"aiolm-mcp-launch-v1");
        field(&mut hash, server.command.as_bytes());
        hash.update((server.args.len() as u64).to_le_bytes());
        for argument in &server.args {
            field(&mut hash, argument.as_bytes());
        }
        hash.update((self.environment.len() as u64).to_le_bytes());
        for (name, value) in &self.environment {
            field(&mut hash, name.as_encoded_bytes());
            field(&mut hash, value.as_encoded_bytes());
        }
        field(&mut hash, self.cwd.as_os_str().as_encoded_bytes());
        format!("{:x}", hash.finalize())
    }
}

fn launch_approval_description(server: &McpServer, launch: &LaunchContext) -> String {
    // JSON preserves executable and argument boundaries without suggesting
    // that a shell interprets this command line.
    #[derive(Serialize)]
    struct CommandLine<'a> {
        executable: &'a str,
        arguments: &'a [String],
    }
    let command_line = serde_json::to_string(&CommandLine {
        executable: &server.command,
        arguments: &server.args,
    })
    .expect("strings serialize");
    let cwd = launch.cwd.to_string_lossy();
    bounded_approval_description(&[
        "Allow this MCP server executable to run?\nServer: ",
        &server.name,
        " (",
        &server.id,
        ")\nCommand line (executable and arguments): ",
        &command_line,
        "\nWorking directory: ",
        &cwd,
        "\n\nApproval is remembered for this command, arguments, environment and working directory.",
    ])
}

fn read_launch_approvals(path: &Path) -> Result<BTreeSet<String>, AppError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            AppError::validation(format!("cannot parse MCP launch approvals: {error}"))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(error) => Err(AppError::io("cannot read MCP launch approvals", &error)),
    }
}

async fn approve_launch<F, Fut>(
    path: &Path,
    fingerprint: String,
    approve: F,
) -> Result<(), AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<bool, AppError>>,
{
    // Serialize read/approve/write so simultaneous first uses cannot discard
    // each other's approvals or present duplicate prompts.
    let _guard = LAUNCH_APPROVAL_LOCK.lock().await;
    let read_path = path.to_owned();
    let approvals = tokio::task::spawn_blocking(move || {
        let _guard = LAUNCH_APPROVAL_FILE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        read_launch_approvals(&read_path)
    })
    .await
    .map_err(|error| {
        AppError::new(
            if error.is_cancelled() {
                ErrorKind::Cancelled
            } else {
                ErrorKind::Internal
            },
            format!("MCP approval load task failed: {error}"),
        )
    })??;
    if approvals.contains(&fingerprint) {
        return Ok(());
    }
    let approved = timeout(APPROVAL_TIMEOUT, approve())
        .await
        .map_err(|_| AppError::timeout("MCP server launch approval timed out"))??;
    if !approved {
        return Err(AppError::denied("MCP server launch rejected by the user"));
    }
    let write_path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        // A cancelled caller's blocking write may still finish. Merge while
        // holding a synchronous file lock so that write cannot lose approvals.
        let _guard = LAUNCH_APPROVAL_FILE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut approvals = read_launch_approvals(&write_path)?;
        approvals.insert(fingerprint);
        let bytes = serde_json::to_vec_pretty(&approvals).map_err(|error| {
            AppError::internal(format!("cannot encode MCP launch approvals: {error}"))
        })?;
        crate::config::atomic_write(&write_path, &bytes).map_err(|mut error| {
            error.message = format!("cannot save MCP launch approval: {error}");
            error
        })
    })
    .await
    .map_err(|error| {
        AppError::new(
            if error.is_cancelled() {
                ErrorKind::Cancelled
            } else {
                ErrorKind::Internal
            },
            format!("MCP approval save task failed: {error}"),
        )
    })?
}

async fn spawn_session(server: &McpServer) -> Result<McpSession, AppError> {
    let path = config_path()?.with_file_name(LAUNCH_APPROVAL_FILE);
    spawn_session_with_approval(server, &path, |description| async move {
        crate::native_confirm::confirm("MCP server launch approval required", &description)
            .await
            .map_err(AppError::unavailable)
    })
    .await
}

async fn spawn_session_with_approval<F, Fut>(
    server: &McpServer,
    approvals: &Path,
    approve: F,
) -> Result<McpSession, AppError>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<bool, AppError>>,
{
    if !server.enabled {
        return Err(AppError::busy("MCP server is disabled"));
    }
    validate_server(server)?;
    let launch = LaunchContext::capture()?;
    approve_launch(approvals, launch.fingerprint(server), || {
        approve(launch_approval_description(server, &launch))
    })
    .await?;
    let mut command = crate::procutil::tokio_command(&server.command);
    crate::procutil::configure_process_group(&mut command);
    command
        .args(&server.args)
        .env_clear()
        .envs(launch.environment)
        .current_dir(launch.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = TransientChild::spawn(&mut command).map_err(|error| {
        AppError::io(
            &format!("cannot start MCP server '{}'", server.name),
            &error,
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::internal("MCP server stdin was not captured"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::internal("MCP server stdout was not captured"))?;
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
        next_request_id: 2,
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
    next_request_id: u64,
}

impl McpSession {
    fn next_request_id(&mut self) -> u64 {
        let id = self.next_request_id;
        self.next_request_id += 1;
        id
    }
}

async fn send_message(
    stdin: &mut ChildStdin,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), AppError> {
    let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    write_line(stdin, message).await
}

async fn send_notification(
    stdin: &mut ChildStdin,
    method: &str,
    params: Value,
) -> Result<(), AppError> {
    let message = json!({"jsonrpc": "2.0", "method": method, "params": params});
    write_line(stdin, message).await
}

async fn write_line(stdin: &mut ChildStdin, message: Value) -> Result<(), AppError> {
    let mut bytes = serde_json::to_vec(&message)
        .map_err(|error| AppError::internal(format!("cannot encode MCP request: {error}")))?;
    bytes.push(b'\n');
    timeout(RPC_TIMEOUT, async {
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| AppError::unavailable(format!("cannot write MCP request: {error}")))?;
        stdin
            .flush()
            .await
            .map_err(|error| AppError::unavailable(format!("cannot flush MCP request: {error}")))
    })
    .await
    .map_err(|_| AppError::timeout("MCP request write timed out after 15 seconds"))?
}

async fn read_bounded_line(
    reader: &mut BufReader<ChildStdout>,
) -> Result<Option<String>, AppError> {
    let mut bytes = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|error| AppError::unavailable(format!("cannot read MCP response: {error}")))?;
        if buffer.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            return String::from_utf8(bytes).map(Some).map_err(|error| {
                AppError::validation(format!("MCP response was not UTF-8: {error}"))
            });
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        append_bounded_line(&mut bytes, &buffer[..take])?;
        reader.consume(take);
        if newline.is_some() {
            return String::from_utf8(bytes).map(Some).map_err(|error| {
                AppError::validation(format!("MCP response was not UTF-8: {error}"))
            });
        }
    }
}

async fn read_response(reader: &mut BufReader<ChildStdout>, id: u64) -> Result<Value, AppError> {
    read_response_with_size(reader, id)
        .await
        .map(|(result, _)| result)
}

async fn read_response_with_size(
    reader: &mut BufReader<ChildStdout>,
    id: u64,
) -> Result<(Value, usize), AppError> {
    let read = timeout(RPC_TIMEOUT, async {
        loop {
            let Some(line) = read_bounded_line(reader).await? else {
                return Err(AppError::unavailable(
                    "MCP server closed stdout before responding",
                ));
            };
            let mut message: Value = serde_json::from_str(&line).map_err(|error| {
                AppError::validation(format!("MCP returned invalid JSON: {error}"))
            })?;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(AppError::internal(format!("MCP request failed: {error}")));
            }
            return Ok((
                message
                    .as_object_mut()
                    .and_then(|object| object.remove("result"))
                    .unwrap_or(Value::Null),
                line.len(),
            ));
        }
    })
    .await
    .map_err(|_| AppError::timeout("MCP request timed out after 15 seconds"))?;
    read
}

async fn close_session(mut session: McpSession) {
    // The Job object (Windows) or process group (Unix) owns the whole tree, so
    // one terminate reaches every descendant before the root is reaped.
    #[cfg(windows)]
    let process_tree = session.child.process_handle();
    session.child.terminate();
    let _ = session.child.wait().await;
    // Job termination can outlive the root's exit. Retain its process handles
    // and wait off the async worker until every captured member has exited.
    #[cfg(windows)]
    let _ =
        tokio::task::spawn_blocking(move || process_tree.wait_exited(Duration::from_secs(5))).await;
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

pub async fn list() -> Result<Vec<McpServer>, AppError> {
    load_servers().await
}

pub async fn save(server: McpServer) -> Result<Vec<McpServer>, AppError> {
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

pub async fn remove(id: &str) -> Result<Vec<McpServer>, AppError> {
    if !valid_id(id) {
        return Err(AppError::validation("invalid MCP server id"));
    }
    let _config_guard = config_lock().lock().await;
    let mut servers = load_servers().await?;
    servers.retain(|server| server.id != id);
    save_servers(&servers).await?;
    Ok(servers)
}

pub async fn tools(id: &str) -> Result<Vec<McpTool>, AppError> {
    let server = load_servers()
        .await?
        .into_iter()
        .find(|server| server.id == id)
        .ok_or_else(|| AppError::not_found("MCP server was not found"))?;
    let mut session = spawn_session(&server).await?;
    let result = send_tools_request(&mut session).await;
    close_session(session).await;
    result?
        .into_iter()
        .map(|tool| {
            serde_json::from_value(tool).map_err(|error| {
                AppError::validation(format!("invalid MCP tool metadata: {error}"))
            })
        })
        .collect()
}

async fn send_tools_request(session: &mut McpSession) -> Result<Vec<Value>, AppError> {
    let mut tools = Vec::new();
    let mut cursor = None;
    let mut seen_cursors = BTreeSet::new();
    let mut bytes = 0_usize;
    for _ in 0..MAX_TOOL_LIST_PAGES {
        let id = session.next_request_id();
        let params = cursor
            .as_ref()
            .map_or_else(|| json!({}), |cursor| json!({"cursor": cursor}));
        send_message(&mut session.stdin, id, "tools/list", params).await?;
        let (mut result, response_bytes) = read_response_with_size(&mut session.stdout, id).await?;
        bytes = bytes.saturating_add(response_bytes);
        if bytes > MAX_TOOL_LIST_BYTES {
            return Err(AppError::validation(
                "MCP tools/list exceeded the 1 MiB aggregate safety limit",
            ));
        }
        let page = result
            .as_object_mut()
            .and_then(|object| object.remove("tools"))
            .and_then(|tools| match tools {
                Value::Array(tools) => Some(tools),
                _ => None,
            })
            .ok_or_else(|| AppError::validation("MCP tools/list returned no tools array"))?;
        if tools.len().saturating_add(page.len()) > MAX_LISTED_TOOLS {
            return Err(AppError::validation(
                "MCP tools/list exceeded the 4096 tool safety limit",
            ));
        }
        tools.extend(page);
        match result.get("nextCursor") {
            None | Some(Value::Null) => return Ok(tools),
            Some(Value::String(next)) => {
                if !seen_cursors.insert(next.clone()) {
                    return Err(AppError::validation(
                        "MCP tools/list repeated a pagination cursor",
                    ));
                }
                cursor = Some(next.clone());
            }
            Some(_) => {
                return Err(AppError::validation(
                    "MCP tools/list returned an invalid pagination cursor",
                ));
            }
        }
    }
    Err(AppError::validation(
        "MCP tools/list exceeded the 64 page safety limit",
    ))
}

fn validate_tool_arguments(schema: &Value, arguments: &Value) -> Result<(), AppError> {
    let Some(schema) = schema.as_object() else {
        return Ok(());
    };
    let Some(arguments) = arguments.as_object() else {
        return Err(AppError::validation(
            "MCP tool arguments must be a JSON object",
        ));
    };
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for field in required.iter().filter_map(Value::as_str) {
            if !arguments.contains_key(field) {
                return Err(AppError::validation(format!(
                    "MCP tool argument '{field}' is required"
                )));
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
                return Err(AppError::validation(format!(
                    "MCP tool argument '{field}' must be {expected}"
                )));
            }
        }
    }
    Ok(())
}

fn push_bounded(output: &mut String, value: &str, limit: usize) -> bool {
    let remaining = limit.saturating_sub(output.len());
    let take = value.floor_char_boundary(value.len().min(remaining));
    output.push_str(&value[..take]);
    take == value.len()
}

fn tool_approval_description(server: &McpServer, name: &str, serialized: &str) -> String {
    let parts = [
        "Server: ",
        server.name.as_str(),
        " (",
        server.id.as_str(),
        ")\nTool: ",
        name,
        "\nArguments: ",
        serialized,
        "\n\nAllow this one-time MCP tool call?",
    ];
    bounded_approval_description(&parts)
}

fn bounded_approval_description(parts: &[&str]) -> String {
    let full_len: usize = parts.iter().map(|part| part.len()).sum();
    if full_len <= MAX_APPROVAL_DESCRIPTION_BYTES {
        let mut description = String::with_capacity(full_len);
        for part in parts {
            description.push_str(part);
        }
        return description;
    }

    let limit = MAX_APPROVAL_DESCRIPTION_BYTES.saturating_sub(APPROVAL_TRUNCATION_SUFFIX.len());
    let mut bounded = String::with_capacity(MAX_APPROVAL_DESCRIPTION_BYTES);
    for part in parts {
        if !push_bounded(&mut bounded, part, limit) {
            break;
        }
    }
    bounded.push_str(APPROVAL_TRUNCATION_SUFFIX);
    bounded
}

async fn confirm_tool_call(
    server: &McpServer,
    name: &str,
    serialized: &str,
) -> Result<(), AppError> {
    let description = tool_approval_description(server, name, serialized);
    let approved = crate::native_confirm::confirm(APPROVAL_TITLE, &description)
        .await
        .map_err(AppError::unavailable)?;
    if approved {
        Ok(())
    } else {
        Err(AppError::denied("MCP tool call rejected by the user"))
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
) -> Result<Value, AppError> {
    // A call without a caller id still registers under a private one, so
    // shutdown can cancel it like any other.
    let call_id = call_id
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (_registration, mut cancel) = register_tool_call(&call_id)?;
    if name.is_empty() || name.len() > 256 || contains_forbidden_control(name) {
        return Err(AppError::validation("invalid MCP tool name"));
    }
    if !arguments.is_object() {
        return Err(AppError::validation(
            "MCP tool arguments must be a JSON object",
        ));
    }
    let serialized_arguments = serde_json::to_string(&arguments).map_err(|error| {
        AppError::internal(format!("cannot encode MCP tool arguments: {error}"))
    })?;
    if serialized_arguments.len() > MAX_TOOL_ARGUMENT_BYTES {
        return Err(AppError::validation(
            "MCP tool arguments exceed the 256 KiB safety limit",
        ));
    }
    let server = cancel
        .guard(load_servers())
        .await??
        .into_iter()
        .find(|server| server.id == id)
        .ok_or_else(|| AppError::not_found("MCP server was not found"))?;
    run_tool_call(
        spawn_session(&server),
        name,
        &arguments,
        cancel,
        || confirm_tool_call(&server, name, &serialized_arguments),
        APPROVAL_TIMEOUT,
    )
    .await
}

/// Run one approved tool call on its own session. Cancellation drops the
/// pending step (spawn, RPC or the approval wait) and always reclaims the
/// session; a call cancelled before approval never sends `tools/call`.
async fn run_tool_call<F, Fut>(
    launch: impl Future<Output = Result<McpSession, AppError>>,
    name: &str,
    arguments: &Value,
    mut cancel: CallCancel,
    approve: F,
    approval_timeout: Duration,
) -> Result<Value, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    // A dropped spawn future still owns its TransientChild, which terminates
    // the process tree, so an early cancel needs no separate cleanup.
    let mut session = cancel.guard(launch).await??;
    let approval_cancel = cancel.clone();
    let work = async {
        let tool_list = send_tools_request(&mut session).await?;
        let tool = tool_list
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
            .ok_or_else(|| {
                AppError::not_found(format!("MCP tool '{name}' is not declared by the server"))
            })?;
        if let Some(schema) = tool.get("inputSchema") {
            validate_tool_arguments(schema, arguments)?;
        }
        timeout(approval_timeout, approve())
            .await
            .map_err(|_| AppError::timeout("MCP tool approval timed out"))??;
        // The approval may have resolved in the same instant as a Stop; the
        // tool must not run once the caller has cancelled.
        if approval_cancel.is_cancelled() {
            return Err(AppError::cancelled(TOOL_CALL_CANCELLED));
        }
        let request_id = session.next_request_id();
        send_message(
            &mut session.stdin,
            request_id,
            "tools/call",
            json!({"name": name, "arguments": arguments}),
        )
        .await?;
        read_response(&mut session.stdout, request_id).await
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
pub fn cancel_tool_call(call_id: &str) -> Result<(), AppError> {
    if !valid_id(call_id) {
        return Err(AppError::validation("invalid MCP tool call id"));
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
    crate::native_confirm::dismiss_all();
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

fn register_tool_call(call_id: &str) -> Result<(CallRegistration, CallCancel), AppError> {
    if !valid_id(call_id) {
        return Err(AppError::validation("invalid MCP tool call id"));
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
) -> Result<tokio::sync::watch::Receiver<bool>, AppError> {
    prune_cancelled_calls(calls, MAX_CANCELLED_CALLS);
    match calls.get(call_id) {
        Some(CallSlot::Active(_)) => Err(AppError::busy("MCP tool call id is already in use")),
        Some(CallSlot::Cancelled(_)) => {
            calls.remove(call_id);
            Err(AppError::cancelled(TOOL_CALL_CANCELLED))
        }
        None => {
            let active = calls
                .values()
                .filter(|slot| matches!(slot, CallSlot::Active(_)))
                .count();
            // Each running call owns an MCP server process.
            if active >= MAX_ACTIVE_CALLS {
                return Err(AppError::busy(
                    "too many MCP tool calls are already running",
                ));
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
    async fn guard<T>(&mut self, work: impl Future<Output = T>) -> Result<T, AppError> {
        tokio::select! {
            biased;
            _ = self.cancelled() => Err(AppError::cancelled(TOOL_CALL_CANCELLED)),
            value = work => Ok(value),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use crate::native_confirm::native_approval;

    async fn spawn_test_session(server: &McpServer) -> Result<McpSession, AppError> {
        let fixture = LifecycleFixture::new();
        spawn_session_with_approval(server, &fixture.0.join(LAUNCH_APPROVAL_FILE), |_| async {
            Ok(true)
        })
        .await
    }

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

    struct LifecycleFixture(std::path::PathBuf);

    impl LifecycleFixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("aiolm-mcp-lifecycle-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }

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
                OwnedTask::from(tokio::spawn(
                    async move { spawn_test_session(&candidate).await },
                ));
            let sockets = accept_lifetimes(&listener).await;
            if mode == "pending" {
                task.abort();
                assert!(matches!(task.await, Err(error) if error.is_cancelled()));
            } else {
                let result = timeout(Duration::from_secs(10), task)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    matches!(&result, Err(error) if error.kind == ErrorKind::Validation && error.message.contains("invalid JSON"))
                );
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
                    spawn_test_session(&candidate),
                    "probe",
                    &json!({}),
                    cancel,
                    move || async move {
                        let _ = shown.send(());
                        if waiting_for_approval {
                            std::future::pending::<Result<(), AppError>>().await
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
            assert_eq!(result, Err(AppError::cancelled(TOOL_CALL_CANCELLED)));
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
        let result = spawn_test_session(&candidate).await;
        assert!(
            matches!(&result, Err(error) if error.kind == ErrorKind::Validation && error.message.contains("invalid JSON")),
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
        let task = OwnedTask::from(tokio::spawn(
            async move { spawn_test_session(&candidate).await },
        ));
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

    /// A synthetic MCP server that records every request line, answers
    /// `initialize`, and answers `tools/list` with the exact bytes of
    /// `reply.bin`. Ending the reply with end of output exits the server,
    /// because Node never closes an inherited stdout pipe on its own.
    #[cfg(any(windows, unix))]
    fn scripted_reply_fixture(root: &std::path::Path, reply: &[u8], end_output: bool) -> McpServer {
        std::fs::write(root.join("reply.bin"), reply).unwrap();
        if end_output {
            std::fs::write(root.join("end-output"), "").unwrap();
        }
        let script = r#"import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
record('server.pid', process.pid);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
    appendFileSync(join(root, 'requests.jsonl'), line + '\n');
    const message = JSON.parse(line);
    if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
    else if (message.method === 'tools/list') process.stdout.write(readFileSync(join(root, 'reply.bin')), () => {
        if (existsSync(join(root, 'end-output'))) process.exit(0);
    });
});
"#;
        node_fixture(root, script)
    }

    #[cfg(any(windows, unix))]
    fn paginated_tools_fixture(root: &Path, mode: &str) -> McpServer {
        std::fs::write(root.join("pagination-mode"), mode).unwrap();
        node_fixture(
            root,
            r#"import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = readFileSync(join(root, 'pagination-mode'), 'utf8');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
    appendFileSync(join(root, 'requests.jsonl'), line + '\n');
    const message = JSON.parse(line);
    let result;
    if (message.method === 'initialize') result = {};
    else if (message.method === 'tools/list') {
        const cursor = message.params.cursor;
        if (mode === 'repeated-cursor') result = { tools: [], nextCursor: 'same' };
        else if (mode === 'page-limit') result = { tools: [], nextCursor: String(Number(cursor ?? 0) + 1) };
        else if (mode === 'tool-limit') result = { tools: Array.from({ length: 4097 }, (_, i) => ({ name: `tool-${i}` })) };
        else if (mode === 'byte-limit') result = { tools: [{ name: 'large', description: 'x'.repeat(600000) }], ...(cursor === undefined ? { nextCursor: 'second' } : {}) };
        else if (cursor === undefined) result = { tools: [{ name: 'first' }], nextCursor: 'second' };
        else if (cursor === 'second') result = { tools: [{ name: 'second', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } }] };
        else throw new Error('unexpected cursor');
    } else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: message.params.arguments.text }] };
    if (result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
"#,
        )
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn paginated_tools_reject_repeated_cursors_and_bound_aggregate_work() {
        for (mode, message, list_requests) in [
            (
                "repeated-cursor",
                "MCP tools/list repeated a pagination cursor",
                2,
            ),
            (
                "page-limit",
                "MCP tools/list exceeded the 64 page safety limit",
                64,
            ),
            (
                "tool-limit",
                "MCP tools/list exceeded the 4096 tool safety limit",
                1,
            ),
            (
                "byte-limit",
                "MCP tools/list exceeded the 1 MiB aggregate safety limit",
                2,
            ),
        ] {
            let fixture = LifecycleFixture::new();
            let candidate = paginated_tools_fixture(&fixture.0, mode);
            let result = run_tool_call(
                spawn_test_session(&candidate),
                "second",
                &json!({"text": "synthetic"}),
                CallCancel(None),
                || async { panic!("an invalid tool list must not reach approval") },
                Duration::from_secs(60),
            )
            .await;
            assert_eq!(result, Err(AppError::validation(message)), "{mode}");
            let requests = recorded_requests(&fixture.0);
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request["method"] == "tools/list")
                    .count(),
                list_requests,
                "{mode}"
            );
            assert!(requests
                .iter()
                .all(|request| request["method"] != "tools/call"));
        }
    }

    #[cfg(any(windows, unix))]
    fn tools_list_reply(result: Value) -> Vec<u8> {
        let mut line =
            serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": 2, "result": result})).unwrap();
        line.push(b'\n');
        line
    }

    #[cfg(any(windows, unix))]
    fn recorded_requests(root: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(root.join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[cfg(any(windows, unix))]
    fn handshake_requests() -> [Value; 3] {
        [
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "aiolm", "version": env!("CARGO_PKG_VERSION")}
            }}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
        ]
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn responses_keep_numeric_id_error_precedence_null_and_line_limits() {
        let ok = |result: Value| Ok::<Value, AppError>(result);
        let string_line = |padding: usize| {
            let mut line = br#"{"id":2,"result":""#.to_vec();
            line.resize(line.len() + padding, b'x');
            line.extend_from_slice(b"\"}\n");
            line
        };
        let framing = string_line(0).len();
        let utf8_prefix = br#"{"id":2,"result":""#;
        let mut invalid_utf8 = utf8_prefix.to_vec();
        invalid_utf8.extend_from_slice(b"\xff\"}\n");
        let cases: Vec<(&str, Vec<u8>, Result<Value, AppError>)> = vec![
            (
                "object",
                tools_list_reply(json!({"tools": [], "nested": {"list": [1, "가"]}})),
                ok(json!({"tools": [], "nested": {"list": [1, "가"]}})),
            ),
            (
                "array",
                tools_list_reply(json!([1, {"two": 2}])),
                ok(json!([1, {"two": 2}])),
            ),
            (
                "string",
                tools_list_reply(json!("🦙 text")),
                ok(json!("🦙 text")),
            ),
            (
                "explicit null",
                tools_list_reply(Value::Null),
                ok(Value::Null),
            ),
            (
                "missing result",
                b"{\"jsonrpc\":\"2.0\",\"id\":2}\n".to_vec(),
                ok(Value::Null),
            ),
            (
                "only the numeric matching id is accepted",
                concat!(
                    "{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"result\":\"string id\"}\n",
                    "{\"jsonrpc\":\"2.0\",\"result\":\"missing id\"}\n",
                    "{\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"code\":1,\"message\":\"other\"}}\n",
                    "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"stale\"}\n",
                    "{\"jsonrpc\":\"2.0\",\"id\":2.0,\"result\":\"float id\"}\n",
                    "{\"jsonrpc\":\"2.0\",\"id\":-2,\"result\":\"negative id\"}\n",
                    "[\"id\",2]\n",
                    "\"text\"\n",
                    "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"accepted\":true}}\n",
                )
                .as_bytes()
                .to_vec(),
                ok(json!({"accepted": true})),
            ),
            (
                "ignored ids then end of output",
                concat!(
                    "{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"result\":\"string id\"}\n",
                    "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":\"other\"}\n",
                )
                .as_bytes()
                .to_vec(),
                Err(AppError::unavailable("MCP server closed stdout before responding")),
            ),
            (
                "error wins over result",
                b"{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32601,\"message\":\"no tools\"},\"result\":{\"tools\":[]}}\n".to_vec(),
                Err(r#"MCP request failed: {"code":-32601,"message":"no tools"}"#.into()),
            ),
            (
                "explicit null error wins over result",
                b"{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":null,\"result\":\"ignored\"}\n".to_vec(),
                Err("MCP request failed: null".into()),
            ),
            (
                "CRLF",
                b"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"crlf\":true}}\r\n".to_vec(),
                ok(json!({"crlf": true})),
            ),
            (
                "final line without LF",
                b"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"no newline\"}".to_vec(),
                ok(json!("no newline")),
            ),
            (
                "exactly 1 MiB including LF",
                string_line(MAX_RPC_LINE - framing),
                ok(Value::String("x".repeat(MAX_RPC_LINE - framing))),
            ),
            (
                "one byte over 1 MiB",
                string_line(MAX_RPC_LINE - framing + 1),
                Err(AppError::validation("MCP response exceeded the 1 MiB safety limit")),
            ),
            (
                "invalid UTF-8",
                invalid_utf8,
                Err(AppError::validation(format!(
                    "MCP response was not UTF-8: invalid utf-8 sequence of 1 bytes from index {}",
                    utf8_prefix.len()
                ))),
            ),
            (
                "invalid JSON",
                b"x\n".to_vec(),
                Err(AppError::validation("MCP returned invalid JSON: expected value at line 1 column 1")),
            ),
        ];
        for (case, reply, expected) in cases {
            let fixture = LifecycleFixture::new();
            let end_output = matches!(
                case,
                "ignored ids then end of output" | "final line without LF"
            );
            let candidate = scripted_reply_fixture(&fixture.0, &reply, end_output);
            let mut session = spawn_test_session(&candidate).await.unwrap();
            #[cfg(windows)]
            let exit = open_server_probe(&fixture.0);
            send_message(&mut session.stdin, 2, "tools/list", json!({}))
                .await
                .unwrap();
            let result = read_response(&mut session.stdout, 2).await;
            close_session(session).await;
            assert_eq!(result, expected, "{case}");
            assert_eq!(
                recorded_requests(&fixture.0),
                handshake_requests(),
                "{case}"
            );
            #[cfg(windows)]
            assert!(exit.exited(), "{case}: the MCP server must be reclaimed");
        }

        // An approved call returns the server's own result, not its input.
        let fixture = LifecycleFixture::new();
        let candidate = node_fixture(
            &fixture.0,
            r#"import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
record('server.pid', process.pid);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
    appendFileSync(join(root, 'requests.jsonl'), line + '\n');
    const message = JSON.parse(line);
    let result;
    if (message.method === 'initialize') result = {};
    else if (message.method === 'tools/list') result = { tools: [{ name: 'shout', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } }] };
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: message.params.arguments.text.toUpperCase() }], structuredContent: { characters: [...message.params.arguments.text].length } };
    if (result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
"#,
        );
        let arguments = json!({"text": "llama 가🦙"});
        #[cfg(windows)]
        let exit = std::cell::RefCell::new(None);
        let result = run_tool_call(
            spawn_test_session(&candidate),
            "shout",
            &arguments,
            CallCancel(None),
            || {
                #[cfg(windows)]
                {
                    *exit.borrow_mut() = Some(open_server_probe(&fixture.0));
                }
                async { Ok(()) }
            },
            Duration::from_secs(60),
        )
        .await;
        assert_eq!(
            result,
            Ok(json!({
                "content": [{"type": "text", "text": "LLAMA 가🦙"}],
                "structuredContent": {"characters": 8}
            }))
        );
        let [initialize, initialized, tools_list] = handshake_requests();
        assert_eq!(
            recorded_requests(&fixture.0),
            [
                initialize,
                initialized,
                tools_list,
                json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
                    "name": "shout",
                    "arguments": {"text": "llama 가🦙"}
                }}),
            ]
        );
        #[cfg(windows)]
        assert!(exit
            .into_inner()
            .expect("the call must reach approval")
            .exited());
    }

    const PUBLIC_TOOLS_CHILD: &str = "AIOLM_MCP_PUBLIC_TOOLS_CHILD";

    /// `tools` reads the process-wide `AIOLM_HOME`, so the public calls run in
    /// a child test process with its own data folder; this process and the
    /// user's configuration are never touched.
    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn public_tools_keep_order_metadata_and_errors_in_an_isolated_home() {
        if std::env::var_os(PUBLIC_TOOLS_CHILD).is_some() {
            public_tools_in_isolated_home().await;
            return;
        }
        let parent_home = std::env::var_os("AIOLM_HOME");
        let home = LifecycleFixture::new();
        let output = crate::procutil::tokio_command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "mcp::tests::public_tools_keep_order_metadata_and_errors_in_an_isolated_home",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("AIOLM_HOME", &home.0)
            .env(PUBLIC_TOOLS_CHILD, "1")
            .output()
            .await
            .unwrap();
        assert_eq!(
            std::env::var_os("AIOLM_HOME"),
            parent_home,
            "the parent environment must remain unchanged"
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "isolated tools() child failed ({:?}):\nstdout:\n{stdout}\nstderr:\n{stderr}",
            output.status
        );
        assert!(
            stdout.contains("MCP_PUBLIC_TOOLS_CHILD_DONE")
                && stdout.contains("test result: ok. 1 passed"),
            "the exact child filter must run the whole fixture:\n{stdout}"
        );
    }

    #[cfg(any(windows, unix))]
    async fn public_tools_in_isolated_home() {
        let home = crate::home::resolve_aiolm_home().unwrap();
        assert!(home
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("aiolm-mcp-lifecycle-")));
        assert!(list().await.unwrap().is_empty());
        assert_eq!(
            tools("absent").await.unwrap_err(),
            AppError::not_found("MCP server was not found")
        );
        let schema = json!({
            "type": "object",
            "properties": {"q": {"type": "string", "enum": ["가", "🦙"]}},
            "required": ["q"]
        });
        let nested = json!({
            "type": "object",
            "properties": {"deep": {"type": "array", "items": {"type": "integer"}}}
        });
        let no_tools_array = || {
            Err::<Value, AppError>(AppError::validation(
                "MCP tools/list returned no tools array",
            ))
        };
        let cases: Vec<(&str, Vec<u8>, Result<Value, AppError>)> = vec![
            (
                "ordered metadata",
                tools_list_reply(json!({
                    "tools": [
                        {"name": "alpha", "description": "", "inputSchema": schema},
                        {"name": "검색", "description": "🦙 설명", "inputSchema": nested},
                        {"name": "bare", "annotations": {"readOnlyHint": true}}
                    ]
                })),
                Ok(json!([
                    {"name": "alpha", "description": "", "inputSchema": schema},
                    {"name": "검색", "description": "🦙 설명", "inputSchema": nested},
                    {"name": "bare", "description": null, "inputSchema": null}
                ])),
            ),
            (
                "empty",
                tools_list_reply(json!({"tools": []})),
                Ok(json!([])),
            ),
            (
                "missing tools",
                tools_list_reply(json!({})),
                no_tools_array(),
            ),
            (
                "object tools",
                tools_list_reply(json!({"tools": {"name": "x"}})),
                no_tools_array(),
            ),
            (
                "array result",
                tools_list_reply(json!([{"name": "x"}])),
                no_tools_array(),
            ),
            (
                "null result",
                tools_list_reply(Value::Null),
                no_tools_array(),
            ),
            (
                "missing result",
                b"{\"jsonrpc\":\"2.0\",\"id\":2}\n".to_vec(),
                no_tools_array(),
            ),
            (
                "wrong name type",
                tools_list_reply(json!({"tools": [{"name": "ok"}, {"name": 5}]})),
                Err(AppError::validation(
                    "invalid MCP tool metadata: invalid type: integer `5`, expected a string",
                )),
            ),
            (
                "missing name",
                tools_list_reply(json!({"tools": [{"description": "x"}]})),
                Err(AppError::validation("invalid MCP tool metadata: missing field `name`")),
            ),
            (
                "server error",
                b"{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32601,\"message\":\"no tools\"},\"result\":{\"tools\":[]}}\n".to_vec(),
                Err(r#"MCP request failed: {"code":-32601,"message":"no tools"}"#.into()),
            ),
        ];
        for (case, reply, expected) in cases {
            let fixture = LifecycleFixture::new();
            let server = scripted_reply_fixture(&fixture.0, &reply, false);
            save(server.clone()).await.unwrap();
            assert!(
                !fixture.0.join("server.pid").exists(),
                "saving must not launch the server"
            );
            approve_launch(
                &home.join(LAUNCH_APPROVAL_FILE),
                LaunchContext::capture().unwrap().fingerprint(&server),
                || async { Ok(true) },
            )
            .await
            .unwrap();
            let result = tools("test-server")
                .await
                .map(|tools| serde_json::to_value(tools).unwrap());
            assert_eq!(result, expected, "{case}");
            assert_eq!(
                recorded_requests(&fixture.0),
                handshake_requests(),
                "{case}"
            );
            #[cfg(windows)]
            {
                let pid = std::fs::read_to_string(fixture.0.join("server.pid"))
                    .unwrap()
                    .parse()
                    .unwrap();
                if let Some(exit) = crate::procutil::ProcessExitProbe::open(pid) {
                    assert!(exit.exited(), "{case}: tools() must reclaim the MCP server");
                }
            }
        }
        let fixture = LifecycleFixture::new();
        let server = paginated_tools_fixture(&fixture.0, "two-pages");
        save(server.clone()).await.unwrap();
        approve_launch(
            &home.join(LAUNCH_APPROVAL_FILE),
            LaunchContext::capture().unwrap().fingerprint(&server),
            || async { Ok(true) },
        )
        .await
        .unwrap();
        let discovered = tools("test-server").await.unwrap();
        assert_eq!(
            discovered
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        let mut expected = handshake_requests().to_vec();
        expected.push(json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {"cursor": "second"}}));
        assert_eq!(recorded_requests(&fixture.0), expected);
        let result = run_tool_call(
            spawn_test_session(&server),
            "second",
            &json!({"text": "synthetic page two"}),
            CallCancel(None),
            || async { Ok(()) },
            Duration::from_secs(60),
        )
        .await;
        assert_eq!(
            result,
            Ok(json!({"content": [{"type": "text", "text": "synthetic page two"}]}))
        );
        let mut call_requests = expected.clone();
        call_requests.push(
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
                "name": "second", "arguments": {"text": "synthetic page two"}
            }}),
        );
        expected.extend(call_requests);
        assert_eq!(recorded_requests(&fixture.0), expected);
        std::fs::remove_file(home.join(MCP_FILE)).unwrap();
        println!("MCP_PUBLIC_TOOLS_CHILD_DONE");
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
                spawn_test_session(&candidate),
                "probe",
                &json!({}),
                cancel,
                move || async move {
                    // The real prompt, held hidden at creation by the test gate.
                    let (gates, reached, release) = native_approval::tests::created_gates();
                    let mut prompt =
                        native_approval::Prompt::open_with(APPROVAL_TITLE, "synthetic", gates)
                            .map_err(AppError::unavailable)?;
                    held_tx.send(prompt.hold(reached, release)).unwrap();
                    if prompt.answer().await.map_err(AppError::unavailable)? {
                        Ok(())
                    } else {
                        Err(AppError::denied("MCP tool call rejected by the user"))
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
        assert_eq!(result, Err(AppError::cancelled(TOOL_CALL_CANCELLED)));
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
            Some(AppError::busy(
                "too many MCP tool calls are already running"
            ))
        );
        // A cancel recorded for a waiting call is still honoured at the limit.
        assert_eq!(
            admit_call(&mut calls, &format!("stopped-{}", MAX_CANCELLED_CALLS + 4)).err(),
            Some(AppError::cancelled(TOOL_CALL_CANCELLED))
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
                spawn_test_session(&candidate),
                "probe",
                &json!({}),
                cancel,
                move || async move {
                    let _ = shown.send(());
                    std::future::pending::<Result<(), AppError>>().await
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
        assert_eq!(result, Err(AppError::cancelled(TOOL_CALL_CANCELLED)));
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
            spawn_test_session(&candidate),
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
        assert_eq!(result, Err(AppError::cancelled(TOOL_CALL_CANCELLED)));
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
                spawn_test_session(&candidate),
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
        assert_eq!(result, Err(AppError::cancelled(TOOL_CALL_CANCELLED)));
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
            spawn_test_session(&candidate),
            "probe",
            &json!({}),
            CallCancel(None),
            || {
                *exit.borrow_mut() = Some(open_server_probe(&fixture.0));
                std::future::pending::<Result<(), AppError>>()
            },
            Duration::from_millis(200),
        )
        .await;
        let exit = exit
            .into_inner()
            .unwrap_or_else(|| panic!("the call must reach approval: {result:?}"));
        assert_eq!(
            result,
            Err(AppError::timeout("MCP tool approval timed out"))
        );
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
            Err(AppError::cancelled(TOOL_CALL_CANCELLED))
        );
        assert!(!call_registered(&call_id));
        // The tombstone is consumed, so a later call may reuse the id.
        let (registration, cancel) = register_tool_call(&call_id).unwrap();
        assert!(!cancel.is_cancelled());
        assert_eq!(
            register_tool_call(&call_id).err().unwrap().kind,
            ErrorKind::Busy,
            "an id runs one call at a time"
        );
        cancel_tool_call(&call_id).unwrap();
        assert!(cancel.is_cancelled());
        drop(registration);
        assert!(!call_registered(&call_id));
    }

    #[test]
    fn cancelled_call_tombstones_stay_bounded_and_ids_are_validated() {
        assert_eq!(
            cancel_tool_call("bad id\n").unwrap_err().kind,
            ErrorKind::Validation
        );
        assert_eq!(
            register_tool_call("").err().unwrap().kind,
            ErrorKind::Validation
        );
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
        assert_eq!(
            validate_server(&server("npx && whoami")).unwrap_err().kind,
            ErrorKind::Validation
        );
        assert_eq!(
            validate_server(&server("npx\nwhoami")).unwrap_err().kind,
            ErrorKind::Validation
        );
    }

    #[test]
    fn rejects_invalid_ids_and_oversized_arguments() {
        let mut candidate = server("npx");
        candidate.id = "../server".into();
        assert_eq!(
            validate_server(&candidate).unwrap_err().kind,
            ErrorKind::Validation
        );
        candidate.id = "test-server".into();
        candidate.args = vec!["x".repeat(4097)];
        assert_eq!(
            validate_server(&candidate).unwrap_err().kind,
            ErrorKind::Validation
        );
    }

    #[tokio::test]
    async fn concurrent_readers_only_observe_complete_server_documents_during_save() {
        let fixture = LifecycleFixture::new();
        let path = fixture.0.join(MCP_FILE);
        save_servers_to_path(&[server("synthetic-initial")], path.clone())
            .await
            .unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let reader = {
            let path = path.clone();
            let stop = stop.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                for _ in 0..100_000 {
                    let servers = load_servers_from_path(&path)
                        .expect("the live document is complete and remains available");
                    assert_eq!(servers.len(), 1);
                    assert!(servers[0].command.starts_with("synthetic-"));
                    if stop.load(std::sync::atomic::Ordering::Acquire) {
                        break;
                    }
                }
            })
        };
        barrier.wait();
        for index in 0..8 {
            save_servers_to_path(&[server(&format!("synthetic-{index}"))], path.clone())
                .await
                .unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Release);
        reader.join().unwrap();
        assert_eq!(
            load_servers_from_path(&path).unwrap()[0].command,
            "synthetic-7"
        );
    }

    #[tokio::test]
    async fn saved_servers_replace_atomically_and_invalid_updates_preserve_the_document() {
        let fixture = LifecycleFixture::new();
        let path = fixture.0.join(MCP_FILE);
        let initial = server("synthetic-initial");
        save_servers_to_path(&[initial], path.clone())
            .await
            .unwrap();
        let updated = server("synthetic-updated");
        save_servers_to_path(&[updated], path.clone())
            .await
            .unwrap();
        assert_eq!(
            load_servers_from_path(&path).unwrap()[0].command,
            "synthetic-updated"
        );
        let before = std::fs::read(&path).unwrap();
        let mut invalid = server("synthetic-invalid");
        invalid.args = vec!["bad\nargument".into()];
        assert!(save_servers_to_path(&[invalid], path.clone())
            .await
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_file_held_by_another_application_preserves_saved_servers_and_can_be_retried() {
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = LifecycleFixture::new();
        let path = fixture.0.join(MCP_FILE);
        save_servers_to_path(&[server("synthetic-original")], path.clone())
            .await
            .unwrap();
        let original = std::fs::read(&path).unwrap();
        // Model an external reader that does not grant delete/rename sharing.
        let external_reader = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0001)
            .open(&path)
            .unwrap();
        let error = save_servers_to_path(&[server("synthetic-updated")], path.clone())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Busy);
        assert!(error.message.contains("then retry"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
        drop(external_reader);
        save_servers_to_path(&[server("synthetic-updated")], path.clone())
            .await
            .unwrap();
        assert_eq!(
            load_servers_from_path(&path).unwrap()[0].command,
            "synthetic-updated"
        );
    }

    #[test]
    fn missing_server_document_recovers_the_newest_legacy_backup() {
        let fixture = LifecycleFixture::new();
        let path = fixture.0.join(MCP_FILE);
        let old_backup = fixture.0.join("mcp-servers.json.backup-old");
        let newest_backup = fixture.0.join("mcp-servers.json.backup-new");
        std::fs::write(&old_backup, serde_json::to_vec(&[server("old")]).unwrap()).unwrap();
        let newest = serde_json::to_vec(&[server("newest")]).unwrap();
        std::fs::write(&newest_backup, &newest).unwrap();
        for (backup, seconds) in [(&old_backup, 10), (&newest_backup, 20)] {
            std::fs::File::options()
                .write(true)
                .open(backup)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(seconds))
                .unwrap();
        }
        assert_eq!(load_servers_from_path(&path).unwrap()[0].command, "newest");
        assert_eq!(std::fs::read(&path).unwrap(), newest);
        assert!(old_backup.exists());
        assert!(newest_backup.exists());
        // A live document is never replaced just because a backup exists.
        std::fs::write(&path, serde_json::to_vec(&[server("live")]).unwrap()).unwrap();
        assert_eq!(load_servers_from_path(&path).unwrap()[0].command, "live");
    }

    #[tokio::test]
    async fn rejected_launch_never_starts_the_executable_or_records_approval() {
        let fixture = LifecycleFixture::new();
        let path = fixture.0.join(LAUNCH_APPROVAL_FILE);
        let candidate = server("synthetic-missing-executable");
        let result = spawn_session_with_approval(&candidate, &path, |description| async move {
            assert!(description.contains("\"executable\":\"synthetic-missing-executable\""));
            Ok(false)
        })
        .await;
        assert!(
            matches!(result, Err(error) if error.kind == ErrorKind::Denied && error.message == "MCP server launch rejected by the user")
        );
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn unavailable_launch_approval_never_starts_or_records_approval() {
        let fixture = LifecycleFixture::new();
        let path = fixture.0.join(LAUNCH_APPROVAL_FILE);
        let candidate = server("synthetic-missing-executable");
        let result = spawn_session_with_approval(&candidate, &path, |_| async {
            Err(AppError::unavailable(
                "cannot open the MCP approval prompt: synthetic failure",
            ))
        })
        .await;
        let error = result.err().unwrap();
        assert_eq!(error.kind, ErrorKind::Unavailable);
        assert_eq!(
            error.message,
            "cannot open the MCP approval prompt: synthetic failure"
        );
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn disabled_servers_are_busy_before_requesting_launch_approval() {
        let fixture = LifecycleFixture::new();
        let path = fixture.0.join(LAUNCH_APPROVAL_FILE);
        let mut candidate = server("synthetic-missing-executable");
        candidate.enabled = false;
        let result = spawn_session_with_approval(&candidate, &path, |_| async {
            panic!("a disabled server must not request approval");
        })
        .await;
        let error = result.err().unwrap();
        assert_eq!(error.kind, ErrorKind::Busy);
        assert_eq!(error.message, "MCP server is disabled");
        assert!(!path.exists());
    }

    #[test]
    fn malformed_server_and_approval_documents_are_validation_errors() {
        assert_eq!(
            decode_servers(b"{").unwrap_err().kind,
            ErrorKind::Validation,
        );
        let fixture = LifecycleFixture::new();
        let path = fixture.0.join(LAUNCH_APPROVAL_FILE);
        std::fs::write(&path, b"{").unwrap();
        assert_eq!(
            read_launch_approvals(&path).unwrap_err().kind,
            ErrorKind::Validation,
        );
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn denied_tool_approval_preserves_kind_and_never_sends_tools_call() {
        let fixture = LifecycleFixture::new();
        let candidate = scripted_reply_fixture(
            &fixture.0,
            &tools_list_reply(json!({"tools": [{"name": "probe"}]})),
            false,
        );
        let error = run_tool_call(
            spawn_test_session(&candidate),
            "probe",
            &json!({}),
            CallCancel(None),
            || async { Err(AppError::denied("MCP tool call rejected by the user")) },
            Duration::from_secs(60),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Denied);
        assert_eq!(error.message, "MCP tool call rejected by the user");
        assert_eq!(recorded_requests(&fixture.0), handshake_requests());
    }

    #[tokio::test]
    async fn approved_launch_is_persisted_and_reused_but_changed_inputs_require_approval() {
        let fixture = LifecycleFixture::new();
        let path = fixture.0.join(LAUNCH_APPROVAL_FILE);
        let candidate = server("synthetic-missing-executable");
        let result = spawn_session_with_approval(&candidate, &path, |_| async { Ok(true) }).await;
        assert!(
            matches!(result, Err(error) if error.kind == ErrorKind::NotFound && error.message.contains("cannot start MCP server"))
        );
        assert_eq!(read_launch_approvals(&path).unwrap().len(), 1);
        let result = spawn_session_with_approval(&candidate, &path, |_| async {
            panic!("a saved approval must not prompt again");
        })
        .await;
        assert!(
            matches!(result, Err(error) if error.kind == ErrorKind::NotFound && error.message.contains("cannot start MCP server"))
        );

        let launch = LaunchContext::capture().unwrap();
        let original = launch.fingerprint(&candidate);
        let mut changed_command = candidate.clone();
        changed_command.command.push_str("-changed");
        let mut changed_args = candidate.clone();
        changed_args.args.push("new-argument".into());
        let changed_env = LaunchContext {
            environment: vec![("SYNTHETIC_ENV".into(), "changed".into())],
            cwd: launch.cwd.clone(),
        };
        let changed_cwd = LaunchContext {
            environment: launch.environment.clone(),
            cwd: fixture.0.clone(),
        };
        for fingerprint in [
            launch.fingerprint(&changed_command),
            launch.fingerprint(&changed_args),
            changed_env.fingerprint(&candidate),
            changed_cwd.fingerprint(&candidate),
        ] {
            assert_ne!(fingerprint, original);
            let error = approve_launch(&path, fingerprint, || async { Ok(false) })
                .await
                .unwrap_err();
            assert_eq!(error.kind, ErrorKind::Denied);
            assert_eq!(error.message, "MCP server launch rejected by the user");
        }
        assert_eq!(read_launch_approvals(&path).unwrap().len(), 1);
    }

    #[test]
    fn launch_description_is_bounded_at_a_utf8_boundary() {
        let mut candidate = server("synthetic-executable");
        candidate.args = vec!["한".repeat(4000)];
        let launch = LaunchContext {
            environment: Vec::new(),
            cwd: PathBuf::from("synthetic-working-directory"),
        };
        let description = launch_approval_description(&candidate, &launch);
        assert!(description.len() <= MAX_APPROVAL_DESCRIPTION_BYTES);
        assert!(description.contains("synthetic-executable"));
        assert!(description.ends_with(APPROVAL_TRUNCATION_SUFFIX));
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
        assert_eq!(
            validate_tool_arguments(&schema, &json!({})).unwrap_err(),
            AppError::validation("MCP tool argument 'query' is required"),
        );
        assert_eq!(
            validate_tool_arguments(&schema, &json!({"query": 4})).unwrap_err(),
            AppError::validation("MCP tool argument 'query' must be string"),
        );
        assert!(validate_tool_arguments(&schema, &json!({"query": "llama"})).is_ok());
    }

    #[test]
    fn approval_description_is_bounded_and_binds_server_and_tool_identity() {
        let arguments = json!({"query": "llama"});
        let serialized = serde_json::to_string(&arguments).unwrap();
        let description = tool_approval_description(&server("npx"), "search", &serialized);
        assert!(description.contains("Test server"));
        assert!(description.contains("search"));
        assert!(description.contains("llama"));
        assert!(description.len() <= MAX_APPROVAL_DESCRIPTION_BYTES);
    }

    #[test]
    fn approval_description_matches_full_text_truncation_at_utf8_boundaries() {
        let mut candidate = server("npx");
        candidate.name = "한글 서버".into();
        for character in ["é", "가", "🦙"] {
            for padding in 0..4 {
                let query = format!(
                    "{}{}",
                    "x".repeat(padding),
                    character.repeat(MAX_APPROVAL_DESCRIPTION_BYTES)
                );
                let arguments = json!({"query": query});
                let serialized = serde_json::to_string(&arguments).unwrap();
                let full = format!(
                    "Server: {} ({})\nTool: {}\nArguments: {}\n\nAllow this one-time MCP tool call?",
                    candidate.name, candidate.id, "문서검색", serialized
                );
                let expected = if full.len() <= MAX_APPROVAL_DESCRIPTION_BYTES {
                    full
                } else {
                    let mut bounded = full;
                    let limit = MAX_APPROVAL_DESCRIPTION_BYTES
                        .saturating_sub(APPROVAL_TRUNCATION_SUFFIX.len());
                    bounded.truncate(bounded.floor_char_boundary(limit));
                    bounded.push_str(APPROVAL_TRUNCATION_SUFFIX);
                    bounded
                };
                assert_eq!(
                    tool_approval_description(&candidate, "문서검색", &serialized),
                    expected
                );
            }
        }
    }
}
