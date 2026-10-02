import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import { defaultPreferences } from "../../shared/config/preferences";
import { isNativeRuntimeAvailable } from "../../shared/api/index";
import { PERSONALIZATION_CHANGED_EVENT, readAgentsFile, saveAgentsFile, type AgentInstructionsFile, type PersonalizationSource } from "../../shared/api/personalization";
import SettingsPanel from "./Settings";

vi.mock("../../shared/api/index", () => ({ isNativeRuntimeAvailable: vi.fn(() => true) }));
// The conflict check and event name stay real; only the file system calls are faked.
vi.mock("../../shared/api/personalization", async (importActual) => ({
  ...await importActual<typeof import("../../shared/api/personalization")>(),
  readAgentsFile: vi.fn(),
  saveAgentsFile: vi.fn(),
}));

const read = vi.mocked(readAgentsFile);
const save = vi.mocked(saveAgentsFile);
// Synthetic locations under a temporary-looking root; no real home directory is read.
const file = (source: PersonalizationSource, content: string, revision: string | null = `${source}-r1`): AgentInstructionsFile => ({
  source,
  path: String.raw`\\?\D:\tmp\home\.` + source + String.raw`\AGENTS.md`,
  exists: revision !== null,
  content,
  revision,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const mount = (reset = vi.fn()) => {
  render(<I18nProvider initialLocale="en"><SettingsPanel preferences={defaultPreferences()} update={vi.fn()} reset={reset} /></I18nProvider>);
  fireEvent.click(screen.getByRole("tab", { name: "Personalization" }));
  return reset;
};
const editor = () => screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement;
const chooseSource = (name: RegExp) => fireEvent.click(screen.getByRole("radio", { name }));

describe("personalization settings", () => {
  beforeEach(() => {
    vi.mocked(isNativeRuntimeAvailable).mockReturnValue(true);
    read.mockReset();
    save.mockReset();
  });

  it("reads each instructions file when it is chosen and shows its resolved location", async () => {
    read.mockImplementation(async (source) => file(source, `${source} instructions`));
    mount();

    expect(screen.getByText(/~\/\.agents\/AGENTS\.md first, then ~\/\.aiolm\/AGENTS\.md/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Shared agents file/ })).toBeChecked();
    await waitFor(() => expect(editor()).toHaveValue("agents instructions"));
    expect(screen.getByText(String.raw`D:\tmp\home\.agents\AGENTS.md`)).toBeInTheDocument();
    expect(screen.queryByText(/\\\\\?\\/)).not.toBeInTheDocument();

    chooseSource(/AioLM file/);
    await waitFor(() => expect(editor()).toHaveValue("aiolm instructions"));
    expect(screen.getByText(String.raw`D:\tmp\home\.aiolm\AGENTS.md`)).toBeInTheDocument();
    expect(read.mock.calls.map(([source]) => source)).toEqual(["agents", "aiolm"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("creates a missing file only on Save, then saves against the new revision and announces the change", async () => {
    read.mockImplementation(async (source) => file(source, "", null));
    let revision = 0;
    save.mockImplementation(async (source, content) => file(source, content, `${source}-r${++revision}`));
    const changed = vi.fn();
    window.addEventListener(PERSONALIZATION_CHANGED_EVENT, changed);
    mount();
    chooseSource(/AioLM file/);

    expect(await screen.findByText("This file does not exist yet. Saving creates it.")).toBeInTheDocument();
    expect(editor()).toHaveValue("");
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    fireEvent.change(editor(), { target: { value: "Answer briefly.\n" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(saveButton);

    expect(await screen.findByText(/Saved\. The next chat turn uses these instructions\./)).toBeInTheDocument();
    expect(save).toHaveBeenLastCalledWith("aiolm", "Answer briefly.\n", null);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ source: "aiolm" });
    expect(screen.queryByText("This file does not exist yet. Saving creates it.")).not.toBeInTheDocument();

    fireEvent.change(editor(), { target: { value: "Answer briefly.\nCite files.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith("aiolm", "Answer briefly.\nCite files.\n", "aiolm-r1");
    window.removeEventListener(PERSONALIZATION_CHANGED_EVENT, changed);
  });

  it("keeps the draft after an external edit and reloads only after confirming the discard", async () => {
    read.mockResolvedValueOnce(file("agents", "original")).mockResolvedValueOnce(file("agents", "edited elsewhere", "agents-r2"));
    save.mockRejectedValue("Save conflict: the file changed on disk");
    const changed = vi.fn();
    window.addEventListener(PERSONALIZATION_CHANGED_EVENT, changed);
    mount();
    await waitFor(() => expect(editor()).toHaveValue("original"));

    fireEvent.change(editor(), { target: { value: "my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/changed outside AioLM after it was loaded/)).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith("agents", "my draft", "agents-r1");
    expect(editor()).toHaveValue("my draft");
    expect(changed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(editor()).toHaveValue("my draft");
    expect(read).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and reload" }));
    await waitFor(() => expect(editor()).toHaveValue("edited elsewhere"));
    expect(read).toHaveBeenCalledTimes(2);
    window.removeEventListener(PERSONALIZATION_CHANGED_EVENT, changed);
  });

  it("applies a read or save that finishes late only to the file it was for", async () => {
    const agentsRead = deferred<AgentInstructionsFile>();
    read.mockImplementation((source) => source === "agents" ? agentsRead.promise : Promise.resolve(file("aiolm", "aiolm text")));
    mount();
    chooseSource(/AioLM file/);
    await waitFor(() => expect(editor()).toHaveValue("aiolm text"));
    fireEvent.change(editor(), { target: { value: "aiolm draft" } });

    await act(async () => { agentsRead.resolve(file("agents", "agents text")); });
    expect(editor()).toHaveValue("aiolm draft");
    chooseSource(/Shared agents file/);
    expect(editor()).toHaveValue("agents text");

    // A save still running when the user moves on lands on its own file.
    const agentsSave = deferred<AgentInstructionsFile>();
    save.mockReturnValue(agentsSave.promise);
    fireEvent.change(editor(), { target: { value: "agents draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(editor()).toHaveAttribute("readonly");
    chooseSource(/AioLM file/);
    expect(editor()).toHaveValue("aiolm draft");
    await act(async () => { agentsSave.resolve(file("agents", "agents draft", "agents-r2")); });
    expect(editor()).toHaveValue("aiolm draft");
    expect(screen.getByRole("radio", { name: /AioLM file, Unsaved changes/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Shared agents file/ })).not.toHaveAccessibleName(/Unsaved/);
  });

  it("keeps a dirty draft through settings tabs, search and preference resets", async () => {
    read.mockImplementation(async (source) => file(source, "loaded"));
    const reset = mount();
    await waitFor(() => expect(editor()).toHaveValue("loaded"));
    fireEvent.change(editor(), { target: { value: "unsaved draft" } });

    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    expect(screen.queryByRole("textbox", { name: "Instructions" })).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "AGENTS.md" } });
    expect(editor()).toHaveValue("unsaved draft");
    fireEvent.change(search, { target: { value: "theme" } });
    expect(screen.queryByRole("textbox", { name: "Instructions" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });

    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset settings" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Reset settings" }).at(-1)!);
    expect(reset).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "Personalization" }));
    expect(editor()).toHaveValue("unsaved draft");
    expect(read).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("explains that editing needs the desktop app in the browser preview", () => {
    vi.mocked(isNativeRuntimeAvailable).mockReturnValue(false);
    mount();
    expect(screen.getByText("Available in the desktop app")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Instructions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });
});
