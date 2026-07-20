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
