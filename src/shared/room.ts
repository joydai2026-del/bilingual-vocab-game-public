// Pure reducer for room state. RoomDO (src/worker/room-do.ts) is a thin
// persistence + HTTP shell around this file: every rule that decides what the
// room DOES lives here, so it can be tested without a Durable Object.
//
// Room model v2: a room no longer IS one race, it HOSTS a sequence of rounds.
//
//   lobby --(host starts a round)--> round --(schedule ends, or host: "end
//     ^                                          this round now")--> results
//     |                                                              |
//     +--------------------(host: "pick another game")---------------+
//
//                          lobby --(30 min idle)--> closed
//                        results --(15 min idle)--> closed
//                    any phase --(host: "finish")--> closed
//
// The roster persists across rounds; joining is allowed in `lobby` only, so a
// round's roster freezes the moment it starts.
//
// Every function is a pure transform: (state, ...) -> new state. No I/O, no
// Date.now() (the caller passes `now`, which in production is the DO's own
// clock, never a client-supplied timestamp).
//
// Server-authoritative timing: question `i` is open during
// [startsAt + i*slotMs, that + perQuestionMs], and slotMs comes from
// slotMsFor(kind, perQuestionMs) so a dash round gets its wider slot. The
// elapsed time credited for an answer is computed here from `now`, not sent by
// the client, so a client cannot claim to have answered instantly.

import type {
  ChestOutcome,
  Direction,
  Player,
  PublicRoomState,
  QuizQuestion,
  Refusal,
  RoomModel,
  RoomPhase,
  RoomResult,
  RoomState,
  Round,
  RoundKind,
  RoundResult,
  VocabSet,
  WireRoomPhase,
} from './types';
import { ROOM_MODEL, newId } from './types';
import { buildQuestions, scoreAnswer } from './quiz';
import { hashSeed } from './rng';
import {
  DEFAULT_QUESTIONS_PER_ROUND,
  GRACE_MS,
  MAX_QUESTIONS_PER_ROUND,
  MIN_QUESTIONS_PER_ROUND,
  REVEAL_MS,
  applyPick,
  buildRanking,
  buildRoundResult,
  clampQuestionsPerRound,
  climbStepFor,
  configFor,
  towerQuestionsInClock,
  TOWER_CLOCK_MS,
  currentWindowClosesAt,
  pickWindow,
  questionWindow,
  rankingMsFor,
  revealPauseFor,
  slotMsFor,
  towerTotalOf,
  towerReached,
} from './round';

export {
  GRACE_MS,
  REVEAL_MS,
  revealPauseFor,
  DEFAULT_QUESTIONS_PER_ROUND,
  MIN_QUESTIONS_PER_ROUND,
  MAX_QUESTIONS_PER_ROUND,
  clampQuestionsPerRound,
  questionWindow,
  rankingMsFor,
  slotMsFor,
  pickWindow,
  currentWindowClosesAt,
  buildRanking,
  buildRoundResult,
  towerTotalOf,
  towerReached,
};

/**
 * The legacy "Race a friend" roster cap. Two people race; 8 was week 1's number
 * and it is the only one that shape ever needed.
 */
export const MAX_PLAYERS = 8;
/**
 * The default teacher-room roster cap. A real class is 20-30, and week 2
 * inherited the 8 above unchanged, so the ninth child to type the code was told
 * "this room is full" (Claude code review round 1, MUST-FIX 3).
 *
 * Overridable per deploy by `ROOM_MAX_PLAYERS_TEACHER` in wrangler.jsonc: the
 * worker reads the policy and passes the number in at create, and the room
 * carries it for its whole life (RoomState.maxPlayers).
 */
export const MAX_PLAYERS_TEACHER = 40;
/**
 * The structural ceiling on that policy value, whatever a config says. Every
 * player is a row in the state that every device polls, so this is what stops a
 * fat-fingered var from making the poll payload the size of the class list.
 */
export const MAX_PLAYERS_CEILING = 200;
/**
 * "Race a friend" means head to head: one player alone cannot start a legacy
 * race. A teacher room is different - the teacher is not a player, so one
 * student is a legitimate class (plan §1.2).
 */
export const MIN_PLAYERS = 2;
export const TEACHER_MIN_PLAYERS = 1;
export const START_DELAY_MS = 3_000;
/** A round finishes this long after the last join/start/answer/pick. */
export const INACTIVITY_TIMEOUT_MS = 60_000;
/** A room sitting on the results screen this long closes itself (plan §1.8). */
export const RESULTS_IDLE_MS = 15 * 60 * 1000;
/**
 * A room sitting in the LOBBY this long closes itself (Claude code review round
 * 1, SHOULD-FIX 2).
 *
 * A lobby had no deadline at all, so a room abandoned before the first round, or
 * sent back to the lobby by "pick another game" and then left, kept every device
 * in the class polling every 2 seconds until the 2h TTL deleted it. Joining,
 * starting and ending all bump `lastActivityAt`; polling deliberately does not,
 * so a screenful of idle tabs cannot hold a dead room open.
 *
 * Longer than the results window because a lobby is where a teacher waits for a
 * class to file in and find the code.
 */
export const LOBBY_IDLE_MS = 30 * 60 * 1000;

/**
 * `correctChoice` when the server is not telling. See AnswerEnvelope in
 * src/shared/types.ts for why a refused answer reveals nothing.
 */
export const CHOICE_WITHHELD = -1;

/** How many players this room needs before a round may start. */
export function minPlayersFor(state: RoomState): number {
  return state.teacherRoom ? TEACHER_MIN_PLAYERS : MIN_PLAYERS;
}

/**
 * How many players this room holds.
 *
 * Reads the number the room was created with. The fallback covers a room stored
 * before this field existed, which a 2h TTL means can only be a room created in
 * the last two hours, and which persist.ts backfills on load anyway.
 */
