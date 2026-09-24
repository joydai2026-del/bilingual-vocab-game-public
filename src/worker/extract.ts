// POST /api/extract: whatever the teacher pasted, in; a word list, out.
//
// WHY THIS ROUTE EXISTS AT ALL
// The reading is done by src/shared/extract.ts, which is pure and could run in
// the browser. It cannot, because the thing that makes it work is the 8 MB
// CC-CEDICT asset: no teacher on a phone is downloading a dictionary to paste a
// word list. The dictionary stays on the server, so the reading happens here.
//
// WHAT IT COSTS: nothing, in the normal case. Segmentation is a table lookup.
// There is no model on this path, no quota is touched, and the answer does not
// vary between two identical pastes.
//
// THE ONE EXCEPTION is the rescue below: a paste with plenty of Chinese in it
// that produced almost no words is a paste the dictionary could not read, and
// asking a model is better than handing the teacher an empty screen. It is
// hedged three ways. It runs only on that narrow condition, it is charged to
// the same `enrich` daily budget as everything else paid, and every word it
// suggests is CHECKED AGAINST THE DICTIONARY before it is kept, so a model that
// invents a word cannot put that word on a card. Out of budget means the rescue
// is skipped in silence: the teacher still gets whatever the dictionary found,
// which is the honest answer and not an error screen.
//
// A paste that has already been through the rescue in this isolate does not go
// again: the answer is remembered, the empty one included, because a teacher
// whose paste did not work is a teacher who presses the button again.

import {
  MAX_EXTRACT_ITEMS,
  countSources,
  extractVocab,
  isAllCjk,
  isLeftoverSummaryNote,
  leftoverSummaryCount,
  withoutDocStructureMarkers,
  type ExtractResult,
  type ExtractedVocab,
} from '../shared/extract';
import { isStopword } from '../shared/stopwords';
import { loadDict, type Dict, type DictEnv } from './dict';
import { enrichModelPlan } from './enrich';
import type { AiRunner } from './tts';

/** What this module needs from the worker environment. `Env` satisfies it. */
export interface ExtractEnv extends DictEnv {
  AI: AiRunner;
}

/** The most text one paste may hold. A 64 KB paste is already ~20k characters. */
export const MAX_EXTRACT_BYTES = 64 * 1024;

/** What the teacher reads when the box was empty. */
export const EXTRACT_EMPTY = 'Paste your words in the box first.';
/** What she reads when the paste was too big to send. */
export const EXTRACT_TOO_BIG =
  'That is more than one paste can hold. Send it in two or three goes.';

/** The body the client posts. */
export interface ExtractRequest {
  text: string;
}

/**
 * The body the client reads. `items` is the shape src/client/input/extract.ts
 * expects; `counts` says which of the three paths each word came from, which is
 * how a live run can be told apart from a lucky one.
 */
export interface ExtractResponse {
  items: Array<{ zh: string; pinyin: string; en: string }>;
  skipped: string[];
  /**
   * Notices that are NOT lines we failed to read: a word defined twice, a
   * meaning we did not use, how much Quizlet sidebar came off, how many
   * leftovers were too many to list. Present only when there is something to
   * say. See ExtractResult in src/shared/extract.ts.
   */
  notes?: string[];
  mode: 'structured' | 'free';
  counts: { pair: number; dict: number; segment: number };
  /** Present only when the model rescue actually added something. */
  rescued?: number;
  /**
   * Present only on an empty answer that was a DECISION: the paste was headings
   * and nothing else. It tells the client not to fall back to its own parser,
   * which reads `第1课 Lesson one` as a word and its meaning. See ExtractResult
   * in src/shared/extract.ts.
   */
  paperworkOnly?: boolean;
}

type Validated = { ok: true; text: string } | { ok: false; error: string; status: number };

