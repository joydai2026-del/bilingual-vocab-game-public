// Instant feedback: short WebAudio tones (no audio files, nothing to
// download) plus the green-pulse / shake / emoji-burst reactions.
//
// The AudioContext is created lazily on the first tap, so nothing ever tries
// to make a sound before a user gesture.

import type { Level } from '../shared/types';
import { silentMode } from './tts';

let audioCtx: AudioContext | null = null;

/**
 * The one gate every sound in this file passes through.
 *
 * `speak()` has honoured silent mode since the day it was written; these blips
 * did not, so an automated run with `?silent=1` still beeped through the
 * machine's speakers on every single answer. One guard, at the only place a
 * sound can start, so a new chime cannot be added around it.
 */
function context(): AudioContext | null {
  if (silentMode()) return null;
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Plays a short note sequence. Each note is [frequency Hz, seconds]. */
function play(notes: [number, number][], type: OscillatorType = 'sine', peak = 0.16): void {
  const ctx = context();
  if (!ctx) return;

  let at = ctx.currentTime;
  for (const [frequency, seconds] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + seconds + 0.02);
    at += seconds;
  }
}

export function correctSound(): void {
  play(
    [
      [660, 0.09],
      [880, 0.14],
    ],
    'sine',
    0.18
  );
}

export function wrongSound(): void {
  play([[196, 0.16]], 'triangle', 0.1);
}

export function winSound(): void {
  play(
    [
      [523, 0.11],
      [659, 0.11],
      [784, 0.11],
      [1047, 0.22],
    ],
    'sine',
    0.18
  );
}

export function flipSound(): void {
  play([[440, 0.05]], 'sine', 0.07);
}

function restart(node: HTMLElement, className: string, ms: number): void {
  node.classList.remove(className);
  void node.offsetWidth; // force reflow so the animation can replay
  node.classList.add(className);
  window.setTimeout(() => node.classList.remove(className), ms);
}

/** Green pulse: the "yes, that was right" reaction. */
export function pulse(node: HTMLElement): void {
  restart(node, 'is-correct', 700);
}

/** Gentle shake: wrong, try the next one. Never harsh, never red-screen. */
export function shake(node: HTMLElement): void {
  restart(node, 'is-wrong', 500);
}

const KID_EMOJI = ['🎉', '⭐️', '🌟', '🎈', '🥳', '🍭', '🐼', '🌈'];

/**
 * Win celebration. Little kids get an emoji burst; big kids and adults get a
 * plain "Great job" line, per the plan's level rules.
 */
export function celebrate(host: HTMLElement, level: Level): HTMLElement {
  winSound();

  if (level !== 'kids') {
    return document.createElement('div');
  }

  const burst = document.createElement('div');
  burst.className = 'burst';
  burst.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 14; i++) {
    const piece = document.createElement('span');
    piece.textContent = KID_EMOJI[i % KID_EMOJI.length];
    piece.style.setProperty('--x', `${Math.round(Math.random() * 200 - 100)}%`);
    piece.style.setProperty('--r', `${Math.round(Math.random() * 120 - 60)}deg`);
    piece.style.setProperty('--d', `${Math.round(Math.random() * 260)}ms`);
    burst.append(piece);
  }
  host.append(burst);
  window.setTimeout(() => burst.remove(), 2600);
  return burst;
}

