// Panel round 1, M3: silent mode has to reach the WebAudio blips too.
//
// `speak()` honoured `?silent=1` from the first day. `feedback.ts` did not: its
// correct / wrong / win chimes opened an AudioContext and played oscillators
// whatever the URL said, so an automated run on a real machine beeped through
// the owner's speakers on every answer. That is the 2026-09-08 incident one
// layer down, and this file is the measurement that stops it coming back.
//
// The gate is a COUNTING stub, not a deleted constructor: the count is what
// turns "no sound" from a hope into a number.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStore {
  [key: string]: string;
}

let constructions = 0;
let started = 0;
let store: FakeStore = {};

/** Enough AudioContext for feedback.ts to run all the way through. */
function CountingAudioContext(this: unknown): unknown {
  constructions += 1;
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
        started += 1;
      },
      stop() {},
    }),
    createGain: () => ({
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: () => ({ connect() {} }),
    }),
  };
}

function installFakeBrowser(search: string): void {
  store = {};
  const localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.location = { search, hash: '' };
  g.localStorage = localStorage;
  g.window = { AudioContext: CountingAudioContext, location: g.location, localStorage };
}

/** feedback.ts caches its context in a module-level binding, so reload it. */
async function freshFeedback(): Promise<typeof import('../src/client/feedback')> {
  vi.resetModules();
  return import('../src/client/feedback');
}

beforeEach(() => {
  constructions = 0;
  started = 0;
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.location;
  delete g.localStorage;
  delete g.window;
});

describe('the answer chimes obey silent mode', () => {
  it('opens no AudioContext and starts no oscillator with ?silent=1', async () => {
    installFakeBrowser('?silent=1');
    const feedback = await freshFeedback();
    feedback.correctSound();
    feedback.wrongSound();
    feedback.winSound();
    feedback.flipSound();
    expect(constructions).toBe(0);
    expect(started).toBe(0);
  });

  it('honours the remembered localStorage flag with no query string', async () => {
    installFakeBrowser('');
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem('vocab-silent', '1');
    const feedback = await freshFeedback();
    feedback.correctSound();
    expect(constructions).toBe(0);
  });

  it('still makes a sound for a real child with silent mode off', async () => {
    installFakeBrowser('');
    const feedback = await freshFeedback();
    feedback.correctSound();
    expect(constructions).toBe(1);
    expect(started).toBeGreaterThan(0);
  });
});

