import { describe, expect, it } from 'vitest';
import {
  exchangeCode as capTableExchangeCode,
  fetchCapTable,
  mapCarta,
  mapPulley,
  type FetchFn,
} from '../../src/clients/capTableSync.js';
import { exchangeCode as hrisExchangeCode, fetchRosterAndGrants } from '../../src/clients/hris.js';
import { exchangeCode as accountingExchangeCode } from '../../src/clients/accounting.js';
import { IntegrationError, MAX_PROVIDER_TEXT, storableProviderText } from '../../src/clients/deadline.js';
import { findUnstorableText } from '../../src/domain/nulBytes.js';

/**
 * Text a provider sends that Postgres will not store, held at the connector
 * boundary (round 259, methodology M6).
 *
 * `domain/nulBytes.ts` refuses `U+0000` and a lone surrogate on the way in, and
 * says of itself that the hook it installs guards *request* bodies. A connector
 * payload is the other kind of outside data: it arrives from a third party over
 * `fetch`, never passes that hook, and lands in the same columns — including
 * two `jsonb` ones, where these two characters are not stored wrong but
 * *refused* by the driver.
 *
 * What each refusal costs is stated at the fix sites; the two pinned below are
 * the ones a retry cannot clear:
 *
 *   - the connect event's payload, written inside `upsertConnection`'s
 *     transaction, so a bad `company_name` rolls the connection back *after*
 *     the one-time OAuth code has been spent — and does so identically on every
 *     reconnect, because the provider sends the same name; and
 *   - `recordSync`'s `last_sync_summary`, written after the pull has already
 *     been applied and outside every catch in the sync, so `next_sync_at` is
 *     never advanced, no error is recorded against the connection, and the
 *     sweep re-pulls and re-applies the same payload every fifteen minutes
 *     under a card that reads as healthy.
 */

const creds = { clientId: 'id', clientSecret: 'secret' };
const NUL = '\u0000';
const LONE_SURROGATE = '\uD800';

const stub = (body: unknown, status = 200): FetchFn =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as FetchFn;

describe('storableProviderText', () => {
  it('refuses the two characters the driver refuses, whatever the column', () => {
    expect(storableProviderText(`Acme${NUL} Ltd`)).toBeNull();
    expect(storableProviderText(`Acme${LONE_SURROGATE} Ltd`)).toBeNull();
  });

  it('refuses a non-string rather than stringifying it', () => {
    expect(storableProviderText({ name: 'Acme' })).toBeNull();
    expect(storableProviderText(['Acme'])).toBeNull();
    expect(storableProviderText(42)).toBeNull();
    expect(storableProviderText(null)).toBeNull();
  });

  it('refuses an over-long value rather than truncating it', () => {
    expect(storableProviderText('a'.repeat(MAX_PROVIDER_TEXT))).toHaveLength(MAX_PROVIDER_TEXT);
    expect(storableProviderText('a'.repeat(MAX_PROVIDER_TEXT + 1))).toBeNull();
  });

  it('trims, and reads a blank as absent', () => {
    expect(storableProviderText('  Acme Ltd  ')).toBe('Acme Ltd');
    expect(storableProviderText('   ')).toBeNull();
  });

  it('keeps an ordinary name, astral characters included', () => {
    expect(storableProviderText('Acme \u{1F680} Ltd')).toBe('Acme \u{1F680} Ltd');
  });
});

describe('connector token exchange', () => {
  it('does not carry an unstorable company name onto a cap-table connection', async () => {
    const tokens = await capTableExchangeCode(
      'carta',
      creds,
      'https://n409.test/cb',
      'code',
      stub({ access_token: 'at', company_id: `c-1${NUL}`, company_name: `Acme${LONE_SURROGATE}` }),
    );
    expect(tokens.externalCompanyId).toBeNull();
    expect(tokens.externalCompanyName).toBeNull();
  });

  it('does not carry a non-string company name onto a cap-table connection', async () => {
    const tokens = await capTableExchangeCode(
      'pulley',
      creds,
      'https://n409.test/cb',
      'code',
      stub({ access_token: 'at', company_name: { legalName: 'Acme' } }),
    );
    // `[object Object]` in the column an analyst reads as the company they
    // connected is the alternative this refuses.
    expect(tokens.externalCompanyName).toBeNull();
  });

  it('does not carry an unstorable company name onto an HRIS connection', async () => {
    const tokens = await hrisExchangeCode(
      'gusto',
      creds,
      'https://n409.test/cb',
      'code',
      stub({ access_token: 'at', company_name: `Acme${LONE_SURROGATE}` }),
    );
    expect(tokens.externalCompanyName).toBeNull();
  });

  it('does not carry an unstorable Xero tenant name onto an accounting connection', async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/connections')
        ? [{ tenantId: 't-1', tenantName: `Acme${NUL} Ltd` }]
        : { access_token: 'at' };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as FetchFn;
    const tokens = await accountingExchangeCode('xero', creds, 'https://n409.test/cb', 'code', fetchFn);
    expect(tokens.externalOrgId).toBe('t-1');
    expect(tokens.externalOrgName).toBeNull();
  });
});

describe('cap-table pull', () => {
  it('keeps an unstorable company name and as-of out of the sync summary', async () => {
    const pulled = await fetchCapTable(
      'carta',
      { accessToken: 'at', externalCompanyId: 'c-1', externalCompanyName: 'Acme Ltd' },
      stub({
        companyName: `Acme${NUL} Ltd`,
        asOf: `2026-08-31${LONE_SURROGATE}`,
        shareClasses: [{ name: 'Common', type: 'common', outstandingShares: 100 }],
      }),
    );
    // The name already on the connection stands in for the one that could not
    // be read, rather than the summary write being refused after the cap table
    // has already been saved.
    expect(pulled.external_company_name).toBe('Acme Ltd');
    expect(pulled.as_of).toBeNull();
    expect(findUnstorableText(pulled)).toBeNull();
  });

  it('refuses a share class whose name cannot be stored, naming the provider', () => {
    expect(() => mapCarta({ shareClasses: [{ name: `Series ${NUL}A`, outstandingShares: 100 }] })).toThrow(
      IntegrationError,
    );
    expect(() =>
      mapPulley({ securities: [{ shareClass: `Series ${LONE_SURROGATE}A`, sharesOutstanding: 100 }] }),
    ).toThrow(/Pulley returned a security whose name cannot be stored/);
  });

  it('leaves an ordinary payload alone', () => {
    const entries = mapCarta({
      shareClasses: [{ name: 'Series A \u{1F680}', type: 'preferred', outstandingShares: 100 }],
    });
    expect(entries[0]?.security_class).toBe('Series A \u{1F680}');
  });
});

describe('HRIS pull', () => {
  it('keeps an unstorable company name out of the sync summary', async () => {
    const pull = await fetchRosterAndGrants(
      'rippling',
      { accessToken: 'at', externalCompanyId: 'c-1', externalCompanyName: null },
      stub({ companyName: `Acme${LONE_SURROGATE}`, employees: [] }),
    );
    expect(pull.external_company_name).toBeNull();
  });
});
