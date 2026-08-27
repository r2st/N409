import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every write that can move `state` is accounted for, and every one that does
 * is conditional on the row not having moved.
 *
 * The transition a route applies is *derived* from the state it read: `advance`
 * looks its target up in `AUTO_ADVANCE`, a review decision in `decisionTarget`,
 * the Stripe webhook asks whether the file is at `completed`. Judging that from
 * a reading another connection is free to invalidate is the bug this census
 * exists over, and it is not a narrow window: `findValuationById` caches a row
 * for five seconds and collapses concurrent lookups into one load, so two
 * requests arriving together genuinely share one read of the row.
 *
 * Two things went wrong there, both silently. Two holders of one read both
 * wrote the same move — the row landed where it should and the spine recorded
 * the transition twice, with `onStateChanged` emailing the client twice for one
 * move. And a holder whose read had been overtaken wrote its target over a row
 * further on, walking the workflow backwards and recording a `from` the row had
 * left two moves earlier.
 *
 * `expectedVersion` refuses both: `patchValuation` bumps `version` on every
 * write, so a row that moved fails the write instead of overwriting it. Until
 * R189 exactly one of the four state writers passed it, and it passed it behind
 * an opt-in flag the other three left off.
 *
 * The roster is the census, in the shape R90 settled on: this reads every
 * `patchValuation` call out of the source and fails on one it has never been
 * told about, so a new writer cannot ship without somebody deciding here
 * whether it can move the state. It proves nothing about behaviour —
 * `stateMachineDoors.test.ts` drives the doors — only that the list is complete.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../../src');

type Verdict =
  | { writesState: true; guard: string }
  | { writesState: false; because: string };

/**
 * Keyed by the file and the third argument — the fields being written — because
 * that is the part of a call that says what it does, and unlike a line number it
 * does not drift when the comment above it grows.
 */
const DECIDED: Record<string, Verdict> = {
  'domain/applyState.ts :: { state: to }': {
    writesState: true,
    // The shared door: workflow advance, workflow restart, every arm of the
    // bulk executor, and the partner API's submit walk.
    guard: 'expectedVersion: valuation.version, unconditionally, for every caller',
  },
  'routes/reviews.ts :: { state: target }': {
    writesState: true,
    // `target` comes out of `decisionTarget(valuation.state, decision)`, so the
    // read it was derived from is the thing that has to still be true.
    guard: 'expectedVersion: valuation.version',
  },
  'routes/valuations.ts :: parsed.data as Record<string, unknown>': {
    writesState: true,
    // `state` is in OPS_PATCH_FIELDS, so a PATCH body can carry it. `If-Match`
    // stays opt-in for an ordinary field save and cannot be for this: the
    // `state_changed` event records the caller's read as the `from` of the move.
    guard: "expectedVersion defaults to valuation.version whenever the body carries `state`",
  },
  'routes/workflow.ts :: { assigned_reviewer_id: reviewerId }': {
    writesState: false,
    because: 'reassignment writes one column the caller named; no state, no derived target',
  },
  'routes/workflow.ts :: { assigned_reviewer_id: reviewer_id }': {
    writesState: false,
    // Unguarded on purpose — see the comment at the call site. "Assign these two
    // hundred to Alice" is meant to overwrite a concurrent assignment.
    because: 'the bulk arm of the same reassignment',
  },
  'routes/partnerApi.ts :: fields': {
    writesState: false,
    because: 'company_name / service_name / currency / service_countries / external_id only',
  },
  "routes/payments.ts :: { paid_status: 'unpaid', paid_at: null }": {
    writesState: false,
    because: 'a refund or dispute clears the settlement fields; the lifecycle move is separate',
  },
  'routes/payments.ts :: settlement fields': {
    writesState: false,
    // It used to, as `...(advancing ? { state: 'paid' } : {})` off a read taken
    // before the write. The advance is now a second, guarded call through
    // `applyValuationState`, decided from the row the money write returned — and
    // it must stay separate, because a refused advance must not roll back a
    // settlement Stripe has already taken.
    because: 'money fields only; the completed → paid advance goes through applyValuationState',
  },
};

/** Every `.ts` under src, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });
}

/** The text between `patchValuation(` and its matching close paren. */
function callBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = 'patchValuation(';
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    // `export async function patchValuation(` is the definition, not a call.
    if (/[\w.]/.test(source[i - 1] ?? '')) continue;
    if (/function\s+$/.test(source.slice(Math.max(0, i - 20), i))) continue;
    let depth = 0;
    for (let j = i + marker.length - 1; j < source.length; j += 1) {
      const ch = source[j];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(i + marker.length, j));
          break;
        }
      }
    }
  }
  return bodies;
}

/**
 * Splits a call's arguments on commas that are not inside a nested construct.
 *
 * Type arguments count as nesting, or `Record<string, unknown>` splits in half
 * and the PATCH route's fields argument becomes two. The arrow in `(x) => y` is
 * the one other `>` these calls contain, so it is neutralised first rather than
 * counted as a close.
 */
function splitArgs(raw: string): string[] {
  const body = raw.replaceAll('=>', '==');
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if ('([{<'.includes(ch)) depth += 1;
    else if (')]}>'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  args.push(raw.slice(start));
  return args.map((a) => a.trim()).filter((a) => a.length > 0);
}

/** Comments carry prose about `state` and would make every call look like a writer. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

interface CallSite {
  key: string;
  fields: string;
  options: string;
}

const CALLS: CallSite[] = sourceFiles(SRC).flatMap((file) => {
  const rel = relative(SRC, file).replaceAll('\\', '/');
  return callBodies(readFileSync(file, 'utf8')).map((body) => {
    const args = splitArgs(withoutComments(body));
    const fields = (args[2] ?? '').replace(/\s+/g, ' ').trim();
    // The Stripe settlement patch is a long object literal; naming it by its
    // first field would make the key churn with every field added to it.
    const label = fields.startsWith("{ paid_status: 'paid'") ? 'settlement fields' : fields;
    return { key: `${rel} :: ${label}`, fields, options: (args[4] ?? '').replace(/\s+/g, ' ') };
  });
});

describe('every writer that can move a valuation state', () => {
  it('finds the call sites at all', () => {
    // A rename or a wrapper that hides `patchValuation(` would make every
    // assertion below vacuously true. Eight is the count as of R189.
    expect(CALLS.length).toBeGreaterThanOrEqual(8);
  });

  it('has a decision recorded for each one', () => {
    const undecided = CALLS.map((c) => c.key).filter((k) => !(k in DECIDED));
    expect(undecided, 'new patchValuation call — decide whether it can write `state`').toEqual([]);
  });

  it('has no decision left over for a call site that is gone', () => {
    const found = new Set(CALLS.map((c) => c.key));
    expect(Object.keys(DECIDED).filter((k) => !found.has(k))).toEqual([]);
  });

  it('guards every one that writes state against the row having moved', () => {
    for (const call of CALLS) {
      const verdict = DECIDED[call.key]!;
      if (!verdict.writesState) continue;
      expect(call.options, `${call.key} writes state without a version guard`).toContain(
        'expectedVersion',
      );
    }
  });

  it('and the ones filed as not writing state really do not name it', () => {
    // The half of the roster a reader is least likely to re-check. A literal
    // `state:` in the fields argument of a call filed as "no state" is either a
    // stale decision or a new writer that slipped in beside an old one.
    for (const call of CALLS) {
      if (DECIDED[call.key]!.writesState) continue;
      expect(/\bstate\s*:/.test(call.fields), `${call.key} names state after all`).toBe(false);
    }
  });
});
