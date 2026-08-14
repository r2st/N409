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

  const known = new Set<string>([
    ...marketingRoutes().map((r) => r.path),
    ...slugs.map((s) => `/blog/${s}`),
  ]);

  it('finds links to check', () => {
    // Without this the suite passes on an empty set, which is exactly the state
    // it exists to prevent — articles that link nowhere convert nobody. One
    // link per seeded post is the floor, not the target.
    expect(slugs.length).toBeGreaterThanOrEqual(11);
    expect(links.length).toBeGreaterThanOrEqual(slugs.length);
  });

  it('resolves every internal link to a real route', () => {
    const broken = links
      .map((href) => href.split('#')[0]!.split('?')[0]!)
      .filter((path) => !known.has(path));
    expect([...new Set(broken)]).toEqual([]);
  });

  it('never links an article to itself', () => {
    // A self-link is dead weight in the body and a self-referential internal
    // link to a crawler. It happens when a post is copied to start a new one.
    // Each row runs from its id to the `\n)` that closes it — which is how
    // both row terminators start, `),` mid-list and `) ON CONFLICT` at the end.
    const bySlug = [
      ...sql.matchAll(/'[0-9A-HJKMNP-TV-Z]{26}',\s*'([a-z0-9-]+)',([\s\S]*?)(?=\n\))/g),
    ];
    expect(bySlug.length).toBe(slugs.length);
    for (const [, slug, body] of bySlug) {
      expect(body!.includes(`href="/blog/${slug}"`), `${slug} links to itself`).toBe(false);
    }
  });
});
