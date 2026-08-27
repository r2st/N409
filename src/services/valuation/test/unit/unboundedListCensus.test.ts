import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A list with no cap at all.
 *
 * `silentCapCensus` asks "does every capped query report its cap". It keys on
 * a literal `LIMIT n` in the SQL, so it is blind by construction to the
 * question one step earlier: a query with *no* `LIMIT` is not a capped query as
 * far as that census can tell, has no flag to be missing, and passes by having
 * nothing to be asked about. Same shape as the vacuous guards in
 * `n409-vacuous-checks`, one level up — the census that exists to catch silent
 * caps cannot see a list that was never capped.
 *
 * Fifty-six repo reads returned an array, a `Map` or a `Set` built from a
 * `SELECT` with no `LIMIT`. Most are fine, and this file is mostly the record
 * of *why* — but the reason has to be written down, because "nobody has hit it
 * yet" and "it cannot grow" look identical in a passing test suite.
 *
 * ## The split that matters
 *
 * Not every unbounded read wants a cap. Two kinds of read live here and they
 * want opposite treatment:
 *
 *   * A **display list** is drawn, counted or summed for a human. Capping it
 *     costs a short list, and the house `{ rows, truncated }` shape makes the
 *     shortness legible. That is the R162 treatment and most of the fixes in
 *     this round are it.
 *
 *   * A **decision set** is a `Set` or `Map` some branch is taken from — a
 *     dedupe set, a membership test, a list of people whose signature is
 *     awaited. Capping one of these does not produce a short list, it produces
 *     a *wrong answer*: a duplicate grant imported onto a cap table, an alert
 *     re-sent, a resolution that reads as approved while a member has not
 *     signed. So a decision set is never capped. It is bounded by asking it
 *     about the caller's own bounded input instead (`existingGrantExternalIds`,
 *     `notifiedSignaturesFor`, `latestMarks`), or the write end is bounded so
 *     the read cannot grow (`MAX_BOARD_MEMBERS`, `MAX_SCENARIOS`).
 *
 * A `why` below that says "small in practice" for a decision set is therefore
 * not an exemption, it is the bug. Every entry states what makes the row count
 * bounded, not what makes the cap unlikely to bite.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPOS = path.resolve(here, '../../src/repos');

/**
 * Why each uncapped multi-row read cannot grow without bound.
 *
 * `bound` is the mechanism, in one of four kinds:
 *
 *   * `caller`   — the predicate is `= ANY($ids)` over a list the caller has
 *                  already bounded, so the page size is the caller's.
 *   * `schema`   — a uniqueness constraint or enum column caps the row count
 *                  per parent at something the schema itself states.
 *   * `write`    — a create path refuses past a stated maximum.
 *   * `curated`  — an administrator-managed table with no self-serve write
 *                  path; it grows by deliberate editorial act, not by use.
 */
interface Bound {
  bound: 'caller' | 'schema' | 'write' | 'curated';
  why: string;
}

