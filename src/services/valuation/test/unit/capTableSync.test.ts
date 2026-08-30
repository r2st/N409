import { describe, it, expect } from 'vitest';
import {
  authorizeUrl,
  exchangeCode,
  fetchCapTable,
  mapCarta,
  mapPulley,
  CAP_TABLE_PROVIDERS,
  CAP_TABLE_PROVIDER_LABELS,
  type CapTableProvider,
  type FetchFn,
} from '../../src/clients/capTableSync.js';
import { diffCapTables } from '../../src/domain/capTableSync.js';
import { validateCapTable } from '../../src/domain/capTable.js';
import type { CapTableEntry } from '../../src/domain/capTable.js';

const creds = { clientId: 'client-abc', clientSecret: 'secret-xyz' };

/** A fetch double that records its call and answers with a canned Response. */
function stubFetch(make: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fn: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return make(String(input), init);
  }) as FetchFn;
  return { fn, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('provider cap-table mapping', () => {
  it('maps a Carta payload including options, warrants and convertibles', () => {
    const entries = mapCarta({
      shareClasses: [
        { name: 'Common', type: 'common', outstandingShares: 8_000_000, issuePrice: 0.001 },
        {
          name: 'Series A',
          type: 'preferred',
          outstandingShares: 2_000_000,
          issuePrice: 1.5,
          amountInvested: 3_000_000,
          liquidationPreference: 1,
          seniority: 1,
          conversionRatio: 1,
        },
      ],
      optionPools: [{ name: 'Option Pool', outstandingShares: 1_000_000, strikePrice: 0.5 }],
      warrants: [{ name: 'Warrants', shares: 100_000, strikePrice: 1 }],
      convertibles: [{ name: 'SAFE 2023', principal: 500_000, liquidationMultiple: 1 }],
    });
    const byName = Object.fromEntries(entries.map((e) => [e.security_class, e]));
    expect(byName['Common']!.class_type).toBe('common');
    expect(byName['Common']!.shares).toBe(8_000_000);
    expect(byName['Series A']!.class_type).toBe('preferred');
    expect(byName['Series A']!.invested_amount).toBe(3_000_000);
    expect(byName['Option Pool']!.class_type).toBe('option');
    expect(byName['Warrants']!.class_type).toBe('warrant');
    // Convertible note becomes a preference-bearing preferred row.
    expect(byName['SAFE 2023']!.class_type).toBe('preferred');
    expect(byName['SAFE 2023']!.invested_amount).toBe(500_000);
    expect(byName['SAFE 2023']!.liquidation_multiple).toBe(1);
  });

  it('maps a Pulley payload with securities + convertibles', () => {
    const entries = mapPulley({
      securities: [
        { shareClass: 'Common', securityType: 'common', sharesOutstanding: 5_000_000 },
        {
          shareClass: 'Seed Preferred',
          securityType: 'preferred',
          sharesOutstanding: 1_500_000,
          totalInvested: 2_000_000,
          liquidationMultiple: 1,
        },
        { shareClass: 'ESOP', securityType: 'option', sharesOutstanding: 750_000 },
      ],
      convertibles: [{ name: 'Note 2024', principal: 250_000 }],
    });
    const byName = Object.fromEntries(entries.map((e) => [e.security_class, e]));
    expect(byName['Common']!.shares).toBe(5_000_000);
    expect(byName['Seed Preferred']!.invested_amount).toBe(2_000_000);
    expect(byName['ESOP']!.class_type).toBe('option');
    expect(byName['Note 2024']!.class_type).toBe('preferred');
  });

  /*
   * Every field above is read through a `??` chain because the two providers
   * spell the same figure differently across API versions — Carta's
   * `outstandingShares` is `shares` on an older payload, `issuePrice` is
   * `pricePerShare`. The first spelling was the only one under test, so the
   * fallback arm of each chain was carrying a cap table nobody had ever mapped.
   */
  it('reads the alternate Carta spelling of every field', () => {
    const [common, series] = mapCarta({
      shareClasses: [
        { className: 'Common', classType: 'common', shares: 6_000_000, pricePerShare: 0.002 },
        {
          className: 'Series Seed',
          classType: 'preferred',
          shares: 1_000_000,
          pricePerShare: 2,
          invested: 2_000_000,
          liquidationMultiple: 1.5,
        },
      ],
    });
    expect(common!.security_class).toBe('Common');
    expect(common!.shares).toBe(6_000_000);
    expect(common!.price_per_share).toBe(0.002);
    expect(series!.invested_amount).toBe(2_000_000);
    expect(series!.liquidation_multiple).toBe(1.5);
  });

  it('skips a Carta share class with no name rather than emitting a blank row', () => {
    // A blank security_class would collide with every other blank one in the
    // diff, which keys on the trimmed name.
    const entries = mapCarta({
      shareClasses: [{ name: '   ', shares: 1000 }, { name: 'Common', shares: 2000 }, { shares: 3000 }],
    });
    expect(entries.map((e) => e.security_class)).toEqual(['Common']);
  });

  it('names an unnamed Carta pool, warrant and convertible', () => {
    const entries = mapCarta({
      optionPools: [{ reservedShares: 900_000, exercisePrice: 0.25 }],
      warrants: [{ outstandingShares: 50_000, exercisePrice: 1.25 }],
      convertibles: [{ amount: 400_000 }],
    });
    expect(entries.map((e) => e.security_class)).toEqual(['Option Pool', 'Warrants', 'Convertible Note']);
    expect(entries[0]!.shares).toBe(900_000);
    expect(entries[0]!.price_per_share).toBe(0.25);
    expect(entries[1]!.shares).toBe(50_000);
    expect(entries[1]!.price_per_share).toBe(1.25);
    expect(entries[2]!.invested_amount).toBe(400_000);
    // A note with no stated multiple still sits in the preference stack at 1×.
    expect(entries[2]!.liquidation_multiple).toBe(1);
  });

  it('defaults every absent Carta quantity to zero rather than NaN', () => {
    const entries = mapCarta({
      shareClasses: [{ name: 'Common' }],
      optionPools: [{}],
      warrants: [{}],
      convertibles: [{}],
    });
    expect(entries.map((e) => e.shares)).toEqual([0, 0, 0, 0]);
    expect(entries[0]!.price_per_share).toBeNull();
  });

  it('maps an empty Carta payload to no entries', () => {
    expect(mapCarta({})).toEqual([]);
  });

  it('reads the alternate Pulley spelling of every field', () => {
    const [row] = mapPulley({
      securities: [
        {
          name: 'Series A',
          type: 'preferred',
          shares: 2_000_000,
          issuePrice: 1.75,
          invested: 3_500_000,
          liquidationPreference: 2,
          seniority: 1,
          conversionRatio: 1,
        },
      ],
    });
    expect(row!.security_class).toBe('Series A');
    expect(row!.shares).toBe(2_000_000);
    expect(row!.price_per_share).toBe(1.75);
    expect(row!.invested_amount).toBe(3_500_000);
    expect(row!.liquidation_multiple).toBe(2);
  });

  it('falls back to the Pulley strike price for an option grant', () => {
    const [row] = mapPulley({ securities: [{ name: 'ESOP', type: 'option', strikePrice: 0.4 }] });
    expect(row!.price_per_share).toBe(0.4);
  });

  it('skips a Pulley security with no class name', () => {
    const entries = mapPulley({ securities: [{ shares: 100 }, { shareClass: 'Common', shares: 200 }] });
    expect(entries.map((e) => e.security_class)).toEqual(['Common']);
  });

  it('names an unnamed Pulley convertible and defaults its multiple', () => {
    const [row] = mapPulley({ convertibles: [{ amount: 150_000 }] });
    expect(row!.security_class).toBe('Convertible');
    expect(row!.liquidation_multiple).toBe(1);
    expect(row!.shares).toBe(0);
  });

  it('maps an empty Pulley payload to no entries', () => {
    expect(mapPulley({})).toEqual([]);
  });

  /*
   * `class_type` drives the waterfall: an option pool graded as common is paid
   * as common, and a note graded as common loses its preference entirely. The
   * classifier reads the declared type first and the class name second, which
   * is what makes a provider's free-text label survivable.
   */
  describe('security type classification', () => {
    const typed = (securityType: unknown, name = 'Whatever') =>
      mapPulley({ securities: [{ shareClass: name, securityType }] })[0]!.class_type;

    it('takes a declared canonical type verbatim', () => {
      expect(typed('common')).toBe('common');
      expect(typed('preferred')).toBe('preferred');
      expect(typed('option')).toBe('option');
      expect(typed('warrant')).toBe('warrant');
      expect(typed('PREFERRED')).toBe('preferred'); // case-insensitive
    });

    it('reads an option out of the type or, failing that, the class name', () => {
      expect(typed('ISO')).toBe('option');
      expect(typed('nso')).toBe('option');
      expect(typed('equity', 'Employee Option Pool 2024')).toBe('option');
    });

    it('grades a warrant-ish type as a warrant and a note-ish one as preferred', () => {
      expect(typed('warrant_coverage')).toBe('warrant');
      expect(typed('convertible_note', 'Bridge')).toBe('preferred');
      expect(typed('equity', 'SAFE 2025')).toBe('preferred');
    });

    it('reads a priced round out of the class name alone', () => {
      expect(typed('equity', 'Series B')).toBe('preferred');
      expect(typed('equity', 'Seed Round')).toBe('preferred');
    });

    it('falls back to common for an unrecognised or absent type', () => {
      expect(typed('restricted', 'RSU Grant')).toBe('common');
      expect(typed(undefined, 'Founders')).toBe('common');
      expect(typed(null, 'Founders')).toBe('common');
    });
  });

  /*
   * Providers send money as formatted strings at least as often as numbers —
   * `"$1,250,000"` in a CSV-backed export. Number("$1,250,000") is NaN, and a
   * NaN invested_amount silently zeroes a preference in the waterfall.
   */
  it('parses a currency-formatted string amount', () => {
    const [row] = mapPulley({
      securities: [{ shareClass: 'Series A', sharesOutstanding: '2,000,000', totalInvested: '$3,500,000 ' }],
    });
    expect(row!.shares).toBe(2_000_000);
    expect(row!.invested_amount).toBe(3_500_000);
  });

  it('nulls a non-numeric value instead of propagating NaN', () => {
    const [row] = mapPulley({
      securities: [
        { shareClass: 'Common', sharesOutstanding: 'unknown', pricePerShare: true, seniority: {} },
      ],
    });
    expect(row!.shares).toBe(0);
    expect(row!.price_per_share).toBeNull();
    expect(row!.seniority).toBeNull();
  });
});

/**
 * The provider payload, shaped to break the mapper.
 *
 * `readJson` refuses a body that is not an object, and that is where the shape
 * checking stopped: `securities`, `shareClasses` and every row and cell inside
 * them were asserted by a compile-time cast and read unguarded. Three outcomes
 * were reachable from a body that parses as JSON — a `TypeError` whose message
 * was then published on the connection's page as the provider's own failure, a
 * share class named `[object Object]`, and a share count that read as zero and
 * validated clean.
 *
 * The bar is the same as the CSV importer's: it must not crash, and it must not
 * answer with a number.
 */
describe('adversarial provider payloads', () => {
  it('refuses a collection that is not a list rather than failing to iterate it', () => {
    expect(() => mapPulley({ securities: { 'series-a': { shareClass: 'Series A' } } })).toThrow(
      'Pulley returned a "securities" list that is not a list',
    );
    expect(() => mapCarta({ shareClasses: 'Common' })).toThrow(
      'Carta returned a "shareClasses" list that is not a list',
    );
    expect(() => mapCarta({ convertibles: 3 })).toThrow('Carta returned a "convertibles" list');
  });

  it('refuses a row that is not a security rather than reading fields off it', () => {
    expect(() => mapPulley({ securities: [{ shareClass: 'Common' }, null] })).toThrow(
      'Pulley returned a "securities" entry that is not a security',
    );
    expect(() => mapCarta({ optionPools: [['Option Pool', 1_000_000]] })).toThrow(
      'Carta returned a "optionPools" entry that is not a security',
    );
    expect(() => mapCarta({ warrants: ['Warrants'] })).toThrow('Carta returned a "warrants" entry');
  });

  it('still reads a collection the provider omitted or sent empty', () => {
    expect(mapPulley({ securities: null, convertibles: [] })).toEqual([]);
    expect(mapCarta({})).toEqual([]);
  });

  /*
   * The quiet one. `String({})` is `"[object Object]"` — a name, as far as
   * every reader downstream is concerned, and one that reaches the waterfall,
   * the exhibits and the PDF. Treating it as *absent* is no better: these
   * mappers skip an unnamed security on purpose, so that silently takes the
   * row's shares out of the fully-diluted count.
   */
  it('refuses a class name that is an object rather than minting one from it', () => {
    expect(() => mapPulley({ securities: [{ shareClass: { id: 7 }, sharesOutstanding: 100 }] })).toThrow(
      'Pulley returned a security whose name is not text',
    );
    expect(() => mapCarta({ shareClasses: [{ name: ['Series A', 'Series B'] }] })).toThrow(
      'Carta returned a share class whose name is not text',
    );
    expect(() => mapCarta({ convertibles: [{ name: {} }] })).toThrow(
      'Carta returned a convertible whose name is not text',
    );
  });

  it('accepts a numeric class name, which a provider keyed by round number sends', () => {
    const [row] = mapPulley({ securities: [{ shareClass: 2021, sharesOutstanding: 5 }] });
    expect(row!.security_class).toBe('2021');
  });

  /*
   * `"2,000,000 sh"` is a real administrator's real formatting, and `toNum`
   * cannot read it. Every call site ended `?? 0` or `?? 1`, so it imported as
   * zero shares against a table that `validateCapTable` then called valid —
   * and a scheduled sync applies a valid pull with no person in the loop.
   */
  it('records a figure it could not read rather than importing the default', () => {
    const [row] = mapPulley({
      securities: [
        { shareClass: 'Series A', sharesOutstanding: '2,000,000 sh', liquidationMultiple: 'one times' },
      ],
    });
    expect(row!.shares).toBe(0);
    expect(row!.unreadable_numbers).toEqual({
      shares: '2,000,000 sh',
      liquidation_multiple: 'one times',
    });
  });

  it('makes an unreadable figure an error, so the pull is not applied', () => {
    const entries = mapPulley({
      securities: [
        { shareClass: 'Common', securityType: 'common', sharesOutstanding: 8_000_000 },
        { shareClass: 'Series A', securityType: 'preferred', sharesOutstanding: '2,000,000 sh' },
      ],
    });
    const validation = validateCapTable(entries);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'unreadable_number' }),
    );
  });

  it('names an unreadable object or list without stringifying it into the message', () => {
    const [row] = mapPulley({
      securities: [{ shareClass: 'Common', sharesOutstanding: { value: 5 }, pricePerShare: [1, 2] }],
    });
    expect(row!.unreadable_numbers).toEqual({ shares: 'an object', price_per_share: 'a list' });
  });

  it('caps the text it quotes back, so a long value does not become the issue', () => {
    const [row] = mapPulley({
      securities: [{ shareClass: 'Common', sharesOutstanding: 'x'.repeat(5_000) }],
    });
    expect(row!.unreadable_numbers!.shares!.length).toBeLessThan(200);
  });

  /*
   * A cell that says "no figure" is not a cell that failed to read — the CSV
   * reader has drawn that line since `unreadable_numbers` was added, and the
   * two paths must draw it the same way or the same export imports differently
   * depending on which door it came through.
   */
  it('reads the spellings of "no figure" as an absent figure, and tries the next spelling', () => {
    const [row] = mapCarta({
      shareClasses: [
        { name: 'Series A', outstandingShares: 100, issuePrice: 'N/A', amountInvested: '#DIV/0!' },
      ],
    });
    expect(row!.price_per_share).toBeNull();
    expect(row!.invested_amount).toBeNull();
    expect(row!.unreadable_numbers).toBeUndefined();

    const [alt] = mapCarta({
      shareClasses: [{ name: 'Series B', outstandingShares: 1, issuePrice: '-', pricePerShare: 2.5 }],
    });
    expect(alt!.price_per_share).toBe(2.5);
  });

  it('reports no company name or date when the provider sends an object for one', async () => {
    const { fn } = stubFetch(() =>
      json({ companyName: { legal: 'Acme' }, asOf: { date: '2026-01-01' }, securities: [] }),
    );
    const pulled = await fetchCapTable(
      'pulley',
      { accessToken: 't', externalCompanyId: null, externalCompanyName: null },
      fn,
    );
    expect(pulled.external_company_name).toBeNull();
    expect(pulled.as_of).toBeNull();
  });

  it('falls back to the connection name when the payload names the company with an object', async () => {
    const { fn } = stubFetch(() => json({ companyName: 42, securities: [] }));
    const pulled = await fetchCapTable(
      'carta',
      { accessToken: 't', externalCompanyId: 'c1', externalCompanyName: 'Acme, Inc.' },
      fn,
    );
    expect(pulled.external_company_name).toBe('Acme, Inc.');
  });

  /*
   * The whole point of using `IntegrationError` rather than letting a
   * `TypeError` out: the sync route forwards the message of one and answers a
   * constant for anything else, and `recordSyncError` writes the message of
   * whatever was thrown to a column served to the analyst verbatim.
   */
  it('raises a provider-attributable failure, not a TypeError, out of the pull', async () => {
    const { fn } = stubFetch(() => json({ securities: [null] }));
    await expect(
      fetchCapTable('pulley', { accessToken: 't', externalCompanyId: null, externalCompanyName: null }, fn),
    ).rejects.toMatchObject({ name: 'IntegrationError' });
  });
});

