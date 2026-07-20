import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Tiny, dependency-free Markdown renderer for **in-repo, author-trusted** help
 * content (src/data/helpContent.ts). It renders a deliberately small subset —
 * headings, paragraphs, ordered/unordered lists, bold, inline code and links —
 * straight to React nodes, so there is no `dangerouslySetInnerHTML` and no HTML
 * parsing of untrusted strings. Internal links (`/…`) route through react-router;
 * external links open in a new tab with `rel="noreferrer"`.
 */

const INLINE = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold text-ink-900">
          {m[2]}
        </strong>,
      );
    } else if (m[4] !== undefined) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="rounded bg-paper-200 px-1 py-0.5 font-mono text-[0.85em] text-ink-800"
        >
          {m[4]}
        </code>,
      );
    } else if (m[6] !== undefined) {
      const href = m[7]!;
      const linkClass = 'font-semibold text-bond-600 underline-offset-2 hover:text-bond-700 hover:underline';
      if (href.startsWith('/')) {
        nodes.push(
          <Link key={`${keyPrefix}-l${i}`} to={href} className={linkClass}>
            {m[6]}
          </Link>,
        );
      } else {
        nodes.push(
          <a key={`${keyPrefix}-l${i}`} href={href} target="_blank" rel="noreferrer" className={linkClass}>
            {m[6]}
          </a>,
        );
      }
    }
    last = INLINE.lastIndex;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING = /^(#{1,4})\s+(.*)$/;
const UL_ITEM = /^\s*[-*]\s+/;
const OL_ITEM = /^\s*\d+\.\s+/;

const headingClass: Record<number, string> = {
  1: 'font-display text-2xl font-semibold text-ink-900',
  2: 'mt-2 font-display text-xl font-semibold text-ink-900',
  3: 'mt-1 text-base font-semibold text-ink-900',
  4: 'text-sm font-semibold tracking-wide text-ink-500 uppercase',
};

/** Render a trusted Markdown string as React nodes. */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      const content = renderInline(h[2]!, `h${key}`);
      const cls = headingClass[level];
      const el =
        level === 1 ? (
          <h2 key={key} className={cls}>
            {content}
          </h2>
        ) : level === 2 ? (
          <h3 key={key} className={cls}>
            {content}
          </h3>
        ) : level === 3 ? (
          <h4 key={key} className={cls}>
            {content}
          </h4>
        ) : (
          <h5 key={key} className={cls}>
            {content}
          </h5>
        );
      blocks.push(el);
      key += 1;
      i += 1;
      continue;
    }

    if (UL_ITEM.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && UL_ITEM.test(lines[i]!)) {
        const text = lines[i]!.replace(UL_ITEM, '');
        items.push(<li key={items.length}>{renderInline(text, `ul${key}-${items.length}`)}</li>);
        i += 1;
      }
      blocks.push(
        <ul key={key} className="ml-5 list-disc space-y-1.5 text-ink-700 marker:text-ink-300">
          {items}
        </ul>,
      );
      key += 1;
      continue;
    }

    if (OL_ITEM.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && OL_ITEM.test(lines[i]!)) {
        const text = lines[i]!.replace(OL_ITEM, '');
        items.push(<li key={items.length}>{renderInline(text, `ol${key}-${items.length}`)}</li>);
        i += 1;
      }
      blocks.push(
        <ol key={key} className="ml-5 list-decimal space-y-1.5 text-ink-700 marker:text-ink-400">
          {items}
        </ol>,
      );
      key += 1;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !HEADING.test(lines[i]!) &&
      !UL_ITEM.test(lines[i]!) &&
      !OL_ITEM.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push(
      <p key={key} className="leading-relaxed text-ink-700">
        {renderInline(para.join(' '), `p${key}`)}
      </p>,
    );
    key += 1;
  }

  return <div className={`space-y-4 text-[0.95rem] ${className}`}>{blocks}</div>;
}
