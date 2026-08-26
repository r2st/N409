import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLatestOnly } from '../../lib/useLatestOnly';
import { useClearOnChange } from '../../lib/useClearOnChange';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { formatDate } from '../../lib/format';
import { sanitizeHtml } from '../../lib/m2';
import { Seo } from '../../components/Seo';
import { ErrorNote, Spinner } from '../../components/ui';
import { articleJsonLd, breadcrumbJsonLd, websiteJsonLd } from '../../lib/seo';

/**
 * The marketing blog (design §16.2, P2-20).
 *
 * Two pages over one table: an index at `/blog` and an article at
 * `/blog/:slug`. Both are public and both carry their own `<Seo>` — an article
 * whose link preview says "N409 · Valuations" is an article nobody clicks.
 *
 * Post bodies are HTML authored by ops and sanitised **server-side on write**
 * with the same policy as report content. `dangerouslySetInnerHTML` here is
 * rendering already-sanitised content, which is the same arrangement the help
 * centre and the report editor use — sanitising again at render would be a
 * second policy to keep in step with the first.
 *
 * An ops session falls back to the draft-preview endpoint when the public read
 * 404s, so a writer checks an unpublished post on the real page rather than in
 * a preview that renders differently.
 */

interface PostSummary {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  author: string;
  /** Server-derived: the index does not carry the body it would count. */
  read_minutes?: number;
  og_image: string | null;
  published: boolean;
  published_at: string | null;
}

interface Post extends PostSummary {
  body_html: string;
  keywords: string;
}

const BLOG_DESCRIPTION =
  'Notes on 409A and fair-value practice from the N409 team — methodology, audit defensibility, and what actually changes when valuation work is automated.';

function DraftTag() {
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.65rem] font-semibold text-amber-800">
      draft — not public
    </span>
  );
}

/** Category counts in publication order, so the filter row is stable. */
function categoriesOf(posts: PostSummary[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of posts) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }));
}

