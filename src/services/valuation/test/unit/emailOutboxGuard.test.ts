import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `markEmail` is the initial-send settlement path and must only write to a row
 * that is still 'queued'. Without the guard, a transport call that outlived the
 * retry claim lease could overwrite a row `settleClaimedEmail` had already
 * settled — putting a delivered message back on the retry ladder.
 *
 * `settleClaimedEmail` has its own `attempts` pin (R196); this is the matching
 * guard on the other door.
 */
describe('markEmail status guard', () => {
  it('guards the UPDATE on status = queued', () => {
    const src = readFileSync(join(here, '../../src/repos/emailOutbox.ts'), 'utf8');
    const markEmailFn = src.slice(src.indexOf('async function markEmail'));
    expect(markEmailFn, 'markEmail must guard on status = queued').toMatch(
      /WHERE.*status\s*=\s*'queued'/s,
    );
  });

  it('returns a boolean so callers know whether the settle landed', () => {
    const src = readFileSync(join(here, '../../src/repos/emailOutbox.ts'), 'utf8');
    const markEmailFn = src.slice(src.indexOf('async function markEmail'));
    const returnType = markEmailFn.match(/\):\s*Promise<(\w+)>/);
    expect(returnType?.[1], 'markEmail must return Promise<boolean>').toBe('boolean');
  });
});
