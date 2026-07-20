/**
 * Live cap-table sync providers (feature 4): OAuth2 connect + cap-table pull
 * for Carta and Pulley, mirroring the accounting integration (clients/
 * accounting.ts). Each provider is config-gated by an env client id/secret; an
 * unconfigured provider shows as "not configured" and its routes 503.
 *
 * The pull maps each provider's cap-table payload — share classes, outstanding
 * shares, the option pool, and convertible notes — onto the canonical
 * CapTableEntry shape (domain/capTable.ts) so the result feeds the same
 * validation and waterfall path as a CSV import. All HTTP goes through an
 * injectable fetch so tests never touch the network.
 */

import type { CapTableEntry, CapTableClassType } from '../domain/capTable.js';

export const CAP_TABLE_PROVIDERS = ['carta', 'pulley'] as const;
export type CapTableProvider = (typeof CAP_TABLE_PROVIDERS)[number];

export const CAP_TABLE_PROVIDER_LABELS: Record<CapTableProvider, string> = {
  carta: 'Carta',
  pulley: 'Pulley',
};

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  externalCompanyId?: string | null;
  externalCompanyName?: string | null;
}

export type FetchFn = typeof fetch;

interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  apiBase: string;
  scope: string;
}

const ENDPOINTS: Record<CapTableProvider, OAuthEndpoints> = {
  carta: {
    authorizeUrl: 'https://login.carta.com/oauth/authorize',
    tokenUrl: 'https://login.carta.com/oauth/token',
    apiBase: 'https://api.carta.com',
    scope: 'read:capitalization read:company offline_access',
  },
  pulley: {
    authorizeUrl: 'https://app.pulley.com/oauth/authorize',
    tokenUrl: 'https://api.pulley.com/oauth/token',
    apiBase: 'https://api.pulley.com',
    scope: 'read_cap_table read_company offline_access',
  },
};

export function authorizeUrl(
  provider: CapTableProvider,
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
  company_id?: string;
  company_name?: string;
}

export async function exchangeCode(
  provider: CapTableProvider,
  creds: ProviderCredentials,
  redirectUri: string,
  code: string,
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  const e = ENDPOINTS[provider];
  const res = await fetchFn(e.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`${CAP_TABLE_PROVIDER_LABELS[provider]} token exchange failed (${res.status})`);
  }
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) {
    throw new Error(`${CAP_TABLE_PROVIDER_LABELS[provider]} returned no access token`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    externalCompanyId: body.company_id ?? null,
    externalCompanyName: body.company_name ?? null,
  };
}

const toNum = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** A normalized cap-table pull: canonical entries + a couple of headline facts. */
export interface PulledCapTable {
  provider: CapTableProvider;
  external_company_name: string | null;
  entries: CapTableEntry[];
  as_of: string | null;
}

const CLASS_TYPES: ReadonlySet<string> = new Set(['common', 'preferred', 'option', 'warrant']);

function normalizeType(raw: unknown, name: string): CapTableClassType {
  const t = String(raw ?? '').toLowerCase();
  if (CLASS_TYPES.has(t)) return t as CapTableClassType;
  if (/option|pool|isos?|nso/.test(t) || /option|pool/.test(name.toLowerCase())) return 'option';
  if (/warrant|note|safe|convertible/.test(t + ' ' + name.toLowerCase())) return t.includes('warrant') ? 'warrant' : 'preferred';
  if (/preferred|series|seed/.test(t + ' ' + name.toLowerCase())) return 'preferred';
  return 'common';
}

/**
 * Carta capitalization payload → entries. Carta groups the cap table into
 * shareClasses (common/preferred), optionPools, warrants and convertibles;
 * convertible notes are represented as preferred-like preference-bearing rows.
 */
