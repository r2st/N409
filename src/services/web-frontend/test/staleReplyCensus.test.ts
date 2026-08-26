import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The recurring shape: a request the user can re-issue before the first reply
 * lands, with nothing deciding which reply wins.
 *
 * Every list, picker and pager here re-fetches when a dependency changes, and
 * `fetch` promises nothing about the order of the replies. Two are outstanding,
 * the slower one lands second, and the previous answer is painted under the
 * current controls. There is no error, no spinner left to explain it — the
 * `setData(null)` that would have justified one ran before the request — and no
 * further request coming to correct it. The screen settles, self-consistently,
 * on the wrong answer: page 2's rows beneath a pager reading 3, one
 * organization's consolidated equity value under another's name, a value bridge
 * decomposing a pair of valuations nobody asked to compare.
 *
 * Found and fixed a component at a time — `SearchPage` and `CalculatorPage` in
 * earlier rounds, then the worklist, the comparison page, the bridge, the
 * portfolio sidebar, the partner pager and the valuation workspace in R121 —
 * which is exactly the pattern that says a census belongs here. Grepping finds
 * what exists; it does not stop the next one being written.
 *
 * R147 is the reason the scanner's own reach is now asserted as hard as its
 * verdict. This file passed for two rounds with an empty `KNOWN_UNFIXED` while
 * seven live races sat in the tree — the firm console's book of clients, the
 * job monitor under its own fifteen-second poll, the admin user list, the
 * template categories, the email outbox, the shared inbox and the support
 * queue. None of them was a new mistake; every one was written in a spelling
 * this scan did not read. A census that cannot see a shape reports its absence
 * as health, which is worse than not having one — see `vacuousChecks`.
 *
 * What is counted is narrower than "an effect that fetches", and the narrowing
 * is the substance rather than a convenience. An effect that re-requests *the
 * same address* cannot show the wrong answer, however many replies overlap; the
 * bug needs two different addresses outstanding at once. So the scan flags an
 * unguarded effect only when its request URL interpolates something the effect
 * declares as a dependency — including through a `useCallback` it delegates to,
 * which is how most of them are written here.
 *
 * Two lists, and the difference between them is the point:
 *
 *   - `ORDERED_BY_A_REMOUNT` — the component is torn down when that dependency
 *     changes, so the late reply writes to state that no longer exists. This is
 *     a real guard, not an excuse, but it is only true if something makes it
 *     true; the entries name what.
 *   - `KNOWN_UNFIXED` — real, still wrong, written down. A list that exists so
 *     it can shrink, not so it can be pointed at.
 *
 * The set of flagged effects must equal the union exactly. A new one fails
 * until it is classified; a fixed one fails until it is struck off.
 */

/**
 * The whole valuation workspace subtree is one entry with one reason.
 *
 * `ValuationWorkspace` renders its `<Outlet>` with `key={id}`, so every tab and
 * every panel beneath it is rebuilt when the URL moves to another engagement.
 * That is what makes forty-odd `/valuations/${id}/…` loads safe without forty
 * tickets, and it is asserted directly — see
 * `ValuationWorkspaceNavigation.test.tsx`, "rebuilds the tab below rather than
 * re-rendering it with a new engagement". If that key is ever dropped, that
 * test fails and this exemption is what it was protecting.
 */
const KEYED_SUBTREE = /^src\/(?:pages\/valuation|components\/valuation)\//;

/** The valuation the whole subtree is addressed by. */
const VALUATION_ID = /^(?:valuation|valuationId|v)$/;

/**
 * …under whatever local name the file gave it.
 *
 * `Asc718Tab` opens with `const id = valuation.id`, and once the scan started
 * following names into the URL that alias read as an unrelated dependency
 * called `id` — a keyed-subtree file reported as a race, which is the failure
 * mode that makes a census worth ignoring. The alias is checked rather than
 * `id` being added to the list above, because a bare `id` in this subtree is
 * exactly as likely to be a grant, a document or a comment.
 */
function aliasesTheValuation(source: string, slot: string): boolean {
  return new RegExp(`\\b(?:const|let)\\s+${slot}\\s*=\\s*valuation\\??\\.id\\b`).test(source);
}

