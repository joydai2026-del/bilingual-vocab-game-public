// Sky Tower's rules. Node environment, no DOM, no three: the reducer is the
// only thing both renderers trust, so it is the thing that gets covered.

import { describe, expect, it } from 'vitest';

import {
  BLOCKS_PER_PLAYER,
  BURST_GAP_MS,
  MAX_TARGET,
  MIN_TARGET,
  ROUND_MS,
  SOLO_BASE_BLOCKS,
  WRONG_PAUSE_MS,
  betterRun,
  claimedHeight,
  createTower,
  earnBlock,
  formatClock,
  isPaused,
  missBlock,
  msLeft,
  nextDropAt,
  targetBlocks,
  tickTower,
  towerOutcome,
} from '../src/shared/sky-tower';

const T0 = 1_000_000;

function tower(target: number) {
  return createTower({ target, now: T0 });
}

/** Earns `n` blocks in the same instant, which is what a poll tick delivers. */
function burst(state: ReturnType<typeof tower>, n: number, now: number) {
  let next = state;
  for (let i = 0; i < n; i += 1) {
    next = earnBlock(next, { owner: `p${i}`, colorIndex: i }, now);
  }
  return next;
}

describe('targetBlocks', () => {
  it('is the solo base at normal with nobody in a room', () => {
    expect(targetBlocks('normal')).toBe(SOLO_BASE_BLOCKS);
    expect(targetBlocks('normal', 0)).toBe(SOLO_BASE_BLOCKS);
  });

  it('treats a room of one as solo, not as a class of one', () => {
    expect(targetBlocks('normal', 1)).toBe(SOLO_BASE_BLOCKS);
  });

  it('scales the solo target by the level dial', () => {
    expect(targetBlocks('easy')).toBe(9);
    expect(targetBlocks('normal')).toBe(12);
    expect(targetBlocks('hard')).toBe(18);
  });

  it('gives a room three blocks per player at normal', () => {
    for (const players of [2, 5, 12, 20]) {
      expect(targetBlocks('normal', players)).toBe(BLOCKS_PER_PLAYER * players);
    }
  });

  it('scales a room target too', () => {
    expect(targetBlocks('easy', 8)).toBe(18); // round(24 * 0.75)
    expect(targetBlocks('hard', 8)).toBe(36); // round(24 * 1.5)
  });

  it('never asks for a tower below the floor or above the ceiling', () => {
    expect(targetBlocks('easy', 2)).toBe(5); // round(6 * 0.75), the smallest a room ever asks
    expect(targetBlocks('easy', 2)).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(targetBlocks('hard', 40)).toBe(MAX_TARGET);
    expect(targetBlocks('easy', -3)).toBe(9); // junk roster falls back to solo
    expect(targetBlocks('normal', Number.NaN)).toBe(SOLO_BASE_BLOCKS);
  });

  it('always returns a whole number inside the bounds', () => {
    for (const level of ['easy', 'normal', 'hard'] as const) {
      for (let players = 0; players <= 40; players += 1) {
        const t = targetBlocks(level, players);
        expect(Number.isInteger(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(t).toBeLessThanOrEqual(MAX_TARGET);
      }
    }
  });
});

describe('burst queue', () => {
  it('spaces four answers from one poll tick 120 ms apart', () => {
    const state = burst(tower(20), 4, T0);
    expect(state.queue.map((b) => b.dueAt)).toEqual([
      T0,
      T0 + BURST_GAP_MS,
      T0 + 2 * BURST_GAP_MS,
      T0 + 3 * BURST_GAP_MS,
    ]);
  });

  it('never merges two drops into the same instant', () => {
    const state = burst(tower(30), 9, T0);
    const times = state.queue.map((b) => b.dueAt);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1]).toBe(BURST_GAP_MS);
    }
    expect(new Set(times).size).toBe(times.length);
  });

  it('keeps the gap across an already landed block', () => {
    let state = earnBlock(tower(10), { owner: 'a', colorIndex: 0 }, T0);
    state = tickTower(state, T0);
    expect(state.placed).toHaveLength(1);
    // 40 ms later is still inside the gap, so the next block waits for it.
    state = earnBlock(state, { owner: 'b', colorIndex: 1 }, T0 + 40);
    expect(state.queue[0].dueAt).toBe(T0 + BURST_GAP_MS);
  });

  it('drops immediately when the gap has already passed', () => {
    let state = earnBlock(tower(10), { owner: 'a', colorIndex: 0 }, T0);
    state = tickTower(state, T0);
    state = earnBlock(state, { owner: 'b', colorIndex: 1 }, T0 + 5_000);
    expect(state.queue[0].dueAt).toBe(T0 + 5_000);
  });

  it('nextDropAt agrees with where earnBlock actually puts the block', () => {
    const state = burst(tower(20), 3, T0);
    const at = nextDropAt(state, T0);
    const after = earnBlock(state, { owner: 'x', colorIndex: 4 }, T0);
    expect(after.queue[after.queue.length - 1].dueAt).toBe(at);
  });

  it('lands queued blocks in order as the clock reaches each slot', () => {
    let state = burst(tower(20), 3, T0);
    state = tickTower(state, T0);
    expect(state.placed).toHaveLength(1);
    state = tickTower(state, T0 + BURST_GAP_MS);
    expect(state.placed).toHaveLength(2);
    state = tickTower(state, T0 + 2 * BURST_GAP_MS);
    expect(state.placed).toHaveLength(3);
    expect(state.queue).toHaveLength(0);
    expect(state.placed.map((b) => b.owner)).toEqual(['p0', 'p1', 'p2']);
  });

  it('lands every overdue block at once when frames were skipped', () => {
    let state = burst(tower(20), 5, T0);
    state = tickTower(state, T0 + 10_000);
    expect(state.placed).toHaveLength(5);
    expect(state.queue).toHaveLength(0);
  });

  it('keeps the colour of whoever earned each block', () => {
    let state = earnBlock(tower(10), { owner: 'ann', colorIndex: 3 }, T0);
    state = earnBlock(state, { owner: 'bo', colorIndex: 7 }, T0);
    state = tickTower(state, T0 + BURST_GAP_MS);
    expect(state.placed.map((b) => [b.owner, b.colorIndex])).toEqual([
      ['ann', 3],
      ['bo', 7],
    ]);
  });
});

