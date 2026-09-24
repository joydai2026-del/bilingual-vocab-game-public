// Reveal Rush, the pure half: which words are worth hiding, the twelve-tile
// grid and the clip rectangles it produces, when the guess prompt opens, what a
// wrong guess costs, and the score.
//
// Node environment, no DOM, no WebGL. The renderers are not tested here; the
// render gate (tests/e2e/verify-reveal-rush.cjs) is what looks at those.

import { describe, expect, it } from 'vitest';

import {
  GRID_COLS,
  GRID_ROWS,
  OWED_AFTER_WRONG_GUESS,
  SIMPLE_GLYPHS,
  TILE_COUNT,
  WORDS_PER_ROUND,
  afterWrongGuess,
  clipPathFor,
  guessPrompt,
  guessUnlocked,
  hideTier,
  newTileRound,
  pickHiddenItems,
  popOrder,
  popTile,
  revealDisabledReason,
  roundLength,
  scoreForRound,
  sideQuestions,
  solveRound,
  tileRect,
  tileRectPx,
  tilesLeft,
  visibleFraction,
} from '../src/client/games/reveal-rush';
import type { VocabItem, VocabSet } from '../src/shared/types';

const FRUIT: Array<[string, string, string]> = [
  ['苹果', 'píng guǒ', 'apple'],
  ['香蕉', 'xiāng jiāo', 'banana'],
  ['葡萄', 'pú tao', 'grape'],
  ['西瓜', 'xī guā', 'watermelon'],
  ['草莓', 'cǎo méi', 'strawberry'],
  ['橙子', 'chéng zi', 'orange'],
  ['桃子', 'táo zi', 'peach'],
  ['梨', 'lí', 'pear'],
];

function item(zh: string, pinyin: string, en: string, n: number): VocabItem {
  return { id: `i${n}`, zh, pinyin, en };
}

const SET: VocabSet = {
  v: 1,
  title: 'Fruit',
  level: 'kids',
  items: FRUIT.map(([zh, py, en], i) => item(zh, py, en, i)),
};

function setOf(rows: Array<[string, string]>): VocabSet {
  return {
    v: 1,
    title: 'T',
    level: 'big',
    items: rows.map(([zh, en], i) => item(zh, '', en, i)),
  };
}

// --- which words are worth hiding -------------------------------------------

describe('hideTier', () => {
  it('puts multi-character words at the top', () => {
    expect(hideTier('苹果')).toBe(2);
    expect(hideTier('西瓜')).toBe(2);
  });

  it('puts an interesting single character in the middle', () => {
    expect(hideTier('梨')).toBe(1);
    expect(hideTier('猫')).toBe(1);
  });

  it('puts the very plain glyphs at the bottom', () => {
    for (const glyph of Array.from(SIMPLE_GLYPHS)) {
      expect(hideTier(glyph)).toBe(0);
    }
  });

  it('treats an empty or blank word as worthless, not as a crash', () => {
    expect(hideTier('')).toBe(0);
    expect(hideTier('   ')).toBe(0);
  });
});

