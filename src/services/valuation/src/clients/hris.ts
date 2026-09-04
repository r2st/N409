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
import { clampScheduleMonths, MAX_GRANTEE_NAME } from '../domain/vesting.js';
import {
  pagedPullBudget,
  IntegrationError,
  MAX_PROVIDER_PAGES,
  nextPageUrl,
  OAUTH_TIMEOUT_MS,
  providerRefused,
  providerSaysMore,
  readJson,
  storableProviderText,
  withDeadline,
} from './deadline.js';
import { refreshOAuthTokens, type RefreshedTokens } from './oauthRefresh.js';

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
  if (!res.ok) throw providerRefused(HRIS_PROVIDER_LABELS[provider], 'token exchange', res);
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
 * Spend the stored refresh token for a new access token.
 *
 * The counterpart to `exchangeCode`, and the reason this file has a reason to
 * read the `refresh_token` column at all. The exchange itself, and the rule
 * about which refusals a retry can clear, live in `clients/oauthRefresh.ts` —
 * they are identical at all three connector families and were worth writing
 * once.
 */
export async function refreshTokens(
  provider: HrisProvider,
  creds: ProviderCredentials,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<RefreshedTokens> {
  return refreshOAuthTokens({
    label: HRIS_PROVIDER_LABELS[provider],
    tokenUrl: ENDPOINTS[provider].tokenUrl,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken,
    fetchFn,
  });
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
const MAX_EXTERNAL_ID = 255;
const MAX_EXERCISE_PRICE = 1e9;
/** `hris_connections.external_company_name`, which no index covers. */
const MAX_COMPANY_NAME = 255;

/**
 * A provider string this platform will store, trimmed — or null.
 *
 * The rule now lives in `clients/deadline.ts` beside `readJson`, because it is
 * the same rule at all three connector families and this one was the only file
 * that had it. It also gained a case this copy was missing: a *lone surrogate*
 * is refused by Postgres in a `jsonb` column exactly as a NUL is, and
 * `external_company_name` reaches one — `recordSync`'s summary — after the
 * grants have already been imported. See `storableProviderText`.
 */
const storableText = storableProviderText;

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
  /**
   * Which of them, and why — a prefix, capped at {@link MAX_REJECTED_DETAIL}.
   * `rejected` alone tells an analyst a number came up short of what the
   * provider reported and nothing about which employee to go check, and a
   * roster is exactly the population where "5 of 400" is not a search an
   * analyst can do by eye.
   */
  rejectedDetail: RejectedGrant[];
  /** True when `rejected` is larger than `rejectedDetail.length`. */
  rejectedDetailTruncated: boolean;
}

/** One grant the provider sent that this platform declined to store. */
export interface RejectedGrant {
  employee: string;
  /** Storable form of the provider's own id, when it had one worth keeping. */
  external_id: string | null;
  reason: string;
}

/** Named examples are a display list, not the accounting figure — capped like every other one. */
const MAX_REJECTED_DETAIL = 20;

/**
 * Normalise a provider equity grant into the ASC 718 grant shape. Providers
 * expose vesting as {months, cliff, frequency}; sensible 48/12/1 defaults fill
 * gaps (the analyst can adjust after import).
 *
 * Returns the reason for a grant this function declines, rather than a bare
 * `null`: the checks below are independent facts about the provider's record,
 * and the reason is what turns `rejectedDetail` from a name with no diagnosis
 * into something an analyst can go fix at the source.
 */
function mapGrant(
  raw: Record<string, unknown>,
  granteeName: string,
  granteeEmail: string | null,
): { grant: MappedGrant } | { reason: string } {
  const options = toNum(raw.optionsGranted ?? raw.shares ?? raw.quantity);
  const grantDate = toDate(raw.grantDate ?? raw.issueDate ?? raw.date);
  // `String(raw.id)` turned an object into `"[object Object]"` and a 5 KB
  // string into a b-tree the index cannot take. The id is what makes a re-sync
  // idempotent, so an unstorable one is not a field to drop — it is a grant
  // that would be re-imported on every pass.
  const externalId = storableText(raw.id ?? raw.grantId, MAX_EXTERNAL_ID);
  if (!options || options <= 0) return { reason: 'no option count on the record, or zero' };
  if (!grantDate) return { reason: 'no usable grant date' };
  if (!externalId) return { reason: "the provider's id for this grant could not be stored" };
  // `Math.round` first, because that is the value the column receives:
  // `1e300` is a perfectly finite number and an `integer` it is not.
  const optionsCount = Math.round(options);
  if (!Number.isSafeInteger(optionsCount) || optionsCount < 1 || optionsCount > INT4_MAX)
    return { reason: 'option count is out of range' };
  // `grantee_name` is `NOT NULL`, so an unstorable one has nothing to fall back
  // to; the manual route bounds it at 200 and so does this.
  const name = storableText(granteeName, MAX_GRANTEE_NAME);
  if (!name) return { reason: 'the employee name could not be stored' };
  // The strike is a `numeric CHECK (>= 0)` and the form stops at 1e9. Refused
  // rather than clamped: a price is the grant's economics, and a clamped one is
  // a number nobody chose sitting in an ASC 718 expense calculation.
  const exercisePrice = toNum(raw.strikePrice ?? raw.exercisePrice) ?? 0;
  if (exercisePrice < 0 || exercisePrice > MAX_EXERCISE_PRICE)
    return { reason: 'exercise price is negative or implausibly large' };
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
    grant: {
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
    },
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
  /** Which of them, and why — a prefix. See {@link RejectedGrant}. */
  rejectedDetail: RejectedGrant[];
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const people = records(p.employees ?? p.people);
  const roster: RosterEmployee[] = [];
  const grants: MappedGrant[] = [];
  const rejectedDetail: RejectedGrant[] = [];
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
      if ('grant' in mapped) {
        grants.push(mapped.grant);
      } else {
        rejected++;
        if (rejectedDetail.length < MAX_REJECTED_DETAIL) {
          rejectedDetail.push({
            // `name` is the raw provider string, and this is a report going
            // out to a jsonb column and a JSON body — the same "what this
            // platform can store" question `mapGrant` already asked of it,
            // which is why the fallback below is exactly the record whose
            // own name was the reason for the rejection.
            employee: storableText(name, MAX_GRANTEE_NAME) ?? '(name could not be stored)',
            external_id: storableText(g.id ?? g.grantId, MAX_EXTERNAL_ID),
            reason: mapped.reason,
          });
        }
      }
    }
  }
  return { roster, grants, rejected, rejectedDetail };
}

