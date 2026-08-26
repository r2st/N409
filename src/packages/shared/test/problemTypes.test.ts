// The problem `type` vocabulary is a published contract, so it is checked
// against the code rather than trusted to review.
//
// `type` is the only field of an RFC 9457 body a client may branch on — `title`
// is a constant and `detail` is prose that moves between releases. That makes
// the set of types an API surface in its own right, and it was documented
// nowhere: twenty-three of them were scattered across ten files as bare string
// literals, and the sole mention in api-design.md described the envelope shape.
// An integrator reading the docs could not discover that
// `urn:n409:problem:plan-limit` exists, let alone that it arrives as a 402.
//
// Same enforcement shape as `.env.example` being the deployment contract: the
// table in docs/api-design.md §1.1 is the source a client reads, and this test
// is what stops it drifting from the source a client actually hits.
//
// Since R163 the direction is inverted. The table used to be the source and the
// code was compared against it, which caught a type with no row and could not
// catch a row that had stopped being true — and one had, for as long as it had
// existed: `plan-limit` was documented as a 409 and has always been raised as a
// 402. The catalog in `src/problemCatalog.ts` is now the source, the table is
// rendered from it, and the three checks below hold the catalog to what the
// services actually raise: the type, the status, and the title.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_CATALOG, describeProblem, renderProblemTable, statusOrder } from '../src/problemCatalog.js';
import { problems } from '../src/problem.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const DOC = 'docs/api-design.md';

const TYPE_PATTERN = /urn:n409:problem:[a-z0-9-]+/g;

/**
 * The catalog is not evidence about itself.
 *
 * Every URN appears in `problemCatalog.ts` by construction, so a scan that
 * included it would report each catalogued type as "raised" and the
 * stale-entry check below would pass by having nothing left to ask — a guard
 * that is green because it is looking at its own answer.
 */
const CATALOG_SOURCE = 'src/packages/shared/src/problemCatalog.ts';

/**
 * Source files that run in a deployed process.
 *
 * Tests are excluded deliberately: a test asserting on a type it invented would
 * otherwise oblige somebody to document a type no route can produce.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.venv', 'test', 'tests', 'mutants'].includes(entry.name)) {
        continue;
      }
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function deployedSources(): string[] {
  return [
    ...sourceFiles(path.join(repoRoot, 'src/services')),
    ...sourceFiles(path.join(repoRoot, 'src/packages')),
  ].filter((file) => path.relative(repoRoot, file) !== CATALOG_SOURCE);
}

/** Every problem type the services can actually emit, to the file that emits it. */
function raised(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of deployedSources()) {
    const rel = path.relative(repoRoot, file);
    for (const m of readFileSync(file, 'utf8').matchAll(TYPE_PATTERN)) {
      const at = found.get(m[0]) ?? [];
      if (!at.includes(rel)) at.push(rel);
      found.set(m[0], at);
    }
  }
  return found;
}

/**
 * Every `new ApiProblem({ … })` in the services that names a problem type, with
 * the status and title the call site gives it.
 *
 * This is the check the old table could not make. A row said which status a
 * type arrives with, and nothing compared that to the constructor — so the
 * documented status of `plan-limit` was wrong for the whole life of the route,
 * and a client that branched on 409 (as the table instructed) handled a status
 * the service has never sent.
 *
 * Matched on the literal object passed to the constructor rather than on the
 * whole file, so a type mentioned in a comment nearby cannot be attributed to
 * it. Call sites that build the argument some other way are simply not seen,
 * which is the safe direction: this check adds evidence, it is not the thing
 * that decides a type exists.
 */
interface RaiseSite {
  type: string;
  status: number;
  title: string;
  file: string;
}

function raiseSites(): RaiseSite[] {
  const sites: RaiseSite[] = [];
  for (const file of deployedSources()) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    for (const m of text.matchAll(/new ApiProblem\(\{([\s\S]*?)\}\)/g)) {
      const body = m[1]!;
      const type = /type:\s*'(urn:n409:problem:[a-z0-9-]+)'/.exec(body)?.[1];
      const status = /status:\s*(\d{3})/.exec(body)?.[1];
      const title = /title:\s*'([^']*)'/.exec(body)?.[1];
      if (type && status && title !== undefined) {
        sites.push({ type, status: Number(status), title, file: rel });
      }
    }
  }
  return sites;
}

