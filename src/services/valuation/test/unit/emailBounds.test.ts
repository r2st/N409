import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EmailAddress, MAX_EMAIL_LENGTH, isStorableEmail } from '../../src/domain/email.js';
import { SYSTEM_SETTINGS_SCHEMA, SYSTEM_SETTINGS_DEFAULTS } from '../../src/domain/systemSettings.js';
import { extractIdentity } from '../../src/routes/saml.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * Every address entering this service is length-bounded.
 *
 * `z.string().email()` checks a shape and not a size. Seven schemas spelled the
 * field that way — including `POST /api/v1/auth/register`, which needs no
 * session — so the only ceiling on an address was Fastify's 1 MB body limit.
 *
 * The database is what made that matter. `users.email` is `text`, but
 * `users_email_key` is a unique b-tree over `lower(email)`, and a b-tree index
 * tuple cannot exceed 2704 bytes. An address past that fails the INSERT with
 * `54000 index row size … exceeds btree version 4 maximum` — which is not a
 * unique violation, so the 409 branch does not catch it — and the public
 * registration form answers 500 to what is an input problem, in a log line
 * carrying the whole address.
 *
 * 320 is RFC 5321: 64 octets of local part, `@`, 255 of domain. It is what
 * routes/contact.ts and routes/clientIntake.ts already used; this is that answer
 * applied to the routes that had none.
 */
describe('EmailAddress', () => {
  const local = (n: number) => 'a'.repeat(n);
  const atLimit = `${local(MAX_EMAIL_LENGTH - '@example.com'.length)}@example.com`;

  it('is the RFC 5321 bound', () => {
    expect(MAX_EMAIL_LENGTH).toBe(320);
    expect(atLimit).toHaveLength(320);
  });

  it('accepts an address exactly at the bound', () => {
    expect(EmailAddress.parse(atLimit)).toBe(atLimit);
  });

  it('refuses one character past it', () => {
    expect(EmailAddress.safeParse(`a${atLimit}`).success).toBe(false);
  });

  it('refuses the sizes that break the b-tree index, not merely absurd ones', () => {
    // 2704 is the b-tree index tuple ceiling; anything at or past it used to
    // reach the INSERT and come back as 54000.
    for (const n of [2704, 4000, 100_000]) {
      expect(isStorableEmail(`${local(n)}@corp.com`)).toBe(false);
    }
  });

  it('still refuses what it always refused', () => {
    for (const bad of ['', 'not-an-address', 'a@', '@corp.com', 'a b@corp.com']) {
      expect(isStorableEmail(bad)).toBe(false);
    }
  });

  /**
   * Trimming is new, and it is a loosening: zod's email regex is anchored and
   * `\s` is in none of its classes, so a padded address used to be a 422. It
   * matters because `routes/auth.ts` charges its per-email throttle to
   * `email.toLowerCase()` — normalising means one bucket per address rather
   * than one per spelling of it.
   */
  it('normalises the padding a client sends rather than refusing it', () => {
    expect(EmailAddress.parse('  Ada@Example.com  ')).toBe('Ada@Example.com');
  });

  it('rejects a non-string without throwing', () => {
    for (const bad of [null, undefined, 42, {}, ['a@b.com']]) {
      expect(isStorableEmail(bad)).toBe(false);
    }
  });
});

/**
 * The sweep. A new route reaching for `z.string().email()` reintroduces exactly
 * the gap this round closed, and the seven original sites were all found by
 * grep — so grep is what keeps them closed.
 */
