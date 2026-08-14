import { coverageConfigDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // test against shared sources so unit tests don't require a prebuild
      '@n409/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    // Collects the throwaway databases a killed or interrupted run leaked.
    // See test/globalSetup.ts — it is a no-op without a reachable Postgres, so
    // it costs a unit-only run nothing.
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    coverage: {
      // `scratchpad/` is the gitignored throwaway-probe directory (.gitignore:38).
      // Its scripts are not part of the service, and counting them was pulling
      // the whole-package line and function numbers down by whatever somebody
      // happened to have left in there — a floor that moves with uncommitted
      // local files is not a floor.
      // Spread rather than replace: `coverage.exclude` overrides the defaults
      // outright, and dropping them would pull `dist/`, the config files and
      // the tests themselves into the measurement.
      exclude: [...coverageConfigDefaults.exclude, 'scratchpad/**'],
      // Enforced coverage floor (audit P2-2). Set at the current measured level
      // (a point or two below) so CI can't silently regress — the TS analogue of
      // the Python services' `--cov-fail-under=80`. Ratchet upward over time.
      thresholds: {
        lines: 87,
        statements: 87,
        functions: 89,
        branches: 90,
      },
    },
  },
});
