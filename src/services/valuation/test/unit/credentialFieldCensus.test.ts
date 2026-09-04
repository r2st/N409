import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_ISSUED_CREDENTIAL_CHARS,
  MAX_TOKEN_CHARS,
  issuedCredentialField,
  newPasswordField,
  presentedPasswordField,
  tokenField,
} from '../../src/domain/credentialFields.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../src/domain/passwordPolicy.js';
import { sourceFiles } from '../support/sourceFiles.js';
import { blankNonCode, chainAfter } from '../support/zodChain.js';

/**
 * Every credential a caller sends is bounded by its own schema (R426, M4).
 *
 * 246 `z.string()`s are declared in `src/routes` and all but a dozen carry a
 * `.max()`. The dozen were not a scattering — they were a category. Passwords
 * (`z.string().min(10, …)` at register, reset, change, accept-invite and the
 * admin console; `z.string().min(1)` at sign-in and at every `current_password`
 * re-auth), the six single-purpose tokens this platform mints and emails, the
 * MFA challenge, and the OIDC `code`/`state`. Fifteen fields, every one of them
 * on the unauthenticated identity surface, and not one of them had a ceiling.
 *
 * What bounded them instead was Fastify's 1 MiB body limit, and
 * `routes/bodyLimits.ts` already says what is wrong with that, about three
 * other routes: the 413 is raised by the content-type parser, "so it names no
 * field and quotes no limit". On a credential that is the worst case of it. The
 * caller cannot see what they pasted; the one field they would look at is the
 * one the refusal does not name; and the field beside it in the same schema —
 * `first_name`, `email` — would have been refused with its own name and its own
 * limit. It also decided how much work an unauthenticated request could buy:
 * `verifyPassword` hands the whole string to scrypt, whose first step is linear
 * in the length, on the one route answered before anything else on the box.
 *
 * The rule is stated over the route table rather than fixed fifteen times,
 * because a sixteenth password box is a routine thing to add and `min(1)` is
 * the obvious way to write it. A field whose name says it carries a credential
 * is one of the four helpers in `domain/credentialFields.ts`, or it is named
 * below with what bounds it instead.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/** Field names that carry a credential rather than describing one. */
const HELPERS = ['newPasswordField', 'presentedPasswordField', 'tokenField', 'issuedCredentialField'] as const;

/**
 * The lookahead accepts the helpers as well as `z.`, because a field that has
 * been fixed must stay in the population — a census that only sees the
 * unconverted spelling cannot tell "converted" from "deleted", and the day the
 * last one is converted it starts passing on an empty set.
 */
const CREDENTIAL_FIELD = new RegExp(
  `(?:^|[{,(\\s])((?:new_|current_|old_)?password|token|challenge|code|state|secret)\\s*:\\s*(?=z\\.|${HELPERS.join('|')})`,
  'g',
);

/**
 * There is no exemption list, and that is a claim rather than an omission.
 *
 * `code` and `state` are also how a TOTP field, a zod issue code and an
 * engagement state are spelled, so the population picks up more names than it
 * means to — and every one of them answers the rule on its own terms: the TOTP
 * digits are `z.string().min(6).max(10)`, an engagement state is
 * `z.enum(VALUATION_STATES)`, and `z.ZodIssueCode.custom` is not a schema. The
 * three other OAuth callbacks (`accounting.ts`, `capTableSync.ts`, `hris.ts`)
 * had already bounded their `code`/`state` at 4096, which is where
 * `MAX_ISSUED_CREDENTIAL_CHARS` comes from: the Google/OIDC callback beside
 * them was the one that had not.
 *
 * So a name that lands here and cannot answer is a finding, not a candidate for
 * a list — and the day one genuinely needs an exemption, it gets the same
 * treatment `emailBounds` and the route audit give theirs: named, with what
 * bounds it instead.
 */

interface Site {
  file: string;
  line: number;
  field: string;
  /** The schema expression the field is declared as, comments and strings blanked. */
  expression: string;
  text: string;
}

/**
 * Is this field's schema bounded by its own expression?
 *
 * Three answers count. One of the helpers, which carries the figure. A
 * `z.enum(…)`, whose members *are* the bound. Or a `.max()` in the member chain
 * of the expression itself — chained onto the `z.string()`, not merely present
 * on the line, for the reason `emailBounds` gives about `.max(10)` on an array
 * of addresses.
 */
