/**
 * Seed the three sample engagements, end to end, through the real API.
 *
 * The live site had nothing on it. A visitor who signed in saw four `pending`
 * rows dated July and nothing else — and behind them every screen that makes
 * this product worth looking at (the workbook, the exhibits, the calculation
 * inspector, the report editor, the discount derivations) renders as an empty
 * frame until an engagement has actually been through the engine.
 *
 * Three of those four were deployment checks, owned by `@n409.test` and
 * `@test.local` addresses. The fourth, `SimplEquation`, belongs to a real
 * person's account and is not ours to touch — which is the reason `--purge`
 * takes exact ids and has no pattern form. "Everything pending from July" would
 * have swept up a client.
 *
 * This drives `src/services/valuation/src/domain/sampleEngagements.ts` through
 * the same endpoints an analyst uses — create, profile, params, engine inputs,
 * workbook, comparables, calculate, draft, narrative, ASC 718, sign, QA,
 * publish — and then reads the rendered PDF back and fails if it still carries
 * an unfilled figure. Nothing is written directly to a table, on purpose: a
 * sample is then only ever as good as the API that made it, and a seeded
 * engagement that the product itself could not have produced is not a sample,
 * it is a lie about the product.
 *
 * Usage (local — needs Postgres, the engine on :8799, and the valuation API):
 *
 *     npm run build
 *     cd src/services/engine-wrapper && .venv/bin/python -m uvicorn app.main:app --port 8799 &
 *     DATABASE_URL=... JWT_SECRET=... node src/services/valuation/dist/index.js &
 *     node tools/seed-samples.mjs
 *
 * Usage (production — run it on the host, where /opt/N409/.env already has
 * everything and the API is on 127.0.0.1:3001):
 *
 *     cd /opt/N409 && set -a && . ./.env && set +a && node tools/seed-samples.mjs --replace
 *
 * Options:
 *   --replace          retire any existing valuation whose company name matches
 *                      a sample, then re-seed it. Without this, a name already
 *                      present is skipped rather than duplicated.
 *   --purge=A,B,C      retire these valuation ids first (the July smoke tests).
 *                      Exact ids only — there is no pattern form. "Retire" is
 *                      archive-and-rename, not delete: `valuation_events` is
 *                      append-only behind a compliance trigger, so nothing here
 *                      can hard-delete an engagement. See repos/valuationPurge.
 *   --only=key         seed one sample: saas | biotech | manufacturing.
 *   --keep-draft       stop before publishing, leaving the engagements in
 *                      'draft_accepted' with the report rendered.
 *   --dry-run          print the plan and touch nothing.
 *
 * Environment:
 *   DATABASE_URL       required — used to mint the ops token and to retire rows.
 *   API_URL            valuation API base (default http://127.0.0.1:3001).
 *   JWT_SECRET, JWT_ISSUER
 *                      required — the token is minted for an existing admin.
 *   SEED_ACTOR_EMAIL   the admin the seeding acts as (default: the oldest admin).
 *   SEED_OWNER_EMAIL   the client account that owns the samples
 *                      (default samples@n409.aiknol.com, created if absent).
 *
 * Exits non-zero if any step fails or any rendered report still carries an
 * unresolved `{{placeholder}}` or an analyst ellipsis.
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { pdfText as extractPdfText, stripDotLeaders } from './pdf-text.mjs';

const ROOT = new URL('../src/services/valuation/dist', import.meta.url).pathname;
const { SAMPLE_ENGAGEMENTS, asc718SectionHtml } = await import(`${ROOT}/domain/sampleEngagements.js`);
const { retireValuations, findValuationIdsByCompanyName } = await import(`${ROOT}/repos/valuationPurge.js`);
const { signSession } = await import(`${ROOT}/auth/jwt.js`);
const { createUser } = await import(`${ROOT}/repos/users.js`);
const { hashPassword } = await import(`${ROOT}/auth/password.js`);
const { upsertPreference } = await import(`${ROOT}/repos/notificationPreferences.js`);

// ── options ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const unknown = argv.filter(
  (a) => !/^--(replace|dry-run|keep-draft|help)$/.test(a) && !/^--(purge|only)=/.test(a),
);
if (unknown.length > 0) {
  console.error(`seed-samples: unknown argument ${unknown[0]}`);
  process.exit(2);
}
if (flag('help')) {
  console.log(
    'usage: node tools/seed-samples.mjs [--replace] [--purge=ID,ID] [--only=key] [--keep-draft] [--dry-run]',
  );
  process.exit(0);
}

const REPLACE = flag('replace');
const DRY_RUN = flag('dry-run');
const KEEP_DRAFT = flag('keep-draft');
const PURGE_IDS = (opt('purge') ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const ONLY = opt('only');

const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? 'samples@n409.aiknol.com';

if (!DATABASE_URL) die('DATABASE_URL is required');
if (!process.env.JWT_SECRET) die('JWT_SECRET is required (it must match the running API)');

const samples = ONLY ? SAMPLE_ENGAGEMENTS.filter((s) => s.key === ONLY) : [...SAMPLE_ENGAGEMENTS];
if (samples.length === 0) {
  die(`--only=${ONLY} matches nothing; keys are ${SAMPLE_ENGAGEMENTS.map((s) => s.key).join(', ')}`);
}

function die(message) {
  console.error(`seed-samples: ${message}`);
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

// ── who we act as, and who owns the result ───────────────────────────────────

/**
 * The token is minted rather than obtained by logging in, because there is no
 * password this script is entitled to know. `session_epoch` has to come from
 * the row: a token minted without it reads as epoch 0, which is a *revoked*
 * token for any account that has ever signed out everywhere.
 */
