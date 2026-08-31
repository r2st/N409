import { describe, expect, it } from 'vitest';
import { fetchRosterAndGrants, type FetchFn } from '../../src/clients/hris.js';
import { fetchCapTable } from '../../src/clients/capTableSync.js';
import {
  IntegrationError,
  MAX_INTEGRATION_JSON_BYTES,
  MAX_PROVIDER_PAGES,
  nextPageUrl,
  PAGED_PULL_BUDGET_BYTES,
  PAGED_PULL_BUDGET_MS,
  pagedPullBudget,
  providerSaysMore,
} from '../../src/clients/deadline.js';
import { classifyFailure } from '@n409/shared';

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

/**
 * The deadline the page walk multiplied (round 261, methodology M5).
 *
 * `withDeadline` bounds a request. R259 put it inside a twenty-iteration loop,
 * which turned one thirty-second bound into twenty of them: a provider
 * answering every page in twenty-nine seconds trips nothing, holds an
 * analyst's handler for ten minutes behind an edge that gave up long before,
 * and on the scheduler stretches a fifteen-minute tick — four connections at a
 * time out of twenty-five due — into an hour, dropping every tick underneath
 * it.
 */
/**
 * The other resource a page walk spends (round 265, methodology M6).
 *
 * `MAX_INTEGRATION_JSON_BYTES` bounds *a response*, and it says what it is
 * protecting: the process, and with it the four other services on the box,
 * because the one that dies is the one holding the heap. Both walks keep every
 * page so the mappers can run over the whole collection, so a per-response cap
 * inside a twenty-iteration loop made the real bound 320 MB — the same shape
 * that made a per-request deadline into twenty of them.
 */
describe('the bytes a paged pull may hold across all its pages (R265)', () => {
  const body = (bytes: number) => new Response(JSON.stringify({ pad: 'x'.repeat(bytes) }), { status: 200 });

  it('reads pages until the walk budget is spent, not until each page is too big', async () => {
    const budget = pagedPullBudget('Gusto', 120_000, () => 0, 400);
    expect(await budget.readPage(body(100))).toHaveProperty('pad');
    expect(await budget.readPage(body(100))).toHaveProperty('pad');
    // Each page is far inside the per-response cap; together they are past the
    // walk's, which is the only bound that describes what is held in memory.
    await expect(budget.readPage(body(300))).rejects.toThrow(/across the pages of one import/);
  });

  it('says a retry is worth it, like the time budget beside it', async () => {
    const budget = pagedPullBudget('Carta', 120_000, () => 0, 50);
    const err = await budget.readPage(body(200)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(classifyFailure(err).kind).toBe('transient');
  });

  it('still names an oversized single response as one', async () => {
    // The two bounds want two sentences: telling the analyst one page was too
    // big when the walk got there by accumulating sends them looking for a page
    // that is not there, and the reverse hides a provider that really did send
    // one enormous body.
    const budget = pagedPullBudget('Gusto');
    const huge = new Response('{}', {
      status: 200,
      headers: { 'content-length': String(MAX_INTEGRATION_JSON_BYTES + 1) },
    });
    await expect(budget.readPage(huge)).rejects.toThrow(/larger than 16 MB/);
  });

  it('refuses a non-JSON page in the wording every other provider body gets', async () => {
    const budget = pagedPullBudget('Gusto');
    const html = new Response('<html><head>', { status: 200 });
    await expect(budget.readPage(html)).rejects.toThrow(/returned a non-JSON response/);
    await expect(pagedPullBudget('Gusto').readPage(new Response('[]', { status: 200 }))).rejects.toThrow(
      /unexpected response body/,
    );
  });

  it('is the same byte budget for every paged pull, and wider than one answer', () => {
    expect(PAGED_PULL_BUDGET_BYTES).toBe(32 * 1024 * 1024);
    expect(PAGED_PULL_BUDGET_BYTES).toBeGreaterThan(MAX_INTEGRATION_JSON_BYTES);
  });

  it('is the walk that reads the page, on both families', async () => {
    // The wiring, stated where it can regress: a walk still reading through
    // `readJson` would take the per-response cap and none of the budget above.
    const oversized = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(MAX_INTEGRATION_JSON_BYTES + 1) },
      })) as FetchFn;
    await expect(fetchRosterAndGrants('gusto', tokens, oversized)).rejects.toThrow(/larger than 16 MB/);
    await expect(fetchCapTable('carta', tokens, oversized)).rejects.toThrow(/larger than 16 MB/);
  });
});

describe('the budget a paged pull spends across all its pages (R261)', () => {
  it('gives the first page the per-request deadline, not the whole budget', () => {
    const budget = pagedPullBudget('Carta', 120_000, () => 1_000);
    // 30s, the per-request bound: a budget is not licence for one slow socket.
    expect(budget.nextPageTimeoutMs()).toBe(30_000);
  });

  it('shrinks a page deadline to what is left, so the walk ends inside the budget', () => {
    let now = 0;
    const budget = pagedPullBudget('Carta', 120_000, () => now);
    expect(budget.nextPageTimeoutMs()).toBe(30_000);
    now = 110_000;
    expect(budget.nextPageTimeoutMs()).toBe(10_000);
  });

  it('refuses the next page once the budget is spent, and says a retry is worth it', () => {
    let now = 0;
    const budget = pagedPullBudget('Carta', 120_000, () => now);
    now = 120_001;
    let thrown: unknown;
    try {
      budget.nextPageTimeoutMs();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IntegrationError);
    expect((thrown as Error).message).toContain('Carta');
    // A provider that was slow once is worth another attempt on the backoff —
    // and the classifier can only read that off the error if it was said.
    expect(classifyFailure(thrown)).toMatchObject({ kind: 'transient' });
  });

  it('is the same budget for every paged pull', () => {
    expect(PAGED_PULL_BUDGET_MS).toBe(120_000);
  });
});
