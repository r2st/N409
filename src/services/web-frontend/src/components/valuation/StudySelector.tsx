import { Button, Field, InfoTooltip, Select, TextInput } from '../ui';

/**
 * Which published studies a study-based discount is blended from, and — for a
 * firm with its own subscription data — the rows to blend instead of the
 * engine's built-ins.
 *
 * Three parameter sets share this shape, so they share this component:
 *
 *   * `dlom_studies` / `dlom_study_table` — restricted-stock studies (DLOM)
 *   * `dlom_pre_ipo_studies` / `dlom_pre_ipo_table` — pre-IPO studies (DLOM)
 *   * `dloc_studies` / `dloc_study_table` — control-premium studies (DLOC)
 *
 * All six columns have existed since migrations 0111/0131/0132, are validated
 * by the params route, are read by the engine and are printed by the report
 * exhibits — and none of them had a control. Set selection is the whole
 * objection to a study-based discount, so "which studies" was the one question
 * an analyst could not answer without going through the API.
 */

/** One row of a study table, in the shape the engine and the API both use. */
export interface StudyRow {
  study: string;
  /** The DLOM tables carry a discount; the DLOC table carries a premium. */
  discount?: number;
  premium?: number;
  period_start?: number;
  period_end?: number;
  statistic?: 'median' | 'mean';
}

/**
 * The engine's built-in restricted-stock table (engine/dlom.py).
 *
 * Duplicated rather than fetched, on the same grounds as the AICPA stage scale
 * in `ParamsPanel`: these are published figures that do not change, and a
 * checkbox list that cannot render until a round trip completes is worse than
 * one that cannot drift. `StudyTables.test.ts` asserts the copy against the
 * Python source, so drift is a failing test rather than a name the engine
 * rejects at pre-flight.
 */
export const RESTRICTED_STOCK_STUDIES: readonly StudyRow[] = [
  { study: 'SEC Institutional Investor Study', period_start: 1966, period_end: 1969, discount: 0.258, statistic: 'mean' },
  { study: 'Gelman', period_start: 1968, period_end: 1970, discount: 0.33, statistic: 'median' },
  { study: 'Moroney', period_start: 1969, period_end: 1972, discount: 0.335, statistic: 'median' },
  { study: 'Maher', period_start: 1969, period_end: 1973, discount: 0.333, statistic: 'median' },
  { study: 'Trout', period_start: 1968, period_end: 1972, discount: 0.335, statistic: 'mean' },
  { study: 'Standard Research Consultants', period_start: 1978, period_end: 1982, discount: 0.45, statistic: 'median' },
  { study: 'Willamette Management Associates', period_start: 1981, period_end: 1984, discount: 0.312, statistic: 'median' },
  { study: 'Silber', period_start: 1981, period_end: 1988, discount: 0.338, statistic: 'mean' },
  { study: 'FMV Opinions', period_start: 1979, period_end: 1992, discount: 0.23, statistic: 'mean' },
  { study: 'Management Planning Inc.', period_start: 1980, period_end: 1996, discount: 0.277, statistic: 'mean' },
  { study: 'Johnson', period_start: 1991, period_end: 1995, discount: 0.2, statistic: 'mean' },
  { study: 'Columbia Financial Advisors (pre-amendment)', period_start: 1996, period_end: 1997, discount: 0.21, statistic: 'mean' },
  { study: 'Columbia Financial Advisors (post-amendment)', period_start: 1997, period_end: 1998, discount: 0.13, statistic: 'mean' },
];

/** The year Rule 144's holding period dropped from two years to one. */
export const RULE_144_AMENDMENT_YEAR = 1997;

/**
 * Whether a study observed *only* post-amendment placements — keyed on when it
 * started collecting, not when it closed, for the reason `is_post_amendment`
 * gives in the engine: a window opening in 1996 mostly watched two-year
 * restricted stock however late it closed.
 */
export const isPostAmendment = (row: StudyRow): boolean =>
  typeof row.period_start === 'number' && row.period_start >= RULE_144_AMENDMENT_YEAR;

/** The engine's default restricted-stock set: post-amendment studies only. */
export const DEFAULT_RESTRICTED_STOCK_SET: readonly string[] = RESTRICTED_STOCK_STUDIES.filter(
  isPostAmendment,
).map((s) => s.study);

