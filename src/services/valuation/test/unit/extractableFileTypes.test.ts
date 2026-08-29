import { describe, expect, it } from 'vitest';
import { EXTENSION_CATEGORIES, checkUploadType } from '../../src/documents/fileType.js';
import { EXTRACTABLE_EXTENSIONS } from '../../src/routes/ai.js';

/**
 * The content check and the extraction list are two allowlists over the same
 * files, kept in different modules, and they had drifted.
 *
 * `checkUploadType` falls back to "anything that is not an executable or HTML"
 * for an extension it has no entry for, and that fallback is missing exactly
 * one rule: the one that says a text format has to contain text. So an
 * uncategorised extension is checked, but never against its own container —
 * which is the wrong way round for an *extractable* format, because that file
 * is decoded, parsed and handed to a model with no operator in the loop to
 * notice it was never a spreadsheet.
 *
 * `.xlsm` was the extension that had gone missing. Its container rule (a ZIP,
 * like every other OOXML package) happens to be one the fallback reaches the
 * same verdict on, so nothing was reachable through it today — the finding is
 * the drift, not a live hole. The next format added to the extraction list is
 * where it would cost something: a `.log`, a `.yaml`, an `.xml` shipped to the
 * model would be text with no text check, and this test is what makes adding it
 * a decision rather than an omission.
 */
describe('every extractable extension has a content category', () => {
  it('leaves none of them to the unknown-extension fallback', () => {
    const uncategorised = [...EXTRACTABLE_EXTENSIONS].filter(
      (ext) => !(ext.replace(/^\./, '') in EXTENSION_CATEGORIES),
    );
    expect(uncategorised).toEqual([]);
  });

  /** What the fallback does not do, and why the census above is worth having. */
  it('does not hold an uncategorised extension to any container', () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x04]);
    expect(checkUploadType('notes.txt', binary).ok).toBe(false);
    expect(EXTENSION_CATEGORIES.log).toBeUndefined();
    expect(checkUploadType('notes.log', binary).ok).toBe(true);
  });

  it('reads a macro-enabled workbook as the OOXML package it is', () => {
    expect(EXTENSION_CATEGORIES.xlsm).toEqual(['zip']);
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(checkUploadType('model.xlsm', zip).ok).toBe(true);
  });
});
