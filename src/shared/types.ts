// Shared data model.
//
// Room model v2 (docs/plans/2026-09-08-week2-games-and-rooms.md §1.9, as amended
// by "Amendments after Codex round 1"): a room no longer IS one race, it HOSTS a
// sequence of rounds. This file is the contract both halves of the build compile
// against; changing a shape here means changing the plan.
//
// =============================================================================
// WIRE CHANGES (Codex code review round 1, MUST-FIX 1 and 2)
// =============================================================================
// Every change below applies to a `model: 2` room ONLY. A `model: 1` room keeps
// the week-1 wire shape, because a tab still holding week-1 JS has to finish its
// race across the deploy (amendment 6). Everything a v1 room needs is still
// there; the v2 room is the one that lost fields.
//
// 1. `state.set` is no longer the full VocabSet. It is now `PublicVocabSet`:
//    `{ v, title, level, count }`. The item list is gone from the wire.
//    WHY: `questions[].itemId` plus `set.items` WAS the answer key. Any player
//    could look up the item a question points at and read the right choice
//    straight out of devtools, which made stripping `answer` decorative.
//    v1 mirror: a model 1 room additionally carries `set.items`, unchanged.
//
// 2. `questions[]` entries are now `PublicQuizQuestion`: `{ index, dir, prompt,
//    promptPinyin, choices }`. `itemId` is gone (it was half of the leak above),
//    and `promptPinyin` is new, because the client used to derive the prompt's
//    pinyin from `set.items` and no longer can. It is '' for an en2zh question,
//    whose prompt is English.
//    v1 mirror: a model 1 room additionally carries `questions[].itemId`.
//
// 3. `POST /join` now returns `memberKey` (a crypto.randomUUID) alongside
//    `playerId`, and `POST /answer` and `POST /pick` now require BOTH
//    `{ playerId, memberKey }`. A mismatch is refused with 403 and a
//    plain-language message.
//    WHY: `players[]` is public, so a player id was a name badge being used as a
//    password. Any student could answer as another student or burn their
//    Treasure Dash chest. The key never appears in any state response: it lives
//    in its own Durable Object storage slot (`members`, keyed by playerId), like
//    the teacher's `hostKey`. The client stores it next to `playerId` in
//    localStorage.
//    v1 exemption: a model 1 room still accepts `playerId` alone, because a
//    week-1 client has no member key and never will. A model 2 room never does,
//    including for a player who joined a v2 room before this deploy: that player
//    has no stored key, so their device has to rejoin. Rooms live 2h, so the
//    exposure window is one deploy.
//
// -----------------------------------------------------------------------------
// Claude code review round 1 (MUST-FIX 3 and 5, and the payload should-fix)
// -----------------------------------------------------------------------------
//
// 4. `RoundConfig` (every kind) gains `questionsPerRound`: how many questions
//    this round actually asks. `POST /round` accepts an optional
//    `questionsPerRound` between 6 and 30; without one it is 12.
//    WHY: a round used every question `buildQuestions` produced, which is up to
//    two per set item. A 30-word class list was a 60-question, 13-minute round
//    with no way to stop it, and a 200-word set was 110 minutes.
//    Consecutive rounds draw from a per-room cursor (`RoomState.askedKeys`,
//    which is NOT on the wire) so round 2 asks questions round 1 did not, until
//    the set is exhausted and the cycle restarts.
//    v1 mirror: a model 1 room races the list its creator uploaded, whole, so
//    neither the cap nor the cursor applies to it.
//
// 5. `POST /api/rooms/:code/end` is new: a host action that ends the round
//    running right now, with the scores as they stand, and moves the room to
//    `results`. Same credential as `/round`, `/lobby` and `/close` (a hostKey,
//    or the legacy player-host's playerId).
//    WHY: `/close` was the only way out of a round and it is terminal. A
//    teacher who started the wrong game had to destroy the room and make the
//    class retype a code. `/end` is non-destructive: the history row is
//    written, the roster survives, and "pick another game" still works.
//
// 6. `PublicRoomState.maxPlayers` is on the wire (it is a plain field of
//    `RoomState`), so a client can say "this room is full" for the right
//    number. A teacher room holds `ROOM_MAX_PLAYERS_TEACHER` (40 by default,
//    a `vars` entry in wrangler.jsonc); a legacy "Race a friend" room holds 8.
//
// 7. `questions` is sent only while `phase === 'round'` in a model 2 room. In
//    `lobby`, `results` and `closed` it is an empty array. Nothing renders a
//    question outside a round, and repeating the list in every poll of every
//    device was the largest avoidable part of the payload.
//    v1 mirror: a model 1 room always carries its questions, because a week-1
//    client reads them on its `done` screen.
// =============================================================================

