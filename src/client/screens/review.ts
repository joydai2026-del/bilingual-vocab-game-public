// Edit words. Two jobs, one screen.
//
//   - Normally this is the Edit link from the set page: the teacher fixes a
//     reading or a meaning she disagrees with, and goes back to the games.
//   - When almost nothing could be read out of what she pasted, this is where
//     she lands instead. Then the screen leads with what we actually read and
//     two ways out (a photo, or paste something else). It never asks her to
//     type the English for each word: that was the failure we set out to end.
//
// Either way a word with no English meaning simply sits the games out.

import { encodeSet } from '../../shared/share';
import { linkTooLong } from '../../shared/share';
import type { VocabItem } from '../../shared/types';
import { MIN_WORDS, buildFromText, openGames } from '../build';
import { fillMissingGlosses } from '../enrich';
import { readPhoto } from '../input/remote';
import { needsPinyinCheck, toPinyin } from '../pinyin';
import { navigate } from '../router';
import { speakerButton } from '../speaker';
import {
  draftToSet,
  getDraft,
  itemId,
  persistedDraft,
  setDraft,
  setSetNote,
  wordList,
} from '../state';
import { h, notice, screen } from '../ui';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

/** A short, honest look at what we were given, for the could-not-read screen. */
function pastedPreview(text: string): string {
  const tidy = text.replace(/\s+/g, ' ').trim();
  if (!tidy) return '(nothing)';
  return tidy.length > 160 ? `${tidy.slice(0, 160)}...` : tidy;
}

