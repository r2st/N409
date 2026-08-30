import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No admin event about a person names another person in its payload.
 *
 * `buildPersonalDataExport` now answers an Art. 15 request with the rows of
 * `admin_events` whose subject is the requester, and it makes one careful
 * omission: `actor_id` is not selected, because which administrator carried
 * the action out is another person's data. That is the same call the export
 * makes about `email_suppressions.released_by` and
 * `contact_submissions.handled_by`.
 *
 * `payload` is selected whole, and it has to be — it is where the substance
 * of an event lives (which roles, which method, which fields) and it is
 * free-form `jsonb`, so there is no schema to enumerate against. That makes it
 * the one field through which the omission can be undone, and it had been:
 * `user_promoted` and `user_demoted` each wrote `promoted_by` / `demoted_by`
 * into the payload, duplicating the `actor_id` column `recordAdminEvent` fills
 * from the very same value. Nothing read either one. The whole effect was to
 * put the withheld fact back into the copy through the field nobody was
 * governing.
 *
 * The rule is stated over the source rather than over a sample of rows,
 * because a row only exists once somebody has been promoted: a test over data
 * passes on a fresh database while the call site is still writing the key.
 *
 * `_by` is the shape rather than a list of names. On this schema an actor is
 * always spelled that way — `created_by`, `updated_by`, `invited_by`,
 * `handled_by`, `released_by`, `placed_by`, `resolved_by`, the whole
 * `ACTOR_COLUMNS` class in `personalDataCensus` — so a family is the honest
 * rule here where it is not for `_name` or `_email`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Every `payload:` object literal that belongs to a user-subject audit write.
 *
 * Two call shapes reach `recordAdminEvent` and both have to be read. The
 * direct one names `subjectType: 'user'` and `payload: { … }` in the same
 * object literal. The other is the ten route-local `audit(...)` helpers, whose
 * subject type is a positional string — `audit(actor, type, 'user', id,
 * label, { … })` — so the payload is the last argument and the subject type is
 * the third. Reading only the first shape would have missed `adminUsers.ts`
 * entirely, which is where both offending keys were.
 */
