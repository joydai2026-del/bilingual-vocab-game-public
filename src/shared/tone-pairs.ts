// Minimal tone pairs: the content logic behind Tone Catcher's three gates.
//
// Everything here is pure and runs in the node test environment. It never
// imports `pinyin-pro` and never looks a reading up from the characters: the
// tone of a card is whatever the card's OWN pinyin string says it is. That is
// what makes it polyphone-safe. 重 is chóng or zhòng depending on the word, and
// the set already knows which, so this file trusts the set and nothing else.
//
// The distractor chain, in the order the spec fixed:
//   1. a real minimal pair from the SAME SET (same syllables, different tone)
//   2. a real minimal pair from the small built-in filler list below
//   3. a near neighbour from the set (shares a syllable, a rime, a length)
//   4. a near neighbour from the filler list, so a tiny set still gets 3 lanes

import { seededShuffle } from './rng';

/** The shape a card needs to be usable here. `VocabItem` satisfies it. */
export interface ToneCard {
  zh: string;
  pinyin: string;
  en: string;
}

export type OptionKind = 'answer' | 'set-pair' | 'filler-pair' | 'near' | 'filler-near';

export interface ToneOption extends ToneCard {
  /** One tone number per syllable. 1-4 marked, 5 neutral. */
  tones: number[];
  kind: OptionKind;
}

export interface ToneQuestion extends ToneCard {
  tones: number[];
  /** The lane labels, already shuffled. */
  options: ToneOption[];
  /** Index into `options` of the word that was spoken. */
  correct: number;
}

// --- reading a tone off a pinyin string -------------------------------------

/**
 * The four combining tone marks. Decomposing with NFD turns ā, á, ǎ, à AND
 * ǖ, ǘ, ǚ, ǜ into a base letter plus one of these, so one table covers every
 * vowel including ü (whose own diaeresis, U+0308, is deliberately not here and
 * therefore survives).
 */
const TONE_BY_MARK: Record<string, number> = {
  '\u0304': 1, // macron
  '\u0301': 2, // acute
  '\u030C': 3, // caron
  '\u0300': 4, // grave
};