/** Reasons are prose on purpose: an entry nobody can justify is a bug. */
const ORDERED_BY_A_REMOUNT: Record<string, string> = {
  'src/pages/ValuationDetailPage.tsx\tvaluation':
    'The workspace index route, rendered inside the Outlet keyed by the engagement — see KEYED_SUBTREE.',
  'src/components/BoardApprovalPanel.tsx\tvaluation':
    'A child of ValuationDetailPage, so it is rebuilt with it when the engagement changes — see KEYED_SUBTREE.',
  'src/components/SignaturePanel.tsx\tvaluation':
    'A child of ValuationDetailPage, so it is rebuilt with it when the engagement changes — see KEYED_SUBTREE.',
  'src/components/CommentThread.tsx\tvaluationId':
    'CommentsSection is a child of ValuationDetailPage, rebuilt with it when the engagement changes — see KEYED_SUBTREE.',
  'src/components/FundingHistory.tsx\tvaluationId':
    'A child of ValuationDetailPage, so it is rebuilt with it when the engagement changes — see KEYED_SUBTREE.',
  'src/pages/AdminNarrativePromptsPage.tsx\tkind':
    'PreviewPanel is rendered with key={`${kind}:…`}, so switching kind rebuilds it rather than re-running its effect.',
  'src/pages/PartnerLoginPage.tsx\tslug':
    'The slug is the subdomain the page was served on. It cannot change without a full document load.',
  'src/pages/DebtInstrumentsPage.tsx\tinstrumentId':
    'Rendered as <InstrumentDetail key={selected} …>, so picking another instrument rebuilds it rather than re-running its load.',
  'src/pages/FundPortfolioPage.tsx\tfundId':
    'Rendered as <FundDetailView key={selected} …>, so picking another fund rebuilds it rather than re-running its load.',
  'src/pages/PartnerPortalPage.tsx\tpartnerId':
    'The signed-in user’s own firm, read off the session. It does not change while a session lasts.',
};

/** Each reason says what the user is shown that is not true. */
const KNOWN_UNFIXED: Record<string, string> = {
  // Empty, for now. The list is the point, not its length — the census fails on
  // a new race whether or not anything is currently owed.
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** Comments out, code in — see the note in `swallowedFailureCensus`. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The `{ … }` starting at or after `from`, balanced. */
function balanced(source: string, from: number): { body: string; end: number } | null {
  const open = source.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return { body: source.slice(open, i + 1), end: i + 1 };
  }
  return null;
}

