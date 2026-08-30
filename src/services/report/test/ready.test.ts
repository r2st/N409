import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { verifyFontAssets } from '../src/pdf.js';

/**
 * Report service readiness.
 *
 * This service registered no checks, so `/ready` answered 200 unconditionally —
 * structurally incapable of reporting "not ready", which is the same defect the
 * web service's /ready was fixed for, and worse here because `infra/deploy.sh`
 * probes this unit and would have believed it.
 *
 * The whole of "can this service do its job" is whether it can render, and the
 * only part of a render that lives outside the process is the four embedded
 * font faces. They sit in `assets/`, a sibling of `dist/` rather than something
 * the build emits, so an archive or image that drops them yields a unit that
 * starts, answers /health, and fails every render — with nothing between the
 * bad deploy and the first analyst asking for a PDF.
 */

const SECRET = 'internal-secret-token';

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env.INTERNAL_SERVICE_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
  else process.env.INTERNAL_SERVICE_TOKEN = savedToken;
  vi.restoreAllMocks();
});

describe('report /ready', () => {
  it('checks something, rather than answering 200 by construction', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', checks: { fonts: 'ok' } });
    await app.close();
  });

  it('reports unavailable when a font asset cannot be read', async () => {
    const app = buildApp();
    // Warm the memoised faces first so the failure is injected rather than
    // depending on the real files being absent, which they are not.
    verifyFontAssets();
    vi.spyOn(await import('../src/pdf.js'), 'verifyFontAssets').mockImplementation(() => {
      throw new Error('report font "DejaVuSans.ttf" is unreadable: ENOENT');
    });

    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unavailable');
    expect(res.json().checks.fonts).toBe('failed');
    await app.close();
  });

  it('names the file for an operator holding the internal token', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = SECRET;
    const app = buildApp();
    vi.spyOn(await import('../src/pdf.js'), 'verifyFontAssets').mockImplementation(() => {
      throw new Error('report font "DejaVuSans-Bold.ttf" is unreadable: ENOENT');
    });

    const res = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { 'x-internal-token': SECRET },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.fonts).toMatch(/DejaVuSans-Bold\.ttf/);
    await app.close();
  });

  it('leaves liveness up while readiness is red', async () => {
    const app = buildApp();
    vi.spyOn(await import('../src/pdf.js'), 'verifyFontAssets').mockImplementation(() => {
      throw new Error('unreadable');
    });
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('adopts the caller request id so a render logs under the id that asked for it', async () => {
    // The other two Fastify services do this and the Python pair read the
    // header into a contextvar; this unit minted its own, so it was the one hop
    // where a correlated trace broke.
    //
    // Asked of a served request rather than of `initialConfig.requestIdHeader`,
    // which is how it was spelled until R211 replaced the header option with
    // `genReqId` — so that the *rule* about what may be adopted is one function
    // all three services share. The assertion went on naming the option and had
    // been failing ever since; what the trace needs is that the id comes back,
    // however the framework is told to take it.
    const app = buildApp();
    const seen: string[] = [];
    app.addHook('onRequest', async (req) => {
      seen.push(req.id);
    });
    await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': '01J9REQUESTID0000000000001' },
    });
    expect(seen).toEqual(['01J9REQUESTID0000000000001']);
    // And an id nobody could join on is refused rather than repeated: the hop
    // mints its own, and the request is still served.
    const refused = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'x'.repeat(4096) },
    });
    expect(refused.statusCode).toBe(200);
    expect(seen[1]).not.toBe('x'.repeat(4096));
    await app.close();
  });
});

describe('verifyFontAssets', () => {
  it('passes against the assets that actually ship', () => {
    // The check has to be true of a correct deploy, or it is just a new way to
    // be down. Also the only test that would catch the assets going missing
    // from the package.
    expect(() => verifyFontAssets()).not.toThrow();
  });

  it('is cheap to repeat, so a probe every second costs nothing', () => {
    verifyFontAssets();
    const started = process.hrtime.bigint();
    for (let i = 0; i < 50; i += 1) verifyFontAssets();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(50);
  });
});
