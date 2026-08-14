/**
 * Engagement tags — the controlled vocabulary, and the mapping from the
 * `tagging` agent's output onto it.
 *
 * This is 409.ai parity gap #23 (`AI:FindRelevantTags`), and the reason it sat
 * open longest of the thirty-one is recorded in the comparison document: there
 * was no `valuation_tags` table *and no consumer for one*. A tag nothing reads
 * is a field an analyst fills in and never sees again, so the vocabulary and
 * the consumer are decided here together.
 *
 * ## Why the vocabulary is closed
 *
 * The single decision this module exists to make. A tagging model asked for
 * free text returns `saas`, `SaaS`, `B2B SaaS` and `software-as-a-service` for
 * one fact, across four engagements, and every one of them is a different tag.
 * A filter over that vocabulary returns a quarter of the matches while looking
 * exactly like a filter that worked — which is worse than no filter, because
 * nothing about the result says it is incomplete.
 *
 * So the model chooses from `TAG_CATALOGUE` and anything else it returns is
 * dropped rather than normalised. Normalising would be the tempting half-fix
 * and it is a trap: `slugify('B2B SaaS') === 'b2b-saas'` is still not `saas`,
 * and the cases it does catch teach a reader to trust the cases it does not.
 *
 * ## What a tag is for
 *
 * Three consumers, and the vocabulary is shaped by them rather than by what a
 * model finds easy to say:
 *
 *   * **Filtering the engagement list.** "Show me the pre-revenue ones", "the
 *     ones with a participating stack".
 *   * **Precedent.** A firm's defensibility rests on treating like engagements
 *     alike, and the question "what did we conclude last time we valued a
 *     pre-revenue medtech company with a participating preferred stack" has no
 *     answer without a shared vocabulary to ask it in.
 *   * **Review routing.** `going_concern_doubt` and `restatement` are not
 *     descriptive; they say which checklist this file needs.
 *
 * ## Why every tag carries its reasoning
 *
 * A tag is a claim. `going_concern_doubt` on an engagement is a serious one,
 * and a reviewer has to be able to see what it was read from before acting on
 * it. So a row carries the rationale, the confidence and the source, and the
 * agent's tags land as *suggestions* — see `TAG_STATUSES`.
 */

/** The families a tag belongs to. Ordering is the order they are presented. */
export const TAG_CATEGORIES = [
  'stage',
  'revenue',
  'business_model',
  'capital_structure',
  'valuation_context',
  'risk',
] as const;
export type TagCategory = (typeof TAG_CATEGORIES)[number];

export const TAG_CATEGORY_LABELS: Readonly<Record<TagCategory, string>> = Object.freeze({
  stage: 'Stage',
  revenue: 'Revenue',
  business_model: 'Business model',
  capital_structure: 'Capital structure',
  valuation_context: 'Valuation context',
  risk: 'Risk',
});

/**
 * Who put a tag on the engagement.
 *
 * Kept even after a tag is accepted, because "the analyst concluded this" and
 * "the analyst agreed with the model" are different facts about the same row,
 * and only the first is evidence of independent judgement.
 */
export const TAG_SOURCES = ['manual', 'ai'] as const;
export type TagSource = (typeof TAG_SOURCES)[number];

/**
 * Where a tag stands.
 *
 * `rejected` is a stored state rather than a deletion, and that is what makes
 * re-running the agent safe. A rejected tag deleted is a tag the next run
 * proposes again, so an analyst who declined `dual_class_common` last month
 * declines it again this month, forever. The same argument
 * `replaceMachineComparables` makes for carrying include/exclude decisions
 * forward by ticker.
 */
export const TAG_STATUSES = ['suggested', 'accepted', 'rejected'] as const;
export type TagStatus = (typeof TAG_STATUSES)[number];

export interface TagDescriptor {
  slug: string;
  category: TagCategory;
  label: string;
  /** What the tag asserts — shown to the analyst, and given to the model. */
  definition: string;
}

