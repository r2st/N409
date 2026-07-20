import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Wordmark } from '../components/Logo';
import { Button, ErrorNote, Field } from '../components/ui';

/**
 * Public board-member signing page (feature 5). A board member arrives via the
 * emailed link `/board-sign#token=…`; the token lives in the URL fragment so it
 * never reaches server logs or a Referer header. No login required.
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
      <header className="border-b border-paper-300 bg-ink-900 px-6 py-4">
        <Wordmark light />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10">
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

  const load = useCallback(async () => {
    if (!token) {
      setError('This signing link is invalid or incomplete.');
      return;
    }
    try {
      const res = await api<ResolutionView>(`/board/resolution?token=${encodeURIComponent(token)}`);
      setView(res);
      if (res.member.status !== 'pending') setDone(res.member.status);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This signing link is no longer valid.'
          : 'Could not load the resolution.',
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
      setError(err instanceof ApiError ? err.message : 'Could not record your decision.');
    } finally {
      setBusy(false);
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
            {done === 'signed'
              ? 'Thank you — your signature is recorded.'
              : 'Your response is recorded.'}
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
        Signing as <span className="font-semibold text-ink-800">{view.member.name}</span> (
        {view.member.email}).
      </p>
      <div
        className="prose-resolution max-h-[50vh] overflow-y-auto rounded-lg border border-paper-300 bg-white p-6 text-sm text-ink-800 shadow-card [&_h1]:mb-2 [&_h1]:font-display [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:font-semibold [&_p]:mb-3"
        dangerouslySetInnerHTML={{ __html: view.resolution.body_html }}
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
            className="w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
          />
        </Field>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button onClick={() => void submit('signed')} disabled={busy}>
          {busy ? 'Recording…' : 'Sign & adopt'}
        </Button>
        <Button variant="danger" onClick={() => void submit('rejected')} disabled={busy}>
          Reject
        </Button>
      </div>
    </Shell>
  );
}
