// The question card used by both the solo Race Quiz and the head-to-head
// room, so a race looks the same whoever you are playing against.

import type { QuizQuestion, VocabItem } from '../../shared/types';
import { correctSound, pulse, shake, wrongSound } from '../feedback';
import { toPinyin } from '../pinyin';
import { pinyinOn } from '../state';
import { audioSource, hasUserGesture, speak } from '../tts';
import { speakerButton } from '../speaker';
import { h } from '../ui';

/**
 * What the card needs to draw a question. The head-to-head room gets its
 * questions from the server, which strips `answer` so nobody can read the
 * right choice out of the network tab, so the card never relies on it. It also
 * strips `itemId`, because an id plus a word list is the answer key written
 * twice, so the card must not rely on that either: the prompt's reading comes
 * on the question as `promptPinyin` instead (Codex round 1, MUST-FIX 1).
 */
export type QuizPrompt = Omit<QuizQuestion, 'answer' | 'itemId'> & {
  answer?: number;
  itemId?: string;
  promptPinyin?: string;
};

/** True for a label with any Han character in it, which is what has a reading. */
function hasHan(label: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(label);
}

/**
 * The word list, when there is one. Solo play holds the whole set; a class
 * room does not get one at all, so `items` is optional and the readings come
 * from the question and from pinyin-pro instead.
 */
export interface QuizWords {
  items?: VocabItem[];
}

export interface QuizView {
  node: HTMLElement;
  show(question: QuizPrompt, position: { n: number; total: number }): void;
  setProgress(fraction: number): void;
  /**
   * Paints the right answer green and a wrong pick red, then locks. Pass
   * `null` for the answer when it is not known (the room only learns it from
   * the server's reply): the card then locks without claiming anything.
   */
  reveal(answer: number | null, chosen: number | null): void;
  /** Locks the card and shows which choice was tapped, before any verdict. */
  markChoice(chosen: number): void;
  lock(): void;
}

export function createQuizView(
  set: QuizWords,
  onChoose: (choiceIndex: number) => void
): QuizView {
  const byZh = new Map((set.items ?? []).map((item) => [item.zh, item]));

  const timerFill = h('div', { class: 'timer-fill' });
  const promptBox = h('div', { class: 'quiz-prompt' });
  const choicesBox = h('div', { class: 'choices' });
  const node = h('div', {}, [
    h('div', { class: 'timer-bar' }, [timerFill]),
    promptBox,
    choicesBox,
  ]);

  let locked = true;
  let buttons: HTMLButtonElement[] = [];

  /**
   * The reading to print under a Chinese label. The teacher's own pinyin wins
   * wherever this device has it (solo play, and the prompt of a room question,
   * which the server sends with the question). A class room's choices arrive
   * with no word list behind them, so their reading is filled in locally by
   * pinyin-pro rather than dropped.
   */
  const readingFor = (label: string, given?: string): string | null => {
    if (!pinyinOn()) return null;
    const curated = given?.trim() || byZh.get(label)?.pinyin?.trim();
    if (curated) return curated;
    if (!hasHan(label)) return null;
    return toPinyin(label) || null;
  };

  const show = (question: QuizPrompt, position: { n: number; total: number }): void => {
    locked = false;
    const zhPrompt = question.dir === 'zh2en';
    const promptPinyin = zhPrompt
      ? readingFor(question.prompt, question.promptPinyin)
      : null;

    promptBox.replaceChildren(
      h('p', { class: 'dir', text: `Question ${position.n} of ${position.total}` }),
      h('div', { class: 'row', style: 'justify-content:center' }, [
        h('div', {}, [
          h('div', { class: 'big', text: question.prompt }),
          promptPinyin ? h('span', { class: 'py', text: promptPinyin }) : null,
        ]),
        zhPrompt ? speakerButton(() => question.prompt) : null,
      ]),
      h('p', {
        class: 'dir',
        text: zhPrompt ? 'What does it mean?' : 'Which word is it?',
      })
    );

    buttons = question.choices.map((choice, index) => {
      const py = question.dir === 'en2zh' ? readingFor(choice) : null;
      const button = h('button', { class: 'choice', type: 'button' });
      button.append(
        h('span', {}, [h('span', { text: choice }), py ? h('span', { class: 'py', text: py }) : null])
      );
      button.addEventListener('click', () => {
        if (locked) return;
        locked = true;
        onChoose(index);
      });
      return button;
    });
    choicesBox.replaceChildren(...buttons);

    // The Chinese side is read aloud as soon as it is shown, but only from the
    // device's own voice. `show()` runs from a timer in the head-to-head room,
    // and iOS blocks an <audio> clip started off a tap, so server audio waits
    // for the speaker button instead of being refused mid-race.
    if (zhPrompt && hasUserGesture() && audioSource() === 'device') {
      void speak(question.prompt).catch(() => undefined);
    }
  };

  const setProgress = (fraction: number): void => {
    const clamped = Math.max(0, Math.min(1, fraction));
    timerFill.style.width = `${(clamped * 100).toFixed(1)}%`;
    timerFill.classList.toggle('low', clamped < 0.25);
  };

  const reveal = (answer: number | null, chosen: number | null): void => {
    locked = true;
    for (const button of buttons) button.disabled = true;

    // Nothing to reveal: the answer never reached us, so the card locks with
    // the question unmarked rather than guessing at green and red.
    if (answer === null) {
      if (chosen !== null && buttons[chosen]) buttons[chosen].classList.add('picked');
      return;
    }

    buttons.forEach((button, index) => {
      // The waiting-for-the-server colour comes off everywhere: it is defined
      // after .right in the stylesheet, so leaving it on the correct choice
      // would paint a right answer blue instead of green.
      button.classList.remove('picked');
      if (index === answer) button.classList.add('right');
      if (chosen !== null && index === chosen && chosen !== answer) {
        button.classList.add('chosen-wrong');
      }
    });
    if (chosen === answer) {
      correctSound();
      if (buttons[answer]) pulse(buttons[answer]);
    } else {
      wrongSound();
      if (chosen !== null && buttons[chosen]) shake(buttons[chosen]);
    }
  };

  // The gap between a tap and the server's verdict is a real wait on a phone.
  // The card shows the tap landed straight away, and colours it later.
  const markChoice = (chosen: number): void => {
    locked = true;
    for (const button of buttons) button.disabled = true;
    if (buttons[chosen]) buttons[chosen].classList.add('picked');
  };

  const lock = (): void => {
    locked = true;
    for (const button of buttons) button.disabled = true;
  };

  return { node, show, setProgress, reveal, markChoice, lock };
}

