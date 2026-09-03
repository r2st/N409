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

type Provider = 'carta' | 'pulley';
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

interface FieldChange {
  field: string;
  from: number | string | null;
  to: number | string | null;
}
interface ClassConflict {
  security_class: string;
  status: 'changed' | 'added' | 'removed';
  changes: FieldChange[];
}
interface SyncOutcome {
  applied: boolean;
  class_count: number;
  external_company_name: string | null;
  diff: {
    conflicts: ClassConflict[];
    has_conflicts: boolean;
    added: number;
    removed: number;
    changed: number;
  };
  validation: { valid: boolean };
}

/**
 * The provider names this panel is willing to print, for the reason
 * `lib/integrationCallback` gives: `?provider=` arrives on a URL somebody else
 * may have composed. Mirrors the server's `CAP_TABLE_PROVIDER_LABELS`.
 */
const PROVIDER_LABELS: Record<string, string> = { carta: 'Carta', pulley: 'Pulley' };

const fmtVal = (v: number | string | null) =>
  v === null ? '—' : typeof v === 'number' ? v.toLocaleString() : v;

/**
 * Live cap-table sync (feature 4): connect Carta / Pulley, pull the cap table,
 * review conflicts against the table on file, and set a periodic cadence.
 */
export function CapTableSyncPanel({
  valuationId,
  onApplied,
}: {
  valuationId: string;
  onApplied: () => void;
}) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  // Why the schedule is not running, when it is the engagement rather than the
  // connection that stopped it. See `SCHEDULE_PAUSED_NOTE`.
  const [paused, setPaused] = useState<'retired' | 'closed' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<{ provider: Provider; outcome: SyncOutcome } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [callback, setCallback] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{
        providers: ProviderStatus[];
        scheduled?: boolean;
        unscheduled_reason?: 'retired' | 'closed';
      }>(`/valuations/${valuationId}/cap-table/sync`);
      setProviders(r.providers);
      // An older server sends neither field, and reads as scheduled — which is
      // what this panel assumed before they existed.
      setPaused(r.scheduled === false ? (r.unscheduled_reason ?? 'closed') : null);
    } catch {
      setError('Could not load sync providers.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load, token]);

  /*
   * Say what came back from the provider, then clean the URL.
   *
   * `/api/v1/cap-table-sync/callback` redirects here with `?sync=…&provider=…`
   * and nothing on this page read either one. `connected` needs no sentence —
   * the refetch above draws the connection — but the three refusals do, and an
   * analyst who pressed Cancel on Carta's consent screen was returned to a
   * panel that looked exactly as it had before they left, with the answer
   * sitting unread in the address bar.
   */
  useEffect(() => {
    const outcome = searchParams.get('sync');
    if (!outcome) return;
    setCallback(
      describeCallbackOutcome(
        outcome,
        providerLabel(PROVIDER_LABELS, searchParams.get('provider')),
        'pull the cap table below to review it.',
      ),
    );
    searchParams.delete('sync');
    searchParams.delete('provider');
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  /*
   * Drawn by every branch below, including the two that return early. A load
   * that failed is not a reason to lose the one sentence saying whether a third
   * party was just granted access to the client's cap table — and the failed
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
        `/valuations/${valuationId}/cap-table/sync/${provider}/connect`,
        { method: 'POST' },
      );
      window.location.href = authorize_url;
    } catch (err) {
      setError(describeActionFailure(err, 'Could not start the connection.'));
      setBusy(null);
    }
  };

  const pull = async (provider: Provider, apply: boolean) => {
    setError(null);
    setBusy(provider);
    try {
      const outcome = await api<SyncOutcome>(`/valuations/${valuationId}/cap-table/sync/${provider}/pull`, {
        method: 'POST',
        body: { apply },
      });
      if (outcome.applied) {
        setPending(null);
        onApplied();
        await load();
      } else {
        setPending({ provider, outcome });
      }
    } catch (err) {
      setError(describeActionFailure(err, apply
          ? 'The cap table could not be updated from this provider.'
          : 'The cap table could not be read from this provider.'));
    } finally {
      setBusy(null);
    }
  };

  const setFrequency = async (provider: Provider, frequency: Frequency) => {
    setError(null);
    try {
      await api(`/valuations/${valuationId}/cap-table/sync/${provider}/frequency`, {
        method: 'POST',
        body: { frequency },
      });
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not update the sync cadence.'));
    }
  };

  const disconnect = async (provider: Provider) => {
    setBusy(provider);
    try {
      await api(`/valuations/${valuationId}/cap-table/sync/${provider}`, { method: 'DELETE' });
      await load();
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
      className="space-y-4 rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
      data-testid="cap-table-sync"
    >
      <div>
        <h3 className="overline text-ink-400">Live sync</h3>
        <p className="mt-1 text-sm text-ink-400">
          Pull the cap table directly from your equity-management provider.
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

      <div className="space-y-3">
        {providers.map((p) => {
          const connected = p.connection && p.connection.status !== 'revoked';
          /**
           * A connection whose last sync failed was drawn exactly like one whose
           * last sync worked: the same green Connected pill, the same cadence
           * select still reading Daily, with one line of small red text below
           * quoting a status code from an hour or a month ago. R252 gave the
           * failure its own pill and the reconnect its own button — and drew
           * both for every failure, including the majority that are retried on
           * a backoff and need nobody. See `lib/connectorState` for the two
           * states and why only the row can tell them apart.
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
                    // "Not configured on this deployment" is beside the button
                    // but not on it: a reader who has tabbed to the control is
                    // told nothing about why it will not take the press.
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
                    <Button disabled={busy === p.provider} onClick={() => pull(p.provider, false)}>
                      {busy === p.provider ? 'Syncing…' : 'Sync now'}
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
      </div>

      {pending && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4" data-testid="sync-conflicts">
          <p className="text-sm font-semibold text-amber-800">
            {pending.outcome.diff.changed} changed · {pending.outcome.diff.added} added ·{' '}
            {pending.outcome.diff.removed} removed vs. the cap table on file.
          </p>
          <div className="mt-3 max-h-64 overflow-y-auto overscroll-y-contain rounded border border-amber-200 bg-surface">
            <table className="w-full text-sm">
              <caption className="sr-only">Cap table sync conflicts</caption>
              <tbody>
                {/*
                  Keyed by position, not by class name. A cap table may hold the
                  same class name on two rows — `duplicate_class` is a warning,
                  and a provider that returns one certificate per row produces
                  the shape by construction — so the diff names a class more
                  than once whenever one of those rows is added or removed.
                  Under a name key React reconciles those rows onto each other
                  and the table draws fewer rows than the "n changed · n added ·
                  n removed" line above it counts, on the screen an analyst
                  reads before overwriting the cap table on file. The list is
                  rendered whole and never reordered, so the index is stable.
                */}
                {pending.outcome.diff.conflicts.map((c, i) => (
                  <tr
                    key={`${c.security_class}:${c.status}:${i}`}
                    className="border-b border-paper-200 last:border-0 align-top"
                  >
                    <th scope="row" className="px-3 py-2 text-left font-semibold text-ink-800">
                      {c.security_class}
                    </th>
                    <td className="px-3 py-2 text-ink-600">
                      <span className="mr-2 rounded bg-paper-100 px-1.5 py-0.5 text-xs font-semibold">
                        {c.status}
                      </span>
                      {c.changes.map((ch) => (
                        <span key={ch.field} className="mr-3 text-xs">
                          {ch.field}: {fmtVal(ch.from)} → <strong>{fmtVal(ch.to)}</strong>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy === pending.provider} onClick={() => pull(pending.provider, true)}>
              Apply provider data
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Keep current
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
