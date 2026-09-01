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

import {
  describeConnectorFailure,
  IMPORT_TIMEOUT_MS,
  IntegrationError,
  OAUTH_TIMEOUT_MS,
  providerRefused,
  readJson,
  readJsonArray,
  storableProviderText,
  withDeadline,
} from './deadline.js';
import { refreshOAuthTokens, type RefreshedTokens } from './oauthRefresh.js';

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

/**
 * Normalized balance-sheet snapshot.
 *
 * `total_assets_cents` and `total_liabilities_cents` are the two the 409A
 * asset approach actually requires (engine `inputs.asset.*`), which is why
 * they carry the parsers' effort; the rest are captured because an analyst
 * reviewing an imported figure wants to see the statement it came from rather
 * than two numbers with no context.
 *
 * Every field is independently nullable. A chart of accounts that names its
 * subtotals unusually yields a partial parse, and a partial balance sheet is
 * worth more than none — the missing lines simply stay manual.
 */
export interface ImportedBalanceSheet {
  as_of: string | null;
  total_assets_cents: number | null;
  total_liabilities_cents: number | null;
  total_equity_cents: number | null;
  current_assets_cents: number | null;
  current_liabilities_cents: number | null;
  cash_cents: number | null;
}

/** What a profit-and-loss parser produces, before the balance sheet joins it. */
export type ProfitAndLossSnapshot = Pick<
  ImportedFinancials,
  | 'currency'
  | 'period_start'
  | 'period_end'
  | 'revenue_cents'
  | 'prior_year_revenue_cents'
  | 'net_income_cents'
>;

/** Normalized P&L + balance-sheet snapshot every import parser produces. */
export interface ImportedFinancials {
  currency: string | null;
  period_start: string | null;
  period_end: string | null;
  revenue_cents: number | null;
  prior_year_revenue_cents: number | null;
  net_income_cents: number | null;
  /**
   * Null when the balance sheet could not be pulled or parsed. The P&L is the
   * primary import — it is what the revenue params depend on — so a balance
   * sheet failure degrades to null rather than failing the whole import, and
   * `balance_sheet_error` says why.
   */
  balance_sheet: ImportedBalanceSheet | null;
  balance_sheet_error?: string | null;
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

/**
 * Spend the stored refresh token for a new access token.
 *
 * QuickBooks access tokens last an hour and Xero's thirty minutes, so an
 * import run any time after the connect flow was answering `401` — the same
 * unread `refresh_token` column the two scheduled connectors had, on a path
 * where the analyst at least gets told something failed. See
 * `clients/oauthRefresh.ts`.
 */
export async function refreshTokens(
  provider: AccountingProvider,
  creds: ProviderCredentials,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<RefreshedTokens> {
  return refreshOAuthTokens({
    label: PROVIDER_LABELS[provider],
    tokenUrl: ENDPOINTS[provider].tokenUrl,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken,
    fetchFn,
  });
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
    throw providerRefused(PROVIDER_LABELS[provider], 'token exchange', res);
  }
  const body = (await readJson(res, PROVIDER_LABELS[provider])) as TokenResponse;
  if (!body.access_token) {
    throw new IntegrationError(`${PROVIDER_LABELS[provider]} returned no access token`);
  }

  const tokens: TokenSet = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
  };

