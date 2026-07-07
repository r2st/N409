/**
 * Fetches a partner logo for PDF embedding (improvement 8). Deliberately
 * strict: http(s) only, 3s timeout, 1 MB cap, and PNG/JPEG magic-byte
 * sniffing (the only formats PDFKit can embed). Every failure returns null —
 * a missing logo must never block a report render.
 */

const MAX_LOGO_BYTES = 1024 * 1024;
const TIMEOUT_MS = 3_000;

export function sniffImageKind(buf: Buffer): 'png' | 'jpeg' | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))) {
    return 'png';
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

export async function fetchPartnerLogo(
  logoUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer | null> {
  if (!logoUrl) return null;
  let url: URL;
  try {
    url = new URL(logoUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_LOGO_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_LOGO_BYTES) return null;
    return sniffImageKind(buf) ? buf : null;
  } catch {
    return null;
  }
}
