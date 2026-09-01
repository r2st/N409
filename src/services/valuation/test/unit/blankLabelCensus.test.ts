import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';
import { nonBlankText } from '../../src/domain/nonBlankText.js';

/**
 * A required name, and what "required" was taken to mean.
 *
 * `domain/nonBlankText.ts` was written for the signature block — a
 * `signer_name` of two spaces passed the publish gate and printed `/s/` with
 * nothing after it on the certification page — and applied to the five fields
 * that round was about. Every other required label in the service kept
 * `z.string().min(1)`, which counts characters, and one space is one of them.
 *
 * That is not the same bug five times over; it is the same bug wherever the
 * value is the row's only handle. A task titled `'   '` is a blank line in the
 * task list with a due date beside it. An API token named `'   '` is a row in
 * the revoke table nobody can tell from the other one. A published blog post
 * titled `'   '` goes out on the marketing site under no title at all. And
 * `brand_name` is the case already on the record: two *readers* were written
 * to work around the blank — `publicPartnerName` falls through it and
 * `/branding/tenants` reads `nullif(btrim(brand_name), '')` — while the write
 * kept accepting it and telling the administrator their brand was live.
 *
 * So the rule, over the whole route table: a required field whose name says it
 * labels something is `nonBlankText`, or normalises the blank itself with
 * `.trim()` before its `.min()`, or is named below with what normalises it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

/**
 * Fields that reach a normaliser instead, each with the one that takes them.
 *
 * The test asserts the normaliser's behaviour rather than trusting the note,
 * so an exemption cannot outlive the thing it names.
 */
const NORMALISED_ELSEWHERE: Record<string, string> = {
  'routes/partnerApi.ts:filename':
    'An uploaded name is stored as `safeFilename(name)` (documents/filename.ts), which scrubs it, trims it, and substitutes `upload` when nothing is left — the same normalisation `fileType.ts` checks the extension against. Refusing a blank here would be a second answer to a question one function already owns.',
};

interface Hit {
  where: string;
  key: string;
  text: string;
}

/**
 * A property whose *name* says it labels the row, declared as a required
 * string: `.min(1)` or higher. `.optional()` is not the question — an absent
 * name is a name nobody gave, which is a different thing from a name of three
 * spaces — so an optional field with a `.min()` is still in the population.
 */
const LABEL_KEY = /(?:^|[{,\s])(\w*(?:name|title|label|subject|heading))\s*:\s*(z\.string\(\)[^,]*)/i;

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text) => {
        const trimmed = text.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
        const m = LABEL_KEY.exec(text);
        if (!m) return;
        const chain = m[2]!;
        // Required only. A `z.string().max(200)` with no floor is a field that
        // may be empty by design, and '' and '   ' are the same answer there.
        if (!/\.min\(\s*[1-9]/.test(chain)) return;
        // `.trim()` rewrites the value before the floor is counted, so '   '
        // is already refused. A different choice from nonBlankText's — see the
        // prose there — but it closes this gap.
        if (/\.trim\(\)/.test(chain)) return;
        hits.push({ where: rel, key: m[1]!, text: trimmed });
      });
  }
  return hits;
}

describe('a required label cannot be only whitespace', () => {
  it('has no required label field left on a bare .min()', () => {
    const offenders = scan()
      .filter((h) => !NORMALISED_ELSEWHERE[`${h.where}:${h.key}`])
      .map((h) => `${h.where}  ${h.text}`);
    expect(
      offenders,
      `use nonBlankText() from domain/nonBlankText.js — .min(1) counts characters, and a space is one:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('exempts only fields a normaliser really takes, and finds them', () => {
    const exempt = scan().filter((h) => NORMALISED_ELSEWHERE[`${h.where}:${h.key}`]);
    expect(exempt.map((h) => `${h.where}:${h.key}`)).toEqual(Object.keys(NORMALISED_ELSEWHERE));
  });

  it('proves the one normaliser it excuses, rather than taking the note for it', async () => {
    const { safeFilename } = await import('../../src/documents/filename.js');
    expect(safeFilename('   ')).toBe('upload');
    expect(safeFilename('  cap table.csv  ')).toBe('cap table.csv');
  });

  it('is looking at a population, and at the files the labels are in', () => {
    // The vacuity guard. This scan goes green the moment the `z.string()`
    // spelling moves or the walk stops reaching routes/, and both are shapes a
    // refactor moves.
    const files = sourceFiles(SRC).map((f) => path.relative(SRC, f).split(path.sep).join('/'));
    expect(files).toContain('routes/tasks.ts');
    expect(files).toContain('routes/blog.ts');
    // What says the matcher still fires: the labels that already carry the
    // rule. If the `z.string()` chain stops being recognisable, this empties
    // out before the offenders list does.
    let bounded = 0;
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line) => {
          if (LABEL_KEY.test(line) && /nonBlankText\(|\.trim\(\)/.test(line)) bounded++;
        });
    }
    expect(bounded).toBeGreaterThan(15);
  });

  it('refuses what it says it refuses', () => {
    const label = nonBlankText(1, 300);
    expect(label.safeParse('   ').success).toBe(false);
    expect(label.safeParse('\t\n ').success).toBe(false);
    expect(label.safeParse('Q3 board pack').success).toBe(true);
    // Trim-checked, not trimmed: what was typed is what is stored.
    expect(label.parse(' Q3 ')).toBe(' Q3 ');
  });
});
