import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import {
  BOARD_EVENT_TYPES,
  boardSignoffTokenExpiry,
  resolutionStatusFrom,
  type BoardResolutionStatus,
  type BoardSignoffStatus,
} from '../domain/boardResolution.js';

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

/** Insert-or-replace the resolution: regenerating supersedes the body + resets status. */
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
    // over to a materially different document.
    await client.query('DELETE FROM board_signoffs WHERE resolution_id = $1', [rows[0]!.id]);
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: BOARD_EVENT_TYPES.resolutionGenerated,
      actor,
      payload: { resolution_id: rows[0]!.id, fmv_conclusion: input.fmvConclusion },
    });
    return rows[0]!;
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
  return rows[0] ?? null;
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
  return new Map(rows.map((row) => [row.valuation_id, row]));
}

export async function addBoardMember(
  pool: pg.Pool,
  input: {
    resolutionId: string;
    valuationId: string;
    name: string;
    email: string;
    title?: string | null;
    tokenHash: string;
  },
  actor: EventActor,
): Promise<BoardSignoffRow> {
  return withTransaction(pool, async (client) => {
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
      payload: { signoff_id: rows[0]!.id, member_email: input.email.toLowerCase() },
    });
    // Adding a member means the board is no longer fully signed.
    await refreshResolutionStatusTx(client, input.resolutionId, input.valuationId, actor);
    return rows[0]!;
  });
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
    await client.query('DELETE FROM board_signoffs WHERE id = $1', [signoff.id]);
    await recordEvent(client, {
      valuationId: signoff.valuation_id,
      type: BOARD_EVENT_TYPES.memberRemoved,
      actor,
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
      payload: { signoff_id: signoff.id, member_email: signoff.member_email, decision: decision.status },
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
 * reached, and emitting an approval/rejection event on transitions.
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
  if (next === current.status) return current;

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
  }
  return updated[0]!;
}
