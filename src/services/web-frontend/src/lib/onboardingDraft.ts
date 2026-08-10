import type { DocumentKind } from './pipeline';
import type { Valuation } from './types';

/**
 * Where the client onboarding wizard is up to, kept across a page load.
 *
 * The funnel held every step in React state, and one of its own steps navigates
 * away from the page: "Pay now with card" does `window.location.assign` to
 * Stripe. Coming back — success, cancel, or the browser back button — the
 * component remounts at step 1 with `valuation` null, and the client is looking
 * at an empty "Company legal name" field. The engagement they created a minute
 * ago still exists; the wizard has simply forgotten it. The obvious thing to do
 * from there is type the name again, which creates a *second* valuation, and
 * ops then has two records for one client and no way to tell which the payment
 * attached to. A refresh, a phone locking, or a tab restored after a crash all
 * land in the same place.
 *
 * So the draft is written after every step that changes something, and read
 * back on mount.
 *
 * `sessionStorage`, not `localStorage`: the Stripe round trip stays in the same
 * tab, so session storage is enough to survive it, and it does not leave a
 * half-finished request on a shared machine after the tab is closed. Cleared
 * outright when the wizard finishes.
 *
 * Every read is defensive. This is data the user's own browser can have
 * corrupted, downgraded, or half-written, and the failure mode has to be "start
 * fresh" — never a wizard stuck on a step it cannot render.
 */

export const ONBOARDING_DRAFT_KEY = 'n409.onboarding.draft';

/** Bumped when the shape changes; a draft from an older shape is discarded. */
const DRAFT_VERSION = 1;

/** The last step index the wizard has; a stored step is clamped to it. */
export const LAST_STEP = 3;

export interface OnboardingDraft {
  version: number;
  step: number;
  valuation: Valuation;
  /** Document kind → filenames already accepted, for the checklist ticks. */
  uploaded: Partial<Record<DocumentKind, string[]>>;
  /** Sticky note from the payment step ("we'll invoice you instead"). */
  paymentNote?: string | null;
  /** When it was written — a stale draft is not resumed. See MAX_AGE_MS. */
  savedAt: number;
}

/**
 * How long a draft is worth resuming.
 *
 * Long enough to cover a Stripe checkout, a phone call, and a coffee; short
 * enough that "continue where you left off" never means a form from a previous
 * visit the client has forgotten making. A day is the honest span for a session
 * that is, by construction, one sitting.
 */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isValuation(value: unknown): value is Valuation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Valuation>;
  // Only what the wizard actually uses to render and to address the API. A
  // stricter check would reject a draft over a field the server later added.
  return (
    typeof candidate.id === 'string' &&
    candidate.id !== '' &&
    typeof candidate.company_name === 'string' &&
    typeof candidate.kind === 'string'
  );
}

function isUploadMap(value: unknown): value is Partial<Record<DocumentKind, string[]>> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (names) => Array.isArray(names) && names.every((name) => typeof name === 'string'),
  );
}

/** The stored draft, or null if there is none worth resuming. */
export function loadDraft(now: number = Date.now()): OnboardingDraft | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(ONBOARDING_DRAFT_KEY);
  } catch {
    // Safari in private mode throws on storage access. No draft, no error.
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearDraft();
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    clearDraft();
    return null;
  }

  const draft = parsed as Partial<OnboardingDraft>;
  if (draft.version !== DRAFT_VERSION || !isValuation(draft.valuation)) {
    clearDraft();
    return null;
  }
  if (typeof draft.savedAt !== 'number' || now - draft.savedAt > MAX_AGE_MS) {
    clearDraft();
    return null;
  }

  // A step outside the wizard is clamped rather than rejected: the valuation is
  // real and resuming at the nearest legitimate screen beats starting over.
  const step = typeof draft.step === 'number' && Number.isFinite(draft.step) ? draft.step : 0;
  return {
    version: DRAFT_VERSION,
    step: Math.min(Math.max(Math.trunc(step), 0), LAST_STEP),
    valuation: draft.valuation,
    uploaded: isUploadMap(draft.uploaded) ? draft.uploaded : {},
    paymentNote: typeof draft.paymentNote === 'string' ? draft.paymentNote : null,
    savedAt: draft.savedAt,
  };
}

/**
 * Writes the draft. Never throws — a wizard that cannot save its place must
 * still work, and a quota error mid-funnel would otherwise blank the screen.
 */
export function saveDraft(
  draft: Omit<OnboardingDraft, 'version' | 'savedAt'>,
  now: number = Date.now(),
): void {
  try {
    sessionStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({ ...draft, version: DRAFT_VERSION, savedAt: now } satisfies OnboardingDraft),
    );
  } catch {
    /* storage unavailable or full — the wizard carries on in memory */
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(ONBOARDING_DRAFT_KEY);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}
