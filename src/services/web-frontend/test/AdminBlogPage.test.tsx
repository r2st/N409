import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminBlogPage } from '../src/pages/AdminBlogPage';

/**
 * Blog authoring. The console is deliberately the help-article one with a
 * byline, but publishing means something different here: a help article is
 * read by people who are already customers, and a blog post is a public URL a
 * crawler will keep.
 *
 * That difference is what these tests are mostly about. A new post starts as a
 * draft, because one that goes live a moment early is an indexed URL rather
 * than a premature support answer. An empty card image is sent as `null` and
 * not as `''`, because the SEO tags would emit the empty string as an
 * `og:image` pointing at the site root. And deleting is confirmed while
 * unpublishing is not, because unpublishing is reversible and deleting breaks
 * a link somebody may already have shared.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PUBLISHED = {
  id: 'p1',
  slug: 'what-is-a-409a',
  title: 'What is a 409A?',
  excerpt: 'The short version.',
  body_html: '<p>Body.</p>',
  category: 'Basics',
  keywords: '409a valuation',
  author: 'Dana Reyes, ASA',
  og_image: '/img/409a.png',
  published: true,
  published_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
};

const DRAFT = {
  ...PUBLISHED,
  id: 'p2',
  slug: 'safe-notes',
  title: 'SAFE notes and the cap table',
  category: 'Advanced',
  og_image: null,
  published: false,
  published_at: null,
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function mockApi(
  opts: { posts?: () => Response; write?: () => Response } = {},
): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (method !== 'GET') return opts.write ? opts.write() : json({});
      return opts.posts ? opts.posts() : json({ posts: [PUBLISHED, DRAFT] });
    },
  );
  return calls;
}

const problem = (status: number, detail: string) => () =>
  json({ status, title: 'Error', detail }, status);

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminBlogPage />
    </MemoryRouter>,
  );

const ready = () => screen.findByRole('table', { name: 'Blog posts' });
const postRow = (title: string) => screen.getByText(title).closest('tr') as HTMLElement;
const write = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

describe('AdminBlogPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('loading', () => {
    it('waits for the posts', async () => {
      mockApi();
      renderPage();
      expect(screen.getByRole('status')).toBeInTheDocument();
      await ready();
    });

    it('says plainly that the blog is operations-only on a 403', async () => {
      mockApi({ posts: problem(403, 'Forbidden') });
      renderPage();
      expect(await screen.findByRole('alert')).toHaveTextContent('The blog is operations-only.');
    });

    it('gives a generic message for any other failure', async () => {
      mockApi({ posts: problem(500, 'boom') });
      renderPage();
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the blog posts.');
    });

    it('invites the first post when there are none', async () => {
      mockApi({ posts: () => json({ posts: [] }) });
      renderPage();
      expect(await screen.findByText('No posts yet')).toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Blog posts' })).not.toBeInTheDocument();
    });
  });

  describe('the post list', () => {
    it('shows the public URL each post will have', async () => {
      mockApi();
      renderPage();
      await ready();
      expect(within(postRow('What is a 409A?')).getByText('/blog/what-is-a-409a')).toBeInTheDocument();
    });

    it('distinguishes a published post from a draft', async () => {
      mockApi();
      renderPage();
      await ready();
      expect(within(postRow('What is a 409A?')).getByText('Published')).toBeInTheDocument();
      expect(within(postRow('SAFE notes and the cap table')).getByText('Draft')).toBeInTheDocument();
    });

    it('dates a post by when it was first published, and a draft not at all', async () => {
      mockApi();
      renderPage();
      await ready();
      expect(postRow('What is a 409A?')).toHaveTextContent('2026');
      expect(within(postRow('SAFE notes and the cap table')).getByText('—')).toBeInTheDocument();
    });

    it('links a draft at its real URL, labelled as a draft', async () => {
      // An ops session is served the unpublished row there, so what a writer
      // checks is the page itself rather than an approximation of it.
      mockApi();
      renderPage();
      await ready();
      const draft = within(postRow('SAFE notes and the cap table')).getByRole('link', {
        name: 'View draft',
      });
      expect(draft).toHaveAttribute('href', '/blog/safe-notes');
      expect(within(postRow('What is a 409A?')).getByRole('link', { name: 'View' })).toHaveAttribute(
        'href',
        '/blog/what-is-a-409a',
      );
    });
  });

  describe('writing a new post', () => {
    const openNew = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: '+ New post' }));
    };

    it('starts as a draft', async () => {
      // The default that matters: a post that goes live a moment early is a
      // public URL somebody may already have indexed.
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await ready();
      await openNew(user);
      expect(screen.getByLabelText('Published')).not.toBeChecked();
    });

    it('starts in the General category', async () => {
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await ready();
      await openNew(user);
      expect(screen.getByLabelText(/^Category/)).toHaveValue('General');
    });

    it('cannot be created without a title and a slug', async () => {
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await ready();
      await openNew(user);
      const submit = screen.getByRole('button', { name: 'Create post' });
      expect(submit).toBeDisabled();
      await user.type(screen.getByLabelText(/^Title/), 'Down rounds');
      expect(submit).toBeDisabled();
      await user.type(screen.getByLabelText(/^Slug/), 'down-rounds');
      expect(submit).toBeEnabled();
    });

    it('constrains the slug to what can be a URL', async () => {
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await ready();
      await openNew(user);
      expect(screen.getByLabelText(/^Slug/)).toHaveAttribute('pattern', '[a-z0-9-]+');
    });

    it('posts the trimmed fields', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await openNew(user);
      await user.type(screen.getByLabelText(/^Title/), '  Down rounds  ');
      // Unpadded: the slug carries pattern="[a-z0-9-]+", so a padded one is
      // refused by the browser before submit — which is the intended guard,
      // not something to type around.
      await user.type(screen.getByLabelText(/^Slug/), 'down-rounds');
      await user.type(screen.getByLabelText(/^Excerpt/), '  When the price falls.  ');
      await user.type(screen.getByLabelText(/^Byline/), '  Dana Reyes, ASA  ');
      await user.click(screen.getByRole('button', { name: 'Create post' }));
      await waitFor(() => expect(write(calls).length).toBeGreaterThan(0));
      const sent = write(calls)[0]!;
      expect(sent.method).toBe('POST');
      expect(sent.body).toMatchObject({
        title: 'Down rounds',
        slug: 'down-rounds',
        excerpt: 'When the price falls.',
        author: 'Dana Reyes, ASA',
        published: false,
      });
    });

    it('sends no card image as null, not as an empty string', async () => {
      // An empty string is emitted by the SEO tags as an og:image pointing at
      // the site root, which is worse than having no card image at all.
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await openNew(user);
      await user.type(screen.getByLabelText(/^Title/), 'Down rounds');
      await user.type(screen.getByLabelText(/^Slug/), 'down-rounds');
      await user.click(screen.getByRole('button', { name: 'Create post' }));
      await waitFor(() => expect(write(calls).length).toBeGreaterThan(0));
      expect(write(calls)[0]!.body!.og_image).toBeNull();
    });

    it('falls back to General when the category is cleared', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await openNew(user);
      await user.type(screen.getByLabelText(/^Title/), 'Down rounds');
      await user.type(screen.getByLabelText(/^Slug/), 'down-rounds');
      await user.clear(screen.getByLabelText(/^Category/));
      await user.click(screen.getByRole('button', { name: 'Create post' }));
      await waitFor(() => expect(write(calls).length).toBeGreaterThan(0));
      expect(write(calls)[0]!.body!.category).toBe('General');
    });

    it('can be published on creation when that is deliberate', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await openNew(user);
      await user.type(screen.getByLabelText(/^Title/), 'Down rounds');
      await user.type(screen.getByLabelText(/^Slug/), 'down-rounds');
      await user.click(screen.getByLabelText('Published'));
      await user.click(screen.getByRole('button', { name: 'Create post' }));
      await waitFor(() => expect(write(calls).length).toBeGreaterThan(0));
      expect(write(calls)[0]!.body!.published).toBe(true);
    });

    it('closes the editor and re-reads the list once saved', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await openNew(user);
      await user.type(screen.getByLabelText(/^Title/), 'Down rounds');
      await user.type(screen.getByLabelText(/^Slug/), 'down-rounds');
      await user.click(screen.getByRole('button', { name: 'Create post' }));
      await waitFor(() => expect(screen.queryByLabelText(/^Slug/)).not.toBeInTheDocument());
      expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    });

    it('keeps the editor open with its text when the save is refused', async () => {
      const user = userEvent.setup();
      mockApi({ write: problem(409, 'That slug is already taken.') });
      renderPage();
      await ready();
      await openNew(user);
      await user.type(screen.getByLabelText(/^Title/), 'Down rounds');
      await user.type(screen.getByLabelText(/^Slug/), 'what-is-a-409a');
      await user.click(screen.getByRole('button', { name: 'Create post' }));
      expect(await screen.findByText('That slug is already taken.')).toBeInTheDocument();
      expect(screen.getByLabelText(/^Title/)).toHaveValue('Down rounds');
    });

    it('closes on Cancel without writing anything', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await openNew(user);
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByLabelText(/^Slug/)).not.toBeInTheDocument();
      expect(write(calls)).toHaveLength(0);
    });
  });

  describe('editing an existing post', () => {
    it('opens with the stored values, named in the heading', async () => {
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await ready();
      await user.click(within(postRow('What is a 409A?')).getByRole('button', { name: 'Edit' }));
      expect(screen.getByText('Edit “What is a 409A?”')).toBeInTheDocument();
      expect(screen.getByLabelText(/^Slug/)).toHaveValue('what-is-a-409a');
      expect(screen.getByLabelText(/^Byline/)).toHaveValue('Dana Reyes, ASA');
      expect(screen.getByLabelText(/^Card image/)).toHaveValue('/img/409a.png');
      expect(screen.getByLabelText('Published')).toBeChecked();
    });

    it('shows a missing card image as an empty box, not the word null', async () => {
      const user = userEvent.setup();
      mockApi();
      renderPage();
      await ready();
      await user.click(
        within(postRow('SAFE notes and the cap table')).getByRole('button', { name: 'Edit' }),
      );
      expect(screen.getByLabelText(/^Card image/)).toHaveValue('');
    });

    it('patches the post it opened rather than creating another', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.click(within(postRow('What is a 409A?')).getByRole('button', { name: 'Edit' }));
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(write(calls).length).toBeGreaterThan(0));
      expect(write(calls)[0]!.method).toBe('PATCH');
      expect(write(calls)[0]!.url).toMatch(/\/admin\/blog\/posts\/p1$/);
    });
  });

  describe('publishing', () => {
    it('publishes a draft without asking', async () => {
      // Reversible, so no confirmation — the asymmetry with delete is the point.
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.click(
        within(postRow('SAFE notes and the cap table')).getByRole('button', { name: 'Publish' }),
      );
      await waitFor(() => expect(write(calls).length).toBeGreaterThan(0));
      expect(write(calls)[0]!.body).toEqual({ published: true });
      expect(write(calls)[0]!.url).toMatch(/\/admin\/blog\/posts\/p2$/);
    });

    it('unpublishes a published post', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.click(within(postRow('What is a 409A?')).getByRole('button', { name: 'Unpublish' }));
      await waitFor(() => expect(write(calls).length).toBeGreaterThan(0));
      expect(write(calls)[0]!.body).toEqual({ published: false });
    });

    it('reports a refused publish', async () => {
      const user = userEvent.setup();
      mockApi({ write: problem(422, 'A post needs a body before it can be published.') });
      renderPage();
      await ready();
      await user.click(
        within(postRow('SAFE notes and the cap table')).getByRole('button', { name: 'Publish' }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'A post needs a body before it can be published.',
      );
    });
  });

  describe('deleting', () => {
    it('asks first, and says why unpublishing is usually enough', async () => {
      const user = userEvent.setup();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const calls = mockApi();
      renderPage();
      await ready();
      await user.click(within(postRow('What is a 409A?')).getByRole('button', { name: 'Delete' }));
      expect(confirm).toHaveBeenCalledWith(
        'Delete "What is a 409A?"? Unpublishing is usually enough — deleting breaks any link already shared.',
      );
      expect(write(calls)).toHaveLength(0);
    });

    it('deletes once confirmed', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const calls = mockApi();
      renderPage();
      await ready();
      await user.click(within(postRow('What is a 409A?')).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(write(calls).length).toBeGreaterThan(0));
      expect(write(calls)[0]!.method).toBe('DELETE');
      expect(write(calls)[0]!.url).toMatch(/\/admin\/blog\/posts\/p1$/);
    });

    it('reports a refused delete', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      mockApi({ write: problem(409, 'This post is referenced by a campaign.') });
      renderPage();
      await ready();
      await user.click(within(postRow('What is a 409A?')).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This post is referenced by a campaign.',
      );
    });
  });
});
