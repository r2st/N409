import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field, Modal, Spinner, TextInput } from '../src/components/ui';

describe('Field aria wiring (F-3 P2)', () => {
  it('marks the control invalid and links it to the error text', () => {
    render(
      <Field label="Email" error="Email is required">
        <TextInput defaultValue="" />
      </Field>,
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('Email is required');
  });

  it('links to the hint when there is no error, and is not invalid', () => {
    render(
      <Field label="Password" hint="At least 10 characters">
        <TextInput defaultValue="" />
      </Field>,
    );
    const input = screen.getByRole('textbox');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)).toHaveTextContent('At least 10 characters');
  });

  it('names the control even when the label carries a tooltip', () => {
    render(
      <>
        <Field label="Coupon rate">
          <TextInput defaultValue="" />
        </Field>
        <Field label="Market yield" tooltip="The annual return the market demands.">
          <TextInput defaultValue="" />
        </Field>
      </>,
    );
    // A tooltip puts a <button> inside the wrapping <label>, and
    // name-from-a-wrapping-label stops at the first nested control: the tipped
    // field computed an accessible name of "" and was announced as an
    // unlabelled edit box. Twenty-two fields across the platform have one,
    // including every rate a valuation is defensible on.
    expect(screen.getByRole('textbox', { name: 'Coupon rate' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Market yield' })).toBeInTheDocument();
    // The tooltip trigger keeps its own distinct name — it is a separate
    // control and must not be folded into the field's.
    expect(screen.getByRole('button', { name: 'About Market yield' })).toBeInTheDocument();
  });

  it('names a control that ships with a sibling, such as a suggestion list', () => {
    // A suggestion box is a control *and* its `<datalist>`, so the field's
    // children arrive as an array — and the wiring below used to run only for a
    // lone child. Those inputs fell back to name-from-the-wrapping-label, which
    // sweeps in the hint: the bot-prompt model box announced itself as "Model
    // OpenRouter model id — leave empty to use the default fallback chain",
    // and the template-name box likewise. Two of the platform's suggestion
    // fields, both read aloud as a paragraph.
    render(
      <Field label="Model" hint="OpenRouter model id — leave empty to use the default fallback chain.">
        <TextInput list="models" defaultValue="" />
        <datalist id="models">
          <option value="a/b" />
        </datalist>
      </Field>,
    );
    // `list` puts the input in the combobox role rather than textbox.
    const input = screen.getByRole('combobox', { name: 'Model' });
    expect(input).toHaveAttribute('list', 'models');
    // The hint is still described-by rather than folded into the name.
    const describedBy = input.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)).toHaveTextContent('OpenRouter model id');
    // The sibling survives the rewiring — the suggestions still resolve.
    expect(document.getElementById('models')).toBeInTheDocument();
  });

  it('leaves a sibling that is not the control alone', () => {
    render(
      <Field label="Amount" error="Too large">
        <TextInput defaultValue="" />
        <span data-testid="suffix">USD</span>
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Amount' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('suffix')).not.toHaveAttribute('aria-labelledby');
  });

  it('does not overwrite a name the caller set deliberately', () => {
    render(
      <Field label="Search">
        <TextInput aria-label="Search valuations by company" defaultValue="" />
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: 'Search valuations by company' })).toBeInTheDocument();
  });
});

describe('Spinner (F-3 P3)', () => {
  it('exposes a role=status with an sr-only label', () => {
    render(<Spinner />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading…');
  });

  it('accepts a custom label', () => {
    render(<Spinner label="Fetching valuations" />);
    expect(screen.getByRole('status')).toHaveTextContent('Fetching valuations');
  });
});

describe('Modal (F-3 P2)', () => {
  it('renders a labelled dialog only when open', () => {
    const { rerender } = render(
      <Modal open={false} onClose={() => {}} title="Confirm">
        <p>Body</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <Modal open onClose={() => {}} title="Confirm">
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Confirm');
  });

  it('moves focus into the dialog on open', () => {
    render(
      <Modal open onClose={() => {}} title="Confirm">
        <button>First action</button>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Confirm">
        <button>Ok</button>
      </Modal>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click but not on a content click', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Confirm">
        <button>Ok</button>
      </Modal>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Ok' }));
    expect(onClose).not.toHaveBeenCalled();
    // The backdrop is the dialog's parent element.
    const backdrop = screen.getByRole('dialog').parentElement!;
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab within the dialog', async () => {
    const user = userEvent.setup();
    render(
      <Modal open onClose={() => {}} title="Confirm">
        <button>One</button>
        <button>Two</button>
      </Modal>,
    );
    const one = screen.getByRole('button', { name: 'One' });
    const two = screen.getByRole('button', { name: 'Two' });
    expect(one).toHaveFocus();
    await user.tab();
    expect(two).toHaveFocus();
    await user.tab(); // wraps back to the first
    expect(one).toHaveFocus();
    await user.tab({ shift: true }); // wraps to the last
    expect(two).toHaveFocus();
  });

  it('restores focus to the trigger on close', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { rerender } = render(
      <Modal open onClose={() => {}} title="Confirm">
        <button>Ok</button>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'Ok' })).toHaveFocus();
    rerender(
      <Modal open={false} onClose={() => {}} title="Confirm">
        <button>Ok</button>
      </Modal>,
    );
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});

describe('within helper keeps dialog queries scoped', () => {
  it('finds content inside the dialog', () => {
    render(
      <Modal open onClose={() => {}} title="Scoped">
        <p>Inside body</p>
      </Modal>,
    );
    expect(within(screen.getByRole('dialog')).getByText('Inside body')).toBeInTheDocument();
  });
});
