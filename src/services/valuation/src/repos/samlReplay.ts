import type pg from 'pg';

/**
 * The SAML assertion replay guard (migration 0098, SAML core §6.1).
 */

export interface SamlAssertionRef {
  /** Entity id from the signed assertion; '' when it names no issuer. */
  issuer: string;
  /** The assertion's ID attribute. */
  assertionId: string;
  /** Conditions/@NotOnOrAfter — when the assertion stops being usable. */
  expiresAt: Date;
}

/**
 * Record an assertion as consumed, returning false if it already was.
 *
 * The check and the write are one INSERT ... ON CONFLICT DO NOTHING rather than
 * a SELECT followed by an INSERT, because the interleaving worth defending
 * against is the one the attack actually produces: the captured assertion is
 * replayed *alongside* the user's own login, not minutes later. Read-then-write
 * would let both requests find the table empty and both proceed, which is the
 * whole attack — and the primary key would not save it, since the loser's
 * failed insert arrives after its session was already issued.
 *
 * Expired rows are swept in the same statement. Pruning before the insert is
 * safe rather than a hole: a row is only dropped once the assertion it names
 * has passed its own NotOnOrAfter, and node-saml refuses such an assertion on
 * the Conditions check before this is ever reached. The table therefore stays
 * sized by the assertions in flight instead of by every login ever made, with
 * no scheduled job to own.
 */
export async function consumeSamlAssertion(pool: pg.Pool, ref: SamlAssertionRef): Promise<boolean> {
  const { rowCount } = await pool.query(
    `WITH swept AS (
       DELETE FROM saml_assertions_seen WHERE expires_at <= now()
     )
     INSERT INTO saml_assertions_seen (issuer, assertion_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (issuer, assertion_id) DO NOTHING`,
    [ref.issuer, ref.assertionId, ref.expiresAt],
  );
  return (rowCount ?? 0) > 0;
}
