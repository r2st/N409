/**
 * HRIS / payroll integrations for ASC 718 (feature 11): OAuth2 connect + pull
 * of the employee roster and equity grants from Rippling, Gusto and Deel,
 * mapped onto the grant shape ASC 718 management consumes (repos/grants.ts).
 * Mirrors the accounting / cap-table sync clients. All HTTP goes through an
 * injectable fetch.
 */

import { isIsoCalendarDate } from '@n409/shared';
import { isStorableEmail, MAX_EMAIL_LENGTH } from '../domain/email.js';
import { INT4_MAX } from '../domain/int4.js';
import { clampScheduleMonths } from '../domain/vesting.js';
import {
  IMPORT_TIMEOUT_MS,
  IntegrationError,
  OAUTH_TIMEOUT_MS,
  ReconnectRequiredError,
  providerRefused,
  readJson,
  withDeadline,
} from './deadline.js';

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
  const res = await withDeadline(HRIS_PROVIDER_LABELS[provider], OAUTH_TIMEOUT_MS, (signal) =>
    fetchFn(e.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
      signal,
    }),
  );
  if (!res.ok)
    throw new IntegrationError(`${HRIS_PROVIDER_LABELS[provider]} token exchange failed (${res.status})`);
  const body = (await readJson(res, HRIS_PROVIDER_LABELS[provider])) as TokenResponse;
  if (!body.access_token)
    throw new IntegrationError(`${HRIS_PROVIDER_LABELS[provider]} returned no access token`);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    // Both go straight onto `hris_connections` as `text`; both are whatever the
    // provider's token response had at those keys, cast rather than checked.
    externalCompanyId: storableText(body.company_id, MAX_COMPANY_NAME),
    externalCompanyName: storableText(body.company_name, MAX_COMPANY_NAME),
  };
}

/**
 * How long before a stored access token expires we stop trusting it.
 *
 * A roster pull is a 30-second call against a provider doing real work, and a
 * token that expires while it is in flight fails the whole sync. Ninety
 * seconds covers the call plus ordinary clock skew between this box and the
 * provider's auth server, which is the other half of why a token that is
 * "still valid for four seconds" is not.
 */
export const TOKEN_REFRESH_SKEW_MS = 90_000;

/**
 * Spend the stored refresh token for a new access token.
 *
 * The counterpart to `exchangeCode`, and the reason this file has a reason to
 * read the `refresh_token` column at all — see {@link ReconnectRequiredError}
 * for what its absence cost.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO.
 *
 * It does not invent an expiry. A refresh response without `expires_in` leaves
 * `expiresAt` null, which the caller reads as "unknown" and therefore stops
 * refreshing proactively; guessing an hour would be a number nobody chose
 * governing when we hand a provider a credential.
 *
 * It does not report the absence of a rotated refresh token as a null. Most
 * providers answer a refresh with `access_token` alone and expect the caller
 * to keep using the refresh token it already had; a few rotate it on every
 * use. Returning `null` for the first group and having the repo write it would
 * erase the only credential that can renew the connection — turning a
 * successful refresh into the last one that will ever work. `undefined` here
 * means "unchanged", and `updateTokens` writes only what it is given.
 */
export async function refreshTokens(
  provider: HrisProvider,
  creds: ProviderCredentials,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<{ accessToken: string; refreshToken: string | undefined; expiresAt: Date | null }> {
  const label = HRIS_PROVIDER_LABELS[provider];
  const e = ENDPOINTS[provider];
  const res = await withDeadline(label, OAUTH_TIMEOUT_MS, (signal) =>
    fetchFn(e.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
      signal,
    }),
  );
  if (!res.ok) {
    // RFC 6749 §5.2: the token endpoint answers `400 invalid_grant` for a
    // refresh token that has been revoked or has expired, and `401
    // invalid_client` for credentials this deployment can no longer use.
    // Neither improves on the next tick, and retrying either is how a dead
    // connection becomes a dead connection we call every fifteen minutes
    // forever. Everything else — a 5xx, a gateway — is the provider being
    // briefly unwell, and keeps the wording every other refusal here has.
    if (res.status === 400 || res.status === 401) {
      throw new ReconnectRequiredError(
        `${label} no longer accepts the stored authorisation — reconnect ${label} to resume syncing.`,
      );
    }
    throw providerRefused(label, 'token refresh', res);
  }
  const body = (await readJson(res, label)) as TokenResponse;
  if (!body.access_token) throw new IntegrationError(`${label} returned no access token`);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
  };
}

