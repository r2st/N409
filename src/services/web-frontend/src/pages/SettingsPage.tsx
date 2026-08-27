import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  all,
  email as emailRule,
  matches,
  required,
  useFormValidation,
  password as passwordRule,
} from '../lib/useFormValidation';
import { PASSWORD_HINT } from '../lib/passwordPolicy';
import { api, ApiError, apiDownload, tokenExpiry } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { useAuth } from '../lib/auth';
import { canManageUsers, isOps, isPartner, scopeLabel } from '../lib/rbac';
import { displayName, formatDateTime, initials } from '../lib/format';
import type { ApiToken, User } from '../lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  ListTruncationNote,
  Select,
  Spinner,
  TextInput,
} from '../components/ui';
import { PhoneInput, phoneFieldError } from '../components/PhoneInput';
import { MfaCard } from '../components/MfaCard';
import { ThemeToggle } from '../components/ThemeToggle';

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 className="overline mb-1 text-ink-400">{title}</h2>
      {description && <p className="mb-4 text-sm text-ink-400">{description}</p>}
      <div className={description ? '' : 'mt-4'}>{children}</div>
    </section>
  );
}

function SavedNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
      {children}
    </div>
  );
}

/**
 * The browser's own tz database, so the list can't drift from what the API
 * accepts (it validates against the same source via Intl).
 */
function timezoneOptions(): string[] {
  const supported = Intl.supportedValuesOf?.('timeZone');
  return supported?.length ? [...supported] : [Intl.DateTimeFormat().resolvedOptions().timeZone];
}

/** Self-service profile: name, contact details, company, time zone. */
function ProfileCard() {
  const { user, setUser } = useAuth();
  const [form, setForm] = useState(() => ({
    first_name: user?.first_name ?? '',
    last_name: user?.last_name ?? '',
    phone: user?.phone ?? '',
    job_title: user?.job_title ?? '',
    company_name: user?.company_name ?? '',
    timezone: user?.timezone ?? '',
  }));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * The phone box used to carry its own `phoneTouched` flag and an early return
   * in the submit handler — which is the hook's whole job, written out once.
   * The API rejects a non-E.164 number with a 422; this says so next to the
   * field instead, as it did before.
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(form, {
    phone: (v) => phoneFieldError(String(v.phone ?? '')),
  });

  if (!user) return null;
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setSaved(false);
  };

  const submit = handleSubmit(async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const res = await api<{ user: User }>('/me', { method: 'PATCH', body: form });
      setUser(res.user);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your profile.');
    } finally {
      setBusy(false);
    }
  });

  return (
    <Card title="Profile" description="How your name appears on reports and in comment threads.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <ErrorNote>{error}</ErrorNote>
        {saved && <SavedNote>Profile updated.</SavedNote>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name">
            <TextInput value={form.first_name} onChange={set('first_name')} maxLength={100} />
          </Field>
          <Field label="Last name">
            <TextInput value={form.last_name} onChange={set('last_name')} maxLength={100} />
          </Field>
          <Field label="Company">
            <TextInput value={form.company_name} onChange={set('company_name')} maxLength={200} />
          </Field>
          <Field label="Job title">
            <TextInput value={form.job_title} onChange={set('job_title')} maxLength={150} />
          </Field>
          <Field label="Phone" error={errorFor('phone')} hint="Used for SMS notifications.">
            <PhoneInput
              value={form.phone}
              onChange={(phone) => {
                setForm((f) => ({ ...f, phone }));
                setSaved(false);
              }}
              onBlur={blurHandler('phone')}
            />
          </Field>
          <Field label="Time zone" hint="Used for dates and deadlines.">
            <Select value={form.timezone} onChange={set('timezone')}>
              <option value="">Use my browser's time zone</option>
              {timezoneOptions().map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </Button>
      </form>
    </Card>
  );
}

/** Changing the login email is a credential change — it re-authenticates. */
function ChangeEmailCard() {
  const { user, setUser } = useAuth();
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * The form carried `noValidate` and both boxes carried `required`, so
   * between them nothing checked anything: a malformed address went to the
   * API and came back a 422 banner. R28 fixed eight forms in this shape and
   * missed the four on this page.
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(
    { email, password },
    {
      email: emailRule('email'),
      password: required('password', 'Current password'),
    },
  );

  const submit = handleSubmit(async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const res = await api<{ user: User }>('/me', {
        method: 'PATCH',
        body: { email, current_password: password },
      });
      setUser(res.user);
      setPassword('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change your email.');
    } finally {
      setBusy(false);
    }
  });

  /*
   * Below every hook, not above them. `useFormValidation` used to sit under
   * this guard, which made the component's hook count depend on whether a user
   * was in context — a render with none would have run fewer hooks than the
   * one before it, which React treats as a fatal error rather than a missing
   * card. It is not reachable today (`RequireAuth` is an ancestor and swaps the
   * whole subtree for a redirect in the same render that clears the user), so
   * this is closing the hole rather than fixing a live crash. There is no cost
   * to being right about it: the guard reads the same here.
   */
  if (!user) return null;

  return (
    <Card
      title="Email address"
      description="This is how you sign in and where password resets are sent. Changing it means verifying the new address."
    >
      <form onSubmit={submit} className="max-w-sm space-y-4" noValidate>
        <ErrorNote>{error}</ErrorNote>
        {saved && <SavedNote>Email updated. Check your inbox to verify the new address.</SavedNote>}
        <Field label="Email" error={errorFor('email')}>
          <TextInput
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={blurHandler('email')}
          />
        </Field>
        <Field
          label="Current password"
          hint="Required to change the email on your account."
          error={errorFor('password')}
        >
          <TextInput
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={blurHandler('password')}
          />
        </Field>
        {/* Still gated on the address having actually changed — that is a
            statement about the form's purpose, not a validation failure, and
            there is no message to show for it. */}
        <Button type="submit" disabled={busy || email === user.email}>
          {busy ? 'Updating…' : 'Update email'}
        </Button>
      </form>
    </Card>
  );
}

