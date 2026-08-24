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

/**
 * Put focus on the main landmark, for a control that has just removed itself.
 *
 * A button that unmounts as a result of being pressed — "Hide" on a panel that
 * then returns `null`, "Dismiss" on a banner, the last press of "Load more" —
 * leaves the browser with nothing focused, and the browser's answer to that is
 * `<body>`. From `<body>` the next Tab starts again at the top of the document:
 * past the skip link, past the whole sidebar, back to where the user was
 * several minutes ago. Nothing is announced either, so to a screen reader the
 * press did nothing at all.
 *
 * Where the control has an obvious survivor near it — the row it acted on, the
 * box it belongs beside — focus that instead; it keeps the reader in place.
 * This is for the case where the whole region is gone and there is no such
 * thing, and the honest answer is "you are now at the top of the page
 * content". The landmark is the right target because it is the one element
 * both shells guarantee and already make focusable — see
 * {@link mainContentTargetProps}, whose `tabIndex` exists for the skip link and
 * serves exactly as well here.
 *
 * A no-op when there is no landmark (a bare-component test, a shell-less
 * route): losing focus is the status quo, and throwing would be worse.
 */
export function focusMainContent(): void {
  document.getElementById(MAIN_CONTENT_ID)?.focus();
}

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
