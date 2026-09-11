//! MCP server configuration and tool invocation IPC.
use crate::mcp;

#[tauri::command]
pub(crate) async fn mcp_list_servers(app: tauri::AppHandle) -> Result<Vec<mcp::McpServer>, String> {
    mcp::list(app).await
}

#[tauri::command]
pub(crate) async fn mcp_save_server(
    app: tauri::AppHandle,
    server: mcp::McpServer,
) -> Result<Vec<mcp::McpServer>, String> {
    mcp::save(app, server).await
}

#[tauri::command]
pub(crate) async fn mcp_remove_server(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<mcp::McpServer>, String> {
    mcp::remove(app, &id).await
}

#[tauri::command]
pub(crate) async fn mcp_list_tools(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<mcp::McpTool>, String> {
    mcp::tools(app, &id).await
}

#[tauri::command]
pub(crate) async fn mcp_call_tool(
    app: tauri::AppHandle,
    id: String,
    name: String,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    mcp::call_tool(app, &id, &name, arguments).await
}
