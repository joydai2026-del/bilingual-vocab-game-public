// GET /api/tts?text=<zh>: server-side Chinese speech.
//
// This is a ladder, not one model. The worker tries each provider in
// TTS_PROVIDER_ORDER and returns the first that produces audio:
//
//   azure    Azure Neural TTS (zh-CN-XiaoxiaoNeural by default). Standard
//            Neural voices accept full SSML, which is the whole reason they
//            win here: <prosody rate> gives teacher pacing and a <break> on
//            each side stops a one-word clip sounding clipped. Runs only when
//            both AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are set, so the
//            app works unchanged with no Azure account at all.
//   melotts  @cf/myshell-ai/melotts via the Workers AI binding. No key, but a
//            frozen 2024 VITS model and the only multi-lingual TTS in the
//            catalogue (the Deepgram aura models are English and Spanish).
//
// Below both of those the client shows pinyin only, which is not this file.
//
// Note on the content type: Cloudflare's docs describe MeloTTS output as MP3,
// but the live service returned 16-bit PCM WAV for lang "zh" on 2026-09-07.
// Rather than trust either, the bytes are sniffed and the header is set from
// what actually came back, so the browser never gets a mislabelled file. Azure
// is asked for MP3 explicitly and sniffed the same way, for the same reason.
//
// Every provider attempt is one paid call and is charged to the same daily TTS
// quota: the caller reserves `ttsAttemptBudget()` calls up front and refunds
// the ones the ladder did not make.

// No `import type { Env } from './index'` here on purpose: that would drag the
// ambient Cloudflare Workers types (`Ai`, `DurableObjectNamespace`, ...) into
// any file that imports this module, including tests/worker.test.ts, which is
// typechecked under tsconfig.json (the client config, no Workers types). The
// same trick quota.ts uses for `QuotaStorage`: a local, structural slice of the
// real `Ai` binding that `Env` satisfies with no cast needed at the call site.
import { normalizeText } from './quota';

export interface AiRunner {
  run(model: string, options: Record<string, unknown>): Promise<unknown>;
}

export const TTS_MODEL = '@cf/myshell-ai/melotts';
export const TTS_CACHE_SECONDS = 86_400;

/** The rungs of the ladder, in the only order the code knows how to run them. */
export type TtsProvider = 'azure' | 'melotts';

/** Every provider name `TTS_PROVIDER_ORDER` may contain. */
export const TTS_PROVIDERS: readonly TtsProvider[] = ['azure', 'melotts'];

/** Used when TTS_PROVIDER_ORDER is missing, empty, or entirely unrecognised. */
export const DEFAULT_PROVIDER_ORDER: readonly TtsProvider[] = ['azure', 'melotts'];

// Azure defaults. Each one is overridable by a `vars` entry, so changing the
// voice or the pacing is a config edit and a redeploy, never a code edit.
export const AZURE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
/** Slower than natural: these are learners hearing one word with no context. */
export const AZURE_DEFAULT_RATE = '-10%';
/**
 * Silence padded onto both ends of the word. A bare single word can otherwise
 * start on the very first sample and sound clipped.
 */
export const AZURE_BREAK_MS = 120;
/** 24 kHz is the voices' native rate, and MP3 plays everywhere including iOS. */
export const AZURE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const SSML_NS = 'http://www.w3.org/2001/10/synthesis';
const MSTTS_NS = 'http://www.w3.org/2001/mstts';

/**
 * The slice of the worker environment this file reads.
 *
 * Everything but `AI` is optional on purpose: with no Azure resource created
 * the ladder simply starts at MeloTTS, which is exactly the behaviour that
 * shipped before Azure existed.
 */
export interface TtsEnv {
  AI: AiRunner;
  /** Azure Speech resource key. Read here, never logged, never returned. */
  AZURE_SPEECH_KEY?: string;
  /** Azure region short name, e.g. "eastus". A plain var, not a secret. */
  AZURE_SPEECH_REGION?: string;
  AZURE_TTS_VOICE?: string;
  AZURE_TTS_RATE?: string;
  /** Comma-separated provider order, e.g. "azure,melotts". */
  TTS_PROVIDER_ORDER?: string;
}

/**
 * MeloTTS fails non-deterministically on a small fraction of otherwise-identical
 * calls (live-verified 2026-09-07: 2 of 20 identical `text=苹果` requests came
 * back 502). One call plus two retries absorbs that without the teacher ever
 * seeing it.
 *
 * The retry budget is real money, so index.ts RESERVES the worst case against
 * the daily quota before calling and refunds the attempts that were not used.
 * The attempt cap itself lives in policy.ts (`ttsMaxAttempts`); this is only the
 * default for a caller that does not pass one.
 */
