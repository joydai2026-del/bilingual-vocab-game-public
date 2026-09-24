// From "the teacher pressed Make games" to "the games are on screen".
//
// One path, used by the home screen and by the photo button on the
// could-not-read screen, so both behave identically:
//
//   1. the worker's dictionary segmentation reads the text (`/api/extract`);
//      if it cannot be reached, the local parser reads it instead;
//   2. missing pinyin is filled locally, missing English from the worker;
//   3. any word we still have no English for is left OUT of the games and
//      listed on the set page, rather than stopping the teacher;
//   4. two or more words with an English meaning means straight to the games.
//
// The type-each-word table is what happens when this fails, not the way in.

import { parseVocab } from '../shared/parse';
import { encodeSet } from '../shared/share';
import type { Level, VocabItem } from '../shared/types';
import { fillMissingGlosses } from './enrich';
import { extractWords, type ExtractedItem } from './input/extract';
import { fillMissingPinyin } from './pinyin';
import { navigate } from './router';
import { draftToSet, itemId, setDraft, setSetNote, type Draft } from './state';

/** Two words is the smallest set any of the games can be played with. */
export const MIN_WORDS = 2;

export interface BuildRequest {
  /** What the teacher pasted, typed, or what came back off a photo. */
  text: string;
  /**
   * Words the worker already found (the photo path gets them with the OCR
   * answer). When present the text is not sent to `/api/extract` again.
   */
  items?: readonly ExtractedItem[];
  /**
   * The notices that came back with those words. The photo path reads the
   * words in the worker, so its notes arrive with `items` and nowhere else;
   * without this they were dropped and a photo of a list pasted twice said
   * nothing about the fold (round 6 fix list, item 5).
   */
  notes?: readonly string[];
  title: string;
  level: Level;
}

export interface BuildOutcome {
  draft: Draft;
  /** Words with both sides, which is what the games are built from. */
  ready: VocabItem[];
  /** Words we found but have no English for, so they sit the games out. */
  dropped: VocabItem[];
}

function toItems(rows: readonly { zh: string; pinyin: string; en: string }[]): VocabItem[] {
  return fillMissingPinyin(rows.map((row, index) => ({ id: itemId(index), ...row })));
}

/**
 * Reads the text into words and fills in whatever is missing. Never throws:
 * every remote step has a local answer, so the worst case is an outcome with
 * no ready words, which the caller turns into the could-not-read screen.
 */
export async function buildFromText(request: BuildRequest): Promise<BuildOutcome> {
  const { text, title, level } = request;

  let rows: { zh: string; pinyin: string; en: string }[];
  let skipped: string[];
  let notes: string[] = [];

  if (request.items) {
    rows = request.items.map((item) => ({ ...item }));
    skipped = [];
    notes = [...(request.notes ?? [])];
  } else {
    const extracted = await extractWords(text);
    // The worker is the better reader, but it is not the only one. It is used
    // when it was reachable AND it actually found something; a null answer
    // (offline, slow, refused) and an empty one (a shape its dictionary could
    // not cut) both fall through to the local parser, because a teacher gets
    // more from the tidy-shapes reader than from a screen that gave up.
    if (extracted && extracted.items.length > 0) {
      rows = extracted.items;
      skipped = extracted.skipped;
      notes = extracted.notes;
    } else if (extracted && extracted.paperworkOnly) {
      // The one empty answer that must NOT be second-guessed. The worker read
      // the paste and found only paperwork in it. The local parser has no
      // dictionary and no paperwork rule, so it reads each of those rows as a
      // word and its English meaning and hands her a game whose cards are the
      // chapter numbers. An empty answer she can see and fix is the better one,
      // so it stands and she gets the could-not-read screen.
      //
      // THE EXAMPLE THIS COMMENT USED TO CARRY WAS STALE, and it was the
      // load-bearing half. It said the branch exists for a bilingual lesson
      // index, `第1课 Lesson one`; since round 7c that paste comes back with
      // THREE CARDS and paperworkOnly is never set on it (measured 2026-09-09,
      // r8 SF-C). The live triggers are a bare run of markers with no gloss
      // anywhere (`第1课 第2课`, isMarkerRunOnly) and the all-filtered retry
      // (`第1课：` x2, `第一课生词`).
      rows = [];
      skipped = extracted.skipped;
      notes = extracted.notes;
    } else {
      const local = parseVocab(text);
      rows = local.items;
      skipped = local.items.length > 0 ? local.skipped : (extracted?.skipped ?? local.skipped);
    }
  }

  let items = toItems(rows);

  if (items.some((item) => !item.en.trim())) {
    try {
      const result = await fillMissingGlosses(items);
      items = items.map((item) =>
        item.en.trim() ? item : { ...item, en: result.filled.get(item.zh.trim()) ?? '' }
      );
    } catch {
      // No glosses came back. The words we already had English for still play.
    }
  }

  const draft: Draft = {
    title: title.trim() || 'My words',
    level,
    items,
    skipped,
    notes,
    pasted: text,
  };
  setDraft(draft);

  return {
    draft,
    ready: items.filter((item) => item.zh.trim() && item.en.trim()),
    dropped: items.filter((item) => item.zh.trim() && !item.en.trim()),
  };
}

/**
 * Opens the games for an outcome, or the could-not-read screen when there are
 * not enough words. Returns true when the games were opened.
 */
export async function openGames(outcome: BuildOutcome): Promise<boolean> {
  if (outcome.ready.length < MIN_WORDS) {
    navigate('#/review');
    return false;
  }

  const encoded = await encodeSet(draftToSet({ ...outcome.draft, items: outcome.ready }));
  setSetNote({
    encoded,
    found: outcome.ready.length,
    dropped: outcome.dropped.map((item) => item.zh.trim()),
    // The set page says one line about these and the edit table shows them all.
    notes: outcome.draft.notes,
  });
  navigate(`#/set/${encoded}`);
  return true;
}

