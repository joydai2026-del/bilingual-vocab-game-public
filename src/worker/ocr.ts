// Reading a photo or screenshot of a word list.
//
// This is a ladder, not one provider. The worker tries each name in
// OCR_PROVIDER_ORDER and returns the first that produces text:
//
//   azure      Azure AI Vision Read. A purpose-built OCR engine, so it wins
//              when it is available. Runs only when both AZURE_VISION_KEY and
//              AZURE_VISION_ENDPOINT are set, so it is simply skipped on an
//              install that has no Azure account.
//   workersai  @cf/meta/llama-3.2-11b-vision-instruct through the AI binding
//              that already exists for /api/enrich and /api/tts. No account,
//              no key, nothing to buy: this is what makes the photo button
//              work on a fresh checkout.
//
// Both rungs are one paid call each and both are charged to the same daily OCR
// quota: the caller reserves `ocrAttemptBudget()` calls up front and refunds
// the ones the ladder did not make.
//
// The 501 survives for exactly one case: an order that names only providers
// this install cannot run (`OCR_PROVIDER_ORDER=azure` with no Azure secrets).
//
// ---------------------------------------------------------------------------
// Azure rung
//
// API contract, verified against Microsoft's own docs on 2026-09-08 (grade B,
// docs and not a live call: the Azure resource does not exist yet):
//
//   POST <endpoint>/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read
//   header  Ocp-Apim-Subscription-Key: <key>
//   header  Content-Type: application/octet-stream   (raw image bytes in the body)
//   200     { "readResult": { "blocks": [ { "lines": [ { "text": "..." } ] } ] } }
//
//   https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/how-to/call-analyze-image-40
//   https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/language-support
//
// On the language parameter, which is deliberately NOT sent by default. The
// language-support page says of Read: "Do not provide the language code as the
// parameter unless you are sure about the language and want to force the
// service to apply only the relevant model. Otherwise, the service may return
// incomplete and incorrect text." A vocab list is Chinese AND English on the
// same line, which is exactly the mixed case the universal model is built for
// and a forced zh-Hans would damage. The knob still exists as the OCR_LANGUAGE
// var for anyone who wants to force it (zh-Hans is the Read code for Simplified
// Chinese; zh is an Image Analysis code, not a Read one).
//
// ---------------------------------------------------------------------------
// Workers AI rung
//
// Model existence verified LIVE on 2026-09-08 against the real Workers AI
// service through `wrangler dev` (grade A for "this model resolves"): a made-up
// name answers `5007: No such model`, while
// `@cf/meta/llama-3.2-11b-vision-instruct` and `@cf/llava-hf/llava-1.5-7b-hf`
// both answer `4006: you have used up your daily free allocation of 10,000
// neurons`. Only a model the service knows gets as far as the neuron check.
// `@cf/qwen/qwen2.5-vl-7b-instruct` answers 5007 and does NOT exist.
//
// The request and response SHAPES come from the type the account's own
// wrangler ships (@cloudflare/workers-types,
// `Ai_Cf_Meta_Llama_3_2_11B_Vision_Instruct_Input` / `_Output`, grade B): the
// input takes `{ prompt, image?: number[] | string, max_tokens }` and the
// output carries the text in `response`. The free neuron budget for the day was
// already spent when this shipped, so no end-to-end photo has been read live
// yet; every branch below is covered by the fake-runner tests instead.
//
// `image` is sent as a plain byte array, the first member of that input union.
// A 4 MB photo is therefore a 4-million-element array, which is why
// OCR_MAX_BYTES stays where it is: raising it costs worker memory, not just
// upload time.

// A structural slice of the `AI` binding rather than `Env` from ./index, for
// the reason spelled out in tts.ts and enrich.ts: importing Env would drag the
// ambient Cloudflare Workers types into every file that imports this one,
// including tests/worker.test.ts, which is typechecked without them.
import type { AiRunner } from './tts';

/** What the teacher reads when no configured provider can actually run. */
export const OCR_NOT_SET_UP = 'Photo reading is not set up yet.';

export const OCR_WRONG_TYPE =
  'That file is not a photo. Take a picture, or use a screenshot saved as JPG, PNG or WebP.';

export const OCR_TOO_BIG = 'That photo is too big. Take it again, or use a smaller screenshot.';

export const OCR_EMPTY = 'Please choose a photo first.';

export const OCR_FAILED =
  'Could not read that photo. Try a clearer picture, or type the words in instead.';

export const OCR_NO_TEXT =
  'No words were found in that photo. Try a clearer picture with the list filling the frame.';

