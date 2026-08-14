import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { Valuation } from '../lib/types';
import { Button, ErrorNote, Field, Select, Spinner, TextInput } from './ui';

/**
 * Signature workflow (remaining-gaps §3 #3) — Signature (main) / Signature
 * (second) capture. The API blocks the transition to 'published' until the
 * main signature is on file; this panel shows that gate to the reviewer.
 */

export interface Signature {
  id: string;
  valuation_id: string;
  role: 'main' | 'second';
  signer_user_id: string;
  signer_name: string;
  signer_title: string | null;
  signature_text: string;
  signed_at: string;
}

export function SignaturePanel({ valuation }: { valuation: Valuation }) {
  const [signatures, setSignatures] = useState<Signature[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ role: 'main', signer_name: '', signer_title: '', signature_text: '' });

  const load = useCallback(async () => {
    try {
      const { signatures: items } = await api<{ signatures: Signature[] }>(
        `/valuations/${valuation.id}/signatures`,
      );
      setSignatures(items);
      setLoadFailed(false);
    } catch {
      // Emphatically not `setSignatures([])`. An empty list here is a claim —
      // it renders both roles as "Not signed", stamps the engagement "Publish
      // blocked — main signature required", and offers the sign form again on a
      // valuation that may already carry both signatures. A failed read must
      // not be able to produce a duplicate signature.
      setLoadFailed(true);
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const published = valuation.state === 'published';
  const main = signatures?.find((s) => s.role === 'main');
  const second = signatures?.find((s) => s.role === 'second');

  const sign = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuation.id}/signatures`, {
        method: 'POST',
        body: {
          role: form.role,
          signer_name: form.signer_name.trim(),
          signer_title: form.signer_title.trim() || null,
          signature_text: form.signature_text.trim(),
        },
      });
      setForm((f) => ({ ...f, signer_name: '', signer_title: '', signature_text: '' }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the signature.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (role: 'main' | 'second') => {
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuation.id}/signatures/${role}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the signature.');
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, sig: Signature | undefined) => (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-paper-300 bg-paper-50 px-3.5 py-2.5">
      <span className="text-xs font-bold text-ink-500 uppercase">{label}</span>
      {sig ? (
        <>
          <span className="font-display text-base text-ink-900 italic">{sig.signature_text}</span>
          <span className="text-sm text-ink-600">
            {sig.signer_name}
            {sig.signer_title ? `, ${sig.signer_title}` : ''}
          </span>
          <span className="tnum ml-auto text-xs text-ink-400">{formatDateTime(sig.signed_at)}</span>
          {!published && (
            <button
              className="cursor-pointer text-xs font-semibold text-red-700 hover:underline"
              disabled={busy}
              onClick={() => void remove(sig.role)}
            >
              remove
            </button>
          )}
        </>
      ) : (
        <span className="text-sm text-ink-400">Not signed</span>
      )}
    </div>
  );

  // Nothing below can be stated without the list: the badge, both rows and the
  // sign form are all assertions about what has been signed. Until it arrives,
  // the panel says so rather than defaulting to "Not signed".
  if (signatures === null) {
    return (
      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-2 text-ink-400">Signatures</h2>
        {loadFailed ? (
          <ErrorNote>Could not load the signatures on this valuation.</ErrorNote>
        ) : (
          <Spinner label="Loading signatures" />
        )}
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="overline text-ink-400">Signatures</h2>
        {main ? (
          <span className="inline-flex items-center rounded-full bg-bond-50 px-2.5 py-0.5 text-xs font-semibold text-bond-700 ring-1 ring-bond-200 ring-inset">
            Ready to publish
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
            Publish blocked — main signature required
          </span>
        )}
      </div>
      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="space-y-2">
        {row('Main', main)}
        {row('Second', second)}
      </div>

      {!published && (
        <form onSubmit={sign} className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Role">
            <Select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
              <option value="main">Signature (main)</option>
              <option value="second">Signature (second)</option>
            </Select>
          </Field>
          <Field label="Full name">
            <TextInput
              value={form.signer_name}
              onChange={(e) => setForm((f) => ({ ...f, signer_name: e.target.value }))}
              required
              maxLength={200}
            />
          </Field>
          <Field label="Title (optional)">
            <TextInput
              value={form.signer_title}
              onChange={(e) => setForm((f) => ({ ...f, signer_title: e.target.value }))}
              maxLength={200}
              placeholder="e.g. Senior Analyst"
            />
          </Field>
          <Field label="Type to sign" hint="Typing your name here is your digital signature.">
            <TextInput
              value={form.signature_text}
              onChange={(e) => setForm((f) => ({ ...f, signature_text: e.target.value }))}
              required
              maxLength={500}
              placeholder="/s/ Your Name"
            />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={busy || !form.signer_name.trim() || !form.signature_text.trim()}>
              {busy ? 'Signing…' : 'Sign'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
