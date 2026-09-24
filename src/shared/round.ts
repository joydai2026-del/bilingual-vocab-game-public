// The rules that turn a scored answer into a visible thing.
//
// Design law 1 from docs/research/2026-09-08-game-templates.md: one question set,
// many shells. Every round kind reads the same QuizQuestion[] on the same fixed
// schedule; all that differs is the small reducer in this file. Race = points,
// Cloud Climb = a step, Treasure Dash = a chest pick.
//
// Everything here is pure: (state, ...) -> new state, no I/O, no Date.now(). The
// caller passes `now`, which in production is the Durable Object's own clock and
// never a client-supplied timestamp. That is what lets the solo path
// (src/client/games/local-room.ts) drive exactly the same rules as the DO.

import type {
  ChestOutcome,
  DashCard,
  DashConfig,
  DashWeights,
  Level,
  Player,
  RankingEntry,
  Refusal,
  Round,
  RoundConfig,
  RoundKind,
  RoundResult,
} from './types';
import { hashSeed, mulberry32 } from './rng';
import { ROOM_MIN_TARGET, ROUND_MS, roomTargetBlocks, type TowerLevel } from './sky-tower';

// --- timing ------------------------------------------------------------------

/** Feedback gap between questions, and the grace allowed on a late answer. */
export const GRACE_MS = 1_500;

/**
 * How long the right answer stays on the projector, big, before the next
 * question replaces it.
 *
 * This is a teaching pause, not a technical one, and it is the reason it exists
 * in the schedule at all. Until 2026-09-08 a race or climb slot was exactly
 * `perQuestionMs + GRACE_MS`, so the instant the server was willing to release
 * an answer was the same instant the next question opened. Two things followed,
 * both of which a class would notice and neither of which any test caught:
 *   - the last question of a round could never be revealed, because its release
 *     instant WAS the end of the schedule, when the room has already flipped to
 *     `results`;
 *   - the big `Answer:` line could only ever appear when every joined child had
 *     answered (the early-close shortcut), which in a class of thirty with one
 *     child not tapping is never. The teacher only ever saw the small grey
 *     `Last answer:` under the following question.
 * Giving the slot its own reveal pause fixes both with one number, and leaves
 * the safety rule in `revealedAnswerFor` exactly as it was.
 */
export const REVEAL_MS = 2_500;

/** Default chest-pick window. Lives in DashConfig so a round can retune it. */
export const DEFAULT_PICK_MS = 3_000;

/** Chests on the podium. Fixed at three: the card is `chests: 3`. */
export const DASH_CHESTS = 3;

/**
 * Weights are relative, not percentages: dashCardFor normalises by their sum.
 * Rare enough to be an event, common enough to fire twice in a 20-question round
 * (plan §1.6).
 */
export const DEFAULT_DASH_WEIGHTS: DashWeights = {
  points50: 40,
  points100: 35,
  points200: 15,
  swap: 4,
  steal: 6,
};

/**
 * One schedule step for a round of this kind.
 *
 * A slot is the question, then the grace on a late answer, then the tail in
 * which the answer is on the projector and nothing is scoreable. Race, Climb
 * and Tower are one action per question, so that tail is the reveal pause. Dash is two
 * actions in the same slot (answer, then open a chest), so its tail is the pick
 * window (amendment 1), which is already longer than the pause, and its slot is
 * unchanged.
 */
export function slotMsFor(
  kind: RoundKind,
  perQuestionMs: number,
  pickMs: number = DEFAULT_PICK_MS,
  revealMs: number = REVEAL_MS
): number {
  const tailMs = kind === 'dash' ? Math.max(revealMs, pickMs) : revealMs;
  return perQuestionMs + GRACE_MS + tailMs;
}

/**
 * The projector pause this round carries, in ms.
 *
 * A round started before this field existed is a teacher round on the old
 * unconditional tail, so it reads back as the full pause and finishes the way it
 * was scheduled (a room lives 2h, so that path stops mattering two hours after a
 * deploy).
 *
 * Zero is a room with nothing on a wall: solo, and the legacy "race a friend"
 * shape. Those reveal on the child's own device the instant she answers, so the
 * 2.5s pause bought them nothing and cost 30s on a 12-question game (round-2
 * review, SHOULD-FIX 3).
 */
