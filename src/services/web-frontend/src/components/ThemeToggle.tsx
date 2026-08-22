import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getThemeChoice, setThemeChoice, subscribeTheme } from '../lib/theme';
import type { ThemeChoice } from '../lib/theme';

const OPTIONS: { value: ThemeChoice; label: string; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'Light',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="4.2" />
        <path
          d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    value: 'system',
    label: 'System',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="4.5" width="18" height="12" rx="1.8" />
        <path d="M8.5 20h7M12 16.5V20" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z" strokeLinejoin="round" />
      </svg>
    ),
  },
];

/** Subscribes to the shared theme state so every toggle on the page agrees. */
export function useThemeChoice(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice);
  useEffect(() => subscribeTheme(setChoice), []);
  return [choice, setThemeChoice];
}

/**
 * Light / System / Dark segmented control (feature-improvements §2).
 *
 * Two skins because it appears on both sides of the theme boundary: `chrome`
 * for the sidebar and marketing footer, which stay dark in either theme, and
 * `surface` for the settings page, which follows the theme like any card.
 */
export function ThemeToggle({ variant = 'surface' }: { variant?: 'chrome' | 'surface' }) {
  const [choice, choose] = useThemeChoice();
  const onChrome = variant === 'chrome';

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={`flex items-center gap-0.5 rounded-md border p-0.5 ${
        onChrome ? 'border-chrome-700 bg-chrome-800/40' : 'border-ink-200 bg-paper-100'
      }`}
    >
      {OPTIONS.map((option) => {
        const active = choice === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${option.label} theme`}
            onClick={() => choose(option.value)}
            className={`touch:min-h-11 flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-semibold transition-colors ${
              active
                ? onChrome
                  ? 'bg-chrome-700 text-chrome-fg'
                  : 'bg-surface text-ink-900 shadow-card'
                : onChrome
                  ? 'text-chrome-dim hover:text-chrome-fg'
                  : 'text-ink-600 hover:text-ink-900'
            }`}
          >
            <span aria-hidden>{option.icon}</span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One-tap variant for tight spots (the marketing header, the mobile app bar).
 * Cycles light → dark → system so every state is still reachable.
 */
export function ThemeToggleButton({ variant = 'surface' }: { variant?: 'chrome' | 'surface' }) {
  const [choice, choose] = useThemeChoice();
  const next: ThemeChoice = choice === 'light' ? 'dark' : choice === 'dark' ? 'system' : 'light';
  const current = OPTIONS.find((o) => o.value === choice) ?? OPTIONS[1]!;

  return (
    <button
      type="button"
      onClick={() => choose(next)}
      aria-label={`Colour theme: ${current.label}. Switch to ${next}.`}
      title={`Theme: ${current.label} — click for ${next}`}
      className={`tap-area cursor-pointer rounded-md p-2 transition-colors ${
        variant === 'chrome'
          ? 'text-chrome-dim hover:bg-chrome-800 hover:text-chrome-fg'
          : 'text-ink-600 hover:bg-paper-200 hover:text-ink-900'
      }`}
    >
      {current.icon}
    </button>
  );
}
