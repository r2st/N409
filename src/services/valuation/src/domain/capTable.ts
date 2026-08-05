/**
 * Cap-table import, validation and waterfall feed (feature 9). Pure functions —
 * no I/O — so CSV parsing, column mapping, validation and the engine-input
 * projection are all unit-testable. The route layer persists the result.
 */

export const CAP_TABLE_EVENT_TYPES = {
  imported: 'cap_table_imported',
} as const;

export type CapTableClassType = 'common' | 'preferred' | 'option' | 'warrant';

export interface CapTableEntry {
  security_class: string;
  class_type: CapTableClassType;
  shares: number;
  price_per_share: number | null;
  invested_amount: number | null;
  liquidation_multiple: number | null;
  seniority: number | null;
  conversion_ratio: number | null;
}

/** Canonical fields the importer maps source columns onto. */
export const CAP_TABLE_FIELDS = [
  'security_class',
  'class_type',
  'shares',
  'price_per_share',
  'invested_amount',
  'liquidation_multiple',
  'seniority',
  'conversion_ratio',
] as const;
export type CapTableField = (typeof CAP_TABLE_FIELDS)[number];

export type ColumnMapping = Partial<Record<CapTableField, string>>;

export interface FormatPreset {
  key: string;
  label: string;
  mapping: ColumnMapping;
}

/**
 * Column-name presets for common cap-table exports. Matched case-insensitively
 * and trimmed; unmatched columns fall back to the user-supplied mapping.
 */
export const FORMAT_PRESETS: readonly FormatPreset[] = [
  {
    key: 'carta',
    label: 'Carta export',
    mapping: {
      security_class: 'Security',
      shares: 'Shares',
      price_per_share: 'Issue Price',
      invested_amount: 'Amount Invested',
      liquidation_multiple: 'Liquidation Preference',
      seniority: 'Seniority',
    },
  },
  {
    key: 'pulley',
    label: 'Pulley export',
    mapping: {
      security_class: 'Share Class',
      shares: 'Shares Outstanding',
      price_per_share: 'Price Per Share',
      invested_amount: 'Total Invested',
      liquidation_multiple: 'Liquidation Multiple',
    },
  },
  {
    key: 'generic',
    label: 'Generic CSV',
    mapping: {
      security_class: 'class',
      class_type: 'type',
      shares: 'shares',
      price_per_share: 'price',
      invested_amount: 'invested',
      liquidation_multiple: 'liquidation_multiple',
      seniority: 'seniority',
      conversion_ratio: 'conversion_ratio',
    },
  },
] as const;

export function presetByKey(key: string): FormatPreset | undefined {
  return FORMAT_PRESETS.find((p) => p.key === key);
}

/**
 * Parse a money/number cell: strips $, commas and whitespace; '' → null.
 *
 * A fully parenthesised figure is negative — that is what `(500,000)` means in
 * every accounting export a cap table arrives from. Discarding the parentheses
 * instead, as this did, turned a 500,000-share repurchase into a 500,000-share
 * holding: `-500000` is rejected by `validateCapTable` as a bad share count,
 * but `(500000)` sailed through as a legitimate position and inflated the
 * fully-diluted count that divides the equity value into a per-share figure.
 *
 * An unbalanced parenthesis is now unparseable rather than silently positive:
 * `(500000` says the cell was not understood, and null is the honest answer.
 */
export function parseNumericCell(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let cleaned = String(value).replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  let negated = false;
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    negated = true;
    cleaned = cleaned.slice(1, -1);
    if (cleaned === '') return null;
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // `n !== 0` keeps `(0)` from becoming -0, which formats as "-0".
  return negated && n !== 0 ? -n : n;
}

/** Infer the class type from the security name when it isn't a column. */
export function inferClassType(name: string): CapTableClassType {
  const n = name.toLowerCase();
  if (/\boption|\bisos?\b|\bnso|pool\b/.test(n)) return 'option';
  if (/warrant/.test(n)) return 'warrant';
  if (/common|founder|restricted stock|\brsu/.test(n)) return 'common';
  if (/preferred|series|seed|convertible/.test(n)) return 'preferred';
  return 'common';
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes and
 * CRLF. Returns an array of row objects keyed by the header row.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (r[i] ?? '').trim();
    });
    return obj;
  });
}