const BOUNDED: Record<string, Bound> = {
  // ── Bounded by the caller's own page ────────────────────────────────────
  'boardApprovals.ts:findResolutionsByValuationIds': {
    bound: 'caller',
    why: 'One row per valuation id handed in, and every caller passes a page of `eachEnabledMonitor` or of a capped list.',
  },
  'calculations.ts:latestSucceededCalculationsByValuationIds': {
    bound: 'caller',
    why: 'DISTINCT ON over the ids handed in — one row per valuation, and the id list is the caller’s page.',
  },
  'capTables.ts:findCapTablesByValuationIds': {
    bound: 'caller',
    why: 'One cap table per valuation id handed in.',
  },
  'communications.ts:findTemplatesByKeys': {
    bound: 'caller',
    why: 'Keyed on the template keys the caller names, which come from the catalogue rather than from data.',
  },
  'communications.ts:templateOverrides': {
    bound: 'caller',
    why: 'Keyed on the same caller-named template keys, which come from the transactional email catalogue rather than from data.',
  },
  'dataRemediation.ts:findRerunnableBacksolves': {
    bound: 'caller',
    why: 'A membership set over the valuation ids on the remediation page the caller is rendering.',
  },
  'documents.ts:findDocumentsByIds': {
    bound: 'caller',
    why: 'Explicit id list. This is what `routes/ai.ts` now asks instead of filtering a capped page — see `hasExtractableDocument` for the other half of that fix.',
  },
  'firmDashboard.ts:firmTeam': {
    bound: 'caller',
    why: 'Aggregated per analyst over one firm; the group set is the firm’s user roster, which `listUsers` pages.',
  },
  'funds.ts:latestMarks': {
    bound: 'caller',
    why: 'Keyed on the position ids the caller is rendering — the page `listPositions` returned, which is capped at FUND_POSITION_PAGE_LIMIT. Asked by fund it read a mark for every position the fund holds and dropped the ones past that page.',
  },
  'hrisConnections.ts:existingGrantExternalIds': {
    bound: 'caller',
    why: 'A decision set: the sync skips a grant it finds here, so a short one is a duplicate grant rather than a short list. Bounded by the provider pull the caller is about to iterate, never by a cap.',
  },
  'monitors.ts:notifiedSignaturesFor': {
    bound: 'caller',
    why: 'A decision set, bounded by the (monitor, signature) candidates this scan actually evaluated. Asked by monitor it read every alert those monitors had ever fired.',
  },
  'notificationPreferences.ts:preferenceOverrides': {
    bound: 'caller',
    why: 'Overrides for the notification kinds named by the caller, which come from EVENT_CATALOG.',
  },
  'params.ts:findParamsByValuationIds': {
    bound: 'caller',
    why: 'One params row per valuation id handed in.',
  },
  'users.ts:findUsersByIds': {
    bound: 'caller',
    why: 'Explicit id list — the assigned reviewers on one page of monitors, or one page of any list that renders a user.',
  },
  'valuationTags.ts:acceptedTagsFor': {
    bound: 'caller',
    why: 'Tags for the valuation ids on the caller’s page, and per valuation bounded by the catalogue as below.',
  },
  'valuationTags.ts:tagUsageCounts': {
    bound: 'caller',
    why: 'Counts over the same page of valuation ids.',
  },
  'valuations.ts:findValuationsByIds': {
    bound: 'caller',
    why: 'One row per valuation id handed in; every caller passes a page it has already capped.',
  },
  'notifications.ts:createNotifications': {
    bound: 'caller',
    why: 'Not a read. It returns the rows it just inserted from an `unnest` of the caller’s own array.',
  },
  'comparableItems.ts:replaceMachineComparables': {
    bound: 'caller',
    why: 'Returns the rows it just inserted, from the screen result the caller passed in.',
  },

  // ── Bounded by the schema ───────────────────────────────────────────────
  'accountingConnections.ts:listConnections': {
    bound: 'schema',
    why: 'UNIQUE (valuation_id, provider) and `provider` is an enum, so one row per provider per engagement.',
  },
  'capTableConnections.ts:listConnections': {
    bound: 'schema',
    why: 'UNIQUE (valuation_id, provider), provider an enum.',
  },
  'hrisConnections.ts:listConnections': {
    bound: 'schema',
    why: 'UNIQUE (valuation_id, provider), provider an enum.',
  },
  'overwrites.ts:listOverwrites': {
    bound: 'schema',
    why: 'UNIQUE (valuation_id, field_key), and every write path resolves `field_key` through OVERWRITE_FIELDS_BY_KEY — an unknown key is a 404, not a new row.',
  },
  'signatures.ts:listSignatures': {
    bound: 'schema',
    why: 'UNIQUE (valuation_id, role) and `role` is the `signature_role` enum.',
  },
  'valuationTags.ts:listValuationTags': {
    bound: 'schema',
    why: 'ON CONFLICT (valuation_id, slug), and both write paths reject a slug outside TAG_CATALOGUE — the AI path drops it rather than normalising, the manual path answers 422. One row per catalogue entry is the ceiling.',
  },
  'valuationTags.ts:acceptedTagSlugs': {
    bound: 'schema',
    why: 'A subset of the same per-valuation set. A decision set — filters, exports and precedent queries read it — so it is bounded by the catalogue rather than capped.',
  },
  'jobs.ts:jobStats': {
    bound: 'schema',
    why: 'GROUP BY over the job queue’s kind and status columns, both enums. One row per pair, whatever the queue depth.',
  },
  'valuations.ts:dashboardStats': {
    bound: 'schema',
    why: 'GROUP BY over `state`, an enum. One row per state.',
  },

  // ── Bounded at the write end ────────────────────────────────────────────
  'boardApprovals.ts:listBoardMembers': {
    bound: 'write',
    why: 'MAX_BOARD_MEMBERS (routes/boardApproval.ts). A decision set — every member on it is a signature the resolution is waiting for, so a member hidden past a page boundary reads as a member who is not required. The bound is on the create.',
  },
  'scenarios.ts:listScenarios': {
    bound: 'write',
    why: 'MAX_SCENARIOS = 12, enforced by `countScenarios` on create.',
  },
  'mfa.ts:listUnusedBackupCodeHashes': {
    bound: 'write',
    why: 'A decision set — the codes a login is checked against. Regenerating replaces the set, and a generation writes a fixed ten.',
  },
  'partnerWebhooks.ts:listWebhooks': {
    bound: 'write',
    why: 'The create refuses past ten per partner.',
  },
  'partnerWebhooks.ts:enabledWebhooks': {
    bound: 'write',
    why: 'A subset of the same ten. A decision set — it is the fan-out list for an event, so a short one is a delivery that never happened.',
  },

  // ── Curated tables ──────────────────────────────────────────────────────
  'aiPrompts.ts:listPrompts': {
    bound: 'curated',
    why: 'One row per AI pipeline, edited by admins in the Bot Prompts view. Versions live in a separate, capped table.',
  },
  'billing.ts:listPlans': {
    bound: 'curated',
    why: 'The plan catalogue: one row per subscription tier, written by migration and edited by admins.',
  },
  'communications.ts:listCommunicationTemplates': {
    bound: 'curated',
    why: 'Admin-authored templates keyed to the transactional email catalogue.',
  },
  'communications.ts:listAutoEmails': {
    bound: 'curated',
    why: 'Admin-authored campaigns. The sweep that reads it is per-campaign, and the recipients it fans out to are paged.',
  },
  'jobAlerts.ts:listJobAlertRules': {
    bound: 'curated',
    why: 'One rule per queue and threshold, configured by admins.',
  },
  'narrativePrompts.ts:listNarrativePrompts': {
    bound: 'curated',
    why: 'Admin-authored report sections — one row per section of the report skeleton, per valuation kind.',
  },
  'narrativePrompts.ts:listNarrativePromptsForKind': {
    bound: 'curated',
    why: 'A `kind`-filtered slice of the same admin-authored table, so bounded by the same section list.',
  },
  'retention.ts:listPolicies': {
    bound: 'curated',
    why: 'One retention policy per subject type, and the subject types are a fixed list the admin screen offers.',
  },
  'systemSettings.ts:readSettingRows': {
    bound: 'curated',
    why: 'One row per known setting key; the writer refuses an unknown key.',
  },
};

