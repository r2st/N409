import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentsPanel, MAX_DOCUMENT_BYTES } from '../src/components/valuation/DocumentsPanel';
import type { ValuationDocument } from '../src/lib/pipeline';

const VAL_ID = '01N409VAL000000000000000AA';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

function doc(id: string, filename: string): ValuationDocument {
  return {
    id,
    valuation_id: VAL_ID,
    kind: 'other',
    filename,
    content_type: 'text/plain',
    size_bytes: 12,
    sha256: 'x'.repeat(64),
    uploaded_by: null,
    created_at: '2026-01-05T10:00:00.000Z',
  };
}

/** A File of a stated size, without allocating the bytes behind it. */
function sizedFile(name: string, bytes: number): File {
  const file = new File(['x'], name, { type: 'text/plain' });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

/**
 * Mocks the two calls the panel makes: the document list, and the upload.
 * `uploads` responds per filename so a batch can partly fail.
 */
function mockApi(uploads: Record<string, () => Response> = {}) {
  const uploaded: string[] = [];
  let listed: ValuationDocument[] = [];
  let listCalls = 0;

  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';

    if (method === 'GET' && path.endsWith(`/valuations/${VAL_ID}/documents`)) {
      listCalls += 1;
      return jsonResponse({ documents: listed });
    }
    if (method === 'POST' && path.endsWith(`/valuations/${VAL_ID}/documents`)) {
      const form = init?.body as FormData;
      const name = (form.get('file') as File).name;
      const responder = uploads[name];
      if (responder) return responder();
      uploaded.push(name);
      listed = [...listed, doc(`01N409DOC${uploaded.length}`, name)];
      return jsonResponse({ document: listed.at(-1), pipeline_run: null }, 201);
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  });

  return { fetchMock, uploaded, listCalls: () => listCalls };
}

async function pick(files: File[]) {
  const input = screen.getByTestId('file-input') as HTMLInputElement;
  await userEvent.upload(input, files);
}

