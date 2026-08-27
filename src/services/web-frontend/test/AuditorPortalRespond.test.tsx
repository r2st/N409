import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditorPortalPage } from '../src/pages/AuditorPortalPage';

/**
 * The end of the auditor journey, which used to be a wall.
 *
 * The portal served a report, a conclusion, the assumptions and the QA record
 * to an outside reviewer and gave them nowhere to put the answer. Every other
 * route into the engagement needs an account, and an auditor is the one reader
 * defined by not having one — so the journey ended on a read-only page, and a
 * reviewer who found a problem had to leave the product entirely.
 *
 * The other half of the same wall was the page's silence about what it was not
 * showing: `report: null` rendered as no section at all, which to someone
 * holding a link they were sent reads as a broken page rather than as a
 * document that is not ready.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BUNDLE = {
  valuation: {
    number: '1042',
    company_name: 'Acme Robotics, Inc.',
    kind: '409a',
    state: 'drafted',
    currency: 'USD',
  },
  report: null,
  report_status: 'not_shared' as const,
  can_submit_notes: true,
  assumptions: null,
  conclusion: null,
  qa: [],
  evidence_summary: {
    has_report: false,
    has_conclusion: false,
    qa_count: 0,
    qa_truncated: false,
    assumptions_recorded: false,
  },
  access_expires_at: '2030-01-01T00:00:00Z',
};

/**
 * One fetch stub for both calls the page makes: the bundle on mount, and the
 * note on submit. Returns the calls so a test can assert what was sent.
 */
function mountWith(
  bundle: Record<string, unknown> = BUNDLE,
  noteReply: () => Response = () =>
    jsonResponse({
      note: {
        disposition: 'change_requested',
        heading: 'Auditor requested a change',
        from: 'Auditor · PwC',
        body: 'Exhibit C uses 22%; the term sheet says 25%.',
        created_at: '2026-08-27T00:00:00Z',
      },
    }, 201),
) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).endsWith('/notes')) return Promise.resolve(noteReply());
    return Promise.resolve(jsonResponse(bundle));
  }) as typeof fetch);
  window.location.hash = '#token=abc123';
  render(<AuditorPortalPage />);
  return calls;
}

describe('the auditor can respond', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    window.location.hash = '';
  });

  it('sends a change request and shows the auditor what was recorded', async () => {
    const user = userEvent.setup();
    const calls = mountWith();
    await waitFor(() => expect(screen.getByText('Respond')).toBeInTheDocument());

    await user.click(screen.getByRole('radio', { name: /Request a change/i }));
    await user.type(
      screen.getByRole('textbox', { name: /Your note/i }),
      'Exhibit C uses 22%; the term sheet says 25%.',
    );
    await user.click(screen.getByRole('button', { name: /Send to the engagement team/i }));

    // The token comes from the link fragment, not from a session.
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/notes'))).toMatchObject({
        body: {
          token: 'abc123',
          disposition: 'change_requested',
          body: 'Exhibit C uses 22%; the term sheet says 25%.',
        },
      }),
    );

    // Echoed back rather than the box merely clearing: a submission whose only
    // feedback is an empty form is one the sender cannot tell landed, and the
    // obvious response to that is to send it again.
    const sent = await screen.findByTestId('auditor-note-sent');
    expect(sent).toHaveTextContent('Auditor requested a change');
    expect(sent).toHaveTextContent('Exhibit C uses 22%');
    expect(screen.getByRole('textbox', { name: /Your note/i })).toHaveValue('');
  });

  it('keeps the text when the send fails, so the note can be retried not rewritten', async () => {
    const user = userEvent.setup();
    mountWith(BUNDLE, () => jsonResponse({ detail: 'This auditor link is invalid, expired, or revoked' }, 401));
    await waitFor(() => expect(screen.getByText('Respond')).toBeInTheDocument());

    const box = screen.getByRole('textbox', { name: /Your note/i });
    await user.type(box, 'The DLOM study is not cited.');
    await user.click(screen.getByRole('button', { name: /Send to the engagement team/i }));

    // The server's own words, not a generic failure: an auditor whose link was
    // revoked needs to know to ask for a new one, and this page is the only
    // place that can tell them.
    expect(await screen.findByText(/invalid, expired, or revoked/i)).toBeInTheDocument();
    expect(box).toHaveValue('The DLOM study is not cited.');
    expect(screen.queryByTestId('auditor-note-sent')).toBeNull();
  });

  it('says what each disposition will and will not do before it is used', async () => {
    const user = userEvent.setup();
    mountWith();
    await waitFor(() => expect(screen.getByText('Respond')).toBeInTheDocument());

    // "Record your sign-off" beside a valuation report is exactly the control
    // someone expects to publish something. It does not, and the page says so
    // while they are choosing rather than after they have clicked.
    await user.click(screen.getByRole('radio', { name: /Record your sign-off/i }));
    expect(screen.getByText(/does not publish or approve anything itself/i)).toBeInTheDocument();
  });

  it('names the empty box rather than sending nothing or disabling the button', async () => {
    // The convention the rest of the product uses, and it matters more here:
    // a disabled control says something is wrong without saying what, to a
    // reader with no account to ask from.
    const user = userEvent.setup();
    const calls = mountWith();
    await waitFor(() => expect(screen.getByText('Respond')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Send to the engagement team/i }));
    expect(await screen.findByText(/Your note is required/i)).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith('/notes'))).toHaveLength(0);
  });

  it('hides the form on an engagement that can no longer take a note', async () => {
    // A retired engagement refuses the POST. Offering a form whose submit is
    // always refused is the inverse of the dead end this closes.
    mountWith({ ...BUNDLE, can_submit_notes: false });
    await waitFor(() => expect(screen.getByText('Acme Robotics, Inc.')).toBeInTheDocument());
    expect(screen.queryByText('Respond')).toBeNull();
  });
});

describe('the portal explains what it is not showing', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    window.location.hash = '';
  });

  it('says a report has not been shared yet rather than rendering nothing', async () => {
    mountWith();
    const note = await screen.findByTestId('auditor-report-absent');
    expect(note).toHaveTextContent(/has not been shared yet/i);
    // And that the wait does not cost them a new link — the reason an auditor
    // would otherwise write to ask.
    expect(note).toHaveTextContent(/without you needing a new link/i);
  });

  it('distinguishes a report nobody has written from one not yet shared', async () => {
    mountWith({ ...BUNDLE, report_status: 'not_started' });
    const note = await screen.findByTestId('auditor-report-absent');
    expect(note).toHaveTextContent(/no version has been written yet/i);
    expect(note).not.toHaveTextContent(/has not been shared yet/i);
  });

  it('stays silent about the reason when the server did not give one', async () => {
    // A bundle from a build that predates `report_status`. Guessing a reason
    // would be worse than the silence: telling an auditor a report is unwritten
    // when it is merely unshared sends them to ask the wrong question.
    const { report_status: _drop, ...older } = BUNDLE;
    mountWith(older);
    await waitFor(() => expect(screen.getByText('Acme Robotics, Inc.')).toBeInTheDocument());
    expect(screen.queryByTestId('auditor-report-absent')).toBeNull();
  });
});
