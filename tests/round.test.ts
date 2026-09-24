// The v2 room lifecycle, Cloud Climb, and the two things that must never leak:
// the answer key and the round seed.

import { describe, it, expect } from 'vitest';
import {
  answer,
  clampMaxPlayers,
  close,
  closeIfIdle,
  createRoom,
  drawQuestions,
  endNow,
  endRound,
  finishIfDone,
  join,
  maxPlayersFor,
  minPlayersFor,
  nextDeadline,
  nextPollMsFor,
  publicState,
  questionKey,
  scheduleEndsAt,
  settle,
  slotMsFor,
  startRound,
  toLobby,
  DEFAULT_QUESTIONS_PER_ROUND,
  GRACE_MS,
  REVEAL_MS,
  LOBBY_IDLE_MS,
  MAX_PLAYERS,
  MAX_PLAYERS_CEILING,
  MAX_PLAYERS_TEACHER,
  MAX_QUESTIONS_PER_ROUND,
  MIN_QUESTIONS_PER_ROUND,
  RESULTS_IDLE_MS,
  TEACHER_MIN_PLAYERS,
} from '../src/shared/room';
import {
  DEFAULT_PICK_MS,
  buildRanking,
  buildRoundResult,
  clampQuestionsPerRound,
  climbStepFor,
  rankingMsFor,
} from '../src/shared/round';
import { start } from '../src/shared/room';
import { buildQuestions } from '../src/shared/quiz';
import { cpuMoveMs, cpuPlan } from '../src/shared/cpu';
import {
  DEFAULT_SPEED_INDEX,
  SPEED_STOPS,
  clampSpeedIndex,
  speedRestartNeeded,
  speedScaledMs,
  speedValueText,
} from '../src/client/games/climb';
import { isHostAuthorized, roomActionAuthFor } from '../src/worker/pure';
import type {
  Player,
  PublicRoomState,
  RoomState,
  VocabItem,
  VocabSet,
} from '../src/shared/types';

const NOW = 1_000_000;
const PER_QUESTION_MS = 8000;
/** A seed distinctive enough that a recursive string search cannot miss it. */
const SENTINEL_SEED = 'SEED-SENTINEL-1c1e5e4a-do-not-leak';

function makeSet(n: number): VocabSet {
  const items: VocabItem[] = Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    zh: `中${i}`,
    pinyin: `zhong${i}`,
    en: `word${i}`,
  }));
  return { v: 1, title: 'class set', level: 'big', items };
}

/** A teacher room with two students in the lobby. The teacher is not a player. */
function classroom(itemCount = 3) {
  const room = createRoom('WXYZ', makeSet(itemCount), [], PER_QUESTION_MS, NOW, {
    teacher: true,
  });
  const a = join(room, 'Ana', NOW);
  const b = join(a.state, 'Ben', NOW);
  return { state: b.state, anaId: a.playerId!, benId: b.playerId! };
}

function startClimb(state: RoomState, seed = SENTINEL_SEED, now = NOW): RoomState {
  return startRound(state, { kind: 'climb', seed, directions: ['zh2en'] }, now);
}

/** Answers every question correctly for one player, on schedule. */
function answerAll(state: RoomState, playerId: string, correct: boolean): RoomState {
  const round = state.round!;
  let next = state;
  for (let i = 0; i < round.questionCount; i++) {
    const q = next.questions[i];
    const choice = correct ? q.answer : (q.answer + 1) % q.choices.length;
    next = answer(next, playerId, i, choice, round.startsAt + i * round.slotMs + 200);
  }
  return next;
}

describe('teacher room', () => {
  it('has no player host, so a student cannot start or end a round', () => {
    const { state } = classroom();
    expect(state.teacherRoom).toBe(true);
    expect(state.hostId).toBe('');
    expect(state.model).toBe(2);
    expect(minPlayersFor(state)).toBe(TEACHER_MIN_PLAYERS);
  });

  it('starts a round with one student, because the teacher is not a player', () => {
    const room = createRoom('WXYZ', makeSet(3), [], PER_QUESTION_MS, NOW, { teacher: true });
    const solo = join(room, 'Ana', NOW);
    expect(startClimb(solo.state).phase).toBe('round');
  });

  it('refuses to start an empty room', () => {
    const room = createRoom('WXYZ', makeSet(3), [], PER_QUESTION_MS, NOW, { teacher: true });
    expect(startClimb(room)).toBe(room);
  });
});

describe('round lifecycle', () => {
  it('runs lobby -> round -> results -> lobby with the roster intact', () => {
    const { state, anaId } = classroom(2);
    const started = startClimb(state);
    expect(started.phase).toBe('round');

    const played = answerAll(started, anaId, true);
    const ended = finishIfDone(played, started.round!.startsAt + 999_999);
    expect(ended.phase).toBe('results');

    const back = toLobby(ended, NOW + 1);
    expect(back.phase).toBe('lobby');
    expect(back.players.map((p) => p.id)).toEqual(started.players.map((p) => p.id));
    expect(back.players).toHaveLength(2);
  });

  it('refuses a join during a round and allows one back in the lobby', () => {
    const { state } = classroom(2);
    const started = startClimb(state);
    expect(join(started, 'Late', NOW + 1).playerId).toBeNull();

    const ended = finishIfDone(started, started.round!.startsAt + 999_999);
    const back = toLobby(ended, NOW + 1);
    expect(join(back, 'Late', NOW + 2).playerId).not.toBeNull();
  });

  it('zeroes the per-round fields at each round start but never the totals', () => {
    const { state, anaId } = classroom(2);
    const played = answerAll(startClimb(state), anaId, true);
    const ended = finishIfDone(played, NOW + 999_999);
    const banked = ended.players.find((p) => p.id === anaId)!;
    expect(banked.total).toBeGreaterThan(0);

    const round2 = startRound(
      toLobby(ended, NOW + 1),
      { kind: 'climb', seed: 'seed-2', directions: ['zh2en'] },
      NOW + 2
    );
    const ana = round2.players.find((p) => p.id === anaId)!;
    expect(ana.total).toBe(banked.total);
    expect(ana.wins).toBe(banked.wins);
    expect(ana.score).toBe(0);
    expect(ana.answered).toBe(0);
    expect(ana.correct).toBe(0);
    expect(ana.step).toBe(0);
    expect(ana.answeredIndexes).toEqual([]);
    expect(ana.correctIndexes).toEqual([]);
    expect(ana.pickedIndexes).toEqual([]);
  });

  it('grows history by exactly one row per round, numbered in order', () => {
    const { state, anaId } = classroom(2);
    let room = finishIfDone(answerAll(startClimb(state), anaId, true), NOW + 999_999);
    expect(room.history).toHaveLength(1);
    expect(room.history[0].n).toBe(1);
    expect(room.history[0].kind).toBe('climb');

    room = startRound(toLobby(room, NOW + 1), { kind: 'race', seed: 's2' }, NOW + 2);
    expect(room.round!.n).toBe(2);
    room = finishIfDone(answerAll(room, anaId, true), NOW + 999_999);
    expect(room.history).toHaveLength(2);
    expect(room.history[1].n).toBe(2);
    expect(room.history[1].kind).toBe('race');
  });

  it('gives the second round a different seed and a different question order', () => {
    const { state } = classroom(6);
    const r1 = startRound(state, { kind: 'race', seed: 'seed-one' }, NOW);
    const done = finishIfDone(r1, NOW + 999_999);
    const r2 = startRound(toLobby(done, NOW + 1), { kind: 'race', seed: 'seed-two' }, NOW + 2);

    expect(r2.round!.seed).not.toBe(r1.round!.seed);
    expect(r2.questions.map((q) => q.itemId)).not.toEqual(r1.questions.map((q) => q.itemId));
    // Same set, so the same number of questions either way.
    expect(r2.questions).toHaveLength(r1.questions.length);
  });

  it('gives a dash round a wider slot than a climb round on the same timer', () => {
    // Every slot is question + grace + a tail nothing is scoreable in. For race
    // and climb the tail is the projector's reveal pause; for dash it is the
    // chest-pick window, which is longer, so dash is wider and unchanged.
    expect(slotMsFor('climb', PER_QUESTION_MS)).toBe(PER_QUESTION_MS + GRACE_MS + REVEAL_MS);
    expect(slotMsFor('race', PER_QUESTION_MS)).toBe(PER_QUESTION_MS + GRACE_MS + REVEAL_MS);
    expect(slotMsFor('dash', PER_QUESTION_MS)).toBe(
      PER_QUESTION_MS + DEFAULT_PICK_MS + GRACE_MS
    );
    expect(slotMsFor('dash', PER_QUESTION_MS)).toBeGreaterThan(
      slotMsFor('climb', PER_QUESTION_MS)
    );
  });

  it('cannot start a round from results, only from the lobby', () => {
    const { state, anaId } = classroom(2);
    const ended = finishIfDone(answerAll(startClimb(state), anaId, true), NOW + 999_999);
    expect(startRound(ended, { kind: 'race', seed: 'x' }, NOW + 1)).toBe(ended);
  });

  it('closes itself after 15 idle minutes on the results screen', () => {
    const { state, anaId } = classroom(2);
    const ended = finishIfDone(answerAll(startClimb(state), anaId, true), NOW + 999_999);
    const idleAt = ended.lastActivityAt + RESULTS_IDLE_MS;

    expect(closeIfIdle(ended, idleAt - 1)).toBe(ended);
    expect(closeIfIdle(ended, idleAt).phase).toBe('closed');
    expect(settle(ended, idleAt).phase).toBe('closed');
    expect(nextDeadline(ended)).toBe(idleAt);
  });

  it('writes the running round into history when the host finishes mid-round', () => {
    const { state, anaId } = classroom(3);
    const started = startClimb(state);
    const partway = answer(started, anaId, 0, started.questions[0].answer, started.round!.startsAt);

    const closed = close(partway, NOW + 10);
    expect(closed.phase).toBe('closed');
    expect(closed.history).toHaveLength(1);
    expect(closed.players.find((p) => p.id === anaId)!.total).toBeGreaterThan(0);
  });

  it('stops every client once closed and refuses to reopen', () => {
    const { state } = classroom(2);
    const closed = close(state, NOW + 1);
    expect(close(closed, NOW + 2)).toBe(closed);
    expect(toLobby(closed, NOW + 3)).toBe(closed);
    expect(startRound(closed, { kind: 'race', seed: 'x' }, NOW + 4)).toBe(closed);
    expect(nextDeadline(closed)).toBeUndefined();
  });
});