export function maxPlayersFor(state: RoomState): number {
  const stored = state.maxPlayers;
  if (typeof stored === 'number' && Number.isInteger(stored) && stored > 0) {
    return Math.min(stored, MAX_PLAYERS_CEILING);
  }
  return state.teacherRoom ? MAX_PLAYERS_TEACHER : MAX_PLAYERS;
}

/** A configured roster cap, made safe: a positive integer, never above the ceiling. */
export function clampMaxPlayers(requested: unknown, fallback: number): number {
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) {
    return Math.min(fallback, MAX_PLAYERS_CEILING);
  }
  return Math.min(requested, MAX_PLAYERS_CEILING);
}

// --- what goes on the wire ---------------------------------------------------

/** v2 phase -> the word a week-1 client understands. */
function legacyPhaseFor(phase: RoomPhase): WireRoomPhase {
  if (phase === 'lobby') return 'lobby';
  if (phase === 'round') return 'playing';
  return 'done';
}

/** The last finished round, in the v1 `RoomResult` shape. */
function legacyResultFor(state: RoomState): RoomResult | undefined {
  const last = state.history[state.history.length - 1];
  if (!last) return undefined;
  return { winnerId: last.winnerId, tie: last.tie, ranking: last.ranking };
}

/**
 * The set as a v2 room puts it on the wire: title and level, no words.
 *
 * A model 1 room keeps `items`, because a week-1 client reads them and because
 * that client uploaded the set itself, so it already has every word (wire
 * change 1 in src/shared/types.ts).
 */
function publicSetFor(state: RoomState): PublicRoomState['set'] {
  const base: PublicRoomState['set'] = {
    v: 1,
    title: state.set.title,
    level: state.set.level,
    count: state.set.items.length,
  };
  return state.model === 1 ? { ...base, items: state.set.items } : base;
}

/**
 * The questions as a v2 room puts them on the wire.
 *
 * Rebuilt field by field, not stripped by destructuring, so a field added to
 * QuizQuestion later cannot leak by default. `itemId` is dropped: with
 * `set.items` it named the answer, and it is the half a v2 client never needed.
 * `promptPinyin` replaces the lookup the client used to do in `set.items`.
 */
function publicQuestionsFor(state: RoomState): PublicRoomState['questions'] {
  const pinyinById = new Map(state.set.items.map((item) => [item.id, item.pinyin]));
  return state.questions.map((q) => {
    const pub: PublicRoomState['questions'][number] = {
      index: q.index,
      dir: q.dir,
      prompt: q.prompt,
      // Only a zh2en prompt is Chinese. Sending pinyin for an en2zh prompt would
      // be sending the pinyin of the ENGLISH word, which is nothing, and sending
      // the item's pinyin there would name the Chinese answer.
      promptPinyin: q.dir === 'zh2en' ? (pinyinById.get(q.itemId) ?? '') : '',
      choices: q.choices,
    };
    if (state.model === 1) pub.itemId = q.itemId;
    return pub;
  });
}

/**
 * The room as a player is allowed to see it: the answer key is stripped from
 * every question, the item the question came from is stripped with it, the set's
 * words are stripped, and the seed is stripped from the round.
 *
 * This is the ONLY thing RoomDO ever puts on the wire. Every strip is
 * load-bearing. Sending the raw state handed every player the right answer to
 * every question from the moment they joined. Dropping only `answer` was not
 * enough: `itemId` plus `set.items` reconstructed it exactly (Codex round 1,
 * MUST-FIX 1). And because `buildQuestions` is public code, a leaked
 * `round.seed` is a leaked answer key AND a preview of every chest.
 *
 * A `model: 1` room additionally gets the v1 mirror fields and the v1 phase
 * words, so a tab still holding week-1 JS finishes its race instead of dying on
 * a phase it has never heard of (amendment 6).
 */
/**
 * Who is asking for the state.
 *
 * It matters for exactly one round kind. Sky Tower promises a child that she
 * sees her own blocks and nobody else's, and a promise the client keeps by
 * choosing not to render something is not a promise: the numbers would still be
 * one devtools tab away, in a game whose whole point is that nobody is being
 * ranked. So the server strips them, which means the server has to know who is
 * reading.
 *
 * `host` is the teacher's device, proved by the host key. `player` is a child,
 * proved by the member key her join minted; the id alone is public and proves
 * nothing, so an unproved caller is `anon` and sees no counts at all.
 */
export type RoomViewer =
  | { role: 'host' }
  | { role: 'player'; playerId: string }
  | { role: 'anon' };

/**
 * Every scoring number zeroed, and the identity (id, name, joinedAt) left alone.
 *
 * `total` and `wins` go too, and that is the panel round 1 fix (M2). They read
 * like durable identity, but `endRound` banks the round's score straight into
 * `total` (`total: p.total + p.score` below), so leaving them alone undid the
 * whole redaction the instant the round flipped to results: every child's exact
 * tower score, by name, to every other child, for the rest of the lesson. The
 * lesson scoreboard is the teacher's; a child gets her own points and the class
 * total, which is a number that names nobody.
 */
function withoutRoundProgress(player: Player): Player {
  return {
    ...player,
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
  };
}

/**
 * The roster as this viewer may see it.
 *
 * Untouched for every kind but Sky Tower, and untouched for the teacher. For a
 * child in a tower round, every OTHER child is flattened to zero: not hidden
 * (the lobby list, the roster and the join limit all still work), just silent
 * about what they scored. The shared height still reaches her, as
 * `towerTotal`, which is a number and not a name.
 */
function playersFor(state: RoomState, viewer: RoomViewer): Player[] {
  if (state.round?.config.kind !== 'tower') return state.players;
  if (viewer.role === 'host') return state.players;
  const selfId = viewer.role === 'player' ? viewer.playerId : '';
  return state.players.map((p) => (p.id === selfId ? p : withoutRoundProgress(p)));
}

/**
 * The finished-round rows this viewer may see.
 *
 * A tower row's ranking is the contribution list, which is the same thing the
 * live roster was just stripped of, so it goes to the teacher and to nobody
 * else. What a child needs from the row is `won`, and that stays.
 */
