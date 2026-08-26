import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatDateTime, formatPerShare } from '../../lib/format';
import {
  DOCUMENT_KIND_LABELS,
  formatBytes,
  formatMoney,
  AI_PIPELINE_META,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
} from '../../lib/pipeline';
import type { AiPipeline, DocumentKind, ReviewTaskKind, ReviewTaskStatus } from '../../lib/pipeline';
import { ErrorNote, ListTruncationNote, Spinner } from '../../components/ui';
import { useWorkspace } from './ValuationWorkspace';

interface PackageDocument {
  id: string;
  kind: DocumentKind;
  filename: string;
  size_bytes: string | number;
  created_at: string;
}

interface PackageData {
  valuation: Record<string, unknown>;
  company_profile: {
    legal_name: string | null;
    industry: string | null;
    employee_count: number | null;
  } | null;
  params: Record<string, unknown> | null;
  documents: PackageDocument[];
  ai_jobs: Array<{
    id: string;
    pipeline: AiPipeline;
    status: string;
    model: string | null;
    created_at: string;
  }>;
  calculations: Array<{
    id: string;
    status: string;
    engine_version: string;
    fmv_per_share: string | null;
    equity_value: string | null;
    error: string | null;
    created_at: string;
  }>;
  /** Both run histories are pages of longer logs; see the `truncated` note on `Node`. */
  ai_jobs_truncated: boolean;
  calculations_truncated: boolean;
  overwrites: Array<{ id: string; category: string; field_key: string; value: unknown }>;
  report: {
    id: string;
    status: string;
    template_version: string;
    current_version: number;
    versions: Array<{ version: number; created_at: string; has_pdf: boolean }>;
  } | null;
  tasks: Array<{ id: string; kind: ReviewTaskKind; title: string; status: ReviewTaskStatus }>;
  funding_rounds: Array<{
    id: string;
    name: string;
    closed_on: string | null;
    amount_raised_cents: number | null;
  }>;
  transactions: Array<{ id: string; kind: string; occurred_on: string }>;
}

