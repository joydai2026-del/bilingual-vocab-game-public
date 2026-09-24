// Three rules a real class needed on 2026-09-08, one test file so the reason
// they exist stays together.
//
//   D1  two children called Ana are two rows a teacher cannot tell apart, so
//       the second join is refused by the SERVER (the client cannot be trusted
//       to hold the roster).
//   D2  "your teacher can let you in between games" has to be true at the
//       moment it is shown: the results screen IS between games.
//   D3  the projector may show the right answer once the question is shut, and
//       the answer key still never leaves the server before that.

import { describe, it, expect } from 'vitest';
import {
  CHOICE_WITHHELD,
  answer,
  GRACE_MS,
  close,
  createRoom,
  endNow,
  finishIfDone,
  join,
  nextDeadline,
  normalizeName,
  publicState,
  REVEAL_MS,
  revealedAnswerFor,
  revealPauseFor,
  scheduleEndsAt,
  slotMsFor,
  start,
  startRound,
  toLobby,
} from '../src/shared/room';
import { isHostAuthorized, isRevealAuthorized, roomActionAuthFor } from '../src/worker/pure';
import { buildQuestions } from '../src/shared/quiz';
import type { RoomState, VocabItem, VocabSet } from '../src/shared/types';

const NOW = 1_000_000;
const PER_QUESTION_MS = 8000;

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

function startClimb(state: RoomState, seed = 'seed-1', now = NOW): RoomState {
  return startRound(state, { kind: 'climb', seed, directions: ['zh2en'] }, now);
}

describe('D1 duplicate names', () => {
  it('refuses a second child with a name already on the board', () => {
    const { state } = classroom();
    const dup = join(state, 'Ana', NOW + 1);
    expect(dup.playerId).toBeNull();
    expect(dup.refusal).toBe('duplicate');
    expect(dup.state.players).toHaveLength(2);
    expect(dup.state.version).toBe(state.version);
  });

  it('compares names the way a teacher reads them: trimmed, folded, one space', () => {
    const { state } = classroom();
    for (const typed of ['ana', 'ANA', '  Ana  ', 'ana ', '\tAna\n']) {
      expect(join(state, typed, NOW + 1).playerId).toBeNull();
    }
    const ok = join(state, 'Ana B', NOW + 1);
    expect(ok.playerId).not.toBeNull();
    expect(ok.state.players.map((p) => p.name)).toEqual(['Ana', 'Ben', 'Ana B']);
  });

  it('collapses inner runs of whitespace but does not delete them', () => {
    const { state } = classroom();
    const two = join(state, 'Ana  Lee', NOW + 1);
    expect(two.playerId).not.toBeNull();
    expect(join(two.state, 'ana lee', NOW + 2).playerId).toBeNull();
    // "A na" is not "Ana": deleting the space would merge two real names.
    expect(join(two.state, 'A na', NOW + 2).playerId).not.toBeNull();
  });

  it('folds the shapes a phone keyboard produces', () => {
    expect(normalizeName('  Ana  ')).toBe('ana');
    expect(normalizeName('Ana Lee')).toBe('ana lee');
    expect(normalizeName('ＡＮＡ')).toBe('ana');
    expect(normalizeName('小 明')).toBe('小 明');
  });

  it('names the reason for every refusal, so the screen can say the right thing', () => {
    const { state } = classroom();
    expect(join(state, 'Cara', NOW + 1).refusal).toBeUndefined();
    const started = startClimb(state);
    expect(join(started, 'Cara', NOW + 1).refusal).toBe('phase');
    expect(join(close(started, NOW + 1), 'Cara', NOW + 2).refusal).toBe('closed');
  });

  it('still fills a room to its cap and then says full', () => {
    let state = createRoom('WXYZ', makeSet(3), [], PER_QUESTION_MS, NOW, {
      teacher: true,
      maxPlayers: 2,
    });
    state = join(state, 'One', NOW).state;
    state = join(state, 'Two', NOW).state;
    const third = join(state, 'Three', NOW);
    expect(third.playerId).toBeNull();
    expect(third.refusal).toBe('full');
  });
});