function historyFor(state: RoomState, viewer: RoomViewer): RoundResult[] {
  if (viewer.role === 'host') return state.history;
  if (!state.history.some((row) => row.kind === 'tower')) return state.history;
  return state.history.map((row) => (row.kind === 'tower' ? { ...row, ranking: [] } : row));
}

export function publicState(
  state: RoomState,
  viewer: RoomViewer = { role: 'anon' }
): PublicRoomState {
  // Outside a round there is nothing on any screen that renders a question, and
  // the list is the largest avoidable part of the payload (wire change 7). A
  // model 1 room keeps sending them: a week-1 client reads them on its `done`
  // screen, and its questions were never secret from it anyway.
  const questions =
    state.model === 1 || state.phase === 'round' ? publicQuestionsFor(state) : [];

  let round: PublicRoomState['round'];
  if (state.round) {
    const {
      n,
      config,
      startsAt,
      perQuestionMs,
      slotMs,
      questionCount,
      directions,
      endedAt,
    } = state.round;
    round = { n, config, startsAt, perQuestionMs, slotMs, questionCount, directions, endedAt };
  }

  const base: PublicRoomState = {
    model: state.model,
    code: state.code,
    phase: state.phase,
    teacherRoom: state.teacherRoom,
    hostId: state.hostId,
    players: playersFor(state, viewer),
    // On the wire on purpose: a client that does not know the cap cannot tell a
    // child whether "this room is full" means wait or means a typo in the code.
    maxPlayers: maxPlayersFor(state),
    set: publicSetFor(state),
    round,
    questions,
    history: historyFor(state, viewer),
    defaultPerQuestionMs: state.defaultPerQuestionMs,
    createdAt: state.createdAt,
    lastActivityAt: state.lastActivityAt,
    version: state.version,
  };

  // The class tower's height, for the round that is running or the one that
  // just finished. Computed from the UNREDACTED roster on purpose: this is the
  // one number every child is allowed to have.
  if (state.round?.config.kind === 'tower') base.towerTotal = towerTotalOf(state.players);

  if (state.model !== 1) return base;

  const result = legacyResultFor(state);
  return {
    ...base,
    phase: legacyPhaseFor(state.phase),
    startsAt: state.round?.startsAt,
    perQuestionMs: state.round?.perQuestionMs ?? state.defaultPerQuestionMs,
    slotMs:
      state.round?.slotMs ??
      slotMsFor('race', state.defaultPerQuestionMs, undefined, state.teacherRoom ? REVEAL_MS : 0),
    questionCount: state.round?.questionCount ?? state.questions.length,
    result,
    winnerId: result?.winnerId ?? undefined,
  };
}

/**
 * The right choice for one question, revealed only when the server actually
 * recorded this player's answer to it. Returns CHOICE_WITHHELD otherwise, so a
 * player cannot POST a junk answer at a question that has not opened yet and
 * read the key out of the refusal.
 */
export function revealedChoice(state: RoomState, index: number, accepted: boolean): number {
  if (!accepted) return CHOICE_WITHHELD;
  const question = state.questions[index];
  return question === undefined ? CHOICE_WITHHELD : question.answer;
}

/**
 * The right choice for one question, for the PROJECTOR, and only once that
 * question is shut for good: its window plus the answering grace have both
 * passed on the server's own clock. CHOICE_WITHHELD otherwise.
 *
 * This is the whole of D3's safety rule in one place. The answer key never
 * travels in `publicState` (see there), so the teacher screen has to ask for it,
 * and this function is what the host-only `reveal` endpoint answers with. Two
 * things it must never do, both live behaviours a class would notice:
 *   - reveal a question that is still open, or still inside its grace, which
 *     would hand the room the answer while a child can still score it;
 *   - reveal a question that has not opened, which would be the answer key.
 */
export function revealedAnswerFor(state: RoomState, index: number, now: number): number {
  if (state.phase !== 'round' || !state.round) return CHOICE_WITHHELD;
  if (!Number.isInteger(index) || index < 0 || index >= state.questions.length) {
    return CHOICE_WITHHELD;
  }
  if (now < revealInstantFor(state, index)) return CHOICE_WITHHELD;
  return state.questions[index].answer;
}

/**
 * The first instant question `index` may go on the projector.
 *
 * Its window plus the answering grace, because the grace is when a late answer
 * still counts and the answer is therefore still live. The one exception is a
 * class that has ALL answered: nobody's answer can change, so the question is
 * over early and the projector may say so.
 *
 * Shared with `finishIfDone`, which holds the room in `round` until this instant
 * plus the reveal pause has run, so the last word of a lesson is on the wall for
 * as long as every other word was (round-2 review, MUST-FIX 1). One expression,
 * one place: the gate and the hold cannot drift apart.
 */
export function revealInstantFor(state: RoomState, index: number): number {
  const round = state.round;
  if (!round) return Number.POSITIVE_INFINITY;
  const { closesAt } = questionWindow(round.startsAt, round.slotMs, round.perQuestionMs, index);
  const everyoneAnswered =
    state.players.length > 0 && state.players.every((p) => p.answeredIndexes.includes(index));
  return everyoneAnswered ? closesAt : closesAt + GRACE_MS;
}

/**
 * Polling cadence the server tells the client to use, per phase. 0 = stop.
 *
 * `results` polling at 2000 is the real behavioural change in v2: a device on
 * the results screen must keep asking, or it will never learn the teacher
 * started the next game. `closed` is the escape hatch that stops every client
 * for good.
 *
 * A `model: 1` room keeps the v1 cadence, where `done` is the end of the story
 * and an old client has nothing left to wait for.
 */
export function nextPollMsFor(phase: RoomPhase, model: RoomModel = ROOM_MODEL as RoomModel): number {
  if (phase === 'lobby') return 2000;
  if (phase === 'round') return 1000;
  if (phase === 'results') return model === 1 ? 0 : 2000;
  return 0;
}