/** Image types the route accepts. Everything else is refused before any spend. */
export const OCR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export function isAllowedImageType(contentType: string | null): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return (OCR_CONTENT_TYPES as readonly string[]).includes(type);
}

export interface OcrConfig {
  endpoint: string;
  key: string;
  /** Optional forced Read language, e.g. zh-Hans. Absent means auto-detect. */
  language?: string;
}

/** What the Azure rung alone reads. Split out so it can be checked without AI. */
export interface AzureOcrEnv {
  AZURE_VISION_ENDPOINT?: string;
  AZURE_VISION_KEY?: string;
  OCR_LANGUAGE?: string;
}

/** What choosing the ladder reads: config only, no binding needed. */
export interface OcrOrderEnv extends AzureOcrEnv {
  /** Comma-separated provider order, e.g. "azure,workersai". */
  OCR_PROVIDER_ORDER?: string;
}

/** Everything running the ladder needs. `Env` in ./index satisfies it. */
export interface OcrEnv extends OcrOrderEnv {
  AI: AiRunner;
}

/** The rungs of the ladder, in the only order the code knows how to run them. */
export type OcrProvider = 'azure' | 'workersai';

/** Every provider name `OCR_PROVIDER_ORDER` may contain. */
export const OCR_PROVIDERS: readonly OcrProvider[] = ['azure', 'workersai'];

/** Used when OCR_PROVIDER_ORDER is missing, empty, or entirely unrecognised. */
export const DEFAULT_OCR_PROVIDER_ORDER: readonly OcrProvider[] = ['azure', 'workersai'];

/** The Workers AI vision model. Existence live-verified, see the file header. */
export const OCR_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

/**
 * What the vision model is asked to do.
 *
 * Deliberately narrow. This is a transcription job, not a translation or a
 * tidy-up job: the teacher checks the words in the same box she would have
 * typed them into, so anything the model invents is worse than a gap. Pinyin
 * tone marks are named explicitly because a general "read the text" prompt
 * tends to drop them.
 */
export const OCR_PROMPT = [
  'Transcribe every line of text in this image exactly, one line per row.',
  'Keep Chinese characters, pinyin (including tone marks) and English exactly as they appear.',
  'Do not translate, reorder, correct or explain anything.',
  'Output plain text only, with no commentary, no numbering and no code fences.',
].join(' ');

/** Tokens one photo may generate. A page of a word list is well under this. */
export const OCR_MAX_TOKENS = 1024;

function trimmed(raw: unknown): string | undefined {
  const text = String(raw ?? '').trim();
  return text === '' ? undefined : text;
}

/**
 * Reads `OCR_PROVIDER_ORDER`, e.g. "azure,workersai".
 *
 * Unknown names are dropped with a log rather than crashing the route, and an
 * order that ends up empty falls back to the default. A typo in config must not
 * be able to switch photo reading off. An order that names a REAL provider this
 * install cannot run is respected, because that is a deliberate choice and not
 * a typo, and it is what leaves the 501 reachable.
 */
export function parseOcrProviderOrder(raw: unknown): OcrProvider[] {
  const text = trimmed(raw);
  if (text === undefined) return [...DEFAULT_OCR_PROVIDER_ORDER];

  const out: OcrProvider[] = [];
  for (const part of text.split(',')) {
    const name = part.trim().toLowerCase();
    if (name === '') continue;
    if (!(OCR_PROVIDERS as readonly string[]).includes(name)) {
      console.error(`ocr: unknown provider "${name}" in OCR_PROVIDER_ORDER, ignoring it`);
      continue;
    }
    const provider = name as OcrProvider;
    if (!out.includes(provider)) out.push(provider);
  }

  if (out.length === 0) {
    console.error('ocr: OCR_PROVIDER_ORDER named no usable provider, using the default order');
    return [...DEFAULT_OCR_PROVIDER_ORDER];
  }
  return out;
}

/**
 * The providers this request will actually try, in order.
 *
 * Azure drops out unless both of its secrets are readable, so the shipped
 * default "azure,workersai" means Workers AI on an install with no Azure
 * account, and Azure first the day one is created. No code change either way.
 */
export function plannedOcrProviders(env: OcrOrderEnv | undefined): OcrProvider[] {
  const order = parseOcrProviderOrder(env?.OCR_PROVIDER_ORDER);
  return order.filter((p) => (p === 'azure' ? readOcrConfig(env) !== null : true));
}

/**
 * Worst-case paid calls one photo may make, to reserve up front.
 *
 * One per rung: neither provider is retried. A retry would double the bill on
 * the failure a teacher is most likely to hit (a blurry photo), and pressing
 * the button again is a better answer than spending twice unasked.
 */