describe('answering', () => {
  it('a wrong answer costs two seconds and no block', () => {
    let state = burst(tower(10), 2, T0);
    state = tickTower(state, T0 + BURST_GAP_MS);
    const before = state.placed.length;
    state = missBlock(state, T0 + 500);
    expect(state.placed).toHaveLength(before);
    expect(state.queue).toHaveLength(0);
    expect(state.wrong).toBe(1);
    expect(isPaused(state, T0 + 500)).toBe(true);
    expect(isPaused(state, T0 + 500 + WRONG_PAUSE_MS - 1)).toBe(true);
    expect(isPaused(state, T0 + 500 + WRONG_PAUSE_MS)).toBe(false);
  });

  it('two wrong answers in a row never shorten the pause', () => {
    let state = missBlock(tower(10), T0);
    state = missBlock(state, T0 + 100);
    expect(state.pausedUntil).toBe(T0 + 100 + WRONG_PAUSE_MS);
    state = missBlock(state, T0 + 50);
    expect(state.pausedUntil).toBe(T0 + 100 + WRONG_PAUSE_MS);
  });

  it('refuses to build past the cloud line', () => {
    const state = burst(tower(4), 7, T0);
    expect(claimedHeight(state)).toBe(4);
    expect(state.correct).toBe(4);
  });

  it('ignores answers once the round is over', () => {
    let state = tickTower(tower(10), T0 + ROUND_MS);
    expect(state.endedAt).toBe(T0 + ROUND_MS);
    const after = earnBlock(state, { owner: 'a', colorIndex: 0 }, T0 + ROUND_MS + 10);
    expect(after).toBe(state);
    state = missBlock(state, T0 + ROUND_MS + 10);
    expect(state.wrong).toBe(0);
  });
});

