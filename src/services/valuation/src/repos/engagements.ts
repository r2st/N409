import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { ENGAGEMENT_EVENT_TYPES, stageByKey, type StageHistoryEntry } from '../domain/engagement.js';
import { STATE_GROUPS } from '../domain/operations.js';
import type { RoleKey } from '../domain/roles.js';

export interface EngagementRow {
  id: string;
  valuation_id: string;
  current_stage: string;
  assigned_analyst_id: string | null;
  stage_entered_at: Date;
  created_at: Date;
  updated_at: Date;
}

export async function findEngagement(pool: pg.Pool, valuationId: string): Promise<EngagementRow | null> {
  const { rows } = await pool.query<EngagementRow>('SELECT * FROM engagements WHERE valuation_id = $1', [
    valuationId,
  ]);
  return rows[0] ?? null;
}

/** Create the engagement at the kickoff stage if it doesn't exist yet. */
export async function ensureEngagement(
  pool: pg.Pool,
  valuationId: string,
  actor: EventActor,
): Promise<EngagementRow> {
  const existing = await findEngagement(pool, valuationId);
  if (existing) return existing;
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<EngagementRow>(
      `INSERT INTO engagements (id, valuation_id) VALUES ($1, $2)
       ON CONFLICT (valuation_id) DO NOTHING
       RETURNING *`,
      [id, valuationId],
    );
    // Lost the race — read the row the other writer created.
    if (rows.length === 0) {
      const { rows: again } = await client.query<EngagementRow>(
        'SELECT * FROM engagements WHERE valuation_id = $1',
        [valuationId],
      );
      return again[0]!;
    }
    await client.query(
      `INSERT INTO engagement_stage_history (id, engagement_id, valuation_id, stage, entered_by)
       VALUES ($1, $2, $3, 'kickoff', $4)`,
      [newUlid(), id, valuationId, actor.actorId ?? null],
    );
    await recordEvent(client, {
      valuationId,
      type: ENGAGEMENT_EVENT_TYPES.started,
      actor,
      payload: { stage: 'kickoff' },
    });
    return rows[0]!;
  });
}

/**
 * Move the engagement to `toStage`, but only if it is still where the caller
 * read it.
 *
 * THE `WHERE current_stage = $3` IS THE POINT. This used to update by primary
 * key alone, and every guard the route applies — "unknown stage", "already at
 * that stage", "already at its final stage" — is computed from a row read on a
 * *different* connection some milliseconds earlier. So none of them survived
 * two operators with the panel open, which is the ordinary case for a pipeline
 * board that exists to be worked from:
 *
 *   * Two advances off one read both committed. The trail got two rows and two
 *     events, and the second event said `from: kickoff` for a move out of
 *     `analysis` — a transition that never happened, written into an
 *     append-only log a compliance reader is entitled to believe.
 *   * Each caller was handed back the row *its own* UPDATE returned, so both
 *     were told the engagement was somewhere it was not. One of them was wrong
 *     before the response finished serialising.
 *   * `stage_entered_at` — the SLA clock, and the thing the overdue sweep
 *     reads — was reset twice, so a double-click bought the stage a fresh
 *     window.
 *
 * A conditional UPDATE makes the guard and the write the same act. Losing the
 * race is a 409 naming the stage the engagement actually reached, because the
 * caller's next move depends on where it is now, not on being told "conflict".
 * The throw rolls the transaction back, so a lost race writes no history row
 * and no event either.
 *
 * `reopen` selects the event type only; the refusal that decides whether a
 * reopen is allowed at all is `planStageTransition`.
 */