/** Lines of code, with the doc comments this repo writes at length stripped. */
function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
}

interface Fn {
  name: string;
  body: string;
  /** Declared return type, normalised to one line. */
  ret: string;
}

/** Exported functions of a repo module, each sliced at the next top-level `export`. */
function exportedFunctions(src: string): Fn[] {
  const out: Fn[] = [];
  const starts = [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.index! : src.length;
    const chunk = src.slice(m.index!, end);
    const ret = /\)\s*:\s*(Promise<[\s\S]*?>)\s*\{/.exec(chunk);
    out.push({ name: m[1]!, body: chunk, ret: ret ? ret[1]!.replace(/\s+/g, ' ') : '' });
  }
  return out;
}

/** Whether the declared return type can hold more than one row. */
function returnsMany(ret: string): boolean {
  return /\[\]/.test(ret) || /\bMap</.test(ret) || /\bSet</.test(ret);
}

/** Multi-row reads with no `LIMIT` of any kind — literal or parameterised. */
function unboundedReads(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(REPOS).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(REPOS, file), 'utf8');
    for (const fn of exportedFunctions(src)) {
      const body = code(fn.body);
      if (!/\bSELECT\b/i.test(body)) continue;
      if (/\bLIMIT\b/i.test(body)) continue;
      if (!returnsMany(fn.ret)) continue;
      found.push(`${file}:${fn.name}`);
    }
  }
  return found.sort();
}

