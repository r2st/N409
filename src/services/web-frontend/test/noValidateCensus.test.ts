import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `noValidate` turns the browser's own checking off. Something has to take it
 * over.
 *
 * The attribute is on nearly every form here, and correctly: the native
 * bubbles cannot be styled, appear one at a time, and vanish on the next
 * keystroke. What they do have is the property that `required`, `type=email`,
 * `pattern`, `min`, `max` and `step` on a control *mean* something. Turning
 * them off without putting a validator behind them leaves those attributes as
 * rules that read as enforced and are not, and leaves the round trip as the
 * first thing that checks — which answers "which of these boxes" with a single
 * message above the form, if the endpoint says anything useful at all.
 *
 * `BrandingPage` was the last one in that state. This is what stops the next.
 *
 * The scan is per file rather than per `<form>`: a file holding two forms, one
 * validated and one not, passes here. Making it exact means matching a `<form>`
 * element to the identifier its `onSubmit` was bound from, which is a parser,
 * and the coarse version already covers the case that actually occurs — a page
 * whose forms were all written the same way.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

const turnsOffTheBrowser = FILES.filter(({ text }) => /\bnoValidate\b/.test(text));

describe('a form that turns off the browser checks it anyway', () => {
  it('is looking at a source tree with forms in it', () => {
    // The vacuity guard. Both assertions below are satisfied by a scan that
    // found no files at all, which is what a moved `src/` or a renamed
    // extension would produce.
    expect(FILES.length).toBeGreaterThan(50);
    expect(turnsOffTheBrowser.length).toBeGreaterThan(20);
  });

  it('has a validator behind every noValidate', () => {
    const unguarded = turnsOffTheBrowser
      .filter(({ text }) => !/useFormValidation/.test(text))
      .map(({ file }) => file);
    expect(unguarded).toEqual([]);
  });
});
