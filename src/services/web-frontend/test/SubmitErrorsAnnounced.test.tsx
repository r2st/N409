import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { SavedViews } from '../src/components/SavedViews';

/**
 * A failure that answers something the user just did has to be announced, not
 * only painted.
 *
 * `ErrorNote` — which most of the product uses — is a `role="alert"`, so it
 * carries. Four surfaces rendered the same kind of message as a bare styled
 * span instead: the saved-view picker, the inbox reply box, the partner pin
 * control and the scenario save box. In each, the message appears after a
 * button press, by which time focus is on the button that failed and the text
 * has been painted somewhere the reader is not looking. A screen reader said
 * nothing at all, so the action simply seemed not to have happened.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file),
  lines: readFileSync(file, 'utf8').split('\n'),
}));

describe('every rendered error message reaches a screen reader', () => {
  /**
   * The source-level half, so a fifth one cannot be added quietly. An element
   * styled as an error and rendering an error-shaped variable must sit in a
   * live region — its own `role="alert"`, one a line or two up, or `Field`'s
   * error slot, which is reached instead through `aria-describedby`.
   */
  it('gives every red error node a live region or a described-by', () => {
    const offenders: string[] = [];
    for (const { file, lines } of FILES) {
      // `Field` is the one place that wires an error the other way, via
      // aria-describedby on the control it belongs to.
      if (file === 'components/ui.tsx') continue;
      lines.forEach((line, i) => {
        if (!/text-red-[5-9]00/.test(line)) return;
        const context = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        if (/role="(alert|status)"/.test(context)) return;
        if (!/\{(\w*[Ee]rror\w*|\w*[Mm]essage\w*)\}/.test(context)) return;
        offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('SavedViews announces a save that failed', () => {
  beforeEach(() => vi.restoreAllMocks());

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /**
   * The behavioural half, on the surface where the gap mattered most: the user
   * is in a dialog, presses "Save view", the dialog closes and the only sign
   * that nothing was saved is eight words beside a dropdown behind it.
   */
  it('puts the failure in a live region rather than beside the picker', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        return jsonResponse({ title: 'Conflict', detail: 'A view with that name exists.' }, 409);
      }
      return jsonResponse({ views: [] });
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/valuations?state=in_progress']}>
        <AuthProvider>
          <SavedViews />
        </AuthProvider>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /Save/ }));
    await user.type(await screen.findByRole('textbox'), 'My view');
    await user.click(screen.getByRole('button', { name: 'Save view' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A view with that name exists.');
  });
});
