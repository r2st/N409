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

import { cellText, meansNoFigure, parseNumericCell } from '../domain/capTable.js';
import type { CapTableEntry, CapTableClassType, NumericCapTableField } from '../domain/capTable.js';
import {
  IMPORT_TIMEOUT_MS,
  IntegrationError,
  OAUTH_TIMEOUT_MS,
  providerRefused,
  readJson,
  withDeadline,
} from './deadline.js';

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
  const res = await withDeadline(CAP_TABLE_PROVIDER_LABELS[provider], OAUTH_TIMEOUT_MS, (signal) =>
    fetchFn(e.tokenUrl, {
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
      signal,
    }),
  );
  if (!res.ok) {
    throw providerRefused(CAP_TABLE_PROVIDER_LABELS[provider], 'token exchange', res);
  }
  const body = (await readJson(res, CAP_TABLE_PROVIDER_LABELS[provider])) as TokenResponse;
  if (!body.access_token) {
    throw new IntegrationError(`${CAP_TABLE_PROVIDER_LABELS[provider]} returned no access token`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    externalCompanyId: body.company_id ?? null,
    externalCompanyName: body.company_name ?? null,
  };
}

/**
 * A provider's figure, read by the rule the CSV importer reads a cell by.
 *
 * This had its own: strip `[$,\s]` and `Number()` what is left. Two things it
 * got wrong, both of which `parseNumericCell` had already been taught on the
 * other reader of the same shapes — and the lesson of the two xlsx readers is
 * that a bug in a format is a candidate in both, so a *rule* about figures is
 * too.
 *
 *  - **The decimal comma.** Stripping every comma reads `1,00` as **100** and
 *    `1.234,56` as `1.23456`. That is the exact figure R150 found and fixed in
 *    `parseNumericCell`; nothing carried it here. The provider path is where it
 *    costs most: the scheduled sync applies with `apply: true` and no person in
 *    the loop, so a hundredfold price per share is stored without anyone
 *    reading a diff.
 *  - **The empty string as zero.** `Number('')` is `0`, not `NaN`, so a field
 *    the provider sent as `""` came back as a *figure* of zero rather than as
 *    an absent one — and `read` below never reached its `meansNoFigure` check,
 *    because that only runs on a null. A `liquidation_multiple` of `""`
 *    therefore imported as 0x instead of defaulting to 1x: the class's whole
 *    preference became zero, `validateCapTable` has no rule against a zero
 *    multiple (only a negative one), and the waterfall paid common out of money
 *    that was contractually preferred.
 *
 * It also inherits the rest of the rule: a parenthesised figure is negative,
 * `€`/`£`/`¥` are currency symbols, and an object or a list is not a figure at
 * all.
 */
const toNum = (v: unknown): number | null => parseNumericCell(v);

/**
 * Reading a provider payload two levels below the one `readJson` checked.
 *
 * `readJson` refuses a body that is not an object, and its docstring says why:
 * the `as` casts these mappers use are compile-time assertions with no runtime
 * force, so `null` and arrays reach property reads that then throw. That guard
 * stops at the top level. Everything below it — `securities`, `shareClasses`,
 * each row inside them, each cell inside a row — is still asserted rather than
 * checked, and a provider (or an ingress rewriting one, or a compromised
 * token's endpoint) that answers with the wrong shape lands in one of three
 * places, none of which is a sentence anybody can act on:
 *
 *   `{"securities": {...}}`        `TypeError: object is not iterable`
 *   `{"securities": [null]}`       `TypeError: Cannot read properties of null`
 *   `{"securities": [{"shareClass": {...}}]}`   a class named `[object Object]`
 *
 * The first two throw a bare `TypeError` out of `fetchCapTable`, which is
 * inside the sync's fetch try-block: `recordSyncError` then writes the
 * `TypeError`'s own message to `cap_table_connections.last_error`, a column
 * `toPublic` serves to the analyst verbatim and which is documented as
 * carrying only text we wrote. The analyst is shown this codebase's internals
 * and told the provider is unreachable, which it is not.
 *
 * The third is worse, because nothing fails: the pull imports a share class
 * literally named `[object Object]`, the table validates clean, and — a
 * scheduled sync runs with `apply: true` — it is what the waterfall, the
 * exhibits and the PDF then say the company's capitalization is.
 *
 * So each collection is checked where it is read, and a wrong shape is an
 * `IntegrationError` naming the provider and the field, which is what the
 * route is built to forward and what the connection's page is built to show.
 * Refused rather than skipped: a `convertibles` quietly read as absent is a
 * cap table missing its whole preference stack that still validates, and a
 * clean-looking wrong number is the failure mode this import path exists to
 * refuse.
 */
function objectOf(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function rowsOf(payload: Record<string, unknown>, field: string, label: string): Record<string, unknown>[] {
  const raw = payload[field];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new IntegrationError(`${label} returned a "${field}" list that is not a list`);
  }
  for (const row of raw) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new IntegrationError(`${label} returned a "${field}" entry that is not a security`);
    }
  }
  return raw as Record<string, unknown>[];
}

