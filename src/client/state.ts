// Client-side state that outlives one screen: the set being edited (kept in
// memory and mirrored to sessionStorage so a refresh mid-review is not a
// disaster) and the pinyin toggle (localStorage, because a teacher's choice
// should stick between lessons).

import type { Level, VocabItem, VocabSet } from '../shared/types';

const DRAFT_KEY = 'bvg.draft.v1';
const NOTE_KEY = 'bvg.setnote.v1';
const PINYIN_KEY = 'bvg.pinyin.v1';
const NAME_KEY = 'bvg.name.v1';

export interface Draft {
  title: string;
  level: Level;
  items: VocabItem[];
  skipped: string[];
  /**
   * Notices that are NOT lines we could not read: a word she defined twice, a
   * meaning we did not use, how much Quizlet page came off. Kept apart from
   * `skipped` because the review screen prints that list under "We could not
   * read N lines" and these were read fine.
   */
  notes: string[];
  /**
   * What the teacher actually pasted or photographed, kept only so the
   * "we could not read this" screen can show it back to her. Absent when the
   * draft came from the set page's Edit button.
   */
  pasted?: string;
}

/**
 * What the set page says about the words it was just given: how many were
 * found, and which Chinese words had to be left out because no English
 * meaning could be found for them. Tied to one encoded set, so a shared link
 * that somebody else opens never shows a stranger's notice.
 */
export interface SetNote {
  encoded: string;
  found: number;
  dropped: string[];
  /**
   * The read's notices (a word defined twice, a meaning we did not use). They
   * ride with the set so the teacher who never opens the edit table still
   * learns a duplicate was folded, and so `Edit words` can hand them to the
   * review screen instead of rebuilding the draft without them (round 6 fix
   * list, items 2 and 8).
   */
  notes: string[];
}

let draft: Draft | null = null;

function safeGet(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // private mode / storage full: state simply does not survive a refresh
  }
}

export function getDraft(): Draft | null {
  if (draft) return draft;
  const raw = safeGet(window.sessionStorage, DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Draft;
    if (parsed && Array.isArray(parsed.items)) draft = parsed;
  } catch {
    draft = null;
  }
  return draft;
}

/**
 * The words of a list as one string, so two readings can be compared as text.
 *
 * A re-typed identical value is not a change, which is why this compares what
 * is IN the rows rather than the row objects.
 */
export function wordList(rows: readonly VocabItem[]): string {
  return rows
    .filter((item) => item.zh.trim())
    .map((item) => `${item.zh.trim()}\u001f${item.pinyin.trim()}\u001f${item.en.trim()}`)
    .join('\u001e');
}

/**
 * The draft to save after an edit on the review screen.
 *
 * THE NOTICES DESCRIBE THE LIST THEY CAME FROM. `词语零 appears twice` and
 * `second meaning not used` are about the words as they were read; once she has
 * changed a word, dropped one or added one, they are about a list that no
 * longer exists. Clearing them only in the set note going out left `Draft.notes`
 * untouched, so Back after Make games re-rendered the review screen from a
 * draft that still carried them, that render baselined on the edited list, and
 * Make games again put the obsolete notices back (round 8 fix list, item 2).
 * The draft is what a Back button reads, so the draft is where the
 * invalidation has to live.
 *
 * `openedWith` is `wordList` of the rows the screen was opened with.
 */
export function persistedDraft(
  draft: Draft,
  items: VocabItem[],
  openedWith: string
): Draft {
  const changed = wordList(items) !== openedWith;
  return { ...draft, items, notes: changed ? [] : (draft.notes ?? []) };
}

export function setDraft(next: Draft): void {
  draft = next;
  safeSet(window.sessionStorage, DRAFT_KEY, JSON.stringify(next));
}

/** Remembers the notice for the set page we are about to open. */
export function setSetNote(note: SetNote): void {
  safeSet(window.sessionStorage, NOTE_KEY, JSON.stringify(note));
}

/** The notice for this encoded set, or null when there is none for it. */
export function getSetNote(encoded: string): SetNote | null {
  const raw = safeGet(window.sessionStorage, NOTE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SetNote;
    if (!parsed || parsed.encoded !== encoded) return null;
    return {
      encoded: parsed.encoded,
      found: Number(parsed.found) || 0,
      dropped: Array.isArray(parsed.dropped) ? parsed.dropped.filter((d) => typeof d === 'string') : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n) => typeof n === 'string') : [],
    };
  } catch {
    return null;
  }
}

export function draftToSet(source: Draft): VocabSet {
  return {
    v: 1,
    title: source.title.trim() || 'My words',
    level: source.level,
    items: source.items.map((item) => ({
      id: item.id,
      zh: item.zh.trim(),
      pinyin: item.pinyin.trim(),
      en: item.en.trim(),
    })),
  };
}

/** Pinyin under Chinese: on by default, because most classes want it. */
export function pinyinOn(): boolean {
  return safeGet(window.localStorage, PINYIN_KEY) !== 'off';
}

export function setPinyinOn(on: boolean): void {
  safeSet(window.localStorage, PINYIN_KEY, on ? 'on' : 'off');
}

export function savedName(): string {
  return safeGet(window.localStorage, NAME_KEY) ?? '';
}

export function saveName(name: string): void {
  safeSet(window.localStorage, NAME_KEY, name);
}

/** Short unique-enough id for a vocab row. */
export function itemId(index: number): string {
  return `i${index.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