export function ocrAttemptBudget(env: OcrOrderEnv | undefined): number {
  return plannedOcrProviders(env).length;
}

/**
 * Reads the Vision secrets. Returns null when either is missing, which is what
 * makes the route answer 501 instead of pretending to work. Both are set with
 * `wrangler secret put`, so they are absent on a fresh checkout by design.
 */
export function readOcrConfig(env: AzureOcrEnv | undefined): OcrConfig | null {
  const endpoint = String(env?.AZURE_VISION_ENDPOINT ?? '').trim();
  const key = String(env?.AZURE_VISION_KEY ?? '').trim();
  if (!endpoint || !key) return null;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    console.error('ocr: AZURE_VISION_ENDPOINT is not a URL');
    return null;
  }
  if (parsed.protocol !== 'https:') {
    console.error('ocr: AZURE_VISION_ENDPOINT must be https');
    return null;
  }

  const language = String(env?.OCR_LANGUAGE ?? '').trim();
  return {
    endpoint: parsed.origin + parsed.pathname.replace(/\/+$/, ''),
    key,
    language: language || undefined,
  };
}

/** The analyze URL for one request. */
export function buildAnalyzeUrl(config: OcrConfig): string {
  const url = new URL(`${config.endpoint}/computervision/imageanalysis:analyze`);
  url.searchParams.set('api-version', '2024-02-01');
  url.searchParams.set('features', 'read');
  if (config.language) url.searchParams.set('language', config.language);
  return url.toString();
}

/**
 * Pulls the text out of an Image Analysis 4.0 answer, one line per line of the
 * page, in the order Azure returned them. Anything unexpected in the shape is
 * skipped rather than thrown on, because a partly readable photo is still worth
 * handing to the teacher.
 */
export function extractText(payload: unknown): string {
  const blocks = (payload as { readResult?: { blocks?: unknown } } | null)?.readResult?.blocks;
  if (!Array.isArray(blocks)) return '';

  const lines: string[] = [];
  for (const block of blocks) {
    const blockLines = (block as { lines?: unknown } | null)?.lines;
    if (!Array.isArray(blockLines)) continue;
    for (const line of blockLines) {
      const text = (line as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && text.trim()) lines.push(text.trim());
    }
  }
  return lines.join('\n');
}

export type OcrResult =
  | { ok: true; text: string; attempts: number }
  | { ok: false; status: number; error: string; attempts: number };

/**
 * Sends one image to Azure and returns the text.
 *
 * Exactly one attempt. A retry here would double the bill on the failure the
 * teacher is most likely to hit (a blurry photo), and pressing the button again
 * is a better answer than spending twice without being asked. `attempts` is 0
 * when nothing reached Azure, so the quota reservation is given straight back.
 */
export async function runOcr(
  config: OcrConfig,
  bytes: ArrayBuffer,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
): Promise<OcrResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(buildAnalyzeUrl(config), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': config.key,
        // Azure takes application/octet-stream for raw bytes. The browser's own
        // type is never forwarded, so a mislabelled upload cannot steer it.
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`ocr: azure answered ${response.status}`);
      return { ok: false, status: 502, error: OCR_FAILED, attempts: 1 };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      console.error('ocr: azure answer was not JSON');
      return { ok: false, status: 502, error: OCR_FAILED, attempts: 1 };
    }

    const text = extractText(payload);
    if (!text) return { ok: false, status: 422, error: OCR_NO_TEXT, attempts: 1 };
    return { ok: true, text, attempts: 1 };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    console.error('ocr: azure call failed', err instanceof Error ? err.message : err);
    return { ok: false, status: aborted ? 504 : 502, error: OCR_FAILED, attempts: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a raw request body with a hard byte ceiling.
 *
 * The same two-check shape /api/enrich uses for JSON: Content-Length catches
 * the honest case before a byte is buffered, the streaming counter catches a
 * chunked body that lies about (or omits) its length.
 */
export async function readImageBounded(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false }> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return { ok: false };
  }

  const body = request.body;
  if (!body) return { ok: true, bytes: new ArrayBuffer(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged.buffer };
}

/**
 * Turns whatever the vision model said into the lines the teacher will check.
 *
 * The prompt asks for plain text, but an instruct model wrapping its answer in
 * a ``` fence is common enough to be worth undoing, and blank lines are noise
 * in the parser downstream. Nothing else is touched: a "fix" that rewrote what
 * the model read would be inventing vocabulary.
 */
