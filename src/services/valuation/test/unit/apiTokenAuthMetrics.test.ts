import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import { API_TOKEN_REFUSAL_DETAIL } from '../../src/repos/apiTokens.js';
import {
  recordApiTokenAuth,
  refuseApiToken,
  registerApiTokenAuthMetrics,
  resetApiTokenAuthMetrics,
  SELF_INFLICTED_REFUSALS,
} from '../../src/observability/apiTokenAuth.js';

/**
 * An integration outage that answers one 401 (R345, methodology M11).
 *
 * Every other machine door on this platform was instrumented in turn and for
 * the same reason — the inbound webhooks and both SSO flows in R329, the
 * directory connector in R337, the OAuth connect callbacks in R341 — and the
 * argument each time is `scimRequests.ts`'s: `registerProblemHandler` leaves
 * 4xx unlogged on purpose, which is right for a browser and wrong for the one
 * caller that is a machine and cannot tell anybody it is being turned away.
 *
 * The API key was the door left, and it is the one this estate itself calls
 * "the door with no person behind it to notice". R342 gave it two more ways to
 * refuse — an archived firm, a suspended account — on the argument that
 * archiving a firm must reach its keys. It does now, and until this nothing
 * anywhere recorded that it had: the firm's integration stops, the console it
 * would look in is behind the same key, and this side sees a 401 in the same
 * 4xx class as every mistyped password on the box.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.resolve(HERE, file), 'utf8');

describe('the API token auth counter', () => {
  afterEach(() => resetApiTokenAuthMetrics());

  it('counts a refusal by the reason the credential layer gave', () => {
    const registry = new MetricsRegistry();
    registerApiTokenAuthMetrics(registry);

    refuseApiToken({ warn: vi.fn() }, 'partner_retired', { tokenId: 't1', partnerId: 'p1' });
    refuseApiToken({ warn: vi.fn() }, 'orphaned', { tokenId: 't2', partnerId: 'p1' });

    const text = registry.render();
    expect(text).toContain('api_token_auth_total{outcome="partner_retired"} 1');
    expect(text).toContain('api_token_auth_total{outcome="orphaned"} 1');
  });

  it('keeps `accepted` so a refusal count has a denominator', () => {
    // One key refused is somebody's typo; every key refused for half an hour is
    // something an administrator did. A bare refusal count cannot separate
    // those, and how many API calls a deployment serves per hour is not
    // something a dashboard holds.
    const registry = new MetricsRegistry();
    registerApiTokenAuthMetrics(registry);
    recordApiTokenAuth('accepted');
    expect(registry.render()).toContain('api_token_auth_total{outcome="accepted"} 1');
  });

  it('names the key and the firm in the log, which the counter deliberately cannot', () => {
    // The label set is one series per outcome on purpose. That makes the metric
    // safe and leaves it unable to answer the only question worth asking once
    // it fires — whose integration is down — so the ids travel on the line.
    const warn = vi.fn();
    refuseApiToken({ warn }, 'partner_retired', { tokenId: 'tok_1', partnerId: 'ptr_1' });
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({
      source: 'api-token',
      outcome: 'partner_retired',
      token_id: 'tok_1',
      partner_id: 'ptr_1',
    });
    expect(message).toContain('archived');
  });

  it('counts a stranger without logging one', () => {
    // The reason `unauthenticated` is kept apart from `bad_token` on the SCIM
    // door: this API faces the internet, a bearer nobody issued is a scanner,
    // and a scanner must not get to choose how much this box logs. The count
    // stays, because the rate of it is a signal even when no single one is.
    const registry = new MetricsRegistry();
    registerApiTokenAuthMetrics(registry);
    const warn = vi.fn();
    refuseApiToken({ warn }, 'unknown', { tokenId: null, partnerId: null });
    expect(warn).not.toHaveBeenCalled();
    expect(registry.render()).toContain('api_token_auth_total{outcome="unknown"} 1');
  });

  it('is inert before registration rather than throwing', () => {
    expect(() => recordApiTokenAuth('accepted')).not.toThrow();
    expect(() =>
      refuseApiToken({ warn: vi.fn() }, 'revoked', { tokenId: null, partnerId: null }),
    ).not.toThrow();
  });

  it('records both halves from the one place every bearer goes through', () => {
    // A census rather than a fixture, because the denominator is the half that
    // is easy to leave out — and because `plugins/auth.ts` is the single door:
    // an instrument wired at a route would be one route's worth of the answer.
    const plugin = source('../../src/plugins/auth.ts');
    expect(plugin).toMatch(/recordApiTokenAuth\('accepted'\)/);
    expect(plugin).toMatch(/refuseApiToken\(\s*req\.log/);
  });

  it('has a bounded outcome vocabulary tied to the refusal union', () => {
    // The label values are `ApiTokenRefusal` itself plus `accepted`, so no
    // caller can mint a series — the cardinality trap `MAX_SERIES_PER_METRIC`
    // exists for — and a sixth refusal added to that union cannot reach the
    // metric without being given a message here first.
    const refusals = Object.keys(API_TOKEN_REFUSAL_DETAIL);
    expect(refusals.sort()).toEqual(['no_owner', 'orphaned', 'partner_retired', 'revoked', 'unknown']);
    const module = source('../../src/observability/apiTokenAuth.ts');
    for (const refusal of refusals) {
      expect(module, `${refusal} has no log sentence`).toContain(`${refusal}:`);
    }
  });

  it('wakes somebody only for the refusals this platform caused', () => {
    /*
     * The judgement the rule encodes, held to the code rather than restated in
     * it. `revoked` is a deliberate act by somebody who knows they did it and
     * `unknown` is the internet; neither may page. The other three are a firm
     * archived, a member moved, an account closed — each a decision about a
     * person or an organisation whose side effect is that an integration
     * reading cap tables and creating engagements stops, with the remedy on
     * this side and nobody told.
     */
    const rules = readFileSync(path.resolve(HERE, '../../../../../infra/monitoring/alerts.yml'), 'utf8');
    const selector = /api_token_auth_total\{outcome=~"([^"]+)"\}/.exec(rules);
    expect(selector, 'no rule reads the API-key door').not.toBeNull();
    expect(selector![1]!.split('|').sort()).toEqual([...SELF_INFLICTED_REFUSALS].sort());
    // And the pair that must stay out of it.
    expect(selector![1]).not.toContain('revoked');
    expect(selector![1]).not.toContain('unknown');
  });
});
