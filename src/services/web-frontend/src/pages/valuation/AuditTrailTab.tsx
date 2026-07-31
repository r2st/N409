import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken } from '../../lib/api';
import { downloadPdf } from '../../lib/m2';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { ErrorNote, Spinner } from '../../components/ui';

/**
 * Per-valuation change history (GET /valuations/:id/audit-trail). The event
 * spine, enriched server-side with a category, a severity and the field-level
 * before/after of every change — the view that answers "who moved the DLOM,
 * when, and from what?" without reading JSON payloads.
 *
 * Ops see the whole trail; a client or partner sees only the client-visible
 * slice, decided server-side. The banner reflects which one they got.
 */

const CATEGORIES = [
  'lifecycle',
  'documents',
  'methodology',
  'data',
  'analysis',
  'review',
  'output',
  'access',
  'integration',
  'other',
] as const;

const SEVERITIES = ['info', 'notice', 'critical'] as const;

interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

interface AuditEntry {
  id: string;
  seq: string;
  type: string;
  label: string;
  category: string;
  severity: (typeof SEVERITIES)[number];
  visibility: string;
  actor_type: string;
  actor_id: string | null;
  source: string | null;
  changes: FieldChange[];
  summary: string;
  occurred_at: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  summary: {
    total: number;
    by_category: Record<string, number>;
    by_severity: Record<string, number>;
    critical_changes: number;
    changed_fields: string[];
    first_at: string | null;
    last_at: string | null;
  };
  page: number;
  per_page: number;
  total: number;
  includes_internal: boolean;
  truncated: boolean;
}

const SEVERITY_STYLES: Record<AuditEntry['severity'], string> = {
  critical: 'bg-red-50 text-red-800 ring-red-200',
  notice: 'bg-amber-50 text-amber-800 ring-amber-200',
  info: 'bg-paper-100 text-ink-600 ring-paper-300',
};

const PER_PAGE = 25;

/** Renders a value the way the server's own audit summary does. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return 'updated';
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function ChangeList({ changes }: { changes: FieldChange[] }) {
  if (changes.length === 0) return null;
  return (
    <table className="mt-2 w-full text-xs" data-testid="change-list">
      <tbody>
        {changes.map((change, i) => (
          <tr key={`${change.field}-${i}`} className="align-top">
            <th scope="row" className="w-1/3 py-0.5 pr-3 text-left font-medium text-ink-600">
              {change.field}
            </th>
            <td className="tnum py-0.5 text-ink-500">
              <span className="line-through decoration-ink-300">{formatValue(change.from)}</span>
              <span aria-hidden className="mx-1.5 text-ink-300">
                →
              </span>
              <span className="font-semibold text-ink-800">{formatValue(change.to)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AuditTrailTab() {
  const { valuation } = useWorkspace();
  const [data, setData] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
    if (category) params.set('category', category);
    if (severity) params.set('severity', severity);
    try {
      setError(null);
      setData(await api<AuditResponse>(`/valuations/${valuation.id}/audit-trail?${params}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the audit trail.');
    }
  }, [valuation.id, category, severity, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;

  const pages = Math.max(1, Math.ceil(data.total / data.per_page));

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-testid="audit-summary">
        <div>
          <dt className="overline text-ink-400">Recorded events</dt>
          <dd className="tnum text-lg font-semibold text-ink-900">{data.summary.total}</dd>
        </div>
        <div>
          <dt className="overline text-ink-400">Value-moving</dt>
          <dd className="tnum text-lg font-semibold text-ink-900">
            {data.summary.critical_changes}
          </dd>
        </div>
        <div>
          <dt className="overline text-ink-400">Fields changed</dt>
          <dd className="tnum text-lg font-semibold text-ink-900">
            {data.summary.changed_fields.length}
          </dd>
        </div>
        <div>
          <dt className="overline text-ink-400">Last change</dt>
          <dd className="tnum text-lg font-semibold text-ink-900">
            {data.summary.last_at ? formatDateTime(data.summary.last_at) : '—'}
          </dd>
        </div>
      </dl>

      {!data.includes_internal && (
        <p className="rounded-md border border-paper-300 bg-paper-50 px-4 py-2.5 text-xs text-ink-500">
          This trail shows the events shared with you. Internal analyst working notes are not
          included.
        </p>
      )}
      {data.truncated && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          This valuation has more history than one view can show — the oldest events are omitted.
          Narrow the filters to reach them.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="text-xs font-medium text-ink-600">
          <span className="overline mb-1 block text-ink-400">Category</span>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
            className="rounded-md border border-paper-300 bg-surface px-2.5 py-1.5 text-sm"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-600">
          <span className="overline mb-1 block text-ink-400">Severity</span>
          <select
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value);
              setPage(1);
            }}
            className="rounded-md border border-paper-300 bg-surface px-2.5 py-1.5 text-sm"
          >
            <option value="">All severities</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() =>
            void downloadPdf(
              `/valuations/${valuation.id}/audit-trail.csv`,
              `change-log-${valuation.company_name.replace(/[^\w.-]+/g, '_')}.csv`,
              getToken(),
            ).catch(() => {})
          }
          className="ml-auto cursor-pointer rounded-md border border-paper-300 px-3 py-1.5 text-sm font-semibold text-ink-700 hover:bg-paper-100"
        >
          Download change log (CSV)
        </button>
      </div>

      {data.entries.length === 0 ? (
        <p className="text-sm text-ink-400">No events match these filters.</p>
      ) : (
        <ol className="space-y-3" data-testid="audit-entries">
          {data.entries.map((entry) => (
            <li
              key={entry.id}
              className="rounded-lg border border-paper-300 bg-surface p-4 shadow-card"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-semibold text-ink-900">{entry.label}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset ${SEVERITY_STYLES[entry.severity]}`}
                >
                  {entry.severity}
                </span>
                <span className="text-xs text-ink-400">{entry.category}</span>
                <span className="tnum ml-auto text-xs text-ink-400">
                  {formatDateTime(entry.occurred_at)}
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-500">
                by {entry.actor_type}
                {entry.source && ` · ${entry.source}`}
              </p>
              <ChangeList changes={entry.changes} />
            </li>
          ))}
        </ol>
      )}

      {pages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="cursor-pointer rounded-md border border-paper-300 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <span className="tnum text-ink-500">
            Page {data.page} of {pages}
          </span>
          <button
            type="button"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            className="cursor-pointer rounded-md border border-paper-300 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