/** Splits a pinyin string into chunks on spaces, apostrophes and hyphens. */
function chunks(pinyin: string): string[] {
  return pinyin
    .split(/[\s'\u2019\u00b7\-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Tone numbers, one per syllable, left to right.
 *
 * A chunk may hold several syllables when a set writes pinyin unspaced
 * ("píngguǒ"), so tones are counted by MARK, not by chunk: both "píng guǒ" and
 * "píngguǒ" come back as [2, 3]. A chunk with no mark at all is neutral, [5],
 * which is the right answer for "dou" in "dòu dou". Numeric pinyin ("ma1") is
 * accepted too, because teachers paste it.
 */
export function toneSequence(pinyin: string): number[] {
  const out: number[] = [];
  for (const chunk of chunks(pinyin)) {
    const marks: number[] = [];
    for (const ch of chunk.normalize('NFD')) {
      const tone = TONE_BY_MARK[ch];
      if (tone) marks.push(tone);
    }
    if (marks.length) {
      out.push(...marks);
      continue;
    }
    const numbered = chunk.match(/[1-5]/g);
    if (numbered) out.push(...numbered.map(Number));
    else out.push(5);
  }
  return out;
}

/** The tone of a single syllable. 5 when it carries no mark. */
export function toneOf(syllable: string): number {
  return toneSequence(syllable)[0] ?? 5;
}

/**
 * The syllables with every tone stripped, lowercased, joined by spaces.
 * "mā" and "mà" both give "ma"; "píng guǒ" and "píngguǒ" both give "pingguo",
 * so spacing style never decides whether two cards are a pair.
 */
export function baseKey(pinyin: string): string {
  let out = '';
  for (const ch of pinyin.normalize('NFD')) {
    if (TONE_BY_MARK[ch]) continue;
    out += ch;
  }
  return out
    .normalize('NFC')
    .toLowerCase()
    .replace(/u:/g, '\u00fc')
    .replace(/v/g, '\u00fc')
    .replace(/[^a-z\u00fc]/g, '');
}

/** Same syllables, different tones: the pair a tone drill is built on. */
export function isMinimalPair(a: string, b: string): boolean {
  const keyA = baseKey(a);
  if (!keyA || keyA !== baseKey(b)) return false;
  const tonesA = toneSequence(a);
  const tonesB = toneSequence(b);
  if (tonesA.length !== tonesB.length) return false;
  return tonesA.some((tone, i) => tone !== tonesB[i]);
}

/** A card is playable when it can be spoken, labelled and read three ways. */
export function playableToneCards<T extends ToneCard>(items: readonly T[]): T[] {
  return items.filter(
    (item) => item.zh.trim() && item.pinyin.trim() && item.en.trim() && baseKey(item.pinyin)
  );
}

// --- the built-in filler list ------------------------------------------------

/**
 * Common syllables that come in tone families, so a set with no internal pair
 * (four fruits, say) still gets a real minimal pair to choose against. Small on
 * purpose: it is a safety net, not a dictionary. Every gloss is distinct, since
 * Easy mode labels the lanes with glosses.
 */
export const TONE_FILLERS: readonly ToneCard[] = [
  { zh: '\u5988', pinyin: 'm\u0101', en: 'mother' },
  { zh: '\u9ebb', pinyin: 'm\u00e1', en: 'hemp' },
  { zh: '\u9a6c', pinyin: 'm\u01ce', en: 'horse' },
  { zh: '\u9a82', pinyin: 'm\u00e0', en: 'to scold' },
  { zh: '\u516b', pinyin: 'b\u0101', en: 'eight' },
  { zh: '\u62d4', pinyin: 'b\u00e1', en: 'to pull up' },
  { zh: '\u628a', pinyin: 'b\u01ce', en: 'handle' },
  { zh: '\u7238', pinyin: 'b\u00e0', en: 'dad' },
  { zh: '\u732b', pinyin: 'm\u0101o', en: 'cat' },
  { zh: '\u6bdb', pinyin: 'm\u00e1o', en: 'fur' },
  { zh: '\u5e3d', pinyin: 'm\u00e0o', en: 'hat' },
  { zh: '\u4e66', pinyin: 'sh\u016b', en: 'book' },
  { zh: '\u719f', pinyin: 'sh\u00fa', en: 'ripe' },
  { zh: '\u9f20', pinyin: 'sh\u01d4', en: 'mouse' },
  { zh: '\u6811', pinyin: 'sh\u00f9', en: 'tree' },
  { zh: '\u6c64', pinyin: 't\u0101ng', en: 'soup' },
  { zh: '\u7cd6', pinyin: 't\u00e1ng', en: 'candy' },
  { zh: '\u8eba', pinyin: 't\u01ceng', en: 'to lie down' },
  { zh: '\u70eb', pinyin: 't\u00e0ng', en: 'scalding' },
  { zh: '\u9c7c', pinyin: 'y\u00fa', en: 'fish' },
  { zh: '\u96e8', pinyin: 'y\u01d4', en: 'rain' },
  { zh: '\u7389', pinyin: 'y\u00f9', en: 'jade' },
  { zh: '\u9505', pinyin: 'gu\u014d', en: 'pot' },
  { zh: '\u56fd', pinyin: 'gu\u00f3', en: 'country' },
  { zh: '\u679c', pinyin: 'gu\u01d2', en: 'fruit' },
  { zh: '\u8fc7', pinyin: 'gu\u00f2', en: 'to pass' },
  { zh: '\u82b1', pinyin: 'hu\u0101', en: 'flower' },
  { zh: '\u534e', pinyin: 'hu\u00e1', en: 'splendid' },
  { zh: '\u753b', pinyin: 'hu\u00e0', en: 'painting' },
  { zh: '\u9999', pinyin: 'xi\u0101ng', en: 'fragrant' },
  { zh: '\u60f3', pinyin: 'xi\u01ceng', en: 'to think' },
  { zh: '\u8c61', pinyin: 'xi\u00e0ng', en: 'elephant' },
  { zh: '\u70df', pinyin: 'y\u0101n', en: 'smoke' },
  { zh: '\u76d0', pinyin: 'y\u00e1n', en: 'salt' },
  { zh: '\u773c', pinyin: 'y\u01cen', en: 'eye' },
  { zh: '\u71d5', pinyin: 'y\u00e0n', en: 'swallow' },
  { zh: '\u56fe', pinyin: 't\u00fa', en: 'picture' },
  { zh: '\u571f', pinyin: 't\u01d4', en: 'soil' },
  { zh: '\u5154', pinyin: 't\u00f9', en: 'rabbit' },
  { zh: '\u897f', pinyin: 'x\u012b', en: 'west' },
  { zh: '\u4e60', pinyin: 'x\u00ed', en: 'to practise' },
  { zh: '\u6d17', pinyin: 'x\u01d0', en: 'to wash' },
  { zh: '\u7ec6', pinyin: 'x\u00ec', en: 'thin' },
  { zh: '\u7ffb', pinyin: 'f\u0101n', en: 'to turn over' },
  { zh: '\u70e6', pinyin: 'f\u00e1n', en: 'annoyed' },
  { zh: '\u53cd', pinyin: 'f\u01cen', en: 'opposite' },
  { zh: '\u996d', pinyin: 'f\u00e0n', en: 'cooked rice' },
  { zh: '\u5341', pinyin: 'sh\u00ed', en: 'ten' },
  { zh: '\u4f7f', pinyin: 'sh\u01d0', en: 'to make' },
  { zh: '\u662f', pinyin: 'sh\u00ec', en: 'to be' },
  { zh: '\u732a', pinyin: 'zh\u016b', en: 'pig' },
  { zh: '\u7af9', pinyin: 'zh\u00fa', en: 'bamboo' },
  { zh: '\u4e3b', pinyin: 'zh\u01d4', en: 'main' },
  { zh: '\u4f4f', pinyin: 'zh\u00f9', en: 'to live' },
  { zh: '\u5c71', pinyin: 'sh\u0101n', en: 'mountain' },
  { zh: '\u95ea', pinyin: 'sh\u01cen', en: 'to flash' },
  { zh: '\u6247', pinyin: 'sh\u00e0n', en: 'fan' },
  { zh: '\u4e70', pinyin: 'm\u01cei', en: 'to buy' },
  { zh: '\u5356', pinyin: 'm\u00e0i', en: 'to sell' },
  { zh: '\u6c34', pinyin: 'shu\u01d0', en: 'water' },
  { zh: '\u7761', pinyin: 'shu\u00ec', en: 'to sleep' },
  { zh: '\u725b', pinyin: 'ni\u00fa', en: 'cow' },
  { zh: '\u626d', pinyin: 'ni\u01d4', en: 'to twist' },
  { zh: '\u72d7', pinyin: 'g\u01d2u', en: 'dog' },
  { zh: '\u591f', pinyin: 'g\u00f2u', en: 'enough' },
  { zh: '\u5305', pinyin: 'b\u0101o', en: 'bag' },
  { zh: '\u9971', pinyin: 'b\u01ceo', en: 'full' },
  { zh: '\u62b1', pinyin: 'b\u00e0o', en: 'to hug' },
];

// --- picking the other two lanes ---------------------------------------------

/** Splits a base key back into rough syllable-sized pieces for near matching. */
function initialOf(key: string): string {
  const match = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])/.exec(key);
  return match ? match[1] : '';
}

function rimeOf(key: string): string {
  return key.slice(initialOf(key).length);
}

/**
 * How close a card sounds to the answer without being a tone pair. Higher is
 * closer. Deliberately coarse: it only has to beat "a random other word".
 */
function nearScore(answer: ToneCard, other: ToneCard): number {
  const a = baseKey(answer.pinyin);
  const b = baseKey(other.pinyin);
  let score = 0;
  if (toneSequence(answer.pinyin).length === toneSequence(other.pinyin).length) score += 8;
  if (initialOf(a) && initialOf(a) === initialOf(b)) score += 3;
  if (rimeOf(a) && rimeOf(a) === rimeOf(b)) score += 5;
  if (a.length === b.length) score += 1;
  return score;
}

/**
 * Same syllables AND same tones: two labels a learner cannot tell apart by ear.
 *
 * This is deliberately not string equality. "ta1" and "tā" are one sound spelt
 * two ways, and so are "píng guǒ" and "píngguǒ"; `baseKey` already flattens
 * spacing, case and ü/v/u:, and `toneSequence` already reads a tone off either
 * notation, so the two helpers together say what a child's ear would say.
 */
export function sameSound(a: string, b: string): boolean {
  const keyA = baseKey(a);
  if (!keyA || keyA !== baseKey(b)) return false;
  // A neutral syllable carries no mark, so `dōngxi` reads as [1] and `dōng xi`
  // as [1,5]. Pad the shorter list with the neutral tone (5) before comparing;
  // the syllables already matched, so the missing entries can only be neutral.
  // Real minimal pairs (mā / mǎ) still differ at the marked position.
  const tonesA = toneSequence(a);
  const tonesB = toneSequence(b);
  const n = Math.max(tonesA.length, tonesB.length);
  for (let i = 0; i < n; i++) {
    if ((tonesA[i] ?? 5) !== (tonesB[i] ?? 5)) return false;
  }
  return true;
}

/**
 * Two cards may not share a lane label in ANY mode, so all three fields differ,
 * and neither may they SOUND the same.
 *
 * The sound check is the load-bearing half. In Hard mode the lane label is the
 * pinyin, so two lanes reading "ta1" and "tā" ask the child to pick between one
 * word and itself: they hear it right, they pick a lane, and half the time the
 * game marks them wrong. A set that mixes notation, or that carries 苹果 and
 * 蘋果, does this on every single round. When the set has no distinct candidate
 * left, `buildToneQuestion` walks on to the filler list, which always does.
 */
function collides(a: ToneCard, b: ToneCard): boolean {
  return a.zh === b.zh || a.en === b.en || a.pinyin === b.pinyin || sameSound(a.pinyin, b.pinyin);
}

/** True when the string carries at least one Chinese character. */
function hasCjk(s: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿々〇]/.test(s);
}

