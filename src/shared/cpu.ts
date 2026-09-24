// Seeded CPU opponents for the solo games.
//
// Solo Cloud Climb is not a different game: it drives the SAME reducers as the
// Durable Object, through a local room. The only thing missing without a network
// is other players, so this file manufactures three of them - deterministically,
// from a seed, so a solo bug reproduces exactly and one test covers both paths.
//
// Pure: no clock, no randomness beyond the seed, no I/O.

import { hashSeed, mulberry32 } from './rng';

export type CpuPace = 'easy' | 'normal' | 'fast';

export interface CpuMove {
  /** Question this move answers. */
  index: number;
  correct: boolean;
  /** ms after the question opens, always inside the question's own budget. */
  ms: number;
  /** Which chest this bean opens in a Treasure Dash round. */
  chest: number;
}

interface PaceProfile {
  /** Probability of answering correctly. */
  correctRate: number;
  /** Mean answer time as a fraction of the per-question budget. */
  latency: number;
}

const PACES: Record<CpuPace, PaceProfile> = {
  easy: { correctRate: 0.55, latency: 0.72 },
  normal: { correctRate: 0.7, latency: 0.55 },
  fast: { correctRate: 0.85, latency: 0.35 },
};

/**
 * One CPU bean's whole round, decided up front.
 *
 * `ms` is a fraction of the per-question budget rather than a raw duration, so
 * the same plan works at any timer. It is jittered around the pace's mean and
 * clamped to [0.05, 0.95] so a CPU never answers at literally 0ms (which would
 * look like a cheat) and never lands outside the window (which would silently
 * drop the move).
 *
 * Give each of the three beans a different seed string; the caller owns that, so
 * a whole solo game is reproducible from one seed.
 */
export function cpuPlan(seed: string, questionCount: number, pace: CpuPace): CpuMove[] {
  const profile = PACES[pace] ?? PACES.normal;
  const rand = mulberry32(hashSeed(`cpu:${seed}:${pace}`));

  const moves: CpuMove[] = [];
  for (let index = 0; index < questionCount; index++) {
    const correct = rand() < profile.correctRate;
    // Triangular-ish jitter: two draws, so times cluster near the mean instead
    // of spreading flat across the whole window.
    const jitter = (rand() + rand()) / 2 - 0.5;
    const fraction = Math.min(0.95, Math.max(0.05, profile.latency + jitter * 0.5));
    const chest = Math.floor(rand() * 3);
    moves.push({ index, correct, ms: fraction, chest });
  }
  return moves;
}

/** The real answer time for one move, given the round's per-question budget. */
export function cpuMoveMs(move: CpuMove, perQuestionMs: number): number {
  return Math.round(move.ms * perQuestionMs);
}