describe('the problem catalog is the client contract', () => {
  it('catalogues every type the services can raise', () => {
    const missing = [...raised().entries()].filter(([type]) => !(type in PROBLEM_CATALOG));

    expect(
      missing.map(([type, files]) => `${type} (raised in ${files[0]})`),
      'problem types raised by the services but absent from PROBLEM_CATALOG',
    ).toEqual([]);
  });

  it('catalogues nothing the services can no longer raise', () => {
    // The direction an integrator pays for: an entry left behind after the code
    // that raised it went away is an instruction to handle an error that can
    // never arrive, and the handler for it is never exercised.
    const canRaise = new Set(raised().keys());
    const stale = Object.keys(PROBLEM_CATALOG).filter((type) => !canRaise.has(type));

    expect(stale, 'types in PROBLEM_CATALOG that no deployed code raises').toEqual([]);
  });

  it('finds the types it is supposed to be checking', () => {
    // A regex that silently stopped matching would make both checks above pass
    // by scanning nothing at all.
    const types = raised();
    expect(types.has('urn:n409:problem:not-found')).toBe(true);
    expect(types.has('urn:n409:problem:validation')).toBe(true);
    expect(types.has('urn:n409:problem:rate-limited')).toBe(true);
    // One raised only by a route, so a scan that lost src/services still fails.
    expect(types.has('urn:n409:problem:plan-limit')).toBe(true);
    expect(types.size).toBeGreaterThan(15);
    expect(Object.keys(PROBLEM_CATALOG).length).toBe(types.size);
  });

  it('does not count the catalog as its own evidence', () => {
    // The exclusion above is load-bearing: without it every catalogued type is
    // trivially "raised" and the stale-entry check asks nothing. Proved by
    // showing the scan does not see a file it would otherwise dominate.
    const files = new Set([...raised().values()].flat());
    expect([...files]).not.toContain(CATALOG_SOURCE);
    expect(files.size).toBeGreaterThan(3);
  });
});

