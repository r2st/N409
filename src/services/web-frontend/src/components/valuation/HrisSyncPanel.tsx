import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button, ErrorNote, Select, Spinner } from '../ui';

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
}

/**
 * HRIS/payroll sync for ASC 718 (feature 11): connect Rippling / Gusto / Deel,
 * pull the roster + equity grants into grant management, and set a cadence.
 */
export function HrisSyncPanel({ valuationId, onImported }: { valuationId: string; onImported: () => void }) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  }, [load]);

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
        `Synced ${r.roster_count} employees · ${r.grants_created} grants imported, ${r.grants_skipped} already present.`,
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
    setBusy(provider);
    try {
      await api(`/valuations/${valuationId}/hris/${provider}`, { method: 'DELETE' });
      await load();
    } finally {
      setBusy(null);
    }
  };

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
      {note && (
        <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
          {note}
        </div>
      )}

      {providers.map((p) => {
        const connected = p.connection && p.connection.status !== 'revoked';
        return (
          <div key={p.provider} className="rounded-md border border-paper-300 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-semibold text-ink-900">{p.label}</span>
              {!p.configured ? (
                <span className="text-xs text-ink-400">Not configured on this deployment</span>
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
