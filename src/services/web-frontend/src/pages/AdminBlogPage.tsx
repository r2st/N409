import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { all, optional, pattern, required, useFormValidation } from '../lib/useFormValidation';
import { formatDate } from '../lib/format';
import { Button, EmptyState, ErrorNote, Field, Spinner, TextInput } from '../components/ui';
import { RichTextEditor } from '../components/RichTextEditor';

/**
 * Blog authoring (design §16.2).
 *
 * Deliberately the help-article console with a byline and a date rather than a
 * new kind of editor: the writing surface an ops user already knows, over a
 * table shaped the same way. What is different is what publishing means — a
 * help article is read by people who are already customers, and a blog post is
 * a public URL a crawler will keep. So a draft here gets a "view draft" link to
 * its real page, and unpublishing is offered before deleting.
 */

interface BlogPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body_html: string;
  category: string;
  keywords: string;
  author: string;
  og_image: string | null;
  published: boolean;
  published_at: string | null;
  updated_at: string;
}

type EditorState = {
  id?: string;
  slug: string;
  title: string;
  excerpt: string;
  body_html: string;
  category: string;
  keywords: string;
  author: string;
  og_image: string;
  published: boolean;
};

/**
 * The slug shape the box declares as `pattern`. It is the public URL, so a
 * capital letter or a space here is a 404 for everyone the link is sent to.
 */
const SLUG = /[a-z0-9-]+/;

const emptyEditor = (): EditorState => ({
  slug: '',
  title: '',
  excerpt: '',
  body_html: '',
  category: 'General',
  keywords: '',
  author: '',
  og_image: '',
  // Drafts by default, unlike help articles. A help article that goes live a
  // moment early is a support answer; a blog post that does is a public URL
  // somebody may already have indexed.
  published: false,
});

/** What the rules read while no post is open. */
const CLOSED_EDITOR: EditorState = emptyEditor();

