import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { brandingFor } from '../../src/routes/reports.js';
import type { ValuationRow } from '../../src/repos/valuations.js';

/**
 * What the cover of a partner engagement's report says about the firm that
 * prepared it.
 *
 * The read behind this used to be `findPartnerById`, whose column list predates
 * migration 0091: it stops at `name`/`brand_color`/`logo_url`, so the cover
 * could see neither the firm's public `brand_name` nor the `white_label_enabled`
 * switch that decides whether the brand is live at all. Both halves are pinned
 * here because both are silent — a wrong firm name and a not-yet-live logo both
 * render a perfectly valid PDF.
 */

/** A partner row as `findBrandingByPartnerId` returns it. */
function partnerRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ptr-1',
    name: 'bridge-uk (ops channel)',
    subdomain: null,
    brand_name: 'Bridge Valuation Advisors LLP',
    brand_tagline: null,
    brand_color: '#1d4ed8',
    accent_color_dark: null,
    logo_url: null,
    logo_dark_url: null,
    favicon_url: null,
    support_email: null,
    white_label_enabled: true,
    ...over,
  };
}

function poolWith(row: Record<string, unknown> | null): pg.Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM partners')) return { rows: row ? [row] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
}

const VALUATION = { id: 'val-1', partner_id: 'ptr-1' } as unknown as ValuationRow;

describe('report cover branding', () => {
  it('names the firm the way the firm names itself, not the ops channel label', async () => {
    const branding = await brandingFor(poolWith(partnerRow()), VALUATION);
    expect(branding?.partner_name).toBe('Bridge Valuation Advisors LLP');
  });

  it('falls back to the channel name when the firm set no brand name', async () => {
    const branding = await brandingFor(poolWith(partnerRow({ brand_name: null })), VALUATION);
    expect(branding?.partner_name).toBe('bridge-uk (ops channel)');
  });

  it('keeps a staged brand off the deliverable until white label is live', async () => {
    const branding = await brandingFor(
      poolWith(
        partnerRow({
          white_label_enabled: false,
          logo_url: 'https://cdn.example.com/staged.png',
        }),
      ),
      VALUATION,
    );
    // The attribution stays — who prepared the report is a fact about the
    // engagement — but the firm's colour and mark do not.
    expect(branding).toEqual({
      partner_name: 'bridge-uk (ops channel)',
      brand_color: null,
      logo: null,
    });
  });

  it('lifts an accent that would be invisible on the cover', async () => {
    // #f7f3a0 clears nothing against paper; the resolved accent is darkened
    // until it does, and it is the same value the app paints with.
    const branding = await brandingFor(poolWith(partnerRow({ brand_color: '#f7f3a0' })), VALUATION);
    expect(branding?.brand_color).not.toBe('#f7f3a0');
    expect(branding?.brand_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('passes an already-legible accent through unchanged', async () => {
    const branding = await brandingFor(poolWith(partnerRow()), VALUATION);
    expect(branding?.brand_color).toBe('#1d4ed8');
  });

  it('is undefined for a direct engagement and for an archived channel', async () => {
    await expect(
      brandingFor(poolWith(partnerRow()), { id: 'v', partner_id: null } as unknown as ValuationRow),
    ).resolves.toBeUndefined();
    // `findBrandingByPartnerId` filters archived rows out in SQL.
    await expect(brandingFor(poolWith(null), VALUATION)).resolves.toBeUndefined();
  });
});
