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

const FILES = walk(SRC).map((file) => {
  const text = readFileSync(file, 'utf8');
  return { file: path.relative(SRC, file), text, lines: text.split('\n') };
});

/**
 * The other way an error message reaches a reader: it is not announced when it
 * appears, it is part of the *name* of the box it belongs to, and the reader
 * hears it on arriving there.
 *
 * `Field` does this for the controls it wraps, and a handful of call sites do
 * it by hand because their control cannot be a `Field` — the branding colour
 * boxes are a colour picker and a hex box for one value, and a <label> owning
 * two inputs is ambiguous. Those are correctly wired, and adding `role=alert`
 * on top would announce the message twice.
 *
 * The test is the pairing rather than the presence: the node carries an `id`,
 * and that same identifier is what some `aria-describedby` in the file points
 * at. An `id` on its own proves nothing.
 */
function describedByInFile(text: string, context: string): boolean {
  const declared = /\bid=\{([A-Za-z0-9_$.]+)\}/.exec(context)?.[1];
  if (!declared) return false;
  const pointers = text.match(/aria-describedby=\{[^}]*\}/g) ?? [];
  return pointers.some((p) => new RegExp(`\\b${declared.replace('.', '\\.')}\\b`).test(p));
}

describe('every rendered error message reaches a screen reader', () => {
  /**
   * The source-level half, so a fifth one cannot be added quietly. An element
   * styled as an error and rendering an error-shaped variable must sit in a
   * live region — its own `role="alert"`, one a line or two up, or `Field`'s
   * error slot, which is reached instead through `aria-describedby`.
   */
  it('gives every red error node a live region or a described-by', () => {
    const offenders: string[] = [];
    for (const { file, text, lines } of FILES) {
      // `Field` is the one place that wires an error the other way, via
      // aria-describedby on the control it belongs to.
      if (file === 'components/ui.tsx') continue;
      lines.forEach((line, i) => {
        if (!/text-red-[5-9]00/.test(line)) return;
        const context = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        if (/role="(alert|status)"/.test(context)) return;
        if (!/\{(\w*[Ee]rror\w*|\w*[Mm]essage\w*)\}/.test(context)) return;
        if (describedByInFile(text, context)) return;
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
