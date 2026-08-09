import { useEffect } from 'react';

/**
 * Warn before leaving a screen that holds unsaved edits.
 *
 * Two ways out of an editor, and they need different mechanisms:
 *
 *  - Leaving the document entirely — reload, close, typing a new URL — is the
 *    browser's `beforeunload`, which can only ask for a generic confirmation.
 *    Every engine ignores the custom string; `preventDefault()` is what arms
 *    the dialog, and the message is theirs.
 *
 *  - Clicking a link inside the app never unloads anything, so `beforeunload`
 *    is silent for exactly the case that loses work most often: an analyst
 *    mid-edit on the report clicking another workspace tab. React Router's
 *    `useBlocker` would be the right tool, but it needs a data router and this
 *    app mounts a `BrowserRouter` (src/main.tsx), so intercepting the click is
 *    the portable equivalent — a capture-phase listener, armed only while
 *    `dirty`, that confirms before letting the navigation through.
 *
 * Deliberately not intercepted: the back button, and `navigate()` calls the
 * component makes itself. History entries cannot be blocked without a data
 * router, and a component that navigates away from its own unsaved state knows
 * it is doing so — that is the caller's decision to confirm, not this hook's.
 */
export function useUnsavedChanges(dirty: boolean, message: string): void {
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy engines keyed off the return value rather than the default being
      // prevented. Harmless where it is ignored, which is everywhere modern.
      e.returnValue = message;
      return message;
    };

    const onClickCapture = (e: MouseEvent) => {
      // Only a plain left click opens in this tab. Modified clicks and
      // middle-clicks open elsewhere and leave the editor where it is.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const target = e.target as Element | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      // `download` and `target=_blank` keep this document alive.
      if (anchor.hasAttribute('download')) return;
      if (anchor.target && anchor.target !== '' && anchor.target !== '_self') return;

      const href = anchor.getAttribute('href') ?? '';
      // In-page anchors (the report outline's own jump links) are not a
      // navigation at all, and neither are other-origin or non-http schemes,
      // which unload the document and are therefore `beforeunload`'s business.
      if (href.startsWith('#')) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
    };
  }, [dirty, message]);
}
