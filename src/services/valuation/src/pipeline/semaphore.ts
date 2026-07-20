/**
 * A minimal counting semaphore used to bound in-process fan-out (B-3 §auto-pipeline).
 * The auto-pipeline is fire-and-forget: N simultaneous uploads would otherwise
 * spawn N concurrent orchestrations, each doing blocking AI + engine calls.
 * Acquire before running, release in a `finally`; excess work queues FIFO.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore max must be a positive integer, got ${max}`);
    }
  }

  /** Number of slots currently held. */
  get activeCount(): number {
    return this.active;
  }

  /** Number of acquirers waiting for a slot. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Resolves with a release function once a slot is free. */
  acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  /** Acquire, run fn, and always release. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
