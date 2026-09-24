// The render gate for the cute 3D kit.
//
// A green build and a canvas element prove nothing: a blank canvas passes both.
// This harness opens the hidden #/kit-demo page in headless Chromium with
// SwiftShader, reads the pixels back, and fails unless the picture actually has
// content in it. It then does the same for the CSS twin at ?flat=1, and again
// at phone size.
//
// Silence: `?silent=1` plus an init script that stubs speechSynthesis and
// media playback, exactly like verify-onboarding.cjs. Nothing here makes sound.
//
// Run:
//   npm run cf:dev -- --port 8801        # in another shell
//   NODE_PATH=/path/to/node_modules \
//     node tests/e2e/verify-kit-demo.cjs
//
// Env: BVG_BASE (default http://localhost:8801), BVG_CHROME, BVG_SHOTS.

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

const BASE = process.env.BVG_BASE || 'http://localhost:8801';
const SHOTS = process.env.BVG_SHOTS || path.join(__dirname, '..', '..', 'scratch', 'kit');

/** Software GL: a headless machine has no GPU, so SwiftShader is the renderer. */
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

async function silence(ctx) {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('vocab-silent', '1');
    } catch {
      /* private mode */
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = () => {};
      window.speechSynthesis.cancel = () => {};
      window.speechSynthesis.getVoices = () => [];
    }
    HTMLMediaElement.prototype.play = function () {
      return Promise.resolve();
    };
    window.__spoke = 0;
  });
}

/**
 * Variance across sampled pixels, read through the demo page's `__kitPixels`
 * hook so the draw and the readback happen in the SAME task. Reading from the
 * outside always returns zeros: the browser wipes a WebGL drawing buffer when
 * it composites, and this canvas does not pay for `preserveDrawingBuffer`.
 *
 * A blank or single-colour canvas scores variance 0, which is the failure this
 * whole harness exists to catch.
 */
async function canvasVariance(page, samples) {
  return page.evaluate((want) => {
    if (!document.querySelector('canvas')) return { ok: false, why: 'no canvas element' };
    const read = window.__kitPixels;
    if (typeof read !== 'function') return { ok: false, why: '__kitPixels hook missing' };
    const out = read(want);
    if (!out || !out.lum || !out.lum.length) return { ok: false, why: 'hook returned nothing' };
    const lum = out.lum;
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const variance = lum.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lum.length;
    return { ok: true, sampled: lum.length, mean, variance, drawn: out.drawn, w: out.w, h: out.h };
  }, samples);
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: GL_ARGS });
  const results = [];
  let bad = 0;

  const cases = [
    { name: '3d-1280x800', url: `${BASE}/?silent=1#/kit-demo`, size: { width: 1280, height: 800 }, gl: true },
    {
      name: 'flat-1280x800',
      url: `${BASE}/?silent=1&flat=1#/kit-demo`,
      size: { width: 1280, height: 800 },
      gl: false,
    },
    { name: '3d-390x844', url: `${BASE}/?silent=1#/kit-demo`, size: { width: 390, height: 844 }, gl: true },
    {
      name: 'flat-390x844',
      url: `${BASE}/?silent=1&flat=1#/kit-demo`,
      size: { width: 390, height: 844 },
      gl: false,
    },
  ];

  for (const c of cases) {
    const ctx = await browser.newContext({ viewport: c.size, deviceScaleFactor: 1 });
    await silence(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(c.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const title = await page.textContent('.kit-title').catch(() => null);
    const labels = await page.$$eval('.kit-label', (n) => n.map((e) => e.textContent));
    const mode = await page.textContent('.kit-mode').catch(() => null);
    const spoke = await page.evaluate(() => window.__spoke || 0);
    const flatBeans = await page.$$eval('.kit-flat-bean', (n) => n.length);
    const pixels = c.gl ? await canvasVariance(page, 240) : null;

    const shot = path.join(SHOTS, `${c.name}.png`);
    await page.screenshot({ path: shot });

    const row = {
      case: c.name,
      title: (title || '').trim(),
      labels,
      mode: (mode || '').trim(),
      flatBeans,
      spoke,
      errors,
      pixels,
      shot,
    };

    const problems = [];
    if (!row.title.includes('云端大冒险')) problems.push('title missing');
    if (errors.length) problems.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);
    if (spoke !== 0) problems.push('something tried to speak');
    if (c.gl) {
      if (!pixels || !pixels.ok) problems.push(`canvas unreadable: ${pixels && pixels.why}`);
      else {
        if (pixels.sampled < 200) problems.push(`only ${pixels.sampled} pixels sampled, wanted 200+`);
        if (!(pixels.variance > 1)) problems.push(`flat canvas: variance ${pixels.variance}`);
        if (pixels.drawn < pixels.sampled * 0.05) problems.push(`almost nothing drawn: ${pixels.drawn}`);
      }
    } else if (flatBeans !== 8) {
      problems.push(`flat twin drew ${flatBeans} beans, wanted 8`);
    }

    row.problems = problems;
    if (problems.length) bad += 1;
    results.push(row);
    await ctx.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  console.log(bad === 0 ? '\nRENDER GATE: PASS' : `\nRENDER GATE: FAIL (${bad} case(s))`);
  process.exit(bad === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

