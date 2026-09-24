// Tone Catcher, solo: `#/play/tone/<enc>`.
//
// A bean runs down a three-lane track. A word is spoken, three gates come at
// you with the candidates on them, and you steer into the lane you heard. Right
// lane: a hop, a confetti puff and a speed bonus. Wrong lane: a stumble, and a
// short slow (1.5 s at Chill, scaled with the Speed dial) that eats into the
// next gate.
//
// This file is the RULES and the wiring. Everything above the `--- rules ---`
// divider is pure and unit tested in the node environment: it must never touch
// the DOM at module level and must never statically import a scene, three, or a
// stylesheet. The two renderers (`tone-catcher-3d.ts` and `tone-catcher-css.ts`)
// are lazily imported, which is also what keeps `three` out of the index chunk.
//
// Room play is NOT in this file yet. See the TODO in
// `docs/research/2026-09-08-tone-catcher-notes.md` for the exact server delta.

import {
  buildToneRound,
  playableToneCards,
  readableEasyLanes,
  type ToneCard,
  type ToneQuestion,
} from '../../shared/tone-pairs';
import type { VocabSet } from '../../shared/types';
import { applyLevel, audioStatusLine } from '../controls';
import { navigate } from '../router';
import { speak } from '../tts';
import { h, isCjkSentence, notice, screen } from '../ui';
import { toneContour, toneWords } from './tone-contour';

// --- rules (pure) ------------------------------------------------------------

export type ToneMode = 'easy' | 'normal' | 'hard';

/** How long a gate takes to arrive, per the spec's difficulty ladder. */
export const GATE_MS: Record<ToneMode, number> = { easy: 6000, normal: 4000, hard: 3000 };

/** The beat between one gate resolving and the next one opening. */
export const GAP_MS = 500;

/** A miss slows the runner: no lane changes for this long. */
export const STUMBLE_MS = 1500;

/**
 * The Speed dial, slowest to fastest. A second axis on top of the difficulty
 * ladder: difficulty picks what a gate SHOWS, speed picks how fast it ARRIVES.
 */
export const SPEED_STOPS = ['Chill', 'Steady', 'Quick', 'Fast', 'Turbo'] as const;

export type SpeedStop = (typeof SPEED_STOPS)[number];

/** What each stop divides the gate time by, in stop order. */
export const SPEED_MULTIPLIERS: readonly number[] = [1, 1.5, 2, 2.5, 3];

/** Quick. The unscaled tempo (Chill) plays as too slow. */
export const DEFAULT_SPEED = 2;

/**
 * Turns anything at all into a real stop index. A hand-edited localStorage
 * entry, a missing key, a fraction or an old value falls back to the default
 * rather than handing the round a NaN gate time.
 */
export function speedIndex(value: unknown): number {
  const raw = typeof value === 'string' ? value.trim() : value;
  const n = typeof raw === 'number' || (typeof raw === 'string' && raw !== '') ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n < SPEED_STOPS.length ? n : DEFAULT_SPEED;
}

/** The name shown next to the dial, for the same forgiving input. */
export function speedName(value: unknown): SpeedStop {
  return SPEED_STOPS[speedIndex(value)];
}

/**
 * What a screen reader announces for a stop. The name alone ("Fast") does not
 * say how fast, so the multiplier rides along. Same wording as Cloud Climb.
 */
export function speedValueText(value: unknown): string {
  const index = speedIndex(value);
  return `${SPEED_STOPS[index]}, ${SPEED_MULTIPLIERS[index]} times speed`;
}

/** How long one gate takes at this difficulty AND this speed. */
export function scaledGateMs(mode: ToneMode, speed: unknown): number {
  return GATE_MS[mode] / SPEED_MULTIPLIERS[speedIndex(speed)];
}

/**
 * The stumble freeze rides the same divisor as the gate. An unscaled 1.5 s
 * freeze in front of a 1 s Turbo gate makes the gate after a miss literally
 * unanswerable, which turns one wrong lane into two.
 */
