// Home: one input box, one button. Paste a list, paste a Google Sheets link, or
// add a photo of the list on the board; pick a level, name the set. Plus a
// join-a-room box for students who were given a code out loud.

import { smartInput } from '../input/smart-box';
import type { Level } from '../../shared/types';
import { buildFromText, openGames } from '../build';
import { navigate } from '../router';
import { getDraft } from '../state';
import { h, notice, screen } from '../ui';

export function renderHome(root: HTMLElement): void {
  const previous = getDraft();
  let level: Level = previous?.level ?? 'kids';

  const { root: page, body } = screen('Vocab Games', {
    subtitle: 'Paste your words, get games to play. Pinyin and English are filled in for you.',
  });

  const input = smartInput();

  const titleInput = h('input', {
    type: 'text',
    id: 'set-title',
    placeholder: 'Unit 3 animals',
    value: previous?.title ?? '',
  });

  const kidsButton = h('button', { type: 'button', text: 'Little kids' });
  const bigButton = h('button', { type: 'button', text: 'Big kids and adults' });
  const setLevel = (next: Level): void => {
    level = next;
    kidsButton.setAttribute('aria-pressed', String(next === 'kids'));
    bigButton.setAttribute('aria-pressed', String(next === 'big'));
  };
  kidsButton.addEventListener('click', () => setLevel('kids'));
  bigButton.addEventListener('click', () => setLevel('big'));
  setLevel(level);

  const problem = h('div');

  const goButton = h('button', {
    class: 'btn btn-primary btn-big',
    type: 'button',
    text: 'Make games',
  });

  // One button for every kind of input. A Google Sheets link is fetched first,
  // a Quizlet link gets the copy-and-paste instructions and stops here, and
  // anything else goes to the extractor: same button, no format picker.
  //
  // From here it is one straight line to the games. The teacher never types a
  // word: whatever we could read plays, whatever we could not is listed on the
  // set page, and the editing table is only for when almost nothing came back.
  const makeGames = async (): Promise<void> => {
    problem.replaceChildren();

    const busy = (on: boolean): void => {
      goButton.disabled = on;
      goButton.textContent = on ? 'Making games...' : 'Make games';
    };

    busy(true);
    let resolved: Awaited<ReturnType<typeof input.resolve>>;
    try {
      resolved = await input.resolve();
    } catch {
      busy(false);
      problem.append(notice('Something went wrong reading that. Please try again.', 'error'));
      return;
    }
    if (!resolved.ok) {
      busy(false);
      return;
    }

    if (!resolved.text.trim()) {
      busy(false);
      problem.append(
        notice('Paste your words in the box first, or add a photo of the list.', 'warn')
      );
      input.box.focus();
      return;
    }

    try {
      const outcome = await buildFromText({
        text: resolved.text,
        items: resolved.items,
        notes: resolved.notes,
        title: titleInput.value,
        level,
      });
      await openGames(outcome);
    } catch {
      problem.append(notice('Could not build the game link. Please try again.', 'error'));
    } finally {
      busy(false);
    }
  };

  goButton.addEventListener('click', () => {
    void makeGames();
  });

  const codeInput = h('input', {
    type: 'text',
    id: 'room-code',
    placeholder: 'ABCD',
    maxlength: '4',
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  const joinButton = h('button', { class: 'btn', type: 'button', text: 'Join' });
  const joinProblem = h('div');
  const join = (): void => {
    joinProblem.replaceChildren();
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
      joinProblem.append(notice('A room code is 4 letters, like WXYZ.', 'warn'));
      return;
    }
    navigate(`#/room/${code}`);
  };
  joinButton.addEventListener('click', join);
  codeInput.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') join();
  });

  body.append(
    input.el,
    h('div', { class: 'field' }, [
      h('label', { for: 'set-title', text: 'Name this set' }),
      titleInput,
    ]),
    h('div', { class: 'field' }, [
      h('label', { text: 'Who is playing?' }),
      h('div', { class: 'segmented' }, [kidsButton, bigButton]),
    ]),
    problem,
    goButton,
    h('div', { class: 'panel', style: 'margin-top:32px' }, [
      h('h2', { text: 'Join a room' }),
      h('p', { class: 'hint', text: 'Got a 4-letter code from your teacher? Type it here.' }),
      h('div', { class: 'row' }, [
        h('div', { style: 'flex:1 1 180px' }, [codeInput]),
        joinButton,
      ]),
      joinProblem,
    ])
  );

  root.replaceChildren(page);
  if (previous) {
    // Coming back: put back exactly what was pasted when we still have it, so
    // a teacher who is fixing a typo is not handed a table she never typed.
    input.setValue(
      previous.pasted ??
        previous.items
          .map((item) => [item.zh, item.pinyin, item.en].filter(Boolean).join('\t'))
          .join('\n')
    );
  }
}