describe('the clock and the ending', () => {
  it('starts at three minutes and counts down', () => {
    const state = tower(12);
    expect(msLeft(state, T0)).toBe(ROUND_MS);
    expect(msLeft(state, T0 + 60_000)).toBe(ROUND_MS - 60_000);
    expect(msLeft(state, T0 + ROUND_MS + 5_000)).toBe(0);
  });

  it('ends on the clock with the tower unfinished', () => {
    let state = burst(tower(12), 3, T0);
    state = tickTower(state, T0 + 1_000);
    state = tickTower(state, T0 + ROUND_MS);
    const out = towerOutcome(state);
    expect(out.won).toBe(false);
    expect(out.height).toBe(3);
    expect(out.ms).toBe(ROUND_MS);
  });

  it('ends on the win, timed to the block that landed it', () => {
    let state = burst(tower(3), 3, T0 + 5_000);
    state = tickTower(state, T0 + 9_000);
    expect(state.endedAt).toBe(T0 + 5_000 + 2 * BURST_GAP_MS);
    const out = towerOutcome(state);
    expect(out.won).toBe(true);
    expect(out.height).toBe(3);
    expect(out.target).toBe(3);
    expect(out.ms).toBe(5_000 + 2 * BURST_GAP_MS);
  });

  it('freezes the clock once the round has ended', () => {
    let state = burst(tower(2), 2, T0);
    state = tickTower(state, T0 + BURST_GAP_MS);
    const left = msLeft(state, T0 + BURST_GAP_MS);
    expect(msLeft(state, T0 + 60_000)).toBe(left);
  });

  it('does not re-end a round that already ended', () => {
    let state = burst(tower(2), 2, T0);
    state = tickTower(state, T0 + BURST_GAP_MS);
    const endedAt = state.endedAt;
    state = tickTower(state, T0 + ROUND_MS + 60_000);
    expect(state.endedAt).toBe(endedAt);
  });
});

describe('personal best', () => {
  it('takes the first run when there is nothing to beat', () => {
    expect(betterRun(null, { ms: 40_000, target: 12 })).toEqual({ ms: 40_000, target: 12 });
  });

  it('keeps the faster run at the same target', () => {
    const prev = { ms: 40_000, target: 12 };
    expect(betterRun(prev, { ms: 55_000, target: 12 })).toBe(prev);
    expect(betterRun(prev, { ms: 31_000, target: 12 })).toEqual({ ms: 31_000, target: 12 });
  });

  it('replaces rather than compares when the target changed', () => {
    const prev = { ms: 20_000, target: 9 };
    expect(betterRun(prev, { ms: 90_000, target: 18 })).toEqual({ ms: 90_000, target: 18 });
  });
});

// --- panel round 1, M2: a burst that lands after the buzzer ------------------
//
// The queue paces the VISUALS at 120 ms a block. It must not decide the round:
// a class that answers `target` questions before time-up has earned the cloud
// line even when the last block's animation slot falls past the clock. The old
// reducer abandoned the queue at the buzzer and told the class it had lost.

describe('answers accepted before the buzzer decide the round', () => {
  it('a class that earns the target in the last second still wins', () => {
    let state = createTower({ target: 12, now: 0 });
    const at = ROUND_MS - 50; // 50 ms left: everyone answers at once
    for (let i = 0; i < 12; i++) state = earnBlock(state, { owner: `p${i}`, colorIndex: i }, at);
    expect(state.queue).toHaveLength(12);

    // The live loop ticks every 80 ms, so the first tick after the buzzer is
    // the normal case, not a corner.
    state = tickTower(state, ROUND_MS + 500);
    const out = towerOutcome(state);
    expect(out.won).toBe(true);
    expect(out.height).toBe(12);
    expect(state.queue).toHaveLength(0);
  });

  it('never stamps the end of a round after the clock ran out', () => {
    let state = createTower({ target: 4, now: 0 });
    const at = ROUND_MS - 10;
    for (let i = 0; i < 4; i++) state = earnBlock(state, { owner: 'a', colorIndex: i }, at);
    state = tickTower(state, ROUND_MS + 1000);
    expect(state.endedAt).not.toBeNull();
    expect(state.endedAt as number).toBeLessThanOrEqual(ROUND_MS);
    expect(towerOutcome(state).ms).toBeLessThanOrEqual(ROUND_MS);
  });

  it('an answer offered after time-up is not accepted', () => {
    let state = createTower({ target: 6, now: 0 });
    state = earnBlock(state, { owner: 'a', colorIndex: 0 }, ROUND_MS + 1);
    expect(state.correct).toBe(0);
    expect(state.queue).toHaveLength(0);
  });
});

describe('formatClock', () => {
  it('reads as m:ss', () => {
    expect(formatClock(ROUND_MS)).toBe('3:00');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(9_400)).toBe('0:09');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
  });
});

