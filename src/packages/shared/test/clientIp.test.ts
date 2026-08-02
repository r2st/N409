// Which hops are allowed to name the client.
//
// This is the input to Fastify's `trustProxy`, and it is the whole of what
// stands between "per-IP rate limit" and "rate limit anyone can opt out of".
// Two failure directions, both silent at boot and both fully open:
//
//   - too little trust and `req.ip` is the proxy, so every client shares one
//     bucket and one of them can spend it for all of them;
//   - too much trust and `req.ip` is whatever the client wrote in a header, so
//     each of them gets an unlimited number of buckets.
//
// Neither shows up as an error at runtime. A 429 looks identical whichever way
// the identity was wrong, so the value is pinned here instead.
import { describe, expect, it } from 'vitest';
import { trustedProxies, DEFAULT_TRUSTED_PROXIES } from '../src/clientIp.js';

describe('trustedProxies', () => {
  it('defaults to the private ranges the deployment actually uses', () => {
    // Loopback covers web→valuation and a same-host Caddy; uniquelocal covers
    // RFC1918, which is where a containerised Caddy dials from
    // (host.docker.internal → the 172.17/16 bridge). The two infra documents
    // disagree about which of those is in play, so the default covers both.
    const hops = trustedProxies({});
    expect(hops).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    expect(DEFAULT_TRUSTED_PROXIES).toContain('loopback');
  });

  it('treats an unset, empty, or whitespace value as unconfigured', () => {
    const expected = ['loopback', 'linklocal', 'uniquelocal'];
    expect(trustedProxies({})).toEqual(expected);
    expect(trustedProxies({ TRUSTED_PROXIES: '' })).toEqual(expected);
    expect(trustedProxies({ TRUSTED_PROXIES: '   ' })).toEqual(expected);
  });

  it('takes an explicit list of hops', () => {
    expect(trustedProxies({ TRUSTED_PROXIES: '10.0.0.7, 192.168.1.0/24' })).toEqual([
      '10.0.0.7',
      '192.168.1.0/24',
    ]);
  });

  it('tolerates ragged spacing and trailing separators in that list', () => {
    expect(trustedProxies({ TRUSTED_PROXIES: ' 10.0.0.7 ,,  loopback , ' })).toEqual([
      '10.0.0.7',
      'loopback',
    ]);
  });

  it('trusts nothing when asked to, leaving req.ip as the socket peer', () => {
    // The correct setting for a service with no proxy in front — not a
    // degraded one. It has to be reachable, or an operator who genuinely has
    // no proxy is pushed toward the blanket value below.
    for (const value of ['none', 'false', 'off', 'no', 'NONE', 'None']) {
      expect(trustedProxies({ TRUSTED_PROXIES: value })).toBe(false);
    }
  });

  describe('blanket trust is refused rather than accepted quietly', () => {
    // `trustProxy: true` takes the *leftmost* X-Forwarded-For entry, and that
    // entry is written by the client. Every per-IP limit in the valuation
    // service becomes a limit the caller may issue itself an exemption from,
    // and every audit row records an address of the caller's choosing. A
    // process that boots and looks healthy in that state is worse than one
    // that refuses to start, because nothing downstream can detect it.
    for (const value of ['true', 'all', '*', 'yes', 'any', 'TRUE', 'True']) {
      it(`refuses TRUSTED_PROXIES=${value}`, () => {
        expect(() => trustedProxies({ TRUSTED_PROXIES: value })).toThrow(/would trust any/i);
      });
    }

    it('names the way out in the message, so the fix is not "set it to none"', () => {
      expect(() => trustedProxies({ TRUSTED_PROXIES: 'true' })).toThrow(/TRUSTED_PROXIES=none/);
      expect(() => trustedProxies({ TRUSTED_PROXIES: 'true' })).toThrow(/loopback/);
    });

    it('refuses a blanket keyword hidden inside an otherwise specific list', () => {
      // The list is a union, so one permissive entry decides the whole thing —
      // and this is the form that reads as safe at a glance.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '10.0.0.7, all' })).toThrow(/"all"/);
      expect(() => trustedProxies({ TRUSTED_PROXIES: 'loopback, *, 10.0.0.7' })).toThrow(/contains "\*"/);
    });
  });

  it('refuses a value that is only separators instead of silently defaulting', () => {
    // ",," is a typo, not a request for the default. Quietly restoring full
    // default trust would hide it for as long as the deployment survives.
    expect(() => trustedProxies({ TRUSTED_PROXIES: ',' })).toThrow(/names no hops/);
    expect(() => trustedProxies({ TRUSTED_PROXIES: ' , , ' })).toThrow(/names no hops/);
  });
});
