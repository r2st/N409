import { Link, Navigate, useParams } from 'react-router-dom';
import { comparisonBySlug } from '../../lib/marketing';
import { Seo } from '../../components/Seo';
import { comparePageMeta } from '../../lib/pageMeta';

/** Competitor comparison landing page (409.ai §22.6) — data-driven. */
export function ComparePage() {
  const { slug } = useParams<{ slug: string }>();
  const comparison = slug ? comparisonBySlug(slug) : undefined;
  if (!comparison) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-5xl px-5 py-16">
      <Seo {...comparePageMeta(comparison.slug)!} />
      <div className="overline text-ink-400">{comparison.category}</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
        N409 vs {comparison.competitor}
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-600">{comparison.summary}</p>

      <div className="mt-10 overflow-x-auto rounded-lg border border-paper-300 shadow-card">
        <table className="w-full min-w-[640px] text-sm" aria-label={`N409 vs ${comparison.competitor}`}>
          <thead>
            <tr className="border-b border-paper-300 bg-paper-50 text-left">
              <th className="overline px-5 py-3 font-semibold text-ink-400">Dimension</th>
              <th className="overline px-4 py-3 font-semibold text-bond-700">N409</th>
              <th className="overline px-4 py-3 font-semibold text-ink-400">{comparison.competitor}</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => (
              <tr key={row.dimension} className="border-b border-paper-200 bg-white last:border-0">
                <td className="px-5 py-3.5 font-semibold text-ink-800">{row.dimension}</td>
                <td className="px-4 py-3.5 font-medium text-bond-700">{row.us}</td>
                <td className="px-4 py-3.5 text-ink-600">{row.them}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-4">
        <Link
          to="/register"
          className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-white shadow-card transition-colors hover:bg-bond-700"
        >
          Start my valuation
        </Link>
        <Link to="/pricing" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
          See pricing →
        </Link>
        <Link
          to="/compare/409a-valuation-providers"
          className="text-sm font-semibold text-bond-600 hover:text-bond-700"
        >
          Compare all providers →
        </Link>
      </div>
    </div>
  );
}
