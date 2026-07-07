import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { REDACT_PATHS } from '../src/logger.js';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);
  return { logger, lines };
}

describe('PII redaction (issue #4)', () => {
  it('redacts credentials and PII at top level and nested', () => {
    const { logger, lines } = captureLogger();
    logger.info({
      email: 'founder@acme.com',
      password: 'hunter2',
      user: { email: 'x@y.z', first_name: 'Jane', last_name: 'Doe', phone: '+1555' },
      req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } },
    });
    const out = JSON.parse(lines[0]!);
    expect(out.email).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.user.email).toBe('[REDACTED]');
    expect(out.user.first_name).toBe('[REDACTED]');
    expect(out.user.last_name).toBe('[REDACTED]');
    expect(out.user.phone).toBe('[REDACTED]');
    expect(out.req.headers.authorization).toBe('[REDACTED]');
    expect(out.req.headers.cookie).toBe('[REDACTED]');
  });

  it('redacts cap table payloads', () => {
    const { logger, lines } = captureLogger();
    logger.info({ attachment: { cap_table: { holders: ['a'] } } });
    const out = JSON.parse(lines[0]!);
    expect(out.attachment.cap_table).toBe('[REDACTED]');
  });

  it('keeps non-sensitive fields intact', () => {
    const { logger, lines } = captureLogger();
    logger.info({ valuation_id: '01ABC', state: 'pending' });
    const out = JSON.parse(lines[0]!);
    expect(out.valuation_id).toBe('01ABC');
    expect(out.state).toBe('pending');
  });
});
