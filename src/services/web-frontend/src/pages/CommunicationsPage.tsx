import { useCallback, useEffect, useRef, useState } from 'react';
import {
  all,
  numberMin,
  numberRange,
  optional,
  pattern,
  required,
  useFormValidation,
} from '../lib/useFormValidation';
import { api, ApiError } from '../lib/api';
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABELS,
  VALUATION_STATES,
  type AutoEmail,
  type CommunicationTemplate,
  type TemplateCategory,
  type TemplateVariable,
} from '../lib/types';
import { STATE_LABELS } from '../lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Select,
  Spinner,
  TextInput,
  inputClass,
} from '../components/ui';

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
      <strong>SMS is in preview.</strong> There is no live SMS provider connected yet — messages on this
      channel are recorded in the service log but not delivered to phones. Email delivery is unaffected.
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

function CategoryBadge({ category }: { category: TemplateCategory }) {
  return (
    <span className="inline-block rounded-full border border-paper-300 bg-paper-100 px-2.5 py-0.5 text-xs font-semibold text-ink-600">
      {TEMPLATE_CATEGORY_LABELS[category]}
    </span>
  );
}

/**
 * The variable palette, served from the same catalog the renderer validates
 * against (`/admin/communication-templates/variables`). Hard-coding the list
 * here is how the hint text on the subject field came to name four variables
 * out of fifteen and go stale — the promise and the picker have to be one
 * thing.
 *
 * Clicking a name inserts it at the cursor of whichever field was last
 * focused, because the alternative is an operator typing `{{valuation_date}}`
 * by hand, and a typo there is an email a client reads with braces in it.
 */
