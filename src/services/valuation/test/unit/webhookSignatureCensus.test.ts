import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ROUTES } from '../../src/plugins/routeAudit.js';

/**
 * Every inbound webhook proves who sent it, and does it over the bytes it read.
 *
 * A webhook is the one endpoint on this platform that is deliberately
 * unauthenticated and deliberately trusted: no session, no API key, a server on
 * the internet POSTing a fact that the handler then acts on. Stripe's says an
 * invoice was paid; the mail provider's says an address bounced and should be
 * suppressed, which stops a named client's reports arriving. The whole of the
 * authority behind each of those is a signature header, so a handler that
 * forgets to check one is not a weak endpoint — it is an endpoint that lets
 * anybody mark any invoice paid, or silence any recipient, by knowing a URL
 * that is written down in `PUBLIC_ROUTES`.
 *
 * `routeAudit` cannot see this. Its question is "is this route authenticated or
 * written down", and a webhook is written down by construction — the exemption
 * is the point. Nothing then asked whether the reason it gives is true.
 *
 * ## What identifies a webhook here
 *
 * Not a name, and not a URL prefix: `/api/v1/stripe/webhook`,
 * `/api/v1/billing/webhook` and `/api/v1/webhooks/email/:provider` share no
 * spelling, and the next one will not either. What they share is a mechanism.
 * A signature covers *bytes*, so verifying one means holding the body exactly
 * as it arrived — which in Fastify means registering the route inside its own
 * `app.register()` scope with a raw-buffer content parser, so the parser cannot
 * leak to any other route. Each of the three does precisely that, and each says
 * in a comment that it is doing it for that reason.
 *
 * So the trigger is the raw-buffer parser. It is the thing an author copies
 * when they add a fourth webhook, it exists in this codebase for exactly one
 * purpose, and a route that has one and verifies nothing is either a webhook
 * missing its check or a parser nobody needed. Both are worth failing on.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/**
 * The scope body containing a raw-buffer parser, taken by brace balance from
 * the `app.register(` that opens it.
 *
 * Brace-matched rather than read to the next blank line or a fixed number of
 * lines, because the Stripe handler is two hundred lines long and a scan that
 * stops early would find the parser, miss the verification below it, and report
 * a signed webhook as unsigned — a census that fails on correct code gets
 * loosened until it passes, which is how it stops meaning anything.
 */
