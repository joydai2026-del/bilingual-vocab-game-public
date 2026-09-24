// The one call that turns whatever a teacher pasted into words.
//
// `POST /api/extract` runs the worker's dictionary segmentation, so a
// paragraph, a run of characters with no spaces at all, or a mis-organised
// list all come back as items. It is a helper, never a gate: if it is slow,
// offline, or answers with something we do not recognise, the caller falls
// back to the local parser and the teacher never sees a dead end.

export interface ExtractedItem {
  zh: string;
  pinyin: string;
  en: string;
}

export interface ExtractOutcome {
  items: ExtractedItem[];
  skipped: string[];
  /**
   * Notices that are not unread lines: a word defined twice, a meaning we did
   * not use, how much Quizlet sidebar came off. Empty when the worker sent
   * none, an older worker's reply included.
   */
  notes: string[];
  /** What the worker thought it was reading. Kept for diagnostics only. */
  mode: 'structured' | 'free' | 'unknown';
  /**
   * The worker read the paste and decided it holds no vocabulary at all: it is
   * headings, a lesson index, paperwork. NOT the same as "the worker found
   * nothing", which still deserves a second look from the local parser.
   *
   * False for every reply that does not say so, an older worker's included.
   */
  paperworkOnly: boolean;
}

/** Past this we stop waiting and parse locally instead. */
const TIMEOUT_MS = 8000;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Reads the worker's answer defensively: a missing field is empty, not a throw. */
export function readExtractBody(body: unknown): ExtractOutcome | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as {
    items?: unknown;
    skipped?: unknown;
    notes?: unknown;
    mode?: unknown;
    paperworkOnly?: unknown;
  };
  if (!Array.isArray(raw.items)) return null;

  const items: ExtractedItem[] = [];
  for (const entry of raw.items) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { zh?: unknown; pinyin?: unknown; en?: unknown };
    const zh = asString(row.zh);
    if (!zh) continue;
    items.push({ zh, pinyin: asString(row.pinyin), en: asString(row.en) });
  }

  const skipped = Array.isArray(raw.skipped)
    ? raw.skipped.filter((line): line is string => typeof line === 'string')
    : [];

  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter((line): line is string => typeof line === 'string')
    : [];

  const mode = raw.mode === 'structured' || raw.mode === 'free' ? raw.mode : 'unknown';
  // Only the literal `true` counts, and only alongside an empty list: a claim
  // of "no vocabulary here" next to a list of words is a reply we do not
  // understand, and the words win.
  const paperworkOnly = raw.paperworkOnly === true && items.length === 0;
  return { items, skipped, notes, mode, paperworkOnly };
}

/**
 * Asks the worker to pull words out of `text`. Returns null when the worker
 * could not be used at all, which means "parse it locally instead".
 */
export async function extractWords(text: string): Promise<ExtractOutcome | null> {
  if (!text.trim()) return null;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;

  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller?.signal,
    });
    if (!response.ok) return null;
    return readExtractBody(await response.json());
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