/**
 * When the current round is over on the clock alone. The DO sets an alarm for
 * this instant so a round still finishes when players stop polling. Undefined
 * outside a round.
 *
 * `questionCount * slotMs` already covers the trailing grace: the last question
 * opens at `(n-1) * slotMs`, closes `perQuestionMs` later, and its grace (plus,
 * in dash, its pick window) runs for the rest of that slot.
 */
export function scheduleEndsAt(state: RoomState): number | undefined {
  if (!state.round || state.phase !== 'round') return undefined;
  const round = state.round;
  const schedule = round.startsAt + round.questionCount * round.slotMs;
  // Sky Tower runs against a three-minute class clock as well as its question
  // list, and whichever runs out first ends the round. The clock is a cap, so
  // a short round still ends when its questions do.
  if (round.config.kind === 'tower') {
    return Math.min(schedule, round.startsAt + round.config.clockMs);
  }
  return schedule;
}

// --- creating and joining ----------------------------------------------------

function freshPlayer(id: string, name: string, now: number): Player {
  return {
    id,
    name,
    joinedAt: now,
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
  };
}

/**
 * A new room.
 *
 * Two shapes come through here. A teacher room (`{ teacher: true }`) starts
 * empty: no questions, no host player, and the server builds a fresh question
 * list at every round start. A legacy "Race a friend" room arrives with its
 * questions already uploaded and stays `model: 1` until somebody starts a v2
 * round, so a week-1 client keeps working across the deploy.
 */
export function createRoom(
  code: string,
  set: VocabSet,
  questions: QuizQuestion[],
  perQuestionMs: number,
  now: number,
  opts: { teacher?: boolean; maxPlayers?: number } = {}
): RoomState {
  const teacher = opts.teacher === true;
  return {
    model: teacher ? 2 : 1,
    code,
    phase: 'lobby',
    teacherRoom: teacher,
    hostId: '',
    players: [],
    // A legacy room is head to head and stays at the week-1 number whatever the
    // policy says; only a teacher room takes the configured class size.
    maxPlayers: teacher
      ? clampMaxPlayers(opts.maxPlayers, MAX_PLAYERS_TEACHER)
      : MAX_PLAYERS,
    set,
    questions,
    history: [],
    askedKeys: [],
    defaultPerQuestionMs: perQuestionMs,
    createdAt: now,
    lastActivityAt: now,
    version: 1,
  };
}

/** Why a join was refused. The screen says a different sentence for each. */
export type JoinRefusal = 'full' | 'phase' | 'closed' | 'duplicate';

/**
 * One child's name as the roster compares it: trimmed, inner runs of whitespace
 * collapsed to one space, case folded, and width-folded (a phone keyboard can
 * produce full-width Latin).
 *
 * Whitespace is COLLAPSED, never deleted: "Ana Lee" and "ana  lee" are one
 * child, but "A na" and "Ana" are two, because deleting the space would merge
 * names that a teacher reads as different people.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Is this name already on the roster, as a teacher would read the board? */
export function nameTaken(state: RoomState, name: string): boolean {
  const wanted = normalizeName(name);
  if (wanted === '') return false;
  return state.players.some((p) => normalizeName(p.name) === wanted);
}

/**
 * Joins a new player. Rejects (playerId: null, plus the reason) when the room is
 * full (see maxPlayersFor: 40 by default in a teacher room, 8 in a legacy one),
 * when a round is actually running, when the lesson is finished, or when the
 * name is one the board already shows.
 *
 * WHEN a child may join (D2, live verification 2026-09-08): whenever no round is
 * in progress. That is the lobby AND the results screen a class room sits on
 * between games, which is what the refusal message has always promised. A legacy
 * "Race a friend" room is excluded: its results screen is the end of that race,
 * and a week-1 client on `done` has nothing a new player could do.
 *
 * WHY the duplicate check is here and not on the join screen (D1): the teacher
 * reads one board, and two rows reading "Ana 0" are two children she cannot tell
 * apart. The client holds no roster it can be trusted with, so the server owns
 * the rule.
 *
 * The first joiner becomes host in a legacy room only. In a teacher room the
 * host is whoever holds the host key, and `hostId` stays empty, so a student
 * cannot start or end a round.
 */
export function join(
  state: RoomState,
  name: string,
  now: number
): { state: RoomState; playerId: string | null; refusal?: JoinRefusal } {
  const betweenGames = state.phase === 'results' && state.teacherRoom;
  if (state.phase !== 'lobby' && !betweenGames) {
    return { state, playerId: null, refusal: state.phase === 'closed' ? 'closed' : 'phase' };
  }
  if (state.players.length >= maxPlayersFor(state)) {
    return { state, playerId: null, refusal: 'full' };
  }
  if (nameTaken(state, name)) return { state, playerId: null, refusal: 'duplicate' };

  const playerId = newId();
  const player = freshPlayer(playerId, name, now);
  const isFirstJoiner = state.players.length === 0;

  const nextState: RoomState = {
    ...state,
    players: [...state.players, player],
    hostId: !state.teacherRoom && isFirstJoiner ? playerId : state.hostId,
    lastActivityAt: now,
    version: state.version + 1,
  };

  return { state: nextState, playerId };
}

// --- rounds ------------------------------------------------------------------

/**
 * The identity of one question, independent of the shuffle it arrived in: which
 * item it asks about, and which way round. Two rounds rebuild their pool from
 * different secret seeds, so position means nothing across rounds and this is
 * what the cursor in `RoomState.askedKeys` records.
 */
export function questionKey(question: QuizQuestion): string {
  return `${question.itemId}:${question.dir}`;
}

/**
 * Draws one round's worth of questions from the pool, preferring ones this room
 * has not asked yet, and returns the new cursor.
 *
 * The rule in one line: work through the set before repeating any of it. Fresh
 * questions first; when they run out mid-draw the cycle restarts, so the round
 * is still full length and the cursor from then on records only this round.
 *
 * A pool smaller than `want` (a short set, or a set where duplicate glosses
 * dropped half the en2zh direction) gives everything it has rather than padding
 * with repeats inside a single round.
 */
