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
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { trustedProxies, DEFAULT_TRUSTED_PROXIES, CLOUDFLARE_RANGES } from '../src/clientIp.js';

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

  // The breadth check only runs on entries this file can parse into a range;
  // anything it cannot parse is handed to proxy-addr as if it were a preset
  // name. That fallback is correct for `loopback`, and it is a hole for
  // everything else — an address proxy-addr understands and this parser does
  // not is a wide block that reaches production unmeasured. So the spellings
  // below are not parser trivia: each is a way of writing a block that must be
  // refused, and the test is that the spelling does not change the answer.
  describe('breadth is measured however the address is spelled', () => {
    it('reads a fully-written IPv6 block the same as its compressed form', () => {
      // `::ffff:0.0.0.0/96` is already refused. Written out, it is the same
      // block and the same grant of all IPv4 — the `::` is a convenience, not
      // the thing that makes it wide.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '0:0:0:0:0:ffff:0:0/96' })).toThrow(/spans/);
      expect(() => trustedProxies({ TRUSTED_PROXIES: '0000:0000:0000:0000:0000:ffff:0:0/96' })).toThrow(
        /spans/,
      );
    });

    it('expands :: with groups on both sides of it', () => {
      // left = 2000, right = 1, six groups elided between them.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '2000::1/3' })).toThrow(/spans/);
      // left only, right empty.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '2000::/3' })).toThrow(/spans/);
      // right only, left empty — the leading-:: form.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '::1/0' })).toThrow(/spans/);
    });

    it('reads hex groups in either case', () => {
      // An operator pasting from a log gets whichever case that log used.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '2A00::/3' })).toThrow(/spans/);
      expect(trustedProxies({ TRUSTED_PROXIES: '2A00:CB00::/32' })).toEqual(['2A00:CB00::/32']);
    });

    it('reads a trailing dotted quad, which is how a dual-stack peer is logged', () => {
      // ::ffff:203.0.113.9 is a single host and fine; the /97 around it is half
      // of IPv4 and is not.
      expect(trustedProxies({ TRUSTED_PROXIES: '::ffff:203.0.113.9' })).toEqual(['::ffff:203.0.113.9']);
      expect(() => trustedProxies({ TRUSTED_PROXIES: '::ffff:0.0.0.0/97' })).toThrow(/of IPv4/);
    });

    it('does not mistake a v4 block for a v6 one, or the reverse', () => {
      // `contains` compares families before ranges: 10.0.0.0/8 must not exempt
      // an IPv6 block that happens to share its numeric start.
      expect(() => trustedProxies({ TRUSTED_PROXIES: '::a00:0/24' })).toThrow(/spans/);
    });
  });

  // These are the inputs the parser gives up on. Giving up is the documented
  // behaviour — proxy-addr is the validator, and it rejects them at boot — so
  // what is pinned here is that `trustedProxies` passes them through rather
  // than throwing its own confusing error or, worse, coercing them into a
  // range it then measures wrongly.
  describe('unparseable entries are left for proxy-addr to reject', () => {
    const unparseable = [
      '256.0.0.0/1', // octet out of range
      '10.0.0/1', // three octets
      '10.0.0.0/abc', // non-numeric prefix
      '10.0.0.0/33', // prefix wider than the family
      '::/129', // prefix wider than the family, v6
      'gggg::/1', // not hex
      '1:2:3/1', // too few groups, and no :: to stand in for the rest
      '1:2:3:4:5:6:7:8:9/1', // too many groups
      '1:2:3:4:5:6:7:8::9/1', // :: with no room left to expand into
      '::1::2/1', // two ::
      '::ffff:999.0.0.1/96', // dotted quad that is not an address
      'not-an-address',
    ];

    for (const entry of unparseable) {
      it(`passes "${entry}" through untouched`, () => {
        expect(trustedProxies({ TRUSTED_PROXIES: entry })).toEqual([entry]);
      });
    }

    it('still refuses a real wide block sitting beside one of them', () => {
      // The unmeasurable entry must not short-circuit the rest of the list.
      expect(() => trustedProxies({ TRUSTED_PROXIES: 'not-an-address, 0.0.0.0/1' })).toThrow(/spans/);
    });
  });
});

