// Pinyin filling, done locally with pinyin-pro. No network, no LLM: the
// mapping is deterministic, so the same word always gets the same reading.

import { pinyin } from 'pinyin-pro';

/**
 * Characters whose reading depends on the word (amendment 6 of the plan).
 * A row containing one of these gets a small "check" mark in the review
 * table, because the automatic reading may be the wrong one.
 */
export const POLYPHONES = [
  '重',
  '行',
  '乐',
  '长',
  '还',
  '得',
  '都',
  '发',
  '觉',
  '教',
  '少',
  '数',
  '种',
  '干',
  '好',
  '应',
];

const POLYPHONE_SET = new Set(POLYPHONES);

export function needsPinyinCheck(zh: string): boolean {
  for (const char of zh) {
    if (POLYPHONE_SET.has(char)) return true;
  }
  return false;
}

/** Tone-mark pinyin for one word. Non-Chinese runs are passed through. */
export function toPinyin(zh: string): string {
  const text = zh.trim();
  if (!text) return '';
  try {
    return pinyin(text, { toneType: 'symbol', nonZh: 'consecutive' }).trim();
  } catch {
    return '';
  }
}

/** Fills pinyin only where it is missing; a teacher's own reading wins. */
export function fillMissingPinyin<T extends { zh: string; pinyin: string }>(items: T[]): T[] {
  return items.map((item) =>
    item.pinyin.trim() ? item : { ...item, pinyin: toPinyin(item.zh) }
  );
}

