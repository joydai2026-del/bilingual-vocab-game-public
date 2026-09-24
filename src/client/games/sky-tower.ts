// Sky Tower, solo: `#/play/sky-tower/<enc>`.
//
// One question at a time, one block per correct answer, three minutes to touch
// the cloud line. Nothing is lost for a wrong answer: it costs two seconds and
// the tower keeps every block it has. That is the whole design, and it is why
// this is the game a class plays together (see the room TODO in
// docs/research/2026-09-08-sky-tower-notes.md).
//
// The split, per the kit contract: `src/shared/sky-tower.ts` owns every number,
// this file owns the screen and the loop, and the two renderers (3D and the CSS
// twin) are told what to draw and decide nothing.

import { buildQuestions } from '../../shared/quiz';
import {
  ROUND_MS,
  TOWER_LEVELS,
  type TowerBest,
  type TowerLevel,
  type TowerState,
  betterRun,
  createTower,
  earnBlock,
  formatClock,
  isPaused,
  missBlock,
  msLeft,
  targetBlocks,
  tickTower,
  towerOutcome,
} from '../../shared/sky-tower';
import type { QuizQuestion, VocabSet } from '../../shared/types';
import { applyLevel, audioStatusLine, pinyinToggle } from '../controls';
import { celebrate } from '../feedback';
import { beanColor } from '../scene/palette';
import '../scene/kit.css';
import { wantsFlat } from '../scene/webgl';
import { navigate } from '../router';
import { h, notice, screen } from '../ui';
import { raceDisabledReason, playableDirections } from './race';
import { createQuizView, type QuizView } from './quizview';
import type { TowerScene } from './sky-tower-3d';
import { mountTowerFlat } from './sky-tower-css';
import './sky-tower.css';

/** Same reason Race is unplayable: a quiz needs two different answers. */
export function skyTowerDisabledReason(set: VocabSet): string | undefined {
  return raceDisabledReason(set);
}

const BEST_KEY = 'bvg.skytower.best.v1';

/** How long the right answer stays on screen after a correct tap. */
const CORRECT_GAP_MS = 700;

const LEVEL_LABELS: Record<TowerLevel, string> = {
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
};

type BestByLevel = Partial<Record<TowerLevel, TowerBest>>;

