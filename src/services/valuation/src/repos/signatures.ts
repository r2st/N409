import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction, type Queryable } from '../db/pool.js';
import { lockPublishGate } from './publishLock.js';

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
  const { rows } = await client.query<{ state: string }>(
    'SELECT state FROM valuations WHERE id = $1',
    [valuationId],
  );
  // No row is not this function's 404 to raise: the routes load the valuation
  // before calling, so reaching here without one means it was deleted mid-flight
  // and the write below will fail its foreign key anyway.
  if (rows[0]?.state === 'published') throw problems.conflict(message);
}

/** Insert-or-replace: re-signing after changes supersedes the previous row. */
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
): Promise<SignatureRow> {
  return withTransaction(pool, async (client) => {
    await assertNotPublished(client, input.valuationId, 'Cannot re-sign a published valuation');
    return upsertSignatureIn(client, input);
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

export async function deleteSignature(
  pool: pg.Pool,
  valuationId: string,
  role: SignatureRole,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    await assertNotPublished(
      client,
      valuationId,
      'Cannot remove signatures from a published valuation',
    );
    const { rowCount } = await client.query(
      'DELETE FROM valuation_signatures WHERE valuation_id = $1 AND role = $2',
      [valuationId, role],
    );
    return (rowCount ?? 0) > 0;
  });
}

/** Signature gate: publish requires a 'main' signature (remaining-gaps §3 #3). */
export async function hasMainSignature(db: Queryable, valuationId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM valuation_signatures WHERE valuation_id = $1 AND role = 'main'",
    [valuationId],
  );
  return rows.length > 0;
}
