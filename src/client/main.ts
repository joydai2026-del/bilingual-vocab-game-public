// App entry: wires the hash router to the screens and tears down the timers
// of the screen we are leaving.

import './styles.css';

import { decodeSet } from '../shared/share';
import type { VocabSet } from '../shared/types';
import { renderClimb } from './games/climb';
import { renderMemory } from './games/memory';
import { renderRace } from './games/race';
import { renderToneCatcher } from './games/tone-catcher';
import { renderSkyTower } from './games/sky-tower';
import { renderRevealRush } from './games/reveal-rush';
import { renderHost } from './host/screen';
import { renderRoom } from './room/screen';
import { startRouter, type Route } from './router';
import { renderBoardDemo } from './screens/board-demo';
import { renderHome } from './screens/home';
import { renderReview } from './screens/review';
import { renderSet } from './screens/set';
import { noteUserGesture } from './tts';
import { reloadIfStale } from './version';
import { h, notice, screen } from './ui';

type Cleanup = (() => void) | void;

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app is missing from index.html');

let cleanup: Cleanup;
let renderToken = 0;

function showMessage(title: string, message: string): void {
  const { root: page, body } = screen(title, { back: '#/' });
  body.append(notice(message, 'warn'), h('p', {}, [h('a', { href: '#/', text: 'Start again' })]));
  root!.replaceChildren(page);
}

async function withSet(
  encoded: string,
  token: number,
  render: (set: VocabSet) => Cleanup
): Promise<void> {
  let set: VocabSet;
  try {
    set = await decodeSet(encoded);
  } catch {
    if (token === renderToken) {
      showMessage('Link problem', 'This link did not open. Ask for a fresh one.');
    }
    return;
  }
  if (token !== renderToken) return;

  // A screen can still throw on a set that passed validation (an unplayable
  // combination, a browser API missing). Show the same friendly page rather
  // than leaving a blank white screen behind.
  try {
    cleanup = render(set);
  } catch {
    if (token === renderToken) {
      showMessage('Link problem', 'This link did not open. Ask for a fresh one.');
    }
  }
}

/** True when this load asked for the development pages. */
function isDevMode(current: Route): boolean {
  if (current.query.get('dev') === '1') return true;
  try {
    return new URLSearchParams(window.location.search).get('dev') === '1';
  } catch {
    return false;
  }
}

function route(current: Route): void {
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  const token = ++renderToken;

  const [first, second, third] = current.parts;

  if (!first) {
    void reloadIfStale();
    renderHome(root!);
    return;
  }

  if (first === 'review') {
    renderReview(root!);
    return;
  }

  if (first === 'set' && second) {
    void withSet(second, token, (set) => renderSet(root!, set, second));
    return;
  }

  if (first === 'play' && second && third) {
    if (second === 'memory') {
      void withSet(third, token, (set) => renderMemory(root!, set, third));
      return;
    }
    if (second === 'race') {
      void withSet(third, token, (set) => renderRace(root!, set, third));
      return;
    }
    if (second === 'climb') {
      void withSet(third, token, (set) => renderClimb(root!, set, third));
      return;
    }
    if (second === 'tone') {
      void withSet(third, token, (set) => renderToneCatcher(root!, set, third));
      return;
    }
    if (second === 'sky-tower') {
      void withSet(third, token, (set) => renderSkyTower(root!, set, third));
      return;
    }
    if (second === 'reveal') {
      void withSet(third, token, (set) => renderRevealRush(root!, set, third));
      return;
    }
  }

  // The board demo is a development page, not a route a class should be able to
  // land on, so it answers only with `?dev=1` and is a 404 otherwise (Codex
  // round 1, SHOULD-FIX 8). Either query works: `#/demo/board?dev=1` on the
  // hash, or `?dev=1` on the page URL.
  if (first === 'demo' && second === 'board' && isDevMode(current)) {
    cleanup = renderBoardDemo(root!);
    return;
  }

  // The 3D kit demo. Hidden (nothing links to it) and lazily loaded, so the
  // `three` chunk is never fetched by a class that stays on the normal screens.
  if (first === 'kit-demo') {
    let dropped = false;
    let inner: Cleanup;
    cleanup = () => {
      dropped = true;
      if (typeof inner === 'function') inner();
    };
    void import('./screens/kit-demo')
      .then(({ renderKitDemo }) => {
        if (dropped || token !== renderToken) return;
        inner = renderKitDemo(root!);
      })
      .catch(() => {
        if (dropped || token !== renderToken) return;
        showMessage('Page not found', 'That link does not point at anything here.');
      });
    return;
  }

  if (first === 'host' && second) {
    cleanup = renderHost(root!, second.toUpperCase().slice(0, 4));
    return;
  }

  if (first === 'room' && second) {
    cleanup = renderRoom(root!, second.toUpperCase().slice(0, 4));
    return;
  }

  showMessage('Page not found', 'That link does not point at anything here.');
}

document.addEventListener('pointerdown', noteUserGesture, { capture: true, passive: true });
document.addEventListener('keydown', noteUserGesture, { capture: true });

startRouter(route);

