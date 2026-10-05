import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R366 (M8): verify that hot-path DB reads are batched into a single
 * Promise.all rather than awaited sequentially.
 *
 * Each test reads the route source and checks that the named functions appear
 * inside one Promise.all call rather than as separate `await` statements.
 * This is a structural guard — the kind of thing that catches a revert or a
 * refactor that accidentally serializes the queries again.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const AI_ROUTE = path.resolve(here, '../../src/routes/ai.ts');
const EVIDENCE_ROUTE = path.resolve(here, '../../src/routes/evidence.ts');

/**
 * Extracts every `Promise.all([...])` block from the source inside a given
 * function, and returns an array of arrays: each inner array holds the
 * identifiers that appear inside one Promise.all call. Crude but stable
 * against formatting changes.
 */
function promiseAllMembers(source: string, fnName: string): string[][] {
  // Find the function body (starts after the function signature).
  const fnStart = source.indexOf(`function ${fnName}`);
  if (fnStart === -1) return [];

  const result: string[][] = [];
  let pos = fnStart;
  while (true) {
    const idx = source.indexOf('Promise.all([', pos);
    if (idx === -1) break;
    const end = source.indexOf('])', idx);
    if (end === -1) break;
    const block = source.slice(idx, end);
    // Collect identifiers that look like function calls inside the block.
    const calls = [...block.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1]!);
    result.push(calls);
    pos = end + 2;
  }
  return result;
}

describe('runAiPipeline query batching', () => {
  const source = readFileSync(AI_ROUTE, 'utf-8');

  it('runs findParams, listDocuments, findPromptByPipeline and findRedactionIdentity in one Promise.all', () => {
    const batches = promiseAllMembers(source, 'runAiPipeline');
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const firstBatch = batches[0]!;
    for (const fn of ['findParams', 'listDocuments', 'findPromptByPipeline', 'findRedactionIdentity']) {
      expect(firstBatch, `${fn} should be inside the first Promise.all of runAiPipeline`).toContain(fn);
    }
  });

  it('does not await findParams, listDocuments or findRedactionIdentity outside a Promise.all', () => {
    // Extract the function body.
    const fnStart = source.indexOf('function runAiPipeline');
    expect(fnStart).toBeGreaterThan(-1);
    const body = source.slice(fnStart);

    // Lines with a bare `await findParams(` that are NOT inside a Promise.all
    // block — i.e. sequential calls. We check for the pattern on lines that
    // are standalone awaits (not inside an array literal).
    for (const fn of ['findParams', 'listDocuments', 'findRedactionIdentity']) {
      const pattern = new RegExp(`^\\s*(?:const|let|var)\\s+\\w+\\s*=\\s*await\\s+${fn}\\(`, 'm');
      expect(pattern.test(body), `${fn} should not be a standalone sequential await`).toBe(false);
    }
  });
});

describe('evidence bundle query batching', () => {
  const source = readFileSync(EVIDENCE_ROUTE, 'utf-8');

  it('runs all independent queries in a single Promise.all', () => {
    const batches = promiseAllMembers(source, 'registerEvidenceRoutes');
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const mainBatch = batches[0]!;

    const expected = [
      'listEvents',
      'listCalculations',
      'listDocuments',
      'listComments',
      'listSignatures',
      'listAiJobs',
      'findReportByValuation',
      'findUserById',
      'listDecisions',
      'listQaReviews',
      'listScenarios',
      'listMarketResearch',
      'listComparableItems',
      'listCalculationTraces',
      'listWorkbookCells',
    ];
    for (const fn of expected) {
      expect(mainBatch, `${fn} should be in the main Promise.all batch`).toContain(fn);
    }
  });

  it('does not split independent queries across multiple sequential Promise.all batches', () => {
    // Count how many separate `await Promise.all` appear inside the
    // evidence-bundle route handler (the POST handler).
    const handlerStart = source.indexOf("'/api/v1/valuations/:id/evidence-bundle'");
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = source.slice(handlerStart);
    // Find all `await Promise.all([` in the handler up to the response.
    const promiseAlls = [...handler.matchAll(/await Promise\.all\(\[/g)];
    // Should be at most 2: the main batch and the listVersions call (which
    // is not a Promise.all, but a conditional await). Previously there were 3.
    expect(
      promiseAlls.length,
      'evidence bundle should have at most 2 Promise.all batches (was 3 before R366)',
    ).toBeLessThanOrEqual(2);
  });
});
