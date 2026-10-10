import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Spinner } from '../components/ui';
import { handOffAfterSignIn } from '../components/SignedInHandoff';

/**
 * Landing page for an SSO hand-off: `/auth/google/complete#token=…`, and — for
 * an account with 2FA enrolled here — `#mfa=<challenge>`.
 *
 * Both SSO doors used to answer a 2FA-enabled account with a session outright,
 * skipping in full the factor its owner had enrolled and that `require_mfa`
 * will not let them remove (R354). They now hand back a challenge, the same one
 * `POST /auth/login` returns, and the second-factor screen that already knows
 * how to redeem it lives on `LoginPage` — so this page carries the challenge
 * there in router state rather than growing a second copy of that form.
 */
export function GoogleCompletePage() {
  const { adoptToken } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-invoke guard
    ran.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const mfaChallenge = fragment.get('mfa');
    if (mfaChallenge) {
      // Out of the URL first, for the reason the token is: a challenge is a
      // bearer credential for the second step and the address bar is not a
      // private channel for one. `replace` so the browser Back button does not
      // return to a fragment that has already been spent.
      window.history.replaceState(null, '', '/auth/google/complete');
      navigate('/login', { replace: true, state: { mfaChallenge } });
      return;
    }
    const token = fragment.get('token');
    if (!token) {
      setFailed(true);
      return;
    }
    // Drop the token from the URL before anything else can observe it.
    window.history.replaceState(null, '', '/auth/google/complete');
    let returnTo = '/';
    try {
      const stored = sessionStorage.getItem('n409.post_auth_return');
      if (stored) { returnTo = stored; sessionStorage.removeItem('n409.post_auth_return'); }
    } catch {}
    adoptToken(token)
      .then(() => handOffAfterSignIn(returnTo, navigate))
      .catch(() => setFailed(true));
  }, [adoptToken, navigate]);

  if (failed) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-paper-100 px-6 text-center">
        <p className="font-display text-xl text-ink-900">Google sign-in didn't complete</p>
        <p className="text-sm text-ink-400">The sign-in link was missing or expired.</p>
        <Link to="/login" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper-100">
      <Spinner />
    </div>
  );
}
