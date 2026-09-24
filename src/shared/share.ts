// Share links. The whole vocab set travels inside the URL fragment, so a
// solo link needs no server and never expires.
//
// Wire format: a one-character tag, a dot, then base64url payload.
//   `j.<base64url>`  plain JSON. The default, because every browser can read
//                    it: an older iPad with no DecompressionStream still
//                    opens a normal-sized link.
//   `z.<base64url>`  raw-deflate of the JSON, used only when the plain link
//                    would be over the length cap.
// The tag means an old link keeps working after the encoder changes.
//
// Decoding treats the payload as hostile: it is somebody else's link, pasted
// from a chat app. Both shapes are size-capped before anything is parsed (a
// `z.` link on the bytes it inflates to, a `j.` link on the characters it
// arrives as) and the decoded object is checked field by field before any
// screen is handed it.

import type { VocabSet } from './types';

const DEFLATE_TAG = 'z.';
const JSON_TAG = 'j.';

/** Links longer than this get a "shorten your set" warning in the UI. */
export const MAX_LINK_CHARS = 6000;

/**
 * Hard ceiling on the bytes a `z.` link is allowed to inflate to. A 200-item
 * set is well under 100 KB of JSON, so this only ever stops a deflate bomb
 * (a short link that expands to tens of megabytes and freezes the tab).
 */
export const MAX_INFLATED_BYTES = 256 * 1024;

/**
 * The longest base64url payload a plain `j.` link may carry. Base64 spends 4
 * characters on every 3 bytes, so this is the string length that decodes to
 * `MAX_INFLATED_BYTES`. It is checked on the string, before `atob` runs, so a
 * hostile fragment is refused rather than decoded and then measured.
 */
export const MAX_PLAIN_PAYLOAD_CHARS = Math.ceil(MAX_INFLATED_BYTES / 3) * 4;

/** Field limits, matching the worker's own `validateSet`. */
const MAX_ITEMS = 200;
const MAX_TITLE_CHARS = 200;
const MAX_ID_CHARS = 64;
const MAX_ZH_CHARS = 40;
const MAX_PINYIN_CHARS = 200;
const MAX_EN_CHARS = 200;

export function linkTooLong(encoded: string): boolean {
  return encoded.length > MAX_LINK_CHARS;
}

function hasCompressionStream(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padding = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const binary = atob(b64 + padding);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function drain(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  maxBytes = MAX_INFLATED_BYTES
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('link too big');
      }
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function pump(
  transform: CompressionStream | DecompressionStream,
  bytes: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const writing = (async () => {
    await writer.write(bytes);
    await writer.close();
  })().catch(() => undefined); // a cancelled reader makes the write reject too
  const out = await drain(transform.readable);
  await writing;
  return out;
}

/**
 * Encodes a set for a share link.
 *
 * Plain `j.` is the default so the link opens anywhere, including an iPad
 * whose Safari predates DecompressionStream. Deflate is reached for only when
 * the plain link would be over `MAX_LINK_CHARS`, where a `z.` link that some
 * old browser cannot open still beats a link no browser will send.
 * `forcePlain` exists so tests can pin the plain path.
 */
export async function encodeSet(set: VocabSet, forcePlain = false): Promise<string> {
  const json = JSON.stringify(set);
  const bytes = new Uint8Array(new TextEncoder().encode(json)) as Uint8Array<ArrayBuffer>;
  const plain = JSON_TAG + bytesToBase64url(bytes);

  if (forcePlain || !linkTooLong(plain) || !hasCompressionStream()) return plain;

  try {
    const deflated = await pump(new CompressionStream('deflate-raw'), bytes);
    return DEFLATE_TAG + bytesToBase64url(deflated);
  } catch {
    return plain;
  }
}

/** Decodes a share-link payload produced by `encodeSet`. */
export async function decodeSet(encoded: string): Promise<VocabSet> {
  const text = (encoded ?? '').trim();
  const tag = text.slice(0, 2);
  const payload = text.slice(2);

  let json: string;
  if (tag === DEFLATE_TAG) {
    if (!hasCompressionStream()) {
      throw new Error('This link needs a newer browser to open.');
    }
    const inflated = await pump(new DecompressionStream('deflate-raw'), base64urlToBytes(payload));
    json = new TextDecoder().decode(inflated);
  } else if (tag === JSON_TAG) {
    // A plain link is not compressed, so nothing here can expand. The cap is
    // against the raw size: 4 MB of base64 pasted into the address bar would
    // otherwise be decoded and handed to JSON.parse before anyone checked it.
    if (payload.length > MAX_PLAIN_PAYLOAD_CHARS) throw new Error('link too big');
    const bytes = base64urlToBytes(payload);
    if (bytes.length > MAX_INFLATED_BYTES) throw new Error('link too big');
    json = new TextDecoder().decode(bytes);
  } else {
    throw new Error('That link is not a vocab set link.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That link is not a vocab set link.');
  }
  return validateDecodedSet(parsed);
}

function isString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/**
 * Checks a decoded payload field by field before any screen sees it. Anything
 * off throws a message a teacher can read; `main.ts` turns that into the
 * "This link did not open" screen.
 */
export function validateDecodedSet(value: unknown): VocabSet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('That link is not a vocab set link.');
  }
  const set = value as Record<string, unknown>;

  if (set.v !== 1) throw new Error('That link was made by a different version of this app.');
  if (!isString(set.title, MAX_TITLE_CHARS)) throw new Error('That link has no readable title.');
  if (set.level !== 'kids' && set.level !== 'big') {
    throw new Error('That link does not say who it is for.');
  }
  if (!Array.isArray(set.items)) throw new Error('That link is missing its word list.');
  if (set.items.length === 0) throw new Error('That link has no words in it.');
  if (set.items.length > MAX_ITEMS) {
    throw new Error(`That link has more than ${MAX_ITEMS} words in it.`);
  }

  const ids = new Set<string>();
  for (const raw of set.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('That link has a word we could not read.');
    }
    const item = raw as Record<string, unknown>;
    if (!isString(item.id, MAX_ID_CHARS) || item.id.trim() === '') {
      throw new Error('That link has a word with no id.');
    }
    if (!isString(item.zh, MAX_ZH_CHARS) || item.zh.trim() === '') {
      throw new Error('That link has a word with no Chinese in it.');
    }
    if (!isString(item.pinyin, MAX_PINYIN_CHARS)) {
      throw new Error('That link has a word we could not read.');
    }
    if (!isString(item.en, MAX_EN_CHARS)) {
      throw new Error('That link has a word we could not read.');
    }
    if (ids.has(item.id)) throw new Error('That link has the same word id twice.');
    ids.add(item.id);
  }

  return set as unknown as VocabSet;
}