describe('D2 late join between games', () => {
  it('lets a child in at the results screen, which is between games', () => {
    const { state } = classroom();
    const ended = endNow(startClimb(state), NOW + 1000);
    expect(ended.phase).toBe('results');

    const late = join(ended, 'Late', NOW + 2000);
    expect(late.playerId).not.toBeNull();
    expect(late.state.players).toHaveLength(3);
    expect(late.state.phase).toBe('results');
    // The round that just finished is not rewritten by somebody who missed it.
    expect(late.state.history[0].ranking).toHaveLength(2);
  });

  it('carries the latecomer into the next round with a clean score', () => {
    const { state } = classroom();
    const ended = endNow(startClimb(state), NOW + 1000);
    const late = join(ended, 'Late', NOW + 2000);
    const next = startClimb(toLobby(late.state, NOW + 3000), 'seed-2', NOW + 3000);
    expect(next.phase).toBe('round');
    expect(next.players.map((p) => p.name)).toContain('Late');
    expect(next.players.every((p) => p.score === 0)).toBe(true);
  });

  it('still freezes the roster while a round is actually running', () => {
    const { state } = classroom();
    const started = startClimb(state);
    expect(join(started, 'Late', started.round!.startsAt + 10).playerId).toBeNull();
  });

  it('refuses a finished lesson', () => {
    const { state } = classroom();
    const closed = close(endNow(startClimb(state), NOW + 1000), NOW + 2000);
    expect(join(closed, 'Late', NOW + 3000).playerId).toBeNull();
  });

  it('leaves a legacy race alone: its results screen is the end of the story', () => {
    const set = makeSet(3);
    const room = createRoom('ABCD', set, buildQuestions(set, { seed: 1 }), PER_QUESTION_MS, NOW);
    const a = join(room, 'Alice', NOW);
    const b = join(a.state, 'Bob', NOW);
    const ended = endNow(start(b.state, a.playerId!, NOW), NOW + 1000);
    expect(ended.phase).toBe('results');
    expect(join(ended, 'Late', NOW + 2000).playerId).toBeNull();
  });
});

describe('D3 the projector reveals a closed answer', () => {
  it('withholds the answer while the question is still open', () => {
    const started = startClimb(classroom().state);
    const round = started.round!;
    expect(revealedAnswerFor(started, 0, round.startsAt - 1)).toBe(CHOICE_WITHHELD);
    expect(revealedAnswerFor(started, 0, round.startsAt + 10)).toBe(CHOICE_WITHHELD);
    expect(revealedAnswerFor(started, 0, round.startsAt + round.perQuestionMs - 1)).toBe(
      CHOICE_WITHHELD
    );
  });

  it('withholds it through the grace, when a late answer still counts', () => {
    const started = startClimb(classroom().state);
    const round = started.round!;
    const graceEnd = round.startsAt + round.perQuestionMs + GRACE_MS;
    expect(revealedAnswerFor(started, 0, graceEnd - 1)).toBe(CHOICE_WITHHELD);
    expect(revealedAnswerFor(started, 0, graceEnd)).toBe(started.questions[0].answer);
  });

  it('reveals at the close when every child has already answered', () => {
    const { state, anaId, benId } = classroom();
    const started = startClimb(state);
    const round = started.round!;
    const q = started.questions[0];
    let answered = answer(started, anaId, 0, q.answer, round.startsAt + 100);
    answered = answer(answered, benId, 0, (q.answer + 1) % q.choices.length, round.startsAt + 200);
    // Nobody's answer can change now, so the grace is not protecting anything.
    const closesAt = round.startsAt + round.perQuestionMs;
    expect(revealedAnswerFor(answered, 0, closesAt - 1)).toBe(CHOICE_WITHHELD);
    expect(revealedAnswerFor(answered, 0, closesAt)).toBe(q.answer);
    // One child still out means the grace still protects the question.
    const half = answer(started, anaId, 0, q.answer, round.startsAt + 100);
    expect(revealedAnswerFor(half, 0, closesAt)).toBe(CHOICE_WITHHELD);
  });

  it('never reveals a question that has not opened yet', () => {
    const started = startClimb(classroom().state);
    const round = started.round!;
    const afterFirst = round.startsAt + round.perQuestionMs + GRACE_MS;
    expect(revealedAnswerFor(started, 1, afterFirst)).toBe(CHOICE_WITHHELD);
  });

  it('refuses an index that is not a question', () => {
    const started = startClimb(classroom().state);
    const late = started.round!.startsAt + 10 * started.round!.slotMs;
    expect(revealedAnswerFor(started, -1, late)).toBe(CHOICE_WITHHELD);
    expect(revealedAnswerFor(started, 999, late)).toBe(CHOICE_WITHHELD);
    expect(revealedAnswerFor(started, 1.5, late)).toBe(CHOICE_WITHHELD);
  });

  it('says nothing outside a round', () => {
    const { state } = classroom();
    expect(revealedAnswerFor(state, 0, NOW)).toBe(CHOICE_WITHHELD);
    const ended = endNow(startClimb(state), NOW + 1000);
    expect(revealedAnswerFor(ended, 0, NOW + 10_000_000)).toBe(CHOICE_WITHHELD);
  });

  it('keeps the answer key off the wire, closed question or not', () => {
    const started = startClimb(classroom().state);
    const wire = JSON.stringify(publicState(started));
    for (const q of started.questions) {
      expect(wire).not.toContain(`"answer":${q.answer}`);
    }
    expect(wire).not.toContain('revealed');
  });
});

