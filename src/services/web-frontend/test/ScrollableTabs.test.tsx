import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ScrollableTabs,
  centredScrollLeft,
  isFullyVisible,
  scrollAffordance,
} from '../src/components/ScrollableTabs';

/**
 * The workspace's 27-tab strip. jsdom has no layout engine at all — every box
 * is 0×0 — so the geometry the component reads (`scrollWidth`, `clientWidth`,
 * `getBoundingClientRect`) is stubbed here, and `scrollBy`/`scrollLeft` are
 * recorded rather than performed.
 */

interface StripLayout {
  scrollWidth: number;
  clientWidth: number;
  /** Active tab's left edge relative to the strip, and its width. */
  active?: { offset: number; width: number };
}

const originals = {
  rect: Element.prototype.getBoundingClientRect,
  scrollLeft: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft'),
};

function stubLayout(layout: StripLayout) {
  let scrollLeft = 0;
  const scrollBy = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get: () => layout.scrollWidth,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => layout.clientWidth,
  });
  Object.defineProperty(Element.prototype, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v;
    },
  });
  Object.defineProperty(Element.prototype, 'scrollBy', { configurable: true, value: scrollBy });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const box =
      this.tagName === 'NAV'
        ? { left: 0, width: layout.clientWidth }
        : { left: layout.active?.offset ?? 0, width: layout.active?.width ?? 0 };
    return {
      ...box,
      top: 0,
      right: box.left + box.width,
      bottom: 0,
      height: 0,
      x: box.left,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return {
    scrollBy,
    get scrollLeft() {
      return scrollLeft;
    },
    set scrollLeft(v: number) {
      scrollLeft = v;
    },
  };
}

afterEach(() => {
  Element.prototype.getBoundingClientRect = originals.rect;
  for (const prop of ['scrollWidth', 'clientWidth', 'scrollBy'] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    delete (Element.prototype as unknown as Record<string, unknown>)[prop];
  }
  if (originals.scrollLeft) {
    Object.defineProperty(Element.prototype, 'scrollLeft', originals.scrollLeft);
  }
  vi.unstubAllGlobals();
});

function Strip({ activeIndex = 0, count = 6 }: { activeIndex?: number; count?: number }) {
  return (
    <ScrollableTabs label="Valuation sections" activeKey={`tab-${activeIndex}`}>
      {Array.from({ length: count }, (_, i) => (
        <a key={i} href={`#tab-${i}`} {...(i === activeIndex ? { 'aria-current': 'page' } : {})}>
          Tab {i}
        </a>
      ))}
    </ScrollableTabs>
  );
}

describe('scrollAffordance', () => {
  it('reports neither edge when the strip fits', () => {
    expect(scrollAffordance({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800 })).toEqual({
      left: false,
      right: false,
    });
  });

  it('tolerates sub-pixel layout noise rather than drawing a dead arrow', () => {
    expect(scrollAffordance({ scrollLeft: 0, scrollWidth: 801, clientWidth: 800 })).toEqual({
      left: false,
      right: false,
    });
    expect(scrollAffordance({ scrollLeft: 1, scrollWidth: 2000, clientWidth: 800 }).left).toBe(false);
  });

  it('reports the directions that still have content', () => {
    expect(scrollAffordance({ scrollLeft: 0, scrollWidth: 2550, clientWidth: 944 })).toEqual({
      left: false,
      right: true,
    });
    expect(scrollAffordance({ scrollLeft: 800, scrollWidth: 2550, clientWidth: 944 })).toEqual({
      left: true,
      right: true,
    });
    expect(scrollAffordance({ scrollLeft: 1606, scrollWidth: 2550, clientWidth: 944 })).toEqual({
      left: true,
      right: false,
    });
  });
});

