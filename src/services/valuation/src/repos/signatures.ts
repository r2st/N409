import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction, type Queryable } from '../db/pool.js';
import { lockPublishGate } from './publishLock.js';
import { recordEvent, type EventActor } from '../events/record.js';

export type SignatureRole = 'main' | 'second';

export interface SignatureRow {
  id: string;
  valuation_id: string;
  role: SignatureRole;
  signer_user_id: string;
  signer_name: string;
  signer_title: string | null;
  signature_text: string;
  signed_at: Date;
}

/**
 * Refuses the change if the valuation is published, under the gate lock.
 *
 * The routes check this too, against the row they loaded — which is the check
 * that produces the message an operator sees, and the one that runs when the
 * answer is not in dispute. This is the same question asked where it is
 * decidable: after {@link lockPublishGate}, holding the state still against a
 * concurrent publish, so "not published" cannot stop being true between the
 * check and the write it licenses.
 *
 * Without it the lock would only make the two writers take turns, and taking
 * turns is not the property wanted: a signature deleted immediately *after* a
 * publish commits is as wrong as one deleted during it. Both orderings have to
 * end with a published valuation still holding its signature.
 */
async function assertNotPublished(
  client: pg.PoolClient,
  valuationId: string,
  message: string,
): Promise<void> {
  await lockPublishGate(client, valuationId);
  const { rows } = await client.query<{ state: string }>('SELECT state FROM valuations WHERE id = $1', [
    valuationId,
  ]);
  // No row is not this function's 404 to raise: the routes load the valuation
  // before calling, so reaching here without one means it was deleted mid-flight
  // and the write below will fail its foreign key anyway.
  if (rows[0]?.state === 'published') throw problems.conflict(message);
}

/**
 * Insert-or-replace: re-signing after changes supersedes the previous row.
 *
 * The replacement is the reason this records (R388, M3). One row per role is
 * the right shape for "who is certifying this engagement now", and it is the
 * whole of what this table can say: the `ON CONFLICT DO UPDATE` below writes
 * the new signatory over the old one, and the old one is then nowhere. A file
 * signed by one reviewer, re-signed by another and published carried no record
 * that the first certification was ever given — see `signature_recorded` in
 * `domain/auditTrail.ts`. The event is in the same transaction as the write,
 * per `events/record.ts`, and names the superseded signatory when there was
 * one, because that is the fact the row can no longer hold.
 */
export async function upsertSignature(
  pool: pg.Pool,
  input: {
    valuationId: string;
    role: SignatureRole;
    signerUserId: string;
    signerName: string;
    signerTitle?: string | null;
    signatureText: string;
  },
  actor: EventActor,
): Promise<SignatureRow> {
  return withTransaction(pool, async (client) => {
    await assertNotPublished(client, input.valuationId, 'Cannot re-sign a published valuation');
    // Read before the write, for the reason `deleteOrganization` reads before
    // its detach: the `RETURNING` hands back the row as it now is, and the
    // superseded signatory is exactly what this statement is about to
    // overwrite. Under the gate lock already held, so nothing lands between.
    const { rows: prior } = await client.query<SignatureRow>(
      'SELECT * FROM valuation_signatures WHERE valuation_id = $1 AND role = $2',
      [input.valuationId, input.role],
    );
    const superseded = prior[0];
    const signature = await upsertSignatureIn(client, input);
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: 'signature_recorded',
      actor,
      payload: {
        role: input.role,
        signer_name: input.signerName,
        signer_title: input.signerTitle ?? null,
        ...(superseded
          ? {
              replaced: {
                signer_user_id: superseded.signer_user_id,
                signer_name: superseded.signer_name,
                signed_at: superseded.signed_at,
              },
            }
          : {}),
      },
    });
    return signature;
  });
}

