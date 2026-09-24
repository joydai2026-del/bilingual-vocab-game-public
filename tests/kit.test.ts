// The pure half of the 3D kit: easing curves, the palette, the flat-look
// switch and the instance clamp. Everything here runs in the node environment
// with no DOM and no WebGL, which is the point: a scene cannot be unit tested,
// but the numbers a scene is built from can.

import { describe, expect, it } from 'vitest';

import {
  BEAN_COLORS,
  EASINGS,
  MAX_INSTANCES,
  PALETTE,
  easeTo,
  instanceCount,
  releaseRenderer,
  restHeight,
} from '../src/client/scene/three-kit';
import { flatRequested, wantsFlat } from '../src/client/scene/webgl';

const EASE_NAMES = ['linear', 'out', 'overshoot', 'bounce'] as const;

describe('easings', () => {
  for (const name of EASE_NAMES) {
    it(`${name} starts at 0 and lands on 1`, () => {
      const f = EASINGS[name];
      expect(f(0)).toBeCloseTo(0, 10);
      expect(f(1)).toBeCloseTo(1, 10);
    });

    it(`${name} stays finite across the whole run`, () => {
      const f = EASINGS[name];
      for (let i = 0; i <= 100; i += 1) {
        expect(Number.isFinite(f(i / 100))).toBe(true);
      }
    });
  }

  it('overshoot really overshoots: it peaks above 1 before settling', () => {
    let peak = 0;
    for (let i = 0; i <= 1000; i += 1) peak = Math.max(peak, EASINGS.overshoot(i / 1000));
    expect(peak).toBeGreaterThan(1);
    // A pop, not a catapult. Past about 1.15 a bean visibly leaves its platform.
    expect(peak).toBeLessThan(1.2);
  });

  it('linear and out never leave [0, 1]', () => {
    for (const name of ['linear', 'out'] as const) {
      for (let i = 0; i <= 100; i += 1) {
        const v = EASINGS[name](i / 100);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('bounce is monotone in spirit: it never goes negative', () => {
    for (let i = 0; i <= 200; i += 1) expect(EASINGS.bounce(i / 200)).toBeGreaterThanOrEqual(0);
  });
});

describe('palette', () => {
  it('has exactly the seven contract colours', () => {
    expect(PALETTE).toEqual({
      mint: '#B7F0D3',
      butter: '#FFE8A3',
      sky: '#BFE3FF',
      coral: '#FFB3A7',
      lilac: '#D9C8FF',
      cloud: '#FFFFFF',
      ink: '#2B2D42',
    });
    expect(Object.keys(PALETTE)).toHaveLength(7);
  });

  it('every bean colour is a distinct 6-digit hex', () => {
    expect(BEAN_COLORS.length).toBeGreaterThanOrEqual(12);
    for (const c of BEAN_COLORS) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(new Set(BEAN_COLORS).size).toBe(BEAN_COLORS.length);
  });
});

describe('wantsFlat', () => {
  it('honours ?flat=1 on the page query', () => {
    expect(wantsFlat({ search: '?flat=1', hash: '#/kit-demo' })).toBe(true);
    expect(flatRequested({ search: '?flat=1', hash: '' })).toBe(true);
  });

  it('honours ?flat=1 inside the hash, which is where the router puts a query', () => {
    expect(wantsFlat({ search: '', hash: '#/play/climb/abc?flat=1' })).toBe(true);
  });

  it('reads flat=1 alongside other params', () => {
    expect(flatRequested({ search: '?silent=1&flat=1', hash: '' })).toBe(true);
    expect(flatRequested({ search: '', hash: '#/x?pace=fast&flat=1' })).toBe(true);
  });

  it('does not fire on flat=0, a bare flat, or no query at all', () => {
    expect(flatRequested({ search: '?flat=0', hash: '' })).toBe(false);
    expect(flatRequested({ search: '?flat', hash: '' })).toBe(false);
    expect(flatRequested({ search: '', hash: '#/kit-demo' })).toBe(false);
    expect(flatRequested({ search: '', hash: '' })).toBe(false);
  });

  it('with no flag and no DOM, falls back to flat because WebGL cannot be proven', () => {
    // vitest runs in the node environment here: `document` is absent, so
    // hasWebGL() is false and the twin is the honest answer.
    expect(wantsFlat({ search: '', hash: '' })).toBe(true);
  });
});

describe('instanceCount', () => {
  it('never returns more than was asked for', () => {
    for (const n of [0, 1, 2, 7, 39, 40, 1023, 1024, 1025, 1e6, 3.7, 0.9]) {
      expect(instanceCount(n)).toBeLessThanOrEqual(n);
    }
  });

  it('returns a whole non-negative count', () => {
    for (const n of [-5, -0.4, 0, 3.7, 12, 1e9, NaN, Infinity, -Infinity]) {
      const got = instanceCount(n);
      expect(Number.isInteger(got)).toBe(true);
      expect(got).toBeGreaterThanOrEqual(0);
    }
  });

  it('passes small counts through untouched and caps runaway ones', () => {
    expect(instanceCount(44)).toBe(44);
    expect(instanceCount(MAX_INSTANCES)).toBe(MAX_INSTANCES);
    expect(instanceCount(MAX_INSTANCES + 500)).toBe(MAX_INSTANCES);
    expect(instanceCount(Number.MAX_SAFE_INTEGER)).toBe(MAX_INSTANCES);
  });
});

// --- panel round 1, M4: giving the drawing context back ----------------------
//
// `renderer.dispose()` frees GPU objects but does not reliably drop the drawing
// context. Chrome keeps about sixteen of those alive and silently kills the
// oldest, so a teacher bouncing between the three games in one lesson ends up
// looking at a blank canvas. `forceContextLoss()` hands the context back on the
// way out; `releaseRenderer` is the one place that order is written down.

describe('releaseRenderer', () => {
  const fake = () => {
    const calls: string[] = [];
    return {
      calls,
      renderer: {
        forceContextLoss: () => calls.push('forceContextLoss'),
        dispose: () => calls.push('dispose'),
      },
    };
  };

  it('drops the context before freeing the objects', () => {
    const f = fake();
    releaseRenderer(f.renderer);
    expect(f.calls).toEqual(['forceContextLoss', 'dispose']);
  });

  it('still disposes when the renderer cannot lose its context', () => {
    const calls: string[] = [];
    releaseRenderer({ dispose: () => calls.push('dispose') });
    expect(calls).toEqual(['dispose']);
  });

  it('still disposes when forceContextLoss throws', () => {
    const calls: string[] = [];
    releaseRenderer({
      forceContextLoss: () => {
        throw new Error('no context');
      },
      dispose: () => calls.push('dispose'),
    });
    expect(calls).toEqual(['dispose']);
  });
});

describe('easeTo', () => {
  // 220 ms is the lane slide, 50 ms frames are a slow phone: 4 frames land at
  // 200 ms and the fifth overshoots the end.
  const MS = 220;
  const FROM = 0;
  const TO = 3.4;

  it('lands exactly on the target once the clock passes the duration', () => {
    let run = 0;
    let x = FROM;
    for (let i = 0; i < 5; i += 1) {
      run += 50;
      x = easeTo(FROM, TO, run, MS, 'overshoot');
    }
    expect(run).toBeGreaterThan(MS);
    expect(x).toBe(TO);
  });

  it('lands exactly on the target on a frame that hits the duration dead on', () => {
    expect(easeTo(FROM, TO, MS, MS, 'overshoot')).toBe(TO);
  });

  it('is still travelling before the duration is up', () => {
    const mid = easeTo(FROM, TO, 100, MS, 'overshoot');
    expect(mid).not.toBe(TO);
    expect(mid).toBeGreaterThan(FROM);
  });

  it('starts where it was told to start', () => {
    expect(easeTo(FROM, TO, 0, MS, 'overshoot')).toBeCloseTo(FROM, 10);
  });

  it('treats a zero or negative duration as already finished', () => {
    expect(easeTo(FROM, TO, 0, 0, 'overshoot')).toBe(TO);
    expect(easeTo(FROM, TO, 10, -5, 'overshoot')).toBe(TO);
  });
});

describe('restHeight', () => {
  const box = { y: 0 };
  const anchor = () =>
    restHeight(
      () => box.y,
      (y) => {
        box.y = y;
      }
    );

  it('gives every overlapping animation the SAME rest height', () => {
    box.y = 0;
    const rest = anchor();
    const hopBase = rest.enter();
    box.y = 1.5; // mid-hop, the bean is in the air
    const cheerBase = rest.enter();
    expect(hopBase).toBe(0);
    expect(cheerBase).toBe(0);
  });

  it('puts the bean back on the floor after a hop and a cheer overlap', () => {
    box.y = 0;
    const rest = anchor();
    rest.enter(); // hop starts
    box.y = 1.5;
    rest.enter(); // cheer starts while the hop is still in the air
    box.y = 0.9;
    rest.exit(); // the hop finishes first: the cheer is still running
    expect(box.y).toBe(0.9);
    box.y = 1.1;
    rest.exit(); // the cheer finishes last
    expect(box.y).toBe(0);
  });

  it('re-reads the rest height once everything has settled', () => {
    box.y = 0;
    const rest = anchor();
    rest.enter();
    rest.exit();
    box.y = 2; // the game moved the bean for its own reasons
    rest.enter();
    box.y = 3;
    rest.exit();
    expect(box.y).toBe(2);
  });

  it('puts the yaw back after two overlapping cheers', () => {
    const spin = { y: 0 };
    const rest = restHeight(
      () => spin.y,
      (y) => {
        spin.y = y;
      }
    );
    rest.enter(); // the first cheer starts at rest
    spin.y = Math.PI; // half way round
    rest.enter(); // a second cheer starts while the first is still turning
    spin.y = Math.PI * 3;
    rest.exit(); // the first cheer finishes
    expect(spin.y).toBe(Math.PI * 3);
    spin.y = Math.PI * 4;
    rest.exit(); // the last one out restores the rest yaw exactly
    expect(spin.y).toBe(0);
  });

  it('never goes negative on an unbalanced exit', () => {
    box.y = 0;
    const rest = anchor();
    rest.exit();
    box.y = 5;
    rest.enter();
    box.y = 6;
    rest.exit();
    expect(box.y).toBe(5);
  });
});

