import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { StateTone } from '../lib/format';
import { STATE_LABELS, STATE_TONES, KIND_LABELS } from '../lib/format';
import type { ValuationKind, ValuationState } from '../lib/types';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-bond-600 text-bond-fg hover:bg-bond-700 active:bg-bond-800 shadow-card disabled:bg-ink-300',
  secondary:
    'border border-ink-200 bg-surface text-ink-800 hover:border-ink-400 hover:bg-paper-50 disabled:text-ink-300',
  ghost: 'text-ink-600 hover:bg-paper-200 hover:text-ink-900',
  danger: 'border border-red-200 bg-surface text-red-700 hover:bg-red-50',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      // `touch:min-h-11` — 44px under a finger. The designed height is 36px
      // (py-2 on a 14px line), which is comfortable for a cursor and under the
      // touch floor; a minimum rather than a fixed height so a button that
      // wraps to two lines still grows past it.
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors touch:min-h-11 disabled:cursor-not-allowed ${buttonStyles[variant]} ${className}`}
    />
  );
}

/**
 * Small contextual "?" that reveals a short explanation on hover/focus/click.
 * Accessible: a real button with an aria-label, and the bubble is wired via
 * aria-describedby while visible. Used for field-level tooltips (see `Field`'s
 * `tooltip` prop) and anywhere a term needs a one-line gloss.
 */
export function InfoTooltip({
  text,
  label = 'More information',
  className = '',
}: {
  text: ReactNode;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  /*
   * Which pointer, if any, put focus on the button — null means the keyboard
   * did.
   *
   * A tap fires the compatibility mouse events off the one gesture: enter,
   * then focus, then click. Hover-opens and focus-opens both fired before the
   * click toggled, so a tap opened the bubble and shut it again before the
   * finger left the glass, and the first tap on a "?" showed nothing at all.
   * These are the app's inline explanations of volatility, expected term and
   * the rest, so on a tablet every one of them needed two taps.
   *
   * Hover and focus-to-open are a mouse and a keyboard affordance
   * respectively. Suppressing both for a touch pointer leaves the click
   * toggle governing touch on its own, which is the behaviour the button
   * would have had if it had never listened for hover.
   */
  const focusedByPointer = useRef<string | null>(null);
  return (
    <span className={`relative inline-flex ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onPointerDown={(e) => {
          focusedByPointer.current = e.pointerType;
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') setOpen(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setOpen(false);
        }}
        onFocus={() => {
          if (focusedByPointer.current === null) setOpen(true);
        }}
        onBlur={() => {
          focusedByPointer.current = null;
          setOpen(false);
        }}
        onClick={(e) => {
          // Inside a <label> a bare click would toggle the field; keep it local.
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        /*
         * 16px drawn, 44px to a finger (`tap-area`). The circle is sized to sit
         * on a label's baseline beside its text, so the box cannot grow — and
         * at 16px it was the smallest target in the product. Fixing the toggle
         * for touch, as this button already had, only got a tap counted once
         * the tap landed.
         */
        className="tap-area flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-ink-300 text-[0.6rem] font-bold text-ink-400 transition-colors hover:border-bond-500 hover:text-bond-600 focus:ring-2 focus:ring-bond-600/30 focus:outline-none"
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="absolute bottom-full left-1/2 z-50 mb-1.5 w-56 -translate-x-1/2 rounded-md bg-chrome-900 px-3 py-2 text-xs leading-snug font-normal text-chrome-fg shadow-lift"
        >
          {text}
        </span>
      )}
    </span>
  );
}

