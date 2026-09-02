import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, describeActionFailure } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { useAuth } from '../lib/auth';
import { computeStats } from '../lib/stats';
import { formatDate, formatDateTime } from '../lib/format';
import type { ApiToken, PartnerBranding, Valuation, ValuationList } from '../lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  KindBadge,
  ListTruncationNote,
  Spinner,
  StatCard,
  StateBadge,
  TextInput,
} from '../components/ui';

/**
 * M3 feature 12 — the partner portal. Everything here is server-scoped to the
 * partner's own portfolio; this page just gives partners a home: portfolio
 * stats, recent engagements, and API token management (feature 14).
 */
export function PartnerPortalPage() {
  const { user } = useAuth();
  const [valuations, setValuations] = useState<Valuation[] | null>(null);
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  /** True when the partner holds more tokens than this page carries. */
  const [tokensTruncated, setTokensTruncated] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<{ name: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [org, setOrg] = useState<PartnerBranding | null>(null);
  const partnerId = user?.partner_id ?? null;
  const canMint = Boolean(user?.roles.includes('partner')); // org admins, not members

  useEffect(() => {
    api<ValuationList>('/valuations?per_page=100')
      .then((res) => setValuations(res.valuations))
      .catch(() => setError('Could not load your portfolio.'));
  }, []);

  // P1 #7 — the organisation's name/branding, set by the platform admins.
  useEffect(() => {
    api<{ partner: PartnerBranding }>('/partners/mine')
      .then((res) => setOrg(res.partner))
      .catch(() => {});
  }, []);

  const loadTokens = useCallback(() => {
    if (!partnerId || !canMint) return;
    api<{ tokens: ApiToken[]; truncated: boolean }>(`/partners/${partnerId}/tokens`)
      .then((res) => {
        setTokens(res.tokens);
        setTokensTruncated(res.truncated);
      })
      .catch(() => setTokenError('Could not load API tokens.'));
  }, [partnerId, canMint]);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const mint = async (e: FormEvent) => {
    e.preventDefault();
    if (!partnerId || !name.trim()) return;
    setBusy(true);
    setTokenError(null);
    try {
      const res = await api<{ token: ApiToken; secret: string }>(`/partners/${partnerId}/tokens`, {
        method: 'POST',
        body: { name: name.trim() },
      });
      setMinted({ name: res.token.name, secret: res.secret });
      setName('');
      loadTokens();
    } catch (err) {
      setTokenError(describeActionFailure(err, 'Could not create the token.'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: ApiToken) => {
    if (!window.confirm(`Revoke "${token.name}"? Integrations using it will stop working.`)) return;
    try {
      await api(`/api-tokens/${token.id}`, { method: 'DELETE' });
      loadTokens();
    } catch (err) {
      setTokenError(describeActionFailure(err, 'Could not revoke the token.'));
    }
  };

  const stats = valuations ? computeStats(valuations) : null;
  const recent = valuations?.slice(0, 8) ?? [];

  return (
    <div>
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Partner portal
        <HelpIcon article="client-portal-overview" />
      </div>
      <h1 className="mt-1 flex items-center gap-3 font-display text-3xl font-semibold text-ink-900">
        {org?.logo_url && (
          <img src={org.logo_url} alt={`${org.name} logo`} className="h-9 w-9 rounded object-contain" />
        )}
        {org ? org.name : 'Your portfolio'}
      </h1>
      {org?.brand_color && (
        <div
          aria-hidden
          className="mt-2 h-1 w-24 rounded-full"
          style={{ backgroundColor: org.brand_color }}
        />
      )}
      <p className="mt-1 text-sm text-ink-400">
        Valuations across your organisation — scoped to your partnership.
      </p>

      {error && (
        <div className="mt-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {!valuations && !error && <Spinner />}

      {stats && (
        <>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Total" value={stats.total} />
            <StatCard label="Open" value={stats.open} />
            <StatCard label="In review" value={stats.inReview} />
            <StatCard label="Drafted" value={stats.drafted} />
            <StatCard label="Published" value={stats.published} accent />
          </div>

          <div className="mt-10 flex items-center justify-between">
            <h2 className="overline text-ink-400">Recent engagements</h2>
            <Link to="/valuations" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
              View all →
            </Link>
          </div>
          {recent.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No valuations in your portfolio yet">
                <Link to="/valuations/new" className="font-semibold text-bond-600 hover:text-bond-700">
                  Start one for a client
                </Link>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {recent.map((v) => (
                <li key={v.id}>
                  <Link
                    to={`/valuations/${v.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-paper-300 bg-surface px-5 py-4 shadow-card transition-shadow hover:shadow-lift"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-display text-[1.05rem] font-semibold text-ink-900">
                        {v.company_name}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-400">Created {formatDate(v.created_at)}</div>
                    </div>
                    <KindBadge kind={v.kind} />
                    <StateBadge state={v.state} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* API tokens — partner org admins only */}
      {canMint && partnerId && (
        <section className="mt-10 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <div className="mb-1 flex items-center justify-between">
            <h2 id="partner-api-tokens-heading" className="overline text-ink-400">
              API tokens
            </h2>
            <Link to="/partner/api-docs" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
              API documentation →
            </Link>
          </div>
          <p className="text-sm text-ink-400">
            Integrate your systems with the N409 partner API. Send the token as{' '}
            <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">
              Authorization: Bearer …
            </code>
          </p>

          {tokenError && (
            <div className="mt-4">
              <ErrorNote>{tokenError}</ErrorNote>
            </div>
          )}

          {minted && (
            <div className="mt-4 rounded-md border border-bond-200 bg-bond-50 px-4 py-3 text-sm text-bond-700">
              <div className="font-semibold">Token “{minted.name}” created — copy it now.</div>
              <div className="mt-1 text-xs">This secret is shown once and cannot be retrieved again.</div>
              <div className="mt-2 flex items-center gap-2">
                <code className="tnum break-all rounded bg-surface px-2 py-1 font-mono text-xs text-ink-800 ring-1 ring-bond-200">
                  {minted.secret}
                </code>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(minted.secret);
                  }}
                >
                  Copy
                </Button>
              </div>
            </div>
          )}

          <form onSubmit={mint} className="mt-5 flex flex-wrap gap-2">
            <div className="w-full sm:w-72">
              <TextInput
                aria-label="Token name"
                placeholder="Token name, e.g. “CRM integration”"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create token'}
            </Button>
          </form>

          {tokens && tokens.length > 0 && (
            <div className="mt-5 overflow-x-auto overscroll-x-contain">
              <table className="w-full text-sm" aria-labelledby="partner-api-tokens-heading">
                <thead>
                  <tr className="border-b border-paper-300 text-left">
                    <th className="overline py-2 pr-4 font-semibold text-ink-400">Name</th>
                    <th className="overline py-2 pr-4 font-semibold text-ink-400">Prefix</th>
                    <th className="overline py-2 pr-4 font-semibold text-ink-400">Created</th>
                    <th className="overline py-2 pr-4 font-semibold text-ink-400">Last used</th>
                    <th className="overline py-2 font-semibold text-ink-400">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.id} className="border-b border-paper-200 last:border-0">
                      <td className="py-2.5 pr-4 font-semibold text-ink-900">{t.name}</td>
                      <td className="tnum py-2.5 pr-4 font-mono text-xs text-ink-600">{t.token_prefix}…</td>
                      <td className="tnum py-2.5 pr-4 text-ink-600">{formatDate(t.created_at)}</td>
                      <td className="tnum py-2.5 pr-4 text-ink-600">
                        {t.last_used_at ? formatDateTime(t.last_used_at) : 'Never'}
                      </td>
                      <td className="py-2.5">
                        {t.revoked_at ? (
                          <span className="text-xs font-semibold text-ink-400">Revoked</span>
                        ) : (
                          <button
                            onClick={() => revoke(t)}
                            className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tokens && tokens.length === 0 && <p className="mt-5 text-sm text-ink-400">No tokens yet.</p>}
          {/* Revoked keys stay for the audit trail, so this list only grows. */}
          <ListTruncationNote
            truncated={tokensTruncated}
            shown={tokens?.length ?? 0}
            noun="API tokens"
            hint="the oldest keys are not listed"
          />
        </section>
      )}
    </div>
  );
}