describe('centredScrollLeft', () => {
  it('centres the active tab in the visible strip', () => {
    expect(
      centredScrollLeft({
        scrollLeft: 0,
        scrollWidth: 2550,
        clientWidth: 1000,
        activeOffset: 1200,
        activeWidth: 100,
      }),
    ).toBe(750);
  });

  it('settles a first or last tab flush rather than leaving dead space', () => {
    const strip = { scrollLeft: 0, scrollWidth: 2550, clientWidth: 1000 };
    expect(centredScrollLeft({ ...strip, activeOffset: 0, activeWidth: 100 })).toBe(0);
    expect(centredScrollLeft({ ...strip, activeOffset: 2500, activeWidth: 50 })).toBe(1550);
  });

  it('never scrolls a strip that fits', () => {
    expect(
      centredScrollLeft({
        scrollLeft: 0,
        scrollWidth: 800,
        clientWidth: 800,
        activeOffset: 400,
        activeWidth: 100,
      }),
    ).toBe(0);
  });
});

describe('isFullyVisible', () => {
  it('accepts a tab flush against either edge', () => {
    expect(isFullyVisible({ activeOffset: 0, activeWidth: 100, clientWidth: 944 })).toBe(true);
    expect(isFullyVisible({ activeOffset: 844, activeWidth: 100, clientWidth: 944 })).toBe(true);
  });

  it('rejects a tab that runs off either end', () => {
    expect(isFullyVisible({ activeOffset: -20, activeWidth: 100, clientWidth: 944 })).toBe(false);
    expect(isFullyVisible({ activeOffset: 900, activeWidth: 100, clientWidth: 944 })).toBe(false);
  });
});

describe('ScrollableTabs', () => {
  it('names the strip for screen readers and draws no arrows when it fits', () => {
    stubLayout({ scrollWidth: 800, clientWidth: 800 });
    render(<Strip />);

    expect(screen.getByRole('navigation', { name: 'Valuation sections' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /scroll tabs/i })).not.toBeInTheDocument();
  });

  it('offers a right arrow — and only a right arrow — parked at the start', () => {
    stubLayout({ scrollWidth: 2550, clientWidth: 944 });
    render(<Strip />);

    expect(screen.getByRole('button', { name: 'Scroll tabs right' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll tabs left' })).not.toBeInTheDocument();
  });

  it('shows both arrows once the strip is scrolled off both ends', () => {
    const strip = stubLayout({ scrollWidth: 2550, clientWidth: 944 });
    render(<Strip />);

    strip.scrollLeft = 800;
    fireEvent.scroll(screen.getByRole('navigation'));

    expect(screen.getByRole('button', { name: 'Scroll tabs left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll tabs right' })).toBeInTheDocument();
  });

  it('pages by most of a screen width, in the direction of the arrow', async () => {
    const strip = stubLayout({ scrollWidth: 2550, clientWidth: 1000 });
    render(<Strip />);

    await userEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }));
    expect(strip.scrollBy).toHaveBeenCalledWith({ left: 800, behavior: 'smooth' });

    strip.scrollLeft = 800;
    fireEvent.scroll(screen.getByRole('navigation'));
    await userEvent.click(screen.getByRole('button', { name: 'Scroll tabs left' }));
    expect(strip.scrollBy).toHaveBeenLastCalledWith({ left: -800, behavior: 'smooth' });
  });

  it('scrolls a deep-linked late tab into view instead of leaving the strip at 0', () => {
    const strip = stubLayout({
      scrollWidth: 2550,
      clientWidth: 1000,
      active: { offset: 1800, width: 100 },
    });
    render(<Strip activeIndex={5} />);

    // 0 + 1800 - (1000 - 100) / 2 = 1350
    expect(strip.scrollLeft).toBe(1350);
  });

  it('leaves a tab that is already on screen where it is', () => {
    const strip = stubLayout({
      scrollWidth: 2550,
      clientWidth: 1000,
      active: { offset: 200, width: 100 },
    });
    render(<Strip activeIndex={1} />);

    expect(strip.scrollLeft).toBe(0);
  });

  it('re-measures when the surrounding layout changes', () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const strip = stubLayout({ scrollWidth: 2550, clientWidth: 944 });
    const { unmount } = render(<Strip />);

    expect(observers).toHaveLength(1);
    strip.scrollLeft = 900;
    act(() => observers[0]!());

    expect(screen.getByRole('button', { name: 'Scroll tabs left' })).toBeInTheDocument();
    // Disconnects on unmount rather than leaking an observer per navigation.
    unmount();
  });
});
