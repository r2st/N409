import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AuthProviders } from '../lib/types';
import { AuthShell } from '../components/AuthShell';
import { Button, ErrorNote, Field, TextInput } from '../components/ui';

function GoogleButton() {
  return (
    <a
      href="/api/v1/auth/google"
      className="flex w-full items-center justify-center gap-2.5 rounded-md border border-ink-200 bg-surface px-4 py-2 text-sm font-semibold text-ink-800 transition-colors hover:border-ink-400 hover:bg-paper-50"
    >
      <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
        <path
          fill="#EA4335"
          d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.7 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.5 17.7 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.4 6.9-17.7z"
        />
        <path fill="#FBBC05" d="M10.5 28.6a14.5 14.5 0 0 1 0-9.2l-7.9-6.2a24 24 0 0 0 0 21.6l7.9-6.2z" />
        <path
          fill="#34A853"
          d="M24 48c6.2 0 11.4-2 15.2-5.6l-7.7-6c-2.1 1.4-4.8 2.3-7.5 2.3-6.3 0-11.6-4-13.5-9.6l-7.9 6.2C6.5 42.6 14.6 48 24 48z"
        />
      </svg>
      Continue with Google
    </a>
  );
}

export function LoginPage() {
  const { status, login, verifyMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  // Second-factor step: set once the password step returns a challenge.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(false);

  useEffect(() => {
    api<AuthProviders>('/auth/providers')
      .then(setProviders)
      .catch(() => setProviders({ password: true, google: false }));
  }, []);

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    // "/" is the role-aware landing (partners → /partner, others → /dashboard).
    return <Navigate to={from ?? '/'} replace />;
  }

  const goHome = () => navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(email, password);
      if (result.mfaRequired) {
        setChallenge(result.challenge);
      } else {
        goHome();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in — please try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      await verifyMfa({
        challenge,
        code: useBackup ? undefined : code.trim(),
        backupCode: useBackup ? code.trim() : undefined,
        rememberDevice,
      });
      goHome();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  };

  if (challenge) {
    return (
      <AuthShell title="Two-factor authentication" subtitle="Enter the code from your authenticator app.">
        <form onSubmit={submitCode} className="space-y-5" noValidate>
          <ErrorNote>{error}</ErrorNote>
          <Field label={useBackup ? 'Backup code' : 'Authenticator code'}>
            <TextInput
              autoFocus
              inputMode={useBackup ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={useBackup ? 'XXXX-XXXX' : '123456'}
              aria-label={useBackup ? 'Backup code' : 'Authenticator code'}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-500">
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={(e) => setRememberDevice(e.target.checked)}
            />
            Remember this device for 30 days
          </label>
          <Button type="submit" disabled={busy || !code.trim()} className="w-full">
            {busy ? 'Verifying…' : 'Verify'}
          </Button>
          <button
            type="button"
            className="block w-full text-center text-sm font-semibold text-bond-600 hover:text-bond-700"
            onClick={() => {
              setUseBackup((v) => !v);
              setCode('');
              setError(null);
            }}
          >
            {useBackup ? 'Use your authenticator app instead' : 'Use a backup code instead'}
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign in" subtitle="Access your valuations workspace.">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <ErrorNote>{error}</ErrorNote>
        <Field label="Email">
          <TextInput
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Password">
          <TextInput
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
          />
        </Field>
        <div className="-mt-2 text-right">
          <Link to="/forgot-password" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" disabled={busy || !email || !password} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {(providers?.google || providers?.saml) && (
        <>
          <div className="my-6 flex items-center gap-3 text-xs text-ink-300">
            <span className="h-px flex-1 bg-paper-300" />
            or
            <span className="h-px flex-1 bg-paper-300" />
          </div>
          {providers?.google && <GoogleButton />}
          {providers?.saml && (
            <a
              href="/api/v1/auth/saml/login"
              className="mt-3 flex w-full items-center justify-center gap-2.5 rounded-md border border-ink-200 bg-surface px-4 py-2 text-sm font-semibold text-ink-800 transition-colors hover:border-ink-400 hover:bg-paper-50"
            >
              Sign in with SSO
            </a>
          )}
        </>
      )}

      <p className="mt-8 text-center text-sm text-ink-400">
        New to N409?{' '}
        <Link to="/register" className="font-semibold text-bond-600 hover:text-bond-700">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
