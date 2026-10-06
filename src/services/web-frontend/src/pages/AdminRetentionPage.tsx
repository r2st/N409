import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, describeActionFailure, describeLoadFailure } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { formatDateTime, kindLabel } from '../lib/format';
import {
  Button,
  ErrorNote,
  ListTruncationNote,
  LoadError,
  ResultCount,
  Select,
  Spinner,
  SuccessNote,
  TextInput,
  useRetry,
} from '../components/ui';

interface Policy {
  data_type: string;
  archive_after_days: number | null;
  retention_days: number | null;
  enabled: boolean;
  /**
   * What the sweep will actually do with this policy (server-declared).
   *
   * Optional so the page still renders against a server that predates the
   * field; absent reads as "nothing stated", which is what it was.
   */
  enforcement?: { archives: boolean; purges: boolean; note: string };
}
/**
 * The one-word verdict in front of the server's note.
 *
 * "Not enforced" is deliberately the loud case rather than the quiet one: a
 * setting that saves and does nothing is the failure this column exists to
 * make visible, and a reader skimming five rows should be able to find it
 * without reading five paragraphs.
 */
function effectSummary(e: { archives: boolean; purges: boolean }): string {
  if (e.purges && e.archives) return 'Archives and purges.';
  if (e.purges) return 'Purges.';
  if (e.archives) return 'Archives.';
  return 'Not enforced.';
}

interface Hold {
  id: string;
  scope: string;
  reference_id: string | null;
  reason: string;
  active: boolean;
  placed_at: string;
}
/**
 * How much of the log the page draws. Named rather than inline because the
 * count below has to agree with it: a list silently cut at fifty reads as a
 * complete list, which is precisely how the restore control used to vanish.
 */
const ACTION_LOG_LIMIT = 50;

/** Chip colours per action; anything unrecognised falls back to the amber one. */
const ACTION_CHIP: Record<string, string> = {
  archived: 'bg-paper-100 text-ink-700',
  restored: 'bg-bond-50 text-bond-700',
};

/**
 * A withdrawn engagement, as state rather than as history.
 * `GET /admin/retention/valuations/retired`.
 */
interface RetiredValuation {
  id: string;
  number: number;
  company_name: string;
  kind: string;
  state: string;
  archived_at: string;
  retired_reason: string | null;
  retired_manually: boolean;
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
  const [holdsTruncated, setHoldsTruncated] = useState(false);
  const [actions, setActions] = useState<Action[]>([]);
  const [retired, setRetired] = useState<{ valuations: RetiredValuation[]; total: number } | null>(null);
  const [retiredQuery, setRetiredQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
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
      const [p, h, a, r] = await Promise.all([
        api<{ policies: Policy[] }>('/admin/retention/policies'),
        api<{ holds: Hold[]; truncated: boolean }>('/admin/retention/holds'),
        api<{ actions: Action[] }>('/admin/retention/actions'),
        api<{ valuations: RetiredValuation[]; total: number }>('/admin/retention/valuations/retired'),
      ]);
      setPolicies(p.policies);
      setHolds(h.holds);
      // A hold that is not listed reads as a hold that is not in force — the one
      // wrong conclusion this table must not invite, since it is the screen an
      // operator checks before letting the sweep run.
      setHoldsTruncated(h.truncated);
      setActions(a.actions);
      setRetired({ valuations: r.valuations, total: r.total });
    } catch (err) {
      setError(describeLoadFailure(err, 'Could not load retention settings.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, token]);

  if (!policies) return error ? <LoadError message={error} {...retryProps} /> : <Spinner />;

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
        setError(describeActionFailure(err, 'Could not save the policy.'));
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
        setError(describeActionFailure(err, 'Could not place the hold.'));
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
        setError(describeActionFailure(err, 'Could not release the hold.'));
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
        setError(describeActionFailure(err, 'Could not restore that valuation.'));
      }
    });

