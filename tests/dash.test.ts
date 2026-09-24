// Treasure Dash: what is in the chest, who is allowed to open it, and the
// property that makes Swap and Steal safe to ship - neither invents or destroys
// a single point.

import { describe, it, expect } from 'vitest';
import { answer, createRoom, join, pick, pickWindowFor, startRound } from '../src/shared/room';
import {
  CARD_POINTS,
  CONSOLATION_POINTS,
  DEFAULT_DASH_WEIGHTS,
  dashCardFor,
  leaderIndexOf,
} from '../src/shared/round';
import type { DashCard, Player, RoomState, VocabItem, VocabSet } from '../src/shared/types';

const NOW = 1_000_000;
const PER_QUESTION_MS = 8000;
const SEED = 'dash-seed-4f2a';

function makeSet(n: number): VocabSet {
  const items: VocabItem[] = Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    zh: `中${i}`,
    pinyin: `zhong${i}`,
    en: `word${i}`,
  }));
  return { v: 1, title: 'dash set', level: 'big', items };
}

/** A dash round with three students, all of whom answered question 0 correctly. */
function dashRoom(itemCount = 4) {
  const room = createRoom('DASH', makeSet(itemCount), [], PER_QUESTION_MS, NOW, {
    teacher: true,
  });
  const a = join(room, 'Ana', NOW);
  const b = join(a.state, 'Ben', NOW);
  const c = join(b.state, 'Cal', NOW);
  const started = startRound(
    c.state,
    { kind: 'dash', seed: SEED, directions: ['zh2en'] },
    NOW
  );
  return {
    state: started,
    anaId: a.playerId!,
    benId: b.playerId!,
    calId: c.playerId!,
  };
}

/**
 * Loads every chest with the same card, by zeroing the other weights.
 *
 * Hunting the seed space for a swap would make these tests depend on the PRNG's
 * exact stream; steering the config does not, and it is the config the plan says
 * is tunable anyway.
 */
function forceCard(state: RoomState, card: DashCard): RoomState {
  const config = state.round!.config;
  if (config.kind !== 'dash') throw new Error('not a dash round');
  const weights = { points50: 0, points100: 0, points200: 0, swap: 0, steal: 0 };
  weights[card] = 1;
  return { ...state, round: { ...state.round!, config: { ...config, weights } } };
}

/** Everyone answers question `index` correctly, so everyone has earned a chest. */
function allAnswer(state: RoomState, ids: string[], index: number): RoomState {
  const round = state.round!;
  let next = state;
  for (const id of ids) {
    next = answer(next, id, index, next.questions[index].answer, round.startsAt + index * round.slotMs + 200);
  }
  return next;
}

function setScores(state: RoomState, scores: Record<string, number>): RoomState {
  return {
    ...state,
    players: state.players.map((p) => (p.id in scores ? { ...p, score: scores[p.id] } : p)),
  };
}

const totalScore = (players: Player[]): number => players.reduce((sum, p) => sum + p.score, 0);

const pickAt = (state: RoomState, index: number): number =>
  state.round!.startsAt + index * state.round!.slotMs + state.round!.perQuestionMs + 100;

describe('dashCardFor', () => {
  it('is stable: the same seed, player, index and chest always give the same card', () => {
    const first = dashCardFor(SEED, 'ana', 3, 1);
    for (let i = 0; i < 1000; i++) {
      expect(dashCardFor(SEED, 'ana', 3, 1)).toBe(first);
    }
  });

  it('gives different chests at the same question different cards', () => {
    // Not every triple differs (there are five cards and the common ones repeat),
    // so this asserts that SOME question in a normal round offers a real choice.
    let differs = 0;
    for (let index = 0; index < 40; index++) {
      const cards = [0, 1, 2].map((chest) => dashCardFor(SEED, 'ana', index, chest));
      if (new Set(cards).size > 1) differs++;
    }
    expect(differs).toBeGreaterThan(20);
  });

  it('separates the streams: different players and rounds get different cards', () => {
    const ana = Array.from({ length: 30 }, (_, i) => dashCardFor(SEED, 'ana', i, 0));
    const ben = Array.from({ length: 30 }, (_, i) => dashCardFor(SEED, 'ben', i, 0));
    const other = Array.from({ length: 30 }, (_, i) => dashCardFor('other-seed', 'ana', i, 0));
    expect(ana).not.toEqual(ben);
    expect(ana).not.toEqual(other);
  });

  it('draws every card from the default weights, rare ones included', () => {
    const seen = new Map<DashCard, number>();
    for (let i = 0; i < 3000; i++) {
      const card = dashCardFor(SEED, `p${i % 8}`, i, i % 3);
      seen.set(card, (seen.get(card) ?? 0) + 1);
    }
    for (const card of ['points50', 'points100', 'points200', 'swap', 'steal'] as DashCard[]) {
      expect(seen.get(card) ?? 0).toBeGreaterThan(0);
    }
    // The common cards stay common and the rare ones stay rare.
    expect(seen.get('points50')!).toBeGreaterThan(seen.get('swap')!);
    expect(DEFAULT_DASH_WEIGHTS.swap).toBeLessThan(DEFAULT_DASH_WEIGHTS.points50);
  });

  it('never crashes on a config with no weight anywhere', () => {
    const zero = { points50: 0, points100: 0, points200: 0, swap: 0, steal: 0 };
    expect(dashCardFor(SEED, 'ana', 0, 0, zero)).toBe('points50');
  });
});

