import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { EventActor } from '../events/record.js';
import {
  recordIntegrationConnected,
  recordIntegrationDisconnected,
  recordIntegrationScheduleChanged,
} from '../events/integrationEvents.js';
import { openConnectionTokens, sealNullable, sealSecret } from '../crypto/connectionSecrets.js';
import type { CapTableProvider, TokenSet } from '../clients/capTableSync.js';

export type SyncFrequency = 'manual' | 'daily' | 'weekly';

export interface CapTableConnectionRow {
  id: string;
  valuation_id: string;
  provider: CapTableProvider;
  status: 'connected' | 'error' | 'revoked';
  external_company_id: string | null;
  external_company_name: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: Date | null;
  sync_frequency: SyncFrequency;
  next_sync_at: Date | null;
  connected_by: string | null;
  connected_at: Date;
  last_synced_at: Date | null;
  last_sync_summary: Record<string, unknown> | null;
  last_error: string | null;
  /**
   * Failures since the last success. Drives the retry backoff in
   * `recordSyncError`; see migration 0194 for why a scheduled connector needs
   * one at all.
   */
  sync_failures: number;
  /**
   * Whether the last failure was one only a person can clear — an
   * authorisation the provider has ended, which is never retried. The other
   * kind is on a backoff with a time to try again, and asks nothing of anybody.
   * `next_sync_at` cannot answer this: a `manual` connection has none in either
   * case. See migration 0196.
   */
  reconnect_required: boolean;
  /** Bumped by each reconnect; see migration 0197. */
  auth_generation: number;
}

/**
 * `auth_generation` is dropped alongside the tokens: it is bookkeeping about
 * which authorisation a write belongs to, and nothing outside this module has
 * a use for it. Leaking it would widen the public shape for no reader.
 */
export type PublicCapTableConnection = Omit<
  CapTableConnectionRow,
  'access_token' | 'refresh_token' | 'auth_generation'
>;

export function toPublic(row: CapTableConnectionRow): PublicCapTableConnection {
  const { access_token: _a, refresh_token: _r, auth_generation: _g, ...rest } = row;
  return rest;
}

const FREQ_INTERVAL: Record<SyncFrequency, string | null> = {
  manual: null,
  daily: '1 day',
  weekly: '7 days',
};

/**
 * The identity of a connection *and* of the authorisation it is currently on.
 * See `recordSync` for why the second half is part of the identity.
 */
export interface ConnectionGeneration {
  id: string;
  auth_generation: number;
}

export async function listConnections(pool: pg.Pool, valuationId: string): Promise<CapTableConnectionRow[]> {
  const { rows } = await pool.query<CapTableConnectionRow>(
    'SELECT * FROM cap_table_connections WHERE valuation_id = $1 ORDER BY provider',
    [valuationId],
  );
  return rows.map((r) => openConnectionTokens(r));
}

export async function findConnection(
  pool: pg.Pool,
  valuationId: string,
  provider: CapTableProvider,
): Promise<CapTableConnectionRow | null> {
  const { rows } = await pool.query<CapTableConnectionRow>(
    'SELECT * FROM cap_table_connections WHERE valuation_id = $1 AND provider = $2',
    [valuationId, provider],
  );
  return rows[0] ? openConnectionTokens(rows[0]) : null;
}

