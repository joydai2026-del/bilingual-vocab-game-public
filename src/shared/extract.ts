// Turns whatever a teacher pasted into a vocabulary list.
//
// THE PROBLEM THIS SOLVES (reproduced 2026-09-08 with scratch/parse-probe.mjs)
// src/shared/parse.ts reads ROWS: one word per line, optionally with a gloss
// beside it. That is the right reader for a Quizlet export or a spreadsheet, and
// the wrong reader for the way a teacher actually writes a list to her class:
//
//   苹果，香蕉，老师，学生            one line, Chinese commas   -> 1 "word"
//   苹果、香蕉、老师                  one line, pause marks      -> 1 "word"
//   苹果香蕉老师学生跑步游泳          no separators at all       -> 1 "word"
//   今天我们学习水果。苹果很好吃。    a paragraph                -> 1 "word"
//   这周的生词：苹果 香蕉 ...请复习   a WeChat message           -> 1 "word"
//
// Every one of those produced a single enormous "word" and sent the teacher to a
// screen asking her to type an English gloss for it. This module is the layer
// above parse.ts that makes all five work.
//
// HOW IT WORKS
//   1. NFKC normalise, so a fullwidth paste and an ASCII paste are one shape.
//   2. Decide STRUCTURED or FREE. Structured means the paste has columns (a tab,
//      a ` | `) or most of its rows already carry a gloss or a pinyin, i.e. the
//      teacher did the pairing herself. parse.ts is authoritative there and its
//      answers are kept whole, because her gloss beats any dictionary gloss.
//   3. Anything left over goes down the FREE path: cut the text into runs of
//      Chinese characters (which splits on ALL punctuation, Chinese and ASCII,
//      plus brackets, bullets, numbering, Latin text and whitespace), then for
//      each run:
//        - if the whole run is a dictionary headword, keep it;
//        - otherwise segment it by forward maximum matching over the CC-CEDICT
//          headwords, longest match first, at most 4 characters.
//      Then drop function words (src/shared/stopwords.ts), and drop single
//      characters UNLESS the teacher listed that character on its own.
//   4. Dedupe by the Chinese, first occurrence wins, and cap the list.
//
// WHY MAXIMUM MATCHING AND NOT A MODEL: it needs no network, no budget and no
// latency, it is deterministic (the same paste always makes the same game), and
// the dictionary that scores it is the same 125k-headword asset that already
// ships for glosses. The worker keeps a model call in reserve for the case where
// this finds almost nothing (src/worker/extract.ts).
//
// The dictionary lives on the SERVER (public/cedict.json, 8 MB), so the client
// cannot run step 3. That is why /api/extract exists.

import {
  BARE_DOC_STRUCTURE_MARKER_RE,
  DOC_STRUCTURE_UNITS,
  ORDINAL_NUMERAL,
  ORDINAL_STEM,
  ORDINAL_VOCAB_UNITS,
  hasCJK,
  isPinyinToken,
  parseVocab,
} from './parse';
import {
  isPaperwork,
  isSignOffRun,
  isStopword,
  isStructuralPaperwork,
} from './stopwords';

/** Where an item came from. Reported so the worker can count the three paths. */
export type ExtractSource = 'pair' | 'dict' | 'segment';

/**
 * `structured` = the teacher's own rows were used (columns, or most rows already
 * glossed). `free` = the words were cut out of running text.
 */
export type ExtractMode = 'structured' | 'free';

export interface ExtractedVocab {
  zh: string;
  pinyin: string;
  en: string;
  source: ExtractSource;
}

export interface ExtractDictHit {
  pinyin: string;
  en: string;
}

/**
 * The slice of the dictionary this module needs. `Dict` from src/worker/dict.ts
 * satisfies it, and a test can pass a four-word object.
 *
 * A traditional headword resolves through the same call: the shipped asset holds
 * traditional forms as keys of the same table (see buildDict in shared/cedict.ts),
 * so 蘋果 and 苹果 are both lookups that hit.
 */
export interface ExtractDict {
  lookup(zh: string): ExtractDictHit | null;
}

export interface ExtractResult {
  items: ExtractedVocab[];
  /** Lines that had content but produced no word: headers, page numbers, notes. */
  skipped: string[];
  /**
   * Things worth telling the teacher that are NOT lines we failed to read: a
   * word she defined twice, a meaning we did not use, how much Quizlet sidebar
   * came off, how many leftovers were too many to list.
   *
   * They used to ride in `skipped`, and the review screen prints that list
   * under "We could not read N lines", so a 60-word list pasted twice made all
   * 60 cards and then told her we could not read 50 lines (round 5 review,
   * must-fix 4). Absent when there is nothing to say.
   */
  notes?: string[];
  mode: ExtractMode;
  /**
   * Set only on an EMPTY answer, and only when that answer is a decision rather
   * than a failure: the un-stripped retry at the bottom of extractVocab ran, it
   * did find words, and every single one of them was paperwork (`第1课` shattered
   * into 第 and 课, an ordinal fragment, a list header). The paste has no
   * vocabulary in it and we know that, as opposed to a paste we could not read.
   *
   * Nobody's cards change because of this field. It exists so the worker can
   * tell the two empties apart before it spends money: see needsRescue in
   * src/worker/extract.ts.
   */
  paperworkOnly?: boolean;
}

/** A game cannot use more than this, and neither can a teacher. */
export const MAX_EXTRACT_ITEMS = 200;

/** The longest run the segmenter will treat as one word. */
export const MAX_WORD_CHARS = 4;

/** A gloss longer than this is a sentence, not a card. Matches cedict.ts. */
const MAX_GLOSS_CHARS = 40;

const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3005\\u3007';
/** Maximal runs of Chinese. Everything else in the text is a separator. */
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]+`, 'g');
const CJK_ONE_RE = new RegExp(`[${CJK_CLASS}]`);

/**
 * A gloss the teacher wrote on the same line as the word, in FREE mode:
 * `apple 苹果` and `苹果 - apple`. Latin letters first, so `1 苹果 píngguǒ n.`
 * (which starts with a digit and carries tone marks) is not mistaken for one.
 */
const LINE_GLOSS_RE = /^[A-Za-z][A-Za-z0-9\s'’\-,./()&]{0,60}$/;

/** Part-of-speech tags an HSK list or a textbook glossary puts before the gloss. */
const POS_PREFIX_RE = /^(?:n|v|adj|adv|prep|pron|conj|num|mw|cl|int|part|aux|vo|s|m)\.\s*/i;

/**
 * The paperwork around a word list: `Unit 3 Vocabulary`, `Homework: page 12`,
 * `Name:`. These are removed from the text BEFORE parse.ts reads it and are
 * reported to the teacher as skipped.
 *
 * Removing them early is the point. parse.ts reads a line with no Chinese as
 * the gloss of the line above it (the Quizlet screen-copy shape), so a paste
 * that ends `Homework: page 12` used to hand that string to 香蕉 as its English
 * meaning. It has to go before the pairing runs, not after.
 *
 * SAFETY PROPERTY, deliberately designed for: every pattern here requires
 * punctuation or a digit. A bare English word is never a header, so a real
 * gloss (`teacher`, `test`, `to review`, `page`) can never be eaten by this,
 * however close it looks to a heading word.
 *
 * The gap between the word and the number is ONE class, `[\s#]*`, and not
 * `\s*#?\s*`. Two adjacent quantifiers that can both match a space give the
 * engine an enormous number of ways to divide a run of spaces between them, and
 * every one of them has to be tried before a line that never reaches a digit
 * can be rejected: `'Unit' + ' '.repeat(60000) + 'x'` took 5.9 s here on
 * 2026-09-08. One class has one way to match, so the same line is linear.
 */
const HEADING_WITH_NUMBER_RE =
  /^(?:unit|lesson|chapter|week|module|section|part|level|grade|period|semester|term|hsk|day|page|pg|no|number|set|list|group|book|quiz|test|exam)[\s#]*\d+\b/i;

/** `Homework: page 12`, `Due: Friday`, `Subject: this week's words`. */
const LABELLED_LINE_RE =
  /^(?:homework|hw|assignment|due|quiz|test|exam|name|date|class|teacher|student|worksheet|handout|review|study|practice|vocab|vocabulary|spelling|notes?|subject|from|sent|to|cc|bcc|re|topic|title|grade|level|unit|lesson|week|chapter|page)\s*[:\uff1a]/i;

/** A line that is nothing but a label: `Name:`, `This week's words:`. */
const BARE_LABEL_RE = /^[A-Za-z][A-Za-z ./'\u2019&-]{0,28}[:\uff1a]\s*$/;

/**
 * A date written into the paste: `2026年9月8日`, `9月8日`, `9月8号`, `2026年9月`.
 *
 * NOT `第3周`, and not `3点`, `5分`, `8岁`, `3次`. 周 点 分 岁 次 are not in this
 * pattern and never were, whatever an earlier version of this comment said:
 * `第3周 生词：苹果 香蕉` still comes back holding 第 and 周. That is the same
 * bug (a digit cuts a Chinese run in two and each half is trusted as a word
 * she separated herself) reached through a different character, and adding a
 * fifth character to the list would not reach it either. It is open.
 *
 * Reproduced live on 2026-09-08 against the deployed /api/extract:
 * `第三课 2026年9月8日 生词：苹果 香蕉 葡萄 西瓜` came back holding 年, 月 and 日
 * as three of its seven cards, because the digits cut the line into runs and
 * every one of those characters is a dictionary headword on its own.
 *
 * TWO UNITS ARE REQUIRED, IN CALENDAR ORDER, and the match has to end where a
 * token ends. That is what makes this safe, and the earlier one-unit version
 * (`\d+[ \t]?[年月日号]`) was not:
 *
 *   1年级 2年级      one unit. Untouched, so 年级 stays 年级 and not 级.
 *   100日元          one unit. Untouched, so 日元 stays 日元 and not 元.
 *   3号线            one unit. Untouched, so 号线 stays 号线 and not 线.
 *   1月 2月 3月      one unit each. A months lesson is the commonest way a
 *                    Chinese teacher writes one, and the old rule deleted the
 *                    whole thing and returned zero cards.
 *   9月8日记          two units, but the match would end inside 日记, so the
 *                    trailing boundary refuses it. A date glued to a word is
 *                    left alone rather than guessed at.
 *
 * A calendar lesson without digits (`年 月 日`, `今年 明年`, `一月 二月`) never
 * had a digit in front of the unit and is untouched, as before.
 *
 * EVERY QUANTIFIER IS BOUNDED. `\d+` in front of a required character is
 * retried from every start position: `'9'.repeat(60000) + '苹果'` (60,006
 * bytes, inside the 64 KB the worker accepts from an unauthenticated POST)
 * cost 5,398 ms of Worker CPU on 2026-09-08, against 6 ms before the rule
 * existed. A year is at most four digits and a month or a day at most two, so
 * every position now costs a fixed handful of steps and the same paste is
 * linear. The test that holds this is `a paste of sixty thousand digits still
 * answers in under a second`.
 */
const DATE_YEAR = '\\d{1,4}[ \\t]?\\u5e74';
const DATE_MONTH = '\\d{1,2}[ \\t]?\\u6708';
const DATE_DAY = '\\d{1,2}[ \\t]?[\\u65e5\\u53f7]';
/** Not inside a longer number, and not the first half of a longer word. */
const DATE_HEAD = '(?<!\\d)';
const DATE_TAIL = '(?![\\d\\u4e00-\\u9fff\\u3400-\\u4dbf])';
const DATE_PART_RE = new RegExp(
  DATE_HEAD +
    '(?:' +
    `${DATE_YEAR}[ \\t]?${DATE_MONTH}(?:[ \\t]?${DATE_DAY})?` +
    `|${DATE_YEAR}[ \\t]?${DATE_DAY}` +
    // NO SPACE between the month and the day when there is no year in front of
    // them. A space there is her list separator, not part of a date: measured
    // 2026-09-08, `1月 5日 9号` came back as `["9号"]` and `1月 2月 1日 2日` as
    // `["1月","2日"]`, so adding a fourth item to her calendar list DELETED the
    // first two. A year makes it unambiguous (nobody lists years), so the two
    // alternatives above still allow the space; a bare month and day do not.
    `|${DATE_MONTH}${DATE_DAY}` +
    ')' +
    DATE_TAIL,
  'g'
);

/**
 * `1月` through `12月`, and `1日`/`1号` through `31日`/`31号`, on a LIST rather than a
 * date: a months lesson (fixture 48) or a days-of-the-month lesson, each unit
 * written on its own rather than paired into a calendar date.
 *
 * DATE_PART_RE runs first and always wins: a real date (`2026年9月8日`, `9月8日`)
 * needs two units in calendar order and is stripped before this ever sees it,
 * so a date is still a date, not a month card.
 *
 * What is LEFT after that strip is a single unit standing alone, and the old
 * behaviour threw the digit away and kept only the dictionary word (`月`,
 * `日`): twelve different months came back as one repeated card, 月. She wrote
 * `1月`; the card is `1月`, with a reading and an English meaning she never
 * typed, because a calendar unit is not in CC-CEDICT with a number glued on
 * the front and the dictionary has nothing to offer it.
 *
 * ONLY ON A LIST. Splitting a numeral out of running prose is a different,
 * unguarded problem (a price, a page number, a phone number); this only fires
 * when the caller already knows the line reads as a list, not as a sentence.
 */
const MONTH_CHAR = '月';
const DAY_CHARS = new Set(['日', '号']);

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * `1` -> `一`, `12` -> `十二`, `20` -> `二十`, `31` -> `三十一`, `100` ->
 * `一百`, `101` -> `一百零一`, `123` -> `一百二十三`, `999` -> `九百九十九`.
 *
 * The date reader only ever asks it for 1-31; the hundreds are for the ordinal
 * card (`第100天` -> `dì yī bǎi tiān`), where the reading has to be built from
 * the number because a digit spelling has none of its own.
 */
function chineseNumberWord(n: number): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return digits[n];
  if (n < 20) return '十' + (n === 10 ? '' : digits[n - 10]);
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return digits[tens] + '十' + (ones === 0 ? '' : digits[ones]);
  }
  const hundreds = digits[Math.floor(n / 100)] + '百';
  const rest = n % 100;
  if (rest === 0) return hundreds;
  // 一百零五, not 一百五: a missing tens place is spoken as 零. And 一百一十,
  // not 一百十, because 十 needs its digit once it is not the leading place.
  if (rest < 10) return hundreds + '零' + digits[rest];
  const tens = Math.floor(rest / 10);
  const ones = rest % 10;
  return hundreds + digits[tens] + '十' + (ones === 0 ? '' : digits[ones]);
}

/** `1` -> `the 1st`, `12` -> `the 12th`, `21` -> `the 21st`, `31` -> `the 31st`. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `the ${n}th`;
  switch (n % 10) {
    case 1:
      return `the ${n}st`;
    case 2:
      return `the ${n}nd`;
    case 3:
      return `the ${n}rd`;
    default:
      return `the ${n}th`;
  }
}

/**
 * Pinyin for the digit words `chineseNumberWord` produces, `十` included. A
 * static table, not pinyin-pro: this file is imported by src/worker/extract.ts,
 * and pinyin-pro schedules a `setTimeout` at module scope building its
 * segmentation automaton, which the Workers runtime refuses to start (see
 * tests/worker-imports.test.ts). src/client/pinyin.ts keeps using the library
 * for everything else; this table only needs to cover 1-31 and three units.
 */
const DIGIT_PINYIN: Record<string, string> = {
  零: 'líng', 一: 'yī', 二: 'èr', 三: 'sān', 四: 'sì',
  五: 'wǔ', 六: 'liù', 七: 'qī', 八: 'bā', 九: 'jiǔ', 十: 'shí',
  // 百 arrived with the hundreds (round 11b). A date never needs it; an ordinal
  // card does, and without it `第100天` would have read `dì yī 百 tiān`.
  百: 'bǎi',
  // 两 IS ALSO 2, AND IT IS NOT SAID `èr`. ORDINAL_NUMERAL has always accepted
  // it, so `第两天` built a card whose reading was for a character she did not
  // type (round 10, F4). `chineseNumberWord` never produces it; it is only
  // ever read back off her own spelling.
  两: 'liǎng',
};

const UNIT_PINYIN: Record<string, string> = { 月: 'yuè', 日: 'rì', 号: 'hào' };

/**
 * Pinyin for a `chineseNumberWord(n)` + unit reading, matching exactly what
 * pinyin-pro produced (probed live 2026-09-08, kept in tests/extract.test.ts):
 * every digit reads with its own tone EXCEPT `一` immediately before `日` when
 * the whole number is 1 - real Mandarin tone sandhi, 一 -> yí before a 4th
 * tone syllable. It does NOT extend to `号` (also 4th tone: pinyin-pro reads
 * "一号" as `yī hào`, not `yí hào`) and does NOT extend to `一` inside a
 * compound like 十一/二十一/三十一 (`èr shí yī rì`, not `èr shí yí rì`): the
 * sandhi only fires when 一 is the whole number, standing alone in front of
 * the unit.
 */
function numberAndUnitPinyin(n: number, word: string, unit: string): string {
  const syllables = Array.from(word).map((ch) => DIGIT_PINYIN[ch] ?? ch);
  if (n === 1 && unit === '日') syllables[0] = 'yí';
  syllables.push(UNIT_PINYIN[unit]);
  return syllables.join(' ');
}

/**
 * The card for a numeral-plus-unit run that DATE_PART_RE left alone: `1月` on
 * its own line, not the `9月8日` a date rule already ate. `null` when the run
 * is not `月`/`日`/`号`, the digits in front of it are not a plain trailing
 * number, or the number is out of range for what that unit can mean.
 *
 * `list` gates this on the same signal the caller already computed
 * (`!options.prose` in extractFromLine): a sentence that happens to contain a
 * date fragment is not this function's problem, and the safety of DATE_PART_RE
 * itself does not depend on prose vs list at all.
 */
const NUMBERED_SINGLE_CHAR_RE = new RegExp(
  `[0-9]([${CJK_CLASS}])(?![${CJK_CLASS}])`,
  'g'
);

/**
 * True when the calendar rule may fire ON THIS PASTE at all: a WHOLE-PASTE
 * question, asked once, because a single run cannot answer it.
 *
 * THE BUG THIS EXISTS FOR. `1日 2月 3水 4火 5木` is the first set of characters a
 * Chinese class learns, and numbering a list with no separator is the commonest
 * way a teacher types one. Measured 2026-09-08: it came back as
 * `["1日","2月","水","火","木"]`, so the child was asked "the 1st" for 日 and
 * "February" for 月 while items three to five stayed right. Half a game wrong
 * reads as random rather than as one broken rule.
 *
 * A months lesson and a numbered character lesson have the SAME shape run by
 * run, and they are separable only by the whole paste: in a months lesson every
 * digit-fronted single character is a calendar unit; in a character lesson the
 * same numbering also fronts 水, 火, 木. So the rule fires only when every one
 * of them is 月, 日 or 号. That keeps fixtures 48 and 49 and kills this.
 *
 * The RANGE is deliberately not checked here (`0月`, `32号`), because that is
 * monthOrDayCard's job per run; this decides whether to ask it at all.
 *
 * What this refuses when its assumption is wrong: a real calendar lesson with
 * one numbered non-calendar character in it (`1月 2月 3课`) makes no calendar
 * cards and falls back to what main did. That loses a reading and a gloss the
 * teacher never typed; the other direction rewrote characters she did type.
 */
function calendarCardsFit(body: string): boolean {
  NUMBERED_SINGLE_CHAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBERED_SINGLE_CHAR_RE.exec(body)) !== null) {
    if (isLessonOrdinalAt(body, m.index)) continue;
    if (m[1] !== MONTH_CHAR && !DAY_CHARS.has(m[1])) return false;
  }
  return true;
}

