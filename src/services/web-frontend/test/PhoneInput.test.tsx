import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  PhoneInput,
  composePhoneValue,
  parsePhoneValue,
  phoneFieldError,
} from '../src/components/PhoneInput';
import { COUNTRIES, flagEmoji } from '../src/lib/countries';

describe('phone value parsing (gap #27)', () => {
  it('defaults to US for a bare number', () => {
    expect(parsePhoneValue('5551234567')).toEqual({ iso: 'US', national: '5551234567' });
  });

  it('strips formatting off a bare legacy value', () => {
    expect(parsePhoneValue('(555) 123-4567')).toEqual({ iso: 'US', national: '5551234567' });
  });

  it('splits a +1 US number', () => {
    expect(parsePhoneValue('+15551234567')).toEqual({ iso: 'US', national: '5551234567' });
  });

  it('still reads the legacy spaced form stored before this change', () => {
    expect(parsePhoneValue('+1 5551234567')).toEqual({ iso: 'US', national: '5551234567' });
  });

  it('prefers the longest matching dial code', () => {
    // +1868 is Trinidad and Tobago, not the bare US +1.
    expect(parsePhoneValue('+18682221234')).toEqual({ iso: 'TT', national: '2221234' });
  });

  it('parses a multi-digit European code', () => {
    expect(parsePhoneValue('+442079460000')).toEqual({ iso: 'GB', national: '2079460000' });
  });

  it('reads 00 as the international prefix it is', () => {
    expect(parsePhoneValue('0044 20 7946 0000')).toEqual({ iso: 'GB', national: '2079460000' });
  });

  it('composes to an empty string when there is no number', () => {
    expect(composePhoneValue('US', '')).toBe('');
    expect(composePhoneValue('GB', '   ')).toBe('');
  });

  it('composes canonical E.164 — no spaces for a gateway to choke on', () => {
    expect(composePhoneValue('US', '(555) 123-4567')).toBe('+15551234567');
    expect(composePhoneValue('DE', '30 1234')).toBe('+49301234');
  });
});

describe('country data (gap #27)', () => {
  it('covers 240+ countries with a US default present', () => {
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(240);
    expect(COUNTRIES.find((c) => c.iso === 'US')?.dial).toBe('1');
  });

  it('derives a flag emoji from the ISO code', () => {
    expect(flagEmoji('US')).toBe('🇺🇸');
  });

  it('renders nothing rather than mojibake for a code that is not two letters', () => {
    // A partner-supplied country on an imported row is not guaranteed to be
    // alpha-2; the arithmetic below would otherwise emit arbitrary code points.
    expect(flagEmoji('')).toBe('');
    expect(flagEmoji('USA')).toBe('');
    expect(flagEmoji('U')).toBe('');
  });
});

describe('phoneFieldError', () => {
  it('treats an empty field as "no phone", which every form here allows', () => {
    expect(phoneFieldError('')).toBeNull();
    expect(phoneFieldError('   ')).toBeNull();
  });

  it('demands one only where the field is required', () => {
    expect(phoneFieldError('', { required: true })).toMatch(/enter a phone number/i);
  });

  it('passes a dialable number and rejects a half-typed one', () => {
    expect(phoneFieldError('+15551234567')).toBeNull();
    expect(phoneFieldError('+1555')).toMatch(/too short/i);
  });
});

/** Thin controlled wrapper so we can assert the emitted value. */
function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <PhoneInput value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </div>
  );
}

const countrySelect = () => screen.getByLabelText('Country calling code') as HTMLSelectElement;

describe('PhoneInput component', () => {
  it('emits a canonical E.164 value as the user types', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('textbox'), '5551234567');
    expect(screen.getByTestId('value').textContent).toBe('+15551234567');
  });

  it('re-composes with the selected country code', async () => {
    const user = userEvent.setup();
    render(<Harness initial="+15551234567" />);
    await user.selectOptions(countrySelect(), 'GB');
    expect(screen.getByTestId('value').textContent).toBe('+445551234567');
  });

  it('keeps a sticky country choice even with an empty number', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PhoneInput value="" onChange={onChange} />);
    await user.selectOptions(countrySelect(), 'FR');
    // No number yet, so the emitted value is empty…
    expect(onChange).toHaveBeenLastCalledWith('');
    // …but the dropdown still shows France selected.
    expect(countrySelect().value).toBe('FR');
  });

  it('keeps the country the user picked when several share a dial code', async () => {
    const user = userEvent.setup();
    render(<Harness initial="+15551234567" />);
    // +1 parses back as US, so echoing our own emission must not snap the
    // dropdown off Canada.
    await user.selectOptions(countrySelect(), 'CA');
    expect(screen.getByTestId('value').textContent).toBe('+15551234567');
    expect(countrySelect().value).toBe('CA');

    await user.type(screen.getByRole('textbox'), '8');
    expect(countrySelect().value).toBe('CA');
  });

  // ── The stale-select bug ───────────────────────────────────────────────────
  // The country was seeded once with useState, so a value that arrived after
  // mount moved the digits and left the dropdown behind.

  it('re-seeds the country when the value arrives after mount', () => {
    const { rerender } = render(<PhoneInput value="" onChange={vi.fn()} />);
    expect(countrySelect().value).toBe('US');

    // The profile fetch lands.
    rerender(<PhoneInput value="+442079460000" onChange={vi.fn()} />);
    expect(countrySelect().value).toBe('GB');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('2079460000');
  });

  it('re-seeds the country when the parent switches to another record', () => {
    const { rerender } = render(<PhoneInput value="+442079460000" onChange={vi.fn()} />);
    expect(countrySelect().value).toBe('GB');

    rerender(<PhoneInput value="+33142685300" onChange={vi.fn()} />);
    expect(countrySelect().value).toBe('FR');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('142685300');
  });

  it('does not re-seed a country the user picked when the field is cleared', async () => {
    const user = userEvent.setup();
    render(<Harness initial="+33142685300" />);
    expect(countrySelect().value).toBe('FR');

    await user.clear(screen.getByRole('textbox'));
    expect(screen.getByTestId('value').textContent).toBe('');
    // A cleared field names no country, so the choice survives the round trip
    // rather than snapping back to the US default.
    expect(countrySelect().value).toBe('FR');
  });

  it('emits against the country shown after an external re-seed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<PhoneInput value="" onChange={onChange} />);
    rerender(<PhoneInput value="+442079460000" onChange={onChange} />);

    // Before the fix this appended to a US-composed value: the dropdown said
    // US while the digits were British, and typing saved a +1 number.
    await user.type(screen.getByRole('textbox'), '1');
    expect(onChange).toHaveBeenLastCalledWith('+4420794600001');
  });

  // ── Wiring ─────────────────────────────────────────────────────────────────

  it('reports a blur from either control so a form can gate its error', async () => {
    const user = userEvent.setup();
    const onBlur = vi.fn();
    render(<PhoneInput value="" onChange={vi.fn()} onBlur={onBlur} />);
    await user.click(screen.getByRole('textbox'));
    await user.tab();
    expect(onBlur).toHaveBeenCalled();
  });

  it('forwards the aria wiring Field injects', () => {
    render(<PhoneInput value="" onChange={vi.fn()} id="phone" aria-invalid aria-describedby="phone-error" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // Field's error node, plus the component's own sr-only calling-code note.
    expect(input.getAttribute('aria-describedby')).toContain('phone-error');
    expect(input.getAttribute('aria-describedby')).toContain('phone-code');
  });
});
