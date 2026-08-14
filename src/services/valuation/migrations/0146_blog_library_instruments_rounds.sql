-- The article library, part 4: the instruments and the rounds.
--
-- 0142-0144 built the library out to thirty-one pieces covering what a 409A is,
-- how it is done, what founders do with the equity it prices, and the twelve
-- specialty deliverables. What none of them cover is the thing an intake call
-- actually opens with, which is never "what is fair market value" — it is "we
-- have four SAFEs, two of them post-money, a note that has not converted, and
-- the board wants to know what this does to the strike price".
--
-- Those questions are also where the long-tail search volume is. "post money
-- safe conversion", "pay to play recapitalization", "venture debt warrant
-- valuation" are typed by someone with a live transaction and a deadline, which
-- is a materially better visitor than one reading a definition.
--
-- Conventions as set out in 0142: dollar-quoted bodies, staggered publication
-- dates, ON CONFLICT DO NOTHING, and every piece linking into the product,
-- guide or article the question leads to.
--
-- One editorial rule these ten follow more strictly than the earlier batches:
-- where the answer depends on facts we cannot see from here — which SAFE
-- template, what the charter says, whether the board took the vote — the piece
-- says so rather than asserting the common case. These are the articles most
-- likely to be read as advice by someone mid-transaction.

