// Do the games and the class room behave the way a teacher was promised?
//
// The four things a live run found broken on 2026-09-08, checked on the REAL
// surface (`npm run cf:dev`), through the same buttons a child presses:
//
//   D6  Memory Match's Turns counter starts a fresh round at 0, not at
//       whatever round 1 finished on;
//   D1  a second child typing a name already on the board is refused, with a
//       sentence that says what to do about it;
//   D2  a child who arrives at the round-ended screen (which IS between games)
//       gets in, without the teacher pressing anything;
//   D3  the projector shows the right answer once the question is shut, and
//       never before it.
//
// Plus the standing promise of every harness in this repo: zero speech. Every
// context stubs speechSynthesis and counts the calls, and a single call is a
// failure, not a note.
//
// Run:
//   npm run cf:dev -- --port 8798      # in another shell
//   BVG_BASE=http://localhost:8798 \
//     NODE_PATH=/path/to/node_modules \
//     node tests/e2e/verify-games.cjs
//
// Env: BVG_BASE (default http://localhost:8798), BVG_CHROME, BVG_LAND_MS.

const path = require('path');
const fs = require('fs');

// Playwright is not a dependency of this project (it is only ever used from
// these harnesses), so it is resolved from wherever it happens to live.
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

/** A Chromium to drive. Same resolution as verify-onboarding.cjs. */
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

const BASE = process.env.BVG_BASE || 'http://localhost:8798';
const LAND_MS = Number(process.env.BVG_LAND_MS || 12000);
const WORDS = '苹果 香蕉 葡萄 西瓜 草莓 橙子 桃子 梨';

const out = [];
const L = (s) => {
  console.log(s);
  out.push(s);
};

