import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sniffImageKind } from '../../src/clients/partnerLogo.js';

/**
 * R270 — what the branding form tells a firm to upload, against what a report
 * cover will actually draw.
 *
 * `logo_url` has two consumers and they do not accept the same files. The
 * application renders it in an `<img>`, where an SVG is fine. A cover goes
 * through `fetchPartnerLogo`, which sniffs the first eight bytes and keeps png
 * or jpeg — an SVG is `unsupported_format`, the cover is drawn without the mark,
 * and the reason is written to a log the firm's administrator will never see.
 * The help text beside the box said "an SVG or PNG", naming the refused format
 * first and never mentioning the accepted one.
 *
 * Which is a fact about two files and therefore drifts. The sniffer is where
 * the rule lives; this is the sentence being held to it.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANDING_PAGE = path.resolve(HERE, '../../../web-frontend/src/pages/BrandingPage.tsx');

/** The `help:` string of the `logo_url` entry in `TEXT_FIELDS`, read as text. */
function logoHelp(): string {
  const source = readFileSync(BRANDING_PAGE, 'utf8');
  const at = source.indexOf("key: 'logo_url'");
  expect(at, "the logo_url field in web-frontend's BrandingPage").toBeGreaterThan(-1);
  const help = source.indexOf('help:', at);
  const end = source.indexOf('\n  },', help);
  return source.slice(help, end).replace(/\s+/g, ' ');
}

const png = () => Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(16)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');

describe('what a report cover can draw, and what the form says', () => {
  it('keeps png and jpeg and nothing else', () => {
    expect(sniffImageKind(png())).toBe('png');
    expect(sniffImageKind(jpeg())).toBe('jpeg');
    expect(sniffImageKind(svg())).toBeNull();
    expect(sniffImageKind(Buffer.from('GIF89a-------', 'latin1'))).toBeNull();
    expect(sniffImageKind(Buffer.from('RIFF____WEBPVP8 ', 'latin1'))).toBeNull();
  });

  it('names both accepted formats in the hint the administrator reads', () => {
    const help = logoHelp();
    expect(help).toMatch(/PNG/);
    expect(help).toMatch(/JPEG/);
  });

  it('does not offer the refused format as an answer', () => {
    // The page says SVG elsewhere on purpose — the warning under the box says
    // what happens to one. The hint is what a reader follows before they type.
    expect(logoHelp()).not.toMatch(/SVG/i);
  });

  it('says the cover is one of the places this mark lands', () => {
    // Without it the sentence is a rule with no reason, and the two consumers
    // disagreeing is the whole cause of the confusion.
    expect(logoHelp()).toMatch(/report cover/i);
  });
});