describe('Cloud Climb', () => {
  it('puts a bean on the platform matching its correct count', () => {
    const { state, anaId } = classroom(4);
    const started = startClimb(state);
    const played = answerAll(started, anaId, true);
    const ana = played.players.find((p) => p.id === anaId)!;

    expect(ana.correct).toBe(started.round!.questionCount);
    expect(ana.step).toBe(ana.correct);
    expect(climbStepFor(ana.correct)).toBe(ana.step);
  });

  it('leaves the bean where it is on a wrong answer (a stumble, not a fall)', () => {
    const { state, anaId } = classroom(4);
    const started = startClimb(state);
    const round = started.round!;

    const right = answer(started, anaId, 0, started.questions[0].answer, round.startsAt + 100);
    expect(right.players[0].step).toBe(1);

    const q1 = started.questions[1];
    const wrong = answer(
      right,
      anaId,
      1,
      (q1.answer + 1) % q1.choices.length,
      round.startsAt + round.slotMs + 100
    );
    expect(wrong.players[0].step).toBe(1);
    expect(wrong.players[0].answered).toBe(2);
    // Nothing carries into the next question: stunSlots was cut for week 2.
    const q2 = started.questions[2];
    const after = answer(wrong, anaId, 2, q2.answer, round.startsAt + 2 * round.slotMs + 100);
    expect(after.players[0].step).toBe(2);
  });

  it('sets the tower height to the round question count', () => {
    const { state } = classroom(5);
    const started = startClimb(state);
    expect(started.round!.config).toEqual({
      kind: 'climb',
      height: started.round!.questionCount,
      questionsPerRound: started.round!.questionCount,
    });
  });

  it('ranks on the tower first, so the ordering on screen is the ordering that wins', () => {
    const { state, anaId, benId } = classroom(3);
    const started = startClimb(state);
    let room = answerAll(started, benId, true);
    // Ana gets one right, late; Ben gets everything right. Ben is higher.
    room = answer(room, anaId, 0, room.questions[0].answer, started.round!.startsAt + 5000);

    const ranking = buildRanking(room.players, started.round!.questionCount, PER_QUESTION_MS, 'climb');
    expect(ranking[0].playerId).toBe(benId);
    expect(ranking[0].step).toBeGreaterThan(ranking[1].step!);
    expect(ranking[1].playerId).toBe(anaId);
  });

  it('ties when two beans reach the same platform at the same pace', () => {
    const { state, anaId, benId } = classroom(2);
    const started = startClimb(state);
    const round = started.round!;
    let room = started;
    for (let i = 0; i < round.questionCount; i++) {
      const at = round.startsAt + i * round.slotMs + 300;
      room = answer(room, anaId, i, room.questions[i].answer, at);
      room = answer(room, benId, i, room.questions[i].answer, at);
    }
    const done = finishIfDone(room, NOW + 999_999);
    expect(done.history[0].tie).toBe(true);
    expect(done.history[0].winnerId).toBeNull();
  });
});

// --- climb ranks on the tower and the clock, and nothing else (MUST-FIX 4) ---

