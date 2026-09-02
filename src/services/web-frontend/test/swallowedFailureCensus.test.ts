import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The recurring shape: a request whose failure is thrown away.
 *
 * This has been found and fixed one component at a time across rounds 12, 16,
 * 119 and 120 — `IntakeTab`, `GrantsTab`, `FundPortfolioPage`,
 * `SubscriptionSection`, `CapTableSyncPanel`, `HrisSyncPanel`,
 * `OrgAssignmentCard`, `RollforwardPanel`, `AnonymizePanel`, `TasksPage`,
 * `AdminUsersPage`, the bulk reviewer bar, and two download buttons. Each was
 * found by grepping, and grepping finds what already exists rather than
 * stopping the next one from being written.
 *
 * The failures are never loud. `catch { setItems([]) }` renders a 503 as "you
 * have none of these", usually with an invitation to create one; `.catch(() =>
 * {})` on a picker renders it as "there is nobody to choose", and the pickers
 * that write on change then act on that. The worst two found so far both came
 * from the same missing roster: a queue that accused every assignee of having
 * been deleted, and a bulk control labelled "Assign reviewer" that sent
 * `reviewer_id: null` — *unassign* — across every selected engagement.
 *
 * So the swallow itself is what this census counts. Two lists, and the
 * difference between them is the point:
 *
 *   - `SILENT_BY_DESIGN` — the failure genuinely warrants no UI. Polled
 *     badges, fire-and-forget writes, additive extras. These are settled.
 *   - `KNOWN_UNFIXED` — real, still wrong, written down. A list that exists so
 *     it can shrink, not so it can be pointed at.
 *
 * The set of swallows must equal the union exactly. A new one fails until it
 * is classified; a fixed one fails until it is struck off. `KNOWN_UNFIXED` is
 * deliberately not a permission — a census whose allowlist rubber-stamps known
 * bugs is a check that passes by having nothing left to ask.
 *
 * R352 (M5) added the second spelling. Until then the population was the arrow
 * form alone — `.catch(() => …)` — and `try { await api(…) } catch { … }`
 * around the identical discard was invisible to it. `ScenariosTab` answered a
 * failed read of the saved bull/base/bear cases with `setSaved(null)`, which
 * took the only surface those cases appear on off the page: a 503 drawn as
 * *this engagement has saved none*, beside a form still inviting one. It sat
 * there through every round this census has been green for, because a census
 * that reads one of two spellings is green about the half it reads.
 */

/** Reasons are prose on purpose: an entry nobody can justify is a bug. */
const SILENT_BY_DESIGN: Record<string, string> = {
  // One entry, not three, since the three nav badges were hoisted into
  // `useBadgePoll` — the swallow moved into the hook with them, so there is one
  // site left and the census keys it by the hook's parameter (R350). The
  // justification is unchanged and covers all three callers.
  'src/components/AppLayout.tsx\tpath':
    'The shared nav-badge poll, every 60s for the inbox, bucket and notification counts. Raising an error banner from a badge is worse than a stale number.',
  'src/lib/crashReport.ts\tENDPOINT':
    'The crash reporter posting to /client-errors. The network is the other thing that might be broken, and a failed crash report has nowhere to be reported to.',
  'src/lib/auth.tsx\t/api/v1/auth/logout':
    'Best-effort POST. The local session is already cleared, and the user is on their way out.',
  'src/pages/ClientIntakePage.tsx\t/api/v1/intake/portal/answers':
    'Unload-time save. Nobody is looking at the page and a result has nowhere to land.',
  'src/pages/BrandingPage.tsx\t/branding/settings':
    'Re-reads branding after a save that reports its own outcome.',
  'src/pages/valuation/ReportTab.tsx\t/valuations/${valuation.id}/report/versions':
    'Cosmetic refresh in a finally on the failure path — it must not replace the error explaining the refusal.',
  'src/lib/branding.tsx\t/branding':
    'An unbranded tenant is the norm and platform branding is already applied.',
  'src/components/valuation/ExplanationCard.tsx\t/valuations/${valuationId}/explanation':
    'Purely additive prose beside a figure that stands without it.',
  'src/pages/BotPromptsPage.tsx\t/admin/prompts/models':
    'A datalist of suggestions on a free-text field. The field works with no suggestions.',
  'src/components/HelpWidget.tsx\t(none)':
    'Falls back to the built-in topic list, so the widget still answers the questions it shipped with.',
  'src/pages/CommunicationsPage.tsx\t/admin/communication-templates/variables':
    'A palette of insertable variables. Without it they are typed by hand, which is what the page did before.',
  'src/pages/PartnerDetailPage.tsx\t/admin/communication-templates/variables':
    'The same palette, on the white-label template editor. It degrades to the three variables the send is typed to require — and the endpoint is ops-only, so a partner administrator may legitimately be refused it.',
  'src/components/GettingStarted.tsx\t/onboarding/progress':
    'A checklist of onboarding steps, additive to the ones the user has ticked by hand. Its own comment says so, and the panel is dismissible.',
  'src/pages/PartnerPortalPage.tsx\t/partners/mine':
    'Branding only. The heading falls back to "Your portfolio", which is true of every partner and claims nothing.',
  // The block spelling, in the population since R352.
  'src/lib/realtime.ts\t/api/v1/valuations/${valuationId}/stream':
    'The SSE read loop. Every way out of it — unmount, abort, a dropped socket — is answered below by the reconnect and the presence reset, which is where the failure is handled rather than reported.',
  'src/pages/InboxPage.tsx\t/inbox/read':
    'Marking a thread read on the way into it. The optimistic update is inside the try, so a failure leaves the row exactly as it was, and the next load restores the truth.',
  'src/pages/NotificationsPage.tsx\t/notifications/${id}/read':
    'The same fire-and-forget read mark, per row. A failed mark leaves the row unread, which is what it was; interrupting the navigation it accompanies would cost more than the stale badge.',
  'src/pages/PaymentRedirectPages.tsx\t/valuations/${valuationId}/payments':
    'The post-checkout poll. A failed poll is transient by assumption and the loop keeps going; the budget running out is reported, by `setTimedOut`.',
};

/** Each reason says what the user is told that is not true. */
const KNOWN_UNFIXED: Record<string, string> = {
  // Empty, for now. The list is the point, not its length — the census fails on
  // a new swallow whether or not anything is currently owed.
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/**
 * Comments out, code in.
 *
 * Not cosmetic: the doc comment on `useDownload` quotes `.catch(() => {})` as
 * the thing it exists to replace, and an unstripped scan reported the fix as an
 * instance of the bug. Block comments are removed wholesale; line comments only
 * where the `//` opens the line, which leaves `https://` inside a string alone.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Empty body, or one that only substitutes a value nobody sent.
 *
 * R270 widened the second half twice. It read `[]` and `null` — the two
 * substitutions that at least *look* like an absence — and the sign-in page was
 * answering a failed `/auth/providers` with `setProviders({ password: true,
 * google: false })`: a whole record, invented, asserting which doors into the
 * product exist. That is the worst version of this shape and it was the one
 * spelling the census could not see, because a fabricated object reads as data
 * rather than as a gap. `undefined` joined it for the same reason `{}` is
 * there: it is a discarded failure wearing a value.
 */
