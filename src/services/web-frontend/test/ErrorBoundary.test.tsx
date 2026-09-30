import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary, isChunkLoadError } from '../src/components/ErrorBoundary';

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

/**
 * A code-split chunk that would not load is not a bug in the page, and the
 * generic fallback told the user the wrong thing and then offered them a button
 * that could not work.
 *
 * Every page below the marketing entry is a `React.lazy` import, so a page
 * transition is a network fetch. When it fails — the build was replaced while
 * the tab was open and the hashed URL is gone, an intermediary served a stale
 * document, the connection dropped — `React.lazy` stores the rejection and
 * re-throws it on every later render without touching the network. "Try again"
 * clears this boundary and re-renders the same children, so it reproduced the
 * same screen for as long as the user was willing to press it.
 */
describe('a chunk that would not load', () => {
  const chunkThrower = (message: string, name = 'Error') =>
    function ChunkBoom(): never {
      const err = new Error(message);
      err.name = name;
      throw err;
    };

  it.each([
    ['Chrome', 'Failed to fetch dynamically imported module: https://409.doaide.com/assets/Dashboard-a1b2c3.js'],
    ['Firefox', 'error loading dynamically imported module: https://409.doaide.com/assets/Dashboard-a1b2c3.js'],
    ['Safari', 'Importing a module script failed.'],
  ])('names the real cause on %s instead of "something went wrong"', (_engine, message) => {
    const Thrower = chunkThrower(message);
    render(
      <ErrorBoundary onError={() => {}}>
        <Thrower />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/didn’t finish loading/)).toBeInTheDocument();
    expect(screen.getByText(/a new version was released/)).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('offers only Reload, because Try again cannot clear a cached rejection', () => {
    const Thrower = chunkThrower('Failed to fetch dynamically imported module: /assets/X-1.js');
    render(
      <ErrorBoundary onError={() => {}}>
        <Thrower />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('still reports it, so the deploy that caused it is visible in telemetry', () => {
    const onError = vi.fn();
    const Thrower = chunkThrower('Importing a module script failed.');
    render(
      <ErrorBoundary onError={onError}>
        <Thrower />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledOnce();
  });

  it('leaves a genuine page bug on the generic fallback, with Try again intact', () => {
    render(
      <ErrorBoundary onError={() => {}}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://409.doaide.com/assets/a.js',
    'error loading dynamically imported module: https://409.doaide.com/assets/a.js',
    'Importing a module script failed.',
    'Loading chunk 42 failed.',
  ])('recognises %s', (message) => expect(isChunkLoadError(new Error(message))).toBe(true));

  it('recognises a ChunkLoadError by name whatever it says', () => {
    const err = new Error('anything at all');
    err.name = 'ChunkLoadError';
    expect(isChunkLoadError(err)).toBe(true);
  });

  it.each([
    'kaboom',
    "Cannot read properties of undefined (reading 'shares')",
    'Failed to fetch',
    'NetworkError when attempting to fetch resource.',
  ])('does not claim %s', (message) => expect(isChunkLoadError(new Error(message))).toBe(false));
});