describe('DocumentsPanel upload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads every file in a batch', async () => {
    const api = mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');

    await pick([sizedFile('a.pdf', 10), sizedFile('b.pdf', 10), sizedFile('c.pdf', 10)]);

    await waitFor(() => expect(api.uploaded).toEqual(['a.pdf', 'b.pdf', 'c.pdf']));
    expect(await screen.findByText('c.pdf')).toBeInTheDocument();
  });

  /**
   * The behaviour this panel got wrong. The loop aborted on the first
   * rejection, so a batch with one bad file in the middle silently dropped
   * everything after it and reported only "Upload failed."
   */
  it('finishes the batch when one file is rejected, and names the one that failed', async () => {
    const api = mockApi({
      'bad.exe': () => problem(422, 'Rejected upload: content does not match .exe'),
    });
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');

    await pick([sizedFile('a.pdf', 10), sizedFile('bad.exe', 10), sizedFile('c.pdf', 10)]);

    // The files either side of the failure still went up.
    await waitFor(() => expect(api.uploaded).toEqual(['a.pdf', 'c.pdf']));
    expect(await screen.findByText(/bad\.exe/)).toHaveTextContent(
      'bad.exe — Rejected upload: content does not match .exe',
    );
    expect(screen.getByText('1 file was not uploaded')).toBeInTheDocument();
  });

  it('lists every failure when several files fail', async () => {
    const api = mockApi({
      'one.exe': () => problem(422, 'Rejected upload: bad type'),
      'two.exe': () => problem(500, 'Something broke'),
    });
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');

    await pick([sizedFile('one.exe', 10), sizedFile('two.exe', 10), sizedFile('ok.pdf', 10)]);

    expect(await screen.findByText('2 files were not uploaded')).toBeInTheDocument();
    expect(screen.getByText(/one\.exe/)).toBeInTheDocument();
    expect(screen.getByText(/two\.exe/)).toBeInTheDocument();
    await waitFor(() => expect(api.uploaded).toEqual(['ok.pdf']));
  });

  /**
   * The server can only refuse a file it has already received, so an oversize
   * file otherwise costs a full upload — and holds up the rest of the batch
   * behind it — before being told no.
   */
  it('refuses an oversize file without uploading it, and uploads the rest', async () => {
    const api = mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');

    await pick([sizedFile('huge.pdf', MAX_DOCUMENT_BYTES + 1), sizedFile('fine.pdf', 10)]);

    await waitFor(() => expect(api.uploaded).toEqual(['fine.pdf']));
    expect(await screen.findByText(/huge\.pdf/)).toHaveTextContent(/over the 25 MB limit/);
  });

  it('accepts a file exactly on the limit', async () => {
    const api = mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');

    await pick([sizedFile('exactly.pdf', MAX_DOCUMENT_BYTES)]);

    await waitFor(() => expect(api.uploaded).toEqual(['exactly.pdf']));
  });

  it('refuses an empty file locally rather than letting the server 422 it', async () => {
    const api = mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');

    await pick([sizedFile('empty.pdf', 0)]);

    expect(await screen.findByText(/empty\.pdf/)).toHaveTextContent('the file is empty');
    expect(api.uploaded).toEqual([]);
  });

  it('does not re-read the list when nothing uploaded', async () => {
    // A batch that failed outright has not changed the list, and refetching
    // it only makes the failure blink.
    const api = mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');
    const before = api.listCalls();

    await pick([sizedFile('empty.pdf', 0)]);
    await screen.findByText(/empty\.pdf/);

    expect(api.listCalls()).toBe(before);
  });

  it('clears the previous batch’s failures when a new batch starts', async () => {
    const api = mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');

    await pick([sizedFile('empty.pdf', 0)]);
    await screen.findByText('1 file was not uploaded');

    await pick([sizedFile('good.pdf', 10)]);
    await waitFor(() => expect(api.uploaded).toEqual(['good.pdf']));
    expect(screen.queryByText('1 file was not uploaded')).not.toBeInTheDocument();
  });

  /**
   * `<input type="file">` fires no change event when the same file is chosen
   * twice, so without clearing the input the retry after a fix is a click that
   * does nothing at all.
   */
  it('lets the same file be selected again after it was rejected', async () => {
    const api = mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');
    const input = screen.getByTestId('file-input') as HTMLInputElement;

    await pick([sizedFile('retry.pdf', 0)]);
    await screen.findByText(/retry\.pdf/);
    expect(input.value).toBe('');

    await pick([sizedFile('retry.pdf', 10)]);
    await waitFor(() => expect(api.uploaded).toEqual(['retry.pdf']));
  });

  it('says the limit the panel actually enforces', async () => {
    mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    expect(await screen.findByText(/max 25 MB each/)).toBeInTheDocument();
  });

  it('names the type files will upload as, and follows the picker', async () => {
    mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');

    expect(screen.getByText(/Drag & drop files here/)).toHaveTextContent('upload as Other');
    await userEvent.selectOptions(screen.getByLabelText('Document type'), 'cap_table');
    expect(screen.getByText(/Drag & drop files here/)).toHaveTextContent('upload as Cap table');
  });

  it('reports which file of how many is in flight', async () => {
    let release: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ documents: [] });
      return new Promise<Response>((resolve) => (release = resolve));
    });
    render(<DocumentsPanel valuationId={VAL_ID} />);
    await screen.findByText('No documents yet');

    const pending = pick([sizedFile('a.pdf', 10), sizedFile('b.pdf', 10)]);
    expect(await screen.findByRole('status')).toHaveTextContent('Uploading 1 of 2 — a.pdf');
    release(jsonResponse({ document: doc('d1', 'a.pdf') }, 201));
    expect(await screen.findByRole('status')).toHaveTextContent('Uploading 2 of 2 — b.pdf');
    release(jsonResponse({ document: doc('d2', 'b.pdf') }, 201));
    await pending;
  });

  it('says so when the drop was a folder rather than files', async () => {
    mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    const zone = await screen.findByText(/Drag & drop files here/);

    fireEvent.drop(zone, { dataTransfer: { files: [] } });

    expect(await screen.findByText(/drop files rather than a folder/i)).toBeInTheDocument();
  });

  it('highlights the dropzone while a drag is over it', async () => {
    mockApi();
    render(<DocumentsPanel valuationId={VAL_ID} />);
    const zone = await screen.findByText(/Drag & drop files here/);

    fireEvent.dragOver(zone);
    expect(zone.className).toContain('border-bond-500');
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toContain('border-bond-500');
  });
});