/** P0 #3 — change password for signed-in accounts (hidden for Google SSO). */
function ChangePasswordCard() {
  const { replaceToken } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * These two rules were already here, as early returns setting a banner above
   * the form — which said "New password must be at least 10 characters" without
   * indicating which of the three password boxes it meant. Same rules, attached
   * to the box each is about.
   */
  const { errorFor, blurHandler, handleSubmit, reset } = useFormValidation(
    { current, next, confirm },
    {
      current: required('current', 'Current password'),
      next: passwordRule('next', 'New password'),
      confirm: all(
        required('confirm', 'Confirmation'),
        matches('confirm', 'next', "New passwords don't match."),
      ),
    },
  );

  const submit = handleSubmit(async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const res = await api<{ token?: string }>('/auth/change-password', {
        method: 'POST',
        body: { current_password: current, new_password: next },
      });
      // The change signed out every session, this one included — adopt the
      // replacement before the next request 401s us.
      if (res.token) replaceToken(res.token);
      setCurrent('');
      setNext('');
      setConfirm('');
      setSaved(true);
      // The card stays mounted after saving, and the three boxes have just been
      // emptied — without this every "is required" message reappears at once
      // on a form the user has finished with.
      reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  });

  return (
    <Card title="Change password">
      <form onSubmit={submit} className="max-w-sm space-y-4" noValidate>
        <ErrorNote>{error}</ErrorNote>
        {saved && <SavedNote>Password updated. Other sessions have been signed out.</SavedNote>}
        <Field label="Current password" error={errorFor('current')}>
          <TextInput
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            onBlur={blurHandler('current')}
          />
        </Field>
        <Field label="New password" hint={PASSWORD_HINT} error={errorFor('next')}>
          <TextInput
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            onBlur={blurHandler('next')}
          />
        </Field>
        <Field label="Confirm new password" error={errorFor('confirm')}>
          <TextInput
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={blurHandler('confirm')}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </Card>
  );
}

interface NotificationPreference {
  event_type: string;
  in_app: boolean;
  email: boolean;
}

const EVENT_LABELS: Record<string, string> = {
  valuation_started: 'Work started on a valuation',
  review_needed: 'A valuation needs your review',
  draft_ready: 'Draft report ready',
  changes_requested: 'Client requested changes',
  valuation_completed: 'Valuation published',
  valuation_cancelled: 'Valuation cancelled',
};

/** P2 #11 — per-event-type channel toggles, saved on change. Transactional
 * emails (password reset, invitations) always deliver and aren't listed. */
