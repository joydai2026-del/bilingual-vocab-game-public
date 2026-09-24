// English gloss filling. Asks the worker (`POST /api/enrich`), caches every
// answer in localStorage keyed by the Chinese word, and never blocks the
// teacher: if the network fails the gloss stays blank and the review screen
// says so in plain words.

const CACHE_KEY = 'bvg.gloss.v1';
const BATCH_SIZE = 40; // the worker caps a request at 40 items

type Cache = Record<string, string>;

function readCache(): Cache {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Cache;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Cache): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage unavailable or full: we just lose the cache, not the glosses
  }
}

export interface EnrichResult {
  /** zh -> English gloss, only for words we actually filled. */
  filled: Map<string, string>;
  /** How many words we asked about but still have no gloss for. */
  missing: number;
  /** A plain-language message to show the teacher, or null when all is well. */
  message: string | null;
}

interface EnrichResponse {
  items?: { zh?: string; en?: string }[];
}

async function requestBatch(batch: { zh: string; en?: string }[]): Promise<Map<string, string>> {
  const response = await fetch('/api/enrich', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: batch }),
  });
  if (!response.ok) {
    throw new Error(`enrich failed with status ${response.status}`);
  }
  const data = (await response.json()) as EnrichResponse;
  const out = new Map<string, string>();
  for (const item of data.items ?? []) {
    const zh = (item.zh ?? '').trim();
    const en = (item.en ?? '').trim();
    if (zh && en) out.set(zh, en);
  }
  return out;
}

/**
 * Fills the English column for every item whose gloss is empty. Cached words
 * cost nothing; the rest go to the worker in batches of 40.
 */
export async function fillMissingGlosses(
  items: { zh: string; en: string }[]
): Promise<EnrichResult> {
  const filled = new Map<string, string>();
  const needed: string[] = [];
  const cache = readCache();

  for (const item of items) {
    const zh = item.zh.trim();
    if (!zh || item.en.trim()) continue;
    const cached = cache[zh];
    if (cached) {
      filled.set(zh, cached);
      continue;
    }
    if (!needed.includes(zh)) needed.push(zh);
  }

  if (needed.length === 0) {
    return { filled, missing: 0, message: null };
  }

  let networkFailed = false;
  for (let i = 0; i < needed.length; i += BATCH_SIZE) {
    const batch = needed.slice(i, i + BATCH_SIZE).map((zh) => ({ zh }));
    try {
      const answers = await requestBatch(batch);
      for (const [zh, en] of answers) {
        filled.set(zh, en);
        cache[zh] = en;
      }
    } catch {
      networkFailed = true;
    }
  }
  writeCache(cache);

  const missing = needed.filter((zh) => !filled.has(zh)).length;
  let message: string | null = null;
  if (missing > 0) {
    const word = missing === 1 ? 'word' : 'words';
    message = networkFailed
      ? `We could not reach the dictionary for ${missing} ${word}. They sit the games out unless you add a meaning.`
      : `We could not find a meaning for ${missing} ${word}. They sit the games out unless you add one.`;
  }

  return { filled, missing, message };
}

