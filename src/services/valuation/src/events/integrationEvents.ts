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

/**
 * The cadence somebody chose for a standing pull of a client's data.
 *
 * The third transition of the same row, and the one left when R256 recorded the
 * other two. `manual` -> `daily` is a person arranging for a third party's
 * payroll roster to be read every day from now on, without anybody being asked
 * again; `daily` -> `manual` is that arrangement quietly ending, which reads
 * afterwards as a connection that simply stopped producing data. Neither left a
 * trace: `sync_frequency` is a column, and a column says what it is now.
 *
 * `info` rather than the `notice` its two siblings carry, and for the same
 * reason `monitoring_enabled` is `info`: the standing access itself was granted
 * and recorded elsewhere, and this is the schedule on top of it.
 */
export async function recordIntegrationScheduleChanged(
  client: pg.PoolClient,
  args: IntegrationEventArgs & { from: string; to: string },
): Promise<void> {
  await recordEvent(client, {
    valuationId: args.valuationId,
    type: 'integration_schedule_changed',
    actor: args.actor,
    // The `{ changes: { field: { from, to } } }` shape rather than a bare
    // `{ from, to }`: `extractChanges` reads the bare one as a field literally
    // called `value`, so the trail would have rendered "value: manual → daily"
    // over an event that names three other things.
    payload: {
      family: args.family,
      provider: args.provider,
      changes: { sync_frequency: { from: args.from, to: args.to } },
    },
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
