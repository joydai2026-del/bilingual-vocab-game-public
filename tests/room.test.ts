// The v1 race rules, still true in the v2 room model.
//
// Everything here goes through the LEGACY path (createRoom with uploaded
// questions, then `start`), because that is the path a week-1 client uses and
// the one thing this rewrite must not break. The v2 lifecycle, Cloud Climb and
// Treasure Dash live in round.test.ts and dash.test.ts.

import { describe, it, expect } from 'vitest';
import {
  createRoom,
  join,
  start,
  answer,
  finishIfDone,
  buildResult,
  nextPollMsFor,
  scheduleEndsAt,
  questionWindow,
  rankingMsFor,
  publicState,
  revealedChoice,
  revealPauseFor,
  slotMsFor,
  startRound,
  currentWindowClosesAt,
  inactivityFinishAt,
  CHOICE_WITHHELD,
  GRACE_MS,
  REVEAL_MS,
  MIN_PLAYERS,
} from '../src/shared/room';
import { buildQuestions } from '../src/shared/quiz';
import type { Player, VocabItem, VocabSet } from '../src/shared/types';

function makeSet(n: number): VocabSet {
  const items: VocabItem[] = Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    zh: `中${i}`,
    pinyin: `zhong${i}`,
    en: `word${i}`,
  }));
  return { v: 1, title: 'room set', level: 'big', items };
}

const NOW = 1_000_000;
const PER_QUESTION_MS = 8000;
// question, then the grace on a late answer, then the pause in which the
// projector holds the right answer up (REVEAL_MS).
const SLOT_MS = PER_QUESTION_MS + GRACE_MS + REVEAL_MS;
// The same slot in a room with no projector: the legacy "race a friend" shape
// and the solo games, where each child reads the answer off her own screen the
// instant she taps and so has nothing to wait for (round-2 review, SHOULD-FIX 3).
const NO_PROJECTOR_SLOT_MS = PER_QUESTION_MS + GRACE_MS;

function freshRoom(itemCount = 3) {
  const set = makeSet(itemCount);
  const questions = buildQuestions(set, { directions: ['zh2en'], seed: 1 });
  return createRoom('ABCD', set, questions, PER_QUESTION_MS, NOW);
}

/**
 * A lobby with the two players a head-to-head race needs. Returns the host's id
 * first. Almost every test below needs this, because start() refuses a
 * one-player room.
 */
function lobbyOfTwo(itemCount = 3) {
  const host = join(freshRoom(itemCount), 'Host', NOW);
  const guest = join(host.state, 'Guest', NOW);
  return { state: guest.state, hostId: host.playerId!, guestId: guest.playerId! };
}

