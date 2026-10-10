import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Spinner } from '../components/ui';
import { handOffAfterSignIn } from '../components/SignedInHandoff';

export function MicrosoftCompletePage() {
  const { adoptToken } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const mfaChallenge = fragment.get('mfa');
    if (mfaChallenge) {
      window.history.replaceState(null, '', '/auth/microsoft/complete');
      navigate('/login', { replace: true, state: { mfaChallenge } });
      return;
    }
    const token = fragment.get('token');
    if (!token) {
      setFailed(true);
      return;
    }
    window.history.replaceState(null, '', '/auth/microsoft/complete');
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
        <p className="font-display text-xl text-ink-900">Microsoft sign-in didn't complete</p>
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
