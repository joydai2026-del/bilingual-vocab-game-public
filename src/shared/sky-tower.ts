// Sky Tower: the rules, with nothing that can draw.
//
// The whole game is "a correct answer drops one block, the class wins when the
// tower touches the cloud line, the clock is three minutes". That is small
// enough to be a pure reducer, and small enough that it MUST be one: the 3D
// scene and the CSS twin both have to agree about the height of the tower, and
// the only way two renderers agree is by not owning the number.
//
// Everything here is (state, ..., now) -> new state. No Date.now(), no DOM, no
// three. That is what lets the vitest node environment cover it and what keeps
// this file importable from anywhere.
//
// Contract: docs/plans/2026-09-08-three-games-spec.md, Game 2.

/** The dial the teacher turns. Same three words as the app's other level dials. */
export type TowerLevel = 'easy' | 'normal' | 'hard';

export const TOWER_LEVELS: TowerLevel[] = ['easy', 'normal', 'hard'];

/** Three minutes, per the spec. The round ends on this whatever the tower did. */
export const ROUND_MS = 180_000;

/**
 * A wrong answer costs two seconds and NOT a block. The tower only ever grows:
 * that is the co-operative promise, and it is why nobody on the class screen
 * can be seen to have lost the group a block.
 */
export const WRONG_PAUSE_MS = 2_000;

/**
 * Blocks land 120 ms apart. A poll tick can hand us four correct answers at
 * once; dropping them in the same frame reads as one lump, so the queue holds
 * them and lets them fall one after another.
 */
export const BURST_GAP_MS = 120;

/** Solo target before the level dial scales it. */
export const SOLO_BASE_BLOCKS = 12;

/** Room target before the level dial scales it: three blocks per player. */
export const BLOCKS_PER_PLAYER = 3;

/** A tower shorter than this is not a tower, and taller than this is not a lesson. */
export const MIN_TARGET = 4;
export const MAX_TARGET = 60;

export const LEVEL_SCALE: Record<TowerLevel, number> = {
  easy: 0.75,
  normal: 1,
  hard: 1.5,
};

/**
 * How many blocks reach the cloud line.
 *
 * `players` is the room roster. 0 or 1 means solo (one child on one device is
 * not a class of one; they get the solo target, which is what the spec names).
 * A junk value is treated as solo rather than throwing at a child mid-lesson.
 */
export function targetBlocks(level: TowerLevel, players = 0): number {
  const roster = Number.isFinite(players) ? Math.floor(players) : 0;
  const base = roster >= 2 ? BLOCKS_PER_PLAYER * roster : SOLO_BASE_BLOCKS;
  const scale = LEVEL_SCALE[level] ?? LEVEL_SCALE.normal;
  const scaled = Math.round(base * scale);
  return Math.max(MIN_TARGET, Math.min(MAX_TARGET, scaled));
}

/**
 * The floor under a CLASS tower, which is a different number from the solo
 * floor above.
 *
 * `MIN_TARGET` (4) is what stops a level dial from shrinking a solo tower into
 * a two-tap game. A room has a second problem the solo game does not: three
 * blocks per player means a class of one or two would finish before the second
 * question opened, and a class that wins in twenty seconds has not played
 * anything together. Six is about two questions each for a pair and still a
 * warm-up for a class of thirty.
 */
export const ROOM_MIN_TARGET = 6;

/**
 * How many blocks a ROOM has to stack, given the set's level dial and how many
 * children actually joined.
 *
 * Three per player, scaled, then floored at six and capped at MAX_TARGET. The
 * floor is applied AFTER the scale on purpose: "min 6" is a promise about the
 * number the class sees on the cloud line, not about an intermediate.
 */
export function roomTargetBlocks(level: TowerLevel, players: number): number {
  const roster = Number.isFinite(players) ? Math.max(0, Math.floor(players)) : 0;
  const scale = LEVEL_SCALE[level] ?? LEVEL_SCALE.normal;
  // The cap goes on the per-player BASE, not on the scaled result, so the level
  // dial keeps working in a big class. Capping last meant that above twenty
  // children every dial position clipped to the same 60 and an easy set was
  // exactly as tall as a normal one (panel round 1, S5). Capping first, a class
  // of thirty reads 45 on a kids set and 60 on a big one, and the ceiling on
  // what a class is ever asked to stack is unchanged.
  const base = Math.min(BLOCKS_PER_PLAYER * roster, MAX_TARGET);
  const scaled = Math.round(base * scale);
  return Math.max(ROOM_MIN_TARGET, Math.min(MAX_TARGET, scaled));
}

/** One block, and who earned it. `colorIndex` indexes BEAN_COLORS. */
export interface TowerBlock {
  owner: string;
  colorIndex: number;
  /** When this block is allowed to land. Set by the burst queue. */
  dueAt: number;
}

export interface TowerState {
  target: number;
  /** Blocks that have landed, oldest first. `placed.length` is the height. */
  placed: TowerBlock[];
  /** Earned but still falling, oldest first. */
  queue: TowerBlock[];
  startedAt: number;
  /** Set once, by the win or by the clock. Null while the round is live. */
  endedAt: number | null;
  /** No question is asked before this instant. A wrong answer pushes it out. */
  pausedUntil: number;
  correct: number;
  wrong: number;
}

export function createTower(opts: { target: number; now: number }): TowerState {
  return {
    target: Math.max(1, Math.floor(opts.target)),
    placed: [],
    queue: [],
    startedAt: opts.now,
    endedAt: null,
    pausedUntil: opts.now,
    correct: 0,
    wrong: 0,
  };
}

