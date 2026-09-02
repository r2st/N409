import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { DOWNLOAD_CACHE_CONTROL, registerDownloadCacheControl } from '../../src/plugins/downloadCache.js';

/**
 * Every response that is a file carries a caching directive, and the ones that
 * are somebody's file say `no-store`.
 *
 * WHY (R349, methodology M4). `content-disposition` is what makes a response a
 * file rather than a payload: it tells a browser to save the bytes, and names
 * them. Sixteen routes on this service set it, and until R349 two of them said
 * anything about caching. Both said `no-store`, and `routes/account.ts` gives
 * the reason in full — a file of somebody's personal data has no business in a
 * shared cache, and `no-store` is the directive that also keeps it off the disk
 * of a machine they may not own.
 *
 * The other fourteen are the same kind of object. The one that matters most is
 * `GET /api/v1/valuations/:id/report.pdf`: a concluded fair market value for a
 * named client, at a URL whose path ends in `.pdf`, behind a Cloudflare proxy
 * whose default cacheability is keyed on exactly that extension, authenticated
 * by a cookie that the response does not echo. Nothing in that exchange tells
 * the edge the body belongs to one person.
 *
 * ## The two directions
 *
 * The population is derived from the source rather than listed, for the reason
 * every census in this suite is: a list is a thing somebody has to remember to
 * add to, and the seventeenth download door is written by somebody who has not
 * read this file. Both directions are asserted, because either alone can be
 * satisfied by the wrong code:
 *
 *   * the *doors* are named, so a regex that stopped matching fails here
 *     rather than passing by finding nothing to check;
 *   * the *hook* is what supplies the header, so a route deleting it or the
 *     registration disappearing from `app.ts` is a failure even though every
 *     route file still reads exactly as it does today.
 *
 * The end-to-end half — a real request coming back with the header on it —
 * lives in `reportDownloadCache.test.ts`, which needs a database.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const ROUTES = path.join(SRC, 'routes');

/** Route files that answer with a `content-disposition` header. */
function downloadDoors(): { file: string; line: number }[] {
  const found: { file: string; line: number }[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const lines = readFileSync(path.join(ROUTES, file), 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (/['"]content-disposition['"]/i.test(text)) found.push({ file, line: i + 1 });
    });
  }
  return found;
}

const DOORS = downloadDoors();

describe('every download door is covered by a caching directive', () => {
  it('finds the doors it is auditing', () => {
    // Named, not counted: the whole population is sixteen lines across eleven
    // files, and a typo in the pattern empties it completely.
    expect([...new Set(DOORS.map((d) => d.file))].sort()).toEqual([
      'account.ts',
      'adminUsers.ts',
      'auditTrail.ts',
      'billing.ts',
      'compare.ts',
      'documents.ts',
      'evidence.ts',
      'exports.ts',
      'partnerApi.ts',
      'payments.ts',
      'reports.ts',
      'sampleReport.ts',
    ]);
    expect(DOORS.length).toBeGreaterThanOrEqual(16);
  });

  it('the hook that stamps them is registered, and stamps no-store', () => {
    const app = readFileSync(path.join(SRC, 'app.ts'), 'utf8');
    expect(app).toMatch(/registerDownloadCacheControl\(app\)/);
    expect(DOWNLOAD_CACHE_CONTROL).toMatch(/\bno-store\b/);
  });

  it('stamps a file response, leaves a payload alone, and defers to a route', async () => {
    // The mechanism, rather than the source. A census that only reads text
    // passes just as happily when the hook has been registered on a scope
    // nothing routes through.
    const app = Fastify();
    registerDownloadCacheControl(app);
    app.get('/file', async (_req, reply) =>
      reply.header('content-disposition', 'attachment; filename="x.pdf"').send('bytes'),
    );
    app.get('/payload', async () => ({ ok: true }));
    app.get('/public', async (_req, reply) =>
      reply
        .header('content-disposition', 'attachment; filename="sample.pdf"')
        .header('cache-control', 'public, max-age=3600')
        .send('bytes'),
    );

    expect((await app.inject({ method: 'GET', url: '/file' })).headers['cache-control']).toBe(
      DOWNLOAD_CACHE_CONTROL,
    );
    // Not every response — a JSON list is not a file, and `no-store` on the
    // whole API would take the conditional-GET endpoints down with it.
    expect((await app.inject({ method: 'GET', url: '/payload' })).headers['cache-control']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/public' })).headers['cache-control']).toBe(
      'public, max-age=3600',
    );
    await app.close();
  });

  it('the only route allowed to opt out of no-store is the public sample', () => {
    // A route may set its own `cache-control` — the hook defers to it — so the
    // opt-out is real and has to be watched. Anything cacheable by a shared
    // cache must be a document with no client in it; today that is the
    // marketing sample and nothing else.
    const shared: string[] = [];
    for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(ROUTES, file), 'utf8');
      for (const m of source.matchAll(/['"]cache-control['"]\s*,\s*['"]([^'"]+)['"]/gi)) {
        if (/\bpublic\b|max-age=[1-9]/i.test(m[1]!)) shared.push(`${file}: ${m[1]}`);
      }
    }
    expect(shared).toEqual(['sampleReport.ts: public, max-age=3600']);
  });
});
