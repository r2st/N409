import { useEffect, useRef } from 'react';
import { sanitizeHtml } from '../lib/m2';

/**
 * Minimal WYSIWYG editor over contentEditable — no external editor
 * dependency. Output is sanitized to the report HTML whitelist on every
 * change; the server sanitizes again on save.
 */

const TOOLS: Array<{ label: string; title: string; command: string; arg?: string; className?: string }> = [
  { label: 'B', title: 'Bold', command: 'bold', className: 'font-bold' },
  { label: 'I', title: 'Italic', command: 'italic', className: 'italic' },
  { label: 'U', title: 'Underline', command: 'underline', className: 'underline' },
  { label: 'H2', title: 'Section heading', command: 'formatBlock', arg: 'h2' },
  { label: 'H3', title: 'Sub-heading', command: 'formatBlock', arg: 'h3' },
  { label: '¶', title: 'Paragraph', command: 'formatBlock', arg: 'p' },
  { label: '• List', title: 'Bulleted list', command: 'insertUnorderedList' },
  { label: '1. List', title: 'Numbered list', command: 'insertOrderedList' },
];

/** Blank 3×3 starter table (gap 9) — headers + two body rows. */
const TABLE_HTML =
  '<table><thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead>' +
  '<tbody><tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>' +
  '<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br></p>';

export function RichTextEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Push external value changes (initial load, revert) into the editor, but
  // never while the analyst is typing in it.
  useEffect(() => {
    const el = ref.current;
    if (el && el.innerHTML !== value && document.activeElement !== el) {
      el.innerHTML = sanitizeHtml(value);
    }
  }, [value]);

  const exec = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    if (ref.current) onChange(sanitizeHtml(ref.current.innerHTML));
  };

  // Links + tables (gap 9). The sanitizer keeps only http(s)/mailto hrefs,
  // so a bad URL degrades to plain text rather than a live javascript: link.
  const insertLink = () => {
    const url = window.prompt('Link URL (https://… or mailto:…)');
    if (!url) return;
    const withScheme = /^(https?:\/\/|mailto:)/i.test(url) ? url : `https://${url}`;
    exec('createLink', withScheme);
  };

  return (
    <div className={`rounded-md border border-ink-200 bg-white ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap gap-1 border-b border-paper-300 px-2 py-1.5">
        {TOOLS.map((tool) => (
          <button
            key={tool.label}
            type="button"
            title={tool.title}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault() /* keep editor selection */}
            onClick={() => exec(tool.command, tool.arg)}
            className={`cursor-pointer rounded px-2 py-1 text-xs font-semibold text-ink-600 hover:bg-paper-200 hover:text-ink-900 disabled:cursor-not-allowed ${tool.className ?? ''}`}
          >
            {tool.label}
          </button>
        ))}
        <button
          type="button"
          title="Insert link"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={insertLink}
          className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-ink-600 underline decoration-dotted hover:bg-paper-200 hover:text-ink-900 disabled:cursor-not-allowed"
        >
          Link
        </button>
        <button
          type="button"
          title="Remove link"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('unlink')}
          className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-ink-600 hover:bg-paper-200 hover:text-ink-900 disabled:cursor-not-allowed"
        >
          Unlink
        </button>
        <button
          type="button"
          title="Insert table"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('insertHTML', TABLE_HTML)}
          className="cursor-pointer rounded px-2 py-1 text-xs font-semibold text-ink-600 hover:bg-paper-200 hover:text-ink-900 disabled:cursor-not-allowed"
        >
          Table
        </button>
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={() => {
          if (ref.current) onChange(sanitizeHtml(ref.current.innerHTML));
        }}
        className="report-editor min-h-32 px-4 py-3 text-sm leading-relaxed text-ink-900 focus:outline-none"
      />
    </div>
  );
}
