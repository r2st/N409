import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';
import { useAuth } from '../../lib/auth';
import { api, describeActionFailure } from '../../lib/api';
import type { AuthProviders, PublicSystemSettings } from '../../lib/types';
import { Button, ErrorNote, Field, TextInput } from '../../components/ui';
import {
  email as emailRule,
  password as passwordRule,
  required,
  useFormValidation,
} from '../../lib/useFormValidation';
import { PASSWORD_HINT } from '../../lib/passwordPolicy';
import { SignedInHandoff, handOffAfterSignIn } from '../../components/SignedInHandoff';

const GOLD = '#F0B429';
const GOLD_LIGHT = '#F7CC5F';
const GOLD_DARK = '#D4A017';

const VALUE_PROPS = [
  'AI-powered valuations',
  'IRC §409A compliant',
  'Reports in 24 hours',
  'Analyst-reviewed',
];

const DOAIDE_PRODUCTS = [
  { name: 'Desk', url: 'https://desk.doaide.com' },
  { name: 'Jobs', url: 'https://job.doaide.com' },
  { name: '409', url: 'https://409.doaide.com' },
  { name: 'GST', url: 'https://gst.doaide.com' },
  { name: 'Pulse', url: 'https://pulse.doaide.com' },
  { name: 'Med', url: 'https://med.doaide.com' },
  { name: 'Realty', url: 'https://realty.doaide.com' },
  { name: 'Reach', url: 'https://reach.doaide.com' },
  { name: 'Trade', url: 'https://trade.doaide.com' },
  { name: 'Cortex', url: 'https://cortex.doaide.com' },
];

function RobotFace({ size = 32 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <line x1="16" y1="6" x2="16" y2="2" stroke={GOLD} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="1.5" r="1.5" fill={GOLD} />
      <rect x="5" y="6" width="22" height="17" rx="5" fill={GOLD} />
      <ellipse cx="11" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
      <ellipse cx="21" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
      <circle cx="11.5" cy="12.5" r="1" fill={GOLD_LIGHT} />
      <circle cx="21.5" cy="12.5" r="1" fill={GOLD_LIGHT} />
      <path d="M12 19Q16 22 20 19" stroke="#0A0A0B" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <rect x="1" y="10" width="4" height="5" rx="2" fill={GOLD_DARK} />
      <rect x="27" y="10" width="4" height="5" rx="2" fill={GOLD_DARK} />
    </svg>
  );
}

function HeroRobot() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100" width="120" height="100" className="landing-hero-robot" aria-hidden="true">
      <defs>
        <linearGradient id="robot-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={GOLD} />
          <stop offset="100%" stopColor={GOLD_LIGHT} />
        </linearGradient>
      </defs>
      <line x1="60" y1="18" x2="60" y2="6" stroke={GOLD} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="60" cy="4" r="3" fill={GOLD_LIGHT} className="landing-antenna-glow" />
      <rect x="25" y="18" width="70" height="55" rx="16" fill="url(#robot-gold)" />
      <ellipse cx="42" cy="40" rx="8" ry="10" fill="#0A0A0B" />
      <ellipse cx="78" cy="40" rx="8" ry="10" fill="#0A0A0B" />
      <circle cx="44" cy="38" r="3" fill={GOLD_LIGHT} opacity="0.7" />
      <circle cx="80" cy="38" r="3" fill={GOLD_LIGHT} opacity="0.7" />
      <path d="M45 60 Q60 72 75 60" stroke="#0A0A0B" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <rect x="5" y="30" width="16" height="18" rx="6" fill={GOLD_DARK} />
      <rect x="99" y="30" width="16" height="18" rx="6" fill={GOLD_DARK} />
    </svg>
  );
}

