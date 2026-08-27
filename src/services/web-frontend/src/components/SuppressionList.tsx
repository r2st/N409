import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { useClearOnChange } from '../lib/useClearOnChange';
import { formatDateTime } from '../lib/format';
import { Button, ErrorNote, ListTruncationNote, LoadingBlock, SkeletonTable } from './ui';

/**
 * The email suppression list, and the control that lifts one.
 *
 * `POST /admin/email/suppressions/release` describes itself as "the recovery
 * path for a wrong one" and its own comment records that nothing in the SPA
 * called it. That is the whole defect: a hard bounce, a transient mailbox-full,
 * or one spam complaint from a client's colleague suppresses an address
 * permanently, the outbox then files every later message as `skipped` under
 * "Not sent — the address is suppressed", and there was no screen anywhere that
 * would say which addresses were on the list or take one off it. A client
 * quietly stops receiving their own 409A report and the recovery is a SQL
 * prompt.
 *
 * It lives beside the outbox rather than on a page of its own because the two
 * are read in one motion: the reason to look at this list is a `skipped` row in
 * the table above it.
 *
 * Released rows are available but off by default. The row is kept rather than
 * deleted precisely so "this was suppressed and an admin lifted it" survives,
 * and that history is worth having a switch for — but the default question an
 * operator arrives with is "who is being blocked right now".
 */

interface Suppression {
  to_email: string;
  reason: 'hard' | 'soft' | 'complaint';
  detail: string | null;
  outbox_id: string | null;
  created_at: string;
  released_at: string | null;
  released_by: string | null;
}

/** What each reason is evidence of, and what it implies about releasing it. */
const REASON_TITLES: Record<Suppression['reason'], string> = {
  hard: 'The recipient’s mail system rejected the address outright — usually it does not exist.',
  soft: 'A temporary failure that kept recurring — a full mailbox, or a server that stayed down.',
  complaint: 'The recipient marked a message as spam. Releasing this re-mails somebody who asked not to be.',
};

const REASON_STYLES: Record<Suppression['reason'], string> = {
  hard: 'bg-red-50 text-red-700 border-red-200',
  soft: 'bg-amber-50 text-amber-800 border-amber-200',
  complaint: 'bg-red-50 text-red-700 border-red-200',
};

export function SuppressionList() {
  const [rows, setRows] = useState<Suppression[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [includeReleased, setIncludeReleased] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /*
   * `includeReleased` moves this effect's URL and nothing orders the replies,
   * so the released-inclusive answer can land under an unchecked box and the
   * other way round. What that shows is a row marked "Released" in a list whose
   * own control says released rows are hidden — and the operator's next move is
   * to look for a Release button that is not there. See `useLatestOnly`.
   */
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    setError(null);
    try {
      const res = await api<{ suppressions?: Suppression[]; truncated?: boolean }>(
        `/admin/email/suppressions?include_released=${includeReleased ? 'true' : 'false'}`,
      );
      // A 200 with the wrong shape is the failure that reaches the render:
      // `undefined` in `rows` throws on `.length` and takes the outbox page
      // down with it. Reported as a failed load, which is what it is.
      if (!current()) return;
      if (!Array.isArray(res.suppressions)) throw new TypeError('malformed suppression payload');
      setRows(res.suppressions);
      setTruncated(res.truncated === true);
    } catch (err) {
      if (!current()) return;
      // A suppression list that failed to load and an empty one are the same
      // picture and opposite facts, and the empty one is reassuring.
      setError(
        err instanceof ApiError && err.status === 403
          ? 'The suppression list is operations-only.'
          : 'Could not load the suppression list.',
      );
      setRows(null);
    }
  }, [includeReleased, claim]);

  // The checkbox is the question; the table is the answer to it. Without this
  // the un-released list sits under a ticked "Show released" box for a whole
  // round trip, unmarked — and `load` is shared with Refresh and with the
  // re-read after a release, so clearing inside the loader would flash a
  // skeleton over an answer that had not changed. See `useClearOnChange`.
  useClearOnChange(String(includeReleased), () => setRows(null));

  useEffect(() => {
    void load();
  }, [load]);

  const release = async (address: string) => {
    setBusy(address);
    setActionError(null);
    try {
      // The address travels in the body, never the path: it is PII, and a path
      // is the part of a request everything logs. See the route's comment.
      await api('/admin/email/suppressions/release', { method: 'POST', body: { address } });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not release that suppression.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold text-ink-900">Suppressed addresses</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-400">
            The platform sends nothing to an address on this list — a message to one is filed as
            <span className="font-semibold"> skipped</span> above rather than failed. A hard bounce or a spam
            complaint adds one automatically, so an address here is not necessarily one anybody chose.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-600">
            <input
              type="checkbox"
              checked={includeReleased}
              onChange={(e) => setIncludeReleased(e.target.checked)}
            />
            Show released
          </label>
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {actionError && (
        <div className="mt-4">
          <ErrorNote>{actionError}</ErrorNote>
        </div>
      )}

      {!rows ? (
        !error && (
          <div className="mt-6">
            <LoadingBlock label="Loading suppressed addresses…">
              <SkeletonTable columns={4} rows={3} />
            </LoadingBlock>
          </div>
        )
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink-500">
          {includeReleased ? 'No address has ever been suppressed.' : 'No address is currently suppressed.'}
        </p>
      ) : (
        <>
          <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[720px] text-sm" aria-label="Suppressed addresses">
              <thead>
                <tr className="border-b border-paper-300 text-left">
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Address</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Reason</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Suppressed</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.to_email}-${row.created_at}`}
                    className="border-b border-paper-200 align-top last:border-0"
                  >
                    <td className="px-5 py-3.5 text-ink-900">{row.to_email}</td>
                    <td className="px-4 py-3.5">
                      <span
                        title={REASON_TITLES[row.reason]}
                        className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${REASON_STYLES[row.reason]}`}
                      >
                        {row.reason[0]!.toUpperCase() + row.reason.slice(1)}
                      </span>
                      {row.detail && (
                        <div className="mt-1 max-w-64 text-xs text-ink-500" title={row.detail}>
                          <span className="line-clamp-2">{row.detail}</span>
                        </div>
                      )}
                    </td>
                    <td className="tnum px-4 py-3.5 text-ink-600">{formatDateTime(row.created_at)}</td>
                    <td className="px-4 py-3.5">
                      {row.released_at === null ? (
                        <Button
                          variant="secondary"
                          disabled={busy !== null}
                          onClick={() => void release(row.to_email)}
                        >
                          {busy === row.to_email ? 'Releasing…' : 'Release'}
                        </Button>
                      ) : (
                        // The row survives its own release, which is the point:
                        // "this was suppressed and an admin lifted it" is the
                        // history somebody will want later.
                        <span className="text-xs text-ink-500">
                          Released {formatDateTime(row.released_at)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListTruncationNote
            truncated={truncated}
            shown={rows.length}
            noun="suppressed addresses"
            hint="narrow with the released filter, or raise ?limit="
          />
        </>
      )}
    </section>
  );
}