/**
 * Every page of the provider's employee list, or a refusal saying it did not
 * fit.
 *
 * This asked once and mapped the answer. Nothing in these three APIs promises
 * that one request is the whole roster — all of them page, at defaults in the
 * tens — so a company past that default imported a *prefix* of its employees
 * and every figure downstream said so with the wording it uses for a complete
 * pull: `roster_count`, `grants_found`, and an ASC 718 expense struck over the
 * options it had seen.
 *
 * Silent is the part that makes it worth a round. A truncated import looks
 * exactly like a small company. Nothing on the connection card, in the sync
 * summary or in the audit trail distinguishes "40 employees" from "the first 40
 * of 180", and the analyst's next act is to sign an expense figure that is
 * missing the rest.
 *
 * So the pages are followed where the provider hands over something followable
 * — an absolute URL on its own API host, bounded by {@link MAX_PROVIDER_PAGES}
 * — and refused where it says there is more in a spelling this platform cannot
 * act on. Refused rather than reported: `HrisSyncOutcome` is counts, and a
 * count that quietly means "so far" is the silent cap this estate answers with
 * `truncated` everywhere it is a display list. This is not a display list; it
 * is the population an accounting figure is struck over.
 */
async function fetchEmployeePages(
  provider: HrisProvider,
  accessToken: string,
  fetchFn: FetchFn,
): Promise<Record<string, unknown>[]> {
  const label = HRIS_PROVIDER_LABELS[provider];
  const e = ENDPOINTS[provider];
  const pages: Record<string, unknown>[] = [];
  let url = `${e.apiBase}/v1/employees?include=equity`;
  // One budget for the walk, not one deadline per page: twenty pages at
  // twenty-nine seconds each trips nothing and takes ten minutes. See
  // `pagedPullBudget`.
  const budget = pagedPullBudget(label);
  for (let page = 0; page < MAX_PROVIDER_PAGES; page++) {
    const res = await withDeadline(label, budget.nextPageTimeoutMs(), (signal) =>
      fetchFn(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal,
      }),
    );
    // Through the shared refusal, like every other outbound call in this
    // estate. These two sites — this and the token exchange above — were the
    // last that wrote the status into a sentence themselves, which meant a
    // rate-limited provider was reported as "Gusto roster fetch failed (429)".
    // That reads like a broken integration and prompts exactly the wrong
    // response: pressing Import now again, immediately, which is how a rate
    // limit becomes a longer one. `providerRefused` answers a 429 with the
    // provider's own Retry-After instead, and leaves every other status with
    // the wording it had.
    if (!res.ok) throw providerRefused(label, 'roster fetch', res);
    // Read against the walk's byte budget rather than the per-response cap:
    // every page is kept so the mappers can run over the whole roster, so the
    // heap this holds is the sum of them. See `PAGED_PULL_BUDGET_BYTES`.
    const payload = await budget.readPage(res);
    pages.push(payload);
    const next = nextPageUrl(payload, e.apiBase);
    if (!next) {
      const said = providerSaysMore(payload);
      if (said) {
        throw new IntegrationError(
          `${label} says its employee list continues past this page ("${said}"), and does not give a ` +
            'link this platform can follow — so the roster and the grants pulled from it would be a ' +
            'prefix of the company reported as all of it. Import the remaining grants from a CSV, or ' +
            'ask support to add paging for this provider.',
        );
      }
      return pages;
    }
    url = next;
  }
  throw new IntegrationError(
    `${label} is still returning more employees after ${MAX_PROVIDER_PAGES} pages — the roster would ` +
      'be a prefix of the company reported as all of it. Import the grants from a CSV instead.',
  );
}