function NotificationPreferencesCard() {
  const [prefs, setPrefs] = useState<NotificationPreference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ preferences: NotificationPreference[] }>('/me/notification-preferences')
      .then((d) => setPrefs(d.preferences))
      .catch(() => setError('Could not load your notification preferences.'));
  }, []);

  const toggle = async (eventType: string, channel: 'in_app' | 'email') => {
    if (!prefs) return;
    const next = prefs.map((p) => (p.event_type === eventType ? { ...p, [channel]: !p[channel] } : p));
    setPrefs(next);
    setSaving(true);
    setError(null);
    try {
      const updated = next.find((p) => p.event_type === eventType)!;
      await api('/me/notification-preferences', {
        method: 'PUT',
        body: { preferences: [updated] },
      });
    } catch (err) {
      setPrefs(prefs); // roll the optimistic flip back
      setError(err instanceof ApiError ? err.message : 'Could not save the preference.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Notifications"
      description="Choose how you hear about each event. Account emails (password reset, invitations) are always delivered."
    >
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {!prefs && !error && <Spinner />}
      {prefs?.length === 0 && (
        <EmptyState title="No notification events">
          This account has no notification types to configure yet.
        </EmptyState>
      )}
      {prefs && prefs.length > 0 && (
        <table className="w-full text-sm" aria-label="Notification preferences">
          <thead>
            <tr className="border-b border-paper-300 text-left">
              <th className="overline py-2 font-semibold text-ink-400">Event</th>
              <th className="overline w-20 py-2 text-center font-semibold text-ink-400">In-app</th>
              <th className="overline w-20 py-2 text-center font-semibold text-ink-400">Email</th>
            </tr>
          </thead>
          <tbody>
            {prefs.map((p) => (
              <tr key={p.event_type} className="border-b border-paper-200 last:border-0">
                <td className="py-2.5 text-ink-700">{EVENT_LABELS[p.event_type] ?? p.event_type}</td>
                {(['in_app', 'email'] as const).map((channel) => (
                  <td key={channel} className="py-2.5 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${channel === 'in_app' ? 'In-app' : 'Email'} — ${EVENT_LABELS[p.event_type] ?? p.event_type}`}
                      checked={p[channel]}
                      disabled={saving}
                      onChange={() => void toggle(p.event_type, channel)}
                      className="accent-bond-600"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/**
 * Personal API tokens. Distinct from the partner keys on the partner portal:
 * these carry only the owner's own scope and are rejected by the partner API.
 */
function ApiTokensCard() {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  /**
   * Revoked tokens are kept for the audit trail, so this list only grows —
   * and a live token past the page reads as a credential nobody holds.
   */
  const [tokensTruncated, setTokensTruncated] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [minted, setMinted] = useState<{ name: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Minting a token is a credential-level action, so the server re-authenticates
   * it — same rule and same shape as closing the account below. And the same
   * exception: a Google SSO account has no password to confirm, so asking for
   * one would be a box nobody can fill.
   */
  const needsPassword = user?.sso_provider !== 'google';

  const load = () =>
    api<{ tokens: ApiToken[]; truncated: boolean }>('/me/tokens')
      .then((d) => {
        setTokens(d.tokens);
        setTokensTruncated(d.truncated);
      })
      .catch(() => setError('Could not load your API tokens.'));

  useEffect(() => {
    void load();
  }, []);

  const { errorFor, blurHandler, handleSubmit, reset } = useFormValidation(
    { name, password },
    {
      name: required('name', 'Token name'),
      password: needsPassword ? required('password', 'Password') : undefined,
    },
  );

  const create = handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ token: ApiToken; secret: string }>('/me/tokens', {
        method: 'POST',
        body: { name, current_password: password },
      });
      setMinted({ name: res.token.name, secret: res.secret });
      setName('');
      // Never leave a password sitting in a form that stays on screen.
      setPassword('');
      // The box is now empty and the form is still on screen; without this the
      // "is required" message appears the moment the token is created.
      reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the token.');
    } finally {
      setBusy(false);
    }
  });

  const revoke = async (token: ApiToken) => {
    if (!window.confirm(`Revoke "${token.name}"? Anything using it will stop working.`)) return;
    setError(null);
    try {
      await api(`/me/tokens/${token.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the token.');
    }
  };

  const live = tokens?.filter((t) => !t.revoked_at) ?? [];

  return (
    <Card
      title="API tokens"
      description="Personal tokens act as you, with your access. Send one as an Authorization: Bearer header."
    >
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {minted && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3.5">
          <p className="text-sm font-semibold text-amber-900">
            Copy “{minted.name}” now — it won't be shown again.
          </p>
          <code className="mt-2 block overflow-x-auto overscroll-x-contain rounded bg-surface px-3 py-2 font-mono text-xs text-ink-900">
            {minted.secret}
          </code>
        </div>
      )}

      {!tokens && !error && <Spinner />}
      {tokens && live.length === 0 && <p className="text-sm text-ink-400">You have no active tokens.</p>}
      {live.length > 0 && (
        <table className="w-full text-sm" aria-label="Personal API tokens">
          <thead>
            <tr className="border-b border-paper-300 text-left">
              <th className="overline py-2 font-semibold text-ink-400">Name</th>
              <th className="overline py-2 font-semibold text-ink-400">Prefix</th>
              <th className="overline py-2 font-semibold text-ink-400">Last used</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {live.map((t) => (
              <tr key={t.id} className="border-b border-paper-200 last:border-0">
                <td className="py-2.5 text-ink-700">{t.name}</td>
                <td className="tnum py-2.5 font-mono text-xs text-ink-400">{t.token_prefix}…</td>
                <td className="py-2.5 text-ink-400">
                  {t.last_used_at ? formatDateTime(t.last_used_at) : 'Never'}
                </td>
                <td className="py-2.5 text-right">
                  <Button variant="ghost" onClick={() => void revoke(t)}>
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ListTruncationNote
        truncated={tokensTruncated}
        shown={live.length}
        noun="tokens"
        hint="revoke the ones you no longer use"
      />

      <form onSubmit={create} className="mt-5 max-w-md space-y-4" noValidate>
        <Field label="New token name" error={errorFor('name')}>
          <TextInput
            required
            maxLength={200}
            placeholder="e.g. reporting script"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={blurHandler('name')}
          />
        </Field>
        {needsPassword && (
          <Field
            // Not "Confirm your password", which is what the close-account card
            // below says: two identically-labelled password boxes on one page
            // are ambiguous to a screen reader reading the form out, and to
            // anything else that finds a field by its label.
            label="Your password"
            error={errorFor('password')}
            hint="A token outlives signing out everywhere, so we check it is you before issuing one."
          >
            <TextInput
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={blurHandler('password')}
            />
          </Field>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create token'}
        </Button>
      </form>
    </Card>
  );
}

/** Session controls: expiry, sign out here, sign out everywhere. */
function SessionCard() {
  const { logout, replaceToken } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const revokeAll = async () => {
    if (!window.confirm('Sign out of every other browser and device?')) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ token: string }>('/me/sessions/revoke', { method: 'POST' });
      // This request's own token was invalidated too — adopt its successor.
      replaceToken(res.token);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign out other sessions.');
    } finally {
      setBusy(false);
    }
  };

  const exp = tokenExpiry();
  return (
    <Card
      title="Sessions"
      description="Signing out clears the session token from this browser. API tokens are unaffected — revoke those separately."
    >
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {done && (
        <div className="mb-3">
          <SavedNote>Other sessions have been signed out.</SavedNote>
        </div>
      )}
      <p className="mb-4 text-sm text-ink-400">
        This session expires{' '}
        <span className="tnum text-ink-700">{exp ? formatDateTime(new Date(exp).toISOString()) : '—'}</span>.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" disabled={busy} onClick={() => void revokeAll()}>
          {busy ? 'Signing out…' : 'Sign out everywhere else'}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          Sign out
        </Button>
      </div>
    </Card>
  );
}

/**
 * The other half of the sentence on the privacy page.
 *
 * "Request a copy or deletion of your personal data at any time" — deletion is
 * the card below, and has been self-serve for a while. The copy had nothing
 * behind it, so it happened by email and by hand. It sits above Close account
 * deliberately: taking a copy before closing an account is the order somebody
 * doing both wants, and the order they will not get if they meet the
 * irreversible one first.
 */
function DataExportCard() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setError(null);
    setBusy(true);
    try {
      await apiDownload('/me/data-export', 'n409-data-export.json');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build your export.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Download your data"
      description="A machine-readable copy of everything we hold about you: your account, your engagements, the messages you have written and the payments on your account. Credentials are named but never included."
    >
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <Button variant="secondary" disabled={busy} onClick={() => void download()}>
        {busy ? 'Preparing…' : 'Download my data (JSON)'}
      </Button>
    </Card>
  );
}

/** Irreversible from the user's side — an administrator can restore it. */
function CloseAccountCard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * The password box is not rendered for a Google SSO account — there is no
   * password to confirm — so the rule has to ask who is signed in rather than
   * demand a field that is not on screen.
   */
  const needsPassword = user?.sso_provider !== 'google';
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(
    { password },
    { password: needsPassword ? required('password', 'Password') : undefined },
  );

  const close = handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      await api('/me', { method: 'DELETE', body: { current_password: password } });
      logout();
      navigate('/login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not close your account.');
      setBusy(false);
    }
  });

  return (
    <Card
      title="Close account"
      description="You'll be signed out immediately and your API tokens will stop working. Your valuations are retained; contact support to reopen the account."
    >
      {!confirming ? (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Close my account
        </Button>
      ) : (
        <form onSubmit={close} className="max-w-sm space-y-4" noValidate>
          <ErrorNote>{error}</ErrorNote>
          {needsPassword && (
            <Field label="Confirm your password" error={errorFor('password')}>
              <TextInput
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={blurHandler('password')}
              />
            </Field>
          )}
          <div className="flex gap-3">
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? 'Closing…' : 'Permanently close account'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  if (!user) return null;

  const isSso = user.sso_provider === 'google';
  const accessTag = isOps(user) ? 'Operations' : isPartner(user) ? 'Partner' : 'Client';

  return (
    <div className="max-w-2xl">
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Account
        <HelpIcon article="settings-overview" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Settings</h1>

      <section className="mt-8 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-bond-700 text-lg font-bold text-paper-50">
            {initials(user)}
          </div>
          <div>
            <div className="font-display text-xl font-semibold text-ink-900">{displayName(user)}</div>
            <div className="text-sm text-ink-400">{user.email}</div>
          </div>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-paper-200 pt-6 sm:grid-cols-3">
          <div>
            <dt className="overline text-ink-400">Access</dt>
            <dd className="mt-1 text-sm text-ink-900">{accessTag}</dd>
          </div>
          <div>
            <dt className="overline text-ink-400">Data scope</dt>
            <dd className="mt-1 text-sm text-ink-900">{scopeLabel(user)}</dd>
          </div>
          <div>
            <dt className="overline text-ink-400">Sign-in</dt>
            <dd className="mt-1 text-sm text-ink-900">{isSso ? 'Google SSO' : 'Email & password'}</dd>
          </div>
          <div>
            <dt className="overline text-ink-400">Email verified</dt>
            <dd className="mt-1 text-sm text-ink-900">{user.verified ? 'Yes' : 'Not yet'}</dd>
          </div>
          {user.partner_id && (
            <div>
              <dt className="overline text-ink-400">Partner</dt>
              <dd className="tnum mt-1 text-sm text-ink-900">{user.partner_id}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Roles</h2>
        <div className="flex flex-wrap gap-2">
          {user.roles.map((r) => (
            <span
              key={r}
              className="rounded-full border border-ink-200 bg-paper-50 px-3 py-1 font-mono text-xs font-semibold text-ink-700"
            >
              {r}
            </span>
          ))}
          {user.roles.length === 0 && <span className="text-sm text-ink-400">No roles assigned.</span>}
        </div>
        {canManageUsers(user) && (
          <p className="mt-4 text-sm text-ink-400">
            You can administer users, roles, partners and system settings.
          </p>
        )}
      </section>

      <Card
        title="Appearance"
        description="System follows your operating system's light/dark setting. The choice is stored on this device."
      >
        <ThemeToggle />
      </Card>

      <ProfileCard />
      {/* Google owns the email on an SSO account, and there's no password to
          re-authenticate the change with. */}
      {!isSso && <ChangeEmailCard />}
      <NotificationPreferencesCard />
      <ApiTokensCard />
      {!isSso && <ChangePasswordCard />}
      {!isSso && <MfaCard />}
      <SessionCard />
      <DataExportCard />
      <CloseAccountCard />
    </div>
  );
}