async function upsertSignatureIn(
  client: pg.PoolClient,
  input: {
    valuationId: string;
    role: SignatureRole;
    signerUserId: string;
    signerName: string;
    signerTitle?: string | null;
    signatureText: string;
  },
): Promise<SignatureRow> {
  const { rows } = await client.query<SignatureRow>(
    `INSERT INTO valuation_signatures
       (id, valuation_id, role, signer_user_id, signer_name, signer_title, signature_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (valuation_id, role) DO UPDATE SET
       signer_user_id = EXCLUDED.signer_user_id,
       signer_name    = EXCLUDED.signer_name,
       signer_title   = EXCLUDED.signer_title,
       signature_text = EXCLUDED.signature_text,
       signed_at      = now()
     RETURNING *`,
    [
      newUlid(),
      input.valuationId,
      input.role,
      input.signerUserId,
      input.signerName,
      input.signerTitle ?? null,
      input.signatureText,
    ],
  );
  return rows[0]!;
}

export async function listSignatures(pool: pg.Pool, valuationId: string): Promise<SignatureRow[]> {
  const { rows } = await pool.query<SignatureRow>(
    'SELECT * FROM valuation_signatures WHERE valuation_id = $1 ORDER BY role',
    [valuationId],
  );
  return rows;
}

/**
 * Withdraw a signature.
 *
 * `RETURNING *` rather than a row count, because the event has to say whose
 * attestation was withdrawn and when it had been given — after this statement
 * the row is gone and nothing else on the platform holds it. A delete that
 * matched nothing writes nothing: the route answers 404 and no attestation
 * changed hands.
 */
export async function deleteSignature(
  pool: pg.Pool,
  valuationId: string,
  role: SignatureRole,
  actor: EventActor,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    await assertNotPublished(client, valuationId, 'Cannot remove signatures from a published valuation');
    const { rows } = await client.query<SignatureRow>(
      'DELETE FROM valuation_signatures WHERE valuation_id = $1 AND role = $2 RETURNING *',
      [valuationId, role],
    );
    const removed = rows[0];
    if (!removed) return false;
    await recordEvent(client, {
      valuationId,
      type: 'signature_removed',
      actor,
      payload: {
        role,
        signer_user_id: removed.signer_user_id,
        signer_name: removed.signer_name,
        signed_at: removed.signed_at,
      },
    });
    return true;
  });
}

/** When each role signed, `null` for a role with no row. */
export type SignedAtByRole = Record<SignatureRole, Date | null>;

/**
 * When each signatory signed, or null for one who has not.
 *
 * The instant rather than the fact, because the publish gate asks two questions
 * of a row and only one of them is answerable by its existence: whether the
 * engagement is signed at all, and whether it was signed against the body and
 * the conclusion it is about to publish. See `assertPublishGate`.
 *
 * Both roles in one read, and not only `main`, because the deliverable prints
 * both. `domain/reportSignatures.ts` resolves `{{signatures}}` into a
 * certification table with a "Date signed" column per signatory, so the
 * concurring reviewer's attestation is on the page under a date exactly as the
 * analyst's is — and a currency rule that reads one row cannot be about a page
 * that shows two.
 */
export async function signedAtByRole(db: Queryable, valuationId: string): Promise<SignedAtByRole> {
  const { rows } = await db.query<{ role: SignatureRole; signed_at: Date }>(
    'SELECT role, signed_at FROM valuation_signatures WHERE valuation_id = $1',
    [valuationId],
  );
  const signed: SignedAtByRole = { main: null, second: null };
  for (const row of rows) signed[row.role] = row.signed_at;
  return signed;
}

/** When the analyst signed, or null if nobody has. */
export async function mainSignedAt(db: Queryable, valuationId: string): Promise<Date | null> {
  return (await signedAtByRole(db, valuationId)).main;
}

/** Signature gate: publish requires a 'main' signature (remaining-gaps §3 #3). */
export async function hasMainSignature(db: Queryable, valuationId: string): Promise<boolean> {
  return (await mainSignedAt(db, valuationId)) !== null;
}
