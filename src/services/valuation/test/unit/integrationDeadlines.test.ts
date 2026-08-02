import { describe, expect, it, vi } from 'vitest';
import { exchangeCode as accountingExchange, fetchFinancials } from '../../src/clients/accounting.js';
import { exchangeCode as capTableExchange, fetchCapTable } from '../../src/clients/capTableSync.js';
import { exchangeCode as hrisExchange, fetchRosterAndGrants } from '../../src/clients/hris.js';
import { IMPORT_TIMEOUT_MS, OAUTH_TIMEOUT_MS, withDeadline } from '../../src/clients/deadline.js';

/**
 * Every outbound call to a third-party integration must carry a deadline.
 *
 * Node's `fetch` has no default timeout, so a provider that accepts the
 * connection and then goes quiet parks the request handler indefinitely — the
 * import never fails, it simply never returns. These tests assert the property
 * at each call site rather than trusting that whoever adds the next provider
 * remembers, because the failure is invisible until production: a fake fetch in
 * a test always answers immediately, deadline or not.
 *
 * Nothing here waits out a real budget. `AbortSignal.timeout` is implemented in
 * the platform rather than on `setTimeout`, so vitest's fake timers do not
 * advance it and a literal test of the 30s import budget costs 30s of wall
 * clock. Instead the two halves are checked separately: the call sites are
 * asserted to attach a signal and to translate an abort into a provider-named
 * error, and `withDeadline` is timed out for real against a 20ms budget.
 */

const creds = { clientId: 'cid', clientSecret: 'shh' };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** What `fetch` rejects with once its `AbortSignal.timeout` fires. */
const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

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

describe('third-party integrations carry a deadline', () => {
  it.each(CASES)('$name passes an abort signal', async ({ run }) => {
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return json({ access_token: 'at' });
    }) as unknown as typeof fetch;

    // The call may still reject on a payload this fake doesn't satisfy; the
    // signal is attached before any of that, which is what's under test.
    await run(fetchFn).catch(() => undefined);

    expect(calls.length).toBeGreaterThan(0);
    for (const init of calls) {
      expect(init.signal, 'outbound call has no deadline').toBeInstanceOf(AbortSignal);
      expect(init.signal!.aborted, 'signal was already spent before the call').toBe(false);
    }
  });

  it.each(CASES)('$name reports a timeout as the provider not responding', async ({ run, provider }) => {
    // Stands in for the deadline firing: this is exactly what fetch rejects
    // with. A call site that attached a raw signal without going through
    // withDeadline would surface the stock DOMException wording instead.
    const abortingFetch = (async () => {
      throw timeoutError();
    }) as typeof fetch;

    await expect(run(abortingFetch)).rejects.toThrow(provider);
    await expect(run(abortingFetch)).rejects.toThrow(/did not respond within \d+s/);
  });

  it('budgets a token exchange more tightly than a full import', () => {
    // A token exchange is a small round-trip against an auth server; a report
    // or cap-table pull is a real query on the provider's side.
    expect(OAUTH_TIMEOUT_MS).toBeLessThan(IMPORT_TIMEOUT_MS);
    expect(OAUTH_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('withDeadline', () => {
  it('returns the value when the call beats the deadline', async () => {
    await expect(withDeadline('Xero', 50, async () => 'ok')).resolves.toBe('ok');
  });

  it('passes a live signal, not a spent one', async () => {
    const signal = await withDeadline('Xero', 50, async (s) => s);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('actually aborts a call that overruns its budget', async () => {
    // The one real wait in this file, against a 20ms budget rather than the
    // production ones. Without the signal this promise never settles.
    const started = Date.now();
    await expect(
      withDeadline(
        'Carta',
        20,
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason as Error));
          }),
      ),
    ).rejects.toThrow('Carta did not respond within 0s');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports the budget in whole seconds', async () => {
    const abortLike = async () => {
      throw timeoutError();
    };
    await expect(withDeadline('Gusto', 10_000, abortLike)).rejects.toThrow(
      'Gusto did not respond within 10s',
    );
    await expect(withDeadline('Gusto', 30_000, abortLike)).rejects.toThrow(
      'Gusto did not respond within 30s',
    );
  });

  it('leaves a non-timeout failure exactly as it was', async () => {
    // A 401 or a DNS failure must keep its own message — rewriting every error
    // as a timeout would hide the actual cause behind a plausible-looking one.
    const boom = new Error('invalid_client');
    await expect(
      withDeadline('Carta', 50, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
