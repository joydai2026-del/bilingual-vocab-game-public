// Tests for the worker's non-Cloudflare halves: room-code handling, request
// validation, the tolerant gloss parser, the Chinese-only TTS gate, and the
// exact persistence code RoomDO runs (against an in-memory fake of DO storage).
//
// NOT covered here: RoomDO's own HTTP shell, blockConcurrencyWhile, and alarms.
// Exercising those needs a Workers runtime (Miniflare / @cloudflare/vitest-pool-
// workers), which would mean a new dependency, so they are verified by the live
// wrangler dev / deploy checks instead. See README.

import { describe, it, expect } from 'vitest';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_ID_CHARS,
  MAX_SET_ITEMS,
  containsCjk,
  generateCode,
  isChineseText,
  isValidCode,
  parseGlossArray,
  validateEnrichItems,
  validateQuestions,
  validateSet,
} from '../src/worker/pure';
import { DEFAULT_POLICY, POLICY_VARS, readPolicy } from '../src/worker/policy';
import {
  NOT_A_SHEET,
  SHEET_PRIVATE,
  SHEET_SLOW,
  SHEET_TOO_BIG,
  SHEET_UNREACHABLE,
  buildCsvUrl,
  fetchSheetCsv,
  parseSheetUrl,
} from '../src/worker/sheet';
import {
  DEFAULT_OCR_PROVIDER_ORDER,
  OCR_FAILED,
  OCR_MODEL,
  OCR_NO_TEXT,
  OCR_PROMPT,
  buildAnalyzeUrl,
  cleanOcrText,
  extractText,
  isAllowedImageType,
  ocrAttemptBudget,
  parseOcrProviderOrder,
  plannedOcrProviders,
  readOcrConfig,
  runOcr,
  runOcrLadder,
  runWorkersAiOcr,
} from '../src/worker/ocr';
import {
  MAX_CONSUME_COUNT,
  MAX_GLOSS_ENTRIES,
  consume,
  getGlosses,
  normalizeText,
  parseConsumeRequest,
  parseRefundRequest,
  parseUsageRequest,
  putGlosses,
  refund,
  usage,
  utcDayKey,
  type QuotaStorage,
} from '../src/worker/quota';
import {
  KEY_DELETE_AT,
  loadHostKey,
  loadMembers,
  loadRoom,
  saveHostKey,
  saveJoin,
  saveNewRoom,
  saveRoomMeta,
  splitRoom,
  type RoomStorage,
} from '../src/worker/persist';
import { isHostAuthorized, isMemberAuthorized, roomActionAuthFor } from '../src/worker/pure';
import {
  AZURE_BREAK_MS,
  AZURE_DEFAULT_RATE,
  AZURE_DEFAULT_VOICE,
  AZURE_OUTPUT_FORMAT,
  DEFAULT_PROVIDER_ORDER,
  TTS_DEFAULT_MAX_ATTEMPTS,
  TTS_RETRY_DELAYS_MS,
  azureSsml,
  parseProviderOrder,
  plannedProviders,
  synthesize,
  synthesizeLadder,
  ttsAttemptBudget,
  ttsCacheKey,
  ttsCacheVariant,
  xmlEscape,
  type TtsEnv,
} from '../src/worker/tts';
import {
  aiUnavailableWarning,
  enrichItems,
  enrichModelPlan,
  fillFromDict,
  FALLBACK_MODEL,
  PRIMARY_MODEL,
  type GlossLookup,
} from '../src/worker/enrich';
import { buildDict, pickGloss, toneMarks, usableSenses } from '../src/shared/cedict';
import { makeDict } from '../src/worker/dict';
import { createRoom, join, start, answer, finishIfDone } from '../src/shared/room';
import { buildQuestions } from '../src/shared/quiz';
import type { VocabItem, VocabSet } from '../src/shared/types';

// --- fixtures ----------------------------------------------------------------

function makeSet(n: number): VocabSet {
  const items: VocabItem[] = Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    zh: `中${i}`,
    pinyin: `zhong${i}`,
    en: `word${i}`,
  }));
  return { v: 1, title: 'worker set', level: 'big', items };
}

/**
 * In-memory stand-in for DurableObjectStorage. Values are structured-cloned via
 * JSON so a test fails if we ever try to persist something unserializable.
 */
class FakeStorage implements RoomStorage {
  private readonly map = new Map<string, string>();
  public writes = 0;

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async put<T>(keyOrEntries: string | Record<string, unknown>, value?: T): Promise<void> {
    this.writes++;
    if (typeof keyOrEntries === 'string') {
      this.map.set(keyOrEntries, JSON.stringify(value));
      return;
    }
    for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, JSON.stringify(v));
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
  }

  keys(): string[] {
    return [...this.map.keys()].sort();
  }
}

/**
 * The same in-memory stand-in, widened to the slice QuotaDO needs (delete and
 * a prefix list). Same JSON round-trip, so anything unserializable fails here
 * exactly as it would in a real Durable Object.
 */
class FakeQuotaStorage implements QuotaStorage {
  private readonly map = new Map<string, string>();

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  /**
   * Ascending key order with an optional `limit`, exactly like the real
   * storage. The order is load-bearing: the gloss index leans on it to find the
   * oldest entries without reading the cache.
   */
  async list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? Infinity;
    this.listCalls++;
    const out = new Map<string, T>();
    for (const [key, raw] of [...this.map.entries()].sort()) {
      if (out.size >= limit) break;
      if (key.startsWith(prefix)) out.set(key, JSON.parse(raw) as T);
    }
    this.listedKeys += out.size;
    return out;
  }

  /** How many list() calls, and how many keys they returned in total. */
  listCalls = 0;
  listedKeys = 0;

  keys(): string[] {
    return [...this.map.keys()].sort();
  }
}

/**
 * Minimal stand-in for the `Ai` binding's `run` method: queues a canned result
 * per call (a value to return, or an `Error` to throw for a failed attempt),
 * repeating the last entry if more calls come in than results were queued.
 */
class FakeAi {
  calls = 0;

  constructor(private readonly results: Array<unknown>) {}

  async run(): Promise<unknown> {
    const result = this.results[Math.min(this.calls, this.results.length - 1)];
    this.calls++;
    if (result instanceof Error) throw result;
    return result;
  }
}

// --- room codes --------------------------------------------------------------

describe('room codes', () => {
  it('generates 4-character codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
      expect(isValidCode(code)).toBe(true);
    }
  });

  it('leaves out the digits and letters that look alike (the plan alphabet)', () => {
    for (const ch of ['O', '0', 'I', '1']) {
      expect(CODE_ALPHABET).not.toContain(ch);
    }
    expect(CODE_ALPHABET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  });

  it('rejects wrong length, lowercase, and out-of-alphabet codes', () => {
    expect(isValidCode('ABC')).toBe(false);
    expect(isValidCode('ABCDE')).toBe(false);
    expect(isValidCode('abcd')).toBe(false);
    expect(isValidCode('AB0D')).toBe(false);
    expect(isValidCode('')).toBe(false);
  });
});

// --- Chinese-only TTS gate ---------------------------------------------------

describe('isChineseText', () => {
  it('accepts Chinese words and Chinese punctuation', () => {
    expect(isChineseText('你好')).toBe(true);
    expect(isChineseText('苹果，香蕉')).toBe(true);
    expect(isChineseText('中 文')).toBe(true);
  });

  it('rejects English, mixed text, empty input, and digits', () => {
    expect(isChineseText('hello')).toBe(false);
    expect(isChineseText('apple 苹果')).toBe(false);
    expect(isChineseText('')).toBe(false);
    expect(isChineseText('123')).toBe(false);
    expect(isChineseText('   ')).toBe(false);
  });
});

// --- tts retry (bug B1: 2 of 20 identical live calls came back 502) ----------