/**
 * True when the digit at `digitIndex` is the tail of a lesson ordinal: the `1`
 * of `第1课`, `第2周`, `第10页`.
 *
 * THE BUG THIS EXISTS FOR. `第N课` is the single commonest way a Chinese lesson
 * is headed, and it puts a digit in front of a single character, which is
 * exactly the shape `calendarCardsFit` refuses on. Measured 2026-09-08:
 * `第1课：1月 2月 3月` came back as `["第","课","月"]` - three months collapsed
 * into one card - while `第一课：1月 2月 3月` was perfect. Whether her lesson
 * worked came down to which numeral she typed.
 *
 * An ordinal is not a list token. `第` is what says so: nothing else in a
 * numbered LIST puts that character in front of the number, and the gate is
 * about what the teacher NUMBERED, not about what a header calls itself.
 */
function isLessonOrdinalAt(body: string, digitIndex: number): boolean {
  let i = digitIndex;
  while (i > 0 && body.charCodeAt(i - 1) >= 48 && body.charCodeAt(i - 1) <= 57) i--;
  // ONE SPACE IS ALLOWED BETWEEN 第 AND THE NUMBER, and no more. `第 1课` is the
  // same heading as `第1课`, and demanding them glued reopened the collapse this
  // function exists to stop (round-4 panel: `第 1课：1月 2月 3月` -> `第 课 月`).
  if (i > 0 && (body[i - 1] === ' ' || body[i - 1] === '　')) i--;
  return i > 0 && body[i - 1] === '第';
}

function monthOrDayCard(
  run: CjkRun,
  list: boolean
): { zh: string; pinyin: string; en: string } | null {
  if (!list || Array.from(run.zh).length !== 1) return null;
  const m = /([0-9]{1,3})$/.exec(run.before);
  if (!m) return null;
  const n = Number(m[1]);

  if (run.zh === MONTH_CHAR && n >= 1 && n <= 12) {
    return {
      zh: m[1] + run.zh,
      pinyin: numberAndUnitPinyin(n, chineseNumberWord(n), run.zh),
      en: MONTH_NAMES[n - 1],
    };
  }
  if (DAY_CHARS.has(run.zh) && n >= 1 && n <= 31) {
    return {
      zh: m[1] + run.zh,
      pinyin: numberAndUnitPinyin(n, chineseNumberWord(n), run.zh),
      en: ordinal(n),
    };
  }
  return null;
}

/**
 * A note she put in brackets right after a word: `\u82f9\u679c\uff08\u6c34\u679c\uff09`, `\u8001\u5e08\uff08\u4eba\uff09`.
 *
 * Probed live 2026-09-08: `\u82f9\u679c\uff08\u6c34\u679c\uff09\u9999\u8549\uff08\u6c34\u679c\uff09\u8001\u5e08\uff08\u4eba\uff09` came back with \u6c34\u679c
 * and \u4eba as cards of their own, so a game about fruit asked the class what
 * "fruit" means. Bracketed PINYIN was already read as a reading
 * (extractBracketPinyin in parse.ts) and bracketed ENGLISH is still read as her
 * gloss; bracketed CHINESE had no rule at all, so it fell through to the run
 * splitter as ordinary vocabulary.
 *
 * Q5 of docs/research/2026-09-08-onboarding-probe-round2.md, answered yes: a
 * teacher who means a word to be on the card does not put it in brackets.
 *
 * THREE THINGS MAKE THIS SAFE.
 *   - The INSIDE must be Chinese and nothing else, so `(apple)`, `(p\u00edng gu\u01d2)`
 *     and `(fruit, \u6c34\u679c)` are all untouched and keep working exactly as before.
 *   - A CHINESE CHARACTER MUST COME FIRST. `\uff08\u6c34\u679c\uff09` alone on a line has no
 *     word to be a note about, so it is left alone rather than deleted.
 *   - Every quantifier is bounded. An unbounded one in front of a required
 *     character is what turned a line of 60000 spaces into seconds; the test
 *     that caught that is still watching this file.
 *
 * The bracket becomes a space, never nothing, so the words on either side of it
 * stay two separate runs. NFKC has already folded \uff08\uff09 to (); \u3010\u3011 and \u3014\u3015 are
 * not folded, so they are named.
 */
const CJK_ASIDE_RE = new RegExp(
  `([${CJK_CLASS}])[ \\t]{0,3}[(\\uff08\\u3010\\u3014]` +
    `[${CJK_CLASS}][${CJK_CLASS}\\u3001\\uff0c, \\t]{0,19}` +
    `[)\\uff09\\u3011\\u3015]`,
  'g'
);

/**
 * The classifiers a teacher's measure-word lesson actually uses. CC-CEDICT
 * records classifiers per noun (`CL:\u672c[ben3]`) but the shipped asset drops that
 * column (see pickGloss in shared/cedict.ts), so the set is written out here.
 *
 * It is a SET rather than "any character", because any character would read
 * `\u4e09\u70b9\u534a` and `\u4e00\u53e3\u6c14` as counted nouns.
 */
const CLASSIFIERS = new Set(
  Array.from('\u4e2a\u672c\u652f\u53ea\u5f20\u6761\u4ef6\u676f\u74f6\u5757\u4f4d\u8f86\u53cc\u628a\u53f0\u5ea7\u5bb6\u95f4\u5934\u5339\u9897\u68f5\u6735\u5c01\u7bc7\u9996\u5e45\u573a\u8282\u95e8\u53e3\u540d')
);

/** The numbers that can sit in front of a classifier, including \u4e24 and \u534a. */
const COUNT_CHARS = new Set(Array.from('\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u4e24\u51e0\u534a0123456789'));

/**
 * The head noun of a measure-word phrase: `\u4e00\u672c\u4e66` -> `\u4e66`, `\u4e09\u4e2a\u82f9\u679c` -> `\u82f9\u679c`.
 * Returns null when the run is not number + classifier + noun.
 *
 * Probed live 2026-09-08: `\u4e00\u672c\u4e66 \u4e00\u652f\u7b14 \u4e09\u4e2a\u82f9\u679c \u4e24\u53ea\u732b` came back holding ONE
 * card, \u82f9\u679c, because \u4e66, \u7b14 and \u732b are single characters and a single character
 * the SEGMENTER produced is dropped as a leftover (extractFromLine). That drop
 * is right in general: it is what keeps a half-read chunk off the cards. It is
 * wrong here, because the counter in front of the noun tells us exactly where
 * the word is.
 *
 * Q4 of docs/research/2026-09-08-onboarding-probe-round2.md, answered HEAD NOUN
 * for now. JJ may later prefer the whole phrase (`\u4e00\u672c\u4e66`), which is what she
 * typed and what a measure-word lesson is about, at the price of needing
 * /api/enrich for the English. THAT SWITCH IS THE ONE `return` BELOW: return
 * `run` instead of `noun` and every caller changes with it.
 *
 * The noun must be a word THE DICTIONARY KNOWS, so this can never invent a card
 * out of a run it merely failed to segment.
 */
export function measureWordPhrase(run: string, dict: ExtractDict | null): string | null {
  if (!dict) return null;
  const chars = Array.from(run);
  // At least one number, one classifier and one noun character.
  if (chars.length < 3 || chars.length > 2 + MAX_WORD_CHARS) return null;

  let i = 0;
  while (i < chars.length && COUNT_CHARS.has(chars[i])) i++;
  if (i === 0) return null;
  if (i >= chars.length || !CLASSIFIERS.has(chars[i])) return null;

  const noun = chars.slice(i + 1).join('');
  if (noun === '' || !dict.lookup(noun)) return null;
  // Switch to `return run;` to put the whole phrase on the card instead.
  return noun;
}

/**
 * True when two forms are the same dictionary entry written two ways: `\u82f9\u679c`
 * and `\u860b\u679c`, `\u8001\u5e08` and `\u8001\u5e2b`.
 *
 * The shipped asset does not keep a simplified-to-traditional column: buildDict
 * (shared/cedict.ts) adds the traditional headword POINTING AT THE SAME VALUE
 * as the simplified one, so the pair is recognised by both halves resolving to
 * the same reading AND the same gloss. That is also the right test for the case
 * the pair is not a script pair at all but two spellings of one word.
 */
function isSameEntry(a: string, b: string, dict: ExtractDict | null): boolean {
  if (!dict || a === b) return false;
  const ha = dict.lookup(a);
  const hb = dict.lookup(b);
  if (!ha || !hb) return false;
  return ha.pinyin === hb.pinyin && ha.en === hb.en;
}

/**
 * The titles at the top of a Chinese word table: the row a teacher gets free
 * when she copies out of Excel, Google Sheets or a textbook glossary.
 *
 * Probed live 2026-09-08: `\u5e8f\u53f7 / \u751f\u8bcd / \u62fc\u97f3 / \u82f1\u6587` arrived as the first four
 * cards of the game. The English titles (`Word`, `Pinyin`, `English`) were
 * already caught by LABELLED_LINE_RE; the Chinese ones had nothing.
 */
const COLUMN_TITLES = new Set([
  '\u5e8f\u53f7', '\u5e8f\u865f', '\u7f16\u53f7', '\u7de8\u865f', '\u5e8f', '\u53f7', '\u865f',
  '\u751f\u8bcd', '\u751f\u5b57', '\u65b0\u8bcd', '\u5355\u8bcd', '\u55ae\u8a5e', '\u8bcd\u8bed', '\u8a5e\u8a9e', '\u8bcd', '\u8a5e', '\u6c49\u5b57', '\u6f22\u5b57',
  '\u4e2d\u6587', '\u62fc\u97f3', '\u8bfb\u97f3', '\u8b80\u97f3', '\u6ce8\u97f3', '\u82f1\u6587', '\u82f1\u8bed', '\u82f1\u8a9e', '\u610f\u601d', '\u89e3\u91ca', '\u89e3\u91cb',
  '\u7ffb\u8bd1', '\u7ffb\u8b6f', '\u91ca\u4e49', '\u91cb\u7fa9', '\u8bcd\u6027', '\u8a5e\u6027', '\u4f8b\u53e5', '\u7b14\u753b', '\u7b46\u756b', '\u90e8\u9996',
  'no', 'no.', '#', 'word', 'term', 'pinyin', 'english', 'meaning', 'definition',
  'translation', 'chinese', 'characters', 'example',
]);

/**
 * True when every field on this line is a column title and there are at least
 * THREE of them. This is the SHAPE of a header row. It is not proof of one: see
 * isColumnTitleRow, which is the rule that actually decides.
 *
 * Tabs and pipes are the separators when the line has any. When it has none,
 * the fields are split on spaces, because a teacher copying a table out of a
 * PDF or a Word document gets spaces (`\u5e8f\u53f7 \u751f\u8bcd \u62fc\u97f3 \u82f1\u6587`), which is the
 * shape the bug report actually named.
 *
 * WHY THREE AND NOT TWO. Measured 2026-09-08: `\u8bcd\tword` over `\u62fc\u97f3\tpinyin` over
 * `\u82f9\u679c\tapple` returned ONE card. A two-field pair of title words is what an
 * ordinary row of a glossary about words looks like, and the context test
 * (first line, content below) cannot tell the two apart because a mixed
 * glossary passes it. Dropping row one cost TWO cards, not one: it promoted
 * `\u62fc\u97f3\tpinyin` to the first row, where parse.ts's own first-row header filter
 * took it as well. Every header this rule was written for has four fields
 * (fixtures 43 and 51); a glossary row has two.
 *
 * WHAT THIS REFUSES WHEN ITS ASSUMPTION IS WRONG, stated so the next round does
 * not flip it back silently: a genuine two-column header (`\u751f\u8bcd\t\u82f1\u6587`) is no
 * longer recognised HERE. Measured 2026-09-08, that exact paste still comes
 * back as `["\u82f1\u6587"]`, because parse.ts's own first-row filter takes the \u751f\u8bcd
 * side, so the cost is at most one junk card and in the shape probed it is
 * none. Priced deliberately either way: one junk card the teacher can delete is
 * recoverable; two words she typed and never saw again are not.
 */
function isAllColumnTitles(line: string): boolean {
  // Split on the column characters THEMSELVES and trim after, never on
  // `\s*\|\s*`: an unbounded quantifier in front of a required character is
  // retried from every position and costs seconds on a line of 60000 spaces.
  const parts = /[\t|]/.test(line) ? line.split(/[\t|]/) : line.split(/[ \u3000]/);
  const fields = parts
    .map((f) => f.trim().replace(/[:\uff1a]$/, ''))
    .filter((f) => f !== '');
  if (fields.length < 3) return false;
  return fields.every((f) => COLUMN_TITLES.has(f.toLowerCase()));
}

/** What a line cannot know about itself: where it sits in the paste. */
export interface HeaderContext {
  /** Nothing but blank lines came before it. */
  isFirstContent: boolean;
  /** Some line below it is NOT another row of column titles. */
  hasContentBelow: boolean;
}

const HEADER_ANYWHERE: HeaderContext = { isFirstContent: true, hasContentBelow: true };

/**
 * True when a line is the title row at the top of her table.
 *
 * WHAT THE SHAPE ALONE DOES NOT TELL YOU, and the reason this needs context:
 * in a two-column glossary the words for word, pinyin, meaning and example are
 * THEMSELVES the vocabulary. `\u8bcd\tword` is an ordinary row of a lesson about
 * how to talk about words, and "every field is a title" is exactly what that
 * row looks like. Measured 2026-09-08: the shape test alone returned nothing
 * at all for a four-row glossary of `\u8bcd / \u62fc\u97f3 / \u610f\u601d / \u4f8b\u53e5`.
 *
 * So a title row has to be BOTH the first thing in the paste AND have a row
 * under it that is not another rack of titles. A glossary fails the second
 * test (every row is titles), a `\u4e2d\u6587\tChinese` on its own fails it too (there
 * is nothing under it), and `\u4e2d\u6587 | Chinese` as the second row of a paste
 * fails the first. Her spreadsheet header (`\u5e8f\u53f7 \u751f\u8bcd \u62fc\u97f3 \u82f1\u6587` over three
 * numbered rows) passes both, which is the one case this rule is for.
 */
function isColumnTitleRow(line: string, ctx: HeaderContext): boolean {
  if (!ctx.isFirstContent || !ctx.hasContentBelow) return false;
  return isAllColumnTitles(line);
}

/**
 * The Chinese half of the same paperwork: the title a teacher puts on her own
 * list. `第一课生词`, `生词表`, `第三单元词汇`.
 *
 * The segmenter reads a title as vocabulary, because that is all it can do:
 * `第一课生词` came out as the word 第一, and `第三单元词汇` as 单元 and 词汇.
 * Those then went onto the cards of a game about fruit.
 *
 * Same safety property as the English patterns, reached a different way: this
 * can never eat a real word because it demands a WHOLE LINE that is a unit
 * marker (`第三单元`), a word-list noun (`生词表`, `词汇`), or one followed by
 * the other, and nothing else. `这周的生词：苹果 香蕉` has a list on it, so it
 * does not match and is read as usual.
 */
/**
 * WHAT THE UNIT AFTER 第N SAYS ABOUT THE MARKER, split in two because the two
 * halves answer the paperwork question in OPPOSITE directions. Round 9, F2.
 *
 * A DOCUMENT-STRUCTURE unit names a part of the handout: 第1课, 第一页, 第1章,
 * 第1节, 第1单元, 第1部分. A run of them with no gloss anywhere is a contents
 * page and holds no vocabulary at all, which is the deliberate empty answer
 * fixture 68 stands for.
 *
 * An ORDINAL-VOCABULARY unit names something the CLASS counts: 第一天, 第二周,
 * 第一次, 第一名, 第一年, 第一月, 第一个. Those are ordinary HSK words a teacher
 * types as her list. Measured by Codex on 44d2a41 against the real
 * public/cedict.json: `第1天 第2天` and `第一天 第二天` came back with NO cards
 * and `paperworkOnly`, which is worse than an ordinary empty answer because it
 * also tells the worker the empty was deliberate and refuses the rescue.
 * Fixtures 64 and 69 are the same words with an English gloss beside them and
 * they make five cards each, so the gloss she happened to type was the only
 * thing separating a card from an empty screen.
 *
 * BOTH HALVES ARE STILL HEADING UNITS ON A LINE WITH A LIST AFTER THEM. The
 * split decides paperwork-versus-vocabulary for a BARE marker only; `第2周 1月
 * 2月` and `第1天 苹果 香蕉` are headings over her list exactly as they were
 * before (M1, rounds 4 to 7), because there the words after the marker are the
 * lesson and the marker is what she is calling it.
 */
// The four constants below are DEFINED IN parse.ts and imported at the top of
// this file, because parse.ts needs them too (its column rule drops a lesson
// column) and it cannot import from here without a cycle. The argument for the
// two-list split is the comment above; the data is over there.
//
// ONE OPTIONAL SPACE AFTER 第 in ORDINAL_STEM. `第 1课：1月 2月 3月` returned
// `["第","课","月"]` on every tree up to and including 695cd85: the exact
// r3-MF1 collapse, reopened by one keystroke. A teacher who spaces her lesson
// number is writing the same heading.
const CJK_HEADING_UNIT =
  `${ORDINAL_STEM}(?:${[...DOC_STRUCTURE_UNITS, ...ORDINAL_VOCAB_UNITS].join('|')})`;
/** The same marker, restricted to the units that mean a part of a document. */
const CJK_DOC_STRUCTURE_UNIT = `${ORDINAL_STEM}(?:${DOC_STRUCTURE_UNITS.join('|')})`;
const CJK_HEADING_TOPIC =
  '(?:生词|生字|新词|单词|词汇|词语|词)表?|课文';
/**
 * EVERY GAP IN THE HEADING PATTERN IS BOUNDED, AND THAT IS LOAD-BEARING.
 *
 * This used to be `\s*` three times over in front of a REQUIRED topic. On a
 * line that never supplies the topic the engine has to try every partition of
 * the whitespace between them, and `'第1课' + 60,000 spaces + 'x'` (60,008
 * bytes, comfortably under the worker's 64 KB accept cap) cost 5,653 ms on
 * main, 9,018 ms at 2ebc5e8 and 10,077 ms at 695cd85. It is an availability
 * bug, not a card bug: one paste holds a request thread for ten seconds.
 *
 * A heading is written with ONE space, or none. Eight is already generous, and
 * a bounded run cannot backtrack more than 8 ways per gap. The line is trimmed
 * before it gets here, so leading and trailing whitespace never reaches this.
 * `tests/extract.test.ts` asserts that exact 60,000-space line under 200 ms;
 * the sibling assertion above cannot see this pattern because its line starts
 * with `Unit`, which is not a Chinese heading unit.
 */
const CJK_HEADING_GAP = '[ \\t\\u3000]{0,8}';
const CJK_HEADING_RE = new RegExp(
  `^(?:${CJK_HEADING_UNIT})?${CJK_HEADING_GAP}(?:的)?${CJK_HEADING_GAP}` +
    `(?:${CJK_HEADING_TOPIC})${CJK_HEADING_GAP}[:\\uff1a]?$` +
    // A MARKER ALONE ON A LINE IS A HEADING ONLY WHEN ITS UNIT NAMES PART OF A
    // DOCUMENT. `第2课` on its own is the top of a lesson; `第二天` on its own is
    // a word (round 9, F2). The first branch above keeps the full unit set,
    // because it also demands a word-list topic (`第三单元词汇`), which nothing
    // she means as vocabulary is written with.
    `|^(?:${CJK_DOC_STRUCTURE_UNIT})${CJK_HEADING_GAP}[:\\uff1a]?$`
);

/**
 * `日期：9月 8日`. A label that says "date" over a body that is nothing but a
 * date, which is the top of a worksheet rather than anything to learn.
 *
 * IT IS HERE BECAUSE OF THE PRICE OF A DIFFERENT FIX. Round 4 removed
 * `MONTH[ \t]?DAY` from DATE_PART_RE, which was the right call (it is what
 * stopped round 3 deleting the real months out of a months lesson), but it
 * means a SPACED date is now read as two cards: measured on 695cd85,
 * `日期：9月 8日` over a word list added 日期, 9月 AND 8日. This takes the line
 * off before the segmenter ever sees it.
 *
 * THE BODY HAS TO BE A DATE, character by character: digits, the calendar units
 * 年月日号, a Chinese numeral, 星期 or 周, and the separators between them. That
 * is what keeps it from eating a word. `日期：苹果 香蕉` holds 苹, which is in
 * none of those, so it is not a date line and stays her vocabulary. Every gap
 * is bounded for the reason CJK_HEADING_RE's are.
 */