describe('Cloud Climb ranking', () => {
  /** A bare player row. */
  function bean(id: string, over: Partial<Player>): Player {
    return {
      id,
      name: id,
      joinedAt: NOW,
      total: 0,
      wins: 0,
      score: 0,
      answered: 0,
      correct: 0,
      totalMs: 0,
      answeredIndexes: [],
      correctIndexes: [],
      step: 0,
      pickedIndexes: [],
      ...over,
    };
  }

  /**
   * What the class is looking at: the beans ordered by how high they are, and
   * then by how fast they got there. Computed here from the players directly, so
   * it cannot inherit a mistake from the code under test.
   */
  function towerOrder(players: Player[], questionCount: number): string[] {
    return players
      .slice()
      .sort((a, b) => {
        if (a.step !== b.step) return b.step - a.step;
        return (
          rankingMsFor(a, questionCount, PER_QUESTION_MS) -
          rankingMsFor(b, questionCount, PER_QUESTION_MS)
        );
      })
      .map((p) => p.id);
  }

  it('puts the result rows in exactly the order the tower shows', () => {
    // Score deliberately disagrees with step everywhere: Cal has the most points
    // and the fewest clouds, Ana the fewest points and the most.
    const players = [
      bean('ana', { step: 5, correct: 5, answered: 5, score: 500, totalMs: 30_000 }),
      bean('ben', { step: 5, correct: 5, answered: 5, score: 900, totalMs: 40_000 }),
      bean('cal', { step: 2, correct: 2, answered: 6, score: 1200, totalMs: 1_000 }),
      bean('dee', { step: 4, correct: 4, answered: 4, score: 100, totalMs: 5_000 }),
    ];
    const questionCount = 6;

    const result = buildRoundResult(players, 1, 'climb', questionCount, PER_QUESTION_MS);
    expect(result.ranking.map((r) => r.playerId)).toEqual(towerOrder(players, questionCount));
    // Spelled out, so a future refactor cannot quietly agree with itself:
    expect(result.ranking.map((r) => r.playerId)).toEqual(['ana', 'ben', 'dee', 'cal']);
    expect(result.winnerId).toBe('ana');
    // The winner is not the highest scorer, and that is the point.
    expect(result.ranking[0].score).toBeLessThan(result.ranking[3].score);
  });

  it('breaks a same-cloud tie on time alone, not on points', () => {
    const players = [
      bean('fast', { step: 3, correct: 3, answered: 3, score: 10, totalMs: 1_000 }),
      bean('rich', { step: 3, correct: 3, answered: 3, score: 999, totalMs: 2_000 }),
    ];
    const ranking = buildRanking(players, 3, PER_QUESTION_MS, 'climb');
    expect(ranking.map((r) => r.playerId)).toEqual(['fast', 'rich']);
  });

  it('ties two beans on the same cloud at the same pace, however far apart their points', () => {
    const players = [
      bean('ana', { step: 3, correct: 3, answered: 3, score: 10, totalMs: 3_000 }),
      bean('ben', { step: 3, correct: 3, answered: 3, score: 900, totalMs: 3_000 }),
    ];
    const result = buildRoundResult(players, 1, 'climb', 3, PER_QUESTION_MS);
    expect(result.tie).toBe(true);
    expect(result.winnerId).toBeNull();
  });

  it('leaves race and dash ranking on score, where the screen shows points', () => {
    const players = [
      bean('high', { step: 1, correct: 1, answered: 3, score: 900, totalMs: 3_000 }),
      bean('tall', { step: 3, correct: 3, answered: 3, score: 100, totalMs: 3_000 }),
    ];
    for (const kind of ['race', 'dash'] as const) {
      const ranking = buildRanking(players, 3, PER_QUESTION_MS, kind);
      expect(ranking.map((r) => r.playerId)).toEqual(['high', 'tall']);
      expect(ranking[0].step).toBeUndefined();
    }
  });

  it('matches the tower on a round actually played out', () => {
    const { state, anaId, benId } = classroom(4);
    const started = startClimb(state);
    const round = started.round!;
    // Ben answers everything right but slowly; Ana gets one right, instantly.
    let room = started;
    for (let i = 0; i < round.questionCount; i++) {
      room = answer(room, benId, i, room.questions[i].answer, round.startsAt + i * round.slotMs + 6000);
    }
    room = answer(room, anaId, 0, room.questions[0].answer, round.startsAt + 1);

    const done = finishIfDone(room, NOW + 999_999);
    const result = done.history[0];
    expect(result.ranking.map((r) => r.playerId)).toEqual(
      towerOrder(room.players, round.questionCount)
    );
    expect(result.ranking[0].playerId).toBe(benId);
    expect(result.ranking[0].step).toBeGreaterThan(result.ranking[1].step!);
  });
});

describe('nothing secret reaches the wire', () => {
  /** Every key name anywhere in a JSON value, however deeply nested. */
  function keysOf(value: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
      for (const entry of value) keysOf(entry, found);
      return found;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        found.add(key);
        keysOf(entry, found);
      }
    }
    return found;
  }

  it('has no `seed` key and no `answer` key anywhere in the public state', () => {
    const { state } = classroom(4);
    const started = startClimb(state, SENTINEL_SEED);
    expect(started.round!.seed).toBe(SENTINEL_SEED);

    const keys = keysOf(publicState(started));
    expect(keys.has('seed')).toBe(false);
    expect(keys.has('answer')).toBe(false);
    // The keys we DO expect are still there, so this is not passing by emitting
    // nothing at all.
    expect(keys.has('choices')).toBe(true);
    expect(keys.has('startsAt')).toBe(true);
  });

  it('does not carry the seed value anywhere in the serialized state', () => {
    const { state } = classroom(4);
    const started = startClimb(state, SENTINEL_SEED);
    expect(JSON.stringify(started)).toContain(SENTINEL_SEED);
    expect(JSON.stringify(publicState(started))).not.toContain(SENTINEL_SEED);
  });

  it('still hides the seed once the round has ended and history is on the wire', () => {
    const { state, anaId } = classroom(2);
    const ended = finishIfDone(
      answerAll(startClimb(state, SENTINEL_SEED), anaId, true),
      NOW + 999_999
    );
    const wire = JSON.stringify(publicState(ended));
    expect(wire).not.toContain(SENTINEL_SEED);
    expect(keysOf(publicState(ended)).has('seed')).toBe(false);
  });

  it('has no itemId and no set items anywhere in a v2 public state', () => {
    const { state } = classroom(6);
    const wire = publicState(startClimb(state));

    expect(keysOf(wire).has('itemId')).toBe(false);
    expect(wire.set.items).toBeUndefined();
    // The set that IS sent is exactly the four display-safe fields.
    expect(Object.keys(wire.set).sort()).toEqual(['count', 'level', 'title', 'v']);
    expect(wire.set.count).toBe(6);
    // Not passing by emitting nothing: the question still has what it needs.
    expect(wire.questions[0].prompt).toBeTruthy();
    expect(wire.questions[0].choices.length).toBeGreaterThan(1);
  });
});

// --- the answer key cannot be rebuilt from the wire (MUST-FIX 1) -------------

