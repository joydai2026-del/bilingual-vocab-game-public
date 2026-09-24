// Worker entry point: the /api/* router. Everything that is not /api/* is served
// from the static assets binding (Vite build output, SPA fallback configured in
// wrangler.jsonc).
//
// Routes:
//   POST /api/enrich                  fill English glosses via Workers AI
//   GET  /api/tts?text=<zh>           Chinese speech fallback via Workers AI
//   GET  /api/sheet?url=<sheets url>  read a shared Google Sheet as CSV text
//   POST /api/extract                 { text } -> the words in it, read with the
//                                     shipped dictionary. No model, no quota.
//   POST /api/ocr                     read a photo of a word list (Workers AI, or Azure Vision),
//                                     and run the same extractor over what it read
//   POST /api/rooms                   { set, teacher: true }       -> { code, hostKey }
//                                     { set, questions, perQuestionMs } (legacy) -> { code }
//   POST /api/rooms/:code/join        { name }                     -> { playerId, state, ... }
//   POST /api/rooms/:code/round       { hostKey|playerId, kind,
//                                       questionsPerRound? }        -> { state, ... }
//   POST /api/rooms/:code/end         { hostKey|playerId }          -> { state, ... }  (end this round now)
//   POST /api/rooms/:code/start       { playerId }  (legacy alias for kind: race)
//   POST /api/rooms/:code/answer      { playerId, index, choice }  -> { state, accepted, correct, ... }
//   POST /api/rooms/:code/pick        { playerId, index, chest }   -> { state, accepted, outcome?, ... }
//   POST /api/rooms/:code/lobby       { hostKey|playerId }         -> { state, ... }  (pick another game)
//   POST /api/rooms/:code/close       { hostKey|playerId }         -> { state, ... }  (finish)
//   POST /api/rooms/:code/reveal      { hostKey|playerId, index }  -> { index, answer }  (projector only)
//   GET  /api/rooms/:code?v=N         -> { state, version, nextPollMs, serverNow }
//        optional headers x-host-key, or x-player-id + x-member-key: who is
//        asking. Only a Sky Tower round answers differently for different
//        askers (a child sees her own block count and nobody else's).
//                                        or { unchanged: true, version, nextPollMs, serverNow }
//
// Every JSON response is Cache-Control: no-store. Only /api/tts is cacheable.
// Validation lives in ./pure.ts so it can be unit-tested.
//
// Cost protection (the two AI routes cost real money and are public):
//   - every JSON body is size-capped BEFORE it is parsed;
//   - /api/tts answers from caches.default first, so a repeated word is free;
//   - /api/enrich answers from the server-side gloss cache first, likewise;
//   - what is left RESERVES its worst-case number of model calls against the
//     per-IP and global daily budgets in QuotaDO, and refunds the attempts it
//     did not use, so the cap counts paid AI calls and not requests;
//   - over budget returns 429 with a plain-language message.
// Every limit comes from ./policy.ts, which reads `vars`; none is hardcoded here.

import type { VocabSet } from '../shared/types';
import { buildQuestions, perQuestionMsFor } from '../shared/quiz';
import { MAX_QUESTIONS_PER_ROUND, MIN_QUESTIONS_PER_ROUND } from '../shared/round';
import { loadDict } from './dict';
import { enrichItems, type EnrichInputItem } from './enrich';
import {
  cachedRescue,
  extractWithDict,
  mergeRescue,
  needsRescue,
  rescueWithModel,
  toResponse,
  validateExtractBody,
} from './extract';
import { synthesizeLadder, ttsAttemptBudget, ttsCacheKey, ttsCacheVariant } from './tts';
import { readPolicy, type Policy, type PolicyVars } from './policy';
import { fetchSheetCsv, parseSheetUrl } from './sheet';
import {
  OCR_EMPTY,
  OCR_NOT_SET_UP,
  OCR_TOO_BIG,
  OCR_WRONG_TYPE,
  isAllowedImageType,
  plannedOcrProviders,
  readImageBounded,
  runOcrLadder,
  type OcrEnv,
} from './ocr';
import { QUOTA_OBJECT_NAME } from './quota-do';
import { type ConsumeResult, type QuotaBucket } from './quota';
import {
  MAX_HOST_KEY_CHARS,
  MAX_MEMBER_KEY_CHARS,
  MAX_NAME_CHARS,
  MAX_PLAYER_ID_CHARS,
  MAX_QUESTIONS,
  TTS_MAX_CHARS,
  generateCode,
  isChineseText,
  isValidCode,
  roomActionAuthFor,
  validateEnrichItems,
  validateQuestions,
  validateSet,
} from './pure';

