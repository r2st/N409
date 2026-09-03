/**
 * SCIM 2.0 resource mapping (feature 9). Pure helpers to translate between our
 * user rows and the SCIM User schema, and to parse the narrow slice of SCIM
 * request syntax we support (userName eq filters, PatchOp active toggles).
 */

import { EmailAddress, MAX_EMAIL_LENGTH } from './email.js';

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

export interface ScimUserRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  scim_external_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
}

/**
 * The SCIM 2.0 resources this service emits, as types rather than as
 * `Record<string, unknown>`.
 *
 * The bag type compiled, which is the problem: `userName` misspelled, `meta`
 * omitted, `schemas` left off a list response — RFC 7644 requires all three —
 * are the errors an IdP reports as "the SCIM endpoint is not compliant" and
 * nothing else. Nothing checked them, and a test reading `result.meta` had to
 * cast to reach it, which is a cast the compiler can never disprove.
 */
export interface ScimName {
  givenName?: string;
  familyName?: string;
}

export interface ScimEmail {
  value: string;
  primary: boolean;
  type: string;
}

export interface ScimMeta {
  resourceType: 'User';
  created: Date;
  location: string;
}

export interface ScimUser {
  schemas: string[];
  id: string;
  /** Absent rather than null when the IdP never sent one — SCIM omits, it does not null. */
  externalId?: string;
  userName: string;
  name: ScimName;
  displayName: string;
  emails: ScimEmail[];
  active: boolean;
  meta: ScimMeta;
}

export interface ScimListResponse {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: ScimUser[];
}

/**
 * The machine-readable half of a SCIM error (RFC 7644 §3.12).
 *
 * Only the members this service can actually raise. The full set is larger, and
 * publishing a token for a condition no handler produces would be a claim about
 * behaviour rather than a description of it.
 */
export type ScimType = 'uniqueness' | 'invalidValue' | 'invalidSyntax' | 'invalidFilter';

export interface ScimErrorResponse {
  schemas: string[];
  /** SCIM sends the status as a string in the body, not a number. */
  status: string;
  detail: string;
  /**
   * The classifier a connector branches on, absent unless the condition has
   * one. Omitted rather than nulled: RFC 7644 defines `scimType` only for 400
   * and for the 409 uniqueness case, and a null on a 401 or a 503 asserts that
   * the field was considered and found not to apply, which for a rate limit or
   * an unhandled fault is not a thing this service knows.
   */
  scimType?: ScimType;
}

export function toScimUser(u: ScimUserRow): ScimUser {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: u.id,
    externalId: u.scim_external_id ?? undefined,
    userName: u.email,
    name: { givenName: u.first_name ?? undefined, familyName: u.last_name ?? undefined },
    displayName: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
    emails: [{ value: u.email, primary: true, type: 'work' }],
    active: u.deleted_at === null,
    meta: { resourceType: 'User', created: u.created_at, location: `/scim/v2/Users/${u.id}` },
  };
}

/**
 * Coerce a SCIM `active` value to a boolean.
 *
 * `Boolean(value)` is wrong here. Microsoft Entra ID (Azure AD) does not send
 * JSON booleans for `active` — it sends the *strings* `"True"` and `"False"`,
 * capitalised, in both User create bodies and PatchOp deprovision requests:
 *
 *     { "op": "Replace", "path": "active", "value": "False" }
 *
 * `Boolean("False")` is `true`, because every non-empty string is truthy. The
 * effect was that a deprovision from Entra reported 200 and left the account
 * fully active: an offboarded employee kept their session, their password
 * reset, and their access to every valuation their roles reached. Nothing in
 * the response told the IdP otherwise, so the failure was silent on both ends.
 *
 * Anything that isn't recognisably false is treated as true, matching the
 * previous behaviour for genuine booleans and for the `"1"`/`"0"` some smaller
 * IdPs send.
 */
export function scimBoolean(value: unknown): boolean {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'false' || v === '0' || v === '') return false;
    return true;
  }
  return Boolean(value);
}