describe('an uncapped list says why it cannot grow', () => {
  const reads = unboundedReads();

  it('is reading the repo sources at all', () => {
    // The vacuity guard, and this census needs one more than most: it passes
    // trivially the moment the export regex, the return-type regex or the
    // `LIMIT` test stops firing, and each of those three is a shape this
    // codebase reformats regularly.
    const all = readdirSync(REPOS).filter((f) => f.endsWith('.ts'));
    expect(all.length).toBeGreaterThan(20);

    const fns = exportedFunctions(readFileSync(path.join(REPOS, 'valuationTags.ts'), 'utf8'));
    // Return types are being read — without them every `find*` returning one
    // row would be in scope and the census would be about something else.
    const tags = fns.find((f) => f.name === 'listValuationTags');
    expect(tags?.ret).toContain('ValuationTagRow[]');
    expect(returnsMany(tags!.ret)).toBe(true);
    expect(returnsMany('Promise<ValuationTagRow | null>')).toBe(false);

    // And a capped read is being excluded for the right reason: `listPositions`
    // returns an array and is out of scope only because it has a LIMIT.
    const positions = exportedFunctions(readFileSync(path.join(REPOS, 'funds.ts'), 'utf8')).find(
      (f) => f.name === 'listPositions',
    );
    expect(returnsMany(positions!.ret)).toBe(true);
    expect(/\bLIMIT\b/i.test(code(positions!.body))).toBe(true);

    // The census is looking at a real population, not an empty one.
    expect(reads.length).toBeGreaterThan(20);
  });

  it('has every uncapped multi-row read accounted for', () => {
    expect(reads.filter((r) => !(r in BOUNDED))).toEqual([]);
  });

  it('accounts for nothing that has stopped being uncapped', () => {
    expect(Object.keys(BOUNDED).filter((k) => !reads.includes(k))).toEqual([]);
  });

  it('states a mechanism, not a hope, for every one', () => {
    // The failure this catches is an entry added in a hurry that says a list is
    // "small in practice". Small in practice is how every one of these started.
    const vague: string[] = [];
    for (const [key, entry] of Object.entries(BOUNDED)) {
      if (entry.why.trim().length < 40) vague.push(key);
      // Hedges about *likelihood*, not the words themselves — "a delivery
      // that never happened" is a consequence and belongs here; "small in
      // practice" is a guess about traffic and does not.
      if (
        /\b(small|short|few|low) (enough|in practice)\b|\bunlikely to\b|\brarely\b|\bfor now\b|\bnobody has\b|\bin practice\b/i.test(
          entry.why,
        )
      )
        vague.push(key);
    }
    expect(vague).toEqual([]);
  });
});

describe('the decision sets stay uncapped', () => {
  /**
   * The reads a cap would turn into a wrong answer rather than a short list.
   *
   * Stated as a list because the pressure on each of these is to "make it
   * consistent with the others" — they are the odd ones out in a file whose
   * whole subject is capping lists, and each is one careless edit away from a
   * duplicate import, a re-sent alert or a resolution approved while somebody
   * has not signed.
   */
  const DECISION_SETS = [
    'hrisConnections.ts:existingGrantExternalIds',
    'monitors.ts:notifiedSignaturesFor',
    'boardApprovals.ts:listBoardMembers',
    'partnerWebhooks.ts:enabledWebhooks',
    'mfa.ts:listUnusedBackupCodeHashes',
    'valuationTags.ts:acceptedTagSlugs',
  ];

  for (const key of DECISION_SETS) {
    const [file, name] = key.split(':') as [string, string];

    it(`${key} has no LIMIT, and says why`, () => {
      const src = readFileSync(path.join(REPOS, file), 'utf8');
      const fn = exportedFunctions(src).find((f) => f.name === name);
      expect(fn, `${key} no longer exists`).toBeDefined();
      expect(/\bLIMIT\b/i.test(code(fn!.body)), `${key} has been capped`).toBe(false);
      expect(BOUNDED[key]?.bound).not.toBe('curated');
    });
  }

  it('bounds the two dedupe sets by their caller rather than by the table', () => {
    // Both took a parent id and read everything under it. Both now take the
    // candidates the caller is about to decide on. The signature is the guard:
    // a second parameter that is a list is what makes the bound the caller's.
    const hris = exportedFunctions(readFileSync(path.join(REPOS, 'hrisConnections.ts'), 'utf8')).find(
      (f) => f.name === 'existingGrantExternalIds',
    );
    expect(hris!.body).toContain('candidates: readonly string[]');
    expect(code(hris!.body)).toContain('= ANY(');

    const monitors = exportedFunctions(readFileSync(path.join(REPOS, 'monitors.ts'), 'utf8')).find(
      (f) => f.name === 'notifiedSignaturesFor',
    );
    expect(monitors!.body).toContain('candidates: readonly AlertCandidate[]');
    expect(code(monitors!.body)).toContain('unnest(');
  });
});
