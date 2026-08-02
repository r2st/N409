/**
 * "Skip to main content" — WCAG 2.4.1 (Bypass Blocks).
 *
 * The app shell puts up to ~30 nav links ahead of the content on every single
 * page, and the marketing header another dozen. Without a bypass, a keyboard
 * or switch user pays for all of them again on every navigation before they
 * reach the thing they came for.
 *
 * Two details that are easy to get wrong:
 *
 *  - The link must be *reachable but invisible* until focused. `display: none`
 *    or `visibility: hidden` would take it out of the tab order entirely, so
 *    this uses `sr-only` + `focus:not-sr-only`, which clips it to a 1px box
 *    while leaving it focusable.
 *  - A bare fragment jump moves the *scroll* position but not, in most
 *    browsers, the *focus* — the next Tab would land back at the top of the
 *    document, which defeats the point. So the click handler focuses the
 *    target itself. That only works if the target can hold focus, hence
 *    `tabIndex={-1}` on the `<main>` elements that carry {@link MAIN_CONTENT_ID}.
 */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Props for the `<main>` that a {@link SkipLink} targets. Spread this rather
 * than repeating the id/tabIndex pair — `MainContentTargetProps` is what keeps
 * the two ends of the link in sync, and `a11y.test.tsx` asserts every shell
 * uses it.
 */
export const mainContentTargetProps = {
  id: MAIN_CONTENT_ID,
  tabIndex: -1,
  /* The element is only focusable to receive the skip; it should never draw a
     focus ring of its own when it does. Keyboard focus remains visible on the
     controls *inside* it. */
  className: 'outline-none',
} as const;

export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={(e) => {
        const target = document.getElementById(MAIN_CONTENT_ID);
        if (!target) return; // no target on this page — let the browser try the fragment
        e.preventDefault();
        target.focus();
        target.scrollIntoView?.();
      }}
      className="sr-only rounded-md font-semibold focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:bg-chrome-900 focus:px-4 focus:py-2 focus:text-sm focus:text-chrome-fg focus:shadow-lift focus:outline-2 focus:outline-offset-2 focus:outline-brass-400"
    >
      Skip to main content
    </a>
  );
}