describe('pickHiddenItems', () => {
  it('prefers multi-character words over any single character', () => {
    const mixed = setOf([
      ['日', 'sun'],
      ['苹果', 'apple'],
      ['人', 'person'],
      ['香蕉', 'banana'],
      ['梨', 'pear'],
    ]);
    const picked = pickHiddenItems(mixed.items, 2, 7);
    expect(picked.map((p) => p.zh).sort()).toEqual(['苹果', '香蕉']);
  });

  it('takes an interesting single character before a plain one', () => {
    const mixed = setOf([
      ['日', 'sun'],
      ['人', 'person'],
      ['梨', 'pear'],
    ]);
    expect(pickHiddenItems(mixed.items, 1, 3)[0].zh).toBe('梨');
  });

  it('falls back to the plain glyphs rather than returning an empty round', () => {
    const plain = setOf([
      ['日', 'sun'],
      ['月', 'moon'],
      ['大', 'big'],
    ]);
    expect(pickHiddenItems(plain.items, 3, 1)).toHaveLength(3);
  });

  it('never returns more than the set holds', () => {
    expect(pickHiddenItems(SET.items, 99, 1)).toHaveLength(SET.items.length);
    expect(pickHiddenItems([], 5, 1)).toHaveLength(0);
  });

  it('is deterministic for a seed and varies between seeds', () => {
    const a = pickHiddenItems(SET.items, 4, 42).map((i) => i.id);
    const b = pickHiddenItems(SET.items, 4, 42).map((i) => i.id);
    expect(a).toEqual(b);
    const seeds = new Set(
      [1, 2, 3, 4, 5, 6].map((s) => pickHiddenItems(SET.items, 4, s).map((i) => i.id).join(','))
    );
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('skips a word with no characters in it', () => {
    const withBlank = setOf([
      ['', 'nothing'],
      ['苹果', 'apple'],
    ]);
    expect(pickHiddenItems(withBlank.items, 5, 1).map((i) => i.zh)).toEqual(['苹果']);
  });
});

describe('roundLength', () => {
  it('is the spec\'s three to five', () => {
    expect(WORDS_PER_ROUND).toEqual({ easy: 3, normal: 4, hard: 5 });
    expect(roundLength('easy', 20)).toBe(3);
    expect(roundLength('normal', 20)).toBe(4);
    expect(roundLength('hard', 20)).toBe(5);
  });

  it('never asks for more words than the set has', () => {
    expect(roundLength('hard', 2)).toBe(2);
    expect(roundLength('easy', 0)).toBe(0);
  });
});

// --- the grid and the clip ---------------------------------------------------

describe('tileRect', () => {
  it('is a four by three grid', () => {
    expect(GRID_COLS).toBe(4);
    expect(GRID_ROWS).toBe(3);
    expect(TILE_COUNT).toBe(12);
  });

  it('tiles the unit square exactly, with no gap and no overlap', () => {
    let area = 0;
    for (let i = 0; i < TILE_COUNT; i += 1) {
      const r = tileRect(i);
      area += r.w * r.h;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(area).toBeCloseTo(1, 10);

    for (let a = 0; a < TILE_COUNT; a += 1) {
      for (let b = a + 1; b < TILE_COUNT; b += 1) {
        const p = tileRect(a);
        const q = tileRect(b);
        const overlap =
          Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) *
          Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));
        expect(overlap).toBeCloseTo(0, 12);
      }
    }
  });

  it('runs row-major, so tile 0 is top left and tile 11 is bottom right', () => {
    expect(tileRect(0)).toEqual({ x: 0, y: 0, w: 0.25, h: 1 / 3 });
    expect(tileRect(11).x).toBeCloseTo(0.75, 10);
    expect(tileRect(11).y).toBeCloseTo(2 / 3, 10);
  });

  it('clamps an index that is out of range instead of returning NaN', () => {
    expect(tileRect(-5)).toEqual(tileRect(0));
    expect(tileRect(99)).toEqual(tileRect(11));
  });

  it('scales to pixels', () => {
    expect(tileRectPx(5, 400, 300)).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });
});

