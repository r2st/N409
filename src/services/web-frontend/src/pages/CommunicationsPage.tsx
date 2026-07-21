import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { VALUATION_STATES, type AutoEmail, type CommunicationTemplate } from '../lib/types';
import { STATE_LABELS } from '../lib/format';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner, TextInput, inputClass } from '../components/ui';

/**
 * Communications admin (409.ai §15.5/§15.6): email/SMS templates with
 * {{var}} placeholders, and the lifecycle-triggered drip campaigns that use
 * them. Ops-only.
 */

const CONDITIONS = [
  { value: 'always', label: 'Always' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'no_documents', label: 'No documents uploaded' },
  { value: 'waiting_on_client', label: 'Waiting on client' },
] as const;

function ChannelBadge({ channel }: { channel: 'email' | 'sms' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
        channel === 'sms'
          ? 'border-violet-200 bg-violet-50 text-violet-800'
          : 'border-sky-200 bg-sky-50 text-sky-800'
      }`}
    >
      {channel.toUpperCase()}
      {channel === 'sms' && (
        <span className="rounded-sm bg-violet-200/70 px-1 text-[0.6rem] font-bold tracking-wide text-violet-900 uppercase">
          Preview
        </span>
      )}
    </span>
  );
}

/**
 * SMS has no real delivery provider yet — the backend only logs sends
 * (SMS_MODE=log). Surface that wherever an SMS channel is chosen so ops don't
 * assume texts are actually going out (P2-4).
 */
function SmsPreviewNote() {
  return (
    <p className="mt-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
      <strong>SMS is in preview.</strong> There is no live SMS provider connected yet — messages on
      this channel are recorded in the service log but not delivered to phones. Email delivery is
      unaffected.
    </p>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
        enabled
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-paper-300 bg-paper-200 text-ink-600'
      }`}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

// ── Templates tab ─────────────────────────────────────────────────────────────