export function cleanOcrText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();

  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1];

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Pulls the text out of a Workers AI answer.
 *
 * `response` is where the shipped type puts it. A bare string is accepted too,
 * the way enrich.ts does, because the binding has returned one in the past and
 * it costs one line to survive it.
 */
export function extractModelText(payload: unknown): string {
  if (typeof payload === 'string') return cleanOcrText(payload);
  if (!payload || typeof payload !== 'object') return '';
  return cleanOcrText((payload as { response?: unknown }).response);
}

/**
 * True when the answer carries a text field at all, whatever it says.
 *
 * This is the malformed-versus-empty test: `{ response: "" }` is a model that
 * read the photo and found nothing, while `{ foo: 1 }`, `null` and a number are
 * a model whose answer we cannot read.
 */
export function isReadableModelAnswer(payload: unknown): boolean {
  if (typeof payload === 'string') return true;
  if (!payload || typeof payload !== 'object') return false;
  return typeof (payload as { response?: unknown }).response === 'string';
}

/**
 * One Workers AI vision call. Never throws.
 *
 * `attempts` is 1 for every outcome except the timeout, because by then the
 * call has been handed to the service and there is no honest way to claim it
 * was free. The timeout races the call rather than aborting it: the AI binding
 * takes no signal, so this bounds how long the TEACHER waits, and the attempt
 * is still charged for the same reason.
 */
export async function runWorkersAiOcr(
  env: OcrEnv,
  bytes: ArrayBuffer,
  timeoutMs: number
): Promise<OcrResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const call = env.AI.run(OCR_MODEL, {
      prompt: OCR_PROMPT,
      image: [...new Uint8Array(bytes)],
      max_tokens: OCR_MAX_TOKENS,
    });
    // The losing promise must not become an unhandled rejection.
    call.catch(() => undefined);

    const TIMED_OUT = Symbol('ocr-timeout');
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });

    const raced = await Promise.race([call, deadline]);
    if (raced === TIMED_OUT) {
      console.error(`ocr: ${OCR_MODEL} did not answer within ${timeoutMs}ms`);
      return { ok: false, status: 504, error: OCR_FAILED, attempts: 1 };
    }

    // Two different failures hide behind "no text", and the teacher needs to be
    // told them apart: a model that answered in a shape we cannot read is
    // broken (502, and the ladder tries the next rung), while a model that
    // answered with an empty transcription read the photo and found nothing
    // (422, and the ladder stops, because a second opinion costs money and
    // changes nothing).
    if (!isReadableModelAnswer(raced)) {
      console.error(`ocr: ${OCR_MODEL} returned an unusable shape`);
      return { ok: false, status: 502, error: OCR_FAILED, attempts: 1 };
    }

    const text = extractModelText(raced);
    if (!text) return { ok: false, status: 422, error: OCR_NO_TEXT, attempts: 1 };

    return { ok: true, text, attempts: 1 };
  } catch (err) {
    console.error(`ocr: ${OCR_MODEL} call threw`, err instanceof Error ? err.message : err);
    return { ok: false, status: 502, error: OCR_FAILED, attempts: 1 };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs the ladder and returns the first rung that produced text.
 *
 * "No words in this photo" (422) STOPS the ladder rather than falling through.
 * It is a real answer about the photo, not a provider being unavailable, and
 * paying a second provider to agree helps nobody. A provider that failed (502,
 * 504) falls through to the next one, and `attempts` adds up across every rung
 * that was actually called so the caller refunds exactly what was not spent.
 *
 * `providers` is passed in rather than recomputed so the caller reserves quota
 * against the same list this will run. An empty list is a caller bug: the route
 * answers 501 before it gets here.
 */
export async function runOcrLadder(
  env: OcrEnv,
  providers: readonly OcrProvider[],
  bytes: ArrayBuffer,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
): Promise<OcrResult> {
  let attempts = 0;
  let last: OcrResult = { ok: false, status: 502, error: OCR_FAILED, attempts: 0 };

  for (const provider of providers) {
    let result: OcrResult;
    if (provider === 'azure') {
      const config = readOcrConfig(env);
      // Cannot happen for a list from plannedOcrProviders, but a caller that
      // hand-rolls one must not be able to send a keyless request to Azure.
      if (!config) continue;
      result = await runOcr(config, bytes, timeoutMs, fetchImpl);
    } else {
      result = await runWorkersAiOcr(env, bytes, timeoutMs);
    }

    attempts += result.attempts;
    if (result.ok) return { ...result, attempts };
    if (result.status === 422) return { ...result, attempts };
    last = result;
  }

  return { ...last, attempts };
}

