/**
 * A white-labelled report that came out without the firm's mark on it says so.
 *
 * `fetchPartnerLogo` has nine ways out and every one of them was `return null`.
 * That is right — a missing logo must never block a render — and it was
 * indistinguishable from the partner not having configured one. A firm whose
 * mark had silently stopped appearing on its own client-facing 409A reports
 * produced no line anywhere: the URL is stored and looks fine, the render
 * succeeds, the PDF is just missing the logo, and support has nothing to read.
 *
 * The reasons answer completely different questions, which is why they are
 * enumerated rather than counted. `blocked_destination` is the SSRF guard doing
 * its job on a URL somebody needs to be asked about; `unsupported_format` is a
 * partner who uploaded an SVG and needs telling; `http_error` is their CDN.
 */

import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_PIXELS } from '@n409/shared';
import { fetchPartnerLogo, type HostResolver, type LogoFailure } from '../../src/clients/partnerLogo.js';
import { fetchPartnerLogoCached } from '../../src/clients/partnerLogoCache.js';

/** A PNG that a header reader can measure: magic + a real IHDR. */
function pngOf(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(21);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), ihdr]);
}

const png = pngOf(64, 64);
const publicDns: HostResolver = async () => ['93.184.216.34'];
const privateDns: HostResolver = async () => ['10.0.0.5'];

function recorder() {
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    warns,
    log: { warn: (obj: Record<string, unknown>, msg: string) => void warns.push({ obj, msg }) },
  };
}

const fetchReturning = (body: Buffer, init: ResponseInit = {}) =>
  vi.fn(async () => new Response(new Uint8Array(body), { status: 200, ...init }));

/** The reason on the single line the call wrote. */
async function reasonFor(
  url: string,
  impl: typeof fetch,
  resolve: HostResolver = publicDns,
): Promise<LogoFailure | undefined> {
  const { log, warns } = recorder();
  const got = await fetchPartnerLogo(url, impl, resolve, log);
  expect(got).toBeNull();
  expect(warns).toHaveLength(1);
  return warns[0]!.obj.reason as LogoFailure;
}