export { RoomDO } from './room-do';
export { QuotaDO } from './quota-do';

export interface Env extends PolicyVars, OcrEnv {
  ASSETS: Fetcher;
  AI: Ai;
  ROOMS: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
  /**
   * Azure Speech, the top rung of the /api/tts ladder (see ./tts.ts). Both are
   * optional: with neither set the ladder starts at MeloTTS and the app behaves
   * exactly as it did before Azure existed.
   *
   * KEY is a secret (`wrangler secret put AZURE_SPEECH_KEY`). It is read here,
   * never logged and never returned in a response. REGION, VOICE and RATE are
   * plain `vars` in wrangler.jsonc.
   */
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
  AZURE_TTS_VOICE?: string;
  AZURE_TTS_RATE?: string;
  /** Which providers /api/tts tries and in what order, e.g. "azure,melotts". */
  TTS_PROVIDER_ORDER?: string;
}

/** How many room codes to try before giving up (collisions are vanishingly rare). */
const CODE_ATTEMPTS = 8;

// --- helpers -----------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function tooLarge(): Response {
  return json({ error: 'That word list is too big to send. Try it in smaller batches.' }, 413);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/**
 * Reads a JSON body with a hard byte ceiling.
 *
 * The size is checked twice on purpose. Content-Length catches the honest case
 * before a single byte is buffered; the streaming counter catches a chunked
 * body that lies about (or omits) its length. Without this the worker parses
 * whatever arrives before any validation runs, which is how a 400 MB body gets
 * as far as the isolate's memory limit.
 */
async function readJsonBounded(request: Request, maxBytes: number): Promise<BodyResult> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return { ok: false, response: tooLarge() };
  }

  const body = request.body;
  let text = '';
  if (body) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return { ok: false, response: tooLarge() };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, response: badRequest('body must be JSON') };
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(merged);
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: badRequest('body must be JSON') };
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// --- quota -------------------------------------------------------------------

function quotaStub(env: Env): DurableObjectStub {
  return env.QUOTA.get(env.QUOTA.idFromName(QUOTA_OBJECT_NAME));
}

