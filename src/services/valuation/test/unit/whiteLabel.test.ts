import { describe, expect, it, vi } from 'vitest';
import {
  applyPartnerEmailTemplates,
  emailsForTransition,
  PARTNER_EMAIL_TEMPLATE_KEYS,
  renderEmailTemplate,
  type ValuationSnapshot,
} from '../../src/domain/emailWorkflows.js';
import { fetchPartnerLogo, sniffImageKind } from '../../src/clients/partnerLogo.js';

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

describe('fetchPartnerLogo', () => {
  const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(16)]);

  const fetchReturning = (body: Buffer, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(new Uint8Array(body), { status: 200, headers }));

  it('returns image bytes for a valid PNG', async () => {
    const logo = await fetchPartnerLogo('https://cdn.example.com/logo.png', fetchReturning(png));
    expect(logo && sniffImageKind(logo)).toBe('png');
  });

  it('rejects non-http(s) URLs without fetching', async () => {
    const impl = fetchReturning(png);
    expect(await fetchPartnerLogo('file:///etc/passwd', impl)).toBeNull();
    expect(await fetchPartnerLogo('not a url', impl)).toBeNull();
    expect(await fetchPartnerLogo(null, impl)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it('rejects non-image bodies, empty bodies, and failed responses', async () => {
    expect(
      await fetchPartnerLogo('https://x.example/logo', fetchReturning(Buffer.from('<html>nope'))),
    ).toBeNull();
    expect(await fetchPartnerLogo('https://x.example/logo', fetchReturning(Buffer.alloc(0)))).toBeNull();
    const failing = vi.fn(async () => new Response('gone', { status: 404 }));
    expect(await fetchPartnerLogo('https://x.example/logo', failing)).toBeNull();
    const throwing = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await fetchPartnerLogo('https://x.example/logo', throwing)).toBeNull();
  });

  it('rejects oversized bodies via content-length', async () => {
    expect(
      await fetchPartnerLogo(
        'https://x.example/logo',
        fetchReturning(png, { 'content-length': String(10 * 1024 * 1024) }),
      ),
    ).toBeNull();
  });
});