const REQUESTS = /\b(?:api|apiDownload|fetch)\s*(?:<[^>]*>)?\s*\(/;
const WRITES_STATE = /\bset[A-Z]\w*\(/;

/**
 * The guard spellings in the tree: the `useLatestOnly` ticket, a boolean flag
 * cleared in the effect's cleanup, and the sequence ref that predates the hook.
 * `AbortController` counts too — no call site uses one, but a scanner that
 * reported a correct fix as the bug would be worse than useless.
 */
const GUARDED = /\bcurrent\(\)|\b(?:cancelled|canceled|ignored?|aborted|live)\b|\.current\b|AbortController/;

/**
 * Where `const <name> = useCallback(…)` is declared, nearest *before* `before`.
 *
 * Searching from the top of the file is the obvious spelling and it under-
 * reports: `PartnerDetailPage` declares three different callbacks called
 * `load`, and resolving every one of them to the first meant the page's own
 * partner load — a genuine race, since `:id` changes without the page being
 * torn down — was never reached at all. Nearest-preceding is what a reader
 * would do, and what the shadowing rules actually mean.
 */
function declarationBefore(source: string, name: string, before: number): number {
  const decl = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*useCallback\\s*\\(`, 'g');
  let at = -1;
  for (const m of source.matchAll(decl)) {
    if (m.index > before) break;
    at = m.index;
  }
  // A callback declared *after* the effect that uses it is not valid here, but
  // falling back to the first keeps the scan honest rather than silently blind.
  if (at < 0) at = source.search(decl);
  return at;
}

/** The body of the `useCallback` called `name` in scope at `before`. */
function namedCallbackBody(source: string, name: string, before: number): string {
  const at = declarationBefore(source, name, before);
  if (at < 0) return '';
  return balanced(source, at)?.body ?? '';
}

/** The dependency array of that same `useCallback`. */
function namedCallbackDeps(source: string, name: string, before: number): string[] {
  const at = declarationBefore(source, name, before);
  if (at < 0) return [];
  const block = balanced(source, at);
  if (!block) return [];
  const deps = source.slice(block.end, block.end + 200).match(/^\s*,\s*\[([^\]]*)\]/);
  return deps ? roots(deps[1]!) : [];
}

/** `[valuation.id, page]` → `['valuation', 'page']`. */
function roots(deps: string): string[] {
  return deps
    .split(',')
    .map((d) =>
      d
        .trim()
        .split(/[.?[(]/)[0]!
        .trim(),
    )
    .filter(Boolean);
}

/** The parameter names of the `useCallback` called `name` in scope at `before`. */
function namedCallbackParams(source: string, name: string, before: number): string[] {
  const at = declarationBefore(source, name, before);
  if (at < 0) return [];
  const head = source.slice(at, source.indexOf('{', at));
  const args = /\(([^)]*)\)\s*(?::[^=]*)?=>\s*$/.exec(head.replace(/useCallback\s*\(\s*(?:async\s*)?/, ''));
  if (!args) return [];
  return args[1]!
    .split(',')
    .map((a) => a.trim().split(/[:=]/)[0]!.trim())
    .filter((a) => /^[A-Za-z_$][\w$]*$/.test(a));
}

/**
 * `useEffect(load, [load])`, `useEffect(() => { void load(); }, [load])` — and
 * `useEffect(() => { … loadClients(page, search) … }, [page, search, loadClients])`.
 *
 * All three spellings are in the tree and all three hide the request one level
 * down, in a `useCallback` whose own dependency is what actually changes.
 * Resolving the name is not a nicety: the valuation workspace — the instance
 * every tab reads the object from — is written the second way, and a scan that
 * only reads inline bodies reports it clean.
 *
 * The third form is the one this scanner missed for two rounds, and it is worth
 * saying why it is not a variant of the second. There the loader closes over
 * what varies, so the *callback's* dependency array names it; here what varies
 * is handed in as an argument, so the callback's dependency array names only
 * the tenant and the varying term appears nowhere the old scan looked. Behind
 * exactly that shape sat the firm console's book of clients, re-requested on
 * every keystroke and every page click with nothing ordering the replies.
 *
 * Returns the effect body with every such callee's body appended, and the
 * parameter names those callees bind, which `varyingSlot` treats as varying
 * when the call site passes something that varies into them.
 */
function resolveDelegation(
  source: string,
  body: string,
  deps: string[],
  before: number,
): { body: string; bound: string[] } {
  const only = body
    .replace(/\s+/g, ' ')
    .trim()
    .match(/^\{\s*(?:void\s+)?(\w+)\(\)\s*;?\s*\}$/);
  if (only) return { body: namedCallbackBody(source, only[1]!, before) || body, bound: [] };

  let out = body;
  const bound: string[] = [];
  for (const dep of deps) {
    const call = new RegExp(`\\b${dep}\\s*\\(\\s*([^)]*)\\)`).exec(body);
    if (!call) continue;
    const callee = namedCallbackBody(source, dep, before);
    if (!callee) continue;
    out += `\n${callee}`;
    // Only the parameters the call site fills from something that varies. A
    // constant argument binds a constant, and reporting that as varying would
    // turn every loader taking a literal into a false positive.
    const args = call[1]!.split(',').map((a) => a.trim());
    const params = namedCallbackParams(source, dep, before);
    args.forEach((arg, i) => {
      const idents = arg.match(/[A-Za-z_$][\w$]*/g) ?? [];
      if (idents.some((id) => deps.includes(id)) && params[i]) bound.push(params[i]!);
    });
  }
  return { body: out, bound };
}

/**
 * The interpolation in the request URL that moves with a dependency, if any.
 *
 * This is the difference between the bug and the overwhelming majority of
 * effects here, which fetch one fixed address on mount and refetch it after a
 * mutation. Two replies to the same address cannot disagree about anything that
 * matters; two replies to different addresses are two different answers, and
 * only one of them belongs to what is on screen.
 */
function varyingSlot(
  source: string,
  body: string,
  deps: string[],
  bound: string[],
  before: number,
): string | null {
  const closure = deps.flatMap((d) => namedCallbackDeps(source, d, before));
  const all = new Set([...deps, ...closure, ...bound]);
  /*
   * One hop through a local. `/firm/clients?${query}` interpolates a name that
   * is in no dependency array anywhere — it is a `URLSearchParams` assembled
   * two lines up out of the page number and the search term. Reading only the
   * identifier in the braces says that address is fixed, which is how the firm
   * console's pager sat unflagged: the varying part had been given a name.
   * Anything assigned from something that varies, varies.
   */
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const assign of body.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=([^;]*);/g)) {
      const name = assign[1]!;
      if (all.has(name)) continue;
      const idents = assign[2]!.match(/[A-Za-z_$][\w$]*/g) ?? [];
      if (idents.some((id) => all.has(id))) {
        all.add(name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  const urls = [...body.matchAll(/(?:api|apiDownload|fetch)\s*(?:<[^>]*>)?\s*\(\s*`([^`]*)`/g)];
  for (const url of urls) {
    for (const slot of url[1]!.matchAll(/\$\{([^}]*)\}/g)) {
      for (const ident of slot[1]!.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (all.has(ident)) return ident;
      }
    }
  }
  /*
   * …and the address handed over as a name rather than written at the call.
   * `api<FirmDashboard>(path)` reads as a fixed address to a scan that only
   * looks inside backticks, and `path` two lines above is the ternary choosing
   * between one tenant's console and another's.
   */
  for (const call of body.matchAll(
    /(?:api|apiDownload|fetch)\s*(?:<[^>]*>)?\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g,
  )) {
    if (all.has(call[1]!)) return call[1]!;
  }
  return null;
}

function census(): string[] {
  const found: string[] = [];
  for (const file of walk('src')) {
    if (!/\.tsx?$/.test(file)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/useEffect\(\s*(?:\(\)\s*=>|(\w+)\s*,)/g)) {
      const named = match[1];
      const block = named ? null : balanced(source, match.index);
      if (!named && !block) continue;
      const from = named ? match.index + match[0].length : block!.end;
      const deps = source.slice(from, from + 300).match(named ? /^\s*\[([^\]]*)\]/ : /^\s*,\s*\[([^\]]*)\]/);
      // A mount-only effect (`[]`) issues exactly one request and cannot race.
      if (!deps || deps[1]!.trim() === '') continue;
      const declared = roots(deps[1]!);
      const resolved = named
        ? { body: namedCallbackBody(source, named, match.index), bound: [] as string[] }
        : resolveDelegation(source, block!.body, declared, match.index);
      const body = resolved.body;
      if (!REQUESTS.test(body) || !WRITES_STATE.test(body)) continue;
      if (GUARDED.test(body)) continue;
      const slot = varyingSlot(source, body, declared, resolved.bound, match.index);
      if (!slot) continue;
      // The workspace subtree is exempted as a subtree, by the Outlet key —
      // but only for the dependency that key is keyed on.
      if (KEYED_SUBTREE.test(file) && (VALUATION_ID.test(slot) || aliasesTheValuation(source, slot)))
        continue;
      found.push(`${file}\t${slot}`);
    }
  }
  return [...new Set(found)].sort();
}

