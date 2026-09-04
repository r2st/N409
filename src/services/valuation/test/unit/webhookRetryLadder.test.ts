import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_ATTEMPTS_CEILING,
  WEBHOOK_RETRY_BACKOFF_MINUTES,
  retryDelayMinutes,
} from '../../src/domain/partnerWebhooks.js';

/**
 * One retry ceiling, stated in three layers (R413, methodology M6).
 *
 * `WEBHOOK_MAX_ATTEMPTS` is derived from the backoff ladder and written into
 * `partner_webhook_deliveries.max_attempts` on every insert. The column states
 * the same number twice more — as its DEFAULT, which is what a row inserted
 * without one inherits, and as a CHECK that caps it at 10. Nothing linked the
 * three, so extending the ladder could:
 *
 *   * push the constant past the CHECK, and every enqueue then fails with a
 *     `23514` from the driver — post-commit, on the announcement path, where a
 *     failure is a partner event nobody knows was lost; or
 *   * leave the DEFAULT behind, so the new steps exist in the code and are
 *     unreachable for every new delivery. `retryDelayMinutes` stops at the
 *     *row's* max_attempts, not at the constant.
 *
 * Migration 0139 is the near miss: it had to raise the default by hand and
 * check the CHECK in a comment. These assertions ask the schema directly.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../migrations');

/** Every migration body, oldest first — the order Postgres applied them in. */
function migrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS, name), 'utf8') }));
}

describe('webhook retry ladder', () => {
  it('fits under the CHECK the delivery table states', () => {
    let ceiling: number | null = null;
    for (const { sql } of migrations()) {
      const m = /max_attempts\s+BETWEEN\s+\d+\s+AND\s+(\d+)/i.exec(sql);
      if (m) ceiling = Number(m[1]);
    }
    expect(ceiling, 'no migration states a max_attempts CHECK any more').not.toBeNull();
    expect(ceiling).toBe(WEBHOOK_MAX_ATTEMPTS_CEILING);
    expect(WEBHOOK_MAX_ATTEMPTS).toBeLessThanOrEqual(WEBHOOK_MAX_ATTEMPTS_CEILING);
  });

  it('is the default a delivery inserted without one inherits', () => {
    // Last writer wins: 0103 created the column with DEFAULT 4 and 0139 raised
    // it to 6 when the ladder grew.
    let dflt: number | null = null;
    for (const { sql } of migrations()) {
      for (const m of sql.matchAll(
        /max_attempts\s+integer\s+NOT NULL\s+DEFAULT\s+(\d+)|ALTER COLUMN max_attempts SET DEFAULT\s+(\d+)/gi,
      )) {
        dflt = Number(m[1] ?? m[2]);
      }
    }
    expect(dflt, 'no migration sets a max_attempts default any more').not.toBeNull();
    expect(dflt).toBe(WEBHOOK_MAX_ATTEMPTS);
  });

  it('has a step for every attempt the ceiling allows', () => {
    // The ladder and the constant are the same statement read two ways; this is
    // the one that fails if somebody sets the constant by hand.
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(WEBHOOK_RETRY_BACKOFF_MINUTES.length + 1);
    for (let made = 1; made < WEBHOOK_MAX_ATTEMPTS; made += 1) {
      expect(retryDelayMinutes(made)).toBe(WEBHOOK_RETRY_BACKOFF_MINUTES[made - 1]);
    }
    expect(retryDelayMinutes(WEBHOOK_MAX_ATTEMPTS)).toBeNull();
  });

  it('holds a row whose ceiling was raised by hand at the longest step', () => {
    // The column exists so one troublesome endpoint can be given more attempts.
    // Falling through to null there would make a raised ceiling do nothing.
    const longest = WEBHOOK_RETRY_BACKOFF_MINUTES.at(-1);
    expect(retryDelayMinutes(WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_ATTEMPTS_CEILING)).toBe(longest);
    expect(retryDelayMinutes(WEBHOOK_MAX_ATTEMPTS_CEILING, WEBHOOK_MAX_ATTEMPTS_CEILING)).toBeNull();
  });
});
