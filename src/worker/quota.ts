// The counting and caching logic QuotaDO runs, with no Cloudflare types, so it
// can be unit-tested against a plain in-memory fake of Durable Object storage
// (the same trick persist.ts uses for rooms).
//
// Two jobs:
//   1. per-IP and global daily counters for the two paid AI routes, so nobody
//      can drain the Workers AI allowance with a for-loop;
//   2. a server-side gloss cache, so a word the model has already translated
//      never costs a second model call.
//
// Counters are read-modify-written. That is safe inside a Durable Object: the
// input gate defers other events while a storage operation is in flight, and
// nothing here awaits anything but storage.

// --- storage ------------------------------------------------------------------

/** The slice of DurableObjectStorage this module needs. */
export interface QuotaStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
}

export type QuotaBucket = 'enrich' | 'tts' | 'ocr';

const COUNTER_PREFIX = 'c:';
const GLOSS_PREFIX = 'g:';
/**
 * Insertion-order index over the gloss cache: `gi:<seq>` -> the gloss key. Seq
 * is zero-padded so a plain ascending key listing IS oldest-first, which is how
 * eviction finds what to drop without reading the cache.
 */
const GLOSS_INDEX_PREFIX = 'gi:';
const SEQ_DIGITS = 12;
/** Holds the UTC day the counters belong to, so a new day wipes them. */
const KEY_DAY = 'day';
/** Number of cached glosses. Never an undercount; see putGlosses. */
const KEY_GLOSS_COUNT = 'glossCount';
/** Next insertion sequence number. Monotonic, never reused. */
const KEY_GLOSS_SEQ = 'glossSeq';
/**
 * Fallback cap, used only when a caller passes none. The live number comes from
 * `policy.maxGlossEntries` (var MAX_GLOSS_ENTRIES) and travels with the
 * gloss/put request, so the ceiling is configurable without touching code.
 */
export const MAX_GLOSS_ENTRIES = 50_000;

// --- keys ---------------------------------------------------------------------

/** The UTC calendar day, as YYYY-MM-DD. Counters reset at UTC midnight. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The key a word is cached and rate-limited under. Unicode-normalized, runs of
 * whitespace collapsed, trimmed, so "苹果", " 苹果 " and a decomposed copy of
 * the same characters all share one entry.
 */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function ipKey(bucket: QuotaBucket, day: string, ip: string): string {
  return `${COUNTER_PREFIX}${bucket}:${day}:ip:${normalizeText(ip).slice(0, 64)}`;
}

function globalKey(bucket: QuotaBucket, day: string): string {
  return `${COUNTER_PREFIX}${bucket}:${day}:global`;
}

// --- counters -----------------------------------------------------------------

export interface ConsumeRequest {
  bucket: QuotaBucket;
  ip: string;
  /** How many paid calls this request is about to make. */
  count: number;
  perIpPerDay: number;
  globalPerDay: number;
  now: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Which limit stopped it, present only when `allowed` is false. */
  scope?: 'ip' | 'global';
  /** Calls left for this IP today, after this request. */
  ipRemaining: number;
  globalRemaining: number;
  /**
   * The UTC day this charge landed on. The caller hands it back with the
   * refund so a reservation taken at 23:59 can never give calls back out of
   * the next day's budget.
   */
  day: string;
}

/** Gives back reserved calls the route did not end up making. */
export interface RefundRequest {
  bucket: QuotaBucket;
  ip: string;
  /** How many reserved calls went unused. */
  count: number;
  /** The `day` from the ConsumeResult that reserved them. */
  day: string;
  now: number;
}

export interface RefundResult {
  /** How many were actually given back. Zero is normal and not an error. */
  refunded: number;
}

/** How many paid calls one request may ever reserve. A sanity ceiling. */
export const MAX_CONSUME_COUNT = 100;

/** Drops yesterday's counters the first time we count on a new UTC day. */
async function rollDay(storage: QuotaStorage, day: string): Promise<void> {
  const marker = await storage.get<string>(KEY_DAY);
  if (marker === day) return;
  const stale = await storage.list<number>({ prefix: COUNTER_PREFIX });
  for (const key of stale.keys()) await storage.delete(key);
  await storage.put(KEY_DAY, day);
}