/**
 * Every tag an engagement can carry.
 *
 * Deliberately not extensible at runtime. A per-firm vocabulary is a reasonable
 * thing to want and a bad thing to add first: the precedent query is only worth
 * running across a whole book of work, and a tag that means something different
 * in two firms' hands answers it wrongly while looking authoritative. If custom
 * tags are added later they want their own namespace and their own filter, not
 * a row alongside these.
 *
 * The definitions are load-bearing in two directions: they are the tooltip an
 * analyst reads before accepting a suggestion, and they are the specification
 * the model is given. One definition means the two cannot drift.
 */
export const TAG_CATALOGUE: readonly TagDescriptor[] = [
  // ── Stage ──────────────────────────────────────────────────────────────────
  {
    slug: 'pre_seed',
    category: 'stage',
    label: 'Pre-seed',
    definition: 'Founders and early hires only; no institutional priced round has closed.',
  },
  {
    slug: 'seed',
    category: 'stage',
    label: 'Seed',
    definition: 'A seed round has closed; the product is in market or close to it.',
  },
  {
    slug: 'series_a',
    category: 'stage',
    label: 'Series A',
    definition: 'A Series A is the most recent priced round.',
  },
  {
    slug: 'series_b',
    category: 'stage',
    label: 'Series B',
    definition: 'A Series B is the most recent priced round.',
  },
  {
    slug: 'series_c_plus',
    category: 'stage',
    label: 'Series C or later',
    definition: 'Series C or a later lettered round is the most recent priced round.',
  },
  {
    slug: 'growth_stage',
    category: 'stage',
    label: 'Growth stage',
    definition: 'Scaled operations funded by growth or crossover investors rather than by venture rounds.',
  },
  {
    slug: 'pre_ipo',
    category: 'stage',
    label: 'Pre-IPO',
    definition: 'A public offering is being prepared or has been formally contemplated.',
  },

  // ── Revenue ────────────────────────────────────────────────────────────────
  {
    slug: 'pre_revenue',
    category: 'revenue',
    label: 'Pre-revenue',
    definition: 'No revenue recognised in the most recent reported period.',
  },
  {
    slug: 'early_revenue',
    category: 'revenue',
    label: 'Early revenue',
    definition: 'Revenue exists but is immaterial to value, or is not yet repeatable.',
  },
  {
    slug: 'scaling_revenue',
    category: 'revenue',
    label: 'Scaling revenue',
    definition: 'Material and repeatable revenue growing materially year over year.',
  },
  {
    slug: 'profitable',
    category: 'revenue',
    label: 'Profitable',
    definition: 'Positive operating income in the most recent reported period.',
  },

  // ── Business model ─────────────────────────────────────────────────────────
  {
    slug: 'saas',
    category: 'business_model',
    label: 'SaaS',
    definition: 'Revenue is predominantly recurring software subscriptions.',
  },
  {
    slug: 'marketplace',
    category: 'business_model',
    label: 'Marketplace',
    definition: 'Revenue is a take rate on transactions between third parties.',
  },
  {
    slug: 'ecommerce',
    category: 'business_model',
    label: 'E-commerce',
    definition: 'Revenue is direct sale of goods to end customers.',
  },
  {
    slug: 'hardware',
    category: 'business_model',
    label: 'Hardware',
    definition: 'Revenue depends on manufacturing and shipping physical product.',
  },
  {
    slug: 'biotech',
    category: 'business_model',
    label: 'Biotech / pharma',
    definition: 'Value rests on a therapeutic pipeline and its regulatory milestones.',
  },
  {
    slug: 'medtech',
    category: 'business_model',
    label: 'Medical device',
    definition: 'Value rests on a device and its regulatory clearance pathway.',
  },
  {
    slug: 'fintech',
    category: 'business_model',
    label: 'Fintech',
    definition: 'The business holds, moves, lends or underwrites money.',
  },
  {
    slug: 'deeptech',
    category: 'business_model',
    label: 'Deep tech',
    definition: 'Value rests on unproven science or engineering rather than on commercial traction.',
  },
  {
    slug: 'consumer_app',
    category: 'business_model',
    label: 'Consumer app',
    definition: 'Revenue is from individual consumers, by subscription, advertising or in-app purchase.',
  },
  {
    slug: 'services',
    category: 'business_model',
    label: 'Services',
    definition: 'Revenue is predominantly people-delivered services rather than product.',
  },

  // ── Capital structure ──────────────────────────────────────────────────────
  {
    slug: 'common_only',
    category: 'capital_structure',
    label: 'Common only',
    definition: 'One class of common stock and no preferred outstanding.',
  },
  {
    slug: 'multi_preferred_stack',
    category: 'capital_structure',
    label: 'Multi-series preferred',
    definition: 'Three or more series of preferred stock are outstanding.',
  },
  {
    slug: 'participating_preferred',
    category: 'capital_structure',
    label: 'Participating preferred',
    definition: 'At least one preferred series participates after its preference is paid.',
  },
  {
    slug: 'dual_class_common',
    category: 'capital_structure',
    label: 'Dual-class common',
    definition: 'Two classes of common stock with different voting rights.',
  },
  {
    slug: 'convertibles_outstanding',
    category: 'capital_structure',
    label: 'Convertible notes outstanding',
    definition: 'Convertible debt is outstanding and unconverted at the valuation date.',
  },
  {
    slug: 'safes_outstanding',
    category: 'capital_structure',
    label: 'SAFEs outstanding',
    definition: 'SAFEs or advance subscription agreements are outstanding and unconverted.',
  },
  {
    slug: 'warrants_outstanding',
    category: 'capital_structure',
    label: 'Warrants outstanding',
    definition: 'Warrants over equity are outstanding at the valuation date.',
  },

  // ── Valuation context ──────────────────────────────────────────────────────
  {
    slug: 'recent_priced_round',
    category: 'valuation_context',
    label: 'Recent priced round',
    definition: 'A priced equity round closed within twelve months of the valuation date.',
  },
  {
    slug: 'no_recent_round',
    category: 'valuation_context',
    label: 'No recent round',
    definition: 'No priced round has closed within twelve months of the valuation date.',
  },
  {
    slug: 'down_round',
    category: 'valuation_context',
    label: 'Down round',
    definition: 'The most recent priced round was at a lower price than the one before it.',
  },
  {
    slug: 'roll_forward',
    category: 'valuation_context',
    label: 'Roll-forward',
    definition: 'The conclusion is carried from a prior appraisal rather than from a fresh round.',
  },
  {
    slug: 'secondary_activity',
    category: 'valuation_context',
    label: 'Secondary activity',
    definition: 'Secondary transactions in the company’s stock are known to have occurred.',
  },
  {
    slug: 'acquisition_interest',
    category: 'valuation_context',
    label: 'Acquisition interest',
    definition: 'A third party has made or indicated an offer to acquire the company.',
  },

  // ── Risk ───────────────────────────────────────────────────────────────────
  {
    slug: 'going_concern_doubt',
    category: 'risk',
    label: 'Going-concern doubt',
    definition: 'Runway, covenants or an auditor’s statement put continued operation in doubt.',
  },
  {
    slug: 'customer_concentration',
    category: 'risk',
    label: 'Customer concentration',
    definition: 'A single customer or a few customers account for most of revenue.',
  },
  {
    slug: 'regulatory_exposure',
    category: 'risk',
    label: 'Regulatory exposure',
    definition: 'The business needs a licence, clearance or approval it does not yet hold.',
  },
  {
    slug: 'litigation_pending',
    category: 'risk',
    label: 'Litigation pending',
    definition: 'Material litigation is outstanding against the company.',
  },
  {
    slug: 'key_person_dependency',
    category: 'risk',
    label: 'Key-person dependency',
    definition: 'The business depends materially on one or two named individuals.',
  },
  {
    slug: 'restatement',
    category: 'risk',
    label: 'Restatement',
    definition: 'Previously issued financial statements have been restated.',
  },
];

