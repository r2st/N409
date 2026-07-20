/**
 * SCIM 2.0 resource mapping (feature 9). Pure helpers to translate between our
 * user rows and the SCIM User schema, and to parse the narrow slice of SCIM
 * request syntax we support (userName eq filters, PatchOp active toggles).
 */

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

export function toScimUser(u: ScimUserRow): Record<string, unknown> {
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

export function scimError(status: number, detail: string): Record<string, unknown> {
  return { schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail };
}

export function scimList(resources: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** Parse `userName eq "value"` (the only filter Okta/Azure send on lookup). */
export function parseUserNameFilter(filter: string | undefined): string | null {
  if (!filter) return null;
  const m = /userName\s+eq\s+"([^"]+)"/i.exec(filter);
  return m ? m[1]!.toLowerCase() : null;
}

export interface ScimCreate {
  email: string;
  firstName: string | null;
  lastName: string | null;
  externalId: string | null;
  active: boolean;
}

/** Parse a SCIM User create/replace body into our shape. */
export function parseScimUser(body: unknown): ScimCreate | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const emails = Array.isArray(b.emails) ? (b.emails as Array<Record<string, unknown>>) : [];
  const primaryEmail =
    emails.find((e) => e.primary)?.value ?? emails[0]?.value ?? (b.userName as string | undefined);
  const email = typeof primaryEmail === 'string' ? primaryEmail.toLowerCase() : null;
  if (!email) return null;
  const name = (b.name ?? {}) as Record<string, unknown>;
  return {
    email,
    firstName: typeof name.givenName === 'string' ? name.givenName : null,
    lastName: typeof name.familyName === 'string' ? name.familyName : null,
    externalId: typeof b.externalId === 'string' ? b.externalId : null,
    active: b.active === undefined ? true : Boolean(b.active),
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
    const op = raw as Record<string, unknown>;
    const path = typeof op.path === 'string' ? op.path.toLowerCase() : '';
    if ((op.op === 'replace' || op.op === 'Replace') && path === 'active') {
      return Boolean(op.value);
    }
    // Pathless replace: { op:'replace', value:{ active:false } }
    if ((op.op === 'replace' || op.op === 'Replace') && !path && op.value && typeof op.value === 'object') {
      const v = op.value as Record<string, unknown>;
      if ('active' in v) return Boolean(v.active);
    }
  }
  return undefined;
}
