import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/lib/diff';

describe('diffLines', () => {
  it('marks identical content as all-same', () => {
    const lines = diffLines('a\nb', 'a\nb');
    expect(lines).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
    ]);
  });

  it('detects an added line', () => {
    expect(diffLines('a\nc', 'a\nb\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'added', text: 'b' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('detects a removed line', () => {
    expect(diffLines('a\nb\nc', 'a\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('treats a changed line as remove + add', () => {
    const lines = diffLines('hello world', 'hello there');
    expect(lines).toEqual([
      { kind: 'removed', text: 'hello world' },
      { kind: 'added', text: 'hello there' },
    ]);
  });

  it('handles empty inputs', () => {
    expect(diffLines('', '')).toEqual([{ kind: 'same', text: '' }]);
    expect(diffLines('', 'a')).toEqual([
      { kind: 'removed', text: '' },
      { kind: 'added', text: 'a' },
    ]);
  });
});
