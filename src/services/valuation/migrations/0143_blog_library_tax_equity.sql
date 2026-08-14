-- The article library, part 2 of 3: tax and equity compensation.
--
-- Part 1 (0142) covers what a valuation is and how it is built. This batch
-- covers what founders and employees do with the equity the valuation prices —
-- which is where the questions actually arrive from, and where the search
-- traffic is. Conventions and reasoning are as set out in 0142.
--
-- These pieces state rules, not advice, and several of them turn on thresholds
-- that Congress moves. Where a figure is indexed or was recently changed the
-- text says so rather than quoting it as permanent, because the failure mode
-- for a published article is not being wrong today — it is being wrong in
-- eighteen months and still reading as authoritative.

INSERT INTO blog_posts (id, slug, title, excerpt, category, keywords, author, published, published_at, body_html)
VALUES
(
  '01N409B1GPST0000000000000C',
  'iso-vs-nso-how-stock-options-are-taxed',
  'ISOs and NSOs: how each one is actually taxed',
  $x$The two option types diverge at exercise and again at sale. The $100,000 limit, the AMT trap, the 90-day window, and why most option grants end up as NSOs anyway.$x$,
  'Equity Compensation',
  'iso nso incentive stock option non qualified taxation amt disqualifying disposition 100k limit',
  'The N409 team',
  true,
  now() - interval '168 days',
  $x$<p>An option grant is a right to buy stock at a fixed price. What separates an incentive stock option from a non-qualified one is entirely a matter of tax treatment, and the difference lands at two moments: exercise and sale.</p>
<h2>At grant, nothing happens</h2>
<p>Neither type is taxed at grant, provided the strike price is at or above the fair market value of the common stock on the grant date. That condition is the entire reason a 409A valuation exists. An option struck below fair market value is discounted deferred compensation under Section 409A, and the penalty — ordinary income as it vests, plus an additional 20% federal tax, plus interest — falls on the holder.</p>
<h2>At exercise, they diverge</h2>
<p><strong>NSO.</strong> The spread between the strike price and the fair market value at exercise is ordinary compensation income. The company withholds on it and reports it on the W-2. This happens whether or not the shares can be sold, which is why exercising a large NSO position in a private company can produce a tax bill with no cash to pay it.</p>
<p><strong>ISO.</strong> No regular income tax at exercise. But the same spread is a preference item for the alternative minimum tax. A holder with a large spread can owe substantial AMT on shares they cannot sell — the classic trap, and the reason people exercise early when the spread is small, or exercise in tranches sized to stay under the AMT crossover.</p>
<h2>At sale</h2>
<p>For an NSO, the basis is the strike plus the income already recognised, and the gain from there is capital, long or short depending on the holding period from exercise.</p>
<p>For an ISO, everything depends on whether the sale is a <em>qualifying disposition</em>: the shares must be held more than two years from the grant date and more than one year from the exercise date. Meet both and the entire gain over the strike price is long-term capital gain. Miss either and it is a disqualifying disposition — the spread at exercise becomes ordinary income in the year of sale, and only the further appreciation is capital.</p>
<h2>The rules that turn ISOs into NSOs</h2>
<p>ISO status is conditional, and grants lose it more often than founders expect:</p>
<ul>
<li><strong>The $100,000 limit.</strong> Only $100,000 of options, measured by fair market value at grant, may become exercisable in any calendar year. The excess is treated as an NSO. A large grant with a one-year cliff frequently breaches this.</li>
<li><strong>The 90-day window.</strong> ISO treatment requires exercise within three months of leaving. Companies offering an extended post-termination exercise window — increasingly common, and good for employees — convert the option to an NSO after month three by operation of law.</li>
<li><strong>Employees only.</strong> Advisors, contractors and board members cannot hold ISOs at all.</li>
<li><strong>10% shareholders</strong> need a strike at 110% of fair market value and a five-year term.</li>
<li><strong>Ten-year term</strong> maximum, and the plan must have been shareholder-approved within twelve months of adoption.</li>
</ul>
<h2>The practical picture</h2>
<p>ISOs are better for the holder in the good case and are worth structuring for. But between the $100,000 limit, the employee-only rule, extended exercise windows and the AMT, a large share of outstanding startup options are NSOs in practice — including many that were granted as ISOs.</p>
<p>What both types share is the dependence on a current, defensible fair market value at every grant date. If your last valuation is eleven months old and you are about to grant, that is the thing to deal with first: see <a href="/blog/how-often-do-you-need-a-409a-valuation">how often you need a 409A</a>, or <a href="/pricing">what a refresh costs</a>.</p>$x$
),
(
  '01N409B1GPST0000000000000D',
  'the-83b-election-explained',
  'The 83(b) election: what it does and the deadline that kills it',
  $x$Thirty days, no extensions, no exceptions. What the election actually elects, when it is obviously right, when it is a gamble, and the situations where it does nothing at all.$x$,
  'Tax',
  '83b election restricted stock early exercise 30 day deadline founder vesting section 83',
  'The N409 team',
  true,
  now() - interval '161 days',
  $x$<p>Section 83 says that property transferred in connection with services is taxed when it stops being subject to a substantial risk of forfeiture — in plain terms, as it vests, at the value it has then. For founder stock bought at a fraction of a cent and vesting over four years while the company appreciates, that default is a disaster: each vesting tranche is ordinary income at the then-current value, on shares nobody can sell.</p>
<p>The 83(b) election opts out of the default. It elects to be taxed on the whole grant <em>now</em>, at today&rsquo;s value, and it starts the capital gains holding period at grant rather than at each vesting date.</p>
<h2>Why it is usually right for founder stock</h2>
<p>At incorporation, founder stock is typically issued at par — a value so small that the tax on the entire grant is a few dollars, or nothing at all if the purchase price equals fair market value. Electing costs almost nothing and converts every subsequent dollar of appreciation from ordinary income into capital gain, with the holding period running from day one.</p>
<p>Not electing is how a founder ends up with a large ordinary income bill in year three on stock they cannot sell, at a valuation someone else set.</p>
<h2>Where it applies</h2>
<p>The election applies to transfers of <em>property</em> subject to vesting:</p>
<ul>
<li>Founder stock and other restricted stock purchases</li>
<li>Early-exercised options, where the shares received are still subject to repurchase</li>
<li>Restricted stock awards generally</li>
</ul>
<p>It does <em>not</em> apply to plain option grants — an unexercised option is not property under Section 83 — and it does not apply to RSUs, which are a contractual promise rather than a transfer of shares. This is one of the most common misunderstandings: an employee who receives RSUs and files an 83(b) has filed nothing.</p>
<h2>The deadline</h2>
<p>Thirty days from the date of transfer. Not thirty business days, not from the board approval, not from when the certificate arrives. There is no extension procedure and no reasonable-cause relief. A late election is simply not an election.</p>
<p>File with the IRS service centre where you file your return, keep proof of mailing, and give a copy to the company. The requirement to attach a copy to your own return was removed for later years, but the company needs one for its records and you will want the proof.</p>
<h2>When it is a genuine gamble</h2>
<p>The election accelerates tax on value you may never realise. If you elect on stock worth $400,000, pay tax on it, and then the company fails, you do not get that tax back — the loss is a capital loss, deductible against capital gains and $3,000 of ordinary income a year. That asymmetry is the whole risk.</p>
<p>So: nearly always elect when the spread is trivial, which is the founder case and the early-exercise-immediately-after-grant case. Think carefully when the spread is large, which is what early-exercising a grant made three rounds ago looks like. The larger the spread, the more the election is a bet on the outcome rather than a piece of housekeeping.</p>
<h2>Where the valuation comes in</h2>
<p>The amount you are electing to be taxed on is the fair market value of the stock at transfer — which for a private company is the 409A conclusion. An election filed against a stale or unsupported value is an election against a number you may have to defend later. See <a href="/blog/what-an-irs-409a-audit-asks-for">what an examination asks for</a>, and <a href="/blog/section-1244-ordinary-loss-on-failed-startup-stock">Section 1244</a> for the provision that softens the downside case.</p>$x$
),
(
  '01N409B1GPST0000000000000E',
  'section-83i-qualified-equity-grant-deferral',
  'Section 83(i): the five-year deferral almost nobody uses',
  $x$A private-company employee can defer tax on an option exercise or RSU settlement for up to five years — if the company opts in for at least 80% of its US workforce in the same year. Why the take-up is so low.$x$,
  'Tax',
  'section 83i qualified equity grant deferral tcja private company 80 percent rule illiquid stock',
  'The N409 team',
  true,
  now() - interval '154 days',
  $x$<p>The problem Section 83(i) was written to solve is real and familiar: an employee exercises an NSO or settles RSUs in a private company, owes ordinary income tax on the spread, and has no way to sell shares to pay it. Enacted in the 2017 tax act, 83(i) lets a qualified employee elect to defer that income for up to five years, or until an earlier triggering event.</p>
<h2>What the election defers</h2>
<p>Federal income tax on the spread at exercise or settlement, for up to five years from the date the shares become substantially vested and transferable. It does not defer Social Security and Medicare taxes, which are due at the normal time, and it does not bind the states, several of which do not conform.</p>
<p>Deferral ends early — and the tax becomes due — if the stock becomes readily tradable on an established securities market, if the employee becomes an excluded individual, if they revoke the election, or at the five-year mark.</p>
<h2>The 80% requirement</h2>
<p>This is the provision that keeps 83(i) rare. To have any qualified stock at all, the corporation must, in the calendar year in question, grant stock options or RSUs to <strong>at least 80% of its US employees who provide services</strong>, with the same rights and privileges as to the number of shares. It is not a cumulative test across years: 80% must be granted <em>in the year</em>.</p>
<p>That is a real constraint on the many companies whose grant practice is by role, by seniority, or by negotiation at hire, and it means an eligible year has to be planned as one. A company that grants to 70% of its people in a year has no qualified stock for that year, no matter how it grants in any other.</p>
<h2>Who cannot elect</h2>
<p>Excluded individuals are the 1%-or-more owners at any time in the preceding ten calendar years, the current or any former chief executive or chief financial officer and their family members, and any of the four highest-compensated officers for any of the preceding ten years. These are the people most likely to have a large spread, which further narrows the benefit.</p>
<h2>The obligations that follow</h2>
<p>The company must notify employees that qualified stock is available and that the election may be made, must certify that the stock is qualified, and must ensure the deferred income is reported and withheld correctly at the end of the deferral. Employers who fail to give the required notice face a per-failure penalty. There is also a practical escrow requirement: the deferred shares must be held so that withholding can be satisfied at the end of the deferral period.</p>
<h2>The alternatives most companies pick instead</h2>
<p>In practice, companies address the same problem with an extended post-termination exercise window, with early exercise plus an <a href="/blog/the-83b-election-explained">83(b) election</a> while the spread is small, or by running a company-sponsored <a href="/blog/tender-offers-secondary-sales-and-your-409a">tender offer</a> that gives employees actual cash. Each of those has its own consequences, and none of them requires reorganising the grant policy around an 80% test.</p>
<p>83(i) remains worth knowing about, particularly for a company that already grants broadly and is several years from liquidity. The blocker is almost never the employee&rsquo;s appetite; it is the year-by-year 80% grant discipline.</p>$x$
),
(
  '01N409B1GPST0000000000000F',
  'qsbs-section-1202-what-founders-need-to-know',
  'QSBS under Section 1202: the exclusion, and what recently changed',
  $x$Up to 100% of the gain on qualified small business stock can be excluded from federal tax. The tests that have to hold from issuance onward, the 2025 changes, and why a contemporaneous attestation matters.$x$,
  'Tax',
  'qsbs section 1202 qualified small business stock exclusion gross assets holding period attestation',
  'The N409 team',
  true,
  now() - interval '147 days',
  $x$<p>Section 1202 is the most valuable provision in the startup tax code and the one most often discovered too late to do anything about. It excludes gain on the sale of qualified small business stock from federal income tax, subject to a per-issuer cap — and the conditions have to be satisfied at issuance and maintained, which means the work is done years before the exclusion is claimed.</p>
<h2>The core tests</h2>
<ul>
<li><strong>C corporation.</strong> The issuer must be a domestic C corp, at issuance and substantially throughout the holding period. An LLC that converts later does not retroactively qualify the earlier interests.</li>
<li><strong>Original issuance.</strong> The stock must be acquired from the company for money, property or services — not bought from another shareholder. Secondary purchases do not qualify.</li>
<li><strong>Gross assets test.</strong> The company&rsquo;s aggregate gross assets must not have exceeded the statutory ceiling at any time before, and immediately after, the issuance. Assets are measured at cash plus adjusted basis, so a large round can breach it.</li>
<li><strong>Active business.</strong> At least 80% of assets used in a qualified trade or business. Excluded are health, law, engineering, accounting, actuarial science, performing arts, athletics, financial services, brokerage, banking, insurance, farming, hospitality, and any business whose principal asset is the reputation or skill of its employees.</li>
<li><strong>Holding period.</strong> Historically five years for the full exclusion.</li>
</ul>
<h2>What changed in 2025</h2>
<p>The 2025 tax legislation made three changes for stock acquired after the date of enactment, leaving stock issued earlier under the old rules:</p>
<ul>
<li>A <strong>tiered holding period</strong>: a partial exclusion becomes available at three years and increases at four, reaching the full exclusion at five. Previously it was all-or-nothing at five years.</li>
<li>A higher <strong>gross assets ceiling</strong>, raised from the long-standing $50 million.</li>
<li>A higher <strong>per-issuer cap</strong> on excludable gain, above the previous $10 million floor, and indexed going forward.</li>
</ul>
<p>Because the changes apply by issuance date, a cap table can easily contain both regimes at once — which is a records problem as much as a tax one.</p>
<h2>Why the paperwork matters more than the rule</h2>
<p>The exclusion is claimed on a return filed years after the facts that support it. What an examiner asks for is evidence of the position <em>at issuance</em>: the entity&rsquo;s status, the gross assets figure at the relevant dates, the business activity, the stock purchase documents, and the acquisition date. Companies that reconstruct this from memory at exit routinely find the gross assets number is unprovable, or that a convertible instrument makes the issuance date ambiguous.</p>
<p>A contemporaneous attestation — prepared while the records exist, testing each element as at the issuance date — is what turns a plausible position into a documented one. It is also what an acquirer&rsquo;s diligence team will ask for, and what shareholders will ask the company for at exit.</p>
<p>N409 issues QSBS attestation letters standalone or bundled with a valuation, where the intake and cap-table work is already done. <a href="/products/qsbs-attestation">The product page</a> sets out what the letter covers, and <a href="/pricing">pricing</a> shows the bundled rate.</p>
<p>None of this is advice on your position. Section 1202 interacts with your entity history, your state, and the timing of every issuance, and the amounts are large enough to justify proper counsel.</p>$x$
),
(
  '01N409B1GPST0000000000000G',
  'section-1244-ordinary-loss-on-failed-startup-stock',
  'Section 1244: turning a failed startup into an ordinary loss',
  $x$Section 1202 rewards the win. Section 1244 handles the loss — converting up to $50,000, or $100,000 jointly, of capital loss into an ordinary deduction. The conditions have to be met at issuance.$x$,
  'Tax',
  'section 1244 ordinary loss small business stock failed startup capital loss deduction',
  'The N409 team',
  true,
  now() - interval '140 days',
  $x$<p>Most startup tax planning is written for the outcome that does not happen. Section 1244 is written for the one that usually does.</p>
<p>Without it, worthless stock produces a capital loss: offset against capital gains, and beyond that deductible against ordinary income at $3,000 a year. A founder or angel who put $80,000 into a company that failed is carrying that loss forward for decades. Section 1244 converts up to $50,000 of it — $100,000 on a joint return, per year — into an ordinary loss, deductible against salary in the year the loss occurs.</p>
<h2>What has to be true</h2>
<ul>
<li><strong>Domestic corporation</strong>, C or S.</li>
<li><strong>Original issuance to an individual or a partnership</strong>, for money or property. Not stock bought from another shareholder, and not stock received for services.</li>
<li><strong>The $1,000,000 capitalisation test.</strong> The aggregate amount received by the corporation for stock, as a contribution to capital and as paid-in surplus, must not have exceeded $1,000,000 at the time the stock was issued. This is the constraint that matters: a company that has raised more than that has issued its later stock outside 1244, though the earlier stock remains qualified.</li>
<li><strong>The operating income test.</strong> For the five years before the loss, more than half of the corporation&rsquo;s gross receipts must have come from operations rather than from passive sources such as royalties, rents, interest, dividends and securities gains. A company with little or no gross receipts is tested on whether it was primarily an operating business.</li>
<li><strong>The loss must be the original holder&rsquo;s.</strong> The character does not transfer with the stock — an inheritance, a gift, or a purchase from the original holder does not carry 1244 treatment.</li>
</ul>
<h2>How it interacts with 1202</h2>
<p>The two provisions are complements, not alternatives, and stock can qualify for both. Section 1202 excludes gain if the company succeeds; Section 1244 accelerates the deduction if it does not. Early-round stock in a company that stayed under $1,000,000 of capital for its first issuances frequently qualifies for each in its respective outcome.</p>
<h2>What to keep</h2>
<p>There is no election to file and no form to lodge at issuance, which is precisely why the position is so often lost. What is needed at the time of the loss is evidence of the facts as they stood at issuance: the stock purchase agreement, the consideration paid and its form, the corporation&rsquo;s capital account at that date, and the gross receipts history for the five-year window. Reconstructing a capital account from ten-year-old records, for a company that no longer exists and whose bookkeeper is long gone, is the usual failure.</p>
<p>Keep the issuance file per round, alongside the <a href="/blog/qsbs-section-1202-what-founders-need-to-know">QSBS</a> evidence, and keep it somewhere that is not the company&rsquo;s own systems — because in the case Section 1244 is for, those systems will be gone.</p>
<p>This is a description of the provision, not advice on your situation.</p>$x$
),
(
  '01N409B1GPST0000000000000H',
  'rule-701-and-equity-compensation-disclosure',
  'Rule 701: the exemption your option grants rely on',
  $x$Every option you grant is a securities offering. Rule 701 is why it does not need registering — and past a threshold it requires you to hand employees financial statements and risk factors.$x$,
  'Equity Compensation',
  'rule 701 securities exemption compensatory offering disclosure financial statements private company options',
  'The N409 team',
  true,
  now() - interval '133 days',
  $x$<p>Granting a stock option is an offer of a security. Absent an exemption it would require registration, which no private company is going to do. Rule 701 under the Securities Act is the exemption that makes employee equity possible for companies that are not SEC reporting companies, and most founders have never read it.</p>
<h2>What it covers</h2>
<p>Compensatory offerings under a written plan or agreement, to employees, directors, general partners, trustees, officers, consultants and advisors — with the consultant and advisor category restricted to natural persons providing bona fide services unconnected with capital-raising. Former employees qualify only for grants made while they were employed.</p>
<h2>The volume ceiling</h2>
<p>In any consecutive twelve months, the aggregate sales price or amount of securities sold in reliance on 701 may not exceed the greatest of:</p>
<ul>
<li>$1,000,000;</li>
<li>15% of the total assets of the issuer, measured at the most recent balance sheet date; or</li>
<li>15% of the outstanding amount of the class of securities being offered.</li>
</ul>
<p>For an option, the clock runs at grant and the amount is measured by the exercise price, not by the current value of the stock.</p>
<h2>The disclosure threshold</h2>
<p>This is the part that catches growing companies. Where the aggregate sales price or amount sold in a twelve-month period exceeds a specified threshold — raised from $5 million to $10 million by legislation in 2018, and indexed — the issuer must deliver additional disclosure to every person receiving securities in that period, a reasonable period before sale:</p>
<ul>
<li>A summary of the material terms of the plan</li>
<li>Risk factors associated with investment in the securities</li>
<li>Financial statements — a balance sheet and income statements — prepared under GAAP and no older than 180 days before the sale</li>
</ul>
<p>Companies discover this obligation at the point where their grants become large: the same growth that pushes you past the threshold is what makes the disclosure uncomfortable, because it means handing every option recipient your financials.</p>
<h2>What goes wrong</h2>
<p><strong>Grants outside a written plan.</strong> An offer letter promising options, with no plan document and no board approval, is not covered.</p>
<p><strong>Advisors who are not eligible.</strong> An entity advisor, or someone whose services relate to fundraising, falls outside the rule.</p>
<p><strong>Missing the threshold crossing</strong>, because nobody is tracking the twelve-month rolling total by exercise price.</p>
<p><strong>Assuming state law follows.</strong> Rule 701 is a federal exemption; blue sky requirements are separate, and California in particular has its own regime.</p>
<h2>Why it comes up in a valuation</h2>
<p>The disclosure obligation, the grant volumes, and the option plan documents are all part of the same file a valuation works from — and the twelve-month grant history is one of the things an appraiser needs anyway. Companies that keep a clean grant register for 701 purposes tend to have a much easier intake. See <a href="/blog/iso-vs-nso-how-stock-options-are-taxed">how the grants themselves are taxed</a>, and the <a href="/409a-valuation-guide">409A guide</a> for what a valuation asks for.</p>
<p>This is a summary of a securities rule, not legal advice. Anything near the threshold is a conversation with counsel.</p>$x$
),
(
  '01N409B1GPST0000000000000J',
  'down-rounds-underwater-options-and-repricing',
  'Down rounds, underwater options, and what repricing actually costs',
  $x$A lower valuation is not the problem — stale grants are. The exchange, the repricing, the tender offer rules that catch both, and the accounting charge nobody budgets for.$x$,
  'Equity Compensation',
  'down round underwater options repricing option exchange modification accounting asc 718 tender offer',
  'The N409 team',
  true,
  now() - interval '126 days',
  $x$<p>When a company raises at a lower price than its last round, two things follow for equity compensation: the 409A conclusion will usually fall, and every option granted at the old, higher strike is now above water only in a scenario nobody currently believes in.</p>
<h2>The valuation is not the problem</h2>
<p>Founders sometimes delay a refresh after a down round, reasoning that a lower number is bad news. It is the opposite. A lower fair market value means cheaper options for the people you are hiring to fix the situation, and it is exactly the moment you want a low strike price. Continuing to grant at a stale value hands new joiners options that are underwater on day one.</p>
<p>It is also the moment where <em>not</em> refreshing is hardest to defend. A material adverse event followed by grants at the pre-event price is the fact pattern that turns an audit question into an audit finding. A down round is unambiguously a material event; see <a href="/blog/how-often-do-you-need-a-409a-valuation">when a valuation expires</a>.</p>
<h2>The three ways to fix existing grants</h2>
<p><strong>Reprice in place.</strong> Amend the outstanding options to the new, lower strike. Simplest mechanically, most generous to holders, and the least popular with investors because it hands value back without anything given up.</p>
<p><strong>Option-for-option exchange.</strong> Cancel the old grants and issue new ones, usually fewer, often with a fresh vesting schedule. The ratio is the negotiation.</p>
<p><strong>Exchange for restricted stock or RSUs.</strong> Removes the strike price question entirely, at the cost of a different tax profile for the holder.</p>
<h2>The costs that surprise people</h2>
<p><strong>Modification accounting.</strong> Under ASC 718, a repricing is a modification. You compare the fair value of the award immediately before and immediately after, and the incremental fair value is additional compensation cost — recognised immediately for vested awards and over the remaining service period for unvested ones. This lands on the P&amp;L in a year when the P&amp;L is already the reason for the down round.</p>
<p><strong>Tender offer rules.</strong> An exchange offer made to a broad group of employees, where they must decide whether to participate, is generally a tender offer under the securities laws. That means a formal offer document, a minimum period the offer must stay open, and disclosure obligations — an SEC filing if the company is a reporting company, and a real legal process either way.</p>
<p><strong>ISO consequences.</strong> A repriced ISO is treated as a new grant for the $100,000 annual limit and restarts the holding periods. A repricing that pushes a holder over the limit converts the excess to NSOs.</p>
<p><strong>Sequencing.</strong> The new strike must be at or above the fair market value on the date of the modification, which means the fresh 409A has to be complete and board-approved before the repricing is effective — not alongside it.</p>
<h2>The order of operations</h2>
<p>Close the round. Commission the valuation with a date after the close. Get it board-approved. Decide the mechanism with counsel, because the tender offer question shapes the timeline more than anything else. Model the ASC 718 charge before you commit to a ratio, not after — the <a href="/products/asc-718-valuation">expense study</a> and the 409A are the same underlying analysis, and running them together is how you find out what the exchange costs before you announce it.</p>$x$
),
(
  '01N409B1GPST0000000000000K',
  'double-trigger-rsus-and-the-ipo-tax-bill',
  'Double-trigger RSUs and the tax bill that arrives at IPO',
  $x$Why private companies moved to double-trigger RSUs, what the liquidity condition does to the accounting, and why the settlement can produce a very large withholding event on a single day.$x$,
  'Equity Compensation',
  'double trigger rsu liquidity condition ipo settlement withholding sell to cover lockup asc 718',
  'The N409 team',
  true,
  now() - interval '119 days',
  $x$<p>A restricted stock unit is a promise to deliver shares. In a public company it usually vests on time alone and settles when it vests. In a private company, time-only vesting creates a serious problem: the units settle, the holder owes ordinary income tax on the full value of the shares, and there is no market to sell into. Employees end up owing tax on illiquid stock they did not choose to acquire.</p>
<h2>The second trigger</h2>
<p>The standard private-company answer is the double-trigger RSU. Two conditions must be met before settlement: a service condition, satisfied by time as usual, and a liquidity condition — an IPO, a change of control, or in some plans a company-sponsored tender offer. Units that satisfy the time condition sit vested-but-unsettled until the liquidity event occurs.</p>
<p>Plans typically include an outside expiry date, usually seven years, after which unsettled units lapse. That has caught companies that stayed private longer than the plan anticipated.</p>
<h2>What it does to the accounting</h2>
<p>Under ASC 718 a liquidity event of this kind is a performance condition, and compensation cost is recognised only when the condition is <em>probable</em>. An IPO is generally not considered probable until it has effectively happened. So no expense is recognised for years, and then, on the qualifying event, the company records a large catch-up charge for all the service already rendered, with the remainder recognised over the residual service period.</p>
<p>The charge is computed on the grant-date fair value of the units, which is why the 409A valuation at each grant date continues to matter even though nothing settles for years. See <a href="/products/asc-718-valuation">what an ASC 718 study covers</a>.</p>
<h2>The day the bill arrives</h2>
<p>At settlement, the full fair market value of the delivered shares is ordinary compensation income, subject to withholding. Two features make this uncomfortable:</p>
<ul>
<li><strong>It is concentrated.</strong> Years of vested units settle at once, at the price on the settlement date. For long-tenured employees at a company that has appreciated substantially, the single-day income can dwarf their salary and push withholding into the higher supplemental rate — which is frequently still short of the actual marginal rate, leaving a balance due at filing.</li>
<li><strong>The shares may be locked up.</strong> Settlement often occurs at or shortly after the IPO, while a lockup restricts sale. Companies handle this with a sell-to-cover at settlement, a net settlement in which shares are withheld, or by timing settlement to the first trading window — each choice with different cash and dilution consequences for the company.</li>
</ul>
<p>The subsequent movement in the share price is capital gain or loss against a basis equal to the settlement value. An employee whose shares fall 50% between settlement and the end of the lockup has income tax on the high number and a capital loss on the difference, which is limited in how fast it can be used.</p>
<h2>What to plan</h2>
<p>For the company: model the ASC 718 catch-up before the S-1, decide the withholding mechanism early because it drives cash or dilution, and check the outside expiry date on grants made years ago. For the holder: know the settlement mechanism, know whether the withholding rate applied will cover your actual rate, and know the lockup terms. None of this is a tax opinion — but all of it is knowable well before the day it lands.</p>$x$
),
(
  '01N409B1GPST0000000000000M',
  'profits-interests-and-the-llc-hurdle',
  'Profits interests: the LLC answer to stock options, and the hurdle that makes it work',
  $x$A profits interest is worth nothing on the day it is granted, by design. What the threshold amount is, why it needs a valuation, and the safe harbour the whole structure depends on.$x$,
  'Equity Compensation',
  'profits interest llc hurdle threshold amount rev proc 93-27 capital interest partnership equity',
  'The N409 team',
  true,
  now() - interval '112 days',
  $x$<p>An LLC taxed as a partnership cannot grant incentive stock options — those are a corporate creature. The equivalent instrument is the profits interest: a share of the entity&rsquo;s <em>future</em> profits and appreciation, with no claim on the value that exists at the date of grant.</p>
<h2>How the hurdle works</h2>
<p>A profits interest is defined by what it excludes. On the grant date, a threshold — the hurdle amount, or distribution threshold — is set equal to the amount that would be distributed to existing members if the entity sold all of its assets at fair value and liquidated that day. The holder participates only in distributions above that figure.</p>
<p>By construction the interest has a liquidation value of zero at grant. That is what makes it a profits interest rather than a capital interest, and a capital interest received for services is taxable compensation at grant on its full value.</p>
<h2>The safe harbour</h2>
<p>Revenue Procedure 93-27 provides that the receipt of a profits interest for services to or for the benefit of the partnership is generally not a taxable event, and Revenue Procedure 2001-43 extends the treatment to interests that are still subject to vesting, provided the partnership and the holder treat the holder as a partner from the grant date and the partnership takes no deduction.</p>
<p>The safe harbour does not apply where the interest relates to a substantially certain and predictable stream of income, where the holder disposes of it within two years, or where it is a limited partnership interest in a publicly traded partnership.</p>
<h2>Why it needs a valuation</h2>
<p>The whole structure rests on the hurdle being right. Set it below the entity&rsquo;s value at grant and the interest has value on day one — it is, in part, a capital interest, and the holder has taxable compensation income they did not expect. Set it too high and you have quietly given away less than you intended.</p>
<p>So the hurdle has to be derived from a fair value of the entity as at the grant date, on a liquidation basis, taking account of every preference and priority return in the operating agreement. For an entity with several classes of units and a preferred return, this is the same allocation exercise a corporate <a href="/blog/liquidation-preferences-and-the-allocation-waterfall">waterfall</a> requires, in different clothes.</p>
<h2>Valuing the interest itself</h2>
<p>Separately from the hurdle, the interest has to be valued for financial reporting — an award granted for services is within the scope of ASC 718 regardless of the entity&rsquo;s form. Because the interest pays only above a threshold, it is economically a call option struck at the hurdle, and it is normally valued with an option pricing model over the entity&rsquo;s equity value, using volatility from comparable companies and a term matched to the expected holding period.</p>
<h2>Practical notes</h2>
<ul>
<li>A holder becomes a <strong>partner</strong>, not an employee. That means a K-1 instead of a W-2, no employer withholding, self-employment tax considerations, and quarterly estimates — which surprises people who thought they were receiving something like options.</li>
<li>Allocated income is taxable whether or not it is distributed. Operating agreements often include tax distributions for exactly this reason.</li>
<li>Set the hurdle contemporaneously and document it. A hurdle reconstructed later is the first thing an examiner or an acquirer&rsquo;s diligence team will test.</li>
<li>Re-set hurdles on new grants. Each grant date has its own threshold, and reusing an old one gives away value.</li>
</ul>
<p>N409 values LLC and partnership equity including profits interests and the hurdle derivation — see <a href="/which-valuation">which report you need</a> if you are not sure whether this or a 409A is the right engagement.</p>$x$
),
(
  '01N409B1GPST0000000000000N',
  'tender-offers-secondary-sales-and-your-409a',
  'Tender offers, secondary sales, and what they do to your 409A',
  $x$A transaction in your own common stock is the most direct evidence of what it is worth — which is exactly why it has to be handled carefully. When a secondary sets the FMV, and when it does not.$x$,
  'Funds & Transactions',
  'tender offer secondary sale common stock 409a fair market value liquidity employee shares',
  'The N409 team',
  true,
  now() - interval '105 days',
  $x$<p>Employee liquidity before an exit is now normal at later-stage private companies: a company-sponsored tender offer alongside a round, an investor buying common from early employees, or individual sales through a broker. Every one of these is a transaction in the security a 409A is trying to value, and an appraiser cannot ignore it.</p>
<h2>Why it matters so much</h2>
<p>Most 409A evidence is indirect. Comparable companies are other companies; a backsolve calibrates to preferred stock and works back to common through a model. A secondary sale is the actual security, changing hands at an actual price. Where it is arm&rsquo;s length, that is the most direct evidence available, and a valuation that concludes materially below a recent, sizeable, arm&rsquo;s-length sale of the same stock has to explain itself.</p>
<h2>When a secondary should not simply set the price</h2>
<p>Not every transaction is evidence of fair market value, and the distinctions are the substance of the analysis:</p>
<ul>
<li><strong>Buyer motivation.</strong> A strategic investor buying common to establish a position, or an investor who could not get allocation in the priced round, may pay above what a financial buyer would. This is common and it is a real adjustment.</li>
<li><strong>Volume.</strong> A single employee selling a small parcel is weaker evidence than a broad tender in which a large fraction of the common changes hands.</li>
<li><strong>Access to information.</strong> An arm&rsquo;s-length price assumes both sides are informed. An employee selling without access to financials is not the same transaction as an institution buying after diligence.</li>
<li><strong>Duress.</strong> A forced or urgent sale is not evidence of fair market value.</li>
<li><strong>What was actually sold.</strong> Tenders sometimes purchase preferred, or common that converts, or common with rights attached. If what changed hands is not the plain common the option plan issues, the price is not directly comparable.</li>
<li><strong>Age.</strong> A transaction two quarters ago in a fast-moving business is context, not a conclusion.</li>
</ul>
<h2>The company-sponsored tender</h2>
<p>A tender offer the company organises is the strongest evidence of the set, because it is broad, priced by the company, and documented. It is also a securities transaction with real process obligations: the offer must remain open for a minimum period, the offer documents must disclose properly, and the company should assume it is a tender offer subject to those rules rather than hoping it is not.</p>
<p>Two practical consequences follow. First, the tender price will be tested against the 409A, in both directions — a tender well above the current FMV invites the question of whether the FMV was too low, and the company will need a fresh valuation for grants after it. Second, a tender is a material event: the grants you make afterwards cannot be priced off the valuation that preceded it.</p>
<h2>What to do</h2>
<p>Tell your appraiser about every secondary transaction you know of, including the ones you would rather not mention, with the price, volume, date, counterparties and how the buyer was informed. A transaction that surfaces during an audit and is not addressed in the report is far worse than one that is disclosed and reasoned about — including reasoned about and given little weight.</p>
<p>If a tender is planned, sequence it: valuation, board approval, tender, then a fresh valuation for subsequent grants. See <a href="/blog/how-often-do-you-need-a-409a-valuation">what counts as a material event</a> and <a href="/blog/what-an-irs-409a-audit-asks-for">what an examination asks for</a>.</p>$x$
)
ON CONFLICT (slug) DO NOTHING;
