import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IntegrationError, providerRefused } from '../../src/clients/deadline.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * A provider that answered "not now" reported as a provider that is broken.
 *
 * `providerRefused` exists because one status out of all of them deserves its
 * own sentence: a 429 is not a failure, it is the provider naming a time to
 * come back, usually in a `Retry-After` header nobody read. Told
 * "Gusto roster fetch failed (429)", an analyst reads a broken integration and
 * does the one thing that makes it worse — presses Import now again,
 * immediately.
 *
 * The helper landed with the cap-table and accounting clients converted, and
 * the two HRIS refusal sites kept writing the status into a sentence
 * themselves. Nothing was wrong with either line; they were simply the two the
 * conversion missed, and nothing was watching for the third.
 *
 * So the rule is a scan rather than a habit. A new integration client is
 * exactly where this reappears — the shape
 *
 *     if (!res.ok) throw new IntegrationError(`${label} … failed (${res.status})`)
 *
 * is what everybody writes first, because it is what every one of these
 * clients used to say.
 *
 * Scoped to `clients/`, deliberately. `res.status` in a *route* is this
 * platform answering its own caller, and `deadline.ts` is where the sentence
 * this looks for is legitimately built.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The `src/` tree: this file sits at `src/services/valuation/test/unit`. */
const SRC = path.resolve(HERE, '../../../..');
const CLIENTS = 'services/valuation/src/clients';
/** Where `providerRefused` is defined, and so the one file allowed to build it. */
const HELPER = 'services/valuation/src/clients/deadline.ts';

/**
 * A thrown error whose message ends in a bare HTTP status — the spelling that
 * loses the 429. Matched on `res.status` inside a thrown template literal
 * rather than on the whole sentence, because the wording varies per client
 * ("token exchange failed", "roster fetch failed", "cap-table fetch failed")
 * and the status interpolation is the part that does not.
 */
const RAW_STATUS_THROW = /throw new (?:Integration)?Error\([^)]*\$\{[^}]*res\.status[^}]*\}/;

const isProse = (line: string): boolean => /^(\/\/|\/\*|\*)/.test(line.trim());

interface Hit {
  file: string;
  line: number;
  text: string;
}

function rawStatusRefusals(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(path.join(SRC, CLIENTS))) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel === HELPER) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (isProse(line)) return;
        if (RAW_STATUS_THROW.test(line)) hits.push({ file: rel, line: i + 1, text: line.trim() });
      });
  }
  return hits;
}

describe('an outbound refusal reported to the person who asked', () => {
  it('scans the tree it claims to', () => {
    expect(existsSync(path.join(SRC, CLIENTS))).toBe(true);
    expect(existsSync(path.join(SRC, HELPER))).toBe(true);
    // The scan is worth nothing if it walks an empty file list.
    expect(sourceFiles(path.join(SRC, CLIENTS)).length).toBeGreaterThan(5);
  });

  it('builds every provider refusal through the shared helper', () => {
    expect(rawStatusRefusals()).toEqual([]);
  });

  it('recognises the spelling it exists to stop', () => {
    // The vacuity guard: the assertion above passes for a pattern that has
    // stopped matching anything at all.
    for (const form of [
      'throw new IntegrationError(`${label} roster fetch failed (${res.status})`);',
      'if (!res.ok) throw new Error(`${PROVIDER_LABELS[p]} import failed (${res.status})`);',
      'throw new IntegrationError(`Carta said ${res.status}`);',
    ]) {
      expect(RAW_STATUS_THROW.test(form), form).toBe(true);
    }
  });

  it('leaves the shared helper and its callers alone', () => {
    for (const form of [
      "throw providerRefused(label, 'token refresh', res);",
      "if (!res.ok) throw providerRefused(HRIS_PROVIDER_LABELS[provider], 'roster fetch', res);",
      'throw new IntegrationError(`${label} returned no access token`);',
      'reply.status(res.status).send(body);',
    ]) {
      expect(RAW_STATUS_THROW.test(form), form).toBe(false);
    }
  });

  it('names the wait when the provider named one', () => {
    // The behavioural half — what the scan is protecting.
    const headers = new Headers({ 'retry-after': '45' });
    const rateLimited = providerRefused('Gusto', 'roster fetch', { status: 429, headers });
    expect(rateLimited).toBeInstanceOf(IntegrationError);
    expect(rateLimited.message).toMatch(/rate-limiting us/i);
    expect(rateLimited.message).toMatch(/45s/);
    expect(rateLimited.message).not.toMatch(/429/);

    const broken = providerRefused('Gusto', 'roster fetch', { status: 503, headers: new Headers() });
    expect(broken.message).toBe('Gusto roster fetch failed (503)');
  });
});
