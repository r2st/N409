import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry, problems } from '@n409/shared';
import { refuseSso, SSO_REFUSAL_CODES } from '../../src/auth/ssoRefusal.js';
import {
  recordSsoOutcome,
  registerSsoMetrics,
  resetSsoMetrics,
  ssoFlowOf,
} from '../../src/observability/ssoOutcomes.js';

/**
 * A sign-in outage that answers 302 (R329, methodology M11).
 *
 * R273 gave every identity-provider refusal a log line and said why: "a refusal
 * that becomes a 302 is a 302 in the access log, indistinguishable from the
 * successful hand-off two lines below it". The half it left is that on this box
 * the log is not the alerting channel — `infra/journald` is retention and
 * rate-limit configuration, nothing consumes a log field, and `/metrics` is
 * what a rule can be written against.
 *
 * So an expired IdP signing certificate, a rotated Google client secret or an
 * administrator narrowing the allowed domain refuses every sign-in at a firm,
 * and each refusal is counted in the 3xx class beside every ordinary redirect
 * on the platform. No 5xx, no slow request, no circuit — the IdP is not one of
 * ours. Nobody can sign in and every other instrument reads green.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const reply = { redirect: vi.fn(() => reply) } as unknown as FastifyReply;

function fakeRequest(url: string, accept = 'text/html'): FastifyRequest {
  return {
    headers: { accept },
    method: 'POST',
    url,
    routeOptions: { url },
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

describe('the SSO outcome counter', () => {
  afterEach(() => resetSsoMetrics());

  it('counts a refusal by the reason it gave, from the one place all seventeen go through', () => {
    const registry = new MetricsRegistry();
    registerSsoMetrics(registry);

    refuseSso(fakeRequest('/api/v1/auth/saml/acs'), reply, 'assertion_rejected', problems.forbidden('no'));
    refuseSso(
      fakeRequest('/api/v1/auth/google/callback'),
      reply,
      'domain_not_allowed',
      problems.forbidden('no'),
    );

    const text = registry.render();
    expect(text).toContain('sso_outcomes_total{flow="saml",outcome="assertion_rejected"} 1');
    expect(text).toContain('sso_outcomes_total{flow="google",outcome="domain_not_allowed"} 1');
  });

  it('counts the refusal an API caller gets, which leaves as a thrown problem', () => {
    // The R273 asymmetry, one instrument over: whether the refusal is visible
    // must not depend on whether the caller happened to ask for HTML. The ACS
    // is a POST an IdP's page makes, and one that submits it with `fetch`
    // sends no `text/html`.
    const registry = new MetricsRegistry();
    registerSsoMetrics(registry);
    expect(() =>
      refuseSso(
        fakeRequest('/api/v1/auth/saml/acs', 'application/json'),
        reply,
        'provider_error',
        problems.forbidden('no'),
      ),
    ).toThrow();
    expect(registry.render()).toContain('sso_outcomes_total{flow="saml",outcome="provider_error"} 1');
  });

  it('keeps `signed_in` so a refusal count has a denominator', () => {
    // One person with a personal address hitting `domain_not_allowed` is
    // Tuesday; the same code on every attempt for half an hour is a setting
    // somebody changed. A bare refusal count cannot separate those, and the
    // number of sign-ins a deployment does per hour is not something a
    // dashboard holds.
    const registry = new MetricsRegistry();
    registerSsoMetrics(registry);
    recordSsoOutcome('saml', 'signed_in');
    expect(registry.render()).toContain('sso_outcomes_total{flow="saml",outcome="signed_in"} 1');
  });

  it('reads the flow off the route rather than taking it as an argument', () => {
    // Seventeen call sites across two files; an argument at each is an argument
    // one of them gets wrong. Same reasoning that put the sweep name inside
    // `scheduleSweep`.
    expect(ssoFlowOf(fakeRequest('/api/v1/auth/saml/login'))).toBe('saml');
    expect(ssoFlowOf(fakeRequest('/api/v1/auth/saml/acs'))).toBe('saml');
    expect(ssoFlowOf(fakeRequest('/api/v1/auth/google/callback'))).toBe('google');
  });

  it('is inert before registration rather than throwing', () => {
    expect(() => recordSsoOutcome('google', 'signed_in')).not.toThrow();
  });

  it('counts the success on both flows, not only the refusals', () => {
    // A census, because the denominator is the half that is easy to leave out —
    // and a ratio rule built on a numerator alone fires on the first stray
    // address or never fires at all.
    for (const file of ['../../src/routes/saml.ts', '../../src/routes/auth.ts']) {
      const source = readFileSync(path.resolve(HERE, file), 'utf8');
      expect(source, file).toMatch(/recordSsoOutcome\('(saml|google)', 'signed_in'\)/);
    }
  });

  it('has a bounded outcome vocabulary', () => {
    // The label set is fixed by `SSO_REFUSAL_CODES` plus one, so no caller can
    // mint a series — the cardinality trap `MAX_SERIES_PER_METRIC` exists for.
    expect(SSO_REFUSAL_CODES.length).toBe(10);
    expect(new Set(SSO_REFUSAL_CODES).size).toBe(SSO_REFUSAL_CODES.length);
  });
});
