import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every partner mutation that *publishes* an idempotency guarantee *honours*
 * one, and every one that honours it says so.
 *
 * `idempotencyDoc` in `routes/partnerApi.ts` carries a doc-comment that is
 * almost true: "declaring an endpoint here is also what puts it in the spec —
 * there is no second list." There is. `idempotencyDoc` writes the promise into
 * the registry, and `withIdempotency` — a wrapper each handler applies to its
 * own body, by hand, sixty lines further down — is what keeps it. Two lists,
 * paired by nothing.
 *
 * The pairing matters in both directions, and they fail differently:
 *
 *   - Declared, not wrapped. The spec a partner integrates against says a
 *     retried `POST /valuations` with the same `Idempotency-Key` replays the
 *     original response. It would instead create a second engagement — the
 *     exact duplicate the header exists to prevent, on the one resource this
 *     API bills for, discovered by the partner rather than by us.
 *   - Wrapped, not declared. The guarantee holds and no client is told, so
 *     integrations write their own de-duplication against a platform that was
 *     already doing it, and the 409 on a reused key arrives undocumented.
 *
 * The contract tests next door check response *schemas* — that what a route
 * returns matches what the spec says it returns. This is the other half: that
 * what a route *does* matches what the spec says it does. Nothing else asks.
 *
 * Source-scanned rather than driven, deliberately. What is at issue is whether
 * the two spellings appear together in the same `define(…)` block, which is a
 * fact about the file; `partnerApiContract.test.ts` is where behaviour is
 * exercised against a live app.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, '../../src/routes/partnerApi.ts'), 'utf8');

interface Block {
  method: string;
  path: string;
  /** `method path`, the spelling the exemption roster and the failures use. */
  route: string;
  declaresKey: boolean;
  honoursKey: boolean;
}

/**
 * Split the file on its `define(` calls — every partner endpoint is registered
 * by one, at one indent, and each block runs to the next.
 */
function blocks(): Block[] {
  const starts: number[] = [];
  const re = /^ {2}define\($/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SOURCE))) starts.push(m.index);

  return starts.map((start, i) => {
    const text = SOURCE.slice(start, starts[i + 1] ?? SOURCE.length);
    const method = /\bmethod:\s*'([A-Z]+)'/.exec(text)?.[1];
    const path = /\bpath:\s*'([^']+)'/.exec(text)?.[1];
    if (!method || !path) {
      throw new Error(`a define() block at offset ${start} declares no method/path`);
    }
    return {
      method,
      path,
      route: `${method} ${path}`,
      declaresKey: /\bidempotencyDoc\(/.test(text),
      honoursKey: /\bwithIdempotency\(/.test(text),
    };
  });
}

/**
 * Mutations that carry no `Idempotency-Key`, and why that is right rather than
 * missed. Phrased as a roster so a new mutation cannot join them silently: an
 * unlisted one fails below until somebody writes the reason down here.
 */
const NO_KEY_NEEDED: Record<string, string> = {
  'PUT /valuations/{id}':
    'a whole-resource correction — replaying it writes the same fields to the same row',
  'DELETE /webhooks/{id}':
    'deleting an id that is already gone is the 404 the first call earned, not a second deletion',
};

describe('the partner API idempotency contract', () => {
  const all = blocks();

  it('finds the endpoints it is supposed to be checking', () => {
    // A regex that matched nothing would make every assertion below vacuous.
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(all.some((b) => b.declaresKey)).toBe(true);
    expect(all.map((b) => b.route)).toContain('POST /valuations');
  });

  it('honours the key on every endpoint that publishes one', () => {
    const promised = all.filter((b) => b.declaresKey && !b.honoursKey).map((b) => b.route);
    expect(
      promised,
      'these endpoints document an `Idempotency-Key` and do not wrap their handler in ' +
        '`withIdempotency`. A partner retrying a timed-out request gets the duplicate the ' +
        'header told them they would not.',
    ).toEqual([]);
  });

  it('publishes the key on every endpoint that honours one', () => {
    const silent = all.filter((b) => b.honoursKey && !b.declaresKey).map((b) => b.route);
    expect(
      silent,
      'these endpoints replay on a repeated `Idempotency-Key` and never say so, so an ' +
        'integration cannot use the guarantee and meets the 409 on a reused key undocumented. ' +
        'Add `idempotencyDoc(…)` to the registry entry.',
    ).toEqual([]);
  });

  it('accounts for every mutation that carries no key at all', () => {
    const unexplained = all
      .filter((b) => b.method !== 'GET' && !b.declaresKey && !(b.route in NO_KEY_NEEDED))
      .map((b) => b.route);
    expect(
      unexplained,
      'these mutations neither publish nor honour an idempotency key. If a retry of one is ' +
        'genuinely harmless, say why in NO_KEY_NEEDED; otherwise give it `idempotencyDoc(…)` ' +
        'and `withIdempotency(…)` like its siblings.',
    ).toEqual([]);
  });

  it('has no exemption that outlived the endpoint it excused', () => {
    const routes = new Set(all.map((b) => b.route));
    const stale = Object.keys(NO_KEY_NEEDED).filter(
      (route) => !routes.has(route) || all.some((b) => b.route === route && b.declaresKey),
    );
    expect(
      stale,
      'these roster entries no longer describe an unkeyed mutation — delete them rather than ' +
        'leaving them to excuse a future one',
    ).toEqual([]);
  });
});
