import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * POST /valuations/:id/ai/anonymize — 409.ai parity gap #22.
 *
 * The redaction itself is the AI service's, and its own suite proves what gets
 * struck (`services/ai/tests/test_anonymize_route.py`). What is only testable
 * from here is the half this route exists for: that the entities an operator
 * could not have known to type — the issuer, the client contact, the contact's
 * own company — are assembled off the engagement and actually sent, that a
 * document is selected by id rather than the whole corpus going out, and that
 * taking an extract of client material leaves an audit record behind.
 *
 * The stub redacts for real against the list it is handed rather than replaying
 * a canned string, so a route that built an empty entity list would fail here
 * instead of passing on a fixture that never depended on it.
 */

const CAP_TABLE = [
  'Holder,Class,Shares',
  'Ada Lovelace,Common,2500000',
  'Analytical Engines LLC,Series A,4200000',
  'Anonymous Co,Common,1000',
].join('\n');

interface AnonymizeCall {
  text: string;
  documents: Array<{ id: string; filename: string; content_base64: string }>;
  company_names: string[];
  person_names: string[];
}

/**
 * A stand-in for the AI service's `/ai/v1/anonymize`, striking whole-word
 * matches of whatever entity list it is given — the same contract, in one
 * regex, so the assertions below are about which names travelled.
 */
