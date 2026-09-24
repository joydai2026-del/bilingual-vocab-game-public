import { describe, it, expect } from 'vitest';
import { parseVocab, isPinyinToken, hasCJK } from '../src/shared/parse';

describe('parseVocab: Quizlet tab export', () => {
  it('reads term<TAB>definition lines', () => {
    const { items, skipped } = parseVocab('你好\thello\n谢谢\tthank you\n再见\tgoodbye');
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      { zh: '你好', pinyin: '', en: 'hello' },
      { zh: '谢谢', pinyin: '', en: 'thank you' },
      { zh: '再见', pinyin: '', en: 'goodbye' },
    ]);
  });
});

describe('parseVocab: Chinese-comma list', () => {
  it('splits on a fullwidth comma', () => {
    const { items } = parseVocab('苹果，apple\n香蕉，banana');
    expect(items).toEqual([
      { zh: '苹果', pinyin: '', en: 'apple' },
      { zh: '香蕉', pinyin: '', en: 'banana' },
    ]);
  });

  it('handles the fullwidth vertical bar and other fullwidth separators', () => {
    const { items } = parseVocab('水｜water\n火：fire\n土／earth');
    expect(items.map((i) => [i.zh, i.en])).toEqual([
      ['水', 'water'],
      ['火', 'fire'],
      ['土', 'earth'],
    ]);
  });
});

describe('parseVocab: Chinese-only list', () => {
  it('keeps every word with an empty pinyin and gloss', () => {
    const { items, skipped } = parseVocab('猫\n狗\n鸟');
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      { zh: '猫', pinyin: '', en: '' },
      { zh: '狗', pinyin: '', en: '' },
      { zh: '鸟', pinyin: '', en: '' },
    ]);
  });
});

describe('parseVocab: CSV with a comma inside a quoted gloss', () => {
  it('keeps the quoted gloss in one piece', () => {
    const { items } = parseVocab('你好,"hello, hi there"\n谢谢,"thanks, thank you"');
    expect(items).toEqual([
      { zh: '你好', pinyin: '', en: 'hello, hi there' },
      { zh: '谢谢', pinyin: '', en: 'thanks, thank you' },
    ]);
  });

  it('unescapes a doubled quote inside a field', () => {
    const { items } = parseVocab('引号,"a ""quoted"" word"');
    expect(items[0].en).toBe('a "quoted" word');
  });
});

describe('parseVocab: three columns zh + pinyin + en', () => {
  it('reads a tab-separated three-column export', () => {
    const { items } = parseVocab('你好\tnǐ hǎo\thello\n谢谢\txiè xie\tthank you');
    expect(items).toEqual([
      { zh: '你好', pinyin: 'nǐ hǎo', en: 'hello' },
      { zh: '谢谢', pinyin: 'xiè xie', en: 'thank you' },
    ]);
  });

  it('reads a comma-separated three-column line with digit tones', () => {
    const { items } = parseVocab('你好,ni3 hao3,hello');
    expect(items).toEqual([{ zh: '你好', pinyin: 'ni3 hao3', en: 'hello' }]);
  });

  it('keeps a multi-syllable pinyin phrase together', () => {
    const { items } = parseVocab('图书馆 | tú shū guǎn | library');
    expect(items).toEqual([{ zh: '图书馆', pinyin: 'tú shū guǎn', en: 'library' }]);
  });
});

describe('parseVocab: numbered lists', () => {
  it('strips 1. / 1、/ ① prefixes', () => {
    const { items } = parseVocab('1. 你好，hello\n2、谢谢，thanks\n①再见，goodbye\n3 苹果，apple');
    expect(items.map((i) => [i.zh, i.en])).toEqual([
      ['你好', 'hello'],
      ['谢谢', 'thanks'],
      ['再见', 'goodbye'],
      ['苹果', 'apple'],
    ]);
  });
});

