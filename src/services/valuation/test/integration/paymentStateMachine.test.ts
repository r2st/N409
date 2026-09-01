import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { newUlid } from '@n409/shared';
import {
  PAYMENT_INITIAL_STATUSES,
  PAYMENT_REVERSIBLE_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  canTransitionPayment,
  isTerminalPaymentStatus,
  type PaymentStatus,
} from '../../src/domain/payments.js';
import {
  createPayment,
  findPaymentBySessionId,
  recordDispute,
  recordRefund,
} from '../../src/repos/payments.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The machine a `payments` row moves through, and the writes that move it.
 *
 * The statuses were in the schema (migrations 0041 and 0099) and the edges
 * between them were nowhere: they lived in four `markPayment` call sites, two
 * UPDATE WHERE clauses, and the prose around them. R203's replayed settlement —
 * a refunded row marked succeeded again, handing back a published 409A to a
 * client who had every cent — was a missing edge, and it was invisible because
 * there was no machine to be missing from.
 *
 * The invoice half of billing has had this since billingStateMachine.test.ts;
 * this is the same census on the payment half.
 */

const SRC_DIR = new URL('../../src/', import.meta.url);
const REPO_SRC = readFileSync(new URL('repos/payments.ts', SRC_DIR), 'utf8');
const dbUp = await isDbAvailable();

/** Every `.ts` under src/, so a fifth caller in a new file is not invisible. */
function sourceFiles(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) return sourceFiles(child);
    return entry.name.endsWith('.ts') ? [child] : [];
  });
}

/**
 * `markPayment(…)` call sites, sliced on balanced parentheses rather than on a
 * closing shape — the four in the tree are written three different ways (one
 * inline, one multi-line, one inside an `if`), and a regex that ends at `);`
 * matched none of them.
 */
function markPaymentCalls(): Array<{ where: string; target: string; text: string }> {
  const calls: Array<{ where: string; target: string; text: string }> = [];
  for (const file of sourceFiles(SRC_DIR)) {
    if (file.pathname.endsWith('/repos/payments.ts')) continue; // the definition
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/markPayment\(/g)) {
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      for (; i < src.length; i += 1) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const text = src.slice(m.index!, i + 1);
      const target = /markPayment\(\s*[^,]+,\s*[^,]+,\s*'([a-z]+)'/.exec(text)?.[1] ?? '';
      // Last `/src/`, not the first: the repo path contains two.
      const rel = file.pathname.slice(file.pathname.lastIndexOf('/src/') + 5);
      calls.push({ where: `${rel} → '${target}'`, target, text });
    }
  }
  return calls;
}

describe('the declared payment state machine', () => {
  it('gives every status an entry, and names no status that is not one', () => {
    expect(Object.keys(PAYMENT_TRANSITIONS).sort()).toEqual([...PAYMENT_STATUSES].sort());
    for (const [from, tos] of Object.entries(PAYMENT_TRANSITIONS)) {
      for (const to of tos) {
        expect(PAYMENT_STATUSES, `${from} → ${to}`).toContain(to);
      }
    }
  });

  it('has no self-edges — a redelivery is not a transition', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(canTransitionPayment(status, status), `${status} → ${status}`).toBe(false);
    }
  });

  it('makes every ending terminal and the one beginning not', () => {
    for (const ending of ['failed', 'expired', 'refunded'] as const) {
      expect(isTerminalPaymentStatus(ending), ending).toBe(true);
    }
    expect(isTerminalPaymentStatus('pending')).toBe(false);
    expect(isTerminalPaymentStatus('succeeded')).toBe(false);
  });

  /**
   * The edge R203 was about. A settlement replayed onto a row that has since
   * been refunded must not walk it back, and the machine has to say so before a
   * `from` list can be checked against it.
   */
  it('refuses every way back out of a terminal status', () => {
    for (const ending of ['failed', 'expired', 'refunded'] as const) {
      for (const to of PAYMENT_STATUSES) {
        expect(canTransitionPayment(ending, to), `${ending} → ${to}`).toBe(false);
      }
    }
  });

  it('reaches money coming back only from money that arrived', () => {
    for (const from of PAYMENT_STATUSES) {
      expect(canTransitionPayment(from, 'refunded'), `${from} → refunded`).toBe(from === 'succeeded');
    }
    // And the reversal writers act on exactly that status plus the one they
    // themselves produce, since a second partial refund lands on it.
    expect([...PAYMENT_REVERSIBLE_STATUSES].sort()).toEqual(['refunded', 'succeeded']);
  });

  it('creates rows in exactly one status', () => {
    expect([...PAYMENT_INITIAL_STATUSES]).toEqual(['pending']);
    // The column default is what actually creates them; `createPayment` names
    // no status at all, so the default is the declaration.
    expect(REPO_SRC).not.toMatch(/INSERT INTO payments[\s\S]{0,400}?\bstatus\b/);
  });
});

