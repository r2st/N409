import type pg from 'pg';
import { newUlid } from '@n409/shared';

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
  const { rows } = await pool.query<SignatureRow>(
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
  const { rowCount } = await pool.query(
    'DELETE FROM valuation_signatures WHERE valuation_id = $1 AND role = $2',
    [valuationId, role],
  );
  return (rowCount ?? 0) > 0;
}

/** Signature gate: publish requires a 'main' signature (remaining-gaps §3 #3). */
export async function hasMainSignature(pool: pg.Pool, valuationId: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM valuation_signatures WHERE valuation_id = $1 AND role = 'main'",
    [valuationId],
  );
  return rows.length > 0;
}
