import type { ZodError } from 'zod';
import { problems, validationDetail, type ApiProblem } from '@n409/shared';

/**
 * The two answers a route gives when a schema refuses the caller's input.
 *
 * These exist so the *field names reach `detail`*. The estate had ~150 sites
 * shaped
 *
 *     if (!parsed.success) throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });
 *
 * and fourteen more that omitted the extension entirely, so the whole answer
 * was the two words `Invalid query`. Both halves of that are a problem, and
 * only the second one looks like one: the extension is not what the user sees.
 * `ApiError` in the browser is `super(problem.detail ?? problem.title)`, so the
 * category noun is the entire message every `setError(err.message)` in the
 * frontend renders. See `validationDetail` in shared for the rest of that.
 *
 * Two functions rather than one with a status argument, because the status is
 * not a caller's choice — it is decided by *which* part of the request failed,
 * and getting it wrong changes what a client does about it:
 *
 *   - {@link invalidQuery} is 400. A query string that does not parse is a
 *     malformed request; there is no entity to be unprocessable about.
 *   - {@link invalidBody} is 422. The request was well-formed and the content
 *     was refused, which is the distinction `accountingCallbackValidation`
 *     already pins for the one unauthenticated route in the service.
 *
 * Both are in `domain/` rather than being a `problems.*` member for a reason
 * worth stating: `problems` lives in shared, shared has no zod, and giving it
 * one so that a message could be built here would put a validation library in
 * the dependency tree of the report renderer.
 */

/**
 * A malformed query string — 400, naming the parameters that failed.
 *
 * The subject stays `Invalid query` because it is the half that says *where*
 * to look. A route validates its path parameters, its query and its body
 * against three schemas, and `page: Expected number, received nan` on its own
 * does not tell the caller which of the three to go and fix.
 */
export function invalidQuery(error: ZodError, subject = 'Invalid query'): ApiProblem {
  return problems.badRequest(validationDetail(subject, error.issues), { errors: error.issues });
}

/**
 * Refused content — 422, naming the fields that failed.
 *
 * `subject` is the noun the existing call sites already chose (`Invalid fund`,
 * `Invalid patch`, `Invalid bulk action`) and is kept per-site rather than
 * flattened to one word: on a route that takes a body *and* a query, it is the
 * only thing distinguishing the two failures from each other.
 */
export function invalidBody(subject: string, error: ZodError): ApiProblem {
  return problems.unprocessable(validationDetail(subject, error.issues), { errors: error.issues });
}