const SWALLOW =
  /\.catch\(\(\)\s*=>\s*(?:\{\s*\}|undefined|set[A-Za-z0-9_]*\(\s*(?:\[\s*\]|null|\{[^}]*\})\s*\))\s*\)/g;

/**
 * The request a catch belongs to: the nearest call before it, named by its
 * first argument.
 *
 * A literal path where there is one, and otherwise the identifier holding it.
 * The literal-only version had a blind spot a refactor walked straight into:
 * `AppLayout` hoisted its three nav-badge polls into one `useBadgePoll(path)`
 * hook, so the swallow's nearest call became `api<T>(path)` with no literal
 * anywhere before it. The entry key silently became `(none)`, which failed both
 * assertions at once — three list entries stale and one swallow unclassified —
 * and would have collapsed to the same opaque key for any *other* swallow in
 * the file, so a genuinely new one would have hidden behind the settled one.
 *
 * Naming the identifier keeps the key specific to the call site through a
 * refactor that moves the URL a level up, which is the ordinary way this code
 * changes. `(none)` remains for a call whose argument is neither.
 */
const REQUEST = /(?:api|fetch)\s*(?:<[^>]*>)?\s*\(\s*(?:[`'"]([^`'"]*)[`'"]|([A-Za-z_$][\w$]*)\s*[,)])/g;

/**
 * The same discard, written as a statement instead of an argument.
 *
 * `SWALLOW` above reads `.catch(() => …)`. The block form is
 * `try { await api(…) } catch { … }`, and it says exactly the same thing: a
 * body that is empty, or that substitutes a value nobody sent. Comments are
 * already stripped by the time this runs, so a catch whose whole body is an
 * explanation counts as empty — which is the common spelling of it, and the
 * one `ScenariosTab` was written in.
 */
const BLOCK_DISCARD =
  /^(?:return\s+(?:\[\s*\]|null|undefined|\{\s*\}|new (?:Set|Map)\(\))\s*;?|(?:set[A-Za-z0-9_]*\(\s*(?:\[\s*\]|null|undefined|\{[^}]*\})\s*\)\s*;?\s*)+)$/;

/** The `{ … }` opening at `open`, and where it closes. */
function braced(source: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, i), end: i };
    }
  }
  return { body: source.slice(open + 1), end: source.length };
}

