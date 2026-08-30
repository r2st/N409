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
 */

/** Reasons are prose on purpose: an entry nobody can justify is a bug. */
const SILENT_BY_DESIGN: Record<string, string> = {
  'src/components/AppLayout.tsx\t/inbox/unread-count':
    'A badge polled every 60s. Raising an error banner from a badge is worse than a stale number.',
  'src/components/AppLayout.tsx\t/valuations/counts?buckets=named':
    'Nav badge poll on a 60s timer, as above. A stale count beats a banner nobody asked for.',
  'src/components/AppLayout.tsx\t/notifications/unread-count':
    'Nav badge poll on a 60s timer, as above. A stale count beats a banner nobody asked for.',
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
  'src/pages/PartnerPortalPage.tsx\t/partners/mine':
    'Branding only. The heading falls back to "Your portfolio", which is true of every partner and claims nothing.',
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

/** Empty body, or one that only substitutes an empty collection or null. */
const SWALLOW = /\.catch\(\(\)\s*=>\s*(?:\{\s*\}|set[A-Za-z0-9_]*\(\s*(?:\[\s*\]|null)\s*\))\s*\)/g;

/** The request a catch belongs to: the nearest path literal before it. */
const REQUEST = /(?:api|fetch)\s*(?:<[^>]*>)?\s*\(\s*[`'"]([^`'"]*)[`'"]/g;

function census(): string[] {
  const found: string[] = [];
  for (const file of walk('src')) {
    if (!/\.tsx?$/.test(file)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(SWALLOW)) {
      const before = source.slice(0, match.index);
      const requests = [...before.matchAll(REQUEST)];
      const path = requests.length ? requests[requests.length - 1]![1] : '(none)';
      found.push(`${file}\t${path}`);
    }
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
    expect(SWALLOW.test(".catch(() => setError('Could not load.'))")).toBe(false);
    SWALLOW.lastIndex = 0;
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
