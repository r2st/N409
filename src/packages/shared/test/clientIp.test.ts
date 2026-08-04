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

  describe('blanket trust spelled as a CIDR is refused too', () => {
    // The keyword guard above only reads words. proxy-addr is happy to compile
    // `0.0.0.0/1` and `128.0.0.0/1`, they tile the entire IPv4 space between
    // them, and the result is `trustProxy: true` reached by a route the guard
    // never looked at — every hop trusted, so `req.ip` is whatever the client
    // put leftmost in X-Forwarded-For. None of these values *looks* like
    // blanket trust, which is exactly why they have to be refused by number.

    it('refuses the two halves that tile the whole IPv4 space', () => {
      expect(() => trustedProxies({ TRUSTED_PROXIES: '0.0.0.0/1, 128.0.0.0/1' })).toThrow(
        /spans .* addresses of routable space/,
      );
      // Either half alone is already most of the internet.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '128.0.0.0/1' })).toThrow(/128\.0\.0\.0\/1/);
    });

    it('refuses a single block wide enough to cover the caller', () => {
      expect(() => trustedProxies({ TRUSTED_PROXIES: '198.0.0.0/4' })).toThrow(/routable space/);
    });

    it('refuses all-global-unicast IPv6', () => {
      // 2000::/3 is every globally routable IPv6 address there is.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '2000::/3' })).toThrow(/routable space/);
    });

    it('refuses a wide block hidden behind specific ones', () => {
      expect(() => trustedProxies({ TRUSTED_PROXIES: 'loopback, 10.0.0.7, 64.0.0.0/2' })).toThrow(
        /64\.0\.0\.0\/2/,
      );
    });

    it('says how to fix it rather than just refusing', () => {
      expect(() => trustedProxies({ TRUSTED_PROXIES: '0.0.0.0/1' })).toThrow(/loopback/);
      expect(() => trustedProxies({ TRUSTED_PROXIES: '0.0.0.0/1' })).toThrow(/TRUSTED_PROXIES=true/);
    });

    it('leaves real proxy fleets alone', () => {
      // The check is breadth, not routability — operators do legitimately put a
      // public load balancer in front. A CDN's widest advertised IPv4 block is
      // about a /13 and an ISP IPv6 allocation about a /32; both must pass, or
      // the guard just teaches people to set TRUSTED_PROXIES=none.
      expect(trustedProxies({ TRUSTED_PROXIES: '104.16.0.0/13' })).toEqual(['104.16.0.0/13']);
      expect(trustedProxies({ TRUSTED_PROXIES: '172.31.0.0/16, 2400:cb00::/32' })).toEqual([
        '172.31.0.0/16',
        '2400:cb00::/32',
      ]);
      // A bare address is one host, however it is written.
      expect(trustedProxies({ TRUSTED_PROXIES: '203.0.113.9, ::1, ::ffff:10.0.0.1' })).toEqual([
        '203.0.113.9',
        '::1',
        '::ffff:10.0.0.1',
      ]);
    });

    it('exempts non-routable blocks at any width, since the default is one', () => {
      // `uniquelocal` *is* 10/8 plus fc00::/7. Refusing the literal spelling
      // while shipping the preset would only teach operators that the preset is
      // the way around the check.
      expect(trustedProxies({ TRUSTED_PROXIES: '10.0.0.0/8' })).toEqual(['10.0.0.0/8']);
      expect(trustedProxies({ TRUSTED_PROXIES: 'fc00::/7' })).toEqual(['fc00::/7']);
      expect(trustedProxies({ TRUSTED_PROXIES: '127.0.0.0/8, 100.64.0.0/10' })).toEqual([
        '127.0.0.0/8',
        '100.64.0.0/10',
      ]);
      // …but a block that merely *starts* in private space and runs out of it
      // is not exempt: 10.0.0.0/6 reaches 11.x, which is routable.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '10.0.0.0/6' })).toThrow(/routable space/);
    });

    // ── The same blanket trust, spelled in the other address family ──────────
    //
    // A `/96` clears the `/32` IPv6 floor by a mile and is nonetheless every
    // IPv4 address there is, because `::ffff:0:0/96` is where IPv4 lives inside
    // IPv6 — and that is the spelling a dual-stack listener puts in its logs
    // (`::ffff:203.0.113.9`), so it is the natural thing for an operator to
    // copy. proxy-addr converts across families in both directions, so the
    // block really is honoured for plain IPv4 peers: the check has to measure
    // the IPv4 breadth, not the prefix length.
    describe('a v4-mapped IPv6 block is measured as the IPv4 space it grants', () => {
      it('refuses the mapped range itself, which is all of IPv4', () => {
        expect(() => trustedProxies({ TRUSTED_PROXIES: '::ffff:0.0.0.0/96' })).toThrow(
          /4294967296 addresses of IPv4, via the ::ffff:0:0\/96 mapped range/,
        );
      });

      it('refuses blocks written around the mapped range, which grant it whole', () => {
        // Both are IPv6 blocks in their own right — /95 clears the IPv6 floor —
        // and both contain every mapped IPv4 address.
        expect(() => trustedProxies({ TRUSTED_PROXIES: '::ffff:0.0.0.0/95' })).toThrow(/IPv4/);
        expect(() => trustedProxies({ TRUSTED_PROXIES: '::/0' })).toThrow(/routable space/);
      });

      it('refuses a mapped block that is merely very wide', () => {
        // /100 is a /4 of IPv4 — the same breadth 198.0.0.0/4 is refused for.
        expect(() => trustedProxies({ TRUSTED_PROXIES: '::ffff:0.0.0.0/100' })).toThrow(/IPv4/);
      });

      it('applies the IPv4 floor to it, not the IPv6 one', () => {
        // /104 is exactly a /8 of IPv4, which MIN_PREFIX allows for IPv4 — so
        // the mapped spelling must be allowed on identical terms, or the guard
        // is inconsistent about the same set of addresses.
        expect(trustedProxies({ TRUSTED_PROXIES: '::ffff:0.0.0.0/104' })).toEqual(['::ffff:0.0.0.0/104']);
      });

      it('still exempts non-routable space through the mapped spelling', () => {
        // ::ffff:10.0.0.0/104 is 10/8, which `uniquelocal` covers by preset.
        expect(trustedProxies({ TRUSTED_PROXIES: '::ffff:10.0.0.0/104' })).toEqual(['::ffff:10.0.0.0/104']);
      });

      it('leaves ordinary IPv6 fleets alone — they touch no mapped address', () => {
        expect(trustedProxies({ TRUSTED_PROXIES: '2400:cb00::/32, ::ffff:203.0.113.9' })).toEqual([
          '2400:cb00::/32',
          '::ffff:203.0.113.9',
        ]);
      });

      it('refuses it inside an otherwise specific list', () => {
        expect(() => trustedProxies({ TRUSTED_PROXIES: 'loopback, 10.0.0.7, ::ffff:0.0.0.0/96' })).toThrow(
          /::ffff:0\.0\.0\.0\/96/,
        );
      });
    });

    it('still hands the named presets through untouched', () => {
      // They are fixed strings this file chose, not operator-supplied breadth,
      // and proxy-addr is what validates them.
      expect(trustedProxies({ TRUSTED_PROXIES: 'loopback, uniquelocal' })).toEqual([
        'loopback',
        'uniquelocal',
      ]);
      expect(trustedProxies({})).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    });
  });

  it('refuses a value that is only separators instead of silently defaulting', () => {
    // ",," is a typo, not a request for the default. Quietly restoring full
    // default trust would hide it for as long as the deployment survives.
    expect(() => trustedProxies({ TRUSTED_PROXIES: ',' })).toThrow(/names no hops/);
    expect(() => trustedProxies({ TRUSTED_PROXIES: ' , , ' })).toThrow(/names no hops/);
  });
});
