import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scrubSensitive } from '../src/problem.js';

/**
 * The two shape-matched redaction nets, held to the same list of kinds.
 *
 * This platform scrubs free text in two places and by two mechanisms that
 * cannot share code: `scrubSensitive` (packages/shared/src/problem.ts) for the
 * Node services, and `_REDACTIONS` (services/{ai,engine-wrapper}/app/
 * observability.py) for the Python pair. Field-name redaction — pino's
 * `redact` paths, held by `logger.test.ts` — reaches neither, because what
 * these two catch is a *value inside a sentence*: a DSN in an exception, an
 * address Postgres quoted back in a constraint violation, a credential a
 * provider echoed into its refusal.
 *
 * Nothing held them to each other, and they drifted the way two hand-kept
 * lists do — each gaining the rule whoever was looking had just been burned by.
 * At R266 the Node tier, which owns `users.phone` and
 * `contact_submissions.phone`, had **no phone rule at all** and no EIN rule,
 * while the Python tier, which owns neither column, had both. And the Python
 * phone rule required a separator between the groups, so it could not match
 * canonical E.164 (`+15551234567`) — which is the only form `domain/phone.ts`
 * ever stores, and therefore the only form a driver error can quote back.
 *
 * So the rule is: a kind is redacted in both tiers, or it carries a written
 * reason for living in one. The reasons are the record of what each tier is
 * exposed to.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const JS_SOURCE = path.resolve(HERE, '../src/problem.ts');
const PY_SOURCES = [
  path.join(ROOT, 'src/services/ai/app/observability.py'),
  path.join(ROOT, 'src/services/engine-wrapper/app/observability.py'),
];

/**
 * One kind of thing a shape rule strikes, and the marker each tier leaves
 * behind when it strikes one.
 *
 * The marker is the anchor rather than the pattern: two tiers cannot share a
 * regex — JS and Python differ on verbose mode, lookbehind support and escape
 * handling — but they can be made to agree on *what they claim to catch*, and
 * a rule that stops matching still has to have its marker deleted, which is
 * the edit this census sees.
 */
const KINDS: { kind: string; js: string | null; py: string | null; why?: string }[] = [
  { kind: 'email address', js: '[REDACTED-EMAIL]', py: '[EMAIL]' },
  { kind: 'US social security number', js: '[REDACTED-SSN]', py: '[SSN]' },
  { kind: 'US employer identification number', js: '[REDACTED-EIN]', py: '[EIN]' },
  { kind: 'phone number', js: '[REDACTED-PHONE]', py: '[PHONE]' },
  { kind: 'bearer credential', js: '$1[REDACTED]', py: 'Bearer [REDACTED]' },
  { kind: 'provider API key', js: '[REDACTED-KEY]', py: '[API_KEY]' },
  { kind: 'AWS access key id', js: '[REDACTED-KEY]', py: '[AWS_KEY_ID]' },
  {
    kind: 'JSON web token',
    js: '[REDACTED-JWT]',
    py: null,
    why:
      'A JWT reaches the Node tier as a session or a `state` parameter, both of which it issues. ' +
      'Nothing hands one to the Python pair: the internal hop authenticates with a shared secret ' +
      "the literal-value net already covers, and a client's token never crosses it.",
  },
  {
    kind: 'connection-string credentials',
    js: '$1[REDACTED]@',
    py: null,
    why:
      'The founding case (audit B-1 P3) and a Node one: `pg` puts the DSN in the message of a ' +
      'connection failure. The Python pair holds no database credential — it reaches Postgres ' +
      'through the valuation service, not directly.',
  },
  {
    kind: 'AWS SigV4 signature',
    js: null,
    py: 'Signature=[REDACTED]',
    why:
      '`services/ai/app/bedrock.py` builds the SigV4 authorization header by hand, and AWS quotes ' +
      'the string-to-sign back in a `SignatureDoesNotMatch` body. No Node service signs an AWS ' +
      'request; the estate reaches Bedrock only through the AI tier.',
  },
];

/** Every `"[SOMETHING]"` replacement a Python redaction rule names. */
function pythonMarkers(source: string): Set<string> {
  const block = source.slice(source.indexOf('_REDACTIONS'), source.indexOf('_SECRET_ENV_VARS'));
  // The replacement half of a `(pattern, replacement)` pair, which is the
  // string followed by the tuple's closing paren — a marker written anywhere
  // else in the block would be a comment, not a rule.
  return new Set([...block.matchAll(/,\s*"([^"]*\[[A-Z_]+\][^"]*)"\s*,?\s*\)/g)].map((m) => m[1]));
}

