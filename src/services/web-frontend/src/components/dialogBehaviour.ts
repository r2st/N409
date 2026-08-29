import { useEffect, useRef } from 'react';

/**
 * The two overlay hooks, extracted from `ui.tsx` (R202).
 *
 * `ui.tsx` is a 40-export barrel that 106 modules import, all of them behind a
 * lazy route — except one. `CookieConsent` is part of the eager shell, it is
 * rendered for anonymous traffic on the landing page, and it needs exactly one
 * thing from the barrel: `useDialogDismiss`. That single import put the whole
 * kit in the entry chunk, so every first-time visitor downloaded ~19 kB of
 * workspace components (tables, badges, the file dropzone, the modal) to render
 * a cookie banner and a marketing page.
 *
 * The hooks live here so that importing one costs one. `ui.tsx` re-exports both
 * for the 106 modules that already reach them through it — nothing else had to
 * move, and no call site changes meaning.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]',
]
  .map((clause) => `${clause}:not([tabindex="-1"])`)
  .join(', ');

/**
 * Focus-trap for overlays (audit F-3 P2). While `active`, keeps Tab/Shift+Tab
 * cycling inside the referenced element, moves focus in on activate and restores
 * it to the trigger on deactivate, and calls `onEscape` on the Esc key. Attach
 * the returned ref to the dialog container.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape: () => void,
): React.RefObject<T | null> {
  return useDialogBehaviour<T>(active, onEscape, true);
}

/**
 * The same dialog behaviour, minus the claim that the rest of the page is gone.
 *
 * A dialog that marks itself modal is not decorating itself; it is instructing
 * assistive technology to drop everything outside the dialog from the virtual
 * buffer. The Tab trap is the keyboard half of the same claim. Both are
 * correct for an overlay that paints a scrim over the document — nothing
 * outside it can be clicked either, so no group loses anything the others
 * keep.
 *
 * They were also on two surfaces that paint no scrim: the help widget, a
 * corner panel whose entire purpose is to be read *beside* the form it
 * explains, and the cookie gate, a strip along the bottom of the marketing
 * site on a first visit. In both, a mouse user goes on using the page — every
 * control behind is live and clickable — while a screen-reader user is shut
 * out of the whole application until they close it. The one group that most
 * needs the reference open next to the work is the only group forbidden to
 * have it, and on the marketing site the first thing a first visit does is
 * make the site unreadable.
 *
 * So: focus moves in on open, `Esc` dismisses, focus returns to the trigger on
 * close — and `Tab` walks out into the page, because the page is still there.
 */
export function useDialogDismiss<T extends HTMLElement>(
  active: boolean,
  onDismiss: () => void,
): React.RefObject<T | null> {
  return useDialogBehaviour<T>(active, onDismiss, false);
}

function useDialogBehaviour<T extends HTMLElement>(
  active: boolean,
  onEscape: () => void,
  trap: boolean,
): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  /*
   * The escape handler is read through a ref rather than depended on directly.
   * Every caller passes an inline arrow — `onClose={() => setConverting(null)}`
   * — so a dependency on it re-ran this effect on every render of the parent
   * while the overlay was open. Each re-run tore the trap down (restoring focus
   * to the trigger, outside the dialog) and set it up again (focusing the first
   * control in it), so any state the dialog owned stole focus as it changed:
   * picking a valuation type in the convert-to-engagement dialog dropped the
   * user back into the company-name box, and a caret placed mid-word jumped to
   * the end on the next keystroke. The trap should install once per opening,
   * which is what `[active]` alone says.
   */
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const container = ref.current;

    const focusable = (): HTMLElement[] =>
      container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

    (focusable()[0] ?? container)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        escapeRef.current();
        return;
      }
      if (!trap || e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        container?.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement;
      /*
       * Focus outside the dialog is the case that made this a trap in name
       * only. A browser drops focus to <body> whenever the focused element
       * stops being focusable under it — a button that disables itself while
       * the request is in flight, a row that re-renders away — and from <body>
       * the next Tab went to the first control on the page *behind* the
       * overlay. Wherever focus has ended up, Tab belongs back inside.
       */
      if (!container || !activeEl || !container.contains(activeEl)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (activeEl === first || activeEl === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreFocusRef.current?.focus?.();
    };
  }, [active, trap]);

  return ref;
}