describe('parseVocab: lines we cannot use', () => {
  it('sends a lone English word to skipped', () => {
    const { items, skipped } = parseVocab('你好，hello\nbanana\n谢谢，thanks');
    expect(items.map((i) => i.zh)).toEqual(['你好', '谢谢']);
    expect(skipped).toEqual(['banana']);
  });

  it('never chops an English-only line at its comma', () => {
    const { items, skipped } = parseVocab('hello, hi there');
    expect(items).toEqual([]);
    expect(skipped).toEqual(['hello, hi there']);
  });

  it('skips blank lines silently', () => {
    const { items, skipped } = parseVocab('\n\n你好\thello\n   \n\n');
    expect(items).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('skips a header row without reporting it', () => {
    const { items, skipped } = parseVocab('Chinese,English\n你好,hello');
    expect(items).toEqual([{ zh: '你好', pinyin: '', en: 'hello' }]);
    expect(skipped).toEqual([]);
  });

  it('skips a Term,Definition header too', () => {
    const { items, skipped } = parseVocab('Term\tDefinition\n猫\tcat');
    expect(items).toHaveLength(1);
    expect(skipped).toEqual([]);
  });
});

describe('parseVocab: duplicates', () => {
  it('collapses a repeated Chinese word and back-fills missing columns', () => {
    const { items } = parseVocab('你好\n你好\tnǐ hǎo\thello');
    expect(items).toEqual([{ zh: '你好', pinyin: 'nǐ hǎo', en: 'hello' }]);
  });
});

describe('isPinyinToken', () => {
  it('accepts tone marks, digit tones, and ü', () => {
    expect(isPinyinToken('nǐ hǎo')).toBe(true);
    expect(isPinyinToken('ni3 hao3')).toBe(true);
    expect(isPinyinToken('lv4')).toBe(true);
    expect(isPinyinToken('nv3')).toBe(true);
    expect(isPinyinToken('lü')).toBe(true);
  });

  it('rejects plain English and Chinese', () => {
    expect(isPinyinToken('hello')).toBe(false);
    expect(isPinyinToken('thank you')).toBe(false);
    expect(isPinyinToken('你好')).toBe(false);
    expect(isPinyinToken('')).toBe(false);
  });
});

describe('hasCJK', () => {
  it('detects Chinese characters only', () => {
    expect(hasCJK('你好')).toBe(true);
    expect(hasCJK('a你b')).toBe(true);
    expect(hasCJK('hello')).toBe(false);
    expect(hasCJK('ni3 hao3')).toBe(false);
  });
});

describe('parseVocab: unquoted CSV with commas inside the gloss', () => {
  it('joins the extra fields back into the English meaning', () => {
    const { items } = parseVocab('苹果,apple, the fruit');
    expect(items).toEqual([{ zh: '苹果', pinyin: '', en: 'apple, the fruit' }]);
  });

  it('handles a fullwidth comma list the same way', () => {
    const { items } = parseVocab('你好，hello, hi there\n谢谢，thanks, thank you');
    expect(items).toEqual([
      { zh: '你好', pinyin: '', en: 'hello, hi there' },
      { zh: '谢谢', pinyin: '', en: 'thanks, thank you' },
    ]);
  });

  it('keeps the pinyin column out of the joined gloss', () => {
    const { items } = parseVocab('你好,ni3 hao3,hello, hi, greetings');
    expect(items).toEqual([{ zh: '你好', pinyin: 'ni3 hao3', en: 'hello, hi, greetings' }]);
  });

  it('joins on other punctuation separators too', () => {
    const { items } = parseVocab('图书馆;library; the building with books');
    expect(items).toEqual([
      { zh: '图书馆', pinyin: '', en: 'library, the building with books' },
    ]);
  });

  it('leaves real tab columns alone', () => {
    // A tab export's third column is a separate column, not more gloss.
    const { items } = parseVocab('苹果\tapple\tnoun');
    expect(items).toEqual([{ zh: '苹果', pinyin: '', en: 'apple' }]);
  });

  it('still refuses to chop an English-only line at its commas', () => {
    const { items, skipped } = parseVocab('apple, the fruit, a red one');
    expect(items).toEqual([]);
    expect(skipped).toEqual(['apple, the fruit, a red one']);
  });
});

// --- shapes added 2026-09-08 with the smart input box -------------------------
// Sources: section 6 of docs/research/2026-09-08-quizlet-extraction.md (Quizlet
// export shapes and the alternating-lines clipboard shape) and the Google
// Sheets gviz CSV finding in section 7.

describe('parseVocab: a plain space between the word and the rest', () => {
  it('splits 你好 hello, which the home screen promises works', () => {
    const { items, skipped } = parseVocab('你好 hello\n谢谢 thank you');
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      { zh: '你好', pinyin: '', en: 'hello' },
      { zh: '谢谢', pinyin: '', en: 'thank you' },
    ]);
  });

  it('keeps a multi-word gloss whole instead of chopping it into columns', () => {
    const { items } = parseVocab('图书馆 the building with books');
    expect(items).toEqual([{ zh: '图书馆', pinyin: '', en: 'the building with books' }]);
  });

  it('peels a space-separated pinyin run off the front of the gloss', () => {
    const { items } = parseVocab('图书馆 tú shū guǎn library');
    expect(items).toEqual([{ zh: '图书馆', pinyin: 'tú shū guǎn', en: 'library' }]);
  });

  it('reads a word with only its pinyin as pinyin, not as a gloss', () => {
    const { items } = parseVocab('你好 nǐ hǎo');
    expect(items).toEqual([{ zh: '你好', pinyin: 'nǐ hǎo', en: '' }]);
  });
});

