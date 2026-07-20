import { describe, expect, it } from 'vitest';
import { Semaphore } from '../../src/pipeline/semaphore.js';

const tick = () => new Promise((r) => setImmediate(r));

describe('Semaphore', () => {
  it('rejects a non-positive limit', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it('caps concurrency and queues the rest', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.activeCount).toBe(2);

    let third = false;
    const p3 = sem.acquire().then((rel) => {
      third = true;
      return rel;
    });
    await tick();
    expect(third).toBe(false); // blocked — no free slot
    expect(sem.pendingCount).toBe(1);

    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    expect(sem.activeCount).toBe(2);
    r2();
    r3();
    expect(sem.activeCount).toBe(0);
  });

  it('never runs more than max fns at once under a burst', async () => {
    const sem = new Semaphore(3);
    let running = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick();
        running -= 1;
      });
    await Promise.all(Array.from({ length: 20 }, task));
    expect(peak).toBeLessThanOrEqual(3);
    expect(sem.activeCount).toBe(0);
    expect(sem.pendingCount).toBe(0);
  });

  it('releases the slot even when the fn throws', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sem.activeCount).toBe(0);
    // A slot is available again.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('preserves FIFO order of waiters', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const hold = await sem.acquire();
    const waiters = [1, 2, 3].map((n) =>
      sem.run(async () => {
        order.push(n);
      }),
    );
    hold();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });
});
