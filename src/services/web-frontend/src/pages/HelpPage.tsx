import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { Markdown } from '../lib/markdown';
import { sanitizeHtml } from '../lib/m2';
import { HELP_ARTICLES, HELP_CATEGORIES, type HelpArticleContent } from '../data/helpContent';
import { EmptyState, ErrorNote, Spinner, TextInput } from '../components/ui';

/**
 * Operations-authored knowledge-base article (served by `/help/articles`). The
 * shape is retained for AdminHelpPage, which manages these records. Their HTML
 * is sanitized server-side with the report-content policy.
 */
export interface HelpArticle {
  id: string;
  slug: string;
  title: string;
  category: string;
  keywords: string;
  body_html: string;
  sort_order: number;
  published: boolean;
  updated_at: string;
}

/** One article, whether authored in-repo (Markdown) or in the CMS (HTML). */
interface UnifiedArticle {
  slug: string;
  title: string;
  summary: string;
  categoryId: string;
  categoryLabel: string;
  keywords: string;
  source: 'static' | 'cms';
  body?: string;
  bodyHtml?: string;
  related?: string[];
  updatedAt?: string;
  /** In-app destination for the feature this article documents. */
  route?: string;
}

function fromStatic(a: HelpArticleContent): UnifiedArticle {
  const cat = HELP_CATEGORIES.find((c) => c.id === a.category);
  return {
    slug: a.id,
    title: a.title,
    summary: a.summary,
    categoryId: a.category,
    categoryLabel: cat?.label ?? a.category,
    keywords: a.keywords.join(' '),
    source: 'static',
    body: a.body,
    related: a.related,
    route: a.route,
  };
}

/** CMS articles group under a matching static category (by label) or their own. */
function fromCms(a: HelpArticle): UnifiedArticle {
  const match = HELP_CATEGORIES.find((c) => c.label.toLowerCase() === a.category.toLowerCase());
  return {
    slug: a.slug,
    title: a.title,
    summary: '',
    categoryId: match?.id ?? `cms:${a.category}`,
    categoryLabel: match?.label ?? a.category,
    keywords: a.keywords,
    source: 'cms',
    bodyHtml: a.body_html,
    updatedAt: a.updated_at,
  };
}

function matches(a: UnifiedArticle, q: string): boolean {
  if (!q) return true;
  return (
    a.title.toLowerCase().includes(q) ||
    a.summary.toLowerCase().includes(q) ||
    a.keywords.toLowerCase().includes(q) ||
    (a.body ?? '').toLowerCase().includes(q) ||
    (a.bodyHtml ?? '').toLowerCase().includes(q)
  );
}