describe('parseVocab: pinyin in brackets', () => {
  it('reads 苹果 (píng guǒ) apple', () => {
    const { items } = parseVocab('苹果 (píng guǒ) apple');
    expect(items).toEqual([{ zh: '苹果', pinyin: 'píng guǒ', en: 'apple' }]);
  });

  it('reads the same line with no spaces around the brackets', () => {
    const { items } = parseVocab('苹果(píng guǒ)apple');
    expect(items).toEqual([{ zh: '苹果', pinyin: 'píng guǒ', en: 'apple' }]);
  });

  it('reads fullwidth brackets and 【】 too', () => {
    const { items } = parseVocab('香蕉（xiāng jiāo）banana\n猫【māo】cat');
    expect(items).toEqual([
      { zh: '香蕉', pinyin: 'xiāng jiāo', en: 'banana' },
      { zh: '猫', pinyin: 'māo', en: 'cat' },
    ]);
  });

  it('leaves a bracket that is not pinyin exactly where the teacher put it', () => {
    const { items } = parseVocab('苹果 (fruit) apple');
    expect(items).toEqual([{ zh: '苹果', pinyin: '', en: '(fruit) apple' }]);
  });
});

describe('parseVocab: bullets', () => {
  it('strips - * • and · markers', () => {
    const { items, skipped } = parseVocab('- 你好，hello\n* 谢谢，thanks\n• 再见，goodbye\n· 苹果，apple');
    expect(skipped).toEqual([]);
    expect(items.map((i) => [i.zh, i.en])).toEqual([
      ['你好', 'hello'],
      ['谢谢', 'thanks'],
      ['再见', 'goodbye'],
      ['苹果', 'apple'],
    ]);
  });

  it('strips a bullet and a number together', () => {
    const { items } = parseVocab('- 1. 你好 hello');
    expect(items).toEqual([{ zh: '你好', pinyin: '', en: 'hello' }]);
  });
});

describe('parseVocab: the alternating-lines clipboard shape', () => {
  it('pairs a Chinese line with the English line under it', () => {
    const { items, skipped } = parseVocab('你好\nhello\n谢谢\nthank you\n再见\ngoodbye');
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      { zh: '你好', pinyin: '', en: 'hello' },
      { zh: '谢谢', pinyin: '', en: 'thank you' },
      { zh: '再见', pinyin: '', en: 'goodbye' },
    ]);
  });

  it('keeps a comma inside an alternating gloss', () => {
    const { items } = parseVocab('自制\nhold back, restrain');
    expect(items).toEqual([{ zh: '自制', pinyin: '', en: 'hold back, restrain' }]);
  });

  it('takes a pinyin line and then an English line for the same word', () => {
    const { items } = parseVocab('你好\nnǐ hǎo\nhello');
    expect(items).toEqual([{ zh: '你好', pinyin: 'nǐ hǎo', en: 'hello' }]);
  });

  it('shows the teacher a stray unpaired line rather than dropping it', () => {
    const { items, skipped } = parseVocab('你好\nhello\nleftover');
    expect(items).toEqual([{ zh: '你好', pinyin: '', en: 'hello' }]);
    expect(skipped).toEqual(['leftover']);
  });

  it('never steals a gloss from a line that already has one', () => {
    const { items, skipped } = parseVocab('你好\thello\nbanana');
    expect(items).toEqual([{ zh: '你好', pinyin: '', en: 'hello' }]);
    expect(skipped).toEqual(['banana']);
  });
});