/**
 * Charges `count` calls against both the per-IP and the global daily budget.
 * Nothing is charged when either budget would be exceeded, so a refused request
 * does not eat into tomorrow's allowance.
 */
export async function consume(storage: QuotaStorage, req: ConsumeRequest): Promise<ConsumeResult> {
  const day = utcDayKey(req.now);
  await rollDay(storage, day);

  const kIp = ipKey(req.bucket, day, req.ip);
  const kGlobal = globalKey(req.bucket, day);
  const usedIp = (await storage.get<number>(kIp)) ?? 0;
  const usedGlobal = (await storage.get<number>(kGlobal)) ?? 0;

  if (usedIp + req.count > req.perIpPerDay) {
    return {
      allowed: false,
      scope: 'ip',
      ipRemaining: Math.max(0, req.perIpPerDay - usedIp),
      globalRemaining: Math.max(0, req.globalPerDay - usedGlobal),
      day,
    };
  }
  if (usedGlobal + req.count > req.globalPerDay) {
    return {
      allowed: false,
      scope: 'global',
      ipRemaining: Math.max(0, req.perIpPerDay - usedIp),
      globalRemaining: Math.max(0, req.globalPerDay - usedGlobal),
      day,
    };
  }

  await storage.put(kIp, usedIp + req.count);
  await storage.put(kGlobal, usedGlobal + req.count);
  return {
    allowed: true,
    ipRemaining: req.perIpPerDay - usedIp - req.count,
    globalRemaining: req.globalPerDay - usedGlobal - req.count,
    day,
  };
}

/**
 * Gives back calls that were reserved but never made.
 *
 * Deliberately conservative:
 *   - it refuses to cross a UTC midnight (a refund for yesterday is dropped,
 *     because yesterday's counters are gone and touching today's would hand
 *     out free budget);
 *   - it never drives a counter below zero;
 *   - it refunds the same amount to the per-IP and the global counter, since
 *     `consume` always charges them together.
 *
 * A dropped refund only ever costs the user calls they did not make. It can
 * never create budget, which is the direction that matters.
 */
export async function refund(storage: QuotaStorage, req: RefundRequest): Promise<RefundResult> {
  if (req.count <= 0) return { refunded: 0 };

  const today = utcDayKey(req.now);
  if (req.day !== today) return { refunded: 0 };

  // Never rollDay() here. A refund must not be the thing that creates a new
  // day's counters; only a charge may do that.
  const marker = await storage.get<string>(KEY_DAY);
  if (marker !== today) return { refunded: 0 };

  const kIp = ipKey(req.bucket, today, req.ip);
  const kGlobal = globalKey(req.bucket, today);
  const usedIp = (await storage.get<number>(kIp)) ?? 0;
  const usedGlobal = (await storage.get<number>(kGlobal)) ?? 0;

  const give = Math.min(req.count, usedIp, usedGlobal);
  if (give <= 0) return { refunded: 0 };

  await storage.put(kIp, usedIp - give);
  await storage.put(kGlobal, usedGlobal - give);
  return { refunded: give };
}

// --- request validation -------------------------------------------------------
//
// QuotaDO is only reachable from this worker, but "only my own code calls it"
// is exactly the assumption that rots. A caller that passes a negative count, a
// missing limit, or an unknown bucket must be refused before any counter moves,
// not trusted into corrupting the day's accounting.

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isBucket(value: unknown): value is QuotaBucket {
  return value === 'enrich' || value === 'tts' || value === 'ocr';
}

/** IPs arrive from a header, so anything unusable becomes one shared bucket. */
function readIp(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim();
  return trimmed === '' ? 'unknown' : trimmed;
}