describe('reconstructing the answer key from publicState alone', () => {
  /** A set whose ids and pinyin are searchable sentinels. */
  function sentinelSet(n: number): VocabSet {
    const items: VocabItem[] = Array.from({ length: n }, (_, i) => ({
      id: `ITEM-SENTINEL-${i}`,
      zh: `中${i}`,
      pinyin: `PY-SENTINEL-${i}`,
      en: `word${i}`,
    }));
    return { v: 1, title: 'sentinel set', level: 'big', items };
  }

  /**
   * Every route a player actually has to turn the wire into an answer key.
   *
   * This is the attack Codex round 1 MUST-FIX 1 described, written out: find the
   * item a question came from, read the right label off it, and look up which
   * choice that is. Two routes, because closing only the obvious one is not a
   * fix:
   *   1. `set.items`, keyed by the question's `itemId`;
   *   2. two questions that share an `itemId` and ask in opposite directions,
   *      whose two prompts ARE the item's zh and en, with no item list needed.
   *
   * Returns question index -> the answer index it managed to prove.
   */
  function reconstructAnswers(wire: PublicRoomState): Map<number, number> {
    const byId = new Map<string, { zh?: string; en?: string }>();

    for (const item of wire.set.items ?? []) {
      byId.set(item.id, { zh: item.zh, en: item.en });
    }

    for (const q of wire.questions) {
      if (typeof q.itemId !== 'string') continue;
      const seen = byId.get(q.itemId) ?? {};
      if (q.dir === 'zh2en') seen.zh ??= q.prompt;
      else seen.en ??= q.prompt;
      byId.set(q.itemId, seen);
    }

    const recovered = new Map<number, number>();
    for (const q of wire.questions) {
      if (typeof q.itemId !== 'string') continue;
      const item = byId.get(q.itemId);
      const label = q.dir === 'zh2en' ? item?.en : item?.zh;
      if (label === undefined) continue;
      const guess = q.choices.indexOf(label);
      if (guess !== -1) recovered.set(q.index, guess);
    }
    return recovered;
  }

  /** A v2 teacher room mid-round, over a sentinel set. */
  function v2Round(n = 8): RoomState {
    const room = createRoom('WXYZ', sentinelSet(n), [], PER_QUESTION_MS, NOW, {
      teacher: true,
    });
    const ana = join(room, 'Ana', NOW);
    return startRound(
      ana.state,
      { kind: 'climb', seed: SENTINEL_SEED, directions: ['zh2en', 'en2zh'] },
      NOW
    );
  }

  it('recovers nothing: not one answer, on either route', () => {
    const started = v2Round();
    const wire = publicState(started);
    expect(wire.questions.length).toBeGreaterThan(4);

    expect(reconstructAnswers(wire).size).toBe(0);
  });

  it('carries no item id and no unrelated item text at all', () => {
    const wire = JSON.stringify(publicState(v2Round()));
    // The linking key is gone, so there is nothing to join the questions on.
    expect(wire).not.toContain('ITEM-SENTINEL');
  });

  it('sends pinyin only for the prompt in front of the player, never the set', () => {
    // en2zh only: every prompt is English, so no pinyin belongs on the wire at
    // all. If item pinyin were leaking, this is where it would show.
    const room = createRoom('WXYZ', sentinelSet(8), [], PER_QUESTION_MS, NOW, {
      teacher: true,
    });
    const ana = join(room, 'Ana', NOW);
    const enOnly = startRound(
      ana.state,
      { kind: 'climb', seed: SENTINEL_SEED, directions: ['en2zh'] },
      NOW
    );
    const wire = publicState(enOnly);

    expect(JSON.stringify(wire)).not.toContain('PY-SENTINEL');
    for (const q of wire.questions) expect(q.promptPinyin).toBe('');

    // And the zh2en direction, where the prompt IS Chinese, does send its own.
    const zhOnly = startRound(
      ana.state,
      { kind: 'climb', seed: SENTINEL_SEED, directions: ['zh2en'] },
      NOW
    );
    for (const q of publicState(zhOnly).questions) {
      expect(q.promptPinyin).toMatch(/^PY-SENTINEL-\d+$/);
    }
  });

  it('DOES recover the key from a model 1 room, which is what makes this test real', () => {
    // The negative control. Same reconstructor, run against the wire shape that
    // shipped before this fix: it reads every answer. A v2 room now refuses it.
    const set = sentinelSet(8);
    const questions = buildQuestions(set, { directions: ['zh2en', 'en2zh'], seed: 7 });
    const host = join(createRoom('ABCD', set, questions, PER_QUESTION_MS, NOW), 'Host', NOW);
    const guest = join(host.state, 'Guest', NOW);
    const legacy = start(guest.state, host.playerId!, NOW);
    expect(legacy.model).toBe(1);

    const recovered = reconstructAnswers(publicState(legacy));
    expect(recovered.size).toBe(legacy.questions.length);
    for (const q of legacy.questions) {
      expect(recovered.get(q.index)).toBe(q.answer);
    }
  });
});

describe('host authorization', () => {
  const HOST_KEY = 'e8b0c2b6-0f3a-4a2c-9a1d-9a7b6c5d4e3f';

  it('accepts the teacher host key for the host actions', () => {
    for (const action of ['round', 'lobby', 'close']) {
      expect(roomActionAuthFor(action)).toBe('host');
    }
    expect(
      isHostAuthorized({ hostKey: HOST_KEY, storedHostKey: HOST_KEY, hostId: '' })
    ).toBe(true);
  });

  it('rejects a wrong, empty or missing host key', () => {
    expect(isHostAuthorized({ hostKey: 'nope', storedHostKey: HOST_KEY, hostId: '' })).toBe(false);
    expect(isHostAuthorized({ hostKey: '', storedHostKey: HOST_KEY, hostId: '' })).toBe(false);
    expect(isHostAuthorized({ storedHostKey: HOST_KEY, hostId: '' })).toBe(false);
    // A room with no stored key cannot be hosted by any key at all.
    expect(isHostAuthorized({ hostKey: HOST_KEY, hostId: '' })).toBe(false);
  });

  it('accepts the legacy player-host by id, and nobody else', () => {
    expect(isHostAuthorized({ playerId: 'p1', hostId: 'p1' })).toBe(true);
    expect(isHostAuthorized({ playerId: 'p2', hostId: 'p1' })).toBe(false);
    // A teacher room has no hostId, so an empty one must never match.
    expect(isHostAuthorized({ playerId: '', hostId: '' })).toBe(false);
  });

  it('routes answer and pick as player actions, so a host key alone is not enough', () => {
    expect(roomActionAuthFor('answer')).toBe('player');
    expect(roomActionAuthFor('pick')).toBe('player');
    expect(roomActionAuthFor('start')).toBe('player');
    expect(roomActionAuthFor('join')).toBe('none');
    expect(roomActionAuthFor('nonsense')).toBe('unknown');
  });
});

// --- MUST-FIX 3: a room the size of a class ---------------------------------

describe('how many students fit in a room', () => {
  /** A teacher room with `n` students already in the lobby. */
  function classOf(n: number, maxPlayers?: number) {
    let room = createRoom('WXYZ', makeSet(30), [], PER_QUESTION_MS, NOW, {
      teacher: true,
      maxPlayers,
    });
    for (let i = 0; i < n; i++) room = join(room, `Student ${i + 1}`, NOW).state;
    return room;
  }

  it('takes a whole class of 40 and turns away the 41st', () => {
    const full = classOf(MAX_PLAYERS_TEACHER);
    expect(full.players).toHaveLength(40);
    // The name is still trying, and the room is genuinely full now.
    const overflow = join(full, 'Latecomer', NOW);
    expect(overflow.playerId).toBeNull();
    expect(overflow.state).toBe(full);
  });

  it('lets the ninth student in, which is the bug this fixes', () => {
    const nine = join(classOf(8), 'Student 9', NOW);
    expect(nine.playerId).not.toBeNull();
    expect(nine.state.players).toHaveLength(9);
  });

  it('keeps a legacy "Race a friend" room at 8', () => {
    // No `teacher`, so this is the week-1 shape: head to head, week-1 cap.
    let room = createRoom('ABCD', makeSet(30), [], PER_QUESTION_MS, NOW);
    expect(maxPlayersFor(room)).toBe(MAX_PLAYERS);
    for (let i = 0; i < MAX_PLAYERS; i++) room = join(room, `P${i}`, NOW).state;
    expect(join(room, 'P9', NOW).playerId).toBeNull();
  });

  it('carries the configured class size for the life of the room', () => {
    const room = classOf(0, 12);
    expect(room.maxPlayers).toBe(12);
    expect(maxPlayersFor(room)).toBe(12);
    // Still 12 after a round has come and gone: the room keeps what it was made
    // with, whatever the deployed policy says an hour later.
    const played = toLobby(endRound(startClimb(join(room, 'Ana', NOW).state), NOW + 1), NOW + 2);
    expect(maxPlayersFor(played)).toBe(12);
  });

  it('tells the client the number, so "this room is full" can mean something', () => {
    expect(publicState(classOf(1)).maxPlayers).toBe(MAX_PLAYERS_TEACHER);
    expect(publicState(classOf(1, 25)).maxPlayers).toBe(25);
  });

  it('refuses a nonsense configured cap and never exceeds the ceiling', () => {
    expect(clampMaxPlayers(undefined, MAX_PLAYERS_TEACHER)).toBe(MAX_PLAYERS_TEACHER);
    expect(clampMaxPlayers('40' as unknown, MAX_PLAYERS_TEACHER)).toBe(MAX_PLAYERS_TEACHER);
    expect(clampMaxPlayers(0, MAX_PLAYERS_TEACHER)).toBe(MAX_PLAYERS_TEACHER);
    expect(clampMaxPlayers(2.5, MAX_PLAYERS_TEACHER)).toBe(MAX_PLAYERS_TEACHER);
    expect(clampMaxPlayers(1_000_000, MAX_PLAYERS_TEACHER)).toBe(MAX_PLAYERS_CEILING);
    // And a room somehow carrying a silly number is still capped on read.
    expect(maxPlayersFor({ ...classOf(0), maxPlayers: 999_999 })).toBe(MAX_PLAYERS_CEILING);
  });
});

