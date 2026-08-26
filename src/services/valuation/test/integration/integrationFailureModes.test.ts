import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What the platform does when an integration point answers badly (round 165,
 * methodology M5).
 *
 * The suites beside this one exercise the failure modes an integration *admits
 * to*: a refused connection, a 5xx, a 422 with issues, a deadline. Those are
 * the easy half, because the failure arrives already labelled as one and every
 * layer between here and the client is written to carry a label.
 *
 * This one is about the failures that arrive wearing a success's clothes — an
 * upload that stops early, an upstream that answers 200 with something that is
 * not the answer, a settlement for an object we have no record of. Each of the
 * three was reaching a person as a claim that was either false or empty:
 *
 *   * a truncated upload was reported as a file that was too large,
 *   * an engine body with no concluded figures became a *succeeded* calculation
 *     whose QA review passed,
 *   * a settled Stripe session with no local payment row was acknowledged,
 *     ledgered as handled, and never mentioned again.
 *
 * The acceptance rule they are asserted against is the same in all three:
 * nothing is stored half-done, and whoever has to act — the person uploading,
 * the analyst, the ops team reconciling a Stripe statement — is told something
 * they can act on.
 */

// ── Engine ──────────────────────────────────────────────────────────────────

/** Whatever the stub is currently told to answer /compute with. */
const engineState = { body: {} as unknown };

const GOOD_RESULTS = {
  engine_version: 'py-stub',
  results: {
    equity_value: 12_000_000,
    fmv_per_share: 1.2,
    approaches: { income: { equity_value: 12_000_000, weight: 1 } },
  },
  warnings: [],
};