export async function advanceStage(
  pool: pg.Pool,
  engagement: EngagementRow,
  toStage: string,
  actor: EventActor,
  opts: { reopen?: boolean } = {},
): Promise<EngagementRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<EngagementRow>(
      `UPDATE engagements SET current_stage = $2, stage_entered_at = now(), updated_at = now()
       WHERE id = $1 AND current_stage = $3 RETURNING *`,
      [engagement.id, toStage, engagement.current_stage],
    );
    if (rows.length === 0) throw await staleAdvance(client, engagement);
    await client.query(
      `INSERT INTO engagement_stage_history (id, engagement_id, valuation_id, stage, entered_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [newUlid(), engagement.id, engagement.valuation_id, toStage, actor.actorId ?? null],
    );
    await recordEvent(client, {
      valuationId: engagement.valuation_id,
      type: opts.reopen ? ENGAGEMENT_EVENT_TYPES.reopened : ENGAGEMENT_EVENT_TYPES.stageAdvanced,
      actor,
      payload: { from: engagement.current_stage, to: toStage },
    });
    return rows[0]!;
  });
}

/**
 * Why the conditional UPDATE above matched nothing, as something to throw.
 *
 * Two possibilities, and they want different answers: somebody else moved the
 * stage (409, and the message names where it went, because that is what decides
 * what the caller does next), or the engagement is gone — the valuation was
 * hard-deleted out from under the request and `ON DELETE CASCADE` took it (404).
 */
async function staleAdvance(client: pg.PoolClient, engagement: EngagementRow): Promise<Error> {
  const { rows } = await client.query<{ current_stage: string }>(
    'SELECT current_stage FROM engagements WHERE id = $1',
    [engagement.id],
  );
  const actual = rows[0]?.current_stage;
  /*
   * Not a bare 404. The existence-oracle argument that keeps most of this
   * estate's 404s wordless does not apply here: the caller loaded this
   * engagement to attempt the advance, so naming what happened to it discloses
   * nothing they did not already have. "Resource not found" in reply to a stage
   * advance reads as a bad request rather than as the row having gone.
   */
  if (actual === undefined)
    return problems.notFound(
      'This engagement no longer exists — the valuation it belongs to was deleted while this ' +
        'change was being made. Nothing was recorded.',
    );
  const label = stageByKey(actual)?.label ?? actual;
  return problems.conflict(
    `The engagement moved to "${label}" while this change was being made. Reload the engagement and try again.`,
  );
}

export async function assignAnalyst(
  pool: pg.Pool,
  engagement: EngagementRow,
  analystId: string | null,
  actor: EventActor,
): Promise<EngagementRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<EngagementRow>(
      `UPDATE engagements SET assigned_analyst_id = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [engagement.id, analystId],
    );
    await recordEvent(client, {
      valuationId: engagement.valuation_id,
      type: ENGAGEMENT_EVENT_TYPES.analystAssigned,
      actor,
      payload: { analyst_id: analystId },
    });
    return rows[0]!;
  });
}

/**
 * Ceiling on one engagement's stage trail.
 *
 * A row per stage entry, and the stage can be re-entered — an engagement that
 * bounces between review and drafting writes one every time — so the trail is
 * not bounded by the number of stages. Oldest first: the trail is read to see
 * where the time went, which is a question about the beginning.
 */
export const STAGE_HISTORY_LIMIT = 500;

export async function stageHistory(
  pool: pg.Pool,
  engagementId: string,
): Promise<{ history: StageHistoryEntry[]; truncated: boolean }> {
  const { rows } = await pool.query<StageHistoryEntry>(
    `SELECT stage, entered_at FROM engagement_stage_history
      WHERE engagement_id = $1 ORDER BY entered_at LIMIT $2`,
    [engagementId, STAGE_HISTORY_LIMIT + 1],
  );
  return {
    history: rows.slice(0, STAGE_HISTORY_LIMIT),
    truncated: rows.length > STAGE_HISTORY_LIMIT,
  };
}

export interface EngagementListRow extends EngagementRow {
  company_name: string;
  valuation_state: string;
  kind: string;
  analyst_email: string | null;
  /**
   * The assigned analyst's account state, carried so the sweep can decide
   * whether the assignment is still one it may act on. Null across all three
   * when nobody is assigned. See {@link analystIsChasable}.
   */
  analyst_deleted_at: Date | null;
  analyst_roles: RoleKey[] | null;
  analyst_partner_id: string | null;
}

/** Ceiling on one page of the active-engagement pipeline. */
export const ENGAGEMENT_PAGE_LIMIT = 500;

/**
 * Active engagements (not yet complete) for the pipeline dashboard, joined to
 * their valuation and assigned analyst.
 *
 * Bounded: the set is every engagement the firm has not finished, which grows
 * with the firm and with anything that stalls. Oldest-in-stage first is kept
 * deliberately under the cap — the rows a pipeline board exists to surface are
 * the ones that have sat longest, so a capped page is the end that matters
 * rather than an arbitrary slice.
 */
