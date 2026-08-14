import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MarketingLayout } from '../src/components/MarketingLayout';
import { LandingPage } from '../src/pages/marketing/LandingPage';
import { PricingPage } from '../src/pages/marketing/PricingPage';

/**
 * The products dropdown in the marketing header had only two ways to shut:
 * move the mouse off it, or click the trigger a second time. Both need a
 * mouse. It is the first control in the header a keyboard user reaches, and
 * once opened it stayed open — an eight-link panel over the top of the page,
 * dismissable only by navigating away.
 *
 * These assert the two dismissals a menu owes a keyboard: Escape, and leaving
 * it. Nothing here touches the mouse behaviour, which was never broken.
 */

function renderHeader() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<MarketingLayout />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/pricing" element={<PricingPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const trigger = () => screen.getByRole('button', { name: /^Products/ });

/** The panel the trigger points at, or null when it is shut. The landing page
 *  behind it links to the same products, so every query has to be scoped. */
const panel = () => {
  const id = trigger().getAttribute('aria-controls');
  return id ? document.getElementById(id) : null;
};

describe('the products menu can be dismissed without a mouse', () => {
  it('opens from the keyboard and announces itself as a menu trigger', async () => {
    const user = userEvent.setup();
    renderHeader();

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'true');

    trigger().focus();
    await user.keyboard('{Enter}');

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    // The trigger points at the panel it controls, so a screen reader can find
    // what just appeared.
    const panelId = trigger().getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    const user = userEvent.setup();
    renderHeader();

    trigger().focus();
    await user.keyboard('{Enter}');
    expect(within(panel()!).getByRole('link', { name: '409A Valuation' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).toBeNull();
    // Focus must not be left on a node that has just been unmounted.
    expect(trigger()).toHaveFocus();
  });

  /**
   * The other half: tabbing off the end of the panel is what a keyboard user
   * does instead of moving the mouse away, and it left the panel open and
   * overlapping whatever they landed on.
   */
  it('closes when focus leaves it for the next header link', async () => {
    const user = userEvent.setup();
    renderHeader();

    trigger().focus();
    await user.keyboard('{Enter}');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');

    // Land on the last link in the panel and Tab off the far side of it.
    const links = within(panel()!).getAllByRole('link');
    links[links.length - 1]!.focus();
    await user.tab();

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).toBeNull();
  });

  it('stays open while focus moves between its own links', async () => {
    const user = userEvent.setup();
    renderHeader();

    trigger().focus();
    await user.keyboard('{Enter}');
    await user.tab();

    // First Tab off the trigger lands inside the panel; it must survive that.
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(panel()).toContainElement(document.activeElement as HTMLElement);
  });
});
