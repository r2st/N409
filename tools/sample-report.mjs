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
 * or, doing all of that for you:  npm run sample:report
 *
 * Writes `sample-409a.pdf` and `sample-results.json` to OUT (default: cwd), and
 * drops the throwaway database on the way out.
 *
 * Exits non-zero on a failed step. It used to press on regardless and then die
 * on `calculation.results` of an undefined calculation — a stack trace naming
 * this file for an engine that was not running, which is the one failure the
 * script exists to make obvious.
 */
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { inflateSync as zlibInflate } from 'node:zlib';

const ROOT = new URL('../src/services/valuation', import.meta.url).pathname;
const { migrate } = await import(`${ROOT}/dist/db/migrate.js`);
const { buildApp } = await import(`${ROOT}/dist/app.js`);
const { loadConfig } = await import(`${ROOT}/dist/config.js`);
const { createUser } = await import(`${ROOT}/dist/repos/users.js`);
const { hashPassword } = await import(`${ROOT}/dist/auth/password.js`);

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

/** Drop the throwaway database, on every exit path including the failing ones. */
let cleanedUp = false;
const cleanup = async () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    await app?.close();
  } catch {
    /* already closed */
  }
  await pool.end().catch(() => {});
  const drop = new pg.Client({ connectionString: BASE_URL });
  await drop.connect();
  await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await drop.end();
};

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

let failed = 0;
const call = async (method, path, token, payload) => {
  const res = await app.inject({ method, url: path, headers: auth(token), payload });
  if (res.statusCode >= 400) {
    failed += 1;
    console.error(`!! ${method} ${path} → ${res.statusCode}`, res.body.slice(0, 600));
  }
  return res;
};

/** Stop at the first step whose failure makes everything after it meaningless. */
const must = async (method, path, token, payload) => {
  const res = await call(method, path, token, payload);
  if (res.statusCode >= 400) {
    console.error(
      `\nAborting: ${method} ${path} failed. ` +
        (path.endsWith('/calculations')
          ? 'Is the engine running on :8799? See the usage note at the top of this file.'
          : ''),
    );
    await cleanup();
    process.exit(1);
  }
  return res;
};

// ── A company an analyst would recognise ─────────────────────────────────────
// Series B SaaS: $18M raised, $9.4M LTM revenue, a real preference stack.
const created = await must('POST', '/api/v1/valuations', client.token, {
  kind: '409a',
  company_name: 'Northwind Robotics, Inc.',
});
const vid = created.json().valuation.id;

await must('PATCH', `/api/v1/valuations/${vid}/params`, ops.token, {
  weight_asset: 0,
  weight_opm: 0.4,
  weight_income: 0.25,
  weight_market: 0.35,
  dloc: 0.08,
  dlom_method: 'finnerty',
  // ALLOCATION=monte_carlo exercises the simulated path end to end.
  allocation_method: process.env.ALLOCATION ?? 'opm',
  market_method: 'revenue',
  market_horizon: 'ltm',
  exit_timeline: '2030-06-30',
});

await must('PATCH', `/api/v1/valuations/${vid}/engine-inputs`, ops.token, {
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
  // The round closed in October and this valuation is dated the following June.
  // Exercising the adjustment here is the point: the deliverable has to be able
  // to say what moved between the two, and Exhibit B has to show both figures.
  market_movement: {
    index_name: 'S&P North American Technology Software Index',
    index_start: 4_812.6,
    index_end: 4_390.1,
    period_start: '2025-10-15',
    period_end: '2026-06-30',
    beta: 1.15,
  },
  // The cap table. Required by the Monte Carlo allocation, and it upgrades the
  // OPM run from a single blended preference to the full breakpoint waterfall.
  share_classes: [
    { kind: 'preferred', name: 'Series B', shares: 4_000_000, preference: 12_000_000, seniority: 1 },
    { kind: 'preferred', name: 'Series A', shares: 2_400_000, preference: 6_000_000, seniority: 2 },
    { kind: 'common', name: 'Common', shares: 9_250_000 },
    { kind: 'option', name: 'Option pool', shares: 1_750_000, strike: 0.55 },
  ],
});

const calc = await must('POST', `/api/v1/valuations/${vid}/calculations`, ops.token, {});
const calculation = calc.json().calculation;
console.log('\n── ENGINE OUTPUT ──────────────────────────────────────────────');
console.log(JSON.stringify(calculation.results, null, 1));