export function revealPauseFor(round: { revealMs?: number }): number {
  return typeof round.revealMs === 'number' ? round.revealMs : REVEAL_MS;
}

/** The fixed open/close window for one question index. */
export function questionWindow(
  startsAt: number,
  slotMs: number,
  perQuestionMs: number,
  index: number
): { opensAt: number; closesAt: number } {
  const opensAt = startsAt + index * slotMs;
  return { opensAt, closesAt: opensAt + perQuestionMs };
}

/**
 * When the chest for question `index` may be opened.
 *
 * The window runs from the moment the question opens (you cannot pick before you
 * have answered it correctly anyway) to `pickMs` after the question closes. An
 * answer that lands inside the 1.5s grace therefore leaves less pick time, which
 * is the honest consequence of answering late rather than a separate penalty.
 */
export function pickWindow(
  round: Round,
  index: number
): { opensAt: number; expiresAt: number } {
  const pickMs = round.config.kind === 'dash' ? round.config.pickMs : 0;
  const opensAt = round.startsAt + index * round.slotMs;
  return { opensAt, expiresAt: opensAt + round.perQuestionMs + pickMs };
}

/**
 * The end of the slot the round is in at `now`: the moment the current
 * question's answer window, its grace, and (in dash) its chest-pick window have
 * ALL shut.
 *
 * This is the floor under the 60s inactivity finish (Codex round 1, SHOULD-FIX
 * 1). `perQuestionMs` is allowed up to 60s by the API, so a class working
 * quietly through one slow question could go 60s with nothing recorded and have
 * the round closed underneath them, discarding an answer that was still legal.
 * A round may now never end while a window a player could still act in is open.
 *
 * Clamped at both ends: before the round starts the first slot is the current
 * one, and after the last slot the answer is the schedule end.
 */
export function currentWindowClosesAt(round: Round, now: number): number {
  const raw = Math.floor((now - round.startsAt) / round.slotMs);
  const last = Math.max(0, round.questionCount - 1);
  const index = Math.min(Math.max(raw, 0), last);
  return round.startsAt + (index + 1) * round.slotMs;
}

// --- configuration -----------------------------------------------------------

/**
 * How long a round is, in questions.
 *
 * Week 2 shipped with no bound at all: a round asked every question
 * `buildQuestions` produced, up to two per set item. A 30-word class list was 60
 * questions (13 minutes of Cloud Climb, 16 of Treasure Dash) and a 200-word set
 * was 110 minutes, with `close()` the only way out. 12 is about four minutes,
 * which is a warm-up a teacher can run twice in a lesson; the 6..30 band is what
 * she may ask for instead.
 */
export const DEFAULT_QUESTIONS_PER_ROUND = 12;
export const MIN_QUESTIONS_PER_ROUND = 6;
export const MAX_QUESTIONS_PER_ROUND = 30;

/**
 * The requested round length, made safe. Anything absent or unusable becomes the
 * default; anything in range is kept; anything outside is pulled to the nearest
 * end.
 *
 * The API refuses an out-of-range number with a 400 rather than silently
 * clamping (see handleRoomAction in src/worker/index.ts). This is the second
 * line: the reducer is also reached by the solo path and by tests, and neither
 * goes through the router.
 */
export function clampQuestionsPerRound(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return DEFAULT_QUESTIONS_PER_ROUND;
  }
  const n = Math.round(requested);
  if (n < MIN_QUESTIONS_PER_ROUND) return MIN_QUESTIONS_PER_ROUND;
  if (n > MAX_QUESTIONS_PER_ROUND) return MAX_QUESTIONS_PER_ROUND;
  return n;
}

/**
 * The default config for a round of `kind` asking `questionCount` questions.
 *
 * `questionCount` is what the round WILL ask (the drawn count, which may be
 * smaller than the requested one on a small set), so `questionsPerRound` and
 * climb's `height` are both honest about the round in front of the class.
 */
