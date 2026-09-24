// Vocab list parser. One item per line, pasted by a teacher from anywhere:
// a Quizlet tab export, a Quizlet page copied straight off the screen, a
// Google Sheets CSV, a Chinese-comma list, or a plain Chinese-only list.
//
// Implements amendment 6 of docs/plans/2026-09-07-mvp-plan.md:
//   NFKC normalize; try tab, then CSV (quoted fields), then ` | ` / `｜`;
//   only then punctuation separators, and only when exactly one side is CJK;
//   pinyin tokens with spaces stay together; numbered-list prefixes
//   (`1.`, `1、`, `①`) stripped; fullwidth `：；／` and `，` are separators
//   (NFKC folds them to ASCII); header lines and blanks are skipped.
//
// Four shapes were added on 2026-09-08, from section 6 of
// docs/research/2026-09-08-quizlet-extraction.md:
//   - bullets (`- 你好`, `• 你好`) alongside the numbered prefixes;
//   - pinyin in brackets, `苹果 (píng guǒ) apple`;
//   - a plain space between the Chinese and the rest, `你好 hello there`,
//     split ONCE at the last Chinese character so the gloss stays whole;
//   - a whole line of Chinese words with spaces between them (`苹果 香蕉 老师`),
//     which is what a teacher gets by typing a list across one line instead of
//     down a column: every token is Chinese, so the spaces are separators;
//   - the alternating-lines clipboard shape, where a teacher selects the terms
//     on a Quizlet set page and copies: Chinese on one line, the English on the
//     next. A line with no Chinese becomes the gloss (or the pinyin) of the
//     line above it when that line is still missing one. This is the only path
//     that works for a set the teacher did not create, so it matters more than
//     the Export dialog does.
//
// Every split takes the FIRST delimiter only. A definition may contain commas
// ("hold back, 自制, 抑制"), so a split-all would quietly cut glosses in half.

export interface ParsedItem {
  zh: string;
  pinyin: string;
  en: string;
}

export interface ParseResult {
  items: ParsedItem[];
  /** Lines that had content but no Chinese, so we could not make an item. */
  skipped: string[];
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u3007]/;

/** True when the string contains at least one Chinese character. */
export function hasCJK(s: string): boolean {
  return CJK_RE.test(s);
}

// Tone-marked vowels, plus `ü` (which never appears in an English gloss).
// `ń ň ǹ ḿ` cover the interjection syllables pinyin-pro can emit.
const TONE_MARK_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹḿ]/i;
// A digit-tone syllable such as `ni3`, `lv4`, `nv3`, or a bare `er` in a run.
const DIGIT_TONE_SYLLABLE_RE = /^[a-zü]{1,6}[1-5]$/i;
/**
 * The same syllables written with no spaces at all: `ping2guo3`, `ni3hao3`.
 * That is what a teacher gets from a keyboard that cannot make tone marks, and
 * from more than one textbook glossary. Two or more syllables are required, so
 * a lone `a1` still has to arrive as its own token, and the digits mean no
 * English word can ever match this by accident.
 */
const DIGIT_TONE_RUN_RE = /^(?:[a-zü]{1,6}[1-5]){2,}$/i;

/**
 * Pinyin detection is deliberately narrow: tone marks (or `ü`) anywhere, or a
 * run of digit-tone syllables. We do NOT try to recognise untoned romanisation
 * (`ni hao`), because far too many untoned syllables are also English words
 * (`an`, `men`, `he`, `long`, `she`, `die`). An untoned romanisation therefore
 * lands in the English column, where the teacher can move it in the review
 * table. A whole phrase (`nǐ hǎo`) is kept together as one token.
 */