/** The engine's built-in pre-IPO table (engine/dlom.py). */
export const PRE_IPO_STUDIES: readonly StudyRow[] = [
  { study: 'Emory 1980-1981', period_start: 1980, period_end: 1981, discount: 0.6, statistic: 'mean' },
  { study: 'Emory 1985-1986', period_start: 1985, period_end: 1986, discount: 0.43, statistic: 'mean' },
  { study: 'Emory 1987-1989', period_start: 1987, period_end: 1989, discount: 0.45, statistic: 'mean' },
  { study: 'Emory 1990-1992', period_start: 1990, period_end: 1992, discount: 0.42, statistic: 'mean' },
  { study: 'Emory 1992-1993', period_start: 1992, period_end: 1993, discount: 0.45, statistic: 'mean' },
  { study: 'Emory 1994-1995', period_start: 1994, period_end: 1995, discount: 0.45, statistic: 'mean' },
  { study: 'Emory 1995-1997', period_start: 1995, period_end: 1997, discount: 0.43, statistic: 'mean' },
  { study: 'Emory 1997-2000', period_start: 1997, period_end: 2000, discount: 0.5, statistic: 'mean' },
  { study: 'Emory 1980-2000 (combined)', period_start: 1980, period_end: 2000, discount: 0.46, statistic: 'mean' },
  { study: 'Willamette 1975-1978', period_start: 1975, period_end: 1978, discount: 0.547, statistic: 'median' },
  { study: 'Willamette 1980-1982', period_start: 1980, period_end: 1982, discount: 0.555, statistic: 'median' },
  { study: 'Willamette 1985-1987', period_start: 1985, period_end: 1987, discount: 0.451, statistic: 'median' },
  { study: 'Willamette 1988-1990', period_start: 1988, period_end: 1990, discount: 0.502, statistic: 'median' },
  { study: 'Willamette 1991-1993', period_start: 1991, period_end: 1993, discount: 0.456, statistic: 'median' },
  { study: 'Willamette 1994-1996', period_start: 1994, period_end: 1996, discount: 0.483, statistic: 'median' },
  { study: 'Willamette 1997', period_start: 1997, period_end: 1997, discount: 0.352, statistic: 'median' },
];

/** The most recent window from each family, plus Emory's combined figure. */
export const DEFAULT_PRE_IPO_SET: readonly string[] = [
  'Emory 1997-2000',
  'Emory 1980-2000 (combined)',
  'Willamette 1994-1996',
  'Willamette 1997',
];

/** A pre-IPO window closing before this predates the modern IPO market. */
export const PRE_IPO_RECENCY_YEAR = 1990;

/** The engine's built-in control-premium table (engine/dloc.py). */
export const CONTROL_PREMIUM_STUDIES: readonly StudyRow[] = [
  { study: 'US public targets, 1990s', period_start: 1990, period_end: 1999, premium: 0.36 },
  { study: 'US public targets, 2000s', period_start: 2000, period_end: 2009, premium: 0.33 },
  { study: 'US public targets, 2010s', period_start: 2010, period_end: 2019, premium: 0.3 },
  { study: 'US public targets, 2020s', period_start: 2020, period_end: 2024, premium: 0.31 },
];

/** The engine's default control-premium set: the two most recent decades. */
export const DEFAULT_CONTROL_PREMIUM_SET: readonly string[] = [
  'US public targets, 2010s',
  'US public targets, 2020s',
];

/**
 * Below this a blend is one or two studies wide. The same threshold the three
 * engine blenders use, reported here as a note rather than a block: it is thin,
 * not wrong, and an appraiser may have a reason.
 */
export const THIN_STUDY_SET = 3;

/** A custom study row while it is being typed — every field a string. */
export interface CustomStudyRow {
  study: string;
  value: string;
  period_start: string;
  period_end: string;
  statistic: string;
}

/**
 * One family's selection: which names to blend, and the rows to blend them
 * from. `studies: []` means the engine's default set (the column is NULL);
 * `table: null` means the engine's built-in table.
 */
export interface StudySelection {
  studies: string[];
  table: CustomStudyRow[] | null;
}

export const emptySelection = (): StudySelection => ({ studies: [], table: null });

export const emptyCustomRow = (): CustomStudyRow => ({
  study: '',
  value: '',
  period_start: '',
  period_end: '',
  statistic: '',
});

/** Which value column a family carries — a DLOM discount or a DLOC premium. */
export type StudyValueKey = 'discount' | 'premium';

