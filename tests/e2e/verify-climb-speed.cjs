// The live-surface gate for Cloud Climb's Speed slider.
//
// The claim under test is a wall-clock one, so this harness times it rather
// than reading a number out of the app: it sets the slider to Chill, waits for
// the round's own end screen, then sets it to Turbo and does it again, on its
// OWN clock. A unit test can prove the arithmetic; only this can prove that a
// child waits a third as long.
//
// Silence: `?silent=1`, plus an init script that stubs speechSynthesis (and
// COUNTS the calls, so the zero is evidence and not decoration), media playback
// and AudioContext. Chromium is launched with `--mute-audio` on top. Nothing
// here is allowed to make a sound on this machine.
//
// The counters are per-page and the TOTALS live here in Node: every navigation
// harvests the page it is leaving first, and a page that comes back with no
// audit object (or an unstubbed speechSynthesis) is recorded as a RECORDING
// FAILURE that fails the run, so "0 spoke" can never mean "nothing counted".
// A positive control at the top of the run speaks once on purpose and asserts
// the counter reads 1, which is what proves the stub and the counter work.
//
// Run:
//   npm run cf:dev -- --port 8822        # in another shell
//   NODE_PATH=/path/to/node_modules \
//     BVG_BASE=http://localhost:8822 BVG_SHOTS=<dir> node tests/e2e/verify-climb-speed.cjs
//
// Env: BVG_BASE (default http://localhost:8822), BVG_CHROME, BVG_SHOTS.

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

const BASE = process.env.BVG_BASE || 'http://localhost:8822';
const SHOTS = process.env.BVG_SHOTS || path.join(__dirname, '..', '..', 'scratch', 'climb-speed');
// Two words, both directions: a four-question round. Three words made a Chill
// round 84 s long on its own, which pushed the whole run past the watchdog; the
// per-question slot check below is the precise measurement, so the round only
// has to be long enough to separate the stops, not long enough to be a lesson.
const WORDS = '苹果 香蕉';
const SPEED_KEY = 'bvg.speed.climb.v1';
const STOPS = ['Chill', 'Steady', 'Quick', 'Fast', 'Turbo'];
const MULTS = [1, 1.5, 2, 2.5, 3];
/** Must match SPEED_COALESCE_MS in src/client/games/climb.ts. */
const COALESCE_MS = 250;

/** Software GL plus a hard mute: a headless machine has no GPU and no ears. */
const GL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--mute-audio',
];

const L = (s) => console.log(s);

async function silence(ctx) {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('vocab-silent', '1');
    } catch {
      /* private mode */
    }
    // Per-page counters on `window`. This init script runs again on every
    // navigation, so these reset each time on purpose: the Node process
    // harvests them BEFORE it navigates and keeps the running totals itself.
    // sessionStorage was the previous home and was wrong: a setItem that threw
    // while getItem still worked would swallow the call and leave the final
    // reader looking at a comforting 0.
    const audit = { spoke: 0, audioCtx: 0, speechStubbed: false };
    window.__bvgAudit = audit;
    const bump = (key) => {
      audit[key] += 1;
    };
    if (window.speechSynthesis) {
      // Counting, not just swallowing: a silent stub that never increments
      // makes the "spoke 0" assertion vacuous.
      window.speechSynthesis.speak = () => {
        bump('spoke');
      };
      window.speechSynthesis.cancel = () => {};
      window.speechSynthesis.getVoices = () => [];
      audit.speechStubbed = true;
    }
    HTMLMediaElement.prototype.play = function () {
      return Promise.resolve();
    };
    const Dead = function () {
      bump('audioCtx');
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

// --- the silence ledger, kept here in Node -----------------------------------

const audit = { spoke: 0, audioCtx: 0, pages: 0, failures: [] };

/**
 * Folds the page's counters into the Node-side totals. Called before every
 * navigation, because the next page's init script resets them. A page with no
 * audit object, or with speechSynthesis left unstubbed, is a RECORDING FAILURE:
 * it is added to `audit.failures`, and the final assertion fails on that list
 * rather than reporting a zero it never actually counted.
 */
async function harvest(page, where) {
  if (page.url() === 'about:blank') return;
  let seen = null;
  try {
    seen = await page.evaluate(() => {
      const a = window.__bvgAudit;
      return a ? { spoke: a.spoke, audioCtx: a.audioCtx, speechStubbed: a.speechStubbed } : null;
    });
  } catch (e) {
    audit.failures.push(`${where}: could not read the counters (${String(e).slice(0, 90)})`);
    return;
  }
  if (!seen) {
    audit.failures.push(`${where}: no audit object, so this page's calls were never counted`);
    return;
  }
  if (!seen.speechStubbed) audit.failures.push(`${where}: speechSynthesis was never stubbed`);
  audit.spoke += seen.spoke;
  audit.audioCtx += seen.audioCtx;
  audit.pages += 1;
}

const goTo = async (page, url) => {
  await harvest(page, `leaving ${page.url()}`);
  return page.goto(url, { waitUntil: 'domcontentloaded' });
};

const reloadPage = async (page) => {
  await harvest(page, 'reload');
  return page.reload({ waitUntil: 'domcontentloaded' });
};

/**
 * The positive control. Speaks once and opens one AudioContext ON PURPOSE, then
 * asserts both counters read 1 and resets them. Without this, a missing stub
 * and a silent run are the same number.
 */
async function positiveControl(page) {
  return page.evaluate(() => {
    const a = window.__bvgAudit;
    if (!a) return { ok: false, why: 'no audit object on the page' };
    try {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance('x'));
      new AudioContext();
    } catch (e) {
      return { ok: false, why: String(e).slice(0, 90) };
    }
    const got = { spoke: a.spoke, audioCtx: a.audioCtx };
    a.spoke = 0;
    a.audioCtx = 0;
    return { ok: got.spoke === 1 && got.audioCtx === 1, why: JSON.stringify(got), got };
  });
}

