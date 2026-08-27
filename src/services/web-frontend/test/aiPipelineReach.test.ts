/**
 * Every agent the server can run has a control in the browser that runs it.
 *
 * Four agents are why this exists. `cap_table`, `assumptions`, `audit_defense`
 * and `roll_forward` each have a Python agent, a prompt-registry row, a place
 * in the dependency sets that auto-attach documents or a calculation, and a
 * route that will happily run them — and until R178 no screen in the product
 * offered any of them. Nothing was broken. Four finished features were simply
 * unreachable, which is the failure this file is shaped to catch, because it is
 * invisible to every test that asks whether a thing works: each of them had
 * passing unit tests on the day it shipped with no way to press it.
 *
 * WHAT COUNTS AS REACHABLE. Not "the name appears somewhere" — `cap_table` is
 * also a document kind and a task kind, and `assumptions` is a word the report
 * uses constantly, so a name-mention check would have scored two of the four
 * unreachable agents as fine. Reachability is a call the client can actually
 * make:
 *
 *   * membership of `AI_PIPELINES`, which the AI tab turns into `POST
 *     /valuations/:id/ai/${pipeline}` for every entry; or
 *   * an explicit `/ai/<name>` path written somewhere in the client, which is
 *     how the agents that live beside their own data are launched; or
 *   * a dedicated route that runs the agent without naming it, which is a
 *     server fact and so is declared below with the route it hides behind.
 *
 * Deliberate break: drop any of the four from `AI_PIPELINES` and this fails,
 * naming it. Rename `/report/narrative` on the Report tab and the third rule
 * fails rather than silently exempting an agent nothing can reach.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_PIPELINES } from '../src/lib/pipeline';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const SERVER_PIPELINE = path.resolve(HERE, '../../valuation/src/domain/pipeline.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const CLIENT = walk(SRC)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

const SERVER = readFileSync(SERVER_PIPELINE, 'utf8');

/** The `'…'` members of a named `as const` array or `new Set([…])` literal. */
function members(source: string, name: string): string[] {
  const start = source.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`${name} not found — did domain/pipeline.ts move?`);
  const open = source.indexOf('[', start);
  const close = source.indexOf(']', open);
  if (open === -1 || close === -1) throw new Error(`${name} is not an array literal`);
  return [...source.slice(open, close).matchAll(/'([a-z_]+)'/gu)].map((m) => m[1] as string);
}

const ALL = members(SERVER, 'AI_PIPELINES');
const NON_RUNNABLE = new Set(members(SERVER, 'NON_RUNNABLE_PIPELINES'));

/**
 * Agents a dedicated route runs without the client ever naming the pipeline,
 * mapped to the path the client has to call to get there. Both halves are
 * asserted: the route must still exist server-side, and the client must still
 * call it. An exemption that stops being true stops being an exemption.
 */
const ROUTED_ELSEWHERE: Record<string, { clientPath: string; serverFile: string }> = {
  // The QA gate's deterministic checks and its gate-visible review row ride
  // along with the AI reviewer, so it is never run through the generic route.
  qa: { clientPath: '/qa', serverFile: 'qa.ts' },
  // The Report tab redrafts the narrative; `reuse` decides whether a fresh run
  // happens, and either way the pipeline name stays on the server.
  report_narrative: { clientPath: '/report/narrative', serverFile: 'reports.ts' },
};

/** `/ai/<name>` written out in the client — how the apply-route agents launch. */
const EXPLICIT_AI_PATHS = new Set([...CLIENT.matchAll(/\/ai\/([a-z_]+)/gu)].map((m) => m[1] as string));

describe('every runnable AI pipeline is reachable from the browser', () => {
  it('parses the server registry rather than trusting a copy of it', () => {
    // A regex that quietly stopped matching would turn this file into a test
    // that two empty sets are equal.
    expect(ALL.length).toBeGreaterThan(10);
    expect(ALL).toContain('audit_defense');
    expect(NON_RUNNABLE.size).toBeGreaterThan(0);
    expect(NON_RUNNABLE.has('market_research')).toBe(true);
    expect(EXPLICIT_AI_PATHS.has('tagging')).toBe(true);
  });

  it('names no runnable agent the product cannot launch', () => {
    const inAiTab = new Set<string>(AI_PIPELINES);
    const unreachable = ALL.filter(
      (p) => !NON_RUNNABLE.has(p) && !(p in ROUTED_ELSEWHERE) && !inAiTab.has(p) && !EXPLICIT_AI_PATHS.has(p),
    );
    expect(
      unreachable,
      `These agents are fully built server-side and cannot be run from the UI: ${unreachable.join(', ')}. ` +
        'Give each one a control — add it to AI_PIPELINES in lib/pipeline.ts, or call /ai/<name> from ' +
        'the tab whose data it fills.',
    ).toEqual([]);
  });

  it('keeps each dedicated-route exemption anchored to a route that still exists', () => {
    for (const [pipeline, { clientPath, serverFile }] of Object.entries(ROUTED_ELSEWHERE)) {
      const server = readFileSync(path.resolve(HERE, `../../valuation/src/routes/${serverFile}`), 'utf8');
      expect(server, `${serverFile} no longer runs ${pipeline}`).toContain(pipeline);
      expect(CLIENT, `nothing in the client calls ${clientPath} for ${pipeline}`).toContain(clientPath);
    }
  });

  it('offers a label and a description for every agent on the AI tab', () => {
    // A pipeline added to the array and not to the meta map renders as an empty
    // card — the control exists, and says nothing about what pressing it does.
    for (const pipeline of AI_PIPELINES) {
      const meta = readFileSync(path.join(SRC, 'lib/pipeline.ts'), 'utf8');
      expect(meta).toMatch(new RegExp(`\\b${pipeline}:\\s*\\{`, 'u'));
    }
  });
});