function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function parseConsumeRequest(body: unknown, now: number): Validated<ConsumeRequest> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const rec = body as Record<string, unknown>;

  if (!isBucket(rec.bucket)) return { ok: false, error: 'bucket must be "enrich", "tts" or "ocr"' };
  if (!isPositiveInt(rec.count)) return { ok: false, error: 'count must be a positive integer' };
  if (rec.count > MAX_CONSUME_COUNT) {
    return { ok: false, error: `count must be at most ${MAX_CONSUME_COUNT}` };
  }
  if (!isPositiveInt(rec.perIpPerDay)) {
    return { ok: false, error: 'perIpPerDay must be a positive integer' };
  }
  if (!isPositiveInt(rec.globalPerDay)) {
    return { ok: false, error: 'globalPerDay must be a positive integer' };
  }

  return {
    ok: true,
    value: {
      bucket: rec.bucket,
      ip: readIp(rec.ip),
      count: rec.count,
      perIpPerDay: rec.perIpPerDay,
      globalPerDay: rec.globalPerDay,
      now,
    },
  };
}

export function parseRefundRequest(body: unknown, now: number): Validated<RefundRequest> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const rec = body as Record<string, unknown>;

  if (!isBucket(rec.bucket)) return { ok: false, error: 'bucket must be "enrich", "tts" or "ocr"' };
  if (!isPositiveInt(rec.count)) return { ok: false, error: 'count must be a positive integer' };
  if (rec.count > MAX_CONSUME_COUNT) {
    return { ok: false, error: `count must be at most ${MAX_CONSUME_COUNT}` };
  }
  if (!isDayKey(rec.day)) return { ok: false, error: 'day must be a YYYY-MM-DD string' };

  return {
    ok: true,
    value: {
      bucket: rec.bucket,
      ip: readIp(rec.ip),
      count: rec.count,
      day: rec.day,
      now,
    },
  };
}

/** Validates a usage lookup. Reads nothing but still refuses an unknown bucket. */
export function parseUsageRequest(body: unknown): Validated<{ bucket: QuotaBucket; ip: string }> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const rec = body as Record<string, unknown>;
  if (!isBucket(rec.bucket)) return { ok: false, error: 'bucket must be "enrich", "tts" or "ocr"' };
  return { ok: true, value: { bucket: rec.bucket, ip: readIp(rec.ip) } };
}

/** Reads a counter without charging it. Used by tests and by /api/quota. */
export async function usage(
  storage: QuotaStorage,
  bucket: QuotaBucket,
  ip: string,
  now: number
): Promise<{ ip: number; global: number }> {
  const day = utcDayKey(now);
  return {
    ip: (await storage.get<number>(ipKey(bucket, day, ip))) ?? 0,
    global: (await storage.get<number>(globalKey(bucket, day))) ?? 0,
  };
}

// --- gloss cache --------------------------------------------------------------
//
// A cache with no eviction is not a cache, it is a leak. The size ceiling here
// binds because every entry also gets an index row `gi:<seq>` written in
// insertion order. Evicting means listing the FEW oldest index rows (a bounded
// `list({ limit })`), not scanning the whole cache: the previous version deleted
// only EXPIRED entries, so a full cache of 30-day glosses freed nothing and paid
// for a 50,000-key scan on every single write, forever.
//
// Cost per write is therefore O(new words), not O(cache size).

interface GlossRecord {
  en: string;
  /** Absolute expiry timestamp in ms. */
  exp: number;
  /**
   * The insertion sequence this entry's index row was written under. Eviction
   * compares it so an index row left behind by an older, already-replaced copy
   * of the same word cannot delete the live one.
   */
  seq?: number;
}

export interface GlossEntry {
  zh: string;
  en: string;
}

function indexKey(seq: number): string {
  return GLOSS_INDEX_PREFIX + String(seq).padStart(SEQ_DIGITS, '0');
}

/**
 * Looks up cached glosses. Expired entries are retired as they are found.
 *
 * "Retired" means the whole entry goes: the gloss row, its `gi:` index row, and
 * one off `glossCount`. Leaving the index row behind (what this used to do) was
 * not free. Eviction spends a fixed budget of index rows and takes one off the
 * count for each, live or not, so every corpse left in the index made a later
 * eviction delete one extra LIVE gloss to reach its target. Keeping the three
 * in step here is what makes the eviction arithmetic exact.
 */