export function isPinyinToken(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if (hasCJK(t)) return false;
  if (TONE_MARK_RE.test(t)) return true;

  const chunks = t.split(/[\s'·]+/).filter(Boolean);
  if (chunks.length === 0) return false;
  return chunks.every((c) => DIGIT_TONE_SYLLABLE_RE.test(c) || DIGIT_TONE_RUN_RE.test(c));
}

/**
 * THE 第N MARKER VOCABULARY LIVES HERE, not in extract.ts, because both files
 * need it and parse.ts is the one extract.ts imports (the other direction is a
 * cycle). The ARGUMENT for the split between the two lists is written out at
 * the point of use in `src/shared/extract.ts`; this is only the data.
 *
 * DOC_STRUCTURE_UNITS name a part of a document (lesson, unit, chapter). They
 * are what a teacher puts in the first column of a table to say where a row
 * came from. ORDINAL_VOCAB_UNITS name a countable thing (day, week, month)
 * and `第1天` really can be the word on the card, so they are NOT paperwork.
 */
export const DOC_STRUCTURE_UNITS = [
  '课', '課', '單元', '单元', '章', '册', '冊', '讲', '講', '节', '節', '页', '頁', '部分',
];
export const ORDINAL_VOCAB_UNITS = ['天', '周', '週', '名', '次', '年', '月', '个', '個'];
/**
 * FIVE CHARACTERS, NOT FOUR. `第九百九十九天` is the longest number the ordinal
 * table reads (round 11b took it to 999), and its numeral is five characters:
 * at {1,4} the marker did not match at all and the paste shattered into
 * dictionary fragments (`九十`/ninety, `九天`/the ninth heaven, measured
 * 2026-09-09). A digit run longer than the table can read still matches here
 * and is simply refused a number downstream, which is the wanted answer: an
 * ordinary token, never paperwork.
 */
export const ORDINAL_NUMERAL = '[一二三四五六七八九十百千零两\\d]{1,5}';
/** ONE OPTIONAL SPACE AFTER 第; see the r3-MF1 note in extract.ts. */
export const ORDINAL_STEM = `第[ \\u3000]?${ORDINAL_NUMERAL}`;
/**
 * `第1课` / `第一單元` and nothing glued to either end: a marker that names a
 * part of a document. Used by the column rule below and re-exported through
 * extract.ts, which owns the reasoning.
 */
export const BARE_DOC_STRUCTURE_MARKER_RE = new RegExp(
  `^(?:${ORDINAL_STEM}(?:${DOC_STRUCTURE_UNITS.join('|')}))$`
);
/**
 * The same for a COUNTABLE unit: `第1周`, `第3天`, `第2名`. Used only by the
 * column rule below, and only when the same field index carries one on two or
 * more rows. `第1天` on its own really can be the word on the card, so this
 * must never be read as "paperwork" the way the doc-structure pattern is.
 */
const BARE_ORDINAL_VOCAB_MARKER_RE = new RegExp(
  `^(?:${ORDINAL_STEM}(?:${ORDINAL_VOCAB_UNITS.join('|')}))$`
);

const HEADER_WORDS = new Set([
  'chinese',
  'english',
  'pinyin',
  'term',
  'terms',
  'definition',
  'definitions',
  'word',
  'words',
  'meaning',
  'meanings',
  'front',
  'back',
  'question',
  'answer',
  'vocab',
  'vocabulary',
  'translation',
  'hanzi',
  'character',
  'characters',
  'gloss',
  'mandarin',
  'notes',
  '中文',
  '汉字',
  '漢字',
  '英文',
  '拼音',
  '词语',
  '詞語',
  '单词',
  '單詞',
  '生词',
  '生詞',
  '生词表',
  '生詞表',
  '单词表',
  '單詞表',
  '词语表',
  '詞語表',
  '词汇',
  '詞彙',
  '意思',
  '解释',
  '解釋',
  '翻译',
  '翻譯',
  // THE LESSON COLUMN'S TITLE. `课\t生词\t英文` over `第1课\t苹果\tapple` rows is
  // the shape a teacher gets out of Excel, and without this the title row came
  // back as three cards (课/subject, 生词/new word, 英文/English, measured
  // 2026-09-09). It can only ever fire on a line whose EVERY field is a column
  // name and which has three or more of them, so a real two-column row
  // (`课\tlesson`) is untouched by the floor above.
  //
  // ROUND 11b: AND THE OTHER SEVENTEEN UNITS. Adding 课 alone covered one shape
  // out of nine, and `isHeaderLine` wants EVERY field to be a column name, so a
  // single unrecognised unit poisoned the whole title row: `周\t生词\t英文`
  // came back as three cards (周/circle, 生词/new word, 英文/English), and so
  // did `天\t中文\t英文` and `单元\t生词\t英文` (measured 2026-09-09). Every
  // unit in BOTH lists is a column title when it stands in a row of nothing but
  // column titles; the three-field floor is what keeps `周\tweek` a real row.
  ...DOC_STRUCTURE_UNITS,
  ...ORDINAL_VOCAB_UNITS,
]);

/**
 * A line whose every field is a column name, e.g. `Chinese,English`.
 *
 * Quotes are stripped per token because a Google Sheets CSV export quotes every
 * field, so the header arrives as `"Chinese","English"`. Without the strip that
 * header was not recognised and the teacher was shown it as a skipped line.
 */
function looksLikeHeader(line: string): boolean {
  const tokens = line
    .split(/[\t,;:|\/、]+/)
    .map((t) => stripWrappingQuotes(t).toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  // THREE FIELDS ONCE THERE IS CHINESE ON THE LINE, the same floor extract.ts's
  // isAllColumnTitles carries, and for the same reason: in a glossary ABOUT
  // words the title words ARE the vocabulary, and a two-field row of them is
  // exactly what an ordinary row of that glossary looks like. Measured
  // 2026-09-08: `意思\tmeaning` over `例句\texample` over `苹果\tapple` returned
  // `["例句","苹果"]`, so 意思, a word she typed and glossed herself, was never
  // seen again. extract.ts got this floor and priced the other side as "at most
  // one junk card, because parse.ts's own first-row filter takes it"; that
  // filter is this one, and it was taking a real word.
  //
  // THE FLOOR IS NOT APPLIED TO A LATIN-ONLY LINE. `Chinese,English` and
  // `Term\tDefinition` cannot be Chinese vocabulary whatever else they are, so
  // there is no word to lose and they stay headers.
  //
  // WHAT THIS REFUSES WHEN ITS ASSUMPTION IS WRONG: a genuine two-column Chinese
  // header (`生词\t英文`) is no longer dropped here and arrives as a row.
  //
  // THE COST IS TWO JUNK CARDS, NOT ONE, and this comment used to say otherwise.
  // It claimed 生词 "comes off in extract.ts anyway"; measured on the real
  // dictionary (round-4 panel, reproduced here 2026-09-09), it does not come off
  // on the structured path. `生词\t英文` over three fruit rows returns
  // ["生词","英文","苹果","香蕉","橘子"] - BOTH title words survive. The CSV
  // spelling `生词,英文` returns ["英文","苹果","香蕉"], one. extract.ts's
  // stopword list is prose-only and structural words are not in it, which is the
  // open question the probe doc names for JJ.
  //
  // The TRADE still holds and is why the floor stays: two junk cards the teacher
  // deletes, against a word she typed and never saw again. Recoverability
  // decides it. The arithmetic just has to be stated honestly.
  if (tokens.length < 3 && hasCJK(line)) return false;
  return tokens.every((t) => HEADER_WORDS.has(t));
}

/** Splits one CSV line, honouring "quoted, fields" and "" escapes. */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',' || ch === '\t') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

// Punctuation separators, tried in order. Each is only accepted when the split
// leaves exactly one side holding the Chinese (amendment 6), so an all-English
// line like "hello, hi there" is never chopped into two fields.
//
// NOT `\s*[,;:\/]\s*`, THOUGH THAT IS THE OBVIOUS WAY TO WRITE IT. Every caller
// trims each field and drops the empty ones, so the surrounding `\s*` changes no
// answer, and it costs the whole line: an unbounded quantifier in front of a
// required character is retried from every position in the string, which made a
// 60 KB line of spaces take 4.1 s to split (measured 2026-09-08). The spaces
// around the dash cannot go, because they are what tells a separator dash from
// the hyphen inside `ice-cream`, so they are BOUNDED instead: nobody writes nine
// spaces before a dash, and a line that does is caught by `\s{2,}` below.
const PUNCT_SEPARATORS: RegExp[] = [
  /[,;:\/]/,
  /[、。]/,
  /\s{1,8}[-–—]\s{1,8}/,
  /\s{2,}/,
];

interface SplitLine {
  fields: string[];
  /**
   * True for a line split on bare punctuation, where the separator is also
   * ordinary English punctuation. `苹果,apple, the fruit` is one gloss the
   * teacher wrote with a comma in it, not two columns, so the leftover fields
   * are joined back onto the gloss instead of being dropped. Real columns
   * (tab, quoted CSV, `|`) keep their own meaning and are never joined.
   */
  joinExtras: boolean;
}

function splitFields(line: string): SplitLine {
  if (line.includes('\t')) {
    return { fields: csvFields(line), joinExtras: false };
  }
  if (line.includes('"')) {
    const fields = csvFields(line);
    if (fields.length > 1) return { fields, joinExtras: false };
  }
  if (line.includes('|')) {
    const parts = line
      // Bare `|`, not `\s*\|\s*`: the trim below already removes the spaces, and
      // the unbounded quantifier in front of a required character is what makes
      // a long line quadratic. See PUNCT_SEPARATORS.
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) return { fields: parts, joinExtras: false };
  }

  for (const sep of PUNCT_SEPARATORS) {
    const parts = line
      .split(sep)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    const cjkParts = parts.filter(hasCJK).length;
    if (cjkParts === 1) return { fields: parts, joinExtras: true };
  }

  const boundary = splitAtCjkBoundary(line);
  if (boundary) return { fields: boundary, joinExtras: false };

  return { fields: [line], joinExtras: false };
}

/**
 * Splits `你好 hello there` into `你好` and `hello there` on a single space.
 *
 * The cut is made at the FIRST whitespace after the LAST Chinese character, so
 * a multi-character phrase stays together on the left and the whole gloss stays
 * together on the right. Anything with a real delimiter has already been
 * handled above; this is the last resort, and it is why the home screen can
 * honestly promise that `你好 hello` works.
 *
 * Returns null when the line has no Chinese, or no space after it.
 */
function splitAtCjkBoundary(line: string): string[] | null {
  let last = -1;
  for (let i = 0; i < line.length; i++) {
    if (CJK_RE.test(line[i])) last = i;
  }
  if (last < 0) return null;

  const tail = line.slice(last + 1);
  const gap = /\s+/.exec(tail);
  if (!gap) return null;

  const left = line.slice(0, last + 1 + gap.index).trim();
  const right = line.slice(last + 1 + gap.index + gap[0].length).trim();
  if (!left || !right) return null;
  return [left, ...splitPinyinPrefix(right)];
}

/**
 * Peels a leading pinyin run off the right-hand side: `tú shū guǎn library`
 * becomes `tú shū guǎn` and `library`.
 *
 * Without this, `图书馆 tú shū guǎn library` would hand the whole right side to
 * isPinyinToken, which sees the tone marks and calls the entire string pinyin.
 * A right side that is ALL pinyin is left in one piece, so `你好 nǐ hǎo` still
 * parses as a word plus its pinyin and no gloss.
 */
function splitPinyinPrefix(rest: string): string[] {
  const chunks = rest.split(/\s+/).filter(Boolean);
  let n = 0;
  while (n < chunks.length && isPinyinToken(chunks[n])) n++;
  if (n === 0 || n === chunks.length) return [rest];
  return [chunks.slice(0, n).join(' '), chunks.slice(n).join(' ')];
}

/**
 * `苹果 香蕉 老师 学生`: a line that is nothing but Chinese words with spaces
 * between them. A teacher who types the list across one line instead of down a
 * column used to get one giant "word" holding the whole line, because the
 * space rule above cuts at the LAST Chinese character and there is nothing
 * after it. Returns the words, or null when the line is any other shape.
 *
 * The test is deliberately strict: two or more space-separated tokens, and
 * every character of every token is Chinese. So `苹果 apple`, `图书馆 library`
 * and `你好 nǐ hǎo` are untouched, and only a line with no English on it at all
 * is read as a row of separate words.
 */
function splitCjkOnlyRun(line: string): string[] | null {
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  for (const token of tokens) {
    for (const ch of token) {
      if (!CJK_RE.test(ch)) return null;
    }
  }
  return tokens;
}

function stripWrappingQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
}

