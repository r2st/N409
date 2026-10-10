import { describe, expect, it } from 'vitest';
import { esc, table, P, section } from '../../src/domain/exhibitHtml.js';

describe('esc — HTML entity escaping for exhibit cells', () => {
  it('escapes ampersands', () => {
    expect(esc('A & B')).toBe('A &amp; B');
  });

  it('escapes angle brackets', () => {
    expect(esc('Series A <old>')).toBe('Series A &lt;old&gt;');
  });

  it('escapes all three in one string', () => {
    expect(esc('a < b & b > c')).toBe('a &lt; b &amp; b &gt; c');
  });

  it('passes through already-safe text unchanged', () => {
    expect(esc('Founders Common')).toBe('Founders Common');
    expect(esc('')).toBe('');
  });

  it('escapes injected script tags', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('table', () => {
  it('renders a basic table with head and body rows', () => {
    const html = table({
      head: ['Class', 'Shares'],
      rows: [['Common', '1,000'], ['Preferred A', '500']],
    });
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>Class</th>');
    expect(html).toContain('<td>Common</td>');
    expect(html).toContain('<td>500</td>');
    expect(html).not.toContain('<strong>');
  });

  it('renders a footer row in bold when foot is provided', () => {
    const html = table({
      head: ['Item', 'Total'],
      rows: [['Revenue', '$100']],
      foot: ['Total', '$100'],
    });
    expect(html).toContain('<strong>Total</strong>');
    expect(html).toContain('<strong>$100</strong>');
  });

  it('omits the footer entirely when foot is not provided', () => {
    const html = table({
      head: ['A'],
      rows: [['1']],
    });
    const bodyEnd = html.indexOf('</tbody>');
    const afterBody = html.slice(bodyEnd);
    expect(afterBody).not.toContain('<strong>');
  });
});

describe('P', () => {
  it('wraps text in a paragraph tag', () => {
    expect(P('hello')).toBe('<p>hello</p>');
  });
});

describe('section', () => {
  it('returns a section when parts have content', () => {
    const result = section('Schedule A', ['<p>Content</p>']);
    expect(result).toEqual({ heading: 'Schedule A', html: '<p>Content</p>' });
  });

  it('returns null when all parts are empty or null (degradation rule)', () => {
    expect(section('Empty', [null, '', null])).toBeNull();
    expect(section('Empty', [])).toBeNull();
  });

  it('filters out null and empty parts, keeping valid ones', () => {
    const result = section('Mixed', [null, '<p>A</p>', '', '<p>B</p>', null]);
    expect(result).toEqual({ heading: 'Mixed', html: '<p>A</p><p>B</p>' });
  });

  it('includes schedules array when provided and non-empty', () => {
    const result = section('Schedule', ['<p>X</p>'], ['sched-a', 'sched-b']);
    expect(result).toEqual({
      heading: 'Schedule',
      html: '<p>X</p>',
      schedules: ['sched-a', 'sched-b'],
    });
  });

  it('omits schedules key when array is empty', () => {
    const result = section('No Schedules', ['<p>X</p>'], []);
    expect(result).toEqual({ heading: 'No Schedules', html: '<p>X</p>' });
    expect(result).not.toHaveProperty('schedules');
  });
});
