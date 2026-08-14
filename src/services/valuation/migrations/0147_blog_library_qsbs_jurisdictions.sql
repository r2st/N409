-- The article library, part 5: §1202 in depth, the non-US jurisdictions, and
-- the cap table the whole thing runs on.
--
-- Three gaps, each of a different kind.
--
-- QSBS: 0143 has one piece, and it is an overview. The questions that arrive
-- afterwards are all specific — whether a trust gift stacks the exclusion,
-- whether a services business fails the active-business test, whether a
-- redemption three years ago disqualified the stock — and each is a separate
-- search with its own intent. One overview cannot rank for or answer them.
--
-- Jurisdictions: 0144 covers EMI and CSOP because we sell those deliverables.
-- It does not cover the much more common case, which is a company incorporated
-- somewhere else with US employees, or a US company with employees in Canada,
-- India or Israel. Each has a local valuation requirement that is not a 409A
-- and is frequently discovered late.
--
-- The cap table: every article in the library assumes one that reconciles, and
-- nothing in it says what that means or who checks. It is also the single
-- largest cause of engagement delay, so the piece is written as the checklist
-- we would otherwise send by email.
--
-- Conventions as 0142. The jurisdiction pieces name thresholds and rules that
-- move with local budgets and say so in the text; none of them is advice for a
-- particular company, and each says where the local adviser's job starts.

