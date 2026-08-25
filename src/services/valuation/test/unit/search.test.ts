import { describe, expect, it } from 'vitest';
import { escapeLike, valuationNumberQuery } from '../../src/repos/search.js';

describe('escapeLike', () => {
  it('passes plain strings through', () => {
    expect(escapeLike('Acme Corp')).toBe('Acme Corp');
    expect(escapeLike('hello')).toBe('hello');
  });

  it('escapes percent wildcards', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('%drop%')).toBe('\\%drop\\%');
  });

  it('escapes underscore wildcards', () => {
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes backslashes', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  it('handles combined special characters', () => {
    expect(escapeLike('100%_test')).toBe('100\\%\\_test');
  });
});

describe('valuationNumberQuery', () => {
  it('accepts a digit run that fits the bigint column', () => {
    expect(valuationNumberQuery('42')).toBe('42');
    expect(valuationNumberQuery('9223372036854775807')).toBe('9223372036854775807');
  });

  it('rejects a digit run past the bigint ceiling', () => {
    // Casting these would be a range *error*, not a miss, taking the whole
    // search statement — company-name matches included — down with it.
    expect(valuationNumberQuery('9223372036854775808')).toBeNull();
    expect(valuationNumberQuery('99999999999999999999999')).toBeNull();
    expect(valuationNumberQuery('1'.repeat(200))).toBeNull();
  });

  it('reads a padded digit run at its value, not its length', () => {
    expect(valuationNumberQuery('00000000000000000000001')).toBe('00000000000000000000001');
  });

  it('accepts the leading # this application prints numbers with', () => {
    // Every surface writes a valuation number as `#{number}` — the dashboard,
    // the inbox, the billing page, the firm roster, and the search results
    // page itself. Rejecting the `#` meant copying a number off the screen and
    // pasting it into the search box found nothing, while the valuations list
    // filter, which does strip it, disagreed.
    expect(valuationNumberQuery('#42')).toBe('42');
    expect(valuationNumberQuery('#00000000000000000000001')).toBe('00000000000000000000001');
    // The ceiling still applies with the prefix on: a cast that overflows is a
    // Postgres range error, and it fails the whole statement rather than the
    // one clause.
    expect(valuationNumberQuery('#9223372036854775807')).toBe('9223372036854775807');
    expect(valuationNumberQuery('#9223372036854775808')).toBeNull();
  });

  it('rejects anything that is not a digit run, prefixed or not', () => {
    expect(valuationNumberQuery('acme')).toBeNull();
    expect(valuationNumberQuery('12a')).toBeNull();
    expect(valuationNumberQuery('-1')).toBeNull();
    expect(valuationNumberQuery('1.5')).toBeNull();
    expect(valuationNumberQuery(' 12 ')).toBeNull();
    // One `#`, and only at the front — nothing else is a number this
    // application ever wrote.
    expect(valuationNumberQuery('##12')).toBeNull();
    expect(valuationNumberQuery('12#')).toBeNull();
    expect(valuationNumberQuery('#')).toBeNull();
    expect(valuationNumberQuery('#-1')).toBeNull();
    expect(valuationNumberQuery(' #12')).toBeNull();
  });
});
