import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, describeRequestFailure } from '../lib/api';
import { sanitizeHtml } from '../lib/m2';
import { Wordmark } from '../components/Logo';
import { Button, ErrorNote, Field, Modal } from '../components/ui';
import { formatAmount, formatDate } from '../lib/format';
import { mainContentTargetProps } from '../components/SkipLink';

/**
 * Public board-member signing page (feature 5). A board member arrives via the
 * emailed link `/board-sign#token=…`; the token lives in the URL fragment so it
 * never reaches server logs or a Referer header. No login required.
 *
 * Both decisions are final and the page has to say so before it takes one.
 * `POST /board/sign` refuses anything from a member whose status is not
 * `pending` — "You have already recorded a decision on this resolution" — and
 * the firm's own remedy does not reach it: re-sending the link re-mints the
 * token and leaves the status alone, so the fresh link 409s on arrival. The
 * only way back is deleting the member and re-adding them, which throws away
 * the record of who was asked. So a director who meant Sign and hit the button
 * beside it had rejected their company's 409A resolution, permanently, in one
 * click, on a page they reached from an email.
 */

interface ResolutionView {
  member: { name: string; email: string; status: 'pending' | 'signed' | 'rejected' };
  resolution: {
    body_html: string;
    status: string;
    valuation_date: string;
    fmv_conclusion: string;
    currency: string;
  };
}

function tokenFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  return new URLSearchParams(hash).get('token');
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper-100">
      <header className="border-b border-chrome-800 bg-chrome-900 px-6 py-4">
        <Wordmark light />
      </header>
      <main
        {...mainContentTargetProps}
        className={`mx-auto w-full max-w-3xl flex-1 px-5 py-10 ${mainContentTargetProps.className}`}
      >
        <h1 className="mb-6 font-display text-2xl font-semibold text-ink-900">Board resolution</h1>
        {children}
      </main>
    </div>
  );
}

