import type pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { newUlid } from '@n409/shared';

/**
 * Firm-branded client intake links (migration 0092).
 *
 * Same token discipline as auditor access: a 256-bit opaque token, only its
 * SHA-256 stored, shown once on creation. The difference is what the token
 * grants — this one *writes*, so every mutation re-resolves the token rather
 * than trusting an id the caller supplies.
 */

export interface ClientIntakeLinkRow {
  id: string;
  partner_id: string;
  token_hash: string;
  client_name: string | null;
  client_email: string | null;
  label: string | null;
  expires_at: Date;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  last_accessed_at: Date | null;
  access_count: number;
  answers: Record<string, unknown>;
  submitted_at: Date | null;
  valuation_id: string | null;
}

export type PublicClientIntakeLink = Omit<ClientIntakeLinkRow, 'token_hash' | 'answers'>;

/**
 * The firm-facing shape. Drops the hash for the obvious reason, and the answers
 * because the list endpoint is a roster — a firm reading one client's responses
 * asks for that link, rather than receiving every prospect's answers on a page
 * load it did not ask them for.
 */
export function toPublicLink(row: ClientIntakeLinkRow): PublicClientIntakeLink {
  const { token_hash: _t, answers: _a, ...rest } = row;
  return rest;
}

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export async function createIntakeLink(
  pool: pg.Pool,
  input: {
    partnerId: string;
    clientName?: string | null;
    clientEmail?: string | null;
    label?: string | null;
    expiresAt: Date;
    createdBy: string;
  },
): Promise<{ link: ClientIntakeLinkRow; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<ClientIntakeLinkRow>(
    `INSERT INTO client_intake_links
       (id, partner_id, token_hash, client_name, client_email, label, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      newUlid(),
      input.partnerId,
      hashToken(token),
      input.clientName ?? null,
      input.clientEmail ?? null,
      input.label ?? null,
      input.expiresAt,
      input.createdBy,
    ],
  );
  return { link: rows[0]!, token };
}

export async function listIntakeLinks(pool: pg.Pool, partnerId: string): Promise<ClientIntakeLinkRow[]> {
  const { rows } = await pool.query<ClientIntakeLinkRow>(
    'SELECT * FROM client_intake_links WHERE partner_id = $1 ORDER BY created_at DESC',
    [partnerId],
  );
  return rows;
}

/**
 * A single link, scoped to the firm. The partner_id is part of the predicate
 * rather than checked afterwards, so a firm naming another firm's link id gets
 * the same "not found" as one naming an id that never existed.
 */
export async function findIntakeLink(
  pool: pg.Pool,
  partnerId: string,
  id: string,
): Promise<ClientIntakeLinkRow | null> {
  const { rows } = await pool.query<ClientIntakeLinkRow>(
    'SELECT * FROM client_intake_links WHERE id = $1 AND partner_id = $2',
    [id, partnerId],
  );
  return rows[0] ?? null;
}

export async function revokeIntakeLink(pool: pg.Pool, partnerId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE client_intake_links SET revoked_at = now()
      WHERE id = $1 AND partner_id = $2 AND revoked_at IS NULL`,
    [id, partnerId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Resolve a raw token to a live link, recording the visit.
 *
 * A submitted link still resolves: the client may reopen it to review what they
 * sent, and the read path needs the row to say so. What a submitted link stops
 * allowing is further writes — enforced by the save/submit calls below, not by
 * hiding the row.
 */
export async function redeemIntakeToken(
  pool: pg.Pool,
  rawToken: string,
): Promise<ClientIntakeLinkRow | null> {
  const { rows } = await pool.query<ClientIntakeLinkRow>(
    `UPDATE client_intake_links
        SET last_accessed_at = now(), access_count = access_count + 1
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING *`,
    [hashToken(rawToken)],
  );
  return rows[0] ?? null;
}

/**
 * Merge answers into a live, unsubmitted link.
 *
 * The merge happens in SQL (`answers || $2`) rather than read-modify-write in
 * the route: two tabs of the same form saving different sections would
 * otherwise have the slower one overwrite the faster one's section with the
 * stale copy it read before either saved.
 *
 * A save also counts as an access. Typing is stronger evidence the client is
 * engaged than opening the page is, and the firm console derives "in progress"
 * from `last_accessed_at` — without this a client halfway through the form
 * still reads as never having opened the link.
 */
export async function saveIntakeAnswers(
  pool: pg.Pool,
  rawToken: string,
  answers: Record<string, unknown>,
): Promise<ClientIntakeLinkRow | null> {
  const { rows } = await pool.query<ClientIntakeLinkRow>(
    `UPDATE client_intake_links
        SET answers = answers || $2::jsonb, last_accessed_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND submitted_at IS NULL
      RETURNING *`,
    [hashToken(rawToken), JSON.stringify(answers)],
  );
  return rows[0] ?? null;
}

/** Stamp the submission. Null when the link is dead or already submitted. */
export async function submitIntakeLink(pool: pg.Pool, rawToken: string): Promise<ClientIntakeLinkRow | null> {
  const { rows } = await pool.query<ClientIntakeLinkRow>(
    `UPDATE client_intake_links
        SET submitted_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND submitted_at IS NULL
      RETURNING *`,
    [hashToken(rawToken)],
  );
  return rows[0] ?? null;
}

/** Record the engagement a submission was converted into. */
export async function attachIntakeValuation(
  pool: pg.Pool,
  partnerId: string,
  id: string,
  valuationId: string,
): Promise<ClientIntakeLinkRow | null> {
  const { rows } = await pool.query<ClientIntakeLinkRow>(
    `UPDATE client_intake_links SET valuation_id = $3
      WHERE id = $1 AND partner_id = $2 AND valuation_id IS NULL
      RETURNING *`,
    [id, partnerId, valuationId],
  );
  return rows[0] ?? null;
}
