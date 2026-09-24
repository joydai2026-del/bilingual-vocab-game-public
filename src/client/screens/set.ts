// The set page: the game cards, share links, pinyin toggle, audio status.
// This is where a shared `#/set/<enc>` link lands.

import type { VocabSet } from '../../shared/types';
import { applyLevel, audioStatusLine, pinyinToggle } from '../controls';
import { createTeacherRoom } from '../room/api';
import { writeHostKey } from '../room/session';
import { betterVoiceToggle } from '../speaker';
import { climbDisabledReason } from '../games/climb';
import { toneCatcherDisabledReason } from '../games/tone-catcher';
import { raceDisabledReason } from '../games/race';
import { skyTowerDisabledReason } from '../games/sky-tower';
import { revealDisabledReason } from '../games/reveal-rush';
import { navigate } from '../router';
import { speakerButton } from '../speaker';
import { toPinyin } from '../pinyin';
import { getSetNote, itemId, pinyinOn, setDraft } from '../state';
import { absoluteUrl, copyButton, h, notice, screen } from '../ui';

interface CardSpec {
  title: string;
  why: string;
  actions: { label: string; hash: string; primary?: boolean }[];
  disabledReason?: string;
}

export function renderSet(root: HTMLElement, set: VocabSet, encoded: string): void {
  applyLevel(set.level);

  const { root: page, body } = screen(set.title, {
    back: '#/',
    subtitle: `${set.items.length} ${set.items.length === 1 ? 'word' : 'words'} · ${
      set.level === 'kids' ? 'Little kids' : 'Big kids and adults'
    }`,
  });

  const specs: CardSpec[] = [
    {
      title: 'Memory Match',
      why: 'Turn over two cards and find the Chinese word with its meaning.',
      actions: [{ label: 'Play', hash: `#/play/memory/${encoded}`, primary: true }],
    },
    {
      title: 'Cloud Climb',
      why: 'Hop up the cloud tower. Every right answer is one cloud higher, against three beans.',
      actions: [{ label: 'Play', hash: `#/play/climb/${encoded}`, primary: true }],
      disabledReason: climbDisabledReason(set),
    },
    {
      title: 'Tone Catcher',
      why: 'Hear a word, run into the lane that matches. Tones, at speed.',
      actions: [{ label: 'Play', hash: `#/play/tone/${encoded}`, primary: true }],
      disabledReason: toneCatcherDisabledReason(set),
    },
    {
      title: 'Race Quiz',
      why: 'Four choices, a timer, and a score. Play alone or race a friend.',
      actions: [{ label: 'Play', hash: `#/play/race/${encoded}`, primary: true }],
      disabledReason: raceDisabledReason(set),
    },
    {
      title: 'Sky Tower',
      why: 'Every right answer drops a block. Build to the clouds before the three minutes run out.',
      actions: [{ label: 'Play', hash: `#/play/sky-tower/${encoded}`, primary: true }],
      disabledReason: skyTowerDisabledReason(set),
    },
    {
      title: 'Reveal Rush',
      why: 'A giant character hides behind twelve tiles. Answer to knock them off, then read it before they all go.',
      actions: [{ label: 'Play', hash: `#/play/reveal/${encoded}`, primary: true }],
      disabledReason: revealDisabledReason(set),
    },
  ];

  const cards = specs.map((spec) => {
    const buttons = spec.actions.map((action) => {
      const button = h('button', {
        class: `btn ${action.primary ? 'btn-primary' : ''}`.trim(),
        type: 'button',
        text: action.label,
        disabled: Boolean(spec.disabledReason),
      });
      button.addEventListener('click', () => navigate(action.hash));
      return button;
    });

    const links = spec.actions.map((action) =>
      copyButton(
        spec.actions.length > 1 ? `Copy ${action.label.toLowerCase()} link` : 'Copy link',
        () => absoluteUrl(action.hash)
      )
    );
    if (spec.disabledReason) {
      for (const link of links) link.disabled = true;
    }

    return h('section', { class: `game-card ${spec.disabledReason ? 'disabled' : ''}`.trim() }, [
      h('h2', { text: spec.title }),
      h('p', { class: 'why', text: spec.why }),
      spec.disabledReason ? notice(spec.disabledReason, 'warn') : null,
      h('div', { class: 'row' }, buttons),
      h('div', { class: 'row' }, links),
    ]);
  });

  // The whole class, on one code, with no accounts. The host key comes back
  // once and is kept on this device only, so this is the teacher's screen for
  // as long as the room lives.
  const classTrouble = h('div');
  const classButton = h('button', {
    class: 'btn btn-primary btn-big',
    type: 'button',
    text: 'Start a class room',
  });
  classButton.addEventListener('click', () => {
    classButton.disabled = true;
    classButton.textContent = 'Opening the room...';
    classTrouble.replaceChildren();
    void createTeacherRoom(set)
      .then(({ code, hostKey, createdAt }) => {
        writeHostKey(code, hostKey, createdAt);
        navigate(`#/host/${code}`);
      })
      .catch((error: Error) => {
        classButton.disabled = false;
        classButton.textContent = 'Start a class room';
        classTrouble.replaceChildren(notice(error.message, 'error'));
      });
  });

  // What we just did with the teacher's text, said once, in one line. Words we
  // could not find an English meaning for are named here rather than silently
  // dropped, and every route out of this notice is the same edit table.
  const note = getSetNote(encoded);

  const editWords = (): void => {
    // Bring the left-out words along, so the edit table is the place to fix
    // them rather than a dead end that has forgotten they existed.
    const extra = (note?.dropped ?? [])
      .filter((zh) => zh && !set.items.some((item) => item.zh === zh))
      .map((zh, index) => ({
        id: itemId(set.items.length + index),
        zh,
        pinyin: toPinyin(zh),
        en: '',
      }));
    setDraft({
      title: set.title,
      level: set.level,
      items: [...set.items, ...extra],
      skipped: [],
      // THE NOTICES COME WITH THE WORDS. Rebuilding the draft empty here threw
      // away the duplicate and second-meaning notices before the teacher ever
      // saw them, which is the one screen that shows them (round 6 fix list,
      // item 2).
      notes: note?.notes ?? [],
    });
    navigate('#/review');
  };

  const editLink = (label: string): HTMLButtonElement => {
    const button = h('button', { class: 'btn btn-ghost btn-inline', type: 'button', text: label });
    button.addEventListener('click', editWords);
    return button;
  };

  const foundNotice: HTMLElement | null = note
    ? h('div', { class: 'notice notice-info found-notice', role: 'status' }, [
        h('p', {}, [
          `We found ${note.found} ${note.found === 1 ? 'word' : 'words'} in your text. Not right? `,
          editLink('Edit words'),
        ]),
        note.dropped.length > 0
          ? h('p', {}, [
              `Could not find: ${note.dropped.slice(0, 8).join(', ')}${
                note.dropped.length > 8 ? ' ...' : ''
              }. `,
              editLink('Edit'),
            ])
          : null,
      ])
    : null;

  // ONE LINE, SO A TEACHER WHO NEVER OPENS THE EDIT TABLE STILL KNOWS. A
  // successful import goes straight past the review screen, and that screen is
  // where the notices live (round 6 fix list, item 8).
  const noteCount = note?.notes.length ?? 0;
  const notesNotice: HTMLElement | null =
    noteCount > 0
      ? h('div', { class: 'notice notice-info', role: 'status' }, [
          h('p', {}, [
            `${noteCount} ${noteCount === 1 ? 'note' : 'notes'} about your words. `,
            editLink('Edit words'),
            ' to see them.',
          ]),
        ])
      : null;

  const editButton = h('button', { class: 'btn', type: 'button', text: 'Edit these words' });
  editButton.addEventListener('click', editWords);

  // The words themselves, so the pinyin toggle and the speaker are usable on
  // the page a shared `#/set/<enc>` link actually lands on.
  const wordList = h('ul', { class: 'word-list' });
  const paintWords = (): void => {
    wordList.replaceChildren(
      ...set.items.map((item) =>
        h('li', { class: 'word-row' }, [
          h('div', { class: 'word-zh' }, [
            h('span', { class: 'zh', text: item.zh }),
            pinyinOn() && item.pinyin ? h('span', { class: 'py', text: item.pinyin }) : null,
          ]),
          h('div', { class: 'word-en', text: item.en }),
          speakerButton(() => item.zh, { label: `Hear ${item.zh}` }),
        ])
      )
    );
  };
  paintWords();

  if (foundNotice) body.append(foundNotice);
  if (notesNotice) body.append(notesNotice);

  body.append(
    h('div', { class: 'panel' }, [
      h('div', { class: 'row' }, [
        pinyinToggle(paintWords),
        betterVoiceToggle(() => paintWords()),
        copyButton('Copy set link', () => absoluteUrl(`#/set/${encoded}`)),
        editButton,
      ]),
      audioStatusLine(),
    ]),
    h('section', { class: 'class-panel' }, [
      h('h2', { text: 'Play with the whole class' }),
      h('p', {
        class: 'why',
        text:
          'One code on the projector. Everyone joins by name, you pick the game, ' +
          'and the board shows the whole class at once.',
      }),
      h('div', { class: 'row' }, [classButton]),
      classTrouble,
    ]),
    h('h2', { text: 'Or play on one device' }),
    h('div', { class: 'game-cards' }, cards),
    h('section', { class: 'word-panel' }, [
      h('h2', { text: 'The words' }),
      h('p', { class: 'hint', text: 'Tap the speaker to hear a word. The toggle above shows or hides pinyin.' }),
      wordList,
    ])
  );

  root.replaceChildren(page);
}