/** The last instant any block is spoken for, or -Infinity when none is. */
function lastDue(state: TowerState): number {
  if (state.queue.length > 0) return state.queue[state.queue.length - 1].dueAt;
  if (state.placed.length > 0) return state.placed[state.placed.length - 1].dueAt;
  return Number.NEGATIVE_INFINITY;
}

/** When the next earned block would land if it were earned at `now`. */
export function nextDropAt(state: TowerState, now: number): number {
  const after = lastDue(state) + BURST_GAP_MS;
  return Number.isFinite(after) ? Math.max(now, after) : now;
}

/** Blocks earned and not yet landed, plus the ones already up. */
export function claimedHeight(state: TowerState): number {
  return state.placed.length + state.queue.length;
}

/**
 * A correct answer. Queues one block at the next free 120 ms slot.
 *
 * Refused once the round is over, and once the tower is already spoken for up
 * to the target: a class that all answer at once should not build past the
 * cloud line and leave blocks hanging in the sky.
 */
export function earnBlock(
  state: TowerState,
  block: { owner: string; colorIndex: number },
  now: number
): TowerState {
  if (state.endedAt !== null) return state;
  // The clock is the gate, not the last tick. A click between the buzzer and
  // the next 80 ms poll is not an answer the class earned.
  if (now >= state.startedAt + ROUND_MS) return state;
  if (claimedHeight(state) >= state.target) return state;
  return {
    ...state,
    correct: state.correct + 1,
    queue: [...state.queue, { ...block, dueAt: nextDropAt(state, now) }],
  };
}

/** A wrong answer. Two seconds of nothing, and the tower keeps every block. */
export function missBlock(state: TowerState, now: number): TowerState {
  if (state.endedAt !== null) return state;
  return {
    ...state,
    wrong: state.wrong + 1,
    pausedUntil: Math.max(state.pausedUntil, now + WRONG_PAUSE_MS),
  };
}

/** True while a wrong answer is still being looked at. */
export function isPaused(state: TowerState, now: number): boolean {
  return now < state.pausedUntil;
}

/** Milliseconds left on the three-minute clock. Frozen once the round ends. */
export function msLeft(state: TowerState, now: number): number {
  const at = state.endedAt === null ? now : Math.min(now, state.endedAt);
  return Math.max(0, state.startedAt + ROUND_MS - at);
}

/**
 * Advance the world to `now`: land every block whose slot has come, then check
 * the two ways a round ends.
 *
 * The win is stamped at the LANDING time of the block that won it rather than
 * at `now`, so a tab that was backgrounded for two seconds between frames does
 * not charge those two seconds to the run.
 */
export function tickTower(state: TowerState, now: number): TowerState {
  let next = state;
  const buzzer = next.startedAt + ROUND_MS;

  if (next.queue.length > 0 && next.queue[0].dueAt <= now) {
    const landing = next.queue.filter((b) => b.dueAt <= now);
    const waiting = next.queue.filter((b) => b.dueAt > now);
    next = { ...next, placed: [...next.placed, ...landing], queue: waiting };
    next = stampWin(next, buzzer);
  }

  if (next.endedAt === null && now >= buzzer) {
    // Every block still in the queue was EARNED before the buzzer; the 120 ms
    // spacing only paces the animation. Abandoning them here is what told a
    // class that answered twelve questions in the last second that it had not
    // reached the cloud line. The clock ends the round, it does not take a
    // block back, so everything owed lands and then the round closes.
    if (next.queue.length > 0) {
      next = { ...next, placed: [...next.placed, ...next.queue], queue: [] };
    }
    next = stampWin(next, buzzer);
    if (next.endedAt === null) next = { ...next, endedAt: buzzer };
  }

  return next;
}

/**
 * Stamp the win, if the tower has reached the cloud line, at the LANDING time
 * of the block that won it. Clamped to the buzzer: a block whose animation slot
 * fell past the clock still counts, but the run is never recorded as having
 * taken longer than the three minutes it was allowed.
 */
function stampWin(state: TowerState, buzzer: number): TowerState {
  if (state.endedAt !== null || state.placed.length < state.target) return state;
  const wonAt = state.placed[state.target - 1].dueAt;
  return { ...state, endedAt: Math.min(wonAt, buzzer) };
}

export interface TowerOutcome {
  won: boolean;
  height: number;
  target: number;
  /** How long the run took: to the win, or the whole three minutes. */
  ms: number;
}

export function towerOutcome(state: TowerState): TowerOutcome {
  const end = state.endedAt ?? state.startedAt;
  return {
    won: state.placed.length >= state.target,
    height: state.placed.length,
    target: state.target,
    ms: Math.max(0, end - state.startedAt),
  };
}

// --- personal best -----------------------------------------------------------

export interface TowerBest {
  /** Time to the win, in ms. */
  ms: number;
  target: number;
}

/**
 * The better of two runs at the same target. A run at a different target is not
 * comparable, so the newer one simply replaces it: changing the level dial
 * starts a new record rather than beating an easier one.
 */
export function betterRun(prev: TowerBest | null, next: TowerBest): TowerBest {
  if (!prev) return next;
  if (prev.target !== next.target) return next;
  return next.ms < prev.ms ? next : prev;
}

/** m:ss, floored, for a clock a seven-year-old reads at a glance. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

