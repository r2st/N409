import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { MarketingLayout } from '../src/components/MarketingLayout';
import { PRODUCTS } from '../src/lib/marketing';

/**
 * The marketing header's two menus, driven the way most visitors drive them —
 * with a pointer, and on a phone.
 *
 * `MarketingProductsMenu.test.tsx` covers the keyboard contract that was once
 * broken. What neither it nor `NavDrawerA11y.test.tsx` reaches is the ordinary
 * path: hovering the products trigger, and every link in the mobile drawer.
 * Those links each carry an `onClick` whose whole job is to shut the drawer
 * behind them, and a drawer left open over the page it just navigated to is
 * the failure this pins.
 */

/** Reports where the router ended up, so a nav click can be checked. */
function Here() {
  return <p>path: {useLocation().pathname}</p>;
}

function renderShell(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route element={<MarketingLayout />}>
          <Route path="*" element={<Here />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const productsTrigger = () => screen.getByRole('button', { name: /^Products/ });
const productsPanel = () => document.getElementById('marketing-products-menu');
const drawerToggle = () => screen.getByRole('button', { name: 'Toggle menu' });
const drawer = () => document.getElementById('marketing-mobile-menu');

describe('the products menu under a pointer', () => {
  it('opens on hover and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    renderShell();

    expect(productsPanel()).toBeNull();

    // The hover target is the wrapper, not the button: the panel sits below the
    // trigger and the pointer has to cross it without the menu flickering shut.
    await user.hover(productsTrigger());
    expect(productsPanel()).not.toBeNull();
    expect(productsTrigger()).toHaveAttribute('aria-expanded', 'true');

    await user.unhover(productsTrigger());
    await waitFor(() => expect(productsPanel()).toBeNull());
    expect(productsTrigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists every product, split across two columns', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.hover(productsTrigger());
    const links = within(productsPanel()!).getAllByRole('link');
    expect(links).toHaveLength(PRODUCTS.length);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(PRODUCTS.map((p) => `/products/${p.slug}`));
  });

  it('closes itself when a product is chosen from it', async () => {
    const user = userEvent.setup();
    renderShell();

    // Opened from the keyboard: jsdom has no layout, so user-event models a
    // pointer move between two elements as a leave to `null` and back, which
    // React reads as the pointer having left the wrapper entirely. Hovering
    // and then clicking inside the panel therefore tears it down here in a way
    // a real browser never would — `MarketingProductsMenu.test.tsx` opens the
    // same panel the same way for the same reason.
    productsTrigger().focus();
    await user.keyboard('{Enter}');
    const first = within(productsPanel()!).getByRole('link', { name: PRODUCTS[0]!.name });
    await user.click(first);

    expect(screen.getByText(`path: /products/${PRODUCTS[0]!.slug}`)).toBeInTheDocument();
    // Navigating with the panel still open would leave it over the page the
    // visitor just asked for.
    await waitFor(() => expect(productsPanel()).toBeNull());
  });
});

describe('the products menu under a finger', () => {
  /** One tap: press and release on the same element. */
  const tap = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement) =>
    user.pointer([
      { keys: '[TouchA>]', target: el },
      { keys: '[/TouchA]', target: el },
    ]);

  it('opens on the first tap', async () => {
    const user = userEvent.setup();
    renderShell();

    /*
     * A tap fires the compatibility mouse events off the same gesture —
     * `mouseenter`, then `click`. Against a hover-to-open trigger whose click
     * toggles, that opened the panel and shut it again within the one tap, and
     * `aria-expanded` never left "false": the products menu could not be
     * opened by touch at all. The desktop nav is what shows from 768px up, so
     * this was every iPad.
     */
    await tap(user, productsTrigger());

    expect(productsTrigger()).toHaveAttribute('aria-expanded', 'true');
    expect(productsPanel()).not.toBeNull();
    expect(within(productsPanel()!).getAllByRole('link')).toHaveLength(PRODUCTS.length);
  });

  it('closes on the second tap', async () => {
    const user = userEvent.setup();
    renderShell();

    await tap(user, productsTrigger());
    await tap(user, productsTrigger());

    expect(productsTrigger()).toHaveAttribute('aria-expanded', 'false');
    expect(productsPanel()).toBeNull();
  });

  it('does not shut when the finger lifts off the trigger', async () => {
    const user = userEvent.setup();
    renderShell();

    await tap(user, productsTrigger());
    // A touch pointer is destroyed on release, which fires `pointerleave`.
    // Treating that as "the mouse moved away" would close the panel in the
    // same gesture that opened it — the original bug from the other side.
    expect(productsPanel()).not.toBeNull();
  });
});

describe('the mobile drawer', () => {
  /** Every link in the drawer, with where it should land. */
  const DESTINATIONS: Array<[string, string]> = [
    ['Pricing', '/pricing'],
    ['Which valuation?', '/which-valuation'],
    ['Sample report', '/sample-report'],
    ['409A calculator', '/tools/409a-valuation-calculator'],
    ['Log in', '/login'],
    ['Start valuation', '/register'],
  ];

  it.each(DESTINATIONS)('closes behind the %s link', async (name, path) => {
    const user = userEvent.setup();
    renderShell();

    await user.click(drawerToggle());
    expect(drawer()).not.toBeNull();

    await user.click(within(drawer()!).getByRole('link', { name }));

    expect(screen.getByText(`path: ${path}`)).toBeInTheDocument();
    // A full-width drawer that survives its own navigation hides the page.
    await waitFor(() => expect(drawer()).toBeNull());
    expect(drawerToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes behind a product chosen from the drawer', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(drawerToggle());
    const product = PRODUCTS[PRODUCTS.length - 1]!;
    await user.click(within(drawer()!).getByRole('link', { name: product.name }));

    expect(screen.getByText(`path: /products/${product.slug}`)).toBeInTheDocument();
    await waitFor(() => expect(drawer()).toBeNull());
  });

  it('carries the calculator, which the desktop nav leaves to the footer', async () => {
    const user = userEvent.setup();
    renderShell();

    // There is no room for it in the 16px-tall desktop bar, so the drawer is
    // the only nav that offers it — losing it there would strand the tool on
    // a phone.
    await user.click(drawerToggle());
    expect(within(drawer()!).getByRole('link', { name: '409A calculator' })).toHaveAttribute(
      'href',
      '/tools/409a-valuation-calculator',
    );
  });

  it('toggles shut again from its own trigger', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(drawerToggle());
    expect(drawer()).not.toBeNull();
    await user.click(drawerToggle());
    expect(drawer()).toBeNull();
  });
});
