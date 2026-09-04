import { describe, expect, it } from 'vitest';
import { readDiskSpace, registerDiskMetrics } from '../src/diskSpace.js';
import { MetricsRegistry } from '../src/prometheus.js';

/**
 * The other finite resource on this box (R353, methodology M11).
 *
 * Memory has had a ceiling since R99, a reading of it since R337 and four rules
 * since. The disk had nothing: PostgreSQL refusing writes, uploads failing at
 * `open`, the nightly dump having nowhere to land and the journal dropping the
 * lines that describe all three are the four symptoms of a full volume, and not
 * one of them names the disk. What was missing is the part with lead time.
 */

/** A filesystem of a chosen size, in 4 KiB blocks. */
const fs = (totalGiB: number, availGiB: number) => ({
  bsize: 4096,
  blocks: (totalGiB * 1024 ** 3) / 4096,
  bavail: (availGiB * 1024 ** 3) / 4096,
});

describe('reading a filesystem', () => {
  it('reports the space this process may use, not the space root may use', () => {
    // ext4 reserves 5% of a volume for root by default, so `bfree` stays
    // comfortable while an unprivileged writer is already getting ENOSPC.
    // `bavail` is the number that decides whether the next upload lands.
    const d = readDiskSpace('/anything', { statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 100 }) });
    expect(d.total).toBe(4_096_000);
    expect(d.available).toBe(409_600);
  });

  it('reads the real filesystem when nothing is injected', () => {
    const d = readDiskSpace(process.cwd());
    expect(d.total).toBeGreaterThan(0);
    expect(d.available).toBeGreaterThanOrEqual(0);
  });
});

describe('the disk gauges', () => {
  it('name the role rather than the device', () => {
    // What an operator needs first is what stops working, which `/dev/sda1`
    // does not say — the same reason the readiness checks are named `valuation`
    // and `ai` rather than for their hostnames.
    const registry = new MetricsRegistry();
    const roles = registerDiskMetrics(registry, { documents: '/srv/n409/documents' }, { statfs: () => fs(40, 4) });

    expect(roles).toEqual(['documents']);
    const text = registry.render();
    expect(text).toContain(`n409_disk_total_bytes{mount="documents"} ${40 * 1024 ** 3}`);
    expect(text).toContain(`n409_disk_available_bytes{mount="documents"} ${4 * 1024 ** 3}`);
  });

  it('registers no reading for a path that cannot be read, and says that it did not', () => {
    /*
     * Decided once, at registration, so a misconfigured directory is a fact
     * about the boot rather than a gauge that throws on every scrape for ever
     * — and, since R428, a fact with a witness.
     *
     * The drop used to publish nothing at all. Both disk rules are
     * gauge-backed, so a `DOCUMENTS_DIR` that was not there when the unit
     * started took `DiskFillingUp` and `DiskNearlyFull` off the box for the
     * life of the process, and an absent series is exactly what a healthy
     * filesystem looks like. `n409_disk_watched` is the absence stated as a
     * value, minted for every role that was *asked* about rather than every
     * role that answered.
     */
    const registry = new MetricsRegistry();
    const roles = registerDiskMetrics(
      registry,
      { documents: '/no/such/place' },
      {
        statfs: () => {
          throw new Error('ENOENT');
        },
      },
    );
    expect(roles).toEqual([]);
    const text = registry.render();
    // No reading, because a path that cannot be stat'ed is not a full disk.
    expect(text).not.toContain('n409_disk_available_bytes');
    expect(text).not.toContain('n409_disk_total_bytes');
    // But the role is still named, at zero.
    expect(text).toContain('n409_disk_watched{mount="documents"} 0');
  });

  it('reports a watched role as watched', () => {
    const registry = new MetricsRegistry();
    registerDiskMetrics(registry, { documents: '/srv/n409/documents' }, { statfs: () => fs(40, 4) });
    expect(registry.render()).toContain('n409_disk_watched{mount="documents"} 1');
  });

  it('names every role it was asked about, not only the ones that answered', () => {
    // The property the rule rests on: one bad path among several must not be
    // indistinguishable from a deployment that never configured it.
    const registry = new MetricsRegistry();
    const roles = registerDiskMetrics(
      registry,
      { backups: '/no/such/place', documents: '/srv/n409/documents' },
      {
        statfs: (path: string) => {
          if (path === '/no/such/place') throw new Error('ENOENT');
          return fs(40, 4);
        },
      },
    );
    expect(roles).toEqual(['documents']);
    const text = registry.render();
    expect(text).toContain('n409_disk_watched{mount="backups"} 0');
    expect(text).toContain('n409_disk_watched{mount="documents"} 1');
    expect(text).toContain('n409_disk_available_bytes{mount="documents"}');
    expect(text).not.toContain('n409_disk_available_bytes{mount="backups"}');
  });

  it('goes absent and countable rather than reporting a full disk it did not measure', () => {
    /*
     * The one decision in this module. A path that cannot be stat'ed is not a
     * filesystem with zero bytes free, and the two readings are opposite
     * instructions to whoever is woken — so the collect is deliberately left
     * unguarded, and `MetricsRegistry.render` does what R341 built it to do:
     * drop the gauge, count the failure, and let `MetricCollectFailing` say
     * that a gauge is missing and its rules are matching nothing.
     */
    const registry = new MetricsRegistry();
    let readable = true;
    registerDiskMetrics(
      registry,
      { documents: '/srv/n409/documents' },
      {
        statfs: () => {
          if (!readable) throw new Error('EIO');
          return fs(40, 4);
        },
      },
    );
    expect(registry.render()).toContain('n409_disk_available_bytes{mount="documents"}');

    readable = false;
    const text = registry.render();
    expect(text, 'a zero here would read as a full disk').not.toContain('n409_disk_available_bytes{');
    expect(text).toContain('n409_metric_collect_failures_total{metric="n409_disk_available_bytes"} 1');
  });

  it('is registered on the valuation app, or the rules watch nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(path.resolve(here, '../../../services/valuation/src/app.ts'), 'utf8');
    expect(app).toContain('registerDiskMetrics(metricsRegistry, diskRoles)');
    expect(app).toContain('documents: config.DOCUMENTS_DIR');
  });

  it('is registered by a caller that reads the answer', async () => {
    /*
     * The other half of the same registration (R428).
     *
     * This function has always returned the roles it registered, and the note
     * on it says why — "so a caller can say so at boot rather than assume".
     * The one caller assumed. A returned value nobody reads is the same shape
     * as the `onStateChange` hook R313 found with no subscriber: the
     * affordance built to prevent exactly this failure, present and inert.
     */
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(path.resolve(here, '../../../services/valuation/src/app.ts'), 'utf8');
    expect(app).toMatch(/const \w+ = registerDiskMetrics\(/);
    // …and does something with it that reaches a person.
    expect(app).toContain('disk free space cannot be read for a configured path');
    expect(app).toContain('alert: true');
  });
});
