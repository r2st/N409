/**
 * Field-level validation for the hand-written forms.
 *
 * Every form on the platform is plain `useState` — there is no form library —
 * and each one had reinvented some part of "tell the user what is wrong". The
 * shapes that had accumulated were: nothing at all (the control carries
 * `required` and the form carries `noValidate`, so neither the browser nor the
 * page ever checks); a single `ErrorNote` above the form saying "Password must
 * be at least 10 characters" with no indication of which box; and the server's
 * 422 rendered after a round trip. None of them put a message next to the field
 * it is about, and none of them said anything until submit.
 *
 * `Field` (components/ui) has taken an `error` prop and wired `aria-invalid` /
 * `aria-describedby` for a while. What was missing is the state that decides
 * *when* a message is allowed to appear, which is the part that is easy to get
 * wrong: validating on every keystroke tells someone their email is invalid
 * while they are still typing the local part.
 *
 * The rule this implements is the conventional one:
 *
 *   - A field is checked continuously, but its message stays hidden until the
 *     field has been blurred once, or the form has been submitted once.
 *   - After that it updates live, so a correction clears the message as soon as
 *     the value is good rather than on the next blur.
 *   - Submitting reveals every message at once and does not call the handler.
 *
 * Validators are pure functions of the whole value object, so a rule that spans
 * two fields (confirm-password) is written the same way as one that does not.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';

/** Returns a message when the values are wrong for this field, else null. */
export type Validator<V> = (values: V) => string | null;
export type Rules<V> = Partial<Record<keyof V, Validator<V>>>;

export interface FormValidation<V> {
  /** The message to hand `Field`'s `error` prop — undefined while hidden. */
  errorFor: (key: keyof V) => string | undefined;
  /** `onBlur` for the control; reveals this field's message. */
  blurHandler: (key: keyof V) => () => void;
  /**
   * Wraps a submit handler: prevents the default, reveals every message, and
   * runs the handler only if nothing is wrong.
   */
  handleSubmit: (run: () => void | Promise<void>) => (e: FormEvent) => void;
  /** True when no rule is failing, regardless of what is currently shown. */
  valid: boolean;
  /** Clears the revealed state — for a form that stays mounted after saving. */
  reset: () => void;
}

export function useFormValidation<V extends Record<string, unknown>>(
  values: V,
  rules: Rules<V>,
): FormValidation<V> {
  const [touched, setTouched] = useState<Partial<Record<keyof V, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);

  /*
   * `rules` is rebuilt by the caller on every render — they are inline arrow
   * functions — so it cannot be a dependency without defeating the memo. The
   * ref keeps the newest set reachable from a stable identity, and `values` is
   * the dependency that actually decides the answer.
   */
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  const failures = useMemo(() => {
    const out = new Map<keyof V, string>();
    for (const key of Object.keys(rulesRef.current) as Array<keyof V>) {
      const message = rulesRef.current[key]?.(values);
      if (message) out.set(key, message);
    }
    return out;
  }, [values]);

  const errorFor = useCallback(
    (key: keyof V) => (submitted || touched[key] ? failures.get(key) : undefined),
    [failures, submitted, touched],
  );

  const blurHandler = useCallback(
    (key: keyof V) => () => setTouched((t) => (t[key] ? t : { ...t, [key]: true })),
    [],
  );

  /*
   * The failing set is read through a ref rather than closed over, so a handler
   * created on an early render cannot submit against a stale verdict.
   */
  const failuresRef = useRef(failures);
  failuresRef.current = failures;

  const handleSubmit = useCallback(
    (run: () => void | Promise<void>) => (e: FormEvent) => {
      e.preventDefault();
      setSubmitted(true);
      if (failuresRef.current.size > 0) return;
      void run();
    },
    [],
  );

  const reset = useCallback(() => {
    setTouched({});
    setSubmitted(false);
  }, []);

  return { errorFor, blurHandler, handleSubmit, valid: failures.size === 0, reset };
}

// ── The rules that were being written out inline, once each ─────────────────

