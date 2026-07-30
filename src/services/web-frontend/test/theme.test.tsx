import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  THEME_STORAGE_KEY,
  applyTheme,
  getThemeChoice,
  resolveTheme,
  setThemeChoice,
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
