import { memo, useMemo, type ReactNode } from "react";
import { createStreamingMarkdown, parseMarkdown, type Block, type Inline } from "./markdown";

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

const CompletedBlocks = memo(function CompletedBlocks({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map(renderBlock)}</>;
});

/**
 * A stable stream identity opts into append-only parsing. Finished answers use
 * the full parser, including any canonical final text returned by the server.
 */
function ChatMarkdown({ source, stream }: { source: string; stream?: object }) {
  const cache = useMemo(() => stream ? { parser: createStreamingMarkdown() } : null, [stream]);
  const parsed = useMemo(() => {
    if (!cache) return { completed: parseMarkdown(source), tail: [] };
    if (source.length < cache.parser.length) cache.parser = createStreamingMarkdown();
    return cache.parser.append(source.slice(cache.parser.length));
  }, [source, cache]);
  return <div className="chat-markdown">
    <CompletedBlocks blocks={parsed.completed} />
    {parsed.tail.map((block, index) => renderBlock(block, parsed.completed.length + index))}
  </div>;
}

export default memo(ChatMarkdown);