/** The stored `text[]` + `jsonb` pair, as the form edits them. */
export function selectionFromParams(
  studies: string[] | null | undefined,
  table: unknown,
  valueKey: StudyValueKey,
): StudySelection {
  const rows = Array.isArray(table)
    ? (table as StudyRow[]).map((r) => ({
        study: typeof r.study === 'string' ? r.study : '',
        value: r[valueKey] === undefined || r[valueKey] === null ? '' : String(r[valueKey]),
        period_start: r.period_start === undefined || r.period_start === null ? '' : String(r.period_start),
        period_end: r.period_end === undefined || r.period_end === null ? '' : String(r.period_end),
        statistic: r.statistic ?? '',
      }))
    : null;
  return { studies: Array.isArray(studies) ? [...studies] : [], table: rows };
}

/**
 * The custom table as the API takes it, or null for "use the engine's".
 *
 * Optional keys are *omitted* rather than sent as null: the route's row schema
 * is `.strict()` with `.optional()` (not `.nullable()`) periods, so a null
 * period_start is a 422 rather than an absent one.
 */
export function tableForApi(
  table: CustomStudyRow[] | null,
  valueKey: StudyValueKey,
  withStatistic: boolean,
): StudyRow[] | null {
  if (table === null) return null;
  const rows = table
    .filter((r) => r.study.trim() !== '')
    .map((r) => {
      const out: StudyRow = { study: r.study.trim() };
      out[valueKey] = Number(r.value);
      if (r.period_start.trim() !== '') out.period_start = Number(r.period_start);
      if (r.period_end.trim() !== '') out.period_end = Number(r.period_end);
      if (withStatistic && (r.statistic === 'median' || r.statistic === 'mean')) {
        out.statistic = r.statistic;
      }
      return out;
    });
  return rows.length > 0 ? rows : null;
}

/**
 * What is wrong with a custom table, in the words of the field it is wrong in —
 * mirroring the route's schema so the analyst is told here rather than by a 422.
 *
 * A discount is a fraction below 1 (a security worth nothing is not a
 * marketability problem); a premium is unbounded above, and only its sign is
 * constrained, because a negative one is a discount paid for control and the
 * engine's inversion would read it as a premium.
 */
export function studyTableProblem(
  table: CustomStudyRow[] | null,
  valueKey: StudyValueKey,
): string | null {
  if (table === null) return null;
  const named = table.filter((r) => r.study.trim() !== '');
  if (named.length === 0) return 'A custom table needs at least one named study.';
  const names = named.map((r) => r.study.trim());
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate !== undefined) return `"${duplicate}" is listed twice.`;
  for (const row of named) {
    const n = Number(row.value);
    if (row.value.trim() === '' || !Number.isFinite(n)) {
      return `"${row.study.trim()}" needs a ${valueKey}.`;
    }
    if (valueKey === 'discount' && (n < 0 || n >= 1)) {
      return `"${row.study.trim()}": a discount is a fraction in [0, 1).`;
    }
    if (valueKey === 'premium' && n < 0) {
      return `"${row.study.trim()}": a premium cannot be negative.`;
    }
    for (const key of ['period_start', 'period_end'] as const) {
      const raw = row[key].trim();
      if (raw !== '' && !(Number(raw) >= 1900 && Number(raw) <= 2200)) {
        return `"${row.study.trim()}": ${key === 'period_start' ? 'from' : 'to'} must be a year.`;
      }
    }
  }
  return null;
}

const pct = (v: number | undefined) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');

const period = (row: StudyRow) =>
  row.period_start && row.period_end
    ? row.period_start === row.period_end
      ? ` (${row.period_start})`
      : ` (${row.period_start}–${row.period_end})`
    : '';

/** The rows the picker offers: the custom table when there is one, else the built-ins. */
export function effectiveRows(
  selection: StudySelection,
  builtIn: readonly StudyRow[],
  valueKey: StudyValueKey,
): StudyRow[] {
  if (selection.table === null) return [...builtIn];
  return selection.table
    .filter((r) => r.study.trim() !== '')
    .map((r) => {
      const out: StudyRow = { study: r.study.trim() };
      out[valueKey] = Number(r.value);
      if (r.period_start.trim() !== '') out.period_start = Number(r.period_start);
      if (r.period_end.trim() !== '') out.period_end = Number(r.period_end);
      return out;
    });
}

