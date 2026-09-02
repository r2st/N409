import type pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';

/**
 * Shareable, expiring auditor access links (feature 8). The raw token is shown
 * once on creation; only its SHA-256 hash is stored. The token grants a
 * read-only, single-valuation view via the public auditor portal.
 */

export interface AuditorAccessRow {
  id: string;
  valuation_id: string;
  token_hash: string;
  label: string | null;
  expires_at: Date;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  last_accessed_at: Date | null;
  access_count: number;
}

export type PublicAuditorAccess = Omit<AuditorAccessRow, 'token_hash'>;

export function toPublic(row: AuditorAccessRow): PublicAuditorAccess {
  const { token_hash: _t, ...rest } = row;
  return rest;
}

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

/**
 * Mint a link, and say on the engagement's spine that one was minted (R392,
 * methodology M11).
 *
 * This is the only door on this platform that hands a *reader with no account*
 * the deliverable, the concluded value, the assumptions and the QA record —
 * for as long as `expires_at` says. The board's external signing link, which
 * grants strictly less, has written `board_member_added` and
 * `board_member_removed` since it existed; the auditor's reply writes
 * `auditor_note_received`. Only the grant itself was silent, so the trail could
 * show a stranger writing on the engagement and hold no row anywhere saying who
 * let them in.
 *
 * `auditor_access` rows do persist — nothing deletes a revoked or expired grant,
 * and the list docstring below calls that "the audit trail". It is a register of
 * outstanding links and not a record of what happened to them: it is not read by
 * the change log, the evidence bundle or the client portal, its ordering is its
 * own, and `revoke` writes a timestamp with no actor beside it. R388 made the
 * same distinction for `valuation_signatures`, which also persists.
 *
 * In the transaction that writes the row, so a grant without its event cannot
 * exist. The payload carries the id, the label and the expiry — never the token
 * or its hash: the raw secret is returned once to the caller and the hash is the
 * credential's stored form, and neither belongs in a payload six surfaces read.
 */
export async function createAuditorAccess(
  pool: pg.Pool,
  input: { valuationId: string; label?: string | null; expiresAt: Date; createdBy: string },
  actor: EventActor,
): Promise<{ access: AuditorAccessRow; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const access = await withTransaction(pool, async (client) => {
    const { rows } = await client.query<AuditorAccessRow>(
      `INSERT INTO auditor_access (id, valuation_id, token_hash, label, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [newUlid(), input.valuationId, hashToken(token), input.label ?? null, input.expiresAt, input.createdBy],
    );
    const row = rows[0]!;
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: 'auditor_access_granted',
      actor,
      payload: {
        access_id: row.id,
        label: row.label,
        expires_at: row.expires_at.toISOString(),
      },
    });
    return row;
  });
  return { access, token };
}

/**
 * Ceiling on one page of an engagement's auditor grants.
 *
 * Revoked and expired grants stay for the audit trail, so this list only ever
 * grows — every audit season adds rows and nothing removes them. Newest first,
 * which is also the live end.
 */
export const AUDITOR_ACCESS_PAGE_LIMIT = 200;

export async function listAuditorAccess(
  pool: pg.Pool,
  valuationId: string,
): Promise<{ grants: AuditorAccessRow[]; truncated: boolean }> {
  const { rows } = await pool.query<AuditorAccessRow>(
    'SELECT * FROM auditor_access WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT $2',
    [valuationId, AUDITOR_ACCESS_PAGE_LIMIT + 1],
  );
  return {
    grants: rows.slice(0, AUDITOR_ACCESS_PAGE_LIMIT),
    truncated: rows.length > AUDITOR_ACCESS_PAGE_LIMIT,
  };
}

/**
 * Take a link back, and name whose it was.
 *
 * `RETURNING *` for the reason R388's `deleteSignature` takes it: after this
 * statement the row is revoked and the only thing that can say which auditor
 * lost their access is the row as it was. `revoked_at` records the moment and
 * has never had an actor column beside it, so until this event "who withdrew
 * this auditor's link" was a question the database could not answer at all.
 *
 * Still reports whether it landed. The `revoked_at IS NULL` predicate makes a
 * second revoke a no-op rather than an error, and the route answers 404 on it —
 * so the event is written only on the pass that actually changed the grant, and
 * a double-clicked button does not put two withdrawals on the trail.
 */
export async function revokeAuditorAccess(
  pool: pg.Pool,
  valuationId: string,
  accessId: string,
  actor: EventActor,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<AuditorAccessRow>(
      `UPDATE auditor_access SET revoked_at = now()
        WHERE id = $1 AND valuation_id = $2 AND revoked_at IS NULL
        RETURNING *`,
      [accessId, valuationId],
    );
    const row = rows[0];
    if (!row) return false;
    await recordEvent(client, {
      valuationId,
      type: 'auditor_access_revoked',
      actor,
      payload: {
        access_id: row.id,
        label: row.label,
        expires_at: row.expires_at.toISOString(),
      },
    });
    return true;
  });
}

/**
 * Resolve a raw token to a live (unrevoked, unexpired) access row, recording
 * the access. Returns null for an invalid / revoked / expired token.
 */
/**
 * The same validity test as {@link redeemAuditorToken}, without counting it.
 *
 * `access_count` and `last_accessed_at` answer "how often has this auditor
 * opened the link", and ops read both off the access list to decide whether a
 * link is still in use. A write from the portal — the auditor submitting a note
 * — is not an opening, and redeeming for it would inflate the one figure the
 * list exists to report, on the auditors who engage with the work the most.
 */
export async function verifyAuditorToken(pool: pg.Pool, rawToken: string): Promise<AuditorAccessRow | null> {
  const { rows } = await pool.query<AuditorAccessRow>(
    `SELECT * FROM auditor_access
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(rawToken)],
  );
  return rows[0] ?? null;
}

export async function redeemAuditorToken(pool: pg.Pool, rawToken: string): Promise<AuditorAccessRow | null> {
  const { rows } = await pool.query<AuditorAccessRow>(
    `UPDATE auditor_access
        SET last_accessed_at = now(), access_count = access_count + 1
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING *`,
    [hashToken(rawToken)],
  );
  return rows[0] ?? null;
}
