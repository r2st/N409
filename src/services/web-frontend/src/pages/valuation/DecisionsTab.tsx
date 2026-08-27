import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { required, useFormValidation } from '../../lib/useFormValidation';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  ListTruncationNote,
  LoadError,
  Select,
  Spinner,
  TextInput,
  WriteGate,
  useRetry,
} from '../../components/ui';

const CATEGORY_LABELS: Record<string, string> = {
  approach_selection: 'Approach selection',
  weighting: 'Approach weighting',
  dlom: 'DLOM',
  dloc: 'DLOC',
  volatility: 'Volatility',
  discount_rate: 'Discount rate',
  comparables: 'Comparables',
  backsolve: 'Backsolve',
  allocation: 'Allocation',
  other: 'Other',
};

interface Decision {
  id: string;
  category: string;
  decision: string;
  rationale: string;
  supersedes: string | null;
  superseded: boolean;
  decided_by: string;
  created_at: string;
}

interface DecisionsResponse {
  decisions: Decision[];
  categories: string[];
  /** True when the log runs past `page_limit` — the log is append-only. */
  truncated: boolean;
  page_limit: number;
}

/**
 * Audit-defense methodology decision log (IMPROVEMENTS_RESEARCH §5.3,
 * ops-only): record every methodology choice with its rationale as it is
 * made. Append-only — a revision supersedes the old entry instead of editing
 * it, and everything here ships in the evidence bundle as decisions.json.
 */
export function DecisionsTab() {
  const { valuation, retired } = useWorkspace();
  const [data, setData] = useState<DecisionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [saving, setSaving] = useState(false);
  const [category, setCategory] = useState('approach_selection');
  const [decision, setDecision] = useState('');
  const [rationale, setRationale] = useState('');
  const [supersedes, setSupersedes] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<DecisionsResponse>(`/valuations/${valuation.id}/decisions`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the decision log.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load, token]);

  const { errorFor, blurHandler, handleSubmit, reset } = useFormValidation(
    { decision, rationale },
    {
      decision: required('decision', 'Decision'),
      rationale: required('rationale', 'Rationale'),
    },
  );

  const submit = handleSubmit(async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/valuations/${valuation.id}/decisions`, {
        method: 'POST',
        body: {
          category,
          decision: decision.trim(),
          rationale: rationale.trim(),
          supersedes: supersedes || null,
        },
      });
      setDecision('');
      setRationale('');
      setSupersedes('');
      // The form stays mounted for the next decision, so the revealed state has
      // to go with the values — otherwise the empty boxes it leaves behind are
      // immediately marked as errors.
      reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the decision.');
    } finally {
      setSaving(false);
    }
  });

  if (error && !data) return <LoadError message={error} {...retryProps} />;
  if (!data) return <Spinner />;

  // Newest last in the API (audit order); show newest first here.
  const decisions = [...data.decisions].reverse();
  const active = data.decisions.filter((d) => !d.superseded);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_24rem]">
      <div>
        <h2 className="overline mb-4 text-ink-400">Decision log</h2>
        {decisions.length === 0 ? (
          <EmptyState title="No decisions recorded yet">
            Record each methodology choice with its rationale as you make it — this log becomes the
            audit-defense narrative.
          </EmptyState>
        ) : (
          <ol className="space-y-3">
            {decisions.map((entry) => (
              <li
                key={entry.id}
                className={`rounded-lg border p-4 ${
                  entry.superseded
                    ? 'border-paper-300 bg-paper-100 opacity-70'
                    : 'border-paper-300 bg-surface shadow-card'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-bond-50 px-2.5 py-0.5 text-xs font-semibold text-bond-700 ring-1 ring-bond-200 ring-inset">
                    {CATEGORY_LABELS[entry.category] ?? entry.category}
                  </span>
                  {entry.superseded && (
                    <span className="rounded-full bg-paper-200 px-2 py-0.5 text-xs font-semibold text-ink-500">
                      superseded
                    </span>
                  )}
                  {entry.supersedes && (
                    <span className="text-xs text-ink-400">revises an earlier decision</span>
                  )}
                  <span className="tnum ml-auto text-xs text-ink-400">
                    {formatDateTime(entry.created_at)}
                  </span>
                </div>
                <p
                  className={`mt-2.5 text-sm font-medium ${entry.superseded ? 'text-ink-500 line-through' : 'text-ink-900'}`}
                >
                  {entry.decision}
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
                  <span className="font-semibold text-ink-400">Why: </span>
                  {entry.rationale}
                </p>
              </li>
            ))}
          </ol>
        )}
        {/* The oldest end is the page that survives, so a truncated log is
            missing its most recent decisions — including any that supersede
            one still shown as live. */}
        <ListTruncationNote
          truncated={data.truncated}
          shown={decisions.length}
          noun="decisions"
          hint="the most recent entries are not listed"
        />
      </div>

      <aside>
        <h2 className="overline mb-4 text-ink-400">Record a decision</h2>
        <form
          onSubmit={submit}
          className="space-y-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
          noValidate
        >
          <WriteGate closed={retired}>
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {data.categories.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c] ?? c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Decision"
              hint="What was decided, e.g. “DLOM of 30% via Finnerty”."
              error={errorFor('decision')}
            >
              <TextInput
                value={decision}
                onChange={(e) => setDecision(e.target.value)}
                onBlur={blurHandler('decision')}
                required
                maxLength={2000}
              />
            </Field>
            <Field
              label="Rationale"
              hint="Why — this is what an auditor reads."
              error={errorFor('rationale')}
            >
              <textarea
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                onBlur={blurHandler('rationale')}
                required
                maxLength={10000}
                rows={4}
                className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-bond-500 focus:ring-1 focus:ring-bond-500 focus:outline-none"
                aria-label="Rationale"
              />
            </Field>
            {active.length > 0 && (
              <Field label="Supersedes (optional)" hint="Pick the earlier decision this one revises.">
                <Select value={supersedes} onChange={(e) => setSupersedes(e.target.value)}>
                  <option value="">— none —</option>
                  {active.map((d) => (
                    <option key={d.id} value={d.id}>
                      {(CATEGORY_LABELS[d.category] ?? d.category) + ': ' + d.decision.slice(0, 60)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" disabled={saving}>
              {saving ? 'Recording…' : 'Record decision'}
            </Button>
          </WriteGate>
        </form>
      </aside>
    </div>
  );
}
