import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * COUNT THE READS OF THE BODY, NOT THE BYTES THAT COME BACK (R398, M8).
 *
 * `GET /blog/posts` returns exactly what it always returned, so an assertion on
 * the response cannot see this — the same blindness R322's `not.toHaveProperty`
 * and R385's over-walk had. What moved is when the work happens: the entry
 * cached the rows and mapped them per request, and the map runs
 * `readMinutes(post.body_html)`, a character-by-character walk of every post in
 * the index. 7.4 ms of event loop for 200 thirteen-kilobyte posts, 24.4 ms at
 * forty-three, on every anonymous request.
 *
 * So the guard puts a counting getter in front of `body_html` on the rows the
 * driver hands back. Nothing reaches the value without going through it, and
 * the count is per request rather than per byte, which makes it exact rather
 * than a timing assertion.
 */
describe.skipIf(!dbUp)('marketing blog — the index computes its read times once', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  /** Times any row's `body_html` has been read since the last reset. */
  let bodyReads = 0;

  const publicList = () => ctx.app.inject({ method: 'GET', url: '/api/v1/blog/posts' });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    for (let i = 0; i < 3; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/blog/posts',
        headers: authHeader(admin.token),
        payload: {
          slug: `r398-index-post-${i}`,
          title: `Index post ${i}`,
          excerpt: 'A short excerpt.',
          body_html: `<p>${'word '.repeat(440)}</p>`,
          category: 'valuation',
          keywords: 'k',
          author: 'A',
          published: true,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
    }

    // Every row from here on carries the counter, whichever statement produced
    // it — installed once so no test has to remember to install it.
    const original = ctx.pool.query.bind(ctx.pool);
    (ctx.pool as unknown as { query: (...a: unknown[]) => unknown }).query = async (...args: unknown[]) => {
      const result = (await (original as (...a: unknown[]) => unknown)(...args)) as {
        rows?: Array<Record<string, unknown>>;
      };
      for (const row of result?.rows ?? []) {
        if (!(row && typeof row === 'object' && 'body_html' in row)) continue;
        const value = row.body_html;
        Object.defineProperty(row, 'body_html', {
          configurable: true,
          enumerable: true,
          get() {
            bodyReads += 1;
            return value;
          },
        });
      }
      return result;
    };
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('reads the bodies on the miss and not again while the entry stands', async () => {
    const first = await publicList();
    expect(first.statusCode).toBe(200);
    // The miss reads them: `read_minutes` is derived from the body, so this is
    // the work the answer genuinely costs.
    expect(bodyReads).toBeGreaterThan(0);

    for (let i = 0; i < 4; i += 1) {
      bodyReads = 0;
      const again = await publicList();
      expect(again.statusCode).toBe(200);
      // ...and the four requests behind it do not.
      expect(bodyReads, `request ${i + 2}`).toBe(0);
      expect(again.json()).toEqual(first.json());
    }
  });

  it('still sends the read time and still withholds the body', async () => {
    const posts = (await publicList()).json().posts as Array<Record<string, unknown>>;
    const post = posts.find((p) => p.slug === 'r398-index-post-0')!;
    // 440 words at 220 a minute.
    expect(post.read_minutes).toBe(2);
    expect(post).not.toHaveProperty('body_html');
    expect(post.excerpt).toBe('A short excerpt.');
  });

  it('recomputes after a write clears the entry, so an edited post is not stale', async () => {
    const listed = (await publicList()).json().posts as Array<{ slug: string; id?: string }>;
    expect(listed.some((p) => p.slug === 'r398-index-post-0')).toBe(true);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/blog/posts',
      headers: authHeader(admin.token),
      payload: {
        slug: 'r398-index-post-late',
        title: 'Late post',
        excerpt: 'Later.',
        body_html: `<p>${'word '.repeat(1100)}</p>`,
        category: 'valuation',
        keywords: 'k',
        author: 'A',
        published: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    bodyReads = 0;
    const after = (await publicList()).json().posts as Array<Record<string, unknown>>;
    // The write cleared the entry, so the bodies are read again — which is the
    // point: a cached projection that never recomputed would be worse than the
    // cost it saves.
    expect(bodyReads).toBeGreaterThan(0);
    const late = after.find((p) => p.slug === 'r398-index-post-late')!;
    expect(late.read_minutes).toBe(5);
  });
});