function bounded(site: Site): boolean {
  const expression = site.expression;
  if (HELPERS.some((helper) => expression.startsWith(helper))) return true;
  const head = /^z\.(\w+)\(/.exec(expression);
  // `z.ZodIssueCode.custom` is a `code:` and is not a schema at all.
  if (!head) return true;
  if (head[1] === 'enum' || head[1] === 'literal') return true;
  let depth = 0;
  let end = head[0].length - 1;
  for (; end < expression.length; end++) {
    if (expression[end] === '(') depth += 1;
    else if (expression[end] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return chainAfter(expression, end + 1).includes('max');
}

function credentialSites(): Site[] {
  const found: Site[] = [];
  for (const file of sourceFiles(ROUTES)) {
    const source = readFileSync(file, 'utf8');
    const code = blankNonCode(source);
    const rel = path.basename(file);
    for (const match of code.matchAll(CREDENTIAL_FIELD)) {
      const line = code.slice(0, match.index!).split('\n').length;
      found.push({
        file: rel,
        line,
        field: match[1]!,
        expression: code.slice(match.index! + match[0].length),
        text: source.split('\n')[line - 1]!.trim(),
      });
    }
  }
  return found;
}

describe('every credential field carries its own ceiling', () => {
  const sites = credentialSites();

  it('finds the credential fields at all — the population is not silently empty', () => {
    // Fifteen were fixed; the scan sees those plus the exempted look-alikes.
    // A refactor that renames the helpers must fail here rather than pass on an
    // empty sweep.
    expect(sites.length).toBeGreaterThan(10);
    expect(sites.map((s) => s.file)).toContain('auth.ts');
  });

  it('leaves none bounded only by the transport', () => {
    const unbounded = sites
      .filter((s) => !bounded(s))
      .map((s) => `${s.file}:${s.line}  ${s.text}`);
    expect(unbounded).toEqual([]);
  });

});

describe('the helpers bound what they say they bound', () => {
  it('refuses a password one character past the ceiling, and accepts it at it', () => {
    const at = `a1${'x'.repeat(PASSWORD_MAX_LENGTH - 2)}`;
    expect(newPasswordField().safeParse(at).success).toBe(true);
    expect(newPasswordField().safeParse(`${at}x`).success).toBe(false);
    expect(presentedPasswordField().safeParse(at).success).toBe(true);
    expect(presentedPasswordField().safeParse(`${at}x`).success).toBe(false);
  });

  it('keeps the floor split: a set password meets the policy minimum, a presented one need not', () => {
    // A password set before a deployment raised `password_min_length` is still
    // that account's password. Refusing it at the sign-in schema would lock the
    // account out of the route that changes it.
    const short = 'a1';
    expect(short.length).toBeLessThan(PASSWORD_MIN_LENGTH);
    expect(newPasswordField().safeParse(short).success).toBe(false);
    expect(presentedPasswordField().safeParse(short).success).toBe(true);
    expect(presentedPasswordField().safeParse('').success).toBe(false);
  });

  it('names the field in the refusal, which is the whole point of moving the bound here', () => {
    const refusal = newPasswordField().safeParse('a1'.repeat(PASSWORD_MAX_LENGTH));
    expect(refusal.success).toBe(false);
    if (!refusal.success) {
      expect(refusal.error.issues[0]!.message).toContain(String(PASSWORD_MAX_LENGTH));
    }
  });

  it('bounds a minted token and an issued one at their own figures', () => {
    expect(tokenField().safeParse('x'.repeat(MAX_TOKEN_CHARS)).success).toBe(true);
    expect(tokenField().safeParse('x'.repeat(MAX_TOKEN_CHARS + 1)).success).toBe(false);
    expect(issuedCredentialField().safeParse('x'.repeat(MAX_ISSUED_CREDENTIAL_CHARS)).success).toBe(true);
    expect(issuedCredentialField().safeParse('x'.repeat(MAX_ISSUED_CREDENTIAL_CHARS + 1)).success).toBe(
      false,
    );
  });

  it('leaves room for what the platform actually mints', () => {
    // The secrets are 32 random bytes as base64url (43 characters), carried
    // alone or as `id.secret`; the challenge is a two-claim JWS.
    expect(MAX_TOKEN_CHARS).toBeGreaterThan(26 + 1 + 43);
    expect(MAX_ISSUED_CREDENTIAL_CHARS).toBeGreaterThan(MAX_TOKEN_CHARS);
  });
});
