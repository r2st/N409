import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, describeActionFailure } from '../lib/api';
import { all, numberRange, pattern, required, useFormValidation } from '../lib/useFormValidation';
import { formatDate } from '../lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  ListTruncationNote,
  LoadError,
  Spinner,
  TextInput,
  useRetry,
} from '../components/ui';
import { RichTextEditor } from '../components/RichTextEditor';
import type { HelpArticle } from './HelpPage';

type EditorState = {
  id?: string;
  slug: string;
  title: string;
  category: string;
  keywords: string;
  body_html: string;
  sort_order: number;
  published: boolean;
};

const emptyEditor = (): EditorState => ({
  slug: '',
  title: '',
  category: 'General',
  keywords: '',
  body_html: '',
  sort_order: 0,
  published: true,
});

/**
 * What the rules read while the editor is closed.
 *
 * `useFormValidation` is a hook, so it runs whether or not there is an article
 * open; a blank article fails `required` harmlessly, because nothing is ever
 * revealed on a form that is not on screen.
 */
const CLOSED_EDITOR: EditorState = emptyEditor();

/** The slug shape the box declares as `pattern`, which is also the URL's. */
const SLUG = /[a-z0-9-]+/;

/** P2 #10 — ops CRUD over the knowledge base: articles appear in the help
 * widget and /help immediately, no deploy needed. */
