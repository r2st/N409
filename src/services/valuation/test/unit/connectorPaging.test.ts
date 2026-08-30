import { describe, expect, it } from 'vitest';
import { fetchRosterAndGrants, type FetchFn } from '../../src/clients/hris.js';
import { fetchCapTable } from '../../src/clients/capTableSync.js';
import {
  IntegrationError,
  MAX_PROVIDER_PAGES,
  nextPageUrl,
  providerSaysMore,
} from '../../src/clients/deadline.js';

/**
 * A provider's employee list that did not fit in one request (round 259,
 * methodology M6).
 *
 * `fetchRosterAndGrants` asked once and mapped the answer. All three of these
 * APIs page, at defaults in the tens, so a company past that default imported a
 * *prefix* of its employees — and every figure downstream reported it with the
 * wording it uses for a complete pull: `roster_count`, `grants_found`, and an
 * ASC 718 expense struck over the options it happened to have seen.
 *
 * Nothing distinguished "40 employees" from "the first 40 of 180", which is
 * what makes it worth a refusal rather than a `truncated` flag: the estate uses
 * that flag for display lists, and this is the population an accounting figure
 * is struck over.
 */

const tokens = { accessToken: 'at', externalCompanyId: 'c-1', externalCompanyName: null };

/** A fetch double that answers each URL from a script and records the order. */
function paged(pages: Record<string, unknown>[]): { fn: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const body = pages[urls.length - 1] ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as FetchFn;
  return { fn, urls };
}

const employee = (id: string) => ({
  id,
  fullName: `Person ${id}`,
  equityGrants: [{ id: `g-${id}`, shares: 1000, grantDate: '2026-01-01', strikePrice: 1 }],
});

describe('nextPageUrl', () => {
  it('follows an absolute link on the provider own API host', () => {
    expect(nextPageUrl({ next: 'https://api.gusto.com/v1/employees?page=2' }, 'https://api.gusto.com')).toBe(
      'https://api.gusto.com/v1/employees?page=2',
    );
    expect(nextPageUrl({ links: { next: 'https://api.gusto.com/v1/e?p=2' } }, 'https://api.gusto.com')).toBe(
      'https://api.gusto.com/v1/e?p=2',
    );
  });

  it('refuses to follow a link to another host', () => {
    // The request that follows it carries this engagement's bearer token, so a
    // `next` pointing elsewhere is a credential handed to whoever wrote the
    // payload.
    expect(nextPageUrl({ next: 'https://evil.example/v1/employees' }, 'https://api.gusto.com')).toBeNull();
    expect(nextPageUrl({ next: 'http://api.gusto.com/v1/e' }, 'https://api.gusto.com')).toBeNull();
  });

  it('leaves a relative link unfollowed rather than guessing how to resolve it', () => {
    expect(nextPageUrl({ next: '/v1/employees?page=2' }, 'https://api.gusto.com')).toBeNull();
  });

  it('reads an absent or finished page as absent', () => {
    expect(nextPageUrl({ next: null }, 'https://api.gusto.com')).toBeNull();
    expect(nextPageUrl({ next: '' }, 'https://api.gusto.com')).toBeNull();
    expect(nextPageUrl({}, 'https://api.gusto.com')).toBeNull();
  });
});

describe('providerSaysMore', () => {
  it('reads the flags and cursors that mean there is another page', () => {
    expect(providerSaysMore({ has_more: true })).toBe('has_more');
    expect(providerSaysMore({ meta: { next_cursor: 'abc' } })).toBe('next_cursor');
    expect(providerSaysMore({ pagination: { hasMore: true } })).toBe('hasMore');
  });

  it('reads a finished page as finished', () => {
    expect(providerSaysMore({ has_more: false, next_cursor: null, employees: [] })).toBeNull();
    expect(providerSaysMore({ meta: { next_cursor: '' } })).toBeNull();
    expect(providerSaysMore({ employees: [{ id: '1' }] })).toBeNull();
  });
});

