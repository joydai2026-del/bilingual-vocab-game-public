// Reveal Rush, solo: `#/play/reveal/<enc>`.
//
// One enormous Chinese character hides behind twelve chunky tiles. Answering a
// side question pops a tile off; once half the tiles are gone the player may
// guess which character it is. A wrong guess owes two more tiles. Score is the
// tiles still standing when the word is read.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: the reveal is a CSS `clip-path` on
// the DOM glyph, built from the rectangles of the tiles that have POPPED. It is
// never "the 3D tiles happen to sit in front of it". That is what makes the 3D
// scene and the flat twin show exactly the same slice of the character, and it
// is why the glyph is provably unreadable before the first pop: with nothing
// popped the clip is an empty rectangle, so the element paints zero pixels
// whatever the renderer is doing.
//
// Everything above the `--- the screen ---` divider is pure and unit tested in
// tests/reveal-rush.test.ts. The renderers below it are thin.

import { buildQuestions } from '../../shared/quiz';
import { seededShuffle } from '../../shared/rng';
import type { QuizQuestion, VocabItem, VocabSet } from '../../shared/types';
import { applyLevel, audioStatusLine, pinyinToggle } from '../controls';
import { celebrate, correctSound, pulse, shake, wrongSound } from '../feedback';
import { navigate } from '../router';
import '../scene/kit.css';
import { wantsFlat } from '../scene/webgl';
import { speakerButton } from '../speaker';
import { pinyinOn } from '../state';
import { speak } from '../tts';
import { h, notice, screen } from '../ui';
import './reveal-rush.css';

// =============================================================================
// The rules. Pure, no DOM, no `three`.
// =============================================================================

export const GRID_COLS = 4;
export const GRID_ROWS = 3;
export const TILE_COUNT = GRID_COLS * GRID_ROWS;

/** Tiles a wrong guess owes before the guess prompt comes back. */
export const OWED_AFTER_WRONG_GUESS = 2;

/**
 * Characters too plain to be worth hiding: a child reads 日 from one stroke of
 * it, so a round built on them is a round with no puzzle in it. They are only
 * SKIPPED, never banned: a set of nothing but these still plays, because the
 * picker falls back through the tiers rather than returning an empty round.
 */
export const SIMPLE_GLYPHS = '一二三十人口日月大小';

/**
 * Tile colours, in the order the twelve tiles take them. The same six hexes as
 * `PALETTE` in three-kit.ts and `--kit-*` in kit.css, written out here so the
 * flat twin never has to reach into the chunk that carries `three`.
 */
export const PALETTE_ROTATION: string[] = [
  '#B7F0D3',
  '#FFE8A3',
  '#BFE3FF',
  '#FFB3A7',
  '#D9C8FF',
  '#FFFFFF',
];

export type RevealLevel = 'easy' | 'normal' | 'hard';

/** Hidden words in one round, by level. The spec's "3 to 5". */
export const WORDS_PER_ROUND: Record<RevealLevel, number> = { easy: 3, normal: 4, hard: 5 };

/** A rectangle. Unit fractions from `tileRect`, CSS pixels from `tileRectPx`. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Characters, not UTF-16 units, so a surrogate pair counts as one glyph. */
function glyphs(zh: string): string[] {
  return Array.from(zh.trim());
}

/**
 * How much a word is worth hiding. 2 = several characters (the best puzzle),
 * 1 = one character with some shape to it, 0 = one of the plain glyphs above.
 * A stroke count would be better and we do not have one, so character count is
 * the proxy the spec settled on.
 */
export function hideTier(zh: string): number {
  const chars = glyphs(zh);
  if (chars.length === 0) return 0;
  if (chars.length >= 2) return 2;
  return SIMPLE_GLYPHS.includes(chars[0]) ? 0 : 1;
}

/**
 * The words to hide this round, best first. Deterministic for a seed.
 *
 * Tier order is strict: every multi-character word is used before any single
 * character, and every interesting single character before any plain one. That
 * is the "when better items exist" half of the rule.
 */
export function pickHiddenItems(
  items: readonly VocabItem[],
  count: number,
  seed: number
): VocabItem[] {
  const usable = items.filter((item) => glyphs(item.zh).length > 0);
  const buckets: VocabItem[][] = [[], [], []];
  for (const item of usable) buckets[hideTier(item.zh)].push(item);
  const ordered = [2, 1, 0].flatMap((tier) => seededShuffle(buckets[tier], seed + tier * 7919 + 1));
  return ordered.slice(0, Math.max(0, Math.min(Math.floor(count), ordered.length)));
}

