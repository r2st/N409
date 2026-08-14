-- The article library, part 1 of 3: 409A fundamentals and methodology.
--
-- 0122 shipped the `blog_posts` table with a single post so `/blog` would not
-- be an empty state on the day it launched. One post is not a resources
-- section. A prospect comparing us against an incumbent opens /blog, sees one
-- article, and concludes — correctly — that nobody here writes. Every
-- competitor in this category runs a library of forty to fifty pieces, and
-- those pieces are also the long-tail search surface that brings founders in
-- before they know they need a valuation at all.
--
-- These are authored, not generated: each one answers a question we are
-- actually asked during intake, and each links into the product, guide or
-- calculator page that question leads to. Bodies are dollar-quoted rather than
-- apostrophe-escaped — the prose is full of possessives, and doubling every
-- one of them is how a migration acquires a typo nobody notices until it is
-- rendered on a public page.
--
-- `published_at` is staggered backwards rather than set to now(). A library
-- that appears in one instant, all fifty pieces sharing a timestamp, reads as
-- what it would be: a bulk load. Spacing them means the index sorts into
-- something a reader can move through, and it does not claim more recency than
-- the content has.
--
-- ON CONFLICT DO NOTHING throughout, so re-running against a database where
-- ops has already edited a post by hand does not overwrite their edit.