/** Case-insensitive lookup of a source column in a row. */
function readCell(row: Record<string, unknown>, header: string | undefined): unknown {
  if (!header) return undefined;
  if (header in row) return row[header];
  const lower = header.toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Map raw rows to canonical cap-table entries using the column mapping. */
export function parseCapTable(rows: Record<string, unknown>[], mapping: ColumnMapping): CapTableEntry[] {
  const entries: CapTableEntry[] = [];
  for (const row of rows) {
    const name = String(readCell(row, mapping.security_class) ?? '').trim();
    const sharesRaw = parseNumericCell(readCell(row, mapping.shares));
    // Skip blank rows / totals rows with no class and no shares.
    if (name === '' && sharesRaw === null) continue;
    const typeCell = String(readCell(row, mapping.class_type) ?? '')
      .trim()
      .toLowerCase();
    const classType: CapTableClassType =
      typeCell === 'common' || typeCell === 'preferred' || typeCell === 'option' || typeCell === 'warrant'
        ? (typeCell as CapTableClassType)
        : inferClassType(name);
    entries.push({
      security_class: name,
      class_type: classType,
      shares: sharesRaw ?? 0,
      price_per_share: parseNumericCell(readCell(row, mapping.price_per_share)),
      invested_amount: parseNumericCell(readCell(row, mapping.invested_amount)),
      liquidation_multiple: parseNumericCell(readCell(row, mapping.liquidation_multiple)),
      seniority: parseNumericCell(readCell(row, mapping.seniority)),
      conversion_ratio: parseNumericCell(readCell(row, mapping.conversion_ratio)),
    });
  }
  return entries;
}

export interface CapTableIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  security_class?: string;
}

export interface CapTableSummary {
  total_shares: number;
  common_shares: number;
  preferred_shares: number;
  option_shares: number;
  warrant_shares: number;
  fully_diluted_shares: number;
  total_preference_stack: number;
  class_count: number;
}

export interface CapTableValidation {
  valid: boolean;
  issues: CapTableIssue[];
  summary: CapTableSummary;
}

/**
 * Validate parsed entries: share counts, preference stacks, conversion ratios
 * and option pool. Errors make the table invalid (block save); warnings note
 * defaulted or missing figures.
 */
