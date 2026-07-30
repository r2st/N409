import { useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Getting Started checklist (dashboard).
 *
 * A dismissible, self-guided list of the steps to a first board-approved
 * valuation. Progress (which steps are checked, and whether the whole card is
 * dismissed) persists in localStorage so it survives reloads. It vanishes once
 * every step is checked or the user dismisses it — new users see it, veterans
 * don't. No network calls, so it's safe to render anywhere.
 */

interface Step {
  id: string;
  title: string;
  description: string;
  /** In-app destination for the primary action. */
  action?: { to: string; label: string };
  /** Related help article id. */
  learn: string;
}

const STEPS: Step[] = [
  {
    id: 'company',
    title: 'Set up your company',
    description: 'Start a valuation and enter your legal name, product kind and currency.',
    action: { to: '/valuations/new', label: 'New valuation' },
    learn: 'creating-a-valuation',
  },
  {
    id: 'cap-table',
    title: 'Build your cap table',
    description: 'Add share classes, the option pool and preferences — or sync from Carta/Pulley.',
    learn: 'cap-table-basics',
  },
  {
    id: 'financials',
    title: 'Provide financial data',
    description: 'Upload statements and projections, or let the AI agents extract the model.',
    learn: 'financial-data-overview',
  },
  {
    id: 'methodology',
    title: 'Choose a methodology',
    description: 'Pick how equity value is allocated: OPM, PWERM, Hybrid or CVM.',
    learn: 'methodology-overview',
  },
  {
    id: 'assumptions',
    title: 'Set your assumptions',
    description: 'Volatility, discount rate, DLOM and the approach weights.',
    learn: 'assumptions-overview',
  },
  {
    id: 'run',
    title: 'Run the valuation',
    description: 'Compute the FMV and clear any health-check warnings.',
    learn: 'health-checks-overview',
  },
  {
    id: 'report',
    title: 'Generate the report',
    description: 'Draft, review and publish the audit-ready valuation report.',
    learn: 'report-overview',
  },
  {
    id: 'board',
    title: 'Get board approval',
    description: 'Route the final value to your board and capture signatures.',
    learn: 'board-approval-overview',
  },
];

/** Specialized engines beyond a first 409A — surfaced as explore links, not steps. */
const EXPLORE: Array<{ to: string; label: string }> = [
  { to: '/help/asc718-public-overview', label: 'ASC 718 (public company)' },
  { to: '/help/fund-holdings-overview', label: 'Fund holdings (ASC 820)' },
  { to: '/help/debt-valuation-overview', label: 'Debt valuation' },
];

const DISMISS_KEY = 'n409.getting-started.dismissed';
const PROGRESS_KEY = 'n409.getting-started.done';

function loadDone(): Set<string> {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function GettingStarted() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');
  const [done, setDone] = useState<Set<string>>(loadDone);

  if (dismissed) return null;

  const completed = STEPS.filter((s) => done.has(s.id)).length;
  const allDone = completed === STEPS.length;

  const toggle = (id: string) => {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(PROGRESS_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  return (
    <section
      aria-labelledby="getting-started-heading"
      className="mb-8 rounded-xl border border-paper-300 bg-surface p-6 shadow-card"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Getting started</div>
          <h2 id="getting-started-heading" className="mt-1 font-display text-xl font-semibold text-ink-900">
            {allDone ? "You're all set 🎉" : 'Your first valuation, step by step'}
          </h2>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-ink-400 hover:bg-paper-100 hover:text-ink-700"
        >
          {allDone ? 'Dismiss' : 'Hide'}
        </button>
      </div>

      {/* Progress */}
      <div className="mt-4 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-paper-200">
          <div
            className="h-full rounded-full bg-bond-600 transition-all"
            style={{ width: `${(completed / STEPS.length) * 100}%` }}
          />
        </div>
        <span className="tnum text-xs font-semibold text-ink-500">
          {completed}/{STEPS.length}
        </span>
      </div>

      <ol className="mt-5 space-y-2">
        {STEPS.map((step, i) => {
          const isDone = done.has(step.id);
          return (
            <li key={step.id} className="flex items-start gap-3 rounded-lg border border-paper-200 px-4 py-3">
              <button
                type="button"
                role="checkbox"
                aria-checked={isDone}
                aria-label={`Mark "${step.title}" as ${isDone ? 'not done' : 'done'}`}
                onClick={() => toggle(step.id)}
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-bold transition-colors ${
                  isDone
                    ? 'border-bond-600 bg-bond-600 text-bond-fg'
                    : 'border-ink-300 text-transparent hover:border-bond-500'
                }`}
              >
                ✓
              </button>
              <div className="min-w-0 flex-1">
                <div
                  className={`text-sm font-semibold ${isDone ? 'text-ink-400 line-through' : 'text-ink-900'}`}
                >
                  {i + 1}. {step.title}
                </div>
                <p className="mt-0.5 text-sm text-ink-500">{step.description}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs font-semibold">
                  {step.action && (
                    <Link to={step.action.to} className="text-bond-600 hover:text-bond-700">
                      {step.action.label} →
                    </Link>
                  )}
                  <Link to={`/help/${step.learn}`} className="text-ink-400 hover:text-ink-700">
                    Learn more
                  </Link>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-5 border-t border-paper-200 pt-4">
        <div className="overline mb-2 text-ink-400">Beyond your first valuation</div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs font-semibold">
          {EXPLORE.map((e) => (
            <li key={e.to}>
              <Link to={e.to} className="text-bond-600 hover:text-bond-700">
                {e.label} →
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
