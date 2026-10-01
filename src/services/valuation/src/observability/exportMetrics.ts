import type { Counter, Histogram, MetricsRegistry } from '@n409/shared';

/**
 * How exports are used, and how long they take to build.
 *
 * WHY THIS EXISTS (R451, methodology M11). The export path builds up to 10,000
 * rows into a CSV, a PDF or a multi-sheet XLSX — the auditor workbook pulls
 * five tables and a calculation in parallel — and nothing on this box said how
 * long any of it takes. `http_request_duration_seconds` sees the request, and
 * the request is 95 % one of the two operations below: the database read and
 * the file build. But the format is in the query string, and the route label
 * is the same for all three, so a PDF that takes four seconds to rasterize ten
 * thousand rows is indistinguishable from a CSV that took four seconds to
 * stream — and both are lumped with the XLSX whose write path is synchronous
 * and whose sheet set varies by engagement.
 *
 * `data_exports_total` is the denominator every rate below divides into. Its
 * `truncated` label tracks whether the row cap (MAX_EXPORT_ROWS) is being hit,
 * which is the signal that clients are outgrowing the export ceiling and need
 * the streaming path this estate has not yet built.
 *
 * `data_export_duration_seconds` is wall time from the route handler's first
 * database call to the reply leaving. The histogram lets an alert fire on the
 * p99 of workbook builds — which is the only format that pulls five tables in
 * parallel and then hands them to the XLSX writer — separately from the p99 of
 * a list CSV whose cost is one scan and one text join.
 */
let exports: Counter | null = null;
let duration: Histogram | null = null;

export type ExportFormat = 'csv' | 'pdf' | 'xlsx';
export type ExportKind = 'list' | 'workbook';

export function registerExportMetrics(registry: MetricsRegistry): void {
  exports = registry.counter(
    'data_exports_total',
    'Completed data exports by format, kind and whether the row cap applied.',
    ['format', 'kind', 'truncated'],
  );
  duration = registry.histogram(
    'data_export_duration_seconds',
    'Wall time of a data export from first database call to reply, by format and kind.',
    ['format', 'kind'],
  );
}

export function resetExportMetrics(): void {
  exports = null;
  duration = null;
}

export function recordExport(
  format: ExportFormat,
  kind: ExportKind,
  truncated: boolean,
  durationMs: number,
): void {
  exports?.inc({ format, kind, truncated: truncated ? 'true' : 'false' });
  duration?.observe(durationMs / 1000, { format, kind });
}
