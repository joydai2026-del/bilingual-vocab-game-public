// Cloud Climb, solo: `#/play/climb/<enc>`.
//
// One child, one device, three CPU beans, no network past the page load. It is
// the same game the class plays, because it is literally the same reducers: the
// screen owns the clock and the drawing, `LocalRoom` owns the rules.

import type { CpuPace } from '../../shared/cpu';
import { perQuestionMsFor } from '../../shared/quiz';
import type { VocabSet } from '../../shared/types';
import { applyLevel, audioStatusLine, pinyinToggle } from '../controls';
import { celebrate } from '../feedback';
import { createBoard, type Board, type BoardPlayer } from '../scene/board';
import { h, notice, screen } from '../ui';
import { LocalRoom } from './local-room';
import { playableDirections, raceDisabledReason } from './race';
import { createQuizView, type QuizView } from './quizview';

/** Three classmates who are always in the room and never turn up late. */
const CPU_NAMES = ['Pip', 'Nori', 'Bao'];

const PACES: { pace: CpuPace; label: string }[] = [
  { pace: 'easy', label: 'Easy' },
  { pace: 'normal', label: 'Normal' },
  { pace: 'fast', label: 'Fast' },
];

/** Same reason Race is unplayable: a quiz needs two different answers. */
export function climbDisabledReason(set: VocabSet): string | undefined {
  return raceDisabledReason(set);
}

// --- speed -------------------------------------------------------------------

/**
 * The Speed slider's five stops, slowest first.
 *
 * Speed is a clock axis, not a difficulty axis: it divides the per-question
 * budget the round is built with, and nothing else. The CPU beans need no
 * adjustment because `cpuPlan` stores each move as a FRACTION of the budget
 * (src/shared/cpu.ts), so a shorter budget moves them in automatically.
 */
export const SPEED_STOPS: readonly { name: string; multiplier: number }[] = [
  { name: 'Chill', multiplier: 1 },
  { name: 'Steady', multiplier: 1.5 },
  { name: 'Quick', multiplier: 2 },
  { name: 'Fast', multiplier: 2.5 },
  { name: 'Turbo', multiplier: 3 },
];

/** Quick (2x). The shipped 1x tempo was too slow to hold a child's attention. */
export const DEFAULT_SPEED_INDEX = 2;

/** How long a burst of slider commits is allowed to run before one restart. */
const SPEED_COALESCE_MS = 250;

/** The keys a range input changes value on. Any of them can be held down. */
const SPEED_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

const SPEED_KEY = 'bvg.speed.climb.v1';

/**
 * A stored value turned back into a stop. Anything that is not one of the five
 * indexes (a stale key, a hand-edited string, a value from a future build with
 * more stops) falls back to the default rather than throwing or picking Chill.
 */
export function clampSpeedIndex(raw: unknown): number {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n >= SPEED_STOPS.length) return DEFAULT_SPEED_INDEX;
  return n;
}

/**
 * What a screen reader announces for a stop. The name alone ("Fast") does not
 * say how fast, so the multiplier rides along.
 */
export function speedValueText(index: number): string {
  const stop = SPEED_STOPS[clampSpeedIndex(index)];
  return `${stop.name}, ${stop.multiplier} times speed`;
}

/** The per-question budget this stop asks for, in whole ms. */
export function speedScaledMs(perQuestionMs: number, index: number): number {
  return Math.round(perQuestionMs / SPEED_STOPS[clampSpeedIndex(index)].multiplier);
}

/**
 * Whether a committed stop should throw the running round away. Equal stops
 * mean the round on screen was already built with that clock, so a restart
 * would cost the child their score and change nothing else. Exported because
 * this rule IS the gesture handling below, and a closure cannot be tested.
 */
export function speedRestartNeeded(committedIndex: number, roundIndex: number): boolean {
  return committedIndex !== roundIndex;
}

function readSpeedIndex(): number {
  try {
    return clampSpeedIndex(window.localStorage?.getItem(SPEED_KEY));
  } catch {
    return DEFAULT_SPEED_INDEX;
  }
}

function writeSpeedIndex(index: number): void {
  try {
    window.localStorage?.setItem(SPEED_KEY, String(index));
  } catch {
    // private mode / storage full: the choice simply does not survive a reload
  }
}