/** The name of the `function name(` an offset sits inside, if any. */
function enclosingFunction(src: string, offset: number): string | null {
  const declarations = [...src.slice(0, offset).matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  return declarations.length ? declarations[declarations.length - 1]![1]! : null;
}

/**
 * The first object-literal argument of every call to `name` in `src`.
 *
 * Brace-balanced from the `{`, because these arguments span lines and contain
 * ternaries with their own braces — a non-greedy `\{([^{}]*)\}` reads the
 * first nested object and calls it the whole argument.
 */
function objectArgumentsTo(src: string, name: string): string[] {
  const out: string[] = [];
  for (const call of src.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    // Not the declaration. `function auditInvoiceRefund(` matches this pattern
    // too, and the first `{` after its parameter list is the body — which
    // would enter the census as a "payload" holding every key the helper
    // writes, including the `payload:` line the spread is inside.
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, call.index! - 20), call.index!))) continue;
    const open = src.indexOf('{', call.index! + call[0].length);
    if (open === -1) continue;
    // Only an argument of *this* call: a `{` after the call's closing paren
    // belongs to the next statement.
    if (src.slice(call.index!, open).includes(';')) continue;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(src.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Every `payload:` object literal that belongs to a user-subject audit write.
 *
 * Two call shapes reach `recordAdminEvent` and both have to be read. The
 * direct one names `subjectType: 'user'` and `payload: { … }` in the same
 * object literal. The other is the ten route-local `audit(...)` helpers, whose
 * subject type is a positional string — `audit(actor, type, 'user', id,
 * label, { … })` — so the payload is the last argument and the subject type is
 * the third. Reading only the first shape would have missed `adminUsers.ts`
 * entirely, which is where both offending keys were.
 *
 * ## The third shape: a payload the write does not hold
 *
 * `payload: { stripe_event_id: stripeEventId, ...payload }` is a user-subject
 * write whose keys are not at the write. `auditInvoiceRefund` is a local helper
 * taking the payload as a parameter, so a scan that reads the literal sees one
 * key and nothing about the two call sites that supply the rest — and this
 * census reported the file as covered while reading none of what it audits.
 * That is the failure mode a census has that a route sweep does not: it is
 * green because it found nothing, and it found nothing because it stopped one
 * indirection short of the keys.
 *
 * A spread is therefore resolved rather than ignored: the enclosing helper is
 * named, its call sites in the same file are read for their object argument,
 * and those keys join the census. `resolves the keys a payload is spread from`
 * below fails if a spread cannot be followed, so the *next* helper — one
 * defined in another module, or fed from a variable — is a failure here rather
 * than a silent gap.
 */
function userSubjectPayloads(): Array<{ file: string; keys: string[]; spread: string | null }> {
  const out: Array<{ file: string; keys: string[]; spread: string | null }> = [];
  const keysOf = (body: string) => [...body.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*:/gi)].map((m) => m[1]!);
  const push = (file: string, src: string, body: string, offset: number) => {
    // Top-level keys only: a nested object is a value somebody assembled, and
    // the two cases this exists for are flat.
    const keys = keysOf(body);
    const spreadName = /\.\.\.\s*([A-Za-z_$][\w$]*)/.exec(body)?.[1] ?? null;
    let spread: string | null = null;
    if (spreadName) {
      const helper = enclosingFunction(src, offset);
      const forwarded = helper ? objectArgumentsTo(src, helper).flatMap(keysOf) : [];
      // A helper resolved to nothing is not resolved: either the name was
      // wrong or every call site passes a variable, and both are the case the
      // assertion below is for.
      if (helper && forwarded.length > 0) keys.push(...forwarded);
      else spread = spreadName;
    }
    if (keys.length || spread) out.push({ file: path.relative(SRC, file), keys, spread });
  };
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/subjectType:\s*'user'[\s\S]{0,600}?payload:\s*\{([^{}]*)\}/g))
      push(file, src, m[1]!, m.index!);
    for (const m of src.matchAll(/\baudit\(\s*[^;]*?,\s*'user'\s*,[^;]*?\{([^{}]*)\}\s*\)/g))
      push(file, src, m[1]!, m.index!);
  }
  return out;
}

const payloads = userSubjectPayloads();

describe('an audit event about a person does not name another person', () => {
  it('finds the payloads at all', () => {
    // Vacuity guard: the assertion below is over `payloads`, and two regexes
    // over TypeScript that stopped matching would report a clean estate of
    // nothing. Pinned to the two files that certainly carry such writes.
    expect(payloads.length).toBeGreaterThan(5);
    const files = new Set(payloads.map((p) => p.file));
    expect([...files].some((f) => f.endsWith('routes/adminUsers.ts'))).toBe(true);
    expect([...files].some((f) => f.endsWith('routes/scim.ts'))).toBe(true);
  });

  it('resolves the keys a payload is spread from', () => {
    // A spread this census cannot follow is a payload it is not reading. The
    // one that exists — `auditInvoiceRefund`'s — resolves to its two call
    // sites; anything else must be made resolvable or moved to a literal at
    // the write, not left to pass by being invisible.
    expect(
      payloads.filter((p) => p.spread).map((p) => `${p.file}: ...${p.spread}`),
      'a user-subject audit payload assembled from a spread this census cannot read',
    ).toEqual([]);
    // Vacuity guard for the resolution itself: the keys the refund helper's
    // callers supply are in the census, so the `_by` rule below is actually
    // applied to them.
    const payments = payloads.filter((p) => p.file.endsWith('routes/payments.ts')).flatMap((p) => p.keys);
    expect(payments).toContain('refunded_cents');
    expect(payments).toContain('invoice_number');
  });

  it('puts no actor-shaped key in a payload the subject can read', () => {
    const offenders = payloads
      .flatMap(({ file, keys }) => keys.filter((k) => /_by$/.test(k)).map((k) => `${file}: ${k}`))
      .sort();
    // The actor belongs in `actor_id`, which `recordAdminEvent` already fills
    // and the export already withholds. If a payload genuinely needs to say
    // something about who acted, it must say it without naming them.
    expect(offenders).toEqual([]);
  });
});
