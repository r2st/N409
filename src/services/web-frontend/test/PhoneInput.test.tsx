import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  PhoneInput,
  composePhoneValue,
  parsePhoneValue,
} from '../src/components/PhoneInput';
import { COUNTRIES, flagEmoji } from '../src/lib/countries';

describe('phone value parsing (gap #27)', () => {
  it('defaults to US for a bare number', () => {
    expect(parsePhoneValue('5551234567')).toEqual({ iso: 'US', national: '5551234567' });
  });

  it('splits a +1 US number', () => {
    expect(parsePhoneValue('+1 5551234567')).toEqual({ iso: 'US', national: '5551234567' });
  });

  it('prefers the longest matching dial code', () => {
    // +1868 is Trinidad and Tobago, not the bare US +1.
    expect(parsePhoneValue('+1868 2221234')).toEqual({ iso: 'TT', national: '2221234' });
  });

  it('parses a multi-digit European code', () => {
    expect(parsePhoneValue('+44 2079460000')).toEqual({ iso: 'GB', national: '2079460000' });
  });

  it('composes to an empty string when there is no number', () => {
    expect(composePhoneValue('US', '')).toBe('');
    expect(composePhoneValue('GB', '   ')).toBe('');
  });

  it('composes dial code + digits, stripping formatting', () => {
    expect(composePhoneValue('US', '(555) 123-4567')).toBe('+1 5551234567');
    expect(composePhoneValue('DE', '30 1234')).toBe('+49 301234');
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

describe('PhoneInput component', () => {
  it('emits an E.164-ish value as the user types', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('textbox'), '5551234567');
    expect(screen.getByTestId('value').textContent).toBe('+1 5551234567');
  });

  it('re-composes with the selected country code', async () => {
    const user = userEvent.setup();
    render(<Harness initial="+1 5551234567" />);
    await user.selectOptions(screen.getByLabelText('Country calling code'), 'GB');
    expect(screen.getByTestId('value').textContent).toBe('+44 5551234567');
  });

  it('keeps a sticky country choice even with an empty number', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PhoneInput value="" onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText('Country calling code'), 'FR');
    // No number yet, so the emitted value is empty…
    expect(onChange).toHaveBeenLastCalledWith('');
    // …but the dropdown still shows France selected.
    expect((screen.getByLabelText('Country calling code') as HTMLSelectElement).value).toBe('FR');
  });
});