// --- Data model (verbatim from the week-1 plan) ---
export type Level = 'kids' | 'big';
export interface VocabItem { id: string; zh: string; pinyin: string; en: string }
export interface VocabSet { v: 1; title: string; level: Level; items: VocabItem[] }
/** Games the set page can launch. `bingo` was retired in week 2. */
export type GameKind = 'memory' | 'race' | 'climb' | 'dash';
export type Direction = 'zh2en' | 'en2zh';
export interface QuizQuestion { index: number; dir: Direction; itemId: string; prompt: string; choices: string[]; answer: number }

// --- Room model version ------------------------------------------------------

/**
 * The wire contract version. A client whose `state.model` does not match this
 * constant is running stale JS after a deploy and must reload rather than guess.
 */
export const ROOM_MODEL = 2;

/**
 * 1 = a room created before this deploy, or a legacy "Race a friend" room that
 * has never started a v2 round. Those keep emitting the v1 wire shape so a tab
 * holding week-1 JS finishes its race (amendment 6).
 */
export type RoomModel = 1 | 2;

// --- Phases ------------------------------------------------------------------

export type RoundKind = 'race' | 'climb' | 'dash' | 'tower';

/** The v2 phases the reducer and storage speak. */
export type RoomPhase = 'lobby' | 'round' | 'results' | 'closed';

/** The v1 phases a week-1 client understands. Emitted only for `model: 1` rooms. */
export type LegacyRoomPhase = 'lobby' | 'playing' | 'done';

/** What `PublicRoomState.phase` may hold: v2 words, or v1 words for a v1 room. */
export type WireRoomPhase = RoomPhase | LegacyRoomPhase;

// --- Round configuration -----------------------------------------------------

/** What every round kind carries, whatever its shell does with the answers. */
export interface RoundConfigBase {
  /**
   * How many questions this round asks. Bounded so a round fits a lesson:
   * DEFAULT_QUESTIONS_PER_ROUND (12) when the host names nothing, and between
   * MIN_QUESTIONS_PER_ROUND and MAX_QUESTIONS_PER_ROUND (6..30) when she does.
   * The three constants live in src/shared/round.ts; `startRound` in
   * src/shared/room.ts holds the cursor that decides WHICH questions.
   *
   * This is the count actually asked, not the count requested: a set too small
   * to fill the round gives everything it has and this says so.
   */
  questionsPerRound: number;
}

export interface RaceConfig extends RoundConfigBase { kind: 'race' }

export interface ClimbConfig extends RoundConfigBase {
  kind: 'climb';
  /** Platforms to the top gate. Set to the round's questionCount at start. */
  height: number;
}

/**
 * Chest weights. They are relative, not percentages: `dashCardFor` normalises by
 * their sum, so a weight set that does not add to 100 still works.
 */
export interface DashWeights {
  points50: number;
  points100: number;
  points200: number;
  swap: number;
  steal: number;
}

export interface DashConfig extends RoundConfigBase {
  kind: 'dash';
  chests: 3;
  /** ms after a question closes in which the chest may be picked. */
  pickMs: number;
  weights: DashWeights;
}

/**
 * Sky Tower, the co-operative round: one tower, built by the whole class.
 *
 * `target` is the height that touches the cloud line, fixed at start from the
 * roster that was in the lobby (three blocks a child, never fewer than six,
 * scaled by the set's level). It does NOT move when somebody joins later,
 * because a goal line that walks away as the class grows is not a goal line.
 *
 * `clockMs` is the three-minute lesson clock. It is a CAP on the schedule, not
 * a replacement for it: a round still asks `questionsPerRound` questions on the
 * same per-question slots as Cloud Climb, and whichever of the two ends first
 * ends the round (see scheduleEndsAt).
 */
export interface TowerConfig extends RoundConfigBase {
  kind: 'tower';
  target: number;
  clockMs: number;
}

export type RoundConfig = RaceConfig | ClimbConfig | DashConfig | TowerConfig;

// --- A round -----------------------------------------------------------------

