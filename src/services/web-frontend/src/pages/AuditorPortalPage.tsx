import { useEffect, useState } from 'react';
import { AuthShell } from '../components/AuthShell';
import { HelpIcon } from '../components/HelpIcon';
import { ErrorNote, Spinner } from '../components/ui';
import { formatDate, moneyFormatter } from '../lib/format';
import { sanitizeHtml } from '../lib/m2';

interface Section {
  heading: string;
  html: string;
}
interface Bundle {
  valuation: { number: string; company_name: string; kind: string; state: string; currency: string };
  report: {
    template_version: string;
    status: string;
    content: { title: string; sections: Section[] };
  } | null;
  assumptions: {
    allocation_method: string;
    weights: { asset: string | null; opm: string | null; income: string | null; market: string | null };
    dloc: string | null;
    dlom: string | null;
    dlom_method: string | null;
    exit_timeline: string | null;
  } | null;
  conclusion: {
    equity_value: string | null;
    fmv_per_share: string | null;
    engine_version: string;
    /*
     * What each figure is, in this valuation kind's own words — the server
     * sends the caption with the number (see domain/specialty.ts). A specialty
     * engine writes its headline into the 409A-named columns, so the fixed
     * captions this page used to print called an IFRS 2 total expense an
     * "Equity value". `null` is the kind contributing no such figure, and the
     * metric is then omitted rather than shown as an em-dash.
     *
     * Optional because a bundle served by an older build carries neither key;
     * those fall back to the 409A wording, which is what they held.
     */
    equity_label?: string | null;
    fmv_per_share_label?: string | null;
  } | null;
  qa: Array<{ id: string; status: string; checks: Array<{ label: string; status: string; detail: string }> }>;
  evidence_summary: {
    has_report: boolean;
    has_conclusion: boolean;
    qa_count: number;
    assumptions_recorded: boolean;
  };
  access_expires_at: string;
}

/**
 * External auditor portal (feature 8). Public, token-authenticated, read-only
 * view of one valuation: report, assumptions, conclusion, and audit-defense
 * Q&A. The token comes from the shared link's fragment (never a query string).
 */
export function AuditorPortalPage() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (!token) {
      setError('This auditor link is missing its access token.');
      return;
    }
    fetch('/api/v1/auditor/portal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? 'Access denied');
        return res.json();
      })
      .then(setBundle)
      .catch((err) => setError(err instanceof Error ? err.message : 'This link is invalid or expired.'));
  }, []);

  if (error) {
    return (
      <AuthShell title="Auditor access" subtitle="Read-only valuation review">
        <ErrorNote>{error}</ErrorNote>
      </AuthShell>
    );
  }
  if (!bundle) {
    return (
      <AuthShell title="Auditor access" subtitle="Loading…">
        <Spinner />
      </AuthShell>
    );
  }

  // `undefined` is a bundle from a build that predates the captions; `null` is
  // this kind having no such figure. Only the first falls back.
  const perShareLabel =
    bundle.conclusion?.fmv_per_share_label === undefined
      ? 'Concluded FMV / share'
      : bundle.conclusion.fmv_per_share_label;
  const equityLabel =
    bundle.conclusion?.equity_label === undefined ? 'Equity value' : bundle.conclusion.equity_label;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Auditor portal · read-only
        <HelpIcon article="auditor-portal-overview" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
        {bundle.valuation.company_name}
      </h1>
      <p className="tnum mt-1 text-sm text-ink-400">
        {bundle.valuation.number} · {bundle.valuation.kind.toUpperCase()} · {bundle.valuation.state}
      </p>
      <p className="mt-1 text-xs text-ink-400">Access expires {formatDate(bundle.access_expires_at)}</p>

      {bundle.conclusion && (
        <section className="mt-6 flex flex-wrap gap-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          {perShareLabel !== null && (
            <Metric
              label={perShareLabel}
              value={bundle.conclusion.fmv_per_share ?? '—'}
              currency={bundle.valuation.currency}
            />
          )}
          {equityLabel !== null && (
            <Metric
              label={equityLabel}
              value={bundle.conclusion.equity_value ?? '—'}
              currency={bundle.valuation.currency}
            />
          )}
          <Metric label="Engine version" value={bundle.conclusion.engine_version} />
        </section>
      )}

      {bundle.assumptions && (
        <Card title="Assumptions">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Fact label="Allocation" value={bundle.assumptions.allocation_method} />
            <Fact label="DLOM" value={pct(bundle.assumptions.dlom)} />
            <Fact label="DLOM method" value={bundle.assumptions.dlom_method ?? '—'} />
            <Fact label="DLOC" value={pct(bundle.assumptions.dloc)} />
            <Fact label="Asset wt" value={pct(bundle.assumptions.weights.asset)} />
            <Fact label="OPM wt" value={pct(bundle.assumptions.weights.opm)} />
            <Fact label="Income wt" value={pct(bundle.assumptions.weights.income)} />
            <Fact label="Market wt" value={pct(bundle.assumptions.weights.market)} />
          </dl>
        </Card>
      )}

      {bundle.report && (
        <Card title={`Report — ${bundle.report.status}`}>
          {bundle.report.content.sections.map((s, i) => (
            <div key={i} className="mb-5 last:mb-0">
              <h3 className="mb-1.5 font-display text-base font-semibold text-ink-900">{s.heading}</h3>
              {/*
                Sanitised again here, as the report tab does. Server-side
                sanitisation on save is the primary control, but this page
                renders whatever is *already stored* — including content
                written before a sanitiser covered the path that wrote it —
                and its reader is an external auditor holding a token, the one
                viewer with no account and the least reason to trust us.
              */}
              <div
                className="prose-sm text-ink-700"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(s.html) }}
              />
            </div>
          ))}
        </Card>
      )}

      {bundle.qa.length > 0 && (
        <Card title="Audit-defense review">
          {bundle.qa.map((q) => (
            <div key={q.id} className="mb-4 last:mb-0">
              <div className="overline text-ink-400">Review · {q.status}</div>
              <ul className="mt-2 space-y-1.5">
                {q.checks.map((c, i) => (
                  <li key={i} className="text-sm">
                    <span
                      className={`mr-2 rounded px-1.5 py-0.5 text-xs font-semibold ${
                        c.status === 'pass'
                          ? 'bg-emerald-50 text-emerald-700'
                          : c.status === 'fail'
                            ? 'bg-red-50 text-red-700'
                            : 'bg-paper-100 text-ink-600'
                      }`}
                    >
                      {c.status}
                    </span>
                    <span className="font-semibold text-ink-800">{c.label}:</span>{' '}
                    <span className="text-ink-600">{c.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

const pct = (v: string | null) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

function Metric({ label, value, currency }: { label: string; value: string; currency?: string }) {
  const display =
    currency && /^-?\d/.test(value)
      ? moneyFormatter(currency, { maximumFractionDigits: 2 })(Number(value))
      : value;
  return (
    <div>
      <div className="overline text-ink-400">{label}</div>
      <div className="tnum mt-1 font-display text-xl font-semibold text-ink-900">{display}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 className="overline mb-4 text-ink-400">{title}</h2>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="mt-0.5 font-semibold text-ink-900">{value}</dd>
    </div>
  );
}
