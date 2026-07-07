import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StateBadge, KindBadge, StatCard } from '../src/components/ui';

describe('ui primitives', () => {
  it('renders human labels for lifecycle states', () => {
    render(<StateBadge state="draft_changes" />);
    expect(screen.getByText('Changes requested')).toBeInTheDocument();
  });

  it('renders kind labels', () => {
    render(<KindBadge kind="409a" />);
    expect(screen.getByText('IRC §409A')).toBeInTheDocument();
  });

  it('renders stat cards with label and value', () => {
    render(<StatCard label="Published" value={12} />);
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });
});
