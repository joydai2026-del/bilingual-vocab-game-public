// The live-surface gate for Tone Catcher.
//
// It pastes a real word list on the home page, opens the game the way a child
// would, plays a WHOLE round by DOM, and only then asserts. A green build and a
// canvas element prove nothing: a blank canvas passes both, and a game that
// never reaches its end screen still renders beautifully.
//
// Silence: `?silent=1`, plus an init script that stubs speechSynthesis (and
// COUNTS the calls, so the zero is evidence and not decoration), media
// playback, and AudioContext. Chromium is launched with `--mute-audio` on top.
// Nothing here is allowed to make a sound on this machine.
//
// Run:
//   npm run cf:dev -- --port 8811        # in another shell
//   NODE_PATH=/path/to/node_modules \
//     BVG_BASE=http://localhost:8811 BVG_SHOTS=<dir> node tests/e2e/verify-tone-catcher.cjs
//
// Env: BVG_BASE (default http://localhost:8811), BVG_CHROME, BVG_SHOTS.

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

const BASE = process.env.BVG_BASE || 'http://localhost:8811';
const SHOTS = process.env.BVG_SHOTS || path.join(__dirname, '..', '..', 'scratch', 'tone');
const WORDS = '妈 麻 马 骂 苹果 香蕉 葡萄 西瓜';

/** Software GL plus a hard mute: a headless machine has no GPU and no ears. */
const GL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--mute-audio',
];

const L = (s) => console.log(s);

/**
 * The whole-run silence counters, kept TWICE on purpose.
 *
 * `window.__spoke` only covers the current document, so the Node side banks it
 * before every reload and adds the live document's at the end. sessionStorage
 * is the independent cross-check. Neither one is allowed to fail quietly: a
 * browser that cannot write sessionStorage used to make the whole silence
 * assertion vacuous, so a storage error is now counted and FAILS the case.
 */
function newTally() {
  return { spoke: 0, audioCtx: 0, storeFail: 0, installed: true };
}

/**
 * What the CURRENT document has seen. Reset by the init script on navigation.
 *
 * `installed` is the difference between "nothing spoke" and "nothing was ever
 * counted": an init script that did not run leaves the counters undefined, and
 * `Number(undefined || 0)` is the same 0 a genuinely quiet run reports.
 */
async function windowCounters(page) {
  return page.evaluate(() => ({
    spoke: Number(window.__spoke || 0),
    audioCtx: Number(window.__audioCtx || 0),
    storeFail: Number(window.__storeFail || 0),
    installed:
      typeof window.__spoke === 'number' &&
      typeof window.__audioCtx === 'number' &&
      typeof window.__storeFail === 'number',
  }));
}

/** Bank the current document's counters into the Node total before a reload. */
async function bank(page, tally) {
  const w = await windowCounters(page);
  tally.spoke += w.spoke;
  tally.audioCtx += w.audioCtx;
  tally.storeFail += w.storeFail;
  tally.installed = tally.installed && w.installed;
}

/**
 * The positive control. Speaks once and opens one AudioContext ON PURPOSE from
 * the harness, requires both counters to read exactly 1, then puts them back to
 * zero (sessionStorage included, since that is the cross-check).
 *
 * Under `?silent=1` the app's own `speak()` returns before it ever reaches
 * `speechSynthesis`, so "spoke 0" on its own proves nothing about the stub. The
 * counters exist to catch anything that BYPASSES silent mode, and this is what
 * makes that assertion non-vacuous. Nothing is audible: the stub is still a
 * stub, it just counts.
 */
async function positiveControl(page) {
  return page.evaluate(() => {
    try {
      if (typeof window.__spoke !== 'number' || typeof window.__audioCtx !== 'number') {
        return { ok: false, why: 'the silence counters were never installed' };
      }
      window.speechSynthesis.speak(new SpeechSynthesisUtterance('x'));
      new AudioContext();
      const got = { spoke: window.__spoke, audioCtx: window.__audioCtx };
      window.__spoke = 0;
      window.__audioCtx = 0;
      try {
        sessionStorage.setItem('bvg.spoke', '0');
        sessionStorage.setItem('bvg.audioctx', '0');
      } catch {
        return { ok: false, why: 'the sessionStorage cross-check could not be reset' };
      }
      return { ok: got.spoke === 1 && got.audioCtx === 1, why: JSON.stringify(got) };
    } catch (e) {
      return { ok: false, why: String(e).slice(0, 90) };
    }
  });
}

/** The Node total plus the live document, and the sessionStorage cross-check. */
async function counters(page, tally) {
  const w = await windowCounters(page);
  const store = await page.evaluate(() => {
    try {
      return {
        ok: true,
        spoke: Number(sessionStorage.getItem('bvg.spoke') || 0),
        audioCtx: Number(sessionStorage.getItem('bvg.audioctx') || 0),
      };
    } catch {
      return { ok: false, spoke: null, audioCtx: null };
    }
  });
  return {
    spoke: tally.spoke + w.spoke,
    audioCtx: tally.audioCtx + w.audioCtx,
    storeFail: tally.storeFail + w.storeFail + (store.ok ? 0 : 1),
    storeSpoke: store.spoke,
    storeAudioCtx: store.audioCtx,
    installed: tally.installed && w.installed,
  };
}

