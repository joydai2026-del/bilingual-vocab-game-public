// Sky Tower as a class round, end to end through RoomDO.fetch.
//
// Same stand-in Durable Object as tests/reveal-route.test.ts, for the same
// reason: the two things this game promises a class are both HTTP-shaped, and
// neither can be proved by a pure-function test.
//
//   1. The class wins TOGETHER. When the sum of everyone's correct answers
//      reaches the target before the clock, the round flips to `results` with
//      `won: true`; when the clock beats them it flips with `won: false`.
//   2. A child sees her OWN block count and nobody else's. That is a promise
//      about the bytes on the wire, not about what the page happens to draw,
//      so it is asserted against the poll payload itself.
//
// It lives in tsconfig.worker.json (not tsconfig.json) because importing RoomDO
// pulls in the Cloudflare globals the DOM project does not declare.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoomDO } from '../src/worker/room-do';
import { TOWER_CLOCK_MS } from '../src/shared/round';
import { roomTargetBlocks } from '../src/shared/sky-tower';
import type { Env } from '../src/worker/index';
import type { PublicRoomState, RoomEnvelope, TowerConfig, VocabSet } from '../src/shared/types';

class FakeDurableObjectState {
  public readonly storage: FakeDoStorage = new FakeDoStorage();
  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

class FakeDoStorage {
  private readonly map = new Map<string, string>();
  public alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async put<T>(keyOrEntries: string | Record<string, unknown>, value?: T): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.map.set(keyOrEntries, JSON.stringify(value));
      return;
    }
    for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, JSON.stringify(v));
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
    this.alarm = null;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }
}

function newRoomDo(): RoomDO {
  const ctx = new FakeDurableObjectState() as unknown as DurableObjectState;
  return new RoomDO(ctx, {} as Env);
}