describe('parseVocab: two-column CSV from Google Sheets', () => {
  // Exactly the shape gviz/tq?tqx=out:csv returns: every field quoted, a header
  // row, and trailing empty columns for the width of the sheet.
  const SHEET_CSV =
    '"Chinese","English","",""\n' +
    '"你好","hello","",""\n' +
    '"谢谢","thanks, thank you","",""\n' +
    '"再见","goodbye","",""';

  it('drops the quoted header row instead of reporting it as skipped', () => {
    const { items, skipped } = parseVocab(SHEET_CSV);
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      { zh: '你好', pinyin: '', en: 'hello' },
      { zh: '谢谢', pinyin: '', en: 'thanks, thank you' },
      { zh: '再见', pinyin: '', en: 'goodbye' },
    ]);
  });

  it('reads a three-column sheet with a pinyin column', () => {
    const { items } = parseVocab('"Chinese","Pinyin","English"\n"你好","nǐ hǎo","hello"');
    expect(items).toEqual([{ zh: '你好', pinyin: 'nǐ hǎo', en: 'hello' }]);
  });

  it('reads a sheet with no header row at all', () => {
    const { items, skipped } = parseVocab('"猫","cat"\n"狗","dog"');
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      { zh: '猫', pinyin: '', en: 'cat' },
      { zh: '狗', pinyin: '', en: 'dog' },
    ]);
  });
});

describe('parseVocab: a line of Chinese words separated by spaces', () => {
  it('reads 苹果 香蕉 老师 学生 as four words, not one', () => {
    const { items, skipped } = parseVocab('苹果 香蕉 老师 学生');
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      { zh: '苹果', pinyin: '', en: '' },
      { zh: '香蕉', pinyin: '', en: '' },
      { zh: '老师', pinyin: '', en: '' },
      { zh: '学生', pinyin: '', en: '' },
    ]);
  });

  it('reads the whole ten-word line a teacher pastes across one line', () => {
    const { items } = parseVocab('苹果 香蕉 老师 学生 跑步 游泳 高兴 漂亮 图书馆 电脑');
    expect(items).toHaveLength(10);
    expect(items.map((i) => i.zh)).toEqual([
      '苹果', '香蕉', '老师', '学生', '跑步', '游泳', '高兴', '漂亮', '图书馆', '电脑',
    ]);
  });

  it('leaves 苹果 apple as one pair, because the line is not all Chinese', () => {
    const { items } = parseVocab('苹果 apple');
    expect(items).toEqual([{ zh: '苹果', pinyin: '', en: 'apple' }]);
  });

  it('leaves 图书馆 library as one pair', () => {
    const { items } = parseVocab('图书馆 library');
    expect(items).toEqual([{ zh: '图书馆', pinyin: '', en: 'library' }]);
  });

  it('leaves 你好 nǐ hǎo as one word and its pinyin', () => {
    const { items } = parseVocab('你好 nǐ hǎo');
    expect(items).toEqual([{ zh: '你好', pinyin: 'nǐ hǎo', en: '' }]);
  });

  it('splits a numbered line of words too', () => {
    const { items } = parseVocab('1. 猫 狗 鸟');
    expect(items.map((i) => i.zh)).toEqual(['猫', '狗', '鸟']);
  });

  it('collapses a word repeated on the same line', () => {
    const { items } = parseVocab('猫 狗 猫');
    expect(items.map((i) => i.zh)).toEqual(['猫', '狗']);
  });

  it('does not hand an English line under a row of words to the last word', () => {
    const { items, skipped } = parseVocab('猫 狗\ncat');
    expect(items).toEqual([
      { zh: '猫', pinyin: '', en: '' },
      { zh: '狗', pinyin: '', en: '' },
    ]);
    expect(skipped).toEqual(['cat']);
  });

  it('keeps a mixed line of two Chinese tokens and a gloss as one pair', () => {
    const { items } = parseVocab('图书 馆 library');
    expect(items).toEqual([{ zh: '图书 馆', pinyin: '', en: 'library' }]);
  });
});