/** A bare player row, for the ranking helpers that take one directly. */
function playerRow(over: Partial<Player> & { id: string; name: string }): Player {
  return {
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

describe('createRoom', () => {
  it('starts a legacy room at model 1 with no round and no history', () => {
    const room = freshRoom();
    expect(room.model).toBe(1);
    expect(room.teacherRoom).toBe(false);
    expect(room.phase).toBe('lobby');
    expect(room.round).toBeUndefined();
    expect(room.history).toEqual([]);
    expect(room.defaultPerQuestionMs).toBe(PER_QUESTION_MS);
    expect(room.version).toBe(1);
  });

  it('derives a race slot from perQuestionMs plus the feedback gap', () => {
    const { state, hostId } = lobbyOfTwo();
    // A legacy "race a friend" room has no projector, so no reveal pause.
    expect(start(state, hostId, NOW).round!.slotMs).toBe(NO_PROJECTOR_SLOT_MS);
    expect(slotMsFor('race', PER_QUESTION_MS, undefined, 0)).toBe(NO_PROJECTOR_SLOT_MS);
    expect(slotMsFor('race', PER_QUESTION_MS)).toBe(SLOT_MS);
  });

  it('gives a teacher room the projector pause and a friend room none', () => {
    const teacherLobby = join(
      createRoom('WXYZ', makeSet(3), [], PER_QUESTION_MS, NOW, { teacher: true }),
      'Ana',
      NOW
    );
    const teacherRound = startRound(
      teacherLobby.state,
      { kind: 'race', seed: 'seed' },
      NOW
    ).round!;
    expect(teacherRound.revealMs).toBe(REVEAL_MS);
    expect(teacherRound.slotMs).toBe(SLOT_MS);

    const friends = lobbyOfTwo();
    const friendRound = start(friends.state, friends.hostId, NOW).round!;
    expect(friendRound.revealMs).toBe(0);
    expect(friendRound.slotMs).toBe(NO_PROJECTOR_SLOT_MS);
  });
});

describe('join', () => {
  it('makes the first joiner the host', () => {
    const { state, playerId } = join(freshRoom(), 'Alice', NOW);
    expect(state.hostId).toBe(playerId);
    expect(state.players).toHaveLength(1);
  });

  it('caps the room at 8 players', () => {
    let state = freshRoom();
    let lastId: string | null = null;
    for (let i = 0; i < 8; i++) {
      const res = join(state, `Player${i}`, NOW);
      state = res.state;
      lastId = res.playerId;
    }
    expect(state.players).toHaveLength(8);
    expect(lastId).not.toBeNull();

    const res9 = join(state, 'Player9', NOW);
    expect(res9.playerId).toBeNull();
    expect(res9.state.players).toHaveLength(8);
  });

  it('freezes the roster once a round has started (no late joins)', () => {
    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);

    const late = join(started, 'Latecomer', NOW + 500);
    expect(late.playerId).toBeNull();
    expect(late.state.players).toHaveLength(2);
  });

  it('bumps the version on a successful join and leaves it alone on a rejected one', () => {
    const room = freshRoom();
    const j1 = join(room, 'Host', NOW);
    expect(j1.state.version).toBe(room.version + 1);

    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);
    const late = join(started, 'Latecomer', NOW + 10);
    expect(late.state.version).toBe(started.version);
  });
});

describe('start (the v1 "Race a friend" alias)', () => {
  it('is a no-op for a non-host player', () => {
    const { state, guestId } = lobbyOfTwo();

    const started = start(state, guestId, NOW);
    expect(started.phase).toBe('lobby');
    expect(started.round).toBeUndefined();
  });

  it('starts the room for the host and sets startsAt 3s out', () => {
    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);
    expect(started.phase).toBe('round');
    expect(started.round!.startsAt).toBe(NOW + 3000);
    expect(started.round!.config.kind).toBe('race');
    expect(started.round!.n).toBe(1);
    expect(started.version).toBe(state.version + 1);
  });

  it('races the questions the creator uploaded, not a fresh shuffle', () => {
    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);
    expect(started.questions).toEqual(state.questions);
  });

  it('leaves the room at model 1, so a week-1 client keeps working', () => {
    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);
    expect(started.model).toBe(1);
    expect(publicState(started).phase).toBe('playing');
  });

  it('refuses to start a one-player room, even for the host', () => {
    const solo = join(freshRoom(), 'Host', NOW);
    expect(solo.state.players).toHaveLength(1);
    expect(MIN_PLAYERS).toBe(2);

    const started = start(solo.state, solo.playerId!, NOW);
    expect(started).toBe(solo.state);
    expect(started.phase).toBe('lobby');
  });

  it('starts as soon as the second player has joined', () => {
    const solo = join(freshRoom(), 'Host', NOW);
    expect(start(solo.state, solo.playerId!, NOW).phase).toBe('lobby');

    const pair = join(solo.state, 'Guest', NOW);
    expect(start(pair.state, solo.playerId!, NOW).phase).toBe('round');
  });

  it('is a no-op once a round is already running', () => {
    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);
    const startedAgain = start(started, hostId, NOW + 100);
    expect(startedAgain).toEqual(started);
  });
});

