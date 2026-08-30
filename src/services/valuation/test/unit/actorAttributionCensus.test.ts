import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Who a `system` actor is, stated once per site.
 *
 * `actor_type` is a filter on the activity log — `/admin/events?actor_type=…`
 * — and `actor_id` is what a reader joins on. A row that says `system` while
 * carrying a person's user id answers both of those wrongly at once: it is
 * missing from "what did people do" and present in "what did the platform do
 * on its own", and neither reader has any way to notice.
 *
 * Four sites had drifted into that shape and none of them looked wrong in
 * isolation: an operator running the health checks, a person downloading the
 * deliverable, the render inside an evidence bundle whose own export event two
 * hundred lines away already said `human`, and the partner API door — in a file
 * whose own `actorFor` helper says `human` and is used everywhere else in it.
 *
 * The rule cannot be "system actors have no id": several genuinely do, and they
 * are the useful ones — `accounting:xero` names the connector that wrote a
 * revenue figure, a SCIM token id names which connector provisioned an account,
 * `retry-sweep` names the timer. So this is a register instead. Every `system`
 * actor with an id is listed below with what that id is, and a new one fails
 * here until somebody decides which kind it is. The failure mode being guarded
 * is a `principal.id` — a *request's* actor — appearing on the `system` side.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../src');

/** Every `.ts` under the service's src tree. */
function sourceFiles(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts'))
        out.push({ file: path.relative(SRC, full), text: readFileSync(full, 'utf8') });
    }
  };
  walk(SRC);
  return out;
}

/**
 * The `actorId` expression at every `actorType: 'system'` site, as written.
 *
 * Read off the source rather than by calling anything, because the property is
 * about which *expression* supplies the id — a runtime check sees a string and
 * cannot tell `principal.id` from a service account's id, which is precisely
 * the distinction that matters here.
 */
function systemActorIds(): Array<{ file: string; id: string }> {
  const found: Array<{ file: string; id: string }> = [];
  for (const { file, text } of sourceFiles()) {
    // `actorType: 'system'` and the `actorId` beside it, in either order and
    // across the line break the formatter puts between them.
    for (const m of text.matchAll(/actorType:\s*'system'[^;]{0,200}?actorId:\s*([^,\n]+)/g)) {
      found.push({ file, id: m[1]!.trim() });
    }
    for (const m of text.matchAll(/actorId:\s*([^,\n]+),[^;]{0,200}?actorType:\s*'system'/g)) {
      found.push({ file, id: m[1]!.trim() });
    }
  }
  return found;
}

/**
 * What each `system` actor's id actually names. A machine identifier, or the
 * service account of a machine that signs in like a user.
 */
const DECIDED: Record<string, string> = {
  "'reaper'": 'the AI-job reaper timer',
  triggeredBy: 'the automated pipeline, named by what triggered the run',
  "'retry-sweep'": 'the pipeline retry sweep',
  "'job-alerts'": 'the job-alert monitor',
  'principal.id': 'the inbound-mail service account — a machine that signs in like a user',
  '`accounting:${provider}`': 'the accounting connector that pulled the figures',
  '`captable-sync:${connection.provider}`': 'the cap-table connector',
  '`hris-sync:${connection.provider}`': 'the HRIS connector',
  tokenId: 'the SCIM token, so a provisioning write names which connector did it',
  'access.id': 'the auditor portal access grant, which is not a user row',
  null: 'Stripe, which has no id of ours to carry',
};

/**
 * The one id expression that is ambiguous, so it is pinned to its file.
 *
 * `principal.id` on a `system` actor is the defect this census exists for. It
 * is legitimate in exactly one place — the inbound-mail gateway, whose
 * principal *is* a machine — and anywhere else it is a person's action filed
 * under the platform.
 */
const PRINCIPAL_ID_ALLOWED_IN = ['routes/comments.ts'];

describe('the actors written as `system`', () => {
  const sites = systemActorIds();

  it('finds the sites at all', () => {
    // A census that matched nothing would pass by having nothing left to ask.
    expect(sites.length).toBeGreaterThan(8);
  });

  it('is a register somebody has decided about', () => {
    const undecided = sites.filter((s) => !(s.id in DECIDED));
    expect(undecided).toEqual([]);
  });

  it('never files a request principal under the platform', () => {
    const offenders = sites
      .filter((s) => s.id === 'principal.id' && !PRINCIPAL_ID_ALLOWED_IN.includes(s.file))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});
