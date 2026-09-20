import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as documentUtils from "./chatUtils";
import {
  buildDocumentContext, buildVectorDocumentRetrieval, documentChunksExceedSearchLimit,
  MAX_SEARCHABLE_DOCUMENT_CHUNKS, rankVectorDocumentChunks, splitDocumentChunks,
} from "./chatUtils";
import { retrieveDocumentContext } from "./chatSendHelpers";
import { embedText } from "../../shared/api/index";
import { loadDocumentVectors, saveDocumentVectors } from "./documentIndex";
import type { DocumentAttachment } from "./chatTypes";

vi.mock("../../shared/api/index", () => ({ embedText: vi.fn() }));
vi.mock("./documentIndex", () => ({ loadDocumentVectors: vi.fn(), saveDocumentVectors: vi.fn() }));

describe("bounded document chunking", () => {
  it("preserves document, offset, and order metadata when stopping partway through a document", () => {
    const documents = [
      { name: "empty.md", path: "/documents/empty.md", text: "" },
      { name: "first.md", path: "/documents/first.md", text: "가나다라마" },
      { name: "second.md", path: "/documents/second.md", text: "abcdef" },
    ];
    expect(splitDocumentChunks(documents, 2, 4)).toEqual(splitDocumentChunks(documents, 2).slice(0, 4));
    expect(splitDocumentChunks(documents, 2, 0)).toEqual([]);
  });

  it("stops reading later documents once the requested chunk count is reached", () => {
    const unreadText = vi.fn(() => { throw new Error("The remaining document should not be read."); });
    const documents: DocumentAttachment[] = [
      { name: "first.md", path: "/documents/first.md", text: "abcdef" },
      { name: "next.md", path: "/documents/next.md", get text() { return unreadText(); } },
    ];
    expect(splitDocumentChunks(documents, 2, 2).map((chunk) => chunk.text)).toEqual(["ab", "cd"]);
    expect(unreadText).not.toHaveBeenCalled();
  });

  it("counts partially filled chunks in each document at the search limit", () => {
    const full = { name: "full.md", path: "/documents/full.md", text: "x".repeat(1800 * 63) };
    const partial = { name: "partial.md", path: "/documents/partial.md", text: "x" };
    expect(documentChunksExceedSearchLimit([full, partial])).toBe(false);
    expect(documentChunksExceedSearchLimit([full, partial, partial])).toBe(true);
    expect(documentChunksExceedSearchLimit([{ ...full, text: "x".repeat(1800 * 64) }])).toBe(false);
    expect(documentChunksExceedSearchLimit([{ ...full, text: "x".repeat(1800 * 64 + 1) }])).toBe(true);
    expect(documentChunksExceedSearchLimit([])).toBe(false);
  });
});

describe("shared vector ranking", () => {
  it("uses one similarity pass for context, source labels, and citation scores", () => {
    const chunks = splitDocumentChunks([{ name: "notes.md", path: "/documents/notes.md", text: "first second" }], 6);
    const coordinateRead = vi.fn();
    const vectors = [[1, 0], [0, 1], [0, 1]].map((vector) => new Proxy(vector, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) coordinateRead();
        return Reflect.get(target, key, receiver);
      },
    }));
    rankVectorDocumentChunks(chunks, vectors, 2);
    const onePassReads = coordinateRead.mock.calls.length;
    coordinateRead.mockClear();

    const result = buildVectorDocumentRetrieval(chunks, vectors, 2, 100, 1);
    expect(result.documentContext).toBe("\n\nRelevant vector-retrieved context:\n[Attached document: notes.md @ 6]\nsecond\n[/Attached document]");
    expect(result.retrievalSources).toEqual(["notes.md @ 6 (1.00)"]);
    expect(result.retrievalCitations).toEqual([{ name: "notes.md", path: "/documents/notes.md", offset: 6, score: 1 }]);
    expect(coordinateRead).toHaveBeenCalledTimes(onePassReads);
  });

  it("preserves empty results when query vectors are unavailable", () => {
    expect(buildVectorDocumentRetrieval([], [], 0)).toEqual({ documentContext: null, retrievalSources: [], retrievalCitations: [] });
  });
});

describe("document retrieval", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadDocumentVectors).mockResolvedValue(null);
    vi.mocked(saveDocumentVectors).mockResolvedValue(undefined);
  });

  it("embeds and persists only the searchable prefix while keeping the truncation warning", async () => {
    const document = { name: "large.md", path: "/documents/large.md", text: "x".repeat(200_000) };
    vi.mocked(embedText).mockImplementation(async (_url, _key, _model, texts) => texts.map(() => [1, 0]));

    const result = await retrieveDocumentContext([document], "question", "model", "test-key", "http://127.0.0.1:8080");
    const embeddedTexts = vi.mocked(embedText).mock.calls[0][3];
    expect(embeddedTexts).toHaveLength(MAX_SEARCHABLE_DOCUMENT_CHUNKS + 1);
    expect(embeddedTexts[embeddedTexts.length - 1]).toBe("question");
    expect(vi.mocked(loadDocumentVectors).mock.calls[0][1]).toHaveLength(MAX_SEARCHABLE_DOCUMENT_CHUNKS);
    expect(vi.mocked(saveDocumentVectors).mock.calls[0][1]).toHaveLength(MAX_SEARCHABLE_DOCUMENT_CHUNKS);
    expect(result.documentChunksTruncated).toBe(true);
    expect(result.retrievalCitations.map((citation) => citation.offset)).toEqual([0, 1800, 3600, 5400]);
  });

  it("reuses cached document vectors and embeds only the query", async () => {
    const lexicalContext = vi.spyOn(documentUtils, "buildDocumentContext");
    const document = { name: "notes.md", path: "/documents/notes.md", text: `${"x".repeat(1800)}second` };
    vi.mocked(loadDocumentVectors).mockResolvedValue([[1, 0], [0, 1]]);
    vi.mocked(embedText).mockResolvedValue([[0, 1]]);

    const result = await retrieveDocumentContext([document], "question", "model", "test-key", "http://127.0.0.1:8080");
    expect(embedText).toHaveBeenCalledWith("http://127.0.0.1:8080", "test-key", "model", ["question"]);
    expect(saveDocumentVectors).not.toHaveBeenCalled();
    expect(lexicalContext).not.toHaveBeenCalled();
    expect(result.retrievalSources[0]).toBe("notes.md @ 1800 (1.00)");
    expect(result.documentContext?.indexOf("second")).toBeLessThan(result.documentContext!.indexOf("xxx"));
    expect(result.documentChunksTruncated).toBe(false);
  });

  it("retains lexical context and citations when the embeddings endpoint fails", async () => {
    const document = { name: "notes.md", path: "/documents/notes.md", text: "Document content" };
    vi.mocked(embedText).mockRejectedValue(new Error("Embeddings are unavailable."));

    expect(await retrieveDocumentContext([document], "question", "model", "test-key", "http://127.0.0.1:8080")).toEqual({
      documentContext: buildDocumentContext([document], 12_000, "question"),
      retrievalSources: ["notes.md (lexical fallback)"],
      retrievalCitations: [{ name: "notes.md", path: "/documents/notes.md", offset: 0 }],
      documentChunksTruncated: false,
    });
  });
});