export function scaledStumbleMs(speed: unknown): number {
  return STUMBLE_MS / SPEED_MULTIPLIERS[speedIndex(speed)];
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

/**
 * The seconds in the hint line. One decimal for anything that is not a whole
 * number of seconds, and a singular "second" for the one stop that lands on 1.
 */
export function gateSecondsLabel(ms: number): string {
  const secs = ms / 1000;
  const shown = Number.isInteger(secs) ? String(secs) : secs.toFixed(1);
  return `${shown} ${Number(shown) === 1 ? 'second' : 'seconds'}`;
}

/** A round is 12 words, or the whole set when the set is shorter. */
export const MAX_ROUND = 12;

export const LANES = 3;

export const MODES: readonly ToneMode[] = ['easy', 'normal', 'hard'];

export function isToneMode(value: string): value is ToneMode {
  return (MODES as readonly string[]).includes(value);
}

export function roundLength(available: number, max = MAX_ROUND): number {
  return Math.max(0, Math.min(max, Math.floor(available)));
}

/**
 * Millisecond offset from the round start at which each gate opens. It takes
 * the SCALED gate time, so the Speed dial moves the schedule with it.
 */
export function gateSchedule(gateMs: number, count: number): number[] {
  const step = gateMs + GAP_MS;
  return Array.from({ length: Math.max(0, count) }, (_, i) => i * step);
}

/**
 * 0 to 4 extra points for committing early. `decidedMs` is how long after the
 * gate opened the player last changed lanes; `null` means they never moved, so
 * they get the point for being right and nothing for speed.
 */
export function speedBonus(decidedMs: number | null, gateMs: number): number {
  if (decidedMs === null || !(gateMs > 0)) return 0;
  const left = 1 - decidedMs / gateMs;
  return Math.max(0, Math.min(4, Math.round(4 * left)));
}

export function gatePoints(correct: boolean, decidedMs: number | null, gateMs: number): number {
  return correct ? 1 + speedBonus(decidedMs, gateMs) : 0;
}

export interface CatcherState {
  /** Which lane the bean is in, 0 to LANES - 1. */
  lane: number;
  /** Index of the gate in flight. */
  gate: number;
  /** Total gates in this round. */
  gates: number;
  /** Timestamp the current gate opened. */
  gateStart: number;
  /** Timestamp of the last lane change inside this gate, or null. */
  decidedAt: number | null;
  /** Lane changes are frozen until this timestamp (the stumble slow). */
  slowUntil: number;
  score: number;
  correct: number;
  streak: number;
  bestStreak: number;
  last: 'none' | 'hit' | 'miss';
  done: boolean;
}

export function startRound(gates: number, atMs: number, lane = 1): CatcherState {
  return {
    lane,
    gate: 0,
    gates: Math.max(0, gates),
    gateStart: atMs,
    decidedAt: null,
    slowUntil: 0,
    score: 0,
    correct: 0,
    streak: 0,
    bestStreak: 0,
    last: 'none',
    done: gates <= 0,
  };
}

/** Opens the gate the player is now facing. Called once per gate. */
export function openGate(state: CatcherState, atMs: number): CatcherState {
  if (state.done) return state;
  return { ...state, gateStart: atMs, decidedAt: null, last: 'none' };
}

/** Steer into a lane. Ignored while the runner is still recovering. */
export function moveTo(state: CatcherState, lane: number, atMs: number, lanes = LANES): CatcherState {
  if (state.done) return state;
  if (atMs < state.slowUntil) return state;
  if (!Number.isInteger(lane) || lane < 0 || lane >= lanes) return state;
  if (lane === state.lane) return state;
  return { ...state, lane, decidedAt: atMs };
}

/** Arrow keys: one lane left or right. */
export function nudge(state: CatcherState, dir: -1 | 1, atMs: number, lanes = LANES): CatcherState {
  return moveTo(state, Math.max(0, Math.min(lanes - 1, state.lane + dir)), atMs, lanes);
}

/** The gate reaches the bean. Scores it, and ends the round on the last gate. */
export function resolveGate(
  state: CatcherState,
  correctLane: number,
  atMs: number,
  gateMs: number,
  stumbleMs: number = STUMBLE_MS
): CatcherState {
  if (state.done) return state;
  const hit = state.lane === correctLane;
  const decided = state.decidedAt === null ? null : state.decidedAt - state.gateStart;
  const streak = hit ? state.streak + 1 : 0;
  const gate = state.gate + 1;
  return {
    ...state,
    gate,
    score: state.score + gatePoints(hit, decided, gateMs),
    correct: state.correct + (hit ? 1 : 0),
    streak,
    bestStreak: Math.max(state.bestStreak, streak),
    slowUntil: hit ? state.slowUntil : atMs + stumbleMs,
    last: hit ? 'hit' : 'miss',
    done: gate >= state.gates,
  };
}

/** Plain-language reason shown wherever Tone Catcher is offered but unplayable. */
export function toneCatcherDisabledReason(set: VocabSet): string | undefined {
  const playable = playableToneCards(set.items);
  if (playable.length >= 3) return undefined;
  return `Tone Catcher needs at least three words that have pinyin and a meaning. This set has ${playable.length}.`;
}

// --- the renderer contract ---------------------------------------------------

export interface GateResult {
  correct: boolean;
  correctLane: number;
}

/** What both renderers implement. The rules above drive it and nothing else. */
export interface CatcherScene {
  /** A new gate appears at the far end, carrying these lane labels. */
  showGate(labels: HTMLElement[]): void;
  /** 0 = the gate is at the horizon, 1 = it is on top of the bean. */
  setGateProgress(t: number): void;
  setLane(lane: number, animate: boolean): void;
  resolve(result: GateResult): void;
  clearGate(): void;
  resize(): void;
  dispose(): void;
  /**
   * Pixel readback for the render gate, installed only when `?probe=1` is in
   * the URL. Draw and read happen in the same task; see the kit notes.
   */
  probePixels?(want: number): { w: number; h: number; drawn: number; lum: number[] };
}

/**
 * How easy mode can label a gate on THIS set.
 *
 * `text` is the original: the meaning itself rides the gate. `number` is for a
 * set whose meanings are Chinese SENTENCES. Three of those cannot sit side by
 * side across a 390 px stage: the labels overlap as the gates scale up and the
 * narrowest lane clamps mid-clause, which was the round-1 finding left open.
 * So the gate carries a big 1, 2 or 3 and the sentences are read once, in full,
 * from a legend under the stage.
 */
export type EasyLaneStyle = 'text' | 'number';

/**
 * The decision, per SET rather than per gate: are the meanings in this set
 * Chinese sentences?
 *
 * A majority, not all of them. A real Chinese-definition set (fixture 78) has
 * short entries in it too (就业 / 找到工作。 is five characters), and a set that
 * flips to text labels for those rounds and numbers for the rest would change
 * shape under the child mid-game. One answer for the whole set.
 */
export function easyLaneStyle(items: readonly ToneCard[]): EasyLaneStyle {
  const meanings = items.map((item) => (item.en ?? '').trim()).filter((m) => m !== '');
  if (meanings.length === 0) return 'text';
  const sentences = meanings.filter(isCjkSentence).length;
  return sentences * 2 > meanings.length ? 'number' : 'text';
}

export interface ToneView {
  state: CatcherState;
  question: ToneQuestion | null;
  phase: 'run' | 'reveal' | 'over';
  mode: ToneMode;
  /**
   * The three meanings of the gate in flight, in lane order, when easy mode is
   * showing numbers on this set. `null` in every other mode and on every other
   * set, and the page then shows no legend at all.
   */
  legend: string[] | null;
}

export interface MountOpts {
  mode?: ToneMode;
  /** Stop index into SPEED_STOPS. Anything unusable becomes the default. */
  speed?: number;
  seed?: number;
  onUpdate?(view: ToneView): void;
  /** Injectable so a test can prove nothing spoke. Defaults to the app's TTS. */
  say?(zh: string): void;
}

export interface ToneGame {
  restart(mode?: ToneMode): void;
  /**
   * Steer into a lane from outside the stage. The legend rows use it, so a
   * tap on "2 让机器像人一样学习、思考和工作。" is the same move as running
   * the bean into lane 2.
   */
  pick(lane: number): void;
  /** Move the Speed dial. Restarts the round, exactly as Difficulty does. */
  setSpeed(index: number): void;
  /** Say the current word again. Wired to the big replay button. */
  replay(): void;
  dispose(): void;
}

// --- the wiring --------------------------------------------------------------

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** True when a key belongs to a form control rather than to the runner. */
function typingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}

