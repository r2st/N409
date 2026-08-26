import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every spreadsheet an export hands out has to say whether it is the whole
 * answer (R169).
 *
 * `truncationOf` and `sendExport` exist because a capped export is the one
 * failure a reader cannot see: a CSV that stops at ten thousand rows looks
 * exactly like a CSV of ten thousand rows, and the rows past the cap are, by
 * construction, the ones nobody thinks to look for. The valuations export got
 * that treatment when the pair was written. The two exports beside it did not,
 * and both were capped:
 *
 *   - `GET /users/export` asked `listUsers` for 10,000 accounts and discarded
 *     the `total` it was handed back;
 *   - `GET /valuations/:id/audit-trail.csv` destructured around the `truncated`
 *     that `loadTrail` had computed for it — while the JSON view of the same
 *     trail, twenty lines above, returned it.
 *
 * Neither is the kind of thing a test about content would catch, because
 * nothing about either file is wrong. So the census asks the structural
 * question instead: a route handler that serves a spreadsheet content type
 * either goes through `sendExport`, or is named below with what makes its
 * output bounded by something other than a cap.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(here, '../../src/routes');

/**
 * Exports whose size is set by the request rather than by a cap.
 *
 * An exemption states why the file cannot be short — never merely that nobody
 * has got to it.
 */
const EXEMPT: Record<string, string> = {
  'compare.ts /api/v1/valuations/compare':
    'A comparison of exactly two valuations. Every row is a metric from a fixed ' +
    'register, so the file is the same length whatever the engagements hold.',
  'exports.ts /api/v1/valuations/:id/workbook.xlsx':
    'Refuses rather than truncates. Past GRANT_PAGE_LIMIT grants it 422s with ' +
    'the reason, on the stated ground that a workbook an auditor reconciles the ' +
    'option pool against must not be buildable from a partial grant set — a ' +
    'stronger answer than a flag, and the one this census would accept second.',
};

/** `.header('content-type', 'text/csv…')` and the XLSX constant beside it. */
const SPREADSHEET_TYPE = /'text\/csv|XLSX_CONTENT_TYPE/;

interface Handler {
  /** `app.get('/api/v1/...` — the path, for a legible failure. */
  route: string;
  body: string;
}

/**
 * Route handlers of a module, each sliced at the next `app.<verb>(` — the same
 * naive split the other route censuses use, and adequate for the question:
 * a handler that serves a spreadsheet contains both the content type and, if it
 * is correct, the `sendExport` call, and neither can drift into a neighbour
 * without the neighbour also matching.
 */
function handlers(src: string): Handler[] {
  const starts = [...src.matchAll(/app\.(?:get|post)\(\s*'([^']+)'/g)];
  return starts.map((m, i) => ({
    route: m[1]!,
    body: src.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index! : src.length),
  }));
}

/** Code only: these files discuss truncation in prose at length. */
function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
}

function silentExports(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(ROUTES, file), 'utf8');
    for (const handler of handlers(src)) {
      const key = `${file} ${handler.route}`;
      if (key in EXEMPT) continue;
      const body = code(handler.body);
      if (!SPREADSHEET_TYPE.test(body)) continue;
      if (!/\bsendExport\(/.test(body)) found.push(key);
    }
  }
  return found.sort();
}

describe('export truncation census', () => {
  it('every spreadsheet export reports whether it was cut short', () => {
    expect(silentExports()).toEqual([]);
  });

  /**
   * The census is only worth anything if it can see the handlers it claims to
   * scan. A regex that matched nothing — a route file renamed, `app.get`
   * written differently — would pass by having nothing left to ask.
   */
  it('finds the exports it is asserting about', () => {
    const scanned: string[] = [];
    for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(path.join(ROUTES, file), 'utf8');
      for (const handler of handlers(src)) {
        if (SPREADSHEET_TYPE.test(code(handler.body))) scanned.push(`${file} ${handler.route}`);
      }
    }
    expect(scanned).toEqual(
      expect.arrayContaining([
        'adminUsers.ts /api/v1/users/export',
        'auditTrail.ts /api/v1/valuations/:id/audit-trail.csv',
        'compare.ts /api/v1/valuations/compare',
        'exports.ts /api/v1/valuations/export',
        'exports.ts /api/v1/valuations/:id/workbook.xlsx',
      ]),
    );
  });

  /** An exemption with no handler behind it is a rule nobody is being held to. */
  it('exempts only routes that exist and still serve a spreadsheet', () => {
    const live = new Set<string>();
    for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(path.join(ROUTES, file), 'utf8');
      for (const handler of handlers(src)) {
        if (SPREADSHEET_TYPE.test(code(handler.body))) live.add(`${file} ${handler.route}`);
      }
    }
    expect(Object.keys(EXEMPT).filter((k) => !live.has(k))).toEqual([]);
  });
});
