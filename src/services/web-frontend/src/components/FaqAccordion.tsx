import type { FaqItem } from '../lib/marketing';

/**
 * Expand/collapse FAQ accordion shared by the product pages (gap #17) and the
 * pricing page (gap #31). Built on native <details>/<summary> so it's keyboard-
 * and screen-reader-accessible with no JS state to manage.
 */
export function FaqAccordion({ items }: { items: FaqItem[] }) {
  return (
    <div className="divide-y divide-paper-300 overflow-hidden rounded-lg border border-paper-300 bg-surface shadow-card">
      {items.map((item) => (
        <details key={item.q} className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-ink-900 hover:bg-paper-50">
            <span>{item.q}</span>
            <svg
              className="shrink-0 text-ink-400 transition-transform group-open:rotate-180"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <div className="px-5 pb-4 text-sm leading-relaxed text-ink-600">{item.a}</div>
        </details>
      ))}
    </div>
  );
}