async function startEngineStub() {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/compute', async () => engineState.body);
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

const WEBHOOK_SECRET = 'whsec_failure_modes_test';

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

describe.skipIf(!dbUp)('integration points that fail while looking like they worked', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['admin'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'FailureModes Inc' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { weight_income: 1, weight_asset: 0, weight_opm: 0, weight_market: 0, dlom: 0.25 },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/engine-inputs`,
      headers: authHeader(ops.token),
      payload: {
        shares_outstanding_common: 8_000_000,
        income: { free_cash_flows: [1e6, 2e6], discount_rate: 0.25, terminal_growth: 0.03 },
      },
    });
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  // ── 1. The engine answers 200 with something that is not a calculation ────

  describe('a calculation whose engine answered 200 with the wrong shape', () => {
    const compute = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
        payload: {},
      });

    const calculations = async () =>
      (
        await ctx.pool.query<{ status: string; equity_value: string | null; error: string | null }>(
          'SELECT status, equity_value, error FROM calculations WHERE valuation_id = $1 ORDER BY created_at',
          [valuationId],
        )
      ).rows;

    it('the happy path still lands, so the checks below are about the shape and nothing else', async () => {
      engineState.body = GOOD_RESULTS;
      const res = await compute();
      expect(res.statusCode).toBe(201);
      expect(res.json().calculation.status).toBe('succeeded');
      expect(Number(res.json().calculation.fmv_per_share)).toBe(1.2);
    });

    /**
     * The arm that used to vanish. `response.results.equity_value` threw a
     * `TypeError`, which is not an `InternalServiceError`, so the catch that
     * exists to record a failed run declined to — and the analyst got a bare
     * 500 about a valuation whose inputs were all fine, with no row anywhere
     * saying the run had been attempted.
     */
    it('a body with no results is a recorded failure, not an unexplained 500', async () => {
      const before = (await calculations()).length;
      engineState.body = { engine_version: 'py-stub' };

      const res = await compute();
      expect(res.statusCode).toBe(502);
      const problem = res.json();
      // Names the dependency and what was wrong with what it said. The old
      // answer was `{"title":"Internal Server Error"}` and nothing else.
      expect(problem.title).toBe('Bad Gateway');
      expect(problem.detail).toContain('engine');
      expect(problem.detail).toContain('results is missing');

      const rows = await calculations();
      expect(rows.length).toBe(before + 1);
      expect(rows.at(-1)!.status).toBe('failed');
      expect(rows.at(-1)!.error).toContain('results is missing');
    });

    /**
     * The arm that used to *succeed*. This is the one that reaches a filed
     * 409A: `createCalculation` coerces the absent figures to null, the row is
     * written `succeeded`, and every reader downstream treats it as the
     * valuation's latest good run.
     */
    it('a body with results but no concluded figures is a failure, not a null-valued success', async () => {
      engineState.body = {
        engine_version: 'py-stub',
        results: { approaches: { income: { weight: 1 } } },
      };

      const res = await compute();
      expect(res.statusCode).toBe(502);
      expect(res.json().detail).toContain('results.equity_value is missing');

      const rows = await calculations();
      expect(rows.at(-1)!.status).toBe('failed');
      // The specific corruption: no `succeeded` row may carry a null equity
      // value. Asserted over the whole table rather than the last row, because
      // the damage is not that the run failed — it is that a null-valued row
      // would still be there tomorrow, being read as the conclusion.
      expect(rows.filter((r) => r.status === 'succeeded' && r.equity_value === null)).toEqual([]);
    });

    it('a figure that is present but not a finite number is refused too', async () => {
      engineState.body = {
        engine_version: 'py-stub',
        results: { equity_value: '12000000', fmv_per_share: 1.2 },
      };
      const res = await compute();
      expect(res.statusCode).toBe(502);
      expect(res.json().detail).toContain('results.equity_value is not a finite number');
    });

    /**
     * `engine_version` is NOT NULL in the schema, so its absence used to fail
     * one line later than the figures do — inside the INSERT, as a pg error,
     * which is again not an `InternalServiceError`. Same 500, same missing row.
     */
    it('a body with no engine_version is refused at the boundary, not by the column', async () => {
      engineState.body = { results: { equity_value: 1_000, fmv_per_share: 0.1 } };
      const res = await compute();
      expect(res.statusCode).toBe(502);
      expect(res.json().detail).toContain('engine_version is missing');
    });

    /**
     * A malformed body is the engine being *wrong*, not being *down*, and the
     * difference decides two things: whether the request is retried (it must
     * not be — the same request will draw the same body) and whether the
     * breaker counts it toward an outage (it must not — the service answered).
     * Both are settled by the status the boundary error carries, so the run
     * makes exactly one call.
     */
    it('is not retried — a wrong answer is not a transient one', async () => {
      let calls = 0;
      const counting = Fastify({ logger: false });
      counting.post('/engine/v1/compute', async () => {
        calls += 1;
        return { engine_version: 'py-stub', results: {} };
      });
      await counting.listen({ port: 0, host: '127.0.0.1' });
      const address = counting.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const solo = await setupTestApp({ ENGINE_URL: `http://127.0.0.1:${port}` });
      try {
        const soloOps = await seedUser(solo, { roles: ['admin'] });
        const v = await solo.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(soloOps.token),
          payload: { kind: '409a', company_name: 'RetryCo' },
        });
        const vid = v.json().valuation.id as string;
        await solo.app.inject({
          method: 'PATCH',
          url: `/api/v1/valuations/${vid}/params`,
          headers: authHeader(soloOps.token),
          payload: { weight_income: 1, weight_asset: 0, weight_opm: 0, weight_market: 0, dlom: 0.25 },
        });
        await solo.app.inject({
          method: 'PATCH',
          url: `/api/v1/valuations/${vid}/engine-inputs`,
          headers: authHeader(soloOps.token),
          payload: {
            shares_outstanding_common: 8_000_000,
            income: { free_cash_flows: [1e6, 2e6], discount_rate: 0.25, terminal_growth: 0.03 },
          },
        });
        const res = await solo.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${vid}/calculations`,
          headers: authHeader(soloOps.token),
          payload: {},
        });
        expect(res.statusCode).toBe(502);
        expect(calls).toBe(1);
      } finally {
        await solo.teardown();
        await counting.close();
      }
    });

    /**
     * Why the boundary check has to be a *refusal* and not a warning.
     *
     * The QA review is the last thing between a calculation and a published
     * 409A, and its two output-sanity rules are written `if (equity !== null)`
     * — so a null figure does not fail them, it deletes them. A stored
     * null-valued `succeeded` row therefore came back `pass` with the two
     * rules that would have objected simply absent from the list, which reads
     * as an all-clear.
     *
     * Written against a row inserted directly, because the route can no longer
     * produce one: this asserts the *consequence* the refusal exists to
     * prevent, so it must not depend on the refusal to set itself up.
     */
    it('a null-valued succeeded row would pass QA with the sanity rules missing', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: '409a', company_name: 'VacuousQA Co' },
      });
      const vid = created.json().valuation.id as string;
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${vid}/params`,
        headers: authHeader(ops.token),
        payload: { weight_income: 1, weight_asset: 0, weight_opm: 0, weight_market: 0, dlom: 0.25 },
      });

      const { rows } = await ctx.pool.query<{ id: string }>('SELECT id FROM valuations WHERE id = $1', [vid]);
      expect(rows.length).toBe(1);
      await ctx.pool.query(
        `INSERT INTO calculations (id, valuation_id, engine_version, status, inputs, results, equity_value, fmv_per_share, created_by)
         VALUES ($1, $2, 'py-stub', 'succeeded', $3::jsonb, $4::jsonb, NULL, NULL, $5)`,
        [
          '01ARZ3NDEKTSV4RRFFQ69G5FBB',
          vid,
          JSON.stringify({ params: { weight_income: 1 }, inputs: {} }),
          JSON.stringify({ approaches: {} }),
          ops.id,
        ],
      );

      const qa = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/qa`,
        headers: authHeader(ops.token),
        payload: {},
      });
      expect(qa.statusCode).toBe(201);
      const keys = (qa.json().review.checks as { key: string }[]).map((c) => c.key);
      // The gate passes by having nothing left to ask.
      expect(qa.json().review.status).toBe('pass');
      expect(keys).not.toContain('equity_positive');
      expect(keys).not.toContain('fmv_positive');
    });
  });

  // ── 2. An upload that stops before the file is all there ─────────────────

  describe('an upload whose body ends mid-file', () => {
    const CRLF = '\r\n';
    const B = 'FAILUREMODEBOUNDARY';
    const part = (lines: string[]) => lines.join(CRLF);

    const upload = (body: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/documents`,
        headers: { ...authHeader(ops.token), 'content-type': `multipart/form-data; boundary=${B}` },
        payload: body,
      });

    const head = [
      `--${B}`,
      'Content-Disposition: form-data; name="kind"',
      '',
      'cap_table',
      `--${B}`,
      'Content-Disposition: form-data; name="file"; filename="holders.csv"',
      'Content-Type: text/csv',
      '',
      'class,shares',
      'common,100',
    ];

    it('a complete upload is stored', async () => {
      const res = await upload(part([...head, `--${B}--`, '']));
      expect(res.statusCode).toBe(201);
      expect(res.json().document.filename).toBe('holders.csv');
    });

    /**
     * The whole finding in one assertion: a 26-byte file must never be told it
     * is over a 25 MB limit.
     *
     * `toBuffer` consumes the file stream with a `for await`, so a body that
     * stops before its closing boundary throws from the iterator — an error
     * that has nothing to do with size and that the route's bare `catch` was
     * reporting as size anyway. The message mattered more than the status:
     * it sent the reader off to split a spreadsheet that was never too big,
     * and argued against the one thing that would have worked.
     */
    it('is told the transfer ended early, not that the file is too large', async () => {
      const res = await upload(part(head));
      const problem = res.json();
      expect(problem.detail).not.toContain('MB limit');
      expect(problem.detail).toMatch(/upload (it again|ended before)/i);
      expect(problem.detail).toContain('nothing was saved');
      expect(res.statusCode).toBe(400);
    });

    it('stores nothing for the interrupted upload', async () => {
      const before = await ctx.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM documents WHERE valuation_id = $1',
        [valuationId],
      );
      await upload(part(head));
      const after = await ctx.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM documents WHERE valuation_id = $1',
        [valuationId],
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it('the retry the message asks for works — the same file goes on to store', async () => {
      await upload(part(head));
      const retried = await upload(part([...head, `--${B}--`, '']));
      expect(retried.statusCode).toBe(201);
    });

    /**
     * The cap-table importer buffers through the same helper, so it answers
     * the same way. Asserted rather than assumed: it is a second route with a
     * second limit, and the two used to have two copies of the wrong catch.
     */
    it('the cap-table importer answers the same way', async () => {
      const capHead = [
        `--${B}`,
        'Content-Disposition: form-data; name="file"; filename="captable.csv"',
        'Content-Type: text/csv',
        '',
        'class,shares',
        'common,100',
      ];
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/cap-table/upload`,
        headers: { ...authHeader(ops.token), 'content-type': `multipart/form-data; boundary=${B}` },
        payload: part(capHead),
      });
      expect(res.json().detail).not.toContain('MB limit');
      expect(res.json().detail).toContain('nothing was saved');
    });
  });

  // ── 3. Stripe settles a session we have no row for ───────────────────────

  describe('a Stripe checkout that settled against no payment row', () => {
    const post = (event: Record<string, unknown>) => {
      const payload = JSON.stringify(event);
      return app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(payload),
        payload,
      });
    };

    /**
     * A distinct session id per case; the event ledger keys on the event.
     * `client_reference_id` is what `createCheckoutSession` stamps on every
     * session this platform opens, so its presence is what makes a session
     * ours — the cases below that omit it are standing in for another
     * integration on the same Stripe account.
     */
    const sessionEvent = (id: string, type: string, over: Record<string, unknown> = {}) => ({
      id: `evt_${id}`,
      type,
      data: {
        object: {
          id: `cs_test_${id}`,
          client_reference_id: valuationId,
          metadata: { valuation_id: valuationId },
          amount_total: 250_000,
          currency: 'usd',
          payment_status: 'paid',
          ...over,
        },
      },
    });

    /**
     * The one that used to disappear. `createCheckoutSession` runs before
     * `createPayment`, so a failure between the two leaves a live Stripe
     * session with nothing behind it — and the settlement for it was answered
     * `ignored: 'unknown session'` and written into the event ledger as dealt
     * with, which made the silence permanent.
     */
    it('says the settlement is unreconciled rather than ignoring it', async () => {
      const res = await post(sessionEvent('orphan1', 'checkout.session.completed'));
      expect(res.statusCode).toBe(200);
      expect(res.json().unreconciled).toBe('settled session has no payment row');
      expect(res.json().ignored).toBeUndefined();
    });

    it('says the same for a delayed method that settles later', async () => {
      const res = await post(sessionEvent('orphan2', 'checkout.session.async_payment_succeeded'));
      expect(res.json().unreconciled).toBe('settled session has no payment row');
    });

    /**
     * The other half, and the reason this is a judgement about the event and
     * not about the missing row: a session that completed *without* settling,
     * or one that expired, took no money. Those stay quiet — a Stripe account
     * legitimately carries sessions this platform never created, and alerting
     * on every one of them is how an alert stops being read.
     */
    it('stays quiet for a completed session that did not take any money', async () => {
      const res = await post(
        sessionEvent('unsettled', 'checkout.session.completed', { payment_status: 'unpaid' }),
      );
      expect(res.json().ignored).toBe('unknown session');
      expect(res.json().unreconciled).toBeUndefined();
    });

    it('stays quiet for an expired session', async () => {
      const res = await post(sessionEvent('gone', 'checkout.session.expired'));
      expect(res.json().ignored).toBe('unknown session');
      expect(res.json().unreconciled).toBeUndefined();
    });

    /**
     * Acknowledged, not 5xx'd: redelivery cannot conjure the missing row, so a
     * failure status would only buy days of Stripe retries. The ack is what
     * makes the alert the only trace, which is why the alert had to exist.
     */
    it('acknowledges rather than asking Stripe to retry forever', async () => {
      const res = await post(sessionEvent('orphan3', 'checkout.session.completed'));
      expect(res.statusCode).toBe(200);
      expect(res.json().received).toBe(true);
    });

    /**
     * The other boundary, and the reason the alert is not simply "settled and
     * unknown". A webhook endpoint receives every event on the Stripe account,
     * so a settled session opened by some *other* integration is not our money
     * and not ours to reconcile. What separates the two is the engagement id
     * our own checkout stamps on every session it opens; a foreign session
     * carries none, and stays quiet.
     */
    it('stays quiet for a settled session that was never ours', async () => {
      const res = await post(
        sessionEvent('foreign', 'checkout.session.completed', {
          client_reference_id: undefined,
          metadata: {},
        }),
      );
      expect(res.json().ignored).toBe('unknown session');
      expect(res.json().unreconciled).toBeUndefined();
    });

    it('reads the engagement from metadata when the top-level field is gone', async () => {
      const res = await post(
        sessionEvent('metaonly', 'checkout.session.completed', { client_reference_id: undefined }),
      );
      expect(res.json().unreconciled).toBe('settled session has no payment row');
    });

    /**
     * A reference that is not a ULID is not one of ours either — an id-shaped
     * string from another integration must not be read as an engagement.
     */
    it('stays quiet when the reference is not an engagement id', async () => {
      const res = await post(
        sessionEvent('notours', 'checkout.session.completed', {
          client_reference_id: 'order-99812',
          metadata: { valuation_id: 'order-99812' },
        }),
      );
      expect(res.json().ignored).toBe('unknown session');
    });
  });
});
