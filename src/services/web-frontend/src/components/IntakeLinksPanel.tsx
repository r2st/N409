import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/format';
import { Button, DataTable, ErrorNote, Field, Modal, Spinner, TextInput, type Column } from './ui';

/**
 * Client intake links — the firm's side of the intake form.
 *
 * A firm taking on a client sends one link, watches it fill in, and reads the
 * answers when it lands. So the panel is a roster, not a form builder: create,
 * see how far each prospect got, open what came back, withdraw a link that
 * shouldn't have gone out.
 *
 * The one thing this UI has to get right is that the URL is shown exactly once.
 * The server keeps only a hash, so a firm that navigates away before copying it
 * has to issue a new link — the created-link callout stays put until dismissed
 * and says so plainly.
 */

const STATUS_STYLES: Record<string, string> = {
  sent: 'bg-paper-200 text-ink-600 ring-ink-200',
  in_progress: 'bg-sky-50 text-sky-800 ring-sky-200',
  submitted: 'bg-bond-50 text-bond-700 ring-bond-200',
  converted: 'bg-bond-50 text-bond-700 ring-bond-200',
  expired: 'bg-amber-50 text-amber-800 ring-amber-200',
  revoked: 'bg-paper-200 text-ink-400 ring-ink-200',
};

const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  in_progress: 'In progress',
  submitted: 'Submitted',
  converted: 'Converted',
  expired: 'Expired',
  revoked: 'Withdrawn',
};

interface SectionCompletion {
  key: string;
  title: string;
  requiredTotal: number;
  requiredAnswered: number;
  complete: boolean;
}

interface Completion {
  sections: SectionCompletion[];
  requiredTotal: number;
  requiredAnswered: number;
  percentComplete: number;
  ready: boolean;
}

interface IntakeLink {
  id: string;
  client_name: string | null;
  client_email: string | null;
  label: string | null;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
  submitted_at: string | null;
  valuation_id: string | null;
  status: string;
  completion: Completion;
}

interface IntakeField {
  key: string;
  label: string;
  type: string;
  required: boolean;
}

interface IntakeSection {
  key: string;
  title: string;
  description: string;
  fields: IntakeField[];
}

