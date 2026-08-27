import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  LoadError,
  Select,
  Spinner,
  StatCard,
  useRetry,
} from '../components/ui';

/**
 * Legacy document triage (design §9.2).
 *
 * Migration 0112 gave the corporate record seven buckets of its own and moved
 * nothing into them — re-filing from a filename is the silent reclassification
 * the category axis exists to prevent. So every charter, option plan and board
 * consent uploaded before it is still in "Other documents" together.
 *
 * This page is where that backlog is worked off by hand. A suggestion appears
 * beside a row when the filename says something unambiguous, with the term it
 * matched on shown rather than a score: an operator can check "bylaws" against
 * the filename in the same glance. Nothing is pre-selected and nothing is
 * applied without a choice — the suggestion is a shortcut, not a decision.
 */

interface Suggestion {
  category: string;
  matched: string;
}

interface UnfiledDocument {
  id: string;
  valuation_id: string;
  valuation_number: number;
  company_name: string;
  state: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_by_email: string | null;
  created_at: string;
  suggestion: Suggestion | null;
}

interface CategoryOption {
  key: string;
  label: string;
  description: string;
}

interface TriageListing {
  documents: UnfiledDocument[];
  total: number;
  truncated: boolean;
  max_assign: number;
  categories: CategoryOption[];
  suggested: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AdminDocumentsPage() {
  const [data, setData] = useState<TriageListing | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const listing = await api<TriageListing>('/admin/documents/triage');
      setData(listing);
      // Choices are reset on every load rather than merged: a row that has
      // been filed is gone from the queue, and carrying a stale selection
      // forward would re-submit a decision that has already been made.
      setChoices({});
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Document triage is operations-only.'
          : 'Could not load the triage queue.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, token]);

  const chosen = Object.entries(choices).filter(([, category]) => category !== '');

  const acceptAllSuggestions = () => {
    if (!data) return;
    setChoices((prev) => {
      const next = { ...prev };
      for (const doc of data.documents) {
        if (doc.suggestion && !next[doc.id]) next[doc.id] = doc.suggestion.category;
      }
      return next;
    });
  };

  const apply = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api<{
        succeeded: number;
        failed: number;
        results: Array<{ error?: string }>;
      }>('/admin/documents/triage', {
        method: 'POST',
        body: {
          assignments: chosen.map(([document_id, category]) => ({ document_id, category })),
        },
      });
      setNote(
        result.failed === 0
          ? `Filed ${result.succeeded} document${result.succeeded === 1 ? '' : 's'}.`
          : `${result.succeeded} filed, ${result.failed} failed (${
              result.results.find((r) => r.error)?.error ?? 'see log'
            }).`,
      );
      await load();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'The re-filing failed.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <LoadError message={error} {...retryProps} />;
  if (!data) return <Spinner />;

  const overLimit = chosen.length > data.max_assign;

  return (
    <div>
      <div className="overline text-ink-400">Operations</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Document triage</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-500">
        Uploads the platform knows nothing about on either axis — no category, no kind. The seven corporate
        buckets were added after these arrived and nothing was moved into them automatically, because a
        filename is not evidence of what a document is. Re-file them here.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Awaiting triage" value={String(data.total)} />
        <StatCard label="With a suggestion" value={String(data.suggested)} />
        <StatCard label="Selected" value={String(chosen.length)} />
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {note && <p className="mt-4 text-sm font-medium text-bond-700">{note}</p>}

      {data.documents.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="Nothing to triage">Every live upload is filed under a named bucket.</EmptyState>
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button onClick={() => void apply()} disabled={busy || chosen.length === 0 || overLimit}>
              {busy ? 'Filing…' : `File ${chosen.length} document${chosen.length === 1 ? '' : 's'}`}
            </Button>
            {data.suggested > 0 && (
              <button
                onClick={acceptAllSuggestions}
                className="cursor-pointer text-sm font-semibold text-bond-600 hover:text-bond-700"
              >
                Fill in every suggestion
              </button>
            )}
            {chosen.length > 0 && (
              <button
                onClick={() => setChoices({})}
                className="cursor-pointer text-sm font-semibold text-ink-500 hover:text-ink-700"
              >
                Clear selection
              </button>
            )}
            {overLimit && <span className="text-sm text-red-700">At most {data.max_assign} at a time.</span>}
          </div>

          {data.truncated && (
            <p className="mt-3 text-xs text-ink-400">
              Showing the {data.documents.length} oldest of {data.total}. Work through these and reload for
              the next batch.
            </p>
          )}

          <div className="mt-4 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[900px] text-left text-sm" aria-label="Documents awaiting triage">
              <thead>
                <tr className="border-b border-paper-300 text-xs text-ink-400">
                  <th className="py-2 pr-4 pl-4 font-semibold">File</th>
                  <th className="py-2 pr-4 font-semibold">Engagement</th>
                  <th className="py-2 pr-4 font-semibold">Uploaded</th>
                  <th className="py-2 pr-4 font-semibold">Suggestion</th>
                  <th className="py-2 pr-4 font-semibold">File as</th>
                </tr>
              </thead>
              <tbody>
                {data.documents.map((doc) => (
                  <tr key={doc.id} className="border-b border-paper-200 last:border-0">
                    <td className="py-2 pr-4 pl-4">
                      <div className="font-medium text-ink-800">{doc.filename}</div>
                      <div className="text-xs text-ink-400">
                        {formatSize(doc.size_bytes)} · {doc.content_type}
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <Link
                        to={`/valuations/${doc.valuation_id}`}
                        className="font-medium text-bond-600 hover:text-bond-700"
                      >
                        #{doc.valuation_number} {doc.company_name}
                      </Link>
                      <div className="text-xs text-ink-400">{doc.state.replace(/_/g, ' ')}</div>
                    </td>
                    <td className="py-2 pr-4 text-ink-500">
                      <div>{formatDate(doc.created_at)}</div>
                      {doc.uploaded_by_email && (
                        <div className="text-xs text-ink-400">{doc.uploaded_by_email}</div>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {doc.suggestion ? (
                        <button
                          onClick={() =>
                            setChoices((prev) => ({ ...prev, [doc.id]: doc.suggestion!.category }))
                          }
                          className="cursor-pointer text-left"
                          title={`Matched on “${doc.suggestion.matched}” in the filename`}
                        >
                          <span className="font-semibold text-bond-600 hover:text-bond-700">
                            {data.categories.find((c) => c.key === doc.suggestion!.category)?.label ??
                              doc.suggestion.category}
                          </span>
                          <span className="block text-xs text-ink-400">
                            matched &ldquo;{doc.suggestion.matched}&rdquo;
                          </span>
                        </button>
                      ) : (
                        <span className="text-xs text-ink-400">&mdash;</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <Select
                        aria-label={`File ${doc.filename} as`}
                        value={choices[doc.id] ?? ''}
                        onChange={(e) => setChoices((prev) => ({ ...prev, [doc.id]: e.target.value }))}
                      >
                        <option value="">Leave in Other documents</option>
                        {data.categories.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
