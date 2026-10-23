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


    const forwardContext = "\n\nRelevant vector-retrieved context:\n[Attached document: notes.md @ 0]\nfirst \n[/Attached document]\n[Attached document: notes.md @ 6]\nsecond\n[/Attached document]";
    const reverseContext = "\n\nRelevant vector-retrieved context:\n[Attached document: notes.md @ 6]\nsecond\n[/Attached document]\n[Attached document: notes.md @ 0]\nfirst \n[/Attached document]";
    const mixedVectors = [[1], [0, 1], [1, 2]];
    const mixedBefore = structuredClone(mixedVectors);
    expect(buildVectorDocumentRetrieval(chunks, mixedVectors, 2)).toEqual({
      documentContext: forwardContext,
      retrievalSources: ["notes.md @ 0 (1.00)", "notes.md @ 6 (0.89)"],
      retrievalCitations: [
        { name: "notes.md", path: "/documents/notes.md", offset: 0, score: 1 },
        { name: "notes.md", path: "/documents/notes.md", offset: 6, score: 0.8944 },
      ],
    });
    expect(mixedVectors).toEqual(mixedBefore);
    mixedVectors[2][0] = 0;
    mixedVectors[2][1] = 1;
    expect(buildVectorDocumentRetrieval(chunks, mixedVectors, 2)).toEqual({
      documentContext: reverseContext,
      retrievalSources: ["notes.md @ 6 (1.00)", "notes.md @ 0 (0.00)"],
      retrievalCitations: [
        { name: "notes.md", path: "/documents/notes.md", offset: 6, score: 1 },
        { name: "notes.md", path: "/documents/notes.md", offset: 0, score: 0 },
      ],
    });
    for (const edgeVectors of [
      [[1, 0], [0, 1], [0, 0]],
      [[Number.MAX_VALUE, 0], [0, Number.MAX_VALUE], [1, 1]],
      [[1, 0], [0, 1], [Number.NaN, 1]],
    ]) {
      expect(buildVectorDocumentRetrieval(chunks, edgeVectors, 2)).toEqual({
        documentContext: forwardContext,
        retrievalSources: ["notes.md @ 0 (0.00)", "notes.md @ 6 (0.00)"],
        retrievalCitations: [
          { name: "notes.md", path: "/documents/notes.md", offset: 0, score: 0 },
          { name: "notes.md", path: "/documents/notes.md", offset: 6, score: 0 },
        ],
      });
    }
    expect(buildVectorDocumentRetrieval(chunks, [[Infinity, 0], [0, 1], [1, 1]], 2)).toEqual({
      documentContext: "\n\nRelevant vector-retrieved context:\n[Attached document: notes.md @ 6]\nsecond\n[/Attached document]",
      retrievalSources: ["notes.md @ 6 (0.71)"],
      retrievalCitations: [{ name: "notes.md", path: "/documents/notes.md", offset: 6, score: 0.7071 }],
    });

    const costChunks = splitDocumentChunks([
      { name: "cost.md", path: "/documents/cost.md", text: "x".repeat(MAX_SEARCHABLE_DOCUMENT_CHUNKS) },
    ], 1);
    const costVectors = costChunks.map(() => [1, 0, 0, 0]);
    const costBefore = structuredClone(costVectors);
    for (const vector of costVectors) Object.freeze(vector);
    const queryValues = [1, 0, 0, 0];
    Object.freeze(queryValues);
    let queryReads = 0;
    const query = new Proxy(queryValues, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) queryReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(buildVectorDocumentRetrieval(costChunks, [...costVectors, query], costChunks.length, 1, 1)).toEqual({
      documentContext: "\n\nRelevant vector-retrieved context:\n[Attached document: cost.md @ 0]\nx\n[/Attached document]",
      retrievalSources: ["cost.md @ 0 (1.00)"],
      retrievalCitations: [{ name: "cost.md", path: "/documents/cost.md", offset: 0, score: 1 }],
    });
    expect(costVectors).toEqual(costBefore);
    expect(queryValues).toEqual([1, 0, 0, 0]);
    // Each chunk reads the query for its dot product; its shared norm is read once.
    expect(queryReads).toBe((MAX_SEARCHABLE_DOCUMENT_CHUNKS + 1) * queryValues.length);
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
    expect(embedText).toHaveBeenCalledWith("http://127.0.0.1:8080", "test-key", "model", ["question"], undefined);
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

  it.each([false, true])("cancels an in-flight embedding request with cached vectors=%s without lexical fallback", async cached => {
    const document = { name: 'notes.md', path: '/documents/notes.md', text: 'Document content' };
    const controller = new AbortController();
    if (cached) vi.mocked(loadDocumentVectors).mockResolvedValue([[1, 0]]);
    vi.mocked(embedText).mockImplementation((_url, _key, _model, _input, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    }));
    const pending = retrieveDocumentContext([document], 'question', 'model', 'test-key', 'http://127.0.0.1:8080', 'synthetic', controller.signal);
    await Promise.resolve();
    expect(embedText).toHaveBeenCalledOnce();
    expect(vi.mocked(embedText).mock.calls[0][4]).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(saveDocumentVectors).not.toHaveBeenCalled();
  });

  it("does not start embeddings when document cache loading outlives cancellation", async () => {
    const document = { name: 'notes.md', path: '/documents/notes.md', text: 'Document content' };
    const controller = new AbortController();
    let loaded!: (value: null) => void;
    vi.mocked(loadDocumentVectors).mockImplementation(() => new Promise(resolve => { loaded = resolve; }));
    const pending = retrieveDocumentContext([document], 'question', 'model', 'test-key', 'http://127.0.0.1:8080', 'synthetic', controller.signal);
    controller.abort();
    loaded(null);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(embedText).not.toHaveBeenCalled();
  });
});
