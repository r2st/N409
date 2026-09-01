import { z } from 'zod';
import { isUlid } from '@n409/shared';

/**
 * An id-shaped field in a request *body*, validated.
 *
 * `plugins/params.ts` closed this hole for route parameters — ~190 handlers
 * casting `req.params` and passing the string to a repo, where the `ulid`
 * domain rejects it as a 500. Body fields were left to each schema, and most
 * spell them `z.string()`, which admits every string there is.
 *
 * The one that actually gets through is the *empty* string, and it gets through
 * because of the shape the guards are written in:
 *
 *     if (body.parent_org_id) await loadOwnedOrg(principal, body.parent_org_id);
 *     ...
 *     { parentOrgId: body.parent_org_id }          // undefined ⇒ "leave alone"
 *
 * `''` is falsy, so the guard reads it as "not supplied" and skips the
 * ownership, self-parent and cycle checks; it is not `undefined`, so the write
 * reads it as supplied and puts it in the UPDATE. The column is
 * `ulid REFERENCES …`, whose CHECK constraint refuses `''` with a 23514, and
 * nothing maps that to a problem document — so the request that skipped every
 * check answers "Internal Server Error".
 *
 * The SPA does not hit it because it converts the blank option itself
 * (`e.target.value || null` in TasksPage), which is the server's rule living in
 * one client. Any other caller — a partner integration, a curl, the second
 * client — gets the 500.
 *
 * Validating in the schema fixes both halves at once: `''` is refused with a
 * 422 that names the field, and no id that reaches a handler can be blank, so
 * the truthiness guards below mean what they read as.
 */
export const ULID_FIELD_MESSAGE = 'must be a 26-character Crockford-base32 ULID';

/** A ULID carried in a request body or query string. */
export const ulidField = () => z.string().refine(isUlid, { message: ULID_FIELD_MESSAGE });
