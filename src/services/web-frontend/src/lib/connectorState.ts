import { formatDateTime } from './format';

/**
 * What a scheduled connector's card says, from the row the API returns.
 *
 * WHY THIS IS ONE FUNCTION AND NOT TWO PANELS. R252 gave the HRIS and cap-table
 * panels the same rewrite twice, because `status !== 'revoked'` had drawn a
 * failing connection with the green Connected pill in both. Both panels then
 * drew *every* failure the same way — the amber "Not syncing" pill with a
 * Reconnect button beside it — and by R256 that had stopped being true of the
 * server, which since R252 does two different things with a failure:
 *
 *   * a provider that was briefly unwell (a 503, a timeout, a rate limit) is
 *     retried on a backoff — 15m, 30m, 1h, 2h, 4h, then 8h — and the connection
 *     resumes on its own. Nothing is asked of anybody.
 *   * an authorisation the provider has ended is refused identically forever,
 *     so it is deliberately never retried and stays stopped until somebody
 *     redoes the OAuth hop.
 *
 * Told "Not syncing — Reconnect" for the first of those, an analyst redoes an
 * OAuth hop to fix a hiccup that was going to clear by itself before they
 * finished. Told nothing about the retry, they have no way to know the card
 * will right itself, so the reasonable reading of a red line quoting a status
 * code is that somebody has to act.
 *
 * The two are distinguished by `reconnect_required`, which the row carries
 * since migration 0196 precisely because they cannot be told apart any other
 * way: `next_sync_at` is null for a `manual` connection whichever failure it is
 * in.
 */
export type ConnectorHealth = 'not-configured' | 'not-connected' | 'connected' | 'retrying' | 'stopped';

export interface ConnectorConnection {
  status: 'connected' | 'error' | 'revoked';
  sync_frequency: 'manual' | 'daily' | 'weekly';
  next_sync_at?: string | null;
  reconnect_required?: boolean;
}

export function connectorHealth(
  connection: ConnectorConnection | null | undefined,
  configured: boolean,
): ConnectorHealth {
  if (!configured) return 'not-configured';
  if (!connection || connection.status === 'revoked') return 'not-connected';
  if (connection.status !== 'error') return 'connected';
  // A row written by a release that predates 0196 carries neither field, and
  // the old reading — a failure is a failure and reconnecting is the fix — is
  // the safe one to fall back to: it asks for an action that always works.
  if (connection.reconnect_required !== false) return 'stopped';
  return connection.next_sync_at ? 'retrying' : 'stopped';
}

/**
 * The sentence a card carries when the *engagement* stopped, not the connection
 * (R401).
 *
 * The scheduled sync skips a retired or closed engagement rather than disabling
 * the connection — a close is reversible, and restoring the file resumes the
 * schedule where it was. So the row keeps saying `connected`, keeps its cadence
 * and keeps a `next_sync_at` that stops advancing, and the card went on reading
 * 'Connected · syncs daily'. Nothing else on the page contradicts it: the
 * workspace's retired banner is gated on `archived_at`, so a called-off
 * engagement carries no banner at all.
 *
 * One sentence for both panels, because R252 is the standing lesson here — the
 * same connector prose written twice drifted apart in exactly the direction
 * that mattered.
 */
export const SCHEDULE_PAUSED_NOTE: Record<'retired' | 'closed', string> = {
  retired: 'This engagement has been retired, so scheduled syncing is paused.',
  closed: 'This engagement has been closed, so scheduled syncing is paused.',
};

/** The pill's words. The provider name is appended by the caller. */
export const CONNECTOR_HEALTH_LABEL: Record<ConnectorHealth, string> = {
  'not-configured': 'Not configured on this deployment',
  'not-connected': 'Not connected',
  connected: 'Connected',
  // Not "Not syncing": it is, on a backoff, and saying otherwise is what sends
  // somebody to redo an authorisation that is working.
  retrying: 'Sync failing · retrying',
  stopped: 'Not syncing',
};

/**
 * The sentence under the error, for a failure that will retry itself.
 *
 * Returns null when there is nothing to promise — a connection that is stopped,
 * or one whose retry time the row does not carry.
 */
export function retryNote(connection: ConnectorConnection, health: ConnectorHealth): string | null {
  if (health !== 'retrying' || !connection.next_sync_at) return null;
  return `Retrying automatically — next attempt ${formatDateTime(connection.next_sync_at)}.`;
}

/**
 * The sentence beside the cadence control on a connection that will not run it.
 *
 * Round 261 made `setSyncFrequency` stop restarting a terminally-failed
 * schedule: the cadence is recorded, because it is what the reconnect will
 * start from, but `next_sync_at` stays null and no sweep picks the row up.
 * That is the right server behaviour and it left the card saying two things at
 * once — "Not syncing" in the pill, "Daily" in the dropdown the analyst had
 * just set and been given a silent success for. The reasonable reading of a
 * saved cadence is that something is now scheduled.
 *
 * Returned from here rather than written into the two panels for the same
 * reason `connectorHealth` is: R252 wrote this card twice and the copies
 * diverged.
 */
export function cadenceNote(connection: ConnectorConnection, health: ConnectorHealth): string | null {
  // Nothing to correct on a `manual` connection: it schedules nothing either
  // way, and telling its reader that nothing is scheduled reads as a fault.
  if (health !== 'stopped' || connection.sync_frequency === 'manual') return null;
  return 'Auto-sync is saved, but nothing is scheduled until this connection is reconnected.';
}