const CJK_DATE_LINE_RE = new RegExp(
  '^日期[ \\u3000]{0,8}[:\\uff1a][ \\u3000]{0,8}' +
    '(?:[\\d年月日号/.\\- \\u3000\\t]|星期|周|[一二三四五六七八九十]){1,40}$'
);

/**
 * The same unit marker when the teacher put her list on the SAME line as it:
 * `第1课：1月 2月 3月`, `第2周 1月 2月`, `第5页 苹果 香蕉`.
 *
 * `第一课` on a line of its own has been paperwork since the rule above existed.
 * On a line with words after it, it was not, so it went to the segmenter and
 * came back as cards: measured 2026-09-08, `第5页 苹果 香蕉` yielded 第 and 页
 * and `第一单元 苹果 香蕉` yielded 第一 and 单元, both in a game about fruit. The
 * Arabic-numeral form was worse than junk - the digit cut the line into two
 * single-character runs, and that shape then switched the calendar rule off for
 * the whole paste (see isLessonOrdinalAt).
 *
 * A LEADING marker only, and only with something left after it. That is what
 * keeps it from eating a real word: 第 plus a number plus a unit plus more text
 * is a heading in front of a list, and nothing else is written that way.
 *
 * WHAT SEPARATES THE MARKER FROM WHAT FOLLOWS DECIDES WHETHER IT IS A HEADING
 * AT ALL. The first version used `\s*`, which eats a TAB, and a tab does not
 * mean "and here is the list", it means "and here is the English for the word
 * I just typed". So `第一天<TAB>the first day` was read as a heading over a
 * list called `the first day`, and a whole glossary of 第一天 / 第二天 / 第三章
 * came back EMPTY (round-4 panel; every one of them worked on main). 第一天,
 * 第三章 and 第一节 are ordinary HSK vocabulary, and TERM-TAB-GLOSS is the
 * Quizlet and Anki export shape this onboarding is built around.
 *
 * A heading is therefore followed by A SPACE OR A COLON and then her list:
 *
 *   第1课：1月 2月 3月   colon. Heading.
 *   第2周 1月 2月        space. Heading.
 *   第一课的生词：苹果   `的` GLUED to the marker. Heading, the possessive form.
 *   第一天<TAB>the first day   a column separator. HER WORD, with its gloss.
 *   第一天,the first day       a CSV gloss. HER WORD.
 *   第一天|the first day       the same row again. HER WORD.
 *
 * `的` has to be GLUED for the same reason. Floating on `\s*` it swallowed a
 * one-character word: `第1课 的 了 过` (a grammar-particles lesson) returned
 * `了 过`, while `第1课：的 了 过` returned all three, so whether she kept 的
 * depended on whether she typed the colon. Glued, it only ever matches the
 * possessive the examples above are written with.
 *
 * The space run is left unbounded on purpose: it is a single quantifier in
 * front of a lookahead, so it matches greedily once and never backtracks
 * (`第1课` + 60,000 spaces + `x` measured at 1 ms). The bounded gaps live in
 * CJK_HEADING_RE, where a REQUIRED token follows and backtracking is real.
 */
const CJK_HEADING_PREFIX =
  `(?:${CJK_HEADING_UNIT})(?:的|[ \\u3000]{0,8}[:\\uff1a][ \\u3000]*|[ \\u3000]+)(?=\\S)`;
/**
 * THE SAME PATTERN, ASKED AT A POSITION instead of at the front of a fresh
 * string. The stripping loop used to rebuild the whole remaining line on every
 * pass (`rest = rest.replace(...)`), so a run of 16,384 markers copied 64 KB
 * 16,384 times. Sticky plus `lastIndex` asks the same question in place. It
 * carries no `^`: with `y` the engine already refuses to start anywhere but
 * `lastIndex`, and a `^` would additionally demand position 0.
 */
const CJK_HEADING_PREFIX_AT_RE = new RegExp(CJK_HEADING_PREFIX, 'y');

/**
 * The last question the pattern above cannot answer: after a bare SPACE, is
 * what follows her LIST or her GLOSS?
 *
 * Round 4 took the tab out of the separator and reopened the identical hole one
 * keystroke over. A space is the commonest term-gloss separator a teacher
 * types - a two-column Word or PDF table pastes as spaces, and so does anything
 * hand-typed - so `第一天 the first day` was read as a heading over a list
 * called `the first day`, and a whole glossary came back EMPTY again (round-5
 * panel: 0 cards, needsRescue true, straight to the paid model; every row works
 * on main). Mixed into a fruit list it was worse: the row vanished with no
 * signal at all.
 *
 * WHAT FOLLOWS THE SPACE DECIDES IT. A heading is followed by the Chinese list
 * it is a heading FOR; a glossed row is followed by the English she wrote for
 * the word. So:
 *
 *   第一课 你好 谢谢      Chinese after the space. HEADING.
 *   第1课 1月 2月 3月     Chinese after the space. HEADING.
 *   第一天 the first day  no Chinese after the space. HER WORD, with its gloss.
 *   第一天 - the first day  the same, with a dash column between them.
 *
 * A COLON OR A GLUED 的 IS NEVER ASKED. `第1课：...` and `第一课的生词：...` are
 * written that way only as headings, whatever follows them, and that is what
 * keeps `第1课：the first lesson` working.
 *
 * THE NUMERAL DOES NOT DECIDE IT, AND THAT QUESTION IS CLOSED. Round 6 shipped
 * the rule above. Round 7 reversed it for Arabic digits: `第1课 Lesson one` came
 * back holding 第 and 课 (measured a67b4c7 and main), so the marker was called a
 * heading whenever the number was written in digits, and the row was thrown
 * away. Round 7's own panel then measured the price on the twin shape
 *
 *   第1天 the first day        (x5, an ordinary day glossary)
 *
 * which went from five right cards to ZERO, needsRescue true, and a rescue that
 * cannot recover it either (validateRescue rejects any word with a digit in it).
 * Two consecutive rounds reversing each other means the question is not
 * decidable from the evidence in front of it, so it is not decided on evidence.
 *
 * RECOVERABILITY DECIDES IT: WHAT SHE TYPED AS A PAIR STAYS A PAIR. Deleting an
 * unwanted card on the edit table is one click. Retyping a card the reader threw
 * away costs her the typing she already did, and an empty answer that buys a
 * paid rescue is worse than both - quota spent and still nowhere. So a marker
 * with a gloss beside it is her card, whichever numeral she wrote, and it is
 * never shattered into 第 + 课 (extractFromPaste keeps the whole marker as the
 * term; see BARE_ORDINAL_MARKER_RE at its call site).
 *
 *   第1课 Lesson one / 第2课 Lesson two   -> two cards, her two glosses
 *   第1天 the first day (x5)              -> five cards
 *   第一天 the first day                  -> unchanged, fixture 64
 *
 * The paperwork case is the one with NO gloss anywhere: a bare run of markers
 * and nothing else (`第1课 第2课`). That holds no vocabulary at all, so it is
 * answered with no cards and `paperworkOnly`, and never bought. See
 * isMarkerRunOnly.
 *
 * THE DICTIONARY CANNOT ANSWER THIS EITHER, which is worth keeping because it
 * is the obvious first idea. Neither 第一天 nor 第三章 nor 第一课 is a CC-CEDICT
 * headword (checked against the shipped public/cedict.json), so "keep it if the
 * dictionary knows it" would empty fixture 64, the exact glossary round 5 was
 * fixed to save.
 *
 * IT IS ASKED HERE AND NOT IN THE REGEX ON PURPOSE. The obvious fix is a
 * lookahead on the space branch, `[ 　]+(?=[^\n]*[CJK])`. That reopens the
 * ReDoS round 4 closed: the lookahead rescans the tail from every position the
 * unbounded space run can end at, and `第1课` + 60,000 spaces measured 7,771 ms
 * with it (round-5 panel) against ~8 ms without. Out here the same question is
 * one linear walk of the line, asked once per line.
 *
 * IT IS SPLIT IN TWO because the two halves cost different amounts. The marker
 * itself is a handful of characters and is re-read for every marker; the tail
 * is the whole rest of the line and is read once. See the loop in stripHeaders.
 */
function markerSaysHeading(marker: string): boolean {
  return /[的:：]/.test(marker);
}

/**
 * The other half of the same question: after a bare SPACE, is there Chinese
 * left on the line that is not itself a marker?
 *
 * A bare space and no Chinese after it is her word and its English gloss,
 * whichever numeral she used. See the round 6 / round 7 note above: this is
 * the one line the two rounds kept flipping, and it is now held by the
 * recoverability argument rather than by a signal in the paste.
 *
 * ANOTHER MARKER FURTHER ALONG THE LINE IS NOT "her list". Round 9, F1: on
 * `第1课 Lesson one 第2课 Lesson two` the raw hasCJK test saw the 第2课 at the
 * far end, called the whole tail a Chinese list, and threw her first row
 * away - measured 第/but, 课/subject on 44d2a41. Each marker owns the tokens
 * up to the NEXT marker, so the markers themselves are taken out of this
 * question before it is asked.
 *
 * IT WALKS THE LINE FROM `from` AND NEVER BUILDS A STRING. It used to join the
 * surviving tokens back together only to ask whether any character in them was
 * Chinese; the caller asked it once per stripped marker, and the two together
 * were the 11.8 s (round 10, F5).
 */
function hasCJKOutsideBareMarkers(text: string, from: number): boolean {
  const token = /[^\s　]+/g;
  token.lastIndex = from;
  for (let m = token.exec(text); m !== null; m = token.exec(text)) {
    if (!BARE_ORDINAL_MARKER_RE.test(m[0]) && hasCJK(m[0])) return true;
  }
  return false;
}

/**
 * The tokens of `text` that are not whole DOC-STRUCTURE markers, rejoined.
 *
 * The rescue counter uses this. `第1课 第2课 苹果` is one card (苹果) with six
 * Chinese characters around it, so the raw count cleared RESCUE_MIN_CJK and
 * bought a model call on a paste that had already been read correctly and can
 * never make a game anyway (r8 SF-B, a money path). A lesson number holds no
 * vocabulary, so it is not evidence that there is vocabulary left to find.
 *
 * DOC-STRUCTURE ONLY, not every 第N marker: `第1天` can be the word she meant,
 * so its characters still count and a paste of those still gets its rescue.
 */
export function withoutDocStructureMarkers(text: string): string {
  return text
    .split(/[\s\u3000]+/)
    .filter((t) => t !== '' && !BARE_DOC_STRUCTURE_MARKER_RE.test(t))
    .join(' ');
}

/**
 * The line Quizlet prints directly above the set itself.
 *
 * Everything above it is the page, not the set: the flashcard sample, the
 * "Study with Learn" question, and a sidebar of OTHER teachers' sets. On
 * fixture 78 that sidebar put 中国古代哲学 and 哥林多后书 on cards.
 */
const QUIZLET_SET_ANCHOR_RE = /^Terms in this set \(\d+\)$/;

/**
 * The chrome Quizlet prints between the words, anywhere on the page. Every one
 * of these is a whole line on its own, so they are matched whole and never
 * searched for inside a line the teacher typed.
 */
