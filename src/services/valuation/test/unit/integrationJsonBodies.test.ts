import { describe, expect, it, vi } from 'vitest';
import { exchangeCode as accountingExchange, fetchFinancials } from '../../src/clients/accounting.js';
import { exchangeCode as capTableExchange, fetchCapTable } from '../../src/clients/capTableSync.js';
import { exchangeCode as hrisExchange, fetchRosterAndGrants } from '../../src/clients/hris.js';
import {
  IntegrationError,
  MAX_INTEGRATION_JSON_BYTES,
  readJson,
  readJsonArray,
} from '../../src/clients/deadline.js';
import { GoogleOidc } from '../../src/auth/google.js';

/**
 * A 2xx from a provider is not a promise of JSON.
 *
 * The companion file asserts that every outbound integration call carries a
 * deadline. This one covers what arrives when the call *does* return: an
 * ingress or gateway in front of Xero, Carta, Gusto or Google answering with
 * its own HTML error page under a 200, or a body that simply arrives cut off.
 *
 * Each client used to do `(await res.json()) as TokenResponse` — a cast with no
 * runtime force behind it. Two things followed. The parser's rejection reached
 * the analyst raw, as `Sync failed: Unexpected token '<', "<html><hea"... is
 * not valid JSON`, which is the same complaint `withDeadline` was written to
 * fix: it names neither the provider nor whose fault it was. And a body of
 * `null` or `[...]` satisfied the cast, then hit a property read and threw
 * `Cannot read properties of null`.
 *
 * So the property under test is per call site, not per helper: whatever the
 * provider sends, the error names the provider and reads as the provider's
 * problem.
 */

const creds = { clientId: 'cid', clientSecret: 'shh' };

const html = (status = 200) =>
  new Response('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });

const raw = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Bodies that are a 200 but cannot become the object the client expects. */
const UNUSABLE = {
  'an HTML error page': () => html(),
  'a truncated body': () => raw('{"access_token": "at'),
  'an empty body': () => raw(''),
  'a JSON null': () => json(null),
  'a JSON array': () => json([{ access_token: 'at' }]),
  'a JSON string': () => json('access_token'),
  'a JSON number': () => json(42),
} as const;

const CASES = [
  {
    name: 'accounting token exchange',
    run: (f: typeof fetch) => accountingExchange('quickbooks', creds, 'https://cb', 'code', f),
    provider: /QuickBooks/,
  },
  {
    name: 'cap-table token exchange',
    run: (f: typeof fetch) => capTableExchange('carta', creds, 'https://cb', 'code', f),
    provider: /Carta/,
  },
  {
    name: 'HRIS token exchange',
    run: (f: typeof fetch) => hrisExchange('gusto', creds, 'https://cb', 'code', f),
    provider: /Gusto/,
  },
  {
    name: 'accounting financials import',
    run: (f: typeof fetch) => fetchFinancials('xero', { accessToken: 'at', externalOrgId: 'tenant' }, f),
    provider: /Xero/,
  },
  {
    name: 'cap-table pull',
    run: (f: typeof fetch) =>
      fetchCapTable('carta', { accessToken: 'at', externalCompanyId: 'co', externalCompanyName: null }, f),
    provider: /Carta/,
  },
  {
    name: 'HRIS roster pull',
    run: (f: typeof fetch) =>
      fetchRosterAndGrants(
        'gusto',
        { accessToken: 'at', externalCompanyId: 'co', externalCompanyName: null },
        f,
      ),
    provider: /Gusto/,
  },
] as const;

/** Answers every request with the same body, whatever the client asks for. */
const always = (make: () => Response) => (async () => make()) as typeof fetch;

describe('a provider answering 200 with a body that is not JSON', () => {
  for (const [label, make] of Object.entries(UNUSABLE)) {
    it.each(CASES)(`$name rejects ${label} by naming the provider`, async ({ run, provider }) => {
      await expect(run(always(make))).rejects.toThrow(provider);
    });
  }

  it.each(CASES)('$name never leaks the JSON parser wording', async ({ run }) => {
    // The specific string an analyst was shown before this was guarded.
    await expect(run(always(() => html()))).rejects.not.toThrow(/is not valid JSON|Unexpected token/);
  });

  it.each(CASES)('$name never surfaces a null property read', async ({ run }) => {
    await expect(run(always(() => json(null)))).rejects.not.toThrow(/Cannot read properties/);
  });

  it.each(CASES)('$name says the response was the problem', async ({ run }) => {
    await expect(run(always(() => html()))).rejects.toThrow(/non-JSON response/);
  });
});

describe('Google SSO code exchange', () => {
  const oidc = () =>
    new GoogleOidc(
      { clientId: 'cid', clientSecret: 'shh', redirectUri: 'https://cb' },
      { fetch: always(() => html()) },
    );

  it('reports a non-JSON token response as Google’s, not the parser’s', async () => {
    // A login path: the person hitting this is signing in, and "Unexpected
    // token '<'" tells them nothing about which side broke.
    await expect(oidc().exchangeCode('code')).rejects.toThrow(/Google/);
    await expect(oidc().exchangeCode('code')).rejects.not.toThrow(/is not valid JSON/);
  });

  it('reports a null token response without a property-read crash', async () => {
    const client = new GoogleOidc(
      { clientId: 'cid', clientSecret: 'shh', redirectUri: 'https://cb' },
      { fetch: always(() => json(null)) },
    );
    await expect(client.exchangeCode('code')).rejects.not.toThrow(/Cannot read properties/);
  });

  it('still returns the id_token on a well-formed response', async () => {
    const client = new GoogleOidc(
      { clientId: 'cid', clientSecret: 'shh', redirectUri: 'https://cb' },
      { fetch: always(() => json({ id_token: 'jwt-here' })) },
    );
    await expect(client.exchangeCode('code')).resolves.toBe('jwt-here');
  });
});

describe('Xero org identification stays best-effort', () => {
  it('does not fail the connection when /connections answers with junk', async () => {
    // Org identification is a nicety layered on top of a token exchange that
    // already succeeded; a bad body there must not cost the analyst the
    // connection they just authorised.
    const fetchFn = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/connections') ? html() : json({ access_token: 'at' }),
    ) as unknown as typeof fetch;

    const tokens = await accountingExchange('xero', creds, 'https://cb', 'code', fetchFn);
    expect(tokens.accessToken).toBe('at');
    expect(tokens.externalOrgId ?? null).toBeNull();
  });

  it('still reads the tenant when /connections answers properly', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/connections')
        ? json([{ tenantId: 't-1', tenantName: 'Acme' }])
        : json({ access_token: 'at' }),
    ) as unknown as typeof fetch;

    const tokens = await accountingExchange('xero', creds, 'https://cb', 'code', fetchFn);
    expect(tokens.externalOrgId).toBe('t-1');
    expect(tokens.externalOrgName).toBe('Acme');
  });
});

