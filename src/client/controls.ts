// Controls shared by the set page and every game: the pinyin toggle and the
// one-line audio status.

import { audioStatusText, watchVoices } from './tts';
import { pinyinOn, setPinyinOn } from './state';
import { h } from './ui';

/** Two-state toggle for "show pinyin under Chinese". Persisted for next time. */
export function pinyinToggle(onChange: (on: boolean) => void): HTMLElement {
  const on = h('button', { type: 'button', text: 'Pinyin on' });
  const off = h('button', { type: 'button', text: 'Pinyin off' });

  const paint = (): void => {
    on.setAttribute('aria-pressed', String(pinyinOn()));
    off.setAttribute('aria-pressed', String(!pinyinOn()));
  };
  const set = (next: boolean): void => {
    setPinyinOn(next);
    paint();
    onChange(next);
  };
  on.addEventListener('click', () => set(true));
  off.addEventListener('click', () => set(false));
  paint();

  return h('div', { class: 'segmented', role: 'group', 'aria-label': 'Pinyin' }, [on, off]);
}

/** Live "where audio comes from" line; updates once voices finish loading. */
export function audioStatusLine(): HTMLElement {
  const line = h('p', { class: 'hint', text: audioStatusText() });
  watchVoices(() => {
    line.textContent = audioStatusText();
  });
  return line;
}

/** Adds the level class to <body> so CSS can scale type for little kids. */
export function applyLevel(level: 'kids' | 'big'): void {
  document.body.classList.toggle('level-kids', level === 'kids');
  document.body.classList.toggle('level-big', level === 'big');
}

