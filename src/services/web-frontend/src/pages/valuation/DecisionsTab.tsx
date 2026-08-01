import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner, TextInput } from '../../components/ui';

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
}

/**
 * Audit-defense methodology decision log (IMPROVEMENTS_RESEARCH §5.3,
 * ops-only): record every methodology choice with its rationale as it is
 * made. Append-only — a revision supersedes the old entry instead of editing
 * it, and everything here ships in the evidence bundle as decisions.json.
 */
export function DecisionsTab() {
  const { valuation } = useWorkspace();
  const [data, setData] = useState<DecisionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
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
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the decision.');
    } finally {
      setSaving(false);
    }
  };

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
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
      </div>

      <aside>
        <h2 className="overline mb-4 text-ink-400">Record a decision</h2>
        <form
          onSubmit={(e) => void submit(e)}
          className="space-y-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
        >
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {data.categories.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c] ?? c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Decision" hint="What was decided, e.g. “DLOM of 30% via Finnerty”.">
            <TextInput value={decision} onChange={(e) => setDecision(e.target.value)} required />
          </Field>
          <Field label="Rationale" hint="Why — this is what an auditor reads.">
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              required
              rows={4}
              className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:border-bond-500 focus:ring-1 focus:ring-bond-500 focus:outline-none"
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
          <Button type="submit" disabled={saving || !decision.trim() || !rationale.trim()}>
            {saving ? 'Recording…' : 'Record decision'}
          </Button>
        </form>
      </aside>
    </div>
  );
}
