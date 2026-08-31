import { describe, expect, it } from 'vitest';
// @ts-expect-error — a repo-root tool, deliberately plain .mjs with no build step.
import { deprecatedOf, resolutionsIn } from '../../../../tools/check-deprecations.mjs';

/**
 * The offline half of `tools/check-deprecations.mjs`.
 *
 * The tool's own run needs the registry, so CI runs it beside `npm audit`
 * rather than here. What is testable without a network is the reading it does
 * before it asks anything: which resolutions it will ask about, and which
 * answers it treats as a hit. Both have a wrong version that looks right —
 * asking about a workspace link queries a name that does not exist publicly,
 * and reading "is this package deprecated?" off the packument instead of "is
 * *our* version deprecated?" reports every dependency whose old releases were
 * retired.
 */

describe('which resolutions the checker will ask the registry about', () => {
  it('skips the root entry and workspace links, which have no registry name', () => {
    const found = resolutionsIn({
      packages: {
        '': { name: 'n409' },
        'src/services/valuation': { name: '@n409/valuation', version: '0.1.0' },
        'node_modules/@n409/valuation': { resolved: '', link: true },
        'node_modules/pg': { version: '8.23.0', resolved: 'https://registry.npmjs.org/pg/-/pg-8.23.0.tgz' },
      },
    });
    expect([...found.keys()]).toEqual(['pg']);
  });

  it('names a nested copy by the package, not by the path it sits at', () => {
    const found = resolutionsIn({
      packages: {
        'node_modules/glob': { version: '13.0.6', resolved: 'https://registry.npmjs.org/x' },
        'node_modules/test-exclude/node_modules/glob': {
          version: '10.5.0',
          resolved: 'https://registry.npmjs.org/x',
        },
        'node_modules/@xmldom/xmldom': { version: '0.8.15', resolved: 'https://registry.npmjs.org/x' },
      },
    });
    expect([...found.get('glob')!].sort()).toEqual(['10.5.0', '13.0.6']);
    expect([...found.get('@xmldom/xmldom')!]).toEqual(['0.8.15']);
  });
});

describe('which answers count as a hit', () => {
  const packument = {
    versions: {
      '0.8.13': { deprecated: 'this version has\n  critical issues' },
      '0.8.15': {},
      '0.9.12': {},
    },
  };

  it('reports the version we resolved', () => {
    expect(deprecatedOf('@xmldom/xmldom', ['0.8.13'], packument)).toEqual([
      { name: '@xmldom/xmldom', version: '0.8.13', notice: 'this version has critical issues' },
    ]);
  });

  /**
   * The half that keeps this usable. Nearly every long-lived package has some
   * retired release; a check that reported on the packument rather than on the
   * resolution would fire on all of them and be turned off within a week.
   */
  it('says nothing when a sibling version is deprecated and ours is not', () => {
    expect(deprecatedOf('@xmldom/xmldom', ['0.8.15'], packument)).toEqual([]);
  });

  it('says nothing when the registry knows no such version', () => {
    expect(deprecatedOf('@xmldom/xmldom', ['0.8.99'], packument)).toEqual([]);
    expect(deprecatedOf('nope', ['1.0.0'], undefined)).toEqual([]);
  });
});