// --- restarts ----------------------------------------------------------------

/**
 * Counts round restarts from inside the page, and stamps each one with the
 * page's own clock. `start()` re-adds the same countdown element to the stage,
 * so one childList record with that node in it is exactly one restart. Timing a
 * round from this stamp (rather than from the instant the event was dispatched)
 * keeps the app's coalescing window out of the measurement.
 */
async function watchRestarts(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.countdown');
    const stage = el && el.parentElement;
    window.__restarts = stage ? 0 : -1;
    window.__lastRestartAt = 0;
    if (window.__restartObs) window.__restartObs.disconnect();
    if (!stage) return false;
    const obs = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node.nodeType === 1 && node.classList.contains('countdown')) {
            window.__restarts += 1;
            window.__lastRestartAt = Date.now();
          }
        }
      }
    });
    obs.observe(stage, { childList: true });
    window.__restartObs = obs;
    return true;
  });
}

const restarts = (page) => page.evaluate(() => window.__restarts);
const resetRestarts = (page) => page.evaluate(() => void (window.__restarts = 0));

/** Types the word list into the home page's one box and presses Make games. */
async function makeSet(page) {
  await goTo(page, `${BASE}/?silent=1#/`);
  await page.waitForSelector('#paste', { timeout: 15000 });
  // Before anything is measured: prove the stubs and the counters actually fire.
  const control = await positiveControl(page);
  await page.fill('#paste', WORDS);
  await page.getByRole('button', { name: 'Make games', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/set/'), null, {
    timeout: 20000,
    polling: 100,
  });
  const enc = await page.evaluate(() => location.hash.replace('#/set/', ''));
  // The set page prints the pairs, which is the only way this harness can pick
  // a RIGHT answer. Without one, "the score reset to 0" is vacuous: a wrong
  // answer scores 0 too, so the assertion would pass on a broken restart.
  const pairs = await page.evaluate(() =>
    [...document.querySelectorAll('.word-row')].map((row) => ({
      zh: ((row.querySelector('.zh') || {}).textContent || '').trim(),
      en: ((row.querySelector('.word-en') || {}).textContent || '').trim(),
    }))
  );
  return { enc, pairs, control };
}

/** "Question 3 of 6", read off the card, or null while the countdown is up. */
async function questionPos(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.quiz-prompt .dir');
    const m = /Question (\d+) of (\d+)/.exec((el && el.textContent) || '');
    return m ? { n: Number(m[1]), total: Number(m[2]) } : null;
  });
}

async function waitForQuestion(page, n, timeout) {
  await page.waitForFunction(
    (want) => {
      const el = document.querySelector('.quiz-prompt .dir');
      const m = /Question (\d+) of/.exec((el && el.textContent) || '');
      return Boolean(m) && Number(m[1]) === want;
    },
    n,
    // 50ms, not 100: the slot check below is a difference between two of these
    // observations, so the polling grain is half the measurement error.
    { timeout, polling: 50 }
  );
  return Date.now();
}

/** The score on the game bar, as a number. */
async function scoreNow(page) {
  return page.evaluate(() => {
    const stat = [...document.querySelectorAll('.stat')].find((s) =>
      (s.textContent || '').trim().startsWith('Score')
    );
    const b = stat ? stat.querySelector('b') : null;
    return b ? Number(b.textContent) : null;
  });
}

/**
 * Taps the correct choice for the question on screen, using the pairs scraped
 * from the set page. Returns false when the card is not answerable.
 */
async function answerCorrectly(page, pairs) {
  return page.evaluate((table) => {
    const promptEl = document.querySelector('.quiz-prompt .big');
    if (!promptEl) return false;
    const prompt = (promptEl.textContent || '').trim();
    const isZh = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(prompt);
    const row = table.find((r) => (isZh ? r.zh === prompt : r.en === prompt));
    if (!row) return false;
    const want = isZh ? row.en : row.zh;
    const buttons = [...document.querySelectorAll('.choices .choice')];
    const label = (b) => {
      const inner = b.querySelector('span span');
      return ((inner || b).textContent || '').trim();
    };
    const hit = buttons.find((b) => label(b) === want);
    if (!hit) return false;
    hit.click();
    return true;
  }, pairs);
}