const QUIZLET_CHROME_RE =
  /^(?:\d+ \/ \d+|\d[\d,]* terms?|Preview|Teacher|Study with Learn|Choose an answer|Don[’']t know\?)$/;

/** The one chrome line that carries a trailing emoji, so it is read as a prefix. */
const QUIZLET_FLIP_PREFIX = 'Click the card to flip';

/**
 * A whole Quizlet page, cut down to the set the teacher meant to copy.
 *
 * ONE PASS OVER THE LINES, and every test is anchored at both ends against a
 * single trimmed line: the 64 KB shapes the round-10 and round-11 panels found
 * were all loops that re-scanned a growing remainder, and this cannot do that.
 *
 * The text comes back UNCHANGED, character for character, when the page holds
 * no chrome at all, so the other 77 pastes reach the readers below exactly as
 * the teacher typed them.
 */
export interface QuizletPageReading {
  /** The paste with the page around the set removed, or the paste untouched. */
  text: string;
  /**
   * What was cut, in one line she can read. Empty when nothing was cut.
   *
   * A NOTE, NOT AN UNREAD LINE: it is a count of the sidebar, and the review
   * screen prints unread lines under "We could not read N lines".
   */
  notes: string[];
}

export function withoutQuizletChrome(text: string): QuizletPageReading {
  const lines = text.split(/\r\n|\r|\n/);
  // The FIRST anchor, not the last. Taking the last one deleted every earlier
  // set on a page that carries two of them, and a trailing anchor with nothing
  // under it emptied the paste outright (round 1 review). From the first anchor
  // on, every anchored section is still in the text; the anchor LINES themselves
  // drop below as chrome, and the collector dedupes terms a page repeats.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (QUIZLET_SET_ANCHOR_RE.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  // NO ANCHOR, NO PAGE, NOTHING TOUCHED. Without the anchor there is no proof
  // this came off Quizlet at all, and the words alone are not proof: `Teacher`,
  // `Preview` and `12 terms` are three things a teacher may well have typed
  // above her own list. Deleting them here deleted them SILENTLY - main reported
  // all three as skipped and this branch reported nothing (round 2 review,
  // must-fix 3). With no anchor they go down the ordinary path, which is the
  // reader that knows how to report a line it could not use.
  if (start < 0) return { text, notes: [] };
  const kept: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (QUIZLET_CHROME_RE.test(t) || QUIZLET_SET_ANCHOR_RE.test(t) || t.startsWith(QUIZLET_FLIP_PREFIX)) {
      continue;
    }
    kept.push(lines[i]);
  }
  // AND WHAT WAS ABOVE THE ANCHOR IS REPORTED, not vanished. It is a sidebar of
  // other people's sets and can run to a hundred lines, so it is reported as one
  // count rather than a hundred entries she has to read past.
  //
  // `start` is the line AFTER the anchor, so what was above the anchor is one
  // line fewer than that. The count used to be `start`, which counted the anchor
  // itself and told a teacher whose page begins with `Terms in this set (51)`
  // that one line was skipped when none was (round 3 review, must-fix 5).
  const above = start - 1;
  return {
    text: kept.join('\n'),
    notes:
      above === 0
        ? []
        : [
            above === 1
              ? '1 line above the Quizlet word list was skipped'
              : `${above} lines above the Quizlet word list were skipped`,
          ],
  };
}

/**
 * A 第N marker on its own, with nothing glued to either end.
 *
 * Used for the two ends of the round 7c decision: the paperwork test below
 * (a paste that is nothing but these), and the structured path, where it is
 * what keeps `第1课` on one card instead of shattering into 第 + 课.
 */
const BARE_ORDINAL_MARKER_RE = new RegExp(`^(?:${CJK_HEADING_UNIT})$`);
/**
 * The same, restricted to the units that name a part of a document. Defined in
 * parse.ts (its column rule needs it) and re-exported here so this file stays
 * the place the reasoning lives.
 */
export { BARE_DOC_STRUCTURE_MARKER_RE };

/**
 * THE GLOSS STYLE FOR A BUILT ORDINAL CARD IS `day 1`, and it is one noun per
 * unit plus the number. `the first day` was the other candidate and it needs an
 * English ordinal table that runs out (第10天 -> "the tenth day"), while this
 * form reads the same at 1 and at 31 and can never be half-built. The teacher's
 * own gloss always wins over it: this is only ever offered where she wrote none.
 */
const ORDINAL_VOCAB_NOUN: Record<string, string> = {
  天: 'day', 周: 'week', 週: 'week', 名: 'place',
  次: 'time', 年: 'year', 月: 'month', 个: 'item', 個: 'item',
};
/** Readings for the same units. Static, for the reason DIGIT_PINYIN is static. */
const ORDINAL_VOCAB_PINYIN: Record<string, string> = {
  天: 'tiān', 周: 'zhōu', 週: 'zhōu', 名: 'míng',
  次: 'cì', 年: 'nián', 月: 'yuè', 个: 'gè', 個: 'gè',
};

/** The cap on both spellings. See `ordinalNumberValue`. */
const ORDINAL_MAX = 999;

/**
 * `1` -> 1, `一` -> 1, `十二` -> 12, `二十` -> 20, `三十一` -> 31, `一百` -> 100,
 * `一百零一` -> 101, `一百二十三` -> 123, `九百九十九` -> 999. `null` outside
 * 1-999.
 *
 * THE CAP IS 999 AND IT IS A REAL CAP: `第1000天` and `第一千天` come back null.
 * 999 is where a teacher's numbering stops in practice (a 100-day challenge
 * list, a 365-day calendar) and going further would mean a 万/亿 reader for
 * numbers nobody counts lessons in. What matters more than the cap is what
 * happens ABOVE it: an ordinal-vocabulary marker with no number is an ORDINARY
 * TOKEN, never paperwork, so the paste keeps its rescue. See the paperwork
 * decision in `extractVocab`.
 *
 * It was 99 until round 11b. `第100天 第101天 第102天` - the shape of every
 * 100-day challenge list - returned no cards AND `paperworkOnly`, which refuses
 * the paid rescue that main allowed (main gave two junk cards, measured
 * 2026-09-09 with `git archive main`).
 *
 * The inverse of `chineseNumberWord`, reading the SAME static table, so both
 * spellings of one handout give one answer.
 */
function ordinalNumberValue(numeral: string): number | null {
  if (/^\d{1,5}$/.test(numeral)) {
    const n = Number(numeral);
    return n >= 1 && n <= ORDINAL_MAX ? n : null;
  }
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const value = (ch: string): number => (ch === '两' ? 2 : digits.indexOf(ch));
  const chars = Array.from(numeral);

  // THE HUNDREDS PLACE IS SPLIT OFF FIRST, and what follows it is read by the
  // same 1-99 reader below: `一百二十三` is `一百` + `二十三`, and `一百零一` is
  // `一百` + `零一`, the 零 marking the empty tens place a speaker says out
  // loud. 千 is deliberately not read; see the cap above.
  const hundred = chars.indexOf('百');
  if (hundred !== -1) {
    if (hundred !== 1) return null;
    const h = value(chars[0]);
    if (!(h >= 1 && h <= 9)) return null;
    const rest = chars.slice(hundred + 1);
    if (rest.length === 0) return h * 100;
    // AFTER A HUNDREDS PLACE THE TENS MUST BE SPELLED OUT IN FULL, or there is
    // no reading that is not a guess. Round 12, the Codex leg: `第一百一天` was
    // being read as day 101 and `第一百二天` as day 102, and neither spelling
    // means that. Said out loud `一百一` is the colloquial 110 (the way `一块二`
    // is 1.20), and written down by a teacher counting days it could as easily
    // be a typo for 一百零一. 101 has ONE unambiguous spelling, `一百零一`, and
    // that is the one this reads.
    //
    // `一百十` and `一百十二` are refused by the same sentence for the same
    // reason: 十 with its tens digit elided is the bare-10 shorthand, so the
    // string is not unambiguously 110 or 112 either, and the code comment in
    // tensValue already said the digit has to be there. The unambiguous forms
    // 一百一十 and 一百一十二 are unaffected.
    //
    // Refusing lands the token as an ordinary unknown word: not a card with a
    // generated gloss, and not paperwork, so the paid rescue stays open.
    // `rest.indexOf('十') === 1`: the tens digit written, then 十.
    if (rest[0] !== '零' && rest.indexOf('十') !== 1) return null;
    const tail = rest[0] === '零' ? tensValue(rest.slice(1), value) : tensValue(rest, value);
    if (tail === null) return null;
    // `一百零二十` is not a number anyone writes: after 零 only the ones place.
    if (rest[0] === '零' && tail > 9) return null;
    const n = h * 100 + tail;
    return n >= 1 && n <= ORDINAL_MAX ? n : null;
  }

  const n = tensValue(chars, value);
  return n !== null && n >= 1 && n <= ORDINAL_MAX ? n : null;
}

/**
 * The 1-99 half, split out of `ordinalNumberValue` so the hundreds can reuse it
 * on their tail. `null` for anything it cannot read.
 */
function tensValue(chars: string[], value: (ch: string) => number): number | null {
  if (chars.length === 0) return null;
  const ten = chars.indexOf('十');
  let n: number;
  if (ten === -1) {
    if (chars.length !== 1) return null;
    n = value(chars[0]);
  } else {
    // THE TENS DIGIT IS THE CHARACTER BEFORE 十, wherever 十 sits. This used to
    // ask `chars.length === 2`, which is only true of a round number: `二十`
    // read as 20, but `二十一` and `三十一` were rejected outright and a whole
    // syllabus of weeks came back as paperwork (round 10, F3).
    const tens = ten === 0 ? 1 : ten === 1 ? value(chars[0]) : NaN;
    const ones = ten === chars.length - 1 ? 0 : chars.length === ten + 2 ? value(chars[ten + 1]) : NaN;
    n = tens * 10 + ones;
  }
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The card for a bare 第N marker whose unit is something the class counts:
 * `第1天` -> `day 1`, `dì yī tiān`. `null` when the unit names part of a
 * document (that is paperwork, not vocabulary) or when the number cannot be
 * read, because a card with no English is dropped by src/client/build.ts and a
 * half-built one is worse than none.
 */
function ordinalVocabCard(marker: string): { zh: string; pinyin: string; en: string } | null {
  const m = new RegExp(`^第[ \\u3000]?(${ORDINAL_NUMERAL})(.+)$`).exec(marker);
  if (!m) return null;
  const noun = ORDINAL_VOCAB_NOUN[m[2]];
  if (noun === undefined) return null;
  const n = ordinalNumberValue(m[1]);
  if (n === null) return null;
  // THE READING IS OF THE CHARACTERS SHE TYPED, not of the canonical spelling
  // of the number they add up to. Those are the same string for every numeral
  // but 两, which is 2 and is said `liǎng`. A digit spelling has no reading of
  // its own, so that one is read off `chineseNumberWord`.
  const word = /^\d+$/.test(m[1]) ? chineseNumberWord(n) : m[1];
  const syllables = Array.from(word).map((ch) => DIGIT_PINYIN[ch] ?? ch);
  return {
    zh: marker,
    pinyin: ['dì', ...syllables, ORDINAL_VOCAB_PINYIN[m[2]]].join(' '),
    en: `${noun} ${n}`,
  };
}

/**
 * True when the whole paste is bare 第N markers and whitespace: `第1课 第2课`,
 * `第一课 第二课 第三课 第四课`, or one marker alone.
 *
 * A lesson index holds no vocabulary, so no cards is the right answer, and the
 * point of asking here is to say so BEFORE the empty answer reaches the worker,
 * which would otherwise read it as a failed dictionary pass and buy a model
 * call for it (round 7b). Linear: one pass over the tokens, each matched
 * against an anchored, bounded pattern.
 */
function isMarkerRunOnly(text: string): boolean {
  const tokens = text.split(/[\s　]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // DOC-STRUCTURE UNITS ONLY. Round 9, F2: this used to accept every unit, so
  // `第1天 第2天` was answered with no cards and `paperworkOnly`, which also
  // refuses the rescue. A run of 第N DAYS is her list; a run of 第N LESSONS is
  // her contents page. See DOC_STRUCTURE_UNITS for the whole argument.
  return tokens.every((t) => BARE_DOC_STRUCTURE_MARKER_RE.test(t));
}

/**
 * True when every token of the line is a whole 第N marker, whatever the unit.
 * Such a line is read token by token (each marker is its own card or its own
 * heading) instead of being fed to the leading-prefix loop, which would strip
 * all but the last one and hand that last one to the segmenter.
 */
function isAllBareMarkers(line: string): boolean {
  const tokens = line.split(/[\s　]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => BARE_ORDINAL_MARKER_RE.test(t));
}

/** One card built for a bare marker, or one marker dropped as paperwork. */
interface MarkerRead {
  rest: string;
  cards: Array<{ zh: string; pinyin: string; en: string; source: ExtractSource }>;
  skipped: string[];
  changed: boolean;
}

/**
 * Answers every line that is NOTHING BUT whole 第N markers, before any other
 * reader sees the paste.
 *
 * IT IS ANSWERED HERE, AHEAD OF THE DATE STRIP, because the date strip eats
 * the number out of the vocabulary units that are also calendar units:
 * `第1月 第2月` reaches DATE_PART_RE as two `1月`/`2月` fragments and comes out
 * as `第 第`. A marker is one token, and the only way to keep it one token is
 * to take it off the paste before anything is allowed to cut it up.
 *
 * Each token is read on its own: a document-structure unit is her contents
 * page and is reported as skipped, an ordinal-vocabulary unit is her word and
 * becomes a card. See DOC_STRUCTURE_UNITS for which is which.
 *
 * Cards from these lines are added AHEAD of whatever the rest of the paste
 * yields, rather than woven back into their line positions. A line of nothing
 * but markers is either the whole paste (fixtures 68 and 71) or a heading run
 * above the list (`第1课 第2课` over her words), so in every shape seen so far
 * the two orders are the same one.
 */
/**
 * True when a Latin line under a marker line reads as the MEANING of that
 * marker, rather than as the next piece of paperwork on the page.
 *
 * Round 12's second finding. The next-line pairing below runs ahead of the
 * paperwork strip on purpose (the strip would have eaten the pair before the
 * pairing could see it), and the cost was that it also ran ahead of the checks
 * that know what English paperwork looks like: `第1课\nName: ____\n苹果 apple`
 * built a card reading `第1课 = Name: ____`, and `第1课\nThanks,` built one
 * reading `第1课 = Thanks`. Neither is a meaning, and a card with a wrong
 * answer key is worse than no card.
 *
 * So the pairing now asks the same two readers the rest of the file asks, plus
 * the two shapes a form has that neither of them was written for: a trailing
 * colon (`This week:`) and a fill-in blank (`____`, `Name: ____`).
 *
 * WHAT DELIBERATELY STAYS A PAIR is a section title: `第1课\nFood and Drink`
 * still builds `第1课 = Food and Drink`. That is round 7c's decision that what
 * she typed as a pair stays a pair, and a bare English phrase with no
 * punctuation and no digit is indistinguishable from the gloss she meant
 * (`第1课\nLesson one` is the same shape and is the round-10 fixture this
 * pairing exists for). The panel logged the section-title case as a should-fix;
 * it is not decided here, it is pinned by a test as current behaviour.
 *
 * `isSignatureOpener` is asked with `isLastNonEmpty: true` because a bare
 * `Thanks` directly under a marker is a sign-off wherever it sits: this call
 * only decides whether to BUILD a card, never whether to delete the rest of
 * the paste, so the caution that rule needs elsewhere does not apply.
 */
function readsAsGloss(line: string): boolean {
  const t = line.trim();
  if (t === '' || hasCJK(t)) return false;
  if (/[:：]\s*$/.test(t)) return false;
  if (/_{3,}/.test(t)) return false;
  if (isHeaderLine(t)) return false;
  return !isSignatureOpener(t, true);
}

function readBareMarkerLines(text: string): MarkerRead {
  const out: MarkerRead = { rest: text, cards: [], skipped: [], changed: false };
  const lines = text.split(/\r\n|\r|\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || !isAllBareMarkers(line)) {
      kept.push(lines[i]);
      continue;
    }
    out.changed = true;
    // A MARKER-ONLY LINE WITH A LATIN LINE UNDER IT IS A PAIR, NOT PAPERWORK.
    // Round 10, F1 and F2: this is the Quizlet alternating-lines shape
    // (fixture 09) with a lesson number as the term, and it is exactly the
    // same paste as `第1课 Lesson one` with the space typed as a newline. It
    // used to lose BOTH lines - `第1课\nLesson one\n第2课\nLesson two` came
    // back as no cards at all, because the marker line left as paperwork
    // before the pairing could ever see it and the English line was then
    // skipped for having no Chinese. Where the unit is one a class counts it
    // was worse than losing: `第1天\nthe first day` kept the marker and built
    // `day 1` over the gloss she had typed one line down. HER GLOSS WINS; the
    // built one is only ever offered where she wrote none.
    //
    // THE VERY NEXT LINE, with no blank between. A marker with a blank line
    // under it is the top of a section, and the paragraph after the blank is
    // not its meaning.
    const tokens = line.split(/[\s　]+/).filter(Boolean);
    const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (tokens.length === 1 && readsAsGloss(next)) {
      // pinyin is left empty, exactly as the same-line pair leaves it: what
      // she typed is the card, and the reading is filled in downstream.
      out.cards.push({ zh: tokens[0], pinyin: '', en: cleanGloss(next), source: 'pair' });
      kept.push('', '');
      i += 1;
      continue;
    }
    for (const token of tokens) {
      const card = ordinalVocabCard(token);
      if (card) out.cards.push({ ...card, source: 'segment' });
      else out.skipped.push(token);
    }
    kept.push('');
  }
  out.rest = kept.join('\n');
  return out;
}

type MarkerSegment =
  | { kind: 'card'; zh: string; pinyin: string; en: string; source: ExtractSource }
  | { kind: 'drop'; zh: string }
  | { kind: 'text'; text: string };

/**
 * Cuts a free-path line into segments at its whole 第N markers, so the marker
 * is never handed to the run splitter that cuts it at its digit.
 *
 * Each marker OWNS THE TOKENS UP TO THE NEXT MARKER, and what those tokens are
 * decides what the marker is - the same question isSameLineHeading asks, asked
 * once per marker instead of once per line:
 *
 *   第1课 Lesson one          English after it. HER CARD, with her gloss.
 *   第1课 Lesson one 第2课 Lesson two   two of those. TWO cards.
 *   第1课 苹果 香蕉            Chinese after it. A HEADING over her list.
 *   第1课                     nothing after it. Paperwork, dropped.
 *   第1天                     nothing after it, but the unit is one a class
 *                             counts. HER WORD, glossed `day 1`.
 *
 * `null` when the line holds no whole marker at all, which is almost every
 * line, and the caller then reads it exactly as it did before.
 */
function readMarkerSegments(line: string): MarkerSegment[] | null {
  const tokens = line.split(/[\s　]+/).filter(Boolean);
  if (!tokens.some((t) => BARE_ORDINAL_MARKER_RE.test(t))) return null;

  const segments: MarkerSegment[] = [];
  let marker: string | null = null;
  let tail: string[] = [];
  const close = () => {
    if (marker === null) {
      if (tail.length > 0) segments.push({ kind: 'text', text: tail.join(' ') });
      return;
    }
    if (tail.length === 0) {
      const card = ordinalVocabCard(marker);
      segments.push(card ? { ...card, kind: 'card', source: 'segment' } : { kind: 'drop', zh: marker });
    } else if (hasCJK(tail.join(' '))) {
      // A heading over the list it names. The list stays exactly as she typed
      // it and is read by the ordinary reader.
      segments.push({ kind: 'drop', zh: marker });
      segments.push({ kind: 'text', text: tail.join(' ') });
    } else {
      segments.push({
        kind: 'card',
        zh: marker,
        pinyin: '',
        en: cleanGloss(tail.join(' ')),
        source: 'pair',
      });
    }
  };
  for (const token of tokens) {
    if (BARE_ORDINAL_MARKER_RE.test(token)) {
      close();
      marker = token;
      tail = [];
    } else {
      tail.push(token);
    }
  }
  close();
  return segments;
}

/**
 * The line that opens an email signature. Everything after one of these is
 * signature, whatever it says, which is how a signature actually works and
 * saves us guessing whether `Ms. Chen` is a name or somebody's gloss.
 *
 * A rule that throws away THE REST OF THE PASTE has to be sure, so it is split
 * in three:
 *
 *   MARK      `--`, `____`, `Sent from my iPhone`. Nothing else is ever that.
 *   CLOSING   `Best,` `Thanks.` `Regards!` The punctuation is REQUIRED. It is
 *             what makes the word a sign-off rather than a word.
 *   BARE      `Thanks` with nothing after it. Trusted only as the LAST non-empty
 *             line of the paste, where there is nothing left to lose.
 *
 * The bare form used to be trusted anywhere, so a `Thanks` in the middle of a
 * word list deleted every word under it (reproduced 2026-09-08, fixture 37).
 */
const SIGNATURE_MARK_RE = /^(?:-{2,}|_{2,}|sent from my .{1,30})$/i;
const SIGNATURE_WORD =
  '(?:best|thanks|thank you|regards|best regards|kind regards|warm regards|sincerely|cheers|warmly|yours)';
const SIGNATURE_CLOSING_RE = new RegExp(`^${SIGNATURE_WORD}\\s*[,.!]$`, 'i');
const SIGNATURE_BARE_RE = new RegExp(`^${SIGNATURE_WORD}$`, 'i');

/**
 * True when this line starts an email signature.
 *
 * `isLastNonEmpty` comes from the caller, because a line cannot know whether
 * anything follows it, and that is exactly what decides a bare closing word.
 */
export function isSignatureOpener(line: string, isLastNonEmpty: boolean): boolean {
  const t = line.trim();
  // A line with Chinese on it is vocabulary. Whatever else it says, it is not
  // the end of the list.
  if (t === '' || hasCJK(t)) return false;
  if (SIGNATURE_MARK_RE.test(t) || SIGNATURE_CLOSING_RE.test(t)) return true;
  return isLastNonEmpty && SIGNATURE_BARE_RE.test(t);
}

/**
 * True when this line is paperwork rather than vocabulary.
 *
 * `ctx` is where the line sits in the paste, which only the caller knows. It
 * defaults to "could be a title row", so a call with one argument still tests
 * the SHAPE of the line, which is what the unit tests want.
 */
export function isHeaderLine(line: string, ctx: HeaderContext = HEADER_ANYWHERE): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (isColumnTitleRow(t, ctx)) return true;
  if (hasCJK(t)) return CJK_HEADING_RE.test(t) || CJK_DATE_LINE_RE.test(t);
  return HEADING_WITH_NUMBER_RE.test(t) || LABELLED_LINE_RE.test(t) || BARE_LABEL_RE.test(t);
}

interface StrippedText {
  /** The paste with the paperwork taken out, ready for parse.ts. */
  text: string;
  /** The paperwork, in the order the teacher wrote it. */
  skipped: string[];
}

/**
 * Splits a paste into the words and the paperwork around them.
 *
 * A blank line is kept as a blank line rather than deleted, so the shape of
 * what is left (which line follows which) is exactly what the teacher typed.
 */
function stripHeaders(text: string): StrippedText {
  const kept: string[] = [];
  const skipped: string[] = [];
  const raws = text.split(/\r\n|\r|\n/);

  let lastNonEmpty = -1;
  for (let i = 0; i < raws.length; i++) {
    if (raws[i].trim() !== '') lastNonEmpty = i;
  }

  // The first line that holds anything, and, for every line, whether something
  // below it is an ordinary row rather than another rack of column titles.
  // Both are what isColumnTitleRow needs and a line cannot see for itself.
  let firstContent = -1;
  for (let i = 0; i < raws.length; i++) {
    if (raws[i].trim() !== '') {
      firstContent = i;
      break;
    }
  }
  const contentBelow: boolean[] = new Array(raws.length).fill(false);
  let seen = false;
  for (let i = raws.length - 1; i >= 0; i--) {
    contentBelow[i] = seen;
    const t = raws[i].trim();
    if (t !== '' && !isAllColumnTitles(t)) seen = true;
  }

  // THE LINE UNDER THIS ONE, for the heading rescue below. One backward pass,
  // so asking it costs nothing per line.
  const below: string[] = new Array(raws.length).fill('');
  let next = '';
  for (let i = raws.length - 1; i >= 0; i--) {
    below[i] = next;
    const t = raws[i].trim();
    if (t !== '') next = t;
  }

  let inSignature = false;
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    const line = raw.trim();
    // THE SIGNATURE NEVER SWALLOWS CHINESE. A line with Chinese on it is a word
    // the teacher typed, so it ENDS the signature rather than disappearing into
    // it. Whatever `Thanks` meant, it did not mean "delete the rest of my list".
    if (inSignature && line !== '' && hasCJK(line)) inSignature = false;
    if (inSignature) {
      if (line !== '') skipped.push(line);
      kept.push('');
      continue;
    }
    if (isSignatureOpener(line, i === lastNonEmpty)) {
      inSignature = true;
      skipped.push(line);
      kept.push('');
      continue;
    }
    // A WORD WITH ITS OWN EXPLANATION UNDER IT IS NEVER PAPERWORK. `isPairHeading`
    // already refuses to take `单词` off a list when the next line explains it,
    // but THIS pass runs first and had already deleted the line, so the rescue
    // never saw it: `苹果 / 香蕉 / 单词 / 老师 / 学生` with a definition each came
    // back as nine segmenter fragments and one notice (round 5 review, must-fix
    // 2; Codex round 4, P1). Same test, same two exceptions: a line that SAYS it
    // is a label (`生词表`, `词语解释`) is still a label.
    if (
      !isPairKeptByDefinition(line, below[i]) &&
      isHeaderLine(line, { isFirstContent: i === firstContent, hasContentBelow: contentBelow[i] })
    ) {
      skipped.push(line);
      kept.push('');
      continue;
    }
    // `第1课：1月 2月 3月`: the heading and her list on one line. The heading
    // comes off the FRONT and the list stays where she typed it.
    //
    // A RUN OF MARKERS COMES OFF AS A RUN. `第一课 第二课 第三课 第四课` is a lesson
    // index, not a word list, and taking only the first marker off left
    // `第二课 第三课 第四课` for the segmenter, which found the CC-CEDICT headword
    // 第二 and put it on a card (main: 第一 and 第二). Each pass consumes at least
    // two characters of a line that is already trimmed, so the loop is linear
    // and cannot spin.
    //
    // A LINE THAT IS NOTHING BUT MARKERS IS NOT THIS LOOP'S BUSINESS. The loop
    // strips LEADING markers and leaves the last one on the line, which is how
    // `第1课 第2课` reached the segmenter and came back as 第 and 课 (round 9,
    // F1, measured on 44d2a41 even with the round-7c guard in place). Such a
    // line is handed to the free path whole and read token by token there: a
    // doc-structure marker is a heading and drops, an ordinal-vocabulary marker
    // (`第1天`) is her word and becomes a card.
    if (isAllBareMarkers(line)) {
      kept.push(line);
      continue;
    }
    //
    // ONE PASS, NOT ONE PASS PER MARKER. Round 10, F5: this walked the line by
    // rebuilding it (`rest = rest.replace(...)`) and re-asked the tail question
    // over the whole remainder each time, so `'第1课 '.repeat(16384) + '苹果'`
    // (64 KB, inside the worker's accept cap) cost 18.4 s here and held the
    // request for all of it. The answer was always right; the price was
    // availability, which is the same class of bug as the round-4 ReDoS.
    //
    // THE TAIL QUESTION IS ASKED ONCE. Stripping a SPACE-separated marker
    // removes exactly one whole token, and that token is a bare marker, so it
    // is one hasCJKOutsideBareMarkers had already discarded: which tokens are
    // left, and whether any of them is Chinese, cannot change. The 的 / colon
    // forms cut INSIDE a token, so the cached answer is dropped there and the
    // next space-form marker asks again.
    let pos = 0;
    const markers: string[] = [];
    let tailIsHerList: boolean | null = null;
    for (;;) {
      CJK_HEADING_PREFIX_AT_RE.lastIndex = pos;
      const m = CJK_HEADING_PREFIX_AT_RE.exec(line);
      if (m === null) break;
      const end = pos + m[0].length;
      const marker = line.slice(pos, end);
      if (markerSaysHeading(marker)) {
        tailIsHerList = null;
      } else {
        if (tailIsHerList === null) tailIsHerList = hasCJKOutsideBareMarkers(line, end);
        if (!tailIsHerList) break;
      }
      markers.push(marker.trim());
      pos = end;
    }
    if (markers.length > 0) {
      skipped.push(...markers);
      kept.push(line.slice(pos));
      continue;
    }
    kept.push(raw);
  }

  return { text: kept.join('\n'), skipped };
}

