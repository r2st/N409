import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { calendarDateRow } from '../domain/calendarDate.js';
import { recordEvent, type EventActor } from '../events/record.js';
import {
  BOARD_EVENT_TYPES,
  boardSignoffTokenExpiry,
  resolutionStatusFrom,
  type BoardResolutionStatus,
  type BoardSignoffStatus,
} from '../domain/boardResolution.js';

/**
 * `valuation_date` is a `date` column this declares `string`, and the board
 * routes send the resolution row as it stands — including into the auditor
 * portal and the resolution PDF. See domain/calendarDate.ts.
 */
const resolution = (row: BoardResolutionRow): BoardResolutionRow => calendarDateRow(row, 'valuation_date');

export interface BoardResolutionRow {
  id: string;
  valuation_id: string;
  valuation_date: string;
  fmv_conclusion: string;
  currency: string;
  methodology_summary: string;
  appraiser_qualifications: string;
  body_html: string;
  status: BoardResolutionStatus;
  approved_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface BoardSignoffRow {
  id: string;
  resolution_id: string;
  valuation_id: string;
  member_name: string;
  member_email: string;
  member_title: string | null;
  token_sha256: string;
  /** Deadline on the emailed token (migration 0101); re-minting pushes it out. */
  token_expires_at: Date;
  status: BoardSignoffStatus;
  comment: string | null;
  sent_at: Date | null;
  signed_at: Date | null;
  created_at: Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Generates a signing token; the raw value is emailed, only the hash is stored. */
export function mintSignoffToken(): { token: string; hash: string } {
  const token = `n409_brd_${randomBytes(24).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

/**
 * Insert-or-replace the resolution: regenerating supersedes the body + resets
 * status.
 *
 * THE THIRD DOOR ONTO approved → pending, AND THE ONLY ONE THAT LEFT NO TRACE
 * (round 312, methodology M3).
 *
 * `refreshResolutionStatusTx` is where the aggregate is meant to move, and it
 * records every direction it moves in — including the way back out of a
 * decision, which is what `board_resolution_reopened` is for. R288 closed the
 * `addBoardMember` door onto that direction by refusing under the row lock;
 * `deleteBoardMember` is allowed through it and says so on the spine.
 *
 * This statement reaches the same place without going near either: the
 * `DO UPDATE` writes `status = 'pending'` and `approved_at = NULL` directly, so
 * regenerating over a resolution the board had already adopted withdrew that
 * adoption — the safe-harbor timestamp cleared, every director's signature
 * deleted by the statement below — and put nothing on the trail but
 * `board_resolution_generated`, which is the same event a first generation
 * writes. A reader could not tell a fresh document from one that replaced an
 * approved 409A adoption, and options struck at the superseded FMV
 * (`routes/grants.ts` snapshots `fmv_conclusion`) go on citing a board approval
 * the spine no longer records happening.
 *
 * Recorded rather than refused, which is the distinction R288's comment draws:
 * an addition that withdrew an approval nobody asked to withdraw is a refusal,
 * and an operator generating a new document has asked for exactly this. So the
 * prior status is read under the row lock the upsert takes anyway, and the
 * discarded sign-off ids come back from the DELETE that discards them — the
 * `board_member_added` and `board_signoff_recorded` rows naming those same ids
 * are still on the spine, so the trail joins without a second copy of anyone's
 * address.
 */
export async function upsertResolution(
  pool: pg.Pool,
  input: {
    valuationId: string;
    valuationDate: string;
    fmvConclusion: number;
    currency: string;
    methodologySummary: string;
    appraiserQualifications: string;
    bodyHtml: string;
    createdBy: string;
  },
  actor: EventActor,
): Promise<BoardResolutionRow> {
  return withTransaction(pool, async (client) => {
    // Under the same row lock the upsert below takes, so the status this reads
    // is the one it is about to overwrite. No row on a first generation, which
    // is the case with nothing to withdraw.
    const { rows: prior } = await client.query<{ status: BoardResolutionStatus }>(
      'SELECT status FROM board_resolutions WHERE valuation_id = $1 FOR UPDATE',
      [input.valuationId],
    );
    const previous = prior[0]?.status ?? null;
    const { rows } = await client.query<BoardResolutionRow>(
      `INSERT INTO board_resolutions
         (id, valuation_id, valuation_date, fmv_conclusion, currency,
          methodology_summary, appraiser_qualifications, body_html, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (valuation_id) DO UPDATE SET
         valuation_date          = EXCLUDED.valuation_date,
         fmv_conclusion          = EXCLUDED.fmv_conclusion,
         currency                = EXCLUDED.currency,
         methodology_summary     = EXCLUDED.methodology_summary,
         appraiser_qualifications = EXCLUDED.appraiser_qualifications,
         body_html               = EXCLUDED.body_html,
         status                  = 'pending',
         approved_at             = NULL,
         updated_at              = now()
       RETURNING *`,
      [
        newUlid(),
        input.valuationId,
        input.valuationDate,
        input.fmvConclusion,
        input.currency,
        input.methodologySummary,
        input.appraiserQualifications,
        input.bodyHtml,
        input.createdBy,
      ],
    );
    // Regenerating invalidates prior sign-offs so nobody's signature carries
    // over to a materially different document. Returned, because which ones
    // went is the fact the trail below has to carry: the rows are gone after
    // this statement and a count alone cannot say whose signature was in them.
    const { rows: discarded } = await client.query<{ id: string }>(
      'DELETE FROM board_signoffs WHERE resolution_id = $1 RETURNING id',
      [rows[0]!.id],
    );
    const discardedIds = discarded.map((row) => row.id);
    // Ordered before the generation event so the spine reads in the order the
    // two things happened: the board's adoption was withdrawn, then a new
    // document took its place.
    if (previous === 'approved' || previous === 'rejected') {
      await recordEvent(client, {
        valuationId: input.valuationId,
        type: BOARD_EVENT_TYPES.resolutionReopened,
        actor,
        // Same `from` the other door writes — 'approved' and 'rejected' are the
        // only two values it can take and it means the same thing in both.
        payload: {
          resolution_id: rows[0]!.id,
          from: previous,
          discarded_signoffs: discardedIds,
        },
      });
    }
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: BOARD_EVENT_TYPES.resolutionGenerated,
      actor,
      payload: {
        resolution_id: rows[0]!.id,
        fmv_conclusion: input.fmvConclusion,
        // Non-empty on every regeneration, decided or not: a resolution still
        // collecting signatures loses them here too, and the operator who
        // pressed Generate is not the person whose signature was thrown away.
        discarded_signoffs: discardedIds,
      },
    });
    return resolution(rows[0]!);
  });
}

export async function findResolutionByValuation(
  pool: pg.Pool,
  valuationId: string,
): Promise<BoardResolutionRow | null> {
  const { rows } = await pool.query<BoardResolutionRow>(
    'SELECT * FROM board_resolutions WHERE valuation_id = $1',
    [valuationId],
  );
  return rows[0] ? resolution(rows[0]) : null;
}

/**
 * Batch form of {@link findResolutionByValuation}, keyed by valuation id — one
 * round trip for a list of valuations rather than one per valuation.
 */
export async function findResolutionsByValuationIds(
  pool: pg.Pool,
  valuationIds: string[],
): Promise<Map<string, BoardResolutionRow>> {
  if (valuationIds.length === 0) return new Map();
  const { rows } = await pool.query<BoardResolutionRow>(
    'SELECT * FROM board_resolutions WHERE valuation_id = ANY($1)',
    [[...new Set(valuationIds)]],
  );
  return new Map(rows.map((row) => [row.valuation_id, resolution(row)]));
}

/**
 * Put a director on the sign-off list.
 *
 * THE `FOR UPDATE` IS THE POINT, and it is the same argument `recordSignoff`
 * makes below. Adding a member means the board is no longer fully signed, so
 * this ends by recomputing the aggregate — and on an approved resolution that
 * recomputation is an *un-approval*: `status` goes back to 'pending' and
 * `approved_at` is cleared. The route refuses it for exactly that reason ("The
 * resolution is already approved") — but that refusal is a read on the pool,
 * and the fact it reads is one the last outstanding signature changes.
 *
 * (`refreshResolutionStatusTx` records that direction as
 * `board_resolution_reopened` for the door — `deleteBoardMember` — that is
 * allowed through it. This one is not: an addition that quietly withdrew an
 * approval nobody asked to withdraw is a refusal, not an event.)
 *
 * Which is not an exotic interleaving. The window is "ops adds a director while
 * the last director is signing", and it is opened by the ordinary way this
 * feature is used: the members screen is what ops has open while the links are
 * out. The read said 'pending', the final `POST /board/sign` committed, and
 * this transaction then took an approved resolution back to pending with an
 * `approved_at` that had already been stamped — on the governance record
 * adopting a 409A FMV, which is the one document whose approval has to be able
 * to say when it happened.
 *
 * Asked again here, under the row lock `refreshResolutionStatusTx` takes
 * anyway, the question is settled against a row nothing can move until this
 * transaction ends: either the signature commits first and this is refused, or
 * this commits first and the signature's own recomputation sees the new pending
 * member and does not approve. The pool-side check in the route stays — it is
 * what answers the ordinary, uncontended case before a transaction is opened.
 */
export async function addBoardMember(
  pool: pg.Pool,
  input: {
    resolutionId: string;
    valuationId: string;
    name: string;
    email: string;
    title?: string | null;
    tokenHash: string;
    /**
     * The sign-off list's ceiling, re-asked under the row lock below.
     *
     * `MAX_BOARD_MEMBERS` is not a tidiness rule: {@link listBoardMembers} is
     * deliberately uncapped — a member hidden past a page boundary reads as a
     * member whose signature is not required — so this number is the *only*
     * bound on that read. The route checks it on the pool, one statement before
     * the insert, which is the same read-then-write the `approved` check above
     * was moved in here to close: N requests arriving together all see the same
     * count below the ceiling and all insert, so the list ends up at
     * `MAX_BOARD_MEMBERS + N`. The route's own comment names the case — "a loop
     * against this endpoint would be" near the cap — and a loop that does not
     * wait for each answer defeats the check entirely.
     *
     * Optional so the ceiling stays a route-layer decision; when it is given,
     * the count is taken inside the transaction that holds the resolution
     * still, which is what makes the refusal hold under concurrency.
     */
    maxMembers?: number;
  },
  actor: EventActor,
): Promise<BoardSignoffRow> {
  return withTransaction(pool, async (client) => {
    const { rows: locked } = await client.query<{ status: BoardResolutionStatus }>(
      'SELECT status FROM board_resolutions WHERE id = $1 FOR UPDATE',
      [input.resolutionId],
    );
    // No row is unreachable through the route, which loads the resolution to
    // get here, and nothing deletes one — `upsertResolution` replaces it in
    // place. Left to the INSERT's foreign key rather than given a message of
    // its own, so this reads as the one refusal it is here to make.
    if (locked[0]?.status === 'approved') {
      throw problems.conflict('The resolution is already approved');
    }
    // Counted here rather than only on the pool — see `maxMembers`. The lock
    // above is already held for the whole transaction, so this costs one extra
    // statement and no extra contention: concurrent adds to one resolution were
    // already serialised, and only the count was being taken outside that.
    // Same sentence as the route's, because it is the same refusal.
    if (input.maxMembers !== undefined) {
      const { rows: tally } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM board_signoffs WHERE resolution_id = $1',
        [input.resolutionId],
      );
      if (Number(tally[0]?.count ?? 0) >= input.maxMembers) {
        throw problems.conflict(
          `A resolution takes at most ${input.maxMembers} board members — remove one first`,
        );
      }
    }
    const { rows } = await client.query<BoardSignoffRow>(
      `INSERT INTO board_signoffs
         (id, resolution_id, valuation_id, member_name, member_email, member_title,
          token_sha256, token_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        newUlid(),
        input.resolutionId,
        input.valuationId,
        input.name,
        input.email.toLowerCase(),
        input.title ?? null,
        input.tokenHash,
        boardSignoffTokenExpiry(),
      ],
    );
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: BOARD_EVENT_TYPES.memberAdded,
      actor,
      // The row, not the address. `board_signoffs` is declared in the PII
      // inventory as cascading from the engagement, and that disposition is
      // true of the row and false of a copy made here: `valuation_events`
      // carries 0001's `valuation_events_immutable` trigger, so a director's
      // address written into a payload cannot afterwards be edited or removed
      // by anything at all. `signoff_id` names the row while it exists, and
      // `board_member_removed` below is where the address is kept for the one
      // case in which it does not — so an auditor can still resolve this id,
      // and only one copy of the address is made instead of three.
      payload: { signoff_id: rows[0]!.id },
    });
    // Adding a member means the board is no longer fully signed.
    await refreshResolutionStatusTx(client, input.resolutionId, input.valuationId, actor);
    return rows[0]!;
  });
}

