import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_NOTES } from '../../src/domain/auditTrail.js';

/**
 * Every discriminator a repo writes onto the spine reaches a reader.
 *
 * THE GAP THIS CLOSES (round 389, methodology M4). R384 put
 * `organization_deleted: true` on a `portfolio_membership_changed` payload
 * because the change list it sits beside — `organization_id: 01H… → —` — is
 * character for character the one a person detaching a single engagement
 * produces, and the flag is the only thing that tells the two apart. Nothing
 * read it for three rounds. R387 gave it `EVENT_NOTES` and closed with the
 * honest sentence: "nothing walks the payloads repos actually write looking for
 * the next flag beside `changes`. The census that would find it does not
 * exist." This is it, and walking found four more.
 *
 * WHAT COUNTS AS A DISCRIMINATOR. A payload key whose value the *writer* chose
 * rather than carried: a boolean, or a string literal, or a shorthand of a
 * single-valued union. `document_id`, `size_bytes` and `signer_name` are data
 * about the thing that happened and are not in the census; `reaped: true` is
 * the writer stating a circumstance, and a circumstance stated to nobody is the
 * shape this file exists for. The rule is over the source rather than over
 * rows, for `accountEventPayloadCensus`'s reason: a row only exists once
 * somebody has closed an account, so a test over data passes on a fresh
 * database while the call site is already writing the key.
 *
 * EVERY KEY IS CLASSIFIED, NOT MERELY ALLOWED. A new discriminator fails here
 * until a round says which of three things it is — read as a change, read as a
 * note, or genuinely inert — and that decision is the whole point. `INERT`
 * carries the reason for each, so the next round can disagree with a stated
 * position rather than with an omission.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** The brace-balanced body of the construct opening at `open`. */
function balanced(src: string, open: number, chars: '{}' | '()'): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === chars[0]) depth += 1;
    else if (src[i] === chars[1]) {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** Top-level entries of an object literal body, comments removed. */
function entries(body: string): string[] {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of clean) {
    if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.split(/\s+/).join(' ').trim()).filter(Boolean);
}

/**
 * Every `payload:` literal handed to the valuation spine, and its keys.
 *
 * `(?<![A-Za-z])` because `recordAdminEvent(` contains `recordEvent(`, and the
 * admin spine is a different surface with a different reader. Every `payload:`
 * inside the call, not the first: `recordEvents(client, rows.map(…))` puts one
 * inside a callback, and `deleteOrganization`'s detach — the write that started
 * all of this — is exactly that shape.
 */
function spinePayloads(): Array<{ file: string; key: string; value: string }> {
  const out: Array<{ file: string; key: string; value: string }> = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const call of src.matchAll(/(?<![A-Za-z])recordEvents?\s*\(/g)) {
      const body = balanced(src, call.index! + call[0].length - 1, '()');
      for (const literal of body.matchAll(/payload:\s*\{/g)) {
        for (const entry of entries(balanced(body, literal.index! + literal[0].length - 1, '{}'))) {
          const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(entry);
          if (pair) out.push({ file: path.relative(SRC, file), key: pair[1]!, value: pair[2]! });
          else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry))
            out.push({ file: path.relative(SRC, file), key: entry, value: '(shorthand)' });
        }
      }
    }
  }
  return out;
}