describe('why a partner logo did not load', () => {
  it('says nothing at all when it worked', async () => {
    const { log, warns } = recorder();
    const logo = await fetchPartnerLogo('https://cdn.example/logo.png', fetchReturning(png), publicDns, log);
    expect(logo).not.toBeNull();
    expect(warns).toEqual([]);
  });

  /*
   * The tenth reason (round 265, methodology M6). `MAX_LOGO_BYTES` bounds what
   * comes off the socket, and a PNG deflates its pixels, so it says nothing
   * about what decoding costs: a 995 KB file inside that cap can declare
   * 16000 x 16000 RGBA and take `doc.image` past 1.2 GB in one call. The render
   * catches a bad image; it cannot catch an OOM kill.
   */
  it('refuses a small file that declares an enormous image', async () => {
    const bomb = pngOf(16_000, 16_000);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(await reasonFor('https://cdn.example/logo.png', fetchReturning(bomb))).toBe('too_many_pixels');
  });

  it('says how big it claimed to be, since that is the thing to go look at', async () => {
    const { log, warns } = recorder();
    await fetchPartnerLogo(
      'https://cdn.example/logo.png',
      fetchReturning(pngOf(30_000, 30_000)),
      publicDns,
      log,
    );
    expect(warns[0]!.obj).toMatchObject({ width: 30_000, height: 30_000, maxPixels: MAX_IMAGE_PIXELS });
  });

  it('refuses a header it cannot measure rather than passing it through', async () => {
    // `null` from the reader means unmeasured, not small. A file whose first
    // eight bytes are a good PNG header and whose IHDR is not there is exactly
    // the shape the render's own catch was left holding.
    const headerOnly = Buffer.from('\x89PNG\r\n\x1a\nnot-an-ihdr', 'latin1');
    expect(await reasonFor('https://cdn.example/logo.png', fetchReturning(headerOnly))).toBe(
      'too_many_pixels',
    );
  });

  it('still accepts a JPEG, which declares its size somewhere else entirely', async () => {
    // SOF0 after a JFIF APP0: 8 x 8, one component.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01,
      0x11, 0x00,
    ]);
    const { log, warns } = recorder();
    const got = await fetchPartnerLogo('https://cdn.example/mark.jpg', fetchReturning(jpeg), publicDns, log);
    expect(got).not.toBeNull();
    expect(warns).toEqual([]);
  });

  it('says nothing when the partner simply has no logo configured', async () => {
    // Absence of a URL is not a failure and must not read as one, or the line
    // fires for every non-white-labelled engagement on the platform.
    const { log, warns } = recorder();
    expect(await fetchPartnerLogo(null, fetchReturning(png), publicDns, log)).toBeNull();
    expect(warns).toEqual([]);
  });

  it('distinguishes a stored URL that is not a URL', async () => {
    expect(await reasonFor('not a url', fetchReturning(png))).toBe('invalid_url');
  });

  it('distinguishes the SSRF guard from every other refusal', async () => {
    // The one that must never be confused with a broken CDN: a stored URL
    // pointing into the private network is somebody to ask about, not a retry.
    const { log, warns } = recorder();
    await fetchPartnerLogo('https://internal.example/logo.png', fetchReturning(png), privateDns, log);
    expect(warns[0]!.obj).toMatchObject({ reason: 'blocked_destination', hop: 0 });
  });

  it('says which hop was blocked, so a redirect into the private network is visible', async () => {
    // hop 0 is the stored URL being wrong. Past it, somebody on the internet
    // redirected this process at 169.254.169.254 with a one-line 302.
    let call = 0;
    const impl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response(null, { status: 302, headers: { location: 'https://evil.example/next.png' } })
        : new Response(new Uint8Array(png), { status: 200 });
    });
    const resolve: HostResolver = async (host) =>
      host === 'evil.example' ? ['169.254.169.254'] : ['93.184.216.34'];
    const { log, warns } = recorder();
    await fetchPartnerLogo('https://cdn.example/logo.png', impl as never, resolve, log);
    expect(warns[0]!.obj).toMatchObject({ reason: 'blocked_destination', hop: 1, host: 'evil.example' });
  });

  it('distinguishes the partner CDN answering with an error, and carries the status', async () => {
    const failing = vi.fn(async () => new Response('gone', { status: 404 }));
    const { log, warns } = recorder();
    await fetchPartnerLogo('https://cdn.example/logo.png', failing as never, publicDns, log);
    expect(warns[0]!.obj).toMatchObject({ reason: 'http_error', status: 404 });
  });

  it('distinguishes a format PDFKit cannot embed — the one a partner can fix', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(await reasonFor('https://cdn.example/logo.svg', fetchReturning(svg) as never)).toBe(
      'unsupported_format',
    );
  });

  it('distinguishes an empty body from a body of the wrong kind', async () => {
    expect(await reasonFor('https://cdn.example/logo.png', fetchReturning(Buffer.alloc(0)) as never)).toBe(
      'empty_body',
    );
  });

  it('distinguishes too large, by the header and by the bytes', async () => {
    const byHeader = fetchReturning(png, { headers: { 'content-length': String(10 * 1024 * 1024) } });
    expect(await reasonFor('https://cdn.example/logo.png', byHeader as never)).toBe('too_large');

    const big = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(2 * 1024 * 1024)]);
    expect(await reasonFor('https://cdn.example/logo.png', fetchReturning(big) as never)).toBe('too_large');
  });

  it('stops a host whose content-length was a claim rather than a fact', async () => {
    // The declared length used to be the whole of the guard: `arrayBuffer()`
    // reads to the end of the stream before anything can measure it. This URL
    // is a value a partner typed, pointing at a host on the internet, so a
    // small declared length in front of an endless body is the case that
    // matters — and it took every byte into a report render's heap for the
    // three seconds the deadline allows.
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x41);
    const endless = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { 'content-length': '100' } },
        ),
    );
    expect(await reasonFor('https://cdn.example/logo.png', endless as never)).toBe('too_large');
    // Stopped just past the 1 MB cap, not at whatever the host chose: the
    // chunk that crossed it, plus the one a ReadableStream keeps queued ahead
    // of any reader.
    expect(pulled * chunk.byteLength).toBeLessThanOrEqual(1024 * 1024 + 2 * chunk.byteLength);
  });

  it('distinguishes a redirect loop from a redirect with nowhere to go', async () => {
    const looping = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example/again.png' } }),
    );
    expect(await reasonFor('https://cdn.example/logo.png', looping as never)).toBe('too_many_redirects');

    const headless = vi.fn(async () => new Response(null, { status: 302 }));
    expect(await reasonFor('https://cdn.example/logo.png', headless as never)).toBe(
      'redirect_without_location',
    );
  });

  it('distinguishes the transport giving up, and keeps the error for the stack', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const { log, warns } = recorder();
    await fetchPartnerLogo('https://cdn.example/logo.png', throwing as never, publicDns, log);
    expect(warns[0]!.obj.reason).toBe('transport_error');
    // The context, not just the classification: a timeout and a DNS failure
    // both land here and the message is what tells them apart.
    expect(warns[0]!.obj.err).toBeInstanceOf(Error);
  });

  it('names the URL, which is the partner’s own setting and the thing to go look at', async () => {
    const { log, warns } = recorder();
    await fetchPartnerLogo(
      'https://cdn.example/logo.svg',
      fetchReturning(Buffer.from('<svg/>')) as never,
      publicDns,
      log,
    );
    expect(warns[0]!.obj.logoUrl).toBe('https://cdn.example/logo.svg');
  });
});

describe('the logo cache does not turn one broken partner into a line per render', () => {
  it('reports the failure once and stays quiet for the cached miss', async () => {
    // The negative TTL exists so a dead logo host is dialled once rather than
    // once per render. Re-reporting off a cache entry would be the shape that
    // gets a log muted — a firm rendering fifty reports a day would write fifty
    // identical lines about one misconfigured URL.
    const { log, warns } = recorder();
    const url = `https://cdn.example/${Math.random().toString(36).slice(2)}.png`;
    const failing = vi.fn(async (_u: string, _i?: unknown, _r?: unknown, l?: typeof log) => {
      l?.warn({ reason: 'http_error', logoUrl: url }, 'partner logo not loaded — rendering without it');
      return null;
    });

    const now = () => 1_000;
    expect(await fetchPartnerLogoCached(url, now, failing as never, log)).toBeNull();
    expect(await fetchPartnerLogoCached(url, now, failing as never, log)).toBeNull();
    expect(await fetchPartnerLogoCached(url, now, failing as never, log)).toBeNull();

    expect(failing).toHaveBeenCalledTimes(1);
    expect(warns).toHaveLength(1);
  });
});
