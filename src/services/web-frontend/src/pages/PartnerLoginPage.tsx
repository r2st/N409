import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { email as emailRule, required, useFormValidation } from '../lib/useFormValidation';
import { describeActionFailure } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorNote, Field, Spinner, TextInput } from '../components/ui';
import type { Branding, BrandingResponse } from '../lib/branding';

/**
 * Improvement 8 — white-label partner login at /partner/:slug. Branding comes
 * from `/api/v1/public/branding/:key`, the resolver every other surface reads;
 * an unknown or archived slug falls back to the standard login page.
 *
 * It used to read `/api/v1/public/partners/:key/branding`, a second public
 * endpoint that predated migration 0091 and answered from the columns that
 * existed before it: the internal ops channel label instead of the firm's
 * `brand_name`, the raw `brand_color` rather than the accent lifted to be
 * legible, no `accent_fg` to put on top of it, and no `white_label_enabled` —
 * so the one page white label exists for was the one page resolving a brand a
 * different way from the application behind it, and it showed a firm's staged
 * colour and logo to the public before the firm had gone live.
 */

export function PartnerLoginPage() {
  const { slug } = useParams<{ slug: string }>();
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [branding, setBranding] = useState<Branding | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!slug) return;
    fetch(`/api/v1/public/branding/${encodeURIComponent(slug)}`, {
      headers: { accept: 'application/json' },
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<BrandingResponse>;
      })
      .then((data) => setBranding(data.branding))
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

  // The resolved pair, not a bare colour. The sign-in button is filled with
  // the accent and its label was left at the default ink, so a firm whose brand
  // is pale had a button nobody could read the words on — `accent_fg` is the
  // server's answer to exactly that and was being thrown away with the rest of
  // the resolved brand.
  const accent = branding?.accent ?? '#1d4ed8';
  const accentFg = branding?.accent_fg ?? '#ffffff';

  const submit = handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(describeActionFailure(err, 'Unable to sign in — please try again.'));
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
              <Button
                type="submit"
                disabled={busy}
                className="w-full"
                style={{ backgroundColor: accent, color: accentFg }}
              >
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
