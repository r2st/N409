import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthShell } from '../components/AuthShell';
import type { PublicSystemSettings } from '../lib/types';
import { Button, ErrorNote, Field, TextInput } from '../components/ui';
import { email, minLength, useFormValidation } from '../lib/useFormValidation';

/** The onboarding funnel is per-valuation; company name collected here seeds the first one. */
export const COMPANY_HINT_KEY = 'n409.company_hint';

export function RegisterPage() {
  const { status, register } = useAuth();
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
  /**
   * Where an authenticated visitor is sent. `register()` flips the session to
   * authenticated, and React re-renders across that await — so the redirect
   * below fires *before* any navigate() in the submit handler could run. A
   * brand-new client belongs in the guided funnel, not the worklist, so the
   * destination is decided going in rather than afterwards.
   */
  const [destination, setDestination] = useState('/dashboard');

  // Above the early returns below: hooks cannot be called conditionally.
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(form, {
    email: email('email', 'Work email'),
    password: minLength('password', 10, 'Password'),
  });

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

  if (status === 'authenticated') return <Navigate to={destination} replace />;

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

  const submit = handleSubmit(async () => {
    setError(null);
    setBusy(true);
    // New clients land in the guided onboarding funnel, not the worklist.
    setDestination('/onboarding');
    try {
      if (form.company.trim()) localStorage.setItem(COMPANY_HINT_KEY, form.company.trim());
      await register({
        email: form.email,
        password: form.password,
        first_name: form.first_name || undefined,
        last_name: form.last_name || undefined,
      });
    } catch (err) {
      setDestination('/dashboard');
      setError(err instanceof ApiError ? err.message : 'Unable to register — please try again.');
    } finally {
      setBusy(false);
    }
  });

  return (
    <AuthShell title="Create your account" subtitle="Start your first valuation in minutes.">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <ErrorNote>{error}</ErrorNote>
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name">
            <TextInput
              autoComplete="given-name"
              value={form.first_name}
              onChange={set('first_name')}
              placeholder="Ada"
            />
          </Field>
          <Field label="Last name">
            <TextInput
              autoComplete="family-name"
              value={form.last_name}
              onChange={set('last_name')}
              placeholder="Lovelace"
            />
          </Field>
        </div>
        <Field label="Company" hint="The company you'll be valuing — you can change this later.">
          <TextInput
            autoComplete="organization"
            value={form.company}
            onChange={set('company')}
            placeholder="Acme, Inc."
          />
        </Field>
        <Field label="Work email" error={errorFor('email')}>
          <TextInput
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={set('email')}
            onBlur={blurHandler('email')}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Password" hint="At least 10 characters." error={errorFor('password')}>
          <TextInput
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={form.password}
            onChange={set('password')}
            onBlur={blurHandler('password')}
            placeholder="••••••••••"
          />
        </Field>
        {/*
          Not disabled on the fields being empty any more. A submit button that
          is disabled until the form is valid cannot tell anyone *why* — the
          rules are invisible and the button just does not work. It submits, and
          the submit is what reveals the messages.
        */}
        <Button type="submit" disabled={busy} className="w-full">
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
