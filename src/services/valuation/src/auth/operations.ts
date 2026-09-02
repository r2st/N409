/**
 * M3 policy layer (comments, tokens, admin console) — pure functions, same
 * contract as auth/rbac.ts. Separate file so parallel milestones don't collide
 * editing rbac.ts.
 */
import { canReadValuation, isOps, isSuspended, type Principal, type ValuationRef } from './rbac.js';
import type { CommentKind } from '../domain/operations.js';

/** Chat is client-facing; notes and threaded email are internal ops tooling. */
export function visibleCommentKinds(p: Principal): ReadonlySet<CommentKind> {
  return isOps(p) ? new Set(['chat', 'note', 'email'] as const) : new Set(['chat'] as const);
}

export function canPostComment(p: Principal, v: ValuationRef, kind: CommentKind): boolean {
  if (kind === 'email') return false; // email arrives via the inbox endpoint only
  if (kind === 'note') return isOps(p);
  return canReadValuation(p, v);
}

/**
 * Author may edit/delete their own comment; ops can moderate everything.
 *
 * The suspension is subtracted explicitly, for the reason `SUSPENDED_ROLE`
 * states and `canManageTokens` below already applies: `ignored` is *additive*,
 * so a suspended author keeps the `valuation_user` grant and this predicate's
 * second arm reads an id off a row rather than a capability off a principal.
 * `isOps` subtracts for the first arm; the second one had nothing to subtract
 * for it, which is the same split the four privilege predicates in `rbac.ts`
 * were carrying.
 *
 * Not reachable today — `loadEditable` reads the engagement through
 * `canReadValuation` first, and a suspended principal's `valuationScope` is
 * `none`, so the 404 lands before this is asked. It is written here anyway
 * because that is an argument about one caller and this is a policy function:
 * the file's other three predicates all answer the suspension for themselves,
 * and a rule that holds only where somebody remembered to put a read in front
 * of it is not a rule.
 */
export function canEditComment(p: Principal, comment: { author_id: string | null }): boolean {
  if (isOps(p)) return true;
  if (isSuspended(p)) return false;
  return comment.author_id !== null && comment.author_id === p.id;
}

/** Only ops ingest email into comment threads (relay runs as an 'auto' user). */
export function canIngestEmail(p: Principal): boolean {
  return isOps(p);
}

/**
 * API tokens act for a partner. Ops manage any partner's tokens; a 'partner'
 * (org admin) manages their own org's. 'member' users cannot mint tokens.
 *
 * The suspension check is not redundant with `isOps`, which answers about the
 * ops roles and not about this one: the second line is the whole of a firm
 * administrator's authority, and it read a role key off the row. A suspended
 * `partner` could go on minting credentials that act for their firm — and an
 * API token is the one credential here that a later suspension cannot reach,
 * because it is revoked by its own record rather than by its holder's session.
 */
export function canManageTokens(p: Principal, partnerId: string): boolean {
  if (isOps(p)) return true;
  if (isSuspended(p)) return false;
  return p.roles.includes('partner') && p.partnerId === partnerId;
}
