import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  refusePartnerApiRequest,
  registerPartnerApiGuardMetrics,
  resetPartnerApiGuardMetrics,
} from '../../src/observability/partnerApiGuard.js';

/**
 * The refusals one layer above the door R345 instrumented (R376, M11).
 *
 * `apiTokenAuth.ts` counts what the *credential* layer does with a presented
 * key. `apiKeyGuard` then refuses five more ways on its own account, and R345
 * and R346 both closed with that as an open item: "`apiKeyGuard`'s own two
 * refusals are still silent … they want their own instrument or a labelled
 * split, and this round did not make that call."
 *
 * Their own instrument, because `api_token_auth_total`'s population is every
 * presented token across the estate and `accepted` is its denominator; these
 * happen on the partner routes only, and folding them in would make both
 * numbers mean less than they do apart.
 *
 * The sharpest is `account_suspended` (R342): a key this platform issued and
 * still honours, refused because an administrator here suspended the seat it
 * acts as. The firm's integration stops as a side effect of an unrelated
 * administrative act, the answer is a 403 that `registerProblemHandler` leaves
 * unlogged by design, and until this the whole record was one more 4xx in
 * `http_requests_total`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.resolve(HERE, file), 'utf8');

/** The body of `apiKeyGuard`, which is the population every assertion below is about. */
function guardBody(): string {
  const src = source('../../src/routes/partnerApi.ts');
  const start = src.indexOf('const apiKeyGuard =');
  expect(start, 'apiKeyGuard has been renamed — this census reads it by name').toBeGreaterThan(0);
  const end = src.indexOf('\n  };', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('the partner API gate counter', () => {
  afterEach(() => resetPartnerApiGuardMetrics());

  it('counts each refusal under its own reason', () => {
    const registry = new MetricsRegistry();
    registerPartnerApiGuardMetrics(registry);

    refusePartnerApiRequest({ warn: vi.fn() }, 'session_token');
    refusePartnerApiRequest({ warn: vi.fn() }, 'personal_token');
    refusePartnerApiRequest({ warn: vi.fn() }, 'key_rate_limited');
    refusePartnerApiRequest({ warn: vi.fn() }, 'key_rate_limited');

    const text = registry.render();
    expect(text).toContain('partner_api_refusals_total{reason="session_token"} 1');
    expect(text).toContain('partner_api_refusals_total{reason="personal_token"} 1');
    expect(text).toContain('partner_api_refusals_total{reason="key_rate_limited"} 2');
  });

  it('names the key, the firm and the account when a suspension is what stopped it', () => {
    // The metric is one series per reason on purpose, which leaves it unable to
    // answer the only question worth asking once it fires — whose integration
    // is down, and whose suspension did it. Those three ids travel on the line,
    // under the correlation mixin's own spellings.
    const warn = vi.fn();
    refusePartnerApiRequest({ warn }, 'account_suspended', {
      tokenId: 'tok_1',
      partnerId: 'ptr_1',
      userId: 'usr_1',
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({
      source: 'partner-api',
      outcome: 'account_suspended',
      apiTokenId: 'tok_1',
      partnerId: 'ptr_1',
      userId: 'usr_1',
    });
    expect(message).toContain('suspended');
  });

  it('counts the integrator’s own mistakes and the throttles without logging them', () => {
    // Same split `refuseApiToken` makes for `unknown`: a refusal the caller
    // caused, and can read in the body it was answered with, does not get to
    // decide how much this box logs. The count stays — a rate of clients
    // pointed at the wrong door is a signal even when no single one is.
    const warn = vi.fn();
    for (const reason of ['session_token', 'personal_token', 'key_rate_limited', 'partner_rate_limited'] as const) {
      refusePartnerApiRequest({ warn }, reason);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('is inert before registration rather than throwing', () => {
    // The guard runs on every partner request; an unregistered instrument must
    // never be the reason one of them fails.
    expect(() => refusePartnerApiRequest({ warn: vi.fn() }, 'session_token')).not.toThrow();
  });

  it('covers every arm the gate refuses on, not the ones somebody remembered', () => {
    /*
     * The census, and the reason this file exists rather than five fixtures: a
     * sixth refusal added to `apiKeyGuard` next round is exactly the shape that
     * was silent for two rounds already. Every `throw problems.` in the guard
     * has to be preceded by a count.
     */
    const body = guardBody();
    const throws = body.match(/throw problems\./g) ?? [];
    const counted = body.match(/refusePartnerApiRequest\(/g) ?? [];
    expect(throws.length, 'the guard stopped refusing — this census would pass vacuously').toBe(5);
    expect(counted.length, 'an arm of apiKeyGuard refuses without counting it').toBe(throws.length);
    // And that the counting call comes first, so a refusal cannot be counted by
    // a line that the throw above it never reaches.
    for (const arm of body.split(/throw problems\./).slice(0, -1)) {
      expect(arm, 'a refusal arm with no count before its throw').toContain('refusePartnerApiRequest(');
    }
  });

  it('is registered from the app, beside the door below it', () => {
    // An instrument nothing registers is a series that never appears, and an
    // absent series is what a healthy one looks like from a rule.
    expect(source('../../src/app.ts')).toContain('registerPartnerApiGuardMetrics(metricsRegistry)');
  });

  it('wakes somebody only for the refusal this platform caused', () => {
    const rules = readFileSync(path.resolve(HERE, '../../../../../infra/monitoring/alerts.yml'), 'utf8');
    const selectors = [...rules.matchAll(/partner_api_refusals_total\{reason=~?"([^"]+)"\}/g)].map(
      (m) => m[1]!,
    );
    expect(selectors, 'no rule reads the partner API gate').not.toHaveLength(0);
    const watched = selectors.flatMap((s) => s.split('|'));
    expect(watched).toContain('account_suspended');
    // The integrator's own two stay out of it, for the reason `revoked` and
    // `unknown` stay out of PartnerIntegrationLockedOut.
    expect(watched).not.toContain('session_token');
    expect(watched).not.toContain('personal_token');
  });
});
