// Does a teacher's paste actually reach the games?
//
// Every file in tests/fixtures/teacher-pastes/ is a real shape a teacher might
// paste: a run of characters with no spaces, a paragraph, a WeChat message, an
// HSK table. Each one is typed into the REAL home page served by
// `npm run cf:dev` (so /api/extract, /api/enrich and the dictionary are the
// real ones, not a stub) and the run asserts what the teacher would see:
//
//   landed   the press of "Make games" ends on #/set/<enc> within 8 seconds,
//            not on the could-not-read screen and not on a spinner;
//   count    the set page says it holds at least as many words as the
//            fixture's `must` list;
//   found    every `must` word is on the page's own word list;
//   clean    no `mustNot` word (grammar, the sentence around the list) is.
//
// A fixture whose sidecar says `"expectLanding": false` is graded the other way
// round. Some pastes have no vocabulary in them at all: a bilingual lesson index
// (`第1课 Lesson one`) is chapter numbers and their English titles, and the
// honest answer is no cards. For those the games page is the FAILURE, because a
// game full of chapter numbers looks like it worked. So the run asserts the
// opposite three things:
//
//   #/set/ never comes up within the same 8 seconds;
//   the press ends on the edit table (#/review), which is the screen she can
//   see and fix, not a spinner and not a dead home page;
//   no `mustNot` string is anywhere on that screen, and it never asks her to
//   "type the English".
//
// `must` must be empty for such a fixture; the run says so rather than quietly
// grading a contradiction.
//
// Plus one standing promise about the failure screen: a paste that yields a
// single word lands on the edit table, and that table never asks the teacher to
// "type the English" for her words. Ending that ask is the whole point of the
// onboarding change, so it is checked on every render, not just the last one.
//
// Run:
//   npm run cf:dev -- --port 8796      # in another shell
//   NODE_PATH=/path/to/node_modules \
//     node tests/e2e/verify-onboarding.cjs
//
// Env: BVG_BASE (default http://localhost:8796), BVG_CHROME, BVG_LAND_MS.

const path = require('path');
const fs = require('fs');

// Playwright is not a dependency of this project (it is only ever used from
// this harness), so it is resolved from wherever it happens to live.
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

/**
 * A Chromium to drive. The Playwright download cache is not something this
 * project owns (it lives under ~/Library/Caches and a disk sweep can take it),
 * so the first one that actually exists on disk wins, and the system Chrome is
 * the last resort rather than a hardcoded path that goes stale.
 */
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

const BASE = process.env.BVG_BASE || 'http://localhost:8796';
/** How long a teacher waits between the press and the games. */
const LAND_MS = Number(process.env.BVG_LAND_MS || 8000);
const REPO = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(REPO, 'tests', 'fixtures', 'teacher-pastes');

/**
 * The shapes to run when the fixture folder is not there yet. They are the ones
 * from scratch/parse-probe.mjs, which is where the free-text problem was first
 * measured, so a run on a bare checkout still exercises the real cases rather
 * than doing nothing and reporting a pass.
 */
const BUILTIN = [
  {
    name: 'builtin:run',
    text: '苹果香蕉老师学生跑步游泳',
    must: ['苹果', '香蕉', '老师', '学生'],
    mustNot: ['苹果香蕉老师学生跑步游泳'],
  },
  {
    name: 'builtin:cnCommaOneLine',
    text: '苹果，香蕉，老师，学生，跑步',
    must: ['苹果', '香蕉', '老师', '学生', '跑步'],
    mustNot: ['苹果，香蕉，老师，学生，跑步'],
  },
  {
    name: 'builtin:paragraph',
    text: '今天我们学习水果。苹果很好吃，香蕉也很好吃。老师和学生一起去图书馆。',
    must: ['苹果', '香蕉', '老师'],
    mustNot: ['我们', '也'],
  },
  {
    name: 'builtin:pauseMark',
    text: '苹果、香蕉、老师、学生',
    must: ['苹果', '香蕉', '老师', '学生'],
    mustNot: ['苹果、香蕉、老师、学生'],
  },
  {
    name: 'builtin:unitHeader',
    text: 'Unit 3 Vocabulary\n苹果 apple\n香蕉 banana\nHomework: page 12',
    must: ['苹果', '香蕉'],
    mustNot: ['Unit 3 Vocabulary'],
  },
  {
    name: 'builtin:wechat',
    text: '这周的生词：苹果 香蕉 老师 学生 跑步 游泳 高兴 漂亮，请复习',
    must: ['苹果', '香蕉', '老师', '学生'],
    mustNot: ['请复习', '这周的生词'],
  },
];