/** Every replacement string the JS scrub substitutes in. */
function jsMarkers(source: string): Set<string> {
  const fn = source.slice(source.indexOf('export function scrubSensitive'), source.indexOf('scrubError'));
  return new Set([...fn.matchAll(/,\s*'([^']*\[[A-Z-]+\][^']*)'\)/g)].map((m) => m[1]));
}

describe('the two free-text redaction nets cover the same kinds', () => {
  const js = readFileSync(JS_SOURCE, 'utf8');
  const pySources = PY_SOURCES.map((p) => ({ path: p, source: readFileSync(p, 'utf8') }));

  it('finds rules in both tiers at all — the vacuity guard', () => {
    expect(jsMarkers(js).size).toBeGreaterThanOrEqual(6);
    for (const { path: p, source } of pySources) {
      expect(pythonMarkers(source).size, `no rules parsed from ${p}`).toBeGreaterThanOrEqual(6);
    }
  });

  it('declares every kind in the tier that claims it', () => {
    const found = jsMarkers(js);
    const missing = KINDS.filter((k) => k.js !== null && !found.has(k.js));
    expect(missing.map((k) => k.kind)).toEqual([]);
    for (const { path: p, source } of pySources) {
      const pyFound = pythonMarkers(source);
      const gone = KINDS.filter((k) => k.py !== null && !pyFound.has(k.py));
      expect(gone.map((k) => `${k.kind} (${path.basename(path.dirname(path.dirname(p)))})`)).toEqual([]);
    }
  });

  it('accounts for every rule either tier has — a new one fails until the other is considered', () => {
    const declaredJs = new Set(KINDS.map((k) => k.js).filter((m): m is string => m !== null));
    const declaredPy = new Set(KINDS.map((k) => k.py).filter((m): m is string => m !== null));
    expect([...jsMarkers(js)].filter((m) => !declaredJs.has(m))).toEqual([]);
    for (const { source } of pySources) {
      expect([...pythonMarkers(source)].filter((m) => !declaredPy.has(m))).toEqual([]);
    }
  });

  it('gives a reason for every kind only one tier carries', () => {
    const lopsided = KINDS.filter((k) => k.js === null || k.py === null);
    expect(lopsided.length).toBeGreaterThan(0);
    for (const k of lopsided) expect(k.why ?? '', k.kind).not.toHaveLength(0);
  });

  it('keeps the Python pair saying the same thing as each other', () => {
    const [first, ...rest] = pySources.map(({ source }) => [...pythonMarkers(source)].sort());
    for (const other of rest) expect(other).toEqual(first);
  });
});

/**
 * The behaviour behind the markers, on the tier this file can execute.
 *
 * The census above reads source; these run the function. Both are needed —
 * a marker present in a rule that no longer matches is exactly the vacuous
 * check this estate keeps finding.
 */
describe('scrubSensitive strikes the shapes this platform stores', () => {
  it('redacts a canonical E.164 number, the only form `domain/phone.ts` writes', () => {
    expect(scrubSensitive('call +15551234567 back')).toBe('call [REDACTED-PHONE] back');
    // The case that motivated it: a CHECK violation's `detail` is the whole row.
    expect(scrubSensitive('Failing row contains (01J, Ada Lovelace, +442079460000).')).toBe(
      'Failing row contains (01J, Ada Lovelace, [REDACTED-PHONE]).',
    );
  });

  it('redacts the separated forms a person types into the contact form', () => {
    expect(scrubSensitive('rang (415) 555-0143 twice')).toBe('rang [REDACTED-PHONE] twice');
    expect(scrubSensitive('+1 555-123-4567 typed')).toBe('[REDACTED-PHONE] typed');
  });

  it('redacts an EIN', () => {
    expect(scrubSensitive('ein 12-3456789 on file')).toBe('ein [REDACTED-EIN] on file');
  });

  it('redacts an STS session key id, not only the long-lived form', () => {
    expect(scrubSensitive('using ASIAIOSFODNN7EXAMPLE now')).toBe('using [REDACTED-KEY] now');
  });

  it("leaves a valuation's own numbers alone", () => {
    // Every one of these is a figure this platform prints: a fully-diluted share
    // count, a cent amount, an epoch, a timezone offset, a per-share price.
    for (const benign of [
      'fully diluted 12345678901 shares',
      'total 5,000,000 cents',
      'at 1756612800000',
      'stamped +0530',
      'offset +05:30',
      'FMV 4.1234 per share',
      'engine returned 422 after 30s',
    ]) {
      expect(scrubSensitive(benign), benign).toBe(benign);
    }
  });
});