/**
 * How many members are on this resolution's sign-off list.
 *
 * Counted in SQL so the write cap below can be enforced without reading the
 * list. {@link listBoardMembers} is deliberately uncapped — it is the list of
 * people whose signature the resolution is waiting on, and a member hidden
 * past a page boundary reads as a member who is not required — so the bound
 * has to sit at the write end instead. `MAX_BOARD_MEMBERS` in
 * `routes/boardApproval.ts` is that bound.
 */
export async function countBoardMembers(pool: pg.Pool, resolutionId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM board_signoffs WHERE resolution_id = $1',
    [resolutionId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function listBoardMembers(pool: pg.Pool, resolutionId: string): Promise<BoardSignoffRow[]> {
  const { rows } = await pool.query<BoardSignoffRow>(
    'SELECT * FROM board_signoffs WHERE resolution_id = $1 ORDER BY created_at',
    [resolutionId],
  );
  return rows;
}

export async function findSignoffById(pool: pg.Pool, id: string): Promise<BoardSignoffRow | null> {
  const { rows } = await pool.query<BoardSignoffRow>('SELECT * FROM board_signoffs WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Resolve a raw signing token to its member — expiry enforced in the predicate.
 *
 * In SQL rather than in the routes because both public endpoints resolve
 * through here and a deadline checked by each caller is a deadline one of them
 * eventually forgets. `now()` is the database's clock, which is also the one
 * that stamped the column.
 */
export async function findSignoffByTokenHash(
  pool: pg.Pool,
  tokenHash: string,
): Promise<BoardSignoffRow | null> {
  const { rows } = await pool.query<BoardSignoffRow>(
    'SELECT * FROM board_signoffs WHERE token_sha256 = $1 AND token_expires_at > now()',
    [tokenHash],
  );
  return rows[0] ?? null;
}

/**
 * Re-mint the emailed token: a fresh secret and a fresh deadline, together.
 *
 * The two have to move as one. Rotating the hash while leaving the old deadline
 * would hand a member a link that dies before the window they were promised,
 * and pushing the deadline out without rotating would extend the life of a
 * token that has already been in an inbox.
 */
export async function remintSignoffToken(pool: pg.Pool, signoffId: string, tokenHash: string): Promise<void> {
  await pool.query('UPDATE board_signoffs SET token_sha256 = $2, token_expires_at = $3 WHERE id = $1', [
    signoffId,
    tokenHash,
    boardSignoffTokenExpiry(),
  ]);
}

export async function markMemberSent(pool: pg.Pool, signoffId: string): Promise<void> {
  await pool.query('UPDATE board_signoffs SET sent_at = now() WHERE id = $1', [signoffId]);
}

export async function deleteBoardMember(
  pool: pg.Pool,
  signoff: BoardSignoffRow,
  actor: EventActor,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Once per removal. The route reaches this through `findSignoffById`, a
    // statement earlier and on another connection, so two DELETEs off one read
    // is a double-clicked button — and the event below is the one place on this
    // spine that keeps a director's address (`piiInventory.test.ts` declares it
    // as such, because the row it names is deleted in the same transaction). A
    // second press wrote a second copy of that address for a removal that
    // happened once, and told the trail the board lost a member it no longer
    // had. Same reading as `deleteDocument` and `deleteRound`: the loser writes
    // nothing, including the status refresh below, which the winner has already
    // done under the same row lock.
    const { rowCount } = await client.query('DELETE FROM board_signoffs WHERE id = $1', [signoff.id]);
    if ((rowCount ?? 0) === 0) return;
    await recordEvent(client, {
      valuationId: signoff.valuation_id,
      type: BOARD_EVENT_TYPES.memberRemoved,
      actor,
      // The one place on this spine that keeps a director's address, and the
      // reason is that the row it names is being deleted in the same
      // transaction: after this statement `signoff_id` resolves to nothing,
      // and an event saying only that some member was removed from the board
      // resolution adopting a 409A FMV does not answer the question the trail
      // exists for. Declared as such in `piiInventory.test.ts` — the copy
      // outlives every mechanism this schema has for removing it, which is a
      // decision rather than an oversight.
      payload: { signoff_id: signoff.id, member_email: signoff.member_email },
    });
    await refreshResolutionStatusTx(client, signoff.resolution_id, signoff.valuation_id, actor);
  });
}

/**
 * Records a board member's decision (signed / rejected) against a token, then
 * rolls the aggregate resolution status forward. Returns the refreshed
 * resolution so the caller can react to a newly-reached approval, or `null`
 * when the member had already decided and this call changed nothing.
 *
 * The `status = 'pending'` predicate is what makes a decision final. The route
 * checks `member.status !== 'pending'` before calling, but that read happens in
 * its own statement, so two requests carrying the same token can both pass it
 * and both arrive here — and an unconditional UPDATE let the second overwrite
 * the first. That is not a harmless duplicate: it is how a signature already
 * recorded (and possibly already counted toward an approved resolution, with an
 * `approved_at` stamped and an approval event emitted) gets rewritten to
 * 'rejected' afterwards, leaving two contradictory `signoff_recorded` events
 * against one member and an audit trail that cannot say which decision stood.
 * A board resolution adopting a 409A FMV is precisely the document whose
 * sign-offs have to be write-once.
 *
 * Putting the predicate in the UPDATE closes the window rather than narrowing
 * it: the second transaction blocks on the first's row lock, then re-evaluates
 * the condition against the committed row and matches nothing.
 */
export async function recordSignoff(
  pool: pg.Pool,
  signoff: BoardSignoffRow,
  decision: { status: 'signed' | 'rejected'; comment?: string | null },
): Promise<{ signoff: BoardSignoffRow; resolution: BoardResolutionRow } | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<BoardSignoffRow>(
      `UPDATE board_signoffs
         SET status = $2, comment = $3, signed_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [signoff.id, decision.status, decision.comment ?? null],
    );
    // Lost the race (or a replayed request). Nothing has been written, so there
    // is no event to record and no status to roll forward.
    if (rows.length === 0) return null;
    await recordEvent(client, {
      valuationId: signoff.valuation_id,
      type: BOARD_EVENT_TYPES.signoffRecorded,
      actor: { actorType: 'human', source: 'board-member' },
      payload: { signoff_id: signoff.id, decision: decision.status },
    });
    const resolution = await refreshResolutionStatusTx(client, signoff.resolution_id, signoff.valuation_id, {
      actorType: 'system',
      source: 'board',
    });
    return { signoff: rows[0]!, resolution };
  });
}

/**
 * Recomputes board_resolutions.status from its sign-offs inside an open
 * transaction, stamping approved_at exactly once when approval is first
 * reached, and emitting an event on every transition — including the way back
 * out of a decision, which for a while it made silently.
 */
async function refreshResolutionStatusTx(
  client: pg.PoolClient,
  resolutionId: string,
  valuationId: string,
  actor: EventActor,
): Promise<BoardResolutionRow> {
  const { rows: resRows } = await client.query<BoardResolutionRow>(
    'SELECT * FROM board_resolutions WHERE id = $1 FOR UPDATE',
    [resolutionId],
  );
  const current = resRows[0]!;
  const { rows: sigs } = await client.query<{ status: BoardSignoffStatus }>(
    'SELECT status FROM board_signoffs WHERE resolution_id = $1',
    [resolutionId],
  );
  const next = resolutionStatusFrom(sigs);
  if (next === current.status) return resolution(current);

  const approvedAt = next === 'approved' ? 'now()' : 'NULL';
  const { rows: updated } = await client.query<BoardResolutionRow>(
    `UPDATE board_resolutions SET status = $2, approved_at = ${approvedAt}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [resolutionId, next],
  );
  if (next === 'approved') {
    await recordEvent(client, {
      valuationId,
      type: BOARD_EVENT_TYPES.resolutionApproved,
      actor,
      payload: { resolution_id: resolutionId },
    });
  } else if (next === 'rejected') {
    await recordEvent(client, {
      valuationId,
      type: BOARD_EVENT_TYPES.resolutionRejected,
      actor,
      payload: { resolution_id: resolutionId },
    });
  } else {
    // The third direction, which had no event at all. `next` is 'pending' and
    // `current.status` is not — the recomputation has just taken a decided
    // resolution back to undecided and cleared an `approved_at` that had
    // already been stamped.
    //
    // R288 closed the way `addBoardMember` reached here, by refusing under this
    // same row lock. `deleteBoardMember` reaches it too and cannot be refused
    // the same way: removing a director is a thing ops is allowed to do, and
    // removing the sole director of an approved resolution — or the rejecting
    // director of a rejected one — is exactly the undoing of a decision. The
    // `board_member_removed` row beside this one says a member went; it does
    // not say the board's adoption of a 409A FMV went with them, and the trail
    // has to be readable without the reader re-deriving the aggregate from the
    // sign-off list as it stood at that instant.
    //
    // `from` rather than a type per direction: 'approved' and 'rejected' are
    // the only two values it can take and the event means the same thing in
    // both.
    await recordEvent(client, {
      valuationId,
      type: BOARD_EVENT_TYPES.resolutionReopened,
      actor,
      payload: { resolution_id: resolutionId, from: current.status },
    });
  }
  return resolution(updated[0]!);
}