// --- round 2: what the adversarial review found the code did not do ----------

describe('M1 the last question of a round is revealed too', () => {
  it('climb: there is a moment, still inside the round, when the last answer is legal', () => {
    const { state } = classroom(6);
    const started = startClimb(state);
    const round = started.round!;
    const last = started.questions.length - 1;
    const revealAt = round.startsAt + last * round.slotMs + round.perQuestionMs + GRACE_MS;
    const endsAt = scheduleEndsAt(started)!;
    // The release instant has to fall strictly INSIDE the schedule, or the room
    // is already on the results screen by the time the answer is legal and the
    // class never sees the last word (adversarial probe A1).
    expect(revealAt).toBeLessThan(endsAt);
    expect(revealedAnswerFor(started, last, revealAt)).toBe(started.questions[last].answer);
    expect(revealedAnswerFor(started, last, endsAt - 1)).toBe(started.questions[last].answer);
  });

  it('race: the same, and the host tick is still on the last question when it lands', () => {
    const { state } = classroom(6);
    const started = startRound(state, { kind: 'race', seed: 's', directions: ['zh2en'] }, NOW);
    const round = started.round!;
    const last = started.questions.length - 1;
    const elapsedAtReveal = last * round.slotMs + round.perQuestionMs + GRACE_MS;
    expect(Math.floor(elapsedAtReveal / round.slotMs)).toBe(last);
    expect(revealedAnswerFor(started, last, round.startsAt + elapsedAtReveal)).toBe(
      started.questions[last].answer
    );
  });
});

describe('M2 the full reveal has time on screen in a real class', () => {
  it('a class where one child never answers still gets a pause on the shut question', () => {
    // Three joined, two answer. The everyone-answered shortcut cannot fire, so
    // this is the path a room of 30 actually takes.
    const room = createRoom('WXYZ', makeSet(6), [], PER_QUESTION_MS, NOW, { teacher: true });
    const a = join(room, 'Ana', NOW);
    const b = join(a.state, 'Ben', NOW);
    const c = join(b.state, 'Cai', NOW);
    const started = startClimb(c.state);
    const round = started.round!;
    const q = started.questions[0];
    let answered = answer(started, a.playerId!, 0, q.answer, round.startsAt + 100);
    answered = answer(answered, b.playerId!, 0, q.answer, round.startsAt + 200);
    expect(c.playerId).not.toBeNull();

    const revealAt = round.startsAt + round.perQuestionMs + GRACE_MS;
    const nextOpensAt = round.startsAt + round.slotMs;
    expect(revealedAnswerFor(answered, 0, revealAt)).toBe(q.answer);
    // The whole point: the answer is legal BEFORE the next question opens, and
    // long enough that a teacher can read it out (REVEAL_MS).
    expect(nextOpensAt - revealAt).toBeGreaterThanOrEqual(REVEAL_MS);
    expect(REVEAL_MS).toBeGreaterThanOrEqual(2500);
    // Still question 0 on the host's clock for the whole of that pause.
    expect(Math.floor((revealAt - round.startsAt) / round.slotMs)).toBe(0);
    expect(Math.floor((nextOpensAt - 1 - round.startsAt) / round.slotMs)).toBe(0);
  });

  it('dash keeps the slot it already had: its pick window is the pause', () => {
    expect(slotMsFor('dash', PER_QUESTION_MS, 3000)).toBe(PER_QUESTION_MS + 3000 + GRACE_MS);
    expect(slotMsFor('climb', PER_QUESTION_MS)).toBe(PER_QUESTION_MS + GRACE_MS + REVEAL_MS);
    expect(slotMsFor('race', PER_QUESTION_MS)).toBe(PER_QUESTION_MS + GRACE_MS + REVEAL_MS);
  });
});