/** Present after trimming. `label` is used in the message, so pass a noun. */
export function required<V>(key: keyof V, label: string): Validator<V> {
  return (values) => (String(values[key] ?? '').trim() ? null : `${label} is required.`);
}

/**
 * A deliberately permissive address check.
 *
 * The form is not the authority on whether an address exists — the confirmation
 * mail is — so this only catches the shapes that are certainly a typo: no `@`,
 * nothing before or after it, no dot in the domain, or whitespace anywhere. A
 * stricter pattern here would reject valid addresses and the user would have no
 * way to argue with it.
 */
export function email<V>(key: keyof V, label = 'Email'): Validator<V> {
  return (values) => {
    const value = String(values[key] ?? '').trim();
    if (!value) return `${label} is required.`;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : `Enter a valid email address.`;
  };
}

/** At least `n` characters, counted on the raw value — spaces are legitimate. */
export function minLength<V>(key: keyof V, n: number, label: string): Validator<V> {
  return (values) => {
    const value = String(values[key] ?? '');
    if (!value) return `${label} is required.`;
    return value.length >= n ? null : `${label} must be at least ${n} characters.`;
  };
}

/** Equal to another field — confirm-password, and nothing else so far. */
export function matches<V>(key: keyof V, other: keyof V, message: string): Validator<V> {
  return (values) => {
    const value = String(values[key] ?? '');
    if (!value) return null; // the field's own required rule owns the empty case
    return value === String(values[other] ?? '') ? null : message;
  };
}

/**
 * A number inside an inclusive range.
 *
 * `type="number"` with `min`/`max` already expresses this to the browser, and
 * on a form carrying `noValidate` the browser is not listening — which is
 * exactly where the attribute reads as a rule that is being enforced and is
 * not. Non-numeric text is its own message: an empty `<input type=number>`
 * yields `''`, and `Number('')` is 0, so a blank box would otherwise report
 * "must be at least 10" rather than "is required".
 */
export function numberRange<V>(key: keyof V, min: number, max: number, label: string): Validator<V> {
  return (values) => {
    const raw = String(values[key] ?? '').trim();
    if (!raw) return `${label} is required.`;
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${label} must be a number.`;
    if (n < min) return `${label} must be at least ${min}.`;
    if (n > max) return `${label} must be at most ${max}.`;
    return null;
  };
}

/**
 * A number at or above `min`, with no ceiling.
 *
 * Most of the money and share boxes are bounded below and not above — an equity
 * value has no largest sensible figure — and writing that as `numberRange(k, 0,
 * Infinity, l)` puts an "at most Infinity" branch in the code that can never
 * fire. This is the same check without it.
 */
export function numberMin<V>(key: keyof V, min: number, label: string): Validator<V> {
  return (values) => {
    const raw = String(values[key] ?? '').trim();
    if (!raw) return `${label} is required.`;
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${label} must be a number.`;
    return n >= min ? null : `${label} must be at least ${min}.`;
  };
}

/**
 * A whole number.
 *
 * `step="1"` on `<input type=number>` is a real constraint the browser enforces
 * — it rejects 1.5 — so the boxes counting shares need it restated here, or
 * turning the browser off would quietly start accepting fractional shares.
 */
export function integer<V>(key: keyof V, label: string): Validator<V> {
  return (values) => {
    const raw = String(values[key] ?? '').trim();
    if (!raw) return `${label} is required.`;
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${label} must be a number.`;
    return Number.isInteger(n) ? null : `${label} must be a whole number.`;
  };
}

/**
 * Applies `validator` only when the field has been filled in.
 *
 * For the boxes that are genuinely optional but must be well-formed if used —
 * a support address that may be left unset, but must be an address when set.
 */
export function optional<V>(key: keyof V, validator: Validator<V>): Validator<V> {
  return (values) => (String(values[key] ?? '').trim() ? validator(values) : null);
}

/** Runs each rule in order and reports the first that fails. */
export function all<V>(...validators: Array<Validator<V>>): Validator<V> {
  return (values) => {
    for (const validate of validators) {
      const message = validate(values);
      if (message) return message;
    }
    return null;
  };
}