export function drawQuestions(
  pool: QuizQuestion[],
  askedKeys: string[],
  want: number
): { questions: QuizQuestion[]; askedKeys: string[] } {
  const alreadyAsked = new Set(askedKeys);
  const fresh = pool.filter((q) => !alreadyAsked.has(questionKey(q)));
  const drawn = fresh.slice(0, want);

  if (drawn.length < want) {
    // Everything left in the pool was asked in this cycle, so the cycle ends
    // here: the rest of this round comes off the top of the pool again, and the
    // cursor restarts from what this round just drew.
    const drawnKeys = new Set(drawn.map(questionKey));
    const recycled = pool
      .filter((q) => !drawnKeys.has(questionKey(q)))
      .slice(0, want - drawn.length);
    drawn.push(...recycled);
  }

  // `index` is the ordinal a client answers with, so it has to match the round's
  // own order, not the position the question held in the pool.
  return {
    questions: drawn.map((q, i) => ({ ...q, index: i })),
    // The cursor this draw WOULD leave if every question in it were asked. The
    // room does not take it at start any more (see commitAsked and endRound);
    // it is returned so the draw can still be reasoned about on its own.
    askedKeys: commitAsked(askedKeys, drawn, drawn.length),
  };
}

/**
 * The room's question cursor after `opened` of `drawn` were actually put in
 * front of the class, starting from the cursor `askedKeys` the round drew
 * against.
 *
 * This is the whole cursor rule in one place, and it is deliberately not
 * "append what was drawn". A teacher who starts the wrong game and ends it
 * three questions in has shown the class three words, so three words are what
 * the next round must skip (Codex round 2, MUST-FIX 1).
 *
 * The one subtlety is the recycle round. When the draw ran out of fresh
 * questions it restarted the cycle partway through, and every question from
 * that point on is one the room has already seen. If the round got that far,
 * the new cycle is what this round asked and nothing before it; if it stopped
 * while still inside the leftovers, the old cycle simply gains those few.
 * `recycleAt` is where that boundary falls: the first drawn question whose key
 * was already on the cursor.
 */
export function commitAsked(
  askedKeys: string[],
  drawn: QuizQuestion[],
  opened: number
): string[] {
  const taken = Math.max(0, Math.min(opened, drawn.length));
  if (taken === 0) return askedKeys;

  const alreadyAsked = new Set(askedKeys);
  const openedKeys = drawn.slice(0, taken).map(questionKey);
  const recycleAt = drawn.findIndex((q) => alreadyAsked.has(questionKey(q)));

  if (recycleAt === -1 || taken <= recycleAt) return [...askedKeys, ...openedKeys];
  return openedKeys;
}

/**
 * How many of this round's questions had opened by `now`, on the server's own
 * clock. Nothing before `startsAt` has opened; the last question opens at
 * `startsAt + (questionCount - 1) * slotMs`.
 */
export function openedQuestionCount(round: Round, now: number): number {
  if (now < round.startsAt) return 0;
  const elapsed = now - round.startsAt;
  const opened = Math.floor(elapsed / round.slotMs) + 1;
  return Math.min(opened, round.questionCount);
}

export interface StartRoundOptions {
  kind: RoundKind;
  /** Opaque secret. crypto.randomUUID() in production, a fixture in tests. */
  seed: string;
  perQuestionMs?: number;
  directions?: Direction[];
  /**
   * How many questions this round should ask. Clamped to 6..30, and 12 when
   * absent. Ignored on the legacy path, which races the uploaded list whole.
   */
  questionsPerRound?: number;
  /**
   * Use these questions instead of building fresh ones. The legacy create path
   * uploads its own list, and that list is what `/start` must race on.
   */
  questions?: QuizQuestion[];
  /**
   * True only for the v1 `/start` alias. Keeps the room at `model: 1` so its
   * wire shape stays v1 for the client that created it.
   */
  legacy?: boolean;
  /**
   * Is there a projector in the room? Defaults to `state.teacherRoom`, which is
   * the shape that has one. The solo games build a local `teacher: true` room to
   * get the v2 reducers and pass `false` here, because the child has already
   * read the answer off her own screen and should not wait 2.5s per question for
   * a wall she does not have (round-2 review, SHOULD-FIX 3).
   */
  projector?: boolean;
}

/**
 * Starts a round. Lobby-only, and only once the room has enough players.
 *
 * Questions are generated HERE, server-side, from the round's own secret seed
 * (plan §1.4): a fresh shuffle every round, a smaller create payload, and an
 * answer key that never leaves the server. The seed is hashed with a `:q`
 * suffix so the question order and the chest outcomes are drawn from different
 * streams of the same secret (amendment 5).
 *
 * Per-round player fields are zeroed here rather than at endRound, so the
 * results screen can still show the round that just finished.
 *
 * How MANY questions is `questionsPerRound` (12 by default, 6..30 on request),
 * and WHICH ones is `drawQuestions` reading the room's cursor, so a class works
 * through the set before it meets a word for the second time.
 */
