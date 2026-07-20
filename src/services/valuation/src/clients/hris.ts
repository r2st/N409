/**
 * HRIS / payroll integrations for ASC 718 (feature 11): OAuth2 connect + pull
 * of the employee roster and equity grants from Rippling, Gusto and Deel,
 * mapped onto the grant shape ASC 718 management consumes (repos/grants.ts).
 * Mirrors the accounting / cap-table sync clients. All HTTP goes through an
 * injectable fetch.
 */

export const HRIS_PROVIDERS = ['rippling', 'gusto', 'deel'] as const;
export type HrisProvider = (typeof HRIS_PROVIDERS)[number];

export const HRIS_PROVIDER_LABELS: Record<HrisProvider, string> = {
  rippling: 'Rippling',
  gusto: 'Gusto',
  deel: 'Deel',
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

const ENDPOINTS: Record<HrisProvider, OAuthEndpoints> = {
  rippling: {
    authorizeUrl: 'https://app.rippling.com/apps/PLATFORM/oauth/authorize',
    tokenUrl: 'https://app.rippling.com/api/o/token/',
    apiBase: 'https://api.rippling.com',
    scope: 'company:read employee:read equity:read',
  },
  gusto: {
    authorizeUrl: 'https://api.gusto.com/oauth/authorize',
    tokenUrl: 'https://api.gusto.com/oauth/token',
    apiBase: 'https://api.gusto.com',
    scope: 'employees:read companies:read',
  },
  deel: {
    authorizeUrl: 'https://app.deel.com/oauth2/authorize',
    tokenUrl: 'https://app.deel.com/oauth2/tokens',
    apiBase: 'https://api.letsdeel.com',
    scope: 'people:read equity:read',
  },
};

export function authorizeUrl(
  provider: HrisProvider,
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
  provider: HrisProvider,
  creds: ProviderCredentials,
  redirectUri: string,
  code: string,
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  const e = ENDPOINTS[provider];
  const res = await fetchFn(e.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`${HRIS_PROVIDER_LABELS[provider]} token exchange failed (${res.status})`);
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) throw new Error(`${HRIS_PROVIDER_LABELS[provider]} returned no access token`);
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
const toDate = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

export interface RosterEmployee {
  external_id: string;
  name: string;
  email: string | null;
  title: string | null;
  status: string | null;
}

/** A grant mapped to the ASC 718 grant shape; external_id makes re-sync idempotent. */
export interface MappedGrant {
  external_id: string;
  grantee_name: string;
  grantee_email: string | null;
  grant_date: string;
  options_count: number;
  exercise_price: number;
  vesting_start_date: string;
  vesting_months: number;
  cliff_months: number;
  frequency_months: number;
}

export interface HrisPull {
  provider: HrisProvider;
  external_company_name: string | null;
  roster: RosterEmployee[];
  grants: MappedGrant[];
}

/**
 * Normalise a provider equity grant into the ASC 718 grant shape. Providers
 * expose vesting as {months, cliff, frequency}; sensible 48/12/1 defaults fill
 * gaps (the analyst can adjust after import).
 */
function mapGrant(raw: Record<string, unknown>, granteeName: string, granteeEmail: string | null): MappedGrant | null {
  const options = toNum(raw.optionsGranted ?? raw.shares ?? raw.quantity);
  const grantDate = toDate(raw.grantDate ?? raw.issueDate ?? raw.date);
  const externalId = String(raw.id ?? raw.grantId ?? '').trim();
  if (!options || options <= 0 || !grantDate || !externalId) return null;
  const vesting = (raw.vesting ?? raw.vestingSchedule ?? {}) as Record<string, unknown>;
  return {
    external_id: externalId,
    grantee_name: granteeName,
    grantee_email: granteeEmail,
    grant_date: grantDate,
    options_count: Math.round(options),
    exercise_price: toNum(raw.strikePrice ?? raw.exercisePrice) ?? 0,
    vesting_start_date: toDate(vesting.startDate ?? raw.vestingStartDate) ?? grantDate,
    vesting_months: toNum(vesting.months ?? vesting.durationMonths) ?? 48,
    cliff_months: toNum(vesting.cliffMonths ?? vesting.cliff) ?? 12,
    frequency_months: toNum(vesting.frequencyMonths ?? vesting.frequency) ?? 1,
  };
}

/**
 * All three providers expose a company employees list where each employee may
 * carry an `equityGrants` array. We flatten to a roster + a grant list. The
 * shapes are close enough that one mapper covers them with lenient field names.
 */
export function mapEmployees(payload: unknown): { roster: RosterEmployee[]; grants: MappedGrant[] } {
  const p = payload as { employees?: Array<Record<string, unknown>>; people?: Array<Record<string, unknown>> };
  const people = p.employees ?? p.people ?? [];
  const roster: RosterEmployee[] = [];
  const grants: MappedGrant[] = [];
  for (const emp of people) {
    const name =
      String(emp.fullName ?? emp.name ?? [emp.firstName, emp.lastName].filter(Boolean).join(' ')).trim() ||
      'Unknown';
    const email = typeof emp.workEmail === 'string' ? emp.workEmail : typeof emp.email === 'string' ? emp.email : null;
    roster.push({
      external_id: String(emp.id ?? emp.employeeId ?? email ?? name),
      name,
      email,
      title: typeof emp.title === 'string' ? emp.title : typeof emp.jobTitle === 'string' ? emp.jobTitle : null,
      status:
        (typeof emp.status === 'string' && emp.status) ||
        (typeof emp.employmentStatus === 'string' && emp.employmentStatus) ||
        null,
    });
    const empGrants = (emp.equityGrants ?? emp.grants ?? emp.equity) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(empGrants)) {
      for (const g of empGrants) {
        const mapped = mapGrant(g, name, email);
        if (mapped) grants.push(mapped);
      }
    }
  }
  return { roster, grants };
}

export async function fetchRosterAndGrants(
  provider: HrisProvider,
  tokens: { accessToken: string; externalCompanyId: string | null; externalCompanyName: string | null },
  fetchFn: FetchFn = fetch,
): Promise<HrisPull> {
  const e = ENDPOINTS[provider];
  const res = await fetchFn(`${e.apiBase}/v1/employees?include=equity`, {
    headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${HRIS_PROVIDER_LABELS[provider]} roster fetch failed (${res.status})`);
  const payload = (await res.json()) as Record<string, unknown>;
  const { roster, grants } = mapEmployees(payload);
  return {
    provider,
    external_company_name:
      (payload.companyName as string | undefined) ?? tokens.externalCompanyName ?? null,
    roster,
    grants,
  };
}