INSERT INTO blog_posts (id, slug, title, excerpt, category, keywords, author, published, published_at, body_html)
VALUES
(
  '01N409B3GPST00000000000001',
  'qsbs-stacking-packing-and-non-grantor-trusts',
  $x$QSBS stacking, packing, and what a non-grantor trust actually does$x$,
  $x$The exclusion is per taxpayer and per issuer, which is why gifting shares multiplies it. The mechanics, the conditions that make it work, and the parts that are genuinely contested.$x$,
  'Tax',
  'qsbs stacking packing non grantor trust gifting section 1202 exclusion per taxpayer estate planning',
  'The N409 team',
  true,
  now() - interval '14 days',
  $x$<p>The §1202 gain exclusion is limited per taxpayer, per issuer. Those two words are the reason for an entire planning practice: if the limit attaches to the taxpayer, then more taxpayers means more limit, and shares can be moved to other taxpayers by gift without the recipient losing the stock&rsquo;s qualified status or its holding period.</p>
<p>This is real and widely used. It is also more conditional than the summaries suggest, and the conditions are where it fails.</p>
<h2>Stacking</h2>
<p>Stacking means multiplying the exclusion across taxpayers. A founder gifts qualified stock to non-grantor trusts for the benefit of family members; each trust is a separate taxpayer with its own per-issuer limitation, and on a sale each claims its own exclusion. §1202(h)(2) is what makes it work: stock acquired by gift is treated as having been acquired by the donee in the same way and at the same time as the donor held it, so qualification and holding period carry across.</p>
<p>Two conditions do the heavy lifting. The trust must be <strong>non-grantor</strong> — a grantor trust is disregarded and its income is the settlor&rsquo;s, which stacks nothing. And the gift must be a completed gift, which uses gift tax exemption and requires the shares to be valued for gift tax purposes at the transfer date. <a href="/products/gift-estate-tax-valuation">That valuation</a> is a separate engagement from a 409A, prepared to a different standard, and it is the document the return is filed on.</p>
<h2>Packing</h2>
<p>Packing means increasing the basis-driven half of the limitation. The cap is the greater of a dollar figure and ten times the taxpayer&rsquo;s aggregate adjusted basis in the qualified stock disposed of that year, so contributing appreciated property to the corporation in exchange for stock raises basis and therefore raises the ceiling. It is useful in a narrow set of facts and it interacts with the gross-assets test, since the contribution also raises the corporation&rsquo;s assets towards the ceiling.</p>
<h2>What actually goes wrong</h2>
<ul>
<li><strong>Gifting too late.</strong> A gift made when a sale is already agreed invites an assignment-of-income argument. The planning is done early, when the shares are worth little and the gift tax cost is small, which is also when nobody is thinking about it.</li>
<li><strong>Trusts that are not really separate.</strong> Multiple trusts with the same settlor, the same beneficiary and the same trustee, funded on the same day, are the fact pattern §643(f) addresses.</li>
<li><strong>State tax.</strong> Several states do not conform to §1202 at all. The federal exclusion may be complete and the state bill unchanged, and where the trust is sited matters.</li>
<li><strong>The stock was never qualified.</strong> All of this is downstream of the stock actually meeting the §1202 tests, which is the thing least often checked before the planning is built on it.</li>
</ul>
<h2>The order of operations</h2>
<p>Establish that the stock qualifies, then plan. <a href="/blog/qsbs-the-active-business-and-asset-tests-in-detail">The active business and gross asset tests</a> is where that starts, and <a href="/products/qsbs-attestation">a §1202 attestation</a> is the document that records the conclusion with the evidence behind it. Doing it the other way round produces an elaborate structure over stock that never qualified, which is the most expensive way to discover the answer.</p>
<p>The planning itself is your tax counsel&rsquo;s and estate counsel&rsquo;s work, not ours. What we provide is the qualification analysis it stands on and the transfer-date valuations the gifts are reported at.</p>$x$
),
(
  '01N409B3GPST00000000000002',
  'qsbs-the-active-business-and-asset-tests-in-detail',
  $x$QSBS: the active business and gross asset tests, in detail$x$,
  $x$Two tests fail more §1202 claims than everything else combined. One is measured at a single moment and never again; the other has to hold for substantially all of the holding period.$x$,
  'Tax',
  'qsbs active business test 80 percent gross assets test 50 million section 1202 e 3 excluded services',
  'The N409 team',
  true,
  now() - interval '12 days',
  $x$<p>Section 1202 has five or six conditions depending on how you count them. In practice two of them decide most cases, and they fail in opposite ways: the gross assets test fails at a single historical instant nobody was watching, and the active business test fails gradually over years.</p>
<h2>The gross assets test</h2>
<p>The corporation&rsquo;s aggregate gross assets must not have exceeded the statutory ceiling at any time from incorporation up to and immediately after the issuance of the stock in question. Three features of that sentence matter more than the number:</p>
<ul>
<li><strong>&ldquo;At any time.&rdquo;</strong> A single moment above the ceiling — the day a large round landed before the cash was deployed — disqualifies every issuance from that moment on. It is not measured at year end.</li>
<li><strong>&ldquo;Immediately after.&rdquo;</strong> The round&rsquo;s own proceeds count. A company at the ceiling that raises is over it on the closing date, so the shares issued in that round fail even though the shares issued the week before pass.</li>
<li><strong>Adjusted basis, not fair value.</strong> Assets are measured at adjusted basis, with contributed property taken at fair market value on contribution. A company can be worth many multiples of the ceiling and be comfortably inside it, which is why late-stage companies still issue qualified stock.</li>
</ul>
<p>Because the test is historical and per-issuance, the answer differs share by share on the same cap table. That is the single most misunderstood feature of §1202: qualification is a property of an issuance, not of a company.</p>
<h2>The active business test</h2>
<p>During substantially all of the taxpayer&rsquo;s holding period, at least 80% of the corporation&rsquo;s assets by value must be used in the active conduct of one or more qualified trades or businesses. Two clauses do the damage.</p>
<p><strong>The excluded businesses.</strong> §1202(e)(3) excludes any trade or business whose principal asset is the reputation or skill of one or more of its employees, along with named categories including health, law, engineering, architecture, accounting, actuarial science, performing arts, consulting, athletics, financial services and brokerage — plus banking, insurance, farming, extraction and hospitality. The reputation-or-skill clause is the contested one, and the guidance that exists reads it narrowly: a business is not excluded merely because skilled people work there. A software company employing excellent engineers is not an engineering firm.</p>
<p>Where it genuinely bites is the services company that describes itself as a technology company. If revenue is billed per hour or per engagement, that is the question being asked, and how the pitch deck describes the business is not the answer.</p>
<p><strong>The working capital limit.</strong> Cash and investments count as used in the business only as reasonably required working capital or as investment in research and development, and after the first two years no more than 50% of assets may be held that way. A company sitting on a very large raise relative to its burn can fail the 80% test on cash alone, and the failure is silent.</p>
<h2>The evidence that has to exist</h2>
<p>These tests are applied years later, usually under a diligence deadline, from records nobody kept for this purpose. What is needed is a contemporaneous asset history, the balance sheets around each issuance, a description of the business and its revenue as it actually was in each period, and the deployment of each round&rsquo;s proceeds. <a href="/products/qsbs-attestation">A §1202 attestation</a> assembles and tests exactly that, and the earlier it is done the more of the evidence still exists. <a href="/blog/qsbs-section-1202-what-founders-need-to-know">The overview piece</a> covers the remaining conditions.</p>$x$
),
(
  '01N409B3GPST00000000000003',
  'qsbs-redemptions-and-how-eligibility-is-quietly-lost',
  $x$QSBS: redemptions, conversions, and how eligibility is quietly lost$x$,
  $x$A buyback two years before your issuance can disqualify it, and nobody involved in the buyback will have mentioned it. The look-back rules, what conversions and reorganisations do, and what to check before relying on §1202.$x$,
  'Tax',
  'qsbs redemption rules section 1202 c 3 look back buyback disqualification conversion reorganization 1045 rollover',
  'The N409 team',
  true,
  now() - interval '10 days',
  $x$<p>The §1202 conditions people check are the ones about the company: C corporation, under the asset ceiling, active qualified business. The conditions that most often disqualify stock quietly are about transactions the shareholder had nothing to do with.</p>
<h2>The redemption look-back</h2>
<p>§1202(c)(3) disqualifies stock issued in proximity to redemptions by the corporation, in two forms.</p>
<p><strong>Related-party redemptions.</strong> If the corporation redeems stock from the taxpayer or a related person within a window running from two years before the issuance to two years after it, the newly issued stock is not qualified. The window is four years wide and half of it is in the past at the moment of issuance.</p>
<p><strong>Significant redemptions.</strong> If the corporation redeems more than a de minimis amount of its aggregate stock — measured by value against a low percentage threshold — within a window running from one year before issuance to one year after, stock issued in that window is disqualified. This one does not require any relationship to the shareholder at all.</p>
<p>Both rules have de minimis exceptions, and both have exceptions for redemptions arising from terminations of employment, death, disability and similar events. Those exceptions are the reason most ordinary leaver buybacks do not cause a problem — and the reason it is worth establishing which exception applies rather than assuming one does.</p>
<h2>Why this is missed</h2>
<p>The redemption is a transaction between the company and a departing shareholder. The founder holding stock issued eighteen months later was not a party to it, may not have been told, and has no reason to think about it. A secondary purchase by an investor is <em>not</em> a redemption — the company is not the buyer — but a company-funded buyback of a departing founder&rsquo;s stock is, and the two are described in conversation with the same word.</p>
<p>Any repurchase of shares by the company is worth flagging: pay-to-play recapitalisations, repurchases of unvested stock on departure, and company-funded tender offers all deserve a look. <a href="/blog/tender-offers-secondary-sales-and-your-409a">The tender offer piece</a> covers the structuring difference between a company redemption and an investor purchase, which is one of the reasons the distinction is worth getting right at the time.</p>
<h2>Conversions and reorganisations</h2>
<p>Converting from an LLC to a C corporation starts the §1202 clock at conversion, and the stock&rsquo;s basis for the ten-times-basis limitation is the fair value of the contributed assets — which is why the conversion-date valuation matters years later. Preferred converting to common on an IPO is generally not a new issuance for these purposes. A tax-free reorganisation can carry qualification into the successor&rsquo;s stock under §1202(h)(4), with limits on the gain that remains excludable.</p>
<p>And where the five-year holding period is not met, §1045 permits a rollover of the gain into other qualified small business stock within sixty days. That is a live option in an acquisition that closes at four and a half years, and it has to be identified before the proceeds are spent.</p>
<h2>The check that is worth doing early</h2>
<p>List every share the company has ever repurchased, with date, counterparty, relationship and reason. It takes an afternoon while the people involved are still there, and it is close to unreconstructable after two changes of finance lead. <a href="/blog/qsbs-stacking-packing-and-non-grantor-trusts">Any planning built on §1202</a> is built on the answer.</p>$x$
),
(
  '01N409B3GPST00000000000004',
  '409a-valuations-for-non-us-companies-with-us-employees',
  $x$409A valuations for non-US companies with US employees$x$,
  $x$Section 409A follows the person, not the company. A Delaware entity is not what triggers it — a US taxpayer holding an option is.$x$,
  'UK & International',
  '409a non us company us employees foreign parent delaware flip subsidiary option grant taxpayer',
  'The N409 team',
  true,
  now() - interval '9 days',
  $x$<p>Companies incorporated outside the United States regularly conclude that Section 409A is not their problem. It is a US tax rule, they are a UK or Israeli or Singaporean company, and their lawyers did not raise it. Then they hire in San Francisco and grant that person options.</p>
<h2>The rule follows the taxpayer</h2>
<p>Section 409A applies to deferred compensation received by a US taxpayer. If a person subject to US federal income tax holds an option over your shares, the option must be struck at or above the fair market value of those shares on the grant date, or the holder faces income tax on the spread as it vests, an additional 20% penalty, and interest. The place of incorporation of the issuer does not enter into it.</p>
<p>So the trigger is your first US employee, your first US-resident contractor taking equity, and any US citizen on your team wherever they live — citizenship is enough. It is not the Delaware subsidiary, which is a common misreading.</p>
<h2>What that means practically</h2>
<p>You need an independent appraisal of the shares underlying the options, refreshed at least every twelve months and on any material event, adopted by the board, and used to price grants — the same discipline a US company runs. The valuation is of your actual shares: if the options are over the parent&rsquo;s ordinary shares, the parent&rsquo;s ordinary shares are what is valued, whatever the group structure below.</p>
<p><a href="/blog/how-often-do-you-need-a-409a-valuation">The refresh rules</a> and <a href="/blog/what-a-409a-valuation-actually-defends">what safe harbour buys</a> apply unchanged.</p>
<h2>The double-requirement problem</h2>
<p>The common case is not a 409A instead of a local requirement. It is both, at once, over the same shares, on different standards and possibly at different numbers.</p>
<p>A UK company with US employees typically needs an HMRC-agreed value for its <a href="/products/emi-valuation">EMI</a> or <a href="/products/csop-valuation">CSOP</a> scheme and a 409A conclusion for the US grants. These are not the same figure and are not supposed to be: EMI is agreed on an unrestricted and an actual market value basis under UK law, and a 409A concludes fair market value under US rules. Running both from one analysis, with one cap table and one set of financials, is what keeps them consistent where they should be and explicable where they differ. Running them at different firms a year apart is how a company ends up unable to explain either.</p>
<p>The same pattern applies for <a href="/blog/indian-esop-valuations-and-the-merchant-banker-requirement">India</a>, <a href="/blog/israeli-section-102-options-and-the-trustee-route">Israel</a> and <a href="/blog/canadian-employee-stock-options-and-fair-market-value">Canada</a>.</p>
<h2>If you are about to flip</h2>
<p>Companies redomiciling into a US holding company for a US round should sequence the valuation around the flip rather than through it. The share exchange changes the entity whose shares are under option and normally changes the capital structure with it, so a valuation of the old parent does not price grants over the new one. Value after the flip, before the first grant under the new plan.</p>
<p><a href="/which-valuation">The chooser</a> will tell you which deliverables your situation needs, or <a href="/contact">ask us</a> — multi-jurisdiction structures are the case where the answer is worth checking rather than assuming.</p>$x$
),
(
  '01N409B3GPST00000000000005',
  'hmrc-share-and-assets-valuation-how-agreement-works',
  $x$HMRC Shares and Assets Valuation: how agreement actually works$x$,
  $x$A UK share valuation is proposed, not filed. What SAV does with a submission, how long agreement lasts, what happens if they disagree, and why the negotiation is won in the covering letter.$x$,
  'UK & International',
  'hmrc shares and assets valuation sav val231 val230 emi csop agreement negotiation unrestricted market value',
  'The N409 team',
  true,
  now() - interval '8 days',
  $x$<p>UK share scheme valuations work differently from US ones in a way that catches companies used to the American model. A 409A is an appraisal you obtain, your board adopts, and nobody approves — its strength is the safe harbour, and the IRS only sees it if it is challenged. A UK EMI or CSOP valuation is a figure you <em>propose to HMRC</em>, and HMRC either agrees it or does not.</p>
<h2>The process</h2>
<p>You submit a valuation to Shares and Assets Valuation on the appropriate form — VAL231 for <a href="/products/emi-valuation">EMI</a>, VAL230 for <a href="/products/csop-valuation">CSOP</a> — with the supporting analysis, the accounts, the cap table and the articles. SAV reviews it and either agrees the figures, agrees them subject to a modification, or comes back with questions. What emerges is an agreed value, valid for a defined period from the agreement date, within which options may be granted at that value.</p>
<p>The period is a matter of published HMRC practice rather than statute and it has changed; confirm the current window at the time of your submission rather than relying on what applied to your last round. An agreement also ceases to be reliable if something material changes in the meantime — a funding round, a significant acquisition or disposal, a change to the articles. The rule of thumb is the same as the 409A one: the agreement covers a period <em>and</em> a state of the world.</p>
<h2>What SAV is testing</h2>
<p>For EMI, two figures: the <strong>unrestricted market value</strong>, ignoring the restrictions attaching to the shares, and the <strong>actual market value</strong>, taking them into account. The scheme limits are measured on UMV and the option price is normally set at AMV, so both matter and the discount between them is where most of the discussion happens. <a href="/blog/emi-share-options-uk-hmrc-valuation">The EMI piece</a> covers this in more detail; for CSOP, only the unrestricted value is relevant.</p>
<p>The discount has to be argued from the actual articles — leaver provisions, compulsory transfer, pre-emption, drag and tag — and not from a customary percentage. A submission that asserts a discount without naming the clauses that support it is the one most likely to come back with questions.</p>
<h2>What good submissions do</h2>
<ul>
<li><strong>State the basis plainly.</strong> Which approach was used, why it fits a company at this stage, and how the per-share figure follows from the equity value.</li>
<li><strong>Deal with the last funding round head-on.</strong> If preferred shares were issued at a much higher price, explain the rights that account for the difference rather than leaving SAV to ask.</li>
<li><strong>Attach the articles and point at the clauses.</strong> The restriction discount stands on them.</li>
<li><strong>Confirm scheme qualification separately.</strong> SAV agrees value; it does not bless your Schedule 5 or Schedule 4 position, and a company that assumes agreement means qualification has assumed the wrong thing.</li>
</ul>
<h2>If HMRC disagrees</h2>
<p>The usual outcome is a negotiation, not a refusal, and it is settled in correspondence. What weakens your position is an unexplained gap between the proposed value and a recent transaction, or a valuation prepared without the documents that govern the shares. What strengthens it is having answered the obvious question before it was asked.</p>
<p>Do not grant options against an unagreed valuation if the agreement matters to you — the point of the process is certainty, and granting first gives that up. Where the same company also has US employees, <a href="/blog/409a-valuations-for-non-us-companies-with-us-employees">the parallel 409A requirement</a> runs alongside this and concludes at its own figure.</p>$x$
),
(
  '01N409B3GPST00000000000006',
  'canadian-employee-stock-options-and-fair-market-value',
  $x$Canadian employee stock options and fair market value$x$,
  $x$No filing, no agreement, and a deduction that depends on the exercise price having been right at grant. Where the FMV requirement comes from, what the CCPC rules change, and what the annual cap did.$x$,
  'UK & International',
  'canada employee stock option fair market value ccpc 110 1 d deduction deferral cra valuation annual vesting limit',
  'The N409 team',
  true,
  now() - interval '7 days',
  $x$<p>Canada has no equivalent of a 409A filing and no equivalent of HMRC&rsquo;s agreement process. What it has is a set of tax consequences that turn on whether the exercise price was at least the fair market value of the share at the date of grant, which produces the same practical requirement by a different route.</p>
<p>This is general information about how the regime is structured, not Canadian tax advice; the rules are detailed and have changed more than once, and a Canadian adviser should confirm the current position for any actual plan.</p>
<h2>The basic structure</h2>
<p>An employee who exercises an option realises an employment benefit equal to the spread between the fair market value of the share at exercise and the exercise price. Where the conditions are met — broadly, the exercise price is not less than the fair market value of the share at grant, the shares are ordinary common shares, and the employee deals at arm&rsquo;s length with the employer — a deduction is available that taxes the benefit at an effective rate comparable to a capital gain.</p>
<p>That deduction is the entire benefit of the plan to the employee, and its first condition is a fact about the grant date. So a grant priced below fair market value does not merely create a bigger benefit later; it can cost the favourable treatment on all of it.</p>
<h2>What CCPC status changes</h2>
<p>For a Canadian-controlled private corporation, the taxation of the benefit is generally <strong>deferred until the shares are disposed of</strong> rather than arising at exercise. This is a substantial advantage over the US treatment of a non-qualified option and is the reason CCPC status is guarded carefully.</p>
<p>It is also fragile. Control by non-residents or by public corporations can end CCPC status, and a US-led venture round is exactly the kind of event that raises the question. Companies frequently discover the change after the round rather than during it.</p>
<h2>The annual limit</h2>
<p>An annual vesting limit applies to the favourable deduction for options granted by larger, non-CCPC employers, with the excess taxed without it and a corresponding deduction available to the employer instead. Where the limit bites, the plan design question changes shape — the ordering of grants and the choice of instrument start to matter in a way they did not before. The threshold and its scope are the parts most worth confirming currently.</p>
<h2>Establishing fair market value</h2>
<p>There is no prescribed method and no approval process, which is not the relief it sounds like: the burden of demonstrating the exercise price was right sits with the taxpayer, and it is discharged years later against a CRA review with whatever evidence exists. The evidence that works is an independent appraisal as at the grant date, refreshed on the same cadence a 409A would be, with the board&rsquo;s adoption recorded.</p>
<p>For a company with employees in both countries, the sensible arrangement is one analysis supporting both conclusions rather than two firms reaching two numbers over the same shares — see <a href="/blog/409a-valuations-for-non-us-companies-with-us-employees">the multi-jurisdiction piece</a>. <a href="/blog/iso-vs-nso-how-stock-options-are-taxed">The US option tax piece</a> is the comparison point for anyone administering both.</p>$x$
),
(
  '01N409B3GPST00000000000007',
  'indian-esop-valuations-and-the-merchant-banker-requirement',
  $x$Indian ESOP valuations and the merchant banker requirement$x$,
  $x$India prescribes who may value and, for some purposes, how. Two separate valuation requirements sit over the same shares, and the one companies miss is the issue-price rule, not the ESOP one.$x$,
  'UK & International',
  'india esop valuation merchant banker registered valuer rule 11ua section 56 2 viib perquisite fema',
  'The N409 team',
  true,
  now() - interval '6 days',
  $x$<p>India differs from most jurisdictions in prescribing not only that a valuation is required but <em>who</em> may perform it and, in places, how. Companies with an Indian subsidiary granting equity to Indian employees encounter at least two distinct requirements, and they are frequently conflated.</p>
<p>What follows describes the shape of the regime rather than the current detail. Indian valuation rules have been amended repeatedly and the categories of eligible valuer have moved; a local chartered accountant or merchant banker should confirm the position for any actual transaction.</p>
<h2>The perquisite valuation on exercise</h2>
<p>When an employee exercises, the difference between the fair market value of the share on the exercise date and the price paid is a perquisite taxable as salary, with the employer required to withhold. For an unlisted company the fair market value for this purpose is determined under the income tax rules, which have historically required a category of prescribed valuer — a merchant banker registered with SEBI — as at a date within a defined window before exercise.</p>
<p>The practical consequence is that the valuation has to be obtained on a schedule set by exercise activity, not annually for convenience, and it has to be produced by an eligible valuer. A valuation from the wrong category of professional is not a cheaper version of the right one; for this purpose it does not satisfy the requirement.</p>
<h2>The issue price rule, which is the one that gets missed</h2>
<p>Separately, where an Indian company issues shares to a resident at more than their fair market value, the excess can be taxed in the company&rsquo;s hands. Rule 11UA prescribes the methods available for establishing that value. This applies to <em>issuances</em>, which means it applies to the parent funding the Indian subsidiary and to any share issue by the Indian entity — not only to employee equity.</p>
<p>Companies focus on the ESOP valuation because it has an obvious owner in HR or finance and forget the issue-price valuation, which sits with whoever processes the intercompany funding. There are also cross-border pricing rules under FEMA governing transfers between residents and non-residents, with their own valuation requirements and their own eligible-valuer categories.</p>
<h2>How this fits a US parent</h2>
<p>The common structure is a Delaware parent with an Indian subsidiary, granting options over parent stock to Indian employees. That produces a 409A over the parent&rsquo;s common stock for US purposes and an Indian perquisite valuation of the same stock for withholding, on a different date, on a different basis, by a prescribed valuer.</p>
<p>They will not be the same number and are not supposed to be. What they should be is consistent about the facts underneath — the same cap table, the same financials, the same funding history — so that a difference is explicable as a difference in method rather than as two firms disagreeing about the company. <a href="/blog/409a-valuations-for-non-us-companies-with-us-employees">The multi-jurisdiction piece</a> covers the general pattern.</p>
<h2>What to put in place</h2>
<p>A calendar keyed to exercise windows rather than to the financial year, a named eligible valuer engaged before the first exercise rather than after it, and one source of truth for the cap table that both the US and Indian analyses run from. <a href="/blog/what-a-valuation-provider-needs-from-your-cap-table">The cap table piece</a> is the practical version of that last point, and <a href="/contact">we can scope</a> the US side alongside whatever your Indian advisers require.</p>$x$
),
(
  '01N409B3GPST00000000000008',
  'israeli-section-102-options-and-the-trustee-route',
  $x$Israeli Section 102 options and the trustee route$x$,
  $x$The capital gains track is the reason Israeli option plans exist, and it depends on filings and a trustee holding period rather than on the exercise price. Where valuation does and does not come into it.$x$,
  'UK & International',
  'israel section 102 options capital gains track trustee holding period ita filing 3i non employee valuation',
  'The N409 team',
  true,
  now() - interval '5 days',
  $x$<p>Israel&rsquo;s Section 102 regime is unusual in that its central benefit turns on procedure rather than price. Getting the exercise price right matters, but the thing that decides how an Israeli employee is taxed is whether the plan was filed correctly and whether a trustee held the securities for long enough.</p>
<p>This is a description of the structure, not Israeli tax advice. Section 102 is procedural and unforgiving, and Israeli counsel should run the filings.</p>
<h2>The tracks</h2>
<p>Grants to employees can be made through a trustee or without one. The trustee routes divide again into an ordinary income track and a <strong>capital gains track</strong>, and the capital gains track is what almost every plan uses: the employee&rsquo;s gain is taxed at a favourable rate on sale rather than as employment income, with the company giving up a corresponding expense deduction.</p>
<p>Two conditions carry it. The plan and the trustee must be filed with the Israeli Tax Authority in advance, with a waiting period before grants can be made under it. And the securities must be held by the approved trustee for a minimum period running from the date of grant and deposit. Release before that period ends loses the treatment.</p>
<p>Grants to controlling shareholders and to non-employees — consultants, advisers, service providers — fall outside Section 102 and are taxed under Section 3(i) as ordinary income. This is the most common structural error in Israeli plans, because the person concerned looks like everyone else on the cap table.</p>
<h2>Where valuation comes in</h2>
<p>Not in the way it does under Section 409A. The favourable treatment does not depend on the exercise price having equalled fair market value at grant. Valuation matters instead for the ordinary reasons: setting a defensible exercise price, measuring the expense under <a href="/blog/ifrs-2-vs-asc-718">IFRS 2 or ASC 718</a>, and — for the very common Israeli structure of a Delaware parent over an Israeli subsidiary — for the parent&rsquo;s <a href="/products/409a-valuation">409A</a>, which is a genuine requirement for any US taxpayer in the plan.</p>
<p>It also matters at exit, where the allocation of consideration between share classes determines what each option holder receives, and that arithmetic runs off the same waterfall a valuation is built on. <a href="/blog/liquidation-preferences-and-the-allocation-waterfall">The waterfall piece</a> covers it.</p>
<h2>The failures worth naming</h2>
<ul>
<li><strong>Granting before the filing waiting period has run.</strong> The grants are not under the filed plan.</li>
<li><strong>Non-employees granted under the 102 plan.</strong> Wrong section, wrong tax, discovered at exit.</li>
<li><strong>Early release from the trustee.</strong> A tender offer or secondary that releases shares inside the holding period can cost the treatment for those shares.</li>
<li><strong>Amending the plan without re-filing.</strong> Material amendments have their own procedure.</li>
</ul>
<h2>For the US parent</h2>
<p>An Israeli-founded group with a Delaware parent needs the 409A for its US taxpayers, the Israeli plan filings and trustee arrangements for its Israeli employees, and one valuation of the parent&rsquo;s common stock underneath both. Running that once, from one cap table, is the arrangement that survives diligence — see <a href="/blog/409a-valuations-for-non-us-companies-with-us-employees">409A valuations for non-US companies</a>.</p>$x$
),
(
  '01N409B3GPST00000000000009',
  'what-a-valuation-provider-needs-from-your-cap-table',
  $x$What a valuation provider actually needs from your cap table$x$,
  $x$Nearly every delayed engagement is delayed here, and almost always for one of eight reasons. The list, in the order they are found, and how to clear them before you submit.$x$,
  'Cap Table & Governance',
  'cap table reconciliation charter certificate of incorporation 409a delay diligence share register option ledger',
  'The N409 team',
  true,
  now() - interval '4 days',
  $x$<p>Appraisers do not usually miss deadlines because the analysis was hard. They miss them because the cap table does not agree with the charter, and answering that takes a round trip through a law firm. The same eight problems account for most of it.</p>
<h2>What is being reconciled, and against what</h2>
<p>The cap table is a working record. The <strong>charter</strong> — the amended and restated certificate of incorporation, or the equivalent constitutional document — is the authority, and it is what the allocation is built from. So the cap table is checked against the charter, the share register, the board consents authorising each issuance, and the executed instruments for anything not yet converted. Where they disagree, the charter wins and the work stops until the difference is explained.</p>
<h2>The eight</h2>
<ul>
<li><strong>Authorised versus issued.</strong> A series showing more shares issued than the charter authorises. Usually an amendment that was approved and never filed, or filed and never recorded.</li>
<li><strong>Preferences that do not match the charter.</strong> The platform says 1x non-participating; the charter says participating with a cap. The platform stores a summary, and <a href="/blog/structured-rounds-and-the-price-behind-the-headline">structure is price</a>.</li>
<li><strong>Options promised beyond the pool.</strong> Offer letters and board-approved grants exceeding the shares reserved. Common after a hiring push, and it changes the fully diluted count.</li>
<li><strong>Grants with no approval date.</strong> A grant register with vesting start dates and no corresponding board consent. The grant date is the approval date, and it is what ties the grant to a valuation.</li>
<li><strong>Unconverted instruments missing.</strong> SAFEs and notes held in a folder rather than on the cap table. <a href="/blog/caps-discounts-and-accrued-interest-how-a-note-converts">Each has terms</a> that have to be modelled.</li>
<li><strong>Warrants nobody recorded.</strong> Almost always <a href="/blog/venture-debt-warrants-and-how-they-are-valued">from a debt facility</a>, issued by finance, never sent to the equity administrator.</li>
<li><strong>Unvested and repurchased founder stock.</strong> Shares subject to repurchase treated as outstanding, or repurchased shares never retired. The second also matters for <a href="/blog/qsbs-redemptions-and-how-eligibility-is-quietly-lost">§1202</a>.</li>
<li><strong>Two versions in circulation.</strong> The platform, the finance team&rsquo;s spreadsheet, and the one in the last data room, all different. This is the one that costs the most time, because every other answer has to be given twice.</li>
</ul>
<h2>What to send</h2>
<p>The current charter with every amendment, the cap table as at the valuation date rather than today, the option plan and its amendments, the grant register with approval dates, executed copies of every unconverted instrument and warrant, board consents for issuances and grants in the period, and the share register. Where a platform can be connected directly, most of this arrives without anyone retyping it, which also removes a class of transcription error.</p>
<h2>The habit that prevents all of it</h2>
<p>Reconcile once a quarter, not once a round. A quarterly check against the charter takes an hour when nothing has changed and catches the one thing that has. Doing it for the first time during diligence means doing it under a deadline, with the people who made the original entries no longer at the company.</p>
<p><a href="/blog/inside-the-409a-valuation-process">Inside the valuation process</a> shows where this sits in the engagement, and <a href="/blog/board-approval-and-the-409a-paper-trail">the board approval piece</a> covers the record that has to exist alongside it.</p>$x$
),
(
  '01N409B3GPST00000000000010',
  'board-approval-and-the-409a-paper-trail',
  $x$Board approval and the 409A paper trail nobody keeps$x$,
  $x$The report is half the record. The other half is the resolution adopting it, the grant approvals that reference it, and the dates tying the two together — and it is the half that is missing when someone asks.$x$,
  'Cap Table & Governance',
  'board approval 409a resolution minutes grant date written consent safe harbor record keeping equity administration',
  'The N409 team',
  true,
  now() - interval '3 days',
  $x$<p>A valuation report establishes a value. It does not establish that the company adopted it, granted against it, or knew what it said. Those are questions about the board&rsquo;s record, and they are asked by auditors during an IPO readiness review, by acquirers in diligence, and by an examiner reviewing a grant.</p>
<h2>What the record has to show</h2>
<p>Three links, in order, each with a date:</p>
<ul>
<li><strong>Adoption.</strong> A board resolution accepting the valuation report, identifying it specifically — provider, valuation date, concluded value per share — and stating that the value is adopted as the fair market value of the common stock for grants until it expires or a material event occurs.</li>
<li><strong>Grant approval.</strong> Board or committee approval of each grant, with the recipient, the number of shares, the exercise price, the vesting terms, and the date of approval.</li>
<li><strong>The tie.</strong> Something that shows the exercise price used was the adopted value current on the approval date. In practice this is the grant register carrying both the approval date and the valuation it was priced from.</li>
</ul>
<p>Any of the three missing is a gap, and the gaps are found together because they have the same cause: nobody owned the record.</p>
<h2>Grant date, precisely</h2>
<p>The grant date is the date of the corporate action approving the grant, not the date of the offer letter, the start date, or the day the paperwork was processed. Two situations produce most of the errors.</p>
<p><strong>Written consents that circulate.</strong> A consent signed by directors over three weeks is effective when the last required signature is obtained. If a valuation expired in the middle of that period, which side of it the grant falls on is a real question with a real answer, and the answer should be applied consistently.</p>
<p><strong>Grants approved subject to a condition.</strong> A grant approved contingent on something — a start date, a financing closing — has a grant date determined by when the mutual understanding of the key terms is reached, which is also the date <a href="/blog/asc-718-stock-based-compensation-for-startups">ASC 718</a> measures grant-date fair value on. The tax and accounting answers should not diverge.</p>
<h2>The expiry nobody diaries</h2>
<p>A valuation runs twelve months from the <strong>valuation date</strong>, not from delivery. A report with a 31 March valuation date delivered on 15 May expires on 31 March, and the six weeks of delivery time are not extra runway. Diary it from the valuation date the day the report arrives, and diary a refresh to start well before it — a grant made in the gap while the next valuation is in progress has no current valuation behind it. <a href="/blog/how-often-do-you-need-a-409a-valuation">The refresh rules</a> and the material-event test are covered separately.</p>
<h2>Where to keep it</h2>
<p>One place, with the reports and their exhibits, the source documents as supplied, the adopting resolutions, and the grant approvals. Not split between a board portal, a shared drive and the equity platform, which is the arrangement that survives right up until the person who knew where everything was leaves.</p>
<p>This is unglamorous and it is most of what distinguishes a company whose equity history holds up in diligence from one that spends a fortnight in a data room reconstructing it. <a href="/blog/what-a-valuation-provider-needs-from-your-cap-table">The cap table piece</a> is the other half, and <a href="/blog/ipo-readiness-the-valuation-work-that-starts-early">IPO readiness</a> is what both of them are eventually for.</p>$x$
)
ON CONFLICT (slug) DO NOTHING;

