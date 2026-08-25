/**
 * The company name on the way to a filesystem.
 *
 * Two of the three download buttons that name their own file build that name
 * out of `valuation.company_name`, and the class they filtered it through was
 * `[^\w.-]`. `\w` is ASCII no matter what flags a regex carries, so that class
 * treated every letter outside `A-Za-z0-9_` as punctuation to be collapsed:
 * "Ångström Robotics" reached disk as `_ngstr_m_Robotics`, and a name written
 * in a non-Latin script reached it as a row of underscores.
 *
 * The behaviour tests below pin what survives now. The census exists because
 * the third copy of that regex was written inline at a call site rather than
 * imported, so fixing the shared helper fixed two sites out of three and the
 * grep is the only thing that says which.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filenameStem } from '../src/lib/useDownload';

describe('filenameStem', () => {
  it('keeps letters ASCII cannot spell', () => {
    expect(filenameStem('Ångström Robotics')).toBe('Ångström_Robotics');
  });

  it('keeps a name with no Latin letters in it at all', () => {
    expect(filenameStem('資本政策 株式会社')).toBe('資本政策_株式会社');
  });

  it('keeps the ring on a decomposed Å rather than half the letter', () => {
    // NFD: 'A' + U+030A COMBINING RING ABOVE. Without \p{M} the mark is
    // punctuation and the name silently becomes "Angstrom".
    const decomposed = 'Ångström'.normalize('NFD');
    expect(filenameStem(decomposed).normalize('NFC')).toBe('Ångström');
  });

  it('still collapses the punctuation it was there to collapse', () => {
    expect(filenameStem('Acme, Inc. (Delaware)')).toBe('Acme_Inc._Delaware_');
  });

  it('leaves no path separator behind', () => {
    expect(filenameStem('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(filenameStem('a\\b')).toBe('a_b');
  });

  it('does not let a name reach disk as a bare dot-segment', () => {
    // Collapsed to `_..`, not `..` — the separator becomes a character rather
    // than disappearing, so the result cannot be read as a parent directory.
    expect(filenameStem('/..')).toBe('_..');
  });

  it('keeps digits and the characters a filename legitimately uses', () => {
    expect(filenameStem('Acme-2026_v3.1')).toBe('Acme-2026_v3.1');
  });
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * Any character class that excludes `\w` — the mangle, however it is spelled.
 * Matching the idiom rather than the exact literal, so a copy that adds a space
 * or reorders `.-` is still caught.
 */
const ASCII_WORD_CLASS = /\[\^[^\]]*\\w[^\]]*\]/;

describe('nobody re-implements the ASCII mangle', () => {
  it('is looking at a source tree', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('has one filename filter, and it is the Unicode one', () => {
    const copies = FILES.filter(({ text }) => ASCII_WORD_CLASS.test(text)).map(({ file }) => file);
    expect(copies).toEqual([]);
  });

  it('has every company-name filename go through the helper', () => {
    const inlined = FILES.filter(
      ({ text, file }) =>
        file !== 'lib/useDownload.ts' && /company_name\s*\.replace\(/.test(text.replace(/\s+/g, ' ')),
    ).map(({ file }) => file);
    expect(inlined).toEqual([]);
  });
});
