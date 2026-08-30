import { describe, expect, it } from 'vitest';
import { checkUploadType, sniffCategory } from '../../src/documents/fileType.js';

const buf = (...parts: Array<number[] | string>): Buffer =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))));

const PDF = buf([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const ZIP = buf([0x50, 0x4b, 0x03, 0x04]);
const ELF = buf([0x7f, 0x45, 0x4c, 0x46]);
const MZ = buf([0x4d, 0x5a, 0x90, 0x00]);
const HTML = buf('<!DOCTYPE html><html><body>hi</body></html>');
const CSV = buf('revenue,cost\n100,40\n');
const SHEBANG = buf('#!/bin/sh\nrm -rf /\n');

describe('sniffCategory', () => {
  it('detects common binary signatures', () => {
    expect(sniffCategory(PDF)).toBe('pdf');
    expect(sniffCategory(PNG)).toBe('png');
    expect(sniffCategory(ZIP)).toBe('zip');
    expect(sniffCategory(ELF)).toBe('executable');
    expect(sniffCategory(MZ)).toBe('executable');
  });

  it('recognises html, shebang, plain text, and NUL-tainted binary', () => {
    expect(sniffCategory(HTML)).toBe('html');
    expect(sniffCategory(SHEBANG)).toBe('executable');
    expect(sniffCategory(CSV)).toBe('text');
    expect(sniffCategory(buf([0x00, 0x01, 0x02]))).toBe('unknown');
    expect(sniffCategory(buf())).toBe('unknown');
  });
});

describe('checkUploadType', () => {
  it('accepts a matching extension + content', () => {
    expect(checkUploadType('report.pdf', PDF).ok).toBe(true);
    expect(checkUploadType('income.csv', CSV).ok).toBe(true);
    expect(checkUploadType('model.xlsx', ZIP).ok).toBe(true);
    expect(checkUploadType('logo.png', PNG).ok).toBe(true);
  });

  it('rejects HTML masquerading as a PDF', () => {
    const res = checkUploadType('report.pdf', HTML);
    expect(res.ok).toBe(false);
    expect(res.sniffed).toBe('html');
  });

  it('rejects a binary uploaded as a text/extractable file', () => {
    expect(checkUploadType('income.csv', PDF).ok).toBe(false);
    expect(checkUploadType('notes.txt', PNG).ok).toBe(false);
  });

  it('always rejects executables regardless of extension', () => {
    expect(checkUploadType('income.csv', ELF).ok).toBe(false);
    expect(checkUploadType('whatever.bin', MZ).ok).toBe(false);
    expect(checkUploadType('data.csv', SHEBANG).ok).toBe(false);
  });

  it('rejects HTML for unknown extensions but allows other content', () => {
    expect(checkUploadType('mystery', HTML).ok).toBe(false);
    expect(checkUploadType('mystery', CSV).ok).toBe(true);
  });

  it('tolerates a benign binary-vs-binary extension mismatch', () => {
    // A PNG named .gif is odd but not a security risk — do not reject.
    expect(checkUploadType('image.gif', PNG).ok).toBe(true);
    // …but text content mislabeled as a binary extension is also fine.
    expect(checkUploadType('photo.png', CSV).ok).toBe(true);
  });
});

/**
 * R222 — the half of a rejection that is not the finding.
 *
 * Every reason here was accurate and none of them was usable.
 * `.csv must be text but the content is zip` tells a client three true things
 * about a file they cannot see inside, in a vocabulary they did not choose, and
 * leaves them to work out that a modern spreadsheet *is* a zip and that what
 * they did wrong was rename a workbook instead of exporting it. That last part
 * is the whole answer, it takes thirty seconds, and it was the part missing.
 *
 * Asserted as a property of the table rather than as a list of sentences, so a
 * seventh rejection added later cannot arrive with only the diagnosis.
 */
describe('every upload rejection says what to do next', () => {
  const REJECTIONS: Array<[string, string, Buffer]> = [
    ['an executable', 'setup.pdf', Buffer.from('MZ\x90\x00binary', 'binary')],
    ['a page saved from a browser', 'accounts.pdf', Buffer.from('<!DOCTYPE html><html></html>')],
    ['a web page with no extension', 'accounts', Buffer.from('<!DOCTYPE html><html></html>')],
    ['a workbook renamed to .csv', 'captable.csv', Buffer.from('PK\x03\x04zipzipzip', 'binary')],
    ['a PDF renamed to .txt', 'notes.txt', Buffer.from('%PDF-1.7\n1 0 obj', 'binary')],
  ];

  for (const [what, filename, buffer] of REJECTIONS) {
    it(`gives ${what} something to try`, () => {
      const check = checkUploadType(filename, buffer);
      expect(check.ok, `${filename} was expected to be refused`).toBe(false);
      const reason = check.reason!;

      // A remedy is an instruction, so it contains a verb the reader can act
      // on. Matching the verbs rather than the sentences lets the wording be
      // rewritten without the guard going quiet.
      expect(reason, `no remedy in: "${reason}"`).toMatch(/\b(re-?export|upload|use|open|save|split)\b/i);
      // And it is a sentence, not a fragment: the founding cases were all
      // under 50 characters and were the entire answer.
      expect(reason.length, `too terse to carry a remedy: "${reason}"`).toBeGreaterThan(60);
    });
  }

  it('never quotes the internal sniffed category at a reader', () => {
    // `sniffed` is an enum member, and three of its values are jargon in a
    // sentence — a client told their file "is zip" has to already know that is
    // what .xlsx is made of. The category still rides along in the problem
    // extension for anybody debugging; it is the prose that must not use it.
    const check = checkUploadType('captable.csv', Buffer.from('PK\x03\x04zipzipzip', 'binary'));
    expect(check.sniffed).toBe('zip');
    expect(check.reason).not.toMatch(/\bis zip\b/);
    expect(check.reason).toMatch(/\.xlsx/);
  });
});
