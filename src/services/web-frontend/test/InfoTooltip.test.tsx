import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field, InfoTooltip } from '../src/components/ui';

/**
 * The "?" that glosses a field.
 *
 * It is the app's whole inline-help mechanism — volatility, expected term,
 * participation caps, the discount-rate build-up all explain themselves
 * through one of these — and it answers to three different input devices at
 * once. The three do not agree about what a "hover" is, and the disagreement
 * is what this pins:
 *
 *   * a mouse hovers, and expects the bubble to follow the pointer;
 *   * a keyboard focuses, and expects the bubble to follow the focus ring;
 *   * a finger does neither, and the browser fakes both off the one tap —
 *     enter, then focus, then click. With hover-to-open and focus-to-open both
 *     firing before the click toggled, a tap opened the bubble and shut it
 *     inside the same gesture, so the first tap on any "?" in the product
 *     showed nothing.
 */

const gloss = 'Annualized standard deviation of equity value.';

const renderTip = () => render(<InfoTooltip text={gloss} label="About volatility" />);
const tip = () => screen.getByRole('button', { name: 'About volatility' });
const bubble = () => screen.queryByRole('tooltip');

/** One tap: press and release on the same element. */
const tap = (user: ReturnType<typeof userEvent.setup>, el: HTMLElement) =>
  user.pointer([
    { keys: '[TouchA>]', target: el },
    { keys: '[/TouchA]', target: el },
  ]);

describe('InfoTooltip under a finger', () => {
  it('shows the explanation on the first tap', async () => {
    const user = userEvent.setup();
    renderTip();

    await tap(user, tip());

    expect(bubble()).toHaveTextContent(gloss);
    // Announced too, not merely painted.
    expect(tip()).toHaveAttribute('aria-describedby', bubble()!.id);
  });

  it('dismisses on the second tap', async () => {
    const user = userEvent.setup();
    renderTip();

    await tap(user, tip());
    await tap(user, tip());

    expect(bubble()).toBeNull();
    expect(tip()).not.toHaveAttribute('aria-describedby');
  });

  it('survives the finger lifting, which fires a pointer leave of its own', async () => {
    const user = userEvent.setup();
    renderTip();

    await tap(user, tip());
    // A touch pointer is destroyed on release. Reading that as "the mouse
    // moved off" would shut the bubble in the gesture that opened it.
    expect(bubble()).toHaveTextContent(gloss);
  });
});

describe('InfoTooltip under a mouse', () => {
  it('follows the pointer on and off', async () => {
    const user = userEvent.setup();
    renderTip();

    expect(bubble()).toBeNull();
    await user.hover(tip());
    expect(bubble()).toHaveTextContent(gloss);

    await user.unhover(tip());
    await waitFor(() => expect(bubble()).toBeNull());
  });

  it('closes on a click, which is how a mouse dismisses one it is still over', async () => {
    const user = userEvent.setup();
    renderTip();

    await user.hover(tip());
    expect(bubble()).not.toBeNull();

    await user.click(tip());
    expect(bubble()).toBeNull();
  });
});

describe('InfoTooltip under a keyboard', () => {
  it('opens on focus and closes when focus moves on', async () => {
    const user = userEvent.setup();
    render(
      <>
        <InfoTooltip text={gloss} label="About volatility" />
        <button type="button">Next</button>
      </>,
    );

    await user.tab();
    expect(tip()).toHaveFocus();
    expect(bubble()).toHaveTextContent(gloss);

    await user.tab();
    expect(bubble()).toBeNull();
  });

  it('still opens on focus after a mouse has been over it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <InfoTooltip text={gloss} label="About volatility" />
        <button type="button">Next</button>
      </>,
    );

    // Clicking records that a pointer put focus here. Tabbing away and back
    // must not inherit that: the return trip is the keyboard's, and owes a
    // bubble.
    await user.click(tip());
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
    expect(bubble()).toBeNull();

    await user.tab({ shift: true });
    expect(tip()).toHaveFocus();
    expect(bubble()).toHaveTextContent(gloss);
  });

  it('toggles shut on Enter while focused', async () => {
    const user = userEvent.setup();
    renderTip();

    await user.tab();
    expect(bubble()).not.toBeNull();
    await user.keyboard('{Enter}');
    expect(bubble()).toBeNull();
  });
});

describe('InfoTooltip inside a Field label', () => {
  it('does not toggle the control it sits beside', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Participating" tooltip={gloss}>
        <input type="checkbox" />
      </Field>,
    );

    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);

    // The whole Field is a <label>, so an activation that reached it would
    // flip the checkbox — reading the explanation of a field must not change
    // the field. Tapped rather than clicked because a tap is the gesture that
    // both opens the bubble and would activate the label.
    await tap(user, screen.getByRole('button', { name: 'About Participating' }));

    expect(screen.getByRole('tooltip')).toHaveTextContent(gloss);
    expect(box.checked).toBe(false);
  });
});