describe('who may open a chest', () => {
  it('accepts a pick from a player who got that question right', () => {
    const { state, anaId } = dashRoom();
    const answered = allAnswer(state, [anaId], 0);
    expect(pickWindowFor(answered, 0)!.expiresAt).toBe(pickAt(state, 0) - 100 + 3000);

    const result = pick(answered, anaId, 0, 1, pickAt(state, 0));
    expect(result.accepted).toBe(true);
    expect(result.outcome).toBeDefined();
    expect(result.state.players.find((p) => p.id === anaId)!.pickedIndexes).toEqual([0]);
  });

  it('refuses a pick on a question the player got WRONG, and reveals nothing', () => {
    const { state, anaId } = dashRoom();
    const q = state.questions[0];
    const wrong = answer(
      state,
      anaId,
      0,
      (q.answer + 1) % q.choices.length,
      state.round!.startsAt + 100
    );

    const result = pick(wrong, anaId, 0, 0, pickAt(state, 0));
    expect(result.accepted).toBe(false);
    expect(result.refusal).toBe('unearned');
    expect(result.outcome).toBeUndefined();
    expect('outcome' in result).toBe(false);
    expect(result.state).toBe(wrong);
  });

  it('refuses a second pick at the same question and withholds that outcome too', () => {
    const { state, anaId } = dashRoom();
    const answered = allAnswer(state, [anaId], 0);
    const first = pick(answered, anaId, 0, 0, pickAt(state, 0));
    expect(first.accepted).toBe(true);

    const second = pick(first.state, anaId, 0, 1, pickAt(state, 0) + 10);
    expect(second.accepted).toBe(false);
    expect(second.refusal).toBe('duplicate');
    expect(second.outcome).toBeUndefined();
    // The scoreboard did not move, so a client cannot infer the card from it.
    expect(second.state).toBe(first.state);
  });

  it('refuses a pick outside the pick window', () => {
    const { state, anaId } = dashRoom();
    const answered = allAnswer(state, [anaId], 0);
    const { expiresAt, opensAt } = { ...pickWindowFor(answered, 0)!, opensAt: state.round!.startsAt };

    expect(pick(answered, anaId, 0, 0, opensAt - 1).refusal).toBe('window');
    expect(pick(answered, anaId, 0, 0, expiresAt + 1).refusal).toBe('window');
    expect(pick(answered, anaId, 0, 0, expiresAt).accepted).toBe(true);
  });

  it('refuses an unknown player, an out-of-range chest and an out-of-range question', () => {
    const { state, anaId } = dashRoom();
    const answered = allAnswer(state, [anaId], 0);
    const at = pickAt(state, 0);

    expect(pick(answered, 'ghost', 0, 0, at).refusal).toBe('unknown');
    expect(pick(answered, anaId, 0, 3, at).refusal).toBe('unknown');
    expect(pick(answered, anaId, 0, -1, at).refusal).toBe('unknown');
    expect(pick(answered, anaId, 999, 0, at).refusal).toBe('unknown');
  });

  it('refuses a pick when the room is not in a round', () => {
    const { state, anaId } = dashRoom();
    const lobby: RoomState = { ...state, phase: 'lobby' };
    expect(pick(lobby, anaId, 0, 0, NOW).refusal).toBe('phase');
  });

  it('refuses a pick in a round that is not Treasure Dash', () => {
    const room = createRoom('RACE', makeSet(4), [], PER_QUESTION_MS, NOW, { teacher: true });
    const a = join(room, 'Ana', NOW);
    const b = join(a.state, 'Ben', NOW);
    const climb = startRound(b.state, { kind: 'climb', seed: SEED }, NOW);
    expect(pick(climb, a.playerId!, 0, 0, climb.round!.startsAt + 100).refusal).toBe('phase');
    expect(pickWindowFor(climb, 0)).toBeUndefined();
  });
});

