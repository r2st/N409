import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findOverDeepValue, findUnstorableText, MAX_SCAN_DEPTH } from '../../src/domain/nulBytes.js';

/**
 * The walk behind the boundary guard in app.ts.
 *
 * `nulByteRefusal.test.ts` is the half only a running app can show — that the
 * hook is wired, that it fires ahead of the handler, and that the request that
 * used to 500 now 400s. This file is the walk itself: what it finds, where it
 * stops, and what it deliberately leaves alone.
 */

const NUL = '\u0000';

describe('the gap this closes', () => {
  it('is invisible to zod: every string bound is about something else', () => {
    expect(z.string().min(1).max(200).safeParse(`Acme${NUL}`).success).toBe(true);
    expect(z.string().trim().safeParse(NUL).success).toBe(true);
  });

  it('is invisible to a raw-body scan: JSON writes the byte as an escape', () => {
    // What a client puts on the wire has no 0x00 in it at all.
    expect(JSON.stringify({ name: `a${NUL}b` })).toBe('{"name":"a\\u0000b"}');
    expect(Buffer.from(JSON.stringify({ name: `a${NUL}b` })).includes(0)).toBe(false);
    // It exists only once parsed, which is where the hook looks.
    expect((JSON.parse('{"name":"a\\u0000b"}') as { name: string }).name).toContain(NUL);
  });
});

/** The path alone, for the cases that are only about where the walk stopped. */
const at = (value: unknown): string | null => findUnstorableText(value)?.path ?? null;

describe('findOverDeepValue', () => {
  const nest = (levels: number, leaf: unknown): unknown => {
    let v = leaf;
    for (let i = 0; i < levels; i += 1) v = { a: v };
    return v;
  };

  it('passes anything the unstorable scan can finish reading', () => {
    expect(findOverDeepValue({ a: 1 })).toBeNull();
    expect(findOverDeepValue(nest(MAX_SCAN_DEPTH, 'leaf'))).toBeNull();
    // The engine input document, the deepest body this API takes.
    expect(findOverDeepValue({ market: { multiples: [{ metric: 'ev_revenue', value: 4.2 }] } })).toBeNull();
  });

  it('names the first value nested past the scan, in objects and in arrays', () => {
    expect(findOverDeepValue(nest(MAX_SCAN_DEPTH + 2, 'leaf'))).toBe('a'.repeat(1).concat(
      '.a'.repeat(MAX_SCAN_DEPTH),
    ));
    expect(findOverDeepValue({ rows: [nest(MAX_SCAN_DEPTH + 2, 1)] })?.startsWith('rows[0]')).toBe(true);
  });

  /**
   * The reason it exists: the unstorable scan answers `null` below its depth
   * bound, so a NUL at depth 13 passed the hook and reached the jsonb column
   * that `inputs` is stored in, where the driver refuses it as 22021.
   */
  it('catches the depth a NUL was hiding at', () => {
    const hidden = nest(MAX_SCAN_DEPTH + 1, `x${NUL}y`);
    expect(findUnstorableText(hidden)).toBeNull();
    expect(findOverDeepValue(hidden)).not.toBeNull();
  });
});