/**
 * A SCIM error, with the classifier when the condition has one.
 *
 * Every error under `/scim/v2` used to be `{schemas, status, detail}` and
 * nothing else, and `detail` is prose — the one field RFC 7644 does not ask to
 * be stable, and the one a connector therefore cannot branch on. The
 * consequential omission is the 409 on `POST /Users`: a directory connector
 * that reads `scimType: "uniqueness"` treats "this person already has an
 * account" as something to reconcile and carries on, and a bare 409 as an
 * unclassified failure it files as an error for a human to resolve by hand.
 * The condition it describes — an existing account for an address the IdP is
 * pushing — is the ordinary case on a first import of a directory into a
 * platform people already had logins for, so the whole of that import lands in
 * the admin's error queue (R350, methodology M19).
 *
 * The prose is unchanged and stays the thing a person reads; this is the field
 * beside it for the software.
 */
export function scimError(status: number, detail: string, scimType?: ScimType): ScimErrorResponse {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail,
    ...(scimType ? { scimType } : {}),
  };
}

/**
 * The largest page this service will return, and the number
 * `ServiceProviderConfig` publishes as `filter.maxResults`.
 */
export const SCIM_MAX_PAGE = 200;

/**
 * A SCIM ListResponse.
 *
 * `totalResults` is how many resources match, *not* how many are in this page —
 * RFC 7644 §3.4.2.4 — and it was the page's own length. The listing takes 200
 * rows and nothing else, so a directory with 250 provisioned accounts was
 * answered `totalResults: 200, itemsPerPage: 200, startIndex: 1`, which is a
 * complete, self-consistent, wrong answer: every field agrees that those 200
 * are all of them. Okta's reconciliation reads exactly this to decide who this
 * service still knows about, so the fifty past the cut are accounts it believes
 * are already gone — and a connector configured to deprovision what it no
 * longer sees has been told the wrong thing by a 200 OK.
 *
 * The other half is that `startIndex` was the constant 1. An IdP pages by
 * asking for `startIndex=201` next; the parameter was ignored, so the same
 * first page came back with `startIndex: 1` on it, and the client either loops
 * or gives up. Reporting the index the caller asked for is what lets paging
 * terminate.
 *
 * So the total is passed in by the caller — it comes from a `count(*)` over
 * the same predicate — and defaults to the page length only for the filtered
 * lookup, where the page genuinely is the whole match set.
 */
export function scimList(
  resources: ScimUser[],
  page: { totalResults?: number; startIndex?: number } = {},
): ScimListResponse {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: page.totalResults ?? resources.length,
    startIndex: page.startIndex ?? 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/**
 * `startIndex` / `count` as this service will honour them.
 *
 * Both are 1-based decimal strings on the query string and both arrive from a
 * connector rather than a form, so every degenerate spelling has to land
 * somewhere sane rather than in an `OFFSET NaN`: absent, empty, `"abc"`,
 * `"-5"`, `"1e9"`, repeated (Fastify hands back an array), or larger than the
 * page this service will build. RFC 7644 §3.4.2.4 fixes the two clamps — a
 * `startIndex` below 1 is treated as 1, a negative `count` as 0 — and the
 * upper bound on `count` is ours, published as `filter.maxResults`.
 *
 * `count: 0` is a legal request meaning "just tell me the total", so it is
 * distinct from an absent `count`, which means "a page of whatever you give
 * me". That is why the parse keeps null rather than folding both to a default.
 */
export function scimPage(query: unknown): { startIndex: number; count: number } {
  const q = (query ?? {}) as Record<string, unknown>;
  const int = (value: unknown): number | null => {
    const raw = Array.isArray(value) ? value[value.length - 1] : value;
    if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    // Decimal only: `Number('1e9')` and `Number('0x10')` both parse, and neither
    // is an index any IdP means.
    if (!/^[+-]?\d+$/.test(raw.trim())) return null;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) ? n : null;
  };
  const startIndex = Math.max(1, int(q.startIndex) ?? 1);
  const requested = int(q.count);
  const count = requested === null ? SCIM_MAX_PAGE : Math.min(Math.max(requested, 0), SCIM_MAX_PAGE);
  return { startIndex, count };
}

/**
 * Parse `userName eq "value"` (the only filter Okta/Azure send on lookup).
 *
 * Takes `unknown` rather than `string | undefined` because the caller's input
 * is a query string, and a query string is not a `Record<string, string>`:
 * Fastify's parser collects a repeated key into an array, so `?filter=a&filter=b`
 * arrives as `['a', 'b']`. Declaring the narrow type did not make it true — it
 * only moved the surprise to whichever line first treated the value as a
 * string. Anything that is not one is no filter at all, which is the same
 * answer this already gives for an absent one.
 */
