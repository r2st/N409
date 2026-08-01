import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTING_PROVIDERS,
  authorizeUrl,
  exchangeCode,
  fetchFinancials,
  parseQuickBooksProfitAndLoss,
  parseXeroProfitAndLoss,
} from '../../src/clients/accounting.js';
import { accountingCredentials } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { signAccountingState, verifyAccountingState } from '../../src/auth/jwt.js';

const creds = { clientId: 'cid', clientSecret: 'shh' };
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('accounting OAuth (§23)', () => {
  it('builds a provider authorize URL with state and redirect', () => {
    const url = new URL(
      authorizeUrl('xero', creds, 'https://n409.example/api/v1/accounting/callback', 'st4te'),
    );
    expect(url.origin).toBe('https://login.xero.com');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('redirect_uri')).toBe('https://n409.example/api/v1/accounting/callback');
    expect(url.searchParams.get('scope')).toContain('accounting.reports.read');
  });

  it('exchanges the code with basic auth and captures the Xero tenant', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('identity.xero.com')) {
        return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 1800 });
      }
      if (String(url).includes('api.xero.com/connections')) {
        return jsonResponse([{ tenantId: 'tenant-1', tenantName: 'Acme Ltd' }]);
      }
      throw new Error(`unexpected ${String(url)}`);
    }) as unknown as typeof fetch;

    const tokens = await exchangeCode('xero', creds, 'https://cb', 'the-code', fetchFn);
    expect(tokens).toMatchObject({
      accessToken: 'at',
      refreshToken: 'rt',
      externalOrgId: 'tenant-1',
      externalOrgName: 'Acme Ltd',
    });
    expect(tokens.expiresAt).toBeInstanceOf(Date);

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('cid:shh').toString('base64')}`,
    );
    expect(String(init.body)).toContain('grant_type=authorization_code');
  });

  it('rejects a failed token exchange', async () => {
    const fetchFn = (async () => new Response('nope', { status: 400 })) as typeof fetch;
    await expect(exchangeCode('quickbooks', creds, 'https://cb', 'bad', fetchFn)).rejects.toThrow(
      /QuickBooks token exchange failed/,
    );
  });

  it('round-trips the signed OAuth state and rejects tampering', async () => {
    const cfg = { secret: 'x'.repeat(32), issuer: 'n409', ttlSeconds: 60 };
    const state = await signAccountingState(
      { valuationId: '01N409VAL000000000000000AA', provider: 'xero', userId: 'u1' },
      cfg,
    );
    await expect(verifyAccountingState(state, cfg)).resolves.toEqual({
      valuationId: '01N409VAL000000000000000AA',
      provider: 'xero',
      userId: 'u1',
    });
    await expect(verifyAccountingState(state + 'x', cfg)).rejects.toThrow();
  });
});

describe('accounting credentials from env', () => {
  const base = { JWT_SECRET: 'x'.repeat(32) };

  it('activates only providers with both halves set', () => {
    const config = loadConfig({
      ...base,
      XERO_CLIENT_ID: 'a',
      XERO_CLIENT_SECRET: 'b',
      QUICKBOOKS_CLIENT_ID: 'only-half',
    } as NodeJS.ProcessEnv);
    const active = accountingCredentials(config);
    expect(Object.keys(active)).toEqual(['xero']);
  });

  it('covers all six providers', () => {
    expect(ACCOUNTING_PROVIDERS).toHaveLength(6);
  });
});

describe('P&L parsers', () => {
  it('parses the Xero report shape', () => {
    const report = {
      Reports: [
        {
          Fields: [
            { Id: 'FromDate', Value: '2026-01-01' },
            { Id: 'ToDate', Value: '2026-06-30' },
            { Id: 'Currency', Value: 'USD' },
          ],
          Rows: [
            {
              Rows: [
                {
                  RowType: 'SummaryRow',
                  Cells: [{ Value: 'Total Income' }, { Value: '1250000.50' }, { Value: '900000' }],
                },
              ],
            },
            {
              Rows: [{ RowType: 'SummaryRow', Cells: [{ Value: 'Net Profit' }, { Value: '-52000.25' }] }],
            },
          ],
        },
      ],
    };
    expect(parseXeroProfitAndLoss(report)).toEqual({
      currency: 'USD',
      period_start: '2026-01-01',
      period_end: '2026-06-30',
      revenue_cents: 125_000_050,
      prior_year_revenue_cents: 90_000_000,
      net_income_cents: -5_200_025,
    });
  });

  it('parses the QuickBooks report shape', () => {
    const report = {
      Header: { StartPeriod: '2026-01-01', EndPeriod: '2026-06-30', Currency: 'USD' },
      Rows: {
        Row: [
          { group: 'Income', Summary: { ColData: [{ value: 'Total Income' }, { value: '425000.00' }] } },
          {
            group: 'Expenses',
            Rows: {
              Row: [
                {
                  group: 'NetIncome',
                  Summary: { ColData: [{ value: 'Net Income' }, { value: '31000.10' }] },
                },
              ],
            },
          },
        ],
      },
    };
    expect(parseQuickBooksProfitAndLoss(report)).toEqual({
      currency: 'USD',
      period_start: '2026-01-01',
      period_end: '2026-06-30',
      revenue_cents: 42_500_000,
      prior_year_revenue_cents: null,
      net_income_cents: 3_100_010,
    });
  });

  it('tolerates missing summary rows', () => {
    expect(parseXeroProfitAndLoss({ Reports: [{ Rows: [] }] })).toMatchObject({
      revenue_cents: null,
      net_income_cents: null,
    });
  });
});

describe('fetchFinancials', () => {
  it('pulls the Xero P&L with the tenant header', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain('Reports/ProfitAndLoss');
      expect(new Headers(init?.headers).get('xero-tenant-id')).toBe('tenant-1');
      return jsonResponse({
        Reports: [{ Rows: [{ Rows: [{ Cells: [{ Value: 'Total Income' }, { Value: '100' }] }] }] }],
      });
    }) as unknown as typeof fetch;

    const out = await fetchFinancials('xero', { accessToken: 'at', externalOrgId: 'tenant-1' }, fetchFn);
    expect(out).toMatchObject({ provider: 'xero', revenue_cents: 10_000 });
  });

  it('declines providers without an import parser', async () => {
    await expect(fetchFinancials('wave', { accessToken: 'at', externalOrgId: null }, fetch)).rejects.toThrow(
      /not supported/,
    );
  });
});
