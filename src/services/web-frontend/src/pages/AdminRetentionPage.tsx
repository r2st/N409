import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { formatDateTime } from '../lib/format';
import { Button, ErrorNote, Select, Spinner, TextInput } from '../components/ui';

interface Policy {
  data_type: string;
  archive_after_days: number | null;
  retention_days: number | null;
  enabled: boolean;
}
interface Hold {
  id: string;
  scope: string;
  reference_id: string | null;
  reason: string;
  active: boolean;
  placed_at: string;
}
interface Action {
  id: string;
  data_type: string;
  action: string;
  reference_id: string | null;
  created_at: string;
}

/**
 * Data retention + legal hold administration (feature 10). Admin-only: tune
 * per-data-type retention, place/release legal holds, run the sweep, and read
 * the retention audit log.
 */
export function AdminRetentionPage() {
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [holdForm, setHoldForm] = useState({ scope: 'valuation', reference_id: '', reason: '' });

  const load = useCallback(async () => {
    try {
      const [p, h, a] = await Promise.all([
        api<{ policies: Policy[] }>('/admin/retention/policies'),
        api<{ holds: Hold[] }>('/admin/retention/holds'),
        api<{ actions: Action[] }>('/admin/retention/actions'),
      ]);
      setPolicies(p.policies);
      setHolds(h.holds);
      setActions(a.actions);
    } catch {
      setError('Could not load retention settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!policies) return error ? <ErrorNote>{error}</ErrorNote> : <Spinner />;

  const savePolicy = async (p: Policy) => {
    setError(null);
    try {
      await api(`/admin/retention/policies/${p.data_type}`, {
        method: 'PUT',
        body: { archive_after_days: p.archive_after_days, retention_days: p.retention_days, enabled: p.enabled },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the policy.');
    }
  };

  const setPolicy = (dataType: string, patch: Partial<Policy>) =>
    setPolicies((ps) => ps?.map((p) => (p.data_type === dataType ? { ...p, ...patch } : p)) ?? ps);

  const placeHold = async () => {
    setError(null);
    try {
      await api('/admin/retention/holds', {
        method: 'POST',
        body: {
          scope: holdForm.scope,
          reference_id: holdForm.scope === 'global' ? null : holdForm.reference_id.trim() || null,
          reason: holdForm.reason.trim(),
        },
      });
      setHoldForm({ scope: 'valuation', reference_id: '', reason: '' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not place the hold.');
    }
  };

  const releaseHold = async (id: string) => {
    await api(`/admin/retention/holds/${id}/release`, { method: 'POST' });
    await load();
  };

  const runSweep = async () => {
    setNote(null);
    const { result } = await api<{ result: { archived: number; skipped_hold: number } }>(
      '/admin/retention/run',
      { method: 'POST' },
    );
    setNote(`Sweep complete: ${result.archived} archived, ${result.skipped_hold} held.`);
    await load();
  };

  return (
    <div className="max-w-4xl">
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Admin
        <HelpIcon article="data-retention-overview" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Data retention</h1>
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      {note && <div className="mt-4 rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">{note}</div>}

      <section className="mt-6 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="overline text-ink-400">Retention policies</h2>
          <Button variant="secondary" onClick={runSweep}>Run archival sweep</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-3 py-2 font-semibold text-ink-400">Data type</th>
                <th className="overline px-3 py-2 font-semibold text-ink-400">Archive after (days)</th>
                <th className="overline px-3 py-2 font-semibold text-ink-400">Retain (days)</th>
                <th className="overline px-3 py-2 font-semibold text-ink-400">Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.data_type} className="border-b border-paper-200 last:border-0">
                  <td className="px-3 py-2 font-semibold text-ink-800">{p.data_type}</td>
                  <td className="px-3 py-2">
                    <TextInput
                      type="number"
                      value={p.archive_after_days ?? ''}
                      onChange={(e) =>
                        setPolicy(p.data_type, { archive_after_days: e.target.value === '' ? null : Number(e.target.value) })
                      }
                      className="w-24"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <TextInput
                      type="number"
                      value={p.retention_days ?? ''}
                      onChange={(e) =>
                        setPolicy(p.data_type, { retention_days: e.target.value === '' ? null : Number(e.target.value) })
                      }
                      className="w-24"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => setPolicy(p.data_type, { enabled: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => savePolicy(p)} className="text-sm font-semibold text-bond-600 hover:text-bond-700">
                      Save
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Legal holds</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="overline mb-1 block text-ink-400">Scope</span>
            <Select value={holdForm.scope} onChange={(e) => setHoldForm((f) => ({ ...f, scope: e.target.value }))} aria-label="Hold scope">
              <option value="valuation">Valuation</option>
              <option value="user">User</option>
              <option value="global">Global</option>
            </Select>
          </label>
          {holdForm.scope !== 'global' && (
            <label className="text-sm">
              <span className="overline mb-1 block text-ink-400">Reference ID</span>
              <TextInput value={holdForm.reference_id} onChange={(e) => setHoldForm((f) => ({ ...f, reference_id: e.target.value }))} placeholder="valuation / user id" />
            </label>
          )}
          <label className="text-sm flex-1">
            <span className="overline mb-1 block text-ink-400">Reason</span>
            <TextInput value={holdForm.reason} onChange={(e) => setHoldForm((f) => ({ ...f, reason: e.target.value }))} placeholder="e.g. IRS audit 2026" />
          </label>
          <Button disabled={!holdForm.reason.trim()} onClick={placeHold}>Place hold</Button>
        </div>
        {holds.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <tbody>
              {holds.map((h) => (
                <tr key={h.id} className="border-b border-paper-200 last:border-0">
                  <td className="px-2 py-2 font-semibold text-ink-800">{h.scope}{h.reference_id ? ` · ${h.reference_id}` : ''}</td>
                  <td className="px-2 py-2 text-ink-600">{h.reason}</td>
                  <td className="px-2 py-2 text-ink-500">{h.active ? 'Active' : 'Released'}</td>
                  <td className="px-2 py-2 text-right">
                    {h.active && (
                      <button onClick={() => releaseHold(h.id)} className="text-sm font-semibold text-red-600 hover:text-red-700">
                        Release
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Retention audit log</h2>
        {actions.length === 0 ? (
          <p className="text-sm text-ink-400">No retention actions recorded yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {actions.slice(0, 50).map((a) => (
              <li key={a.id} className="flex items-center gap-3">
                <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${a.action === 'archived' ? 'bg-paper-100 text-ink-700' : 'bg-amber-50 text-amber-800'}`}>
                  {a.action}
                </span>
                <span className="text-ink-600">{a.data_type}</span>
                <span className="tnum text-xs text-ink-400">{a.reference_id}</span>
                <span className="ml-auto text-xs text-ink-400">{formatDateTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
