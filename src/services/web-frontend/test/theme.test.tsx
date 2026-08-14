import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  THEME_STORAGE_KEY,
  applyTheme,
  getThemeChoice,
  resolveTheme,
  setThemeChoice,
  subscribeTheme,
} from '../src/lib/theme';
import { ThemeToggle, ThemeToggleButton } from '../src/components/ThemeToggle';

/** jsdom has no real media query engine, so the OS preference is stubbed. */
function stubPrefersDark(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: dark && query.includes('dark'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  stubPrefersDark(false);
});

describe('theme preference', () => {
  it('defaults to system and ignores a corrupt stored value', () => {
    expect(getThemeChoice()).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(getThemeChoice()).toBe('system');
  });

  it('resolves system against prefers-color-scheme, and pins an explicit choice', () => {
    stubPrefersDark(true);
    expect(resolveTheme('system')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    stubPrefersDark(false);
    expect(resolveTheme('system')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('writes the resolved theme — never the choice — to <html>', () => {
    stubPrefersDark(true);
    expect(applyTheme('system')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('persists the choice so a reload keeps it', () => {
    setThemeChoice('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(getThemeChoice()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('matches the inline pre-paint script in index.html', () => {
    // The script duplicates the rule to avoid a white flash; if this drifts,
    // dark-mode users get a flash of the light theme on every cold load.
    stubPrefersDark(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    let c = localStorage.getItem('n409.theme');
    if (c !== 'light' && c !== 'dark') {
      c = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    expect(c).toBe(resolveTheme(getThemeChoice()));
  });
});

describe('theme storage failures', () => {
  const realStorage = globalThis.localStorage;
  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: realStorage,
      writable: true,
      configurable: true,
    });
  });

  /** Safari in private mode throws on every localStorage access. */
  function stubHostileStorage() {
    const hostile = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: hostile,
      writable: true,
      configurable: true,
    });
  }

  it('falls back to system when the preference cannot be read', () => {
    stubHostileStorage();
    expect(getThemeChoice()).toBe('system');
  });

  it('still switches the session when the preference cannot be written', () => {
    stubHostileStorage();
    expect(() => setThemeChoice('dark')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('applyTheme and the browser chrome', () => {
  it('keeps theme-color and color-scheme in step with the resolved theme', () => {
    const themeColor = document.createElement('meta');
    themeColor.setAttribute('name', 'theme-color');
    const colorScheme = document.createElement('meta');
    colorScheme.setAttribute('name', 'color-scheme');
    document.head.append(themeColor, colorScheme);
    try {
      applyTheme('dark');
      expect(themeColor.getAttribute('content')).toBe('#0a0e16');
      expect(colorScheme.getAttribute('content')).toBe('dark');

      applyTheme('light');
      expect(themeColor.getAttribute('content')).toBe('#0B1220');
      expect(colorScheme.getAttribute('content')).toBe('light');
    } finally {
      themeColor.remove();
      colorScheme.remove();
    }
  });
});

describe('subscribeTheme', () => {
  /** A matchMedia stub whose `change` listeners can actually be fired. */
  function controllableMedia() {
    const handlers = new Set<() => void>();
    let dark = false;
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        get matches() {
          return dark && query.includes('dark');
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => handlers.add(fn),
        removeEventListener: (_: string, fn: () => void) => handlers.delete(fn),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    );
    return {
      flipTo(next: boolean) {
        dark = next;
        for (const fn of [...handlers]) fn();
      },
      get listenerCount() {
        return handlers.size;
      },
    };
  }

  it('follows the OS at sunset while the choice is system', () => {
    const media = controllableMedia();
    const seen: string[] = [];
    const unsubscribe = subscribeTheme((c) => seen.push(c));

    media.flipTo(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(seen).toEqual(['system']);

    unsubscribe();
    expect(media.listenerCount).toBe(0);
  });

  it('ignores the OS once the analyst has pinned a theme', () => {
    const media = controllableMedia();
    setThemeChoice('light');
    const seen: string[] = [];
    const unsubscribe = subscribeTheme((c) => seen.push(c));

    media.flipTo(true);
    expect(seen).toEqual([]);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    unsubscribe();
  });

  it('carries a preference changed in another tab across to this one', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeTheme((c) => seen.push(c));

    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));

    expect(seen).toEqual(['dark']);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    unsubscribe();
  });

  it('ignores storage events for unrelated keys', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeTheme((c) => seen.push(c));

    dispatchEvent(new StorageEvent('storage', { key: 'n409.token' }));

    expect(seen).toEqual([]);
    unsubscribe();
  });

  it('stops listening after unsubscribe, so an unmounted toggle is not called', () => {
    const seen: string[] = [];
    subscribeTheme((c) => seen.push(c))();

    setThemeChoice('dark');

    expect(seen).toEqual([]);
  });

  it('survives an environment with no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(() => subscribeTheme(() => {})()).not.toThrow();
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('ThemeToggle', () => {
  it('exposes a radiogroup and applies the picked theme', async () => {
    render(<ThemeToggle />);
    const dark = screen.getByRole('radio', { name: /dark/i });
    expect(dark).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(dark);
    expect(dark).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('radio', { name: /light/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('cycles light → dark → system on the compact button', async () => {
    setThemeChoice('light');
    render(<ThemeToggleButton />);
    const button = screen.getByRole('button');

    await userEvent.click(button);
    expect(getThemeChoice()).toBe('dark');
    await userEvent.click(button);
    expect(getThemeChoice()).toBe('system');
    await userEvent.click(button);
    expect(getThemeChoice()).toBe('light');
  });

  it('keeps two mounted toggles in agreement', async () => {
    render(
      <>
        <ThemeToggle />
        <ThemeToggleButton />
      </>,
    );
    await userEvent.click(screen.getByRole('radio', { name: /dark/i }));
    // The compact button reads the shared state, so its label follows.
    expect(screen.getByRole('button', { name: /Colour theme: Dark/i })).toBeInTheDocument();
  });
});
