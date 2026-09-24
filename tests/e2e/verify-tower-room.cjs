// Does a class actually build one tower together?
//
// A teacher and THREE children on the real surface (`npm run cf:dev`), playing
// a Sky Tower round through the same buttons a class presses, to a real win.
// What it asserts, and why each one needs a live run rather than a unit test:
//
//   1. the projector is DRAWING. Sampled luminance variance through the game's
//      own `__towerPixels` hook, so the draw and the readback happen in one
//      task. A blank canvas scores 0 and passes every other kind of check;
//   2. the number of blocks the scene was handed equals the class total. The
//      board stamps `data-blocks` with what it told the renderer, so this
//      compares the picture against the arithmetic and not against itself;
//   3. no child's page ever names another child or shows another child's
//      count, at any point in the round. Checked on all three, every tick;
//   4. the projector shows the FULL answer after each question shuts (Cloud
//      Climb's reveal, unchanged, which is the thing most likely to have been
//      broken by adding a fourth round kind);
//   5. the finish screen appears and says the class built it;
//   6. zero speech and zero AudioContexts in every one of the four contexts.
//
// Silence is a measurement here, not a hope: speechSynthesis and AudioContext
// are wired to recorders rather than deleted, `?silent=1` is on every URL, and
// Chromium runs with --mute-audio. Nothing makes a sound on this machine.
//
// Run:
//   npm run build && npm run cf:dev -- --port 8831     # in another shell
//   NODE_PATH=/path/to/node_modules \
//     BVG_BASE=http://localhost:8831 node tests/e2e/verify-tower-room.cjs
//
// Env: BVG_BASE (default http://localhost:8831), BVG_CHROME, BVG_SHOTS.

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
  const usable = found.find((candidate) => fs.existsSync(candidate));
  if (!usable) throw new Error('no Chromium found; set BVG_CHROME to one');
  return usable;
})();

const BASE = process.env.BVG_BASE || 'http://localhost:8831';
const SHOTS = process.env.BVG_SHOTS || path.join(__dirname, '..', '..', 'scratch', 'tower-room');
const WORDS = '苹果 香蕉 葡萄 西瓜 草莓 橙子 桃子 梨';
const KIDS = ['Ana', 'Ben', 'Cara'];

const GL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--mute-audio',
];

let failures = 0;
const L = (s) => console.log(s);
const check = (name, ok, detail) => {
  L(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Recorders, not deletions. A blip that cannot happen also cannot be measured,
 * and the app has read vocabulary aloud through this machine's speakers once.
 */
async function silence(ctx) {
  await ctx.addInitScript(() => {
    window.__spoke = 0;
    window.__played = 0;
    window.__audioCtx = 0;
    try {
      localStorage.setItem('vocab-silent', '1');
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
    HTMLMediaElement.prototype.play = function () {
      const src = String(this.currentSrc || this.src || '');
      // The one-off silent WAV that unlocks iOS audio is not a sound.
      if (!/^data:audio\/wav;base64,UklGRiQ/.test(src)) window.__played += 1;
      return Promise.resolve();
    };
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
          start() {},
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

/** Variance across sampled pixels, read in the same task the frame is drawn in. */
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
    return { ok: true, sampled: lum.length, mean, variance, drawn: out.drawn };
  }, samples);
}

/** What the projector says: blocks drawn, the tally, the clock, the answer line. */
async function readProjector(page) {
  return page.evaluate(() => {
    const board = document.querySelector('.tower-board');
    const full = document.querySelector('.host-answer:not(.host-answer--last)');
    const tally = Array.from(document.querySelectorAll('.host-tower-tally li')).map((li) => {
      const b = li.querySelector('b');
      return {
        name: (li.querySelector('.host-tower-who') || {}).textContent || '',
        count: Number((b && b.textContent) || 0),
      };
    });
    const goal = document.querySelector('.host-round-goal');
    const clock = document.querySelector('.host-tower-clock');
    const headline = document.querySelector('.host-headline');
    return {
      blocks: board ? Number(board.dataset.blocks || '-1') : -1,
      tally,
      total: tally.reduce((sum, row) => sum + row.count, 0),
      goal: (goal && goal.textContent) || '',
      clock: (clock && clock.textContent) || '',
      answer: full ? full.textContent.trim() : '',
      headline: headline ? headline.textContent.trim() : '',
    };
  });
}

/**
 * Records what the server sends back to THIS device on its own /answer POST.
 *
 * Panel round 1, M1: every POST used to be answered with the anonymous payload,
 * so in a tower round the answering child's OWN row came back zeroed. Nothing
 * on screen said so for more than a poll interval, which is exactly why this is
 * measured on the wire rather than in the DOM.
 */
async function recordAnswerReplies(ctx) {
  await ctx.addInitScript(() => {
    window.__answerReplies = [];
    const original = window.fetch;
    window.fetch = async function (...args) {
      const res = await original.apply(this, args);
      const url = String((args[0] && args[0].url) || args[0] || '');
      if (/\/answer$/.test(url)) {
        try {
          const body = await res.clone().json();
          const players = (body && body.state && body.state.players) || [];
          window.__answerReplies.push(
            players.map((p) => ({
              name: p.name,
              answered: p.answered,
              correct: p.correct,
              answeredIndexes: p.answeredIndexes,
            }))
          );
        } catch {
          /* not JSON, or already consumed */
        }
      }
      return res;
    };
  });
}

/** Joins a room as `name` in its own context, on a phone-sized viewport. */
async function joinAs(browser, code, name) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await silence(ctx);
  await recordAnswerReplies(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?silent=1#/room/${code}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input', { timeout: 15000 });
  await page.fill('input', name);
  await page.getByRole('button', { name: 'Join the game', exact: true }).click();
  await sleep(2500);
  return { ctx, page, name };
}

/** The open question on a child's screen: choice labels, and which is green. */
async function readCard(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('.choices .choice'));
    if (buttons.length === 0) return null;
    return {
      count: buttons.length,
      anyEnabled: buttons.some((b) => !b.disabled),
      right: buttons.findIndex((b) => b.classList.contains('right')),
    };
  });
}