function PipelineGraphic() {
  return (
    <div className="landing-pipeline" aria-hidden="true">
      <svg viewBox="0 0 440 80" xmlns="http://www.w3.org/2000/svg" className="landing-pipeline-svg">
        <defs>
          <filter id="pipe-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="pipe-line-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={GOLD} stopOpacity="0.3" />
            <stop offset="50%" stopColor={GOLD} stopOpacity="0.6" />
            <stop offset="100%" stopColor={GOLD} stopOpacity="0.3" />
          </linearGradient>
        </defs>

        {/* Connecting lines */}
        <line x1="100" y1="40" x2="150" y2="40" stroke="url(#pipe-line-grad)" strokeWidth="1.5" />
        <line x1="210" y1="40" x2="260" y2="40" stroke="url(#pipe-line-grad)" strokeWidth="1.5" />
        <line x1="320" y1="40" x2="370" y2="40" stroke="url(#pipe-line-grad)" strokeWidth="1.5" />

        {/* Flowing dots — 3 sets staggered */}
        {[0, 1, 2].map((set) => (
          <g key={set}>
            <circle r="2.5" fill={GOLD} filter="url(#pipe-glow)">
              <animateMotion dur="4s" begin={`${set * 1.33}s`} repeatCount="indefinite">
                <mpath href="#pipe-path-1" />
              </animateMotion>
            </circle>
            <circle r="2.5" fill={GOLD} filter="url(#pipe-glow)">
              <animateMotion dur="4s" begin={`${set * 1.33}s`} repeatCount="indefinite">
                <mpath href="#pipe-path-2" />
              </animateMotion>
            </circle>
            <circle r="2.5" fill={GOLD} filter="url(#pipe-glow)">
              <animateMotion dur="4s" begin={`${set * 1.33}s`} repeatCount="indefinite">
                <mpath href="#pipe-path-3" />
              </animateMotion>
            </circle>
          </g>
        ))}

        {/* Hidden motion paths */}
        <path id="pipe-path-1" d="M100,40 L150,40" fill="none" stroke="none" />
        <path id="pipe-path-2" d="M210,40 L260,40" fill="none" stroke="none" />
        <path id="pipe-path-3" d="M320,40 L370,40" fill="none" stroke="none" />

        {/* Stage 1: Intake */}
        <g className="landing-pipeline-stage">
          <rect x="20" y="12" width="80" height="56" rx="10" fill="rgba(16,16,18,0.8)" stroke={GOLD} strokeWidth="0.8" strokeOpacity="0.4" />
          <rect x="20" y="12" width="80" height="56" rx="10" fill="none" className="landing-pipeline-stage-glow" />
          {/* Document icon */}
          <rect x="48" y="22" width="14" height="18" rx="2" fill="none" stroke={GOLD_LIGHT} strokeWidth="1.2" />
          <path d="M56,22 L56,27 L62,27" fill="none" stroke={GOLD_LIGHT} strokeWidth="1" />
          <line x1="51" y1="31" x2="59" y2="31" stroke={GOLD_LIGHT} strokeWidth="0.8" opacity="0.6" />
          <line x1="51" y1="34" x2="57" y2="34" stroke={GOLD_LIGHT} strokeWidth="0.8" opacity="0.6" />
          <text x="60" y="54" textAnchor="middle" fill={GOLD_LIGHT} fontSize="9" fontFamily="'IBM Plex Mono', monospace" opacity="0.9">Intake</text>
        </g>

        {/* Stage 2: Compute */}
        <g className="landing-pipeline-stage">
          <rect x="130" y="12" width="80" height="56" rx="10" fill="rgba(16,16,18,0.8)" stroke={GOLD} strokeWidth="0.8" strokeOpacity="0.4" />
          <rect x="130" y="12" width="80" height="56" rx="10" fill="none" className="landing-pipeline-stage-glow" />
          {/* AI/Gear icon */}
          <circle cx="170" cy="30" r="8" fill="none" stroke={GOLD_LIGHT} strokeWidth="1.2" />
          <circle cx="170" cy="30" r="3" fill="none" stroke={GOLD_LIGHT} strokeWidth="0.8" />
          {/* Gear teeth */}
          {[0, 60, 120, 180, 240, 300].map((deg) => (
            <line
              key={deg}
              x1={170 + 7 * Math.cos((deg * Math.PI) / 180)}
              y1={30 + 7 * Math.sin((deg * Math.PI) / 180)}
              x2={170 + 10 * Math.cos((deg * Math.PI) / 180)}
              y2={30 + 10 * Math.sin((deg * Math.PI) / 180)}
              stroke={GOLD_LIGHT}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          ))}
          <text x="170" y="54" textAnchor="middle" fill={GOLD_LIGHT} fontSize="9" fontFamily="'IBM Plex Mono', monospace" opacity="0.9">Compute</text>
        </g>

        {/* Stage 3: Review */}
        <g className="landing-pipeline-stage">
          <rect x="240" y="12" width="80" height="56" rx="10" fill="rgba(16,16,18,0.8)" stroke={GOLD} strokeWidth="0.8" strokeOpacity="0.4" />
          <rect x="240" y="12" width="80" height="56" rx="10" fill="none" className="landing-pipeline-stage-glow" />
          {/* Checkmark icon */}
          <circle cx="280" cy="30" r="8" fill="none" stroke={GOLD_LIGHT} strokeWidth="1.2" />
          <path d="M274,30 L278,34 L286,26" fill="none" stroke={GOLD_LIGHT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <text x="280" y="54" textAnchor="middle" fill={GOLD_LIGHT} fontSize="9" fontFamily="'IBM Plex Mono', monospace" opacity="0.9">Review</text>
        </g>

        {/* Stage 4: Report */}
        <g className="landing-pipeline-stage">
          <rect x="350" y="12" width="80" height="56" rx="10" fill="rgba(16,16,18,0.8)" stroke={GOLD} strokeWidth="0.8" strokeOpacity="0.4" />
          <rect x="350" y="12" width="80" height="56" rx="10" fill="none" className="landing-pipeline-stage-glow" />
          {/* Chart/report icon */}
          <rect x="378" y="22" width="14" height="18" rx="2" fill="none" stroke={GOLD_LIGHT} strokeWidth="1.2" />
          <polyline points="381,36 384,32 387,34 389,28" fill="none" stroke={GOLD_LIGHT} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          <text x="390" y="54" textAnchor="middle" fill={GOLD_LIGHT} fontSize="9" fontFamily="'IBM Plex Mono', monospace" opacity="0.9">Report</text>
        </g>
      </svg>
    </div>
  );
}

function ValueCycle() {
  const [index, setIndex] = useState(0);
  const [displayText, setDisplayText] = useState('');
  const [phase, setPhase] = useState<'typing' | 'hold' | 'erasing'>('typing');
  const charRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const tick = useCallback(() => {
    const target = VALUE_PROPS[index] ?? '';
    if (phase === 'typing') {
      charRef.current += 1;
      setDisplayText(target.slice(0, charRef.current));
      if (charRef.current >= target.length) {
        setPhase('hold');
        timerRef.current = setTimeout(() => setPhase('erasing'), 2200);
        return;
      }
      timerRef.current = setTimeout(tick, 50 + Math.random() * 30);
    } else if (phase === 'erasing') {
      charRef.current -= 1;
      setDisplayText(target.slice(0, charRef.current));
      if (charRef.current <= 0) {
        setPhase('typing');
        setIndex((i) => (i + 1) % VALUE_PROPS.length);
        timerRef.current = setTimeout(tick, 400);
        return;
      }
      timerRef.current = setTimeout(tick, 25);
    }
  }, [index, phase]);

  useEffect(() => {
    timerRef.current = setTimeout(tick, phase === 'hold' ? 0 : 80);
    return () => clearTimeout(timerRef.current);
  }, [tick, phase]);

  const current = VALUE_PROPS[index] ?? '';
  const progress = (index + (phase === 'hold' ? 1 : phase === 'erasing' ? 0.5 : displayText.length / (current.length || 1))) / VALUE_PROPS.length;

  return (
    <div className="landing-value-cycle">
      <div className="landing-value-text" aria-live="polite" aria-label={current}>
        <span className="landing-value-typed">{displayText}</span>
        <span className="landing-value-cursor" />
      </div>
      <div className="landing-value-track">
        <div className="landing-value-progress" style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="landing-value-dots">
        {VALUE_PROPS.map((_, i) => (
          <span key={i} className={`landing-value-dot${i === index ? ' landing-value-dot-active' : ''}`} />
        ))}
      </div>
    </div>
  );
}

const SSO_ERROR_MESSAGES: Record<string, string> = {
  not_configured:
    'Single sign-on is not set up for this workspace. Sign in with your email and password, or ask your administrator to enable SSO.',
  invalid_request:
    'That sign-in attempt did not arrive complete — it may have been left open too long. Start again from the sign-in form.',
  assertion_rejected:
    'Your identity provider\'s response could not be verified. Try again; if it keeps happening, your administrator will need to check the SSO certificate.',
  assertion_reused:
    'That sign-in response has already been used. Try again rather than reloading or going back.',
  no_email:
    'Your identity provider did not send an email address, which DoAide 409A needs to identify your account. Ask your administrator to release the email attribute.',
  email_unverified:
    'Google has not confirmed the email address on that account. Verify it with Google, then try again.',
  domain_not_allowed:
    'Single sign-on here is restricted to a different email domain. Sign in with the address your firm issued you.',
  account_deactivated: 'This account has been deactivated. Your administrator can restore it.',
  registration_closed:
    'There is no DoAide 409A account for that address, and this platform is invitation-only. Ask an administrator to invite you.',
  provider_error:
    'We could not finish signing you in with that provider. Try again in a moment; if it keeps happening, contact support.',
};
const SSO_ERROR_FALLBACK =
  'Single sign-on did not complete. Try again, or sign in with your email and password.';

export const COMPANY_HINT_KEY = 'n409.company_hint';

function GoogleButton() {
  return (
    <a
      href="/api/v1/auth/google"
      className="landing-social-btn"
    >
      <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.7 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.5 17.7 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.4 6.9-17.7z" />
        <path fill="#FBBC05" d="M10.5 28.6a14.5 14.5 0 0 1 0-9.2l-7.9-6.2a24 24 0 0 0 0 21.6l7.9-6.2z" />
        <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.6l-7.7-6c-2.1 1.4-4.8 2.3-7.5 2.3-6.3 0-11.6-4-13.5-9.6l-7.9 6.2C6.5 42.6 14.6 48 24 48z" />
      </svg>
      Continue with Google
    </a>
  );
}

function LoginForm({ onMfa }: { onMfa: (challenge: string) => void }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [providersFailed, setProvidersFailed] = useState(false);
  const ssoErrorCode = new URLSearchParams(location.search).get('sso_error');
  const ssoError = ssoErrorCode
    ? Object.hasOwn(SSO_ERROR_MESSAGES, ssoErrorCode)
      ? SSO_ERROR_MESSAGES[ssoErrorCode]
      : SSO_ERROR_FALLBACK
    : null;

  const credentials = useFormValidation(
    { email, password },
    { email: emailRule('email'), password: required('password', 'Password') },
  );

  useEffect(() => {
    api<AuthProviders>('/auth/providers')
      .then(setProviders)
      .catch(() => setProvidersFailed(true));
  }, []);

  const goHome = () =>
    handOffAfterSignIn((location.state as { from?: string } | null)?.from ?? '/', navigate);

  const submit = credentials.handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await login(email, password);
      if (result.mfaRequired) {
        onMfa(result.challenge);
      } else {
        goHome();
      }
    } catch (err) {
      setError(describeActionFailure(err, 'Unable to sign in — please try again.'));
    } finally {
      setBusy(false);
    }
  });

  return (
    <>
      <form onSubmit={submit} className="space-y-4" noValidate>
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
        <div className="-mt-1 text-right">
          <Link to="/forgot-password" className="text-xs font-semibold text-[var(--gold)] hover:text-[var(--gold-dark)]">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" disabled={busy} className="landing-submit-btn w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {providersFailed && (
        <p className="mt-4 rounded-md border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-300">
          We couldn't load the other ways to sign in. If your firm uses Google or SSO, reload to try again.
        </p>
      )}

      {(providers?.google || providers?.saml) && (
        <>
          <div className="landing-divider">
            <span className="landing-divider-line" />
            <span className="landing-divider-text">or</span>
            <span className="landing-divider-line" />
          </div>
          {providers?.google && <GoogleButton />}
          {providers?.saml && (
            <a href="/api/v1/auth/saml/login" className="landing-social-btn mt-2">
              Sign in with SSO
            </a>
          )}
        </>
      )}
    </>
  );
}

