/**
 * Theme preference (feature-improvements §2 "Dark mode").
 *
 * Three states, not two: 'system' follows `prefers-color-scheme` and keeps
 * following it as the OS flips at sunset; 'light'/'dark' pin the choice. Only
 * the *resolved* value ever reaches the DOM, as `data-theme` on <html>, which
 * is what the token overrides in index.css key off.
 *
 * The same storage key and resolution rule are duplicated as an inline script
 * in index.html so the attribute is set before first paint. If you change
 * either the key or the rule, change it there too — the duplication is the
 * price of avoiding a white flash on a dark-mode load.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'n409.theme';

const listeners = new Set<(choice: ThemeChoice) => void>();

function isChoice(value: string | null): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** The stored preference, defaulting to 'system' for anyone who never chose. */
export function getThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isChoice(stored) ? stored : 'system';
  } catch {
    // Safari in private mode throws on localStorage access.
    return 'system';
  }
}

function prefersLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'system') return prefersLight() ? 'light' : 'dark';
  return choice;
}

/**
 * Writes the resolved theme to <html>. Also keeps the `theme-color` meta in
 * sync, which is what colours the browser chrome on mobile — a light-mode
 * value on a dark page reads as a rendering bug on iOS.
 */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#0a0a0b' : '#0b1220');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
  return resolved;
}

/** Persists a choice, applies it, and notifies every mounted toggle. */
export function setThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Preference is lost on reload but the session still switches.
  }
  applyTheme(choice);
  for (const listener of listeners) listener(choice);
}

/**
 * Subscribes to preference changes — both explicit ones from another toggle on
 * the page and OS-level ones while the choice is 'system'. Returns an
 * unsubscribe function.
 */
export function subscribeTheme(listener: (choice: ThemeChoice) => void): () => void {
  listeners.add(listener);

  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  const onSystemChange = () => {
    if (getThemeChoice() === 'system') {
      applyTheme('system');
      listener('system');
    }
  };
  media?.addEventListener('change', onSystemChange);

  // Another tab changing the preference should carry over to this one.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    const choice = getThemeChoice();
    applyTheme(choice);
    listener(choice);
  };
  addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);
    media?.removeEventListener('change', onSystemChange);
    removeEventListener('storage', onStorage);
  };
}
