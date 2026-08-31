import { describe, expect, it, vi } from 'vitest';
import {
  applyPartnerEmailTemplates,
  emailsForTransition,
  PARTNER_EMAIL_TEMPLATE_KEYS,
  renderEmailTemplate,
  type ValuationSnapshot,
} from '../../src/domain/emailWorkflows.js';
import {
  fetchPartnerLogo,
  isPrivateAddress,
  sniffImageKind,
  type HostResolver,
} from '../../src/clients/partnerLogo.js';

/** Improvement 8 — white-label email templates + logo fetching guards. */

const VARS = { company_name: 'Acme Inc', kind: '409a', partner_name: 'Bridge Advisors' };

const snapshot: ValuationSnapshot = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  kind: '409a',
  company_name: 'Acme Inc',
  user_id: 'U1',
  assigned_reviewer_id: null,
  partner_id: 'P1',
};

describe('renderEmailTemplate', () => {
  it('substitutes known placeholders and leaves unknown ones verbatim', () => {
    expect(renderEmailTemplate('{{partner_name}}: {{company_name}} ({{kind}}) {{nope}}', VARS)).toBe(
      'Bridge Advisors: Acme Inc (409a) {{nope}}',
    );
  });

  // `\w+` matches every name on `Object.prototype`, and a plain `vars[key]`
  // lookup found them — so `{{constructor}}` in a partner's email template
  // rendered as `function Object() { [native code] }`. Same three lines as
  // `renderTemplate` in domain/communications.ts, which carries the full note.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'leaves the inherited name {{%s}} verbatim',
    (key) => {
      expect(renderEmailTemplate(`{{${key}}}`, VARS)).toBe(`{{${key}}}`);
    },
  );
});

describe('applyPartnerEmailTemplates', () => {
  it('replaces subject and body for overridden keys only', () => {
    const specs = emailsForTransition(snapshot, 'started');
    expect(specs).toHaveLength(1);
    const out = applyPartnerEmailTemplates(
      specs,
      { valuation_started: { subject: '{{partner_name}} started {{company_name}}', body: 'Custom body.' } },
      VARS,
    );
    expect(out[0]!.subject).toBe('Bridge Advisors started Acme Inc');
    expect(out[0]!.body).toBe('Custom body.');
    expect(out[0]!.templateKey).toBe('valuation_started');
    expect(out[0]!.recipient).toBe('owner');
  });

  it('keeps platform defaults for keys without a complete override', () => {
    const specs = emailsForTransition(snapshot, 'published');
    const untouched = applyPartnerEmailTemplates(specs, {}, VARS);
    expect(untouched).toEqual(specs);
    // half-filled overrides are ignored
    const half = applyPartnerEmailTemplates(
      specs,
      { valuation_completed: { subject: 'only subject', body: '' } },
      VARS,
    );
    expect(half).toEqual(specs);
  });

  /**
   * The var bag a white-labelled send hands a partner's template.
   *
   * The send path assembles every scope it can answer — `always`, `link`, the
   * whole `valuation` scope — for the platform template and then rebuilt a
   * three-key subset for the partner's, so a partner template writing
   * `{{kind_label}}`, the phrasing every seeded platform template uses,
   * reached that partner's own client as literal braces while the identical
   * placeholder in a DB override beside it rendered correctly.
   */
  it('answers every name the platform template beside it can answer', () => {
    const specs = emailsForTransition(snapshot, 'started');
    const out = applyPartnerEmailTemplates(
      specs,
      {
        valuation_started: {
          subject: 'Your {{kind_label}} for {{company_name}}',
          body: 'Hi {{recipient_name}}, see {{valuation_link}}. Due {{due_date}}. — {{partner_name}}',
        },
      },
      {
        ...VARS,
        kind_label: '409A',
        recipient_name: 'Dana',
        valuation_link: 'https://app.n409.test/valuations/01JQ',
        due_date: '2026-08-21',
      },
    );
    expect(out[0]!.subject).toBe('Your 409A for Acme Inc');
    expect(out[0]!.body).toBe(
      'Hi Dana, see https://app.n409.test/valuations/01JQ. Due 2026-08-21. — Bridge Advisors',
    );
  });

  it('every templatable key corresponds to a real workflow email', () => {
    const seen = new Set<string>();
    for (const to of ['started', 'review', 'drafted', 'published', 'cancelled'] as const) {
      for (const spec of emailsForTransition(snapshot, to)) seen.add(spec.templateKey);
    }
    for (const key of PARTNER_EMAIL_TEMPLATE_KEYS) expect(seen.has(key), key).toBe(true);
  });
});

describe('sniffImageKind', () => {
  const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(16)]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it('recognizes PNG and JPEG magic bytes, rejects the rest', () => {
    expect(sniffImageKind(png)).toBe('png');
    expect(sniffImageKind(jpeg)).toBe('jpeg');
    expect(sniffImageKind(Buffer.from('<svg xmlns="…"/>'))).toBeNull();
    expect(sniffImageKind(Buffer.from('GIF89a'))).toBeNull();
  });
});

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

