// The teacher's screen: `#/host/:code`, the one that gets projected.
//
// It is not a player. It holds the room's host key (minted once at create,
// stored on this device only) and it is the only screen that can start a round,
// send the room back to the lobby, or finish the lesson. It never shows an
// answer button, because the teacher is not answering.
//
// Everything it draws comes from the room state the server sends every second.
// It computes which question is open from the server's own clock, exactly the
// way a student's device does, so the projector and thirty iPads agree.

import { DEFAULT_QUESTIONS_PER_ROUND, GRACE_MS, towerTotalOf } from '../../shared/round';
import { ROOM_MODEL, type RankingEntry, type RoundKind } from '../../shared/types';
import { formatClock } from '../../shared/sky-tower';
import { applyLevel } from '../controls';
import { navigate } from '../router';
import { createBoard, type Board, type BoardPlayer } from '../scene/board';
import { createTowerBoard, type TowerBoard } from '../room/tower-board';
import { beanColor } from '../scene/palette';
import { absoluteUrl, copyButton, h, notice, screen } from '../ui';
import {
  backToLobby,
  closeRoom,
  endRound,
  isNotSignedIn,
  revealAnswer,
  RoomError,
  serverTime,
  startRound,
  type RoomEnvelope,
  type RoomStateWire,
} from '../room/api';
import { startPolling } from '../room/poll';
import { rankingCell, type RankingCell } from '../room/ranking';
import { bindHostRoom, forgetHostKey, readHostSession } from '../room/session';

type Phase = 'none' | 'lobby' | 'round' | 'results' | 'closed' | 'stale';

interface GameSpec {
  kind: RoundKind;
  title: string;
  why: string;
}

const GAMES: GameSpec[] = [
  {
    kind: 'climb',
    title: 'Cloud Climb',
    why: 'Every right answer hops your bean up one cloud. The tower is the scoreboard.',
  },
  {
    kind: 'tower',
    title: 'Sky Tower',
    why: 'One tower, built by the whole class. Every right answer anywhere adds a block.',
  },
  {
    kind: 'dash',
    title: 'Treasure Dash',
    why: 'Answer, then open one of three chests. Some hold points. A rare one steals or swaps.',
  },
  {
    kind: 'race',
    title: 'Race Quiz',
    why: 'Four choices and a timer. Fastest right answer scores most.',
  },
];

/**
 * How long a round is, in questions. The server clamps to 6..30 and defaults to
 * DEFAULT_QUESTIONS_PER_ROUND, so these are four points inside that range and
 * not a second opinion about it: a warm-up, a normal round, a long one, and the
 * whole lesson's worth.
 *
 * Before this existed a round asked every question the set could produce, which
 * is two per word: a 30-word class list ran 13 minutes with no way out
 * (Codex round 1, MUST-FIX 5).
 */
const ROUND_LENGTHS: { count: number; label: string }[] = [
  { count: 6, label: 'Quick' },
  { count: DEFAULT_QUESTIONS_PER_ROUND, label: 'Normal' },
  { count: 20, label: 'Long' },
  { count: 30, label: 'Longest' },
];

/**
 * The projected round view, in px. `HOST_GAP` is the `.host` flex gap and
 * `PROJECTOR_PAD` the breathing room under the buttons; both are only used to
 * work out what is left for the board, never to draw anything.
 */
const HOST_GAP = 16;
const PROJECTOR_PAD = 16;
/** A board shorter than this is not a board; the page may scroll instead. */
const BOARD_MIN_H = 200;
/** Taller than this and the tower reads as a wall on a big screen. */
const BOARD_MAX_H = 560;

/** What each player looked like last poll, so a change can be animated once. */
interface Trace {
  step: number;
  answered: number;
  correct: number;
  picked: number;
  score: number;
}