export function validateCapTable(entries: CapTableEntry[]): CapTableValidation {
  const issues: CapTableIssue[] = [];
  const summary: CapTableSummary = {
    total_shares: 0,
    common_shares: 0,
    preferred_shares: 0,
    option_shares: 0,
    warrant_shares: 0,
    fully_diluted_shares: 0,
    total_preference_stack: 0,
    class_count: entries.length,
  };

  if (entries.length === 0) {
    issues.push({ severity: 'error', code: 'empty', message: 'No cap-table rows were found.' });
  }

  const seen = new Set<string>();
  for (const e of entries) {
    if (e.security_class === '') {
      issues.push({
        severity: 'error',
        code: 'missing_class',
        message: 'A row is missing a security class name.',
      });
    } else if (seen.has(e.security_class.toLowerCase())) {
      issues.push({
        severity: 'warning',
        code: 'duplicate_class',
        message: `Duplicate security class "${e.security_class}".`,
        security_class: e.security_class,
      });
    }
    seen.add(e.security_class.toLowerCase());

    if (!Number.isFinite(e.shares) || e.shares < 0) {
      issues.push({
        severity: 'error',
        code: 'bad_shares',
        message: `"${e.security_class}" has an invalid share count.`,
        security_class: e.security_class,
      });
    } else if (e.shares === 0) {
      // A warning rather than an error, unlike the negative money below: zero
      // is a real thing for a row to say (a retired class, an option pool with
      // nothing left in it) and refusing the import would lose the other
      // fifteen rows over it. But it is not a thing the *waterfall* can say —
      // the engine's rule is `shares must be positive`, so this row is the one
      // that turns the allocation into a 422 — and the importer is the only
      // place that still knows which row it was.
      issues.push({
        severity: 'warning',
        code: 'zero_shares',
        message: `"${e.security_class}" has no shares outstanding — the waterfall allocation will refuse this row.`,
        security_class: e.security_class,
      });
    }
    summary.total_shares += Math.max(0, e.shares);
    if (e.class_type === 'common') summary.common_shares += e.shares;
    else if (e.class_type === 'preferred') summary.preferred_shares += e.shares;
    else if (e.class_type === 'option') summary.option_shares += e.shares;
    else if (e.class_type === 'warrant') summary.warrant_shares += e.shares;

    if (e.class_type === 'preferred') {
      const mult = e.liquidation_multiple ?? 1;
      if (e.liquidation_multiple === null) {
        issues.push({
          severity: 'warning',
          code: 'default_liq_pref',
          message: `"${e.security_class}" has no liquidation preference — defaulting to 1×.`,
          security_class: e.security_class,
        });
      }
      if (mult < 0) {
        issues.push({
          severity: 'error',
          code: 'bad_liq_pref',
          message: `"${e.security_class}" has a negative liquidation preference.`,
          security_class: e.security_class,
        });
      }
      if (e.conversion_ratio !== null && e.conversion_ratio <= 0) {
        issues.push({
          severity: 'error',
          code: 'bad_conversion',
          message: `"${e.security_class}" has a non-positive conversion ratio.`,
          security_class: e.security_class,
        });
      }
      // Seniority was the one preferred field nothing here checked, and it is
      // the field that orders the stack. `parseNumericCell` accepts any finite
      // number, so a 0-based export ("0, 1, 2"), a negative, or a fractional
      // rank imported as `valid: true` and was carried through unexamined:
      //
      //   - `waterfallSheet` sorts the preference stack by it and declares the
      //     column `integer`, so the sheet an auditor reaches for first shows
      //     the wrong liquidation order — with a fraction in an integer column.
      //   - the ops `waterfall-inputs` endpoint hands it to an engine whose own
      //     rule is `seniority must be an integer >= 1`, so the allocation is
      //     refused for a table the importer had just called valid.
      //
      // Same rule as the hand-entry schema (`z.number().int().min(1)`) and the
      // engine, stated where the import can still say which row is wrong.
      if (e.seniority !== null && (!Number.isInteger(e.seniority) || e.seniority < 1)) {
        issues.push({
          severity: 'error',
          code: 'bad_seniority',
          message: `"${e.security_class}" has a seniority of ${e.seniority} — it must be a whole number of 1 or more (1 is the most senior).`,
          security_class: e.security_class,
        });
      }
      // Preference stack: invested × multiple, else shares × price × multiple.
      const invested = e.invested_amount ?? (e.price_per_share !== null ? e.price_per_share * e.shares : 0);
      // The two money columns were the last unchecked inputs to the preference
      // stack, and `parseNumericCell` hands them straight through: it reads a
      // fully parenthesised `(5,000,000)` as −5,000,000, which is the correct
      // reading of an accounting export and precisely how a negative one
      // arrives. Shares are checked for it; these were not, so a repurchase or
      // a contra row imported as `valid: true` and carried a *negative*
      // preference through everything downstream:
      //
      //   - `waterfallSheet` prints it as the class's "Preference (currency)"
      //     and sums it into the total, so the preference stack an auditor
      //     reads is understated by twice the row.
      //   - `summary.total_preference_stack` is understated the same way, and
      //     that is the figure the import screen reports back.
      //   - the ops `waterfall-inputs` endpoint hands it to an engine whose own
      //     rule is `preference must be >= 0`, so the allocation is refused for
      //     a table the importer had just called valid.
      //
      // A liquidation preference is a claim on proceeds; there is no such thing
      // as a negative one. Same severity as `bad_liq_pref` just above, which
      // has been making this exact check on the multiple all along.
      if (e.invested_amount !== null && e.invested_amount < 0) {
        issues.push({
          severity: 'error',
          code: 'negative_investment',
          message: `"${e.security_class}" has a negative invested amount (${e.invested_amount}) — a liquidation preference cannot be negative.`,
          security_class: e.security_class,
        });
      }
      if (e.price_per_share !== null && e.price_per_share < 0) {
        issues.push({
          severity: 'error',
          code: 'negative_price',
          message: `"${e.security_class}" has a negative price per share (${e.price_per_share}).`,
          security_class: e.security_class,
        });
      }
      if (invested === 0) {
        issues.push({
          severity: 'warning',
          code: 'no_investment',
          message: `"${e.security_class}" has no invested amount or price — preference stack may be understated.`,
          security_class: e.security_class,
        });
      }
      summary.total_preference_stack += invested * mult;
    }
  }

  summary.fully_diluted_shares =
    summary.common_shares + summary.preferred_shares + summary.option_shares + summary.warrant_shares;
  if (summary.option_shares === 0) {
    issues.push({
      severity: 'warning',
      code: 'no_option_pool',
      message: 'No option pool detected in the cap table.',
    });
  }

  return { valid: !issues.some((i) => i.severity === 'error'), issues, summary };
}

export interface WaterfallInputs {
  common_shares: number;
  option_pool_shares: number;
  preferred: Array<{
    security_class: string;
    shares: number;
    invested_amount: number;
    liquidation_multiple: number;
    seniority: number;
    conversion_ratio: number;
  }>;
}

/**
 * Project the cap table into the structured inputs the waterfall engine
 * consumes: common (incl. warrants) + option pool + preferred stack with
 * defaulted preferences.
 */
export function toWaterfallInputs(entries: CapTableEntry[]): WaterfallInputs {
  const preferred = entries
    .filter((e) => e.class_type === 'preferred')
    .map((e, i) => ({
      security_class: e.security_class,
      shares: e.shares,
      invested_amount: e.invested_amount ?? (e.price_per_share !== null ? e.price_per_share * e.shares : 0),
      liquidation_multiple: e.liquidation_multiple ?? 1,
      seniority: e.seniority ?? i + 1,
      conversion_ratio: e.conversion_ratio ?? 1,
    }));
  return {
    common_shares: entries
      .filter((e) => e.class_type === 'common' || e.class_type === 'warrant')
      .reduce((n, e) => n + e.shares, 0),
    option_pool_shares: entries.filter((e) => e.class_type === 'option').reduce((n, e) => n + e.shares, 0),
    preferred,
  };
}