describe('synthesize retries a failing AI.run', () => {
  it('returns audio from the attempt that finally succeeds, and charges no extra wait when it works first try', async () => {
    const ai = new FakeAi([new Uint8Array([1, 2, 3, 4])]);
    const env = { AI: ai };
    const waits: number[] = [];

    const res = await synthesize(env, '苹果', {
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    expect(res.audio).not.toBeNull();
    expect(new Uint8Array(await res.audio!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(ai.calls).toBe(1);
    // The number the caller refunds against: one paid call, not the reserved three.
    expect(res.attempts).toBe(1);
    expect(waits).toEqual([]);
  });

  it('retries with the configured backoff and returns audio once the third call succeeds', async () => {
    const ai = new FakeAi([
      new Error('melotts down'),
      new Error('melotts down'),
      new Uint8Array([9, 9]),
    ]);
    const env = { AI: ai };
    const waits: number[] = [];

    const res = await synthesize(env, '苹果', {
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    expect(res.audio).not.toBeNull();
    expect(new Uint8Array(await res.audio!.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    expect(ai.calls).toBe(3);
    expect(res.attempts).toBe(3);
    // Backed off between attempt 1->2 and 2->3, on the schedule the fix specifies.
    expect(waits).toEqual(TTS_RETRY_DELAYS_MS);
  });

  it('gives up and returns null audio (the caller turns this into a 502) once every attempt fails', async () => {
    const ai = new FakeAi([
      new Error('melotts down'),
      new Error('melotts down'),
      new Error('melotts down'),
    ]);
    const env = { AI: ai };

    const res = await synthesize(env, '苹果', { wait: async () => {} });

    expect(res.audio).toBeNull();
    expect(ai.calls).toBe(TTS_DEFAULT_MAX_ATTEMPTS);
    expect(res.attempts).toBe(TTS_DEFAULT_MAX_ATTEMPTS);
  });

  it('does not retry past the attempt cap even if AI.run keeps failing', async () => {
    const ai = new FakeAi([new Error('always fails')]);
    const env = { AI: ai };

    const res = await synthesize(env, '苹果', { wait: async () => {} });

    expect(res.audio).toBeNull();
    expect(ai.calls).toBe(TTS_DEFAULT_MAX_ATTEMPTS);
  });

  it('takes its attempt cap from the caller, so policy drives the spend', async () => {
    const ai = new FakeAi([new Error('always fails')]);

    const res = await synthesize({ AI: ai }, '苹果', { maxAttempts: 1, wait: async () => {} });

    expect(res.audio).toBeNull();
    expect(ai.calls).toBe(1);
    expect(res.attempts).toBe(1);
  });
});

// --- tts retry only on transient failure (codex r2, should-fix 4) ------------

describe('synthesize tells a transient failure from a malformed answer', () => {
  it('stops after one call when the model answers in a shape we cannot read', async () => {
    // Deterministic junk: the same prompt gives the same junk, so two more paid
    // calls would buy nothing.
    const ai = new FakeAi([{ notAudio: true }]);

    const res = await synthesize({ AI: ai }, '苹果', { wait: async () => {} });

    expect(res.audio).toBeNull();
    expect(ai.calls).toBe(1);
    expect(res.attempts).toBe(1);
  });

  it('stops after one call on undecodable base64 rather than burning the budget', async () => {
    const ai = new FakeAi([{ audio: '!!!not base64!!!' }]);

    const res = await synthesize({ AI: ai }, '苹果', { wait: async () => {} });

    expect(res.audio).toBeNull();
    expect(ai.calls).toBe(1);
  });

  it('stops after one call when the clip decodes to zero bytes', async () => {
    const ai = new FakeAi([new Uint8Array([])]);

    const res = await synthesize({ AI: ai }, '苹果', { wait: async () => {} });

    expect(res.audio).toBeNull();
    expect(ai.calls).toBe(1);
  });

  it('still retries a null result, which is an empty upstream response', async () => {
    const ai = new FakeAi([null, null, new Uint8Array([7])]);

    const res = await synthesize({ AI: ai }, '苹果', { wait: async () => {} });

    expect(res.audio).not.toBeNull();
    expect(ai.calls).toBe(3);
    expect(res.attempts).toBe(3);
  });
});

// --- the tts provider ladder (azure -> melotts -> pinyin only) --------------
//
// The Azure rung is unproven against the live service: the Azure resource does
// not exist yet, so every test below drives it through an injected `fetch`.
// What these prove is the ladder's own behaviour (order, fallback, budget,
// cache keying) and the exact bytes we would put on the wire. Whether Azure
// accepts that body is a live check for the day the key lands.

/** Records what the ladder would have sent to Azure, and answers with a canned reply. */
function fakeAzure(reply: () => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), headers, body: String(init?.body ?? '') });
    return await reply();
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const AZURE_ENV: Omit<TtsEnv, 'AI'> = {
  AZURE_SPEECH_KEY: 'test-key-never-logged',
  AZURE_SPEECH_REGION: 'eastus',
};

describe('SSML body', () => {
  it('escapes every XML metacharacter in the word, so a teacher cannot break the body', () => {
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
    // & first, or the escapes would themselves be re-escaped.
    expect(xmlEscape('a & b')).toBe('a &amp; b');
    expect(xmlEscape('苹果')).toBe('苹果');
  });

  it('puts the escaped word inside prosody, padded by a break on each side', () => {
    const ssml = azureSsml('R&D<苹果>', AZURE_DEFAULT_VOICE, AZURE_DEFAULT_RATE);

    expect(ssml).toContain('R&amp;D&lt;苹果&gt;');
    // The raw characters never reach the body.
    expect(ssml).not.toContain('R&D');
    expect(ssml).not.toContain('<苹果>');
    expect(ssml).toContain(`<prosody rate="${AZURE_DEFAULT_RATE}">`);
    expect(ssml).toContain(`<voice name="${AZURE_DEFAULT_VOICE}">`);
    // Padding on BOTH ends: a one-word clip must not start on the first sample.
    const breaks = ssml.match(new RegExp(`<break time="${AZURE_BREAK_MS}ms"/>`, 'g')) ?? [];
    expect(breaks).toHaveLength(2);
    expect(ssml.indexOf('<break')).toBeLessThan(ssml.indexOf('<prosody'));
    expect(ssml.lastIndexOf('<break')).toBeGreaterThan(ssml.indexOf('</prosody>'));
  });

  it('escapes the voice and rate too, since both come from config a human types', () => {
    expect(azureSsml('苹果', 'a"b', '-10% & fast')).toContain('<voice name="a&quot;b">');
    expect(azureSsml('苹果', 'v', '-10% & fast')).toContain('rate="-10% &amp; fast"');
  });
});

describe('TTS_PROVIDER_ORDER parsing', () => {
  it('reads a comma-separated order, trimming and lower-casing', () => {
    expect(parseProviderOrder('azure,melotts')).toEqual(['azure', 'melotts']);
    expect(parseProviderOrder(' MeloTTS , Azure ')).toEqual(['melotts', 'azure']);
    expect(parseProviderOrder('melotts')).toEqual(['melotts']);
  });

  it('drops duplicates so a provider is never tried twice in one request', () => {
    expect(parseProviderOrder('azure,azure,melotts')).toEqual(['azure', 'melotts']);
  });

  it('falls back to the default when the var is missing, blank, or all junk', () => {
    // A typo in config must not be able to switch spoken audio off.
    expect(parseProviderOrder(undefined)).toEqual([...DEFAULT_PROVIDER_ORDER]);
    expect(parseProviderOrder('   ')).toEqual([...DEFAULT_PROVIDER_ORDER]);
    expect(parseProviderOrder(',,,')).toEqual([...DEFAULT_PROVIDER_ORDER]);
    expect(parseProviderOrder('elevenlabs')).toEqual([...DEFAULT_PROVIDER_ORDER]);
    expect(parseProviderOrder(42)).toEqual([...DEFAULT_PROVIDER_ORDER]);
  });

  it('keeps the good names out of a partly-bad list', () => {
    expect(parseProviderOrder('elevenlabs,melotts')).toEqual(['melotts']);
  });
});

describe('the ladder this request will actually run', () => {
  const ai = new FakeAi([new Uint8Array([1])]);

  it('skips azure entirely when its secrets are absent, which is today', () => {
    expect(plannedProviders({ AI: ai })).toEqual(['melotts']);
    expect(plannedProviders({ AI: ai, AZURE_SPEECH_KEY: 'k' })).toEqual(['melotts']);
    expect(plannedProviders({ AI: ai, AZURE_SPEECH_REGION: 'eastus' })).toEqual(['melotts']);
  });

  it('runs both rungs once both secrets are set', () => {
    expect(plannedProviders({ AI: ai, ...AZURE_ENV })).toEqual(['azure', 'melotts']);
  });

  it('lets ?voice= narrow the ladder for an A/B listen, but never widen it', () => {
    const env = { AI: ai, ...AZURE_ENV };
    expect(plannedProviders(env, 'melotts')).toEqual(['melotts']);
    expect(plannedProviders(env, 'azure')).toEqual(['azure']);
    // ?voice=azure cannot conjure azure without its key.
    expect(plannedProviders({ AI: ai }, 'azure')).toEqual([]);
    // Anything unrecognised is ignored and the normal ladder runs.
    expect(plannedProviders(env, 'elevenlabs')).toEqual(['azure', 'melotts']);
    expect(plannedProviders(env, null)).toEqual(['azure', 'melotts']);
  });

  it('reserves one call for azure and the full retry budget for melotts', () => {
    const env = { AI: ai, ...AZURE_ENV };
    // Azure's failures are auth, quota or outage; a second identical call fixes
    // none of them, so it gets no retry and the ladder moves down instead.
    expect(ttsAttemptBudget(env, 3)).toBe(4);
    expect(ttsAttemptBudget(env, 3, 'azure')).toBe(1);
    expect(ttsAttemptBudget(env, 3, 'melotts')).toBe(3);
    // Unchanged from before azure existed on a worker with no key.
    expect(ttsAttemptBudget({ AI: ai }, 3)).toBe(3);
  });
});

describe('synthesizeLadder', () => {
  it('sends the documented azure call and labels the clip azure', async () => {
    const ai = new FakeAi([new Error('melotts must not be reached')]);
    const azure = fakeAzure(() => new Response(new Uint8Array([0xff, 0xfb, 1, 2])));

    const res = await synthesizeLadder({ AI: ai, ...AZURE_ENV }, '苹果', {
      maxAttempts: 3,
      fetchImpl: azure.fetch,
      wait: async () => {},
    });

    expect(res.provider).toBe('azure');
    expect(res.attempts).toBe(1);
    expect(ai.calls).toBe(0);
    expect(res.audio!.headers.get('x-tts-voice')).toBe('azure');

    const [call] = azure.calls;
    expect(call.url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(call.headers['ocp-apim-subscription-key']).toBe('test-key-never-logged');
    expect(call.headers['content-type']).toBe('application/ssml+xml');
    expect(call.headers['x-microsoft-outputformat']).toBe(AZURE_OUTPUT_FORMAT);
    // Documented as required; azure answers 400 without it.
    expect(call.headers['user-agent']).toBe('bilingual-vocab-game');
    expect(call.body).toBe(azureSsml('苹果', AZURE_DEFAULT_VOICE, AZURE_DEFAULT_RATE));
  });

  it('falls to melotts on a 401 and never logs the key', async () => {
    const ai = new FakeAi([new Uint8Array([7, 7, 7])]);
    const azure = fakeAzure(() => new Response('unauthorized', { status: 401 }));
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };

    let res;
    try {
      res = await synthesizeLadder({ AI: ai, ...AZURE_ENV }, '苹果', {
        maxAttempts: 3,
        fetchImpl: azure.fetch,
        wait: async () => {},
      });
    } finally {
      console.error = realError;
    }

    expect(res.provider).toBe('melotts');
    expect(new Uint8Array(await res.audio!.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
    expect(res.audio!.headers.get('x-tts-voice')).toBe('melotts');
    // One azure call plus one melotts call, both charged to the tts quota.
    expect(res.attempts).toBe(2);
    expect(ai.calls).toBe(1);
    // Exactly one line, naming the status and nothing else.
    expect(logged).toEqual(['tts: azure returned 401, falling back to the next provider']);
    expect(logged.join(' ')).not.toContain('test-key-never-logged');
  });

  it('falls to melotts on 403, 429 and 5xx as well', async () => {
    for (const status of [403, 429, 500, 503]) {
      const ai = new FakeAi([new Uint8Array([1])]);
      const azure = fakeAzure(() => new Response('nope', { status }));
      const res = await synthesizeLadder({ AI: ai, ...AZURE_ENV }, '苹果', {
        maxAttempts: 3,
        fetchImpl: azure.fetch,
        wait: async () => {},
      });
      expect(res.provider).toBe('melotts');
      expect(res.attempts).toBe(2);
    }
  });

  it('falls to melotts when the azure call throws or comes back empty', async () => {
    const thrown = await synthesizeLadder({ AI: new FakeAi([new Uint8Array([1])]), ...AZURE_ENV }, '苹果', {
      fetchImpl: (() => Promise.reject(new Error('dns'))) as unknown as typeof fetch,
      wait: async () => {},
    });
    expect(thrown.provider).toBe('melotts');

    const empty = await synthesizeLadder({ AI: new FakeAi([new Uint8Array([1])]), ...AZURE_ENV }, '苹果', {
      fetchImpl: fakeAzure(() => new Response(new Uint8Array([]))).fetch,
      wait: async () => {},
    });
    expect(empty.provider).toBe('melotts');
  });

  it('returns no audio and no provider once every rung has failed, so the client shows pinyin', async () => {
    const ai = new FakeAi([new Error('down'), new Error('down'), new Error('down')]);
    const res = await synthesizeLadder({ AI: ai, ...AZURE_ENV }, '苹果', {
      maxAttempts: 3,
      fetchImpl: fakeAzure(() => new Response('nope', { status: 500 })).fetch,
      wait: async () => {},
    });

    expect(res.audio).toBeNull();
    expect(res.provider).toBeNull();
    // Refunds 4 - 4 = 0 of the reservation: every held call was spent.
    expect(res.attempts).toBe(4);
  });

  it('makes no call at all when ?voice= names a provider config has ruled out', async () => {
    const ai = new FakeAi([new Uint8Array([1])]);
    const azure = fakeAzure(() => new Response(new Uint8Array([1])));

    const res = await synthesizeLadder({ AI: ai }, '苹果', {
      force: 'azure',
      fetchImpl: azure.fetch,
      wait: async () => {},
    });

    expect(res.audio).toBeNull();
    expect(res.attempts).toBe(0);
    expect(ai.calls).toBe(0);
    expect(azure.calls).toHaveLength(0);
  });
});

describe('the clip cache key', () => {
  const env: TtsEnv = { AI: new FakeAi([]), ...AZURE_ENV };
  const keyFor = (text: string, force?: string | null): string =>
    ttsCacheKey('https://app.example/api/tts', text, ttsCacheVariant(env, force)).url;

  it('shares one entry for the same word however it was spaced', () => {
    expect(keyFor(' 苹果 ')).toBe(keyFor('苹果'));
  });

  it('gives a forced voice its own entry, so an A/B listen never replays the other one', () => {
    expect(keyFor('苹果', 'melotts')).not.toBe(keyFor('苹果', 'azure'));
    expect(keyFor('苹果', 'melotts')).not.toBe(keyFor('苹果'));
  });

  it('re-keys when the azure voice or rate var changes, so config never serves stale audio', () => {
    const base = ttsCacheVariant(env);
    expect(ttsCacheVariant({ ...env, AZURE_TTS_VOICE: 'zh-CN-YunxiNeural' })).not.toBe(base);
    expect(ttsCacheVariant({ ...env, AZURE_TTS_RATE: '-25%' })).not.toBe(base);
    // No azure key: the variant is melotts alone, and the azure vars cannot move it.
    expect(ttsCacheVariant({ AI: env.AI })).toBe('melotts');
  });

  it('a cache hit answers from the stored clip and calls neither provider', async () => {
    // The two steps handleTts runs before it spends anything: build the key,
    // ask the cache. A hit returns here, which is why a repeated word is free.
    const stored = new Map<string, Response>();
    const variant = ttsCacheVariant(env);
    stored.set(
      ttsCacheKey('https://app.example/api/tts', '苹果', variant).url,
      new Response(new Uint8Array([4, 2]), { headers: { 'x-tts-voice': 'azure' } })
    );

    const ai = new FakeAi([new Error('melotts must not be reached')]);
    const azure = fakeAzure(() => new Response(new Uint8Array([9])));

    const key = ttsCacheKey('https://app.example/api/tts?text=%E8%8B%B9%E6%9E%9C', ' 苹果 ', variant);
    const hit = stored.get(key.url);

    let served = hit;
    if (!served) {
      served = (await synthesizeLadder({ AI: ai, ...AZURE_ENV }, '苹果', { fetchImpl: azure.fetch })).audio!;
    }

    expect(hit).toBeDefined();
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array([4, 2]));
    // The provider that recorded it is still reported on a hit.
    expect(served.headers.get('x-tts-voice')).toBe('azure');
    expect(ai.calls).toBe(0);
    expect(azure.calls).toHaveLength(0);
  });
});

// --- the enrich attempt plan (what its reservation has to cover) -------------

describe('enrichModelPlan', () => {
  it('tries the primary until one attempt is left, then the fallback', () => {
    expect(enrichModelPlan(3)).toEqual([PRIMARY_MODEL, PRIMARY_MODEL, FALLBACK_MODEL]);
    expect(enrichModelPlan(2)).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);
  });

  it('never plans more calls than the cap allows, and never fewer than one', () => {
    expect(enrichModelPlan(1)).toEqual([PRIMARY_MODEL]);
    expect(enrichModelPlan(0)).toEqual([PRIMARY_MODEL]);
    expect(enrichModelPlan(5)).toHaveLength(5);
  });
});

// --- CC-CEDICT -----------------------------------------------------------------
//
// The dictionary is the PRIMARY gloss source now, so its selection rules are
// pinned here rather than eyeballed in the generated asset. Every sample below
// is copied verbatim out of the real CC-CEDICT dump.

/** A CC-CEDICT slice big enough to exercise every selection rule. */
const CEDICT_SAMPLE = [
  '# CC-CEDICT',
  '#! version=1',
  // The proper-noun trap: the Apple entry is listed FIRST in the real dump.
  '蘋果 苹果 [Ping2 guo3] /Apple (American tech company)/',
  '蘋果 苹果 [ping2 guo3] /apple/CL:個|个[ge4],顆|颗[ke1]/',
  // A classifier note glued into a parenthetical.
  '貓 猫 [mao1] /cat (CL:隻|只[zhi1])/(dialect) to hide oneself/',
  '貓 猫 [mao2] /used in 貓腰|猫腰[mao2 yao1]/',
  // Register parentheticals, a `;` list, and a `sth` to expand.
  '高興 高兴 [gao1 xing4] /happy/glad/willing (to do sth)/in a cheerful mood/',
  // Surname sense skipped in favour of the next entry.
  '水 水 [Shui3] /surname Shui/',
  '水 水 [shui3] /water/(coll.) lacking in substance; shoddy/',
  // Proper noun with no common-word rival: still indexed, a class wants "China".
  '中國 中国 [Zhong1 guo2] /China/',
  // Nothing but redirects: dropped entirely.
  '麵 面 [mian4] /old variant of 麵|面[mian4]/',
  '衆 众 [zhong4] /variant of 眾|众[zhong4]/',
  // First sense over the 40-char cap with a short one available later.
  '死士 死士 [si3 shi4] /a person willing to sacrifice his life in a cause/martyr/',
  'x x [x] /a/',
].join('\n');

describe('CC-CEDICT sense cleaning', () => {
  it('strips a classifier note whether or not it is parenthesised', () => {
    expect(usableSenses(['cat (CL:隻|只[zhi1])'])).toEqual(['cat']);
    expect(usableSenses(['apple', 'CL:個|个[ge4],顆|颗[ke1]'])).toEqual(['apple']);
  });

  it('strips register parentheticals and expands sb/sth', () => {
    expect(usableSenses(['(coll.) lacking in substance; shoddy'])).toEqual([
      'lacking in substance',
      'shoddy',
    ]);
    expect(usableSenses(['willing (to do sth)'])).toEqual(['willing']);
    expect(usableSenses(['to tell sb sth'])).toEqual(['to tell someone something']);
  });

  it('skips redirect senses: variant of, see, abbr. for, surname, Taiwan pr.', () => {
    expect(usableSenses(['old variant of 麵|面[mian4]'])).toEqual([]);
    expect(usableSenses(['see 貓腰|猫腰[mao2 yao1]'])).toEqual([]);
    expect(usableSenses(['abbr. for 中國|中国[Zhong1 guo2]'])).toEqual([]);
    expect(usableSenses(['surname Shui', 'water'])).toEqual(['water']);
    expect(usableSenses(['Taiwan pr. [na2]'])).toEqual([]);
  });

  it('caps the gloss at 40 chars, preferring a shorter later sense', () => {
    const gloss = pickGloss(['a person willing to sacrifice his life in a cause', 'martyr']);
    expect(gloss).toBe('martyr');
    const truncated = pickGloss(['a person willing to sacrifice his life in a very long cause']);
    expect(truncated).not.toBeNull();
    expect((truncated as string).length).toBeLessThanOrEqual(40);
  });

  it('returns null when every sense is a redirect', () => {
    expect(pickGloss(['old variant of 麵|面[mian4]'])).toBeNull();
  });
});

describe('CC-CEDICT numbered pinyin to tone marks', () => {
  it('marks the standard vowel', () => {
    expect(toneMarks('ping2 guo3')).toBe('píng guǒ');
    expect(toneMarks('gao1 xing4')).toBe('gāo xìng');
    expect(toneMarks('Zhong1 guo2')).toBe('Zhōng guó');
  });

  it('marks the last vowel for iu/ui and leaves the neutral tone bare', () => {
    expect(toneMarks('liu4')).toBe('liù');
    expect(toneMarks('gui1')).toBe('guī');
    expect(toneMarks('ma5')).toBe('ma');
    expect(toneMarks('nu:3')).toBe('nǚ');
  });
});

describe('CC-CEDICT index building', () => {
  const asset = buildDict(CEDICT_SAMPLE.split('\n'));
  const dict = makeDict(asset);

  it('prefers the common word over the proper noun listed before it', () => {
    expect(asset.e['苹果']).toEqual(['píng guǒ', 'apple']);
  });

  it('prefers the entry with the most senses', () => {
    // 猫 [mao1] has two senses, [mao2] has one redirect and is unusable anyway.
    expect(asset.e['猫']).toEqual(['māo', 'cat']);
    expect(asset.e['水']).toEqual(['shuǐ', 'water']);
  });

  it('keeps a proper noun that has no common-word rival', () => {
    expect(asset.e['中国']).toEqual(['Zhōng guó', 'China']);
  });

  it('drops a headword whose only senses are redirects', () => {
    expect(asset.e['面']).toBeUndefined();
    expect(asset.e['众']).toBeUndefined();
  });

  it('indexes traditional headwords that differ from the simplified form', () => {
    expect(asset.e['蘋果']).toEqual(['píng guǒ', 'apple']);
    expect(asset.e['貓']).toEqual(['māo', 'cat']);
    expect(asset.e['中國']).toEqual(['Zhōng guó', 'China']);
    // Same in both scripts, so exactly one key, not two.
    expect(asset.e['水']).toEqual(['shuǐ', 'water']);
  });

  it('looks a word up after NFKC normalisation and trimming', () => {
    expect(dict.lookup(' 苹果 ')).toEqual({ pinyin: 'píng guǒ', en: 'apple' });
    expect(dict.lookup('苹果')).toEqual({ pinyin: 'píng guǒ', en: 'apple' });
    expect(dict.lookup('')).toBeNull();
    expect(dict.lookup('不在词典里')).toBeNull();
  });

  it('refuses an asset of the wrong shape instead of guessing', () => {
    expect(makeDict(null).size).toBe(0);
    expect(makeDict({ v: 2, e: { 苹果: ['a', 'b'] } }).lookup('苹果')).toBeNull();
    expect(makeDict({ v: 1, e: { 苹果: ['a'] } }).lookup('苹果')).toBeNull();
  });
});

// --- enrich ordering: cache, then dictionary, then AI ------------------------

/** A Workers AI binding that is out of daily budget, as it was on 2026-09-07. */
function aiOutOfBudget(): { AI: { run: () => Promise<never> }; ASSETS: never } {
  return {
    AI: {
      run: () =>
        Promise.reject(
          new Error('AiError: 4006: Free allocation of 10,000 neurons exceeded for the day.')
        ),
    },
  } as unknown as { AI: { run: () => Promise<never> }; ASSETS: never };
}

const SAMPLE_DICT: GlossLookup = makeDict(buildDict(CEDICT_SAMPLE.split('\n')));

describe('enrich source order', () => {
  it('fills from the dictionary and never calls the model', async () => {
    let calls = 0;
    const env = {
      AI: {
        run: async () => {
          calls++;
          return '[]';
        },
      },
    } as never;
    const result = await enrichItems(
      env,
      [{ zh: '苹果' }, { zh: '高兴' }, { zh: '猫' }],
      3,
      { dict: SAMPLE_DICT }
    );
    expect(result.items).toEqual([
      { zh: '苹果', en: 'apple' },
      { zh: '高兴', en: 'happy' },
      { zh: '猫', en: 'cat' },
    ]);
    // The whole point: no paid call, so nothing to charge the daily budget.
    expect(result.attempts).toBe(0);
    expect(calls).toBe(0);
    expect(result.warning).toBeUndefined();
  });

  it("never overwrites a gloss the cache or the teacher already supplied", async () => {
    const result = await enrichItems(
      {} as never,
      [{ zh: '苹果', en: 'the red fruit' }],
      3,
      { dict: SAMPLE_DICT }
    );
    expect(result.items).toEqual([{ zh: '苹果', en: 'the red fruit' }]);
    expect(result.attempts).toBe(0);
  });

  it('still fills the dictionary words when Workers AI is out of budget (4006)', async () => {
    const result = await enrichItems(
      aiOutOfBudget() as never,
      [{ zh: '苹果' }, { zh: '不在词典里' }, { zh: '高兴' }],
      3,
      { dict: SAMPLE_DICT }
    );
    expect(result.items).toEqual([
      { zh: '苹果', en: 'apple' },
      { zh: '不在词典里', en: '' },
      { zh: '高兴', en: 'happy' },
    ]);
    expect(result.warning).toBe(
      'The AI helper has used up its daily budget. 2 words were filled from the dictionary; please type the rest.'
    );
    expect(result.warning).toBe(aiUnavailableWarning(2));
    // It tried the whole plan before giving up, and reports it so the caller
    // refunds nothing it actually spent.
    expect(result.attempts).toBe(3);
  });

  it('says nothing when 4006 leaves no blanks behind', async () => {
    const result = await enrichItems(aiOutOfBudget() as never, [{ zh: '苹果' }], 3, {
      dict: SAMPLE_DICT,
    });
    expect(result.items).toEqual([{ zh: '苹果', en: 'apple' }]);
    expect(result.warning).toBeUndefined();
    expect(result.attempts).toBe(0);
  });

  it('fillFromDict reports what it filled and skips what it could not', () => {
    const items = [
      { zh: '苹果', en: '' },
      { zh: '不在词典里', en: '' },
      { zh: '高兴', en: 'glad already' },
    ];
    expect(fillFromDict(items, SAMPLE_DICT)).toBe(1);
    expect(items).toEqual([
      { zh: '苹果', en: 'apple' },
      { zh: '不在词典里', en: '' },
      { zh: '高兴', en: 'glad already' },
    ]);
    expect(fillFromDict(items, null)).toBe(0);
  });
});

// --- gloss parsing -----------------------------------------------------------

describe('parseGlossArray', () => {
  it('parses a plain JSON array', () => {
    expect(parseGlossArray('[{"zh":"苹果","en":"apple"}]')).toEqual([{ zh: '苹果', en: 'apple' }]);
  });

  it('strips a ```json code fence', () => {
    const raw = '```json\n[{"zh":"苹果","en":"apple"},{"zh":"香蕉","en":"banana"}]\n```';
    expect(parseGlossArray(raw)).toHaveLength(2);
  });

  it('tolerates chatter before and after the array', () => {
    const raw = 'Sure! Here you go:\n[{"zh":"猫","en":"cat"}]\nHope that helps.';
    expect(parseGlossArray(raw)).toEqual([{ zh: '猫', en: 'cat' }]);
  });

  it('trims whitespace and drops entries with no zh', () => {
    const raw = '[{"zh":"  狗 ","en":" dog "},{"en":"orphan"},{"zh":"鸟","en":"bird"}]';
    expect(parseGlossArray(raw)).toEqual([
      { zh: '狗', en: 'dog' },
      { zh: '鸟', en: 'bird' },
    ]);
  });

  it('returns an empty array for junk instead of throwing', () => {
    expect(parseGlossArray('no json at all')).toEqual([]);
    expect(parseGlossArray('[{"zh": broken}]')).toEqual([]);
    expect(parseGlossArray('{"zh":"苹果","en":"apple"}')).toEqual([]);
    expect(parseGlossArray(null)).toEqual([]);
    expect(parseGlossArray(undefined)).toEqual([]);
    expect(parseGlossArray(42)).toEqual([]);
  });

  it('keeps an entry whose gloss came back blank, so the caller can see it failed', () => {
    expect(parseGlossArray('[{"zh":"苹果","en":""}]')).toEqual([{ zh: '苹果', en: '' }]);
  });

  it('accepts an already-parsed array, which is what Workers AI actually returned live', () => {
    // Verified 2026-09-07: the chat-completion object's `response` field came
    // back as a real array, not a JSON string.
    expect(parseGlossArray([{ zh: '苹果', en: 'apple' }])).toEqual([{ zh: '苹果', en: 'apple' }]);
    expect(parseGlossArray([{ zh: '狗', en: 'dog' }, 'junk', null, { en: 'no zh' }])).toEqual([
      { zh: '狗', en: 'dog' },
    ]);
    expect(parseGlossArray([])).toEqual([]);
  });
});

// --- request validation ------------------------------------------------------

describe('containsCjk', () => {
  it('is true for any text holding a Chinese character', () => {
    expect(containsCjk('苹果')).toBe(true);
    expect(containsCjk('apple 苹果')).toBe(true);
    expect(containsCjk('苹')).toBe(true);
  });

  it('is false for text with no Chinese character at all', () => {
    expect(containsCjk('apple')).toBe(false);
    expect(containsCjk('translate this document for me please')).toBe(false);
    expect(containsCjk('123')).toBe(false);
    expect(containsCjk('')).toBe(false);
    expect(containsCjk('こんにちは')).toBe(false); // kana only, no ideographs
  });
});

describe('validateEnrichItems', () => {
  const MAX = DEFAULT_POLICY.maxEnrichItems;

  it('accepts a normal batch', () => {
    expect(validateEnrichItems([{ zh: '苹果' }, { zh: '香蕉', en: 'banana' }], MAX)).toBeNull();
  });

  it('rejects a non-array, an empty list, and an oversized batch', () => {
    expect(validateEnrichItems('nope', MAX)).toContain('array');
    expect(validateEnrichItems([], MAX)).toContain('empty');
    const tooMany = Array.from({ length: MAX + 1 }, () => ({ zh: '字' }));
    expect(validateEnrichItems(tooMany, MAX)).toContain(`${MAX}`);
  });

  it('takes its item cap from the caller, so policy drives it', () => {
    const five = Array.from({ length: 5 }, () => ({ zh: '字' }));
    expect(validateEnrichItems(five, 5)).toBeNull();
    expect(validateEnrichItems(five, 4)).toContain('at most 4');
  });

  it('rejects an item with no zh or a wrongly typed en', () => {
    expect(validateEnrichItems([{ en: 'apple' }], MAX)).toContain('zh');
    expect(validateEnrichItems([{ zh: '苹果', en: 5 }], MAX)).toContain('en');
  });

  it('rejects a word with no Chinese in it, so the route is not a free translator', () => {
    expect(validateEnrichItems([{ zh: 'apple' }], MAX)).toBe('every word must be Chinese');
    expect(validateEnrichItems([{ zh: '苹果' }, { zh: 'summarize this' }], MAX)).toBe(
      'every word must be Chinese'
    );
    // Mixed text still counts: a teacher may paste "苹果 (fruit)".
    expect(validateEnrichItems([{ zh: '苹果 (fruit)' }], MAX)).toBeNull();
  });
});

describe('validateSet', () => {
  it('accepts a well-formed set', () => {
    expect(validateSet(makeSet(3))).toBeNull();
  });

  it('rejects the wrong version, a bad level, and an empty item list', () => {
    expect(validateSet({ ...makeSet(1), v: 2 })).toContain('v must be 1');
    expect(validateSet({ ...makeSet(1), level: 'grown-ups' })).toContain('level');
    expect(validateSet({ ...makeSet(1), items: [] })).toContain('empty');
  });

  it('rejects a set past the item cap', () => {
    expect(validateSet(makeSet(MAX_SET_ITEMS + 1))).toContain(`${MAX_SET_ITEMS}`);
    expect(validateSet(makeSet(MAX_SET_ITEMS))).toBeNull();
  });

  it('rejects an item missing a field', () => {
    const set = makeSet(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (set.items[1] as any).zh = '';
    expect(validateSet(set)).toContain('zh');
  });
});

describe('validateQuestions', () => {
  const set = makeSet(5);
  const questions = buildQuestions(set, { seed: 7 });

  it('accepts questions built by the generator', () => {
    expect(validateQuestions(questions, set)).toBeNull();
  });

  it('rejects an answer index outside the choices', () => {
    const broken = questions.map((q, i) => (i === 0 ? { ...q, answer: 99 } : q));
    expect(validateQuestions(broken, set)).toContain('answer');
  });

  it('rejects a bad direction and a single-choice question', () => {
    expect(validateQuestions([{ ...questions[0], dir: 'zh2zh' }], set)).toContain('dir');
    expect(
      validateQuestions([{ ...questions[0], choices: ['only'], answer: 0 }], set)
    ).toContain('choices');
  });

  it('rejects a non-array and an empty list', () => {
    expect(validateQuestions({}, set)).toContain('array');
    expect(validateQuestions([], set)).toContain('empty');
  });

  it('rejects an itemId longer than the id cap (the 400 MB body hole)', () => {
    const huge = questions.map((q, i) => (i === 0 ? { ...q, itemId: 'x'.repeat(1_000_000) } : q));
    expect(validateQuestions(huge, set)).toContain(`${MAX_ID_CHARS}`);

    const justOver = questions.map((q, i) =>
      i === 0 ? { ...q, itemId: 'x'.repeat(MAX_ID_CHARS + 1) } : q
    );
    expect(validateQuestions(justOver, set)).toContain(`${MAX_ID_CHARS}`);
  });

  it('rejects a question that points at an item the set does not contain', () => {
    const orphan = questions.map((q, i) => (i === 0 ? { ...q, itemId: 'nope' } : q));
    expect(validateQuestions(orphan, set)).toContain('item in the set');
  });

  it('rejects a NaN, infinite, negative, or out-of-order index', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 99]) {
      const broken = questions.map((q, i) => (i === 0 ? { ...q, index: bad } : q));
      expect(validateQuestions(broken, set)).toContain('index');
    }
    // Same questions, shuffled: every index is a valid number but the order is wrong.
    const swapped = [questions[1], questions[0], ...questions.slice(2)];
    expect(validateQuestions(swapped, set)).toContain('index');
  });

  it('rejects an answer label that is not the right word for that item', () => {
    const q = questions[0];
    const item = set.items.find((it) => it.id === q.itemId)!;
    const correctLabel = q.dir === 'zh2en' ? item.en : item.zh;
    // Keep the shape legal, just point `answer` at a distractor.
    const wrongIndex = q.choices.findIndex((c) => c !== correctLabel);
    const lying = questions.map((each, i) => (i === 0 ? { ...each, answer: wrongIndex } : each));
    expect(validateQuestions(lying, set)).toContain('right word');
  });

  it('rejects duplicate choice labels in one question', () => {
    const q = questions[0];
    const dupes = [...q.choices];
    dupes[(q.answer + 1) % dupes.length] = dupes[q.answer];
    const broken = questions.map((each, i) => (i === 0 ? { ...each, choices: dupes } : each));
    expect(validateQuestions(broken, set)).toContain('repeat');
  });

  it('rejects more than four choices', () => {
    const q = questions[0];
    const five = [...q.choices, 'extra1', 'extra2'].slice(0, 5);
    const broken = questions.map((each, i) => (i === 0 ? { ...each, choices: five } : each));
    expect(validateQuestions(broken, set)).toContain('2 to 4');
  });
});

// --- policy ------------------------------------------------------------------

describe('readPolicy', () => {
  it('uses the documented defaults when nothing is configured', () => {
    expect(readPolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(readPolicy({})).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY).toEqual({
      enrichPerIpPerDay: 30,
      enrichGlobalPerDay: 600,
      enrichMaxAttempts: 3,
      ttsMaxAttempts: 3,
      ttsPerIpPerDay: 300,
      ttsGlobalPerDay: 4000,
      ocrPerIpPerDay: 20,
      ocrGlobalPerDay: 300,
      ocrMaxBytes: 4194304,
      ocrTimeoutMs: 20000,
      sheetMaxBytes: 524288,
      sheetTimeoutMs: 20000,
      maxEnrichItems: 40,
      maxBodyBytes: 262144,
      glossCacheDays: 30,
      maxGlossEntries: 50_000,
      roomMaxPlayersTeacher: 40,
    });
  });

  it('takes an override as a number (wrangler.jsonc) or a string (--var)', () => {
    expect(readPolicy({ [POLICY_VARS.enrichPerIpPerDay]: 2 }).enrichPerIpPerDay).toBe(2);
    expect(readPolicy({ [POLICY_VARS.enrichPerIpPerDay]: '2' }).enrichPerIpPerDay).toBe(2);
    expect(readPolicy({ [POLICY_VARS.ttsGlobalPerDay]: ' 7 ' }).ttsGlobalPerDay).toBe(7);
  });

  it('keeps the default when a var is junk, so a typo cannot switch a cap off', () => {
    for (const junk of ['abc', '0', '-5', '1.5', '']) {
      expect(readPolicy({ [POLICY_VARS.enrichPerIpPerDay]: junk }).enrichPerIpPerDay).toBe(
        DEFAULT_POLICY.enrichPerIpPerDay
      );
    }
  });

  it('leaves the other fields alone when one is overridden', () => {
    const policy = readPolicy({ [POLICY_VARS.maxEnrichItems]: 5 });
    expect(policy.maxEnrichItems).toBe(5);
    expect(policy.maxBodyBytes).toBe(DEFAULT_POLICY.maxBodyBytes);
  });
});

// --- quota counters and the gloss cache --------------------------------------

describe('quota counters', () => {
  const DAY1 = Date.UTC(2026, 8, 7, 10, 0, 0);
  const LIMITS = { perIpPerDay: 3, globalPerDay: 5 };

  it('counts per IP and refuses the call past the per-IP budget', async () => {
    const storage = new FakeQuotaStorage();
    const args = { bucket: 'enrich' as const, ip: '1.2.3.4', count: 1, ...LIMITS, now: DAY1 };

    for (let i = 0; i < 3; i++) {
      expect((await consume(storage, args)).allowed).toBe(true);
    }
    const refused = await consume(storage, args);
    expect(refused.allowed).toBe(false);
    expect(refused.scope).toBe('ip');
    expect(refused.ipRemaining).toBe(0);
  });

  it('does not charge a refused call, so being over does not eat tomorrow', async () => {
    const storage = new FakeQuotaStorage();
    const args = { bucket: 'enrich' as const, ip: '1.2.3.4', count: 3, ...LIMITS, now: DAY1 };
    expect((await consume(storage, args)).allowed).toBe(true);
    expect((await consume(storage, args)).allowed).toBe(false);
    expect(await usage(storage, 'enrich', '1.2.3.4', DAY1)).toEqual({ ip: 3, global: 3 });
  });

  it('keeps each IP separate but shares the global budget', async () => {
    const storage = new FakeQuotaStorage();
    const base = { bucket: 'enrich' as const, count: 1, ...LIMITS, now: DAY1 };

    for (let i = 0; i < 3; i++) {
      expect((await consume(storage, { ...base, ip: 'a' })).allowed).toBe(true);
    }
    // A fresh IP has its own per-IP budget, but only 2 remain globally.
    expect((await consume(storage, { ...base, ip: 'b' })).allowed).toBe(true);
    expect((await consume(storage, { ...base, ip: 'b' })).allowed).toBe(true);

    const refused = await consume(storage, { ...base, ip: 'b' });
    expect(refused.allowed).toBe(false);
    expect(refused.scope).toBe('global');
  });

  it('keeps the two AI routes on separate budgets', async () => {
    const storage = new FakeQuotaStorage();
    const base = { ip: '1.2.3.4', count: 3, ...LIMITS, now: DAY1 };
    expect((await consume(storage, { ...base, bucket: 'enrich' })).allowed).toBe(true);
    expect((await consume(storage, { ...base, bucket: 'enrich' })).allowed).toBe(false);
    expect((await consume(storage, { ...base, bucket: 'tts' })).allowed).toBe(true);
  });

  it('resets at UTC midnight and drops the old day rather than piling up keys', async () => {
    const storage = new FakeQuotaStorage();
    const args = { bucket: 'enrich' as const, ip: '1.2.3.4', count: 3, ...LIMITS, now: DAY1 };
    expect((await consume(storage, args)).allowed).toBe(true);
    expect((await consume(storage, args)).allowed).toBe(false);

    const nextDay = DAY1 + 24 * 60 * 60 * 1000;
    expect(utcDayKey(nextDay)).not.toBe(utcDayKey(DAY1));
    expect((await consume(storage, { ...args, now: nextDay })).allowed).toBe(true);

    const counters = storage.keys().filter((k) => k.startsWith('c:'));
    expect(counters.every((k) => k.includes(utcDayKey(nextDay)))).toBe(true);
  });

  it('the same UTC day just before and after local midnight is one budget', async () => {
    const storage = new FakeQuotaStorage();
    const early = Date.UTC(2026, 8, 7, 0, 30, 0);
    const late = Date.UTC(2026, 8, 7, 23, 30, 0);
    const args = { bucket: 'tts' as const, ip: 'x', count: 3, ...LIMITS };
    expect((await consume(storage, { ...args, now: early })).allowed).toBe(true);
    expect((await consume(storage, { ...args, now: late })).allowed).toBe(false);
  });
});

// --- reserve and refund (codex r2, must-fix 1) -------------------------------
//
// The cap has to be a cap on PAID AI CALLS, not on requests: one accepted
// /api/enrich request can make three model calls. The route reserves the worst
// case up front and gives back what it did not use.

describe('reserving the worst case and refunding the rest', () => {
  const DAY1 = Date.UTC(2026, 8, 7, 10, 0, 0);
  const LIMITS = { perIpPerDay: 9, globalPerDay: 20 };

  it('a normal single-attempt call still costs exactly 1', async () => {
    const storage = new FakeQuotaStorage();
    const reserved = await consume(storage, {
      bucket: 'tts',
      ip: '1.2.3.4',
      count: 3,
      ...LIMITS,
      now: DAY1,
    });
    expect(reserved.allowed).toBe(true);
    expect(await usage(storage, 'tts', '1.2.3.4', DAY1)).toEqual({ ip: 3, global: 3 });

    // The synthesis succeeded first try, so two of the three go back.
    const given = await refund(storage, {
      bucket: 'tts',
      ip: '1.2.3.4',
      count: 2,
      day: reserved.day,
      now: DAY1,
    });

    expect(given.refunded).toBe(2);
    expect(await usage(storage, 'tts', '1.2.3.4', DAY1)).toEqual({ ip: 1, global: 1 });
  });

  it('a request that burns every retry keeps paying for every retry', async () => {
    const storage = new FakeQuotaStorage();
    const reserved = await consume(storage, {
      bucket: 'enrich',
      ip: 'a',
      count: 3,
      ...LIMITS,
      now: DAY1,
    });
    // Nothing unused, so nothing refunded.
    const given = await refund(storage, {
      bucket: 'enrich',
      ip: 'a',
      count: 0,
      day: reserved.day,
      now: DAY1,
    });
    expect(given.refunded).toBe(0);
    expect(await usage(storage, 'enrich', 'a', DAY1)).toEqual({ ip: 3, global: 3 });
  });

  it('the reservation, not the request count, is what runs the budget out', async () => {
    const storage = new FakeQuotaStorage();
    const args = { bucket: 'enrich' as const, ip: 'a', count: 3, ...LIMITS, now: DAY1 };

    // Three worst-case reservations fill a 9-call per-IP budget.
    for (let i = 0; i < 3; i++) expect((await consume(storage, args)).allowed).toBe(true);

    const refused = await consume(storage, args);
    expect(refused.allowed).toBe(false);
    expect(refused.scope).toBe('ip');
    // Refunding one call's worth reopens exactly that much room, no more.
    await refund(storage, {
      bucket: 'enrich',
      ip: 'a',
      count: 3,
      day: utcDayKey(DAY1),
      now: DAY1,
    });
    expect((await consume(storage, args)).allowed).toBe(true);
    expect((await consume(storage, args)).allowed).toBe(false);
  });

  it('refunds the per-IP and the global counter by the same amount', async () => {
    const storage = new FakeQuotaStorage();
    await consume(storage, { bucket: 'tts', ip: 'a', count: 3, ...LIMITS, now: DAY1 });
    await consume(storage, { bucket: 'tts', ip: 'b', count: 3, ...LIMITS, now: DAY1 });

    await refund(storage, { bucket: 'tts', ip: 'a', count: 2, day: utcDayKey(DAY1), now: DAY1 });

    expect(await usage(storage, 'tts', 'a', DAY1)).toEqual({ ip: 1, global: 4 });
    expect(await usage(storage, 'tts', 'b', DAY1)).toEqual({ ip: 3, global: 4 });
  });

  it('never drives a counter below zero, however big the refund claims to be', async () => {
    const storage = new FakeQuotaStorage();
    await consume(storage, { bucket: 'tts', ip: 'a', count: 2, ...LIMITS, now: DAY1 });

    const given = await refund(storage, {
      bucket: 'tts',
      ip: 'a',
      count: 99,
      day: utcDayKey(DAY1),
      now: DAY1,
    });

    expect(given.refunded).toBe(2);
    expect(await usage(storage, 'tts', 'a', DAY1)).toEqual({ ip: 0, global: 0 });
  });

  it('drops a refund that would cross UTC midnight instead of handing out free budget', async () => {
    const storage = new FakeQuotaStorage();
    const reserved = await consume(storage, {
      bucket: 'tts',
      ip: 'a',
      count: 3,
      ...LIMITS,
      now: DAY1,
    });
    const nextDay = DAY1 + 24 * 60 * 60 * 1000;
    await consume(storage, { bucket: 'tts', ip: 'a', count: 3, ...LIMITS, now: nextDay });

    const given = await refund(storage, {
      bucket: 'tts',
      ip: 'a',
      count: 2,
      day: reserved.day,
      now: nextDay,
    });

    expect(given.refunded).toBe(0);
    expect(await usage(storage, 'tts', 'a', nextDay)).toEqual({ ip: 3, global: 3 });
  });

  it('a refund never creates a new day\'s counters on its own', async () => {
    const storage = new FakeQuotaStorage();
    const given = await refund(storage, {
      bucket: 'tts',
      ip: 'a',
      count: 3,
      day: utcDayKey(DAY1),
      now: DAY1,
    });
    expect(given.refunded).toBe(0);
    expect(storage.keys().filter((k) => k.startsWith('c:'))).toEqual([]);
  });

  it('reports the day it charged, which is what the refund is scoped to', async () => {
    const storage = new FakeQuotaStorage();
    const result = await consume(storage, {
      bucket: 'enrich',
      ip: 'a',
      count: 1,
      ...LIMITS,
      now: DAY1,
    });
    expect(result.day).toBe(utcDayKey(DAY1));
  });
});

// --- QuotaDO body validation (codex r2, should-fix 5) ------------------------

describe('quota request validation', () => {
  const NOW = Date.UTC(2026, 8, 7, 10, 0, 0);
  const GOOD = { bucket: 'enrich', ip: '1.2.3.4', count: 1, perIpPerDay: 30, globalPerDay: 600 };

  it('accepts a well-formed consume body', () => {
    const parsed = parseConsumeRequest(GOOD, NOW);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ ...GOOD, now: NOW });
  });

  it('refuses a negative, zero, fractional, or absurd count before anything is charged', () => {
    for (const count of [-5, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
      expect(parseConsumeRequest({ ...GOOD, count }, NOW).ok).toBe(false);
    }
    expect(parseConsumeRequest({ ...GOOD, count: MAX_CONSUME_COUNT + 1 }, NOW).ok).toBe(false);
    expect(parseConsumeRequest({ ...GOOD, count: MAX_CONSUME_COUNT }, NOW).ok).toBe(true);
  });

  it('refuses a limit that is not a positive integer, so a bad caller cannot widen the cap', () => {
    for (const bad of [0, -1, 2.5, '30', null, undefined]) {
      expect(parseConsumeRequest({ ...GOOD, perIpPerDay: bad }, NOW).ok).toBe(false);
      expect(parseConsumeRequest({ ...GOOD, globalPerDay: bad }, NOW).ok).toBe(false);
    }
  });

  it('refuses an unknown bucket, and a body that is not an object', () => {
    expect(parseConsumeRequest({ ...GOOD, bucket: 'images' }, NOW).ok).toBe(false);
    expect(parseConsumeRequest(null, NOW).ok).toBe(false);
    expect(parseConsumeRequest('consume', NOW).ok).toBe(false);
    expect(parseUsageRequest({ bucket: 'nope' }).ok).toBe(false);
  });

  it('folds an unusable IP into one shared bucket rather than rejecting the call', () => {
    for (const ip of [undefined, '', '   ', 42]) {
      const parsed = parseConsumeRequest({ ...GOOD, ip }, NOW);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.ip).toBe('unknown');
    }
  });

  it('requires a real YYYY-MM-DD day on a refund', () => {
    const base = { bucket: 'tts', ip: 'a', count: 2 };
    expect(parseRefundRequest({ ...base, day: '2026-09-07' }, NOW).ok).toBe(true);
    for (const day of [undefined, '', 'yesterday', '2026-9-7', 20260907]) {
      expect(parseRefundRequest({ ...base, day }, NOW).ok).toBe(false);
    }
  });

  it('refuses a refund with a bad count, which would otherwise mint budget', () => {
    const base = { bucket: 'tts', ip: 'a', day: '2026-09-07' };
    for (const count of [-1, 0, 2.5, '2', MAX_CONSUME_COUNT + 1]) {
      expect(parseRefundRequest({ ...base, count }, NOW).ok).toBe(false);
    }
  });
});

describe('gloss cache', () => {
  const NOW_MS = Date.UTC(2026, 8, 7, 10, 0, 0);
  const TTL = 30 * 24 * 60 * 60 * 1000;

  it('returns a stored gloss so a repeated word costs no model call', async () => {
    const storage = new FakeQuotaStorage();
    await putGlosses(storage, [{ zh: '苹果', en: 'apple' }], NOW_MS, TTL);
    expect(await getGlosses(storage, ['苹果', '香蕉'], NOW_MS)).toEqual({ 苹果: 'apple' });
  });

  it('matches on the normalized word, so spacing does not miss the cache', async () => {
    const storage = new FakeQuotaStorage();
    expect(normalizeText(' 苹  果 ')).toBe('苹 果');
    await putGlosses(storage, [{ zh: '苹 果', en: 'apple' }], NOW_MS, TTL);
    expect(await getGlosses(storage, [' 苹  果 '], NOW_MS)).toEqual({ ' 苹  果 ': 'apple' });
  });

  it('does not cache a blank gloss (that is a failure, not an answer)', async () => {
    const storage = new FakeQuotaStorage();
    await putGlosses(storage, [{ zh: '苹果', en: '   ' }], NOW_MS, TTL);
    expect(await getGlosses(storage, ['苹果'], NOW_MS)).toEqual({});
  });

  it('expires an entry after the TTL and deletes it on the way past', async () => {
    const storage = new FakeQuotaStorage();
    await putGlosses(storage, [{ zh: '苹果', en: 'apple' }], NOW_MS, TTL);
    expect(await getGlosses(storage, ['苹果'], NOW_MS + TTL - 1)).toEqual({ 苹果: 'apple' });
    expect(await getGlosses(storage, ['苹果'], NOW_MS + TTL)).toEqual({});
    expect(storage.keys().filter((k) => k.startsWith('g:'))).toEqual([]);
  });

  it('refreshes an existing word without adding a second entry', async () => {
    const storage = new FakeQuotaStorage();
    await putGlosses(storage, [{ zh: '苹果', en: 'apple' }], NOW_MS, TTL, 10);
    await putGlosses(storage, [{ zh: '苹果', en: 'apple fruit' }], NOW_MS + 1000, TTL, 10);
    expect(await getGlosses(storage, ['苹果'], NOW_MS + 1000)).toEqual({ 苹果: 'apple fruit' });
    expect(storage.keys().filter((k) => k.startsWith('gi:'))).toHaveLength(1);
    expect(await storage.get('glossCount')).toBe(1);
  });

  // The bug this replaces: eviction deleted only EXPIRED entries, so a full
  // cache of 30-day glosses freed nothing, the stored count stayed above the
  // cap forever, and every later write paid for a full scan of the whole cache.
  it('evicts the oldest words once the cap is reached, and never exceeds it', async () => {
    const storage = new FakeQuotaStorage();
    const CAP = 12;
    const word = (i: number) => `词${i}`;

    for (let i = 0; i < CAP + 3; i++) {
      await putGlosses(storage, [{ zh: word(i), en: `gloss ${i}` }], NOW_MS + i, TTL, CAP);
      expect(await storage.get('glossCount')).toBeLessThanOrEqual(CAP);
      expect(storage.keys().filter((k) => k.startsWith('g:'))).toHaveLength(
        Math.min(i + 1, CAP)
      );
    }

    // The three oldest are gone; everything after them survived.
    const found = await getGlosses(
      storage,
      Array.from({ length: CAP + 3 }, (_, i) => word(i)),
      NOW_MS
    );
    expect(Object.keys(found)).toEqual(Array.from({ length: CAP }, (_, i) => word(i + 3)));
    // The index does not leak rows: one per live entry.
    expect(storage.keys().filter((k) => k.startsWith('gi:'))).toHaveLength(CAP);
  });

  it('does not scan the whole cache on a write, which is what made it O(n)', async () => {
    const storage = new FakeQuotaStorage();
    const CAP = 40;
    for (let i = 0; i < CAP; i++) {
      await putGlosses(storage, [{ zh: `词${i}`, en: `gloss ${i}` }], NOW_MS, TTL, CAP);
    }
    // Fill-up phase costs no listing at all.
    expect(storage.listCalls).toBe(0);

    for (let i = 0; i < 5; i++) {
      await putGlosses(storage, [{ zh: `新${i}`, en: `new ${i}` }], NOW_MS, TTL, CAP);
    }
    // Five writes past a full cache: five bounded lookups of one row each, not
    // five scans of forty keys.
    expect(storage.listedKeys).toBe(5);
    expect(await storage.get('glossCount')).toBe(CAP);
  });

  it('reclaims the count for an entry that expired away before eviction saw it', async () => {
    const storage = new FakeQuotaStorage();
    const CAP = 3;
    await putGlosses(storage, [{ zh: '过期', en: 'stale' }], NOW_MS, 1000, CAP);
    await putGlosses(storage, [{ zh: '甲', en: 'a' }], NOW_MS, TTL, CAP);
    await putGlosses(storage, [{ zh: '乙', en: 'b' }], NOW_MS, TTL, CAP);
    // Read past the TTL: the expired entry is deleted, its index row is not.
    expect(await getGlosses(storage, ['过期'], NOW_MS + 2000)).toEqual({});

    await putGlosses(storage, [{ zh: '丙', en: 'c' }], NOW_MS + 2000, TTL, CAP);
    expect(await storage.get('glossCount')).toBeLessThanOrEqual(CAP);
    expect(storage.keys().filter((k) => k.startsWith('g:')).length).toBeLessThanOrEqual(CAP);
    expect(await getGlosses(storage, ['甲', '乙', '丙'], NOW_MS + 2000)).toEqual({
      甲: 'a',
      乙: 'b',
      丙: 'c',
    });
  });

  it('does not let a pre-index count pin the cache at its cap with nothing to drop', async () => {
    const storage = new FakeQuotaStorage();
    const CAP = 5;
    // A store written before the index existed: a count, no sequence, no rows.
    await storage.put('glossCount', 4000);
    await putGlosses(storage, [{ zh: '苹果', en: 'apple' }], NOW_MS, TTL, CAP);
    // The migration recounts from what is actually there, so eviction still
    // has something to evict when the cap is next reached.
    expect(await storage.get('glossCount')).toBe(1);
    expect(await getGlosses(storage, ['苹果'], NOW_MS)).toEqual({ 苹果: 'apple' });
  });

  // The bug this replaces: an entry that expired on a read left its index row
  // behind and its count uncollected. With the corpse NEWER than live entries
  // the two errors did not cancel, and the next write evicted a live gloss to
  // pay for a row that was already dead.
  it('retires the row and the count together when an entry expires on read', async () => {
    const storage = new FakeQuotaStorage();
    const CAP = 3;
    await putGlosses(storage, [{ zh: '甲', en: 'a' }], NOW_MS, TTL, CAP);
    await putGlosses(storage, [{ zh: '乙', en: 'b' }], NOW_MS, TTL, CAP);
    await putGlosses(storage, [{ zh: '短命', en: 'brief' }], NOW_MS, 1000, CAP);
    expect(await storage.get('glossCount')).toBe(3);

    // Read the newest entry past its TTL: entry, index row and count all go.
    expect(await getGlosses(storage, ['短命'], NOW_MS + 2000)).toEqual({});
    expect(await storage.get('glossCount')).toBe(2);
    expect(storage.keys().filter((k) => k.startsWith('gi:'))).toHaveLength(2);
    expect(storage.keys().filter((k) => k.startsWith('g:'))).toHaveLength(2);

    // The cache now has room for one more, so nothing should be evicted.
    await putGlosses(storage, [{ zh: '丙', en: 'c' }], NOW_MS + 2000, TTL, CAP);
    expect(await storage.get('glossCount')).toBe(3);
    expect(await getGlosses(storage, ['甲', '乙', '丙'], NOW_MS + 2000)).toEqual({
      甲: 'a',
      乙: 'b',
      丙: 'c',
    });

    // One past the cap evicts exactly one, and it is the oldest live entry.
    await putGlosses(storage, [{ zh: '丁', en: 'd' }], NOW_MS + 3000, TTL, CAP);
    expect(await storage.get('glossCount')).toBe(3);
    expect(await getGlosses(storage, ['甲', '乙', '丙', '丁'], NOW_MS + 3000)).toEqual({
      乙: 'b',
      丙: 'c',
      丁: 'd',
    });
    expect(storage.keys().filter((k) => k.startsWith('gi:'))).toHaveLength(3);
  });

  // The bug this replaces: a store written before the index existed kept its
  // old `g:` rows unindexed and uncounted, so eviction could never reach them.
  // They lived in the cache forever and the cap was not a real ceiling.
  it('migrates a pre-index store once, dropping the dead and indexing the live', async () => {
    const storage = new FakeQuotaStorage();
    const CAP = 3;
    // Written by the old code: no `seq` on any record, no `gi:` rows, a count.
    await storage.put('g:甲', { en: 'a', exp: NOW_MS + TTL });
    await storage.put('g:乙', { en: 'b', exp: NOW_MS + TTL });
    await storage.put('g:过期', { en: 'stale', exp: NOW_MS - 1 });
    await storage.put('g:空', { en: '   ', exp: NOW_MS + TTL });
    await storage.put('g:坏', { garbage: true });
    await storage.put('glossCount', 5);

    await putGlosses(storage, [{ zh: '丙', en: 'c' }], NOW_MS, TTL, CAP);

    // Expired, blank and malformed rows are gone; the two live ones survived.
    expect(storage.keys().filter((k) => k.startsWith('g:'))).toEqual(['g:丙', 'g:乙', 'g:甲'].sort());
    // Exact count and seq, not the stale 5.
    expect(await storage.get('glossCount')).toBe(3);
    expect(await storage.get('glossSeq')).toBe(3);
    expect(await getGlosses(storage, ['甲', '乙', '丙'], NOW_MS)).toEqual({
      甲: 'a',
      乙: 'b',
      丙: 'c',
    });

    // The legacy pair was indexed in ascending key order, deterministically,
    // and the newly written word took the seq after them.
    const rowKeys = storage.keys().filter((k) => k.startsWith('gi:'));
    expect(rowKeys).toHaveLength(3);
    const pointsAt = [];
    for (const k of rowKeys) pointsAt.push(await storage.get<string>(k));
    const legacyPair = ['g:甲', 'g:乙'].sort();
    expect(pointsAt).toEqual([...legacyPair, 'g:丙']);

    // The whole point: a legacy entry is now evictable like any other.
    await putGlosses(storage, [{ zh: '丁', en: 'd' }], NOW_MS, TTL, CAP);
    expect(await storage.get('glossCount')).toBe(3);
    expect(storage.keys().filter((k) => k.startsWith('g:'))).not.toContain(legacyPair[0]);
    expect(storage.keys().filter((k) => k.startsWith('gi:'))).toHaveLength(3);
  });

  it('does not re-run the migration on a store the index already owns', async () => {
    const storage = new FakeQuotaStorage();
    await putGlosses(storage, [{ zh: '甲', en: 'a' }], NOW_MS, TTL, 10);
    const seenLists = storage.listCalls;
    await putGlosses(storage, [{ zh: '乙', en: 'b' }], NOW_MS, TTL, 10);
    // A second write under the cap lists nothing: no migration, no eviction.
    expect(storage.listCalls).toBe(seenLists);
    expect(await storage.get('glossCount')).toBe(2);
    expect(await storage.get('glossSeq')).toBe(2);
  });

  it('falls back to the built-in cap when the caller passes junk', async () => {
    const storage = new FakeQuotaStorage();
    await putGlosses(storage, [{ zh: '苹果', en: 'apple' }], NOW_MS, TTL, 0);
    await putGlosses(storage, [{ zh: '香蕉', en: 'banana' }], NOW_MS, TTL, -1);
    expect(MAX_GLOSS_ENTRIES).toBe(50_000);
    expect(await getGlosses(storage, ['苹果', '香蕉'], NOW_MS)).toEqual({
      苹果: 'apple',
      香蕉: 'banana',
    });
  });

  it('never mixes a gloss key up with a counter key', async () => {
    const storage = new FakeQuotaStorage();
    await putGlosses(storage, [{ zh: '苹果', en: 'apple' }], NOW_MS, TTL);
    await consume(storage, {
      bucket: 'enrich',
      ip: 'a',
      count: 1,
      perIpPerDay: 9,
      globalPerDay: 9,
      now: NOW_MS,
    });
    // A day roll wipes counters; the cached gloss must survive it.
    await consume(storage, {
      bucket: 'enrich',
      ip: 'a',
      count: 1,
      perIpPerDay: 9,
      globalPerDay: 9,
      now: NOW_MS + 48 * 60 * 60 * 1000,
    });
    expect(await getGlosses(storage, ['苹果'], NOW_MS + 48 * 60 * 60 * 1000)).toEqual({
      苹果: 'apple',
    });
  });
});

// --- persistence (the code RoomDO runs) --------------------------------------

describe('room persistence', () => {
  const NOW = 2_000_000;

  function seed(itemCount = 3) {
    const set = makeSet(itemCount);
    const questions = buildQuestions(set, { directions: ['zh2en'], seed: 3 });
    return createRoom('ABCD', set, questions, 8000, NOW);
  }

  it('round-trips a room through storage unchanged', async () => {
    const storage = new FakeStorage();
    const room = seed();
    await saveNewRoom(storage, room);

    const loaded = await loadRoom(storage);
    expect(loaded).toEqual(room);
  });

  it('returns null when this object holds no room (unknown code -> 404 path)', async () => {
    expect(await loadRoom(new FakeStorage())).toBeNull();
  });

  it('writes set and questions once, then only meta on later mutations', async () => {
    const storage = new FakeStorage();
    const room = seed();
    await saveNewRoom(storage, room);
    expect(storage.keys()).toEqual(['meta', 'questions', 'set']);

    const joined = join(room, 'Alice', NOW).state;
    await saveRoomMeta(storage, joined);
    expect(storage.keys()).toEqual(['meta', 'questions', 'set']);

    const reloaded = await loadRoom(storage);
    expect(reloaded!.players).toHaveLength(1);
    expect(reloaded!.questions).toEqual(room.questions);
  });

  it('keeps the split halves disjoint and lossless', () => {
    const room = seed();
    const { meta, set, questions } = splitRoom(room);
    expect(meta).not.toHaveProperty('set');
    expect(meta).not.toHaveProperty('questions');
    expect({ ...meta, set, questions }).toEqual(room);
  });

  it('a race survives the DO being evicted and reloaded mid-game', async () => {
    const storage = new FakeStorage();

    // First instantiation: create, two players join, host starts.
    let room = seed(2);
    await saveNewRoom(storage, room);
    const alice = join(room, 'Alice', NOW);
    await saveRoomMeta(storage, alice.state);
    const bob = join(alice.state, 'Bob', NOW);
    await saveRoomMeta(storage, bob.state);
    room = start(bob.state, alice.playerId!, NOW);
    await saveRoomMeta(storage, room);

    const opensAt = room.round!.startsAt;
    const slotMs = room.round!.slotMs;
    room = answer(room, alice.playerId!, 0, room.questions[0].answer, opensAt + 500);
    await saveRoomMeta(storage, room);

    // The DO is evicted here. A fresh instance reloads from storage only.
    const revived = await loadRoom(storage);
    expect(revived).not.toBeNull();
    expect(revived!.phase).toBe('round');
    expect(revived!.round!.startsAt).toBe(opensAt);
    expect(revived!.players.find((p) => p.id === alice.playerId)!.answered).toBe(1);

    // Play continues on the reloaded state, including first-write-wins.
    let after = answer(revived!, alice.playerId!, 0, room.questions[0].answer, opensAt + 900);
    expect(after).toEqual(revived); // already answered index 0, ignored

    after = answer(revived!, bob.playerId!, 0, room.questions[0].answer, opensAt + 700);
    after = answer(after, alice.playerId!, 1, after.questions[1].answer, opensAt + slotMs);
    after = answer(after, bob.playerId!, 1, after.questions[1].answer, opensAt + slotMs + 200);

    const done = finishIfDone(after, opensAt + slotMs + 300);
    expect(done.phase).toBe('results');
    expect(done.history).toHaveLength(1);
    expect(done.history[0].ranking).toHaveLength(2);

    await saveRoomMeta(storage, done);
    const finalLoad = await loadRoom(storage);
    expect(finalLoad!.history).toEqual(done.history);
  });

  it('records a delete-at stamp that a 2h alarm can act on', async () => {
    const storage = new FakeStorage();
    const room = seed();
    await saveNewRoom(storage, room);
    await storage.put(KEY_DELETE_AT, room.createdAt + 2 * 60 * 60 * 1000);

    expect(await storage.get<number>(KEY_DELETE_AT)).toBe(NOW + 7_200_000);

    await storage.deleteAll();
    expect(await loadRoom(storage)).toBeNull();
  });

  it('keeps member keys out of the room, so publicState has no path to them', async () => {
    const storage = new FakeStorage();
    const room = seed();
    await saveNewRoom(storage, room);

    const alice = join(room, 'Alice', NOW);
    await saveJoin(storage, alice.state, { [alice.playerId!]: 'key-alice' });

    // The map lives beside the room, never inside it.
    expect(storage.keys()).toEqual(['members', 'meta', 'questions', 'set']);
    const reloaded = await loadRoom(storage);
    expect(JSON.stringify(reloaded)).not.toContain('key-alice');
    expect(await loadMembers(storage)).toEqual({ [alice.playerId!]: 'key-alice' });
  });

  it('writes the roster and the member map together, so neither outlives the other', async () => {
    const storage = new FakeStorage();
    const room = seed();
    await saveNewRoom(storage, room);

    const alice = join(room, 'Alice', NOW);
    await saveJoin(storage, alice.state, { [alice.playerId!]: 'key-alice' });
    const bob = join(alice.state, 'Bob', NOW);
    await saveJoin(storage, bob.state, {
      [alice.playerId!]: 'key-alice',
      [bob.playerId!]: 'key-bob',
    });

    const members = await loadMembers(storage);
    const players = (await loadRoom(storage))!.players;
    // Every player on the public roster has a key, and nobody else does.
    expect(Object.keys(members).sort()).toEqual(players.map((p) => p.id).sort());
  });

  it('has no member map at all before anyone joins', async () => {
    const storage = new FakeStorage();
    await saveNewRoom(storage, seed());
    expect(await loadMembers(storage)).toEqual({});
  });
});

// --- player credentials (Codex round 1, MUST-FIX 2) --------------------------

describe('isMemberAuthorized', () => {
  const KEY = '0a3f1f2e-6d4b-4f1a-9c7e-2b8d5e6f7a90';

  it('accepts a v2 player whose key matches the one join gave them', () => {
    expect(
      isMemberAuthorized({ model: 2, playerId: 'p1', memberKey: KEY, storedMemberKey: KEY })
    ).toBe(true);
  });

  it('refuses a v2 player answering as somebody else', () => {
    // The whole bug: `players` is public, so p2 knows p1's id. It is not enough.
    expect(
      isMemberAuthorized({ model: 2, playerId: 'p1', memberKey: 'p2s-own-key', storedMemberKey: KEY })
    ).toBe(false);
    expect(isMemberAuthorized({ model: 2, playerId: 'p1', storedMemberKey: KEY })).toBe(false);
    expect(
      isMemberAuthorized({ model: 2, playerId: 'p1', memberKey: '', storedMemberKey: KEY })
    ).toBe(false);
    expect(
      isMemberAuthorized({ model: 2, playerId: 'p1', memberKey: 12345, storedMemberKey: KEY })
    ).toBe(false);
  });

  it('refuses a v2 player the room has no key for, rather than letting them in', () => {
    expect(isMemberAuthorized({ model: 2, playerId: 'p1', memberKey: KEY })).toBe(false);
    expect(
      isMemberAuthorized({ model: 2, playerId: 'p1', memberKey: '', storedMemberKey: '' })
    ).toBe(false);
  });

  it('still takes a bare playerId in a model 1 room, so a week-1 race finishes', () => {
    expect(isMemberAuthorized({ model: 1, playerId: 'p1' })).toBe(true);
    expect(isMemberAuthorized({ model: 1, playerId: 'p1', memberKey: 'anything' })).toBe(true);
  });

  it('never accepts a missing or empty playerId, in either model', () => {
    expect(isMemberAuthorized({ model: 1, playerId: '' })).toBe(false);
    expect(isMemberAuthorized({ model: 1 })).toBe(false);
    expect(isMemberAuthorized({ model: 2, playerId: '', memberKey: KEY, storedMemberKey: KEY })).toBe(
      false
    );
  });

  it('is a separate gate from host authorization: a host key does not answer questions', () => {
    expect(roomActionAuthFor('answer')).toBe('player');
    expect(roomActionAuthFor('pick')).toBe('player');
    expect(
      isMemberAuthorized({ model: 2, playerId: 'p1', memberKey: KEY, storedMemberKey: 'other' })
    ).toBe(false);
  });
});

// --- a host key does not survive its room (Codex round 1, SHOULD-FIX 2) ------

describe('host key across a room incarnation', () => {
  const NOW = 3_000_000;

  it('refuses a host key from a deleted room when its code is reused', async () => {
    const storage = new FakeStorage();
    const set = makeSet(3);

    // First room on code ABCD.
    const first = createRoom('ABCD', set, [], 8000, NOW, { teacher: true });
    await saveNewRoom(storage, first);
    await saveHostKey(storage, 'host-key-of-the-FIRST-room');

    // It hits its 2h TTL. The alarm wipes the Durable Object's storage.
    await storage.deleteAll();
    expect(await loadRoom(storage)).toBeNull();
    expect(await loadHostKey(storage)).toBeUndefined();

    // The code comes back round and a new room is created on it.
    const second = createRoom('ABCD', set, [], 8000, NOW + 7_200_001, { teacher: true });
    await saveNewRoom(storage, second);
    await saveHostKey(storage, 'host-key-of-the-second-room');

    // The old teacher's device still holds the old key. It is refused, because
    // the key is checked against this room's own slot, not against the code.
    const stored = await loadHostKey(storage);
    expect(
      isHostAuthorized({ hostKey: 'host-key-of-the-FIRST-room', storedHostKey: stored, hostId: '' })
    ).toBe(false);
    // The new teacher's key does work, so this is not passing by refusing all.
    expect(
      isHostAuthorized({ hostKey: 'host-key-of-the-second-room', storedHostKey: stored, hostId: '' })
    ).toBe(true);

    // And the two rooms are distinguishable on the wire, which is how a stale
    // host device knows to clear its own storage rather than wait for a 403.
    expect(second.createdAt).not.toBe(first.createdAt);
  });

  it('refuses every key in a room that has none, so a wiped slot fails closed', async () => {
    const storage = new FakeStorage();
    await saveNewRoom(storage, createRoom('ABCD', makeSet(3), [], 8000, NOW, { teacher: true }));
    expect(
      isHostAuthorized({ hostKey: 'anything', storedHostKey: await loadHostKey(storage), hostId: '' })
    ).toBe(false);
  });
});

// --- Google Sheets input (added 2026-09-08) ----------------------------------
//
// The endpoint shape and its behaviour come from section 7 of
// docs/research/2026-09-08-quizlet-extraction.md, re-verified live on
// 2026-09-08 against the public "Class Data" sample sheet Google uses in its
// own Sheets API docs (200, quoted CSV) and against a made-up id (404, HTML).

describe('parseSheetUrl', () => {
  const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

  it('reads the id out of an ordinary sheet link', () => {
    const parsed = parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.target).toEqual({ id: ID, gid: undefined });
  });

  it('keeps the tab from #gid= and from ?gid=', () => {
    const hash = parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=1234`);
    expect(hash.ok && hash.target.gid).toBe('1234');
    const query = parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/export?gid=77`);
    expect(query.ok && query.target.gid).toBe('77');
  });

  it('reads a link from an account-scoped path', () => {
    const parsed = parseSheetUrl(`https://docs.google.com/spreadsheets/u/0/d/${ID}/edit`);
    expect(parsed.ok && parsed.target.id).toBe(ID);
  });

  it('refuses any host but docs.google.com, so this cannot become an open proxy', () => {
    for (const bad of [
      `https://docs.google.com.evil.test/spreadsheets/d/${ID}/edit`,
      `https://evil.test/spreadsheets/d/${ID}/edit`,
      `https://drive.google.com/spreadsheets/d/${ID}/edit`,
      `https://docs.google.com@evil.test/spreadsheets/d/${ID}`,
      'https://quizlet.com/123/set',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      const parsed = parseSheetUrl(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toBe(NOT_A_SHEET);
    }
  });

  it('refuses a docs.google.com link that is not a spreadsheet, and a short id', () => {
    expect(parseSheetUrl(`https://docs.google.com/document/d/${ID}/edit`).ok).toBe(false);
    expect(parseSheetUrl('https://docs.google.com/spreadsheets/d/short/edit').ok).toBe(false);
  });

  it('refuses the published-to-web /d/e/ shape, whose id gviz does not accept', () => {
    expect(
      parseSheetUrl('https://docs.google.com/spreadsheets/d/e/2PACX-1vQxxxxxxxxxxxxxxxxx/pubhtml').ok
    ).toBe(false);
  });

  it('builds the gviz CSV url, with the tab when there is one', () => {
    expect(buildCsvUrl({ id: ID })).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/gviz/tq?tqx=out:csv`
    );
    expect(buildCsvUrl({ id: ID, gid: '5' })).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/gviz/tq?tqx=out:csv&gid=5`
    );
  });
});

describe('fetchSheetCsv', () => {
  const TARGET = { id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms' };
  const LIMITS = { maxBytes: 1024, timeoutMs: 1000 };
  const CSV = '"Chinese","English"\n"你好","hello"';

  function fakeFetch(response: Response): typeof fetch {
    return (async () => response) as unknown as typeof fetch;
  }

  it('returns the CSV a shared sheet answers with', async () => {
    const result = await fetchSheetCsv(
      TARGET,
      LIMITS,
      fakeFetch(new Response(CSV, { headers: { 'Content-Type': 'text/csv' } }))
    );
    expect(result).toEqual({ ok: true, text: CSV });
  });

  it('asks the teacher to share the sheet when Google answers 404', async () => {
    const result = await fetchSheetCsv(TARGET, LIMITS, fakeFetch(new Response('<html>', { status: 404 })));
    expect(result).toEqual({ ok: false, status: 400, error: SHEET_PRIVATE });
  });

  it('treats a 200 sign-in page as private, because HTML is never a CSV', async () => {
    const result = await fetchSheetCsv(
      TARGET,
      LIMITS,
      fakeFetch(new Response('<html>sign in</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    );
    expect(result).toEqual({ ok: false, status: 400, error: SHEET_PRIVATE });
  });

  it('stops reading a sheet that is over the cap instead of buffering it', async () => {
    const big = 'x'.repeat(4096);
    const result = await fetchSheetCsv(
      TARGET,
      LIMITS,
      fakeFetch(new Response(big, { headers: { 'Content-Type': 'text/csv' } }))
    );
    expect(result).toEqual({ ok: false, status: 413, error: SHEET_TOO_BIG });
  });

  it('refuses a declared Content-Length over the cap before reading a byte', async () => {
    const result = await fetchSheetCsv(
      TARGET,
      LIMITS,
      fakeFetch(
        new Response('short', {
          headers: { 'Content-Type': 'text/csv', 'Content-Length': '999999' },
        })
      )
    );
    expect(result).toEqual({ ok: false, status: 413, error: SHEET_TOO_BIG });
  });

  it('says so plainly when Google cannot be reached', async () => {
    const boom = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await fetchSheetCsv(TARGET, LIMITS, boom);
    expect(result).toEqual({ ok: false, status: 502, error: SHEET_UNREACHABLE });
  });

  it('gives up on a slow sheet rather than hanging the teacher', async () => {
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;
    const result = await fetchSheetCsv(TARGET, { maxBytes: 1024, timeoutMs: 5 }, slow);
    expect(result).toEqual({ ok: false, status: 504, error: SHEET_SLOW });
  });

  it('treats an empty sheet as one the teacher still has to share or fill', async () => {
    const result = await fetchSheetCsv(
      TARGET,
      LIMITS,
      fakeFetch(new Response('   \n', { headers: { 'Content-Type': 'text/csv' } }))
    );
    expect(result).toEqual({ ok: false, status: 400, error: SHEET_PRIVATE });
  });
});

// --- photo input (added 2026-09-08) ------------------------------------------
//
// Graded B: the request shape and the response shape come from Microsoft's docs
// (cited in src/worker/ocr.ts), not from a live call. AZURE_VISION_KEY and
// AZURE_VISION_ENDPOINT are not set yet, so no live Azure call has been made.

describe('readOcrConfig', () => {
  it('is null until BOTH secrets are set, which is what makes the route 501', () => {
    expect(readOcrConfig(undefined)).toBeNull();
    expect(readOcrConfig({})).toBeNull();
    expect(readOcrConfig({ AZURE_VISION_KEY: 'k' })).toBeNull();
    expect(readOcrConfig({ AZURE_VISION_ENDPOINT: 'https://x.cognitiveservices.azure.com' })).toBeNull();
    expect(readOcrConfig({ AZURE_VISION_KEY: '   ', AZURE_VISION_ENDPOINT: 'https://x.test' })).toBeNull();
  });

  it('refuses an endpoint that is not an https URL', () => {
    expect(readOcrConfig({ AZURE_VISION_KEY: 'k', AZURE_VISION_ENDPOINT: 'nonsense' })).toBeNull();
    expect(readOcrConfig({ AZURE_VISION_KEY: 'k', AZURE_VISION_ENDPOINT: 'http://x.test' })).toBeNull();
  });

  it('trims a trailing slash off the endpoint', () => {
    const config = readOcrConfig({
      AZURE_VISION_KEY: 'k',
      AZURE_VISION_ENDPOINT: 'https://x.cognitiveservices.azure.com/',
    });
    expect(config?.endpoint).toBe('https://x.cognitiveservices.azure.com');
    expect(config?.language).toBeUndefined();
  });

  it('carries a forced language only when OCR_LANGUAGE is set', () => {
    const config = readOcrConfig({
      AZURE_VISION_KEY: 'k',
      AZURE_VISION_ENDPOINT: 'https://x.test',
      OCR_LANGUAGE: 'zh-Hans',
    });
    expect(config?.language).toBe('zh-Hans');
  });
});

describe('buildAnalyzeUrl', () => {
  const BASE = { endpoint: 'https://x.cognitiveservices.azure.com', key: 'k' };

  it('matches the documented Image Analysis 4.0 read endpoint', () => {
    expect(buildAnalyzeUrl(BASE)).toBe(
      'https://x.cognitiveservices.azure.com/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read'
    );
  });

  it('sends no language by default, because Read is told not to be forced', () => {
    expect(buildAnalyzeUrl(BASE)).not.toContain('language');
    expect(buildAnalyzeUrl({ ...BASE, language: 'zh-Hans' })).toContain('language=zh-Hans');
  });
});

describe('extractText', () => {
  it('joins every line of every block with newlines, for the parser to read', () => {
    const payload = {
      readResult: {
        blocks: [
          { lines: [{ text: '你好' }, { text: 'hello' }] },
          { lines: [{ text: ' 谢谢 ' }, { text: 'thank you' }] },
        ],
      },
    };
    expect(extractText(payload)).toBe('你好\nhello\n谢谢\nthank you');
  });

  it('returns nothing rather than throwing on an unexpected shape', () => {
    expect(extractText(null)).toBe('');
    expect(extractText({})).toBe('');
    expect(extractText({ readResult: {} })).toBe('');
    expect(extractText({ readResult: { blocks: 'nope' } })).toBe('');
    expect(extractText({ readResult: { blocks: [{ lines: [{ text: 42 }, { text: '  ' }] }] } })).toBe('');
  });
});

describe('runOcr', () => {
  const CONFIG = { endpoint: 'https://x.cognitiveservices.azure.com', key: 'secret-key' };
  const BYTES = new Uint8Array([1, 2, 3]).buffer;

  it('sends the key and the raw bytes the documented way, and returns the text', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fake = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response(
        JSON.stringify({ readResult: { blocks: [{ lines: [{ text: '猫' }, { text: 'cat' }] }] } }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const result = await runOcr(CONFIG, BYTES, 1000, fake);
    expect(result).toEqual({ ok: true, text: '猫\ncat', attempts: 1 });
    expect(seenUrl).toContain('imageanalysis:analyze');
    expect(seenInit?.method).toBe('POST');
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('secret-key');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(seenInit?.body).toBe(BYTES);
  });

  it('charges the attempt when Azure answers with an error, since the call was made', async () => {
    const fake = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const result = await runOcr(CONFIG, BYTES, 1000, fake);
    expect(result).toEqual({ ok: false, status: 502, error: OCR_FAILED, attempts: 1 });
  });

  it('charges nothing when the call never reached Azure, so the quota is refunded', async () => {
    const fake = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await runOcr(CONFIG, BYTES, 1000, fake);
    expect(result).toEqual({ ok: false, status: 502, error: OCR_FAILED, attempts: 0 });
  });

  it('tells the teacher when the photo held no words', async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ readResult: { blocks: [] } }), {
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const result = await runOcr(CONFIG, BYTES, 1000, fake);
    expect(result).toEqual({ ok: false, status: 422, error: OCR_NO_TEXT, attempts: 1 });
  });

  it('does not hang on a slow Azure', async () => {
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;
    const result = await runOcr(CONFIG, BYTES, 5, slow);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(504);
  });
});

describe('isAllowedImageType', () => {
  it('accepts the three image types the route takes, with or without parameters', () => {
    expect(isAllowedImageType('image/jpeg')).toBe(true);
    expect(isAllowedImageType('image/png')).toBe(true);
    expect(isAllowedImageType('IMAGE/WEBP')).toBe(true);
    expect(isAllowedImageType('image/jpeg; charset=binary')).toBe(true);
  });

  it('refuses everything else before any Vision call is paid for', () => {
    for (const bad of [null, '', 'application/pdf', 'image/heic', 'text/plain', 'image/svg+xml']) {
      expect(isAllowedImageType(bad)).toBe(false);
    }
  });
});

// --- the OCR provider ladder (added 2026-09-08) -------------------------------
//
// Graded B. The Workers AI MODEL was verified live on 2026-09-08 (a made-up
// name answers 5007 "No such model"; @cf/meta/llama-3.2-11b-vision-instruct
// answers 4006 "used up your daily free allocation of 10,000 neurons", which
// only a real model reaches). The day's free neuron budget was already spent,
// so no photo has been read end to end yet and every branch below is driven by
// a fake AI runner instead.

/** A stand-in for the `AI` binding that records what it was asked. */
function fakeAi(reply: unknown) {
  const calls: Array<{ model: string; options: Record<string, unknown> }> = [];
  return {
    calls,
    env: {
      AI: {
        async run(model: string, options: Record<string, unknown>): Promise<unknown> {
          calls.push({ model, options });
          if (reply instanceof Error) throw reply;
          if (typeof reply === 'function') return (reply as () => unknown)();
          return reply;
        },
      },
    },
  };
}

const PHOTO = new Uint8Array([137, 80, 78, 71]).buffer;

describe('parseOcrProviderOrder', () => {
  it('defaults to azure first, workers ai second', () => {
    expect(parseOcrProviderOrder(undefined)).toEqual(['azure', 'workersai']);
    expect(parseOcrProviderOrder('')).toEqual(['azure', 'workersai']);
    expect(parseOcrProviderOrder('   ')).toEqual([...DEFAULT_OCR_PROVIDER_ORDER]);
  });

  it('reads the order it is given, trimming, lowercasing and de-duplicating', () => {
    expect(parseOcrProviderOrder('workersai,azure')).toEqual(['workersai', 'azure']);
    expect(parseOcrProviderOrder(' WorkersAI , azure , workersai ')).toEqual(['workersai', 'azure']);
    expect(parseOcrProviderOrder('workersai')).toEqual(['workersai']);
  });

  it('ignores a typo rather than letting it switch photo reading off', () => {
    expect(parseOcrProviderOrder('tesseract,workersai')).toEqual(['workersai']);
    expect(parseOcrProviderOrder('tesseract,nonsense')).toEqual(['azure', 'workersai']);
  });
});

describe('plannedOcrProviders', () => {
  const SECRETS = {
    AZURE_VISION_KEY: 'k',
    AZURE_VISION_ENDPOINT: 'https://x.cognitiveservices.azure.com',
  };

  it('skips azure when its secrets are missing, which is the shipped default', () => {
    expect(plannedOcrProviders({})).toEqual(['workersai']);
    expect(plannedOcrProviders({ OCR_PROVIDER_ORDER: 'azure,workersai' })).toEqual(['workersai']);
    expect(ocrAttemptBudget({})).toBe(1);
  });

  it('puts azure back the day both secrets exist, with no code change', () => {
    expect(plannedOcrProviders(SECRETS)).toEqual(['azure', 'workersai']);
    expect(ocrAttemptBudget(SECRETS)).toBe(2);
  });

  it('leaves the 501 reachable: azure pinned alone with no secrets runs nothing', () => {
    expect(plannedOcrProviders({ OCR_PROVIDER_ORDER: 'azure' })).toEqual([]);
    expect(ocrAttemptBudget({ OCR_PROVIDER_ORDER: 'azure' })).toBe(0);
    expect(plannedOcrProviders({ ...SECRETS, OCR_PROVIDER_ORDER: 'azure' })).toEqual(['azure']);
  });
});

describe('cleanOcrText', () => {
  it('keeps the lines exactly, dropping only blank ones', () => {
    expect(cleanOcrText('苹果 apple\n\n老师 lǎo shī teacher\n')).toBe(
      '苹果 apple\n老师 lǎo shī teacher'
    );
  });

  it('unwraps a code fence an instruct model added on its own', () => {
    expect(cleanOcrText('```\n苹果 apple\n香蕉\n```')).toBe('苹果 apple\n香蕉');
    expect(cleanOcrText('```text\n猫 cat\n```')).toBe('猫 cat');
  });

  it('returns nothing for anything that is not a string', () => {
    for (const bad of [null, undefined, 42, {}, []]) expect(cleanOcrText(bad)).toBe('');
  });
});

describe('runWorkersAiOcr', () => {
  it('asks the verified model to transcribe, sending the photo as bytes', async () => {
    const fake = fakeAi({ response: '苹果 apple\n老师 lǎo shī teacher' });
    const result = await runWorkersAiOcr(fake.env, PHOTO, 1000);

    expect(result).toEqual({ ok: true, text: '苹果 apple\n老师 lǎo shī teacher', attempts: 1 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].model).toBe(OCR_MODEL);
    expect(fake.calls[0].options.prompt).toBe(OCR_PROMPT);
    expect(fake.calls[0].options.image).toEqual([137, 80, 78, 71]);
  });

  it('reports 502 when the model answers in a shape with no text in it', async () => {
    for (const malformed of [{ foo: 1 }, null, 42, { response: 7 }, { response: null }]) {
      const result = await runWorkersAiOcr(fakeAi(malformed).env, PHOTO, 1000);
      expect(result).toEqual({ ok: false, status: 502, error: OCR_FAILED, attempts: 1 });
    }
  });

  it('reports 502 when the model call itself fails, and still charges the call', async () => {
    const result = await runWorkersAiOcr(fakeAi(new Error('4006 neurons')).env, PHOTO, 1000);
    expect(result).toEqual({ ok: false, status: 502, error: OCR_FAILED, attempts: 1 });
  });

  it('tells the teacher the photo held no words when the answer is empty', async () => {
    for (const empty of ['', '   ', { response: '' }, { response: '\n\n' }]) {
      const result = await runWorkersAiOcr(fakeAi(empty).env, PHOTO, 1000);
      expect(result).toEqual({ ok: false, status: 422, error: OCR_NO_TEXT, attempts: 1 });
    }
  });

  it('does not leave the teacher waiting on a model that never answers', async () => {
    const never = fakeAi(() => new Promise(() => {}));
    const result = await runWorkersAiOcr(never.env, PHOTO, 5);
    expect(result).toEqual({ ok: false, status: 504, error: OCR_FAILED, attempts: 1 });
  });
});

describe('runOcrLadder', () => {
  const SECRETS = {
    AZURE_VISION_KEY: 'k',
    AZURE_VISION_ENDPOINT: 'https://x.cognitiveservices.azure.com',
  };

  it('reads the photo with workers ai when azure is not configured', async () => {
    const fake = fakeAi({ response: '香蕉' });
    const env = { ...fake.env };
    const result = await runOcrLadder(env, plannedOcrProviders({}), PHOTO, 1000);
    expect(result).toEqual({ ok: true, text: '香蕉', attempts: 1 });
  });

  it('falls through to workers ai when azure fails, and charges both calls', async () => {
    const fake = fakeAi({ response: '猫 cat' });
    const azureDown = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const env = { ...fake.env, ...SECRETS };

    const result = await runOcrLadder(env, ['azure', 'workersai'], PHOTO, 1000, azureDown);
    expect(result).toEqual({ ok: true, text: '猫 cat', attempts: 2 });
    expect(fake.calls).toHaveLength(1);
  });

  it('never calls the second rung when the first one read the photo', async () => {
    const fake = fakeAi({ response: 'should not be used' });
    const azureOk = (async () =>
      new Response(JSON.stringify({ readResult: { blocks: [{ lines: [{ text: '书' }] }] } }), {
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const env = { ...fake.env, ...SECRETS };

    const result = await runOcrLadder(env, ['azure', 'workersai'], PHOTO, 1000, azureOk);
    expect(result).toEqual({ ok: true, text: '书', attempts: 1 });
    expect(fake.calls).toHaveLength(0);
  });

  it('stops on "no words in this photo" rather than paying a second provider', async () => {
    const fake = fakeAi({ response: '' });
    const result = await runOcrLadder({ ...fake.env }, ['workersai', 'workersai'], PHOTO, 1000);
    expect(result).toEqual({ ok: false, status: 422, error: OCR_NO_TEXT, attempts: 1 });
    expect(fake.calls).toHaveLength(1);
  });

  it('reports the last failure when every rung failed', async () => {
    const fake = fakeAi(new Error('down'));
    const azureDown = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const env = { ...fake.env, ...SECRETS };

    const result = await runOcrLadder(env, ['azure', 'workersai'], PHOTO, 1000, azureDown);
    expect(result).toEqual({ ok: false, status: 502, error: OCR_FAILED, attempts: 2 });
  });
});

describe('ocr quota bucket', () => {
  it('counts separately from the enrich and tts budgets', async () => {
    const storage = new FakeQuotaStorage();
    const now = Date.UTC(2026, 8, 8, 10, 0, 0);
    const limits = { perIpPerDay: 20, globalPerDay: 300 };
    expect((await consume(storage, { bucket: 'ocr', ip: '1.2.3.4', count: 1, ...limits, now })).allowed).toBe(true);
    expect(await usage(storage, 'ocr', '1.2.3.4', now)).toEqual({ ip: 1, global: 1 });
    expect(await usage(storage, 'enrich', '1.2.3.4', now)).toEqual({ ip: 0, global: 0 });
  });

  it('is accepted by the QuotaDO request validator', () => {
    const now = Date.UTC(2026, 8, 8, 10, 0, 0);
    expect(
      parseConsumeRequest(
        { bucket: 'ocr', ip: '1.2.3.4', count: 1, perIpPerDay: 20, globalPerDay: 300 },
        now
      ).ok
    ).toBe(true);
  });
});


