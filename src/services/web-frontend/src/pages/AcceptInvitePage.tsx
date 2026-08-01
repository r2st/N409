import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { User } from '../lib/types';
import { AuthShell } from '../components/AuthShell';
import { Button, ErrorNote, Field, Spinner, TextInput } from '../components/ui';

/**
 * Feature #9 — accept an admin invitation: the link's fragment carries the
 * token, the invitee sets a password and lands signed-in with their
 * pre-assigned roles/partner.
 */
export function AcceptInvitePage() {
  const { adoptToken } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'invalid' | 'form'>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-invoke guard
    ran.current = true;
    const fromFragment = new URLSearchParams(window.location.hash.slice(1)).get('token');
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    const t = fromFragment ?? fromQuery;
    if (!t) {
      setState('invalid');
      return;
    }
    // Drop the token from the URL before anything else can observe it.
    window.history.replaceState(null, '', '/accept-invite');
    setToken(t);
    api<{ email: string }>('/auth/invite-info', { method: 'POST', body: { token: t } })
      .then((info) => {
        setEmail(info.email);
        setState('form');
      })
      .catch(() => setState('invalid'));
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
      const res = await api<{ user: User; token: string }>('/auth/accept-invite', {
        method: 'POST',
        body: {
          token,
          password,
          first_name: firstName.trim() || undefined,
          last_name: lastName.trim() || undefined,
        },
      });
      await adoptToken(res.token);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — please try again.');
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return (
      <AuthShell title="Checking your invitation…" subtitle="One moment.">
        <Spinner />
      </AuthShell>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthShell title="Invitation not valid" subtitle="This link can't be used.">
        <p className="text-sm text-ink-600">
          This invitation is invalid, expired, or has been revoked. Ask your administrator to send a new one.
        </p>
        <p className="mt-8 text-center text-sm text-ink-400">
          <Link to="/login" className="font-semibold text-bond-600 hover:text-bond-700">
            Back to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Join N409"
      subtitle={
        <>
          You've been invited as <span className="font-semibold text-ink-700">{email}</span>. Set a password
          to finish creating your account.
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5" noValidate>
        <ErrorNote>{error}</ErrorNote>
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name">
            <TextInput
              autoComplete="given-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </Field>
          <Field label="Last name">
            <TextInput
              autoComplete="family-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Password" hint="At least 10 characters.">
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
        <Field label="Confirm password">
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
          {busy ? 'Creating account…' : 'Create account & sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}