function rawBodyScopes(source: string): string[] {
  const scopes: string[] = [];
  for (const parser of source.matchAll(/addContentTypeParser\([^)]*parseAs:\s*'buffer'/g)) {
    const opened = source.lastIndexOf('app.register(', parser.index);
    if (opened < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = opened; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    scopes.push(source.slice(opened, end < 0 ? source.length : end + 1));
  }
  return scopes;
}

interface Webhook {
  file: string;
  method: string;
  url: string;
  /** The whole enclosing raw-body scope — the handler and its parser. */
  scope: string;
}

function webhooks(): Webhook[] {
  const found: Webhook[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(ROUTES, file), 'utf8');
    for (const scope of rawBodyScopes(source)) {
      for (const route of scope.matchAll(/\bscope\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
        found.push({ file, method: route[1]!.toUpperCase(), url: route[2]!, scope });
      }
    }
  }
  return found;
}

const WEBHOOKS = webhooks();
const at = (w: Webhook) => `${w.method} ${w.url} (${w.file})`;

/**
 * "This request carries a signature I checked, and I checked it against the
 * raw bytes."
 *
 * Two clauses, both required, because either alone passes on a handler that is
 * wrong. Reading a signature header and never comparing it is the mistake that
 * looks most like the real thing in review; computing an HMAC over
 * `JSON.stringify(req.body)` rather than over the buffer is the one that works
 * in testing and fails in production the first time a provider sends a key
 * order the parser does not reproduce.
 */
const READS_A_SIGNATURE = /headers\[['"][a-z0-9-]*signature['"]\]|stripe-signature/i;
const VERIFIES_IT = /verifyWebhookSignature\(|createHmac\(/;
const OVER_RAW_BYTES = /Buffer\.isBuffer\(raw\)|\.update\(raw\)|payload:\s*raw/;

/** And refuses when it does not match, rather than logging and carrying on. */
const REFUSES = /throw problems\.(unauthorized|badRequest)\(/;

describe('inbound webhooks verify their signature', () => {
  it('finds the webhooks it is auditing', () => {
    // Named, not counted. A regex that stopped matching would leave this file
    // asserting nothing about an empty list, which is the failure mode every
    // census in this suite is written to avoid — and the one that matters most
    // here, because the set is three routes rather than three hundred and a
    // typo empties it completely.
    expect(WEBHOOKS.map((w) => `${w.method} ${w.url}`).sort()).toEqual([
      'POST /api/v1/billing/webhook',
      'POST /api/v1/stripe/webhook',
      'POST /api/v1/webhooks/email/:provider',
    ]);
  });

  it('every one of them reads a signature header', () => {
    expect(WEBHOOKS.filter((w) => !READS_A_SIGNATURE.test(w.scope)).map(at)).toEqual([]);
  });

  it('every one of them verifies it cryptographically', () => {
    // Rather than comparing it to something, or trusting a provider id in the
    // body — both of which a caller supplies along with the payload.
    expect(WEBHOOKS.filter((w) => !VERIFIES_IT.test(w.scope)).map(at)).toEqual([]);
  });

  it('every one of them verifies over the raw body, not the parsed one', () => {
    expect(WEBHOOKS.filter((w) => !OVER_RAW_BYTES.test(w.scope)).map(at)).toEqual([]);
  });

  it('every one of them refuses the request when it does not match', () => {
    expect(WEBHOOKS.filter((w) => !REFUSES.test(w.scope)).map(at)).toEqual([]);
  });

  it('every one of them is written down as public, and says the signature is why', () => {
    // The two halves of the same claim. A webhook that is not in PUBLIC_ROUTES
    // fails boot, so this direction is already covered — what is not is a
    // reason that has drifted away from the code, which is how a route ends up
    // documented as signature-authenticated after somebody removed the check.
    for (const w of WEBHOOKS) {
      const entry = PUBLIC_ROUTES.find((r) => r.method === w.method && r.url === w.url);
      expect(entry, at(w)).toBeDefined();
      expect(entry!.reason, at(w)).toMatch(/signature/i);
    }
  });

  it('no route claims a request signature it does not verify', () => {
    // The inverse, and the thing that stops the case above from being
    // satisfiable by writing the word into every reason: an entry may cite a
    // *signature* only when there is a raw-body handler behind it.
    //
    // Keyed on that word specifically and not on "signed", because the
    // allow-list uses the two for different mechanisms and only one of them is
    // this file's business. A *signature* is computed by somebody else over the
    // bytes of this request and checked here — Stripe's header, the mail
    // provider's HMAC. A *signed* state or token is a bearer this platform
    // minted earlier and is now redeeming: the OAuth callbacks' `state`, the
    // one-click unsubscribe token, the SAML assertion (XML-DSig inside the
    // SAMLResponse field, validated against the IdP certificate by
    // `validatePostResponseAsync`, which needs the form parsed rather than held
    // as bytes). Those have their own guards — `domain/unsubscribeToken`,
    // `portalTokenHygiene` — and holding them to a raw-body parser would be
    // asserting the wrong mechanism.
    const signed = new Set(WEBHOOKS.map((w) => `${w.method} ${w.url}`));
    const overclaimed = PUBLIC_ROUTES.filter(
      (r) => /\bsignature\b/i.test(r.reason) && !signed.has(`${r.method.toUpperCase()} ${r.url}`),
    ).map((r) => `${r.method} ${r.url}`);
    expect(overclaimed).toEqual([]);
  });

  it('reads an unverified raw-body handler as a violation', () => {
    // The mechanism, against a handler shaped like the ones above but missing
    // the check — so a regex that stopped matching fails here rather than
    // passing the sweep by finding nothing to complain about.
    const source = `
      void app.register(async (scope) => {
        scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
          done(null, body),
        );
        scope.post('/api/v1/vendor/webhook', async (req, reply) => {
          const event = JSON.parse((req.body as Buffer).toString('utf8'));
          return reply.send({ received: true, type: event.type });
        });
      });
    `;
    const scopes = rawBodyScopes(source);
    expect(scopes).toHaveLength(1);
    expect(READS_A_SIGNATURE.test(scopes[0]!)).toBe(false);
    expect(VERIFIES_IT.test(scopes[0]!)).toBe(false);
    // …and that the scan would have found the route to report.
    expect([...scopes[0]!.matchAll(/\bscope\.(post)\(\s*'([^']+)'/g)].map((m) => m[2])).toEqual([
      '/api/v1/vendor/webhook',
    ]);
  });

  it('every one of them counts what it refused', () => {
    /*
     * The census above proves each door refuses an unproven request. This is
     * the half after it: that the refusal leaves a trace anything on the box
     * can see.
     *
     * A signature is a secret held on two machines and neither tells the other
     * when it changes. A rotation that misses this deployment refuses *every*
     * delivery — Stripe retries for days and gives up, and on this side no
     * payment is fulfilled and no bounce is recorded. The refusal is a 4xx, and
     * `registerProblemHandler` leaves 4xx unlogged on purpose ("those describe
     * the request, the caller was told"), which is right for a browser and
     * wrong for the one caller that is a machine and cannot tell anybody it is
     * being turned away.
     *
     * So: the counter, not a log line, for the reason the sweep tallies became
     * counters in R321 — nothing on this box consumes a log field, and the
     * scrape is what an alert can be written against.
     */
    const COUNTS_REFUSALS = /refuseInboundWebhook\(/;
    expect(WEBHOOKS.filter((w) => !COUNTS_REFUSALS.test(w.scope)).map(at)).toEqual([]);
  });

  it('every one of them counts the deliveries it accepted, for the denominator', () => {
    // A refusal count alone cannot separate one scanner POSTing junk at a URL
    // that is written down in PUBLIC_ROUTES from a secret that has been wrong
    // since Tuesday. Same reason `background_sweep_runs_total` exists beside
    // the failure count.
    const COUNTS_ACCEPTED = /recordInboundWebhook\([^)]*'accepted'\)/;
    expect(WEBHOOKS.filter((w) => !COUNTS_ACCEPTED.test(w.scope)).map(at)).toEqual([]);
  });

  /**
   * R346, methodology M6: the guard these three routes step outside of.
   *
   * `app.ts`'s `preValidation` hook refuses any request carrying text Postgres
   * will not store — a NUL or an unpaired surrogate — before a handler can hand
   * it to the driver, and it is global precisely because the exposure is
   * per-column rather than per-route. A raw-body webhook is the one shape that
   * escapes it: the hook needs a parsed body, a signature needs the bytes that
   * arrived, so this scope hands Fastify a Buffer, the hook walks past it, and
   * the object only exists inside the handler.
   *
   * What that costs is not a dropped row. Every one of these three writes what
   * it read into a `text` or `jsonb` column, the driver refuses the character,
   * and the handler answers a 5xx — which to a provider is a delivery to retry,
   * not an answer. The same body then fails the same way on every redelivery.
   * `parseStripeEvent` was taught to scan its own envelope for this; the mail
   * delivery door was written to the same pattern without that half and sat in
   * a permanent 503 redelivery loop for one bad character in a bounce message.
   *
   * So: a raw-body scope must scan the object it parsed. Matched on the scan
   * rather than on a spelling of the refusal, because the two callers are
   * different shapes — one returns an error, one throws — and the scan is the
   * thing an author copying this pattern has to remember.
   */
  it('every one of them scans the body it parsed for text the database will not store', () => {
    // `parseStripeEvent` is the shared form: it runs `findUnstorableText` over
    // the whole envelope and answers an error the handler turns into a 400.
    const SCANS_ITS_BODY = /findUnstorableText\(|parseStripeEvent\(/;
    expect(WEBHOOKS.filter((w) => !SCANS_ITS_BODY.test(w.scope)).map(at)).toEqual([]);
  });

  it('reads a raw-body handler that never scans as a violation', () => {
    // The mechanism again, so the assertion above cannot pass by matching
    // nothing: a handler shaped like a webhook with the scan left out.
    const source = `
      void app.register(async (scope) => {
        scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
          done(null, body),
        );
        scope.post('/api/v1/vendor/webhook', async (req, reply) => {
          const raw = req.body as Buffer;
          const expected = createHmac('sha256', secret).update(raw).digest('hex');
          if (expected !== req.headers['x-signature']) throw problems.unauthorized('no');
          return reply.send({ received: true });
        });
      });
    `;
    const scope = rawBodyScopes(source)[0]!;
    expect(/findUnstorableText\(|parseStripeEvent\(/.test(scope)).toBe(false);
  });

  it('takes the whole scope, not the lines nearest the parser', () => {
    // The brace balance is what makes the assertions above trustworthy on the
    // Stripe handler, whose verification sits well below the parser and whose
    // scope runs for hundreds of lines. A scan with a fixed lookahead would
    // report it as unsigned.
    const stripe = WEBHOOKS.find((w) => w.url === '/api/v1/stripe/webhook');
    expect(stripe, 'the Stripe webhook still exists').toBeDefined();
    expect(stripe!.scope.split('\n').length).toBeGreaterThan(100);
  });
});
