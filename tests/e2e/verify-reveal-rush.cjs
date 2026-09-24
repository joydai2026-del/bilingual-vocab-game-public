// The render gate for Reveal Rush.
//
// Modelled on verify-kit-demo.cjs, and it asks one question that harness does
// not: is the hidden character actually HIDDEN? A green build, a canvas with
// pixels in it, and twelve tiles on screen would all pass while the glyph sat
// there readable underneath. So the run measures the reveal itself:
//
//   before any tile is popped   the visible area of the glyph element is 0
//   after six pops              it is partly visible, and by the exact fraction
//                               the twelve-tile grid says it should be
//
// "Visible" is not the game's own opinion. `clip-path` clips hit testing as
// well as painting, so the page-context probe walks a grid of points over the
// glyph box and asks `document.elementFromPoint` whether the glyph is the thing
// there. Everything layered over it is `pointer-events: none`, so the clip is
// the only thing that can answer no. The probe, and the `data-answer` this
// harness plays by, exist only with `?probe=1` in the URL.
//
// It also plays the game: a real teacher paste through the real home page, then
// two hidden words solved by DOM, then the end screen.
//
// Silence: `?silent=1` plus an init script that stubs speechSynthesis and media
// playback AND COUNTS the calls, so `spoke: 0` is a measurement rather than a
// variable nobody ever wrote to. Nothing here makes sound.
//
// Run:
//   npm run cf:dev -- --port 8813        # in another shell
//   NODE_PATH=/path/to/node_modules \
//     node tests/e2e/verify-reveal-rush.cjs
//
// Env: BVG_BASE (default http://localhost:8813), BVG_CHROME, BVG_SHOTS.

const path = require('path');
const fs = require('fs');

const { chromium } = (() => {
  const candidates = [
    'playwright',
  ];
  for (const name of candidates) {
    try {
      return require(name);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('playwright not found in: ' + candidates.join(', '));
})();

const EXE = (() => {
  if (process.env.BVG_CHROME) return process.env.BVG_CHROME;
  const home = process.env.HOME || '';
  const cache = path.join(home, 'Library/Caches/ms-playwright');
  const found = [];
  try {
    for (const dir of fs.readdirSync(cache)) {
      if (!dir.startsWith('chromium-')) continue;
      found.push(
        path.join(
          cache,
          dir,
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
        )
      );
    }
  } catch {
    /* no download cache on this machine */
  }
  found.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  );
  const usable = found.find((c) => fs.existsSync(c));
  if (!usable) throw new Error('no Chromium found; set BVG_CHROME to one');
  return usable;
})();

const BASE = process.env.BVG_BASE || 'http://localhost:8813';
const SHOTS =
  process.env.BVG_SHOTS ||
  '/private/tmp/claude-501/-Users-joyd-Bilingual-Vocab-Game-Generator/48bc5bd5-0a7b-495e-8cf2-1a7876341956/scratchpad/reveal';

const PASTE = '苹果 香蕉 葡萄 西瓜 草莓 橙子 桃子 梨';

/** Software GL: a headless machine has no GPU, so SwiftShader is the renderer. */
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const TILE_COUNT = 12;
/** The feedback pause in the game, plus room for the pop animation. */
const STEP_MS = 1100;

const out = [];
const L = (s) => {
  console.log(s);
  out.push(s);
};

async function silence(ctx) {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('vocab-silent', '1');
    } catch {
      /* private mode */
    }
    window.__spoke = 0;
    // The app plays ONE frame of pure silence on the first tap to unlock the
    // audio element. That is not the app reading vocabulary aloud, so it is
    // counted apart rather than folded into a number the gate then has to
    // forgive.
    window.__unlocks = 0;
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = () => {
        window.__spoke += 1;
      };
      window.speechSynthesis.cancel = () => {};
      window.speechSynthesis.getVoices = () => [];
    }
    HTMLMediaElement.prototype.play = function () {
      const src = String(this.src || '');
      if (src.startsWith('data:audio/wav;base64,UklGRiQAAAB')) window.__unlocks += 1;
      else window.__spoke += 1;
      return Promise.resolve();
    };
    // This game blips on EVERY answer, and those blips are WebAudio, not
    // speech. The harness used to leave `AudioContext` alone and never ask,
    // which is how it ran on a real machine with the sound on. Counting stub,
    // never a deleted constructor: a sound that cannot happen also cannot be
    // measured, and the count is the whole point.
    window.__audioCtx = 0;
    window.__oscillators = 0;
    const Recorder = function () {
      window.__audioCtx += 1;
      return {
        state: 'running',
        currentTime: 0,
        destination: {},
        resume: () => Promise.resolve(),
        createOscillator: () => ({
          type: 'sine',
          frequency: { setValueAtTime() {} },
          connect: () => ({ connect() {} }),
          start() {
            window.__oscillators += 1;
          },
          stop() {},
        }),
        createGain: () => ({
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect: () => ({ connect() {} }),
        }),
      };
    };
    window.AudioContext = Recorder;
    window.webkitAudioContext = Recorder;
  });
}

