import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Spinner } from '../components/ui';

/** Landing page for the Google OIDC redirect: /auth/google/complete#token=… */
export function GoogleCompletePage() {
  const { adoptToken } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-invoke guard
    ran.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (!token) {
      setFailed(true);
      return;
    }
    // Drop the token from the URL before anything else can observe it.
    window.history.replaceState(null, '', '/auth/google/complete');
    adoptToken(token)
      .then(() => navigate('/', { replace: true }))
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
