import { describe, expect, it, vi } from 'vitest';
import {
  fetchPartnerLogo,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  type HostResolver,
} from '../../src/clients/partnerLogo.js';
import { isPublicWebhookHost, isValidWebhookUrl } from '../../src/domain/partnerWebhooks.js';

/**
 * The address guards' refuse-rather-than-guess paths.
 *
 * `whiteLabel.test.ts` drives these through `isPrivateAddress`, which asks
 * `isIP` first — so anything that is not a well-formed literal is refused
 * there and the two family-specific functions never see it. They are exported
 * and used on their own, and every one of their own malformed-input paths is a
 * decision to refuse. A guard that answered "public" for an input it could not
 * parse would be a guard an attacker only has to confuse rather than defeat,
 * so each of those paths is worth pinning at the function that makes it.
 */

describe('isPrivateIpv4 — input it cannot reason about', () => {
  it('refuses anything that is not four dotted parts', () => {
    for (const address of ['127.0.0', '1.2.3.4.5', '', 'localhost', '::1']) {
      expect(isPrivateIpv4(address), address).toBe(true);
    }
  });

  it('refuses parts that are not integers', () => {
    for (const address of ['a.b.c.d', '1e2.0.0.1', '.0.0.1', '0x7f.0.0.1']) {
      expect(isPrivateIpv4(address), address).toBe(true);
    }
  });
});