export async function upsertConnection(
  pool: pg.Pool,
  input: {
    valuationId: string;
    provider: CapTableProvider;
    tokens: TokenSet;
    connectedBy: string | null;
    externalCompanyId?: string | null;
  },
  actor: EventActor,
): Promise<CapTableConnectionRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<CapTableConnectionRow>(
      `INSERT INTO cap_table_connections
       (id, valuation_id, provider, access_token, refresh_token, token_expires_at,
        external_company_id, external_company_name, connected_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (valuation_id, provider) DO UPDATE SET
       status = 'connected',
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_expires_at = EXCLUDED.token_expires_at,
       external_company_id = COALESCE(EXCLUDED.external_company_id, cap_table_connections.external_company_id),
       external_company_name = COALESCE(EXCLUDED.external_company_name, cap_table_connections.external_company_name),
       connected_by = EXCLUDED.connected_by,
       connected_at = now(),
       -- A new authorisation, so any pull still in flight against the old one
       -- no longer owns this row. See migration 0197.
       auth_generation = cap_table_connections.auth_generation + 1,
       last_error = NULL,
       -- Reconnecting is what the authorisation failures ask a person to do,
       -- and what they ask it for is the schedule. A terminal failure clears
       -- the next-sync time, so a reconnect that only cleared the error would
       -- leave the cadence select reading Daily over a connection that never
       -- syncs again -- the same lie in a new place.
       sync_failures = 0,
       reconnect_required = false,
       next_sync_at = CASE WHEN cap_table_connections.sync_frequency = 'manual' THEN NULL ELSE now() END
     RETURNING *`,
      [
        newUlid(),
        input.valuationId,
        input.provider,
        sealSecret(input.tokens.accessToken),
        sealNullable(input.tokens.refreshToken),
        input.tokens.expiresAt,
        input.externalCompanyId ?? input.tokens.externalCompanyId ?? null,
        input.tokens.externalCompanyName ?? null,
        input.connectedBy,
      ],
    );
    const row = openConnectionTokens(rows[0]!);
    await recordIntegrationConnected(client, {
      valuationId: row.valuation_id,
      family: 'cap_table',
      provider: row.provider,
      externalName: row.external_company_name,
      actor,
    });
    return row;
  });
}

/**
 * Revocation is the end of the connection, so every bookkeeping write below is
 * conditional on it not having happened.
 *
 * `revokeConnection` blanks the stored tokens and refuses to run twice
 * (`status <> 'revoked'`), which says plainly that `revoked` is terminal — and
 * every other writer of `status` was unconditional. A revoke landing while a
 * sync or import is in flight is the ordinary case rather than an exotic one:
 * the scheduler runs on a fifteen-minute tick against provider calls measured
 * in seconds to minutes, and "disconnect" is exactly what somebody clicks when
 * a sync is misbehaving.
 *
 * What the unguarded write then did was report a connection the client had
 * just severed as `connected`, with `last_error` cleared and `last_synced_at`
 * stamped a moment ago — over a row whose access token is now the empty
 * string. The card in the product says the integration is healthy and synced;
 * the credential behind it is gone. `error` is the same untruth the other way
 * round: a provider failure attributed to a connection that no longer exists,
 * which reads as something to fix rather than something deliberately ended.
 */
/**
 * Record a successful sync and schedule the next one.
 *
 * WHY THE CADENCE IS READ HERE. This used to take the frequency as an argument,
 * and both callers passed `connection.sync_frequency` — the value read off the
 * row before the provider was called. Between that read and this write sits the
 * whole sync: a provider round trip plus, for the roster import, one INSERT and
 * one audit event per grant on a roster that can be hundreds. Changing the
 * cadence is exactly what somebody does during that window, for the same reason
 * they press Disconnect during it — the sync is behaving in a way they want to
 * change.
 *
 * So the success wrote back a schedule from before their change. Set Weekly
 * during a running daily sync and the row keeps `sync_frequency = 'weekly'`
 * while `next_sync_at` says tomorrow; set Daily during a running weekly one and
 * the card reads Daily over a connection that will not run for a week. Neither
 * says anything, because the select shows the cadence that was saved and the
 * time disagreeing with it is not on screen at all.
 *
 * Reading `sync_frequency` off the row inside the statement closes the window:
 * the value used is the one committed at this instant rather than one carried
 * in from a caller who read it minutes ago. `setSyncFrequency` writes both
 * columns together, so whichever of the two lands last leaves them agreeing.

 *
 * PINNED TO THE AUTHORISATION THE SYNC STARTED UNDER. `status <> 'revoked'`
 * asks whether the connection has ended; it cannot ask whether this is still
 * the same connection. A pull is a long round trip against a third party, and
 * the analyst reconnecting is a thing that happens *during* one — often
 * because the sync is what looked wrong. `upsertConnection` then installs new
 * tokens, clears `sync_failures` and `reconnect_required`, and puts the
 * schedule back; and the in-flight pull, still holding the superseded
 * credential, lands afterwards and writes its outcome over all of it.
 *
 * The worst version is not hypothetical, it is the *likely* one: many providers
 * invalidate the old refresh token when a user re-authorises, so the credential
 * the old pull is carrying is refused precisely because of the reconnect. That
 * is a `ReconnectRequiredError`, which is terminal — `reconnect_required = true`
 * and `next_sync_at = NULL` on a connection with a working authorisation
 * installed seconds earlier. The card reads "Reconnect required" over a healthy
 * connection, the schedule is dead, and reconnecting again can lose the same
 * race again.
 *
 * `auth_generation` (migration 0197) is bumped by `upsertConnection` and by
 * nothing else — a token refresh does not, because refreshing is the same
 * authorisation continuing. It is counted rather than timed because
 * `connected_at` cannot be the pin: a `timestamptz` holds microseconds and a JS
 * Date holds milliseconds, so a value read out and sent back never compares
 * equal. Taking the whole row rather than the id is what makes a new call site
 * say which generation it is writing for instead of being able to forget.
 */
