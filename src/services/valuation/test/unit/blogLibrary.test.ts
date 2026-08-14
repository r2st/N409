import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sanitizeHtml } from '../../src/domain/report.js';

/**
 * The seeded article library (migrations 0122 and 0142+).
 *
 * These posts are authored as SQL rather than entered through the admin UI,
 * which means nothing validates them until the migration runs against a real
 * database — and by then a body that exceeds the API's limit, or a slug that
 * collides with one seeded three migrations earlier, is a failed deploy rather
 * than a failed test.
 *
 * The check that earns its keep is sanitizer stability. `POST /blog/posts`
 * sanitizes on write, so anything an author used that is not on the whitelist
 * is dropped *silently*: the migration succeeds, the page renders, and a
 * paragraph is simply missing. Asserting the body is a fixed point of
 * `sanitizeHtml` catches that here, where the diff is still in front of you.
 *
 * Parsing rather than querying keeps this a unit test. Everything it can get
 * wrong is textual, and requiring Postgres to find a too-long excerpt would
 * mean nobody runs it.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const INSERT = 'INSERT INTO blog_posts';

interface SeededPost {
  file: string;
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  keywords: string;
  author: string;
  published: boolean;
  body: string;
}

/**
 * A text column, in either of the two forms the migrations use: single-quoted
 * with doubled apostrophes (0122) or dollar-quoted (0142 onwards, because
 * doubling every possessive in four thousand words of prose is how a migration
 * acquires a typo nobody sees until it is on a public page).
 *
 * `(?:[^']|'')*` cannot backtrack pathologically: at any position exactly one
 * of the two branches can match, so the alternation is deterministic.
 */
const TEXT = String.raw`(?:'((?:[^']|'')*)'|\$x\$([\s\S]*?)\$x\$)`;

/** Rows in the fixed column order the INSERT declares. */
const ROW = new RegExp(
  [
    String.raw`\(\s*'([0-9A-HJKMNP-TV-Z]{26})',`, // 1 id
    String.raw`\s*'([a-z0-9-]+)',`, // 2 slug
    String.raw`\s*${TEXT},`, // 3/4 title
    String.raw`\s*${TEXT},`, // 5/6 excerpt
    String.raw`\s*${TEXT},`, // 7/8 category
    String.raw`\s*${TEXT},`, // 9/10 keywords
    String.raw`\s*${TEXT},`, // 11/12 author
    String.raw`\s*(true|false),`, // 13 published
    String.raw`\s*[^,]+,`, // published_at — now(), or now() - interval '…'
    String.raw`\s*${TEXT}\s*\)`, // 14/15 body_html
  ].join(''),
  'g',
);

/** One id literal per row, used to check the parser saw every row there is. */
const ID_LINE = /^\s*'[0-9A-HJKMNP-TV-Z]{26}',$/gm;

/** Single-quoted SQL text unescapes; dollar-quoted text is already literal. */
function text(single: string | undefined, dollar: string | undefined): string {
  return single !== undefined ? single.replaceAll("''", "'") : dollar!;
}

function seedFiles(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(MIGRATIONS_DIR + file, 'utf8') }))
    .filter(({ sql }) => sql.includes(INSERT));
}

function seededPosts(): SeededPost[] {
  const posts: SeededPost[] = [];
  for (const { file, sql } of seedFiles()) {
    for (const m of sql.matchAll(ROW)) {
      posts.push({
        file,
        id: m[1]!,
        slug: m[2]!,
        title: text(m[3], m[4]),
        excerpt: text(m[5], m[6]),
        category: text(m[7], m[8]),
        keywords: text(m[9], m[10]),
        author: text(m[11], m[12]),
        published: m[13] === 'true',
        body: text(m[14], m[15]),
      });
    }
  }
  return posts;
}

/** Mirrors the zod schema in src/routes/blog.ts — the limits a write enforces. */
const LIMITS = { title: 200, excerpt: 500, category: 100, keywords: 500, author: 200, slug: 120 };

describe('seeded blog library', () => {
  const posts = seededPosts();

  it('parses every seeded post', () => {
    // A parser that silently matched nothing would make every assertion below
    // vacuously true, so the expected count comes from the raw SQL — counted
    // per file, from the INSERT onwards, because plenty of other migrations
    // seed rows with ulid literals of their own.
    const declared = seedFiles()
      .map(({ sql }) => sql.slice(sql.indexOf(INSERT)).match(ID_LINE)?.length ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(posts).toHaveLength(declared);
    expect(posts.length).toBeGreaterThanOrEqual(11);
  });

  it('gives every post a unique id and slug', () => {
    expect(new Set(posts.map((p) => p.id)).size).toBe(posts.length);
    const bySlug = new Map<string, string>();
    for (const p of posts) {
      // ON CONFLICT (slug) DO NOTHING means a duplicate is not an error at
      // deploy time — it is a post that silently never appears.
      expect(bySlug.get(p.slug), `slug "${p.slug}" reused in ${p.file}`).toBeUndefined();
      bySlug.set(p.slug, p.file);
    }
  });

  it('stays inside the limits the write API enforces', () => {
    for (const p of posts) {
      expect(p.slug.length, p.slug).toBeLessThanOrEqual(LIMITS.slug);
      expect(p.title.length, p.slug).toBeLessThanOrEqual(LIMITS.title);
      expect(p.excerpt.length, p.slug).toBeLessThanOrEqual(LIMITS.excerpt);
      expect(p.category.length, p.slug).toBeLessThanOrEqual(LIMITS.category);
      expect(p.keywords.length, p.slug).toBeLessThanOrEqual(LIMITS.keywords);
      expect(p.author.length, p.slug).toBeLessThanOrEqual(LIMITS.author);
      expect(p.body.length, p.slug).toBeLessThanOrEqual(200_000);
    }
  });

  it('survives the sanitizer unchanged', () => {
    for (const p of posts) {
      // Length first: a four-thousand-character diff names nothing, whereas a
      // length mismatch with the slug in the message points straight at it.
      const clean = sanitizeHtml(p.body);
      expect(clean.length, `${p.slug} loses markup to the sanitizer`).toBe(p.body.length);
      expect(clean).toBe(p.body);
    }
  });

  it('gives every post an excerpt, a byline and a real category', () => {
    for (const p of posts) {
      expect(p.excerpt.trim().length, p.slug).toBeGreaterThan(40);
      expect(p.author.trim(), p.slug).not.toBe('');
      // 'General' is the column default — a post that lands on it was never
      // categorised, and the index shows this next to every headline.
      expect(p.category, p.slug).not.toBe('General');
    }
  });

  it('writes articles rather than stubs', () => {
    for (const p of posts) {
      expect(p.body.length, `${p.slug} is too short to be an article`).toBeGreaterThan(1500);
      // An article with no subheadings is a wall of text nobody scans, and it
      // is also the shape that ranks worst.
      expect(p.body.match(/<h2>/g)?.length ?? 0, `${p.slug} has no <h2>`).toBeGreaterThanOrEqual(3);
    }
  });

  it('publishes every seeded post with a date', () => {
    for (const p of posts) {
      expect(p.published, p.slug).toBe(true);
    }
    // The table's own CHECK requires published_at when published; assert the
    // migrations supply one rather than leaving the constraint to fail a deploy.
    for (const { file, sql } of seedFiles()) {
      expect(sql, file).toMatch(/published_at/);
    }
  });
});