export function startRound(state: RoomState, opts: StartRoundOptions, now: number): RoomState {
  if (state.phase !== 'lobby') return state;
  if (state.players.length < minPlayersFor(state)) return state;

  const perQuestionMs = opts.perQuestionMs ?? state.defaultPerQuestionMs;
  const directions = opts.directions ?? (['zh2en', 'en2zh'] as Direction[]);

  // The legacy path races the list its creator uploaded, whole and in order:
  // that list IS the v1 race and neither the length cap nor the cursor applies.
  // A teacher room builds a fresh pool from the round's own secret seed and
  // draws a lesson-sized slice of it.
  let questions: QuizQuestion[];
  let drawnFromCursor = false;
  if (opts.questions) {
    questions = opts.questions;
  } else {
    const pool = buildQuestions(state.set, { directions, seed: hashSeed(`${opts.seed}:q`) });
    const draw = drawQuestions(pool, state.askedKeys ?? [], clampQuestionsPerRound(opts.questionsPerRound));
    questions = draw.questions;
    drawnFromCursor = true;
  }

  if (questions.length === 0) return state;

  const revealMs = (opts.projector ?? state.teacherRoom) ? REVEAL_MS : 0;

  // Sky Tower is the one kind whose slot does not depend on its own config (it
  // has no pick window), so the slot can be known before the config is built,
  // and the clock can be applied to both the schedule and the target.
  //
  // The schedule first: a tower round gets only as many questions as the 3
  // minute clock can OPEN. On the default kids path (12s a question, a 16s
  // slot) twelve questions ran 192s against a 180s clock, so the last word
  // appeared, was yanked 4s later, and `endRound` still burned it off the
  // lesson cursor as asked. Nobody in the room could see why that word was
  // gone (panel round 1, S3).
  if (opts.kind === 'tower') {
    const towerSlotMs = slotMsFor('tower', perQuestionMs, undefined, revealMs);
    const opens = towerQuestionsInClock(TOWER_CLOCK_MS, towerSlotMs);
    // At least one: a pacing so slow the clock opens nothing is still a round.
    questions = questions.slice(0, Math.max(1, Math.min(questions.length, opens)));
  }

  // Sky Tower's target is the only config that depends on anything but the
  // question count: three blocks a child, scaled by the set's level and capped
  // by what the clock lets the class bank. Fixed HERE, from the roster in the
  // lobby, so the cloud line does not move.
  const config = configFor(opts.kind, questions.length, {
    level: state.set.level,
    playerCount: state.players.length,
    slotMs: slotMsFor(opts.kind, perQuestionMs, undefined, revealMs),
  });
  const pickMs = config.kind === 'dash' ? config.pickMs : undefined;

  const round: Round = {
    n: state.history.length + 1,
    config,
    seed: opts.seed,
    startsAt: now + START_DELAY_MS,
    perQuestionMs,
    revealMs,
    slotMs: slotMsFor(opts.kind, perQuestionMs, pickMs, revealMs),
    questionCount: questions.length,
    directions,
    // Whether this round's list came off the room's cursor, and so whether
    // ending it moves that cursor. A legacy round races the list its creator
    // uploaded and never touches the cursor.
    drawnFromCursor,
  };

  return {
    ...state,
    model: opts.legacy ? state.model : 2,
    phase: 'round',
    round,
    // A fresh round has nothing booked. Belt and braces: endRound clears it too.
    pendingFinishAt: undefined,
    questions,
    // The cursor does NOT move here. A round that is started and ended before
    // the class sees a word must cost the room nothing, so the questions are
    // committed at endRound, and only the ones whose window actually opened
    // (Codex round 2, MUST-FIX 1).
    askedKeys: state.askedKeys ?? [],
    players: state.players.map((p) => ({
      ...p,
      score: 0,
      answered: 0,
      correct: 0,
      totalMs: 0,
      answeredIndexes: [],
      correctIndexes: [],
      step: 0,
      pickedIndexes: [],
    })),
    lastActivityAt: now,
    version: state.version + 1,
  };
}

/**
 * The v1 "Race a friend" start, unchanged on the wire: host-only, lobby-only,
 * two players minimum, and it races the questions the creator uploaded. No-op
 * otherwise. The two-player rule is enforced here rather than only in the UI, so
 * a direct API call cannot start a one-player "head-to-head" race.
 */
export function start(state: RoomState, playerId: string, now: number): RoomState {
  if (state.phase !== 'lobby') return state;
  if (state.teacherRoom) return state;
  if (playerId !== state.hostId) return state;
  if (state.players.length < MIN_PLAYERS) return state;
  if (state.questions.length === 0) return state;

  return startRound(
    state,
    {
      kind: 'race',
      seed: `legacy:${state.code}:${state.history.length + 1}`,
      questions: state.questions,
      legacy: true,
    },
    now
  );
}

// --- answering ---------------------------------------------------------------

/**
 * Records one answer, scoring it from the server's own clock.
 *
 * Ignored (state returned unchanged) when: the room is not in a round, the index
 * is out of range, the choice is not one of the choices that question actually
 * offers, `now` is before the question opens or after close + grace, the player
 * is not in the room, or that player already answered this index (first write
 * wins per (playerId, index)).
 *
 * Scoring is the same in every kind, so cumulative totals stay comparable across
 * a lesson. What differs is what the round DOES with it: Cloud Climb reads
 * `step` (the correct count) and Treasure Dash reads `correctIndexes` to decide
 * who has earned a chest.
 */
export function answer(
  state: RoomState,
  playerId: string,
  index: number,
  choice: number,
  now: number
): RoomState {
  if (state.phase !== 'round' || !state.round) return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.questions.length) return state;

  const round = state.round;
  const question = state.questions[index];
  // A choice the question does not offer is not a wrong answer, it is not an
  // answer. Recording it as one let a raw API caller burn their single attempt
  // on choice 99 and read `correctChoice` out of the accepted reply without ever
  // picking something the UI displayed.
  if (!Number.isInteger(choice) || choice < 0 || choice >= question.choices.length) return state;

  const { opensAt, closesAt } = questionWindow(
    round.startsAt,
    round.slotMs,
    round.perQuestionMs,
    index
  );
  // Half-open, [opensAt, closesAt + GRACE_MS), and that is deliberate: the
  // projector releases the answer AT closesAt + GRACE_MS, so accepting an answer
  // on that same millisecond would let one child score off a word the room can
  // already read (round-2 review, SHOULD-FIX 2). One side has to be exclusive
  // and it is this one, because the reveal is the thing everybody can see.
  if (now < opensAt || now >= closesAt + GRACE_MS) return state;

  const playerIdx = state.players.findIndex((p) => p.id === playerId);
  if (playerIdx === -1) return state;

  const player = state.players[playerIdx];
  if (player.answeredIndexes.includes(index)) return state;

  // Server-computed elapsed time, clamped to the question's own budget so a
  // grace-period answer cannot score below zero or above the full bonus.
  const ms = Math.min(Math.max(now - opensAt, 0), round.perQuestionMs);

  const correct = choice === question.answer;
  const points = scoreAnswer(correct, ms, round.perQuestionMs);
  const correctCount = player.correct + (correct ? 1 : 0);

  const updatedPlayer: Player = {
    ...player,
    score: player.score + points,
    answered: player.answered + 1,
    correct: correctCount,
    totalMs: player.totalMs + ms,
    answeredIndexes: [...player.answeredIndexes, index],
    correctIndexes: correct ? [...player.correctIndexes, index] : player.correctIndexes,
    step: climbStepFor(correctCount),
  };

  const players = state.players.slice();
  players[playerIdx] = updatedPlayer;

  return { ...state, players, lastActivityAt: now, version: state.version + 1 };
}