-- The launch post, given a way out of itself.
--
-- 0122's single article was written before there was a library, so it links
-- nowhere: a reader who finishes it has no route to a product, a guide or
-- another piece, and a crawler reaching it finds a dead end. Fifty articles
-- later there is somewhere to send them, and each of its four sections now has
-- a piece of its own.
--
-- 0122 itself is amended so a fresh database seeds the linked version; this
-- statement is for databases where that INSERT has already run and its
-- ON CONFLICT would leave the old body in place. The guard is the original
-- closing sentence, so a post ops has since rewritten by hand is left alone
-- rather than having a paragraph appended to prose that no longer leads to it.
UPDATE blog_posts
   SET body_html = body_html ||
       '<p>The four parts are each taken separately elsewhere in this library: ' ||
       '<a href="/blog/the-three-valuation-approaches">the approaches and how they are weighted</a>, ' ||
       '<a href="/blog/opm-pwerm-and-the-hybrid-method">the allocation methods</a>, and ' ||
       '<a href="/blog/dlom-finnerty-chaffe-and-what-auditors-check">the marketability discount auditors test first</a>. ' ||
       '<a href="/sample-report">The sample report</a> shows the whole argument assembled, section by section.</p>',
       updated_at = now()
 WHERE slug = 'what-a-409a-valuation-actually-defends'
   AND body_html LIKE '%that is the part worth automating, not the judgment.</p>'
   AND body_html NOT LIKE '%/blog/the-three-valuation-approaches%';