export interface Round {
  /** 1-based. */
  n: number;
  config: RoundConfig;
  /**
   * SECRET. Drives the question order AND every chest outcome. An opaque string
   * from crypto.randomUUID(), never numeric and never 0, and stripped by
   * publicState: buildQuestions is public code, so a leaked seed is a leaked
   * answer key (amendment 5).
   */
  seed: string;
  /** Server clock; set at start to now + START_DELAY_MS. */
  startsAt: number;
  perQuestionMs: number;
  /** slotMsFor(config.kind, perQuestionMs, pickMs, revealMs). */
  slotMs: number;
  /**
   * The projector pause at the tail of each slot, in ms. REVEAL_MS in a teacher
   * room, 0 in a room with no projector (solo, and legacy "race a friend").
   * Absent on a round that was already running when this shipped; read it
   * through `revealPauseFor`, never directly.
   */
  revealMs?: number;
  questionCount: number;
  directions: Direction[];
  endedAt?: number;
  /**
   * True when this round's questions were drawn against the room's `askedKeys`
   * cursor, and so ending it advances that cursor over the questions that
   * actually opened. Absent (and false) on the legacy path, which races the
   * list its creator uploaded and leaves the cursor alone, and on a round that
   * was already running when this shipped: that round finishes without moving
   * the cursor, which repeats a few questions rather than skipping them, and a
   * room lives 2h. Never on the wire: publicState rebuilds the round field by
   * field.
   */
  drawnFromCursor?: boolean;
}

/** A round as a player is allowed to see it. */
export type PublicRound = Omit<Round, 'seed'>;

// --- Players -----------------------------------------------------------------

export interface Player {
  id: string;
  name: string;
  joinedAt: number;
  /** Cumulative points across every round in this room. */
  total: number;
  /** Rounds won. */
  wins: number;

  // --- current round only; zeroed at every round start ---
  score: number;
  answered: number;
  correct: number;
  totalMs: number;
  answeredIndexes: number[];
  /**
   * Question indexes this player got RIGHT. A dash chest may only be opened on
   * one of these, so a wrong answer earns no treasure (amendment 2).
   */
  correctIndexes: number[];
  /** climb: platform index. Equal to `correct` (stumble-only, no stun). */
  step: number;
  /** dash: question indexes whose chest has been opened. */
  pickedIndexes: number[];
}

// --- Results -----------------------------------------------------------------

export interface RankingEntry {
  playerId: string;
  name: string;
  score: number;
  /**
   * The time this player is RANKED on, not the raw time they spent: every
   * question they left unanswered is charged at the full per-question budget.
   * See rankingMsFor in src/shared/room.ts for why.
   */
  totalMs: number;
  /** climb only: platforms climbed. */
  step?: number;
  /**
   * tower only: blocks this child earned. Present so the TEACHER screen can
   * show who contributed what after a co-operative round; the children's own
   * screens never render a tower ranking, and during the round the server does
   * not even send them each other's counts (see publicState).
   */
  correct?: number;
}

/** One finished round. Written once, at endRound, and never recomputed. */
export interface RoundResult {
  n: number;
  kind: RoundKind;
  winnerId: string | null;
  tie: boolean;
  ranking: RankingEntry[];
  /**
   * tower only: did the class reach the cloud line before the clock?
   *
   * A co-operative round has no `winnerId` to carry the outcome (nobody wins a
   * tower round alone), so the one bit that says how it went needs its own
   * field. Absent on every other kind.
   */
  won?: boolean;
}

/**
 * The v1 end-of-race record. Kept because `model: 1` rooms still put it on the
 * wire for week-1 clients; v2 rooms use `history: RoundResult[]` instead.
 */
export interface RoomResult {
  winnerId: string | null;
  tie: boolean;
  ranking: RankingEntry[];
}

// --- Room --------------------------------------------------------------------