// --- MUST-FIX 5: a round that fits a lesson ---------------------------------

describe('how long a round is', () => {
  /** A teacher room with one student and a set of `itemCount` words. */
  function ready(itemCount: number) {
    const room = createRoom('WXYZ', makeSet(itemCount), [], PER_QUESTION_MS, NOW, {
      teacher: true,
    });
    return join(room, 'Ana', NOW).state;
  }

  it('asks 12 questions by default, not the 60 a 30-word list can produce', () => {
    const started = startClimb(ready(30));
    expect(started.round!.questionCount).toBe(DEFAULT_QUESTIONS_PER_ROUND);
    expect(started.questions).toHaveLength(DEFAULT_QUESTIONS_PER_ROUND);
    // The old behaviour, for contrast: the pool this was drawn from is far
    // bigger than the round.
    expect(buildQuestions(makeSet(30), { directions: ['zh2en'] }).length).toBe(30);
  });

  it('lets the host ask for a shorter or longer round, inside the band', () => {
    for (const want of [MIN_QUESTIONS_PER_ROUND, 20, MAX_QUESTIONS_PER_ROUND]) {
      const started = startRound(
        ready(30),
        { kind: 'race', seed: SENTINEL_SEED, questionsPerRound: want },
        NOW
      );
      expect(started.round!.questionCount).toBe(want);
      expect(started.round!.config.questionsPerRound).toBe(want);
    }
  });

  it('pulls a request outside the band to the nearest end rather than obeying it', () => {
    expect(clampQuestionsPerRound(undefined)).toBe(DEFAULT_QUESTIONS_PER_ROUND);
    expect(clampQuestionsPerRound('12' as unknown)).toBe(DEFAULT_QUESTIONS_PER_ROUND);
    expect(clampQuestionsPerRound(Number.NaN)).toBe(DEFAULT_QUESTIONS_PER_ROUND);
    expect(clampQuestionsPerRound(1)).toBe(MIN_QUESTIONS_PER_ROUND);
    expect(clampQuestionsPerRound(400)).toBe(MAX_QUESTIONS_PER_ROUND);
    expect(clampQuestionsPerRound(12)).toBe(12);
  });

  it('gives a small set everything it has instead of padding with repeats', () => {
    // 4 words, one direction: 4 questions exist and 12 were asked for.
    const started = startRound(
      ready(4),
      { kind: 'race', seed: SENTINEL_SEED, directions: ['zh2en'] },
      NOW
    );
    expect(started.round!.questionCount).toBe(4);
    expect(started.round!.config.questionsPerRound).toBe(4);
    const keys = started.questions.map(questionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sizes the tower and the schedule to the round, not to the set', () => {
    const started = startClimb(ready(30));
    const round = started.round!;
    expect(round.config).toEqual({
      kind: 'climb',
      height: DEFAULT_QUESTIONS_PER_ROUND,
      questionsPerRound: DEFAULT_QUESTIONS_PER_ROUND,
    });
    // 12 questions of Cloud Climb is minutes, not the quarter of an hour a
    // 30-word list used to buy.
    expect(round.questionCount * round.slotMs).toBe(
      12 * (PER_QUESTION_MS + GRACE_MS + REVEAL_MS)
    );
  });

  it('races the whole uploaded list on the legacy path, cap and cursor ignored', () => {
    const set = makeSet(20);
    const uploaded = buildQuestions(set, { directions: ['zh2en', 'en2zh'], seed: 5 });
    expect(uploaded.length).toBeGreaterThan(MAX_QUESTIONS_PER_ROUND);
    let room = createRoom('ABCD', set, uploaded, PER_QUESTION_MS, NOW);
    const host = join(room, 'Host', NOW);
    room = join(host.state, 'Guest', NOW).state;
    const started = start(room, host.playerId!, NOW);
    expect(started.round!.questionCount).toBe(uploaded.length);
    expect(started.askedKeys).toEqual([]);
  });
});

describe('the round cursor', () => {
  function teacherRoom(itemCount: number) {
    const room = createRoom('WXYZ', makeSet(itemCount), [], PER_QUESTION_MS, NOW, {
      teacher: true,
    });
    return join(room, 'Ana', NOW).state;
  }

  it('does not repeat a question in the next round, on a 20-word set', () => {
    // 20 words both directions is a pool of 40; two rounds is 24 of them.
    const room = teacherRoom(20);
    const first = startRound(room, { kind: 'race', seed: 'seed-one' }, NOW);
    // Ended at the end of its own schedule, so all 12 questions opened and the
    // whole round counts against the cursor.
    const firstEnd = scheduleEndsAt(first)!;
    const between = toLobby(endRound(first, firstEnd), firstEnd + 1000);
    const second = startRound(between, { kind: 'race', seed: 'seed-two' }, firstEnd + 2000);

    const firstKeys = first.questions.map(questionKey);
    const secondKeys = second.questions.map(questionKey);
    expect(firstKeys).toHaveLength(12);
    expect(secondKeys).toHaveLength(12);
    expect(secondKeys.filter((k) => firstKeys.includes(k))).toEqual([]);
  });

  it('keeps working through the set until it is exhausted, then starts again', () => {
    let state = teacherRoom(20);
    const pool = buildQuestions(makeSet(20), { directions: ['zh2en', 'en2zh'] });
    const seen: string[][] = [];

    // Three rounds is 36 of the 40 available: still no repeat anywhere.
    for (let n = 1; n <= 3; n++) {
      const started = startRound(state, { kind: 'race', seed: `seed-${n}` }, NOW + n * 200_000);
      seen.push(started.questions.map(questionKey));
      const ended = scheduleEndsAt(started)!;
      state = toLobby(endRound(started, ended), ended + 1000);
    }
    const all = seen.flat();
    expect(all).toHaveLength(36);
    expect(new Set(all).size).toBe(36);
    expect(state.askedKeys).toHaveLength(36);

    // Round four: only 4 unasked questions are left, so the cycle restarts and
    // the round is still a full 12 rather than a stub.
    const fourth = startRound(state, { kind: 'race', seed: 'seed-4' }, NOW + 1_000_000);
    const fourthKeys = fourth.questions.map(questionKey);
    expect(fourthKeys).toHaveLength(12);
    expect(new Set(fourthKeys).size).toBe(12);
    const leftovers = pool.map(questionKey).filter((k) => !all.includes(k));
    expect(leftovers).toHaveLength(4);
    for (const key of leftovers) expect(fourthKeys).toContain(key);
    // The cursor restarted with this round, so the next one has 28 to choose from.
    expect(endRound(fourth, scheduleEndsAt(fourth)!).askedKeys).toEqual(fourthKeys);
  });

  it('renumbers what it draws, so index is the ordinal a client answers with', () => {
    const started = startRound(teacherRoom(20), { kind: 'race', seed: 'seed-x' }, NOW);
    expect(started.questions.map((q) => q.index)).toEqual([...Array(12).keys()]);
  });

  it('draws fresh first, then recycles, and reports the cursor either way', () => {
    const pool = buildQuestions(makeSet(6), { directions: ['zh2en'] });
    expect(pool).toHaveLength(6);

    const first = drawQuestions(pool, [], 4);
    expect(first.questions).toHaveLength(4);
    expect(first.askedKeys).toHaveLength(4);

    const second = drawQuestions(pool, first.askedKeys, 4);
    expect(second.questions).toHaveLength(4);
    // Two fresh were left, so two came from a restarted cycle, and the cursor
    // now records this round only.
    expect(second.askedKeys).toEqual(second.questions.map(questionKey));
    expect(new Set(second.questions.map(questionKey)).size).toBe(4);
  });

  it('keeps the cursor off the wire', () => {
    const started = startRound(teacherRoom(20), { kind: 'race', seed: 'seed-y' }, NOW);
    const ended = endRound(started, scheduleEndsAt(started)!);
    expect(ended.askedKeys).toHaveLength(12);
    expect(publicState(started)).not.toHaveProperty('askedKeys');
    expect(JSON.stringify(publicState(started))).not.toContain('askedKeys');
    expect(JSON.stringify(publicState(ended))).not.toContain('askedKeys');
  });

  // The cursor is committed at the END of a round, over the questions whose
  // window actually opened, not at the start (Codex round 2, MUST-FIX 1). A
  // teacher who starts the wrong game and ends it must not burn the set.
  describe('commits only what the class actually saw', () => {
    it('consumes nothing when the round is ended before it starts', () => {
      const started = startRound(teacherRoom(20), { kind: 'race', seed: 'seed-a' }, NOW);
      const before = started.round!.startsAt - 1;
      const ended = endRound(started, before);
      expect(ended.askedKeys).toEqual([]);

      // And the next round may draw the same 12 again, because nobody saw them.
      const next = startRound(toLobby(ended, before + 1000), { kind: 'race', seed: 'seed-a' }, before + 2000);
      expect(next.questions.map(questionKey)).toEqual(started.questions.map(questionKey));
    });

    it('consumes exactly the three questions that opened, of twelve', () => {
      const started = startRound(teacherRoom(20), { kind: 'race', seed: 'seed-b' }, NOW);
      const round = started.round!;
      // Part way through question 3 (index 2): three windows have opened.
      const ended = endRound(started, round.startsAt + 2 * round.slotMs + 500);
      const asked = started.questions.map(questionKey);
      expect(ended.askedKeys).toEqual(asked.slice(0, 3));

      // The nine that never opened are still unasked, so the next round may draw
      // them again; only the three the class saw are off the table.
      const next = startRound(toLobby(ended, NOW + 100_000), { kind: 'race', seed: 'seed-b2' }, NOW + 101_000);
      const nextKeys = next.questions.map(questionKey);
      expect(nextKeys.filter((k) => asked.slice(0, 3).includes(k))).toEqual([]);
      expect(nextKeys.filter((k) => asked.slice(3).includes(k)).length).toBeGreaterThan(0);
    });

    it('a full round consumes all twelve', () => {
      const started = startRound(teacherRoom(20), { kind: 'race', seed: 'seed-c' }, NOW);
      const ended = endRound(started, scheduleEndsAt(started)!);
      expect(ended.askedKeys).toEqual(started.questions.map(questionKey));
    });

    it('keeps the cursor right when a recycle round is ended inside its leftovers', () => {
      // 6 words, one direction: a pool of 6, drawn 4 at a time. Round one takes
      // 4, so round two has 2 leftovers and recycles 2 already-seen ones.
      let state = teacherRoom(6);
      const first = startRound(
        state,
        { kind: 'race', seed: 'r1', directions: ['zh2en'], questionsPerRound: MIN_QUESTIONS_PER_ROUND },
        NOW
      );
      expect(first.questions).toHaveLength(6);
      state = toLobby(endRound(first, scheduleEndsAt(first)!), NOW + 200_000);
      expect(state.askedKeys).toHaveLength(6);

      // 8 words in one direction: a pool of 8, and a 6-question round leaves 2.
      let big = teacherRoom(8);
      const r1 = startRound(
        big,
        { kind: 'race', seed: 'b1', directions: ['zh2en'], questionsPerRound: MIN_QUESTIONS_PER_ROUND },
        NOW
      );
      expect(r1.questions).toHaveLength(6);
      big = toLobby(endRound(r1, scheduleEndsAt(r1)!), NOW + 200_000);
      const cycleOne = r1.questions.map(questionKey);
      expect(big.askedKeys).toEqual(cycleOne);

      // Round two: 2 fresh leftovers, then 4 recycled from cycle one.
      const r2 = startRound(
        big,
        { kind: 'race', seed: 'b2', directions: ['zh2en'], questionsPerRound: MIN_QUESTIONS_PER_ROUND },
        NOW + 201_000
      );
      const r2Keys = r2.questions.map(questionKey);
      const leftovers = r2Keys.filter((k) => !cycleOne.includes(k));
      expect(leftovers).toHaveLength(2);
      expect(r2Keys.slice(0, 2)).toEqual(leftovers);

      // Ended while still inside the leftovers: the old cycle simply gains them,
      // so cycle one is finished rather than thrown away and restarted.
      const round = r2.round!;
      const stoppedEarly = endRound(r2, round.startsAt + round.slotMs + 500);
      expect(stoppedEarly.askedKeys).toEqual([...cycleOne, ...leftovers]);
      expect(stoppedEarly.askedKeys).toHaveLength(8);

      // Ended past the recycle boundary: the new cycle is this round alone.
      const ranOn = endRound(r2, round.startsAt + 3 * round.slotMs + 500);
      expect(ranOn.askedKeys).toEqual(r2Keys.slice(0, 4));
    });

    it('leaves the cursor alone on the legacy path', () => {
      const set = makeSet(6);
      const uploaded = buildQuestions(set, { directions: ['zh2en'] });
      let room = createRoom('ABCD', set, uploaded, PER_QUESTION_MS, NOW);
      const host = join(room, 'Host', NOW);
      room = join(host.state, 'Guest', NOW).state;
      const started = start(room, host.playerId!, NOW);
      expect(endRound(started, scheduleEndsAt(started)!).askedKeys).toEqual([]);
    });
  });
});

describe('ending a round without ending the lesson', () => {
  it('stops the round where it is and shows the scores as they stand', () => {
    const { state, anaId, benId } = classroom(20);
    const started = startClimb(state);
    const round = started.round!;

    // Ana answers the first three; Ben answers nothing. Nine questions are still
    // unasked when the teacher ends it.
    let played = started;
    for (let i = 0; i < 3; i++) {
      played = answer(played, anaId, i, played.questions[i].answer, round.startsAt + i * round.slotMs + 200);
    }
    const scoreBefore = played.players.find((p) => p.id === anaId)!.score;
    expect(scoreBefore).toBeGreaterThan(0);

    const ended = endNow(played, round.startsAt + 3 * round.slotMs + 500);
    expect(ended.phase).toBe('results');
    expect(ended.history).toHaveLength(1);
    expect(ended.history[0].winnerId).toBe(anaId);
    // The scores were not recomputed or discarded: they were banked as they were.
    expect(ended.players.find((p) => p.id === anaId)!.total).toBe(scoreBefore);
    expect(ended.players.find((p) => p.id === benId)!.total).toBe(0);
    expect(ended.round!.endedAt).toBeDefined();
  });

  it('is not "finish": the room stays usable and the class stays in it', () => {
    const { state } = classroom(20);
    const ended = endNow(startClimb(state), NOW + 5000);
    expect(ended.phase).toBe('results');
    expect(ended.players).toHaveLength(2);
    // Every device keeps polling, and the next game is one tap away.
    expect(nextPollMsFor(ended.phase, ended.model)).toBe(2000);
    const again = toLobby(ended, NOW + 6000);
    expect(again.phase).toBe('lobby');
    expect(startClimb(again, 'seed-two', NOW + 7000).phase).toBe('round');

    // Whereas close() is the end of the lesson, and there is no way back.
    const closed = close(ended, NOW + 8000);
    expect(closed.phase).toBe('closed');
    expect(nextPollMsFor(closed.phase, closed.model)).toBe(0);
    expect(toLobby(closed, NOW + 9000)).toBe(closed);
  });

  it('is safe to press twice, and does nothing outside a round', () => {
    const { state } = classroom(20);
    const ended = endNow(startClimb(state), NOW + 5000);
    expect(endNow(ended, NOW + 6000)).toBe(ended);
    expect(endNow(state, NOW + 1000)).toBe(state);
    expect(endNow(close(state, NOW + 1000), NOW + 2000).phase).toBe('closed');
  });

  it('is a host action, so a student cannot end the class game', () => {
    expect(roomActionAuthFor('end')).toBe('host');
  });
});

describe('a room nobody is using', () => {
  it('closes a lobby after 30 minutes of nothing happening', () => {
    const { state } = classroom(3);
    expect(state.phase).toBe('lobby');
    expect(closeIfIdle(state, NOW + LOBBY_IDLE_MS - 1)).toBe(state);
    expect(closeIfIdle(state, NOW + LOBBY_IDLE_MS).phase).toBe('closed');
    // Polling is deliberately not activity, but joining is.
    const late = join(state, 'Cal', NOW + LOBBY_IDLE_MS - 1000);
    expect(closeIfIdle(late.state, NOW + LOBBY_IDLE_MS + 500)).toBe(late.state);
  });

  it('wakes the room up at the lobby deadline, which is what the alarm needs', () => {
    const { state } = classroom(3);
    expect(nextDeadline(state)).toBe(state.lastActivityAt + LOBBY_IDLE_MS);
    const ended = endNow(startClimb(state), NOW + 5000);
    expect(nextDeadline(ended)).toBe(ended.lastActivityAt + RESULTS_IDLE_MS);
    expect(nextDeadline(close(ended, NOW + 6000))).toBeUndefined();
  });

  it('closes a lobby a finished round dropped the class back into', () => {
    const { state } = classroom(3);
    const back = toLobby(endNow(startClimb(state), NOW + 5000), NOW + 6000);
    expect(back.phase).toBe('lobby');
    expect(settle(back, NOW + 6000 + LOBBY_IDLE_MS).phase).toBe('closed');
  });

  it('points the alarm at the results deadline the moment a round ends', () => {
    // The bug this pins (SHOULD-FIX 4 and 5): the DO used to re-arm before
    // settling, so when the last action of a round ended it, the alarm was left
    // on the round's schedule end instead of the deadline the room had moved to.
    const { state, anaId } = classroom(2);
    const started = startClimb(state);
    const overrun = started.round!.startsAt + started.round!.questionCount * started.round!.slotMs;
    const settled = settle(answerAll(started, anaId, true), overrun);
    expect(settled.phase).toBe('results');
    expect(nextDeadline(settled)).toBe(settled.lastActivityAt + RESULTS_IDLE_MS);
  });
});

// --- what a poll actually costs ---------------------------------------------

describe('poll payload', () => {
  /** A 30-word teacher room, mid-round, every seat taken and everybody answering. */
  function fullClassroom(players = 30) {
    let room = createRoom('WXYZ', makeSet(30), [], PER_QUESTION_MS, NOW, { teacher: true });
    for (let i = 0; i < players; i++) room = join(room, `Student ${i + 1}`, NOW).state;
    const lobby = room;
    let started = startRound(room, { kind: 'dash', seed: 'payload-seed' }, NOW);
    const round = started.round!;
    for (let q = 0; q < round.questionCount; q++) {
      const at = round.startsAt + q * round.slotMs + 120;
      for (const p of started.players) {
        started = answer(started, p.id, q, started.questions[q].answer, at);
      }
    }
    return { lobby, mid: started, done: endRound(started, NOW + 999_999) };
  }

  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

  it('sends the question list during a round and never outside one', () => {
    const { lobby, mid, done } = fullClassroom();
    expect(lobby.phase).toBe('lobby');
    expect(publicState(lobby).questions).toEqual([]);
    expect(publicState(mid).questions).toHaveLength(mid.round!.questionCount);
    expect(publicState(done).questions).toEqual([]);
    expect(publicState(toLobby(done, NOW + 1)).questions).toEqual([]);
    expect(publicState(close(done, NOW + 1)).questions).toEqual([]);
  });

  it('still sends them in a legacy room, whose week-1 client reads them', () => {
    const set = makeSet(3);
    const uploaded = buildQuestions(set, { directions: ['zh2en'], seed: 9 });
    let room = createRoom('ABCD', set, uploaded, PER_QUESTION_MS, NOW);
    const host = join(room, 'Host', NOW);
    room = join(host.state, 'Guest', NOW).state;
    expect(room.model).toBe(1);
    expect(publicState(room).questions).toHaveLength(uploaded.length);
  });

  it('measures the poll for 30 players and 12 questions, and says where the bytes are', () => {
    const { lobby, mid } = fullClassroom();
    const midState = publicState(mid);
    const total = bytes(midState);
    const questionBytes = bytes(midState.questions);
    const playerBytes = bytes(midState.players);

    // Dropping the question list is worth this much on every non-round poll,
    // which is every poll in the lobby and on the results screen.
    // Dropping the question list is worth ~1.3 KB on every poll that is not
    // during a round, which is every poll in the lobby and on the results
    // screen. That is the payload fix that landed.
    expect(questionBytes).toBeGreaterThan(1_200);
    expect(bytes(publicState(lobby))).toBeLessThan(total - questionBytes + 200);

    // Measured on this fixture: total 9,385 / questions 1,323 / players 7,522,
    // and 6,024 for the same room sitting in the lobby. Pinned so a regression
    // shows up as a failure rather than as a slow lesson.
    //
    // This is NOT the 6 KB the review asked for during a round, and the
    // arithmetic says why: a player row is ~250 bytes and thirty of them are
    // ~7.5 KB on their own, so no amount of trimming the question list reaches
    // 6 KB with a class this size. Reaching it means slimming the player ROW.
    // The two candidates, both server-side but both breaking wire changes and
    // therefore a separate decision: `correctIndexes` is read by no client at
    // all (~1.3 KB), and `answeredIndexes` is only ever read for the polling
    // device's OWN row, which would need the poll to say who is asking.
    expect(total).toBeLessThan(10_000);
    expect(playerBytes).toBeGreaterThan(total * 0.7);
  });

  it('holds a full class of 40 under the 12 KB ceiling, mid-round', () => {
    // The cap the policy actually seats is 40, not the 30 the first payload
    // measurement used, so the guard now covers the worst case a real class can
    // reach (Codex round 2, SHOULD-FIX 3).
    //
    // Measured on this fixture, every seat taken and every question answered:
    // TOTAL 11,895 bytes, of which 10,032 is the forty player rows and 1,323
    // the question list. THE ACCEPTED CEILING IS 12 KB (12,288 bytes) for a
    // mid-round poll at the maximum roster, which at a 1s round poll is about
    // 12 KB/s down to each device. It is over the 6 KB the round-1 review asked
    // for, and deliberately so: a player row is ~250 bytes, so forty of them
    // are 10 KB whatever happens to the question list. Getting under 6 KB means
    // slimming the player ROW, which is a breaking wire change and a separate
    // decision, NOT taken this round.
    const { mid } = fullClassroom(MAX_PLAYERS_TEACHER);
    const midState = publicState(mid);
    expect(midState.players).toHaveLength(40);
    const total = bytes(midState);
    expect(total).toBeLessThan(12_288);
    // Where the bytes are, pinned so a wire change that moves them fails here
    // rather than in a classroom.
    expect(bytes(midState.players)).toBeGreaterThan(total * 0.8);
    expect(bytes(midState.questions)).toBeLessThan(1_500);
  });
});

// --- Cloud Climb's Speed slider (solo) ---------------------------------------
//
// Speed is a pure division of the per-question budget. `climb.ts` is importable
// in a node run for the same reason `tone-catcher.ts` is: its board and its
// stylesheet are lazy imports, so nothing here drags three or CSS into the run.

describe('cloud climb speed', () => {
  it('has five stops, 1x to 3x, with Quick the default', () => {
    expect(SPEED_STOPS.map((stop) => stop.name)).toEqual([
      'Chill',
      'Steady',
      'Quick',
      'Fast',
      'Turbo',
    ]);
    expect(SPEED_STOPS.map((stop) => stop.multiplier)).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(SPEED_STOPS[DEFAULT_SPEED_INDEX].name).toBe('Quick');
  });

  it('falls back to the default stop for anything that is not one of the five', () => {
    for (const stored of ['0', '4', 0, 4]) {
      expect(clampSpeedIndex(stored)).toBe(Number(stored));
    }
    // A stale key, a hand-edited value, a value from a build with more stops.
    for (const junk of [null, undefined, '', ' ', 'turbo', '2.5', 2.5, -1, 5, NaN]) {
      expect(clampSpeedIndex(junk)).toBe(DEFAULT_SPEED_INDEX);
    }
  });

  it('divides the level budget by the stop multiplier, in whole ms', () => {
    // kids = 12s, big = 8s (perQuestionMsFor).
    expect(speedScaledMs(12_000, 0)).toBe(12_000);
    expect(speedScaledMs(12_000, 1)).toBe(8_000);
    expect(speedScaledMs(12_000, DEFAULT_SPEED_INDEX)).toBe(6_000);
    expect(speedScaledMs(12_000, 3)).toBe(4_800);
    expect(speedScaledMs(12_000, 4)).toBe(4_000);
    // 8000 / 1.5 = 5333.33: rounded, never fractional, because it becomes a
    // schedule instant the reducers do integer arithmetic on.
    expect(speedScaledMs(8_000, 1)).toBe(5_333);
    expect(Number.isInteger(speedScaledMs(8_000, 3))).toBe(true);
    // An unknown stop scales by the default rather than not scaling at all.
    expect(speedScaledMs(12_000, 99)).toBe(6_000);
  });

  it('shrinks every question slot, and slotMsFor has no floor to stop it', () => {
    // Solo carries no projector pause, so a slot is budget + grace and nothing
    // else. The tightest schedule the slider can ask for is Turbo on the BIG
    // level (8000 / 3 = 2667 ms), not on kids (12000 / 3 = 4000 ms), and both
    // are honoured exactly: slotMsFor has no floor that clamps them back up.
    const chill = speedScaledMs(12_000, 0);
    const turbo = speedScaledMs(12_000, 4);
    const turboBig = speedScaledMs(8_000, 4);
    expect(turboBig).toBe(2_667);
    expect(slotMsFor('climb', chill, undefined, 0)).toBe(12_000 + GRACE_MS);
    expect(slotMsFor('climb', turbo, undefined, 0)).toBe(4_000 + GRACE_MS);
    expect(slotMsFor('climb', turboBig, undefined, 0)).toBe(2_667 + GRACE_MS);
    expect(slotMsFor('climb', turbo, undefined, 0)).toBeLessThan(
      slotMsFor('climb', chill, undefined, 0)
    );
  });

  it('scales the CPU beans automatically, because their plan is fractions', () => {
    // cpuPlan stores `ms` as a fraction of the budget, so the SAME plan replays
    // proportionally faster at Turbo. This is the reason the slider does not
    // have to touch src/shared/cpu.ts at all.
    const plan = cpuPlan('solo-seed:Pip', 6, 'normal');
    const chill = speedScaledMs(12_000, 0);
    const turbo = speedScaledMs(12_000, 4);
    for (const move of plan) {
      expect(cpuMoveMs(move, chill)).toBe(Math.round(move.ms * 12_000));
      expect(cpuMoveMs(move, turbo)).toBe(Math.round(move.ms * 4_000));
      // Still inside its own window at the tightest budget, so no move is ever
      // silently dropped for landing past the close.
      expect(cpuMoveMs(move, turbo)).toBeLessThan(turbo);
      expect(cpuMoveMs(move, turbo)).toBeGreaterThan(0);
    }
  });

  it('keeps every CPU move inside the window at the tightest budget (big + Turbo)', () => {
    // 8000 / 3 = 2667 ms is the smallest budget the slider can produce. If any
    // pace's plan landed on or past that close, a bean would freeze for a whole
    // question, so all three paces are checked, not just 'normal'.
    const turboBig = speedScaledMs(8_000, 4);
    expect(turboBig).toBe(2_667);
    for (const pace of ['easy', 'normal', 'fast'] as const) {
      const plan = cpuPlan(`solo-seed:${pace}`, 12, pace);
      expect(plan.length).toBeGreaterThan(0);
      for (const move of plan) {
        const at = cpuMoveMs(move, turboBig);
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(turboBig);
      }
    }
  });

  it('restarts only when the committed stop is not the round\'s own stop', () => {
    // The rule the whole gesture path exists for: a drag or a key burst that
    // wanders and comes home must NOT throw the child's round away, and any
    // other landing must. Deleting the equality half of this used to pass every
    // gate in the repo.
    for (let index = 0; index < SPEED_STOPS.length; index++) {
      expect(speedRestartNeeded(index, index)).toBe(false);
    }
    expect(speedRestartNeeded(0, 3)).toBe(true);
    expect(speedRestartNeeded(3, 0)).toBe(true);
    expect(speedRestartNeeded(DEFAULT_SPEED_INDEX, DEFAULT_SPEED_INDEX + 1)).toBe(true);
  });

  it('announces the stop name and how fast it is', () => {
    // A screen reader reads aria-valuetext, and "Fast" alone does not say how
    // fast, so the multiplier rides along.
    expect(speedValueText(0)).toBe('Chill, 1 times speed');
    expect(speedValueText(1)).toBe('Steady, 1.5 times speed');
    expect(speedValueText(DEFAULT_SPEED_INDEX)).toBe('Quick, 2 times speed');
    expect(speedValueText(4)).toBe('Turbo, 3 times speed');
    // An out-of-range index announces the default rather than throwing.
    expect(speedValueText(99)).toBe('Quick, 2 times speed');
    expect(speedValueText(-1)).toBe('Quick, 2 times speed');
  });

  it('turns a 12-question kids round from 162s into 66s', () => {
    // The owner's complaint, as a number: 12 questions, kids level, solo.
    const questions = 12;
    const at = (index: number): number =>
      questions * slotMsFor('climb', speedScaledMs(12_000, index), undefined, 0);
    expect(at(0)).toBe(162_000);
    expect(at(DEFAULT_SPEED_INDEX)).toBe(90_000);
    expect(at(4)).toBe(66_000);
  });
});

