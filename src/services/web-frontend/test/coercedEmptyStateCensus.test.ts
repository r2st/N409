import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R226 — the `?? []` that turns "not loaded" into "there are none".
 *
 * Every surface here keeps its loaded data in one nullable state: `null` until
 * a reply lands, an array afterwards. That is three situations, not two — the
 * request is in flight, the request failed, the record is empty — and only the
 * third of them is something the page may say out loud.
 *
 * The coercion collapses the three into one. `const thread = comments ?? []`
 * hands the renderer an empty array for all of them, and `thread.length === 0`
 * cannot tell them apart afterwards, so whatever sentence hangs off it is
 * printed for a wait and for a failure as readily as for an empty record. Two
 * were found this round, both by reading:
 *
 *   - `CommentsSection` printed "No messages yet — start the conversation
 *     below." directly beneath "Could not load the conversation.", and "No
 *     notes yet." in a panel with no banner near it at all;
 *   - the partner console's `ApiTokenPanel` printed "No active tokens." during
 *     the load *and* under its own failure banner — on the screen an
 *     administrator reads to decide whether a firm's integration still holds a
 *     live credential.
 *
 * Both had siblings that were already right: the personal-token card in
 * Settings gates on `tokens &&`, the dashboards gate on a `stats` computed
 * from the same nullable source. So the rule below is the one the correct
 * ones already follow, written down.
 *
 * THE RULE. Where a list is derived from a nullable load state by a `?? []`
 * coercion, an `=== 0` test of that list in JSX child position must sit inside
 * a conditional that tests the *source* — directly (`comments &&`), through a
 * value declared from its nullness (`const stats = valuations ? … : null`,
 * `const topicsSettled = … meta !== null …`), or through an unconditional
 * `if (!X) return` above it. Testing the derived list instead is not a guard:
 * it is `[]` in all three situations, which is the bug.
 *
 * WHAT IT DOES NOT SEE, said plainly:
 *
 *   - only JSX child position. `disabled={replayable.length === 0}` on the DLQ
 *     replay button is a control, not a claim about the record, and reading it
 *     as one would be noise;
 *   - only the `?? []` spelling. A component that keeps `[]` as its initial
 *     state has no null to coerce and no way to tell the three apart at all —
 *     that is `falseEmptyStates.test.tsx`'s territory, from the outside;
 *   - polarity is not checked. `{!data ? <Spinner /> : …}` and `{data ? … :
 *     <p>None</p>}` both read as guarded here. The first is right and the
 *     second is the bug, and only rendering it can tell.
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

/**
 * The `{ … }` containers enclosing `index`, innermost first — but only while
 * they are JSX child position. Returns null the moment the innermost container
 * turns out to be an attribute value (`disabled={…}`) or a function body,
 * which is how those are dropped rather than reported.
 */
function jsxChildConditionals(text: string, index: number, levels = 3): string[] | null {
  const out: string[] = [];
  let pos = index;
  for (let n = 0; n < levels; n++) {
    let depth = 0;
    let open = -1;
    for (let i = pos - 1; i >= 0; i--) {
      const c = text[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) {
          open = i;
          break;
        }
        depth--;
      }
    }
    if (open < 0) break;
    const before = text.slice(0, open).replace(/\s+$/, '').slice(-1);
    if (before !== '>' && before !== '}') return n === 0 ? null : out;
    out.push(text.slice(open, index));
    pos = open;
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  source: string;
  derived: string;
  guarded: boolean;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

const SITES: Site[] = [];
for (const { file, text } of FILES) {
  const sources = [
    ...text.matchAll(/const \[(\w+),\s*set\w+\]\s*=\s*useState<[^=]*?\|\s*null>\(null\)/g),
  ].map((m) => m[1]!);

  for (const source of sources) {
    const derived = [
      ...text.matchAll(new RegExp(`const (\\w+)\\s*=\\s*[^;]*?\\b${source}\\b[^;]*?\\?\\?\\s*\\[\\]`, 'g')),
    ].map((m) => m[1]!);
    if (derived.length === 0) continue;
    const derivedNames = new Set(derived);

    // Anything declared from whether the source is there is as good a guard as
    // the source itself — `stats`, `topicsSettled`. A *derived list* never is:
    // it is `[]` in every one of the three situations.
    const witnesses = new Set([source]);
    const asksAboutNull = new RegExp(`\\b${source}\\s*(\\?[^.]|&&|[!=]==\\s*null)|!\\s*${source}\\b`);
    for (const m of text.matchAll(/const (\w+)\s*=\s*([^;]*)/g)) {
      if (!derivedNames.has(m[1]!) && asksAboutNull.test(m[2]!)) witnesses.add(m[1]!);
    }

    const guardRe = new RegExp(`(^|[^\\w.$])!?\\s*(${[...witnesses].join('|')})\\s*(&&|\\?)`);
    const earlyReturn = new RegExp(`if \\(!${source}\\)\\s*return`).test(text);

    for (const name of derivedNames) {
      for (const m of text.matchAll(new RegExp(`\\b${name}\\.length\\s*===\\s*0`, 'g'))) {
        const context = jsxChildConditionals(text, m.index!);
        if (context === null) continue;
        SITES.push({
          file,
          line: lineOf(text, m.index!),
          source,
          derived: name,
          guarded: earlyReturn || context.some((c) => guardRe.test(c)),
        });
      }
    }
  }
}

describe('an empty-state claim is never made out of a coerced null', () => {
  it('is still finding the shape it is looking for', () => {
    // The vacuity guard. Every assertion below is satisfied by a scan that
    // matched nothing — a renamed `src/`, a `useState` spelling this regex has
    // stopped recognising, or a `jsxChildConditionals` that returns null for
    // everything. Twelve of these existed when the rule was written.
    expect(FILES.length).toBeGreaterThan(100);
    expect(SITES.length).toBeGreaterThanOrEqual(10);
  });

  it('gates every one of them on the source rather than the coercion', () => {
    const ungated = SITES.filter((s) => !s.guarded).map(
      (s) =>
        `${s.file}:${s.line} — ${s.derived} is ${s.source} ?? [], and nothing here asks about ${s.source}`,
    );
    expect(ungated).toEqual([]);
  });
});
