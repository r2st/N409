import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';

/**
 * "See a sample report" (`/sample-report`).
 *
 * The chapter list is fetched rather than written here, because the endpoint
 * reads it off the same template the renderer instantiates. A page that
 * hard-codes what is in the deliverable is a page that quietly stops being
 * true; this one cannot, and it prints the template version it is describing
 * so a reader can see which document they are looking at the contents of.
 */

interface Outline {
  kind: string;
  version: string;
  name: string;
  sections: { key: string; heading: string; blurb: string | null }[];
  exhibits: { id: string; title: string; description: string; always: boolean }[];
}

/** The headline figures of the worked example, as the report concludes them. */
const WORKED_EXAMPLE = [
  { label: 'Equity value', value: '$32.0M' },
  { label: 'Preferred', value: '−$12.4M' },
  { label: 'Option pool', value: '−$5.5M' },
  { label: 'Common', value: '$14.1M' },
  { label: 'DLOM', value: '−27.5%' },
  { label: 'FMV / share', value: '$4.12' },
];

export function SampleReportPage() {
  const [outline, setOutline] = useState<Outline | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<{ outline: Outline }>('/sample-report')
      .then((r) => setOutline(r.outline))
      .catch(() => setFailed(true));
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <Seo {...pageMeta('/sample-report')!} />
      <div className="overline text-ink-400">Sample 409A report</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
        See a real 409A valuation report
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
        The same document your auditors, investors and board will see. Expert-reviewed, prepared for IRS
        safe-harbor reliance, and signed by a credentialed analyst.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <Link
          to="/register"
          className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
        >
          Start my valuation
        </Link>
        <Link
          to="/tools/409a-valuation-calculator"
          className="text-sm font-semibold text-bond-600 hover:text-bond-700"
        >
          Estimate your range first →
        </Link>
      </div>

      <section className="mt-12 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="overline text-bond-700">Report summary</div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {WORKED_EXAMPLE.map((f) => (
            <div key={f.label}>
              <div className="tnum font-display text-2xl font-semibold text-ink-900">{f.value}</div>
              <div className="overline mt-0.5 text-ink-400">{f.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-5 border-t border-paper-200 pt-4 text-xs leading-relaxed text-ink-500">
          A worked Series B example: an OPM backsolve calibrated to the last priced round, a Finnerty
          marketability discount, and the per-share conclusion the board resolution references.
        </p>
      </section>

      <section className="mt-14">
        <div className="overline text-ink-400">What&rsquo;s inside</div>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">Every section, explained</h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
          A defensible 409A is a documented argument, not just a number.{' '}
          {outline && (
            <>
              Here are all {outline.sections.length} chapters of the{' '}
              <span className="tnum">{outline.version}</span> template, and what each one does for you.
            </>
          )}
        </p>

        {failed && (
          <p className="mt-6 text-sm text-ink-500">
            The report outline is temporarily unavailable. Please try again shortly.
          </p>
        )}

        {outline && (
          <ol className="mt-6 grid gap-4" data-testid="sample-report-sections">
            {outline.sections.map((s, i) => (
              <li key={s.key} className="flex gap-4 border-b border-paper-200 pb-4 last:border-b-0">
                <span className="tnum shrink-0 text-sm font-semibold text-bond-600">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <div className="text-sm font-semibold text-ink-900">{s.heading}</div>
                  {s.blurb && <p className="mt-1 text-sm leading-relaxed text-ink-600">{s.blurb}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {outline && outline.exhibits.length > 0 && (
        <section className="mt-14">
          <div className="overline text-ink-400">Exhibits</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
            The schedules behind the numbers
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
            Every figure in the report traces to a schedule. Exhibits marked{' '}
            <span className="font-semibold">as applicable</span> appear only when your engagement uses that
            approach — a company with no discounted cash flow receives no Exhibit C.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2" data-testid="sample-report-exhibits">
            {outline.exhibits.map((e) => (
              <div key={e.id} className="rounded-lg border border-paper-300 bg-surface p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-ink-900">
                    Exhibit {e.id} — {e.title}
                  </span>
                  {!e.always && (
                    <span className="shrink-0 rounded bg-paper-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                      as applicable
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-600">{e.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-14 rounded-lg border border-bond-200 bg-bond-50 p-6">
        <h2 className="font-display text-xl font-semibold text-ink-900">Take it to your board</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-600">
          Your own report follows this same structure, with a first draft in 24 hours. Wondering how the
          numbers are derived? The methodology walks through the OPM backsolve and the DLOM step by step.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <Link
            to="/register"
            className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
          >
            Start my valuation
          </Link>
          <Link to="/pricing" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
            See pricing →
          </Link>
        </div>
      </section>
    </div>
  );
}
