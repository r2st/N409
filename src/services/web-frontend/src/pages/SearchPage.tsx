import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { displayName, formatDate } from '../lib/format';
import type { SearchResults } from '../lib/types';
import { EmptyState, ErrorNote, KindBadge, Spinner, StateBadge, TextInput } from '../components/ui';

/** Global search (M4) — one box across valuations and, for ops, users. */
export function SearchPage() {
  const { user } = useAuth();
  const ops = isOps(user);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInput(q);
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    setBusy(true);
    setError(null);
    const timer = setTimeout(() => {
      api<SearchResults>(`/search?q=${encodeURIComponent(q.trim())}&limit=20`)
        .then(setResults)
        .catch(() => setError('Search failed.'))
        .finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

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
          placeholder={ops ? 'Company, valuation number or id, user name or email…' : 'Company, valuation number…'}
          aria-label="Search"
        />
      </form>

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {busy && <Spinner />}

      {!busy && q.trim().length >= 2 && results && (
        <div className="mt-8 space-y-10">
          <section>
            <h2 className="overline mb-3 text-ink-400">Valuations ({results.valuations.length})</h2>
            {results.valuations.length === 0 ? (
              <p className="text-sm text-ink-400">No matching valuations.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
                <table className="w-full min-w-[560px] text-sm">
                  <tbody>
                    {results.valuations.map((v) => (
                      <tr key={v.id} className="border-b border-paper-200 last:border-0 hover:bg-paper-50">
                        <td className="px-5 py-3">
                          <Link to={`/valuations/${v.id}`} className="font-semibold text-ink-900 hover:text-bond-700">
                            {v.company_name}
                          </Link>
                          <span className="tnum ml-2 text-xs text-ink-400">#{v.number}</span>
                        </td>
                        <td className="px-5 py-3"><KindBadge kind={v.kind} /></td>
                        <td className="px-5 py-3"><StateBadge state={v.state} /></td>
                        <td className="tnum px-5 py-3 text-ink-600">{formatDate(v.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {ops && (
            <section>
              <h2 className="overline mb-3 text-ink-400">Users ({results.users.length})</h2>
              {results.users.length === 0 ? (
                <p className="text-sm text-ink-400">No matching users.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
                  <table className="w-full min-w-[480px] text-sm">
                    <tbody>
                      {results.users.map((u) => (
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