describe('provider OAuth', () => {
  it('exposes a label for every provider', () => {
    expect(CAP_TABLE_PROVIDERS).toEqual(['carta', 'pulley']);
    for (const p of CAP_TABLE_PROVIDERS) expect(CAP_TABLE_PROVIDER_LABELS[p]).toBeTruthy();
  });

  it.each<[CapTableProvider, string]>([
    ['carta', 'https://login.carta.com/oauth/authorize'],
    ['pulley', 'https://app.pulley.com/oauth/authorize'],
  ])('builds the %s authorize URL with the state and offline scope', (provider, base) => {
    const url = new URL(authorizeUrl(provider, creds, 'https://app.n409.test/cb', 'state-123'));
    expect(`${url.origin}${url.pathname}`).toBe(base);
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.n409.test/cb');
    expect(url.searchParams.get('state')).toBe('state-123');
    // Without offline_access the refresh token never arrives and the
    // connection dies silently at the first token expiry.
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('exchanges a code for a full token set', async () => {
    const { fn, calls } = stubFetch(() =>
      json({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        company_id: 'co-1',
        company_name: 'Northwind Robotics',
      }),
    );
    const before = Date.now();
    const tokens = await exchangeCode('carta', creds, 'https://app.n409.test/cb', 'code-1', fn);
    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.externalCompanyId).toBe('co-1');
    expect(tokens.externalCompanyName).toBe('Northwind Robotics');
    expect(tokens.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);

    expect(calls[0]!.url).toBe('https://login.carta.com/oauth/token');
    const body = new URLSearchParams(String(calls[0]!.init!.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_secret')).toBe('secret-xyz');
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('leaves the optional token fields null when the provider omits them', async () => {
    const { fn } = stubFetch(() => json({ access_token: 'at-2' }));
    const tokens = await exchangeCode('pulley', creds, 'https://app.n409.test/cb', 'code-2', fn);
    expect(tokens).toEqual({
      accessToken: 'at-2',
      refreshToken: null,
      expiresAt: null,
      externalCompanyId: null,
      externalCompanyName: null,
    });
  });

  it('names the provider when the token exchange is rejected', async () => {
    const { fn } = stubFetch(() => json({ error: 'invalid_grant' }, 400));
    await expect(exchangeCode('carta', creds, 'cb', 'bad', fn)).rejects.toThrow(
      'Carta token exchange failed (400)',
    );
  });

  it('rejects a 200 that carries no access token', async () => {
    const { fn } = stubFetch(() => json({ token_type: 'bearer' }));
    await expect(exchangeCode('pulley', creds, 'cb', 'code', fn)).rejects.toThrow(
      'Pulley returned no access token',
    );
  });

  it('names the provider when a 200 is not JSON at all', async () => {
    // A gateway serving an HTML error page under a 200 — the parser's own
    // wording would reach the analyst otherwise.
    const { fn } = stubFetch(() => new Response('<html>502</html>', { status: 200 }));
    await expect(exchangeCode('carta', creds, 'cb', 'code', fn)).rejects.toThrow(
      'Carta returned a non-JSON response',
    );
  });
});

describe('provider cap-table pull', () => {
  const tokens = { accessToken: 'at-1', externalCompanyId: 'co-1', externalCompanyName: 'On File Inc' };

  it('pulls and maps a Carta capitalization', async () => {
    const { fn, calls } = stubFetch(() =>
      json({
        companyName: 'Northwind Robotics',
        asOf: '2026-06-30',
        shareClasses: [{ name: 'Common', type: 'common', outstandingShares: 8_000_000 }],
      }),
    );
    const pulled = await fetchCapTable('carta', tokens, fn);
    expect(calls[0]!.url).toBe('https://api.carta.com/v1/companies/co-1/capitalization');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer at-1');
    expect(pulled.provider).toBe('carta');
    expect(pulled.external_company_name).toBe('Northwind Robotics');
    expect(pulled.as_of).toBe('2026-06-30');
    expect(pulled.entries).toHaveLength(1);
  });

  it('pulls the Pulley cap-table endpoint and accepts its snake_case as_of', async () => {
    const { fn, calls } = stubFetch(() =>
      json({ as_of: '2026-03-31', securities: [{ shareClass: 'Common', sharesOutstanding: 100 }] }),
    );
    const pulled = await fetchCapTable('pulley', tokens, fn);
    expect(calls[0]!.url).toBe('https://api.pulley.com/v1/companies/co-1/cap-table');
    expect(pulled.as_of).toBe('2026-03-31');
    expect(pulled.entries[0]!.shares).toBe(100);
  });

  it('keeps the name from the connection when the payload states none', async () => {
    const { fn } = stubFetch(() => json({ shareClasses: [] }));
    const pulled = await fetchCapTable('carta', tokens, fn);
    expect(pulled.external_company_name).toBe('On File Inc');
    expect(pulled.as_of).toBeNull();
  });

  it('reports no company name when neither the payload nor the connection has one', async () => {
    const { fn } = stubFetch(() => json({}));
    const pulled = await fetchCapTable(
      'pulley',
      { accessToken: 'at', externalCompanyId: 'co', externalCompanyName: null },
      fn,
    );
    expect(pulled.external_company_name).toBeNull();
    expect(pulled.entries).toEqual([]);
  });

  it('percent-encodes an external company id into the path', async () => {
    const { fn, calls } = stubFetch(() => json({}));
    await fetchCapTable('carta', { ...tokens, externalCompanyId: 'co/1 2' }, fn);
    expect(calls[0]!.url).toBe('https://api.carta.com/v1/companies/co%2F1%202/capitalization');
  });

  it('still calls the endpoint when no company id was recorded', async () => {
    const { fn, calls } = stubFetch(() => json({}));
    await fetchCapTable('carta', { ...tokens, externalCompanyId: null }, fn);
    expect(calls[0]!.url).toBe('https://api.carta.com/v1/companies//capitalization');
  });

  it('names the provider when the pull is rejected', async () => {
    const { fn } = stubFetch(() => json({ error: 'forbidden' }, 403));
    await expect(fetchCapTable('pulley', tokens, fn)).rejects.toThrow('Pulley cap-table fetch failed (403)');
  });

  it('rejects a payload that is a bare array rather than an object', async () => {
    // `as` casts are compile-time only; an array here would reach
    // `payload.companyName` as undefined and map to a silently empty table.
    const { fn } = stubFetch(() => json([{ name: 'Common' }]));
    await expect(fetchCapTable('carta', tokens, fn)).rejects.toThrow(
      'Carta returned an unexpected response body',
    );
  });

  it('names the provider when the pull stalls past its deadline', async () => {
    const { fn } = stubFetch(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    await expect(fetchCapTable('carta', tokens, fn)).rejects.toThrow('Carta did not respond within 30s');
  });
});

const entry = (over: Partial<CapTableEntry> & { security_class: string }): CapTableEntry => ({
  security_class: over.security_class,
  class_type: over.class_type ?? 'common',
  shares: over.shares ?? 0,
  price_per_share: over.price_per_share ?? null,
  invested_amount: over.invested_amount ?? null,
  liquidation_multiple: over.liquidation_multiple ?? null,
  seniority: over.seniority ?? null,
  conversion_ratio: over.conversion_ratio ?? null,
});

describe('cap-table diff', () => {
  it('reports no conflicts for identical tables', () => {
    const a = [entry({ security_class: 'Common', shares: 1000 })];
    const diff = diffCapTables(a, [entry({ security_class: 'Common', shares: 1000 })]);
    expect(diff.has_conflicts).toBe(false);
  });

  it('detects changed, added and removed classes', () => {
    const existing = [
      entry({ security_class: 'Common', shares: 1000 }),
      entry({ security_class: 'Series A', class_type: 'preferred', shares: 500 }),
    ];
    const incoming = [
      entry({ security_class: 'Common', shares: 1200 }), // changed
      entry({ security_class: 'Series B', class_type: 'preferred', shares: 300 }), // added
      // Series A removed
    ];
    const diff = diffCapTables(existing, incoming);
    expect(diff.changed).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    const common = diff.conflicts.find((c) => c.security_class === 'Common')!;
    expect(common.status).toBe('changed');
    expect(common.changes).toContainEqual({ field: 'shares', from: 1000, to: 1200 });
  });

  it('matches class names case-insensitively', () => {
    const diff = diffCapTables(
      [entry({ security_class: 'common', shares: 1000 })],
      [entry({ security_class: 'Common', shares: 1000 })],
    );
    expect(diff.has_conflicts).toBe(false);
  });

  /*
   * Most of the numeric fields are null on a hand-entered table and populated
   * by the pull (or the reverse). "Both unset" and "one unset" are the two
   * cases the analyst actually meets, and they must not read the same.
   */
  it('treats a field unset on both sides as unchanged', () => {
    const diff = diffCapTables(
      [entry({ security_class: 'Common', shares: 1000 })],
      [entry({ security_class: 'Common', shares: 1000 })],
    );
    expect(diff.conflicts).toEqual([]);
  });

  it('reports a field that gained or lost a value', () => {
    const diff = diffCapTables(
      [entry({ security_class: 'Series A', shares: 500, price_per_share: null, seniority: 1 })],
      [entry({ security_class: 'Series A', shares: 500, price_per_share: 1.5, seniority: null })],
    );
    const changed = diff.conflicts[0]!;
    expect(changed.status).toBe('changed');
    expect(changed.changes).toContainEqual({ field: 'price_per_share', from: null, to: 1.5 });
    expect(changed.changes).toContainEqual({ field: 'seniority', from: 1, to: null });
  });

  it('ignores a difference below the rounding tolerance', () => {
    const diff = diffCapTables(
      [entry({ security_class: 'Common', shares: 1000 })],
      [entry({ security_class: 'Common', shares: 1000.0000001 })],
    );
    expect(diff.has_conflicts).toBe(false);
  });

  it('reports a reclassified security even when every number matches', () => {
    const diff = diffCapTables(
      [entry({ security_class: 'Bridge', class_type: 'common', shares: 100 })],
      [entry({ security_class: 'Bridge', class_type: 'preferred', shares: 100 })],
    );
    expect(diff.conflicts[0]!.changes).toEqual([{ field: 'class_type', from: 'common', to: 'preferred' }]);
  });

  it('reports two empty tables as no conflict at all', () => {
    expect(diffCapTables([], [])).toEqual({
      conflicts: [],
      has_conflicts: false,
      added: 0,
      removed: 0,
      changed: 0,
    });
  });
});