export const TAGS_BY_SLUG: ReadonlyMap<string, TagDescriptor> = new Map(
  TAG_CATALOGUE.map((t) => [t.slug, t]),
);

export function isTagSlug(value: unknown): value is string {
  return typeof value === 'string' && TAGS_BY_SLUG.has(value);
}

/**
 * Tags whose categories are mutually exclusive — at most one may be accepted.
 *
 * Stage and revenue are ladders: a company is at one rung. Two accepted stage
 * tags is not extra information, it is a contradiction that makes both the
 * filter and the precedent query wrong, and it is the state a re-run of the
 * agent would otherwise drift into as a company matures. The other four
 * categories are genuinely multi-valued — a fintech marketplace with warrants
 * and a participating stack is one company, not four.
 *
 * Enforced on acceptance rather than on suggestion: two competing *suggestions*
 * are useful, because they are exactly the judgement the analyst is being asked
 * to make.
 */
export const EXCLUSIVE_TAG_CATEGORIES: ReadonlySet<TagCategory> = new Set<TagCategory>([
  'stage',
  'revenue',
]);

/** An input problem the analyst has to fix — the route maps it to a 422. */
export class ValuationTagError extends Error {}

/** One tag as the agent's output maps to a row. */
export interface MappedTag {
  slug: string;
  confidence: number | null;
  rationale: string | null;
  /** The documents or fields the model says it read the tag from. */
  evidence: string[];
}

