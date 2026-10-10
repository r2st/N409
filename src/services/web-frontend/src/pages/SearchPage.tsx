import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, describeLoadFailure } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { displayName, formatDate } from '../lib/format';
import { formatBytes } from '../lib/pipeline';
import type { SearchResults } from '../lib/types';
import {
  EmptyState,
  KindBadge,
  LoadError,
  ResultCount,
  Spinner,
  StateBadge,
  TextInput,
} from '../components/ui';

/**
 * Global search (M4) — one box across valuations, documents and, for ops,
 * users. Document hits carry their owning valuation because a filename alone
 * does not identify an engagement.
 */
export function SearchPage() {
  const { user } = useAuth();
  const ops = isOps(user);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  /**
   * Which search the displayed results belong to.
   *
   * The debounce cancels a *pending* request, not an in-flight one, so a query
   * that takes longer than the debounce leaves two requests open at once — and
   * nothing ordered their replies. When the slower reply for "ac" landed after
   * the reply for "acme", the page showed one query's results under the other
   * query's text and stayed that way, because no further request was coming to
   * correct it. Only the newest request may write state.
   */
  const latestRequest = useRef(0);

  useEffect(() => {
    setInput(q);
    if (q.trim().length < 2) {
      // Abandon anything in flight too, or its reply repopulates the list the
      // cleared box is supposed to have emptied.
      latestRequest.current += 1;
      setResults(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    const timer = setTimeout(() => {
      const seq = (latestRequest.current += 1);
      const current = () => seq === latestRequest.current;
      api<SearchResults>(`/search?q=${encodeURIComponent(q.trim())}&limit=20`)
        .then((data) => current() && setResults(data))
        .catch((err: unknown) => current() && setError(describeLoadFailure(err, 'Search failed.')))
        .finally(() => current() && setBusy(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, retryToken]);

  /**
   * The three collections, each defaulted to empty.
   *
   * The frontend and the API deploy separately, so during a rollout this page
   * can be the new build reading an old reply — one that has no `documents`
   * key at all. Reaching straight into `results.documents.length` turns that
   * window into a blank page with a render error, which is a far worse outcome
   * than briefly showing no document hits.
   */
  const valuationHits = results?.valuations ?? [];
  const documentHits = results?.documents ?? [];
  const userHits = results?.users ?? [];
  /*
   * All three collections are one answer to one question, so they are announced
   * as one count rather than three regions racing each other. `busy` holds it
   * back until the reply lands: without that, every keystroke announced the
   * previous query's total as though it were this one's.
   */
  const totalHits = valuationHits.length + documentHits.length + userHits.length;

  return (
    <div>
      <div className="overline text-ink-400">Everywhere</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Search</h1>

      <form
        className="mt-6 max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(input.trim() ? { q: input.trim() } : {}, { replace: true });
        }}
      >
        <TextInput
          autoFocus
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setParams(e.target.value.trim() ? { q: e.target.value.trim() } : {}, { replace: true });
          }}
          placeholder={
            ops
              ? 'Company, valuation number or id, filename, user name or email…'
              : 'Company, valuation number, filename…'
          }
          aria-label="Search"
        />
        <ResultCount count={busy || results === null ? null : totalHits} noun="result" query={q} />
      </form>

      {error && (
        <div className="mt-6">
          <LoadError message={error} onRetry={() => { setError(null); setRetryToken((n) => n + 1); }} />
        </div>
      )}
      {busy && <Spinner />}

      {!busy && q.trim().length >= 2 && results && (
        <div className="mt-8 space-y-10">
          <section>
            <h2 className="overline mb-3 text-ink-400">Valuations ({valuationHits.length})</h2>
            {valuationHits.length === 0 ? (
              <p className="text-sm text-ink-400">No matching valuations.</p>
            ) : (
              <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
                <table className="w-full min-w-[560px] text-sm">
                  <caption className="sr-only">Matching valuations</caption>
                  <thead>
                    <tr className="sr-only">
                      <th scope="col">Valuation</th>
                      <th scope="col">Type</th>
                      <th scope="col">State</th>
                      <th scope="col">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valuationHits.map((v) => (
                      <tr key={v.id} className="border-b border-paper-200 last:border-0 hover:bg-paper-50">
                        <td className="px-5 py-3">
                          <Link
                            to={`/valuations/${v.id}`}
                            className="font-semibold text-ink-900 hover:text-bond-700"
                          >
                            {v.company_name}
                          </Link>
                          <span className="tnum ml-2 text-xs text-ink-400">#{v.number}</span>
                        </td>
                        <td className="px-5 py-3">
                          <KindBadge kind={v.kind} />
                        </td>
                        <td className="px-5 py-3">
                          <StateBadge state={v.state} />
                        </td>
                        <td className="tnum px-5 py-3 text-ink-600">{formatDate(v.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className="overline mb-3 text-ink-400">Documents ({documentHits.length})</h2>
            {documentHits.length === 0 ? (
              <p className="text-sm text-ink-400">No matching documents.</p>
            ) : (
              <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
                <table className="w-full min-w-[560px] text-sm">
                  <caption className="sr-only">Matching documents</caption>
                  <thead>
                    <tr className="sr-only">
                      <th scope="col">Document</th>
                      <th scope="col">Size</th>
                      <th scope="col">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documentHits.map((d) => (
                      <tr key={d.id} className="border-b border-paper-200 last:border-0 hover:bg-paper-50">
                        <td className="px-5 py-3">
                          {/* A filename on its own does not say which engagement
                              it belongs to, and the same file name recurs across
                              deals — so the link goes to the documents tab of the
                              owning valuation, and the company is shown beside it. */}
                          <Link
                            to={`/valuations/${d.valuation_id}/documents`}
                            className="font-semibold text-ink-900 hover:text-bond-700"
                          >
                            {d.filename}
                          </Link>
                          <div className="mt-0.5 text-xs text-ink-400">
                            {d.company_name}
                            <span className="tnum ml-1">#{d.valuation_number}</span>
                          </div>
                        </td>
                        <td className="tnum px-5 py-3 text-ink-600">{formatBytes(d.size_bytes)}</td>
                        <td className="tnum px-5 py-3 text-ink-600">{formatDate(d.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {ops && (
            <section>
              <h2 className="overline mb-3 text-ink-400">Users ({userHits.length})</h2>
              {userHits.length === 0 ? (
                <p className="text-sm text-ink-400">No matching users.</p>
              ) : (
                <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
                  <table className="w-full min-w-[480px] text-sm">
                    <caption className="sr-only">Matching users</caption>
                    <thead>
                      <tr className="sr-only">
                        <th scope="col">Name</th>
                        <th scope="col">Email</th>
                        <th scope="col">User id</th>
                      </tr>
                    </thead>
                    <tbody>
                      {userHits.map((u) => (
                        <tr key={u.id} className="border-b border-paper-200 last:border-0">
                          <td className="px-5 py-3 font-semibold text-ink-900">{displayName(u)}</td>
                          <td className="px-5 py-3 text-ink-600">{u.email}</td>
                          <td className="tnum px-5 py-3 text-xs text-ink-400">{u.id}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {!busy && q.trim().length < 2 && (
        <div className="mt-8">
          <EmptyState title="Type at least two characters to search" />
        </div>
      )}
    </div>
  );
}