describe('readJson', () => {
  it('returns the parsed object', async () => {
    await expect(readJson(json({ a: 1 }), 'Xero')).resolves.toEqual({ a: 1 });
  });

  it('names the provider when the body will not parse', async () => {
    await expect(readJson(html(), 'Xero')).rejects.toThrow('Xero returned a non-JSON response');
  });

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'text'],
    ['a number', 7],
    ['a boolean', true],
  ])('rejects %s, which no caller can read properties off', async (_label, body) => {
    await expect(readJson(json(body), 'Carta')).rejects.toThrow('Carta returned an unexpected response body');
  });

  it('accepts an empty object — absent fields are the caller’s to check', async () => {
    // `readJson` guarantees a shape, not a payload; `!body.access_token`
    // downstream is the check that a token is actually present.
    await expect(readJson(json({}), 'Gusto')).resolves.toEqual({});
  });
});

describe('readJsonArray', () => {
  it('returns the parsed array', async () => {
    await expect(readJsonArray(json([{ tenantId: 't-1' }]))).resolves.toEqual([{ tenantId: 't-1' }]);
  });

  it.each([
    ['unparseable', () => html()],
    ['an object', () => json({ tenantId: 't-1' })],
    ['null', () => json(null)],
  ])('degrades %s to an empty list rather than throwing', async (_label, make) => {
    await expect(readJsonArray(make())).resolves.toEqual([]);
  });
});

/**
 * A body with no end to it.
 *
 * `res.json()` reads to the end of the stream before it parses, so against
 * this stream it never returns: it buffers until the process is killed. That
 * is the whole failure — no status, no log line, just a dead service and the
 * four others on the box that die with it. Every assertion below is really the
 * same one, that the read *terminates*, checked from a different angle.
 */
const endless = (chunkBytes = 1024 * 1024) => {
  let pulled = 0;
  const chunk = new Uint8Array(chunkBytes).fill(0x20);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  return { res: new Response(body), pulls: () => pulled };
};

describe('a provider answering with more body than we agreed to hold', () => {
  it('stops an endless body instead of buffering it to death', async () => {
    // Without the cap this line does not fail — it never returns at all.
    const { res } = endless();
    await expect(readJson(res, 'Carta')).rejects.toThrow(/Carta returned a response larger than/);
  });

  it('stops within a chunk of the cap, not whatever the provider chose to send', async () => {
    const chunkBytes = 1024 * 1024;
    const { res, pulls } = endless(chunkBytes);
    await expect(readJson(res, 'Carta')).rejects.toThrow(IntegrationError);
    // The peak held is the budget plus the one chunk that crossed it.
    expect(pulls() * chunkBytes).toBeLessThanOrEqual(MAX_INTEGRATION_JSON_BYTES + chunkBytes);
  });

  it('refuses an honestly declared oversize before reading a byte', async () => {
    const { res, pulls } = endless();
    const declared = new Response(res.body, {
      headers: { 'content-length': String(MAX_INTEGRATION_JSON_BYTES + 1) },
    });
    await expect(readJson(declared, 'Gusto')).rejects.toThrow(/Gusto returned a response larger than/);
    // Not 0: a ReadableStream fills its one-chunk queue as soon as it is
    // constructed, before anyone reads. What matters is that nothing *we* did
    // consumed the body — a read would have run to the cap, 16 pulls away.
    expect(pulls()).toBeLessThanOrEqual(1);
  });

  it('names the provider, so the refusal reads as theirs', async () => {
    const { res } = endless();
    await expect(readJson(res, 'Rippling')).rejects.toThrow(/^Rippling /);
  });

  it('keeps a body just under the cap readable', async () => {
    // The cap is a backstop for the unbounded case, not a limit real answers
    // are meant to feel; a large-but-sane pull must still come back.
    const padding = 'x'.repeat(4 * 1024 * 1024);
    await expect(readJson(json({ pad: padding }), 'Xero')).resolves.toEqual({ pad: padding });
  });

  it('degrades an endless array body to an empty list, like every other unusable one', async () => {
    // `readJsonArray` is best-effort by contract — see the Xero /connections
    // case above. Oversize is one more body it cannot use, not a new outcome.
    const { res } = endless();
    await expect(readJsonArray(res)).resolves.toEqual([]);
  });
});
