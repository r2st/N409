import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { articleById } from '../src/data/helpContent';
import { TAB_HELP } from '../src/pages/valuation/ValuationWorkspace';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Every `<HelpIcon article="…" />` occurrence in the app, with its source file. */
function helpIconUsages(): { file: string; article: string }[] {
  const usages: { file: string; article: string }[] = [];
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8');
    // Only static string literals — dynamic `article={helpArticle}` is covered
    // separately via the TAB_HELP map assertions below.
    for (const m of text.matchAll(/article=(?:"([a-z0-9-]+)"|'([a-z0-9-]+)')/g)) {
      usages.push({ file: file.slice(srcDir.length + 1), article: m[1] ?? m[2]! });
    }
  }
  return usages;
}

describe('help link coverage', () => {
  it('resolves every article id referenced by a HelpIcon (no "coming soon" links)', () => {
    const usages = helpIconUsages();
    // Sanity: we expect the icons to actually exist across the app.
    expect(usages.length).toBeGreaterThan(10);

    const broken = usages.filter((u) => !articleById(u.article));
    expect(broken, `Unknown help article(s): ${JSON.stringify(broken)}`).toEqual([]);
  });

  it('maps every workspace tab to a real help article', () => {
    for (const [tab, article] of Object.entries(TAB_HELP)) {
      expect(articleById(article), `TAB_HELP["${tab}"] → "${article}" does not exist`).toBeTruthy();
    }
  });

  it('covers every workspace tab route in TAB_HELP', () => {
    // Sub-paths rendered under the ValuationWorkspace shell (App.tsx routes).
    // '' is the index (Overview) tab.
    const tabRoutes = [
      '',
      'intake',
      'company',
      'documents',
      'cap-table',
      'model',
      'params',
      'ai',
      'tasks',
      'calculations',
      'progress',
      'qa',
      'health',
      'decisions',
      'scenarios',
      'bridge',
      'analytics',
      'workbook',
      'overwrites',
      'report',
      'grants',
      'asc718',
      'monitoring',
      'engagement',
      'package',
    ];
    const missing = tabRoutes.filter((t) => !(t in TAB_HELP));
    expect(missing, `Workspace tabs with no help mapping: ${missing.join(', ')}`).toEqual([]);
  });

  it('ensures each primary feature page wires a HelpIcon', () => {
    const featurePages = [
      'pages/DashboardPage.tsx',
      'pages/ValuationsPage.tsx',
      'pages/NewValuationPage.tsx',
      'pages/PortfolioPage.tsx',
      'pages/SensitivityPage.tsx',
      'pages/EngagementsPage.tsx',
      'pages/MonitorsPage.tsx',
      'pages/TemplatesPage.tsx',
      'pages/BillingPage.tsx',
      'pages/SettingsPage.tsx',
      'pages/TasksPage.tsx',
      'pages/AuditorPortalPage.tsx',
      'pages/PartnerPortalPage.tsx',
      'pages/BotPromptsPage.tsx',
      'pages/ActivityLogPage.tsx',
      'pages/AdminSsoPage.tsx',
      'pages/AdminRetentionPage.tsx',
      'pages/FundPortfolioPage.tsx',
      'pages/DebtInstrumentsPage.tsx',
      'pages/valuation/Asc718Tab.tsx',
      'pages/valuation/ValuationWorkspace.tsx',
    ];
    const withoutHelp = featurePages.filter(
      (rel) => !readFileSync(join(srcDir, rel), 'utf8').includes('HelpIcon'),
    );
    expect(withoutHelp, `Feature pages missing a HelpIcon: ${withoutHelp.join(', ')}`).toEqual([]);
  });
});
