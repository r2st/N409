import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, Field, TextInput } from '../src/components/ui';
import {
  all,
  email,
  integer,
  isEmailAddress,
  matches,
  minLength,
  numberMin,
  numberRange,
  pattern,
  optional,
  required,
  useFormValidation,
  type Validator,
} from '../src/lib/useFormValidation';

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

  it('puts focus on the first failing field when a submit is rejected', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // Everything is empty, so all three rules fail. Focus has to land on the
    // email box — first in reading order — and not stay on the button, which
    // is what makes a rejected submit silent for a screen reader.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(emailBox()).toHaveFocus();
  });

  it('skips a field that passes and focuses the one that does not', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(emailBox(), 'ada@corp.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // The email is fine; the first *failure* is the password.
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('moves focus again when the same broken form is submitted twice', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(emailBox()).toHaveFocus();

    // Nothing about the failing set changed, so the effect only re-runs if the
    // attempt is counted rather than the verdict watched. Without that, the
    // second press of a button that already looks inert is inert.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(emailBox()).toHaveFocus();
  });

  it('leaves focus alone when the submit is accepted', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(emailBox(), 'ada@corp.com');
    await user.type(screen.getByLabelText('Password'), 'correcthorse');
    await user.type(screen.getByLabelText('Confirm'), 'correcthorse');
    const save = screen.getByRole('button', { name: 'Save' });
    await user.click(save);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(save).toHaveFocus();
  });

  it('does not reach outside its own form for something to focus', async () => {
    const user = userEvent.setup();
    render(
      <>
        <form aria-label="other">
          <Field label="Other email" error="Enter a valid email address.">
            <TextInput defaultValue="nope" />
          </Field>
        </form>
        <Harness />
      </>,
    );
    // The unrelated form above is already showing an error, so a search that
    // started at the document would focus its box. Only this form's fields are
    // this form's business.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(emailBox()).toHaveFocus();
  });

  it('finds the failing field when the submit is a button rather than a form', async () => {
    // The scenario table in ParamsPanel is this shape: a `Save` button with an
    // onClick, inside a section, with no <form> anywhere above it.
    function SectionHarness() {
      const [form, setForm] = useState({ weight: '' });
      const { errorFor, blurHandler, handleSubmit } = useFormValidation(form, {
        weight: numberRange('weight', 0, 1, 'Weight'),
      });
      return (
        <section>
          <Field label="Weight" error={errorFor('weight')}>
            <TextInput
              value={form.weight}
              onChange={(e) => setForm({ weight: e.target.value })}
              onBlur={blurHandler('weight')}
            />
          </Field>
          <Button type="button" onClick={(e) => handleSubmit(vi.fn())(e)}>
            Save scenarios
          </Button>
        </section>
      );
    }
    const user = userEvent.setup();
    render(<SectionHarness />);
    await user.click(screen.getByRole('button', { name: 'Save scenarios' }));
    expect(screen.getByLabelText('Weight')).toHaveFocus();
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

  /**
   * The predicate behind `email`, exported for the one field holding a *list*
   * of addresses (the partner CC box). Checking each line against a second,
   * slightly different regex is how a form and the field it feeds end up
   * disagreeing about what an address is, so the two share this.
   */
  describe('isEmailAddress', () => {
    it('agrees with the email rule on every shape the rule rejects', () => {
      for (const value of ['adacorp.com', '@corp.com', 'ada@', 'ada@corp', 'ada lovelace@corp.com']) {
        expect(isEmailAddress(value)).toBe(false);
        expect(email('e')({ e: value })).not.toBeNull();
      }
    });

    it('agrees with the email rule on every shape the rule accepts', () => {
      for (const value of ['ada@corp.com', 'ada@mail.corp.co.uk', 'ada+409a@corp.com']) {
        expect(isEmailAddress(value)).toBe(true);
        expect(email('e')({ e: value })).toBeNull();
      }
    });

    it('trims before deciding, so a line with trailing space is still an address', () => {
      expect(isEmailAddress('  ada@corp.com  ')).toBe(true);
    });

    it('treats an empty string as not an address', () => {
      // The caller filters blanks out first; this is the guard for when it does not.
      expect(isEmailAddress('')).toBe(false);
    });
  });

  it('counts a password on the raw value, so spaces are characters', () => {
    expect(minLength('p', 10, 'Password')({ p: 'a b c d e ' })).toBeNull();
    expect(minLength('p', 10, 'Password')({ p: 'short' })).toBe('Password must be at least 10 characters.');
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

  describe('numberMin', () => {
    const rule = numberMin('v', 1, 'Shares');

    it('accepts the boundary and anything above it', () => {
      expect(rule({ v: '1' })).toBeNull();
      expect(rule({ v: '9999999999999' })).toBeNull();
    });

    it('rejects below the floor, and reports the floor', () => {
      expect(rule({ v: '0' })).toBe('Shares must be at least 1.');
      expect(rule({ v: '-5' })).toBe('Shares must be at least 1.');
    });

    it('calls an empty box absent rather than zero', () => {
      // `Number('')` is 0, which would otherwise fail the floor check and
      // report "must be at least 1" about a box with nothing in it.
      expect(rule({ v: '' })).toBe('Shares is required.');
      expect(rule({ v: '   ' })).toBe('Shares is required.');
    });

    it('separates non-numeric text from an out-of-range number', () => {
      expect(rule({ v: 'lots' })).toBe('Shares must be a number.');
    });

    it('has no ceiling, unlike numberRange', () => {
      expect(numberRange('v', 1, 10, 'Shares')({ v: '11' })).toBe('Shares must be at most 10.');
      expect(numberMin('v', 1, 'Shares')({ v: '11' })).toBeNull();
    });
  });

  describe('pattern', () => {
    const slug = pattern('k', /[a-z0-9_]+/, 'Slug only.');

    it('accepts a value the whole expression matches', () => {
      expect(slug({ k: 'payment_reminder_1' })).toBeNull();
    });

    it('anchors, so a match buried inside a longer value is still a failure', () => {
      // `pattern` on an input matches the whole value. Handing the same source
      // to a bare `RegExp.test` would accept these on the strength of the
      // matching run inside them.
      expect(slug({ k: 'Payment Reminder!' })).toBe('Slug only.');
      expect(slug({ k: 'payment reminder' })).toBe('Slug only.');
      expect(slug({ k: 'UPPER_case' })).toBe('Slug only.');
    });

    it('leaves the empty case to the required rule', () => {
      // Otherwise a box nobody has typed in reads as malformed.
      expect(slug({ k: '' })).toBeNull();
      expect(slug({ k: '   ' })).toBeNull();
    });

    it('pairs with required through all, which reports the empty case first', () => {
      const rule = all<{ k: string }>(required('k', 'Key'), slug);
      expect(rule({ k: '' })).toBe('Key is required.');
      expect(rule({ k: 'Nope!' })).toBe('Slug only.');
      expect(rule({ k: 'fine_1' })).toBeNull();
    });

    it('does not carry a g flag into repeated calls, which would alternate', () => {
      // A /g regex keeps `lastIndex` between `test` calls, so the same value
      // would pass, fail, pass on successive renders.
      const global = pattern('k', /[a-z]+/g, 'Letters only.');
      expect(global({ k: 'abc' })).toBeNull();
      expect(global({ k: 'abc' })).toBeNull();
      expect(global({ k: 'abc' })).toBeNull();
    });
  });

  describe('integer', () => {
    const rule = integer('v', 'Shares');

    it('accepts whole numbers, including negative and exponent forms', () => {
      expect(rule({ v: '1000' })).toBeNull();
      expect(rule({ v: '-4' })).toBeNull();
      expect(rule({ v: '1e3' })).toBeNull();
    });

    it('rejects a fraction, which is what step="1" rejected', () => {
      expect(rule({ v: '1000.5' })).toBe('Shares must be a whole number.');
    });

    it('accepts a trailing zero decimal, which is the same whole number', () => {
      expect(rule({ v: '1000.0' })).toBeNull();
    });

    it('reports an empty box and non-numeric text distinctly', () => {
      expect(rule({ v: '' })).toBe('Shares is required.');
      expect(rule({ v: 'many' })).toBe('Shares must be a number.');
    });
  });
});

/**
 * Every validator reads its field as `String(values[key] ?? '')`, and the `??`
 * is not decoration: a form's state object holds `null` for a cleared select,
 * an unfilled optional box, or a row loaded from the API before the user has
 * touched it. `String(null)` is the four characters "null" — long enough to
 * pass `minLength`, non-empty enough to pass `required`, and `Number('null')`
 * is NaN, so without the coalesce a null would report "must be a number" on a
 * box the user has not filled in yet.
 */
describe('the validators — a field holding null or nothing at all', () => {
  const cases: Array<[string, Validator<Record<string, unknown>>, string]> = [
    ['required', required('v', 'Company name'), 'Company name is required.'],
    ['email', email('v', 'Work email'), 'Work email is required.'],
    ['minLength', minLength('v', 10, 'Password'), 'Password is required.'],
    ['numberRange', numberRange('v', 1, 10, 'Weight'), 'Weight is required.'],
    ['numberMin', numberMin('v', 0, 'Equity value'), 'Equity value is required.'],
    ['integer', integer('v', 'Shares'), 'Shares is required.'],
  ];

  it.each(cases)('%s reads null as absent', (_name, rule, message) => {
    expect(rule({ v: null })).toBe(message);
    expect(rule({ v: undefined })).toBe(message);
    expect(rule({})).toBe(message);
  });

  it.each([
    ['matches', matches('v', 'other', 'Passwords do not match.')],
    ['pattern', pattern('v', /[a-z0-9_]+/, 'Use lowercase letters, digits and underscores.')],
    ['optional', optional('v', required('v', 'Support email'))],
  ] as Array<[string, Validator<Record<string, unknown>>]>)(
    '%s leaves a null field to the required rule',
    (_name, rule) => {
      expect(rule({ v: null })).toBeNull();
      expect(rule({ v: undefined })).toBeNull();
      expect(rule({})).toBeNull();
    },
  );

  it('matches a null confirm field against a null original without reporting one', () => {
    // Both cleared is not a mismatch — it is two empty boxes.
    expect(matches('v', 'other', 'Passwords do not match.')({ v: null, other: null })).toBeNull();
    expect(matches('v', 'other', 'Passwords do not match.')({ v: 'x', other: null })).toBe(
      'Passwords do not match.',
    );
  });

  it('runs an optional rule once the field is filled', () => {
    const rule = optional('v', email('v', 'Support email'));
    expect(rule({ v: '   ' })).toBeNull();
    expect(rule({ v: 'nonsense' })).toBe('Enter a valid email address.');
    expect(rule({ v: 'help@corp.com' })).toBeNull();
  });

  it('reports a number above the ceiling as well as below the floor', () => {
    const rule = numberRange('v', 1, 10, 'Weight');
    expect(rule({ v: '11' })).toBe('Weight must be at most 10.');
    expect(rule({ v: '0' })).toBe('Weight must be at least 1.');
    expect(rule({ v: 'heavy' })).toBe('Weight must be a number.');
    expect(rule({ v: '10' })).toBeNull();
  });

  it('passes every rule when all of them pass', () => {
    expect(all(required('v', 'Key'), pattern('v', /[a-z]+/, 'lowercase only'))({ v: 'slug' })).toBeNull();
  });
});
