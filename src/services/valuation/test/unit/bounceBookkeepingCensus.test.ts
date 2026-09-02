import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A bounce that could not be recorded is a bounce nothing will record.
 *
 * `recordSendFailure` is the write that takes a hard-rejected address out of
 * future sends (migration 0163). Every caller contains its failure on purpose:
 * these all sit in a `catch` that is already reporting the send failure it
 * caught, and letting a bookkeeping rejection out would strand the rest of a
 * claim of up to five hundred messages, or turn a delivered request into a
 * 500.
 *
 * What the containment must not do is make the loss read like the ordinary
 * absence. The handler returns `null`, which is also what "the provider did not
 * reject the recipient" returns, and the failure line beside it prints both as
 * `bounce: null`. So the consequence — the address stays unsuppressed and the
 * ladder keeps sending to a mailbox that has hard-rejected us — has exactly one
 * witness: the level this handler logs at.
 *
 * R267 found the shape and fixed the two sweeps. R352 found the other two still
 * at `warn`, and they are the doors that send the most: every transactional
 * email goes through `transactional.ts`, and every failed one comes back
 * through `emailRetry.ts`. `warn` in this codebase promises a retry; nothing
 * revisits this write, on any of the four paths.
 *
 * Derived from the source rather than listed, so a fifth caller is in the
 * population the day it is written. Same idiom as `announcementLossCensus`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? tsFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** The balanced `(` argument text starting at `open`. */
function argumentOf(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open);
}

interface Site {
  file: string;
  line: number;
  handler: string;
}

/** Every `recordSendFailure(…).catch(<handler>)` in the service. */
function sites(): Site[] {
  const found: Site[] = [];
  for (const file of tsFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (let i = src.indexOf('recordSendFailure('); i >= 0; i = src.indexOf('recordSendFailure(', i + 1)) {
      const call = i + 'recordSendFailure'.length;
      const after = src.slice(call + argumentOf(src, call).length + 2);
      const chained = /^\s*\.catch\(/.exec(after);
      if (!chained) continue;
      const open = call + argumentOf(src, call).length + 2 + chained[0].lastIndexOf('(');
      found.push({
        file: path.relative(SRC, file),
        line: src.slice(0, i).split('\n').length,
        handler: argumentOf(src, open),
      });
    }
  }
  return found;
}

describe('a bounce that could not be recorded (R352)', () => {
  const found = sites();

  it('finds every caller, so an empty scan cannot pass', () => {
    // `autoEmails`, `stateChange`, `emailRetry`, `transactional`.
    expect(new Set(found.map((s) => s.file)).size).toBeGreaterThanOrEqual(4);
  });

  it('reports the loss at the level nothing coming back for it earns', () => {
    const offenders = found
      .filter((s) => !/\blogUnretried\s*\(/.test(s.handler))
      .map((s) => `${s.file}:${s.line}`);
    expect(
      offenders,
      'a contained recordSendFailure must log through logUnretried: the address stays ' +
        'unsuppressed, the ladder keeps sending, and nothing revisits this write.',
    ).toEqual([]);
  });

  it('says what was lost, not just that a write failed', () => {
    // The line an operator reads has to name the consequence: `could not record
    // bounce` is a fact about a query, and the fact about the estate is that a
    // hard-rejected address is still being mailed.
    for (const site of found) {
      expect(site.handler, `${site.file}:${site.line}`).toContain('suppress');
    }
  });
});
