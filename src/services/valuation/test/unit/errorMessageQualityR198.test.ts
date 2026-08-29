import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@n409/shared';
import { InternalServiceError, toProblem } from '../../src/clients/internal.js';
import { configureReportRenderer, renderReportPdf } from '../../src/clients/reportRender.js';
import { stripeProblem } from '../../src/routes/payments.js';
import { StripeApiError } from '../../src/payments/stripe.js';
import { API_TOKEN_REFUSAL_DETAIL } from '../../src/repos/apiTokens.js';

/**
 * R198 — the four failures M19 had not reached, each of which reported itself
 * to a person by naming something that person has no access to.
 *
 * R180 swept the *routes*, where a rejection is written next to the schema that
 * produced it. Everything here fails a layer below that: an upstream service, a
 * PDF renderer, a payment provider, a credential store. The shape they share is
 * that the layer knows exactly what went wrong and the sentence that reaches
 * the reader is about the layer instead — "engine rejected the request",
 * "Invalid or revoked API token", a bodiless 500 — so the one person who could
 * act is the one person not told what to do.
 *
 * `upstreamErrorDisclosure` guards the opposite direction on the same strings
 * and the two are checked together deliberately: the fix for "say more" is one
 * edit away from "say the traceback", and each of these asserts the remedy is
 * present *and* that the upstream's raw body still is not.
 */

describe('an upstream failure names the work, not the component', () => {
  // Every arm of `toProblem` except the breaker one used to say "engine" or
  // "ai" — the names of processes on a box the analyst cannot see — and stop.
  // `DEGRADED_MESSAGES` already had the argument written down for why that is
  // useless; it had only been applied to one of the four branches.

  it('rewrites a rejected calculation as work the analyst can act on', () => {
    const err = new InternalServiceError('engine', 422, 'volatility is required');
    const detail = toProblem(err).detail!;

    expect(detail).toContain('The calculation could not be run');
    expect(detail).toContain('volatility is required');
    // The half that cannot be derived from the failure: where to go.
    expect(detail).toContain('parameters');
    expect(detail).not.toContain('engine rejected');
  });

  it('rewrites a rejected AI job in the AI job’s own terms', () => {
    const detail = toProblem(new InternalServiceError('ai', 400, 'prompt exceeds context'))!.detail!;
    expect(detail).toContain('The AI analysis could not be completed');
    expect(detail).toMatch(/documents/i);
  });

  it('states a remedy even when the upstream body had to be withheld', () => {
    // The worst of the old set. An opaque body meant `said === null`, and the
    // whole answer was four words naming an internal service.
    const opaque = new InternalServiceError('engine', 500, '<html>502 Bad Gateway</html>', [], false, true);
    const detail = toProblem(opaque).detail!;

    expect(detail).toContain('The calculation could not be run');
    expect(detail).toContain('Your inputs are saved');
    expect(detail).not.toContain('<html>');
  });

  it('says how long to wait in the prose, not only in a header', () => {
    // `retry-after` is a header; nothing renders it to the person waiting.
    const err = new InternalServiceError('engine', 429, 'daily allowance spent', [], false, false, false, 45);
    const problem = toProblem(err);
    expect(problem.status).toBe(429);
    expect(problem.retryAfterSeconds).toBe(45);
    expect(problem.detail).toContain('45s');
    expect(problem.detail).toContain('request allowance');
  });

  it('does not double the full stop when the upstream punctuated its own sentence', () => {
    // One string, two authors. Cosmetic, and exactly the kind of thing that
    // ships and stays.
    const detail = toProblem(new InternalServiceError('engine', 422, 'volatility is required.'))!.detail!;
    expect(detail).not.toContain('..');
    expect(detail).not.toContain('. .');
  });

  it('falls back to a usable sentence for a service with no entry', () => {
    // A fifth internal service added later must not reintroduce the bare shape
    // by being absent from the table.
    const detail = toProblem(new InternalServiceError('scoring', 500, 'boom'))!.detail!;
    expect(detail).toContain('could not be completed');
    expect(detail).toMatch(/try again/i);
  });
});