/** The class clock on a Sky Tower round. Three minutes, per the spec. */
export const TOWER_CLOCK_MS = ROUND_MS;

/**
 * The set's level dial, in the words Sky Tower's own rules speak.
 *
 * The app grades a set as `kids` or `big`; Sky Tower scales its target by
 * `easy` / `normal` / `hard`. A kids set gets the short tower, which is the
 * only mapping the two vocabularies allow without inventing a third dial for a
 * teacher to have to find.
 */
export function towerLevelFor(level: Level): TowerLevel {
  return level === 'kids' ? 'easy' : 'normal';
}

/**
 * The share of questions a class is assumed to get right. Not a tuning knob for
 * difficulty: it is the honesty margin on the cloud line, so a class that plays
 * normally can finish rather than needing a perfect round.
 */
export const TOWER_ASSUMED_ACCURACY = 0.7;

/**
 * How many questions the class clock can actually open at this pacing.
 *
 * A question costs a whole slot (the question, the grace, the reveal tail), so
 * this is the honest count, not `clockMs / perQuestionMs`.
 */
export function towerQuestionsInClock(clockMs: number, slotMs: number): number {
  if (!Number.isFinite(slotMs) || slotMs <= 0) return 0;
  if (!Number.isFinite(clockMs) || clockMs <= 0) return 0;
  return Math.floor(clockMs / slotMs);
}

/**
 * How many blocks reach the cloud line in THIS room.
 *
 * Three a child scaled by the level dial, floored at six, capped by the 70%
 * accuracy formula, and THEN capped again by the hard ceiling of what the
 * clock can physically deliver (`openings x players`, one block per correct
 * answer):
 *
 *   target = min(max(6, min(rosterTarget, floor(openings x players x 0.7))), openings x players)
 *
 * The floor of six must never be applied AFTER the hard-ceiling cap, or a
 * pacing slow enough to open fewer than 6/players questions hands the class a
 * line nobody could reach even at 100%: one child at 60s a question opens only
 * 2 questions, so `max(6, ...)` alone produced a target of 6 against a hard
 * ceiling of 2 (panel round 2). Applying the hard ceiling LAST keeps the
 * floor's intent (a two-tap tower is not a tower) everywhere it is actually
 * reachable, while never exceeding what the clock allows. The final
 * `Math.max(1, ...)` is the last-resort floor for a clock so tight it opens
 * nothing.
 *
 * `clock` absent leaves the roster line alone, which is what every caller that
 * does not yet know the slot length gets.
 */
export function towerTargetFor(
  level: Level,
  playerCount: number,
  clock?: { clockMs: number; slotMs: number }
): number {
  const roster = roomTargetBlocks(towerLevelFor(level), playerCount);
  if (!clock) return roster;
  const opens = towerQuestionsInClock(clock.clockMs, clock.slotMs);
  const hardMax = opens * Math.max(0, playerCount);
  const reachable = Math.floor(hardMax * TOWER_ASSUMED_ACCURACY);
  const withFloor = Math.max(ROOM_MIN_TARGET, Math.min(roster, reachable));
  return Math.max(1, Math.min(withFloor, hardMax));
}

/** The class total: every child's correct answers, added up. This is the height. */
export function towerTotalOf(players: Pick<Player, 'correct'>[]): number {
  return players.reduce((sum, p) => sum + Math.max(0, p.correct), 0);
}

/** Has the class reached the cloud line? */
export function towerReached(players: Pick<Player, 'correct'>[], target: number): boolean {
  return towerTotalOf(players) >= target;
}

/**
 * Extra facts a round kind needs at start that the question count does not
 * carry. Only Sky Tower uses either: its target comes from the roster in the
 * lobby and the set's level, neither of which any other kind cares about.
 */
export interface ConfigContext {
  level: Level;
  playerCount: number;
  /**
   * One schedule step for this round, in ms. Sky Tower needs it to know how many
   * questions its 3 minute clock can open, and therefore how high a line the
   * class can actually reach. Absent leaves the target on the roster alone.
   */
  slotMs?: number;
}

