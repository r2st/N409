import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  ACCOUNT_SCOPED_KEYS,
  DEVICE_SCOPED_KEYS,
  clearAccountScopedStorage,
} from '../src/lib/accountStorage';

/**
 * What this browser keeps about the account that just signed out.
 *
 * Sign-out removed `n409.token` and nothing else, so on a shared machine the
 * next person to open New valuation found the previous account's client already
 * typed into "Company legal name" (`n409.company_hint`, written at registration
 * and removed only when an engagement is created), and the onboarding wizard
 * would resume their draft — engagement id, legal name, uploaded file names —
 * because sessionStorage outlives a sign-out in the same tab.
 *
 * The census is the half that keeps working: a key added next cycle is
 * classified as account- or device-scoped by whoever adds it, rather than
 * defaulting to "kept" the way these did.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...sources(abs));
    else if (/\.tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

/**
 * Every key the app reads or writes through a browser storage, resolved at its
 * call site.
 *
 * Scanning for `n409`-shaped string literals instead would sweep in script
 * element ids, download filenames and the brand stylesheet's id — names that
 * share the prefix and are not storage at all. So the call is what is matched,
 * and its argument is resolved: a literal, a `const` holding one, or a template

 * whose constant head names a family (`n409.nav.${label}`). An argument that
 * resolves to none of those is reported rather than skipped — a key this cannot
 * see is a key nothing classifies.
 *
 * The `const` map is built across the whole tree rather than per file, because
 * a key is exported and used elsewhere (`COMPANY_HINT_KEY` is declared on the
 * registration page and read by the new-valuation page) — which is also the
 * shape a key that outlives one screen tends to have.
 */
function storageKeys(): { keys: Map<string, string>; unresolved: string[] } {
  const keys = new Map<string, string>();
  const unresolved: string[] = [];
  const files = sources(SRC).filter((f) => !f.endsWith(path.join('lib', 'accountStorage.ts')));

  const consts = new Map<string, string>();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(
      /const\s+([A-Za-z0-9_]+)\s*=\s*['"`](n409[-.][A-Za-z0-9_.-]*)/g,
    )) {
      consts.set(m[1]!, m[2]!);
    }
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(SRC, file);
    for (const m of text.matchAll(/\.(?:get|set|remove)Item\(\s*([^,)]+)/g)) {
      const arg = m[1]!.trim();
      const literal = /^['"`]/.test(arg) ? arg.slice(1).replace(/['"`]$/, '') : consts.get(arg);
      if (literal === undefined || !/^n409[-.]/.test(literal)) {
        unresolved.push(`${arg} (${rel})`);
        continue;
      }
      // A template contributes its constant head, which is what a prefix entry
      // in DEVICE_SCOPED_KEYS declares.
      keys.set(literal.split('${')[0]!, rel);
    }
  }
  return { keys, unresolved };
}

const declaredAccount = new Set(ACCOUNT_SCOPED_KEYS);
const declaredDevice = DEVICE_SCOPED_KEYS.map((d) => d.key);

/** A literal is covered by an exact device key or by a declared prefix. */
const deviceCovers = (key: string): boolean =>
  declaredDevice.some((d) => (d.endsWith('.') ? key.startsWith(d) : d === key));

describe('browser storage inventory', () => {
  it('classifies every key the app writes as account- or device-scoped', () => {
    const { keys, unresolved } = storageKeys();
    const unclassified = [...keys]
      .filter(([key]) => !declaredAccount.has(key) && !deviceCovers(key))
      .map(([key, file]) => `${key} (${file})`);
    expect(unclassified).toEqual([]);
    // A key the scan could not resolve is a key nobody classified either.
    expect(unresolved).toEqual([]);
  });

  it('classifies each key exactly once', () => {
    const both = ACCOUNT_SCOPED_KEYS.filter((k) => deviceCovers(k));
    expect(both).toEqual([]);
    expect(new Set(ACCOUNT_SCOPED_KEYS).size).toBe(ACCOUNT_SCOPED_KEYS.length);
  });

  it('gives every kept key a reason', () => {
    for (const entry of DEVICE_SCOPED_KEYS) {
      expect(entry.why.length, entry.key).toBeGreaterThan(30);
    }
  });

  // The lists are only worth having if they name the keys that were actually
  // leaking, so those are pinned by name rather than left to the census.
  it('treats the client-bearing keys as the account’s', () => {
    for (const key of ['n409.company_hint', 'n409.onboarding.draft']) {
      expect(ACCOUNT_SCOPED_KEYS).toContain(key);
    }
  });
});

describe('clearAccountScopedStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('removes account-scoped keys from both storages', () => {
    for (const key of ACCOUNT_SCOPED_KEYS) {
      localStorage.setItem(key, 'x');
      sessionStorage.setItem(key, 'x');
    }
    clearAccountScopedStorage();
    for (const key of ACCOUNT_SCOPED_KEYS) {
      expect(localStorage.getItem(key), key).toBeNull();
      expect(sessionStorage.getItem(key), key).toBeNull();
    }
  });

  it('leaves the browser’s own preferences alone', () => {
    localStorage.setItem('n409.theme', 'dark');
    localStorage.setItem('n409.nav.admin', 'closed');
    localStorage.setItem('n409-cookie-consent', 'accepted');
    clearAccountScopedStorage();
    expect(localStorage.getItem('n409.theme')).toBe('dark');
    expect(localStorage.getItem('n409.nav.admin')).toBe('closed');
    expect(localStorage.getItem('n409-cookie-consent')).toBe('accepted');
  });
});
