// The render + play gate for Sky Tower.
//
// Modelled on verify-kit-demo.cjs. A green build and a canvas element prove
// nothing: a blank canvas passes both, and a game that never drops a block
// passes a typecheck. This harness pastes a real word list on the home page,
// opens Sky Tower from the set page, plays a whole round by clicking the DOM,
// and fails unless the tower actually reached the target, the end screen came
// up, the canvas has content in it, nothing spoke, and the console is clean.
//
// It does the same for the CSS twin at ?flat=1 and again at phone size.
//
// Silence: `?silent=1` plus an init script that stubs speechSynthesis, media
// playback AND the AudioContext, and Chromium is launched with --mute-audio.
// Nothing here makes a sound on this machine.
//
// Run:
//   npm run cf:dev -- --port 8812          # in another shell
//   NODE_PATH=/path/to/node_modules \
//     BVG_BASE=http://localhost:8812 node tests/e2e/verify-sky-tower.cjs
//
// Env: BVG_BASE (default http://localhost:8812), BVG_CHROME, BVG_SHOTS.

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

const BASE = process.env.BVG_BASE || 'http://localhost:8812';
const SHOTS = process.env.BVG_SHOTS || path.join(__dirname, '..', '..', 'scratch', 'tower');

const WORDS = '苹果 香蕉 葡萄 西瓜 草莓 橙子 桃子 梨';

/** Software GL plus a hard mute: a headless machine has no GPU and no ears. */
const GL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--mute-audio',
];

