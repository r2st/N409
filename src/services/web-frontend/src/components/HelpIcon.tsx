import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { articleById, categoryMeta } from '../data/helpContent';
import { Markdown } from '../lib/markdown';
import { useFocusTrap, useScrollLock } from './ui';

/**
 * Contextual help affordance: a small "?" next to a section header that opens
 * the matching help article in a right-hand slide-over — no navigation away
 * from the current task. A "Open in Help Center" link is always offered as the
 * full-page fallback (route `/help/:id`).
 */
export function HelpIcon({
  article,
  label,
  className = '',
}: {
  /** Id of the article in helpContent to surface. */
  article: string;
  /** Accessible label; defaults to the article title. */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const panelRef = useFocusTrap<HTMLDivElement>(open, close);
  useScrollLock(open);

  const found = articleById(article);
  const title = found?.title ?? 'Help';
  const category = found ? categoryMeta(found.category) : undefined;

  return (
    <>
      <button
        type="button"
        aria-label={label ?? `Help: ${title}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={`touch:min-h-11 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-ink-200 text-[0.7rem] font-bold text-ink-400 align-middle transition-colors hover:border-bond-500 hover:text-bond-600 focus:ring-2 focus:ring-bond-600/30 focus:outline-none ${className}`}
      >
        ?
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex justify-end overscroll-contain bg-chrome-950/60"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label={`Help — ${title}`}
              tabIndex={-1}
              className="flex h-full w-[min(28rem,100vw)] flex-col bg-surface shadow-lift focus:outline-none"
            >
              <div className="flex items-start justify-between gap-4 border-b border-paper-200 px-5 py-4">
                <div className="min-w-0">
                  {category && <div className="overline text-ink-400">{category.label}</div>}
                  <h2 className="mt-0.5 font-display text-lg font-semibold text-ink-900">{title}</h2>
                </div>
                <button
                  type="button"
                  aria-label="Close help"
                  onClick={close}
                  className="tap-area rounded-md p-1 text-ink-400 hover:bg-paper-100 hover:text-ink-700"
                >
                  <svg
                    aria-hidden="true"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M5 5l14 14M19 5L5 19" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5">
                {found ? (
                  <Markdown source={found.body} />
                ) : (
                  <p className="text-sm text-ink-500">This help article is coming soon.</p>
                )}
              </div>

              <div className="border-t border-paper-200 px-5 py-3">
                <Link
                  to={`/help/${article}`}
                  onClick={close}
                  className="text-sm font-semibold text-bond-600 hover:text-bond-700"
                >
                  Open in Help Center →
                </Link>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
