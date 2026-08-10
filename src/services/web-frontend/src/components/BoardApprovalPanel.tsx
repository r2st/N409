import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { sanitizeHtml } from '../lib/m2';
import type { Valuation } from '../lib/types';
import { Button, ErrorNote, Field, TextInput } from './ui';

/**
 * Board approval workflow (feature 5). After a valuation is finalized, ops
 * generate the board resolution, add board members, and email each a signing
 * link. Member sign-off status rolls up into the resolution's approval state —
 * the approval timestamp is the 409A safe-harbor record.
 */

type BoardResolutionStatus = 'pending' | 'approved' | 'rejected';
type BoardSignoffStatus = 'pending' | 'signed' | 'rejected';

interface BoardMember {
  id: string;
  member_name: string;
  member_email: string;
  member_title: string | null;
  status: BoardSignoffStatus;
  comment: string | null;
  sent_at: string | null;
  signed_at: string | null;
  /** Deadline on this member's signing token (migration 0101). */
  token_expires_at?: string | null;
}

interface BoardResolution {
  id: string;
  valuation_date: string;
  fmv_conclusion: string;
  currency: string;
  body_html: string;
  status: BoardResolutionStatus;
  approved_at: string | null;
  updated_at: string;
}

interface BoardResponse {
  resolution: BoardResolution | null;
  members: BoardMember[];
}

const RESOLUTION_TONE: Record<BoardResolutionStatus, string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-200',
  approved: 'bg-bond-50 text-bond-700 ring-bond-200',
  rejected: 'bg-red-50 text-red-700 ring-red-200',
};

const SIGNOFF_TONE: Record<BoardSignoffStatus, string> = {
  pending: 'bg-paper-200 text-ink-500 ring-ink-200',
  signed: 'bg-bond-50 text-bond-700 ring-bond-200',
  rejected: 'bg-red-50 text-red-700 ring-red-200',
};

/**
 * What to tell ops about a pending member's signing link.
 *
 * Signing tokens expire (migration 0101), and the failure mode without this is
 * silent: the director clicks a dead link, the console still says "pending",
 * and nobody learns anything until someone chases it by email. Resend re-mints,
 * so the fix is one click away once the state is visible.
 */
export function signingLinkNote(
  member: Pick<BoardMember, 'status' | 'sent_at' | 'token_expires_at'>,
  now: Date,
): string | null {
  if (member.status !== 'pending' || !member.token_expires_at) return null;
  const expiresAt = new Date(member.token_expires_at).getTime();
  if (!Number.isFinite(expiresAt)) return null;
  if (expiresAt <= now.getTime()) return 'Link expired — resend';
  // Only worth saying once the link is actually out there; an unsent member's
  // countdown is noise on a row whose next action is "Email link" regardless.
  if (!member.sent_at) return null;
  const days = Math.ceil((expiresAt - now.getTime()) / (24 * 60 * 60 * 1000));
  return days <= 7 ? `Link expires in ${days} day${days === 1 ? '' : 's'}` : null;
}

