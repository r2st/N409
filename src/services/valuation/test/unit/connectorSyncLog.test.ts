import { describe, expect, it } from 'vitest';
import { classifyFailure } from '@n409/shared';
import {
  IntegrationError,
  ReconnectRequiredError,
  providerRefused,
  withDeadline,
} from '../../src/clients/deadline.js';
import { logConnectorSyncFailure } from '../../src/domain/connectorSyncLog.js';

/**
 * What the log says when a scheduled connector stops.
 *
 * Since R252 `error` on one of these rows is two states — a backoff the sweep
 * comes back for, and an authorisation the provider has ended — and R256 put
 * the answer on the row (`reconnect_required`). The log was not told either
 * time: both arms wrote `warn({ err, connectionId }, 'scheduled … sync
 * failed')`, and `shared/failure.ts` says in as many words what `warn` there
 * promises, namely that the retry is going to handle it. For the terminal arm
 * nothing is going to handle it: `next_sync_at` is NULL, no sweep will read
 * that row again, and the analyst's only other notice is a pill on a panel.
 */

interface Line {
  level: 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
}

function recorder() {
  const lines: Line[] = [];
  const push = (level: 'warn' | 'error') => (fields: Record<string, unknown>, message: string) =>
    void lines.push({ level, fields, message });
  return { lines, warn: push('warn'), error: push('error') };
}

const subject = {
  family: 'hris' as const,
  provider: 'gusto',
  connectionId: '01HZCONN',
  valuationId: '01HZVAL',
  priorFailures: 3,
};

describe('a connector sync failure is logged at the level it earned', () => {
  it('alerts, and says no retry is coming, when the authorisation has ended', () => {
    const log = recorder();
    logConnectorSyncFailure(
      log,
      new ReconnectRequiredError('Gusto no longer accepts the stored authorisation — reconnect.'),
      subject,
      { scheduled: true },
    );
    expect(log.lines).toHaveLength(1);
    const [line] = log.lines;
    expect(line!.level).toBe('error');
    expect(line!.fields).toMatchObject({
      alert: true,
      retried: false,
      reconnect_required: true,
      valuationId: '01HZVAL',
      connectionId: '01HZCONN',
      provider: 'gusto',
      family: 'hris',
    });
    expect(line!.message).toMatch(/needs reconnecting/);
  });

  it('stays a warn for a provider having a bad minute', () => {
    const log = recorder();
    logConnectorSyncFailure(
      log,
      providerRefused('Gusto', 'roster fetch', { status: 503, headers: { get: () => null } }),
      subject,
      { scheduled: true },
    );
    expect(log.lines[0]!.level).toBe('warn');
    expect(log.lines[0]!.fields).toMatchObject({ failure_kind: 'transient', failure_reason: 'http.503' });
    expect(log.lines[0]!.fields.alert).toBeUndefined();
  });

  it('alerts on a refusal that will be refused identically forever', () => {
    const log = recorder();
    logConnectorSyncFailure(
      log,
      providerRefused('Gusto', 'roster fetch', { status: 404, headers: { get: () => null } }),
      subject,
      { scheduled: false },
    );
    expect(log.lines[0]!.level).toBe('error');
    expect(log.lines[0]!.fields).toMatchObject({ alert: true, failure_reason: 'http.404', scheduled: false });
  });

  it('carries how long this has been going on, which neither level can show', () => {
    const log = recorder();
    logConnectorSyncFailure(log, new Error('boom'), subject, { scheduled: true });
    // Eight transient failures read from the log as eight ordinary warns
    // spread over the day and a half the backoff took to get there.
    expect(log.lines[0]!.fields.priorFailures).toBe(3);
  });
});

/**
 * The classifier could not classify a single error these connectors throw.
 *
 * `providerRefused` interpolated the status into a sentence and dropped the
 * number, so `classifyFailure` — which reads `status`/`statusCode` off the
 * error — saw nothing structured and fell through to its deliberate default of
 * `permanent`. Routing these through `logFailure` without this would have
 * paged somebody for every 503 and every rate limit.
 */
describe('an integration failure says what kind it is', () => {
  it('classifies a rate limit as transient, the status it hid in its message', () => {
    const err = providerRefused('Carta', 'cap-table fetch', {
      status: 429,
      headers: { get: () => '30' },
    });
    expect(err.status).toBe(429);
    expect(classifyFailure(err)).toMatchObject({ kind: 'transient', reason: 'http.429' });
  });

  it('classifies a refused authorisation as permanent whatever the status was', () => {
    expect(classifyFailure(new ReconnectRequiredError('reconnect'))).toMatchObject({ kind: 'permanent' });
  });

  it('classifies our own deadline as transient', async () => {
    const err = await withDeadline('Gusto', 5, async (signal) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(classifyFailure(err)).toMatchObject({ kind: 'transient' });
  });

  it('leaves an error with no status alone rather than guessing', () => {
    expect(new IntegrationError('Gusto returned a non-JSON response').status).toBeUndefined();
  });
});
