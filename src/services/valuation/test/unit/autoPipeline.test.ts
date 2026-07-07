import { describe, expect, it } from 'vitest';
import { isExtractable } from '../../src/pipeline/autoPipeline.js';

describe('auto-pipeline trigger gate', () => {
  it('accepts the text-extractable formats the AI route ships', () => {
    for (const filename of ['deck.pdf', 'notes.txt', 'income.csv', 'model.xlsx', 'README.md']) {
      expect(isExtractable({ filename })).toBe(true);
    }
  });

  it('ignores case in the extension', () => {
    expect(isExtractable({ filename: 'INCOME.CSV' })).toBe(true);
  });

  it('rejects binaries and extensionless uploads', () => {
    for (const filename of ['photo.png', 'archive.zip', 'upload', 'video.mp4', 'summary.docx']) {
      expect(isExtractable({ filename })).toBe(false);
    }
  });
});
