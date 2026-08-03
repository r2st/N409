import { describe, expect, it } from 'vitest';
import { escapeLike, likeContains } from '../../src/db/like.js';

describe('likeContains', () => {
  it('wraps a plain query in a substring pattern', () => {
    expect(likeContains('Acme')).toBe('%Acme%');
  });

  it('escapes the query before wrapping, so only the wrapping wildcards match', () => {
    expect(likeContains('100%')).toBe('%100\\%%');
    expect(likeContains('%')).toBe('%\\%%');
    expect(likeContains('Z_ta')).toBe('%Z\\_ta%');
    expect(likeContains('a\\b')).toBe('%a\\\\b%');
  });

  it('is the escaped form of the query, by construction', () => {
    for (const q of ['plain', '100%', 'a_b', 'a\\b', '%_\\', '']) {
      expect(likeContains(q)).toBe(`%${escapeLike(q)}%`);
    }
  });
});
