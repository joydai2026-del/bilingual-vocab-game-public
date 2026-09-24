// Round-2 screenshot run for the zh-term / zh-definition UI.
//
// Not a gate: it drives the real surface with fixture 78 and SAVES the pictures
// so they can be looked at. Silence is copied from verify-tone-catcher.cjs
// (?silent=1, a speechSynthesis stub that COUNTS, a dead AudioContext,
// --mute-audio). Nothing here is allowed to make a sound on this machine.
//
// Run:
//   BVG_BASE=http://localhost:8829 BVG_SHOTS=<dir> node tests/e2e/shot-zhzh-ui.cjs

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
  const cache = path.join(process.env.HOME || '', 'Library/Caches/ms-playwright');
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
    /* no download cache */
  }
  found.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  );
  const usable = found.find((c) => fs.existsSync(c));
  if (!usable) throw new Error('no Chromium found; set BVG_CHROME to one');
  return usable;
})();

const BASE = process.env.BVG_BASE || 'http://localhost:8829';
const SHOTS = process.env.BVG_SHOTS || path.join(__dirname, '..', '..', 'scratch', 'zhzh');
const PASTE = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'teacher-pastes', '78-quizlet-zh-term-zh-definition.txt'),
  'utf8'
);

/** An English-meaning set: the control that proves text lanes are untouched. */
const PASTE_EN = ['\u82f9\u679c apple', '\u9999\u8549 banana', '\u8001\u5e08 teacher', '\u5b66\u751f student', '\u670b\u53cb friend', '\u6c34 water'].join('\n');

const GL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--mute-audio',
];

async function silence(ctx) {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('vocab-silent', '1');
    } catch {
      /* private mode */
    }
    window.__spoke = 0;
    window.__audioCtx = 0;
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = () => {
        window.__spoke += 1;
      };
      window.speechSynthesis.cancel = () => {};
      window.speechSynthesis.getVoices = () => [];
    }
    HTMLMediaElement.prototype.play = function () {
      return Promise.resolve();
    };
    const Dead = function () {
      window.__audioCtx += 1;
      return {
        state: 'suspended',
        currentTime: 0,
        destination: {},
        resume: () => Promise.resolve(),
        createOscillator: () => ({
          type: 'sine',
          frequency: { setValueAtTime() {} },
          connect: () => ({ connect() {} }),
          start() {},
          stop() {},
        }),
        createGain: () => ({
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect: () => ({ connect() {} }),
        }),
      };
    };
    window.AudioContext = Dead;
    window.webkitAudioContext = Dead;
  });
}

