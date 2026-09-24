// The reveal route, end to end through RoomDO.fetch.
//
// Every other test in this repo exercises a pure function or a storage helper.
// This file drives the Durable Object's own HTTP shell, because the reveal
// route is the one place where deleting a single line
// ("if (!isRevealAuthorized(...))") publishes the answer key while every other
// test stays green (adversarial review 2026-09-08, MUST-FIX 3). Verified by
// doing exactly that: with the gate forced open, two of these seven go red.
//
// The stand-in below is the DO contract RoomDO actually uses and nothing more:
// a storage map with an alarm slot, and blockConcurrencyWhile. Real alarms,
// eviction and the input gate still need a Workers runtime and are still
// covered by the live wrangler checks.
//
// It lives in its own file, and in tsconfig.worker.json rather than
// tsconfig.json, because importing RoomDO pulls in the Cloudflare globals
// (DurableObjectState, Fetcher, Ai) that the DOM-flavoured client project does
// not and should not declare.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoomDO } from '../src/worker/room-do';
import { GRACE_MS, REVEAL_MS } from '../src/shared/room';
import type { Env } from '../src/worker/index';
import type { RoomEnvelope, VocabSet } from '../src/shared/types';

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

const REVEAL_PER_QUESTION_MS = 8000;

/** A teacher room, two children joined, one climb round running. */
async function runningClassroom() {
  const room = newRoomDo();
  const created = (await (
    await post(room, 'create', {
      code: 'WXYZ',
      set: classSet(4),
      perQuestionMs: REVEAL_PER_QUESTION_MS,
      teacher: true,
    })
  ).json()) as { hostKey?: string };
  const hostKey = created.hostKey!;

  const ana = (await (await post(room, 'join', { name: 'Ana' })).json()) as {
    playerId?: string;
    memberKey?: string;
  };
  const ben = (await (await post(room, 'join', { name: 'Ben' })).json()) as {
    playerId?: string;
    memberKey?: string;
  };

  const started = (await (
    await post(room, 'round', { hostKey, kind: 'climb' })
  ).json()) as RoomEnvelope;
  const round = started.state.round!;
  return {
    room,
    hostKey,
    anaId: ana.playerId!,
    anaKey: ana.memberKey!,
    benId: ben.playerId!,
    benKey: ben.memberKey!,
    round,
    questions: started.state.questions,
  };
}

/**
 * The right answer to `index`, obtained the only honest way a test can get it:
 * the polled state does not carry it (that is D3), so one child answers inside
 * the window and the server tells HER what it was.
 *
 * Ana answers alone here, which is the half-answered room: the reveal is still
 * on the clock and the round runs its full schedule. The all-answered room,
 * where the round wants to end the moment the last child taps, is the last test
 * in this file and it drives BOTH children (round-2 review, MUST-FIX 1).
 */
async function trueAnswer(
  ctx: Awaited<ReturnType<typeof runningClassroom>>,
  index: number
): Promise<number> {
  vi.setSystemTime(ctx.round.startsAt + index * ctx.round.slotMs + 100);
  const res = await post(ctx.room, 'answer', {
    playerId: ctx.anaId,
    memberKey: ctx.anaKey,
    index,
    choice: 0,
  });
  const body = (await res.json()) as { accepted: boolean; correctChoice: number };
  expect(body.accepted).toBe(true);
  expect(body.correctChoice).toBeGreaterThanOrEqual(0);
  return body.correctChoice;
}