/** Checks a posted body without trusting any of it. */
export function validateExtractBody(body: unknown): Validated {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body must be JSON', status: 400 };
  }
  const text = (body as { text?: unknown }).text;
  if (typeof text !== 'string') return { ok: false, error: 'text is required', status: 400 };
  if (text.trim() === '') return { ok: false, error: EXTRACT_EMPTY, status: 400 };
  if (new TextEncoder().encode(text).byteLength > MAX_EXTRACT_BYTES) {
    return { ok: false, error: EXTRACT_TOO_BIG, status: 413 };
  }
  return { ok: true, text };
}

/** How many Chinese characters the paste holds. Decides whether to rescue. */
export function cjkCount(text: string): number {
  const runs = text.match(/[㐀-䶿一-鿿豈-﫿々〇]/g);
  return runs ? runs.length : 0;
}

/** Below this many words, on a paste with real Chinese in it, we ask a model. */
export const RESCUE_BELOW_ITEMS = 2;
/** A paste with fewer Chinese characters than this is not worth a model call. */
export const RESCUE_MIN_CJK = 4;

/**
 * True when the dictionary path failed on something that plainly has words in
 * it. Deliberately narrow: two words already make a game, so a paste that
 * produced two is finished, not rescued.
 *
 * AN EMPTY ANSWER IS NOT ALWAYS A FAILED READ. `paperworkOnly` means the reader
 * looked, found only headings, and decided there is no vocabulary here: a
 * bilingual lesson index (`第1课 Lesson one`) is the case that named it. Asking
 * a model to find words in a paste that has none is how the teacher ended up in
 * a game whose cards were 第 and 课. So it is never asked, and she gets the
 * could-not-read screen she can actually fix. Round 7b.
 *
 * A LESSON NUMBER IS NOT EVIDENCE OF UNREAD VOCABULARY, so it is not counted.
 * `第1课 第2课 苹果` reads correctly as the one card 苹果, and the six Chinese
 * characters in the two markers around it used to clear RESCUE_MIN_CJK and buy
 * a model call out of her 30 a day on a paste that was already finished and
 * could not make a game either way (r8 SF-B, measured 2026-09-09). Only
 * doc-structure markers come off: see withoutDocStructureMarkers.
 */
export function needsRescue(result: ExtractResult, text: string): boolean {
  if (result.paperworkOnly) return false;
  return (
    result.items.length < RESCUE_BELOW_ITEMS &&
    cjkCount(withoutDocStructureMarkers(text)) >= RESCUE_MIN_CJK
  );
}

const RESCUE_SYSTEM = [
  'You find the vocabulary words in a piece of Chinese text for a language classroom.',
  'You reply with JSON only: a JSON array of the words, e.g. ["苹果","香蕉"].',
  'Each word is 1 to 4 Chinese characters and appears in the text exactly as you write it.',
  'Skip grammar words, particles and pronouns. No pinyin, no English, no explanations.',
  'At most 40 words.',
].join(' ');

/** The most words the rescue may add, whatever the model returns. */
export const RESCUE_MAX_WORDS = 40;

/**
 * Reads a model's answer into a word list. Tolerant on purpose: the reply may
 * be a JSON array, a JSON array wrapped in prose, or an already-parsed array.
 * Anything it cannot read is an empty list, never a throw.
 */
export function parseWordArray(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    const start = value.indexOf('[');
    const end = value.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    try {
      value = JSON.parse(value.slice(start, end + 1)) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const word = typeof entry === 'string' ? entry.trim() : '';
    if (word !== '' && word.length <= 8) out.push(word);
  }
  return out.slice(0, RESCUE_MAX_WORDS);
}

