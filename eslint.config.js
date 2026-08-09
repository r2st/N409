import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.venv/**',
      '.claude/**',
      'infra/**',
      'src/services/ai/**',
      'src/services/engine-wrapper/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
    },
  },
  /**
   * Type-checked promise rules, for the long-lived server processes only.
   *
   * A floating promise in a request handler is a bug; in a scheduler tick or a
   * fire-and-forget write it is an unhandled rejection, and an unhandled
   * rejection takes the process down. That is not hypothetical here — 66a0c79
   * fixed exactly that, an unawaited outbox insert, and it was found by reading
   * rather than by any check that would have caught the next one.
   *
   * Scoped to the services' `src` because that is where the cost lands: the
   * frontend's `onClick={async …}` is the ordinary React idiom and would report
   * ~300 times without a crash behind any of them, and the test files hold
   * deliberate un-awaited promises. Type-aware linting costs a few seconds over
   * this scope, which is worth it for the one class of bug that is fatal rather
   * than merely wrong.
   */
  {
    files: [
      'src/services/valuation/src/**/*.ts',
      'src/services/web/src/**/*.ts',
      'src/services/report/src/**/*.ts',
      'src/packages/shared/src/**/*.ts',
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['**/test/**', '**/*.test.ts', '**/vitest.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  /**
   * The dev scripts at the repo root — seeds and sample renders, run by hand
   * with `node`.
   *
   * They need the Node globals, and they need `console`: a script whose whole
   * purpose is to print what it did to a terminal is not the case `no-console`
   * is guarding against. That rule exists to keep stray logging out of the
   * long-lived services, where structured logging is the contract, and it stays
   * on everywhere else.
   */
  {
    // `e2e/*.mjs` is the same kind of script — `reset-db.mjs` drops and recreates
    // the end-to-end database and says so on stdout — and was missed because the
    // pattern above only reaches the repo root and `tools/`. It has been failing
    // the lint with seven `no-undef`s on `process` and `console` since the
    // harness landed.
    files: ['*.mjs', 'tools/**/*.mjs', 'e2e/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
);
