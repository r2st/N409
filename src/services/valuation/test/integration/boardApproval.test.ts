import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('feature 5 — board approval workflow', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let teardown: () => Promise<void>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    const ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    teardown = ctx.teardown;

    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'BoardCo' },
    });
    valuationId = created.json().valuation.id;

    // Seed a concluded FMV the resolution can derive from.
    await createCalculation(
      pool,
      {
        valuationId,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 3.5 },
        equityValue: 35_000_000,
        fmvPerShare: 3.5,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
  });

  afterAll(async () => {
    await teardown?.();
  });

  it('returns an empty resolution before one is generated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolution: null, members: [] });
  });

  it('generates a resolution from the concluded FMV', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
      payload: { valuation_date: '2026-05-01' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.resolution.status).toBe('pending');
    expect(Number(body.resolution.fmv_conclusion)).toBe(3.5);
    expect(body.resolution.body_html).toContain('USD 3.5 per share');
    expect(body.resolution.body_html).toContain('BoardCo');
  });

  it('rejects generation when there is no concluded FMV and none supplied', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'FreshCo' },
    });
    const freshId = created.json().valuation.id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${freshId}/board`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(422);

    // But an explicit override works.
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${freshId}/board`,
      headers: authHeader(ops.token),
      payload: { fmv_conclusion: 1.11 },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().resolution.body_html).toContain('USD 1.11 per share');
  });

  it('is operations-only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('collects sign-offs and approves once every member has signed', async () => {
    const addA = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Alice Chair', email: 'alice@board.example', title: 'Chair' },
    });
    expect(addA.statusCode).toBe(201);
    const tokenA = addA.json().sign_token as string;
    expect(tokenA).toMatch(/^n409_brd_/);

    const addB = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Bob Director', email: 'bob@board.example' },
    });
    const tokenB = addB.json().sign_token as string;

    // Duplicate email is rejected.
    const dup = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Alice Again', email: 'alice@board.example' },
    });
    expect(dup.statusCode).toBe(409);

    // Public: Alice can view the resolution her token grants. POST, not a query
    // string — the token must never reach an access log.
    const view = await app.inject({
      method: 'POST',
      url: '/api/v1/board/resolution',
      payload: { token: tokenA },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().member.name).toBe('Alice Chair');
    expect(view.json().resolution.body_html).toContain('BoardCo');

    // Alice signs — still pending because Bob hasn't.
    const signA = await app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token: tokenA, decision: 'signed', comment: 'Approved.' },
    });
    expect(signA.statusCode).toBe(200);
    expect(signA.json().resolution_status).toBe('pending');

    // Double-signing is rejected.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token: tokenA, decision: 'signed' },
    });
    expect(again.statusCode).toBe(409);

    // Bob signs — now the whole resolution is approved.
    const signB = await app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token: tokenB, decision: 'signed' },
    });
    expect(signB.statusCode).toBe(200);
    expect(signB.json().resolution_status).toBe('approved');

    // Approval timestamp recorded for safe harbor.
    const board = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
    });
    expect(board.json().resolution.status).toBe('approved');
    expect(board.json().resolution.approved_at).toBeTruthy();
    expect(board.json().members).toHaveLength(2);

    // An approval event is on the audit spine.
    const { rows } = await pool.query(
      "SELECT type FROM valuation_events WHERE valuation_id = $1 AND type = 'board_resolution_approved'",
      [valuationId],
    );
    expect(rows.length).toBe(1);
  });

  it('a rejection rejects the whole resolution', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'RejectCo' },
    });
    const vId = created.json().valuation.id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${vId}/board`,
      headers: authHeader(ops.token),
      payload: { fmv_conclusion: 2 },
    });
    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${vId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Carol', email: 'carol@board.example' },
    });
    const token = add.json().sign_token as string;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token, decision: 'rejected', comment: 'Needs more work.' },
    });
    expect(res.json().resolution_status).toBe('rejected');
  });

  it('regenerating the resolution clears prior sign-offs', async () => {
    // The main valuation is approved with 2 signed members; regenerate wipes them.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
      payload: { fmv_conclusion: 4.0 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().resolution.status).toBe('pending');
    expect(res.json().members).toHaveLength(0);
  });

  it('hides the board from a client who cannot read the valuation', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(otherClient.token),
    });
    // otherClient is a client role → forbidden (ops-only), not a data leak.
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unknown signing token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token: 'n409_brd_nope', decision: 'signed' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('no longer accepts the resolution token in the query string', async () => {
    // The GET route is gone: a bearer token in a URL leaks into access logs,
    // Referer headers and browser history.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/board/resolution?token=n409_brd_anything',
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s a resolution request with no token in the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/board/resolution',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
