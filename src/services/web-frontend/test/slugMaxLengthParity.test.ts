import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The two slug boxes and the two services that own their ceilings.
 *
 * Both consoles restate a server rule in an HTML attribute — the browser
 * cannot import the service — and a `maxLength` is the only thing standing
 * between an author and a refusal they cannot act on: the length rule is not
 * one of the field's validators, so a slug past the ceiling is not caught on
 * blur. It goes over the wire and comes back 422, rendered as a banner at the
 * top of the form rather than beside the box it is about, which is the shape
 * `lib/useFormValidation.ts` exists to remove.
 *
 * The blog box said 120 against the service's 100. The help box has always
 * said 100. Reading both source files is what keeps the pair honest when
 * either side moves — a fixture asserting "100" twice would agree with itself
 * and not with the server (see the parity notes in `passwordPolicy.test.ts`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8');

/** The `.max(n)` on the service's `Slug` schema. */
function serviceSlugMax(source: string): number {
  const slug = source.match(/const Slug = z[\s\S]*?;/);
  expect(slug, 'the service still declares a `Slug` schema').toBeTruthy();
  const max = slug![0].match(/\.max\((?:SLUG_MAX|(\d+))\)/);
  expect(max, 'the `Slug` schema still carries a `.max()`').toBeTruthy();
  if (max![1]) return Number(max![1]);
  const named = source.match(/const SLUG_MAX = (\d+);/);
  expect(named, 'SLUG_MAX is still declared').toBeTruthy();
  return Number(named![1]);
}

/** The `maxLength={n}` on the page's slug box. */
function pageSlugMaxLength(source: string): number {
  const field = source.match(/label="Slug"[\s\S]*?maxLength=\{(\d+)\}/);
  expect(field, 'the page still has a Slug box with a maxLength').toBeTruthy();
  return Number(field![1]);
}

describe('a slug box stops where its service does', () => {
  it('the blog console matches routes/blog.ts', () => {
    const max = serviceSlugMax(read('../../valuation/src/routes/blog.ts'));
    expect(max).toBe(100);
    expect(pageSlugMaxLength(read('../src/pages/AdminBlogPage.tsx'))).toBe(max);
  });

  it('the help console matches routes/help.ts', () => {
    const max = serviceSlugMax(read('../../valuation/src/routes/help.ts'));
    expect(max).toBe(100);
    expect(pageSlugMaxLength(read('../src/pages/AdminHelpPage.tsx'))).toBe(max);
  });
});