export function Field({
  label,
  error,
  hint,
  tooltip,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  /** Optional one-line explanation shown via an InfoTooltip next to the label. */
  tooltip?: string;
  children: ReactNode;
}) {
  // Wire aria so screen readers announce validation errors (audit F-3 P2). The
  // control gets an id + aria-invalid + aria-describedby pointing at the error
  // (or hint) node, injected into the single child so call sites don't change.
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const labelId = `${fieldId}-label`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  // A field whose control comes with a sibling — a `<datalist>` behind a
  // suggestion box is the usual one — arrives here as an array, and the
  // single-child branch below simply skipped it: no id, no `aria-labelledby`.
  // Those inputs fell back to name-from-the-wrapping-label, which sweeps in the
  // hint, so a screen reader announced the model box as "Model OpenRouter model
  // id — leave empty to use the default fallback chain". The control is the
  // first element in the list by construction; the rest are its attachments.
  const childList = Children.toArray(children);
  const primary = childList.length > 1 ? childList.find((c) => isValidElement(c)) : children;

  let control: ReactNode = children;
  /*
   * Whether the control this field wraps is required, read off the control
   * itself rather than passed in beside it. 63 controls across the product
   * carry `required` and not one of them said so on the label, so a form was
   * only discoverable by submitting it and being told. Reading the attribute
   * means the marker cannot drift away from the rule it describes, and no call
   * site has to be edited to gain one.
   */
  let isRequired = false;
  if (isValidElement(primary)) {
    const child = primary as ReactElement<Record<string, unknown>>;
    const props = child.props;
    isRequired = props.required === true || props['aria-required'] === true;
    const existingDescribedBy = props['aria-describedby'] as string | undefined;
    // Name the control explicitly rather than leaning on the wrapping <label>.
    // A field with a tooltip puts an interactive <button> inside that label,
    // and name-from-a-wrapping-label stops at the nested control: every
    // tooltipped field on the platform computed an accessible name of "" —
    // announced by a screen reader as an unlabelled edit box. Pointing at the
    // label's own text span skips the tooltip trigger and is unambiguous.
    // An explicit name on the child still wins; the caller meant it.
    const named = props['aria-label'] !== undefined || props['aria-labelledby'] !== undefined;
    const wired = cloneElement(child, {
      id: (props.id as string | undefined) ?? fieldId,
      'aria-invalid': error ? true : props['aria-invalid'],
      'aria-describedby': [existingDescribedBy, describedBy].filter(Boolean).join(' ') || undefined,
      ...(named ? {} : { 'aria-labelledby': labelId }),
    });
    // `Children.toArray` has already keyed the siblings, so rebuilding the list
    // around the wired control does not provoke React's missing-key warning.
    control = childList.length > 1 ? childList.map((c) => (c === primary ? wired : c)) : wired;
  }

  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-[0.8rem] font-semibold text-ink-700">
        <span className="flex items-baseline">
          <span id={labelId}>{label}</span>
          {/* Outside the labelled span, and hidden: `required` on the control
              is already an implicit `aria-required`, so a screen reader
              announces the rule anyway — carrying the asterisk into the name
              would only make the field "Company name star". */}
          {isRequired && (
            <span aria-hidden="true" className="ml-0.5 text-red-600">
              *
            </span>
          )}
        </span>
        {tooltip && <InfoTooltip text={tooltip} label={`About ${label}`} />}
      </span>
      {control}
      {hint && !error && (
        <span id={hintId} className="mt-1 block text-xs text-ink-400">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className="mt-1 block text-xs font-medium text-red-600">
          {error}
        </span>
      )}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none';

/**
 * `ref` is declared explicitly rather than inherited: React 19 passes it
 * through as an ordinary prop, but `InputHTMLAttributes` does not include it,
 * so a caller that needs the DOM node (to place a caret, to focus on error)
 * could not ask for one without a type error.
 */
export function TextInput({
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

/**
 * The last entry in a picker whose server-side list was capped.
 *
 * Reviewer and partner pickers used to be filled by reading every matching row
 * on the platform, which is a query that gets slower for everyone as the
 * business grows. They are capped now — and a cap on a picker is only safe if
 * it is visible, because the failure it causes otherwise is silent: a reviewer
 * who is simply not in the list reads as a reviewer who cannot be assigned, and
 * nobody thinks to doubt a dropdown.
 *
 * Disabled so it cannot be chosen, and rendered last so it does not displace
 * the entry someone is reaching for.
 */
/**
 * The line under a list that stopped short of the book.
 *
 * Every list endpoint in this API is capped in SQL and reports `truncated`
 * alongside the rows, precisely so a page is not mistaken for the whole set —
 * the repos say so in as many words. Ten surfaces dropped the flag on the
 * floor and rendered the page as if it were everything, which is worse than an
 * uncapped query rather than better: a missing engagement reads as an
 * engagement that does not exist, and any figure the page derives from
 * `rows.length` becomes a wrong number stated with confidence rather than a
 * short list.
 *
 * `shown` is the rendered row count rather than the server's limit, because it
 * is the only figure that is true whatever the caller asked for, and it makes
 * no claim about the order the cap fell in.
 *
 * {@link PickerOverflowNote} is the same idea inside a `<select>`, where the
 * note has to be an `<option>` to appear at all.
 */
export function ListTruncationNote({
  truncated,
  shown,
  noun,
  hint,
}: {
  truncated: boolean;
  shown: number;
  noun: string;
  /** What the reader can do about it, when there is something. */
  hint?: string;
}) {
  if (!truncated) return null;
  return (
    <p className="mt-2 text-xs text-ink-500" data-testid="list-truncated">
      Showing {shown} {noun}. More exist than are listed{hint ? ` — ${hint}` : ''}.
    </p>
  );
}

export function PickerOverflowNote({ truncated }: { truncated: boolean }) {
  if (!truncated) return null;
  return (
    <option disabled value="">
      — more exist than are listed; filter to narrow the list —
    </option>
  );
}

/**
 * How many rows a long list renders before the reader asks for more.
 *
 * A hundred is far more than fits on a screen and far less than the caps the
 * API is willing to answer with — the grant register alone will hand back ten
 * thousand rows, and the conversation five.
 */
export const LIST_WINDOW_STEP = 100;

/**
 * A window over a list that the server capped somewhere the DOM cannot follow.
 *
 * `ListTruncationNote` is about the rows the *server* did not send. This is the
 * other end of the same problem: the rows it did. Every list endpoint here is
 * capped in SQL, but the caps are sized for the API — ten thousand grants, five
 * thousand messages — and a surface that maps straight over the response builds
 * a node per row per cell. Ten thousand grant rows is roughly two hundred
 * thousand nodes, and the tab does not render slowly so much as it stops: the
 * layout pass blocks the main thread, and every keystroke and click after it
 * queues behind that. Worse, the cost is paid by exactly the customer who has
 * the most at stake in the page working.
 *
 * A window is not virtualization — there is no scroll math and no measured row
 * height, and it does not try to be. It is the smaller claim that a reader who
 * has not asked for the ten-thousandth row should not have to wait for it, and
 * it holds without a dependency, without absolute positioning, and without the
 * find-in-page and screen-reader breakage that windowing-on-scroll brings.
 *
 * `edge` decides which end survives. A register is read from the top, so its
 * window keeps the head. A conversation is read from the bottom — the newest
 * message is the one somebody came for — so its window keeps the tail and the
 * control offers the *earlier* messages.
 */
export function useListWindow<T>(
  items: T[],
  { step = LIST_WINDOW_STEP, edge = 'head' }: { step?: number; edge?: 'head' | 'tail' } = {},
): {
  /** The rows to render. */
  shown: T[];
  /** How many are held back — 0 when everything is on screen. */
  hidden: number;
  /** Widen the window by one step. */
  showMore: () => void;
  step: number;
} {
  const [limit, setLimit] = useState(step);
  const hidden = Math.max(0, items.length - limit);
  const shown = useMemo(() => {
    if (hidden === 0) return items;
    return edge === 'head' ? items.slice(0, limit) : items.slice(items.length - limit);
  }, [items, limit, hidden, edge]);
  const showMore = useCallback(() => setLimit((n) => n + step), [step]);
  return { shown, hidden, showMore, step };
}

/**
 * The control that widens a {@link useListWindow}.
 *
 * It says how many are hidden rather than only offering a button, because
 * "Show more" over a list that looks complete is indistinguishable from a list
 * that *is* complete — the same failure `ListTruncationNote` exists to prevent,
 * one layer in. Renders nothing when nothing is held back, so a short list
 * carries no furniture.
 *
 * `aria-live` on the count: widening the window changes what is on screen
 * without moving focus, and a reader who cannot see the rows appear otherwise
 * has no signal that the button did anything.
 */
export function ShowMoreRows({
  hidden,
  step = LIST_WINDOW_STEP,
  noun,
  plural,
  onMore,
  label,
}: {
  hidden: number;
  step?: number;
  /** Singular, lowercase: "grant", "message". */
  noun: string;
  /** Override when the plural is not `noun + "s"`. */
  plural?: string;
  onMore: () => void;
  /** Override the button text — "Show earlier messages" for a conversation. */
  label?: string;
}) {
  if (hidden <= 0) return null;
  const many = plural ?? `${noun}s`;
  const word = hidden === 1 ? noun : many;
  const next = Math.min(step, hidden);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="show-more-rows">
      <Button variant="secondary" onClick={onMore}>
        {label ?? `Show ${next} more`}
      </Button>
      <span aria-live="polite" className="text-xs text-ink-500">
        {hidden} more {word} not shown
      </span>
    </div>
  );
}

const toneStyles: Record<StateTone, string> = {
  neutral: 'bg-paper-200 text-ink-600 ring-ink-200',
  progress: 'bg-sky-50 text-sky-800 ring-sky-200',
  attention: 'bg-amber-50 text-amber-800 ring-amber-200',
  success: 'bg-bond-50 text-bond-700 ring-bond-200',
  muted: 'bg-paper-200 text-ink-400 ring-ink-200 line-through decoration-ink-300',
};

export function StateBadge({ state }: { state: ValuationState }) {
  const tone = STATE_TONES[state] ?? 'neutral';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${toneStyles[tone]}`}
    >
      {STATE_LABELS[state] ?? state}
    </span>
  );
}

export function KindBadge({ kind }: { kind: ValuationKind }) {
  return (
    <span className="inline-flex items-center rounded border border-ink-200 bg-surface px-2 py-0.5 font-mono text-[0.7rem] font-semibold tracking-wide text-ink-700 uppercase">
      {KIND_LABELS[kind] ?? kind}
    </span>
  );
}

export function StatCard({
  label,
  value,
  accent = false,
  to,
}: {
  label: string;
  value: ReactNode;
  accent?: boolean;
  /** Makes the whole card a link to the cohort it counts. */
  to?: string;
}) {
  const body = (
    <>
      <div className="overline text-ink-400">{label}</div>
      <div
        className={`tnum mt-2 font-display text-3xl font-semibold ${accent ? 'text-bond-600' : 'text-ink-900'}`}
      >
        {value}
      </div>
    </>
  );
  const base = 'block rounded-lg border border-paper-300 bg-surface p-5 shadow-card';

  // A count nobody can act on is decoration. Where the caller knows the
  // worklist behind a number, the card carries the reader there.
  if (to) {
    return (
      <Link
        to={to}
        className={`${base} transition-shadow hover:border-bond-300 hover:shadow-lift focus-visible:ring-2 focus-visible:ring-bond-600/30 focus-visible:outline-none`}
      >
        {body}
      </Link>
    );
  }
  return <div className={base}>{body}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800"
    >
      {children}
    </div>
  );
}

/**
 * How many rows a search or filter left, announced.
 *
 * Typing in a filter box changes a list that the typist is not looking at and
 * never moves focus, so to a screen reader nothing happened at all: the result
 * count, the "no matches" state and the difference between a query that found
 * eleven rows and one that found none were all silent. `Spinner` announces the
 * *wait* on the surfaces that fetch, which made it worse — the user heard
 * "Loading…" and then nothing, with no way to tell a finished search from a
 * stuck one short of leaving the box and reading the table. WCAG 2.2 SC 4.1.3.
 *
 * Two details carry the whole thing:
 *
 * - It is always mounted, and only its text changes. A live region that is
 *   inserted into the DOM already holding its message is commonly not
 *   announced at all — the region has to be observed before the mutation it is
 *   reporting. So render it unconditionally beside the input, not inside the
 *   branch that renders results.
 * - It is `sr-only`. The count is already on screen in the section headings;
 *   this is the same fact routed to the people the headings do not reach.
 *
 * `polite` rather than `assertive`: it must never cut across the character the
 * user is still typing. Rapid changes coalesce to the latest, which is exactly
 * the behaviour a per-keystroke filter wants.
 */
export function ResultCount({
  count,
  noun,
  plural,
  query,
}: {
  /**
   * `null` means "no answer yet" — a fetch in flight, or a query too short to
   * run. The region still renders, empty. Skipping the element instead would
   * mount it already holding its message, which is the case screen readers
   * commonly do not announce.
   */
  count: number | null;
  /** Singular, lowercase: "valuation", "help article", "field". */
  noun: string;
  /** Override when the plural is not `noun + "s"` — "entries", "people". */
  plural?: string;
  /** The query these results are for, quoted back so the answer names its question. */
  query?: string;
}) {
  const many = plural ?? `${noun}s`;
  const q = query?.trim();
  let message = '';
  if (count !== null) {
    if (count === 0) message = q ? `No ${many} match “${q}”` : `No ${many}`;
    else {
      const word = count === 1 ? noun : many;
      message = q ? `${count} ${word} matching “${q}”` : `${count} ${word}`;
    }
  }
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-paper-50 px-6 py-14 text-center">
      <p className="font-display text-lg text-ink-700">{title}</p>
      {children && <div className="mt-3 text-sm text-ink-400">{children}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  // role=status + an sr-only label so non-sighted users hear the load (F-3 P3).
  return (
    <div role="status" aria-live="polite" className="flex justify-center py-16">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-ink-200 border-t-bond-600" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/*
 * ── Skeletons ───────────────────────────────────────────────────────────────
 *
 * A spinner says "wait"; a skeleton says "wait, and here is what is coming".
 * On the pages that carry the product — the worklist, the dashboard, a
 * valuation workspace — a centred spinner on an otherwise empty page also
 * throws away the layout twice: once when it replaces the page, once when the
 * page replaces it. The placeholders below hold the real geometry, so the
 * arriving content lands where the reader is already looking instead of
 * shoving the viewport around.
 *
 * They are for structure that is *known before the data arrives* — a table of
 * ~n rows, a row of five stat cards. Where the shape genuinely depends on the
 * response (a form whose fields come from a schema, a three-line panel), the
 * honest placeholder is still `Spinner`, and those call sites keep it.
 */

/**
 * One placeholder block. Decorative by construction: `aria-hidden`, because a
 * screen reader gains nothing from thirty pulsing rectangles. The announcement
 * belongs to `LoadingBlock`, which makes it exactly once.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`skeleton block rounded ${className}`} />;
}

/**
 * Accessible wrapper for a group of `Skeleton`s: one polite live region and one
 * sr-only label for the whole placeholder, plus `aria-busy` so assistive tech
 * knows the region is mid-update rather than empty.
 */
export function LoadingBlock({
  label = 'Loading…',
  className = '',
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

// Line lengths cycle rather than randomise. Math.random() would reshuffle on
// every render — which reads as flicker, not texture — and would make any test
// that asserts on the markup non-deterministic.
const LINE_WIDTHS = ['w-4/5', 'w-3/5', 'w-11/12', 'w-2/3', 'w-3/4', 'w-1/2'];

/** `lines` placeholder text rows of varying length, at body-copy rhythm. */
export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden className={`block space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3.5 ${LINE_WIDTHS[i % LINE_WIDTHS.length]}`} />
      ))}
    </span>
  );
}

/** Placeholder matching `StatCard`'s box, label and figure. */
export function StatCardSkeleton() {
  return (
    <div aria-hidden className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
      <Skeleton className="h-2.5 w-20" />
      <Skeleton className="mt-3.5 h-7 w-14" />
    </div>
  );
}

/**
 * The table picture itself, with no live region of its own — so it can be
 * composed into a larger skeleton without announcing a second time. Marked
 * `aria-hidden` and `role="presentation"`: announcing eight empty rows to a
 * screen reader would be a lie about content. Use `TableSkeleton` when the
 * table is the whole of what is loading; use this when it is one part of a
 * larger placeholder that already carries the announcement.
 */
export function SkeletonTable({ columns = 5, rows = 6 }: { columns?: number; rows?: number }) {
  return (
    <div className="overflow-x-auto overscroll-x-contain">
      <table role="presentation" aria-hidden className="w-full border-collapse text-sm">
        <tbody>
          <tr className="border-b border-paper-300">
            {Array.from({ length: columns }, (_, c) => (
              <td key={c} className="px-3 py-2.5">
                <Skeleton className="h-2.5 w-16" />
              </td>
            ))}
          </tr>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className="border-b border-paper-200 last:border-0">
              {Array.from({ length: columns }, (_, c) => (
                <td key={c} className="px-3 py-2.5">
                  <Skeleton className={`h-4 ${LINE_WIDTHS[(r + c) % LINE_WIDTHS.length]}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Placeholder matching `DataTable`'s geometry — same paddings, same rules, a
 * real `<table>` so the columns distribute the way the loaded one will.
 */
export function TableSkeleton({
  columns = 5,
  rows = 6,
  label = 'Loading rows…',
}: {
  columns?: number;
  rows?: number;
  label?: string;
}) {
  return (
    <LoadingBlock label={label}>
      <SkeletonTable columns={columns} rows={rows} />
    </LoadingBlock>
  );
}

/** One list row: a title line, `lines - 1` meta lines, `badges` pills at the end. */
function SkeletonListRow({
  index,
  lines,
  badges,
  className,
}: {
  index: number;
  lines: number;
  badges: number;
  className: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${className}`}>
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-48 max-w-full" />
        {Array.from({ length: Math.max(0, lines - 1) }, (_, i) => (
          <Skeleton key={i} className={`h-3 ${LINE_WIDTHS[(index + i) % LINE_WIDTHS.length]}`} />
        ))}
      </div>
      {Array.from({ length: badges }, (_, b) => (
        <Skeleton key={b} className="h-5 w-20 rounded-full" />
      ))}
    </div>
  );
}

/**
 * The card-list picture: `rows` separately bordered cards at `space-y-3`.
 * Matches the geometry several of the app's list surfaces actually use — the
 * dashboard's recent valuations, the change-log entries, grants — which are
 * cards, not tables. No live region of its own, for the same reason as
 * `SkeletonTable`: it composes into a larger placeholder.
 */
export function SkeletonCardList({
  rows = 4,
  lines = 2,
  badges = 0,
  className = '',
}: {
  rows?: number;
  lines?: number;
  badges?: number;
  className?: string;
}) {
  return (
    <div aria-hidden className={`space-y-3 ${className}`}>
      {Array.from({ length: rows }, (_, r) => (
        <SkeletonListRow
          key={r}
          index={r}
          lines={lines}
          badges={badges}
          className="rounded-lg border border-paper-300 bg-surface px-5 py-4 shadow-card"
        />
      ))}
    </div>
  );
}

/**
 * The other list shape in use: one bordered box with rules between the rows,
 * rather than separate cards. Documents and review tasks are drawn this way,
 * and a `SkeletonCardList` behind them would draw n shadows where the loaded
 * list has one.
 */
export function SkeletonDividedList({
  rows = 4,
  lines = 2,
  badges = 0,
  className = '',
}: {
  rows?: number;
  lines?: number;
  badges?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`divide-y divide-paper-300 rounded-lg border border-paper-300 bg-surface shadow-card ${className}`}
    >
      {Array.from({ length: rows }, (_, r) => (
        <SkeletonListRow key={r} index={r} lines={lines} badges={badges} className="px-5 py-4" />
      ))}
    </div>
  );
}

/**
 * A row of bare label/figure pairs — the `<dl>` summary strips that head the
 * change log and the health tab, which are unboxed and so would sit wrong
 * behind `StatCardSkeleton`'s bordered card.
 */
export function SkeletonStatStrip({ count = 4, className = '' }: { count?: number; className?: string }) {
  return (
    <div aria-hidden className={`grid grid-cols-2 gap-4 sm:grid-cols-4 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <Skeleton className="h-2.5 w-24 max-w-full" />
          <Skeleton className="mt-2 h-6 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * Route-level fallback for a page chunk that has not downloaded yet — a page
 * heading and a body block, at the position the real page's heading occupies.
 * Used inside the app shell (see AppLayout), so the sidebar stays put while a
 * lazily-imported page arrives.
 */
export function PageSkeleton({ label = 'Loading page…' }: { label?: string }) {
  return (
    <LoadingBlock label={label}>
      <Skeleton className="h-2.5 w-24" />
      <Skeleton className="mt-3 h-8 w-72 max-w-full" />
      <Skeleton className="mt-3 h-3.5 w-96 max-w-full" />
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      <div className="mt-8 rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
        <SkeletonTable columns={4} rows={5} />
      </div>
    </LoadingBlock>
  );
}

/**
 * What Tab stops on inside a trapped overlay.
 *
 * `:not([tabindex="-1"])` is on every clause, not only the last. The intent
 * was always there — the `[tabindex]` clause carried it — but `button`,
 * `input`, `a[href]` and friends did not, and `tabindex="-1"` is exactly how
 * an element says "focus me from code, do not stop here on Tab". The command
 * palette is the case that showed it: its result rows are buttons marked
 * `tabindex="-1"` because the highlight is `aria-activedescendant` and DOM
 * focus has to stay in the search box. Tab walked into them anyway, one row
 * at a time, breaking the mechanism announcing the highlight — and the strip
 * is as long as the search result set.
 */
/**
 * How many overlays currently hold the page still, and how to give it back.
 *
 * Module-level rather than per-hook because the lock is a property of the
 * document, not of any one dialog, and more than one can be open at a time:
 * the command palette answers ⌘K from anywhere, including from on top of a
 * `Modal`, and a `HelpIcon` sits next to section headers that live inside
 * dialogs. Two independent locks that each reset the style on close means the
 * *first* one to close hands the page back while the second is still covering
 * it — a bug that only appears when two overlays overlap, which is exactly the
 * case nobody exercises by hand. Counting is what makes the last one out the
 * one that unlocks.
 */
let scrollLockCount = 0;
let releaseScrollLock: (() => void) | null = null;

/**
 * Holds the document still while an overlay covers it.
 *
 * Every full-viewport overlay in the product — `Modal`, the help slide-over,
 * the command palette — paints a backdrop over the page and then lets the page
 * keep scrolling underneath it. The wheel over the backdrop scrolls the list
 * behind the dialog; on a touch screen a drag anywhere does, and so does a
 * flick inside the dialog's own scroll area once it reaches its end, because
 * scrolling chains to the nearest scrollable ancestor. The reader closes the
 * dialog and is somewhere else in the list than where they opened it, with
 * nothing on screen having explained the move.
 *
 * The lock is `overflow: hidden` on both the root element and the body. Both,
 * because which of the two is the viewport's scrolling box depends on the
 * document, and setting only one leaves engines that chose the other still
 * scrolling. The previous *inline* values are captured and put back rather
 * than blanked, so a caller that had set its own `overflow` still has it
 * afterwards.
 *
 * Hiding the scrollbar frees the width it occupied, and the page behind the
 * backdrop jumps a scrollbar's width wider the moment a dialog opens. The
 * gutter is measured and held open with matching padding — but only when the
 * document reports a width at all. Under jsdom `clientWidth` is 0, so the
 * naive subtraction reads the whole viewport as scrollbar and pads the body by
 * a thousand pixels; a measurement of zero is not a measurement.
 *
 * Containment on the overlays themselves is the other half — the class is on
 * each scrim and on each scroll area under it: the lock stops the page
 * scrolling, and containment stops a gesture inside the dialog from being
 * handed to it in the first place.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (scrollLockCount++ === 0) {
      const root = document.documentElement;
      const { body } = document;
      const previous = {
        rootOverflow: root.style.overflow,
        bodyOverflow: body.style.overflow,
        bodyPaddingRight: body.style.paddingRight,
      };
      const documentWidth = root.clientWidth;
      const gutter = documentWidth > 0 ? window.innerWidth - documentWidth : 0;
      root.style.overflow = 'hidden';
      body.style.overflow = 'hidden';
      if (gutter > 0) body.style.paddingRight = `${gutter}px`;
      releaseScrollLock = () => {
        root.style.overflow = previous.rootOverflow;
        body.style.overflow = previous.bodyOverflow;
        body.style.paddingRight = previous.bodyPaddingRight;
      };
    }
    return () => {
      if (--scrollLockCount === 0) {
        releaseScrollLock?.();
        releaseScrollLock = null;
      }
    };
  }, [active]);
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]',
]
  .map((clause) => `${clause}:not([tabindex="-1"])`)
  .join(', ');

/**
 * Focus-trap for overlays (audit F-3 P2). While `active`, keeps Tab/Shift+Tab
 * cycling inside the referenced element, moves focus in on activate and restores
 * it to the trigger on deactivate, and calls `onEscape` on the Esc key. Attach
 * the returned ref to the dialog container.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape: () => void,
): React.RefObject<T | null> {
  return useDialogBehaviour<T>(active, onEscape, true);
}

/**
 * The same dialog behaviour, minus the claim that the rest of the page is gone.
 *
 * A dialog that marks itself modal is not decorating itself; it is instructing
 * assistive technology to drop everything outside the dialog from the virtual
 * buffer. The Tab trap is the keyboard half of the same claim. Both are
 * correct for an overlay that paints a scrim over the document — nothing
 * outside it can be clicked either, so no group loses anything the others
 * keep.
 *
 * They were also on two surfaces that paint no scrim: the help widget, a
 * corner panel whose entire purpose is to be read *beside* the form it
 * explains, and the cookie gate, a strip along the bottom of the marketing
 * site on a first visit. In both, a mouse user goes on using the page — every
 * control behind is live and clickable — while a screen-reader user is shut
 * out of the whole application until they close it. The one group that most
 * needs the reference open next to the work is the only group forbidden to
 * have it, and on the marketing site the first thing a first visit does is
 * make the site unreadable.
 *
 * So: focus moves in on open, `Esc` dismisses, focus returns to the trigger on
 * close — and `Tab` walks out into the page, because the page is still there.
 */
export function useDialogDismiss<T extends HTMLElement>(
  active: boolean,
  onDismiss: () => void,
): React.RefObject<T | null> {
  return useDialogBehaviour<T>(active, onDismiss, false);
}

function useDialogBehaviour<T extends HTMLElement>(
  active: boolean,
  onEscape: () => void,
  trap: boolean,
): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  /*
   * The escape handler is read through a ref rather than depended on directly.
   * Every caller passes an inline arrow — `onClose={() => setConverting(null)}`
   * — so a dependency on it re-ran this effect on every render of the parent
   * while the overlay was open. Each re-run tore the trap down (restoring focus
   * to the trigger, outside the dialog) and set it up again (focusing the first
   * control in it), so any state the dialog owned stole focus as it changed:
   * picking a valuation type in the convert-to-engagement dialog dropped the
   * user back into the company-name box, and a caret placed mid-word jumped to
   * the end on the next keystroke. The trap should install once per opening,
   * which is what `[active]` alone says.
   */
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const container = ref.current;

    const focusable = (): HTMLElement[] =>
      container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

    (focusable()[0] ?? container)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        escapeRef.current();
        return;
      }
      if (!trap || e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        container?.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement;
      /*
       * Focus outside the dialog is the case that made this a trap in name
       * only. A browser drops focus to <body> whenever the focused element
       * stops being focusable under it — a button that disables itself while
       * the request is in flight, a row that re-renders away — and from <body>
       * the next Tab went to the first control on the page *behind* the
       * overlay. Wherever focus has ended up, Tab belongs back inside.
       */
      if (!container || !activeEl || !container.contains(activeEl)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (activeEl === first || activeEl === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreFocusRef.current?.focus?.();
    };
  }, [active, trap]);

  return ref;
}

/**
 * Accessible modal dialog (audit F-3 P2): `role="dialog"` + `aria-modal`, a focus
 * trap (Tab/Shift+Tab cycle within), `Esc` to close, focus moved in on open and
 * restored to the trigger on close, and a backdrop click to dismiss.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  labelledBy,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  labelledBy?: string;
  className?: string;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(open, onClose);
  useScrollLock(open);
  const titleId = useId();

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-chrome-950/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
        tabIndex={-1}
        className={`max-h-[85vh] w-full max-w-lg overflow-y-auto overscroll-y-contain rounded-xl border border-paper-300 bg-surface shadow-lift focus:outline-none ${className}`}
      >
        {title && (
          <h2
            id={titleId}
            className="border-b border-paper-200 px-5 py-4 font-display text-lg font-semibold text-ink-900"
          >
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface Column<T> {
  /** Stable key; also used as the React key for the cell. */
  key: string;
  header: ReactNode;
  /** Cell renderer; defaults to `String(row[key])`. */
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Extra classes on the <td>/<th> (e.g. column width, hide-on-mobile). */
  className?: string;
}

const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

/**
 * Shared semantic table primitive (audit F-4 P3): each list page re-implemented
 * its own `<table>`. One accessible table (scoped `<th>`, a required caption, an
 * empty-state row) that scrolls horizontally inside its own container so the
 * page body never scrolls sideways on mobile.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty = 'Nothing to show.',
  onRowClick,
  rowHref,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /**
   * The table's accessible name. Required, not optional: this is the one
   * table on the platform that had a name available and let a caller skip it,
   * and a screen reader announces the result as "table" — indistinguishable
   * from the next table on the page.
   */
  caption: string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /**
   * Where the row leads, for the keyboard.
   *
   * `onRowClick` alone makes the whole row clickable, which is a mouse-only
   * affordance: a `<tr onClick>` is not focusable and has no key binding, so
   * the rows of a table whose only way in was the row click could not be
   * opened at all without a pointer. Given this, the first column's content
   * becomes a real link — the row click stays as the convenience it was.
   */
  rowHref?: (row: T) => string;
}) {
  return (
    <div className="overflow-x-auto overscroll-x-contain">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-paper-300 text-left">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`px-3 py-2.5 text-xs font-semibold tracking-wide text-ink-500 uppercase ${alignClass[col.align ?? 'left']} ${col.className ?? ''}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-ink-400">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-b border-paper-200 last:border-0 ${
                  onRowClick ? 'cursor-pointer hover:bg-paper-50' : ''
                }`}
              >
                {columns.map((col, colIndex) => {
                  const content = col.render
                    ? col.render(row)
                    : String((row as Record<string, unknown>)[col.key] ?? '');
                  return (
                    <td
                      key={col.key}
                      className={`px-3 py-2.5 text-ink-800 ${alignClass[col.align ?? 'left']} ${col.className ?? ''}`}
                    >
                      {rowHref && colIndex === 0 ? (
                        <Link
                          to={rowHref(row)}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-bond-600/40 focus-visible:outline-none"
                        >
                          {content}
                        </Link>
                      ) : (
                        content
                      )}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Total number of pages for `total` items at `pageSize` (min 1). */
export function pageCountOf(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Shared pagination control (audit F-4 P3). 1-indexed; disables Prev/Next at the
 * ends and renders as a labelled <nav> so it's reachable by assistive tech.
 *
 * The control also drags an out-of-range owner back into range, because a list
 * that shrank under a reader who had paged into it is otherwise a dead end.
 * Nothing clamps `page` server-side — `domain/pagination.ts` is explicit that a
 * page past the end "matches nothing and the route answers with an empty list"
 * — so the only thing standing between a reader and a permanently empty screen
 * is this component, and until now it failed at that in both directions:
 *
 *   - `page` past a *multi-page* count rendered "Page 4 of 4" over a list
 *     fetched at page 99. The label was clamped; the fetch was not, so the
 *     control confidently described a page whose rows were never requested.
 *   - `page` past a count that collapsed to *one* page hid the control
 *     entirely, which removes the only affordance that could have walked the
 *     reader back. On a screen that reloads itself — the job monitor polls
 *     every 15 seconds — that empty page never repairs itself.
 *
 * Both are the same missing step: tell the owner. `onPage(clamped)` re-runs the
 * owner's fetch at a page that exists, so the label and the rows agree again.
 * It settles in one pass — once the owner adopts `clamped`, `page === clamped`
 * and the effect stops — and it is safe to run before the early return because
 * a collapsed list needs the correction *most* precisely when the control is
 * about to render nothing.
 */
export function Pagination({
  page,
  pageCount,
  onPage,
  className = '',
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  className?: string;
}) {
  const clamped = Math.min(Math.max(page, 1), Math.max(pageCount, 1));
  useEffect(() => {
    if (page !== clamped) onPage(clamped);
  }, [page, clamped, onPage]);
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Pagination" className={`flex items-center justify-between gap-4 text-sm ${className}`}>
      <Button
        variant="secondary"
        onClick={() => onPage(clamped - 1)}
        disabled={clamped <= 1}
        aria-label="Previous page"
      >
        Previous
      </Button>
      <span aria-live="polite" className="text-ink-500">
        Page {clamped} of {pageCount}
      </span>
      <Button
        variant="secondary"
        onClick={() => onPage(clamped + 1)}
        disabled={clamped >= pageCount}
        aria-label="Next page"
      >
        Next
      </Button>
    </nav>
  );
}

const toastTone = {
  success: 'border-bond-200 bg-bond-50 text-bond-800',
  error: 'border-red-200 bg-red-50 text-red-800',
  info: 'border-ink-200 bg-surface text-ink-800',
} as const;

/**
 * Lightweight controlled toast (audit F-4 P3). Announces via `role=status`
 * (errors as `alert`) and auto-dismisses after `duration` ms; the parent owns
 * visibility so it stays trivially testable without a global provider.
 */
export function Toast({
  message,
  tone = 'info',
  onDismiss,
  duration = 4000,
}: {
  message: ReactNode;
  tone?: keyof typeof toastTone;
  onDismiss?: () => void;
  duration?: number;
}) {
  useEffect(() => {
    if (!onDismiss || duration <= 0) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [onDismiss, duration, message]);

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border px-4 py-2.5 text-sm font-medium shadow-lift ${toastTone[tone]}`}
    >
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="tap-area rounded p-0.5 text-current/60 hover:text-current"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M5 5l14 14M19 5L5 19" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Wraps a region of write controls so one condition closes all of them.
 *
 * A `fieldset` rather than a `disabled`/`readOnly` prop threaded through every
 * control inside: `disabled` on a fieldset is inherited natively by every
 * button, input, select and textarea beneath it — including the ones somebody
 * adds next year without reading this comment. That is the whole point. The
 * valuation workspace has twenty-five tabs of write UI, and a policy of
 * "remember to pass the prop" is a policy that a control which forgot is
 * indistinguishable from one deliberately left open.
 *
 * `display: contents` keeps the fieldset out of layout, so wrapping an
 * existing region moves nothing on screen. The browser's disabled inheritance
 * is a DOM relationship, not a layout one, so it survives that.
 *
 * What this does NOT close, and what still needs its own check beside it:
 * anchors and `Link`s, and anything hung off an `onClick` on a non-form
 * element. A `fieldset` has no opinion about those.
 *
 * WHERE IT MAY GO. It is flow content, so it goes wherever a `div` would and
 * nowhere a `div` would not: inside a `td`, never between `tr` and `td`;
 * inside a `div`, never inside a `span`. `display: contents` makes both of the
 * wrong ones *look* right, which is the reason to say so here — the layout is
 * the last thing that would tell you.
 */
export function WriteGate({
  closed,
  className = '',
  children,
}: {
  closed: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset disabled={closed} className={`contents ${className}`.trim()}>
      {children}
    </fieldset>
  );
}