describe('question windows', () => {
  it('spaces each question one slot apart and closes it after perQuestionMs', () => {
    const w0 = questionWindow(NOW, SLOT_MS, PER_QUESTION_MS, 0);
    const w1 = questionWindow(NOW, SLOT_MS, PER_QUESTION_MS, 1);
    expect(w0).toEqual({ opensAt: NOW, closesAt: NOW + PER_QUESTION_MS });
    expect(w1.opensAt).toBe(NOW + SLOT_MS);
  });

  it('scheduleEndsAt is exactly one slot per question, no extra grace', () => {
    const { state, hostId } = lobbyOfTwo(3);
    const started = start(state, hostId, NOW);
    // The last question's own grace AND its reveal pause are already inside its
    // slot: it opens at 2*slotMs, closes PER_QUESTION_MS later, its grace runs
    // GRACE_MS beyond that, and the projector then holds the answer up for the
    // round's own pause, which together are one more slot and no more. That last
    // stretch is why the round does not end on the instant the last answer
    // becomes legal, which is the bug that made word 12 unrevealable.
    const slotMs = started.round!.slotMs;
    const pauseMs = revealPauseFor(started.round!);
    expect(scheduleEndsAt(started)).toBe(NOW + 3000 + 3 * slotMs);

    const lastOpensAt = NOW + 3000 + 2 * slotMs;
    expect(scheduleEndsAt(started)).toBe(lastOpensAt + PER_QUESTION_MS + GRACE_MS + pauseMs);
  });

  it('has no schedule end before a round starts', () => {
    expect(scheduleEndsAt(freshRoom())).toBeUndefined();
  });
});

describe('answer', () => {
  // Question 0's window opens at startsAt (NOW + 3000) and closes at
  // startsAt + perQuestionMs (NOW + 11000), with a 1500ms grace after that.
  const OPENS_AT = NOW + 3000;
  const IN_WINDOW = OPENS_AT + 500;

  function startedRoom(itemCount = 3) {
    const { state, hostId } = lobbyOfTwo(itemCount);
    return { state: start(state, hostId, NOW), playerId: hostId };
  }

  it('first write wins per (playerId, index)', () => {
    const { state: started, playerId } = startedRoom();

    const once = answer(started, playerId, 0, started.questions[0].answer, IN_WINDOW);
    const twice = answer(once, playerId, 0, started.questions[0].answer, IN_WINDOW + 1000);

    expect(twice.players[0].answered).toBe(1);
    expect(twice.players[0].score).toBe(once.players[0].score);
    expect(twice).toEqual(once);
  });

  it('ignores an out-of-range question index', () => {
    const { state: started, playerId } = startedRoom();
    expect(answer(started, playerId, 999, 0, IN_WINDOW)).toEqual(started);
    expect(answer(started, playerId, -1, 0, IN_WINDOW)).toEqual(started);
  });

  it('ignores an answer from a player who is not in the room', () => {
    const { state: started } = startedRoom();
    expect(answer(started, 'ghost', 0, 0, IN_WINDOW)).toEqual(started);
  });

  it('scores a correct answer and a wrong one differently', () => {
    const { state: started, playerId } = startedRoom();
    const correctChoice = started.questions[0].answer;
    const wrongChoice = (correctChoice + 1) % started.questions[0].choices.length;

    const afterCorrect = answer(started, playerId, 0, correctChoice, IN_WINDOW);
    expect(afterCorrect.players[0].score).toBeGreaterThan(0);

    const afterWrong = answer(started, playerId, 0, wrongChoice, IN_WINDOW);
    expect(afterWrong.players[0].score).toBe(0);
  });

  it('records which answers were right, which is what earns a chest later', () => {
    const { state: started, playerId } = startedRoom();
    const q = started.questions[0];
    const right = answer(started, playerId, 0, q.answer, IN_WINDOW);
    expect(right.players[0].correct).toBe(1);
    expect(right.players[0].correctIndexes).toEqual([0]);

    const wrong = answer(started, playerId, 0, (q.answer + 1) % q.choices.length, IN_WINDOW);
    expect(wrong.players[0].correct).toBe(0);
    expect(wrong.players[0].correctIndexes).toEqual([]);
    expect(wrong.players[0].answeredIndexes).toEqual([0]);
  });

  it('credits elapsed time from the server clock, not from the client', () => {
    const { state: started, playerId } = startedRoom();
    const correctChoice = started.questions[0].answer;

    const fast = answer(started, playerId, 0, correctChoice, OPENS_AT + 200);
    const slow = answer(started, playerId, 0, correctChoice, OPENS_AT + 6000);

    expect(fast.players[0].totalMs).toBe(200);
    expect(slow.players[0].totalMs).toBe(6000);
    expect(fast.players[0].score).toBeGreaterThan(slow.players[0].score);
  });

  it('clamps a grace-period answer to the question budget', () => {
    const { state: started, playerId } = startedRoom();
    const graceAnswer = answer(
      started,
      playerId,
      0,
      started.questions[0].answer,
      OPENS_AT + PER_QUESTION_MS + 1000
    );
    expect(graceAnswer.players[0].totalMs).toBe(PER_QUESTION_MS);
  });

  it('rejects an answer submitted before the question opens', () => {
    const { state: started, playerId } = startedRoom();
    expect(answer(started, playerId, 0, started.questions[0].answer, OPENS_AT - 1)).toEqual(started);
  });

  it('rejects an answer submitted after the close+grace window', () => {
    const { state: started, playerId } = startedRoom();
    const past = OPENS_AT + PER_QUESTION_MS + GRACE_MS + 1;
    expect(answer(started, playerId, 0, started.questions[0].answer, past)).toEqual(started);
  });

  it('rejects a choice the question does not offer, and leaks nothing by doing it', () => {
    const { state: started, playerId } = startedRoom();
    const q = started.questions[0];
    for (const bad of [-1, q.choices.length, q.choices.length + 5, 1.5, NaN]) {
      const after = answer(started, playerId, 0, bad, IN_WINDOW);
      // Unchanged state is how RoomDO decides `accepted: false`, and a refused
      // answer is exactly what makes revealedChoice withhold the key.
      expect(after).toEqual(started);
      expect(after.players[0].answeredIndexes).toEqual([]);
      expect(revealedChoice(after, 0, after !== started)).toBe(CHOICE_WITHHELD);
    }

    // The attempt was not spent: a real choice still lands afterwards.
    const good = answer(started, playerId, 0, q.answer, IN_WINDOW);
    expect(good.players[0].answeredIndexes).toEqual([0]);
  });

  it('rejects an answer for a question whose slot has not arrived yet', () => {
    const { state: started, playerId } = startedRoom();
    // Question 1 opens one slot after question 0.
    expect(answer(started, playerId, 1, started.questions[1].answer, IN_WINDOW)).toEqual(started);

    const inSlot1 = answer(started, playerId, 1, started.questions[1].answer, OPENS_AT + SLOT_MS);
    expect(inSlot1.players[0].answered).toBe(1);
  });
});