/** The build this run is evidence for. A log that names no commit proves less. */
const SHA = (() => {
  try {
    return require('child_process')
      .execSync('git rev-parse HEAD', { cwd: __dirname, encoding: 'utf8' })
      .trim();
  } catch {
    return 'unknown';
  }
})();
let failures = 0;
const check = (name, ok, detail) => {
  L(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) failures++;
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Never let an automated run make sound on the host machine, and COUNT the
 * attempts so "no speech" is a measurement rather than a hope. The app read
 * vocabulary aloud through the machine's speakers once; it does not get to
 * again.
 */
async function prepare(ctx) {
  await ctx.addInitScript(() => {
    window.__speakCalls = 0;
    try {
      localStorage.setItem('vocab-silent', '1');
    } catch {
      /* private mode */
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = () => {
        window.__speakCalls++;
      };
      window.speechSynthesis.cancel = () => {};
      window.speechSynthesis.getVoices = () => [];
    }
    HTMLMediaElement.prototype.play = function () {
      return Promise.resolve();
    };
    // The games also chime through WebAudio, which no `silent` flag reaches.
    const Dead = function () {
      window.__audioContexts++;
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
    window.__audioContexts = 0;
    window.AudioContext = Dead;
    window.webkitAudioContext = Dead;
  });
}

/** Types the fruit set into the home page and waits for the set page. */
async function makeSet(page) {
  await page.goto(`${BASE}/?silent=1#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#paste', { timeout: 15000 });
  // Before anything is measured: speak once and open one AudioContext ON
  // PURPOSE, and assert both counters saw it. Without this, a zero at the end
  // could mean the init script never ran rather than that nothing made a sound.
  const control = await page.evaluate(() => {
    window.speechSynthesis.speak({});
    void new window.AudioContext();
    const got = { spoke: window.__speakCalls, audioCtx: window.__audioContexts };
    window.__speakCalls = 0;
    window.__audioContexts = 0;
    return got;
  });
  check(
    'positive control: the silence stubs are installed and counting',
    control.spoke === 1 && control.audioCtx === 1,
    JSON.stringify(control)
  );
  await page.fill('#paste', WORDS);
  await page.getByRole('button', { name: 'Make games', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/set/'), null, {
    timeout: LAND_MS,
    polling: 100,
  });
  return page.evaluate(() => location.hash.slice('#/set/'.length));
}

/** The number in the "Turns" stat on the Memory Match bar. */
async function turnsShown(page) {
  return page.evaluate(() => {
    const stat = Array.from(document.querySelectorAll('.game-bar .stat')).find((node) =>
      /turns/i.test(node.textContent || '')
    );
    const digits = ((stat && stat.textContent) || '').match(/\d+/);
    return digits ? Number(digits[0]) : null;
  });
}

/** The word list off the set page: the zh/en pairs a Memory round is built from. */
async function readWordPairs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.word-list .word-row')).map((row) => ({
      zh: ((row.querySelector('.word-zh .zh') || {}).textContent || '').trim(),
      en: ((row.querySelector('.word-en') || {}).textContent || '').trim(),
    }))
  );
}

/**
 * Plays one Memory Match round perfectly, using the word pairs read off the set
 * page to know which two cards belong together. Perfect play means the turn
 * count is exactly the pair count, which is what makes the D6 assertion sharp:
 * a 2-pair round must report 2 turns, and reported 8 before the fix.
 *
 * (The faces are in the DOM face-down, which is what makes this possible at
 * all. That is defect D8 in the live report, not something this harness needs.)
 */
async function playMemoryRound(page, pairs) {
  const result = await page.evaluate(async (wordPairs) => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const enFor = new Map(wordPairs.map((p) => [p.zh, p.en]));
    for (let guard = 0; guard < 40; guard++) {
      if (document.querySelector('.final')) break;
      const cards = Array.from(document.querySelectorAll('.memory-card')).filter(
        (node) => !node.classList.contains('done')
      );
      if (cards.length < 2) break;
      // Key every remaining card by the CHINESE word of its pair, so the zh
      // card and its en card share a key.
      const keyed = new Map();
      for (const node of cards) {
        const face = node.querySelector('.face');
        if (!face) continue;
        const zh = face.querySelector('.zh');
        let key = '';
        if (zh) {
          key = (zh.textContent || '').trim();
        } else {
          const text = (face.textContent || '').trim();
          for (const [chinese, english] of enFor) {
            if (english === text) {
              key = chinese;
              break;
            }
          }
        }
        if (!key) continue;
        if (!keyed.has(key)) keyed.set(key, []);
        keyed.get(key).push(node);
      }
      const pair = Array.from(keyed.values()).find((nodes) => nodes.length === 2);
      if (!pair) return { stuck: true };
      pair[0].click();
      pair[1].click();
      await wait(150);
    }
    const hint = document.querySelector('.final .hint');
    return { stuck: false, text: hint ? hint.textContent : '' };
  }, pairs);
  const digits = ((result && result.text) || '').match(/(\d+)\s*turns?/i);
  return {
    text: (result && result.text) || (result && result.stuck ? 'solver stuck' : ''),
    turns: digits ? Number(digits[1]) : null,
  };
}

/** Joins a room as `name` in its own context. Returns what the page says. */
async function joinAs(browser, code, name) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await prepare(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?silent=1#/room/${code}`, { waitUntil: 'domcontentloaded' });
  let joined = false;
  try {
    await page.waitForSelector('input', { timeout: 12000 });
    await page.fill('input', name);
    await page.getByRole('button', { name: 'Join the game', exact: true }).click();
    joined = true;
  } catch {
    /* refused before the name screen: the body text says why */
  }
  // The refusal is a server round trip, so read the screen after it lands, not
  // while the button still says "Joining...".
  await sleep(3000);
  const body = await page.evaluate(() => document.body.innerText || '');
  return { ctx, page, body, reachedNameScreen: joined };
}

(async () => {
  L(`commit  ${SHA}`);
  L(`base    ${BASE}`);
  L(`chrome  ${EXE}`);
  L(`words   ${WORDS}`);
  L('');

  // `--mute-audio` is the belt to the init script's braces: nothing this
  // harness drives is allowed to reach this machine's speakers.
  const browser = await chromium.launch({
    headless: true,
    executablePath: EXE,
    args: ['--mute-audio'],
  });
  const contexts = [];
  const pageErrors = [];
  const track = (ctx) => {
    contexts.push(ctx);
    return ctx;
  };

  try {
    // ---------- (a) Memory Match: the Turns counter is per round ----------
    const soloCtx = track(await browser.newContext({ viewport: { width: 900, height: 1200 } }));
    await prepare(soloCtx);
    const solo = await soloCtx.newPage();
    solo.on('pageerror', (e) => pageErrors.push(String(e.message)));

    const enc = await makeSet(solo);
    check('the fruit paste reaches a set page', Boolean(enc), enc ? '' : 'no #/set/');
    const pairs = await readWordPairs(solo);
    check('the set page lists the 8 fruit words', pairs.length === 8, `${pairs.length} rows`);

    await solo.goto(`${BASE}/?silent=1#/play/memory/${enc}`, { waitUntil: 'domcontentloaded' });
    await solo.waitForSelector('.memory-card', { timeout: 15000 });
    const first = await playMemoryRound(solo, pairs);
    check('Memory Match round 1 finishes', first.turns !== null, first.text || 'no end card');

    const next = await solo.getByRole('button', { name: 'Next words', exact: true });
    const hasNext = (await next.count()) > 0;
    check('a second round is offered ("Next words")', hasNext, hasNext ? '' : 'no button');
    if (hasNext) {
      await next.click();
      await solo.waitForSelector('.memory-card', { timeout: 10000 });
      const atStart = await turnsShown(solo);
      check(
        'D6 the Turns counter resets when the next round starts',
        atStart === 0,
        `bar says ${atStart} turns`
      );
      const secondPairs = await solo.evaluate(
        () => document.querySelectorAll('.memory-card').length / 2
      );
      const second = await playMemoryRound(solo, pairs);
      // Perfect play means turns == pairs. Round 2 of an 8-word set is 2 pairs,
      // so it must say 2. Before the fix it said 8 (round 1's 6 carried in).
      check(
        'D6 round 2 reports its own turns, not round 1 plus round 2',
        second.turns === secondPairs,
        `round 1 ${first.turns} turns, round 2 ${second.turns} turns for ${secondPairs} pairs`
      );
    }

    // ---------- (b) the class room ----------
    await solo.goto(`${BASE}/?silent=1#/set/${enc}`, { waitUntil: 'domcontentloaded' });
    await solo.getByRole('button', { name: /Start a class room/i }).first().click();
    await solo.waitForFunction(() => location.hash.startsWith('#/host/'), null, {
      timeout: LAND_MS,
      polling: 100,
    });
    const code = await solo.evaluate(() => location.hash.slice('#/host/'.length).slice(0, 4));
    check('a class room gets a 4-letter code', /^[A-Z0-9]{4}$/.test(code), code);

    const teacherGate = await solo.getByRole('button', { name: /I am the teacher/i });
    if ((await teacherGate.count()) > 0) await teacherGate.first().click();
    await sleep(800);

    const ming = await joinAs(browser, code, '小明');
    track(ming.ctx);
    const ana = await joinAs(browser, code, 'Ana');
    track(ana.ctx);
    await sleep(2000);
    const roster = await solo.evaluate(() => document.body.innerText || '');
    check(
      'two students join and land on the teacher roster',
      roster.includes('小明') && roster.includes('Ana'),
      roster.split('\n').find((line) => /player/i.test(line)) || ''
    );

    // D1: the same name again, spelled the way a child would retype it.
    const dup = await joinAs(browser, code, 'ana ');
    track(dup.ctx);
    const refused = /already using that name|already called|already in this room/i.test(dup.body);
    check('D1 a second "ana " is refused', refused, dup.body.split('\n').slice(0, 4).join(' / '));
    const rosterLine = await solo.evaluate(() => {
      const text = document.body.innerText || '';
      return text.split('\n').find((line) => /\d+ players?:/i.test(line)) || text;
    });
    const anaRows = (rosterLine.match(/ana/gi) || []).length;
    check('D1 the board still shows one Ana', anaRows === 1, rosterLine);

    // ---------- Race Quiz: the projector reveals a shut answer ----------
    const race = await solo.getByRole('button', { name: /Race Quiz/i });
    if ((await race.count()) > 0) await race.first().click();
    const quick = await solo.getByRole('button', { name: /^6\b|Quick/i });
    if ((await quick.count()) > 0) await quick.first().click();
    await solo.getByRole('button', { name: /^Start$/i }).first().click();

    // While the first question is OPEN, the projector must not print an answer.
    await solo.waitForFunction(
      () => Boolean(document.querySelector('.host-word')),
      null,
      { timeout: 20000, polling: 100 }
    );
    const whileOpen = await solo.evaluate(() =>
      Boolean(document.querySelector('.host-answer'))
    );
    check('D3 the projector shows NO answer while the question is open', !whileOpen);

    // Both children answer, then the question shuts on the server's clock.
    for (const who of [ming, ana]) {
      const choice = await who.page.$$('.choice, .btn-choice, .quiz-choice');
      if (choice.length > 0) await choice[0].click().catch(() => undefined);
    }
    // A kids-level question is open for 12 s, plus the 1.5 s answering grace,
    // so the reveal cannot arrive before then. Wait for it rather than guessing.
    // The FULL reveal, and only the full reveal. The earlier version of this
    // check accepted "Answer: grape" OR the shrunken "Last answer: 葡萄 = grape",
    // and went green on the second while the first was structurally impossible
    // in a real class (adversarial review 2026-09-08, MUST-FIX 2). Accepting
    // either shape is what let a half-working feature report as done, so the
    // small grey line is now explicitly NOT enough on its own.
    let full = '';
    let lastLine = '';
    for (let i = 0; i < 60; i++) {
      const seen = await solo.evaluate(() => {
        const node = document.querySelector('.host-answer:not(.host-answer--last)');
        const last = document.querySelector('.host-answer--last');
        return {
          full: node ? node.textContent.trim() : '',
          last: last ? last.textContent.trim() : '',
        };
      });
      if (seen.full) full = seen.full;
      if (seen.last) lastLine = seen.last;
      if (full) break;
      await sleep(500);
    }
    const namesAWord = (text) =>
      pairs.some((pair) => text.includes(pair.en) || text.includes(pair.zh));
    check(
      'D3 the projector shows the FULL answer while the shut question is on screen',
      /^Answer:\s*\S/.test(full) && namesAWord(full),
      full || `no full .host-answer (last-answer line was: ${lastLine || 'none'})`
    );

    // ...and it then shrinks to the small line under the question that follows,
    // so the class keeps the word in view without it competing with the new one.
    let shrunk = lastLine;
    for (let i = 0; i < 30 && !shrunk; i++) {
      await sleep(500);
      shrunk = await solo.evaluate(() => {
        const node = document.querySelector('.host-answer--last');
        return node ? node.textContent.trim() : '';
      });
    }
    check(
      'D3 the full answer then shrinks to the last-answer line',
      /^Last answer:\s*\S/.test(shrunk) && namesAWord(shrunk),
      shrunk || 'no .host-answer--last after the full reveal'
    );

    // ---------- the all-answered room: both children finish the round ----------
    //
    // This is the shape the round-2 review found broken (MUST-FIX 1) and the
    // shape this harness room has always been: two children, both tapping. When
    // every child has answered every question the room wants to end on the last
    // tap, which used to be BEFORE the last question's reveal instant, so the
    // last word of the lesson reached the projector at no time at all. Playing
    // the round out to its end is the only way this file can see that.
    const counterOf = () =>
      solo.evaluate(() => {
        const node = document.querySelector('.host-counter');
        const text = node ? node.textContent.trim() : '';
        const m = /Question\s+(\d+)\s+of\s+(\d+)/i.exec(text);
        return m ? { index: Number(m[1]), total: Number(m[2]) } : null;
      });

    const opening = await counterOf();
    const total = opening ? opening.total : 0;
    let lastFull = '';
    if (total > 1) {
      const answeredHere = new Set([opening.index]);
      // Both children tap whatever is on their screen, every question, to the
      // end of the round. A 6-question round is 6 * (12s + 1.5s grace + 2.5s
      // pause) = 96s plus the 3s start delay, so the budget has to outlast two
      // minutes: at roughly 0.6s an iteration, 260 of them.
      for (let i = 0; i < 260; i++) {
        const now = await counterOf();
        if (!now) {
          // "Get ready", "Last one in...", a re-render, or the results screen.
          // None of those is a reason to stop looking: keep polling until the
          // full answer shows up or the budget runs out, so a transient blank
          // cannot be read as a missing reveal.
          await sleep(1000);
          continue;
        }
        if (!answeredHere.has(now.index)) {
          answeredHere.add(now.index);
          for (const who of [ming, ana]) {
            const choice = await who.page.$$('.choice, .btn-choice, .quiz-choice');
            if (choice.length > 0) await choice[0].click().catch(() => undefined);
          }
        }
        if (now.index === total) {
          const seen = await solo.evaluate(() => {
            const node = document.querySelector('.host-answer:not(.host-answer--last)');
            return node ? node.textContent.trim() : '';
          });
          if (seen) {
            lastFull = seen;
            break;
          }
        }
        await sleep(500);
      }
      if (!lastFull) {
        const where = await solo.evaluate(() => (document.body.innerText || '').slice(0, 200));
        console.log(`      (host screen when the last answer never came: ${where.replace(/\n/g, ' / ')})`);
      }
      check(
        'the LAST question still gets its full Answer: line when everyone answered',
        /^Answer:\s*\S/.test(lastFull) && namesAWord(lastFull),
        lastFull || `no full .host-answer on question ${total} of ${total}`
      );
    } else {
      check('the round reported a question count the harness can play out', false, String(total));
    }

    // ---------- D2: a third child joins at the round-ended screen ----------
    // The round may have finished itself by now, in which case there is no
    // button to press and the room is already where D2 needs it.
    const endNow = await solo.getByRole('button', { name: /End round now/i });
    if ((await endNow.count()) > 0) await endNow.first().click();
    await sleep(2500);
    const hostBody = await solo.evaluate(() => document.body.innerText || '');
    check(
      'the teacher is on the round-ended screen',
      /Pick another game|wins|Round over|It is a tie/i.test(hostBody),
      hostBody.split('\n').slice(0, 3).join(' / ')
    );

    const late = await joinAs(browser, code, 'Late');
    track(late.ctx);
    // The server's own roster is the truth here, not a sentence on a screen.
    const roomState = await solo.evaluate(async (room) => {
      const res = await fetch(`/api/rooms/${room}`);
      return res.json();
    }, code);
    const names = ((roomState && roomState.state && roomState.state.players) || []).map(
      (p) => p.name
    );
    check(
      'D2 a third child joins between games, with nobody pressing anything',
      names.includes('Late'),
      `roster: ${names.join(', ')} :: ${late.body.split('\n').slice(0, 3).join(' / ')}`
    );
    await sleep(2000);
    const rosterLate = await solo.evaluate(() => document.body.innerText || '');
    check('D2 the teacher board picks the latecomer up', rosterLate.includes('Late'));

    // ---------- (c) silence, in every context ----------
    for (const [name, page] of [
      ['teacher', solo],
      ['小明', ming.page],
      ['Ana', ana.page],
      ['duplicate', dup.page],
      ['late', late.page],
    ]) {
      const calls = await page.evaluate(() => window.__speakCalls || 0).catch(() => 0);
      check(`no speech in the ${name} context`, calls === 0, `speak called ${calls} times`);
      // The games also chime through WebAudio, and that counter was being
      // incremented and never read. A MISSING counter is a recording failure,
      // not a zero: -1 makes it fail loudly instead of reading as silence.
      const ctxs = await page
        .evaluate(() => (typeof window.__audioContexts === 'number' ? window.__audioContexts : -1))
        .catch(() => -1);
      check(
        `nothing opened an AudioContext in the ${name} context`,
        ctxs === 0,
        ctxs < 0 ? 'the counter was missing, so silence was never recorded' : `${ctxs} context(s)`
      );
    }

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  L('');
  L(`${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});