INSERT INTO blog_posts (id, slug, title, excerpt, category, keywords, author, published, published_at, body_html)
VALUES
(
  '01N409B2GPST00000000000001',
  'post-money-and-pre-money-safes-the-conversion-arithmetic',
  $x$Post-money and pre-money SAFEs: the conversion arithmetic$x$,
  $x$The two templates dilute completely differently, and the difference is not visible on the instrument. How each converts, why a stack of pre-money SAFEs dilutes each other and post-money SAFEs do not, and what the appraiser needs to see.$x$,
  'Funds & Transactions',
  'post money safe pre money safe conversion dilution valuation cap y combinator stack',
  'The N409 team',
  true,
  now() - interval '34 days',
  $x$<p>A SAFE is a short document, and the shortest part of it — whether the valuation cap is a pre-money or a post-money number — is the part that decides how much of the company the holder ends up with. Founders who have signed both templates frequently do not know which they signed, because the instruments look nearly identical and the words &ldquo;post-money&rdquo; appear once.</p>
<h2>What each cap means</h2>
<p>Under the original 2013 SAFE, the cap is a <strong>pre-money</strong> figure. The holder converts at a price derived from the cap divided by the pre-money capitalisation, and that capitalisation does not include the other SAFEs converting at the same time. Under the 2018 post-money SAFE, the cap is a <strong>post-money</strong> figure that includes all the SAFEs and the option pool, and the holder converts into a fixed percentage of the company measured immediately after the SAFEs convert but before the new money.</p>
<p>The consequence is the whole point of the redesign: a post-money SAFE holder&rsquo;s percentage is knowable on the day they sign it, and is not diluted by any SAFE signed afterwards. A pre-money SAFE holder&rsquo;s percentage is not, and every subsequent SAFE reduces it.</p>
<h2>Why a stack behaves differently</h2>
<p>Take a company that raises on four SAFEs at the same cap and then prices a round. On the pre-money template the four holders share a pool of ownership that is computed once and split between them — adding a fifth SAFE shrinks each of the first four. On the post-money template each holder&rsquo;s percentage stands on its own, and adding a fifth SAFE dilutes the founders and only the founders.</p>
<p>That is not a criticism of either instrument. It is the reason a founder who raised on post-money SAFEs across three separate closings at three different caps is often surprised at the priced round: the percentages add, and nobody added them.</p>
<h2>What this does to the 409A</h2>
<p>Very little directly, and a great deal indirectly. An unconverted SAFE is not common stock and its holder is not a common shareholder, so the instrument does not itself set the fair market value of common. What it does is change the capital structure the allocation runs over — the conversion is modelled as part of the exit scenarios, with the cap, the discount and the conversion mechanics as the appraiser reads them from the document.</p>
<p>Which means the appraiser needs the actual instruments, not a summary line on the cap table. A cap table row that says &ldquo;SAFE — $500k — $8m cap&rdquo; does not say whether that cap is pre- or post-money, whether there is also a discount and which applies, whether there is an MFN clause that has already been triggered by a later instrument, or whether a pro-rata side letter exists. All four change the arithmetic. <a href="/blog/how-safes-and-convertible-notes-affect-your-409a">How SAFEs and convertible notes affect your 409A</a> covers the modelling side in more detail.</p>
<h2>Before you sign the next one</h2>
<p>Build the conversion table for the round you expect, with the SAFEs you have already signed in it, before you sign another. The arithmetic is not hard and it is never done, and the moment it is usually done for the first time is the week the priced round papers arrive, which is the week it is too late to change anything.</p>
<p>If you are raising now and want the strike price question answered alongside it, <a href="/409a-valuation/seed">the seed-stage page</a> sets out what a valuation at this stage involves, and <a href="/tools/409a-valuation-calculator">the calculator</a> gives an indicative range in a couple of minutes.</p>$x$
),
(
  '01N409B2GPST00000000000002',
  'caps-discounts-and-accrued-interest-how-a-note-converts',
  $x$Caps, discounts and accrued interest: how a convertible note actually converts$x$,
  $x$Two conversion terms that usually both apply, one that compounds quietly in the background, and the maturity date nobody diaries. What the documents say and what the cap table has to show.$x$,
  'Funds & Transactions',
  'convertible note conversion valuation cap discount accrued interest maturity qualified financing',
  'The N409 team',
  true,
  now() - interval '32 days',
  $x$<p>A convertible note is debt that is expected never to be repaid in cash. It carries a principal amount, an interest rate, a maturity date, and a set of terms describing what happens when the company raises a priced round. Most of the disputes it produces come from the interaction between those terms rather than from any one of them.</p>
<h2>The two conversion terms</h2>
<p>Almost every note carries both a <strong>valuation cap</strong> and a <strong>discount</strong>, and converts at whichever produces the lower price per share for the holder. The cap sets a ceiling on the valuation at which the note converts regardless of what the round prices at; the discount gives the holder a percentage off the round price. In a round that prices well below the cap, the discount governs. In a round that prices above it, the cap governs, and the gap between the two can be very large.</p>
<p>Where a note carries only one of the two, read carefully which. A note with a discount and no cap gives its holder no protection against a large step-up, which is usually not what the holder thought they were buying.</p>
<h2>Interest, which is real</h2>
<p>The interest accrues from the date of issue and converts along with the principal. At 5% over eighteen months that is an extra 7.5% of the principal converting into equity, and on a $2m note that is $150,000 of additional conversion nobody put in the model. It is small enough to be forgotten and large enough to change a cap table by a fraction of a percent per holder, which is the size of error that surfaces in diligence rather than before it.</p>
<p>Whether interest is simple or compounding, and on what day count, is in the note. It varies.</p>
<h2>The qualified financing threshold</h2>
<p>Conversion is normally automatic on a <strong>qualified financing</strong> — a priced equity round raising at least some stated minimum. Below that threshold, conversion is usually optional, or requires the consent of a majority of noteholders. A company that raises a small priced round to bridge to a larger one can find that its notes have not converted, which leaves debt sitting above the new investors in the waterfall.</p>
<h2>Maturity, and what happens if you reach it</h2>
<p>A note that reaches maturity without a qualified financing is a demand obligation. In practice the parties extend, but the negotiating position at that moment is not the one the founder had at issue, and repeated extensions are visible in diligence. Diary the maturity date the week the note is signed.</p>
<h2>What the valuation needs</h2>
<p>The executed notes, not the summary. The appraiser models conversion inside the exit scenarios, and doing that requires the cap, the discount, the interest rate and accrual convention, the qualified-financing threshold, and any most-favoured-nation clause that may have pulled better terms from a later instrument into an earlier one. <a href="/blog/liquidation-preferences-and-the-allocation-waterfall">The allocation waterfall</a> shows where the converted position lands relative to the preferred stock, and <a href="/blog/how-safes-and-convertible-notes-affect-your-409a">this piece</a> covers how unconverted instruments are handled.</p>$x$
),
(
  '01N409B2GPST00000000000003',
  'the-option-pool-shuffle',
  $x$The option pool shuffle, and what it actually costs the founders$x$,
  $x$Expanding the pool before the round rather than after moves several points of ownership without changing the headline valuation. How the arithmetic works, how to negotiate it, and why the pool size is a hiring plan and not a convention.$x$,
  'Cap Table & Governance',
  'option pool shuffle pre money post money dilution effective valuation term sheet negotiation hiring plan',
  'The N409 team',
  true,
  now() - interval '30 days',
  $x$<p>A term sheet says the round is at a $20m pre-money valuation and that the company will maintain a 15% unallocated option pool post-closing. Those two clauses are usually read separately. Read together they say something the headline number does not: the pool is being created out of the pre-money, which means the founders and existing shareholders pay for all of it.</p>
<h2>The arithmetic</h2>
<p>If the pool is established before the money goes in, the shares reserved for it dilute everyone who is already on the cap table and nobody who is arriving. On a $20m pre-money with a $5m round, a 15% post-closing pool created pre-money reduces the effective pre-money valuation to roughly $17m — the investors buy the same 20% of the company for the same $5m, and the existing holders absorb the pool on top of the round dilution.</p>
<p>Establish the same pool after closing and it dilutes everyone proportionally, investors included. Same pool, same headline valuation, several points of ownership in a different place.</p>
<h2>Why it is standard, and what to do about it</h2>
<p>It is standard because the investor&rsquo;s position is defensible: the pool exists to hire the team that will deliver the plan they are underwriting, and those hires happen after the round. The argument is not that the pool is unreasonable. The argument is about its <em>size</em>.</p>
<p>So negotiate the size, not the concept, and negotiate it with a hiring plan rather than a percentage. Name the roles you intend to fill before the next round, the level and the grant each would take, and total it. A pool sized from an actual plan is usually smaller than the round-number percentage in the first draft, and the conversation moves from a negotiation about fairness to a conversation about the plan — which is a conversation founders generally win, because they know the answer and the investor does not.</p>
<h2>What it does to the 409A</h2>
<p>Directly, less than founders expect. The unallocated pool is part of the fully diluted capitalisation the allocation runs over, so enlarging it spreads the equity value across more shares and pushes the per-share value of common down slightly. That is arithmetic, not a lever: the pool is sized for hiring, and sizing it to move a strike price is both ineffective at the margin and exactly the fact pattern an examiner reads as unreasonable.</p>
<p>Indirectly it matters more. A pool that is nearly exhausted is a signal the appraiser reads about hiring plans and the next round, and an option pool with more shares promised in offer letters than remain in the reserve is one of the cap table errors that stalls an engagement. <a href="/blog/why-your-409a-is-lower-than-your-post-money">Why your 409A is lower than your post-money</a> explains the larger gap this sits inside.</p>
<h2>The version that catches people twice</h2>
<p>A pool created pre-money at the Series A and then <em>topped up</em> pre-money at the Series B has been paid for twice by the same people. It is worth checking, at each round, what proportion of the existing pool is genuinely unallocated before agreeing to expand it — and <a href="/blog/rule-701-and-equity-compensation-disclosure">Rule 701</a> covers the disclosure obligations that arrive once the granting starts in volume.</p>$x$
),
(
  '01N409B2GPST00000000000004',
  'bridge-rounds-and-the-valuation-in-between',
  $x$Bridge rounds and the valuation in between$x$,
  $x$A bridge is not a priced round, so it does not reset the 409A on its own — but the circumstances that produced it usually are a material event. How to think about the valuation date, and what an inside round at last round terms actually evidences.$x$,
  'Funds & Transactions',
  'bridge round inside round extension safe note material event 409a valuation runway',
  'The N409 team',
  true,
  now() - interval '28 days',
  $x$<p>A bridge round — a note, a SAFE, or an equity extension on the last round&rsquo;s terms — raises money without setting a new price. Companies frequently assume this means the 409A is unaffected. Sometimes that is right. More often the bridge is a symptom of something that is squarely a material event, and the two questions get conflated.</p>
<h2>The instrument does not set a price, the facts do</h2>
<p>An unpriced instrument gives the appraiser no new transaction price to backsolve to. What it gives them is information: how much was raised, on what terms, from whom, and at what implied cap. A bridge from existing investors at a cap well below the last round&rsquo;s post-money is evidence about value even though it is not a price, and an appraiser who ignores it is ignoring the most recent arm&rsquo;s-length data point in the file.</p>
<h2>When a bridge is a material event</h2>
<p>Ask what changed rather than what was signed. A bridge raised because the round is oversubscribed and closing in six weeks is a scheduling artefact. A bridge raised because the round did not happen, the plan was missed, or the runway reached three months is a change in the company&rsquo;s prospects, and that is a material event whatever the instrument was called. So is a bridge that comes with a structural term the last round did not have — a senior liquidation preference, a ratchet, a board change.</p>
<p><a href="/blog/how-often-do-you-need-a-409a-valuation">How often you need a 409A</a> sets out the material-event test in general; the specific thing to avoid is granting options in the months after a difficult bridge on a valuation that predates it.</p>
<h2>The inside round at last round terms</h2>
<p>An extension of the previous round at the same price, taken up entirely by existing holders, is the case that most needs care. It looks like confirmation that the value has not moved. It is often the opposite: existing investors protecting a position have reasons to transact at a price a new investor would not accept, and that makes the price weak evidence of fair market value. The relevant question is whether a new outside investor participated on the same terms and in a meaningful amount.</p>
<p>An appraiser will ask exactly that, and a report that treats an insider extension as an arm&rsquo;s-length round without addressing it is one of the more common weaknesses <a href="/blog/what-an-irs-409a-audit-asks-for">an examination</a> finds.</p>
<h2>Practical sequencing</h2>
<p>If a bridge is closing and grants are pending, the cheaper order is almost always: close the bridge, then value, then grant. Granting first on a stale valuation to beat a price change is the fact pattern that produces the tax problem the whole regime exists to avoid — and if the bridge is a step down rather than a step up, <a href="/blog/down-rounds-underwater-options-and-repricing">the down-round piece</a> covers what happens to the options already outstanding.</p>$x$
),
(
  '01N409B2GPST00000000000005',
  'structured-rounds-and-the-price-behind-the-headline',
  $x$Structured rounds: the headline price and the real one$x$,
  $x$A 2x participating preference with a ratchet is not the same security as the last round&rsquo;s, and a flat headline price built on one is not a flat round. What structure does to the value of common, and what the appraiser has to do with it.$x$,
  'Methodology',
  'structured round participating preferred liquidation preference ratchet anti dilution flat round backsolve opm',
  'The N409 team',
  true,
  now() - interval '26 days',
  $x$<p>When capital gets more expensive, the price often does not move and the terms do. A round that prices at the last round&rsquo;s number but adds a 2x participating liquidation preference, a full ratchet, or a guaranteed return on exit is described internally as a flat round. In valuation terms it is not one, and the difference lands on the common stock.</p>
<h2>Structure is price</h2>
<p>The preferred share issued in a structured round is a different instrument from the one issued last time. It has a larger claim on the proceeds of every exit and a claim that stands ahead of the common in more scenarios. Paying the same nominal price for a materially better security means paying less, in the sense that matters, and the value that moved has to come from somewhere. It comes from the common.</p>
<p>This is why a backsolve to a structured round can produce a lower common-stock value than the previous unstructured round at the same headline price. That is not the model misbehaving. It is the model reporting what the terms did.</p>
<h2>What the appraiser reads</h2>
<p>The charter, not the term sheet summary. Specifically:</p>
<ul>
<li><strong>The preference multiple and whether it participates.</strong> A 1x non-participating preference caps the preferred&rsquo;s downside claim; a 2x participating one takes the multiple and then shares the residual.</li>
<li><strong>Seniority.</strong> Whether the new series stands ahead of earlier series or alongside them changes every scenario below the new money.</li>
<li><strong>Anti-dilution.</strong> Full ratchet and broad-based weighted average behave very differently in a subsequent down round, and the difference is in the conversion ratio the waterfall uses.</li>
<li><strong>Dividends.</strong> Cumulative dividends accrue and are paid ahead of common, which quietly raises the preference over time.</li>
<li><strong>Redemption and pay-to-play.</strong> Both change which scenarios are reachable.</li>
</ul>
<p><a href="/blog/liquidation-preferences-and-the-allocation-waterfall">The allocation waterfall</a> covers how these terms are turned into scenario payoffs, and <a href="/blog/opm-pwerm-and-the-hybrid-method">OPM, PWERM and the hybrid method</a> covers the models the payoffs feed.</p>
<h2>Why a summary line is not enough</h2>
<p>Cap-table platforms record a preference multiple and often nothing else. Participation, seniority, the anti-dilution formula and the dividend convention are in the amended and restated certificate of incorporation, and they are what a defensible allocation is built on. A valuation run from the summary is a valuation of a security the company did not issue.</p>
<h2>What to tell your team</h2>
<p>If the headline price held and the strike price fell, that is the structure being priced, and it is explicable in a sentence: the new investors bought a stronger claim, so the residual claim the options sit on is worth less. Saying that plainly is better than the alternative, which is a room full of people concluding the valuation is arbitrary. <a href="/blog/409a-valuations-explained-for-employees">The employee explainer</a> is written for exactly that conversation.</p>$x$
),
(
  '01N409B2GPST00000000000006',
  'founder-secondaries-and-what-they-do-to-your-409a',
  $x$Founder secondaries and what they do to your 409A$x$,
  $x$A founder selling common stock creates the one thing a 409A rarely has: an observed transaction in the exact security being valued. Whether it sets the value depends on facts the appraiser will ask about in detail.$x$,
  'Funds & Transactions',
  'founder secondary sale common stock 409a valuation arm length transaction price liquidity',
  'The N409 team',
  true,
  now() - interval '24 days',
  $x$<p>Secondary sales by founders — usually a small block sold to an incoming investor alongside a priced round — are now routine from Series B onwards. They also produce a data point most 409A analyses never see: an actual price paid, in cash, for common stock, by an unrelated buyer.</p>
<h2>Why it matters more than a preferred round</h2>
<p>The central difficulty in every 409A is that the observable transactions are in preferred stock and the security being valued is common. The whole apparatus of preference waterfalls and option-pricing allocation exists to bridge that gap. A secondary sale of common removes the bridge: the transaction is in the subject security, which is a stronger form of evidence than any allocation model applied to a preferred round price.</p>
<p>An appraiser who has a genuine arm&rsquo;s-length common sale near the valuation date and concludes at a materially different number has something specific to explain.</p>
<h2>When it does not govern</h2>
<p>&ldquo;Genuine arm&rsquo;s-length&rdquo; does most of the work in that sentence, and several common patterns fail it:</p>
<ul>
<li><strong>Size.</strong> A sale of a fraction of a percent is thin evidence of the value of the whole class.</li>
<li><strong>Motivation.</strong> A founder selling to a buyer who is also leading the round at a strategic price is transacting inside a larger negotiation, not in a market.</li>
<li><strong>Compulsion.</strong> A sale a founder needed to make on a timetable they did not choose is not a willing-seller transaction.</li>
<li><strong>Terms.</strong> If the shares carried rights the ordinary common does not — a transfer restriction waived, information rights, a board observer seat — the price is for a different security.</li>
</ul>
<p>The appraiser is required to weigh these rather than take the price at face value, and the report should show the weighing. <a href="/blog/tender-offers-secondary-sales-and-your-409a">Tender offers and secondary sales</a> covers the larger company-run programmes, where volume makes the evidence much harder to set aside.</p>
<h2>Sequencing, and the tax question that is not ours</h2>
<p>A secondary that closes at a price above the current 409A conclusion is a material event: value the company, then grant, in that order. The reverse order is how a company ends up with grants priced below a number it can be shown to have known about.</p>
<p>The tax treatment of the founder&rsquo;s own sale — holding period, whether the shares were <a href="/blog/qsbs-section-1202-what-founders-need-to-know">QSBS-eligible</a>, and what the sale does to that eligibility — is a separate question and one for the founder&rsquo;s own adviser. It is worth asking before the sale rather than after, because some of it cannot be undone.</p>
<h2>What to hand the appraiser</h2>
<p>The purchase agreement, the number of shares and the price, the identity and relationship of the buyer, the date, and any side letter. Not the rounded per-share figure from an email. <a href="/sample-report">The sample report</a> shows where a transaction like this appears in the analysis.</p>$x$
),
(
  '01N409B2GPST00000000000007',
  'pay-to-play-recapitalizations-and-the-common-stock',
  $x$Pay-to-play recapitalisations and what they do to the common$x$,
  $x$Non-participating preferred converts to common, preferences are washed out, and the cap table that comes out the other side is not the one the last valuation was built on. What changes, and why the effect on common is not always downward.$x$,
  'Funds & Transactions',
  'pay to play recapitalization pull up preferred conversion common stock washout down round cram down',
  'The N409 team',
  true,
  now() - interval '22 days',
  $x$<p>A pay-to-play is a financing in which existing preferred holders must participate pro rata in the new round or have their existing shares converted — usually into common, sometimes into a shadow series with reduced rights. It is a restructuring, and its effects on the common stock are larger and less intuitive than a down round&rsquo;s.</p>
<h2>What actually happens to the stack</h2>
<p>Three things, in order. The new money comes in, normally with a senior preference. Non-participating holders are converted, which removes their liquidation preference from the waterfall entirely. And participating holders are often &ldquo;pulled up&rdquo; into the new senior series for some multiple of their new investment, moving old money up the stack.</p>
<p>The net effect on the total preference overhang can go either way. A recapitalisation that converts $60m of stale preference to common and adds $15m of new senior preference has <em>reduced</em> the claim standing ahead of the common by a large margin, even though the round was punitive and the price was low.</p>
<h2>Why the common can go up</h2>
<p>This is the part that surprises boards. The value of the common in an allocation model is the residual after the preference stack is satisfied in each scenario. Wash out most of the stack and the residual is reachable in far more scenarios than before. Against that, the new round price is usually low and the total equity value has fallen. The two effects run in opposite directions, and which dominates is a fact about the particular structure rather than a rule.</p>
<p>So a pay-to-play is one of the few events where the honest answer to &ldquo;what does this do to our strike price?&rdquo; before the modelling is done is that nobody knows yet. <a href="/blog/opm-pwerm-and-the-hybrid-method">The allocation methods piece</a> explains why the residual moves the way it does.</p>
<h2>It is unambiguously a material event</h2>
<p>Charter amended, share classes changed, preferences extinguished, new money at a new price. No 409A that predates a recapitalisation survives it, and grants made afterwards on the old number have no safe harbour behind them.</p>
<h2>What the appraiser needs, and it is more than usual</h2>
<p>The restated charter, the recapitalisation agreement, the record of who participated and who did not, the resulting conversions actually reflected in the share register, and the terms of any pull-up. The cap table must be the post-recap one, reconciled to the charter. This is the transaction most likely to produce a cap table that disagrees with the constitutional documents, because several things changed at once and someone has to record all of them.</p>
<h2>The options already outstanding</h2>
<p>Existing grants are usually far underwater and the retention problem is immediate. <a href="/blog/down-rounds-underwater-options-and-repricing">Down rounds, underwater options and repricing</a> covers the exchange and repricing mechanics, including the accounting consequence of a modification under <a href="/blog/asc-718-stock-based-compensation-for-startups">ASC 718</a>. Do the new valuation first: a repricing set at a number that predates the recapitalisation reprices to the wrong price.</p>$x$
),
(
  '01N409B2GPST00000000000008',
  'venture-debt-warrants-and-how-they-are-valued',
  $x$Venture debt warrants and how they are valued$x$,
  $x$The warrant coverage on a facility is a real cost, measured at fair value, and it sits in three places at once — the lender&rsquo;s pricing, your accounting, and the fully diluted cap table your 409A runs over.$x$,
  'Financial Reporting',
  'venture debt warrant coverage valuation black scholes fair value asc 815 asc 718 fully diluted',
  'The N409 team',
  true,
  now() - interval '20 days',
  $x$<p>A venture debt facility is usually priced as an interest rate plus warrant coverage: the lender receives warrants over some percentage of the facility amount, struck at the price of the last round. Founders tend to treat the coverage as a rounding error next to the interest. It is normally the more expensive half.</p>
<h2>What coverage means</h2>
<p>&ldquo;10% warrant coverage&rdquo; on a $10m facility means warrants over $1m of stock at the stated strike. The number of shares follows from the strike price, so the same coverage percentage buys a different number of shares depending on which round&rsquo;s price it is struck at. The warrants are typically exercisable for seven to ten years and survive repayment of the loan, which is what makes them expensive: the lender keeps the upside long after the debt is gone.</p>
<h2>Valuing the warrant</h2>
<p>A warrant over private preferred stock is an option, and it is valued as one — normally Black-Scholes, with the same four inputs any option model needs and each of them harder to establish here than for an employee option:</p>
<ul>
<li><strong>Underlying price</strong> — the fair value of the class the warrant is over, which for preferred is not the 409A common conclusion.</li>
<li><strong>Term</strong> — for a warrant, usually the full contractual term rather than an expected-life shortcut, since the holder is not an employee and will not exercise early for liquidity.</li>
<li><strong>Volatility</strong> — from a guideline company set, over a period matched to that long term.</li>
<li><strong>Risk-free rate</strong> — matched to the same term.</li>
</ul>
<p>The long term is why the fair value is often 40&ndash;60% of the notional coverage rather than the small fraction people expect.</p>
<h2>Where the number is used</h2>
<p>In the accounting, the warrant is separated from the debt at issuance and the proceeds allocated, which creates a debt discount amortised to interest expense over the facility&rsquo;s life. Whether the warrant is equity- or liability-classified turns on its own terms — a settlement provision or an adjustment feature can push it into liability classification and require remeasurement every period. That determination should be made at issuance rather than at audit.</p>
<p>In the 409A, the warrants are part of the fully diluted capitalisation and appear in the allocation like any other option on the stack, at their own strike. In the effective cost of the facility, they belong alongside the interest rate — a comparison of two term sheets on rate alone is not a comparison.</p>
<h2>The practical failure</h2>
<p>Warrants are issued by the finance team under a facility agreement and frequently never reach the cap table of record, because the equity administrator was not in the loop. They surface at the next 409A, at diligence, or at the audit. Get them onto the cap table the day they are issued, with the strike, the class and the expiry. <a href="/blog/asc-718-stock-based-compensation-for-startups">The ASC 718 piece</a> covers the adjacent measurement work, and <a href="/products/asc-718-valuation">the ASC 718 product page</a> what a study delivers.</p>$x$
),
(
  '01N409B2GPST00000000000009',
  'ipo-readiness-the-valuation-work-that-starts-early',
  $x$IPO readiness: the valuation work that starts eighteen months out$x$,
  $x$Cheap stock is the finding that delays filings, and it is found by looking backwards at grants already made. What to fix while it is still cheap to fix, in the order the auditors will ask.$x$,
  'Financial Reporting',
  'ipo readiness cheap stock retrospective valuation sec comment letter audit s-1 equity grants',
  'The N409 team',
  true,
  now() - interval '18 days',
  $x$<p>The cheap-stock review that happens before an IPO does not examine the company&rsquo;s valuation policy going forward. It examines every equity grant made in roughly the two years before the filing, and asks whether the fair value used for each was supportable in hindsight, knowing what the offering price turned out to be. Everything that goes wrong there went wrong months earlier.</p>
<h2>What the review actually tests</h2>
<p>The auditors reconstruct a value trajectory from the earliest grant in the window to the IPO price, and look for grants priced below that trajectory. Where they find them, the company records additional stock compensation expense, restates if the amount is material, and explains the gap in the registration statement. The SEC then reads that explanation, and comment letters on it are a routine cause of delay.</p>
<p><a href="/blog/cheap-stock-and-the-pre-ipo-409a">Cheap stock and the pre-IPO 409A</a> covers the mechanics of that reconstruction. This piece is about the preceding eighteen months.</p>
<h2>Eighteen to twelve months out</h2>
<p>Move to quarterly valuations, if you have not. Annual valuations in a period of rapidly rising value guarantee a growing gap between the concluded value and the trajectory, and every grant in the back half of each year lands in it. Quarterly is what a company with a live IPO plan is expected to be doing, and the incremental cost is small against the restatement it avoids.</p>
<p>At the same time, reconcile the cap table to the charter and to the share register properly, once. Every subsequent piece of work depends on it.</p>
<h2>Twelve to six months out</h2>
<p>Tighten grant hygiene, because this is where most findings originate rather than in the valuation itself. Grant dates must be the date of board or committee approval, not the date someone got round to processing the paperwork; the approval must exist in writing before the grant is effective; and each grant must be priced off a valuation that was current on that date. A grant approved by written consent that circulated for three weeks has a date question with a clear answer, and it is worth answering it consistently rather than per grant.</p>
<p>Also stop making grants in the days immediately before a valuation refresh you know is coming. The pattern is visible and it invites the question.</p>
<h2>Six months out</h2>
<p>Expect the valuation methodology to shift as the offering becomes probable — the weight on a PWERM scenario with an IPO outcome rises, and the marketability discount falls towards zero as the expected holding period shortens. Both movements push the value up, which is correct and is precisely what creates the gap against grants made earlier. <a href="/blog/dlom-finnerty-chaffe-and-what-auditors-check">The DLOM piece</a> covers the discount side.</p>
<h2>What to have ready</h2>
<p>Every valuation report with its exhibits, board minutes approving each one, the grant register tying each grant to an approval date and a valuation, and the option plan with amendments. If a valuation was never formally adopted by the board, that is worth fixing now — <a href="/blog/what-a-409a-valuation-actually-defends">a report that was never adopted</a> is a document, not a policy. <a href="/products/asc-718-valuation">The ASC 718 study</a> is normally run alongside this work, from the same inputs.</p>$x$
),
(
  '01N409B2GPST00000000000010',
  'secondary-market-prices-and-what-a-409a-does-with-them',
  $x$Secondary market prices and what a 409A does with them$x$,
  $x$Broker platforms quote your stock, forwards trade at prices you never agreed, and none of it is automatically your fair market value. What an appraiser can use, what they must discount, and what they should ignore.$x$,
  'Methodology',
  'secondary market private stock broker platform forward contract spv price discovery 409a fair market value',
  'The N409 team',
  true,
  now() - interval '16 days',
  $x$<p>Once a private company is well known, prices for its stock start to exist whether or not it participates. Brokers match employee sellers with funds, SPVs assemble positions, and forward contracts trade on shares that have not been delivered. Founders discover these numbers, usually because a journalist or an employee found them first, and ask whether the 409A has to follow them.</p>
<h2>Three different things, often reported as one</h2>
<ul>
<li><strong>Completed transfers of common stock</strong> — a real sale, settled, with the company&rsquo;s consent and its right of first refusal waived. The strongest evidence in the category.</li>
<li><strong>Indications and quotes</strong> — a broker&rsquo;s bid or ask, or the last price at which someone said they would trade. Not a transaction. Wide spreads are normal and the ask is what gets reported.</li>
<li><strong>Forwards and SPV interests</strong> — a contract for future delivery of shares, or an interest in a vehicle that holds shares. The buyer is taking counterparty risk, structure risk and a fee layer, so the price is measuring something other than the share.</li>
</ul>
<p>Reporting rarely distinguishes them, and a headline &ldquo;trading at $X&rdquo; is very often the third category.</p>
<h2>What an appraiser does with each</h2>
<p>Completed common-stock transfers near the valuation date are considered directly, with weight depending on volume, whether buyers and sellers were unrelated, and whether the company facilitated the trade. A single small sale by a departing employee who needed the cash is not the market clearing; a sustained pattern of transfers at consistent prices is much closer to it.</p>
<p>Quotes and indications inform the range and do not set it. Forwards and SPV prices are adjusted for what they actually contain, or set aside with a reason given. Setting them aside without a reason is the weakness — the file should show the appraiser saw the number.</p>
<h2>Restricted transfer is the reason it is not automatic</h2>
<p>Nearly every private company&rsquo;s charter carries transfer restrictions and a right of first refusal, and most stock plans prohibit transfer of unexercised options outright. A price paid in a market the company can lawfully block is not the price of an unrestricted share, which is part of why <a href="/blog/dlom-finnerty-chaffe-and-what-auditors-check">a marketability discount</a> still applies even where a secondary market exists.</p>
<h2>The company&rsquo;s own choice</h2>
<p>Companies that dislike the price discovery have a better option than trying to suppress it: run a structured programme. A company-run tender at a stated price is transparent, controllable, and produces evidence the appraiser can weigh properly — and, being large and orderly, it is also evidence that is hard to discount away. <a href="/blog/tender-offers-secondary-sales-and-your-409a">Tender offers and secondary sales</a> covers how those are treated, and <a href="/blog/founder-secondaries-and-what-they-do-to-your-409a">founder secondaries</a> the smaller case.</p>
<h2>What to do when someone sends you a screenshot</h2>
<p>Send it to the appraiser. A number the company knew about and the report does not mention is a worse position than any number the report addresses and weighs. <a href="/contact">Ask us</a> if you are unsure whether something counts.</p>$x$
)
ON CONFLICT (slug) DO NOTHING;