/**
 * Trims a gloss down to something that fits on a card.
 *
 * The trailing-punctuation strip is BOUNDED (`[ ]{0,8}`, not `\s*`). Unanchored
 * `\s*` in front of a required character is retried from every position, and on
 * a raw run of 60,000 spaces that pattern measured 3,495 ms (round-4 sweep).
 * The line above collapses every whitespace run to one space before it gets
 * there, so the slow shape is unreachable today - but it is unreachable because
 * of a line somebody could reorder, which is not a reason to leave it armed.
 */
function cleanGloss(raw: string): string {
  let g = raw.replace(/\s+/g, ' ').trim();
  g = g.replace(POS_PREFIX_RE, '').trim();
  g = g.replace(/^[-–—:;,.]+[ ]{0,8}/, '').replace(/[ ]{0,8}[-–—:;,]+$/, '').trim();
  if (g.length > MAX_GLOSS_CHARS) {
    const cut = g.slice(0, MAX_GLOSS_CHARS);
    const space = cut.lastIndexOf(' ');
    g = (space > 12 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?…]+$/, '');
  }
  return g;
}

/**
 * How long one of the teacher's own definitions may run.
 *
 * Three times the dictionary limit. A CEDICT gloss is a phrase and 40
 * characters is generous for one; a definition she wrote is a whole sentence,
 * and 40 cut it mid-clause (round 1 review).
 */
const MAX_DEFINITION_CHARS = 120;

/** Where a clause ends, in either the Chinese or the ASCII spelling. */
const CLAUSE_END_RE = /[。，、；！？,;!?]/;

/**
 * Trims a definition the teacher wrote, at a clause boundary or not at all.
 *
 * `cleanGloss` above is for dictionary glosses and cuts at a space, which
 * Chinese does not have.
 */
function cleanDefinition(raw: string): string {
  const d = raw.replace(/\s+/g, ' ').trim();
  // CODE POINTS, NOT UTF-16 UNITS. `slice` cuts an astral character in half and
  // leaves a lone surrogate on the card (round 2 review, should-fix 5).
  const chars = Array.from(d);
  if (chars.length <= MAX_DEFINITION_CHARS) return d;
  const cut = chars.slice(0, MAX_DEFINITION_CHARS);
  // NFKC has already turned her fullwidth comma into an ASCII one by the time
  // the text gets here, so both spellings are clause ends.
  let stop = -1;
  for (let i = cut.length - 1; i >= 0; i--) {
    if (CLAUSE_END_RE.test(cut[i])) {
      stop = i;
      break;
    }
  }
  if (stop > 0) return cut.slice(0, stop + 1).join('');
  // NO CLAUSE MARK IN 120 CHARACTERS: one long unbroken run. Cut at the last
  // WHOLE character and say out loud that it was cut, rather than handing her a
  // sentence that stops in the middle of a word and looks like the whole thing.
  return `${cut.join('')}\u2026`;
}

/** True when every character of the string is Chinese. */
export function isAllCjk(s: string): boolean {
  if (s === '') return false;
  for (const ch of s) {
    if (!CJK_ONE_RE.test(ch)) return false;
  }
  return true;
}

/** One row of a Chinese term / Chinese definition list. */
export interface TermDefinitionPair {
  /** The word, exactly as she typed it. Never re-segmented. */
  term: string;
  /** The sentence she wrote under it. It becomes the meaning on the card. */
  definition: string;
}

/** What a paste read as pairs left behind. */
export interface TermDefinitionReading {
  pairs: TermDefinitionPair[];
  /**
   * Every non-empty line the pair walk did NOT consume, in order. Pair mode
   * used to throw these away: five pairs followed by a spreadsheet of ordinary
   * rows silently lost 苹果 香蕉 老师 学生 (round 1 review). They go back
   * through the normal readers instead.
   */
  rest: string[];
  /**
   * The lines that name the list rather than belong to it: the set's title
   * (`科技创新 词语解释`) and any heading between two groups of pairs. They
   * were never vocabulary and must not become cards now that the leftovers are
   * parsed, so they are reported instead of dropped.
   */
  title: string[];
  /**
   * `科技创新 appears twice`, once per pair a run repeated. A teacher who
   * pasted a row twice gets her 51 words and one line saying which row she
   * doubled, instead of the whole reading collapsing (round 3 review,
   * must-fix 1).
   */
  duplicates: string[];
}

/**
 * What the row parser splits a row on: a tab, a pipe, a comma of either width,
 * an enumeration comma, or a run of spaces. Used only to ask whether a leftover
 * row donated one of its FIELDS to a card.
 */
const ROW_FIELD_SEPARATOR_RE = /[\t|,\uFF0C\u3001\uFF1B;]+|[ \u3000]+/;

/** Longest run of Chinese that can still be a term rather than a sentence. */
const PAIR_TERM_MAX_CHARS = 8;
/** Below this many pairs the shape is a coincidence, not a list. */
const MIN_TERM_DEFINITION_PAIRS = 5;
/** How many unreadable leftover lines are listed before they are counted. */
export const MAX_REPORTED_LEFTOVERS = 49;

/**
 * The note that counts the LEFTOVER LINES that were not listed.
 *
 * `… and 12 more` is about the unreadable rows above it, never about the
 * notes: the notes have their own cut line, written by the worker's reply cap
 * (`reportedNotes`). Written and recognised in one place because that cap has
 * to hold this one back from its cut, being the only note whose absence changes
 * what the lines above it mean (round 6 fix list, item 3; wording corrected in
 * round 7, item 3).
 */
export function leftoverSummaryNote(more: number): string {
  return `\u2026 and ${more} more`;
}

/** True for a note written by `leftoverSummaryNote`. */
export function isLeftoverSummaryNote(note: string): boolean {
  return /^\u2026 and \d+ more$/.test(note);
}

/**
 * How many leftover lines such a note is counting, or 0 for any other note.
 *
 * The worker's reply cap folds this count into its own, so the number has to
 * come back out of the line it was written into (round 8 fix list, item 4).
 * Read here, beside the two functions that write and recognise the line, so the
 * wording lives in one place.
 */
export function leftoverSummaryCount(note: string): number {
  const said = /^\u2026 and (\d+) more$/.exec(note);
  return said ? Number(said[1]) : 0;
}

/** How much of a leftover line is quoted back before it is cut short. */
export const MAX_REPORTED_LINE_CHARS = 80;

/** A line quoted back to the teacher, cut to something a notice can hold. */
function shortened(line: string): string {
  const chars = Array.from(line);
  if (chars.length <= MAX_REPORTED_LINE_CHARS) return line;
  return chars.slice(0, MAX_REPORTED_LINE_CHARS).join('') + '\u2026';
}

/** A short run of Chinese with no punctuation in it: the term half of a pair. */
export function isPairTerm(line: string): boolean {
  const t = line.trim();
  return t.length <= PAIR_TERM_MAX_CHARS && isAllCjk(t);
}

/**
 * The function words a written-out explanation carries. A vocabulary row and a
 * line of classical verse do not: 疑是地上霜 is the exception the length rule
 * below catches, not this one.
 */
const DEFINITION_FUNCTION_WORD_RE = /[的是或让把用和等有不]/;
/** How a dialogue turn ends and an explanation does not. */
const DEFINITION_TURN_END_RE = /[?\uFF1F!\uFF01]$/;
/**
 * How much longer than its term a definition has to be, in Chinese characters.
 *
 * 1.5 is where the two ends of the corpus sit either side of the line. A line
 * of verse answers its partner one for one (床前明月光 / 疑是地上霜。, ratio 1.0)
 * and a dialogue's answer runs about as long as its question; the shortest real
 * definition in fixtures 78 and 79 is 就业 / 找到工作。at 2.0.
 */
const DEFINITION_LENGTH_RATIO = 1.5;

/** How many Chinese characters are in the string. Punctuation does not count. */
function cjkLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (CJK_ONE_RE.test(ch)) n++;
  }
  return n;
}

/**
 * The definition half, judged against the term it would explain.
 *
 * "Has Chinese in it and runs past 8 characters" was not evidence of anything.
 * It made a card out of `老师` over `学生 student person`, out of a dialogue's
 * question and its answer, and out of the two halves of 床前明月光 / 疑是地上霜。
 * (round 1 review). Three things have to hold now, and each one kills one of
 * those shapes:
 *
 * - NO LATIN. A zh-zh set has no English in it by design, so a Latin run is a
 *   gloss or a pinyin, which makes the line another vocabulary row.
 * - HALF AGAIN THE TERM'S LENGTH IN CHINESE. A couplet answers its own line one
 *   for one and a dialogue answers a question at about its own length; an
 *   explanation does not.
 * - A FUNCTION WORD OR A FULL STOP. 的 是 或 让 把 用 和 等 有 不 are what a
 *   sentence that explains something is built out of. A vocabulary row is a
 *   noun phrase and carries none of them.
 */
export function isPairDefinition(line: string, term: string): boolean {
  const d = line.trim();
  if (!hasCJK(d)) return false;
  if (/[A-Za-z]/.test(d)) return false;
  // AN EXPLANATION NEVER ASKS AND NEVER SHOUTS. A dialogue turn does both, and
  // 的 / 是 are the two commonest characters in the language, so the function
  // word below let every one of them through (round 2 review, must-fix 1).
  // Both spellings, because this is called on raw lines in the unit tests as
  // well as on the NFKC-folded body.
  if (DEFINITION_TURN_END_RE.test(d)) return false;
  if (cjkLength(d) < cjkLength(term.trim()) * DEFINITION_LENGTH_RATIO) return false;
  return DEFINITION_FUNCTION_WORD_RE.test(d) || d.endsWith('。');
}

/**
 * The pronouns a dialogue turn is built on: the SINGULARS only.
 *
 * `我们` / `你们` / `咱` were markers until round 6 and cost real definitions:
 * 环境, 社会, 国家 are all explained with `我们` by every dictionary written for
 * children ("我们生活的地方和周围的一切。", fixture 84). A plural is how an
 * explanation includes the reader; a dialogue turn is caught by the singular
 * pronouns and the particles below.
 */
const CONVERSATIONAL_PRONOUN_RE = /[我你您]/;
/**
 * What a pronoun turns into when the character AFTER it belongs to it.
 *
 * `我国` is how an impersonal sentence says "this country", and `我省`, `我校`,
 * `我们` are the same shape: the pronoun plus the body it stands for. A fixed
 * word list held `我国` and `我校` and missed `我省` and every Traditional
 * spelling, so the family is described rather than enumerated (round 7 fix
 * list, item 1). Both spellings of each, because a Quizlet set is as often
 * Traditional as Simplified.
 *
 * `家` and `系` were in it for one round and are OUT again (round 8 fix list,
 * item 3): `我家有三口人。` / `你家在哪儿` / `你系好安全带。` stopped
 * counting as conversational, and a five-turn 我家 / 你家 beginner dialogue was
 * read as five vocabulary cards. See the frozen-rule paragraph below.
 */
const PRONOUN_COMPOUND_TAIL = '们們国國校省市县縣方军軍党黨厂廠院班队隊社';
/** What swallows a pronoun from the LEFT: 自我, 忘我, 无我, 小我, 迷你. */
const PRONOUN_COMPOUND_HEAD = '自忘迷无無小';
/**
 * What follows `你好` when it is the greeting on a card rather than `你` + `好`.
 *
 * The old exclusion cut the substring out of the line, so `你好好学习，天天向上。`
 * lost its `你` and a plain instruction to a child read as an explanation
 * (round 7 fix list, item 2). `你好` is the word when the line stops after it
 * or explains it (`你好是见面时说的话。`); with anything else behind it the `你`
 * is somebody being spoken to.
 */
const GREETING_BOUNDARY = '。．.！!？?，,、；;：:…“”「」（）() 　';
/**
 * The idioms BUILT out of both pronouns, which mean neither of them.
 *
 * `我行我素` is one person's stubbornness and `你死我活` is a fight to the end:
 * the `我` in them belongs to the word the way the `我` in `自我` does. Round 7
 * replaced the old cut-the-substring rule with the character families above and
 * dropped these on the way (round 8 fix list, item 1), so they are matched here
 * instead, anchored at the pronoun the scan is standing on rather than cut out
 * of the line.
 */
const PRONOUN_IDIOMS = [
  '我行我素',
  '你死我活',
  '你争我夺',
  '你来我往',
  '你一言我一语',
];

/**
 * True when the pronoun at `i` is one of the characters of such an idiom.
 *
 * Five fixed strings tried at a fixed set of offsets, so it costs the same for
 * every pronoun and leaves the scan linear in the length of the line.
 */
function insidePronounIdiom(t: string, i: number): boolean {
  for (const idiom of PRONOUN_IDIOMS) {
    for (let j = 0; j < idiom.length; j++) {
      if (idiom[j] === t[i] && i - j >= 0 && t.startsWith(idiom, i - j)) return true;
    }
  }
  return false;
}

/** How a dialogue turn trails off and an explanation does not. */
const CONVERSATIONAL_TAIL_RE = /[吗吧呢啊哦呀]/;
/** Above this share of conversational B lines the run is a dialogue, not a list. */
const CONVERSATIONAL_RUN_SHARE = 0.4;

/**
 * True when one of `我` / `你` / `您` in the line is the PRONOUN.
 *
 * One left-to-right pass over the line, so it costs the length of the line and
 * nothing more. A pronoun is not the pronoun when the character before it makes
 * a word of it (`自我`), when the character after it does (`我们`, `我省`), when
 * it is a character of an idiom built out of both pronouns (`我行我素`), or
 * when it opens `你好` used as the greeting: the line stops after it, or a
 * boundary mark or `是` follows it. `你好好学习` has a verb behind it, so the
 * `你` there is a child being told what to do.
 */
function hasStandalonePronoun(t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '我' && c !== '你' && c !== '您') continue;
    if (insidePronounIdiom(t, i)) continue;
    if (i > 0 && PRONOUN_COMPOUND_HEAD.includes(t[i - 1])) continue;
    const next = i + 1 < t.length ? t[i + 1] : '';
    if (next !== '' && PRONOUN_COMPOUND_TAIL.includes(next)) continue;
    if (c !== '我' && next === '好') {
      const after = i + 2 < t.length ? t[i + 2] : '';
      if (after === '' || after === '是' || GREETING_BOUNDARY.includes(after)) continue;
    }
    return true;
  }
  return false;
}

/**
 * True when the line reads as something one person SAID rather than as an
 * explanation of a word. See the DECIDED ADDENDUM below.
 *
 * Three markers, any one of which is enough: a standalone singular first- or
 * second-person pronoun, a sentence-final particle, or quotation marks around
 * the whole line. "Standalone" means the character is not part of one of the
 * common compounds above: `迷你手机` is a phone, not somebody talking to you.
 */
export function isConversationalLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (CONVERSATIONAL_PRONOUN_RE.test(t) && hasStandalonePronoun(t)) return true;
  // The last Chinese character, whatever punctuation was typed after it.
  let end = t.length;
  while (end > 0 && !CJK_ONE_RE.test(t[end - 1])) end -= 1;
  if (end > 0 && CONVERSATIONAL_TAIL_RE.test(t[end - 1])) return true;
  // The quote test reads the ends of the LINE, so it walks back over a full
  // stop typed outside the closing mark rather than over the mark itself.
  let tail = t.length;
  while (tail > 0 && '。．.！!？?，,、；;… '.includes(t[tail - 1])) tail -= 1;
  const opener = t[0];
  const closer = tail > 0 ? t[tail - 1] : '';
  return (opener === '“' || opener === '「') && (closer === '”' || closer === '」');
}

/**
 * A line that NAMES the list rather than belongs to it.
 *
 * `isHeaderLine` answers most of them (`生词表`, `第一课生词`). It does not answer
 * the two shapes a term / definition set is titled with: `科技创新 词语解释`, the
 * subject plus what the list does to it, and `第二组生词`, the heading over a
 * second group. Both END in a word-list topic, and nothing a teacher means as
 * vocabulary is written that way.
 */
const PAIR_HEADING_TAIL_RE = /(?:生词|生字|新词|单词|词汇|词语)(?:表|解释)?$/;
/** The half of that tail that can only ever be a label: `生词表`, `词语解释`. */
const PAIR_HEADING_LABEL_TAIL_RE = /(?:表|解释)$/;

/**
 * True when the row parser reads the line as a vocabulary row rather than a
 * label: a row that carries a READING or a GLOSS beside its Chinese.
 *
 * The reading or the gloss is the whole test. `parseVocab` hands back an item
 * for any line with Chinese in it, `课文生词表` included, so "it parsed" proves
 * nothing; `苹果\tpíng guǒ\t一种名词` carries a pinyin column and a title never
 * does.
 */
function readsAsVocabularyRow(line: string): boolean {
  return parseVocab(line).items.some(
    (it) => it.pinyin.trim() !== '' || it.en.trim() !== ''
  );
}

/**
 * True when the line is a title or a heading rather than a term or a sentence.
 *
 * `next` is the line under it, because a heading cannot be judged on its own
 * text. The suffix test used to accept any Chinese line ending in 词, which
 * ate 名词, 动词, 形容词, 歌词 and 台词 - ordinary vocabulary - and took a
 * spreadsheet row ending in 一种名词 with them (round 4 review, must-fix 1 and
 * Codex round 3, P1). Three things now have to hold: the line reads as a label,
 * the row parser does NOT read it as a vocabulary row, and it is not a term
 * with its own definition sitting under it.
 */
/**
 * A WORD WITH ITS OWN EXPLANATION UNDER IT IS A PAIR, unless the line SAYS it
 * is a label. `名词` over `表示人或事物名称的词。` is a row of the list; `词语解释`
 * over the same sentence is the set's title split across two lines, and
 * fixture 91 needs it to stay a title so 科技创新 keeps its own sentence.
 * 表 and 解释 are what make the difference: nothing is a vocabulary word
 * because it ends in `解释`.
 *
 * Asked in two places - here in the pair walk, and by `stripHeaders`, which runs
 * first and used to delete the line before the walk could rescue it.
 */
function isPairKeptByDefinition(line: string, next: string): boolean {
  const t = line.trim();
  if (t === '' || PAIR_HEADING_LABEL_TAIL_RE.test(t)) return false;
  return isPairTerm(t) && isPairDefinition(next, t);
}

export function isPairHeading(line: string, next = ''): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (!isHeaderLine(t) && !(hasCJK(t) && PAIR_HEADING_TAIL_RE.test(t))) return false;
  if (isPairKeptByDefinition(t, next)) {
    return false;
  }
  // A ROW THE ROW PARSER ACCEPTS IS VOCABULARY. Pulling it out as a heading
  // lost 苹果 and left its neighbours to be re-paired around the hole.
  if (readsAsVocabularyRow(t)) return false;
  return true;
}