INSERT INTO blog_posts (id, slug, title, excerpt, category, keywords, author, published, published_at, body_html)
VALUES
(
  '01N409B1GPST00000000000002',
  'what-is-a-409a-valuation',
  'What a 409A valuation is, and what it is for',
  $x$An independent appraisal of your common stock, used to price options without handing your employees a tax problem. What it covers, who needs one, and what safe harbour actually buys you.$x$,
  '409A Basics',
  '409a valuation what is definition safe harbor common stock fmv strike price',
  'The N409 team',
  true,
  now() - interval '240 days',
  $x$<p>A 409A valuation is an independent appraisal of the fair market value of a private company&rsquo;s common stock. Its job is narrow and specific: to establish a defensible strike price for the stock options you grant, so that neither the company nor the people receiving those options end up on the wrong side of Section 409A of the Internal Revenue Code.</p>
<h2>Why the rule exists at all</h2>
<p>Section 409A governs deferred compensation. A stock option granted with a strike price below the fair market value of the underlying stock on the grant date is, in the eyes of the IRS, deferred compensation — and non-compliant deferred compensation at that. The consequences land on the employee, not the company: immediate income tax on the spread as it vests, an additional 20% federal penalty tax, and interest charges. An employee who has not sold anything, and may never be able to, receives a tax bill.</p>
<p>That asymmetry is the reason 409A valuations are taken seriously. The company issuing cheap stock creates the exposure; the employee holding it carries the cost.</p>
<h2>What safe harbour actually means</h2>
<p>The regulations do not require a valuation. They provide <em>safe harbours</em> — circumstances in which the IRS presumes your valuation is reasonable, and must prove it was <em>grossly unreasonable</em> to challenge it. That reversal of the burden of proof is the whole product.</p>
<p>The safe harbour nearly every venture-backed company uses is the independent appraisal presumption: a valuation performed by someone qualified, independent of the company, no more than twelve months before the grant, and not invalidated by a material event since. The other two — the illiquid start-up presumption and the binding formula method — are narrow, and most companies that think they qualify for the start-up presumption do not, because it requires the appraiser to have no relationship to the company and the company to have no expectation of a liquidity event within twelve months.</p>
<h2>Who needs one</h2>
<p>Any private company granting stock options or issuing common stock to employees, contractors or advisors. In practice that means: from the first option grant, which is usually the first employee hire, and continuing for as long as the option plan is live. There is no company too early. There is no company too small. The methods change with stage — an asset-based or backsolve approach early, an income or market approach later — but the requirement does not.</p>
<h2>How long it lasts</h2>
<p>Twelve months, or until a material event, whichever comes first. A material event is anything that would change what a buyer would pay: a priced financing round, a term sheet, an acquisition offer, a major customer win or loss, a pivot, a large secondary transaction in your own stock. A round closing is the most common one, and it invalidates the valuation the day it closes, not at the anniversary.</p>
<h2>What you actually receive</h2>
<p>A report, not a number. The number is its conclusion. A defensible report documents the inputs and where each came from, the approaches considered and the weight given to each, the allocation of total equity value across every share class above the common, the marketability discount and the model behind it, and the certification and limiting conditions an auditor reads first. If your report is six pages and the methodology section is a paragraph, you have bought a number and not a defence.</p>
<p>If you are working out which report you need — a 409A, an ASC 718 expense study, or something else entirely — the <a href="/which-valuation">30-second quiz</a> narrows it down, and the <a href="/409a-valuation-guide">409A guide</a> covers the process end to end.</p>$x$
),
(
  '01N409B1GPST00000000000003',
  'how-often-do-you-need-a-409a-valuation',
  'How often you need a 409A valuation',
  $x$Twelve months is the ceiling, not the schedule. What counts as a material event, why a closed round resets the clock immediately, and how to time a refresh around a grant cycle.$x$,
  '409A Basics',
  '409a valuation frequency how often twelve months material event refresh expiry',
  'The N409 team',
  true,
  now() - interval '232 days',
  $x$<p>The short answer is: at least every twelve months while you are granting options, and immediately after any material event. The longer answer is that the twelve-month figure is a ceiling on the safe harbour, not a recommended cadence, and companies that treat it as a calendar reminder are the ones that get caught out.</p>
<h2>The twelve-month clock</h2>
<p>The independent appraisal safe harbour applies to a valuation performed no more than twelve months before the grant date. On day 366, a grant priced off that report has no safe harbour. Not a weaker one — none. The valuation may still be perfectly reasonable, but you are back to proving it rather than the IRS having to disprove it.</p>
<p>Note what the clock runs on: the <em>valuation date</em>, not the delivery date. A report with a 31 December valuation date delivered on 15 February expires the following 31 December, not the following February. Companies that plan around delivery lose six weeks of coverage.</p>
<h2>Material events reset it early</h2>
<p>A material event is any development that would change what an informed buyer would pay for the company. The clearest one is a priced equity financing: the round closes, the valuation is stale that day, and every grant afterwards needs a fresh one. Others that come up constantly:</p>
<ul>
<li>A signed term sheet, in many cases, not just the close</li>
<li>An acquisition offer or an approach that gets as far as diligence</li>
<li>A secondary transaction in your own stock at a meaningful size</li>
<li>A change in the business itself — a pivot, a regulatory decision, the loss of a customer who was a large share of revenue</li>
<li>Missing your own plan badly enough that the forecast underlying the last report is no longer the plan</li>
<li>A convertible instrument converting, or a bridge round on materially different terms</li>
</ul>
<p>The judgment call is what counts as material. The honest test is whether you would be comfortable explaining to an auditor, two years later, why you kept granting at the old price after it happened.</p>
<h2>Timing it around your grant cycle</h2>
<p>Most companies grant options in batches — at a board meeting, at a quarterly cycle, at onboarding. The efficient arrangement is to hold the valuation date slightly ahead of the grant batch, so the report is delivered and board-approved before the grants are dated, rather than grants sitting unpriced while a report is in draft.</p>
<p>If a financing is close, wait for it. Commissioning a valuation four weeks before a round closes buys you four weeks of coverage and then a second engagement. If a financing has just closed, do not wait: the grants you are making to the people you are hiring with that money all need the post-round price.</p>
<h2>The down-round case</h2>
<p>Companies sometimes delay a refresh because they expect the number to fall. This is exactly backwards. A lower fair market value makes options <em>cheaper</em> for the people receiving them, which is the point of granting them. Continuing to grant at a stale, higher strike price hands new hires underwater options and does not protect anyone. And a valuation that is deliberately not refreshed after a material adverse event is the fact pattern that turns an audit question into an audit finding.</p>
<p>Our <a href="/pricing">pricing page</a> shows what a refresh costs, and the <a href="/tools/409a-valuation-calculator">calculator</a> gives a rough sense of where a refresh is likely to land before you commission one.</p>$x$
),
(
  '01N409B1GPST00000000000004',
  'why-your-409a-is-lower-than-your-post-money',
  'Why your 409A is lower than your post-money valuation',
  $x$Your round priced preferred stock. Your 409A prices common. The gap between them is liquidation preferences, control rights and marketability — and it is supposed to be there.$x$,
  '409A Basics',
  '409a lower than post money preferred common discount liquidation preference dlom',
  'The N409 team',
  true,
  now() - interval '225 days',
  $x$<p>You closed a round at a $40M post-money. Your 409A comes back at $0.94 a share, which multiplied out across your fully diluted shares is nothing like $40M. Founders read this as an error, or as the valuation firm being conservative to keep the IRS happy. It is neither. The two numbers measure different securities.</p>
<h2>Your round priced preferred stock</h2>
<p>An investor paying $2.50 a share in a Series A is buying <em>Series A Preferred</em>. That share carries rights your common stock does not have: a liquidation preference that pays out first, often a participation right on top of it, anti-dilution protection, a board seat or a right to appoint one, protective provisions over what the company can do without their consent, information rights, and registration rights.</p>
<p>The post-money valuation is simply the price per preferred share multiplied by the fully diluted share count. It is an arithmetic convention, not an appraisal — it prices every share as though it were the preferred share the investor bought. Your employees are not receiving that share.</p>
<h2>The preference stack comes off first</h2>
<p>In an exit, the preferred stack is paid before common sees anything. A company with $12M of raised capital and a 1x non-participating preference has to clear $12M before a single dollar reaches common. Below that threshold the common is worth zero, and the option pricing model that allocates value across share classes reflects exactly this: common stock is, formally, a call option on the company&rsquo;s equity value struck at the top of the preference stack.</p>
<p>That structure is why the gap widens as the stack deepens. Two companies with identical enterprise values but $5M and $45M of preferences behind them do not have the same common stock value, and no methodology that ignores the stack would tell you so.</p>
<h2>Then the marketability discount</h2>
<p>Even after allocation, the common stock an employee holds cannot be sold. There is no market, transfer is restricted by the company&rsquo;s own charter and stockholders&rsquo; agreement, there is usually a right of first refusal, and the holding period until any liquidity is measured in years and is uncertain. A discount for lack of marketability adjusts for that, typically in the range of 15% to 35% depending on volatility and expected time to liquidity, supported by an option-based model rather than a rule of thumb.</p>
<h2>What a normal gap looks like</h2>
<p>There is no correct ratio, and anyone quoting one is selling you a number rather than an appraisal. That said, a common stock value somewhere between a fifth and a half of the preferred price is unremarkable for an early venture-backed company, and the ratio tends to rise as a company matures, the preference stack becomes small relative to enterprise value, and a liquidity event moves closer. A late-stage company approaching an IPO may see common approach preferred closely — which is precisely why cheap-stock scrutiny intensifies in that window.</p>
<h2>Why the gap is good news</h2>
<p>A low common stock FMV means a low strike price, which means the options you grant have more value to the people receiving them and cost them less to exercise. The gap is not a problem to be minimised. It is the mechanism by which employee equity is worth having.</p>
<p>What matters is that the gap is <em>documented</em> — that the report shows the preference terms it modelled, the allocation it ran, and the discount it applied with its inputs. That is what an auditor tests, and it is covered in detail in <a href="/blog/liquidation-preferences-and-the-allocation-waterfall">how the allocation waterfall works</a>.</p>$x$
),
(
  '01N409B1GPST00000000000005',
  'what-an-irs-409a-audit-asks-for',
  'What an IRS examination of a 409A actually asks for',
  $x$The document request is predictable. Here is what gets asked for, which answers cause follow-up questions, and what to keep from every valuation so the file is complete years later.$x$,
  '409A Basics',
  'irs audit 409a examination document request idr audit defense safe harbor challenge',
  'The N409 team',
  true,
  now() - interval '218 days',
  $x$<p>Direct IRS examinations of 409A valuations are not common, and when the question arises it usually arrives through a different door: an employment tax examination, a review triggered by a large exercise, or — far more often — an audit of the company&rsquo;s financial statements where the auditor tests stock compensation under ASC 718 and works back to the valuation underneath it.</p>
<p>In every version, the request looks similar. Knowing its shape tells you what to keep.</p>
<h2>The standard document request</h2>
<ul>
<li>The valuation report itself, complete, including appendices and exhibits</li>
<li>The appraiser&rsquo;s qualifications, and evidence of independence from the company</li>
<li>The board resolutions approving the option grants, with dates</li>
<li>The option grant agreements and the stock ledger for the period</li>
<li>The capitalization table as at the valuation date, with the charter that governs the preference terms</li>
<li>The financial statements and the management forecast used in the report</li>
<li>Documentation of any financing round near the valuation date, including the purchase agreement</li>
<li>Any prior valuations, and the reason for the change between them</li>
</ul>
<h2>The questions that generate follow-up</h2>
<p><strong>A gap between the valuation date and the grant date.</strong> If a grant was dated 14 March and the valuation was as at 31 December, the examiner will ask what happened in between. Usually nothing did — but if a round closed in February, the safe harbour is gone for that grant regardless of the twelve-month window.</p>
<p><strong>A discount that is asserted rather than derived.</strong> &ldquo;A DLOM of 30% was applied&rdquo; invites the question of where 30% came from. A Finnerty or Chaffe calculation with its volatility, term and inputs shown does not.</p>
<p><strong>An enterprise value that is disconnected from a recent round.</strong> If you raised at a $60M post-money in April and the June valuation implies an equity value of $30M with no explanation, that is the first thing anyone reads. There may be a perfectly good reason — a bridge on punitive terms, a material adverse development, a round that was structured rather than priced — but it has to be in the report.</p>
<p><strong>Forecasts that were never met, used without comment.</strong> If the income approach leaned on a plan the company missed by 60% the year before, an examiner will ask whether the plan was reasonable at the time. A report that already addresses the company&rsquo;s forecasting history answers that before it is asked.</p>
<p><strong>An appraiser who is not independent.</strong> Your outsourced CFO, your accountant who also prepares the financials, or an investor is not an independent appraiser for safe harbour purposes, no matter how well qualified.</p>
<h2>What to keep, from every valuation</h2>
<p>Keep the full report with exhibits, not the summary. Keep the source documents you gave the appraiser, in the version you gave them — the cap table as at the valuation date, not as it stands now. Keep the board minutes approving both the valuation and the grants. Keep the correspondence where a judgment was discussed and settled. And keep it all together, per valuation, because the person assembling this file in three years will not be you.</p>
<p>Every N409 report ships with an evidence bundle that assembles exactly this set, and the first two hours of audit support are included. The <a href="/409a-valuation-guide">guide</a> covers what goes into the report in the first place.</p>$x$
),
(
  '01N409B1GPST00000000000006',
  '409a-valuations-explained-for-employees',
  'Your company got a 409A. What it means for your options',
  $x$Written for the person receiving the grant, not the person issuing it: what the strike price is, what the valuation does and does not say about what your equity is worth, and the tax moments that matter.$x$,
  '409A Basics',
  '409a for employees stock options strike price fmv spread amt exercise tax',
  'The N409 team',
  true,
  now() - interval '210 days',
  $x$<p>Most writing about 409A valuations is addressed to the company. This one is for the person holding the option grant.</p>
<h2>What the number is</h2>
<p>The 409A valuation sets the fair market value of your company&rsquo;s <em>common stock</em>. Your option&rsquo;s strike price — the price you pay per share when you exercise — is set at or above that figure on the day the grant is made. That is the entire legal purpose of the exercise. It is not a statement about what the company is worth to an acquirer, and it is not the price an investor paid.</p>
<h2>Why it is lower than the number in the press release</h2>
<p>Your company&rsquo;s last round priced <em>preferred</em> stock, which carries liquidation preferences, board rights and protections your common stock does not have. In an exit, the preferred stack is paid before common receives anything. On top of that, your shares cannot be sold — no market, transfer restrictions, and a right of first refusal — which reduces what they are worth today. A common stock FMV well below the headline valuation is normal and expected.</p>
<p>A low strike price is good for you. It is the difference between what you pay and what the share is eventually worth that has value, and a lower strike widens that gap.</p>
<h2>The moments where tax happens</h2>
<p><strong>At grant:</strong> nothing, for a normal option granted at fair market value. This is the reason the valuation exists.</p>
<p><strong>At exercise:</strong> it depends on the option type. For an <em>NSO</em>, the spread between the strike price and the then-current FMV is ordinary income, taxed and withheld at exercise, whether or not you can sell anything. For an <em>ISO</em>, there is no regular income tax at exercise, but the spread is an adjustment item for the alternative minimum tax, which catches a surprising number of people.</p>
<p><strong>At sale:</strong> the gain over your basis is capital gain. Whether it is long-term depends on holding periods — and for ISOs, whether the sale is a qualifying disposition depends on holding the shares more than two years from grant and more than one year from exercise.</p>
<p>A new 409A does not create a tax event for options you already hold. It sets the strike for grants made after it, and it is the FMV reference for exercises that happen while it is current.</p>
<h2>What to actually ask</h2>
<p>Reasonable questions to put to your company, none of which are impolite:</p>
<ul>
<li>How many shares are outstanding on a fully diluted basis? A grant of 10,000 shares means nothing without it.</li>
<li>What is the current strike price, and what was the most recent 409A FMV?</li>
<li>Are these ISOs or NSOs, and is there a post-termination exercise window longer than 90 days?</li>
<li>How much preferred stock sits above the common in the preference stack?</li>
<li>Has the company done a tender offer or allowed secondaries before?</li>
</ul>
<p>The last two matter most for understanding what your equity would actually pay in a realistic outcome — a topic covered in <a href="/blog/liquidation-preferences-and-the-allocation-waterfall">the allocation waterfall</a>.</p>
<p>None of this is tax advice for your situation. The rules interact with your income, your state, and the AMT in ways that are specific to you, and the amounts involved are usually large enough to justify an hour with an accountant before you exercise.</p>$x$
),
(
  '01N409B1GPST00000000000007',
  'opm-pwerm-and-the-hybrid-method',
  'OPM, PWERM and the hybrid method: choosing an allocation',
  $x$Three ways to split equity value across share classes, and the stage-based logic for choosing between them. Includes what a backsolve actually does and when it stops being credible.$x$,
  'Methodology',
  'opm pwerm hybrid allocation backsolve option pricing model probability weighted expected return',
  'The N409 team',
  true,
  now() - interval '203 days',
  $x$<p>Establishing the company&rsquo;s total equity value is half the work. The other half is allocating that value across share classes — and because the preferred sits above the common with preferences, participation and conversion rights, the allocation method changes the common stock conclusion substantially. Three methods are in general use.</p>
<h2>The option pricing model</h2>
<p>The OPM treats each share class as a call option on the company&rsquo;s total equity value. Value flows to a class only above the point where the classes senior to it have been satisfied. Those points are the <em>breakpoints</em>: the equity value at which the preference stack is covered, at which each participating class starts sharing, at which options come into the money, at which a preferred class would rationally convert to common.</p>
<p>Between each pair of breakpoints, a Black-Scholes calculation values the tranche, and the tranche is divided among the classes participating in it. The inputs are equity value, volatility drawn from a set of comparable public companies, a term equal to the expected time to a liquidity event, and the risk-free rate.</p>
<p>The OPM&rsquo;s strength is that it handles uncertainty without requiring anyone to name specific outcomes. Its weakness is that it assumes a lognormal distribution of future values, which is a poor description of a company facing a binary event — an approval, a lawsuit, an acquisition already in diligence.</p>
<h2>The backsolve</h2>
<p>A backsolve is not a fourth method; it is the OPM run in reverse. Instead of estimating equity value independently, you take the price an investor just paid for preferred stock in an arm&rsquo;s-length round, and solve for the total equity value that makes the OPM produce that price for that class. Everything else follows.</p>
<p>It is the most defensible approach available for a company that has recently raised, because it calibrates to an actual transaction in the company&rsquo;s own securities rather than to a judgment about comparables. It requires the round to have been genuinely arm&rsquo;s-length and recent. A round led by existing insiders, a bridge, a round with heavy structure, or a round nine months stale all weaken it, and a report that leans on a backsolve past that point should say why.</p>
<h2>PWERM</h2>
<p>The probability-weighted expected return method names the specific future outcomes — an IPO, an acquisition at a given multiple, a dissolution — assigns each a probability and a date, works out what each share class receives in each, discounts back, and weights.</p>
<p>PWERM is the right tool when the outcomes are genuinely discrete and foreseeable: a late-stage company with an IPO in view, a company in acquisition discussions, a business whose value turns on a single approval. It is a poor tool early, when naming five specific exits and their probabilities is a fabrication dressed as analysis. Auditors test PWERM scenarios hard, and the weakest point is always the probability weighting.</p>
<h2>The hybrid</h2>
<p>The hybrid method runs PWERM at the top level for the outcomes that are genuinely discrete, and uses an OPM within one or more of those branches to handle the outcomes that remain continuous. The common shape is an IPO scenario modelled explicitly and a &ldquo;stay private&rdquo; scenario allocated by OPM. It is now the standard approach for pre-IPO companies, and it is what the AICPA practice aid steers towards for exactly that fact pattern.</p>
<h2>Choosing</h2>
<p>Roughly: backsolve when there is a recent, clean, arm&rsquo;s-length round. OPM when there is not, and no specific exit is in view. Hybrid when an exit is in view but not certain. PWERM alone when outcomes are few, near, and describable.</p>
<p>What matters as much as the choice is that the report states the methods considered, the one selected, and why — including the ones given no weight. N409 runs OPM, backsolve, PWERM, hybrid and Monte Carlo allocations and shows the comparison, rather than presenting one method as though it were the only one available.</p>
<p>Whichever method is selected, it runs on top of the <a href="/blog/liquidation-preferences-and-the-allocation-waterfall">preference waterfall</a>, and its output is then adjusted by the <a href="/blog/dlom-finnerty-chaffe-and-what-auditors-check">marketability discount</a>. The <a href="/409a-valuation-guide">409A guide</a> puts the three steps in order.</p>$x$
),
(
  '01N409B1GPST00000000000008',
  'dlom-finnerty-chaffe-and-what-auditors-check',
  'DLOM: Finnerty, Chaffe, and what auditors actually check',
  $x$The marketability discount is the most contested number in the report. What the put-option models do, which inputs move them, and why a benchmark study on its own no longer survives review.$x$,
  'Methodology',
  'dlom discount lack of marketability finnerty chaffe put option restricted stock study',
  'The N409 team',
  true,
  now() - interval '196 days',
  $x$<p>The discount for lack of marketability adjusts the value of a share that cannot be sold. Your employees&rsquo; common stock has no market, is restricted by the charter and the stockholders&rsquo; agreement, is subject to a right of first refusal, and may not be liquid for years. A share you cannot sell is worth less than an otherwise identical share you can, and the DLOM quantifies that.</p>
<p>It is also the single most contested figure in any valuation report, because it applies directly to the conclusion and because for two decades it was frequently asserted rather than derived.</p>
<h2>The put-option framing</h2>
<p>The modern approach models the discount as the cost of the protection the holder does not have. If you owned a put option letting you sell at today&rsquo;s price at any point during your restriction period, you would be insulated from illiquidity. The value of that hypothetical put, as a percentage of the share value, is the discount.</p>
<p><strong>Chaffe (1993)</strong> values a European put struck at the current price over the restriction period, using Black-Scholes. It is simple and transparent, and it tends to produce higher discounts than the alternatives at the same volatility.</p>
<p><strong>Finnerty (2012)</strong> values an average-strike put — the holder cannot time their sale to the peak — which is a closer description of the actual disadvantage of illiquidity. Finnerty is the model most commonly relied on in venture valuations, and it is the one auditors are most used to seeing.</p>
<p><strong>Longstaff (1995)</strong> bounds the value of perfect market timing foregone. It produces large numbers and is normally used as an upper reference point rather than as the concluded figure.</p>
<h2>The inputs that move it</h2>
<p>Two inputs dominate. <strong>Volatility</strong>, drawn from comparable public companies over a period matched to the expected holding period, moves the discount roughly linearly over the relevant range. <strong>Term</strong> — the expected time until the shares become liquid — moves it too, and it is the input most often set by assertion. A two-year term and a five-year term produce very different discounts, and the difference between them has to be justified by something: the company&rsquo;s stage, its runway, its stated plans, the age of the fund holding the preferred.</p>
<h2>Why benchmark studies are no longer enough</h2>
<p>The restricted stock studies of the 1990s and the pre-IPO studies that followed still appear in reports, usually as corroboration. On their own they are hard to defend now: the samples are old, the transactions are heterogeneous, and the observed discounts conflate marketability with a great many other things — control, information asymmetry, transaction-specific bargaining. The AICPA practice aid, and every audit team following it, expects a quantitative model with disclosed inputs. Empirical studies are supporting evidence for reasonableness, not the derivation.</p>
<h2>What review actually tests</h2>
<ul>
<li>Is the model named, and are its inputs disclosed with enough detail to reproduce the calculation?</li>
<li>Is the volatility sourced from a comparable set that matches the one used elsewhere in the report — or has a different peer group quietly appeared?</li>
<li>Is the holding period consistent with the term assumption in the OPM? Reports that use two years in the allocation and four in the DLOM get asked about it.</li>
<li>Does the concluded discount move when the facts move? A company whose DLOM is 30% at seed and 30% two rounds later, with liquidity visibly closer, is asserting a number.</li>
<li>Are the transfer restrictions actually documented from the company&rsquo;s charter and agreements, rather than assumed?</li>
</ul>
<p>N409 computes Finnerty and Chaffe from the same volatility and term used in the allocation, shows both alongside the concluded figure, and carries the inputs into the report exhibits so the calculation can be traced rather than taken on faith.</p>
<p>The discount is the last step; the <a href="/blog/opm-pwerm-and-the-hybrid-method">allocation method</a> comes before it, and both appear in the <a href="/sample-report">sample report</a> with their inputs shown.</p>$x$
),
(
  '01N409B1GPST00000000000009',
  'the-three-valuation-approaches',
  'Income, market and asset: the three approaches, and when each one holds',
  $x$Every valuation report considers all three. What each actually measures, the stage at which each becomes credible, and why the weighting between them is the part auditors read.$x$,
  'Methodology',
  'income approach market approach asset approach dcf guideline public company valuation methods',
  'The N409 team',
  true,
  now() - interval '189 days',
  $x$<p>Valuation practice recognises three approaches to enterprise value. A complete report considers all three and explains the weight given to each — including the ones given none. Presenting a single approach without addressing the others is one of the more common weaknesses in a thin report.</p>
<h2>The income approach</h2>
<p>The income approach values a company as the present value of the cash it will generate. In practice this is a discounted cash flow: project free cash flow over a forecast horizon, apply a terminal value, and discount at a rate reflecting the risk of those cash flows.</p>
<p>The discount rate is where the work is. For an early-stage private company it is built up rather than taken from a textbook: a risk-free rate, an equity risk premium, a size premium, and a company-specific risk premium that accounts for concentration, key-person dependence, and the simple fact that most early-stage plans are not met. Weighted for capital structure, this becomes the WACC. Venture-stage build-ups routinely land between 25% and 50%, and the company-specific component is the piece that has to be reasoned rather than looked up.</p>
<p>The approach is credible when there is a forecast worth discounting: a business with revenue, a history of forecasting against which its plan can be assessed, and an economic model that does not depend entirely on events that have not happened yet. It is not credible for a pre-revenue company, and applying it there produces a number with the appearance of rigour and none of the substance.</p>
<h2>The market approach</h2>
<p>The market approach values the company against what the market pays for comparable businesses. Two variants:</p>
<p><strong>Guideline public company method.</strong> Select public companies genuinely comparable in business model, growth and margin profile, derive trading multiples — revenue, EBITDA, or a sector-specific measure — and apply them to the subject with adjustments for size, growth and risk. The selection of the comparable set is the whole argument, and an auditor will test whether the set was chosen because it is comparable or because it is flattering.</p>
<p><strong>Guideline transaction method.</strong> The same logic applied to observed M&amp;A transactions. Multiples in acquisitions include a control premium and reflect the conditions at the deal date, both of which need adjusting for.</p>
<p>There is a third variant specific to venture: the subject company&rsquo;s own recent financing round, which is the most directly comparable transaction available and is normally handled through a backsolve rather than as a multiple.</p>
<h2>The asset approach</h2>
<p>The asset approach values the company as the fair value of its assets less its liabilities. For an operating business this understates value, because it captures nothing of the going concern. It is the right approach in two situations: a pre-revenue company whose value genuinely is its cash and its tangible assets, and a company where liquidation is the realistic outcome and the going-concern premise no longer holds.</p>
<p>It is also a useful floor. A concluded enterprise value below net asset value should prompt a question about whether the going-concern premise is right.</p>
<h2>Weighting</h2>
<p>The weighting is a judgment, and it should be stated as one with its reasoning. Broadly: asset-heavy early, market and backsolve through the venture-funded middle, income increasingly as the business develops a forecastable model, and a blend of market and income at maturity. A seed-stage company weighted 100% to a DCF, or a company with $40M of revenue weighted entirely to an asset approach, are both signalling that the method was chosen for its answer.</p>
<p>N409 runs the approaches it has inputs for, shows the value each produces, and records the weighting as an explicit decision with its rationale rather than folding it silently into a single conclusion.</p>
<p>These three settle the company&rsquo;s total equity value. Splitting that value across share classes is a separate exercise, covered in <a href="/blog/opm-pwerm-and-the-hybrid-method">OPM, PWERM and the hybrid method</a>. If you are not sure which report you need in the first place, the <a href="/which-valuation">30-second quiz</a> narrows it down.</p>$x$
),
(
  '01N409B1GPST0000000000000A',
  'liquidation-preferences-and-the-allocation-waterfall',
  'Liquidation preferences and the allocation waterfall',
  $x$Where the money actually goes in an exit, term by term. Non-participating versus participating preferred, seniority, conversion, and why the waterfall is where valuations most often go quietly wrong.$x$,
  'Methodology',
  'liquidation preference waterfall participating preferred seniority conversion breakpoints exit proceeds',
  'The N409 team',
  true,
  now() - interval '182 days',
  $x$<p>Total equity value is not the answer a 409A is looking for. The answer is what the <em>common</em> is worth, and that depends on every term sitting above it. The waterfall is the model of how exit proceeds are distributed, and it is the part of a valuation most often wrong in ways nobody notices — because the errors live in the charter, not in the arithmetic.</p>
<h2>The basic mechanic</h2>
<p>On a liquidation, proceeds are distributed in order of seniority. Preferred holders take their liquidation preference first — typically 1x their original purchase price, sometimes more, occasionally with an accruing dividend. Whatever remains flows to common. Options and warrants participate once proceeds exceed their exercise prices.</p>
<p>The consequence: below the top of the preference stack, common receives nothing. This is why the option pricing model treats common as a call option struck at that threshold.</p>
<h2>Non-participating versus participating</h2>
<p><strong>Non-participating</strong> preferred faces a choice at exit: take the preference, or convert to common and take a pro-rata share. A rational holder takes whichever is larger. That choice creates a conversion breakpoint — the equity value above which converting beats taking the preference — and it is a real breakpoint the model must find, not an approximation.</p>
<p><strong>Participating</strong> preferred takes the preference <em>and then</em> shares in the remainder as though converted. This is much more expensive for common, and it shifts value substantially. Participation is often capped at a multiple of the original investment, which creates yet another breakpoint: above the cap, the holder is better off converting and the participation stops.</p>
<h2>Seniority between rounds</h2>
<p>Preferences are not always equal. Three structures appear:</p>
<ul>
<li><strong>Pari passu</strong> — every preferred class shares the first tranche pro rata to their preference amounts. The most common arrangement in straightforward venture rounds.</li>
<li><strong>Stacked (standard seniority)</strong> — the most recent round is paid in full before the round before it, and so on backwards. Common in later rounds and in any market where investors have leverage.</li>
<li><strong>Tiered</strong> — groups of rounds rank together and ahead of other groups.</li>
</ul>
<p>Modelling a stacked structure as pari passu will produce a common stock value that is too high, and in a downside scenario dramatically so. This is the single most consequential input that comes from the charter rather than the cap-table spreadsheet.</p>
<h2>The terms that get missed</h2>
<p><strong>Accruing dividends.</strong> An 8% cumulative dividend on a preference growing for four years increases the stack by more than a third. Cap-table exports frequently omit it.</p>
<p><strong>Multiple preferences.</strong> A 1.5x or 2x preference, common in structured or down rounds, and easy to miss when the round is described by its headline valuation.</p>
<p><strong>Anti-dilution adjustments</strong> that have already been triggered, changing the conversion ratio so a preferred share converts into more than one common share.</p>
<p><strong>Warrants</strong> issued to lenders or as part of a bridge, which are dilutive and sit in the waterfall at their own strike.</p>
<p><strong>SAFEs and notes that have not converted</strong>, which are not yet share classes but will be, and whose conversion terms determine what they become.</p>
<h2>Why it matters beyond the valuation</h2>
<p>The same waterfall answers the question founders and employees actually care about: at a given exit price, who gets what. A company with $80M of preferences and a $70M acquisition offer has a waterfall in which common receives nothing, and that is worth knowing before the offer arrives rather than after.</p>
<p>N409 builds the waterfall from the charter terms captured at intake — seniority, participation, caps, accruals, conversion ratios — and exposes it as its own exhibit, so the breakpoints in the allocation can be traced back to the document that created them.</p>
<p>The breakpoints this produces are the input to the <a href="/blog/opm-pwerm-and-the-hybrid-method">allocation model</a>, and the reason the resulting common stock value sits <a href="/blog/why-your-409a-is-lower-than-your-post-money">well below your post-money</a>.</p>$x$
),
(
  '01N409B1GPST0000000000000B',
  'how-safes-and-convertible-notes-affect-your-409a',
  'How SAFEs and convertible notes affect your 409A',
  $x$Unconverted instruments are not yet equity, but they are not nothing. How valuation caps, discounts and MFN terms get modelled, and why a SAFE cap is not a valuation.$x$,
  'Methodology',
  'safe convertible note 409a valuation cap discount pre money post money mfn conversion',
  'The N409 team',
  true,
  now() - interval '175 days',
  $x$<p>Most early-stage companies reach their first 409A having raised on SAFEs or convertible notes rather than priced equity. That creates a genuine modelling question: the instruments are not yet shares, so they are not in the cap table as a class, but they represent a claim on the company that will dilute common when it converts. Ignoring them overstates common stock value. Treating them as converted equity misstates the structure.</p>
<h2>A cap is not a valuation</h2>
<p>The most common misunderstanding: founders read a $12M post-money SAFE cap as a $12M valuation. It is not. A cap is a ceiling on the price at which the instrument converts — protection for the investor against a high priced round. It says the investor will not pay <em>more</em> than that price. It does not say the company is worth it, and investors regularly accept caps well above what they would pay in a priced round precisely because a cap costs them nothing if the company does not reach it.</p>
<p>A backsolve to a SAFE cap is therefore not the same exercise as a backsolve to a priced round, and a report that treats it as one is making a claim it cannot support. The cap is evidence — useful, especially when the round was competitive and recent — but it is one input, weighed alongside the approaches, not a transaction price.</p>
<h2>How the terms actually work</h2>
<p><strong>Pre-money versus post-money SAFEs.</strong> The 2018 post-money SAFE fixed the investor&rsquo;s ownership percentage at conversion; the earlier pre-money version did not, and its dilution depends on everything else that converts alongside it. A company with a stack of both has a genuinely complex conversion, and the order of operations matters.</p>
<p><strong>Discounts.</strong> A 20% discount converts at 80% of the priced round&rsquo;s price. Where an instrument has both a cap and a discount, it converts at whichever is more favourable to the holder.</p>
<p><strong>MFN clauses.</strong> A most-favoured-nation term entitles the holder to the best terms given to any later instrument. A stack of MFN SAFEs can ratchet so that all of them convert on the terms of the most investor-friendly one issued.</p>
<p><strong>Notes.</strong> Convertible notes add interest, which accrues and converts, and a maturity date that may fall before any qualifying round — creating a repayment obligation or a negotiated extension that is a real liability.</p>
<h2>How they are modelled</h2>
<p>Two treatments are defensible, and the choice should be stated.</p>
<p>The first treats each instrument as converting at its own terms in the scenarios being modelled, so the conversion price — and therefore the dilution — varies with the exit value. This is the more accurate treatment and the one that a scenario-based or hybrid allocation supports naturally.</p>
<p>The second converts the instruments at their caps into a synthetic share class before running the allocation. It is simpler and is defensible when a priced round is imminent and expected to be below the caps, but it fixes the dilution at a single assumption and should be disclosed as such.</p>
<p>What is not defensible is leaving them out because they are not in the cap table yet, or including them at face value as debt with no conversion feature.</p>
<h2>The practical consequence</h2>
<p>The more SAFE money outstanding, the more dilution sits ahead of the common — and the lower the common stock FMV, all else equal. Founders sometimes expect the opposite, reasoning that a high cap signals a high valuation. In a 409A the mechanism runs the other way: unconverted claims on future equity reduce what the current common is worth.</p>
<p>Capture every instrument at intake, with its cap, discount, MFN status, date and any accrued interest. A SAFE that surfaces after the report is drafted is a re-run, not an amendment — and it is the most common cause of one.</p>
<p>Once they convert, they become share classes in the <a href="/blog/liquidation-preferences-and-the-allocation-waterfall">preference waterfall</a> like any other. If you are raising on SAFEs now and wondering when the first valuation is due, <a href="/when-do-you-need-a-409a">when you need a 409A</a> covers the trigger.</p>$x$
)
ON CONFLICT (slug) DO NOTHING;
