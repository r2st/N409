import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { email as emailRule, required, useFormValidation } from '../lib/useFormValidation';
import { api, describeActionFailure } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AuthProviders } from '../lib/types';
import { AuthShell } from '../components/AuthShell';
import { Button, ErrorNote, Field, TextInput } from '../components/ui';
import { SignedInHandoff, handOffAfterSignIn } from '../components/SignedInHandoff';

/**
 * The sentences behind `?sso_error=…`.
 *
 * A refusal in either identity-provider flow used to end at the API's problem
 * body, rendered as text in the browser window the person was signing in
 * through. `refuseSso` (`services/valuation/src/auth/ssoRefusal.ts`) now sends
 * them back here with a code, and this is where the code becomes something to
 * read. Keys are that module's `SSO_REFUSAL_CODES`; `ssoRefusalCodes.test.ts`
 * holds the two lists to each other.
 *
 * The code is read from the URL and is therefore whatever a visitor typed, so
 * it is looked up and never rendered: an unknown one gets the general
 * sentence rather than being echoed back onto the page.
 *
 * Every sentence names what to do next, because on this screen the reader
 * usually cannot fix the cause — half of these are settings inside their own
 * firm's identity provider, and the remedy is a person, not a button.
 */
const SSO_ERROR_MESSAGES: Record<string, string> = {
  not_configured:
    'Single sign-on is not set up for this workspace. Sign in with your email and password, or ask your administrator to enable SSO.',
  invalid_request:
    'That sign-in attempt did not arrive complete — it may have been left open too long. Start again from the sign-in button below.',
  assertion_rejected:
    ‘Your identity provider’s response could not be verified. Start again below; if it keeps happening, your administrator will need to check the SSO certificate in DoAide 409A.’,
  assertion_reused:
    'That sign-in response has already been used. Start again below rather than reloading or going back.',
  no_email:
    'Your identity provider did not send an email address, which DoAide 409A needs to identify your account. Ask your administrator to release the email attribute.',
  email_unverified:
    'Google has not confirmed the email address on that account. Verify it with Google, then try again.',
  domain_not_allowed:
    'Single sign-on here is restricted to a different email domain. Sign in with the address your firm issued you, or ask your administrator which domain is allowed.',
  account_deactivated: 'This account has been deactivated in DoAide 409A. Your administrator can restore it.',
  registration_closed:
    'There is no DoAide 409A account for that address, and this platform is invitation-only — signing in with Google does not create one. Ask an administrator to invite you.',
  provider_error:
    'We could not finish signing you in with that provider. Try again in a moment; if it keeps happening, contact support.',
};

