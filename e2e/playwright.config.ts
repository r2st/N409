import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite: a real browser against the real stack.
 *
 * Three processes are started here rather than assumed to be running, so `npm
 * run e2e` is one command on a clean machine: the Python engine (3003), the
 * valuation API (3001), and the Vite dev server (5173) whose `/api` proxy
 * points at the API. The database is reset *before* Playwright starts — see
 * `reset-db.mjs` for why it cannot be a global-setup hook.
 *
 * `webServer.reuseExistingServer` is on outside CI: a developer iterating on
 * one spec should not pay a full stack boot per run. In CI it is off, so a
 * stale process can never be mistaken for a healthy one.
 */

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://n409:n409_dev@localhost:5432/n409_e2e';
const JWT_SECRET = process.env.E2E_JWT_SECRET ?? 'e2e-only-secret-change-me-0123456789abcdef';
// `localhost`, not `127.0.0.1`: Vite's dev server binds the hostname, which on
// this platform resolves to ::1 first, so the v4 literal simply refuses the
// connection and the webServer probe times out with nothing in the log.
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const ENGINE_URL = 'http://127.0.0.1:3003';

const repoRoot = new URL('..', import.meta.url).pathname;

export default defineConfig({
  testDir: './tests',
  outputDir: './.artifacts/test-results',
  // A cold stack plus an engine run is slower than the 30s default, and a
  // timeout that fires mid-calculation reads as a product bug rather than an
  // impatient test.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker: these tests share a single database and several of them assert
  // on list counts and dashboard totals, which are not isolated facts. Parallel
  // workers would make those assertions flake for reasons that have nothing to
  // do with the code under test.
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: './.artifacts/report', open: 'never' }]]
    : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // Registers the accounts and saves their signed-in storage state. Every
    // other project depends on it, so no spec has to log in through the form
    // except the one that is actually testing the login form.
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      command:
        '.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 3003 --log-level warning',
      cwd: `${repoRoot}src/services/engine-wrapper`,
      url: `${ENGINE_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev -w @n409/valuation',
      cwd: repoRoot,
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        DATABASE_URL,
        JWT_SECRET,
        ENGINE_URL,
        PORT: '3001',
        NODE_ENV: 'development',
        // Deterministic runs: mail goes to the outbox table instead of a
        // transport, and an upload does not kick off a background pipeline that
        // would race the assertions in the spec that made it.
        EMAIL_MODE: 'log',
        AUTO_PIPELINE: 'off',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'npm run dev -w @n409/web-frontend -- --port 5173 --strictPort',
      cwd: repoRoot,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