export function StudySelector({
  testId,
  label,
  tooltip,
  builtIn,
  defaultSet,
  valueKey,
  withStatistic = false,
  note,
  value,
  onChange,
  readOnly,
}: {
  /** Prefix for every `data-testid` in the block. */
  testId: string;
  label: string;
  tooltip: string;
  builtIn: readonly StudyRow[];
  defaultSet: readonly string[];
  valueKey: StudyValueKey;
  /** Whether a custom row carries the study's own median/mean (DLOM only —
   *  the DLOC row schema is strict and has no such key). */
  withStatistic?: boolean;
  /** The family's own caveat about a particular selection, if it has one. */
  note?: (selected: StudyRow[]) => string | null;
  value: StudySelection;
  onChange: (next: StudySelection) => void;
  readOnly: boolean;
}) {
  const rows = effectiveRows(value, builtIn, valueKey);
  const available = rows.map((r) => r.study);
  const selectedRows = rows.filter((r) => value.studies.includes(r.study));
  const usingDefault = value.studies.length === 0;
  const valueLabel = valueKey === 'discount' ? 'Discount' : 'Premium';

  /** Selections are pruned to what the table still contains — a name edited out
   *  of a custom table would otherwise be sent, and refused, as unknown. */
  const emit = (next: StudySelection) => {
    const names = effectiveRows(next, builtIn, valueKey).map((r) => r.study);
    onChange({ ...next, studies: next.studies.filter((s) => names.includes(s)) });
  };

  const toggle = (study: string) =>
    emit({
      ...value,
      studies: value.studies.includes(study)
        ? value.studies.filter((s) => s !== study)
        : [...value.studies, study],
    });

  const setRow = (i: number, key: keyof CustomStudyRow) => (v: string) =>
    emit({
      ...value,
      table: (value.table ?? []).map((r, j) => (j === i ? { ...r, [key]: v } : r)),
    });

  const defaultsInTable = defaultSet.filter((n) => available.includes(n));
  const problem = studyTableProblem(value.table, valueKey);
  const caveat = note && selectedRows.length > 0 ? note(selectedRows) : null;

  return (
    <div className="mt-5 rounded-md border border-paper-300 bg-paper-50 p-4" data-testid={testId}>
      <h5 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-800">
        {label}
        <InfoTooltip text={tooltip} />
      </h5>

      {/* The table first, because it decides which names the picker can offer. */}
      <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-800">
        <input
          type="checkbox"
          disabled={readOnly}
          checked={value.table !== null}
          onChange={(e) =>
            // Switching table clears the selection outright rather than pruning
            // it: the built-in and a firm's own rows share no names by
            // assumption, so anything that survived would be a coincidence.
            onChange(
              e.target.checked
                ? { studies: [], table: [emptyCustomRow()] }
                : { studies: [], table: null },
            )
          }
          className="h-4 w-4 accent-bond-600"
          data-testid={`${testId}-custom-toggle`}
        />
        Supply our own study rows
      </label>
      <p className="mt-1 text-xs text-ink-500">
        The built-in table holds published summary figures. A firm with subscription data (Stout/FMV
        and successors, BVR) supplies its own rows here, and the report prints whichever was used.
      </p>

      {value.table !== null && (
        <div className="mt-4" data-testid={`${testId}-table`}>
          <ol className="space-y-3">
            {value.table.map((row, i) => (
              <li key={i} className="flex flex-wrap items-end gap-3">
                <div className="min-w-[14rem] flex-1">
                  <Field label={`Study ${i + 1}`}>
                    <TextInput
                      disabled={readOnly}
                      value={row.study}
                      onChange={(e) => setRow(i, 'study')(e.target.value)}
                      data-testid={`${testId}-row-${i}-study`}
                    />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label={`${valueLabel} ${i + 1}`}>
                    <TextInput
                      type="number"
                      min={0}
                      max={valueKey === 'discount' ? 0.99 : 10}
                      /* Not a 0.01 step: published figures run to three
                         decimals (0.185, 0.258, 0.547), and a step the value
                         does not divide makes the input constraint-invalid —
                         which blocks the form's submit event with nothing on
                         screen to say why. */
                      step="any"
                      disabled={readOnly}
                      value={row.value}
                      onChange={(e) => setRow(i, 'value')(e.target.value)}
                      data-testid={`${testId}-row-${i}-value`}
                    />
                  </Field>
                </div>
                <div className="w-24">
                  <Field label={`From ${i + 1}`}>
                    <TextInput
                      type="number"
                      min={1900}
                      max={2200}
                      step={1}
                      disabled={readOnly}
                      value={row.period_start}
                      onChange={(e) => setRow(i, 'period_start')(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="w-24">
                  <Field label={`To ${i + 1}`}>
                    <TextInput
                      type="number"
                      min={1900}
                      max={2200}
                      step={1}
                      disabled={readOnly}
                      value={row.period_end}
                      onChange={(e) => setRow(i, 'period_end')(e.target.value)}
                    />
                  </Field>
                </div>
                {withStatistic && (
                  <div className="w-32">
                    <Field label={`Statistic ${i + 1}`}>
                      <Select
                        disabled={readOnly}
                        value={row.statistic}
                        onChange={(e) => setRow(i, 'statistic')(e.target.value)}
                      >
                        <option value="">—</option>
                        <option value="median">Median</option>
                        <option value="mean">Mean</option>
                      </Select>
                    </Field>
                  </div>
                )}
                {!readOnly && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="mb-1"
                    onClick={() =>
                      emit({ ...value, table: (value.table ?? []).filter((_, j) => j !== i) })
                    }
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {!readOnly && (
            <Button
              type="button"
              variant="secondary"
              className="mt-3"
              onClick={() => emit({ ...value, table: [...(value.table ?? []), emptyCustomRow()] })}
              data-testid={`${testId}-add-row`}
            >
              Add study row
            </Button>
          )}
          {problem && <p className="mt-2 text-sm font-medium text-red-600">{problem}</p>}
        </div>
      )}

      {/* ── The selection itself ──────────────────────────────────────────── */}
      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-500 uppercase">
          Studies blended
        </legend>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-500">Name a study above to choose from it.</p>
        ) : (
          <ul className="space-y-1.5">
            {/* Keyed by position, not by name: a custom table is duplicate-named
                for as long as it takes to type the second row's name, and React
                warns about the collision. */}
            {rows.map((row, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-start gap-2 text-sm text-ink-800">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={value.studies.includes(row.study)}
                    onChange={() => toggle(row.study)}
                    className="mt-0.5 h-4 w-4 accent-bond-600"
                  />
                  <span>
                    {row.study}
                    <span className="tnum ml-2 text-ink-500">
                      {pct(row[valueKey])}
                      {period(row)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {!readOnly && defaultsInTable.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => emit({ ...value, studies: usingDefault ? [...defaultsInTable] : [] })}
            data-testid={`${testId}-default-set`}
          >
            {usingDefault ? "Show the engine's default set" : 'Back to the engine default'}
          </Button>
        )}
        {usingDefault ? (
          <p className="text-xs text-ink-500" data-testid={`${testId}-default-note`}>
            {value.table === null
              ? `Nothing selected — the engine blends its default set: ${defaultSet.join(', ')}.`
              : 'Nothing selected — the engine blends every row of the table above.'}
          </p>
        ) : (
          <p className="tnum text-xs text-ink-500">
            {value.studies.length} of {rows.length} selected.
          </p>
        )}
      </div>

      {!usingDefault && value.studies.length < THIN_STUDY_SET && (
        <p className="mt-2 text-sm text-amber-700" data-testid={`${testId}-thin`}>
          A set this narrow is a thin basis to conclude on — the engine flags it on the calculation
          and the report discloses it.
        </p>
      )}
      {caveat && (
        <p className="mt-2 text-sm text-amber-700" data-testid={`${testId}-caveat`}>
          {caveat}
        </p>
      )}
    </div>
  );
}

/**
 * The restricted-stock family's caveat: a set spanning the 1997 amendment is
 * averaging two different securities. The engine reports it as
 * `straddles_rule_144_amendment`; saying so at the checkbox is cheaper than
 * saying so after a calculation.
 */
export function rule144Note(selected: StudyRow[]): string | null {
  const dated = selected.filter((r) => typeof r.period_start === 'number');
  const straddles = dated.some(isPostAmendment) && dated.some((r) => !isPostAmendment(r));
  return straddles
    ? 'This set spans the 1997 Rule 144 amendment. Pre-amendment studies observed two-year restricted stock and run roughly twice the post-amendment discounts, so the blend describes neither regime.'
    : null;
}

/** The pre-IPO family's: a window that closed before the modern IPO market. */
export function preIpoNote(selected: StudyRow[]): string | null {
  const stale = selected.filter(
    (r) => typeof r.period_end === 'number' && r.period_end < PRE_IPO_RECENCY_YEAR,
  );
  return stale.length > 0
    ? `${stale.map((r) => r.study).join(', ')} closed before ${PRE_IPO_RECENCY_YEAR} — a different IPO process and a different retail bid. The engine flags the set as predating the modern IPO market.`
    : null;
}

/** The control-premium family's: every built-in row is a decade summary. */
export function indicativeNote(selected: StudyRow[]): string | null {
  const indicative = selected.filter((r) =>
    CONTROL_PREMIUM_STUDIES.some((b) => b.study === r.study),
  );
  return indicative.length > 0
    ? 'The built-in rows are indicative decade medians, not the year-and-industry extraction an appraiser would cite. The engine marks any conclusion resting on them, and the pre-flight raises it.'
    : null;
}
