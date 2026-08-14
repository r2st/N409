import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BlogIndexPage, BlogPostPage } from '../src/pages/marketing/BlogPages';

/**
 * The marketing blog (design §16.2, P2-20).
 *
 * A blog page's job is to be found and to be readable. So the tests are about
 * the two things a blog gets wrong: the article body not rendering as authored
 * HTML, and a draft previewed at its real URL being indexable.
 */

const ROLES = { current: [] as string[] };

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: ROLES.current.length > 0 ? 'authenticated' : 'anonymous',
    user:
      ROLES.current.length > 0
        ? {
            id: '01N409OPSUSER000000000000A',
            email: 'olive@n409.example',
            first_name: 'Olive',
            last_name: 'Ops',
            verified: true,
            sso_provider: null,
            partner_id: null,
            roles: ROLES.current,
          }
        : null,
  }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const POST = {
  slug: 'what-a-409a-defends',
  title: 'What a 409A actually has to defend',
  excerpt: 'A 409A is not a number — it is an argument.',
  body_html: '<p>The number is its conclusion.</p><h2>The inputs</h2><p>Every figure traces.</p>',
  category: 'Methodology',
  keywords: '409a audit',
  author: 'The N409 team',
  og_image: null,
  published: true,
  published_at: '2026-02-01T09:00:00Z',
};

function mockApi(
  over: { posts?: unknown[]; post?: unknown; publicStatus?: number; adminStatus?: number } = {},
) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/admin/blog/posts/')) {
      const status = over.adminStatus ?? 200;
      return jsonResponse(status >= 400 ? { status } : { post: over.post ?? POST }, status);
    }
    if (path.includes('/blog/posts/')) {
      const status = over.publicStatus ?? 200;
      return jsonResponse(status >= 400 ? { status } : { post: over.post ?? POST }, status);
    }
    if (path.includes('/blog/posts')) {
      return jsonResponse({ posts: over.posts ?? [POST] });
    }
    return jsonResponse({}, 404);
  });
  return calls;
}

const renderIndex = () =>
  render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/blog']}>
        <BlogIndexPage />
      </MemoryRouter>
    </HelmetProvider>,
  );

const renderPost = (slug = POST.slug) =>
  render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[`/blog/${slug}`]}>
        <Routes>
          <Route path="/blog/:slug" element={<BlogPostPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );

describe('blog index', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ROLES.current = [];
  });

  it('lists posts with their date, byline and a link into the article', async () => {
    mockApi();
    renderIndex();
    const link = await screen.findByRole('link', { name: POST.title });
    expect(link).toHaveAttribute('href', `/blog/${POST.slug}`);
    expect(screen.getByText(POST.excerpt)).toBeInTheDocument();
    expect(screen.getByText('The N409 team')).toBeInTheDocument();
    expect(screen.getByText('Methodology')).toBeInTheDocument();
  });

  it('dates the entry with a machine-readable time element', async () => {
    // The date is what a reader judges an article's currency by, and a
    // <time datetime> is what makes it legible to anything else.
    mockApi();
    renderIndex();
    await screen.findByRole('link', { name: POST.title });
    const time = document.querySelector('time');
    expect(time).toHaveAttribute('datetime', POST.published_at);
  });

  it('says the blog is empty rather than looking broken', async () => {
    mockApi({ posts: [] });
    renderIndex();
    expect(await screen.findByText(/Nothing published yet/)).toBeInTheDocument();
  });

  it('reports a failure instead of an empty blog', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    renderIndex();
    expect(await screen.findByText(/Could not load the blog/)).toBeInTheDocument();
  });

  it('shows the reading time the server derived', async () => {
    mockApi({ posts: [{ ...POST, read_minutes: 7 }] });
    renderIndex();
    expect(await screen.findByText('7 min read')).toBeInTheDocument();
  });

  // A library of thirty articles in one flat list is a library nobody reads
  // past the fold.
  it('filters the index by category, and counts each one', async () => {
    const tax = { ...POST, slug: 'qsbs', title: 'QSBS', category: 'Tax' };
    mockApi({ posts: [POST, tax, { ...tax, slug: 'ordinary-loss', title: '1244' }] });
    renderIndex();

    await screen.findByRole('link', { name: POST.title });
    expect(screen.getByRole('button', { name: 'All 3' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Tax 2' }));
    expect(screen.queryByRole('link', { name: POST.title })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'QSBS' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '1244' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All 3' }));
    expect(screen.getByRole('link', { name: POST.title })).toBeInTheDocument();
  });

  it('offers no filter row when every post shares one category', async () => {
    // One button reading "All 1" next to one reading "Methodology 1" is noise.
    mockApi({ posts: [POST, { ...POST, slug: 'second', title: 'Second' }] });
    renderIndex();
    await screen.findByRole('link', { name: POST.title });
    expect(screen.queryByRole('group', { name: /category/i })).not.toBeInTheDocument();
  });
});

describe('blog post', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ROLES.current = [];
  });

  it('renders the authored body as HTML, not as escaped text', async () => {
    // The body is sanitised server-side on write with the report policy;
    // rendering it as text would show the reader their own markup.
    mockApi();
    renderPost();
    expect(await screen.findByRole('heading', { name: 'The inputs' })).toBeInTheDocument();
    expect(screen.getByText('The number is its conclusion.')).toBeInTheDocument();
    expect(screen.queryByText(/<p>/)).not.toBeInTheDocument();
  });

  it('shows a 404 body for an unknown post and does not ask the admin endpoint', async () => {
    const calls = mockApi({ publicStatus: 404 });
    renderPost('no-such-post');
    expect(await screen.findByText(/Post not found/)).toBeInTheDocument();
    // An anonymous reader must not probe an ops endpoint on every dead link.
    expect(calls.some((c) => c.includes('/admin/blog'))).toBe(false);
  });

  it('falls back to the draft preview for an ops reader', async () => {
    ROLES.current = ['admin'];
    const calls = mockApi({
      publicStatus: 404,
      post: { ...POST, published: false, published_at: null },
    });
    renderPost();
    expect(await screen.findByRole('heading', { name: POST.title })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.includes('/admin/blog/posts/'))).toBe(true));
    expect(screen.getByText(/draft — not public/)).toBeInTheDocument();
  });

  it('gives up gracefully when even the preview is missing', async () => {
    ROLES.current = ['admin'];
    mockApi({ publicStatus: 404, adminStatus: 404 });
    renderPost('never-existed');
    expect(await screen.findByText(/Post not found/)).toBeInTheDocument();
  });

  it('offers the way back to the index from both states', async () => {
    mockApi();
    const { unmount } = renderPost();
    expect(await screen.findByRole('link', { name: /All posts/ })).toHaveAttribute('href', '/blog');
    unmount();

    vi.restoreAllMocks();
    mockApi({ publicStatus: 404 });
    renderPost('gone');
    expect(await screen.findByRole('link', { name: /All posts/ })).toHaveAttribute('href', '/blog');
  });
});
