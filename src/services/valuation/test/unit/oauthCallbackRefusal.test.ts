import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  integrationCallbackRefusal,
  type IntegrationCallbackKind,
} from '../../src/domain/oauthCallbackRefusal.js';

/**
 * The three integration callbacks are the only routes on this platform that a
 * browser navigates to and that can answer with a problem body — every other
 * failure in those handlers redirects back into the app with a result code.
 * So this string is not read by an integration; it is read by a person, in
 * their browser's JSON view, immediately after pressing Allow on a provider's
 * consent screen, with no way back into the product.
 *
 * It said `Invalid or expired state`.
 */
const KINDS: IntegrationCallbackKind[] = ['accounting', 'hris', 'capTable'];

describe('the sentence a stranded OAuth redirect shows', () => {
  it.each(KINDS)('names no OAuth vocabulary for %s', (kind) => {
    const detail = integrationCallbackRefusal(kind);
    // "state" is the parameter's name, not a fact about the reader's
    // situation, and it is the word the message used to be built out of.
    expect(detail).not.toMatch(/\bstate\b/i);
    expect(detail).not.toMatch(/\bOAuth\b/i);
    expect(detail).not.toMatch(/\bJWT\b|\btoken\b/i);
  });

  it.each(KINDS)('says nothing was connected for %s', (kind) => {
    // The token exchange sits below both checks and never ran. Somebody who
    // has just granted a third party access to their ledger wants that fact
    // more than any other, and it was the one the message withheld.
    expect(integrationCallbackRefusal(kind)).toMatch(/nothing has been connected/i);
    expect(integrationCallbackRefusal(kind)).toMatch(/no access was granted/i);
  });

  it.each(KINDS)('names the likely cause and the way to restart for %s', (kind) => {
    const detail = integrationCallbackRefusal(kind);
    expect(detail).toMatch(/30 minutes/); // the signed state's actual expiry
    expect(detail).toMatch(/browser history/i);
    expect(detail).toMatch(/press Connect again/i);
  });

  it('sends each integration back to its own tab', () => {
    // Which is the whole reason this is a function of the kind: "go back and
    // press Connect" is useless without saying where Connect is.
    expect(integrationCallbackRefusal('accounting')).toContain('Documents tab');
    expect(integrationCallbackRefusal('hris')).toContain('Grants tab');
    // "Cap Table", capital T: the tab is labelled that, and a remedy is read
    // by searching the screen for the words in it (see remedyControlLabels).
    expect(integrationCallbackRefusal('capTable')).toContain('Cap Table tab');
    expect(new Set(KINDS.map(integrationCallbackRefusal)).size).toBe(3);
  });

  it('gives the missing marker and the unverifiable one the same words', () => {
    /*
     * The statuses stay apart — 400 and 422 mean different things to an
     * integration — but the prose does not. For a person, "the provider sent
     * us back without the marker" and "the marker no longer verifies" are one
     * situation with one fix, and two strings would be an invitation for one
     * of them to be written carelessly.
     *
     * Asserted over the source rather than over a return value, because the
     * property is about the two *call sites*, and a helper compared with
     * itself would pass whatever the routes did.
     */
    const routes: Array<[string, string]> = [
      ['accounting.ts', 'accounting'],
      ['hris.ts', 'hris'],
      ['capTableSync.ts', 'capTable'],
    ];
    for (const [file, kind] of routes) {
      const text = readFileSync(new URL(`../../src/routes/${file}`, import.meta.url), 'utf8');
      const calls = [...text.matchAll(/integrationCallbackRefusal\('([a-zA-Z]+)'\)/g)].map((m) => m[1]);
      expect(calls, `${file} refuses both ways with the same sentence`).toEqual([kind, kind]);
      // And neither of the strings this replaced is left anywhere in the route.
      expect(text).not.toContain("'Missing state'");
      expect(text).not.toContain("'Invalid or expired state'");
    }
  });
});
