import { describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { hashPassword } from '../../src/auth/password.js';
import { REAUTH_MAX_FAILURES, REAUTH_WINDOW_MS, verifyReauthPassword } from '../../src/auth/reauth.js';

/**
 * The re-authentication throttle. The budget is process-wide and keyed by user
 * id with no reset hook, so every test mints its own id rather than sharing one
 * — which is also the honest way to check that the budget really is per user.
 */
const PASSWORD = 'correct-horse-battery';
const digest = await hashPassword(PASSWORD);

const userId = () => newUlid();

/** Swallows the 429 so a test can count how many guesses got through. */
async function guess(id: string, password: string): Promise<'ok' | 'wrong' | 'throttled'> {
  try {
    return (await verifyReauthPassword(id, password, digest)) ? 'ok' : 'wrong';
  } catch (err) {
    if ((err as { status?: number }).status === 429) return 'throttled';
    throw err;
  }
}

describe('verifyReauthPassword', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const id = userId();
    expect(await verifyReauthPassword(id, PASSWORD, digest)).toBe(true);
    expect(await verifyReauthPassword(id, 'not-it', digest)).toBe(false);
  });

  it('stops answering once the failure budget is spent', async () => {
    const id = userId();
    for (let i = 0; i < REAUTH_MAX_FAILURES; i++) {
      expect(await guess(id, `wrong-${i}`)).toBe('wrong');
    }
    // The whole point: the prompt stops being an oracle.
    expect(await guess(id, 'wrong-again')).toBe('throttled');
  });

  it('refuses the correct password too once throttled', async () => {
    const id = userId();
    for (let i = 0; i < REAUTH_MAX_FAILURES; i++) await guess(id, `wrong-${i}`);
    // Otherwise the throttle would leak the answer: "not 429" would mean "right".
    expect(await guess(id, PASSWORD)).toBe('throttled');
  });

  it('charges failures only, so a legitimate owner never runs out', async () => {
    const id = userId();
    for (let i = 0; i < REAUTH_MAX_FAILURES * 3; i++) {
      expect(await guess(id, PASSWORD)).toBe('ok');
    }
  });

  it('keeps one user’s failures off another user’s budget', async () => {
    const attacked = userId();
    const bystander = userId();
    for (let i = 0; i < REAUTH_MAX_FAILURES; i++) await guess(attacked, `wrong-${i}`);

    expect(await guess(attacked, PASSWORD)).toBe('throttled');
    expect(await guess(bystander, PASSWORD)).toBe('ok');
  });

  it('counts a guess against an SSO-only account rather than waving it through', async () => {
    const id = userId();
    // No digest: nothing can match, but the attempts still have to be bounded,
    // or the endpoint becomes an unmetered probe for which accounts have one.
    for (let i = 0; i < REAUTH_MAX_FAILURES; i++) {
      expect(await verifyReauthPassword(id, 'anything', null)).toBe(false);
    }
    await expect(verifyReauthPassword(id, 'anything', null)).rejects.toMatchObject({ status: 429 });
  });

  it('throttles before doing the password hashing work', async () => {
    // scrypt is deliberately slow; the refusal must not pay for it, or the
    // throttle becomes the CPU-exhaustion vector it exists to prevent. Measured
    // against a real verify rather than a fixed millisecond bound, so a loaded
    // machine slows both sides of the comparison.
    const baselineStart = performance.now();
    await verifyReauthPassword(userId(), PASSWORD, digest);
    const baseline = performance.now() - baselineStart;

    const id = userId();
    for (let i = 0; i < REAUTH_MAX_FAILURES; i++) await guess(id, `wrong-${i}`);

    const started = performance.now();
    await expect(verifyReauthPassword(id, PASSWORD, digest)).rejects.toMatchObject({ status: 429 });
    expect(performance.now() - started).toBeLessThan(baseline / 2);
  });

  it('tells the caller how long the prompt stays shut', async () => {
    // The window is a quarter of an hour, and the refusal used to carry no
    // number at all — so the workspace showing this prompt had nothing to put
    // in front of the user but "try again later", and `PROBLEM_CATALOG` was
    // meanwhile telling clients to wait the stated number of seconds.
    const id = userId();
    for (let i = 0; i < REAUTH_MAX_FAILURES; i++) await guess(id, `wrong-${i}`);
    await expect(verifyReauthPassword(id, PASSWORD, digest)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: expect.any(Number),
    });
    const refused = await verifyReauthPassword(id, PASSWORD, digest).catch(
      (err: { retryAfterSeconds: number }) => err,
    );
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(REAUTH_WINDOW_MS / 1000);
  });
});
