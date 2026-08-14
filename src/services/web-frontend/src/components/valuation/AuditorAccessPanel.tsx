import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { Button, ErrorNote, Field, Select, TextInput } from '../ui';

interface Access {
  id: string;
  label: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
}

/**
 * Manage external auditor share links for a valuation (feature 8): mint an
 * expiring read-only link, see active links, and revoke. The raw URL is shown
 * once, right after creation.
 */
export function AuditorAccessPanel({ valuationId }: { valuationId: string }) {
  const [links, setLinks] = useState<Access[] | null>(null);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('30');
  const [minted, setMinted] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ access: Access[] }>(`/valuations/${valuationId}/auditor-access`);
      setLinks(r.access);
    } catch {
      setError('Could not load auditor links.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ url: string; access: { id: string } }>(
        `/valuations/${valuationId}/auditor-access`,
        {
          method: 'POST',
          body: { label: label.trim() || undefined, expires_in_days: Number(days) },
        },
      );
      setMinted({ id: r.access.id, url: r.url });
      setLabel('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the link.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Revoking is the control that cuts an outside firm off from the valuation,
   * so it is the one that must never fail quietly. It did: the DELETE was
   * unguarded, and a rejected call left the row sitting there marked "Active"
   * with nothing said. The analyst who clicked Revoke had every reason to
   * believe the auditor was locked out while the link kept working.
   */
  const revoke = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuationId}/auditor-access/${id}`, { method: 'DELETE' });
      // The banner still offers the raw URL of the link that was just revoked,
      // under a heading telling the reader to copy it while they can.
      setMinted((m) => (m?.id === id ? null : m));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
      data-testid="auditor-access"
    >
      <h3 className="overline mb-1 text-ink-400">External auditor access</h3>
      <p className="mb-4 text-sm text-ink-400">
        Share a read-only link to the report, assumptions and audit-defense review — no account required, and
        it expires automatically.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}

      {minted && (
        <div className="mb-4 rounded-md border border-bond-200 bg-bond-50 p-4">
          <p className="text-sm font-semibold text-bond-800">
            Link created — copy it now, it won't be shown again:
          </p>
          <code className="mt-2 block overflow-x-auto rounded bg-surface px-3 py-2 font-mono text-xs text-ink-700">
            {minted.url}
          </code>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Label (optional)">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Deloitte" />
        </Field>
        <Field label="Expires in">
          <Select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Expiry">
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
          </Select>
        </Field>
        <Button disabled={busy} onClick={create}>
          {busy ? 'Creating…' : 'Create link'}
        </Button>
      </div>

      {links && links.length > 0 && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-3 py-2 font-semibold text-ink-400">Label</th>
                <th className="overline px-3 py-2 font-semibold text-ink-400">Expires</th>
                <th className="overline px-3 py-2 font-semibold text-ink-400">Uses</th>
                <th className="overline px-3 py-2 font-semibold text-ink-400">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {links.map((a) => {
                const expired = new Date(a.expires_at) < new Date();
                const active = !a.revoked_at && !expired;
                return (
                  <tr key={a.id} className="border-b border-paper-200 last:border-0">
                    <td className="px-3 py-2 text-ink-800">{a.label ?? '—'}</td>
                    <td className="px-3 py-2 text-ink-600">{formatDateTime(a.expires_at)}</td>
                    <td className="tnum px-3 py-2 text-ink-600">{a.access_count}</td>
                    <td className="px-3 py-2">
                      <span className={active ? 'text-emerald-700' : 'text-ink-400'}>
                        {a.revoked_at ? 'Revoked' : expired ? 'Expired' : 'Active'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {active && (
                        <button
                          onClick={() => void revoke(a.id)}
                          disabled={busy}
                          className="text-sm font-semibold text-red-600 hover:text-red-700"
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
        </div>
      )}
    </section>
  );
}