// ROUND 9b. A table whose FIRST column is the lesson number.
//
// `Lesson | Chinese | English` is what a teacher gets out of Excel or Google
// Sheets. The first Chinese field used to take the term slot unconditionally,
// so her word was thrown away and the lesson number became the card's Chinese:
// a wrong answer key, one per row. See src/shared/parse.ts and fixture 72.
describe('a lesson-number column beside the word', () => {
  it('gives the term slot to the word, not to the tab-separated lesson number', () => {
    const { items } = parseVocab(
      '第1课\t苹果\tapple\n第2课\t香蕉\tbanana\n第3课\t老师\tteacher\n第4课\t学生\tstudent\n第5课\t你好\thello'
    );
    expect(items).toEqual([
      { zh: '苹果', pinyin: '', en: 'apple' },
      { zh: '香蕉', pinyin: '', en: 'banana' },
      { zh: '老师', pinyin: '', en: 'teacher' },
      { zh: '学生', pinyin: '', en: 'student' },
      { zh: '你好', pinyin: '', en: 'hello' },
    ]);
  });

  it('does the same for a pipe table, spaced or not', () => {
    expect(parseVocab('第1课 | 苹果 | apple').items).toEqual([
      { zh: '苹果', pinyin: '', en: 'apple' },
    ]);
    expect(parseVocab('第1课|你好|hello').items).toEqual([
      { zh: '你好', pinyin: '', en: 'hello' },
    ]);
  });

  it('keeps the pinyin column when the lesson number is dropped', () => {
    expect(parseVocab('第1课\t苹果\tpíng guǒ\tapple').items).toEqual([
      { zh: '苹果', pinyin: 'píng guǒ', en: 'apple' },
    ]);
  });

  it('reads the Chinese title row above such a table as a header', () => {
    const { items } = parseVocab('课\t生词\t英文\n第1课\t苹果\tapple\n第2课\t香蕉\tbanana');
    expect(items).toEqual([
      { zh: '苹果', pinyin: '', en: 'apple' },
      { zh: '香蕉', pinyin: '', en: 'banana' },
    ]);
  });

  // ROUND 7c IS NOT REOPENED. One Chinese column means the marker IS her term.
  it('leaves a marker glossed in Latin alone: one Chinese column, so it is the term', () => {
    const { items } = parseVocab('第1课\tLesson one\n第2课\tLesson two');
    expect(items).toEqual([
      { zh: '第1课', pinyin: '', en: 'Lesson one' },
      { zh: '第2课', pinyin: '', en: 'Lesson two' },
    ]);
  });

  // A COUNTABLE UNIT ON ONE ROW IS NOT A COLUMN. One row cannot tell a Week
  // column from a word she typed, and `第1天` can be the word she meant, so the
  // rule does not reach it. It takes a repeat to make it a column; see below.
  it('does not drop a countable 第N marker on a single row: 第1周 keeps the term slot', () => {
    expect(parseVocab('第1周\t苹果\tapple').items).toEqual([
      { zh: '第1周', pinyin: '', en: 'apple' },
    ]);
  });

  it('keeps the first field when both Chinese columns are lesson numbers', () => {
    expect(parseVocab('第1课\t第一課\tlesson one').items).toEqual([
      { zh: '第1课', pinyin: '', en: 'lesson one' },
    ]);
  });
});