export const TTS_DEFAULT_MAX_ATTEMPTS = 3;
export const TTS_RETRY_DELAYS_MS = [150, 400];

/**
 * Why one attempt produced no audio.
 *
 * `transient` is a hiccup worth retrying: the call threw (the live 502), or it
 * came back with nothing at all. `malformed` is the model answering with a
 * shape we cannot read; the same prompt will produce the same shape, so a retry
 * only burns another paid call for the same user-visible failure.
 */
export type TtsFailure = 'transient' | 'malformed';

interface AttemptResult {
  bytes: Uint8Array | null;
  reason: 'ok' | TtsFailure;
}

export interface TtsResult {
  /** The audio response, or null when every usable attempt failed. */
  audio: Response | null;
  /** Paid `env.AI.run` calls actually made, for the caller's quota refund. */
  attempts: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Reads the audio container from its magic bytes. Defaults to MP3. */
export function sniffAudioType(bytes: Uint8Array): string {
  const starts = (sig: number[], offset = 0) =>
    sig.every((byte, i) => bytes[offset + i] === byte);

  // "RIFF" .... "WAVE"
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x41, 0x56, 0x45], 8)) return 'audio/wav';
  // "OggS"
  if (starts([0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  // "fLaC"
  if (starts([0x66, 0x4c, 0x61, 0x43])) return 'audio/flac';
  // "ID3" tag, or an MPEG frame sync (0xFF 0xEx / 0xFx)
  if (starts([0x49, 0x44, 0x33])) return 'audio/mpeg';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return 'audio/mpeg';
}

/**
 * Runs MeloTTS and returns an audio response plus the number of paid calls it
 * took.
 *
 * Retries only a `transient` failure (see `TtsFailure`), up to `maxAttempts`
 * calls with a 150ms then 400ms backoff. A `malformed` answer stops immediately:
 * retrying deterministic junk spends three calls for one failure.
 *
 * Only a successful clip is ever returned, so only a successful clip is ever
 * written into `caches.default` by the caller. `audio: null` means the caller
 * should send a JSON 502 and let the client fall back to the browser's voice.
 */
export async function synthesize(
  env: { AI: AiRunner },
  text: string,
  options: { maxAttempts?: number; wait?: (ms: number) => Promise<void> } = {}
): Promise<TtsResult> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? TTS_DEFAULT_MAX_ATTEMPTS));
  const wait = options.wait ?? sleep;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { bytes, reason } = await runOnce(env, text);
    const attempts = attempt + 1;

    if (reason === 'ok' && bytes) {
      return {
        audio: new Response(bytes as BodyInit, {
          headers: {
            'Content-Type': sniffAudioType(bytes),
            'Content-Length': String(bytes.byteLength),
            'Cache-Control': `public, max-age=${TTS_CACHE_SECONDS}`,
            'x-tts-voice': 'melotts',
          },
        }),
        attempts,
      };
    }

    if (reason === 'malformed') {
      console.error('tts: melotts returned an unusable shape, not retrying');
      return { audio: null, attempts };
    }

    if (attempts >= maxAttempts) {
      console.error(`tts: melotts failed after ${attempts} attempt(s)`);
      return { audio: null, attempts };
    }

    console.error(`tts: melotts attempt ${attempts} failed transiently, retrying`);
    await wait(TTS_RETRY_DELAYS_MS[Math.min(attempt, TTS_RETRY_DELAYS_MS.length - 1)]);
  }

  return { audio: null, attempts: maxAttempts };
}

/** One Workers AI call. Never throws; classifies why it failed. */
async function runOnce(env: { AI: AiRunner }, text: string): Promise<AttemptResult> {
  let raw: unknown;
  try {
    raw = await env.AI.run(TTS_MODEL, { prompt: text, lang: 'zh' });
  } catch (err) {
    console.error('tts: melotts call threw', err instanceof Error ? err.message : err);
    return { bytes: null, reason: 'transient' };
  }
  // Nothing at all came back: an empty upstream response, worth one more try.
  if (raw === null || raw === undefined) return { bytes: null, reason: 'transient' };
  return toBytes(raw);
}

/**
 * Buffers whatever Workers AI returned into bytes. The clips are one or two
 * seconds long (under 100 KB), so buffering costs nothing and is what lets the
 * content type be sniffed instead of guessed.
 *
 * A stream that fails mid-read is transient. Anything else that gets here is
 * the model answering in a shape we cannot use, which a retry will not change.
 */
