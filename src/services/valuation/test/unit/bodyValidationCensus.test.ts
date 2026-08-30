import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRoutes } from '../support/routeSource.js';

/**
 * A request body read by cast rather than by schema.
 *
 * Two hundred and ten mutations in this service take a body, and all but a
 * handful parse it with zod before touching it. The handful is the point: the
 * shape that escapes is
 *
 *     const label = (req.body as { label?: string } | undefined)?.label;
 *
 * which compiles, reads as deliberate, and does none of the four things the
 * schema beside it would. It does not refuse an unknown field — every body
 * schema here is `.strict()`, so a misspelt one is a 422 and not a silently
 * dropped value. It does not refuse a wrong type. It does not name the field
 * in `detail`, which is the only part of a problem document a user ever sees
 * (`domain/validationProblem.ts`). And where the cast is followed by a bound
 * of its own — `.slice(0, 200)` on the SCIM token label, the one site this
 * census was written for — it *truncates* what a schema would refuse, storing
 * a row the caller did not ask for and cannot tell apart from the one they
 * wanted. That cut had a second edge: two hundred UTF-16 units can land inside
 * an astral character, and the orphaned half is a string the `jsonb` payload
 * of the audit event cannot hold (domain/textSlice.ts).
 *
 * So the rule, stated over the whole route table: a handler that reads
 * `req.body` parses it, or is named below with what validates it instead.
 * Every exemption here is a route whose body is *not* JSON this service's
 * schemas describe — a signed webhook envelope, a SAML assertion, a SCIM
 * payload with its own specified shape — and each names the validator that
 * stands in for zod.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Routes whose body is validated by something other than a zod schema. */
const VALIDATED_ELSEWHERE: Record<string, string> = {
  'POST /api/v1/stripe/webhook':
    'The body is a raw Buffer, because the `stripe-signature` HMAC is over the exact bytes: `verifyWebhookSignature` runs before anything reads it, and `parseStripeEvent` in `domain/stripeEvents.ts` is what turns it into an envelope. A zod pass over `req.body` here would be validating a Buffer.',
  'POST /api/v1/billing/webhook':
    'The subscription-lifecycle half of the Stripe surface, on its own `verifyWebhookSignature` check over the raw bytes and read by the same `parseStripeEvent` in `domain/stripeEvents.ts`.',
  'POST /api/v1/webhooks/email/:provider':
    'A raw Buffer for the same reason — the `x-n409-signature` HMAC is over the bytes. It *is* schema-validated: the handler JSON-parses the buffer and runs `WebhookBody.safeParse` over the result, which is one step further from `req.body` than this census’s matcher reaches.',
  'POST /api/v1/auth/saml/acs':
    'Not JSON: a form-urlencoded `SAMLResponse`, whose trust is the XML signature `validatePostResponseAsync` checks against the configured IdP certificate. A schema over the envelope would assert nothing the signature does not.',
  'POST /scim/v2/Users':
    'A SCIM user resource, validated by `parseScimUser` in `domain/scim.ts` against RFC 7643 rather than by a zod schema — the refusal has to be a SCIM error document with SCIM field names, because an IdP connector shows `detail` to a directory administrator verbatim.',
  'PATCH /scim/v2/Users/:id':
    'A SCIM PATCH operations list, read by `activeFromPatch` in `domain/scim.ts` against RFC 7644 for the same reason as the create above.',
};

const routes = scanRoutes(ROUTES);

/** Handlers that touch `req.body` without parsing it. */
function unparsedBodies(): string[] {
  return routes
    .filter((r) => MUTATIONS.has(r.method))
    .filter((r) => /\b(?:req|request)\.body\b/.test(r.body))
    .filter((r) => !/(?:safeParse|\.parse)\(\s*(?:req|request)\.body/.test(r.body))
    .map((r) => `${r.method} ${r.url}`)
    .sort();
}

describe('every mutation body is parsed before it is used', () => {
  it('is reading a route table of the size this service has', () => {
    // The vacuity guard. A census whose scan stops matching reports a clean
    // surface, which is the failure `routeSourceScan` exists to catch one
    // level down — this is the same check at this file's own population.
    expect(routes.filter((r) => MUTATIONS.has(r.method)).length).toBeGreaterThan(150);
    expect(routes.filter((r) => /\b(?:req|request)\.body\b/.test(r.body)).length).toBeGreaterThan(100);
  });

  it('has every unparsed body accounted for', () => {
    expect(unparsedBodies().filter((k) => !(k in VALIDATED_ELSEWHERE))).toEqual([]);
  });

  it('accounts for nothing that has started parsing its body', () => {
    const unparsed = new Set(unparsedBodies());
    expect(Object.keys(VALIDATED_ELSEWHERE).filter((k) => !unparsed.has(k))).toEqual([]);
  });

  it('names a validator, not an assurance, for every exemption', () => {
    // The failure this catches is an entry added in a hurry that says the body
    // is "trusted". Nothing that arrives over HTTP is; the question is which
    // code checks it, and the answer has to be a place in this repository.
    const vague: string[] = [];
    for (const [key, why] of Object.entries(VALIDATED_ELSEWHERE)) {
      if (why.trim().length < 60) vague.push(key);
      if (!/[a-zA-Z]\.ts|`[A-Za-z][\w.-]*`|RFC \d/.test(why)) vague.push(key);
      if (/\btrusted\b|\binternal only\b|\bno need\b/i.test(why)) vague.push(key);
    }
    expect(vague).toEqual([]);
  });

  it('holds the SCIM token label to a schema rather than a slice', () => {
    // The finding. It is asserted by name as well as by the census above,
    // because the census would go quiet again the day somebody re-introduced
    // the cast *and* added an exemption for it.
    const route = routes.find((r) => `${r.method} ${r.url}` === 'POST /api/v1/admin/sso/scim-tokens');
    expect(route).toBeDefined();
    expect(route!.body).toContain('ScimTokenBody.safeParse');
    expect(route!.body).not.toContain('.slice(0, 200)');
  });
});