function post(room: RoomDO, action: string, body: unknown): Promise<Response> {
  return room.fetch(
    new Request(`https://do/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

/** A plain poll, with whatever identity headers the caller wants to present. */
function get(room: RoomDO, headers: Record<string, string> = {}): Promise<Response> {
  return room.fetch(new Request('https://do/state', { method: 'GET', headers }));
}

function classSet(n: number): VocabSet {
  return {
    v: 1,
    title: 'class set',
    level: 'big',
    items: Array.from({ length: n }, (_, i) => ({
      id: `id${i}`,
      zh: `中${i}`,
      pinyin: `zhong${i}`,
      en: `word${i}`,
    })),
  };
}

const PER_QUESTION_MS = 8000;

interface Student {
  name: string;
  id: string;
  key: string;
}

/** A teacher room with three children joined and one tower round running. */
async function towerClassroom() {
  const room = newRoomDo();
  const created = (await (
    await post(room, 'create', {
      code: 'TOWR',
      set: classSet(12),
      perQuestionMs: PER_QUESTION_MS,
      teacher: true,
    })
  ).json()) as { hostKey?: string };
  const hostKey = created.hostKey!;

  const students: Student[] = [];
  for (const name of ['Ana', 'Ben', 'Cara']) {
    const joined = (await (await post(room, 'join', { name })).json()) as {
      playerId?: string;
      memberKey?: string;
    };
    students.push({ name, id: joined.playerId!, key: joined.memberKey! });
  }

  const started = (await (
    await post(room, 'round', { hostKey, kind: 'tower' })
  ).json()) as RoomEnvelope;

  return { room, hostKey, students, started, round: started.state.round! };
}

interface AnswerReply {
  accepted: boolean;
  correct: boolean;
  correctChoice: number;
  state: PublicRoomState;
}

async function sendAnswer(
  room: RoomDO,
  who: Student,
  index: number,
  choice: number
): Promise<AnswerReply> {
  const res = await post(room, 'answer', {
    playerId: who.id,
    memberKey: who.key,
    index,
    choice,
  });
  return (await res.json()) as AnswerReply;
}

describe('a Sky Tower round through the Durable Object', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a tower round with a cooperative target and a three minute clock', async () => {
    const { round, students } = await towerClassroom();
    expect(round.config.kind).toBe('tower');
    const config = round.config as TowerConfig;
    // Three children, three blocks each, and never fewer than six.
    expect(config.target).toBe(3 * students.length);
    expect(config.clockMs).toBe(TOWER_CLOCK_MS);
  });

  it('flips to results with won true when the class total reaches the target', async () => {
    const ctx = await towerClassroom();
    const target = (ctx.round.config as TowerConfig).target;
    const [ana, ...rest] = ctx.students;

    let classTotal = 0;
    let index = 0;
    while (classTotal < target && index < ctx.round.questionCount) {
      vi.setSystemTime(ctx.round.startsAt + index * ctx.round.slotMs + 100);
      // Ana probes with choice 0; the server tells HER what was right, and the
      // other two answer with it. The answer key never sits in the state.
      const probe = await sendAnswer(ctx.room, ana, index, 0);
      expect(probe.accepted).toBe(true);
      if (probe.correct) classTotal += 1;
      for (const who of rest) {
        const reply = await sendAnswer(ctx.room, who, index, probe.correctChoice);
        expect(reply.accepted).toBe(true);
        expect(reply.correct).toBe(true);
        classTotal += 1;
      }
      index += 1;
    }
    expect(classTotal).toBeGreaterThanOrEqual(target);

    // The win is BOOKED, not taken: the projector keeps the last answer up for
    // its full reveal pause first. Settle past that and read the result.
    vi.setSystemTime(ctx.round.startsAt + (index + 1) * ctx.round.slotMs);
    const after = (await (await get(ctx.room, { 'x-host-key': ctx.hostKey })).json()) as RoomEnvelope;
    expect(after.state.phase).toBe('results');
    const result = after.state.history[after.state.history.length - 1];
    expect(result.kind).toBe('tower');
    expect(result.won).toBe(true);
    // Cooperative: nobody is the winner of a tower round.
    expect(result.winnerId).toBeNull();
    // The teacher still gets the per-child counts.
    const counted = result.ranking.reduce((sum, r) => sum + (r.correct ?? 0), 0);
    expect(counted).toBe(classTotal);
  });

  it('flips to results with won false when the clock beats the class', async () => {
    const ctx = await towerClassroom();
    const [ana] = ctx.students;
    vi.setSystemTime(ctx.round.startsAt + 100);
    await sendAnswer(ctx.room, ana, 0, 0);

    vi.setSystemTime(ctx.round.startsAt + TOWER_CLOCK_MS + 1);
    const after = (await (await get(ctx.room, { 'x-host-key': ctx.hostKey })).json()) as RoomEnvelope;
    expect(after.state.phase).toBe('results');
    const result = after.state.history[after.state.history.length - 1];
    expect(result.kind).toBe('tower');
    expect(result.won).toBe(false);
  });

  it('never puts another child’s block count in a child’s poll payload', async () => {
    const ctx = await towerClassroom();
    const [ana, ben, cara] = ctx.students;

    // Ben and Cara each get one right; Ana gets nothing.
    vi.setSystemTime(ctx.round.startsAt + 100);
    const probe = await sendAnswer(ctx.room, ben, 0, 0);
    const rightChoice = probe.correctChoice;
    if (!probe.correct) {
      // Ben guessed wrong; give him the next question instead so he has one.
      vi.setSystemTime(ctx.round.startsAt + ctx.round.slotMs + 100);
      const second = await sendAnswer(ctx.room, ben, 1, 0);
      if (!second.correct) await sendAnswer(ctx.room, ben, 1, second.correctChoice);
    }
    vi.setSystemTime(ctx.round.startsAt + 200);
    await sendAnswer(ctx.room, cara, 0, rightChoice);

    vi.setSystemTime(ctx.round.startsAt + 300);
    const mine = (await (
      await get(ctx.room, { 'x-player-id': ana.id, 'x-member-key': ana.key })
    ).json()) as RoomEnvelope;
    expect(mine.state.phase).toBe('round');

    const others = mine.state.players.filter((p) => p.id !== ana.id);
    expect(others.length).toBe(2);
    for (const other of others) {
      expect(other.correct).toBe(0);
      expect(other.score).toBe(0);
      expect(other.answered).toBe(0);
      expect(other.correctIndexes).toEqual([]);
      expect(other.answeredIndexes).toEqual([]);
    }
    // The shared height still arrives, as ONE number that names nobody.
    expect(mine.state.towerTotal).toBeGreaterThanOrEqual(1);

    // And the teacher, who is not a child, still sees every count.
    const board = (await (
      await get(ctx.room, { 'x-host-key': ctx.hostKey })
    ).json()) as RoomEnvelope;
    const caraOnBoard = board.state.players.find((p) => p.id === cara.id)!;
    expect(caraOnBoard.correct).toBe(1);
  });

  it('gives a child her OWN count, unredacted', async () => {
    const ctx = await towerClassroom();
    const [ana] = ctx.students;
    vi.setSystemTime(ctx.round.startsAt + 100);
    const probe = await sendAnswer(ctx.room, ana, 0, 0);
    const expected = probe.correct ? 1 : 0;

    vi.setSystemTime(ctx.round.startsAt + 200);
    const mine = (await (
      await get(ctx.room, { 'x-player-id': ana.id, 'x-member-key': ana.key })
    ).json()) as RoomEnvelope;
    const me = mine.state.players.find((p) => p.id === ana.id)!;
    expect(me.correct).toBe(expected);
    expect(me.answered).toBe(1);
  });

  it('redacts for a child who presents a member key that is not hers', async () => {
    const ctx = await towerClassroom();
    const [ana, ben] = ctx.students;
    vi.setSystemTime(ctx.round.startsAt + 100);
    const probe = await sendAnswer(ctx.room, ben, 0, 0);
    if (!probe.correct) await sendAnswer(ctx.room, ben, 1, 0);

    vi.setSystemTime(ctx.round.startsAt + 200);
    // Ana claims to be Ben with her own key. A public player id is not a
    // credential, so this reads as an unidentified caller: everybody at zero.
    const spoof = (await (
      await get(ctx.room, { 'x-player-id': ben.id, 'x-member-key': ana.key })
    ).json()) as RoomEnvelope;
    for (const p of spoof.state.players) expect(p.correct).toBe(0);
  });

  it('leaves a climb round’s payload exactly as it was', async () => {
    const room = newRoomDo();
    const created = (await (
      await post(room, 'create', {
        code: 'CLMB',
        set: classSet(12),
        perQuestionMs: PER_QUESTION_MS,
        teacher: true,
      })
    ).json()) as { hostKey?: string };
    const hostKey = created.hostKey!;
    const joined: Student[] = [];
    for (const name of ['Ana', 'Ben']) {
      const j = (await (await post(room, 'join', { name })).json()) as {
        playerId?: string;
        memberKey?: string;
      };
      joined.push({ name, id: j.playerId!, key: j.memberKey! });
    }
    const started = (await (
      await post(room, 'round', { hostKey, kind: 'climb' })
    ).json()) as RoomEnvelope;
    const round = started.state.round!;

    vi.setSystemTime(round.startsAt + 100);
    const probe = await sendAnswer(room, joined[1], 0, 0);
    if (!probe.correct) {
      vi.setSystemTime(round.startsAt + 150);
      await sendAnswer(room, joined[1], 0, probe.correctChoice);
    }

    vi.setSystemTime(round.startsAt + 200);
    const seen = (await (
      await get(room, { 'x-player-id': joined[0].id, 'x-member-key': joined[0].key })
    ).json()) as RoomEnvelope;
    const ben = seen.state.players.find((p) => p.id === joined[1].id)!;
    // Cloud Climb is a race: everybody's tower is public and stays public.
    expect(ben.answered).toBe(1);
    expect(seen.state.towerTotal).toBeUndefined();
  });
});

/**
 * A teacher room with `names` joined and one tower round running at the given
 * pacing. Same shape as `towerClassroom`, but the clock-versus-pacing tests
 * need to choose both.
 */
async function towerRoomWith(perQuestionMs: number, names: string[]) {
  const room = newRoomDo();
  const created = (await (
    await post(room, 'create', {
      code: 'TWRB',
      set: classSet(12),
      perQuestionMs,
      teacher: true,
    })
  ).json()) as { hostKey?: string };
  const hostKey = created.hostKey!;
  const students: Student[] = [];
  for (const name of names) {
    const j = (await (await post(room, 'join', { name })).json()) as {
      playerId?: string;
      memberKey?: string;
    };
    students.push({ name, id: j.playerId!, key: j.memberKey! });
  }
  const started = (await (
    await post(room, 'round', { hostKey, kind: 'tower' })
  ).json()) as RoomEnvelope;
  return { room, hostKey, students, round: started.state.round! };
}

describe('who a POST reply is written for (panel round 1, M1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the answering child her OWN progress in the reply to her own answer', async () => {
    const ctx = await towerClassroom();
    const [ana, ben] = ctx.students;
    vi.setSystemTime(ctx.round.startsAt + 100);
    const reply = await sendAnswer(ctx.room, ana, 0, 0);
    expect(reply.accepted).toBe(true);

    const mineInReply = reply.state.players.find((p) => p.id === ana.id)!;
    expect(mineInReply.answered).toBe(1);
    expect(mineInReply.answeredIndexes).toEqual([0]);
    expect(mineInReply.correct).toBe(reply.correct ? 1 : 0);

    // The other child is still zeroed in that same reply: the fix threads the
    // caller's identity through, it does not lift the redaction.
    const other = reply.state.players.find((p) => p.id === ben.id)!;
    expect(other.answered).toBe(0);
    expect(other.correct).toBe(0);
    expect(other.answeredIndexes).toEqual([]);

    // And the reply's own-player row is the SAME row the authenticated poll
    // gives her. That is the whole bug: it used to be {0,0,0,[]} here and
    // {1,...,[0]} there, so the counter flashed to zero on every tap.
    vi.setSystemTime(ctx.round.startsAt + 150);
    const poll = (await (
      await get(ctx.room, { 'x-player-id': ana.id, 'x-member-key': ana.key })
    ).json()) as RoomEnvelope;
    const mineInPoll = poll.state.players.find((p) => p.id === ana.id)!;
    expect(mineInReply.answered).toBe(mineInPoll.answered);
    expect(mineInReply.correct).toBe(mineInPoll.correct);
    expect(mineInReply.score).toBe(mineInPoll.score);
    expect(mineInReply.answeredIndexes).toEqual(mineInPoll.answeredIndexes);
  });

  it('leaves a climb round\u2019s answer reply byte for byte what it was', async () => {
    const room = newRoomDo();
    const created = (await (
      await post(room, 'create', {
        code: 'CLM2',
        set: classSet(12),
        perQuestionMs: PER_QUESTION_MS,
        teacher: true,
      })
    ).json()) as { hostKey?: string };
    const hostKey = created.hostKey!;
    const joined: Student[] = [];
    for (const name of ['Ana', 'Ben']) {
      const j = (await (await post(room, 'join', { name })).json()) as {
        playerId?: string;
        memberKey?: string;
      };
      joined.push({ name, id: j.playerId!, key: j.memberKey! });
    }
    const started = (await (
      await post(room, 'round', { hostKey, kind: 'climb' })
    ).json()) as RoomEnvelope;
    const round = started.state.round!;

    vi.setSystemTime(round.startsAt + 100);
    const reply = await sendAnswer(room, joined[0], 0, 0);
    // Nothing mutates between these two reads, so for a climb round, where no
    // viewer logic applies, the identified reply and the anonymous poll must
    // serialise to exactly the same bytes.
    const anon = (await (await get(room)).json()) as RoomEnvelope;
    expect(JSON.stringify(reply.state)).toBe(JSON.stringify(anon.state));
  });
});

describe('a child\u2019s results screen after a tower round (panel round 1, M2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries no other child\u2019s total, score or name once the round ends', async () => {
    const ctx = await towerClassroom();
    const [ana, ben] = ctx.students;
    vi.setSystemTime(ctx.round.startsAt + 100);
    const probe = await sendAnswer(ctx.room, ana, 0, 0);
    vi.setSystemTime(ctx.round.startsAt + 150);
    const scored = await sendAnswer(ctx.room, ben, 0, probe.correctChoice);
    expect(scored.correct).toBe(true);

    vi.setSystemTime(ctx.round.startsAt + 200);
    await post(ctx.room, 'end', { hostKey: ctx.hostKey });

    const mine = (await (
      await get(ctx.room, { 'x-player-id': ana.id, 'x-member-key': ana.key })
    ).json()) as RoomEnvelope;
    expect(mine.state.phase).toBe('results');
    for (const other of mine.state.players.filter((p) => p.id !== ana.id)) {
      // `total` is the leak the panel measured: it is the round score with a
      // multiplier on it, and it survived into every later round.
      expect(other.total).toBe(0);
      expect(other.score).toBe(0);
      expect(other.correct).toBe(0);
    }
    const myRow = mine.state.history[mine.state.history.length - 1];
    expect(myRow.kind).toBe('tower');
    expect(myRow.ranking).toEqual([]);
    const asText = JSON.stringify(myRow);
    expect(asText).not.toContain('Ben');

    // The teacher keeps the whole picture.
    const board = (await (
      await get(ctx.room, { 'x-host-key': ctx.hostKey })
    ).json()) as RoomEnvelope;
    const benOnBoard = board.state.players.find((p) => p.id === ben.id)!;
    expect(benOnBoard.total).toBeGreaterThan(0);
    const hostRow = board.state.history[board.state.history.length - 1];
    expect(hostRow.ranking.length).toBe(3);
    expect(JSON.stringify(hostRow)).toContain('Ben');
  });
});

describe('the cloud line and the schedule both respect the clock (panel round 1, S2/S3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps the target at what the clock can actually deliver', async () => {
    // 60s a question: slot 64s, so the 3 minute clock opens 2 questions. Three
    // children can bank 6 blocks at 100%; 70% of that is 4, and the floor of
    // six wins. The roster target of 9 was unreachable.
    const slow = await towerRoomWith(60_000, ['Ana', 'Ben', 'Cara']);
    expect((slow.round.config as TowerConfig).target).toBe(6);

    // 15s a question: slot 19s, 9 questions, 3 children, 70% -> 18. The roster
    // target of 9 is comfortably reachable, so it is left alone.
    const brisk = await towerRoomWith(15_000, ['Ana', 'Ben', 'Cara']);
    expect((brisk.round.config as TowerConfig).target).toBe(9);
  });

  it('never sets a target the class cannot possibly reach, even at 100% (panel round 2)', async () => {
    // One child, 60s a question: slot 64s, so the clock opens only 2
    // questions. The old formula applied the floor of 6 AFTER the clock cap
    // (`max(6, min(roster, reachable))`), so a lone child was handed a
    // 6-block line with a hard ceiling of 2 blocks: unreachable at any
    // accuracy. The fixed target must never exceed `openings x players`.
    const lonely = await towerRoomWith(60_000, ['Ana']);
    const lonelyTarget = (lonely.round.config as TowerConfig).target;
    expect(lonelyTarget).toBeGreaterThan(0);
    expect(lonelyTarget).toBeLessThanOrEqual(2);

    // Two children, 30s a question: slot 34s, 5 opens, hard max 10. Reachable
    // at 100% (target must not exceed the hard max).
    const pair = await towerRoomWith(30_000, ['Ana', 'Ben']);
    const pairTarget = (pair.round.config as TowerConfig).target;
    expect(pairTarget).toBeGreaterThan(0);
    expect(pairTarget).toBeLessThanOrEqual(2 * 5);

    // Three children, 15s a question: unchanged from today (roster target of
    // 9 was already comfortably reachable).
    const unchangedSmall = await towerRoomWith(15_000, ['Ana', 'Ben', 'Cara']);
    expect((unchangedSmall.round.config as TowerConfig).target).toBe(9);

    // Forty children, 8s a question: unchanged from today (roster target of
    // 60 was already comfortably reachable).
    const bigClass = Array.from({ length: 40 }, (_, i) => `Kid${i}`);
    const unchangedBig = await towerRoomWith(8_000, bigClass);
    expect((unchangedBig.round.config as TowerConfig).target).toBe(60);
  });

  it('never schedules a question the clock cannot open', async () => {
    for (const perQuestionMs of [60_000, 30_000, 15_000, 12_000, 8_000]) {
      const ctx = await towerRoomWith(perQuestionMs, ['Ana', 'Ben', 'Cara']);
      const round = ctx.round;
      const scheduleEnd = round.startsAt + round.questionCount * round.slotMs;
      const clockEnd = round.startsAt + (round.config as TowerConfig).clockMs;
      expect(scheduleEnd).toBeLessThanOrEqual(clockEnd);
      expect(round.questionCount).toBeGreaterThan(0);
    }
  });
});

describe('the level dial above twenty children (panel round 1, S5)', () => {
  it('still moves the cloud line in a big class', () => {
    // Thirty children: 3 x 30 = 90 clips to the 60 ceiling, and the dial used to
    // be applied afterwards, so easy and normal both read 60.
    expect(roomTargetBlocks('easy', 30)).toBe(45);
    expect(roomTargetBlocks('normal', 30)).toBe(60);
    expect(roomTargetBlocks('easy', 30)).toBeLessThan(roomTargetBlocks('normal', 30));
    // Small classes are untouched.
    expect(roomTargetBlocks('normal', 3)).toBe(9);
    expect(roomTargetBlocks('easy', 3)).toBe(7);
    expect(roomTargetBlocks('normal', 1)).toBe(6);
  });
});

