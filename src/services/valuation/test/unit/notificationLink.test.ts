import { describe, expect, it } from 'vitest';
import { appPath } from '../../src/domain/notificationLink.js';

/**
 * The value a notification's "Open →" becomes (R218).
 *
 * Nothing user-supplied reaches this today — every writer is a route or a
 * sweep in this service — but "no caller passes anything dangerous" is a
 * property of the callers, and callers are added. What the page does with the
 * value is navigate to it, so the shapes below are the ones that would take a
 * reader out of the application from a link inside their own inbox.
 */
describe('notification link', () => {
  it('keeps an app-relative path', () => {
    expect(appPath('/billing')).toBe('/billing');
    expect(appPath('/valuations/01N409VAL00000000000000AAA')).toBe('/valuations/01N409VAL00000000000000AAA');
    expect(appPath('/admin/jobs?source=email')).toBe('/admin/jobs?source=email');
  });

  it('treats an absent link as no link', () => {
    expect(appPath(null)).toBeNull();
    expect(appPath(undefined)).toBeNull();
    expect(appPath('')).toBeNull();
  });

  it('refuses anything that leaves the application', () => {
    // Protocol-relative, in both spellings — a check written as
    // `startsWith('//')` passes the second one.
    expect(appPath('//evil.example/take-over')).toBeNull();
    expect(appPath('/\\evil.example/take-over')).toBeNull();
    expect(appPath('https://evil.example')).toBeNull();
    expect(appPath('javascript:alert(1)')).toBeNull();
    // Not anchored to the app root, so it resolves against whatever page the
    // reader happens to be on.
    expect(appPath('billing')).toBeNull();
  });

  it('refuses a control character a URL parser would strip before resolving', () => {
    expect(appPath('/\tjavascript:alert(1)')).toBeNull();
    expect(appPath('/billing\n')).toBeNull();
  });
});
