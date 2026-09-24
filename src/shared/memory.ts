// Round planning for Memory Match.
//
// A set bigger than one round's worth of pairs is played across several
// rounds. The rule that matters: every word is played exactly once. A round
// holding a single leftover word is not playable (a pair needs a partner to
// hunt for), so that one-word tail merges into the round before it rather
// than being dropped or replayed from the top.

/** How many rounds a set of `itemCount` words needs at `perRound` pairs. */
export function roundCount(itemCount: number, perRound: number): number {
  const n = Math.max(0, Math.floor(itemCount));
  const p = Math.max(1, Math.floor(perRound));
  if (n === 0) return 0;

  const rounds = Math.ceil(n / p);
  // A trailing round of exactly one word merges backwards.
  if (rounds > 1 && n % p === 1) return rounds - 1;
  return rounds;
}

/**
 * The slice of `order` played in round `roundIndex` (0-based). Rounds tile the
 * list with no gaps and no overlap, so concatenating every round reproduces
 * `order` exactly. An out-of-range index clamps to the last round.
 */
export function roundItems<T>(order: readonly T[], roundIndex: number, perRound: number): T[] {
  const total = roundCount(order.length, perRound);
  if (total === 0) return [];

  const p = Math.max(1, Math.floor(perRound));
  const index = Math.min(Math.max(0, Math.floor(roundIndex)), total - 1);
  const start = index * p;
  const end = index === total - 1 ? order.length : start + p;
  return order.slice(start, end);
}