  /**
   * Search the withdrawn list.
   *
   * Separate from `load()` so a search does not re-fetch the policies and the
   * holds, and so a failed search leaves the previous results on screen with
   * the error above them rather than emptying the section — an empty list and
   * a failed search look identical, and only one of them means "nothing
   * matched".
   */
  const searchRetired = () =>
    run('retired-search', async () => {
      setError(null);
      try {
        const q = retiredQuery.trim();
        const r = await api<{ valuations: RetiredValuation[]; total: number }>(
          `/admin/retention/valuations/retired${q === '' ? '' : `?q=${encodeURIComponent(q)}`}`,
        );
        setRetired({ valuations: r.valuations, total: r.total });
      } catch (err) {
        setError(describeActionFailure(err, 'Could not search withdrawn engagements.'));
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
        setError(describeActionFailure(err, 'Could not retire that valuation.'));
      }
    });

  const runSweep = () =>
    run('sweep', async () => {
      setNote(null);
      setError(null);
      try {
        /*
         * THE HALF THAT CANNOT BE UNDONE WAS THE HALF NOT REPORTED (R414,
         * methodology M5). `SweepResult` carries three numbers and this note
         * read two of them. `archived` is reversible and has a Restore button
         * three rows down; `purged` is `sweepOutbox`, which the route's own
         * comment calls "the destructive one" — outbox rows deleted outright
         * under the `email_outbox` policy, taking `email_delivery_events` with
         * them by cascade.
         *
         * So the sentence an administrator got after pressing the button
         * described only the recoverable work, and a pass that destroyed a
         * year of client correspondence and archived nothing said "Sweep
         * complete: 0 archived, 0 held." The deletions are in the decision log
         * this page reloads underneath, which is where the audit answer lives —
         * but the operator is owed the number by the control they just used,
         * not by a table they have to go and read.
         *
         * `?? 0` because this note must not turn an older build's body into a
         * claim that nothing was deleted; a build that does not send the field
         * simply keeps the sentence it had.
         */
        const { result } = await api<{
          result: { archived: number; skipped_hold: number; purged?: number };
        }>('/admin/retention/run', { method: 'POST' });
        const purged = result.purged ?? 0;
        setNote(
          `Sweep complete: ${result.archived} archived, ${result.skipped_hold} held` +
            (purged > 0
              ? `, ${purged} outbox message${purged === 1 ? '' : 's'} deleted for good`
              : '') +
            '.',
        );
        await load();
      } catch (err) {
        setError(describeActionFailure(err, 'Could not run the archival sweep.'));
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
      {note && <SuccessNote className="mt-4">{note}</SuccessNote>}

      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="retention-policies-heading" className="overline text-ink-400">
            Retention policies
          </h2>
          <Button variant="secondary" onClick={runSweep} disabled={busy !== null}>
            {busy === 'sweep' ? 'Running sweep…' : 'Run archival sweep'}
          </Button>
        </div>
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="w-full min-w-[600px] text-sm" aria-labelledby="retention-policies-heading">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-3 py-2 font-semibold text-ink-400">Data type</th>
                <th className="overline px-3 py-2 font-semibold text-ink-400">Archive after (days)</th>
                <th className="overline px-3 py-2 font-semibold text-ink-400">Retain (days)</th>
                <th className="overline px-3 py-2 font-semibold text-ink-400">Enabled</th>
                {/* The column this screen was missing. Four of the five rows
                    below save three numbers and a checkbox and are read by
                    nothing, and until the server said so there was no way to
                    tell them apart from the row that works. */}
                <th className="overline px-3 py-2 font-semibold text-ink-400">Effect</th>
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
                  <td colSpan={6} className="px-3 py-6 text-center text-sm text-ink-400">
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
                  <td className="max-w-sm px-3 py-2 text-xs text-ink-600">
                    {p.enforcement ? (
                      <>
                        <span
                          className={
                            p.enforcement.archives || p.enforcement.purges
                              ? 'font-semibold text-ink-800'
                              : 'font-semibold text-amber-800'
                          }
                        >
                          {effectSummary(p.enforcement)}
                        </span>{' '}
                        {p.enforcement.note}
                      </>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right align-top">
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
        <h2 id="legal-holds-heading" className="overline mb-4 text-ink-400">
          Legal holds
        </h2>
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
          <table className="mt-4 w-full text-sm" aria-labelledby="legal-holds-heading">
            <thead>
              <tr className="sr-only">
                <th scope="col">Scope</th>
                <th scope="col">Reason</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
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
        <ListTruncationNote truncated={holdsTruncated} shown={holds.length} noun="legal holds" />
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

      {/* State, not history — see the route's comment. The audit log below is
          capped and ordered by when things happened, so an engagement withdrawn
          before the last sweep falls off it and takes the only route back with
          it. This section is derived from `archived_at`, so nothing ages out
          of it: a row leaves only when it is restored. */}
      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="overline text-ink-400">Withdrawn engagements</h2>
          {retired && (
            <span className="text-xs text-ink-400">
              {retired.total === 0
                ? 'none'
                : retired.valuations.length < retired.total
                  ? `showing ${retired.valuations.length} of ${retired.total}`
                  : `${retired.total} withdrawn`}
            </span>
          )}
        </div>
        <p className="mb-4 max-w-2xl text-sm text-ink-500">
          Every engagement currently withdrawn, whether by a retention policy or by hand. Restoring one puts
          it back in the product, takes the “[retired]” suffix off its name, and lets it accept changes again.
        </p>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex-1 text-sm">
            <span className="overline mb-1 block text-ink-400">Search</span>
            <TextInput
              value={retiredQuery}
              onChange={(e) => setRetiredQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void searchRetired();
                }
              }}
              placeholder="company name, or an exact valuation id"
              aria-label="Search withdrawn engagements"
            />
          </label>
          <Button variant="secondary" disabled={busy !== null} onClick={() => void searchRetired()}>
            {busy === 'retired-search' ? 'Searching…' : 'Search'}
          </Button>
          <ResultCount
            count={retired ? retired.valuations.length : null}
            noun="withdrawn engagement"
            query={retiredQuery}
          />
        </div>
        {!retired ? (
          <Spinner />
        ) : retired.valuations.length === 0 ? (
          <p className="text-sm text-ink-400">
            {retiredQuery.trim() === ''
              ? 'No engagement is withdrawn.'
              : 'No withdrawn engagement matches that.'}
          </p>
        ) : (
          <ul className="divide-y divide-paper-200">
            {retired.valuations.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className="tnum text-xs text-ink-400">#{v.number}</span>
                <span className="font-semibold text-ink-900">{v.company_name}</span>
                <span className="text-xs text-ink-400">{kindLabel(v.kind)}</span>
                {/* The reason is what tells an admin whether this is the row
                    the support ticket is about. A policy archival has none,
                    and that absence is itself the answer. */}
                <span className="text-xs text-ink-500">
                  {v.retired_reason
                    ? `“${v.retired_reason}”`
                    : v.retired_manually
                      ? 'withdrawn by hand, no reason recorded'
                      : 'retention policy'}
                </span>
                <span className="ml-auto text-xs text-ink-400">{formatDateTime(v.archived_at)}</span>
                <button
                  onClick={() => restoreValuation(v.id)}
                  disabled={busy !== null}
                  className="cursor-pointer text-xs font-semibold text-bond-600 hover:text-bond-700 disabled:cursor-not-allowed disabled:text-ink-300"
                >
                  {busy === `restore:${v.id}` ? 'Restoring…' : 'Restore'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="overline text-ink-400">Retention audit log</h2>
          {actions.length > ACTION_LOG_LIMIT && (
            // Said rather than left to be inferred: this list is where the
            // restore control used to live, and a cut list that does not
            // admit it is a cut list looks like the whole story.
            <span className="text-xs text-ink-400">
              showing the {ACTION_LOG_LIMIT} most recent of {actions.length} — older withdrawals are in the
              section above
            </span>
          )}
        </div>
        {actions.length === 0 ? (
          <p className="text-sm text-ink-400">No retention actions recorded yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {actions.slice(0, ACTION_LOG_LIMIT).map((a) => (
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