describe('points chests', () => {
  it('pays exactly what the card says', () => {
    const { state, anaId } = dashRoom();
    const answered = allAnswer(state, [anaId], 0);
    const before = answered.players.find((p) => p.id === anaId)!.score;

    for (const card of ['points50', 'points100', 'points200'] as const) {
      const result = pick(forceCard(answered, card), anaId, 0, 0, pickAt(state, 0));
      expect(result.outcome).toEqual({ kind: 'points', points: CARD_POINTS[card] });
      expect(result.state.players.find((p) => p.id === anaId)!.score).toBe(
        before + CARD_POINTS[card]
      );
    }
  });
});

describe('Swap', () => {
  it('exchanges the two scores and leaves the total untouched', () => {
    const { state, anaId, benId, calId } = dashRoom();
    let room = allAnswer(state, [anaId, benId, calId], 0);
    // Ben leads; Ana picks, so the swap has a real target.
    room = setScores(room, { [anaId]: 100, [benId]: 900, [calId]: 400 });
    const before = totalScore(room.players);

    const result = pick(forceCard(room, 'swap'), anaId, 0, 0, pickAt(state, 0));
    expect(result.accepted).toBe(true);
    expect(result.outcome).toEqual({ kind: 'swap', withPlayerId: benId, before: 100, after: 900 });

    const after = result.state.players;
    expect(after.find((p) => p.id === anaId)!.score).toBe(900);
    expect(after.find((p) => p.id === benId)!.score).toBe(100);
    expect(after.find((p) => p.id === calId)!.score).toBe(400);
    expect(totalScore(after)).toBe(before);
  });

  it('pays the leader 100 instead, so the card is never a dud', () => {
    const { state, anaId, benId, calId } = dashRoom();
    let room = allAnswer(state, [anaId, benId, calId], 0);
    room = setScores(room, { [anaId]: 900, [benId]: 100, [calId]: 400 });
    expect(leaderIndexOf(room.players, room.round!.questionCount, PER_QUESTION_MS)).toBe(
      room.players.findIndex((p) => p.id === anaId)
    );

    const result = pick(forceCard(room, 'swap'), anaId, 0, 0, pickAt(state, 0));
    expect(result.outcome).toEqual({ kind: 'points', points: CONSOLATION_POINTS });
    expect(result.state.players.find((p) => p.id === anaId)!.score).toBe(900 + CONSOLATION_POINTS);
  });

  it('applies two swaps in the same tick in arrival order, and the total still holds', () => {
    const { state, anaId, benId, calId } = dashRoom();
    let room = allAnswer(state, [anaId, benId, calId], 0);
    room = setScores(room, { [anaId]: 100, [benId]: 900, [calId]: 400 });
    const before = totalScore(room.players);
    const at = pickAt(state, 0);

    // Ana swaps with the leader (Ben), which makes Ana the leader; Cal's swap
    // then lands against the board as it stands, not as it was.
    const first = pick(forceCard(room, 'swap'), anaId, 0, 0, at);
    const second = pick(forceCard(first.state, 'swap'), calId, 0, 0, at);

    expect(first.outcome).toMatchObject({ kind: 'swap', withPlayerId: benId });
    expect(second.outcome).toMatchObject({ kind: 'swap', withPlayerId: anaId });
    const after = second.state.players;
    expect(after.find((p) => p.id === anaId)!.score).toBe(400);
    expect(after.find((p) => p.id === benId)!.score).toBe(100);
    expect(after.find((p) => p.id === calId)!.score).toBe(900);
    expect(totalScore(after)).toBe(before);
  });
});

describe('Steal', () => {
  it('takes exactly half the leader score, rounded down, and the total holds', () => {
    const { state, anaId, benId, calId } = dashRoom();
    let room = allAnswer(state, [anaId, benId, calId], 0);
    room = setScores(room, { [anaId]: 100, [benId]: 901, [calId]: 400 });
    const before = totalScore(room.players);

    const result = pick(forceCard(room, 'steal'), anaId, 0, 0, pickAt(state, 0));
    expect(result.outcome).toEqual({ kind: 'steal', fromPlayerId: benId, points: 450 });

    const after = result.state.players;
    expect(after.find((p) => p.id === benId)!.score).toBe(901 - 450);
    expect(after.find((p) => p.id === anaId)!.score).toBe(100 + 450);
    expect(after.find((p) => p.id === calId)!.score).toBe(400);
    expect(totalScore(after)).toBe(before);
  });

  it('auto-targets the current leader, with no target window to wait through', () => {
    const { state, anaId, benId, calId } = dashRoom();
    let room = allAnswer(state, [anaId, benId, calId], 0);
    room = setScores(room, { [anaId]: 0, [benId]: 200, [calId]: 500 });

    const result = pick(forceCard(room, 'steal'), anaId, 0, 0, pickAt(state, 0));
    // Cal leads, so Cal is the one who gets robbed. No second request.
    expect(result.outcome).toEqual({ kind: 'steal', fromPlayerId: calId, points: 250 });
  });

  it('pays the leader 100 instead of robbing themselves', () => {
    const { state, anaId, benId, calId } = dashRoom();
    let room = allAnswer(state, [anaId, benId, calId], 0);
    room = setScores(room, { [anaId]: 900, [benId]: 100, [calId]: 200 });

    const result = pick(forceCard(room, 'steal'), anaId, 0, 0, pickAt(state, 0));
    expect(result.outcome).toEqual({ kind: 'points', points: CONSOLATION_POINTS });
  });

  it('steals nothing from a leader on zero, which is still zero-sum', () => {
    const { state, anaId, benId, calId } = dashRoom();
    let room = allAnswer(state, [anaId, benId, calId], 0);
    room = setScores(room, { [anaId]: 0, [benId]: 0, [calId]: 0 });
    const before = totalScore(room.players);

    // Everyone is on zero, so the tie-break picks a leader; whoever it is, the
    // board cannot change.
    const result = pick(forceCard(room, 'steal'), calId, 0, 0, pickAt(state, 0));
    expect(result.accepted).toBe(true);
    expect(totalScore(result.state.players)).toBe(before);
  });
});

