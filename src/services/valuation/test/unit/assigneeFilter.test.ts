import { describe, expect, it } from 'vitest';
import { assigneeFilter, ASSIGNEE_FILTER_MESSAGE } from '../../src/domain/assignee.js';

describe('assigneeFilter', () => {
  const schema = assigneeFilter();

  it('accepts the literal "me"', () => {
    expect(schema.parse('me')).toBe('me');
  });

  it('accepts a valid 26-character ULID', () => {
    const ulid = '01JAAAAAAAAAAAAAAAAAAAAAAA';
    expect(schema.parse(ulid)).toBe(ulid);
  });

  it('rejects a truncated ULID', () => {
    expect(() => schema.parse('01JAAAAAA')).toThrow();
  });

  it('rejects a too-long string that is not "me" or a ULID', () => {
    expect(() => schema.parse('01JAAAAAAAAAAAAAAAAAAAAAAAEXTRA')).toThrow();
  });

  it('rejects "Me" (case-sensitive)', () => {
    expect(() => schema.parse('Me')).toThrow();
  });

  it('rejects an email address', () => {
    expect(() => schema.parse('user@example.com')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => schema.parse('')).toThrow();
  });

  it('includes the expected error message on rejection', () => {
    const result = schema.safeParse('invalid');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(ASSIGNEE_FILTER_MESSAGE);
    }
  });
});
