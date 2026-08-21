import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      // A stray file under the package root is counted at 0% and drags the
      // global figure down — `src/services/valuation/scratchpad/probe.mjs`,
      // written by a session running a relative-path script from the wrong cwd,
      // sat here gitignored and cost the floor most of a point locally while CI
      // (a clean checkout) never saw it. Excluding the pattern makes a local run
      // agree with CI instead of failing for a reason that is not in the repo.
      exclude: [...coverageConfigDefaults.exclude, '**/scratchpad/**'],
      // Enforced coverage floor (audit P2-2). Set at the current measured level
      // (a point or two below) so CI can't silently regress — the TS analogue of
      // the Python services' `--cov-fail-under=80`. Ratcheted as coverage
      // improves; the floor is only doing its job if it moves up behind the work.
      //
      // Was 73/73/66/82, from when otel.ts, index.ts and createLogger had no
      // tests at all. What is left uncovered is defensive branches that cannot
      // be reached from outside — a `?? ''` after String.split (which always
      // yields an element, but is typed as if it might not), the real-`fetch`
      // default in probeReady, and a catch around path.resolve. None of those is
      // worth a test that fakes the platform to reach it, so branches stops
      // short of the rest.
      //
      // The 99/99/100/96 written here had been *failing* on a clean checkout
      // since `startup.ts` landed with no shared-level tests at all (8.13%
      // lines) — invisible because `npm test` runs `vitest run` without
      // `--coverage`, so the floor only bit whoever asked for it. R87 covered
      // startup.ts and securityHeaders.ts and closed the systemdEnv parser's
      // reachable branches; measured now: 99.79 / 96.69 / 100 / 99.79.
      thresholds: {
        lines: 99.5,
        statements: 99.5,
        functions: 100,
        branches: 96.5,
      },
    },
  },
});
