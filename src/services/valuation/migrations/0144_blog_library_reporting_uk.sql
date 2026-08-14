-- The article library, part 3 of 3: financial reporting, UK share schemes,
-- and the transaction work.
--
-- Parts 1 (0142) and 2 (0143) cover the 409A and what founders do with the
-- equity it prices. This batch covers the other twelve products on the pricing
-- page, which until now had product pages and no writing behind them — the
-- surface that ranks for "ifrs 2 vs asc 718" or "emi valuation hmrc" is an
-- article, not a product page, and those searches are made by exactly the
-- companies that then need the report.
--
-- The UK pieces quote thresholds that move with each Finance Act, and the ESOP
-- piece describes a regulatory position the Department of Labor has been
-- actively revising. Both say so in the text. Conventions as set out in 0142.

INSERT INTO blog_posts (id, slug, title, excerpt, category, keywords, author, published, published_at, body_html)
VALUES
(
  '01N409B1GPST0000000000000P',
  'asc-718-stock-based-compensation-for-startups',
  'ASC 718: what a stock compensation expense study actually involves',
  $x$Grant-date fair value, the requisite service period, and the four inputs auditors test first. Why the 409A number is a starting point and not the answer.$x$,
  'Financial Reporting',
  'asc 718 stock based compensation expense grant date fair value black scholes expected term volatility',
  'The N409 team',
  true,
  now() - interval '98 days',
  $x$<p>ASC 718 governs how share-based payments appear in financial statements. It is a different question from the one a 409A answers, and companies routinely conflate them: the 409A sets the strike price for tax purposes, while ASC 718 measures the compensation cost of the award and spreads it across the periods in which it is earned.</p>
<p>They share an input — the fair value of the underlying common stock — and diverge immediately afterwards.</p>
<h2>Grant-date fair value</h2>
<p>An equity-classified award is measured once, at grant, and that measurement is not revisited for changes in the share price. What is measured is the fair value of the <em>award</em>, not of the underlying share: an option struck at the current price has a fair value well below the share price, because it is an option.</p>
<p>For a plain option this is normally a Black-Scholes calculation with four inputs:</p>
<ul>
<li><strong>Underlying share price</strong> — the 409A conclusion at the grant date. Private companies may apply the practical expedient introduced by ASU 2021-07 to determine this using the same reasonable-application methodology used for tax purposes.</li>
<li><strong>Expected term</strong> — not the contractual ten years, but the expected time to exercise. Companies without exercise history commonly use the simplified midpoint of the vesting period and the contractual term.</li>
<li><strong>Volatility</strong> — from a set of guideline public companies, over a period matched to the expected term. The peer set has to be defensible and should be the same one used elsewhere in the analysis.</li>
<li><strong>Risk-free rate</strong> — the Treasury yield for the matching term.</li>
</ul>
<p>Awards with market conditions — a share-price hurdle, a TSR target — cannot be valued this way and need a lattice or Monte Carlo model.</p>
<h2>The requisite service period</h2>
<p>Cost is recognised over the period the employee has to work to earn the award. For a four-year graded vest with a one-year cliff, ASC 718 permits a policy choice for service-only awards: straight-line over the total period, or accelerated attribution treating each tranche separately. The choice is applied consistently, and it changes the shape of the expense materially in the early years.</p>
<p>Performance conditions are recognised only when the outcome is probable, which is why <a href="/blog/double-trigger-rsus-and-the-ipo-tax-bill">double-trigger RSUs</a> produce no expense for years and then a large catch-up.</p>
<h2>Forfeitures</h2>
<p>Since ASU 2016-09 an entity elects either to estimate forfeitures or to account for them as they occur. Accounting as they occur is simpler and is what most private companies choose; it is a policy election, applied consistently, and it should be stated.</p>
<h2>What auditors test</h2>
<p>In roughly this order: whether grant dates agree to board approvals; whether the underlying share price at each grant date agrees to a valuation that was current at that date; whether the volatility peer set is comparable and consistently applied; whether the expected term assumption has any support; and whether modifications — <a href="/blog/down-rounds-underwater-options-and-repricing">repricings and exchanges</a> — have been accounted for as modifications rather than treated as new grants.</p>
<p>The most common finding is not a modelling error. It is grants priced off a valuation that had already expired, which is a 409A problem that becomes an audit problem. <a href="/products/asc-718-valuation">The ASC 718 product page</a> sets out what a study delivers, and running it alongside the 409A is how the two stay consistent.</p>$x$
),
(
  '01N409B1GPST0000000000000Q',
  'ifrs-2-vs-asc-718',
  'IFRS 2 and ASC 718: the differences that change the numbers',
  $x$Both standards measure share-based payment at grant-date fair value and then diverge — on graded vesting, forfeitures, deferred tax and group arrangements. What a dual-reporting company has to run twice.$x$,
  'Financial Reporting',
  'ifrs 2 asc 718 difference share based payment graded vesting forfeiture deferred tax dual reporting',
  'The N409 team',
  true,
  now() - interval '91 days',
  $x$<p>IFRS 2 and ASC 718 start from the same principle: share-based payments are measured at the fair value of the award and recognised as an expense over the period in which the service is rendered. A company reporting under both — a UK or EU entity with a US parent, or a group filing IFRS consolidated statements over US GAAP subsidiary accounts — cannot simply restate one into the other. Four differences matter enough to change the reported figures.</p>
<h2>Graded vesting attribution</h2>
<p>The largest difference. Under IFRS 2, an award that vests in tranches must be treated as several separate awards, each with its own vesting period, and expense is attributed on an accelerated basis. ASC 718 permits a policy election for awards with service conditions only: accelerated attribution, or straight-line over the total vesting period.</p>
<p>A four-year award with annual vesting recognises a materially higher expense in year one under accelerated attribution than under straight-line. A company that elected straight-line under US GAAP has to recompute for IFRS, not merely reclassify.</p>
<h2>Forfeitures</h2>
<p>IFRS 2 requires an entity to estimate the number of awards expected to vest and to revise that estimate each period. ASC 718 allows the entity to elect to account for forfeitures as they occur instead. Where the US GAAP election is &ldquo;as they occur&rdquo;, the two sets of accounts diverge in every period in which anyone leaves.</p>
<h2>Deferred tax</h2>
<p>Under IFRS 2 the deferred tax asset is based on the estimated future tax deduction, which for most option regimes means the <em>intrinsic value</em> at each reporting date — so the asset moves with the share price. Any excess over the cumulative expense goes to equity. Under ASC 718 the deferred tax asset is based on the cumulative grant-date fair value expense recognised, and the difference on settlement runs through the income statement as a discrete tax item.</p>
<p>For a company whose share price has risen substantially, these produce very different tax lines and very different volatility in the effective tax rate.</p>
<h2>Expected term and the simplified method</h2>
<p>The simplified method for estimating expected term is US practice, originating in SEC staff guidance. IFRS 2 has no equivalent shortcut: the expected term must be estimated from the entity&rsquo;s own facts. In practice auditors accept a reasoned estimate, but it has to be reasoned rather than cited.</p>
<h2>Other differences worth knowing</h2>
<ul>
<li><strong>Group and parent-settled awards</strong> are dealt with explicitly in IFRS 2 for both the receiving entity and the settling entity; US GAAP handles the same fact pattern differently, and the subsidiary-level accounts are where this bites.</li>
<li><strong>Cash-settled awards</strong> are remeasured to fair value each period under both, but the classification boundary between equity- and liability-classified awards is not drawn identically.</li>
<li><strong>Modification accounting</strong> is similar in principle — incremental fair value — with differences in how a modification that reduces fair value is treated.</li>
</ul>
<p>None of these is exotic, but each requires the underlying model to be run again with different conventions rather than adjusted at the total. That is the practical case for having one provider produce both: the peer set, volatility and share price should be identical across the two, and the only differences in the output should be the ones the standards require. See <a href="/products/ifrs-2-valuation">the IFRS 2 product page</a> and <a href="/blog/asc-718-stock-based-compensation-for-startups">the ASC 718 walkthrough</a>.</p>$x$
),
(
  '01N409B1GPST0000000000000R',
  'asc-820-level-3-fair-value-for-fund-portfolios',
  'ASC 820 and Level 3: valuing a fund portfolio nobody trades',
  $x$Exit price, the fair value hierarchy, and calibration. Why the entry price stops being the answer after the first reporting date, and what an audit tests in a Level 3 position.$x$,
  'Financial Reporting',
  'asc 820 level 3 fair value fund portfolio nav calibration exit price venture capital private equity',
  'The N409 team',
  true,
  now() - interval '84 days',
  $x$<p>A venture or private equity fund reports its holdings at fair value. For anything not publicly traded, that means ASC 820, and it means Level 3 of the fair value hierarchy — inputs that are unobservable, and therefore inputs the fund has to justify.</p>
<h2>The definition doing the work</h2>
<p>Fair value under ASC 820 is an <em>exit price</em>: the amount that would be received to sell the asset in an orderly transaction between market participants at the measurement date. Three parts of that definition are load-bearing.</p>
<p><em>Exit</em>, not entry: what you paid is evidence, not the answer. <em>Market participant</em>, not you: your own strategic view of a holding does not enter into it. <em>At the measurement date</em>: the question is today, not at exit and not at the fund&rsquo;s expected outcome.</p>
<h2>The hierarchy</h2>
<p>Level 1 is a quoted price in an active market for an identical asset. Level 2 is other observable inputs — quoted prices for similar assets, or observable market data. Level 3 is unobservable inputs, which is where essentially every private holding sits.</p>
<p>Level 3 does not mean unsupported. It means the support is a model with disclosed inputs, and the disclosure requirements are correspondingly heavier: the valuation techniques, the significant unobservable inputs with ranges and weighted averages, a rollforward of Level 3 positions, and a description of the sensitivity of the measurement to changes in those inputs.</p>
<h2>Calibration</h2>
<p>This is the technique that distinguishes a defensible Level 3 process from a stale one. At the initial investment, the transaction price is presumed to be fair value. The model — a market multiple, a scenario allocation, a DCF — is calibrated so that it reproduces that price with the facts as at that date. At every subsequent measurement date, the same calibrated model is run with updated facts.</p>
<p>What calibration prevents is the two familiar failure modes: holding at cost until an event forces a change, and marking to a new model each period whose movements have as much to do with the model as with the company.</p>
<h2>What an audit actually tests</h2>
<ul>
<li><strong>Consistency of technique</strong> across periods, and disclosure when it changes.</li>
<li><strong>The unit of account.</strong> The fund holds a specific security — Series B preferred with its own preferences — not a share of enterprise value. Allocating equity value across the capital structure through a <a href="/blog/liquidation-preferences-and-the-allocation-waterfall">waterfall</a> is required, not optional.</li>
<li><strong>Whether a recent round has been reflected</strong>, and if not, why.</li>
<li><strong>Whether a written-down position was written down late.</strong> Positions that go from cost to zero in one period with no intervening movement are the classic finding.</li>
<li><strong>Backtesting</strong>: how prior marks compared with realised exits.</li>
</ul>
<h2>The practical problem</h2>
<p>A fund with forty holdings has forty of these, quarterly, each requiring current company information the fund does not control. This is why portfolio valuation is usually the operational bottleneck rather than the technical one — and why it is worth having the same process, peer sets and documentation applied across the portfolio rather than reconstructed per position.</p>
<p>See <a href="/products/asc-820-valuation">the ASC 820 product page</a> and <a href="/products/portfolio-valuation">portfolio valuation</a> for how a whole book is handled at once.</p>$x$
),
(
  '01N409B1GPST0000000000000S',
  'asc-805-purchase-price-allocation',
  'Purchase price allocation: what ASC 805 makes you identify',
  $x$Buy a company and you cannot book the price as goodwill. What has to be recognised separately, the three income methods used to value intangibles, and the private company alternatives.$x$,
  'Financial Reporting',
  'asc 805 purchase price allocation ppa intangible assets goodwill mpeem relief from royalty business combination',
  'The N409 team',
  true,
  now() - interval '77 days',
  $x$<p>When one company acquires another, ASC 805 requires the consideration to be allocated to the identifiable assets acquired and liabilities assumed, each measured at fair value, with the residual recognised as goodwill. The exercise is called a purchase price allocation, and it is normally the first piece of technical accounting work a company faces after closing an acquisition.</p>
<p>The reason it matters commercially rather than just technically: the intangibles you identify are amortised, and goodwill is not. How much of the price lands in each bucket determines the acquirer&rsquo;s reported earnings for years.</p>
<h2>What has to be identified separately</h2>
<p>An intangible asset is recognised apart from goodwill if it arises from contractual or legal rights, or if it is separable — capable of being sold or licensed independently. In practice the recurring categories are:</p>
<ul>
<li><strong>Developed technology</strong> — the software or product actually acquired</li>
<li><strong>Customer relationships</strong> and customer contracts, including backlog</li>
<li><strong>Trade names and trademarks</strong></li>
<li><strong>In-process research and development</strong>, recognised as an indefinite-lived asset until the project completes or is abandoned</li>
<li><strong>Non-competition agreements</strong> with the sellers</li>
</ul>
<p>An assembled workforce is explicitly <em>not</em> separable, and is subsumed into goodwill.</p>
<h2>The three methods</h2>
<p><strong>Multi-period excess earnings.</strong> Isolates the cash flows attributable to one asset by deducting contributory asset charges — a rent for every other asset that helps generate those flows. Standard for customer relationships, and sometimes for developed technology when it is the primary asset.</p>
<p><strong>Relief from royalty.</strong> Values an asset at the present value of the royalties the acquirer no longer has to pay because it owns the asset. Standard for trade names and frequently used for technology, and it depends entirely on a defensible royalty rate drawn from comparable licensing arrangements.</p>
<p><strong>With and without.</strong> Values an asset as the difference between two forecasts — one in which the acquirer has it, one in which it does not. Standard for non-competition agreements, where the &ldquo;without&rdquo; case is the seller competing.</p>
<p>Cross-checks tie the whole exercise together: the weighted average return on assets should reconcile to the WACC and to the internal rate of return implied by the transaction price. Where those three diverge materially, something in the allocation or the forecast is wrong.</p>
<h2>Contingent consideration</h2>
<p>An earnout is measured at fair value at the acquisition date and, if it is a liability, remeasured each period through earnings. Founders who negotiated an earnout are frequently surprised that its accounting volatility lands on the acquirer&rsquo;s income statement.</p>
<h2>The private company alternatives</h2>
<p>The Private Company Council alternatives let an eligible private company subsume certain customer-related intangibles that are not separable, and all non-competition agreements, into goodwill — reducing the number of assets to value. Electing this generally requires also electing to amortise goodwill. Public companies, and private companies expecting to go public or to be acquired by a public company, usually do not elect it, because the numbers have to be unwound later.</p>
<h2>Timing</h2>
<p>The measurement period allows up to one year from the acquisition date to finalise provisional amounts, but the first reporting date after closing usually needs a substantially complete allocation. Starting the work at the audit is how a deal closes in March and the numbers are still moving in November.</p>
<p>See <a href="/products/purchase-price-allocation">the PPA product page</a>, and <a href="/blog/goodwill-impairment-for-private-companies">goodwill impairment</a> for what happens to the residual afterwards.</p>$x$
),
(
  '01N409B1GPST0000000000000T',
  'goodwill-impairment-for-private-companies',
  'Goodwill impairment: the private company alternative, and the triggering event test',
  $x$Amortise it over ten years and test only on a triggering event, or test annually like a public company. What each choice costs, and what counts as a trigger.$x$,
  'Financial Reporting',
  'goodwill impairment asc 350 private company alternative amortisation triggering event reporting unit',
  'The N409 team',
  true,
  now() - interval '70 days',
  $x$<p>Goodwill is the residual from an acquisition: the part of the price that is not attributable to any identifiable asset. Under the general model in ASC 350 it is not amortised, and it is instead tested for impairment at least annually and whenever events indicate the carrying amount may not be recoverable.</p>
<h2>The general model</h2>
<p>Testing is performed at the reporting unit level — an operating segment or one level below. The entity may first perform a qualitative assessment, and if it is more likely than not that fair value is below carrying amount, it performs the quantitative test: compare the reporting unit&rsquo;s fair value to its carrying amount, and recognise an impairment for the excess, limited to the goodwill allocated to that unit.</p>
<p>The second step of the old test, which required a hypothetical purchase price allocation, was eliminated by ASU 2017-04. The remaining single-step test is considerably less work but still requires a defensible fair value for the reporting unit — typically an income approach, a market approach, or both, reconciled to market capitalisation where one exists.</p>
<h2>The private company alternative</h2>
<p>An eligible private company may elect to amortise goodwill on a straight-line basis over ten years, or less if a shorter useful life is more appropriate, and to test for impairment only when a triggering event occurs. It may also elect to test at the entity level rather than by reporting unit.</p>
<p>The trade-off is straightforward. Amortisation puts a predictable charge through earnings every year, which private company lenders and shareholders usually find easier to live with than a nil charge punctuated by an occasional large write-down. It also removes the annual valuation exercise entirely, which is a real cost saving.</p>
<p>The reason not to elect it is future-facing: a company heading for an IPO or for acquisition by a public filer will have to unwind the alternative and present under the general model, and reconstructing several years of annual tests retrospectively is worse than having done them. The alternative usually travels with the <a href="/blog/asc-805-purchase-price-allocation">PPA alternative</a> on customer-related intangibles, and the same reasoning applies to both.</p>
<h2>What counts as a triggering event</h2>
<p>Companies electing the trigger-only approach still have to know what a trigger is. The recurring ones:</p>
<ul>
<li>A sustained decline in the entity&rsquo;s own share price or in the value implied by a recent financing</li>
<li>Deterioration in the industry or the broader economic environment</li>
<li>Increased costs or a change in the cost structure that affects earnings</li>
<li>Actual and projected financial performance below expectations — the most common one, and the one that gets rationalised away</li>
<li>Loss of key personnel, a key customer, or a key contract</li>
<li>An expectation of selling or disposing of a reporting unit</li>
<li>Litigation or regulatory action</li>
</ul>
<p>There is a further alternative permitting private companies that do not report on an interim basis to assess triggering events only as of the annual reporting date, which removes the awkward question of what to do about a trigger that arose and resolved mid-year.</p>
<h2>The practical point</h2>
<p>Goodwill impairment work is not hard; it is late. The test needs a fair value of the reporting unit, which needs a forecast and a discount rate, which need to exist before the audit rather than during it. If your last acquisition produced material goodwill and your performance is behind plan, the trigger has already happened. See <a href="/products/impairment-testing">the impairment testing product page</a>.</p>$x$
),
(
  '01N409B1GPST0000000000000V',
  'emi-share-options-uk-hmrc-valuation',
  'EMI share options: qualifying, and agreeing the valuation with HMRC',
  $x$The most tax-advantaged share scheme in the UK, and the one with the most conditions. The company and employee limits, AMV versus UMV, and the advance agreement that makes the whole thing safe.$x$,
  'UK & International',
  'emi share options hmrc valuation val231 amv umv qualifying conditions enterprise management incentive',
  'The N409 team',
  true,
  now() - interval '63 days',
  $x$<p>Enterprise Management Incentives are the UK&rsquo;s tax-advantaged option scheme for smaller, higher-risk companies, and for a company that qualifies there is nothing better. Granted at market value, there is no income tax or National Insurance on exercise, and the gain is taxed as a capital gain on disposal — potentially at the reduced rate available under Business Asset Disposal Relief, where the two-year holding period runs from the date of grant rather than exercise.</p>
<p>The relief rate has been changing under recently announced measures, so check the rate applying to your disposal date rather than the one quoted in older guidance.</p>
<h2>What the company has to satisfy</h2>
<ul>
<li><strong>Gross assets</strong> of no more than £30 million, tested across the group.</li>
<li><strong>Fewer than 250 full-time equivalent employees</strong> at the date of grant.</li>
<li><strong>A qualifying trade.</strong> The excluded activities list is long and catches more companies than founders expect — banking, insurance, leasing, legal and accountancy services, property development, farming, hotels and nursing homes among them.</li>
<li><strong>Independence.</strong> The company must not be a 51% subsidiary of, or otherwise controlled by, another company.</li>
<li><strong>A UK permanent establishment.</strong></li>
</ul>
<p>Limits also apply to the scheme: no more than £3 million of unexercised options measured by market value at grant across the company, and no more than £250,000 per individual, measured on unrestricted market value, with a three-year exclusion period after that limit is reached.</p>
<h2>What the employee has to satisfy</h2>
<p>At least 25 hours a week, or 75% of their working time, committed to the company or group. No material interest — broadly more than 30% of the ordinary share capital. Options must be capable of exercise within ten years of grant, and must be granted under a written agreement stating the terms and any restrictions on the shares.</p>
<h2>AMV and UMV</h2>
<p>EMI valuations produce two figures, and the distinction is the part that gets missed.</p>
<p><strong>Unrestricted market value</strong> is the value of the shares ignoring any restrictions attaching to them. It is the figure used to test the £250,000 individual limit.</p>
<p><strong>Actual market value</strong> takes the restrictions into account — the transfer restrictions, drag and tag provisions, compulsory transfer terms and pre-emption rights in the articles. AMV is lower, and it is the figure the exercise price is normally set at, so that the option is granted at market value and the favourable treatment applies.</p>
<p>Getting the restriction analysis right requires reading the articles and any shareholders&rsquo; agreement, not just the cap table.</p>
<h2>The advance agreement</h2>
<p>HMRC will agree both figures in advance, on form VAL231, before grant. An agreed valuation is normally valid for a limited window — 90 days is the standard period, subject to nothing material changing — and grants made inside that window are made against a value HMRC has already accepted.</p>
<p>This is the single most valuable step in the process, and it is optional in the sense that nothing forces you to do it. Companies that skip it are relying on a valuation nobody has confirmed, for a scheme whose benefits depend on that valuation being right.</p>
<h2>After grant</h2>
<p>The grant must be notified to HMRC within the statutory window, through the employment-related securities service. A missed notification can cost the tax advantages of the grant, and it is a purely administrative failure — the most avoidable way to lose an EMI benefit.</p>
<p>See <a href="/products/emi-valuation">the EMI valuation product page</a>, and <a href="/blog/csop-share-options-uk-hmrc-valuation">CSOP</a> for the scheme that applies when the company does not qualify for EMI.</p>$x$
),
(
  '01N409B1GPST0000000000000W',
  'csop-share-options-uk-hmrc-valuation',
  'CSOP: the tax-advantaged scheme for companies too large for EMI',
  $x$No gross assets limit, no employee count limit, a higher individual cap since 2023, and relaxed share class rules. What a Company Share Option Plan requires, and how the valuation is agreed.$x$,
  'UK & International',
  'csop company share option plan hmrc valuation val232 60000 limit three year holding uk share scheme',
  'The N409 team',
  true,
  now() - interval '56 days',
  $x$<p>A Company Share Option Plan is the UK&rsquo;s other main tax-advantaged discretionary share option scheme. It is less generous than <a href="/blog/emi-share-options-uk-hmrc-valuation">EMI</a>, and it is where companies go when they no longer qualify for EMI — because they have passed the £30 million gross assets test, passed 250 employees, are no longer independent, or trade in an excluded activity.</p>
<h2>What changed in 2023</h2>
<p>Two changes made CSOP substantially more usable from 6 April 2023:</p>
<ul>
<li>The individual limit doubled from £30,000 to <strong>£60,000</strong> of options, measured by market value at grant.</li>
<li>The share class restrictions were relaxed. The previous requirement — broadly that the shares be of a class that was &ldquo;worth having&rdquo; by reference to employee shareholdings or open-market holdings — was removed, so companies with multiple share classes, including venture-backed companies with a separate class for employees, can now operate a CSOP without restructuring their share capital.</li>
</ul>
<p>That second change is the more significant one for private companies, and it is not yet widely known.</p>
<h2>The conditions</h2>
<ul>
<li>Options must be granted at an exercise price <strong>not less than the market value</strong> of the shares at grant. Unlike EMI there is no scope for granting below market value with a tax charge on the discount.</li>
<li>Shares must be ordinary share capital, fully paid and not redeemable.</li>
<li>Participants must be employees or full-time directors — a director must work at least 25 hours a week.</li>
<li>No material interest: broadly more than 30% of the share capital of a close company.</li>
<li>The plan must be self-certified to HMRC through the employment-related securities service by the statutory deadline following the tax year of the first grant.</li>
</ul>
<h2>The tax treatment</h2>
<p>Where the option is exercised at least three years after grant, or earlier in certain good-leaver and takeover circumstances, there is no income tax or National Insurance on exercise. The gain over the exercise price is a capital gain on disposal.</p>
<p>That three-year condition is the main practical difference from EMI. An employee who leaves after two years and exercises has an ordinary income tax charge on the spread, which is precisely the outcome the scheme exists to avoid.</p>
<h2>Agreeing the value</h2>
<p>Because the exercise price must be at least market value, the valuation is the foundation of the scheme rather than a supporting document. HMRC will agree the market value in advance on form VAL232, and as with EMI the agreement is valid for a limited window, subject to nothing material changing.</p>
<p>The analysis is the same one an EMI valuation requires: a value for the company, an allocation across the share classes with their rights, and an assessment of the restrictions in the articles. Where a company has both an EMI history and a CSOP going forward — which happens the year a company outgrows EMI — the two should be prepared consistently, because a value that jumps for no reason other than a change of scheme is the first thing anyone will ask about.</p>
<h2>Choosing between them</h2>
<p>If you qualify for EMI, use EMI: the limits are higher in aggregate, there is no minimum holding period, and the capital gains treatment is better. CSOP is the answer when you do not qualify, and increasingly it is the answer for the UK subsidiary of a larger group, where EMI&rsquo;s independence requirement rules the scheme out entirely.</p>
<p>See <a href="/products/csop-valuation">the CSOP valuation product page</a>, or <a href="/which-valuation">the 30-second quiz</a> if you are not sure which applies.</p>$x$
),
(
  '01N409B1GPST0000000000000X',
  'esop-valuation-and-adequate-consideration',
  'ESOP valuations and the adequate consideration standard',
  $x$An ESOP may not pay more than adequate consideration for employer stock. What that means in practice, why the appraiser reports to the trustee and not the company, and where the process gets challenged.$x$,
  'Funds & Transactions',
  'esop valuation adequate consideration erisa trustee independent appraiser annual valuation department of labor',
  'The N409 team',
  true,
  now() - interval '49 days',
  $x$<p>An employee stock ownership plan is a retirement plan that invests primarily in the stock of the sponsoring employer. Because the plan is buying an asset from a party with an interest in the price — often the selling owner — ERISA imposes a specific constraint: the plan may not pay more than <em>adequate consideration</em> for the stock.</p>
<p>Everything difficult about ESOP valuation follows from that sentence.</p>
<h2>What adequate consideration requires</h2>
<p>For an asset with no generally recognised market, adequate consideration is the fair market value determined in good faith by the plan fiduciary, in accordance with regulations. The statutory definition has two limbs, and the second — the good faith determination by the fiduciary — is the one that is litigated. It is a standard about <em>process</em> as much as about the number.</p>
<p>The Department of Labor has been actively revising its guidance in this area following a Congressional direction to issue formal regulations on adequate consideration, so any engagement should be run against the current position rather than against practice settled a decade ago.</p>
<h2>Who the appraiser works for</h2>
<p>This is the structural feature that distinguishes ESOP work from a 409A. The appraiser is engaged by, and reports to, the <strong>plan trustee</strong> — the fiduciary acting for the plan participants — not the company and not the selling shareholder. An appraiser taking direction from the seller is the fact pattern in most enforcement actions.</p>
<p>The trustee is expected to engage independently, to interrogate the appraisal rather than receive it, to question assumptions that favour the seller, and to document that process. A trustee who accepted a valuation without challenge has failed the standard even if the number was defensible.</p>
<h2>What the valuation itself involves</h2>
<p>The core is a conventional appraisal of a private operating company — income and market approaches, weighted and reconciled. The ESOP-specific questions sit on top:</p>
<ul>
<li><strong>Control versus minority.</strong> If the ESOP acquires a controlling interest, a control basis may be appropriate — but only where the ESOP genuinely obtains the attributes of control, which depends on the governance arrangements rather than on the percentage alone.</li>
<li><strong>Marketability.</strong> A discount for lack of marketability applies, moderated by the effect of the <a href="/blog/dlom-finnerty-chaffe-and-what-auditors-check">put option</a> the plan must provide to participants for their distributions.</li>
<li><strong>The transaction debt.</strong> A leveraged ESOP purchase loads the company with acquisition debt, which affects the value of the shares the plan holds afterwards.</li>
<li><strong>Repurchase obligation.</strong> The company&rsquo;s future obligation to buy back shares from departing participants is a real economic burden and has to be considered.</li>
<li><strong>Post-transaction adjustments</strong>, including any warrants or synthetic equity issued to the seller or to management.</li>
</ul>
<h2>Annual, not one-off</h2>
<p>The plan must obtain an independent appraisal at least annually to value participant accounts and to price distributions and repurchases. Those annual valuations are also where a problematic transaction becomes visible: a share price that falls sharply in the year after the sale invites the obvious question about the price the plan paid.</p>
<p>See <a href="/products/esop-valuation">the ESOP valuation product page</a>. This is a description of the standard, not legal advice on a specific transaction.</p>$x$
),
(
  '01N409B1GPST0000000000000Y',
  'cheap-stock-and-the-pre-ipo-409a',
  'Cheap stock: why pre-IPO option grants get scrutinised',
  $x$The gap between your last 409A and your IPO price has to be explained. What retrospective valuations are, why contemporaneous ones are worth so much more, and how the hybrid method fits.$x$,
  'Funds & Transactions',
  'cheap stock pre ipo 409a sec comment retrospective valuation s-1 disclosure hybrid method',
  'The N409 team',
  true,
  now() - interval '42 days',
  $x$<p>&ldquo;Cheap stock&rdquo; is the term for equity issued before an IPO at a price that, with hindsight and an offering price to compare against, looks too low. It is one of the more predictable sources of SEC comment on a registration statement, and it can delay an offering.</p>
<h2>The mechanism</h2>
<p>In the year or two before an IPO a company grants options at the fair market value determined by its 409A valuations. The IPO then prices at a substantially higher number. The registration statement has to explain that difference — for each grant date in the look-back period, what the fair value of the underlying stock was, how it was determined, and what happened between then and the offering to account for the change.</p>
<p>Where the explanation is unconvincing, the outcome is additional stock compensation expense — the difference between the value used and the value the staff considers supportable, recognised over the vesting periods — plus a restatement risk and, in practice, delay.</p>
<h2>Contemporaneous beats retrospective, by a lot</h2>
<p>A <strong>contemporaneous</strong> valuation is performed as at a date, using information available at that date, before anyone knows the outcome. A <strong>retrospective</strong> valuation is performed later, looking back at an earlier date, and it is what a company commissions when it discovers it granted against a stale report.</p>
<p>Retrospective valuations are permitted and are sometimes unavoidable. But they carry much less weight, because the appraiser knew how the story ended. The AICPA practice aid is explicit about the preference, and audit teams and the staff apply it. A company that maintained a contemporaneous valuation at every grant date in the look-back period has a much shorter conversation than one presenting three retrospective reports prepared in the same month.</p>
<h2>What changes in the methodology as an IPO approaches</h2>
<p>The plain OPM becomes progressively less appropriate. It assumes a continuous distribution of outcomes, and a company with a live IPO process has a discrete one: it lists, or it does not. This is precisely the fact pattern the <a href="/blog/opm-pwerm-and-the-hybrid-method">hybrid method</a> exists for — an explicit IPO scenario, probability weighted, alongside a stay-private branch allocated by OPM.</p>
<p>Two inputs also move sharply and should be seen to move. The expected time to liquidity shortens, which reduces the marketability discount. And in the IPO scenario the preferred converts to common, which collapses much of the gap between the two — which is exactly why the common stock value should be climbing towards the eventual offering price in the quarters before it, rather than jumping on the day of pricing.</p>
<h2>What to do about it</h2>
<ul>
<li>Keep the valuation current — quarterly, once an offering is realistically in view, rather than annually.</li>
<li>Treat every step of the process as a material event: the organisational meeting, the confidential submission, a change in the range.</li>
<li>Move to a hybrid allocation when an IPO becomes a real scenario rather than an aspiration, and document when and why the method changed.</li>
<li>Keep the board minutes that approve each valuation and each grant, dated and in order.</li>
<li>Do not grant against an expired report because the process is busy. That is when it happens.</li>
</ul>
<p>The general rule is simple enough: a smooth, documented progression of contemporaneous values towards the offering price is a paragraph in the S-1. A flat line followed by a step change is a comment letter. See <a href="/blog/how-often-do-you-need-a-409a-valuation">what counts as a material event</a>.</p>$x$
),
(
  '01N409B1GPST0000000000000Z',
  'inside-the-409a-valuation-process',
  'Inside the process: what happens between intake and a signed report',
  $x$What a valuation engagement actually consists of, in order, with the two stages that cause nearly every delay. Written so you can tell whether yours is on track.$x$,
  '409A Basics',
  '409a valuation process intake documents draft review final report timeline what to expect',
  'The N409 team',
  true,
  now() - interval '35 days',
  $x$<p>Valuation providers advertise turnaround times. What they do not usually publish is what the time is spent on, which makes it hard to tell whether an engagement is progressing or stuck. Here is the sequence.</p>
<h2>1. Intake</h2>
<p>You supply the company&rsquo;s information: the capitalisation table, the charter and any amendments, financial statements, a forecast, details of every financing including instruments that have not converted, the option plan and grant register, and a description of the business and its market. Where an accounting system or cap-table platform can be connected directly, most of this arrives without anyone retyping it.</p>
<p>This stage is where nearly all delay originates, and almost always for one of three reasons: the cap table does not agree to the charter, the financials are not closed for the valuation date, or a SAFE or bridge instrument surfaces that was not mentioned. Sorting these out before submitting rather than during review is the single largest thing a company controls.</p>
<h2>2. Analysis</h2>
<p>The appraiser establishes total equity value using the approaches the facts support — income, market, or a backsolve to a recent round — and documents the weighting between them. A comparable company set is selected and volatility derived from it. The <a href="/blog/liquidation-preferences-and-the-allocation-waterfall">preference waterfall</a> is built from the charter, and total equity value is allocated across share classes with the chosen <a href="/blog/opm-pwerm-and-the-hybrid-method">allocation method</a>. A <a href="/blog/dlom-finnerty-chaffe-and-what-auditors-check">marketability discount</a> is calculated and applied.</p>
<h2>3. Draft review</h2>
<p>You receive a draft with a conclusion and the reasoning behind it. This is the stage companies most often skip and most often should not.</p>
<p>What to check: does the cap table in the report match your records at the valuation date; are the comparable companies actually comparable to your business; does the forecast in the report match the plan you gave; is the expected time to liquidity consistent with what you told them; and does the concluded value make sense against your last round.</p>
<p>What this stage is not: a negotiation. A defensible appraisal cannot move because the number is inconvenient, and an appraiser who moves it on request has damaged the report&rsquo;s value to you. What it is for is correcting facts and surfacing context the appraiser did not have.</p>
<h2>4. Review and sign-off</h2>
<p>A second credentialed reviewer, independent of the preparer, tests the analysis and signs. Independent review is part of what safe harbour is buying — a single-analyst report with no second pair of eyes is a weaker document regardless of who wrote it.</p>
<h2>5. Board approval</h2>
<p>The report is delivered, and your board adopts it by resolution, setting the fair market value for grants until it expires or a material event occurs. This step is yours, it is frequently forgotten, and it is one of the first things an examiner asks for. A valuation that was never board-approved is a report, not a policy.</p>
<h2>Afterwards</h2>
<p>Keep the report with its exhibits, the source documents as supplied, and the minutes together. Diary the expiry twelve months from the valuation date, not from delivery, and re-run on any <a href="/blog/how-often-do-you-need-a-409a-valuation">material event</a> regardless of the diary.</p>
<p>The <a href="/sample-report">sample report</a> shows what the output looks like section by section, and <a href="/pricing">pricing</a> shows the standard and express timelines.</p>$x$
)
ON CONFLICT (slug) DO NOTHING;
