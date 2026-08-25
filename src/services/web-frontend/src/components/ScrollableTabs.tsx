import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A horizontally scrolling tab strip that admits it scrolls.
 *
 * The valuation workspace shows 27 tabs to an analyst. In a 944px column that
 * is ~2,550px of strip: two thirds of the tabs are off-screen, and on a
 * platform with overlay scrollbars nothing on screen says so. Worse, opening a
 * late tab directly (a deep link, or "Open tab →" from the package view) left
 * the strip parked at scroll 0, so the *active* tab was invisible — the page
 * showed Package while the nav highlighted nothing at all.
 *
 * This keeps the native scroll behaviour and adds the three things that were
 * missing: the active tab is scrolled into view, the edges fade where content
 * continues, and there are real buttons for people who would rather click than
 * shift-scroll.
 */

/** How much of the visible width one arrow press travels. */
const PAGE_FRACTION = 0.8;

/** Sub-pixel layout noise; below this an edge counts as fully reached. */
const EPSILON = 2;

export interface ScrollMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Which directions still have content. Both false means the strip fits and no
 * affordance should be drawn at all.
 */
export function scrollAffordance(m: ScrollMetrics): { left: boolean; right: boolean } {
  const maxScroll = m.scrollWidth - m.clientWidth;
  if (maxScroll <= EPSILON) return { left: false, right: false };
  return {
    left: m.scrollLeft > EPSILON,
    right: m.scrollLeft < maxScroll - EPSILON,
  };
}

export interface CentreParams extends ScrollMetrics {
  /** Active tab's left edge, relative to the strip's visible left edge. */
  activeOffset: number;
  activeWidth: number;
}

/**
 * The scroll offset that centres the active tab, clamped to the scrollable
 * range so a first or last tab settles flush against its edge rather than
 * leaving dead space.
 */
export function centredScrollLeft(p: CentreParams): number {
  const maxScroll = Math.max(0, p.scrollWidth - p.clientWidth);
  const target = p.scrollLeft + p.activeOffset - (p.clientWidth - p.activeWidth) / 2;
  return Math.min(maxScroll, Math.max(0, target));
}

/** Does the active tab already sit fully inside the visible strip? */
export function isFullyVisible(
  p: Pick<CentreParams, 'activeOffset' | 'activeWidth' | 'clientWidth'>,
): boolean {
  return p.activeOffset >= -EPSILON && p.activeOffset + p.activeWidth <= p.clientWidth + EPSILON;
}

export function ScrollableTabs({
  label,
  children,
  /** Changes to this value re-centre the active tab (pass the active route). */
  activeKey,
}: {
  label: string;
  children: ReactNode;
  activeKey?: string;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    setEdges(
      scrollAffordance({
        scrollLeft: nav.scrollLeft,
        scrollWidth: nav.scrollWidth,
        clientWidth: nav.clientWidth,
      }),
    );
  }, []);

  // Bring the active tab into view before paint, so a deep link never flashes
  // the wrong part of the strip.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) {
      const navRect = nav.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const params = {
        scrollLeft: nav.scrollLeft,
        scrollWidth: nav.scrollWidth,
        clientWidth: nav.clientWidth,
        activeOffset: activeRect.left - navRect.left,
        activeWidth: activeRect.width,
      };
      // Leave a tab that is already on screen where it is — re-centring on
      // every navigation makes the strip lurch for no reason.
      if (!isFullyVisible(params)) nav.scrollLeft = centredScrollLeft(params);
    }
    measure();
  }, [activeKey, measure]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    // ResizeObserver catches the sidebar collapsing and the window resizing
    // alike; jsdom and older browsers simply keep the initial measurement.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    observer?.observe(nav);
    return () => observer?.disconnect();
  }, [measure]);

  const page = (direction: -1 | 1) => {
    const nav = navRef.current;
    if (!nav) return;
    nav.scrollBy({ left: direction * nav.clientWidth * PAGE_FRACTION, behavior: 'smooth' });
  };

  return (
    <div className="relative mt-6">
      {edges.left && (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-px left-0 w-12 bg-gradient-to-r from-paper-100 to-transparent"
          />
          <ArrowButton side="left" onClick={() => page(-1)} />
        </>
      )}

      <nav
        ref={navRef}
        onScroll={measure}
        aria-label={label}
        className="scrollbar-none flex gap-6 overflow-x-auto overscroll-x-contain border-b border-paper-300"
      >
        {children}
      </nav>

      {edges.right && (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-px right-0 w-12 bg-gradient-to-l from-paper-100 to-transparent"
          />
          <ArrowButton side="right" onClick={() => page(1)} />
        </>
      )}
    </div>
  );
}

function ArrowButton({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Scroll tabs left' : 'Scroll tabs right'}
      className={`touch:h-11 touch:w-11 absolute top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-paper-300 bg-surface text-ink-500 shadow-card transition-colors hover:text-ink-900 ${
        side === 'left' ? 'left-0' : 'right-0'
      }`}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  );
}
