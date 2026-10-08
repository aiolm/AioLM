import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readDocumentBinding } from "../../shared/api/index";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import { testConfig } from "../../testing/appStore";
import { projectFromConfig, setActiveProjectId, writeProjects, type ProjectPreset } from "../projects/projectStore";
import { createChatThread, type ChatWorkspace } from "./chatHistory";
import type { DocumentAttachment } from "./chatUtils";
import { useProjectChatBinding } from "./useProjectChatBinding";
import { projectChatBindingCopy } from "./projectChatBindingCopy";

vi.mock("../../shared/api/index", () => ({ readDocumentBinding: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function project(id: string, documentCount = 1): ProjectPreset {
  return { ...projectFromConfig(id, `${id} instructions`, testConfig,
    Array.from({ length: documentCount }, (_, index) => ({ name: `${id}-${index}.txt`, path: `/synthetic/${id}-${index}.txt` })),
    [`${id}-tool`]), id };
}

type Props = { phase: "idle" | "thinking" | "streaming"; hasPendingTurn: boolean; composerRevision: number };

function setup(initialDocuments: DocumentAttachment[] = [], initialProps: Partial<Props> = {}, locale: Locale = "en") {
  const documentWrites = vi.fn();
  const view = renderHook((props: Props) => {
    const [workspace, setWorkspace] = useState<ChatWorkspace>({ activeThreadId: "first", threads: [createChatThread(1, "first"), createChatThread(2, "second")] });
    const [documents, setDocuments] = useState(initialDocuments);
    const [tools, setTools] = useState<string[]>([]);
    const binding = useProjectChatBinding({
      workspace, setWorkspace, documents,
      setDocuments: action => { documentWrites(action); setDocuments(action); },
      setSelectedTools: setTools, locale, ...props,
    });
    return { ...binding, workspace, documents, tools, setWorkspace, setDocuments };
  }, { initialProps: { phase: "idle", hasPendingTurn: false, composerRevision: 0, ...initialProps } as Props });
  return { ...view, documentWrites };
}

describe("active project chat binding", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(readDocumentBinding).mockResolvedValue("Project document");
  });

  it("blocks sending while loading and applies only the documented first four bindings", async () => {
    const selected = project("research", 16);
    writeProjects([selected]); setActiveProjectId(selected.id);
    const reads = Array.from({ length: 4 }, () => deferred<string>());
    reads.forEach(read => vi.mocked(readDocumentBinding).mockImplementationOnce(() => read.promise));
    const { result } = setup();
    expect(result.current.documentsLoading).toBe(true);
    expect(result.current.documentsError).toBeNull();
    expect(readDocumentBinding).toHaveBeenCalledTimes(4);
    expect(result.current.workspace.threads[0].systemPrompt).toBe("research instructions");
    expect(result.current.tools).toEqual(["research-tool"]);
    await act(async () => { reads.forEach((read, index) => read.resolve(`Content ${index}`)); });
    await waitFor(() => expect(result.current.documentsLoading).toBe(false));
    expect(result.current.documents).toEqual(selected.documentBindings.slice(0, 4).map((binding, index) => ({ ...binding, text: `Content ${index}` })));
    expect(result.current.documentsError).toBeNull();
  });

  it.each(["en", "ko", "ja", "zh"] as const)("names every unreadable binding and retries atomically in %s", async locale => {
    const selected = project("failure", 3);
    writeProjects([selected]); setActiveProjectId(selected.id);
    vi.mocked(readDocumentBinding).mockImplementation(async path => {
      if (path.endsWith("-0.txt") || path.endsWith("-2.txt")) throw new Error("Unreadable synthetic file");
      return "Readable synthetic file";
    });
    const manual = { name: "manual.txt", path: "/synthetic/manual.txt", text: "Keep this attachment" };
    const { result } = setup([manual], {}, locale);
    await waitFor(() => expect(result.current.documentsLoading).toBe(false));
    expect(result.current.documentsError).toContain("failure-0.txt");
    expect(result.current.documentsError).toContain("failure-2.txt");
    expect(result.current.documentsError).not.toContain("failure-1.txt");
    expect(result.current.documents).toEqual([manual]);
    vi.mocked(readDocumentBinding).mockResolvedValue("Recovered");
    act(() => result.current.retryDocuments());
    expect(result.current.documentsLoading).toBe(true);
    await waitFor(() => expect(result.current.documents).toHaveLength(4));
    expect(result.current.documentsLoading).toBe(false);
    expect(result.current.documentsError).toBeNull();
    expect(result.current.documents[0]).toBe(manual);
    expect(readDocumentBinding).toHaveBeenCalledTimes(6);
  });

  it("lets the latest project event win when document reads finish in reverse order", async () => {
    const first = project("alpha"); const second = project("beta");
    writeProjects([first, second]); setActiveProjectId(first.id);
    const older = deferred<string>(); const newer = deferred<string>();
    vi.mocked(readDocumentBinding).mockImplementation(path => path.includes("alpha") ? older.promise : newer.promise);
    const { result } = setup();
    act(() => setActiveProjectId(second.id));
    await act(async () => newer.resolve("Newest project"));
    await waitFor(() => expect(result.current.documentsError).toBeNull());
    expect(result.current.documents[0]?.name).toBe("beta-0.txt");
    await act(async () => older.resolve("Stale project"));
    expect(result.current.documents).toEqual([{ ...second.documentBindings[0], text: "Newest project" }]);
    expect(result.current.projectName).toBe("beta");
    expect(result.current.workspace.threads[0].systemPrompt).toBe("beta instructions");
    expect(result.current.tools).toEqual(["beta-tool"]);
  });

  it("rebinds a new thread and a reset composer while rejecting their older pending reads", async () => {
    const selected = project("threaded");
    writeProjects([selected]); setActiveProjectId(selected.id);
    const old = deferred<string>(); const next = deferred<string>();
    vi.mocked(readDocumentBinding).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
    const { result, rerender } = setup();
    act(() => {
      result.current.setDocuments([]);
      result.current.setWorkspace(workspace => ({ ...workspace, activeThreadId: "second" }));
    });
    await act(async () => next.resolve("New thread context"));
    expect(result.current.workspace.threads[1].systemPrompt).toBe("threaded instructions");
    expect(result.current.documents[0]?.text).toBe("New thread context");
    await act(async () => old.resolve("Wrong thread context"));
    expect(result.current.documents[0]?.text).toBe("New thread context");
    act(() => result.current.setDocuments([]));
    rerender({ phase: "idle", hasPendingTurn: false, composerRevision: 1 });
    await waitFor(() => expect(result.current.documents[0]?.text).toBe("Project document"));
    expect(readDocumentBinding).toHaveBeenCalledTimes(3);
  });

  it("does not apply prompt, tools or documents during MCP approval and resumes with the latest project", async () => {
    const first = project("pending"); const next = project("after-approval");
    writeProjects([first, next]); setActiveProjectId(first.id);
    const { result, rerender } = setup([], { hasPendingTurn: true });
    act(() => setActiveProjectId(next.id));
    expect(readDocumentBinding).not.toHaveBeenCalled();
    expect(result.current.workspace.threads[0].systemPrompt).toBe("");
    expect(result.current.tools).toEqual([]);
    rerender({ phase: "idle", hasPendingTurn: false, composerRevision: 0 });
    await waitFor(() => expect(result.current.documents[0]?.name).toBe("after-approval-0.txt"));
    expect(result.current.tools).toEqual(["after-approval-tool"]);
    expect(result.current.workspace.threads[0].systemPrompt).toBe("after-approval instructions");
  });

  it("invalidates an in-flight read when a turn begins and retries after the turn ends", async () => {
    const selected = project("busy");
    writeProjects([selected]); setActiveProjectId(selected.id);
    const pending = deferred<string>();
    vi.mocked(readDocumentBinding).mockImplementationOnce(() => pending.promise);
    const { result, rerender } = setup();
    rerender({ phase: "thinking", hasPendingTurn: false, composerRevision: 0 });
    await act(async () => pending.resolve("Arrived during generation"));
    expect(result.current.documents).toEqual([]);
    rerender({ phase: "idle", hasPendingTurn: false, composerRevision: 0 });
    await waitFor(() => expect(result.current.documents[0]?.text).toBe("Project document"));
  });

  it("preserves manual attachments added during loading and clears only known project attachments on deactivation", async () => {
    const selected = project("manual");
    writeProjects([selected]); setActiveProjectId(selected.id);
    const pending = deferred<string>();
    vi.mocked(readDocumentBinding).mockImplementationOnce(() => pending.promise);
    const { result } = setup();
    const manual = { name: "user.txt", path: "/synthetic/user.txt", text: "Manual attachment" };
    act(() => result.current.setDocuments([manual]));
    await act(async () => pending.resolve("Project context"));
    expect(result.current.documents).toHaveLength(2);
    expect(result.current.documents[0]).toBe(manual);
    act(() => setActiveProjectId(null));
    expect(result.current.documents).toEqual([manual]);
    expect(result.current.projectName).toBeNull();
    expect(result.current.documentsError).toBeNull();
  });

  it("preserves a manually attached copy of a project path when that project is deactivated", async () => {
    const selected = project("same-path");
    writeProjects([selected]); setActiveProjectId(selected.id);
    const manual = { ...selected.documentBindings[0], text: "Explicitly chosen manual content" };
    const { result } = setup([manual]);
    await waitFor(() => expect(result.current.documentsLoading).toBe(false));
    expect(result.current.documents).toEqual([manual]);
    act(() => setActiveProjectId(null));
    expect(result.current.documents).toEqual([manual]);
  });

  it("leaves unknown manual attachments untouched when there is no active project", () => {
    const manual = { name: "independent.txt", path: "/synthetic/independent.txt", text: "No active project" };
    const { result, documentWrites } = setup([manual]);
    expect(result.current.documents).toEqual([manual]);
    expect(result.current.projectName).toBeNull();
    expect(result.current.documentsLoading).toBe(false);
    expect(result.current.documentsError).toBeNull();
    expect(readDocumentBinding).not.toHaveBeenCalled();
    expect(documentWrites).not.toHaveBeenCalled();
  });

  it("reports attachment capacity instead of overwriting manual files or silently dropping project files", async () => {
    const selected = project("capacity", 4);
    writeProjects([selected]); setActiveProjectId(selected.id);
    const manual = { name: "manual.txt", path: "/synthetic/manual.txt", text: "Preserve" };
    const { result } = setup([manual]);
    await waitFor(() => expect(result.current.documentsError).toContain("capacity-0.txt"));
    expect(result.current.documents).toEqual([manual]);
    act(() => result.current.setDocuments([]));
    act(() => result.current.retryDocuments());
    await waitFor(() => expect(result.current.documents).toHaveLength(4));
    expect(result.current.documentsError).toBeNull();
  });

  it("keeps a queued manual edit when the read finishes before that edit has rendered", async () => {
    const selected = project("queued");
    writeProjects([selected]); setActiveProjectId(selected.id);
    const pending = deferred<string>();
    vi.mocked(readDocumentBinding).mockImplementationOnce(() => pending.promise);
    const { result } = setup();
    const manual = { name: "queued-manual.txt", path: "/synthetic/queued-manual.txt", text: "Keep queued edit" };
    await act(async () => {
      result.current.setDocuments([manual]);
      pending.resolve("Project content");
    });
    expect(result.current.documents).toContain(manual);
    if (result.current.documents.length === 1) {
      expect(result.current.documentsError).toBe(projectChatBindingCopy.en.changed);
      act(() => result.current.retryDocuments());
      await waitFor(() => expect(result.current.documentsError).toBeNull());
      expect(result.current.documents).toContain(manual);
      expect(result.current.documents).toHaveLength(2);
    }
  });

  it("does not write documents after unmounting", async () => {
    const selected = project("unmounted");
    writeProjects([selected]); setActiveProjectId(selected.id);
    const pending = deferred<string>();
    vi.mocked(readDocumentBinding).mockImplementationOnce(() => pending.promise);
    const { unmount, documentWrites } = setup();
    unmount();
    await act(async () => pending.resolve("Too late"));
    expect(documentWrites).not.toHaveBeenCalled();
  });
});