export interface RoomState {
  model: RoomModel;
  code: string;
  phase: RoomPhase;
  /** True when a teacher holds the host key. That teacher is not a player. */
  teacherRoom: boolean;
  /** Legacy player-host ("Race a friend"). '' in a teacher room. */
  hostId: string;
  players: Player[];
  /**
   * How many players may join this room. Fixed at create and carried in the
   * state, so a room keeps the limit it was made with even if the deployed
   * policy changes underneath it, and so the client can say "this room is full"
   * for the right number (it is on the wire).
   *
   * A teacher room gets `ROOM_MAX_PLAYERS_TEACHER` (40 by default, a `vars`
   * entry in wrangler.jsonc). A legacy "Race a friend" room gets 8, which is
   * the week-1 number and the only number that shape ever needed.
   */
  maxPlayers: number;
  set: VocabSet;
  /** The round being played or just finished. Undefined in a fresh lobby. */
  round?: Round;
  /** The CURRENT round's questions. Empty in a fresh teacher lobby. */
  questions: QuizQuestion[];
  /** One row per finished round, oldest first. */
  history: RoundResult[];
  /**
   * SERVER ONLY (omitted from PublicRoomState). The round cursor: one
   * `itemId:direction` key per question this room has already asked in the
   * current cycle.
   *
   * A round asks `questionsPerRound` questions, not the whole set, so without
   * this a second round would re-ask whatever the shuffle happened to put
   * first. `startRound` draws only from questions whose key is absent here, and
   * clears the list when the set runs out, so a class works through the set
   * before it sees a word twice.
   *
   * Kept off the wire because it names the items a round drew from and because
   * a 200-word set makes it 400 strings, which is not something to repeat in
   * every poll.
   */
  askedKeys: string[];
  /**
   * Per-question timer used when a round start does not name one. Set from the
   * set's level at create, and carried by a legacy room whose questions were
   * uploaded at create but whose race has not started yet.
   */
  defaultPerQuestionMs: number;
  createdAt: number;
  lastActivityAt: number;
  /**
   * SERVER ONLY (omitted from PublicRoomState). Set when every player has
   * finished every question early: the instant the round is then allowed to flip
   * to `results`, which is one full reveal pause after the last question went on
   * the projector. Undefined at every other time. See `finishIfDone`.
   */
  pendingFinishAt?: number;
  /** Bumped on every mutation, so `GET /api/rooms/:code?v=N` can answer "unchanged". */
  version: number;
}

// --- What players are allowed to see -----------------------------------------
//
// `QuizQuestion.answer` is the answer key, `Round.seed` regenerates it, and
// `itemId` + `set.items` reconstructs it. All three stay on the server: a v2
// room's wire state carries the questions WITHOUT the key and WITHOUT the item
// they came from, the set WITHOUT its items, and the round WITHOUT the seed, so
// opening devtools mid-round shows nothing a player could win with. The correct
// choice comes back one question at a time, in the reply to that player's own
// answer.

/**
 * The set as a player is allowed to see it: enough to title the screen and pick
 * the right styling, and NOT the words.
 *
 * `items` was the other half of the answer key (wire change 1). Everything a
 * player needs from an item now arrives on the question that asks about it.
 */
export interface PublicVocabSet {
  v: 1;
  title: string;
  level: Level;
  /** How many items the set holds. Replaces `items` for anything that counted. */
  count: number;
  /**
   * v1 mirror (model 1 only): the full item list, exactly as week-1 sent it. A
   * model 2 room omits this, and code that reads it must handle `undefined`.
   */
  items?: VocabItem[];
}

/**
 * A question as a player sees it: the prompt, the choices, and nothing that
 * says which choice is right.
 *
 * Built field by field rather than by `Omit`, so a field added to QuizQuestion
 * later cannot leak by default. `itemId` is deliberately absent: paired with
 * `set.items` it named the answer outright.
 */
export interface PublicQuizQuestion {
  index: number;
  dir: Direction;
  prompt: string;
  /**
   * Pinyin for the prompt, when the prompt is Chinese. '' for an en2zh
   * question, whose prompt is English. Sent because the client can no longer
   * look the item up in `set.items`.
   */
  promptPinyin: string;
  choices: string[];
  /** v1 mirror (model 1 only). Absent on a model 2 room. */
  itemId?: string;
}

/**
 * The room as it goes on the wire: no answer key, no round seed.
 *
 * The five optional fields at the bottom are the v1 mirrors. They are present
 * ONLY for a `model: 1` room, whose wire shape must stay byte-compatible with
 * what a week-1 client reads (amendment 6). A v2 room omits them and the client
 * reads `round` instead.
 */
