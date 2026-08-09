// Seed a live ops user + engagement in the dev database, then drive a
// calculation so the network log has rows to render. The engine wrapper is not
// running, which is exactly the interesting case: the failed call is recorded.
import pg from 'pg';
import { createUser } from './src/services/valuation/dist/repos/users.js';
import { hashPassword } from './src/services/valuation/dist/auth/password.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const email = 'netlog-demo@test.example.com';
const password = 'test-password-123';

await pool.query('DELETE FROM users WHERE email = $1', [email]);
const user = await createUser(pool, {
  email,
  passwordDigest: await hashPassword(password),
  roles: ['admin'],
  partnerId: null,
});
console.log('seeded user', user.id);
await pool.end();

const base = 'http://127.0.0.1:3001/api/v1';
const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const { token } = await login.json();
console.log('token ok:', Boolean(token));

const created = await fetch(`${base}/valuations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ kind: '409a', company_name: 'Netlog Demo Co' }),
});
const valuation = (await created.json()).valuation;
console.log('valuation', valuation.id);

await fetch(`${base}/valuations/${valuation.id}/params`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ weight_income: 1, weight_asset: 0, weight_opm: 0, weight_market: 0, dlom: 0.25 }),
});
await fetch(`${base}/valuations/${valuation.id}/engine-inputs`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    shares_outstanding_common: 8000000,
    income: { free_cash_flows: [1e6, 2e6], discount_rate: 0.25, terminal_growth: 0.03 },
  }),
});

// The engine is down, so this fails — and the failure is the row worth seeing.
const calc = await fetch(`${base}/valuations/${valuation.id}/calculations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({}),
});
console.log('calculation status', calc.status);

await new Promise((r) => setTimeout(r, 1500));
const log = await fetch(`${base}/valuations/${valuation.id}/network-items`, {
  headers: { authorization: `Bearer ${token}` },
});
console.log('network log:', JSON.stringify(await log.json(), null, 2).slice(0, 1200));
console.log('\nLOGIN:', email, password);
console.log('URL: /valuations/' + valuation.id + '/network');