async function tap(page, index) {
  await page
    .evaluate((i) => {
      const buttons = Array.from(document.querySelectorAll('.choices .choice'));
      if (buttons[i] && !buttons[i].disabled) buttons[i].click();
    }, index)
    .catch(() => undefined);
}

(async () => {
  L(`base    ${BASE}`);
  L(`chrome  ${EXE}`);
  L(`shots   ${SHOTS}`);
  L('');
  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: GL_ARGS });
  const contexts = [];
  const pageErrors = [];

  try {
    // ---------- the teacher makes a set and a room ----------
    const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(hostCtx);
    await silence(hostCtx);
    const host = await hostCtx.newPage();
    host.on('pageerror', (e) => pageErrors.push('host: ' + e.message));

    // `probe=1` is what turns on the render gate's readback hook. It is not on
    // in a normal page load.
    await host.goto(`${BASE}/?silent=1&probe=1#/`, { waitUntil: 'domcontentloaded' });
    await host.waitForSelector('#paste', { timeout: 20000 });
    await host.fill('#paste', WORDS);
    await host.getByRole('button', { name: 'Make games', exact: true }).click();
    await host.waitForFunction(() => location.hash.startsWith('#/set/'), null, {
      timeout: 20000,
      polling: 100,
    });
    await host.getByRole('button', { name: /Start a class room/i }).first().click();
    await host.waitForFunction(() => location.hash.startsWith('#/host/'), null, {
      timeout: 20000,
      polling: 100,
    });
    const code = await host.evaluate(() => location.hash.slice('#/host/'.length).slice(0, 4));
    check('a class room gets a 4-letter code', /^[A-Z0-9]{4}$/.test(code), code);

    const gate = await host.getByRole('button', { name: /I am the teacher/i });
    if ((await gate.count()) > 0) await gate.first().click();
    await sleep(800);

    // ---------- three children join ----------
    const kids = [];
    for (const name of KIDS) {
      const kid = await joinAs(browser, code, name);
      contexts.push(kid.ctx);
      kid.page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
      kids.push(kid);
    }
    await sleep(2000);
    const roster = await host.evaluate(() => document.body.innerText || '');
    check(
      'all three children reach the teacher roster',
      KIDS.every((name) => roster.includes(name)),
      KIDS.filter((name) => !roster.includes(name)).join(', ') || 'all three'
    );

    // ---------- the teacher starts Sky Tower ----------
    const towerCard = await host.getByRole('button', { name: /Sky Tower/i });
    check('the teacher can pick Sky Tower', (await towerCard.count()) > 0);
    if ((await towerCard.count()) > 0) await towerCard.first().click();
    await host.getByRole('button', { name: /^Start$/i }).first().click();

    await host.waitForFunction(() => Boolean(document.querySelector('.tower-board')), null, {
      timeout: 25000,
      polling: 150,
    });
    const opening = await readProjector(host);
    const goalMatch = /Goal (\d+) blocks/.exec(opening.goal);
    const target = goalMatch ? Number(goalMatch[1]) : 0;
    check('the projector states the class goal', target > 0, opening.goal || 'no goal line');
    check(
      'the tally lists every child before a block is built',
      opening.tally.length === KIDS.length && opening.total === 0,
      JSON.stringify(opening.tally)
    );

    // ---------- the class plays to a win ----------
    //
    // One child probes with the first choice; the server tells HER what was
    // right (the answer key is never in the polled state), her card paints it
    // green, and the other two tap that. That is roughly two to three blocks a
    // question, so a target of 7 to 9 falls inside four or five questions.
    let built = 0;
    let midShot = false;
    let sawAnswer = '';
    let leak = '';
    let shrunkAnswer = '';
    /** How many times the no-leak check actually ran, so it cannot pass vacuously. */
    let leakChecks = 0;
    const answered = new Set();

    for (let tick = 0; tick < 400 && !leak; tick += 1) {
      const view = await readProjector(host);
      if (view.headline) break;

      // (3) checked EVERY tick, not once: a child in a tower round must never
      // see another child. Scoped to the round VIEW on purpose. The lobby is a
      // roster and is supposed to name everybody who joined; the promise is
      // about the game, and the game is the screen with `.tower-mine` on it.
      for (const kid of kids) {
        const seen = await kid.page.evaluate((names) => {
          if (!document.querySelector('.tower-mine')) return null;
          const text = document.body.innerText || '';
          return names.filter((name) => text.includes(name));
        }, KIDS.filter((name) => name !== kid.name));
        if (seen === null) continue;
        leakChecks += 1;
        if (seen.length > 0) {
          leak = `${kid.name}'s screen named ${seen.join(', ')}`;
          break;
        }
      }
      if (leak) break;

      if (view.answer && !sawAnswer) sawAnswer = view.answer;
      if (!shrunkAnswer) {
        shrunkAnswer = await host.evaluate(() => {
          const node = document.querySelector('.host-answer--last');
          return node ? node.textContent.trim() : '';
        });
      }

      // A question is open when the probe child's card has live buttons.
      const probeCard = await readCard(kids[0].page);
      if (probeCard && probeCard.anyEnabled) {
        const key = await kids[0].page.evaluate(() => {
          const big = document.querySelector('.quiz-prompt .big');
          return big ? (big.textContent || '').trim() : '';
        });
        if (key && !answered.has(key)) {
          answered.add(key);
          await tap(kids[0].page, 0);
          // Wait for the server's verdict to paint the right choice green.
          let right = -1;
          for (let i = 0; i < 30 && right < 0; i += 1) {
            await sleep(200);
            const card = await readCard(kids[0].page);
            right = card ? card.right : -1;
          }
          if (right >= 0) {
            for (const kid of kids.slice(1)) await tap(kid.page, right);
          }
        }
      }

      const after = await readProjector(host);
      built = Math.max(built, after.total);
      if (!midShot && after.blocks >= 2) {
        midShot = true;
        const variance = await canvasVariance(host, 900);
        check(
          'the projector canvas is DRAWING mid-round',
          variance.ok && variance.variance > 1,
          JSON.stringify(variance)
        );
        // (2) the picture and the arithmetic agree. Blocks land 120 ms apart,
        // so allow the queue a moment to empty before comparing.
        await sleep(800);
        const settled = await readProjector(host);
        check(
          'the blocks drawn equal the class total',
          settled.blocks === settled.total,
          `${settled.blocks} drawn, ${settled.total} earned (${JSON.stringify(settled.tally)})`
        );
        check(
          'the class clock is counting down from three minutes',
          /^[0-2]:\d\d$/.test(settled.clock),
          settled.clock || 'no clock'
        );
        const shot = path.join(SHOTS, 'projector-mid.png');
        await host.screenshot({ path: shot });
        L(`shot    ${shot}`);
      }
      await sleep(500);
    }

    check(
      'no child ever saw another child on her screen',
      leak === '' && leakChecks > 20,
      leak || (leakChecks > 20 ? `${leakChecks} in-round checks` : `only ${leakChecks} checks ran`)
    );
    check(
      'the projector showed the FULL answer after a question shut',
      /^Answer:\s*\S/.test(sawAnswer),
      sawAnswer || 'no .host-answer during the round'
    );
    check(
      'the full answer then shrank to the last-answer line',
      /^Last answer:\s*\S/.test(shrunkAnswer),
      shrunkAnswer || 'no .host-answer--last during the round'
    );

    // ---------- the finish ----------
    let finish = await readProjector(host);
    for (let i = 0; i < 60 && !finish.headline; i += 1) {
      await sleep(1000);
      finish = await readProjector(host);
    }
    check('the round reaches a finish screen', Boolean(finish.headline), finish.headline);
    check(
      'the class built the tower',
      finish.headline === 'The class built it!',
      `${finish.headline} (built ${built} of ${target})`
    );
    // Counting the elements is NOT enough: the first live run drew 24 of them
    // and the screenshot showed a blank strip, because a positive animation
    // delay parks a piece above the band until the delay elapses. So the
    // assertion is where the pieces ARE, not how many exist.
    const confetti = await host.evaluate(() => {
      const box = document.querySelector('.host-confetti');
      if (!box) return { pieces: 0, inFrame: 0 };
      const band = box.getBoundingClientRect();
      const bits = Array.from(box.querySelectorAll('i'));
      const inFrame = bits.filter((bit) => {
        const r = bit.getBoundingClientRect();
        return r.bottom > band.top && r.top < band.bottom && r.height > 0;
      }).length;
      return { pieces: bits.length, inFrame };
    });
    check(
      'confetti is actually visible over the win, not parked above it',
      confetti.inFrame > 4,
      JSON.stringify(confetti)
    );

    // The other thing only the screenshot saw: a co-operative round drew a
    // first/second/third podium with points under "The class built it!".
    const podium = await host.evaluate(() => ({
      podiumSteps: document.querySelectorAll('.podium .podium-step:not(.podium-step--empty)').length,
      built: Array.from(document.querySelectorAll('.host-tower-built li')).map((li) =>
        (li.textContent || '').replace(/\s+/g, ' ').trim()
      ),
    }));
    check(
      'the finish shows no podium for a co-operative round',
      podium.podiumSteps === 0,
      `${podium.podiumSteps} podium steps`
    );
    check(
      'the finish says who built what, in blocks',
      podium.built.length === KIDS.length && podium.built.every((row) => /\d+ blocks?$/.test(row)),
      podium.built.join(' | ') || 'no .host-tower-built list'
    );

    const finishShot = path.join(SHOTS, 'projector-finish.png');
    await host.screenshot({ path: finishShot });
    L(`shot    ${finishShot}`);

    // A child's own finish view.
    //
    // Scoped to the ROUND result. The block below it is the lesson scoreboard,
    // which spans every round a class plays and names everybody by design; the
    // co-operative promise is about the tower, and the tower's result is this
    // part. So the assertion is: the round result says what the CLASS did and
    // what SHE did, and nothing about anybody else.
    const kidFinish = await kids[0].page.evaluate(() => {
      const final = document.querySelector('.final');
      const roundLine = document.querySelector('.round-line');
      return {
        result: final ? final.innerText.trim() : '',
        roundLine: roundLine ? roundLine.textContent.trim() : '',
        rankingRows: document.querySelectorAll('.final ~ .ranking li').length,
      };
    });
    const namesOthers = KIDS.slice(1).filter((name) => kidFinish.result.includes(name));
    check(
      'the child\u2019s round result names no other child',
      namesOthers.length === 0,
      namesOthers.join(', ') || kidFinish.result.replace(/\n/g, ' / ')
    );
    check(
      'the child\u2019s round result is the co-operative one',
      /The class built it/.test(kidFinish.result) && /You added \d+ block/.test(kidFinish.result),
      kidFinish.result.replace(/\n/g, ' / ') || 'no .final'
    );
    await kids[0].page.screenshot({ path: path.join(SHOTS, 'child-finish.png') });

    // (1) panel round 1, M2: after a co-operative round, nothing anywhere on a
    // child's page names another child. Not scoped to the round result this
    // time: the lesson scoreboard under it was the leak, and the whole page is
    // what the child is actually holding.
    const wholePage = await kids[0].page.evaluate(() => document.body.innerText || '');
    const namedAnywhere = KIDS.slice(1).filter((name) => wholePage.includes(name));
    check(
      'a child\u2019s whole page names no other child after a tower round',
      namedAnywhere.length === 0,
      namedAnywhere.join(', ') || `${wholePage.length} chars checked`
    );

    // (2) panel round 1, M1: the reply to her own answer carried her own count.
    const replies = await kids[0].page.evaluate(() => window.__answerReplies || []);
    const mine = replies
      .map((rows) => rows.find((row) => row.name === KIDS[0]))
      .filter(Boolean);
    const zeroed = mine.filter(
      (row) => row.answered === 0 || (row.answeredIndexes || []).length === 0
    );
    check(
      'every answer reply carried the answering child\u2019s own count',
      mine.length > 0 && zeroed.length === 0,
      `${mine.length} replies seen, ${zeroed.length} came back zeroed`
    );

    // ---------- silence, in every context ----------
    const pages = [host, ...kids.map((k) => k.page)];
    const names = ['teacher', ...KIDS];
    for (let i = 0; i < pages.length; i += 1) {
      const heard = await pages[i].evaluate(() => ({
        spoke: window.__spoke,
        played: window.__played,
        audioCtx: window.__audioCtx,
      }));
      check(
        `${names[i]}: no speech, no media, no AudioContext`,
        heard.spoke === 0 && heard.played === 0 && heard.audioCtx === 0,
        JSON.stringify(heard)
      );
    }

    check('no page errors anywhere', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  L('');
  L(failures === 0 ? 'TOWER ROOM GATE: PASS' : `TOWER ROOM GATE: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