function probeRequested(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  const hash = window.location.hash || '';
  const mark = hash.indexOf('?');
  const inHash = mark === -1 ? '' : hash.slice(mark + 1);
  try {
    return (
      new URLSearchParams(window.location.search || '').get('probe') === '1' ||
      new URLSearchParams(inHash).get('probe') === '1'
    );
  } catch {
    return false;
  }
}

/**
 * The mode the lanes can actually be READ in, which is not always the one the
 * player picked. Easy mode puts the meaning on the gate; when the meanings on
 * this round do not all read the same way (a set of Chinese definitions that
 * had to borrow an English filler), the odd lane out IS the answer, so the
 * round drops to the normal-mode label instead.
 */
function readableMode(question: ToneQuestion, mode: ToneMode): ToneMode {
  if (mode === 'easy' && !readableEasyLanes(question)) return 'normal';
  return mode;
}

/** The lane label for one option, in the mode the player picked. */
function laneLabel(
  question: ToneQuestion,
  lane: number,
  picked: ToneMode,
  style: EasyLaneStyle
): HTMLElement {
  const option = question.options[lane];
  const mode = readableMode(question, picked);
  const node = h('div', { class: `tc-gate-label tc-mode-${mode}` });

  if (mode === 'easy' && style === 'number') {
    node.append(h('span', { class: 'tc-lane-no', text: String(lane + 1) }));
  } else if (mode === 'easy') {
    node.append(
      h('span', {
        class: isCjkSentence(option.en) ? 'tc-gloss tc-zh-gloss' : 'tc-gloss',
        text: option.en,
      })
    );
  } else if (mode === 'normal') {
    node.append(h('span', { class: 'tc-zh', text: option.zh }));
  } else {
    node.append(
      toneContour(option.tones),
      h('span', { class: 'tc-py', text: option.pinyin })
    );
  }
  return node;
}

