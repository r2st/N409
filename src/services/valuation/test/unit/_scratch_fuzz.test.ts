import { describe, it } from 'vitest';
import { parseCsvSheet, sniffDelimiter } from '../../src/domain/capTable.js';
import { csvEscape, toCsv } from '../../src/domain/csv.js';
import { decodeSheetText } from '../../src/domain/sheetText.js';
import { decodeXmlText, columnIndex, excelSerialToIso } from '../../src/domain/xlsxRead.js';
import { safeFilename } from '../../src/documents/filename.js';
import { normalizeViewQuery } from '../../src/routes/savedViews.js';
import { buildMimeMessage, textToHtml, encodeQuotedPrintable, foldHeader, encodeHeaderWords, messageIdDomain } from '../../src/email/mime.js';
import { renderTemplate } from '../../src/domain/communications.js';

const C = (n: number) => String.fromCharCode(n);
const HOSTILE: string[] = [
  '', ' ', 'a b', C(0xd800), C(0xdfff), 'a' + C(0xd800) + 'b',
  C(0xfeff), C(0x202e), C(0x200b), C(0x00a0), C(13) + C(10), C(13), C(10), C(9), C(0),
  '"', '""', '"""', ',', ';', '=', '-1', '+1', '@x',
  '__proto__', 'constructor', 'prototype', 'toString',
  '&amp;', '&#0;', '&#x110000;', '&constructor;', '&#xD800;',
  'x'.repeat(100000), '<script>', '</td>', 'a'.repeat(5000) + C(0xd83d),
  '{{a}}', '${x}', '\\', '%00', C(27) + '[31m',
  'A'.repeat(30), 'ZZZZZZZZZZZZZZZZZZZZ1',
];

function tryAll(name: string, fn: (s: string) => unknown) {
  for (const s of HOSTILE) {
    try {
      fn(s);
    } catch (err) {
      const e = err as Error;
      const n = e?.constructor?.name;
      if (n === 'CsvReadError' || n === 'SheetTextError' || n === 'XlsxReadError' || n === 'ApiProblem') continue;
      console.log('THROW ' + name + ' <' + JSON.stringify(s).slice(0, 40) + '>: ' + n + ': ' + String(e?.message).slice(0, 140));
    }
  }
}

describe('scratch', () => {
  it('runs', () => {
    tryAll('parseCsvSheet', (s) => parseCsvSheet(s));
    tryAll('sniffDelimiter', (s) => sniffDelimiter(s));
    tryAll('csvEscape', (s) => csvEscape(s));
    tryAll('toCsv', (s) => toCsv(['a'] as never, [{ a: s }] as never));
    tryAll('decodeSheetText', (s) => decodeSheetText(Buffer.from(s, 'utf8')));
    tryAll('decodeXmlText', (s) => decodeXmlText(s));
    tryAll('columnIndex', (s) => columnIndex(s));
    tryAll('safeFilename', (s) => safeFilename(s));
    tryAll('normalizeViewQuery', (s) => normalizeViewQuery(s));
    tryAll('textToHtml', (s) => textToHtml(s));
    tryAll('encodeQuotedPrintable', (s) => encodeQuotedPrintable(s));
    tryAll('foldHeader', (s) => foldHeader('X', s));
    tryAll('encodeHeaderWords', (s) => encodeHeaderWords(s));
    tryAll('messageIdDomain', (s) => messageIdDomain(s));
    tryAll('renderTemplate', (s) => renderTemplate(s, { a: '1' }));
    tryAll('mime-subject', (s) => buildMimeMessage({ from: 'a@b.c', to: 'd@e.f', subject: s, body: 'x' }));
    tryAll('mime-body', (s) => buildMimeMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'x', body: s }));
    tryAll('mime-from', (s) => buildMimeMessage({ from: s, to: 'd@e.f', subject: 'x', body: 'y' }));
    for (const n of [0, -1, 1e18, -1e18, NaN, Infinity, 2958465, 0.5, 1e308]) {
      try { excelSerialToIso(n); } catch (e) { console.log('THROW excelSerialToIso ' + n + ': ' + String((e as Error).message).slice(0, 140)); }
    }
  });
});