export async function recordSync(
  pool: pg.Pool,
  connection: ConnectionGeneration,
  summary: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `UPDATE cap_table_connections
     SET last_synced_at = now(), last_sync_summary = $2, status = 'connected', last_error = NULL,
         sync_failures = 0,
         reconnect_required = false,
         next_sync_at = CASE sync_frequency
           WHEN 'daily' THEN now() + interval '1 day'
           WHEN 'weekly' THEN now() + interval '7 days'
           ELSE NULL
         END
     WHERE id = $1 AND status <> 'revoked' AND auth_generation = $3`,
    [connection.id, JSON.stringify(summary), connection.auth_generation],
  );
}

/**
 * Record a failed sync, and say when — if ever — to try again.
 *
 * The `status = 'error'` half is what this always did, and on its own it ended
 * the schedule: both sweeps ask for `status = 'connected'`, and nothing moved a
 * connection back. One 503 at three in the morning and the daily sync was over,
 * with the panel still showing the cadence somebody chose.
 *
 * So the failure now schedules its own retry, on a backoff that grows with the
 * number of failures since the last success — 15m, 30m, 1h, 2h, 4h, then 8h —
 * and the sweeps admit `error` rows whose time has come. Retrying on the
 * ordinary fifteen-minute tick would be the wrong answer in the other
 * direction: that is how a provider's rate limit becomes a longer rate limit.
 *
 * `terminal` is for the failure a retry cannot clear — a refresh token the
 * provider has refused, which it will refuse identically forever. Those clear
 * `next_sync_at` and wait for a person to reconnect, which is what their
 * message asks for. A connection whose cadence is `manual` also gets no time:
 * it never had one.
 *
 * `retryAfterSeconds` is the wait the provider *named*, and it is honoured as a
 * floor rather than as the answer. R255 taught `providerRefused` to read
 * `Retry-After` and spend it on the sentence an analyst reads; nothing carried
 * it as far as this column, so a scheduled sync answered `429 Retry-After:
 * 7200` came back in fifteen minutes to be refused again, and again thirty
 * minutes after that — the failure mode the comment above names, committed by
 * the schedule that names it.
 *
 * A floor, and not the whole answer, because the two numbers know different
 * things. The header knows when *this* provider will next serve a request; the
 * ladder knows this connection has now failed six times running. Taking the
 * later of them can only ever wait longer, so it cannot reintroduce the
 * hammering, while a provider naming two hours is believed over a ladder that
 * would have said fifteen minutes.
 */
export async function recordSyncError(
  pool: pg.Pool,
  connection: ConnectionGeneration,
  error: string,
  opts: { terminal?: boolean; retryAfterSeconds?: number | null } = {},
): Promise<void> {
  await pool.query(
    `UPDATE cap_table_connections
        SET status = 'error',
            last_error = $2,
            sync_failures = sync_failures + 1,
            -- Every failure states what it knows. A transient refusal sets this
            -- false because the request reached the provider and came back with
            -- something other than a refusal of our authorisation.
            reconnect_required = $3::boolean,
            next_sync_at = CASE
              WHEN $3::boolean THEN NULL
              WHEN sync_frequency = 'manual' THEN NULL
              -- Reads the pre-increment count: a first failure waits 15
              -- minutes, a sixth and every one after it waits eight hours.
              ELSE GREATEST(
                now() + interval '15 minutes' * power(2, LEAST(sync_failures, 5)),
                -- NULL whenever the provider named nothing, and GREATEST
                -- ignores NULLs, so the ladder stands alone in the ordinary case.
                now() + make_interval(secs => $4::double precision)
              )
            END
      WHERE id = $1 AND status <> 'revoked' AND auth_generation = $5`,
    [
      connection.id,
      error.slice(0, 500),
      opts.terminal ?? false,
      opts.retryAfterSeconds ?? null,
      connection.auth_generation,
    ],
  );
}

