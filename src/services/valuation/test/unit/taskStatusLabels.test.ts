import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REVIEW_TASK_STATUSES, TASK_STATUS_LABELS } from '../../src/domain/pipeline.js';

/**
 * The words an operator is shown for a review-task status, on both sides of the
 * wire.
 *
 * R264 gave the tasks board a conflict refusal — "This task moved to …" — and a
 * refusal has to name the status the way the screen the reader is looking at
 * names it. `in_progress` is a column value; the board says "In progress". That
 * is round 255's finding and round 262's, and the way it stays fixed here is
 * the way it stayed fixed there: web-frontend has no `@n409/shared` dependency,
 * so its `TASK_STATUS_LABELS` and the service's are two copies of one fact, and
 * a copy nothing compares is a copy that drifts.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER = path.resolve(HERE, '../../../web-frontend/src/lib/pipeline.ts');

/** The browser's `TASK_STATUS_LABELS` object literal, read as text. */
function browserLabels(): Record<string, string> {
  const source = readFileSync(BROWSER, 'utf8');
  const start = source.indexOf('export const TASK_STATUS_LABELS');
  expect(start, 'TASK_STATUS_LABELS in web-frontend/src/lib/pipeline.ts').toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  const close = source.indexOf('};', open);
  const out: Record<string, string> = {};
  for (const m of source.slice(open + 1, close).matchAll(/(\w+):\s*'((?:[^\\']|\\.)*)'/g)) out[m[1]!] = m[2]!;
  return out;
}

describe('review task status labels', () => {
  it('covers every status, by type rather than by list', () => {
    // `Record<ReviewTaskStatus, string>` is the real guard — a sixth status will
    // not compile until it is named. This checks the census has a population.
    expect(Object.keys(TASK_STATUS_LABELS).sort()).toEqual([...REVIEW_TASK_STATUSES].sort());
  });

  it('says the same thing as the browser', () => {
    const browser = browserLabels();
    expect(Object.keys(browser).length).toBe(REVIEW_TASK_STATUSES.length);
    for (const status of REVIEW_TASK_STATUSES) {
      expect(TASK_STATUS_LABELS[status], `label for ${status}`).toBe(browser[status]);
    }
  });

  it('never answers a reader with the column value', () => {
    for (const status of REVIEW_TASK_STATUSES) {
      expect(TASK_STATUS_LABELS[status], `label for ${status}`).not.toBe(status);
    }
  });
});
