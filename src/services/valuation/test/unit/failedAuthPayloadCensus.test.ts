import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R273 (methodology M11) — a failed sign-in says where it came from.
 *
 * `loginAudit.test.ts` holds the three properties that make the failure half of
 * the spine worth keeping: every failing branch writes a row, the reason is
 * inside the row, and the throttle bounds how many an unauthenticated caller
 * can cause. What it does not hold is what else is on the row, and the fourth
 * door to be written — SAML's closed-account refusal, R272 — shipped without
 * `ip` while the three before it all carried one.
 *
 * That field is not decoration on this event. A failed sign-in is read to
 * answer "who has been trying, and from where"; every other identifying field
 * describes the *account*, which the reader already has, because it is how they
 * found the row. And there is no other record to fall back on: nothing
 * authenticated, so no principal reaches a log line, and the request that
 * carried the address ends in a refusal nobody retries.
 *
 * A census rather than four assertions, and over the source rather than over
 * the database, because the population is "every door onto this event" and the
 * failure mode is the fifth one being written the way the fourth was. The
 * integration tests need Postgres; this one is the part that has to be true on
 * every machine.
 */

const ROUTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes');

/** The event types that record an attempt that signed nobody in. */
const FAILED_AUTH_EVENTS = ['user_login_failed', 'user_mfa_challenge_failed'] as const;

/** Comments blanked, offsets preserved, so a type named in prose is not a call. */
function code(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/([^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(1)));
}

interface Site {
  file: string;
  line: number;
  type: string;
  payload: string;
}

/** Every `recordAdminEvent` whose `type` is one of the failed-auth events. */
function sites(): Site[] {
  const out: Site[] = [];
  for (const name of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const raw = readFileSync(path.join(ROUTES, name), 'utf8');
    const src = code(raw);
    for (const type of FAILED_AUTH_EVENTS) {
      for (const m of src.matchAll(new RegExp(`type:\\s*'${type}'`, 'g'))) {
        // The `payload:` of the same object literal. Bounded rather than
        // balanced: these payloads are flat, and a window that ran to the next
        // brace of any depth would swallow the following call.
        const after = src.slice(m.index!, m.index! + 600);
        const at = after.indexOf('payload:');
        const payload = at < 0 ? '' : after.slice(at, after.indexOf('}', at) + 1);
        out.push({ file: name, line: raw.slice(0, m.index!).split('\n').length, type, payload });
      }
    }
  }
  return out;
}

describe('a failed sign-in on the audit spine', () => {
  const found = sites();

  it('finds the doors at all — the vacuity guard', () => {
    // Four today: password, MFA, Google and SAML. A census that stopped
    // matching would pass over nothing, which is how this check would stop
    // being one.
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(new Set(found.map((s) => s.file)).size).toBeGreaterThanOrEqual(2);
  });

  it('names the address every attempt came from', () => {
    const anonymous = found
      .filter((s) => !/\bip:\s*req\.ip\b/.test(s.payload))
      .map((s) => `${s.file}:${s.line} ${s.type} payload ${s.payload.replace(/\s+/g, ' ')}`);
    expect(anonymous).toEqual([]);
  });

  it('says why, in a word an operator can group on', () => {
    // The other half of the same row, and the one `loginAudit.test.ts` already
    // covers behaviourally — stated here too so a new door cannot ship with an
    // address and no reason.
    const mute = found
      .filter((s) => s.type === 'user_login_failed')
      .filter((s) => !/\breason:/.test(s.payload))
      .map((s) => `${s.file}:${s.line} ${s.payload.replace(/\s+/g, ' ')}`);
    expect(mute).toEqual([]);
  });

  it('says which door, so three of them are not one number', () => {
    const unattributed = found
      .filter((s) => s.type === 'user_login_failed')
      .filter((s) => !/\bmethod:/.test(s.payload))
      .map((s) => `${s.file}:${s.line} ${s.payload.replace(/\s+/g, ' ')}`);
    expect(unattributed).toEqual([]);
  });
});
