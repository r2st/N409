import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_EVENT_CATALOG } from '../../src/domain/auditTrail.js';

/**
 * A route that changes who can sign in, or with what, writes it down.
 *
 * `admin_events` is the audit spine for everything that is not one engagement,
 * and it was written from the *administrator's* side of the platform only. The
 * console had a row for every action: role granted, invitation resent, prompt
 * edited, template archived, sessions revoked. The doors an account uses on
 * itself, and the ones a machine uses on the firm, had almost none —
 *
 *   - sign-out, everywhere; sign-in through SAML, while password and Google
 *     both wrote `user_login`
 *   - changing a password, and completing a reset
 *   - enrolling a second factor, **disabling** one, replacing the backup codes
 *   - minting and revoking an API token, personal or partner
 *   - repointing `saml_config` at a different identity provider, and minting
 *     the SCIM tokens that create and deactivate accounts
 *   - SCIM itself: every seat a directory connector provisions or deprovisions
 *   - a person exporting their own personal data, where an administrator
 *     exporting it for them was recorded
 *
 * — twenty-three routes. Read together they are most of what an account
 * takeover consists of: sign in, disable the second factor, mint a token that
 * outlives the session, take a copy of the data. The trail could describe an
 * administrator tidying prompts and not that.
 *
 * ## Why this is derived rather than listed
 *
 * A list of "security-sensitive routes" is a list somebody has to remember to
 * add to, which is the failure that produced the gap. So the question is asked
 * of the schema instead, in three steps, each of which can be checked:
 *
 *   1. `IDENTITY_TABLES` — the tables that decide identity, credentials and
 *      access. This is the one judgement, stated once.
 *   2. Every exported repo function whose SQL writes one of them, read out of
 *      `src/repos`. That is the set of ways this codebase can change identity.
 *   3. Every route handler that calls one, read out of `src/routes`. Each must
 *      record an admin event or hold an exemption with a reason.
 *
 * A new table for a new credential type is the only thing a person has to
 * think about; everything downstream of it fails on its own.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.resolve(HERE, '../..');

/**
 * The tables that decide who this platform believes you are.
 *
 * Deliberately not "every table with a `user_id`" — that is most of the
 * schema, and the row a valuation's comment belongs to is not an identity
 * question. These are the tables an attacker would write to, and the ones a
 * compliance reviewer means by "access management".
 */
const IDENTITY_TABLES = new Set([
  'users',
  'user_roles',
  'mfa_secrets',
  'mfa_backup_codes',
  'mfa_trusted_devices',
  'api_tokens',
  'saml_config',
  'scim_tokens',
  'password_reset_tokens',
  'user_invitations',
  'email_verification_tokens',
]);

/**
 * Repo functions that write an identity table *while reading a credential*.
 *
 * Every one of these is on the hot path of a request that is already audited
 * or is not an action at all: `resolveApiTokenWithReason` and `verifyScimToken` stamp
 * `last_used_at` on every authenticated call, `isDeviceTrusted` stamps a
 * remembered device, `consumeTotpCounter` burns a time step so a code cannot
 * be replayed, `consumeBackupCode` spends one during a sign-in that writes
 * `user_login` itself. Requiring an event for these would mean a row per API
 * request, which is not an audit trail — it is an access log, and the service
 * already has one.
 *
 * The distinction is: does the write change what the credential *grants*, or
 * only record that it was used?
 */
const READ_PATH_WRITERS = new Set([
  'resolveApiTokenWithReason',
  'verifyScimToken',
  'isDeviceTrusted',
  'consumeTotpCounter',
  'consumeBackupCode',
  'trustDevice',
]);

/**
 * Routes that write an identity table and deliberately record nothing.
 *
 * Each reason has to survive being read out to somebody reconstructing an
 * incident from the trail, which is the standard these are written to.
 */
const EXEMPT: Record<string, string> = {
  'POST /api/v1/account/mfa/setup':
    'Stages a candidate TOTP secret that grants nothing: it is inert until /confirm verifies a live ' +
    'code against it, and the next /setup overwrites it. Enrolment is recorded at /confirm, which is ' +
    'the moment the factor exists; recording this one too would put a row against every abandoned QR ' +
    'screen and bury the three MFA events that mean something.',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(full) ? [full] : [];
  });
}

/**
 * Exported repo functions whose body writes an identity table.
 *
 * A function's "body" is the text from its `export function` to the next one,
 * which over-reads by whatever trails the last function in a file — harmless,
 * because the consequence of over-reading is a *stricter* census.
 */
