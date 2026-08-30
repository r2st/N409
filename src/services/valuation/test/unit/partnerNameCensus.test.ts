import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPartnerName, resolveBranding, type BrandingSource } from '../../src/domain/branding.js';
import { publicPartnerNameSql } from '../../src/repos/branding.js';

/**
 * Which name a firm is called by, and who is allowed to use the other one.
 *
 * `partners` carries two names. `name` is the label ops typed when the channel
 * was opened; `brand_name` (migration 0091) is what the firm calls itself in
 * front of its own clients, and 0091 says in as many words that the first "is
 * not necessarily what clients should read". `white_label_enabled` decides
 * which is live, on the same terms as the colour and the logo.
 *
 * Every client-facing surface had picked `name` on its own, because `name` is
 * the column that was there first and the one a `SELECT` reaches for: the
 * report cover's attribution, the `{{partner_name}}` and `{{platform_name}}` a
 * workflow email renders, the campaign scan, and the operator's own preview of
 * the template about to be sent. A firm that set its brand name saw it in the
 * application, on its login page and in its client intake, and its clients read
 * the ops channel label.
 *
 * So the rule lives in one place in each language — `publicPartnerName` and
 * `publicPartnerNameSql` — and every other reading of a partner's name has to
 * be named here as an internal one. An admin console showing ops which channel
 * a row belongs to genuinely wants the ops label; a message leaving the
 * building does not.
 *
 * ## An exemption is a claim about the reader, and one of them was wrong
 *
 * `repos/valuations.ts` was on this list as "an ops/firm-internal roster rather
 * than a document a client receives". The engagement export is not that:
 * `/api/v1/valuations/export` is behind `app.authenticate` and nothing more,
 * and `routes/exports.ts` has a whole per-reader projection
 * (`OPS_ONLY_EXPORT_COLUMNS`) that exists *because* clients and partner members
 * download it — its own note settles `partner_name` with "stay for everyone".
 * So the file every client of a white-labelled firm could download was the one
 * place in the product still calling that firm by its ops channel label.
 *
 * Which is the failure mode of a list like this one: the offending line is
 * matched precisely, and then waved through by a sentence about who reads it
 * that nobody re-checks when the surface grows a new reader. The remaining
 * entries each name a console or a subject-access record, not a file a client
 * can ask for.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../../src');

function sourceTree(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceTree(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Readings of `partners.name` that are deliberately the internal label, with
 * what makes them internal.
 */
const INTERNAL: Record<string, string> = {
  'repos/adminUsers.ts':
    'The ops user console: which channel a person belongs to, for the people who named the channel.',
  'repos/invitations.ts': 'The ops invitation console, same reader as above.',
  'repos/apiTokens.ts': 'The ops token console — a key is administered against the channel, not the brand.',
  'repos/dataExport.ts':
    'The Art. 15 export: a record of which channel holds the subject’s data, not a message addressed to them.',
};

describe('partner name census', () => {
  const files = sourceTree(SRC);

  it('resolves the client-facing name through the one rule, in both languages', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file).split('\\').join('/');
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        // A query aliasing a partner's name for something downstream to render.
        if (!/AS partner_name/.test(line)) continue;
        if (line.includes('publicPartnerNameSql')) continue;
        if (INTERNAL[rel]) continue;
        offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every named internal reading still exists, so the list cannot rot', () => {
    for (const [rel, why] of Object.entries(INTERNAL)) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect(/AS partner_name/.test(text), `${rel} no longer reads a partner name (${why})`).toBe(true);
    }
  });

  /**
   * Surfaces a reader outside the firm can obtain the file from, named
   * positively.
   *
   * The census above goes green two ways — by fixing a read, or by adding a
   * line to `INTERNAL` — and the second is how the engagement export stayed
   * wrong. So the files whose reader is *not* ops are asserted here as well,
   * where an exemption is not one of the available answers.
   */
  const CLIENT_READABLE: Record<string, string> = {
    'repos/valuations.ts':
      'GET /api/v1/valuations/export — any authenticated caller, within their own scope.',
  };

  it('a read a client can download resolves the brand name, exemption or not', () => {
    for (const [rel, why] of Object.entries(CLIENT_READABLE)) {
      expect(INTERNAL[rel], `${rel} may not be exempted (${why})`).toBeUndefined();
      const lines = readFileSync(join(SRC, rel), 'utf8')
        .split('\n')
        .filter((line) => /AS partner_name/.test(line));
      expect(lines.length, `${rel} no longer names a partner (${why})`).toBeGreaterThan(0);
      for (const line of lines) expect(line, why).toContain('publicPartnerNameSql');
    }
  });

  it('the SQL spells the same rule the TypeScript does', () => {
    const sql = publicPartnerNameSql('p');
    // Gated on the switch, brand name first, blank brand name is no brand name.
    expect(sql).toContain('p.white_label_enabled');
    expect(sql).toContain("nullif(btrim(p.brand_name), '')");
    expect(sql).toContain('p.name');
  });
});

describe('publicPartnerName', () => {
  const row = { name: 'bridge-uk (ops)', brand_name: 'Bridge Advisors LLP', white_label_enabled: true };

  it('prefers the brand name once white label is live', () => {
    expect(publicPartnerName(row)).toBe('Bridge Advisors LLP');
  });

  it('keeps the channel label while the brand is only staged', () => {
    expect(publicPartnerName({ ...row, white_label_enabled: false })).toBe('bridge-uk (ops)');
  });

  it('treats a blank brand name as unset', () => {
    expect(publicPartnerName({ ...row, brand_name: '   ' })).toBe('bridge-uk (ops)');
    expect(publicPartnerName({ ...row, brand_name: null })).toBe('bridge-uk (ops)');
  });

  it('is the name `resolveBranding` resolves, so the two cannot drift', () => {
    const source = {
      id: 'p1',
      subdomain: null,
      brand_tagline: null,
      brand_color: null,
      accent_color_dark: null,
      logo_url: null,
      logo_dark_url: null,
      favicon_url: null,
      support_email: null,
      ...row,
    } satisfies BrandingSource;
    expect(resolveBranding(source).name).toBe(publicPartnerName(source));
  });
});