export function renderClimb(root: HTMLElement, set: VocabSet, encoded: string): () => void {
  applyLevel(set.level);

  const { root: page, body } = screen('Cloud Climb', { back: `#/set/${encoded}` });
  const directions = playableDirections(set);

  // Reachable by pasting a play link straight into the address bar; the set
  // page already disables the button.
  if (directions.length === 0) {
    body.append(notice(climbDisabledReason(set)!, 'warn'));
    root.replaceChildren(page);
    return () => undefined;
  }

  const basePerQuestionMs = perQuestionMsFor(set.level);
  const scoreOut = h('b', { text: '0' });
  const stepOut = h('b', { text: '0' });
  const countdown = h('div', { class: 'countdown' });
  const boardSlot = h('div', { class: 'solo-board' });
  const verdict = h('p', { class: 'verdict' });
  const stage = h('div');
  const paceRow = h('div', { class: 'segmented' });
  const speedRange = h('input', {
    type: 'range',
    min: '0',
    max: String(SPEED_STOPS.length - 1),
    step: '1',
    'aria-label': 'Speed',
  });
  const speedOut = h('b', { class: 'speed-name' });

  let pace: CpuPace = 'normal';
  let speedIndex = readSpeedIndex();
  /** The stop the round now on screen was built with. */
  let roundSpeedIndex = speedIndex;
  let speedRestartTimer = 0;
  /**
   * Every adjustment key currently down on the slider, not just a flag. A
   * player can hold ArrowLeft and tap Shift, and a flag cleared by that
   * unrelated keyup would restart the round in the middle of the hold.
   */
  const speedKeysDown = new Set<string>();
  let room: LocalRoom | null = null;
  let view: QuizView | null = null;
  let board: Board | null = null;
  let boardGeneration = 0;
  let timer = 0;
  let shownIndex = -1;
  let revealed = false;
  let finished = false;
  let disposed = false;
  let lastSteps = new Map<string, number>();

  const stopTimer = (): void => window.clearInterval(timer);

  const teardown = (): void => {
    disposed = true;
    stopTimer();
    window.clearTimeout(speedRestartTimer);
    board?.dispose();
    board = null;
  };

  function sayVerdict(text: string, tone: 'ok' | 'bad' | 'muted'): void {
    verdict.className = `verdict verdict-${tone}`;
    verdict.textContent = text;
  }

  function paintPaces(): void {
    paceRow.replaceChildren(
      ...PACES.map((option) => {
        const button = h('button', {
          type: 'button',
          text: option.label,
          'aria-pressed': String(option.pace === pace),
        });
        button.addEventListener('click', () => {
          if (option.pace === pace) return;
          pace = option.pace;
          paintPaces();
          start();
        });
        return button;
      })
    );
  }

  /** Slider position, readout and aria-valuetext all say the same stop. */
  function paintSpeed(index: number): void {
    const stop = SPEED_STOPS[index];
    speedRange.value = String(index);
    speedRange.setAttribute('aria-valuetext', speedValueText(index));
    speedOut.textContent = stop.name;
  }

  /** One restart for a whole gesture, and none at all if nothing changed. */
  function commitSpeed(): void {
    window.clearTimeout(speedRestartTimer);
    speedRestartTimer = 0;
    if (disposed || !speedRestartNeeded(speedIndex, roundSpeedIndex)) return;
    start();
  }

  // `input` fires on every pixel of a drag, so it only moves the label: a round
  // in progress must survive a brushed slider.
  //
  // `change` is NOT once-per-gesture. A drag commits on release, but Chromium
  // fires `input` AND `change` on every value-changing keydown, so a held arrow
  // key commits a whole burst of stops and a naive handler would restart the
  // round once per stop crossed. So a commit only ARMS a restart, and the
  // restart is dropped entirely when the gesture settles back on the stop the
  // running round was already built with.
  //
  // The two gestures need different end-of-gesture signals. A pointer drag has
  // none, so it is coalesced on a timer. A held key HAS one, and needs it: the
  // OS delays the first auto-repeat to about 500 ms, which is longer than any
  // inactivity window, so a timer alone restarts once mid-hold and again on the
  // next repeat. The keyboard path therefore waits for the key to come up.
  speedRange.addEventListener('input', () => paintSpeed(clampSpeedIndex(speedRange.value)));
  speedRange.addEventListener('change', () => {
    const next = clampSpeedIndex(speedRange.value);
    paintSpeed(next);
    if (next !== speedIndex) {
      speedIndex = next;
      writeSpeedIndex(next);
    }
    window.clearTimeout(speedRestartTimer);
    if (speedKeysDown.size > 0) return;
    speedRestartTimer = window.setTimeout(commitSpeed, SPEED_COALESCE_MS);
  });
  speedRange.addEventListener('keydown', (event) => {
    if (SPEED_KEYS.has(event.key)) speedKeysDown.add(event.key);
  });
  // The gesture ends when the LAST adjustment key comes up, so a keyup for a
  // key that was never holding the slider (Shift, Tab, a letter) ends nothing.
  // blur covers the release that never arrives, when focus leaves the slider
  // (or the tab) while a key is still down.
  speedRange.addEventListener('keyup', (event) => {
    if (!speedKeysDown.delete(event.key)) return;
    if (speedKeysDown.size > 0) return;
    commitSpeed();
  });
  speedRange.addEventListener('blur', () => {
    if (speedKeysDown.size === 0) return;
    speedKeysDown.clear();
    commitSpeed();
  });

  function beans(): BoardPlayer[] {
    const current = room?.state();
    if (!current) return [];
    return current.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      colorIndex: index,
      step: player.step,
      score: player.score,
      isMe: player.id === room?.myId,
    }));
  }

  async function buildBoard(height: number): Promise<void> {
    const mine = ++boardGeneration;
    board?.dispose();
    board = null;
    const next = await createBoard(boardSlot, 'climb', { height, compact: false });
    if (disposed || mine !== boardGeneration) {
      next.dispose();
      return;
    }
    board = next;
    board.setPlayers(beans());
  }

  /** A fresh round: new seed, new question order, the CPUs replanned. */
  function start(): void {
    stopTimer();
    roundSpeedIndex = speedIndex;
    finished = false;
    shownIndex = -1;
    revealed = false;
    verdict.textContent = '';

    const now = Date.now();
    room = new LocalRoom({
      set,
      kind: 'climb',
      myName: 'You',
      cpuNames: CPU_NAMES,
      pace,
      perQuestionMs: speedScaledMs(basePerQuestionMs, speedIndex),
      directions,
      seed: `solo:${now}:${Math.random().toString(36).slice(2)}`,
      now,
    });

    const round = room.state().round!;
    lastSteps = new Map(room.state().players.map((player) => [player.id, player.step]));
    scoreOut.textContent = '0';
    stepOut.textContent = '0';

    view = createQuizView(set, onChoose);
    view.node.hidden = true;
    stage.replaceChildren(countdown, view.node, verdict);

    void buildBoard(Math.max(1, round.questionCount));

    timer = window.setInterval(tick, 100);
    tick();
  }

  function onChoose(choice: number): void {
    if (!room || shownIndex < 0 || revealed) return;
    const result = room.answer(shownIndex, choice, Date.now());
    revealed = true;
    view?.setProgress(0);

    if (!result.accepted) {
      // The window shut between the tap and this line, or the question was
      // already answered. Nothing is revealed, exactly as the room behaves.
      view?.reveal(null, choice);
      sayVerdict('That one did not count.', 'muted');
      return;
    }

    view?.reveal(result.correctChoice, choice);
    const mine = room.myPlayer();
    scoreOut.textContent = String(mine?.score ?? 0);
    stepOut.textContent = String(mine?.step ?? 0);

    if (result.correct) {
      sayVerdict('Correct! Up you go.', 'ok');
      board?.hop(room.myId, mine?.step ?? 0);
    } else {
      sayVerdict('Not this time. The green one is right.', 'bad');
      board?.stumble(room.myId);
    }
    refreshBoard();
  }

  /** Slides every bean to where the rules put it, hopping the ones that moved. */
  function refreshBoard(): void {
    if (!board || !room) return;
    board.setPlayers(beans());
    for (const player of room.state().players) {
      const before = lastSteps.get(player.id);
      if (before !== undefined && player.step > before && player.id !== room.myId) {
        board.hop(player.id, player.step);
      }
      lastSteps.set(player.id, player.step);
    }
  }

  function tick(): void {
    if (!room || !view) return;
    const now = Date.now();
    room.tick(now);
    const current = room.state();
    const round = current.round;
    if (!round) return;

    if (current.phase !== 'round') {
      // The tick that ends the round also applies the CPUs' last answers, so
      // the board is painted BEFORE the ranking is printed under it. Without
      // this the two disagreed about any bean whose last answer landed in the
      // same 100ms tick that ended the round.
      if (!finished) {
        refreshBoard();
        finish();
      }
      return;
    }

    const elapsed = now - round.startsAt;
    if (elapsed < 0) {
      countdown.hidden = false;
      countdown.textContent = String(Math.max(1, Math.ceil(-elapsed / 1000)));
      view.node.hidden = true;
      return;
    }
    countdown.hidden = true;
    view.node.hidden = false;

    const index = Math.floor(elapsed / round.slotMs);
    if (index >= current.questions.length) {
      view.lock();
      view.setProgress(0);
      return;
    }

    if (index !== shownIndex) {
      shownIndex = index;
      revealed = false;
      verdict.textContent = '';
      view.show(current.questions[index], { n: index + 1, total: current.questions.length });
    }

    const withinSlot = elapsed - index * round.slotMs;
    if (withinSlot < round.perQuestionMs) {
      if (!revealed) view.setProgress(1 - withinSlot / round.perQuestionMs);
    } else if (!revealed) {
      revealed = true;
      view.setProgress(0);
      view.reveal(null, null);
      sayVerdict('Missed that one.', 'muted');
    }

    refreshBoard();
  }

  function finish(): void {
    finished = true;
    stopTimer();
    if (!room) return;
    const current = room.state();
    const result = current.history[current.history.length - 1];
    const ranking = result?.ranking ?? [];
    const myPlace = ranking.findIndex((row) => row.playerId === room?.myId);
    const won = result?.winnerId === room.myId;

    const final = h('div', { class: 'final' }, [
      h('p', {
        class: 'score',
        text: won ? 'You reached the top first!' : result?.tie ? "It's a tie!" : 'Round over',
      }),
      myPlace >= 0
        ? h('p', { text: `You came ${myPlace + 1} of ${ranking.length}.` })
        : null,
    ]);

    const list = h(
      'ul',
      { class: 'player-list ranking' },
      ranking.map((row, index) =>
        h('li', { class: index === 0 ? 'winner' : '' }, [
          h('span', {
            text: `${index + 1}. ${row.name}${row.playerId === room?.myId ? ' (you)' : ''}`,
          }),
          h('span', { text: `${row.step ?? 0} up · ${row.score}` }),
        ])
      )
    );

    const again = h('button', { class: 'btn btn-primary btn-big', type: 'button', text: 'Play again' });
    again.addEventListener('click', start);

    stage.replaceChildren(final, list, h('div', { class: 'row' }, [again]));
    celebrate(final, set.level);
  }

  paintPaces();
  paintSpeed(speedIndex);
  body.append(
    h('div', { class: 'game-bar' }, [
      h('span', { class: 'stat' }, ['Score ', scoreOut]),
      h('span', { class: 'stat' }, ['Clouds ', stepOut]),
      pinyinToggle(() => {
        // Repaint the question with or without pinyin, never mid-reveal.
        const current = room?.state();
        if (!revealed && current && shownIndex >= 0 && shownIndex < current.questions.length) {
          view?.show(current.questions[shownIndex], {
            n: shownIndex + 1,
            total: current.questions.length,
          });
        }
      }),
    ]),
    h('div', { class: 'row' }, [h('span', { class: 'hint', text: 'How quick are they?' }), paceRow]),
    h('div', { class: 'row' }, [
      h('span', { class: 'hint', text: 'How fast is the clock?' }),
      h('span', { class: 'speed' }, [
        h('span', { class: 'speed-end', text: '🐢', 'aria-hidden': 'true' }),
        speedRange,
        h('span', { class: 'speed-end', text: '🚀', 'aria-hidden': 'true' }),
        speedOut,
      ]),
    ]),
    boardSlot,
    stage,
    audioStatusLine()
  );

  root.replaceChildren(page);
  start();

  return teardown;
}