describe('S1 only the private host key may ask for an answer', () => {
  it('the public hostId of a legacy room does not open the reveal route', () => {
    const set = makeSet(3);
    const room = createRoom('ABCD', set, buildQuestions(set, { seed: 1 }), PER_QUESTION_MS, NOW);
    const a = join(room, 'Alice', NOW);
    const pub = publicState(a.state);
    // The legacy host id is on the wire, so the OTHER player can read it off
    // their own poll. The generic host gate accepts it; the reveal gate must
    // not (adversarial probe A3).
    expect(pub.hostId).toBe(a.playerId);
    expect(isHostAuthorized({ playerId: pub.hostId, hostId: a.state.hostId })).toBe(true);
    expect(
      isRevealAuthorized({ playerId: pub.hostId, storedHostKey: 'the-real-key' })
    ).toBe(false);
  });

  it('accepts the stored host key and nothing else', () => {
    expect(isRevealAuthorized({ hostKey: 'k', storedHostKey: 'k' })).toBe(true);
    expect(isRevealAuthorized({ hostKey: 'k', storedHostKey: 'other' })).toBe(false);
    expect(isRevealAuthorized({ hostKey: '', storedHostKey: '' })).toBe(false);
    expect(isRevealAuthorized({ storedHostKey: 'k' })).toBe(false);
    expect(isRevealAuthorized({ hostKey: 'k' })).toBe(false);
    expect(isRevealAuthorized({ hostKey: 7, storedHostKey: 'k' })).toBe(false);
  });

  /**
   * The route gate, one level up from the key check.
   *
   * `revealRefused` on the host screen (the 403 that stops the projector asking
   * forever) cannot be proved from the server side at all: it is a client flag
   * set from the shape of the error. What CAN be proved here is the thing that
   * produces that 403, which is that `reveal` is a host action and nothing
   * softer (round-2 review, SHOULD-FIX 4). Delete the `reveal` clause and this
   * goes red instead of the route quietly becoming a 404.
   */
  it('reveal is a host action, so a student key and the public hostId both bounce', () => {
    expect(roomActionAuthFor('reveal')).toBe('host');
    expect(roomActionAuthFor('answer')).toBe('player');
    // A player credential is checked against the player gate, never the host
    // one, so a student key cannot reach the answer key by any route.
    expect(roomActionAuthFor('reveal')).not.toBe('player');
    expect(roomActionAuthFor('reveal')).not.toBe('none');
    // And the host gate the route then applies is the reveal-specific one,
    // which the legacy public hostId does not satisfy.
    expect(isRevealAuthorized({ playerId: 'the-public-host-id', storedHostKey: 'k' })).toBe(false);
    expect(isRevealAuthorized({ hostKey: 'a-student-key', storedHostKey: 'k' })).toBe(false);
  });
});