/**
 * The first of several spellings of a name field, as text.
 *
 * A name that is an object or a list is refused rather than stringified. The
 * two silent alternatives are both worse: `String()` mints the class
 * `[object Object]`, and treating it as absent drops the row — these mappers
 * skip an unnamed security deliberately — which takes its shares out of the
 * fully-diluted count without saying so.
 */
function nameOf(
  row: Record<string, unknown>,
  label: string,
  what: string,
  ...keys: readonly string[]
): string {
  for (const key of keys) {
    const raw = row[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    throw new IntegrationError(`${label} returned a ${what} whose name is not text`);
  }
  return '';
}

/**
 * A row reader that keeps the figures it could not read, rather than defaulting
 * them.
 *
 * The CSV importer has recorded this since `unreadable_numbers` was added, on
 * the reasoning that an unreadable share count is *also* a zero share count and
 * an unreadable multiple is also an absent one — so the warnings those raise
 * describe the defaults rather than the file, and every one of the defaults is
 * a number the valuation goes on to divide by. `validateCapTable` turns a
 * recorded cell into an *error*, which makes the table invalid, which is what
 * stops the sync applying it.
 *
 * The provider path recorded nothing. `toNum` returns null for anything it
 * cannot read and every call site ends `?? 0` or `?? 1`, so a Pulley security
 * whose `sharesOutstanding` is `"2,000,000 sh"` — a real provider's real
 * formatting — imported as **zero shares**, validated clean, and was applied
 * by the scheduled sync without a person ever seeing it. The bound on this
 * path was `MAX_CAP_TABLE_ENTRIES`; there was none on what the rows said.
 *
 * A spelling that says "no figure" (`""`, `"-"`, `"N/A"`, a spreadsheet error
 * literal) is a figure that was not supplied and falls through to the next
 * spelling, exactly as the CSV reader treats the same text.
 */
interface RowFigures {
  unreadable: Partial<Record<NumericCapTableField, string>>;
  read: (field: NumericCapTableField, ...keys: readonly string[]) => number | null;
}

function figuresOf(row: Record<string, unknown>): RowFigures {
  const unreadable: Partial<Record<NumericCapTableField, string>> = {};
  const read = (field: NumericCapTableField, ...keys: readonly string[]): number | null => {
    for (const key of keys) {
      const raw = row[key];
      if (raw === undefined || raw === null) continue;
      const n = toNum(raw);
      if (n !== null) return n;
      const text = cellText(raw);
      if (meansNoFigure(text)) continue;
      unreadable[field] = text;
      return null;
    }
    return null;
  };
  return { unreadable, read };
}

/** Attach the unreadable cells of a row to the entry built from it. */
function withUnreadable(entry: CapTableEntry, figures: RowFigures): CapTableEntry {
  if (Object.keys(figures.unreadable).length > 0) entry.unreadable_numbers = figures.unreadable;
  return entry;
}

/** A provider-supplied string field, or null when it is not one. */
function textField(payload: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === 'string' && raw !== '') return raw;
  }
  return null;
}

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
  if (/warrant|note|safe|convertible/.test(t + ' ' + name.toLowerCase()))
    return t.includes('warrant') ? 'warrant' : 'preferred';
  if (/preferred|series|seed/.test(t + ' ' + name.toLowerCase())) return 'preferred';
  return 'common';
}

/**
 * Carta capitalization payload → entries. Carta groups the cap table into
 * shareClasses (common/preferred), optionPools, warrants and convertibles;
 * convertible notes are represented as preferred-like preference-bearing rows.
 */