describe('clipPathFor', () => {
  it('hides the glyph completely when no tile has popped', () => {
    // This is the one that matters: before the first pop the character must be
    // unreadable, and an empty inset is the only value that is unambiguously
    // zero area in every engine.
    expect(clipPathFor([], 400, 300)).toBe('inset(50% 50% 50% 50%)');
    expect(visibleFraction([])).toBe(0);
  });

  it('opens exactly one rectangle per popped tile', () => {
    const path = clipPathFor([0, 5], 400, 300);
    expect(path.startsWith('path("')).toBe(true);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(visibleFraction([0, 5])).toBeCloseTo(2 / 12, 10);
  });

  it('places the rectangle where the tile is', () => {
    // Tile 5 is row 1, column 1: x 100..200, y 100..200 on a 400x300 board.
    const path = clipPathFor([5], 400, 300, 0);
    expect(path).toBe('path("M100 100H200V200H100Z")');
  });

  it('bleeds outward but never outside the board', () => {
    const path = clipPathFor([0], 400, 300, 0.5);
    // Tile 0 touches both the left and the top edge, so the bleed is clamped
    // there and only the inner edges grow.
    expect(path).toBe('path("M0 0H100.5V100.5H0Z")');
  });

  it('ignores repeats and out-of-range indexes', () => {
    expect(clipPathFor([3, 3, 3], 120, 120)).toBe(clipPathFor([3], 120, 120));
    expect(clipPathFor([-1, 40], 120, 120)).toBe('inset(50% 50% 50% 50%)');
    expect(visibleFraction([2, 2, 99])).toBeCloseTo(1 / 12, 10);
  });

  it('hides everything on a board with no size yet', () => {
    expect(clipPathFor([0, 1, 2], 0, 0)).toBe('inset(50% 50% 50% 50%)');
  });

  it('shows the whole board once every tile is gone', () => {
    const all = Array.from({ length: TILE_COUNT }, (_, i) => i);
    expect(visibleFraction(all)).toBe(1);
    expect(clipPathFor(all, 400, 300).match(/M/g)).toHaveLength(12);
  });
});

describe('popOrder', () => {
  it('is every tile exactly once', () => {
    const order = popOrder(TILE_COUNT, 9);
    expect(order.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: TILE_COUNT }, (_, i) => i)
    );
  });

  it('is deterministic for a seed', () => {
    expect(popOrder(TILE_COUNT, 5)).toEqual(popOrder(TILE_COUNT, 5));
  });
});

// --- the guess gate ----------------------------------------------------------

describe('the guess prompt gate', () => {
  it('is shut until half the tiles are gone', () => {
    let round = newTileRound();
    expect(round.unlockAt).toBe(6);
    for (let i = 0; i < 5; i += 1) {
      round = popTile(round, i);
      expect(guessUnlocked(round)).toBe(false);
    }
    round = popTile(round, 5);
    expect(guessUnlocked(round)).toBe(true);
  });

  it('costs two more tiles for a wrong guess', () => {
    let round = newTileRound();
    for (let i = 0; i < 6; i += 1) round = popTile(round, i);
    round = afterWrongGuess(round);
    expect(OWED_AFTER_WRONG_GUESS).toBe(2);
    expect(round.unlockAt).toBe(8);
    expect(round.wrongGuesses).toBe(1);
    expect(guessUnlocked(round)).toBe(false);

    round = popTile(round, 6);
    expect(guessUnlocked(round)).toBe(false);
    round = popTile(round, 7);
    expect(guessUnlocked(round)).toBe(true);
  });

  it('never owes more tiles than the board has, so the round cannot deadlock', () => {
    let round = newTileRound();
    for (let i = 0; i < TILE_COUNT; i += 1) round = popTile(round, i);
    round = afterWrongGuess(round);
    expect(round.unlockAt).toBe(TILE_COUNT);
    // Every tile is already gone, so the prompt is open again immediately
    // rather than waiting on two tiles that do not exist.
    expect(guessUnlocked(round)).toBe(true);
  });

  it('closes for good once the word is read', () => {
    let round = newTileRound();
    for (let i = 0; i < 6; i += 1) round = popTile(round, i);
    round = solveRound(round);
    expect(guessUnlocked(round)).toBe(false);
  });

  it('ignores a repeated or impossible pop', () => {
    let round = newTileRound();
    round = popTile(round, 3);
    round = popTile(round, 3);
    round = popTile(round, 99);
    round = popTile(round, -1);
    expect(round.popped).toEqual([3]);
  });
});

