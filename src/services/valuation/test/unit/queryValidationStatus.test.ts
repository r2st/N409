import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One status for a bad query string, across every route in the service.
 *
 * The rule: a request whose *query string* does not parse is a 400. 422 means
 * the request was well-formed and the server will not act on the *body* — a
 * weight vector that does not sum to one, a pinned comment that is not a note.
 * A query string never gets that far. `?limit=abc` is not a request the server
 * understood and declined; it is a request it could not read.
 *
 * This had drifted to seven-of-nine before it was caught: the same `?limit=`
 * mistake answered 400 on `/report-templates` and 422 on `/help/articles`, for
 * no reason either endpoint could state. A caller cannot write one handler for
 * "you sent a bad page size" if the answer depends on which list was asked, and
 * the ones that had it wrong were not a category — they were the ones written
 * after somebody copied the wrong neighbour.
 *
 * Which is why this is a source scan rather than a request. `listCaps` asserts
 * the codes agree across the nine capped lists, and `paginationBounds` and
 * `pickerLimits` assert the rule on the routes they cover, but all three only
 * see the endpoints somebody remembered to enumerate — and a new route added
 * next week is exactly the one that will copy the wrong neighbour again. This
 * sees every `req.query` parse in the directory, including the ones with no
 * test of their own.
 */

const routesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes');

interface Parse {
  /** `file.ts:12`, for an assertion message that points at the line. */
  at: string;
  /** `query` or `body` — which half of the request failed to parse. */
  source: 'query' | 'body';
  /** The `problems.<kind>` thrown on the failure branch. */
  kind: string;
}

/**
 * Every `safeParse(req.query …)` / `safeParse(req.body …)` in the routes
 * directory, paired with the problem its *failure branch* throws.
 *
 * Anchored on the `!<var>.success` guard rather than on "the next throw", which
 * is the whole difficulty here. A handler's happy path continues immediately
 * below the parse and is usually a run of `if (!row) throw problems.notFound()`
 * — so a scanner that takes the nearest throw reads a successful parse's 404 as
 * the parse's own answer. It anchors on the guard, and pairs it back to the
 * parse by variable name, so what it reports is the branch that actually runs
 * when validation fails.
 *
 * The declaration can sit well above the `.safeParse(` — prettier wraps a long
 * inline schema across a dozen lines — hence the backward search for the name.
 */
function parses(): { found: Parse[]; unresolved: string[] } {
  const found: Parse[] = [];
  const unresolved: string[] = [];

  for (const entry of readdirSync(routesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const lines = readFileSync(path.join(routesDir, entry.name), 'utf8').split('\n');

    lines.forEach((text, i) => {
      const parse = /safeParse\(\s*req\.(query|body)/.exec(text);
      if (!parse) return;
      const at = `${entry.name}:${i + 1}`;
      const source = parse[1] as 'query' | 'body';

      // The result's name, from the declaration this call is the tail of.
      // 45 lines back: the widest inline schema in the directory is the partner
      // PATCH body in `adminUsers.ts`, whose `const parsed =` is twenty-odd
      // commented fields above the `.safeParse(` that terminates it.
      const declaration = lines
        .slice(Math.max(0, i - 45), i + 1)
        .reverse()
        .map((l) => /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(l))
        .find(Boolean);
      if (!declaration) {
        unresolved.push(`${at} (no declaration)`);
        return;
      }
      const name = declaration[1]!;

      // …and the guard on it, with the throw that guard governs.
      const window = lines.slice(i, i + 8).join('\n');
      const guard = new RegExp(
        `!${name}\\.success\\)?\\s*(?:\\{\\s*)?[\\s\\S]{0,120}?throw problems\\.([a-zA-Z]+)\\(`,
      ).exec(window);
      if (!guard) {
        unresolved.push(`${at} (no !${name}.success branch)`);
        return;
      }
      found.push({ at, source, kind: guard[1]! });
    });
  }
  return { found, unresolved };
}

/**
 * The one body parse that deliberately does not answer 422.
 *
 * A signing token is a bearer credential, and `POST /board/resolution` is
 * public. A malformed token and a revoked one have to be indistinguishable from
 * outside, or the difference between the two answers is an oracle: send a
 * candidate token, and a 422 means "not even the right shape" while a 404 means
 * "the right shape, wrong value". So the parse failure is dressed as the same
 * 404 a dead token gets. Listed here rather than exempted by pattern, because
 * the next route that wants this exemption should have to state why.
 */
const NOT_422_BY_DESIGN = new Map([['boardApproval.ts:316', 'notFound']]);

describe('query-string validation answers 400, everywhere', () => {
  const { found, unresolved } = parses();
  const byQuery = found.filter((f) => f.source === 'query');
  const byBody = found.filter((f) => f.source === 'body');

  it('finds the parses it is supposed to be checking', () => {
    // A regex that stopped matching would make the assertions below pass for
    // the worst possible reason — an empty list. There were 60-odd query parses
    // and 80-odd body parses when this was written; the floors are deliberately
    // well under that, since the failure being guarded is "zero", not "fewer
    // than yesterday".
    expect(byQuery.length).toBeGreaterThan(40);
    expect(byBody.length).toBeGreaterThan(40);
    expect(byQuery.map((f) => f.at.split(':')[0])).toContain('help.ts');
    expect(byQuery.map((f) => f.at.split(':')[0])).toContain('grants.ts');
  });

  it('resolves the failure branch of every parse it finds', () => {
    // A parse this scanner cannot pair with a guard is a hole in the check, and
    // it should be visible as a failure rather than as a smaller number above.
    expect(unresolved, 'req.query/req.body parses whose failure branch was not found').toEqual([]);
  });

  it('never answers 422 to a query string', () => {
    const wrong = byQuery.filter((f) => f.kind !== 'badRequest').map((f) => `${f.at} → ${f.kind}`);
    expect(wrong, 'req.query parses that do not answer 400').toEqual([]);
  });

  it('leaves 422 to the request bodies, which is what it is for', () => {
    // The other half of the rule, and the reason this is not simply "ban
    // `unprocessable` in routes/". A body validator answering 400 would be the
    // same loss of information in the other direction: the caller could no
    // longer tell "I sent something unreadable" from "you read it and said no".
    const wrong = byBody
      .filter((f) => f.kind !== (NOT_422_BY_DESIGN.get(f.at) ?? 'unprocessable'))
      .map((f) => `${f.at} → ${f.kind}`);
    expect(wrong, 'req.body parses that do not answer 422').toEqual([]);
  });

  it('keeps the documented exception documented', () => {
    // A stale exemption is worse than none: it is a licence sitting in the list
    // for whatever moves onto that line next.
    for (const [at, kind] of NOT_422_BY_DESIGN) {
      expect(
        byBody.find((f) => f.at === at)?.kind,
        `${at} no longer throws ${kind} — drop it from NOT_422_BY_DESIGN`,
      ).toBe(kind);
    }
  });
});