export function configFor(
  kind: RoundKind,
  questionCount: number,
  context?: ConfigContext
): RoundConfig {
  if (kind === 'tower') {
    return {
      kind: 'tower',
      target: towerTargetFor(
        context?.level ?? 'big',
        context?.playerCount ?? 0,
        context?.slotMs === undefined
          ? undefined
          : { clockMs: TOWER_CLOCK_MS, slotMs: context.slotMs }
      ),
      clockMs: TOWER_CLOCK_MS,
      questionsPerRound: questionCount,
    };
  }
  if (kind === 'climb') {
    return { kind: 'climb', height: questionCount, questionsPerRound: questionCount };
  }
  if (kind === 'dash') {
    return {
      kind: 'dash',
      chests: DASH_CHESTS,
      pickMs: DEFAULT_PICK_MS,
      weights: { ...DEFAULT_DASH_WEIGHTS },
      questionsPerRound: questionCount,
    };
  }
  return { kind: 'race', questionsPerRound: questionCount };
}

// --- Cloud Climb -------------------------------------------------------------

/**
 * Cloud Climb's whole rule: a bean's platform is how many questions it has got
 * right. A wrong answer is a stumble, which is an animation and nothing else, so
 * last place keeps playing (design law 2). `stunSlots` was cut for week 2, so
 * there is no state to carry between questions and no way for the tower ordering
 * to drift out of step with the score ordering.
 */
export function climbStepFor(correct: number): number {
  return correct;
}

// --- Treasure Dash: what is in the chest -------------------------------------

const CARD_ORDER: DashCard[] = ['points50', 'points100', 'points200', 'swap', 'steal'];

export const CARD_POINTS: Record<'points50' | 'points100' | 'points200', number> = {
  points50: 50,
  points100: 100,
  points200: 200,
};

/** What a swap or steal pays when there is nobody to swap or steal from. */
export const CONSOLATION_POINTS = 100;

/**
 * What chest `chest` holds for `playerId` at question `index`.
 *
 * Pure and seeded, so all three chests already hold a card before anybody picks:
 * picking chooses which one you get, it does not roll one. Because `seed` is an
 * opaque secret stripped from the wire (amendment 5), a client cannot pre-read
 * the good chest, and because the function is total it cannot be re-rolled by
 * retrying.
 */
export function dashCardFor(
  seed: string,
  playerId: string,
  index: number,
  chest: number,
  weights: DashWeights = DEFAULT_DASH_WEIGHTS
): DashCard {
  const roll = mulberry32(hashSeed(`${seed}:${playerId}:${index}:${chest}`))();

  let total = 0;
  for (const card of CARD_ORDER) total += Math.max(0, weights[card]);
  // A weight set that sums to zero is a config error, not a crash: fall back to
  // the smallest card rather than dividing by zero.
  if (total <= 0) return 'points50';

  let cursor = roll * total;
  for (const card of CARD_ORDER) {
    cursor -= Math.max(0, weights[card]);
    if (cursor < 0) return card;
  }
  return CARD_ORDER[CARD_ORDER.length - 1];
}

// --- ranking -----------------------------------------------------------------

/**
 * The time a player is ranked on: what they actually spent, plus the FULL
 * per-question budget for every question they never answered.
 *
 * Without that top-up the tie-break rewarded answering fewer questions. Worked
 * example on a 4-question race: A answers all four (two right at 4000ms, two
 * wrong at 100ms) for score 300 and 8200ms; B answers only two, both right at
 * 4000ms, for score 300 and 8000ms. On raw totalMs B wins having played half the
 * game. Charging B the full 8000ms budget for the two skipped questions makes it
 * 16000ms and A wins, which is the honest result.
 */
export function rankingMsFor(player: Player, questionCount: number, perQuestionMs: number): number {
  const unanswered = Math.max(0, questionCount - player.answered);
  return player.totalMs + unanswered * perQuestionMs;
}

/**
 * Who is currently winning, by live score and then by lower ranking time.
 *
 * This is the target a Swap exchanges with and a Steal takes from, so it has to
 * be a total order with no coin flips: an unstable leader would make the same
 * seeded chest do two different things.
 */
