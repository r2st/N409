import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      // Enforced coverage floor (audit P2-2). Set at the current measured level
      // (a point or two below) so CI can't silently regress — the TS analogue of
      // the Python services' `--cov-fail-under=80`. TS baselines are lower today;
      // ratchet these upward as coverage improves.
      thresholds: {
        lines: 73,
        statements: 73,
        functions: 66,
        branches: 82,
      },
    },
  },
});
