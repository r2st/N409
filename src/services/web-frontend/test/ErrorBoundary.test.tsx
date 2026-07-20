import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

function Boom(): never {
  throw new Error('kaboom');
}

/** Top-level render error boundary (audit F-1 P1). */
describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('catches a render throw, reports it, and shows a recoverable fallback', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('renders a custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={(err) => <div>custom: {err.message}</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('custom: kaboom')).toBeInTheDocument();
  });

  it('recovers after "Try again" once the child stops throwing', async () => {
    let throwIt = true;
    function Controlled() {
      if (throwIt) throw new Error('boom');
      return <div>recovered</div>;
    }
    render(
      <ErrorBoundary onError={() => {}}>
        <Controlled />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    throwIt = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