async function opsToken() {
  const email = process.env.SEED_ACTOR_EMAIL;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.session_epoch, u.partner_id,
            array_agg(r.key ORDER BY r.key) AS roles
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE ($1::text IS NULL OR u.email = $1)
      GROUP BY u.id
     HAVING array_agg(r.key) && ARRAY['admin','reviewer','analyst','ops']
      ORDER BY u.created_at
      LIMIT 1`,
    [email ?? null],
  );
  const actor = rows[0];
  if (!actor) {
    die(
      email
        ? `no operations account found for SEED_ACTOR_EMAIL=${email}`
        : 'no operations account exists in this database — nothing can be seeded as ops',
    );
  }
  const token = await signSession(
    {
      sub: actor.id,
      roles: actor.roles,
      partner_id: actor.partner_id ?? null,
      session_epoch: actor.session_epoch ?? 0,
    },
    {
      secret: process.env.JWT_SECRET,
      issuer: process.env.JWT_ISSUER ?? 'n409',
      ttlSeconds: 3600,
    },
  );
  return { actor, token };
}

/**
 * The client account the samples belong to.
 *
 * Deliberately not the operator's own login. Publishing an engagement fires the
 * workflow emails, and pointing those at a person who did not ask for three
 * fictional valuations is a poor way to demonstrate a product. The account is
 * created with a random password nobody keeps, and every workflow email is
 * switched off for it through the product's own notification preferences —
 * in-app notifications stay on, because an empty notification bell is one of
 * the things these samples exist to fill.
 */
const EMAIL_EVENT_TYPES = [
  'valuation_started',
  'review_needed',
  'draft_ready',
  'valuation_completed',
  'valuation_cancelled',
];

async function sampleOwner() {
  const found = await pool.query('SELECT id, email FROM users WHERE email = $1', [OWNER_EMAIL]);
  let owner = found.rows[0];
  if (!owner) {
    if (DRY_RUN) return { id: '(created on apply)', email: OWNER_EMAIL, created: true };
    const created = await createUser(pool, {
      email: OWNER_EMAIL,
      passwordDigest: await hashPassword(randomBytes(24).toString('hex')),
      roles: ['valuation_user'],
      partnerId: null,
    });
    owner = { id: created.id, email: created.email };
  }
  if (!DRY_RUN) {
    for (const eventType of EMAIL_EVENT_TYPES) {
      await upsertPreference(pool, owner.id, eventType, { in_app: true, email: false });
    }
  }
  return owner;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

let token = '';
let failures = 0;

async function call(method, path, body, { raw = false } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer: buf };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON — keep the text for the error message */
  }
  return { status: res.status, json, text };
}

/** A step whose failure makes everything after it meaningless. */
async function must(method, path, body, opts) {
  const res = await call(method, path, body, opts);
  if (res.status >= 400) {
    failures += 1;
    throw new Error(
      `${method} ${path} → ${res.status} ${(res.text ?? '').slice(0, 800)}` +
        (path.endsWith('/calculations') ? '\n  (is the engine reachable at the API’s ENGINE_URL?)' : ''),
    );
  }
  return res;
}

// ── the rendered deliverable, read back as text ──────────────────────────────

/**
 * Pull readable text out of the PDF the API just produced.
 *
 * The same helper `tools/sample-report.mjs` uses, and for the same reason: the
 * assertion worth making is about the *document*, not about the JSON that
 * preceded it. A report whose Conclusion of Value reads "$ ... per share" three
 * pages after the summary printed a figure passes every unit test in the suite.
 */
const pdfText = (buffer) => extractPdfText(buffer, { inflateSync });

// ── seeding one engagement ───────────────────────────────────────────────────

async function seed(sample, ownerId) {
  const log = (msg) => console.log(`   ${msg}`);

  const created = await must('POST', '/api/v1/valuations', {
    kind: '409a',
    company_name: sample.companyName,
    service_name: sample.serviceName,
    user_id: ownerId,
  });
  const id = created.json.valuation.id;
  log(`created ${id}`);

  await must('PATCH', `/api/v1/valuations/${id}/company-profile`, sample.profile);
  await must('PATCH', `/api/v1/valuations/${id}/params`, sample.params);
  await must('PATCH', `/api/v1/valuations/${id}/engine-inputs`, sample.engineInputs);
  if (sample.workbook.length > 0) {
    await must('PATCH', `/api/v1/valuations/${id}/workbook`, { cells: sample.workbook });
  }
  for (const peer of sample.comparables) {
    await must('POST', `/api/v1/valuations/${id}/comparables`, peer);
  }
  log(
    `inputs: ${sample.workbook.length} workbook cells, ${sample.comparables.length} comparables, ` +
      `${sample.engineInputs.share_classes?.length ?? 0} share classes`,
  );

  const calc = await must('POST', `/api/v1/valuations/${id}/calculations`, {});
  const results = calc.json.calculation.results;
  log(
    `calculated: equity ${fmt(results.equity_value)}, ` +
      `common ${fmt(results.allocation?.common_per_share ?? results.common_per_share, 4)}/sh, ` +
      `DLOC ${pct(results.discounts?.dloc)}, DLOM ${pct(results.discounts?.dlom)}, ` +
      `FMV ${fmt(results.fmv_per_share, 4)}/sh (${results.allocation_method})`,
  );

  await must('POST', `/api/v1/valuations/${id}/report/draft`, {});

  // ASC 718: measure the grants against the FMV just concluded, and write the
  // answer into the chapter the skeleton leaves as four ellipses.
  let asc718Html = null;
  if (sample.grants.length > 0) {
    const measured = await must('POST', `/api/v1/valuations/${id}/asc718`, {
      company_type: 'private',
      grants: sample.grants,
      default_volatility: sample.engineInputs.volatility,
    });
    const portfolio = measured.json.asc718.options;
    asc718Html = asc718SectionHtml(portfolio, { currency: 'USD' });
    log(`ASC 718: ${portfolio.grants.length} grant(s), cost ${fmt(portfolio.totalCompensationCost)}`);
  }

  // The authored body. Chapters not named here keep the skeleton's text, which
  // for the boilerplate chapters is already the finished text.
  const report = await must('GET', `/api/v1/valuations/${id}/report`);
  const content = report.json.version.content;
  let replaced = 0;
  const sections = content.sections.map((s) => {
    const authored = s.key === 'asc718' ? asc718Html : sample.narrative[s.key];
    if (!authored) return s;
    replaced += 1;
    return { ...s, html: authored };
  });
  await must('PUT', `/api/v1/valuations/${id}/report`, { content: { ...content, sections } });
  log(`report: ${replaced} of ${content.sections.length} chapters authored`);

  // Commercially settled, so the workflow walks completed → paid → review the
  // way a real engagement does rather than skipping the gate.
  await must('PATCH', `/api/v1/valuations/${id}`, { paid_status: 'paid' });

  await must('POST', `/api/v1/valuations/${id}/signatures`, {
    role: 'main',
    signer_name: sample.signature.signer_name,
    signer_title: sample.signature.signer_title,
    signature_text: sample.signature.signature_text,
  });

  const qa = await must('POST', `/api/v1/valuations/${id}/qa`, { ai: false });
  const review = qa.json.review ?? qa.json;
  log(`QA: ${review.status ?? 'unknown'}`);
  if (review.status === 'fail') {
    failures += 1;
    const failing = (review.checks ?? []).filter((c) => c.status === 'fail');
    console.error(`   !! QA failed — ${JSON.stringify(failing).slice(0, 800)}`);
  }

  await must('POST', `/api/v1/valuations/${id}/report/render`, {});

  // Walk the lifecycle one legal transition at a time. `workflow/advance`
  // refuses an illegal edge, so a wrong turn here fails loudly rather than
  // leaving an engagement in a state the product cannot reach.
  const target = KEEP_DRAFT ? 'draft_accepted' : 'published';
  let state = 'pending';
  for (let i = 0; i < 12 && state !== target; i += 1) {
    const res = await must('POST', `/api/v1/valuations/${id}/workflow/advance`, {});
    state = res.json.valuation.state;
  }
  if (state !== target) throw new Error(`stalled at '${state}' short of '${target}'`);
  log(`state: ${state}`);

  // The check the whole exercise exists for.
  const pdf = await must('GET', `/api/v1/valuations/${id}/report.pdf`, undefined, { raw: true });
  const text = pdfText(pdf.buffer);
  const unresolved = [...new Set([...text.matchAll(/\{\{\w+\}\}/g)].map((m) => m[0]))];
  const ellipses = /[…]|\.\.\./.test(stripDotLeaders(text));
  log(`pdf: ${pdf.buffer.length} bytes`);
  if (unresolved.length > 0) {
    failures += 1;
    console.error(`   !! ${unresolved.length} unresolved placeholder(s): ${unresolved.join(', ')}`);
  }
  if (ellipses) {
    failures += 1;
    console.error('   !! the rendered report still carries an analyst ellipsis');
  }
  if (unresolved.length === 0 && !ellipses) log('pdf: no unfilled figures, no ellipsis markers');

  return { id, state, fmv: results.fmv_per_share, bytes: pdf.buffer.length };
}

const fmt = (v, digits = 2) =>
  typeof v === 'number'
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(v)
    : 'n/a';
const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : 'n/a');

// ── run ──────────────────────────────────────────────────────────────────────

let exitCode = 0;
try {
  const { actor, token: minted } = await opsToken();
  token = minted;
  console.log(`seed-samples: ${API_URL} as ${actor.email} [${actor.roles.join(', ')}]`);

  const health = await call('GET', '/health');
  if (health.status !== 200) die(`the API at ${API_URL} is not answering /health (${health.status})`);
  console.log(`seed-samples: API build ${health.json?.build_sha ?? 'unknown'}`);

  if (PURGE_IDS.length > 0) {
    if (DRY_RUN) {
      console.log(`[dry-run] would purge ${PURGE_IDS.length} valuation(s): ${PURGE_IDS.join(', ')}`);
    } else {
      const done = await retireValuations(pool, PURGE_IDS);
      console.log(
        `retired ${done.retired.length} valuation(s)` +
          (done.alreadyArchived.length > 0 ? `; already archived: ${done.alreadyArchived.join(', ')}` : '') +
          (done.missing.length > 0 ? `; not found: ${done.missing.join(', ')}` : ''),
      );
    }
  }

  const existing = await findValuationIdsByCompanyName(
    pool,
    samples.map((s) => s.companyName),
  );
  if (existing.length > 0) {
    if (REPLACE) {
      if (DRY_RUN) {
        console.log(`[dry-run] would replace ${existing.length} existing sample(s)`);
      } else {
        const done = await retireValuations(
          pool,
          existing.map((r) => r.id),
        );
        console.log(`retired ${done.retired.length} existing sample engagement(s)`);
      }
    } else {
      const names = new Set(existing.map((r) => r.company_name));
      console.log(`skipping ${names.size} sample(s) already present (pass --replace to rebuild)`);
      for (const s of [...samples]) {
        if (names.has(s.companyName)) samples.splice(samples.indexOf(s), 1);
      }
    }
  }

  const owner = await sampleOwner();
  console.log(`seed-samples: owner ${owner.email} (${owner.id})`);

  if (DRY_RUN) {
    for (const s of samples) console.log(`[dry-run] would seed ${s.companyName} — ${s.summary}`);
  } else {
    for (const s of samples) {
      console.log(`\n── ${s.companyName} ${'─'.repeat(Math.max(0, 56 - s.companyName.length))}`);
      console.log(`   ${s.summary}`);
      const done = await seed(s, owner.id);
      console.log(`   done: ${done.id} ${done.state}`);
    }
  }

  console.log(failures === 0 ? '\nseed-samples: OK' : `\nseed-samples: ${failures} problem(s)`);
  exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error(`\nseed-samples: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
process.exit(exitCode);
