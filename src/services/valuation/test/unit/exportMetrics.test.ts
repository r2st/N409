import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  registerExportMetrics,
  resetExportMetrics,
  recordExport,
} from '../../src/observability/exportMetrics.js';

describe('export metrics (R451, M11)', () => {
  afterEach(() => resetExportMetrics());

  it('counts exports by format, kind and truncation', () => {
    const registry = new MetricsRegistry();
    registerExportMetrics(registry);

    recordExport('csv', 'list', false, 120);
    recordExport('xlsx', 'list', true, 3400);
    recordExport('pdf', 'list', false, 950);
    recordExport('xlsx', 'workbook', false, 2100);

    const text = registry.render();
    expect(text).toContain('data_exports_total{format="csv",kind="list",truncated="false"} 1');
    expect(text).toContain('data_exports_total{format="xlsx",kind="list",truncated="true"} 1');
    expect(text).toContain('data_exports_total{format="pdf",kind="list",truncated="false"} 1');
    expect(text).toContain('data_exports_total{format="xlsx",kind="workbook",truncated="false"} 1');
  });

  it('observes duration in the histogram', () => {
    const registry = new MetricsRegistry();
    registerExportMetrics(registry);

    recordExport('csv', 'list', false, 200);
    recordExport('xlsx', 'workbook', false, 5000);

    const text = registry.render();
    expect(text).toContain('data_export_duration_seconds_count{format="csv",kind="list"} 1');
    expect(text).toContain('data_export_duration_seconds_count{format="xlsx",kind="workbook"} 1');
  });

  it('is silent before registration', () => {
    expect(() => recordExport('csv', 'list', false, 100)).not.toThrow();
  });
});
