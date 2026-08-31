import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * An announcement that was lost is logged as lost, not as delayed.
 *
 * The shape this guards is the estate's commonest deliberate swallow. Work
 * commits, and the thing that tells somebody about it runs afterwards, outside
 * the transaction, wrapped in a `try` — because reporting a failed notification
 * as a 5xx would tell the caller their comment, payment or filing had failed
 * when it had not, and the obvious response to that is to send it again. On a
 * Stripe webhook it is worse than obvious: the handler answers 2xx, so a throw
 * earns a redelivery that re-applies the half that already worked.
 *
 * The swallow is right. The level it was logged at was not. `warn` in this
 * codebase carries a promise written down in `shared/failure.ts`: a transient
 * failure is `warn` *because the retry is going to handle it*. Nothing retries
 * these. No sweep revisits a dropped notification row, the webhook has been
 * answered, and the announcement is gone whatever kind of error lost it — a
 * busy pool classifies transient and the receipt is just as unsent as if the
 * template had been deleted. The transience of the cause says nothing about the
 * durability of the consequence, and the consequence is the thing an operator
 * is being asked to act on: somebody who should have been told was not.
 *
 * So `logUnretried` (error, `alert: true`, `retried: false`) is the level here,
 * and this census is what keeps the next one from reaching for `warn` again.
 *
 * ## Why the population is derived from the writers
 *
 * A list of "announcement sites" is a list somebody has to remember to add to.
 * The question is asked of the code instead: a `try` block that calls one of
 * the three functions that actually tell a person something — the notification
 * writer and the two transactional-email doors — and whose `catch` does not
 * rethrow, is an announcement that can be lost. That is the whole population,
 * and it grows on its own.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.resolve(HERE, '../..');

/**
 * The doors through which a person is told something.
 *
 * `createNotification`/`createNotifications` write the in-app inbox;
 * `sendTransactionalEmail` and its background twin are the only two ways an
 * email leaves this service outside the outbox sweep. A subsystem that grows a
 * fourth door adds it here, which is the one judgement this file states.
 *
 * THE FOURTH DOOR (round 273, methodology M11). A partner integration is told
 * things too, and `firePartnerWebhooks` and its two batch entry points are the
 * whole of how. It is the same shape as the three above and it fails the same
 * way: the fan-out runs after the transition or the retirement has committed,
 * a failure before `recordDelivery` leaves no delivery row, and the retry sweep
 * works from delivery rows — so there is nothing to revisit and the partner is
 * simply not told. The census did not know about it, and the one caller that
 * did wrap it logged the loss at `warn`.
 *
 * `deliverToWebhook` is deliberately not here: it is one hop below these, its
 * failure *does* leave a row, and `partnerApi.ts` calls it for a test ping
 * whose whole purpose is to report the outcome to the caller.
 */
const ANNOUNCERS =
  /\b(createNotifications?|sendTransactionalEmail(?:InBackground)?|notifyCommentPosted|firePartnerWebhooks(?:ForTransition|ForRetirement)?)\s*\(/;

/**
 * The whole service tree, not the two directories where these happen to live
 * today. Routes and hooks hold every announcement site at the moment; scoping
 * the scan to them would mean the first one written under `src/pipeline` is
 * invisible to a census that keeps reporting a clean sweep. Scanning `src`
 * costs nothing — a file with no `try` around an announcer contributes no
 * pairs.
 */
const ROOTS = ['src'];

/**
 * A catch that says, in the code, why losing this one silently is correct.
 *
 * Written as a comment rather than a list here so the reason sits beside the
 * code it excuses, and moves or dies with it.
 */
const EXEMPTION = /\/\/\s*announcement-loss:/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface TryCatch {
  tryBody: string;
  catchBody: string;
  line: number;
}

/**
 * Every `try { … } catch (…) { … }` in a file, with the bodies.
 *
 * Deliberately naive about strings and comments containing braces: a false
 * pair would surface as a failure with a nonsense body rather than as silence,
 * which is the direction a census should err in. The vacuity guard below is
 * what catches the opposite — a parser that has quietly stopped finding
 * anything.
 */
function tryCatches(src: string): TryCatch[] {
  const out: TryCatch[] = [];
  const re = /\btry\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    const close = matchBrace(src, open);
    if (close === -1) continue;
    const after = src.slice(close + 1);
    const catchMatch = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(after);
    if (!catchMatch) continue;
    const catchOpen = close + 1 + catchMatch[0].lastIndexOf('{');
    const catchClose = matchBrace(src, catchOpen);
    if (catchClose === -1) continue;
    out.push({
      tryBody: src.slice(open + 1, close),
      catchBody: src.slice(catchOpen + 1, catchClose),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/** `body` with any nested `try { … } catch { … }` removed. */
function withoutNested(body: string): string {
  let out = body;
  for (const nested of tryCatches(body)) {
    out = out.replace(nested.tryBody, ' ').replace(nested.catchBody, ' ');
  }
  return out;
}

describe('announcement loss is logged as loss', () => {
  const files = ROOTS.flatMap((root) => tsFiles(path.join(SERVICE, root)));

  it('finds the files and the try/catch pairs, so an empty scan cannot pass', () => {
    expect(files.length).toBeGreaterThan(100);
    const pairs = files.reduce((n, f) => n + tryCatches(readFileSync(f, 'utf8')).length, 0);
    expect(pairs).toBeGreaterThan(60);
  });

  it('finds announcement sites, so a broken ANNOUNCERS pattern cannot pass', () => {
    const sites = files.flatMap((file) =>
      tryCatches(readFileSync(file, 'utf8')).filter((tc) => ANNOUNCERS.test(withoutNested(tc.tryBody))),
    );
    expect(sites.length).toBeGreaterThan(8);
  });

  it('swallows an announcement failure only through logUnretried', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const tc of tryCatches(src)) {
        if (!ANNOUNCERS.test(withoutNested(tc.tryBody))) continue;
        // A catch that rethrows has not swallowed anything; the caller still
        // hears about it and this file has no opinion on what it does next.
        if (/\bthrow\b/.test(tc.catchBody)) continue;
        if (EXEMPTION.test(tc.catchBody)) continue;
        if (/\blogUnretried\s*\(/.test(tc.catchBody)) continue;
        offenders.push(`${path.relative(SERVICE, file)}:${tc.line}`);
      }
    }
    expect(offenders, 'announcement failures swallowed without logUnretried').toEqual([]);
  });
});