/**
 * Set the cadence of the standing pull, and record who set it.
 *
 * The third transition this row can make, and the one R256 left when it gave
 * the other two an event. `manual` -> `daily` is a person arranging for a third
 * party to be read every day from here on without anyone being asked again, and
 * `daily` -> `manual` is that arrangement ending — after which the connection
 * simply stops producing data, and the only record of why is a column that says
 * what it is now.
 *
 * The previous value comes from a `FOR UPDATE` sub-select rather than from the
 * caller. The caller has a row it read before the round trip, which is the
 * staleness R256 removed from `recordSync` for the same two columns; and taking
 * it here means the event names the cadence that was actually replaced. No
 * change, no event: setting Daily on a daily connection is a no-op the audit
 * trail should not report as a change, though the write still happens, so
 * pressing it re-bases `next_sync_at` exactly as it always did.
 */
/**
 * Whether a cadence change is allowed to restart the schedule.
 *
 * A terminal failure is the one state in this row that says "no sweep will
 * ever pick this up again": `recordSyncError` clears `next_sync_at` and sets
 * `reconnect_required`, and `logConnectorSyncFailure` writes the one line in
 * this subsystem that alerts, on the strength of that being final. Setting a
 * cadence wrote `next_sync_at = now() + interval` unconditionally, which
 * un-finalises it — from the dropdown, without touching the authorisation the
 * provider ended.
 *
 * What that produced is both halves of the lie at once. The sweep picks the
 * row up when the new cadence falls due, spends a refresh token the provider
 * has already refused, and records the same terminal failure again — an
 * `alert: true, retried: false` line for work no one can action, once per
 * cadence period, forever. Meanwhile `connectorHealth` reads
 * `reconnect_required` first, so the card still says "Not syncing" over a
 * connection that is being synced on a schedule.
 *
 * So the cadence is recorded and the schedule stays stopped. Reconnecting is
 * what starts it: `upsertConnection` clears `reconnect_required` and sets
 * `next_sync_at` from whatever cadence is on the row by then — including one
 * chosen while the connection was dead.
 */
export async function setSyncFrequency(
  pool: pg.Pool,
  id: string,
  frequency: SyncFrequency,
  actor: EventActor,
): Promise<void> {
  const interval = FREQ_INTERVAL[frequency];
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      valuation_id: string;
      provider: CapTableProvider;
      previous_frequency: SyncFrequency;
    }>(
      `UPDATE cap_table_connections c
       SET sync_frequency = $2,
           next_sync_at = ${interval ? `CASE WHEN c.reconnect_required THEN NULL ELSE now() + interval '${interval}' END` : 'NULL'}
      FROM (SELECT id, sync_frequency FROM cap_table_connections WHERE id = $1 FOR UPDATE) prev
     WHERE c.id = prev.id AND c.status <> 'revoked'
 RETURNING c.valuation_id, c.provider, prev.sync_frequency AS previous_frequency`,
      [id, frequency],
    );
    const row = rows[0];
    if (!row || row.previous_frequency === frequency) return;
    await recordIntegrationScheduleChanged(client, {
      valuationId: row.valuation_id,
      family: 'cap_table',
      provider: row.provider,
      from: row.previous_frequency,
      to: frequency,
      actor,
    });
  });
}

