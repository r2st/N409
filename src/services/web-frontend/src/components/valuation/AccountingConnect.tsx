import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, describeRequestFailure, describeActionFailure } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { Button, ErrorNote } from '../ui';

/**
 * Accounting software connections (409.ai §23) — shown on the Documents tab.
 * Connect opens the provider's OAuth consent in a new tab; the callback
 * bounces back here with ?accounting=connected|denied|error.
 */

export interface AccountingProviderStatus {
  provider: string;
  label: string;
  configured: boolean;
  import_supported: boolean;
  connection: {
    status: 'connected' | 'error' | 'revoked';
    external_org_name: string | null;
    last_import_at: string | null;
    last_import_summary: { revenue_cents: number | null } | null;
    last_error: string | null;
  } | null;
}

/**
 * The provider names this component is willing to print.
 *
 * `?provider=` rides in on a URL anyone can compose and send to a signed-in
 * analyst, and the sentence it lands in is the one that says a connection
 * succeeded. Echoing the parameter made that sentence whatever the link's
 * author wrote — "Connected to QuickBooks. Your session has expired, call
 * 1-800-…" — printed in this workspace's own voice, on the tab that holds the
 * client's financials. React escapes the markup; it cannot escape the claim.
 *
 * So the same rule the SSO codes are held to (`SSO_ERROR_MESSAGES` in
 * `pages/LoginPage.tsx`): a fixed vocabulary, and anything outside it is "the
 * provider". `Object.hasOwn` because a bare lookup would answer `__proto__`.
 * The list is the server's `PROVIDER_LABELS`
 * (`services/valuation/src/clients/accounting.ts`); the callback only ever
 * redirects with a slug from it.
 */
const PROVIDER_LABELS: Record<string, string> = {
  xero: 'Xero',
  quickbooks: 'QuickBooks',
  freshbooks: 'FreshBooks',
  netsuite: 'Oracle NetSuite',
  sage: 'Sage',
  wave: 'Wave',
};

