import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import McpPanel from "./Mcp";

vi.mock("../../shared/api/index", () => ({
  mcpListServers: vi.fn(), mcpSaveServer: vi.fn(), mcpListTools: vi.fn(), mcpCallTool: vi.fn(),
}));

describe("MCP path presentation", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it("cleans restored commands, metadata, schemas, approvals and results without changing server or tool arguments", async () => {
    const raw = String.raw`\\?\C:\tools\server.exe`;
    const rawDocument = String.raw`\\?\UNC\server\share\notes.md`;
    const display = String.raw`C:\tools\server.exe`;
    const displayDocument = String.raw`\\server\share\notes.md`;
    const server = { id: "files", name: raw, command: raw, args: [rawDocument], enabled: true };
    const tool = { name: "read", description: `Reads ${rawDocument}`, input_schema: { type: "object", properties: { path: { type: "string", default: rawDocument } } } };
    vi.mocked(api.mcpListServers).mockResolvedValue([server]);
    vi.mocked(api.mcpSaveServer).mockResolvedValue([server]);
    vi.mocked(api.mcpListTools).mockResolvedValue([tool]);
    vi.mocked(api.mcpCallTool).mockResolvedValue({ path: rawDocument, detail: `Read ${rawDocument}` });
    const { container } = render(<I18nProvider initialLocale="en"><McpPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click((await screen.findByText(display)).closest("button")!);
    expect(screen.getByLabelText("Executable / command")).toHaveValue(display);
    expect(screen.getByLabelText("Arguments, one per line")).toHaveValue(displayDocument);
    expect(container.querySelector('code[title]')).toHaveAttribute('title', `${display} ${displayDocument}`);
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(api.mcpSaveServer).toHaveBeenCalledWith(server));
    fireEvent.click(screen.getByRole("button", { name: "Discover tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "Prepare call: read" }));
    expect(screen.getByText(`Reads ${displayDocument}`)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Input schema", { selector: "summary" }));
    expect(screen.getByLabelText("Input schema").textContent).toContain(JSON.stringify(displayDocument));
    fireEvent.change(screen.getByLabelText("JSON arguments"), { target: { value: JSON.stringify({ path: rawDocument }) } });
    expect(JSON.parse((screen.getByLabelText("JSON arguments") as HTMLTextAreaElement).value)).toEqual({ path: displayDocument });
    fireEvent.click(screen.getByRole("button", { name: "Review tool call" }));
    expect(container.textContent).not.toContain('\\\\?\\');
    fireEvent.click(screen.getByRole("button", { name: "Approve and run once" }));
    await waitFor(() => expect(api.mcpCallTool).toHaveBeenCalledWith("files", "read", { path: rawDocument }));
    const result = await screen.findByLabelText("Tool result");
    expect(JSON.parse(result.textContent!)).toEqual({ path: displayDocument, detail: `Read ${displayDocument}` });
    expect(server.command).toBe(raw);
  });
});