/** Hidden words this round: the level's number, or the whole set if it is smaller. */
export function roundLength(level: RevealLevel, available: number): number {
  return Math.max(0, Math.min(WORDS_PER_ROUND[level], Math.floor(available)));
}

/** Tile `index` as a fraction of the board box. Row-major, no gaps. */
export function tileRect(index: number): Rect {
  const i = Math.max(0, Math.min(TILE_COUNT - 1, Math.floor(index)));
  const col = i % GRID_COLS;
  const row = Math.floor(i / GRID_COLS);
  return { x: col / GRID_COLS, y: row / GRID_ROWS, w: 1 / GRID_COLS, h: 1 / GRID_ROWS };
}

/** The same rectangle in CSS pixels for a board `w` x `h`. */
export function tileRectPx(index: number, w: number, h: number): Rect {
  const r = tileRect(index);
  return { x: r.x * w, y: r.y * h, w: r.w * w, h: r.h * h };
}

/**
 * The `clip-path` that shows the glyph through the popped tiles and nothing
 * else.
 *
 * `path()` rather than `polygon()`: the popped tiles are usually not one
 * connected region, and a polygon is one ring. Several rectangular subpaths,
 * all wound the same way, fill correctly under both fill rules.
 *
 * Nothing popped is the case this whole game hangs on, so it is not left to a
 * degenerate path: it returns `inset(50% 50% 50% 50%)`, an empty rectangle that
 * every engine agrees paints nothing.
 *
 * `bleed` grows each rectangle by half a pixel so two neighbours do not leave a
 * hairline of unpainted glyph between them.
 */
