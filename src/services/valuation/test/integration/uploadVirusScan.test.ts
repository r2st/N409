import { afterAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Upload antivirus wiring (documents/virusScan.ts).
 *
 * The unit tests cover the clamd protocol and the fail policy in isolation.
 * What they cannot show is that the policy is actually *reachable* from an
 * upload — that config becomes a scanner, that the scanner is handed to the
 * route, and that a refusal comes back as a 422 with nothing written. That
 * whole chain is what regresses when someone adds a third upload path, so it is
 * asserted here against the real app.
 *
 * No clamd is needed, and deliberately so: pointing the scanner at a port with
 * nothing behind it produces the `error` verdict, which is the case the
 * fail-closed switch exists to decide. Both settings are exercised below, which
 * between them prove the scan ran at all — the two differ only in whether the
 * scanner was consulted.
 */
const SCANNER_ENV = {
  CLAMAV_HOST: '127.0.0.1',
  // Nothing listens here; the connection is refused immediately.
  CLAMAV_PORT: '1',
  CLAMAV_TIMEOUT_MS: '2000',
};

/** A minimal multipart body for the session upload route. */
function multipart(filename: string, contents: string) {
  const boundary = '----n409scan';
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/plain\r\n\r\n${contents}\r\n--${boundary}--\r\n`;
  return { boundary, payload: Buffer.from(body) };
}

describe.skipIf(!dbUp)('upload virus scanning', () => {
  const contexts: TestApp[] = [];

  /** A fresh app on `env`, with a user and a valuation to upload against. */
  async function appWith(env: Record<string, string>) {
    const ctx = await setupTestApp(env);
    contexts.push(ctx);
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Scanned Co' },
    });
    const valuationId = created.json().valuation.id as string;

    const upload = (filename = 'financials.csv', contents = 'a,b\n1,2') => {
      const { boundary, payload } = multipart(filename, contents);
      return ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/documents`,
        headers: {
          ...authHeader(owner.token),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
    };
    return { ctx, owner, valuationId, upload };
  }

  afterAll(async () => {
    for (const ctx of contexts) await ctx?.teardown();
  });

  it('accepts uploads unchanged when no scanner is configured', async () => {
    const { upload } = await appWith({});
    const res = await upload();
    expect(res.statusCode, res.body).toBe(201);
  });

  /**
   * The default. An upload that could not be scanned is refused rather than
   * quietly stored unscanned — see the note on VIRUS_SCAN_FAIL_CLOSED.
   */
  it('refuses an upload it cannot scan when fail-closed', async () => {
    const { upload, ctx, valuationId } = await appWith({
      ...SCANNER_ENV,
      VIRUS_SCAN_FAIL_CLOSED: 'true',
    });
    const res = await upload();
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toContain('virus scan');

    // Nothing was written: the scan runs before the blob reaches disk, so a
    // refusal leaves no row to reconcile later.
    const rows = await ctx.pool.query('SELECT count(*)::int AS n FROM documents WHERE valuation_id = $1', [
      valuationId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('lets an unscannable upload through when fail-open', async () => {
    const { upload } = await appWith({ ...SCANNER_ENV, VIRUS_SCAN_FAIL_CLOSED: 'false' });
    const res = await upload();
    expect(res.statusCode, res.body).toBe(201);
  });

  /**
   * The scan is not a substitute for the type check, and does not run before
   * it: a file whose bytes contradict its extension is still refused on that
   * ground alone, with the scanner's own reason nowhere in the message.
   */
  it('still refuses a type-check failure on its own terms', async () => {
    const { upload } = await appWith({ ...SCANNER_ENV, VIRUS_SCAN_FAIL_CLOSED: 'false' });
    const res = await upload('report.csv', '<!doctype html><script>alert(1)</script>');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toContain('HTML');
  });
});