function readBests(): BestByLevel {
  try {
    const raw = window.localStorage.getItem(BEST_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: BestByLevel = {};
    for (const level of TOWER_LEVELS) {
      const row = (parsed as Record<string, unknown>)[level];
      if (row && typeof row === 'object') {
        const { ms, target } = row as { ms?: unknown; target?: unknown };
        if (typeof ms === 'number' && typeof target === 'number' && ms > 0) {
          out[level] = { ms, target };
        }
      }
    }
    return out;
  } catch {
    // Private mode, or somebody has been editing localStorage by hand. Either
    // way a missing record is not a reason to refuse to play.
    return {};
  }
}

function writeBests(bests: BestByLevel): void {
  try {
    window.localStorage.setItem(BEST_KEY, JSON.stringify(bests));
  } catch {
    // Storage full or blocked: the run still counts, it just is not remembered.
  }
}

export interface SkyTowerOptions {
  /** The encoded set, for the "Pick another game" link back to the set page. */
  encoded: string;
  /** Force the CSS twin. Defaults to what the URL and the device say. */
  flat?: boolean;
}

/**
 * Draws Sky Tower into `el` and returns the teardown the router calls when the
 * hash changes.
 */
export function mount(el: HTMLElement, set: VocabSet, opts: SkyTowerOptions): () => void {
  applyLevel(set.level);

  const { root: page, body } = screen('Sky Tower', { back: `#/set/${opts.encoded}` });

  // Reachable by pasting a play link straight into the address bar; the set
  // page already disables the button.
  const directions = playableDirections(set);
  if (directions.length === 0) {
    body.append(notice(skyTowerDisabledReason(set)!, 'warn'));
    el.replaceChildren(page);
    return () => undefined;
  }

  const flat = opts.flat ?? wantsFlat();

  const blocksOut = h('b', { text: '0' });
  const targetOut = h('b', { text: '0' });
  const clockOut = h('b', { class: 'tower-clock', text: formatClock(ROUND_MS) });
  const bestOut = h('span', { class: 'hint' });
  const levelRow = h('div', { class: 'segmented', role: 'group', 'aria-label': 'How tall' });
  const stageBox = h('div', { class: 'kit-stage tower-stage' });
  const overlay = h('div', { class: 'kit-overlay' });
  const verdict = h('p', { class: 'verdict' });
  const stage = h('div');

  let level: TowerLevel = 'normal';
  let bests = readBests();
  let state: TowerState = createTower({ target: targetBlocks(level), now: Date.now() });
  let questions: QuizQuestion[] = [];
  let asked = 0;
  let current: QuizQuestion | null = null;
  let view: QuizView | null = null;
  let scene: TowerScene | null = null;
  let sceneGeneration = 0;
  let drawn = 0;
  let gateUntil = 0;
  let finished = false;
  let disposed = false;
  let timer = 0;

  const colorFor = (index: number): string => beanColor(index).fill;

  function sayVerdict(text: string, tone: 'ok' | 'bad' | 'muted'): void {
    verdict.className = `verdict verdict-${tone}`;
    verdict.textContent = text;
  }

  function paintBest(): void {
    const best = bests[level];
    const target = targetBlocks(level);
    bestOut.textContent =
      best && best.target === target ? `Best: ${formatClock(best.ms)}` : 'Best: not yet';
  }

  function paintLevels(): void {
    levelRow.replaceChildren(
      ...TOWER_LEVELS.map((option) => {
        const button = h('button', {
          type: 'button',
          text: LEVEL_LABELS[option],
          'aria-pressed': String(option === level),
        });
        button.addEventListener('click', () => {
          if (option === level) return;
          level = option;
          paintLevels();
          start();
        });
        return button;
      })
    );
  }

  /** Tears the scene down and builds the one this run needs. */
  function buildScene(target: number): void {
    const mine = ++sceneGeneration;
    scene?.dispose();
    scene = null;
    drawn = 0;
    stageBox.replaceChildren();
    stageBox.classList.remove('kit-sky-day', 'kit-sky-sunset');
    overlay.replaceChildren();
    stageBox.append(overlay);

    if (flat) {
      scene = mountTowerFlat(stageBox, overlay, { target, cloudLabel: `${target} blocks` });
      return;
    }

    void import('./sky-tower-3d')
      .then(({ mountTower3d }) => mountTower3d(stageBox, overlay, { target, cloudLabel: `${target} blocks` }))
      .then((built) => {
        if (disposed || mine !== sceneGeneration) {
          built.dispose();
          return;
        }
        scene = built;
        // Whatever landed while three was still downloading is painted at once,
        // with no animation, so the tower is never short of what the rules say.
        if (state.placed.length > 0) {
          scene.setBlocks(state.placed.map((_, i) => colorFor(i)));
          drawn = state.placed.length;
        }
      })
      .catch(() => {
        // The contract's fallback: a failed chunk or a dead context runs the
        // twin rather than leaving an empty sky.
        if (disposed || mine !== sceneGeneration) return;
        scene = mountTowerFlat(stageBox, overlay, { target, cloudLabel: `${target} blocks` });
        if (state.placed.length > 0) {
          scene.setBlocks(state.placed.map((_, i) => colorFor(i)));
          drawn = state.placed.length;
        }
      });
  }

  /** A fresh pack of questions. Called again when the set has been worked through. */
  function reshuffle(): void {
    questions = buildQuestions(set, {
      directions,
      seed: (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
    });
    asked = 0;
  }

  function showNext(): void {
    if (!view || finished) return;
    if (questions.length === 0 || asked >= questions.length) reshuffle();
    if (questions.length === 0) return;
    current = questions[asked];
    view.node.hidden = false;
    view.show(current, { n: asked + 1, total: questions.length });
    asked += 1;
  }

  function onChoose(choice: number): void {
    if (!current || finished) return;
    const now = Date.now();
    const right = choice === current.answer;

    view?.reveal(current.answer, choice);
    current = null;

    if (right) {
      // The block belongs to whoever earned it. Solo has one builder, so the
      // index is used instead of an owner and the tower comes out a rainbow;
      // in a room this is the player's own colour (see the room TODO).
      state = earnBlock(state, { owner: 'me', colorIndex: state.correct }, now);
      sayVerdict('Up it goes!', 'ok');
      gateUntil = now + CORRECT_GAP_MS;
    } else {
      state = missBlock(state, now);
      sayVerdict('Not that one. Nothing falls: the green one is right.', 'bad');
      gateUntil = state.pausedUntil;
    }
  }

  function tick(): void {
    if (finished) return;
    const now = Date.now();
    state = tickTower(state, now);

    // Blocks that landed since the last frame, in order.
    while (drawn < state.placed.length) {
      scene?.drop(drawn, drawn, colorFor(drawn));
      drawn += 1;
    }

    blocksOut.textContent = String(state.placed.length);
    const left = msLeft(state, now);
    clockOut.textContent = formatClock(left);
    clockOut.classList.toggle('low', left <= 30_000);
    view?.setProgress(left / ROUND_MS);

    if (state.endedAt !== null) {
      finish();
      return;
    }

    if (!current && now >= gateUntil && !isPaused(state, now)) {
      verdict.textContent = '';
      showNext();
    }
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    window.clearInterval(timer);
    view?.lock();
    view?.setProgress(0);

    const out = towerOutcome(state);
    if (out.won) {
      scene?.finish();
      bests = { ...bests, [level]: betterRun(bests[level] ?? null, { ms: out.ms, target: out.target }) };
      writeBests(bests);
      paintBest();
    }

    const headline = out.won
      ? `The tower touched the clouds! ${out.height} blocks.`
      : `Time! The tower reached ${out.height} of ${out.target} blocks.`;

    const final = h('div', { class: 'final' }, [
      h('p', { class: 'score', text: headline }),
      h('p', { text: `Height ${out.height} blocks · Time ${formatClock(out.ms)}` }),
      h('p', {
        class: 'hint',
        text: `${state.correct} right, ${state.wrong} wrong. A wrong answer never costs a block.`,
      }),
      out.won && bests[level] ? h('p', { class: 'hint', text: `Best at this height: ${formatClock(bests[level]!.ms)}` }) : null,
    ]);

    const again = h('button', { class: 'btn btn-primary btn-big', type: 'button', text: 'Play again' });
    again.addEventListener('click', start);

    const another = h('button', { class: 'btn btn-big', type: 'button', text: 'Pick another game' });
    another.addEventListener('click', () => navigate(`#/set/${opts.encoded}`));

    stage.replaceChildren(final, h('div', { class: 'row' }, [again, another]));
    // The stage sticks to the top of a phone screen and the question card is
    // scrolled well below it by the time the last block lands, so the end
    // screen would otherwise open half-hidden behind the tower.
    try {
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch {
      window.scrollTo(0, 0);
    }
    celebrate(final, set.level);
  }

  function start(): void {
    window.clearInterval(timer);
    finished = false;
    current = null;
    gateUntil = 0;

    const target = targetBlocks(level);
    state = createTower({ target, now: Date.now() });
    targetOut.textContent = String(target);
    blocksOut.textContent = '0';
    clockOut.textContent = formatClock(ROUND_MS);
    clockOut.classList.remove('low');
    verdict.textContent = '';
    paintBest();

    reshuffle();
    buildScene(target);

    view = createQuizView(set, onChoose);
    stage.replaceChildren(view.node, verdict);
    showNext();

    timer = window.setInterval(tick, 80);
    tick();
  }

  paintLevels();
  body.append(
    h('div', { class: 'game-bar tower-bar' }, [
      h('span', { class: 'stat' }, ['Blocks ', blocksOut, ' / ', targetOut]),
      h('span', { class: 'stat' }, ['Time ', clockOut]),
      bestOut,
      pinyinToggle(() => {
        // Repaint the open question with or without pinyin, never mid-reveal.
        if (current && view) view.show(current, { n: asked, total: questions.length });
      }),
    ]),
    h('div', { class: 'row' }, [
      h('span', { class: 'hint', text: 'How tall is the tower?' }),
      levelRow,
    ]),
    h('div', { class: 'tower-play' }, [stageBox, stage]),
    audioStatusLine()
  );

  el.replaceChildren(page);
  start();

  return () => {
    disposed = true;
    window.clearInterval(timer);
    scene?.dispose();
    scene = null;
  };
}

/** The router's entry point, shaped like every other game screen. */
export function renderSkyTower(root: HTMLElement, set: VocabSet, encoded: string): () => void {
  return mount(root, set, { encoded });
}

// Re-exported so a reader who opens the game file finds the rules it plays by,
// and so `import { targetBlocks } from './sky-tower'` is not a lie.
export {
  ROUND_MS,
  WRONG_PAUSE_MS,
  BURST_GAP_MS,
  targetBlocks,
  createTower,
  earnBlock,
  missBlock,
  tickTower,
  towerOutcome,
} from '../../shared/sky-tower';

