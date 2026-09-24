// POST /api/enrich: fill a 1-4 word English gloss for Chinese items that do not
// have one yet.
//
// Three sources, cheapest first (order set 2026-09-08):
//   (a) the QuotaDO gloss cache, applied by the caller before we are reached:
//       anything the teacher or a previous request already glossed arrives with
//       a non-empty `en` and is passed straight through;
//   (b) CC-CEDICT, the offline dictionary shipped as a static asset. This is
//       now the PRIMARY source. It costs no neurons, so a word it knows never
//       touches the paid budget;
//   (c) Workers AI, for whatever is left. The exception, not the rule.
//
// Why the order changed: on 2026-09-07 the free Workers AI allocation of 10,000
// neurons a day ran out (error 4006) and EVERY gloss came back empty, because
// (c) was the only source there was.
//
// This function NEVER throws to the client. Every failure path degrades to
// `en: ""` for the affected item plus a `warning` string, so the teacher can
// type the gloss in the review table instead of hitting an error screen.

import { parseGlossArray } from './pure';
import { loadDict, type Dict, type DictEnv } from './dict';
// A structural slice of the `AI` binding rather than `Env` from ./index, for the
// reason spelled out in tts.ts: importing Env drags the ambient Cloudflare
// Workers types into every file that imports this one, including
// tests/worker.test.ts, which is typechecked without them.
import type { AiRunner } from './tts';

/** What this module needs from the worker environment. `Env` satisfies it. */
export interface EnrichEnv extends DictEnv {
  AI: AiRunner;
}

/** The slice of a Dict this module uses, so tests can pass a two-line fake. */
export interface GlossLookup {
  lookup(zh: string): { en: string } | null;
}

/** Options for enrichItems. Both exist so tests can run without a real asset. */
export interface EnrichOptions {
  /** Overrides the shipped dictionary. `null` disables step (b) entirely. */
  dict?: GlossLookup | null;
  /** Request URL, so the asset is fetched from this same origin. */
  baseUrl?: string;
}

/**
 * The exact sentence a teacher sees when Workers AI could not answer at all.
 * Named because tests pin it: a vague "something went wrong" is useless, and
 * naming the dictionary count tells her how much typing is actually left.
 */
export function aiUnavailableWarning(fromDictionary: number): string {
  return (
    'The AI helper has used up its daily budget. ' +
    `${fromDictionary} words were filled from the dictionary; please type the rest.`
  );
}

/**
 * Fills empty glosses from the dictionary. Returns how many it filled.
 *
 * A teacher's own gloss always wins, and so does a cached one, because both
 * arrive as a non-empty `en` and are skipped here.
 */
export function fillFromDict(
  items: Array<{ zh: string; en: string }>,
  dict: GlossLookup | null | undefined
): number {
  if (!dict) return 0;
  let filled = 0;
  for (const item of items) {
    if (item.en !== '') continue;
    const hit = dict.lookup(item.zh);
    if (hit && hit.en) {
      item.en = hit.en;
      filled++;
    }
  }
  return filled;
}

/** Pinned per plan amendment 1. Primary is tried twice, then the fallback once. */
export const PRIMARY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const FALLBACK_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

export interface EnrichInputItem {
  zh: string;
  en?: string;
}
export interface EnrichOutputItem {
  zh: string;
  en: string;
}
export interface EnrichResult {
  items: EnrichOutputItem[];
  warning?: string;
  /**
   * How many paid `env.AI.run` calls this actually made. The caller reserves
   * the worst case against the daily budgets before calling and refunds
   * `reserved - attempts` afterwards, so a first-try success costs 1.
   */
  attempts: number;
}

/**
 * The models one request may try, in order: the primary as many times as the
 * budget allows, then the fallback once. `maxAttempts` comes from policy.ts.
 */
export function enrichModelPlan(maxAttempts: number): string[] {
  const n = Math.max(1, Math.floor(maxAttempts));
  if (n === 1) return [PRIMARY_MODEL];
  return [...new Array(n - 1).fill(PRIMARY_MODEL), FALLBACK_MODEL];
}

const SYSTEM_PROMPT = [
  'You translate Chinese vocabulary for a language classroom.',
  'You reply with JSON only: a JSON array of objects, each {"zh": "<the Chinese word exactly as given>", "en": "<gloss>"}.',
  'The gloss is 1 to 4 plain English words that a language learner would use.',
  'No pinyin. No pronunciation. No part-of-speech labels. No explanations, notes, or extra keys.',
  'Return one object for every Chinese word you are given, in the same order.',
].join(' ');

function buildUserPrompt(words: string[]): string {
  return `Give the English gloss for each of these ${words.length} Chinese words:\n${JSON.stringify(words)}`;
}

/**
 * One Workers AI text-generation call. Returns whatever payload most likely
 * holds the gloss list, or null on any error.
 *
 * Workers AI answers with an OpenAI-style chat completion (verified live
 * 2026-09-07). Two fields can carry the answer: `response`, which is sometimes
 * already a parsed array and sometimes the raw string, and
 * `choices[0].message.content`, which is always the raw string. Both are tried,
 * and parseGlossArray copes with either shape.
 */
