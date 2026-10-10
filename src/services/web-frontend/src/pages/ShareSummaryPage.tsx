import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Seo } from '../components/Seo';
import { ShareResultBar } from '../components/ShareResultBar';
import { siteOrigin } from '../lib/seo';

interface ShareSummary {
  company_name: string;
  valuation_date: string | null;
  fmv_per_share: number | null;
  state: string;
  kind: string;
  powered_by: string;
}

function formatDollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const KIND_LABELS: Record<string, string> = {
  '409a': '409A Valuation',
  fmv: 'Fair Market Value',
  '718': 'ASC 718 Valuation',
  '820': 'ASC 820 Fair Value',
  '805': 'Purchase Price Allocation',
};

const STATE_LABELS: Record<string, string> = {
  published: 'Completed',
  signed: 'Signed',
  delivered: 'Delivered',
};

export function ShareSummaryPage() {
  const { token } = useParams<{ token: string }>();
  const [summary, setSummary] = useState<ShareSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    fetch(`/api/share-tokens/${encodeURIComponent(token)}/summary`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (res.status === 410)
            setError(body.detail ?? 'This share link has expired.');
          else if (res.status === 404)
            setError(body.detail ?? 'Share link not found — the token may be invalid or already used.');
          else
            setError(
              body.detail ??
                `Could not load the valuation summary (${res.status}). Try reloading the page.`,
            );
          return;
        }
        setSummary(await res.json());
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error && err.message
              ? `Could not load the valuation summary: ${err.message}`
              : 'Could not reach the server to load the valuation summary. Check your connection and reload the page.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token]);

  const origin = siteOrigin();
  const shareText = summary
    ? `${summary.company_name} completed their ${KIND_LABELS[summary.kind] ?? summary.kind}${summary.fmv_per_share ? ` — ${formatDollars(summary.fmv_per_share)}/share` : ''} | Powered by DoAide 409A`
    : '';
  const whatsappText = summary
    ? `\u{1F4CA} ${summary.company_name} just completed their ${KIND_LABELS[summary.kind] ?? summary.kind} with DoAide${summary.fmv_per_share ? ` — ${formatDollars(summary.fmv_per_share)}/share` : ''}\n\nGet yours \u{2192} ${origin}`
    : '';

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-200 border-t-bond-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-lg px-5 py-24 text-center">
        <h1 className="font-display text-2xl font-semibold text-ink-900">Share link unavailable</h1>
        <p className="mt-3 text-sm text-ink-600">{error}</p>
        <Link
          to="/"
          className="mt-6 inline-block rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
        >
          Go to DoAide 409A
        </Link>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="mx-auto max-w-2xl px-5 py-16">
      <Seo
        title={`${summary.company_name} — ${KIND_LABELS[summary.kind] ?? summary.kind}`}
        description={`${summary.company_name} completed their ${KIND_LABELS[summary.kind] ?? summary.kind} with DoAide 409A.`}
        path={`/share/${token ?? ''}`}
        noindex
      />

      {/* Powered by badge */}
      <div className="mb-8 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-bond-200 bg-bond-50 px-4 py-1.5 text-xs font-semibold text-bond-700">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          Powered by DoAide 409A
        </span>
      </div>

      {/* Summary card */}
      <div className="rounded-xl border border-paper-300 bg-surface p-8 shadow-card" data-testid="share-summary-card">
        <h1 className="text-center font-display text-3xl font-semibold text-ink-900">
          {summary.company_name}
        </h1>
        <p className="mt-2 text-center text-sm text-ink-500">
          {KIND_LABELS[summary.kind] ?? summary.kind}
          {summary.state in STATE_LABELS ? ` — ${STATE_LABELS[summary.state]}` : ''}
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {summary.fmv_per_share != null && (
            <div className="rounded-lg bg-paper-50 p-4 text-center">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Fair Market Value</div>
              <div className="mt-1 font-display text-2xl font-bold text-ink-900">
                {formatDollars(summary.fmv_per_share)}
              </div>
              <div className="text-xs text-ink-500">per share</div>
            </div>
          )}
          {summary.valuation_date && (
            <div className="rounded-lg bg-paper-50 p-4 text-center">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Valuation Date</div>
              <div className="mt-1 font-display text-2xl font-bold text-ink-900">
                {formatDate(summary.valuation_date)}
              </div>
              <div className="text-xs text-ink-500">effective date</div>
            </div>
          )}
        </div>

        <div className="mt-6 border-t border-paper-200 pt-6">
          <ShareResultBar
            title={`${summary.company_name} valuation summary`}
            text={shareText}
            emailSubject={`${summary.company_name} — ${KIND_LABELS[summary.kind] ?? summary.kind}`}
            emailLabel="Email summary"
            whatsappText={whatsappText}
          />
        </div>
      </div>

      {/* CTA */}
      <div className="mt-8 rounded-lg border border-bond-200 bg-bond-50 p-6 text-center">
        <h2 className="font-display text-lg font-semibold text-ink-900">
          Need a 409A valuation for your company?
        </h2>
        <p className="mt-2 text-sm text-ink-600">
          AI-assisted intake, transparent engine, analyst-signed report. First draft in 24 hours.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/register"
            className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
          >
            Start your valuation
          </Link>
          <Link
            to="/tools/readiness-checker"
            className="text-sm font-semibold text-bond-600 hover:text-bond-700"
          >
            Check your readiness →
          </Link>
        </div>
      </div>

      <p className="mt-8 text-center text-xs text-ink-400">
        This is a summary view. Full valuation details are available to authorised parties only.
      </p>
    </div>
  );
}
