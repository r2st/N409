import type { KeyboardEvent } from 'react';

/**
 * The keyboard half of the composite ARIA roles.
 *
 * `role="tablist"` and `role="radiogroup"` are promises about the keyboard,
 * not only labels. A screen reader announcing "Drafted, tab, 6 of 9" — or
 * "System, radio button, 2 of 3" — is telling the user that the arrows move
 * between those options and that Tab leaves the group. Three groups on the
 * platform delivered neither: arrows did nothing, and every option sat in the
 * tab order, so reaching the table under the nine valuation scopes cost nine
 * presses of Tab past choices the reader had already rejected. That is a worse
 * state than plain buttons, which promise nothing and keep the promise.
 *
 * Two rules from the ARIA authoring practices, shared by both roles:
 *
 *   - Left/Right move and wrap; Home and End jump to the ends.
 *   - Exactly one option is in the tab order — the chosen one — so Tab enters
 *     the group at the current answer and leaves it in one press.
 *
 * Where they differ is activation, and the practices are explicit about it. A
 * radio group selects as it moves: the arrows *are* the choice, and a group
 * that only moved focus would leave a keyboard user unable to see what they
 * had picked. A tablist moves focus and waits for Enter or Space, because
 * selection-follows-focus is the recommendation only where showing a panel is
 * instant — arrowing across the valuation scopes would rewrite the URL and
 * refetch the list once per keypress.
 */

/** The enabled options of the group this event is inside, in document order. */
function optionsIn(group: HTMLElement, role: string): HTMLElement[] {
  return Array.from(group.querySelectorAll<HTMLElement>(`[role="${role}"]`)).filter(
    (option) => !option.hasAttribute('disabled') && option.getAttribute('aria-disabled') !== 'true',
  );
}

/**
 * Builds the `onKeyDown` for a group container.
 *
 * The current option is read from the event's own target rather than from
 * `document.activeElement`: an option that holds a count badge or an icon has
 * children, and the key event arrives having bubbled from wherever focus
 * actually is.
 */
function rovingKeyDown(role: string, selectOnMove: boolean) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    const options = optionsIn(event.currentTarget, role);
    if (options.length === 0) return;

    const from = (event.target as HTMLElement).closest?.(`[role="${role}"]`) as HTMLElement | null;
    const current = from ? options.indexOf(from) : -1;

    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % options.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = options.length - 1;
        break;
      default:
        return;
    }
    // Only once the key is one this owns: Home and End otherwise scroll the
    // page, and swallowing every keystroke would take the browser's
    // find-as-you-type with it — and, on a group of <button>s, Enter and Space.
    event.preventDefault();
    const target = options[next];
    target?.focus();
    if (selectOnMove) target?.click();
  };
}

/** `onKeyDown` for the element carrying `role="tablist"`. */
export const tabListKeyDown = rovingKeyDown('tab', false);

/** `onKeyDown` for the element carrying `role="radiogroup"`. */
export const radioGroupKeyDown = rovingKeyDown('radio', true);

/**
 * The attributes every `role="tab"` needs, given whether it is the chosen one.
 *
 * Spread rather than remembered: `aria-selected` and the roving `tabIndex` are
 * the same fact written twice, and an option that carries one without the
 * other is either unreachable by Tab or the second stop in a strip of nine.
 */
export function tabProps(selected: boolean): {
  role: 'tab';
  'aria-selected': boolean;
  tabIndex: 0 | -1;
} {
  return { role: 'tab', 'aria-selected': selected, tabIndex: selected ? 0 : -1 };
}

/**
 * The same, for `role="radio"`.
 *
 * One caveat the tab version does not have: a radio group with *nothing*
 * checked would give every option a `tabIndex` of -1 and drop out of the tab
 * order entirely. The practices handle that by making the first radio the tab
 * stop; this does not, because it sees one option at a time. Both groups here
 * always have an answer — a theme is always one of three — and the census in
 * `rovingFocus.test` holds that true rather than leaving it to be discovered.
 */
export function radioProps(checked: boolean): {
  role: 'radio';
  'aria-checked': boolean;
  tabIndex: 0 | -1;
} {
  return { role: 'radio', 'aria-checked': checked, tabIndex: checked ? 0 : -1 };
}
