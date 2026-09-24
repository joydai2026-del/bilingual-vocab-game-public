// Deploying the v2 room model over live v1 rooms.
//
// A week-1 room is 2h TTL and a lesson is under an hour, so the honest answer is
// "deploy after the last class". This file is the belt to that braces: a race
// that is running when the deploy lands must finish, not 404.

import { describe, it, expect } from 'vitest';
import {
  KEY_META,
  KEY_QUESTIONS,
  KEY_SET,
  isV1Meta,
  loadRoom,
  saveNewRoom,
  saveRoundStart,
  upgradeV1Meta,
  type RoomStorage,
  type V1RoomMeta,
} from '../src/worker/persist';
import {
  answer,
  createRoom,
  finishIfDone,
  join,
  publicState,
  start,
  startRound,
  toLobby,
} from '../src/shared/room';
import { buildQuestions } from '../src/shared/quiz';
import type { QuizQuestion, VocabItem, VocabSet } from '../src/shared/types';

const NOW = 3_000_000;
const PER_QUESTION_MS = 8000;
const SLOT_MS = PER_QUESTION_MS + 1500;

function makeSet(n: number): VocabSet {
  const items: VocabItem[] = Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    zh: `中${i}`,
    pinyin: `zhong${i}`,
    en: `word${i}`,
  }));
  return { v: 1, title: 'v1 set', level: 'big', items };
}

/** An in-memory stand-in for DurableObjectStorage. */
class FakeStorage implements RoomStorage {
  private map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.map.set(keyOrEntries, value);
      return;
    }
    for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, v);
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
  }

  /** How many times put() has been called, which is what saveRoundStart is about. */
  writes = 0;
}

/** Exactly the meta shape week 1 wrote. */
function v1Meta(over: Partial<V1RoomMeta> = {}): V1RoomMeta {
  return {
    code: 'ABCD',
    phase: 'lobby',
    hostId: 'p1',
    perQuestionMs: PER_QUESTION_MS,
    questionCount: 3,
    slotMs: SLOT_MS,
    players: [
      { id: 'p1', name: 'Alice', score: 0, answered: 0, totalMs: 0, answeredIndexes: [] },
      { id: 'p2', name: 'Bob', score: 0, answered: 0, totalMs: 0, answeredIndexes: [] },
    ],
    createdAt: NOW,
    lastActivityAt: NOW,
    version: 4,
    ...over,
  };
}

describe('isV1Meta', () => {
  it('recognises a v1 meta by the absence of a model field, and only that', () => {
    expect(isV1Meta(v1Meta())).toBe(true);
    expect(isV1Meta({ ...v1Meta(), model: 1 })).toBe(false);
    expect(isV1Meta({ ...v1Meta(), model: 2 })).toBe(false);
    expect(isV1Meta(undefined)).toBe(false);
  });
});

