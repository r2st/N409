import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ShareResultBar } from '../src/components/ShareResultBar';

function renderBar(props?: Partial<React.ComponentProps<typeof ShareResultBar>>) {
  return render(
    <MemoryRouter>
      <ShareResultBar
        title="Test title"
        text="Test result text"
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('ShareResultBar', () => {
  it('renders email, LinkedIn, and copy buttons', () => {
    renderBar();
    expect(screen.getByText('Email result')).toBeTruthy();
    expect(screen.getByText('Share on LinkedIn')).toBeTruthy();
    expect(screen.getByText('Copy result')).toBeTruthy();
  });

  it('uses custom email label', () => {
    renderBar({ emailLabel: 'Send to CFO' });
    expect(screen.getByText('Send to CFO')).toBeTruthy();
  });

  it('builds a mailto link with subject and body', () => {
    renderBar({ emailSubject: 'My Subject', text: 'My body' });
    const link = screen.getByText('Email result').closest('a');
    expect(link?.getAttribute('href')).toContain('mailto:');
    expect(link?.getAttribute('href')).toContain('My%20Subject');
  });

  it('builds a LinkedIn share link', () => {
    renderBar();
    const link = screen.getByText('Share on LinkedIn').closest('a');
    expect(link?.getAttribute('href')).toContain('linkedin.com/sharing');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('renders the copy button', () => {
    renderBar();
    const btn = screen.getByText('Copy result');
    expect(btn.tagName).toBe('BUTTON');
  });
});
