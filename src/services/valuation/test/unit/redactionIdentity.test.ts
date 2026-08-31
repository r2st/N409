import { describe, expect, it } from 'vitest';
import {
  isIdentityUnavailable,
  ownerRedactionEntities,
  redactionIdentityState,
  type RedactionIdentityResult,
} from '../../src/domain/redactionIdentity.js';

/**
 * A failed owner lookup is its own value, not the absence of a name.
 *
 * Both AI routes resolve the engagement owner best-effort, because a lookup
 * that fails must not cost a pipeline run or refuse an operator's preview. What
 * that produced was a run record identical to the one an account with no name
 * on file produces — `declared: {people: 0}` — while the client's name went to
 * an external model unstruck. `users.first_name` is nullable, so the count
 * genuinely is zero for some accounts and the two cannot be told apart by
 * counting.
 */
describe('the engagement owner, as the redactor is told about them', () => {
  const person: RedactionIdentityResult = {
    first_name: 'Ada',
    last_name: 'Lovelace',
    company_name: 'Analytical Engines Ltd',
  };

  it('separates the read that failed from the row that was not there', () => {
    expect(redactionIdentityState(person)).toBe('read');
    expect(redactionIdentityState(null)).toBe('missing');
    expect(redactionIdentityState('unavailable')).toBe('unavailable');
  });

  it('only the failed read is the one a reader has to be warned about', () => {
    expect(isIdentityUnavailable('unavailable')).toBe(true);
    expect(isIdentityUnavailable(null)).toBe(false);
    expect(isIdentityUnavailable(person)).toBe(false);
  });

  it('gives the two entity lists the redactor is told to strike', () => {
    expect(ownerRedactionEntities(person)).toEqual({
      companies: ['Analytical Engines Ltd'],
      people: ['Ada Lovelace'],
    });
  });

  /*
   * The shape the record could not previously distinguish from a failure: an
   * account that has never filled a name in. It is a real and permanent state,
   * which is exactly why the failure needed a value of its own.
   */
  it('declares nobody for an account with no name, and says the read succeeded', () => {
    const nameless: RedactionIdentityResult = { first_name: null, last_name: null, company_name: null };
    expect(ownerRedactionEntities(nameless)).toEqual({ companies: [], people: [] });
    expect(redactionIdentityState(nameless)).toBe('read');
  });

  it('declares nobody for a failed read too — and says so', () => {
    expect(ownerRedactionEntities('unavailable')).toEqual({ companies: [], people: [] });
    expect(redactionIdentityState('unavailable')).toBe('unavailable');
  });

  /*
   * A half-filled name still names somebody, and a blank one is an entity the
   * redactor would compile a pattern for and match nothing with — or, for a
   * company, one `_short_form` would derive a second blank from.
   */
  it('takes whichever half of the name is on file, and no blanks', () => {
    expect(ownerRedactionEntities({ first_name: 'Ada', last_name: null, company_name: '   ' })).toEqual({
      companies: [],
      people: ['Ada'],
    });
    expect(ownerRedactionEntities({ first_name: '  ', last_name: '  ', company_name: 'Acme' })).toEqual({
      companies: ['Acme'],
      people: [],
    });
  });
});