interface LinkDetail {
  link: IntakeLink;
  answers: Record<string, unknown>;
  sections: IntakeSection[];
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${
        STATUS_STYLES[status] ?? STATUS_STYLES.sent
      }`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function answerText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  return String(value).replace(/_/g, ' ');
}

export function IntakeLinksPanel({ partnerId }: { partnerId?: string | null }) {
  const [links, setLinks] = useState<IntakeLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ url: string; name: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [detail, setDetail] = useState<LinkDetail | null>(null);

  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('30');

  const scoped = useCallback(
    (path: string) => (partnerId ? `${path}${path.includes('?') ? '&' : '?'}partner_id=${partnerId}` : path),
    [partnerId],
  );

  const load = useCallback(async () => {
    try {
      const res = await api<{ links: IntakeLink[] }>(scoped('/firm/intake-links'));
      setLinks(res.links);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Client intake is available to firm accounts.'
          : 'Could not load intake links.',
      );
      setLinks([]);
    }
  }, [scoped]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ url: string; link: IntakeLink }>(scoped('/firm/intake-links'), {
        method: 'POST',
        body: {
          client_name: clientName.trim() || undefined,
          client_email: clientEmail.trim() || undefined,
          expires_in_days: Number(expiresInDays) || 30,
        },
      });
      setIssued({ url: res.url, name: res.link.client_name });
      setCopied(false);
      setCreating(false);
      setClientName('');
      setClientEmail('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the intake link.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (link: IntakeLink) => {
    setError(null);
    try {
      await api(scoped(`/firm/intake-links/${link.id}`), { method: 'DELETE' });
      await load();
    } catch {
      setError('Could not withdraw that link.');
    }
  };

  const open = async (link: IntakeLink) => {
    try {
      setDetail(await api<LinkDetail>(scoped(`/firm/intake-links/${link.id}`)));
    } catch {
      setError('Could not load that submission.');
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure origin, denied permission).
      // The URL is on screen and selectable, so this is a nicety, not a path.
      setCopied(false);
    }
  };

  const columns: Column<IntakeLink>[] = [
    {
      key: 'client',
      header: 'Client',
      render: (row) => (
        <span>
          <span className="font-medium text-ink-900">{row.client_name ?? 'Unnamed prospect'}</span>
          {row.client_email && <span className="block text-xs text-ink-400">{row.client_email}</span>}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'progress',
      header: 'Completed',
      align: 'right',
      render: (row) => (
        <span className="inline-flex items-center justify-end gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-paper-300">
            <span
              className="block h-full rounded-full bg-bond-500"
              style={{ width: `${row.completion.percentComplete}%` }}
            />
          </span>
          <span className="tnum text-xs text-ink-500">{row.completion.percentComplete}%</span>
        </span>
      ),
    },
    {
      key: 'expires',
      header: 'Expires',
      align: 'right',
      render: (row) => <span className="tnum text-ink-500">{formatDate(row.expires_at)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <span className="flex justify-end gap-3 text-sm">
          <button
            type="button"
            className="cursor-pointer text-bond-700 underline"
            onClick={() => void open(row)}
          >
            View
          </button>
          {(row.status === 'sent' || row.status === 'in_progress') && (
            <button
              type="button"
              className="cursor-pointer text-ink-400 underline hover:text-red-700"
              onClick={() => void revoke(row)}
            >
              Withdraw
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-ink-900">Client intake</h2>
          <p className="mt-0.5 text-sm text-ink-400">
            Send a branded questionnaire to a new client — no account needed on their side.
          </p>
        </div>
        <Button onClick={() => setCreating((c) => !c)}>{creating ? 'Cancel' : 'New intake link'}</Button>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {issued && (
        <div className="mt-4 rounded-lg border border-bond-200 bg-bond-50 p-5">
          <h3 className="font-display text-base font-semibold text-bond-900">
            Link ready{issued.name ? ` for ${issued.name}` : ''}
          </h3>
          <p className="mt-1 text-sm text-bond-800">
            Copy it now — for security we store only a hash, so this URL cannot be shown again.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="flex-1 rounded-md border border-bond-200 bg-surface px-3 py-2 text-xs break-all text-ink-700">
              {issued.url}
            </code>
            <Button variant="secondary" onClick={() => void copy(issued.url)}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button variant="ghost" onClick={() => setIssued(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {creating && (
        <div className="mt-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Client name" hint="Shown as a greeting on the form.">
              <TextInput
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="Northwind Robotics"
              />
            </Field>
            <Field label="Client email" hint="For your records — we don't email it.">
              <TextInput
                type="email"
                value={clientEmail}
                onChange={(e) => setClientEmail(e.target.value)}
                placeholder="founder@company.com"
              />
            </Field>
            <Field label="Expires in (days)">
              <TextInput
                type="number"
                min={1}
                max={90}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-4">
            <Button disabled={busy} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create link'}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
        {links === null ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            rows={links}
            rowKey={(row) => row.id}
            caption="Client intake links"
            empty="No intake link yet — send one to start a client off."
          />
        )}
      </div>

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.link.client_name ?? 'Intake submission'}
        className="max-w-2xl"
      >
        {detail && (
          <div className="px-5 py-4">
            <div className="flex flex-wrap items-center gap-3 text-sm text-ink-500">
              <StatusBadge status={detail.link.status} />
              <span className="tnum">{detail.link.completion.percentComplete}% complete</span>
              {detail.link.submitted_at && <span>Submitted {formatDate(detail.link.submitted_at)}</span>}
              <span>Opened {detail.link.access_count}×</span>
            </div>
            {detail.sections.map((section) => (
              <div key={section.key} className="mt-5">
                <h3 className="overline text-ink-400">{section.title}</h3>
                <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {section.fields.map((f) => (
                    <div key={f.key}>
                      <dt className="text-xs text-ink-400">{f.label}</dt>
                      <dd className="text-sm text-ink-900">{answerText(detail.answers[f.key])}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </section>
  );
}
