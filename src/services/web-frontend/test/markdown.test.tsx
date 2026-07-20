import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Markdown } from '../src/lib/markdown';

function renderMd(source: string) {
  return render(
    <MemoryRouter>
      <Markdown source={source} />
    </MemoryRouter>,
  );
}

describe('Markdown', () => {
  it('renders headings, paragraphs and inline emphasis', () => {
    renderMd('# Title\n\nSome **bold** text.');
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('bold')).toBeInTheDocument();
  });

  it('renders unordered and ordered lists', () => {
    renderMd('- one\n- two\n\n1. first\n2. second');
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('routes internal links through react-router and opens external links safely', () => {
    renderMd('See [the guide](/help/methodology-overview) and [the IRS](https://irs.gov).');
    const internal = screen.getByRole('link', { name: 'the guide' });
    expect(internal).toHaveAttribute('href', '/help/methodology-overview');
    const external = screen.getByRole('link', { name: 'the IRS' });
    expect(external).toHaveAttribute('href', 'https://irs.gov');
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noreferrer');
  });

  it('does not render raw HTML from the source', () => {
    renderMd('A <script>alert(1)</script> line.');
    // The angle-bracket text is escaped by React, never a real element.
    expect(document.querySelector('script')).toBeNull();
  });
});