export interface PublicRoomState
  extends Omit<RoomState, 'questions' | 'round' | 'phase' | 'set' | 'askedKeys'> {
  phase: WireRoomPhase;
  set: PublicVocabSet;
  /**
   * The CURRENT round's questions, and empty outside a round in a model 2 room
   * (wire change 7). Always an array, never absent, so a client that reads
   * `.length` cannot trip over it.
   */
  questions: PublicQuizQuestion[];
  round?: PublicRound;

  /** v1 mirror (model 1 only). */
  startsAt?: number;
  /** v1 mirror (model 1 only). */
  perQuestionMs?: number;
  /** v1 mirror (model 1 only). */
  slotMs?: number;
  /** v1 mirror (model 1 only). */
  questionCount?: number;
  /** v1 mirror (model 1 only). */
  result?: RoomResult;
  /** v1 mirror (model 1 only). */
  winnerId?: string;

  /**
   * tower rounds only: how many blocks the CLASS has stacked, as one number
   * that names nobody.
   *
   * It exists because the same poll that carries it has had every other
   * child's count stripped out of `players` (see publicState). Without it a
   * child could not draw the shared tower at all, and with it she still cannot
   * say who put which block there.
   */
  towerTotal?: number;
}

// --- Treasure Dash -----------------------------------------------------------

/**
 * What a chest holds, decided by the round seed BEFORE anybody picks. All three
 * chests already have a card; picking chooses which one you get, so the client
 * cannot re-roll and the secret seed means it cannot pre-read the good one.
 */
export type DashCard = 'points50' | 'points100' | 'points200' | 'swap' | 'steal';

/**
 * What a card DID once applied to the live scoreboard. Separate from DashCard on
 * purpose (Codex round 1, SHOULD-FIX): the seed decides the card, the room state
 * decides who it hit and for how much.
 */
export type ChestOutcome =
  | { kind: 'points'; points: number }
  | { kind: 'swap'; withPlayerId: string; before: number; after: number }
  | { kind: 'steal'; fromPlayerId: string; points: number };

// --- Refusals ----------------------------------------------------------------

/**
 * Why the server ignored an action.
 * - `window`   the question or pick window is not open
 * - `duplicate` already answered / already opened that chest
 * - `unearned` a dash pick on a question this player did not get right
 * - `unknown`  no such player, or an out-of-range index or chest
 * - `phase`    the room is not in a round
 */
export type Refusal = 'window' | 'duplicate' | 'unearned' | 'unknown' | 'phase';

/** Short random id, good enough for player ids and similar non-cryptographic uses. */
export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// --- API envelopes -----------------------------------------------------------

/** What every room route returns around the state. */
export interface RoomEnvelope {
  state: PublicRoomState;
  version: number;
  nextPollMs: number;
  serverNow: number;
}

/**
 * POST /api/rooms/:code/join adds the id the caller was given, and the secret
 * that proves the caller IS that id.
 *
 * This response is the ONLY place `memberKey` ever travels. It is not in
 * `PublicRoomState`, so no later state read can hand it to anyone else, and the
 * client must keep it (localStorage, next to `playerId`) to answer or pick.
 */
export interface JoinEnvelope extends RoomEnvelope {
  playerId: string;
  memberKey: string;
}

/** POST /api/rooms returns this. `hostKey` is present only for a teacher room. */
export interface CreateRoomResponse {
  code: string;
  hostKey?: string;
}

/**
 * POST /api/rooms/:code/answer. `accepted` is false when the server ignored the
 * answer (window closed, wrong index, already answered, unknown player), which
 * is the client's cue to unlock the question and resync rather than show a
 * result. `correct` is only ever true when `accepted` is also true.
 */
export interface AnswerEnvelope extends RoomEnvelope {
  accepted: boolean;
  correct: boolean;
  /**
   * Which choice was the right one for the question just answered, so the
   * client can highlight it. This is the ONLY place the answer key reaches a
   * player, and only for a question the server actually recorded an answer to.
   *
   * `-1` means withheld: the server did not record the answer (window shut,
   * duplicate, unknown player, bad index), so revealing it would hand out a
   * free answer to a question that may still be open.
   */
  correctChoice: number;
  refusal?: Refusal;
  /** dash only: the pick window this correct answer just opened. */
  pick?: { index: number; expiresAt: number };
}

/**
 * POST /api/rooms/:code/pick. `outcome` is withheld whenever `accepted` is
 * false, so a refused pick reveals nothing about what was in the chest.
 */
export interface PickEnvelope extends RoomEnvelope {
  accepted: boolean;
  refusal?: Refusal;
  outcome?: ChestOutcome;
}