/** The pick window a correct answer just opened, or undefined outside dash. */
export function pickWindowFor(
  state: RoomState,
  index: number
): { index: number; expiresAt: number } | undefined {
  if (!state.round || state.round.config.kind !== 'dash') return undefined;
  return { index, expiresAt: pickWindow(state.round, index).expiresAt };
}

export interface PickOutcome {
  state: RoomState;
  accepted: boolean;
  refusal?: Refusal;
  outcome?: ChestOutcome;
}

/**
 * Opens one chest in a Treasure Dash round. The rules live in
 * src/shared/round.ts; this wraps them in the room's bookkeeping.
 */
export function pick(
  state: RoomState,
  playerId: string,
  index: number,
  chest: number,
  now: number
): PickOutcome {
  if (state.phase !== 'round' || !state.round) {
    return { state, accepted: false, refusal: 'phase' };
  }

  const result = applyPick(state.players, state.round, playerId, index, chest, now);
  if (!result.accepted) {
    return { state, accepted: false, refusal: result.refusal };
  }

  return {
    state: {
      ...state,
      players: result.players,
      lastActivityAt: now,
      version: state.version + 1,
    },
    accepted: true,
    outcome: result.outcome,
  };
}

// --- ending a round ----------------------------------------------------------

/**
 * Writes the round's immutable result row, banks each player's round score into
 * their cumulative total, credits the winner, and moves to `results`.
 *
 * No-op in any other phase, so a result row is written exactly once and every
 * device that polls afterwards sees the same winner.
 */
export function endRound(state: RoomState, now: number): RoomState {
  if (state.phase !== 'round' || !state.round) return state;

  const round = state.round;
  const result = buildRoundResult(
    state.players,
    round.n,
    round.config.kind,
    round.questionCount,
    round.perQuestionMs,
    round.config.kind === 'tower' ? round.config.target : undefined
  );

  // The question cursor moves HERE, not at start, and only over the questions
  // whose window had opened by `now`. "End round now" two questions in costs
  // the room two words, not a whole lesson's worth (Codex round 2, MUST-FIX 1).
  const askedKeys = round.drawnFromCursor
    ? commitAsked(state.askedKeys ?? [], state.questions, openedQuestionCount(round, now))
    : (state.askedKeys ?? []);

  return {
    ...state,
    phase: 'results',
    round: { ...round, endedAt: now },
    pendingFinishAt: undefined,
    askedKeys,
    players: state.players.map((p) => ({
      ...p,
      total: p.total + p.score,
      wins: p.wins + (result.winnerId === p.id ? 1 : 0),
    })),
    history: [...state.history, result],
    lastActivityAt: now,
    version: state.version + 1,
  };
}

/**
 * The earliest instant the inactivity rule is allowed to end this round: 60s
 * after the last join/start/answer/pick, but never before the window a player
 * could still legally act in has shut (Codex round 1, SHOULD-FIX 1).
 *
 * The floor is what is new. `perQuestionMs` may be set as high as 60s, so a
 * class thinking hard about one slow question could cross the inactivity line
 * while their answer was still in time, and have the round closed underneath
 * them. Taking the later of the two means silence never discards a legal answer.
 *
 * Consequence, stated plainly because it is a behaviour change: while a round's
 * schedule is still running, each new slot pushes this floor forward, so an
 * abandoned round now runs to its schedule end rather than stopping 60s in. That
 * end is bounded (`questionCount * slotMs`), the results screen still closes
 * itself after 15 minutes idle, and the room still deletes itself at 2h. The
 * reviewer offered "rely on schedule end" as the alternative fix; this is that,
 * reached by the rule rather than by deleting it.
 */
export function inactivityFinishAt(state: RoomState, now: number): number | undefined {
  if (!state.round || state.phase !== 'round') return undefined;
  return Math.max(
    state.lastActivityAt + INACTIVITY_TIMEOUT_MS,
    currentWindowClosesAt(state.round, now)
  );
}

/**
 * Ends the round when any of the three finish conditions holds:
 *   1. every player answered every question (and, in dash, opened every chest
 *      they earned);
 *   2. the whole schedule has run out - this is what the DO's alarm triggers;
 *   3. 60s passed with no join/start/answer/pick AND the current question or
 *      pick window has closed (see inactivityFinishAt).
 *
 * Condition 1 does NOT end the round on the spot. A room where every child
 * answers every question used to flip to `results` on the last tap, which is
 * before the last question's reveal instant, and `revealedAnswerFor` refuses
 * outside `round`: the last word of the lesson was revealable at no time at all
 * (round-2 review, MUST-FIX 1). So an early finish is BOOKED, not taken:
 * `pendingFinishAt` is the instant the projector has had the last answer up for
 * its full pause, and the DO settles on it at its next poll or alarm.
 *
 * The other two conditions still end on the spot. Both of them already happen
 * at or after the end of the schedule, which includes that same pause.
 */
