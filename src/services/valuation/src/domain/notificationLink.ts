/**
 * Where an in-app notification points, and what it is not allowed to point at.
 *
 * The notification centre renders this as a router link, so the value is a
 * navigation target in the reader's own session. Nothing user-supplied reaches
 * it today — every writer is a route or a sweep in this service — but "no
 * caller passes anything dangerous" is a property of the callers, and the set
 * of callers grows. A single stored `//evil.example` is a protocol-relative
 * URL: React Router hands it to the browser unchanged and the reader leaves
 * the application from a link inside their own inbox, having clicked something
 * the platform wrote.
 *
 * So the shape is fixed rather than trusted, in three places that each fail
 * closed on their own — this function at the write, a CHECK constraint on the
 * column (migration 0188), and the same test in the page that draws it. A path
 * that does not qualify is dropped, not corrected: a notification without a
 * link is the state the whole table was in until this column existed, and it
 * is a strictly better outcome than one whose link goes somewhere else.
 */
export function appPath(path: string | null | undefined): string | null {
  if (!path) return null;
  // One leading slash and no second one — `//host` and `/\host` are both
  // protocol-relative in a browser, and the backslash form is the one a check
  // written as `startsWith('//')` misses.
  if (!/^\/[^/\\]/.test(path)) return null;
  // Control characters, including the newline and tab a URL parser strips
  // before resolving — a path carrying one is not the path it appears to be.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path;
}
