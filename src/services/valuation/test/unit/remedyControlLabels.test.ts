import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_PANELS, connectorPanelPath } from '../../src/domain/connectorRefusal.js';
import { RESTART_TAB, integrationCallbackRefusal } from '../../src/domain/oauthCallbackRefusal.js';

/**
 * A remedy that names a control is held to the words actually on it (R374, M19).
 *
 * R262 stated the rule — before shipping a remedy, find the control it names —
 * and R357 found two more violations of it by reading. Both rounds recorded the
 * same gap: nothing enforces it, because the remedies live in this service and
 * the labels live in `web-frontend`, two packages with no import path between
 * them. So the rule decayed exactly the way an unenforced rule does, into
 * paraphrase:
 *
 *   * `adminUsers` refused a self-targeted session revoke with "Use Settings →
 *     sign out everywhere", and the button is labelled "Sign out everywhere
 *     else", inside the card headed "Sessions".
 *   * all three `CONNECTOR_PANELS` entries named a tab and a panel that read
 *     close to the screen and matched neither: "Cap table" for the tab "Cap
 *     Table", "Sync" for the heading "Live sync", "HRIS sync" for
 *     "HRIS / payroll sync", "Accounting" for "Accounting integrations".
 *
 * A paraphrase is not a small error here, because of how the sentence is used.
 * The reader has been handed a phrase and is looking at a screen; what they do
 * with the phrase is *search the page for it*. A near miss fails that search as
 * completely as a wrong one, and what they conclude is that the control is not
 * there.
 *
 * There is no import path, but there is a filesystem. This reads the frontend's
 * sources as text — which is all a census needs, and which is what makes the
 * check survive the packages staying independent.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SRC = path.resolve(HERE, '../../src');
const FRONTEND_SRC = path.resolve(HERE, '../../../web-frontend/src');
const WORKSPACE = path.join(FRONTEND_SRC, 'pages/valuation/ValuationWorkspace.tsx');

function sourceFiles(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full, pattern);
    return pattern.test(full) ? [full] : [];
  });
}

const frontend = sourceFiles(FRONTEND_SRC, /\.tsx?$/).map((file) => ({
  rel: path.relative(FRONTEND_SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

const serviceText = sourceFiles(SERVICE_SRC, /\.ts$/)
  .map((file) => ({
    rel: path.relative(SERVICE_SRC, file).split(path.sep).join('/'),
    // Comments stripped: this file's own subject is a phrase, and the prose
    // that explains a fixed phrase quotes the broken one.
    text: readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  }))
  .filter(({ rel }) => rel !== 'domain/connectorRefusal.ts' || true);

/**
 * Where the frontend renders a given piece of visible text, if anywhere.
 *
 * The label has to be the *whole* of something — element text (`>Live sync<`)
 * or a complete string literal / attribute value (`title="Sessions"`,
 * `'Sign out everywhere else'`). A bare `includes` would have passed the very
 * paraphrases this file exists to stop: "Sync" occurs in a hundred places, and
 * "Cap table" occurs in a dozen, none of which is the control.
 */
const rendersText = (label: string): string[] =>
  frontend
    .filter(({ text }) => text.includes(`>${label}<`) || text.includes(`"${label}"`) || text.includes(`'${label}'`))
    .map(({ rel }) => rel);

describe('a remedy names a control by the words on it', () => {
  it('reads both packages', () => {
    // A census that found no frontend passes every assertion under it.
    expect(frontend.length).toBeGreaterThan(50);
    expect(readFileSync(WORKSPACE, 'utf8')).toContain('<Tab to=');
  });

  it('names every connector panel’s tab exactly as the tab is labelled', () => {
    const workspace = readFileSync(WORKSPACE, 'utf8');
    const findings = Object.entries(CONNECTOR_PANELS)
      .filter(([, panel]) => !workspace.includes(`label="${panel.tab}"`))
      .map(([family, panel]) => `${family} → tab "${panel.tab}"`);
    expect(findings, 'connector remedies naming a tab that is labelled otherwise').toEqual([]);
  });

  it('names every connector panel’s heading exactly as the heading reads', () => {
    const findings = Object.entries(CONNECTOR_PANELS)
      .filter(([, panel]) => rendersText(panel.panel).length === 0)
      .map(([family, panel]) => `${family} → panel "${panel.panel}"`);
    expect(findings, 'connector remedies naming a panel heading the frontend does not draw').toEqual([]);
  });

  it('composes the remedy phrase from the two halves it checked', () => {
    expect(connectorPanelPath(CONNECTOR_PANELS.capTable)).toBe('Cap Table → Live sync');
  });

  /**
   * The third table that names a tab, and the one this census did not read when
   * it was written: the sentence a browser is shown when an integration
   * callback cannot be matched to the request that started it. It said "the Cap
   * table tab" against the tab labelled "Cap Table" — the same paraphrase R374
   * removed from `CONNECTOR_PANELS`, surviving one file over because nothing
   * looked here.
   */
  it('names every callback restart tab exactly as the tab is labelled', () => {
    const workspace = readFileSync(WORKSPACE, 'utf8');
    const findings = Object.entries(RESTART_TAB)
      .filter(([, tab]) => !workspace.includes(`label="${tab}"`))
      .map(([kind, tab]) => `${kind} → tab "${tab}"`);
    expect(findings, 'callback remedies naming a tab that is labelled otherwise').toEqual([]);
  });

  it('puts the checked tab name into the sentence a reader is shown', () => {
    // The name has to reach the prose, or the assertion above is checking a
    // constant nothing renders.
    for (const [kind, tab] of Object.entries(RESTART_TAB)) {
      expect(integrationCallbackRefusal(kind as keyof typeof RESTART_TAB)).toContain(
        `the ${tab} tab`,
      );
    }
  });

  /**
   * The other family of remedies that names a control: the ones that route a
   * reader into Settings. Enumerated rather than parsed, because the label ends
   * where the sentence resumes ("Settings → API tokens for a personal key") and
   * no boundary rule reads that reliably. What the scan below enforces is that
   * the enumeration stays complete — a new `Settings → …` remedy fails here
   * until its control is listed, and listing it fails unless the frontend draws
   * that exact text.
   */
  const SETTINGS_CONTROLS = ['API tokens', 'Sessions → “Sign out everywhere else”'];

  it('draws every Settings control a remedy sends a reader to', () => {
    const findings = SETTINGS_CONTROLS.flatMap((control) =>
      control
        .split(' → ')
        .map((part) => part.replace(/[“”]/g, ''))
        .filter((part) => rendersText(part).length === 0)
        .map((part) => `${control} → "${part}"`),
    );
    expect(findings, 'Settings remedies naming text the frontend does not draw').toEqual([]);
  });

  it('has a listed control behind every Settings remedy in this service', () => {
    const findings: string[] = [];
    for (const { rel, text } of serviceText) {
      for (const m of text.matchAll(/Settings → /g)) {
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
        if (!SETTINGS_CONTROLS.some((control) => after.startsWith(control))) {
          findings.push(`${rel} → "Settings → ${after.split(/[\n'`]/)[0]!.trim()}"`);
        }
      }
    }
    expect(findings, 'Settings remedies naming an unlisted control').toEqual([]);
  });

  /**
   * And the population, so neither Settings assertion can pass by the remedies
   * having been deleted.
   */
  it('still has the Settings remedies it is auditing', () => {
    const total = serviceText.reduce((n, { text }) => n + [...text.matchAll(/Settings → /g)].length, 0);
    expect(total).toBeGreaterThanOrEqual(5);
  });
});