export function identityWriters(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(path.join(SERVICE, 'src/repos'))) {
    const text = readFileSync(file, 'utf8');
    const marks = [...text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => ({
      name: m[1]!,
      at: m.index!,
    }));
    for (let i = 0; i < marks.length; i++) {
      const body = text.slice(marks[i]!.at, marks[i + 1]?.at ?? text.length);
      const tables = new Set<string>();
      for (const m of body.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi)) {
        const table = m[1]!.toLowerCase();
        if (IDENTITY_TABLES.has(table)) tables.add(table);
      }
      if (tables.size) found.set(marks[i]!.name, [...tables].sort());
    }
  }
  return found;
}

export interface RouteHandler {
  method: string;
  url: string;
  body: string;
}

/**
 * Every route handler in `src/routes`, with its body.
 *
 * `app|scope` rather than `app`, and that is not a detail. Five routes in this
 * tree are registered on a nested `scope` inside `app.register(...)`, and one
 * of them is the SAML assertion-consumer endpoint — the route that both signs
 * a user in and mints accounts. A sweep matching only `app.` would report
 * clean while never having looked at it, which is how a previous route sweep
 * in this codebase came to be vacuous.
 */
/**
 * The same source with `//` and comment blocks replaced by whitespace of the
 * same length, so offsets and line numbers are unchanged.
 *
 * String and template state is tracked while stripping for the same reason the
 * matcher below tracks it: `'https://…'` is not a comment, and a `//` inside a
 * template literal is not one either.
 */
function stripComments(text: string): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === quote) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      while (i < stop) {
        if (text[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

export function routeHandlers(source: string): RouteHandler[] {
  const out: RouteHandler[] = [];
  /*
   * COMMENTS COME OUT FIRST, AND THAT IS THE WHOLE OF THIS FUNCTION'S
   * CORRECTNESS (R325, methodology M6).
   *
   * The paren matcher below tracks string literals so a `)` inside one does not
   * close a call. It had no idea what a comment was, so an apostrophe in prose
   * — `// harmless because it isn't enabled until /confirm` in `routes/mfa.ts`
   * — opened a string that stayed open until the next apostrophe several lines
   * later, and every parenthesis in between went uncounted. `POST
   * /account/mfa/setup` came out as a 4,905-character body: its own 1,100 plus
   * `/confirm`, `/disable` and `/backup-codes`, whose `recordAdminEvent` calls
   * it then inherited.
   *
   * That is this census reading *green* on the one route it has an exemption
   * for, and it fails in the direction that hides things: a bled body is a
   * route audited by its neighbour. The contradiction check is what noticed,
   * because an exemption is the only place the census states an expectation
   * strong enough to be contradicted — the `silent` check would simply have
   * gone quiet.
   */
  const text = stripComments(source);
  const call = /\b(?:app|scope)\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\2/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(text))) {
    let i = text.indexOf('(', m.index + m[0].indexOf('.'));
    let depth = 0;
    let quote: string | null = null;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ method: m[1]!.toUpperCase(), url: m[3]!, body: text.slice(m.index, i + 1) });
  }
  return out;
}

/** `recordAdminEvent(…)` or one of the route-local `audit(…)` wrappers. */
const RECORDS_EVENT = /\brecordAdminEvent\s*\(|\baudit\s*\(/;

interface IdentityRoute {
  key: string;
  file: string;
  writers: string[];
  audited: boolean;
}

function scan(): { routes: IdentityRoute[]; handlers: number } {
  const writers = identityWriters();
  const candidates = [...writers.keys()].filter((fn) => !READ_PATH_WRITERS.has(fn));
  const routes: IdentityRoute[] = [];
  let handlers = 0;
  for (const file of sourceFiles(path.join(SERVICE, 'src/routes'))) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(SERVICE, file).split(path.sep).join('/');
    for (const handler of routeHandlers(text)) {
      handlers++;
      const called = candidates.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(handler.body));
      if (!called.length) continue;
      routes.push({
        key: `${handler.method} ${handler.url}`,
        file: rel,
        writers: called.sort(),
        audited: RECORDS_EVENT.test(handler.body),
      });
    }
  }
  return { routes, handlers };
}

const { routes, handlers } = scan();
const writers = identityWriters();

