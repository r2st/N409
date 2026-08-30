/**
 * A specialty run whose engine build could not be read.
 *
 * `calculations.engine_version` is provenance: which build priced this
 * company, read back by an auditor years later and by the rollforward that
 * compares two runs. The version is fetched from the engine's health route and
 * is deliberately not a dependency — a run must never fail for want of it — so
 * all three ways of not knowing end in the string 'unknown' rather than a
 * throw. Which is right, and which meant a run that lost its provenance was
 * indistinguishable from one that had none to lose, and left nothing anywhere
 * saying it had happened.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineVersion, resetEngineVersionCache } from '../../src/routes/specialty.js';

function recorder(): { lines: Array<{ obj: Record<string, unknown>; msg: string }>; log: never } {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    lines,
    log: { warn: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }) } as never,
  };
}

afterEach(() => {
  resetEngineVersionCache();
  vi.unstubAllGlobals();
});

describe('the engine build behind a specialty run', () => {
  it('is remembered, and says nothing, when the engine answers', async () => {
    const { lines, log } = recorder();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ engine_version: '9.9.9' })));
    expect(await engineVersion('http://engine.test', log)).toBe('9.9.9');
    expect(lines).toEqual([]);
  });

  it('names the refusal when the health route answers an error', async () => {
    const { lines, log } = recorder();
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }));
    expect(await engineVersion('http://engine.test', log)).toBe('unknown');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({ reason: 'http_error', status: 503 });
  });

  it('names a health body that no longer carries a version', async () => {
    const { lines, log } = recorder();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ status: 'ok' })));
    expect(await engineVersion('http://engine.test', log)).toBe('unknown');
    expect(lines[0]!.obj).toMatchObject({ reason: 'unreadable_version' });
  });

  it('names the unit being unreachable', async () => {
    const { lines, log } = recorder();
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    });
    expect(await engineVersion('http://engine.test', log)).toBe('unknown');
    expect(lines[0]!.obj).toMatchObject({ reason: 'transport_error' });
  });

  it('does not remember a failure — the next run asks again', async () => {
    const { log } = recorder();
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }));
    expect(await engineVersion('http://engine.test', log)).toBe('unknown');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ engine_version: '9.9.9' })));
    expect(await engineVersion('http://engine.test', log)).toBe('9.9.9');
  });
});
