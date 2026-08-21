import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { email as emailRule, required, useFormValidation } from '../lib/useFormValidation';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorNote, Field, Spinner, TextInput } from '../components/ui';

/**
 * Improvement 8 — white-label partner login at /partner/:slug. Branding
 * (name, logo, accent colour) comes from the public branding endpoint; an
 * unknown or archived slug falls back to the standard login page.
 */

interface PublicBranding {
  name: string;
  key: string;
  brand_color: string | null;
  logo_url: string | null;
}

export function PartnerLoginPage() {
  const { slug } = useParams<{ slug: string }>();
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [branding, setBranding] = useState<PublicBranding | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!slug) return;
    fetch(`/api/v1/public/partners/${encodeURIComponent(slug)}/branding`, {
      headers: { accept: 'application/json' },
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<{ partner: PublicBranding }>;
      })
      .then((data) => setBranding(data.partner))
      .catch(() => setNotFound(true));
  }, [slug]);

  // Above the early returns: hooks cannot be called conditionally. The
  // password rule is `required` only, for the reason LoginPage gives.
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(
    { email, password },
    { email: emailRule('email'), password: required('password', 'Password') },
  );

  if (status === 'authenticated') return <Navigate to="/" replace />;
  if (notFound) return <Navigate to="/login" replace />;

  const accent = branding?.brand_color ?? '#1d4ed8';

  const submit = handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in — please try again.');
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper-100 px-5 py-10">
      <div className="w-full max-w-sm">
        {!branding ? (
          <Spinner />
        ) : (
          <div className="rounded-xl border border-paper-300 bg-surface p-8 shadow-card">
            {/* Brand accent band */}
            <div
              aria-hidden
              data-testid="brand-accent"
              className="-mx-8 -mt-8 mb-8 h-1.5 rounded-t-xl"
              style={{ backgroundColor: accent }}
            />
            <div className="flex flex-col items-center text-center">
              {branding.logo_url && (
                <img
                  src={branding.logo_url}
                  alt={`${branding.name} logo`}
                  className="mb-4 max-h-14 max-w-[180px] object-contain"
                />
              )}
              <h1 className="font-display text-2xl font-semibold text-ink-900">{branding.name}</h1>
              <p className="mt-1.5 mb-8 text-sm text-ink-400">
                Sign in to the {branding.name} valuations portal.
              </p>
            </div>

            <form onSubmit={submit} className="space-y-5" noValidate>
              <ErrorNote>{error}</ErrorNote>
              <Field label="Email" error={errorFor('email')}>
                <TextInput
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={blurHandler('email')}
                  placeholder="you@company.com"
                />
              </Field>
              <Field label="Password" error={errorFor('password')}>
                <TextInput
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={blurHandler('password')}
                  placeholder="••••••••••"
                />
              </Field>
              <div className="-mt-2 text-right">
                <Link
                  to="/forgot-password"
                  className="text-sm font-semibold text-bond-600 hover:text-bond-700"
                >
                  Forgot password?
                </Link>
              </div>
              <Button type="submit" disabled={busy} className="w-full" style={{ backgroundColor: accent }}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </div>
        )}
        <p className="mt-6 text-center text-xs text-ink-400">
          Powered by <span className="font-semibold text-ink-600">N409</span> valuations
        </p>
      </div>
    </div>
  );
}
