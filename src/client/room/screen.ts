// A student's device: join with a name, wait, play whatever the teacher starts,
// see the same ranking as everyone else, then wait for the next game.
//
// The schedule is the server's: question i is open during
// [startsAt + i*slotMs, startsAt + i*slotMs + perQuestionMs]. The client never
// decides when a question opens and never reports its own timing; it only draws
// the window it is in. In a Treasure Dash round the slot is longer than the
// question, and the tail of it is the chest window.
//
// Two room shapes arrive here and both must work:
//   model 2  a class room: phases lobby / round / results / closed, with
//            `round` carrying the schedule.
//   model 1  the week-1 "Race a friend" room, which still speaks the v1 wire
//            phases lobby / playing / done and mirrors its schedule onto the
//            top level. Its Start button and its `/start` route are unchanged.
// Anything else is a tab holding JS from before a deploy, and it says so
// instead of guessing at a shape it has never seen.

import { MIN_PLAYERS } from '../../shared/room';
import { ROOM_MODEL, type RoundKind } from '../../shared/types';
import { applyLevel, audioStatusLine } from '../controls';
import { celebrate } from '../feedback';
import { createQuizView, type QuizView } from '../games/quizview';
import { navigate } from '../router';
import { createBoard, type Board, type BoardPlayer } from '../scene/board';
import { saveName, savedName } from '../state';
import { absoluteUrl, copyButton, h, notice, screen } from '../ui';
import {
  fetchRoom,
  isNotSignedIn,
  joinRoom,
  NOT_SIGNED_IN,
  RoomError,
  revealedChoice,
  sendAnswer,
  sendPick,
  serverTime,
  startRoom,
  type PlayerAuth,
  type RoomEnvelope,
  type RoomQuestion,
  type RoomStateWire,
} from './api';
import { startPolling } from './poll';
import { provisionalRanking, rankedLevel, rankingCell } from './ranking';
import { forgetMembership, readMembership, writeMembership } from './session';

type Mode =
  | 'looking'
  | 'missing'
  | 'name'
  | 'lobby'
  | 'round'
  | 'results'
  | 'closed'
  | 'stale';

/** The v2 phase word, whichever wire the room is speaking. */
type Play = 'lobby' | 'round' | 'results' | 'closed' | 'unknown';

/** The schedule, read from wherever this room keeps it. */
interface Schedule {
  kind: RoundKind;
  startsAt: number;
  slotMs: number;
  perQuestionMs: number;
  questionCount: number;
  /** ms of chest window after a dash question closes. 0 in any other kind. */
  pickMs: number;
}

/** What one player looked like last poll, so a change can be explained once. */
interface ScoreTrace {
  score: number;
  picked: number;
  answered: number;
}

function tracesOf(source: RoomStateWire): Map<string, ScoreTrace> {
  return new Map(
    source.players.map((player) => [
      player.id,
      {
        score: player.score ?? 0,
        picked: player.pickedIndexes?.length ?? 0,
        answered: player.answered ?? 0,
      },
    ])
  );
}

/** How long the line explaining a chest stays on a student's screen. */
const CHEST_NOTE_MS = 5000;

const GAME_TITLES: Record<RoundKind, string> = {
  race: 'Race Quiz',
  climb: 'Cloud Climb',
  dash: 'Treasure Dash',
  tower: 'Sky Tower',
};

/**
 * How many silhouette bricks a child's own little tower draws before it stops
 * counting up and starts scaling down. Her screen is a phone held in one hand,
 * so the shared tower here is a reassurance that the class is getting there,
 * not a second projector.
 */
const SILHOUETTE_MAX = 24;