// The hop that was missing in production.
//
// 409.doaide.com resolves to Cloudflare, not to the origin — the A record is
// proxied, which infra/caddy/README.md says it must not be and which nothing
// ever checked. So the real chain is `client → Cloudflare edge → Caddy → web`,
// proxy-addr stopped at the Cloudflare address because no entry named it, and
// `req.ip` was a Cloudflare datacenter for every request on the internet.
// Measured, not reasoned: a request from 49.43.232.92 was logged by n409-web as
// remoteAddress 104.23.175.42.
describe('trustedProxies: the cloudflare hop', () => {
  it('expands to the published ranges rather than reaching proxy-addr as a name', () => {
    const hops = trustedProxies({ TRUSTED_PROXIES: 'loopback, cloudflare' });
    expect(hops).toContain('loopback');
    // proxy-addr knows `loopback`, `linklocal` and `uniquelocal` and nothing
    // else; left unexpanded, this token would be rejected by it at boot.
    expect(hops).not.toContain('cloudflare');
    expect(hops).toEqual(expect.arrayContaining(CLOUDFLARE_RANGES));
  });

  it('is spelled case-insensitively, like every other value here', () => {
    for (const spelling of ['Cloudflare', 'CLOUDFLARE', ' cloudflare ']) {
      expect(trustedProxies({ TRUSTED_PROXIES: spelling })).toEqual(CLOUDFLARE_RANGES);
    }
  });

  // Shapes, not values: the list is refreshed from Cloudflare and a refresh
  // must not have to fight the test suite.
  it('is a list of CIDR blocks in both families', () => {
    expect(CLOUDFLARE_RANGES.length).toBeGreaterThan(10);
    const v4 = CLOUDFLARE_RANGES.filter((r) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(r));
    const v6 = CLOUDFLARE_RANGES.filter((r) => /^[0-9a-f:]+\/\d{1,3}$/.test(r));
    expect(v4.length + v6.length).toBe(CLOUDFLARE_RANGES.length);
    expect(v4.length).toBeGreaterThan(0);
    expect(v6.length).toBeGreaterThan(0);
  });

  it('holds no duplicates', () => {
    expect(new Set(CLOUDFLARE_RANGES).size).toBe(CLOUDFLARE_RANGES.length);
  });

  // The token is exempt from the width guard on purpose — `2a06:98c0::/29` is
  // wider than MIN_PREFIX allows and is Cloudflare's published block. The
  // exemption must belong to the token and not leak to what an operator types,
  // because the guard's whole job is catching a human who wrote a block wider
  // than they meant.
  it('does not exempt the same block when it is written out by hand', () => {
    expect(() => trustedProxies({ TRUSTED_PROXIES: '2a06:98c0::/29' })).toThrow(/spans/);
  });

  it('still refuses blanket trust alongside it', () => {
    expect(() => trustedProxies({ TRUSTED_PROXIES: 'cloudflare, true' })).toThrow(/regardless of the other/);
  });

  // It is not in the default, and must not become so: a deployment not behind
  // Cloudflare would be trusting routable space it does not run for nothing.
  it('is opt-in, never a default', () => {
    expect(DEFAULT_TRUSTED_PROXIES).not.toContain('cloudflare');
    expect(trustedProxies({})).not.toEqual(expect.arrayContaining(['104.16.0.0/13']));
  });
});

// What the list is *for*, exercised through the thing that consumes it. The
// unit assertions above pin the value; this pins the behaviour that value
// exists to produce, against the real proxy-addr and a real Fastify request.
describe('the chain a Cloudflare-fronted request actually presents', () => {
  const CLIENT = '49.43.232.92';
  const CF_EDGE = '104.23.175.42';

  /** `req.ip` for a loopback request carrying the given X-Forwarded-For. */
  async function resolve(trustProxy: string[] | false, xff: string): Promise<string> {
    const app = Fastify({ trustProxy });
    app.get('/', async (req) => ({ ip: req.ip }));
    const res = await app.inject({ method: 'GET', url: '/', headers: { 'x-forwarded-for': xff } });
    await app.close();
    return (res.json() as { ip: string }).ip;
  }

  // Cloudflare sets X-Forwarded-For to the client; Caddy appends the address it
  // was dialled from, which is the Cloudflare edge.
  const CHAIN = `${CLIENT}, ${CF_EDGE}`;

  it('attributes the request to Cloudflare without the hop — the live bug', async () => {
    expect(await resolve(trustedProxies({}), CHAIN)).toBe(CF_EDGE);
  });

  it('attributes it to the client with the hop', async () => {
    expect(await resolve(trustedProxies({ TRUSTED_PROXIES: 'loopback, cloudflare' }), CHAIN)).toBe(CLIENT);
  });

  // The other direction, and the reason this cannot simply be `trustProxy:
  // true`: trusting Cloudflare must not let the *client* name itself. A header
  // forged by whoever is really at 49.43.232.92 sits to the left of an address
  // nothing trusts, so the walk stops before it.
  it('does not let a client prepend an address of its own choosing', async () => {
    const forged = `203.0.113.9, ${CLIENT}, ${CF_EDGE}`;
    expect(await resolve(trustedProxies({ TRUSTED_PROXIES: 'loopback, cloudflare' }), forged)).toBe(CLIENT);
  });

  // A deployment that drops Cloudflare later keeps working: with no Cloudflare
  // address in the chain there is nothing for the extra ranges to match, and
  // the walk stops at the same place it would have anyway.
  it('is harmless when the request did not come through Cloudflare', async () => {
    expect(await resolve(trustedProxies({ TRUSTED_PROXIES: 'loopback, cloudflare' }), CLIENT)).toBe(CLIENT);
  });
});
