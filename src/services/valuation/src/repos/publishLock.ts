import type pg from 'pg';

/**
 * Lock class for the publish gate. Distinct from `OVERWRITE_CELL_LOCK`
 * (repos/overwrites.ts) and `TEMPLATE_NAME_LOCK` (repos/reportTemplates.ts) —
 * `pg_advisory_xact_lock(key1, key2)` shares one namespace across the database,
 * so two unrelated subsystems picking the same pair would block each other for
 * no reason.
 */
const PUBLISH_GATE_LOCK = 0x5062ae;

/**
 * Serialises everything that can change the answer `assertPublishGate` gives,
 * against the write that acts on that answer.
 *
 * The gate is a read ("is there a main signature, does the latest calculation
 * carry a passing QA review") and publishing is a write, and they ran on two
 * different connections with nothing holding the read's subject still in
 * between. `DELETE /valuations/:id/signatures/main` refuses only once the
 * valuation is *already* published, which at the moment it checks is not yet
 * true — so the two interleave into "gate reads the signature, signature is
 * deleted, publish lands", and the engagement ends up published with no main
 * signature on file. See test/integration/publishGateRace.test.ts, where that
 * ordering reproduces on five runs in six.
 *
 * A row lock on `valuations` would not do: the rows that decide the gate are in
 * `valuation_signatures` and `qa_reviews`, and the signature case has no row to
 * lock at all in the direction that matters — a *missing* signature is what the
 * publisher must not race. An advisory lock keyed on the valuation is held by
 * the transaction whether or not the rows it protects exist, which is the
 * property this needs.
 *
 * Transaction-scoped, so it is released by COMMIT or ROLLBACK and no failure
 * path can leak it. Must therefore be taken on a client inside a transaction —
 * on a pooled connection outside one it is acquired and released in the same
 * breath, and guards nothing.
 */
export async function lockPublishGate(client: pg.PoolClient, valuationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [PUBLISH_GATE_LOCK, valuationId]);
}
