// How a room is written to and read back from Durable Object storage.
//
// Kept out of room-do.ts (and free of any Cloudflare types) so the exact code
// the DO runs can be tested with a plain in-memory fake, no Miniflare needed.
//
// Storage layout:
//   meta      everything except the set and the current round's questions
//   set       the vocab set, written once at creation
//   questions the CURRENT round's questions, rewritten at each round start
//   hostKey   the teacher's host key, in its OWN slot so it can never be part
//             of RoomState and therefore can never leak through publicState
//   members   playerId -> memberKey, the secret each player proves themselves
//             with. Same reasoning as hostKey: its own slot, never part of
//             RoomState, so publicState has no path to it
//   deleteAt  the 2h TTL
//
// Why the split: `set` never changes, so it is written once. A per-answer
// mutation rewrites `meta` only, which keeps the hot write small. A round start
// rewrites `meta` and `questions` TOGETHER in one call (saveRoundStart), because
// two separate puts leave a window where an evicted DO reloads round 2's meta
// against round 1's questions.
//
// The split is NOT what bounds the stored size. The router does that, before a
// room exists: it caps the request body and the serialized {set, questions}
// payload at the policy limit (256 KB by default).

import type {
  Direction,
  Player,
  QuizQuestion,
  RankingEntry,
  RoomState,
  Round,
  RoundResult,
  VocabSet,
} from '../shared/types';
import { MAX_PLAYERS, MAX_PLAYERS_TEACHER } from '../shared/room';

export const KEY_META = 'meta';
export const KEY_SET = 'set';
export const KEY_QUESTIONS = 'questions';
export const KEY_DELETE_AT = 'deleteAt';
export const KEY_HOST_KEY = 'hostKey';
export const KEY_MEMBERS = 'members';

export type RoomMeta = Omit<RoomState, 'set' | 'questions'>;

/** The slice of DurableObjectStorage this module needs. */
export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(key: string, value: T): Promise<void>;
  deleteAll(): Promise<void>;
}

export function splitRoom(room: RoomState): {
  meta: RoomMeta;
  set: VocabSet;
  questions: QuizQuestion[];
} {
  const { set, questions, ...meta } = room;
  return { meta, set, questions };
}

/**
 * Rebuilds a room from its stored parts, filling in fields added after it was
 * written.
 *
 * `maxPlayers` and `askedKeys` both arrived after week 2 shipped, and a room
 * stored without them is a room a live class may be sitting in. Backfilled here
 * rather than at every read site, so the reducer never has to ask whether a
 * field is really there. A room lives 2h, so this path stops mattering two hours
 * after a deploy; it is a few lines to be right for those two hours.
 */
export function mergeRoom(meta: RoomMeta, set: VocabSet, questions: QuizQuestion[]): RoomState {
  const stored = meta as Partial<RoomMeta> & RoomMeta;
  return {
    ...meta,
    maxPlayers:
      typeof stored.maxPlayers === 'number' && stored.maxPlayers > 0
        ? stored.maxPlayers
        : meta.teacherRoom
          ? MAX_PLAYERS_TEACHER
          : MAX_PLAYERS,
    askedKeys: Array.isArray(stored.askedKeys) ? stored.askedKeys : [],
    set,
    questions,
  };
}

/** First write of a room: meta + the set + the questions (empty in a teacher room). */
export async function saveNewRoom(storage: RoomStorage, room: RoomState): Promise<void> {
  const { meta, set, questions } = splitRoom(room);
  await storage.put({
    [KEY_META]: meta,
    [KEY_SET]: set,
    [KEY_QUESTIONS]: questions,
  });
}

/** Every ordinary mutation (join, answer, pick, end, close): meta only. */
export async function saveRoomMeta(storage: RoomStorage, room: RoomState): Promise<void> {
  await storage.put(KEY_META, splitRoom(room).meta);
}

/**
 * A round start: meta AND questions, in ONE storage call.
 *
 * The pairing is the point (amendment 7). Written separately, an eviction
 * between the two puts leaves `meta` describing round 2 while `questions` still
 * holds round 1's list, and the round then scores answers against the wrong key.
 */
export async function saveRoundStart(storage: RoomStorage, room: RoomState): Promise<void> {
  const { meta, questions } = splitRoom(room);
  await storage.put({
    [KEY_META]: meta,
    [KEY_QUESTIONS]: questions,
  });
}

// --- v1 -> v2 migration ------------------------------------------------------

/** A v1 player, as week-1 wrote it to storage. */
interface V1Player {
  id: string;
  name: string;
  score: number;
  answered: number;
  totalMs: number;
  answeredIndexes: number[];
}

/** A v1 meta, as week-1 wrote it to storage. Recognised by having no `model`. */
export interface V1RoomMeta {
  code: string;
  phase: 'lobby' | 'playing' | 'done';
  hostId: string;
  startsAt?: number;
  perQuestionMs: number;
  questionCount: number;
  slotMs: number;
  players: V1Player[];
  winnerId?: string;
  createdAt: number;
  lastActivityAt: number;
  version: number;
  result?: { winnerId: string | null; tie: boolean; ranking: RankingEntry[] };
}

/** True when this stored meta predates the room-model version field. */
export function isV1Meta(meta: unknown): meta is V1RoomMeta {
  return !!meta && typeof meta === 'object' && (meta as { model?: unknown }).model === undefined;
}