/**
 * DECIDED PRINCIPLE (written here so no later round flips it):
 *
 * repetition of a term is NEVER the dialogue signal. Rounds 2, 3 and 4 each
 * reversed the previous rule (any repeat kills / one repeat ok / three repeats
 * kill), which means the evidence does not decide it. The signal that separates
 * a vocab list from a dialogue is the number of DISTINCT terms: pair mode needs
 * >= 5 distinct terms, so a two- or three-speaker dialogue can never qualify
 * however long it is, while a teacher's list with pasted-twice rows always can.
 * Recoverability wins: a wrongly kept duplicate costs one skipped notice; a
 * wrongly rejected list costs the teacher the whole set.
 *
 * Do not re-tune repetition counts. The floor is MIN_TERM_DEFINITION_PAIRS
 * DISTINCT terms, counted after this function has folded the repeats away, and
 * that is the only place repetition is allowed to change the answer.
 *
 * DECIDED ADDENDUM: the discriminator is the CONTENT of the B line, never
 * repetition and never the term count alone. A definition is impersonal; a
 * dialogue turn is conversational. A B line is "conversational" if it contains
 * a standalone 你 / 我 / 您, or ends with 吗 / 吧 / 呢 / 啊 / 哦 / 呀 before its
 * punctuation, or is wrapped in quotes “ ” 「 」. A run in which 40% or more of
 * the B lines are conversational is not pair mode.
 *
 * THE PLURALS ARE NOT MARKERS (round 6 fix list, item 1). 我们 / 你们 / 咱 read
 * as a dialogue to a character test and as an explanation to a teacher: fixture
 * 84 defines 环境 as `我们生活的地方和周围的一切。`. Two speakers are still caught
 * by the singulars and by the distinct-term floor.
 *
 * Measured before it was written: 0 of fixture 78's 51 definitions and 0 of
 * fixture 79's are conversational under this rule, so it costs no real card.
 * Five distinct speakers with one statement each - 小明 小红 老王 李丽 张伟, no
 * repetition anywhere - passed as five vocabulary cards before it (round 5
 * review, must-fix 1).
 *
 * WHAT IT COSTS, SAID EXACTLY: it demotes the RUN to free mode, so the terms
 * come back through the segmenter and the teacher's own sentences are NOT used
 * as meanings. That is a real loss, and it is why every refused run of five or
 * more pairs pushes a note saying so (round 6 fix list, item 6). It never
 * deletes a card and it never costs a word silently.
 *
 * STOPPING RULE APPLIED (round 8, the closing round):
 *
 * the conversational-marker rule has been re-tuned in rounds 5, 6, 7 and each
 * review found a new edge case in the opposite direction (我们 in definitions vs
 * 我 in dialogue; 我省 the province vs 我省下的钱 the verb; 你好 the greeting vs
 * 你好好学习). Pronoun-in-sentence classification is not decidable by character
 * rules, so the marker set is FROZEN at this commit plus the two idiom
 * exclusions below. Second-order principle: recoverability. A wrongly REFUSED
 * list costs the teacher every meaning, and the refusal is now visible as a
 * note; a wrongly ACCEPTED dialogue costs a few junk cards she can delete on the
 * Edit words screen. Known limitation, accepted: a list with two definitions
 * such as 请你方便的时候过来。 and 我省下的钱都是为了买书。 in five is accepted as
 * pairs (harmless), and a dialogue whose turns use only 我省 / 我方 style
 * compounds is accepted (rare, visible). Future rounds may not re-tune the
 * marker set; they may only add a NEW signal that is independent of pronouns.
 *
 * THE ONE CORRECTION THE FREEZE TOOK WITH IT: `家` and `系` were removed from
 * the compound-tail family (round 8 fix list, item 3). Round 7 had added them,
 * and 我家有三口人。/ 你家在哪儿 / 你系好安全带。 stopped counting as
 * conversational, so a five-turn 我家 / 你家 beginner dialogue passed as five
 * name cards with no note at all. 我家 and 你家 are a beginner talking far more
 * often than they are a compound inside a definition. That is the last change
 * to the marker set.
 */

/**
 * A run with its repeated terms folded into one card each, and a note for every
 * fold so nothing disappears in silence.
 *
 * Two kinds of repeat, two different notes:
 *
 * - THE SAME ROW AGAIN, word for word. She pasted twice, or merged two files
 *   that share a word. One note saying how many times it appears.
 * - THE SAME WORD WITH A DIFFERENT SENTENCE UNDER IT. The first card is the one
 *   kept, and the sentence that was not used is quoted back verbatim, so a
 *   teacher who rewrote a definition can see which text is on the card
 *   (round 4 review, should-fix 1; Codex round 3, P2).
 *
 * It never refuses a run. See the DECIDED PRINCIPLE above.
 */
function withoutRepeatedTerms(
  run: TermDefinitionPair[]
): { pairs: TermDefinitionPair[]; notes: string[] } {
  const first = new Map<string, string>();
  const counts = new Map<string, number>();
  const conflicts = new Map<string, string[]>();
  const order: string[] = [];
  const pairs: TermDefinitionPair[] = [];
  for (const pair of run) {
    const kept = first.get(pair.term);
    if (kept === undefined) {
      first.set(pair.term, pair.definition);
      counts.set(pair.term, 1);
      order.push(pair.term);
      pairs.push(pair);
      continue;
    }
    counts.set(pair.term, (counts.get(pair.term) ?? 1) + 1);
    if (pair.definition !== kept) {
      const said = conflicts.get(pair.term);
      if (said === undefined) conflicts.set(pair.term, [pair.definition]);
      else said.push(pair.definition);
    }
  }
  const notes: string[] = [];
  for (const term of order) {
    const n = counts.get(term) ?? 1;
    if (n === 1) continue;
    const said = conflicts.get(term);
    if (said === undefined) {
      notes.push(n === 2 ? `${term} appears twice` : `${term} appears ${n} times`);
      continue;
    }
    let first = true;
    for (const definition of said) {
      // THE THIRD DEFINITION IS NOT A SECOND ONE. Two rewrites of the same word
      // both said "second meaning not used", which reads like the same notice
      // printed twice (round 4 review, should-fix 2).
      // QUOTED, NOT REPRINTED, like every other line that comes back to her.
      // This one note skipped `shortened` and built a 2,033-character banner
      // out of a pasted page (round 6 fix list, item 7).
      notes.push(
        `${term}: ${first ? 'second' : 'another'} meaning not used: ${shortened(definition)}`
      );
      first = false;
    }
  }
  return { pairs, notes };
}

/**
 * Reads a paste as a Chinese term / Chinese definition list, or says it is not
 * one.
 *
 * The shape is a whole Quizlet set with no English anywhere: 科技创新 on one
 * line, 用新的科学和技术创造新的东西。on the next, 51 times. Every reader below
 * this line does the wrong thing with it - the segmenter cuts 科技创新 into the
 * two dictionary words 科技 and 创新, and the definitions donate 电脑 and 东西 -
 * so the shape is answered here, before any of them see it.
 *
 * THE HEADINGS COME OUT FIRST, which is what keeps a pair adjacent to its own
 * term. A `词语解释` between `科技创新` and its sentence used to pair the HEADING
 * with the sentence and drop the word (round 3 review, must-fix 3).
 *
 * EVERY QUALIFYING RUN IS KEPT, not the longest one. A heading in the middle of
 * a 51-word list split it into two runs, the shorter one was thrown back to the
 * segmenter, and 25 of her words came back as fragments (round 3 review,
 * must-fix 2).
 *
 * ONE PASS. Each step consumes one line or two and never looks back, so a
 * 64 KB paste costs one walk of its lines.
 */
export function readTermDefinitionPairs(
  lines: string[],
  refused: string[] = []
): TermDefinitionReading | null {
  // The blank lines come out first, so a heading is judged against the line a
  // reader would see under it rather than against an empty string.
  const written: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t !== '') written.push(t);
  }
  const body: string[] = [];
  const headings: string[] = [];
  for (let k = 0; k < written.length; k++) {
    const t = written[k];
    if (isPairHeading(t, k + 1 < written.length ? written[k + 1] : '')) {
      headings.push(t);
      continue;
    }
    body.push(t);
  }
  const regions: { start: number; end: number; pairs: TermDefinitionPair[] }[] = [];
  let run: TermDefinitionPair[] = [];
  let conversational = 0;
  let runStart = 0;
  let i = 0;
  const closeRun = (end: number): void => {
    // A DIALOGUE IS TURNED AWAY ON WHAT ITS SENTENCES SAY. See the DECIDED
    // ADDENDUM above: five speakers with one statement each are five distinct
    // terms, so the distinct-term floor alone let them through as cards.
    const talky = conversational >= run.length * CONVERSATIONAL_RUN_SHARE;
    // A REFUSAL IS SAID OUT LOUD. The run goes back to the segmenter and her
    // sentences are not used as meanings; a teacher who pasted a list with
    // example dialogue in it saw the meanings vanish with nothing on screen to
    // explain it (round 6 fix list, item 6).
    if (run.length >= MIN_TERM_DEFINITION_PAIRS && talky) {
      // AND IT SAYS WHAT IT ACTUALLY REFUSED. `word-and-meaning pairs` named
      // the run after the thing it was NOT: a teacher whose dialogue was turned
      // away was told her pairs were dropped (round 7 fix list, item 5). The
      // count is the meaning lines, one per pair.
      refused.push(
        `${run.length} lines that looked like a conversation were not used as word meanings`
      );
    }
    if (run.length >= MIN_TERM_DEFINITION_PAIRS && !talky) {
      // DISTINCT TERMS ARE THE FLOOR, and the only thing repetition changes.
      // A six-turn dialogue folds to two distinct terms and stops here; a
      // 51-word list with a row pasted three times folds to 51 and does not.
      // The fold is asked here and DONE once, over every accepted run together:
      // asking it per run let the same word be defined differently in two runs
      // with only the Collector's silent dedupe between them (Codex round 4,
      // P2).
      if (withoutRepeatedTerms(run).pairs.length >= MIN_TERM_DEFINITION_PAIRS) {
        regions.push({ start: runStart, end, pairs: run });
      }
    }
    run = [];
    conversational = 0;
  };
  while (i < body.length) {
    const term = body[i];
    if (i + 1 < body.length && isPairTerm(term) && isPairDefinition(body[i + 1], term)) {
      if (run.length === 0) runStart = i;
      run.push({ term, definition: body[i + 1] });
      if (isConversationalLine(body[i + 1])) conversational += 1;
      i += 2;
      continue;
    }
    closeRun(i);
    i += 1;
  }
  closeRun(body.length);
  if (regions.length === 0) return null;
  const merged: TermDefinitionPair[] = [];
  for (const region of regions) {
    for (const pair of region.pairs) merged.push(pair);
  }
  const answered = withoutRepeatedTerms(merged);
  // EVERYTHING OUTSIDE A RUN GOES BACK DOWN THE ORDINARY PATH. That is the
  // reader that knows what a spreadsheet row or a bare word list is, and the
  // first line is no longer exempt from it: `苹果	píng guǒ	apple` above five
  // pairs was being discarded as the set's title (round 3 review, must-fix 3).
  // A real title is a heading and came out above.
  const rest: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    for (let j = cursor; j < region.start; j++) rest.push(body[j]);
    cursor = region.end;
  }
  for (let j = cursor; j < body.length; j++) rest.push(body[j]);
  return { pairs: answered.pairs, rest, title: headings, duplicates: answered.notes };
}

/**
 * Forward maximum matching over the dictionary headwords.
 *
 * At each position the longest headword that starts there wins, trying 4
 * characters then 3 then 2 then 1. A position that matches nothing consumes one
 * character, which the caller then drops: a character the segmenter had to
 * guess at is not a word the teacher asked for.
 *
 * Returns the pieces in order, each flagged with whether the dictionary knew it.
 */
export function segment(
  chunk: string,
  dict: ExtractDict | null
): Array<{ zh: string; known: boolean }> {
  const out: Array<{ zh: string; known: boolean }> = [];
  const chars = Array.from(chunk);
  let i = 0;
  while (i < chars.length) {
    let taken = 0;
    if (dict) {
      const max = Math.min(MAX_WORD_CHARS, chars.length - i);
      for (let len = max; len >= 1; len--) {
        const candidate = chars.slice(i, i + len).join('');
        if (dict.lookup(candidate)) {
          out.push({ zh: candidate, known: true });
          taken = len;
          break;
        }
      }
    }
    if (taken === 0) {
      out.push({ zh: chars[i], known: false });
      taken = 1;
    }
    i += taken;
  }
  return out;
}

/** Collects items, dedupes by the Chinese, and stops at the cap. */
class Collector {
  readonly items: ExtractedVocab[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly dict: ExtractDict | null) {}

  get full(): boolean {
    return this.items.length >= MAX_EXTRACT_ITEMS;
  }

  /**
   * Adds a word. A repeat only fills in a column the first one was missing, so
   * the first occurrence keeps its place in the list and the teacher's own gloss
   * is never overwritten by a later dictionary one.
   */
  add(
    zh: string,
    pinyin: string,
    en: string,
    source: ExtractSource,
    isDefinition = false
  ): void {
    const key = zh.trim();
    if (key === '') return;
    // Her own CHINESE SENTENCE gets the long limit; everything else gets the
    // short gloss trim it was written for. Asking `source === 'pair'` instead
    // caught the spreadsheet and HSK rows, which are 'pair' too, and their
    // glosses stopped being cleaned: fixture 13 came back `n. apple` where main
    // returns `apple` (Codex round 3, P2 / fix list item 3). Only the term /
    // definition walk passes `true`.
    const clean = (raw: string): string =>
      isDefinition ? cleanDefinition(raw) : cleanGloss(raw);
    const existing = this.seen.has(key);
    if (existing) {
      const item = this.items.find((it) => it.zh === key);
      if (item) {
        if (!item.pinyin && pinyin) item.pinyin = pinyin;
        if (!item.en && en) item.en = clean(en);
      }
      return;
    }
    if (this.full) return;

    const hit = this.dict ? this.dict.lookup(key) : null;
    this.seen.add(key);
    this.items.push({
      zh: key,
      pinyin: pinyin || (hit ? hit.pinyin : ''),
      en: en ? clean(en) : hit ? cleanGloss(hit.en) : '',
      source,
    });
  }
}

/** One run of Chinese, and the characters that separated it from the last one. */
interface CjkRun {
  zh: string;
  /** What sat between this run and the previous one. '' for the first run. */
  before: string;
  /** What follows it, up to the next run or the end of the line. */
  after: string;
}

/** Cuts a line into its runs of Chinese, remembering what separated them. */
function splitRuns(line: string): CjkRun[] {
  const runs: CjkRun[] = [];
  const re = new RegExp(CJK_RUN_RE.source, 'g');
  let last = 0;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (runs.length > 0) runs[runs.length - 1].after = line.slice(last, m.index);
    runs.push({ zh: m[0], before: line.slice(last, m.index), after: '' });
    last = m.index + m[0].length;
  }
  if (runs.length > 0) runs[runs.length - 1].after = line.slice(last);
  return runs;
}

/**
 * True when the teacher declared this run as her word by writing a colon after
 * it: `喜欢：我喜欢吃苹果。`
 *
 * Reproduced live 2026-09-08: that paste came back WITHOUT 学习, because the
 * example sentence makes the whole paste read as prose and 学习 is on the prose
 * stopword list (a teacher saying `今天我们学习水果` does not want 学习 on a
 * card). Writing it in front of a colon is her saying she does.
 *
 * It buys the run list-mode treatment, not a blanket exemption. What happens
 * to a PAPERWORK word in front of a colon is decided by isHerWord below, and
 * it is not "stays dropped", which is what this comment used to claim:
 * 学习：我每天学习中文。 gets 学习 back (she uses it in her own sentence), and
 * 注意：明天考试。 does not get 注意. A marker that introduces a list (`生词：`,
 * `作业：`) is dropped in both modes; what FOLLOWS it on the line is her list.
 */
function isDeclaredHeadword(run: CjkRun): boolean {
  return /^\s*[:：]/.test(run.after);
}

/**
 * A colon is not enough on its own when the word in front of it is paperwork.
 *
 * 注意：明天考试。 is "Note: there is a test tomorrow", and 完成：作业第三页。 is
 * "Complete: page three of the homework". Neither is a vocabulary word she
 * declared; both became cards on 2026-09-08, and 完成 was the ONLY card of its
 * paste. Two things tell a declaration from an instruction, and either does:
 *
 *   SHE USES IT AGAIN. 学习：我每天学习中文。 puts 学习 in the sentence as well
 *   as in front of the colon, which is what a word-plus-example-sentence looks
 *   like. A notice never repeats its own marker.
 *
 *   THE PASTE IS A LIST OF THEM. Several `word：sentence` lines in a row is a
 *   vocabulary sheet whatever the words are (fixture 44). A line whose marker
 *   is itself paperwork does not count towards this, or 注意： and 生词： would
 *   vouch for each other.
 *
 * A word that is not paperwork at all never needed vouching for and is
 * declared by the colon alone, exactly as before.
 */
function isHerWord(run: CjkRun, index: number, runs: CjkRun[], manyDeclared: boolean): boolean {
  if (!isPaperwork(run.zh)) return true;
  if (manyDeclared) return true;
  for (let i = index + 1; i < runs.length; i++) {
    if (runs[i].zh.includes(run.zh)) return true;
  }
  return false;
}

/**
 * True when this line declares a word that is not paperwork: the shape that
 * makes a paste a vocabulary sheet rather than a notice. extractVocab counts
 * these across the whole paste. See isHerWord.
 */
export function declaresOrdinaryWord(line: string): boolean {
  const m = /^\s*([\u4e00-\u9fff\u3400-\u4dbf]{1,8})\s*[:：]\s*\S/.exec(line);
  return m !== null && !isPaperwork(m[1]);
}

/**
 * Puts a word back together that OCR cut in half.
 *
 * Reading a photo of a board routinely returns `香 蕉` for 香蕉: the space is an
 * artefact of the picture, not something the teacher wrote. Two runs are joined
 * when a space is all that separates them, at least one of them is a single
 * character, and the dictionary knows the joined word.
 *
 * GATED ON THE LINE HAVING LATIN TEXT ON IT, which is the whole reason this is
 * safe. A teacher drilling single characters writes `人 口 手 大 小`, and 人口
 * (population) is a dictionary word, so joining that list would destroy it. A
 * character list is characters and nothing else; an OCR-ed vocabulary row
 * carries its pinyin or its English on the same line. Only the second is
 * touched.
 */
function mergeBrokenRuns(runs: CjkRun[], dict: ExtractDict | null, hasLatin: boolean): CjkRun[] {
  if (!dict || !hasLatin || runs.length < 2) return runs;

  const out: CjkRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const here = runs[i];
    const next = runs[i + 1];
    const oneIsSingle =
      Array.from(here.zh).length === 1 || (next ? Array.from(next.zh).length === 1 : false);
    if (next && oneIsSingle && /^[ \t\u3000]+$/.test(next.before)) {
      const joined = here.zh + next.zh;
      if (Array.from(joined).length <= MAX_WORD_CHARS && dict.lookup(joined)) {
        // The joined word ends where the SECOND half ended, so what follows it
        // (a colon, say) is the second half's `after`.
        out.push({ zh: joined, before: here.before, after: next.after });
        i++;
        continue;
      }
    }
    out.push(here);
  }
  return out;
}

/**
 * Collapses `苹果/蘋果` into one run, keeping the form she wrote FIRST.
 *
 * Probed live 2026-09-08: `苹果/蘋果 ... 老师/老師` made two cards per pair. In a
 * game that plays as two different questions with one answer, and in Memory
 * Match as two tiles that both look right.
 *
 * Q6 of docs/research/2026-09-08-onboarding-probe-round2.md, answered yes.
 *
 * SAFETY PROPERTY: the two halves must resolve to THE SAME DICTIONARY ENTRY.
 * A slash between two different words is a separator and stays one, which is
 * fixture 21 (`苹果/香蕉/老师/学生/跑步`) and its test.
 *
 * The separator is checked as a whole (a slash, at most a space either side),
 * never as `\s*\/\s*`: see PUNCT_SEPARATORS in parse.ts for what an unbounded
 * quantifier in front of a required character costs.
 */
function collapseSlashPairs(runs: CjkRun[], dict: ExtractDict | null): CjkRun[] {
  if (!dict || runs.length < 2) return runs;
  const out: CjkRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const here = runs[i];
    const next = runs[i + 1];
    if (next && /^[ \t]{0,2}[/／][ \t]{0,2}$/.test(next.before) && isSameEntry(here.zh, next.zh, dict)) {
      // The kept form ends where the SECOND one ended, so whatever follows the
      // pair (a colon, a gloss) still belongs to it.
      out.push({ zh: here.zh, before: here.before, after: next.after });
      i++;
      continue;
    }
    out.push(here);
  }
  return out;
}

/** Drops the pinyin tokens from a line's non-Chinese remainder. */
function dropPinyin(rest: string): string {
  const kept = rest.split(/\s+/).filter((token) => token !== '' && !isPinyinToken(token));
  return kept.join(' ');
}

