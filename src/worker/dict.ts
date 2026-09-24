// The offline CC-CEDICT lookup: the PRIMARY source of English glosses.
//
// Why this exists: /api/enrich used to depend entirely on Workers AI, and on
// 2026-09-07 the free allocation of 10,000 neurons ran out (Workers AI error
// 4006). Every gloss came back empty and the teacher had a blank review table.
// A 125k-entry dictionary answers the overwhelming majority of classroom
// vocabulary for zero neurons and zero latency variance, so the model is now
// the exception rather than the rule.
//
// The asset is built by `scripts/build-cedict.mjs` into public/cedict.json.
// Vite copies public/ into dist/client, which is `assets.directory` in
// wrangler.jsonc, so the Worker reads it back through `env.ASSETS`.
//
// CC-CEDICT is CC BY-SA 4.0; see README.md.

import type { DictAsset } from '../shared/cedict';

/**
 * What this module needs from the environment. Cloudflare's `Fetcher` (the type
 * of `env.ASSETS`) satisfies it. Declared structurally rather than imported
 * from ./index for the reason spelled out in tts.ts: pulling `Env` in would
 * drag the ambient Workers types into every file that imports this one,
 * including tests/worker.test.ts, which is typechecked without them.
 */
export interface AssetFetcher {
  fetch(input: string | URL): Promise<Response>;
}

export interface DictEnv {
  ASSETS: AssetFetcher;
}

export interface DictHit {
  /** Tone-mark pinyin, e.g. `píng guǒ`. */
  pinyin: string;
  /** A 1-4 word classroom gloss, at most 40 characters. */
  en: string;
}

export interface Dict {
  lookup(zh: string): DictHit | null;
  /** Headword count. Zero means the asset was missing or unreadable. */
  size: number;
}

/** The path the asset is served from. Same name the build script writes. */
export const DICT_PATH = '/cedict.json';

/**
 * Used when no request URL is available. `env.ASSETS` routes on the pathname
 * only, so the origin here is a placeholder and never leaves the isolate.
 */
const INTERNAL_ORIGIN = 'https://assets.invalid';

/** A dictionary that knows nothing. Returned when the asset cannot be read. */
export const EMPTY_DICT: Dict = { lookup: () => null, size: 0 };

/**
 * The lookup key. NFKC so a full-width or compatibility-composed paste finds
 * the same entry, trimmed so a stray space from a spreadsheet does not miss.
 */
export function dictKey(zh: string): string {
  return zh.normalize('NFKC').trim();
}

/** Wraps a parsed asset. Rejects anything that is not the shape we wrote. */
export function makeDict(asset: unknown): Dict {
  if (!asset || typeof asset !== 'object') return EMPTY_DICT;
  const rec = asset as Partial<DictAsset>;
  const table = rec.e;
  if (rec.v !== 1 || !table || typeof table !== 'object') return EMPTY_DICT;

  return {
    size: Object.keys(table).length,
    lookup(zh: string): DictHit | null {
      const key = dictKey(zh);
      if (key === '') return null;
      const hit = (table as Record<string, unknown>)[key];
      if (!Array.isArray(hit) || hit.length < 2) return null;
      const [pinyin, en] = hit;
      if (typeof pinyin !== 'string' || typeof en !== 'string' || en === '') return null;
      return { pinyin, en };
    },
  };
}

/**
 * One in-flight or settled load per isolate. A promise rather than a value so
 * concurrent requests during a cold start share the single fetch and parse
 * instead of each doing their own.
 */
let cached: Promise<Dict> | null = null;

/** Drops the per-isolate cache. Tests only. */
export function resetDictCache(): void {
  cached = null;
}

async function fetchDict(env: DictEnv, baseUrl?: string): Promise<Dict> {
  const url = new URL(DICT_PATH, baseUrl ?? INTERNAL_ORIGIN);
  const started = Date.now();
  const res = await env.ASSETS.fetch(url);
  if (!res.ok) throw new Error(`asset ${DICT_PATH} returned ${res.status}`);
  const text = await res.text();
  const dict = makeDict(JSON.parse(text) as unknown);
  console.log(
    `dict: loaded ${dict.size} headwords in ${Date.now() - started} ms ` +
      `(${(text.length / 1024 / 1024).toFixed(2)}M chars of JSON)`
  );
  return dict;
}

/**
 * The dictionary for this isolate, loaded at most once.
 *
 * Never throws. A missing or corrupt asset degrades to EMPTY_DICT and the
 * caller falls through to Workers AI, which is exactly the old behaviour, and
 * the failure is NOT cached: the next request retries, so one bad fetch does
 * not disable the dictionary for the life of the isolate.
 */
export function loadDict(env: DictEnv, baseUrl?: string): Promise<Dict> {
  if (cached) return cached;
  const attempt = fetchDict(env, baseUrl).catch((err) => {
    console.error('dict: load failed', err instanceof Error ? err.message : err);
    cached = null;
    return EMPTY_DICT;
  });
  cached = attempt;
  return attempt;
}