async function toBytes(raw: unknown): Promise<AttemptResult> {
  const ok = (bytes: Uint8Array): AttemptResult =>
    bytes.byteLength > 0 ? { bytes, reason: 'ok' } : { bytes: null, reason: 'malformed' };

  if (raw instanceof Uint8Array) return ok(raw);
  if (raw instanceof ArrayBuffer) return ok(new Uint8Array(raw));
  if (raw instanceof ReadableStream) {
    try {
      return ok(new Uint8Array(await new Response(raw).arrayBuffer()));
    } catch {
      return { bytes: null, reason: 'transient' };
    }
  }
  if (raw && typeof raw === 'object') {
    const audio = (raw as { audio?: unknown }).audio;
    if (typeof audio === 'string' && audio.length > 0) {
      try {
        return ok(base64ToBytes(audio));
      } catch {
        return { bytes: null, reason: 'malformed' };
      }
    }
  }
  return { bytes: null, reason: 'malformed' };
}

// --- azure -------------------------------------------------------------------

/**
 * XML-escapes one word for an SSML body.
 *
 * Not optional: the text is teacher-supplied. `/api/tts` already rejects
 * anything that is not Chinese, but a rejected-input gate is not an encoding
 * guarantee, and an unescaped `&` alone is enough to make Azure return 400.
 */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The exact SSML body sent to Azure. Exported so a test can read it. */
export function azureSsml(text: string, voice: string, rate: string): string {
  return (
    `<speak version="1.0" xmlns="${SSML_NS}" xmlns:mstts="${MSTTS_NS}" xml:lang="zh-CN">` +
    `<voice name="${xmlEscape(voice)}">` +
    `<break time="${AZURE_BREAK_MS}ms"/>` +
    `<prosody rate="${xmlEscape(rate)}">${xmlEscape(text)}</prosody>` +
    `<break time="${AZURE_BREAK_MS}ms"/>` +
    `</voice>` +
    `</speak>`
  );
}

/** Trimmed non-empty string, or undefined. `vars` can arrive as either type. */
function str(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function azureVoice(env: TtsEnv): string {
  return str(env.AZURE_TTS_VOICE) ?? AZURE_DEFAULT_VOICE;
}

export function azureRate(env: TtsEnv): string {
  return str(env.AZURE_TTS_RATE) ?? AZURE_DEFAULT_RATE;
}

/** True when both Azure secrets are present. Never inspects the key's value. */
export function azureConfigured(env: TtsEnv): boolean {
  return str(env.AZURE_SPEECH_KEY) !== undefined && str(env.AZURE_SPEECH_REGION) !== undefined;
}

/**
 * Reads `TTS_PROVIDER_ORDER`, e.g. "azure,melotts".
 *
 * Unknown names are dropped with a log rather than crashing the route, and an
 * order that ends up empty falls back to the default. A typo in config must
 * not be able to switch spoken audio off.
 */
export function parseProviderOrder(raw: unknown): TtsProvider[] {
  const text = str(raw);
  if (text === undefined) return [...DEFAULT_PROVIDER_ORDER];

  const out: TtsProvider[] = [];
  for (const part of text.split(',')) {
    const name = part.trim().toLowerCase();
    if (name === '') continue;
    if (!(TTS_PROVIDERS as readonly string[]).includes(name)) {
      console.error(`tts: unknown provider "${name}" in TTS_PROVIDER_ORDER, ignoring it`);
      continue;
    }
    const provider = name as TtsProvider;
    if (!out.includes(provider)) out.push(provider);
  }

  if (out.length === 0) {
    console.error('tts: TTS_PROVIDER_ORDER named no usable provider, using the default order');
    return [...DEFAULT_PROVIDER_ORDER];
  }
  return out;
}

/**
 * The providers this request will actually try, in order.
 *
 * `force` is the `?voice=` query parameter: it exists so a teacher (or we) can
 * A/B the two voices on the same word. It narrows the ladder, it never adds a
 * rung that config left out, and it can never conjure Azure without its key.
 */
export function plannedProviders(env: TtsEnv, force?: string | null): TtsProvider[] {
  let order = parseProviderOrder(env.TTS_PROVIDER_ORDER);

  const wanted = str(force)?.toLowerCase();
  if (wanted !== undefined && (TTS_PROVIDERS as readonly string[]).includes(wanted)) {
    order = order.filter((p) => p === wanted);
  }

  return order.filter((p) => (p === 'azure' ? azureConfigured(env) : true));
}

/**
 * Worst-case paid calls this request may make, to reserve up front.
 *
 * Azure is one call with no retry (its failures are auth, quota, or an outage,
 * none of which a second identical call fixes; the ladder falls to MeloTTS
 * instead). MeloTTS gets its full retry budget because its failure mode is a
 * measured non-deterministic 502.
 */
export function ttsAttemptBudget(env: TtsEnv, maxAttempts: number, force?: string | null): number {
  const perProvider = (p: TtsProvider): number => (p === 'azure' ? 1 : Math.max(1, Math.floor(maxAttempts)));
  return plannedProviders(env, force).reduce((total, p) => total + perProvider(p), 0);
}

/**
 * The cache-key discriminator for this request.
 *
 * The clip cache must not serve an Azure clip to a request that forced
 * MeloTTS, and must not serve yesterday's pacing after the voice or rate var
 * changed, so both the plan and the Azure settings are part of the key.
 */
export function ttsCacheVariant(env: TtsEnv, force?: string | null): string {
  return plannedProviders(env, force)
    .map((p) => (p === 'azure' ? `azure:${azureVoice(env)}:${azureRate(env)}` : p))
    .join('|') || 'none';
}

/**
 * One Azure Neural TTS call. Never throws.
 *
 * A 401/403 (bad or missing key), 429 (quota) or 5xx (outage) all mean the same
 * thing to the caller: this rung is unavailable right now, use the next one.
 * The status is logged; the key never is.
 */
export async function synthesizeAzure(
  env: TtsEnv,
  text: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<Response | null> {
  const key = str(env.AZURE_SPEECH_KEY);
  const region = str(env.AZURE_SPEECH_REGION);
  if (!key || !region) return null;

  const doFetch = options.fetchImpl ?? fetch;
  const body = azureSsml(text, azureVoice(env), azureRate(env));

  let res: Response;
  try {
    res = await doFetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
        // Documented as required. Azure answers 400 without it.
        'User-Agent': 'bilingual-vocab-game',
      },
      body,
    });
  } catch (err) {
    console.error('tts: azure call threw', err instanceof Error ? err.message : err);
    return null;
  }

  if (!res.ok) {
    console.error(`tts: azure returned ${res.status}, falling back to the next provider`);
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error('tts: azure body could not be read', err instanceof Error ? err.message : err);
    return null;
  }
  if (bytes.byteLength === 0) {
    console.error('tts: azure returned an empty body');
    return null;
  }

  return new Response(bytes as BodyInit, {
    headers: {
      'Content-Type': sniffAudioType(bytes),
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': `public, max-age=${TTS_CACHE_SECONDS}`,
      'x-tts-voice': 'azure',
    },
  });
}

