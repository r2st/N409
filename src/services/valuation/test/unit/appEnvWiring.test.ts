import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  buildEmailTransports,
  capTableSyncCredentials,
  hrisCredentials,
  resolveScanPolicy,
} from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

/**
 * The four functions that turn environment variables into wiring.
 *
 * They are pure and boring, which is why nothing had exercised them, and they
 * are also the whole of what separates a deployment that sends mail from one
 * that only queues it, and one that scans uploads from one that does not. Each
 * of the pairs below is a half-configured environment — the case that is easy
 * to reach by accident and that has to resolve to something explicit rather
 * than a partly-live provider.
 */

const base = { JWT_SECRET: 'x'.repeat(32) };
const config = (env: Record<string, string>) => loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);

/** Enough of a Fastify logger for the functions under test, with spies. */
function stubLog() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  };
  log.child = () => log;
  return log as unknown as FastifyBaseLogger & typeof log;
}

describe('buildEmailTransports', () => {
  it('uses SMTP when the mode asks for it and a host is set', () => {
    const log = stubLog();
    const { transport } = buildEmailTransports(
      config({ EMAIL_MODE: 'smtp', SMTP_HOST: 'mail.example', SMTP_FROM: 'n409@example' }),
      log,
    );
    expect(transport).toBeDefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns and falls back to the log transport when SMTP is asked for without a host', () => {
    const log = stubLog();
    const { transport } = buildEmailTransports(config({ EMAIL_MODE: 'smtp' }), log);
    // Still a transport — a service that silently stopped sending because one
    // variable was missed is the failure this warning exists to name.
    expect(transport).toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      'EMAIL_MODE=smtp but SMTP_HOST is unset — falling back to log transport',
    );
  });

  it('is the log transport in the default mode, with no warning', () => {
    const log = stubLog();
    const { transport } = buildEmailTransports(config({}), log);
    expect(transport).toBeDefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('has no transport at all when mail is off — the outbox is the only record', () => {
    const { transport } = buildEmailTransports(config({ EMAIL_MODE: 'off' }), stubLog());
    expect(transport).toBeUndefined();
  });

  it('wires SMS to the log transport only in log mode', () => {
    expect(buildEmailTransports(config({ SMS_MODE: 'log' }), stubLog()).smsTransport).toBeDefined();
    expect(buildEmailTransports(config({ SMS_MODE: 'off' }), stubLog()).smsTransport).toBeUndefined();
    // The two modes are independent: mail off does not silence SMS.
    expect(
      buildEmailTransports(config({ EMAIL_MODE: 'off', SMS_MODE: 'log' }), stubLog()).smsTransport,
    ).toBeDefined();
  });
});

describe('resolveScanPolicy', () => {
  it('is no scanner, and says so in the log, when no clamd host is configured', () => {
    const log = stubLog();
    const policy = resolveScanPolicy(config({}), log);
    expect(policy.scanner).toBeUndefined();
    // Fail-open is the only sane default with no scanner: fail-closed here
    // would reject every upload on a deployment that never asked for scanning.
    expect(policy.failClosed).toBe(false);
    expect(log.info).toHaveBeenCalledWith('CLAMAV_HOST unset — uploaded documents are not virus scanned');
  });

  it('carries the fail-closed choice through once a host is set', () => {
    const log = stubLog();
    const policy = resolveScanPolicy(
      config({ CLAMAV_HOST: 'clamd.internal', VIRUS_SCAN_FAIL_CLOSED: 'true' }),
      log,
    );
    expect(policy.scanner).toBeDefined();
    expect(policy.failClosed).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'clamd.internal', failClosed: true }),
      'upload virus scanning enabled',
    );
  });

  it('scans and blocks by default once a host is configured', () => {
    // Configuring a scanner is the deployment saying it wants one, so an
    // unreachable one blocks: the uploads that land while it is down are
    // exactly the ones nobody goes back to re-check.
    const policy = resolveScanPolicy(config({ CLAMAV_HOST: 'clamd.internal' }), stubLog());
    expect(policy.scanner).toBeDefined();
    expect(policy.failClosed).toBe(true);
  });

  it('scans without blocking when the deployment opts out', () => {
    const policy = resolveScanPolicy(
      config({ CLAMAV_HOST: 'clamd.internal', VIRUS_SCAN_FAIL_CLOSED: 'false' }),
      stubLog(),
    );
    expect(policy.scanner).toBeDefined();
    expect(policy.failClosed).toBe(false);
  });
});

describe('provider credentials from env', () => {
  it('activates a cap-table provider only when both halves are set', () => {
    expect(
      Object.keys(
        capTableSyncCredentials(
          config({
            CARTA_CLIENT_ID: 'a',
            CARTA_CLIENT_SECRET: 'b',
            // Half of Pulley: an id with no secret cannot complete an exchange,
            // so offering it in the picker would be a dead button.
            PULLEY_CLIENT_ID: 'only-half',
          }),
        ),
      ),
    ).toEqual(['carta']);
  });

  it('activates a cap-table provider from the other half alone for neither', () => {
    expect(capTableSyncCredentials(config({ CARTA_CLIENT_SECRET: 'b' }))).toEqual({});
    expect(capTableSyncCredentials(config({}))).toEqual({});
  });

  it('activates both cap-table providers when both are fully configured', () => {
    expect(
      capTableSyncCredentials(
        config({
          CARTA_CLIENT_ID: 'a',
          CARTA_CLIENT_SECRET: 'b',
          PULLEY_CLIENT_ID: 'c',
          PULLEY_CLIENT_SECRET: 'd',
        }),
      ),
    ).toEqual({
      carta: { clientId: 'a', clientSecret: 'b' },
      pulley: { clientId: 'c', clientSecret: 'd' },
    });
  });

  it('activates each HRIS provider independently', () => {
    expect(
      Object.keys(
        hrisCredentials(
          config({
            RIPPLING_CLIENT_ID: 'a',
            RIPPLING_CLIENT_SECRET: 'b',
            DEEL_CLIENT_ID: 'e',
            DEEL_CLIENT_SECRET: 'f',
            GUSTO_CLIENT_SECRET: 'only-half',
          }),
        ),
      ).sort(),
    ).toEqual(['deel', 'rippling']);
  });

  it('activates no HRIS provider from an empty environment', () => {
    expect(hrisCredentials(config({}))).toEqual({});
    expect(hrisCredentials(config({ GUSTO_CLIENT_ID: 'a' }))).toEqual({});
  });
});
