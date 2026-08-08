import { useMemo, useState, type FocusEventHandler } from 'react';
import { COUNTRIES, DEFAULT_COUNTRY_ISO, countryByIso, flagEmoji, primaryIsoForDial } from '../lib/countries';
import { e164Error } from '../lib/phone';
import { inputClass } from './ui';

/**
 * International phone input (409.ai gap #27): a country dial-code dropdown
 * (240+ countries, US default) beside a national-number field. The value is a
 * single canonical E.164 string ("+15551234567") so callers store one column
 * and an SMS gateway can dial it unchanged; an empty national number yields an
 * empty string (i.e. "no phone").
 */

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Split a stored value into a country ISO + national digits, best-effort. */
function parseValue(value: string): { iso: string; national: string } {
  const trimmed = value.trim();
  // `00` is the international access prefix and means what `+` means, so a
  // number pasted as "0044 20 7946 0000" resolves to the UK rather than being
  // read as a national number.
  const international = trimmed.startsWith('+')
    ? trimmed.slice(1)
    : trimmed.startsWith('00')
      ? trimmed.slice(2)
      : null;
  if (international === null) {
    // No calling code on the value at all — a legacy row, or a number typed
    // before this component existed. The default country is the only one it
    // can be attributed to.
    return { iso: DEFAULT_COUNTRY_ISO, national: onlyDigits(trimmed) };
  }
  const digits = onlyDigits(international);
  // Prefer the longest matching dial code so e.g. "+1868" resolves to Trinidad
  // rather than the bare US "+1".
  let best: { iso: string; dial: string } | null = null;
  for (const c of COUNTRIES) {
    if (digits.startsWith(c.dial) && (!best || c.dial.length > best.dial.length)) {
      best = { iso: c.iso, dial: c.dial };
    }
  }
  if (!best) return { iso: DEFAULT_COUNTRY_ISO, national: digits };
  // Prefer the canonical country when several share this exact dial code.
  const iso = primaryIsoForDial(best.dial) ?? best.iso;
  return { iso, national: digits.slice(best.dial.length) };
}

function compose(iso: string, national: string): string {
  const digits = onlyDigits(national);
  if (!digits) return '';
  const country = countryByIso(iso);
  return country ? `+${country.dial}${digits}` : digits;
}

/**
 * The error a form should show for a phone field, or null when there is none.
 *
 * An empty value means "no phone", which every phone field on this platform
 * allows — pass `required` for one that does not. Deliberately *not* rendered
 * by the component: `Field` already owns the error slot and its aria wiring, so
 * a call site holds the touched/blurred flag and hands the message to `Field`.
 */
export function phoneFieldError(value: string, opts: { required?: boolean } = {}): string | null {
  if (!value.trim()) return opts.required ? 'Enter a phone number' : null;
  return e164Error(value);
}

export function PhoneInput({
  value,
  onChange,
  id,
  name = 'phone',
  autoComplete = 'tel',
  onBlur,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  autoComplete?: string;
  /** Fires when focus leaves either control — call sites use it to gate errors. */
  onBlur?: FocusEventHandler<HTMLElement>;
  /** Injected by `Field` when it is showing an error for this control. */
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const parsed = useMemo(() => parseValue(value), [value]);

  // The country lives in state rather than being read straight off `value`,
  // because one string cannot say which country was picked: "+15551234567"
  // parses back as US whether the user chose US, Canada or Puerto Rico, and an
  // empty number carries no country at all.
  const [own, setOwn] = useState(() => ({ iso: parsed.iso, emitted: value }));

  // …but it is re-seeded whenever `value` changes to something this component
  // did not emit. That is the stale-select bug: seeding once with useState
  // meant a value arriving after mount — a profile fetched from the API, a
  // reset form, a parent switching records — updated the national digits while
  // the dropdown kept whatever country it first rendered. A UK number then sat
  // behind a US flag, and the next keystroke re-composed it as +1.
  let iso = own.iso;
  if (value !== own.emitted) {
    // An empty value names no country, so a cleared field keeps the choice.
    iso = value.trim() ? parsed.iso : own.iso;
    setOwn({ iso, emitted: value });
  }

  /** Emit, and record what we emitted so the sync above ignores our own echo. */
  const emit = (nextIso: string, national: string) => {
    const next = compose(nextIso, national);
    setOwn({ iso: nextIso, emitted: next });
    onChange(next);
  };

  const active = countryByIso(iso);
  const fieldId = id ?? name;
  const codeId = `${fieldId}-code`;
  const describedBy = [ariaDescribedBy, codeId].filter(Boolean).join(' ');

  return (
    <div className="flex gap-2">
      <select
        id={`${fieldId}-country`}
        aria-label="Country calling code"
        value={iso}
        onChange={(e) => emit(e.target.value, parsed.national)}
        onBlur={onBlur}
        // Fixed basis rather than `w-auto`: sized to its content the select is
        // as wide as "Bosnia and Herzegovina", which left the number field a
        // 40px stub beside it. Basis wins over the `w-full` in inputClass
        // (flex-basis beats width for a flex item) without depending on which
        // order Tailwind happens to emit two width utilities in.
        className={`${inputClass} shrink-0 grow-0 basis-36 pr-8`}
      >
        {COUNTRIES.map((c) => (
          <option key={c.iso} value={c.iso}>
            {/* Code before name: the closed select truncates at that basis, and
                the calling code is the half that has to survive. */}
            {flagEmoji(c.iso)} +{c.dial} {c.name}
          </option>
        ))}
      </select>
      <input
        id={fieldId}
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete={autoComplete}
        // The wrapping `Field` label resolves to the <select> (it is the first
        // labelable descendant), so the number itself needs its own name.
        aria-label="Phone number"
        placeholder="(555) 123-4567"
        value={parsed.national}
        onChange={(e) => emit(iso, e.target.value)}
        onBlur={onBlur}
        aria-invalid={ariaInvalid}
        aria-describedby={describedBy}
        className={`${inputClass} min-w-0 flex-1`}
      />
      <span id={codeId} className="sr-only">
        Selected calling code +{active?.dial ?? '1'}
      </span>
    </div>
  );
}

export { parseValue as parsePhoneValue, compose as composePhoneValue };
