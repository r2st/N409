-- P2 #10 — help / knowledge base (docs/n409-remaining-features-spec.md).
-- DB-backed help articles so ops can edit content without a deploy. Seeded
-- from the seven topics previously hard-coded in the frontend HelpWidget
-- (components/HelpWidget.tsx), which stay in code as a fetch-failure fallback.

CREATE TABLE help_articles (
  id         ulid PRIMARY KEY,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  title      text NOT NULL,
  category   text NOT NULL DEFAULT 'General',
  keywords   text NOT NULL DEFAULT '',
  body_html  text NOT NULL,             -- sanitized server-side, like report content
  sort_order integer NOT NULL DEFAULT 0,
  published  boolean NOT NULL DEFAULT true,
  author_id  ulid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX help_articles_category_idx ON help_articles (category, sort_order, title);

INSERT INTO help_articles (id, slug, title, category, keywords, sort_order, body_html) VALUES
  (
    '01N409HE1PART00000000000GS',
    'getting-started',
    'Getting started with a valuation',
    'Getting started',
    'new create begin start valuation request',
    1,
    '<p>Create a valuation from "New valuation", pick the product kind (409A, patent, …) and your company name. The workspace then guides you through documents, methodology params and the report. Your progress is visible on the Overview tab at every step.</p>'
  ),
  (
    '01N409HE1PART00000000000DC',
    'documents',
    'Uploading documents',
    'Getting started',
    'upload file document cap table financials pdf csv',
    2,
    '<p>Open your valuation → Documents. Upload the cap table, income statement, balance sheet, projections, articles of incorporation and option grants. PDF, CSV, TSV, TXT, MD and JSON are machine-readable; run the AI "Missing data check" afterwards to see what is still needed.</p>'
  ),
  (
    '01N409HE1PART00000000000PA',
    'params',
    'Methodology params',
    'Methodology',
    'params weights dlom dloc approach methodology',
    3,
    '<p>Params define the methodology: the four approach weights (asset, OPM, income, market) must sum to 1.0, plus DLOC/DLOM settings and the market method. Analysts set these — clients can review them read-only.</p>'
  ),
  (
    '01N409HE1PART00000000000CA',
    'calculations',
    'Running calculations',
    'Methodology',
    'calculate compute engine fmv fair market value recalculate',
    4,
    '<p>Calculations combine saved params with AI-extracted inputs and comparables. Run a full calculation first; afterwards you can recalculate a single approach (asset, OPM, income or market) without re-running everything else.</p>'
  ),
  (
    '01N409HE1PART00000000000RE',
    'report',
    'Reports and versions',
    'Reports',
    'report pdf draft publish version editor',
    5,
    '<p>The Report tab holds the sectioned report with immutable version history. Ops edit and render the PDF; the report becomes visible to clients once the valuation reaches the draft states, and publishing locks the engagement.</p>'
  ),
  (
    '01N409HE1PART00000000000ST',
    'states',
    'Valuation states',
    'Process',
    'state status lifecycle pending started published waiting',
    6,
    '<p>Valuations move through a 14-state lifecycle from pending to published. "Waiting on client" flags that we need something from you — check the chat thread on the Overview tab for what is blocking.</p>'
  ),
  (
    '01N409HE1PART00000000000AC',
    'access',
    'Who can see what',
    'Process',
    'roles permissions access partner client ops team',
    7,
    '<p>Clients see their own valuations; partners see their channel; operations see everything. Working tabs (Workbook, Overwrites, AI, Calculations) are operations-only. Reports become client-visible from the draft stage onward.</p>'
  )
ON CONFLICT (slug) DO NOTHING;