/** Leading `①`-style markers, removed before NFKC folds them to bare digits. */
const CIRCLED_PREFIX_RE = /^\s*[\u2460-\u2473\u2776-\u277f\u24ea]\s*/;
// `1.` `1、` `1)` `1 ` — only stripped when Chinese survives the strip.
const NUMBER_PREFIX_RE = /^\d{1,3}\s*(?:[.、。)\]:,]\s*|\s+)/;
/**
 * A list marker: a bullet, a number, or a bullet then a number. `- 你好`,
 * `1. 你好`, `• 1) 你好`. Only stripped when it does not change whether the line
 * holds Chinese, so a line that is nothing but a dash keeps its content.
 */
const LIST_PREFIX_RE = new RegExp(
  `^(?:[-*•·‣▪◦※–—]+\\s*)?(?:${NUMBER_PREFIX_RE.source.slice(1)})?`
);

/**
 * A bracketed group, e.g. the `(píng guǒ)` in `苹果 (píng guǒ) apple`. NFKC has
 * already folded fullwidth brackets to ASCII by the time this runs; `【】` and
 * `〔〕` are not folded, so they are listed.
 */
const BRACKET_RE = /[([{【〔]([^)\]}】〕]{1,40})[)\]}】〕]/;

/**
 * Pulls a bracketed pinyin reading out of a line and hands back the rest.
 *
 * The bracket is replaced by a space rather than deleted, so `苹果(píng guǒ)apple`
 * still leaves a boundary for splitAtCjkBoundary to cut on. A bracket that is
 * not pinyin (`苹果 (fruit) apple`) is left exactly where the teacher put it.
 */
