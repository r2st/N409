import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A control that will not take the press has to say why.
 *
 * Not every disabled button does. Most of them are disabled for a reason the
 * reader is already looking at — a Save that goes grey while it is saving and
 * reads "Saving…", a Next page at the last page, a Send with an empty box
 * above it. Those explain themselves and a tooltip on them would be noise.
 *
 * The ones that do not are the shape this census is for: a button gated on
 * something the reader cannot see from where they are standing. R191 found
 * nine, and every one of them had the same signature — the reason existed,
 * written in a code comment or derived three files away, and reached the
 * screen nowhere:
 *
 *   * Restart, refused on a published engagement.
 *   * Reassign, refused because the picker still names the current reviewer.
 *   * Save this view, refused on an empty filter set (the *comment* said so).
 *   * Add an adjustment, refused at a cap of ten that nothing mentioned.
 *   * Render PDF, refused while the body has unsaved edits.
 *   * A trace step with no payload, which just looked broken.
 *   * Advance to next stage, at the last stage.
 *   * Connect, for a provider with no credentials on this deployment.
 *   * Apply, on the bulk bar, when the reviewer roster failed to load — the
 *     worst of them, because the action it refuses is the one that would
 *     otherwise have unassigned every selected engagement.
 *
 * So the rule, and it is a rule about *which* condition rather than about
 * disabled buttons in general:
 *
 *   A button whose `disabled` expression contains a term that is neither an
 *   in-flight action nor self-evident from the same view must carry a `title`
 *   (or an `aria-describedby`).
 *
 * "Self-evident" is not left to taste. It is the four families in
 * `SELF_EVIDENT` below, matched on the term itself, and a term that is none of
 * them needs the explanation. Nothing here checks that the sentence is *good*
 * — no census can — but a control cannot go back to being silently dead
 * without this failing.
 */

type Tag = 'in-flight' | 'self-evident';

/**
 * Terms naming an action already under way. The label says so — every one of
 * these sits on a button that reads "Saving…", "Running…", "Syncing…" while it
 * is true — so the disabled state is the label's own consequence.
 */
