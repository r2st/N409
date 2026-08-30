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