function laneName(question: ToneQuestion, lane: number, picked: ToneMode): string {
  const option = question.options[lane];
  const mode = readableMode(question, picked);
  if (mode === 'easy') return `Lane ${lane + 1}: ${option.en}`;
  if (mode === 'normal') return `Lane ${lane + 1}: ${option.zh}`;
  return `Lane ${lane + 1}: ${option.pinyin}, ${toneWords(option.tones)}`;
}

/**
 * Runs the game inside `el`. Chooses the 3D scene or the CSS twin by
 * `wantsFlat()`, builds the round, owns the clock, and reports every change
 * through `opts.onUpdate` so the page chrome stays dumb.
 */
export function mount(el: HTMLElement, set: VocabSet, opts: MountOpts = {}): ToneGame {
  const say = opts.say ?? ((zh: string) => void speak(zh));
  const cards = playableToneCards(set.items);
  // One answer for the whole set, decided before the first gate: a Chinese
  // definition set gets numbered gates plus the legend under the stage.
  const laneStyle = easyLaneStyle(cards);
  const probe = probeRequested();

  // The size is set inline as well as in tone-catcher.css: the stylesheet is in
  // a lazy chunk, and a canvas that is 0 px tall when the first frame draws is
  // exactly the blank-render failure the gate exists to catch.
  const stage = h('div', {
    class: 'kit-stage tc-stage',
    style: 'width:100%;min-height:240px',
  });
  const overlay = h('div', { class: 'kit-overlay tc-overlay' });
  const laneRow = h('div', { class: 'tc-lanes' });
  const laneButtons = Array.from({ length: LANES }, (_, i) =>
    h('button', {
      class: 'kit-hit tc-lane',
      type: 'button',
      'aria-label': `Lane ${i + 1}`,
    })
  );
  laneRow.append(...laneButtons);
  overlay.append(laneRow);
  el.replaceChildren(stage);

  let mode: ToneMode = opts.mode ?? 'normal';
  let speed = speedIndex(opts.speed);
  let scene: CatcherScene | null = null;
  let round: ToneQuestion[] = [];
  let question: ToneQuestion | null = null;
  let state = startRound(0, nowMs());
  let phase: ToneView['phase'] = 'run';
  let repeated = false;
  let raf = 0;
  let beat = 0;
  let disposed = false;
  /** Rounds started. The e2e harness counts restarts with it. */
  let begins = 0;

  /**
   * The legend rows for the gate in flight, or null when the gate is carrying
   * the meanings itself. `readableMode` is consulted too: a round that had to
   * fall back to the characters is not showing meanings anywhere, so a legend
   * of them would name the answer.
   */
  function legendRows(): string[] | null {
    if (laneStyle !== 'number' || !question) return null;
    if (readableMode(question, mode) !== 'easy') return null;
    return question.options.map((option) => option.en);
  }

  const emit = (): void =>
    opts.onUpdate?.({ state, question, phase, mode, legend: legendRows() });

  /** The one place the clock and the scoring agree on how long a gate is. */
  const gateMs = (): number => scaledGateMs(mode, speed);

  function paintLaneNames(): void {
    laneButtons.forEach((button, lane) => {
      button.classList.remove('tc-lane-right', 'tc-lane-wrong');
      button.classList.toggle('tc-lane-here', lane === state.lane);
      button.setAttribute(
        'aria-label',
        question ? laneName(question, lane, mode) : `Lane ${lane + 1}`
      );
    });
  }

  function choose(lane: number): void {
    if (disposed || phase !== 'run') return;
    const next = moveTo(state, lane, nowMs());
    if (next === state) return;
    state = next;
    scene?.setLane(state.lane, true);
    paintLaneNames();
    emit();
  }

  laneButtons.forEach((button, lane) => {
    button.addEventListener('click', () => choose(lane));
  });

  function onKey(event: KeyboardEvent): void {
    if (disposed || phase !== 'run') return;
    // The Speed dial is a range input: arrow keys belong to whatever the player
    // has focused, not to the runner. Without this the dial cannot be moved by
    // keyboard at all, and trying steers the bean instead.
    if (typingTarget(event.target)) return;
    if (event.key === 'ArrowLeft') choose(state.lane - 1);
    else if (event.key === 'ArrowRight') choose(state.lane + 1);
    else if (event.key >= '1' && event.key <= String(LANES)) choose(Number(event.key) - 1);
    else return;
    event.preventDefault();
  }
  window.addEventListener('keydown', onKey);

  const onResize = (): void => scene?.resize();
  window.addEventListener('resize', onResize);

  function sayWord(): void {
    if (question) say(question.zh);
  }

  function openNext(): void {
    if (disposed || state.done) return;
    const next = round[state.gate] ?? null;
    question = next;
    if (!next) {
      finish();
      return;
    }
    state = openGate(state, nowMs());
    phase = 'run';
    repeated = false;
    scene?.showGate(next.options.map((_, lane) => laneLabel(next, lane, mode, laneStyle)));
    scene?.setGateProgress(0);
    paintLaneNames();
    sayWord();
    emit();
  }

  function settle(): void {
    if (disposed || !question) return;
    const correctLane = question.correct;
    state = resolveGate(state, correctLane, nowMs(), gateMs(), scaledStumbleMs(speed));
    phase = state.done ? 'over' : 'reveal';
    scene?.resolve({ correct: state.last === 'hit', correctLane });

    laneButtons.forEach((button, lane) => {
      button.classList.toggle('tc-lane-right', lane === correctLane);
      button.classList.toggle(
        'tc-lane-wrong',
        state.last === 'miss' && lane === state.lane && lane !== correctLane
      );
    });
    emit();

    if (state.done) {
      window.clearTimeout(beat);
      beat = window.setTimeout(() => {
        if (disposed) return;
        scene?.clearGate();
        emit();
      }, GAP_MS);
      return;
    }
    window.clearTimeout(beat);
    beat = window.setTimeout(() => {
      if (disposed) return;
      scene?.clearGate();
      openNext();
    }, GAP_MS);
  }

  function finish(): void {
    phase = 'over';
    state = { ...state, done: true };
    emit();
  }

  function frame(): void {
    raf = requestAnimationFrame(frame);
    if (disposed || phase !== 'run' || !question) return;
    const t = (nowMs() - state.gateStart) / gateMs();
    if (t >= 1) {
      settle();
      return;
    }
    scene?.setGateProgress(Math.max(0, t));
    // Exactly one automatic repeat, and only for a player who has not moved.
    if (!repeated && t > 0.55 && state.decidedAt === null) {
      repeated = true;
      sayWord();
    }
  }

  function begin(nextMode?: ToneMode): void {
    begins += 1;
    if (nextMode) mode = nextMode;
    window.clearTimeout(beat);
    round = buildToneRound(cards, {
      lanes: LANES,
      seed: opts.seed ?? Math.floor(Math.random() * 2 ** 31),
      length: roundLength(cards.length),
    });
    state = startRound(round.length, nowMs());
    question = null;
    phase = 'run';
    scene?.clearGate();
    scene?.setLane(state.lane, false);
    paintLaneNames();
    emit();
    if (round.length === 0) {
      finish();
      return;
    }
    openNext();
  }

  // The render gate and the harness need a way in, and a WebGL drawing buffer
  // can only be read in the same task that drew it. This hook is installed ONLY
  // when `?probe=1` is in the URL, so a child on a normal link never gets it.
  if (probe) {
    (window as unknown as { __tone?: unknown }).__tone = {
      state: () => state,
      phase: () => phase,
      mode: () => mode,
      speed: () => speed,
      begins: () => begins,
      gateMs: () => gateMs(),
      /** The gate in flight, INCLUDING its answer. Test affordance only. */
      question: () => question,
      pick: (lane: number) => choose(lane),
      pixels: (want = 240) => scene?.probePixels?.(want) ?? null,
      flat: () => !scene?.probePixels,
    };
  }

  // The scene arrives asynchronously (both twins are lazy chunks). The round is
  // started only once it is here, so the first gate is never drawn into nothing.
  void (async () => {
    const { wantsFlat } = await import('../scene/webgl');
    const made = wantsFlat()
      ? (await import('./tone-catcher-css')).mountToneCatcherCss(stage, overlay, { probe })
      : await (await import('./tone-catcher-3d')).mountToneCatcher3d(stage, overlay, { probe });
    if (disposed) {
      made.dispose();
      return;
    }
    scene = made;
    begin();
  })().catch(async () => {
    // Contract fallback: a dead context or a failed import runs the flat twin
    // rather than leaving a blank stage.
    if (disposed) return;
    try {
      const made = (await import('./tone-catcher-css')).mountToneCatcherCss(stage, overlay, {
        probe,
      });
      if (disposed) {
        made.dispose();
        return;
      }
      scene = made;
      begin();
    } catch {
      el.append(notice('The track did not load. Try reloading the page.', 'warn'));
    }
  });

  raf = requestAnimationFrame(frame);

  return {
    restart(nextMode?: ToneMode) {
      if (disposed) return;
      if (scene) begin(nextMode);
      else if (nextMode) mode = nextMode;
    },
    pick(lane: number) {
      choose(lane);
    },
    setSpeed(index: number) {
      if (disposed) return;
      const next = speedIndex(index);
      if (next === speed) return;
      speed = next;
      if (scene) begin();
    },
    replay() {
      if (!disposed) sayWord();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(beat);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      delete (window as unknown as { __tone?: unknown }).__tone;
      scene?.dispose();
      scene = null;
    },
  };
}