/** The general sentence, for a code this build does not know. */
const SSO_ERROR_FALLBACK =
  'Single sign-on did not complete. Try again below, or sign in with your email and password.';

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
  const [providersFailed, setProvidersFailed] = useState(false);
  /*
   * Second-factor step: set once the password step returns a challenge — or
   * handed to us by `GoogleCompletePage`, which is where an SSO hand-off lands.
   *
   * Since R354 both SSO doors answer a 2FA-enabled account with a challenge
   * rather than a session, exactly as the password door does. The redirect
   * carries it in the fragment and that page routes here with it in `state`,
   * so the code is collected by the one screen that knows how to.
   */
  const [challenge, setChallenge] = useState<string | null>(
    (location.state as { mfaChallenge?: string } | null)?.mfaChallenge ?? null,
  );
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(false);
  const ssoErrorCode = new URLSearchParams(location.search).get('sso_error');
  /*
   * `Object.hasOwn`, not a bare lookup: the code is whatever the query string
   * carries, and every object answers to `__proto__`, `constructor` and
   * `toString`. A bare lookup handed `Object.prototype` — an object, which
   * React refuses to render — to `ErrorNote` below, so
   * `/login?sso_error=__proto__` took the sign-in page down for anyone who
   * followed the link.
   */
  const ssoError = ssoErrorCode
    ? Object.hasOwn(SSO_ERROR_MESSAGES, ssoErrorCode)
      ? SSO_ERROR_MESSAGES[ssoErrorCode]
      : SSO_ERROR_FALLBACK
    : null;

  /*
   * Which doors exist, and what to say when we could not find out.
   *
   * The failure used to substitute `{ password: true, google: false }` — an
   * answer nobody gave, asserting that the password box below is the only way
   * in. R267 fixed the server's half of exactly this: the route logs when it
   * cannot read the SAML configuration, because `saml: false` "is not 'we could
   * not tell' — the SPA reads it as a fact and draws no SSO button, so an
   * organisation whose people sign in *only* through their IdP is shown a
   * password field for a password they were never issued". The browser was
   * fabricating the same claim one layer up, out of a request that never
   * arrived, and with no log or banner anywhere.
   *
   * Nothing here can know whether the missing button existed, so the page says
   * so rather than deciding. The password form is untouched and still works for
   * everyone it works for.
   */
  useEffect(() => {
    api<AuthProviders>('/auth/providers')
      .then(setProviders)
      .catch(() => setProvidersFailed(true));
  }, []);

  /*
   * Both forms' validation is declared here, above every early return below —
   * hooks cannot be called conditionally, and this component returns early
   * three times (authenticated, MFA challenge, the sign-in form).
   *
   * The password rule is `required` and nothing more. A length rule here would
   * be wrong twice over: it tells an attacker what the policy is, and it locks
   * out an account whose password predates the current one.
   */
  const credentials = useFormValidation(
    { email, password },
    { email: emailRule('email'), password: required('password', 'Password') },
  );
  const secondFactor = useFormValidation(
    { code },
    { code: required('code', useBackup ? 'Backup code' : 'Authenticator code') },
  );

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    // "/" is the role-aware landing (partners → /partner, others → /dashboard).
    return <SignedInHandoff to={from ?? '/'} />;
  }

  const goHome = () =>
    handOffAfterSignIn((location.state as { from?: string } | null)?.from ?? '/', navigate);

  const submit = credentials.handleSubmit(async () => {
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
      setError(describeActionFailure(err, 'Unable to sign in — please try again.'));
    } finally {
      setBusy(false);
    }
  });

  const submitCode = secondFactor.handleSubmit(async () => {
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
      setError(describeActionFailure(err, 'That code was not accepted.'));
    } finally {
      setBusy(false);
    }
  });

  if (challenge) {
    return (
      <AuthShell title="Two-factor authentication" subtitle="Enter the code from your authenticator app.">
        <form onSubmit={submitCode} className="space-y-5" noValidate>
          <ErrorNote>{error}</ErrorNote>
          <Field
            label={useBackup ? 'Backup code' : 'Authenticator code'}
            error={secondFactor.errorFor('code')}
          >
            <TextInput
              autoFocus
              inputMode={useBackup ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onBlur={secondFactor.blurHandler('code')}
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
          <Button type="submit" disabled={busy} className="w-full">
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
        <ErrorNote>{error ?? ssoError}</ErrorNote>
        <Field label="Email" error={credentials.errorFor('email')}>
          <TextInput
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={credentials.blurHandler('email')}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Password" error={credentials.errorFor('password')}>
          <TextInput
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={credentials.blurHandler('password')}
            placeholder="••••••••••"
          />
        </Field>
        <div className="-mt-2 text-right">
          <Link to="/forgot-password" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {providersFailed && (
        <p className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
          We couldn’t load the other ways to sign in. If your firm uses Google or single sign-on, reload this
          page to try again.
        </p>
      )}

      {(providers?.google || providers?.saml) && (
        <>
          <div className="my-6 flex items-center gap-3 text-xs text-ink-400">
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
        New to DoAide 409A?{' '}
        <Link to="/register" className="font-semibold text-bond-600 hover:text-bond-700">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
