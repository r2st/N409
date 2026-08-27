import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findNulByte, MAX_SCAN_DEPTH } from '../../src/domain/nulBytes.js';

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

describe('findNulByte', () => {
  it('passes ordinary payloads, including awkward Unicode', () => {
    expect(findNulByte({ name: 'Ünïcödé 🏢 Ltd', n: 3, ok: true, missing: null })).toBeNull();
    // Other control characters are not this guard's business: Postgres stores
    // them, and the PDF renderer strips the ones it cannot draw.
    expect(findNulByte({ name: 'abc' })).toBeNull();
  });

  it('names the field it found, so the refusal can say which', () => {
    expect(findNulByte({ company_name: `Acme${NUL}` })).toBe('company_name');
    expect(findNulByte({ rows: [{ ok: 'y' }, { holder: `A${NUL}` }] })).toBe('rows[1].holder');
  });

  it('searches keys as well as values', () => {
    // The cap-table column mapping is a `z.record(z.string(), z.string())` and
    // lands in jsonb with its keys intact; an unstorable key is as fatal there
    // as an unstorable value.
    expect(findNulByte({ mapping: { [`col${NUL}`]: 'shares' } })).toBe(`mapping.col${NUL} (key)`);
  });

  it('reports the first hit and stops', () => {
    expect(findNulByte({ a: `x${NUL}`, b: `y${NUL}` })).toBe('a');
  });

  it('leaves the bodies that are bytes on purpose alone', () => {
    // Webhook routes install their own buffer parser so they can verify a
    // signature over the exact bytes; those never reach a text column as they
    // stand, and a buffer has no `.includes(string)` semantics to test anyway.
    expect(findNulByte(Buffer.from([0, 1, 2]))).toBeNull();
    expect(findNulByte(new Date(0))).toBeNull();
  });

  it('handles the root being a bare string', () => {
    expect(findNulByte(`a${NUL}`)).toBe('(root)');
    expect(findNulByte('a')).toBeNull();
  });

  it('stops descending past the depth bound rather than recursing forever', () => {
    const nest = (depth: number): unknown => (depth === 0 ? { leaf: `x${NUL}` } : { down: nest(depth - 1) });
    expect(findNulByte(nest(MAX_SCAN_DEPTH - 2))).toContain('leaf');
    // Deeper than the bound is not searched. That is the trade the bound makes:
    // no request is allowed to turn the guard into unbounded work, and a body
    // nested twelve deep is not a shape any schema in this service accepts.
    expect(findNulByte(nest(MAX_SCAN_DEPTH + 5))).toBeNull();
  });

  it('is not confused by an object with no prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.name = `a${NUL}`;
    expect(findNulByte(bare)).toBe('name');
  });
});