/** A value the writer chose, rather than a datum it carried. */
function isDiscriminator(value: string): boolean {
  return (
    /^(true|false)$/.test(value) ||
    /^'[a-z_]+'$/.test(value) ||
    /!==?\s*null|^Boolean\(|^![A-Za-z]/.test(value) ||
    value === '(shorthand)'
  );
}

/** Read by `extractChanges` and rendered as a change list. */
const READ_AS_CHANGES = ['changes', 'from', 'to', 'fields', 'engine_inputs_applied'];

/**
 * Discriminators that reach a reader some other way, and why.
 *
 * Each of these was looked at in round 389 and left alone deliberately. The
 * reason is here so the next round argues with a position.
 */
const INERT: Record<string, string> = {
  ai: 'qa_review_completed points at a QA review row; whether it had AI findings is on that panel, beside the findings themselves.',
  decision:
    'review_decision carries `from`/`to` as well, and the decision is what moved — the change list already states it.',
  origin:
    "report_saved's only other origin is a version restore, which writes its own event; `template` distinguishes nothing a reader sees.",
  role: 'signature_recorded / signature_removed name the role in a payload nothing renders — see the R389 gap, which is about the whole of these two payloads and not this key.',
  source:
    'valuation_created from an intake link; the link id is beside it and the seeding writes its own params event.',
  stage:
    "engagement_created always opens at 'kickoff'; a constant is not a discriminator, it is a default written down.",
  state: "valuation_created always opens at 'pending', same.",
  status:
    "ai_job_completed's status is the half `reaped` qualifies, and the reap is what R389 gave the note to.",
};

const payloads = spinePayloads();
const discriminators = payloads.filter((p) => isDiscriminator(p.value));
const noted = new Set(Object.values(EVENT_NOTES).flatMap((flags) => Object.keys(flags)));

describe('the spine states no circumstance nobody can read', () => {
  it('finds the payloads at all', () => {
    // Vacuity guard: two regexes over TypeScript that stopped matching would
    // report a clean estate of nothing. Pinned to the writes that certainly
    // carry discriminators, including the batch-inside-a-callback shape.
    expect(payloads.length).toBeGreaterThan(60);
    expect(discriminators.map((d) => `${d.file}: ${d.key}`)).toContain(
      'repos/organizations.ts: organization_deleted',
    );
    expect(discriminators.map((d) => `${d.file}: ${d.key}`)).toContain('repos/assignedWork.ts: reason');
    expect(discriminators.map((d) => `${d.file}: ${d.key}`)).toContain(
      'repos/pipelineRuns.ts: retry_scheduled',
    );
    // And the whole-key census the pair rule below runs over, which is a
    // different list: `document_refiled` carries no discriminator at all.
    expect(payloads.map((p) => `${p.file}: ${p.key}`)).toContain('repos/documents.ts: document_id');
  });

  it('classifies every discriminator a repo writes', () => {
    const unclassified = [
      ...new Set(
        discriminators
          .filter((d) => !READ_AS_CHANGES.includes(d.key) && !noted.has(d.key) && !(d.key in INERT))
          .map((d) => `${d.file}: ${d.key}: ${d.value}`),
      ),
    ].sort();
    // Read as a change, read as a note, or argued inert above. A payload flag
    // in none of the three is a sentence the writer meant for a reader and no
    // reader receives — R384's `organization_deleted`, three rounds running.
    expect(unclassified).toEqual([]);
  });

  it('declares no note for a flag nothing writes', () => {
    // The other direction: a note is dead once its writer is gone, and a dead
    // note is a sentence this build promises and can never say.
    const written = new Set(discriminators.map((d) => d.key));
    const orphans = [...noted].filter((flag) => !written.has(flag)).sort();
    expect(orphans).toEqual([]);
  });

  it('spells a before/after pair the one way the reader parses', () => {
    /*
     * The other half of the same failure. `extractChanges` reads four payload
     * shapes; `document_refiled` wrote a fifth — `from_category`/`to_category`
     * and `from_kind`/`to_kind` — so the two pairs a re-file consists of
     * reached no reader, and the change log emitted no row for the event at
     * all. A `from_x` with a matching `to_x` is a change list spelled in a way
     * nothing renders, and it costs nothing to spell it the way that works.
     *
     * `from_number` on the clone event is not one: it names the engagement the
     * copy came from, beside `from`, and has no `to_number`.
     */
    const keys = new Set(payloads.map((p) => p.key));
    const pairs = [...keys].filter((key) => key.startsWith('from_') && keys.has(`to_${key.slice(5)}`)).sort();
    expect(pairs).toEqual([]);
  });

  it('argues its inert list against something that exists', () => {
    // An INERT entry for a key no payload carries is a position about nothing,
    // and it hides the same key arriving later under a different writer.
    const written = new Set(discriminators.map((d) => d.key));
    expect(
      Object.keys(INERT)
        .filter((key) => !written.has(key))
        .sort(),
    ).toEqual([]);
  });
});
