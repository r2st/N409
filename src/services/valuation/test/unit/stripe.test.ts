import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeForm,
  parseSignatureHeader,
  retrieveReceipt,
  StripeApiError,
  verifyWebhookSignature,
} from '../../src/payments/stripe.js';
import { priceForKind, DEFAULT_PRICE_CENTS, FALLBACK_PRICE_CENTS } from '../../src/routes/payments.js';

function sign(payload: string, secret: string, timestamp: number): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

describe('Stripe form encoding', () => {
  it('flattens nested objects and arrays the way Stripe expects', () => {
    const encoded = encodeForm({
      mode: 'payment',
      metadata: { valuation_id: 'abc' },
      line_items: [{ quantity: 1, price_data: { unit_amount: 119000 } }],
      skipped: undefined,
    });
    expect(encoded).toContain('mode=payment');
    expect(encoded).toContain(encodeURIComponent('metadata[valuation_id]') + '=abc');
    expect(encoded).toContain(encodeURIComponent('line_items[0][quantity]') + '=1');
    expect(encoded).toContain(encodeURIComponent('line_items[0][price_data][unit_amount]') + '=119000');
    expect(encoded).not.toContain('skipped');
  });
});

describe('Stripe webhook signature', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

  it('parses the Stripe-Signature header', () => {
    const parsed = parseSignatureHeader('t=1700000000,v1=abc,v0=legacy');
    expect(parsed).toEqual({ timestamp: 1700000000, signatures: ['abc'] });
    expect(parseSignatureHeader('garbage')).toBeNull();
  });

  it('accepts a valid signature within tolerance', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = sign(payload, secret, now);
    expect(verifyWebhookSignature({ payload, header, secret })).toBe(true);
    expect(verifyWebhookSignature({ payload: Buffer.from(payload), header, secret })).toBe(true);
  });

  it('rejects a bad secret, a tampered payload, and a stale timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = sign(payload, secret, now);
    expect(verifyWebhookSignature({ payload, header, secret: 'whsec_other' })).toBe(false);
    expect(verifyWebhookSignature({ payload: payload + 'x', header, secret })).toBe(false);
    const stale = sign(payload, secret, now - 3600);
    expect(verifyWebhookSignature({ payload, header: stale, secret })).toBe(false);
  });
});

describe('retrieveReceipt', () => {
  afterEach(() => vi.restoreAllMocks());

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('expands the latest charge and returns its id and receipt URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        id: 'pi_1',
        latest_charge: { id: 'ch_1', receipt_url: 'https://pay.stripe.com/receipts/r1' },
      }),
    );
    await expect(retrieveReceipt('sk_test', 'pi_1')).resolves.toEqual({
      chargeId: 'ch_1',
      receiptUrl: 'https://pay.stripe.com/receipts/r1',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.stripe.com/v1/payment_intents/pi_1?expand[]=latest_charge');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
  });

  it('tolerates a missing charge (nulls, not a crash)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'pi_1' }));
    await expect(retrieveReceipt('sk_test', 'pi_1')).resolves.toEqual({
      chargeId: null,
      receiptUrl: null,
    });
  });

  it('surfaces Stripe errors as StripeApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'No such payment_intent' } }, 404),
    );
    await expect(retrieveReceipt('sk_test', 'pi_missing')).rejects.toThrow(StripeApiError);
  });
});

describe('checkout pricing', () => {
  it('prices known kinds and falls back for the rest', () => {
    expect(priceForKind('409a')).toBe(DEFAULT_PRICE_CENTS['409a']);
    expect(priceForKind('esop')).toBe(FALLBACK_PRICE_CENTS);
  });
});