describe('the reveal pause belongs to the room that has a projector', () => {
  /**
   * SHOULD-FIX 2. `answer` used to accept through `closesAt + GRACE_MS` while
   * `revealedAnswerFor` released AT that same instant, so on one millisecond a
   * child could score off a word already on the wall. The window is half-open
   * now: the answer stops one millisecond before the reveal starts.
   */
  it('an answer and a reveal are never both legal at the same instant', () => {
    const { state, anaId, benId } = classroom(4);
    const started = startClimb(state);
    const round = started.round!;
    const q = started.questions[0];
    // Ana answers; Ben does not, so the reveal is on the clock, not on the
    // everyone-answered shortcut.
    const answered = answer(started, anaId, 0, q.answer, round.startsAt + 100);
    const revealAt = round.startsAt + round.perQuestionMs + GRACE_MS;

    // One millisecond before: the answer counts, the projector gets nothing.
    expect(answer(answered, benId, 0, q.answer, revealAt - 1)).not.toBe(answered);
    expect(revealedAnswerFor(answered, 0, revealAt - 1)).toBe(CHOICE_WITHHELD);
    // On the instant itself: the projector has it, so the answer is refused.
    expect(answer(answered, benId, 0, q.answer, revealAt)).toBe(answered);
    expect(revealedAnswerFor(answered, 0, revealAt)).toBe(q.answer);
  });

  /**
   * SHOULD-FIX 3. The pause exists so a class can read the word off the wall.
   * A child alone on an iPad has already read it on her own screen, and was
   * paying 2.5s a question for a wall that is not there.
   */
  it('a solo room keeps its brisk slot; a teacher room keeps the pause', () => {
    const soloLobby = join(
      createRoom('SOLO', makeSet(6), [], PER_QUESTION_MS, NOW, { teacher: true }),
      'Ana',
      NOW
    );
    const solo = startRound(
      soloLobby.state,
      { kind: 'climb', seed: 'seed-1', directions: ['zh2en'], projector: false },
      NOW
    ).round!;
    expect(revealPauseFor(solo)).toBe(0);
    expect(solo.slotMs).toBe(PER_QUESTION_MS + GRACE_MS);

    const teacher = startClimb(classroom(6).state).round!;
    expect(revealPauseFor(teacher)).toBe(REVEAL_MS);
    expect(teacher.slotMs).toBe(PER_QUESTION_MS + GRACE_MS + REVEAL_MS);

    // The whole cost of the branch, in the number the review measured: twelve
    // questions of pause a solo game cannot use.
    expect(12 * (teacher.slotMs - solo.slotMs)).toBe(12 * REVEAL_MS);
  });

  /**
   * MUST-FIX 1, at the reducer. The DO route test in reveal-route.test.ts is
   * the one that proves it end to end; this is the same claim one layer down,
   * where the numbers are visible.
   */
  it('an all-answered round stays in round until the last word has had its pause', () => {
    const { state, anaId, benId } = classroom(3);
    const started = startClimb(state);
    const round = started.round!;
    const last = round.questionCount - 1;

    let room = started;
    for (let index = 0; index <= last; index += 1) {
      const at = round.startsAt + index * round.slotMs + 100;
      room = answer(room, anaId, index, started.questions[index].answer, at);
      room = answer(room, benId, index, started.questions[index].answer, at + 10);
    }
    const lastAnswerAt = round.startsAt + last * round.slotMs + 110;

    // Booked, not taken.
    const held = finishIfDone(room, lastAnswerAt);
    expect(held.phase).toBe('round');
    const closesAt = round.startsAt + last * round.slotMs + round.perQuestionMs;
    expect(held.pendingFinishAt).toBe(closesAt + REVEAL_MS);
    // Everyone answered, so the last word goes up without waiting out the grace,
    // and it is still up one millisecond before the room is allowed to finish.
    expect(revealedAnswerFor(held, last, closesAt)).toBe(started.questions[last].answer);
    expect(finishIfDone(held, closesAt + REVEAL_MS - 1).phase).toBe('round');
    expect(finishIfDone(held, closesAt + REVEAL_MS).phase).toBe('results');
    // And the DO is told to wake up for it.
    expect(nextDeadline(held)).toBe(closesAt + REVEAL_MS);
  });

  it('a room with no projector still finishes the instant everyone is done', () => {
    const lobby = join(
      createRoom('SOLO', makeSet(3), [], PER_QUESTION_MS, NOW, { teacher: true }),
      'Ana',
      NOW
    );
    const started = startRound(
      lobby.state,
      { kind: 'climb', seed: 'seed-1', directions: ['zh2en'], projector: false },
      NOW
    );
    const round = started.round!;
    let room = started;
    for (let index = 0; index < round.questionCount; index += 1) {
      room = answer(
        room,
        lobby.playerId!,
        index,
        started.questions[index].answer,
        round.startsAt + index * round.slotMs + 100
      );
    }
    const lastAnswerAt = round.startsAt + (round.questionCount - 1) * round.slotMs + 100;
    const done = finishIfDone(room, lastAnswerAt);
    expect(done.phase).toBe('results');
    expect(done.pendingFinishAt).toBeUndefined();
  });
});

