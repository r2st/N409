import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A methodology decision is revised once.
 *
 * `methodology_decisions.supersedes` is the log's only edge and the only thing
 * that strikes an entry through, so two rows pointing at one prior decision is
 * a fork: the earlier entry is struck through exactly once, and the log — and
 * the evidence bundle an auditor reads it out of — carries two live,
 * contradictory revisions of one methodology choice with nothing to order them.
 *
 * The rule existed only in the browser. `DecisionsTab` builds its "Supersedes"
 * select from `decisions.filter((d) => !d.superseded)`, and a select is a
 * snapshot: the second of two operators working the same engagement, a tab left
 * open while a colleague revises the row it is listing, or a retried submit all
 * post a target that stopped being revisable after the page was drawn. The
 * route's own read could not close it either, being one statement earlier on
 * another connection.
 */
describe.skipIf(!dbUp)('methodology decision revisions', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function newValuation(companyName: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  }

  const record = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/decisions`,
      headers: authHeader(ops.token),
      payload: { category: 'dlom', rationale: 'because', ...payload },
    });

  const listDecisions = async (id: string) => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/decisions`,
      headers: authHeader(ops.token),
    });
    expect(list.statusCode).toBe(200);
    return list.json().decisions as Array<{ id: string; supersedes: string | null; superseded: boolean }>;
  };

  it('refuses a second revision of the same decision, and names the first', async () => {
    const id = await newValuation('ForkCo, Inc.');
    const first = await record(id, { decision: 'DLOM of 30% via Finnerty' });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().decision.id as string;

    const revision = await record(id, { decision: 'DLOM revised to 25%', supersedes: firstId });
    expect(revision.statusCode).toBe(201);
    const revisionId = revision.json().decision.id as string;

    const fork = await record(id, { decision: 'DLOM revised to 20%', supersedes: firstId });
    expect(fork.statusCode).toBe(409);
    // Named, because the operator's next step is to read the revision that got
    // there first and decide whether they still disagree with it.
    expect(fork.json().detail).toContain(revisionId);

    // Nothing was written: no third row, and the log still has one revision.
    const decisions = await listDecisions(id);
    expect(decisions).toHaveLength(2);
    expect(decisions.filter((d) => !d.superseded)).toHaveLength(1);
  });

  it('leaves the log unforked when two revisions of one decision arrive together', async () => {
    // The ordinary way this is reached, and the one a read-then-write cannot
    // stop: two operators on the same engagement, each holding a select drawn
    // before the other submitted. Repeated, because a single interleaving that
    // happens to serialise proves nothing.
    for (let run = 0; run < 4; run++) {
      const id = await newValuation(`RaceCo ${run}, Inc.`);
      const first = await record(id, { decision: 'DLOM of 30%' });
      const firstId = first.json().decision.id as string;

      const [a, b] = await Promise.all([
        record(id, { decision: 'DLOM revised to 25%', supersedes: firstId }),
        record(id, { decision: 'DLOM revised to 20%', supersedes: firstId }),
      ]);

      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes, `run ${run}`).toEqual([201, 409]);

      const decisions = await listDecisions(id);
      expect(decisions, `run ${run}`).toHaveLength(2);
      // The invariant, stated as itself: exactly one row revises the first
      // decision, so exactly one entry is struck through and one is live.
      expect(decisions.filter((d) => d.supersedes === firstId), `run ${run}`).toHaveLength(1);
      expect(decisions.filter((d) => d.superseded), `run ${run}`).toHaveLength(1);
    }
  });

  it('still accepts a revision of the revision — the chain is a chain, not a cap', async () => {
    const id = await newValuation('ChainCo, Inc.');
    const first = await record(id, { decision: 'DLOM of 30%' });
    const firstId = first.json().decision.id as string;
    const second = await record(id, { decision: 'DLOM of 25%', supersedes: firstId });
    const secondId = second.json().decision.id as string;

    const third = await record(id, { decision: 'DLOM of 20%', supersedes: secondId });
    expect(third.statusCode).toBe(201);

    const decisions = await listDecisions(id);
    expect(decisions.filter((d) => d.superseded).map((d) => d.id).sort()).toEqual(
      [firstId, secondId].sort(),
    );
  });
});
