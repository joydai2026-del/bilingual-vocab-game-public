// Every shape a teacher has actually pasted, run against the REAL dictionary.
//
// WHAT THIS FILE IS FOR
// On 2026-09-08 a teacher pasted `苹果，香蕉，老师，学生` and got ONE word: a card
// holding the entire line, and a screen asking her to type its English meaning.
// Nothing in the test suite caught it, because every parser test used a shape
// the parser was written for. tests/fixtures/teacher-pastes/ is the answer to
// that: 36 pastes in the shapes teachers really use, each one a `.txt` beside a
// `.expected.json` saying which words MUST come out and which strings must NOT.
//
// The dictionary is public/cedict.json, the same 177k-headword asset the worker
// serves. Loading the real one is the point: a fake dictionary would pass this
// file while the deployed extractor kept failing, which is exactly the gap that
// let the bug ship.
//
// The expectation format is deliberately loose. `must` is what the teacher
// plainly meant; `mustNot` is what has actually gone wrong before (a whole line
// as one word, grammar on a card, a header line used as somebody's meaning).
// Nothing pins the exact item count, so a segmenter that finds one extra real
// word is an improvement rather than a failure.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeDict, type Dict } from '../src/worker/dict';
import {
  MAX_EXTRACT_ITEMS,
  MAX_REPORTED_LEFTOVERS,
  MAX_REPORTED_LINE_CHARS,
  countSources,
  extractVocab,
  isHeaderLine,
  isPairDefinition,
  isPairHeading,
  isPairTerm,
  isConversationalLine,
  isSignatureOpener,
  readTermDefinitionPairs,
  segment,
  withoutQuizletChrome,
  isLeftoverSummaryNote,
  leftoverSummaryNote,
  leftoverSummaryCount,
} from '../src/shared/extract';
import { isStopword } from '../src/shared/stopwords';
import { parseVocab } from '../src/shared/parse';
import { readExtractBody } from '../src/client/input/extract';
import {
  EXTRACT_EMPTY,
  EXTRACT_TOO_BIG,
  MAX_EXTRACT_BYTES,
  MAX_NOTES_REPORTED,
  MAX_SKIPPED_REPORTED,
  cachedRescue,
  cjkCount,
  clearRescueCache,
  mergeRescue,
  needsRescue,
  parseWordArray,
  rescueCacheKey,
  rescueCacheSize,
  rescueWithModel,
  reportedNotes,
  toResponse,
  validateExtractBody,
  validateRescue,
  type ExtractEnv,
} from '../src/worker/extract';

// decodeURIComponent because the repository path contains a space, which a
// file URL percent-encodes and readFileSync does not decode back.
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname);
const FIXTURES = join(ROOT, 'tests/fixtures/teacher-pastes');

/** The real shipped asset. Built by `npm run build:dict`. */
const dict: Dict = makeDict(JSON.parse(readFileSync(join(ROOT, 'public/cedict.json'), 'utf8')));

interface Expected {
  why: string;
  must: string[];
  mustNot: string[];
  mode?: 'structured' | 'free';
  minItems?: number;
  /**
   * An UPPER bound, for the shapes where finding one more word is the bug
   * rather than an improvement: a heading read as vocabulary, a repeated row
   * kept whole. Most fixtures leave it out, so a better segmenter still passes.
   */
  maxItems?: number;
}

interface Fixture {
  name: string;
  text: string;
  expected: Expected;
}

function loadFixtures(): Fixture[] {
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.txt'))
    .sort();
  return names.map((file) => {
    const name = file.replace(/\.txt$/, '');
    return {
      name,
      text: readFileSync(join(FIXTURES, file), 'utf8'),
      expected: JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8')) as Expected,
    };
  });
}

const fixtures = loadFixtures();

/** One row of the summary table printed at the end of the run. */
const report: string[] = [];

describe('the dictionary the fixtures are graded against', () => {
  it('is the real one, not a stub', () => {
    // A wrong path or a missing build would silently make every segmentation
    // test pass for the wrong reason, so the size is asserted first.
    expect(dict.size).toBeGreaterThan(100_000);
    expect(dict.lookup('苹果')?.en).toBeTruthy();
  });
});

describe('teacher pastes', () => {
  it('there are enough of them to mean something', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(39);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: ${fixture.expected.why}`, () => {
      const result = extractVocab(fixture.text, dict);
      const found = result.items.map((item) => item.zh);
      const missing = fixture.expected.must.filter((word) => !found.includes(word));
      const glossless = fixture.expected.must.filter((word) => {
        const item = result.items.find((it) => it.zh === word);
        return item !== undefined && item.en.trim() === '';
      });
      const leaked = fixture.expected.mustNot.filter(
        (bad) => found.includes(bad) || result.items.some((it) => it.en.trim() === bad)
      );

      report.push(
        [
          fixture.name.padEnd(28),
          `${String(fixture.expected.must.length - missing.length).padStart(2)}/${String(
            fixture.expected.must.length
          ).padStart(2)} wanted`,
          `${String(result.items.length).padStart(3)} found`,
          result.mode.padEnd(10),
          missing.length === 0 && glossless.length === 0 && leaked.length === 0 ? 'ok' : 'FAIL',
        ].join('  ')
      );

      expect(missing, `${fixture.name}: words the teacher meant, not found`).toEqual([]);
      // A word with no English is dropped from the games by src/client/build.ts,
      // so "found it" is not the bar. It has to arrive playable.
      expect(glossless, `${fixture.name}: found but with no English meaning`).toEqual([]);
      expect(leaked, `${fixture.name}: something that must never appear`).toEqual([]);

      if (fixture.expected.mode) expect(result.mode).toBe(fixture.expected.mode);
      if (fixture.expected.minItems) {
        expect(result.items.length).toBeGreaterThanOrEqual(fixture.expected.minItems);
      }
      // `!== undefined`, not truthiness: fixture 66 wants EXACTLY zero cards,
      // and `maxItems: 0` read as falsy would have skipped the only assertion
      // that says so.
      if (fixture.expected.maxItems !== undefined) {
        expect(
          result.items.map((it) => it.zh),
          `${fixture.name}: found more words than the paste holds`
        ).toHaveLength(fixture.expected.maxItems);
      }
    });
  }

  it('never returns a duplicate, whatever the shape', () => {
    for (const fixture of fixtures) {
      const found = extractVocab(fixture.text, dict).items.map((i) => i.zh);
      expect(new Set(found).size, `${fixture.name} repeated a word`).toBe(found.length);
    }
  });

  it('never returns a word longer than a card can hold', () => {
    for (const fixture of fixtures) {
      for (const item of extractVocab(fixture.text, dict).items) {
        // A dictionary headword may legitimately be long (an idiom). Anything
        // longer that the dictionary does NOT know is the old bug coming back.
        if (Array.from(item.zh).length > 4) {
          expect(dict.lookup(item.zh), `${fixture.name}: "${item.zh}" is not a word`).not.toBeNull();
        }
      }
    }
  });

  it('prints what every fixture produced', () => {
    // Straight to stdout: vitest captures console output from a passing test,
    // and a table nobody can see is not a report.
    process.stdout.write(
      `\n  fixture                       wanted        found  mode\n` +
        `  ${'-'.repeat(66)}\n` +
        report
          .sort()
          .map((row) => `  ${row}`)
          .join('\n') +
        `\n\n  ${fixtures.length} teacher pastes, graded against ${dict.size} dictionary headwords\n\n`
    );
    expect(report.length).toBe(fixtures.length);
  });
});

describe('the parts, on their own', () => {
  it('segments a run by longest match first', () => {
    expect(segment('苹果香蕉', dict).map((p) => p.zh)).toEqual(['苹果', '香蕉']);
    expect(segment('图书馆', dict).map((p) => p.zh)).toEqual(['图书馆']);
  });

  it('flags the characters it had to guess at', () => {
    const pieces = segment('苹果\u3400', dict);
    expect(pieces[0]).toEqual({ zh: '苹果', known: true });
    expect(pieces[pieces.length - 1].known).toBe(false);
  });

  it('reads a header line only when punctuation or a digit says so', () => {
    expect(isHeaderLine('Unit 3 Vocabulary')).toBe(true);
    expect(isHeaderLine('Homework: page 12')).toBe(true);
    expect(isHeaderLine('Name:')).toBe(true);
    // The safety property: a bare English word is never paperwork, so a real
    // gloss can never be eaten however close it looks to a heading word.
    expect(isHeaderLine('teacher')).toBe(false);
    expect(isHeaderLine('test')).toBe(false);
    expect(isHeaderLine('page')).toBe(false);
    expect(isHeaderLine('to review')).toBe(false);
    expect(isHeaderLine('苹果')).toBe(false);
  });

  it('keeps grammar off the cards but never off a row the teacher wrote', () => {
    expect(isStopword('的')).toBe(true);
    expect(isStopword('我们')).toBe(true);
    expect(isStopword('苹果')).toBe(false);
    // A teacher who typed the gloss herself meant it: the structured path does
    // not consult the stopword list at all.
    const grammar = extractVocab('的\tpossessive particle\n了\taspect marker\n吗\tquestion word', dict);
    expect(grammar.items.map((i) => i.zh)).toEqual(['的', '了', '吗']);
  });

  // The three below come from probing the LIVE /api/extract on 2026-09-08 with
  // pastes a real teacher makes. Each one shipped a wrong word list.

  it('reads the date on a lesson line as a date, not as three words', () => {
    const result = extractVocab('第三课 2026年9月8日 生词：苹果 香蕉 葡萄 西瓜', dict);
    const found = result.items.map((i) => i.zh);
    expect(found).toEqual(['苹果', '香蕉', '葡萄', '西瓜']);
    // A calendar lesson still teaches them, because nothing numbers them.
    expect(extractVocab('年 月 日', dict).items.map((i) => i.zh)).toEqual(['年', '月', '日']);
  });

  it('reads the column titles of a Chinese spreadsheet as titles', () => {
    expect(isHeaderLine('序号\t生词\t拼音\t英文')).toBe(true);
    expect(isHeaderLine('词语 | 拼音 | 意思')).toBe(true);
    // The safety property: it takes a WHOLE ROW of titles. One title beside a
    // real word is a real row, and a bare word is never a header.
    expect(isHeaderLine('拼音\t苹果\tpíngguǒ')).toBe(false);
    expect(isHeaderLine('英文')).toBe(false);
    const table = extractVocab(
      '序号\t生词\t拼音\t英文\n1\t苹果\tpíngguǒ\tapple\n2\t香蕉\txiāngjiāo\tbanana',
      dict
    );
    expect(table.items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
  });

  it('keeps a word she declared in front of a colon, whatever the stopword list says', () => {
    // 学习 is on the prose stopword list, and the example sentence makes this
    // paste prose, so it used to disappear from her own vocabulary list.
    const result = extractVocab('喜欢：我喜欢吃苹果。\n学习：我每天学习中文。', dict);
    expect(result.items.map((i) => i.zh)).toContain('学习');
    expect(result.items.map((i) => i.zh)).toContain('喜欢');
    // Paperwork in front of a colon is still paperwork.
    expect(extractVocab('生词：苹果 香蕉', dict).items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
  });

  // The three below are round 2b: the WHAT answers JJ gave to Q4, Q5 and Q6 of
  // docs/research/2026-09-08-onboarding-probe-round2.md, each probed live first.

  it('keeps the noun of a measure-word phrase even when it is one character', () => {
    const result = extractVocab('一本书 一支笔 三个苹果 两只猫', dict);
    expect(result.items.map((i) => i.zh)).toEqual(['书', '笔', '苹果', '猫']);
    // The counter itself is never the word.
    expect(result.items.map((i) => i.zh)).not.toContain('一本');
    // THE SAFETY PROPERTY: this does not revive the general single-character
    // drop. A character the segmenter merely guessed at inside a longer chunk
    // is still a leftover, not a word.
    expect(extractVocab('图书馆和公园', dict).items.map((i) => i.zh)).toEqual(['图书馆', '公园']);
    // And a run that is not number + classifier + noun is read as before.
    expect(extractVocab('苹果香蕉', dict).items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
  });

  it('reads Chinese in brackets as a note about the word, not another word', () => {
    const result = extractVocab('苹果（水果）香蕉（水果）老师（人）', dict);
    expect(result.items.map((i) => i.zh)).toEqual(['苹果', '香蕉', '老师']);
    // Her own English in brackets is still her gloss. Byte for byte what the
    // base commit produced, measured on 5a1aa25 rather than assumed: the round
    // brackets stay in the gloss text, which is a separate (pre-existing, and
    // cosmetic) thing and deliberately not touched here.
    const glossed = extractVocab('苹果 (apple)\n香蕉 (banana)', dict);
    expect(glossed.items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
    expect(glossed.items.map((i) => i.en)).toEqual(['(apple)', '(banana)']);
    // Bracketed pinyin is still a reading, unchanged.
    expect(extractVocab('苹果 (píng guǒ) apple', dict).items[0].en).toBe('apple');
    // A line that is nothing BUT a bracketed aside has no word in front of it,
    // so there is nothing to attach the note to and nothing to crash on.
    expect(() => extractVocab('（水果）', dict)).not.toThrow();
  });

  it('collapses a simplified/traditional slash pair into the form she wrote first', () => {
    const result = extractVocab('苹果/蘋果 学习/學習 老师/老師', dict);
    // Round 2d: this paste is a bare list, and on a bare list 学习 is an
    // ordinary word she chose rather than the paperwork around somebody's list,
    // so it is a card. What matters here is that the traditional half of the
    // pair still makes no card of its own behind it.
    expect(result.items.map((i) => i.zh)).toEqual(['苹果', '学习', '老师']);
    // Written the other way round, the traditional form is the one she wrote
    // first, so the traditional form is the one that is kept.
    expect(extractVocab('蘋果/苹果', dict).items.map((i) => i.zh)).toEqual(['蘋果']);
    // THE SAFETY PROPERTY: a slash between two DIFFERENT words is a separator
    // and always was. Fixture 21 is this line.
    expect(extractVocab('苹果/香蕉/老师/学生/跑步', dict).items.map((i) => i.zh)).toEqual([
      '苹果',
      '香蕉',
      '老师',
      '学生',
      '跑步',
    ]);
  });

  it('counts which path each word came from', () => {
    const result = extractVocab('苹果\tapple\n香蕉\tbanana', dict);
    expect(countSources(result.items)).toEqual({ pair: 2, dict: 0, segment: 0 });
    const free = extractVocab('苹果，香蕉', dict);
    expect(countSources(free.items).dict).toBe(2);
  });

  it('caps a runaway paste instead of building an unplayable set', () => {
    const huge = Array.from({ length: 400 }, () => '苹果香蕉老师学生图书馆跑步游泳高兴漂亮水果').join('，');
    expect(extractVocab(huge, dict).items.length).toBeLessThanOrEqual(MAX_EXTRACT_ITEMS);
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of ['', '   ', '\n\n', '???', '🍎🍌', 'no chinese at all']) {
      expect(() => extractVocab(junk, dict)).not.toThrow();
    }
    expect(extractVocab('苹果，香蕉', null).items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
  });

  it('reads a sign-off only when the line is really a sign-off', () => {
    // WITH punctuation it is a sign-off wherever it appears.
    expect(isSignatureOpener('Best,', false)).toBe(true);
    expect(isSignatureOpener('Thanks.', false)).toBe(true);
    expect(isSignatureOpener('Regards!', false)).toBe(true);
    expect(isSignatureOpener('--', false)).toBe(true);
    expect(isSignatureOpener('Sent from my iPhone', false)).toBe(true);
    // WITHOUT it, only as the last line, where there is nothing left to lose.
    expect(isSignatureOpener('Thanks', true)).toBe(true);
    expect(isSignatureOpener('Thanks', false)).toBe(false);
    expect(isSignatureOpener('Cheers', false)).toBe(false);
    expect(isSignatureOpener('Yours', false)).toBe(false);
    // And never a line with a word on it.
    expect(isSignatureOpener('苹果 apple', true)).toBe(false);
  });

  it('never lets a signature swallow a line with Chinese on it', () => {
    // Even the unambiguous opener stops at the next word. Whatever `--` meant,
    // it did not mean "delete the rest of my list".
    const result = extractVocab('苹果 apple\n--\nMs. Chen\n香蕉 banana\n老师 teacher', dict);
    expect(result.items.map((i) => i.zh)).toEqual(['苹果', '香蕉', '老师']);
    expect(result.skipped).toContain('Ms. Chen');
  });

  it('reads a Chinese heading as paperwork, and only a whole one', () => {
    expect(isHeaderLine('第一课生词')).toBe(true);
    expect(isHeaderLine('生词表')).toBe(true);
    expect(isHeaderLine('第三单元词汇')).toBe(true);
    expect(isHeaderLine('第五课')).toBe(true);
    // A line with a list on it is a list, however it starts.
    expect(isHeaderLine('这周的生词：苹果 香蕉 老师')).toBe(false);
    expect(isHeaderLine('生词表 苹果 香蕉')).toBe(false);
    expect(isHeaderLine('苹果')).toBe(false);
  });

  it('never puts a row back as one giant word when its words were repeats', () => {
    // EVERY word of the last row is already in the list. That row adds nothing,
    // and reading "added nothing" as "nothing survived" used to put the whole
    // row on a card as one six-character word.
    const rows = '苹果\tapple\n香蕉\tbanana\n老师\tteacher\n苹果香蕉老师\tall three';
    const result = extractVocab(rows, dict);
    expect(result.items.map((i) => i.zh)).toEqual(['苹果', '香蕉', '老师']);
    for (const item of result.items) expect(Array.from(item.zh).length).toBeLessThanOrEqual(4);
    // A row that really does hold something new is still read for it.
    const withNew = extractVocab('苹果\tapple\n香蕉\tbanana\n苹果香蕉老师\tand a teacher', dict);
    expect(withNew.items.map((i) => i.zh)).toEqual(['苹果', '香蕉', '老师']);
    // And a row nothing at all can be made of is never silently dropped.
    const unreadable = extractVocab('苹果\tapple\n香蕉\tbanana\n㐀㐁㐂㐃㐄\tsomething', dict);
    expect(unreadable.items.map((i) => i.zh)).toContain('㐀㐁㐂㐃㐄');
  });

  it('reads a line of nothing but spaces in milliseconds, not seconds', () => {
    // `\s*#?\s*` in the heading pattern and `\s*[,;:/]\s*` in the row splitter
    // are each an unbounded quantifier in front of a required character, retried
    // from every position: this line took 5.9 s and 4.1 s respectively on
    // 2026-09-08. The fix measures under 1 ms.
    //
    // THE BOUND IS 200 ms, NOT 50. A wall-clock assertion measures the machine
    // as well as the code, and 50 ms was not a measurement of the fix, it was a
    // measurement of an idle laptop: under eight competing CPU-burn processes
    // this line took 80.6 ms and the test went red on code that was correct
    // (round-3 panel, 2026-09-08). 200 ms is still 20x faster than the smaller
    // of the two bugs, so a regression that reintroduces seconds of
    // backtracking cannot hide under it, and it matches the bound the sibling
    // timing test below already uses.
    const line = 'Unit' + ' '.repeat(60000) + 'x';
    const started = performance.now();
    extractVocab(line, dict);
    const ms = performance.now() - started;
    expect(ms, `60,000 spaces took ${ms.toFixed(0)} ms`).toBeLessThan(200);
  });
});

// --- the worker half ----------------------------------------------------------
//
// The route's own validation, and the guard rails on the model rescue. The
// rescue is the only place a model touches this path, so what it is NOT allowed
// to do is what these tests are about.

