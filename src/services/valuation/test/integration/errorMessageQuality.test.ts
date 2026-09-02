import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The messages R180 rewrote, asserted where the caller actually receives them.
 *
 * `errorMessageQuality.test.ts` in `unit/` is a source census — it proves no
 * route is written in the old shape. This proves the new shape *survives the
 * round trip*: that the field names and the remedy are in `detail`, and not in
 * some extension the browser never reads. The last describe block is the other
 * half of an honest audit — the message R180 deliberately left uninformative,
 * pinned so the reasoning does not have to be rediscovered.
 *
 * `detail` specifically, in every case below, and never `errors`. That is the
 * whole point of the round. `ApiError` in the frontend is constructed as
 * `super(problem.detail ?? problem.title)`, so a fact that is not in `detail`
 * is a fact no `setError(err.message)` in the app can render — which is how 203
 * routes came to answer every schema rejection with the words "Invalid
 * request" while carrying the real answer, unread, in the body beside it.
 */
describe.skipIf(!dbUp)('error messages a caller can act on', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let opsToken: string;
  let clientToken: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    opsToken = (await seedUser(ctx, { roles: ['admin'] })).token;
    clientToken = (await seedUser(ctx, { roles: ['valuation_user'] })).token;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  describe('422 — a refused body names the field', () => {
    it('names the field, the rule it broke, and keeps the subject', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/funds',
        headers: authHeader(opsToken),
        payload: { name: 'Seed Fund II', vintage_year: 19999 },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      // What (the field), why (the rule), where to look (the subject).
      expect(body.detail).toContain('vintage_year');
      expect(body.detail).toMatch(/2100/);
      expect(body.detail).toMatch(/^Invalid fund — /);
    });

    it('leaves the machine-readable issues exactly where they were', async () => {
      // The prose is *additional*. An integration reading `errors[].path` should
      // not have to parse a sentence, so the extension is untouched.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/funds',
        headers: authHeader(opsToken),
        payload: { name: '', vintage_year: 19999 },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['vintage_year'] })]),
      );
    });

    it('names several fields at once rather than only the first', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/funds',
        headers: authHeader(opsToken),
        payload: { name: '', fund_type: 'not-a-type', vintage_year: 1000 },
      });
      expect(res.statusCode).toBe(422);
      const { detail } = res.json();
      expect(detail).toContain('name');
      expect(detail).toContain('fund_type');
      expect(detail).toContain('vintage_year');
    });
  });

  describe('400 — a refused query names the parameter', () => {
    it('says which parameter, not just "Invalid query"', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/funds?limit=99999',
        headers: authHeader(opsToken),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/^Invalid query — limit: /);
    });

    it('answers 400 for a query and 422 for a body, and says so differently', async () => {
      // The subject is the half that says *which* of a route's three schemas
      // refused — a field name alone cannot carry that.
      const query = await app.inject({
        method: 'GET',
        url: '/api/v1/funds?limit=abc',
        headers: authHeader(opsToken),
      });
      expect(query.statusCode).toBe(400);
      expect(query.json().detail).toMatch(/^Invalid query — /);

      const body = await app.inject({
        method: 'POST',
        url: '/api/v1/funds',
        headers: authHeader(opsToken),
        payload: { name: 'x'.repeat(500) },
      });
      expect(body.statusCode).toBe(422);
      expect(body.json().detail).toMatch(/^Invalid fund — /);
    });
  });

  describe('403 — says what was refused and what would let it through', () => {
    it('names the action, the audience and the remedy', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/system/metrics',
        headers: authHeader(clientToken),
      });
      expect(res.statusCode).toBe(403);
      const { detail } = res.json();
      expect(detail).toContain('Reading system metrics'); // what
      expect(detail).toContain('operations staff'); // why
      expect(detail).toMatch(/ask an administrator/i); // how
      expect(detail).not.toBe('Not allowed');
    });

    it('carries a coarse token an integration can branch on', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/db/pool',
        headers: authHeader(clientToken),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().required_access).toBe('ops');
    });

    it('does not publish the role vocabulary to do it', async () => {
      // `GET /api/v1/roles` is itself ops-only, so a 403 body is a strange
      // place to hand the internal role keys to somebody who cannot read them.
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/capabilities',
        headers: authHeader(clientToken),
      });
      const serialized = res.body;
      for (const role of ['god', 'supervisor', 'support_supervisor', 'main_reviewer']) {
        expect(serialized, `403 body names the internal role "${role}"`).not.toContain(role);
      }
    });

    /**
     * The valuation PATCH's field-level 403 (R350).
     *
     * `Not allowed to update: state, due_date` is a list of column names and
     * nothing else — no reason, no remedy, no `required_access`. It escaped
     * R180's sweep of the bare `problems.forbidden()` calls by already having
     * a string, which is why the shape survived on the one 403 an ordinary
     * client is most likely to see.
     */
    it('says whose the field is when a client patches one their analyst owns', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(clientToken),
        payload: { kind: '409a', company_name: 'PatchCo' },
      });
      expect(created.statusCode).toBe(201);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${created.json().valuation.id}`,
        headers: authHeader(clientToken),
        payload: { due_date: '2027-01-01T00:00:00.000Z' },
      });
      expect(res.statusCode).toBe(403);
      const { detail, required_access } = res.json();
      expect(detail).toContain('due_date'); // which part of the patch
      expect(detail).toContain('your analyst'); // whose it is
      expect(detail).toMatch(/send it again without/i); // what to do now
      // Never this: a client cannot be granted an operations role, and telling
      // them to ask for one reads as the product being misconfigured.
      expect(detail).not.toMatch(/operations role/i);
      expect(required_access).toBe('ops-managed-field');
    });

    it('distinguishes working data from access the caller could be granted', async () => {
      // "Ask an administrator" is the wrong instruction here: no role a client
      // can be given makes the model internals visible to them, so the remedy
      // points at the report instead.
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/overwrites/schema',
        headers: authHeader(clientToken),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().required_access).toBe('working-data');
      expect(res.json().detail).toMatch(/report/i);
    });
  });

  describe('404 — names what it did not recognise, in words it controls', () => {
    /*
     * The other half of `errorBodyDisclosure`'s rule (R287, methodology M19).
     * Naming the unknown field is right — "unknown field" without the field is
     * a worse answer — but the value being named is by construction the one
     * that matched nothing the server knows, so it is whatever the caller put
     * in the URL, and a path segment carries no schema and no length of its
     * own. `quoteForMessage` is what the workbook readers already put every
     * untrusted name through before quoting it.
     */
    let valuationId: string;

    beforeAll(async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(opsToken),
        payload: { kind: '409a', company_name: 'Echo Co' },
      });
      valuationId = created.json().valuation.id;
    });

    const put = (fieldKey: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/overwrites/${encodeURIComponent(fieldKey)}`,
        headers: authHeader(opsToken),
        payload: { value: 1 },
      });

    it('bounds what it quotes below what the router will hand it', async () => {
      // fastify's `maxParamLength` is 100 and nothing here raises it, so the
      // router answers 414 above that and the route never sees a truly
      // unbounded segment — but 100 is not the quoting budget, and the bound
      // the message keeps has to be its own rather than a default two layers
      // down that this route does not set. See routes/blog.ts on what happens
      // when one layer assumes the other's limit.
      const res = await put('x'.repeat(100));
      expect(res.statusCode).toBe(404);
      expect(res.json().detail).toBe(`Unknown overwrite field "${'x'.repeat(80)}…"`);
    });

    it('strips the reordering and control characters out of what it quotes', async () => {
      const res = await put('fee\u202Egnp.exe\u0007');
      expect(res.statusCode).toBe(404);
      const { detail } = res.json();
      expect(detail).not.toContain('\u202E');
      expect(detail).not.toContain('\u0007');
      expect(detail).toContain('feegnp.exe?');
    });

    it('does not let the quoted value close the quoting around it', async () => {
      const res = await put('a" and also');
      expect(res.json().detail).toBe('Unknown overwrite field "a? and also"');
    });

    it('still names an ordinary typo, which is the reason it names anything', async () => {
      const res = await put('industry_idd');
      expect(res.json().detail).toBe('Unknown overwrite field "industry_idd"');
    });
  });

  describe('404 — uninformative on purpose', () => {
    it('gives a malformed id the same answer as a missing one', () => {
      // Not an oversight, and asserted so nobody "fixes" it twice. R180 tried:
      // it rewrote 119 in-handler `!isUlid` guards to say "that id is not
      // well-formed" and then found the messages were unreachable —
      // `registerParamValidation` turns a bad id away at `preValidation`,
      // before authentication and before any handler — and that the bare answer
      // is deliberate, so the public token-authenticated routes cannot be used
      // to tell "malformed" from "not yours".
      //
      // Both answers are asserted together because the property is that they
      // are *identical*. Checking either alone would pass while the oracle
      // opened.
      return Promise.all([
        app.inject({
          method: 'GET',
          url: '/api/v1/valuations/not-a-ulid',
          headers: authHeader(opsToken),
        }),
        app.inject({
          method: 'GET',
          url: '/api/v1/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV',
          headers: authHeader(opsToken),
        }),
      ]).then(([malformed, absent]) => {
        expect(malformed.statusCode).toBe(404);
        expect(absent.statusCode).toBe(404);
        expect(malformed.json().detail).toBe(absent.json().detail);
      });
    });

    it('turns a bad id away before it costs anything', async () => {
      // `preValidation`, so an unauthenticated caller cannot spend the server's
      // body parsing or rate-limit budget on a malformed id. No credentials at
      // all, and still the 404 rather than the 401 the route would give.
      const res = await app.inject({ method: 'GET', url: '/api/v1/valuations/not-a-ulid' });
      expect(res.statusCode).toBe(404);
    });
  });
});
