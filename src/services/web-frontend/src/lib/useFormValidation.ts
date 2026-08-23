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
 *   - Submitting reveals every message at once, does not call the handler, and
 *     moves focus to the first field that is failing.
 *
 * Validators are pure functions of the whole value object, so a rule that spans
 * two fields (confirm-password) is written the same way as one that does not.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
   * Wraps a submit handler: prevents the default, reveals every message, moves
   * focus to the first field that is failing, and runs the handler only if
   * nothing is wrong.
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

  /*
   * A rejected submit has to move focus, or it is silent.
   *
   * Revealing the messages is enough for someone looking at the form and
   * nothing at all for someone who is not: focus stays on the submit button,
   * the messages are ordinary text rather than live regions, and a screen
   * reader announces exactly nothing. The button appears to have done nothing,
   * which is also how a broken button appears. Focusing the first failing
   * control announces its label, its invalid state and — via the
   * `aria-describedby` `Field` already wires — the message itself, and on a
   * long form it scrolls the problem into view for everyone else.
   *
   * The failing control is found in the DOM rather than tracked, because the
   * hook knows which *rules* fail and only `Field` knows which element each one
   * is about. `Field` marks it `aria-invalid` in the same render that reveals
   * the message, so the first such control inside the form is the first
   * failure in reading order.
   *
   * `submitAttempt` exists so this runs after that render rather than before
   * it, and so that submitting twice against the same errors focuses twice.
   */
  const [submitAttempt, setSubmitAttempt] = useState(0);
  const rejectedFrom = useRef<HTMLElement | null>(null);

  const handleSubmit = useCallback(
    (run: () => void | Promise<void>) => (e: FormEvent) => {
      e.preventDefault();
      setSubmitted(true);
      if (failuresRef.current.size > 0) {
        rejectedFrom.current = e.currentTarget as HTMLElement;
        setSubmitAttempt((n) => n + 1);
        return;
      }
      void run();
    },
    [],
  );

  useEffect(() => {
    if (submitAttempt === 0) return;
    const origin = rejectedFrom.current;
    if (!origin) return;
    /*
     * Nearly every call site hands this to `<form onSubmit>`, so the origin is
     * the form and scoping to it is exact. The one that does not is a `Save`
     * button inside a `<section>` with no form around it, and searching the
     * whole document from there could steal focus into an unrelated form that
     * happens to be showing an error. Widening only as far as the nearest
     * enclosing form or sectioning box keeps the search inside the thing the
     * button belongs to.
     */
    const scope = origin.closest?.('form, fieldset, dialog, [role="dialog"], section, article');
    const invalid = (scope ?? origin).querySelectorAll<HTMLElement>('[aria-invalid="true"]');
    for (const el of invalid) {
      if (el.hasAttribute('disabled')) continue;
      el.focus();
      if (el.ownerDocument.activeElement === el) return;
    }
  }, [submitAttempt]);

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
 *
 * Exported as a predicate as well as a rule, for the one field that holds a
 * *list* of addresses: the partner CC box is one address per line, and checking
 * each of them against a second, slightly different regex is how the form and
 * the field it feeds end up disagreeing about what an address is.
 */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function email<V>(key: keyof V, label = 'Email'): Validator<V> {
  return (values) => {
    const value = String(values[key] ?? '').trim();
    if (!value) return `${label} is required.`;
    return isEmailAddress(value) ? null : `Enter a valid email address.`;
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
 * Matches a regular expression.
 *
 * For the boxes carrying a `pattern` attribute — the template and campaign keys,
 * which are slugs the workflow code looks up by exact string. `message` is
 * written out by the caller rather than derived, because "must match
 * /^[a-z0-9_]+$/" is not something to put in front of anyone.
 *
 * The expression is anchored here rather than at each call site: `pattern` on an
 * input matches the whole value, and a bare `[a-z0-9_]+` translated literally to
 * `RegExp.test` would accept "Payment Reminder!" on the strength of the "ayment"
 * inside it.
 */
export function pattern<V>(key: keyof V, re: RegExp, message: string): Validator<V> {
  const anchored = new RegExp(`^(?:${re.source})$`, re.flags.replace('g', ''));
  return (values) => {
    const value = String(values[key] ?? '').trim();
    if (!value) return null; // the field's own required rule owns the empty case
    return anchored.test(value) ? null : message;
  };
}

/**
 * An absolute `https://` address.
 *
 * The three brand-image boxes and the SAML IdP entry point all hold a URL that
 * somebody else's browser later fetches or is redirected to, and the service
 * requires https on all four. The rule is restated here rather than shared,
 * because the browser bundle cannot import the service — the server stays the
 * authority and this is the early warning, which is the difference between
 * "Logo URL must be an https:// address" beside the box and "Invalid branding"
 * above the form after a round trip.
 *
 * The scheme is read off a parsed URL rather than matched as a prefix, so
 * `http://https.example.com/logo.svg` is not mistaken for one.
 */
export function httpsUrl<V>(key: keyof V, label: string): Validator<V> {
  return (values) => {
    const value = String(values[key] ?? '').trim();
    if (!value) return `${label} is required.`;
    try {
      if (new URL(value).protocol === 'https:') return null;
    } catch {
      return `${label} must be a full https:// address.`;
    }
    return `${label} must be a full https:// address.`;
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