/** What the caller knows about the line that the line itself cannot say. */
interface LineOptions {
  /** Whether the whole paste reads as sentences (grammar words dropped) or as a list (kept). */
  prose: boolean;
  /**
   * Whether a space between two Chinese runs may be an OCR artefact rather than
   * a separator the teacher typed. See mergeBrokenRuns for why this is a
   * decision the caller has to make.
   */
  mergeBroken: boolean;
  /** The teacher's own English for this line, if she wrote one in a column. */
  gloss?: string;
  /** The teacher's own reading for this line, likewise. */
  pinyin?: string;
  /**
   * Whether the paste as a whole is a run of `word：sentence` lines. Only the
   * caller can see that, and it is what vouches for a paperwork word written
   * in front of a colon. See isHerWord.
   */
  manyDeclared?: boolean;
  /**
   * Where this line sits in the paste, for the sign-off rule. Left out on the
   * structured path: a table cell is not the end of a WeChat message.
   */
  signOff?: SignOffContext;
  /**
   * Whether calendar cards are on for this paste. A whole-paste question, so
   * only the caller can answer it. See calendarCardsFit.
   */
  calendarCards?: boolean;
}

/** What a line cannot know about itself: whether it opens or closes the paste. */
interface SignOffContext {
  /** The paste reads as a MESSAGE, not as a bare list of words. */
  isMessage: boolean;
  /** This is the first line of the paste that holds anything. */
  isFirstLine: boolean;
  /** This is the last line of the paste that holds anything. */
  isLastLine: boolean;
}

/**
 * True when a sign-off run on this line, at this position, really is a sign-off.
 *
 * THE BUG THIS EXISTS FOR. `isSignOffRun` was asked about every run with no
 * idea where the run sat, so a `老师好` or a `谢谢老师` ANYWHERE was deleted.
 * Measured 2026-09-08: `老师好 你好 谢谢 再见`, the standard first-week greetings
 * lesson, came back holding three of its four words, and a bare `谢谢老师` came
 * back EMPTY, which sends the worker to the paid model rescue and turns a
 * deterministic answer into a billed guess. This is the same bug the English
 * twin already fixed: isSignatureOpener takes isLastNonEmpty for exactly this
 * reason, and the Chinese one took nothing.
 *
 * TWO CONDITIONS, both needed.
 *   IT IS A MESSAGE. A bare list of words is a lesson, whatever the words are.
 *     `老师好 你好 谢谢 再见` has no punctuation, no 请 and no marker: nobody
 *     writes a WeChat greeting that way, and every word on it is one she
 *     separated herself. A colon, a comma, a full stop or 请 is what turns the
 *     paste into something a person said rather than a list she typed.
 *   IT IS AT AN END. A sign-off opens or closes; it never sits in the middle of
 *     a list. First run of the first line, or last run of the last line.
 *
 * WHAT THIS REFUSES WHEN ITS ASSUMPTION IS WRONG: a message whose sign-off is
 * buried mid-paste (`苹果 谢谢老师 香蕉`, a teacher who kept typing after saying
 * goodbye) keeps 谢谢 and 老师 as cards. Two junk cards she can delete, against
 * a whole greetings lesson silently losing words. Recoverability decides it.
 */
function isSignOffHere(
  ctx: SignOffContext | undefined,
  index: number,
  total: number
): boolean {
  if (!ctx || !ctx.isMessage) return false;
  if (ctx.isFirstLine && index === 0) return true;
  return ctx.isLastLine && index === total - 1;
}

/**
 * True when the paste reads as a message rather than a bare list of words, and
 * has more than one run in it. See isSignOffHere for the first half.
 *
 * The run count is the floor under the whole rule: a paste whose ONLY run is a
 * sign-off can never be emptied by it. `谢谢老师` alone is two cards (谢谢 and
 * 老师, the way the segmenter reads it and the way main always did), never zero.
 *
 * A COMMA IS NOT A SENTENCE. `、` is the standard Chinese LIST separator and
 * `，` is how the same list gets typed on a phone, so counting either as
 * message punctuation read a lesson as a message and deleted its first word:
 * measured 2026-09-08, `老师好、你好、谢谢、再见` came back holding three of its
 * four words while the space-separated spelling of the same lesson (fixture 56)
 * was right. Three signals are left, and each one is something a person SAID
 * rather than something she listed:
 *   SENTENCE-FINAL  。！？!? A list has no full stops in the middle of it.
 *   请              a request, so somebody is being addressed.
 *   A MARKER        a Chinese word with a colon after it (`生词：`, `这周的生词：`),
 *                   which is a person introducing the list rather than the list.
 * A bare `：` is not enough on its own; it has to follow a word (fixtures 54 and
 * 57 both carry one, and both still lose their sign-off).
 */
function readsAsMessage(body: string): boolean {
  // A LIST MAY END WITH A FULL STOP. The rule above says "a list has no full
  // stops in the MIDDLE of it", and the code tested anywhere, so one trailing
  // keystroke turned the lesson back into a message: `\u8001\u5e08\u597d\u3001\u4f60\u597d\u3001\u8c22\u8c22\u3001\u518d\u89c1\u3002`
  // lost \u8001\u5e08\u597d while fixture 60, the same line without the stop, kept all four.
  // A single sentence-final character at the very end of a \u3001 or \uff0c separated
  // line is the punctuation she put on her list, not somebody speaking. Two of
  // them, or one in the middle, still reads as a message.
  const trimmed = body.trim();
  const listWithOneTrailingStop =
    /[\u3001\uff0c]/.test(trimmed) && /^[^\u3002\uff01\uff1f!?]+[\u3002\uff01\uff1f!?]$/.test(trimmed);
  const probe = listWithOneTrailingStop ? trimmed.slice(0, -1) : trimmed;
  if (!/[\u3002\uff01\uff1f!?]|\u8bf7|[\u4e00-\u9fff\u3400-\u4dbf][:\uff1a]/.test(probe)) return false;
  const runs = body.match(CJK_RUN_RE) ?? [];
  return runs.length > 1;
}

/**
 * Pulls the words out of one line of running text.
 *
 * `lineGloss` is the teacher's own English from that same line, used only when
 * the line turns out to hold exactly one word: `apple 苹果` is a pair written
 * backwards, and her word for it beats the dictionary's.
 *
 * Returns HOW MANY WORDS IT FOUND, which is not the same as how many were
 * added: a word already in the list is found again and added no second time.
 * The structured path needs the first number, not the second. See extractVocab.
 */
function extractFromLine(
  line: string,
  dict: ExtractDict | null,
  out: Collector,
  options: LineOptions
): number {
  const runs = collapseSlashPairs(
    mergeBrokenRuns(splitRuns(line), dict, options.mergeBroken),
    dict
  );
  if (runs.length === 0) return 0;

  // Whatever is not Chinese on this line, with any pinyin reading taken out, so
  // `苹果 píng guǒ apple` offers `apple` as the gloss rather than the reading.
  const rest = dropPinyin(line.replace(CJK_RUN_RE, ' ').replace(/\s+/g, ' ').trim());
  const lineGloss = LINE_GLOSS_RE.test(rest) ? cleanGloss(rest) : '';

  // `pinyin` and `en` are a FALLBACK a rule built for this run (the calendar
  // card is the only one so far), used only where the teacher wrote none.
  const found: Array<{
    zh: string;
    source: ExtractSource;
    pinyin?: string;
    en?: string;
  }> = [];
  // Everything after 生词： on the same line is the list she introduced, so
  // 生词：学习 练习 复习 keeps the three study verbs instead of dropping all
  // three as paperwork and returning nothing at all.
  let listed = false;
  for (let ri = 0; ri < runs.length; ri++) {
    const cjkRun = runs[ri];
    const run = cjkRun.zh;
    // A word written in front of a colon is one she declared, so it is read the
    // way a list is read rather than the way prose is. A PAPERWORK word in
    // front of a colon has to earn it: see isHerWord.
    const marked = isDeclaredHeadword(cjkRun);
    const herWord = marked && isHerWord(cjkRun, ri, runs, options.manyDeclared === true);
    const declared = herWord || listed;
    // A COLON IS NOT ENOUGH TO OPEN A LIST. Only a marker that survived the
    // question above does: a list header (`生词：`, structural paperwork, never
    // a word in any mode) or a word isHerWord accepted as hers (`喜欢：`,
    // `学习：`). `注意：复习。` is a notice, and latching on its colon handed the
    // notice's own contents the list exemption, so 复习 led the game (measured
    // 2026-09-08; main returned nothing for that paste).
    //
    // What this refuses when its assumption is wrong: a header the teacher
    // invents opens no list unless isHerWord accepts it. `重点：苹果 香蕉` is
    // ACCEPTED (measured 2026-09-08: `["重点","苹果","香蕉"]`) - 重点 is not
    // paperwork, so it passes isHerWord and becomes a card of its own, which is
    // the cost of reading it as hers. A word that IS paperwork and is not on
    // the structural list (`完成：`, `注意：`) opens nothing, and the words after
    // it are read as prose. That loses cards in a paste that is prose anyway;
    // the other direction turned every notice into vocabulary.
    if (marked && (herWord || isStructuralPaperwork(run))) listed = true;
    const prose = options.prose && !declared;
    // `谢谢老师` on the end of a WeChat message is a sign-off, not two cards.
    // Whole runs only: a bare 谢谢 inside a beginner's list is still her word.
    // And only where a sign-off can be: see isSignOffHere.
    if (isSignOffRun(run) && isSignOffHere(options.signOff, ri, runs.length)) continue;
    // `1月` through `12月`, `1日`/`1号` through `31日`/`31号`: a calendar unit she
    // numbered on a list rather than a dictionary word the digit merely sat next
    // to. Asked before the dictionary lookup below, because CC-CEDICT has no
    // entry for a number glued onto 月/日/号 and would otherwise fall through to
    // segment() and lose the digit entirely (see monthOrDayCard). Gated on the
    // whole paste as well as on this run: see calendarCardsFit.
    const monthDay = monthOrDayCard(cjkRun, !prose && options.calendarCards !== false);
    if (monthDay) {
      // Carried, NOT added here. Adding inside the loop put the built pinyin and
      // gloss in before the pass below could offer the teacher's own, and
      // Collector.add never overwrites a filled column, so `1月\tenero` came out
      // as January. It also moved every calendar card ahead of the words on the
      // same line. These two are the FALLBACK; hers still wins.
      found.push({
        zh: monthDay.zh,
        source: 'segment',
        pinyin: monthDay.pinyin,
        en: monthDay.en,
      });
      continue;
    }
    // The teacher separated this run herself, so a run the dictionary knows is
    // a word she chose, whatever its length, and a single character she wrote
    // between separators is a word she chose too.
    if (dict && dict.lookup(run) && !isStopword(run, prose, false, declared, marked)) {
      found.push({ zh: run, source: 'dict' });
      continue;
    }
    if (!dict) {
      // No dictionary (the asset is missing, or a caller passed null): we cannot
      // segment, so a short run is taken whole and a long one is left alone
      // rather than shipped as one giant card.
      if (run.length <= MAX_WORD_CHARS && !isStopword(run, prose)) {
        found.push({ zh: run, source: 'segment' });
      }
      continue;
    }
    // `一本书`: the counter in front of the noun says exactly where the word
    // is, so its head noun is kept even when it is one character. Asked before
    // the segmenter runs, because the segmenter is what drops it.
    const head = measureWordPhrase(run, dict);
    if (head !== null && !isStopword(head, prose, true, false, marked)) {
      found.push({ zh: head, source: 'segment' });
      continue;
    }
    // `请复习这些生词` is one run, so the marker test for a piece inside it has
    // to look at its neighbours inside the run: 请 immediately before it, or
    // the run's own colon immediately after it if the piece ends the run.
    const pieces = segment(run, dict);
    for (let pi = 0; pi < pieces.length; pi++) {
      const piece = pieces[pi];
      // A single character the SEGMENTER produced is a leftover, not a word.
      if (!piece.known) continue;
      if (Array.from(piece.zh).length < 2) continue;
      const asMarker =
        (pi > 0 && pieces[pi - 1].zh === '请') || (pi === pieces.length - 1 && marked);
      // `prose`, NOT `options.prose`. The local one already carries the list
      // exemption this run earned (`declared`), and asking the line-wide flag
      // here threw it away the moment a segmented run needed it: measured
      // 2026-09-08, `生词：学习练习复习。` returned NOTHING, so the worker went
      // to the paid model rescue, while the same list without her full stop
      // returned all three words.
      if (isStopword(piece.zh, prose, true, false, asMarker)) continue;
      found.push({ zh: piece.zh, source: 'segment' });
    }
  }

  // A line that made exactly one word IS that word, so whatever the teacher
  // wrote beside it belongs to it. Her own gloss is preferred over the one this
  // line happened to carry, and both beat the dictionary's.
  const single = found.length === 1;
  const gloss = single ? (options.gloss?.trim() || lineGloss) : '';
  const pinyin = single ? (options.pinyin?.trim() ?? '') : '';
  // Hers first, then whatever the rule that found this run built for it. A card
  // added in input order with her own gloss intact is the whole point of doing
  // this here rather than inside the loop.
  for (const f of found) {
    out.add(f.zh, pinyin || f.pinyin || '', gloss || f.en || '', f.source);
  }
  return found.length;
}

/**
 * True when a row parse.ts produced can be kept exactly as it is: one Chinese
 * word, nothing else in it.
 *
 * A row that fails this (`苹果，香蕉，老师` read as one "word", or a whole
 * sentence) is sent down the free path instead.
 */
function isCleanWord(zh: string, dict: ExtractDict | null): boolean {
  if (!isAllCjk(zh)) return false;
  const len = Array.from(zh).length;
  if (len > MAX_WORD_CHARS) return dict ? dict.lookup(zh) !== null : false;
  return true;
}

/**
 * A line with no Chinese at all that is worth showing the teacher as skipped:
 * `Unit 3 Vocabulary`, `Homework: page 12`, `Name:`. Anything is, really. The
 * function exists to keep the two paths saying the same thing.
 */
function isReportableSkip(line: string): boolean {
  return line.trim() !== '' && !hasCJK(line);
}

/**
 * The whole job: text in, vocabulary out.
 *
 * Never throws. A `null` dictionary degrades to short-run-only extraction rather
 * than to one giant word, which is the failure this module exists to end.
 */
/**
 * Does this paste read as sentences or as a list? Sentence punctuation is the
 * clear sign. Without it, a long unbroken run that carries a structural
 * particle (的 了 着 过 是 在) is a sentence someone typed without stops; a run
 * without one (`你好谢谢再见什么为什么还有`) is a list typed without separators.
 */
export function readsAsProse(body: string): boolean {
  if (/[。！？!?]/.test(body)) return true;
  const runs = body.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  return runs.some((run) => Array.from(run).length >= 8 && /[的了着过是在]/.test(run));
}

export function extractVocab(text: string, dict: ExtractDict | null = null): ExtractResult {
  // NFKC FIRST, THEN THE PAGE. The page comes off before anything else reads the
  // paste - what is above `Terms in this set (51)` is somebody else's set, and
  // no reader below can tell that from the words themselves - but it comes off
  // AFTER the fold, because the anchor and the chrome are matched against literal
  // ASCII digits and parentheses. Run before it, a page copied with fullwidth
  // ones matched nothing and the whole sidebar stayed in (round 2 review,
  // should-fix 6). The fold also turns a fullwidth `\uFF12\uFF10\uFF12\uFF16\u5E74` into `2026\u5E74` before
  // the date comes out below.
  const page = withoutQuizletChrome(
    String(text ?? '')
      .replace(/^\uFEFF/, '')
      .normalize('NFKC')
  );
  const result = extractPage(page.text, dict);
  if (page.notes.length === 0) return result;
  return { ...result, notes: [...page.notes, ...(result.notes ?? [])] };
}

