// Reading a Google Sheet the teacher pasted a link to.
//
// This is the ONE zero-step URL path the app has. Section 7 of
// docs/research/2026-09-08-quizlet-extraction.md verified live (grade A) that
//   https://docs.google.com/spreadsheets/d/<id>/gviz/tq?tqx=out:csv
// answers 200 with quoted CSV to a plain server-side fetch: no auth, no key,
// no user-agent needed. Quizlet, by contrast, cannot be fetched from a Worker
// at all, which is why there is no Quizlet fetcher anywhere in this codebase.
//
// Everything here is plain TypeScript with the fetch passed in, so the whole
// path is unit-testable without a Workers runtime.

/** The one host we will ever fetch a sheet from. */
const SHEET_HOST = 'docs.google.com';

/**
 * `/spreadsheets/d/<id>` and `/spreadsheets/u/0/d/<id>`.
 *
 * The published-to-web shape, `/spreadsheets/d/e/2PACX-.../pubhtml`, is
 * deliberately NOT matched: its id is a different identifier that gviz does not
 * accept, so accepting it here would only produce a confusing failure later.
 * `e` is one character and cannot pass the length floor, so it falls through to
 * the plain-words error below.
 */
const SHEET_PATH_RE = /^\/spreadsheets(?:\/u\/\d{1,3})?\/d\/([A-Za-z0-9_-]{20,120})(?:\/|$)/;

/** A tab id inside the sheet. Google writes it as digits. */
const GID_RE = /^\d{1,20}$/;

export interface SheetTarget {
  id: string;
  /** Which tab. Absent means the first one. */
  gid?: string;
}

export type SheetUrlResult =
  | { ok: true; target: SheetTarget }
  | { ok: false; error: string };

/** What the teacher reads when the link is not a Google Sheets link. */
export const NOT_A_SHEET =
  'That does not look like a Google Sheets link. Open your sheet, copy the link from the address bar, and paste it again.';

/** What the teacher reads when the sheet is not shared. Verified wording. */
export const SHEET_PRIVATE =
  'This sheet is private. In Google Sheets choose Share, then Anyone with the link, then paste again.';

export const SHEET_TOO_BIG =
  'That sheet is too big to read. Try a sheet with fewer rows, or paste the words in instead.';

export const SHEET_SLOW =
  'Google Sheets did not answer in time. Try again in a moment, or paste the words in instead.';

export const SHEET_UNREACHABLE =
  'Could not reach Google Sheets just now. Try again in a moment, or paste the words in instead.';

/**
 * Validates a pasted link and pulls out the sheet id and tab.
 *
 * Strict on purpose: this URL becomes an outbound fetch from our Worker, so the
 * host is compared exactly and the id is matched against a character class
 * rather than sliced out of the path. A link to any other host, or to another
 * part of Google, is refused before any request is made.
 */
export function parseSheetUrl(raw: string): SheetUrlResult {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: NOT_A_SHEET };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: NOT_A_SHEET };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: NOT_A_SHEET };
  }
  if (url.hostname.toLowerCase() !== SHEET_HOST) return { ok: false, error: NOT_A_SHEET };

  const match = SHEET_PATH_RE.exec(url.pathname);
  if (!match) return { ok: false, error: NOT_A_SHEET };

  // Google puts the tab in the fragment (#gid=123) and sometimes in the query.
  const fromHash = /(?:^|[#&?])gid=(\d{1,20})/.exec(url.hash);
  const fromQuery = url.searchParams.get('gid');
  const gid = fromHash?.[1] ?? (fromQuery && GID_RE.test(fromQuery) ? fromQuery : undefined);

  return { ok: true, target: { id: match[1], gid } };
}

/** The CSV endpoint for one sheet. */
export function buildCsvUrl(target: SheetTarget): string {
  const base = `https://${SHEET_HOST}/spreadsheets/d/${target.id}/gviz/tq?tqx=out:csv`;
  return target.gid ? `${base}&gid=${target.gid}` : base;
}

export type SheetFetchResult =
  | { ok: true; text: string }
  | { ok: false; status: number; error: string };

export interface SheetLimits {
  /** Hard ceiling on the CSV we will read into memory. */
  maxBytes: number;
  timeoutMs: number;
}

/**
 * Fetches the CSV for one sheet.
 *
 * Three things can go wrong and each gets its own plain-words answer:
 *   - the sheet is private, which Google answers with a 404 or a redirect to a
 *     sign-in page (an HTML body, never CSV), so a non-2xx OR an HTML
 *     content-type both mean "not shared";
 *   - the sheet is enormous, so the body is counted as it streams and the read
 *     is abandoned the moment it passes the cap, rather than after;
 *   - Google is slow, so the request carries its own timeout.
 */
export async function fetchSheetCsv(
  target: SheetTarget,
  limits: SheetLimits,
  fetchImpl: typeof fetch = fetch
): Promise<SheetFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(buildCsvUrl(target), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.5' },
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === 'AbortError';
    return aborted
      ? { ok: false, status: 504, error: SHEET_SLOW }
      : { ok: false, status: 502, error: SHEET_UNREACHABLE };
  }

  try {
    if (!response.ok) return { ok: false, status: 400, error: SHEET_PRIVATE };

    // A shared sheet answers with CSV. A sign-in page answers with HTML, and it
    // can do so with a 200, so the status alone is not enough.
    const type = (response.headers.get('Content-Type') ?? '').toLowerCase();
    if (type.includes('text/html')) return { ok: false, status: 400, error: SHEET_PRIVATE };

    const declared = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      return { ok: false, status: 413, error: SHEET_TOO_BIG };
    }

    const read = await readBounded(response, limits.maxBytes);
    if (!read.ok) return { ok: false, status: 413, error: SHEET_TOO_BIG };
    if (!read.text.trim()) return { ok: false, status: 400, error: SHEET_PRIVATE };
    return { ok: true, text: read.text };
  } catch {
    return { ok: false, status: 502, error: SHEET_UNREACHABLE };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a body with a hard byte ceiling, cancelling the stream when it is hit. */
async function readBounded(
  response: Response,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false }> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? { ok: false } : { ok: true, text };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

