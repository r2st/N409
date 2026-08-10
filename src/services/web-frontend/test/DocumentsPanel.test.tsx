import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
});
