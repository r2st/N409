import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { useClearOnChange } from '../lib/useClearOnChange';
import { formatDate, formatDateTime } from '../lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  LoadingBlock,
  SkeletonStatStrip,
  SkeletonTable,
  StatCard,
} from '../components/ui';

/**
 * Cross-partner credential inventory (design §14.1).
 *
 * Every token on the platform in one table. Before this, answering "who holds
 * API credentials" meant opening each partner page in turn — which for two
 * dozen firms is the same as not being able to answer it.
 *
 * The column that earns the page is "last used". A credential list is read to
 * find the keys nobody is using: a live token dormant for a quarter is either
 * an integration that was decommissioned without anyone revoking its key, or
 * one that was never wired up. Both are credentials outstanding for no reason.
 */

interface AdminToken {
  id: string;
  partner_id: string | null;
  partner_name: string | null;
  partner_key: string | null;
  created_by: string;
  created_by_email: string | null;
  created_by_name: string | null;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface TokenListing {
  tokens: AdminToken[];
  /** The listing is a page; `total`/`live`/`dormant` still describe the platform. */
  truncated: boolean;
  total: number;
  live: number;
  dormant: number;
  dormant_after_days: number;
}

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

export function AdminApiTokensPage() {
  const [data, setData] = useState<TokenListing | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // "Include revoked" is a checkbox, so both listings can be in flight at once
  // and the reply for the box's previous position can land second. What that
  // shows is revoked credentials in a list that says it holds live ones, or the
  // reverse — on the page an administrator uses to decide what still has
  // access. See `useLatestOnly`.
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    try {
      setError(null);
      const listing = await api<TokenListing>(`/admin/api-tokens${showRevoked ? '?revoked=true' : ''}`);
      if (current()) setData(listing);
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError && err.status === 403
          ? 'The platform token listing is administrator-only.'
          : 'Could not load the token listing.',
      );
    }
  }, [showRevoked, claim]);

  // Ticking "include revoked" must not leave the live-only listing on screen
  // reading as though it already included them, or the reverse.
  useClearOnChange(String(showRevoked), () => setData(null));

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (token: AdminToken) => {
    const holder = token.partner_name ?? 'a personal scope';
    if (
      !window.confirm(
        `Revoke "${token.name}" (${holder})? Any integration using it stops working immediately.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api(`/api-tokens/${token.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the token.');
    } finally {
      setBusy(false);
    }
  };

  /*
   * The heading, the "include revoked" box and Refresh are the same whatever
   * the listing turns out to hold, so they stay mounted through the wait — a
   * bare `<Spinner />` here removed the very checkbox the user had just ticked.
   * The counters swap too, not just the table: "Listed" answers the same
   * question the checkbox asks, so leaving the previous figure up would state
   * a total for a listing that is no longer the one on screen.
   */
  return (
    <div>
      <h1 className="font-display text-3xl font-semibold text-ink-900">API tokens</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-500">
        Every credential issued across every firm. Secrets are stored hashed and shown once at creation, so
        what a listing can show is the prefix, who holds it, and when it was last used. Revoking here is the
        same action as revoking on the firm&rsquo;s own page.
      </p>

      {data ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <StatCard label="Live tokens" value={String(data.live)} />
          <StatCard label={`Dormant (${data.dormant_after_days}d)`} value={String(data.dormant)} />
          <StatCard label="Listed" value={String(data.total)} />
        </div>
      ) : error ? null : (
        <SkeletonStatStrip count={3} className="mt-6" />
      )}

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-600">
          <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
          Include revoked
        </label>
        <Button variant="secondary" onClick={() => void load()} disabled={busy}>
          Refresh
        </Button>
      </div>

      {!data ? (
        // The failure is already reported above; a skeleton next to it would be
        // a wait that never ends.
        !error && (
          <div className="mt-6">
            <LoadingBlock label={showRevoked ? 'Loading all tokens…' : 'Loading live tokens…'}>
              <SkeletonTable columns={6} rows={5} />
            </LoadingBlock>
          </div>
        )
      ) : data.tokens.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No tokens issued">
            Nothing on the platform currently holds API credentials.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[860px] text-left text-sm" aria-label="API tokens">
            <thead>
              <tr className="border-b border-paper-300 text-xs text-ink-400">
                <th className="py-2 pr-4 pl-4 font-semibold">Partner</th>
                <th className="py-2 pr-4 font-semibold">Name</th>
                <th className="py-2 pr-4 font-semibold">Issued by</th>
                <th className="py-2 pr-4 font-semibold">Client id</th>
                <th className="py-2 pr-4 font-semibold">Secret</th>
                <th className="py-2 pr-4 font-semibold">Created</th>
                <th className="py-2 pr-4 font-semibold">Last used</th>
                <th className="py-2 pr-4" />
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((t) => {
                const revoked = t.revoked_at !== null;
                const dormant =
                  !revoked && daysSince(t.last_used_at ?? t.created_at) > data.dormant_after_days;
                return (
                  <tr
                    key={t.id}
                    className={`border-b border-paper-200 last:border-0 ${revoked ? 'opacity-60' : ''}`}
                  >
                    <td className="py-2 pr-4 pl-4">
                      {t.partner_id ? (
                        <Link
                          to={`/admin/partners/${t.partner_id}`}
                          className="font-medium text-bond-600 hover:text-bond-700"
                        >
                          {t.partner_name ?? t.partner_key ?? t.partner_id}
                        </Link>
                      ) : (
                        // A personal token carries only its owner's own scope.
                        // It is not a firm credential and nobody but the owner
                        // may revoke it, so it is labelled rather than linked.
                        <span className="text-ink-500 italic">Personal</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 font-semibold text-ink-800">{t.name}</td>
                    <td className="py-2 pr-4 text-ink-600">
                      {t.created_by_name ?? t.created_by_email ?? '—'}
                      {t.created_by_name && t.created_by_email && (
                        <span className="block text-xs text-ink-400">{t.created_by_email}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-ink-500">{t.id}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-ink-500">
                      {t.token_prefix}&hellip;&bull;&bull;&bull;&bull;
                    </td>
                    <td className="py-2 pr-4 text-ink-500">{formatDate(t.created_at)}</td>
                    <td className="py-2 pr-4">
                      {revoked ? (
                        <span className="text-xs font-semibold text-ink-400">
                          revoked {formatDate(t.revoked_at!)}
                        </span>
                      ) : (
                        <span className={dormant ? 'font-semibold text-amber-700' : 'text-ink-500'}>
                          {t.last_used_at ? formatDateTime(t.last_used_at) : 'Never'}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {!revoked && t.partner_id && (
                        <button
                          onClick={() => void revoke(t)}
                          disabled={busy}
                          className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.truncated && (
            <p className="border-t border-paper-300 px-4 py-3 text-sm text-ink-600">
              Showing the {data.tokens.length} most recently issued of {data.total} tokens. The counts above
              are platform-wide; the table is not.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
