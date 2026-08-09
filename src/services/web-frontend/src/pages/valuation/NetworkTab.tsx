import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import {
  EmptyState,
  ErrorNote,
  LoadingBlock,
  Skeleton,
  SkeletonCardList,
  Spinner,
} from '../../components/ui';

/**
 * The network log for one engagement (409.ai §11, "Network Items").
 *
 * Every call the platform made to the engine and AI tiers for this valuation:
 * what was sent, what came back, the status and how long it took.
 *
 * The reason this is a view and not a log file is the failure half. A
 * calculation row exists only when the engine answered; a research row only
 * when synthesis succeeded. The 422, the timeout and the retry are recorded
 * here and nowhere else, so "we ran that twice and the first one timed out" is
 * a question only this tab can answer.
 *
 * Scope worth stating: these are the calls *this platform issues*. The AI
 * tier's own onward calls to its model provider happen in another process and
 * are not in this table — `service` is the tier we called, not the vendor it
 * used.
 */

interface NetworkItem {
  id: string;
  service: string;
  name: string;
  status: number | null;
  error: string | null;
  duration_ms: number;
  request_id: string | null;
  created_at: string;
}

interface NetworkPage {
  items: NetworkItem[];
  total: number;
  page: number;
  per_page: number;
  counts: Record<string, number>;
}

interface NetworkItemDetail extends NetworkItem {
  request: unknown;
  response: unknown;
}

const PER_PAGE = 50;

/** Human label for a tier key. Unknown tiers show their raw key rather than being hidden. */
const SERVICE_LABELS: Record<string, string> = {
  engine: 'Engine',
  'ai-service': 'AI',
};

function serviceLabel(key: string): string {
  return SERVICE_LABELS[key] ?? key;
}

/**
 * Status pill. A call with no status never got a response at all — a refused
 * connection or our own deadline — which is a different failure from a 500 and
 * is the one most worth spotting in a list.
 */
function StatusPill({ item }: { item: NetworkItem }) {
  const [label, style] =
    item.status === null
      ? ['no response', 'bg-amber-50 text-amber-800 ring-amber-200']
      : item.status < 400
        ? [String(item.status), 'bg-bond-50 text-bond-700 ring-bond-200']
        : [String(item.status), 'bg-red-50 text-red-800 ring-red-200'];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${style}`}
      title={item.error ?? undefined}
    >
      {label}
    </span>
  );
}

/** Pretty JSON, or the raw text when the body never parsed as JSON. */
function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div className="min-w-0 flex-1">
      <p className="overline mb-1 text-ink-400">{label}</p>
      <pre className="max-h-80 overflow-auto rounded-md bg-paper-100 p-2.5 text-[0.7rem] leading-relaxed text-ink-800 ring-1 ring-paper-300 ring-inset">
        {text}
      </pre>
    </div>
  );
}

/**
 * The payloads, fetched only when a row is opened.
 *
 * They are not in the list for the same reason they are not in the calculations
 * list: one engine compute request is the whole cap table and every projection
 * period, and a page of forty would be megabytes to render a table of
 * timestamps.
 */
function ItemDetail({ valuationId, itemId }: { valuationId: string; itemId: string }) {
  const [detail, setDetail] = useState<NetworkItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void api<{ item: NetworkItemDetail }>(`/valuations/${valuationId}/network-items/${itemId}`)
      .then((res) => {
        if (!cancelled) setDetail(res.item);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the call.');
      });
    return () => {
      cancelled = true;
    };
  }, [valuationId, itemId]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!detail) return <Spinner />;

  return (
    <div className="space-y-3">
      {detail.error && (
        <p className="rounded-md border-l-4 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-900">
          {detail.error}
        </p>
      )}
      <div className="flex flex-wrap gap-4">
        <Payload label="Request" value={detail.request} />
        <Payload label="Response" value={detail.response} />
      </div>
      {detail.request_id && (
        // The id the engine and AI services stamped their own log lines with,
        // so this row joins to theirs on the host.
        <p className="text-xs text-ink-400">
          request id <code className="text-ink-500">{detail.request_id}</code>
        </p>
      )}
    </div>
  );
}

export function NetworkTab() {
  const { valuation } = useWorkspace();
  const [data, setData] = useState<NetworkPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [service, setService] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
    if (service) params.set('service', service);
    try {
      setError(null);
      setData(await api<NetworkPage>(`/valuations/${valuation.id}/network-items?${params}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the network log.');
    }
  }, [valuation.id, service, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data)
    return (
      <LoadingBlock label="Loading network log…" className="space-y-6">
        <div className="flex flex-wrap gap-2" aria-hidden>
          <Skeleton className="h-[30px] w-24" />
          <Skeleton className="h-[30px] w-24" />
        </div>
        <SkeletonCardList rows={6} lines={1} badges={2} />
      </LoadingBlock>
    );

  const total = Object.values(data.counts).reduce((sum, n) => sum + n, 0);
  const pages = Math.max(1, Math.ceil(data.total / data.per_page));
  // Every tier the log holds, so a tab never vanishes because the current
  // filter excluded it.
  const tiers = Object.keys(data.counts).sort();

  const selectTier = (key: string) => {
    setService(key);
    setPage(1);
    setOpen(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-ink-900">Network log</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-500">
          Every call this platform made to the engine and AI services for this valuation — including the ones
          that failed, which no results table records.
        </p>
      </div>

      {total === 0 ? (
        <EmptyState title="No calls recorded yet">
          Calls appear here as soon as this valuation is calculated or an AI pipeline is run.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => selectTier('')}
              aria-pressed={service === ''}
              className={`cursor-pointer rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${
                service === ''
                  ? 'bg-ink-900 text-white ring-ink-900'
                  : 'bg-surface text-ink-600 ring-paper-300 hover:bg-paper-100'
              }`}
            >
              All {total}
            </button>
            {tiers.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => selectTier(key)}
                aria-pressed={service === key}
                className={`cursor-pointer rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${
                  service === key
                    ? 'bg-ink-900 text-white ring-ink-900'
                    : 'bg-surface text-ink-600 ring-paper-300 hover:bg-paper-100'
                }`}
              >
                {serviceLabel(key)} {data.counts[key]}
              </button>
            ))}
          </div>

          <ul className="divide-y divide-paper-300 rounded-lg border border-paper-300 bg-surface shadow-card">
            {data.items.map((item) => (
              <li key={item.id} className="text-sm">
                <button
                  type="button"
                  onClick={() => setOpen((cur) => (cur === item.id ? null : item.id))}
                  aria-expanded={open === item.id}
                  className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-paper-100"
                >
                  <StatusPill item={item} />
                  <span className="font-semibold text-ink-900">{item.name}</span>
                  <span className="tnum text-xs text-ink-400">{item.duration_ms} ms</span>
                  {item.error && (
                    <span className="truncate text-xs text-red-700" title={item.error}>
                      {item.error}
                    </span>
                  )}
                  <span className="tnum ml-auto text-xs text-ink-400">{formatDateTime(item.created_at)}</span>
                  <span className="text-xs text-ink-400">{open === item.id ? '▾' : '▸'}</span>
                </button>
                {open === item.id && (
                  <div className="px-4 pb-4">
                    <ItemDetail valuationId={valuation.id} itemId={item.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>

          {pages > 1 && (
            <div className="flex items-center gap-3 text-sm">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="cursor-pointer rounded-md border border-paper-300 px-3 py-1 disabled:cursor-default disabled:opacity-40"
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
                className="cursor-pointer rounded-md border border-paper-300 px-3 py-1 disabled:cursor-default disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