function extractBracketPinyin(line: string): { line: string; pinyin: string } {
  const match = BRACKET_RE.exec(line);
  if (!match) return { line, pinyin: '' };
  const inner = match[1].trim();
  if (!isPinyinToken(inner)) return { line, pinyin: '' };
  const rest = `${line.slice(0, match.index)} ${line.slice(match.index + match[0].length)}`
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!rest) return { line, pinyin: '' };
  return { line: rest, pinyin: inner };
}

/**
 * WHICH FIELD INDICES ARE A COUNTABLE-MARKER COLUMN, decided over the WHOLE
 * paste before any line is read.
 *
 * A countable marker (`第1周`, `第3天`, `第2名`) is genuinely ambiguous on one
 * row: it can be the word she means, and the round 9 unit split exists to say
 * so. What is not ambiguous is the SAME field index carrying one on two or more
 * rows - that is a Week column, and the word beside it is the term. So the
 * column rule below asks the question once per COLUMN rather than once per row,
 * and every single-row shape keeps the behaviour it had.
 *
 * A MERGED CELL IS THE SAME COLUMN WITH THE LABEL TYPED ONCE. Round 12's
 * must-fix: Excel writes a merged "Week" cell on the FIRST row of the group and
 * leaves the rest blank, so the two-row count never reaches 2, the marker is
 * read as the term, and the word she typed beside it is thrown away in favour
 * of a card whose answer key says "apple" means 第1周. From the outside a
 * merged cell looks like exactly one thing: a marker on one row and an EMPTY
 * field at the same index on another row that has content. That second signal
 * is counted here alongside the two-row one.
 *
 *   第1周 <tab> 苹果 <tab> apple      index 0: a marker
 *          <tab> 香蕉 <tab> banana     index 0: empty, and the row has content
 *
 * A single-row paste has no other row, so `第1周\t苹果\tapple` on its own still
 * keeps the marker exactly as round 11 locked it, and markers sitting at
 * different indices still never make a column.
 *
 * Deliberately loose about what a row is: it splits on the same separators
 * `splitFields` does and counts, so a stray heading line costs nothing. Linear
 * in the paste, one extra split per line.
 */
