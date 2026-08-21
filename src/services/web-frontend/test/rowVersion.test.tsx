import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { paramsVersionKey, resetRowVersions, useRowVersion } from '../src/lib/rowVersion';

/**
 * The store behind the shared optimistic-lock version.
 *
 * `valuation_params` is one row holding three separately-edited documents, and
 * every writer moves the one counter. So the version belongs to the row rather
 * than to whichever panel happened to read it last: two panels on one tab, both
 * writing, must not each hold a private copy that the other invalidates without
 * telling them.
 */

let setters: Record<string, (v: number | undefined) => void> = {};

function Reader({ id, name }: { id: string; name: string }) {
  const [version, setVersion] = useRowVersion(paramsVersionKey(id));
  setters[name] = setVersion;
  return <output data-testid={name}>{version === undefined ? 'none' : String(version)}</output>;
}

const shown = (name: string) => screen.getByTestId(name).textContent;

describe('useRowVersion', () => {
  afterEach(() => {
    resetRowVersions();
    setters = {};
  });

  it('starts with no opinion, which is what makes If-Match optional', () => {
    render(<Reader id="v1" name="a" />);
    expect(shown('a')).toBe('none');
  });

  it('shows one writer’s version to every reader of the same row', () => {
    render(
      <>
        <Reader id="v1" name="a" />
        <Reader id="v1" name="b" />
      </>,
    );
    act(() => setters.a!(7));
    expect(shown('a')).toBe('7');
    expect(shown('b')).toBe('7');
  });

  /**
   * Different engagements are different rows. Sharing across them would hand a
   * panel a version from a table it has never read — a conflict on every save,
   * for a reason nothing on screen could explain.
   */
  it('keeps rows apart', () => {
    render(
      <>
        <Reader id="v1" name="a" />
        <Reader id="v2" name="b" />
      </>,
    );
    act(() => setters.a!(7));
    expect(shown('a')).toBe('7');
    expect(shown('b')).toBe('none');
  });

  /** Clearing is a real value: a panel that reloads against a server with no
   *  version has to be able to say so, and go back to last-write-wins. */
  it('can be set back to no opinion', () => {
    render(<Reader id="v1" name="a" />);
    act(() => setters.a!(7));
    act(() => setters.a!(undefined));
    expect(shown('a')).toBe('none');
  });

  /**
   * The entry is keyed by valuation id, so a session that visits many
   * engagements would accumulate one per visit if nothing dropped them. Both
   * readers unmounting is the signal that nobody is left to care.
   */
  it('forgets a row once its last reader unmounts', () => {
    const first = render(<Reader id="v1" name="a" />);
    act(() => setters.a!(7));
    first.unmount();

    render(<Reader id="v1" name="b" />);
    expect(shown('b')).toBe('none');
  });

  /**
   * A row's version only goes up. A panel that reloads after saving can have
   * its read answered *after* somebody else's write lands, and the number it
   * comes back with was already history — adopting it would refuse the next
   * save for a change nobody made since.
   */
  it('ignores a version older than the one it is holding', () => {
    render(<Reader id="v1" name="a" />);
    act(() => setters.a!(9));
    act(() => setters.a!(7));
    expect(shown('a')).toBe('9');
  });

  it('still takes a newer version', () => {
    render(<Reader id="v1" name="a" />);
    act(() => setters.a!(9));
    act(() => setters.a!(10));
    expect(shown('a')).toBe('10');
  });

  it('keeps the version while another reader is still mounted', () => {
    const view = render(
      <>
        <Reader id="v1" name="a" />
        <Reader id="v1" name="b" />
      </>,
    );
    act(() => setters.a!(7));
    view.rerender(<Reader id="v1" name="b" />);
    expect(shown('b')).toBe('7');
  });
});