function TemplateEditor({
  template,
  onSaved,
  onCancel,
}: {
  template: CommunicationTemplate | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isNew = template === null;
  const [key, setKey] = useState(template?.key ?? '');
  const [channel, setChannel] = useState<'email' | 'sms'>(template?.channel ?? 'email');
  const [description, setDescription] = useState(template?.description ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        await api('/admin/communication-templates', {
          method: 'POST',
          body: { key, channel, description, subject, body, enabled },
        });
      } else {
        await api(`/admin/communication-templates/${template.id}`, {
          method: 'PATCH',
          body: { description, subject, body, enabled },
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the template.');
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    if (isNew) return;
    try {
      setPreview(await api(`/admin/communication-templates/${template.id}/preview`, { method: 'POST', body: {} }));
    } catch {
      setError('Preview failed.');
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4 rounded-lg border border-paper-300 bg-white p-5 shadow-card">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Key" hint="Matches a workflow templateKey to override built-in content">
          <TextInput
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={!isNew}
            required
            pattern="[a-z0-9_]+"
            placeholder="payment_reminder"
          />
        </Field>
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'sms')} disabled={!isNew}>
            <option value="email">Email</option>
            <option value="sms">SMS (preview)</option>
          </Select>
        </Field>
      </div>
      {channel === 'sms' && <SmsPreviewNote />}
      <Field label="Description">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this template is for" />
      </Field>
      {channel === 'email' && (
        <Field label="Subject" hint="Supports {{company_name}}, {{kind_label}}, {{valuation_number}}, {{link}}">
          <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} required />
        </Field>
      )}
      <Field label="Body" hint="Supports {{var}} placeholders; unknown placeholders are left as-is">
        <textarea
          className={`${inputClass} min-h-28 font-mono text-xs`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled — workflow keys fall back to built-in content when disabled
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      {preview && (
        <div className="rounded-md border border-paper-300 bg-paper-50 p-4 text-sm">
          <div className="overline text-ink-400">Preview (sample data)</div>
          {preview.subject && <div className="mt-1 font-semibold text-ink-900">{preview.subject}</div>}
          <p className="mt-1 whitespace-pre-wrap text-ink-600">{preview.body}</p>
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {isNew ? 'Create template' : 'Save template'}
        </Button>
        {!isNew && (
          <Button type="button" variant="secondary" onClick={() => void runPreview()}>
            Preview
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TemplatesTab() {
  const [templates, setTemplates] = useState<CommunicationTemplate[] | null>(null);
  const [editing, setEditing] = useState<CommunicationTemplate | null | 'new'>();
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { templates: items } = await api<{ templates: CommunicationTemplate[] }>(
        '/admin/communication-templates',
      );
      setTemplates(items);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Communication settings are operations-only.'
          : 'Could not load templates.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (t: CommunicationTemplate) => {
    if (!window.confirm(`Delete template "${t.key}"?`)) return;
    try {
      await api(`/admin/communication-templates/${t.id}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the template.');
    }
  };

  if (error && !templates) return <ErrorNote>{error}</ErrorNote>;
  if (!templates) return <Spinner />;

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-400">
          Templates matching a workflow key override the built-in email content; drip campaigns
          reference templates by key.
        </p>
        <Button onClick={() => setEditing('new')}>New template</Button>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      {editing !== undefined && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {templates.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No templates yet" />
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
          <table className="w-full min-w-[760px] text-sm" aria-label="Communication templates">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Key</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Channel</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Subject / body</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Status</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b border-paper-200 align-top last:border-0">
                  <td className="px-5 py-3.5">
                    <span className="font-mono text-xs font-semibold text-ink-900">{t.key}</span>
                    {t.description && <div className="mt-1 max-w-56 text-xs text-ink-400">{t.description}</div>}
                  </td>
                  <td className="px-4 py-3.5">
                    <ChannelBadge channel={t.channel} />
                  </td>
                  <td className="max-w-72 px-4 py-3.5 text-ink-600">
                    {t.subject && <div className="truncate font-medium text-ink-800" title={t.subject}>{t.subject}</div>}
                    <div className="truncate text-xs" title={t.body}>{t.body}</div>
                  </td>
                  <td className="px-4 py-3.5">
                    <EnabledBadge enabled={t.enabled} />
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex gap-3 text-xs font-semibold">
                      <button className="cursor-pointer text-bond-600 hover:text-bond-700" onClick={() => setEditing(t)}>
                        Edit
                      </button>
                      <button className="cursor-pointer text-red-600 hover:text-red-700" onClick={() => void remove(t)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Auto emails tab ───────────────────────────────────────────────────────────

function AutoEmailEditor({
  campaign,
  templates,
  onSaved,
  onCancel,
}: {
  campaign: AutoEmail | null;
  templates: CommunicationTemplate[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isNew = campaign === null;
  const [name, setName] = useState(campaign?.name ?? '');
  const [channel, setChannel] = useState<'email' | 'sms'>(campaign?.channel ?? 'email');
  const [triggerState, setTriggerState] = useState(campaign?.trigger_state ?? 'started');
  const [condition, setCondition] = useState(campaign?.condition ?? 'always');
  const [delayHours, setDelayHours] = useState(campaign?.delay_hours ?? 24);
  const [repeatHours, setRepeatHours] = useState<number | ''>(campaign?.repeat_hours ?? '');
  const [maxSends, setMaxSends] = useState(campaign?.max_sends ?? 1);
  const [templateKey, setTemplateKey] = useState(campaign?.template_key ?? '');
  const [enabled, setEnabled] = useState(campaign?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const channelTemplates = templates.filter((t) => t.channel === channel);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      channel,
      trigger_state: triggerState,
      condition,
      delay_hours: delayHours,
      repeat_hours: repeatHours === '' ? null : repeatHours,
      max_sends: maxSends,
      template_key: templateKey,
      enabled,
    };
    try {
      if (isNew) {
        await api('/admin/auto-emails', { method: 'POST', body: { ...body, name } });
      } else {
        await api(`/admin/auto-emails/${campaign.id}`, { method: 'PATCH', body });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the campaign.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4 rounded-lg border border-paper-300 bg-white p-5 shadow-card">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isNew}
            required
            pattern="[a-z0-9_]+"
            placeholder="payment_reminder_1"
          />
        </Field>
        <Field label="Channel">
          <Select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as 'email' | 'sms');
              setTemplateKey('');
            }}
          >
            <option value="email">Email</option>
            <option value="sms">SMS (preview)</option>
          </Select>
        </Field>
        <Field label="Template">
          <Select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} required>
            <option value="">Choose a template…</option>
            {channelTemplates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.key}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Trigger state" hint="Fires while the valuation sits in this state">
          <Select value={triggerState} onChange={(e) => setTriggerState(e.target.value as AutoEmail['trigger_state'])}>
            {VALUATION_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABELS[s] ?? s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Condition">
          <Select value={condition} onChange={(e) => setCondition(e.target.value as AutoEmail['condition'])}>
            {CONDITIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Delay (hours)">
          <TextInput type="number" min={0} value={delayHours} onChange={(e) => setDelayHours(Number(e.target.value))} />
        </Field>
        <Field label="Repeat every (hours)" hint="Blank = send once">
          <TextInput
            type="number"
            min={1}
            value={repeatHours}
            onChange={(e) => setRepeatHours(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </Field>
        <Field label="Max sends">
          <TextInput type="number" min={1} max={10} value={maxSends} onChange={(e) => setMaxSends(Number(e.target.value))} />
        </Field>
      </div>
      {channel === 'sms' && <SmsPreviewNote />}
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {isNew ? 'Create campaign' : 'Save campaign'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AutoEmailsTab() {
  const [campaigns, setCampaigns] = useState<AutoEmail[] | null>(null);
  const [templates, setTemplates] = useState<CommunicationTemplate[]>([]);
  const [editing, setEditing] = useState<AutoEmail | null | 'new'>();
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ auto_emails }, { templates: tpl }] = await Promise.all([
        api<{ auto_emails: AutoEmail[] }>('/admin/auto-emails'),
        api<{ templates: CommunicationTemplate[] }>('/admin/communication-templates'),
      ]);
      setCampaigns(auto_emails);
      setTemplates(tpl);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Communication settings are operations-only.'
          : 'Could not load auto emails.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (c: AutoEmail) => {
    try {
      await api(`/admin/auto-emails/${c.id}`, { method: 'PATCH', body: { enabled: !c.enabled } });
      void load();
    } catch {
      setError('Could not update the campaign.');
    }
  };

  const remove = async (c: AutoEmail) => {
    if (!window.confirm(`Delete campaign "${c.name}"?`)) return;
    try {
      await api(`/admin/auto-emails/${c.id}`, { method: 'DELETE' });
      void load();
    } catch {
      setError('Could not delete the campaign.');
    }
  };

  const runNow = async () => {
    setRunResult(null);
    try {
      const r = await api<{ queued: number; skipped: number }>('/admin/auto-emails/run', {
        method: 'POST',
      });
      setRunResult(`Scan complete — ${r.queued} queued, ${r.skipped} skipped.`);
    } catch {
      setError('Scan failed.');
    }
  };

  if (error && !campaigns) return <ErrorNote>{error}</ErrorNote>;
  if (!campaigns) return <Spinner />;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-400">
          Campaigns fire for valuations that sit in the trigger state past the delay. Sends land in
          the email outbox.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void runNow()}>
            Run scan now
          </Button>
          <Button onClick={() => setEditing('new')}>New campaign</Button>
        </div>
      </div>
      {runResult && <p className="mt-3 text-sm font-medium text-emerald-700">{runResult}</p>}
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      {editing !== undefined && (
        <AutoEmailEditor
          campaign={editing === 'new' ? null : editing}
          templates={templates}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {campaigns.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No auto email campaigns" />
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
          <table className="w-full min-w-[820px] text-sm" aria-label="Auto email campaigns">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Campaign</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Channel</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Trigger</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Schedule</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Template</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Status</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-paper-200 align-top last:border-0">
                  <td className="px-5 py-3.5 font-mono text-xs font-semibold text-ink-900">{c.name}</td>
                  <td className="px-4 py-3.5">
                    <ChannelBadge channel={c.channel} />
                  </td>
                  <td className="px-4 py-3.5 text-ink-600">
                    {STATE_LABELS[c.trigger_state] ?? c.trigger_state}
                    {c.condition !== 'always' && (
                      <div className="text-xs text-ink-400">
                        {CONDITIONS.find((x) => x.value === c.condition)?.label}
                      </div>
                    )}
                  </td>
                  <td className="tnum px-4 py-3.5 text-ink-600">
                    after {c.delay_hours}h
                    {c.repeat_hours ? `, every ${c.repeat_hours}h` : ''}
                    {c.max_sends > 1 ? `, max ${c.max_sends}` : ''}
                  </td>
                  <td className="px-4 py-3.5 font-mono text-xs text-ink-500">{c.template_key}</td>
                  <td className="px-4 py-3.5">
                    <EnabledBadge enabled={c.enabled} />
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex gap-3 text-xs font-semibold">
                      <button className="cursor-pointer text-ink-600 hover:text-ink-900" onClick={() => void toggle(c)}>
                        {c.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className="cursor-pointer text-bond-600 hover:text-bond-700" onClick={() => setEditing(c)}>
                        Edit
                      </button>
                      <button className="cursor-pointer text-red-600 hover:text-red-700" onClick={() => void remove(c)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CommunicationsPage() {
  const [tab, setTab] = useState<'templates' | 'auto'>('templates');

  return (
    <div>
      <div className="overline text-ink-400">Operations</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Communications</h1>
      <p className="mt-1 text-sm text-ink-400">
        Email &amp; SMS templates and lifecycle-triggered drip campaigns.
      </p>

      <div className="mt-6 flex gap-2">
        {(
          [
            ['templates', 'Templates'],
            ['auto', 'Auto emails'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              tab === value
                ? 'bg-ink-900 text-paper-50'
                : 'border border-ink-200 bg-white text-ink-600 hover:border-ink-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">{tab === 'templates' ? <TemplatesTab /> : <AutoEmailsTab />}</div>
    </div>
  );
}
