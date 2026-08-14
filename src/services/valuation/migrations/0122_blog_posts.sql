-- The marketing blog (design §16.2, P2-20).
--
-- Shaped on `help_articles` (0048) rather than on something new, because the
-- problem is the same one: authored HTML, addressed by slug, edited by ops
-- without a deploy, and sanitised server-side with the report policy. What a
-- blog adds over a help article is everything a *public* page needs — a
-- publication date a reader and a crawler both care about, a byline, an
-- excerpt for the index and the link preview, and a card image.
--
-- Two fields deserve their reasoning stated.
--
-- `published_at` is separate from `published` and is not `created_at`. A post
-- written on Tuesday and published on Friday is a Friday post: `created_at` is
-- when the row appeared and would date the article to a draft nobody read.
-- Keeping the flag as well as the date means an unpublish does not destroy the
-- original date, so re-publishing a corrected post does not silently move it
-- to the top of the index and re-date it for every crawler that indexed it.
--
-- `author` is text, not a user reference. The byline on a public article is a
-- name and a credential the piece is published under — "Dana Reyes, ASA" — and
-- it must not change because an account was renamed, nor disappear because
-- somebody left. `author_id` is kept alongside it for the audit trail, which
-- is a different question: who edited this row.

CREATE TABLE blog_posts (
  id           ulid PRIMARY KEY,
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  title        text NOT NULL,
  excerpt      text NOT NULL DEFAULT '',
  body_html    text NOT NULL,
  category     text NOT NULL DEFAULT 'General',
  keywords     text NOT NULL DEFAULT '',
  author       text NOT NULL DEFAULT '',
  og_image     text,
  published    boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  author_id    ulid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- A published post always has a date. Without this the index has to invent
  -- one, and every reader-facing surface would have to decide what to invent.
  CONSTRAINT blog_posts_published_dated CHECK (NOT published OR published_at IS NOT NULL)
);

-- The index page's query: published, newest first. Partial because drafts are
-- the rows it never returns.
CREATE INDEX blog_posts_published_idx
  ON blog_posts (published_at DESC)
  WHERE published;

-- A first post, so `/blog` is a page and not an empty state on the day this
-- ships. Deliberately about the platform's own method rather than a
-- placeholder: an empty marketing surface is worse than no marketing surface,
-- and a lorem-ipsum one is worse than either.
INSERT INTO blog_posts (id, slug, title, excerpt, category, keywords, author, published, published_at, body_html)
VALUES (
  '01N409B1GPST00000000000001',
  'what-a-409a-valuation-actually-defends',
  'What a 409A valuation actually has to defend',
  'A 409A is not a number — it is an argument that has to survive an auditor reading it two years later. Here is what that argument is made of.',
  'Methodology',
  '409a valuation audit defensible safe harbor irs methodology',
  'The N409 team',
  true,
  now(),
  '<p>A 409A valuation is often described as "getting a number for your common stock". That framing is what leads companies to shop on price and turnaround alone, and it is why so many valuations fail the only test that matters: being read, years later, by somebody who was not in the room.</p>
   <p>What a 409A actually produces is an <strong>argument</strong>. The number is its conclusion. The argument has four parts, and every one of them has to hold on its own.</p>
   <h2>1. The inputs, and where they came from</h2>
   <p>Every figure in the model traces to a document: the cap table to the charter and the stock ledger, the revenue to the financial statements, the forecast to management''s own plan. An input nobody can trace is an assumption wearing a number''s clothes.</p>
   <h2>2. The approaches applied, and why</h2>
   <p>Asset, income, market and a backsolve to the most recent round are not a menu to pick one item from. Each answers a different question about the same company, and the weighting between them is a judgment that has to be written down — including the approaches that were considered and given no weight, and why.</p>
   <h2>3. The allocation</h2>
   <p>Total equity value is not the answer. The answer is what the common stock is worth, which depends on every liquidation preference, participation right and conversion term sitting above it. This is where a valuation is most often quietly wrong, because it is the part a spreadsheet cannot check for you.</p>
   <h2>4. The discounts</h2>
   <p>A marketability discount is the single most contestable figure in the report. Applying one without naming the model, the inputs to it, and the transfer restrictions the company''s own documents impose is the fastest way to lose an audit.</p>
   <p>None of this is exotic. It is what a defensible valuation has always been. What has changed is how much of the assembling can be done without a human retyping figures between documents — and that is the part worth automating, not the judgment.</p>
   <p>The four parts are each taken separately elsewhere in this library: <a href="/blog/the-three-valuation-approaches">the approaches and how they are weighted</a>, <a href="/blog/opm-pwerm-and-the-hybrid-method">the allocation methods</a>, and <a href="/blog/dlom-finnerty-chaffe-and-what-auditors-check">the marketability discount auditors test first</a>. <a href="/sample-report">The sample report</a> shows the whole argument assembled, section by section.</p>'
) ON CONFLICT (slug) DO NOTHING;
