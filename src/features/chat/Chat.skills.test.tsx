import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import ChatPanel from "./Chat";
import { I18nProvider } from "../../shared/i18n/i18n";
import * as api from "../../shared/api/index";
import { getChatPersonalization, readSkill, type ChatSkill } from "../../shared/api/personalization";
import { isNativeRuntimeAvailable } from "../../shared/api/transport";
import { createTestStore } from "../../testing/appStore";
import type { AppStore } from "../../shared/state/store";

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));
vi.mock("../../shared/api/index", () => ({
  pickAttachment: vi.fn(),
  readDocumentText: vi.fn(),
  readDocumentBinding: vi.fn(),
  readImageData: vi.fn(),
  embedText: vi.fn(),
  chatStream: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpListServers: vi.fn(),
  mcpListTools: vi.fn(),
  mcpCallTool: vi.fn(),
  sessionList: vi.fn(async () => []),
  sessionStart: vi.fn(),
  normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
}));
vi.mock("../../shared/api/personalization", () => ({
  getChatPersonalization: vi.fn(),
  readSkill: vi.fn(),
  PERSONALIZATION_CHANGED_EVENT: "aiolm-personalization-changed",
}));
vi.mock("../../shared/api/transport", () => ({ isNativeRuntimeAvailable: vi.fn(() => true) }));

const streamMock = vi.mocked(api.chatStream);
const loadMock = vi.mocked(getChatPersonalization);
const readMock = vi.mocked(readSkill);
const nativeMock = vi.mocked(isNativeRuntimeAvailable);

const pdf: ChatSkill = { id: "aiolm:pdf", name: "pdf", description: "Work with PDF files", source: "aiolm", path: "synthetic/pdf" };
const review: ChatSkill = { id: "agents:review", name: "review", description: "Review code changes", source: "agents", path: "synthetic/review" };

function renderPanel() {
  const base = createTestStore();
  const store = { ...base, status: { state: "running", url: "http://127.0.0.1:8080", api_key: "test-key", model: "model.gguf" } } as AppStore;
  return render(createElement(I18nProvider, { initialLocale: "en", children: createElement(ChatPanel, { store }) }));
}

function answers(text: string) {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ content: text });
    return text;
  });
}

async function openSkills() {
  fireEvent.click(screen.getByText("Skills", { selector: "summary" }));
  // jsdom does not toggle <details> on summary clicks; open it the way a browser would.
  const details = screen.getByText("Skills", { selector: "summary" }).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return details;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  nativeMock.mockReturnValue(true);
  loadMock.mockResolvedValue({ instructions: [], skills: [pdf, review], warnings: [] });
  readMock.mockImplementation(async (id) => ({ skill: [pdf, review].find((skill) => skill.id === id)!, content: `BODY-OF-${id}` }));
});

describe("chat skill picker", () => {
  it("explains that skills need the desktop app instead of showing an empty success in the browser", async () => {
    nativeMock.mockReturnValue(false);
    renderPanel();
    await screen.findByRole("log", { name: "Conversation" });
    const details = await openSkills();
    expect(within(details).getByText("Local instructions and skills are available only in the desktop app.")).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Refresh skills" })).toBeDisabled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("searches, selects and sends a skill once, then clears the selection", async () => {
    renderPanel();
    await screen.findByRole("log", { name: "Conversation" });
    const details = await openSkills();
    const search = await within(details).findByLabelText("Search skills");
    fireEvent.change(search, { target: { value: "code" } });
    expect(within(details).queryByText("pdf")).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(within(details).getByRole("checkbox", { name: /review/ }));
    const chips = screen.getByRole("group", { name: "Selected skills" });
    expect(within(chips).getByText("$review")).toBeInTheDocument();
    expect(streamMock).not.toHaveBeenCalled();

    answers("Reviewed");
    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "Check this with $review" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Reviewed", { exact: true });
    expect(readMock.mock.calls).toEqual([["agents:review"]]);
    expect(String(streamMock.mock.calls[0][3][0].content).split("BODY-OF-agents:review").length - 1).toBe(1);
    expect(screen.queryByRole("group", { name: "Selected skills" })).not.toBeInTheDocument();
  });

  it("keeps the draft and selection when a $skill is unknown", async () => {
    renderPanel();
    await screen.findByRole("log", { name: "Conversation" });
    const details = await openSkills();
    fireEvent.click(await within(details).findByRole("checkbox", { name: /pdf/ }));
    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "Use $nope please" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/Unknown skill: \$nope/)).toBeInTheDocument();
    expect(streamMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Chat message")).toHaveValue("Use $nope please");
    expect(within(screen.getByRole("group", { name: "Selected skills" })).getByText("$pdf")).toBeInTheDocument();
  });

  it("never sends while an IME composition is confirming with Enter", async () => {
    renderPanel();
    await screen.findByRole("log", { name: "Conversation" });
    const textarea = screen.getByLabelText("Chat message");
    fireEvent.change(textarea, { target: { value: "한글" } });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    await act(async () => { await Promise.resolve(); });
    expect(loadMock).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("reloads the catalog when personalization changes and ignores a late stale response", async () => {
    renderPanel();
    await screen.findByRole("log", { name: "Conversation" });
    const details = await openSkills();
    await within(details).findByRole("checkbox", { name: /review/ });

    let resolveStale!: (value: Awaited<ReturnType<typeof getChatPersonalization>>) => void;
    loadMock.mockReturnValueOnce(new Promise((resolve) => { resolveStale = resolve; }));
    loadMock.mockResolvedValueOnce({ instructions: [], skills: [pdf], warnings: ["agents/skills/bad: unreadable"] });
    const changed = () => window.dispatchEvent(new CustomEvent("aiolm-personalization-changed", { detail: { source: "agents" } }));
    act(changed);
    act(changed);
    await waitFor(() => expect(within(details).queryByRole("checkbox", { name: /review/ })).not.toBeInTheDocument());
    expect(within(details).getByText(/unreadable/)).toBeInTheDocument();
    await act(async () => { resolveStale({ instructions: [], skills: [], warnings: [] }); });
    expect(within(details).getByRole("checkbox", { name: /pdf/ })).toBeInTheDocument();
  });
});
