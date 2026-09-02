import { problems, type ApiProblem } from '@n409/shared';

/**
 * A 403 that says what was refused and what would let it through.
 *
 * `problems.forbidden()` defaults to `'Not allowed'`, and twenty-eight route
 * guards took the default — so the entire answer to a partner who opened an
 * ops-only screen, an analyst without the create-valuation right, and a client
 * trying to delete somebody else's upload was the same two words. A 403 is the
 * one status where a bare answer is least defensible: unlike a 404 the server
 * is admitting the thing exists, and unlike a 422 there is nothing in the
 * request to go and fix. The only useful information a 403 can carry is *whose*
 * access this needs, and none of them carried it.
 *
 * Three parts to each message, which is the M19 shape:
 *
 *   1. what was refused — the action, named as the caller would name it;
 *   2. why — the access category it needs;
 *   3. how — who to ask, or what to do instead.
 *
 * (3) is the part that cannot be derived, which is why {@link ACCESS} is a
 * table of hand-written remedies rather than a formatter over role names. "Ask
 * an administrator" and "use your own partner's token" are different
 * instructions, and a caller given the wrong one wastes somebody else's time
 * as well as their own.
 */

/**
 * The access category a guard is testing for.
 *
 * Deliberately coarser than {@link RoleKey}. These are the *audiences* the
 * route guards actually distinguish, and collapsing twelve ops role keys into
 * `'ops'` is not a loss: no guard in the estate refuses somebody for holding
 * `reviewer` rather than `data`, so a message that named the specific role
 * would be naming a distinction the code does not make.
 */
export type AccessKind =
  | 'ops'
  | 'user-admin'
  | 'working-data'
  | 'own-record'
  | 'partner-token'
  | 'ops-managed-field';

interface AccessCopy {
  /** Why the request was refused, in the caller's terms. */
  because: string;
  /** What the caller can do about it. */
  remedy: string;
}

/**
 * The `required_access` token is in the body as well as the prose.
 *
 * A partner integration branching on a 403 needs something stable, and the
 * sentence is not it — this file exists precisely because the wording changed.
 * The token is the coarse category and never the role vocabulary: `ROLE_KEYS`
 * is internal, and `GET /api/v1/roles` is itself ops-only, so a 403 body is a
 * strange place to publish the list.
 */
const ACCESS: Readonly<Record<AccessKind, AccessCopy>> = {
  ops: {
    because: 'it is restricted to N409 operations staff',
    remedy: 'Your account holds no operations role — ask an administrator to grant one.',
  },
  'user-admin': {
    because: 'it is restricted to user administrators',
    remedy: 'Ask an administrator, or someone with the supervisor role, to do this for you.',
  },
  'working-data': {
    because: 'the valuation model behind it is analyst tooling',
    remedy:
      'Working data — workbook cells, overwrites and report drafts — is visible to operations staff only. The concluded figures are on the report.',
  },
  'own-record': {
    because: 'it was created by someone else',
    remedy: 'You can only change records you created. Ask operations staff if this one needs to change.',
  },
  /*
   * The client's own engagement, and a field on it their analyst owns.
   *
   * Distinct from `ops` rather than a spelling of it, because the two audiences
   * are different people and `ops`'s remedy — "ask an administrator to grant
   * you an operations role" — is advice a client must never be given: they are
   * not staff, the role will not be granted, and the sentence reads as though
   * the product is misconfigured rather than as though the field is somebody
   * else's to set. The only caller is the valuation PATCH, whose `denied` list
   * is reached by the engagement's owner and by nobody with an ops role, since
   * `OPS_PATCH_FIELDS` is a superset of every key `PatchBody` admits.
   */
  'ops-managed-field': {
    because: 'your analyst sets it rather than you',
    remedy:
      'The rest of your patch was not applied either — send it again without that field. If it ' +
      'needs to change, say so on the engagement and your analyst will make the change.',
  },
  'partner-token': {
    because: 'it is reachable only with a partner API key',
    remedy:
      'This key is a personal token. Create a partner key under Settings → API tokens for the partner whose data you are reading.',
  },
};

/**
 * `<Action> was refused: <because>. <remedy>`
 *
 * `action` is a noun phrase describing what the caller was doing — "Retrying a
 * webhook delivery", "Creating a valuation" — and not the route, because the
 * route is already in `instance` and a path is not what somebody reads an
 * error for.
 */
export function forbidden(action: string, kind: AccessKind): ApiProblem {
  const copy = ACCESS[kind];
  return problems.forbidden(`${action} was refused because ${copy.because}. ${copy.remedy}`, {
    required_access: kind,
  });
}
