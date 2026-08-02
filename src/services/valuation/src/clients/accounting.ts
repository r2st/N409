/**
 * Accounting software integrations (409.ai §23): OAuth2 connect + financial
 * data import for the six providers the onboarding flow advertises.
 *
 * Every provider is config-gated (env client id/secret) like Stripe — an
 * unconfigured provider shows as "not configured" and its routes 503.
 * Xero and QuickBooks have full profit-and-loss import parsers (their report
 * APIs are stable and well-known); the remaining providers support OAuth
 * connect, with imports declined until a parser lands.
 *
 * All HTTP goes through an injectable fetch so tests never touch the network.
 */

import { IMPORT_TIMEOUT_MS, OAUTH_TIMEOUT_MS, withDeadline } from './deadline.js';

export const ACCOUNTING_PROVIDERS = ['xero', 'quickbooks', 'freshbooks', 'netsuite', 'sage', 'wave'] as const;
export type AccountingProvider = (typeof ACCOUNTING_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<AccountingProvider, string> = {
  xero: 'Xero',
  quickbooks: 'QuickBooks',
  freshbooks: 'FreshBooks',
  netsuite: 'Oracle NetSuite',
  sage: 'Sage',
  wave: 'Wave',
};

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  /** Provider org handle when the token exchange reveals it (Xero tenant). */
  externalOrgId?: string | null;
  externalOrgName?: string | null;
}

/** Normalized P&L snapshot every import parser produces. */
export interface ImportedFinancials {
  currency: string | null;
  period_start: string | null;
  period_end: string | null;
  revenue_cents: number | null;
  prior_year_revenue_cents: number | null;
  net_income_cents: number | null;
  provider: AccountingProvider;
}

export type FetchFn = typeof fetch;

interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

const ENDPOINTS: Record<AccountingProvider, OAuthEndpoints> = {
  xero: {
    authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    scope: 'accounting.reports.read accounting.settings.read offline_access',
  },
  quickbooks: {
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    scope: 'com.intuit.quickbooks.accounting',
  },
  freshbooks: {
    authorizeUrl: 'https://auth.freshbooks.com/oauth/authorize',
    tokenUrl: 'https://api.freshbooks.com/auth/oauth/token',
    scope: 'user:reports:read user:profile:read',
  },
  netsuite: {
    authorizeUrl: 'https://system.netsuite.com/app/login/oauth2/authorize.nl',
    tokenUrl: 'https://system.netsuite.com/services/rest/auth/oauth2/v1/token',
    scope: 'rest_webservices',
  },
  sage: {
    authorizeUrl: 'https://www.sageone.com/oauth2/auth/central',
    tokenUrl: 'https://oauth.accounting.sage.com/token',
    scope: 'full_access',
  },
  wave: {
    authorizeUrl: 'https://api.waveapps.com/oauth2/authorize/',
    tokenUrl: 'https://api.waveapps.com/oauth2/token/',
    scope: 'business:read account:read',
  },
};

/** Providers with a working import parser; the rest are connect-only. */
export const IMPORT_SUPPORTED: ReadonlySet<AccountingProvider> = new Set(['xero', 'quickbooks']);

export function authorizeUrl(
  provider: AccountingProvider,
  creds: ProviderCredentials,
  redirectUri: string,
  state: string,
): string {
  const e = ENDPOINTS[provider];
  const url = new URL(e.authorizeUrl);
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', e.scope);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export async function exchangeCode(
  provider: AccountingProvider,
  creds: ProviderCredentials,
  redirectUri: string,
  code: string,
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  const e = ENDPOINTS[provider];
  const res = await withDeadline(PROVIDER_LABELS[provider], OAUTH_TIMEOUT_MS, (signal) =>
    fetchFn(e.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
      signal,
    }),
  );
  if (!res.ok) {
    throw new Error(`${PROVIDER_LABELS[provider]} token exchange failed (${res.status})`);
  }
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) throw new Error(`${PROVIDER_LABELS[provider]} returned no access token`);

  const tokens: TokenSet = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
  };

  // Xero identifies the org via a separate connections call.
  if (provider === 'xero') {
    try {
      const conns = await withDeadline(PROVIDER_LABELS[provider], OAUTH_TIMEOUT_MS, (signal) =>
        fetchFn('https://api.xero.com/connections', {
          headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
          signal,
        }),
      );
      if (conns.ok) {
        const list = (await conns.json()) as Array<{ tenantId?: string; tenantName?: string }>;
        tokens.externalOrgId = list[0]?.tenantId ?? null;
        tokens.externalOrgName = list[0]?.tenantName ?? null;
      }
    } catch {
      // org identification is best-effort; the connection still works
    }
  }
  return tokens;
}

