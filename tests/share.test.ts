import { describe, it, expect } from 'vitest';
import {
  encodeSet,
  decodeSet,
  linkTooLong,
  validateDecodedSet,
  MAX_LINK_CHARS,
  MAX_INFLATED_BYTES,
  MAX_PLAIN_PAYLOAD_CHARS,
} from '../src/shared/share';
import type { VocabItem, VocabSet } from '../src/shared/types';

function makeSet(n: number, title = 'Animals'): VocabSet {
  const items: VocabItem[] = Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    zh: `汉字${i}`,
    pinyin: `hàn zì ${i}`,
    en: `word ${i}`,
  }));
  return { v: 1, title, level: 'kids', items };
}

function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonLink(value: unknown): string {
  return 'j.' + toBase64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function deflateLink(text: string): Promise<string> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(new TextEncoder().encode(text)).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return 'z.' + toBase64url(out);
}

/** The smallest set whose plain link is over the length cap. */
async function overCapSet(): Promise<VocabSet> {
  let n = 80;
  for (;;) {
    const set = makeSet(n);
    if (linkTooLong(await encodeSet(set, true))) return set;
    n += 20;
  }
}

describe('encodeSet / decodeSet', () => {
  it('round-trips through the plain-JSON path (j. prefix)', async () => {
    const set = makeSet(12);
    const encoded = await encodeSet(set);
    expect(encoded.startsWith('j.')).toBe(true);
    await expect(decodeSet(encoded)).resolves.toEqual(set);
  });

  it('round-trips through the deflate path (z. prefix)', async () => {
    const set = await overCapSet();
    const encoded = await encodeSet(set);
    expect(encoded.startsWith('z.')).toBe(true);
    await expect(decodeSet(encoded)).resolves.toEqual(set);
  });

  it('stays plain for every set that fits under the length cap', async () => {
    // An iPad Safari with no DecompressionStream must be able to open a
    // normal-sized link, so deflate is only reached for oversized ones.
    for (const n of [1, 9, 20, 40]) {
      const encoded = await encodeSet(makeSet(n));
      expect(encoded.startsWith('j.')).toBe(true);
      expect(linkTooLong(encoded)).toBe(false);
    }
  });

  it('only reaches for deflate once the plain link is over the cap', async () => {
    const set = await overCapSet();
    expect(linkTooLong(await encodeSet(set, true))).toBe(true);
    expect((await encodeSet(set)).length).toBeLessThan(
      (await encodeSet(set, true)).length
    );
  });

  it('keeps Chinese characters and tone marks intact', async () => {
    const set: VocabSet = {
      v: 1,
      title: '第一课 · 问候',
      level: 'big',
      items: [{ id: 'a', zh: '绿', pinyin: 'lǜ', en: 'green' }],
    };
    for (const plain of [false, true]) {
      const decoded = await decodeSet(await encodeSet(set, plain));
      expect(decoded).toEqual(set);
    }
  });

  it('produces url-safe output with no padding', async () => {
    const encoded = await encodeSet(makeSet(30));
    expect(encoded.slice(2)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a payload with an unknown prefix', async () => {
    await expect(decodeSet('x.abcdef')).rejects.toThrow(/not a vocab set link/);
  });

  it('rejects base64 that is not JSON at all', async () => {
    const junk = 'j.' + toBase64url(new TextEncoder().encode('not json {{{'));
    await expect(decodeSet(junk)).rejects.toThrow(/not a vocab set link/);
  });

  it('rejects an empty payload', async () => {
    await expect(decodeSet('')).rejects.toThrow(/not a vocab set link/);
    await expect(decodeSet('j.')).rejects.toThrow(/not a vocab set link/);
  });
});

describe('decodeSet: hostile and mangled links', () => {
  it('refuses a deflate bomb instead of inflating it', async () => {
    const bomb = await deflateLink('a'.repeat(MAX_INFLATED_BYTES * 8));
    expect(bomb.length).toBeLessThan(MAX_LINK_CHARS);
    await expect(decodeSet(bomb)).rejects.toThrow(/link too big/);
  });

  it('refuses an oversized plain link without decoding it', async () => {
    // A `j.` link cannot expand, so the guard is on the characters that
    // arrive: 4 MB of base64 must be refused before atob and JSON.parse ever
    // see it. `A` decodes cleanly, so nothing but the size test can reject it.
    const huge = 'j.' + 'A'.repeat(MAX_PLAIN_PAYLOAD_CHARS + 4);
    await expect(decodeSet(huge)).rejects.toThrow(/link too big/);
  });

  it('caps a plain link at the same 256 KB ceiling as an inflated one', async () => {
    // The character cap rounds up, so a payload of exactly that length still
    // decodes to a couple of bytes over 256 KB. The byte check behind it is
    // what closes that gap, and this is the case that proves it runs.
    const atCharCap = 'j.' + 'A'.repeat(MAX_PLAIN_PAYLOAD_CHARS);
    await expect(decodeSet(atCharCap)).rejects.toThrow(/link too big/);

    // Four characters lower is 262143 bytes: inside the ceiling, so it gets
    // through the size gate and is refused on its contents instead.
    const underCap = 'j.' + 'A'.repeat(MAX_PLAIN_PAYLOAD_CHARS - 4);
    await expect(decodeSet(underCap)).rejects.toThrow(/not a vocab set link/);
  });

  it('opens a real link that is nowhere near the cap', async () => {
    const set = makeSet(40);
    const encoded = await encodeSet(set, true);
    expect(encoded.length - 2).toBeLessThan(MAX_PLAIN_PAYLOAD_CHARS);
    await expect(decodeSet(encoded)).resolves.toEqual(set);
  });

  it('rejects items that are not objects', async () => {
    await expect(
      decodeSet(jsonLink({ v: 1, title: 'x', level: 'kids', items: [null, 42, 'nope'] }))
    ).rejects.toThrow(/could not read/);
  });

  it('rejects a wrong version', async () => {
    await expect(
      decodeSet(jsonLink({ v: 2, title: 'x', level: 'kids', items: [] }))
    ).rejects.toThrow(/different version/);
  });

  it('rejects an unknown level', async () => {
    await expect(
      decodeSet(
        jsonLink({ v: 1, title: 'x', level: 'grown', items: [{ id: 'a', zh: '猫', pinyin: '', en: 'cat' }] })
      )
    ).rejects.toThrow(/who it is for/);
  });

  it('rejects an empty word list', async () => {
    await expect(
      decodeSet(jsonLink({ v: 1, title: 'x', level: 'kids', items: [] }))
    ).rejects.toThrow(/no words in it/);
  });

  it('rejects more than 200 words', async () => {
    const set = makeSet(201);
    await expect(decodeSet(jsonLink(set))).rejects.toThrow(/more than 200 words/);
  });

  it('rejects duplicate ids', async () => {
    await expect(
      decodeSet(
        jsonLink({
          v: 1,
          title: 'x',
          level: 'kids',
          items: [
            { id: 'a', zh: '猫', pinyin: '', en: 'cat' },
            { id: 'a', zh: '狗', pinyin: '', en: 'dog' },
          ],
        })
      )
    ).rejects.toThrow(/same word id twice/);
  });

  it('rejects an over-long field', async () => {
    await expect(
      decodeSet(
        jsonLink({
          v: 1,
          title: 'x',
          level: 'kids',
          items: [{ id: 'a'.repeat(65), zh: '猫', pinyin: '', en: 'cat' }],
        })
      )
    ).rejects.toThrow(/no id/);
    await expect(
      decodeSet(
        jsonLink({
          v: 1,
          title: 'x',
          level: 'kids',
          items: [{ id: 'a', zh: '猫', pinyin: '', en: 'e'.repeat(201) }],
        })
      )
    ).rejects.toThrow(/could not read/);
  });

  it('rejects a missing word list', async () => {
    await expect(decodeSet(jsonLink({ v: 1, title: 'x', level: 'kids' }))).rejects.toThrow(
      /missing its word list/
    );
  });

  it('rejects a top-level array', async () => {
    await expect(decodeSet(jsonLink([1, 2, 3]))).rejects.toThrow(/not a vocab set link/);
  });
});

describe('validateDecodedSet', () => {
  it('returns the set unchanged when everything is in order', () => {
    const set = makeSet(3);
    expect(validateDecodedSet(JSON.parse(JSON.stringify(set)))).toEqual(set);
  });
});

describe('linkTooLong', () => {
  it('is false for a normal set and true past the cap', async () => {
    expect(linkTooLong(await encodeSet(makeSet(20)))).toBe(false);
    expect(linkTooLong('z.' + 'a'.repeat(MAX_LINK_CHARS))).toBe(true);
  });
});