const detail = await call('GET', `/api/v1/valuations/${vid}/calculations/${calculation.id}`, ops.token);
console.log('\n── ENGINE STEPS ───────────────────────────────────────────────');
for (const s of detail.json().steps ?? []) {
  console.log(`${s.seq}. ${s.label} [${s.status}] ${s.note ?? ''}`);
}

// Draft the report from the kind's current skeleton, then render the PDF.
const drafted = await must('POST', `/api/v1/valuations/${vid}/report/draft`, ops.token, {});
const report = await must('GET', `/api/v1/valuations/${vid}/report`, ops.token);
console.log('\n── REPORT SECTIONS ────────────────────────────────────────────');
console.log(`template ${drafted.json().template_version}`);
const content = report.json().version?.content;
if (content) {
  content.sections.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.heading}`));
} else {
  console.log('(no draft)', JSON.stringify(report.json()).slice(0, 400));
}

const pdfRes = await must('GET', `/api/v1/valuations/${vid}/report.pdf`, ops.token);
writeFileSync(`${OUT}/sample-409a.pdf`, pdfRes.rawPayload);
console.log(`\nPDF: ${OUT}/sample-409a.pdf (${pdfRes.rawPayload.length} bytes)`);

writeFileSync(`${OUT}/sample-results.json`, JSON.stringify(calculation.results, null, 2));

/*
 * The check the whole rehearsal exists for.
 *
 * A deliverable whose Conclusion of Value chapter reads "$ … per share" three
 * pages after the summary page printed $1.4947 passes every unit test in the
 * suite, because a test asserts what somebody already thought to check. So the
 * finished PDF is searched for the leftovers: an unresolved `{{placeholder}}`
 * means a figure the body asked for and the calculation did not supply, and a
 * bare "$ …" means a figure nobody wired up at all.
 */
const readable = () => {
  const raw = pdfRes.rawPayload;
  const out = [];
  // Streams are Flate-compressed; the text inside them is hex-encoded runs.
  for (const m of raw.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      out.push(zlibInflate(Buffer.from(m[1], 'latin1')).toString('latin1'));
    } catch {
      /* not a Flate stream */
    }
  }
  return out
    .join('\n')
    .replace(/<([0-9a-fA-F]+)>/g, (_, hex) =>
      Buffer.from(hex, 'hex').toString('utf16le').replaceAll('\u0000', ''),
    );
};
const text = readable();
const leftovers = [...new Set([...text.matchAll(/\{\{\w+\}\}/g)].map((m) => m[0]))];
console.log('\n── UNFILLED FIGURES ───────────────────────────────────────────');
if (leftovers.length === 0) {
  console.log('none — every placeholder in the body resolved');
} else {
  failed += 1;
  console.log(`!! ${leftovers.length} unresolved: ${leftovers.join(', ')}`);
}

/*
 * The other marker class, which this script described and never looked for.
 *
 * `{{placeholder}}` is the calculation's to fill and its survival is a failure.
 * An ellipsis is the *analyst's* to fill (domain/reportReadiness.ts), so it is
 * expected in a rehearsal nobody has written narrative into — printing it is
 * still the point, because "$ … per share" reaching a rendered page is exactly
 * what this file exists to make visible, and reading the list is how you tell
 * an ASC 718 table awaiting per-grant data from a Conclusion of Value that lost
 * its figure.
 *
 * It does not fail the run. A freshly drafted skeleton is *supposed* to carry
 * these — that is what the marker means — so exiting non-zero on them would make
 * the rehearsal red in its normal state and stop anyone reading the rest. The
 * sections `reportReadiness` would refuse a publish on are marked, so the list
 * says which of them an analyst has to reach before this could be delivered.
 */
const BLOCKING = /conclusion of value|asc\s*718/i;
const ellipses = content?.sections?.filter((s) => /[…]|\.\.\./.test(s.html)) ?? [];
console.log('\n── AWAITING THE ANALYST (ellipsis markers) ────────────────────');
if (ellipses.length === 0) {
  console.log('none');
} else {
  for (const s of ellipses) {
    console.log(`  ${s.heading}${BLOCKING.test(s.heading) ? '  ← would block a publish' : ''}`);
  }
}

await cleanup();
if (failed > 0) {
  console.error(`\n${failed} step(s) failed.`);
  process.exit(1);
}