describe('POST /api/extract, the parts that are pure', () => {
  it('refuses a body that is not a paste', () => {
    expect(validateExtractBody(null).ok).toBe(false);
    expect(validateExtractBody({}).ok).toBe(false);
    expect(validateExtractBody({ text: 42 }).ok).toBe(false);
    const empty = validateExtractBody({ text: '   ' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toBe(EXTRACT_EMPTY);
  });

  it('refuses a paste bigger than one request may carry', () => {
    const huge = validateExtractBody({ text: '苹'.repeat(MAX_EXTRACT_BYTES) });
    expect(huge.ok).toBe(false);
    if (!huge.ok) {
      expect(huge.status).toBe(413);
      expect(huge.error).toBe(EXTRACT_TOO_BIG);
    }
    // The ceiling is BYTES, not characters: Chinese costs three bytes each, so
    // a character-counted cap would let a paste three times this size through.
    expect(validateExtractBody({ text: '苹果' }).ok).toBe(true);
  });

  it('asks for help only when the dictionary found almost nothing', () => {
    const nothing = extractVocab('㐀㐁㐂㐃', dict);
    expect(needsRescue(nothing, '㐀㐁㐂㐃')).toBe(true);
    // Two words is already a game. Nothing is rescued after that.
    const enough = extractVocab('苹果，香蕉', dict);
    expect(needsRescue(enough, '苹果，香蕉')).toBe(false);
    // And a paste with no Chinese in it is not a failed read, it is an English
    // paste, so it never costs a model call.
    const english = extractVocab('hello there', dict);
    expect(needsRescue(english, 'hello there')).toBe(false);
  });

  it('reads a model answer out of whatever wrapper it arrives in', () => {
    expect(parseWordArray('["苹果","香蕉"]')).toEqual(['苹果', '香蕉']);
    expect(parseWordArray('Sure! Here you go: ["苹果","香蕉"] Hope that helps.')).toEqual([
      '苹果',
      '香蕉',
    ]);
    expect(parseWordArray(['苹果', '香蕉'])).toEqual(['苹果', '香蕉']);
    expect(parseWordArray('not json at all')).toEqual([]);
    expect(parseWordArray(null)).toEqual([]);
  });

  it('lets the model propose but never invent, and never teach grammar', () => {
    const text = '苹果香蕉';
    // A real word, present in the paste: kept, with the DICTIONARY's reading and
    // meaning rather than anything the model said about it.
    const kept = validateRescue(['苹果'], text, dict);
    expect(kept.map((i) => i.zh)).toEqual(['苹果']);
    expect(kept[0].en).toBe(dict.lookup('苹果')?.en);
    expect(kept[0].pinyin).toBe(dict.lookup('苹果')?.pinyin);

    // A word the dictionary has never heard of: dropped, so a hallucinated
    // word can never reach a card.
    expect(validateRescue(['㐀㐁'], text, dict)).toEqual([]);
    // A real word that is NOT in the teacher's paste: dropped too, so the model
    // cannot add vocabulary she did not ask for.
    expect(validateRescue(['老师'], text, dict)).toEqual([]);
    // Repeats collapse, because a duplicate breaks Memory Match pairing.
    expect(validateRescue(['苹果', '苹果'], text, dict).length).toBe(1);
  });

  it('drops what a model answers that is real but is not a vocabulary word', () => {
    // Every one of these IS in the paste and IS a CC-CEDICT headword, so the
    // present-and-known pair of tests passes all of them. 的 了 我 是 are
    // grammar, 一个 is grammar, and IP 3Q 88 A are not Chinese at all.
    const paste = '的了我是一个 IP 3Q 88 A 苹果';
    const answered = ['的', '了', '我', '是', '一个', 'IP', '3Q', '88', 'A', '苹果'];
    expect(validateRescue(answered, paste, dict).map((i) => i.zh)).toEqual(['苹果']);
    // Named one at a time, so a failure says WHICH test stopped working.
    expect(validateRescue(['的'], paste, dict)).toEqual([]);
    expect(validateRescue(['一个'], paste, dict)).toEqual([]);
    expect(validateRescue(['IP'], paste, dict)).toEqual([]);
    expect(validateRescue(['88'], paste, dict)).toEqual([]);
    // A word that is genuinely two Chinese characters with a Latin letter stuck
    // to it is not a word either.
    expect(validateRescue(['苹果A'], '苹果A', dict)).toEqual([]);
  });

  it('sends back at most fifty skipped lines', () => {
    // A paste of prose skips every line of it, and the reply used to carry the
    // whole paste back to a phone.
    const prose = Array.from({ length: 200 }, (_, i) => `note number ${i}`).join('\n');
    const result = extractVocab(`${prose}\n苹果，香蕉`, dict);
    expect(result.skipped.length).toBeGreaterThan(MAX_SKIPPED_REPORTED);
    expect(toResponse(result).skipped).toHaveLength(MAX_SKIPPED_REPORTED);
    // The words are untouched by the cap. It is the courtesy list that is cut.
    expect(toResponse(result).items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
  });

  it('answers in exactly the shape the client reads', () => {
    const body = toResponse(extractVocab('苹果，香蕉，老师', dict));
    expect(body.mode).toBe('free');
    expect(body.items.map((i) => i.zh)).toEqual(['苹果', '香蕉', '老师']);
    for (const item of body.items) {
      // src/client/input/extract.ts reads exactly these three fields.
      expect(Object.keys(item).sort()).toEqual(['en', 'pinyin', 'zh']);
    }
    expect(body.counts.pair + body.counts.dict + body.counts.segment).toBe(body.items.length);
    expect(Array.isArray(body.skipped)).toBe(true);
    expect(body.rescued).toBeUndefined();
  });

  it('counts Chinese characters and not bytes when deciding to rescue', () => {
    expect(cjkCount('苹果香蕉')).toBe(4);
    expect(cjkCount('apple banana')).toBe(0);
    expect(cjkCount('苹果 apple')).toBe(2);
  });
});

// --- the rescue cache ---------------------------------------------------------
//
// One Map in front of the model call. What it is for is not speed: it is the
// daily budget. A teacher whose paste did not work presses the button again.

describe('the rescue cache', () => {
  /** An AI that counts how many times it was asked, and always answers 苹果. */
  function countingEnv(): { env: ExtractEnv; calls: () => number } {
    let calls = 0;
    const env = {
      AI: {
        run: async () => {
          calls++;
          return '["苹果"]';
        },
      },
    } as unknown as ExtractEnv;
    return { env, calls: () => calls };
  }

  it('asks the model once for a paste, however often it arrives', async () => {
    clearRescueCache();
    const { env, calls } = countingEnv();
    const paste = '苹果㐀㐁㐂';
    const first = await rescueWithModel(env, paste, dict, 2);
    expect(first.items.map((i) => i.zh)).toEqual(['苹果']);
    expect(first.attempts).toBe(1);
    expect(calls()).toBe(1);

    const second = await rescueWithModel(env, paste, dict, 2);
    expect(second.items.map((i) => i.zh)).toEqual(['苹果']);
    // Nothing was spent the second time: no attempt to charge, no model call.
    expect(second.attempts).toBe(0);
    expect(calls()).toBe(1);
  });

  it('remembers the EMPTY answer too, which is the expensive one', async () => {
    clearRescueCache();
    let calls = 0;
    const env = {
      AI: {
        run: async () => {
          calls++;
          return 'I could not find any words.';
        },
      },
    } as unknown as ExtractEnv;
    const paste = '㐀㐁㐂㐃';
    const first = await rescueWithModel(env, paste, dict, 2);
    expect(first.items).toEqual([]);
    expect(first.attempts).toBe(2);
    expect(calls).toBe(2);

    // The whole plan ran and found nothing. Running it again finds nothing
    // again, for the same money. So it does not run again.
    const second = await rescueWithModel(env, paste, dict, 2);
    expect(second.items).toEqual([]);
    expect(second.attempts).toBe(0);
    expect(calls).toBe(2);
    // And the route can see the remembered empty answer without spending.
    expect(cachedRescue(paste)).toEqual([]);
  });

  it('reads the same paste typed twice as one paste', () => {
    clearRescueCache();
    // NFKC and collapsed whitespace: a fullwidth paste and a spaced-out retype
    // of the same list are one key.
    expect(rescueCacheKey('苹果  香蕉\n')).toBe(rescueCacheKey('苹果 香蕉'));
    expect(rescueCacheKey('ＡＢ')).toBe(rescueCacheKey('AB'));
    expect(rescueCacheKey('苹果')).not.toBe(rescueCacheKey('香蕉'));
  });

  it('has not been asked about a paste it has never seen', () => {
    clearRescueCache();
    expect(cachedRescue('苹果香蕉老师')).toBeUndefined();
  });

  it('holds two hundred pastes and no more', async () => {
    clearRescueCache();
    const { env } = countingEnv();
    for (let i = 0; i < 260; i++) {
      await rescueWithModel(env, `苹果${'㐀'.repeat(i + 1)}`, dict, 1);
    }
    expect(rescueCacheSize()).toBe(200);
    // The oldest went out, the newest stayed.
    expect(cachedRescue('苹果㐀')).toBeUndefined();
    expect(cachedRescue(`苹果${'㐀'.repeat(260)}`)).toEqual([
      { zh: '苹果', pinyin: dict.lookup('苹果')?.pinyin, en: dict.lookup('苹果')?.en, source: 'segment' },
    ]);
  });

  it('never hands one teacher the words of another', async () => {
    clearRescueCache();
    const { env } = countingEnv();
    await rescueWithModel(env, '苹果㐀㐁㐂', dict, 1);
    // Whatever the hash says, a remembered word that is not in THIS paste is
    // dropped before the caller ever sees it.
    expect(cachedRescue('香蕉㐀㐁㐂')).toBeUndefined();
  });

  it('hands back a copy, so one caller cannot edit what the next one reads', async () => {
    clearRescueCache();
    const { env } = countingEnv();
    const paste = '苹果㐀㐁㐂';
    await rescueWithModel(env, paste, dict, 1);
    const mine = cachedRescue(paste);
    expect(mine).toBeDefined();
    if (mine) mine[0].en = 'something I made up';
    expect(cachedRescue(paste)?.[0].en).toBe(dict.lookup('苹果')?.en);
  });

  it('puts the dictionary first and the rescue after it', () => {
    const base = extractVocab('苹果，香蕉', dict);
    const rescued = [
      { zh: '老师', pinyin: 'lao3 shi1', en: 'teacher', source: 'segment' as const },
      // Already found without a model: not counted, not repeated.
      { zh: '苹果', pinyin: 'ping2 guo3', en: 'apple', source: 'segment' as const },
    ];
    const body = mergeRescue(base, rescued);
    expect(body.items.map((i) => i.zh)).toEqual(['苹果', '香蕉', '老师']);
    expect(body.rescued).toBe(1);
    // Nothing to add means nothing to report.
    expect(mergeRescue(base, []).rescued).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PANEL ROUND 1
//
// The adversarial review of feat/onboarding-probe-round2 found that each of the
// three new rules fixed the paste that motivated it and broke a neighbouring
// paste that used to work. Five must-fixes, one test each, every one of them a
// shape a teacher really pastes. The names are the reviewer's own.
// ---------------------------------------------------------------------------

describe('panel round 1: the five must-fixes', () => {
  it('a paste of sixty thousand digits still answers in under a second', () => {
    // M0. `\d+[ \t]?[年月日号]` backtracks the whole digit run from every start
    // position. One Chinese character at the end makes the string two-byte,
    // V8 loses its Latin1 fast path, and 60,006 bytes (under the 64 KB the
    // worker accepts from an unauthenticated POST) cost 5.4 s of CPU.
    const paste = '9'.repeat(60_000) + '苹果';
    expect(new TextEncoder().encode(paste).length).toBeLessThan(64 * 1024);
    const t0 = performance.now();
    const result = extractVocab(paste, dict);
    const ms = performance.now() - t0;
    expect(result.items.map((i) => i.zh)).toContain('苹果');
    expect(ms, `60,000 digits took ${ms.toFixed(0)} ms`).toBeLessThan(200);
  });

  it('a grade level keeps 年级 when she numbers it', () => {
    // M1. The date strip had no boundary after 年/月/日/号, so any word that
    // BEGINS with one and follows a digit was amputated: 年级 -> 级.
    const grades = extractVocab('1年级 2年级 3年级', dict).items.map((i) => i.zh);
    expect(grades).toContain('年级');
    expect(grades).not.toContain('级');

    const subway = extractVocab('3号线 地铁 100日元', dict).items.map((i) => i.zh);
    expect(subway).toContain('地铁');
    expect(subway).toContain('日元');
    // 线 and 元 are the tails of 号线 and 日元 with the digit-plus-character
    // eaten off the front. Neither is a word she typed.
    expect(subway).not.toContain('线');
    expect(subway).not.toContain('元');
    // 号线 itself is not a CEDICT headword (checked against the real asset), so
    // it produces no card either way. What this pins is that the date rule no
    // longer turns it into one wrong card.
    expect(dict.lookup('号线')).toBeNull();
  });

  it('months written with arabic numerals are still cards', () => {
    // M2. `1月 2月 3月` is how a Chinese teacher types a months lesson, and the
    // date rule returned ZERO items for it. Zero items also trips the paid
    // model rescue in the worker, so a deterministic right answer became a
    // non-deterministic guess.
    const months = extractVocab('1月 2月 3月 4月 5月 6月', dict).items;
    expect(months.length).toBeGreaterThan(0);
    const days = extractVocab('1号 2号 15号 31号', dict).items;
    expect(days.length).toBeGreaterThan(0);
  });

  it('a glossary row 中文/Chinese is a row, not a header', () => {
    // M3. In a two-column glossary the words for word / pinyin / meaning /
    // example are THEMSELVES the vocabulary, so "every field is a title word"
    // is the shape of an ordinary row, not proof of a header.
    const glossary = extractVocab(
      ['词\tword', '拼音\tpinyin', '意思\tmeaning', '例句\texample'].join('\n'),
      dict
    ).items.map((i) => i.zh);
    expect(glossary).toEqual(expect.arrayContaining(['词', '拼音', '意思', '例句']));

    expect(extractVocab('中文\tChinese', dict).items.map((i) => i.zh)).toContain('中文');

    const piped = extractVocab('苹果 | apple\n中文 | Chinese', dict).items.map((i) => i.zh);
    expect(piped).toContain('苹果');
    expect(piped).toContain('中文');
  });

  it('a space separated title row is still a title row', () => {
    // M3, other half (the reviewer's S1): a teacher copying a table out of a
    // PDF or Word gets spaces, not tabs, and that is the shape in the ask.
    const table = extractVocab(
      ['序号 生词 拼音 英文', '1 苹果 píngguǒ apple', '2 香蕉 xiāngjiāo banana'].join('\n'),
      dict
    ).items.map((i) => i.zh);
    expect(table).toContain('苹果');
    expect(table).toContain('香蕉');
    expect(table).not.toContain('序号');
    expect(table).not.toContain('拼音');
    expect(table).not.toContain('英文');
    expect(table).not.toContain('生词');
  });

  it('注意： in front of a notice is still paperwork', () => {
    // M4. 完成 / 注意 / 记得 in front of a colon are markers ("Note:",
    // "Remember:", "Complete:"), not vocabulary. A word before a colon is her
    // word only when she uses it again in the sentence after the colon, or
    // when the paste is a run of `word：sentence` lines.
    expect(extractVocab('注意：明天考试。', dict).items.map((i) => i.zh)).not.toContain('注意');
    expect(extractVocab('完成：作业第三页。', dict).items.map((i) => i.zh)).not.toContain('完成');
    expect(extractVocab('记得：带书和本子。', dict).items.map((i) => i.zh)).not.toContain('记得');
    // ...and the one she really did declare still comes back (fixture 44).
    expect(extractVocab('学习：我每天学习中文。', dict).items.map((i) => i.zh)).toContain('学习');
  });

  it('生词：学习 练习 复习 keeps the three words she listed', () => {
    // Should-fix S2. The declaration only read the run BEFORE the colon, so a
    // paperwork-teachable word LISTED AFTER a marker was still dropped and the
    // whole lesson came back empty.
    const listed = extractVocab('生词：学习 练习 复习', dict).items.map((i) => i.zh);
    expect(listed).toEqual(expect.arrayContaining(['学习', '练习', '复习']));
    expect(listed).not.toContain('生词');
  });
});

// ---------------------------------------------------------------------------
// ROUND 2e
//
// Fixture 48 (`1月 2月 3月 4月 5月 6月 7月 8月 9月 10月 11月 12月`) came out of the
// date rule as a single card, 月: the digit in front of every month was read
// as separator noise and thrown away, so a lesson that plainly teaches twelve
// different months landed the teacher on a table with one row. `1月` written on
// a list is a card in its own right, the way she wrote it, with a reading and
// an English meaning she never has to type.
// ---------------------------------------------------------------------------

describe('round 2e: months and days written with arabic numerals', () => {
  it('each month on a list becomes its own card, written as she typed it', () => {
    const items = extractVocab(
      '1月 2月 3月 4月 5月 6月 7月 8月 9月 10月 11月 12月',
      dict
    ).items;
    const byZh = new Map(items.map((i) => [i.zh, i]));
    expect([...byZh.keys()]).toEqual([
      '1月', '2月', '3月', '4月', '5月', '6月',
      '7月', '8月', '9月', '10月', '11月', '12月',
    ]);
    expect(byZh.get('1月')).toMatchObject({ pinyin: 'yī yuè', en: 'January' });
    expect(byZh.get('9月')).toMatchObject({ pinyin: 'jiǔ yuè', en: 'September' });
    expect(byZh.get('10月')).toMatchObject({ pinyin: 'shí yuè', en: 'October' });
    expect(byZh.get('12月')).toMatchObject({ pinyin: 'shí èr yuè', en: 'December' });
  });

  it('days written 号 or 日 on a list become cards with ordinal glosses', () => {
    const days = extractVocab('1号 2号 15号 31号', dict).items;
    const byZh = new Map(days.map((i) => [i.zh, i]));
    expect(byZh.get('1号')).toMatchObject({ pinyin: 'yī hào', en: 'the 1st' });
    expect(byZh.get('15号')).toMatchObject({ pinyin: 'shí wǔ hào', en: 'the 15th' });
    expect(byZh.get('31号')).toMatchObject({ pinyin: 'sān shí yī hào', en: 'the 31st' });

    const riDays = extractVocab('1日 12日 21日 31日', dict).items;
    const byZhRi = new Map(riDays.map((i) => [i.zh, i]));
    // pinyin-pro applies real tone sandhi: 一 before the 4th tone 日 reads yí,
    // not yī. That is correct Mandarin, not a bug in this fix.
    expect(byZhRi.get('1日')).toMatchObject({ pinyin: 'yí rì', en: 'the 1st' });
    expect(byZhRi.get('12日')).toMatchObject({ pinyin: 'shí èr rì', en: 'the 12th' });
    expect(byZhRi.get('21日')).toMatchObject({ pinyin: 'èr shí yī rì', en: 'the 21st' });
  });

  it('a full date is still a date, not a month card', () => {
    // A two-unit date in calendar order is the date rule's job, not this one's:
    // `9月8日` must still be stripped whole, with or without a year in front.
    expect(
      extractVocab('第三课 2026年9月8日 生词：苹果', dict).items.map((i) => i.zh)
    ).toEqual(['苹果']);
    expect(extractVocab('9月8日 生词：苹果', dict).items.map((i) => i.zh)).toEqual(['苹果']);
  });
});

// ---------------------------------------------------------------------------
// PANEL ROUND 2
//
// Five rules added since round 1 were each validated against the paste that
// motivated them and not against the neighbouring paste they damaged. Every
// case below is a paste `main` handled correctly and this branch broke.
// ---------------------------------------------------------------------------

describe('panel round 2: the five regressions', () => {
  it('a greetings lesson keeps 老师好', () => {
    // F1. The Chinese sign-off had no position gate, so a 老师好 or a 谢谢老师
    // ANYWHERE was deleted. `老师好 你好 谢谢 再见` is the standard first-week
    // greetings lesson and came back holding three of its four words; the bare
    // `谢谢老师` came back EMPTY, which sends the worker to the paid rescue.
    const greetings = extractVocab('老师好 你好 谢谢 再见', dict).items.map((i) => i.zh);
    expect(greetings).toEqual(expect.arrayContaining(['老师', '你好', '谢谢', '再见']));

    const mixed = extractVocab('你好 老师好 谢谢老师 再见', dict).items.map((i) => i.zh);
    expect(mixed).toEqual(expect.arrayContaining(['你好', '老师', '谢谢', '再见']));

    // A bare sign-off is never zero cards.
    const alone = extractVocab('谢谢老师', dict).items.map((i) => i.zh);
    expect(alone).toEqual(['谢谢', '老师']);

    // ...and the WeChat message it was written for still loses it (fixture 54).
    const wechat = extractVocab('请复习这些生词：苹果、香蕉、葡萄 谢谢老师', dict).items.map(
      (i) => i.zh
    );
    expect(wechat).toEqual(expect.arrayContaining(['苹果', '香蕉', '葡萄']));
    expect(wechat).not.toContain('谢谢');
    expect(wechat).not.toContain('老师');
  });

  it('a numbered character lesson keeps 日 and 月', () => {
    // F2. `日月水火木` is the first set of characters a class learns, and
    // numbering it `1日 2月 3水` with no separator is how a teacher types one.
    // The calendar rule read 日 as "the 1st" and 月 as "February" while 水 火 木
    // stayed right, so the game was half wrong and read as random.
    const lesson = extractVocab('1日\n2月\n3水\n4火', dict).items.map((i) => i.zh);
    expect(lesson).toEqual(['日', '月', '水', '火']);

    const oneLine = extractVocab('1日 2月 3水 4火 5木', dict).items.map((i) => i.zh);
    expect(oneLine).toEqual(['日', '月', '水', '火', '木']);

    // ...and a real months lesson is still one card per month (fixture 48).
    const months = extractVocab('1月 2月 3月', dict).items.map((i) => i.zh);
    expect(months).toEqual(['1月', '2月', '3月']);
  });

  it('注意：复习。 is a notice, not a card', () => {
    // F3. `if (marked) listed = true` latched on ANY colon, including one whose
    // marker isHerWord had just rejected as paperwork, so the contents of a
    // notice got the list exemption and led the game.
    expect(extractVocab('注意：复习。', dict).items.map((i) => i.zh)).toEqual([]);
    expect(extractVocab('作业：复习生词。', dict).items.map((i) => i.zh)).toEqual([]);

    const notice = extractVocab('注意：复习。\n生词：苹果 香蕉', dict).items.map((i) => i.zh);
    expect(notice).toEqual(['苹果', '香蕉']);

    // ...and a real list header still opens its list.
    const listed = extractVocab('生词：学习 练习 复习', dict).items.map((i) => i.zh);
    expect(listed).toEqual(expect.arrayContaining(['学习', '练习', '复习']));
  });

  it('词/word over 苹果/apple keeps all three rows', () => {
    // F4. The header rule needed only first-content-line AND content-below, and
    // a mixed glossary satisfies both. Dropping 词 cost TWO cards, not one:
    // 拼音 was promoted to the first row, where parse.ts's own header filter
    // took it as well.
    const glossary = extractVocab(
      ['词\tword', '拼音\tpinyin', '苹果\tapple'].join('\n'),
      dict
    ).items.map((i) => i.zh);
    expect(glossary).toEqual(['词', '拼音', '苹果']);

    // ...and her four-column spreadsheet header is still paperwork (43 and 51).
    const tabbed = extractVocab(
      ['序号\t生词\t拼音\t英文', '1\t苹果\tpíngguǒ\tapple', '2\t香蕉\txiāngjiāo\tbanana'].join('\n'),
      dict
    ).items.map((i) => i.zh);
    expect(tabbed).toEqual(['苹果', '香蕉']);

    const spaced = extractVocab(
      ['序号 生词 拼音 英文', '1 苹果 píngguǒ apple', '2 香蕉 xiāngjiāo banana'].join('\n'),
      dict
    ).items.map((i) => i.zh);
    expect(spaced).toEqual(['苹果', '香蕉']);
  });

  it('1月 with her own English keeps her English', () => {
    // F5. The calendar card was added inside the run loop, before the gloss
    // pass, and Collector.add never overwrites a filled column, so the built
    // "January" beat the teacher's own word. A Spanish-language classroom got
    // an English card it never asked for.
    const enero = extractVocab('1月\tenero', dict).items;
    expect(enero[0]).toMatchObject({ zh: '1月', en: 'enero' });

    const third = extractVocab('3号\tthird day of the month', dict).items;
    expect(third[0]).toMatchObject({ zh: '3号', en: 'third day of the month' });

    // Same root cause reordered the cards: the months jumped the queue.
    const order = extractVocab('苹果 1月 香蕉 2月', dict).items.map((i) => i.zh);
    expect(order).toEqual(['苹果', '1月', '香蕉', '2月']);

    // ...and a month with no English of her own still gets one.
    expect(extractVocab('1月', dict).items[0]).toMatchObject({
      zh: '1月',
      pinyin: 'yī yuè',
      en: 'January',
    });
  });
});

// --- panel round 3 -------------------------------------------------------------
//
// Every paste below was measured live on 2026-09-08 by the round-3 panel against
// the real dictionary, and every one of them is a shape a Chinese teacher types.

describe('panel round 3: the three must-fixes', () => {
  it('a lesson number in the header does not collapse the months under it', () => {
    // R3-1. `calendarCardsFit` scans the WHOLE paste, and `第1课` puts a digit in
    // front of a single CJK character, so the gate read the lesson number as a
    // numbered non-calendar token and switched every month card off. Measured:
    // `第1课：1月 2月 3月` -> `["第","课","月"]`. Three months became one card.
    // `第一课：1月 2月 3月` (Chinese numeral) was fine, so the numeral she happened
    // to type decided whether her lesson worked.
    const colon = extractVocab('第1课：1月 2月 3月', dict).items.map((i) => i.zh);
    expect(colon).toEqual(expect.arrayContaining(['1月', '2月', '3月']));

    const week = extractVocab('第2周 1月 2月', dict).items.map((i) => i.zh);
    expect(week).toEqual(expect.arrayContaining(['1月', '2月']));

    const twoLines = extractVocab('第1课 月份\n1月 2月 3月 4月', dict).items.map((i) => i.zh);
    expect(twoLines).toEqual(expect.arrayContaining(['1月', '2月', '3月', '4月']));

    // A lesson ordinal is paperwork wherever it sits, so it leaves no card
    // behind, and the Arabic and the Chinese numeral now read the same.
    for (const zh of [colon, week, twoLines]) {
      expect(zh).not.toContain('第');
      expect(zh).not.toContain('课');
      expect(zh).not.toContain('周');
    }
    expect(extractVocab('第一课：1月 2月 3月', dict).items.map((i) => i.zh)).toEqual([
      '1月',
      '2月',
      '3月',
    ]);
    expect(extractVocab('第5页 苹果 香蕉', dict).items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
    expect(extractVocab('第一单元 苹果 香蕉', dict).items.map((i) => i.zh)).toEqual([
      '苹果',
      '香蕉',
    ]);

    // The gate itself still does its job: one numbered NON-calendar character
    // still turns the calendar rule off (fixture 55).
    expect(extractVocab('1日 2月 3水 4火', dict).items.map((i) => i.zh)).toEqual([
      '日',
      '月',
      '水',
      '火',
    ]);
  });

  it('a greetings lesson separated by 、 keeps all four words', () => {
    // R3-2. `、` is the standard Chinese LIST separator, and `readsAsMessage`
    // counted it as message punctuation, so the paste read as a WeChat message
    // and its first run was deleted as a sign-off. Measured: both spellings came
    // back holding three of four words, while the space-separated spelling
    // (fixture 56) was fixed. 老师好 is not a CC-CEDICT headword; its card is 老师.
    for (const paste of ['老师好、你好、谢谢、再见', '老师好，你好，谢谢，再见']) {
      expect(extractVocab(paste, dict).items.map((i) => i.zh), paste).toEqual([
        '老师',
        '你好',
        '谢谢',
        '再见',
      ]);
    }

    // A real message still loses its sign-off: a marker with a colon, an
    // ideographic comma list and 请 are all still message signals (fixtures 54
    // and 57).
    const message = extractVocab('这周的生词：苹果、香蕉、葡萄\n谢谢老师', dict).items.map(
      (i) => i.zh
    );
    expect(message).toEqual(['苹果', '香蕉', '葡萄']);
  });
});

describe('panel round 3: the should-fixes', () => {
  it('separated calendar items on one line all stay cards', () => {
    // R3-4. DATE_PART_RE paired a month with a day ACROSS a space, so adding a
    // third item to her list deleted the first two: `1月 5日 9号` -> `["9号"]`,
    // `11月 21日 31号` -> `["31号"]`, `1月 2月 1日 2日` -> `["1月","2日"]`.
    // A month and a day she separated herself are two items, not one date.
    expect(extractVocab('1月 5日 9号', dict).items.map((i) => i.zh)).toEqual([
      '1月',
      '5日',
      '9号',
    ]);
    expect(extractVocab('11月 21日 31号', dict).items.map((i) => i.zh)).toEqual([
      '11月',
      '21日',
      '31号',
    ]);
    expect(extractVocab('1月 2月 1日 2日', dict).items.map((i) => i.zh)).toEqual([
      '1月',
      '2月',
      '1日',
      '2日',
    ]);

    // A date glued into one token is still a date, in every form.
    for (const date of ['5月9日', '2026年9月8日', '9月8号', '2026年9月']) {
      expect(extractVocab(`${date} 苹果 香蕉`, dict).items.map((i) => i.zh), date).toEqual([
        '苹果',
        '香蕉',
      ]);
    }
  });

  it('a two-field row of title words is a glossary row, not a header', () => {
    // R3-5. extract.ts got a three-field floor for exactly this and parse.ts's
    // own first-row filter did not, so the first row of a glossary ABOUT words
    // was eaten: `意思\tmeaning` over `例句\texample` over `苹果\tapple` returned
    // `["例句","苹果"]` and 意思, a word she typed, was never seen again.
    const glossary = extractVocab(
      ['意思\tmeaning', '例句\texample', '苹果\tapple'].join('\n'),
      dict
    ).items.map((i) => i.zh);
    expect(glossary).toEqual(['意思', '例句', '苹果']);

    // A real four-field header row is still a header (fixtures 43 and 51).
    expect(
      extractVocab(
        ['序号\t生词\t拼音\t英文', '1\t苹果\tpíngguǒ\tapple'].join('\n'),
        dict
      ).items.map((i) => i.zh)
    ).toEqual(['苹果']);
  });

  it('a declared list that ends in a full stop is still a list', () => {
    // R3-6. The segmented-pieces path asked `options.prose` (the whole line)
    // where it meant the local `prose` (the line, unless this run was declared),
    // so the list exemption never reached the pieces: `生词：学习练习复习。`
    // returned NOTHING, which sends the worker to the paid model rescue, while
    // the same paste without the full stop returned all three. A teacher who
    // ends her list with a period got a billed guess.
    const stopped = extractVocab('生词：学习练习复习。', dict).items.map((i) => i.zh);
    expect(stopped).toEqual(['学习', '练习', '复习']);
    expect(extractVocab('生词：学习练习复习', dict).items.map((i) => i.zh)).toEqual(stopped);

    // 请复习 is still an instruction, not a card (fixture 54).
    expect(
      extractVocab('请复习这些生词：苹果、香蕉、葡萄', dict).items.map((i) => i.zh)
    ).not.toContain('复习');
  });
});

// --- panel round 4 ------------------------------------------------------------

describe('panel round 4: the three must-fixes', () => {
  it('M1. a 第N unit at the head of a GLOSSARY ROW is her word, not a heading', () => {
    // The prefix rule's `\s*` ate a TAB, so on `第一天<TAB>the first day` the
    // "heading" was her term and the "list after it" was the English gloss:
    // the whole paste came back EMPTY (round-4 panel, measured on 695cd85),
    // which sends the worker to the paid model rescue. TERM-TAB-GLOSS is the
    // Quizlet/Anki export shape this onboarding is built around.
    const days = extractVocab('第一天\tthe first day\n第二天\tthe second day', dict);
    expect(days.items.map((i) => i.zh)).toEqual(['第一天', '第二天']);
    for (const item of days.items) expect(item.en.length).toBeGreaterThan(0);

    // Every unit in CJK_HEADING_UNIT, in the same row shape.
    for (const [term, gloss] of [
      ['第三章', 'chapter three'],
      ['第一节', 'period one'],
      ['第一周', 'week one'],
      ['第一部分', 'part one'],
      ['第一课', 'Lesson One'],
    ] as const) {
      expect(extractVocab(`${term}\t${gloss}`, dict).items.map((i) => i.zh), term).toEqual([term]);
    }

    // A comma-separated gloss is the same row in CSV clothing.
    expect(
      extractVocab('第一天,the first day\n第二天,the second day', dict).items.map((i) => i.zh)
    ).toEqual(['第一天', '第二天']);

    // And the silent version: one such row inside an ordinary glossary.
    expect(
      extractVocab('第一天\tthe first day\n苹果\tapple\n香蕉\tbanana', dict).items.map((i) => i.zh)
    ).toEqual(['第一天', '苹果', '香蕉']);

    // The shapes the rule was written for still lose their heading: a space or
    // a colon and then a LIST on the same line is what makes it paperwork.
    expect(extractVocab('第1课：1月 2月 3月', dict).items.map((i) => i.zh)).toEqual([
      '1月',
      '2月',
      '3月',
    ]);
    expect(extractVocab('第2周 1月 2月', dict).items.map((i) => i.zh)).toEqual(['1月', '2月']);
    expect(extractVocab('第5页 苹果 香蕉', dict).items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
  });

  it('M2. the optional 的 in the prefix rule is not a word she can lose', () => {
    // `(?:的)?` was allowed to float on whitespace, so a grammar-particles
    // lesson kept 的 only if she typed the colon: `第1课 的 了 过` returned
    // `["了","过"]` and `第1课：的 了 过` returned all three.
    expect(extractVocab('第1课 的 了 过', dict).items.map((i) => i.zh)).toEqual(['的', '了', '过']);
    expect(extractVocab('第1课：的 了 过', dict).items.map((i) => i.zh)).toEqual(['的', '了', '过']);
    // 的 GLUED to the unit is still the possessive the docblock cites.
    expect(extractVocab('第一课的生词：苹果 香蕉', dict).items.map((i) => i.zh)).toEqual([
      '苹果',
      '香蕉',
    ]);
  });

  it('M3. a heading unit followed by 60,000 spaces is read in milliseconds', () => {
    // CJK_HEADING_RE had three `\s*` runs in front of a REQUIRED topic that
    // never arrives, so the engine tried every partition of the spaces: this
    // exact line cost 5,653 ms on main, 9,018 ms at 2ebc5e8 and 10,077 ms at
    // 695cd85, on a 60,008-byte paste the worker accepts. The sibling timing
    // test above cannot see it because its string starts with `Unit`, which is
    // not a Chinese heading unit and never enters this pattern.
    const line = '第1课' + ' '.repeat(60000) + 'x';
    const started = performance.now();
    extractVocab(line, dict);
    const ms = performance.now() - started;
    expect(ms, `第1课 + 60,000 spaces took ${ms.toFixed(0)} ms`).toBeLessThan(200);
  });
});

describe('panel round 4: the should-fixes', () => {
  it('R4-5. a 日期： line is a date, not two cards', () => {
    // Dropping `MONTH[ \t]?DAY` from DATE_PART_RE (round 4, and the right call:
    // it is what stopped r3 deleting real months) made a SPACED date into cards,
    // so `日期：9月 8日` over a word list added 日期, 9月 and 8日. A line whose
    // label is 日期 and whose body is nothing but a date is paperwork.
    expect(extractVocab('日期：9月 8日\n生词：苹果 香蕉', dict).items.map((i) => i.zh)).toEqual([
      '苹果',
      '香蕉',
    ]);
    // A 日期 label over something that is NOT a date is NOT a date line, so the
    // line survives and her words come through. 日期 itself still arrives as a
    // card, exactly as it did before this rule: that is the "structural words
    // are not prose stopwords" question the panel left open for JJ, and this
    // fix deliberately does not answer it.
    expect(extractVocab('日期：苹果 香蕉', dict).items.map((i) => i.zh)).toEqual([
      '日期',
      '苹果',
      '香蕉',
    ]);
  });

  it('R4-6. one space inside 第 1课 does not collapse her list', () => {
    // isLessonOrdinalAt walked back over the digits and demanded 第 immediately
    // before, so `第 1课：1月 2月 3月` returned `["第","课","月"]` - the exact
    // r3-MF1 collapse, reopened by one keystroke.
    expect(extractVocab('第 1课：1月 2月 3月', dict).items.map((i) => i.zh)).toEqual([
      '1月',
      '2月',
      '3月',
    ]);
  });

  it('R4-7. a greetings list that ends in a full stop is still a list', () => {
    // readsAsMessage tested for 。！？ANYWHERE in the body, including the last
    // character, so `老师好、你好、谢谢、再见。` lost 老师好 while the same line
    // without the stop kept all four (fixture 60). One keystroke, same lesson
    // as r3-MF2. Her first greeting cards as 老师 because 老师好 is not a
    // CC-CEDICT headword (fixture 56 says the same); the point is that it is
    // THERE at all, because with the stop it was deleted outright.
    const withoutStop = extractVocab('老师好、你好、谢谢、再见', dict).items.map((i) => i.zh);
    expect(withoutStop).toEqual(['老师', '你好', '谢谢', '再见']);
    for (const stop of ['。', '！', '？']) {
      expect(
        extractVocab(`老师好、你好、谢谢、再见${stop}`, dict).items.map((i) => i.zh),
        stop
      ).toEqual(withoutStop);
    }
    // A real message still loses its sign-off: 请 and a marker are untouched.
    expect(
      extractVocab('请复习这些生词：苹果、香蕉、葡萄', dict).items.map((i) => i.zh)
    ).not.toContain('复习');
  });

  it('R4-a. NOT FLIPPED: 谢谢老师 at the end of a comma list stays two cards', () => {
    // Round 2 made 、 and ， message punctuation and lost 老师好; round 3 called
    // that a must-fix; round 4 removed it and gained 谢谢 老师 here. That is two
    // rounds reversing each other on one question, so it is decided on a
    // second-order principle instead of re-argued: a gained junk card is
    // recoverable (she deletes it), a lost word is not (she never sees it
    // again). This sits on the recoverable side and matches main. Round 5 must
    // not flip it back without answering that.
    expect(extractVocab('苹果，香蕉，葡萄，谢谢老师', dict).items.map((i) => i.zh)).toEqual([
      '苹果',
      '香蕉',
      '葡萄',
      '谢谢',
      '老师',
    ]);
  });
});

describe('panel round 5: a space is a gloss separator too', () => {
  it('R5-1. a space-separated 第N glossary is her vocabulary, not a heading', () => {
    // Round 4 stopped a TAB after `第一天` meaning "heading", and round 5 found
    // the same hole one keystroke over. A bare space is the commonest term-gloss
    // separator a teacher types: a two-column Word or PDF table pastes as
    // spaces, and so does anything hand-typed. Measured on 94f907c this paste
    // returned ZERO cards with needsRescue=true, so a glossary that works on
    // main went straight to the paid model.
    const rows = '第一天 the first day\n第二天 the second day\n第三章 chapter three';
    const result = extractVocab(rows, dict);
    expect(result.items.map((i) => i.zh)).toEqual(['第一天', '第二天', '第三章']);
    // Not just the cards: the English she typed beside each one arrives with it.
    expect(result.items.map((i) => i.en)).toEqual([
      'the first day',
      'the second day',
      'chapter three',
    ]);
    // Nothing here is empty enough to reach the rescue.
    expect(needsRescue(result, rows)).toBe(false);

    // Six rows of the same shape, the lesson-glossary form of it.
    const lesson = [1, 2, 3, 4, 5, 6]
      .map((n) => `第${'一二三四五六'[n - 1]}课 lesson ${n}`)
      .join('\n');
    expect(extractVocab(lesson, dict).items).toHaveLength(6);

    // And every other way she can space that column.
    for (const row of [
      '第一天  the first day', // two spaces
      '第一天　the first day', // ideographic space
      '第一天 di4 yi1 tian1 the first day', // a pinyin column between them
      '第一天 - the first day', // a dash between them
    ]) {
      expect(
        extractVocab(`${row}\n${row.replace('第一天', '第二天')}`, dict).items.map((i) => i.zh),
        row
      ).toEqual(['第一天', '第二天']);
    }
  });

  it('R5-2. one 第N row inside an ordinary list is not deleted in silence', () => {
    // The worse half. Empty at least fires needsRescue; mixed into a fruit list
    // the row just vanishes with needsRescue=false and nothing tells her.
    // 94f907c: 2 cards on the first paste and 3 on the second. Main: 4 on both.
    expect(
      extractVocab(
        '苹果 apple\n第一天 the first day\n香蕉 banana\n第三章 chapter three',
        dict
      ).items.map((i) => i.zh)
    ).toEqual(['苹果', '第一天', '香蕉', '第三章']);
    expect(
      extractVocab(
        '苹果 apple\n香蕉 banana\n橘子 orange\n第一天 the first day',
        dict
      ).items.map((i) => i.zh)
    ).toEqual(['苹果', '香蕉', '橘子', '第一天']);
  });

  it('R5-3. what follows the space is what decides it: a Chinese list is still a heading', () => {
    // Every round-3 and round-4 win, re-asserted here because the fix that
    // makes R5-1 pass is exactly the one that could undo them.
    const cases: Array<[string, string[]]> = [
      ['第1课：1月 2月 3月', ['1月', '2月', '3月']],
      ['第 1课：1月 2月 3月', ['1月', '2月', '3月']],
      ['第1课 苹果 香蕉', ['苹果', '香蕉']],
      ['第一课 你好 谢谢', ['你好', '谢谢']],
      ['第2周 1月 2月', ['1月', '2月']],
      ['第1课 的 了 过', ['的', '了', '过']],
      ['第1课：的 了 过', ['的', '了', '过']],
      ['第一课的生词：苹果 香蕉', ['苹果', '香蕉']],
    ];
    for (const [paste, want] of cases) {
      expect(
        extractVocab(paste, dict).items.map((i) => i.zh),
        paste
      ).toEqual(want);
    }
    // The tab, comma and pipe glossaries round 4 fixed are untouched.
    expect(
      extractVocab('第一天\tthe first day\n第二天\tthe second day', dict).items.map((i) => i.zh)
    ).toEqual(['第一天', '第二天']);
    expect(
      extractVocab('第一天,the first day\n第二天,the second day', dict).items.map((i) => i.zh)
    ).toEqual(['第一天', '第二天']);
    expect(
      extractVocab('第一天|the first day\n第二天|the second day', dict).items.map((i) => i.zh)
    ).toEqual(['第一天', '第二天']);
  });

  it('R5-4. the space fix is a linear scan, not a lookahead', () => {
    // THE TRAP THIS ROUND MEASURED. The obvious fix is to ask the question
    // inside the regex: `[ 　]+(?=[^\n]*[一-鿿])`. That reopens the
    // ReDoS round 4 closed, because the lookahead rescans the tail from every
    // position the space run can end at: the line below went from ~8 ms to
    // 7,771 ms on the panel's machine. It is asked caller-side instead, where
    // the cost is one pass over a string we already built.
    const line = '第1课' + ' '.repeat(60000) + 'x';
    const started = performance.now();
    extractVocab(line, dict);
    const ms = performance.now() - started;
    expect(ms, `第1课 + 60,000 spaces took ${ms.toFixed(0)} ms`).toBeLessThan(200);

    // The same run with Chinese after it, which is the branch that now has to
    // answer the "is a list following?" question.
    const heading = '第1课' + ' '.repeat(60000) + '生词';
    const t2 = performance.now();
    extractVocab(heading, dict);
    const ms2 = performance.now() - t2;
    expect(ms2, `第1课 + 60,000 spaces + 生词 took ${ms2.toFixed(0)} ms`).toBeLessThan(200);
  });

  it('R5-5. zero cards is never the PAPERWORK rule doing either', () => {
    // extractVocab already re-read the paste when DATE_PART_RE emptied it. The
    // date LINE rule empties pastes through stripHeaders instead, so it slipped
    // past that net entirely: `日期：一月 二月 三月` gave 4 cards on main and 0
    // on 94f907c, into the paid rescue. The retry now covers the whole strip,
    // which is the general guard for this family rather than a point fix.
    expect(extractVocab('日期：一月 二月 三月', dict).items.length).toBeGreaterThanOrEqual(3);
    expect(extractVocab('日期：星期一 星期二 星期三', dict).items.length).toBeGreaterThanOrEqual(3);

    // A paste that is NOTHING but paperwork stays empty. Re-reading it would
    // only manufacture the phantom the strip exists to prevent, and an empty
    // answer here never reaches the rescue anyway (too little Chinese to ask
    // about). All three are [] on main too.
    expect(extractVocab('第一课', dict).items).toEqual([]);
    expect(extractVocab('Name: ____\nDate: ____\nClass: ____', dict).items).toEqual([]);
    // 第一天 MOVED SIDES IN ROUND 9, deliberately. Round 5 listed it here with
    // 第一课 because both were "nothing but paperwork", and noted in the same
    // breath that an empty answer for it never reaches the rescue anyway, so
    // nothing was riding on the line. F2 says the UNIT decides: 课 names part of
    // a document, 天 is something the class counts, and fixture 71 wants
    // `第一天 第二天 第三天` to be three cards. One day cannot be paperwork while
    // three days are vocabulary, so the single marker moves with them.
    expect(extractVocab('第一天', dict).items.map((i) => [i.zh, i.en])).toEqual([
      ['第一天', 'day 1'],
    ]);

    // AND THE RETRY FILTERS WHAT IT FINDS. Round 6 closed the hole this test
    // used to pin open: above the CJK threshold the re-read did reach paperwork
    // and manufactured cards out of it, so the retry now drops any ordinal
    // fragment or paperwork marker from its own result, and stands down to the
    // empty answer when nothing real is left. 日期 is the label she wrote over
    // her list, never one of the words on it.
    expect(extractVocab('日期：一月 二月 三月', dict).items.map((i) => i.zh)).toEqual([
      '一月',
      '二月',
      '三月',
    ]);

    // And the round-4 date fixes still hold: the paperwork still comes off when
    // taking it off leaves something behind.
    expect(extractVocab('日期：9月 8日\n生词：苹果 香蕉', dict).items.map((i) => i.zh)).toEqual([
      '苹果',
      '香蕉',
    ]);
  });
});

// PANEL ROUND 6. Both findings are the same shape: a paste with no vocabulary
// on it came back holding cards. A phantom is worse than an empty answer,
// because an empty answer is something the teacher can see and fix while a game
// whose cards are 第 / 课 / 日期 looks like it worked. Both are red on a67b4c7
// and both are red on main; this round is not a regression fix, it is the first
// time either was decided.
describe('panel round 6: no paste without vocabulary produces a card', () => {
  it('R6-1. a lesson marker never shatters into 第 and 课', () => {
    // The finding round 6 raised: `第1课 Lesson one` read as a glossed pair and
    // 第1课 shattered into the Chinese runs 第 and 课 (measured a67b4c7 AND
    // main). Round 7 answered it by throwing the rows away; round 7c answers it
    // by keeping the term whole, because the rows she glossed are hers. Fixture
    // 66. The finding itself is unchanged and still red on both those trees:
    // whatever else happens, 第 and 课 are not cards.
    const index = extractVocab('第1课 Lesson one\n第2课 Lesson two', dict);
    expect(index.items.map((i) => i.zh)).toEqual(['第1课', '第2课']);
    expect(index.items.map((i) => i.en)).toEqual(['Lesson one', 'Lesson two']);

    // A run of markers with NO gloss anywhere is the shape that really holds no
    // vocabulary, and it is still answered with nothing. Fixture 68.
    const bare = extractVocab('第1课 第2课', dict);
    expect(bare.items).toEqual([]);
    expect(bare.paperworkOnly).toBe(true);

    // And fixture 64 in one line, which must not move whatever else does.
    expect(
      extractVocab(
        '第一天 the first day\n第二天 the second day\n第三章 chapter three',
        dict
      ).items.map((i) => i.zh)
    ).toEqual(['第一天', '第二天', '第三章']);
  });

  it('R6-2. the zero-card retry never manufactures an ordinal or a marker', () => {
    // Four heading lines clear the CJK threshold, so the retry re-read them
    // with the paperwork strip off and produced 第一 / 第二 as cards (main:
    // ["第一","第二"]; a67b4c7: ["第二"]). Nothing real is left after the
    // filter, so the empty answer stands and the rescue path is as on main.
    expect(extractVocab('第一课 第二课 第三课 第四课', dict).items).toEqual([]);

    // The label she wrote over her list is not one of the words on it. The
    // words are, all four of them, in both spellings she might use.
    expect(extractVocab('日期：一 二 三 四', dict).items.map((i) => i.zh)).toEqual([
      '一',
      '二',
      '三',
      '四',
    ]);
    expect(extractVocab('日期：年 月 日 号', dict).items.map((i) => i.zh)).toEqual([
      '年',
      '月',
      '日',
      '号',
    ]);
    // The round-5 win the retry exists for, kept: this paste is 0 cards and a
    // paid rescue without the retry.
    expect(extractVocab('日期：一月 二月 三月', dict).items.map((i) => i.zh)).toEqual([
      '一月',
      '二月',
      '三月',
    ]);
  });
});

// --- the deliberate empty answer ---------------------------------------------
//
// Zero cards has two completely different meanings and the worker cannot tell
// them apart from the item count alone.
//
//   "I could not read this"   a run of characters the dictionary does not cut.
//                             Worth a model call: RESCUE_BELOW_ITEMS fires.
//   "There is nothing here"   `第1课 Lesson one`, a bilingual lesson index. The
//                             paperwork filter in extractVocab looked at the
//                             un-stripped re-read, found 第 / 课 / 第1 and
//                             nothing else, and threw all of it away ON PURPOSE
//                             (round 7). Paying a model to guess at that buys a
//                             phantom, and the teacher lands on a game whose
//                             cards are the chapter numbers.
//
// `paperworkOnly` is the second case saying so out loud. It changes no card.

describe('a deliberate empty answer is not a failed read', () => {
  // Fixture 68, not 66: round 7c moved the lesson index to the other side of
  // this line, because she glossed those rows herself. What is left here is the
  // paste that really holds nothing, a run of markers with no gloss anywhere.
  const markerRunText = readFileSync(join(FIXTURES, '68-bare-lesson-marker-run.txt'), 'utf8');

  it('flags the paste whose only content was paperwork', () => {
    const markerRun = extractVocab(markerRunText, dict);
    expect(markerRun.items).toEqual([]);
    expect(markerRun.paperworkOnly).toBe(true);
  });

  it('does not flag the rows she glossed herself, however she numbered them', () => {
    const glossed = extractVocab('第1课 Lesson one\n第2课 Lesson two', dict);
    expect(glossed.items.map((i) => i.zh)).toEqual(['第1课', '第2课']);
    expect(glossed.paperworkOnly).toBeFalsy();
  });

  it('does not flag a run the dictionary read fine', () => {
    const runOn = extractVocab('你好谢谢再见什么为什么还有', dict);
    expect(runOn.items.length).toBeGreaterThan(0);
    expect(runOn.paperworkOnly).toBeFalsy();
  });

  it('does not flag a paste with no Chinese in it at all', () => {
    const latin = extractVocab('lorem ipsum dolor sit amet', dict);
    expect(latin.paperworkOnly).toBeFalsy();
  });

  it('does not flag a genuine failed read, which is what the rescue is for', () => {
    const unreadable = extractVocab('㐀㐁㐂㐃', dict);
    expect(unreadable.items).toEqual([]);
    expect(unreadable.paperworkOnly).toBeFalsy();
  });

  it('keeps a paperwork-only paste away from the paid model', async () => {
    clearRescueCache();
    let calls = 0;
    const env = {
      AI: {
        run: async () => {
          calls++;
          return '["苹果"]';
        },
      },
    } as unknown as ExtractEnv;

    // The route's own sequence (src/worker/index.ts handleExtract): read, ask
    // whether to rescue, and only then spend.
    const runRoute = async (text: string) => {
      const result = extractVocab(text, dict);
      if (!needsRescue(result, text)) return { result, rescued: [] as string[] };
      const rescue = await rescueWithModel(env, text, dict, 2);
      return { result, rescued: rescue.items.map((i) => i.zh) };
    };

    const paperwork = await runRoute(markerRunText);
    expect(paperwork.result.items).toEqual([]);
    expect(paperwork.rescued).toEqual([]);
    expect(calls).toBe(0);

    // And the case the rescue exists for still costs exactly one call: a paste
    // with real Chinese in it that the dictionary could not cut.
    const failed = await runRoute('苹果㐀㐁㐂');
    expect(failed.rescued).toEqual(['苹果']);
    expect(calls).toBe(1);
  });

  it('tells the client the empty answer was deliberate', () => {
    const deliberate = toResponse(extractVocab(markerRunText, dict));
    expect(deliberate.items).toEqual([]);
    expect(deliberate.paperworkOnly).toBe(true);
    // Every other reply is unchanged, the ordinary empty one included: the flag
    // is absent rather than false, so nothing already on the wire moves.
    expect(toResponse(extractVocab('㐀㐁㐂㐃', dict)).paperworkOnly).toBeUndefined();
    expect(toResponse(extractVocab('苹果，香蕉', dict)).paperworkOnly).toBeUndefined();
  });

  it('is carried through the client reader, so the local parser stands down', () => {
    // Without this the client falls back to parseVocab on any empty answer, and
    // parseVocab reads a bare marker run as words: four phantom cards for a
    // paste with no vocabulary on it (the round 7b break, measured on 54c9d1b
    // through the live harness with the lesson index, the same mechanism).
    expect(parseVocab(markerRunText).items.map((i) => i.zh)).toEqual([
      '第1课 第2课',
      '第3课 第4课',
    ]);
    const read = readExtractBody({ items: [], skipped: [], mode: 'free', paperworkOnly: true });
    expect(read?.paperworkOnly).toBe(true);
    // An old worker, or any other reply, never claims it.
    expect(readExtractBody({ items: [], skipped: [], mode: 'free' })?.paperworkOnly).toBe(false);
    expect(readExtractBody({ items: [], paperworkOnly: 'yes' })?.paperworkOnly).toBe(false);
  });
});

// ROUND 7C. WHAT SHE TYPED AS A PAIR STAYS A PAIR.
//
// Round 6 shipped "no Chinese after the space means her word". Round 7 reversed
// it to "an Arabic numeral means heading". Two consecutive rounds reversing each
// other on the same question means the question is not decidable from the
// evidence, so it is decided on a second-order principle instead, and written
// down here so a round 8 cannot flip it back by accident.
//
// RECOVERABILITY DECIDES. Deleting an unwanted card on the edit table is one
// click. Retyping a card the reader threw away costs the teacher the typing she
// already did, and an empty answer that buys a paid rescue is worse than both:
// it spends quota and still lands her nowhere. So a marker she wrote a GLOSS
// beside is her card, whichever numeral she used, and the marker never shatters
// into 第 + 课.
//
// The paperwork case is the one with no gloss at all: a bare run of markers and
// nothing else. That is an index, it holds no vocabulary, and the honest answer
// is no cards, said out loud with `paperworkOnly` so nobody pays for it.
describe('round 7c: what she typed as a pair stays a pair', () => {
  const zhOf = (r: { items: { zh: string }[] }) => r.items.map((i) => i.zh);
  const glossOf = (r: { items: { zh: string; en: string }[] }, term: string) =>
    r.items.find((i) => i.zh === term)?.en;

  // (a) A 第N marker with a gloss beside it is a card, Arabic numeral or not.
  it('keeps five Arabic-numeral day rows as five glossed cards', () => {
    const r = extractVocab(
      [
        '第1天 the first day',
        '第2天 the second day',
        '第3天 the third day',
        '第4天 the fourth day',
        '第5天 the fifth day',
      ].join('\n'),
      dict
    );
    expect(zhOf(r)).toEqual(['第1天', '第2天', '第3天', '第4天', '第5天']);
    expect(glossOf(r, '第1天')).toBe('the first day');
    expect(r.paperworkOnly).toBeFalsy();
  });

  it('keeps an English-titled lesson index as its own two cards', () => {
    const r = extractVocab('第1课 Lesson one\n第2课 Lesson two', dict);
    expect(zhOf(r)).toEqual(['第1课', '第2课']);
    expect(glossOf(r, '第1课')).toBe('Lesson one');
    expect(glossOf(r, '第2课')).toBe('Lesson two');
  });

  it('never shatters a marker into 第 and its unit', () => {
    for (const text of ['第1课 Lesson one\n第2课 Lesson two', '第1天 the first day']) {
      const got = zhOf(extractVocab(text, dict));
      expect(got).not.toContain('第');
      expect(got).not.toContain('课');
      expect(got).not.toContain('天');
    }
  });

  it('leaves the Chinese-numeral glossary exactly as round 5 fixed it', () => {
    const r = extractVocab(
      '第一天 the first day\n第二天 the second day\n第三天 the third day',
      dict
    );
    expect(zhOf(r)).toEqual(['第一天', '第二天', '第三天']);
  });

  // (b) A bare run of markers with no gloss is paperwork, and says so.
  it('reads a bare run of markers as paperwork and never pays for it', () => {
    for (const text of ['第1课 第2课', '第一课 第二课 第三课 第四课', '第1课']) {
      const r = extractVocab(text, dict);
      expect(r.items).toEqual([]);
      expect(r.paperworkOnly).toBe(true);
    }
  });

  // (c) A marker over a LIST is still a heading. Rounds 4 to 7 stay won.
  it('still strips a marker that stands over her list', () => {
    expect(zhOf(extractVocab('第1课：1月 2月 3月', dict))).toEqual(['1月', '2月', '3月']);
    expect(zhOf(extractVocab('第1课 苹果 香蕉', dict))).toEqual(['苹果', '香蕉']);
    expect(zhOf(extractVocab('第一课 你好 谢谢', dict))).toEqual(['你好', '谢谢']);
  });

  // (d) One surviving glossed row keeps its own gloss, whole.
  it('does not re-segment a lone surviving row into a mis-glossed card', () => {
    const r = extractVocab('第1课 Lesson one\n第2课 Lesson two\n第一天 the first day', dict);
    expect(zhOf(r)).toContain('第一天');
    expect(zhOf(r)).not.toContain('第一');
    expect(glossOf(r, '第一天')).toBe('the first day');
  });
});

// PANEL ROUND 9. Two findings, both measured by Codex against the real
// public/cedict.json on 44d2a41.
//
// F1: round 7c kept the whole marker together in the STRUCTURED path only, so
// a paste that mixes one glossed marker with a bare one and a plain word list
// falls to the free path, where splitRuns cuts `第1课` at the digit and the
// dictionary answers the two halves. Measured: `第1课 Lesson one\n第2课\n苹果 香蕉`
// returned 第/but, 课/subject, 苹果, 香蕉 - two phantoms whose English does not
// mean their Chinese, and her one real glossed row gone.
//
// F2: isMarkerRunOnly called every bare 第N run paperwork, whatever the unit.
// `第1天 第2天` and `第一天 第二天` are ordinary day vocabulary a teacher types,
// and they came back with no cards AND paperworkOnly, which also tells the
// worker not to rescue them. Fixture 64 and fixture 69 are the same words with
// a gloss beside them; the gloss she happened to type was the only thing
// separating a card from an empty screen.
describe('panel round 9: the marker is one token on every path', () => {
  const zhOf = (r: { items: { zh: string }[] }) => r.items.map((i) => i.zh);
  const enOf = (r: { items: { en: string }[] }) => r.items.map((i) => i.en);
  const pyOf = (r: { items: { pinyin: string }[] }) => r.items.map((i) => i.pinyin);

  it('F1. a mixed paste never shatters the marker into 第 and 课', () => {
    // Fixture 70. The bare 第2课 is a heading line and drops; the glossed
    // 第1课 is her card; the word list is her list.
    const r = extractVocab('第1课 Lesson one\n第2课\n苹果 香蕉', dict);
    expect(zhOf(r)).toEqual(['第1课', '苹果', '香蕉']);
    expect(r.items.find((i) => i.zh === '第1课')?.en).toBe('Lesson one');
  });

  it('F1. two glossed markers on ONE line are two cards', () => {
    const r = extractVocab('第1课 Lesson one 第2课 Lesson two', dict);
    expect(zhOf(r)).toEqual(['第1课', '第2课']);
    expect(enOf(r)).toEqual(['Lesson one', 'Lesson two']);
  });

  it('F1. a bare marker run above her list leaves only her list', () => {
    const r = extractVocab('第1课 第2课\n你好 hello\n谢谢 thanks', dict);
    expect(zhOf(r)).toEqual(['你好', '谢谢']);
  });

  it('F2. a bare run of DAY markers is vocabulary, with a built gloss', () => {
    // Fixture 71 in its digit spelling. `day N` is the gloss style: one noun
    // per unit plus the number, so it reads the same for 第10天 as for 第1天
    // and needs no English ordinal table.
    const digits = extractVocab('第1天 第2天', dict);
    expect(digits.paperworkOnly).toBeUndefined();
    expect(zhOf(digits)).toEqual(['第1天', '第2天']);
    expect(enOf(digits)).toEqual(['day 1', 'day 2']);
    expect(pyOf(digits)).toEqual(['dì yī tiān', 'dì èr tiān']);

    // The Chinese numerals convert through the SAME static digit table the
    // months use, so the two spellings of one handout give one answer.
    const words = extractVocab('第一天 第二天', dict);
    expect(zhOf(words)).toEqual(['第一天', '第二天']);
    expect(enOf(words)).toEqual(['day 1', 'day 2']);
    expect(pyOf(words)).toEqual(['dì yī tiān', 'dì èr tiān']);
  });

  it('F2. the other vocabulary units carry their own noun', () => {
    expect(enOf(extractVocab('第1周 第2周', dict))).toEqual(['week 1', 'week 2']);
    expect(enOf(extractVocab('第一次 第二次', dict))).toEqual(['time 1', 'time 2']);
    expect(enOf(extractVocab('第1名 第2名', dict))).toEqual(['place 1', 'place 2']);
    expect(enOf(extractVocab('第1年 第2年', dict))).toEqual(['year 1', 'year 2']);
    expect(enOf(extractVocab('第1月 第2月', dict))).toEqual(['month 1', 'month 2']);
    expect(enOf(extractVocab('第1个 第2个', dict))).toEqual(['item 1', 'item 2']);
    expect(pyOf(extractVocab('第1周 第2周', dict))).toEqual(['dì yī zhōu', 'dì èr zhōu']);
  });

  it('F2. document-structure units are still paperwork, and still say so', () => {
    for (const text of [
      '第1课 第2课',
      '第一页 第二页',
      '第1章 第2章',
      '第1节',
      '第1单元',
      '第1部分',
    ]) {
      const r = extractVocab(text, dict);
      expect(r.items, `${text} should hold no vocabulary`).toEqual([]);
      expect(r.paperworkOnly, `${text} should be labelled paperwork`).toBe(true);
    }
  });

  it('F2. a vocabulary marker over a LIST is still a heading', () => {
    // The unit split decides PAPERWORK vs VOCABULARY for a bare run only. It
    // must not move the heading rule rounds 4 to 7 settled.
    expect(zhOf(extractVocab('第2周 1月 2月', dict))).toEqual(['1月', '2月']);
    expect(zhOf(extractVocab('第1天 苹果 香蕉', dict))).toEqual(['苹果', '香蕉']);
  });
});

// ROUND 9b. The lesson column, end to end, and the rescue it must not buy.
//
// Fixtures 72 and 73 cover the cards. These cover the two things a fixture
// cannot say: the exact wrong answer key that used to come out, and whether
// the paste spends one of her thirty daily model calls.
describe('round 9b: a lesson-number column and the marker run beside a word', () => {
  it('answers the Excel three-column handout with her words, never the lesson numbers', () => {
    const text =
      '第1课\t苹果\tapple\n第2课\t香蕉\tbanana\n第3课\t老师\tteacher\n' +
      '第4课\t学生\tstudent\n第5课\t你好\thello';
    const result = extractVocab(text, dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '苹果=apple',
      '香蕉=banana',
      '老师=teacher',
      '学生=student',
      '你好=hello',
    ]);
    expect(needsRescue(result, text)).toBe(false);
    expect(result.paperworkOnly).toBeFalsy();
  });

  it('answers the same handout under a Chinese title row', () => {
    const result = extractVocab('课\t生词\t英文\n第1课\t苹果\tapple\n第2课\t香蕉\tbanana', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual(['苹果=apple', '香蕉=banana']);
  });

  it('keeps her pinyin column on the four-column spelling', () => {
    const result = extractVocab('第1课\t苹果\tpíng guǒ\tapple\n第2课\t香蕉\txiāng jiāo\tbanana', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual(['苹果=apple', '香蕉=banana']);
  });

  it('does NOT reopen round 7c: a marker with a Latin gloss is still her card', () => {
    const result = extractVocab('第1课\tLesson one\n第2课\tLesson two\n第3课\tLesson three', dict);
    expect(result.items.map((i) => i.zh)).toEqual(['第1课', '第2课', '第3课']);
  });

  it('reads 第1课 第2课 苹果 as the one word, with no paperwork verdict and no rescue', () => {
    const text = '第1课 第2课 苹果';
    const result = extractVocab(text, dict);
    expect(result.items.map((i) => i.zh)).toEqual(['苹果']);
    expect(result.paperworkOnly).toBeFalsy();
    // The six Chinese characters in the two lesson numbers used to clear
    // RESCUE_MIN_CJK on their own and buy a model call. r8 SF-B.
    expect(needsRescue(result, text)).toBe(false);
  });

  it('still buys the rescue when the markers are countable units', () => {
    // 第1天 can be the word she meant, so its characters still count.
    const text = '第1天 第2天 苹果';
    const result = extractVocab(text, dict);
    expect(needsRescue(result, text)).toBe(true);
  });

  it('still buys the rescue for a real paste the reader could not cut', () => {
    const text = '我们今天学习了很多新的东西。';
    const result = extractVocab(text, null);
    expect(needsRescue(result, text)).toBe(true);
  });
});

// ROUND 11. The five the round-10 panel found, in the order they cost a
// teacher something: a 64 KB paste that holds a request for twelve seconds,
// two shapes where her own typing was thrown away, and the Chinese numerals
// above twenty that a syllabus counts weeks with.
describe('round 11: the marker run at scale, and her gloss winning', () => {
  it('reads a 64 KB run of repeated lesson markers plus one word in well under a second', () => {
    // M1. The prefix loop stripped ONE marker per pass and re-scanned the whole
    // remaining tail on each pass, so 16,384 markers cost 16,384 scans of a
    // 64 KB string: 11.8 s measured by the round-10 panel. The answer itself
    // was always right; the price was availability.
    const line = '第1课 '.repeat(16384) + '苹果';
    const started = performance.now();
    const result = extractVocab(line, dict);
    const ms = performance.now() - started;
    expect(result.items.map((i) => i.zh)).toEqual(['苹果']);
    expect(ms, `16,384 lesson markers + 苹果 took ${ms.toFixed(0)} ms`).toBeLessThan(200);
  });

  it('reads the same run of countable-unit markers just as fast', () => {
    const line = '第1天 '.repeat(16384) + '苹果';
    const started = performance.now();
    const result = extractVocab(line, dict);
    const ms = performance.now() - started;
    expect(result.items.length).toBeGreaterThan(0);
    expect(ms, `16,384 day markers + 苹果 took ${ms.toFixed(0)} ms`).toBeLessThan(200);
  });

  it('reads a 64 KB line that alternates markers and words just as fast', () => {
    const line = '第1课 苹果 '.repeat(8192);
    const started = performance.now();
    const result = extractVocab(line, dict);
    const ms = performance.now() - started;
    expect(result.items.map((i) => i.zh)).toContain('苹果');
    expect(ms, `8,192 marker/word pairs took ${ms.toFixed(0)} ms`).toBeLessThan(200);
  });

  it('keeps her typed gloss when the marker and the gloss are on ALTERNATING LINES', () => {
    // M2. The Quizlet alternating-lines shape (fixture 09) with a lesson
    // number as the term. readBareMarkerLines took the marker-only lines off
    // the paste as paperwork before the pairing could ever see them, and all
    // four lines were thrown away: items: [].
    const result = extractVocab('第1课\nLesson one\n第2课\nLesson two', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第1课=Lesson one',
      '第2课=Lesson two',
    ]);
    expect(result.paperworkOnly).toBeFalsy();
  });

  it("prefers the teacher's own gloss over the built `day N` one", () => {
    // M3. `day 1` is only ever offered where she wrote no gloss at all.
    const result = extractVocab('第1天\nthe first day\n第2天\nthe second day', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第1天=the first day',
      '第2天=the second day',
    ]);
  });

  it('still builds `day N` for a bare marker with no gloss anywhere', () => {
    const result = extractVocab('第1天 第2天', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual(['第1天=day 1', '第2天=day 2']);
  });

  it('still reads a marker over the list it names as a heading', () => {
    const result = extractVocab('第1课\n苹果 香蕉', dict);
    expect(result.items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
  });

  it('reads Chinese numerals above twenty', () => {
    // SF-a. A syllabus counts weeks past twenty; `二十一` and `三十一` were
    // rejected outright and the whole paste came back as paperwork.
    const result = extractVocab('第二十一天 第二十二天', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第二十一天=day 21',
      '第二十二天=day 22',
    ]);
    expect(result.items[0].pinyin).toBe('dì èr shí yī tiān');
    expect(result.paperworkOnly).toBeFalsy();
  });

  it('reads 第三十一天, the longest day a month has', () => {
    const result = extractVocab('第三十一天', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual(['第三十一天=day 31']);
    expect(result.items[0].pinyin).toBe('dì sān shí yī tiān');
  });

  it('reads 两 as liǎng, which is how the character she typed is said', () => {
    const result = extractVocab('第两天 第两周', dict);
    expect(result.items.map((i) => i.pinyin)).toEqual(['dì liǎng tiān', 'dì liǎng zhōu']);
    expect(result.items.map((i) => i.en)).toEqual(['day 2', 'week 2']);
  });

  it('still reads the digit spelling of the same numbers', () => {
    const result = extractVocab('第21天 第31天', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual(['第21天=day 21', '第31天=day 31']);
    expect(result.items[0].pinyin).toBe('dì èr shí yī tiān');
  });
});

// ROUND 11b, MUST-FIX 2. An ordinal-VOCABULARY marker whose number the table
// could not read was filed as paperwork, which is the one label that must never
// be wrong: it refuses the paid rescue as well as returning no cards. Main gave
// two junk cards for `第100天 第101天 第102天` but left the rescue available;
// this branch answered `paperworkOnly: true` and closed it.
//
// The number table now runs to 999, so the 100-day challenge list is simply
// read. What is left over the cap is the point of the second half: an ordinal
// marker the table still cannot read is an ORDINARY TOKEN, never paperwork.
describe('round 11b: an ordinal marker whose number is out of the table', () => {
  it('reads the digit hundreds a 100-day challenge list is numbered with', () => {
    const result = extractVocab('第100天 第101天 第102天', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第100天=day 100',
      '第101天=day 101',
      '第102天=day 102',
    ]);
    expect(result.items[0].pinyin).toBe('dì yī bǎi tiān');
    expect(result.items[1].pinyin).toBe('dì yī bǎi líng yī tiān');
    expect(result.paperworkOnly).toBeFalsy();
  });

  it('reads the Chinese-numeral spelling of the same hundreds', () => {
    const result = extractVocab('第一百天 第一百零一天 第一百二十三天 第九百九十九天', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第一百天=day 100',
      '第一百零一天=day 101',
      '第一百二十三天=day 123',
      '第九百九十九天=day 999',
    ]);
    expect(result.items[0].pinyin).toBe('dì yī bǎi tiān');
  });

  it('never labels an unreadable countable marker paperwork, so the rescue stays open', () => {
    // 1000 is one over the cap, in both spellings.
    for (const text of ['第一千天', '第1000天 第2000天']) {
      const result = extractVocab(text, dict);
      expect(result.paperworkOnly, `${text} is her list, not a contents page`).toBeFalsy();
    }
  });

  it('keeps an unreadable marker as typed when she glossed it herself', () => {
    const result = extractVocab('第1000天\tthe thousandth day', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual(['第1000天=the thousandth day']);
  });

  it('still labels a lesson index paperwork, and now says which lines it dropped', () => {
    const result = extractVocab('第１２３课', dict);
    expect(result.paperworkOnly).toBe(true);
    expect(result.skipped, 'the could-not-read screen must name what it dropped').toEqual([
      '第123课',
    ]);
  });

  it('does not change what a non-numeric marker does: 第abc课 is an ordinary token', () => {
    const result = extractVocab('第abc课', dict);
    expect(result.paperworkOnly).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Round 13. Three findings from the round-12 panel: the merged Week cell, the
// next-line pairing swallowing English paperwork, and the colloquial hundreds.
// ---------------------------------------------------------------------------

describe('a merged Week cell, the label typed once', () => {
  it('keeps the word on the labelled row instead of pairing the label with its gloss', () => {
    const result = extractVocab('第1周\t苹果\tapple\n\t香蕉\tbanana\n\t老师\tteacher', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '苹果=apple',
      '香蕉=banana',
      '老师=teacher',
    ]);
  });

  it('does the same with a countable day column and a header row on top', () => {
    const result = extractVocab('周\t生词\t英文\n第1天\t苹果\tapple\n\t香蕉\tbanana', dict);
    expect(result.items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
  });

  it('still keeps a lone marker row as her word, because one row cannot tell them apart', () => {
    const result = extractVocab('第1周\t苹果\tapple', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual(['第1周=apple']);
  });

  it('does not fire when the markers sit at different field indices', () => {
    const result = extractVocab('第1周\t苹果\tapple\n香蕉\t第2周\tbanana', dict);
    expect(result.items.map((i) => i.zh)).toContain('第1周');
  });
});

// ---------------------------------------------------------------------------
// Round 15. The round-13 merged-cell rule read one signal too loosely and stole
// a real word. 第一次 IS a CC-CEDICT headword ("the first time"); 第1周 is not.
// A single marker plus an empty cell below is only a merged label when the
// token is not a word in its own right.
// ---------------------------------------------------------------------------

describe('a 第N token that is itself a dictionary word', () => {
  it('keeps 第一次 as her word when it is the only marker row', () => {
    const result = extractVocab('第一次\t头一回\tthe first time\n\t苹果\tapple', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第一次=the first time',
      '苹果=apple',
    ]);
  });

  it('does the same for the quoted CSV form of the same paste', () => {
    const result = extractVocab('"第一次","头一回","the first time"\n"","苹果","apple"', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第一次=the first time',
      '苹果=apple',
    ]);
  });

  it('still strips the label when the marker repeats on two rows, word or not', () => {
    const result = extractVocab('第一次\t苹果\tapple\n第一次\t香蕉\tbanana', dict);
    expect(result.items.map((i) => i.zh)).toEqual(['苹果', '香蕉']);
  });
});

describe('a marker line only pairs with a line that reads as a gloss', () => {
  it('refuses a form label under the marker', () => {
    const result = extractVocab('第1课\nName: ____\n苹果 apple', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual(['苹果=apple']);
  });

  it('refuses a sign-off under the marker', () => {
    const result = extractVocab('第1课\nThanks,\n苹果 apple', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual(['苹果=apple']);
  });

  it('refuses anything ending in a colon, and any run of underscores', () => {
    for (const junk of ['This week:', '____', 'Homework: page 12']) {
      const result = extractVocab(`第1课\n${junk}\n苹果 apple`, dict);
      expect(
        result.items.map((i) => i.zh),
        junk
      ).toEqual(['苹果']);
    }
  });

  it('KEEPS a section title as the pair she typed (round 7c, pairs stay pairs)', () => {
    const result = extractVocab('第1课\nFood and Drink\n苹果\tapple', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第1课=Food and Drink',
      '苹果=apple',
    ]);
  });

  it('KEEPS the round-10 alternating-lines pair', () => {
    const result = extractVocab('第1课\nLesson one\n苹果\napple', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第1课=Lesson one',
      '苹果=apple',
    ]);
  });
});

describe('the colloquial hundreds are refused rather than guessed at', () => {
  it('does not read 第一百一天 as 101 or 第一百二天 as 102', () => {
    for (const text of ['第一百一天', '第一百二天', '第一百十天', '第一百十二天']) {
      const result = extractVocab(text, dict);
      expect(result.items, `${text} is not a number anyone writes unambiguously`).toEqual([]);
      expect(result.skipped, text).toEqual([text]);
      expect(result.paperworkOnly, `${text} must keep its rescue`).toBeFalsy();
    }
  });

  it('still reads the spelled-out forms', () => {
    const result = extractVocab('第一百零一天 第一百一十天 第一百一十二天 第一百二十三天', dict);
    expect(result.items.map((i) => `${i.zh}=${i.en}`)).toEqual([
      '第一百零一天=day 101',
      '第一百一十天=day 110',
      '第一百一十二天=day 112',
      '第一百二十三天=day 123',
    ]);
  });
});

/** 零一二三四五六七八九, for building distinct throwaway terms below. */
function chineseDigit(n: number): string {
  return '零一二三四五六七八九'[n % 10];
}

/** The route cap in src/worker/extract.ts: the biggest paste that reaches here. */
const KIB64 = 64 * 1024;
const KIB16 = 16 * 1024;

/**
 * Cuts or pads a paste to EXACTLY 64 KiB, at a line boundary.
 *
 * The padding is spaces, which every reader trims away to nothing, so the size
 * is honest without adding a line anyone has to account for.
 */
function padTo(text: string, limit: number): string {
  const enc = new TextEncoder();
  let out = '';
  let bytes = 0;
  for (const line of text.split('\n')) {
    const n = enc.encode(line).length + 1;
    if (bytes + n > limit) break;
    out += `${line}\n`;
    bytes += n;
  }
  return out + ' '.repeat(limit - bytes);
}
function padTo64KiB(text: string): string {
  return padTo(text, KIB64);
}

/**
 * The fastest of three runs, so one GC pause cannot decide a test.
 *
 * Two was not enough: this file shares the machine with every other test file,
 * and a loaded full-suite run measured a linear path at a ratio of 11.35 that
 * costs 3.97 to 4.01 on its own (round 7 fix list, item 4). Three and not more,
 * because a wall-clock assertion in a NEIGHBOURING file (`parse.test.ts`,
 * main's own 200 ms marker-column test) goes red when this one burns CPU beside
 * it.
 */
function bestOfThree(run: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    run();
    const ms = performance.now() - t0;
    if (ms < best) best = ms;
  }
  return best;
}

/** Every scaling measurement this file took, for the run summary. */
const scalings: { label: string; small: number; big: number }[] = [];

/**
 * How far 4x the input may cost more than 4x the time before it is a bug.
 *
 * Twelve, not six: six was the isolated measurement (3.97 to 4.01) plus room,
 * and a loaded full-suite run measured 11.35 on the same linear code, so the
 * bound was failing the machine rather than the code (round 7 fix list, item
 * 4). A quadratic path pays 16x at this step and is still caught.
 */
const MAX_SCALING_RATIO = 12;

/**
 * THE STANDING RULE, asserted as SHAPE rather than as wall clock.
 *
 * A wall-clock bound measures the machine as much as the code: the round-4
 * review measured one of these at 633 ms inside the full suite and 211 ms alone
 * against a 200 ms bound, so four to six tests went red per run on code that
 * was correct. What the rule actually cares about is that four times the input
 * costs about four times the time, so that is what is asserted: the ratio of
 * 64 KiB to 16 KiB, each the best of three runs, has to stay under
 * MAX_SCALING_RATIO. A quadratic path pays 16x and cannot hide under that. The
 * absolute cap stays only as a coarse tripwire at 1000 ms, five times the old
 * bound, where no amount of load on a laptop can reach it but a genuinely
 * broken path can.
 *
 * `build` is given a byte budget and returns a paste to be padded to it, so
 * both sizes are the SAME shape of input at two sizes.
 */
function expectLinearInSize(
  label: string,
  build: (limit: number) => string
): ReturnType<typeof extractVocab> {
  const small = padTo(build(KIB16), KIB16);
  const big = padTo(build(KIB64), KIB64);
  expect(new TextEncoder().encode(big).length).toBe(KIB64);
  const tSmall = bestOfThree(() => extractVocab(small, dict));
  let read: ReturnType<typeof extractVocab> | null = null;
  const tBig = bestOfThree(() => {
    read = extractVocab(big, dict);
  });
  scalings.push({ label, small: tSmall, big: tBig });
  const note = `${label}: 16 KiB ${tSmall.toFixed(1)} ms, 64 KiB ${tBig.toFixed(1)} ms`;
  // A floor of 1 ms on the denominator: below that the clock is the noise, and
  // a quadratic path at 64 KiB would be nowhere near this fast anyway.
  const ratio = tBig / Math.max(tSmall, 1);
  expect(ratio, `${note}, ratio ${ratio.toFixed(1)}`).toBeLessThan(MAX_SCALING_RATIO);
  expect(tBig, note).toBeLessThan(1_000);
  return read as unknown as ReturnType<typeof extractVocab>;
}

/** Ten characters, none of which is one of the definition function words. */
const NEAR_MISS_CHARS = '零一二三四五六七八九';

/** A distinct `len`-character run of Chinese for the number `i`. */
function nearMissRun(i: number, len: number): string {
  return Array.from(String(i).padStart(len, '0').slice(-len), (d) => NEAR_MISS_CHARS[Number(d)]).join(
    ''
  );
}

/**
 * `n` DISTINCT pairs that get all the way to the last test in the detector and
 * fail there.
 *
 * The term is 8 characters, the longest `isPairTerm` will walk. The definition
 * is 12, which is exactly the length ratio's floor for an 8-character term, and
 * it holds no Latin, so the no-Latin test and the ratio test both pass and only
 * the function-word test refuses it. Nothing repeats, so the collector's dedupe
 * never short-circuits the work.
 */
function nearMissPairs(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(nearMissRun(i, 8), nearMissRun(i, 12));
  return `${out.join('\n')}\n`;
}

/** `n` term / definition pairs, as the lines a teacher would have typed. */
function pairLines(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`词语${chineseDigit(i)}`, `这是第${chineseDigit(i)}个词的意思。`);
  }
  return out;
}

// ROUND 16. The Chinese-taught set: a term on one line, a Chinese sentence
// explaining it on the next, and no English anywhere in the paste. Fixtures 78
// (a whole Quizlet page) and 79 (the same 51 pairs a teacher typed herself).
describe('the term / definition pair detector', () => {
  it('needs five pairs before it calls a paste a list', () => {
    expect(readTermDefinitionPairs(pairLines(4))).toBeNull();
    expect(readTermDefinitionPairs(pairLines(5))?.pairs).toHaveLength(5);
  });

  it('keeps the term exactly as she typed it and the sentence as its meaning', () => {
    const pairs = readTermDefinitionPairs([
      '科技创新',
      '用新的科学和技术创造新的东西。',
      ...pairLines(5),
    ]);
    expect(pairs?.pairs[0]).toEqual({ term: '科技创新', definition: '用新的科学和技术创造新的东西。' });
  });

  // ROUND 2 REVIEW, should-fix 4. There is no ratio any more. A share of the
  // whole paste cliffed: five pairs over seven ordinary rows is 0.588, and one
  // row either side of that line decided whether 51 terms were read as terms or
  // shattered into dictionary words. The evidence is the RUN.
  it('reads the unbroken run of pairs however many plain rows follow it', () => {
    const noise = Array.from({ length: 9 }, (_, i) => `我们今天在学校学习了很多新的东西${i}。`);
    for (const n of [2, 7, 9]) {
      const reading = readTermDefinitionPairs([...pairLines(5), ...noise.slice(0, n)]);
      expect(reading?.pairs, `five pairs over ${n} plain rows`).toHaveLength(5);
      expect(reading?.rest).toHaveLength(n);
    }
  });

  it('leaves a run too short to qualify to the readers below', () => {
    const short = ['苹果', '一种红色的水果。', '香蕉', '一种黄色的水果。'];
    const reading = readTermDefinitionPairs([...short, '今天天气很好我们去公园', ...pairLines(6)]);
    expect(reading?.pairs).toHaveLength(6);
    // ROUND 3 REVIEW, must-fix 3. 苹果 used to be reported as the title for
    // standing on the paste's first line. It is vocabulary, and the readers
    // below are the ones that know that, so all of the short run goes to them.
    expect(reading?.title).toEqual([]);
    expect(reading?.rest).toEqual([...short, '今天天气很好我们去公园']);
  });

  // ROUND 3 REVIEW, must-fix 2. Only the LONGEST run used to keep pair mode, so
  // a second qualifying group was handed back to the segmenter with pair
  // detection off: two groups of five became 27 cards instead of 10.
  it('keeps every qualifying run, not just the longest one', () => {
    const second = Array.from({ length: 5 }, (_, i) => [
      `词组${'零一二三四'[i]}`,
      `这是第${'零一二三四'[i]}个词组的意思。`,
    ]).flat();
    const reading = readTermDefinitionPairs([
      ...pairLines(6),
      '今天天气很好我们去公园',
      ...second,
    ]);
    expect(reading?.pairs).toHaveLength(11);
    expect(reading?.rest).toEqual(['今天天气很好我们去公园']);
  });

  // ROUND 3 REVIEW, must-fix 1. ONE repeated row used to disqualify the whole
  // run: fixture 79 with its first pair pasted twice came back as 173
  // dictionary fragments and `skipped: []`.
  it('keeps the first of a repeated row and reports the second', () => {
    const rows = pairLines(6);
    const reading = readTermDefinitionPairs([...rows, rows[0], rows[1]]);
    expect(reading?.pairs).toHaveLength(6);
    expect(reading?.duplicates).toEqual(['词语零 appears twice']);
  });

  // ROUND 4, must-fix 1. Two conflicting redefinitions used to refuse the whole
  // run. Under the DECIDED PRINCIPLE they cannot: the first card is kept and the
  // sentence that was not used is quoted back, so she can see which text is on
  // the card.
  it('keeps the first card when a term is redefined, and quotes what it dropped', () => {
    const rows = pairLines(5);
    const two = [
      ...rows,
      rows[0], '这是另外一个完全不同的意思。',
      rows[4], '这是又一个完全不同的意思。',
    ];
    const reading = readTermDefinitionPairs(two);
    expect(reading?.pairs).toHaveLength(5);
    expect(reading?.duplicates).toEqual([
      '词语零: second meaning not used: 这是另外一个完全不同的意思。',
      '词语二: second meaning not used: 这是又一个完全不同的意思。',
    ]);
    const whole = extractVocab(two.join('\n'), dict);
    expect(whole.mode).toBe('structured');
    expect(whole.items).toHaveLength(5);
  });

  // ROUND 4, must-fix 1. The same row three times over is still one card and
  // one notice: rounds 2, 3 and 4 each moved the repetition threshold, which is
  // why there is no threshold left to move.
  it('folds a row pasted three times into one card and one notice', () => {
    const rows = pairLines(5);
    const thrice = [...rows, rows[0], rows[1], rows[0], rows[1]];
    const reading = readTermDefinitionPairs(thrice);
    expect(reading?.pairs).toHaveLength(5);
    expect(reading?.duplicates).toEqual(['词语零 appears 3 times']);
    expect(extractVocab(thrice.join('\n'), dict).items).toHaveLength(5);
  });

  // ROUND 3 REVIEW, must-fix 3. A heading between a term and its sentence used
  // to pair the HEADING with the sentence and drop the word.
  // ROUND 4, must-fix 2 (and the round-4 Claude review, items 1 to 3). The tail
  // test used to accept any Chinese line ending in 词, which is the ending of
  // ordinary vocabulary: 名词, 动词, 形容词, 歌词, 台词, 单词, and of 课文 too.
  // A heading now has to pass three tests, not one.
  it('never calls a part-of-speech word a heading when it has its own meaning under it', () => {
    const under = '表示人或事物名称的词。';
    for (const word of ['名词', '动词', '形容词', '歌词', '台词', '单词', '课文']) {
      expect(isPairHeading(word, under), word).toBe(false);
    }
    // A line that SAYS it is a label is a label whatever follows it: nothing is
    // a vocabulary word because it ends in 解释 or 表.
    for (const label of ['词语解释', '课文生词表']) {
      expect(isPairHeading(label, under), label).toBe(true);
    }
    // And a group label over an ordinary list is still the label it always was.
    expect(isPairHeading('第二组生词', '苹果')).toBe(true);
    expect(isPairHeading('生词表', '苹果')).toBe(true);
  });

  it('keeps 名词 and its own explanation as a card inside a list', () => {
    const rows = [...pairLines(5), '名词', '表示人或事物名称的词。'];
    const result = extractVocab(rows.join('\n'), dict);
    expect(result.mode).toBe('structured');
    expect(result.items.map((i) => i.zh)).toContain('名词');
    expect(result.items.find((i) => i.zh === '名词')?.en).toBe('表示人或事物名称的词。');
  });

  it('reads a six-word list of parts of speech as six cards', () => {
    const pos = [
      '名词', '表示人或事物名称的词。',
      '动词', '表示动作或者变化的一类词。',
      '形容词', '表示性质或者状态的一类词。',
      '歌词', '歌曲里面唱出来的那些句子。',
      '台词', '戏里面演员说出来的那些句子。',
      '语法学', '研究语言规则的一门学问。',
    ];
    const result = extractVocab(pos.join('\n'), dict);
    expect(result.mode).toBe('structured');
    expect(result.items.map((i) => i.zh)).toEqual([
      '名词', '动词', '形容词', '歌词', '台词', '语法学',
    ]);
  });

  // ROUND 4, must-fix 2. A spreadsheet row whose GLOSS ends in 名词 was read as
  // a heading and deleted, taking her word with it.
  it('keeps a spreadsheet row whose gloss ends in a part of speech', () => {
    const rows = ['苹果\tpíng guǒ\t一种名词', ...pairLines(5)];
    const result = extractVocab(rows.join('\n'), dict);
    expect(result.items.map((i) => i.zh)).toEqual(
      expect.arrayContaining(['苹果', '词语零', '词语四'])
    );
    expect(result.items).toHaveLength(6);
    expect(isPairHeading('苹果\tpíng guǒ\t一种名词', '词语零')).toBe(false);
  });

  it('takes a heading out from between a term and its own sentence', () => {
    const rows = pairLines(6);
    const reading = readTermDefinitionPairs([rows[0], '词语解释', ...rows.slice(1)]);
    expect(reading?.pairs[0].term).toBe('词语零');
    expect(reading?.pairs[0].definition).toBe('这是第零个词的意思。');
    expect(reading?.title).toEqual(['词语解释']);
  });

  // ROUND 2 REVIEW, must-fix 1. `的` and `是` are the two commonest characters in
  // the language, so the function-word test let a natural dialogue through: six
  // turns became six pairs, two cards, and nine real words thrown away.
  // ROUND 4, must-fix 1 (the DECIDED PRINCIPLE). What refuses a dialogue is not
  // repetition, it is DISTINCT TERMS: two speakers fold to two, which is under
  // the floor of five, so the run stops there however long the conversation is.
  it('refuses a dialogue because two speakers are two distinct terms, not five', () => {
    const dialogue = [
      '小明', '你今天是去哪里的呢',
      '小红', '我去的是学校的图书馆',
      '小明', '你看的是什么样的书',
      '小红', '我看的是有意思的故事书',
      '小明', '明天我们是不是一起去',
      '小红', '好的我们是说好了的',
    ];
    expect(readTermDefinitionPairs(dialogue)).toBeNull();
    expect(extractVocab(dialogue.join('\n'), dict).mode).toBe('free');
    // Three turns each instead of two: still two distinct names, still free.
    const repeated = [
      '小明', '他是一个很好的学生。',
      '小明', '他是一个很高的男孩。',
      '小明', '他是一个爱看书的人。',
      '小红', '她是一个很好的老师。',
      '小红', '她是一个很忙的大人。',
      '小红', '她是一个爱唱歌的人。',
    ];
    expect(readTermDefinitionPairs(repeated)).toBeNull();
    expect(extractVocab(repeated.join('\n'), dict).mode).toBe('free');
  });

  // ROUND 4, must-fix 1. The other half of the same principle: a real list with
  // a row pasted twice keeps all of its cards, however many repeats it carries.
  it('keeps a fifty-one word list whose first row was pasted three times', () => {
    // The real fifty-one, off the fixture, because `pairLines` numbers its
    // terms with the ten Chinese digits and repeats itself after that.
    const written = readFileSync(join(FIXTURES, '79-zh-term-zh-definition-plain.txt'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    const doubled = [...written, written[1], written[2], written[1], written[2]];
    const reading = readTermDefinitionPairs(doubled);
    expect(reading?.pairs).toHaveLength(51);
    expect(reading?.duplicates).toEqual([`${written[1]} appears 3 times`]);
    expect(extractVocab(doubled.join('\n'), dict).items).toHaveLength(51);
  });

  it('refuses a line that asks or shouts: an explanation does neither', () => {
    expect(isPairDefinition('你今天是去哪里的呢？', '小明')).toBe(false);
    expect(isPairDefinition('你今天是去哪里的呢?', '小明')).toBe(false);
    expect(isPairDefinition('他是一个很好的学生！', '小明')).toBe(false);
    expect(isPairDefinition('他是一个很好的学生。', '小明')).toBe(true);
  });

  it('does not read a nine-character line as a term', () => {
    expect(isPairTerm('科技创新人工智能语')).toBe(false);
    expect(isPairTerm('科技创新人工智能')).toBe(true);
    // ...so a nine-character line over a sentence makes no pair, and four
    // pairs on their own are under the floor.
    expect(
      readTermDefinitionPairs(['科技创新人工智能语', '用新的科学和技术创造新的东西。', ...pairLines(4)])
    ).toBeNull();
  });

  it('does not read a line shorter than its term as that term’s definition', () => {
    expect(isPairDefinition('小。', '科技创新')).toBe(false);
    expect(isPairDefinition('用新的科学创造东西。', '科技创新')).toBe(true);
    // A word list that runs short then long is not a pair list either: 你好 is
    // a word she wants on a card, not the meaning of 好.
    expect(isPairDefinition('你好', '好')).toBe(false);
  });

  it('leaves a pasted paragraph of prose in free mode', () => {
    const prose =
      '我们今天在学校学习了很多新的东西。老师说下个星期要考试。' +
      '同学们都很认真地听讲，还做了很多练习。放学以后我和朋友一起回家。';
    expect(extractVocab(prose, dict).mode).toBe('free');
  });

  // ROUND 1 REVIEW. "Has Chinese in it and runs past 8 characters" was not
  // evidence of a definition, and pair mode threw away everything it had not
  // paired. Fixtures 80 to 84 are the corpus half of these; this is the unit
  // half.
  it('refuses a line that carries English: that is a vocabulary row', () => {
    expect(isPairDefinition('学生 student person', '老师')).toBe(false);
    expect(isPairDefinition('科技创新 innovation', '科技创新')).toBe(false);
  });

  it('refuses a line of verse answering another line of verse', () => {
    expect(isPairDefinition('疑是地上霜。', '床前明月光')).toBe(false);
    expect(isPairDefinition('低头思故乡。', '举头望明月')).toBe(false);
  });

  it('refuses a line with no function word and no full stop', () => {
    // A dialogue's answer: long enough, Chinese, and explains nothing.
    expect(isPairDefinition('我去图书馆看书', '你今天去哪里')).toBe(false);
    // The same length with a function word in it IS an explanation.
    expect(isPairDefinition('用来看书的地方', '图书馆')).toBe(true);
  });

  it('keeps every line it did not pair, for the readers below to have', () => {
    const reading = readTermDefinitionPairs([...pairLines(5), '苹果\tapple', '香蕉\tbanana']);
    expect(reading?.rest).toEqual(['苹果\tapple', '香蕉\tbanana']);
  });

  it('puts the pairs and the plain rows under them in one set', () => {
    const paste = [...pairLines(5), '苹果\tpíng guǒ\tapple', '香蕉\txiāng jiāo\tbanana'].join('\n');
    const result = extractVocab(paste, dict);
    expect(result.items.map((i) => i.zh)).toContain('苹果');
    expect(result.items.map((i) => i.zh)).toContain('香蕉');
    expect(result.items).toHaveLength(7);
  });

  it('cuts a long definition at a clause, not at the dictionary limit', () => {
    // 40 characters is a CEDICT gloss's limit and cut her sentences mid-clause.
    const long = `这是一个很长的解释，${'它说明了这个词的意思和用法，'.repeat(8)}所以要写得很清楚。`;
    const result = extractVocab([...pairLines(5), '词语十', long].join('\n'), dict);
    const en = result.items.find((i) => i.zh === '词语十')?.en ?? '';
    expect(en.length).toBeGreaterThan(40);
    expect(en.length).toBeLessThanOrEqual(120);
    expect(/[。，、,]$/.test(en), en).toBe(true);
  });

  // ROUND 2 REVIEW, should-fix 5. A definition with no clause mark in its first
  // 120 characters used to be cut wherever character 120 fell, which on an
  // astral character is HALF of it: a lone surrogate on the card.
  it('cuts an unbroken definition at a whole character and says it was cut', () => {
    const long = `\u{20BB7}${'我们今天在学校学习了很多新的东西'.repeat(20)}`;
    const result = extractVocab([...pairLines(5), '词语十', long].join('\n'), dict);
    const en = result.items.find((i) => i.zh === '词语十')?.en ?? '';
    expect(en.endsWith('\u2026')).toBe(true);
    // 120 code points plus the ellipsis, and the astral character survives whole.
    expect(Array.from(en)).toHaveLength(121);
    expect(en.startsWith('\u{20BB7}')).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(en.slice(0, -1))).toBe(false);
  });

  it('reports a Chinese leftover row that made no card at all', () => {
    // ROUND 1 item 7, still open at the round 2 review: `isReportableSkip` only
    // ever passes a line with no Chinese in it, so a Chinese row the readers
    // below could not use disappeared without a word.
    const result = extractVocab([...pairLines(5), '\u3007\u3007\u3007'].join('\n'), dict);
    expect(result.skipped).toContain('\u3007\u3007\u3007');
  });

  // ROUND 3 REVIEW, must-fix 6. The report used to mark a leftover line USED if
  // any single CHARACTER of it appeared on any card, and 的 一 我 are on
  // everything, so almost every dropped row was reported as if it had been read.
  it('reports a leftover whose characters are all on cards but which is not', () => {
    // Every character of this line is on one of the five cards below, it made
    // no card of its own, and it is on none of them.
    const echo = '这的个';
    const result = extractVocab([...pairLines(5), echo].join('\n'), dict);
    expect(result.items.map((i) => i.zh)).not.toContain(echo);
    expect(result.skipped).toContain(echo);
  });

  // ROUND 4, fix list item 6. The other direction: judging a leftover on whole
  // FIELDS reported a prose line as skipped while that same line was making
  // three cards, because a Chinese sentence has no separator in it to split on.
  it('does not report a prose line that the segmenter turned into cards', () => {
    const prose = '我喜欢吃苹果和香蕉';
    const result = extractVocab([...pairLines(5), prose].join('\n'), dict);
    expect(result.items.map((i) => i.zh)).toEqual(
      expect.arrayContaining(['苹果', '香蕉'])
    );
    expect(result.skipped).not.toContain(prose);
  });

  it('lists forty-nine skipped lines and counts the rest', () => {
    const junk = Array.from({ length: 200 }, (_, i) => `\u3007${nearMissRun(i, 6)}`);
    const result = extractVocab([...pairLines(5), ...junk].join('\n'), dict);
    expect(result.skipped.filter((l) => l.startsWith('\u3007'))).toHaveLength(
      MAX_REPORTED_LEFTOVERS
    );
    // ROUND 5 FIX LIST, item 3. The count is a NOTE, so the worker's cap of
    // fifty skipped lines can never cut it off.
    const counted = (result.notes ?? []).filter((l) => /^\u2026 and \d+ more$/.test(l));
    expect(counted).toHaveLength(1);
    expect(result.notes?.[result.notes.length - 1]).toBe(counted[0]);
  });

  // ROUND 5 FIX LIST, item 6. A 2,000-character banner was echoed back whole
  // and the review screen built a 2,027-character warning out of it.
  it('cuts a very long leftover line short instead of echoing it whole', () => {
    const banner = '\u3007'.repeat(2000);
    const result = extractVocab([...pairLines(5), banner].join('\n'), dict);
    const echoed = result.skipped.filter((l) => l.startsWith('\u3007'));
    expect(echoed).toHaveLength(1);
    expect(Array.from(echoed[0])).toHaveLength(MAX_REPORTED_LINE_CHARS + 1);
    expect(echoed[0].endsWith('\u2026')).toBe(true);
  });

  it('does not report a spreadsheet row whose word did reach a card', () => {
    const result = extractVocab([...pairLines(5), '苹果\tpíng guǒ\tapple'].join('\n'), dict);
    expect(result.items.map((i) => i.zh)).toContain('苹果');
    expect(result.skipped.some((line) => line.includes('苹果'))).toBe(false);
  });

  it('reports the leftover title and never the definitions', () => {
    const result = extractVocab(['科技创新 词语解释', ...pairLines(6)].join('\n'), dict);
    expect(result.mode).toBe('structured');
    expect(result.items).toHaveLength(6);
    expect(result.items[0].en).toBe('这是第零个词的意思。');
    expect(result.skipped.some((s) => s.includes('意思'))).toBe(false);
  });
});

describe('the Quizlet page around the set', () => {
  it('starts the set at "Terms in this set (N)" and drops the chrome lines', () => {
    const page = [
      '中国古代哲学1',
      'Teacher',
      '80 terms',
      'Preview',
      'Terms in this set (5)',
      'Click the card to flip \u{1F446}',
      '1 / 5',
      ...pairLines(5),
    ].join('\n');
    const result = extractVocab(page, dict);
    expect(result.mode).toBe('structured');
    expect(result.items.map((i) => i.zh)).toEqual([
      '词语零',
      '词语一',
      '词语二',
      '词语三',
      '词语四',
    ]);
  });

  it('hands back a paste with no chrome in it character for character', () => {
    const paste = '苹果 apple\r\n香蕉 banana\n';
    expect(withoutQuizletChrome(paste).text).toBe(paste);
    expect(withoutQuizletChrome(paste).notes).toEqual([]);
  });

  // ROUND 2 REVIEW, must-fix 3. Without the anchor there is no proof the paste
  // came off Quizlet, and `Teacher` / `12 terms` / `Preview` are three things a
  // teacher may well have typed above her own list. Deleting them anyway deleted
  // them silently, while main reported all three.
  it('touches nothing when there is no anchor', () => {
    const paste = 'Teacher\n12 terms\nPreview\n苹果\tapple\n香蕉\tbanana\n老师\tteacher\n';
    expect(withoutQuizletChrome(paste).text).toBe(paste);
    const result = extractVocab(paste, dict);
    expect(result.items.map((i) => i.zh)).toEqual(['苹果', '香蕉', '老师']);
    expect(result.skipped).toContain('Preview');
  });

  it('says how much of the page it dropped, instead of dropping it in silence', () => {
    const page = ['中国古代哲学1', 'Teacher', '80 terms', 'Preview', 'Terms in this set (5)', ...pairLines(5)];
    const reading = withoutQuizletChrome(page.join('\n'));
    // FOUR, not five: `start` is the line after the anchor, and the count used
    // to include the anchor itself (round 3 review, must-fix 5).
    expect(reading.notes).toEqual(['4 lines above the Quizlet word list were skipped']);
    // A NOTE, NOT AN UNREAD LINE (round 5 fix list, item 5).
    expect(extractVocab(page.join('\n'), dict).notes?.[0]).toBe(
      '4 lines above the Quizlet word list were skipped'
    );
  });

  // ROUND 3 REVIEW, must-fix 5. An anchor on the first line had nothing above
  // it and the report said one line was skipped, counting the anchor itself.
  it('says nothing when the anchor is the first line of the paste', () => {
    const page = ['Terms in this set (5)', ...pairLines(5)].join('\n');
    expect(withoutQuizletChrome(page).notes).toEqual([]);
    expect(extractVocab(page, dict).skipped).toEqual([]);
    expect(extractVocab(page, dict).notes ?? []).toEqual([]);
  });

  it('says "1 line" when exactly one line was above the anchor', () => {
    const page = ['中国古代哲学1', 'Terms in this set (5)', ...pairLines(5)].join('\n');
    expect(withoutQuizletChrome(page).notes).toEqual([
      '1 line above the Quizlet word list was skipped',
    ]);
  });

  // ROUND 2 REVIEW, should-fix 6. The anchor is matched against literal ASCII
  // digits and parentheses, and it used to run BEFORE the NFKC fold, so a page
  // copied with fullwidth ones matched nothing and the sidebar stayed in.
  it('finds the anchor on a page copied with fullwidth digits and brackets', () => {
    const page = ['中国古代哲学1', 'Teacher', 'Terms in this set （５）', ...pairLines(5)].join('\n');
    const result = extractVocab(page, dict);
    expect(result.items.map((i) => i.zh)).toEqual(['词语零', '词语一', '词语二', '词语三', '词语四']);
    expect(result.notes).toContain('2 lines above the Quizlet word list were skipped');
  });

  it('reads chrome BELOW the anchor at a cost that scales with its size', () => {
    // Round 1 review, must-fix 6: the first version of this test put the chrome
    // ABOVE the anchor, where the anchor scan skips it and QUIZLET_CHROME_RE is
    // never asked about a single line of it. Every chrome line is below the
    // anchor here, so all of it runs through the regex.
    const result = expectLinearInSize(
      'Quizlet chrome',
      () =>
        // FIVE DISTINCT PAIRS, not one pair five times: five DISTINCT terms are
        // the floor the detector needs (the decided principle above
        // `withoutRepeatedTerms`), and one pair repeated folds to one.
        'Terms in this set (5)\n' +
        `${pairLines(5).join('\n')}\n` +
        'Click the card to flip \u{1F446}\n1 / 51\nPreview\nTeacher\nStudy with Learn\nChoose an answer\nDon\u2019t know?\n1,200 terms\n'.repeat(
          700
        )
    );
    expect(result.items.map((i) => i.zh)).toEqual(['词语零', '词语一', '词语二', '词语三', '词语四']);
  });

  it('refuses near-miss pairs at a cost that scales with their size', () => {
    // Round 1 review, must-fix 6 again: repeating one pair was the cheapest
    // input there is, because the collector dedupes it on the second row. Every
    // pair here is distinct, every term is the longest a term may be (8
    // characters, so `isPairTerm` walks all of them), and every definition
    // clears the no-Latin test AND the length ratio and fails only at the last
    // check, the function word. That is every test in the detector run to its
    // failing end, on every line.
    const result = expectLinearInSize('near-miss pairs', () => nearMissPairs(1_100));
    // None of it pairs, which is the point: the cost is in the refusals.
    expect(result.items.every((i) => i.source !== 'pair')).toBe(true);
  });

  // THE STANDING RULE: every new strip or scan ships with its worst case at
  // size. These two are the round 2 additions - the clause hunt in
  // `cleanDefinition` (should-fix 5) and the leftover-report scan in the pair
  // branch (must-fix 3).
  it('cuts a definition with no clause mark in it at a cost that scales', () => {
    const result = expectLinearInSize('run-on definition', (limit) => {
      // 16 characters at 3 bytes each, sized to leave the five pairs above it
      // room, so the padder keeps the whole line at 16 KiB as well as at 64.
      const runOn = '我们今天在学校学习了很多新的东西'.repeat(Math.floor((limit - 1_024) / 48));
      return [...pairLines(5), '词语十', runOn].join('\n');
    });
    const en = result.items.find((i) => i.zh === '词语十')?.en ?? '';
    expect(Array.from(en)).toHaveLength(121);
  });

  it('reports unpairable Chinese leftovers at a cost that scales', () => {
    // ROUND 3 REVIEW, must-fix 4. The first version of this test asserted
    // nothing about the report, and its rows left the scan after two characters
    // because the second one was on a card. Every row here runs the scan to its
    // END - it is Chinese, it is not a card, none of its FIELDS is a card and
    // no token the leftover pass produced is inside it - so every one of them
    // is reported, which is the expensive answer.
    const result = expectLinearInSize('unpairable leftovers', (limit) => {
      const leftovers = Array.from(
        { length: Math.ceil(limit / 30) },
        (_, i) => `\u3007${nearMissRun(i, 6)} \u3007${nearMissRun(i, 6)}`
      );
      return [...pairLines(5), ...leftovers].join('\n');
    });
    expect(result.mode).toBe('structured');
    // ROUND 4, fix list item 6. The report stops at fifty lines and counts the
    // rest, instead of handing back two hundred lines nobody reads.
    const reported = result.skipped.filter((line) => line.startsWith('\u3007'));
    expect(reported).toHaveLength(MAX_REPORTED_LEFTOVERS);
    expect((result.notes ?? []).some((line) => /^\u2026 and \d+ more$/.test(line))).toBe(true);
  });

  // ROUND 5 FIX LIST, item 4. The DECIDED ADDENDUM: the discriminator is the
  // CONTENT of the B line, never repetition and never the term count alone.
  it('reads a first- or second-person pronoun as conversation, not explanation', () => {
    expect(isConversationalLine('\u6211\u4eca\u5929\u65e9\u4e0a\u548c\u670b\u53cb\u4e00\u8d77\u53bb\u4e86\u5b66\u6821\u7684\u56fe\u4e66\u9986\u3002')).toBe(true);
    expect(isConversationalLine('\u4f60\u660e\u5929\u665a\u4e0a\u6709\u7a7a\u5417')).toBe(true);
    expect(isConversationalLine('\u60a8\u8bf7\u5750\u3002')).toBe(true);
    expect(isConversationalLine('\u54b1\u4eec\u4e00\u8d77\u53bb\u5427\u3002')).toBe(true);
    // STANDALONE, which is why the compound comes out first. `\u6211\u56fd` is how an
    // impersonal sentence says "this country".
    expect(isConversationalLine('\u6307\u6211\u56fd\u5386\u53f2\u4e0a\u6700\u65e9\u7684\u6587\u5b57\u8bb0\u5f55\u3002')).toBe(false);
    expect(isConversationalLine('\u4e00\u79cd\u7ea2\u8272\u6216\u8005\u7eff\u8272\u7684\u6c34\u679c\u3002')).toBe(false);
  });

  it('reads a sentence-final particle and a quoted line as conversation', () => {
    expect(isConversationalLine('\u4eca\u5929\u5929\u6c14\u5f88\u597d\u5462\u3002')).toBe(true);
    expect(isConversationalLine('\u4e00\u8d77\u53bb\u5403\u996d\u5427\uff01')).toBe(true);
    expect(isConversationalLine('\u201c\u660e\u5929\u5c31\u8981\u8003\u8bd5\u4e86\u3002\u201d')).toBe(true);
    expect(isConversationalLine('\u300c\u660e\u5929\u5c31\u8981\u8003\u8bd5\u4e86\u3002\u300d')).toBe(true);
    expect(isConversationalLine('')).toBe(false);
    expect(isConversationalLine('\u5c06\u4e24\u4ef6\u4e8b\u60c5\u653e\u5728\u4e00\u8d77\u6bd4\u8f83\u3002')).toBe(false);
  });

  // MEASURED BEFORE THE RULE WAS COMMITTED TO. If a real definition were
  // conversational the marker set would be tightened, never the threshold.
  it('calls none of fixture 78 conversational', () => {
    const reading = readTermDefinitionPairs(
      readFileSync(join(FIXTURES, '78-quizlet-zh-term-zh-definition.txt'), 'utf8')
        .normalize('NFKC')
        .split(/\r\n|\r|\n/)
    );
    expect(reading?.pairs).toHaveLength(51);
    const talky = (reading?.pairs ?? []).filter((p) => isConversationalLine(p.definition));
    expect(talky.map((p) => p.definition)).toEqual([]);
  });

  it('demotes a run of five speakers with one statement each to free mode', () => {
    const turns = [
      '\u5c0f\u660e',
      '\u6211\u4eca\u5929\u65e9\u4e0a\u548c\u670b\u53cb\u4e00\u8d77\u53bb\u4e86\u5b66\u6821\u7684\u56fe\u4e66\u9986\u3002',
      '\u5c0f\u7ea2',
      '\u6211\u6628\u5929\u4e0b\u5348\u5728\u5bb6\u91cc\u505a\u5b8c\u4e86\u8001\u5e08\u7559\u7684\u4f5c\u4e1a\u3002',
      '\u8001\u738b',
      '\u6211\u6bcf\u5929\u665a\u4e0a\u90fd\u4f1a\u770b\u4e00\u4f1a\u513f\u65b0\u95fb\u548c\u5929\u6c14\u9884\u62a5\u3002',
      '\u674e\u4e3d',
      '\u6211\u4e0a\u4e2a\u661f\u671f\u548c\u5988\u5988\u53bb\u5546\u5e97\u4e70\u4e86\u5f88\u591a\u6c34\u679c\u3002',
      '\u5f20\u4f1f',
      '\u6211\u660e\u5929\u8981\u5750\u516c\u5171\u6c7d\u8f66\u53bb\u706b\u8f66\u7ad9\u63a5\u6211\u7684\u540c\u5b66\u3002',
    ];
    expect(readTermDefinitionPairs(turns)).toBeNull();
    expect(extractVocab(turns.join('\n'), dict).mode).toBe('free');
  });

  // A LIST IS NOT DEMOTED BY ONE CHATTY SENTENCE. The threshold is 40% of the
  // run, so a single example sentence among nine explanations still reads as a
  // list.
  it('keeps a list in which one definition of five is conversational', () => {
    // `\u4f60\u8981\u597d\u597d\u5b66\u4e60\u3002` and nothing else: one chatty sentence among four
    // explanations is 20% of the run, under the 40% the rule turns on.
    const lines = [...pairLines(4), '\u52aa\u529b', '\u4f60\u8981\u628a\u6bcf\u4ef6\u4e8b\u90fd\u505a\u5230\u6700\u597d\u3002'];
    const reading = readTermDefinitionPairs(lines);
    expect(reading?.pairs).toHaveLength(5);
  });

  // ROUND 6 FIX LIST, item 1. The pronoun test was a bare character class, so
  // `\u8ff7\u4f60` triggered `\u4f60` and `\u6211\u4eec` flagged the definitions of \u73af\u5883, \u793e\u4f1a and
  // \u56fd\u5bb6 - the way every children's dictionary writes them.
  it('reads a plural and a compound as words, not as somebody talking', () => {
    // Fixture 84's own definition of \u73af\u5883, the one that used to be refused.
    expect(isConversationalLine('\u6211\u4eec\u751f\u6d3b\u7684\u5730\u65b9\u548c\u5468\u56f4\u7684\u4e00\u5207\u3002')).toBe(false);
    expect(isConversationalLine('\u8ff7\u4f60\u624b\u673a\u662f\u5f88\u5c0f\u7684\u624b\u673a\u3002')).toBe(false);
    expect(isConversationalLine('\u4f60\u597d\u662f\u89c1\u9762\u65f6\u8bf4\u7684\u8bdd\u3002')).toBe(false);
    expect(isConversationalLine('\u60a8\u597d\u662f\u5bf9\u957f\u8f88\u8bf4\u7684\u4f60\u597d\u3002')).toBe(false);
    expect(isConversationalLine('\u54b1\u4eec\u4e00\u8d77\u53bb\u4e70\u4e1c\u897f\u3002')).toBe(false);
    // The singulars still are, standing on their own.
    expect(isConversationalLine('\u4f60\u4eca\u5929\u53bb\u4e86\u5b66\u6821\u7684\u56fe\u4e66\u9986\u3002')).toBe(true);
    expect(isConversationalLine('\u6211\u6628\u5929\u5728\u5bb6\u91cc\u505a\u5b8c\u4e86\u4f5c\u4e1a\u3002')).toBe(true);
    expect(isConversationalLine('\u60a8\u770b\u4e00\u4e0b\u8fd9\u4e2a\u5b57\u7684\u610f\u601d\u3002')).toBe(true);
  });

  // ROUND 7 FIX LIST, item 1. The exclusion was a word list, so it held \u6211\u56fd
  // and \u6211\u6821 and missed the rest of the same family, and every Traditional
  // spelling walked straight past it.
  it('reads a pronoun with a body behind it as a compound, in either script', () => {
    for (const line of [
      '\u6211\u7701\u6700\u65e9\u7684\u6587\u5b57\u8bb0\u5f55\u5c31\u5728\u8fd9\u91cc\u3002',
      '\u6211\u6821\u6bcf\u5e74\u90fd\u4f1a\u4e3e\u529e\u8fd9\u6837\u7684\u6d3b\u52a8\u3002',
      '\u6211\u5011\u751f\u6d3b\u7684\u5730\u65b9\u548c\u5468\u570d\u7684\u4e00\u5207\u3002',
      '\u4f60\u5011\u6bcf\u5929\u4e0a\u8bfe\u5b66\u4e60\u7684\u5730\u65b9\u3002',
      '\u54b1\u5011\u4e00\u8d77\u53bb\u4e70\u4e1c\u897f\u3002',
      '\u81ea\u6211\u4ecb\u7ecd\u662f\u8bf4\u81ea\u5df1\u7684\u60c5\u51b5\u3002',
      '\u8ff7\u4f60\u624b\u673a\u662f\u5f88\u5c0f\u7684\u624b\u673a\u3002',
    ]) {
      expect(isConversationalLine(line), line).toBe(false);
    }
  });

  // ROUND 7 FIX LIST, item 2. The old exclusion cut `\u4f60\u597d` out of the line, so
  // an instruction to a child lost the `\u4f60` that made it one.
  it('reads \u4f60\u597d as the greeting only where the line stops or explains it', () => {
    // The greeting on a card, and the line that explains it.
    expect(isConversationalLine('\u4f60\u597d\uff0c\u65e9\u4e0a\u597d\u3002')).toBe(false);
    expect(isConversationalLine('\u60a8\u597d\u3002')).toBe(false);
    expect(isConversationalLine('\u4f60\u597d\u662f\u89c1\u9762\u65f6\u8bf4\u7684\u8bdd\u3002')).toBe(false);
    // \u597d is the start of the next word, so the \u4f60 is a child being spoken to.
    expect(isConversationalLine('\u4f60\u597d\u597d\u5b66\u4e60\uff0c\u5929\u5929\u5411\u4e0a\u3002')).toBe(true);
    expect(isConversationalLine('\u60a8\u597d\u597d\u4f11\u606f\u4e00\u4e0b\u3002')).toBe(true);
  });

  // ROUND 8 FIX LIST, item 1. Round 7 swapped the cut-the-substring exclusion
  // for the character families above and dropped the idioms BUILT out of both
  // pronouns on the way: 我行我素 is one person's stubbornness, and the 我 in it
  // is nobody speaking.
  it('reads an idiom built out of both pronouns as a word, not as a speaker', () => {
    for (const idiom of [
      '\u6211\u884c\u6211\u7d20',
      '\u4f60\u6b7b\u6211\u6d3b',
      '\u4f60\u4e89\u6211\u593a',
      '\u4f60\u6765\u6211\u5f80',
      '\u4f60\u4e00\u8a00\u6211\u4e00\u8bed',
    ]) {
      expect(isConversationalLine(idiom), idiom).toBe(false);
      expect(
        isConversationalLine(`\u6307\u4e00\u4e2a\u4eba${idiom}\u7684\u6837\u5b50\u3002`),
        idiom
      ).toBe(false);
    }
  });

  // ROUND 8 FIX LIST, item 3 (Claude final review). Round 7 put 家 and 系 into
  // the compound-tail family, so a beginner's own sentences stopped counting.
  it('reads \u6211\u5bb6 and \u4f60\u7cfb as a beginner talking, not as a compound', () => {
    expect(isConversationalLine('\u6211\u5bb6\u6709\u4e09\u53e3\u4eba\u3002')).toBe(true);
    expect(isConversationalLine('\u4f60\u5bb6\u5728\u54ea\u513f')).toBe(true);
    expect(isConversationalLine('\u4f60\u7cfb\u597d\u5b89\u5168\u5e26\u3002')).toBe(true);
    // The rest of the family is untouched, and so is the freeze.
    expect(isConversationalLine('\u6211\u7701\u6700\u65e9\u7684\u6587\u5b57\u8bb0\u5f55\u5c31\u5728\u8fd9\u91cc\u3002')).toBe(false);
    expect(isConversationalLine('\u6211\u6821\u6bcf\u5e74\u90fd\u4f1a\u4e3e\u529e\u8fd9\u6837\u7684\u6d3b\u52a8\u3002')).toBe(false);
  });

  // The same fix on the whole read: five names over five 我家 / 你家 sentences is
  // the first dialogue an HSK1 class writes, and it was coming back as five
  // vocabulary cards with no note at all.
  it('refuses a five-turn \u6211\u5bb6 dialogue and says out loud that it did', () => {
    const dialogue = [
      '\u5c0f\u660e', '\u6211\u5bb6\u6709\u4e09\u53e3\u4eba\u3002',
      '\u5c0f\u7ea2', '\u4f60\u5bb6\u6709\u5f88\u591a\u597d\u770b\u7684\u4e66\u3002',
      '\u8001\u738b', '\u6211\u5bb6\u4f4f\u5728\u5b66\u6821\u7684\u540e\u9762\u3002',
      '\u674e\u4e3d', '\u4f60\u5bb6\u7684\u5c0f\u72d7\u5f88\u53ef\u7231\u3002',
      '\u5f20\u4f1f', '\u6211\u5bb6\u79bb\u8fd9\u91cc\u4e0d\u592a\u8fdc\u3002',
    ];
    const result = extractVocab(dialogue.join('\n'), dict);
    expect(result.mode).toBe('free');
    expect(result.notes ?? []).toContain(
      '5 lines that looked like a conversation were not used as word meanings'
    );
  });

  it('calls none of fixture 84 conversational either', () => {
    const reading = readTermDefinitionPairs(
      readFileSync(join(FIXTURES, '84-two-quizlet-sets.txt'), 'utf8')
        .normalize('NFKC')
        .split(/\r\n|\r|\n/)
    );
    const talky = (reading?.pairs ?? []).filter((p) => isConversationalLine(p.definition));
    expect(talky.map((p) => p.definition)).toEqual([]);
  });

  // ROUND 6 FIX LIST, item 6 (Claude final review). Two standalone \u4f60 in five
  // pairs is exactly the 40% threshold, so the run is still refused - and a
  // refusal that says nothing is how her meanings disappeared in silence.
  it('says out loud when a run was refused as a conversation', () => {
    const lines = [
      '\u52aa\u529b', '\u4f60\u8981\u6bcf\u5929\u90fd\u8ba4\u771f\u5730\u505a\u597d\u6bcf\u4e00\u4ef6\u4e8b\u3002',
      '\u575a\u6301', '\u4f60\u4e0d\u80fd\u505a\u4e86\u4e24\u5929\u5c31\u4e0d\u518d\u505a\u4e0b\u53bb\u3002',
      '\u670b\u53cb', '\u5e38\u5e38\u4e00\u8d77\u73a9\u4e00\u8d77\u5b66\u4e60\u7684\u4eba\u3002',
      '\u8001\u5e08', '\u5728\u5b66\u6821\u91cc\u6559\u5b66\u751f\u77e5\u8bc6\u7684\u4eba\u3002',
      '\u5b66\u6821', '\u5b66\u751f\u6bcf\u5929\u4e0a\u8bfe\u5b66\u4e60\u7684\u5730\u65b9\u3002',
    ];
    const refused: string[] = [];
    expect(readTermDefinitionPairs(lines, refused)).toBeNull();
    expect(refused).toEqual([
      '5 lines that looked like a conversation were not used as word meanings',
    ]);
    // And the note reaches the answer, on the path that has no reading to
    // carry it: free mode.
    const result = extractVocab(lines.join('\n'), dict);
    expect(result.mode).toBe('free');
    expect(result.notes ?? []).toContain(
      '5 lines that looked like a conversation were not used as word meanings'
    );
  });

  // ROUND 6 FIX LIST, item 7. Every other quoted line is cut at 80 characters;
  // this one was printed whole, which measured a 2,033-character banner.
  it('cuts a second meaning back to the length every other quote is cut to', () => {
    const long = `${'\u8fd9\u662f\u53e6\u5916\u4e00\u4e2a\u5f88\u957f\u7684\u610f\u601d'.repeat(20)}\u3002`;
    const lines = [...pairLines(5), '\u8bcd\u8bed\u96f6', long, ...pairLines(5).slice(2)];
    const notes = extractVocab(lines.join('\n'), dict).notes ?? [];
    const said = notes.find((n) => n.includes('second meaning not used'));
    const quoted = said?.slice(said.indexOf('not used: ') + 'not used: '.length) ?? '';
    expect(Array.from(quoted)).toHaveLength(MAX_REPORTED_LINE_CHARS + 1);
    expect(quoted.endsWith('\u2026')).toBe(true);
  });

  // ROUND 6 FIX LIST, item 3. The reply's note cap kept the last slot for the
  // count line, which is the one note whose absence changes what the rest mean.
  it('keeps the count line when the notes hit the wire cap', () => {
    const many = Array.from({ length: MAX_NOTES_REPORTED + 9 }, (_, i) => `note ${i}`);
    const summary = leftoverSummaryNote(12);
    const kept = reportedNotes([...many, summary]);
    expect(kept).toHaveLength(MAX_NOTES_REPORTED);
    // ROUND 8 FIX LIST, item 4. The extractor's count used to survive as itself,
    // and it spoke for the leftover LINES only: the ten notes this cap cut went
    // with nothing to say they had. One line counts both now.
    expect(kept[kept.length - 1]).toBe(
      `\u2026 and ${many.length - (MAX_NOTES_REPORTED - 1) + 12} more notes`
    );
    expect(kept[kept.length - 2]).toBe(`note ${MAX_NOTES_REPORTED - 2}`);
    // A list that never overflowed is handed back whole.
    expect(reportedNotes(['note 0', summary])).toEqual(['note 0', summary]);
    // ROUND 7 FIX LIST, item 3. A cut list with no count line of its own is
    // GIVEN one: forty-nine notes and a line saying how many did not fit.
    const cut = reportedNotes(many);
    expect(cut).toHaveLength(MAX_NOTES_REPORTED);
    expect(cut[MAX_NOTES_REPORTED - 2]).toBe(`note ${MAX_NOTES_REPORTED - 2}`);
    expect(cut[MAX_NOTES_REPORTED - 1]).toBe(
      `… and ${many.length - (MAX_NOTES_REPORTED - 1)} more notes`
    );
  });

  // ROUND 7 FIX LIST, item 3, on the WIRE and not on the helper: sixty pairs
  // pasted twice is sixty duplicate notices, no leftovers and no count line, so
  // the reply carried fifty of them and the screen said `Notes (50)` with
  // nothing to say ten were missing.
  it('says how many notes did not fit when they are all duplicate notices', () => {
    // Sixty DISTINCT pairs: `pairLines` numbers its terms with one digit, so
    // sixty of those would repeat inside the first copy as well.
    const sixty: string[] = [];
    for (let i = 0; i < 60; i++) {
      sixty.push(`词语${nearMissRun(i, 3)}`, `这是第${nearMissRun(i, 3)}个词的意思。`);
    }
    const body = toResponse(extractVocab([...sixty, ...sixty].join('\n'), dict));
    const notes = body.notes ?? [];
    expect(notes).toHaveLength(MAX_NOTES_REPORTED);
    // Every one of them is a duplicate notice, so nothing wrote the leftover
    // count line that used to be the only thing holding the last slot.
    expect(notes.some((n) => /^… and \d+ more$/.test(n))).toBe(false);
    expect(notes[MAX_NOTES_REPORTED - 1]).toBe(
      `… and ${60 - (MAX_NOTES_REPORTED - 1)} more notes`
    );
    expect(body.skipped.filter((l) => l.startsWith('〇'))).toHaveLength(0);
  });

  // ROUND 8 FIX LIST, item 4, on the WIRE. Duplicates AND leftovers together:
  // sixty-one notes went out as fifty, and the only count line that survived
  // was the extractor's, which speaks for the leftover LINES. Eleven duplicate
  // notices went in silence.
  it('counts the notes it cut AND the leftovers in one line', () => {
    const sixty: string[] = [];
    for (let i = 0; i < 60; i++) {
      sixty.push(`\u8bcd\u8bed${nearMissRun(i, 3)}`, `\u8fd9\u662f\u7b2c${nearMissRun(i, 3)}\u4e2a\u8bcd\u7684\u610f\u601d\u3002`);
    }
    const junk = Array.from({ length: 200 }, (_, i) => `\u3007${nearMissRun(i, 6)}`);
    const raw = extractVocab([...sixty, ...sixty, ...junk].join('\n'), dict);
    const rawNotes = raw.notes ?? [];
    // Sixty duplicate notices and the extractor's own count of the leftovers.
    // Some of the junk donates a character to a card and stops being a
    // leftover, so the count is read rather than assumed; what matters is that
    // it lists forty-nine and counts a hundred more.
    const unlisted = leftoverSummaryCount(rawNotes[rawNotes.length - 1]);
    expect(raw.skipped.filter((l) => l.startsWith('\u3007'))).toHaveLength(
      MAX_REPORTED_LEFTOVERS
    );
    expect(unlisted).toBeGreaterThan(100);
    const listed = rawNotes.length - 1;
    expect(listed).toBe(60);

    const notes = toResponse(raw).notes ?? [];
    expect(notes).toHaveLength(MAX_NOTES_REPORTED);
    // Nothing is left saying `\u2026 and N more` about the leftover lines alone.
    expect(notes.some((n) => /^\u2026 and \d+ more$/.test(n))).toBe(false);
    expect(notes[MAX_NOTES_REPORTED - 1]).toBe(
      `\u2026 and ${listed - (MAX_NOTES_REPORTED - 1) + unlisted} more notes`
    );
  });

  // STANDING RULE, for the one regex added in round 6. It is anchored at both
  // ends with a single unbounded run in it, so a 64 KiB line fails on the first
  // characters; asserted as shape, like the scans above.
  it('reads the count line at a cost that does not scale with the line', () => {
    // THE SAME SHAPE AT TWO SIZES, and the shape is the expensive one: a line
    // that reaches ` more` and then fails, so the digit run is given back one
    // character at a time. A matching line at one size and a failing one at the
    // other measures two different things.
    const small = `\u2026 and ${'9'.repeat(KIB16)} more x`;
    const big = `\u2026 and ${'9'.repeat(KIB64)} more x`;
    // FIVE HUNDRED CALLS EACH, so the 16 KiB side is milliseconds rather than
    // noise: a ratio measured against a clock floor says nothing.
    const tSmall = bestOfThree(() => {
      for (let i = 0; i < 500; i++) isLeftoverSummaryNote(small);
    });
    const tBig = bestOfThree(() => {
      for (let i = 0; i < 500; i++) isLeftoverSummaryNote(big);
    });
    expect(tBig / Math.max(tSmall, 1)).toBeLessThan(MAX_SCALING_RATIO);
    expect(tBig).toBeLessThan(1_000);
    expect(isLeftoverSummaryNote(leftoverSummaryNote(3))).toBe(true);
    expect(isLeftoverSummaryNote('\u2026 and some more')).toBe(false);
    // STANDING RULE for the one regex round 8 added: `leftoverSummaryCount` is
    // the same anchored shape with the digits captured, so it is measured on
    // the same two lines.
    const cSmall = bestOfThree(() => {
      for (let i = 0; i < 500; i++) leftoverSummaryCount(small);
    });
    const cBig = bestOfThree(() => {
      for (let i = 0; i < 500; i++) leftoverSummaryCount(big);
    });
    expect(cBig / Math.max(cSmall, 1)).toBeLessThan(MAX_SCALING_RATIO);
    expect(cBig).toBeLessThan(1_000);
    expect(leftoverSummaryCount(leftoverSummaryNote(3))).toBe(3);
    expect(leftoverSummaryCount('\u2026 and some more')).toBe(0);
  });

  // ROUND 5 FIX LIST, item 1 (Codex round 4, P1). stripHeaders ran first and
  // took the word off the paste before the pair walk could rescue it.
  it('keeps a word whose own definition sits under it, however it is spelled', () => {
    for (const word of ['\u5355\u8bcd', '\u8bfe\u6587', '\u751f\u8bcd']) {
      const lines = [
        '\u82f9\u679c',
        '\u4e00\u79cd\u7ea2\u8272\u6216\u8005\u7eff\u8272\u7684\u6c34\u679c\u3002',
        '\u9999\u8549',
        '\u4e00\u79cd\u9ec4\u8272\u7684\u957f\u957f\u7684\u6c34\u679c\u3002',
        word,
        '\u8bed\u8a00\u4e2d\u53ef\u4ee5\u72ec\u7acb\u8fd0\u7528\u7684\u6700\u5c0f\u5355\u4f4d\u3002',
        '\u8001\u5e08',
        '\u5728\u5b66\u6821\u91cc\u6559\u5b66\u751f\u77e5\u8bc6\u7684\u4eba\u3002',
        '\u5b66\u751f',
        '\u5728\u5b66\u6821\u91cc\u5b66\u4e60\u77e5\u8bc6\u7684\u4eba\u3002',
      ];
      const result = extractVocab(lines.join('\n'), dict);
      expect(result.mode, word).toBe('structured');
      expect(result.items.map((i) => i.zh), word).toEqual(['\u82f9\u679c', '\u9999\u8549', word, '\u8001\u5e08', '\u5b66\u751f']);
      expect(result.skipped, word).toEqual([]);
    }
  });

  // AND A LINE THAT SAYS IT IS A LABEL IS STILL A LABEL.
  it('still takes a label off the top of a list that explains it', () => {
    const lines = [
      '\u751f\u8bcd\u8868',
      '\u4e00\u79cd\u7ea2\u8272\u6216\u8005\u7eff\u8272\u7684\u6c34\u679c\u3002',
      ...pairLines(5),
    ];
    const result = extractVocab(lines.join('\n'), dict);
    expect(result.items.map((i) => i.zh)).not.toContain('\u751f\u8bcd\u8868');
    expect(result.skipped).toContain('\u751f\u8bcd\u8868');
  });

  // ROUND 5 FIX LIST, item 2 (Codex round 4, P2). Two accepted runs, the same
  // word defined differently in each. Per-run folding met an untouched map the
  // second time, made no notice, and the collector then dropped the card in
  // silence.
  it('reconciles the same word defined twice across two accepted runs', () => {
    const five = pairLines(5);
    const second = [...five];
    second[1] = '\u8fd9\u662f\u53e6\u5916\u4e00\u4e2a\u610f\u601d\uff0c\u5b8c\u5168\u4e0d\u540c\u3002';
    const result = extractVocab([...five, 'Next group', ...second].join('\n'), dict);
    expect(result.mode).toBe('structured');
    expect(result.items).toHaveLength(5);
    // NFKC folded the fullwidth comma before the reader saw the line, so the
    // notice quotes the folded text back.
    expect(result.notes).toContain(
      `\u8bcd\u8bed\u96f6: second meaning not used: ${second[1].normalize('NFKC')}`
    );
    // The four that were pasted unchanged are counted, not quoted.
    expect(result.notes).toContain('\u8bcd\u8bed\u4e00 appears twice');
    // NOT an unread line. They were all read.
    expect(result.skipped).not.toContain('\u8bcd\u8bed\u4e00 appears twice');
  });

  // ROUND 5 FIX LIST, item 7. Two rewrites of one word both said "second".
  it('calls the third definition another meaning, not a second one', () => {
    const lines = [
      ...pairLines(5),
      '\u8bcd\u8bed\u96f6',
      '\u8fd9\u662f\u53e6\u5916\u4e00\u4e2a\u610f\u601d\uff0c\u5b8c\u5168\u4e0d\u540c\u3002',
      '\u8bcd\u8bed\u96f6',
      '\u8fd9\u662f\u7b2c\u4e09\u79cd\u8bf4\u6cd5\uff0c\u4e5f\u4e0d\u4e00\u6837\u3002',
      ...pairLines(5).slice(2),
    ];
    const notes = extractVocab(lines.join('\n'), dict).notes ?? [];
    expect(notes.filter((n) => n.includes('second meaning not used'))).toHaveLength(1);
    expect(notes.filter((n) => n.includes('another meaning not used'))).toHaveLength(1);
  });

  // ROUND 5 FIX LIST, item 3 (Codex round 4, P2). The extractor was right and
  // the WIRE was wrong: toResponse sliced a 51-entry list to 50 and cut off
  // exactly the count line. Asserted on the serialized body, not on the
  // extractor's own answer.
  it('carries the heading, the duplicate, the leftovers and the count over the wire', () => {
    const five = pairLines(5);
    const junk = Array.from({ length: 200 }, (_, i) => `\u3007${nearMissRun(i, 6)}`);
    const body = toResponse(
      extractVocab(['\u751f\u8bcd\u8868', ...five, ...five, ...junk].join('\n'), dict)
    );
    expect(body.mode).toBe('structured');
    expect(body.skipped).toContain('\u751f\u8bcd\u8868');
    expect(body.skipped.filter((l) => l.startsWith('\u3007'))).toHaveLength(MAX_REPORTED_LEFTOVERS);
    expect(body.skipped.length).toBeLessThanOrEqual(MAX_SKIPPED_REPORTED);
    const notes = body.notes ?? [];
    expect(notes).toContain('\u8bcd\u8bed\u96f6 appears twice');
    expect(notes.some((l) => /^\u2026 and \d+ more$/.test(l))).toBe(true);
    expect(notes.length).toBeLessThanOrEqual(MAX_NOTES_REPORTED);
  });

  // STANDING RULE: every new regex ships with a 64 KB worst-case timing test.
  // The conversational scan is a per-line replace plus three character tests,
  // and it runs on every B line of every candidate run.
  it('reads conversational markers at a cost that scales with the paste', () => {
    const result = expectLinearInSize('conversational scan', (limit) => {
      const out: string[] = [];
      for (let i = 0; out.join('\n').length < limit; i++) {
        out.push(
          `\u8bcd\u8bed${nearMissRun(i, 4)}`,
          `\u81ea\u6211\u5fd8\u6211\u6211\u56fd\u6211\u65b9\u4f60\u6b7b\u6211\u6d3b\u6211\u4eec\u4f60\u4eec\u4f60\u597d\u60a8\u597d\u8ff7\u4f60${nearMissRun(i, 20)}\u7684\u610f\u601d\u5462\u3002`
        );
      }
      return out.join('\n');
    });
    expect(result.mode).toBe('free');
  });

  it('prints what the four worst cases cost at both sizes', () => {
    // Straight to stdout, like the fixture table: the numbers the standing rule
    // is about are worth seeing on a green run, not only on a red one.
    process.stdout.write(
      `\n  worst case                16 KiB    64 KiB   ratio\n  ${'-'.repeat(50)}\n` +
        scalings
          .map(
            ({ label, small, big }) =>
              `  ${label.padEnd(24)}${`${small.toFixed(1)} ms`.padStart(8)}${`${big.toFixed(1)} ms`.padStart(10)}${(big / Math.max(small, 1)).toFixed(1).padStart(8)}\n`
          )
          .join('') +
        '\n'
    );
    expect(scalings).toHaveLength(5);
  });
});

// ROUND 4, must-fix 3. `source === 'pair'` was reading the SPREADSHEET and HSK
// rows too, because those are 'pair' as well, and their glosses stopped being
// cleaned: fixture 13 came back `n. apple` where main returns `apple`. One
// mis-routed branch is enough to change every older fixture at once, and a
// per-fixture must / mustNot list is too loose to see it, so the whole of
// main's answer for fixtures 1 to 77 is checked character for character.
//
// The baseline was generated by running `git show main:src/shared/extract.ts`
// as a module against these same fixture files and the same shipped dictionary,
// and it is the JSON of the WHOLE result, not a projection: items in order with
// their pinyin, gloss and source, the skipped list, the mode, and the
// paperwork flag. Regenerate it only when main itself has moved.
describe("main's answer for fixtures 1 to 77, character for character", () => {
  const baseline = JSON.parse(
    readFileSync(join(ROOT, 'tests/fixtures/main-extract-01-77.json'), 'utf8')
  ) as Record<string, unknown>;

  it('has a recorded answer for every one of the seventy-seven', () => {
    expect(Object.keys(baseline)).toHaveLength(77);
    // A guard on the guard: if this ever read a stub dictionary or an empty
    // file the comparison below would pass for the wrong reason.
    expect((baseline['13-hsk-list.txt'] as { items: { en: string }[] }).items[0].en).toBe('apple');
  });

  for (const [file, expected] of Object.entries(baseline)) {
    it(`answers ${file} exactly as main does`, () => {
      const text = readFileSync(join(FIXTURES, file), 'utf8');
      expect(JSON.stringify(extractVocab(text, dict))).toBe(JSON.stringify(expected));
    });
  }
});