/**
 * Keeps only the suggestions that are real. FIVE tests, and a word has to pass
 * every one of them:
 *
 *   1. all Chinese          `IP`, `3Q`, `88`, `A` are not vocabulary. A model
 *                           asked for Chinese words answers with these anyway.
 *   2. at least 2 characters a lone character is a piece of a word, not a card.
 *                           The dictionary path holds itself to the same bar
 *                           (see src/shared/extract.ts), so the rescue cannot
 *                           be the way single characters get in.
 *   3. not a stopword       的, 了, 一个. Grammar, not vocabulary. Same list the
 *                           free path uses, so both paths mean the same thing.
 *   4. in the teacher's own paste
 *   5. in the dictionary, with an English meaning
 *
 * This is the whole reason a model is allowed on this path. It can propose, it
 * cannot invent: a word that is not in her paste, or that CC-CEDICT has never
 * heard of, never reaches a card. It also means the gloss and the reading on
 * the card come from the dictionary rather than from the model.
 *
 * Tests 1 to 3 were added on 2026-09-08. Without them a model that answered
 * `["的","了","我","是","一个","IP","88"]` put every one of those on a card,
 * because each of them IS in the paste and IS a CC-CEDICT headword. Proving a
 * word is real is not the same as proving it is worth teaching.
 */
export function validateRescue(words: string[], text: string, dict: Dict): ExtractedVocab[] {
  const out: ExtractedVocab[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    if (seen.has(word)) continue;
    if (!isAllCjk(word)) continue;
    if (Array.from(word).length < 2) continue;
    if (isStopword(word)) continue;
    if (!text.includes(word)) continue;
    const hit = dict.lookup(word);
    if (!hit || !hit.en) continue;
    seen.add(word);
    out.push({ zh: word, pinyin: hit.pinyin, en: hit.en, source: 'segment' });
    if (out.length >= RESCUE_MAX_WORDS) break;
  }
  return out;
}

/**
 * THE RESCUE CACHE. One Map, this isolate only, 200 entries.
 *
 * The rescue fires on a paste the dictionary could not read, and a teacher whose
 * paste did not work retries it: same text, same failure, another slice of the
 * day's `enrich` budget, and the same answer she already had. The cache is in
 * front of the budget reservation for that reason, and it remembers the EMPTY
 * answer too, which is the case that was costing the money.
 *
 * In-isolate is the right size for it and not a compromise. It is a thing to
 * skip a repeat within one warm worker, not a durable record: a cold isolate
 * simply pays for the call once. Nothing is written to KV, so the cache cannot
 * go stale against a redeployed dictionary and cannot be poisoned across
 * tenants, and there is no eviction policy to get wrong beyond "oldest out".
 *
 * The key is a hash of the NFKC-normalised, whitespace-collapsed text, so the
 * same paste sent twice from a phone keyboard is one key. A hash collision would
 * hand back another paste's words, so the length is part of the key and the
 * validated words are re-checked against the caller's own text before they are
 * used (see cachedRescue).
 */
const RESCUE_CACHE_MAX = 200;
const rescueCache = new Map<string, ExtractedVocab[]>();