/**
 * The Cache API key for one clip. A same-origin GET URL, so it is a legal cache
 * key, and keyed on the normalized text so " 苹果 " and "苹果" share one entry.
 *
 * `variant` is the provider plan for this request (see `ttsCacheVariant`). It
 * is part of the key because the cache must not answer a request that forced
 * one voice with a clip the other voice recorded, and must not keep serving
 * yesterday's pacing after the voice or rate var changed.
 */
export function ttsCacheKey(requestUrl: string, text: string, variant: string): Request {
  const url = new URL('/__tts/v1', requestUrl);
  url.searchParams.set('t', normalizeText(text));
  url.searchParams.set('v', variant);
  return new Request(url.toString(), { method: 'GET' });
}

// --- the ladder --------------------------------------------------------------

export interface LadderResult extends TtsResult {
  /** Which rung produced the audio, or null when every rung failed. */
  provider: TtsProvider | null;
}

/**
 * Walks the provider ladder and returns the first clip anyone produced.
 *
 * `attempts` is the total paid calls made across every rung, which is what the
 * caller refunds against the reservation `ttsAttemptBudget()` sized.
 */
export async function synthesizeLadder(
  env: TtsEnv,
  text: string,
  options: {
    maxAttempts?: number;
    wait?: (ms: number) => Promise<void>;
    fetchImpl?: typeof fetch;
    force?: string | null;
  } = {}
): Promise<LadderResult> {
  let attempts = 0;

  for (const provider of plannedProviders(env, options.force)) {
    if (provider === 'azure') {
      attempts += 1;
      const audio = await synthesizeAzure(env, text, { fetchImpl: options.fetchImpl });
      if (audio) return { audio, attempts, provider };
      continue;
    }

    const result = await synthesize(env, text, {
      maxAttempts: options.maxAttempts,
      wait: options.wait,
    });
    attempts += result.attempts;
    if (result.audio) return { audio: result.audio, attempts, provider };
  }

  return { audio: null, attempts, provider: null };
}