// ROUND 11b, MUST-FIX 1. The r9b column rule tested only the DOC-STRUCTURE
// units, so a Week or Day column in a tab table was still picked as the term:
// `第1周\t苹果\tapple` x3 answered 第1周=apple and every word she typed was
// gone, replaced by a confident wrong answer key. The SPACE-separated twin of
// the same paste already returned the three words, so one paste had two
// opposite answers depending on which key she pressed between the columns.
//
// THE TEST IS THE FIELD INDEX, NOT THE ROW. A countable marker only stops being
// a candidate term when the SAME column holds one on two or more rows, which is
// what makes it a column rather than a word. That keeps the single-row cases
// above (and `第一次\t头一回\tthe first time`) exactly as they were.
describe('parseVocab: a countable 第N marker that is a whole COLUMN', () => {
  const rows = (unit: string, sep: string) =>
    [`第1${unit}${sep}苹果${sep}apple`, `第2${unit}${sep}香蕉${sep}banana`, `第3${unit}${sep}老师${sep}teacher`].join('\n');
  const want = [
    { zh: '苹果', pinyin: '', en: 'apple' },
    { zh: '香蕉', pinyin: '', en: 'banana' },
    { zh: '老师', pinyin: '', en: 'teacher' },
  ];

  for (const unit of ['周', '天', '名']) {
    it(`gives the term slot to her word, not to the 第N${unit} column (tab)`, () => {
      expect(parseVocab(rows(unit, '\t')).items).toEqual(want);
    });
  }

  it('does the same for a pipe table', () => {
    expect(parseVocab(rows('周', '|')).items).toEqual(want);
  });

  it('answers the tab table exactly as the space-separated twin already did', () => {
    expect(parseVocab(rows('周', '\t')).items.map((i) => i.zh)).toEqual(['苹果', '香蕉', '老师']);
  });

  // WHAT IT REFUSES WHEN ITS ASSUMPTION IS WRONG, pinned so a later round does
  // not think it was missed: a table whose real term IS an ordinal word AND
  // which repeats one in the same column loses it. Two rows of `第一次` beside
  // a Chinese synonym is that shape, and it is far rarer than a Week column.
  it('still keeps a countable marker beside a synonym column when it does not repeat', () => {
    expect(parseVocab('第一次\t头一回\tthe first time').items).toEqual([
      { zh: '第一次', pinyin: '', en: 'the first time' },
    ]);
  });

  it('leaves a countable marker glossed in Latin alone: one Chinese column', () => {
    expect(parseVocab('第1周\tWeek one\n第2周\tWeek two').items).toEqual([
      { zh: '第1周', pinyin: '', en: 'Week one' },
      { zh: '第2周', pinyin: '', en: 'Week two' },
    ]);
  });
});

// ROUND 11b, SHOULD-FIX. The r9b header fix added 课 and 課 and stopped there,
// so a title row over any of the other eight units still came back as cards:
// `周\t生词\t英文` produced 周=circle, 生词=new word, 英文=English. isHeaderLine
// wants EVERY field to be a column name, so one unrecognised unit poisons the
// whole row. All nine doc-structure units and all nine countable ones are
// column titles when they stand in a row of nothing but column titles.
describe('parseVocab: a unit title row above the table', () => {
  for (const [unit, table] of [
    ['周', '周\t生词\t英文\n第1周\t苹果\tapple\n第2周\t香蕉\tbanana'],
    ['天', '天\t中文\t英文\n第1天\t苹果\tapple\n第2天\t香蕉\tbanana'],
    ['单元', '单元\t生词\t英文\n第1单元\t苹果\tapple\n第2单元\t香蕉\tbanana'],
  ] as const) {
    it(`drops a ${unit} title row instead of carding it`, () => {
      expect(parseVocab(table).items).toEqual([
        { zh: '苹果', pinyin: '', en: 'apple' },
        { zh: '香蕉', pinyin: '', en: 'banana' },
      ]);
    });
  }

  // The two-field floor is untouched: `周\tweek` is a row, not a header.
  it('does not eat a two-column row whose first field happens to be a unit', () => {
    expect(parseVocab('周\tweek').items).toEqual([{ zh: '周', pinyin: '', en: 'week' }]);
  });
});

// Round 15 (Codex): the marker-column scan must stay linear in the number of
// marker rows. A 64 KB table of 第N周 rows is the worst case.
describe('round 15: marker-column scan is linear', () => {
  it('reads a 64 KB table of 第N周 rows in well under 200 ms', () => {
    const rows: string[] = [];
    let i = 1;
    while (rows.join('\n').length < 60000) {
      rows.push(`第${i}周\t苹果\tapple`);
      i++;
      if (i % 500 === 0 && rows.join('\n').length >= 60000) break;
    }
    const text = rows.join('\n');
    const t0 = performance.now();
    parseVocab(text, { isHeadword: () => false });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(200);
  });
});