async function silence(ctx) {
  await ctx.addInitScript(() => {
    window.__spoke = 0;
    window.__played = 0;
    try {
      localStorage.setItem('vocab-silent', '1');
      // A stale personal best would make the "Best" line untestable.
      localStorage.removeItem('bvg.skytower.best.v1');
    } catch {
      /* private mode */
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = () => {
        window.__spoke += 1;
      };
      window.speechSynthesis.cancel = () => {};
      window.speechSynthesis.getVoices = () => [];
    }
    // The app unlocks iOS audio on the first tap by playing one silent WAV data
    // URI and pausing it. That is not a sound, so it is not counted; anything
    // with real audio behind it is.
    window.__playedSrc = [];
    HTMLMediaElement.prototype.play = function () {
      const src = String(this.currentSrc || this.src || '');
      if (!/^data:audio\/wav;base64,UklGRiQ/.test(src)) {
        window.__played += 1;
        window.__playedSrc.push(src.slice(0, 60));
      }
      return Promise.resolve();
    };
    // feedback.ts makes its correct/wrong blips with WebAudio. Deleting the
    // constructor used to be how this harness stayed quiet, and that is exactly
    // why it could not see that the app ignored ?silent=1: a blip that cannot
    // happen also cannot be measured. So the constructor stays, wired to a
    // recorder that makes no sound, and `audioCtx: 0` becomes a reading.
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

/**
 * Variance across sampled pixels, read through the game's `__towerPixels` hook
 * so the draw and the readback happen in the SAME task. Reading from outside
 * always returns zeros: the browser wipes a WebGL drawing buffer when it
 * composites, and this canvas does not pay for `preserveDrawingBuffer`.
 *
 * A blank or single-colour canvas scores variance 0, which is the failure this
 * whole harness exists to catch.
 */
async function canvasVariance(page, samples) {
  return page.evaluate((want) => {
    if (!document.querySelector('canvas')) return { ok: false, why: 'no canvas element' };
    const read = window.__towerPixels;
    if (typeof read !== 'function') return { ok: false, why: '__towerPixels hook missing' };
    const out = read(want);
    if (!out || !out.lum || !out.lum.length) return { ok: false, why: 'hook returned nothing' };
    const lum = out.lum;
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const variance = lum.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lum.length;
    return { ok: true, sampled: lum.length, mean, variance, drawn: out.drawn, w: out.w, h: out.h };
  }, samples);
}

/** The zh <-> en pairs the set page is showing, so the harness can answer. */
async function readWords(page) {
  return page.$$eval('.word-list .word-row', (rows) =>
    rows.map((row) => ({
      zh: ((row.querySelector('.word-zh .zh') || {}).textContent || '').trim(),
      en: ((row.querySelector('.word-en') || {}).textContent || '').trim(),
    }))
  );
}

/** The open question: its prompt and its choice labels, in order. */
async function readQuestion(page) {
  return page.evaluate(() => {
    const big = document.querySelector('.quiz-prompt .big');
    const buttons = Array.from(document.querySelectorAll('.choices .choice'));
    if (!big || buttons.length === 0) return null;
    const anyEnabled = buttons.some((b) => !b.disabled);
    return {
      prompt: (big.textContent || '').trim(),
      choices: buttons.map((b) => {
        const inner = b.querySelector('span span');
        return ((inner ? inner.textContent : b.textContent) || '').trim();
      }),
      open: anyEnabled,
    };
  });
}

/** The two numbers the game bar shows: blocks placed and the target. */
async function readBar(page) {
  return page.evaluate(() => {
    const stats = Array.from(document.querySelectorAll('.tower-bar .stat')).map((s) =>
      (s.textContent || '').trim()
    );
    const blocks = (stats.find((s) => s.startsWith('Blocks')) || '').match(/(\d+)\s*\/\s*(\d+)/);
    const clock = (stats.find((s) => s.startsWith('Time')) || '').match(/(\d+):(\d\d)/);
    return {
      placed: blocks ? Number(blocks[1]) : null,
      target: blocks ? Number(blocks[2]) : null,
      clock: clock ? `${clock[1]}:${clock[2]}` : null,
    };
  });
}

/** Which choice is right, given the set's word list and the prompt direction. */
function answerIndex(words, q) {
  const zh2en = new Map(words.map((w) => [w.zh, w.en]));
  const en2zh = new Map(words.map((w) => [w.en, w.zh]));
  const want = zh2en.has(q.prompt) ? zh2en.get(q.prompt) : en2zh.get(q.prompt);
  if (want === undefined) return -1;
  return q.choices.indexOf(want);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const query = c.flat ? '?silent=1&probe=1&flat=1' : '?silent=1&probe=1';

  await page.goto(`${BASE}/${query}#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#paste', { timeout: 15000 });
  await page.fill('#paste', WORDS);
  await page.getByRole('button', { name: 'Make games', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/set/'), null, { timeout: 15000 });

  const words = await readWords(page);
  if (words.length !== 8) problems.push(`set page shows ${words.length} words, wanted 8`);

  // Open Sky Tower the way a teacher does: the card on the set page.
  const card = page.locator('.game-card', { hasText: 'Sky Tower' });
  if ((await card.count()) === 0) {
    problems.push('no Sky Tower card on the set page');
    await ctx.close();
    return { case: c.name, problems, errors, shots };
  }
  await card.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/play/sky-tower/'), null, {
    timeout: 15000,
  });
  await page.waitForSelector('.tower-stage', { timeout: 10000 });
  await page.waitForTimeout(1200);

  const start = await readBar(page);
  const target = start.target;
  if (!target) problems.push('game bar never showed a target');

  const mode3d = !c.flat;
  if (mode3d && (await page.locator('.tower-stage canvas').count()) === 0) {
    problems.push('3D mode drew no canvas');
  }
  if (c.flat && (await page.locator('.tower-flat-world').count()) === 0) {
    problems.push('flat mode drew no CSS world');
  }

  // --- one deliberate wrong answer, to prove nothing falls ------------------
  let wrongChecked = false;
  if (c.checkWrong) {
    const q = await readQuestion(page);
    if (q && q.open) {
      const right = answerIndex(words, q);
      const wrong = q.choices.findIndex((_, i) => i !== right);
      const before = (await readBar(page)).placed;
      await page.locator('.choices .choice').nth(wrong).click();
      await page.waitForTimeout(700);
      const after = (await readBar(page)).placed;
      if (after !== before) problems.push(`a wrong answer changed the tower: ${before} -> ${after}`);
      const greens = await page.locator('.choices .choice.right').count();
      if (greens !== 1) problems.push(`wrong answer revealed ${greens} correct choices, wanted 1`);
      // The two-second pause: the next question must NOT be open yet.
      const midPause = await readQuestion(page);
      if (midPause && midPause.open) problems.push('no pause after a wrong answer');
      await page.waitForTimeout(1800);
      wrongChecked = true;
    }
  }

  // --- play to the target ---------------------------------------------------
  let answered = 0;
  let midShot = false;
  const deadline = Date.now() + 150_000;

  while (Date.now() < deadline) {
    if ((await page.locator('.final').count()) > 0) break;
    const q = await readQuestion(page);
    if (!q || !q.open) {
      await sleep(120);
      continue;
    }
    const right = answerIndex(words, q);
    if (right < 0) {
      problems.push(`could not answer "${q.prompt}" from the set's own words`);
      break;
    }
    await page.locator('.choices .choice').nth(right).click();
    answered += 1;
    await sleep(160);

    const bar = await readBar(page);
    if (!midShot && bar.placed >= Math.min(4, target)) {
      midShot = true;
      const shot = path.join(SHOTS, `${c.name}-mid.png`);
      await page.screenshot({ path: shot });
      shots.push(shot);
    }
  }

  // Short enough that the 3D confetti (900 ms) is still in the air for the
  // finish screenshot, long enough for the end screen to have painted.
  await page.waitForSelector('.final', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(350);
  const end = await readBar(page);
  const finalText = await page
    .locator('.final')
    .first()
    .textContent()
    .catch(() => null);

  // The canvas has to have something in it AT THE END, with a tower on screen.
  const pixels = mode3d ? await canvasVariance(page, 240) : null;

  const flatBlocks = c.flat ? await page.locator('.tower-flat-block').count() : null;

  const finishShot = path.join(SHOTS, `${c.name}-finish.png`);
  await page.screenshot({ path: finishShot });
  shots.push(finishShot);

  const spoke = await page.evaluate(() => window.__spoke || 0);
  const played = await page.evaluate(() => window.__played || 0);
  const playedSrc = await page.evaluate(() => window.__playedSrc || []);
  const audioCtx = await page.evaluate(() => window.__audioCtx || 0);
  const oscillators = await page.evaluate(() => window.__oscillators || 0);

  const scrollX = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));

  const playAgain = await page.getByRole('button', { name: 'Play again', exact: true }).count();
  const pickAnother = await page
    .getByRole('button', { name: 'Pick another game', exact: true })
    .count();

  if (!finalText) problems.push('no end screen');
  else {
    if (!/touched the clouds/.test(finalText)) {
      problems.push(`end screen did not say the tower finished: ${finalText.slice(0, 90)}`);
    }
    if (!/Height \d+ blocks/.test(finalText)) problems.push('end screen has no height');
    if (!/Time \d+:\d\d/.test(finalText)) problems.push('end screen has no time');
  }
  if (playAgain !== 1) problems.push(`Play again buttons: ${playAgain}`);
  if (pickAnother !== 1) problems.push(`Pick another game buttons: ${pickAnother}`);
  if (target && end.placed !== target) problems.push(`ended at ${end.placed} of ${target} blocks`);
  if (c.flat && target && flatBlocks !== target) {
    problems.push(`flat twin drew ${flatBlocks} blocks, wanted ${target}`);
  }
  if (spoke !== 0) problems.push(`something tried to speak (${spoke})`);
  if (played !== 0) problems.push(`something tried to play audio: ${playedSrc.join(', ')}`);
  if (audioCtx !== 0) problems.push(`silent mode still opened ${audioCtx} AudioContext(s)`);
  if (oscillators !== 0) problems.push(`silent mode still started ${oscillators} oscillator(s)`);
  if (errors.length) problems.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  if (scrollX.doc > scrollX.win + 1) {
    problems.push(`horizontal scroll: ${scrollX.doc} > ${scrollX.win}`);
  }
  if (mode3d) {
    if (!pixels || !pixels.ok) problems.push(`canvas unreadable: ${pixels && pixels.why}`);
    else {
      if (pixels.sampled < 200) problems.push(`only ${pixels.sampled} pixels sampled, wanted 200+`);
      if (!(pixels.variance > 1)) problems.push(`flat canvas: variance ${pixels.variance}`);
      if (pixels.drawn < pixels.sampled * 0.05) problems.push(`almost nothing drawn: ${pixels.drawn}`);
    }
  }

  await ctx.close();
  return {
    case: c.name,
    target,
    placed: end.placed,
    answered,
    wrongChecked,
    flatBlocks,
    spoke,
    played,
    playedSrc,
    audioCtx,
    oscillators,
    pixels,
    finalText: finalText ? finalText.replace(/\s+/g, ' ').trim().slice(0, 160) : null,
    errors,
    shots,
    problems,
  };
}

/**
 * The route-flip check (panel round 1, M4).
 *
 * A teacher bounces between the set page and a game all lesson. Every visit
 * builds a WebGL context; `renderer.dispose()` alone does not give one back,
 * Chrome caps them at about sixteen per tab and silently kills the oldest, and
 * the symptom is a blank canvas in a game that worked five minutes earlier.
 *
 * Two readings, because either one alone can lie: exactly one canvas may be in
 * the document after each flip (a leaked canvas means the old view was never
 * torn down), and the last visit must still DRAW (variance > 1), which is what
 * a killed context would fail.
 */
async function runLeakCase(browser, c) {
  const ctx = await browser.newContext({ viewport: c.size, deviceScaleFactor: 1 });
  await silence(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const problems = [];
  const canvases = [];

  await page.goto(`${BASE}/?silent=1&probe=1#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#paste', { timeout: 15000 });
  await page.fill('#paste', WORDS);
  await page.getByRole('button', { name: 'Make games', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/set/'), null, { timeout: 15000 });
  const setHash = await page.evaluate(() => location.hash);

  for (let visit = 1; visit <= 5; visit++) {
    const card = page.locator('.game-card', { hasText: 'Sky Tower' });
    await card.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => location.hash.startsWith('#/play/sky-tower/'), null, {
      timeout: 15000,
    });
    await page.waitForSelector('.tower-stage canvas', { timeout: 10000 });
    await page.waitForTimeout(900);

    const n = await page.locator('canvas').count();
    canvases.push(n);
    if (n > 1) problems.push(`visit ${visit} left ${n} canvases in the document`);

    if (visit === 5) {
      const px = await canvasVariance(page, 400);
      if (!px || !px.ok) problems.push(`visit 5 canvas unreadable: ${px && px.why}`);
      else if (!(px.variance > 1)) {
        problems.push(`visit 5 drew nothing: variance ${px.variance} (context probably lost)`);
      }
    }

    // Back to the set page, the way the game's own button does it.
    await page.evaluate((hash) => {
      location.hash = hash;
    }, setHash);
    await page.waitForSelector('.game-card', { timeout: 10000 });
    await page.waitForTimeout(400);

    const left = await page.locator('canvas').count();
    if (left !== 0) problems.push(`visit ${visit} left ${left} canvas(es) on the set page`);
  }

  const audioCtx = await page.evaluate(() => window.__audioCtx || 0);
  if (audioCtx !== 0) problems.push(`silent mode still opened ${audioCtx} AudioContext(s)`);
  if (errors.length) problems.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);

  await ctx.close();
  return { case: c.name, canvases, audioCtx, errors, shots: [], problems };
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: GL_ARGS });

  const cases = [
    { name: '3d-1280x800', size: { width: 1280, height: 800 }, flat: false, checkWrong: true },
    { name: 'flat-1280x800', size: { width: 1280, height: 800 }, flat: true },
    { name: '3d-390x844', size: { width: 390, height: 844 }, flat: false },
    { name: 'flat-390x844', size: { width: 390, height: 844 }, flat: true },
    { name: '3d-820x1180', size: { width: 820, height: 1180 }, flat: false },
    { name: '3d-1440x900', size: { width: 1440, height: 900 }, flat: false },
    { name: 'route-flip-x5', size: { width: 1280, height: 800 }, leak: true },
  ];

  const results = [];
  let bad = 0;
  for (const c of cases) {
    const go = c.leak ? runLeakCase : runCase;
    const row = await go(browser, c).catch((e) => ({
      case: c.name,
      problems: [`threw: ${String(e).slice(0, 200)}`],
      shots: [],
    }));
    if (row.problems.length) bad += 1;
    results.push(row);
    console.log(`${row.case}: ${row.problems.length === 0 ? 'ok' : row.problems.join(' | ')}`);
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  console.log(bad === 0 ? '\nSKY TOWER GATE: PASS' : `\nSKY TOWER GATE: FAIL (${bad} case(s))`);
  process.exit(bad === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