/**
 * Can this question's lanes be labelled with their meanings?
 *
 * Only when they all read the same way. A set of Chinese definitions that had
 * to borrow one English filler to fill a lane is worse than no meanings at all:
 * the odd lane out is visibly the answer. The caller falls back to the Chinese
 * word itself (the normal-mode label) for that round.
 */
export function readableEasyLanes(question: ToneQuestion): boolean {
  const chinese = question.options.filter((o) => hasCjk(o.en)).length;
  return chinese === 0 || chinese === question.options.length;
}

function asOption(card: ToneCard, kind: OptionKind): ToneOption {
  return {
    zh: card.zh,
    pinyin: card.pinyin,
    en: card.en,
    tones: toneSequence(card.pinyin),
    kind,
  };
}

/**
 * Three lane labels for one spoken word: the answer plus `lanes - 1`
 * distractors, walked down the tier chain until enough are found.
 *
 * `seed` makes the whole thing deterministic, which is what lets a test assert
 * on it and what stops a level toggle reshuffling the round underneath a child.
 */
export function buildToneQuestion(
  answer: ToneCard,
  pool: readonly ToneCard[],
  opts: { lanes?: number; seed?: number } = {}
): ToneQuestion {
  const lanes = Math.max(2, opts.lanes ?? 3);
  const seed = opts.seed ?? 1;
  const chosen: ToneOption[] = [];

  const usable = (card: ToneCard): boolean =>
    !collides(card, answer) && !chosen.some((taken) => collides(card, taken));

  const take = (cards: readonly ToneCard[], kind: OptionKind): void => {
    for (const card of cards) {
      if (chosen.length >= lanes - 1) return;
      if (!usable(card)) continue;
      chosen.push(asOption(card, kind));
    }
  };

  const pairs = (cards: readonly ToneCard[]): ToneCard[] =>
    cards.filter((card) => isMinimalPair(card.pinyin, answer.pinyin));

  const ranked = (cards: readonly ToneCard[]): ToneCard[] =>
    seededShuffle(cards, seed + 811)
      .map((card, i) => ({ card, i, score: nearScore(answer, card) }))
      .sort((x, y) => y.score - x.score || x.i - y.i)
      .map((row) => row.card);

  // A set whose meanings are Chinese sentences (a Chinese-taught class writes
  // no English at all) gets its distractors from the OTHER items in the set,
  // never from the filler list. The fillers carry CEDICT English, so in easy
  // mode the one Chinese lane WAS the answer and the game gave itself away
  // every round (round 1 review). The full chain still runs after these tiers,
  // so the lanes are always filled; `readableEasyLanes` below is what tells the
  // caller whether the meanings it got back can be shown as meanings.
  if (hasCjk(answer.en)) {
    const chinese = pool.filter((card) => hasCjk(card.en));
    take(seededShuffle(pairs(chinese), seed + 17), 'set-pair');
    take(ranked(chinese), 'near');
  }
  // Tier 1 and 2: real minimal pairs, the set before the filler list.
  take(seededShuffle(pairs(pool), seed + 17), 'set-pair');
  take(seededShuffle(pairs(TONE_FILLERS), seed + 29), 'filler-pair');
  // Tier 3 and 4: near neighbours, same order of preference.
  take(ranked(pool), 'near');
  take(ranked(TONE_FILLERS), 'filler-near');

  const all = [asOption(answer, 'answer'), ...chosen];
  const order = seededShuffle(
    all.map((_, i) => i),
    seed + 104729
  );
  const options = order.map((i) => all[i]);

  return {
    zh: answer.zh,
    pinyin: answer.pinyin,
    en: answer.en,
    tones: toneSequence(answer.pinyin),
    options,
    correct: order.indexOf(0),
  };
}

/**
 * A whole round: one question per word, shuffled, capped at `length`
 * (12 by the spec, or the set length when the set is shorter).
 */
export function buildToneRound(
  cards: readonly ToneCard[],
  opts: { lanes?: number; seed?: number; length?: number } = {}
): ToneQuestion[] {
  const playable = playableToneCards(cards);
  const seed = opts.seed ?? 1;
  const want = Math.min(opts.length ?? 12, playable.length);
  return seededShuffle(playable, seed)
    .slice(0, want)
    .map((card, i) =>
      buildToneQuestion(card, playable, { lanes: opts.lanes, seed: seed + i * 7919 + 1 })
    );
}