/** Collapsible section of the package tree. */
function Node({
  label,
  count,
  to,
  truncated = false,
  defaultOpen = false,
  children,
}: {
  label: string;
  count: number;
  to?: string;
  /**
   * The rows under this node are a page of a longer list.
   *
   * The count badge is `rows.length`, which is the shape this explorer is most
   * exposed to: a collapsed node reads as a complete inventory of what the
   * engagement holds, and "20" over a hundred engine runs is a wrong number
   * rather than a short list. Marked on the badge and again under the rows,
   * because a reader who never expands the node sees only the badge.
   */
  truncated?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group rounded-lg border border-paper-300 bg-surface shadow-card">
      <summary className="flex cursor-pointer items-center gap-3 px-5 py-3.5 select-none">
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="shrink-0 text-ink-400 transition-transform group-open:rotate-90"
        >
          <path d="M9 5l8 7-8 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-sm font-semibold text-ink-900">{label}</span>
        <span className="tnum rounded-full bg-paper-200 px-2 py-0.5 text-xs font-semibold text-ink-600">
          {count}
          {truncated && '+'}
        </span>
        {to && (
          <Link
            to={to}
            onClick={(e) => e.stopPropagation()}
            className="ml-auto text-xs font-semibold text-bond-600 hover:text-bond-700"
          >
            Open tab →
          </Link>
        )}
      </summary>
      <div className="border-t border-paper-200 px-5 py-4">
        {children}
        <ListTruncationNote truncated={truncated} shown={count} noun={label.toLowerCase()} />
      </div>
    </details>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-paper-200 text-sm">{children}</ul>;
}

function Row({ children }: { children: ReactNode }) {
  return <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">{children}</li>;
}

function None({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-400">{children}</p>;
}

/** Everything the engagement contains, in one hierarchical read-only view. */
export function PackageTab() {
  const { valuation } = useWorkspace();
  const [pkg, setPkg] = useState<PackageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ package: PackageData }>(`/valuations/${valuation.id}/package`)
      .then(({ package: data }) => {
        if (!cancelled) setPkg(data);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the valuation package.');
      });
    return () => {
      cancelled = true;
    };
  }, [valuation.id]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!pkg) return <Spinner />;

  const base = `/valuations/${valuation.id}`;
  const currency = (valuation.currency as string) ?? 'USD';
  const paramsSet = pkg.params
    ? Object.entries(pkg.params).filter(([k, v]) => v !== null && !['valuation_id', 'updated_at'].includes(k))
    : [];
  const latestCalc = pkg.calculations.find((c) => c.status === 'succeeded');

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-ink-500">
        The complete engagement package — every artifact attached to this valuation, in one place. Sections
        link to their working tabs.
      </p>

      <Node label="Company profile" count={pkg.company_profile ? 1 : 0} to={`${base}/company`} defaultOpen>
        {pkg.company_profile ? (
          <Rows>
            <Row>
              <span className="font-semibold text-ink-900">
                {pkg.company_profile.legal_name ?? (valuation.company_name as string)}
              </span>
              {pkg.company_profile.industry && (
                <span className="text-ink-600">{pkg.company_profile.industry}</span>
              )}
              {pkg.company_profile.employee_count !== null && (
                <span className="tnum text-ink-400">{pkg.company_profile.employee_count} employees</span>
              )}
            </Row>
          </Rows>
        ) : (
          <None>No structured profile yet — the engagement carries only the company name.</None>
        )}
      </Node>

      <Node label="Documents" count={pkg.documents.length} to={`${base}/documents`} defaultOpen>
        {pkg.documents.length === 0 ? (
          <None>No documents uploaded.</None>
        ) : (
          <Rows>
            {pkg.documents.map((d) => (
              <Row key={d.id}>
                <span className="font-semibold text-ink-900">{d.filename}</span>
                <span className="text-xs text-ink-400">
                  {DOCUMENT_KIND_LABELS[d.kind] ?? d.kind} · {formatBytes(d.size_bytes)} ·{' '}
                  {formatDateTime(d.created_at)}
                </span>
              </Row>
            ))}
          </Rows>
        )}
      </Node>

      <Node label="Methodology params" count={paramsSet.length} to={`${base}/params`}>
        {paramsSet.length === 0 ? (
          <None>No params set.</None>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
            {paramsSet.map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs text-ink-400">{key.replace(/_/g, ' ')}</dt>
                <dd className="tnum font-semibold break-words text-ink-900">{String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </Node>

      <Node label="AI runs" count={pkg.ai_jobs.length} truncated={pkg.ai_jobs_truncated} to={`${base}/ai`}>
        {pkg.ai_jobs.length === 0 ? (
          <None>No AI pipeline runs.</None>
        ) : (
          <Rows>
            {pkg.ai_jobs.map((j) => (
              <Row key={j.id}>
                <span className="font-semibold text-ink-900">
                  {AI_PIPELINE_META[j.pipeline]?.label ?? j.pipeline}
                </span>
                <span
                  className={`text-xs font-semibold ${j.status === 'succeeded' ? 'text-bond-700' : 'text-red-700'}`}
                >
                  {j.status}
                </span>
                <span className="ml-auto text-xs text-ink-400">
                  {formatDateTime(j.created_at)}
                  {j.model && ` · ${j.model}`}
                </span>
              </Row>
            ))}
          </Rows>
        )}
      </Node>

      <Node
        label="Calculations"
        count={pkg.calculations.length}
        truncated={pkg.calculations_truncated}
        to={`${base}/calculations`}
      >
        {pkg.calculations.length === 0 ? (
          <None>No engine runs.</None>
        ) : (
          <Rows>
            {pkg.calculations.map((c) => (
              <Row key={c.id}>
                <span
                  className={`text-xs font-semibold ${c.status === 'succeeded' ? 'text-bond-700' : 'text-red-700'}`}
                >
                  {c.status}
                </span>
                <span className="tnum font-semibold text-ink-900">
                  {c.status === 'succeeded' ? formatPerShare(c.fmv_per_share, currency) : (c.error ?? '—')}
                </span>
                {c.id === latestCalc?.id && (
                  <span className="rounded-full bg-bond-50 px-2 py-0.5 text-[0.65rem] font-bold text-bond-700 uppercase">
                    latest
                  </span>
                )}
                <span className="ml-auto text-xs text-ink-400">
                  {formatDateTime(c.created_at)} · {c.engine_version}
                </span>
              </Row>
            ))}
          </Rows>
        )}
      </Node>

      <Node label="Overwrites" count={pkg.overwrites.length} to={`${base}/overwrites`}>
        {pkg.overwrites.length === 0 ? (
          <None>No analyst overrides.</None>
        ) : (
          <Rows>
            {pkg.overwrites.map((o) => (
              <Row key={o.id}>
                <span className="font-mono text-xs text-ink-400">{o.category}</span>
                <span className="font-semibold text-ink-900">{o.field_key}</span>
                <span className="tnum ml-auto text-ink-600">{String(o.value)}</span>
              </Row>
            ))}
          </Rows>
        )}
      </Node>

      <Node label="Report" count={pkg.report ? pkg.report.versions.length : 0} to={`${base}/report`}>
        {pkg.report ? (
          <div>
            <p className="text-sm text-ink-700">
              <span className="font-semibold">{pkg.report.template_version}</span> · status{' '}
              <span className="font-semibold">{pkg.report.status}</span> · current v
              {pkg.report.current_version}
            </p>
            <Rows>
              {pkg.report.versions.map((v) => (
                <Row key={v.version}>
                  <span className="tnum font-semibold text-ink-900">v{v.version}</span>
                  {v.has_pdf && <span className="text-xs text-ink-400">PDF rendered</span>}
                  <span className="ml-auto text-xs text-ink-400">{formatDateTime(v.created_at)}</span>
                </Row>
              ))}
            </Rows>
          </div>
        ) : (
          <None>No report generated.</None>
        )}
      </Node>

      <Node label="Review tasks" count={pkg.tasks.length} to={`${base}/tasks`}>
        {pkg.tasks.length === 0 ? (
          <None>No review tasks.</None>
        ) : (
          <Rows>
            {pkg.tasks.map((t) => (
              <Row key={t.id}>
                <span className="font-semibold text-ink-900">{t.title}</span>
                <span className="text-xs text-ink-400">{TASK_KIND_LABELS[t.kind] ?? t.kind}</span>
                <span className="ml-auto text-xs font-semibold text-ink-600">
                  {TASK_STATUS_LABELS[t.status] ?? t.status}
                </span>
              </Row>
            ))}
          </Rows>
        )}
      </Node>

      <Node label="Funding rounds & transactions" count={pkg.funding_rounds.length + pkg.transactions.length}>
        {pkg.funding_rounds.length + pkg.transactions.length === 0 ? (
          <None>No rounds or securities transactions recorded.</None>
        ) : (
          <Rows>
            {pkg.funding_rounds.map((r) => (
              <Row key={r.id}>
                <span className="font-semibold text-ink-900">{r.name}</span>
                {r.amount_raised_cents !== null && (
                  <span className="tnum text-ink-600">
                    {formatMoney(r.amount_raised_cents / 100, currency)} raised
                  </span>
                )}
                <span className="ml-auto text-xs text-ink-400">{r.closed_on ?? 'not closed'}</span>
              </Row>
            ))}
            {pkg.transactions.map((t) => (
              <Row key={t.id}>
                <span className="font-semibold text-ink-900">{t.kind.replace(/_/g, ' ')}</span>
                <span className="ml-auto text-xs text-ink-400">{t.occurred_on}</span>
              </Row>
            ))}
          </Rows>
        )}
      </Node>
    </div>
  );
}
