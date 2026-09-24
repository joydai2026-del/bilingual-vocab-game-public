// How a room turns a ranking row into the two numbers a child reads.
//
// Cloud Climb is ranked on the tower: clouds climbed first, then the clock.
// Points are a second, softer number in that game, because a fast wrong-then-
// right run can out-point a slower climber who got further up. Printing points
// as the headline next to a step-ordered list is how the projector ended up
// showing "1. Ana 300 / 2. Ben 400" (Codex round 1, MUST-FIX 4).
//
// So every list a room draws goes through here: the same ordering as the tower,
// and the same two labelled numbers, on the teacher's screen and on all thirty
// iPads.

import { rankingMsFor } from '../../shared/room';
import type { Player, RankingEntry, RoundKind } from '../../shared/types';

/** The two numbers on one ranking row: the one it is ranked on, and the other. */
export interface RankingCell {
  /** What this game ranks on, e.g. "7 clouds". */
  primary: string;
  /** The other number, always labelled, e.g. "820 points". */
  secondary: string;
}

function clouds(step: number): string {
  return `${step} ${step === 1 ? 'cloud' : 'clouds'}`;
}

function points(score: number): string {
  return `${score} ${score === 1 ? 'point' : 'points'}`;
}

/**
 * The row as it should read for this game.
 *
 * climb        clouds lead, points follow.
 * race / dash  points lead, and there is no second number worth a child's time.
 */
export function rankingCell(row: RankingEntry, kind: RoundKind | undefined): RankingCell {
  if (kind === 'climb') {
    return { primary: clouds(row.step ?? 0), secondary: points(row.score) };
  }
  return { primary: points(row.score), secondary: '' };
}

/**
 * The server's own ordering (`buildRanking` in src/shared/round.ts), applied to
 * rows the server has not ranked yet. climb sorts on `step` then the ranking
 * clock, with score no part of it at all; everything else sorts on score then
 * the clock.
 */
export function sortRanking(rows: RankingEntry[], kind: RoundKind | undefined): RankingEntry[] {
  return rows.slice().sort((a, b) => {
    if (kind === 'climb') {
      const stepA = a.step ?? 0;
      const stepB = b.step ?? 0;
      if (stepA !== stepB) return stepB - stepA;
    } else if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.totalMs - b.totalMs;
  });
}

/**
 * A ranking for a round the server has not finished yet: the live scoreboard,
 * ordered the way the finished one will be. Every unanswered question is
 * charged at the full per-question budget, which is what `rankingMsFor` is for.
 */
export function provisionalRanking(
  players: Player[],
  kind: RoundKind | undefined,
  questionCount: number,
  perQuestionMs: number
): RankingEntry[] {
  const rows = players.map((player) => ({
    playerId: player.id,
    name: player.name,
    score: player.score,
    totalMs: rankingMsFor(player, questionCount, perQuestionMs),
    step: player.step ?? 0,
  }));
  return sortRanking(rows, kind);
}

/** True when two rows are level on everything this game ranks on. */
export function rankedLevel(
  a: RankingEntry,
  b: RankingEntry,
  kind: RoundKind | undefined
): boolean {
  if (a.totalMs !== b.totalMs) return false;
  return kind === 'climb' ? (a.step ?? 0) === (b.step ?? 0) : a.score === b.score;
}