export function parseUserNameFilter(filter: unknown): string | null {
  if (typeof filter !== 'string' || !filter) return null;
  // Anchored. Unanchored, this matched a *prefix*: `userName eq "a@b.c" and
  // active eq true` — the shape Entra sends once a lookup grows a condition,
  // and `userName eq "a" or userName eq "b"` — read as the first clause and
  // the rest silently dropped, so the answer was to a question the client did
  // not ask. A filter with anything else in it is one this endpoint does not
  // read, which is what `isUnsupportedFilter` now says out loud.
  const m = /^\s*userName\s+eq\s+"([^"]+)"\s*$/i.exec(filter);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * True when a `filter` was sent and is not the one this endpoint reads.
 *
 * `parseUserNameFilter` answers `null` for two different requests — "no filter"
 * and "a filter I cannot read" — and `GET /Users` treated both as the first.
 * So a filter this regex misses was *dropped*, and the client that asked
 * "which user has this userName" was answered with the whole provisioned
 * directory, 200 and well-formed. That is worse than a refusal in the one way
 * that matters here: a SCIM client takes a ListResponse as the set that
 * matched, and Okta's and Entra's import matching then reconcile against
 * accounts nobody asked about. `ServiceProviderConfig` publishes
 * `filter.supported: true`, so the client has no reason to suspect it.
 *
 * Only `userName eq "…"` is read — the lookup Okta and Entra send — and RFC
 * 7644 §3.12 has a classifier for exactly this: `invalidFilter`. Anything else,
 * including a repeated `?filter=` (which arrives as an array, see above), is
 * now that 400 rather than a silent full listing.
 *
 * Derived from the parser rather than written beside it, so the two cannot
 * disagree about which filters are readable. An absent or blank `filter` is not
 * a filter at all and stays the unfiltered listing it has always been.
 */
export function isUnsupportedFilter(filter: unknown): boolean {
  if (filter === undefined || filter === null) return false;
  if (typeof filter === 'string' && filter.trim() === '') return false;
  return parseUserNameFilter(filter) === null;
}

export interface ScimCreate {
  email: string;
  firstName: string | null;
  lastName: string | null;
  externalId: string | null;
  active: boolean;
}

/** Why a create body cannot be provisioned, in words an IdP admin can act on. */
export interface ScimRejection {
  rejected: string;
}

export function isScimRejection(parsed: ScimCreate | ScimRejection): parsed is ScimRejection {
  return 'rejected' in parsed;
}

/**
 * Bounds on what an IdP may put in a `users` row.
 *
 * This was the one write path into `users` with no schema in front of it at
 * all: every other create/patch route parses its body with Zod, and SCIM read
 * the fields off the body with `typeof x === 'string'` and inserted whatever
 * came back. So an IdP connector — authenticated, but not by us, and often
 * misconfigured rather than hostile — could provision a 300 KB `givenName`, or
 * a `userName` that is not an address at all.
 *
 * Neither is theoretical. `users_email_key` is a b-tree over `lower(email)` and
 * `users_scim_external_id_idx` is a b-tree over `scim_external_id`; a value past
 * roughly 2.7 KB fails the INSERT with `54000 index row size exceeds btree
 * version 4 maximum`. That is not a unique violation, so the 409 branch below
 * does not catch it, and the IdP receives a 500 on a provision — which Okta and
 * Entra both retry indefinitely, turning one malformed directory record into a
 * permanent write loop against the pool.
 *
 * The shape check matters as much as the size. `userName` maps to
 * `users.email`, which is this platform's login identity and the address every
 * notification and password reset is sent to. RFC 7643 does not require it to
 * be an address, but a row where it is not is an account nobody can sign into
 * and nobody can email; refusing it at the door tells the directory admin which
 * record is wrong, where accepting it fails much later and silently.
 */
const MAX_SCIM_NAME = 100;
const MAX_SCIM_EXTERNAL_ID = 255;
/** A SCIM User carries work/home/other at most; a longer list is a malformed body. */
const MAX_SCIM_EMAILS = 20;