const toNum = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
/**
 * A provider's date, at day resolution, or null when it is not a day.
 *
 * `/^\d{4}-\d{2}-\d{2}$/` is a shape check, and the shape admits days that do
 * not exist: `2026-02-31`, `2026-13-01`, `2026-02-29` in a common year. Every
 * route that accepts a date pairs the shape with `isIsoCalendarDate` for
 * exactly this reason — and this path, which takes its dates from a third
 * party rather than from a form, was the one that did not.
 *
 * `grant_date` and `vesting_start_date` are `date NOT NULL` columns, so an
 * impossible day is not a wrong number that gets stored; it is an error raised
 * by the driver inside `syncHrisConnection`'s insert loop. That loop has no
 * catch of its own, so one malformed day from a provider ends the sync with
 * the grants before it already committed and the ones after it never
 * attempted — and neither `recordSync` nor `recordSyncError` is reached, so
 * the connection's next-due is never advanced and no error is shown against
 * it. The scheduled sweep then finds it due again every pass and fails it
 * again, silently, forever.
 *
 * Rejecting here makes an impossible day behave like an absent one: `mapGrant`
 * already drops a grant with no usable date, along with one that has no
 * options or no external id. That is the same move `clampScheduleMonths` makes
 * just below — hold the import to the rule `POST /grants` enforces, because a
 * provider's payload is no more trustworthy than a form's.
 */
const toDate = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = v.slice(0, 10);
  return isIsoCalendarDate(d) ? d : null;
};

/**
 * The bounds `POST /api/v1/valuations/:id/grants` enforces in zod, applied to
 * the payload a provider sends.
 *
 * `toDate` and `clampScheduleMonths` above each state the rule this block
 * generalises: *hold the import to what the form is held to, because a
 * provider's payload is no more trustworthy than a form's*. Those two covered
 * the date and the three month figures. The rest of the grant went from the
 * provider's JSON into the INSERT unmeasured, and every one of the following
 * is a row Postgres refuses rather than a number that is merely wrong:
 *
 *   `options_count integer NOT NULL CHECK (> 0)` — `shares: 1e300` maps to
 *     `Math.round(1e300)` and arrives as `22003 value out of range for type
 *     integer`.
 *   `exercise_price numeric NOT NULL CHECK (>= 0)` — a negative strike is a
 *     check violation.
 *   `option_grants_external_idx` is a unique b-tree over
 *     `(valuation_id, external_id)`, so an id past roughly 2.7 KB fails with
 *     `54000 index row size exceeds btree version 4 maximum`.
 *   `U+0000` in any text has no UTF-8 encoding Postgres accepts — the estate
 *     refuses it on the way in (`domain/nulBytes.ts`), and that hook guards
 *     *request* bodies. This is the path where text arrives from outside
 *     without passing it.
 *
 * What each of those costs is the same thing, and it is not one bad grant.
 * `syncHrisConnection` inserts in a loop; a row the driver refuses throws out
 * of it, so the grants before it stay written, the grants after it are never
 * attempted, and the connection is left in `error` with a count instead of a
 * roster. One malformed record in a directory of four hundred stops the
 * import, every time it is retried, until somebody edits the provider's data.
 *
 * So a grant that cannot be stored is dropped here, where `mapGrant` already
 * drops one with no date, no options or no external id — and the number
 * dropped is counted and reported (`HrisSyncOutcome.grants_rejected`) rather
 * than being a silence the analyst has to notice.
 */
