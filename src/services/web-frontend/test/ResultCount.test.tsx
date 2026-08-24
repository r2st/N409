import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResultCount } from '../src/components/ui';

/**
 * Typing in a filter box changes a list the typist is not looking at, and never
 * moves focus — so to a screen reader nothing happened. The count, the "no
 * matches" state, and the difference between eleven hits and none were all
 * silent. WCAG 2.2 SC 4.1.3.
 */
describe('ResultCount', () => {
  it('is a polite status region, offscreen', () => {
    render(<ResultCount count={3} noun="valuation" />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // Never assertive: it must not cut across the character being typed.
    expect(region).not.toHaveAttribute('aria-live', 'assertive');
    // The count is already on screen in the headings; this is the same fact
    // routed to the readers the headings do not reach.
    expect(region).toHaveClass('sr-only');
  });

  it('names the query back, so the answer says what it answers', () => {
    render(<ResultCount count={11} noun="valuation" query="acme" />);
    expect(screen.getByRole('status')).toHaveTextContent('11 valuations matching “acme”');
  });

  it('says none rather than zero', () => {
    render(<ResultCount count={0} noun="help article" query="zzz" />);
    expect(screen.getByRole('status')).toHaveTextContent('No help articles match “zzz”');
  });

  it('agrees with itself on a single result', () => {
    render(<ResultCount count={1} noun="field" query="dlom" />);
    expect(screen.getByRole('status')).toHaveTextContent('1 field matching “dlom”');
  });

  it('takes an irregular plural', () => {
    render(<ResultCount count={4} noun="person" plural="people" />);
    expect(screen.getByRole('status')).toHaveTextContent('4 people');
  });

  it('drops the query clause when there is no query', () => {
    render(<ResultCount count={7} noun="client" query="   " />);
    expect(screen.getByRole('status')).toHaveTextContent('7 clients');
    expect(screen.getByRole('status').textContent).not.toContain('matching');
  });

  /**
   * The detail the whole thing rests on. A live region inserted into the DOM
   * already holding its message is commonly not announced at all — the region
   * has to be observed before the mutation it reports. So `count={null}` (a
   * fetch in flight, a query too short to run) renders the region *empty*
   * rather than skipping the element.
   */
  it('still renders the region while there is no answer yet', () => {
    const { rerender } = render(<ResultCount count={null} noun="result" query="ac" />);
    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent('');

    rerender(<ResultCount count={2} noun="result" query="acme" />);
    // Same element, new text — which is the mutation a screen reader reports.
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('2 results matching “acme”');
  });
});
