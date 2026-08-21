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
      //
      // Measured at the ratchet below: statements/lines 97.51, functions 98.34,
      // branches 90.75. The first three had been left at a floor ten points
      // under what the suite actually reaches, which is not a floor — a change
      // could have dropped a tenth of the service's statements and still gone
      // green. Branches is the one that stays where it is: it is the binding
      // constraint with under a point of headroom, and the ~1,400 uncovered
      // branches behind that number are a long tail across 326 files rather
      // than a few neglected ones (the worst single file holds 28), so moving
      // it takes new tests spread widely rather than one more suite.
      //
      // Re-measured at R90 without touching the floors: statements/lines 96.90,
      // functions 98.64, branches 91.23. Statements/lines had drifted 0.6 down
      // from the figure above and was the *tightest* of the four; recorded
      // rather than acted on, with a note that whoever ratcheted next should
      // raise it first.
      //
      // R91 did, by covering rather than by lowering the bar to meet. Two files
      // carried most of the gap: `db/poolHealth.ts` — the connection-leak
      // detector, the only thing that can answer "why is the pool exhausted"
      // with a line number — was at 0%, and `hooks/pipelineRetry.ts` at 28%.
      // Both are now covered, and the second turned up a real hole while being
      // written (see REVISION R91). Measured after: statements/lines 97.33,
      // functions 98.69, branches 91.24.
      //
      // Statements/lines and functions go up. Branches deliberately does not,
      // and the reason is worth writing down rather than rediscovering: 91
      // would leave 0.24 points of headroom, which against ~15,000 branches is
      // about 36 of them — one new module's worth. A floor that a routine
      // addition trips is a floor somebody lowers under time pressure, and a
      // lowered floor is worth less than the one that was never raised. The
      // ~1,300 uncovered branches behind that number are still a long tail
      // across 300-odd files rather than a few neglected ones, so moving it
      // takes tests spread widely rather than one more suite.
      thresholds: {
        lines: 97,
        statements: 97,
        functions: 98,
        branches: 90,
      },
    },
  },
});