  /*
   * Xero identifies the org via a separate connections call.
   *
   * NOT BEST-EFFORT, WHATEVER THE COMMENT SAID (R301, methodology M6).
   *
   * This was a bare `catch {}` under "org identification is best-effort; the
   * connection still works", and a non-`ok` response fell through the same way
   * in silence. Neither is true of Xero. `fetchFinancials` and
   * `fetchBalanceSheet` send `xero-tenant-id` only when `externalOrgId` is set
   * — read the spread at their headers — so a connection without one is a
   * connection every later import is made without the header Xero requires.
   *
   * That is the shape this round is for: the failure lands nowhere near where
   * it happened. The connect answers `?accounting=connected`, the card reads
   * healthy, and the first import comes back as a provider refusal that names
   * the import. Nothing recorded the connections call, so there is no line to
   * join the two, and a reconnect — the obvious remedy — reproduces it exactly.
   *
   * So the connect refuses instead. The OAuth code is spent either way; what
   * changes is that the operator is told now, by the callback they are looking
   * at, rather than by an import days later. The route already answers
   * `?accounting=error` and logs the reason for every other failure in this
   * exchange, so this needs no new handling — only to stop being swallowed.
   */
  if (provider === 'xero') {
    const conns = await withDeadline(PROVIDER_LABELS[provider], OAUTH_TIMEOUT_MS, (signal) =>
      fetchFn('https://api.xero.com/connections', {
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
        signal,
      }),
    );
    if (!conns.ok) {
      throw providerRefused(PROVIDER_LABELS[provider], 'organisation lookup', conns);
    }
    const list = await readJsonArray(conns);
    // `readJsonArray` guarantees a list and nothing about what is in it,
    // so both of these were whatever Xero's JSON had at those keys. They
    // land on `accounting_connections` as `text` *and* in the connect
    // event's `jsonb` payload, written by `upsertConnection` in the same
    // transaction as the row — so a `tenantName` the driver refuses (a NUL
    // byte, half a character) is not a cosmetic field stored wrong, it
    // rolls the connection back after the one-time OAuth code has been
    // spent, identically on every reconnect. See `storableProviderText`.
    const org = list[0] as { tenantId?: unknown; tenantName?: unknown } | undefined;
    tokens.externalOrgId = storableProviderText(org?.tenantId);
    tokens.externalOrgName = storableProviderText(org?.tenantName);
    if (!tokens.externalOrgId) {
      // An empty list is the consent screen finishing with no organisation
      // ticked, which is a thing a person does and can undo. Said in those
      // terms rather than as a missing field, because the fix is theirs.
      throw new IntegrationError(
        `${PROVIDER_LABELS[provider]} did not return an organisation for this connection — ` +
          'reconnect and choose the organisation to share',
      );
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
export function parseXeroProfitAndLoss(report: unknown): ProfitAndLossSnapshot {
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

  for (const section of asRows<{ Rows?: unknown }>(root?.Rows)) {
    for (const row of asRows<{ Cells?: Array<{ Value?: string }> }>(section.Rows)) {
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
  const fields = Object.fromEntries(
    asRows<{ Id?: string; Value?: string }>(root?.Fields).map((f) => [f.Id, f.Value]),
  );
  return {
    // Three more of the same cast the balance sheet's `as_of` carried, into the
    // same two jsonb documents. See `storableProviderText`.
    currency: storableProviderText(fields.Currency),
    period_start: storableProviderText(fields.FromDate),
    period_end: storableProviderText(fields.ToDate),
    revenue_cents: revenue,
    prior_year_revenue_cents: priorRevenue,
    net_income_cents: netIncome,
  };
}

/**
 * QuickBooks reports/ProfitAndLoss: nested Rows with group summaries; the
 * Income group's Summary row and the top-level NetIncome row carry totals.
 */
export function parseQuickBooksProfitAndLoss(report: unknown): ProfitAndLossSnapshot {
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

  const walk = (rows: unknown, depth: number) => {
    if (depth > MAX_REPORT_DEPTH) return;
    for (const row of asRows<QboRow>(rows)) {
      const total = row.Summary?.ColData?.at(-1)?.value;
      if (row.group === 'Income') revenue = toCents(total);
      if (row.group === 'NetIncome') netIncome = toCents(total);
      walk(row.Rows?.Row, depth + 1);
    }
  };
  walk(r.Rows?.Row, 0);

  return {
    currency: storableProviderText(r.Header?.Currency),
    period_start: storableProviderText(r.Header?.StartPeriod),
    period_end: storableProviderText(r.Header?.EndPeriod),
    revenue_cents: revenue,
    prior_year_revenue_cents: null,
    net_income_cents: netIncome,
  };
}

// ── Balance sheets ───────────────────────────────────────────────────────────

const EMPTY_BALANCE_SHEET: ImportedBalanceSheet = {
  as_of: null,
  total_assets_cents: null,
  total_liabilities_cents: null,
  total_equity_cents: null,
  current_assets_cents: null,
  current_liabilities_cents: null,
  cash_cents: null,
};

/**
 * Subtotal labels, matched against whatever the provider calls the row.
 *
 * Matching on the *label* rather than on a section position is what makes this
 * survive a customised chart of accounts: both providers let a bookkeeper
 * rename and renest account groups, but nobody renames "Total Assets" —
 * accountants read these statements too. The patterns are anchored so a
 * subtotal cannot claim a line meant for a total ("Total Current Assets" must
 * not answer for "Total Assets", which is why the current-asset pattern is
 * tested first and the plain one excludes the qualifier).
 */
const BALANCE_LINES: Array<{ field: keyof ImportedBalanceSheet; match: RegExp }> = [
  { field: 'current_assets_cents', match: /^total\s+current\s+assets$/i },
  { field: 'current_liabilities_cents', match: /^total\s+current\s+liabilities$/i },
  { field: 'total_assets_cents', match: /^total\s+assets$/i },
  {
    field: 'total_liabilities_cents',
    // Xero says "Total Liabilities"; QuickBooks often only reports
    // "Total Liabilities and Equity" as a top-level row and puts the
    // liabilities subtotal one level in — both spellings resolve here, and the
    // combined row is excluded because it is assets by another name.
    match: /^total\s+liabilities$/i,
  },
  { field: 'total_equity_cents', match: /^(total\s+equity|net\s+assets|total\s+shareholders'?\s+equity)$/i },
  { field: 'cash_cents', match: /^(total\s+)?(cash(\s+and\s+cash\s+equivalents)?|bank\s+accounts)$/i },
];

function assignBalanceLine(out: ImportedBalanceSheet, label: string, amount: unknown): void {
  const trimmed = label.trim();
  for (const { field, match } of BALANCE_LINES) {
    if (match.test(trimmed)) {
      // First match wins: a statement repeating a subtotal (comparative
      // columns, a consolidated block) should not have the later copy
      // overwrite the first, which is the one belonging to the primary period.
      if (out[field] === null) (out[field] as number | null) = toCents(amount);
      return;
    }
  }
}

/**
 * `report as {…}` is a lie about anything that is not an object, and `null`
 * is the one value that makes the very next property read throw. These parsers
 * are fed provider JSON, so a null body is not hypothetical — it is what a
 * gateway returns when it has nothing to say.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * The same lie, one level down: a list of rows that is not a list, or holds
 * something that is not a row.
 *
 * `asRecord` guards the body. Every `for (… of x.Rows ?? [])` below asserted
 * the collection *inside* it and checked nothing, and the two shapes a report
 * can arrive in are one line apart:
 *
 *   {"Reports":[{"Rows":{…}}]}     TypeError: object is not iterable
 *   {"Reports":[{"Rows":[null]}]}  TypeError: Cannot read properties of null
 *
 * Both leave these parsers as a bare `TypeError`, and the import route catches
 * it, runs it through `describeTransportFailure`, and writes V8's wording to
 * `accounting_connections.last_error` — the column it then tells the analyst
 * to go and read, in a sentence about the *provider* having failed.
 *
 * Read as absent rather than refused, unlike the cap-table sync's equivalent.
 * These are scrapers: a section whose shape they do not recognise already
 * contributes nothing and the parse already answers `null` for a figure it did
 * not find, which is a value the import route checks for before it applies
 * anything. A crash is the bug here; the tolerance is the design.
 */
function asRows<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row)) as T[];
}

/**
 * How deep a QuickBooks report may nest before this stops walking it.
 *
 * `walk` recurses on `row.Rows.Row` with no bound. V8's JSON parser is
 * iterative, so a body of twenty thousand nested `{"Rows":{"Row":[` — about
 * 340 KB, three orders of magnitude inside the 16 MB body cap — parses
 * cleanly and then exhausts the stack, and `RangeError: Maximum call stack
 * size exceeded` becomes the provider's recorded failure. A real balance sheet
 * or P&L nests half a dozen groups deep.
 */
const MAX_REPORT_DEPTH = 64;

/** Xero Reports/BalanceSheet — same row-of-sections shape as the P&L. */
export function parseXeroBalanceSheet(report: unknown): ImportedBalanceSheet {
  const r = asRecord(report) as {
    Reports?: Array<{
      Fields?: Array<{ Id?: string; Value?: string }>;
      Rows?: Array<{ Rows?: Array<{ Cells?: Array<{ Value?: string }> }> }>;
    }>;
  };
  const root = r.Reports?.[0];
  const out: ImportedBalanceSheet = { ...EMPTY_BALANCE_SHEET };
  for (const section of asRows<{ Rows?: unknown }>(root?.Rows)) {
    for (const row of asRows<{ Cells?: Array<{ Value?: string }> }>(section.Rows)) {
      assignBalanceLine(out, row.Cells?.[0]?.Value ?? '', row.Cells?.[1]?.Value);
    }
  }
  const fields = Object.fromEntries(
    asRows<{ Id?: string; Value?: string }>(root?.Fields).map((f) => [f.Id, f.Value]),
  );
  // A balance sheet is a point in time, so the report's ToDate is its date.
  // Cast rather than checked until R259: the value is whatever Xero's JSON had
  // at that key, and it is copied into two `jsonb` documents — the engagement's
  // `engine_inputs.accounting_import` and the connection's
  // `last_import_summary` — where a NUL byte or a lone surrogate is refused by
  // the driver rather than stored. `recordImport` writes the second of those
  // *after* both applies have committed and outside the route's catch, which is
  // the state that leaves an engagement holding a ledger's figures under a
  // connection still reporting its previous import.
  out.as_of = storableProviderText(fields.ToDate) ?? storableProviderText(fields.FromDate);
  return out;
}

/** QuickBooks reports/BalanceSheet — nested Rows whose Summary rows carry totals. */
export function parseQuickBooksBalanceSheet(report: unknown): ImportedBalanceSheet {
  interface QboRow {
    group?: string;
    Summary?: { ColData?: Array<{ value?: string }> };
    Rows?: { Row?: QboRow[] };
  }
  const r = asRecord(report) as { Header?: { EndPeriod?: string }; Rows?: { Row?: QboRow[] } };
  const out: ImportedBalanceSheet = { ...EMPTY_BALANCE_SHEET };

  const walk = (rows: unknown, depth: number) => {
    if (depth > MAX_REPORT_DEPTH) return;
    for (const row of asRows<QboRow>(rows)) {
      const cols = row.Summary?.ColData;
      if (cols && cols.length > 0) {
        assignBalanceLine(out, cols[0]?.value ?? '', cols.at(-1)?.value);
      }
      walk(row.Rows?.Row, depth + 1);
    }
  };
  walk(r.Rows?.Row, 0);
  out.as_of = storableProviderText(r.Header?.EndPeriod);
  return out;
}

/**
 * The largest revenue figure this platform will store, in cents.
 *
 * `ytd_revenue_cents` and `last_year_revenue_cents` are `bigint` columns, and
 * `PATCH /api/v1/valuations/:id/params` holds both to
 * `z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)`. The import wrote
 * neither bound: `toCents` is `Math.round(n * 100)` over whatever the provider
 * put in the cell, so a `"1e300"` in a Total Income row arrived as `1e302` and
 * the driver refused it — `22003 value out of range for type bigint` — from
 * `patchParams`, which sits *outside* this route's catch. The import then had
 * no error recorded against it and a 500 whose message was the column's.
 *
 * Past `Number.MAX_SAFE_INTEGER` nothing is refused and the failure is quieter:
 * the figure is stored, rounded to whichever double was nearest, and read back
 * as the company's revenue.
 *
 * The same rule the form is held to, applied to a payload nobody typed — the
 * move `mapGrant` states for the HRIS import. Refused rather than clamped: a
 * revenue is the market approach's multiplicand, and a clamped one is a number
 * nobody chose sitting under a concluded value.
 */
export const MAX_REVENUE_CENTS = Number.MAX_SAFE_INTEGER;

/**
 * Whether a parsed revenue figure is one the engagement's params can hold.
 *
 * Negative is included, and it is not a hypothetical: a period whose credit
 * notes exceed its invoices reports a negative Total Income, which is a real
 * ledger answer and an impossible column value. Worse than the refusal, the
 * route derives `revenue_status` from the sign — `> 0 ? 'post_revenue' :
 * 'pre_revenue'` — so a trading company with a bad quarter was filed as
 * pre-revenue and valued as one.
 */
export function storableRevenueCents(cents: number | null): boolean {
  return cents === null || (Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_REVENUE_CENTS);
}

/**
 * Whether a parsed balance-sheet figure is one the asset approach can be run on
 * (round 265, methodology M6).
 *
 * Round 259 bounded the two revenue figures because they land in `bigint`
 * columns the params form already held to a rule. `total_assets_cents` and
 * `total_liabilities_cents` land somewhere with no rule at all — divided by a
 * hundred into `engine_inputs.asset`, a `jsonb` document — and they are not a
 * lesser figure for it: `approaches.asset_value` refuses to run NAV without
 * both, so these two *are* the asset approach, the same way revenue is the
 * market approach's multiplicand.
 *
 * `toCents` does not bound them, and cannot be read as if it does. It tests
 * `Number.isFinite` on the parsed cell and then multiplies by a hundred, so the
 * check is on the input and the overflow is in the output: a Total Assets of
 * `1e307` — finite, and a string a provider or an ingress rewriting one can put
 * in a cell — comes back `Infinity`. Two different wrong answers follow from
 * where the figure then goes, and neither says anything:
 *
 *   - `Infinity` is not representable in JSON, so `JSON.stringify` writes it as
 *     `null`. `inputs.asset.total_assets` is then *present and null*, the
 *     engine's `_require_number` reports "total_assets is required", and the
 *     analyst is told the ledger supplied no balance sheet by the import that
 *     read one.
 *   - a merely enormous figure — `1e300` parses to `1e302` cents and stores
 *     fine — is finite the whole way through. `_finite_result` guards the
 *     subtraction and passes, so NAV concludes an equity value of `1e300`,
 *     which is weighted into the conclusion with nothing anywhere calling it
 *     out of range.
 *
 * Refused rather than clamped, for the reason round 259 gives on revenue: a
 * clamped asset base is a number nobody chose sitting under a concluded value.
 * Sign is deliberately not part of the rule — the engine already reasons about
 * liabilities exceeding assets, and refusing a negative here would be this
 * module inventing a bound the approach does not have.
 */
export function storableLedgerCents(cents: number | null): boolean {
  return cents === null || Number.isSafeInteger(cents);
}

/** Did the parse find anything worth keeping? */
function hasAnyBalance(sheet: ImportedBalanceSheet): boolean {
  return (Object.keys(EMPTY_BALANCE_SHEET) as Array<keyof ImportedBalanceSheet>)
    .filter((k) => k !== 'as_of')
    .some((k) => sheet[k] !== null);
}

/**
 * Pull and parse the balance sheet.
 *
 * Separate from `fetchFinancials` so it can be tested against a provider
 * fixture on its own, and so the P&L path is unchanged when this throws.
 */
export async function fetchBalanceSheet(
  provider: AccountingProvider,
  tokens: { accessToken: string; externalOrgId: string | null },
  fetchFn: FetchFn = fetch,
): Promise<ImportedBalanceSheet> {
  const label = PROVIDER_LABELS[provider];
  if (provider === 'xero') {
    const res = await withDeadline(label, IMPORT_TIMEOUT_MS, (signal) =>
      fetchFn('https://api.xero.com/api.xro/2.0/Reports/BalanceSheet', {
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          accept: 'application/json',
          ...(tokens.externalOrgId ? { 'xero-tenant-id': tokens.externalOrgId } : {}),
        },
        signal,
      }),
    );
    if (!res.ok) throw providerRefused('Xero', 'balance sheet fetch', res);
    return parseXeroBalanceSheet(await readJson(res, label));
  }
  if (provider === 'quickbooks') {
    const realmId = tokens.externalOrgId;
    if (!realmId) throw new IntegrationError('QuickBooks connection is missing its realm id');
    const res = await withDeadline(label, IMPORT_TIMEOUT_MS, (signal) =>
      fetchFn(
        `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/reports/BalanceSheet`,
        {
          headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
          signal,
        },
      ),
    );
    if (!res.ok) throw providerRefused('QuickBooks', 'balance sheet fetch', res);
    return parseQuickBooksBalanceSheet(await readJson(res, label));
  }
  throw new IntegrationError(`${label} balance sheet import is not supported yet`);
}

/** The P&L half of an import. Its failure fails the import. */
async function fetchProfitAndLoss(
  provider: AccountingProvider,
  tokens: { accessToken: string; externalOrgId: string | null },
  fetchFn: FetchFn = fetch,
): Promise<ProfitAndLossSnapshot & { provider: AccountingProvider }> {
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
    if (!res.ok) throw providerRefused('Xero', 'report fetch', res);
    return { ...parseXeroProfitAndLoss(await readJson(res, PROVIDER_LABELS[provider])), provider };
  }
  if (provider === 'quickbooks') {
    // Held in a local because TypeScript drops the narrowing above once the
    // property is read inside a callback.
    const realmId = tokens.externalOrgId;
    if (!realmId) throw new IntegrationError('QuickBooks connection is missing its realm id');
    const res = await withDeadline(PROVIDER_LABELS[provider], IMPORT_TIMEOUT_MS, (signal) =>
      fetchFn(
        `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/reports/ProfitAndLoss`,
        {
          headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
          signal,
        },
      ),
    );
    if (!res.ok) throw providerRefused('QuickBooks', 'report fetch', res);
    return {
      ...parseQuickBooksProfitAndLoss(await readJson(res, PROVIDER_LABELS[provider])),
      provider,
    };
  }
  throw new IntegrationError(`${PROVIDER_LABELS[provider]} import is not supported yet`);
}

/**
 * Both statements, in one import.
 *
 * The P&L runs first and unguarded: it drives the revenue params and the
 * revenue-stage flag, so an import that cannot read it has failed and the
 * caller needs to know. The balance sheet is then attempted separately and its
 * failure is *recorded, not raised* — an org that has never run a balance
 * sheet, or names its subtotals unusually, should still get the revenue
 * import it asked for rather than an error page. `balance_sheet_error`
 * carries the reason so the reason is visible rather than inferred from a
 * null.
 *
 * Sequential rather than parallel on purpose: two concurrent report calls
 * against the same token are the shape that trips both providers' per-app
 * rate limits, and the balance sheet is worthless if the P&L already failed.
 */
export async function fetchFinancials(
  provider: AccountingProvider,
  tokens: { accessToken: string; externalOrgId: string | null },
  fetchFn: FetchFn = fetch,
): Promise<ImportedFinancials> {
  const pl = await fetchProfitAndLoss(provider, tokens, fetchFn);
  try {
    const sheet = await fetchBalanceSheet(provider, tokens, fetchFn);
    return {
      ...pl,
      // An all-null parse is a shape we did not recognise, not a company with
      // no assets. Reporting it as a balance sheet of nulls would put six
      // blank rows in front of an analyst with no hint that a parse ran.
      balance_sheet: hasAnyBalance(sheet) ? sheet : null,
      balance_sheet_error: hasAnyBalance(sheet)
        ? null
        : 'The balance sheet was retrieved but no recognised subtotals were found.',
    };
  } catch (err) {
    return {
      ...pl,
      balance_sheet: null,
      // Same vouching rule as the routes': `asRows`/`asRecord` above exist
      // because a shape these scrapers did not expect leaves a bare
      // `TypeError`, and this string is stored on the connection and shown to
      // the analyst as the balance sheet's reason. V8's wording is not a
      // reason; it is a bug report addressed to us.
      balance_sheet_error: describeConnectorFailure(
        err,
        'the balance sheet could not be read, and the reason was not the provider — it is in the service log',
      ),
    };
  }
}
