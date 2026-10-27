import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import McpPanel from "./Mcp";

vi.mock("../../shared/api/index", () => ({
  mcpListServers: vi.fn(), mcpSaveServer: vi.fn(), mcpListTools: vi.fn(), mcpCallTool: vi.fn(),
}));

describe("MCP path presentation", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); Element.prototype.scrollIntoView = vi.fn(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("serializes the selected schema once across argument validation and approval rerenders", async () => {
    const server = { id: "schema-cache", name: "Synthetic schema cache", command: "node", args: [], enabled: true };
    const tool = { name: "echo", input_schema: { type: "object", properties: { message: { type: "string" } } } };
    vi.mocked(api.mcpListServers).mockResolvedValue([server]);
    vi.mocked(api.mcpListTools).mockResolvedValue([tool]);
    const stringify = vi.spyOn(JSON, "stringify");
    const schemaSerializationCount = () => stringify.mock.calls.filter(([value]) => value === tool.input_schema).length;
    render(<I18nProvider initialLocale="en"><McpPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click((await screen.findByText(server.name)).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Discover tools" }));
    const beforePrepare = schemaSerializationCount();
    fireEvent.click(await screen.findByRole("button", { name: "Prepare call: echo" }));
    const afterPrepare = schemaSerializationCount();
    const schema = screen.getByLabelText("Required input format (JSON Schema)");
    const displayedSchema = schema.textContent;
    expect(JSON.parse(displayedSchema!)).toEqual(tool.input_schema);
    expect(afterPrepare).toBeGreaterThan(beforePrepare);
    fireEvent.change(screen.getByLabelText("JSON arguments"), { target: { value: "invalid" } });
    expect(schema.textContent).toBe(displayedSchema);
    expect(schemaSerializationCount()).toBe(afterPrepare);
    fireEvent.click(screen.getByRole("button", { name: "Review tool call" }));
    expect(schemaSerializationCount()).toBe(afterPrepare);
    expect(screen.getByText(/Unexpected token/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("JSON arguments"), { target: { value: "{}" } });
    fireEvent.click(screen.getByRole("button", { name: "Review tool call" }));
    expect(screen.getByRole("button", { name: "Approve and run once" })).toBeInTheDocument();
    expect(schemaSerializationCount()).toBe(afterPrepare);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(schemaSerializationCount()).toBe(afterPrepare);
  });

  it.each([
    ["Executable / command", "/synthetic/tools/mcp--fixture"],
    ["Arguments, one per line", '--run\norbit96-synthetic\n--text\nstraight "double" and \'single\' quotes'],
    ["JSON arguments", '{"text":"ASCII -- flags and \\"double\\" quotes stay exact"}'],
  ])("disables automatic text correction for %s and retains literal input", async (label, literal) => {
    const server = { id: "literal", name: "Synthetic literal tools", command: "node", args: [], enabled: true };
    const tool = { name: "echo", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
    vi.mocked(api.mcpListServers).mockResolvedValue([server]);
    vi.mocked(api.mcpListTools).mockResolvedValue([tool]);
    render(<I18nProvider initialLocale="en"><McpPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click((await screen.findByText(server.name)).closest("button")!);
    if (label === "JSON arguments") {
      fireEvent.click(screen.getByRole("button", { name: "Discover tools" }));
      fireEvent.click(await screen.findByRole("button", { name: "Prepare call: echo" }));
    }
    const input = screen.getByLabelText(label);
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "off");
    fireEvent.change(input, { target: { value: literal } });
    expect(input).toHaveValue(literal);
    if (label === "JSON arguments") {
      fireEvent.click(screen.getByRole("button", { name: "Review tool call" }));
      expect(screen.getByRole("button", { name: "Approve and run once" })).toBeInTheDocument();
    }
  });

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
    fireEvent.click(screen.getByText("Required input format (JSON Schema)", { selector: "summary" }));
    expect(screen.getByLabelText("Required input format (JSON Schema)").textContent).toContain(JSON.stringify(displayDocument));
    fireEvent.change(screen.getByLabelText("JSON arguments"), { target: { value: JSON.stringify({ path: rawDocument }) } });
    expect(JSON.parse((screen.getByLabelText("JSON arguments") as HTMLTextAreaElement).value)).toEqual({ path: displayDocument });
    fireEvent.click(screen.getByRole("button", { name: "Review tool call" }));
    expect(container.textContent).not.toContain('\\\\?\\');
    fireEvent.click(screen.getByRole("button", { name: "Approve and run once" }));
    await waitFor(() => expect(api.mcpCallTool).toHaveBeenCalledWith("files", "read", { path: rawDocument }, expect.any(String)));
    const result = await screen.findByLabelText("Tool result");
    expect(JSON.parse(result.textContent!)).toEqual({ path: displayDocument, detail: `Read ${displayDocument}` });
    expect(server.command).toBe(raw);
  });
});
