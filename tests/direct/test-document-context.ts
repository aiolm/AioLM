import assert from "node:assert/strict";
import { buildDocumentContext, buildVectorDocumentContext, documentChunksExceedSearchLimit, estimateTextTokens, MAX_SEARCHABLE_DOCUMENT_CHUNKS, rankDocumentChunks, splitDocumentChunks, type DocumentAttachment } from "../../src/features/chat/chatUtils.ts";

const document: DocumentAttachment = {
  name: "notes.md",
  path: "C:/safe/notes.md",
  text: "alpha\nbeta",
};
assert.equal(buildDocumentContext([document]), "\n\n[Attached document: notes.md]\nalpha\nbeta\n[/Attached document]");
const long: DocumentAttachment = { ...document, text: "x".repeat(20_000) };
const context = buildDocumentContext([long], 100);
assert.ok(context.length < 500);
assert.match(context, /Attached document: notes\.md/);
const ranked = rankDocumentChunks([{ ...long, text: "unrelated ".repeat(250) + "needle " + "other ".repeat(250) }], "needle");
assert.equal(ranked[0].text.includes("needle"), true);
const frequencies: DocumentAttachment[] = [
  { name: 'a.txt', path: '/synthetic/a.txt', text: 'aaaa DATA_1 data-2 한글 𐐀𐐁' },
  { name: 'b.txt', path: '/synthetic/b.txt', text: 'aa data_1 DATA-2 한글 한글 𐐨𐐩' },
];
const frequenciesBefore = structuredClone(frequencies);
assert.deepEqual(rankDocumentChunks(frequencies, 'AA data_1 DATA-2 한글 𐐀𐐁 aa').map(chunk => [chunk.document.name, chunk.score]), [
  ['a.txt', 6], ['b.txt', 6],
], 'Literal terms keep case folding, non-overlapping counts, deduplication and stable tie ordering.');
assert.deepEqual(rankDocumentChunks(frequencies, '').map(chunk => chunk.score), [0, 0]);
assert.deepEqual(frequencies, frequenciesBefore, 'Ranking must not change attachments.');
const filledContext = buildDocumentContext([long], 100, 'needle');
let laterDocumentReads = 0;
const laterDocument: DocumentAttachment = { name: 'later.txt', path: '/synthetic/later.txt',
  get text() { laterDocumentReads += 1; return 'needle '.repeat(10000); } };
assert.equal(buildDocumentContext([long, laterDocument], 100, 'needle'), filledContext);
assert.equal(laterDocumentReads, 0, 'Documents excluded by the filled context budget need no ranking or text reads.');
const vectorDocument: DocumentAttachment = { name: "vector.md", path: "C:/safe/vector.md", text: "first\nsecond" };
const vectorChunks = splitDocumentChunks([vectorDocument], 6);
const vectorContext = buildVectorDocumentContext(vectorChunks, [[1, 0], [0, 1], [0, 1]], 2, 500);
assert.ok(vectorContext?.includes("second"));
assert.ok(estimateTextTokens("한글 테스트") > estimateTextTokens("test"));
assert.equal(estimateTextTokens(''), 0);
for (const [code, tokens] of [
  [0x7f, 4], [0x80, 6], [0x303f, 6], [0x3040, 8], [0x30ff, 8], [0x3100, 6],
  [0x33ff, 6], [0x3400, 8], [0x9fff, 8], [0xa000, 6],
  [0xabff, 6], [0xac00, 8], [0xd7af, 8], [0xd7b0, 6], [0xd800, 6], [0x1f600, 6],
]) {
  assert.equal(estimateTextTokens(String.fromCodePoint(code).repeat(13)), tokens,
    `Token estimates preserve character weighting at U+${code.toString(16).toUpperCase()}.`);
}
assert.equal(estimateTextTokens('A'.repeat(4) + 'é'.repeat(5) + '한'.repeat(9) + '😀'.repeat(5)), 10);

// A document past the 64-chunk (~115KB at the default 1800-char chunk size)
// vector-search limit must be flagged so the UI can warn the user instead of
// silently dropping the tail of the document from retrieval.
const oversizedDocument: DocumentAttachment = { name: "big.md", path: "C:/safe/big.md", text: "x".repeat(200_000) };
assert.equal(splitDocumentChunks([oversizedDocument]).length > MAX_SEARCHABLE_DOCUMENT_CHUNKS, true);
assert.equal(documentChunksExceedSearchLimit([oversizedDocument]), true);
assert.equal(documentChunksExceedSearchLimit([document]), false);
console.log("document context tests passed");
