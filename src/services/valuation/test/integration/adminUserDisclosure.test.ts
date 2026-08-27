import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * What an administrator is shown of an account, and what they were shown.
 *
 * `findUserById` is `SELECT u.*` and `createUser` is `RETURNING *`, so the row
 * these routes hold is every column of `users`. Five of them serialized it with
 * a single field blanked:
 *
 *     return { user: { ...updated, password_digest: undefined } };
 *
 * A denylist of one, over a table that has grown four credential-shaped columns
 * since it was written. What went out with the response was `totp_secret` —
 * the second factor's shared seed, which is the whole of the second factor —
 * plus `totp_last_counter`, `session_epoch` and `scim_external_id`. In
 * production the seed is sealed by `auth/mfaCrypto.ts`, so this was a
 * ciphertext; in development and test it is stored as the bare base32 string,
 * which is one paste into an authenticator app.
 *
 * The list route on the same resource has always mapped through an allow-list,
 * so the same account read two ways disclosed two different things — and the
 * frontend's `AdminUser` type is the allow-list, meaning nothing ever wanted
 * the extra fields.
 *
 * ## Why the forbidden set is derived and not listed
 *
 * A hand-written list of "don't leak these" is a list that stops being right
 * the next time a column lands on `users`. The set below is read out of the
 * migrations by shape, so a `webhook_secret` or an `sso_refresh_token` added to
 * the accounts table is covered by this test on the day it exists rather than
 * on the day somebody remembers.
 */

const dbUp = await isDbAvailable();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../migrations');

/** Every column `users` currently has, from the migrations. */
function userColumns(): Set<string> {
  const cols = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?users\s*\(([\s\S]*?)\n\s*\)\s*;/i.exec(sql);
    if (create)
      for (const line of create[1]!.split('\n')) {
        const m = /^\s*([a-z0-9_]+)\s+[a-z]/i.exec(line);
        if (m && !/^(primary|unique|constraint|check|foreign)$/i.test(m[1]!)) cols.add(m[1]!.toLowerCase());
      }
    for (const m of sql.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?users\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi,
    ))
      cols.add(m[1]!.toLowerCase());
    for (const m of sql.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?users\s+drop\s+column\s+(?:if\s+exists\s+)?([a-z0-9_]+)/gi,
    ))
      cols.delete(m[1]!.toLowerCase());
  }
  return cols;
}

/**
 * Columns of `users` that must never appear in a response body.
 *
 * Credential material and session bookkeeping. `totp_enabled` and
 * `totp_confirmed_at` are deliberately *not* in the family — they are
 * predicates about the second factor rather than the second factor, the
 * `has_password` distinction the redact list makes — but they are not in the
 * allow-list either, so they do not go out today.
 */
const FORBIDDEN = /(^|_)(digest|secret|token|key|password|epoch|counter|external_id)$/;

const forbidden = [...userColumns()].filter((c) => FORBIDDEN.test(c)).sort();

/** Every key anywhere in a JSON value, however deep. */
function keysOf(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

describe.skipIf(!dbUp)('what the admin user routes disclose', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  it('recognises the columns it is supposed to be policing', () => {
    // Vacuity guard. If the migration parse or the shape pattern stopped
    // matching, every assertion below would pass by having nothing to look
    // for — and would keep passing after the leak came back.
    expect(forbidden).toContain('password_digest');
    expect(forbidden).toContain('totp_secret');
    expect(forbidden).toContain('session_epoch');
    expect(forbidden.length).toBeGreaterThanOrEqual(4);
  });

  it('never returns a credential column from any user-shaped route', async () => {
    const target = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(admin.token),
      payload: {
        email: `created-${target.id.toLowerCase()}@test.example.com`,
        password: 'Str0ng-Test-Passw0rd!x',
        roles: ['valuation_user'],
      },
    });
    expect(created.statusCode).toBe(201);

    const responses: Record<string, unknown> = { created: created.json() };

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${target.id}`,
      headers: authHeader(admin.token),
      payload: { job_title: 'Analyst' },
    });
    expect(patched.statusCode).toBe(200);
    responses.patched = patched.json();

    const promoted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${target.id}/promote`,
      headers: authHeader(admin.token),
      payload: { role: 'reviewer' },
    });
    expect(promoted.statusCode).toBe(200);
    responses.promoted = promoted.json();

    const demoted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${target.id}/demote`,
      headers: authHeader(admin.token),
      payload: { role: 'reviewer' },
    });
    expect(demoted.statusCode).toBe(200);
    responses.demoted = demoted.json();

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${target.id}`,
      headers: authHeader(admin.token),
    });
    expect(deleted.statusCode).toBe(204);

    const restored = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${target.id}/restore`,
      headers: authHeader(admin.token),
    });
    expect(restored.statusCode).toBe(200);
    responses.restored = restored.json();

    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: authHeader(admin.token),
    });
    expect(listed.statusCode).toBe(200);
    responses.listed = listed.json();

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: authHeader(admin.token),
    });
    expect(me.statusCode).toBe(200);
    responses.me = me.json();

    for (const [where, body] of Object.entries(responses)) {
      const keys = keysOf(body);
      const leaked = forbidden.filter((c) => keys.has(c));
      expect(leaked, `${where} disclosed a credential column`).toEqual([]);
    }
  });

  it('returns the same shape from every route on the resource', async () => {
    // The bug was a *divergence*: the list mapped through an allow-list and the
    // single-user reads did not, so which fields an account had depended on how
    // it was fetched. Pinning them equal is what stops one of them drifting
    // back to a spread.
    const target = await seedUser(ctx, { roles: ['valuation_user'] });
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${target.id}`,
      headers: authHeader(admin.token),
      payload: { job_title: 'Analyst' },
    });
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/users?q=${encodeURIComponent(target.email)}`,
      headers: authHeader(admin.token),
    });
    const fromList = (listed.json().users as Record<string, unknown>[]).find((u) => u.id === target.id);

    expect(fromList, 'the seeded user should be findable in the list').toBeDefined();
    expect(Object.keys(patched.json().user).sort()).toEqual(Object.keys(fromList!).sort());
  });

  it('keeps the denylist idiom out of the routes', () => {
    // `{ ...row, password_digest: undefined }` is the shape of the defect, not
    // just an instance of it: it says "everything, minus the one field somebody
    // remembered", over rows that come from `SELECT *`. A source scan rather
    // than another response assertion, because the next occurrence will be on a
    // route this file does not call.
    const routes = path.resolve(HERE, '../../src/routes');
    const offenders: string[] = [];
    for (const file of readdirSync(routes).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(path.join(routes, file), 'utf8');
      // Ignore the explanatory quotation in the mapper's own docstring.
      for (const line of text.split('\n')) {
        if (/^\s*\*/.test(line)) continue;
        if (/\.\.\.\w+,\s*\w*(password|secret|token|digest)\w*:\s*undefined/.test(line))
          offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
