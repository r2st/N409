import type pg from 'pg';
import { recordEvent, type EventActor } from './record.js';

/**
 * Which connector family a lifecycle event is about.
 *
 * One writer for all three because they are the same row three times — an
 * access token, a refresh token, an expiry — and the thing worth recording is
 * the same sentence for each: a named person granted, or ended, a third party's
 * standing access to this engagement's data. Writing it out in three repos is
 * how the payloads drift into three shapes the audit trail has to read three
 * ways.
 */
export type IntegrationFamily = 'hris' | 'cap_table' | 'accounting';

interface IntegrationEventArgs {
  valuationId: string;
  family: IntegrationFamily;
  provider: string;
  /** The company/org the connection names at the provider, when it named one. */
  externalName?: string | null;
  actor: EventActor;
}

/**
 * Written in the same transaction as the connection row, per the audit spine's
 * rule: a change without its event, or an event without its change, is not a
 * state either half can reach.
 */
export async function recordIntegrationConnected(
  client: pg.PoolClient,
  args: IntegrationEventArgs,
): Promise<void> {
  await recordEvent(client, {
    valuationId: args.valuationId,
    type: 'integration_connected',
    actor: args.actor,
    payload: { family: args.family, provider: args.provider, external_name: args.externalName ?? null },
  });
}

export async function recordIntegrationDisconnected(
  client: pg.PoolClient,
  args: IntegrationEventArgs,
): Promise<void> {
  await recordEvent(client, {
    valuationId: args.valuationId,
    type: 'integration_disconnected',
    actor: args.actor,
    payload: { family: args.family, provider: args.provider, external_name: args.externalName ?? null },
  });
}
