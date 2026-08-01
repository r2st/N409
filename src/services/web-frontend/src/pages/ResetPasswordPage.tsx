import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { AuthShell } from '../components/AuthShell';
import { Button, ErrorNote, Field, TextInput } from '../components/ui';

/**
 * P0 #3 — set a new password from an emailed link. The token travels in the
 * URL fragment (like GoogleCompletePage) so it never reaches server logs;
 * a ?token= query param is accepted as a fallback.
 */
export function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-invoke guard
    ran.current = true;
    const fromFragment = new URLSearchParams(window.location.hash.slice(1)).get('token');
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    const t = fromFragment ?? fromQuery;
    if (!t) {
      setMissing(true);
      return;
    }
    // Drop the token from the URL before anything else can observe it.
    window.history.replaceState(null, '', '/reset-password');
    setToken(t);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <AuthShell title="Reset link invalid" subtitle="This page needs a link from a reset email.">
        <p className="text-sm text-ink-600">
          The reset link is missing or incomplete. Request a new one and follow the link in the email exactly.
        </p>
        <p className="mt-8 text-center text-sm text-ink-400">
          <Link to="/forgot-password" className="font-semibold text-bond-600 hover:text-bond-700">
            Request a new reset link
          </Link>
        </p>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Password updated" subtitle="Your new password is active.">
        <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
          Your password has been changed. Sign in with it to continue.
        </div>
        <p className="mt-8 text-center text-sm text-ink-400">
          <Link to="/login" className="font-semibold text-bond-600 hover:text-bond-700">
            Go to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Reset links work once and expire after an hour.">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <ErrorNote>{error}</ErrorNote>
        <Field label="New password" hint="At least 10 characters.">
          <TextInput
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
          />
        </Field>
        <Field label="Confirm new password">
          <TextInput
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••••"
          />
        </Field>
        <Button type="submit" disabled={busy || !password || !confirm} className="w-full">
          {busy ? 'Updating…' : 'Set new password'}
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-ink-400">
        Link expired?{' '}
        <Link to="/forgot-password" className="font-semibold text-bond-600 hover:text-bond-700">
          Request a new one
        </Link>
      </p>
    </AuthShell>
  );
}
