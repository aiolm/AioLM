import { memo, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text": return node.value;
      case "code": return <code key={index} className="chat-markdown-code">{node.value}</code>;
      case "strong": return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em": return <em key={index}>{renderInline(node.children)}</em>;
      case "del": return <del key={index}>{renderInline(node.children)}</del>;
      case "link": return <a key={index} href={node.href} target="_blank" rel="noreferrer">{renderInline(node.children)}</a>;
    }
  });
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <p key={index}>{renderInline(block.children)}</p>;
    case "heading": {
      const Tag = `h${Math.min(block.level + 2, 6)}` as "h3";
      return <Tag key={index}>{renderInline(block.children)}</Tag>;
    }
    case "code":
      return <pre key={index} className="chat-markdown-block" data-language={block.language || undefined}><code>{block.value}</code></pre>;
    case "quote":
      return <blockquote key={index}>{block.children.map(renderBlock)}</blockquote>;
    case "list":
      return block.ordered
        ? <ol key={index} start={block.start}>{block.items.map((item, at) => <li key={at}>{item.map(renderBlock)}</li>)}</ol>
        : <ul key={index}>{block.items.map((item, at) => <li key={at}>{item.map(renderBlock)}</li>)}</ul>;
    case "table":
      return <div key={index} className="chat-markdown-table"><table>
        <thead><tr>{block.header.map((cell, at) => <th key={at} style={{ textAlign: block.align[at] }}>{renderInline(cell)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, at) => <tr key={at}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.align[column] }}>{renderInline(cell)}</td>)}</tr>)}</tbody>
      </table></div>;
    case "rule":
      return <hr key={index} />;
  }
}

/**
 * An assistant answer, rendered from its markdown.
 *
 * Memoized because a streaming answer re-parses on every delta; the parse is a
 * single pass over the text, and the tree is thrown away once the string
 * changes, so there is nothing else to cache.
 */
function ChatMarkdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className="chat-markdown">{blocks.map(renderBlock)}</div>;
}

export default memo(ChatMarkdown);