export function renderHost(root: HTMLElement, code: string): () => void {
  const { root: page, body } = screen(`Class room ${code}`, { back: '#/' });
  const stage = h('div', { class: 'host' });
  const problem = h('div');
  body.append(stage, problem);
  root.replaceChildren(page);

  const session = readHostSession(code);
  const hostKey = session?.hostKey ?? null;
  // The room this key was minted for, or 0 if this device has not seen the
  // room yet. Room codes are handed back out once a room expires, so the key
  // alone does not prove ownership (Codex round 1, SHOULD-FIX 2).
  let boundTo = session?.createdAt ?? 0;
  if (!hostKey) {
    stage.replaceChildren(
      notice(
        `This device is not the teacher for room ${code}. The teacher screen only ` +
          'works on the device that made the room.',
        'warn'
      ),
      homeRow('Make a new room')
    );
    return () => undefined;
  }

  let state: RoomStateWire | null = null;
  let version: number | undefined;
  let phase: Phase = 'none';
  let roundKey = '';
  let disposed = false;
  let stopPoll: (() => void) | null = null;
  let board: Board | null = null;
  let boardGeneration = 0;
  let tickTimer = 0;
  let traces = new Map<string, Trace>();
  /**
   * The class tower, when a tower round is running. It is a separate handle
   * from `board` rather than another Board implementation because it answers a
   * different question: a Board is one bean per child, and this is one stack
   * for everybody.
   */
  let towerBoard: TowerBoard | null = null;
  /** The two lines only a tower round draws: the clock, and who built what. */
  let towerClockOut: HTMLElement | null = null;
  let towerTallyOut: HTMLElement | null = null;
  let towerFinished = false;
  /** The kind the picker is set to. Also what "Play again" restarts. */
  let chosenKind: RoundKind = 'climb';
  /** How many questions the next round asks. Also what "Play again" reuses. */
  let chosenCount = DEFAULT_QUESTIONS_PER_ROUND;

  // Live nodes owned by whichever phase is on screen.
  let boardSlot: HTMLElement | null = null;
  let promptBox: HTMLElement | null = null;
  /** How many players the results screen was drawn for (D2 late joins). */
  let resultsRoster = -1;
  /** Answers this round's shut questions, as the server released them (D3). */
  const revealed = new Map<number, string>();
  /** Reveal requests in flight, so one shut question is asked for once. */
  const asking = new Set<number>();
  /**
   * Set once the server has said this device is not the host of this room.
   * The tick runs five times a second, and the retry-on-failure that makes a
   * network blip harmless also made a 403 a loop that never ends: a projector
   * with a stale key would POST reveal for the whole round and never learn why.
   * No retry can fix a wrong key, so the first 403 stops the asking for good.
   */
  let revealRefused = false;
  /** The most recent answer the room has finished with, kept on the projector. */
  let lastRevealed: { prompt: string; answer: string } | null = null;
  let counterOut: HTMLElement | null = null;
  /** The round's button row, which the board must not sit on top of. */
  let controlsBox: HTMLElement | null = null;
  /** The prompt's last measured height: it decides how much is left over. */
  let promptHeight = -1;
  let rosterBox: HTMLElement | null = null;
  let startButton: HTMLButtonElement | null = null;
  let waitLine: HTMLElement | null = null;

  const teardown = (): void => {
    disposed = true;
    stopPoll?.();
    stopPoll = null;
    window.clearInterval(tickTimer);
    setProjecting(false);
    board?.dispose();
    board = null;
  };

  /**
   * Gives the projected board exactly the height the screen has left.
   *
   * A 1280x800 projector is the common classroom one, and a fixed `54vh` board
   * ran off the bottom of it: the beans stand on the ground row at the start of
   * every round, so the first thing the class saw was a row of half-cut name
   * tags and a page the teacher had to scroll. The height is measured from
   * where the board actually starts, so a prompt that wraps to two lines takes
   * its space out of the board rather than out of the screen.
   */
  /**
   * The projected round view owns the whole screen: no page scroll under the
   * buttons, and the board sized to what is left. Every other phase (lobby,
   * results, a closed room) is an ordinary page again.
   */
  function setProjecting(on: boolean): void {
    document.body.classList.toggle('projecting', on);
    window.removeEventListener('resize', fitBoard);
    if (on) window.addEventListener('resize', fitBoard);
  }

  /** The prompt is the only thing above the board whose height changes. */
  function keepBoardFitted(): void {
    if (!promptBox) return;
    const height = promptBox.offsetHeight;
    if (height === promptHeight) return;
    promptHeight = height;
    fitBoard();
  }

  function fitBoard(): void {
    if (disposed || phase !== 'round' || !boardSlot) return;
    const bounded = (px: number): number =>
      Math.max(BOARD_MIN_H, Math.min(BOARD_MAX_H, Math.round(px)));

    const top = boardSlot.getBoundingClientRect().top;
    const below = controlsBox ? controlsBox.getBoundingClientRect().height + HOST_GAP : 0;
    let height = bounded(window.innerHeight - top - below - PROJECTOR_PAD);
    boardSlot.style.setProperty('--board-h', `${height}px`);

    // Whatever else the page carries under the buttons comes out of the board
    // too: the CC-CEDICT licence line is a footer outside #app that has to stay
    // visible, and it was the last 64px of scroll on a 1280x800 projector.
    // Shrinking the board shrinks the page one for one, so one pass settles it.
    const over = document.documentElement.scrollHeight - window.innerHeight;
    if (over > 0) {
      height = bounded(height - over);
      boardSlot.style.setProperty('--board-h', `${height}px`);
    }
    board?.resize();
    towerBoard?.resize();
  }

  function homeRow(label: string): HTMLElement {
    const button = h('button', { class: 'btn btn-primary', type: 'button', text: label });
    button.addEventListener('click', () => navigate('#/'));
    return h('div', { class: 'row' }, [button]);
  }

  function showError(message: string): void {
    problem.replaceChildren(notice(message, 'error'));
  }

  /**
   * What a host action's 403 means, and the only thing it can mean: the key on
   * this device is not this room's key. The room may have expired and handed
   * its four letters to somebody else, or the key may have been cleared on the
   * server. Either way no retry helps, so the key goes and this device becomes
   * an ordinary joiner rather than sitting on a projector whose every button
   * fails (Codex round 2, SHOULD 1).
   *
   * Returns true when it handled the error, so each button's catch can stop.
   */
  function lostTheRoom(error: unknown): boolean {
    if (!isNotSignedIn(error)) return false;
    forgetHostKey(code);
    teardown();
    navigate(`#/room/${code}`);
    return true;
  }

  // ---------- the board ----------

  /**
   * Beans, in roster order. The colour is the player's position in the roster,
   * which the server only ever appends to, so a bean keeps its colour for the
   * whole lesson.
   */
  function beansOf(source: RoomStateWire): BoardPlayer[] {
    return source.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      colorIndex: index,
      step: player.step ?? 0,
      score: player.score ?? 0,
      isMe: false,
    }));
  }

  /**
   * Builds the board for the current round (or the lobby's idle one) and hands
   * it the roster. Rebuilding is async, so a second call while the first is in
   * flight wins and the loser throws its board away rather than leaving two.
   */
  /**
   * The class tower. Same generation guard as `buildBoard`: mounting a 3D
   * scene is async, so a second call while the first is in flight wins.
   */
  async function buildTower(target: number): Promise<void> {
    const mine = ++boardGeneration;
    board?.dispose();
    board = null;
    towerBoard?.dispose();
    towerBoard = null;
    if (!boardSlot) return;
    const next = await createTowerBoard(boardSlot, { target: Math.max(1, target) });
    if (disposed || mine !== boardGeneration) {
      next.dispose();
      return;
    }
    towerBoard = next;
    if (state) next.update(contributorsOf(state));
    fitBoard();
  }

  /** The roster as the tower reads it: a colour and a count per child. */
  function contributorsOf(source: RoomStateWire) {
    return source.players.map((player, index) => ({
      id: player.id,
      colorIndex: index,
      correct: player.correct ?? 0,
    }));
  }

  async function buildBoard(kind: 'climb' | 'dash', height: number, lobby: boolean): Promise<void> {
    const mine = ++boardGeneration;
    board?.dispose();
    board = null;
    towerBoard?.dispose();
    towerBoard = null;
    if (!boardSlot) return;
    const next = await createBoard(boardSlot, kind, { height, compact: false });
    if (disposed || mine !== boardGeneration) {
      next.dispose();
      return;
    }
    board = next;
    if (lobby) board.node.classList.add('board--lobby');
    if (state) {
      board.setPlayers(beansOf(state));
      traces = traceOf(state);
    }
    if (!lobby) fitBoard();
  }

  function traceOf(source: RoomStateWire): Map<string, Trace> {
    return new Map(
      source.players.map((player) => [
        player.id,
        {
          step: player.step ?? 0,
          answered: player.answered ?? 0,
          correct: player.correct ?? 0,
          picked: player.pickedIndexes?.length ?? 0,
          score: player.score ?? 0,
        },
      ])
    );
  }

  /**
   * Plays what changed since the last poll.
   *
   * A hop and a stumble are unambiguous: `correct` went up, or `answered` went
   * up and `correct` did not. A chest is not, because only the device that
   * opened it is ever told what was inside. So the projector shows the one
   * thing the room state really knows, which is the change to the scoreboard.
   */
  function animateDelta(next: RoomStateWire): void {
    if (!board) return;
    for (const player of next.players) {
      const before = traces.get(player.id);
      if (!before) continue;
      const step = player.step ?? 0;
      const correct = player.correct ?? 0;
      const answered = player.answered ?? 0;
      const picked = player.pickedIndexes?.length ?? 0;
      const score = player.score ?? 0;

      if (step > before.step) board.hop(player.id, step);
      else if (answered > before.answered && correct === before.correct) {
        board.stumble(player.id);
      }

      if (picked > before.picked) {
        const delta = score - before.score;
        if (delta > 0) board.badge(player.id, `+${delta}`, 'good');
        else if (delta < 0) board.badge(player.id, String(delta), 'steal');
        else board.badge(player.id, 'Chest!', 'swap');
      } else if (score < before.score) {
        // Nothing this player did: somebody else's chest took from them.
        board.badge(player.id, String(score - before.score), 'steal');
      }
    }
    traces = traceOf(next);
  }

  // ---------- lobby ----------

  function paintLobbyShell(): void {
    setProjecting(false);
    phase = 'lobby';
    window.clearInterval(tickTimer);
    boardSlot = h('div', { class: 'host-board host-board--lobby' });
    rosterBox = h('p', { class: 'host-roster' });
    waitLine = h('p', { class: 'hint' });
    startButton = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Start',
    });
    startButton.addEventListener('click', () => {
      problem.replaceChildren();
      startButton!.disabled = true;
      startButton!.textContent = 'Starting...';
      void startRound(code, { hostKey }, {
        kind: chosenKind,
        questionsPerRound: chosenCount,
      })
        .then(absorbEnvelope)
        .catch((error: Error) => {
          if (lostTheRoom(error)) return;
          startButton!.disabled = false;
          startButton!.textContent = 'Start';
          showError(error.message);
        });
    });

    const picker = h('div', { class: 'host-picker' });
    const paintPicker = (): void => {
      picker.replaceChildren(
        ...GAMES.map((game) => {
          const card = h('button', {
            class: `host-game ${game.kind === chosenKind ? 'host-game--on' : ''}`.trim(),
            type: 'button',
            'aria-pressed': String(game.kind === chosenKind),
          });
          card.append(
            h('span', { class: 'host-game-title', text: game.title }),
            h('span', { class: 'host-game-why', text: game.why })
          );
          card.addEventListener('click', () => {
            chosenKind = game.kind;
            paintPicker();
          });
          return card;
        })
      );
    };
    paintPicker();

    // How long the round is. A teacher sets it before the class starts, not
    // by watching the clock and hoping (Codex round 1, MUST-FIX 5).
    const lengths = h('div', { class: 'host-lengths' });
    const paintLengths = (): void => {
      lengths.replaceChildren(
        ...ROUND_LENGTHS.map((option) => {
          const button = h('button', {
            class: `host-length ${option.count === chosenCount ? 'host-length--on' : ''}`.trim(),
            type: 'button',
            'aria-pressed': String(option.count === chosenCount),
          });
          button.append(
            h('span', { class: 'host-length-count', text: String(option.count) }),
            h('span', { class: 'host-length-label', text: option.label })
          );
          button.addEventListener('click', () => {
            chosenCount = option.count;
            paintLengths();
          });
          return button;
        })
      );
    };
    paintLengths();

    stage.replaceChildren(
      h('div', { class: 'host-code-panel' }, [
        h('p', { class: 'host-code-lead', text: 'Join at this screen’s address with the code' }),
        h('div', { class: 'host-code', text: code }),
        h('div', { class: 'row' }, [
          copyButton('Copy the join link', () => absoluteUrl(`#/room/${code}`)),
        ]),
      ]),
      boardSlot,
      rosterBox,
      h('h2', { text: 'Pick a game' }),
      picker,
      h('h2', { text: 'Questions this round' }),
      lengths,
      waitLine,
      h('div', { class: 'row' }, [startButton])
    );

    void buildBoard('dash', 1, true);
  }

  function paintLobby(): void {
    if (phase !== 'lobby') paintLobbyShell();
    if (!state || !rosterBox || !waitLine || !startButton) return;

    const names = state.players.map((player) => player.name);
    rosterBox.textContent =
      names.length === 0
        ? 'Nobody has joined yet.'
        : `${names.length} ${names.length === 1 ? 'player' : 'players'}: ${names.join(', ')}`;

    const enough = state.players.length >= 1;
    startButton.disabled = !enough;
    waitLine.textContent = enough
      ? 'Everyone in? Pick a game and tap Start.'
      : 'Waiting for the first player to join.';

    board?.setPlayers(beansOf(state));
  }

  // ---------- a round ----------

  function paintRoundShell(): void {
    if (!state?.round) return;
    phase = 'round';
    const round = state.round;
    roundKey = `${round.n}:${round.config.kind}`;

    revealed.clear();
    asking.clear();
    lastRevealed = null;
    boardSlot = h('div', { class: 'host-board host-board--round' });
    promptBox = h('div', { class: 'host-prompt' });
    counterOut = h('p', { class: 'host-counter' });

    // Two very different buttons, side by side and clearly labelled. "End round
    // now" keeps the class: it stops the questions, keeps the scores and shows
    // the results. "Finish" ends the lesson for every device in the room and
    // cannot be undone, so it asks first (Codex round 1, MUST-FIX 5).
    const controls = h('div', { class: 'row row-end' });
    controlsBox = controls;
    const endNow = h('button', { class: 'btn', type: 'button', text: 'End round now' });
    endNow.addEventListener('click', () => {
      problem.replaceChildren();
      endNow.disabled = true;
      endNow.textContent = 'Ending...';
      void endRound(code, { hostKey })
        .then(absorbEnvelope)
        .catch((error: Error) => {
          if (lostTheRoom(error)) return;
          endNow.disabled = false;
          endNow.textContent = 'End round now';
          showError(error.message);
        });
    });
    controls.append(endNow, finishButton(controls));

    towerClockOut = null;
    towerTallyOut = null;
    towerFinished = false;
    const head = h('div', { class: 'host-round-head' }, [
      h('span', { class: 'host-round-name', text: titleFor(round.config.kind) }),
      h('span', { class: 'host-round-n', text: `Round ${round.n}` }),
      counterOut,
      h('span', { class: 'host-round-code', text: `Room ${code}` }),
    ]);
    let stack: HTMLElement = boardSlot;
    if (round.config.kind === 'tower') {
      // The clock is a Sky Tower rule (three minutes), so it goes where the
      // class can read it, next to the tower rather than in the head.
      towerClockOut = h('span', { class: 'host-tower-clock', text: '3:00' });
      towerTallyOut = h('ul', { class: 'host-tower-tally' });
      head.append(h('span', { class: 'host-round-goal', text: `Goal ${round.config.target} blocks` }));
      stack = h('div', { class: 'host-tower-row' }, [
        boardSlot,
        h('aside', { class: 'host-tower-side' }, [
          towerClockOut,
          h('p', { class: 'host-tower-side-head', text: 'Blocks built' }),
          towerTallyOut,
        ]),
      ]);
    }

    stage.replaceChildren(head, promptBox, stack, controls);

    // The round is the one thing that has to fit a projector in one screenful.
    setProjecting(true);
    promptHeight = -1;

    if (round.config.kind === 'tower') {
      void buildTower(round.config.target);
    } else {
      const kind = round.config.kind === 'dash' ? 'dash' : 'climb';
      const height = round.config.kind === 'climb' ? round.config.height : round.questionCount;
      void buildBoard(kind, Math.max(1, height), false);
    }

    window.clearInterval(tickTimer);
    tickTimer = window.setInterval(tickRound, 200);
    tickRound();
  }

  /** Which question is open right now, from the server's clock. */
  function tickRound(): void {
    if (!state?.round || !promptBox || !counterOut) return;
    const round = state.round;
    const elapsed = serverTime() - round.startsAt;

    if (elapsed < 0) {
      const seconds = Math.max(1, Math.ceil(-elapsed / 1000));
      counterOut.textContent = 'Get ready';
      promptBox.replaceChildren(h('div', { class: 'host-count', text: String(seconds) }));
      keepBoardFitted();
      return;
    }

    const index = Math.floor(elapsed / round.slotMs);
    if (index >= state.questions.length) {
      counterOut.textContent = 'Last one in...';
      promptBox.replaceChildren(h('div', { class: 'host-count', text: '⏳' }));
      keepBoardFitted();
      return;
    }

    const question = state.questions[index];
    counterOut.textContent = `Question ${index + 1} of ${state.questions.length}`;
    const open = elapsed - index * round.slotMs < round.perQuestionMs;
    // The answer to the question that is shut, and after it the last answer the
    // room saw, which stays up while the next question runs. The shut part of a
    // slot is only the answering grace, so a teacher who blinked would otherwise
    // never read it, and a finished question cannot leak anything.
    const shown = revealed.get(index);
    const previous = shown ? null : lastRevealed;
    promptBox.replaceChildren(
      h('div', { class: `host-word ${open ? '' : 'host-word--shut'}`.trim(), text: question.prompt }),
      h('p', {
        class: 'host-ask',
        text: question.dir === 'zh2en' ? 'What does it mean?' : 'Which word is it?',
      }),
    );
    // The teaching moment: once the question is shut, the class reads the right
    // answer off the projector instead of the teacher reading her own word list
    // on another device (D3). Never while it is open.
    if (shown) {
      promptBox.append(h('p', { class: 'host-answer', text: `Answer: ${shown}` }));
    } else if (previous) {
      promptBox.append(
        h('p', {
          class: 'host-answer host-answer--last',
          text: `Last answer: ${previous.prompt} = ${previous.answer}`,
        })
      );
    }
    // Two asks, both guarded so a known answer is never fetched twice. The
    // first is the early one: a class that has all answered closes the question
    // at once. The second is the one that always lands: the newest question
    // whose grace has also run out, which stays askable for the rest of the
    // round instead of only during the 1.5s the projector shows it as shut.
    if (!open) askForAnswer(index);
    const ready = Math.floor((elapsed - round.perQuestionMs - GRACE_MS) / round.slotMs);
    if (ready >= 0) askForAnswer(Math.min(ready, state.questions.length - 1));
    tickTowerClock();
    keepBoardFitted();
  }

  /**
   * The class clock, and the confetti when the tower gets there.
   *
   * The clock counts the round's own three minutes rather than the question
   * schedule, because that is the number on the cloud line's deadline. The win
   * is drawn HERE and not on the phase flip: the server holds the round open
   * for one more reveal pause after the class gets there (so the winning word
   * still goes on the wall), and a class that has just built it should not
   * watch a finished tower for two and a half seconds with nothing said.
   */
  function tickTowerClock(): void {
    const round = state?.round;
    if (!round || round.config.kind !== 'tower') return;
    if (towerClockOut) {
      const left = round.startsAt + round.config.clockMs - serverTime();
      towerClockOut.textContent = formatClock(Math.max(0, left));
    }
    if (!towerFinished && state && towerTotalOf(state.players) >= round.config.target) {
      towerFinished = true;
      towerBoard?.finish();
    }
  }

  /**
   * Ask the server what the right answer to question `index` was, once.
   *
   * The answer key is not in the polled state and must not be: every device
   * polls that, and only this one holds the host key. The server refuses until
   * the question's window and its grace have both shut, so a refusal here is a
   * question that is not shut yet, and the next tick asks again.
   */
  function askForAnswer(index: number): void {
    if (revealRefused || revealed.has(index) || asking.has(index)) return;
    asking.add(index);
    void revealAnswer(code, index, { hostKey })
      .then((choice) => {
        asking.delete(index);
        if (choice === null) return;
        const question = state?.questions[index];
        const text = question?.choices[choice];
        if (typeof text === 'string' && text !== '') {
          revealed.set(index, text);
          lastRevealed = { prompt: question?.prompt ?? '', answer: text };
        }
      })
      .catch((error: unknown) => {
        // A projector that cannot reach the reveal endpoint still runs the
        // round; it just does not print the answer. Retried on the next tick,
        // unless the server said this device is not the host, which no retry
        // can change. The round itself keeps running, so this stops asking and
        // says so once rather than tearing the projector down mid-question.
        asking.delete(index);
        if (isNotSignedIn(error) && !revealRefused) {
          revealRefused = true;
          console.warn('reveal: this device is not the host of this room, so no answers.');
        }
      });
  }

  // ---------- results ----------

  function paintResults(): void {
    setProjecting(false);
    if (!state) return;
    phase = 'results';
    resultsRoster = state.players.length;
    window.clearInterval(tickTimer);
    board?.dispose();
    board = null;
    towerBoard?.dispose();
    towerBoard = null;
    boardSlot = null;

    const last = state.history[state.history.length - 1];
    if (last) chosenKind = last.kind;
    if (state.round?.config.questionsPerRound) {
      chosenCount = state.round.config.questionsPerRound;
    }
    const ranking = last?.ranking ?? [];
    // The list and the tower are ordered by the same rule, and every row prints
    // the number that rule ranks on. In Cloud Climb that is clouds, not points
    // (Codex round 1, MUST-FIX 4).
    const cellOf = (row: RankingEntry): RankingCell => rankingCell(row, last?.kind);
    const podium = ranking.slice(0, 3);
    const totalsOrder = state.players
      .slice()
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

    // Sky Tower has no winner, so it has its own two headlines: the class got
    // there, or the class got this far. Neither names a child.
    const towerBuilt = last?.ranking.reduce((sum, row) => sum + (row.correct ?? 0), 0) ?? 0;
    const towerGoal =
      state.round?.config.kind === 'tower' ? state.round.config.target : towerBuilt;
    const headline =
      last?.kind === 'tower'
        ? last.won
          ? 'The class built it!'
          : `So close: ${towerBuilt} of ${towerGoal}`
        : last?.tie
          ? 'It is a tie!'
          : last?.winnerId
            ? `${nameOf(last.winnerId)} wins ${titleFor(last.kind)}!`
            : 'Round over';

    const again = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Play again',
    });
    again.addEventListener('click', () => {
      if (!last) return;
      again.disabled = true;
      // Another round of the same game needs the room back in the lobby first;
      // the server only starts a round from there.
      void backToLobby(code, { hostKey })
        .then(() =>
          startRound(code, { hostKey }, {
            kind: last.kind,
            questionsPerRound: chosenCount,
          })
        )
        .then(absorbEnvelope)
        .catch((error: Error) => {
          if (lostTheRoom(error)) return;
          again.disabled = false;
          showError(error.message);
        });
    });

    const another = h('button', { class: 'btn btn-big', type: 'button', text: 'Pick another game' });
    another.addEventListener('click', () => {
      another.disabled = true;
      void backToLobby(code, { hostKey })
        .then(absorbEnvelope)
        .catch((error: Error) => {
          if (lostTheRoom(error)) return;
          another.disabled = false;
          showError(error.message);
        });
    });

    const buttons = h('div', { class: 'row' });

    // Which round this was, and how long it ran. Rounds are open-ended: the
    // lesson has as many as the teacher starts, so this counts up rather than
    // pretending to know a total.
    const asked = last ? questionsAsked(last.n) : 0;
    const roundLine = last
      ? `Round ${last.n} of this lesson · ${titleFor(last.kind)}${
          asked > 0 ? ` · ${asked} question${asked === 1 ? '' : 's'}` : ''
        }`
      : '';

    // A co-operative round has no podium. Drawing one anyway (which is what
    // the shared results screen did the first time this ran on a projector,
    // caught by looking at the screenshot rather than by any assertion) put
    // "1. Ben 780 points" under "The class built it!", which is the exact
    // ranking the game promises a class it will not do. So a tower round gets
    // a contribution list instead: who added how many BLOCKS, in the same
    // colours the tower was built in, and no places.
    if (last?.kind === 'tower') {
      stage.replaceChildren(
        h('h2', { class: 'host-headline', text: headline }),
        last.won ? confettiRow() : h('div'),
        h('p', {
          class: 'host-round-line',
          text: `${towerBuilt} block${towerBuilt === 1 ? '' : 's'} of ${towerGoal}${
            roundLine ? ` · ${roundLine}` : ''
          }`,
        }),
        h('h2', { text: 'Who built it' }),
        h(
          'ul',
          { class: 'player-list ranking host-tower-built' },
          ranking.map((row) => {
            const index = state?.players.findIndex((p) => p.id === row.playerId) ?? 0;
            const dot = h('i', { class: 'host-tower-dot' });
            dot.style.setProperty('--fill', beanColor(index < 0 ? 0 : index).fill);
            const blocks = row.correct ?? 0;
            return h('li', {}, [
              h('span', {}, [dot, h('span', { text: ` ${row.name}` })]),
              h('span', { class: 'rank-values' }, [
                h('span', {
                  class: 'rank-primary',
                  text: `${blocks} block${blocks === 1 ? '' : 's'}`,
                }),
              ]),
            ]);
          })
        ),
        h('h2', { text: 'The whole lesson' }),
        rankingTable(
          totalsOrder.map((player) => ({
            name: player.name,
            primary: `${player.total ?? 0} points`,
            secondary: (player.wins ?? 0) > 0 ? `${player.wins} won` : '',
          }))
        ),
        buttons
      );
      buttons.append(again, another, finishButton(buttons, 'btn btn-big'));
      return;
    }

    stage.replaceChildren(
      h('h2', { class: 'host-headline', text: headline }),
      roundLine ? h('p', { class: 'host-round-line', text: roundLine }) : h('div'),
      h(
        'div',
        { class: 'podium' },
        // Second, first, third: a podium reads from its middle.
        [podium[1], podium[0], podium[2]].map((row, slot) =>
          row
            ? h('div', { class: `podium-step podium-step--${[2, 1, 3][slot]}` }, [
                beanChip(row.playerId),
                h('span', { class: 'podium-rank', text: ['2', '1', '3'][slot] }),
                h('span', { class: 'podium-name', text: row.name }),
                h('span', { class: 'podium-score', text: cellOf(row).primary }),
                h('span', { class: 'podium-sub', text: cellOf(row).secondary }),
              ])
            : h('div', { class: 'podium-step podium-step--empty' })
        )
      ),
      h('h2', { text: 'This round' }),
      rankingTable(
        ranking.map((row) => ({ name: row.name, ...cellOf(row) }))
      ),
      h('h2', { text: 'The whole lesson' }),
      rankingTable(
        totalsOrder.map((player) => ({
          name: player.name,
          primary: `${player.total ?? 0} points`,
          secondary: (player.wins ?? 0) > 0 ? `${player.wins} won` : '',
        }))
      ),
      buttons
    );
    buttons.append(again, another, finishButton(buttons, 'btn btn-big'));
  }

  /**
   * A shower of paper over a co-operative win.
   *
   * CSS, not a canvas: the tower's own scene has already been disposed by the
   * time this screen paints, and a class needs one cheerful line, not a second
   * renderer.
   */
  function confettiRow(): HTMLElement {
    const row = h('div', { class: 'host-confetti', 'aria-hidden': 'true' });
    for (let i = 0; i < 24; i += 1) {
      const bit = h('i');
      bit.style.setProperty('--x', `${(i * 4.1) % 100}%`);
      bit.style.setProperty('--d', `${(i % 7) * 0.14}s`);
      bit.style.setProperty('--c', beanColor(i).fill);
      row.append(bit);
    }
    return row;
  }

  /** The player's bean, in their colour, so the podium matches the tower. */
  function beanChip(playerId: string): HTMLElement {
    const index = state?.players.findIndex((player) => player.id === playerId) ?? 0;
    const color = beanColor(index < 0 ? 0 : index);
    const chip = h('span', { class: 'podium-bean' });
    chip.style.setProperty('--fill', color.fill);
    chip.style.setProperty('--rim', color.rim);
    return chip;
  }

  /**
   * One row per player: the number this game is ranked on, and the other one
   * underneath it in smaller type, so nobody has to guess which column decided
   * the order.
   */
  function rankingTable(rows: { name: string; primary: string; secondary: string }[]): HTMLElement {
    return h(
      'ul',
      { class: 'player-list ranking' },
      rows.map((row, index) =>
        h('li', { class: index === 0 ? 'winner' : '' }, [
          h('span', { text: `${index + 1}. ${row.name}` }),
          h('span', { class: 'rank-values' }, [
            h('span', { class: 'rank-primary', text: row.primary }),
            row.secondary
              ? h('span', { class: 'rank-secondary', text: row.secondary })
              : null,
          ].filter(Boolean) as Node[]),
        ])
      )
    );
  }

  // ---------- closed ----------

  function paintClosed(): void {
    setProjecting(false);
    phase = 'closed';
    window.clearInterval(tickTimer);
    stopPoll?.();
    stopPoll = null;
    board?.dispose();
    board = null;
    towerBoard?.dispose();
    towerBoard = null;
    boardSlot = null;

    const totals = (state?.players ?? [])
      .slice()
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

    stage.replaceChildren(
      h('h2', { class: 'host-headline', text: 'Lesson finished' }),
      h('p', { class: 'hint', text: `Room ${code} is closed. Everyone's screen has stopped.` }),
      totals.length > 0
        ? rankingTable(
            totals.map((player) => ({
              name: player.name,
              primary: `${player.total ?? 0} points`,
              secondary: (player.wins ?? 0) > 0 ? `${player.wins} won` : '',
            }))
          )
        : notice('Nobody played in this room.', 'info'),
      homeRow('Back to Home')
    );
  }

  function paintStale(): void {
    setProjecting(false);
    phase = 'stale';
    stopPoll?.();
    stopPoll = null;
    window.clearInterval(tickTimer);
    board?.dispose();
    board = null;
    const reload = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Tap to reload',
    });
    reload.addEventListener('click', () => window.location.reload());
    stage.replaceChildren(
      notice('This game was updated. Reload to carry on.', 'warn'),
      h('div', { class: 'row' }, [reload])
    );
  }

  function paintGone(message: string): void {
    setProjecting(false);
    phase = 'closed';
    stopPoll?.();
    stopPoll = null;
    window.clearInterval(tickTimer);
    board?.dispose();
    board = null;
    stage.replaceChildren(notice(message, 'warn'), homeRow('Back to Home'));
  }

  // ---------- plumbing ----------

  /**
   * The one terminal button in the app. Closing a room stops every device in
   * the class and cannot be undone, and it used to happen on one tap, right
   * next to the only other button on the screen. So it asks first, in the row
   * it lives in, with the plain question and not a jargon dialog.
   */
  function finishButton(row: HTMLElement, className = 'btn'): HTMLButtonElement {
    const finish = h('button', { class: className, type: 'button', text: 'Finish' });
    finish.addEventListener('click', () => {
      const keep = h('button', { class: className, type: 'button', text: 'No, keep playing' });
      const yes = h('button', {
        class: `${className} btn-danger`,
        type: 'button',
        text: 'Yes, finish',
      });
      const asked = h('div', { class: 'host-confirm' }, [
        h('p', { class: 'host-confirm-q', text: 'Finish the class room for everyone?' }),
        h('div', { class: 'row row-end' }, [keep, yes]),
      ]);
      const before = Array.from(row.childNodes);
      keep.addEventListener('click', () => row.replaceChildren(...before));
      yes.addEventListener('click', () => {
        yes.disabled = true;
        keep.disabled = true;
        yes.textContent = 'Finishing...';
        void closeRoom(code, { hostKey })
          .then(absorbEnvelope)
          .catch((error: Error) => {
            if (lostTheRoom(error)) return;
            row.replaceChildren(...before);
            showError(error.message);
          });
      });
      row.replaceChildren(asked);
    });
    return finish;
  }

  function nameOf(playerId: string): string {
    return state?.players.find((player) => player.id === playerId)?.name ?? 'Someone';
  }

  /**
   * How many questions the round numbered `n` asked. The round record is still
   * on the state at `results`, so this reads it there and falls back to 0,
   * which the caller renders as nothing rather than as a wrong number.
   */
  function questionsAsked(n: number): number {
    const round = state?.round;
    if (!round || round.n !== n) return 0;
    return round.questionCount;
  }

  function titleFor(kind: RoundKind): string {
    return GAMES.find((game) => game.kind === kind)?.title ?? 'Quiz';
  }

  function absorbEnvelope(envelope: RoomEnvelope): void {
    // THE MODEL GUARD, first, before this envelope's `set`, `phase`, `round` or
    // `level` is read at all. This tab is running JS from before a deploy, and
    // anything it draws from a shape it has never seen is a guess, so it stops
    // and says so rather than half-applying the state (Codex round 1, MUST 3).
    if (envelope.state && envelope.state.model !== ROOM_MODEL) {
      if (phase !== 'stale') paintStale();
      return;
    }

    // A reply to a button can land after a poll that already carried a newer
    // room. Taking its state would roll the projector backwards.
    if (
      typeof envelope.version === 'number' &&
      typeof version === 'number' &&
      envelope.version < version
    ) {
      return;
    }
    // THE INCARNATION CHECK, before the host UI is drawn from this state. A
    // key stamped with a different room's `createdAt` belongs to a room that is
    // gone and whose four letters have been handed out again: this device is a
    // guest here, not the teacher, so the key goes and the join screen opens
    // instead of a projector that will fail on its first button.
    const stamp = envelope.state?.createdAt;
    if (typeof stamp === 'number') {
      if (boundTo === 0) {
        boundTo = stamp;
        bindHostRoom(code, stamp);
      } else if (stamp !== boundTo) {
        forgetHostKey(code);
        teardown();
        navigate(`#/room/${code}`);
        return;
      }
    }

    if (typeof envelope.version === 'number') version = envelope.version;
    if (envelope.state) {
      state = envelope.state;
      applyLevel(state.set.level);
    }
    if (!state) return;

    if (state.phase === 'closed') {
      if (phase !== 'closed') paintClosed();
      return;
    }
    if (state.phase === 'results') {
      // Repainted when the roster changes as well as on arrival: a child may
      // join at this screen now (D2), and the teacher has to see that they are
      // in before she starts the next game.
      if (phase !== 'results' || state.players.length !== resultsRoster) paintResults();
      return;
    }
    if (state.phase === 'round') {
      const key = state.round ? `${state.round.n}:${state.round.config.kind}` : '';
      if (phase !== 'round' || key !== roundKey) paintRoundShell();
      if (state.round?.config.kind === 'tower') {
        towerBoard?.update(contributorsOf(state));
        paintTowerTally(state);
      } else {
        board?.setPlayers(beansOf(state));
        animateDelta(state);
      }
      return;
    }
    paintLobby();
  }

  /**
   * Who built what, on the projector only. Children never receive these numbers
   * (the server strips them from their poll), so this list exists on exactly
   * one screen in the room, which is the one the class is looking at together.
   */
  function paintTowerTally(source: RoomStateWire): void {
    if (!towerTallyOut) return;
    const rows = source.players
      .map((player, index) => ({ player, index }))
      .sort((a, b) => (b.player.correct ?? 0) - (a.player.correct ?? 0));
    towerTallyOut.replaceChildren(
      ...rows.map(({ player, index }) => {
        const dot = h('i', { class: 'host-tower-dot' });
        dot.style.setProperty('--fill', beanColor(index).fill);
        return h('li', {}, [
          dot,
          h('span', { class: 'host-tower-who', text: player.name }),
          h('b', { text: String(player.correct ?? 0) }),
        ]);
      })
    );
  }

  function beginPolling(): void {
    stopPoll?.();
    stopPoll = startPolling(code, {
      getVersion: () => version,
      // The projector reads the room AS THE TEACHER: in a tower round that is
      // the difference between seeing every child's count and seeing none.
      getAuth: () => ({ hostKey }),
      onEnvelope: (envelope) => {
        problem.replaceChildren();
        absorbEnvelope(envelope);
      },
      onError: (error) => {
        if (error instanceof RoomError && error.status === 404) {
          paintGone(`Room ${code} is gone. Rooms close themselves after two hours.`);
          return;
        }
        showError(`${error.message} Trying again...`);
      },
    });
  }

  /**
   * The teacher's screen is a projector, not a private page: it shows the
   * prompt, the whole roster and the buttons that start and end a round. On a
   * shared classroom iPad the stored host key is one URL away from any child
   * who types it, so the key is not USED until somebody says out loud that
   * they are the teacher (Codex round 1, SHOULD-FIX 7).
   *
   * The default is the child's answer, not the teacher's: the other button
   * goes straight to the join screen, which is what a student wanted anyway.
   */
  function paintTeacherGate(): void {
    const yes = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'I am the teacher',
    });
    yes.addEventListener('click', () => {
      stage.replaceChildren(h('p', { class: 'hint', text: `Opening room ${code}...` }));
      beginPolling();
    });

    const no = h('button', { class: 'btn btn-big', type: 'button', text: 'I am a student' });
    no.addEventListener('click', () => {
      teardown();
      navigate(`#/room/${code}`);
    });

    stage.replaceChildren(
      h('div', { class: 'panel' }, [
        h('h2', { text: `Who is using room ${code}?` }),
        h('p', {
          class: 'hint',
          text:
            'This device can run the teacher screen, the one everybody looks at. ' +
            'Students tap the other button to play.',
        }),
        h('div', { class: 'row' }, [yes, no]),
      ])
    );
  }

  paintTeacherGate();

  return teardown;
}