export async function getGlosses(
  storage: QuotaStorage,
  words: string[],
  now: number
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  let retired = 0;
  for (const word of words) {
    const key = GLOSS_PREFIX + normalizeText(word);
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = await storage.get<GlossRecord>(key);
    if (!rec || typeof rec.en !== 'string' || typeof rec.exp !== 'number') continue;
    if (rec.exp <= now) {
      await storage.delete(key);
      // Only an indexed entry was ever counted, so only an indexed entry gives
      // a row and a count back. A stray from a pre-index store is neither.
      if (typeof rec.seq === 'number') {
        await storage.delete(indexKey(rec.seq));
        retired++;
      }
      continue;
    }
    if (rec.en !== '') out[word] = rec.en;
  }
  if (retired > 0) {
    const count = await storage.get<number>(KEY_GLOSS_COUNT);
    // No count means nothing has been written under the index yet; inventing
    // one here would be a guess, and the migration is about to compute it.
    if (typeof count === 'number') {
      await storage.put(KEY_GLOSS_COUNT, Math.max(0, count - retired));
    }
  }
  return out;
}

/**
 * Rebuilds the insertion index for a store written before the index existed.
 *
 * Such a store has `g:` rows carrying no `seq` and no `gi:` rows at all, so
 * eviction could never reach those entries: they sat in the cache forever and
 * the cap was not a real ceiling, only a ceiling on the entries written after
 * the upgrade. This lists the legacy rows ONCE, drops the expired and the
 * malformed, then hands every survivor a sequence number and an index row in
 * ascending key order, and writes an exact count and seq.
 *
 * Ascending key order is deterministic on purpose: if this is interrupted and
 * runs again it rebuilds the same index rather than a different one.
 *
 * Runs at most once per store. It is called only when `glossSeq` is absent and
 * it always writes `glossSeq`.
 *
 * Deliberately one-shot rather than incremental. A review flagged the
 * unbounded lists as a request-path timeout risk on a large legacy store, but
 * no such store exists: the pre-index format was in production for under one
 * day (2026-09-07) and holds at most a few dozen entries, so the work here is
 * bounded by construction, not by a cursor. An incremental migration with a
 * resume marker would only be needed if a large legacy store ever appeared,
 * which for this cache it cannot.
 */
async function migrateLegacyIndex(
  storage: QuotaStorage,
  now: number
): Promise<number> {
  // `gi:` rows with no `glossSeq` are debris from an interrupted migration.
  // Every sequence number is about to be reassigned, so they go first: keeping
  // them would leave rows pointing at entries under a different seq, which is
  // exactly the mismatch eviction uses to decide an entry is superseded.
  const strays = await storage.list<string>({ prefix: GLOSS_INDEX_PREFIX });
  for (const rowKey of strays.keys()) await storage.delete(rowKey);

  // `g:` does not prefix-match `gi:` ('i' !== ':'), so this lists gloss rows
  // only. One unbounded list, once in the life of the store.
  const legacy = await storage.list<GlossRecord>({ prefix: GLOSS_PREFIX });
  let seq = 0;
  for (const [key, rec] of legacy) {
    const usable =
      !!rec &&
      typeof rec.en === 'string' &&
      typeof rec.exp === 'number' &&
      rec.en.trim() !== '' &&
      rec.exp > now;
    if (!usable) {
      await storage.delete(key);
      continue;
    }
    const mine = seq++;
    await storage.put<GlossRecord>(key, { en: rec.en, exp: rec.exp, seq: mine });
    await storage.put(indexKey(mine), key);
  }

  await storage.put(KEY_GLOSS_COUNT, seq);
  await storage.put(KEY_GLOSS_SEQ, seq);
  return seq;
}

/**
 * Stores glosses for `ttlMs`, then evicts oldest-first until the cache is back
 * inside `maxEntries`. Blank glosses are not cached (they are failures).
 *
 * `glossCount` may still run high (an entry that expires and is never read
 * again keeps its row until eviction walks past it) and never low. Erring high
 * is the safe direction: it can only make eviction fire early, never let the
 * cache outgrow its cap. Eviction corrects that drift as it walks the index.
 */