export function leaderIndexOf(
  players: Player[],
  questionCount: number,
  perQuestionMs: number
): number {
  let best = -1;
  for (let i = 0; i < players.length; i++) {
    if (best === -1) {
      best = i;
      continue;
    }
    const a = players[i];
    const b = players[best];
    if (a.score !== b.score) {
      if (a.score > b.score) best = i;
      continue;
    }
    const aMs = rankingMsFor(a, questionCount, perQuestionMs);
    const bMs = rankingMsFor(b, questionCount, perQuestionMs);
    if (aMs < bMs) best = i;
  }
  return best;
}

/**
 * One ranking row per player.
 *
 * Two orderings, one per game family:
 *   climb  `step` desc, then `totalMs` asc. Score is NOT a key at all.
 *   race / dash  `score` desc, then `totalMs` asc.
 *
 * Cloud Climb's keys are exactly the two things the tower shows: how high the
 * bean got, and how fast it got there (Codex round 1, MUST-FIX 4). Score used to
 * sit between them, which meant the result screen could order two beans
 * differently from the tower they had just watched. The plan's contract is
 * `step` then `rankingMs`, and this is now that and nothing else.
 */
export function buildRanking(
  players: Player[],
  questionCount: number,
  perQuestionMs: number,
  kind: RoundKind
): RankingEntry[] {
  return players
    .map((p) => {
      const entry: RankingEntry = {
        playerId: p.id,
        name: p.name,
        score: p.score,
        totalMs: rankingMsFor(p, questionCount, perQuestionMs),
      };
      if (kind === 'climb') entry.step = p.step;
      // A tower round is co-operative, so this is a contribution list rather
      // than a leaderboard: it is ordered, because a list has to be, and it
      // goes to the teacher's screen and not to the children's.
      if (kind === 'tower') entry.correct = p.correct;
      return entry;
    })
    .sort((a, b) => {
      // Cloud Climb ranks on the tower and the clock, and on nothing else, so
      // what the screen shows and what the sort uses can never disagree.
      if (kind === 'climb') {
        if ((a.step ?? 0) !== (b.step ?? 0)) return (b.step ?? 0) - (a.step ?? 0);
        return a.totalMs - b.totalMs;
      }
      if (kind === 'tower') {
        if ((a.correct ?? 0) !== (b.correct ?? 0)) return (b.correct ?? 0) - (a.correct ?? 0);
        return a.totalMs - b.totalMs;
      }
      if (b.score !== a.score) return b.score - a.score;
      return a.totalMs - b.totalMs;
    });
}

/**
 * Final standings for one round. A tie means the top two share every key that
 * decides the order, and then there is no single winner (winnerId null) and the
 * client shows both.
 *
 * "Every key that decides the order" is per kind, and must be the SAME keys
 * buildRanking sorted on. A climb tie is `step` and `totalMs`; two beans on the
 * same cloud at the same pace tie however far apart their points are.
 */
export function buildRoundResult(
  players: Player[],
  n: number,
  kind: RoundKind,
  questionCount: number,
  perQuestionMs: number,
  towerTarget?: number
): RoundResult {
  const ranking = buildRanking(players, questionCount, perQuestionMs, kind);

  // Sky Tower has no winner and no tie, because the class either got there or
  // it did not. Giving it a `winnerId` would credit one child with a round
  // everybody built, and `endRound` banks a win on that field.
  if (kind === 'tower') {
    return {
      n,
      kind,
      winnerId: null,
      tie: false,
      ranking,
      won: towerReached(players, towerTarget ?? Number.POSITIVE_INFINITY),
    };
  }

  if (ranking.length === 0) return { n, kind, winnerId: null, tie: false, ranking };

  const [first, second] = ranking;
  const tie =
    ranking.length > 1 &&
    first.totalMs === second.totalMs &&
    (kind === 'climb'
      ? (first.step ?? 0) === (second.step ?? 0)
      : first.score === second.score);

  return { n, kind, winnerId: tie ? null : first.playerId, tie, ranking };
}