/** A teacher's paste through the real home page. Returns the encoded set. */
async function makeSet(page) {
  await page.goto(`${BASE}/?silent=1#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#paste', { timeout: 15000 });
  await page.fill('#paste', PASTE);
  await page.getByRole('button', { name: 'Make games', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/set/'), null, {
    timeout: 20000,
    polling: 100,
  });
  const hash = await page.evaluate(() => location.hash);
  return hash.slice('#/set/'.length);
}

/**
 * The probe: what the BROWSER says is visible through the clip right now.
 *
 * The board is scrolled fully into view first. `elementFromPoint` answers null
 * past the viewport edge, and a board half below the fold would otherwise read
 * as a board half covered.
 */
async function probe(page) {
  await page.evaluate(() => {
    const b = document.querySelector('.rr-board');
    if (b) b.scrollIntoView({ block: 'center', inline: 'center' });
  });
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    const read = window.__revealProbe;
    if (typeof read !== 'function') return { ok: false, why: '__revealProbe missing' };
    return Object.assign({ ok: true }, read());
  });
}

/** Canvas variance, drawn and read back in ONE task (see the kit notes). */
async function canvasVariance(page, samples) {
  return page.evaluate((want) => {
    if (!document.querySelector('canvas')) return { ok: false, why: 'no canvas element' };
    const read = window.__revealPixels;
    if (typeof read !== 'function') return { ok: false, why: '__revealPixels hook missing' };
    const o = read(want);
    if (!o || !o.lum || !o.lum.length) return { ok: false, why: 'hook returned nothing' };
    const mean = o.lum.reduce((a, b) => a + b, 0) / o.lum.length;
    const variance = o.lum.reduce((a, b) => a + (b - mean) * (b - mean), 0) / o.lum.length;
    return { ok: true, sampled: o.lum.length, mean, variance, drawn: o.drawn, w: o.w, h: o.h };
  }, samples);
}

/**
 * Does the character stay inside the twelve tiles?
 *
 * The shell lays the word out as one span per character on an explicit grid, so
 * "inside" is checkable: every span box must sit within the board box. Anything
 * outside would be a stroke the clip can never reveal and the tiles never hid.
 */
async function glyphFit(page) {
  return page.evaluate(() => {
    const board = document.querySelector('.rr-board');
    const glyph = document.querySelector('.rr-glyph');
    if (!board || !glyph) return { ok: false, why: 'no board' };
    const b = board.getBoundingClientRect();
    const cells = Array.from(glyph.querySelectorAll('.rr-ch'));
    if (!cells.length) return { ok: false, why: 'no characters on the board' };
    let over = { top: -1e6, bottom: -1e6, left: -1e6, right: -1e6 };
    for (const cell of cells) {
      const c = cell.getBoundingClientRect();
      over = {
        top: Math.max(over.top, b.top - c.top),
        bottom: Math.max(over.bottom, c.bottom - b.bottom),
        left: Math.max(over.left, b.left - c.left),
        right: Math.max(over.right, c.right - b.right),
      };
    }
    for (const k of Object.keys(over)) over[k] = Math.round(over[k]);
    const first = cells[0].getBoundingClientRect();
    return {
      ok: true,
      word: glyph.textContent,
      characters: cells.length,
      board: { w: Math.round(b.width), h: Math.round(b.height) },
      cell: { w: Math.round(first.width), h: Math.round(first.height) },
      fontSize: getComputedStyle(glyph).fontSize,
      over,
    };
  });
}

/** Waits for the dev server to answer. Bounded; it never loops forever. */
async function waitForServer(ms) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/`, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** How many tiles are gone, read off the game bar the player reads. */
async function tilesGone(page) {
  const left = await page.evaluate(() => {
    const stats = Array.from(document.querySelectorAll('.game-bar .stat'));
    const row = stats.find((s) => (s.textContent || '').trim().startsWith('Tiles'));
    return row ? Number((row.textContent || '').replace(/\D+/g, '')) : null;
  });
  return left === null ? null : TILE_COUNT - left;
}

/** Is the card on screen the guess prompt, or a side question? */
async function cardKind(page) {
  return page.evaluate(() => {
    if (document.querySelector('.rr-end')) return 'end';
    if (!document.querySelector('.rr-card')) {
      return document.querySelector('.final') ? 'solved' : 'none';
    }
    const goal = document.querySelector('.rr-goal');
    return goal && goal.classList.contains('rr-goal-hot') ? 'guess' : 'side';
  });
}

/**
 * Answers the card on screen. `right` false picks any other choice, which is
 * how the run exercises the two-tiles-owed rule for real instead of trusting
 * the unit test for it.
 */
async function answer(page, right) {
  const index = await page.evaluate((wantRight) => {
    const card = document.querySelector('.rr-card');
    if (!card) return -1;
    const key = Number(card.dataset.answer);
    const buttons = card.querySelectorAll('.choice');
    if (!buttons.length || Number.isNaN(key)) return -1;
    if (wantRight) return key;
    for (let i = 0; i < buttons.length; i += 1) if (i !== key) return i;
    return key;
  }, right);
  if (index < 0) return false;
  await page.locator('.rr-card .choice').nth(index).click();
  await page.waitForTimeout(STEP_MS);
  return true;
}

/** Plays one hidden word to a solve. Returns what happened, step by step. */
async function solveWord(page, opts = {}) {
  const wrongGuesses = opts.wrongGuesses || 0;
  const onTiles = opts.onTiles || (async () => {});
  let spent = 0;
  let wrongLeft = wrongGuesses;

  for (let step = 0; step < 60; step += 1) {
    const kind = await cardKind(page);
    if (kind === 'solved' || kind === 'end') break;
    if (kind === 'none') {
      await page.waitForTimeout(200);
      continue;
    }
    if (kind === 'guess') {
      if (wrongLeft > 0) {
        wrongLeft -= 1;
        await answer(page, false);
      } else {
        await answer(page, true);
      }
    } else {
      await answer(page, true);
      spent += 1;
    }
    const gone = await tilesGone(page);
    if (gone !== null) await onTiles(gone);
  }
  return { correctAnswers: spent, kind: await cardKind(page) };
}

async function runCase(browser, c) {
  const ctx = await browser.newContext({ viewport: c.size, deviceScaleFactor: 1 });
  await silence(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const problems = [];
  const shots = [];
  // wrangler dev has died mid-run on this machine (an esbuild bundler deadlock
  // while three builds shared the box), so every case waits for the server
  // rather than reporting a dead port as a broken game.
  if (!(await waitForServer(90000))) {
    await ctx.close();
    return { case: c.name, problems: ['the dev server never came back'] };
  }
  const encoded = await makeSet(page);

  const flat = c.flat ? '&flat=1' : '';
  await page.goto(`${BASE}/?silent=1&probe=1${flat}#/play/reveal/${encoded}`, {
    waitUntil: 'domcontentloaded',
  });
  // The board is sized by the renderer, so wait for a board with a real size
  // rather than for a fixed number of milliseconds.
  await page
    .waitForFunction(
      () => {
        const b = document.querySelector('.rr-board');
        return b && b.getBoundingClientRect().width > 40 && typeof window.__revealProbe === 'function';
      },
      null,
      { timeout: 20000, polling: 100 }
    )
    .catch(() => problems.push('the board never got a size'));
  await page.waitForTimeout(900);

  const mode = await page.evaluate(() =>
    document.querySelector('canvas') ? '3d' : 'flat'
  );
  if (mode !== (c.flat ? 'flat' : '3d')) problems.push(`ran as ${mode}, wanted ${c.flat ? 'flat' : '3d'}`);

  // --- the reveal, measured ---------------------------------------------------

  const at0 = await probe(page);
  if (!at0.ok) problems.push(`probe unavailable: ${at0.why}`);
  else {
    if (at0.visible !== 0) {
      problems.push(`the character is readable before any tile popped: ${at0.visible} of it visible`);
    }
    if (!at0.word || !at0.word.trim()) problems.push('no character on the board');
  }
  const shot0 = path.join(SHOTS, `${c.name}-00-tiles.png`);
  await page.screenshot({ path: shot0 });
  shots.push(shot0);

  const pixels0 = c.flat ? null : await canvasVariance(page, 240);

  // The ink has to sit inside the tiles at every size, or the reveal is
  // showing a character the board never covered.
  const fit = await glyphFit(page);
  if (fit.ok) {
    for (const [edge, px] of Object.entries(fit.over)) {
      if (px > 2) problems.push(`the character sticks ${px}px past the ${edge} of the tiles`);
    }
  } else {
    problems.push(`could not measure the character: ${fit.why}`);
  }

  const scrollAtRest = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  if (scrollAtRest.doc > scrollAtRest.win + 1) {
    problems.push(`horizontal scroll: content ${scrollAtRest.doc}px in a ${scrollAtRest.win}px window`);
  }

  // A fit-only case stops here: it exists to prove the board and the glyph
  // survive a viewport, not to replay a whole round on it.
  if (c.layoutOnly) {
    const spokeEarly = await page.evaluate(() => window.__spoke || 0);
    if (spokeEarly !== 0) problems.push(`something tried to speak ${spokeEarly} time(s)`);
    if (errors.length) problems.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);
    await ctx.close();
    return {
      case: c.name,
      mode,
      layoutOnly: true,
      visible: { atZero: at0 && at0.visible },
      fit,
      pixels: { atRest: pixels0 },
      spoke: spokeEarly,
      errors,
      shots,
      problems,
    };
  }

  // --- play it ----------------------------------------------------------------

  let at6 = null;
  let at12 = null;
  const seen = new Set();
  const onTiles = async (gone) => {
    if (gone === 6 && !seen.has(6)) {
      seen.add(6);
      at6 = await probe(page);
      const shot = path.join(SHOTS, `${c.name}-06-tiles.png`);
      await page.screenshot({ path: shot });
      shots.push(shot);
    }
    if (gone === 12 && !seen.has(12)) {
      seen.add(12);
      at12 = await probe(page);
      const shot = path.join(SHOTS, `${c.name}-12-tiles.png`);
      await page.screenshot({ path: shot });
      shots.push(shot);
    }
  };

  // Word 1 is guessed wrong three times on purpose: each wrong guess owes two
  // more tiles, which walks the board from six gone to twelve gone and gives
  // the third screenshot an honest way to exist.
  const word1 = await solveWord(page, { wrongGuesses: c.wrongGuesses ?? 3, onTiles });
  if (word1.kind !== 'solved') problems.push(`word 1 did not solve (ended on "${word1.kind}")`);

  const pixelsMid = c.flat ? null : await canvasVariance(page, 240);

  // On to the next word, then play the rest of the round out to the end screen.
  let words = 1;
  for (let i = 0; i < 6; i += 1) {
    const kind = await cardKind(page);
    if (kind === 'end') break;
    if (kind !== 'solved') {
      problems.push(`stuck on "${kind}" after word ${words}`);
      break;
    }
    await page.locator('.rr-panel .btn-primary').first().click();
    await page.waitForTimeout(500);
    if ((await cardKind(page)) === 'end') break;
    const next = await solveWord(page, { wrongGuesses: 0, onTiles });
    if (next.kind !== 'solved') {
      problems.push(`word ${words + 1} did not solve (ended on "${next.kind}")`);
      break;
    }
    words += 1;
  }

  // The last "See the score" press.
  if ((await cardKind(page)) === 'solved') {
    await page.locator('.rr-panel .btn-primary').first().click();
    await page.waitForTimeout(500);
  }

  const end = await page.evaluate(() => {
    const node = document.querySelector('.rr-end');
    if (!node) return null;
    const buttons = Array.from(document.querySelectorAll('.rr-panel .btn')).map((b) =>
      (b.textContent || '').trim()
    );
    return { text: (node.innerText || '').trim(), buttons };
  });

  const shotEnd = path.join(SHOTS, `${c.name}-end.png`);
  await page.screenshot({ path: shotEnd });
  shots.push(shotEnd);

  // --- the verdict -------------------------------------------------------------

  if (words < 2) problems.push(`only ${words} word(s) solved, wanted 2+`);

  if (at6) {
    if (!at6.ok) problems.push(`probe at six tiles unavailable: ${at6.why}`);
    else {
      if (!(at6.visible > 0)) problems.push('nothing showed through after six tiles popped');
      if (Math.abs(at6.visible - 6 / TILE_COUNT) > 1e-9) {
        problems.push(`six tiles popped showed ${at6.visible}, wanted exactly ${6 / TILE_COUNT}`);
      }
    }
  } else {
    problems.push('never observed the board at six tiles popped');
  }

  if (at12 && at12.ok && Math.abs(at12.visible - 1) > 1e-9) {
    problems.push(`twelve tiles popped showed ${at12.visible}, wanted the whole character`);
  }

  if (!end) problems.push('no end screen');
  else {
    if (!/point/.test(end.text)) problems.push(`end screen has no score: ${end.text}`);
    if (!end.buttons.includes('Play again')) problems.push('end screen has no Play again');
    if (!end.buttons.includes('Pick another game')) problems.push('end screen has no Pick another game');
  }

  const spoke = await page.evaluate(() => window.__spoke || 0);
  const unlocks = await page.evaluate(() => window.__unlocks || 0);
  const audioCtx = await page.evaluate(() => window.__audioCtx || 0);
  const oscillators = await page.evaluate(() => window.__oscillators || 0);
  if (spoke !== 0) problems.push(`something tried to speak ${spoke} time(s)`);
  if (audioCtx !== 0) problems.push(`silent mode still opened ${audioCtx} AudioContext(s)`);
  if (oscillators !== 0) problems.push(`silent mode still started ${oscillators} oscillator(s)`);
  if (errors.length) problems.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);

  const scroll = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  if (scroll.doc > scroll.win + 1) {
    problems.push(`horizontal scroll: content ${scroll.doc}px in a ${scroll.win}px window`);
  }

  for (const [label, px] of [
    ['at rest', pixels0],
    ['mid game', pixelsMid],
  ]) {
    if (!px) continue;
    if (!px.ok) problems.push(`canvas unreadable ${label}: ${px.why}`);
    else {
      if (px.sampled < 200) problems.push(`only ${px.sampled} pixels sampled ${label}`);
      if (!(px.variance > 1)) problems.push(`flat canvas ${label}: variance ${px.variance}`);
      if (px.drawn < px.sampled * 0.05) problems.push(`almost nothing drawn ${label}: ${px.drawn}`);
    }
  }

  await ctx.close();
  return {
    case: c.name,
    mode,
    words,
    visible: { atZero: at0 && at0.visible, atSix: at6 && at6.visible, atTwelve: at12 && at12.visible },
    offScreenSamples: {
      atZero: at0 && at0.offScreen,
      atSix: at6 && at6.offScreen,
      atTwelve: at12 && at12.offScreen,
    },
    clipAtZero: at0 && at0.clip,
    fit,
    board: at0 && at0.board,
    hidden: at0 && at0.word,
    end,
    spoke,
    silentUnlockFrames: unlocks,
    audioCtx,
    oscillators,
    errors,
    pixels: { atRest: pixels0, midGame: pixelsMid },
    shots,
    problems,
  };
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: GL_ARGS });

  const cases = [
    { name: '3d-1280x800', size: { width: 1280, height: 800 }, flat: false, wrongGuesses: 3 },
    { name: 'flat-1280x800', size: { width: 1280, height: 800 }, flat: true, wrongGuesses: 3 },
    { name: '3d-390x844', size: { width: 390, height: 844 }, flat: false, wrongGuesses: 3 },
    // The other two viewports the spec names. Fit and hiding only: replaying a
    // whole round on every size would buy nothing the three above have not
    // already proved.
    { name: '3d-820x1180', size: { width: 820, height: 1180 }, flat: false, layoutOnly: true },
    { name: '3d-1440x900', size: { width: 1440, height: 900 }, flat: false, layoutOnly: true },
    { name: 'flat-390x844', size: { width: 390, height: 844 }, flat: true, layoutOnly: true },
  ];

  const results = [];
  let bad = 0;
  for (const c of cases) {
    let row;
    try {
      row = await runCase(browser, c);
    } catch (error) {
      row = { case: c.name, problems: [`threw: ${String(error && error.message)}`] };
    }
    if (row.problems && row.problems.length) bad += 1;
    results.push(row);
    L(`${row.problems && row.problems.length ? 'FAIL' : 'PASS'}  ${c.name}`);
    for (const p of row.problems || []) L(`        ${p}`);
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  console.log(bad === 0 ? '\nREVEAL RUSH GATE: PASS' : `\nREVEAL RUSH GATE: FAIL (${bad} case(s))`);
  process.exit(bad === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