export function BoardSignPage() {
  const [token] = useState<string | null>(() => tokenFromHash());
  const [view, setView] = useState<ResolutionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'signed' | 'rejected' | null>(null);
  /** The decision the member has asked for and not yet confirmed. */
  const [confirming, setConfirming] = useState<'signed' | 'rejected' | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      // No `#token=` at all, which is overwhelmingly one cause: the link was
      // cut short between the email and the address bar. The server says so
      // for every *other* dead-link state on this surface; there is no request
      // to make here, so the same remedy is written out rather than withheld
      // because the page never got as far as asking.
      setError(
        'This signing link is incomplete — the part that identifies you is missing from it. ' +
          'Open the original email and use the whole link, including any part that wrapped onto a ' +
          'second line. If it still will not open, ask whoever circulated the resolution to send ' +
          'you a new signing link; no decision has been recorded for you.',
      );
      return;
    }
    try {
      // POST, not a query string: the signing token is a bearer credential and
      // must not end up in access logs, Referer headers or browser history.
      const res = await api<ResolutionView>('/board/resolution', {
        method: 'POST',
        body: { token },
      });
      setView(res);
      if (res.member.status !== 'pending') setDone(res.member.status);
    } catch (err) {
      /*
       * The server's own sentence, not a status code translated back into one.
       *
       * Both arms of the branch that stood here threw away the only message
       * written for the person reading it. The 404 arm replaced
       * `DEAD_LINK_DETAIL.board` — which names the cause a director can
       * actually fix (a link cut short in the mail), says who reissues it, and
       * ends with the one fact they came to the page for, that no decision has
       * been recorded for them — with six words that say none of those. The
       * other arm was worse, because it is where the 429 lands: the public
       * throttle computes the wait exactly and phrases it, and "Could not load
       * the resolution" turned "try again in about 40 seconds" into a dead end.
       */
      setError(
        err instanceof ApiError
          ? describeRequestFailure(err)
          : 'This page could not reach the server, so the resolution has not loaded. That is a ' +
              'connection problem rather than anything wrong with your link — check your network ' +
              'and reload. No decision has been recorded for you.',
      );
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (decision: 'signed' | 'rejected') => {
    if (!token) return;
    setError(null);
    setBusy(true);
    try {
      await api('/board/sign', {
        method: 'POST',
        body: { token, decision, comment: comment.trim() || null },
      });
      setDone(decision);
    } catch (err) {
      setError(describeRequestFailure(err));
    } finally {
      setBusy(false);
      // Out of the way either way: on success the page becomes the receipt
      // below, and on failure the error belongs where the member can read it
      // rather than behind a dialog asking them to decide again.
      setConfirming(null);
    }
  };

  if (error && !view) {
    return (
      <Shell>
        <ErrorNote>{error}</ErrorNote>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="rounded-md border border-bond-200 bg-bond-50 px-4 py-8 text-center">
          <p className="font-display text-lg text-ink-900">
            {done === 'signed' ? 'Thank you — your signature is recorded.' : 'Your response is recorded.'}
          </p>
          <p className="mt-2 text-sm text-ink-500">You can close this window.</p>
        </div>
      </Shell>
    );
  }

  if (!view) {
    return (
      <Shell>
        <p className="text-sm text-ink-400">Loading…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="mb-4 text-sm text-ink-500">
        Signing as <span className="font-semibold text-ink-800">{view.member.name}</span> ({view.member.email}
        ).
      </p>
      <div
        className="prose-resolution max-h-[50vh] overflow-y-auto overscroll-y-contain rounded-lg border border-paper-300 bg-surface p-6 text-sm text-ink-800 shadow-card [&_h1]:mb-2 [&_h1]:font-display [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:font-semibold [&_p]:mb-3"
        // Escaped server-side when rendered, sanitized again here. This page is
        // reached with a signing token by someone outside the org, so it is the
        // one render where a lapse upstream would land on an outsider.
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(view.resolution.body_html) }}
      />
      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="mt-5">
        <Field label="Comment (optional)">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={2}
            className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
          />
        </Field>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button onClick={() => setConfirming('signed')} disabled={busy}>
          {busy ? 'Recording…' : 'Sign & adopt'}
        </Button>
        <Button variant="danger" onClick={() => setConfirming('rejected')} disabled={busy}>
          Reject
        </Button>
      </div>
      <p className="mt-3 text-xs text-ink-400">
        Your decision is recorded against your name and cannot be changed afterwards.
      </p>

      <Modal
        open={confirming !== null}
        onClose={() => !busy && setConfirming(null)}
        title={confirming === 'rejected' ? 'Reject this resolution?' : 'Sign this resolution?'}
      >
        <div className="px-5 py-4">
          <p className="text-sm text-ink-700">
            {confirming === 'rejected'
              ? `You are recording a rejection of the board resolution adopting a fair market value of ${formatAmount(view.resolution.fmv_conclusion, view.resolution.currency)} per share as of ${formatDate(view.resolution.valuation_date)}.`
              : `You are signing the board resolution adopting a fair market value of ${formatAmount(view.resolution.fmv_conclusion, view.resolution.currency)} per share as of ${formatDate(view.resolution.valuation_date)}.`}
          </p>
          <p className="mt-3 text-sm text-ink-700">
            This is recorded against {view.member.name} ({view.member.email}) and cannot be changed
            afterwards.
          </p>
          {comment.trim() && (
            <p className="mt-3 rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-600">
              Your comment: “{comment.trim()}”
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            <Button
              variant={confirming === 'rejected' ? 'danger' : 'primary'}
              onClick={() => confirming && void submit(confirming)}
              disabled={busy}
            >
              {busy ? 'Recording…' : confirming === 'rejected' ? 'Record rejection' : 'Confirm signature'}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(null)} disabled={busy}>
              Go back
            </Button>
          </div>
        </div>
      </Modal>
    </Shell>
  );
}