function RegisterForm() {
  const { register } = useAuth();
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    company: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openToSignup, setOpenToSignup] = useState<boolean | null>(null);
  const [supportEmail, setSupportEmail] = useState<string | null>(null);
  const [destination, setDestination] = useState('/dashboard');
  const { status } = useAuth();

  const { errorFor, blurHandler, handleSubmit } = useFormValidation(form, {
    email: emailRule('email', 'Work email'),
    password: passwordRule('password'),
  });

  useEffect(() => {
    api<{ settings: PublicSystemSettings }>('/public/settings')
      .then(({ settings }) => {
        setOpenToSignup(settings.registration_enabled);
        setSupportEmail(settings.support_email);
      })
      .catch(() => setOpenToSignup(true));
  }, []);

  if (status === 'authenticated') return <SignedInHandoff to={destination} />;

  if (openToSignup === false) {
    return (
      <div className="text-center">
        <p className="text-sm text-[var(--text-muted)]">
          Registration is closed. New accounts are by invitation only.
        </p>
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Reach us at{' '}
          <a
            href={`mailto:${supportEmail ?? 'support@409.ai'}`}
            className="font-semibold text-[var(--gold)] hover:text-[var(--gold-dark)]"
          >
            {supportEmail ?? 'support@409.ai'}
          </a>
        </p>
      </div>
    );
  }

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = handleSubmit(async () => {
    setError(null);
    setBusy(true);
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
      setError(describeActionFailure(err, 'Unable to register — please try again.'));
    } finally {
      setBusy(false);
    }
  });

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <ErrorNote>{error}</ErrorNote>
      <div className="grid grid-cols-2 gap-3">
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
      <Field label="Company" hint="The company you'll be valuing.">
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
      <Field label="Password" hint={PASSWORD_HINT} error={errorFor('password')}>
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
      <Button type="submit" disabled={busy} className="landing-submit-btn w-full">
        {busy ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}

