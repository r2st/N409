// The method chip on the partner API reference.
//
// TWO FAILURES MEET HERE, one round apart.
//
// R88 found the first: `EndpointDoc.method` was typed `'GET' | 'POST'` while the
// route registry had been serving three DELETE endpoints for some time, so
// "revoke this webhook" rendered in the same green as "create a valuation" and
// TypeScript could not object — the type was a claim about the server rather
// than a reading of it. Widening it to four verbs fixed the type; nothing
// pinned the consequence, which is that a reader scanning for the call that
// removes their data can tell it apart at a glance.
//
// The fix shipped the second. The new DELETE tone was written in a palette
// family the dark block has never re-pointed, so its lightest step stayed
// near-white under a dark theme: a glaring chip on a dark table, on the one verb
// where being misread costs the most. `themeTokens.test.ts` caught it in a
// repo-wide scan — but only after the change was already deployed, because that
// round did not finish a suite run.
//
// So these assert the two properties at the point where they mean something,
// rather than leaving both to a scanner that speaks in palette steps: four verbs
// look like four different things, and every one of them survives the theme.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiReference } from '../src/components/ApiReference';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The palette steps the dark block re-points, read from the stylesheet.
 *
 * Read rather than listed: a hardcoded copy is a second thing to keep in step
 * with `index.css`, and the whole bug being pinned here is two files that
 * disagreed about a colour.
 */
function darkModeSteps(): Set<string> {
  const css = readFileSync(path.join(here, '../src/index.css'), 'utf8');
  const dark = css.slice(css.indexOf(":root[data-theme='dark']"));
  return new Set([...dark.matchAll(/--color-([a-z]+-\d{2,3})\s*:/g)].map((m) => m[1]));
}

const VERBS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

const docs = {
  name: 'Partner API',
  version: 'v1',
  base_url: 'https://n409.aiknol.com/api/partner/v1',
  authentication: { scheme: 'Bearer', header: 'Authorization', note: 'Use your API key.' },
  rate_limit: { limit: 120, window_seconds: 60, headers: ['x-ratelimit-limit'] },
  endpoints: VERBS.map((method) => ({
    method,
    path: `/things/${method.toLowerCase()}`,
    summary: `A ${method} endpoint.`,
    auth: 'api_key' as const,
    response: '200 { thing }',
  })),
};

function mountWithDocs() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(docs), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  render(<ApiReference />);
}

/** The chip element for one verb, found by its text. */
const chip = (verb: string) => screen.getByText(verb);

afterEach(() => vi.restoreAllMocks());

describe('the verb chip', () => {
  it('renders every method the registry can serve', async () => {
    mountWithDocs();
    for (const verb of VERBS) expect(await screen.findByText(verb)).toBeInTheDocument();
  });

  // The R88 failure stated directly. Four verbs are four different promises
  // about what happens to the resource, and a reader scanning the table sorts
  // them by colour before they read a word of the summary.
  it('gives each of the four verbs a tone of its own', async () => {
    mountWithDocs();
    await screen.findByText('DELETE');
    const tones = VERBS.map((v) => chip(v).className);
    expect(new Set(tones).size).toBe(VERBS.length);
  });

  // Specifically the pair that used to be identical: DELETE inherited POST's
  // green through the `?? METHOD_TONES.POST` fallback, because the type did not
  // admit the verb existed.
  it('does not paint DELETE the way it paints POST', async () => {
    mountWithDocs();
    await screen.findByText('DELETE');
    expect(chip('DELETE').className).not.toBe(chip('POST').className);
  });

  // The R89 failure. Dark mode here is one block of re-pointed palette steps,
  // not a set of `dark:` variants, so a family the block does not carry keeps
  // its light value under a dark theme.
  it('paints every verb in a family the dark theme re-points', async () => {
    mountWithDocs();
    await screen.findByText('DELETE');
    const dark = darkModeSteps();
    const escapes: string[] = [];
    for (const verb of VERBS) {
      for (const [, step] of chip(verb).className.matchAll(/\b(?:bg|text)-([a-z]+-\d{2,3})\b/g)) {
        if (!dark.has(step)) escapes.push(`${verb}: ${step}`);
      }
    }
    expect(escapes).toEqual([]);
  });

  // Guards the two above against passing on a chip that carries no colour at
  // all: an empty tone string is distinct from the others and trivially
  // survives every theme.
  it('is actually painting something', async () => {
    mountWithDocs();
    await screen.findByText('DELETE');
    const dark = darkModeSteps();
    expect(dark.size).toBeGreaterThan(20);
    for (const verb of VERBS) {
      const steps = [...chip(verb).className.matchAll(/\b(?:bg|text)-([a-z]+-\d{2,3})\b/g)];
      expect(steps.length).toBeGreaterThanOrEqual(2);
    }
  });

  // A verb the registry grows that this table has no tone for must still
  // render, rather than throwing an undefined class onto the page. It will look
  // like a POST until somebody gives it a colour — which is the old bug, so the
  // test above is what stops that being anyone's plan.
  it('falls back rather than breaking on a verb it has no tone for', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ...docs,
          endpoints: [
            { ...docs.endpoints[0], method: 'PATCH', path: '/things/patch', summary: 'A PATCH endpoint.' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    render(<ApiReference />);
    await waitFor(() => expect(screen.getByText('PATCH')).toBeInTheDocument());
    expect(screen.getByText('PATCH').className).toContain('bg-');
  });
});
