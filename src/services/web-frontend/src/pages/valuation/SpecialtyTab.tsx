import { useCallback, useEffect, useState } from 'react';
import { api, apiDownload, ApiError } from '../../lib/api';
import { formatDateTime, formatNumber, formatPerShare } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  inputClass,
  ListTruncationNote,
  LoadError,
  LoadingBlock,
  Skeleton,
  SkeletonText,
  WriteGate,
  useRetry,
} from '../../components/ui';

/**
 * The specialty engines, in the product (design §7.2).
 *
 * Eight engines and eleven product kinds have been live behind
 * `POST /valuations/:id/specialty` and operable only with a bearer token and
 * curl. This is the missing layer, and it is the whole of the work: the engines
 * are done, the exhibits already read the stored calculation, and nothing here
 * computes anything.
 *
 * The kind → engine map is read from `GET /valuations/:id/specialty` rather
 * than restated in TypeScript. A frontend copy would be a second answer to
 * "which engine runs an ASC 820 measurement", and the two would disagree the
 * first time an endpoint moved.
 */

interface RunInput {
  key: string;
  label: string;
  hint: string;
}

interface EngineDef {
  kind: string;
  label: string;
  path: string;
  produces: string;
  runInputs: RunInput[];
  hmrcForm: 'VAL231' | 'VAL230' | null;
}

interface HistoryRow {
  id: string;
  status: string;
  engine_version: string;
  equity_value: string | null;
  fmv_per_share: string | null;
  error: string | null;
  created_at: string;
}

interface SpecialtyResponse {
  kind: string;
  supported: boolean;
  engine: EngineDef | null;
  calculation: { id: string; created_at: string; engine_version: string } | null;
  result: Record<string, unknown> | null;
  history: HistoryRow[];
  /**
   * The twenty-run window this history was filtered out of, not the filtered
   * list — a run that fell off it is one this tab cannot show, whether or not
   * it was a specialty run. See CALCULATION_PAGE_LIMIT.
   */
  truncated: boolean;
}

/**
 * One result value, rendered the way the 409A Calculations tab renders the same
 * shape. Two engines' outputs disagreeing on how a currency is printed is the
 * kind of detail that makes a deliverable look assembled rather than produced.
 */
function ResultValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-ink-400">—</span>;
  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'font-semibold text-emerald-700' : 'font-semibold text-red-700'}>
        {value ? 'Yes' : 'No'}
      </span>
    );
  }
  if (typeof value === 'number') return <span className="tnum">{formatNumber(value)}</span>;
  if (Array.isArray(value) || typeof value === 'object') {
    return (
      <pre className="max-h-56 overflow-auto overscroll-contain rounded border border-paper-200 bg-paper-50 p-2 text-xs whitespace-pre-wrap text-ink-700">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <span className="text-ink-800">{String(value)}</span>;
}

function humanKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function ResultPanel({ result }: { result: Record<string, unknown> }) {
  const entries = Object.entries(result);
  if (entries.length === 0) return <p className="text-sm text-ink-400">The engine returned nothing.</p>;
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Engine result</caption>
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} className="border-b border-paper-200 last:border-0 align-top">
            <th scope="row" className="w-1/3 py-2 pr-4 text-left font-medium text-ink-700">
              {humanKey(key)}
            </th>
            <td className="py-2">
              <ResultValue value={value} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SpecialtyTab() {
  const { valuation, retired } = useWorkspace();
  const [data, setData] = useState<SpecialtyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [running, setRunning] = useState(false);
  const [overrides, setOverrides] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<SpecialtyResponse>(`/valuations/${valuation.id}/specialty`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the specialty engine.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load, token]);

  const run = async () => {
    setOverrideError(null);
    let inputs: Record<string, unknown> = {};
    if (overrides.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(overrides);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        inputs = parsed as Record<string, unknown>;
      } catch {
        // Caught here rather than sent: a malformed schedule would come back as
        // a 422 about a missing key, which reads like the questionnaire's fault.
        setOverrideError('Run inputs must be a JSON object, e.g. {"positions": [ … ]}.');
        return;
      }
    }
    setRunning(true);
    setError(null);
    try {
      await api(`/valuations/${valuation.id}/specialty`, { method: 'POST', body: { inputs } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The engine run failed.');
    } finally {
      setRunning(false);
    }
  };

  const downloadHmrc = async () => {
    setError(null);
    try {
      await apiDownload(`/valuations/${valuation.id}/hmrc-form`, `hmrc-${valuation.id}.json`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not download the HMRC pack.');
    }
  };

  if (error && !data) return <LoadError message={error} {...retryProps} />;
  if (!data)
    return (
      <LoadingBlock label="Loading specialty engine…" className="space-y-6">
        <Skeleton className="h-5 w-64" />
        <div className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card" aria-hidden>
          <SkeletonText lines={4} />
        </div>
      </LoadingBlock>
    );

  /*
   * A Run button on a 409A that 422s is worse than no button: it teaches the
   * operator that the tab is unreliable rather than that the kind is wrong.
   * The workspace hides the tab entirely for unsupported kinds; this is the
   * belt-and-braces for a bookmarked URL.
   */
  if (!data.supported || !data.engine) {
    return (
      <EmptyState title="No specialty engine for this report type">
        A {data.kind} engagement runs through the standard calculation pipeline. Use the Calculations tab.
      </EmptyState>
    );
  }

  const engine = data.engine;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="font-display text-lg font-semibold text-ink-900">{engine.label}</h2>
          <span className="font-mono text-xs text-ink-400">{engine.path}</span>
        </div>
        <p className="mt-1 text-sm text-ink-500">{engine.produces}</p>

        {engine.runInputs.length > 0 && (
          <div className="mt-5">
            <Field
              label="Run inputs (JSON)"
              hint={engine.runInputs.map((i) => `${i.key} — ${i.hint}`).join(' ')}
            >
              <textarea
                className={`${inputClass} min-h-32 font-mono text-xs leading-relaxed`}
                value={overrides}
                onChange={(e) => setOverrides(e.target.value)}
                placeholder={`{"${engine.runInputs[0]!.key}": [ … ]}`}
                maxLength={100_000}
              />
            </Field>
            <p className="mt-1.5 text-xs text-ink-400">
              {engine.runInputs.map((i) => i.label).join(' and ')}{' '}
              {engine.runInputs.length === 1 ? 'is' : 'are'} analyst work product — the questionnaire does not
              collect {engine.runInputs.length === 1 ? 'it' : 'them'}, and the engine refuses without{' '}
              {engine.runInputs.length === 1 ? 'it' : 'them'}.
            </p>
          </div>
        )}

        {overrideError && (
          <div className="mt-3">
            <ErrorNote>{overrideError}</ErrorNote>
          </div>
        )}
        {error && (
          <div className="mt-3">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <WriteGate closed={retired}>
            <Button onClick={() => void run()} disabled={running}>
              {running ? 'Running…' : `Run ${engine.label}`}
            </Button>
          </WriteGate>
          {engine.hmrcForm && (
            <Button variant="secondary" onClick={() => void downloadHmrc()}>
              Download {engine.hmrcForm} pack
            </Button>
          )}
        </div>
      </section>

      {data.result ? (
        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="overline text-ink-400">Latest result</h2>
            {data.calculation && (
              <span className="tnum text-xs text-ink-400">
                {formatDateTime(data.calculation.created_at)} · engine {data.calculation.engine_version}
              </span>
            )}
          </div>
          <ResultPanel result={data.result} />
        </section>
      ) : (
        <EmptyState title="No result yet">
          Run the engine to produce the calculation this report type’s exhibits are built from.
        </EmptyState>
      )}

      {data.history.length > 0 && (
        <section>
          <h2 className="overline mb-3 text-ink-400">Run history</h2>
          <ol className="space-y-2">
            {data.history.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-paper-300 bg-surface px-3.5 py-2 text-sm"
              >
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                    row.status === 'succeeded'
                      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                      : 'bg-red-50 text-red-700 ring-red-200'
                  }`}
                >
                  {row.status}
                </span>
                {/* The failure text is the point of listing failed runs — an
                    analyst asking "why did nothing happen" is looking for it. */}
                {row.error && <span className="min-w-0 flex-1 truncate text-ink-600">{row.error}</span>}
                {row.fmv_per_share !== null && (
                  <span className="tnum text-ink-700">
                    {formatPerShare(row.fmv_per_share, valuation.currency)} / share
                  </span>
                )}
                <span className="tnum ml-auto text-xs text-ink-400">{formatDateTime(row.created_at)}</span>
              </li>
            ))}
          </ol>
          <ListTruncationNote truncated={data.truncated} shown={data.history.length} noun="engine runs" />
        </section>
      )}
    </div>
  );
}
