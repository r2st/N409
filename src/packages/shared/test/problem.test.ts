import { describe, expect, it } from 'vitest';
import { scrubError, scrubSensitive } from '../src/problem.js';

describe('scrubSensitive', () => {
  it('masks credentials in a connection string but keeps scheme/host', () => {
    expect(scrubSensitive('connect postgres://n409:s3cr3t@db.internal:5432/n409 failed')).toBe(
      'connect postgres://[REDACTED]@db.internal:5432/n409 failed',
    );
    expect(scrubSensitive('redis://user:pass@cache:6379')).toBe('redis://[REDACTED]@cache:6379');
  });

  it('masks bearer tokens and JWTs', () => {
    expect(scrubSensitive('Authorization: Bearer abcDEF123456789xyz')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(scrubSensitive(`token ${jwt} rejected`)).toBe('token [REDACTED-JWT] rejected');
  });

  it('masks API keys and emails and SSNs', () => {
    expect(scrubSensitive('key sk-ABCDEF0123456789abcdef used')).toBe('key [REDACTED-KEY] used');
    expect(scrubSensitive('using AKIAIOSFODNN7EXAMPLE now')).toBe('using [REDACTED-KEY] now');
    expect(scrubSensitive('user jane.doe@acme.co not found')).toBe('user [REDACTED-EMAIL] not found');
    expect(scrubSensitive('ssn 123-45-6789 present')).toBe('ssn [REDACTED-SSN] present');
  });

  it('leaves benign text untouched', () => {
    const msg = 'Valuation 42 could not be computed: engine returned 422';
    expect(scrubSensitive(msg)).toBe(msg);
  });

  it('is safe on empty input', () => {
    expect(scrubSensitive('')).toBe('');
  });
});

describe('scrubError', () => {
  it('scrubs message and stack of an Error', () => {
    const err = new Error('failed to reach postgres://u:p@h:5432/db for jane@x.io');
    const scrubbed = scrubError(err);
    expect(scrubbed.name).toBe('Error');
    expect(scrubbed.message).toBe('failed to reach postgres://[REDACTED]@h:5432/db for [REDACTED-EMAIL]');
    expect(String(scrubbed.stack)).not.toContain('jane@x.io');
    expect(String(scrubbed.stack)).not.toContain(':p@');
  });

  it('handles non-Error throwables', () => {
    expect(scrubError('boom sk-ABCDEF0123456789abcdef')).toEqual({ message: 'boom [REDACTED-KEY]' });
  });
});
