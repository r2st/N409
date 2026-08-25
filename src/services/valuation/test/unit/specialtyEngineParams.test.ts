/**
 * The reverse census: every parameter a specialty engine accepts is asked of
 * somebody, or named here as one nobody is asked for and why.
 *
 * `specialtyFieldConsumption.test.ts` runs this comparison in the other
 * direction — every question reaches the engine. Both directions matter and
 * only one of them was guarded, which is why the gaps kept being found by
 * hand: the §2503(b) annual exclusion (three parameters the engine had taken
 * since it was written and nothing ever sent), Rev. Rul. 59-60's
 * `factors_addressed`, and IFRS 2's `expected_forfeiture_rate`. Each was a
 * default the engine applied and the deliverable printed as a conclusion, and
 * none of them could fail a test that only walks the questionnaire.
 *
 * What the engine accepts is a Python signature, and three of these endpoints
 * do not have a usable one: `/intangible`, `/impairment` and `/emi-csop` take
 * `(method, params)` and unpack the params into a different function per
 * method, so a parse of the route's own signature reads the dispatcher's
 * locals as parameters. So the accepted names are resolved in Python, where
 * `inspect.signature` can follow the dispatch, and published as
 * `engine-wrapper/contract/specialty-params.json`. A pytest keeps that file
 * true to the source; this file keeps the assembler true to that file.
 *
 * "Asked of somebody" is deliberately narrow. An override merges over the
 * assembled body, so *any* key can be sent by an analyst who knows it exists —
 * counting that would make this census pass unconditionally. A parameter is
 * covered only if the questionnaire produces it, or if it is declared in
 * `SPECIALTY_ENGINES[kind].runInputs`, which is what the workspace tab reads
 * to tell the analyst it exists before the run.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { intakeSectionsFor } from '../../src/domain/intakeKinds.js';
import {
  SPECIALTY_ENGINES,
  SPECIALTY_KINDS,
  specialtyEngineRequest,
  type SpecialtyKind,
} from '../../src/domain/specialty.js';

/** Endpoint path → call variant → accepted keyword names. */
const CONTRACT = JSON.parse(
  readFileSync(new URL('../../../engine-wrapper/contract/specialty-params.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, string[]>>;

type Answers = Record<string, unknown>;

/**
 * A value for each declared run input, so a branch that requires one assembles
 * at all. The keys are asserted against `runInputs` below rather than trusted:
 * a value here for a key the tab does not name would be this census excusing a
 * parameter on the strength of its own fixture.
 */
const RUN_INPUT_VALUES: Record<string, unknown> = {
  intangibles: [{ name: 'Technology', method: 'relief_from_royalty', params: {} }],
  positions: [{ name: 'Position', fair_value: 1_000, level: 3 }],
  level_3_rollforward: { opening: 1_000, closing: 1_000 },
  sensitivity: [{ input: 'discount rate', change: 0.01 }],
  revenues: [100, 100, 100],
  ebit_margin: 0.3,
  contributory_charges_pct: 0.05,
  attrition_rate: 0.1,
  cash_flows_with: [100, 110],
  cash_flows_without: [80, 85],
  terminal_growth: 0.02,
  include_tab: true,
  weights: { sde: 0.5, revenue: 0.5 },
  fair_value_per_award: 1.25,
  current_fair_value_per_award: 1.4,
  market_condition_discount: 0.1,
};

/** The gifts questionnaire asks for the entity value; the run may also carry it. */
const EXTRA_OVERRIDES: Partial<Record<SpecialtyKind, Answers>> = {
  gifts: { entity_value: 10_000_000 },
};

/** Answers a select cannot generate a plausible value for. */
const SHAPED_ANSWERS: Record<string, unknown> = {
  undiscounted_cash_flows: '120000, 130000, 90000',
};

function runInputsFor(kind: SpecialtyKind): Answers {
  const out: Answers = { ...(EXTRA_OVERRIDES[kind] ?? {}) };
  for (const { key } of SPECIALTY_ENGINES[kind].runInputs) out[key] = RUN_INPUT_VALUES[key];
  return out;
}

/** A complete, plausible set of answers to a kind's questionnaire. */
function fullAnswers(kind: SpecialtyKind): Answers {
  const answers: Answers = {};
  let i = 0;
  for (const section of intakeSectionsFor(kind)) {
    for (const field of section.fields) {
      i += 1;
      if (field.key in SHAPED_ANSWERS) {
        answers[field.key] = SHAPED_ANSWERS[field.key];
        continue;
      }
      const rules = (field as { rules?: { min?: number; max?: number } }).rules ?? {};
      switch (field.type) {
        case 'number':
          answers[field.key] = Math.min(rules.max ?? 5, Math.max(rules.min ?? 0, 5));
          break;
        case 'boolean':
          answers[field.key] = true;
          break;
        case 'date':
          answers[field.key] = `2026-0${(i % 9) + 1}-1${i % 9}`;
          break;
        case 'select':
          answers[field.key] = field.options![field.options!.length - 1];
          break;
        default:
          answers[field.key] = `sentinel_${field.key}`;
      }
    }
  }
  return answers;
}

/** Every select swung to each of its options in turn — the dispatchers branch on one. */
function branches(kind: SpecialtyKind, answers: Answers): Answers[] {
  const out: Answers[] = [answers];
  for (const section of intakeSectionsFor(kind)) {
    for (const field of section.fields) {
      if (field.type !== 'select') continue;
      for (const option of field.options!) out.push({ ...answers, [field.key]: option });
    }
  }
  return out;
}

/**
 * The variant key an assembled body selects, matching the contract's spelling.
 * A body with no dispatch key posts a single free-form `inputs` object.
 */
function variantOf(body: Record<string, unknown>): string {
  for (const key of ['method', 'test', 'scheme']) {
    if (typeof body[key] === 'string') return `${key}=${body[key] as string}`;
  }
  return 'inputs';
}

/** Endpoint path → variant → the parameter names the assembler can send. */
function sendableParams(): Map<string, Map<string, Set<string>>> {
  const sendable = new Map<string, Map<string, Set<string>>>();
  const record = (path: string, variant: string, keys: Iterable<string>) => {
    const byVariant = sendable.get(path) ?? new Map<string, Set<string>>();
    const set = byVariant.get(variant) ?? new Set<string>();
    for (const k of keys) set.add(k);
    byVariant.set(variant, set);
    sendable.set(path, byVariant);
  };

  for (const kind of SPECIALTY_KINDS) {
    const overrides = runInputsFor(kind);
    for (const branch of branches(kind, fullAnswers(kind))) {
      let req;
      try {
        req = specialtyEngineRequest(kind, branch, overrides);
      } catch {
        // A branch this questionnaire cannot complete tells us nothing about
        // what the engine accepts; other branches cover the same endpoint.
        continue;
      }
      const body = req.body as Record<string, unknown>;
      const payload = (body.inputs ?? body.params) as Record<string, unknown> | undefined;
      if (payload) record(req.path, variantOf(body), Object.keys(payload));
      const repurchase = body.repurchase as Record<string, unknown> | undefined;
      if (repurchase) record(req.path, 'repurchase', Object.keys(repurchase));
    }
  }
  return sendable;
}

/**
 * Parameters no questionnaire asks for and no run input declares. Each entry is
 * a claim about why nobody needs to be asked — that the engine's default IS the
 * standard's answer, or that the value is the platform's to supply — so adding
 * one is an assertion, not a mute button.
 */
const UNASKED: Record<string, readonly string[]> = {
  '/engine/v1/smb inputs': [
    // The questionnaire collects the add-backs and the engine computes SDE from
    // them; `sde` is the same figure entered directly, and offering both ways
    // to state one number is how two answers come to disagree.
    'sde',
  ],
  '/engine/v1/ifrs2 inputs': [
    // IFRS 2.IG11 does not offer the straight-line election ASC 718 does, so
    // graded over the instalments is the standard's answer rather than a
    // judgement the appraiser makes — and the engine warns when an override
    // elects otherwise for an award that vests in instalments.
    'attribution',
    // Derived from the vesting period: one tranche per year. A different count
    // is a different vesting schedule, which is the question already asked.
    'tranches',
  ],
};

/**
 * Endpoints in the contract that no specialty questionnaire posts to.
 * `/comparables` is reached by the peer-set screen in `routes/comparables.ts`,
 * whose inputs come from the engagement rather than from an intake form.
 */
const NOT_A_SPECIALTY_ENDPOINT = ['/engine/v1/comparables'];

describe('engine → specialty questionnaire parameter census', () => {
  const sendable = sendableParams();
  const paths = Object.keys(CONTRACT).filter((p) => !NOT_A_SPECIALTY_ENDPOINT.includes(p));

  it('covers every endpoint a specialty kind posts to', () => {
    // The vacuity this census would otherwise die of: a kind whose branches all
    // refuse contributes no parameters, and every one of its engine's
    // parameters would then look covered by nothing and fail — or, if it were
    // skipped, look covered by everything and pass.
    const posted = [...new Set(SPECIALTY_KINDS.map((k) => SPECIALTY_ENGINES[k].path))].sort();
    expect(posted).toEqual(paths.sort());
    for (const path of posted) expect([...(sendable.get(path)?.keys() ?? [])].length).toBeGreaterThan(0);
  });

  it('reaches every call variant the contract publishes', () => {
    const missing: string[] = [];
    for (const path of paths) {
      for (const variant of Object.keys(CONTRACT[path])) {
        if (!sendable.get(path)?.has(variant)) missing.push(`${path} ${variant}`);
      }
    }
    expect(
      missing,
      'the assembler never builds these calls, so nothing below can be measured for them',
    ).toEqual([]);
  });

  it.each(
    Object.keys(CONTRACT)
      .filter((p) => !NOT_A_SPECIALTY_ENDPOINT.includes(p))
      .flatMap((path) => Object.keys(CONTRACT[path]).map((variant) => [path, variant] as const)),
  )('asks somebody for every parameter %s %s accepts', (path, variant) => {
    const accepted = CONTRACT[path][variant];
    const sent = sendable.get(path)?.get(variant) ?? new Set<string>();
    const excused = new Set(UNASKED[`${path} ${variant}`] ?? []);
    const unasked = accepted.filter((p) => !sent.has(p) && !excused.has(p));
    expect(
      unasked,
      `${path} (${variant}) accepts these and nobody is asked for them: add a field in ` +
        `domain/intakeKinds.ts, declare a run input in SPECIALTY_ENGINES, or name them in ` +
        `UNASKED with the reason the engine's default is the right answer`,
    ).toEqual([]);
  });

  it('keeps the unasked list honest', () => {
    for (const [key, params] of Object.entries(UNASKED)) {
      const [path, variant] = key.split(' ');
      expect(
        CONTRACT[path]?.[variant],
        `UNASKED names ${key}, which the contract has no entry for`,
      ).toBeDefined();
      for (const param of params) {
        expect(
          CONTRACT[path][variant].includes(param),
          `UNASKED excuses ${param}, which ${key} no longer accepts — drop the entry`,
        ).toBe(true);
        expect(
          sendable.get(path)?.get(variant)?.has(param),
          `UNASKED still excuses ${param}, which the assembler now sends — drop the entry`,
        ).toBeFalsy();
      }
    }
  });

  it('declares a value for every run input the tab names', () => {
    const undeclared: string[] = [];
    for (const kind of SPECIALTY_KINDS) {
      for (const { key } of SPECIALTY_ENGINES[kind].runInputs) {
        if (!(key in RUN_INPUT_VALUES)) undeclared.push(`${kind}.${key}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('does not let an undeclared override excuse a parameter', () => {
    // The property the whole census rests on: overrides merge over the
    // assembled body, so if arbitrary keys counted, every parameter would be
    // "sendable" and this file would pass no matter what the form asked.
    const declared = new Set(SPECIALTY_ENGINES.ifrs2.runInputs.map((r) => r.key));
    expect(declared.has('attribution')).toBe(false);
    expect(sendable.get('/engine/v1/ifrs2')?.get('inputs')?.has('attribution')).toBeFalsy();
  });
});
