//! MCP server configuration and tool invocation IPC.
use crate::mcp;

#[tauri::command]
pub(crate) async fn mcp_list_servers() -> Result<Vec<mcp::McpServer>, String> {
    mcp::list().await
}

#[tauri::command]
pub(crate) async fn mcp_save_server(server: mcp::McpServer) -> Result<Vec<mcp::McpServer>, String> {
    mcp::save(server).await
}

#[tauri::command]
pub(crate) async fn mcp_remove_server(id: String) -> Result<Vec<mcp::McpServer>, String> {
    mcp::remove(&id).await
}

#[tauri::command]
pub(crate) async fn mcp_list_tools(id: String) -> Result<Vec<mcp::McpTool>, String> {
    mcp::tools(&id).await
}

#[tauri::command]
pub(crate) async fn mcp_call_tool(
    id: String,
    name: String,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    mcp::call_tool(&id, &name, arguments).await
}
