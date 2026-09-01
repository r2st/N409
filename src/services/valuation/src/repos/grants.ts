import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { calendarDateRow } from '../domain/calendarDate.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { GRANT_EVENT_TYPES } from '../domain/vesting.js';

export interface GrantRow {
  id: string;
  valuation_id: string;
  grantee_name: string;
  grantee_email: string | null;
  grant_date: string;
  options_count: number;
  exercise_price: string;
  currency: string;
  vesting_template: string;
  vesting_start_date: string;
  vesting_months: number;
  cliff_months: number;
  frequency_months: number;
  status: 'active' | 'cancelled';
  notes: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * `grant_date` and `vesting_start_date` are `date` columns the interface above
 * declares `string`, and the grants routes send the row as it stands. See
 * domain/calendarDate.ts. The vesting schedule is built from these two, so a
 * row that leaves as an instant moves every tranche with it.
 */
const hydrated = (row: GrantRow): GrantRow => calendarDateRow(row, 'grant_date', 'vesting_start_date');

export interface CreateGrantInput {
  valuationId: string;
  granteeName: string;
  granteeEmail?: string | null;
  grantDate: string;
  optionsCount: number;
  exercisePrice: number;
  currency: string;
  vestingTemplate: string;
  vestingStartDate: string;
  vestingMonths: number;
  cliffMonths: number;
  frequencyMonths: number;
  notes?: string | null;
  createdBy: string;
  /** Provenance for HRIS-imported grants (feature 11). */
  source?: string;
  externalId?: string | null;
  /**
   * The board approval this issuance is being made under, re-asked inside the
   * transaction — see {@link createGrant}. Absent on the HRIS import, which
   * records grants made elsewhere rather than issuing one here.
   */
  requireApproval?: { approvedAt: Date | null };
}

/** A grant may only be issued off a live board approval — the route's sentence. */
export const GRANTS_NEED_APPROVAL =
  'Grants can only be issued after the board has approved the 409A valuation';

/**
 * The same check, when the approval the caller read is not the one still
 * standing. A different sentence because the operator's next move is different:
 * nothing is missing, the board's position moved underneath them.
 */
export const APPROVAL_MOVED =
  'The board’s approval of this valuation changed while the grant was being issued — reload the ' +
  'board resolution and issue the grant again.';

/**
 * Issue a grant, and its audit event, atomically.
 *
 * THE APPROVAL THIS IS ISSUED UNDER IS A READ THE ROUTE TOOK EARLIER (round
 * 312, methodology M3). `POST /valuations/:id/grants` refuses unless the board
 * resolution is `approved`, because an option struck at a §409A fair market
 * value the board has not adopted is the compliance failure the whole board
 * workflow exists to prevent — and the exercise price it defaults to is that
 * resolution's `fmv_conclusion`.
 *
 * Both come from `findResolutionByValuation` on the pool, statements before the
 * INSERT, and the approval is a state three doors can take back: a director
 * removed (`deleteBoardMember`), a director's decision recorded
 * (`recordSignoff`), and a regeneration replacing the document outright
 * (`upsertResolution`, R312). Each of those takes the resolution `FOR UPDATE`,
 * so asking again under that lock settles the question against a row nothing
 * can move until this transaction ends.
 *
 * `approved_at` rather than the status alone, because 'approved' is not one
 * state: a resolution regenerated at a different FMV and re-signed is approved
 * too, and it is not the approval the caller read or the figure they were
 * shown. The timestamp is stamped exactly once per approval
 * (`refreshResolutionStatusTx`), which makes it the generation marker.
 */
export async function createGrant(
  pool: pg.Pool,
  input: CreateGrantInput,
  actor: EventActor,
): Promise<GrantRow> {
  return withTransaction(pool, async (client) => {
    if (input.requireApproval) {
      const { rows: live } = await client.query<{ status: string; approved_at: Date | null }>(
        'SELECT status, approved_at FROM board_resolutions WHERE valuation_id = $1 FOR UPDATE',
        [input.valuationId],
      );
      const resolution = live[0];
      if (!resolution || resolution.status !== 'approved' || resolution.approved_at === null) {
        throw problems.conflict(GRANTS_NEED_APPROVAL);
      }
      if (
        input.requireApproval.approvedAt === null ||
        resolution.approved_at.getTime() !== input.requireApproval.approvedAt.getTime()
      ) {
        throw problems.conflict(APPROVAL_MOVED);
      }
    }
    const id = newUlid();
    const { rows } = await client.query<GrantRow>(
      `INSERT INTO option_grants
         (id, valuation_id, grantee_name, grantee_email, grant_date, options_count,
          exercise_price, currency, vesting_template, vesting_start_date,
          vesting_months, cliff_months, frequency_months, notes, created_by, source, external_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        id,
        input.valuationId,
        input.granteeName,
        input.granteeEmail ?? null,
        input.grantDate,
        input.optionsCount,
        input.exercisePrice,
        input.currency,
        input.vestingTemplate,
        input.vestingStartDate,
        input.vestingMonths,
        input.cliffMonths,
        input.frequencyMonths,
        input.notes ?? null,
        input.createdBy,
        input.source ?? 'manual',
        input.externalId ?? null,
      ],
    );
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: GRANT_EVENT_TYPES.granted,
      actor,
      payload: {
        grant_id: id,
        grantee_name: input.granteeName,
        options_count: input.optionsCount,
        exercise_price: input.exercisePrice,
      },
    });
    return hydrated(rows[0]!);
  });
}

/**
 * The cap on one valuation's option grants.
 *
 * Set an order of magnitude above any real cap table — the largest private
 * companies this platform values have low thousands of live grants — because
 * this list is not only a screen. The auditor workbook builds a sheet from it,
 * and a deliverable that silently omits grants is worse than one that refuses
 * to build, so the export checks `truncated` and refuses rather than shipping
 * a short one. What the cap actually guards against is the HRIS import: a
 * misconfigured connector replaying its whole population into one engagement
 * had no ceiling at all before this.
 */
export const GRANT_PAGE_LIMIT = 10_000;

export async function listGrants(
  pool: pg.Pool,
  valuationId: string,
  opts: { limit?: number } = {},
): Promise<{ grants: GrantRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? GRANT_PAGE_LIMIT, 1), GRANT_PAGE_LIMIT);
  const { rows } = await pool.query<GrantRow>(
    `SELECT * FROM option_grants
      WHERE valuation_id = $1
      ORDER BY grant_date DESC, created_at DESC
      LIMIT $2`,
    [valuationId, limit + 1],
  );
  return { grants: rows.slice(0, limit).map(hydrated), truncated: rows.length > limit };
}

export async function findGrantById(pool: pg.Pool, id: string): Promise<GrantRow | null> {
  const { rows } = await pool.query<GrantRow>('SELECT * FROM option_grants WHERE id = $1', [id]);
  return rows[0] ? hydrated(rows[0]) : null;
}

const MUTABLE_FIELDS: Record<string, string> = {
  grantee_name: 'grantee_name',
  grantee_email: 'grantee_email',
  grant_date: 'grant_date',
  options_count: 'options_count',
  vesting_template: 'vesting_template',
  vesting_start_date: 'vesting_start_date',
  vesting_months: 'vesting_months',
  cliff_months: 'cliff_months',
  frequency_months: 'frequency_months',
  notes: 'notes',
};

/**
 * The one sentence that answers an edit to a cancelled grant, wherever the
 * cancellation is noticed — the route's own read, or the UPDATE below.
 */
export const GRANT_CANCELLED_DETAIL =
  'This grant has been cancelled and can no longer be edited — issue a new grant instead.';

/**
 * Edit a grant's mutable columns.
 *
 * THE REFUSAL THE ROUTE MAKES IS A READ, AND THIS IS THE WRITE (round 312,
 * methodology M3). R296 shut this door on a cancelled grant — the row is the
 * record of a security issued and then withdrawn, so the grantee, the count,
 * the grant date and the whole vesting schedule stop being editable once
 * `cancelGrant` has run. But the status it decides on is read by the route on
 * the pool, two statements earlier, and `cancelGrant` is a `DELETE
 * /grants/:grantId` on the same screen: cancel and save land together in the
 * ordinary use of the page, not an exotic interleaving of it.
 *
 * So the predicate goes in the WHERE, which is the same move `cancelGrant`
 * itself makes and the same one `patchTask` and `recordSignoff` make: the
 * second transaction blocks on the first's row lock, then re-evaluates against
 * the committed row and matches nothing. The route's pool-side check stays —
 * it answers the ordinary, uncontended case before a transaction is opened, and
 * with the same sentence, so which one caught it is invisible to the caller.
 *
 * Matching nothing has two causes and they want different answers: the grant
 * was cancelled while the edit was being made (409, the sentence above), or the
 * valuation it hangs off was hard-deleted and `ON DELETE CASCADE` took it (404).
 * The throw rolls the transaction back, so a lost race writes no event either.
 */
export async function updateGrant(
  pool: pg.Pool,
  grant: GrantRow,
  patch: Record<string, unknown>,
  actor: EventActor,
): Promise<GrantRow> {
  const sets: string[] = [];
  const values: unknown[] = [grant.id];
  for (const [key, col] of Object.entries(MUTABLE_FIELDS)) {
    if (key in patch) {
      values.push(patch[key]);
      sets.push(`${col} = $${values.length}`);
    }
  }
  if (sets.length === 0) return grant;
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<GrantRow>(
      `UPDATE option_grants SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND status = 'active' RETURNING *`,
      values,
    );
    if (rows.length === 0) throw await staleGrantPatch(client, grant.id);
    await recordEvent(client, {
      valuationId: grant.valuation_id,
      type: GRANT_EVENT_TYPES.updated,
      actor,
      payload: { grant_id: grant.id, fields: Object.keys(patch) },
    });
    return hydrated(rows[0]!);
  });
}

/** Why the pinned UPDATE above matched nothing, as something to throw. */
async function staleGrantPatch(client: pg.PoolClient, grantId: string): Promise<Error> {
  const { rows } = await client.query<{ id: string }>('SELECT id FROM option_grants WHERE id = $1', [
    grantId,
  ]);
  if (rows.length === 0)
    return problems.notFound(
      'This grant no longer exists — the valuation it belongs to was deleted while this change was ' +
        'being made. Nothing was recorded.',
    );
  return problems.conflict(GRANT_CANCELLED_DETAIL);
}

/**
 * Cancel a grant, once.
 *
 * `DELETE /grants/:grantId` asks nothing about the grant's status before
 * calling this, and the UPDATE asked nothing either — so a repeated call, which
 * is a double-clicked button or a retried request, re-stamped `updated_at` and
 * put a second `grant_cancelled` on the audit spine. A grant is a security
 * somebody holds and its cancellation is the event an auditor reads to date the
 * forfeiture; two of them, minutes apart, describe two cancellations of a grant
 * that was cancelled once.
 *
 * The already-cancelled row comes back unchanged rather than as an error: the
 * caller asked for the grant to be cancelled and it is.
 */
export async function cancelGrant(pool: pg.Pool, grant: GrantRow, actor: EventActor): Promise<GrantRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<GrantRow>(
      "UPDATE option_grants SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'active' RETURNING *",
      [grant.id],
    );
    const cancelled = rows[0];
    if (!cancelled) return hydrated(grant);
    await recordEvent(client, {
      valuationId: grant.valuation_id,
      type: GRANT_EVENT_TYPES.cancelled,
      actor,
      payload: { grant_id: grant.id },
    });
    return hydrated(cancelled);
  });
}