function VariablePalette({
  variables,
  onInsert,
}: {
  variables: TemplateVariable[];
  onInsert: (token: string) => void;
}) {
  const scopes: Array<{ key: TemplateVariable['scope']; label: string }> = [
    { key: 'always', label: 'Always available' },
    { key: 'valuation', label: 'Engagement' },
    { key: 'link', label: 'Links' },
  ];
  return (
    <div className="rounded-md border border-paper-300 bg-paper-50 p-4">
      <div className="overline text-ink-400">Variables</div>
      <div className="mt-2 space-y-3">
        {scopes.map((scope) => {
          const inScope = variables.filter((v) => v.scope === scope.key);
          if (inScope.length === 0) return null;
          return (
            <div key={scope.key}>
              <div className="text-xs font-semibold text-ink-500">{scope.label}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {inScope.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    title={`${v.description} (e.g. ${v.sample})`}
                    onClick={() => onInsert(`{{${v.name}}}`)}
                    className="cursor-pointer rounded border border-paper-300 bg-surface px-2 py-1 font-mono text-[0.7rem] text-ink-700 hover:border-bond-400 hover:text-bond-700"
                  >
                    {v.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Templates tab ─────────────────────────────────────────────────────────────

function TemplateEditor({
  // Defaulted: the palette is fetched separately and may not have arrived (or
  // may have failed) when the editor opens. Without it the editor degrades to
  // typing variables by hand, which is what this page did before — it must not
  // fail to render.
  variables = [],
  template,
  onSaved,
  onCancel,
}: {
  template: CommunicationTemplate | null;
  variables?: TemplateVariable[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isNew = template === null;
  const [key, setKey] = useState(template?.key ?? '');
  const [channel, setChannel] = useState<'email' | 'sms'>(template?.channel ?? 'email');
  const [category, setCategory] = useState<TemplateCategory>(template?.category ?? 'account');
  const [description, setDescription] = useState(template?.description ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
  const [preview, setPreview] = useState<{
    subject: string;
    body: string;
    unknown_variables: string[];
  } | null>(null);
  const [previewValuation, setPreviewValuation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Which field the palette inserts into. Tracked on focus rather than
  // guessed, so clicking a variable after editing the subject does not drop
  // it at the end of the body.
  const [focused, setFocused] = useState<'subject' | 'body'>('body');

  const insert = (token: string) => {
    const el = focused === 'subject' ? subjectRef.current : bodyRef.current;
    const setter = focused === 'subject' ? setSubject : setBody;
    const current = focused === 'subject' ? subject : body;
    if (!el) {
      setter(current + token);
      return;
    }
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    setter(current.slice(0, start) + token + current.slice(end));
    // Restore the caret after React re-renders, so a second click inserts
    // after the first rather than back at the original offset.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  // What the *editor* shows, not what the server last saw: the operator is
  // looking at unsaved text, and warning them about the saved version would
  // be answering a question they did not ask.
  const declared = new Set(variables.map((v) => v.name));

  const unknownNow = [
    ...new Set([...subject.matchAll(/\{\{(\w+)\}\}/g), ...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!)),
  ].filter((name) => !declared.has(name));

  /*
   * `key` is only editable while the template is new — an existing one has the
   * box disabled, and the PATCH does not carry it — so the slug rules apply to
   * the new case only. Applying them always would lock an operator out of
   * editing a template whose key predates the pattern.
   *
   * A subject is required for email and meaningless for SMS, and the box is not
   * rendered at all in the SMS case; a rule that ignored `channel` would fail
   * the form on a field nobody can see.
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(
    { key, subject, body, channel },
    {
      key: isNew
        ? all(
            required('key', 'Key'),
            pattern('key', /[a-z0-9_]+/, 'Use lower-case letters, digits and underscores only.'),
          )
        : undefined,
      subject: (v) => (v.channel === 'email' ? required<typeof v>('subject', 'Subject')(v) : null),
      body: required('body', 'Body'),
    },
  );

  const submit = handleSubmit(async () => {
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        await api('/admin/communication-templates', {
          method: 'POST',
          body: { key, channel, category, description, subject, body, enabled },
        });
      } else {
        await api(`/admin/communication-templates/${template.id}`, {
          method: 'PATCH',
          body: { category, description, subject, body, enabled },
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the template.');
    } finally {
      setBusy(false);
    }
  });

  /**
   * Previews what is on screen, not what is stored — the editor's content is
   * usually not the table's yet. Against a real engagement when one is named:
   * a template reads fine against "Acme Corp" and falls apart against a
   * company whose legal name runs to sixty characters, and the only way to
   * find that out before the client does is to try it.
   */
  const runPreview = async () => {
    if (isNew) return;
    try {
      setPreview(
        await api(`/admin/communication-templates/${template.id}/preview`, {
          method: 'POST',
          body: {
            subject,
            body,
            ...(previewValuation.trim() ? { valuation_id: previewValuation.trim() } : {}),
          },
        }),
      );
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404 ? 'No engagement with that id.' : 'Preview failed.',
      );
    }
  };

  return (
    <form
      onSubmit={submit}
      className="mt-4 space-y-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Key"
          hint="Matches a workflow templateKey to override built-in content"
          error={errorFor('key')}
        >
          <TextInput
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onBlur={blurHandler('key')}
            disabled={!isNew}
            required
            pattern="[a-z0-9_]+"
            placeholder="payment_reminder"
          />
        </Field>
        <Field label="Channel">
          <Select
            value={channel}
            onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}
            disabled={!isNew}
          >
            <option value="email">Email</option>
            <option value="sms">SMS (preview)</option>
          </Select>
        </Field>
      </div>
      {channel === 'sms' && <SmsPreviewNote />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Category"
          hint="Which stage of an engagement sends this — 'Account' for the ones that are not about an engagement at all"
        >
          <Select value={category} onChange={(e) => setCategory(e.target.value as TemplateCategory)}>
            {TEMPLATE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {TEMPLATE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description">
          <TextInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this template is for"
          />
        </Field>
      </div>
      {channel === 'email' && (
        <Field
          label="Subject"
          hint="Click a variable below to insert it at the cursor"
          error={errorFor('subject')}
        >
          <TextInput
            ref={subjectRef}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onFocus={() => setFocused('subject')}
            onBlur={blurHandler('subject')}
            required
          />
        </Field>
      )}
      <Field
        label="Body"
        hint="Unknown placeholders are left verbatim at send time — see the warning below"
        error={errorFor('body')}
      >
        <textarea
          ref={bodyRef}
          className={`${inputClass} min-h-28 font-mono text-xs`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onFocus={() => setFocused('body')}
          onBlur={blurHandler('body')}
          required
        />
      </Field>

      <VariablePalette variables={variables} onInsert={insert} />

      {unknownNow.length > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Nothing supplies {unknownNow.map((n) => `{{${n}}}`).join(', ')}.</strong> These render
          verbatim in the delivered message. Saving is still allowed — the catalog grows, and a variable you
          are expecting may simply not exist yet.
        </p>
      )}

      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled — workflow keys fall back to built-in content when disabled
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      {preview && (
        <div className="rounded-md border border-paper-300 bg-paper-50 p-4 text-sm">
          <div className="overline text-ink-400">
            Preview {previewValuation.trim() ? '(this engagement)' : '(sample data)'}
          </div>
          {preview.subject && <div className="mt-1 font-semibold text-ink-900">{preview.subject}</div>}
          <p className="mt-1 whitespace-pre-wrap text-ink-600">{preview.body}</p>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Button type="submit" disabled={busy}>
          {isNew ? 'Create template' : 'Save template'}
        </Button>
        {!isNew && (
          <>
            <div className="w-72">
              <Field label="Preview against" hint="An engagement id, or blank for sample data">
                <TextInput
                  value={previewValuation}
                  onChange={(e) => setPreviewValuation(e.target.value)}
                  placeholder="01JQ… (optional)"
                />
              </Field>
            </div>
            <Button type="button" variant="secondary" onClick={() => void runPreview()}>
              Preview
            </Button>
          </>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface TemplateListResponse {
  templates: CommunicationTemplate[];
  categories?: Array<{ key: TemplateCategory; label: string; count: number }>;
}

function TemplatesTab() {
  const [templates, setTemplates] = useState<CommunicationTemplate[] | null>(null);
  // Explicitly non-optional: `TemplateListResponse['categories']` admits
  // `undefined` now that the field is optional on the wire, and the state
  // itself never is.
  const [counts, setCounts] = useState<NonNullable<TemplateListResponse['categories']>>([]);
  const [variables, setVariables] = useState<TemplateVariable[]>([]);
  const [category, setCategory] = useState<'all' | TemplateCategory>('all');
  const [editing, setEditing] = useState<CommunicationTemplate | null | 'new'>();
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = category === 'all' ? '' : `?category=${category}`;
      const res = await api<TemplateListResponse>(`/admin/communication-templates${qs}`);
      setTemplates(res.templates);
      // Counts always come back over the whole table, so the tab strip does
      // not collapse to "the one I am looking at" once a filter is applied.
      // Defaulted rather than asserted: a filtered response carries them too,
      // and an older server that does not send them should cost the tab strip
      // its numbers, not the page its render.
      if (category === 'all') setCounts(res.categories ?? []);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Communication settings are operations-only.'
          : 'Could not load templates.',
      );
    }
  }, [category]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetched once, not per render of the editor: the catalog is the same for
  // every template on the page.
  useEffect(() => {
    api<{ variables: TemplateVariable[] }>('/admin/communication-templates/variables')
      .then((d) => setVariables(d.variables))
      .catch(() => {
        // A missing palette degrades to typing variables by hand, which is
        // what this page did before. Not worth an error banner.
      });
  }, []);

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
          Templates matching a workflow key override the built-in email content; drip campaigns reference
          templates by key.
        </p>
        <Button onClick={() => setEditing('new')}>New template</Button>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {(['all', ...TEMPLATE_CATEGORIES] as const).map((c) => {
          const count = c === 'all' ? undefined : counts.find((x) => x.key === c)?.count;
          return (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                category === c
                  ? 'bg-ink-900 text-paper-50'
                  : 'border border-ink-200 bg-surface text-ink-600 hover:border-ink-400'
              }`}
            >
              {c === 'all' ? 'All' : TEMPLATE_CATEGORY_LABELS[c]}
              {count !== undefined && <span className="tnum ml-1.5 opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      {editing !== undefined && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          variables={variables}
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
        <div className="mt-4 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[760px] text-sm" aria-label="Communication templates">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Key</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Category</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Channel</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Subject / body</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Type</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Status</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b border-paper-200 align-top last:border-0">
                  <td className="px-5 py-3.5">
                    <span className="font-mono text-xs font-semibold text-ink-900">{t.key}</span>
                    {t.description && (
                      <div className="mt-1 max-w-56 text-xs text-ink-400">{t.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    <CategoryBadge category={t.category} />
                  </td>
                  <td className="px-4 py-3.5">
                    <ChannelBadge channel={t.channel} />
                  </td>
                  <td className="max-w-72 px-4 py-3.5 text-ink-600">
                    {t.subject && (
                      <div className="truncate font-medium text-ink-800" title={t.subject}>
                        {t.subject}
                      </div>
                    )}
                    <div className="truncate text-xs" title={t.body}>
                      {t.body}
                    </div>
                    {t.unknown_variables && t.unknown_variables.length > 0 && (
                      <div className="mt-1 text-xs font-semibold text-amber-700">
                        Unsupplied: {t.unknown_variables.map((n) => `{{${n}}}`).join(', ')}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    <EnabledBadge enabled={t.enabled} />
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex gap-3 text-xs font-semibold">
                      <button
                        className="cursor-pointer text-bond-600 hover:text-bond-700"
                        onClick={() => setEditing(t)}
                      >
                        Edit
                      </button>
                      <button
                        className="cursor-pointer text-red-600 hover:text-red-700"
                        onClick={() => void remove(t)}
                      >
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
  const [promotional, setPromotional] = useState(campaign?.promotional ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const channelTemplates = templates.filter((t) => t.channel === channel);

  /*
   * The three hour/count boxes are `number` state fed by `Number(e.target.value)`,
   * so clearing one lands 0 in it rather than an empty string — which is why
   * "Max sends" needs the floor restated: emptying the box used to leave a
   * campaign that sends zero times and reports no error.
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(
    { name, templateKey, delayHours, repeatHours, maxSends },
    {
      name: isNew
        ? all(
            required('name', 'Name'),
            pattern('name', /[a-z0-9_]+/, 'Use lower-case letters, digits and underscores only.'),
          )
        : undefined,
      templateKey: required('templateKey', 'Template'),
      delayHours: numberMin('delayHours', 0, 'Delay'),
      repeatHours: optional('repeatHours', numberMin('repeatHours', 1, 'Repeat')),
      maxSends: numberRange('maxSends', 1, 10, 'Max sends'),
    },
  );

  const submit = handleSubmit(async () => {
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
      promotional,
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
  });

  return (
    <form
      onSubmit={submit}
      className="mt-4 space-y-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name" error={errorFor('name')}>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={blurHandler('name')}
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
        <Field label="Template" error={errorFor('templateKey')}>
          <Select
            value={templateKey}
            onChange={(e) => setTemplateKey(e.target.value)}
            onBlur={blurHandler('templateKey')}
            required
          >
            <option value="">Choose a template…</option>
            {channelTemplates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.key}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Trigger state" hint="Fires while the valuation sits in this state">
          <Select
            value={triggerState}
            onChange={(e) => setTriggerState(e.target.value as AutoEmail['trigger_state'])}
          >
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
        <Field label="Delay (hours)" error={errorFor('delayHours')}>
          <TextInput
            type="number"
            min={0}
            value={delayHours}
            onChange={(e) => setDelayHours(Number(e.target.value))}
            onBlur={blurHandler('delayHours')}
          />
        </Field>
        <Field label="Repeat every (hours)" hint="Blank = send once" error={errorFor('repeatHours')}>
          <TextInput
            type="number"
            min={1}
            value={repeatHours}
            onChange={(e) => setRepeatHours(e.target.value === '' ? '' : Number(e.target.value))}
            onBlur={blurHandler('repeatHours')}
          />
        </Field>
        <Field label="Max sends" error={errorFor('maxSends')}>
          <TextInput
            type="number"
            min={1}
            max={10}
            value={maxSends}
            onChange={(e) => setMaxSends(Number(e.target.value))}
            onBlur={blurHandler('maxSends')}
          />
        </Field>
      </div>
      {channel === 'sms' && <SmsPreviewNote />}
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>
      <label className="flex items-start gap-2 text-sm text-ink-700">
        <input
          type="checkbox"
          className="mt-1"
          checked={promotional}
          onChange={(e) => setPromotional(e.target.checked)}
        />
        <span>
          Promotional
          <span className="block text-xs text-ink-400">
            Marketing rather than transactional. Sent only to recipients who have not opted out of marketing,
            and with an unsubscribe footer. Leave off for anything about the client&rsquo;s own engagement —
            an opt-out must never silence a status update.
          </span>
        </span>
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
          Campaigns fire for valuations that sit in the trigger state past the delay. Sends land in the email
          outbox.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void runNow()}>
            Run scan now
          </Button>
          <Button onClick={() => setEditing('new')}>New campaign</Button>
        </div>
      </div>
      {runResult && <p className="mt-3 text-sm font-medium text-emerald-700">{runResult}</p>}
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
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
        <div className="mt-4 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[820px] text-sm" aria-label="Auto email campaigns">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Campaign</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Channel</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Trigger</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Schedule</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Template</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Type</th>
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
                    after {c.delay_hours}h{c.repeat_hours ? `, every ${c.repeat_hours}h` : ''}
                    {c.max_sends > 1 ? `, max ${c.max_sends}` : ''}
                  </td>
                  <td className="px-4 py-3.5 font-mono text-xs text-ink-500">{c.template_key}</td>
                  <td className="px-4 py-3.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ring-1 ring-inset ${
                        c.promotional
                          ? 'bg-amber-50 text-amber-800 ring-amber-200'
                          : 'bg-paper-100 text-ink-500 ring-paper-300'
                      }`}
                      title={
                        c.promotional
                          ? 'Marketing — gated on consent, sent with an unsubscribe footer'
                          : 'Transactional — always delivered, no unsubscribe'
                      }
                    >
                      {c.promotional ? 'promotional' : 'transactional'}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <EnabledBadge enabled={c.enabled} />
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex gap-3 text-xs font-semibold">
                      <button
                        className="cursor-pointer text-ink-600 hover:text-ink-900"
                        onClick={() => void toggle(c)}
                      >
                        {c.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="cursor-pointer text-bond-600 hover:text-bond-700"
                        onClick={() => setEditing(c)}
                      >
                        Edit
                      </button>
                      <button
                        className="cursor-pointer text-red-600 hover:text-red-700"
                        onClick={() => void remove(c)}
                      >
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
                : 'border border-ink-200 bg-surface text-ink-600 hover:border-ink-400'
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
