import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@n409/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      // Enforced coverage floor (audit P2-2), matching the other packages. This
      // one was missing: `web` is the only service the public internet talks to
      // directly — it terminates the proxy, sets the cache headers and serves
      // the SPA — and it was the one package whose coverage could regress to
      // zero without CI noticing.
      //
      // Set a point or two below the current measured level so it catches a
      // real regression rather than normal drift. Ratchet upward over time.
      // `index.ts` (the listen/signal bootstrap) is 0% and pulls the whole-file
      // numbers down about 11 points; it is left in rather than excluded,
      // because excluding the part nobody tests is how a floor stops meaning
      // anything. app.ts itself is at 94%.
      thresholds: {
        lines: 81,
        statements: 81,
        functions: 81,
        branches: 85,
      },
    },
  },
});
