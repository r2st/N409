/**
 * Engagement tags — the client's view of `domain/valuationTags.ts`.
 *
 * Types only, and that is the whole design. The *vocabulary* is deliberately
 * absent: the valuation service ships the catalogue on every read
 * (`GET /tag-catalogue`, and inline on `GET /valuations/:id/tags`) because the
 * same structure is what the `tagging` agent is handed as its specification,
 * and a second copy here would be correct the day it was written and silently
 * wrong the first time a tag was added upstream — with no symptom but a picker
 * missing an option nobody noticed was missing.
 *
 * Mirroring the shape is safe in a way mirroring the list is not: a field that
 * disappears fails the build, whereas a slug that disappears fails nothing.
 */

/** `manual` — an analyst concluded it. `ai` — the tagging agent proposed it. */
export type TagSource = 'manual' | 'ai';

/**
 * `suggested` is the state that makes the rest coherent: everything the agent
 * proposes lands here and nothing acts on it, so a model's classification never
 * becomes a claim the firm is making without a person deciding it.
 */
export type TagStatus = 'suggested' | 'accepted' | 'rejected';

/** One stored tag, with its catalogue entry resolved onto it by the server. */
export interface ValuationTag {
  slug: string;
  label: string;
  definition: string | null;
  category: string | null;
  /**
   * False for a slug that has left the catalogue since it was written. The row
   * still records a decision somebody made, so it is rendered rather than
   * dropped — see `presentValuationTag` in the valuation service.
   */
  known: boolean;
  source: TagSource;
  status: TagStatus;
  /** 0–1 from the agent; null on a tag an analyst added by hand. */
  confidence: number | null;
  rationale: string | null;
  /** Documents or fields the model says it read the tag from. */
  evidence: string[] | null;
  decided_at: string | null;
  created_at: string;
}

/** One catalogue group as `tagCataloguePayload()` serves it. */
export interface TagCatalogueCategory {
  category: string;
  label: string;
  /** At most one *accepted* tag from this group — `stage` and `revenue`. */
  exclusive: boolean;
  tags: Array<{ slug: string; label: string; definition: string }>;
}