function keyFor(file: string, region: string): string {
  const requests = [...region.matchAll(REQUEST)];
  const last = requests.length ? requests[requests.length - 1]! : null;
  return `${file}\t${last ? (last[1] ?? last[2] ?? '(none)') : '(none)'}`;
}

/**
 * Block-form discards, keyed by the request their own `try` was making.
 *
 * Scoped to the try body rather than to everything before the catch, which the
 * arrow half has to do. That is not a refinement for its own sake: a
 * `JSON.parse(localStorage.getItem(…))` guard is a `catch { return null }` too,
 * and it is not a swallowed *request* failure — this census's whole subject.
 * Requiring the guarded block to contain the call keeps those out, and keeps
 * every key distinct, so no entry can hide behind another one's `(none)`.
 */
function blockSwallows(file: string, source: string): string[] {
  const found: string[] = [];
  for (const start of source.matchAll(/\btry\s*\{/g)) {
    const tryOpen = source.indexOf('{', start.index);
    const { body: guarded, end } = braced(source, tryOpen);
    const after = source.slice(end + 1);
    const clause = /^\s*catch\s*(?:\(\s*([A-Za-z_$][\w$]*)?[^)]*\))?\s*\{/.exec(after);
    if (!clause) continue;
    const { body } = braced(source, end + 1 + after.indexOf('{', clause.index));
    const discarded = body.trim().replace(/\s+/g, ' ');
    // A body that names the error it caught is doing something with it.
    if (clause[1] && new RegExp(`\\b${clause[1]}\\b`).test(discarded)) continue;
    if (discarded !== '' && !BLOCK_DISCARD.test(discarded)) continue;
    if (!REQUEST.test(guarded)) continue;
    REQUEST.lastIndex = 0;
    found.push(keyFor(file, guarded));
  }
  REQUEST.lastIndex = 0;
  return found;
}

function census(): string[] {
  const found: string[] = [];
  for (const file of walk('src')) {
    if (!/\.tsx?$/.test(file)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(SWALLOW)) {
      found.push(keyFor(file, source.slice(0, match.index)));
    }
    found.push(...blockSwallows(file, source));
  }
  return found.sort();
}

describe('swallowed request failures', () => {
  const found = census();

  /*
   * The scanner is the thing most likely to break silently — a regex that
   * matches nothing makes every other assertion here pass. These pin that it is
   * still reading code and still recognising the shape.
   */
  it('is still finding the shape it is looking for', () => {
    expect(found.length).toBeGreaterThan(10);
    expect(SWALLOW.test('.catch(() => {})')).toBe(true);
    SWALLOW.lastIndex = 0;
    expect(SWALLOW.test('.catch(() => setItems([]))')).toBe(true);
    SWALLOW.lastIndex = 0;
    // The R270 spelling: a record nobody sent, which is a claim, not a gap.
    expect(SWALLOW.test('.catch(() => setProviders({ password: true }))')).toBe(true);
    SWALLOW.lastIndex = 0;
    expect(SWALLOW.test('.catch(() => undefined)')).toBe(true);
    SWALLOW.lastIndex = 0;
    // The shape that is the fix, not the bug: a failure the page can draw.
    expect(SWALLOW.test('.catch(() => setProvidersFailed(true))')).toBe(false);
    SWALLOW.lastIndex = 0;
    expect(SWALLOW.test(".catch(() => setError('Could not load.'))")).toBe(false);
    SWALLOW.lastIndex = 0;
  });

  it('names the call site when the path was hoisted into a variable', () => {
    // The R350 regression: `useBadgePoll(path)` put the URL a level up, and a
    // literal-only matcher keyed every swallow in the file as `(none)`.
    const found = census();
    expect(found).toContain('src/components/AppLayout.tsx\tpath');
    expect(found).not.toContain('src/components/AppLayout.tsx\t(none)');
    expect(REQUEST.test('api<T>(path)')).toBe(true);
    REQUEST.lastIndex = 0;
    expect(REQUEST.test("api('/inbox/unread-count')")).toBe(true);
    REQUEST.lastIndex = 0;
  });

  it('reads the block spelling as well as the arrow one (R352)', () => {
    // The blind spot `ScenariosTab` sat in: the same discard, written as a
    // statement. Both halves must be represented, and the block half must not
    // drag in the localStorage guards that share its shape but not its subject.
    expect(found).toContain('src/pages/InboxPage.tsx\t/inbox/read');
    expect(found).toContain('src/pages/NotificationsPage.tsx\t/notifications/${id}/read');
    // `tokenExpiry`'s `catch { return null }` guards a JSON.parse, not a request.
    expect(found).not.toContain('src/lib/api.ts\t(none)');

    const block = (source: string) => blockSwallows('f.ts', stripComments(source));
    expect(block('try { await api("/x") } catch { }')).toEqual(['f.ts\t/x']);
    expect(block('try { await api("/x") } catch {\n  // nothing to say\n}')).toEqual(['f.ts\t/x']);
    expect(block('try { setA(await api("/x")) } catch { setA(null); }')).toEqual(['f.ts\t/x']);
    // The fix, not the bug.
    expect(block('try { await api("/x") } catch (err) { setError(describe(err)); }')).toEqual([]);
    expect(block('try { await api("/x") } catch { setFailed(true); }')).toEqual([]);
    // Not a request at all.
    expect(block('try { return JSON.parse(raw) } catch { return null }')).toEqual([]);
  });

  it('does not read a doc comment about the bug as the bug', () => {
    // `useDownload` quotes the pattern it replaces; an unstripped scan flagged it.
    expect(found).not.toContain('src/lib/useDownload.ts\t(none)');
    expect(stripComments('/** .catch(() => {}) */\nconst a = 1;')).not.toContain('catch');
    expect(stripComments("const u = 'https://x.example';")).toContain('https://x.example');
  });

  it('classifies every swallow as deliberate or as known-unfixed', () => {
    const classified = new Set([...Object.keys(SILENT_BY_DESIGN), ...Object.keys(KNOWN_UNFIXED)]);
    const unclassified = found.filter((entry) => !classified.has(entry));
    expect(
      unclassified,
      'A new discarded failure. Give the user something to read, or add it to KNOWN_UNFIXED ' +
        'saying what they are told that is not true.',
    ).toEqual([]);
  });

  it('has no entry left over from a swallow that is gone', () => {
    const present = new Set(found);
    const stale = [...Object.keys(SILENT_BY_DESIGN), ...Object.keys(KNOWN_UNFIXED)].filter(
      (entry) => !present.has(entry),
    );
    expect(stale, 'Fixed or moved — strike it off the list.').toEqual([]);
  });

  it('keeps the two lists disjoint and every entry justified', () => {
    const both = Object.keys(SILENT_BY_DESIGN).filter((k) => k in KNOWN_UNFIXED);
    expect(both, 'A swallow is either deliberate or a bug, not both.').toEqual([]);
    for (const [entry, reason] of Object.entries({ ...SILENT_BY_DESIGN, ...KNOWN_UNFIXED })) {
      expect(reason.length, `${entry} needs a reason worth reading`).toBeGreaterThan(30);
    }
  });
});
