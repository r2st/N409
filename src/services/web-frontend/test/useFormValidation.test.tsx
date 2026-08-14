import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, Field, TextInput } from '../src/components/ui';
import { all, email, matches, minLength, required, useFormValidation } from '../src/lib/useFormValidation';

/**
 * A form with the two rules that between them cover every shape the hook has
 * to handle: one field's own rule, and one that reads a second field.
 */
function Harness({ onSubmit = vi.fn() }: { onSubmit?: () => void }) {
  const [form, setForm] = useState({ email: '', password: '', confirm: '' });
  const { errorFor, blurHandler, handleSubmit, valid } = useFormValidation(form, {
    email: email('email', 'Work email'),
    password: minLength('password', 10, 'Password'),
    confirm: all(
      required('confirm', 'Confirmation'),
      matches('confirm', 'password', 'Passwords do not match.'),
    ),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <Field label="Work email" error={errorFor('email')}>
        <TextInput value={form.email} onChange={set('email')} onBlur={blurHandler('email')} />
      </Field>
      <Field label="Password" error={errorFor('password')}>
        <TextInput
          type="password"
          value={form.password}
          onChange={set('password')}
          onBlur={blurHandler('password')}
        />
      </Field>
      <Field label="Confirm" error={errorFor('confirm')}>
        <TextInput
          type="password"
          value={form.confirm}
          onChange={set('confirm')}
          onBlur={blurHandler('confirm')}
        />
      </Field>
      <span data-testid="valid">{String(valid)}</span>
      <Button type="submit">Save</Button>
    </form>
  );
}

const emailBox = () => screen.getByLabelText('Work email');

describe('useFormValidation', () => {
  it('says nothing while the field is being typed into for the first time', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(emailBox(), 'ada@');
    // The value is invalid, and telling them so mid-address is the behaviour
    // this rule exists to prevent.
    expect(screen.queryByText('Enter a valid email address.')).not.toBeInTheDocument();
  });

  it('reveals the message when the field is blurred', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(emailBox(), 'ada@');
    await user.tab();
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('clears the message as soon as the value is corrected, without a second blur', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(emailBox(), 'ada@');
    await user.tab();
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();

    await user.click(emailBox());
    await user.type(emailBox(), 'corp.com');
    expect(screen.queryByText('Enter a valid email address.')).not.toBeInTheDocument();
  });

  it('reveals every message on submit, including fields never touched', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Work email is required.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    expect(screen.getByText('Confirmation is required.')).toBeInTheDocument();
  });

  it('does not call the handler while anything is wrong', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(emailBox(), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls the handler once everything passes', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(emailBox(), 'ada@corp.com');
    await user.type(screen.getByLabelText('Password'), 'correcthorse');
    await user.type(screen.getByLabelText('Confirm'), 'correcthorse');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('marks the control invalid for assistive tech, not just visually', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(emailBox(), 'nope');
    await user.tab();

    const box = emailBox();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    // The message is what `aria-describedby` points at, so it is announced
    // rather than merely rendered near the box.
    const describedBy = box.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('Enter a valid email address.');
  });

  it('reports a cross-field rule against the field the user can fix', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText('Password'), 'correcthorse');
    await user.type(screen.getByLabelText('Confirm'), 'correcthorsf');
    await user.tab();
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
  });

  it('re-evaluates a cross-field rule when the *other* field changes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText('Password'), 'correcthorse');
    await user.type(screen.getByLabelText('Confirm'), 'correcthorsf');
    await user.tab();
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();

    // Fixing the password, not the confirmation, has to clear it too — the
    // validator is a function of the whole value object for this reason.
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'correcthorsf');
    expect(screen.queryByText('Passwords do not match.')).not.toBeInTheDocument();
  });

  it('tracks validity independently of what is currently shown', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId('valid')).toHaveTextContent('false');
    // Nothing is displayed yet — nothing has been blurred or submitted.
    expect(screen.queryByText('Work email is required.')).not.toBeInTheDocument();

    await user.type(emailBox(), 'ada@corp.com');
    await user.type(screen.getByLabelText('Password'), 'correcthorse');
    await user.type(screen.getByLabelText('Confirm'), 'correcthorse');
    expect(screen.getByTestId('valid')).toHaveTextContent('true');
  });
});

describe('the validators', () => {
  it.each([
    ['no at-sign', 'adacorp.com'],
    ['nothing before the at-sign', '@corp.com'],
    ['nothing after the at-sign', 'ada@'],
    ['no dot in the domain', 'ada@corp'],
    ['an internal space', 'ada lovelace@corp.com'],
  ])('rejects an address with %s', (_label, value) => {
    expect(email('e')({ e: value })).toBe('Enter a valid email address.');
  });

  it.each([
    ['an ordinary address', 'ada@corp.com'],
    ['a subdomain', 'ada@mail.corp.co.uk'],
    ['a plus tag', 'ada+409a@corp.com'],
    ['surrounding whitespace, which is trimmed', '  ada@corp.com  '],
  ])('accepts %s', (_label, value) => {
    expect(email('e')({ e: value })).toBeNull();
  });

  it('counts a password on the raw value, so spaces are characters', () => {
    expect(minLength('p', 10, 'Password')({ p: 'a b c d e ' })).toBeNull();
    expect(minLength('p', 10, 'Password')({ p: 'short' })).toBe(
      'Password must be at least 10 characters.',
    );
  });

  it('treats a whitespace-only value as absent', () => {
    expect(required('n', 'Name')({ n: '   ' })).toBe('Name is required.');
    expect(required('n', 'Name')({ n: ' Ada ' })).toBeNull();
  });

  it('leaves the empty case to the required rule rather than reporting a mismatch', () => {
    // Otherwise an untouched confirmation box reads "Passwords do not match"
    // before anything has been typed into it.
    expect(matches('c', 'p', 'nope')({ c: '', p: 'correcthorse' })).toBeNull();
  });

  it('reports the first failing rule, in the order given', () => {
    const rule = all<{ c: string }>(required('c', 'Confirmation'), () => 'second');
    expect(rule({ c: '' })).toBe('Confirmation is required.');
    expect(rule({ c: 'x' })).toBe('second');
  });
});
