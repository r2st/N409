import { describe, expect, it } from 'vitest';
import {
  describeConnectorFailure,
  IntegrationError,
  ReconnectRequiredError,
} from '../../src/clients/deadline.js';
import { fetchFinancials } from '../../src/clients/accounting.js';

/**
 * What a connector is allowed to write into `last_error`.
 *
 * `errorBodyDisclosure.test.ts` states the rule for the response body: an
 * error's own wording is publishable only when something vouched for it, which
 * in these clients means `IntegrationError`. The rule was applied to the body
 * and not to the column beside it. `last_error` and `last_import_summary` are
 * returned verbatim by every connector's `toPublic`, and the three sync catches
 * wrote `describeTransportFailure(err)` into them — a function whose fallback
 * branch *is* `err.message`.
 *
 * That was defensible while the guarded block held a provider call and nothing
 * else. Round 252 put `accessTokenFor` inside it, and `accessTokenFor` ends in
 * `updateTokens` — a write to Postgres. So the premise the catch's own comment
 * rests on ("everything the client throws is provider-attributable") stopped
 * being true, and a driver error from the token write became a route to putting
 * constraint names, column names and refused values on a screen.
 *
 * `describeConnectorFailure` makes the vouching explicit, and these hold it.
 */
describe('describeConnectorFailure', () => {
  const ours = 'the sync could not be completed — it is in the service log';

  it('publishes an IntegrationError, which is a sentence this codebase wrote', () => {
    expect(describeConnectorFailure(new IntegrationError('Gusto roster fetch failed (503)'), ours)).toBe(
      'Gusto roster fetch failed (503)',
    );
  });

  it('publishes the reconnect request, which is the one an analyst must act on', () => {
    const err = new ReconnectRequiredError('Carta no longer accepts the stored authorisation — reconnect.');
    expect(describeConnectorFailure(err, ours)).toBe(err.message);
  });

  it('publishes a named transport condition, which failure.ts wrote', () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expect(describeConnectorFailure(refused, ours)).toContain('the connection was refused');
  });

  it('still says something when fetch reported no reason at all', () => {
    // `describeTransportFailure` has its own sentence for this and it names
    // nothing, so it stays: replacing it with `ours` would send a reader to the
    // log for a fact the column already holds.
    expect(describeConnectorFailure(new TypeError('fetch failed'), ours)).toBe(
      'the request could not be completed and the connection reported no reason',
    );
  });

  it('substitutes our own sentence for a driver error, values and all', () => {
    // What `updateTokens` throws when Postgres refuses the write — the shape
    // R159 removed from the response body and R257 from the column.
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "x_idx"'), {
      code: '23505',
      table: 'hris_connections',
      detail: 'Key (valuation_id, provider)=(01HZ…, gusto) already exists.',
    });
    const described = describeConnectorFailure(pgError, ours);
    expect(described).toBe(ours);
    expect(described).not.toContain('unique constraint');
    expect(described).not.toContain('hris_connections');
  });

  it('substitutes it for a programming error too, which is the commonest ours', () => {
    // A mapper walking a shape it did not expect — the failure `records()` and
    // `asRows()` were written for. "Cannot read properties of null (reading
    // 'fullName')" under a connection card reads as a provider problem.
    const bug = new TypeError("Cannot read properties of null (reading 'fullName')");
    expect(describeConnectorFailure(bug, ours)).toBe(ours);
  });
});

describe('the balance sheet a reader could not read', () => {
  /**
   * `fetchFinancials` degrades a balance-sheet failure to `null` plus a reason,
   * and that reason is stored on the connection and shown beside the imported
   * figures. It caught whatever was thrown and reported all of it as the
   * provider's.
   *
   * No *parse* reaches that catch today — `asRecord`/`asRows` were written to
   * make the scrapers tolerate any shape, and four malformed reports were tried
   * against this before the assertion below was settled on, all four of which
   * came back "no recognised subtotals were found". So this asserts the rule at
   * the site rather than a reachable parse bug: anything of ours that throws
   * here gets our sentence, and the analyst is not shown wording nothing
   * vouched for under a heading that says the provider failed.
   */
  it('does not report wording nothing vouched for as the provider reason', async () => {
    const fetchFn = (async (url: string) => {
      if (String(url).toLowerCase().includes('balancesheet')) {
        throw new TypeError("Cannot read properties of undefined (reading 'Rows')");
      }
      return new Response(
        JSON.stringify({
          Reports: [{ Rows: [{ Cells: [{ Value: 'Total Income' }, { Value: '100.00' }] }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const financials = await fetchFinancials('xero', { accessToken: 'tok', externalOrgId: 'org' }, fetchFn);
    const reason = financials.balance_sheet_error ?? '';
    expect(reason).not.toMatch(/Cannot read propert/i);
    expect(reason).toContain('the service log');
    // And the import still returns: a balance sheet that could not be read
    // degrades to null rather than failing the whole pull.
    expect(financials.balance_sheet).toBeNull();
  });
});
