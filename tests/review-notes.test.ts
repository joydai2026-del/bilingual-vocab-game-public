// ROUND 8 FIX LIST, item 2. The notices from a read describe the list that was
// read. They were cleared on the way OUT, in the set note, and left in the
// DRAFT - and the draft is what the Back button re-renders the review screen
// from, so Back and Make games again brought the obsolete notices back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDraft, persistedDraft, setDraft, wordList, type Draft } from '../src/client/state';
import type { VocabItem } from '../src/shared/types';

const ROWS: VocabItem[] = [
  { id: 'a', zh: '\u8bcd\u8bed\u96f6', pinyin: 'ci yu ling', en: 'word zero' },
  { id: 'b', zh: '\u8bcd\u8bed\u4e00', pinyin: 'ci yu yi', en: 'word one' },
];
const NOTES = ['\u8bcd\u8bed\u96f6 appears twice'];

function draftOf(): Draft {
  return {
    title: 'her list',
    level: 'big',
    items: ROWS.map((row) => ({ ...row })),
    skipped: [],
    notes: [...NOTES],
  };
}

/** What a refresh would read back: the draft as it was actually stored. */
function stored(store: Map<string, string>): Draft {
  const raw = [...store.values()][0];
  return JSON.parse(raw) as Draft;
}

describe('the notices and the list they came from', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps them while the words are still the words they were read from', () => {
    setDraft(draftOf());
    const openedWith = wordList(getDraft()!.items);
    // She retypes a value to exactly what it already said: not a change.
    const retyped = ROWS.map((row) => ({ ...row }));
    setDraft(persistedDraft(getDraft()!, retyped, openedWith));
    expect(getDraft()!.notes).toEqual(NOTES);
    expect(stored(store).notes).toEqual(NOTES);
  });

  it('leaves them behind for good once an edited list is saved', () => {
    setDraft(draftOf());
    // The review screen opens and remembers what it opened with.
    const openedWith = wordList(getDraft()!.items);

    // She fixes a meaning, and the edit is saved as she types it.
    const edited = ROWS.map((row, i) =>
      i === 0 ? { ...row, en: 'nothing at all' } : { ...row }
    );
    setDraft(persistedDraft(getDraft()!, edited, openedWith));
    expect(getDraft()!.notes).toEqual([]);
    // Make games sends what the draft holds, so the set page gets none either.
    expect(stored(store).notes).toEqual([]);

    // BACK, and the screen re-renders from the draft: it baselines on the
    // EDITED list, so nothing looks changed any more. This is where the
    // notices used to come back, because the draft still carried them.
    const back = getDraft()!;
    const reopened = wordList(back.items);
    setDraft(persistedDraft(back, back.items, reopened));
    expect(getDraft()!.notes).toEqual([]);
    expect(stored(store).notes).toEqual([]);
  });
});

