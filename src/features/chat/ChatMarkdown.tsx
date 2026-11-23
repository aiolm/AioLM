import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import { translate } from "../../shared/i18n/i18nUnified";
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

const CodeBlock = memo(function CodeBlock({ language, value, locale }: { language: string; value: string; locale: Locale }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => undefined);
  };
  const label = language || translate(locale, "chat.codeBlock");
  const ariaLabel = copied
    ? translate(locale, "chat.copiedCode")
    : language
      ? `${translate(locale, "chat.copyCode")} (${language})`
      : translate(locale, "chat.copyCode");
  return (
    <div className="chat-markdown-codeblock">
      <div className="chat-markdown-codeblock-header">
        <span className="chat-markdown-codeblock-lang">{label}</span>
        <button type="button" onClick={copy} className="app-button app-button--ghost app-button--sm chat-markdown-codeblock-copy" data-icon="copy" aria-label={ariaLabel}>
          {copied ? translate(locale, "chat.copied") : translate(locale, "chat.copy")}
        </button>
      </div>
      <pre className="chat-markdown-block" role="region" aria-label={label} tabIndex={0} data-language={language || undefined}><code>{value}</code></pre>
    </div>
  );
});

function renderBlock(block: Block, index: number, locale: Locale): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <p key={index}>{renderInline(block.children)}</p>;
    case "heading": {
      const Tag = `h${Math.min(block.level + 2, 6)}` as "h3";
      return <Tag key={index}>{renderInline(block.children)}</Tag>;
    }
    case "code":
      return <CodeBlock key={index} language={block.language} value={block.value} locale={locale} />;
    case "quote":
      return <blockquote key={index}>{block.children.map((child, childIndex) => renderBlock(child, childIndex, locale))}</blockquote>;
    case "list":
      return block.ordered
        ? <ol key={index} start={block.start}>{block.items.map((item, at) => <li key={at}>{item.map((child, childIndex) => renderBlock(child, childIndex, locale))}</li>)}</ol>
        : <ul key={index}>{block.items.map((item, at) => <li key={at}>{item.map((child, childIndex) => renderBlock(child, childIndex, locale))}</li>)}</ul>;
    case "table":
      return <div key={index} className="chat-markdown-table" role="region" aria-label={translate(locale, "chat.table")} tabIndex={0}><table>
        <thead><tr>{block.header.map((cell, at) => <th key={at} style={{ textAlign: block.align[at] }}>{renderInline(cell)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, at) => <tr key={at}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.align[column] }}>{renderInline(cell)}</td>)}</tr>)}</tbody>
      </table></div>;
    case "rule":
      return <hr key={index} />;
  }
}

const CompletedBlocks = memo(function CompletedBlocks({ blocks, locale }: { blocks: Block[]; locale: Locale }) {
  return <>{blocks.map((block, index) => renderBlock(block, index, locale))}</>;
});

/**
 * A stable stream identity opts into append-only parsing. Finished answers use
 * the full parser, including any canonical final text returned by the server.
 */
function ChatMarkdown({ source, stream, locale = "en" }: { source: string; stream?: object; locale?: Locale }) {
  const cache = useMemo(() => stream ? { parser: createStreamingMarkdown() } : null, [stream]);
  const parsed = useMemo(() => {
    if (!cache) return { completed: parseMarkdown(source), tail: [] };
    if (source.length < cache.parser.length) cache.parser = createStreamingMarkdown();
    return cache.parser.append(source.slice(cache.parser.length));
  }, [source, cache]);
  return <div className="chat-markdown">
    <CompletedBlocks blocks={parsed.completed} locale={locale} />
    {parsed.tail.map((block, index) => renderBlock(block, parsed.completed.length + index, locale))}
  </div>;
}

export default memo(ChatMarkdown);
