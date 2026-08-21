import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button, Select, TextInput, WriteGate } from '../src/components/ui';

/**
 * The primitive the workspace's retired tabs are closed with.
 *
 * It is a `fieldset disabled`, and everything about it rests on the browser's
 * inherited disabled state — so the thing worth pinning is not the markup but
 * the inheritance: a control nobody passed a prop to is still closed, and a
 * click on it does nothing. If a future refactor swaps the fieldset for a
 * context or a prop, these are the assertions that notice the difference.
 */

function Probe({ closed }: { closed: boolean }) {
  const [clicks, setClicks] = useState(0);
  return (
    <div>
      <WriteGate closed={closed}>
        <TextInput aria-label="Decision" defaultValue="" />
        <Select aria-label="Category">
          <option value="a">A</option>
        </Select>
        <textarea aria-label="Rationale" />
        <Button onClick={() => setClicks((c) => c + 1)}>Record decision</Button>
      </WriteGate>
      <span data-testid="clicks">{clicks}</span>
    </div>
  );
}

describe('WriteGate', () => {
  it('closes every control beneath it without any of them being told', () => {
    render(<Probe closed />);
    expect(screen.getByLabelText('Decision')).toBeDisabled();
    expect(screen.getByLabelText('Category')).toBeDisabled();
    expect(screen.getByLabelText('Rationale')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Record decision' })).toBeDisabled();
  });

  it('leaves them alone when it is open — the vacuity guard', () => {
    render(<Probe closed={false} />);
    expect(screen.getByLabelText('Decision')).toBeEnabled();
    expect(screen.getByLabelText('Category')).toBeEnabled();
    expect(screen.getByLabelText('Rationale')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record decision' })).toBeEnabled();
  });

  it('swallows the click, not just the styling', async () => {
    const user = userEvent.setup();
    render(<Probe closed />);
    await user.click(screen.getByRole('button', { name: 'Record decision' }));
    expect(screen.getByTestId('clicks')).toHaveTextContent('0');
  });

  it('stays out of the layout so wrapping a region moves nothing', () => {
    const { container } = render(<Probe closed />);
    // `display: contents` is the only reason an existing grid/flex parent keeps
    // laying its children out as it did before the wrapper appeared.
    expect(container.querySelector('fieldset')).toHaveClass('contents');
  });
});