describe('every route that changes identity leaves a row', () => {
  it('reads a schema, a repo layer and a route tree at all', () => {
    // Vacuity guard, in all three links of the derivation. Each assertion
    // below passes trivially against an empty scan, and each step is regexes
    // over source — one refactor away from finding nothing and reporting it as
    // nothing wrong.
    expect(writers.size, 'repo functions writing an identity table').toBeGreaterThan(20);
    expect(handlers, 'route handlers parsed').toBeGreaterThan(300);
    expect(routes.length, 'routes reaching an identity writer').toBeGreaterThan(15);
  });

  it('does not let an apostrophe in a comment run one handler into the next', () => {
    // The bug this extractor had, reduced: prose with `isn't` in it, between two
    // routes, one of which records an event and one of which must not appear to.
    const found = routeHandlers(
      [
        "app.post('/a', async () => {",
        "  // staging isn't recorded — see /b",
        '  await stage();',
        '});',
        "app.post('/b', async () => {",
        '  await recordAdminEvent(pool, {});',
        '});',
      ].join('\n'),
    );
    expect(found.map((h) => h.url)).toEqual(['/a', '/b']);
    expect(RECORDS_EVENT.test(found[0]!.body), '/a must not inherit /b’s event').toBe(false);
    expect(RECORDS_EVENT.test(found[1]!.body)).toBe(true);
  });

  it('does not mistake a URL in a string for a comment', () => {
    const found = routeHandlers(
      ["app.get('/c', async () => {", "  await fetch('https://example.test/x');", '});'].join('\n'),
    );
    expect(found.map((h) => h.url)).toEqual(['/c']);
    expect(found[0]!.body).toContain('https://example.test/x');
  });

  it('sees the routes registered on a nested scope, not only on app', () => {
    // The SAML assertion-consumer is registered as `scope.post(...)` inside an
    // `app.register(...)`, and it is the route that signs an SSO user in and
    // JIT-provisions the account. A previous sweep in this codebase matched
    // `app.` only and reported "every route" while never seeing five of them.
    expect(routes.map((r) => r.key)).toContain('POST /api/v1/auth/saml/acs');
  });

  it('finds the writers it is supposed to be finding', () => {
    // The other end of the same guard: `identityWriters` parses SQL out of
    // TypeScript, and if it stops matching, no route looks like it touches
    // identity and the census goes quiet.
    for (const fn of ['setPasswordDigest', 'disableTotp', 'createApiToken', 'upsertSamlConfig'])
      expect([...writers.keys()], fn).toContain(fn);
    expect(writers.get('setPasswordDigest')).toEqual(['users']);
  });

  it('records an admin event, or holds a reason for not doing so', () => {
    const silent = routes
      .filter((r) => !r.audited && !(r.key in EXEMPT))
      .map((r) => `${r.file}: ${r.key} → ${r.writers.join(', ')}`)
      .sort();
    expect(silent, 'identity-changing routes with no audit event').toEqual([]);
  });

  it('keeps no exemption for a route that records an event anyway', () => {
    // A stale exemption reads as a considered decision not to record something
    // that is in fact recorded — the registry lying in the direction that makes
    // it useless.
    const contradictory = routes.filter((r) => r.audited && r.key in EXEMPT).map((r) => r.key);
    expect(contradictory).toEqual([]);
  });

  it('keeps no exemption for a route that no longer reaches identity', () => {
    const live = new Set(routes.map((r) => r.key));
    expect(Object.keys(EXEMPT).filter((key) => !live.has(key))).toEqual([]);
  });

  it('gives every exemption a reason somebody could read out', () => {
    const thin = Object.entries(EXEMPT).filter(([, why]) => why.trim().length < 80);
    expect(thin.map(([route]) => route)).toEqual([]);
  });

  it('catalogues the identity vocabulary it now writes', () => {
    // The types this round added, asserted by name rather than by count: a
    // count moves for reasons that have nothing to do with whether sign-out is
    // still describable.
    for (const type of [
      'user_logout',
      'user_password_changed',
      'user_email_verified',
      'invitation_accepted',
      'user_mfa_enabled',
      'user_mfa_disabled',
      'user_mfa_backup_codes_regenerated',
      'api_token_created',
      'api_token_revoked',
      'sso_config_updated',
      'scim_token_created',
      'scim_token_revoked',
    ])
      expect(Object.keys(ADMIN_EVENT_CATALOG), type).toContain(type);
  });

  it('ranks removing a second factor above adding one', () => {
    // Turning MFA off is a step in every account takeover that gets that far;
    // turning it on is housekeeping. A feed that ranks them the same is a feed
    // that cannot surface the one worth waking somebody for.
    expect(ADMIN_EVENT_CATALOG.user_mfa_disabled.severity).toBe('critical');
    expect(ADMIN_EVENT_CATALOG.user_mfa_enabled.severity).toBe('notice');
    expect(ADMIN_EVENT_CATALOG.sso_config_updated.severity).toBe('critical');
    expect(ADMIN_EVENT_CATALOG.api_token_created.severity).toBe('critical');
  });
});