describe('every catalogue entry says what to do about it', () => {
  it('carries a summary and a resolution that are not the same sentence', () => {
    for (const [type, entry] of Object.entries(PROBLEM_CATALOG)) {
      expect(entry.summary.length, `${type} summary`).toBeGreaterThan(20);
      // A resolution that restates the diagnosis is the failure mode this field
      // exists to avoid — "the request was rate limited" tells a client nothing
      // it did not already have from the status.
      expect(entry.resolution.length, `${type} resolution`).toBeGreaterThan(40);
      expect(entry.resolution, `${type} resolution restates its summary`).not.toBe(entry.summary);
    }
  });

  it('repeats its own key, so an entry stands alone once served', () => {
    for (const [type, entry] of Object.entries(PROBLEM_CATALOG)) expect(entry.type).toBe(type);
  });

  it('advises a delay only where the response carries one', () => {
    // `after-delay` is a promise about the body: `retry_after_seconds` is set by
    // `ApiProblem.retryAfterSeconds`, and only the limiter and the circuit
    // breaker set it. Telling a client to wait for a field that is not there
    // leaves it waiting a made-up interval.
    const delayed = Object.values(PROBLEM_CATALOG)
      .filter((entry) => entry.retry === 'after-delay')
      .map((entry) => entry.type)
      .sort();
    expect(delayed).toEqual(['urn:n409:problem:rate-limited', 'urn:n409:problem:upstream-degraded']);
    for (const type of delayed) {
      expect(PROBLEM_CATALOG[type]!.resolution).toMatch(/retry_after_seconds|stated number of seconds/);
    }
  });

  it('resolves a received type, and answers a stranger with undefined', () => {
    // The lookup a client makes on the way *in*: it has a `type` off the wire
    // and wants the advice. Undefined for one this build has never heard of is
    // the documented answer, not a failure — a client on an older build will
    // meet types added since, and the instruction for that case is to fall back
    // to the status class. Throwing would turn forward compatibility into a
    // crash on the one path that exists to survive it.
    expect(describeProblem('urn:n409:problem:rate-limited')?.retry).toBe('after-delay');
    expect(describeProblem('urn:n409:problem:invented-later')).toBeUndefined();
    expect(describeProblem(undefined)).toBeUndefined();
    // `about:blank` is what the shared handler falls back to for a status it
    // has no type for, so it reaches this lookup in real traffic.
    expect(describeProblem('about:blank')).toBeUndefined();
  });

  it('reads in status order', () => {
    const order = Object.values(PROBLEM_CATALOG).map((entry) => statusOrder(entry.status));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('the catalogue agrees with the code that raises it', () => {
  it('matches the status and title of every ApiProblem construction', () => {
    const sites = raiseSites();
    // The scan itself has to find something, or the loop below asserts nothing.
    expect(sites.length).toBeGreaterThan(5);
    const disagreements = sites
      .filter((site) => {
        const entry = PROBLEM_CATALOG[site.type];
        return !entry || entry.status !== String(site.status) || entry.title !== site.title;
      })
      .map((site) => `${site.file}: ${site.type} raised as ${site.status} "${site.title}"`);
    expect(disagreements, 'raise sites the catalogue does not describe').toEqual([]);
  });

  it('matches the shared problem factories', () => {
    const built = [
      problems.badRequest(),
      problems.unauthorized(),
      problems.forbidden(),
      problems.notFound(),
      problems.conflict(),
      problems.unprocessable(),
      problems.tooManyRequests(),
      problems.serviceUnavailable(),
    ];
    for (const problem of built) {
      const entry = PROBLEM_CATALOG[problem.type];
      expect(entry, `${problem.type} has no catalogue entry`).toBeDefined();
      expect(entry!.status, `${problem.type} status`).toBe(String(problem.status));
      expect(entry!.title, `${problem.type} title`).toBe(problem.title);
    }
  });

  it('gives a type one title, whichever path renders it', () => {
    // `title` is documented as constant across occurrences, and it was not:
    // `validation` came back as "Unprocessable Entity" from the route helper and
    // "Unprocessable Content" from the fastify fallback for the same `type`, so
    // the one field RFC 9457 asks to be stable depended on which layer failed.
    const source = readFileSync(path.join(repoRoot, 'src/packages/shared/src/problem.ts'), 'utf8');
    const statusTypes = new Map(
      [...source.matchAll(/^\s{2}(\d{3}):\s*'(urn:n409:problem:[a-z0-9-]+)',/gm)].map((m) => [
        Number(m[1]),
        m[2]!,
      ]),
    );
    const phrases = new Map(
      [...source.matchAll(/^\s{2}(\d{3}):\s*'([^']+)',$/gm)]
        .filter((m) => !m[2]!.startsWith('urn:'))
        .map((m) => [Number(m[1]), m[2]!]),
    );
    expect(statusTypes.size).toBeGreaterThan(8);
    expect(phrases.size).toBeGreaterThan(8);
    for (const [status, type] of statusTypes) {
      const entry = PROBLEM_CATALOG[type];
      expect(entry, `${type} (fastify fallback for ${status}) has no catalogue entry`).toBeDefined();
      expect(entry!.status, `${type} status`).toBe(String(status));
      expect(entry!.title, `${type} title from the fastify fallback`).toBe(phrases.get(status));
    }
  });
});

describe('docs/api-design.md §1.1 is a rendering of the catalogue', () => {
  it('contains the rendered table verbatim', () => {
    const text = readFileSync(path.join(repoRoot, DOC), 'utf8');
    expect(
      text.includes(renderProblemTable()),
      `${DOC} §1.1 does not match PROBLEM_CATALOG — regenerate it from renderProblemTable()`,
    ).toBe(true);
  });

  it('has no second table of types alongside the generated one', () => {
    // A hand-written table left above or below the generated one would be the
    // drift this inversion exists to end, and the check above would not see it.
    const text = readFileSync(path.join(repoRoot, DOC), 'utf8');
    const rows = text.split('\n').filter((line) => /^\|\s*`urn:n409:problem:/.test(line));
    expect(rows.length).toBe(Object.keys(PROBLEM_CATALOG).length);
  });
});
