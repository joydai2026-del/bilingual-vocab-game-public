// The speaker button, used everywhere a Chinese word appears.

import { h } from './ui';
import { hasRealMandarinVoice, preferServerVoice, setPreferServerVoice, speak, watchVoices } from './tts';

export function speakerButton(
  getZh: () => string,
  opts: { class?: string; label?: string } = {}
): HTMLButtonElement {
  const button = h('button', {
    class: `speaker ${opts.class ?? ''}`.trim(),
    type: 'button',
    'aria-label': opts.label ?? 'Hear this word',
    title: opts.label ?? 'Hear this word',
    text: '🔊',
  });

  const restingTitle = opts.label ?? 'Hear this word';

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    button.classList.add('speaking');
    window.setTimeout(() => button.classList.remove('speaking'), 600);
    void speak(getZh()).then(
      () => {
        // A tap that worked clears whatever the last failure left behind.
        button.classList.remove('speaker-failed');
        button.title = restingTitle;
      },
      (error: Error) => {
        button.classList.add('speaker-failed');
        button.title = error.message;
        // Put the button back the way it was so the next tap tries again: a
        // blocked clip or a dropped connection is usually gone by then.
        window.setTimeout(() => {
          button.classList.remove('speaker-failed');
          button.title = restingTitle;
        }, 1500);
      }
    );
  });

  return button;
}

/**
 * "Better voice": send words to the server even though this device can read
 * Chinese itself. Persisted in localStorage, same as the pinyin toggle, and
 * built from the same `segmented` markup so it drops in beside it with no CSS.
 *
 * It hides itself on a device with no real Mandarin voice, because there the
 * server is already doing the reading and the toggle would do nothing.
 *
 * NOT WIRED IN YET: `src/client/screens/set.ts` is owned elsewhere this
 * session. To place it, add `betterVoiceToggle(paintWords)` next to
 * `pinyinToggle(paintWords)` in the `row` div of the set page.
 */
export function betterVoiceToggle(onChange: (on: boolean) => void = () => {}): HTMLElement {
  const on = h('button', { type: 'button', text: 'Better voice' });
  const off = h('button', { type: 'button', text: 'Device voice' });
  const group = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Voice' }, [on, off]);

  const paint = (): void => {
    on.setAttribute('aria-pressed', String(preferServerVoice()));
    off.setAttribute('aria-pressed', String(!preferServerVoice()));
    // Voice lists load asynchronously, so this is re-run from watchVoices too.
    group.hidden = !hasRealMandarinVoice();
  };
  const set = (next: boolean): void => {
    setPreferServerVoice(next);
    paint();
    onChange(next);
  };

  on.addEventListener('click', () => set(true));
  off.addEventListener('click', () => set(false));
  paint();
  watchVoices(paint);

  return group;
}

