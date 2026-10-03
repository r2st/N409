import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { ComplianceCheckerPage } from '../src/pages/marketing/ComplianceCheckerPage';

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/tools/409a-compliance-checker']}>
        <Routes>
          <Route path="/tools/409a-compliance-checker" element={<ComplianceCheckerPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

async function answerAll(user: ReturnType<typeof userEvent.setup>, answers: boolean[]) {
  const buttons = screen.getAllByRole('button');
  const yesButtons = buttons.filter((b) => b.textContent === 'Yes');
  const noButtons = buttons.filter((b) => b.textContent === 'No');

  for (let i = 0; i < answers.length; i++) {
    await user.click(answers[i] ? yesButtons[i]! : noButtons[i]!);
  }
}

describe('ComplianceCheckerPage', () => {
  it('renders the heading and all five questions', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('409A Compliance Checker');
    expect(screen.getByTestId('question-has_409a')).toBeTruthy();
    expect(screen.getByTestId('question-within_12m')).toBeTruthy();
    expect(screen.getByTestId('question-material_event')).toBeTruthy();
    expect(screen.getByTestId('question-independent')).toBeTruthy();
    expect(screen.getByTestId('question-granting_options')).toBeTruthy();
  });

  it('shows empty state before all questions are answered', () => {
    renderPage();
    expect(screen.getByText(/Answer all five questions/)).toBeTruthy();
  });

  it('shows compliant when all answers are favorable', async () => {
    const user = userEvent.setup();
    renderPage();
    // has_409a=yes, within_12m=yes, material_event=no, independent=yes, granting_options=no
    await answerAll(user, [true, true, false, true, false]);

    const result = screen.getByTestId('compliance-result');
    expect(result).toHaveTextContent('Compliant');
  });

  it('shows non-compliant when no 409A exists', async () => {
    const user = userEvent.setup();
    renderPage();
    // has_409a=no, within_12m=no, material_event=no, independent=no, granting_options=no
    await answerAll(user, [false, false, false, false, false]);

    const result = screen.getByTestId('compliance-result');
    expect(result).toHaveTextContent('Not compliant');
  });

  it('shows at-risk when valuation is stale', async () => {
    const user = userEvent.setup();
    renderPage();
    // has_409a=yes, within_12m=no, material_event=no, independent=yes, granting_options=no
    await answerAll(user, [true, false, false, true, false]);

    const result = screen.getByTestId('compliance-result');
    expect(result).toHaveTextContent('At risk');
  });

  it('shows action required when stale and granting soon', async () => {
    const user = userEvent.setup();
    renderPage();
    // has_409a=yes, within_12m=no, material_event=no, independent=yes, granting_options=yes
    await answerAll(user, [true, false, false, true, true]);

    const result = screen.getByTestId('compliance-result');
    expect(result).toHaveTextContent('Action required');
  });

  it('shows partially compliant when not independent', async () => {
    const user = userEvent.setup();
    renderPage();
    // has_409a=yes, within_12m=yes, material_event=no, independent=no, granting_options=no
    await answerAll(user, [true, true, false, false, false]);

    const result = screen.getByTestId('compliance-result');
    expect(result).toHaveTextContent('Partially compliant');
  });

  it('renders share bar when result is shown', async () => {
    const user = userEvent.setup();
    renderPage();
    await answerAll(user, [true, true, false, true, false]);
    expect(screen.getByText('Share with your CFO')).toBeTruthy();
  });
});