/** What the Speed control currently says about itself. */
async function speedShape(page) {
  return page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Speed"]');
    if (!input) return null;
    const row = input.closest('.row');
    const wrap = input.closest('.speed');
    const ends = wrap ? [...wrap.querySelectorAll('.speed-end')].map((e) => e.textContent) : [];
    const name = wrap ? wrap.querySelector('.speed-name') : null;
    return {
      type: input.type,
      min: input.min,
      max: input.max,
      step: input.step,
      value: input.value,
      valuetext: input.getAttribute('aria-valuetext'),
      readout: name ? (name.textContent || '').trim() : null,
      ends,
      hint: row ? (row.querySelector('.hint') || {}).textContent : null,
      stored: (() => {
        try {
          return localStorage.getItem('bvg.speed.climb.v1');
        } catch {
          return 'unreadable';
        }
      })(),
    };
  });
}

/**
 * Sets the slider the cheap scripted way (value, then input, then change) and
 * waits for the restart it commits. Returns the PAGE's timestamp for that
 * restart, so a timed round is measured from the instant it actually began.
 *
 * This is the convenience path used to get the game into a state. It is not
 * evidence that the control works: a synthetic pair of events would pass on a
 * handler no real gesture ever reaches. The H block below drives the same
 * control with a real mouse drag and real key presses.
 */
