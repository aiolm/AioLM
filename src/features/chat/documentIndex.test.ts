import { describe, expect, it, vi } from "vitest";
import { indexRecordForChunks, mergeCachedVectors } from "./documentIndex";
import { splitDocumentChunks } from "./chatUtils";
import type { DocumentAttachment } from "./chatTypes";

describe("document vector cache lookup", () => {
  it("hashes a shared document once when resolving all 64 searchable chunks", () => {
    const text = "a".repeat(1800 * 64);
    const readText = vi.fn(() => text);
    const document: DocumentAttachment = { name: "notes.md", path: "/documents/notes.md", get text() { return readText(); } };
    const chunks = splitDocumentChunks([document]);
    const vectors = chunks.map((_, index) => [index, 1]);
    const record = indexRecordForChunks("model", chunks, vectors, 1, "endpoint");
    readText.mockClear();

    expect(mergeCachedVectors("model", chunks, [record], "endpoint")).toEqual(vectors);
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it("resolves requested offsets in order and retains the first vector at a duplicate offset", () => {
    const document = { name: "notes.md", path: "/documents/notes.md", text: "abcdef" };
    const chunks = splitDocumentChunks([document], 2);
    const record = indexRecordForChunks("model", [chunks[1], chunks[0], chunks[1], chunks[2]], [[1], [2], [3], [4]]);
    const resolved = mergeCachedVectors("model", [chunks[2], chunks[0], chunks[1], chunks[2]], [record]);

    expect(resolved).toEqual([[4], [2], [1], [4]]);
    expect(resolved?.[0]).toBe(record.vectors[3]);
    expect(mergeCachedVectors("model", [{ ...chunks[0], offset: 99 }], [record])).toBeNull();
  });

  it("checks distinct document contents even when their paths match", () => {
    const document = { name: "notes.md", path: "/documents/notes.md", text: "abcdef" };
    const chunks = splitDocumentChunks([document], 2);
    const record = indexRecordForChunks("model", chunks, [[1], [2], [3]]);
    const changed = { ...chunks[1], document: { ...document, text: "changed" } };

    expect(mergeCachedVectors("model", [chunks[0], changed], [record])).toBeNull();
  });

  it("invalidates cached vectors when the same attachment changes between lookups", () => {
    const document = { name: "notes.md", path: "/documents/notes.md", text: "abcdef" };
    const chunks = splitDocumentChunks([document], 2);
    const record = indexRecordForChunks("model", chunks, [[1], [2], [3]], 1, "endpoint");

    expect(mergeCachedVectors("model", chunks, [record], "endpoint")).not.toBeNull();
    expect(mergeCachedVectors("other-model", chunks, [record], "endpoint")).toBeNull();
    expect(mergeCachedVectors("model", chunks, [record], "other-endpoint")).toBeNull();
    document.text = "uvwxyz";
    expect(mergeCachedVectors("model", chunks, [record], "endpoint")).toBeNull();
  });
});