const MAX_GRANTEE_NAME = 200;
const MAX_EXTERNAL_ID = 255;
const MAX_EXERCISE_PRICE = 1e9;
/** `hris_connections.external_company_name`, which no index covers. */
const MAX_COMPANY_NAME = 255;

/**
 * A provider string this platform will store, trimmed — or null.
 *
 * Null rather than a truncation, for the reason `extractIdentity` gives about
 * SAML claims: half a value presented as whole is the silent corruption this
 * codebase avoids elsewhere. What null then *means* is the caller's decision —
 * a missing company name is cosmetic, a missing external id makes the grant
 * unimportable — which is why this returns the absence rather than deciding.
 */
function storableText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed.includes('\u0000') ? null : trimmed;
}

/**
 * Anything the mapper is handed that should be a list of records.
 *
 * `payload.employees` is whatever the provider's JSON had at that key, and
 * `for (const emp of people)` on an object threw `people is not iterable`
 * while a `null` element threw `Cannot read properties of null`. Both escaped
 * `mapEmployees` into `fetchRosterAndGrants`'s caller, which records
 * `describeTransportFailure(err)` on the connection — so a shape the mapper
 * could not walk was written to `last_error`, shown to the analyst verbatim by
 * `toPublic`, and attributed to the *transport*: "Cannot read properties of
 * null (reading 'fullName')" on screen, under a connection that reads as a
 * network problem.
 */
function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

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
  /** Grants the provider sent that this platform will not store. */
  rejected: number;
}

/**
 * Normalise a provider equity grant into the ASC 718 grant shape. Providers
 * expose vesting as {months, cliff, frequency}; sensible 48/12/1 defaults fill
 * gaps (the analyst can adjust after import).
 */
function mapGrant(
  raw: Record<string, unknown>,
  granteeName: string,
  granteeEmail: string | null,
): MappedGrant | null {
  const options = toNum(raw.optionsGranted ?? raw.shares ?? raw.quantity);
  const grantDate = toDate(raw.grantDate ?? raw.issueDate ?? raw.date);
  // `String(raw.id)` turned an object into `"[object Object]"` and a 5 KB
  // string into a b-tree the index cannot take. The id is what makes a re-sync
  // idempotent, so an unstorable one is not a field to drop — it is a grant
  // that would be re-imported on every pass.
  const externalId = storableText(raw.id ?? raw.grantId, MAX_EXTERNAL_ID);
  if (!options || options <= 0 || !grantDate || !externalId) return null;
  // `Math.round` first, because that is the value the column receives:
  // `1e300` is a perfectly finite number and an `integer` it is not.
  const optionsCount = Math.round(options);
  if (!Number.isSafeInteger(optionsCount) || optionsCount < 1 || optionsCount > INT4_MAX) return null;
  // `grantee_name` is `NOT NULL`, so an unstorable one has nothing to fall back
  // to; the manual route bounds it at 200 and so does this.
  const name = storableText(granteeName, MAX_GRANTEE_NAME);
  if (!name) return null;
  // The strike is a `numeric CHECK (>= 0)` and the form stops at 1e9. Refused
  // rather than clamped: a price is the grant's economics, and a clamped one is
  // a number nobody chose sitting in an ASC 718 expense calculation.
  const exercisePrice = toNum(raw.strikePrice ?? raw.exercisePrice) ?? 0;
  if (exercisePrice < 0 || exercisePrice > MAX_EXERCISE_PRICE) return null;
  const vesting = (raw.vesting ?? raw.vestingSchedule ?? {}) as Record<string, unknown>;
  // Bounded to the same range the grant routes enforce in zod. This path wrote
  // whatever the provider sent straight onto the row, so a schedule `POST
  // /grants` refuses — a negative cadence, a cliff past the end of the vest, a
  // `vesting.months` of 2,000,000 — was importable, and the grant page then
  // builds one timeline point per cadence step from it.
  const months = clampScheduleMonths({
    vestingMonths: toNum(vesting.months ?? vesting.durationMonths) ?? undefined,
    cliffMonths: toNum(vesting.cliffMonths ?? vesting.cliff) ?? undefined,
    frequencyMonths: toNum(vesting.frequencyMonths ?? vesting.frequency) ?? undefined,
  });
  return {
    external_id: externalId,
    grantee_name: name,
    // Nulled rather than refused, unlike the name: the column is nullable, the
    // manual route accepts a grant without one, and an address that is not an
    // address identifies nobody — so the grant is still worth importing and the
    // absence is visible on the row.
    grantee_email: granteeEmail,
    grant_date: grantDate,
    options_count: optionsCount,
    exercise_price: exercisePrice,
    vesting_start_date: toDate(vesting.startDate ?? raw.vestingStartDate) ?? grantDate,
    vesting_months: months.vestingMonths,
    cliff_months: months.cliffMonths,
    frequency_months: months.frequencyMonths,
  };
}

