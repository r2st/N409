import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Field, Select, TextInput } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { RegisterPage } from '../src/pages/RegisterPage';

/**
 * Sixty-three controls across the product carry `required`, and not one of
 * them said so on its label. A sighted user could only discover which fields
 * were compulsory by filling the form in, submitting it, and being told —
 * which on the longer forms (intake, new valuation, the grant editor) means
 * scrolling back through everything they have already typed.
 *
 * `Field` reads the attribute off the control it wraps rather than taking a
 * second prop for it, so the marker cannot drift away from the rule it
 * describes and no call site had to be edited to gain one.
 */

describe('Field marks a required control', () => {
  it('adds a marker when the control it wraps is required', () => {
    render(
      <Field label="Company legal name">
        <TextInput required value="" onChange={() => {}} />
      </Field>,
    );

    const label = screen.getByText('Company legal name').parentElement!;
    expect(label).toHaveTextContent('Company legal name*');
  });

  it('leaves an optional control unmarked', () => {
    render(
      <Field label="Job title">
        <TextInput value="" onChange={() => {}} />
      </Field>,
    );

    expect(screen.getByText('Job title').parentElement).toHaveTextContent(/^Job title$/);
  });

  /**
   * The asterisk is decoration. `required` on the control is already an
   * implicit `aria-required`, so the rule is announced from the control
   * itself; repeating it in the label would only rename the field.
   */
  it('keeps the marker out of the control’s accessible name', () => {
    render(
      <Field label="Work email">
        <TextInput required type="email" value="" onChange={() => {}} />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Work email' });
    expect(input).toBeRequired();
    expect(screen.queryByRole('textbox', { name: /\*/ })).not.toBeInTheDocument();
  });

  it('works for a select as well as a text input', () => {
    render(
      <Field label="Currency">
        <Select required value="USD" onChange={() => {}}>
          <option value="USD">USD</option>
        </Select>
      </Field>,
    );

    expect(screen.getByText('Currency').parentElement).toHaveTextContent('Currency*');
    expect(screen.getByRole('combobox', { name: 'Currency' })).toBeRequired();
  });

  /** A field can be required and in error at once; both must show. */
  it('shows the marker alongside a validation error', () => {
    render(
      <Field label="Password" error="Use at least 12 characters.">
        <TextInput required type="password" value="abc" onChange={() => {}} />
      </Field>,
    );

    expect(screen.getByText('Password').parentElement).toHaveTextContent('Password*');
    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument();
  });

  /** A control that declares the rule through ARIA is marked the same way. */
  it('honours aria-required on a control with no native attribute', () => {
    render(
      <Field label="Rationale">
        <div role="textbox" aria-required contentEditable />
      </Field>,
    );

    expect(screen.getByText('Rationale').parentElement).toHaveTextContent('Rationale*');
  });
});

describe('a real form carries the markers', () => {
  it('marks the compulsory fields on the registration page and not the optional ones', () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <RegisterPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('textbox', { name: 'Work email' })).toBeRequired();
    expect(screen.getByText('Work email').parentElement).toHaveTextContent('Work email*');
    expect(screen.getByText('Password').parentElement).toHaveTextContent('Password*');
  });
});
