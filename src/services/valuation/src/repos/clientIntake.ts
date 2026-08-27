import type pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { INTAKE_EVENT_TYPES } from '../domain/intake.js';
import { PIPELINE_EVENT_TYPES } from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { insertValuation, type CreateValuationInput, type ValuationRow } from './valuations.js';
import { PARAM_COLUMNS } from './params.js';

/** Columns `convertIntakeLink` may write. Kept as a set of plain strings
 * because these become raw SQL identifiers. */
const SEEDABLE_PARAM_COLUMNS: ReadonlySet<string> = new Set(PARAM_COLUMNS);

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
): Promise<{ link: ClientIntakeLinkRow; token: string } | null> {
  const token = randomBytes(32).toString('base64url');
  // The mint side of the same rule the redemption predicate enforces. A firm
  // the platform has withdrawn does not get to put a new branded form in front
  // of a prospect, and refusing here means the token never exists rather than
  // existing and never working. `SELECT ... WHERE` rather than a prior read so
  // the check and the insert are one statement.
  const { rows } = await pool.query<ClientIntakeLinkRow>(
    `INSERT INTO client_intake_links
       (id, partner_id, token_hash, client_name, client_email, label, expires_at, created_by)
     SELECT $1::ulid, $2::ulid, $3::text, $4::text, $5::text, $6::text, $7::timestamptz, $8::ulid
      WHERE EXISTS (SELECT 1 FROM partners p WHERE p.id = $2 AND p.archived_at IS NULL)
     RETURNING *`,
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
  if (!rows[0]) return null;
  return { link: rows[0], token };
}

/**
 * Ceiling on one page of a firm's intake links.
 *
 * One row per prospective client, kept after it is used or revoked so the
 * conversion is auditable — so the list grows with the firm's whole history of
 * asking, not with its current pipeline.
 */
export const INTAKE_LINK_PAGE_LIMIT = 200;

export async function listIntakeLinks(
  pool: pg.Pool,
  partnerId: string,
): Promise<{ links: ClientIntakeLinkRow[]; truncated: boolean }> {
  const { rows } = await pool.query<ClientIntakeLinkRow>(
    'SELECT * FROM client_intake_links WHERE partner_id = $1 ORDER BY created_at DESC LIMIT $2',
    [partnerId, INTAKE_LINK_PAGE_LIMIT + 1],
  );
  return {
    links: rows.slice(0, INTAKE_LINK_PAGE_LIMIT),
    truncated: rows.length > INTAKE_LINK_PAGE_LIMIT,
  };
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
 * What makes a token still worth honouring, in one place.
 *
 * The three public endpoints — open the form, save progress, submit — each
 * re-resolve the token rather than trusting an id, which is right, and each
 * spelled the liveness test out again, which is how they came to disagree with
 * the product. `revoked_at IS NULL AND expires_at > now()` asks whether the
 * *link* is alive and never whether the firm behind it still is.
 *
 * `partners.archived_at` is the platform's soft delete for a firm: an archived
 * partner takes no new user assignments, cannot have its branding edited, and
 * is gone from the branding list. Its outstanding intake links kept working.
 * That is a public, unauthenticated form, wearing the firm's name and colours
 * (`resolveBranding` on the partner's own row), collecting a prospect's cap
 * table and financials for a firm the platform has withdrawn — and then
 * offering them for conversion into a live engagement under it.
 *
 * A single fragment rather than three edits, for the reason the soft-delete
 * sweep keeps re-learning: a predicate copied into each caller is one that
 * eventually differs between them, and a form that opens but will not save is a
 * worse failure than either answer given consistently.
 */
const LIVE_LINK_SQL = `revoked_at IS NULL
      AND expires_at > now()
      AND EXISTS (
        SELECT 1 FROM partners p
         WHERE p.id = client_intake_links.partner_id AND p.archived_at IS NULL
      )`;

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
      WHERE token_hash = $1 AND ${LIVE_LINK_SQL}
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
      WHERE token_hash = $1 AND submitted_at IS NULL AND ${LIVE_LINK_SQL}
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
      WHERE token_hash = $1 AND submitted_at IS NULL AND ${LIVE_LINK_SQL}
      RETURNING *`,
    [hashToken(rawToken)],
  );
  return rows[0] ?? null;
}

/** Why a link cannot become an engagement, or `null` when it can. */
export type IntakeConversionRefusal = 'not_found' | 'not_submitted' | 'already_converted';

export interface IntakeConversion {
  link: ClientIntakeLinkRow;
  valuation: ValuationRow;
}

/**
 * Turn a submitted intake into the engagement it was collected for.
 *
 * Everything here is one transaction because the link's `valuation_id` is the
 * only thing that makes conversion once-only. Creating the valuation first and
 * claiming the link afterwards leaves a double-click owning two engagements for
 * one client, with the second one orphaned — so the row is locked before
 * anything is created, and the whole set (valuation, params row, birth event,
 * seeded questionnaire, claim) commits or none of it does.
 *
 * The answers are copied into `intake_questionnaires` rather than referenced:
 * from here on the analyst edits the engagement's questionnaire, and the intake
 * link stays the immutable record of what the prospect actually submitted.
 */
export async function convertIntakeLink(
  pool: pg.Pool,
  args: {
    partnerId: string;
    id: string;
    valuation: Omit<CreateValuationInput, 'companyName' | 'partnerId'> & { companyName: string };
    paramsPatch: Record<string, unknown>;
    actor: EventActor;
  },
): Promise<IntakeConversion | IntakeConversionRefusal> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<ClientIntakeLinkRow>(
      `SELECT l.* FROM client_intake_links l
        WHERE l.id = $1 AND l.partner_id = $2
          AND EXISTS (SELECT 1 FROM partners p WHERE p.id = l.partner_id AND p.archived_at IS NULL)
          FOR UPDATE OF l`,
      [args.id, args.partnerId],
    );
    // An archived firm reads as `not_found` rather than getting a refusal of
    // its own: conversion creates a *new* engagement under the partner, and a
    // withdrawn firm acquiring fresh work is the thing being prevented. The
    // link and its answers stay readable through the listing either way.
    const link = rows[0];
    if (!link) return 'not_found';
    if (!link.submitted_at) return 'not_submitted';
    if (link.valuation_id) return 'already_converted';

    const valuation = await insertValuation(
      client,
      { ...args.valuation, partnerId: args.partnerId },
      args.actor,
    );

    const answers = link.answers ?? {};
    await client.query(
      `INSERT INTO intake_questionnaires (id, valuation_id, answers, submitted_at)
       VALUES ($1, $2, $3, $4)`,
      [newUlid(), valuation.id, JSON.stringify(answers), link.submitted_at],
    );
    await recordEvent(client, {
      valuationId: valuation.id,
      type: INTAKE_EVENT_TYPES.submitted,
      actor: args.actor,
      payload: { source: 'client_intake_link', intake_link_id: link.id },
    });

    // The allow-list is re-applied here rather than trusted from the caller:
    // these keys become raw SQL identifiers, so an unexpected one must be
    // impossible, not merely unlikely. Same discipline as `updateOwnProfile`.
    const patchEntries = Object.entries(args.paramsPatch).filter(([key]) => SEEDABLE_PARAM_COLUMNS.has(key));
    if (patchEntries.length > 0) {
      const sets = patchEntries.map(([key], i) => `${key} = $${i + 1}`);
      await client.query(
        // `version = version + 1` on a row created four statements ago, which
        // no client can be holding: harmless here, and the point. The columns
        // this seeds are methodology columns, and a *locked* row's methodology
        // columns are exactly what the Params form asserts it has not missed
        // (migration 0158). Whether a given writer is safe to skip the bump is
        // a fact about its call site, not about its SQL, and call sites move.
        // Every UPDATE of this table moves the counter, so nobody has to check.
        `UPDATE valuation_params SET ${sets.join(', ')}, updated_at = now(), version = version + 1
          WHERE valuation_id = $${patchEntries.length + 1}`,
        [...patchEntries.map(([, value]) => value), valuation.id],
      );
      await recordEvent(client, {
        valuationId: valuation.id,
        type: PIPELINE_EVENT_TYPES.paramsUpdated,
        actor: args.actor,
        payload: { seeded_from_intake: Object.keys(args.paramsPatch) },
      });
    }

    const { rows: claimed } = await client.query<ClientIntakeLinkRow>(
      'UPDATE client_intake_links SET valuation_id = $2 WHERE id = $1 RETURNING *',
      [link.id, valuation.id],
    );
    return { link: claimed[0]!, valuation };
  });
}
