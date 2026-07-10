import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthShell } from '../components/AuthShell';
import type { PublicSystemSettings } from '../lib/types';
import { Button, ErrorNote, Field, TextInput } from '../components/ui';

/** The onboarding funnel is per-valuation; company name collected here seeds the first one. */
export const COMPANY_HINT_KEY = 'n409.company_hint';

export function RegisterPage() {
  const { status, register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    company: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** null until we know; the API is the authority either way. */
  const [openToSignup, setOpenToSignup] = useState<boolean | null>(null);
  const [supportEmail, setSupportEmail] = useState<string | null>(null);

  useEffect(() => {
    api<{ settings: PublicSystemSettings }>('/public/settings')
      .then(({ settings }) => {
        setOpenToSignup(settings.registration_enabled);
        setSupportEmail(settings.support_email);
      })
      // If we can't read the flag, show the form — the API still rejects the
      // POST, so the worst case is a clear error instead of a blank page.
      .catch(() => setOpenToSignup(true));
  }, []);

  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  if (openToSignup === false) {
    return (
      <AuthShell title="Registration is closed" subtitle="New accounts are currently by invitation only.">
        <p className="text-sm text-ink-400">
          If you were expecting an invitation, check your inbox — or reach us at{' '}
          <a
            href={`mailto:${supportEmail ?? 'support@409.ai'}`}
            className="font-semibold text-bond-600 hover:text-bond-700"
          >
            {supportEmail ?? 'support@409.ai'}
          </a>
          .
        </p>
        <p className="mt-8 text-center text-sm text-ink-400">
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-bond-600 hover:text-bond-700">
            Sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.password.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }
    setBusy(true);
    try {
      if (form.company.trim()) localStorage.setItem(COMPANY_HINT_KEY, form.company.trim());
      await register({
        email: form.email,
        password: form.password,
        first_name: form.first_name || undefined,
        last_name: form.last_name || undefined,
      });
      // New clients land in the guided onboarding funnel, not the worklist.
      navigate('/onboarding', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to register — please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your account" subtitle="Start your first valuation in minutes.">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <ErrorNote>{error}</ErrorNote>
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name">
            <TextInput autoComplete="given-name" value={form.first_name} onChange={set('first_name')} placeholder="Ada" />
          </Field>
          <Field label="Last name">
            <TextInput autoComplete="family-name" value={form.last_name} onChange={set('last_name')} placeholder="Lovelace" />
          </Field>
        </div>
        <Field label="Company" hint="The company you'll be valuing — you can change this later.">
          <TextInput autoComplete="organization" value={form.company} onChange={set('company')} placeholder="Acme, Inc." />
        </Field>
        <Field label="Work email">
          <TextInput
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={set('email')}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <TextInput
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={form.password}
            onChange={set('password')}
            placeholder="••••••••••"
          />
        </Field>
        <Button type="submit" disabled={busy || !form.email || !form.password} className="w-full">
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-ink-400">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-bond-600 hover:text-bond-700">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
