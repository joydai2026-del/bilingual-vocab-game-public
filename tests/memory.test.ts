import { describe, it, expect } from 'vitest';
import { roundCount, roundItems } from '../src/shared/memory';

function list(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** Every round concatenated must reproduce the list exactly once. */
function playAll(n: number, perRound: number): number[] {
  const order = list(n);
  const played: number[] = [];
  for (let r = 0; r < roundCount(n, perRound); r++) {
    played.push(...roundItems(order, r, perRound));
  }
  return played;
}

describe('roundCount', () => {
  it('is one round when the set fits in a round', () => {
    expect(roundCount(6, 6)).toBe(1);
    expect(roundCount(8, 8)).toBe(1);
    expect(roundCount(3, 8)).toBe(1);
  });

  it('merges a one-word tail into the last round', () => {
    // 7 at 6 would be 6 + 1; 9 at 8 would be 8 + 1.
    expect(roundCount(7, 6)).toBe(1);
    expect(roundCount(9, 8)).toBe(1);
    expect(roundCount(13, 6)).toBe(2);
    expect(roundCount(17, 8)).toBe(2);
    expect(roundCount(25, 6)).toBe(4);
    expect(roundCount(25, 8)).toBe(3);
  });

  it('leaves a tail of two or more as its own round', () => {
    expect(roundCount(9, 6)).toBe(2);
    expect(roundCount(10, 8)).toBe(2);
  });

  it('is zero for an empty list', () => {
    expect(roundCount(0, 6)).toBe(0);
  });
});

describe('roundItems', () => {
  it('plays every word exactly once for the counts that used to drop one', () => {
    for (const perRound of [6, 8]) {
      for (const n of [7, 9, 13, 17, 25]) {
        expect(playAll(n, perRound)).toEqual(list(n));
      }
    }
  });

  it('plays every word exactly once for every size from 1 to 60', () => {
    for (const perRound of [6, 8]) {
      for (let n = 1; n <= 60; n++) {
        expect(playAll(n, perRound)).toEqual(list(n));
      }
    }
  });

  it('never serves a round of one word except for a one-word set', () => {
    for (const perRound of [6, 8]) {
      for (let n = 2; n <= 60; n++) {
        for (let r = 0; r < roundCount(n, perRound); r++) {
          expect(roundItems(list(n), r, perRound).length).toBeGreaterThanOrEqual(2);
        }
      }
    }
    expect(roundItems(list(1), 0, 8)).toEqual([0]);
  });

  it('gives the merged round one extra word', () => {
    expect(roundItems(list(9), 0, 8)).toEqual(list(9));
    expect(roundItems(list(13), 1, 6)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(roundItems(list(25), 2, 8)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });

  it('clamps an out-of-range round to the last one', () => {
    expect(roundItems(list(9), 99, 6)).toEqual([6, 7, 8]);
    expect(roundItems(list(9), -3, 6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('returns nothing for an empty list', () => {
    expect(roundItems([], 0, 6)).toEqual([]);
  });
});