describe('findUnstorableText', () => {
  it('passes ordinary payloads, including awkward Unicode', () => {
    expect(at({ name: 'Ünïcödé 🏢 Ltd', n: 3, ok: true, missing: null })).toBeNull();
    // Other control characters are not this guard's business: Postgres stores
    // them, and the PDF renderer strips the ones it cannot draw.
    expect(at({ name: 'abc' })).toBeNull();
  });

  it('names the field it found, so the refusal can say which', () => {
    expect(at({ company_name: `Acme${NUL}` })).toBe('company_name');
    expect(at({ rows: [{ ok: 'y' }, { holder: `A${NUL}` }] })).toBe('rows[1].holder');
  });

  it('searches keys as well as values', () => {
    // The cap-table column mapping is a `z.record(z.string(), z.string())` and
    // lands in jsonb with its keys intact; an unstorable key is as fatal there
    // as an unstorable value.
    expect(at({ mapping: { [`col${NUL}`]: 'shares' } })).toBe(`mapping.col${NUL} (key)`);
  });

  it('reports the first hit and stops', () => {
    expect(at({ a: `x${NUL}`, b: `y${NUL}` })).toBe('a');
  });

  it('leaves the bodies that are bytes on purpose alone', () => {
    // Webhook routes install their own buffer parser so they can verify a
    // signature over the exact bytes; those never reach a text column as they
    // stand, and a buffer has no `.includes(string)` semantics to test anyway.
    expect(at(Buffer.from([0, 1, 2]))).toBeNull();
    expect(at(new Date(0))).toBeNull();
  });

  it('handles the root being a bare string', () => {
    expect(at(`a${NUL}`)).toBe('(root)');
    expect(at('a')).toBeNull();
  });

  it('stops descending past the depth bound rather than recursing forever', () => {
    const nest = (depth: number): unknown => (depth === 0 ? { leaf: `x${NUL}` } : { down: nest(depth - 1) });
    expect(at(nest(MAX_SCAN_DEPTH - 2))).toContain('leaf');
    // Deeper than the bound is not searched. That is the trade the bound makes:
    // no request is allowed to turn the guard into unbounded work, and a body
    // nested twelve deep is not a shape any schema in this service accepts.
    expect(at(nest(MAX_SCAN_DEPTH + 5))).toBeNull();
  });

  it('is not confused by an object with no prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.name = `a${NUL}`;
    expect(at(bare)).toBe('name');
  });
});

/**
 * R217, methodology M6: the second character with no UTF-8 encoding.
 *
 * Reached from the portal's own forms — a company name pasted with half an
 * emoji in it. `POST /api/v1/valuations` and the company-profile editor both
 * answered 500, because `recordEvent` writes the same strings into a `jsonb`
 * column and Postgres refuses an unpaired `\ud800` escape.
 */
describe('an unpaired surrogate', () => {
  const HIGH = '\uD800';
  const LOW = '\uDC00';

  it('is invisible to zod and to a raw-body scan, exactly as the NUL is', () => {
    expect(z.string().min(1).max(200).safeParse(`Acme${HIGH}`).success).toBe(true);
    // Well-formed JSON.stringify (ES2019) emits the half as a literal escape,
    // so the bytes on the wire are ASCII and a raw scan sees nothing.
    expect(JSON.stringify({ name: `a${HIGH}b` })).toBe('{"name":"a\\ud800b"}');
  });

  it('finds a lone half of either kind, and names the field', () => {
    expect(findUnstorableText({ company_name: `Acme${HIGH}` })).toEqual({
      path: 'company_name',
      reason: 'lone_surrogate',
    });
    expect(findUnstorableText({ a: `${LOW}x` })).toEqual({ path: 'a', reason: 'lone_surrogate' });
    // A low half before a high one is two lone halves, not a pair.
    expect(findUnstorableText({ a: `${LOW}${HIGH}` })).toEqual({ path: 'a', reason: 'lone_surrogate' });
  });

  it('leaves real astral characters alone', () => {
    // The whole point: emoji, CJK extension B, musical symbols and flags are
    // surrogate *pairs* and are stored exactly as sent.
    expect(findUnstorableText({ a: '🏢 Ltd', b: '𝄞', c: '🇬🇧', d: '𠮷野家' })).toBeNull();
  });

  it('searches keys, and reports the NUL first when a payload carries both', () => {
    expect(findUnstorableText({ [`col${HIGH}`]: 'shares' })).toEqual({
      path: `col${HIGH} (key)`,
      reason: 'lone_surrogate',
    });
    // Order within a string: the NUL is the older, better-known refusal and
    // the message is more actionable, so it wins when one value has both.
    expect(findUnstorableText({ a: `${HIGH}${NUL}` })?.reason).toBe('nul');
  });
});
