import { describe, expect, it } from 'vitest';
import {
  describeIssues,
  issuePath,
  validationDetail,
  type ValidationIssue,
} from '../src/validationDetail.js';

const issue = (path: ReadonlyArray<string | number>, message: string): ValidationIssue => ({ path, message });

describe('issuePath', () => {
  it('names a top-level field as itself', () => {
    expect(issuePath(['vintage_year'])).toBe('vintage_year');
  });

  it('dots through nested objects', () => {
    expect(issuePath(['lp_terms', 'carry', 'rate'])).toBe('lp_terms.carry.rate');
  });

  it('renders an array element as an index the caller can count to', () => {
    // `positions.0.cost_basis` does not correspond to anything in the JSON the
    // client sent. `positions[0].cost_basis` is the row they can point at.
    expect(issuePath(['positions', 0, 'cost_basis'])).toBe('positions[0].cost_basis');
  });

  it('does not lead with a dot when the root itself is an array', () => {
    expect(issuePath([0, 'ticker'])).toBe('[0].ticker');
  });

  it('has nothing to say about a failure with no path', () => {
    // A `superRefine` on the root, or a body that is an array where an object
    // was expected: there is no field to name, and inventing one would be worse
    // than saying nothing.
    expect(issuePath([])).toBe('');
  });
});

describe('describeIssues', () => {
  it('names the field beside its message', () => {
    expect(describeIssues([issue(['volatility'], 'Number must be greater than 0')])).toBe(
      'volatility: Number must be greater than 0',
    );
  });

  it('keeps the message unprefixed when the issue is about the whole value', () => {
    expect(describeIssues([issue([], 'Expected object, received array')])).toBe(
      'Expected object, received array',
    );
  });

  it('joins several fields with semicolons', () => {
    expect(describeIssues([issue(['page'], 'Expected number'), issue(['sort'], 'Invalid enum value')])).toBe(
      'page: Expected number; sort: Invalid enum value',
    );
  });

  it('stops at three and counts what it is not showing', () => {
    // A schema refusing a badly-shaped body produces one issue per expected
    // field, so the unbounded form of this is a paragraph — and an error
    // message stops being useful the moment it no longer fits where the UI puts
    // it. The full list is still in `errors` for anyone who wants it.
    const many = ['a', 'b', 'c', 'd', 'e'].map((f) => issue([f], 'Required'));
    expect(describeIssues(many)).toBe('a: Required; b: Required; c: Required (and 2 more problems)');
  });

  it('counts the hidden issues, not the total', () => {
    const four = ['a', 'b', 'c', 'd'].map((f) => issue([f], 'Required'));
    // Four issues, three named — so "1 more", not "4" and not "3".
    expect(describeIssues(four)).toContain('(and 1 more problem)');
    expect(describeIssues(four)).not.toContain('problems)');
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(describeIssues([])).toBe('');
  });
});

describe('validationDetail', () => {
  it('keeps the subject, which is the half that says where to look', () => {
    // A route validates path parameters, query and body against three different
    // schemas. `page: Expected number` alone does not say which of the three
    // the caller should go and fix.
    expect(validationDetail('Invalid query', [issue(['page'], 'Expected number')])).toBe(
      'Invalid query — page: Expected number',
    );
  });

  it('degrades to the bare subject rather than trailing an empty dash', () => {
    expect(validationDetail('Invalid query', [])).toBe('Invalid query');
  });

  it('does not paraphrase a message a schema wrote for a person', () => {
    // The schemas in this estate already carry written-for-a-human messages
    // where zod's default is unhelpful. A translation layer here would
    // overwrite the good ones with a generic one.
    expect(validationDetail('Invalid fund', [issue(['as_of'], 'Expected YYYY-MM-DD')])).toBe(
      'Invalid fund — as_of: Expected YYYY-MM-DD',
    );
  });
});
