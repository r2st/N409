import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_TYPES } from '../../src/domain/partnerWebhooks.js';
import { PARTNER_API_PREFIX } from '../../src/routes/partnerApi.js';

/**
 * §3 of docs/api-design.md, against the API it claims to describe.
 *
 * The design doc is not generated. §1.1 is — the problem catalog renders that
 * table and `problemTypes.test.ts` fails when the two disagree — and everything
 * around it is prose somebody wrote once. §3 is where that cost the most,
 * because it is the section a partner integration is designed from.
 *
 * It named five webhook events: `valuation.created`, `valuation.updated`,
 * `valuation.waiting_on_client`, `valuation.drafted`, `valuation.published`.
 * Not one of them has ever been sent. The vocabulary this service has is four
 * entirely different members — a transition event, a deliverable event, a
 * terminal retirement event and a test ping — and the registration endpoint
 * validates `events` against exactly those, so a partner coding from the
 * document would have had every one of their subscriptions rejected as invalid
 * before they ever learned which events exist. The paths were wrong in the same
 * silent way: the prefix was `/partner/v1` where the service serves
 * `/api/partner/v1`, and the upload was `/attachments` where the route is
 * `/documents`.
 *
 * Prose cannot be generated from a registry without becoming a worse document,
 * so this is the other half: the doc stays hand-written and the *facts* in it
 * are pinned. Both directions matter — an operation the doc omits is as much a
 * defect as one it invents, because the section reads as the whole surface.
 *
 * The registry is read from source rather than by booting the app. `define()`
 * is what mints both the route and its entry in `GET /docs`, so its literals
 * are the single statement of what exists; a test that stood the app up would
 * assert the same thing while needing a database to do it.
 */

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const DOC = readFileSync(
  fileURLToPath(new URL('../../../../../docs/api-design.md', import.meta.url)),
  'utf8',
);

/** §3, up to the next top-level heading. */
function partnerSection(): string {
  const start = DOC.indexOf('## 3. Partner API');
  expect(start).toBeGreaterThan(-1);
  const end = DOC.indexOf('\n## ', start + 1);
  return DOC.slice(start, end === -1 ? undefined : end);
}

/** The `METHOD /path` lines inside the section's fenced block. */
function documentedOperations(): string[] {
  const fence = /```\n([\s\S]*?)```/.exec(partnerSection());
  expect(fence).not.toBeNull();
  return fence![1]!
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/\s+/g, ' '));
}

/**
 * Every operation `registerPartnerApi` defines, as `METHOD /path`.
 *
 * Read off the `method:`/`path:` pair of each `define({ ... })` descriptor. The
 * two always travel together in that order and nothing else in the file uses
 * those keys, so the pairing is positional rather than parsed — the shape this
 * depends on is checked below by asserting the count is plausible, which is
 * what stops a refactor turning this census into a vacuous one.
 */
function registeredOperations(): string[] {
  const source = repoFile('src/routes/partnerApi.ts');
  const ops = [...source.matchAll(/method:\s*'([A-Z]+)',\s*\n\s*path:\s*'([^']+)'/g)].map(
    (m) => `${m[1]} ${PARTNER_API_PREFIX}${m[2]}`,
  );
  return ops;
}

describe('docs/api-design.md §3 describes the partner API that exists', () => {
  it('reads a registry rather than an empty one', () => {
    // The guard on the guard: a rename of `define`'s descriptor keys would
    // otherwise leave both sides empty and the comparisons below trivially true.
    expect(registeredOperations().length).toBeGreaterThanOrEqual(15);
    expect(documentedOperations().length).toBeGreaterThanOrEqual(15);
  });

  it('names every operation the service registers, and no others', () => {
    const documented = [...documentedOperations()].sort();
    const registered = [...new Set(registeredOperations())].sort();
    expect(documented).toEqual(registered);
  });

  it('names the base path the routes are actually mounted at', () => {
    // The old text said `/partner/v1`, which is a path this service has never
    // served — every example in the section 404s as written.
    expect(partnerSection()).toContain(PARTNER_API_PREFIX);
    expect(partnerSection()).not.toMatch(/(?<!\/api)\/partner\/v1/);
  });

  it('names the webhook vocabulary the service actually sends', () => {
    const section = partnerSection();
    for (const event of WEBHOOK_EVENT_TYPES) {
      expect(section).toContain(`\`${event}\``);
    }
  });

  it('names no event the registration endpoint would refuse', () => {
    // The failure that made this test worth writing: five invented members,
    // each of which `z.enum(WEBHOOK_EVENT_TYPES)` rejects at registration.
    const quoted = [...partnerSection().matchAll(/`(valuation\.[a-z_]+|webhook\.[a-z_]+)`/g)].map(
      (m) => m[1]!,
    );
    expect(quoted.length).toBeGreaterThan(0);
    const invented = [...new Set(quoted)].filter(
      (e) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(e),
    );
    expect(invented).toEqual([]);
  });
});