describe('upgradeV1Meta', () => {
  it('migrates a v1 lobby with no round and keeps its uploaded questions usable', () => {
    const meta = upgradeV1Meta(v1Meta({ phase: 'lobby' }));
    expect(meta.model).toBe(1);
    expect(meta.phase).toBe('lobby');
    expect(meta.round).toBeUndefined();
    expect(meta.teacherRoom).toBe(false);
    expect(meta.hostId).toBe('p1');
    expect(meta.history).toEqual([]);
    expect(meta.defaultPerQuestionMs).toBe(PER_QUESTION_MS);
    expect(meta.players.every((p) => p.total === 0 && p.wins === 0)).toBe(true);
  });

  it('migrates a v1 mid-race into a live round on the same schedule', () => {
    const meta = upgradeV1Meta(
      v1Meta({
        phase: 'playing',
        startsAt: NOW + 3000,
        players: [
          { id: 'p1', name: 'Alice', score: 190, answered: 1, totalMs: 500, answeredIndexes: [0] },
          { id: 'p2', name: 'Bob', score: 0, answered: 1, totalMs: 700, answeredIndexes: [0] },
        ],
      })
    );

    expect(meta.phase).toBe('round');
    expect(meta.round).toEqual({
      n: 1,
      config: { kind: 'race', questionsPerRound: 3 },
      seed: 'v1:ABCD',
      startsAt: NOW + 3000,
      perQuestionMs: PER_QUESTION_MS,
      slotMs: SLOT_MS,
      questionCount: 3,
      directions: ['zh2en', 'en2zh'],
      endedAt: undefined,
    });
    // Mid-race, the score has NOT been banked yet: endRound will do that, and
    // seeding `total` from `score` here would count it twice.
    expect(meta.players[0].score).toBe(190);
    expect(meta.players[0].total).toBe(0);
    expect(meta.players[0].answeredIndexes).toEqual([0]);
  });

  it('migrates a finished v1 room into results with its result row and totals', () => {
    const meta = upgradeV1Meta(
      v1Meta({
        phase: 'done',
        startsAt: NOW + 3000,
        lastActivityAt: NOW + 40_000,
        winnerId: 'p1',
        players: [
          { id: 'p1', name: 'Alice', score: 560, answered: 3, totalMs: 1500, answeredIndexes: [0, 1, 2] },
          { id: 'p2', name: 'Bob', score: 190, answered: 3, totalMs: 4000, answeredIndexes: [0, 1, 2] },
        ],
        result: {
          winnerId: 'p1',
          tie: false,
          ranking: [
            { playerId: 'p1', name: 'Alice', score: 560, totalMs: 1500 },
            { playerId: 'p2', name: 'Bob', score: 190, totalMs: 4000 },
          ],
        },
      })
    );

    expect(meta.phase).toBe('results');
    expect(meta.history).toHaveLength(1);
    expect(meta.history[0]).toMatchObject({ n: 1, kind: 'race', winnerId: 'p1', tie: false });
    expect(meta.round!.endedAt).toBe(NOW + 40_000);
    // A finished round HAS been banked, so the totals carry.
    expect(meta.players[0].total).toBe(560);
    expect(meta.players[0].wins).toBe(1);
    expect(meta.players[1].total).toBe(190);
    expect(meta.players[1].wins).toBe(0);
  });

  it('loads a v1 room straight off storage, upgraded, and still speaks v1 on the wire', async () => {
    const storage = new FakeStorage();
    const set = makeSet(3);
    const questions: QuizQuestion[] = buildQuestions(set, { directions: ['zh2en'], seed: 9 });
    await storage.put({
      [KEY_META]: v1Meta({ phase: 'playing', startsAt: NOW + 3000, questionCount: questions.length }),
      [KEY_SET]: set,
      [KEY_QUESTIONS]: questions,
    });

    const room = await loadRoom(storage);
    expect(room).not.toBeNull();
    expect(room!.model).toBe(1);
    expect(room!.phase).toBe('round');

    // The week-1 tab that created this room reads these off the top level.
    const wire = publicState(room!);
    expect(wire.phase).toBe('playing');
    expect(wire.startsAt).toBe(NOW + 3000);
    expect(wire.perQuestionMs).toBe(PER_QUESTION_MS);
    expect(wire.slotMs).toBe(SLOT_MS);
    expect(wire.questionCount).toBe(questions.length);

    // And the race it was in the middle of still scores.
    const played = answer(room!, 'p1', 0, questions[0].answer, NOW + 3000 + 200);
    expect(played.players[0].answered).toBe(1);
    expect(played.players[0].score).toBeGreaterThan(0);
  });

  it('lets a migrated v1 lobby still run its /start alias', async () => {
    const storage = new FakeStorage();
    const set = makeSet(3);
    const questions = buildQuestions(set, { directions: ['zh2en'], seed: 11 });
    await storage.put({
      [KEY_META]: v1Meta({ phase: 'lobby', questionCount: questions.length }),
      [KEY_SET]: set,
      [KEY_QUESTIONS]: questions,
    });

    const room = await loadRoom(storage);
    const started = start(room!, 'p1', NOW + 1000);
    expect(started.phase).toBe('round');
    expect(started.questions).toEqual(questions);
    expect(started.model).toBe(1);
    expect(publicState(started).phase).toBe('playing');
  });
});

describe('saveRoundStart', () => {
  it('writes meta and questions together, so an eviction cannot split them', async () => {
    const storage = new FakeStorage();

    // Round 1: a teacher room with two students.
    let room = createRoom('WXYZ', makeSet(4), [], PER_QUESTION_MS, NOW, { teacher: true });
    await saveNewRoom(storage, room);
    const a = join(room, 'Ana', NOW);
    const b = join(a.state, 'Ben', NOW);
    room = startRound(b.state, { kind: 'race', seed: 'r1', directions: ['zh2en'] }, NOW);
    await saveRoundStart(storage, room);
    const round1Questions = room.questions;

    room = finishIfDone(room, room.round!.startsAt + 999_999);
    await saveRoundStart(storage, room);
    room = toLobby(room, NOW + 1);

    // Round 2 gets a different question list. This is the one write that must be
    // atomic: meta says "round 2", questions must say round 2 as well.
    room = startRound(room, { kind: 'climb', seed: 'r2', directions: ['zh2en'] }, NOW + 2);
    expect(room.questions).not.toEqual(round1Questions);
    await saveRoundStart(storage, room);

    // The DO is evicted right here; a fresh instance reloads from storage only.
    const revived = await loadRoom(storage);
    expect(revived!.round!.n).toBe(2);
    expect(revived!.round!.config.kind).toBe('climb');
    expect(revived!.questions).toEqual(room.questions);
    expect(revived!.questions).not.toEqual(round1Questions);

    // And the reloaded round scores against the RIGHT key.
    const played = answer(
      revived!,
      a.playerId!,
      0,
      revived!.questions[0].answer,
      revived!.round!.startsAt + 100
    );
    expect(played.players[0].correct).toBe(1);
  });
});

