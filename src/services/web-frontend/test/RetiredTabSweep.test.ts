import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every workspace tab that can write must know the engagement can be retired.
 *
 * The render tests next door drive seventeen tabs and pin one control on each.
 * They cannot say anything about the eighteenth. This is the "account for every
 * X" half: it reads the sources, works out which tabs write, and fails if one
 * of them has no idea a withdrawn engagement exists — including a tab written
 * next year by somebody who never read the banner's comment.
 *
 * WHY A SOURCE SCAN, given R89's warning about them. The trap there was a scan
 * that passed by finding nothing to ask about — a nested-route parser that
 * matched no routes and reported every route guarded. So the vacuity guards at
 * the bottom of this file are not decoration: they pin the size of the set, and
 * they pin that a tab known to be read-only is *not* in it. A change that makes
 * the classifier blind fails those two before it can pass the rest.
 */

const here = dirname(fileURLToPath(import.meta.url));
const TAB_DIR = join(here, '../src/pages/valuation');
const PANEL_DIR = join(here, '../src/components/valuation');

/**
 * Comments are stripped before anything is looked for. Half of these files
 * discuss retirement at length in prose; a tab that only *mentions* it has not
 * closed anything.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const WRITE_METHOD = /method:\s*'(POST|PUT|PATCH|DELETE)'/;

const tabFiles = readdirSync(TAB_DIR).filter((f) => f.endsWith('.tsx'));
const panelFiles = readdirSync(PANEL_DIR).filter((f) => f.endsWith('.tsx'));

/** Panels that issue a write of their own, by name (`ParamsPanel`, …). */
const writingPanels = new Set(
  panelFiles.filter((f) => WRITE_METHOD.test(code(join(PANEL_DIR, f)))).map((f) => f.replace(/\.tsx$/, '')),
);

interface TabFacts {
  file: string;
  writes: boolean;
  knowsRetired: boolean;
  mountedWritingPanels: string[];
}

const facts: TabFacts[] = tabFiles.map((file) => {
  const src = code(join(TAB_DIR, file));
  const mounted = [...writingPanels].filter((p) => new RegExp(`<${p}[\\s/>]`).test(src));
  return {
    file,
    writes: WRITE_METHOD.test(src) || mounted.length > 0,
    // Not "the word appears": it has to be pulled off the workspace context or
    // handed in as a prop, which is the only way a tab can have it at all.
    knowsRetired: /\bretired\b\s*[,}]/.test(src) || /\bretired[:=]/.test(src),
    mountedWritingPanels: mounted,
  };
});

describe('the workspace tabs and a retired engagement', () => {
  const writing = facts.filter((f) => f.writes);

  it('has no tab that writes without knowing the engagement can be retired', () => {
    const blind = writing.filter((f) => !f.knowsRetired).map((f) => f.file);
    expect(blind).toEqual([]);
  });

  it('counts the writing tabs, so a classifier that goes blind fails here first', () => {
    // R91 closed seventeen tabs plus the six pipeline adapters (one file each
    // since R161). The floor is
    // deliberately below that: a tab that is deleted should not fail this, and
    // a classifier that stops matching anything should.
    expect(writing.length).toBeGreaterThanOrEqual(17);
  });

  it('does not classify a read-only tab as writing — the other half of the guard', () => {
    // Analytics and the audit trail render what happened. If the classifier
    // starts calling these writers it is matching something it should not, and
    // the assertion above has stopped meaning anything.
    const readOnly = facts.filter((f) => ['AnalyticsTab.tsx', 'AuditTrailTab.tsx'].includes(f.file));
    expect(readOnly).toHaveLength(2);
    expect(readOnly.filter((f) => f.writes)).toEqual([]);
  });

  it('found the write-capable panels it screens tabs against', () => {
    // The panel list is derived, not written down, so this is the assertion
    // that it derived something. `ParamsPanel` is the one a tab mounting it
    // must gate; if the set is empty the mount check above is inert.
    expect(writingPanels.size).toBeGreaterThanOrEqual(10);
    expect(writingPanels.has('ParamsPanel')).toBe(true);
    expect(writingPanels.has('RollforwardPanel')).toBe(true);
  });

  it('screens the tabs that only write through a mounted panel', () => {
    // BridgeTab has no `method:` of its own — it writes because it mounts the
    // roll-forward panel. It is the case the `method:` scan alone would miss,
    // so its presence here is what proves the mount check is doing work.
    const bridge = facts.find((f) => f.file === 'BridgeTab.tsx')!;
    expect(bridge.mountedWritingPanels).toContain('RollforwardPanel');
    expect(bridge.knowsRetired).toBe(true);
  });
});