describe('POST /reveal on the Durable Object', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('404s a room code nothing was ever created under', async () => {
    const room = newRoomDo();
    const res = await post(room, 'reveal', { hostKey: 'anything', index: 0 });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('answer');
  });

  it('403s a child of the room replaying her own playerId', async () => {
    const { room, anaId } = await runningClassroom();
    const res = await post(room, 'reveal', { playerId: anaId, index: 0 });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { answer?: number };
    expect(body.answer).toBeUndefined();
  });

  it('403s a host key that is not this room key, and says nothing about the answer', async () => {
    const { room } = await runningClassroom();
    const res = await post(room, 'reveal', { hostKey: 'not-the-key', index: 0 });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { answer?: number };
    expect(body.answer).toBeUndefined();
  });

  it('tells the host -1 while the question is still open', async () => {
    const { room, hostKey, round } = await runningClassroom();
    vi.setSystemTime(round.startsAt + 100);
    const res = await post(room, 'reveal', { hostKey, index: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ index: 0, answer: -1 });
  });

  it('tells the host the answer once the question and its grace have shut', async () => {
    const ctx = await runningClassroom();
    const expected = await trueAnswer(ctx, 0);
    vi.setSystemTime(ctx.round.startsAt + ctx.round.perQuestionMs + GRACE_MS);
    const res = await post(ctx.room, 'reveal', { hostKey: ctx.hostKey, index: 0 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { index: number; answer: number };
    expect(body).toEqual({ index: 0, answer: expected });
  });

  it('reaches the LAST question of the round, which is the whole of M1', async () => {
    const ctx = await runningClassroom();
    const last = ctx.questions.length - 1;
    const expected = await trueAnswer(ctx, last);
    const revealAt =
      ctx.round.startsAt + last * ctx.round.slotMs + ctx.round.perQuestionMs + GRACE_MS;
    // Still inside the round: one more reveal pause runs before the schedule
    // ends, which is exactly what the last word used to be denied.
    expect(revealAt).toBeLessThan(ctx.round.startsAt + ctx.questions.length * ctx.round.slotMs);
    vi.setSystemTime(revealAt);
    const res = await post(ctx.room, 'reveal', { hostKey: ctx.hostKey, index: last });
    expect(((await res.json()) as { answer: number }).answer).toBe(expected);
  });

  /**
   * The all-answered room, which is the small class and the e2e harness room.
   *
   * Both children answer every question, so `finishIfDone` wants to end the
   * round on the last tap, long before the last question's reveal instant. It
   * used to do exactly that, and the last word of the lesson was then revealable
   * at NO time: the room was in `results`, and `revealedAnswerFor` refuses
   * outside `round` (round-2 adversarial review, MUST-FIX 1).
   */
  it('still reveals the LAST answer when every child answered every question', async () => {
    const ctx = await runningClassroom();
    const last = ctx.questions.length - 1;

    let expected = -1;
    for (let index = 0; index <= last; index += 1) {
      vi.setSystemTime(ctx.round.startsAt + index * ctx.round.slotMs + 100);
      const hers = (await (
        await post(ctx.room, 'answer', {
          playerId: ctx.anaId,
          memberKey: ctx.anaKey,
          index,
          choice: 0,
        })
      ).json()) as { accepted: boolean; correctChoice: number };
      expect(hers.accepted).toBe(true);
      const his = (await (
        await post(ctx.room, 'answer', {
          playerId: ctx.benId,
          memberKey: ctx.benKey,
          index,
          choice: 1,
        })
      ).json()) as { accepted: boolean };
      expect(his.accepted).toBe(true);
      if (index === last) expected = hers.correctChoice;
    }

    // The instant the projector asks: the last question is shut on the clock,
    // and with everyone answered there is no grace left to wait out.
    const revealAt = ctx.round.startsAt + last * ctx.round.slotMs + ctx.round.perQuestionMs;
    vi.setSystemTime(revealAt);
    const shown = (await (
      await post(ctx.room, 'reveal', { hostKey: ctx.hostKey, index: last })
    ).json()) as { answer: number };
    expect(shown.answer).toBe(expected);

    // And it stays up for the whole reveal pause, not one tick of it.
    vi.setSystemTime(revealAt + REVEAL_MS - 1);
    await ctx.room.fetch(new Request('https://do/state'));
    const held = (await (
      await post(ctx.room, 'reveal', { hostKey: ctx.hostKey, index: last })
    ).json()) as { answer: number };
    expect(held.answer).toBe(expected);

    // Then, and only then, the room is allowed to be finished.
    vi.setSystemTime(revealAt + REVEAL_MS);
    const after = (await (await ctx.room.fetch(new Request('https://do/state'))).json()) as {
      state: { phase: string };
    };
    expect(after.state.phase).toBe('results');
  });

  it('refuses an index that is not a question, without a 500', async () => {
    const { room, hostKey, round } = await runningClassroom();
    vi.setSystemTime(round.startsAt + 10 * round.slotMs);
    for (const index of [-1, 999, 1.5, 'nope', undefined]) {
      const res = await post(room, 'reveal', { hostKey, index });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { answer: number }).answer).toBe(-1);
    }
  });
});

