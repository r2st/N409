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
/** Chip colours per action; anything unrecognised falls back to the amber one. */
const ACTION_CHIP: Record<string, string> = {
  archived: 'bg-paper-100 text-ink-700',
  restored: 'bg-bond-50 text-bond-700',
};

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
  const [retireForm, setRetireForm] = useState({ id: '', reason: '' });
  /**
   * Which control is mid-write, as `sweep` / `hold` / `policy:<type>` /
   * `release:<id>`, or null.
   *
   * Every action on this page is a write followed by a full three-endpoint
   * `load()`, and none of them gave the operator anything to look at in
   * between: the sweep archives across the whole platform, and "Release" ends a
   * legal hold. A click that produces no visible change reads as a click that
   * did not land, so the honest response is to click again — which is how the
   * sweep gets run twice and a hold gets released by someone who thought the
   * first press missed. One key rather than a boolean because the page has four
   * controls in three sections and only the pressed one should go quiet.
   */
  const [busy, setBusy] = useState<string | null>(null);

  /** Runs `fn` under `key`, ignoring the click entirely if a write is in flight. */
  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

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

  const savePolicy = (p: Policy) =>
    run(`policy:${p.data_type}`, async () => {
      setError(null);
      try {
        await api(`/admin/retention/policies/${p.data_type}`, {
          method: 'PUT',
          body: {
            archive_after_days: p.archive_after_days,
            retention_days: p.retention_days,
            enabled: p.enabled,
          },
        });
        await load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not save the policy.');
      }
    });

  const setPolicy = (dataType: string, patch: Partial<Policy>) =>
    setPolicies((ps) => ps?.map((p) => (p.data_type === dataType ? { ...p, ...patch } : p)) ?? ps);

  const placeHold = () =>
    run('hold', async () => {
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
    });

  // Both of these used to let a rejection escape as an unhandled promise: the
  // click did nothing visible, the hold stayed in place (or the sweep never
  // ran), and the only evidence was in the browser console. On a screen whose
  // whole job is the legal-hold audit trail, a write that silently fails is
  // the one outcome that must never be indistinguishable from success.
  const releaseHold = (id: string) =>
    run(`release:${id}`, async () => {
      setError(null);
      try {
        await api(`/admin/retention/holds/${id}/release`, { method: 'POST' });
        await load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not release the hold.');
      }
    });

  /**
   * Undo one archival.
   *
   * The API refuses a restore the next sweep would immediately undo, and names
   * the escape hatch in the refusal. That refusal is surfaced as a question
   * rather than as an error, because it is the one case where the operator has
   * something to decide: "the policy will take it again tonight — do you want
   * it back anyway?" is a real answer to want (export the file, then let it
   * go), and turning it into a dead end would send them to widen a
   * platform-wide retention policy to rescue a single engagement.
   *
   * Every other failure is an error, including a 409 that is *not* the
   * re-archival one — "not archived" means somebody else already restored it,
   * and re-sending with an acknowledgement would not change that.
   */
  const restoreValuation = (referenceId: string) =>
    run(`restore:${referenceId}`, async () => {
      setNote(null);
      setError(null);
      const send = (acknowledge: boolean) =>
        api(`/admin/retention/valuations/${referenceId}/restore`, {
          method: 'POST',
          body: acknowledge ? { acknowledge_rearchival: true } : {},
        });
      try {
        try {
          await send(false);
        } catch (err) {
          const rearchival =
            err instanceof ApiError &&
            err.status === 409 &&
            /sweep would archive it again/i.test(err.message);
          if (!rearchival) throw err;
          if (!window.confirm(`${err.message}\n\nRestore it anyway?`)) return;
          await send(true);
        }
        setNote(`Restored ${referenceId}. It is back in the product and accepts changes again.`);
        await load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not restore that valuation.');
      }
    });

  /**
   * Withdraw an engagement by id.
   *
   * By id and not from a list, deliberately: there is no screen that offers a
   * live engagement for retirement, and building one would be building a
   * "delete" button into the valuations table. An admin who is retiring a piece
   * of work has the id in front of them, from the ticket that asked for it —
   * the same way the legal-hold form above takes one.
   *
   * The confirmation spells out the company name change because that is the
   * part nobody expects: `retireValuations` appends " [retired]" so the name is
   * free again, and an admin who finds out afterwards raises a support ticket
   * about it.
   */
  const retireValuation = () =>
    run('retire', async () => {
      setNote(null);
      setError(null);
      const id = retireForm.id.trim();
      if (
        !window.confirm(
          `Retire ${id}? It leaves every list, refuses every change, and its company name gains ` +
            '" [retired]". An administrator can restore it from this screen afterwards.',
        )
      ) {
        return;
      }
      try {
        const { valuation } = await api<{ valuation: { company_name: string } }>(
          `/admin/retention/valuations/${id}/retire`,
          { method: 'POST', body: retireForm.reason.trim() ? { reason: retireForm.reason.trim() } : {} },
        );
        setNote(`Retired ${id} — now "${valuation.company_name}". It appears in the log below as archived.`);
        setRetireForm({ id: '', reason: '' });
        await load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not retire that valuation.');
      }
    });

  const runSweep = () =>
    run('sweep', async () => {
      setNote(null);
      setError(null);
      try {
        const { result } = await api<{ result: { archived: number; skipped_hold: number } }>(
          '/admin/retention/run',
          { method: 'POST' },
        );
        setNote(`Sweep complete: ${result.archived} archived, ${result.skipped_hold} held.`);
        await load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not run the archival sweep.');
      }
    });

  /**
   * The ids of the log entries that still have something to undo.
   *
   * `actions` arrives newest-first, so the first entry seen for a reference is
   * the latest thing that happened to it. An `archived` entry is restorable
   * only when it is that latest entry: a row archived, restored and archived
   * again should offer the button on the second archival and not on the first,
   * which is what walking the list in order and keeping the first sighting
   * gives. Valuations only — the other data types have no restore endpoint,
   * and the log is shared across all of them.
   */
  const restorable = new Set<string>();
  const seen = new Set<string>();
  for (const a of actions) {
    if (a.reference_id === null || seen.has(a.reference_id)) continue;
    seen.add(a.reference_id);
    if (a.action === 'archived' && a.data_type === 'valuation') restorable.add(a.id);
  }

  return (
    <div className="max-w-4xl">
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Admin
        <HelpIcon article="data-retention-overview" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Data retention</h1>
      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {note && (
        <div className="mt-4 rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
          {note}
        </div>
      )}

      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="overline text-ink-400">Retention policies</h2>
          <Button variant="secondary" onClick={runSweep} disabled={busy !== null}>
            {busy === 'sweep' ? 'Running sweep…' : 'Run archival sweep'}
          </Button>
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
              {/* No policies at all means nothing is ever archived or purged,
                  which on a retention screen is a finding rather than a blank
                  table — an admin reading four column headers over empty space
                  cannot tell it from a table that failed to render. */}
              {policies.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-sm text-ink-400">
                    No retention policies are configured. Nothing is being archived or purged.
                  </td>
                </tr>
              )}
              {policies.map((p) => (
                <tr key={p.data_type} className="border-b border-paper-200 last:border-0">
                  <td className="px-3 py-2 font-semibold text-ink-800">{p.data_type}</td>
                  {/* Every control in this grid is named after its own row: the
                      column header names the cell, not the input inside it, so
                      without this the page offers three anonymous edit boxes and
                      a button called "Save" per data type. */}
                  <td className="px-3 py-2">
                    <TextInput
                      type="number"
                      aria-label={`Archive ${p.data_type} after (days)`}
                      value={p.archive_after_days ?? ''}
                      onChange={(e) =>
                        setPolicy(p.data_type, {
                          archive_after_days: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      className="w-24"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <TextInput
                      type="number"
                      aria-label={`Retain ${p.data_type} for (days)`}
                      value={p.retention_days ?? ''}
                      onChange={(e) =>
                        setPolicy(p.data_type, {
                          retention_days: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      className="w-24"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Enable the ${p.data_type} retention policy`}
                      checked={p.enabled}
                      onChange={(e) => setPolicy(p.data_type, { enabled: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      aria-label={`Save the ${p.data_type} retention policy`}
                      onClick={() => savePolicy(p)}
                      disabled={busy !== null}
                      className="cursor-pointer text-sm font-semibold text-bond-600 hover:text-bond-700 disabled:cursor-not-allowed disabled:text-ink-300"
                    >
                      {busy === `policy:${p.data_type}` ? 'Saving…' : 'Save'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Legal holds</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="overline mb-1 block text-ink-400">Scope</span>
            <Select
              value={holdForm.scope}
              onChange={(e) => setHoldForm((f) => ({ ...f, scope: e.target.value }))}
              aria-label="Hold scope"
            >
              <option value="valuation">Valuation</option>
              <option value="user">User</option>
              <option value="global">Global</option>
            </Select>
          </label>
          {holdForm.scope !== 'global' && (
            <label className="text-sm">
              <span className="overline mb-1 block text-ink-400">Reference ID</span>
              <TextInput
                value={holdForm.reference_id}
                onChange={(e) => setHoldForm((f) => ({ ...f, reference_id: e.target.value }))}
                placeholder="valuation / user id"
              />
            </label>
          )}
          <label className="text-sm flex-1">
            <span className="overline mb-1 block text-ink-400">Reason</span>
            <TextInput
              value={holdForm.reason}
              onChange={(e) => setHoldForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="e.g. IRS audit 2026"
            />
          </label>
          <Button disabled={!holdForm.reason.trim() || busy !== null} onClick={placeHold}>
            {busy === 'hold' ? 'Placing…' : 'Place hold'}
          </Button>
        </div>
        {holds.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <tbody>
              {holds.map((h) => (
                <tr key={h.id} className="border-b border-paper-200 last:border-0">
                  <td className="px-2 py-2 font-semibold text-ink-800">
                    {h.scope}
                    {h.reference_id ? ` · ${h.reference_id}` : ''}
                  </td>
                  <td className="px-2 py-2 text-ink-600">{h.reason}</td>
                  <td className="px-2 py-2 text-ink-500">{h.active ? 'Active' : 'Released'}</td>
                  <td className="px-2 py-2 text-right">
                    {h.active && (
                      <button
                        onClick={() => releaseHold(h.id)}
                        disabled={busy !== null}
                        className="cursor-pointer text-sm font-semibold text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:text-ink-300"
                      >
                        {busy === `release:${h.id}` ? 'Releasing…' : 'Release'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-1 text-ink-400">Withdraw an engagement</h2>
        <p className="mb-4 max-w-2xl text-sm text-ink-500">
          Retires a valuation immediately, without waiting for a retention policy: it leaves every list,
          dashboard and campaign, refuses every change, and stops the auditor and board links it had issued.
          Reading it stays open. It can be restored from the log below.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="overline mb-1 block text-ink-400">Valuation ID</span>
            <TextInput
              value={retireForm.id}
              onChange={(e) => setRetireForm((f) => ({ ...f, id: e.target.value }))}
              placeholder="valuation id"
            />
          </label>
          <label className="text-sm flex-1">
            <span className="overline mb-1 block text-ink-400">Reason</span>
            <TextInput
              value={retireForm.reason}
              onChange={(e) => setRetireForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="e.g. client withdrew the engagement (optional)"
            />
          </label>
          <Button
            variant="secondary"
            disabled={!retireForm.id.trim() || busy !== null}
            onClick={retireValuation}
          >
            {busy === 'retire' ? 'Retiring…' : 'Retire'}
          </Button>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Retention audit log</h2>
        {actions.length === 0 ? (
          <p className="text-sm text-ink-400">No retention actions recorded yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {actions.slice(0, 50).map((a) => (
              <li key={a.id} className="flex items-center gap-3">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-semibold ${ACTION_CHIP[a.action] ?? 'bg-amber-50 text-amber-800'}`}
                >
                  {a.action}
                </span>
                <span className="text-ink-600">{a.data_type}</span>
                <span className="tnum text-xs text-ink-400">{a.reference_id}</span>
                <span className="ml-auto text-xs text-ink-400">{formatDateTime(a.created_at)}</span>
                {/* Offered against the archival it undoes, and only while that
                    archival is still the last word on the row — a reference
                    with a later `restored` entry is already live, and a button
                    that can only answer "not archived" is not a control. */}
                {restorable.has(a.id) && (
                  <button
                    onClick={() => restoreValuation(a.reference_id!)}
                    disabled={busy !== null}
                    className="cursor-pointer text-xs font-semibold text-bond-600 hover:text-bond-700 disabled:cursor-not-allowed disabled:text-ink-300"
                  >
                    {busy === `restore:${a.reference_id}` ? 'Restoring…' : 'Restore'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