async function setSpeed(page, index) {
  const before = await restarts(page);
  await page.evaluate((i) => {
    const input = document.querySelector('input[aria-label="Speed"]');
    input.value = String(i);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, index);
  await page.waitForFunction((n) => window.__restarts > n, before, {
    timeout: 5000,
    polling: 50,
  });
  return page.evaluate(() => window.__lastRestartAt);
}

/** True when a round is in flight: no end screen, and a question board present. */
async function midRound(page) {
  return page.evaluate(() => ({
    final: Boolean(document.querySelector('.final')),
    // The countdown div is always in the DOM; `hidden` is what says a round is
    // being counted in rather than played.
    counting: Boolean(
      document.querySelector('.countdown') && !document.querySelector('.countdown').hidden
    ),
    boards: document.querySelectorAll('.solo-board').length,
    board: Boolean(document.querySelector('.solo-board')),
  }));
}

async function overflow(page) {
  return page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
}

(async () => {
  const runStartedAt = Date.now();
  fs.mkdirSync(SHOTS, { recursive: true });
  L(`base    ${BASE}`);
  L(`chrome  ${EXE}`);
  L(`shots   ${SHOTS}`);
  L('');

  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: GL_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await silence(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const problems = [];
  const out = {};
  const check = (label, ok, detail) => {
    if (!ok) problems.push(detail ? `${label}: ${detail}` : label);
    L(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
  };

  try {
    const { enc, pairs, control } = await makeSet(page);
    out.pairs = pairs;
    out.control = control;
    check(
      'A0 positive control: a deliberate speak and AudioContext are both counted',
      control && control.ok,
      control && control.why
    );
    await goTo(page, `${BASE}/?silent=1#/play/climb/${enc}`);
    await page.waitForSelector('input[aria-label="Speed"]', { timeout: 15000 });
    out.watching = await watchRestarts(page);
    check('A0b the restart counter attached to the stage', out.watching === true);

    // --- the control's shape, before anything is touched ---------------------
    const first = await speedShape(page);
    out.initial = first;
    check('A1 the Speed control is a range input', first && first.type === 'range');
    check(
      'A2 it has exactly five stops',
      first && first.min === '0' && first.max === '4' && first.step === '1',
      first && `min=${first.min} max=${first.max} step=${first.step}`
    );
    check(
      'A3 turtle on the left, rocket on the right',
      first && first.ends.length === 2 && first.ends[0] === '🐢' && first.ends[1] === '🚀',
      first && JSON.stringify(first.ends)
    );
    check(
      'A4 it defaults to Quick, in the readout and in aria-valuetext',
      first &&
        first.value === '2' &&
        first.readout === 'Quick' &&
        first.valuetext === 'Quick, 2 times speed',
      first && `value=${first.value} readout=${first.readout} valuetext=${first.valuetext}`
    );
    check(
      'A5 the hint reads "How fast is the clock?"',
      first && String(first.hint || '').includes('How fast is the clock?'),
      first && String(first.hint)
    );
    // Scoped to the pace row on purpose: the pinyin toggle on the game bar is
    // `.segmented` too, so a bare `.segmented button` query is not this control.
    out.paceButtons = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.row')].find((r) =>
        ((r.querySelector('.hint') || {}).textContent || '').includes('How quick are they?')
      );
      return row ? [...row.querySelectorAll('.segmented button')].map((b) => b.textContent) : null;
    });
    check(
      'A6 the pace control is untouched beside it',
      (out.paceButtons || []).join(',') === 'Easy,Normal,Fast',
      JSON.stringify(out.paceButtons)
    );

    // --- play a bit of the default round, so the restart has something to undo -
    // A restart that is asserted from a standing start proves nothing: the
    // board is permanent and the end screen is absent during play, so BOTH
    // halves of the old B2 were true before the slider was ever touched. The
    // round is therefore driven forward and scored FIRST, and the assertion is
    // that the slider throws that progress away.
    await waitForQuestion(page, 1, 30000);
    out.roundShape = await questionPos(page);
    check(
      'B0 the round is running, on question 1 of a real list',
      out.roundShape && out.roundShape.n === 1 && out.roundShape.total >= 2,
      JSON.stringify(out.roundShape)
    );
    const answered = await answerCorrectly(page, pairs);
    await page.waitForTimeout(200);
    out.scoreBefore = await scoreNow(page);
    check(
      'B1 a correct answer scores, so there is progress to lose',
      answered && out.scoreBefore > 0,
      `answered=${answered} score=${out.scoreBefore}`
    );
    // Question 2 on screen: the clock is advancing, not stuck on the first card.
    await waitForQuestion(page, 2, 30000);
    out.beforeRestart = await questionPos(page);

    // --- Chill: the restart, then a whole round on the harness's clock --------
    const chillAt = await setSpeed(page, 0);
    await page.waitForTimeout(150);
    const afterChill = await speedShape(page);
    const restarted = await midRound(page);
    out.scoreAfter = await scoreNow(page);
    out.afterChill = afterChill;
    out.restarted = restarted;
    check(
      'B2 moving the slider changes the readout',
      afterChill && afterChill.readout === 'Chill' && afterChill.valuetext === 'Chill, 1 times speed',
      afterChill && `readout=${afterChill.readout} valuetext=${afterChill.valuetext}`
    );
    check(
      'B3 the restart throws the score away',
      out.scoreAfter === 0,
      `was ${out.scoreBefore}, now ${out.scoreAfter}`
    );
    check(
      'B4 the restart counts a fresh round in, mid-round',
      restarted.counting && !restarted.final,
      JSON.stringify(restarted)
    );
    check(
      'B5 exactly one board, so a restart never stacks a second one',
      restarted.boards === 1,
      `${restarted.boards} board element(s)`
    );
    const chillQ1At = await waitForQuestion(page, 1, 30000);
    out.afterRestartFirst = await questionPos(page);
    check(
      'B6 the new round starts again at question 1',
      out.afterRestartFirst &&
        out.afterRestartFirst.n === 1 &&
        out.beforeRestart &&
        out.beforeRestart.n === 2,
      `${JSON.stringify(out.beforeRestart)} -> ${JSON.stringify(out.afterRestartFirst)}`
    );
    // And it keeps going: a restart that froze on question 1 would stop here.
    const chillQ2At = await waitForQuestion(page, 2, 40000);
    out.chillSlotMs = chillQ2At - chillQ1At;
    check('B7 the restarted round goes on progressing', true);
    check(
      'B8 the choice is written to localStorage',
      afterChill && afterChill.stored === '0',
      afterChill && String(afterChill.stored)
    );

    await page.screenshot({ path: path.join(SHOTS, 'chill-mid.png') });
    await page.waitForSelector('.final', { timeout: 180000 });
    out.chillMs = Date.now() - chillAt;
    out.chillFinal = (await page.textContent('.final')).replace(/\s+/g, ' ').trim();

    // --- Turbo: the same round, the same clock -------------------------------
    const turboAt = await setSpeed(page, 4);
    await page.waitForTimeout(150);
    const afterTurbo = await speedShape(page);
    const restarted2 = await midRound(page);
    out.afterTurbo = afterTurbo;
    check(
      'C1 Turbo reads back as Turbo',
      afterTurbo &&
        afterTurbo.readout === 'Turbo' &&
        afterTurbo.valuetext === 'Turbo, 3 times speed',
      afterTurbo && `readout=${afterTurbo.readout}`
    );
    check(
      'C2 the end screen is replaced by a fresh round',
      restarted2.board && !restarted2.final,
      JSON.stringify(restarted2)
    );
    check('C3 Turbo is stored', afterTurbo && afterTurbo.stored === '4', afterTurbo && String(afterTurbo.stored));

    const turboQ1At = await waitForQuestion(page, 1, 30000);
    const turboQ2At = await waitForQuestion(page, 2, 30000);
    out.turboSlotMs = turboQ2At - turboQ1At;

    await page.screenshot({ path: path.join(SHOTS, 'turbo-mid.png') });
    await page.waitForSelector('.final', { timeout: 120000 });
    out.turboMs = Date.now() - turboAt;
    out.turboFinal = (await page.textContent('.final')).replace(/\s+/g, ' ').trim();
    await page.screenshot({ path: path.join(SHOTS, 'turbo-end.png') });

    // --- Quick: one slot at the middle stop ----------------------------------
    // Only the two end stops were ever timed, so a multiplier error confined to
    // a middle stop, or a snap to a neighbour on the DEFAULT stop, went unseen.
    // One slot is enough: the per-slot check is the precise measurement, and it
    // costs one question rather than a whole round.
    await setSpeed(page, 2);
    const quickQ1At = await waitForQuestion(page, 1, 30000);
    const quickQ2At = await waitForQuestion(page, 2, 30000);
    out.quickSlotMs = quickQ2At - quickQ1At;

    // A ratio alone would pass on a round that is wrong in BOTH directions (say
    // both twice as long as they should be). The schedule is known, so each
    // round is also held to an absolute window:
    //   START_DELAY_MS + questionCount x (round(base / multiplier) + GRACE_MS)
    // with base 12000 (kids) or 8000 (big), GRACE_MS 1500, START_DELAY_MS 3000.
    const START_DELAY_MS = 3_000;
    const GRACE_MS = 1_500;
    out.level = await page.evaluate(() =>
      document.body.classList.contains('level-kids') ? 'kids' : 'big'
    );
    const base = out.level === 'kids' ? 12_000 : 8_000;
    const count = (out.roundShape && out.roundShape.total) || 0;
    const slotFor = (i) => Math.round(base / MULTS[i]) + GRACE_MS;
    const expected = (i) => START_DELAY_MS + count * slotFor(i);
    /** The smaller distance from stop `i` to a neighbouring stop, per `of`. */
    const nearestGap = (i, of) => {
      const mine = of(i);
      const near = [];
      if (i > 0) near.push(Math.abs(of(i - 1) - mine));
      if (i < MULTS.length - 1) near.push(Math.abs(of(i + 1) - mine));
      return Math.min(...near);
    };
    // The band is derived from the SCHEDULE, not from a hand-picked percentage:
    // it is 90% of the half-distance to the nearest neighbouring stop, so a
    // reading that belongs to the stop above or below can never pass, and it is
    // capped at 6% so a wide gap does not turn into a wide band. The previous
    // version accepted +12%+4s, which let Fast's 40.8s pass as Turbo's 36s.
    const bandFor = (i, of) => {
      const want = of(i);
      const slack = Math.min((nearestGap(i, of) / 2) * 0.9, want * 0.06);
      return { want, slack, lo: want - slack, hi: want + slack };
    };
    const inBand = (ms, b) => ms >= b.lo && ms <= b.hi;
    const chillBand = bandFor(0, expected);
    const turboBand = bandFor(4, expected);
    // Slot bands are ASYMMETRIC on purpose. A busy machine can only report a
    // question change LATE (a starved main thread notices it after it happened),
    // never early, and a symmetric band therefore reds on correct code: a loaded
    // run measured the 7500ms Quick slot at 8190ms. So the upper side is sized
    // from the gap to the SLOWER neighbour and the lower side from the gap to
    // the FASTER one. Both sides still stop at 90% of that half-gap, so a
    // reading that belongs to a neighbouring stop can never pass. The 250ms
    // floor is the tick-plus-polling grain.
    const slotBandFor = (i) => {
      const want = slotFor(i);
      const slower = i > 0 ? Math.abs(slotFor(i - 1) - want) : Infinity;
      const faster = i < MULTS.length - 1 ? Math.abs(slotFor(i + 1) - want) : Infinity;
      const side = (gap) => Math.max(250, Math.min((gap / 2) * 0.9, want * 0.12));
      return { want, up: side(slower), down: side(faster), lo: want - side(faster), hi: want + side(slower) };
    };
    const chillSlot = slotBandFor(0);
    const turboSlot = slotBandFor(4);
    const quickSlot = slotBandFor(2);
    out.expected = {
      count,
      base,
      chill: chillBand,
      turbo: turboBand,
      chillSlot,
      turboSlot,
      quickSlot,
    };
    check(
      'D1 a Turbo round really is much shorter than a Chill one',
      count > 0 && out.turboMs < out.chillMs * (turboBand.want / chillBand.want + 0.08),
      `chill ${out.chillMs}ms vs turbo ${out.turboMs}ms (schedule says ${chillBand.want} vs ${turboBand.want})`
    );
    check(
      'D1a the Chill round lands on its own scheduled length, not Steady\'s',
      count > 0 && inBand(out.chillMs, chillBand),
      `${out.chillMs}ms vs ${chillBand.want}ms +/-${Math.round(chillBand.slack)} (${count} questions, ${out.level})`
    );
    check(
      'D1b the Turbo round lands on its own scheduled length, not Fast\'s',
      count > 0 && inBand(out.turboMs, turboBand),
      `${out.turboMs}ms vs ${turboBand.want}ms +/-${Math.round(turboBand.slack)} (${count} questions, ${out.level})`
    );
    // The round total is one number over many slots, so a per-slot error could
    // hide inside it. This is the direct observation: the gap between question 1
    // and question 2 appearing on screen IS the slot the round was built with.
    check(
      'D1c the observed Chill slot is the Chill slot',
      inBand(out.chillSlotMs, chillSlot),
      `${out.chillSlotMs}ms vs ${chillSlot.want}ms (band ${Math.round(chillSlot.lo)}-${Math.round(chillSlot.hi)})`
    );
    check(
      'D1d the observed Turbo slot is the Turbo slot',
      inBand(out.turboSlotMs, turboSlot),
      `${out.turboSlotMs}ms vs ${turboSlot.want}ms (band ${Math.round(turboSlot.lo)}-${Math.round(turboSlot.hi)})`
    );
    check(
      'D1e the observed Quick slot is the Quick slot, not a neighbour\'s',
      inBand(out.quickSlotMs, quickSlot),
      `${out.quickSlotMs}ms vs ${quickSlot.want}ms (band ${Math.round(quickSlot.lo)}-${Math.round(quickSlot.hi)})`
    );
    check('D2 both rounds actually reached an end screen', Boolean(out.chillFinal && out.turboFinal));

    // The reload check below asserts the LAST stored stop, and the Quick timing
    // above moved it, so put Turbo back before reloading.
    await setSpeed(page, 4);

    // --- the stop survives a reload ------------------------------------------
    // A real reload, not a re-goto: the hash is already `#/play/climb/<enc>`, so
    // navigating to the same URL is a same-document no-op and would re-read
    // nothing. The first draft of this file did exactly that and passed on a
    // page that had never re-run.
    await reloadPage(page);
    await page.waitForSelector('input[aria-label="Speed"]', { timeout: 15000 });
    await watchRestarts(page);
    const reloaded = await speedShape(page);
    out.reloaded = reloaded;
    check(
      'E1 the chosen stop survives a reload',
      reloaded && reloaded.value === '4' && reloaded.readout === 'Turbo',
      reloaded && `value=${reloaded.value} readout=${reloaded.readout}`
    );

    // --- a junk stored value must not brick the control -----------------------
    await page.evaluate((k) => localStorage.setItem(k, 'turbo-please'), SPEED_KEY);
    await reloadPage(page);
    await page.waitForSelector('input[aria-label="Speed"]', { timeout: 15000 });
    await watchRestarts(page);
    const junked = await speedShape(page);
    out.junked = junked;
    check(
      'E2 a junk stored value falls back to Quick',
      junked && junked.value === '2' && junked.readout === 'Quick',
      junked && `value=${junked.value} readout=${junked.readout}`
    );
    check('E3 every stop name is one of the five', STOPS.includes(junked && junked.readout));

    // --- Speed and Pace are independent axes ----------------------------------
    const paceState = () =>
      page.evaluate(() => {
        const row = [...document.querySelectorAll('.row')].find((r) =>
          ((r.querySelector('.hint') || {}).textContent || '').includes('How quick are they?')
        );
        const on = row
          ? [...row.querySelectorAll('.segmented button')].find(
              (b) => b.getAttribute('aria-pressed') === 'true'
            )
          : null;
        return on ? on.textContent : null;
      });
    const clickPace = (label) =>
      page.evaluate((want) => {
        const row = [...document.querySelectorAll('.row')].find((r) =>
          ((r.querySelector('.hint') || {}).textContent || '').includes('How quick are they?')
        );
        const btn = row
          ? [...row.querySelectorAll('.segmented button')].find((b) => b.textContent === want)
          : null;
        if (btn) btn.click();
        return Boolean(btn);
      }, label);

    await setSpeed(page, 1);
    await page.waitForTimeout(120);
    await clickPace('Easy');
    await page.waitForTimeout(120);
    out.afterPaceChange = { speed: await speedShape(page), pace: await paceState() };
    check(
      'G1 changing Pace leaves the Speed choice alone',
      out.afterPaceChange.speed &&
        out.afterPaceChange.speed.readout === 'Steady' &&
        out.afterPaceChange.speed.stored === '1' &&
        out.afterPaceChange.pace === 'Easy',
      JSON.stringify({
        readout: out.afterPaceChange.speed && out.afterPaceChange.speed.readout,
        pace: out.afterPaceChange.pace,
      })
    );
    await setSpeed(page, 3);
    await page.waitForTimeout(120);
    out.afterSpeedChange = { speed: await speedShape(page), pace: await paceState() };
    check(
      'G2 changing Speed leaves the Pace choice alone',
      out.afterSpeedChange.speed &&
        out.afterSpeedChange.speed.readout === 'Fast' &&
        out.afterSpeedChange.pace === 'Easy',
      JSON.stringify({
        readout: out.afterSpeedChange.speed && out.afterSpeedChange.speed.readout,
        pace: out.afterSpeedChange.pace,
      })
    );

    // --- H: the same control, driven by a real mouse and a real keyboard -----
    // Everything above moves the slider by dispatching two synthetic events, so
    // everything above would still pass on a handler no human gesture reaches.
    // These checks are the ones that cannot: a drag that comes home, a drag
    // across three stops, and a genuinely held key.
    await setSpeed(page, 0);
    await resetRestarts(page);
    const speedBox = await page.locator('input[aria-label="Speed"]').boundingBox();
    out.speedBox = speedBox;
    // The thumb cannot travel the last half-thumb at either end, so the track is
    // sampled inset. The stops actually reached are read back, never assumed.
    const PAD = 10;
    const xAt = (i) => speedBox.x + PAD + ((speedBox.width - 2 * PAD) * i) / 4;
    const midY = speedBox.y + speedBox.height / 2;
    const valueNow = () =>
      page.evaluate(() => document.querySelector('input[aria-label="Speed"]').value);

    // H0 first: a drag that wanders and comes home. The whole point of the
    // commit path is that this restarts NOTHING, and it is the one branch every
    // other check here is blind to (they all land on a different stop).
    await page.mouse.move(xAt(0), midY);
    await page.mouse.down();
    const roundTrip = [await valueNow()];
    for (const stop of [3, 0]) {
      await page.mouse.move(xAt(stop), midY);
      await page.waitForTimeout(60);
      roundTrip.push(await valueNow());
    }
    await page.mouse.up();
    await page.waitForTimeout(COALESCE_MS + 450);
    const restartsAfterRoundTrip = await restarts(page);
    const roundTripShape = await speedShape(page);
    out.roundTrip = { values: roundTrip, restarts: restartsAfterRoundTrip, shape: roundTripShape };
    check(
      'H0a the round trip really left the starting stop and came back',
      new Set(roundTrip).size >= 2 && roundTrip[roundTrip.length - 1] === roundTrip[0],
      roundTrip.join(' -> ')
    );
    check(
      'H0b a drag that ends on the stop it started from restarts nothing',
      restartsAfterRoundTrip === 0,
      `${restartsAfterRoundTrip} restart(s)`
    );
    // Note for anyone reading this as coverage of the drop-when-equal rule: it
    // is NOT. Chromium does not fire `change` at all when a drag lands back on
    // the value it started from, so nothing is committed and nothing can be
    // dropped. Verified by running this check against a build with the equality
    // guard deleted: it still passed. H6 below is the check that sees the rule.
    check(
      'H0c and the readout still names the stop the round is running',
      roundTripShape && roundTripShape.readout === 'Chill' && roundTripShape.value === '0',
      roundTripShape && `${roundTripShape.readout} / ${roundTripShape.value}`
    );

    await resetRestarts(page);
    await page.mouse.move(xAt(0), midY);
    await page.mouse.down();
    const dragValues = [await valueNow()];
    for (const stop of [1, 2, 3]) {
      await page.mouse.move(xAt(stop), midY);
      await page.waitForTimeout(60);
      dragValues.push(await valueNow());
    }
    // Long past the app's coalescing window, and the button is still down.
    await page.waitForTimeout(COALESCE_MS + 250);
    const restartsDuringDrag = await restarts(page);
    await page.mouse.up();
    await page.waitForTimeout(COALESCE_MS + 450);
    const restartsAfterDrop = await restarts(page);
    out.drag = { dragValues, restartsDuringDrag, restartsAfterDrop };
    check(
      'H1 the drag really crossed three or more stops',
      new Set(dragValues).size >= 3,
      dragValues.join(' -> ')
    );
    check(
      'H2 nothing restarts while the thumb is still held',
      restartsDuringDrag === 0,
      `${restartsDuringDrag} restart(s) mid-drag`
    );
    check(
      'H3 letting go restarts the round exactly once',
      restartsAfterDrop === 1,
      `${restartsAfterDrop} restart(s) after release`
    );

    // Chromium fires input AND change on EVERY value-changing keydown, so a
    // held arrow key is a burst of commits, not one. This is the REAL shape of
    // that gesture: the OS delays the first auto-repeat to about 500 ms, which
    // is longer than any inactivity window, so a timer-only coalescer restarts
    // once mid-hold and again on the next repeat. Three quick `press` calls
    // (9 ms in the round-2 log) could never have caught that.
    await resetRestarts(page);
    await page.focus('input[aria-label="Speed"]');
    const beforeHold = await valueNow();
    const burstAt = Date.now();
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(500);
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(120);
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(120);
    const restartsWhileHeld = await restarts(page);
    const heldValue = await valueNow();
    // The page's own clock, so it is comparable with __lastRestartAt.
    const upAt = await page.evaluate(() => Date.now());
    await page.keyboard.up('ArrowLeft');
    const burstMs = Date.now() - burstAt;
    await page.waitForTimeout(COALESCE_MS + 450);
    const restartsAfterBurst = await restarts(page);
    const lastRestartAt = await page.evaluate(() => window.__lastRestartAt);
    out.keyBurst = {
      burstMs,
      beforeHold,
      heldValue,
      restartsWhileHeld,
      restartsAfterBurst,
      msAfterRelease: lastRestartAt - upAt,
      value: await valueNow(),
    };
    check(
      'H4 a held arrow key moves the slider and restarts nothing while it is down',
      heldValue !== beforeHold && restartsWhileHeld === 0,
      `${beforeHold} -> ${heldValue}; ${restartsWhileHeld} restart(s) during a ${burstMs}ms hold`
    );
    // No burst-duration assertion: that would be a claim about this laptop's
    // speed, not about the app. burstMs is logged as detail only.
    check(
      'H4b letting the key go restarts the round exactly once, after the release',
      restartsAfterBurst === 1 && lastRestartAt >= upAt,
      `${restartsAfterBurst} restart(s); restart ${lastRestartAt - upAt}ms after release`
    );

    await resetRestarts(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(COALESCE_MS + 450);
    const restartsAfterKey = await restarts(page);
    out.oneKey = { restartsAfterKey, value: await valueNow() };
    check(
      'H5 one native ArrowRight restarts the round exactly once',
      restartsAfterKey === 1,
      `${restartsAfterKey} restart(s)`
    );

    // --- H6: the drop-when-equal rule, on the one path that reaches it -------
    // A keyboard nudge away and straight back, WITHOUT releasing in between:
    // ArrowLeft is held, ArrowRight brings the value home, and the release
    // commits a stop the running round already has. The round must survive.
    // This is the check that fails on a build with the equality guard deleted.
    await resetRestarts(page);
    await page.focus('input[aria-label="Speed"]');
    const beforeNudge = await valueNow();
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(120);
    const nudgedTo = await valueNow();
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(120);
    const backTo = await valueNow();
    await page.keyboard.up('ArrowRight');
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(COALESCE_MS + 450);
    const restartsAfterNudge = await restarts(page);
    out.nudge = { beforeNudge, nudgedTo, backTo, restartsAfterNudge };
    check(
      'H6a the nudge really moved the slider and brought it home',
      nudgedTo !== beforeNudge && backTo === beforeNudge,
      `${beforeNudge} -> ${nudgedTo} -> ${backTo}`
    );
    check(
      'H6b committing the stop the round already has restarts nothing',
      restartsAfterNudge === 0,
      `${restartsAfterNudge} restart(s)`
    );

    // --- H7: a modifier tapped mid-hold is not the release ------------------
    // Hold an arrow, press and let go of Shift, and the round the player is in
    // must survive: only the arrow release ends the gesture. A handler that
    // treats ANY keyup as the release restarts here, in the middle of a hold.
    await resetRestarts(page);
    await page.focus('input[aria-label="Speed"]');
    const beforeShift = await valueNow();
    const holdKey = Number(beforeShift) > 0 ? 'ArrowLeft' : 'ArrowRight';
    await page.keyboard.down(holdKey);
    await page.waitForTimeout(120);
    const heldUnderShift = await valueNow();
    await page.keyboard.down('Shift');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(COALESCE_MS + 250);
    const restartsAfterShift = await restarts(page);
    await page.keyboard.up(holdKey);
    await page.waitForTimeout(COALESCE_MS + 450);
    const restartsAfterHoldKey = await restarts(page);
    out.modifier = {
      holdKey,
      beforeShift,
      heldUnderShift,
      restartsAfterShift,
      restartsAfterHoldKey,
    };
    check(
      'H7a tapping Shift mid-hold restarts nothing',
      heldUnderShift !== beforeShift && restartsAfterShift === 0,
      `${beforeShift} -> ${heldUnderShift} on a held ${holdKey}; ${restartsAfterShift} restart(s)`
    );
    check(
      'H7b releasing the held arrow then restarts the round exactly once',
      restartsAfterHoldKey === 1,
      `${restartsAfterHoldKey} restart(s)`
    );

    out.overflow = await overflow(page);
    check(
      'F1 nothing pushes the page sideways',
      out.overflow.scrollW <= out.overflow.clientW + 1,
      `${out.overflow.scrollW} > ${out.overflow.clientW}`
    );

    // --- 390px: the row must wrap, not overflow or squash the slider ---------
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'mobile-390.png'), fullPage: false });
    out.mobile = await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="Speed"]');
      const wrap = input && input.closest('.speed');
      const r = input ? input.getBoundingClientRect() : null;
      const w = wrap ? wrap.getBoundingClientRect() : null;
      return {
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        inputW: r ? Math.round(r.width) : 0,
        inputRight: r ? Math.round(r.right) : 0,
        wrapRight: w ? Math.round(w.right) : 0,
        rowHeight: w ? Math.round(w.height) : 0,
      };
    });
    check(
      'F1a at 390px nothing pushes the page sideways',
      out.mobile.scrollW <= out.mobile.clientW + 1,
      `${out.mobile.scrollW} > ${out.mobile.clientW}`
    );
    check(
      'F1b at 390px the whole Speed control fits inside the viewport',
      out.mobile.wrapRight <= out.mobile.clientW + 1 &&
        out.mobile.inputRight <= out.mobile.clientW + 1,
      JSON.stringify(out.mobile)
    );
    check(
      'F1c at 390px the slider is still a usable width',
      out.mobile.inputW >= 80,
      `${out.mobile.inputW}px wide`
    );
    await page.setViewportSize({ width: 1280, height: 900 });

    // The last page has not been navigated away from, so its counters have not
    // been folded in yet.
    await harvest(page, 'end of run');
    out.audit = audit;
    // Order matters: the integrity check comes FIRST, because a zero from a
    // ledger that failed to record is not evidence of silence.
    check(
      'F2 every page in the run was actually counted',
      audit.failures.length === 0 && audit.pages >= 3,
      `${audit.pages} page(s) counted; ${audit.failures.join('; ') || 'no failures'}`
    );
    check('F3 nothing spoke, across the whole run', audit.spoke === 0, `spoke ${audit.spoke} time(s)`);
    check(
      'F4 nothing opened an AudioContext, across the whole run',
      audit.audioCtx === 0,
      `${audit.audioCtx} context(s)`
    );
    check('F5 no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    problems.push(`threw: ${String(e).slice(0, 300)}`);
    try {
      await page.screenshot({ path: path.join(SHOTS, 'FAIL.png') });
    } catch {
      /* the page may already be gone */
    }
  }

  await ctx.close();
  await browser.close();

  L('');
  L(JSON.stringify(out, null, 2));
  L('');
  L(`Chill round: ${out.chillMs} ms (slot ${out.chillSlotMs} ms)    Turbo round: ${out.turboMs} ms (slot ${out.turboSlotMs} ms)`);
  L(`whole verifier: ${Date.now() - runStartedAt} ms`);
  L(problems.length === 0 ? '\nCLIMB SPEED GATE: PASS' : `\nCLIMB SPEED GATE: FAIL\n- ${problems.join('\n- ')}`);
  process.exit(problems.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