export interface MappedTagSet {
  tags: MappedTag[];
  /**
   * Slugs the model returned that are not in the catalogue, kept for the
   * response rather than silently discarded.
   *
   * A drop nobody can see is how a vocabulary quietly stops covering the book
   * of work: if the model keeps proposing `ai_infrastructure` and the platform
   * keeps eating it, the only signal is that the tags feel thin. Surfaced, it
   * is a request to extend the catalogue, which is a decision a person makes.
   */
  unknown: string[];
}

/** How many tags one run may write. A page of tags is not a classification. */
const MAX_TAGS = 12;

/** How far down a returned list to look. Bounds a pathological response. */
const SCAN_LIMIT = 60;

function str(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, limit);
}

function confidence(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * The agent's result document as tag rows.
 *
 * Mirrors `mapAgentComparables`: the mapping is pure, it is where every bound
 * is applied, and the route does the writing. A stored job can predate any of
 * these rules, so they are applied on read rather than trusted.
 *
 * The cap counts what survives rather than what was offered — the same
 * reasoning `company_profile._codes` documents. Truncating first would let
 * twelve invented slugs spend the whole budget and return nothing, reading as
 * "the documents did not classify this engagement" when the model in fact
 * proposed six usable tags after them.
 */
export function mapAgentTags(result: unknown): MappedTagSet {
  const doc = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const raw = Array.isArray(doc.tags) ? doc.tags : [];
  if (raw.length === 0) throw new ValuationTagError('The tagging run proposed no tags');

  const tags: MappedTag[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw.slice(0, SCAN_LIMIT)) {
    if (tags.length >= MAX_TAGS) break;
    const row = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const slug = str(row.slug, 64);
    if (slug === null || seen.has(slug)) continue;
    if (!TAGS_BY_SLUG.has(slug)) {
      // Bounded, and deduplicated against the same set: a response that
      // repeated one invented slug forty times would otherwise fill the
      // response body with it.
      seen.add(slug);
      if (unknown.length < MAX_TAGS) unknown.push(slug);
      continue;
    }
    seen.add(slug);
    tags.push({
      slug,
      confidence: confidence(row.confidence),
      rationale: str(row.rationale, 600),
      evidence: (Array.isArray(row.evidence) ? row.evidence : [])
        .slice(0, 8)
        .map((e) => str(e, 300))
        .filter((e): e is string => e !== null),
    });
  }

  if (tags.length === 0) {
    throw new ValuationTagError(
      unknown.length > 0
        ? `The tagging run proposed no tag in the catalogue — it returned ${unknown.join(', ')}`
        : 'The tagging run proposed no usable tags',
    );
  }
  return { tags, unknown };
}
