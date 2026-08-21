import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketingRoutes } from '../src/lib/routes';

/**
 * Internal links in the seeded article library resolve to real routes.
 *
 * This assertion is genuinely cross-package: the articles live in the
 * valuation service's migrations, and the route table that says whether
 * `/products/asc-718` exists lives here. Splitting it across two suites would
 * leave nobody checking it, and the failure it catches is the quiet kind —
 * `/products/asc-718` versus `/products/asc-718-valuation` renders a 404 page
 * from inside an article that reads perfectly well.
 *
 * The valuation service's own `blogLibrary.test.ts` covers everything about a
 * seeded post that does not need the route table.
 */

// Not `new URL('…', import.meta.url)`: Vite rewrites that pattern at transform
// time as an asset reference, and what comes back is no longer a file URL.
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../valuation/migrations',
);

function seedSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .filter((sql) => sql.includes('INSERT INTO blog_posts'))
    .join('\n');
}

/** The slug column always follows the id column, which is what disambiguates it. */
function seededSlugs(sql: string): string[] {
  return [...sql.matchAll(/'[0-9A-HJKMNP-TV-Z]{26}',\s*'([a-z0-9-]+)',/g)].map((m) => m[1]!);
}

/** Site-relative hrefs only — external links are not ours to validate. */
function internalLinks(sql: string): string[] {
  return [...sql.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]!);
}

describe('seeded blog library links', () => {
  const sql = seedSql();
  const slugs = seededSlugs(sql);
  const links = internalLinks(sql);

  const known = new Set<string>([...marketingRoutes().map((r) => r.path), ...slugs.map((s) => `/blog/${s}`)]);

  /** Each row runs from its id to the `\n)` that closes it — both terminators. */
  const rows = (): { slug: string; body: string }[] =>
    [...sql.matchAll(/'[0-9A-HJKMNP-TV-Z]{26}',\s*'([a-z0-9-]+)',([\s\S]*?)(?=\n\))/g)].map((m) => ({
      slug: m[1]!,
      body: m[2]!,
    }));

  it('finds links to check', () => {
    // Without this the suite passes on an empty set, which is exactly the state
    // it exists to prevent — articles that link nowhere convert nobody.
    expect(slugs.length).toBeGreaterThanOrEqual(51);
    expect(links.length).toBeGreaterThanOrEqual(slugs.length);
  });

  it('gives every post a way out of itself', () => {
    // The aggregate floor above is satisfied by one article carrying fifty
    // links, which is not what it is for. A piece that ends without a route to
    // a product, a guide or another article is a reader who read and left, and
    // it is also the shape a crawler treats as a dead end.
    const orphans = rows()
      .filter(({ body }) => !/href="\//.test(body))
      .map(({ slug }) => slug);
    expect(orphans).toEqual([]);
  });

  it('points more than one article at each of the money pages', () => {
    // The library exists to feed the pages that convert. A product page that no
    // article links to ranks on its own or not at all, and the batches are
    // large enough now that this is checked rather than assumed.
    for (const path of ['/pricing', '/sample-report', '/contact']) {
      const from = rows().filter(({ body }) => body.includes(`href="${path}"`));
      expect(from.length, `only ${from.length} article(s) link to ${path}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('resolves every internal link to a real route', () => {
    const broken = links.map((href) => href.split('#')[0]!.split('?')[0]!).filter((path) => !known.has(path));
    expect([...new Set(broken)]).toEqual([]);
  });

  it('never links an article to itself', () => {
    // A self-link is dead weight in the body and a self-referential internal
    // link to a crawler. It happens when a post is copied to start a new one.
    // Each row runs from its id to the `\n)` that closes it — which is how
    // both row terminators start, `),` mid-list and `) ON CONFLICT` at the end.
    const bySlug = [...sql.matchAll(/'[0-9A-HJKMNP-TV-Z]{26}',\s*'([a-z0-9-]+)',([\s\S]*?)(?=\n\))/g)];
    expect(bySlug.length).toBe(slugs.length);
    for (const [, slug, body] of bySlug) {
      expect(body!.includes(`href="/blog/${slug}"`), `${slug} links to itself`).toBe(false);
    }
  });
});
