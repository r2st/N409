import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { OVERWRITE_CATEGORY_LABELS, type OverwriteSchema } from '../lib/m2';
import { ErrorNote, ResultCount, Spinner, StatCard, TextInput } from '../components/ui';

const CLASS_TONES: Record<string, string> = {
  numeric: 'bg-sky-50 text-sky-800 ring-sky-200',
  date: 'bg-amber-50 text-amber-800 ring-amber-200',
  character: 'bg-bond-50 text-bond-700 ring-bond-200',
};

/**
 * Self-documenting overwrites schema browser (features.md §3.6): the full
 * 68-field set with class, range and examples — table view with filtering.
 */
export function OverwritesSchemaPage() {
  const [schema, setSchema] = useState<OverwriteSchema | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  useEffect(() => {
    api<OverwriteSchema>('/overwrites/schema')
      .then(setSchema)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the overwrites schema.'),
      );
  }, []);

  const fields = useMemo(() => {
    if (!schema) return [];
    const q = query.trim().toLowerCase();
    return schema.fields.filter(
      (f) =>
        (!category || f.category === category) &&
        (!q ||
          f.key.toLowerCase().includes(q) ||
          f.label.toLowerCase().includes(q) ||
          f.description.toLowerCase().includes(q)),
    );
  }, [schema, query, category]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!schema) return <Spinner />;

  return (
    <div>
      <h1 className="font-display text-3xl font-semibold text-ink-900">Overwrites schema</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-400">
        The {schema.total} fields an analyst can manually override on a valuation, across{' '}
        {schema.categories.length} categories. Set overrides from a valuation’s Overwrites tab.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {schema.categories.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setCategory((cur) => (cur === c.key ? null : c.key))}
            aria-pressed={category === c.key}
            className={`cursor-pointer rounded-lg text-left transition-shadow ${
              category === c.key ? 'ring-2 ring-bond-600' : ''
            }`}
          >
            <StatCard
              label={OVERWRITE_CATEGORY_LABELS[c.key] ?? c.key}
              value={c.field_count}
              accent={category === c.key}
            />
          </button>
        ))}
      </div>

      <div className="mt-6 max-w-sm">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by key, label or description…"
          aria-label="Filter fields"
        />
        <ResultCount count={fields.length} noun="field" query={query} />
      </div>

      <div className="mt-4 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
        <table className="w-full min-w-[52rem] border-collapse text-sm">
          <caption className="sr-only">Override fields</caption>
          <thead>
            <tr className="border-b border-paper-300 bg-paper-50 text-left text-xs font-semibold tracking-wide text-ink-400 uppercase">
              <th className="px-4 py-2.5">Field</th>
              <th className="px-4 py-2.5">Category</th>
              <th className="px-4 py-2.5">Class</th>
              <th className="px-4 py-2.5">Range</th>
              <th className="px-4 py-2.5">Example</th>
              <th className="px-4 py-2.5">Description</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.key} className="border-b border-paper-200 align-top">
                <td className="px-4 py-2.5">
                  <div className="font-semibold text-ink-800">{f.label}</div>
                  <code className="text-xs text-ink-400">{f.key}</code>
                </td>
                <td className="px-4 py-2.5 text-ink-600">
                  {OVERWRITE_CATEGORY_LABELS[f.category] ?? f.category}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${CLASS_TONES[f.class] ?? ''}`}
                  >
                    {f.class}
                  </span>
                </td>
                <td className="tnum px-4 py-2.5 text-ink-600">
                  {f.min !== undefined || f.max !== undefined ? `${f.min ?? '−∞'} – ${f.max ?? '∞'}` : '—'}
                </td>
                <td className="tnum px-4 py-2.5 text-ink-600">{String(f.example)}</td>
                <td className="px-4 py-2.5 text-ink-600">{f.description}</td>
              </tr>
            ))}
            {fields.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-ink-400">
                  No fields match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