export function clipPathFor(
  popped: readonly number[],
  w: number,
  h: number,
  bleed = 0.5
): string {
  const unique = Array.from(new Set(popped.map((i) => Math.floor(i))))
    .filter((i) => i >= 0 && i < TILE_COUNT)
    .sort((a, b) => a - b);
  if (unique.length === 0 || !(w > 0) || !(h > 0)) return 'inset(50% 50% 50% 50%)';

  const parts = unique.map((index) => {
    const r = tileRectPx(index, w, h);
    const x0 = Math.max(0, r.x - bleed);
    const y0 = Math.max(0, r.y - bleed);
    const x1 = Math.min(w, r.x + r.w + bleed);
    const y1 = Math.min(h, r.y + r.h + bleed);
    return `M${round2(x0)} ${round2(y0)}H${round2(x1)}V${round2(y1)}H${round2(x0)}Z`;
  });
  return `path("${parts.join('')}")`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** How much of the glyph box the clip lets through, as a fraction. */
export function visibleFraction(popped: readonly number[]): number {
  const unique = new Set(
    popped.map((i) => Math.floor(i)).filter((i) => i >= 0 && i < TILE_COUNT)
  );
  return unique.size / TILE_COUNT;
}

/** One hidden word's worth of tile state. */
export interface TileRound {
  total: number;
  /** Tile indexes already popped, in the order they went. */
  popped: number[];
  /** Tiles that must be popped before the guess prompt opens. */
  unlockAt: number;
  wrongGuesses: number;
  solved: boolean;
}

export function newTileRound(total = TILE_COUNT): TileRound {
  const size = Math.max(1, Math.floor(total));
  return { total: size, popped: [], unlockAt: Math.ceil(size / 2), wrongGuesses: 0, solved: false };
}

/** Pops a tile. A repeat or an out-of-range index changes nothing. */
export function popTile(round: TileRound, index: number): TileRound {
  const i = Math.floor(index);
  if (i < 0 || i >= round.total || round.popped.includes(i)) return round;
  return { ...round, popped: [...round.popped, i] };
}

/** True when the "what character is this?" prompt should be on screen. */
export function guessUnlocked(round: TileRound): boolean {
  return !round.solved && round.popped.length >= round.unlockAt;
}

/**
 * A wrong guess: two more tiles before the prompt comes back.
 *
 * Capped at `total`, because an uncapped threshold on a nearly-cleared board is
 * a threshold that can never be met, and the round would deadlock with every
 * tile gone and no way to say the answer.
 */
export function afterWrongGuess(round: TileRound): TileRound {
  const wanted = round.popped.length + OWED_AFTER_WRONG_GUESS;
  return {
    ...round,
    wrongGuesses: round.wrongGuesses + 1,
    unlockAt: Math.min(round.total, wanted),
  };
}

export function solveRound(round: TileRound): TileRound {
  return { ...round, solved: true };
}

export function tilesLeft(round: TileRound): number {
  return Math.max(0, round.total - round.popped.length);
}

/** Score for one hidden word: the tiles still standing when it was read. */
export function scoreForRound(round: TileRound): number {
  return round.solved ? tilesLeft(round) : 0;
}

/** Which tile goes next, and next after that. Scattered, not left to right. */
export function popOrder(total: number, seed: number): number[] {
  const size = Math.max(0, Math.floor(total));
  return seededShuffle(
    Array.from({ length: size }, (_, i) => i),
    seed
  );
}

/** A side question plus how it is asked. */
export interface SideQuestion extends QuizQuestion {
  /** `read` shows the characters; `listen` only plays them. */
  mode: 'read' | 'listen';
}

/**
 * The side questions for one hidden word.
 *
 * zh-to-en only, so the answers are English and no choice list can spell the
 * hidden word out. The hidden item is dropped outright: a zh-to-en question
 * about it would print the very character the tiles are covering.
 *
 * Odd-numbered questions are `listen`: same question, prompt not shown, read
 * aloud instead. That is the spec's "audio-to-en" with no second builder.
 */
export function sideQuestions(
  set: VocabSet,
  hiddenItemId: string,
  seed: number
): SideQuestion[] {
  return buildQuestions(set, { directions: ['zh2en'], seed })
    .filter((q) => q.itemId !== hiddenItemId)
    .map((q, i) => ({ ...q, mode: i % 2 === 1 ? 'listen' : 'read' }));
}

/**
 * The four-option "what character is this?" prompt.
 *
 * Distractors of the same character count come first, so the outline of the
 * clip is not a giveaway: three of four options being one character long when
 * the board is plainly hiding two is a free answer.
 */
export function guessPrompt(
  set: VocabSet,
  hidden: VocabItem,
  seed: number
): { choices: string[]; answer: number } {
  const size = glyphs(hidden.zh).length;
  const others = Array.from(new Set(set.items.map((item) => item.zh))).filter(
    (zh) => zh !== hidden.zh && zh.trim().length > 0
  );
  const sameSize = others.filter((zh) => glyphs(zh).length === size);
  const rest = others.filter((zh) => glyphs(zh).length !== size);
  const pool = [...seededShuffle(sameSize, seed + 11), ...seededShuffle(rest, seed + 13)];

  const raw = [hidden.zh, ...pool.slice(0, 3)];
  const order = seededShuffle(
    raw.map((_, i) => i),
    seed + 17
  );
  return { choices: order.map((i) => raw[i]), answer: order.indexOf(0) };
}

/**
 * Why Reveal Rush cannot be played on this set, in plain language.
 *
 * It needs two things: two different English meanings (or the side questions
 * have one button) and two different Chinese words (or the guess prompt does).
 */
export function revealDisabledReason(set: VocabSet): string | undefined {
  const glossCount = new Set(set.items.map((item) => item.en.trim()).filter(Boolean)).size;
  const wordCount = new Set(set.items.map((item) => item.zh.trim()).filter(Boolean)).size;
  if (glossCount >= 2 && wordCount >= 2) return undefined;
  const count = set.items.length;
  return `Reveal Rush needs at least two words with different Chinese and different meanings. This set has ${count} ${
    count === 1 ? 'word' : 'words'
  }.`;
}

// =============================================================================
// --- the screen ---
// =============================================================================

/** What a renderer is handed and what the shell asks of it. */
export interface ViewHost {
  /** The `.kit-stage` box. A renderer may add a canvas or tile divs to it. */
  stage: HTMLElement;
  /** The square the glyph fills. The renderer OWNS its left/top/width/height. */
  board: HTMLElement;
  /** Called whenever the board box changes size, in CSS pixels. */
  onLayout(w: number, h: number): void;
}

export interface RevealView {
  /** Back to twelve standing tiles for the next hidden word. */
  reset(): void;
  /** Tile `index` flies off with confetti. */
  pop(index: number): void;
  /** Solved: everything still standing scatters at once. */
  scatter(): void;
  dispose(): void;
}

const FEEDBACK_MS = 900;

/**
 * `probe=1`, on the page query or the hash's own query.
 *
 * TEST HOOK ONLY. Everything it gates (the visible-area probe here, the pixel
 * readback in the 3D scene, and the `data-answer` the harness plays by) is
 * absent from a normal load, so a class can never read an answer out of the
 * DOM by opening devtools.
 */
export function probeRequested(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  const hash = window.location.hash || '';
  const mark = hash.indexOf('?');
  const inHash = mark === -1 ? '' : hash.slice(mark + 1);
  const has = (query: string): boolean => {
    try {
      return new URLSearchParams(query).get('probe') === '1';
    } catch {
      return false;
    }
  };
  return has((window.location.search || '').replace(/^\?/, '')) || has(inHash);
}

const LEVELS: { level: RevealLevel; label: string }[] = [
  { level: 'easy', label: 'Easy' },
  { level: 'normal', label: 'Normal' },
  { level: 'hard', label: 'Hard' },
];

/**
 * Mounts the game into `el`.
 *
 * `opts.flat` forces the twin; left out, `wantsFlat()` decides (no WebGL 2, or
 * `?flat=1`). A failed dynamic import of the 3D chunk falls back to the twin
 * rather than leaving an empty stage, same as the kit demo.
 */
export function mount(
  el: HTMLElement,
  set: VocabSet,
  opts: { encoded: string; flat?: boolean }
): () => void {
  applyLevel(set.level);

  const { root: page, body } = screen('Reveal Rush', { back: `#/set/${opts.encoded}` });

  const blocked = revealDisabledReason(set);
  if (blocked) {
    body.append(notice(blocked, 'warn'));
    el.replaceChildren(page);
    return () => undefined;
  }

  const flat = opts.flat ?? wantsFlat();
  const probe = probeRequested();

  // --- the furniture ---------------------------------------------------------

  const scoreOut = h('b', { text: '0' });
  const wordOut = h('b', { text: '1' });
  const tilesOut = h('b', { text: String(TILE_COUNT) });
  const levelRow = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Level' });

  const glyph = h('div', { class: 'rr-glyph' });
  const board = h('div', { class: 'rr-board' }, [glyph]);
  const solvedLine = h('div', { class: 'rr-solved' });
  const overlay = h('div', { class: 'kit-overlay' }, [board, solvedLine]);
  const stage = h('div', { class: 'kit-stage rr-stage' }, [overlay]);
  const panel = h('div', { class: 'rr-panel' });

  let level: RevealLevel = 'normal';
  let view: RevealView | null = null;
  let viewGeneration = 0;
  let disposed = false;

  // Board size in CSS pixels, owned by the renderer and needed here because the
  // clip path is written in pixels.
  let boardW = 0;
  let boardH = 0;

  // --- round state -----------------------------------------------------------

  let hidden: VocabItem[] = [];
  let wordIndex = 0;
  let tiles = newTileRound();
  let order: number[] = [];
  let questions: SideQuestion[] = [];
  let questionCursor = 0;
  let totalScore = 0;
  let solvedCount = 0;
  let seed = 0;
  let busy = false;

  const currentWord = (): VocabItem | undefined => hidden[wordIndex];

  /** Repaints the clip from the tiles that have popped. The whole reveal. */
  function paintClip(): void {
    // A solved word is shown whole. Re-clipping it on a resize would put the
    // tiles back over a character the player has already read.
    glyph.style.clipPath = tiles.solved ? 'none' : clipPathFor(tiles.popped, boardW, boardH);
  }

  /**
   * The character grid the glyph is laid out on.
   *
   * One or two characters stack in a single column, so they run the full width
   * of the board and line up with its three rows; three or four go in a square.
   * Never wrapped text: a wrapped line box is 1 em tall whatever the box it is
   * in, so an auto-sized two-character word overflowed the tiles by half its
   * own height and only the clip was hiding it.
   */
  function glyphGrid(count: number): { cols: number; rows: number } {
    const n = Math.max(1, count);
    const cols = n <= 2 ? 1 : Math.ceil(Math.sqrt(n));
    return { cols, rows: Math.ceil(n / cols) };
  }

  function onLayout(w: number, h: number): void {
    boardW = w;
    boardH = h;
    const { cols, rows } = glyphGrid(glyph.childElementCount);
    // 0.92 of a cell: a CJK glyph's ink fills close to its em box, and the
    // remainder is the margin that keeps a stroke off the tile edge.
    const size = Math.min(w / cols, h / rows) * 0.92;
    glyph.style.fontSize = `${Math.max(12, Math.round(size))}px`;
    paintClip();
  }

  /** One span per character, on the grid. Called when the hidden word changes. */
  function paintGlyph(zh: string): void {
    const chars = Array.from(zh);
    const { cols, rows } = glyphGrid(chars.length);
    glyph.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    glyph.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    glyph.replaceChildren(...chars.map((c) => h('span', { class: 'rr-ch', text: c })));
    onLayout(boardW, boardH);
  }

  // --- the question card -----------------------------------------------------

  /**
   * One card: a prompt, four buttons, and a verdict. Small enough to own here,
   * which is what lets a `listen` question hide its own prompt (the shared quiz
   * card always prints it) without a flag threaded through shared code.
   */
  function card(
    promptNode: HTMLElement,
    choices: readonly string[],
    answer: number,
    onDone: (correct: boolean) => void,
    opt: { pinyinOnChoices?: boolean } = {}
  ): HTMLElement {
    let locked = false;
    const buttons = choices.map((choice, index) => {
      const button = h('button', { class: 'choice', type: 'button' });
      const py = opt.pinyinOnChoices && pinyinOn() ? readingFor(choice) : null;
      button.append(
        h('span', {}, [h('span', { text: choice }), py ? h('span', { class: 'py', text: py }) : null])
      );
      button.addEventListener('click', () => {
        if (locked || busy) return;
        locked = true;
        busy = true;
        for (const other of buttons) other.disabled = true;
        const right = index === answer;
        buttons[answer]?.classList.add('right');
        if (!right) buttons[index].classList.add('chosen-wrong');
        if (right) {
          correctSound();
          pulse(buttons[answer]);
        } else {
          wrongSound();
          shake(buttons[index]);
        }
        window.setTimeout(() => {
          busy = false;
          if (!disposed) onDone(right);
        }, FEEDBACK_MS);
      });
      return button;
    });

    const node = h('div', { class: 'rr-card' }, [promptNode, h('div', { class: 'choices' }, buttons)]);
    // The harness has to play CORRECTLY to reach a solved word, and a listen
    // question deliberately prints nothing it could look the answer up from.
    // Only ever with `?probe=1`.
    if (probe) node.dataset.answer = String(answer);
    return node;
  }

  /** The set's own pinyin for a Chinese label, when the toggle is on. */
  function readingFor(zh: string): string | null {
    const hit = set.items.find((item) => item.zh === zh);
    return hit?.pinyin?.trim() || null;
  }

  // --- the flow --------------------------------------------------------------

  function showSideQuestion(): void {
    const word = currentWord();
    if (!word) return;
    if (questions.length === 0) {
      // Nothing left to ask about: hand the tile over rather than stall.
      popNext();
      return;
    }
    const q = questions[questionCursor % questions.length];
    questionCursor += 1;

    const promptNode =
      q.mode === 'listen'
        ? h('div', { class: 'quiz-prompt' }, [
            h('p', { class: 'dir', text: 'Listen. What does it mean?' }),
            h('div', { class: 'row rr-listen' }, [
              speakerButton(() => q.prompt, { class: 'rr-big-speaker', label: 'Play the word' }),
            ]),
          ])
        : h('div', { class: 'quiz-prompt' }, [
            h('p', { class: 'dir', text: 'What does it mean?' }),
            h('div', { class: 'row rr-read' }, [
              h('div', { class: 'big', text: q.prompt }),
              speakerButton(() => q.prompt),
            ]),
          ]);

    panel.replaceChildren(
      h('p', { class: 'rr-goal', text: goalText() }),
      card(promptNode, q.choices, q.answer, (correct) => {
        if (correct) popNext();
        else nextPrompt();
      })
    );

    // A listen question plays itself once. `speak()` returns immediately in
    // silent mode, so an automated run makes no sound.
    if (q.mode === 'listen') void speak(q.prompt).catch(() => undefined);
  }

  function goalText(): string {
    if (guessUnlocked(tiles)) return 'Ready to guess.';
    const owed = Math.max(0, tiles.unlockAt - tiles.popped.length);
    return owed === 1 ? 'One more tile before you can guess.' : `${owed} more tiles before you can guess.`;
  }

  function popNext(): void {
    const next = order.find((index) => !tiles.popped.includes(index));
    if (next !== undefined) {
      tiles = popTile(tiles, next);
      view?.pop(next);
      paintClip();
      tilesOut.textContent = String(tilesLeft(tiles));
    }
    nextPrompt();
  }

  function nextPrompt(): void {
    if (disposed) return;
    if (guessUnlocked(tiles)) showGuess();
    else showSideQuestion();
  }

  function showGuess(): void {
    const word = currentWord();
    if (!word) return;
    const { choices, answer } = guessPrompt(set, word, seed + wordIndex * 131);

    panel.replaceChildren(
      h('p', { class: 'rr-goal rr-goal-hot', text: 'Which character is hiding?' }),
      card(
        h('div', { class: 'quiz-prompt' }, [
          h('p', { class: 'dir', text: 'Look at the board and pick it.' }),
        ]),
        choices,
        answer,
        (correct) => {
          if (correct) solveWord();
          else {
            tiles = afterWrongGuess(tiles);
            nextPrompt();
          }
        },
        { pinyinOnChoices: true }
      )
    );
  }

  function solveWord(): void {
    const word = currentWord();
    if (!word) return;
    tiles = solveRound(tiles);
    totalScore += scoreForRound(tiles);
    solvedCount += 1;
    scoreOut.textContent = String(totalScore);

    view?.scatter();
    glyph.style.clipPath = 'none';
    solvedLine.replaceChildren(
      h('div', { class: 'rr-solved-py', text: word.pinyin || '' }),
      h('div', { class: 'rr-solved-en', text: word.en })
    );
    solvedLine.classList.add('on');
    void speak(word.zh).catch(() => undefined);

    const more = wordIndex + 1 < hidden.length;
    const next = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: more ? 'Next word' : 'See the score',
    });
    next.addEventListener('click', () => (more ? startWord(wordIndex + 1) : finish()));

    panel.replaceChildren(
      h('div', { class: 'final' }, [
        h('p', { class: 'score', text: `${word.zh} (${word.en})` }),
        h('p', {
          class: 'hint',
          text: `${scoreForRound(tiles)} ${scoreForRound(tiles) === 1 ? 'tile' : 'tiles'} still standing.`,
        }),
      ]),
      h('div', { class: 'row' }, [next])
    );
  }

  function startWord(index: number): void {
    wordIndex = index;
    const word = currentWord();
    if (!word) {
      finish();
      return;
    }
    tiles = newTileRound();
    order = popOrder(TILE_COUNT, seed + index * 977 + 3);
    questions = sideQuestions(set, word.id, seed + index * 613);
    questionCursor = 0;

    paintGlyph(word.zh);
    glyph.style.clipPath = '';
    solvedLine.replaceChildren();
    solvedLine.classList.remove('on');
    wordOut.textContent = String(index + 1);
    tilesOut.textContent = String(TILE_COUNT);
    view?.reset();
    paintClip();
    showSideQuestion();
  }

  function finish(): void {
    const again = h('button', { class: 'btn btn-primary btn-big', type: 'button', text: 'Play again' });
    again.addEventListener('click', () => startRound());
    const other = h('button', { class: 'btn', type: 'button', text: 'Pick another game' });
    other.addEventListener('click', () => navigate(`#/set/${opts.encoded}`));

    const final = h('div', { class: 'final rr-end' }, [
      h('p', { class: 'score', text: `${totalScore} ${totalScore === 1 ? 'point' : 'points'}` }),
      h('p', {
        class: 'hint',
        text: `${solvedCount} of ${hidden.length} ${hidden.length === 1 ? 'word' : 'words'} read. A point for every tile you left standing.`,
      }),
    ]);
    panel.replaceChildren(final, h('div', { class: 'row' }, [again, other]));
    celebrate(final, set.level);
  }

  function startRound(): void {
    seed = Math.floor(Math.random() * 2 ** 31);
    totalScore = 0;
    solvedCount = 0;
    scoreOut.textContent = '0';
    hidden = pickHiddenItems(set.items, roundLength(level, set.items.length), seed);
    if (hidden.length === 0) {
      panel.replaceChildren(notice(revealDisabledReason(set) ?? 'No words to hide.', 'warn'));
      return;
    }
    startWord(0);
  }

  function paintLevels(): void {
    levelRow.replaceChildren(
      ...LEVELS.map((option) => {
        const button = h('button', {
          type: 'button',
          text: option.label,
          'aria-pressed': String(option.level === level),
        });
        button.addEventListener('click', () => {
          if (option.level === level || busy) return;
          level = option.level;
          paintLevels();
          startRound();
        });
        return button;
      })
    );
  }

  // --- wiring ----------------------------------------------------------------

  paintLevels();
  body.append(
    h('div', { class: 'game-bar' }, [
      h('div', { class: 'row' }, [
        h('span', { class: 'stat' }, ['Score ', scoreOut]),
        h('span', { class: 'stat' }, ['Word ', wordOut]),
        h('span', { class: 'stat' }, ['Tiles ', tilesOut]),
      ]),
      pinyinToggle(() => undefined),
    ]),
    h('div', { class: 'row' }, [h('span', { class: 'hint', text: 'How many words?' }), levelRow]),
    stage,
    panel,
    audioStatusLine()
  );
  el.replaceChildren(page);

  const host: ViewHost = { stage, board, onLayout };

  function useFlat(): void {
    void import('./reveal-rush-css').then(({ createFlatView }) => {
      if (disposed) return;
      view = createFlatView(host);
      view.reset();
    });
  }

  const mine = ++viewGeneration;
  if (flat) {
    useFlat();
  } else {
    void import('./reveal-rush-3d')
      .then(({ createSceneView }) => createSceneView(host))
      .then((made) => {
        if (disposed || mine !== viewGeneration) {
          made.dispose();
          return;
        }
        view = made;
        view.reset();
      })
      .catch(() => {
        if (!disposed) useFlat();
      });
  }

  // The render gate's only way in, and only with `?probe=1` in the URL, so a
  // class never carries it. It does NOT report the game's own idea of how much
  // is showing: it asks the BROWSER, point by point, whether the glyph paints
  // there. `clip-path` clips hit testing as well as painting, so
  // `elementFromPoint` landing on the glyph means the glyph is actually
  // visible at that point. Everything layered over it (the canvas, the flat
  // tiles) is `pointer-events: none`, so the clip is the only thing that can
  // answer no.
  //
  // The sample grid is a whole number of samples per tile, so a correct clip
  // reads back as an exact multiple of 1/12 and an off-by-a-row bug does not
  // hide in rounding.
  let removeProbe = (): void => undefined;
  if (probe) {
    const readProbe = (): unknown => {
      const box = board.getBoundingClientRect();
      const cols = GRID_COLS * 8;
      const rows = GRID_ROWS * 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let inside = 0;
      let onScreen = 0;
      let offScreen = 0;
      for (let ry = 0; ry < rows; ry += 1) {
        for (let cx = 0; cx < cols; cx += 1) {
          const x = box.left + ((cx + 0.5) * box.width) / cols;
          const y = box.top + ((ry + 0.5) * box.height) / rows;
          // `elementFromPoint` answers null for anything past the viewport, and
          // "you scrolled" is not "the character is hidden". Those samples are
          // counted separately instead of quietly reading as covered.
          if (x < 0 || y < 0 || x >= vw || y >= vh) {
            offScreen += 1;
            continue;
          }
          onScreen += 1;
          const hit = document.elementFromPoint(x, y);
          if (hit === glyph || glyph.contains(hit)) inside += 1;
        }
      }
      return {
        visible: onScreen === 0 ? 0 : inside / onScreen,
        samples: onScreen,
        offScreen,
        popped: tiles.popped.length,
        expected: tiles.solved ? 1 : visibleFraction(tiles.popped),
        solved: tiles.solved,
        word: glyph.textContent,
        chars: glyph.childElementCount,
        clip: window.getComputedStyle(glyph).clipPath,
        board: { w: Math.round(box.width), h: Math.round(box.height) },
        mode: flat ? 'flat' : '3d',
      };
    };
    (window as unknown as { __revealProbe?: () => unknown }).__revealProbe = readProbe;
    removeProbe = () => {
      delete (window as unknown as { __revealProbe?: unknown }).__revealProbe;
    };
  }

  startRound();

  return () => {
    disposed = true;
    viewGeneration += 1;
    removeProbe();
    view?.dispose();
    view = null;
  };
}

/** Router shape, matching the other games. */
export function renderRevealRush(root: HTMLElement, set: VocabSet, encoded: string): () => void {
  return mount(root, set, { encoded });
}

