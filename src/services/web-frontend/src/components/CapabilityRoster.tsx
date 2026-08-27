import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { OptionalCapability } from '../lib/types';
import { LoadError, Skeleton, useRetry } from './ui';

/**
 * What the platform is not doing.
 *
 * The settings page above this says "secrets and service URLs stay in the
 * environment", which is true and is also the whole problem: a subsystem left
 * unconfigured degrades deliberately rather than crashing, so the only record
 * of the decision is a log line at boot. On the deployed box that means
 * uploaded documents are stored and served back without ever being scanned,
 * and nothing anywhere on the platform said so.
 *
 * The row that matters is the sentence, not the tick. "Virus scanning: off"
 * does not tell an administrator that the upload still succeeded — `fallback`
 * does, and it is printed for the configured rows too, because somebody
 * reading a green row is entitled to know what they would be back to.
 *
 * Sorted so the silent ones come first: an absence the product already shows
 * (no checkout button, no Google button) is a decision a reader can see for
 * themselves, and putting it above one nobody is told about buries the
 * important half.
 */

const SEVERITY_NOTE: Record<OptionalCapability['severity'], string> = {
  silent: 'Nothing downstream says this is off.',
  visible: 'The product shows this is off.',
};

export function CapabilityRoster() {
  const [rows, setRows] = useState<OptionalCapability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));

  useEffect(() => {
    api<{ capabilities: OptionalCapability[] }>('/admin/capabilities')
      .then((d) => setRows(d.capabilities))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the integration status.'),
      );
  }, [token]);

  // The error wins over the skeleton. A panel that spins forever after a failed
  // load is the swept bug of rounds 12 and 16.
  if (error) return <LoadError message={error} {...retryProps} />;
  if (!rows) return <Skeleton className="h-24 w-full" />;

  const ordered = [...rows].sort((a, b) => {
    const rank = (c: OptionalCapability) => (c.configured ? 2 : c.severity === 'silent' ? 0 : 1);
    return rank(a) - rank(b);
  });
  const off = rows.filter((c) => !c.configured);

  return (
    <div data-testid="capability-roster">
      <p className="mb-4 text-sm text-ink-400">
        {off.length === 0
          ? 'Every optional integration is configured.'
          : `${off.length} of ${rows.length} optional integrations are not configured. Each degrades rather than failing, so the platform runs — this is what it does instead.`}
      </p>
      <ul className="space-y-3">
        {ordered.map((c) => (
          <li
            key={c.key}
            className={`rounded-md border px-4 py-3 ${
              c.configured
                ? 'border-paper-300 bg-surface'
                : c.severity === 'silent'
                  ? 'border-amber-300 bg-amber-50'
                  : 'border-paper-300 bg-paper-50'
            }`}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-semibold text-ink-900">{c.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                  c.configured
                    ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                    : c.severity === 'silent'
                      ? 'bg-amber-100 text-amber-900 ring-amber-300'
                      : 'bg-paper-200 text-ink-600 ring-paper-300'
                }`}
              >
                {c.configured ? 'configured' : 'not configured'}
              </span>
              {!c.configured && <span className="text-xs text-ink-500">{SEVERITY_NOTE[c.severity]}</span>}
              <code className="ml-auto font-mono text-xs text-ink-400">{c.env.join(' · ')}</code>
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
              <span className="font-semibold text-ink-400">
                {c.configured ? 'Without it: ' : 'Instead: '}
              </span>
              {c.fallback}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