function MfaForm({
  challenge,
  onBack,
}: {
  challenge: string;
  onBack: () => void;
}) {
  const { verifyMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const secondFactor = useFormValidation(
    { code },
    { code: required('code', useBackup ? 'Backup code' : 'Authenticator code') },
  );

  const submitCode = secondFactor.handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      await verifyMfa({
        challenge,
        code: useBackup ? undefined : code.trim(),
        backupCode: useBackup ? code.trim() : undefined,
        rememberDevice,
      });
      handOffAfterSignIn(
        (location.state as { from?: string } | null)?.from ?? '/',
        navigate,
      );
    } catch (err) {
      setError(describeActionFailure(err, 'That code was not accepted.'));
    } finally {
      setBusy(false);
    }
  });

  return (
    <div>
      <h2 className="text-lg font-semibold text-[var(--text)] mb-1">Two-factor authentication</h2>
      <p className="text-xs text-[var(--text-muted)] mb-5">Enter the code from your authenticator app.</p>
      <form onSubmit={submitCode} className="space-y-4" noValidate>
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
        <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={rememberDevice}
            onChange={(e) => setRememberDevice(e.target.checked)}
          />
          Remember this device for 30 days
        </label>
        <Button type="submit" disabled={busy} className="landing-submit-btn w-full">
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
        <div className="flex items-center justify-between">
          <button
            type="button"
            className="text-xs font-semibold text-[var(--gold)] hover:text-[var(--gold-dark)]"
            onClick={() => {
              setUseBackup((v) => !v);
              setCode('');
              setError(null);
            }}
          >
            {useBackup ? 'Use authenticator app' : 'Use a backup code'}
          </button>
          <button
            type="button"
            className="text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text)]"
            onClick={onBack}
          >
            Back to sign in
          </button>
        </div>
      </form>
    </div>
  );
}

