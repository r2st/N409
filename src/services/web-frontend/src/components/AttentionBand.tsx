import { Link } from 'react-router-dom';
import type { AttentionItem, AttentionReason, Severity } from '../lib/attention';
import { KindBadge, StateBadge } from './ui';

/**
 * The "what needs a human today" band at the top of the dashboard.
 *
 * It replaces a single amber note that counted valuations waiting on client
 * input. That count was true but not actionable: it never said *which* ones,
 * and it stayed silent about the failure that actually costs a firm money —
 * work that is simply late. The ranking behind this lives in `lib/attention`;
 * this component only decides how a ranked list reads.
 *
 * Two things are deliberate. It renders nothing when nothing is wrong, because
 * a permanent "0 items need attention" panel trains people to stop looking at
 * that part of the page. And it shows a handful of rows rather than the whole
 * list — a band of forty is a worklist, and there is already a worklist.
 */

/** Rows shown inline before the band defers to the worklist. */
const DEFAULT_LIMIT = 5;

/**
 * The same fact reads differently depending on who is holding it.
 *
 * `action_needed` is the one that matters: to a client it means *we are waiting
 * on you*, to the ops team it means *this is parked and not our move*. Labelling
 * both "Action needed" would tell ops they owe work they do not owe.
 */
const REASON_LABELS: Record<AttentionReason, string> = {
  overdue: 'Overdue',
  action_needed: 'Needs your input',
  due_soon: 'Due soon',
  new_activity: 'New activity',
};

const OPS_REASON_LABELS: Partial<Record<AttentionReason, string>> = {
  action_needed: 'Waiting on client',
};

function reasonLabel(reason: AttentionReason, isOps: boolean): string {
  return (isOps && OPS_REASON_LABELS[reason]) || REASON_LABELS[reason];
}

function SeverityDot({ severity }: { severity: Severity }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        severity === 'high' ? 'bg-red-500' : 'bg-amber-400'
      }`}
    />
  );
}

export function AttentionBand({
  items,
  isOps = false,
  limit = DEFAULT_LIMIT,
}: {
  items: readonly AttentionItem[];
  isOps?: boolean;
  /** Rows rendered inline; the remainder becomes a link to the worklist. */
  limit?: number;
}) {
  if (items.length === 0) return null;

  const shown = items.slice(0, limit);
  const hidden = items.length - shown.length;
  // Severity drives the band's own colour: one overdue valuation should make
  // the whole band read as urgent, not average out against four gentle ones.
  const urgent = items.some((item) => item.severity === 'high');

  return (
    <section
      aria-label="Needs attention"
      className={`mt-6 overflow-hidden rounded-lg border shadow-card ${
        urgent ? 'border-red-200' : 'border-amber-200'
      }`}
    >
      <div
        className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3 ${
          urgent ? 'bg-red-50 text-red-900' : 'bg-amber-50 text-amber-900'
        }`}
      >
        <h2 className="font-display text-sm font-semibold">
          {isOps ? 'Needs attention' : 'Needs your attention'}
        </h2>
        <span className="tnum text-xs">
          {items.length} valuation{items.length === 1 ? '' : 's'}
        </span>
      </div>

      <ul className="bg-surface">
        {shown.map((item) => (
          <li key={item.id} className="border-t border-paper-200 first:border-t-0">
            <Link
              to={`/valuations/${item.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 transition-colors hover:bg-paper-50"
            >
              <SeverityDot severity={item.severity} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink-900">{item.company_name}</span>
                <span className="mt-0.5 block text-xs text-ink-400">
                  <span className="font-semibold text-ink-600">{reasonLabel(item.reason, isOps)}</span>
                  {' · '}
                  {item.detail}
                </span>
              </span>
              <KindBadge kind={item.kind} />
              <StateBadge state={item.state} />
            </Link>
          </li>
        ))}
      </ul>

      {hidden > 0 && (
        <div className="border-t border-paper-200 bg-surface px-5 py-2.5 text-xs">
          <Link to="/valuations" className="font-semibold text-bond-600 hover:text-bond-700">
            {hidden} more need{hidden === 1 ? 's' : ''} attention →
          </Link>
        </div>
      )}
    </section>
  );
}
