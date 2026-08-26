/**
 * The window over a list the server capped somewhere the DOM cannot follow.
 *
 * `ListTruncationNote` is about the rows the server did not send. This is the
 * other end: the rows it did. `/grants` will answer with ten thousand and
 * `/comments` with five, and a surface that maps straight over the response
 * builds a node per row per cell — the grant register at its cap is roughly two
 * hundred thousand nodes, which does not render slowly so much as it stops.
 *
 * Three things are worth pinning, and none of them is "it slices an array":
 *
 *   - *which* end survives. A register is read from the top and a conversation
 *     from the bottom, and getting that backwards on the conversation hides the
 *     message somebody opened the panel for behind five hundred of history.
 *   - that the control says how many are hidden. A "Show more" over a list that
 *     looks complete is indistinguishable from a list that is complete, which
 *     is the same failure the truncation note exists to prevent, one layer in.
 *   - that it disappears when there is nothing held back, so a two-row list
 *     carries no furniture.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LIST_WINDOW_STEP, ShowMoreRows, useListWindow } from '../src/components/ui';

/** A harness that renders whatever the hook says to render, and nothing else. */
function Windowed({
  items,
  edge,
  step,
  label,
}: {
  items: string[];
  edge?: 'head' | 'tail';
  step?: number;
  label?: string;
}) {
  const { shown, hidden, showMore } = useListWindow(items, { edge, step });
  return (
    <div>
      <ul>
        {shown.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <ShowMoreRows hidden={hidden} step={step} noun="row" onMore={showMore} label={label} />
    </div>
  );
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${i}`);

describe('useListWindow', () => {
  it('renders the first step of a register and holds the rest back', () => {
    render(<Windowed items={rows(250)} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(LIST_WINDOW_STEP);
    expect(screen.getByText('row-0')).toBeInTheDocument();
    expect(screen.getByText(`row-${LIST_WINDOW_STEP - 1}`)).toBeInTheDocument();
    expect(screen.queryByText(`row-${LIST_WINDOW_STEP}`)).toBeNull();
    expect(screen.getByText('150 more rows not shown')).toBeInTheDocument();
  });

  it('widens by one step per press, and stops offering when it has caught up', async () => {
    const user = userEvent.setup();
    render(<Windowed items={rows(250)} step={100} />);

    await user.click(screen.getByRole('button', { name: 'Show 100 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(200);
    // The last press covers 50, not 100 — the button says what it will do.
    expect(screen.getByRole('button', { name: 'Show 50 more' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show 50 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(250);
    expect(screen.queryByTestId('show-more-rows')).toBeNull();
  });

  it('keeps the newest end of a conversation, not the oldest', async () => {
    // The whole point of `edge: 'tail'`. Windowing the head here would show a
    // reader the start of the thread and hide the reply they came to read.
    const user = userEvent.setup();
    render(<Windowed items={rows(150)} edge="tail" label="Show earlier messages" />);

    expect(screen.getByText('row-149')).toBeInTheDocument();
    expect(screen.getByText('row-50')).toBeInTheDocument();
    expect(screen.queryByText('row-49')).toBeNull();
    expect(screen.getByText('50 more rows not shown')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    expect(screen.getByText('row-0')).toBeInTheDocument();
    // Still the whole tail — widening adds to the front, it does not scroll.
    expect(screen.getByText('row-149')).toBeInTheDocument();
  });

  it('renders no control at all when everything fits', () => {
    render(<Windowed items={rows(3)} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByTestId('show-more-rows')).toBeNull();
  });

  it('hands back the same array when nothing is held back', () => {
    // Identity, not contents: a caller that memoizes on `shown` should not be
    // handed a fresh slice of an unwindowed list on every render.
    const items = rows(5);
    let seen: string[] | null = null;
    function Probe() {
      const { shown } = useListWindow(items);
      seen = shown;
      return null;
    }
    render(<Probe />);
    expect(seen).toBe(items);
  });
});

describe('ShowMoreRows', () => {
  it('counts the hidden rows, not the shown ones', () => {
    render(<ShowMoreRows hidden={7} noun="grant" onMore={() => {}} />);
    expect(screen.getByText('7 more grants not shown')).toBeInTheDocument();
  });

  it('says it in the singular for one', () => {
    render(<ShowMoreRows hidden={1} noun="grant" onMore={() => {}} />);
    expect(screen.getByText('1 more grant not shown')).toBeInTheDocument();
  });

  it('announces the count, since widening moves no focus', () => {
    render(<ShowMoreRows hidden={7} noun="grant" onMore={() => {}} />);
    expect(screen.getByText('7 more grants not shown')).toHaveAttribute('aria-live', 'polite');
  });

  it('takes an irregular plural', () => {
    render(<ShowMoreRows hidden={4} noun="entry" plural="entries" onMore={() => {}} />);
    expect(screen.getByText('4 more entries not shown')).toBeInTheDocument();
  });
});