/**
 * All three providers expose a company employees list where each employee may
 * carry an `equityGrants` array. We flatten to a roster + a grant list. The
 * shapes are close enough that one mapper covers them with lenient field names.
 */
export function mapEmployees(payload: unknown): {
  roster: RosterEmployee[];
  grants: MappedGrant[];
  /** Grants the provider sent that this platform will not store — see the bounds above. */
  rejected: number;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const people = records(p.employees ?? p.people);
  const roster: RosterEmployee[] = [];
  const grants: MappedGrant[] = [];
  let rejected = 0;
  for (const emp of people) {
    const name =
      String(emp.fullName ?? emp.name ?? [emp.firstName, emp.lastName].filter(Boolean).join(' ')).trim() ||
      'Unknown';
    // An address the platform can store, or none. `grantee_email` is what a
    // notice and an auditor's workbook are addressed to, and `email` on a
    // provider record is free text: `mapEmployees` used to pass through
    // `"n/a"`, an empty-domain address, or four kilobytes of one.
    const claimed = emp.workEmail ?? emp.email;
    const email = isStorableEmail(storableText(claimed, MAX_EMAIL_LENGTH)) ? String(claimed).trim() : null;
    roster.push({
      external_id: String(emp.id ?? emp.employeeId ?? email ?? name),
      name,
      email,
      title:
        typeof emp.title === 'string' ? emp.title : typeof emp.jobTitle === 'string' ? emp.jobTitle : null,
      status:
        (typeof emp.status === 'string' && emp.status) ||
        (typeof emp.employmentStatus === 'string' && emp.employmentStatus) ||
        null,
    });
    for (const g of records(emp.equityGrants ?? emp.grants ?? emp.equity)) {
      const mapped = mapGrant(g, name, email);
      if (mapped) grants.push(mapped);
      else rejected++;
    }
  }
  return { roster, grants, rejected };
}

export async function fetchRosterAndGrants(
  provider: HrisProvider,
  tokens: { accessToken: string; externalCompanyId: string | null; externalCompanyName: string | null },
  fetchFn: FetchFn = fetch,
): Promise<HrisPull> {
  const e = ENDPOINTS[provider];
  const res = await withDeadline(HRIS_PROVIDER_LABELS[provider], IMPORT_TIMEOUT_MS, (signal) =>
    fetchFn(`${e.apiBase}/v1/employees?include=equity`, {
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
      signal,
    }),
  );
  if (!res.ok)
    throw new IntegrationError(`${HRIS_PROVIDER_LABELS[provider]} roster fetch failed (${res.status})`);
  const payload = await readJson(res, HRIS_PROVIDER_LABELS[provider]);
  const { roster, grants, rejected } = mapEmployees(payload);
  return {
    provider,
    // The cast said this was a string; `readJson` guarantees an object and
    // nothing about its fields, so a `companyName` that is an object reached
    // `hris_connections.external_company_name` as whatever the driver made of
    // it, and one of any length reached a `text` column unmeasured.
    external_company_name:
      storableText(payload.companyName, MAX_COMPANY_NAME) ?? tokens.externalCompanyName ?? null,
    roster,
    grants,
    rejected,
  };
}