describe('isPrivateIpv4 — the reserved blocks that are not RFC 1918', () => {
  it.each([
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.254', 'benchmarking'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    ['192.1.0.1', 'next to the protocol-assignment block'],
    ['198.20.0.1', 'next to the benchmarking block'],
    ['198.52.0.1', 'next to TEST-NET-2'],
    ['203.1.0.1', 'next to TEST-NET-3'],
    ['100.63.255.255', 'below carrier-grade NAT'],
    ['100.128.0.1', 'above carrier-grade NAT'],
    ['223.255.255.255', 'below multicast'],
  ])('allows %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('isPrivateIpv6 — spellings it cannot expand', () => {
  it.each([
    ['::1::2', 'two "::" runs'],
    ['1:2:3:4:5:6:7:8::', '"::" standing for no group at all'],
    ['1:2:3', 'too few groups without a "::"'],
    ['1:2:3:4:5:6:7:8:9', 'too many groups'],
    ['gggg::1', 'a group that is not hex'],
    ['12345::1', 'a group wider than four hex digits'],
    ['::ffff:1.2.3.999', 'a trailing quad that is out of range'],
    ['', 'nothing at all'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateIpv6(address)).toBe(true);
  });

  it('drops a zone index before judging the address', () => {
    // `fe80::1%eth0` is link-local with or without the interface on the end,
    // and the zone must not be what makes it unparseable — that would be the
    // right answer for the wrong reason.
    expect(isPrivateIpv6('fe80::1%eth0')).toBe(true);
    expect(isPrivateIpv6('2606:4700::1111%eth0')).toBe(false);
  });

  it('expands a compressed public address rather than refusing it', () => {
    expect(isPrivateIpv6('2606:4700::1111')).toBe(false);
    expect(isPrivateIpv6('2606:4700:0000:0000:0000:0000:0000:1111')).toBe(false);
  });
});

describe('the webhook host guard reads the same addresses as the logo guard', () => {
  /*
   * Both guards decide the same question for the same estate, and they used to
   * be two implementations of it. The webhook one matched IPv6 on the text, so
   * every spelling below registered as a public target while `[::1]` — the
   * same machine — was refused.
   */
  it.each([
    // What `new URL()` normalises `http://[::ffff:127.0.0.1]/` into.
    ['[::ffff:7f00:1]', 'IPv4-mapped loopback in hex'],
    ['[::ffff:a9fe:a9fe]', 'IPv4-mapped instance metadata in hex'],
    ['[2002:7f00:1::]', '6to4 wrapping loopback'],
    ['[2002:a9fe:a9fe::]', '6to4 wrapping instance metadata'],
    ['[64:ff9b::7f00:1]', 'NAT64 wrapping loopback'],
    ['[::1]', 'loopback'],
    ['[fe80::1]', 'link local'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'instance metadata'],
    ['203.0.113.9', 'TEST-NET-3'],
  ])('refuses %s (%s)', (host) => {
    expect(isPublicWebhookHost(host)).toBe(false);
    expect(isValidWebhookUrl(`https://${host}/hook`, false)).toBe(false);
  });

  it.each([
    ['[2606:4700::1111]', 'a public v6 literal'],
    ['[::ffff:5db8:d822]', 'IPv4-mapped, mapped to a public address'],
    ['93.184.216.34', 'a public v4 literal'],
    ['hooks.example.com', 'a name, decided at delivery instead'],
  ])('allows %s (%s)', (host) => {
    expect(isPublicWebhookHost(host)).toBe(true);
  });

  it('still lets a deployment opt into private targets deliberately', () => {
    expect(isValidWebhookUrl('http://127.0.0.1:9000/hook', true)).toBe(true);
    // Not for a scheme it never speaks, though.
    expect(isValidWebhookUrl('ftp://127.0.0.1/hook', true)).toBe(false);
  });
});

describe('fetchPartnerLogo — responses it will not follow or keep', () => {
  const publicDns: HostResolver = async () => ['93.184.216.34'];
  // A whole IHDR, not just its tag. R265 gave `fetchPartnerLogo` a tenth
  // refusal — `too_many_pixels`, which reads the declared dimensions and treats
  // an unreadable header as unmeasured rather than as small — and this fixture
  // stopped four bytes before the width, so every test here that expects a logo
  // back was getting `null` from the new guard instead of from the thing it was
  // testing. 16 x 16, far inside the budget.
  const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000001000000010', 'hex');

  it('gives up on a redirect that names no destination', async () => {
    const impl = vi.fn(async () => new Response(null, { status: 302 }));
    expect(await fetchPartnerLogo('https://cdn.example/logo.png', impl as never, publicDns)).toBeNull();
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('gives up on a Location that is not a URL at all', async () => {
    const impl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://[' } }));
    expect(await fetchPartnerLogo('https://cdn.example/logo.png', impl as never, publicDns)).toBeNull();
  });

  it('follows a relative Location against the hop that sent it', async () => {
    const seen: string[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (seen.length === 1)
        return new Response(null, { status: 302, headers: { location: '/assets/final.png' } });
      return new Response(new Uint8Array(PNG), { status: 200 });
    });
    expect(await fetchPartnerLogo('https://cdn.example/a/logo.png', impl as never, publicDns)).not.toBeNull();
    expect(seen[1]).toBe('https://cdn.example/assets/final.png');
  });

  it('refuses a URL that is not http(s) without dialling anything', async () => {
    const impl = vi.fn();
    for (const url of ['file:///etc/passwd', 'ftp://cdn.example/logo.png', 'data:image/png;base64,AAAA']) {
      expect(await fetchPartnerLogo(url, impl as never, publicDns), url).toBeNull();
    }
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses a string that is not a URL, and no URL at all', async () => {
    const impl = vi.fn();
    expect(await fetchPartnerLogo('not a url', impl as never, publicDns)).toBeNull();
    expect(await fetchPartnerLogo(null, impl as never, publicDns)).toBeNull();
    expect(await fetchPartnerLogo('', impl as never, publicDns)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it('keeps nothing from a response that is not an image', async () => {
    const impl = vi.fn(async () => new Response(Buffer.from('<svg/>'), { status: 200 }));
    // An SVG is an image to a browser and a script host to a renderer; the
    // sniff is a whitelist of two raster formats for exactly that reason.
    expect(await fetchPartnerLogo('https://cdn.example/logo.svg', impl as never, publicDns)).toBeNull();
  });

  it('keeps nothing from an empty body, or an error status', async () => {
    const empty = vi.fn(async () => new Response(new Uint8Array(), { status: 200 }));
    expect(await fetchPartnerLogo('https://cdn.example/logo.png', empty as never, publicDns)).toBeNull();

    const notFound = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await fetchPartnerLogo('https://cdn.example/logo.png', notFound as never, publicDns)).toBeNull();
  });

  it('refuses on a declared length over the cap without reading the body', async () => {
    const impl = vi.fn(
      async () =>
        new Response(new Uint8Array(PNG), {
          status: 200,
          headers: { 'content-length': String(50 * 1024 * 1024) },
        }),
    );
    expect(await fetchPartnerLogo('https://cdn.example/huge.png', impl as never, publicDns)).toBeNull();
  });

  it('returns null rather than throwing when the fetch itself fails', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await fetchPartnerLogo('https://cdn.example/logo.png', impl as never, publicDns)).toBeNull();
  });
});
