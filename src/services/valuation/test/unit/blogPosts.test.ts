import { describe, expect, it } from 'vitest';
import { resolvePublishedAt } from '../../src/repos/blogPosts.js';

/**
 * The publication date rule (design §16.2, migration 0122).
 *
 * Small enough to state in one function and important enough to test on its
 * own: it is the field a reader uses to judge whether an article is current,
 * and the field a search engine reorders results by. Getting it wrong is not
 * visible in the UI — the post simply moves.
 */
describe('resolvePublishedAt', () => {
  const jan = new Date('2026-01-10T09:00:00.000Z');
  const mar = new Date('2026-03-04T15:00:00.000Z');

  it('stamps now on first publish', () => {
    expect(resolvePublishedAt(null, { published: true }, mar)).toEqual(mar);
  });

  it('leaves a draft undated', () => {
    expect(resolvePublishedAt(null, { published: false }, mar)).toBeNull();
  });

  it('keeps the original date through a later edit', () => {
    // A typo fixed in March must not re-date a January article: the index
    // would reorder and every crawler that indexed it would see it as new.
    expect(resolvePublishedAt(jan, { published: true }, mar)).toEqual(jan);
  });

  it('keeps the date through an unpublish', () => {
    // Losing it here is what makes the *re*-publish re-date the post.
    expect(resolvePublishedAt(jan, { published: false }, mar)).toEqual(jan);
  });

  it('keeps the date through an unpublish and re-publish', () => {
    const afterUnpublish = resolvePublishedAt(jan, { published: false }, mar);
    expect(resolvePublishedAt(afterUnpublish, { published: true }, mar)).toEqual(jan);
  });

  it('lets an explicit date win, for a migrated article', () => {
    const backDated = new Date('2024-05-05T00:00:00.000Z');
    expect(resolvePublishedAt(jan, { published: true, published_at: backDated }, mar)).toEqual(backDated);
    // Including on a post that has never been published.
    expect(resolvePublishedAt(null, { published: false, published_at: backDated }, mar)).toEqual(backDated);
  });

  it('treats an absent date as "leave it alone", not as "clear it"', () => {
    // A patch that touches only the title arrives with published_at undefined,
    // and must not blank the field the CHECK constraint requires.
    expect(resolvePublishedAt(jan, { published: true, published_at: undefined }, mar)).toEqual(jan);
    expect(resolvePublishedAt(jan, { published: true, published_at: null }, mar)).toEqual(jan);
  });
});