function findOrdinalVocabColumns(rawLines: string[], isHeadword: (token: string) => boolean): Set<number> {
  const counts = new Map<number, number>();
  const emptyOnAContentRow = new Set<number>();
  // Every marker token seen at each index, so the one-row signal below can ask
  // whether the thing it is about to throw away is a word in its own right.
  const markerTokens = new Map<number, string[]>();
  for (const rawLine of rawLines) {
    // A LEADING TAB IS KEPT HERE and nowhere else in the file. It is the whole
    // merged-cell signal: `\t香蕉\tbanana` is a row whose first column is
    // empty, and trimming it turns that into an ordinary two-field row, which
    // is what hid the bug. Other leading whitespace is still removed, so an
    // indented line cannot shift every field index by one.
    const line = rawLine
      .replace(/^﻿/, '')
      .normalize('NFKC')
      // `trimEnd()`, never `/\s+$/`: an unanchored-left `\s+$` over a line of
      // 60,000 spaces backtracks and took 3.5 s here. The leading class is a
      // single quantifier anchored at ^, which has one way to match.
      .replace(/^[^\S\t]+/, '')
      .trimEnd();
    if (!line.trim()) continue;
    const fields = splitFields(line).fields.map(stripWrappingQuotes);
    // A row carries content when it has some Chinese and some other filled
    // field beside it - the shape of a body row under a merged label. A
    // two-field row (`周\tweek`) is not one, which is what keeps the
    // three-field floor from round 11 intact.
    if (fields.length >= 3 && fields.some((f) => hasCJK(f))) {
      fields.forEach((field, i) => {
        if (field.trim() === '') emptyOnAContentRow.add(i);
      });
    }
    if (fields.filter((f) => hasCJK(f)).length < 2) continue;
    fields.forEach((field, i) => {
      const token = field.trim();
      if (BARE_ORDINAL_VOCAB_MARKER_RE.test(token)) {
        counts.set(i, (counts.get(i) ?? 0) + 1);
        // Push, never spread-copy: a table with thousands of marker rows would
        // otherwise copy a growing array per row (Codex, round 15).
        const seen = markerTokens.get(i);
        if (seen) seen.push(token);
        else markerTokens.set(i, [token]);
      }
    });
  }
  // ROUND 15. The empty-cell signal alone stole a real word. `\u7b2c\u4e00\u6b21` is a CC-CEDICT
  // headword meaning "the first time", and `\u7b2c\u4e00\u6b21\t\u5934\u4e00\u56de\tthe first time` over a row whose
  // first cell is blank came back as `\u5934\u4e00\u56de = the first time` with the word she
  // actually taught deleted. A merged Excel label is paperwork (`\u7b2c1\u5468`, `\u7b2c3\u5929`,
  // `\u7b2c1\u8bfe`); a dictionary headword is vocabulary. So the ONE-ROW signal is
  // refused when the token is a word. Two marker rows are still a column
  // whatever the token is: nobody types the same word down a column beside
  // three different glosses.
  return new Set(
    [...counts]
      .filter(
        ([i, n]) =>
          n >= 2 ||
          (emptyOnAContentRow.has(i) && !(markerTokens.get(i) ?? []).some(isHeadword))
      )
      .map(([i]) => i)
  );
}

