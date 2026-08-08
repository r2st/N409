import type pg from 'pg';
import { newUlid } from '@n409/shared';

/** The marketing blog (design §16.2). Shaped on `helpArticles.ts` — see 0122. */

export interface BlogPostRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body_html: string;
  category: string;
  keywords: string;
  author: string;
  og_image: string | null;
  published: boolean;
  published_at: Date | null;
  author_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The index.
 *
 * Drafts sort first when they are included, and only then by date: an ops user
 * opening the admin list is looking for the thing that is not live yet, and a
 * draft buried between two published posts from last year is a draft nobody
 * finds. The public list never sees them at all.
 */
export async function listPosts(
  pool: pg.Pool,
  opts: { includeDrafts?: boolean; limit?: number } = {},
): Promise<BlogPostRow[]> {
  const { rows } = await pool.query<BlogPostRow>(
    `SELECT * FROM blog_posts
      ${opts.includeDrafts ? '' : 'WHERE published'}
      ORDER BY published DESC NULLS LAST, published_at DESC NULLS FIRST, created_at DESC
      LIMIT $1`,
    [opts.limit ?? 200],
  );
  return rows;
}

export async function findPostBySlug(pool: pg.Pool, slug: string): Promise<BlogPostRow | null> {
  const { rows } = await pool.query<BlogPostRow>('SELECT * FROM blog_posts WHERE slug = $1', [slug]);
  return rows[0] ?? null;
}

export async function findPostById(pool: pg.Pool, id: string): Promise<BlogPostRow | null> {
  const { rows } = await pool.query<BlogPostRow>('SELECT * FROM blog_posts WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export interface BlogPostInput {
  slug: string;
  title: string;
  excerpt: string;
  body_html: string;
  category: string;
  keywords: string;
  author: string;
  og_image: string | null;
  published: boolean;
  /**
   * Explicit publication date. Null means "stamp it now if this is being
   * published" — see `resolvePublishedAt`, which is where that decision lives
   * rather than in each caller.
   */
  published_at: Date | null;
}

/**
 * When a post says it was published.
 *
 * First publish stamps now. Every later edit keeps whatever date the post
 * already carried, because a typo fixed in March must not re-date a January
 * article — the index would reorder and every crawler that indexed it would
 * see the piece as new. An explicit date always wins: back-dating a migrated
 * article is a real need and the only way to express it.
 */
export function resolvePublishedAt(
  current: Date | null,
  next: { published: boolean; published_at?: Date | null },
  now: Date,
): Date | null {
  if (next.published_at !== undefined && next.published_at !== null) return next.published_at;
  if (!next.published) return current;
  return current ?? now;
}

export async function createPost(
  pool: pg.Pool,
  input: BlogPostInput,
  authorId: string,
): Promise<BlogPostRow> {
  const publishedAt = resolvePublishedAt(null, input, new Date());
  const { rows } = await pool.query<BlogPostRow>(
    `INSERT INTO blog_posts
       (id, slug, title, excerpt, body_html, category, keywords, author, og_image,
        published, published_at, author_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      newUlid(),
      input.slug,
      input.title,
      input.excerpt,
      input.body_html,
      input.category,
      input.keywords,
      input.author,
      input.og_image,
      input.published,
      publishedAt,
      authorId,
    ],
  );
  return rows[0]!;
}

export async function updatePost(
  pool: pg.Pool,
  id: string,
  patch: Partial<BlogPostInput>,
  authorId: string,
): Promise<BlogPostRow | null> {
  const existing = await findPostById(pool, id);
  if (!existing) return null;

  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  for (const key of [
    'slug',
    'title',
    'excerpt',
    'body_html',
    'category',
    'keywords',
    'author',
    'og_image',
    'published',
  ] as const) {
    if (patch[key] !== undefined) set(key, patch[key]);
  }
  // Recomputed on every write rather than only when `published` is in the
  // patch: the CHECK constraint requires a published post to carry a date, and
  // a patch that flips the flag without one would otherwise fail at the
  // database rather than be resolved here.
  set(
    'published_at',
    resolvePublishedAt(
      existing.published_at,
      { published: patch.published ?? existing.published, published_at: patch.published_at },
      new Date(),
    ),
  );
  set('author_id', authorId);
  params.push(id);
  const { rows } = await pool.query<BlogPostRow>(
    `UPDATE blog_posts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

export async function deletePost(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM blog_posts WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