// --- Treasure Dash: applying a pick ------------------------------------------

export interface PickResult {
  players: Player[];
  accepted: boolean;
  refusal?: Refusal;
  outcome?: ChestOutcome;
}

function refuse(players: Player[], refusal: Refusal): PickResult {
  // No outcome field at all, not an undefined one: a refused pick must reveal
  // nothing about what was in the chest (plan §1.12).
  return { players, accepted: false, refusal };
}

/**
 * Opens one chest.
 *
 * Accepted only when the player is in the room, the chest and index are in
 * range, the player got that question RIGHT (amendment 2 - a wrong answer earns
 * no treasure), the pick window is open, and they have not already opened that
 * question's chest. First write wins per (playerId, index), exactly like an
 * answer.
 *
 * Swap and Steal touch two players. They are applied here as one pure transform
 * over the whole roster, and the DO applies them inside a single fetch with no
 * non-storage await in between, so two picks arriving in the same tick apply in
 * arrival order, each against the state as it stands when applied.
 *
 * Both are zero-sum by construction, which is the property the tests assert: a
 * swap exchanges two numbers and a steal moves `floor(target/2)` from one player
 * to another, so the total of all scores is unchanged by either.
 */
export function applyPick(
  players: Player[],
  round: Round,
  playerId: string,
  index: number,
  chest: number,
  now: number
): PickResult {
  if (round.config.kind !== 'dash') return refuse(players, 'phase');
  const config: DashConfig = round.config;

  if (!Number.isInteger(chest) || chest < 0 || chest >= config.chests) {
    return refuse(players, 'unknown');
  }
  if (!Number.isInteger(index) || index < 0 || index >= round.questionCount) {
    return refuse(players, 'unknown');
  }

  const pickerIdx = players.findIndex((p) => p.id === playerId);
  if (pickerIdx === -1) return refuse(players, 'unknown');

  const picker = players[pickerIdx];
  if (!picker.correctIndexes.includes(index)) return refuse(players, 'unearned');
  if (picker.pickedIndexes.includes(index)) return refuse(players, 'duplicate');

  const { opensAt, expiresAt } = pickWindow(round, index);
  if (now < opensAt || now > expiresAt) return refuse(players, 'window');

  const card = dashCardFor(round.seed, playerId, index, chest, config.weights);
  const next = players.map((p) => ({ ...p }));
  next[pickerIdx] = { ...next[pickerIdx], pickedIndexes: [...picker.pickedIndexes, index] };

  const outcome = applyCard(next, pickerIdx, card, round);
  return { players: next, accepted: true, outcome };
}

/**
 * Mutates `players` (already a fresh copy) to apply one card, and says what it
 * did.
 *
 * The picker being the current leader is the one case both zero-sum cards have
 * to special-case: swapping or stealing from yourself is a no-op, and a chest
 * that does nothing is a dud. Both pay CONSOLATION_POINTS instead, so every
 * chest is worth opening (plan §1.6).
 */
function applyCard(
  players: Player[],
  pickerIdx: number,
  card: DashCard,
  round: Round
): ChestOutcome {
  if (card === 'points50' || card === 'points100' || card === 'points200') {
    const points = CARD_POINTS[card];
    players[pickerIdx].score += points;
    return { kind: 'points', points };
  }

  const leaderIdx = leaderIndexOf(players, round.questionCount, round.perQuestionMs);
  if (leaderIdx === -1 || leaderIdx === pickerIdx) {
    players[pickerIdx].score += CONSOLATION_POINTS;
    return { kind: 'points', points: CONSOLATION_POINTS };
  }

  const picker = players[pickerIdx];
  const leader = players[leaderIdx];

  if (card === 'swap') {
    const before = picker.score;
    const after = leader.score;
    picker.score = after;
    leader.score = before;
    return { kind: 'swap', withPlayerId: leader.id, before, after };
  }

  // steal
  const stolen = Math.floor(leader.score / 2);
  leader.score -= stolen;
  picker.score += stolen;
  return { kind: 'steal', fromPlayerId: leader.id, points: stolen };
}