export async function fetchRosterAndGrants(
  provider: HrisProvider,
  tokens: { accessToken: string; externalCompanyId: string | null; externalCompanyName: string | null },
  fetchFn: FetchFn = fetch,
): Promise<HrisPull> {
  const pages = await fetchEmployeePages(provider, tokens.accessToken, fetchFn);
  const roster: RosterEmployee[] = [];
  const grants: MappedGrant[] = [];
  const rejectedDetail: RejectedGrant[] = [];
  let rejected = 0;
  for (const page of pages) {
    const mapped = mapEmployees(page);
    roster.push(...mapped.roster);
    grants.push(...mapped.grants);
    rejected += mapped.rejected;
    // Capped again at the walk's level: each page already stops at
    // MAX_REJECTED_DETAIL, and a roster of several pages must not multiply
    // that into a list longer than the one a single page would have produced.
    for (const d of mapped.rejectedDetail) {
      if (rejectedDetail.length >= MAX_REJECTED_DETAIL) break;
      rejectedDetail.push(d);
    }
  }
  // The company name is a property of the connection, not of a page, so the
  // first page that names one wins — the later pages of a cursor walk routinely
  // carry only the records.
  const payload = pages.find((p) => storableText(p.companyName, MAX_COMPANY_NAME) !== null) ?? {};
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
    rejectedDetail,
    rejectedDetailTruncated: rejected > rejectedDetail.length,
  };
}