export function LandingPage() {
  const [visible, setVisible] = useState(false);
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const initialTab = searchParams.get('tab') === 'register'
    || location.pathname === '/register' ? 'register' : 'login';
  const [activeTab, setActiveTab] = useState<'login' | 'register'>(initialTab);
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(
    (location.state as { mfaChallenge?: string } | null)?.mfaChallenge ?? null,
  );
  const { status } = useAuth();

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    return <SignedInHandoff to={from ?? '/'} />;
  }

  const cls = visible ? ' landing-visible' : '';

  return (
    <div className="landing-root">
      <Seo {...pageMeta('/')!} />

      {/* Animated background */}
      <div className="landing-bg">
        <div className="landing-orb landing-orb-1" />
        <div className="landing-orb landing-orb-2" />
        <div className="landing-orb landing-orb-3" />
      </div>

      <div className="landing-split">
        {/* ── LEFT HALF: Product info ── */}
        <div className={`landing-left${cls}`}>
          {/* Floating golden particles */}
          <div className="landing-particles">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="landing-particle" />
            ))}
          </div>

          <div className="landing-left-inner">
            {/* Brand */}
            <div className="landing-brand">
              <RobotFace size={28} />
              <span className="landing-brand-text">
                Do<em>Aide</em> 409A
              </span>
            </div>

            {/* Hero */}
            <div className="landing-hero-area">
              <h1 className="landing-title">
                <span className="landing-title-gold">409A</span> valuations,<br />simplified.
              </h1>
              <p className="landing-subtitle">
                AI-assisted intake, engine-computed, analyst-reviewed.
              </p>
              <PipelineGraphic />
            </div>

            {/* Animated value props */}
            <ValueCycle />

            {/* Footer */}
            <footer className="landing-footer">
              <div className="landing-footer-products">
                {DOAIDE_PRODUCTS.map((p) => (
                  <a key={p.name} href={p.url} className="landing-footer-link" target="_blank" rel="noopener noreferrer">
                    {p.name}
                  </a>
                ))}
              </div>
              <div className="landing-footer-bottom">
                <a href="https://doaide.com" className="landing-footer-home" target="_blank" rel="noopener noreferrer">
                  <RobotFace size={14} />
                  doaide.com
                </a>
                <span className="landing-footer-copy">© {new Date().getFullYear()} DoAide</span>
              </div>
            </footer>
          </div>
        </div>

        {/* ── RIGHT HALF: Auth forms ── */}
        <div className={`landing-right${cls}`}>
          <div className="landing-auth-card">
            {/* Mobile-only brand */}
            <div className="landing-mobile-brand">
              <RobotFace size={24} />
              <span className="landing-brand-text">
                Do<em>Aide</em> 409A
              </span>
            </div>

            {mfaChallenge ? (
              <MfaForm
                challenge={mfaChallenge}
                onBack={() => setMfaChallenge(null)}
              />
            ) : (
              <>
                {/* Tab toggle */}
                <div className="landing-tabs">
                  <button
                    type="button"
                    className={`landing-tab${activeTab === 'login' ? ' landing-tab-active' : ''}`}
                    onClick={() => setActiveTab('login')}
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    className={`landing-tab${activeTab === 'register' ? ' landing-tab-active' : ''}`}
                    onClick={() => setActiveTab('register')}
                  >
                    Create account
                  </button>
                </div>

                {/* Forms — key forces re-mount for fade-in animation */}
                <div key={activeTab} className="landing-form-area">
                  {activeTab === 'login' ? (
                    <LoginForm onMfa={setMfaChallenge} />
                  ) : (
                    <RegisterForm />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
