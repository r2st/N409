import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, describeActionFailure } from '../../lib/api';
import {
  CONNECTOR_HEALTH_LABEL,
  SCHEDULE_PAUSED_NOTE,
  cadenceNote,
  connectorHealth,
  retryNote,
} from '../../lib/connectorState';
import { describeCallbackOutcome, providerLabel } from '../../lib/integrationCallback';
import { Button, ErrorNote, LoadError, Select, Spinner, SuccessNote, useRetry } from '../ui';

type Provider = 'rippling' | 'gusto' | 'deel';

/**
 * The provider names this panel is willing to print, for the reason
 * `lib/integrationCallback` gives: `?provider=` arrives on a URL somebody else
 * may have composed. Mirrors the server's `HRIS_PROVIDER_LABELS`.
 */
const PROVIDER_LABELS: Record<string, string> = {
  rippling: 'Rippling',
  gusto: 'Gusto',
  deel: 'Deel',
};
type Frequency = 'manual' | 'daily' | 'weekly';

interface Connection {
  status: 'connected' | 'error' | 'revoked';
  external_company_name: string | null;
  sync_frequency: Frequency;
  last_synced_at: string | null;
  last_error: string | null;
  next_sync_at: string | null;
  /** See `lib/connectorState` — which of the two failures this connection is in. */
  reconnect_required: boolean;
}
interface ProviderStatus {
  provider: Provider;
  label: string;
  configured: boolean;
  connection: Connection | null;
}
interface PullResult {
  roster_count: number;
  grants_found: number;
  grants_created: number;
  grants_skipped: number;
  /**
   * Grants the provider sent that this platform will not store — an options
   * count past what the column holds, a negative strike, an external id longer
   * than the index takes. The importer drops these so one malformed record
   * cannot end the whole sync, which is only defensible if the drop is said
   * out loud: without this line the analyst reads "Synced 240 employees · 198
   * grants imported" and has no way to know two are missing.
   */
  grants_rejected: number;
}

/**
 * HRIS/payroll sync for ASC 718 (feature 11): connect Rippling / Gusto / Deel,
 * pull the roster + equity grants into grant management, and set a cadence.
 */
