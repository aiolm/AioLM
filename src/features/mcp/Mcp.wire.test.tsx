import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { invoke } from "../../shared/api/transport";
import { mcpListTools } from "../../shared/api/commands";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import { useChatMcpTools } from "../chat/useChatMcpTools";
import McpPanel from "./Mcp";

vi.mock("../../shared/api/transport", () => ({
  invoke: vi.fn(),
  isNativeRuntimeAvailable: () => true,
  NATIVE_RUNTIME_ERROR: "Native runtime unavailable",
}));

const server = { id: "fixture", name: "Fixture tools", command: "node", args: [], enabled: true };
const schema = {
  type: "object",
  properties: { message: { type: "string", description: "Text to return" } },
  required: ["message"],
};

describe("MCP native tool payloads", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "mcp_list_servers") return [server];
      if (command === "mcp_list_tools") return [{ name: "echo", description: null, inputSchema: schema }];
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("renders call preparation with the camelCase schema returned by native discovery", async () => {
    render(<I18nProvider initialLocale="en"><McpPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click((await screen.findByText("Fixture tools")).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Discover tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "Prepare call: echo" }));
    expect(screen.getByLabelText("JSON arguments")).toBeInTheDocument();
    expect(JSON.parse(screen.getByLabelText("Input schema").textContent!)).toEqual(schema);
    fireEvent.change(screen.getByLabelText("JSON arguments"), { target: { value: '{"message":"hello"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Review tool call" }));
    expect(screen.getByRole("button", { name: "Approve and run once" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("mcp_list_tools", { id: "fixture" });
  });

  it("preserves discovered properties and required arguments in chat function definitions", async () => {
    const setError = vi.fn();
    const { result } = renderHook(() => useChatMcpTools({ setError }));
    await act(() => result.current.refreshMcpTools());
    expect(result.current.mcpDefinitions).toHaveLength(1);
    expect(result.current.mcpDefinitions[0].function.parameters).toEqual(schema);
    expect(setError).toHaveBeenLastCalledWith(null);
  });

  it("normalizes missing schemas and accepts the existing internal spelling", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { name: "missing" },
      { name: "legacy", input_schema: schema },
      { name: "native-null", inputSchema: null, input_schema: schema },
    ]);
    expect(await mcpListTools("fixture")).toEqual([
      { name: "missing", description: undefined, input_schema: null },
      { name: "legacy", description: undefined, input_schema: schema },
      { name: "native-null", description: undefined, input_schema: null },
    ]);
  });
});
