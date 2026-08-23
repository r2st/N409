import type { KeyboardEvent } from 'react';

/**
 * The keyboard half of `role="tablist"`.
 *
 * Declaring the role is a promise about the keyboard, not only a label. A
 * screen reader announcing "Needs review, tab, 2 of 5" is telling the user
 * that the arrow keys move between these five and that Tab leaves the strip —
 * and both tablists on the platform delivered neither. Arrow keys did nothing,
 * and every tab sat in the tab order, so reaching the table under a five-tab
 * strip cost five presses of Tab past controls the user had already rejected.
 * That is worse than plain buttons would have been: plain buttons promise
 * nothing and behave as promised.
 *
 * Two rules, from the ARIA authoring practices:
 *
 *   - Left/Right move focus and wrap; Home and End jump to the ends.
 *   - Exactly one tab is in the tab order — the selected one — so Tab enters
 *     the strip at the current choice and leaves it in one press.
 *
 * Activation is manual: the arrows move focus and Enter or Space chooses. The
 * alternative — selection following focus — is the recommendation only where
 * showing a panel is instant, and here arrowing across the valuation scopes
 * would rewrite the URL and refetch the list once per keypress.
 */

/** The focusable tabs of the tablist this event is inside, in document order. */
function tabsIn(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (tab) => !tab.hasAttribute('disabled') && tab.getAttribute('aria-disabled') !== 'true',
  );
}

/**
 * `onKeyDown` for the element carrying `role="tablist"`.
 *
 * The current tab is read from the event's own target rather than from
 * `document.activeElement`: a tab that holds a count badge or an icon has
 * children, and the key event arrives having bubbled from wherever focus
 * actually is.
 */
export function tabListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const list = event.currentTarget;
  const tabs = tabsIn(list);
  if (tabs.length === 0) return;

  const from = (event.target as HTMLElement).closest?.('[role="tab"]') as HTMLElement | null;
  const current = from ? tabs.indexOf(from) : -1;

  let next: number;
  switch (event.key) {
    case 'ArrowRight':
      next = current < 0 ? 0 : (current + 1) % tabs.length;
      break;
    case 'ArrowLeft':
      next = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  // Only once a key is one this owns: Home and End otherwise scroll the page,
  // and swallowing every keystroke would take the browser's find-as-you-type
  // with it.
  event.preventDefault();
  tabs[next]?.focus();
}

/**
 * The attributes every `role="tab"` needs, given whether it is the chosen one.
 *
 * Spread rather than remembered: `aria-selected` and the roving `tabIndex` are
 * the same fact written twice, and a tab that carries one without the other is
 * either unreachable by Tab or the second stop in a strip of five.
 */
export function tabProps(selected: boolean): {
  role: 'tab';
  'aria-selected': boolean;
  tabIndex: 0 | -1;
} {
  return { role: 'tab', 'aria-selected': selected, tabIndex: selected ? 0 : -1 };
}