export function finishIfDone(state: RoomState, now: number): RoomState {
  if (state.phase !== 'round' || !state.round) return state;

  const round = state.round;
  const endsAt = scheduleEndsAt(state);
  const scheduleOver = endsAt !== undefined && now >= endsAt;
  const inactiveAt = inactivityFinishAt(state, now);
  const inactive = inactiveAt !== undefined && now >= inactiveAt;
  if (scheduleOver || inactive) return endRound(state, now);

  const allAnswered =
    state.players.length > 0 && state.players.every((p) => p.answered >= round.questionCount);

  // Sky Tower's own early finish: the class touched the cloud line. It is
  // BOOKED exactly like the all-answered case rather than taken on the spot,
  // and for the same reason: the answer that won the round is the last thing
  // the projector shows, and `revealedAnswerFor` refuses outside `round`. Take
  // it immediately and the winning word is the one word of the lesson that
  // could never be read out.
  const towerWon =
    round.config.kind === 'tower' && towerReached(state.players, round.config.target);
  // A dash round is not over while somebody still has a chest to open: their
  // last answer is in but their treasure has not been applied yet.
  const allPicked =
    round.config.kind !== 'dash' ||
    state.players.every((p) => p.pickedIndexes.length >= p.correctIndexes.length);

  // Nobody joins mid-round (see `join`) and nobody un-answers, so once a booking
  // is made it holds: there is no path back from here that has to unbook it.
  if (!((allAnswered && allPicked) || towerWon)) return state;

  // A room with no projector (solo, and the legacy "race a friend" shape) has
  // no reveal pause to protect, so it still ends the instant it is done.
  const pauseMs = revealPauseFor(round);
  if (pauseMs <= 0) return endRound(state, now);

  // Which question's reveal are we waiting on? The all-answered case waits on
  // the last one in the round; a tower win waits on the one that was open when
  // the winning block landed, because that is the word on the wall.
  const lastIndex = towerWon
    ? Math.max(0, openedQuestionCount(round, now) - 1)
    : round.questionCount - 1;
  const due =
    state.pendingFinishAt ?? Math.max(now, revealInstantFor(state, lastIndex)) + pauseMs;
  if (now >= due) return endRound(state, now);
  if (state.pendingFinishAt !== undefined) return state;
  return { ...state, pendingFinishAt: due, version: state.version + 1 };
}

/**
 * The host's "end this round now": the round stops where it is, the scores as
 * they stand become the result, and the room moves to `results` (Claude code
 * review round 1, MUST-FIX 5).
 *
 * Deliberately NOT `close`. Before this, the only button that stopped a round
 * was Finish, which is terminal, so a teacher who started the wrong game had to
 * destroy the room and make thirty children retype a code. This writes the
 * history row, keeps the roster, and leaves "pick another game" working.
 *
 * A no-op outside a round, which is what makes it safe to press twice.
 */
export function endNow(state: RoomState, now: number): RoomState {
  if (state.phase !== 'round') return state;
  return endRound(state, now);
}

/** Back to the lobby so the host can pick another game. Results-only. */
export function toLobby(state: RoomState, now: number): RoomState {
  if (state.phase !== 'results') return state;
  return { ...state, phase: 'lobby', lastActivityAt: now, version: state.version + 1 };
}

/**
 * The end of the lesson: every client stops polling (nextPollMs 0). A round
 * still in progress is ended first, so its result row is written and the
 * history is complete.
 */
export function close(state: RoomState, now: number): RoomState {
  if (state.phase === 'closed') return state;
  const ended = state.phase === 'round' ? endRound(state, now) : state;
  return { ...ended, phase: 'closed', lastActivityAt: now, version: ended.version + 1 };
}

/**
 * How long this room may sit doing nothing before it closes itself, or undefined
 * where the rule does not apply (a round has its own finish conditions, and a
 * closed room is already closed).
 */
export function idleLimitFor(phase: RoomPhase): number | undefined {
  if (phase === 'results') return RESULTS_IDLE_MS;
  if (phase === 'lobby') return LOBBY_IDLE_MS;
  return undefined;
}

/**
 * A room left sitting on the results screen (plan §1.8) or in the lobby (Claude
 * code review round 1, SHOULD-FIX 2) closes itself, which is what stops a class
 * of abandoned tabs polling a dead room until the 2h TTL.
 */
export function closeIfIdle(state: RoomState, now: number): RoomState {
  const limit = idleLimitFor(state.phase);
  if (limit === undefined) return state;
  if (now - state.lastActivityAt < limit) return state;
  return { ...state, phase: 'closed', lastActivityAt: now, version: state.version + 1 };
}

/**
 * Every clock-driven transition, in order. The DO calls this on each read so a
 * room converges without waiting for its alarm.
 */
export function settle(state: RoomState, now: number): RoomState {
  return closeIfIdle(finishIfDone(state, now), now);
}

/** When the DO should next wake this room up, or undefined if there is nothing due. */
export function nextDeadline(state: RoomState): number | undefined {
  if (state.phase === 'round') {
    const endsAt = scheduleEndsAt(state);
    // Wake at the inactivity deadline as it looks FROM that deadline, so the DO
    // does not wake early into a still-open window and find nothing to do.
    const nominal = state.lastActivityAt + INACTIVITY_TIMEOUT_MS;
    const inactivity = inactivityFinishAt(state, nominal) ?? nominal;
    const due = [inactivity, endsAt, state.pendingFinishAt].filter(
      (t): t is number => t !== undefined
    );
    // pendingFinishAt is the earliest of the three when a room finished early:
    // without it the DO would sleep past the booked flip and the class would sit
    // on a revealed last word until something else woke the room.
    return Math.min(...due);
  }
  const limit = idleLimitFor(state.phase);
  return limit === undefined ? undefined : state.lastActivityAt + limit;
}

// --- v1 compatibility --------------------------------------------------------

/**
 * The v1 `RoomResult`. Kept because a `model: 1` room still puts one on the wire
 * for week-1 clients, and because it is the shape `upgradeV1Meta` reads back.
 */
export function buildResult(
  players: Player[],
  questionCount: number,
  perQuestionMs: number
): RoomResult {
  const { winnerId, tie, ranking } = buildRoundResult(
    players,
    1,
    'race',
    questionCount,
    perQuestionMs
  );
  return { winnerId, tie, ranking };
}

