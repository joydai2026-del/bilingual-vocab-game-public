import { describe, it, expect } from 'vitest';
import { buildQuestions, scoreAnswer, perQuestionMsFor } from '../src/shared/quiz';
import type { VocabItem, VocabSet } from '../src/shared/types';

function makeSet(n: number, title = 'test set'): VocabSet {
  const items: VocabItem[] = Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    zh: `中${i}`,
    pinyin: `zhong${i}`,
    en: `word${i}`,
  }));
  return { v: 1, title, level: 'big', items };
}

describe('perQuestionMsFor', () => {
  it('kids get 12000ms, big kids/adults get 8000ms', () => {
    expect(perQuestionMsFor('kids')).toBe(12000);
    expect(perQuestionMsFor('big')).toBe(8000);
  });
});

describe('buildQuestions counts', () => {
  it('produces one question per item per direction', () => {
    const set = makeSet(6);
    const qs = buildQuestions(set, { seed: 1 });
    expect(qs).toHaveLength(12); // 6 items * 2 directions
  });

  it('respects a custom directions list', () => {
    const set = makeSet(5);
    const qs = buildQuestions(set, { directions: ['zh2en'], seed: 1 });
    expect(qs).toHaveLength(5);
    expect(qs.every((q) => q.dir === 'zh2en')).toBe(true);
  });
});

describe('buildQuestions correctness', () => {
  it('answer index points at the correct choice for zh2en', () => {
    const set = makeSet(8);
    const qs = buildQuestions(set, { directions: ['zh2en'], seed: 42 });
    for (const q of qs) {
      const item = set.items.find((i) => i.id === q.itemId)!;
      expect(q.prompt).toBe(item.zh);
      expect(q.choices[q.answer]).toBe(item.en);
    }
  });

  it('answer index points at the correct choice for en2zh', () => {
    const set = makeSet(8);
    const qs = buildQuestions(set, { directions: ['en2zh'], seed: 42 });
    for (const q of qs) {
      const item = set.items.find((i) => i.id === q.itemId)!;
      expect(q.prompt).toBe(item.en);
      expect(q.choices[q.answer]).toBe(item.zh);
    }
  });

  it('never has duplicate choices within one question', () => {
    const set = makeSet(10);
    const qs = buildQuestions(set, { seed: 7 });
    for (const q of qs) {
      expect(new Set(q.choices).size).toBe(q.choices.length);
    }
  });

  it('caps choices at 4 for larger sets', () => {
    const set = makeSet(10);
    const qs = buildQuestions(set, { seed: 7 });
    for (const q of qs) {
      expect(q.choices.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('buildQuestions determinism', () => {
  it('same seed produces identical output', () => {
    const set = makeSet(6);
    const a = buildQuestions(set, { seed: 99 });
    const b = buildQuestions(set, { seed: 99 });
    expect(a).toEqual(b);
  });
});

describe('buildQuestions small sets', () => {
  it('a 2-item set still yields at least 2 choices per question', () => {
    const set = makeSet(2);
    const qs = buildQuestions(set, { seed: 3 });
    expect(qs).toHaveLength(4); // 2 items * 2 directions
    for (const q of qs) {
      expect(q.choices.length).toBeGreaterThanOrEqual(2);
      expect(q.choices[q.answer]).toBeDefined();
    }
  });
});

describe('buildQuestions with duplicate English glosses', () => {
  // 'a' and 'b' share the gloss "happy" so an en2zh prompt of "happy" would
  // be ambiguous about which zh was meant; both are excluded from en2zh.
  function makeAmbiguousSet(): VocabSet {
    const items: VocabItem[] = [
      { id: 'a', zh: '开心', pinyin: 'kai1 xin1', en: 'happy' },
      { id: 'b', zh: '高兴', pinyin: 'gao1 xing4', en: 'happy' },
      { id: 'c', zh: '难过', pinyin: 'nan2 guo4', en: 'sad' },
      { id: 'd', zh: '生气', pinyin: 'sheng1 qi4', en: 'angry' },
    ];
    return { v: 1, title: 'feelings', level: 'big', items };
  }

  it('excludes items with a duplicated gloss from en2zh only', () => {
    const set = makeAmbiguousSet();
    const en2zh = buildQuestions(set, { directions: ['en2zh'], seed: 1 });
    expect(en2zh.map((q) => q.itemId).sort()).toEqual(['c', 'd']);

    const zh2en = buildQuestions(set, { directions: ['zh2en'], seed: 1 });
    expect(zh2en.map((q) => q.itemId).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never offers two choices with the same label even when glosses collide', () => {
    const set = makeAmbiguousSet();
    const zh2en = buildQuestions(set, { directions: ['zh2en'], seed: 1 });
    for (const q of zh2en) {
      expect(new Set(q.choices).size).toBe(q.choices.length);
    }
  });
});

describe('scoreAnswer', () => {
  it('is 0 for a wrong answer regardless of speed', () => {
    expect(scoreAnswer(false, 0, 8000)).toBe(0);
    expect(scoreAnswer(false, 9000, 8000)).toBe(0);
  });

  it('is 200 for an instant correct answer', () => {
    expect(scoreAnswer(true, 0, 8000)).toBe(200);
  });

  it('is 100 (no bonus) for a correct answer at exactly the time limit', () => {
    expect(scoreAnswer(true, 8000, 8000)).toBe(100);
  });

  it('never drops below 100 for a correct answer, even if overtime', () => {
    expect(scoreAnswer(true, 20000, 8000)).toBe(100);
  });

  it('gives a partial bonus for a mid-speed correct answer', () => {
    // half the time budget used -> half the bonus
    expect(scoreAnswer(true, 4000, 8000)).toBe(150);
  });
});