// --- scoring -----------------------------------------------------------------

describe('scoring', () => {
  it('pays a point for every tile left standing', () => {
    let round = newTileRound();
    for (let i = 0; i < 6; i += 1) round = popTile(round, i);
    expect(tilesLeft(round)).toBe(6);
    expect(scoreForRound(round)).toBe(0); // not read yet
    expect(scoreForRound(solveRound(round))).toBe(6);
  });

  it('pays nothing for a word that was never read', () => {
    const round = newTileRound();
    expect(scoreForRound(round)).toBe(0);
  });

  it('pays nothing when the board was cleared to get there', () => {
    let round = newTileRound();
    for (let i = 0; i < TILE_COUNT; i += 1) round = popTile(round, i);
    expect(scoreForRound(solveRound(round))).toBe(0);
  });
});

// --- the questions -----------------------------------------------------------

describe('sideQuestions', () => {
  const hidden = SET.items[0]; // 苹果

  it('never asks about the word it is hiding', () => {
    const qs = sideQuestions(SET, hidden.id, 11);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.some((q) => q.itemId === hidden.id)).toBe(false);
    expect(qs.some((q) => q.prompt === hidden.zh)).toBe(false);
  });

  it('asks Chinese to English only, so no choice list can spell the answer', () => {
    const qs = sideQuestions(SET, hidden.id, 11);
    for (const q of qs) {
      expect(q.dir).toBe('zh2en');
      expect(q.choices).not.toContain(hidden.zh);
    }
  });

  it('alternates between reading and listening', () => {
    const modes = sideQuestions(SET, hidden.id, 11).map((q) => q.mode);
    expect(modes.slice(0, 4)).toEqual(['read', 'listen', 'read', 'listen']);
  });
});

describe('guessPrompt', () => {
  const hidden = SET.items[0]; // 苹果

  it('holds the hidden word at the index it names', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const { choices, answer } = guessPrompt(SET, hidden, seed);
      expect(choices[answer]).toBe(hidden.zh);
    }
  });

  it('offers four different words when the set can', () => {
    const { choices } = guessPrompt(SET, hidden, 3);
    expect(choices).toHaveLength(4);
    expect(new Set(choices).size).toBe(4);
  });

  it('prefers distractors of the same length, so the outline is no giveaway', () => {
    const mixed = setOf([
      ['苹果', 'apple'],
      ['香蕉', 'banana'],
      ['葡萄', 'grape'],
      ['梨', 'pear'],
      ['桃', 'peach'],
    ]);
    const { choices } = guessPrompt(mixed, mixed.items[0], 5);
    expect(choices.filter((c) => Array.from(c).length === 2)).toHaveLength(3);
  });

  it('still works on a two-word set', () => {
    const tiny = setOf([
      ['苹果', 'apple'],
      ['香蕉', 'banana'],
    ]);
    const { choices, answer } = guessPrompt(tiny, tiny.items[0], 1);
    expect(choices).toHaveLength(2);
    expect(choices[answer]).toBe('苹果');
  });
});

describe('revealDisabledReason', () => {
  it('lets a normal set through', () => {
    expect(revealDisabledReason(SET)).toBeUndefined();
  });

  it('refuses a one-word set in plain language', () => {
    const reason = revealDisabledReason(setOf([['苹果', 'apple']]));
    expect(reason).toContain('at least two words');
    expect(reason).toContain('1 word');
  });

  it('refuses a set whose English meanings are all the same', () => {
    expect(
      revealDisabledReason(
        setOf([
          ['苹果', 'fruit'],
          ['香蕉', 'fruit'],
        ])
      )
    ).toBeDefined();
  });

  it('refuses a set whose Chinese words are all the same', () => {
    expect(
      revealDisabledReason(
        setOf([
          ['苹果', 'apple'],
          ['苹果', 'the apple'],
        ])
      )
    ).toBeDefined();
  });
});