export function AdminBlogPage() {
  const [posts, setPosts] = useState<BlogPost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ posts: BlogPost[] }>('/admin/blog/posts')
      .then((d) => setPosts(d.posts))
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 403
            ? 'The blog is operations-only.'
            : 'Could not load the blog posts.',
        ),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openEdit = (p: BlogPost) =>
    setEditor({
      id: p.id,
      slug: p.slug,
      title: p.title,
      excerpt: p.excerpt,
      body_html: p.body_html,
      category: p.category,
      keywords: p.keywords,
      author: p.author,
      og_image: p.og_image ?? '',
      published: p.published,
    });

  /*
   * `useFormValidation` is a hook, so it runs whether or not a post is open;
   * `CLOSED_EDITOR` is what it reads when none is. Nothing is ever revealed on
   * a form that is not on screen, so the blank failing `required` costs
   * nothing.
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(editor ?? CLOSED_EDITOR, {
    title: required('title', 'Title'),
    slug: all(
      required('slug', 'Slug'),
      pattern('slug', SLUG, 'Slug must be lowercase letters, digits and dashes only.'),
    ),
    /*
     * The hint has always said "an https URL or a site-relative path" and
     * nothing checked it. What a bad value produces is not an error but a
     * wrong link preview: `og:image` is emitted verbatim, so "images/card.png"
     * resolves against whatever page shares the link.
     */
    og_image: optional('og_image', (values) => {
      const value = values.og_image.trim();
      return value.startsWith('https://') || value.startsWith('/')
        ? null
        : 'Card image must be an https:// URL or a path starting with “/”.';
    }),
  });

  const save = handleSubmit(async () => {
    if (!editor) return;
    setBusy(true);
    setEditorError(null);
    const body = {
      slug: editor.slug.trim(),
      title: editor.title.trim(),
      excerpt: editor.excerpt.trim(),
      body_html: editor.body_html,
      category: editor.category.trim() || 'General',
      keywords: editor.keywords.trim(),
      author: editor.author.trim(),
      // Empty means "no card image", not an empty string the SEO tags would
      // then emit as an og:image pointing at the site root.
      og_image: editor.og_image.trim() || null,
      published: editor.published,
    };
    try {
      if (editor.id) {
        await api(`/admin/blog/posts/${editor.id}`, { method: 'PATCH', body });
      } else {
        await api('/admin/blog/posts', { method: 'POST', body });
      }
      setEditor(null);
      load();
    } catch (err) {
      setEditorError(err instanceof ApiError ? err.message : 'Could not save the post.');
    } finally {
      setBusy(false);
    }
  });

  const togglePublished = async (p: BlogPost) => {
    try {
      await api(`/admin/blog/posts/${p.id}`, { method: 'PATCH', body: { published: !p.published } });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the post.');
    }
  };

  const remove = async (p: BlogPost) => {
    if (
      !window.confirm(
        `Delete "${p.title}"? Unpublishing is usually enough — deleting breaks any link already shared.`,
      )
    ) {
      return;
    }
    try {
      await api(`/admin/blog/posts/${p.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the post.');
    }
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!posts) return <Spinner />;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Operations</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Blog</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-500">
            The public marketing blog at{' '}
            <Link to="/blog" className="font-semibold text-bond-600 hover:text-bond-700">
              /blog
            </Link>
            . Published posts are visible to anyone, indexed by search engines, and dated by when they were
            first published — not by when they were last edited.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditorError(null);
            setEditor(emptyEditor());
          }}
        >
          + New post
        </Button>
      </div>

      {editor && (
        <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-5 text-ink-400">{editor.id ? `Edit “${editor.title}”` : 'New post'}</h2>
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
                hint="Lowercase letters, digits and dashes; this is the public URL."
                error={errorFor('slug')}
              >
                <TextInput
                  required
                  maxLength={120}
                  pattern="[a-z0-9-]+"
                  value={editor.slug}
                  onChange={(e) => setEditor({ ...editor, slug: e.target.value })}
                  onBlur={blurHandler('slug')}
                />
              </Field>
              <Field
                label="Excerpt"
                hint="Shown on the index and in the link preview. Two sentences at most."
              >
                <TextInput
                  maxLength={500}
                  value={editor.excerpt}
                  onChange={(e) => setEditor({ ...editor, excerpt: e.target.value })}
                />
              </Field>
              <Field label="Byline" hint="The name the piece is published under, e.g. “Dana Reyes, ASA”.">
                <TextInput
                  maxLength={200}
                  value={editor.author}
                  onChange={(e) => setEditor({ ...editor, author: e.target.value })}
                />
              </Field>
              <Field label="Category">
                <TextInput
                  maxLength={100}
                  value={editor.category}
                  onChange={(e) => setEditor({ ...editor, category: e.target.value })}
                />
              </Field>
              <Field label="Keywords" hint="Space-separated search terms.">
                <TextInput
                  maxLength={500}
                  value={editor.keywords}
                  onChange={(e) => setEditor({ ...editor, keywords: e.target.value })}
                />
              </Field>
              <Field
                label="Card image"
                hint="An https URL or a site-relative path. Optional."
                error={errorFor('og_image')}
              >
                <TextInput
                  maxLength={500}
                  value={editor.og_image}
                  onChange={(e) => setEditor({ ...editor, og_image: e.target.value })}
                  onBlur={blurHandler('og_image')}
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
                {busy ? 'Saving…' : editor.id ? 'Save changes' : 'Create post'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}

      {posts.length === 0 && (
        <div className="mt-6">
          <EmptyState title="No posts yet">
            Write the first one — it will appear at /blog as soon as it is published.
          </EmptyState>
        </div>
      )}

      {posts.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[760px] text-sm" aria-label="Blog posts">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Post</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Category</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Status</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Published</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id} className="border-b border-paper-200 last:border-0">
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-ink-900">{p.title}</div>
                    <div className="font-mono text-xs text-ink-400">/blog/{p.slug}</div>
                  </td>
                  <td className="px-5 py-3.5 text-ink-600">{p.category}</td>
                  <td className="px-5 py-3.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                        p.published
                          ? 'bg-bond-50 text-bond-700 ring-bond-200'
                          : 'bg-paper-200 text-ink-500 ring-ink-200'
                      }`}
                    >
                      {p.published ? 'Published' : 'Draft'}
                    </span>
                  </td>
                  <td className="tnum px-5 py-3.5 text-ink-600">
                    {p.published_at ? formatDate(p.published_at) : '—'}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex gap-3 text-xs font-semibold">
                      <button
                        onClick={() => openEdit(p)}
                        className="cursor-pointer text-bond-600 hover:text-bond-700"
                      >
                        Edit
                      </button>
                      {/* A draft opens at its real URL — an ops session is
                          served the unpublished row there, so what a writer
                          checks is the page and not an approximation of it. */}
                      <Link
                        to={`/blog/${p.slug}`}
                        className="text-ink-500 hover:text-ink-700"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {p.published ? 'View' : 'View draft'}
                      </Link>
                      <button
                        onClick={() => void togglePublished(p)}
                        className="cursor-pointer text-ink-500 hover:text-ink-700"
                      >
                        {p.published ? 'Unpublish' : 'Publish'}
                      </button>
                      <button
                        onClick={() => void remove(p)}
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
    </div>
  );
}