describe('a report that produced no PDF says so', () => {
  const log = { warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    log.warn.mockReset();
    log.debug.mockReset();
    log.error.mockReset();
  });
  afterEach(() => {
    configureReportRenderer(null);
  });

  /**
   * Every *handled* failure in `clients/reportRender.ts` still ends in a PDF —
   * an unreachable report unit, an open breaker, a full queue and a 422 all
   * fall back to rendering in-process. The one that does not is the render
   * itself throwing, and that had no handler on the whole path: it left the
   * client untouched, walked past the four routes that call it, and reached
   * `registerProblemHandler` as a 500 whose body carries no `detail` by design.
   * Somebody pressed Download and got neither a file nor a sentence.
   */
  it('answers a render throw with a problem instead of an empty 500', async () => {
    configureReportRenderer(null, log);
    const broken = {
      title: 'Q3 2026 409A',
      // A section list the renderer cannot lay out. What it throws is not the
      // point — the point is that *something* thrown here is now answered.
      sections: null as never,
    };

    const err = await renderReportPdf(broken as never).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiProblem);
    const problem = err as ApiProblem;
    expect(problem.status).toBe(502);
    const detail = problem.detail!;
    expect(detail).toContain('could not be turned into a PDF');
    // The two facts a person needs: their work survived, and what to do.
    expect(detail).toContain('saved');
    expect(detail).toMatch(/try the download again/i);

    // The renderer's own message stays in the log and out of the response.
    // pdfkit's messages are font paths and internal format names, written for
    // whoever holds the stack — the same split `describedBy` makes for the
    // engine. Asserted here rather than in its own case because the log line is
    // a fact about *this* call, and a second `it` would only re-run the render.
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields, message] = log.error.mock.calls[0]!;
    expect(message).toContain('no PDF produced');
    expect(fields).toHaveProperty('detail');
    // Nothing retries a render and no sweep comes back for it, so it wants a
    // person — see the alert contract.
    expect(fields).toMatchObject({ alert: true });
  });
});

describe('a payment that failed for our reasons does not read as the client’s', () => {
  it('keeps Stripe’s own sentence, which is written for the payer', () => {
    // Not a regression this round undoes: "Your card was declined" is the most
    // useful thing anybody can say and it comes from Stripe.
    const declined = new StripeApiError('Your card was declined.', 402);
    expect(stripeProblem(declined).detail).toContain('Your card was declined');
  });

  it('does not hand the payer our own key problem', () => {
    // Stripe answers 401 when *our* secret key is wrong, and its sentence names
    // the credential. The payer can do nothing about it, and the message hands
    // a stranger the shape and prefix of our live key.
    const badKey = new StripeApiError('Invalid API Key provided: sk_live_51H***abc', 401);
    const detail = stripeProblem(badKey).detail!;

    expect(detail).not.toContain('sk_live');
    expect(detail).not.toContain('API Key');
    expect(detail).toContain('misconfigured on our side');
    expect(detail).toContain('Nothing has been charged');
    expect(detail).toMatch(/contact support/i);
  });

  it('treats a permission failure on our key the same way', () => {
    const forbidden = new StripeApiError('The provided key does not have the required permissions.', 403);
    expect(stripeProblem(forbidden).detail).toContain('misconfigured on our side');
  });
});

describe('a refused API token says which of the four things happened', () => {
  /**
   * `resolveApiToken` answered `null` to four conditions and the API said
   * "Invalid or revoked API token" to all of them. Three have different fixes,
   * and `orphaned` — the one this platform causes itself, when the member who
   * minted a firm's key is moved out of the org — reads exactly like a typo.
   *
   * The DB-backed half is `test/integration/apiTokenRefusal.test.ts`; this pins
   * the sentences, which is what a partner actually receives.
   */
  it('gives every refusal a distinct, actionable sentence', () => {
    const details = Object.values(API_TOKEN_REFUSAL_DETAIL);
    expect(new Set(details).size, 'two refusals sharing a sentence is the bug').toBe(details.length);
    for (const [kind, detail] of Object.entries(API_TOKEN_REFUSAL_DETAIL)) {
      expect(detail.length, `${kind} is too short to be actionable`).toBeGreaterThan(60);
      expect(detail, `${kind} states no remedy`).toMatch(/mint|restor/i);
    }
  });

  it('explains the orphaned case rather than calling it invalid', () => {
    const detail = API_TOKEN_REFUSAL_DETAIL.orphaned;
    expect(detail).toContain('no longer a member');
    // Refused, not revoked — which is only a useful property if it is said.
    expect(detail).toContain('refused rather than revoked');
    expect(detail).toMatch(/restoring it brings this token back/i);
  });

  it('stays vague only for the one case where nothing was proved', () => {
    // `unknown` is the presenter having produced no recognised secret. It is
    // the one answer that must not confirm anything about a real token.
    expect(API_TOKEN_REFUSAL_DETAIL.unknown).not.toMatch(/revoked|member|exists/);
  });
});