// --- the page ----------------------------------------------------------------

const MODE_LABELS: Record<ToneMode, string> = {
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
};

// The seconds are no longer part of the sentence: the Speed dial changes them,
// and a hint that says 4 seconds while the gate takes 2 is worse than no hint.
const MODE_HINTS: Record<ToneMode, string> = {
  easy: 'Gates show the meaning.',
  normal: 'Gates show the characters.',
  hard: 'Gates show pinyin with the tone curve.',
};

/** Where the Speed dial is remembered between lessons. */
const SPEED_KEY = 'bvg.speed.tone.v1';

/** How long a burst of dial commits is allowed to run before one restart. */
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

/** Same shape as state.ts's safeGet/safeSet: the storage may not be there. */
function readSpeed(): number {
  try {
    return speedIndex(window.localStorage?.getItem(SPEED_KEY));
  } catch {
    return DEFAULT_SPEED;
  }
}

function writeSpeed(index: number): void {
  try {
    window.localStorage?.setItem(SPEED_KEY, String(index));
  } catch {
    // private mode / storage full: the dial simply does not stick
  }
}

export function renderToneCatcher(root: HTMLElement, set: VocabSet, encoded: string): () => void {
  applyLevel(set.level);

  const { root: page, body } = screen('Tone Catcher', { back: `#/set/${encoded}` });

  /** The same per-set decision the stage makes, for the hint line. */
  const pageLaneStyle = easyLaneStyle(playableToneCards(set.items));

  const blocked = toneCatcherDisabledReason(set);
  if (blocked) {
    body.append(notice(blocked, 'warn'));
    root.replaceChildren(page);
    return () => undefined;
  }

  const scoreOut = h('b', { text: '0' });
  const streakOut = h('b', { text: '0' });
  const gateOut = h('b', { text: '0' });
  const verdict = h('p', { class: 'verdict' });
  const hint = h('p', { class: 'hint tc-hint' });
  const stageHost = h('div', { class: 'tc-host' });
  /**
   * The three sentences, full width, under the stage. Only ever filled when
   * the gates are showing numbers; empty it is `hidden`, so no other set and
   * no other mode grows a strip of blank rows.
   */
  const legendHost = h('div', { class: 'tc-legend', hidden: 'hidden' });
  const finalHost = h('div', { class: 'tc-final' });
  const modeRow = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Difficulty' });

  let mode: ToneMode = 'normal';
  let speed = readSpeed();
  /** The stop the round now on screen was built with. */
  let roundSpeed = speed;
  let speedRestartTimer = 0;
  let tornDown = false;
  /**
   * Every adjustment key currently down on the dial, not just a flag. A player
   * can hold ArrowLeft and tap Shift, and a flag cleared by that unrelated
   * keyup would commit the round mid-hold (and blur the dial, so the rest of
   * the hold steers the runner instead).
   */
  const speedKeysDown = new Set<string>();
  let game: ToneGame | null = null;

  const replayButton = h('button', {
    class: 'btn btn-primary tc-replay',
    type: 'button',
    text: '🔊 Say it again',
  });
  replayButton.addEventListener('click', () => game?.replay());

  const speedOut = h('b', { class: 'tc-speed-name', text: speedName(speed) });
  const speedRange = h('input', {
    class: 'tc-speed-range',
    type: 'range',
    min: '0',
    max: String(SPEED_STOPS.length - 1),
    step: '1',
    value: String(speed),
    'aria-label': 'Speed',
    'aria-valuetext': speedValueText(speed),
  });
  const speedRow = h('label', { class: 'tc-speed' }, [
    h('span', { class: 'tc-speed-title', text: 'Speed' }),
    h('span', { class: 'tc-speed-end', 'aria-hidden': 'true', text: '🐢' }),
    speedRange,
    h('span', { class: 'tc-speed-end', 'aria-hidden': 'true', text: '🚀' }),
    speedOut,
  ]);

  /** The hint carries the seconds, so it has to be rebuilt on either axis. */
  function hintText(stop: number): string {
    // On a Chinese-definition set the easy gates carry a number, not the
    // meaning, so the stock easy hint would be describing a screen that is not
    // there. Every other mode and every other set is untouched.
    const what =
      mode === 'easy' && pageLaneStyle === 'number'
        ? 'Gates show a lane number. The meanings are listed below.'
        : MODE_HINTS[mode];
    return `${what} ${gateSecondsLabel(scaledGateMs(mode, stop))} each.`;
  }

  /** Dial position, readout, aria-valuetext and hint all say the same stop. */
  function paintSpeed(stop: number): void {
    speedRange.value = String(stop);
    speedRange.setAttribute('aria-valuetext', speedValueText(stop));
    speedOut.textContent = speedName(stop);
    hint.textContent = hintText(stop);
  }

  /** One restart for a whole gesture, and none at all if nothing changed. */
  function commitSpeed(): void {
    window.clearTimeout(speedRestartTimer);
    speedRestartTimer = 0;
    // A blur or keyup that lands after the screen was torn down must not
    // rebuild a game nobody is looking at (Cloud Climb guards the same way).
    if (tornDown || !speedRestartNeeded(speed, roundSpeed)) return;
    roundSpeed = speed;
    finalHost.replaceChildren();
    stageHost.hidden = false;
    replayButton.hidden = false;
    game?.setSpeed(speed);
    // The dial has just thrown the round away, so it also has to LET GO: while
    // it keeps focus every following arrow key goes back into the slider and a
    // keyboard player can never steer the runner again. A press that changed
    // nothing (an arrow at the end stop) keeps focus, because nothing happened.
    speedRange.blur();
  }

  // `input` fires on every pixel of a drag, so it only moves the label: a round
  // in progress must survive a brushed dial.
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
  speedRange.addEventListener('input', () => paintSpeed(speedIndex(speedRange.value)));
  speedRange.addEventListener('change', () => {
    const next = speedIndex(speedRange.value);
    paintSpeed(next);
    if (next !== speed) {
      speed = next;
      writeSpeed(next);
    }
    window.clearTimeout(speedRestartTimer);
    if (speedKeysDown.size > 0) return;
    speedRestartTimer = window.setTimeout(commitSpeed, SPEED_COALESCE_MS);
  });
  speedRange.addEventListener('keydown', (event) => {
    if (SPEED_KEYS.has(event.key)) speedKeysDown.add(event.key);
  });
  // The gesture ends when the LAST adjustment key comes up, so a keyup for a
  // key that was never holding the dial (Shift, Tab, a letter) ends nothing.
  // blur covers the release that never arrives, when focus leaves the dial (or
  // the tab) while a key is still down.
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

  function paintModes(): void {
    modeRow.replaceChildren(
      ...MODES.map((option) => {
        const button = h('button', {
          type: 'button',
          text: MODE_LABELS[option],
          'aria-pressed': String(option === mode),
        });
        button.addEventListener('click', () => {
          if (option === mode) return;
          mode = option;
          paintModes();
          hint.textContent = hintText(speed);
          finalHost.replaceChildren();
          stageHost.hidden = false;
          replayButton.hidden = false;
          game?.restart(mode);
        });
        return button;
      })
    );
  }

  /**
   * The rows are rebuilt only when the sentences change, so a tap does not land
   * on a button that was replaced under the finger inside one gate.
   */
  let legendShown: string[] | null = null;
  const legendButtons: HTMLButtonElement[] = [];

  function paintLegend(view: ToneView): void {
    const rows = view.phase === 'over' ? null : view.legend;
    // The stage shrinks on a phone while the rows are up, so all three fit
    // without scrolling. See `.tc-with-legend` in tone-catcher.css.
    page.classList.toggle('tc-with-legend', rows !== null);
    if (!rows) {
      legendHost.hidden = true;
      legendHost.replaceChildren();
      legendButtons.length = 0;
      legendShown = null;
      return;
    }
    if (!legendShown || legendShown.join('\u0000') !== rows.join('\u0000')) {
      legendButtons.length = 0;
      legendHost.replaceChildren(
        ...rows.map((text, lane) => {
          const button = h(
            'button',
            {
              class: 'tc-legend-row',
              type: 'button',
              'aria-label': `Lane ${lane + 1}: ${text}`,
            },
            [
              h('span', { class: 'tc-legend-no', 'aria-hidden': 'true', text: String(lane + 1) }),
              h('span', { class: 'tc-legend-text', text }),
            ]
          ) as HTMLButtonElement;
          button.addEventListener('click', () => game?.pick(lane));
          legendButtons.push(button);
          return button;
        })
      );
      legendShown = rows;
    }
    legendHost.hidden = false;
    legendButtons.forEach((button, lane) => {
      button.classList.toggle('tc-legend-here', lane === view.state.lane);
      button.classList.toggle(
        'tc-legend-right',
        view.phase === 'reveal' && view.question !== null && lane === view.question.correct
      );
      button.setAttribute('aria-pressed', String(lane === view.state.lane));
    });
  }

  function showEnd(state: CatcherState): void {
    stageHost.hidden = true;
    replayButton.hidden = true;
    verdict.textContent = '';

    const again = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Play again',
    });
    again.addEventListener('click', () => {
      finalHost.replaceChildren();
      stageHost.hidden = false;
      replayButton.hidden = false;
      game?.restart();
    });

    const pick = h('button', { class: 'btn btn-big', type: 'button', text: 'Pick another game' });
    pick.addEventListener('click', () => navigate(`#/set/${encoded}`));

    finalHost.replaceChildren(
      h('div', { class: 'final' }, [
        h('p', { class: 'score', text: `Score ${state.score}` }),
        h('p', {
          text: `${state.correct} of ${state.gates} gates · best streak ${state.bestStreak}`,
        }),
      ]),
      h('div', { class: 'row' }, [again, pick])
    );
  }

  function onUpdate(view: ToneView): void {
    scoreOut.textContent = String(view.state.score);
    streakOut.textContent = String(view.state.streak);
    gateOut.textContent = `${Math.min(view.state.gate + (view.phase === 'run' ? 1 : 0), view.state.gates)}/${view.state.gates}`;

    if (view.phase === 'reveal' && view.question) {
      const hitIt = view.state.last === 'hit';
      verdict.className = `verdict verdict-${hitIt ? 'ok' : 'bad'}`;
      verdict.textContent = hitIt
        ? `Yes! ${view.question.zh} ${view.question.pinyin}`
        : `That was ${view.question.zh} ${view.question.pinyin} (${view.question.en})`;
    } else if (view.phase === 'run') {
      verdict.className = 'verdict verdict-muted';
      verdict.textContent = 'Listen, then run into the right lane.';
    }

    paintLegend(view);

    if (view.phase === 'over' && !finalHost.firstChild) showEnd(view.state);
  }

  paintModes();
  paintSpeed(speed);

  body.append(
    h('div', { class: 'game-bar' }, [
      h('span', { class: 'stat' }, ['Score ', scoreOut]),
      h('span', { class: 'stat' }, ['Streak ', streakOut]),
      h('span', { class: 'stat' }, ['Gate ', gateOut]),
    ]),
    h('div', { class: 'row tc-controls' }, [modeRow, replayButton, speedRow]),
    hint,
    stageHost,
    legendHost,
    finalHost,
    verdict,
    h('p', {
      class: 'hint',
      text: 'Tap a lane, or use the left and right arrow keys.',
    }),
    audioStatusLine()
  );

  root.replaceChildren(page);
  // A hash route does not reset the scroll position, so a child who tapped
  // Play from halfway down a long set page on a phone lands with the whole
  // track below the fold. Every screen in the app has this, but this is the
  // one where it makes the game unplayable, so it is fixed here.
  window.scrollTo(0, 0);
  game = mount(stageHost, set, { mode, speed, onUpdate });

  return () => {
    tornDown = true;
    window.clearTimeout(speedRestartTimer);
    game?.dispose();
    game = null;
  };
}