export function BoardApprovalPanel({ valuation }: { valuation: Valuation }) {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [member, setMember] = useState({ name: '', email: '', title: '' });
  const [lastLink, setLastLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<BoardResponse>(`/valuations/${valuation.id}/board`));
    } catch {
      setData({ resolution: null, members: [] });
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuation.id}/board`, { method: 'POST', body: {} });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate the resolution.');
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ sign_token: string }>(`/valuations/${valuation.id}/board/members`, {
        method: 'POST',
        body: {
          name: member.name.trim(),
          email: member.email.trim(),
          title: member.title.trim() || null,
        },
      });
      setMember({ name: '', email: '', title: '' });
      setLastLink(`${window.location.origin}/board-sign#token=${res.sign_token}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the board member.');
    } finally {
      setBusy(false);
    }
  };

  const sendLink = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuation.id}/board/members/${id}/send`, { method: 'POST', body: {} });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the signing link.');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuation.id}/board/members/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the board member.');
    } finally {
      setBusy(false);
    }
  };

  const resolution = data?.resolution ?? null;
  const members = data?.members ?? [];

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="overline text-ink-400">Board approval</h2>
        {resolution && (
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${RESOLUTION_TONE[resolution.status]}`}
          >
            {resolution.status === 'approved'
              ? 'Approved'
              : resolution.status === 'rejected'
                ? 'Rejected'
                : 'Awaiting signatures'}
          </span>
        )}
        {resolution?.approved_at && (
          <span className="tnum text-xs text-ink-400">Approved {formatDateTime(resolution.approved_at)}</span>
        )}
      </div>
      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {!resolution ? (
        <div>
          <p className="mb-3 text-sm text-ink-500">
            Generate a board resolution from the concluded fair market value, then collect e-signatures from
            the board for safe-harbor adoption.
          </p>
          <Button onClick={() => void generate()} disabled={busy}>
            {busy ? 'Generating…' : 'Generate resolution'}
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="rounded-md border border-paper-300 bg-paper-50 px-4 py-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-600">
              <span>
                <span className="font-semibold text-ink-800">FMV:</span> {resolution.currency}{' '}
                {resolution.fmv_conclusion} / share
              </span>
              <span>
                <span className="font-semibold text-ink-800">As of:</span> {resolution.valuation_date}
              </span>
            </div>
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-bond-600 hover:text-bond-700">
                View resolution text
              </summary>
              <div
                className="prose-resolution mt-3 max-h-72 overflow-y-auto rounded border border-paper-200 bg-surface p-4 text-sm text-ink-800 [&_h1]:mb-2 [&_h1]:font-display [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:font-semibold [&_p]:mb-2"
                // Body is rendered and HTML-escaped server-side
                // (domain/boardResolution.ts), and sanitized again here. The
                // second pass is not redundancy for its own sake: the escaping
                // lives in a template a future field could be added to without
                // it, and this is the render that a board member — not an
                // employee — ends up looking at.
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(resolution.body_html) }}
              />
            </details>
            {resolution.status !== 'approved' && (
              <button
                className="mt-3 cursor-pointer text-xs font-semibold text-ink-500 hover:underline"
                disabled={busy}
                onClick={() => void generate()}
              >
                Regenerate (clears signatures)
              </button>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-bold text-ink-500 uppercase">Board members</h3>
            {members.length === 0 ? (
              <p className="text-sm text-ink-400">No board members added yet.</p>
            ) : (
              <ul className="space-y-2">
                {members.map((m) => {
                  const linkNote = signingLinkNote(m, new Date());
                  return (
                    <li
                      key={m.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-paper-300 px-3.5 py-2.5"
                    >
                      <span className="font-semibold text-ink-800">{m.member_name}</span>
                      {m.member_title && <span className="text-sm text-ink-500">{m.member_title}</span>}
                      <span className="text-sm text-ink-400">{m.member_email}</span>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${SIGNOFF_TONE[m.status]}`}
                      >
                        {m.status}
                      </span>
                      {m.signed_at && (
                        <span className="tnum text-xs text-ink-400">{formatDateTime(m.signed_at)}</span>
                      )}
                      {linkNote && <span className="text-xs font-semibold text-amber-700">{linkNote}</span>}
                      <span className="ml-auto flex items-center gap-3">
                        {m.status === 'pending' && (
                          <button
                            className="cursor-pointer text-xs font-semibold text-bond-600 hover:underline"
                            disabled={busy}
                            onClick={() => void sendLink(m.id)}
                          >
                            {m.sent_at ? 'Resend link' : 'Email link'}
                          </button>
                        )}
                        {m.status === 'pending' && (
                          <button
                            className="cursor-pointer text-xs font-semibold text-red-700 hover:underline"
                            disabled={busy}
                            onClick={() => void removeMember(m.id)}
                          >
                            remove
                          </button>
                        )}
                      </span>
                      {m.comment && <p className="w-full text-xs text-ink-500 italic">“{m.comment}”</p>}
                    </li>
                  );
                })}
              </ul>
            )}

            {resolution.status !== 'approved' && (
              <form onSubmit={addMember} className="mt-4 grid gap-3 sm:grid-cols-3">
                <Field label="Name">
                  <TextInput
                    value={member.name}
                    onChange={(e) => setMember((m) => ({ ...m, name: e.target.value }))}
                    required
                    maxLength={200}
                  />
                </Field>
                <Field label="Email">
                  <TextInput
                    type="email"
                    value={member.email}
                    onChange={(e) => setMember((m) => ({ ...m, email: e.target.value }))}
                    required
                    maxLength={320}
                  />
                </Field>
                <Field label="Title (optional)">
                  <TextInput
                    value={member.title}
                    onChange={(e) => setMember((m) => ({ ...m, title: e.target.value }))}
                    maxLength={200}
                    placeholder="e.g. Director"
                  />
                </Field>
                <div className="sm:col-span-3">
                  <Button type="submit" disabled={busy || !member.name.trim() || !member.email.trim()}>
                    Add board member
                  </Button>
                </div>
              </form>
            )}

            {lastLink && (
              <p className="mt-3 rounded-md bg-paper-100 px-3 py-2 text-xs break-all text-ink-500">
                Signing link (share if email is off):{' '}
                <span className="font-mono text-ink-700">{lastLink}</span>
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