export async function putGlosses(
  storage: QuotaStorage,
  entries: GlossEntry[],
  now: number,
  ttlMs: number,
  maxEntries: number = MAX_GLOSS_ENTRIES
): Promise<void> {
  const cap = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_GLOSS_ENTRIES;

  const storedSeq = await storage.get<number>(KEY_GLOSS_SEQ);
  const storedCount = await storage.get<number>(KEY_GLOSS_COUNT);

  let seq: number;
  let stored: number;
  if (storedSeq === undefined && storedCount !== undefined) {
    // A count with no sequence number is the signature of a store written
    // before the index existed: every version of this file that has ever
    // written a `g:` row also wrote `glossCount`, so a store holding legacy
    // entries always has one. Upgrade it in place, then hold it to the cap
    // like any other store. A brand-new store has neither key and skips this,
    // which is why a fresh cache still costs no listing at all to fill.
    stored = await migrateLegacyIndex(storage, now);
    seq = stored;
    if (stored > cap) {
      stored = await evictOldest(storage, stored, cap);
      await storage.put(KEY_GLOSS_COUNT, stored);
    }
  } else {
    seq = storedSeq ?? 0;
    stored = storedSeq === undefined ? 0 : (storedCount ?? 0);
  }
  let added = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.zh !== 'string' || typeof entry.en !== 'string') continue;
    const key = GLOSS_PREFIX + normalizeText(entry.zh);
    if (key === GLOSS_PREFIX || entry.en.trim() === '') continue;

    const existing = await storage.get<GlossRecord>(key);
    if (existing && typeof existing.seq === 'number') {
      // A refresh keeps its place in the queue: the entry is already indexed,
      // so re-indexing it would leave a duplicate row behind.
      await storage.put<GlossRecord>(key, {
        en: entry.en.trim(),
        exp: now + ttlMs,
        seq: existing.seq,
      });
      continue;
    }

    const mine = seq++;
    await storage.put<GlossRecord>(key, {
      en: entry.en.trim(),
      exp: now + ttlMs,
      seq: mine,
    });
    await storage.put(indexKey(mine), key);
    added++;
  }

  if (added === 0) return;
  await storage.put(KEY_GLOSS_SEQ, seq);

  const count = stored + added;
  if (count <= cap) {
    await storage.put(KEY_GLOSS_COUNT, count);
    return;
  }
  await storage.put(KEY_GLOSS_COUNT, await evictOldest(storage, count, cap));
}

/**
 * Drops the oldest entries until `count` is back inside `cap`, and returns the
 * new count.
 *
 * Every index row walked costs exactly one from the count, whether or not it
 * still points at a live gloss, so the walk is bounded by how far over the cap
 * we are (in practice the number of words this one request added) rather than
 * by how much rubbish the index has collected.
 */
export async function evictOldest(
  storage: QuotaStorage,
  count: number,
  cap: number
): Promise<number> {
  let left = count;
  while (left > cap) {
    const batch = await storage.list<string>({
      prefix: GLOSS_INDEX_PREFIX,
      limit: Math.min(left - cap, 128),
    });
    // No index rows left. Every row deleted took exactly one off the count, so
    // reaching here means the count was ahead of the index; zero is the honest
    // answer and it lets the accounting re-converge instead of pinning at cap.
    if (batch.size === 0) return 0;

    for (const [rowKey, glossKey] of batch) {
      await storage.delete(rowKey);
      left--;
      if (typeof glossKey !== 'string') continue;
      const rec = await storage.get<GlossRecord>(glossKey);
      // Missing means it already expired away; a different seq means this row
      // belongs to a superseded copy and the live entry has its own row.
      const seq = Number(rowKey.slice(GLOSS_INDEX_PREFIX.length));
      if (rec && rec.seq === seq) await storage.delete(glossKey);
      if (left <= cap) break;
    }
  }
  return Math.max(0, left);
}