describe('finishIfDone', () => {
  /** Alice right on everything, Bob wrong on everything. Returns the finished room. */
  function playOut(itemCount = 2) {
    const room = freshRoom(itemCount);
    const j1 = join(room, 'Alice', NOW);
    const j2 = join(j1.state, 'Bob', NOW);
    const started = start(j2.state, j1.playerId!, NOW);
    expect(started.phase).toBe('round');

    let state = started;
    let lastAt = NOW;
    started.questions.forEach((q, i) => {
      expect(q.choices.length).toBeGreaterThan(1);
      const at = NOW + 3000 + i * SLOT_MS + 500;
      state = answer(state, j1.playerId!, i, q.answer, at);
      state = answer(state, j2.playerId!, i, (q.answer + 1) % q.choices.length, at + 100);
      lastAt = at + 100;
    });
    return { state, lastAt, aliceId: j1.playerId!, bobId: j2.playerId!, started };
  }

  it('finishes once every player has answered every question, picking the higher score as winner', () => {
    const { state, lastAt, aliceId } = playOut(2);
    const done = finishIfDone(state, lastAt + 1);

    expect(done.phase).toBe('results');
    expect(done.history).toHaveLength(1);
    expect(done.history[0].winnerId).toBe(aliceId);
    expect(done.history[0].tie).toBe(false);
    expect(done.history[0].ranking.map((r) => r.playerId)).toEqual([
      aliceId,
      done.players.find((p) => p.id !== aliceId)!.id,
    ]);
  });

  it('banks the round score into the cumulative total and credits the win', () => {
    const { state, lastAt, aliceId } = playOut(2);
    const done = finishIfDone(state, lastAt + 1);
    const alice = done.players.find((p) => p.id === aliceId)!;
    const bob = done.players.find((p) => p.id !== aliceId)!;

    expect(alice.total).toBe(alice.score);
    expect(alice.total).toBeGreaterThan(0);
    expect(alice.wins).toBe(1);
    expect(bob.total).toBe(0);
    expect(bob.wins).toBe(0);
  });

  it('breaks a score tie by lower totalMs', () => {
    const room = freshRoom(2);
    const j1 = join(room, 'Alice', NOW);
    const j2 = join(j1.state, 'Bob', NOW);
    let state = start(j2.state, j1.playerId!, NOW);

    state.questions.forEach((q, i) => {
      const opensAt = NOW + 3000 + i * SLOT_MS;
      state = answer(state, j1.playerId!, i, q.answer, opensAt + 100);
      state = answer(state, j2.playerId!, i, q.answer, opensAt + 2000);
    });

    const done = finishIfDone(state, NOW + 3000 + 2 * SLOT_MS + 3000);
    expect(done.history[0].winnerId).toBe(j1.playerId);
    expect(done.history[0].tie).toBe(false);
  });

  it('reports a true tie (same score AND same totalMs) with no single winner', () => {
    const room = freshRoom(2);
    const j1 = join(room, 'Alice', NOW);
    const j2 = join(j1.state, 'Bob', NOW);
    let state = start(j2.state, j1.playerId!, NOW);

    state.questions.forEach((q, i) => {
      const at = NOW + 3000 + i * SLOT_MS + 400;
      state = answer(state, j1.playerId!, i, q.answer, at);
      state = answer(state, j2.playerId!, i, q.answer, at);
    });

    const done = finishIfDone(state, NOW + 3000 + 2 * SLOT_MS + 3000);
    expect(done.history[0].tie).toBe(true);
    expect(done.history[0].winnerId).toBeNull();
    expect(done.players.every((p) => p.wins === 0)).toBe(true);
  });

  it('finishes when the alarm fires at the end of the schedule, even with unanswered questions', () => {
    const { state, hostId } = lobbyOfTwo(3);
    const started = start(state, hostId, NOW);
    const endsAt = scheduleEndsAt(started)!;

    expect(finishIfDone(started, endsAt - 1).phase).toBe('round');
    const done = finishIfDone(started, endsAt);
    expect(done.phase).toBe('results');
    expect(done.history[0].ranking).toHaveLength(2);
  });

  // --- the inactivity floor (Codex round 1, SHOULD-FIX 1) -------------------
  //
  // The API allows perQuestionMs up to 60s, the same as the inactivity timeout,
  // so the two used to collide: a class thinking hard about one slow question
  // hit 60s of silence and had the round closed underneath them, throwing away
  // an answer that was still in time. A round may now never end while a window
  // a player could still act in is open.

  /** A two-player race on a 60s timer, which is the longest the API allows. */
  function slowRace(perQuestionMs = 60_000, itemCount = 20) {
    const set = makeSet(itemCount);
    const questions = buildQuestions(set, { directions: ['zh2en'], seed: 1 });
    const j1 = join(createRoom('ABCD', set, questions, perQuestionMs, NOW), 'Alice', NOW);
    const j2 = join(j1.state, 'Bob', NOW);
    return { started: start(j2.state, j1.playerId!, NOW), aliceId: j1.playerId! };
  }

  it('does not end a round at 60s of silence while the first answer is still in time', () => {
    const { started, aliceId } = slowRace();
    const round = started.round!;
    const inactiveAt = started.lastActivityAt + 60_000;

    // The old rule fired here. The first question does not shut until later.
    expect(inactiveAt).toBeLessThan(currentWindowClosesAt(round, inactiveAt));
    expect(finishIfDone(started, inactiveAt).phase).toBe('round');
    expect(finishIfDone(started, inactiveAt + 1000).phase).toBe('round');

    // And the answer the old rule would have discarded is still recorded.
    const late = answer(
      started,
      aliceId,
      0,
      started.questions[0].answer,
      round.startsAt + 60_000 - 1
    );
    expect(late.players.find((p) => p.id === aliceId)!.answered).toBe(1);
  });

  it('never puts the inactivity finish earlier than the current window closes', () => {
    const { started } = slowRace();
    const round = started.round!;
    const endsAt = scheduleEndsAt(started)!;

    // Sampled right across the schedule, including the boundaries of each slot,
    // where an off-by-one would show up.
    for (let t = round.startsAt - 5_000; t <= endsAt + 5_000; t += round.slotMs / 3) {
      const at = Math.round(t);
      expect(inactivityFinishAt(started, at)).toBeGreaterThanOrEqual(
        currentWindowClosesAt(round, at)
      );
    }
  });

  it('still ends an abandoned round, at the end of its schedule', () => {
    // The consequence of the floor, stated as a test: with nobody answering,
    // each new slot pushes the inactivity deadline forward, so the schedule end
    // is what finishes the round. It is bounded, and results still self-close.
    const { started } = slowRace(60_000, 3);
    const endsAt = scheduleEndsAt(started)!;
    expect(finishIfDone(started, endsAt - 1).phase).toBe('round');
    expect(finishIfDone(started, endsAt).phase).toBe('results');
  });

  it('is undefined outside a round, so nothing schedules an inactivity finish', () => {
    expect(inactivityFinishAt(freshRoom(), NOW)).toBeUndefined();
  });

  it('writes the result exactly once (later calls are a no-op)', () => {
    const { state, lastAt } = playOut(2);
    const done = finishIfDone(state, lastAt + 1);
    const again = finishIfDone(done, lastAt + 999_999);
    expect(again).toBe(done);
    expect(again.history).toHaveLength(1);
  });

  it('is a no-op outside a round', () => {
    const lobby = freshRoom();
    expect(finishIfDone(lobby, NOW + 999_999)).toBe(lobby);
  });
});

