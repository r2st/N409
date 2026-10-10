import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  it('renders WhatsApp, email, LinkedIn, and copy buttons', () => {
    renderBar();
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    expect(screen.getByText('Email result')).toBeTruthy();
    expect(screen.getByText('LinkedIn')).toBeTruthy();
    expect(screen.getByText('Copy')).toBeTruthy();
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
    const link = screen.getByText('LinkedIn').closest('a');
    expect(link?.getAttribute('href')).toContain('linkedin.com/sharing');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('renders the copy button', () => {
    renderBar();
    const btn = screen.getByText('Copy');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('builds a WhatsApp share link', () => {
    renderBar({ whatsappText: 'Check this out!' });
    const link = screen.getByText('WhatsApp').closest('a');
    expect(link?.getAttribute('href')).toContain('wa.me');
    expect(link?.getAttribute('target')).toBe('_blank');
  });
});