const V1_DIRECTIONS: Direction[] = ['zh2en', 'en2zh'];

/**
 * Upgrades a week-1 room in place, so a race that is running when the deploy
 * lands finishes instead of 404ing.
 *
 * The room stays `model: 1`, which is what keeps its wire shape v1 for the tab
 * that created it (amendment 6). It becomes a v2 room only if somebody starts a
 * v2 round in it, which a week-1 client has no button for.
 *
 * `total` is the one place this departs from the plan's sketch. The plan said
 * `total = score`; that is right for a room that already finished (its round has
 * been banked), and wrong for one still mid-race, where endRound will bank the
 * score again and double it. So a finished room carries its score into `total`
 * and a running one starts at zero.
 */
export function upgradeV1Meta(meta: V1RoomMeta): RoomMeta {
  const finished = meta.phase === 'done';
  const phase = meta.phase === 'playing' ? 'round' : finished ? 'results' : 'lobby';

  // A v1 lobby never had a round, so it migrates to `round: undefined` and keeps
  // its uploaded questions for the `/start` alias to race on.
  let round: Round | undefined;
  if (meta.startsAt !== undefined) {
    round = {
      n: 1,
      config: { kind: 'race', questionsPerRound: meta.questionCount },
      // Opaque and unused: a migrated round already has its questions and race
      // has no chests. Never numeric and never 0 (amendment 5).
      seed: `v1:${meta.code}`,
      startsAt: meta.startsAt,
      perQuestionMs: meta.perQuestionMs,
      slotMs: meta.slotMs,
      questionCount: meta.questionCount,
      directions: V1_DIRECTIONS,
      endedAt: finished ? meta.lastActivityAt : undefined,
    };
  }

  const history: RoundResult[] = meta.result
    ? [
        {
          n: 1,
          kind: 'race',
          winnerId: meta.result.winnerId,
          tie: meta.result.tie,
          ranking: meta.result.ranking,
        },
      ]
    : [];

  const players: Player[] = meta.players.map((p) => ({
    id: p.id,
    name: p.name,
    joinedAt: meta.createdAt,
    total: finished ? p.score : 0,
    wins: finished && meta.result?.winnerId === p.id ? 1 : 0,
    score: p.score,
    answered: p.answered,
    correct: 0,
    totalMs: p.totalMs,
    answeredIndexes: [...p.answeredIndexes],
    // A v1 room never recorded which answers were right, so nobody in it has
    // earned a chest. Harmless: v1 rooms only ever run race rounds.
    correctIndexes: [],
    step: 0,
    pickedIndexes: [],
  }));

  return {
    model: 1,
    code: meta.code,
    phase,
    teacherRoom: false,
    hostId: meta.hostId,
    players,
    // A v1 room is "Race a friend": head to head, week-1 cap, and it races the
    // list it was created with, so it never draws from the round cursor.
    maxPlayers: MAX_PLAYERS,
    round,
    history,
    askedKeys: [],
    defaultPerQuestionMs: meta.perQuestionMs,
    createdAt: meta.createdAt,
    lastActivityAt: meta.lastActivityAt,
    version: meta.version,
  };
}

/**
 * Rebuilds a room from storage, or null when this DO holds no room.
 *
 * A v1 meta is upgraded on read. The upgraded shape is written back on the next
 * mutation, so a room nobody touches costs nothing.
 */
export async function loadRoom(storage: RoomStorage): Promise<RoomState | null> {
  const [rawMeta, set, questions] = await Promise.all([
    storage.get<RoomMeta | V1RoomMeta>(KEY_META),
    storage.get<VocabSet>(KEY_SET),
    storage.get<QuizQuestion[]>(KEY_QUESTIONS),
  ]);
  if (!rawMeta || !set || !questions) return null;
  const meta = isV1Meta(rawMeta) ? upgradeV1Meta(rawMeta) : (rawMeta as RoomMeta);
  return mergeRoom(meta, set, questions);
}

// --- host key ----------------------------------------------------------------

/**
 * The teacher's host key lives in its own storage slot and is never part of
 * RoomState, so there is no path by which publicState could put it on the wire.
 */
export async function saveHostKey(storage: RoomStorage, hostKey: string): Promise<void> {
  await storage.put(KEY_HOST_KEY, hostKey);
}

export async function loadHostKey(storage: RoomStorage): Promise<string | undefined> {
  return storage.get<string>(KEY_HOST_KEY);
}

// --- member keys -------------------------------------------------------------

/** playerId -> the secret that device proves itself with. */
export type Members = Record<string, string>;

export async function loadMembers(storage: RoomStorage): Promise<Members> {
  return (await storage.get<Members>(KEY_MEMBERS)) ?? {};
}

/**
 * A join: meta AND the members map, in ONE storage call.
 *
 * Paired for the same reason saveRoundStart pairs meta and questions. Written
 * separately, an eviction between the two puts leaves a player on the public
 * roster whose key was never stored, and that player can then never answer
 * anything: they hold a key the room has no record of.
 */
export async function saveJoin(
  storage: RoomStorage,
  room: RoomState,
  members: Members
): Promise<void> {
  await storage.put({
    [KEY_META]: splitRoom(room).meta,
    [KEY_MEMBERS]: members,
  });
}