/**
 * Store a refreshed credential.
 *
 * Guarded on `status <> 'revoked'` like every other writer on this row: a
 * revoke landing while a sync is in flight ends the connection, and writing a
 * live access token back over the blanked one would resurrect a credential the
 * client just severed.
 *
 * `refreshToken` is `undefined` when the provider did not rotate it, which is
 * the common case, and the column is then left alone — writing `null` there
 * would make that the last successful refresh this connection ever had.
 *
 * PINNED TO THE AUTHORISATION THE REFRESH WAS SPENT UNDER, for the reason
 * `recordSync` gives at length and with more at stake than either bookkeeping
 * writer. A refresh is a round trip against the provider, so it has the same
 * window a pull has — and it is *inside* one: `accessTokenFor` renews before it
 * fetches, on the row the scheduler read at the top of the tick. An analyst who
 * reconnects during that window has `upsertConnection` install a new credential
 * and bump the generation; the refresh then lands and writes a token minted
 * from the *superseded* refresh token over it.
 *
 * That is worse than a superseded summary, which the next tick corrects. This
 * writes the credential itself, and on the premise migration 0197 is built on —
 * many providers invalidate the old refresh token family when a user
 * re-authorises — the token it stores is already dead. The next sync 401s,
 * `clients/oauthRefresh.ts` reads that as a `ReconnectRequiredError`, and the
 * connection lands on `reconnect_required = true` with `next_sync_at = NULL`:
 * the exact card R264 set out to stop showing over a healthy authorisation,
 * reached through the one writer on this row it left unpinned.
 *
 * A refresh that no longer owns the row still returns its access token to the
 * caller, and the pull carries on with it — that is deliberate. The outcome of
 * that pull is discarded by `recordSync`/`recordSyncError`, which are pinned to
 * the same generation, so nothing it does reaches the row.
 */
export async function updateTokens(
  pool: pg.Pool,
  connection: ConnectionGeneration,
  tokens: { accessToken: string; refreshToken?: string | undefined; expiresAt: Date | null },
): Promise<void> {
  await pool.query(
    `UPDATE cap_table_connections
        SET access_token = $2,
            refresh_token = COALESCE($3, refresh_token),
            token_expires_at = $4
      WHERE id = $1 AND status <> 'revoked' AND auth_generation = $5`,
    [
      connection.id,
      sealSecret(tokens.accessToken),
      sealNullable(tokens.refreshToken ?? null),
      tokens.expiresAt,
      connection.auth_generation,
    ],
  );
}

/**
 * End the connection, and record that somebody did.
 *
 * Idempotent by the same `status <> 'revoked'` guard that makes `revoked`
 * terminal: a second disconnect updates nothing and, because the event is
 * written from the returned row rather than beside the statement, records
 * nothing either. The route turns the `false` into a 404.
 */
export async function revokeConnection(
  pool: pg.Pool,
  valuationId: string,
  provider: CapTableProvider,
  actor: EventActor,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ external_company_name: string | null }>(
      `UPDATE cap_table_connections
     SET status = 'revoked', access_token = '', refresh_token = NULL, sync_frequency = 'manual',
         next_sync_at = NULL, reconnect_required = false
       WHERE valuation_id = $1 AND provider = $2 AND status <> 'revoked'
   RETURNING external_company_name`,
      [valuationId, provider],
    );
    const row = rows[0];
    if (!row) return false;
    await recordIntegrationDisconnected(client, {
      valuationId,
      family: 'cap_table',
      provider,
      externalName: row.external_company_name,
      actor,
    });
    return true;
  });
}

/**
 * Connections whose next scheduled sync is due (background scheduler).
 *
 * WHY THE JOIN. Three of this service's timers wrote to a valuation without
 * ever asking whether the engagement still existed. R89 put a refusal on all
 * 86 mutating routes and the route beside this one has one; the *timer* that
 * performs the same write on a schedule went through no route at all. So a
 * firm could withdraw an engagement and a scheduled sync would go on pulling
 * the client's cap table from Carta and applying it — hours after every button
 * in the product had stopped accepting changes.
 *
 * Filtered here rather than checked at the apply, deliberately. Checking later
 * would still have called the provider, which means still telling a third
 * party we are working a file the firm has withdrawn; and a sweep that fetches
 * and then discards is a sweep whose cost is invisible.
 *
 * A retirement is reversible (R90), so the connection is skipped rather than
 * disabled: restore the engagement and the schedule picks up where it was.
 */
export async function findDueConnections(pool: pg.Pool, limit = 25): Promise<CapTableConnectionRow[]> {
  const { rows } = await pool.query<CapTableConnectionRow>(
    `SELECT c.* FROM cap_table_connections c
       JOIN valuations v ON v.id = c.valuation_id AND v.archived_at IS NULL
     WHERE c.status IN ('connected', 'error') AND c.sync_frequency <> 'manual'
       AND c.next_sync_at IS NOT NULL AND c.next_sync_at <= now()
     ORDER BY c.next_sync_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => openConnectionTokens(r));
}