async function startAiStub(calls: AnonymizeCall[]) {
  const stub = Fastify({ logger: false });
  let fail = false;
  const strike = (value: string, names: string[], placeholder: string): [string, number] => {
    let out = value;
    let hits = 0;
    for (const name of [...names].sort((a, b) => b.length - a.length)) {
      const pattern = new RegExp(`(?<!\\w)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'gi');
      out = out.replace(pattern, () => {
        hits += 1;
        return placeholder;
      });
    }
    return [out, hits];
  };
  stub.post('/ai/v1/anonymize', async (req, reply) => {
    if (fail) return reply.status(503).send({ detail: 'redactor unavailable' });
    const body = req.body as AnonymizeCall;
    calls.push(body);
    let companies = 0;
    let names = 0;
    const apply = (value: string): string => {
      const [afterCo, c] = strike(value, body.company_names, '[COMPANY]');
      const [afterName, n] = strike(afterCo, body.person_names, '[NAME]');
      companies += c;
      names += n;
      return afterName;
    };
    const documents = (body.documents ?? []).map((doc) => {
      const text = Buffer.from(doc.content_base64, 'base64').toString('utf8');
      return {
        id: doc.id,
        original_filename: doc.filename,
        filename: apply(doc.filename),
        kind: 'cap_table',
        text: apply(text),
        chars: text.length,
      };
    });
    return {
      text: apply(body.text ?? ''),
      documents,
      anonymization: {
        applied: true,
        enforced: false,
        redacted: { ...(companies ? { companies } : {}), ...(names ? { names } : {}) },
      },
    };
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    setFailing: (next: boolean) => {
      fail = next;
    },
  };
}

describe.skipIf(!dbUp)('cap-table anonymization', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ai: Awaited<ReturnType<typeof startAiStub>>;
  const calls: AnonymizeCall[] = [];
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let capTableDocId: string;

  const anonymize = (body: Record<string, unknown>, token?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/anonymize`,
      headers: authHeader(token ?? ops.token),
      payload: body,
    });

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    ai = await startAiStub(calls);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AI_URL: ai.url,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    ops = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['admin'] });
    client = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['valuation_user'] });
    // The contact on the engagement — the person whose name is in the holder
    // column, and the one nobody would think to type.
    await pool.query('UPDATE users SET first_name = $2, last_name = $3, company_name = $4 WHERE id = $1', [
      client.id,
      'Ada',
      'Lovelace',
      'Analytical Engines LLC',
    ]);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Anonymous Co' },
    });
    valuationId = created.json().valuation.id;

    const boundary = '----n409anon';
    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: {
        ...authHeader(ops.token),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: [
        `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\ncap_table\r\n`,
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="Anonymous Co Cap Table.csv"\r\n` +
          `content-type: text/csv\r\n\r\n${CAP_TABLE}\r\n`,
        `--${boundary}--\r\n`,
      ].join(''),
    });
    capTableDocId = upload.json().document.id;
  });

  afterAll(async () => {
    await app?.close();
    await ai?.close();
    await db?.teardown();
  });

  it('is operations-only', async () => {
    const res = await anonymize({ text: 'x' }, client.token);
    expect(res.statusCode).toBe(403);
  });

  it('refuses a request with nothing to anonymize', async () => {
    const res = await anonymize({});
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/provide text or document_ids/i);
  });

  it('whitespace-only text is nothing to anonymize', async () => {
    const res = await anonymize({ text: '   \n  ' });
    expect(res.statusCode).toBe(422);
  });

  it('strikes the issuer, the client contact and their company without being told any of them', async () => {
    calls.length = 0;
    const res = await anonymize({ text: CAP_TABLE });
    expect(res.statusCode).toBe(200);

    const sent = calls.at(-1)!;
    expect(sent.company_names).toEqual(expect.arrayContaining(['Anonymous Co', 'Analytical Engines LLC']));
    expect(sent.person_names).toContain('Ada Lovelace');

    const body = res.json();
    for (const identity of ['Ada Lovelace', 'Analytical Engines LLC', 'Anonymous Co']) {
      expect(body.text).not.toContain(identity);
    }
    // The figures are the half that must survive exactly — a cap table whose
    // share counts moved is not an anonymized cap table, it is a different one.
    for (const figure of ['2500000', '4200000', '1000']) {
      expect(body.text).toContain(figure);
    }
    // And says the contact was actually read, rather than leaving a count one
    // short of what it should be to carry that on its own (round 269).
    expect(body.known_entities).toEqual({ companies: 2, people: 1, contact_unavailable: false });
    expect(body.anonymization.applied).toBe(true);
  });

  it('accepts extra names the operator knows and we do not', async () => {
    calls.length = 0;
    const res = await anonymize({
      text: 'Grace Hopper holds 900,000 shares via Hopper Holdings LLC.',
      known_people: ['Grace Hopper'],
      known_companies: ['Hopper Holdings LLC'],
    });
    expect(res.statusCode).toBe(200);
    expect(calls.at(-1)!.person_names).toContain('Grace Hopper');
    expect(res.json().text).toBe('[NAME] holds 900,000 shares via [COMPANY].');
  });

  it('anonymizes a selected document, filename included, and keeps the original alongside', async () => {
    calls.length = 0;
    const res = await anonymize({ document_ids: [capTableDocId] });
    expect(res.statusCode).toBe(200);

    // Only the document that was asked for.
    expect(calls.at(-1)!.documents).toHaveLength(1);

    const doc = res.json().documents[0];
    expect(doc.id).toBe(capTableDocId);
    expect(doc.original_filename).toBe('Anonymous Co Cap Table.csv');
    // "Anonymous Co Cap Table.csv" re-identifies a sheet whose every row was
    // struck, so the filename goes through the redactor too.
    expect(doc.filename).toBe('[COMPANY] Cap Table.csv');
    expect(doc.text).not.toContain('Ada Lovelace');
    expect(doc.text).toContain('2500000');
  });

  it('names a document that is not on this valuation rather than skipping it', async () => {
    const res = await anonymize({ document_ids: [capTableDocId, '01J0000000000000000000MISS'] });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/not on this valuation/i);
    expect(res.json().missing).toEqual(['01J0000000000000000000MISS']);
  });

  it('records an admin event carrying counts, and none of the text', async () => {
    await anonymize({ text: CAP_TABLE, document_ids: [capTableDocId] });
    const { rows } = await pool.query('SELECT * FROM admin_events WHERE type = $1 ORDER BY id DESC LIMIT 1', [
      'cap_table_anonymized',
    ]);
    expect(rows).toHaveLength(1);

    const event = rows[0];
    expect(event.subject_id).toBe(valuationId);
    expect(event.subject_label).toBe('Anonymous Co');
    expect(event.actor_id).toBe(ops.id);
    expect(event.payload.document_ids).toEqual([capTableDocId]);
    expect(event.payload.text_chars).toBe(CAP_TABLE.length);
    expect(event.payload.known_companies).toBe(2);
    expect(event.payload.known_people).toBe(1);
    // The audit record of an extract leaving the platform says whether that
    // extract was short the one entity nobody could have typed in.
    expect(event.payload.contact_unavailable).toBe(false);
    // An audit record about handling client text must not be a copy of it.
    expect(JSON.stringify(event.payload)).not.toContain('Ada Lovelace');
    expect(JSON.stringify(event.payload)).not.toContain('2500000');
  });

  it('surfaces an AI-service outage as an upstream failure, not a 500', async () => {
    ai.setFailing(true);
    try {
      const res = await anonymize({ text: CAP_TABLE });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.statusCode).toBeLessThan(600);
    } finally {
      ai.setFailing(false);
    }
  });
});
