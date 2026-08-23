import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A 401 means "your session is over" almost everywhere, and `api()` acts on
 * that: it clears the token and raises `UNAUTHORIZED_EVENT`, which
 * `AuthProvider` turns into a sign-out. Almost — a handful of endpoints answer
 * 401 for a credential that is not the session, and signing out on those would
 * end a live session over something that was never about it.
 *
 * The product already keeps both halves of that straight, but by two different
 * mechanisms and neither states the rule: the credential-exchange endpoints are
 * named in `api.ts`, while the client-intake and auditor portals avoid `api()`
 * altogether and call `fetch` directly. Nothing said why, so a later tidy-up
 * that routed a portal page through the shared client — the obviously
 * consistent thing to do — would sign an analyst out of their own session the
 * moment a client's intake link expired in the same browser.
 *
 * This reads both halves out of the source rather than restating them, so it
 * cannot pass by agreeing with a stale copy of either.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = `${path.resolve(HERE, '../../valuation/src/routes')}/`;
const FRONTEND_SRC = `${path.resolve(HERE, '../src')}/`;
const API_CLIENT = path.resolve(HERE, '../src/lib/api.ts');

/** Route registrations, with the block of source each one owns. */
const REGISTRATION = /\bapp\.(get|post|put|patch|delete)\(\s*\n?\s*'(\/api\/v1[^']*)'/g;
/** Whatever the codebase uses to say "a session is required here". */
const SESSION_GUARD = /app\.authenticate\b|app\.authenticateAuditor\b|requireApiKey\b/;

/**
 * Endpoints that answer 401 without a session guard in front of them — that is,
 * every route where a 401 is about the credential in the request rather than
 * about the caller's session.
 */
function openUnauthorizedRoutes(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(ROUTES_DIR + file, 'utf8');
    const hits = [...src.matchAll(REGISTRATION)];
    for (let i = 0; i < hits.length; i++) {
      const block = src.slice(hits[i]!.index, hits[i + 1]?.index ?? src.length);
      if (SESSION_GUARD.test(block)) continue;
      if (!/problems\.unauthorized/.test(block)) continue;
      found.push(hits[i]![2]!.replace('/api/v1', ''));
    }
  }
  return [...new Set(found)].sort();
}

/** Every `.ts`/`.tsx` under the frontend's src. */
function frontendSources(dir = FRONTEND_SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? frontendSources(`${dir}${e.name}/`) : /\.tsx?$/.test(e.name) ? [`${dir}${e.name}`] : [],
  );
}

/**
 * The paths the frontend passes to the session client, as the literal part of
 * each — a template's static head is enough to say which endpoint it is,
 * because the interpolation is always an id further down the path.
 */
function pathsSentThroughApiClient(): { path: string; file: string }[] {
  const CALL = /\b(?:api|apiUpload|apiDownload)\s*(?:<[^>]*>)?\s*\(\s*(['`])([^'`$]*)/g;
  const out: { path: string; file: string }[] = [];
  for (const file of frontendSources()) {
    if (file === API_CLIENT) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(CALL)) {
      const p = m[2]!;
      if (p.startsWith('/')) out.push({ path: p, file: file.slice(FRONTEND_SRC.length) });
    }
  }
  return out;
}

/** The exclusion list `api.ts` actually applies, read from its source. */
function declaredExclusions(): string[] {
  const src = readFileSync(API_CLIENT, 'utf8');
  const set = /const CREDENTIAL_EXCHANGE = new Set\(\[([^\]]*)\]\)/.exec(src);
  expect(set, 'api.ts no longer declares CREDENTIAL_EXCHANGE as a literal set').not.toBeNull();
  return [...set![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
}

/** True when `callPath` addresses `route` (exactly, or as a prefix of a longer path). */
function addresses(callPath: string, route: string): boolean {
  return callPath === route || callPath.startsWith(`${route}/`) || route.startsWith(callPath);
}

describe('a 401 that is not the end of a session', () => {
  const open = openUnauthorizedRoutes();
  const calls = pathsSentThroughApiClient();

  it('finds the routes and the call sites at all — neither half may be empty', () => {
    // Without these, every assertion below passes by having nothing to check.
    expect(open).toContain('/intake/portal');
    expect(open).toContain('/auditor/portal');
    expect(open.length).toBeGreaterThanOrEqual(6);
    expect(calls.length).toBeGreaterThan(100);
  });

  it('is reached through the session client only where api.ts names it', () => {
    const excluded = new Set(declaredExclusions());
    const unguarded = calls
      .filter((c) => open.some((r) => addresses(c.path, r) && !excluded.has(r)))
      .map((c) => `${c.file} → ${c.path}`);
    expect(
      unguarded,
      'these calls would sign the user out over a credential that is not their session — ' +
        'call fetch directly, or add the route to CREDENTIAL_EXCHANGE in src/lib/api.ts',
    ).toEqual([]);
  });

  it('excludes nothing that is a real session 401', () => {
    // The other direction: the exclusion list must not grow to cover a route
    // whose 401 *does* mean the session is over, which would leave the user
    // stuck in a signed-in shell that cannot load anything.
    for (const path of declaredExclusions()) {
      expect(open, `${path} is excluded from the sign-out but is not an open-401 route`).toContain(path);
    }
  });

  it('keeps the portal pages off the session client entirely', () => {
    // Named rather than derived: these two pages are opened by people who are
    // not users of the product at all, in a browser that may hold an analyst's
    // session, so the rule for them is stronger than "do not call this one
    // endpoint" — they must not carry the session anywhere.
    for (const page of ['pages/ClientIntakePage.tsx', 'pages/AuditorPortalPage.tsx']) {
      const src = readFileSync(FRONTEND_SRC + page, 'utf8');
      expect(src, `${page} must reach its endpoints with fetch, not the session client`).not.toMatch(
        /from '\.\.\/lib\/api'/,
      );
      expect(src).toMatch(/fetch\(/);
    }
  });
});