export function mapCarta(payload: unknown): CapTableEntry[] {
  const label = CAP_TABLE_PROVIDER_LABELS.carta;
  const p = objectOf(payload);
  const entries: CapTableEntry[] = [];

  for (const c of rowsOf(p, 'shareClasses', label)) {
    const name = nameOf(c, label, 'share class', 'name', 'className');
    if (!name) continue;
    const f = figuresOf(c);
    entries.push(
      withUnreadable(
        {
          security_class: name,
          class_type: normalizeType(c.type ?? c.classType, name),
          shares: f.read('shares', 'outstandingShares', 'shares') ?? 0,
          price_per_share: f.read('price_per_share', 'issuePrice', 'pricePerShare'),
          invested_amount: f.read('invested_amount', 'amountInvested', 'invested'),
          liquidation_multiple: f.read(
            'liquidation_multiple',
            'liquidationPreference',
            'liquidationMultiple',
          ),
          seniority: f.read('seniority', 'seniority'),
          conversion_ratio: f.read('conversion_ratio', 'conversionRatio'),
        },
        f,
      ),
    );
  }
  for (const o of rowsOf(p, 'optionPools', label)) {
    const f = figuresOf(o);
    entries.push(
      withUnreadable(
        {
          security_class: nameOf(o, label, 'option pool', 'name') || 'Option Pool',
          class_type: 'option',
          shares: f.read('shares', 'outstandingShares', 'reservedShares', 'shares') ?? 0,
          price_per_share: f.read('price_per_share', 'strikePrice', 'exercisePrice'),
          invested_amount: null,
          liquidation_multiple: null,
          seniority: null,
          conversion_ratio: null,
        },
        f,
      ),
    );
  }
  for (const w of rowsOf(p, 'warrants', label)) {
    const f = figuresOf(w);
    entries.push(
      withUnreadable(
        {
          security_class: nameOf(w, label, 'warrant', 'name') || 'Warrants',
          class_type: 'warrant',
          shares: f.read('shares', 'shares', 'outstandingShares') ?? 0,
          price_per_share: f.read('price_per_share', 'strikePrice', 'exercisePrice'),
          invested_amount: null,
          liquidation_multiple: null,
          seniority: null,
          conversion_ratio: null,
        },
        f,
      ),
    );
  }
  // Convertible notes / SAFEs carry a principal that seniorities into the
  // preference stack — model them as preferred with a 1× preference.
  for (const cv of rowsOf(p, 'convertibles', label)) {
    const f = figuresOf(cv);
    entries.push(
      withUnreadable(
        {
          security_class: nameOf(cv, label, 'convertible', 'name') || 'Convertible Note',
          class_type: 'preferred',
          shares: f.read('shares', 'shares') ?? 0,
          price_per_share: f.read('price_per_share', 'pricePerShare'),
          invested_amount: f.read('invested_amount', 'principal', 'amount', 'invested'),
          liquidation_multiple: f.read('liquidation_multiple', 'liquidationMultiple') ?? 1,
          seniority: f.read('seniority', 'seniority'),
          conversion_ratio: f.read('conversion_ratio', 'conversionRatio'),
        },
        f,
      ),
    );
  }
  return entries;
}

/**
 * Pulley cap-table payload → entries. Pulley returns a flat `securities` list
 * tagged by `securityType`; convertible instruments live under `convertibles`.
 */
export function mapPulley(payload: unknown): CapTableEntry[] {
  const label = CAP_TABLE_PROVIDER_LABELS.pulley;
  const p = objectOf(payload);
  const entries: CapTableEntry[] = [];
  for (const s of rowsOf(p, 'securities', label)) {
    const name = nameOf(s, label, 'security', 'shareClass', 'name');
    if (!name) continue;
    const f = figuresOf(s);
    entries.push(
      withUnreadable(
        {
          security_class: name,
          class_type: normalizeType(s.securityType ?? s.type, name),
          shares: f.read('shares', 'sharesOutstanding', 'shares') ?? 0,
          price_per_share: f.read('price_per_share', 'pricePerShare', 'issuePrice', 'strikePrice'),
          invested_amount: f.read('invested_amount', 'totalInvested', 'invested'),
          liquidation_multiple: f.read(
            'liquidation_multiple',
            'liquidationMultiple',
            'liquidationPreference',
          ),
          seniority: f.read('seniority', 'seniority'),
          conversion_ratio: f.read('conversion_ratio', 'conversionRatio'),
        },
        f,
      ),
    );
  }
  for (const cv of rowsOf(p, 'convertibles', label)) {
    const f = figuresOf(cv);
    entries.push(
      withUnreadable(
        {
          security_class: nameOf(cv, label, 'convertible', 'name') || 'Convertible',
          class_type: 'preferred',
          shares: f.read('shares', 'shares') ?? 0,
          price_per_share: f.read('price_per_share', 'pricePerShare'),
          invested_amount: f.read('invested_amount', 'principal', 'amount'),
          liquidation_multiple: f.read('liquidation_multiple', 'liquidationMultiple') ?? 1,
          seniority: f.read('seniority', 'seniority'),
          conversion_ratio: f.read('conversion_ratio', 'conversionRatio'),
        },
        f,
      ),
    );
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
  const res = await withDeadline(CAP_TABLE_PROVIDER_LABELS[provider], IMPORT_TIMEOUT_MS, (signal) =>
    fetchFn(url, {
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
      signal,
    }),
  );
  if (!res.ok) {
    throw providerRefused(CAP_TABLE_PROVIDER_LABELS[provider], 'cap-table fetch', res);
  }
  const payload = await readJson(res, CAP_TABLE_PROVIDER_LABELS[provider]);
  const entries = provider === 'carta' ? mapCarta(payload) : mapPulley(payload);
  // Same compile-time-only cast as the rows above, on the two fields that are
  // not rows. `external_company_name` is written to the connection and served
  // on its page; `as_of` is stamped on the sync summary and dated in the UI.
  // An object in either reached both as an object.
  return {
    provider,
    external_company_name: textField(payload, 'companyName') ?? tokens.externalCompanyName ?? null,
    entries,
    as_of: textField(payload, 'asOf', 'as_of'),
  };
}
