import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { AuthShell } from '../components/AuthShell';
import { ErrorNote, Spinner } from '../components/ui';

/**
 * Gap #26 — confirm an email address from an emailed link. The token travels in
 * the URL fragment (like ResetPasswordPage) so it never reaches server logs; a
 * ?token= query param is accepted as a fallback. Verification runs on load —
 * there's nothing for the user to fill in.
 */
type State =
  | { kind: 'verifying' }
  | { kind: 'ok'; already: boolean }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

export function VerifyEmailPage() {
  const [state, setState] = useState<State>({ kind: 'verifying' });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-invoke guard
    ran.current = true;
    const fromFragment = new URLSearchParams(window.location.hash.slice(1)).get('token');
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    const token = fromFragment ?? fromQuery;
    if (!token) {
      setState({ kind: 'missing' });
      return;
    }
    // Drop the token from the URL before anything else can observe it.
    window.history.replaceState(null, '', '/verify-email');
    void (async () => {
      try {
        const res = await api<{ status: string; message: string }>('/auth/verify-email', {
          method: 'POST',
          body: { token },
        });
        setState({ kind: 'ok', already: res.status === 'already_verified' });
      } catch (err) {
        setState({
          kind: 'error',
          message:
            err instanceof ApiError ? err.message : 'Something went wrong — please try again.',
        });
      }
    })();
  }, []);

  if (state.kind === 'verifying') {
    return (
      <AuthShell title="Verifying your email" subtitle="This only takes a moment.">
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      </AuthShell>
    );
  }

  if (state.kind === 'ok') {
    return (
      <AuthShell title="Email verified" subtitle="Your account is confirmed.">
        <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
          {state.already
            ? 'Your email address was already verified — you’re all set.'
            : 'Thanks — your email address has been verified.'}
        </div>
        <p className="mt-8 text-center text-sm text-ink-400">
          <Link to="/login" className="font-semibold text-bond-600 hover:text-bond-700">
            Continue to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  if (state.kind === 'missing') {
    return (
      <AuthShell title="Verification link invalid" subtitle="This page needs a link from a verification email.">
        <p className="text-sm text-ink-600">
          The verification link is missing or incomplete. Sign in and request a fresh link from your
          account settings.
        </p>
        <p className="mt-8 text-center text-sm text-ink-400">
          <Link to="/login" className="font-semibold text-bond-600 hover:text-bond-700">
            Go to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Verification failed" subtitle="This link didn’t work.">
      <ErrorNote>{state.message}</ErrorNote>
      <p className="mt-6 text-sm text-ink-600">
        Verification links expire after 24 hours and can be used once. Sign in and request a fresh
        link from your account settings.
      </p>
      <p className="mt-8 text-center text-sm text-ink-400">
        <Link to="/login" className="font-semibold text-bond-600 hover:text-bond-700">
          Go to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