describe('every write that moves a payment', () => {
  const callSites = markPaymentCalls();

  it('finds the call sites it means to check', () => {
    // Vacuity guard: a rename of the function, or a slicing rule that matches
    // none of the three ways these are written, turns every assertion below
    // into a loop over nothing.
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    for (const call of callSites) {
      expect(PAYMENT_STATUSES, `${call.where}: unreadable target`).toContain(call.target);
    }
  });

  it('states which statuses it is moving from, on every one of them', () => {
    for (const call of callSites) {
      expect(call.text, `${call.where} with no from:`).toMatch(/from:\s*\[/);
    }
  });

  it('names only statuses the machine lets reach the target', () => {
    for (const call of callSites) {
      const froms = [...call.text.matchAll(/from:\s*\[([^\]]*)\]/g)].flatMap((m) =>
        [...m[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1] as PaymentStatus),
      );
      expect(froms.length, `${call.where} has an empty from:`).toBeGreaterThan(0);
      for (const from of froms) {
        expect(PAYMENT_STATUSES, `${from} is not a payment status`).toContain(from);
        expect(canTransitionPayment(from, call.target as PaymentStatus), `${call.where} from '${from}'`).toBe(
          true,
        );
      }
    }
  });

  /**
   * The two UPDATEs that set 'refunded' do it in a CASE rather than through
   * `markPayment`, so the `from` census above cannot see them. Their guard is
   * the status list in the WHERE, and it has to be the declared one rather than
   * a list restated at the query.
   */
  it('bounds the reversal writers by the declared statuses, not by a literal', () => {
    const reversalUpdates = [...REPO_SRC.matchAll(/UPDATE payments[\s\S]*?RETURNING \*`/g)].filter((m) =>
      m[0].includes("'refunded'::payment_status"),
    );
    expect(reversalUpdates.length, 'expected recordRefund and recordDispute').toBe(2);
    for (const [sql] of reversalUpdates) {
      expect(sql).toMatch(/status::text = ANY\(\$\d+::text\[\]\)/);
      expect(sql, 'a status list written into the SQL drifts from the machine').not.toMatch(
        /status\s+IN\s*\(/,
      );
    }
  });
});

describe.skipIf(!dbUp)('the machine against the database', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  it('permits exactly the statuses the domain declares', async () => {
    const { rows } = await ctx.pool.query<{ label: string }>(
      `SELECT unnest(enum_range(NULL::payment_status))::text AS label`,
    );
    expect(rows.map((r) => r.label).sort()).toEqual([...PAYMENT_STATUSES].sort());
  });

  /** A payment row in a given status, on a valuation of its own. */
  const rowIn = async (status: PaymentStatus, sessionId: string) => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: { kind: '409a', company_name: `Machine ${sessionId}` },
    });
    const vid = created.json().valuation.id as string;
    await createPayment(ctx.pool, {
      valuationId: vid,
      sessionId,
      amountCents: 100_000,
      currency: 'USD',
      createdBy: ops.id,
    });
    const row = (await findPaymentBySessionId(ctx.pool, sessionId))!;
    if (status !== 'pending') {
      await ctx.pool.query('UPDATE payments SET status = $2 WHERE id = $1', [row.id, status]);
    }
    return (await findPaymentBySessionId(ctx.pool, sessionId))!;
  };

  it('refuses to record a refund against a payment that never settled', async () => {
    for (const status of ['pending', 'failed', 'expired'] as const) {
      const row = await rowIn(status, `cs_machine_refund_${status}_${newUlid()}`);
      const written = await recordRefund(ctx.pool, row.id, {
        refundedCents: 100_000,
        fullyRefunded: true,
      });
      expect(written, `${status} → refunded was written`).toBeNull();
      const after = (await findPaymentBySessionId(ctx.pool, row.session_id))!;
      expect(after.status).toBe(status);
    }
  });

  it('refuses to lose a chargeback against a payment that never settled', async () => {
    for (const status of ['pending', 'failed', 'expired'] as const) {
      const row = await rowIn(status, `cs_machine_dispute_${status}_${newUlid()}`);
      expect(
        await recordDispute(ctx.pool, row.id, 'lost', `du_${status}`),
        `${status} → refunded`,
      ).toBeNull();
      const after = (await findPaymentBySessionId(ctx.pool, row.session_id))!;
      expect(after.status).toBe(status);
    }
  });

  /*
   * Which chargeback the verdict belongs to (round 328).
   *
   * `charge.dispute.created` and `charge.dispute.closed` are separate events,
   * both retried for days, and Stripe orders neither — so a `created` for a
   * case already seen closed can arrive after the `closed`. Until the id was
   * stored there was nothing on the row to tell that apart from a real second
   * chargeback raised after the first was decided, and the write chose to
   * allow: a decided case read 'open' again, which is a live case with an
   * evidence deadline, and that is what the audit entry, the alerting line and
   * the notification to the billing group are all about.
   */
  it('refuses a stale reopening of the chargeback it already decided', async () => {
    const row = await rowIn('succeeded', `cs_machine_stale_open_${newUlid()}`);
    const won = await recordDispute(ctx.pool, row.id, 'won', 'du_stale');
    expect(won?.dispute_status).toBe('won');
    const decidedAt = won!.disputed_at;

    // The retried `charge.dispute.created` for the very same case, arriving
    // after the verdict it belongs to.
    expect(await recordDispute(ctx.pool, row.id, 'open', 'du_stale')).toBeNull();

    const after = (await findPaymentBySessionId(ctx.pool, row.session_id))!;
    expect(after.dispute_status).toBe('won');
    expect(after.disputed_at).toEqual(decidedAt);
  });

  it('records a second chargeback on the same charge, whatever the first concluded', async () => {
    /*
     * The other half, and the reason refusing outright was not the fix. An
     * early-warning enquiry closed (`warning_closed`, recorded 'won') and a
     * real chargeback raised on the same charge afterwards is the pair that
     * used to be indistinguishable from the stale delivery above. It is a live
     * case with a deadline, and dropping it would be the worse mistake.
     */
    const row = await rowIn('succeeded', `cs_machine_second_case_${newUlid()}`);
    expect((await recordDispute(ctx.pool, row.id, 'won', 'du_warning'))?.dispute_status).toBe('won');

    const second = await recordDispute(ctx.pool, row.id, 'open', 'du_real_chargeback');
    expect(second?.dispute_status).toBe('open');
    expect(second?.dispute_id).toBe('du_real_chargeback');
    // Dated to the case it is about, not to the enquiry that closed before it.
    expect(second!.disputed_at!.getTime()).toBeGreaterThanOrEqual(
      (await findPaymentBySessionId(ctx.pool, row.session_id))!.disputed_at!.getTime(),
    );
  });

  it('leaves a verdict it cannot identify as permissive as it was', async () => {
    /*
     * A row whose `dispute_id` is NULL — a verdict recorded before migration
     * 0203, or an event carrying no id — is one we cannot place. The old
     * behaviour is kept there rather than guessed at, because it is exactly
     * the case the old behaviour was written for: refusing would drop a live
     * chargeback on the strength of a column we never filled in.
     */
    const row = await rowIn('succeeded', `cs_machine_unidentified_${newUlid()}`);
    expect((await recordDispute(ctx.pool, row.id, 'won', null))?.dispute_status).toBe('won');
    expect((await findPaymentBySessionId(ctx.pool, row.session_id))!.dispute_id).toBeNull();
    expect((await recordDispute(ctx.pool, row.id, 'open', null))?.dispute_status).toBe('open');
  });

  it('still records both against a settled payment', async () => {
    const refundRow = await rowIn('succeeded', `cs_machine_ok_refund_${newUlid()}`);
    const refunded = await recordRefund(ctx.pool, refundRow.id, {
      refundedCents: 100_000,
      fullyRefunded: true,
    });
    expect(refunded?.status).toBe('refunded');

    const disputeRow = await rowIn('succeeded', `cs_machine_ok_dispute_${newUlid()}`);
    expect((await recordDispute(ctx.pool, disputeRow.id, 'lost', 'du_machine_ok'))?.status).toBe('refunded');
  });
});
