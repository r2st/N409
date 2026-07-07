import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { AuthShell } from '../components/AuthShell';
import { Button, ErrorNote, Field, TextInput } from '../components/ui';

/** P0 #3 — request a password reset link. Never confirms whether an account exists. */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {sent ? (
        <div>
          <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
            If an account exists for <span className="font-semibold">{email}</span>, we've sent a
            password reset link. It expires in one hour.
          </div>
          <p className="mt-8 text-center text-sm text-ink-400">
            <Link to="/login" className="font-semibold text-bond-600 hover:text-bond-700">
              Back to sign in
            </Link>
          </p>
        </div>
      ) : (
        <>
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
            <Button type="submit" disabled={busy || !email} className="w-full">
              {busy ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
          <p className="mt-8 text-center text-sm text-ink-400">
            Remembered it?{' '}
            <Link to="/login" className="font-semibold text-bond-600 hover:text-bond-700">
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