async function silence(ctx) {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('vocab-silent', '1');
    } catch {
      /* private mode */
    }
    // The init script re-runs on every navigation, so window counters reset on
    // page.reload() and the pre-reload half of the run would go unwatched. The
    // running totals live in sessionStorage, which survives the reload.
    const bump = (key) => {
      try {
        sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
      } catch {
        // A swallowed storage error used to make the "spoke 0" assertion pass
        // on a browser that could not count at all. Count the failure instead;
        // the Node side turns it into a red case.
        window.__storeFail += 1;
      }
    };
    window.__spoke = 0;
    window.__audioCtx = 0;
    window.__storeFail = 0;
    if (window.speechSynthesis) {
      // Counting, not just swallowing: a silent stub that never increments
      // makes the "spoke 0" assertion vacuous.
      window.speechSynthesis.speak = () => {
        window.__spoke += 1;
        bump('bvg.spoke');
      };
      window.speechSynthesis.cancel = () => {};
      window.speechSynthesis.getVoices = () => [];
    }
    HTMLMediaElement.prototype.play = function () {
      return Promise.resolve();
    };
    // The app's win chime is WebAudio, not speech. Nothing on this page is
    // allowed to open an output node either.
    const Dead = function () {
      window.__audioCtx += 1;
      bump('bvg.audioctx');
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

/** Types the word list into the home page's one box and presses Make games. */
async function makeSet(page) {
  await page.goto(`${BASE}/?silent=1&probe=1#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#paste', { timeout: 15000 });
  await page.fill('#paste', WORDS);
  await page.getByRole('button', { name: 'Make games', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/set/'), null, {
    timeout: 20000,
    polling: 100,
  });
  return page.evaluate(() => location.hash.replace('#/set/', ''));
}

/**
 * Plays one whole round through the DOM: waits for each gate, reads which lane
 * is right from the `?probe=1` hook, clicks that lane's button, and moves on.
 * Clicking is the real user path, so this exercises the hit areas too.
 */
async function playRound(page, { missEvery = 4 } = {}) {
  const seen = new Set();
  const log = [];
  const deadline = Date.now() + 120000;

  while (Date.now() < deadline) {
    const over = await page.evaluate(() => {
      const probe = window.__tone;
      return probe ? probe.phase() === 'over' : false;
    });
    if (over) break;

    const gate = await page.evaluate(() => {
      const probe = window.__tone;
      if (!probe) return null;
      const q = probe.question();
      const s = probe.state();
      return q && probe.phase() === 'run'
        ? { gate: s.gate, correct: q.correct, lane: s.lane, zh: q.zh, gates: s.gates }
        : null;
    });

    if (!gate || seen.has(gate.gate)) {
      await page.waitForTimeout(80);
      continue;
    }
    seen.add(gate.gate);

    // Miss on purpose once in a while, so the stumble, the slow and the green
    // light on the correct lane are all exercised rather than assumed.
    const deliberateMiss = seen.size % missEvery === 0;
    const want = deliberateMiss ? (gate.correct + 1) % 3 : gate.correct;
    await page.locator('.tc-lane').nth(want).click({ force: true, timeout: 5000 });

    // The click AFTER a deliberate miss lands inside the stumble freeze and is
    // swallowed on purpose. Retry until it lands or the gate resolves, and
    // record which: a freeze that outlasts the gate is a real bug, and without
    // this check it hides behind a round that still reaches its end screen.
    let landed = false;
    const stop = Date.now() + 12000;
    while (Date.now() < stop) {
      const now = await page.evaluate(() => {
        const probe = window.__tone;
        const s = probe ? probe.state() : null;
        return s ? { gate: s.gate, lane: s.lane, done: s.done } : null;
      });
      if (!now) break;
      if (now.lane === want) {
        landed = true;
        break;
      }
      if (now.gate !== gate.gate || now.done) break;
      await page.locator('.tc-lane').nth(want).click({ force: true, timeout: 5000 });
      await page.waitForTimeout(60);
    }
    log.push({ gate: gate.gate, zh: gate.zh, picked: want, correct: gate.correct, landed });
  }

  return log;
}

/**
 * The window the game actually accepts steering in: a live gate, no stumble
 * freeze, and the round not over. `moveTo` (src/client/games/tone-catcher.ts)
 * drops a click outside it ON PURPOSE, which is the only thing a retry is for.
 * `slowUntil` is stamped on the page's own `performance.now()` clock, so the
 * comparison has to happen in the page.
 */
async function steerState(page) {
  return page.evaluate(() => {
    const probe = window.__tone;
    const s = probe ? probe.state() : null;
    if (!s) return null;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      lane: s.lane,
      gate: s.gate,
      done: s.done,
      phase: probe.phase(),
      slowUntil: s.slowUntil,
      steerable: probe.phase() === 'run' && !s.done && now >= s.slowUntil,
    };
  });
}

/** Waits for that window and hands back the state read inside it. */
async function waitSteerable(page, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const probe = window.__tone;
      const s = probe ? probe.state() : null;
      if (!s || s.done || probe.phase() !== 'run') return false;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return now >= s.slowUntil;
    },
    null,
    { timeout }
  );
  return steerState(page);
}

/**
 * Clicks one lane the bean is NOT on, and proves the CLICK is what moved it.
 *
 * The old loop retried any click that did not land, so a click dropped during
 * ordinary live play looked exactly like one the game swallowed on purpose:
 * the second click landed and the run went green. Now the state is read in the
 * steerable window immediately before the click, and a lane that did not change
 * is a failure unless the state can show the window closed underneath it (a new
 * gate, a fresh stumble freeze, or the phase leaving `run`).
 */
async function stepTo(page, want) {
  const deadline = Date.now() + 20000;
  let why = 'never found a steerable gate';
  while (Date.now() < deadline) {
    const before = await waitSteerable(page);
    if (!before) throw new Error('steerTo: the game exposed no state');
    if (before.lane === want) {
      throw new Error(`steerTo: asked to click lane ${want}, the bean is already there`);
    }
    await page.locator('.tc-lane').nth(want).click({ force: true, timeout: 5000 });
    await page.waitForTimeout(90);
    const after = await steerState(page);
    if (!after) throw new Error('steerTo: the game stopped exposing state mid-click');
    if (after.lane === want) return { lane: after.lane, from: before.lane };
    const turned = after.gate !== before.gate || after.done || after.phase !== 'run';
    const froze = after.slowUntil > before.slowUntil;
    if (!turned && !froze) {
      throw new Error(
        `steerTo: the click on lane ${want} was dropped during live play ` +
          `(gate ${before.gate}, lane still ${after.lane})`
      );
    }
    why = turned ? 'the gate turned over mid-click' : 'a stumble freeze swallowed it';
  }
  throw new Error(`steerTo: could not steer to lane ${want} in 20s (${why})`);
}

/**
 * Puts the runner on `want`. If the bean already sits there it is moved OFF
 * first, so the last step is always a real lane CHANGE and the return value is
 * evidence of steering rather than of where the bean happened to be.
 */
async function steerTo(page, want, lanes = 3) {
  const here = await waitSteerable(page);
  if (here && here.lane === want) await stepTo(page, (want + 1) % lanes);
  const moved = await stepTo(page, want);
  if (moved.from === moved.lane) throw new Error(`steerTo: lane ${moved.lane} did not change`);
  return moved.lane;
}

/** How long the app is allowed to coalesce a burst of dial commits. */
const COALESCE_MS = 250;

/** Rounds started so far, from the game's own counter. -1 if it is missing. */
const begins = (page) =>
  page.evaluate(() => {
    const probe = window.__tone;
    return probe && probe.begins ? probe.begins() : -1;
  });

/** Everything about the dial a player would notice. */
async function speedShape(page) {
  return page.evaluate(() => {
    const probe = window.__tone;
    const el = document.querySelector('.tc-speed-range');
    const out = document.querySelector('.tc-speed-name');
    const s = probe ? probe.state() : null;
    return {
      value: el ? el.value : null,
      valuetext: el ? el.getAttribute('aria-valuetext') : null,
      ariaLabel: el ? el.getAttribute('aria-label') : null,
      readout: out ? (out.textContent || '').trim() : null,
      gate: s ? s.gate : null,
      lane: s ? s.lane : null,
      decided: s ? s.decidedAt !== null : null,
      speed: probe && probe.speed ? probe.speed() : null,
      gateMs: probe && probe.gateMs ? probe.gateMs() : null,
      hint: (document.querySelector('.tc-hint') || {}).textContent || '',
    };
  });
}

/**
 * Moves the Speed dial the way the contract says the harness must: set the
 * value, then fire both `input` and `change`. The restart a commit arms is
 * COALESCED, so the `after` read waits for the round to actually turn over
 * instead of racing it, and the caller can assert on a real change rather than
 * on the fact that nothing threw.
 */
async function moveSpeed(page, index) {
  const there = await page.evaluate(() => Boolean(document.querySelector('.tc-speed-range')));
  if (!there) return { missing: true };
  const before = await speedShape(page);
  const rounds = await begins(page);
  await page.evaluate((i) => {
    const el = document.querySelector('.tc-speed-range');
    el.value = String(i);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, index);
  if (before.speed === index) await page.waitForTimeout(COALESCE_MS + 200);
  else {
    await page.waitForFunction((n) => window.__tone.begins() > n, rounds, { timeout: 10000 });
  }
  return { before, after: await speedShape(page) };
}

/**
 * The same dial, driven by a real mouse and a real keyboard. Everything else
 * here moves it by dispatching two synthetic events, so everything else would
 * still pass on a handler no human gesture reaches: a drag that restarts the
 * round at every stop it crosses, or a held arrow key that restarts it once per
 * repeat. Leaves the dial back on Turbo so the persistence check still holds.
 */
async function speedGestures(page) {
  const out = { beginsProbe: (await begins(page)) >= 0 };
  const valueNow = () => page.evaluate(() => document.querySelector('.tc-speed-range').value);

  // From Chill, so the drag has the whole track to cross.
  await moveSpeed(page, 0);
  const box = await page.locator('.tc-speed-range').boundingBox();
  out.box = box;
  // The thumb cannot travel the last half-thumb at either end, so the track is
  // sampled inset. The stops actually reached are read back, never assumed.
  const PAD = 8;
  const xAt = (i) => box.x + PAD + ((box.width - 2 * PAD) * i) / 4;
  const midY = box.y + box.height / 2;

  // A drag across three or more stops: nothing may restart while the thumb is
  // down, and letting go restarts exactly once.
  let from = await begins(page);
  await page.mouse.move(xAt(0), midY);
  await page.mouse.down();
  const values = [await valueNow()];
  for (const stop of [1, 2, 3]) {
    await page.mouse.move(xAt(stop), midY);
    await page.waitForTimeout(60);
    values.push(await valueNow());
  }
  // Long past the app's coalescing window, and the button is still down.
  await page.waitForTimeout(COALESCE_MS + 250);
  const duringDrag = (await begins(page)) - from;
  await page.mouse.up();
  await page.waitForTimeout(COALESCE_MS + 450);
  out.drag = { values, duringDrag, afterDrop: (await begins(page)) - from };

  // Chromium fires input AND change on EVERY value-changing keydown, so a held
  // arrow key is a burst of commits, not one. The OS delays the first repeat to
  // about 500 ms, which is longer than any inactivity window, so a timer-only
  // coalescer restarts once mid-hold and again on the next repeat.
  from = await begins(page);
  await page.focus('.tc-speed-range');
  const beforeHold = await valueNow();
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(500);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(120);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(120);
  const whileHeld = (await begins(page)) - from;
  const heldValue = await valueNow();
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(COALESCE_MS + 450);
  out.held = { beforeHold, heldValue, whileHeld, afterRelease: (await begins(page)) - from };

  // A nudge away and straight back WITHOUT releasing: the release commits a
  // stop the running round already has, and the round must survive it. This is
  // the check that fails on a build with the equality guard deleted.
  from = await begins(page);
  await page.focus('.tc-speed-range');
  const beforeNudge = await valueNow();
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(120);
  const nudgedTo = await valueNow();
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(120);
  const backTo = await valueNow();
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(COALESCE_MS + 450);
  out.nudge = { beforeNudge, nudgedTo, backTo, restarts: (await begins(page)) - from };

  // A modifier tapped mid-hold is not the release. Hold ArrowLeft, press and
  // let go of Shift, and the round the player is in must survive: only the
  // ArrowLeft release ends the gesture. A handler that treats ANY keyup as the
  // release restarts here, and on this game it also blurs the dial, so every
  // later repeat of the held arrow steers the runner instead.
  await moveSpeed(page, 3);
  from = await begins(page);
  await page.focus('.tc-speed-range');
  const beforeShift = await valueNow();
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(120);
  const heldUnderShift = await valueNow();
  await page.keyboard.down('Shift');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(COALESCE_MS + 250);
  const afterShift = (await begins(page)) - from;
  const stillOnDial = await page.evaluate(
    () => document.activeElement === document.querySelector('.tc-speed-range')
  );
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(COALESCE_MS + 450);
  out.modifier = {
    beforeShift,
    heldUnderShift,
    afterShift,
    stillOnDial,
    afterArrow: (await begins(page)) - from,
  };

  await moveSpeed(page, 4);
  out.restored = await valueNow();
  return out;
}

/**
 * The arrow keys steer the runner, so the game listens on `window`. This proves
 * the listener lets go once the dial has focus: ArrowLeft must move the SLIDER
 * and ArrowRight at the top stop must move nothing at all, least of all the
 * bean. Leaves the dial back on Turbo so the persistence check still holds.
 */
async function keyboardOnTheDial(page) {
  const lane = () =>
    page.evaluate(() => {
      const probe = window.__tone;
      const s = probe ? probe.state() : null;
      return s ? s.lane : null;
    });
  const value = () => page.evaluate(() => document.querySelector('.tc-speed-range').value);

  // Off the middle lane, so a bean that gets steered is visible in the numbers.
  const laneBefore = await steerTo(page, 0);
  await page.focus('.tc-speed-range');

  // At the top stop ArrowRight has nothing to do: the dial stays, and the lane
  // must stay with it.
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(120);
  const afterRight = { value: await value(), lane: await lane() };

  // One stop down proves the key really reaches the input.
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  const afterLeft = {
    value: await value(),
    readout: await page.evaluate(
      () => (document.querySelector('.tc-speed-name').textContent || '').trim()
    ),
  };

  // The dial restarted the round, so it must also have LET GO. Without the
  // blur the next arrow key goes back into the slider and a keyboard player
  // can never steer the runner again. The round restarted on lane 1, so a
  // single ArrowRight has to land the bean on lane 2.
  //
  // The press waits for the same steerable window the clicks use. Pressing on a
  // gate that was about to turn over made this assertion flake a few percent of
  // runs; a press that misses is re-pressed only when the state can SHOW the
  // window closed, never just because the lane did not move.
  let steered = null;
  for (let tries = 0; tries < 3; tries += 1) {
    const before = await waitSteerable(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const after = await steerState(page);
    steered = {
      focused: await page.evaluate(
        () => document.activeElement === document.querySelector('.tc-speed-range')
      ),
      laneBefore: before ? before.lane : null,
      lane: after ? after.lane : null,
      value: await value(),
    };
    if (!before || !after || after.lane !== before.lane) break;
    const closed =
      after.gate !== before.gate ||
      after.done ||
      after.phase !== 'run' ||
      after.slowUntil > before.slowUntil;
    if (!closed) break; // the press was dropped in live play: let it go red
  }

  await moveSpeed(page, 4);
  await page.waitForTimeout(120);
  return { laneBefore, afterRight, afterLeft, steered, restored: await value() };
}

/** What the dial looks like on a fresh load: the persistence check reads it. */
async function readSpeedControl(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.tc-speed-range');
    const out = document.querySelector('.tc-speed-name');
    return el
      ? {
          type: el.type,
          min: el.getAttribute('min'),
          max: el.getAttribute('max'),
          step: el.getAttribute('step'),
          value: el.value,
          ariaLabel: el.getAttribute('aria-label'),
          valuetext: el.getAttribute('aria-valuetext'),
          readout: out ? (out.textContent || '').trim() : null,
          stored: (() => {
            try {
              return localStorage.getItem('bvg.speed.tone.v1');
            } catch {
              return null;
            }
          })(),
        }
      : null;
  });
}

/**
 * Plays one whole round at `stop` and times it on the harness's own clock.
 * Moving the dial is what starts the round, on a live track or on the end
 * screen alike, so the clock starts the moment the slider moves.
 */
async function timeRoundAt(page, stop) {
  await page.waitForFunction(
    () => {
      const probe = window.__tone;
      return probe && (probe.phase() === 'run' || probe.phase() === 'over');
    },
    null,
    { timeout: 20000 }
  );
  const moved = await moveSpeed(page, stop);
  const t0 = Date.now();
  await playRound(page);
  await page.waitForSelector('.tc-final .final', { timeout: 90000 });
  return { stop, ms: Date.now() - t0, moved };
}

async function readPixels(page, want) {
  return page.evaluate((n) => {
    if (!document.querySelector('canvas')) return { ok: false, why: 'no canvas element' };
    const probe = window.__tone;
    if (!probe) return { ok: false, why: '__tone hook missing' };
    const out = probe.pixels(n);
    if (!out || !out.lum || !out.lum.length) return { ok: false, why: 'no pixels came back' };
    const lum = out.lum;
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const variance = lum.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lum.length;
    return { ok: true, sampled: lum.length, mean, variance, drawn: out.drawn, w: out.w, h: out.h };
  }, want);
}

/** Nothing on the page may push the document sideways. */
async function overflow(page) {
  return page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
}

const CASES = [
  { name: '3d-hard-1280x800', size: { width: 1280, height: 800 }, flat: false, mode: 'Hard', play: true },
  { name: 'flat-normal-1280x800', size: { width: 1280, height: 800 }, flat: true, mode: null, play: true },
  { name: '3d-normal-390x844', size: { width: 390, height: 844 }, flat: false, mode: null, play: true, speed: true },
  { name: '3d-easy-820x1180', size: { width: 820, height: 1180 }, flat: false, mode: 'Easy', play: false },
  { name: '3d-hard-1440x900', size: { width: 1440, height: 900 }, flat: false, mode: 'Hard', play: false },
];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  L(`base    ${BASE}`);
  L(`chrome  ${EXE}`);
  L(`shots   ${SHOTS}`);
  L('');

  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: GL_ARGS });
  const results = [];
  let bad = 0;

  for (const c of CASES) {
    const ctx = await browser.newContext({ viewport: c.size, deviceScaleFactor: 1 });
    await silence(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    const row = { case: c.name, problems: [] };
    const tally = newTally();
    try {
      const enc = await makeSet(page);
      // A fresh navigation resets the window counters: bank them first.
      await bank(page, tally);
      const q = c.flat ? '?silent=1&probe=1&flat=1' : '?silent=1&probe=1';
      await page.goto(`${BASE}/${q}#/play/tone/${enc}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.tc-lane', { timeout: 15000 });
      await page.waitForFunction(() => Boolean(window.__tone), null, { timeout: 15000 });
      // Prove the stubs and the counters are wired BEFORE trusting a zero.
      row.control = await positiveControl(page);

      if (c.mode) {
        await page.getByRole('button', { name: c.mode, exact: true }).click();
        await page.waitForTimeout(300);
      }

      row.title = (await page.textContent('.screen-head h1').catch(() => '')) || '';
      row.flatBean = await page.$$eval('.tc-flat-bean', (n) => n.length);
      row.hasCanvas = await page.$$eval('canvas', (n) => n.length);

      // Mid-round evidence: one gate in flight, labels on screen.
      await page.waitForFunction(
        () => {
          const probe = window.__tone;
          return probe && probe.phase() === 'run' && document.querySelectorAll('.tc-gate-label').length === 3;
        },
        null,
        { timeout: 15000 }
      );
      await page.waitForTimeout(900);

      // A page that lands scrolled away from its own game is a real bug, so it
      // is measured before the screenshot rather than papered over by one.
      row.scrollY = await page.evaluate(() => window.scrollY);
      row.docH = await page.evaluate(() => document.documentElement.scrollHeight);
      row.gateLabels = await page.$$eval('.tc-gate-label', (n) =>
        n.map((e) => (e.textContent || '').trim())
      );
      row.contours = await page.$$eval('.tc-contour svg', (n) => n.length);
      row.pixels = c.flat ? null : await readPixels(page, 240);
      row.overflow = await overflow(page);

      const mid = path.join(SHOTS, `${c.name}-mid.png`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: mid });
      row.shotMid = mid;

      // The Speed dial, on the narrowest viewport we ship to: move it, prove
      // the round really restarted underneath it, and prove the stop survives
      // a reload. Done before the round is played so the restart is visible.
      if (c.speed) {
        row.speedBefore = await readSpeedControl(page);
        // Steer off the middle lane first: a restart puts the bean back on
        // lane 1 with nothing decided, which is what makes the restart legible.
        row.laneBeforeMove = await steerTo(page, 0);
        row.speedMove = await moveSpeed(page, 4);
        await page.waitForTimeout(200);
        const shot = path.join(SHOTS, `${c.name}-speed.png`);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: shot });
        row.shotSpeed = shot;
        row.overflowSpeed = await overflow(page);
        row.speedKeys = await keyboardOnTheDial(page);
        row.speedGestures = await speedGestures(page);

        // The reload wipes the window counters, so bank them first.
        await bank(page, tally);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.tc-lane', { timeout: 15000 });
        await page.waitForFunction(() => Boolean(window.__tone), null, { timeout: 15000 });
        row.speedAfterReload = await readSpeedControl(page);
        await page.waitForFunction(
          () => {
            const probe = window.__tone;
            return probe && probe.phase() === 'run';
          },
          null,
          { timeout: 15000 }
        );
      }

      if (c.play) {
        row.picks = await playRound(page);
        await page.waitForSelector('.tc-final .final', { timeout: 30000 });
        row.finalText = (await page.textContent('.tc-final')).replace(/\s+/g, ' ').trim();
        row.state = await page.evaluate(() => {
          const probe = window.__tone;
          return probe ? probe.state() : null;
        });
        const end = path.join(SHOTS, `${c.name}-end.png`);
        await page.screenshot({ path: end });
        row.shotEnd = end;
      }

      const heard = await counters(page, tally);
      row.spoke = heard.spoke;
      row.audioCtx = heard.audioCtx;
      row.storeFail = heard.storeFail;
      row.storeSpoke = heard.storeSpoke;
      row.storeAudioCtx = heard.storeAudioCtx;
      row.installed = heard.installed;
      row.errors = errors;
    } catch (e) {
      row.problems.push(`threw: ${String(e).slice(0, 240)}`);
      // A case that threw still has to account for the noise it made, and a
      // case that cannot read its counters at all is not a quiet case.
      try {
        const heard = await counters(page, tally);
        row.spoke = heard.spoke;
        row.audioCtx = heard.audioCtx;
        row.storeFail = heard.storeFail;
        row.storeSpoke = heard.storeSpoke;
        row.storeAudioCtx = heard.storeAudioCtx;
        row.installed = heard.installed;
      } catch {
        row.spoke = 0;
        row.audioCtx = 0;
        row.storeFail = 1;
        row.storeSpoke = 0;
        row.storeAudioCtx = 0;
        row.installed = false;
      }
      row.errors = errors;
      try {
        const shot = path.join(SHOTS, `${c.name}-FAIL.png`);
        await page.screenshot({ path: shot });
        row.shotFail = shot;
      } catch {
        /* the page may already be gone */
      }
    }

    // --- the assertions ------------------------------------------------------
    const p = row.problems;
    if (!String(row.title).includes('Tone Catcher')) p.push('not on the Tone Catcher page');
    if ((row.errors || []).length) p.push(`console errors: ${row.errors.slice(0, 3).join(' | ')}`);
    // A zero is only evidence once the counter has been shown to count.
    if (!row.control || !row.control.ok) {
      p.push(`the silence positive control failed: ${(row.control && row.control.why) || 'never ran'}`);
    }
    if (row.installed === false) p.push('the silence counters were never installed: silence unproven');
    if (row.spoke !== 0) p.push(`something spoke ${row.spoke} time(s)`);
    if (row.audioCtx !== 0) p.push(`something opened ${row.audioCtx} AudioContext(s)`);
    // The silence counters have to have WORKED. A run that could not count is
    // not a quiet run, it is an unproven one.
    if (row.storeFail) p.push(`the silence counters failed ${row.storeFail} time(s): silence unproven`);
    if (row.storeSpoke !== 0 || row.storeAudioCtx !== 0) {
      p.push(`sessionStorage disagrees: spoke ${row.storeSpoke}, audioCtx ${row.storeAudioCtx}`);
    }
    if ((row.gateLabels || []).length !== 3) p.push(`saw ${(row.gateLabels || []).length} gate labels, wanted 3`);
    if ((row.gateLabels || []).some((t) => !t)) p.push('a gate label was empty');
    if (c.mode === 'Hard' && !(row.contours > 0)) p.push('Hard mode drew no tone contours');
    if (c.mode !== 'Hard' && row.contours) p.push(`${row.contours} contours outside Hard mode`);
    if (row.scrollY > 4) p.push(`the page landed scrolled down ${row.scrollY}px`);
    if (row.overflow && row.overflow.scrollW > row.overflow.clientW + 1) {
      p.push(`horizontal scroll: ${row.overflow.scrollW} > ${row.overflow.clientW}`);
    }
    if (c.flat) {
      if (row.hasCanvas) p.push('flat twin still made a canvas');
      if (row.flatBean !== 1) p.push(`flat twin drew ${row.flatBean} beans, wanted 1`);
    } else {
      if (!row.hasCanvas) p.push('3D mode drew no canvas');
      const px = row.pixels;
      if (!px || !px.ok) p.push(`canvas unreadable: ${px && px.why}`);
      else {
        if (px.sampled < 200) p.push(`only ${px.sampled} pixels sampled, wanted 200+`);
        if (!(px.variance > 1)) p.push(`blank canvas: variance ${px.variance}`);
        if (px.drawn < px.sampled * 0.05) p.push(`almost nothing drawn: ${px.drawn}`);
      }
    }
    if (c.speed) {
      const s0 = row.speedBefore;
      const mv = row.speedMove;
      const s1 = row.speedAfterReload;
      if (!s0) p.push('no Speed slider on the page');
      else {
        if (s0.type !== 'range') p.push(`Speed control is a ${s0.type}, wanted a range`);
        if (s0.min !== '0' || s0.max !== '4' || s0.step !== '1') {
          p.push(`Speed range is ${s0.min}..${s0.max} step ${s0.step}, wanted 0..4 step 1`);
        }
        if (s0.ariaLabel !== 'Speed') p.push(`Speed aria-label is "${s0.ariaLabel}"`);
        if (s0.value !== '2' || s0.readout !== 'Quick') {
          p.push(`Speed did not default to Quick: value ${s0.value}, readout ${s0.readout}`);
        }
        if (s0.valuetext !== 'Quick, 2 times speed') p.push(`aria-valuetext is "${s0.valuetext}", wanted "Quick, 2 times speed"`);
      }
      // Recorded and, until now, never checked: a total steering failure here
      // used to be a silent pause and a screenshot of a bean that never moved.
      if (row.laneBeforeMove !== 0) {
        p.push(`could not steer the bean off the middle lane before the move: ${row.laneBeforeMove}`);
      }
      if (!mv || mv.missing) p.push('the Speed slider could not be moved');
      else {
        if (!mv.before.decided) p.push('the lane click before the move did not register');
        if (mv.after.readout !== 'Turbo') p.push(`readout is "${mv.after.readout}", wanted Turbo`);
        if (mv.after.readout === mv.before.readout) p.push('the readout did not change');
        if (mv.after.valuetext !== 'Turbo, 3 times speed') p.push(`aria-valuetext stayed "${mv.after.valuetext}"`);
        if (mv.after.gate !== 0 || mv.after.lane !== 1 || mv.after.decided !== false) {
          p.push('moving the slider did not restart the round');
        }
        if (!(mv.after.gateMs < mv.before.gateMs)) {
          p.push(`gate time did not shorten: ${mv.before.gateMs} to ${mv.after.gateMs}`);
        }
        if (!/1\.3 seconds each/.test(mv.after.hint)) p.push(`hint reads "${mv.after.hint}"`);
      }
      if (!s1) p.push('the Speed slider was gone after the reload');
      else if (s1.value !== '4' || s1.readout !== 'Turbo' || s1.stored !== '4') {
        p.push(`the stop did not persist: value ${s1.value}, stored ${s1.stored}`);
      }
      if (row.overflowSpeed && row.overflowSpeed.scrollW > row.overflowSpeed.clientW + 1) {
        p.push(`the slider pushed the page sideways: ${row.overflowSpeed.scrollW}`);
      }
      const k = row.speedKeys;
      if (!k) p.push('the keyboard never reached the Speed dial');
      else {
        if (k.laneBefore !== 0) p.push(`could not get the bean off the middle lane: ${k.laneBefore}`);
        if (k.afterRight.lane !== k.laneBefore) {
          p.push(`ArrowRight on the focused dial steered the runner to lane ${k.afterRight.lane}`);
        }
        if (k.afterRight.value !== '4') p.push(`ArrowRight past the top stop moved it to ${k.afterRight.value}`);
        if (k.afterLeft.value !== '3' || k.afterLeft.readout !== 'Fast') {
          p.push(`ArrowLeft did not move the dial: value ${k.afterLeft.value}, readout ${k.afterLeft.readout}`);
        }
        if (k.restored !== '4') p.push(`the dial was left on ${k.restored}, not Turbo`);
        const st = k.steered;
        if (!st) p.push('the post-restart steer never ran');
        else {
          if (st.focused) p.push('the dial kept focus after restarting the round');
          if (st.lane === st.laneBefore) {
            p.push(`ArrowRight after a speed change did not steer: lane stayed ${st.lane}`);
          }
          if (st.value !== '3') p.push(`ArrowRight went back into the dial: value ${st.value}`);
        }
      }
      const g = row.speedGestures;
      if (!g) p.push('the real-gesture checks never ran');
      else if (!g.beginsProbe) p.push('the round counter is missing from the probe: restarts uncountable');
      else if (!g.box) p.push('the Speed dial had no box to drag');
      else {
        if (new Set(g.drag.values).size < 3) {
          p.push(`the drag crossed too few stops: ${g.drag.values.join(' -> ')}`);
        }
        if (g.drag.duringDrag !== 0) {
          p.push(`${g.drag.duringDrag} restart(s) while the thumb was still down`);
        }
        if (g.drag.afterDrop !== 1) {
          p.push(`letting go of the drag restarted the round ${g.drag.afterDrop} time(s), wanted 1`);
        }
        if (g.held.heldValue === g.held.beforeHold) {
          p.push(`a held arrow key never moved the dial off ${g.held.beforeHold}`);
        }
        if (g.held.whileHeld !== 0) p.push(`${g.held.whileHeld} restart(s) while the key was held`);
        if (g.held.afterRelease !== 1) {
          p.push(`the key release restarted the round ${g.held.afterRelease} time(s), wanted 1`);
        }
        if (g.nudge.nudgedTo === g.nudge.beforeNudge || g.nudge.backTo !== g.nudge.beforeNudge) {
          p.push(`the nudge did not leave and come home: ${g.nudge.beforeNudge} -> ${g.nudge.nudgedTo} -> ${g.nudge.backTo}`);
        }
        if (g.nudge.restarts !== 0) {
          p.push(`committing the stop the round already has restarted it ${g.nudge.restarts} time(s)`);
        }
        if (g.modifier.heldUnderShift === g.modifier.beforeShift) {
          p.push(`the held arrow never moved the dial off ${g.modifier.beforeShift}`);
        }
        if (g.modifier.afterShift !== 0) {
          p.push(`tapping Shift mid-hold restarted the round ${g.modifier.afterShift} time(s)`);
        }
        if (!g.modifier.stillOnDial) p.push('tapping Shift mid-hold took focus off the dial');
        if (g.modifier.afterArrow !== 1) {
          p.push(`releasing the held arrow restarted the round ${g.modifier.afterArrow} time(s), wanted 1`);
        }
        if (g.restored !== '4') p.push(`the gestures left the dial on ${g.restored}, not Turbo`);
      }
    }
    if (c.play) {
      if (!row.state || !row.state.done) p.push('the round never finished');
      if (!row.state || row.state.gates !== 8) p.push(`round was ${row.state && row.state.gates} gates, wanted 8`);
      if (!row.state || !(row.state.score > 0)) p.push('the end screen showed no score');
      if (!row.state || !(row.state.bestStreak > 0)) p.push('best streak never rose above 0');
      if (!/Score \d+/.test(row.finalText || '')) p.push('no score on the end screen');
      if (!/Play again/.test(row.finalText || '')) p.push('no Play again button');
      if (!/Pick another game/.test(row.finalText || '')) p.push('no Pick another game button');
      const swallowed = (row.picks || []).filter((x) => !x.landed);
      if (swallowed.length) {
        p.push(`${swallowed.length} lane click(s) never landed (gates ${swallowed.map((x) => x.gate).join(',')})`);
      }
    }

    if (p.length) bad += 1;
    results.push(row);
    L(`${p.length ? 'FAIL' : 'ok  '}  ${c.name}${p.length ? '  ' + p.join('; ') : ''}`);
    await ctx.close();
  }

  // --- Chill versus Turbo, timed on the harness's own clock ------------------
  // The flat twin on purpose: this measures the CLOCK, not the renderer, and a
  // software-GL round would spend a minute proving nothing extra.
  {
    const timing = { case: 'speed-chill-vs-turbo', problems: [] };
    const tally = newTally();
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await silence(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    try {
      const enc = await makeSet(page);
      await bank(page, tally);
      await page.goto(`${BASE}/?silent=1&probe=1&flat=1#/play/tone/${enc}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('.tc-lane', { timeout: 15000 });
      await page.waitForFunction(() => Boolean(window.__tone), null, { timeout: 15000 });
      timing.control = await positiveControl(page);
      // Both rounds on the one page: the second is started from the end screen
      // by the dial itself, which is the path a child actually takes.
      timing.chill = await timeRoundAt(page, 0);
      timing.turbo = await timeRoundAt(page, 4);
      const heard = await counters(page, tally);
      timing.spoke = heard.spoke;
      timing.audioCtx = heard.audioCtx;
      timing.storeFail = heard.storeFail;
      timing.storeSpoke = heard.storeSpoke;
      timing.storeAudioCtx = heard.storeAudioCtx;
      timing.installed = heard.installed;
      timing.errors = errors;
    } catch (e) {
      timing.problems.push(`threw: ${String(e).slice(0, 240)}`);
      try {
        const heard = await counters(page, tally);
        timing.spoke = heard.spoke;
        timing.audioCtx = heard.audioCtx;
        timing.storeFail = heard.storeFail;
        timing.storeSpoke = heard.storeSpoke;
        timing.storeAudioCtx = heard.storeAudioCtx;
        timing.installed = heard.installed;
      } catch {
        timing.spoke = 0;
        timing.audioCtx = 0;
        timing.storeFail = 1;
        timing.storeSpoke = 0;
        timing.storeAudioCtx = 0;
        timing.installed = false;
      }
      timing.errors = errors;
    }

    const p = timing.problems;
    if ((timing.errors || []).length) p.push(`console errors: ${timing.errors.slice(0, 3).join(' | ')}`);
    if (!timing.control || !timing.control.ok) {
      p.push(`the silence positive control failed: ${(timing.control && timing.control.why) || 'never ran'}`);
    }
    if (timing.installed === false) p.push('the silence counters were never installed: silence unproven');
    if (timing.spoke !== 0) p.push(`something spoke ${timing.spoke} time(s)`);
    // The two timed rounds are two full playthroughs. They get the same silence
    // bar as every other case, AudioContext included.
    if (timing.audioCtx !== 0) p.push(`something opened ${timing.audioCtx} AudioContext(s)`);
    if (timing.storeFail) p.push(`the silence counters failed ${timing.storeFail} time(s): silence unproven`);
    if (timing.storeSpoke !== 0 || timing.storeAudioCtx !== 0) {
      p.push(`sessionStorage disagrees: spoke ${timing.storeSpoke}, audioCtx ${timing.storeAudioCtx}`);
    }
    if (!timing.chill || !timing.turbo) p.push('one of the two timed rounds did not run');
    else {
      // Both legs are STARTED by the dial, so a dial that silently did nothing
      // would make the ratio meaningless rather than red.
      const STOPS = ['Chill', 'Steady', 'Quick', 'Fast', 'Turbo'];
      for (const leg of [timing.chill, timing.turbo]) {
        const mv = leg.moved;
        const want = STOPS[leg.stop];
        if (!mv || mv.missing) p.push(`the dial could not be moved to ${want}`);
        else if (mv.after.readout !== want) p.push(`the dial reads "${mv.after.readout}", wanted ${want}`);
        else if (mv.after.gate !== 0) p.push(`moving to ${want} did not restart the round`);
      }
      const ratio = timing.chill.ms / timing.turbo.ms;
      timing.ratio = Number(ratio.toFixed(2));
      if (!(timing.turbo.ms < timing.chill.ms)) {
        p.push(`Turbo was not faster: chill ${timing.chill.ms}ms, turbo ${timing.turbo.ms}ms`);
      }
      // Theory is 3x on the gate and an unscaled 500 ms gap, so about 2.45x on
      // a whole round. A band, not a point, because this is a wall clock. The
      // floor is 2.2x and not 1.8x on purpose: 1.8x is exactly what a dial that
      // snapped back to the Quick default would produce, so the old floor was
      // green for the bug it was meant to catch.
      if (ratio < 2.2 || ratio > 3.2) p.push(`round-time ratio ${timing.ratio}x, wanted 2.2x to 3.2x`);
      L(`        chill ${timing.chill.ms}ms   turbo ${timing.turbo.ms}ms   ${timing.ratio}x`);
    }

    if (p.length) bad += 1;
    results.push(timing);
    L(`${p.length ? 'FAIL' : 'ok  '}  ${timing.case}${p.length ? '  ' + p.join('; ') : ''}`);
    await ctx.close();
  }

  await browser.close();
  L('');
  L(JSON.stringify(results, null, 2));
  L(bad === 0 ? '\nTONE CATCHER GATE: PASS' : `\nTONE CATCHER GATE: FAIL (${bad} case(s))`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