export async function listActiveEngagements(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ engagements: EngagementListRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? ENGAGEMENT_PAGE_LIMIT, 1), ENGAGEMENT_PAGE_LIMIT);
  const { rows } = await pool.query<EngagementListRow>(
    `${ACTIVE_ENGAGEMENT_SELECT}
      WHERE ${ACTIVE_ENGAGEMENT_WHERE}
      ORDER BY e.stage_entered_at ASC, e.id ASC
      LIMIT $1`,
    [limit + 1],
  );
  return { engagements: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * The join the pipeline board and the overdue sweep both read through.
 *
 * `v.archived_at IS NULL` belongs here rather than in either caller, so the
 * board and the sweep cannot come to disagree about which engagements are still
 * live. Archiving is this platform's soft delete for valuations, and it moves
 * `archived_at` and nothing else — not `engagements.current_stage`, not the
 * valuation's `state` — so a retired engagement stayed `<> 'complete'` and both
 * readers kept finding it.
 *
 * The board showed it, which was wrong. The sweep emailed about it, which was
 * worse: the assigned analyst was chased with "Overdue: … is past SLA in …"
 * over work the firm had withdrawn, once per sweep, for as long as the stage
 * stayed open — and the stage cannot close, because nobody is working it.
 *
 * `analyst_roles` IS A LATERAL JOIN AND NOT A SCALAR SUBQUERY, which is the
 * difference between one lookup per analyst and one per engagement. R279 wrote
 * it as `(SELECT array_agg(…) … WHERE ur.user_id = u.id)` in the select list,
 * and Postgres has no way to cache that: a scalar SubPlan is re-executed for
 * every row of the outer plan, where a LATERAL sits in the join tree and can go
 * under a `Memoize` as the `users` join beside it already does. The spellings
 * return the same value by construction — an aggregate over an empty set is one
 * NULL row either way, so an engagement with no analyst still reads `null` —
 * and the whole difference is how many times the aggregate runs.
 *
 * AND IT IS KEYED ON `e.assigned_analyst_id`, NOT ON `u.id`, WHICH IS THE
 * WHOLE OF WHETHER THE MEMOIZE APPEARS. A `Memoize` is costed from the
 * planner's estimate of how many *distinct* values the parameter takes over the
 * loops: cache the lookup only if the keys repeat. `u.id` is the primary key of
 * `users`, so its `n_distinct` is -1 — unique, by definition — and the planner
 * therefore estimates a 500-row page to carry 500 distinct analysts and builds
 * no cache. `e.assigned_analyst_id` is the same value read off the other side
 * of the join, and ANALYZE has measured *it*: a couple of dozen distinct
 * values over the whole book, which is the number the decision actually turns
 * on.
 *
 * The two are equal on every row the LATERAL can see —
 * `engagements_assigned_analyst_id_fkey` means a non-null assignment always
 * names a real user, so `u` is never the missing side of its LEFT JOIN, and
 * where the assignment is NULL both spellings match no `user_roles` row and
 * aggregate to `null`.
 *
 * R283 wrote the LATERAL keyed on `u.id` and measured a `Memoize` over it,
 * which was true of the database it measured: `engagementRosterPlan` seeds a
 * `users` table containing nothing but the twenty analysts, so `u.id` had
 * twenty distinct values there too and the estimate came out right by accident.
 * On a real book — every client contact, every board member, every deleted
 * account in `users` beside the analysts — the estimate is the row count and
 * the cache is not built. Measured on 60k engagements, 50k users and 30
 * analysts, a 500-row page: 5002 buffers and 10.2–19.2 ms keyed on `u.id`
 * against 2381 and 4.5–5.4 ms keyed on the assignment, with the roles lookup
 * itself going 2753 blocks to 132.
 *
 * Which matters because of who reads this, and because of the one thing an
 * engagement book is guaranteed to look like: a firm's open pipeline is held by
 * a couple of dozen analysts, not by a different person per file. Measured on
 * 40k engagements with a 500-row page and twenty analysts holding it, the
 * SubPlan ran its aggregate 500 times to answer twenty distinct questions —
 * 1717 buffers against the LATERAL's 81, and 8.3ms against 4.9ms for the page.
 * `eachActiveEngagement` pages the *entire* active book through this on every
 * sweep tick, so the waste is per page and the number of pages grows with the
 * firm.
 *
 * Invisible to `listQueryScaling` for the reason R193's LATERAL finding was:
 * the endpoint issues one statement however many rows come back, so a ratio
 * over statement counts cannot see cost *inside* one. `engagementRosterPlan`
 * measures it instead, with the SubPlan spelling explained alongside as the
 * discriminator.
 */
const ACTIVE_ENGAGEMENT_SELECT = `
  SELECT e.*, v.company_name, v.state AS valuation_state, v.kind, u.email AS analyst_email,
         u.deleted_at AS analyst_deleted_at, u.partner_id AS analyst_partner_id,
         ar.analyst_roles
    FROM engagements e
    JOIN valuations v ON v.id = e.valuation_id
    LEFT JOIN users u ON u.id = e.assigned_analyst_id
    LEFT JOIN LATERAL (
      SELECT array_agg(r.key) AS analyst_roles
        FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = e.assigned_analyst_id
    ) ar ON true`;

/**
 * Applied by both readers below; see ACTIVE_ENGAGEMENT_SELECT for why.
 *
 * A CLOSED VALUATION IS THE OTHER WAY THE WORK STOPS (round 400, methodology
 * M3). The paragraph above is about `archived_at`, and it is the rarer half:
 * retirement is the retention sweep's word for a file the firm withdraws years
 * later. `cancelled`, `timeout` and `ignored` are how work actually stops — the
 * three terminal states of `WORKFLOW_TRANSITIONS`, reached the week the client
 * goes quiet — and nothing cascades from them onto the engagement. Closing a
 * valuation moves `state` and nothing else: not `engagements.current_stage`,
 * which only `advanceStage` writes and which nobody is going to advance,
 * because nobody is working the file.
 *
 * So the row stays `<> 'complete'` forever and both readers kept finding it,
 * with exactly the two consequences named above and one worse: the board showed
 * a called-off engagement among the live ones, and the overdue sweep emailed
 * the assigned analyst "Overdue: … is past SLA in …" about it once per tick,
 * for as long as the stage stayed open — which is forever — while writing an
 * `engagement_overdue_reminder` onto a spine whose 0001 trigger will not let it
 * be taken back off.
 *
 * `STATE_GROUPS.closed` rather than three literals: this is the fourth
 * predicate in the service asking what "closed" means, and a list spelled once
 * per query is how they come to disagree.
 */
const ACTIVE_ENGAGEMENT_WHERE = `v.archived_at IS NULL AND e.current_stage <> 'complete'
     AND v.state <> ALL(ARRAY[${STATE_GROUPS.closed.map((s) => `'${s}'`).join(', ')}]::valuation_state[])`;

/**
 * Every active engagement, a page at a time.
 *
 * The overdue-reminder sweep must see all of them — a cap there does not slow a
 * page down, it silently stops sending the alerts the SLA exists to produce, and
 * the failure is invisible because the endpoint still reports a success count.
 * So the sweep pages rather than truncates: bounded memory per query, complete
 * coverage across them. Keyset rather than OFFSET because the set is being
 * mutated as the sweep advances through it.
 *
 * Ordered by `id`, not by `stage_entered_at` as the board is. A sweep needs
 * every row exactly once and does not care in what order, and `id` is the one
 * column that can deliver that: it is the primary key, so it is unique and
 * totally ordered, and it is text, so the cursor survives the round trip
 * through JavaScript intact. A `timestamptz` does not — Postgres keeps
 * microseconds, node-postgres hands back a `Date` carrying milliseconds, and
 * the truncated value sent back as a cursor re-selects the row it was supposed
 * to advance past. That is not a slow sweep, it is a sweep that never
 * terminates.
 */
export async function* eachActiveEngagement(
  pool: pg.Pool,
  opts: { pageSize?: number } = {},
): AsyncGenerator<EngagementListRow> {
  const size = Math.min(Math.max(opts.pageSize ?? ENGAGEMENT_PAGE_LIMIT, 1), ENGAGEMENT_PAGE_LIMIT);
  let after: string | null = null;
  for (;;) {
    const params: unknown[] = [size];
    const cursorSql: string = after ? `AND e.id > $${params.push(after)}` : '';
    const { rows }: pg.QueryResult<EngagementListRow> = await pool.query<EngagementListRow>(
      `${ACTIVE_ENGAGEMENT_SELECT}
        WHERE ${ACTIVE_ENGAGEMENT_WHERE} ${cursorSql}
        ORDER BY e.id ASC
        LIMIT $1`,
      params,
    );
    for (const row of rows) yield row;
    if (rows.length < size) return;
    after = rows[rows.length - 1]!.id;
  }
}