/** FNV-1a over the normalised text. Not a security hash; a cache key. */
export function rescueCacheKey(text: string): string {
  const norm = String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    hash ^= norm.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${norm.length}:${hash.toString(16)}`;
}

/** What this paste got last time, or undefined if it has not been asked. */
export function readRescueCache(text: string): ExtractedVocab[] | undefined {
  const key = rescueCacheKey(text);
  const hit = rescueCache.get(key);
  if (!hit) return undefined;
  // Re-read on use, so 200 entries of a busy worker are the 200 most recently
  // wanted rather than the 200 most recently written.
  rescueCache.delete(key);
  rescueCache.set(key, hit);
  // Copies. A caller that sorts or edits the list it was handed must not be
  // able to edit what the next caller reads.
  return hit.map((item) => ({ ...item }));
}

/** Remembers this answer, empty ones included. Oldest out at 200. */
export function writeRescueCache(text: string, items: ExtractedVocab[]): void {
  const key = rescueCacheKey(text);
  rescueCache.delete(key);
  rescueCache.set(
    key,
    items.map((item) => ({ ...item }))
  );
  while (rescueCache.size > RESCUE_CACHE_MAX) {
    const oldest = rescueCache.keys().next();
    if (oldest.done) break;
    rescueCache.delete(oldest.value);
  }
}

/** Empties it. For tests, which must not inherit each other's answers. */
export function clearRescueCache(): void {
  rescueCache.clear();
}

/** How many pastes it is holding. For tests. */
export function rescueCacheSize(): number {
  return rescueCache.size;
}

/** One model call. Any failure is an empty list; the caller carries on. */
async function runRescueModel(env: ExtractEnv, model: string, text: string): Promise<string[]> {
  try {
    const result = (await env.AI.run(model, {
      messages: [
        { role: 'system', content: RESCUE_SYSTEM },
        // The paste is DATA. It is handed over as a JSON string in its own
        // message so that a paste which itself reads like an instruction cannot
        // be mistaken for one, and nothing it says can widen what this call is
        // allowed to do: the answer is a word list, and every word in it is
        // checked against the teacher's own text and the dictionary afterwards.
        { role: 'user', content: `Find the vocabulary words in this text:\n${JSON.stringify(text)}` },
      ],
      max_tokens: 1024,
      temperature: 0.2,
    })) as unknown;

    if (typeof result === 'string') return parseWordArray(result);
    if (!result || typeof result !== 'object') return [];
    const rec = result as Record<string, unknown>;
    if (Array.isArray(rec.response) || typeof rec.response === 'string') {
      return parseWordArray(rec.response);
    }
    const choices = rec.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const message = (choices[0] as Record<string, unknown> | undefined)?.message;
      const content = (message as Record<string, unknown> | undefined)?.content;
      if (typeof content === 'string') return parseWordArray(content);
    }
    return [];
  } catch (err) {
    console.error(`extract: rescue ${model} failed`, err instanceof Error ? err.message : err);
    return [];
  }
}

export interface RescueResult {
  items: ExtractedVocab[];
  /** Paid model calls actually made, so the caller can refund the rest. */
  attempts: number;
}

/**
 * Asks a model which words are in the text, then throws away everything it
 * cannot prove. Never throws.
 */
export async function rescueWithModel(
  env: ExtractEnv,
  text: string,
  dict: Dict,
  maxAttempts: number
): Promise<RescueResult> {
  if (dict.size === 0) return { items: [], attempts: 0 };
  // Belt and braces: the caller checks the cache before it reserves budget (see
  // cachedRescue), and this checks it again in case some other caller does not.
  const remembered = readRescueCache(text);
  if (remembered) return { items: remembered, attempts: 0 };

  const plan = enrichModelPlan(maxAttempts);
  let attempts = 0;
  for (const model of plan) {
    attempts++;
    const words = await runRescueModel(env, model, text);
    const items = validateRescue(words, text, dict);
    if (items.length > 0) {
      writeRescueCache(text, items);
      return { items, attempts };
    }
  }
  // The empty answer is remembered too. It is the expensive one: it spent every
  // model in the plan to find out that this paste has nothing readable in it.
  writeRescueCache(text, []);
  return { items: [], attempts };
}

/**
 * What the route asks before it spends anything: has this exact paste already
 * been through the rescue in this isolate?
 *
 * Returns undefined when it has not, which is the caller's signal to reserve
 * budget and call rescueWithModel. Every remembered word is re-checked against
 * THIS caller's text, so a hash collision cannot hand one teacher another
 * teacher's words.
 */
export function cachedRescue(text: string): ExtractedVocab[] | undefined {
  const hit = readRescueCache(text);
  if (!hit) return undefined;
  return hit.filter((item) => text.includes(item.zh));
}

/**
 * The most skipped lines the reply will carry.
 *
 * `skipped` is a courtesy: it tells the teacher which lines were paperwork so
 * she can see nothing was lost. A 64 KB paste of prose skips every line of it,
 * and the reply then carries the entire paste back over her phone connection to
 * fill a list nobody reads past the first screen. Fifty is more than she will
 * read and small enough not to matter.
 */
export const MAX_SKIPPED_REPORTED = 50;

/**
 * The most notes the reply will carry. Same reasoning as the skipped cap: a
 * list pasted twice makes one note per repeated word.
 */
export const MAX_NOTES_REPORTED = 50;

/**
 * The notes the reply will carry, with the last slot kept for a count line.
 *
 * ONE count line, and it counts EVERYTHING that did not reach the screen. Two
 * separate cuts happen on the way here: the extractor lists 49 unreadable
 * LEFTOVER LINES and hands its own count of the rest down as the last note
 * (`\u2026 and 151 more`), and this cap then drops whatever notes do not fit in
 * fifty slots. They used to be reported separately, so a paste with duplicates
 * AND leftovers sent sixty-one notes, kept fifty, and the one surviving count
 * line spoke only for the leftovers: eleven duplicate notices went in silence
 * (round 8 fix list, item 4). The extractor's count is now folded into this
 * one, computed after both cuts, and the single line reads
 * `\u2026 and 162 more notes`.
 *
 * A list that fits inside the cap is handed back untouched, count line and all.
 */
export function reportedNotes(notes: readonly string[]): string[] {
  if (notes.length <= MAX_NOTES_REPORTED) return [...notes];
  const last = notes[notes.length - 1];
  // The extractor's count line is not one of the notes: it is the tail of the
  // number this line is about, so it comes off the list and into the total.
  const unlisted = isLeftoverSummaryNote(last) ? leftoverSummaryCount(last) : 0;
  const listed = unlisted > 0 ? notes.slice(0, -1) : notes;
  const kept = listed.slice(0, MAX_NOTES_REPORTED - 1);
  const dropped = listed.length - kept.length + unlisted;
  return [...kept, `\u2026 and ${dropped} more notes`];
}

/** Puts the answer into the shape the client reads. */
export function toResponse(result: ExtractResult, rescued = 0): ExtractResponse {
  const items = result.items.slice(0, MAX_EXTRACT_ITEMS);
  const body: ExtractResponse = {
    items: items.map((item) => ({ zh: item.zh, pinyin: item.pinyin, en: item.en })),
    skipped: result.skipped.slice(0, MAX_SKIPPED_REPORTED),
    mode: result.mode,
    counts: countSources(items),
  };
  const notes = reportedNotes(result.notes ?? []);
  if (notes.length > 0) body.notes = notes;
  if (rescued > 0) body.rescued = rescued;
  if (result.paperworkOnly && items.length === 0) body.paperworkOnly = true;
  return body;
}

/**
 * The dictionary's answer with the rescue's words added to the end of it.
 *
 * The dictionary's own words keep their place at the front: they are the ones
 * that were proved without a model. One function so the fresh-rescue path and
 * the cached-rescue path cannot drift into two different answers.
 */
export function mergeRescue(result: ExtractResult, rescued: ExtractedVocab[]): ExtractResponse {
  if (rescued.length === 0) return toResponse(result);
  const seen = new Set(result.items.map((item) => item.zh));
  const added = rescued.filter((item) => !seen.has(item.zh));
  if (added.length === 0) return toResponse(result);
  return toResponse({ ...result, items: [...result.items, ...added] }, added.length);
}

/**
 * Reads a paste with the shipped dictionary. No model, no quota, no network.
 *
 * A missing or unreadable asset degrades to short-run extraction rather than to
 * an error, which is the same promise src/shared/extract.ts makes.
 */
export async function extractWithDict(
  env: ExtractEnv,
  text: string,
  baseUrl?: string
): Promise<{ result: ExtractResult; dict: Dict }> {
  const dict = await loadDict(env, baseUrl);
  return { result: extractVocab(text, dict.size > 0 ? dict : null), dict };
}