function extractPage(normalizedText: string, dict: ExtractDict | null): ExtractResult {
  // A note she wrote in brackets after a word is not a word, and every reader
  // below this line would read it as one. `$1` keeps the word the note was
  // about. This is not part of the date rule, so it is never undone below.
  const clean = normalizedText.replace(CJK_ASIDE_RE, '$1 ');
  // A space is left behind, never nothing, so the words on either side of the
  // date stay two runs.
  const dated = clean.replace(DATE_PART_RE, ' ');

  // THE ONE PASTE THAT IS PAPERWORK ALL THE WAY DOWN. Bare 第N markers and
  // nothing else: a lesson index she copied off a contents page. It is answered
  // here rather than left to the readers below, because each of them finds
  // something in it and none of them is right - the segmenter cards 第 and 课
  // off the last marker (Codex, round 7), and the empty answer the strip does
  // reach is unlabelled, so the worker buys a rescue for it. Every OTHER shape
  // goes down the normal path, including a marker with a gloss beside it, which
  // is a card (round 7c: what she typed as a pair stays a pair).
  //
  // IT REPORTS WHAT IT DROPPED. `skipped: []` used to go back with the empty
  // answer, so the could-not-read screen - the one screen whose whole job is
  // telling her what was thrown away - listed nothing at all, and main listed
  // the marker (`第１２３课` -> `["第123课"]`, measured 2026-09-09).
  if (isMarkerRunOnly(clean)) {
    return {
      items: [],
      skipped: clean.split(/[\s　]+/).filter(Boolean).slice(0, MAX_EXTRACT_ITEMS),
      mode: 'free',
      paperworkOnly: true,
    };
  }

  // AND EVERY OTHER LINE THAT IS NOTHING BUT MARKERS, read token by token and
  // taken off the paste before the date strip runs. Round 9. Two things forced
  // it up here rather than into one of the readers below:
  //
  //   - the date strip cuts the number out of a marker whose unit is also a
  //     calendar unit (`第1月 第2月` -> `第 第`), so a marker only stays one
  //     token if it leaves the paste before DATE_PART_RE sees it;
  //   - the leading-prefix loop in stripHeaders takes markers off the FRONT and
  //     leaves the last one on the line, which is how `第1课 第2课` reached the
  //     segmenter and came back as 第 and 课.
  //
  // What comes back is either her word (`第1天` -> a card reading `day 1`) or
  // her contents page (`第1课` -> reported skipped), per DOC_STRUCTURE_UNITS.
  const markers = readBareMarkerLines(clean);
  if (markers.changed) {
    // The source is decided line by line up there: a marker she glossed is a
    // pair, a marker the reader built a card for is a segment.
    const cards: ExtractedVocab[] = markers.cards.map((c) => ({ ...c }));
    if (markers.rest.trim() === '') {
      // A paste of nothing but markers, with at least one vocabulary unit among
      // them; the all-paperwork twin returned above.
      //
      // THE LABEL ONLY GOES ON WHAT IS ACTUALLY PAPERWORK. It used to go on any
      // empty result from here, and the reader drops an ordinal-VOCABULARY
      // marker whenever its number is out of the table - so `第100天 第101天`,
      // a 100-day challenge list, came back labelled a contents page and the
      // paid rescue was refused (main gave two junk cards but left the rescue
      // open, measured 2026-09-09 with `git archive main`). `paperworkOnly` is
      // the deliberate-empty label: claiming it on a paste that is not
      // paperwork is the one thing it must never do, because it is unappealable
      // - there is no second reader behind it. An unreadable countable marker
      // leaves the result unlabelled and the rescue runs.
      if (cards.length === 0) {
        const allPaperwork = markers.skipped.every((t) => BARE_DOC_STRUCTURE_MARKER_RE.test(t));
        return {
          items: [],
          skipped: markers.skipped,
          mode: 'free',
          ...(allPaperwork ? { paperworkOnly: true } : {}),
        };
      }
      return { items: cards.slice(0, MAX_EXTRACT_ITEMS), skipped: markers.skipped, mode: 'free' };
    }
    // `extractPage`, not `extractVocab`: this text has already been folded and
    // already had its page taken off.
    const rest = extractPage(markers.rest, dict);
    const items = [...cards, ...rest.items].slice(0, MAX_EXTRACT_ITEMS);
    return {
      items,
      skipped: [...markers.skipped, ...rest.skipped],
      mode: rest.mode,
      // A paste that produced a card is not the deliberate empty answer, so the
      // label the rest of the paste may carry does not survive the merge.
      ...(items.length === 0 && rest.paperworkOnly ? { paperworkOnly: true } : {}),
    };
  }

  let result = extractFromPaste(dated, dict);
  // ZERO CARDS IS NEVER THE DATE RULE'S DOING. A rule whose whole job is to
  // remove three characters must not be able to empty the game: an empty
  // answer sends the worker to the paid model rescue (RESCUE_BELOW_ITEMS in
  // src/worker/extract.ts), so a deterministic right answer would become a
  // non-deterministic guess. If taking the dates out left nothing, the dates
  // were the lesson, and the paste is read again exactly as she typed it.
  if (result.items.length === 0 && dated !== clean) result = extractFromPaste(clean, dict);
  if (result.items.length > 0) return result;

  // AND ZERO CARDS IS NEVER THE PAPERWORK RULE'S DOING EITHER. The same
  // argument, one rule over. The retry above only ever covered DATE_PART_RE,
  // so CJK_DATE_LINE_RE - which empties a line through stripHeaders instead of
  // through the date strip - slipped past it entirely: `日期：一月 二月 三月`
  // gave four cards on main and NOTHING on 94f907c, into the paid rescue
  // (round-5 panel, Codex leg #2). Covering the whole strip is the general
  // guard for that family rather than a point fix on one pattern, and it would
  // have caught the space-glossary break above on its own.
  //
  // ONLY WHEN THE ANSWER WOULD OTHERWISE BE BOUGHT. The gate is a CJK COUNT,
  // not a paperwork test: `第一课` on its own stays empty (three characters,
  // under the threshold), while four heading lines clear it. The threshold
  // exists because below it there is no rescue call to save: too little
  // Chinese for the worker to ask about. It is the same threshold the worker
  // uses, restated here rather than imported, since src/shared must not
  // depend on src/worker.
  //
  // AND THE RE-READ IS FILTERED, because it is reading the paste with the
  // paperwork strip switched OFF and paperwork is exactly what it can now see.
  // `第一课 第二课 第三课 第四课` came back as 第一 and 第二, and `日期：年 月 日 号`
  // put 日期 on a card next to the four words she actually listed (both
  // measured on main too). A phantom is worse than an empty answer: an empty
  // answer is something the teacher can see and fix, while a game whose cards
  // are 第 / 课 / 日期 looks like it worked. So an ordinal fragment or a
  // paperwork marker is dropped here, and if nothing real survives the empty
  // answer stands and the rescue path is exactly as it is on main.
  //
  // FILTERING HERE AND NOT IN THE GATE IS THE POINT. A paperwork-only TEST in
  // front of the retry would re-open the glossary hole the retry closed
  // (`日期：一月 二月 三月` is a paperwork-only line by every test we can write,
  // and its three months are the lesson). Only the RESULT can tell the two
  // apart, so the result is what gets read.
  if (wouldBeRescued(clean)) {
    const unstripped = extractFromPaste(clean, dict, false);
    // A bare 第 in the re-read is proof that a 第N unit marker shattered, which
    // is the only way the lone unit character beside it (`第1课` -> 第 + 课) got
    // there. Asked of the result and not assumed, so a paste that really does
    // list 天 or 页 as words keeps them.
    const shattered = unstripped.items.some((item) => item.zh === '第');
    const real = unstripped.items.filter(
      (item) => !isRetryPhantom(item.zh) && !(shattered && HEADING_UNIT_CHARS.has(item.zh))
    );
    if (real.length > 0) return { ...unstripped, items: real };
    // NOTHING SURVIVED, AND THAT IS AN ANSWER. The re-read did find words and
    // the filter above threw every one of them away, which means the paste is
    // headings and nothing else. The empty answer stands, exactly as before,
    // but it is now labelled, because an unlabelled empty answer goes to the
    // paid rescue and comes back with 第 and 课 on cards (round 7b).
    //
    // THE PASTE THIS COMMENT USED TO NAME NO LONGER ARRIVES HERE, and saying so
    // matters more than the example did. It cited `第1课 Lesson one`, the
    // bilingual lesson index. Since round 7c that paste is THREE CARDS and
    // never reaches this branch (measured 2026-09-09, r8 SF-C). What does reach
    // it is a marker with no usable gloss at all: `第1课：` x2, `第一课生词`. A
    // future round reading the old example would mis-model what this protects.
    if (unstripped.items.length > 0) return { ...result, paperworkOnly: true };
  }
  return result;
}

/**
 * 第一 ... 第十, or 第 with digits: an ordinal with its unit torn off. Always a
 * shard of a heading the strip would have removed, never a word.
 */
const ORDINAL_FRAGMENT_RE = /^第[ 　]?(?:[一二三四五六七八九十百千零两]{1,4}|\d{1,4})?$/;

/**
 * The unit half of a 第N marker, on its own. Only ever dropped alongside a bare
 * 第 in the same result: see the call site.
 */
const HEADING_UNIT_CHARS = new Set([
  '课', '課', '单元', '單元', '周', '週', '章', '册', '冊',
  '讲', '講', '天', '节', '節', '页', '頁', '部分',
]);

/**
 * The label she writes ABOVE her list. `日期` is not in the stopword file
 * because on the normal path CJK_DATE_LINE_RE already takes the whole line,
 * so it never reaches a card; the unstripped re-read is the one place it can.
 * Kept local for that reason rather than widened into STRUCTURAL_PAPERWORK,
 * where it would change every path at once.
 */
const RETRY_ONLY_MARKERS = new Set(['日期', '姓名', '班级', '班級']);

/**
 * True when this word is something the retry read off the paperwork rather
 * than off her list. See the filter at the call site for why the question is
 * asked of the RESULT and not of the paste.
 */
function isRetryPhantom(zh: string): boolean {
  return ORDINAL_FRAGMENT_RE.test(zh) || RETRY_ONLY_MARKERS.has(zh) || isPaperwork(zh);
}

/**
 * How much Chinese has to be in a paste before an empty answer is worth paying
 * a model for. Mirrors RESCUE_MIN_CJK in src/worker/extract.ts, which is the
 * gate the empty answer actually falls through.
 */
const RETRY_MIN_CJK = 4;

function wouldBeRescued(text: string): boolean {
  return (text.match(/[㐀-䶿一-鿿豈-﫿々〇]/g) ?? []).length >= RETRY_MIN_CJK;
}

function extractFromPaste(
  normalized: string,
  dict: ExtractDict | null,
  stripPaperwork = true,
  allowPairs = true
): ExtractResult {

  // The paperwork comes out first, so a trailing `Homework: page 12` can never
  // be paired onto the last word as its English meaning.
  const stripped = stripPaperwork
    ? stripHeaders(normalized)
    : { text: normalized, skipped: [] as string[] };
  const body = stripped.text;
  const lines = body.split(/\r\n|\r|\n/);

  // HER OWN DEFINITIONS ARE THE ANSWER KEY. A term / definition list is read
  // here, ahead of parse.ts and the segmenter, because both of them take the
  // term apart: 科技创新 came back as 科技 and 创新 and the definitions donated
  // 电脑 and 东西, 200 cards for a 51-word set (fixture 78, measured
  // 2026-09-09). The term goes on the card exactly as she typed it and the
  // sentence under it is its meaning, which is what the set is FOR: it is a
  // Chinese-taught class with no English anywhere in the paste.
  // A run the pair walk refused as a dialogue leaves a note behind, and the
  // note has to survive every way out of this function: the refusal is exactly
  // the case where there is no reading to carry it (round 6 fix list, item 6).
  const refusals: string[] = [];
  const withRefusals = (result: ExtractResult): ExtractResult =>
    refusals.length === 0
      ? result
      : { ...result, notes: [...(result.notes ?? []), ...refusals] };
  const reading = allowPairs ? readTermDefinitionPairs(lines, refusals) : null;
  if (reading !== null) {
    const paired = new Collector(dict);
    for (const pair of reading.pairs) {
      paired.add(pair.term, '', pair.definition, 'pair', true);
    }
    // PAIR MODE CONSUMES ONLY WHAT IT PAIRED. Everything else goes back down
    // the ordinary path, which is the reader that knows what to do with a
    // spreadsheet row or a bare word list sitting under the pairs. `false`
    // stops that pass from reading pairs again: the leftovers are lines the
    // walk above already refused, and re-running the walk on them would only
    // pair two refusals that happen to have become neighbours.
    const leftover = extractFromPaste(reading.rest.join('\n'), dict, false, false);
    for (const item of leftover.items) {
      paired.add(item.zh, item.pinyin, item.en, item.source);
    }
    // The title is REPORTED, not silently eaten. `isReportableSkip` only ever
    // passes a line with no Chinese in it, so this branch says so itself: what
    // pair mode drops here is Chinese by definition, and a teacher who cannot
    // see it dropped cannot tell why a word is missing (round 1 review).
    // AND A CHINESE LEFTOVER THAT MADE NO CARD IS REPORTED TOO. `isReportableSkip`
    // only ever passes a line with NO Chinese in it, so a Chinese row the readers
    // below could not use vanished without a word, and a teacher who cannot see a
    // row dropped cannot tell why a word is missing (round 1 item 7, still open at
    // the round 2 review). Judged one character at a time against the characters
    // that did reach a card: one pass over the leftovers, never a scan of the item
    // list per line.
    //
    // WHAT COUNTS AS USED IS A WHOLE WORD, NOT A CHARACTER. Judging it one
    // character at a time meant 的, 一 and 我 marked almost every line used, so
    // a row that made no card at all was reported as if it had (round 3 review,
    // must-fix 6). A leftover line is used when it IS a card - its term or its
    // meaning - or when one of its fields is: that is exactly what the row
    // parser consumes out of `苹果\tpíng guǒ\tapple`. Still one pass over the
    // leftovers and a set lookup per field, never a scan of the item list.
    //
    // AND A LINE THE SEGMENTER ATE IS USED, not skipped. Judging it on whole
    // FIELDS alone reported `\u6211\u559c\u6b22\u5403\u82f9\u679c\u548c\u9999\u8549` as skipped while that one line
    // was making three cards, because a Chinese sentence has no separator in it
    // to split on (round 4 review, should-fix 2). The tokens the leftover pass
    // actually produced are the answer, so the scan asks for those: at most
    // MAX_WORD_CHARS lookups per character, which is the segmenter's own cost
    // and stays linear in the paste.
    const onCards = new Set<string>();
    for (const item of paired.items) {
      onCards.add(item.zh);
      const en = item.en.trim();
      if (en !== '') onCards.add(en);
    }
    const eaten = new Set<string>();
    let probe = 0;
    for (const item of leftover.items) {
      const zh = item.zh.trim();
      const n = Array.from(zh).length;
      // Longer than a headword means the row parser cut it out of a row, and
      // the whole-row and field tests above already answer those.
      if (zh === '' || n > MAX_WORD_CHARS) continue;
      eaten.add(zh);
      if (n > probe) probe = n;
    }
    const lost: string[] = [];
    let unlisted = 0;
    for (const line of reading.rest) {
      const row = line.trim();
      if (!hasCJK(row)) continue;
      if (onCards.has(row)) continue;
      let used = false;
      for (const field of row.split(ROW_FIELD_SEPARATOR_RE)) {
        if (field !== '' && onCards.has(field)) {
          used = true;
          break;
        }
      }
      if (!used && probe > 0) {
        const chars = Array.from(row);
        for (let i = 0; i < chars.length && !used; i++) {
          for (let len = Math.min(probe, chars.length - i); len >= 1; len--) {
            if (eaten.has(chars.slice(i, i + len).join(''))) {
              used = true;
              break;
            }
          }
        }
      }
      if (used) continue;
      // A CAP SHE CAN READ. Two hundred skipped lines is a wall of text nobody
      // reads; forty-nine and a count of the rest says the same thing (round 4
      // fix list, item 6). Forty-nine, not fifty, because the count line rides
      // with them over the wire and the worker's own cap of fifty was cutting
      // exactly that line off (Codex round 4, P2).
      //
      // AND A LINE IS QUOTED, NOT REPRINTED. A 2,000-character banner came back
      // whole and the review screen built a 2,027-character warning out of it
      // (round 5 review, should-fix 1).
      if (lost.length < MAX_REPORTED_LEFTOVERS) lost.push(shortened(row));
      else unlisted += 1;
    }
    // THE COUNT IS A NOTE, NOT AN UNREAD LINE. It says how many there were; it
    // is not one of them.
    const notes = [...refusals, ...(reading.duplicates ?? []), ...(leftover.notes ?? [])];
    if (unlisted > 0) notes.push(leftoverSummaryNote(unlisted));
    const result: ExtractResult = {
      items: paired.items.slice(0, MAX_EXTRACT_ITEMS),
      skipped: [...stripped.skipped, ...reading.title, ...lost, ...leftover.skipped],
      mode: 'structured',
    };
    if (notes.length > 0) result.notes = notes;
    return result;
  }

  // The dictionary goes down with the paste so parse.ts can tell a merged Excel
  // label (`\u7b2c1\u5468`) from a real word that happens to start with \u7b2c (`\u7b2c\u4e00\u6b21`, "the
  // first time"). Without it parse.ts stripped the word (round 15).
  const pre = parseVocab(body, { isHeadword: (token) => !!dict?.lookup(token) });
  // Columns mean the teacher laid the paste out as a table. A gloss or a pinyin
  // on most rows means she wrote the pairs herself. Either way parse.ts read it
  // correctly and its answer is the one to keep.
  //
  // TWO glossed rows are required, not one, because of the flattened two-column
  // paste: all the Chinese, then all the English. parse.ts pairs the first
  // English line onto the last Chinese one and reports the rest as skipped, so
  // a four-word paste of that shape arrives here as four items with exactly one
  // (wrong) gloss. One glossed row is never evidence that the teacher wrote the
  // pairs herself; it is the signature of a shape that must go down the free
  // path, where each line is read on its own.
  const hasColumns = /\t/.test(body) || /\S\s\|\s\S/.test(body);
  const glossed = pre.items.filter((it) => it.en.trim() !== '' || it.pinyin.trim() !== '').length;
  // AND A GLOSSARY OF 第N MARKERS IS STRUCTURED HOWEVER SHORT IT IS. The
  // two-glossed-rows floor above is right about ordinary words and wrong about
  // these, because the free path it sends them to cannot hold the term
  // together: `第一天 the first day` on its own came back as `第一/the first
  // day` (measured 7c; `第1天` split at the digit into 第/but and 天/day). A card
  // whose Chinese does not mean the English on it is a wrong answer key, which
  // is worse than either failure the floor was protecting against. The rule is
  // narrow on purpose: EVERY row has to be a bare marker with a gloss, so the
  // flattened two-column paste the floor exists for is untouched. Round 7c.
  const markerGlossary =
    pre.items.length > 0 &&
    pre.items.every((it) => it.en.trim() !== '' && BARE_ORDINAL_MARKER_RE.test(it.zh.trim()));
  const structured =
    pre.items.length > 0 &&
    (hasColumns || markerGlossary || (glossed >= 2 && glossed * 2 >= pre.items.length));

  const out = new Collector(dict);
  const skipped: string[] = [...stripped.skipped];
  // Asked ONCE per paste, never per row: it scans the whole body.
  const calendarCards = calendarCardsFit(body);

  if (structured) {
    for (const item of pre.items) {
      const zh = item.zh.trim();
      // A 第N MARKER SHE GLOSSED HERSELF IS ONE CARD. `第1课` is not a clean word
      // (the digit fails isAllCjk), so without this it goes to extractFromLine
      // and comes back as the Chinese runs 第 and 课: a card whose Chinese does
      // not mean the English beside it, which is a wrong answer key in the game.
      // The Chinese-numeral twin `第一天` already survives as a clean word, so
      // this only ever bites the digit spelling of the same row. Round 7c.
      if (item.en.trim() !== '' && BARE_ORDINAL_MARKER_RE.test(zh)) {
        out.add(zh, item.pinyin.trim(), item.en.trim(), 'pair');
        continue;
      }
      if (isCleanWord(zh, dict)) {
        out.add(zh, item.pinyin.trim(), item.en.trim(), 'pair');
        continue;
      }
      // The row holds more than one word (`苹果，香蕉` in a column) or a whole
      // phrase. Cut it up, and if nothing survives keep the row as the teacher
      // wrote it: an explicit row is never silently dropped.
      //
      // mergeBroken is on here because this field is already the term column: a
      // space inside it (`香 蕉`, straight off a photo) cannot be the teacher
      // separating two words, since she separated her columns some other way.
      //
      // WHAT WAS FOUND, not what was added. A row whose words are all already in
      // the list (`苹果 香蕉` above, `苹果香蕉` here) adds nothing, and the old
      // test on the list LENGTH read that as "nothing survives" and put the
      // whole row on a card as one giant word. The row was read fine; it was a
      // repeat. A giant word is the one thing this module exists to prevent.
      const found = extractFromLine(zh, dict, out, {
        prose: readsAsProse(zh),
        mergeBroken: true,
        gloss: item.en,
        pinyin: item.pinyin,
        // The same whole-paste question as the free path. `signOff` is left out
        // on purpose: a table cell is not the end of a message.
        calendarCards,
      });
      if (found === 0) out.add(zh, item.pinyin.trim(), item.en.trim(), 'pair');
    }
    for (const line of pre.skipped) {
      if (isReportableSkip(line)) skipped.push(line.trim());
    }
    return withRefusals({
      items: out.items.slice(0, MAX_EXTRACT_ITEMS),
      skipped,
      mode: 'structured',
    });
  }

  const prose = readsAsProse(body);
  // TWO of them, not one: one 喜欢：我喜欢吃苹果。 is a sentence with a colon in
  // it, and a run of them is a vocabulary sheet.
  const manyDeclared = lines.filter((l) => declaresOrdinaryWord(l)).length >= 2;
  // The two whole-paste questions a line cannot answer for itself: is this a
  // message (so a sign-off at either end is a sign-off), and does every numbered
  // single character in it name a calendar unit (so a numbered list is a
  // calendar and not a character lesson).
  const isMessage = readsAsMessage(body);
  let firstLine = -1;
  let lastLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (firstLine === -1) firstLine = i;
    lastLine = i;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (!hasCJK(line)) {
      skipped.push(line);
      continue;
    }
    const options: LineOptions = {
      // In running text a space between two Chinese words is the teacher's own
      // separator (`苹果 香蕉 老师`), so runs are only rejoined on a line that
      // also carries Latin text, which is what an OCR-ed glossary row looks
      // like.
      prose: prose || readsAsProse(line),
      mergeBroken: /[A-Za-z]/.test(line),
      manyDeclared,
      signOff: { isMessage, isFirstLine: i === firstLine, isLastLine: i === lastLine },
      calendarCards,
    };
    // A WHOLE 第N MARKER IS ONE TOKEN ON THIS PATH TOO. Round 7c kept the marker
    // together in the structured path only, so a paste that mixes one glossed
    // marker with anything else fell to here, where splitRuns cuts `第1课` at
    // the digit and the dictionary answers the halves: measured on 44d2a41,
    // `第1课 Lesson one\n第2课\n苹果 香蕉` returned 第/but and 课/subject and lost
    // her glossed row. Round 9, F1.
    const segments = readMarkerSegments(line);
    if (segments === null) {
      extractFromLine(line, dict, out, options);
      continue;
    }
    for (const seg of segments) {
      if (seg.kind === 'card') out.add(seg.zh, seg.pinyin, seg.en, seg.source);
      else if (seg.kind === 'drop') skipped.push(seg.zh);
      else extractFromLine(seg.text, dict, out, options);
    }
  }

  return withRefusals({ items: out.items.slice(0, MAX_EXTRACT_ITEMS), skipped, mode: 'free' });
}

/** How many items came from each path. The worker reports this to the client. */
export function countSources(items: ExtractedVocab[]): {
  pair: number;
  dict: number;
  segment: number;
} {
  const counts = { pair: 0, dict: 0, segment: 0 };
  for (const item of items) counts[item.source]++;
  return counts;
}

