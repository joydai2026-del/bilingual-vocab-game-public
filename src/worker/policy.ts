// Every cost and size limit the worker enforces, in one place.
//
// Rule: handlers never hardcode a limit. They read this object. Each field can
// be overridden by a `vars` entry in wrangler.jsonc (or `--var NAME=value` on a
// wrangler command line) so a limit can be changed without touching code.
//
// A var that is missing, not a number, or not a positive integer falls back to
// the default below and logs once. That is deliberate: a typo in config must
// not silently disable a spending cap.

export interface Policy {
  /** /api/enrich model calls one IP may make per UTC day. */
  enrichPerIpPerDay: number;
  /** /api/enrich model calls everyone together may make per UTC day. */
  enrichGlobalPerDay: number;
  /** /api/tts model calls one IP may make per UTC day (cache hits are free). */
  ttsPerIpPerDay: number;
  /** /api/tts model calls everyone together may make per UTC day. */
  ttsGlobalPerDay: number;
  /**
   * Worst-case paid model calls one /api/enrich request may make: the primary
   * model is tried `enrichMaxAttempts - 1` times, then the fallback once. This
   * many calls are RESERVED against the budgets before the route runs, and the
   * unused ones are refunded afterwards, so a normal single-attempt call still
   * costs 1.
   *
   * QuotaDO refuses a reservation above MAX_CONSUME_COUNT (100) outright, so a
   * silly value here fails closed with a 503 rather than spending unmetered.
   */
  enrichMaxAttempts: number;
  /**
   * Worst-case paid model calls one /api/tts synthesis may make. Reserved and
   * refunded the same way as `enrichMaxAttempts`.
   */
  ttsMaxAttempts: number;
  /** /api/ocr photo reads one IP may make per UTC day. */
  ocrPerIpPerDay: number;
  /** /api/ocr photo reads everyone together may make per UTC day. */
  ocrGlobalPerDay: number;
  /** Hard ceiling on one uploaded photo. */
  ocrMaxBytes: number;
  /** How long the Vision call may take before /api/ocr gives up. */
  ocrTimeoutMs: number;
  /** Hard ceiling on the CSV /api/sheet will read back from Google. */
  sheetMaxBytes: number;
  /** How long Google Sheets has to answer before /api/sheet gives up. */
  sheetTimeoutMs: number;
  /** Words accepted in one /api/enrich request. */
  maxEnrichItems: number;
  /** Hard cap on any JSON request body, and on a serialized room payload. */
  maxBodyBytes: number;
  /** How long a server-side gloss stays cached. */
  glossCacheDays: number;
  /**
   * How many words the server-side gloss cache may hold. Once it is full the
   * oldest entries are evicted, so this is a real ceiling on storage, not a
   * hint.
   */
  maxGlossEntries: number;
  /**
   * How many students may join one TEACHER room. A legacy "Race a friend" room
   * is head to head and keeps its own cap of 8, which is not configurable.
   *
   * Read at create and written into the room, so a room keeps the class size it
   * was made with even if this changes mid-lesson. src/shared/room.ts caps it at
   * MAX_PLAYERS_CEILING whatever is configured here.
   */
  roomMaxPlayersTeacher: number;
}

export const DEFAULT_POLICY: Policy = {
  enrichPerIpPerDay: 30,
  enrichGlobalPerDay: 600,
  ttsPerIpPerDay: 300,
  ttsGlobalPerDay: 4000,
  enrichMaxAttempts: 3,
  ttsMaxAttempts: 3,
  ocrPerIpPerDay: 20,
  ocrGlobalPerDay: 300,
  ocrMaxBytes: 4 * 1024 * 1024,
  ocrTimeoutMs: 20_000,
  sheetMaxBytes: 512 * 1024,
  sheetTimeoutMs: 20_000,
  maxEnrichItems: 40,
  maxBodyBytes: 256 * 1024,
  glossCacheDays: 30,
  maxGlossEntries: 50_000,
  roomMaxPlayersTeacher: 40,
};

/** The `vars` name that overrides each policy field. */
export const POLICY_VARS = {
  enrichPerIpPerDay: 'ENRICH_PER_IP_PER_DAY',
  enrichGlobalPerDay: 'ENRICH_GLOBAL_PER_DAY',
  ttsPerIpPerDay: 'TTS_PER_IP_PER_DAY',
  ttsGlobalPerDay: 'TTS_GLOBAL_PER_DAY',
  enrichMaxAttempts: 'ENRICH_MAX_ATTEMPTS',
  ttsMaxAttempts: 'TTS_MAX_ATTEMPTS',
  ocrPerIpPerDay: 'OCR_PER_IP_PER_DAY',
  ocrGlobalPerDay: 'OCR_GLOBAL_PER_DAY',
  ocrMaxBytes: 'OCR_MAX_BYTES',
  ocrTimeoutMs: 'OCR_TIMEOUT_MS',
  sheetMaxBytes: 'SHEET_MAX_BYTES',
  sheetTimeoutMs: 'SHEET_TIMEOUT_MS',
  maxEnrichItems: 'MAX_ENRICH_ITEMS',
  maxBodyBytes: 'MAX_BODY_BYTES',
  glossCacheDays: 'GLOSS_CACHE_DAYS',
  maxGlossEntries: 'MAX_GLOSS_ENTRIES',
  roomMaxPlayersTeacher: 'ROOM_MAX_PLAYERS_TEACHER',
} as const satisfies { [K in keyof Policy]: string };

/** The shape `Env` must carry for the overrides to be readable. */
export type PolicyVars = {
  [K in (typeof POLICY_VARS)[keyof Policy]]?: string | number;
};

/**
 * Reads one override. `vars` values arrive as numbers from wrangler.jsonc and
 * as strings from `--var`, so both are accepted. Anything else keeps the
 * default.
 */
function readOne(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(`policy: var ${name}=${String(raw)} is not a positive integer, using ${fallback}`);
    return fallback;
  }
  return n;
}

/** Builds the live policy for this request from the environment. */
export function readPolicy(env: PolicyVars | undefined): Policy {
  const source = (env ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_POLICY };
  for (const key of Object.keys(DEFAULT_POLICY) as Array<keyof Policy>) {
    const name = POLICY_VARS[key];
    out[key] = readOne(source[name], name, DEFAULT_POLICY[key]);
  }
  return out;
}