function readFixtures() {
  if (!fs.existsSync(FIXTURE_DIR)) {
    return { source: 'builtin (tests/fixtures/teacher-pastes not on disk)', cases: BUILTIN };
  }
  const cases = [];
  for (const file of fs.readdirSync(FIXTURE_DIR).sort()) {
    if (!file.endsWith('.txt')) continue;
    const stem = file.slice(0, -4);
    const text = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
    let expected = {};
    const sidecar = path.join(FIXTURE_DIR, `${stem}.expected.json`);
    if (fs.existsSync(sidecar)) {
      try {
        expected = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      } catch (error) {
        // A sidecar we cannot read is a finding, not a silent pass: the case
        // still runs, with no expectations, and the table says so.
        expected = { _broken: String(error && error.message) };
      }
    }
    const list = (value) => (Array.isArray(value) ? value.map(String) : []);
    cases.push({
      name: stem,
      text,
      must: list(expected.must),
      mustNot: list(expected.mustNot ?? expected.must_not),
      // Default true: every fixture written before this option expects the
      // games page, and saying nothing keeps meaning that.
      expectLanding: expected.expectLanding !== false,
      // A THIRD ANSWER, because the app has three and this file only had two.
      // A paste that yields exactly ONE word cannot reach #/set/ (one card is
      // not a game) and it is not paperwork either: it lands on the edit table
      // WITH her word on it. Fixture 73 is that shape. Graded as such rather
      // than filed under expectLanding:false, which asserts an EMPTY table and
      // would have thrown away the only thing that fixture is checking.
      expectReview: expected.expectReview === true,
      broken: expected._broken || null,
    });
  }
  if (cases.length === 0) {
    return { source: 'builtin (fixture folder is empty)', cases: BUILTIN };
  }
  return { source: `tests/fixtures/teacher-pastes (${cases.length} files)`, cases };
}

const out = [];
const L = (s) => {
  console.log(s);
  out.push(s);
};

let failures = 0;
const check = (name, ok, detail) => {
  L(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) failures++;
};

/**
 * Never let an automated run make sound on the host machine, and record every
 * state the page was ever in, from before the app's own JS runs. The render log
 * is what lets a check say "the words were never there" rather than only "the
 * words are not there now".
 */
async function prepare(ctx) {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('vocab-silent', '1');
    } catch {
      /* private mode */
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = () => {};
      window.speechSynthesis.cancel = () => {};
    }
    HTMLMediaElement.prototype.play = function () {
      return Promise.resolve();
    };
  });
  await ctx.addInitScript(() => {
    window.__renders = [];
    const snap = () => {
      if (!document.body) return;
      window.__renders.push(document.body.innerText || '');
    };
    const start = () => {
      snap();
      new MutationObserver(snap).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  });
}