export function HrisSyncPanel({ valuationId, onImported }: { valuationId: string; onImported: () => void }) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  // Why the schedule is not running, when it is the engagement rather than the
  // connection that stopped it. See `SCHEDULE_PAUSED_NOTE`.
  const [paused, setPaused] = useState<'retired' | 'closed' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [callback, setCallback] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{
        providers: ProviderStatus[];
        scheduled?: boolean;
        unscheduled_reason?: 'retired' | 'closed';
      }>(`/valuations/${valuationId}/hris`);
      setProviders(r.providers);
      // An older server sends neither field, and reads as scheduled — which is
      // what this panel assumed before they existed.
      setPaused(r.scheduled === false ? (r.unscheduled_reason ?? 'closed') : null);
    } catch {
      setError('Could not load HRIS providers.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load, token]);

  /*
   * Say what came back from the provider, then clean the URL.
   *
   * `/api/v1/hris/callback` redirects here with `?hris=…&provider=…` and
   * nothing on this page read either one. `connected` needs no sentence — the
   * refetch above draws the connection — but the three refusals do, and an
   * analyst who pressed Cancel on Rippling's consent screen was returned to a
   * panel that looked exactly as it had before they left, with the answer
   * sitting unread in the address bar.
   */
  useEffect(() => {
    const outcome = searchParams.get('hris');
    if (!outcome) return;
    setCallback(
      describeCallbackOutcome(
        outcome,
        providerLabel(PROVIDER_LABELS, searchParams.get('provider')),
        'pull the roster and grants below.',
      ),
    );
    searchParams.delete('hris');
    searchParams.delete('provider');
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  /*
   * Drawn by every branch below, including the two that return early. A load
   * that failed is not a reason to lose the one sentence saying whether a third
   * party was just granted access to the client's payroll — and the failed
   * branch is `LoadError`, which offers a Retry that re-runs the list request
   * and would otherwise be the whole answer to "did my connection work?".
   */
  const callbackNote = callback ? (
    callback.ok ? (
      <SuccessNote>{callback.message}</SuccessNote>
    ) : (
      <ErrorNote>{callback.message}</ErrorNote>
    )
  ) : null;

  const connect = async (provider: Provider) => {
    setError(null);
    setBusy(provider);
    try {
      const { authorize_url } = await api<{ authorize_url: string }>(
        `/valuations/${valuationId}/hris/${provider}/connect`,
        { method: 'POST' },
      );
      window.location.href = authorize_url;
    } catch (err) {
      setError(describeActionFailure(err, 'Could not start the connection.'));
      setBusy(null);
    }
  };

  const pull = async (provider: Provider) => {
    setError(null);
    setNote(null);
    setBusy(provider);
    try {
      const r = await api<PullResult>(`/valuations/${valuationId}/hris/${provider}/pull`, { method: 'POST' });
      setNote(
        `Synced ${r.roster_count} employees · ${r.grants_created} grants imported, ${r.grants_skipped} already present.` +
          (r.grants_rejected
            ? ` ${r.grants_rejected} ${r.grants_rejected === 1 ? 'grant was' : 'grants were'} skipped — the provider's record could not be stored; check the record in the provider.`
            : ''),
      );
      onImported();
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'The roster and grants could not be pulled from this provider.'));
    } finally {
      setBusy(null);
    }
  };

  const setFrequency = async (provider: Provider, frequency: Frequency) => {
    try {
      await api(`/valuations/${valuationId}/hris/${provider}/frequency`, {
        method: 'POST',
        body: { frequency },
      });
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not update the cadence.'));
    }
  };

  const disconnect = async (provider: Provider) => {
    setError(null);
    setBusy(provider);
    try {
      await api(`/valuations/${valuationId}/hris/${provider}`, { method: 'DELETE' });
      setNote(null);
      await load();
    } catch (err) {
      // The only one of the four calls that used to swallow its failure: the
      // rejection went nowhere, the row stayed connected, and the analyst was
      // left to conclude the button does nothing. A revoked token is the usual
      // cause and the message says so.
      setError(describeActionFailure(err, 'Could not disconnect the provider.'));
    } finally {
      setBusy(null);
    }
  };

  // Before the spinner: a failed load sets the error and leaves `providers`
  // null, so the ErrorNote below this return would never render.
  if (error && !providers)
    return (
      <div className="space-y-3">
        {callbackNote}
        <LoadError message={error} {...retryProps} />
      </div>
    );
  if (!providers)
    return (
      <div className="space-y-3">
        {callbackNote}
        <Spinner />
      </div>
    );

  return (
    <section
      className="space-y-3 rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
      data-testid="hris-sync"
    >
      <div>
        <h3 className="overline text-ink-400">HRIS / payroll sync</h3>
        <p className="mt-1 text-sm text-ink-400">
          Import the employee roster and equity grants from your HR platform.
        </p>
      </div>
      {callbackNote}
      {error && <ErrorNote>{error}</ErrorNote>}
      {paused && (
        <p
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800"
        >
          {SCHEDULE_PAUSED_NOTE[paused]} The connections below keep their settings and resume if the
          engagement is reopened.
        </p>
      )}
      {note && <SuccessNote>{note}</SuccessNote>}

      {providers.map((p) => {
        const connected = p.connection && p.connection.status !== 'revoked';
        /**
         * A connection whose last sync failed was drawn exactly like one whose
         * last sync worked: the same green Connected pill, the same cadence
         * select still reading Daily, with one line of small red text below
         * quoting a status code from an hour or a month ago. R252 gave the
         * failure its own pill and the reconnect its own button — and drew
         * both for every failure, including the majority that are retried on a
         * backoff and need nobody. See `lib/connectorState` for the two states
         * and why only the row can tell them apart.
         */
        const health = connectorHealth(p.connection, p.configured);
        const failing = health === 'retrying' || health === 'stopped';
        const retrying = p.connection ? retryNote(p.connection, health) : null;
        // R261 records a cadence on a stopped connection without starting it.
        // Said here because the dropdown showing “Daily” beside a “Not syncing”
        // pill is the card contradicting itself.
        const cadence = p.connection ? cadenceNote(p.connection, health) : null;
        return (
          <div key={p.provider} className="rounded-md border border-paper-300 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-semibold text-ink-900">{p.label}</span>
              {!p.configured ? (
                <span className="text-xs text-ink-400">{CONNECTOR_HEALTH_LABEL['not-configured']}</span>
              ) : failing ? (
                <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
                  {CONNECTOR_HEALTH_LABEL[health]}
                  {p.connection?.external_company_name ? ` · ${p.connection.external_company_name}` : ''}
                </span>
              ) : connected ? (
                <span className="rounded-full bg-bond-50 px-2.5 py-0.5 text-xs font-semibold text-bond-700">
                  {CONNECTOR_HEALTH_LABEL.connected}
                  {p.connection?.external_company_name ? ` · ${p.connection.external_company_name}` : ''}
                </span>
              ) : (
                <span className="rounded-full bg-paper-100 px-2.5 py-0.5 text-xs font-semibold text-ink-500">
                  {CONNECTOR_HEALTH_LABEL['not-connected']}
                </span>
              )}
            </div>
            {p.connection?.last_error && (
              <p className="mt-2 text-xs text-red-600">Last error: {p.connection.last_error}</p>
            )}
            {retrying && <p className="mt-1 text-xs text-ink-500">{retrying}</p>}
            {cadence && <p className="mt-1 text-xs text-ink-500">{cadence}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!connected ? (
                <Button
                  variant="secondary"
                  disabled={!p.configured || busy === p.provider}
                  // As in CapTableSyncPanel: the status text sits next to the
                  // button, never on it.
                  title={
                    p.configured
                      ? undefined
                      : `${p.label} has no credentials on this deployment, so it cannot be connected here.`
                  }
                  onClick={() => connect(p.provider)}
                >
                  Connect {p.label}
                </Button>
              ) : (
                <>
                  <Button disabled={busy === p.provider} onClick={() => pull(p.provider)}>
                    {busy === p.provider ? 'Syncing…' : 'Import now'}
                  </Button>
                  <label className="flex items-center gap-1.5 text-sm text-ink-500">
                    Auto-sync
                    <Select
                      value={p.connection!.sync_frequency}
                      onChange={(e) => setFrequency(p.provider, e.target.value as Frequency)}
                      aria-label={`${p.label} sync frequency`}
                    >
                      <option value="manual">Manual</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </Select>
                  </label>
                  {/*
                    The action the failure message asks for. An authorisation the
                    provider has ended is not retried on any schedule, so without a
                    way to redo the OAuth hop from the card that is failing, the only
                    route back was Disconnect and start over.
                  */}
                  {health === 'stopped' && (
                    <Button
                      variant="secondary"
                      disabled={!p.configured || busy === p.provider}
                      // Same rule as the Connect button above, and the same
                      // reason it has one: a reader who has tabbed to a control
                      // that will not take the press is told nothing by the
                      // grey. R252 added this button without it.
                      title={
                        p.configured
                          ? undefined
                          : `${p.label} has no credentials on this deployment, so it cannot be reconnected here.`
                      }
                      onClick={() => connect(p.provider)}
                    >
                      Reconnect {p.label}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={busy === p.provider}
                    onClick={() => disconnect(p.provider)}
                  >
                    Disconnect
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