describe('buildResult', () => {
  it('returns an empty ranking and no winner for an empty room', () => {
    const result = buildResult([], 3, PER_QUESTION_MS);
    expect(result.ranking).toEqual([]);
    expect(result.winnerId).toBeNull();
    expect(result.tie).toBe(false);
  });

  it('orders by score first, then by lower ranking time', () => {
    const players: Player[] = [
      playerRow({ id: 'a', name: 'A', score: 100, answered: 3, totalMs: 9000 }),
      playerRow({ id: 'b', name: 'B', score: 300, answered: 3, totalMs: 9000 }),
      playerRow({ id: 'c', name: 'C', score: 300, answered: 3, totalMs: 1000 }),
    ];
    const result = buildResult(players, 3, PER_QUESTION_MS);
    expect(result.ranking.map((r) => r.playerId)).toEqual(['c', 'b', 'a']);
    expect(result.winnerId).toBe('c');
  });

  it('charges the full per-question budget for every question left unanswered', () => {
    const all = playerRow({ id: 'a', name: 'A', score: 300, answered: 4, totalMs: 8200 });
    const half = playerRow({ id: 'b', name: 'B', score: 300, answered: 2, totalMs: 8000 });

    expect(rankingMsFor(all, 4, PER_QUESTION_MS)).toBe(8200);
    expect(rankingMsFor(half, 4, PER_QUESTION_MS)).toBe(8000 + 2 * PER_QUESTION_MS);

    const result = buildResult([all, half], 4, PER_QUESTION_MS);
    expect(result.winnerId).toBe('a');
    expect(result.ranking[0].totalMs).toBe(8200);
  });

  it('still ties when both players played everything at the same pace', () => {
    const a = playerRow({ id: 'a', name: 'A', score: 200, answered: 2, totalMs: 4000 });
    const b = playerRow({ id: 'b', name: 'B', score: 200, answered: 2, totalMs: 4000 });
    const result = buildResult([a, b], 2, PER_QUESTION_MS);
    expect(result.tie).toBe(true);
    expect(result.winnerId).toBeNull();
  });
});