/** Types `text` into the home page's one box and presses Make games. */
async function paste(page, text) {
  await page.goto(`${BASE}/?silent=1#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#paste', { timeout: 10000 });
  await page.fill('#paste', text);
  await page.getByRole('button', { name: 'Make games', exact: true }).click();
}

/** Waits for the hash to start with `prefix`. Returns the hash, or null. */
async function landed(page, prefix, ms) {
  try {
    await page.waitForFunction(
      (want) => location.hash.startsWith(want),
      prefix,
      { timeout: ms, polling: 100 }
    );
  } catch {
    return null;
  }
  return page.evaluate(() => location.hash);
}

/** The set page as the teacher reads it: the count line and the word list. */
async function readSetPage(page) {
  return page.evaluate(() => {
    const subtitle = document.querySelector('.screen-head .subtitle');
    const text = document.body.innerText || '';
    const match = ((subtitle && subtitle.textContent) || text).match(/(\d+)\s+words?\b/);
    const rows = Array.from(document.querySelectorAll('.word-list .word-row')).map((row) => ({
      zh: (row.querySelector('.word-zh .zh') || {}).textContent || '',
      en: (row.querySelector('.word-en') || {}).textContent || '',
    }));
    return {
      shown: match ? Number(match[1]) : null,
      rows: rows.map((row) => ({ zh: row.zh.trim(), en: row.en.trim() })),
      body: text,
    };
  });
}

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  const { source, cases } = readFixtures();
  L(`base    ${BASE}`);
  L(`chrome  ${EXE}`);
  L(`cases   ${source}`);
  L('');

  const browser = await chromium.launch({ headless: true, executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  await prepare(ctx);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  const table = [];

  for (const fixture of cases) {
    // Only a sidecar that says so opts out; the builtin cases and every fixture
    // written before the option want the games page.
    const wantsGames = fixture.expectLanding !== false && !fixture.expectReview;
    const row = {
      name: fixture.name,
      wantsGames,
      landed: false,
      shown: null,
      expected: fixture.must.length,
      missing: [],
      forbidden: [],
      askedForEnglish: false,
      expectReview: fixture.expectReview,
      note: fixture.broken ? 'unreadable .expected.json' : '',
    };
    // A fixture that expects no game cannot also demand words on it. Caught as
    // a finding rather than graded, so a contradictory sidecar cannot pass.
    const contradictory = fixture.expectLanding === false && fixture.must.length > 0;

    try {
      await paste(page, fixture.text);
      if (wantsGames) {
        const hash = await landed(page, '#/set/', LAND_MS);
        row.landed = Boolean(hash);
        if (!hash) {
          row.note = row.note || (await page.evaluate(() => location.hash)) || 'no navigation';
        } else {
          const seen = await readSetPage(page);
          row.shown = seen.shown;
          const zh = seen.rows.map((r) => r.zh);
          const en = seen.rows.map((r) => r.en);
          const has = (word) => zh.includes(word) || en.includes(word);
          row.missing = fixture.must.filter((word) => !has(word));
          row.forbidden = fixture.mustNot.filter((word) => has(word));
        }
      } else {
        // The games page is the failure here, so what is waited for is the edit
        // table. Waiting for #/review rather than sleeping means a run that
        // DOES reach #/set/ still gets caught: the hash is read afterwards.
        const review = await landed(page, '#/review', LAND_MS);
        const hash = await page.evaluate(() => location.hash);
        row.landed = String(hash || '').startsWith('#/set/');
        row.reachedReview = Boolean(review);
        if (!row.reachedReview) row.note = row.note || hash || 'no navigation';
        // The CARDS, not the page text. This screen deliberately reads her
        // paste back to her under "This is what we read", so every mustNot
        // string is on it as prose and always will be. What must not exist is a
        // row in the edit table holding one.
        const cards = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.review-table tbody tr')).map((tr) =>
            Array.from(tr.querySelectorAll('input'))
              .map((input) => input.value || '')
              .join(' ')
          )
        );
        row.shown = cards.length;
        row.forbidden = fixture.mustNot.filter((word) =>
          cards.some((text) => text.includes(word))
        );
        // For an expectReview fixture the cards are the point, so the must list
        // is graded against them exactly as it is on the set page.
        row.missing = fixture.expectReview
          ? fixture.must.filter((word) => !cards.some((text) => text.includes(word)))
          : [];
        // Every render, not just the last: the ask is a thing that can flash up
        // while the screen settles.
        const renders = await page.evaluate(() => [
          ...(window.__renders || []),
          document.body.innerText || '',
        ]);
        row.askedForEnglish = renders.some((text) => /type the english/i.test(String(text || '')));
      }
    } catch (error) {
      row.note = `threw: ${String(error && error.message).slice(0, 80)}`;
    }

    const ok = contradictory
      ? false
      : wantsGames
        ? row.landed &&
          !fixture.broken &&
          row.shown !== null &&
          row.shown >= row.expected &&
          row.missing.length === 0 &&
          row.forbidden.length === 0
        : !row.landed &&
          !fixture.broken &&
          row.reachedReview === true &&
          (fixture.expectReview
            ? row.shown >= row.expected && row.missing.length === 0
            : row.shown === 0) &&
          row.forbidden.length === 0 &&
          !row.askedForEnglish;
    row.ok = ok;
    table.push(row);

    const detail = [
      contradictory ? 'sidecar says expectLanding false but still lists must words' : null,
      wantsGames && !row.landed ? `never reached #/set/ (${row.note || 'unknown'})` : null,
      wantsGames && row.landed && row.shown === null ? 'no word count on the page' : null,
      wantsGames && row.shown !== null && row.shown < row.expected
        ? `page says ${row.shown} words, fixture needs ${row.expected}`
        : null,
      !wantsGames && row.landed ? 'reached the games page, which this paste must not' : null,
      !wantsGames && !row.landed && !row.reachedReview
        ? `never reached the edit table (${row.note || 'unknown'})`
        : null,
      !wantsGames && fixture.expectReview && row.missing.length > 0
        ? `the edit table is missing ${row.missing.join(', ')}`
        : null,
      !wantsGames && !fixture.expectReview && row.reachedReview && row.shown > 0
        ? `the edit table holds ${row.shown} card(s) and should hold none`
        : null,
      !wantsGames && row.askedForEnglish ? 'the edit table asked her to type the English' : null,
      row.missing.length ? `missing: ${row.missing.join(', ')}` : null,
      row.forbidden.length ? `should not be there: ${row.forbidden.join(', ')}` : null,
      fixture.broken ? `bad sidecar: ${fixture.broken}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    check(`fixture ${fixture.name}`, ok, detail);
  }

  // The standing promise about the failure screen. One word can never make a
  // game (two is the floor), so this is the could-not-read path on purpose.
  {
    await paste(page, '苹果');
    const hash = await landed(page, '#/review', LAND_MS);
    check('a one-word paste lands on the edit table', Boolean(hash), hash ? '' : 'no #/review');
    if (hash) {
      const renders = await page.evaluate(() => window.__renders || []);
      const now = await page.evaluate(() => document.body.innerText || '');
      const offenders = [...renders, now].filter((text) =>
        /type the english/i.test(text || '')
      );
      check(
        'the edit table never says "type the English"',
        offenders.length === 0,
        offenders.length ? `${offenders.length} of ${renders.length + 1} renders said it` : ''
      );
    }
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await ctx.close();
  await browser.close();

  L('');
  L(`${pad('fixture', 30)}${pad('landed', 9)}${pad('found', 22)}${pad('expected', 9)}result`);
  L('-'.repeat(84));
  for (const row of table) {
    // Never say "all N found" for a page we never got to read: an unlanded
    // fixture has empty missing/forbidden lists for want of a page, not for
    // want of a problem.
    const found = !row.wantsGames
      ? row.expectReview
        ? row.missing.length === 0 && row.forbidden.length === 0
          ? `all ${row.expected}, on the table`
          : `${row.expected - row.missing.length}/${row.expected}${
              row.forbidden.length ? ` +${row.forbidden.length} bad` : ''
            }`
        : row.forbidden.length
          ? `+${row.forbidden.length} bad`
          : 'no cards, as asked'
      : !row.landed
        ? '-'
        : row.missing.length === 0 && row.forbidden.length === 0
          ? `all ${row.expected}`
          : `${row.expected - row.missing.length}/${row.expected}${
              row.forbidden.length ? ` +${row.forbidden.length} bad` : ''
            }`;
    // "landed" in this column means the games page. For a no-game fixture that
    // is the wrong outcome, so the wanted value there is "none".
    const landedCell = !row.wantsGames
      ? row.landed
        ? 'GAMES'
        : row.reachedReview
          ? row.expectReview
            ? 'table'
            : 'none'
          : 'NOWHERE'
      : row.landed
        ? 'yes'
        : 'NO';
    L(
      pad(row.name.slice(0, 29), 30) +
        pad(landedCell, 9) +
        pad(found, 22) +
        pad(row.shown === null ? '-' : `${row.shown} shown`, 9) +
        (row.ok ? 'pass' : 'FAIL')
    );
  }
  L('-'.repeat(84));
  const passed = table.filter((row) => row.ok).length;
  L(`${passed}/${table.length} fixtures pass. ${failures} check(s) failed overall.`);

  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});

