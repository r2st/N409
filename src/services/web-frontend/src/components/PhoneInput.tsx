import { useMemo, useState } from 'react';
import { COUNTRIES, DEFAULT_COUNTRY_ISO, countryByIso, flagEmoji, primaryIsoForDial } from '../lib/countries';
import { inputClass } from './ui';

/**
 * International phone input (409.ai gap #27): a country dial-code dropdown
 * (240+ countries, US default) beside a national-number field. The value is a
 * single E.164-ish string ("+1 5551234567") so callers store one column; an
 * empty national number yields an empty string (i.e. "no phone").
 */

/** Split a stored value into a country ISO + national digits, best-effort. */
function parseValue(value: string): { iso: string; national: string } {
  const trimmed = value.trim();
  if (!trimmed.startsWith('+')) {
    return { iso: DEFAULT_COUNTRY_ISO, national: trimmed };
  }
  const digits = trimmed.slice(1).replace(/[^\d]/g, '');
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
  const digits = national.replace(/[^\d]/g, '');
  if (!digits) return '';
  const country = countryByIso(iso);
  return country ? `+${country.dial} ${digits}` : digits;
}

export function PhoneInput({
  value,
  onChange,
  id,
  name = 'phone',
  autoComplete = 'tel',
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  autoComplete?: string;
}) {
  const parsed = useMemo(() => parseValue(value), [value]);
  // The dial-code choice is sticky: selecting a country with an empty number
  // must persist even though compose() emits '' (which parseValue can't round-
  // trip back to that country). Seed from the incoming value once.
  const [iso, setIso] = useState(parsed.iso);
  const national = parsed.national;

  const selectCountry = (nextIso: string) => {
    setIso(nextIso);
    onChange(compose(nextIso, national));
  };

  const setNational = (next: string) => {
    onChange(compose(iso, next));
  };

  const active = countryByIso(iso);

  return (
    <div className="flex gap-2">
      <label className="sr-only" htmlFor={`${id ?? name}-country`}>
        Country calling code
      </label>
      <select
        id={`${id ?? name}-country`}
        aria-label="Country calling code"
        value={iso}
        onChange={(e) => selectCountry(e.target.value)}
        className={`${inputClass} w-auto shrink-0 pr-8`}
      >
        {COUNTRIES.map((c) => (
          <option key={c.iso} value={c.iso}>
            {flagEmoji(c.iso)} {c.name} (+{c.dial})
          </option>
        ))}
      </select>
      <input
        id={id ?? name}
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete={autoComplete}
        placeholder="(555) 123-4567"
        value={national}
        onChange={(e) => setNational(e.target.value)}
        aria-describedby={`${id ?? name}-code`}
        className={inputClass}
      />
      <span id={`${id ?? name}-code`} className="sr-only">
        Selected calling code +{active?.dial ?? '1'}
      </span>
    </div>
  );
}

export { parseValue as parsePhoneValue, compose as composePhoneValue };