describe('fetchPartnerLogo', () => {
  const png = pngOf(64, 64);

  const fetchReturning = (body: Buffer, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(new Uint8Array(body), { status: 200, headers }));

  /** Every hostname resolves to one public address; no DNS in unit tests. */
  const publicDns: HostResolver = async () => ['93.184.216.34'];

  it('returns image bytes for a valid PNG', async () => {
    const logo = await fetchPartnerLogo('https://cdn.example.com/logo.png', fetchReturning(png), publicDns);
    expect(logo && sniffImageKind(logo)).toBe('png');
  });

  it('rejects non-http(s) URLs without fetching', async () => {
    const impl = fetchReturning(png);
    expect(await fetchPartnerLogo('file:///etc/passwd', impl, publicDns)).toBeNull();
    expect(await fetchPartnerLogo('not a url', impl, publicDns)).toBeNull();
    expect(await fetchPartnerLogo(null, impl, publicDns)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it('rejects non-image bodies, empty bodies, and failed responses', async () => {
    expect(
      await fetchPartnerLogo('https://x.example/logo', fetchReturning(Buffer.from('<html>nope')), publicDns),
    ).toBeNull();
    expect(
      await fetchPartnerLogo('https://x.example/logo', fetchReturning(Buffer.alloc(0)), publicDns),
    ).toBeNull();
    const failing = vi.fn(async () => new Response('gone', { status: 404 }));
    expect(await fetchPartnerLogo('https://x.example/logo', failing, publicDns)).toBeNull();
    const throwing = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await fetchPartnerLogo('https://x.example/logo', throwing, publicDns)).toBeNull();
  });

  it('rejects oversized bodies via content-length', async () => {
    expect(
      await fetchPartnerLogo(
        'https://x.example/logo',
        fetchReturning(png, { 'content-length': String(10 * 1024 * 1024) }),
        publicDns,
      ),
    ).toBeNull();
  });
});

/**
 * SSRF: `partners.logo_url` is a stored URL and rendering a report dials it
 * from inside the estate. Every one of these used to be a live request.
 */
describe('partner logo SSRF guard', () => {
  const png = pngOf(64, 64);
  const ok = () => vi.fn(async () => new Response(new Uint8Array(png), { status: 200 }));
  const publicDns: HostResolver = async () => ['93.184.216.34'];

  it('classifies the address ranges a host must not be dialled on', () => {
    for (const addr of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.7',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254', // cloud instance metadata
      '100.64.0.1', // carrier-grade NAT
      '198.18.0.1',
      '255.255.255.255',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      // The form `new URL()` actually produces for the line above — matching
      // only the dotted spelling would have guarded the string nobody sends.
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:169.254.169.254',
      '2002:7f00:1::', // 6to4 wrapping 127.0.0.1
      '64:ff9b::7f00:1', // NAT64
      'not-an-address',
      '1:2:3:4:5:6:7:8:9',
      'gggg::1',
    ]) {
      expect(isPrivateAddress(addr), addr).toBe(true);
    }
    for (const addr of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '172.15.0.1',
      '2606:4700::1111',
      '::ffff:93.184.216.34', // mapped, but mapped to a public address
      '2002:5db8:d822::', // 6to4 wrapping 93.184.216.34
    ]) {
      expect(isPrivateAddress(addr), addr).toBe(false);
    }
  });

  it('refuses a URL whose host is a private literal, without fetching', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://127.0.0.1:3001/api/v1/valuations',
      'http://10.1.2.3/logo.png',
      'http://[::1]:3001/logo.png',
      'http://[::ffff:127.0.0.1]/logo.png',
    ]) {
      const impl = ok();
      expect(await fetchPartnerLogo(url, impl, publicDns), url).toBeNull();
      expect(impl, url).not.toHaveBeenCalled();
    }
  });

  it('refuses localhost and internal suffixes whatever DNS says', async () => {
    const impl = ok();
    const lyingDns: HostResolver = async () => ['93.184.216.34'];
    expect(await fetchPartnerLogo('http://localhost:3001/logo.png', impl, lyingDns)).toBeNull();
    expect(await fetchPartnerLogo('http://db.internal/logo.png', impl, lyingDns)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses a public name that resolves to a private address', async () => {
    const impl = ok();
    const rebinding: HostResolver = async () => ['169.254.169.254'];
    expect(await fetchPartnerLogo('https://logo.attacker.test/x.png', impl, rebinding)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses when any one of several resolved addresses is private', async () => {
    const impl = ok();
    // A record on the internet, AAAA on loopback: which family the runtime
    // picks is not this guard's call, so both have to be public.
    const split: HostResolver = async () => ['93.184.216.34', '::1'];
    expect(await fetchPartnerLogo('https://logo.example/x.png', impl, split)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses when the name does not resolve at all', async () => {
    const impl = ok();
    const nxdomain: HostResolver = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await fetchPartnerLogo('https://nope.example/x.png', impl, nxdomain)).toBeNull();
    expect(await fetchPartnerLogo('https://nope.example/x.png', impl, async () => [])).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it('re-checks every redirect hop, so a public host cannot bounce it inward', async () => {
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      if (href === 'https://cdn.example/logo.png') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
      }
      return new Response(new Uint8Array(png), { status: 200 });
    });
    expect(await fetchPartnerLogo('https://cdn.example/logo.png', impl as never, publicDns)).toBeNull();
    // The first hop was dialled; the metadata address never was.
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('still follows a redirect that stays public', async () => {
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://cdn.example/logo.png') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://assets.example/final.png' },
        });
      }
      return new Response(new Uint8Array(png), { status: 200 });
    });
    const logo = await fetchPartnerLogo('https://cdn.example/logo.png', impl as never, publicDns);
    expect(logo && sniffImageKind(logo)).toBe('png');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('gives up on a redirect loop rather than following it forever', async () => {
    const impl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://a.example/x' } }),
    );
    expect(await fetchPartnerLogo('https://a.example/x', impl as never, publicDns)).toBeNull();
    expect(impl.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('treats a redirect with no Location as a dead end', async () => {
    const impl = vi.fn(async () => new Response(null, { status: 302 }));
    expect(await fetchPartnerLogo('https://a.example/x', impl as never, publicDns)).toBeNull();
  });
});
