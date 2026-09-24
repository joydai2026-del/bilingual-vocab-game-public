// The one input box on the home screen.
//
// The teacher pastes ANYTHING into it: a messy list, a Google Sheets link, or
// nothing at all if she would rather take a photo of the list on the board.
// This module works out which of those it is and turns it into plain text for
// the parser. There is no format picker, no upload dialog, no second step.

import { h, notice } from '../ui';
import { QUIZLET_HELP, detectInput } from './detect';
import type { ExtractedItem } from './extract';
import { loadSheet, readPhoto } from './remote';

const PLACEHOLDER = '你好\thello\n谢谢\tthank you\n再见\tgoodbye';

export const HELPER_LINE =
  'Paste words in any shape, or a Google Sheets link, or add a photo.';

/**
 * Client-side copies of the /api/ocr limits, used only to answer instantly
 * instead of sending a 30 MB photo to be refused. The worker's own check is
 * the real gate; these numbers are a courtesy and are allowed to be stale.
 */
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

export interface SmartInput {
  /** The whole field, ready to append to the page. */
  el: HTMLElement;
  /** The textarea itself, for focus and for restoring a previous draft. */
  box: HTMLTextAreaElement;
  value(): string;
  setValue(text: string): void;
  /**
   * Turns whatever is in the box into text the parser can read: a Sheets link
   * becomes the sheet's CSV, a Quizlet link becomes an on-screen instruction
   * and no text, anything else is passed straight through. Messages are shown
   * in the box's own status line, so the caller only has to check `ok`.
   */
  resolve(): Promise<ResolvedInput>;
}

export type ResolvedInput =
  | {
      ok: true;
      text: string;
      /**
       * Words the worker already pulled out of a photo. Present only while the
       * box still holds exactly what the photo gave us; the moment the teacher
       * edits the box her own text is what counts.
       */
      items?: ExtractedItem[];
      /** The notices the worker sent back with those words. */
      notes?: string[];
    }
  | { ok: false };

export function smartInput(onPhotoLoaded?: () => void): SmartInput {
  const box = h('textarea', {
    class: 'paste-box',
    id: 'paste',
    placeholder: PLACEHOLDER,
    spellcheck: 'false',
  });

  const status = h('div', { class: 'input-status' });

  const photoInput = h('input', {
    type: 'file',
    id: 'photo',
    accept: 'image/*',
    // On a phone this offers the camera as well as the photo library.
    capture: 'environment',
    class: 'visually-hidden',
  });

  const photoButton = h('button', {
    class: 'btn btn-ghost btn-photo',
    type: 'button',
    text: 'Photo or screenshot',
  });
  photoButton.addEventListener('click', () => photoInput.click());

  // The last photo's words, and the text they came with, so an edited box is
  // never sent to the games as if it were the photo.
  let photoItems: ExtractedItem[] | null = null;
  let photoNotes: string[] = [];
  let photoText = '';

  const say = (message: string, kind: 'info' | 'warn' | 'error' = 'info'): void => {
    status.replaceChildren(notice(message, kind));
  };

  const sayLines = (lines: readonly string[]): void => {
    status.replaceChildren(
      h(
        'div',
        { class: 'notice notice-warn', role: 'status' },
        lines.map((line) => h('p', { text: line }))
      )
    );
  };

  photoInput.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    // Clear the picker either way, so choosing the same photo twice still fires.
    photoInput.value = '';
    if (!file) return;

    if (!PHOTO_TYPES.includes(file.type)) {
      say('That file is not a photo. Take a picture, or use a JPG, PNG or WebP screenshot.', 'warn');
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      say('That photo is too big. Take it again, or use a smaller screenshot.', 'warn');
      return;
    }

    photoButton.disabled = true;
    const previousLabel = photoButton.textContent;
    photoButton.textContent = 'Reading the photo...';
    say('Reading the words in your photo. This takes a few seconds.');

    void readPhoto(file)
      .then((result) => {
        if (!result.ok) {
          say(result.message, 'warn');
          return;
        }
        box.value = result.text;
        photoItems = result.items ?? null;
        photoNotes = result.notes ?? [];
        photoText = result.text;
        say('Read the photo. Check the words below, then press Make games.');
        onPhotoLoaded?.();
      })
      .finally(() => {
        photoButton.disabled = false;
        photoButton.textContent = previousLabel;
      });
  });

  const resolve = async (): Promise<ResolvedInput> => {
    status.replaceChildren();
    const raw = box.value;

    if (photoItems && raw === photoText) {
      return { ok: true, text: raw, items: photoItems, notes: photoNotes };
    }

    const detected = detectInput(raw);

    if (detected.kind === 'quizlet') {
      sayLines(QUIZLET_HELP);
      box.focus();
      return { ok: false };
    }

    if (detected.kind === 'sheet') {
      say('Reading your Google Sheet...');
      const result = await loadSheet(detected.url);
      if (!result.ok) {
        say(result.message, 'warn');
        return { ok: false };
      }
      // Put the words in the box so the teacher can see what was read, and so
      // a second press does not fetch the sheet all over again.
      box.value = result.text;
      status.replaceChildren();
      return { ok: true, text: result.text };
    }

    return { ok: true, text: raw };
  };

  const el = h('div', { class: 'field' }, [
    h('label', { for: 'paste', text: 'Paste your words' }),
    box,
    h('div', { class: 'input-row' }, [
      h('p', { class: 'hint', text: HELPER_LINE }),
      photoButton,
      photoInput,
    ]),
    status,
  ]);

  return {
    el,
    box,
    value: () => box.value,
    setValue: (text: string) => {
      box.value = text;
      photoItems = null;
      photoNotes = [];
      photoText = '';
    },
    resolve,
  };
}