export function renderReview(root: HTMLElement): void {
  const draft = getDraft();
  if (!draft) {
    navigate('#/');
    return;
  }

  const items = draft.items.slice();

  // THE NOTICES DESCRIBE THE LIST THEY CAME FROM. `词语零 appears twice` and
  // `second meaning not used` are about the words as they were read; once she
  // has changed a word, dropped one or added one, the notices are about a list
  // that no longer exists and followed her set around for ever (round 7 fix
  // list, item 6). The rule lives in `persistedDraft` so the draft and the set
  // note cannot answer it differently (round 8 fix list, item 2).
  const openedWith = wordList(items);

  // "We could not read this" mode: the teacher was sent here because the words
  // did not come out, not because she asked to edit anything.
  const couldNotRead =
    typeof draft.pasted === 'string' &&
    items.filter((item) => item.zh.trim() && item.en.trim()).length < MIN_WORDS;

  const { root: page, body } = screen(couldNotRead ? 'We could not read that' : draft.title, {
    back: '#/',
    subtitle: couldNotRead
      ? 'Try a photo of the list, or paste something else. You can also fix the words by hand below.'
      : 'Change anything you like, then make the games again.',
  });

  const status = h('div', { class: 'field' });
  const tbody = h('tbody');
  const blanks = h('p', { class: 'blank-count' });
  const problem = h('div');

  const persist = (): void => {
    setDraft(persistedDraft(draft, items, openedWith));
  };

  const refreshBlanks = (): void => {
    const emptyEn = items.filter((item) => item.zh.trim() && !item.en.trim()).length;
    const parts: string[] = [
      `${items.length} ${items.length === 1 ? 'word' : 'words'} here.`,
    ];
    if (emptyEn > 0) {
      parts.push(
        `${emptyEn} ${emptyEn === 1 ? 'has' : 'have'} no meaning yet, so ${
          emptyEn === 1 ? 'it sits' : 'they sit'
        } the games out.`
      );
    }
    blanks.textContent = parts.join(' ');
  };

  const buildRow = (item: VocabItem): HTMLTableRowElement => {
    const zhInput = h('input', { type: 'text', value: item.zh, 'aria-label': 'Chinese' });
    const pyInput = h('input', { type: 'text', value: item.pinyin, 'aria-label': 'Pinyin' });
    const enInput = h('input', { type: 'text', value: item.en, 'aria-label': 'Meaning' });
    enInput.dataset.itemId = item.id;

    const checkMark = h('span', { class: 'check-mark', text: 'check pinyin' });
    const pyCell = h('td', { 'data-label': 'Pinyin' }, [pyInput]);
    const syncCheckMark = (): void => {
      if (needsPinyinCheck(zhInput.value)) {
        if (!checkMark.isConnected) pyCell.append(checkMark);
      } else {
        checkMark.remove();
      }
    };
    syncCheckMark();

    zhInput.addEventListener('input', () => {
      item.zh = zhInput.value;
      syncCheckMark();
      persist();
    });
    zhInput.addEventListener('change', () => {
      // Re-read the pinyin when the word itself changed and pinyin was auto.
      if (!item.pinyin.trim()) {
        item.pinyin = toPinyin(item.zh);
        pyInput.value = item.pinyin;
        refreshBlanks();
        persist();
      }
    });
    pyInput.addEventListener('input', () => {
      item.pinyin = pyInput.value;
      refreshBlanks();
      persist();
    });
    enInput.addEventListener('input', () => {
      item.en = enInput.value;
      refreshBlanks();
      persist();
    });

    const remove = h('button', {
      class: 'row-drop',
      type: 'button',
      'aria-label': `Remove ${item.zh}`,
      text: '✕',
    });
    remove.addEventListener('click', () => {
      const index = items.indexOf(item);
      if (index >= 0) items.splice(index, 1);
      row.remove();
      refreshBlanks();
      persist();
    });

    const row = h('tr', {}, [
      h('td', { class: 'zh-cell', 'data-label': 'Chinese' }, [zhInput]),
      pyCell,
      h('td', { 'data-label': 'Meaning' }, [enInput]),
      h('td', { 'data-label': 'Hear' }, [speakerButton(() => zhInput.value)]),
      h('td', { 'data-label': 'Remove' }, [remove]),
    ]);
    return row;
  };

  for (const item of items) tbody.append(buildRow(item));

  const addRow = h('button', { class: 'btn', type: 'button', text: 'Add a word' });
  addRow.addEventListener('click', () => {
    const item: VocabItem = { id: itemId(items.length), zh: '', pinyin: '', en: '' };
    items.push(item);
    tbody.append(buildRow(item));
    refreshBlanks();
    persist();
  });

  const makeGames = h('button', {
    class: 'btn btn-primary btn-big',
    type: 'button',
    text: 'Make games',
  });

  makeGames.addEventListener('click', () => {
    problem.replaceChildren();
    const cleaned = items.filter((item) => item.zh.trim());
    // A word with no English meaning is left out of the games rather than
    // holding the whole set up. It is still here to fix next time.
    const ready = cleaned.filter((item) => item.en.trim());
    if (ready.length < MIN_WORDS) {
      problem.append(
        notice(
          `The games need at least ${MIN_WORDS} words with a meaning. Try a photo of the list, or paste it again.`,
          'warn'
        )
      );
      return;
    }

    items.length = 0;
    items.push(...cleaned);
    persist();

    makeGames.disabled = true;
    makeGames.textContent = 'Making games...';
    void encodeSet(draftToSet({ ...draft, items: ready }))
      .then((encoded) => {
        if (linkTooLong(encoded)) {
          problem.append(
            notice(
              'This set is very long, so the share link may not open on some phones. Splitting it into two sets is safer.',
              'warn'
            )
          );
        }
        setSetNote({
          encoded,
          found: ready.length,
          dropped: cleaned.filter((item) => !item.en.trim()).map((item) => item.zh.trim()),
          // She has just seen them on this screen; the set page keeps the
          // count so Edit words can show them again - unless she changed the
          // very words they were about, and then they go with the old list.
          // Read from the draft `persist` just wrote, so one rule decides it
          // for both the set page and a Back to this screen.
          notes: getDraft()?.notes ?? [],
        });
        navigate(`#/set/${encoded}`);
      })
      .catch(() => {
        makeGames.disabled = false;
        makeGames.textContent = 'Make games';
        problem.append(notice('Could not build the game link. Please try again.', 'error'));
      });
  });

  // The two ways out of a paste that did not work. A photo of the list on the
  // board is usually the fastest, so it comes first and opens the camera with
  // one tap rather than sending her back to the home screen to find it.
  if (couldNotRead) {
    const photoTrouble = h('div');
    const photoInput = h('input', {
      type: 'file',
      id: 'retry-photo',
      accept: 'image/*',
      capture: 'environment',
      class: 'visually-hidden',
    });
    const photoButton = h('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Try a photo',
    });
    photoButton.addEventListener('click', () => photoInput.click());

    photoInput.addEventListener('change', () => {
      const file = photoInput.files?.[0];
      photoInput.value = '';
      if (!file) return;
      photoTrouble.replaceChildren();
      if (!PHOTO_TYPES.includes(file.type)) {
        photoTrouble.append(
          notice('That file is not a photo. Take a picture, or use a JPG, PNG or WebP screenshot.', 'warn')
        );
        return;
      }
      if (file.size > PHOTO_MAX_BYTES) {
        photoTrouble.append(
          notice('That photo is too big. Take it again, or use a smaller screenshot.', 'warn')
        );
        return;
      }

      photoButton.disabled = true;
      const label = photoButton.textContent;
      photoButton.textContent = 'Reading the photo...';
      void readPhoto(file)
        .then(async (result) => {
          if (!result.ok) {
            photoTrouble.append(notice(result.message, 'warn'));
            return;
          }
          const outcome = await buildFromText({
            text: result.text,
            items: result.items,
            notes: result.notes,
            title: draft.title,
            level: draft.level,
          });
          if (outcome.ready.length < MIN_WORDS) {
            photoTrouble.append(
              notice(
                'That photo did not give us enough words either. Try a closer picture of the list.',
                'warn'
              )
            );
            return;
          }
          await openGames(outcome);
        })
        .catch(() => {
          photoTrouble.append(notice('Could not read that photo. Please try again.', 'warn'));
        })
        .finally(() => {
          photoButton.disabled = false;
          photoButton.textContent = label;
        });
    });

    const pasteAgain = h('button', { class: 'btn', type: 'button', text: 'Paste again' });
    pasteAgain.addEventListener('click', () => navigate('#/'));

    body.append(
      h('section', { class: 'panel' }, [
        h('p', {
          text: 'We looked for Chinese words in what you gave us and did not find enough to make a game.',
        }),
        h('p', { class: 'hint', text: 'This is what we read:' }),
        h('p', { class: 'pasted-back', text: pastedPreview(draft.pasted ?? '') }),
        h('div', { class: 'row' }, [photoButton, pasteAgain, photoInput]),
        photoTrouble,
      ])
    );
  } else if (draft.skipped.length > 0) {
    const count = draft.skipped.length;
    body.append(
      notice(
        `We could not read ${count} ${count === 1 ? 'line' : 'lines'}: ${draft.skipped
          .slice(0, 3)
          .join(' / ')}${count > 3 ? ' ...' : ''}`,
        'warn'
      )
    );
  }

  // NOT A READ FAILURE. A word she defined twice was read fine and is on a
  // card; saying "we could not read it" next to the card that proves we did is
  // how a 60-word list pasted twice told her we lost 50 lines (round 5 review,
  // must-fix 4).
  //
  // AND ALL OF THEM ARE READABLE. Three notices and an ellipsis is not a list:
  // a teacher with eight folded duplicates could see three of them and had no
  // way to reach the rest (round 6 fix list, item 4). The count is always on
  // screen; the tail is one button away.
  const notes = draft.notes ?? [];
  if (notes.length > 0) {
    const shownAtFirst = 3;
    const list = h(
      'ul',
      { class: 'note-list' },
      notes.map((line, index) =>
        h('li', { text: line, hidden: index >= shownAtFirst })
      )
    );
    const block = h('div', { class: 'notice notice-info', role: 'status' }, [
      h('p', { text: `Notes (${notes.length})` }),
      list,
    ]);
    if (notes.length > shownAtFirst) {
      const more = notes.length - shownAtFirst;
      const showAll = h('button', {
        class: 'btn btn-ghost btn-inline',
        type: 'button',
        text: `Show all ${notes.length}`,
      });
      showAll.addEventListener('click', () => {
        for (const item of Array.from(list.children)) item.removeAttribute('hidden');
        showAll.remove();
      });
      showAll.setAttribute('aria-label', `Show all ${notes.length} notes, ${more} more`);
      block.append(showAll);
    }
    body.append(block);
  }

  body.append(
    status,
    h('div', { class: 'panel' }, [
      h('table', { class: 'review-table' }, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', { text: 'Chinese' }),
            h('th', { text: 'Pinyin' }),
            h('th', { text: 'Meaning' }),
            h('th', { text: 'Hear' }),
            h('th', { text: '' }),
          ]),
        ]),
        tbody,
      ]),
      h('div', { class: 'row', style: 'margin-top:16px' }, [addRow]),
    ]),
    blanks,
    problem,
    makeGames
  );

  root.replaceChildren(page);
  refreshBlanks();

  const needsGloss = items.some((item) => !item.en.trim());
  if (needsGloss) {
    status.append(notice('Filling in the English meanings...', 'info'));
    void fillMissingGlosses(items).then((result) => {
      for (const item of items) {
        if (item.en.trim()) continue;
        const gloss = result.filled.get(item.zh.trim());
        if (!gloss) continue;
        item.en = gloss;
        const input = tbody.querySelector<HTMLInputElement>(
          `input[data-item-id="${CSS.escape(item.id)}"]`
        );
        if (input) input.value = gloss;
      }
      persist();
      refreshBlanks();
      status.replaceChildren(
        result.missing > 0
          ? notice(
              `We have no English for ${result.missing} ${result.missing === 1 ? 'word' : 'words'}. ` +
                `${result.missing === 1 ? 'It stays' : 'They stay'} out of the games unless you fill ${
                  result.missing === 1 ? 'it' : 'them'
                } in.`,
              'warn'
            )
          : notice('English meanings filled in. Please check them.', 'info')
      );
    });
  }
}