describe('nextPollMsFor', () => {
  it('polls slowly in the lobby, fast during a round, slowly on results, never when closed', () => {
    expect(nextPollMsFor('lobby')).toBe(2000);
    expect(nextPollMsFor('round')).toBe(1000);
    // The real change in v2: a device on the results screen must keep asking or
    // it never learns the teacher started the next game.
    expect(nextPollMsFor('results')).toBe(2000);
    expect(nextPollMsFor('closed')).toBe(0);
  });

  it('keeps the v1 cadence for a v1 room, where done is the end of the story', () => {
    expect(nextPollMsFor('results', 1)).toBe(0);
    expect(nextPollMsFor('round', 1)).toBe(1000);
  });
});

describe('publicState', () => {
  it('carries no answer on any question', () => {
    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);
    const wire = publicState(started);
    expect(wire.questions).toHaveLength(started.questions.length);
    for (const q of wire.questions) {
      expect(Object.prototype.hasOwnProperty.call(q, 'answer')).toBe(false);
    }
  });

  it('keeps everything a player legitimately needs', () => {
    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);
    const wire = publicState(started);
    expect(wire.code).toBe('ABCD');
    expect(wire.players).toHaveLength(2);
    expect(wire.questions[0].choices).toEqual(started.questions[0].choices);
    expect(wire.questions[0].prompt).toBe(started.questions[0].prompt);
  });

  it('leaves the server copy intact, because the reducer still needs the key', () => {
    const room = freshRoom();
    publicState(room);
    expect(room.questions[0].answer).toBeTypeOf('number');
  });

  it('emits the v1 wire shape for a model 1 room', () => {
    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);
    const wire = publicState(started);

    // A week-1 client reads these five off the top level and knows nothing
    // about `round`.
    expect(wire.phase).toBe('playing');
    expect(wire.startsAt).toBe(NOW + 3000);
    expect(wire.perQuestionMs).toBe(PER_QUESTION_MS);
    expect(wire.slotMs).toBe(NO_PROJECTOR_SLOT_MS);
    expect(wire.questionCount).toBe(started.questions.length);
  });

  it('gives a model 1 room its v1 result and winnerId once it finishes', () => {
    const room = freshRoom(2);
    const j1 = join(room, 'Alice', NOW);
    const j2 = join(j1.state, 'Bob', NOW);
    let state = start(j2.state, j1.playerId!, NOW);
    state.questions.forEach((q, i) => {
      state = answer(state, j1.playerId!, i, q.answer, NOW + 3000 + i * SLOT_MS + 100);
    });
    const done = finishIfDone(state, NOW + 3000 + 2 * SLOT_MS + 5000);
    const wire = publicState(done);

    expect(wire.phase).toBe('done');
    expect(wire.result).toBeDefined();
    expect(wire.result!.winnerId).toBe(j1.playerId);
    expect(wire.winnerId).toBe(j1.playerId!);
    expect(wire.result!.ranking).toHaveLength(2);
  });

  it('still gives a model 1 room its set items and question itemIds', () => {
    // Wire changes 1 and 2 took both of these off the v2 wire. A week-1 client
    // reads both, and it uploaded the set itself, so they stay for model 1.
    const { state, hostId } = lobbyOfTwo();
    const started = start(state, hostId, NOW);
    const wire = publicState(started);

    expect(wire.set.items).toEqual(started.set.items);
    expect(wire.set.count).toBe(started.set.items.length);
    for (const q of wire.questions) {
      expect(typeof q.itemId).toBe('string');
    }
    expect(wire.questions.map((q) => q.itemId)).toEqual(
      started.questions.map((q) => q.itemId)
    );
  });

  it('omits the v1 mirrors for a v2 room, which reads `round` instead', () => {
    const { state, hostId } = lobbyOfTwo();
    const started = { ...start(state, hostId, NOW), model: 2 as const };
    const wire = publicState(started);
    expect(wire.phase).toBe('round');
    expect(wire.startsAt).toBeUndefined();
    expect(wire.result).toBeUndefined();
    expect(wire.round!.startsAt).toBe(NOW + 3000);
  });
});

describe('revealedChoice', () => {
  it('reveals the right choice for an answer the server recorded', () => {
    const room = freshRoom();
    expect(revealedChoice(room, 0, true)).toBe(room.questions[0].answer);
  });

  it('withholds it when the answer was refused, so a probe learns nothing', () => {
    const room = freshRoom();
    expect(revealedChoice(room, 0, false)).toBe(CHOICE_WITHHELD);
    expect(revealedChoice(room, 999, true)).toBe(CHOICE_WITHHELD);
  });
});

