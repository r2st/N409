import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { useClearOnChange } from '../src/lib/useClearOnChange';

/**
 * The three properties the call sites depend on: nothing fires on the first
 * run, re-asking the same question keeps the answer (which is what makes the
 * hook safe on a loader shared with a poll), and a different question drops it.
 */
function Harness({ onClear }: { onClear: () => void }) {
  const [question, setQuestion] = useState('open');
  const [nudge, setNudge] = useState(0);
  useClearOnChange(question, onClear);
  return (
    <div>
      <output>{`${question}#${nudge}`}</output>
      <button onClick={() => setQuestion('resolved')}>ask something else</button>
      <button onClick={() => setQuestion(question)}>ask the same thing</button>
      <button onClick={() => setNudge((n) => n + 1)}>re-render</button>
    </div>
  );
}

describe('useClearOnChange', () => {
  it('does not clear on the first run', () => {
    const clear = vi.fn();
    render(<Harness onClear={clear} />);
    expect(clear).not.toHaveBeenCalled();
  });

  it('clears once when the question changes', async () => {
    const clear = vi.fn();
    render(<Harness onClear={clear} />);
    await userEvent.click(screen.getByRole('button', { name: 'ask something else' }));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe('resolved#0');
  });

  it('leaves the answer alone when the same question is re-asked', async () => {
    const clear = vi.fn();
    render(<Harness onClear={clear} />);
    await userEvent.click(screen.getByRole('button', { name: 'ask the same thing' }));
    await userEvent.click(screen.getByRole('button', { name: 're-render' }));
    await userEvent.click(screen.getByRole('button', { name: 're-render' }));
    // This is the property the job monitor's 15-second poll rests on: a loader
    // re-issued for the same question must not blank the feed.
    expect(clear).not.toHaveBeenCalled();
  });

  it('reads the latest callback rather than the one from the first render', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onClear={first} />);
    rerender(<Harness onClear={second} />);
    await userEvent.click(screen.getByRole('button', { name: 'ask something else' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clears again on each further change of the question', async () => {
    const clear = vi.fn();
    function Cycle() {
      const [q, setQ] = useState('a');
      useClearOnChange(q, clear);
      return <button onClick={() => setQ((v) => v + 'x')}>next</button>;
    }
    render(<Cycle />);
    const next = screen.getByRole('button', { name: 'next' });
    await userEvent.click(next);
    await userEvent.click(next);
    await userEvent.click(next);
    expect(clear).toHaveBeenCalledTimes(3);
  });
});
