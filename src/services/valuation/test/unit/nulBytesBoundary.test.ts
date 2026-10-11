import { describe, expect, it } from 'vitest';
import {
  findUnstorableText,
  findOverDeepValue,
  scanRequestValue,
  MAX_SCAN_DEPTH,
  unstorableTextMessage,
  overDeepMessage,
  type UnstorableText,
} from '../../src/domain/nulBytes.js';

describe('findUnstorableText boundary inputs', () => {
  it('returns null for a clean string', () => {
    expect(findUnstorableText('hello world')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(findUnstorableText(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(findUnstorableText(undefined)).toBeNull();
  });

  it('returns null for numbers', () => {
    expect(findUnstorableText(42)).toBeNull();
  });

  it('returns null for booleans', () => {
    expect(findUnstorableText(true)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(findUnstorableText('')).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(findUnstorableText({})).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(findUnstorableText([])).toBeNull();
  });

  it('finds a NUL byte in a string', () => {
    const result = findUnstorableText('hello\u0000world');
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('nul');
  });

  it('finds a NUL byte deeply nested', () => {
    const result = findUnstorableText({ a: { b: { c: 'has\u0000nul' } } });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('nul');
    expect(result!.path).toContain('a');
  });

  it('finds an unpaired high surrogate', () => {
    const result = findUnstorableText('hello\uD800world');
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('lone_surrogate');
  });

  it('finds an unpaired low surrogate', () => {
    const result = findUnstorableText('hello\uDC00world');
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('lone_surrogate');
  });

  it('accepts a properly paired surrogate (emoji)', () => {
    expect(findUnstorableText('hello 🎉 world')).toBeNull();
  });

  it('finds unstorable characters in object keys', () => {
    const result = findUnstorableText({ 'key\u0000name': 'value' });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('nul');
    expect(result!.path).toContain('(key)');
  });

  it('finds unstorable characters in array elements', () => {
    const result = findUnstorableText(['good', 'has\u0000nul', 'ok']);
    expect(result).not.toBeNull();
    expect(result!.path).toContain('[1]');
  });

  it('skips Date objects without error', () => {
    expect(findUnstorableText({ date: new Date() })).toBeNull();
  });

  it('skips Buffer objects without error', () => {
    expect(findUnstorableText({ buf: Buffer.from('hello') })).toBeNull();
  });

  it('reports a path with a prefix', () => {
    const result = findUnstorableText({ name: 'has\u0000nul' }, 'body');
    expect(result!.path).toBe('body.name');
  });
});

describe('findOverDeepValue boundary inputs', () => {
  it('returns null for shallow values', () => {
    expect(findOverDeepValue({ a: { b: { c: 'd' } } })).toBeNull();
  });

  it('returns null for null', () => {
    expect(findOverDeepValue(null)).toBeNull();
  });

  it('returns the path for values nested past MAX_SCAN_DEPTH', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i <= MAX_SCAN_DEPTH; i++) nested = { child: nested };
    const path = findOverDeepValue(nested);
    expect(path).not.toBeNull();
    expect(typeof path).toBe('string');
  });

  it('returns null for values at exactly MAX_SCAN_DEPTH', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < MAX_SCAN_DEPTH; i++) nested = { child: nested };
    expect(findOverDeepValue(nested)).toBeNull();
  });
});

describe('scanRequestValue boundary inputs', () => {
  it('returns both null for clean input', () => {
    const { unstorable, overDeep } = scanRequestValue({ name: 'hello' });
    expect(unstorable).toBeNull();
    expect(overDeep).toBeNull();
  });

  it('prioritizes unstorable over deep nesting', () => {
    let nested: unknown = 'has\u0000nul';
    for (let i = 0; i <= MAX_SCAN_DEPTH; i++) nested = { child: nested };
    // The unstorable string is at the depth boundary or past it
    const { unstorable } = scanRequestValue({ shallow: 'has\u0000nul', deep: nested });
    expect(unstorable).not.toBeNull();
    expect(unstorable!.reason).toBe('nul');
  });

  it('reports overDeep when no unstorable but deeply nested', () => {
    let nested: unknown = 'clean';
    for (let i = 0; i <= MAX_SCAN_DEPTH; i++) nested = { child: nested };
    const { unstorable, overDeep } = scanRequestValue(nested);
    expect(unstorable).toBeNull();
    expect(overDeep).not.toBeNull();
  });
});

describe('message formatting', () => {
  it('unstorableTextMessage includes the path and reason', () => {
    const hit: UnstorableText = { path: 'body.name', reason: 'nul' };
    const msg = unstorableTextMessage(hit);
    expect(msg).toContain('body.name');
    expect(msg).toContain('NUL');
  });

  it('overDeepMessage includes the path and depth', () => {
    const msg = overDeepMessage('body.deeply.nested');
    expect(msg).toContain('body.deeply.nested');
    expect(msg).toContain(String(MAX_SCAN_DEPTH));
  });
});
