import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      // Enforced coverage floor (audit P2-2). Set at the current measured level
      // (a point or two below) so CI can't silently regress — the TS analogue of
      // the Python services' `--cov-fail-under=80`. Ratcheted as coverage
      // improves; the floor is only doing its job if it moves up behind the work.
      //
      // Was 73/73/66/82, from when otel.ts, index.ts and createLogger had no
      // tests at all. Measured now: 99.76 / 100 / 96.84. What is left uncovered
      // is defensive branches that cannot be reached from outside — a `?? ''`
      // after String.split (which always yields an element, but is typed as if
      // it might not), the real-`fetch` default in probeReady, and a catch
      // around path.resolve. None of those is worth a test that fakes the
      // platform to reach it, so branches stops short of the rest.
      thresholds: {
        lines: 99,
        statements: 99,
        functions: 100,
        branches: 96,
      },
    },
  },
});
