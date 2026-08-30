import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * No integration client takes a provider's text as text without asking whether
 * it can be stored (round 259, methodology M6).
 *
 * `readJson` guarantees an object and nothing about its fields, so every name,
 * handle and date these clients lift out of a payload arrives through a cast.
 * The cast has no runtime force, and what the value reaches is not only a
 * `text` column — three of these paths end in `jsonb`:
 *
 *   - `recordEvent`'s payload for `integration_connected`, written inside
 *     `upsertConnection`'s transaction, so a refused write rolls back a
 *     connection whose one-time OAuth code has already been spent;
 *   - `last_sync_summary` / `last_import_summary`, written *after* the pull has
 *     been applied and outside every catch in the sync, so a refused write
 *     leaves the data written, `next_sync_at` unmoved and no error recorded —
 *     the state that has the sweep re-pulling every fifteen minutes under a
 *     card that reads as healthy; and
 *   - `cap_tables.entries`, where the share class names live.
 *
 * `U+0000` and a lone surrogate are refused by the driver in all three
 * (`domain/nulBytes.ts`), and the hook that catches them on the way in guards
 * *request* bodies — which a provider payload is not.
 *
 * Two assertions rather than one, because the interesting failure is the
 * vacuous pass: the population is asserted by name before anything is asserted
 * about it, and the matcher below is the spelling the fix actually uses.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS = path.resolve(HERE, '../../src/clients');

/** A client that lifts identity text out of a third party's payload. */
const TEXT_MAPPERS = ['accounting.ts', 'capTableSync.ts', 'hris.ts'];

/**
 * The guard each of them declares. `storableText` is `hris.ts`'s local alias
 * for the shared one, kept because its call sites read better with it.
 */
const TEXT_GUARDS = ['storableProviderText', 'storableText'];

/**
 * `<field>: (something as string | undefined) ?? null` and its bare sibling —
 * the two spellings this round removed.
 *
 * Matched on the assignment rather than on the cast alone, because a cast that
 * feeds a *number* parser is fine: `toCents` and `parseNumericCell` both answer
 * a non-string with null, and neither puts the original anywhere.
 */
const UNGUARDED_TEXT =
  /^\s*(?:[a-z_]+|out\.[a-z_]+)\s*[:=]\s*\(?[^;\n]*\bas string\b[^;\n]*\)?\s*\?\?[^;\n]*[,;]/gm;

describe('provider text census', () => {
  const files = sourceFiles(CLIENTS).map((file) => ({
    name: path.basename(file),
    source: readFileSync(file, 'utf8'),
  }));

  it('reads the clients that lift text out of a provider payload', () => {
    const names = files.map((f) => f.name);
    for (const mapper of TEXT_MAPPERS) expect(names).toContain(mapper);
  });

  it('gives each of them a guard for text that may not be storable', () => {
    for (const name of TEXT_MAPPERS) {
      const file = files.find((f) => f.name === name)!;
      expect(
        TEXT_GUARDS.some((guard) => new RegExp(`\\b${guard}\\b`).test(file.source)),
        `${name} lifts text out of a provider payload and declares no storable-text guard ` +
          `(${TEXT_GUARDS.join(' / ')})`,
      ).toBe(true);
    }
  });

  it('assigns no provider field straight out of an "as string" cast', () => {
    const offenders = files.flatMap((f) =>
      [...f.source.matchAll(UNGUARDED_TEXT)].map((m) => `${f.name}: ${m[0].trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('would see the casts this round removed', () => {
    // The census's own founding case, so a matcher that stops matching says so
    // rather than reporting a clean estate — the failure `errorBodyDisclosure`
    // was blind to twice.
    const before = [
      '    currency: (fields.Currency as string | undefined) ?? null,',
      '  out.as_of = (fields.ToDate as string | undefined) ?? (fields.FromDate as string | undefined) ?? null;',
    ].join('\n');
    expect([...before.matchAll(UNGUARDED_TEXT)]).toHaveLength(2);
  });
});