describe('leaderIndexOf', () => {
  it('breaks a score tie on the lower ranking time, so it is a total order', () => {
    const { state, anaId, benId } = dashRoom();
    const room = setScores(allAnswer(state, [anaId, benId], 0), { [anaId]: 500, [benId]: 500 });
    const idx = leaderIndexOf(room.players, room.round!.questionCount, PER_QUESTION_MS);
    const other = room.players.findIndex((p) => p.id !== room.players[idx].id && p.answered > 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    // Whoever it is, asking twice gives the same answer.
    expect(leaderIndexOf(room.players, room.round!.questionCount, PER_QUESTION_MS)).toBe(idx);
    expect(other).not.toBe(idx);
  });

  it('has no leader in an empty room', () => {
    expect(leaderIndexOf([], 5, PER_QUESTION_MS)).toBe(-1);
  });
});

describe('the dud rule, stated once for both cards', () => {
  // The rule: a Swap or a Steal drawn by the player who is ALREADY leading pays
  // a flat 100 instead. There is nobody above them to swap with or steal from,
  // so without this the best player on the board opens a chest and gets
  // nothing. Both halves were implemented and tested separately; this says the
  // rule out loud, in one place, for both cards at once.
  it('pays the leader 100 for a swap and 100 for a steal, identically', () => {
    for (const card of ['swap', 'steal'] as const) {
      const { state, anaId, benId, calId } = dashRoom();
      let room = allAnswer(state, [anaId, benId, calId], 0);
      room = setScores(room, { [anaId]: 900, [benId]: 100, [calId]: 400 });
      const before = totalScore(room.players);

      const result = pick(forceCard(room, card), anaId, 0, 0, pickAt(state, 0));
      expect(result.accepted).toBe(true);
      expect(result.outcome).toEqual({ kind: 'points', points: CONSOLATION_POINTS });
      expect(result.state.players.find((p) => p.id === anaId)!.score).toBe(
        900 + CONSOLATION_POINTS
      );
      // The consolation is the one deliberately non-zero-sum card: it is minted,
      // not taken, so nobody else's score moves.
      expect(result.state.players.find((p) => p.id === benId)!.score).toBe(100);
      expect(result.state.players.find((p) => p.id === calId)!.score).toBe(400);
      expect(totalScore(result.state.players)).toBe(before + CONSOLATION_POINTS);
    }
  });

  it('leaves a swap between two equal scores visibly flat, rather than silently', () => {
    // The other shape of "nothing happened": the picker is not the leader, but
    // their score and the leader's are equal, so exchanging them changes no
    // number. This is what the outcome is for. `before` and `after` come back
    // equal, which is the client's cue to say so instead of announcing a trade.
    const { state, anaId, benId, calId } = dashRoom();
    let room = allAnswer(state, [anaId, benId, calId], 0);
    room = setScores(room, { [anaId]: 400, [benId]: 400, [calId]: 100 });
    const before = totalScore(room.players);

    const leader = room.players[leaderIndexOf(room.players, room.round!.questionCount, PER_QUESTION_MS)];
    const picker = leader.id === anaId ? benId : anaId;

    const result = pick(forceCard(room, 'swap'), picker, 0, 0, pickAt(state, 0));
    expect(result.accepted).toBe(true);
    expect(result.outcome).toEqual({
      kind: 'swap',
      withPlayerId: leader.id,
      before: 400,
      after: 400,
    });
    expect(totalScore(result.state.players)).toBe(before);
    expect(result.state.players.find((p) => p.id === picker)!.score).toBe(400);
  });
});