export function BlogIndexPage() {
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Client-side, not a query parameter: the whole published index is one
  // response the page already holds, so filtering it is a render, not a fetch.
  const [category, setCategory] = useState<string | null>(null);

  useEffect(() => {
    api<{ posts: PostSummary[] }>('/blog/posts')
      .then((res) => setPosts(res.posts))
      .catch(() => setError('Could not load the blog just now.'));
  }, []);

  const categories = posts ? categoriesOf(posts) : [];
  // A category that empties out — every post in it unpublished — would leave a
  // selected filter showing nothing, so fall back rather than trusting state.
  const shown = posts && category ? posts.filter((p) => p.category === category) : (posts ?? []);
  const visible = posts && category && shown.length === 0 ? posts : shown;

  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <Seo
        title="Blog"
        description={BLOG_DESCRIPTION}
        path="/blog"
        jsonLd={[
          websiteJsonLd(),
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog' },
          ]),
        ]}
      />
      <div className="overline text-ink-400">Writing</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">Blog</h1>
      <p className="mt-4 text-[0.95rem] leading-relaxed text-ink-600">{BLOG_DESCRIPTION}</p>

      {error && (
        <div className="mt-8">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {!posts && !error && (
        <div className="mt-8">
          <Spinner label="Loading posts…" />
        </div>
      )}
      {posts && posts.length === 0 && (
        <p className="mt-8 text-sm text-ink-400">Nothing published yet — check back shortly.</p>
      )}

      {/* Past a dozen pieces a flat list stops being browsable. One row of
          counts is enough — a reader who wants ASC 718 should not scroll past
          the UK share schemes to find it. */}
      {categories.length > 1 && (
        <div className="mt-8 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          <button
            type="button"
            onClick={() => setCategory(null)}
            aria-pressed={category === null}
            className={`tap-area rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              category === null ? 'bg-bond-600 text-bond-fg' : 'bg-paper-100 text-ink-600 hover:bg-paper-200'
            }`}
          >
            All {posts!.length}
          </button>
          {categories.map(({ name, count }) => (
            <button
              key={name}
              type="button"
              onClick={() => setCategory(name)}
              aria-pressed={category === name}
              className={`tap-area rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                category === name
                  ? 'bg-bond-600 text-bond-fg'
                  : 'bg-paper-100 text-ink-600 hover:bg-paper-200'
              }`}
            >
              {name} {count}
            </button>
          ))}
        </div>
      )}

      {posts && posts.length > 0 && (
        <ul className="mt-10 divide-y divide-paper-300 border-t border-paper-300">
          {visible.map((post) => (
            <li key={post.slug} className="py-7">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                <span className="font-semibold text-bond-700">{post.category}</span>
                {post.published_at && (
                  <>
                    <span aria-hidden>·</span>
                    <time dateTime={post.published_at}>{formatDate(post.published_at)}</time>
                  </>
                )}
                {post.read_minutes ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>{post.read_minutes} min read</span>
                  </>
                ) : null}
                {post.author && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{post.author}</span>
                  </>
                )}
              </div>
              <h2 className="mt-1.5 font-display text-2xl font-semibold text-ink-900">
                <Link to={`/blog/${post.slug}`} className="hover:text-bond-700">
                  {post.title}
                </Link>
              </h2>
              {post.excerpt && (
                <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-600">{post.excerpt}</p>
              )}
              <Link
                to={`/blog/${post.slug}`}
                className="mt-3 inline-block text-sm font-semibold text-bond-600 hover:text-bond-700"
              >
                Read on &rarr;
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BlogPostPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const ops = isOps(user);
  const [post, setPost] = useState<Post | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Following a link from one post to the next keeps this component mounted and
   * only changes `:slug`, so two posts can be in flight at once. The stale
   * reply renders the previous article under the current URL — and carries its
   * `<Seo>` with it, so the canonical link, the title and the structured data
   * on the page all describe a post that is not the one being shown. This is
   * the public, indexable half of the platform; it is the wrong place to be
   * telling a crawler one thing and a reader another.
   *
   * The two-step lookup makes it worse rather than better: an ops writer's
   * 404-then-preview path is two round trips, so the abandoned request has a
   * second chance to finish last. See `useLatestOnly`.
   */
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    if (!slug) return;
    const current = claim();
    try {
      const res = await api<{ post: Post }>(`/blog/posts/${slug}`);
      if (current()) setPost(res.post);
    } catch (err) {
      if (!current()) return;
      if (!(err instanceof ApiError) || err.status !== 404) {
        setError('Could not load this post just now.');
        return;
      }
      // Not published — an ops writer may still be previewing it.
      if (!ops) {
        setMissing(true);
        return;
      }
      try {
        const res = await api<{ post: Post }>(`/admin/blog/posts/${slug}`);
        if (current()) setPost(res.post);
      } catch {
        if (current()) setMissing(true);
      }
    }
  }, [slug, ops, claim]);

  /*
   * A related-post link changes `slug` without remounting this component, so
   * the post the reader has just left stayed on screen — its title, its body
   * and its publication date — under the URL of the one they asked for. The
   * `missing` flag goes with it: carried over, it would render the previous
   * slug's 404 body for a post that may well exist.
   */
  useClearOnChange(slug ?? '', () => {
    setPost(null);
    setMissing(false);
  });

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16">
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16">
        {/* noindex, because a 404 body served at 200 is exactly what a crawler
            should not add to an index. */}
        <Seo
          title="Post not found"
          description="This article does not exist or is no longer published."
          path={`/blog/${slug ?? ''}`}
          noindex
        />
        <h1 className="font-display text-3xl font-semibold text-ink-900">Post not found</h1>
        <p className="mt-3 text-sm text-ink-500">This article does not exist or is no longer published.</p>
        <Link to="/blog" className="mt-6 inline-block text-sm font-semibold text-bond-600">
          &larr; All posts
        </Link>
      </div>
    );
  }

  if (!post) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16">
        <Spinner label="Loading post…" />
      </div>
    );
  }

  return (
    <article className="mx-auto max-w-3xl px-5 py-16">
      <Seo
        title={post.title}
        description={post.excerpt || BLOG_DESCRIPTION}
        path={`/blog/${post.slug}`}
        type="article"
        image={post.og_image ?? undefined}
        // A draft previewed at its real URL must never be indexable, whatever
        // the preview looks like.
        noindex={!post.published}
        jsonLd={[
          articleJsonLd(post),
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog' },
            { name: post.title, path: `/blog/${post.slug}` },
          ]),
        ]}
      />
      <Link to="/blog" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
        &larr; All posts
      </Link>
      <div className="mt-6 flex flex-wrap items-center gap-2 text-xs text-ink-400">
        <span className="font-semibold text-bond-700">{post.category}</span>
        {post.published_at && (
          <>
            <span aria-hidden>·</span>
            <time dateTime={post.published_at}>{formatDate(post.published_at)}</time>
          </>
        )}
        {post.read_minutes ? (
          <>
            <span aria-hidden>·</span>
            <span>{post.read_minutes} min read</span>
          </>
        ) : null}
        {post.author && (
          <>
            <span aria-hidden>·</span>
            <span>{post.author}</span>
          </>
        )}
        {!post.published && <DraftTag />}
      </div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">{post.title}</h1>
      {post.excerpt && <p className="mt-4 text-lg leading-relaxed text-ink-600">{post.excerpt}</p>}
      <div
        className="prose-n409 mt-10 space-y-5 text-[0.95rem] leading-relaxed text-ink-700"
        // Sanitised server-side on write with the report content policy, and
        // again here with the identical allowlist — idempotent on anything
        // written through the API, and still a guard on a row that reached the
        // table another way. This one is public and unauthenticated.
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(post.body_html) }}
      />
    </article>
  );
}