const IN_FLIGHT = [
  /^!?\(?\s*busy\b/,
  /^!?\(?\s*busyId\b/,
  /^!?\(?\s*saving\b/,
  /^!?\(?\s*saveBusy\b/,
  /^!?\(?\s*scenariosBusy\b/,
  /^!?\(?\s*running\b/,
  /^!?\(?\s*loading\b/,
  /^!?\(?\s*pending\b/,
  /^!?\(?\s*submitting\b/,
  /^!?\(?\s*creating\b/,
  /^!?\(?\s*deleting\b/,
  /^!?\(?\s*removing\b/,
  /^!?\(?\s*adding\b/,
  /^!?\(?\s*recording\b/,
  /^!?\(?\s*sending\b/,
  /^!?\(?\s*scanning\b/,
  /^!?\(?\s*checking\b/,
  /^!?\(?\s*applying\b/,
  /^!?\(?\s*appending\b/,
  /^!?\(?\s*exporting\b/,
  /^!?\(?\s*cloning\b/,
  /^!?\(?\s*testing\b/,
  /^!?\(?\s*reverting\b/,
  /^!?\(?\s*refreshing\b/,
  /^!?\(?\s*retrying\b/,
  /^!?\(?\s*queueBusy\b/,
  /^!?\(?\s*queueBusy\b/,
  /^!?\(?\s*agentPhase\b/,
  /^!?\(?\s*state === 'busy'/,
  /^!?\(?\s*download\.\w+/,
];

/**
 * Terms whose answer is on the same screen, a glance away from the button.
 *
 * Four families, and the reason each one qualifies:
 *
 *   - **an empty box in the same form.** `!draft.trim()` sits under the
 *     textarea it is talking about.
 *   - **a pagination edge.** `page <= 1` on a pager that prints the page
 *     number next to itself.
 *   - **nothing to save.** `!dirty` on a form the reader has not touched.
 *   - **an empty selection.** `selected.size === 0` beside the checkboxes
 *     that would fill it.
 */
const SELF_EVIDENT = [
  // An empty text field in the same form.
  /^!?\(?\s*!?[\w.]+\.trim\(\)(\s*===\s*''| \|\| .*)?$/,
  /^!?\(?\s*![\w.]+\.trim\(\)\)?$/,
  /^!?\(?\s*[\w.]+ === ''$/,
  /^!?\(?\s*![\w.]+ \|\| ![\w.]+\.trim\(\)/,
  // Pagination edges.
  /^!?\(?\s*(page|clamped|step) (<=|>=|===|<|>) /,
  /^!?\(?\s*(page|clamped) (<=|>=) (pageCount|totalPages|pages|1|0)$/,
  // Nothing to save.
  /^!?\(?\s*!dirty\)?$/,
  /^!?\(?\s*dirty\.length === 0$/,
  // An empty selection made on this screen.
  /^!?\(?\s*(selected|chosen)\.(size|length) === 0$/,
  /^!?\(?\s*scenarios\.length === 0$/,
  /^!?\(?\s*(email === user\.email)$/,
];

/**
 * Sites gated on something not self-evident that carry no title *by design*,
 * each with the reason. Prose deliberately: an entry nobody can justify is a
 * dead control with a note on it.
 */
const EXPLAINED_ELSEWHERE: Record<string, string> = {
  'components/WorkflowActions.tsx':
    'Advance reads "No next step" when there is none — the label is the explanation. Restart and Reassign carry titles.',
  'components/valuation/FinancialModelPanel.tsx':
    'Blocked on modelProblem(form), which is rendered verbatim in an ErrorNote directly above the button.',
  'components/valuation/OrgAssignmentCard.tsx':
    'Blocked until a portfolio is picked in the select immediately above, whose placeholder is the instruction.',
  'components/valuation/ParamsPanel.tsx':
    'Both blocked states print their own reason underneath — the probability total that does not sum to one, and the scenario problem.',
  'components/valuation/RollforwardPanel.tsx':
    'Run rollforward prints each of its refusals as a paragraph beneath it (no valuation date, no candidates, candidates failed to load). The adjustment cap was the one that did not, and now carries a title.',
  'components/valuation/VolatilityPanel.tsx':
    'A peer set with no tickers prints "No included comparable carries a ticker, so there is no price history to measure" directly below.',
  'pages/AdminDataRemediationPage.tsx':
    'Over the cap prints "At most N at a time — each is a full engine run" beside the button.',
  'pages/AdminDocumentsPage.tsx': 'Over the cap prints "At most N at a time." beside the button.',
  'pages/BotPromptsPage.tsx':
    'The label itself becomes "Save before testing" while the prompt is dirty, which is the explanation.',
  'pages/InboxPage.tsx': 'Mark all read is blocked when the unread total printed beside it is zero.',
  'pages/valuation/CapTableTab.tsx':
    'Both are blocked until something has been pasted, uploaded or selected in the same panel.',
  'pages/valuation/EngagementTab.tsx':
    'Go is blocked until a stage is chosen in the "Jump to stage…" select immediately to its left. Advance carries a title.',
  'pages/valuation/HealthTab.tsx':
    'The gate banner directly above says health checks open once the first calculation succeeds.',
  'pages/valuation/QaTab.tsx':
    'The gate banner directly above says QA opens once the first calculation succeeds.',
  'pages/valuation/ResearchTab.tsx': 'Blocked until the subject box in the same row holds two characters.',
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

/**
 * Opening tags for `<button>` / `<Button>`, brace-balanced.
 *
 * A regex to the closing `>` is wrong here for the same reason it is wrong in
 * the route census: `disabled={a || (b ? '>' : c)}` closes the tag early and
 * the rest of the attributes — the `title` among them — fall outside the
 * match, which is exactly the direction that reads as a violation when there
 * is none. So the scan tracks brace depth and string literals instead.
 */
function buttonTags(text: string): Array<{ body: string; line: number }> {
  const out: Array<{ body: string; line: number }> = [];
  for (const m of text.matchAll(/<(button|Button)(?=[\s/>])/g)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let inString: string | null = null;
    while (i < text.length) {
      const c = text[i]!;
      if (inString) {
        if (c === inString && text[i - 1] !== '\\') inString = null;
      } else if (c === '"' || c === "'" || c === '`') {
        inString = c;
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
      } else if (c === '>' && depth === 0) {
        break;
      }
      i += 1;
    }
    out.push({ body: text.slice(m.index, i + 1), line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** The expression inside `disabled={...}`, brace-balanced, or null. */
function disabledExpression(body: string): string | null {
  const at = body.indexOf('disabled={');
  if (at < 0) return null;
  let i = at + 'disabled={'.length;
  let depth = 1;
  while (i < body.length && depth > 0) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') depth -= 1;
    i += 1;
  }
  return body.slice(at + 'disabled={'.length, i - 1);
}

function classify(term: string): Tag | 'needs-explanation' {
  const t = term.trim().replace(/\s+/g, ' ');
  if (IN_FLIGHT.some((re) => re.test(t))) return 'in-flight';
  if (SELF_EVIDENT.some((re) => re.test(t))) return 'self-evident';
  return 'needs-explanation';
}

interface Site {
  file: string;
  line: number;
  terms: string[];
  explained: boolean;
}

const SITES: Site[] = walk(SRC).flatMap((full) => {
  const file = path.relative(SRC, full).split(path.sep).join('/');
  const text = readFileSync(full, 'utf8');
  return buttonTags(text).flatMap((tag) => {
    const expr = disabledExpression(tag.body);
    if (expr === null) return [];
    const terms = expr
      .split('||')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((term) => classify(term) === 'needs-explanation');
    if (terms.length === 0) return [];
    return [
      {
        file,
        line: tag.line,
        terms,
        explained: /\btitle=/.test(tag.body) || /\baria-describedby=/.test(tag.body),
      },
    ];
  });
});

describe('a control that will not take the press says why', () => {
  it('finds disabled buttons to check at all', () => {
    // Guards the guard: a scanner that stopped matching would pass this file
    // silently, which is the shape `vacuousChecks` exists to catch.
    expect(SITES.length).toBeGreaterThan(20);
  });

  it('explains every button gated on something the reader cannot see', () => {
    const silent = SITES.filter((s) => !s.explained && !(s.file in EXPLAINED_ELSEWHERE)).map(
      (s) => `${s.file}:${s.line} — disabled on [${s.terms.join(' | ')}] with no title`,
    );
    expect(
      silent,
      'add a title saying why, or register the file in EXPLAINED_ELSEWHERE with the reason',
    ).toEqual([]);
  });

  it('carries no register entry for a file that no longer has a silent control', () => {
    // The list shrinks as titles are added. An entry that outlives its site is
    // a standing permission nobody re-examined.
    const withSilent = new Set(SITES.filter((s) => !s.explained).map((s) => s.file));
    const stale = Object.keys(EXPLAINED_ELSEWHERE).filter((file) => !withSilent.has(file));
    expect(stale, 'these files no longer have an unexplained disabled control; drop their entries').toEqual(
      [],
    );
  });

  it('states a reason for every registered exception', () => {
    const empty = Object.entries(EXPLAINED_ELSEWHERE)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([file]) => file);
    expect(empty, 'an exception nobody can justify is a dead control with a note on it').toEqual([]);
  });

  it('keeps the nine R191 fixed the way they were fixed', () => {
    // Named so a later edit that drops one of these titles fails here rather
    // than quietly restoring a dead control — the register above would not
    // catch it, because the file would simply gain an entry.
    const fixed = [
      'components/WorkflowActions.tsx',
      'components/SavedViews.tsx',
      'components/valuation/RollforwardPanel.tsx',
      'components/valuation/CalculationInspector.tsx',
      'components/valuation/CapTableSyncPanel.tsx',
      'components/valuation/HrisSyncPanel.tsx',
      'pages/valuation/ReportTab.tsx',
      'pages/valuation/EngagementTab.tsx',
      'pages/ValuationsPage.tsx',
    ];
    for (const file of fixed) {
      const text = readFileSync(path.join(SRC, file), 'utf8');
      expect(/\btitle=/.test(text), `${file} lost the title R191 put on its disabled control`).toBe(true);
    }
  });
});
