import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { EmptyState, ErrorNote, Spinner, TextInput } from '../components/ui';

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

export function filterArticles(articles: HelpArticle[], query: string): HelpArticle[] {
  const q = query.trim().toLowerCase();
  if (!q) return articles;
  return articles.filter(
    (a) =>
      a.title.toLowerCase().includes(q) ||
      a.keywords.toLowerCase().includes(q) ||
      a.body_html.toLowerCase().includes(q),
  );
}

/** P2 #10 — full-page knowledge base: category-grouped list + article view.
 * Article HTML is sanitized server-side (same policy as report content). */
export function HelpPage() {
  const { slug } = useParams<{ slug?: string }>();
  const [articles, setArticles] = useState<HelpArticle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api<{ articles: HelpArticle[] }>('/help/articles')
      .then((d) => setArticles(d.articles.filter((a) => a.published)))
      .catch(() => setError('Could not load the help articles.'));
  }, []);

  const filtered = useMemo(() => filterArticles(articles ?? [], query), [articles, query]);
  const byCategory = useMemo(() => {
    const groups = new Map<string, HelpArticle[]>();
    for (const a of filtered) {
      const list = groups.get(a.category) ?? [];
      list.push(a);
      groups.set(a.category, list);
    }
    return [...groups.entries()];
  }, [filtered]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!articles) return <Spinner />;

  const article = slug ? articles.find((a) => a.slug === slug) : undefined;

  if (slug) {
    if (!article) {
      return (
        <div className="max-w-2xl">
          <EmptyState title="Article not found">
            <Link to="/help" className="font-semibold text-bond-600 hover:text-bond-700">
              ← Back to all help articles
            </Link>
          </EmptyState>
        </div>
      );
    }
    return (
      <div className="max-w-2xl">
        <Link to="/help" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
          ← All help articles
        </Link>
        <div className="overline mt-4 text-ink-400">{article.category}</div>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">{article.title}</h1>
        <div
          className="prose-help mt-6 space-y-4 text-[0.95rem] leading-relaxed text-ink-700"
          // Sanitized server-side with the report-content policy.
          dangerouslySetInnerHTML={{ __html: article.body_html }}
        />
        <p className="tnum mt-8 border-t border-paper-300 pt-4 text-xs text-ink-400">
          Last updated {formatDate(article.updated_at)}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <div className="overline text-ink-400">Knowledge base</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Help</h1>
      <p className="mt-2 text-sm text-ink-500">
        Guides to the valuation process. Can't find it? Use the help widget's contact form — the
        operations team reads every message.
      </p>

      <div className="mt-6 max-w-md">
        <TextInput
          aria-label="Search help articles"
          placeholder="Search articles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState title={query ? `No articles match “${query}”` : 'No articles yet'} />
        </div>
      )}

      <div className="mt-8 space-y-8">
        {byCategory.map(([category, items]) => (
          <section key={category}>
            <h2 className="overline mb-3 text-ink-400">{category}</h2>
            <ul className="divide-y divide-paper-200 rounded-lg border border-paper-300 bg-white shadow-card">
              {items.map((a) => (
                <li key={a.id}>
                  <Link
                    to={`/help/${a.slug}`}
                    className="flex items-center justify-between px-5 py-3.5 text-sm font-semibold text-ink-800 hover:bg-paper-50"
                  >
                    {a.title}
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="shrink-0 text-ink-300"
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
    </div>
  );
}