async function runModel(env: EnrichEnv, model: string, words: string[]): Promise<unknown> {
  try {
    const result = (await env.AI.run(model, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(words) },
      ],
      max_tokens: Math.min(2048, 128 + words.length * 32),
      temperature: 0.2,
    })) as unknown;

    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object') return null;

    const rec = result as Record<string, unknown>;
    if (Array.isArray(rec.response) || typeof rec.response === 'string') return rec.response;

    const choices = rec.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const message = (choices[0] as Record<string, unknown> | undefined)?.message;
      const content = (message as Record<string, unknown> | undefined)?.content;
      if (typeof content === 'string') return content;
    }

    console.error(`enrich: ${model} returned an unexpected shape`);
    return null;
  } catch (err) {
    console.error(`enrich: ${model} failed`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Fills glosses from CC-CEDICT first, then Workers AI for whatever is left.
 *
 * Anything still unglossed comes back as `en: ""`. `attempts` reports how many
 * paid calls were actually made so the caller can refund the rest of its
 * reservation; a request the dictionary answers in full reports 0 and never
 * touches `env.AI`.
 */
export async function enrichItems(
  env: EnrichEnv,
  items: EnrichInputItem[],
  maxAttempts = 3,
  options: EnrichOptions = {}
): Promise<EnrichResult> {
  const out: EnrichOutputItem[] = items.map((item) => ({
    zh: item.zh,
    en: typeof item.en === 'string' ? item.en.trim() : '',
  }));

  if (out.every((item) => item.en !== '')) return { items: out, attempts: 0 };

  // (b) CC-CEDICT. `dict: null` disables it; anything else, including the
  // default, loads the shipped asset. A missing asset degrades to a dictionary
  // that knows nothing, so the AI path below is unchanged from before.
  const dict: GlossLookup | null =
    options.dict === undefined ? await loadDictSafely(env, options.baseUrl) : options.dict;
  fillFromDict(out, dict);

  const needIdx = out.map((item, i) => (item.en === '' ? i : -1)).filter((i) => i !== -1);
  if (needIdx.length === 0) return { items: out, attempts: 0 };

  // (c) Workers AI, only for what the dictionary did not know.
  const words = needIdx.map((i) => out[i].zh);
  const plan = enrichModelPlan(maxAttempts);

  let filledAny = false;
  let usedFallback = false;
  /** True once any model call returned something we could parse. */
  let modelAnswered = false;
  /** Indices the model filled, so the warning below can exclude them. */
  const modelFilled = new Set<number>();
  let attempts = 0;

  for (let attempt = 0; attempt < plan.length; attempt++) {
    const model = plan[attempt];
    attempts++;
    const raw = await runModel(env, model, words);
    const parsed = parseGlossArray(raw);
    if (parsed.length === 0) continue;
    modelAnswered = true;

    const byZh = new Map<string, string>();
    for (const entry of parsed) {
      if (entry.en && !byZh.has(entry.zh)) byZh.set(entry.zh, entry.en);
    }

    for (let k = 0; k < needIdx.length; k++) {
      const target = out[needIdx[k]];
      if (target.en !== '') continue;
      // Prefer an exact zh match; fall back to positional alignment when the
      // model echoed the words in order but altered them (e.g. stripped a space).
      const byKey = byZh.get(target.zh);
      const positional = parsed[k] && parsed[k].en ? parsed[k].en : '';
      const gloss = byKey ?? positional;
      if (gloss) {
        target.en = gloss;
        modelFilled.add(needIdx[k]);
        filledAny = true;
      }
    }

    if (model === FALLBACK_MODEL) usedFallback = true;
    if (out.every((item) => item.en !== '')) break;
  }

  const stillEmpty = needIdx.filter((i) => out[i].en === '').length;
  if (stillEmpty === 0) {
    return usedFallback
      ? {
          items: out,
          warning: `Used the backup model (${FALLBACK_MODEL}) for some words.`,
          attempts,
        }
      : { items: out, attempts };
  }
  // Workers AI gave us nothing usable: out of daily budget (error 4006), down,
  // or answering with something we cannot read. The teacher does not care
  // which, she cares how many rows are still hers to type.
  if (!modelAnswered && !filledAny) {
    return { items: out, warning: aiUnavailableWarning(countDictionaryBacked(out, dict, modelFilled)), attempts };
  }
  return {
    items: out,
    warning: `${stillEmpty} word${stillEmpty === 1 ? '' : 's'} came back blank. Type those in yourself.`,
    attempts,
  };
}

/**
 * How many filled rows the teacher owes to the dictionary rather than to the
 * model. NOT the same as `fillFromDict`'s return value: a word this request
 * found in the QuotaDO gloss cache arrived already glossed, so nothing was
 * filled here, yet telling her it came from the model would be false. The test
 * is "it is filled, the model did not fill it, and the dictionary knows it".
 */
function countDictionaryBacked(
  out: EnrichOutputItem[],
  dict: GlossLookup | null,
  modelFilled: Set<number>
): number {
  if (!dict) return 0;
  let n = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i].en === '' || modelFilled.has(i)) continue;
    if (dict.lookup(out[i].zh)) n++;
  }
  return n;
}

/** loadDict already swallows its own errors; this guards a missing binding. */
async function loadDictSafely(env: EnrichEnv, baseUrl?: string): Promise<GlossLookup | null> {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  const dict: Dict = await loadDict(env, baseUrl);
  return dict.size > 0 ? dict : null;
}

