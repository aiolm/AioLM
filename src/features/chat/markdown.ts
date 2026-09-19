/**
 * Markdown for assistant answers.
 *
 * Covers what local models actually emit — fenced code, inline code, emphasis,
 * headings, lists, quotes, tables, links and rules — and leaves anything it does
 * not know as the literal text the model wrote, which is what the panel showed
 * before. Parsing produces a tree the renderer turns into React elements, so
 * model output never reaches `innerHTML` and there is no HTML to sanitize.
 */

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Alignment = "left" | "center" | "right";

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "code"; language: string; value: string }
  | { kind: "quote"; children: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: Block[][] }
  | { kind: "table"; align: Alignment[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
/** Word character, so `_` emphasis can be refused inside a word. */
const WORD = /[\p{L}\p{N}]/u;
/** Only schemes a local chat has any business following. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s]+$/i;

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) { index += 1; continue; }

    const fence = FENCE.exec(lines[index]);
    if (fence) {
      const closing = new RegExp(`^ {0,3}\\${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end: mid-stream that is exactly the
      // code block the model is still writing.
      while (index < lines.length && !closing.test(lines[index])) { body.push(lines[index]); index += 1; }
      index += 1;
      blocks.push({ kind: "code", language: fence[2], value: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(lines[index]);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    if (RULE.test(lines[index])) { blocks.push({ kind: "rule" }); index += 1; continue; }

    if (QUOTE.test(lines[index])) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) { body.push(lines[index].replace(/^ {0,3}> ?/, "")); index += 1; }
      blocks.push({ kind: "quote", children: parseBlocks(body) });
      continue;
    }

    const table = parseTable(lines, index);
    if (table) { blocks.push(table.block); index = table.next; continue; }

    const list = parseList(lines, index);
    if (list) { blocks.push(list.block); index = list.next; continue; }

    const body = [lines[index].trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index]) && !parseTable(lines, index)) {
      body.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(body.join("\n")) });
  }
  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } | null {
  const first = ITEM.exec(lines[start]);
  if (!first) return null;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let index = start;

  while (index < lines.length) {
    const match = ITEM.exec(lines[index]);
    if (!match || match[1].length !== indent || /\d/.test(match[2]) !== ordered) break;
    // Everything the marker is followed by, so a nested list keeps the relative
    // indentation that tells `parseBlocks` it is nested.
    const offset = match[0].length - match[3].length;
    const item = [match[3]];
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      // One blank line is allowed inside an item; two end the list.
      if (!line.trim()) {
        const following = lines[index + 1];
        if (following === undefined || !following.trim() || following.search(/\S/) <= indent) break;
        item.push("");
        index += 1;
        continue;
      }
      const sibling = ITEM.exec(line);
      if (sibling && sibling[1].length <= indent) break;
      if (!sibling && line.search(/\S/) <= indent && startsBlock(line)) break;
      item.push(line.slice(Math.min(offset, line.search(/\S/))));
      index += 1;
    }
    items.push(item);
  }

  if (items.length === 0) return null;
  const start1 = ordered ? Number.parseInt(first[2], 10) : 1;
  return {
    block: { kind: "list", ordered, start: Number.isFinite(start1) ? start1 : 1, items: items.map(parseBlocks) },
    next: index,
  };
}

/** Cells of one `| a | b |` row, or `null` when the line is not one. */
function tableRow(line: string | undefined): string[] | null {
  if (line === undefined) return null;
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < body.length; at += 1) {
    if (body[at] === "\\" && body[at + 1] === "|") { cell += "|"; at += 1; continue; }
    if (body[at] === "|") { cells.push(cell.trim()); cell = ""; continue; }
    cell += body[at];
  }
  cells.push(cell.trim());
  return cells;
}

function parseTable(lines: string[], start: number): { block: Block; next: number } | null {
  const header = tableRow(lines[start]);
  const divider = tableRow(lines[start + 1]);
  if (!header || !divider || header.length < 2 || divider.length !== header.length) return null;
  const align: Alignment[] = [];
  for (const cell of divider) {
    if (/^:-+:$/.test(cell)) align.push("center");
    else if (/^-+:$/.test(cell)) align.push("right");
    else if (/^:?-+$/.test(cell)) align.push("left");
    else return null;
  }
  const rows: Inline[][][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const cells = tableRow(lines[index]);
    if (!cells || !lines[index].trim()) break;
    // Ragged rows are padded rather than dropped: a truncated stream should not
    // make the whole table disappear.
    while (cells.length < header.length) cells.push("");
    rows.push(cells.slice(0, header.length).map(parseInline));
    index += 1;
  }
  return { block: { kind: "table", align, header: header.map(parseInline), rows }, next: index };
}

const MARKS = [
  { token: "**", kind: "strong" },
  { token: "__", kind: "strong" },
  { token: "~~", kind: "del" },
  { token: "*", kind: "em" },
  { token: "_", kind: "em" },
] as const;

export function parseInline(source: string): Inline[] {
  const nodes: Inline[] = [];
  let literal = "";
  const flush = () => { if (literal) { nodes.push({ kind: "text", value: literal }); literal = ""; } };
  let at = 0;

  while (at < source.length) {
    const rest = source.slice(at);
    const character = source[at];

    if (character === "\\" && at + 1 < source.length && "\\`*_~[]()".includes(source[at + 1])) {
      literal += source[at + 1];
      at += 2;
      continue;
    }

    if (character === "`") {
      const run = /^`+/.exec(rest)![0];
      const close = source.indexOf(run, at + run.length);
      if (close !== -1) {
        flush();
        nodes.push({ kind: "code", value: source.slice(at + run.length, close).trim() });
        at = close + run.length;
        continue;
      }
    }

    if (character === "[") {
      const link = /^\[([^\][]*)\]\(\s*([^\s)]*)\s*\)/.exec(rest);
      if (link) {
        flush();
        // An unfollowable scheme keeps its markdown text rather than becoming a
        // link the app would refuse to open anyway.
        if (SAFE_HREF.test(link[2])) nodes.push({ kind: "link", href: link[2], children: parseInline(link[1]) });
        else nodes.push({ kind: "text", value: link[0] });
        at += link[0].length;
        continue;
      }
    }

    const mark = MARKS.find(candidate => rest.startsWith(candidate.token));
    if (mark && (mark.token[0] !== "_" || at === 0 || !WORD.test(source[at - 1]))) {
      const close = findClosing(source, at + mark.token.length, mark.token);
      if (close !== -1 && (mark.token[0] !== "_" || !WORD.test(source[close + mark.token.length] ?? ""))) {
        flush();
        nodes.push({ kind: mark.kind, children: parseInline(source.slice(at + mark.token.length, close)) });
        at = close + mark.token.length;
        continue;
      }
    }

    literal += character;
    at += 1;
  }

  flush();
  return nodes;
}

/** The matching closer for an emphasis run, skipping escapes and inline code. */
function findClosing(source: string, from: number, token: string): number {
  if (source[from] === undefined || /\s/.test(source[from])) return -1;
  for (let at = from; at < source.length; at += 1) {
    if (source[at] === "\\") { at += 1; continue; }
    if (source[at] === "`") {
      const run = /^`+/.exec(source.slice(at))![0];
      const close = source.indexOf(run, at + run.length);
      if (close === -1) return -1;
      at = close + run.length - 1;
      continue;
    }
    if (source.startsWith(token, at) && at > from && !/\s/.test(source[at - 1])) return at;
  }
  return -1;
}