export function renderRoom(root: HTMLElement, code: string): () => void {
  const { root: page, body } = screen(`Room ${code}`, { back: '#/' });
  const stage = h('div');
  const problem = h('div');
  const identity = h('p', { class: 'hint room-identity' });
  body.append(stage, identity, problem, audioStatusLine());
  root.replaceChildren(page);

  const remembered = readMembership(code);
  let playerId: string | null = remembered?.playerId ?? null;
  // The private half of this device's membership. The player id says which
  // bean; this says the tap came from the device that joined as it.
  let memberKey = remembered?.memberKey ?? '';
  let myName = remembered?.name ?? '';
  let recovered = Boolean(remembered);

  let state: RoomStateWire | null = null;
  let version: number | undefined;
  // Which room this screen is following. The server stamps `createdAt` once
  // per room, so it is the only thing that stays put while `version` counts up.
  let incarnation: number | undefined;
  let mode: Mode = 'looking';
  let disposed = false;
  let stopPoll: (() => void) | null = null;
  let raceTimer = 0;
  let view: QuizView | null = null;
  let shownIndex = -1;
  let chosen: number | null = null;
  let revealed = false;
  // The right choice for the question on screen, and only for that one. The
  // server sends it back with the reply to this player's answer; it is never
  // in the room state, so an unanswered question ends with it still null.
  let correctChoice: number | null = null;
  let awaitingReply = false;
  // The question whose answer a dropped request left in the dark: the card is
  // shut, the server may or may not have recorded it, and only a later state
  // can say which. Cleared as soon as the poll answers, or the question ends.
  let unresolvedIndex: number | null = null;
  let scoreOut: HTMLElement | null = null;
  /** Sky Tower only: this child's own block count, and the class silhouette. */
  let myBlocksOut: HTMLElement | null = null;
  let silhouetteOut: HTMLElement | null = null;
  let towerGoalOut: HTMLElement | null = null;
  let verdict: HTMLElement | null = null;
  let playerList: HTMLElement | null = null;
  let startButton: HTMLButtonElement | null = null;
  let actionSlot: HTMLElement | null = null;
  let waitLine: HTMLElement | null = null;
  let countdown: HTMLElement | null = null;

  // The compact board strip above the card, and the round it belongs to.
  let boardSlot: HTMLElement | null = null;
  let board: Board | null = null;
  let boardGeneration = 0;
  let roundKey = '';
  let lastSteps = new Map<string, number>();
  /**
   * What every player's score, chest count and answer count were last poll.
   * A Steal or a Swap moves points between two players and the server tells
   * only the picker what was in the chest, so the victim's device has to read
   * what happened out of the state itself.
   */
  let lastTraces = new Map<string, ScoreTrace>();
  /** The line that says why a score moved, and the timer that clears it. */
  let chestNote: HTMLElement | null = null;
  let chestNoteTimer = 0;

  // Treasure Dash: the chest window this player's correct answer opened.
  let pickBox: HTMLElement | null = null;
  let pending: { index: number; expiresAt: number } | null = null;
  let pickSent = false;

  const teardown = (): void => {
    disposed = true;
    stopPoll?.();
    stopPoll = null;
    window.clearInterval(raceTimer);
    window.clearTimeout(chestNoteTimer);
    board?.dispose();
    board = null;
  };

  // A message the next poll must not wipe. The lobby polls every 2 seconds, so
  // an answer from the server shown the ordinary way vanishes before it is read.
  let stickyProblem: string | null = null;

  const showError = (message: string, opts: { sticky?: boolean } = {}): void => {
    stickyProblem = opts.sticky ? message : null;
    problem.replaceChildren(notice(message, 'error'));
  };

  /** Clears poll noise but keeps a message the player still needs to see. */
  const clearTransientProblem = (): void => {
    if (stickyProblem) problem.replaceChildren(notice(stickyProblem, 'error'));
    else problem.replaceChildren();
  };

  /**
   * "Playing as Ana." plus, while the room is still joinable, a way out of a
   * name this device recovered from a previous tab (amendment 9). Rejoining is
   * a lobby-only action on the server, so the link is only offered there.
   */
  const paintIdentity = (): void => {
    if (!playerId || !myName) {
      identity.replaceChildren();
      return;
    }
    const canRejoin = playPhaseOf(state) === 'lobby';
    identity.replaceChildren(document.createTextNode(`Playing as ${myName}. `));
    if (!canRejoin) return;
    const swap = h('a', { href: '#', text: 'Not you? Join as someone else' });
    swap.addEventListener('click', (event) => {
      event.preventDefault();
      forgetMembership(code);
      playerId = null;
      memberKey = '';
      myName = '';
      recovered = false;
      stopPoll?.();
      stopPoll = null;
      window.clearInterval(raceTimer);
      identity.replaceChildren();
      paintNameScreen();
    });
    identity.append(swap);
  };

  // ---------- reading whichever wire this room speaks ----------

  /**
   * THE MODEL GUARD, as a question that can be asked before any other field of
   * an envelope is touched. `model: 1` is a legacy "Race a friend" room, whose
   * v1 wire shape this screen still speaks; the current model is a class room.
   * Anything else is a tab holding JS from before a deploy, and reading `set`,
   * `phase`, `round` or `level` off a shape this build has never seen is how a
   * dead white screen happens (Codex round 1, MUST-FIX 3).
   */
  function knownModel(source: { model?: unknown } | null | undefined): boolean {
    return source?.model === 1 || source?.model === ROOM_MODEL;
  }

  function playPhaseOf(source: RoomStateWire | null): Play {
    const phase = source?.phase;
    if (phase === 'lobby') return 'lobby';
    if (phase === 'round' || phase === 'playing') return 'round';
    if (phase === 'results' || phase === 'done') return 'results';
    if (phase === 'closed') return 'closed';
    return 'unknown';
  }

  function scheduleOf(source: RoomStateWire | null): Schedule | null {
    if (!source) return null;
    const round = source.round;
    if (round) {
      return {
        kind: round.config.kind,
        startsAt: round.startsAt,
        slotMs: round.slotMs,
        perQuestionMs: round.perQuestionMs,
        questionCount: round.questionCount,
        pickMs: round.config.kind === 'dash' ? round.config.pickMs : 0,
      };
    }
    // A model: 1 room mirrors its schedule onto the top level.
    if (
      typeof source.startsAt === 'number' &&
      typeof source.slotMs === 'number' &&
      typeof source.perQuestionMs === 'number'
    ) {
      return {
        kind: 'race',
        startsAt: source.startsAt,
        slotMs: source.slotMs,
        perQuestionMs: source.perQuestionMs,
        questionCount: source.questionCount ?? source.questions.length,
        pickMs: 0,
      };
    }
    return null;
  }

  /**
   * "This room is full (40 players)." The number is the room's own
   * `maxPlayers`, which the server puts on the wire for exactly this: a class
   * room and a legacy two-player race hold different numbers, and a child who
   * cannot get in should be told which one they hit rather than "full"
   * (Codex round 1, MUST-FIX 3 and its client half).
   */
  function roomFullMessage(): string | null {
    const max = state?.maxPlayers;
    if (typeof max !== 'number' || max <= 0) return null;
    if ((state?.players.length ?? 0) < max) return null;
    return `This room is full (${max} players). Ask your teacher for another room code.`;
  }

  /** This device's credentials for an answer or a pick. */
  function who(): PlayerAuth {
    return { playerId: playerId ?? '', memberKey };
  }

  /**
   * The server refused the identity behind an answer or a pick: the key on this
   * device is not the one that joined as that player. A retry cannot fix that,
   * so the stored player goes and the child is asked for a name again.
   */
  function signedOut(): void {
    playerId = null;
    memberKey = '';
    myName = '';
    recovered = false;
    forgetMembership(code);
    stopPoll?.();
    stopPoll = null;
    window.clearInterval(raceTimer);
    dropBoard();
    view = null;
    scoreOut = null;
    pending = null;
    identity.replaceChildren();
    paintNameScreen();
    showError(NOT_SIGNED_IN, { sticky: true });
  }

  function me(): RoomStateWire['players'][number] | undefined {
    if (!state || !playerId) return undefined;
    return state.players.find((player) => player.id === playerId);
  }

  // ---------- looking for the room ----------

  const paintLooking = (): void => {
    mode = 'looking';
    stage.replaceChildren(h('p', { class: 'hint', text: `Looking for room ${code}...` }));
  };

  /**
   * The room is not there (or is no longer taking players). Say so before a
   * player types a name, rather than after: a confident join screen for a room
   * that does not exist is the thing this replaces.
   */
  const paintNoRoom = (message: string): void => {
    mode = 'missing';
    // Reached from polling as well as from the first probe, so everything the
    // round was running has to come down with it.
    stopPoll?.();
    stopPoll = null;
    window.clearInterval(raceTimer);
    dropBoard();
    view = null;
    scoreOut = null;
    const home = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Back to Home',
    });
    home.addEventListener('click', () => navigate('#/'));
    problem.replaceChildren();
    identity.replaceChildren();
    stickyProblem = null;
    stage.replaceChildren(notice(message, 'warn'), h('div', { class: 'row' }, [home]));
  };

  /**
   * This tab is running JS from before a deploy, so the room is speaking a
   * shape it has never seen. Ten lines that turn a confusing dead screen into
   * a tap (plan §1.13).
   */
  const paintStale = (): void => {
    mode = 'stale';
    stopPoll?.();
    stopPoll = null;
    window.clearInterval(raceTimer);
    dropBoard();
    view = null;
    const reload = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Tap to reload',
    });
    reload.addEventListener('click', () => window.location.reload());
    identity.replaceChildren();
    problem.replaceChildren();
    stage.replaceChildren(
      notice('This game was updated. Tap to reload and carry on.', 'warn'),
      h('div', { class: 'row' }, [reload])
    );
  };

  // ---------- name ----------

  const paintNameScreen = (): void => {
    mode = 'name';
    const nameInput = h('input', {
      type: 'text',
      id: 'player-name',
      placeholder: 'Your name',
      maxlength: '16',
      value: savedName(),
    });
    const joinButton = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Join the game',
    });

    const doJoin = (): void => {
      const name = nameInput.value.trim();
      if (!name) {
        showError('Type a name so the class knows which bean is yours.');
        nameInput.focus();
        return;
      }
      saveName(name);
      joinButton.disabled = true;
      joinButton.textContent = 'Joining...';
      problem.replaceChildren();
      void joinRoom(code, name)
        .then(({ playerId: id, memberKey: key, envelope }) => {
          playerId = id;
          memberKey = key;
          myName = name;
          recovered = false;
          writeMembership(code, id, key, name);
          absorbEnvelope(envelope);
          beginPolling();
        })
        .catch((error: Error) => {
          joinButton.disabled = false;
          joinButton.textContent = 'Join the game';
          // A refusal on a room that is already at its limit is the full room,
          // whatever the server's own wording was, and the message says the
          // number so nobody keeps retapping.
          showError(roomFullMessage() ?? error.message);
        });
    };

    joinButton.addEventListener('click', doJoin);
    nameInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') doJoin();
    });

    // A room already at its limit says so before a name is typed, rather than
    // after a child has typed one and tapped Join.
    const full = roomFullMessage();
    if (full) {
      joinButton.disabled = true;
      nameInput.disabled = true;
    }

    stage.replaceChildren(
      h('div', { class: 'panel' }, [
        h('div', { class: 'code-big', text: code }),
        h('p', { class: 'hint', text: 'This is the room code. Share it or the link below.' }),
        h('div', { class: 'row' }, [
          copyButton('Copy room link', () => absoluteUrl(`#/room/${code}`)),
        ]),
      ]),
      ...(full ? [notice(full, 'warn')] : []),
      h('div', { class: 'field' }, [
        h('label', { for: 'player-name', text: 'What is your name?' }),
        nameInput,
      ]),
      joinButton
    );
  };

  // ---------- lobby ----------

  const paintLobbyShell = (): void => {
    mode = 'lobby';
    window.clearInterval(raceTimer);
    dropBoard();
    playerList = h('ul', { class: 'player-list' });
    waitLine = h('p', { class: 'hint' });
    startButton = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Start the race',
    });
    actionSlot = h('div');
    startButton.addEventListener('click', () => {
      if (!playerId) return;
      stickyProblem = null;
      problem.replaceChildren();
      startButton!.disabled = true;
      startButton!.textContent = 'Starting...';
      void startRoom(code, playerId)
        .then(absorbEnvelope)
        .catch((error: Error) => {
          startButton!.disabled = false;
          startButton!.textContent = 'Start the race';
          // The server refuses a one-player start (409). Keep its answer on
          // screen: the next poll is two seconds away and would erase it.
          showError(error.message, { sticky: true });
        });
    });

    stage.replaceChildren(
      h('div', { class: 'panel' }, [
        h('div', { class: 'code-big', text: code }),
        h('p', {
          class: 'hint',
          text: 'Everyone types this code on the home screen, or opens the link.',
        }),
        h('div', { class: 'row' }, [
          copyButton('Copy room link', () => absoluteUrl(`#/room/${code}`)),
        ]),
      ]),
      h('h2', { text: 'Players' }),
      playerList,
      waitLine,
      actionSlot
    );
  };

  const paintLobby = (): void => {
    if (mode !== 'lobby') paintLobbyShell();
    if (!state || !playerList || !waitLine || !startButton || !actionSlot) return;

    playerList.replaceChildren(
      ...state.players.map((player) =>
        h('li', {}, [
          h('span', { text: player.name }),
          h('span', {
            class: 'tag',
            text: [
              player.id === state?.hostId ? 'host' : '',
              player.id === playerId ? 'you' : '',
            ]
              .filter(Boolean)
              .join(' · '),
          }),
        ])
      )
    );

    // A class room has a teacher on another screen, and no student may start
    // anything. Only the legacy "Race a friend" host gets a Start button, and
    // it is taken out of the page for everyone else rather than hidden: a
    // `.btn` sets its own `display`, so the `hidden` attribute alone left a
    // live blue button under a student's thumb.
    if (state.teacherRoom) {
      actionSlot.replaceChildren();
      waitLine.textContent =
        state.history.length > 0
          ? 'Round over. Waiting for your teacher to pick the next game.'
          : 'You are in. Waiting for your teacher to start.';
      return;
    }

    const isHost = state.hostId === playerId;
    const enough = state.players.length >= MIN_PLAYERS;
    const hostName = state.players.find((player) => player.id === state?.hostId)?.name;

    if (isHost) {
      if (startButton.parentElement !== actionSlot) actionSlot.replaceChildren(startButton);
      startButton.disabled = !enough;
      startButton.title = enough ? '' : 'Waiting for a second player';
      waitLine.textContent = enough
        ? 'Everyone in? Start when you are ready.'
        : 'Waiting for a second player.';
    } else {
      actionSlot.replaceChildren();
      waitLine.textContent = hostName
        ? `Waiting for ${hostName} to start.`
        : 'Waiting for the host to start.';
    }
  };

  // ---------- the compact board strip ----------

  function dropBoard(): void {
    boardGeneration++;
    board?.dispose();
    board = null;
    boardSlot = null;
    lastSteps = new Map();
  }

  function beansOf(source: RoomStateWire): BoardPlayer[] {
    return source.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      colorIndex: index,
      step: player.step ?? 0,
      score: player.score ?? 0,
      isMe: player.id === playerId,
    }));
  }

  async function buildBoard(kind: 'climb' | 'dash', height: number): Promise<void> {
    const mine = ++boardGeneration;
    board?.dispose();
    board = null;
    if (!boardSlot) return;
    const next = await createBoard(boardSlot, kind, { height, compact: true });
    if (disposed || mine !== boardGeneration) {
      next.dispose();
      return;
    }
    board = next;
    if (state) {
      board.setPlayers(beansOf(state));
      lastSteps = new Map(state.players.map((p) => [p.id, p.step ?? 0]));
    }
  }

  /** Slides every bean to where the server says it is, hopping the ones that moved. */
  function refreshBoard(next: RoomStateWire): void {
    explainScoreChange(next);
    if (!board) return;
    board.setPlayers(beansOf(next));
    for (const player of next.players) {
      const before = lastSteps.get(player.id);
      const step = player.step ?? 0;
      if (before !== undefined && step > before) board.hop(player.id, step);
      lastSteps.set(player.id, step);
    }
  }

  /** The one line that says why this player's score moved. Empty text clears it. */
  function sayChestNote(text: string): void {
    window.clearTimeout(chestNoteTimer);
    if (!chestNote) return;
    chestNote.textContent = text;
    chestNote.hidden = text === '';
    if (!text) return;
    chestNoteTimer = window.setTimeout(() => {
      if (!chestNote) return;
      chestNote.textContent = '';
      chestNote.hidden = true;
    }, CHEST_NOTE_MS);
  }

  /**
   * Says out loud what a Treasure Dash chest did to THIS player, when this
   * player is not the one who opened it.
   *
   * A Steal or a Swap moves points between two people, and the server only
   * ever tells the picker what was in the chest: on the victim's device the
   * number simply changed, with nothing on screen to say why (a nine-year-old
   * whose score halves in silence decides the game is broken). So the reason is
   * read out of the state instead: when exactly two players moved by opposite
   * amounts, the other one is who it happened with, and two scores that landed
   * on each other's old values is a Swap rather than a Steal.
   *
   * A change this player's own answer or own chest caused is left alone: those
   * already have words on this screen.
   */
  function explainScoreChange(next: RoomStateWire): void {
    const was = lastTraces;
    lastTraces = tracesOf(next);
    if (!playerId || was.size === 0) return;

    const before = was.get(playerId);
    const mine = next.players.find((player) => player.id === playerId);
    if (!before || !mine) return;

    const delta = (mine.score ?? 0) - before.score;
    if (delta === 0) return;
    if ((mine.answered ?? 0) !== before.answered) return;
    if ((mine.pickedIndexes?.length ?? 0) !== before.picked) return;

    // Everyone whose score moved this poll, this player included. A player who
    // was not in the room last poll cannot have moved and is not counted.
    const moved = next.players.filter((player) => {
      const trace = was.get(player.id);
      return trace !== undefined && (player.score ?? 0) !== trace.score;
    });
    const other = moved.length === 2 ? moved.find((player) => player.id !== playerId) : undefined;
    const otherBefore = other ? was.get(other.id) : undefined;
    const paired =
      other && otherBefore && (other.score ?? 0) - otherBefore.score === -delta
        ? { player: other, before: otherBefore }
        : null;
    const swapped =
      paired !== null &&
      (mine.score ?? 0) === paired.before.score &&
      (paired.player.score ?? 0) === before.score;

    if (swapped && paired) {
      sayChestNote(`Swapped scores with ${paired.player.name}.`);
      board?.badge(playerId, 'SWAP!', 'swap');
      return;
    }
    if (delta < 0) {
      sayChestNote(
        paired ? `${paired.player.name} took ${-delta} points from you.` : `You lost ${-delta} points.`
      );
      board?.badge(playerId, String(delta), 'steal');
      return;
    }
    sayChestNote(
      paired ? `You got ${delta} points from ${paired.player.name}.` : `You got ${delta} points.`
    );
    board?.badge(playerId, `+${delta}`, 'good');
  }

  // ---------- playing ----------

  const paintRoundShell = (): void => {
    if (!state) return;
    const schedule = scheduleOf(state);
    if (!schedule) return;
    mode = 'round';
    roundKey = roundKeyOf(state);
    scoreOut = h('b', { text: String(me()?.score ?? 0) });
    countdown = h('div', { class: 'countdown' });
    verdict = h('p', { class: 'verdict' });
    pickBox = h('div', { class: 'pick-box' });
    // Why a score moved when this player did not move it. `aria-live` so a
    // screen reader says it without the student hunting for it.
    chestNote = h('p', { class: 'chest-note', 'aria-live': 'polite', hidden: true });
    window.clearTimeout(chestNoteTimer);
    lastTraces = tracesOf(state);
    view = createQuizView(state.set, onChoose);
    shownIndex = -1;
    chosen = null;
    revealed = false;
    correctChoice = null;
    awaitingReply = false;
    unresolvedIndex = null;
    pending = null;
    pickSent = false;

    dropBoard();
    const showBoard = schedule.kind === 'climb' || schedule.kind === 'dash';
    boardSlot = showBoard ? h('div', { class: 'board-strip' }) : null;

    // Sky Tower is co-operative, so a child's screen shows two numbers and no
    // names: how many blocks SHE put in, and how tall the class tower is. The
    // server does not even send her the other children's counts, so there is
    // nothing here to leak by accident.
    myBlocksOut = null;
    silhouetteOut = null;
    towerGoalOut = null;
    let towerStrip: HTMLElement | null = null;
    if (schedule.kind === 'tower') {
      myBlocksOut = h('b', { text: String(me()?.correct ?? 0) });
      silhouetteOut = h('div', { class: 'tower-mine-stack', 'aria-hidden': 'true' });
      towerGoalOut = h('p', { class: 'tower-mine-goal' });
      towerStrip = h('div', { class: 'tower-mine' }, [
        silhouetteOut,
        h('div', { class: 'tower-mine-text' }, [
          h('p', { class: 'tower-mine-count' }, ['Your blocks: ', myBlocksOut]),
          towerGoalOut,
        ]),
      ]);
    }

    stage.replaceChildren(
      h('div', { class: 'game-bar' }, [
        h('span', { class: 'stat' }, ['Score ', scoreOut]),
        h('span', { class: 'stat', text: GAME_TITLES[schedule.kind] }),
      ]),
      ...(boardSlot ? [boardSlot] : []),
      ...(towerStrip ? [towerStrip] : []),
      chestNote,
      countdown,
      view.node,
      verdict,
      pickBox
    );
    if (towerStrip) paintMyTower();
    view.node.hidden = true;

    if (boardSlot) {
      const height =
        state.round?.config.kind === 'climb'
          ? state.round.config.height
          : schedule.questionCount;
      void buildBoard(schedule.kind === 'dash' ? 'dash' : 'climb', Math.max(1, height));
    }

    window.clearInterval(raceTimer);
    raceTimer = window.setInterval(tickRace, 100);
    tickRace();
  };

  /**
   * The child's own two Sky Tower numbers.
   *
   * `towerTotal` is the class height, and it is the ONLY thing on this poll
   * that says anything about anybody else: one number, no names, no counts.
   * The silhouette is drawn from it, capped so a class of thirty does not
   * paint six hundred bricks into a phone.
   */
  function paintMyTower(): void {
    if (!myBlocksOut && !silhouetteOut && !towerGoalOut) return;
    const round = state?.round;
    if (round?.config.kind !== 'tower') return;
    const target = round.config.target;
    const total = Math.max(0, state?.towerTotal ?? 0);

    if (myBlocksOut) myBlocksOut.textContent = String(me()?.correct ?? 0);
    if (towerGoalOut) {
      towerGoalOut.textContent =
        total >= target
          ? `The class built it: ${total} of ${target}.`
          : `The class tower: ${total} of ${target}.`;
    }
    if (!silhouetteOut) return;

    const drawn = Math.min(total, SILHOUETTE_MAX);
    if (silhouetteOut.childElementCount !== drawn) {
      silhouetteOut.replaceChildren(
        ...Array.from({ length: drawn }, () => h('i', { class: 'tower-mine-brick' }))
      );
    }
    silhouetteOut.classList.toggle('tower-mine-stack--done', total >= target);
  }

  /** Identity of the round on screen, so a new one rebuilds rather than reuses. */
  function roundKeyOf(source: RoomStateWire): string {
    const schedule = scheduleOf(source);
    if (!schedule) return '';
    return `${source.round?.n ?? 1}:${schedule.kind}:${schedule.startsAt}`;
  }

  /** True while the server's window for `index` is still open. */
  function answerWindowOpen(index: number): boolean {
    const schedule = scheduleOf(state);
    if (!schedule || schedule.slotMs <= 0) return false;
    const elapsed = serverTime() - schedule.startsAt;
    if (elapsed < 0) return false;
    return (
      Math.floor(elapsed / schedule.slotMs) === index &&
      elapsed - index * schedule.slotMs < schedule.perQuestionMs
    );
  }

  /** The one line of feedback under the card. Empty text clears it. */
  function sayVerdict(text: string, tone: 'ok' | 'bad' | 'muted'): void {
    if (!verdict) return;
    verdict.className = `verdict verdict-${tone}`;
    verdict.textContent = text;
  }

  function clearVerdict(): void {
    if (!verdict) return;
    verdict.className = 'verdict';
    verdict.textContent = '';
  }

  /**
   * True when the server's own copy of this room already holds an answer from
   * this player for `index`. The public state carries every player's
   * `answeredIndexes`, so this is the server's word, not a local guess.
   */
  function alreadyAnswered(index: number): boolean {
    const mine = me();
    if (!mine || !Array.isArray(mine.answeredIndexes)) return false;
    return mine.answeredIndexes.includes(index);
  }

  /** Hands the question back for another tap, with nothing revealed. */
  function reopen(index: number, question: RoomQuestion, total: number): void {
    chosen = null;
    revealed = false;
    correctChoice = null;
    unresolvedIndex = null;
    clearVerdict();
    view?.show(question, { n: index + 1, total });
  }

  /**
   * The server already has an answer for this question, so the card stays
   * shut. Nothing is coloured: the answer key rides only on the reply to the
   * answer the server actually took, and this player's copy of it was lost.
   */
  function lockAsCounted(pick: number | null): void {
    revealed = true;
    unresolvedIndex = null;
    view?.setProgress(0);
    view?.reveal(null, pick);
    sayVerdict('Already counted.', 'muted');
  }

  function onChoose(choice: number): void {
    if (!state || !playerId || shownIndex < 0) return;
    const askedIndex = shownIndex;
    const total = state.questions.length;
    const question = state.questions[askedIndex];
    chosen = choice;
    awaitingReply = true;
    // The card cannot mark this right or wrong yet: the room's copy of the
    // question carries no answer. It shows the tap landed and waits for the
    // server, which is the only thing that knows.
    view?.markChoice(choice);
    sayVerdict('Checking...', 'muted');

    void sendAnswer(code, who(), askedIndex, choice)
      .then((envelope) => {
        absorbEnvelope(envelope);
        // A later question is already on screen: this reply is history.
        if (shownIndex !== askedIndex) return;
        awaitingReply = false;

        // The server did not record THIS request. That is not the same as
        // "not recorded": a first answer whose reply was lost is already
        // scored, and the refusal we are reading is the duplicate. The
        // envelope has been absorbed, so the state below is the server's own.
        if (envelope.accepted === false) {
          if (alreadyAnswered(askedIndex)) {
            const known = revealedChoice(envelope, question.choices.length);
            if (known !== null) {
              correctChoice = known;
              settle(known, choice, envelope.correct === true);
            } else {
              lockAsCounted(choice);
            }
            return;
          }
          // The server has no answer from this player here, so the tap really
          // was lost. Hand the question back rather than leaving the player
          // staring at a locked card for the rest of the slot.
          if (answerWindowOpen(askedIndex)) reopen(askedIndex, question, total);
          else settle(null, chosen);
          return;
        }

        correctChoice = revealedChoice(envelope, question.choices.length);
        settle(correctChoice, choice, envelope.correct === true);

        // A correct answer in Treasure Dash earns a chest. The server names the
        // window it opened; nothing else on this device may decide that.
        if (envelope.correct === true && envelope.pick) {
          openChests(envelope.pick.index, envelope.pick.expiresAt);
        }
      })
      .catch((error: unknown) => {
        // A 403 is the one failure that says something definite: this device is
        // not the one that joined as this player. No amount of resyncing fixes
        // that, so it does not resync.
        if (isNotSignedIn(error)) {
          signedOut();
          return;
        }
        // Any other failure says nothing about whether the server took the
        // answer: the break can land after it was scored. So the card stays
        // shut on "Checking..." and one fetch of the room decides.
        if (shownIndex !== askedIndex) return;
        sayVerdict('Checking...', 'muted');
        void fetchRoom(code).then(
          (fresh) => {
            if (shownIndex !== askedIndex) return;
            absorbEnvelope(fresh);
            if (shownIndex !== askedIndex) return;
            awaitingReply = false;
            // Recorded after all: leave it shut.
            if (alreadyAnswered(askedIndex)) {
              lockAsCounted(choice);
              return;
            }
            // The server's own state proves the question is still unanswered,
            // so giving it back cannot cost the player a second score.
            if (answerWindowOpen(askedIndex)) reopen(askedIndex, question, total);
            else settle(null, chosen);
          },
          () => {
            // Two failures in a row. Guessing either way can lie, so the card
            // stays shut and the poll loop closes it when the room answers.
            if (shownIndex !== askedIndex) return;
            awaitingReply = false;
            revealed = true;
            unresolvedIndex = askedIndex;
            view?.setProgress(0);
            view?.reveal(null, choice);
            sayVerdict('Checking...', 'muted');
          }
        );
      });
  }

  /**
   * Ends the question on screen. `answer` is null whenever the server never
   * told us which choice was right, and then nothing is revealed: a missed
   * question must not hand the answer to a player who did not earn it.
   */
  function settle(answer: number | null, pick: number | null, correct?: boolean): void {
    revealed = true;
    view?.setProgress(0);
    view?.reveal(answer, pick);
    if (answer !== null && correct === true) {
      // The hop itself arrives with the next poll, from the server's own step.
      sayVerdict('Correct!', 'ok');
    } else if (answer !== null) {
      // A wrong answer is a stumble and nothing else: no step, no penalty, so
      // last place keeps playing (the plan's design law 2).
      sayVerdict('Not this time. The green one is right.', 'bad');
      if (playerId) board?.stumble(playerId);
    } else if (pick !== null) {
      sayVerdict('That one did not count.', 'muted');
    } else {
      sayVerdict('Missed that one.', 'muted');
    }
  }

  // ---------- Treasure Dash: the three chests ----------

  /**
   * Three shut chests, one tap. All three already hold something (the round's
   * secret seed decided that before the round started), so picking chooses
   * which one you get rather than rolling one.
   */
  function openChests(index: number, expiresAt: number): void {
    if (!pickBox) return;
    pending = { index, expiresAt };
    pickSent = false;

    const row = h('div', { class: 'pick-row' });
    const buttons = [0, 1, 2].map((chest) => {
      const button = h('button', {
        class: 'pick-chest',
        type: 'button',
        'aria-label': `Open chest ${chest + 1}`,
      });
      button.append(
        h('span', { class: 'pick-lid' }),
        h('span', { class: 'pick-body' }),
        h('span', { class: 'pick-num', text: String(chest + 1) })
      );
      button.addEventListener('click', () => choosePick(chest, buttons));
      return button;
    });
    row.append(...buttons);

    pickBox.replaceChildren(
      h('p', { class: 'pick-lead', text: 'Right! Now open a chest.' }),
      row
    );
  }

  function choosePick(chest: number, buttons: HTMLButtonElement[]): void {
    if (!pending || pickSent || !playerId || !pickBox) return;
    const { index } = pending;
    pickSent = true;
    for (const button of buttons) button.disabled = true;
    buttons[chest]?.classList.add('pick-chest--mine');

    void sendPick(code, who(), index, chest)
      .then((envelope) => {
        absorbEnvelope(envelope);
        // The next question is already up: this reply belongs to the last one.
        if (pending?.index !== index) return;
        pending = null;

        // Refused: the window shut, or this chest was already opened. The
        // server withholds the outcome in that case and so does the screen.
        // Saying what was inside a chest that never opened would be a lie, and
        // a rich one: it is the only place the round's secret shows.
        if (envelope.accepted !== true || !envelope.outcome) {
          pickBox!.replaceChildren(
            h('p', { class: 'pick-lead pick-lead--muted', text: 'That chest did not open.' })
          );
          return;
        }

        const outcome = envelope.outcome;
        pickBox!.replaceChildren(
          h('p', { class: 'pick-lead pick-lead--won', text: prizeWords(outcome) })
        );
        board?.chest(playerId!, chest, outcome);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          signedOut();
          return;
        }
        if (pending?.index !== index) return;
        pending = null;
        // The request broke. The server may or may not have opened the chest,
        // and this device cannot tell, so it claims nothing: the next poll
        // carries the real score either way.
        pickBox!.replaceChildren(
          h('p', { class: 'pick-lead pick-lead--muted', text: 'That chest did not open.' })
        );
      });
  }

  /** Plain words for what the server said the chest held. */
  function prizeWords(outcome: NonNullable<RoomEnvelope['outcome']>): string {
    if (outcome.kind === 'points') return `${outcome.points} points!`;
    if (outcome.kind === 'swap') {
      const other = state?.players.find((player) => player.id === outcome.withPlayerId);
      return other ? `Swap! You traded scores with ${other.name}.` : 'Swap!';
    }
    const from = state?.players.find((player) => player.id === outcome.fromPlayerId);
    return from
      ? `Steal! You took ${outcome.points} points from ${from.name}.`
      : `Steal! You took ${outcome.points} points.`;
  }

  function closeChests(): void {
    pending = null;
    pickSent = false;
    pickBox?.replaceChildren();
  }

  // ---------- the clock ----------

  function tickRace(): void {
    if (!state || !view) return;
    const schedule = scheduleOf(state);
    if (!schedule || schedule.slotMs <= 0) return;
    const elapsed = serverTime() - schedule.startsAt;

    if (elapsed < 0) {
      const seconds = Math.max(1, Math.ceil(-elapsed / 1000));
      if (countdown) {
        countdown.hidden = false;
        countdown.textContent = String(seconds);
      }
      view.node.hidden = true;
      return;
    }
    if (countdown) countdown.hidden = true;
    view.node.hidden = false;

    const index = Math.floor(elapsed / schedule.slotMs);
    if (index >= state.questions.length) {
      view.lock();
      view.setProgress(0);
      if (countdown) {
        countdown.hidden = false;
        countdown.textContent = '';
      }
      // The last chest window can still be open after the last question.
      if (pending && serverTime() > pending.expiresAt) closeChests();
      return;
    }

    const withinSlot = elapsed - index * schedule.slotMs;

    if (index !== shownIndex) {
      shownIndex = index;
      chosen = null;
      revealed = false;
      correctChoice = null;
      awaitingReply = false;
      unresolvedIndex = null;
      closeChests();
      clearVerdict();
      const question: RoomQuestion = state.questions[index];
      view.show(question, { n: index + 1, total: state.questions.length });
    }

    // The chest window is the tail of a dash slot, and it closes on its own.
    if (pending && serverTime() > pending.expiresAt) closeChests();

    if (withinSlot < schedule.perQuestionMs) {
      if (!revealed) view.setProgress(1 - withinSlot / schedule.perQuestionMs);
      return;
    }

    // A question two failed requests left in the dark, whose window has now
    // shut. The poll never carried an answer for it, so nothing on this device
    // can say whether the server took the tap. Waiting longer cannot change
    // that, and the card must not sit on "Checking..." into the next question:
    // it closes here, counting nothing and revealing nothing.
    if (unresolvedIndex === index) {
      unresolvedIndex = null;
      settle(null, null);
      return;
    }

    // The window has shut. If an answer is still in flight its reply will
    // settle the card; otherwise it closes now, revealing only what the
    // server has already told us (nothing, for a question nobody answered).
    if (!revealed && !awaitingReply) settle(correctChoice, chosen);
  }

  // ---------- results ----------

  /**
   * What every result screen ends with in a class room: the points the lesson
   * has carried across its rounds, and the line that says another game is
   * coming.
   *
   * This is a LESSON scoreboard, not a round one, which is why a co-operative
   * round still shows it. Sky Tower's own numbers are not in it: the round's
   * blocks are the class's, and the class's total is the only tower number a
   * child is ever sent.
   */
  function paintLessonTail(parts: (Node | null)[]): void {
    if (!state) return;
    const totals = state.players.slice().sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
    parts.push(
      h('h2', { text: 'The whole lesson' }),
      h(
        'ul',
        { class: 'player-list ranking' },
        totals.map((player, index) =>
          h('li', {}, [
            h('span', {
              text: `${index + 1}. ${player.name}${player.id === playerId ? ' (you)' : ''}`,
            }),
            h('span', { class: 'rank-primary', text: `${player.total ?? 0} points` }),
          ])
        )
      ),
      h('p', { class: 'hint', text: 'Waiting for your teacher to pick the next game.' })
    );
  }

  const paintResults = (): void => {
    mode = 'results';
    window.clearInterval(raceTimer);
    dropBoard();
    closeChests();
    if (!state) return;

    const last = state.history[state.history.length - 1];
    const legacy = state.result;
    const schedule = scheduleOf(state);
    // Which game this ranking belongs to, and therefore what it is ranked ON.
    // Cloud Climb is ranked on clouds; everything else on points.
    const kind = last?.kind ?? schedule?.kind;
    // Until the server's immutable result lands, rank by the server's own rule
    // for this game, then by the ranking time, which charges every unanswered
    // question at the full budget. Sorting on raw totalMs put whoever answered
    // fewest questions on top.
    const ranking =
      last?.ranking ??
      legacy?.ranking ??
      provisionalRanking(
        state.players,
        kind,
        schedule?.questionCount ?? state.questions.length,
        schedule?.perQuestionMs ?? 0
      );

    const tie = last?.tie ?? legacy?.tie ?? false;
    const winnerId = last?.winnerId ?? legacy?.winnerId ?? state.winnerId ?? null;

    const winnerIds = new Set<string>();
    if (tie) {
      const top = ranking[0];
      for (const row of ranking) {
        if (top && rankedLevel(row, top, kind)) winnerIds.add(row.playerId);
      }
    } else if (winnerId) {
      winnerIds.add(winnerId);
    }

    const winnerRow = ranking.find((row) => winnerIds.has(row.playerId));
    const headline = tie
      ? "It's a tie!"
      : winnerIds.has(playerId ?? '')
        ? 'You win!'
        : winnerRow
          ? `${winnerRow.name} wins!`
          : 'Round over';

    // Sky Tower did not have places in it, so its result does not have a
    // placing. The child gets the one outcome the whole class shares and the
    // one number that was hers, and no list of anybody: the server sends her
    // an empty ranking for a tower round, and this is the screen that would
    // otherwise have drawn "Round over" over the top of it.
    const tower = last?.kind === 'tower' || (!last && kind === 'tower');
    const towerTotal = Math.max(0, state.towerTotal ?? 0);
    const towerTarget = state.round?.config.kind === 'tower' ? state.round.config.target : 0;
    const myBlocks = me()?.correct ?? 0;
    const myPoints = me()?.total ?? 0;
    if (tower) {
      const built = last?.won ?? towerTotal >= towerTarget;
      const towerFinal = h('div', { class: 'final' }, [
        h('p', {
          class: 'score',
          text: built ? 'The class built it!' : `So close: ${towerTotal} of ${towerTarget}`,
        }),
        h('p', {
          text: `The class built ${towerTotal} block${towerTotal === 1 ? '' : 's'} of ${towerTarget}.`,
        }),
        h('p', {
          text: `You added ${myBlocks} block${myBlocks === 1 ? '' : 's'} to the class tower.`,
        }),
      ]);
      const towerParts: (Node | null)[] = [towerFinal];
      if (state.teacherRoom && last) {
        towerParts.push(
          h('p', {
            class: 'hint round-line',
            text: `Round ${last.n} of this lesson · ${GAME_TITLES[last.kind]}`,
          })
        );
      }
      // NOT paintLessonTail. A co-operative round gets no ranked list of other
      // children on a child's device, and the lesson scoreboard is exactly that
      // list: it names everybody and orders them by points, which after a tower
      // round is mostly the tower (panel round 1, M2). The teacher's screen
      // keeps "Who built it" and "The whole lesson"; a child gets the class
      // total, her own blocks, and her own points. The server sends her nothing
      // else, so this is the render of an already-empty hand, not a promise the
      // client is keeping on its own.
      towerParts.push(
        h('h2', { text: 'Your lesson' }),
        h('p', { class: 'hint', text: `You have ${myPoints} point${myPoints === 1 ? '' : 's'} so far.` }),
        h('p', { class: 'hint', text: 'Waiting for your teacher to pick the next game.' })
      );
      stage.replaceChildren(...(towerParts.filter(Boolean) as Node[]));
      return;
    }

    const myPlace = ranking.findIndex((row) => row.playerId === playerId);
    const final = h('div', { class: 'final' }, [
      h('p', { class: 'score', text: headline }),
      myPlace >= 0
        ? h('p', { text: `You came ${ordinal(myPlace + 1)} of ${ranking.length}.` })
        : null,
    ]);

    const list = h(
      'ul',
      { class: 'player-list ranking' },
      ranking.map((row, index) => {
        const cell = rankingCell(row, kind);
        return h('li', { class: winnerIds.has(row.playerId) ? 'winner' : '' }, [
          h('span', {
            text: `${index + 1}. ${row.name}${row.playerId === playerId ? ' (you)' : ''}`,
          }),
          h(
            'span',
            { class: 'rank-values' },
            [
              h('span', { class: 'rank-primary', text: cell.primary }),
              cell.secondary ? h('span', { class: 'rank-secondary', text: cell.secondary }) : null,
            ].filter(Boolean) as Node[]
          ),
        ]);
      })
    );

    // Which round of the lesson this was. Rounds are open-ended (the teacher
    // starts as many as the lesson needs), so this counts up rather than
    // pretending to know a total.
    const roundLine =
      state.teacherRoom && last
        ? h('p', {
            class: 'hint round-line',
            text: `Round ${last.n} of this lesson · ${GAME_TITLES[last.kind]}${
              schedule?.questionCount
                ? ` · ${schedule.questionCount} question${schedule.questionCount === 1 ? '' : 's'}`
                : ''
            }`,
          })
        : null;

    const parts: (Node | null)[] = [final, roundLine, list];

    if (state.teacherRoom) {
      paintLessonTail(parts);
    } else {
      const again = h('button', { class: 'btn', type: 'button', text: 'Back to the games' });
      again.addEventListener('click', () => navigate('#/'));
      parts.push(h('div', { class: 'row' }, [again]));
    }

    stage.replaceChildren(...(parts.filter(Boolean) as Node[]));
    celebrate(final, state.set.level);
  };

  const paintClosed = (): void => {
    mode = 'closed';
    window.clearInterval(raceTimer);
    dropBoard();
    closeChests();
    stopPoll?.();
    stopPoll = null;

    // A lesson closed straight off a tower round still carries that round's
    // viewer rule, so every other child's total arrives here at zero: this
    // device was never sent them (panel round 1, M2). Ranking a list of zeroes
    // reads as "they scored nothing", which is worse than not drawing it, so a
    // child gets her own line and the teacher's screen keeps the scoreboard.
    const towerLast = state?.round?.config.kind === 'tower';
    const roster = state?.players ?? [];
    const totals = (towerLast ? roster.filter((p) => p.id === playerId) : roster)
      .slice()
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
    const home = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Back to Home',
    });
    home.addEventListener('click', () => navigate('#/'));

    const closing: Node[] = [
      h('div', { class: 'final' }, [h('p', { class: 'score', text: 'That is the lesson!' })]),
    ];
    if (totals.length > 0) {
      closing.push(
        h(
          'ul',
          { class: 'player-list ranking' },
          totals.map((player, index) =>
            h('li', { class: index === 0 ? 'winner' : '' }, [
              h('span', {
                text: `${index + 1}. ${player.name}${player.id === playerId ? ' (you)' : ''}`,
              }),
              h('span', { class: 'rank-primary', text: `${player.total ?? 0} points` }),
            ])
          )
        )
      );
    }
    closing.push(h('div', { class: 'row' }, [home]));
    stage.replaceChildren(...closing);
  };

  function ordinal(n: number): string {
    if (n === 1) return '1st';
    if (n === 2) return '2nd';
    if (n === 3) return '3rd';
    return `${n}th`;
  }

  // ---------- state plumbing ----------

  function absorbEnvelope(envelope: RoomEnvelope): void {
    // The guard comes FIRST, before this envelope's `createdAt`, `version`,
    // `set`, `phase` or `round` is read at all. A state whose model this build
    // does not know is not partially applied and not stored: the screen offers
    // a reload and stops.
    if (envelope.state && !knownModel(envelope.state)) {
      if (mode !== 'stale') paintStale();
      return;
    }

    // `version` only means anything inside ONE room. A code that is deleted and
    // handed out again starts a fresh room back at version 1, and a tab still
    // holding version 10 would ignore that room for good. `createdAt` is the
    // room's identity, so a state stamped with a different one is a different
    // room: it is taken whatever its version says.
    const stamp = envelope.state?.createdAt;
    const reborn =
      typeof stamp === 'number' && typeof incarnation === 'number' && stamp !== incarnation;

    // A reply to an answer can land after a poll that already carried a newer
    // version of the room. Taking its state would roll the screen backwards,
    // so an older envelope is dropped whole rather than half-applied.
    if (
      !reborn &&
      typeof envelope.version === 'number' &&
      typeof version === 'number' &&
      envelope.version < version
    ) {
      return;
    }

    if (reborn) {
      // Answer marks, the question on screen, a question left unresolved and
      // the card itself all belong to the room that is gone. Dropping the mode
      // too forces whichever screen comes next to be built from scratch.
      window.clearInterval(raceTimer);
      dropBoard();
      view = null;
      scoreOut = null;
      myBlocksOut = null;
      silhouetteOut = null;
      towerGoalOut = null;
      mode = 'looking';
      shownIndex = -1;
      chosen = null;
      revealed = false;
      correctChoice = null;
      awaitingReply = false;
      unresolvedIndex = null;
      pending = null;
    }

    if (typeof envelope.version === 'number') version = envelope.version;
    if (envelope.state) {
      state = envelope.state;
      if (typeof envelope.state.createdAt === 'number') incarnation = envelope.state.createdAt;
      applyLevel(state.set.level);
    }
    if (!state) return;

    // The name we hold is not in this room: a stale tab, a room that was
    // deleted and its code reused, or storage carried over from an old game.
    // Clear it and ask for a name again instead of parking on a dead lobby.
    if (playerId && !state.players.some((player) => player.id === playerId)) {
      playerId = null;
      memberKey = '';
      myName = '';
      recovered = false;
      forgetMembership(code);
      stopPoll?.();
      stopPoll = null;
      window.clearInterval(raceTimer);
      dropBoard();
      view = null;
      scoreOut = null;
      identity.replaceChildren();
      paintNameScreen();
      showError('This room does not know that name any more. Join again.');
      return;
    }

    // A recovered device learns its own name from the room rather than from
    // storage, so a rename (or a stale local copy) cannot mislabel the screen.
    const mine = me();
    if (mine && mine.name !== myName) myName = mine.name;

    if (scoreOut) scoreOut.textContent = String(mine?.score ?? 0);
    paintMyTower();

    // A question left in the dark by two failed requests. The poll is the only
    // thing still asking, so it is what closes it once the room's own state
    // shows the answer did land.
    if (unresolvedIndex !== null && unresolvedIndex === shownIndex) {
      if (alreadyAnswered(unresolvedIndex)) lockAsCounted(chosen);
    }

    const play = playPhaseOf(state);

    if (play === 'unknown') {
      if (mode !== 'stale') paintStale();
      return;
    }
    if (play === 'closed') {
      if (mode !== 'closed') paintClosed();
      paintIdentity();
      return;
    }
    if (play === 'results') {
      if (mode !== 'results') paintResults();
      paintIdentity();
      return;
    }
    if (play === 'round') {
      const key = roundKeyOf(state);
      if (mode !== 'round' || key !== roundKey) paintRoundShell();
      else refreshBoard(state);
      paintIdentity();
      return;
    }
    paintLobby();
    paintIdentity();
  }

  function beginPolling(): void {
    stopPoll?.();
    stopPoll = startPolling(code, {
      getVersion: () => version,
      // This device reads the room AS ITSELF. In a Sky Tower round that is what
      // gets this child her own block count back while everyone else's stays
      // zero; in every other round it changes nothing at all.
      getAuth: () => (playerId ? { playerId, memberKey } : undefined),
      onEnvelope: (envelope) => {
        clearTransientProblem();
        absorbEnvelope(envelope);
      },
      onError: (error) => {
        // The room is gone: deleted after its lesson, or timed out for
        // inactivity. Polling has already stopped itself, so drop the saved
        // player id and show the same dead end a bad code gets, instead of
        // promising to keep trying something that can never work.
        if (error instanceof RoomError && error.status === 404) {
          playerId = null;
          forgetMembership(code);
          paintNoRoom(`There is no room with code ${code}. Check the code and try again.`);
          return;
        }
        showError(`${error.message} Trying again...`);
      },
    });
  }

  /**
   * Ask the server whether this room exists BEFORE drawing a join screen for
   * it. A player who already has an id on this device skips the probe: the
   * poll itself is the check for them, and that is the path a reopened tab
   * takes straight back to its own bean.
   */
  function checkThenJoin(): void {
    paintLooking();
    void fetchRoom(code).then(
      (envelope) => {
        if (disposed) return;
        // The same guard as the poll's, and for the same reason: the probe
        // must not read `phase` off a room shape this build has never seen.
        if (envelope.state && !knownModel(envelope.state)) {
          paintStale();
          return;
        }
        // A room can take a new name whenever no round is running: the lobby
        // AND the results screen between games, which is what this sentence
        // used to promise while the join was refused there (D2). What is left
        // says the true thing for the state it is actually in.
        const play = envelope.state ? playPhaseOf(envelope.state) : 'unknown';
        // A class room between games takes a new name; everything else that is
        // not the lobby says the true thing for the state it is in.
        const betweenGames = play === 'results' && envelope.state?.teacherRoom === true;
        if (envelope.state && play !== 'lobby' && !betweenGames) {
          paintNoRoom(
            play === 'round'
              ? 'A round is playing right now. You can join the moment it ends.'
              : play === 'closed'
                ? 'That lesson is finished. Ask your teacher for a new room code.'
                : 'That race is finished. Ask for a fresh room code.'
          );
          return;
        }
        // Keep what the probe learned. The join screen needs the roster and
        // the room's own maxPlayers to say "This room is full (40 players)"
        // before a child types a name. `version` is deliberately NOT taken:
        // the first poll should fetch the whole state, not be told it is
        // unchanged against a version this screen has not drawn.
        if (envelope.state) state = envelope.state;
        paintNameScreen();
      },
      (error: Error) => {
        if (disposed) return;
        if (error instanceof RoomError && error.status === 404) {
          paintNoRoom(`There is no room with code ${code}. Check the code and try again.`);
          return;
        }
        // Anything else (offline, a 500) may well clear: let them try to join.
        paintNameScreen();
        showError(error.message);
      }
    );
  }

  if (playerId) {
    if (recovered) identity.textContent = `Playing as ${myName}.`;
    beginPolling();
  } else {
    checkThenJoin();
  }

  return teardown;
}

