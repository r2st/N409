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
      // one was missing, and it is the service that renders the document a
      // client actually receives and an auditor actually reads — a regression
      // here ships a malformed PDF, not a 500 someone notices.
      //
      // Floors sit a point or two under the measured level (98% statements,
      // 92% branches — pdf.ts is effectively fully exercised by the typography
      // tests). `index.ts` (the listen/signal bootstrap) is 0% and is left in
      // rather than excluded, for the same reason as in `web`.
      thresholds: {
        lines: 96,
        statements: 96,
        functions: 96,
        branches: 89,
      },
    },
  },
});