export function AccountingConnect({ valuationId }: { valuationId: string }) {
  const [providers, setProviders] = useState<AccountingProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    try {
      const { providers: items } = await api<{ providers: AccountingProviderStatus[] }>(
        `/valuations/${valuationId}/accounting`,
      );
      setProviders(items);
    } catch {
      setError('Could not load accounting connections.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Surface the OAuth redirect outcome once, then clean the URL.
  useEffect(() => {
    const outcome = searchParams.get('accounting');
    if (!outcome) return;
    const named = searchParams.get('provider');
    const provider = named && Object.hasOwn(PROVIDER_LABELS, named) ? PROVIDER_LABELS[named] : 'the provider';
    setNotice(
      outcome === 'connected'
        ? `Connected to ${provider} — you can import financials now.`
        : outcome === 'denied'
          ? `Connection to ${provider} was cancelled.`
          : `Connecting to ${provider} failed — please try again.`,
    );
    searchParams.delete('accounting');
    searchParams.delete('provider');
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const connect = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      const { authorize_url } = await api<{ authorize_url: string }>(
        `/valuations/${valuationId}/accounting/${provider}/connect`,
        { method: 'POST' },
      );
      window.location.assign(authorize_url);
    } catch (err) {
      // The type, not the status: a retired engagement (409), a link that is
      // not this caller's (404) and a throttle (429) all arrived as "Could not
      // start the connection", and a maintenance-window 503 arrived as the
      // integration being permanently absent from the deployment.
      setError(
        err instanceof ApiError && err.problem.type === 'urn:n409:problem:accounting-unavailable'
          ? 'This integration is not configured on this deployment yet.'
          : describeRequestFailure(err),
      );
      setBusy(null);
    }
  };

  const runImport = async (provider: string) => {
    setBusy(provider);
    setError(null);
    setNotice(null);
    try {
      await api(`/valuations/${valuationId}/accounting/${provider}/import`, { method: 'POST' });
      setNotice('Financials imported — revenue params were updated from the P&L.');
      void load();
    } catch (err) {
      setError(describeActionFailure(err, 'Import failed.'));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      await api(`/valuations/${valuationId}/accounting/${provider}`, { method: 'DELETE' });
      void load();
    } catch {
      setError('Could not disconnect.');
    } finally {
      setBusy(null);
    }
  };

  /*
   * A failed load returned null, so the whole section vanished and the message
   * the catch had just written had nowhere to render — the integrations simply
   * were not on the Documents tab, which reads as this deployment not having
   * them rather than as a request that failed. Null is still right *before* the
   * first response; after a failure the heading stays so the reader knows which
   * part of the page is missing, and says why.
   */
  if (!providers) {
    return error ? (
      <section className="mt-8" aria-label="Accounting integrations">
        <div className="overline text-ink-400">Accounting integrations</div>
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      </section>
    ) : null;
  }

  return (
    <section className="mt-8" aria-label="Accounting integrations">
      <div className="overline text-ink-400">Accounting integrations</div>
      <p className="mt-1 text-sm text-ink-500">
        Connect your accounting software and we&rsquo;ll pull your financials directly — no exports, no
        re-typing.
      </p>
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map((p) => {
          const connected = p.connection && p.connection.status !== 'revoked';
          return (
            <div key={p.provider} className="rounded-lg border border-paper-300 bg-surface p-4 shadow-card">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-semibold text-ink-900">{p.label}</span>
                {connected ? (
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold ${
                      p.connection!.status === 'error'
                        ? 'border-red-200 bg-red-50 text-red-700'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    }`}
                  >
                    {p.connection!.status === 'error' ? 'Last import failed' : 'Connected'}
                  </span>
                ) : (
                  <span className="rounded-full border border-paper-300 bg-paper-100 px-2 py-0.5 text-[0.65rem] font-semibold text-ink-500">
                    Not connected
                  </span>
                )}
              </div>
              {!p.import_supported && (
                <div className="mt-2 inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.65rem] font-semibold text-amber-800">
                  Connect only — import coming soon
                </div>
              )}
              {connected && p.connection!.external_org_name && (
                <div className="mt-1 truncate text-xs text-ink-500">{p.connection!.external_org_name}</div>
              )}
              {connected && p.connection!.last_import_at && (
                <div className="mt-1 text-xs text-ink-400">
                  Last import {formatDateTime(p.connection!.last_import_at)}
                </div>
              )}
              {/*
               * The import refusal this card is the other half of says "the
               * details are in the connection's last error" — and until round
               * 262 this panel was the only one of the three that never drew
               * it. The HRIS and cap-table cards have shown the same field
               * since they were written; here the analyst was told an import
               * failed, pointed at a field, and shown a pill reading "Error".
               *
               * Accounting is manual-import only — no schedule, so no backoff
               * and nothing to promise about a retry. What to do next is
               * therefore always the same two buttons already on the card, and
               * the note says which one answers which failure rather than
               * leaving a provider's sentence as the last word.
               */}
              {connected && p.connection!.status === 'error' && (
                <>
                  {p.connection!.last_error && (
                    <p className="mt-2 text-xs text-red-600">Last error: {p.connection!.last_error}</p>
                  )}
                  <p className="mt-1 text-xs text-ink-500">
                    Nothing is retried on its own here. Import again to retry, or disconnect and reconnect if{' '}
                    {p.label} has ended the authorisation.
                  </p>
                </>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {!connected && (
                  <Button
                    variant="secondary"
                    className="!px-3 !py-1.5 !text-xs"
                    disabled={busy === p.provider}
                    onClick={() => void connect(p.provider)}
                  >
                    {p.configured ? 'Connect' : 'Connect…'}
                  </Button>
                )}
                {connected && p.import_supported && (
                  <Button
                    className="!px-3 !py-1.5 !text-xs"
                    disabled={busy === p.provider}
                    onClick={() => void runImport(p.provider)}
                  >
                    Import financials
                  </Button>
                )}
                {connected && (
                  <Button
                    variant="ghost"
                    className="!px-3 !py-1.5 !text-xs"
                    disabled={busy === p.provider}
                    onClick={() => void disconnect(p.provider)}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
