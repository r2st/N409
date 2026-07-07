import type pg from 'pg';
import { newUlid } from '@n409/shared';

/** Help / knowledge base articles (P2 #10). */

export interface HelpArticleRow {
  id: string;
  slug: string;
  title: string;
  category: string;
  keywords: string;
  body_html: string;
  sort_order: number;
  published: boolean;
  author_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function listArticles(
  pool: pg.Pool,
  opts: { includeUnpublished?: boolean } = {},
): Promise<HelpArticleRow[]> {
  const { rows } = await pool.query<HelpArticleRow>(
    `SELECT * FROM help_articles
     ${opts.includeUnpublished ? '' : 'WHERE published'}
     ORDER BY category ASC, sort_order ASC, title ASC`,
  );
  return rows;
}

export async function findArticleBySlug(
  pool: pg.Pool,
  slug: string,
): Promise<HelpArticleRow | null> {
  const { rows } = await pool.query<HelpArticleRow>('SELECT * FROM help_articles WHERE slug = $1', [
    slug,
  ]);
  return rows[0] ?? null;
}

export async function findArticleById(pool: pg.Pool, id: string): Promise<HelpArticleRow | null> {
  const { rows } = await pool.query<HelpArticleRow>('SELECT * FROM help_articles WHERE id = $1', [
    id,
  ]);
  return rows[0] ?? null;
}

export interface HelpArticleInput {
  slug: string;
  title: string;
  category: string;
  keywords: string;
  body_html: string;
  sort_order: number;
  published: boolean;
}

export async function createArticle(
  pool: pg.Pool,
  input: HelpArticleInput,
  authorId: string,
): Promise<HelpArticleRow> {
  const { rows } = await pool.query<HelpArticleRow>(
    `INSERT INTO help_articles (id, slug, title, category, keywords, body_html, sort_order, published, author_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      newUlid(),
      input.slug,
      input.title,
      input.category,
      input.keywords,
      input.body_html,
      input.sort_order,
      input.published,
      authorId,
    ],
  );
  return rows[0]!;
}

export async function updateArticle(
  pool: pg.Pool,
  id: string,
  patch: Partial<HelpArticleInput>,
  authorId: string,
): Promise<HelpArticleRow | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  for (const key of ['slug', 'title', 'category', 'keywords', 'body_html', 'sort_order', 'published'] as const) {
    if (patch[key] !== undefined) set(key, patch[key]);
  }
  set('author_id', authorId);
  params.push(id);
  const { rows } = await pool.query<HelpArticleRow>(
    `UPDATE help_articles SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

export async function deleteArticle(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM help_articles WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