/** A bounded optional string field, or a rejection naming it. */
function scimText(value: unknown, field: string, max: number): string | null | ScimRejection {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) return { rejected: `${field} must be at most ${max} characters` };
  return trimmed;
}

/** Parse a SCIM User create/replace body into our shape, or say why we can't. */
export function parseScimUser(body: unknown): ScimCreate | ScimRejection {
  if (!body || typeof body !== 'object') return { rejected: 'A userName / email is required' };
  const b = body as Record<string, unknown>;
  const rawEmails = Array.isArray(b.emails) ? (b.emails as Array<Record<string, unknown>>) : [];
  if (rawEmails.length > MAX_SCIM_EMAILS) {
    return { rejected: `emails accepts at most ${MAX_SCIM_EMAILS} entries` };
  }
  const primaryEmail =
    rawEmails.find((e) => e?.primary)?.value ?? rawEmails[0]?.value ?? (b.userName as unknown);
  if (typeof primaryEmail !== 'string' || !primaryEmail.trim()) {
    return { rejected: 'A userName / email is required' };
  }
  const email = EmailAddress.safeParse(primaryEmail);
  if (!email.success) {
    return {
      rejected: `userName / emails[].value must be an email address of at most ${MAX_EMAIL_LENGTH} characters`,
    };
  }
  const name = (b.name ?? {}) as Record<string, unknown>;
  const firstName = scimText(name.givenName, 'name.givenName', MAX_SCIM_NAME);
  if (firstName !== null && typeof firstName !== 'string') return firstName;
  const lastName = scimText(name.familyName, 'name.familyName', MAX_SCIM_NAME);
  if (lastName !== null && typeof lastName !== 'string') return lastName;
  const externalId = scimText(b.externalId, 'externalId', MAX_SCIM_EXTERNAL_ID);
  if (externalId !== null && typeof externalId !== 'string') return externalId;
  return {
    email: email.data.toLowerCase(),
    firstName,
    lastName,
    externalId,
    active: b.active === undefined ? true : scimBoolean(b.active),
  };
}

/**
 * Resolve a PatchOp body to an active flag when it toggles `active`; returns
 * undefined when the patch doesn't touch activation.
 */
export function activeFromPatch(body: unknown): boolean | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const ops = (body as Record<string, unknown>).Operations;
  if (!Array.isArray(ops)) return undefined;
  for (const raw of ops) {
    /*
     * The element is asserted to be an object and was not checked to be one.
     *
     * `{"Operations": [null]}` — which a connector emits from an empty slot in
     * its own op list, and which anyone holding a SCIM token can send by hand —
     * reached `op.path` and threw `Cannot read properties of null`. The scoped
     * error handler answers that as a 500, on a route whose own comment two
     * files away spells out the cost: "an IdP sees a 500 on a deprovision it
     * will then retry forever". The offboarded account stays active for as long
     * as the loop runs, and the loop does not stop.
     *
     * Skipped rather than refused, unlike the create path's bounds: an
     * operation this cannot read is an operation that does not toggle `active`,
     * which is the same answer `Operations: 'bad'` and a `displayName` replace
     * already get. A PATCH carrying one readable deactivation and one null is
     * still a deactivation, and refusing the whole body would lose it.
     */
    if (!raw || typeof raw !== 'object') continue;
    const op = raw as Record<string, unknown>;
    const path = typeof op.path === 'string' ? op.path.toLowerCase() : '';
    // RFC 7644 names the ops in lower case but IdPs capitalise them freely
    // ("Replace" from Entra, "REPLACE" from some OneLogin connectors), so
    // normalise rather than listing spellings. `add` on a singular attribute
    // that already has a value is a replace, which is what Okta sends when it
    // reactivates a user it previously suspended.
    const verb = typeof op.op === 'string' ? op.op.toLowerCase() : '';
    if (verb !== 'replace' && verb !== 'add') continue;
    if (path === 'active') {
      return scimBoolean(op.value);
    }
    // Pathless replace: { op:'replace', value:{ active:false } }
    if (!path && op.value && typeof op.value === 'object') {
      const v = op.value as Record<string, unknown>;
      if ('active' in v) return scimBoolean(v.active);
    }
  }
  return undefined;
}