// ── Import parsers ────────────────────────────────────────────────────────────

const toCents = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Xero Reports/ProfitAndLoss: rows of sections; the "Total Income" /
 * "Net Profit" summary rows carry current + comparison-period cells.
 */
export function parseXeroProfitAndLoss(report: unknown): Omit<ImportedFinancials, 'provider'> {
  const r = report as {
    Reports?: Array<{
      Fields?: Array<{ Id?: string; Value?: string }>;
      Rows?: Array<{
        Rows?: Array<{ RowType?: string; Cells?: Array<{ Value?: string }> }>;
      }>;
    }>;
  };
  const root = r.Reports?.[0];
  let revenue: number | null = null;
  let priorRevenue: number | null = null;
  let netIncome: number | null = null;

  for (const section of root?.Rows ?? []) {
    for (const row of section.Rows ?? []) {
      const label = row.Cells?.[0]?.Value ?? '';
      const current = row.Cells?.[1]?.Value;
      const prior = row.Cells?.[2]?.Value;
      if (/^total (income|revenue)$/i.test(label)) {
        revenue = toCents(current);
        priorRevenue = toCents(prior);
      } else if (/^net (profit|income)$/i.test(label)) {
        netIncome = toCents(current);
      }
    }
  }
  const fields = Object.fromEntries((root?.Fields ?? []).map((f) => [f.Id, f.Value]));
  return {
    currency: (fields.Currency as string | undefined) ?? null,
    period_start: (fields.FromDate as string | undefined) ?? null,
    period_end: (fields.ToDate as string | undefined) ?? null,
    revenue_cents: revenue,
    prior_year_revenue_cents: priorRevenue,
    net_income_cents: netIncome,
  };
}

/**
 * QuickBooks reports/ProfitAndLoss: nested Rows with group summaries; the
 * Income group's Summary row and the top-level NetIncome row carry totals.
 */
export function parseQuickBooksProfitAndLoss(report: unknown): Omit<ImportedFinancials, 'provider'> {
  const r = report as {
    Header?: { StartPeriod?: string; EndPeriod?: string; Currency?: string };
    Rows?: { Row?: QboRow[] };
  };
  interface QboRow {
    group?: string;
    Summary?: { ColData?: Array<{ value?: string }> };
    Rows?: { Row?: QboRow[] };
  }
  let revenue: number | null = null;
  let netIncome: number | null = null;

  const walk = (rows: QboRow[] | undefined) => {
    for (const row of rows ?? []) {
      const total = row.Summary?.ColData?.at(-1)?.value;
      if (row.group === 'Income') revenue = toCents(total);
      if (row.group === 'NetIncome') netIncome = toCents(total);
      walk(row.Rows?.Row);
    }
  };
  walk(r.Rows?.Row);

  return {
    currency: r.Header?.Currency ?? null,
    period_start: r.Header?.StartPeriod ?? null,
    period_end: r.Header?.EndPeriod ?? null,
    revenue_cents: revenue,
    prior_year_revenue_cents: null,
    net_income_cents: netIncome,
  };
}

export async function fetchFinancials(
  provider: AccountingProvider,
  tokens: { accessToken: string; externalOrgId: string | null },
  fetchFn: FetchFn = fetch,
): Promise<ImportedFinancials> {
  if (provider === 'xero') {
    const res = await withDeadline(PROVIDER_LABELS[provider], IMPORT_TIMEOUT_MS, (signal) =>
      fetchFn('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss', {
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          accept: 'application/json',
          ...(tokens.externalOrgId ? { 'xero-tenant-id': tokens.externalOrgId } : {}),
        },
        signal,
      }),
    );
    if (!res.ok) throw new Error(`Xero report fetch failed (${res.status})`);
    return { ...parseXeroProfitAndLoss(await res.json()), provider };
  }
  if (provider === 'quickbooks') {
    // Held in a local because TypeScript drops the narrowing above once the
    // property is read inside a callback.
    const realmId = tokens.externalOrgId;
    if (!realmId) throw new Error('QuickBooks connection is missing its realm id');
    const res = await withDeadline(PROVIDER_LABELS[provider], IMPORT_TIMEOUT_MS, (signal) =>
      fetchFn(
        `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/reports/ProfitAndLoss`,
        {
          headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
          signal,
        },
      ),
    );
    if (!res.ok) throw new Error(`QuickBooks report fetch failed (${res.status})`);
    return { ...parseQuickBooksProfitAndLoss(await res.json()), provider };
  }
  throw new Error(`${PROVIDER_LABELS[provider]} import is not supported yet`);
}