describe('no schema accepts an unbounded email', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

  /**
   * Where an unbounded address is checked instead of at the schema.
   *
   * Same contract as the route-audit and finite-number exemption lists: each
   * entry names what bounds it, so a reviewer can go and read that check.
   */
  const BOUNDED_ELSEWHERE: ReadonlyArray<{ file: string; reason: string }> = [
    {
      file: 'domain/email.ts',
      reason: 'the module that defines the bound; `.max()` is applied on the next line',
    },
  ];
  const exempt = new Set(BOUNDED_ELSEWHERE.map((e) => e.file));

  function unboundedEmailSites(): string[] {
    const sites: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        if (!/\.email\(\)/.test(line)) return;
        if (/\.max\(/.test(line)) return;
        const rel = path.relative(SRC, file);
        if (exempt.has(rel)) return;
        sites.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    return sites;
  }

  it('finds the .email() sites at all (the scan is not silently empty)', () => {
    const scanned = sourceFiles(SRC).filter((f) => readFileSync(f, 'utf8').includes('.email()'));
    expect(scanned.length).toBeGreaterThan(3);
  });

  it('leaves none unbounded outside the exemption list', () => {
    expect(unboundedEmailSites()).toEqual([]);
  });

  it('keeps the exemption list honest — every entry still has a site', () => {
    for (const entry of BOUNDED_ELSEWHERE) {
      const source = readFileSync(path.join(SRC, entry.file), 'utf8');
      expect(source, `${entry.file} no longer has a .email() site`).toContain('.email()');
    }
  });
});

/** The settings row an admin edits is written to a column the same rules apply to. */
describe('system settings support_email', () => {
  const settings = (email: string) =>
    SYSTEM_SETTINGS_SCHEMA.safeParse({ ...SYSTEM_SETTINGS_DEFAULTS, support_email: email });

  it('accepts an ordinary address', () => {
    expect(settings('help@corp.com').success).toBe(true);
  });

  it('refuses one past the bound', () => {
    expect(settings(`${'a'.repeat(400)}@corp.com`).success).toBe(false);
  });
});

/**
 * SAML's identity extraction, which is the other JIT provisioning path.
 *
 * The assertion is signed, which makes the IdP trusted — not its attribute
 * *mapping*. A directory that maps a DN, a photo or a group blob onto `mail` or
 * `givenName` sends kilobytes into the same INSERT, and nothing measured them.
 */
describe('extractIdentity bounds', () => {
  it('reads an ordinary assertion unchanged', () => {
    expect(extractIdentity({ email: 'Ada@Example.com', firstName: 'Ada', lastName: 'Lovelace' })).toEqual({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('treats an over-long mail claim as no email, so the ACS answers 401', () => {
    // routes/saml.ts turns a null email into `problems.unauthorized('SAML
    // assertion has no email')`, which is the truth: nothing here can be signed
    // in as. Letting it through provisioned an account whose login identity
    // could not receive its own password reset.
    expect(extractIdentity({ mail: `${'a'.repeat(4000)}@corp.com` }).email).toBeNull();
  });

  it('treats a claim that is not an address as no email', () => {
    expect(extractIdentity({ mail: 'CN=Ada,OU=Eng,DC=corp,DC=com' }).email).toBeNull();
  });

  it('drops an over-long display name but still signs the user in', () => {
    // The name is cosmetic and the account is identified by its address, so
    // refusing here would lock a whole org out of SSO over one bad attribute
    // mapping — and half a name presented as whole is worse than none.
    const identity = extractIdentity({
      email: 'ada@corp.com',
      givenName: 'a'.repeat(101),
      surname: 'Lovelace',
    });
    expect(identity.email).toBe('ada@corp.com');
    expect(identity.firstName).toBeNull();
    expect(identity.lastName).toBe('Lovelace');
  });

  it('keeps a name exactly at the bound', () => {
    expect(extractIdentity({ email: 'a@b.com', givenName: 'a'.repeat(100) }).firstName).toHaveLength(100);
  });
});

/** The shape the route schemas share, asserted against the schema they all use. */
describe('the schemas that consume it', () => {
  it('is the same object everywhere, so one bound moves them all', () => {
    const body = z.object({ email: EmailAddress });
    expect(body.safeParse({ email: `${'a'.repeat(400)}@corp.com` }).success).toBe(false);
    expect(body.safeParse({ email: 'ada@corp.com' }).success).toBe(true);
  });
});
