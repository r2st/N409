import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button, ErrorNote, LoadError, Select, Spinner, SuccessNote, useRetry } from '../ui';

type Provider = 'rippling' | 'gusto' | 'deel';
type Frequency = 'manual' | 'daily' | 'weekly';

interface Connection {
  status: 'connected' | 'error' | 'revoked';
  external_company_name: string | null;
  sync_frequency: Frequency;
  last_synced_at: string | null;
  last_error: string | null;
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
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ providers: ProviderStatus[] }>(`/valuations/${valuationId}/hris`);
      setProviders(r.providers);
    } catch {
      setError('Could not load HRIS providers.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load, token]);

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
      setError(err instanceof ApiError ? err.message : 'Could not start the connection.');
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
      setError(err instanceof ApiError ? err.message : 'Sync failed.');
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
      setError(err instanceof ApiError ? err.message : 'Could not update the cadence.');
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
      setError(err instanceof ApiError ? err.message : 'Could not disconnect the provider.');
    } finally {
      setBusy(null);
    }
  };

  // Before the spinner: a failed load sets the error and leaves `providers`
  // null, so the ErrorNote below this return would never render.
  if (error && !providers) return <LoadError message={error} {...retryProps} />;
  if (!providers) return <Spinner />;

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
      {error && <ErrorNote>{error}</ErrorNote>}
      {note && <SuccessNote>{note}</SuccessNote>}

      {providers.map((p) => {
        const connected = p.connection && p.connection.status !== 'revoked';
        /**
         * A connection whose last sync failed was drawn exactly like one whose
         * last sync worked: the same green Connected pill, the same cadence
         * select still reading Daily, with one line of small red text below
         * quoting a status code from an hour or a month ago. Since R252 that
         * cadence may also be suspended entirely — an authorisation the
         * provider has ended is not retried — so the pill has to be able to
         * say the thing the card is actually for: this is not syncing, and
         * reconnecting is what fixes it.
         */
        const failing = p.connection?.status === 'error';
        return (
          <div key={p.provider} className="rounded-md border border-paper-300 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-semibold text-ink-900">{p.label}</span>
              {!p.configured ? (
                <span className="text-xs text-ink-400">Not configured on this deployment</span>
              ) : failing ? (
                <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
                  Not syncing
                  {p.connection?.external_company_name ? ` · ${p.connection.external_company_name}` : ''}
                </span>
              ) : connected ? (
                <span className="rounded-full bg-bond-50 px-2.5 py-0.5 text-xs font-semibold text-bond-700">
                  Connected
                  {p.connection?.external_company_name ? ` · ${p.connection.external_company_name}` : ''}
                </span>
              ) : (
                <span className="rounded-full bg-paper-100 px-2.5 py-0.5 text-xs font-semibold text-ink-500">
                  Not connected
                </span>
              )}
            </div>
            {p.connection?.last_error && (
              <p className="mt-2 text-xs text-red-600">Last error: {p.connection.last_error}</p>
            )}
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
                  {failing && (
                    <Button
                      variant="secondary"
                      disabled={!p.configured || busy === p.provider}
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