async function makeSet(page, text = PASTE) {
  await page.goto(`${BASE}/?silent=1&probe=1#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#paste', { timeout: 20000 });
  await page.fill('#paste', text);
  await page.getByRole('button', { name: 'Big kids and adults', exact: true }).click();
  await page.getByRole('button', { name: 'Make games', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/set/'), null, {
    timeout: 40000,
    polling: 100,
  });
  return page.evaluate(() => location.hash.replace('#/set/', '').split('?')[0]);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: GL_ARGS });
  const out = {};

  // --- 1. Memory Match, a flipped SENTENCE tile, 390 px ----------------------
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await silence(phone);
  const p1 = await phone.newPage();
  const enc = await makeSet(p1);
  console.log('set built:', enc.slice(0, 24), '...');

  await p1.goto(`${BASE}/?silent=1&probe=1#/play/memory/${enc}`, {
    waitUntil: 'domcontentloaded',
  });
  await p1.waitForSelector('.memory-card', { timeout: 20000 });

  // Flip cards until a meaning face (the Chinese sentence) is showing. The
  // grid is shuffled, so which card that is changes every run.
  const total = await p1.locator('.memory-card').count();
  let shown = 0;
  for (let i = 0; i < total && shown < 2; i++) {
    await p1.locator('.memory-card').nth(i).click({ force: true });
    await p1.waitForTimeout(120);
    shown = await p1.evaluate(
      () => document.querySelectorAll('.memory-card.up .face.zh-sentence').length
    );
    if (shown === 0) {
      // Two non-matching cards flip back on the next click; keep going.
      await p1.waitForTimeout(60);
    }
  }
  out.memoryFaces = await p1.evaluate(() =>
    Array.from(document.querySelectorAll('.memory-card.up .face.zh-sentence, .memory-card.done .face.zh-sentence')).map(
      (el) => {
        const cs = getComputedStyle(el);
        const tile = el.closest('.memory-card');
        return {
          text: el.textContent,
          fontSize: cs.fontSize,
          wordBreak: cs.wordBreak,
          lineClamp: cs.webkitLineClamp,
          lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
          tile: tile
            ? { w: Math.round(tile.getBoundingClientRect().width), h: Math.round(tile.getBoundingClientRect().height) }
            : null,
        };
      }
    )
  );
  out.memoryTileHeights = await p1.evaluate(() =>
    Array.from(document.querySelectorAll('.memory-card')).map((el) =>
      Math.round(el.getBoundingClientRect().height)
    )
  );
  await p1.screenshot({ path: path.join(SHOTS, '1-memory-390-sentence-tile.png'), fullPage: false });
  console.log('shot 1 written');

  // --- 2a. Tone Catcher, easy mode, 390 px ----------------------------------
  await p1.goto(`${BASE}/?silent=1&probe=1#/play/tone/${enc}`, { waitUntil: 'domcontentloaded' });
  await p1.waitForSelector('.tc-host canvas, .tc-host .tc-flat', { timeout: 25000 });
  await p1.getByRole('button', { name: 'Easy', exact: true }).click();
  await p1.waitForSelector('.tc-legend-row', { timeout: 20000 });
  await p1.waitForTimeout(900);
  out.legend390 = await p1.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('.tc-legend-row')).map((el) => ({
      text: el.textContent,
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    })),
    hint: document.querySelector('.tc-hint')?.textContent || null,
    gateLabels: Array.from(document.querySelectorAll('.tc-gate-label')).map((el) => el.textContent),
  }));
  await p1.screenshot({ path: path.join(SHOTS, '2-tone-easy-390.png'), fullPage: false });
  console.log('shot 2 written');

  // --- 2b. one gate resolved by TAPPING a legend row ------------------------
  // The tap is the alternative to running the bean into the lane, so the row
  // has to light as the lane in flight and then the gate has to settle on it.
  await p1.locator('.tc-legend-row').nth(1).click();
  await p1.waitForFunction(
    () =>
      document.querySelectorAll('.tc-legend-row')[1]?.classList.contains('tc-legend-here') === true,
    null,
    { timeout: 8000, polling: 30 }
  );
  const reveal = await p1.waitForFunction(
    () => {
      const rows = Array.from(document.querySelectorAll('.tc-legend-row'));
      const right = rows.findIndex((el) => el.classList.contains('tc-legend-right'));
      if (right < 0) return null;
      return {
        right,
        here: rows.findIndex((el) => el.classList.contains('tc-legend-here')),
        verdict: document.querySelector('.verdict')?.textContent || null,
      };
    },
    null,
    { timeout: 40000, polling: 25 }
  );
  await p1.screenshot({ path: path.join(SHOTS, '3-tone-easy-390-legend-tap.png'), fullPage: false });
  out.legendTap = await reveal.jsonValue();
  console.log('shot 3 written');

  // --- 2c. the set page and the review page, same set, 390 px ---------------
  await p1.goto(`${BASE}/?silent=1&probe=1#/set/${enc}`, { waitUntil: 'domcontentloaded' });
  await p1.waitForSelector('.game-card', { timeout: 20000 });
  await p1.waitForTimeout(300);
  out.setPage = await p1.evaluate(() => ({
    english: (document.body.innerText.match(/English/g) || []).length,
    memoryWhy:
      Array.from(document.querySelectorAll('.game-card')).find((c) =>
        c.textContent?.includes('Memory Match')
      )?.textContent || null,
  }));
  await p1.screenshot({ path: path.join(SHOTS, '6-set-390.png'), fullPage: true });
  console.log('shot 6 written');

  await p1.goto(`${BASE}/?silent=1&probe=1#/review`, { waitUntil: 'domcontentloaded' });
  await p1.waitForSelector('table', { timeout: 20000 });
  await p1.waitForTimeout(300);
  out.reviewPage = await p1.evaluate(() => ({
    headers: Array.from(document.querySelectorAll('thead th')).map((el) => el.textContent),
    english: (document.body.innerText.match(/English/g) || []).length,
    blanks: document.querySelector('.blank-count')?.textContent || null,
  }));
  await p1.screenshot({ path: path.join(SHOTS, '7-review-390.png'), fullPage: false });
  console.log('shot 7 written');

  const spoke390 = await p1.evaluate(() => ({ spoke: window.__spoke, ctx: window.__audioCtx }));
  await phone.close();

  // --- 2b. Tone Catcher, easy mode, 1280 px ---------------------------------
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await silence(desk);
  const p2 = await desk.newPage();
  await p2.goto(`${BASE}/?silent=1&probe=1#/play/tone/${enc}`, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.tc-host canvas, .tc-host .tc-flat', { timeout: 25000 });
  await p2.getByRole('button', { name: 'Easy', exact: true }).click();
  await p2.waitForSelector('.tc-legend-row', { timeout: 20000 });
  await p2.waitForTimeout(900);
  out.legend1280 = await p2.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('.tc-legend-row')).map((el) => ({
      text: el.textContent,
      w: Math.round(el.getBoundingClientRect().width),
    })),
    gateLabels: Array.from(document.querySelectorAll('.tc-gate-label')).map((el) => el.textContent),
  }));
  await p2.screenshot({ path: path.join(SHOTS, '4-tone-easy-1280.png'), fullPage: false });
  console.log('shot 4 written');
  const spoke1280 = await p2.evaluate(() => ({ spoke: window.__spoke, ctx: window.__audioCtx }));
  await desk.close();

  // --- 2d. the control: an ENGLISH-meaning set, easy mode, 390 px -----------
  // Nothing about this set is CJK, so the gates must still carry the meaning
  // itself and no legend may appear under the stage.
  const phone2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await silence(phone2);
  const p3 = await phone2.newPage();
  const encEn = await makeSet(p3, PASTE_EN);
  await p3.goto(`${BASE}/?silent=1&probe=1#/play/tone/${encEn}`, {
    waitUntil: 'domcontentloaded',
  });
  await p3.waitForSelector('.tc-host canvas, .tc-host .tc-flat', { timeout: 25000 });
  await p3.getByRole('button', { name: 'Easy', exact: true }).click();
  await p3.waitForTimeout(1200);
  out.english390 = await p3.evaluate(() => ({
    legendRows: document.querySelectorAll('.tc-legend-row').length,
    legendHidden: document.querySelector('.tc-legend')?.hidden ?? null,
    laneNumbers: document.querySelectorAll('.tc-lane-no').length,
    gateLabels: Array.from(document.querySelectorAll('.tc-gate-label')).map((el) =>
      el.textContent?.trim()
    ),
    hint: document.querySelector('.tc-hint')?.textContent || null,
  }));
  await p3.screenshot({ path: path.join(SHOTS, '5-tone-easy-390-english.png'), fullPage: false });
  console.log('shot 5 written');
  const spokeEn = await p3.evaluate(() => ({ spoke: window.__spoke, ctx: window.__audioCtx }));
  await phone2.close();

  await browser.close();
  out.silence = { phone: spoke390, desktop: spoke1280, english: spokeEn };
  console.log(JSON.stringify(out, null, 2));
  if (
    spoke390.spoke ||
    spoke390.ctx ||
    spoke1280.spoke ||
    spoke1280.ctx ||
    spokeEn.spoke ||
    spokeEn.ctx
  ) {
    console.log('SOUND ESCAPED');
    process.exit(1);
  }
  console.log('SHOTS OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