function Breadcrumbs({ trail }: { trail: Array<{ label: string; to?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
      {trail.map((crumb, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {crumb.to ? (
            <Link to={crumb.to} className="font-semibold text-bond-600 hover:text-bond-700">
              {crumb.label}
            </Link>
          ) : (
            <span className="text-ink-500">{crumb.label}</span>
          )}
          {i < trail.length - 1 && <span aria-hidden>/</span>}
        </span>
      ))}
    </nav>
  );
}

/**
 * Help Center (`/help`) — a searchable, category-organized knowledge base. Core
 * content is authored in `src/data/helpContent.ts` (Markdown); any operations-
 * managed CMS articles are merged in so nothing authored via AdminHelpPage is
 * lost. `/help/:slug` renders a single article with breadcrumbs and related links.
 */
export function HelpPage() {
  const { slug } = useParams<{ slug?: string }>();
  const [cms, setCms] = useState<HelpArticle[]>([]);
  const [cmsLoaded, setCmsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  useEffect(() => {
    // CMS articles are a best-effort supplement — a fetch failure still leaves
    // the full static knowledge base intact.
    api<{ articles: HelpArticle[] }>('/help/articles')
      .then((d) => setCms(d.articles.filter((a) => a.published)))
      .catch(() => setError('Some help articles could not be loaded.'))
      .finally(() => setCmsLoaded(true));
  }, []);

  const articles = useMemo<UnifiedArticle[]>(
    () => [...HELP_ARTICLES.map(fromStatic), ...cms.map(fromCms)],
    [cms],
  );

  const bySlug = useMemo(() => {
    const map = new Map<string, UnifiedArticle>();
    for (const a of articles) map.set(a.slug, a);
    return map;
  }, [articles]);

  // Ordered category sections: the 26 static categories first, then any CMS-only
  // categories appended.
  const sections = useMemo(() => {
    const staticSections = HELP_CATEGORIES.map((c) => ({ id: c.id, label: c.label }));
    const extra = new Map<string, string>();
    for (const a of articles) {
      if (!HELP_CATEGORIES.some((c) => c.id === a.categoryId) && !extra.has(a.categoryId)) {
        extra.set(a.categoryId, a.categoryLabel);
      }
    }
    return [...staticSections, ...[...extra].map(([id, label]) => ({ id, label }))];
  }, [articles]);

  // ── Single-article view ───────────────────────────────────────────────────
  if (slug) {
    if (!cmsLoaded && !bySlug.has(slug)) return <Spinner />;
    const article = bySlug.get(slug);
    if (!article) {
      return (
        <div className="max-w-2xl">
          <Breadcrumbs trail={[{ label: 'Help Center', to: '/help' }, { label: 'Not found' }]} />
          <EmptyState title="Article not found">
            <Link to="/help" className="font-semibold text-bond-600 hover:text-bond-700">
              ← Back to the Help Center
            </Link>
          </EmptyState>
        </div>
      );
    }
    const related = (article.related ?? [])
      .map((id) => bySlug.get(id))
      .filter((a): a is UnifiedArticle => Boolean(a));
    return (
      <div className="max-w-2xl">
        <Breadcrumbs
          trail={[
            { label: 'Help Center', to: '/help' },
            { label: article.categoryLabel, to: '/help' },
            { label: article.title },
          ]}
        />
        <div className="overline text-ink-400">{article.categoryLabel}</div>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">{article.title}</h1>
        {article.summary && <p className="mt-2 text-sm text-ink-500">{article.summary}</p>}
        {article.route && (
          <Link
            to={article.route}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-bond-600 px-3 py-1.5 text-sm font-semibold text-paper-50 hover:bg-bond-700"
          >
            Go to the feature →
          </Link>
        )}

        <div className="mt-6">
          {article.source === 'static' ? (
            <Markdown source={article.body ?? ''} />
          ) : (
            <div
              className="prose-help space-y-4 text-[0.95rem] leading-relaxed text-ink-700"
              // Sanitized server-side with the report-content policy, and again
              // here with the identical allowlist — so the pass is idempotent
              // on anything written through the API, and still a guard on a row
              // that reached the table another way (a fixture, a migration, a
              // future importer).
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(article.bodyHtml ?? '') }}
            />
          )}
        </div>

        {related.length > 0 && (
          <div className="mt-10 border-t border-paper-300 pt-5">
            <h2 className="overline mb-3 text-ink-400">Related articles</h2>
            <ul className="space-y-2">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link
                    to={`/help/${r.slug}`}
                    className="text-sm font-semibold text-bond-600 hover:text-bond-700"
                  >
                    {r.title} →
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {article.updatedAt && (
          <p className="tnum mt-8 border-t border-paper-300 pt-4 text-xs text-ink-400">
            Last updated {formatDate(article.updatedAt)}
          </p>
        )}
      </div>
    );
  }

  // ── Index view: search + category sidebar + article list ───────────────────
  const q = query.trim().toLowerCase();
  const visible = articles.filter(
    (a) => matches(a, q) && (!activeCategory || a.categoryId === activeCategory),
  );
  const visibleSections = sections
    .map((s) => ({ ...s, items: visible.filter((a) => a.categoryId === s.id) }))
    .filter((s) => s.items.length > 0);

  return (
    <div className="max-w-5xl">
      <div className="overline text-ink-400">Knowledge base</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Help Center</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">
        Guides to every part of the platform, written for founders, CFOs and accountants. Can't find what you
        need? Open the help widget in the corner to message the operations team.
      </p>
      {error && (
        <div className="mt-4 max-w-2xl">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-6 max-w-md">
        <TextInput
          aria-label="Search help articles"
          placeholder="Search the Help Center…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="mt-8 gap-8 lg:grid lg:grid-cols-[14rem_1fr]">
        {/* Category sidebar */}
        <aside className="mb-6 lg:mb-0">
          <h2 className="overline mb-2 px-2 text-ink-400">Categories</h2>
          <nav className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              aria-current={activeCategory === null ? 'true' : undefined}
              className={`rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors ${
                activeCategory === null
                  ? 'bg-ink-900 text-paper-50'
                  : 'text-ink-600 hover:bg-paper-200 hover:text-ink-900'
              }`}
            >
              All topics
            </button>
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveCategory(s.id)}
                aria-current={activeCategory === s.id ? 'true' : undefined}
                className={`rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors ${
                  activeCategory === s.id
                    ? 'bg-ink-900 text-paper-50'
                    : 'text-ink-600 hover:bg-paper-200 hover:text-ink-900'
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Article list */}
        <div>
          {activeCategory && (
            <Breadcrumbs
              trail={[
                { label: 'Help Center', to: '/help' },
                { label: sections.find((s) => s.id === activeCategory)?.label ?? '' },
              ]}
            />
          )}
          {visibleSections.length === 0 ? (
            <EmptyState title={query ? `No articles match “${query}”` : 'No articles yet'} />
          ) : (
            <div className="space-y-8">
              {visibleSections.map((section) => (
                <section key={section.id}>
                  <h2 className="overline mb-3 text-ink-400">{section.label}</h2>
                  <ul className="divide-y divide-paper-200 rounded-lg border border-paper-300 bg-surface shadow-card">
                    {section.items.map((a) => (
                      <li key={a.slug}>
                        <Link
                          to={`/help/${a.slug}`}
                          className="flex items-start justify-between gap-4 px-5 py-3.5 hover:bg-paper-50"
                        >
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold text-ink-800">{a.title}</span>
                            {a.summary && (
                              <span className="mt-0.5 block text-xs text-ink-500">{a.summary}</span>
                            )}
                          </span>
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className="mt-0.5 shrink-0 text-ink-300"
                            aria-hidden
                          >
                            <path d="M9 5l8 7-8 7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
