import { describe, expect, it } from 'vitest';
import {
  buildWebhookPayload,
  isValidWebhookUrl,
  newWebhookSecret,
  signWebhookBody,
  verifyWebhookSignature,
  webhookWantsEvent,
} from '../../src/domain/partnerWebhooks.js';

describe('partner webhook domain', () => {
  it('signs and verifies over exact body bytes', () => {
    const secret = newWebhookSecret();
    const body = JSON.stringify({ event: 'webhook.test', n: 1 });
    const signature = signWebhookBody(secret, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, body + ' ', signature)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=' + '0'.repeat(64))).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'nonsense')).toBe(false);
  });

  it('mints distinct prefixed secrets', () => {
    const a = newWebhookSecret();
    const b = newWebhookSecret();
    expect(a).toMatch(/^n409_whsec_/);
    expect(a).not.toBe(b);
  });

  it('treats an empty subscription list as every event', () => {
    expect(webhookWantsEvent([], 'valuation.state_changed')).toBe(true);
    expect(webhookWantsEvent(['valuation.report_ready'], 'valuation.state_changed')).toBe(false);
    expect(webhookWantsEvent(['valuation.report_ready'], 'valuation.report_ready')).toBe(true);
  });

  it('accepts only http(s) webhook URLs', () => {
    expect(isValidWebhookUrl('https://example.com/hook')).toBe(true);
    expect(isValidWebhookUrl('http://127.0.0.1:8080/hook')).toBe(true);
    expect(isValidWebhookUrl('ftp://example.com/hook')).toBe(false);
    expect(isValidWebhookUrl('file:///etc/passwd')).toBe(false);
    expect(isValidWebhookUrl('not a url')).toBe(false);
  });

  it('stamps payloads with the event and send time', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    const payload = buildWebhookPayload(
      'valuation.state_changed',
      { id: '01J', number: 42, kind: 'qsbs', state: 'started', company_name: 'Acme' },
      { previous_state: 'pending' },
      now,
    );
    expect(payload.created_at).toBe('2026-08-07T12:00:00.000Z');
    expect(payload.valuation?.kind).toBe('qsbs');
    expect(payload.previous_state).toBe('pending');
  });
});
