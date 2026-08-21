import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every door the stored report PDF leaves by is accounted for, or this fails.
 *
 * `report_versions.pdf` holds the *deliverable*: the canonical render, with no
 * draft stamp on it, frozen so a published version keeps the concluded value
 * the client was given. Whether the reader is being handed a draft is decided
 * when the bytes are served, by `deliverablePdf` — which is the only thing that
 * knows to render a stamped copy for an engagement that has not published yet.
 *
 * That makes every route reading those bytes a place the mark can go missing,
 * and three of them existed the day the stamp was written: the session
 * download, the partner API, and the evidence bundle an auditor receives. Two
 * were found by grep, which is exactly the search that misses the fourth.
 *
 * So this is the census. `getVersion` is the only way to a stored PDF, so a
 * file that calls it must either be shown not to touch `.pdf` at all, or route
 * what it reads through `deliverablePdf`. A new route serving the deliverable
 * cannot ship without somebody deciding, here, which of those it is.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(here, '../../src/routes');

/** Route files that read a stored report version, and what they do with it. */
const DECIDED: Record<string, 'serves the pdf' | 'reads the content only'> = {
  'reports.ts': 'serves the pdf',
  'partnerApi.ts': 'serves the pdf',
  'evidence.ts': 'serves the pdf',
  // The auditor bundle ships the authored body as JSON — the conclusion and the
  // assumptions, deliberately not the deliverable (see the note on the route).
  'auditorPortal.ts': 'reads the content only',
  // The publish gate grades the resolved body; it never renders one.
  'qa.ts': 'reads the content only',
};

const sourceOf = (file: string): string => readFileSync(join(ROUTES, file), 'utf8');

describe('the doors a stored report PDF leaves by', () => {
  const readers = readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /\bgetVersion\s*\(/.test(sourceOf(f)));

  it('is a list somebody has decided about', () => {
    expect(readers.sort()).toEqual(Object.keys(DECIDED).sort());
  });

  it('serves nothing straight from the store without the stamp decision', () => {
    const undecided = readers.filter((file) => {
      const src = sourceOf(file);
      // `.pdf` on a version row is the tell: reading it is serving it.
      const touchesBytes = /\.pdf\b(?!')/.test(src.replace(/report\.pdf|\.pdf["'`]/g, ''));
      if (DECIDED[file] === 'reads the content only') return touchesBytes;
      return !/deliverablePdf\s*\(/.test(src);
    });
    expect(undecided).toEqual([]);
  });

  it('leaves exactly one implementation of the decision', () => {
    // Every caller reaches the same function. Two copies of a rule like this is
    // one of them being wrong, and the wrong one is the one nobody looks at.
    const definitions = readdirSync(ROUTES)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /export async function deliverablePdf/.test(sourceOf(f)));
    expect(definitions).toEqual(['reports.ts']);
  });
});