describe('fetchRosterAndGrants paging', () => {
  it('reads one page when the provider says there is only one', async () => {
    const { fn, urls } = paged([{ companyName: 'Acme', employees: [employee('1')] }]);
    const pull = await fetchRosterAndGrants('gusto', tokens, fn);
    expect(urls).toHaveLength(1);
    expect(pull.roster).toHaveLength(1);
    expect(pull.external_company_name).toBe('Acme');
  });

  it('follows the provider links and merges every page', async () => {
    const { fn, urls } = paged([
      {
        companyName: 'Acme',
        employees: [employee('1'), employee('2')],
        links: { next: 'https://api.gusto.com/v1/employees?page=2' },
      },
      { employees: [employee('3')], next: 'https://api.gusto.com/v1/employees?page=3' },
      { employees: [employee('4')] },
    ]);
    const pull = await fetchRosterAndGrants('gusto', tokens, fn);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toBe('https://api.gusto.com/v1/employees?page=2');
    expect(pull.roster.map((r) => r.external_id)).toEqual(['1', '2', '3', '4']);
    expect(pull.grants).toHaveLength(4);
    // Named on the first page only, which is the ordinary shape of a cursor
    // walk.
    expect(pull.external_company_name).toBe('Acme');
  });

  it('refuses a roster that continues in a spelling it cannot follow', async () => {
    const page = { employees: [employee('1')], meta: { next_cursor: 'eyJpZCI6MX0' } };
    const first = paged([page]);
    await expect(fetchRosterAndGrants('rippling', tokens, first.fn)).rejects.toThrow(IntegrationError);
    await expect(fetchRosterAndGrants('rippling', tokens, paged([page]).fn)).rejects.toThrow(
      /continues past this page \("next_cursor"\)/,
    );
    // Refused rather than reported: `roster_count` is read as the company, and
    // the grants under it become an ASC 718 expense. One request, not a walk.
    expect(first.urls).toHaveLength(1);
  });

  it('refuses a provider that never stops paging', async () => {
    const { fn, urls } = paged(
      Array.from({ length: MAX_PROVIDER_PAGES + 2 }, () => ({
        employees: [employee('x')],
        next: 'https://api.letsdeel.com/v1/employees?page=n',
      })),
    );
    await expect(fetchRosterAndGrants('deel', tokens, fn)).rejects.toThrow(
      new RegExp(`after ${MAX_PROVIDER_PAGES} pages`),
    );
    expect(urls).toHaveLength(MAX_PROVIDER_PAGES);
  });
});

describe('fetchCapTable paging', () => {
  const capTokens = { accessToken: 'at', externalCompanyId: 'c-1', externalCompanyName: null };
  const security = (name: string) => ({ shareClass: name, sharesOutstanding: 1000 });

  it('follows the provider links and concatenates the securities', async () => {
    const { fn, urls } = paged([
      {
        companyName: 'Acme',
        securities: [security('Common')],
        links: { next: 'https://api.pulley.com/v1/companies/c-1/cap-table?page=2' },
      },
      { securities: [security('Series A')], asOf: '2026-08-31' },
    ]);
    const pulled = await fetchCapTable('pulley', capTokens, fn);
    expect(urls).toHaveLength(2);
    expect(pulled.entries.map((e) => e.security_class)).toEqual(['Common', 'Series A']);
    // The two fields that are not rows come from the first page that names
    // them, which for `asOf` here is the second.
    expect(pulled.external_company_name).toBe('Acme');
    expect(pulled.as_of).toBe('2026-08-31');
  });

  it('refuses a cap table that continues in a spelling it cannot follow', async () => {
    const { fn } = paged([{ securities: [security('Common')], has_more: true }]);
    await expect(fetchCapTable('carta', capTokens, fn)).rejects.toThrow(
      /cap table continues past this page \("has_more"\)/,
    );
  });

  it('reads a single-page cap table without a second request', async () => {
    const { fn, urls } = paged([{ securities: [security('Common')], has_more: false, next: null }]);
    const pulled = await fetchCapTable('pulley', capTokens, fn);
    expect(urls).toHaveLength(1);
    expect(pulled.entries).toHaveLength(1);
  });
});
