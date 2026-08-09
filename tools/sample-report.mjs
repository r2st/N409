/**
 * Generate one real 409A deliverable end to end, against the real engine.
 *
 * Not a test — a rehearsal, and the thing tests are bad at. It seeds a company
 * with a cap table an analyst would recognise, runs the actual engine over it,
 * renders the actual PDF, and prints the engine's answer beside the figures the
 * deliverable ends up carrying, so both can be read by a person.
 *
 * Every assertion in the suite passed while the executive summary printed its
 * key assumptions as `<2c"RrT 4.00y`, the value bridge lost the minus sign on
 * both discounts, the cover broke across two pages mid-fact, and the Conclusion
 * of Value chapter said "$ … per share" three pages after the summary said
 * $1.2242. None of that is visible from inside a unit test, because a test
 * asserts what somebody already thought to check.
 *
 * Usage — needs Postgres up (`npm run dev:db`) and the engine on :8799:
 *
 *     cd src/services/engine-wrapper && .venv/bin/python -m uvicorn app.main:app --port 8799 &
 *     npm run build && node tools/sample-report.mjs
 *
 * Writes `sample-409a.pdf` and `sample-results.json` to OUT (default: cwd), and
 * drops the throwaway database on the way out.
 */
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const ROOT = new URL('../src/services/valuation', import.meta.url).pathname;
const { migrate } = await import(`${ROOT}/dist/db/migrate.js`);
const { buildApp } = await import(`${ROOT}/dist/app.js`);
const { loadConfig } = await import(`${ROOT}/dist/config.js`);
const { createUser } = await import(`${ROOT}/dist/repos/users.js`);
const { hashPassword } = await import(`${ROOT}/dist/auth/password.js`);
const { newUlid } = await import('@n409/shared');

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://n409:n409_dev@localhost:5432/n409_dev';
const OUT = process.env.OUT ?? process.cwd();

const dbName = `n409_sample_${randomBytes(5).toString('hex')}`;
const admin = new pg.Client({ connectionString: BASE_URL });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();
const url = new URL(BASE_URL);
url.pathname = `/${dbName}`;
const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
await migrate(pool);

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  JWT_SECRET: 'sample-report-secret-0123456789abcdef',
  LOG_LEVEL: 'warn',
  ENGINE_URL: 'http://127.0.0.1:8799',
});
const app = buildApp({ config, pool });
await app.ready();

const seed = async (roles) => {
  const email = `${randomBytes(4).toString('hex')}@example.com`;
  const password = 'test-password-123';
  const user = await createUser(pool, {
    email,
    passwordDigest: await hashPassword(password),
    roles,
    partnerId: null,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return { id: user.id, token: res.json().token };
};

const ops = await seed(['admin']);
const client = await seed(['valuation_user']);
const auth = (t) => ({ authorization: `Bearer ${t}` });

const call = async (method, path, token, payload) => {
  const res = await app.inject({ method, url: path, headers: auth(token), payload });
  if (res.statusCode >= 400) {
    console.error(`!! ${method} ${path} → ${res.statusCode}`, res.body.slice(0, 600));
  }
  return res;
};

// ── A company an analyst would recognise ─────────────────────────────────────
// Series B SaaS: $18M raised, $9.4M LTM revenue, a real preference stack.
const created = await call('POST', '/api/v1/valuations', client.token, {
  kind: '409a',
  company_name: 'Northwind Robotics, Inc.',
});
const vid = created.json().valuation.id;

await call('PATCH', `/api/v1/valuations/${vid}/params`, ops.token, {
  weight_asset: 0,
  weight_opm: 0.4,
  weight_income: 0.25,
  weight_market: 0.35,
  dloc: 0.08,
  dlom_method: 'finnerty',
  allocation_method: 'opm',
  market_method: 'revenue',
  market_horizon: 'ltm',
  exit_timeline: '2030-06-30',
});

await call('PATCH', `/api/v1/valuations/${vid}/engine-inputs`, ops.token, {
  valuation_date: '2026-06-30',
  shares_outstanding_common: 9_250_000,
  options_outstanding: 1_750_000,
  shares_outstanding_preferred: 6_400_000,
  liquidation_preference: 18_000_000,
  volatility: 0.62,
  risk_free_rate: 0.0421,
  cash: 6_200_000,
  debt: 1_400_000,
  last_round_post_money: 72_000_000,
  last_round_price_per_share: 2.8125,
  income: {
    free_cash_flows: [-2_100_000, 400_000, 3_800_000, 7_900_000, 12_400_000],
    discount_rate: 0.28,
    terminal_growth: 0.03,
  },
  market: { metric: 9_400_000, multiples: [7.4, 6.1, 8.8, 5.9] },
});

const calc = await call('POST', `/api/v1/valuations/${vid}/calculations`, ops.token, {});
const calculation = calc.json().calculation;
console.log('\n── ENGINE OUTPUT ──────────────────────────────────────────────');
console.log(JSON.stringify(calculation.results, null, 1));

const detail = await call('GET', `/api/v1/valuations/${vid}/calculations/${calculation.id}`, ops.token);
console.log('\n── ENGINE STEPS ───────────────────────────────────────────────');
for (const s of detail.json().steps) {
  console.log(`${s.seq}. ${s.label} [${s.status}] ${s.note ?? ''}`);
}

// Draft the report so there is a body to render, then render the PDF.
await call('POST', `/api/v1/valuations/${vid}/report/draft`, ops.token, {});
const report = await call('GET', `/api/v1/valuations/${vid}/report`, ops.token);
console.log('\n── REPORT SECTIONS ────────────────────────────────────────────');
const content = report.json().version?.content;
if (content) {
  content.sections.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.heading}`));
} else {
  console.log('(no draft)', JSON.stringify(report.json()).slice(0, 400));
}

const pdfRes = await call('GET', `/api/v1/valuations/${vid}/report.pdf`, ops.token);
if (pdfRes.statusCode === 200) {
  writeFileSync(`${OUT}/sample-409a.pdf`, pdfRes.rawPayload);
  console.log(`\nPDF: ${OUT}/sample-409a.pdf (${pdfRes.rawPayload.length} bytes)`);
}

writeFileSync(`${OUT}/sample-results.json`, JSON.stringify(calculation.results, null, 2));

await app.close();
await pool.end();
const drop = new pg.Client({ connectionString: BASE_URL });
await drop.connect();
await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await drop.end();
