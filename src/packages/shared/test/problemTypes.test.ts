// The problem `type` vocabulary is a published contract, so it is checked
// against the code rather than trusted to review.
//
// `type` is the only field of an RFC 9457 body a client may branch on — `title`
// is a constant and `detail` is prose that moves between releases. That makes
// the set of types an API surface in its own right, and it was documented
// nowhere: twenty-three of them were scattered across ten files as bare string
// literals, and the sole mention in api-design.md described the envelope shape.
// An integrator reading the docs could not discover that
// `urn:n409:problem:plan-limit` exists, let alone that it arrives as a 409.
//
// Same enforcement shape as `.env.example` being the deployment contract: the
// table in docs/api-design.md §1.1 is the source a client reads, and this test
// is what stops it drifting from the source a client actually hits.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const DOC = 'docs/api-design.md';

const TYPE_PATTERN = /urn:n409:problem:[a-z0-9-]+/g;

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

/** Every problem type the services can actually emit, to the file that emits it. */
function raised(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of [
    ...sourceFiles(path.join(repoRoot, 'src/services')),
    ...sourceFiles(path.join(repoRoot, 'src/packages')),
  ]) {
    const rel = path.relative(repoRoot, file);
    for (const m of readFileSync(file, 'utf8').matchAll(TYPE_PATTERN)) {
      const at = found.get(m[0]) ?? [];
      if (!at.includes(rel)) at.push(rel);
      found.set(m[0], at);
    }
  }
  return found;
}

/** Every problem type with a row in the §1.1 table. */
function documented(): Set<string> {
  const text = readFileSync(path.join(repoRoot, DOC), 'utf8');
  return new Set([...text.matchAll(new RegExp('`(' + TYPE_PATTERN.source + ')`', 'g'))].map((m) => m[1]!));
}

describe('the problem-type table is the client contract', () => {
  it('documents every type the services can raise', () => {
    const have = documented();
    const missing = [...raised().entries()].filter(([type]) => !have.has(type));

    expect(
      missing.map(([type, files]) => `${type} (raised in ${files[0]})`),
      `problem types raised by the services but absent from ${DOC} §1.1`,
    ).toEqual([]);
  });

  it('documents nothing the services can no longer raise', () => {
    // The direction an integrator pays for: a row left behind after the code
    // that raised it went away is an instruction to handle an error that can
    // never arrive, and the handler for it is never exercised.
    const canRaise = new Set(raised().keys());
    const stale = [...documented()].filter((type) => !canRaise.has(type));

    expect(stale, `problem types documented in ${DOC} §1.1 that no code raises`).toEqual([]);
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
    expect(documented().size).toBe(types.size);
  });

  it('gives every documented type a status column', () => {
    // A row with no status tells a client the name and nothing it can act on.
    const text = readFileSync(path.join(repoRoot, DOC), 'utf8');
    for (const type of documented()) {
      const row = text.split('\n').find((line) => line.includes(`\`${type}\``) && line.startsWith('|'));
      expect(row, `${type} should have a table row`).toBeDefined();
      expect(row, `${type} should name the status it arrives with`).toMatch(/\|\s*\d{3}|\|\s*[45]xx/);
    }
  });
});