async function callQuota(env: Env, path: string, body: unknown): Promise<unknown> {
  const res = await quotaStub(env).fetch(
    new Request(`https://quota/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  if (!res.ok) throw new Error(`quota ${path} returned ${res.status}`);
  return await res.json();
}

/** What the teacher reads when a daily budget runs out. No jargon, no numbers. */
const OVER_LIMIT: Record<QuotaBucket, Record<'ip' | 'global', string>> = {
  enrich: {
    ip: "You have used up today's English-helper turns on this device. Type the English in yourself, or try again tomorrow.",
    global:
      "The English helper has hit today's limit for everyone. Type the English in yourself, or try again tomorrow.",
  },
  tts: {
    ip: "You have used up today's spoken-audio turns on this device. Your device's own voice still works, and audio comes back tomorrow.",
    global:
      "The spoken-audio helper has hit today's limit for everyone. Your device's own voice still works, and audio comes back tomorrow.",
  },
  ocr: {
    ip: "You have used up today's photo reads on this device. Type or paste the words in, or try again tomorrow.",
    global:
      "Photo reading has hit today's limit for everyone. Type or paste the words in, or try again tomorrow.",
  },
};

const QUOTA_UNAVAILABLE =
  'The helper is taking a short break. Try again in a minute, or type the English in yourself.';

/** A held reservation, kept only long enough to give the unused part back. */
interface Reservation {
  bucket: QuotaBucket;
  ip: string;
  /** Paid calls held. */
  count: number;
  /** The UTC day they were charged on, so a refund cannot cross midnight. */
  day: string;
}

type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; response: Response };

/**
 * Holds `count` paid calls against the daily budgets before an AI route runs.
 *
 * `count` is the WORST CASE for that route (every retry and fallback), because
 * a cap that counts requests is not a cap on spend: one accepted /api/enrich
 * request can make three model calls. Reserving the worst case and refunding
 * the difference means a normal first-try call still costs exactly 1, while a
 * user who triggers every retry is charged for every retry.
 *
 * Fails CLOSED. If QuotaDO cannot be reached there is no way to know what has
 * already been spent, and an unmetered AI route is exactly the thing this code
 * exists to prevent, so the request is refused rather than waved through.
 */
async function reserveQuota(
  request: Request,
  env: Env,
  policy: Policy,
  bucket: QuotaBucket,
  count: number
): Promise<ReserveResult> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const limits =
    bucket === 'enrich'
      ? { perIpPerDay: policy.enrichPerIpPerDay, globalPerDay: policy.enrichGlobalPerDay }
      : bucket === 'ocr'
        ? { perIpPerDay: policy.ocrPerIpPerDay, globalPerDay: policy.ocrGlobalPerDay }
        : { perIpPerDay: policy.ttsPerIpPerDay, globalPerDay: policy.ttsGlobalPerDay };

  let result: ConsumeResult;
  try {
    result = (await callQuota(env, 'consume', { bucket, ip, count, ...limits })) as ConsumeResult;
  } catch (err) {
    console.error('quota: consume failed', err instanceof Error ? err.message : err);
    return { ok: false, response: json({ error: QUOTA_UNAVAILABLE }, 503) };
  }
  if (!result.allowed) {
    return {
      ok: false,
      response: json({ error: OVER_LIMIT[bucket][result.scope ?? 'global'] }, 429),
    };
  }
  return { ok: true, reservation: { bucket, ip, count, day: result.day } };
}

/**
 * Gives back the attempts a route reserved but never made.
 *
 * Best effort on purpose. A refund that fails only costs that user calls they
 * did not make; it can never hand out budget, and it must never turn a
 * successful answer into an error for the teacher.
 */
async function releaseQuota(env: Env, reservation: Reservation, used: number): Promise<void> {
  const unused = reservation.count - Math.max(0, used);
  if (unused <= 0) return;
  try {
    await callQuota(env, 'refund', {
      bucket: reservation.bucket,
      ip: reservation.ip,
      count: unused,
      day: reservation.day,
    });
  } catch (err) {
    console.error('quota: refund failed', err instanceof Error ? err.message : err);
  }
}

// --- handlers ----------------------------------------------------------------

async function handleEnrich(request: Request, env: Env, policy: Policy): Promise<Response> {
  const parsed = await readJsonBounded(request, policy.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (!body || typeof body !== 'object') return badRequest('body must be JSON');

  const items = (body as { items?: unknown }).items;
  const error = validateEnrichItems(items, policy.maxEnrichItems);
  if (error) return badRequest(error);

  // `en` is non-optional here so the cache-fill below is total.
  const clean: Array<Required<EnrichInputItem>> = (
    items as Array<Record<string, unknown>>
  ).map((it) => ({
    zh: (it.zh as string).trim(),
    en: typeof it.en === 'string' ? it.en : '',
  }));

  // 1. Words the model has already glossed cost nothing.
  const wanted = clean.filter((it) => it.en.trim() === '').map((it) => it.zh);
  let cached: Record<string, string> = {};
  if (wanted.length > 0) {
    try {
      cached = ((await callQuota(env, 'gloss/get', { words: wanted })) as {
        glosses: Record<string, string>;
      }).glosses;
    } catch (err) {
      console.error('quota: gloss/get failed', err instanceof Error ? err.message : err);
    }
  }
  for (const item of clean) {
    if (item.en.trim() === '' && cached[item.zh]) item.en = cached[item.zh];
  }

  // 2. The dictionary fills most words for free, before any quota is touched.
  //    Dictionary glosses are not written to the gloss cache (they are always
  //    available), so they cannot evict a paid AI gloss.
  const dictFilled = new Set<string>();
  try {
    const dict = await loadDict(env, request.url);
    for (const item of clean) {
      if (item.en.trim() !== '') continue;
      const hit = dict.lookup(item.zh);
      if (hit && hit.en) {
        item.en = hit.en;
        dictFilled.add(item.zh);
      }
    }
  } catch (err) {
    console.error('dict: lookup failed', err instanceof Error ? err.message : err);
  }

  // 3. Nothing left for the model means no charge and no call at all.
  const stillEmpty = clean.filter((it) => it.en.trim() === '');
  if (stillEmpty.length === 0) {
    return json({ items: clean.map((it) => ({ zh: it.zh, en: it.en })) });
  }

  // 3. Reserve the worst case (primary, its retries, then the fallback), run,
  //    then give back whatever was not spent.
  const reserved = await reserveQuota(request, env, policy, 'enrich', policy.enrichMaxAttempts);
  if (!reserved.ok) return reserved.response;

  const result = await enrichItems(env, clean, policy.enrichMaxAttempts);
  await releaseQuota(env, reserved.reservation, result.attempts);

  const fresh = result.items.filter(
    (item) =>
      item.en !== '' &&
      !cached[item.zh] &&
      !dictFilled.has(item.zh) &&
      stillEmpty.some((s) => s.zh === item.zh)
  );
  if (fresh.length > 0) {
    try {
      await callQuota(env, 'gloss/put', {
        entries: fresh.map((item) => ({ zh: item.zh, en: item.en })),
        ttlMs: policy.glossCacheDays * 24 * 60 * 60 * 1000,
        maxEntries: policy.maxGlossEntries,
      });
    } catch (err) {
      console.error('quota: gloss/put failed', err instanceof Error ? err.message : err);
    }
  }

  // `attempts` is internal accounting; the client sees items and a warning only.
  return json(result.warning ? { items: result.items, warning: result.warning } : { items: result.items });
}

async function handleTts(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  policy: Policy
): Promise<Response> {
  const text = (url.searchParams.get('text') ?? '').trim();
  if (!text) return badRequest('text is required');
  if (text.length > TTS_MAX_CHARS) {
    return badRequest(`text must be at most ${TTS_MAX_CHARS} characters`);
  }
  if (!isChineseText(text)) return badRequest('text must be Chinese');

  // `?voice=azure|melotts` pins one rung of the ladder so the same word can be
  // heard both ways back to back. It only ever narrows what config already
  // allows; anything else here is ignored and the normal ladder runs.
  const force = url.searchParams.get('voice');
  const variant = ttsCacheVariant(env, force);

  // Cache first. workers.dev subdomains are not CDN-cached, so the
  // Cache-Control header alone protects nothing; this does.
  //
  // The Cache API is an optimisation, never a dependency: read and write are
  // guarded separately, and a failure of either degrades to a normal miss (one
  // quota-protected synthesis) instead of a 500 the teacher has to look at.
  const key = ttsCacheKey(request.url, text, variant);
  const hit = await cacheMatch(key);
  if (hit) {
    // The provider that recorded the clip is baked into the cached headers, so
    // a HIT still reports the right x-tts-voice without calling anyone.
    const headers = new Headers(hit.headers);
    headers.set('X-Tts-Cache', 'HIT');
    return new Response(hit.body, { status: hit.status, headers });
  }

  // Reserve the worst case the whole ladder can spend, refund what it did not
  // use. One reservation covers every rung: Azure and MeloTTS are charged to
  // the same daily budget, because both are calls a stranger can make us pay
  // for.
  const budget = ttsAttemptBudget(env, policy.ttsMaxAttempts, force);
  if (budget === 0) return json({ error: 'speech is unavailable right now' }, 502);

  const reserved = await reserveQuota(request, env, policy, 'tts', budget);
  if (!reserved.ok) return reserved.response;

  const result = await synthesizeLadder(env, text, {
    maxAttempts: policy.ttsMaxAttempts,
    force,
  });
  await releaseQuota(env, reserved.reservation, result.attempts);

  const audio = result.audio;
  if (!audio) return json({ error: 'speech is unavailable right now' }, 502);

  cachePut(ctx, key, audio);
  const headers = new Headers(audio.headers);
  headers.set('X-Tts-Cache', 'MISS');
  return new Response(audio.body, { status: audio.status, headers });
}

/** Reads the clip cache. Any failure is reported as a miss, never thrown. */
async function cacheMatch(key: Request): Promise<Response | undefined> {
  try {
    return await caches.default.match(key);
  } catch (err) {
    console.error('tts: cache read failed', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Writes the clip cache in the background. Any failure is logged and dropped. */
function cachePut(ctx: ExecutionContext, key: Request, audio: Response): void {
  const log = (err: unknown) =>
    console.error('tts: cache write failed', err instanceof Error ? err.message : err);
  try {
    ctx.waitUntil(caches.default.put(key, audio.clone()).catch(log));
  } catch (err) {
    log(err);
  }
}

/**
 * Reads a shared Google Sheet and hands back its CSV.
 *
 * Costs nothing and calls no model, so it is not metered: the only outbound
 * request is to one fixed host (see ./sheet.ts, which refuses anything that is
 * not exactly a docs.google.com spreadsheet link before a request is made), and
 * both the body size and the wait are capped from policy.
 */
async function handleSheet(url: URL, policy: Policy): Promise<Response> {
  const parsed = parseSheetUrl(url.searchParams.get('url') ?? '');
  if (!parsed.ok) return badRequest(parsed.error);

  const result = await fetchSheetCsv(parsed.target, {
    maxBytes: policy.sheetMaxBytes,
    timeoutMs: policy.sheetTimeoutMs,
  });
  if (!result.ok) return json({ error: result.error }, result.status);

  return json({ text: result.text });
}

/**
 * Reads a photo of a word list and hands back the text.
 *
 * Order matters: the 501 for "nothing configured can run" and every validation
 * refusal happen BEFORE any quota is reserved, so a teacher who picks a PDF by
 * mistake does not lose one of the day's photo reads.
 *
 * The worst case is one paid call per rung of the ladder (see ./ocr.ts), so
 * that is what is reserved, and the rungs that were never reached are refunded.
 * With no Azure account that is one call, to Workers AI.
 */
async function handleOcr(request: Request, env: Env, policy: Policy): Promise<Response> {
  const providers = plannedOcrProviders(env);
  if (providers.length === 0) return json({ error: OCR_NOT_SET_UP }, 501);

  const contentType = request.headers.get('Content-Type');
  if (!isAllowedImageType(contentType)) return badRequest(OCR_WRONG_TYPE);

  const read = await readImageBounded(request, policy.ocrMaxBytes);
  if (!read.ok) return json({ error: OCR_TOO_BIG }, 413);
  if (read.bytes.byteLength === 0) return badRequest(OCR_EMPTY);

  const reserved = await reserveQuota(request, env, policy, 'ocr', providers.length);
  if (!reserved.ok) return reserved.response;

  const result = await runOcrLadder(env, providers, read.bytes, policy.ocrTimeoutMs);
  await releaseQuota(env, reserved.reservation, result.attempts);

  if (!result.ok) return json({ error: result.error }, result.status);

  // The photo path ends where the paste path ends. Reading the words out here,
  // rather than making the client post the text straight back, saves a round
  // trip on a phone and means both paths give the identical answer for
  // identical text instead of two readers drifting apart.
  //
  // Best effort: the text is what the teacher spent a photo read on, so a
  // failure here still returns it and the client parses it locally.
  try {
    const extracted = await extractWithDict(env, result.text, request.url);
    return json({ text: result.text, ...toResponse(extracted.result) });
  } catch (err) {
    console.error('ocr: extract failed', err instanceof Error ? err.message : err);
    return json({ text: result.text });
  }
}

/**
 * POST /api/extract: a paste in, the words in it out.
 *
 * The normal path spends nothing. The dictionary is a static asset and the
 * segmentation is a table lookup, so this route has no quota reservation around
 * it at all, which is the point: reading a teacher's list must not be able to
 * run out.
 *
 * The rescue is the exception, and it only fires when the dictionary found
 * almost nothing on a paste that plainly holds Chinese. It is charged to the
 * `enrich` budget, and being out of budget skips it in silence rather than
 * failing the request: whatever the dictionary found is still a better answer
 * than an error.
 */
async function handleExtract(request: Request, env: Env, policy: Policy): Promise<Response> {
  // The BODY is bounded by the global cap, and the TEXT by this route's own
  // 64 KB. Deliberately in that order: capping the body at 64 KB would reject a
  // 64 KB paste for its JSON quoting and answer with the generic size error,
  // and the teacher would read "too big to send" for a list that is not. The
  // body cap is the memory protection; the text cap is the one she hears from.
  const parsed = await readJsonBounded(request, policy.maxBodyBytes);
  if (!parsed.ok) return parsed.response;

  const valid = validateExtractBody(parsed.value);
  if (!valid.ok) return json({ error: valid.error }, valid.status);

  let read;
  try {
    read = await extractWithDict(env, valid.text, request.url);
  } catch (err) {
    console.error('extract: failed', err instanceof Error ? err.message : err);
    return json({ error: 'Could not read those words. Please try again.' }, 500);
  }

  if (!needsRescue(read.result, valid.text)) return json(toResponse(read.result));

  // This exact paste has already been rescued in this isolate. BEFORE the
  // reservation, deliberately: a teacher whose paste did not work presses the
  // button again, and the second press must not spend a second slice of the
  // day's budget to arrive at the answer she already has.
  const remembered = cachedRescue(valid.text);
  if (remembered) return json(mergeRescue(read.result, remembered));

  // Almost nothing came back. Ask a model, and keep only what it can prove.
  const reserved = await reserveQuota(request, env, policy, 'enrich', policy.enrichMaxAttempts);
  if (!reserved.ok) return json(toResponse(read.result));

  const rescue = await rescueWithModel(env, valid.text, read.dict, policy.enrichMaxAttempts);
  await releaseQuota(env, reserved.reservation, rescue.attempts);
  return json(mergeRescue(read.result, rescue.items));
}

/**
 * Two ways to make a room.
 *
 * Teacher room (`{ set, teacher: true }`): no questions in the payload at all.
 * The server builds a fresh list from the set at every round start, so the
 * answer key never leaves the server and each round gets its own shuffle. The
 * reply carries a one-time `hostKey`, which is the only thing that can start,
 * reset, or close the room.
 *
 * Legacy "Race a friend" (`{ set, questions, perQuestionMs }`): unchanged. Those
 * questions become the room's one race. Their creator already knows the key,
 * which is a pre-existing and accepted property of the two-friend race.
 */
async function handleCreateRoom(request: Request, env: Env, policy: Policy): Promise<Response> {
  const parsed = await readJsonBounded(request, policy.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (!body || typeof body !== 'object') return badRequest('body must be JSON');
  const { set, questions, perQuestionMs, teacher } = body as {
    set?: unknown;
    questions?: unknown;
    perQuestionMs?: unknown;
    teacher?: unknown;
  };

  const setError = validateSet(set);
  if (setError) return badRequest(setError);
  const vocabSet = set as VocabSet;
  const isTeacher = teacher === true;

  if (!isTeacher) {
    const questionError = validateQuestions(questions, vocabSet);
    if (questionError) return badRequest(questionError);
  }

  // A teacher room may name its own timer; without one it takes the level's.
  const timer = perQuestionMs === undefined && isTeacher
    ? perQuestionMsFor(vocabSet.level)
    : perQuestionMs;
  if (
    typeof timer !== 'number' ||
    !Number.isFinite(timer) ||
    timer < 1000 ||
    timer > 60_000
  ) {
    return badRequest('perQuestionMs must be between 1000 and 60000');
  }

  // What actually gets written to Durable Object storage, bounded independently
  // of the request body (a small body can still describe a large room). A
  // teacher room stores no questions, but it will build up to two per item, so
  // it is sized on what a round will hold rather than on what was posted.
  const stored = isTeacher
    ? JSON.stringify({ set: vocabSet, questions: buildQuestions(vocabSet) })
    : JSON.stringify({ set: vocabSet, questions });
  if (byteLength(stored) > policy.maxBodyBytes) return tooLarge();

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = generateCode();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const res = await stub.fetch(
      new Request('https://room/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          set: vocabSet,
          questions: isTeacher ? [] : questions,
          perQuestionMs: timer,
          teacher: isTeacher,
          // The class size for THIS room, read from config now and carried by
          // the room for its whole life (policy.roomMaxPlayersTeacher).
          maxPlayers: policy.roomMaxPlayersTeacher,
        }),
      })
    );
    if (res.status === 409) continue; // that code is already a live room, try another
    if (!res.ok) return json({ error: 'could not create the room' }, 502);
    // The host key is minted inside the DO and travels exactly once, here.
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  return json({ error: 'could not find a free room code, please try again' }, 503);
}

/**
 * The identity headers a poll may carry, copied through to the Durable Object.
 *
 * A GET has no body, so a device that wants the state AS ITSELF (the teacher's
 * projector, or a child in a Sky Tower round who may see her own blocks and no
 * one else's) presents its key in a header. Length-capped here with the same
 * numbers the POST validator uses, so a caller cannot push a megabyte of header
 * into the DO, and copied field by field so nothing else on the request rides
 * along.
 *
 * Absent or wrong is not an error. It just means the room answers with the
 * payload it gives an unidentified caller, which is the redacted one.
 */
function viewerHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const copy = (name: string, max: number): void => {
    const value = request.headers.get(name);
    if (value && value.length <= max) out[name] = value;
  };
  copy('x-host-key', MAX_HOST_KEY_CHARS);
  copy('x-player-id', MAX_PLAYER_ID_CHARS);
  copy('x-member-key', MAX_HOST_KEY_CHARS);
  return out;
}

async function forwardToRoom(
  env: Env,
  code: string,
  path: string,
  init: RequestInit
): Promise<Response> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const res = await stub.fetch(new Request(`https://room/${path}`, init));
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function postToRoom(env: Env, code: string, path: string, body: unknown): Promise<Response> {
  return forwardToRoom(env, code, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Validation branches by action (amendment 8), because the two families of room
 * action authenticate differently:
 *
 *   round / end / lobby /   HOST actions: a `hostKey`, or the legacy
 *   close                   player-host's `playerId`. Which one is valid is the
 *                           room's business, so both are forwarded and the DO
 *                           decides.
 *   answer / pick           PLAYER actions: a `playerId`, always, plus the
 *                           `memberKey` that proves it is really that player.
 *                           A model 1 room takes the id alone; a model 2 room
 *                           never does. Which applies is the room's business,
 *                           so both are forwarded and the DO decides.
 *   join                    neither; it is how you get a playerId AND a
 *                           memberKey.
 *
 * Requiring a playerId on every non-join action (which is what v1 did) would
 * lock a teacher, who is not a player, out of her own room.
 */
async function handleRoomAction(
  request: Request,
  env: Env,
  policy: Policy,
  code: string,
  action: string
): Promise<Response> {
  const parsed = await readJsonBounded(request, policy.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (!body || typeof body !== 'object') return badRequest('body must be JSON');
  const rec = body as Record<string, unknown>;

  const auth = roomActionAuthFor(action);
  if (auth === 'unknown') return json({ error: 'unknown room action' }, 404);

  if (action === 'join') {
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) return badRequest('name is required');
    if (name.length > MAX_NAME_CHARS) {
      return badRequest(`name must be at most ${MAX_NAME_CHARS} characters`);
    }
    return postToRoom(env, code, 'join', { name });
  }

  // --- host actions ---
  if (auth === 'host') {
    const hostKey = typeof rec.hostKey === 'string' ? rec.hostKey : '';
    const hostPlayerId = typeof rec.playerId === 'string' ? rec.playerId : '';
    if (hostKey.length > MAX_HOST_KEY_CHARS) return badRequest('hostKey is not valid');
    if (hostPlayerId.length > MAX_PLAYER_ID_CHARS) return badRequest('playerId is not valid');
    if (!hostKey && !hostPlayerId) return badRequest('hostKey or playerId is required');

    // What was the right answer? One question, by index; the DO refuses one
    // that is not shut yet (D3).
    if (action === 'reveal') {
      const { index } = rec;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        return badRequest('index must be a whole number');
      }
      return postToRoom(env, code, 'reveal', { hostKey, playerId: hostPlayerId, index });
    }

    if (action !== 'round') {
      return postToRoom(env, code, action, { hostKey, playerId: hostPlayerId });
    }

    const kind = rec.kind;
    if (kind !== 'race' && kind !== 'climb' && kind !== 'dash' && kind !== 'tower') {
      return badRequest('kind must be race, climb, dash or tower');
    }
    const { perQuestionMs } = rec;
    if (perQuestionMs !== undefined) {
      if (
        typeof perQuestionMs !== 'number' ||
        !Number.isFinite(perQuestionMs) ||
        perQuestionMs < 1000 ||
        perQuestionMs > 60_000
      ) {
        return badRequest('perQuestionMs must be between 1000 and 60000');
      }
    }
    // How long the round is, in questions. Absent means the default (12); an
    // out-of-range number is refused rather than clamped, so a teacher who asks
    // for 60 is told the band instead of quietly getting 30.
    const { questionsPerRound } = rec;
    if (questionsPerRound !== undefined) {
      if (
        typeof questionsPerRound !== 'number' ||
        !Number.isInteger(questionsPerRound) ||
        questionsPerRound < MIN_QUESTIONS_PER_ROUND ||
        questionsPerRound > MAX_QUESTIONS_PER_ROUND
      ) {
        return badRequest(
          `questionsPerRound must be a whole number between ${MIN_QUESTIONS_PER_ROUND} and ${MAX_QUESTIONS_PER_ROUND}`
        );
      }
    }

    return postToRoom(env, code, 'round', {
      hostKey,
      playerId: hostPlayerId,
      kind,
      perQuestionMs,
      questionsPerRound,
    });
  }

  // --- player actions ---
  const playerId = typeof rec.playerId === 'string' ? rec.playerId : '';
  if (!playerId || playerId.length > MAX_PLAYER_ID_CHARS) return badRequest('playerId is required');

  // Whether a member key is REQUIRED depends on the room's model, which only the
  // room knows, so it is forwarded like hostKey and the DO decides. Only the
  // length is the router's business.
  const memberKey = typeof rec.memberKey === 'string' ? rec.memberKey : '';
  if (memberKey.length > MAX_MEMBER_KEY_CHARS) return badRequest('memberKey is not valid');

  if (action === 'start') {
    return postToRoom(env, code, 'start', { playerId });
  }

  if (action === 'answer' || action === 'pick') {
    const { index } = rec;
    // The exact upper bound is `questions.length`, which only the room knows;
    // the reducer enforces it. MAX_QUESTIONS is the structural ceiling that
    // keeps obvious junk from reaching the Durable Object at all.
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= MAX_QUESTIONS
    ) {
      return badRequest('index must be a question number in this game');
    }

    if (action === 'pick') {
      const { chest } = rec;
      if (typeof chest !== 'number' || !Number.isInteger(chest) || chest < 0 || chest >= 3) {
        return badRequest('chest must be 0, 1 or 2');
      }
      return postToRoom(env, code, 'pick', { playerId, memberKey, index, chest });
    }

    const { choice } = rec;
    if (
      typeof choice !== 'number' ||
      !Number.isInteger(choice) ||
      choice < 0 ||
      choice >= MAX_QUESTIONS
    ) {
      return badRequest('choice must be a non-negative integer');
    }
    return postToRoom(env, code, 'answer', { playerId, memberKey, index, choice });
  }

  return json({ error: 'unknown room action' }, 404);
}

// --- entry point -------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const policy = readPolicy(env);

    if (path === '/api/enrich') {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405);
      return handleEnrich(request, env, policy);
    }

    if (path === '/api/tts') {
      if (request.method !== 'GET') return json({ error: 'use GET' }, 405);
      return handleTts(request, url, env, ctx, policy);
    }

    if (path === '/api/sheet') {
      if (request.method !== 'GET') return json({ error: 'use GET' }, 405);
      return handleSheet(url, policy);
    }

    if (path === '/api/extract') {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405);
      return handleExtract(request, env, policy);
    }

    if (path === '/api/ocr') {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405);
      return handleOcr(request, env, policy);
    }

    if (path === '/api/rooms') {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405);
      return handleCreateRoom(request, env, policy);
    }

    // /api/rooms/:code  and  /api/rooms/:code/:action
    const roomMatch = path.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (roomMatch) {
      const code = decodeURIComponent(roomMatch[1]).toUpperCase();
      const action = roomMatch[2];
      if (!isValidCode(code)) return json({ error: 'room not found' }, 404);

      if (!action) {
        if (request.method !== 'GET') return json({ error: 'use GET' }, 405);
        const v = url.searchParams.get('v');
        const query = v !== null ? `?v=${encodeURIComponent(v)}` : '';
        return forwardToRoom(env, code, `state${query}`, {
          method: 'GET',
          headers: viewerHeaders(request),
        });
      }

      if (request.method !== 'POST') return json({ error: 'use POST' }, 405);
      return handleRoomAction(request, env, policy, code, action);
    }

    return json({ error: 'not found' }, 404);
  },
};