export function AdminHelpPage() {
  const [articles, setArticles] = useState<HelpArticle[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ articles: HelpArticle[]; truncated: boolean }>('/help/articles')
      .then((d) => {
        setArticles(d.articles);
        // An article missing from the editor's list reads as an article that
        // was never written, and the next thing that happens is a second one
        // with the same slug.
        setTruncated(d.truncated);
      })
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Help articles are operations-only.'
            : 'Could not load the help articles.',
        ),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load, token]);

  const openEdit = (a: HelpArticle) =>
    setEditor({
      id: a.id,
      slug: a.slug,
      title: a.title,
      category: a.category,
      keywords: a.keywords,
      body_html: a.body_html,
      sort_order: a.sort_order,
      published: a.published,
    });

  const { errorFor, blurHandler, handleSubmit } = useFormValidation(editor ?? CLOSED_EDITOR, {
    title: required('title', 'Title'),
    slug: all(
      required('slug', 'Slug'),
      pattern('slug', SLUG, 'Slug must be lowercase letters, digits and dashes only.'),
    ),
    sort_order: numberRange('sort_order', 0, 10000, 'Sort order'),
  });

  const save = handleSubmit(async () => {
    if (!editor) return;
    setBusy(true);
    setEditorError(null);
    const body = {
      slug: editor.slug.trim(),
      title: editor.title.trim(),
      category: editor.category.trim() || 'General',
      keywords: editor.keywords.trim(),
      body_html: editor.body_html,
      sort_order: editor.sort_order,
      published: editor.published,
    };
    try {
      if (editor.id) {
        await api(`/admin/help/articles/${editor.id}`, { method: 'PATCH', body });
      } else {
        await api('/admin/help/articles', { method: 'POST', body });
      }
      setEditor(null);
      load();
    } catch (err) {
      setEditorError(describeActionFailure(err, 'Could not save the article.'));
    } finally {
      setBusy(false);
    }
  });

  const togglePublished = async (a: HelpArticle) => {
    try {
      await api(`/admin/help/articles/${a.id}`, {
        method: 'PATCH',
        body: { published: !a.published },
      });
      load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not update the article.'));
    }
  };

  const remove = async (a: HelpArticle) => {
    if (!window.confirm(`Delete "${a.title}"? Unpublishing is usually enough.`)) return;
    try {
      await api(`/admin/help/articles/${a.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not delete the article.'));
    }
  };

  if (error) return <LoadError message={error} {...retryProps} />;
  if (!articles) return <Spinner />;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Operations</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Help articles</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-500">
            The knowledge base behind the help widget and{' '}
            <Link to="/help" className="font-semibold text-bond-600 hover:text-bond-700">
              /help
            </Link>
            . Changes go live immediately.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditorError(null);
            setEditor(emptyEditor());
          }}
        >
          + New article
        </Button>
      </div>

      {editor && (
        <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-5 text-ink-400">
            {editor.id ? `Edit "${editor.title}"` : 'New article'}
          </h2>
          <form onSubmit={save} className="space-y-5" noValidate>
            {editorError && <ErrorNote>{editorError}</ErrorNote>}
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Title" error={errorFor('title')}>
                <TextInput
                  required
                  maxLength={200}
                  value={editor.title}
                  onChange={(e) => setEditor({ ...editor, title: e.target.value })}
                  onBlur={blurHandler('title')}
                />
              </Field>
              <Field
                label="Slug"
                hint="Lowercase letters, digits and dashes; part of the URL."
                error={errorFor('slug')}
              >
                <TextInput
                  required
                  maxLength={100}
                  pattern="[a-z0-9-]+"
                  value={editor.slug}
                  onChange={(e) => setEditor({ ...editor, slug: e.target.value })}
                  onBlur={blurHandler('slug')}
                />
              </Field>
              <Field label="Category">
                <TextInput
                  maxLength={100}
                  value={editor.category}
                  onChange={(e) => setEditor({ ...editor, category: e.target.value })}
                />
              </Field>
              <Field label="Keywords" hint="Space-separated search terms for the widget.">
                <TextInput
                  maxLength={500}
                  value={editor.keywords}
                  onChange={(e) => setEditor({ ...editor, keywords: e.target.value })}
                />
              </Field>
              <Field
                label="Sort order"
                hint="Lower numbers list first within the category."
                error={errorFor('sort_order')}
              >
                <TextInput
                  type="number"
                  min={0}
                  max={10000}
                  value={editor.sort_order}
                  onChange={(e) => setEditor({ ...editor, sort_order: Number(e.target.value) || 0 })}
                  onBlur={blurHandler('sort_order')}
                />
              </Field>
              <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={editor.published}
                  onChange={(e) => setEditor({ ...editor, published: e.target.checked })}
                  className="accent-bond-600"
                />
                Published
              </label>
            </div>
            <Field label="Body">
              <RichTextEditor
                value={editor.body_html}
                onChange={(html) => setEditor((ed) => (ed ? { ...ed, body_html: html } : ed))}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : editor.id ? 'Save changes' : 'Create article'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}

      {articles.length === 0 && (
        <div className="mt-6">
          <EmptyState title="No articles yet">
            Run the database migrations to seed the starter topics, or create one above.
          </EmptyState>
        </div>
      )}

      {articles.length > 0 && (
        <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[720px] text-sm" aria-label="Help articles">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Article</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Category</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Status</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Updated</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {articles.map((a) => (
                <tr key={a.id} className="border-b border-paper-200 last:border-0">
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-ink-900">{a.title}</div>
                    <div className="font-mono text-xs text-ink-400">/{a.slug}</div>
                  </td>
                  <td className="px-5 py-3.5 text-ink-600">{a.category}</td>
                  <td className="px-5 py-3.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                        a.published
                          ? 'bg-bond-50 text-bond-700 ring-bond-200'
                          : 'bg-paper-200 text-ink-500 ring-ink-200'
                      }`}
                    >
                      {a.published ? 'Published' : 'Draft'}
                    </span>
                  </td>
                  <td className="tnum px-5 py-3.5 text-ink-600">{formatDate(a.updated_at)}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex gap-3 text-xs font-semibold">
                      <button
                        onClick={() => openEdit(a)}
                        className="cursor-pointer text-bond-600 hover:text-bond-700"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void togglePublished(a)}
                        className="cursor-pointer text-ink-500 hover:text-ink-700"
                      >
                        {a.published ? 'Unpublish' : 'Publish'}
                      </button>
                      <button
                        onClick={() => void remove(a)}
                        className="cursor-pointer text-red-600 hover:text-red-700"
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
      <ListTruncationNote truncated={truncated} shown={articles.length} noun="help articles" />
    </div>
  );
}
