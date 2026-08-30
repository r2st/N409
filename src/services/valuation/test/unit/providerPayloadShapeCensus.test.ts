import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * No integration client walks a provider's collection without checking it is
 * one.
 *
 * `readJson` refuses a body that is not an object, and each of these clients
 * then reads two or three levels below that with a compile-time cast. The cast
 * has no runtime force, so `{"securities": {…}}` and `{"securities": [null]}`
 * both leave the mapper as a bare `TypeError` — and every one of these clients
 * is called from a route that catches, runs the error through
 * `describeTransportFailure`, and writes the result to the connection's
 * `last_error`. That column is served to the analyst verbatim and is
 * documented as carrying only text we wrote; what it carried was V8's wording,
 * under a connection that reads as a network problem.
 *
 * The gap was found and closed one client at a time — HRIS at round 201, the
 * cap-table sync and the four accounting parsers at round 235 — which is
 * exactly the shape a census exists to stop recurring. Each client now has its
 * own guard (`records`, `rowsOf`, `asRows`), and this holds all three to
 * having one and to using it.
 *
 * Two assertions rather than one, because the interesting failure is the
 * vacuous pass. A scan that reads no files, or reads files that no longer map
 * a provider payload, finds nothing and reports success — so the population is
 * asserted first, by name, before anything is asserted about it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS = path.resolve(HERE, '../../src/clients');

/**
 * The guard each client declares for "a list of rows out of provider JSON".
 *
 * Matched as an identifier rather than as `name(`: `asRows` carries an explicit
 * type argument at every call site (`asRows<QboRow>(rows)`), so the paren is one
 * character further along than the obvious spelling expects, and a census that
 * looked for it found nothing in the very file this round hardened.
 */
const LIST_GUARDS = ['records', 'rowsOf', 'asRows'];

/**
 * `for (… of <expr> ?? [])` — the idiom this closed.
 *
 * `?? []` reads as a guard and is not one: it answers the *absent* collection
 * and passes a present-but-wrong one straight to the iterator. Matched on the
 * `of` so that a `??` default anywhere else in these files is untouched.
 */
const UNGUARDED_ITERATION = /\bfor\s*\(\s*(?:const|let|var)\s+[^)]*?\sof\s+[^)]*\?\?\s*\[\]/g;

/** A client that maps a third-party payload, as opposed to one that fetches. */
const PAYLOAD_MAPPERS = ['accounting.ts', 'capTableSync.ts', 'hris.ts'];

describe('provider payload shape census', () => {
  const files = sourceFiles(CLIENTS).map((file) => ({
    name: path.basename(file),
    source: readFileSync(file, 'utf8'),
  }));

  it('reads the clients that map a provider payload', () => {
    const names = files.map((f) => f.name);
    for (const mapper of PAYLOAD_MAPPERS) expect(names).toContain(mapper);
  });

  it('gives each of them a guard for a list that may not be one', () => {
    for (const name of PAYLOAD_MAPPERS) {
      const file = files.find((f) => f.name === name)!;
      expect(
        LIST_GUARDS.some((guard) => new RegExp(`\\b${guard}\\b`).test(file.source)),
        `${name} maps a provider payload and declares no list guard (${LIST_GUARDS.join(' / ')})`,
      ).toBe(true);
    }
  });

  it('iterates no provider collection through a bare "?? []"', () => {
    const offenders = files.flatMap((f) =>
      [...f.source.matchAll(UNGUARDED_ITERATION)].map((m) => `${f.name}: ${m[0].trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