/**
 * Parses a pasted vocab list.
 *
 * Duplicate Chinese entries are collapsed to the first occurrence (a repeated
 * word would break Memory Match pairing and Bingo cards); later occurrences
 * only fill in a pinyin or gloss the first one was missing.
 */
export interface ParseOptions {
  /**
   * True when the token is a word in its own right (a CC-CEDICT headword).
   *
   * parse.ts ships no dictionary and must not grow one: the 8 MB asset lives on
   * the server and this file runs in the browser too. extract.ts already holds
   * the dictionary and passes a lookup down. The default answers "never a
   * headword", so parse.ts called on its own behaves exactly as round 13 left
   * it, and only the dictionary-carrying caller gets the sharper rule.
   */
  isHeadword?: (token: string) => boolean;
}

export function parseVocab(text: string, options: ParseOptions = {}): ParseResult {
  const isHeadword = options.isHeadword ?? (() => false);
  const items: ParsedItem[] = [];
  const skipped: string[] = [];
  const byZh = new Map<string, ParsedItem>();
  let seenContent = false;

  /** Adds a word, or fills the columns a duplicate was missing. */
  function addItem(zh: string, pinyin: string, en: string): ParsedItem {
    const existing = byZh.get(zh);
    if (existing) {
      if (!existing.pinyin && pinyin) existing.pinyin = pinyin;
      if (!existing.en && en) existing.en = en;
      return existing;
    }
    const item: ParsedItem = { zh, pinyin, en };
    byZh.set(zh, item);
    items.push(item);
    return item;
  }

  // The item the last line with Chinese produced, so a following line that has
  // no Chinese can be read as its gloss (the alternating-lines shape).
  let previous: ParsedItem | null = null;

  const rawLines = String(text ?? '').split(/\r\n|\r|\n/);
  const ordinalVocabColumns = findOrdinalVocabColumns(rawLines, isHeadword);

  for (const rawLine of rawLines) {
    let line = rawLine.replace(/^\uFEFF/, '');
    line = line.replace(CIRCLED_PREFIX_RE, '');
    line = line.normalize('NFKC').trim();
    if (!line) continue;

    // A marker may be stripped from an English line too (`- hello` under a
    // Chinese line), but never when stripping it would take the Chinese away.
    const stripped = line.replace(LIST_PREFIX_RE, '').trim();
    if (stripped && hasCJK(stripped) === hasCJK(line)) line = stripped;

    if (!seenContent && looksLikeHeader(line)) {
      seenContent = true;
      continue;
    }
    seenContent = true;

    // A whole line of Chinese words with spaces between them is a list, not one
    // word. It is checked before every other split because every other rule
    // reads a space as the boundary between a word and its gloss.
    const run = splitCjkOnlyRun(line);
    if (run) {
      for (const word of run) addItem(word, '', '');
      // A row of words is not the alternating-lines shape: an English line
      // under it has no single word above it to belong to.
      previous = null;
      continue;
    }

    const bracket = extractBracketPinyin(line);
    const split = splitFields(bracket.line);
    const fields = split.fields.map(stripWrappingQuotes).filter(Boolean);

    // WHICH CHINESE COLUMN IS THE WORD. The first one used to win, and on the
    // commonest spreadsheet layout there is - `Lesson | Chinese | English` -
    // the first one is the lesson number. `第1课\t苹果\tapple` x5 came back as
    // five cards reading 第1课=apple (measured 2026-09-09, r8 must-fix): every
    // word she typed gone, and in its place a confident wrong answer key, which
    // is the one failure this module exists to prevent. A marker column standing
    // BESIDE her word is paperwork; the word is the term.
    //
    // A DOC-STRUCTURE MARKER (课, 单元, 章) IS DROPPED THIS WAY ON SIGHT: a
    // lesson number is never the word on the card.
    //
    // A COUNTABLE MARKER (天, 周, 名) IS DROPPED ONLY WHEN IT IS A COLUMN, i.e.
    // when the same field index carries one on two or more rows. `第1天` can be
    // the word on the card and the round 9 unit split exists to say so, but a
    // Week column is not that: `第1周\t苹果\tapple` x3 answered 第1周=apple and
    // lost all three words she typed, while the SPACE-separated twin of that
    // exact paste already returned them (measured 2026-09-09, r10 MF-1). One
    // handout, two opposite answers, decided by which key she pressed between
    // the columns. Asking per column rather than per row settles it without
    // touching any single-row shape: `第1周\t苹果\tapple` alone still keeps the
    // marker, and so does `第一次\t头一回\tthe first time`.
    //
    // THIS DOES NOT TOUCH THE ROUND 7c DECISION. It needs TWO Chinese columns to
    // fire. `第1课\tLesson one` (fixture 66) has one, so the marker is still the
    // term and her pair is still a card.
    //
    // WHAT IT REFUSES WHEN ITS ASSUMPTION IS WRONG: a table whose real vocabulary
    // word IS a lesson marker and which also carries another Chinese column
    // (`第1课\t第一課\tlesson one`) loses the marker. Both fields are markers
    // there, so the fallback keeps the first and nothing is lost in practice.
    //
    // NOTE THE INDEX IS THE ONE INTO `fields`, not into the CJK-only subset:
    // the marker-column map is keyed by the position in the row a spreadsheet
    // actually wrote, so an English column between two Chinese ones does not
    // shift it.
    const cjk = fields.map((f, i) => ({ f, i })).filter(({ f }) => hasCJK(f));
    const isPaperwork = ({ f, i }: { f: string; i: number }) =>
      BARE_DOC_STRUCTURE_MARKER_RE.test(f.trim()) ||
      (ordinalVocabColumns.has(i) && BARE_ORDINAL_VOCAB_MARKER_RE.test(f.trim()));
    const termField =
      cjk.length > 1 ? (cjk.find((c) => !isPaperwork(c))?.f ?? cjk[0].f) : cjk[0]?.f;

    let zh = '';
    let pinyin = bracket.pinyin;
    const gloss: string[] = [];
    for (const field of fields) {
      if (!zh && hasCJK(field) && field === termField) {
        zh = field;
        continue;
      }
      if (hasCJK(field)) continue; // extra Chinese column: ignore
      if (!pinyin && isPinyinToken(field)) {
        pinyin = field;
        continue;
      }
      gloss.push(field);
    }
    const en = split.joinExtras ? gloss.join(', ') : (gloss[0] ?? '');

    if (!zh) {
      // The alternating-lines shape: a Quizlet set page copied off the screen
      // puts the Chinese on one line and the English on the next. Attach this
      // line to the word above it when that word is still missing the column,
      // and only then. A second English line in a row, or an English line with
      // no word above it, is still reported as skipped rather than guessed at.
      if (previous && !hasCJK(line)) {
        if (pinyin && gloss.length === 0 && !previous.pinyin) {
          previous.pinyin = pinyin;
          continue;
        }
        const text = gloss.join(', ');
        if (text && !previous.en) {
          previous.en = text;
          continue;
        }
      }
      skipped.push(line);
      continue;
    }

    previous = addItem(zh, pinyin, en);
  }

  return { items, skipped };
}