export function mapCarta(payload: unknown): CapTableEntry[] {
  const p = payload as {
    shareClasses?: Array<Record<string, unknown>>;
    optionPools?: Array<Record<string, unknown>>;
    warrants?: Array<Record<string, unknown>>;
    convertibles?: Array<Record<string, unknown>>;
  };
  const entries: CapTableEntry[] = [];

  for (const c of p.shareClasses ?? []) {
    const name = String(c.name ?? c.className ?? '').trim();
    if (!name) continue;
    entries.push({
      security_class: name,
      class_type: normalizeType(c.type ?? c.classType, name),
      shares: toNum(c.outstandingShares ?? c.shares) ?? 0,
      price_per_share: toNum(c.issuePrice ?? c.pricePerShare),
      invested_amount: toNum(c.amountInvested ?? c.invested),
      liquidation_multiple: toNum(c.liquidationPreference ?? c.liquidationMultiple),
      seniority: toNum(c.seniority),
      conversion_ratio: toNum(c.conversionRatio),
    });
  }
  for (const o of p.optionPools ?? []) {
    entries.push({
      security_class: String(o.name ?? 'Option Pool').trim(),
      class_type: 'option',
      shares: toNum(o.outstandingShares ?? o.reservedShares ?? o.shares) ?? 0,
      price_per_share: toNum(o.strikePrice ?? o.exercisePrice),
      invested_amount: null,
      liquidation_multiple: null,
      seniority: null,
      conversion_ratio: null,
    });
  }
  for (const w of p.warrants ?? []) {
    entries.push({
      security_class: String(w.name ?? 'Warrants').trim(),
      class_type: 'warrant',
      shares: toNum(w.shares ?? w.outstandingShares) ?? 0,
      price_per_share: toNum(w.strikePrice ?? w.exercisePrice),
      invested_amount: null,
      liquidation_multiple: null,
      seniority: null,
      conversion_ratio: null,
    });
  }
  // Convertible notes / SAFEs carry a principal that seniorities into the
  // preference stack — model them as preferred with a 1× preference.
  for (const cv of p.convertibles ?? []) {
    entries.push({
      security_class: String(cv.name ?? 'Convertible Note').trim(),
      class_type: 'preferred',
      shares: toNum(cv.shares) ?? 0,
      price_per_share: toNum(cv.pricePerShare),
      invested_amount: toNum(cv.principal ?? cv.amount ?? cv.invested),
      liquidation_multiple: toNum(cv.liquidationMultiple) ?? 1,
      seniority: toNum(cv.seniority),
      conversion_ratio: toNum(cv.conversionRatio),
    });
  }
  return entries;
}

/**
 * Pulley cap-table payload → entries. Pulley returns a flat `securities` list
 * tagged by `securityType`; convertible instruments live under `convertibles`.
 */
export function mapPulley(payload: unknown): CapTableEntry[] {
  const p = payload as {
    securities?: Array<Record<string, unknown>>;
    convertibles?: Array<Record<string, unknown>>;
  };
  const entries: CapTableEntry[] = [];
  for (const s of p.securities ?? []) {
    const name = String(s.shareClass ?? s.name ?? '').trim();
    if (!name) continue;
    entries.push({
      security_class: name,
      class_type: normalizeType(s.securityType ?? s.type, name),
      shares: toNum(s.sharesOutstanding ?? s.shares) ?? 0,
      price_per_share: toNum(s.pricePerShare ?? s.issuePrice ?? s.strikePrice),
      invested_amount: toNum(s.totalInvested ?? s.invested),
      liquidation_multiple: toNum(s.liquidationMultiple ?? s.liquidationPreference),
      seniority: toNum(s.seniority),
      conversion_ratio: toNum(s.conversionRatio),
    });
  }
  for (const cv of p.convertibles ?? []) {
    entries.push({
      security_class: String(cv.name ?? 'Convertible').trim(),
      class_type: 'preferred',
      shares: toNum(cv.shares) ?? 0,
      price_per_share: toNum(cv.pricePerShare),
      invested_amount: toNum(cv.principal ?? cv.amount),
      liquidation_multiple: toNum(cv.liquidationMultiple) ?? 1,
      seniority: toNum(cv.seniority),
      conversion_ratio: toNum(cv.conversionRatio),
    });
  }
  return entries;
}

export async function fetchCapTable(
  provider: CapTableProvider,
  tokens: { accessToken: string; externalCompanyId: string | null; externalCompanyName: string | null },
  fetchFn: FetchFn = fetch,
): Promise<PulledCapTable> {
  const e = ENDPOINTS[provider];
  const company = tokens.externalCompanyId ? encodeURIComponent(tokens.externalCompanyId) : '';
  const url =
    provider === 'carta'
      ? `${e.apiBase}/v1/companies/${company}/capitalization`
      : `${e.apiBase}/v1/companies/${company}/cap-table`;
  const res = await fetchFn(url, {
    headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`${CAP_TABLE_PROVIDER_LABELS[provider]} cap-table fetch failed (${res.status})`);
  }
  const payload = (await res.json()) as Record<string, unknown>;
  const entries = provider === 'carta' ? mapCarta(payload) : mapPulley(payload);
  return {
    provider,
    external_company_name:
      (payload.companyName as string | undefined) ?? tokens.externalCompanyName ?? null,
    entries,
    as_of: (payload.asOf as string | undefined) ?? (payload.as_of as string | undefined) ?? null,
  };
}
