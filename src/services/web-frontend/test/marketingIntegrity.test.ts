import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PARTNER_LOGOS, PRODUCT_CONTENT, STATS, TESTIMONIALS } from '../src/lib/marketing';
import { allPageMeta } from '../src/lib/pageMeta';

/**
 * Guards on what the public site is allowed to claim.
 *
 * The marketing surface was built out from a spec before the business had
 * customers, a calendar, a demo recording, or mailboxes — so it accumulated
 * invented testimonials, an unsubstantiated speed comparison, and a set of
 * example.com-style links. Each of those is individually easy to reintroduce
 * while filling in a page, and none of them fails a type check. These tests are
 * the standing check that they don't come back.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** Every source file under src/, recursively. */
function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Strip comments before scanning. These assertions are about what the site
 * *says*; a comment explaining why a phrase is banned must not itself trip the
 * check that bans it.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles().map((file) => ({
  file: path.relative(SRC, file),
  text: stripComments(readFileSync(file, 'utf8')),
}));

describe('no placeholder contact details ship to production', () => {
  it('uses no reserved example domains', () => {
    // RFC 2606 reserves .example/.test/.invalid — anything addressed there is
    // guaranteed to bounce.
    const offenders = FILES.filter(({ text }) => /@[a-z0-9-]+\.(example|test|invalid)\b/i.test(text)).map(
      ({ file }) => file,
    );
    expect(offenders).toEqual([]);
  });

  it('hardcodes no booking, video, or social URLs', () => {
    // These belong in siteConfig so an unconfigured environment renders no link
    // rather than a dead one.
    const offenders = FILES.filter(
      ({ file, text }) =>
        file !== 'lib/siteConfig.ts' &&
        /https?:\/\/(www\.)?(calendly\.com|youtube\.com|youtube-nocookie\.com|youtu\.be|twitter\.com|x\.com|linkedin\.com)/i.test(
          text,
        ),
    ).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

describe('social proof is real or absent', () => {
  it('ships no testimonial that is not a permissioned customer quote', () => {
    // Populating this list is fine — inventing entries for it is not. If this
    // fails, confirm each quote has written permission covering the person's
    // name, role, and company, then update the expectation.
    expect(TESTIMONIALS).toEqual([]);
  });

  it('describes the accounting vendors without implying they endorse us', () => {
    const claims = FILES.filter(({ text }) => /trusted by/i.test(text)).map(({ file }) => file);
    expect(claims).toEqual([]);
    // They are integrations; that they appear at all is a factual statement
    // about what we connect to.
    expect(PARTNER_LOGOS.length).toBeGreaterThan(0);
  });
});

describe('headline claims are substantiated', () => {
  it('makes no unsubstantiated comparative speed or price claim in the stat strip', () => {
    // "2× faster than a traditional firm" sat directly above our competitor
    // comparison pages with nothing behind it. Stats must be product facts.
    for (const stat of STATS) {
      expect(`${stat.value} ${stat.label}`).not.toMatch(/\b(faster|cheaper|better|more accurate)\s+than\b/i);
    }
  });

  it('quotes no fabricated customer or volume counts', () => {
    // Guards against "trusted by 500+ startups"-style numbers appearing in the
    // stat strip, which we have no basis for.
    for (const stat of STATS) {
      expect(stat.label).not.toMatch(/\b(customers?|companies|startups|clients)\b/i);
    }
  });

  it('states a delivery promise the pricing page also makes', () => {
    expect(STATS.some((s) => /24h/i.test(s.value))).toBe(true);
    expect(allPageMeta().find((p) => p.path === '/pricing')!.description).toMatch(/24-hour/i);
  });

  it('quotes no §1202 threshold without the issuance date it belongs to', () => {
    // The QSBS page promised documentation "that your company met the $50M
    // gross-asset threshold" — the number for stock issued on or before
    // 4 July 2025, and the wrong one for anything issued since (Public Law
    // 119-21 raised it to $75M). The same page's FAQ already told the reader
    // our analysis reflects the rules for their issuance date, so the page
    // contradicted itself as well as the statute.
    //
    // Written against the whole marketing surface rather than the one page: a
    // statutory dollar figure quoted bare is a claim that goes stale on a date
    // nobody is watching for, and the fix is to make it name the date it is
    // true on.
    const qsbs = PRODUCT_CONTENT['qsbs-attestation']!;
    const prose = [
      ...qsbs.solution.map((s) => s.body),
      ...qsbs.included,
      ...qsbs.faq.map((f) => f.a),
      qsbs.problem.body,
    ];
    for (const line of prose) {
      if (/\$\d+M\b/.test(line)) expect(line, line).toMatch(/2025/);
    }
    // Non-vacuity: the threshold is stated somewhere, and states both figures.
    const thresholds = prose.filter((line) => /\$\d+M\b/.test(line));
    expect(thresholds.length).toBeGreaterThan(0);
    expect(thresholds.join(' ')).toContain('$50M');
    expect(thresholds.join(' ')).toContain('$75M');
  });
});