describe('stale replies to a re-issued request', () => {
  const found = census();

  /*
   * The scanner is the thing most likely to break silently — a predicate that
   * matches nothing makes every other assertion here pass. These pin that it is
   * still reading code, still recognising the shape, and still able to tell a
   * guarded effect from an unguarded one.
   */
  it('is still finding the shape it is looking for', () => {
    const fixture = `
      const load = useCallback(() => {
        api(\`/valuations/\${valuationId}/x\`).then((d) => setThing(d));
      }, [valuationId]);
      useEffect(() => { void load(); }, [load]);
    `;
    const { body } = resolveDelegation(fixture, '{ void load(); }', ['load'], fixture.length);
    expect(body).toContain('/valuations/');
    expect(varyingSlot(fixture, body, ['load'], [], fixture.length)).toBe('valuationId');
    // A fixed address, re-requested: not this bug.
    expect(
      varyingSlot(fixture, 'api(`/organizations`).then(setD)', ['selected'], [], fixture.length),
    ).toBeNull();
    expect(GUARDED.test('.then((d) => current() && setD(d))')).toBe(true);
    expect(GUARDED.test('.then((d) => setD(d))')).toBe(false);
  });

  /*
   * The firm console's shape, reduced: the loader takes what varies as an
   * argument rather than closing over it, and the varying part is named before
   * it reaches the URL. Both hops have to work or the entry silently vanishes
   * from the census and the list below reads as clean.
   */
  it('follows a loader called with arguments, and a URL assembled into a local', () => {
    const fixture = `
      const loadClients = useCallback(async (nextPage: number, term: string) => {
        const query = new URLSearchParams({ page: String(nextPage) });
        if (term) query.set('search', term);
        const res = await api(\`/firm/clients?\${query}\`);
        setClients(res.clients);
      }, [partnerId]);
      useEffect(() => {
        const timer = setTimeout(() => void loadClients(page, search), 250);
        return () => clearTimeout(timer);
      }, [page, search, loadClients]);
    `;
    const deps = ['page', 'search', 'loadClients'];
    const effect = '{ const timer = setTimeout(() => void loadClients(page, search), 250); }';
    const { body, bound } = resolveDelegation(fixture, effect, deps, fixture.length);
    expect(body).toContain('/firm/clients');
    expect(bound).toEqual(['nextPage', 'term']);
    expect(varyingSlot(fixture, body, deps, bound, fixture.length)).toBe('query');
    // The same loader called with nothing that varies binds nothing, so its
    // address is fixed and it is not this bug.
    const fixed = resolveDelegation(fixture, '{ void loadClients(1, ""); }', deps, fixture.length);
    expect(fixed.bound).toEqual([]);
    expect(varyingSlot(fixture, fixed.body, ['loadClients'], fixed.bound, fixture.length)).toBeNull();
  });

  it('still sees the guards this round installed, so they cannot be quietly removed', () => {
    // Each of these would be flagged the moment its ticket came out; the census
    // is what turns that from a silent regression into a failing test.
    for (const file of [
      'src/pages/ValuationsPage.tsx',
      'src/pages/ValuationComparePage.tsx',
      'src/pages/PortfolioPage.tsx',
      'src/pages/PartnerDetailPage.tsx',
      'src/pages/valuation/ValuationWorkspace.tsx',
      'src/pages/valuation/BridgeTab.tsx',
      // R147, all of them behind the delegation blind spot described on
      // `resolveDelegation`: the loader takes what varies as an argument, or
      // assembles it into a `URLSearchParams` before the URL sees it.
      'src/pages/FirmDashboardPage.tsx',
      'src/pages/AdminJobsPage.tsx',
      'src/pages/AdminUsersPage.tsx',
      'src/pages/CommunicationsPage.tsx',
      'src/pages/EmailOutboxPage.tsx',
      'src/pages/InboxPage.tsx',
      'src/pages/SupportInboxPage.tsx',
    ]) {
      expect(readFileSync(file, 'utf8'), `${file} lost its stale-reply guard`).toContain('useLatestOnly');
    }
  });

  it('classifies every racing effect as remount-ordered or as known-unfixed', () => {
    const classified = new Set([...Object.keys(ORDERED_BY_A_REMOUNT), ...Object.keys(KNOWN_UNFIXED)]);
    const unclassified = found.filter((entry) => !classified.has(entry));
    expect(
      unclassified,
      'An effect whose URL moves with a dependency and whose reply is unordered. Guard it with ' +
        'useLatestOnly, or add it to KNOWN_UNFIXED saying what the user is shown that is not true.',
    ).toEqual([]);
  });

  it('has no entry left over from a race that is gone', () => {
    const present = new Set(found);
    const stale = [...Object.keys(ORDERED_BY_A_REMOUNT), ...Object.keys(KNOWN_UNFIXED)].filter(
      (entry) => !present.has(entry),
    );
    expect(stale, 'Guarded, moved or deleted — strike it off the list.').toEqual([]);
  });

  it('keeps the two lists disjoint and every entry justified', () => {
    const both = Object.keys(ORDERED_BY_A_REMOUNT).filter((k) => k in KNOWN_UNFIXED);
    expect(both, 'An effect is either ordered by something or it is a bug, not both.').toEqual([]);
    for (const [entry, reason] of Object.entries({ ...ORDERED_BY_A_REMOUNT, ...KNOWN_UNFIXED })) {
      expect(reason.length, `${entry} needs a reason worth reading`).toBeGreaterThan(30);
    }
  });
});