describe('DocumentsPanel list', () => {
  beforeEach(() => vi.restoreAllMocks());

  /** Serves a fixed list, and records the writes made against it. */
  function mockList(
    documents: ValuationDocument[],
    hooks: { del?: () => Response; review?: () => Response; download?: () => Response } = {},
  ) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      calls.push({
        url: path,
        method,
        body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (path.includes('/download')) {
        return (
          hooks.download ??
          (() =>
            new Response(new Blob(['pdf']), {
              status: 200,
              headers: { 'content-disposition': 'attachment; filename="cap-table.pdf"' },
            }))
        )();
      }
      if (path.includes('/review')) return (hooks.review ?? (() => jsonResponse({ ok: true })))();
      if (method === 'DELETE') return (hooks.del ?? (() => jsonResponse({ ok: true })))();
      return jsonResponse({ documents });
    });
    return calls;
  }

  it('names each row’s controls after the file they act on', async () => {
    mockList([doc('d1', 'cap-table.pdf'), doc('d2', 'financials.xlsx')]);
    render(<DocumentsPanel valuationId={VAL_ID} />);

    expect(await screen.findByRole('button', { name: 'Download cap-table.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete financials.xlsx' })).toBeInTheDocument();
  });

  it('asks before deleting, and does nothing if the answer is no', async () => {
    const calls = mockList([doc('d1', 'cap-table.pdf')]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DocumentsPanel valuationId={VAL_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete cap-table.pdf' }));

    expect(confirm).toHaveBeenCalledWith('Remove "cap-table.pdf"?');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('deletes on confirmation', async () => {
    const calls = mockList([doc('d1', 'cap-table.pdf')]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DocumentsPanel valuationId={VAL_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete cap-table.pdf' }));

    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1));
  });

  it('surfaces a delete the server refused', async () => {
    mockList([doc('d1', 'cap-table.pdf')], {
      del: () => problem(403, 'Documents cannot be removed after publication.'),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DocumentsPanel valuationId={VAL_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete cap-table.pdf' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Documents cannot be removed after publication.',
    );
  });

  it('surfaces a failed download', async () => {
    mockList([doc('d1', 'cap-table.pdf')], { download: () => problem(404, 'That file is gone.') });
    render(<DocumentsPanel valuationId={VAL_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Download cap-table.pdf' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That file is gone.');
  });

  it('hides the review mark from anyone who cannot review', async () => {
    mockList([doc('d1', 'cap-table.pdf')]);
    render(<DocumentsPanel valuationId={VAL_ID} />);

    await screen.findByText('cap-table.pdf');
    expect(screen.queryByRole('button', { name: /Mark .* reviewed/ })).not.toBeInTheDocument();
  });

  it('marks a document reviewed at once, and tells the workspace', async () => {
    const calls = mockList([doc('d1', 'cap-table.pdf')]);
    const onReviewed = vi.fn();
    render(<DocumentsPanel valuationId={VAL_ID} canReview onReviewed={onReviewed} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Mark cap-table.pdf reviewed' }));

    // Optimistic — the row flips before the round trip returns.
    expect(screen.getByText('reviewed')).toBeInTheDocument();
    await waitFor(() => expect(onReviewed).toHaveBeenCalled());
    expect(calls.find((c) => c.url.includes('/review'))!.body).toEqual({ reviewed: true });
  });

  it('reopens a reviewed document', async () => {
    const calls = mockList([{ ...doc('d1', 'cap-table.pdf'), reviewed_at: '2026-02-01T00:00:00Z' }]);
    render(<DocumentsPanel valuationId={VAL_ID} canReview />);

    await userEvent.click(await screen.findByRole('button', { name: 'Reopen cap-table.pdf' }));

    await waitFor(() =>
      expect(calls.find((c) => c.url.includes('/review'))!.body).toEqual({ reviewed: false }),
    );
  });

  it('puts the optimistic mark back when the server refuses it', async () => {
    mockList([doc('d1', 'cap-table.pdf')], { review: () => problem(403, 'Reviewers only.') });
    render(<DocumentsPanel valuationId={VAL_ID} canReview />);

    await userEvent.click(await screen.findByRole('button', { name: 'Mark cap-table.pdf reviewed' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Reviewers only.');
    // Reloaded from the server, so the row shows what actually landed.
    await waitFor(() => expect(screen.queryByText('reviewed')).not.toBeInTheDocument());
  });

  it('says the list could not be loaded rather than showing a skeleton for ever', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem(503, 'Storage is unavailable.'));
    render(<DocumentsPanel valuationId={VAL_ID} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load documents/i);
    expect(screen.queryByText('No documents yet')).not.toBeInTheDocument();
  });
});
